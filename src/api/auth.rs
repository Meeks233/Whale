//! Bearer-token auth middleware. See docs/API.md.

use super::AppState;
use crate::error::AppError;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;

#[derive(Debug, Clone, Copy)]
pub struct AuthContext {
    pub client_id: Option<i64>,
}

struct Credential {
    context: AuthContext,
    encryption_key: Option<[u8; 32]>,
}

fn header_token(headers: &HeaderMap) -> Option<String> {
    let val = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let tok = val.strip_prefix("Bearer ")?.trim();
    (!tok.is_empty()).then(|| tok.to_string())
}

/// Extract a bearer token from the `Authorization: Bearer` header or a `token=` query param.
pub fn extract_token(headers: &HeaderMap, query: &str) -> Option<String> {
    if let Some(val) = headers.get(axum::http::header::AUTHORIZATION) {
        if let Ok(s) = val.to_str() {
            if let Some(tok) = s.strip_prefix("Bearer ") {
                let tok = tok.trim();
                if !tok.is_empty() {
                    return Some(tok.to_string());
                }
            }
        }
    }
    for pair in query.split('&') {
        if let Some(tok) = pair.strip_prefix("token=") {
            let decoded = urldecode(tok);
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

pub fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix(&format!("{name}=")) {
            let decoded = urldecode(value);
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

/// Constant-time string equality for secret comparison. A naive `==` returns as
/// soon as it hits a differing byte, leaking — through response timing — how much
/// of a guessed token was correct, which an attacker can walk into a full match
/// (and use to shrink a rainbow-table / brute-force search). This compares every
/// byte regardless of where the first mismatch is. Token length is not secret, so
/// a length mismatch may short-circuit.
pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Minimal percent-decoding for the `?token=` query value.
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                if let Some(h) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(h);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Owner-only middleware. Normal JSON API routes never accept query-string
/// credentials; query auth is limited to media and SSE where browser APIs cannot
/// attach an Authorization header.
pub async fn require_owner(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    run_authenticated(&state, request, next, false).await
}

/// Submission middleware: owner or an explicitly trusted client. Client
/// credentials are intentionally scoped to POST /api/items and cannot read or
/// administer owner data.
pub async fn require_submitter(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    run_authenticated(&state, request, next, true).await
}

async fn run_authenticated(
    state: &AppState,
    request: Request,
    next: Next,
    allow_client: bool,
) -> Result<Response, AppError> {
    let credential = authenticate(state, request.headers(), allow_client).await?;
    let method = request.method().as_str().to_string();
    let target = request
        .uri()
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or(request.uri().path())
        .to_string();
    let encrypted_body = request
        .headers()
        .contains_key(crate::e2ee::HEADER_ENCRYPTED_BODY);
    let mut request = if let (Some(key), true) = (&credential.encryption_key, encrypted_body) {
        let aad = format!("{method}\n{target}");
        crate::e2ee::decrypt_request(request, key, aad.as_bytes()).await?
    } else {
        request
    };
    request.extensions_mut().insert(credential.context);
    let response = next.run(request).await;
    if let Some(key) = &credential.encryption_key {
        let aad = format!("{}\n{target}", response.status().as_u16());
        crate::e2ee::encrypt_response(response, key, aad.as_bytes()).await
    } else {
        Ok(response)
    }
}

async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    allow_client: bool,
) -> Result<Credential, AppError> {
    let encrypted = headers
        .get(crate::e2ee::HEADER_E2EE)
        .and_then(|v| v.to_str().ok())
        == Some("1");
    if encrypted {
        let requested_id = headers
            .get(crate::e2ee::HEADER_KEY_ID)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let owner_hash = crate::e2ee::auth_hash(&state.cfg.token);
        if ct_eq(requested_id, &crate::e2ee::key_id(&owner_hash)) {
            return Ok(Credential {
                context: AuthContext { client_id: None },
                encryption_key: Some(crate::e2ee::encryption_key(&owner_hash)),
            });
        }
        if allow_client {
            for (client_id, stored_hash) in state.db.trusted_client_auth_hashes().await? {
                let Some(hash) = crate::e2ee::auth_hash_from_hex(&stored_hash) else {
                    continue;
                };
                if ct_eq(requested_id, &crate::e2ee::key_id(&hash)) {
                    return Ok(Credential {
                        context: AuthContext {
                            client_id: Some(client_id),
                        },
                        encryption_key: Some(crate::e2ee::encryption_key(&hash)),
                    });
                }
            }
        }
        return Err(AppError::Unauthorized);
    }

    let Some(token) = header_token(headers) else {
        return Err(AppError::Unauthorized);
    };
    if ct_eq(&token, &state.cfg.token) {
        return Ok(Credential {
            context: AuthContext { client_id: None },
            encryption_key: None,
        });
    }
    if allow_client {
        if let Some(client_id) = state.db.find_trusted_client_id(&token).await? {
            return Ok(Credential {
                context: AuthContext {
                    client_id: Some(client_id),
                },
                encryption_key: None,
            });
        }
    }
    Err(AppError::Unauthorized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_comparison_matches_exact_bytes() {
        assert!(ct_eq("0123456789abcdef", "0123456789abcdef"));
        assert!(!ct_eq("0123456789abcdee", "0123456789abcdef"));
        assert!(!ct_eq("short", "longer"));
    }
}
