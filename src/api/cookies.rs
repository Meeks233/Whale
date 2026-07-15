//! Cookie management handlers: list platforms + set/toggle/delete per-platform
//! cookies. All routes require the bearer token (wired in `api::router`).
//! See docs/USER_GUIDE.md.

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::platform;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

/// GET /api/cookies — the platform catalog with each platform's cookie status.
pub async fn list(State(state): State<AppState>) -> AppResult<Response> {
    let platforms: Vec<_> = platform::CATALOG
        .iter()
        .map(|p| {
            let st = state.cookies.status(p.key);
            json!({
                "key": p.key,
                "name": p.name,
                "hosts": p.hosts,
                "login_url": p.login_url,
                "present": st.present,
                "enabled": st.enabled,
                "bytes": st.bytes,
                "updated_at": st.updated_at,
            })
        })
        .collect();
    Ok(Json(json!({ "platforms": platforms })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct SetBody {
    /// Netscape `cookies.txt` contents pasted/exported by the user.
    pub cookies: String,
}

/// PUT /api/cookies/:platform — set (replace) cookies for a platform. Stored
/// enabled so downloads for that platform use it immediately.
pub async fn set(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<SetBody>,
) -> AppResult<Response> {
    let p = known_platform(&key)?;
    state
        .cookies
        .set(p.key, &body.cookies, p.hosts.first().copied())
        .map_err(AppError::BadRequest)?;
    Ok(Json(status_json(&state, p.key)).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ToggleBody {
    pub enabled: bool,
}

/// PATCH /api/cookies/:platform — enable/disable existing cookies (kept on disk).
pub async fn toggle(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<ToggleBody>,
) -> AppResult<Response> {
    let p = known_platform(&key)?;
    if !state.cookies.status(p.key).present {
        return Err(AppError::NotFound);
    }
    state
        .cookies
        .set_enabled(p.key, body.enabled)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(status_json(&state, p.key)).into_response())
}

/// DELETE /api/cookies/:platform — remove stored cookies for a platform.
pub async fn delete(State(state): State<AppState>, Path(key): Path<String>) -> AppResult<Response> {
    let p = known_platform(&key)?;
    state
        .cookies
        .remove(p.key)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "deleted": true })).into_response())
}

/// Reject unknown keys — this also guards against path traversal, since `key`
/// becomes part of a filename in the store.
fn known_platform(key: &str) -> Result<&'static platform::Platform, AppError> {
    platform::by_key(key).ok_or_else(|| AppError::BadRequest(format!("unknown platform '{key}'")))
}

fn status_json(state: &AppState, key: &str) -> serde_json::Value {
    let st = state.cookies.status(key);
    json!({
        "key": key,
        "present": st.present,
        "enabled": st.enabled,
        "bytes": st.bytes,
        "updated_at": st.updated_at,
        "expires_at": st.expires_at,
    })
}
