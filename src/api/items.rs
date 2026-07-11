//! Item handlers: submit / list / get / retry / delete + health. See docs/API.md.

use super::AppState;
use crate::db::ListQuery;
use crate::error::{AppError, AppResult};
use crate::types::{Item, Status, SubmitRequest, SubmitResponse};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

/// POST /api/items — submit a URL: probe → dedup → enqueue.
pub async fn submit(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<SubmitRequest>,
) -> AppResult<Response> {
    let url = req.url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::BadRequest("missing url".into()));
    }
    let force = req.options.as_ref().and_then(|o| o.force).unwrap_or(false);

    // If this request authenticated as a self-registered client (not the owner
    // token), we tally its submissions per extractor for rate/abuse visibility.
    let client_id = match super::auth::extract_token(&headers, "") {
        Some(t) if t != state.cfg.token => state.db.find_trusted_client_id(&t).await.ok().flatten(),
        _ => None,
    };

    // Auto-select the platform cookie for this URL (falls back to global).
    let cookie = crate::cookies::resolve(&state.cookies, state.cfg.cookies.as_deref(), &url);
    let probes = crate::ytdlp::probe(&state.cfg, &url, cookie.as_deref())
        .await
        .map_err(|e| AppError::ProbeFailed(e.to_string()))?;

    let mut items: Vec<Item> = Vec::new();
    let mut duplicates = 0u32;

    for p in &probes {
        if let Some(cid) = client_id {
            let _ = state.db.bump_site_count(cid, &p.extractor).await;
        }
        let key = p.archive_key();
        let existing = state.db.find_by_archive_key(&key).await?;

        if let Some(item) = existing {
            if force {
                // Reuse the row: reset to queued and re-enqueue.
                state.db.set_status(item.id, Status::Queued, None).await?;
                state.queue.enqueue(item.id).await;
                let refreshed = state.db.get(item.id).await?.unwrap_or(item);
                items.push(refreshed);
            } else {
                duplicates += 1;
                items.push(item);
            }
            continue;
        }

        let item = state.db.insert_probe(p, crate::types::Source::Download).await?;
        state.queue.enqueue(item.id).await;
        items.push(item);
    }

    // Single (non-playlist) submit → SubmitResponse; batch → array form (API.md).
    if probes.len() == 1 {
        let item = items.into_iter().next().unwrap();
        let duplicate = duplicates == 1;
        let status = if duplicate {
            StatusCode::OK
        } else {
            StatusCode::ACCEPTED
        };
        Ok((status, Json(SubmitResponse { item, duplicate })).into_response())
    } else {
        Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "items": items, "duplicates": duplicates })),
        )
            .into_response())
    }
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub status: Option<String>,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub before_id: Option<i64>,
}

/// GET /api/items — keyset-paginated history.
pub async fn list(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> AppResult<Response> {
    let status = match params.status.as_deref() {
        Some(s) => Some(Status::parse(s).ok_or_else(|| AppError::BadRequest(format!("bad status '{s}'")))?),
        None => None,
    };
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let page = state
        .db
        .list(ListQuery {
            status,
            q: params.q,
            limit,
            before_id: params.before_id,
        })
        .await?;
    Ok(Json(json!({ "items": page.items, "next_cursor": page.next_cursor })).into_response())
}

/// GET /api/items/:id — one item.
pub async fn get(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Response> {
    let item = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(item).into_response())
}

/// POST /api/items/:id/retry — re-queue a failed item.
pub async fn retry(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Response> {
    let item = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    if item.status != Status::Failed {
        return Err(AppError::BadRequest("item is not in a retryable (failed) state".into()));
    }
    state.db.set_status(id, Status::Queued, None).await?;
    state.queue.enqueue(id).await;
    let refreshed = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(refreshed).into_response())
}

#[derive(Debug, Deserialize)]
pub struct PublicRequest {
    pub public: bool,
}

/// POST /api/items/:id/public — flip an item's public (tokenless-streaming) flag.
pub async fn set_public(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<PublicRequest>,
) -> AppResult<Response> {
    let item = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    if item.status != Status::Completed || item.filepath.is_none() {
        return Err(AppError::BadRequest(
            "only completed items with a file can be made public".into(),
        ));
    }
    state.db.set_public(id, req.public).await?;
    let refreshed = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(refreshed).into_response())
}

#[derive(Debug, Deserialize)]
pub struct DeleteParams {
    #[serde(default)]
    pub delete_file: bool,
}

/// DELETE /api/items/:id — remove a record (optionally its file).
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(params): Query<DeleteParams>,
) -> AppResult<Response> {
    let removed = state.db.delete(id).await?.ok_or(AppError::NotFound)?;
    // Free the dedup key so a future submit can re-download.
    let _ = state.archive.remove(&removed.archive_key).await;
    if params.delete_file {
        if let Some(path) = &removed.filepath {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(Json(json!({ "deleted": true })).into_response())
}

/// GET /api/health — liveness (no auth).
pub async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "ytdlp": state.ytdlp_version,
    }))
    .into_response()
}
