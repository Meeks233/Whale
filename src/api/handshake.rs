//! `POST /api/session` — the secure-channel handshake. See docs/SECURITY.md.

use super::AppState;
use crate::error::AppError;
use crate::session::{HelloRequest, HelloResponse};
use axum::extract::State;
use axum::Json;

/// Exchange ephemeral P-256 public keys and register a pending session. The
/// response is plaintext — it carries only public values — and reveals nothing
/// about the token: identity is proven later, on the first authenticated request.
pub async fn hello(
    State(state): State<AppState>,
    Json(req): Json<HelloRequest>,
) -> Result<Json<HelloResponse>, AppError> {
    state.sessions.hello(&req).map(Json)
}
