//! Bearer-token auth middleware. See docs/API.md.

use super::AppState;
use crate::error::AppError;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;
use std::net::SocketAddr;

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
    let method = request.method().as_str().to_string();
    let target = request
        .uri()
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or(request.uri().path())
        .to_string();
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());
    let credential =
        authenticate(state, request.headers(), peer, allow_client, &method, &target).await?;
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

/// True when the connecting peer is on the machine's loopback interface, the
/// only place the plaintext bearer fallback is honoured. An unknown peer (no
/// connect-info) is treated as remote — fail closed.
fn is_loopback(peer: Option<std::net::IpAddr>) -> bool {
    peer.is_some_and(|ip| ip.is_loopback())
}

/// Name of the HttpOnly cookie that authenticates plaintext media requests in
/// the selective profile (`ORCA_ENCRYPT_MEDIA=0`). Its value is the session
/// `sid` — an opaque public handle already visible on the wire in `X-Orca-Sid`,
/// so the cookie reveals nothing the transport can't already see. It grants only
/// media reads (which are plaintext in this profile anyway), never API access:
/// the API plane still demands a sealed per-request authenticator no cookie can
/// forge. Set at handshake; see `api::handshake`.
pub const MEDIA_COOKIE: &str = "orca_sess";

/// Extract the `orca_sess` session id from the request's `Cookie` header, if any.
fn media_cookie_sid(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())?;
    raw.split(';').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        (k.trim() == MEDIA_COOKIE)
            .then(|| v.trim())
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    })
}

/// Authenticate a media request (`/file`, `/thumb`, `/stream`, `/subs/:lang`)
/// that cannot go through the auth middleware because `<video>`/`<img>`/`<track>`
/// elements can't attach headers — the Service Worker fetches these on their
/// behalf and *can*. Returns:
/// - `Ok(Some(key))` — a secure-channel session; the route must encrypt its bytes
///   under `key` (the browser's SW decrypts them).
/// - `Ok(None)` — the loopback plaintext fallback (`?token=`); serve plaintext,
///   for local `curl`/debugging only.
///
/// `target` must be the request path (no query), which the SW mirrors in the
/// authenticator's AAD.
pub async fn authenticate_media(
    state: &AppState,
    headers: &HeaderMap,
    query: &str,
    peer: Option<std::net::IpAddr>,
    target: &str,
) -> Result<Option<[u8; 32]>, AppError> {
    if let Some(sid) = headers.get(crate::e2ee::HEADER_SID).and_then(|v| v.to_str().ok()) {
        let authenticator = headers
            .get(crate::e2ee::HEADER_AUTH)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let (_client_id, key) =
            resolve_session(state, sid, authenticator, "GET", target, false).await?;
        return Ok(Some(key));
    }
    // Selective profile: `<video>`/`<img>`/`<track>` fetch media directly (no SW,
    // no headers) and carry the HttpOnly `orca_sess` cookie, whose value names an
    // active forward-secret session. A live session authorises plaintext media —
    // no sealing. The API/secrets plane is untouched and still forward-secret; the
    // cookie can't open it (that path demands a sealed authenticator). Off here so
    // the full profile can't be downgraded to cookie auth.
    if !state.cfg.encrypt_media {
        if let Some(sid) = media_cookie_sid(headers) {
            if state.sessions.active_key(&sid).is_some() {
                return Ok(None);
            }
        }
    }
    if is_loopback(peer)
        && extract_token(headers, query)
            .as_deref()
            .is_some_and(|t| ct_eq(t, &state.cfg.token))
    {
        return Ok(None);
    }
    Err(AppError::Unauthorized)
}

