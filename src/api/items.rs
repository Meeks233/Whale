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
    crate::net_guard::guard(&url).map_err(|r| AppError::BadRequest(r.reason().into()))?;
    let force = req.options.as_ref().and_then(|o| o.force).unwrap_or(false);

    // If this request authenticated as a self-registered client (not the owner
    // token), we tally its submissions per extractor for rate/abuse visibility.
    let client_id = match super::auth::extract_token(&headers, "") {
        Some(t) if t != state.cfg.token => state.db.find_trusted_client_id(&t).await.ok().flatten(),
        _ => None,
    };

    // Website registry gating (before probe): a disabled site refuses submissions
    // outright — don't even touch it.
    let sites = state.db.list_websites().await.unwrap_or_default();
    let site = crate::websites::detect(&sites, &url);
    if let Some(w) = site {
        if !w.enabled {
            return Err(AppError::BadRequest(format!(
                "downloads from {} are disabled in Website settings",
                w.name
            )));
        }
    }
    // Auto-select this site's cookie via the DB registry (covers user-added sites),
    // falling back to the global cookie file.
    let site_key = site.map(|w| w.key.clone());
    let cookie = crate::cookies::resolve_keyed(
        &state.cookies,
        state.cfg.cookies.as_deref(),
        site_key.as_deref(),
    );
    let platform = site_key.as_deref().unwrap_or("unknown");
    let probes = match crate::ytdlp::probe(&state.cfg, &url, cookie.as_deref()).await {
        Ok(p) => p,
        Err(e) => {
            let raw = e.to_string();
            // One greppable record per probe failure — the metadata stage had no
            // logging at all, so an X/Twitter (or any) link that couldn't be read
            // failed silently server-side. Filter with
            // `level=warn target=whale::api::items`.
            tracing::warn!(
                url = %url,
                platform,
                had_cookies = cookie.is_some(),
                error = %raw,
                "probe failed"
            );
            // Enrich the client-facing message so a login-gated link (e.g. X video
            // with no cookies) tells the user to add cookies instead of showing a
            // cryptic yt-dlp error.
            let msg = crate::ytdlp::explain_error(&url, &raw);
            // Mirror into the UI-visible error log (bounded, newest-first).
            state.errlog.push("probe", &url, platform, &msg);
            return Err(AppError::ProbeFailed(msg));
        }
    };

    // A multi-video post (e.g. a tweet with two clips) probes into several entries
    // that all carry the SAME webpage_url; a playlist of distinct videos gives each
    // entry its own URL. Only the former needs `--playlist-items` disambiguation on
    // download, so keep an entry's playlist_index solely when its URL is shared.
    let mut url_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for p in &probes {
        *url_counts.entry(p.webpage_url.as_str()).or_insert(0) += 1;
    }

    // "None" (no-download) mode: the global default (stored max_height sentinel
    // "none", no env cap) OR a per-site stream-only flag. Such URLs are probed for
    // metadata then kept as completed stream-only records (no local file).
    let site_no_download = site.map(|w| w.no_download).unwrap_or(false);
    let global_no_download = state.cfg.max_height.is_none()
        && state.db.get_setting("max_height").await?.as_deref() == Some("none");
    let no_download = site_no_download || global_no_download;

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

        let shared_url = url_counts.get(p.webpage_url.as_str()).copied().unwrap_or(0) > 1;
        let mut probe = p.clone();
        probe.playlist_index = if shared_url { p.playlist_index } else { None };
        let item = state.db.insert_probe(&probe, crate::types::Source::Download).await?;
        if no_download {
            // Keep the entry as a stream-only record; don't fetch anything.
            state.db.mark_stream_only(item.id).await?;
            let refreshed = state.db.get(item.id).await?.unwrap_or(item);
            items.push(refreshed);
        } else {
            state.queue.enqueue(item.id).await;
            items.push(item);
        }
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
        // Tag the item with its site's privacy-blur flag so the headless
        // share-target notifications (ShareActivity) can mask a blurred site's
        // real title. Additive field on the item object; harmless to other clients.
        let blur = site.map(|w| w.blur).unwrap_or(false);
        let mut v = serde_json::to_value(SubmitResponse { item, duplicate })
            .unwrap_or_else(|_| json!({}));
        v["item"]["blur"] = json!(blur);
        Ok((status, Json(v)).into_response())
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

