//! `POST /api/session` — the secure-channel handshake. See docs/SECURITY.md.

use super::AppState;
use crate::error::AppError;
use crate::session::HelloRequest;
use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;

/// Exchange ephemeral P-256 public keys and register a pending session. The
/// response is plaintext — it carries only public values — and reveals nothing
/// about the token: identity is proven later, on the first authenticated request.
///
/// In the selective media profile (`ORCA_ENCRYPT_MEDIA=0`) the response also sets
/// the HttpOnly `orca_sess` cookie so `<video>`/`<img>`/`<track>` can authenticate
/// their plaintext media fetches by session without a token on the wire. The
/// cookie value is the sid — already a public handle — and grants only media
/// reads. In the full profile no cookie is set; media stays sealed under the
/// session key and never touches this path.
pub async fn hello(
    State(state): State<AppState>,
    Json(req): Json<HelloRequest>,
) -> Result<Response, AppError> {
    let hello = state.sessions.hello(&req)?;
    if state.cfg.encrypt_media {
        return Ok(Json(hello).into_response());
    }
    // Max-Age mirrors the session idle TTL (30 min); SameSite=Lax so same-origin
    // media subresource GETs carry it. `Secure` is intentionally omitted so local
    // http:// dev works; behind the production HTTPS tunnel the browser leg is
    // encrypted regardless, and operators terminating TLS should add it.
    let cookie = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800",
        super::auth::MEDIA_COOKIE,
        hello.sid,
    );
    Ok(([(header::SET_COOKIE, cookie)], Json(hello)).into_response())
}