/// Resolve and verify a secure-channel session for one request, returning its
/// identity and derived key. Shared by the auth middleware and the header-less
/// media/SSE routes (which pass `allow_client = false`).
///
/// The sid names a session but proves nothing on its own — possession is proven
/// by the sealed `authenticator`, which only a holder of the session key could
/// have produced, bound to this method+target and single-use. An established
/// session verifies against its known key; a freshly handshaken one is still
/// *pending* with an unknown identity, so each candidate token's derived session
/// key is tried and the one that opens the authenticator both authenticates and
/// identifies the peer, promoting the session to active. A wrong candidate fails
/// to open and never burns the authenticator's nonce.
pub async fn resolve_session(
    state: &AppState,
    sid: &str,
    authenticator: &str,
    method: &str,
    target: &str,
    allow_client: bool,
) -> Result<(Option<i64>, [u8; 32]), AppError> {
    let now = crate::types::now_unix();

    if let Some((client_id, key)) = state.sessions.active_key(sid) {
        if client_id.is_some() && !allow_client {
            return Err(AppError::Unauthorized);
        }
        crate::e2ee::verify_authenticator(&key, authenticator, method, target, now)?;
        return Ok((client_id, key));
    }

    let pending = state.sessions.pending(sid).ok_or(AppError::Unauthorized)?;
    let owner_key = crate::e2ee::session_key(
        &pending.shared_x,
        &pending.n_c,
        &pending.n_s,
        &crate::e2ee::auth_hash(&state.cfg.token),
    );
    if crate::e2ee::verify_authenticator(&owner_key, authenticator, method, target, now).is_ok() {
        state.sessions.activate(sid, owner_key, None);
        return Ok((None, owner_key));
    }
    if allow_client {
        for (client_id, stored_hash) in state.db.trusted_client_auth_hashes().await? {
            let Some(psk) = crate::e2ee::auth_hash_from_hex(&stored_hash) else {
                continue;
            };
            let key = crate::e2ee::session_key(&pending.shared_x, &pending.n_c, &pending.n_s, &psk);
            if crate::e2ee::verify_authenticator(&key, authenticator, method, target, now).is_ok() {
                state.sessions.activate(sid, key, Some(client_id));
                return Ok((Some(client_id), key));
            }
        }
    }
    Err(AppError::Unauthorized)
}

async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    peer: Option<std::net::IpAddr>,
    allow_client: bool,
    method: &str,
    target: &str,
) -> Result<Credential, AppError> {
    // Secure-channel path: an opaque session id plus a sealed authenticator.
    if let Some(sid) = headers
        .get(crate::e2ee::HEADER_SID)
        .and_then(|v| v.to_str().ok())
    {
        let authenticator = headers
            .get(crate::e2ee::HEADER_AUTH)
            .and_then(|v| v.to_str().ok())
            .ok_or(AppError::Unauthorized)?;
        let (client_id, key) =
            resolve_session(state, sid, authenticator, method, target, allow_client).await?;
        return Ok(Credential {
            context: AuthContext { client_id },
            encryption_key: Some(key),
        });
    }

    // Plaintext bearer fallback — loopback only. Off the local machine the token
    // must never travel in clear (a Cloudflare Tunnel edge would see it), so a
    // remote request without a session is refused outright.
    if !is_loopback(peer) {
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

    fn cookie_header(v: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(axum::http::header::COOKIE, v.parse().unwrap());
        h
    }

    #[test]
    fn media_cookie_sid_extracts_only_the_session_cookie() {
        // Sole cookie.
        assert_eq!(media_cookie_sid(&cookie_header("orca_sess=abc123")).as_deref(), Some("abc123"));
        // Among others, order-independent, tolerant of spaces.
        assert_eq!(
            media_cookie_sid(&cookie_header("theme=dark; orca_sess=xy_z ; k=v")).as_deref(),
            Some("xy_z"),
        );
        // A different cookie whose name merely contains the marker is not matched.
        assert_eq!(media_cookie_sid(&cookie_header("not_orca_sess=nope")), None);
        // Empty value and absent cookie both yield None.
        assert_eq!(media_cookie_sid(&cookie_header("orca_sess=")), None);
        assert_eq!(media_cookie_sid(&cookie_header("theme=dark")), None);
        assert_eq!(media_cookie_sid(&HeaderMap::new()), None);
    }
}