/// GET /api/items/:id — one item. Carries a computed `blur` flag (its site's
/// privacy-blur setting) so the headless share-target notification poller
/// (ShareActivity) can mask a blurred site's real title.
pub async fn get(State(state): State<AppState>, Path(id): Path<i64>) -> AppResult<Response> {
    let item = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    let sites = state.db.list_websites().await.unwrap_or_default();
    let blur = crate::websites::detect(&sites, &item.webpage_url)
        .map(|w| w.blur)
        .unwrap_or(false);
    let mut v = serde_json::to_value(&item).unwrap_or_else(|_| json!({}));
    v["blur"] = json!(blur);
    Ok(Json(v).into_response())
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
    // Stop the backend download(s) if this item is still fetching — otherwise the
    // yt-dlp child keeps running after the row (and the UI card) are gone. Grab
    // the resolution files first (the rows cascade-delete with the item).
    state.queue.cancel(id);
    let resolution_files: Vec<String> = state
        .db
        .list_resolutions(id)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.filepath)
        .collect();
    let removed = state.db.delete(id).await?.ok_or(AppError::NotFound)?;
    // Free the dedup key so a future submit can re-download.
    let _ = state.archive.remove(&removed.archive_key).await;
    if params.delete_file {
        // Every file to remove: the primary plus any resolution variants. Only
        // delete files that canonicalize inside the download root, so a poisoned
        // `filepath` (e.g. an imported /etc/passwd) can't be removed.
        let mut paths: Vec<String> = resolution_files;
        if let Some(stored) = &removed.filepath {
            paths.push(stored.clone());
        }
        for stored in paths {
            if let Some(path) = crate::safepath::confined_file(&state.cfg.download_dir, &stored) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    Ok(Json(json!({ "deleted": true })).into_response())
}

/// GET /api/stats — aggregate download count + total size (for the header
/// "total downloaded" readout beside the heartbeat).
pub async fn stats(State(state): State<AppState>) -> AppResult<Response> {
    let (count, total_bytes) = state.db.download_stats().await?;
    Ok(Json(json!({ "count": count, "total_bytes": total_bytes })).into_response())
}

/// GET /api/logs — recent probe/download errors (bounded ring buffer, newest
/// first) for the settings-panel diagnostics list. Token-required.
pub async fn logs(State(state): State<AppState>) -> AppResult<Response> {
    let entries = state.errlog.snapshot();
    Ok(Json(json!({ "entries": entries, "capacity": crate::errlog::CAPACITY })).into_response())
}

/// GET /api/items/:id/resolutions — the resolution versions the SOURCE actually
/// offers (its real per-format heights, captured at probe time) and which are
/// already downloaded. Powers the per-item resolution multi-select.
pub async fn resolutions(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let item = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    let downloaded: Vec<i64> = state
        .db
        .list_resolutions(id)
        .await?
        .into_iter()
        .map(|r| r.height)
        .collect();

    // Source heights come from the probe done at submit (or a prior refresh). Use
    // the cache when we have it and kick off a background re-probe so the list
    // tracks the source over time; otherwise probe once now and store the result.
    let source_heights: Vec<i64> = match state.db.get_available_heights(id).await? {
        Some(h) if !h.is_empty() => {
            spawn_heights_refresh(state.clone(), item.clone());
            h
        }
        _ => probe_source_heights(&state, &item).await.unwrap_or_default(),
    };

    // Union the source's heights with anything already downloaded (always let the
    // user keep a version they hold, even if the source has since dropped it), and
    // dedup by exact height — so a portrait video's true height (e.g. 1280) is a
    // single row, never double-listed against a same-label standard bucket.
    let mut set: std::collections::BTreeSet<i64> = source_heights.into_iter().collect();
    set.extend(downloaded.iter().copied());
    if set.is_empty() {
        if let Some(h) = item.height {
            set.insert(h);
        }
    }
    let available: Vec<i64> = set.into_iter().rev().collect();

    Ok(Json(json!({ "available": available, "downloaded": downloaded })).into_response())
}

/// Probe the source's available heights now and cache them. `None` on any
/// failure (SSRF guard / yt-dlp error) so the caller can degrade gracefully.
async fn probe_source_heights(state: &AppState, item: &crate::types::Item) -> Option<Vec<i64>> {
    if crate::net_guard::guard(&item.webpage_url).is_err() {
        return None;
    }
    let cookie =
        crate::cookies::resolve(&state.cookies, state.cfg.cookies.as_deref(), &item.webpage_url);
    match crate::ytdlp::probe_heights(&state.cfg, &item.webpage_url, cookie.as_deref()).await {
        Ok(h) => {
            let _ = state.db.set_available_heights(item.id, &h).await;
            Some(h)
        }
        Err(_) => None,
    }
}

/// Fire-and-forget background refresh of an item's cached source heights: re-probe
/// the source and overwrite the cache. Silently does nothing on failure. This is
/// the "quietly keep the list current" pass — a picker opened later sees any
/// added/removed resolutions, and a cached height the source no longer offers
/// simply stops appearing (a downloaded copy still shows; see the union above).
fn spawn_heights_refresh(state: AppState, item: crate::types::Item) {
    tokio::spawn(async move {
        let _ = probe_source_heights(&state, &item).await;
    });
}

#[derive(Debug, Deserialize)]
pub struct ResolutionsRequest {
    /// The full desired set of resolution heights to keep/download. Heights not
    /// listed that are currently downloaded get their files deleted.
    pub heights: Vec<i64>,
}

/// PUT /api/items/:id/resolutions — reconcile the item's downloaded resolutions
/// to the desired set: queue downloads for newly-selected heights, delete files
/// for deselected ones. Rejects an empty set (a video must keep ≥1 version;
/// deselecting everything must not silently fall back to the original).
pub async fn set_resolutions(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<ResolutionsRequest>,
) -> AppResult<Response> {
    // Ensure the item exists (404 otherwise); its primary is derived below.
    state.db.get(id).await?.ok_or(AppError::NotFound)?;

    // An empty desired set is the explicit "None" (no-download) mode: purge every
    // local file and keep the DB entry as a stream-only record. It is no longer
    // rejected — the picker/batch "clean local downloads" action relies on it.
    let desired: std::collections::BTreeSet<i64> =
        req.heights.into_iter().filter(|h| *h > 0).collect();

    let have: std::collections::BTreeSet<i64> = state
        .db
        .list_resolutions(id)
        .await?
        .into_iter()
        .map(|r| r.height)
        .collect();

    let to_add: Vec<i64> = desired.difference(&have).copied().collect();
    let to_remove: Vec<i64> = have.difference(&desired).copied().collect();

    // Queue downloads for newly-selected resolutions highest-first: `to_add` comes
    // from a BTreeSet difference (ascending), so `.rev()` enqueues high→low. The
    // highest requested resolution therefore starts (and, at the common single-lane
    // concurrency, finishes) first; run_job's repoint_primary then serves it the
    // moment it lands, without waiting for the lower variants (Req 2/3).
    for h in to_add.iter().rev() {
        state.queue.enqueue_resolution(id, *h).await;
    }

    // Delete deselected resolutions' files immediately — the user's intent when
    // switching (e.g. 4K→1080p) is that the old version is freed right away, not
    // retained until the replacement download lands. If this empties the item of
    // every local file, the card falls back to the cloud/stream state until the
    // queued replacement completes and repoint_primary re-pins the primary.
    for h in &to_remove {
        state.queue.cancel_variant(id, *h);
        if let Some(path) = state.db.delete_resolution(id, *h).await? {
            if let Some(p) = crate::safepath::confined_file(&state.cfg.download_dir, &path) {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    // Re-pin the primary at the highest resolution the item still holds. If every
    // local file is now gone (the "None" mode above, or a switch whose replacement
    // is still downloading), clear the primary so the card reflects the stream-only
    // state instead of pointing at a deleted file.
    let remaining = state.db.list_resolutions(id).await?;
    if remaining.is_empty() {
        state.db.clear_primary(id).await?;
    } else {
        state.db.repoint_primary(id).await?;
    }

    let downloaded: Vec<i64> = remaining.into_iter().map(|r| r.height).collect();
    Ok(Json(json!({ "downloaded": downloaded, "queued": to_add })).into_response())
}

/// GET /api/settings — runtime-adjustable settings. `max_height` is the current
/// effective cap (`null` = highest); `max_height_locked` is true when it's
/// pinned by the `WHALE_MAX_HEIGHT` env var and can't be changed from the UI.
pub async fn get_settings(State(state): State<AppState>) -> AppResult<Response> {
    let locked = state.cfg.max_height.is_some();
    // The stored `max_height` value can be the sentinel "none" — the no-download
    // ("None" resolution) default, where a submitted URL is kept as a stream-only
    // record and nothing is fetched. An env-pinned cap can't be "none".
    let raw = if locked {
        None
    } else {
        state.db.get_setting("max_height").await?
    };
    let no_download = raw.as_deref() == Some("none");
    let max_height = if locked {
        state.cfg.max_height
    } else if no_download {
        None
    } else {
        raw.and_then(|v| v.parse::<i64>().ok()).filter(|h| *h > 0)
    };
    Ok(Json(json!({
        "max_height": max_height,
        "max_height_locked": locked,
        "no_download": no_download,
    }))
    .into_response())
}

#[derive(Debug, Deserialize)]
pub struct SettingsRequest {
    /// New max height cap; `null` / 0 means highest (clears the stored setting).
    #[serde(default)]
    pub max_height: Option<i64>,
    /// When true, store the "None" (no-download) default: submitted URLs are kept
    /// as stream-only records and nothing is downloaded. Overrides `max_height`.
    #[serde(default)]
    pub no_download: Option<bool>,
}

/// PUT /api/settings — update runtime settings. Rejected while a setting is
/// env-pinned so a UI change can't silently contradict the operator's env var.
pub async fn put_settings(
    State(state): State<AppState>,
    Json(req): Json<SettingsRequest>,
) -> AppResult<Response> {
    if state.cfg.max_height.is_some() {
        return Err(AppError::BadRequest(
            "max_height is pinned by the WHALE_MAX_HEIGHT environment variable".into(),
        ));
    }
    // "None" (no-download) wins when set; otherwise a missing / 0 / negative value
    // is "highest" (clear the setting), and a positive value is the pixel cap.
    let stored = if req.no_download.unwrap_or(false) {
        Some("none".to_string())
    } else {
        match req.max_height {
            Some(h) if h > 0 => Some(h.to_string()),
            _ => None,
        }
    };
    state.db.set_setting("max_height", stored.as_deref()).await?;
    get_settings(State(state)).await
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
