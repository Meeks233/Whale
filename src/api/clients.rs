//! Self-registered client management. See docs/API.md.
//!
//! A client (Android app / installed PWA) generates its own passphrase and
//! POSTs it to `/api/clients/register` — no owner token needed for that one
//! route. With `ORCA_CLIENT_TOFU` explicitly enabled the passphrase is trusted
//! immediately; otherwise it lands as *pending* until the owner approves it via
//! `POST /api/clients/:id/trust` (token-required). The passphrase then works as
//! a bearer credential only for `POST /api/items`.

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::types::RegisterRequest;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// POST /api/clients/register — self-registration (no owner token required).
/// Idempotent: re-registering the same passphrase returns the existing client.
pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> AppResult<Response> {
    let pass = req.passphrase.trim();
    if !(16..=256).contains(&pass.len()) {
        return Err(AppError::BadRequest(
            "passphrase must be 16 to 256 bytes".into(),
        ));
    }
    if req.label.as_deref().is_some_and(|label| label.len() > 128) {
        return Err(AppError::BadRequest(
            "label must not exceed 128 bytes".into(),
        ));
    }
    let client = state
        .db
        .register_client(pass, req.label.as_deref(), state.cfg.client_tofu)
        .await?;
    let status = if client.trusted {
        StatusCode::OK
    } else {
        StatusCode::ACCEPTED
    };
    Ok((status, Json(client)).into_response())
}

/// GET /api/clients — list clients with per-site counts (token-required).
pub async fn list(State(state): State<AppState>) -> AppResult<Response> {
    let clients = state.db.list_clients().await?;
    Ok(Json(json!({ "clients": clients })).into_response())
}

/// POST /api/clients/:id/trust — owner approves a pending client (token-required).
pub async fn trust(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Response> {
    if !state.db.trust_client(id).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "trusted": true })).into_response())
}

/// DELETE /api/clients/:id — revoke a client (token-required).
pub async fn delete(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Response> {
    if !state.db.delete_client(id).await? {
        return Err(AppError::NotFound);
    }
    Ok(Json(json!({ "deleted": true })).into_response())
}
