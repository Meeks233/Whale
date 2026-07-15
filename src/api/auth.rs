//! Bearer-token auth middleware. See docs/API.md.

use super::AppState;
use crate::error::AppError;
use axum::extract::{Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;

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

/// Middleware guarding `/api/*` routes (except health/events, which are wired separately).
pub async fn require_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let query = request.uri().query().unwrap_or("");
    let token = extract_token(request.headers(), query);
    let Some(t) = token else {
        return Err(AppError::Unauthorized);
    };
    // Owner token OR a trusted self-registered client passphrase.
    if ct_eq(&t, &state.cfg.token) {
        return Ok(next.run(request).await);
    }
    match state.db.find_trusted_client_id(&t).await {
        Ok(Some(_)) => Ok(next.run(request).await),
        _ => Err(AppError::Unauthorized),
    }
}
