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
    if req.url.trim().is_empty() {
        return Err(AppError::BadRequest("missing url".into()));
    }
    // Canonicalize before probe/dedup: strip tracking params and fold short
    // links / mobile hosts so the same video shared in different forms resolves
    // (and dedupes) consistently. See url_normalize.
    let url = crate::url_normalize::normalize(&req.url);
    // SSRF guard: reject non-http(s) schemes and hosts that are/resolve to
    // private, loopback, or link-local addresses before handing the URL to
    // yt-dlp (whose generic extractor would otherwise fetch them).
    crate::net_guard::guard(&url)
        .await
        .map_err(|r| AppError::BadRequest(r.reason().into()))?;
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
    /// How long the share stays live: 7 or 30 days, or `null`/omitted for a
    /// permanent share (Baidu-netdisk style). Only read when `public` is true.
    #[serde(default)]
    pub expires_in_days: Option<i64>,
}

/// Share durations we offer the user. Anything else is rejected so a caller
/// can't set an arbitrary window.
const ALLOWED_SHARE_DAYS: [i64; 2] = [7, 30];

/// POST /api/items/:id/public — flip an item's public (tokenless-streaming) flag.
/// When making public, `expires_in_days` (7 | 30 | null) sets the auto-expiry.
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
    // Resolve the expiry timestamp. Reject out-of-range windows rather than
    // silently clamping so the stored record always matches what the user chose.
    let until = match req.expires_in_days {
        Some(days) => {
            if !ALLOWED_SHARE_DAYS.contains(&days) {
                return Err(AppError::BadRequest(
                    "expires_in_days must be 7, 30, or null (permanent)".into(),
                ));
            }
            Some(crate::types::now_unix() + days * 86_400)
        }
        None => None,
    };
    state.db.set_public(id, req.public, until).await?;
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
        // Only delete a file that canonicalizes inside the download root, so a
        // poisoned `filepath` (e.g. an imported /etc/passwd) can't be removed.
        if let Some(stored) = &removed.filepath {
            if let Some(path) = crate::safepath::confined_file(&state.cfg.download_dir, stored) {
                let _ = std::fs::remove_file(path);
            }
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
        // Canonical public domain for share links; null when the operator
        // hasn't declared WHALE_PUBLIC_URL (UI falls back to its own origin).
        "public_url": state.cfg.public_url,
    }))
    .into_response()
}
