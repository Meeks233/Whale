//! Manual dedup-archive editing. See docs/API.md.
//!
//! The dedup set uses Seal's scheme — one `extractor id` key per item (same as
//! yt-dlp `--download-archive`). Ex-Seal users can view/add/remove keys here to
//! seed "already have this" state or fix mistakes, on top of the Seal-backup CLI
//! import. Adding a key makes a matching future submit dedup; removing one lets
//! it re-download.

use super::AppState;
use crate::error::{AppError, AppResult};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
pub struct KeyRequest {
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    /// Raw yt-dlp/Seal download-archive text: one `extractor id` key per line.
    pub archive: String,
}

/// GET /api/archive — list all dedup keys (sorted).
pub async fn list(State(state): State<AppState>) -> AppResult<Response> {
    Ok(Json(json!({ "keys": state.archive.keys().await })).into_response())
}

/// POST /api/archive — add a dedup key. Body `{ "key": "youtube abc123" }`.
/// Idempotent. Rejects keys not shaped like `extractor id`.
pub async fn add(
    State(state): State<AppState>,
    Json(req): Json<KeyRequest>,
) -> AppResult<Response> {
    let key = req.key.trim();
    if key.is_empty() || !key.contains(' ') {
        return Err(AppError::BadRequest(
            "key must look like 'extractor id' (Seal/yt-dlp archive format)".into(),
        ));
    }
    state
        .archive
        .insert(key)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "added": true, "key": key })).into_response())
}

/// POST /api/archive/import — bulk-import a Seal/yt-dlp download archive. Body
/// `{ "archive": "youtube abc123\ntwitter 456\n…" }`. Blank/malformed lines are
/// skipped; the rest seed "already have this" dedup state. Idempotent.
pub async fn import(
    State(state): State<AppState>,
    Json(req): Json<ImportRequest>,
) -> AppResult<Response> {
    let mut added = 0usize;
    let mut skipped = 0usize;
    for line in req.archive.lines() {
        let key = line.trim();
        // Seal/yt-dlp keys are `extractor id`; anything without a space is junk.
        if key.is_empty() || !key.contains(' ') {
            skipped += 1;
            continue;
        }
        state
            .archive
            .insert(key)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
        added += 1;
    }
    Ok(Json(json!({ "added": added, "skipped": skipped })).into_response())
}

/// DELETE /api/archive — remove a dedup key. Body `{ "key": "youtube abc123" }`.
pub async fn remove(
    State(state): State<AppState>,
    Json(req): Json<KeyRequest>,
) -> AppResult<Response> {
    let key = req.key.trim();
    state
        .archive
        .remove(key)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(json!({ "removed": true, "key": key })).into_response())
}
