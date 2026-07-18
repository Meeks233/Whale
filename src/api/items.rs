//! Item handlers: submit / list / get / retry / delete + health. See docs/API.md.

use super::AppState;
use crate::db::{ListQuery, SortKey};
use crate::error::{AppError, AppResult};
use crate::types::{Item, Status, SubmitRequest, SubmitResponse};
use axum::extract::{Extension, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

async fn item_by_slug(state: &AppState, slug: &str) -> AppResult<Item> {
    let valid = matches!(slug.len(), 24 | 32) && slug.bytes().all(|b| b.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::NotFound);
    }
    state.db.find_by_slug(slug).await?.ok_or(AppError::NotFound)
}

fn decorate_item(item: &Item, sites: &[crate::types::Website]) -> serde_json::Value {
    let mut value = serde_json::to_value(item).unwrap_or_else(|_| json!({}));
    if let Some(site) = crate::websites::detect(sites, &item.webpage_url) {
        value["blur"] = json!(site.blur);
        value["site_name"] = json!(site.name);
    }
    value
}

/// POST /api/items — submit a URL: probe → dedup → enqueue.
pub async fn submit(
    State(state): State<AppState>,
    Extension(auth): Extension<super::auth::AuthContext>,
    Json(req): Json<SubmitRequest>,
) -> AppResult<Response> {
    if req.url.trim().is_empty() {
        return Err(AppError::BadRequest("missing url".into()));
    }
    if req.url.len() > 8192 {
        return Err(AppError::BadRequest("url is too long".into()));
    }
    // Canonicalize before probe/dedup: strip tracking params and fold short
    // links / mobile hosts so the same video shared in different forms resolves
    // (and dedupes) consistently. See url_normalize.
    let url = crate::url_normalize::normalize(&req.url);
    // SSRF guard: reject non-http(s) schemes and hosts that are/resolve to
    // private, loopback, or link-local addresses before handing the URL to
    // yt-dlp (whose generic extractor would otherwise fetch them).
    crate::net_guard::guard(&url, state.cfg.allow_private_dns)
        .await
        .map_err(|r| AppError::BadRequest(r.reason().into()))?;
    let force = req.options.as_ref().and_then(|o| o.force).unwrap_or(false);

    // If this request authenticated as a self-registered client (not the owner
    // token), we tally its submissions per extractor for rate/abuse visibility.
    let client_id = auth.client_id;

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
            // `level=warn target=orca::api::items`.
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
    if probes.len() > 500 {
        return Err(AppError::BadRequest("playlist exceeds 500 items".into()));
    }

    // A multi-video post (e.g. a tweet with two clips) probes into several entries
    // that all carry the SAME webpage_url; a playlist of distinct videos gives each
    // entry its own URL. Only the former needs `--playlist-items` disambiguation on
    // download, so keep an entry's playlist_index solely when its URL is shared.
    let mut url_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for p in &probes {
        *url_counts.entry(p.webpage_url.as_str()).or_insert(0) += 1;
    }

    // The effective height set for this URL (env > per-site > global). The empty
    // set is "None" / no-download mode: such URLs are probed for metadata then
    // kept as completed stream-only records (no local file). Anything else names
    // the copies to fetch — the tallest as the item's primary, the rest as
    // variants enqueued once the row exists.
    // A prepare card can pin one resolution for this submission (goal 4),
    // overriding the settings ladder. `0` is the "highest available" sentinel; any
    // other positive height is taken as-is (the card offers the source's own
    // reported heights, which may sit between ladder rungs — see single_requested).
    // The override is also persisted per item below so run_job's primary honours it.
    let requested_height = req.options.as_ref().and_then(|o| o.max_height);
    let heights = match requested_height {
        Some(h) => crate::resolution::HeightSet::single_requested(h)
            .map_err(AppError::BadRequest)?,
        None => crate::queue::resolve_max_heights(&state.cfg, &state.db, &sites, &url).await,
    };
    let no_download = heights.is_empty();
    // Out of room: still probe and record the item (so it stays searchable and
    // streamable via /api/stream/:slug), but park the fetch as Paused rather than
    // filling the last of the disk. Freeing space and hitting Resume picks it up.
    let no_space = !no_download && crate::queue::storage_full(&state.cfg, &state.db).await;

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
                // Carry the prepare card's resolution choice onto the reused row so
                // the re-enqueued primary honours it, same as a fresh submit.
                if let Some(h) = requested_height {
                    state.db.set_requested_height(item.id, Some(h)).await?;
                }
                // Reuse the row: reset to queued and re-enqueue — unless there's no
                // room, in which case park it exactly like a fresh submit would.
                if no_space {
                    state.db.set_status(item.id, Status::Paused, None).await?;
                } else {
                    state.db.set_status(item.id, Status::Queued, None).await?;
                    state.queue.enqueue(item.id).await;
                }
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
        let item = state
            .db
            .insert_probe(&probe, crate::types::Source::Download)
            .await?;
        // Persist the prepare card's resolution override before the job is enqueued
        // so run_job's primary reads it (goal 4). Harmless on the stream-only /
        // paused paths — it's only consulted when a primary download actually runs.
        if let Some(h) = requested_height {
            state.db.set_requested_height(item.id, Some(h)).await?;
        }
        if no_download {
            // Keep the entry as a stream-only record; don't fetch anything.
            state.db.mark_stream_only(item.id).await?;
            let refreshed = state.db.get(item.id).await?.unwrap_or(item);
            items.push(refreshed);
        } else if no_space {
            // Recorded, streamable, and waiting for room — see `no_space` above.
            // Paused (not stream-only) because the user still wants this file: it
            // downloads as soon as space frees and Resume is pressed.
            state.db.set_status(item.id, Status::Paused, None).await?;
            let refreshed = state.db.get(item.id).await?.unwrap_or(item);
            items.push(refreshed);
        } else {
            // The primary job fetches the tallest of the set (run_job re-derives
            // that cap itself). Snap the rest against what this probe says the
            // source actually offers, so picking e.g. {4320, 1080} on a 1080p
            // source queues one download rather than two that race to write the
            // same 1080p row. `resolve` already dropped the primary's twin, so
            // skip its first element rather than filtering by value — two
            // requests can legitimately snap to the same height only if they were
            // the same file, which is exactly what dedup removed.
            state.queue.enqueue(item.id).await;
            for &h in heights.resolve(&probe.available_heights).iter().skip(1) {
                state
                    .queue
                    .enqueue_resolution_replacing(item.id, h, Vec::new())
                    .await;
            }
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
        let mut v =
            serde_json::to_value(SubmitResponse { item, duplicate }).unwrap_or_else(|_| json!({}));
        v["item"]["blur"] = json!(blur);
        if let Some(site) = site {
            v["item"]["site_name"] = json!(site.name);
        }
        Ok((status, Json(v)).into_response())
    } else {
        Ok((
            StatusCode::ACCEPTED,
            Json(json!({ "items": items, "duplicates": duplicates })),
        )
            .into_response())
    }
}

/// POST /api/preview — probe a URL for metadata WITHOUT recording or enqueuing
/// anything. Powers the clipboard auto-detect confirm dialog: the UI shows what
/// each detected link actually is (title, uploader, duration, site) so a user
/// confirms real videos, not bare URLs, before the download starts. A multi-video
/// post (or playlist) probes into several entries, each returned as its own row.
pub async fn preview(
    State(state): State<AppState>,
    Json(req): Json<SubmitRequest>,
) -> AppResult<Response> {
    if req.url.trim().is_empty() {
        return Err(AppError::BadRequest("missing url".into()));
    }
    if req.url.len() > 8192 {
        return Err(AppError::BadRequest("url is too long".into()));
    }
    let url = crate::url_normalize::normalize(&req.url);
    crate::net_guard::guard(&url, state.cfg.allow_private_dns)
        .await
        .map_err(|r| AppError::BadRequest(r.reason().into()))?;

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
    let site_key = site.map(|w| w.key.clone());
    let site_name = site.map(|w| w.name.clone());
    let cookie = crate::cookies::resolve_keyed(
        &state.cookies,
        state.cfg.cookies.as_deref(),
        site_key.as_deref(),
    );
    let probes = match crate::ytdlp::probe(&state.cfg, &url, cookie.as_deref()).await {
        Ok(p) => p,
        Err(e) => {
            let raw = e.to_string();
            let msg = crate::ytdlp::explain_error(&url, &raw);
            return Err(AppError::ProbeFailed(msg));
        }
    };
    if probes.len() > 500 {
        return Err(AppError::BadRequest("playlist exceeds 500 items".into()));
    }
    // The resolution the current settings would pick for this URL, resolved per
    // entry against what that entry actually offers — the prepare card seeds its
    // resolution selector with it (goal 4), and the user may override it before
    // submitting via SubmitOptions.max_height.
    let heights = crate::queue::resolve_max_heights(&state.cfg, &state.db, &sites, &url).await;
    // Report whether each entry already exists (dedup), so the dialog can flag a
    // link the user has downloaded before instead of silently re-fetching it.
    let mut previews: Vec<serde_json::Value> = Vec::with_capacity(probes.len());
    for (i, p) in probes.iter().enumerate() {
        let known = state.db.find_by_archive_key(&p.archive_key()).await?.is_some();
        // Synchronously pull the thumbnail and inline it as a data URI so the card
        // can show it without an item slug or a CDN round-trip from the client
        // (goal 1). Best-effort: a missing thumbnail leaves the field null. Only the
        // first entry is fetched — the prepare card shows that one as the face, so a
        // 500-item playlist still costs a single thumbnail fetch, not 500.
        let thumbnail = match (i, p.thumbnail_url.as_deref()) {
            (0, Some(u)) => {
                super::media::thumbnail_data_uri(u, &p.webpage_url, state.cfg.allow_private_dns)
                    .await
            }
            _ => None,
        };
        let default_height = heights.resolve(&p.available_heights).first().copied();
        previews.push(json!({
            "title": p.title.clone(),
            "uploader": p.uploader.clone(),
            "duration": p.duration,
            "webpage_url": p.webpage_url.clone(),
            "extractor": p.extractor.clone(),
            "site_name": site_name.clone(),
            "available_heights": p.available_heights.clone(),
            "default_height": default_height,
            "thumbnail": thumbnail,
            "duplicate": known,
        }));
    }
    Ok(Json(json!({ "url": url, "previews": previews })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub status: Option<String>,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub before_id: Option<i64>,
    /// `local=true` → only items holding a downloaded file; `local=false` → only
    /// stream-only ones. Answered in SQL so "show me what's downloaded" costs one
    /// filtered page rather than paging the whole history to sieve it client-side.
    pub local: Option<bool>,
    /// Column to order by: `time` (default), `size`, `duration`, `resolution`.
    pub sort: Option<String>,
    /// `reverse=true` flips the default descending order to ascending.
    pub reverse: Option<bool>,
}

/// GET /api/items — keyset-paginated history.
pub async fn list(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> AppResult<Response> {
    let status = match params.status.as_deref() {
        Some(s) => Some(
            Status::parse(s).ok_or_else(|| AppError::BadRequest(format!("bad status '{s}'")))?,
        ),
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
            local: params.local,
            sort: params.sort.as_deref().map(SortKey::parse).unwrap_or_default(),
            reverse: params.reverse.unwrap_or(false),
        })
        .await?;
    let sites = state.db.list_websites().await.unwrap_or_default();
    let items = page
        .items
        .iter()
        .map(|item| decorate_item(item, &sites))
        .collect::<Vec<_>>();
    Ok(Json(json!({ "items": items, "next_cursor": page.next_cursor })).into_response())
}

/// GET /api/items/:slug — one item. Carries a computed `blur` flag (its site's
/// privacy-blur setting) so the headless share-target notification poller
/// (ShareActivity) can mask a blurred site's real title.
pub async fn get(State(state): State<AppState>, Path(slug): Path<String>) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
    let sites = state.db.list_websites().await.unwrap_or_default();
    let mut value = decorate_item(&item, &sites);
    // Live percent/speed/eta for a running download. The Android notification
    // service polls this endpoint (it cannot hold the SSE stream open across
    // process death), so without this it could only show a spinner.
    if let Some(p) = state.queue.live_progress(item.id) {
        value["progress"] = json!({
            "percent": p.percent,
            "speed": p.speed,
            "eta": p.eta,
            "phase": p.phase,
        });
    }
    Ok(Json(value).into_response())
}

/// POST /api/items/:slug/retry — re-queue a failed, canceled, or stream-only item.
pub async fn retry(State(state): State<AppState>, Path(slug): Path<String>) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
    // Canceled is retryable alongside failed, and has to be: cancel discards the
    // partial file, so retry is the ONLY route back to a download the user changed
    // their mind about. (Paused is not here — it has resume, which continues from
    // the partial rather than starting over.)
    //
    // A *completed* item is retryable only in the one case where "completed" does
    // not mean "there is a file": stream-only mode, where deselecting every
    // resolution purged the local copy and left the record playing from source.
    // That state is a cancel by another name — the user has no partial to resume
    // and no file to keep — so it gets the same one-tap route back to a download.
    // A completed item that still has its file is NOT retryable: re-fetching bytes
    // already on disk is the resolution picker's job, not retry's.
    let stream_only = item.status == Status::Completed && !item.local_available;
    if !matches!(item.status, Status::Failed | Status::Canceled) && !stream_only {
        return Err(AppError::BadRequest(
            "item is not in a retryable (failed, canceled, or stream-only) state".into(),
        ));
    }
    // Retry means "fetch this again", and a primary download consults yt-dlp's
    // download archive (see download_args). So for any item with no local file
    // whose key is still recorded, the fetch cannot succeed — yt-dlp finds the key,
    // writes nothing, and reports "already recorded" forever. Dropping the key is
    // the precondition for retry to do anything at all; it is exactly what the
    // resulting error tells the user to go and do by hand in the Archive editor.
    //
    // Keyed off the missing file rather than off the status, because that is the
    // thing that makes it correct: the archive exists to stop us re-fetching what
    // we already have, and we do not have this. A stream-only item reaches here with
    // its key recorded (it downloaded once, then the file was purged); a failed one
    // can too, when it completed earlier in its life. Where no key is recorded — the
    // common failed/canceled case — this is a no-op. Success re-records it.
    if !item.local_available {
        if let Err(e) = state.archive.remove(&item.archive_key).await {
            tracing::warn!(item = item.id, error = %e, "failed to drop archive key for retry");
        }
    }
    state.db.set_status(item.id, Status::Queued, None).await?;
    state.queue.enqueue(item.id).await;
    let refreshed = state.db.get(item.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(refreshed).into_response())
}

/// POST /api/items/:slug/pause — hold a download back without discarding it.
/// Kills any in-flight yt-dlp child; its `.part` file survives, so a later resume
/// continues from where it stopped rather than starting over. Online playback via
/// `/api/stream/:slug` keeps working throughout — pausing defers the local copy,
/// it doesn't retract the record.
pub async fn pause(State(state): State<AppState>, Path(slug): Path<String>) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
    // A resolution-upgrade job runs against an already-terminal item (completed /
    // canceled) without ever flipping its status to running, so pausing it can't go
    // through the status machine below. Stop the variant's yt-dlp child but keep its
    // `.part` and leave the completed file and status untouched — the row simply
    // drops back to its resting state. `false` (no live job) falls through so the
    // usual "nothing to pause" rejection still applies to a truly idle item.
    if matches!(item.status, Status::Completed | Status::Canceled) {
        if state.queue.cancel(item.id) {
            // The killed variant's run_job broadcasts a terminal tick as it unwinds,
            // which clears the live chip on every client; the item keeps its status
            // and file.
            let refreshed = state.db.get(item.id).await?.ok_or(AppError::NotFound)?;
            return Ok(Json(refreshed).into_response());
        }
    }
    if !matches!(item.status, Status::Queued | Status::Running) {
        return Err(AppError::BadRequest(
            "only a queued or running download can be paused".into(),
        ));
    }
    // Status first, then kill: run_job's Cancelled branch deliberately writes no
    // status, so the Paused mark set here is what survives.
    state.db.set_status(item.id, Status::Paused, None).await?;
    state.queue.cancel(item.id);
    let refreshed = state.db.get(item.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(refreshed).into_response())
}

/// POST /api/items/:slug/cancel — give up on a download without giving up the
/// record. Kills the yt-dlp child and discards its partials, so unlike pause
/// there is nothing to continue from: the way back is Retry, which starts over.
/// The item stays in the history (streamable, searchable) — removing it entirely
/// is what DELETE is for.
pub async fn cancel(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
    // A resolution-upgrade job runs against an already-terminal item (completed /
    // canceled) without flipping its status. Cancelling it must stop the variant
    // fetch and drop its partials while keeping the existing completed file and the
    // item's status intact. `false` (no live job) falls through so the normal
    // rejection still guards a truly idle item.
    if matches!(item.status, Status::Completed | Status::Canceled) {
        if state.queue.cancel(item.id) {
            crate::queue::discard_partials(&state.cfg.download_dir, &item.video_id);
            // The killed variant's run_job broadcasts a terminal tick as it unwinds,
            // which clears the live chip on every client; the item keeps its status
            // and file.
            let refreshed = state.db.get(item.id).await?.ok_or(AppError::NotFound)?;
            return Ok(Json(refreshed).into_response());
        }
    }
    if !matches!(
        item.status,
        Status::Queued | Status::Running | Status::Paused
    ) {
        return Err(AppError::BadRequest(
            "only an outstanding (queued, running or paused) download can be canceled".into(),
        ));
    }
    // Status first, then kill: run_job's Cancelled branch deliberately writes no
    // status, so the Canceled mark set here is what survives.
    state.db.set_status(item.id, Status::Canceled, None).await?;
    state.queue.cancel(item.id);
    crate::queue::discard_partials(&state.cfg.download_dir, &item.video_id);
    let refreshed = state.db.get(item.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(refreshed).into_response())
}

/// POST /api/queue/cancel — give up on every outstanding download at once.
pub async fn cancel_all(State(state): State<AppState>) -> AppResult<Response> {
    let ids = state.db.cancel_active().await?;
    for id in &ids {
        state.queue.cancel(*id);
        // The row is already marked; its partials still have to go. A vanished
        // item is not an error worth failing the sweep over.
        if let Ok(Some(item)) = state.db.get(*id).await {
            crate::queue::discard_partials(&state.cfg.download_dir, &item.video_id);
        }
    }
    Ok(Json(json!({ "canceled": ids.len() })).into_response())
}

/// POST /api/items/:slug/resume — re-queue a paused download.
pub async fn resume(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
    if item.status != Status::Paused {
        return Err(AppError::BadRequest("item is not paused".into()));
    }
    state.db.set_status(item.id, Status::Queued, None).await?;
    state.queue.enqueue(item.id).await;
    let refreshed = state.db.get(item.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(refreshed).into_response())
}

/// POST /api/queue/pause — park every queued/running download at once.
pub async fn pause_all(State(state): State<AppState>) -> AppResult<Response> {
    let ids = state.db.pause_active().await?;
    for id in &ids {
        state.queue.cancel(*id);
    }
    Ok(Json(json!({ "paused": ids.len() })).into_response())
}

/// POST /api/queue/resume — release every paused download, oldest submission
/// first, so the backlog drains in the order the user queued it.
pub async fn resume_all(State(state): State<AppState>) -> AppResult<Response> {
    let ids = state.db.paused_ids().await?;
    for id in &ids {
        state.db.set_status(*id, Status::Queued, None).await?;
        state.queue.enqueue(*id).await;
    }
    Ok(Json(json!({ "resumed": ids.len() })).into_response())
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

/// POST /api/items/:slug/public — flip an item's public (tokenless-streaming) flag.
/// When making public, `expires_in_days` (7 | 30 | null) sets the auto-expiry.
pub async fn set_public(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Json(req): Json<PublicRequest>,
) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
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
    state.db.set_public(item.id, req.public, until).await?;
    let refreshed = state.db.get(item.id).await?.ok_or(AppError::NotFound)?;
    Ok(Json(refreshed).into_response())
}

#[derive(Debug, Deserialize)]
pub struct DeleteParams {
    #[serde(default)]
    pub delete_file: bool,
}

/// DELETE /api/items/:slug — remove a record (optionally its file).
pub async fn delete(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(params): Query<DeleteParams>,
) -> AppResult<Response> {
    // Stop the backend download(s) if this item is still fetching — otherwise the
    // yt-dlp child keeps running after the row (and the UI card) are gone. Grab
    // the resolution files first (the rows cascade-delete with the item).
    let item = item_by_slug(&state, &slug).await?;
    let id = item.id;
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

/// GET /api/stats — what the header readout beside the heartbeat needs: how much
/// storage is used against the cap, plus whether anything is paused.
///
/// `limit_bytes` is null on an uncapped install (the gauge then just reports a
/// size). `paused` is a server-wide count on purpose: the global pause/resume
/// button keys off what the *backend* is holding, not off whichever page of items
/// this client happens to have fetched, so it stays correct when the paused work
/// is further down the list than the client has scrolled.
pub async fn stats(State(state): State<AppState>) -> AppResult<Response> {
    let (count, total_bytes) = state.db.download_stats().await?;
    let limit_bytes = crate::queue::resolve_max_storage(&state.cfg, &state.db).await;
    let paused = state.db.paused_count().await?;
    Ok(Json(json!({
        "count": count,
        "total_bytes": total_bytes,
        "limit_bytes": limit_bytes,
        "limit_locked": state.cfg.max_storage.is_some(),
        "paused": paused,
    }))
    .into_response())
}

/// GET /api/logs — recent probe/download errors (bounded ring buffer, newest
/// first) for the settings-panel diagnostics list. Token-required.
pub async fn logs(State(state): State<AppState>) -> AppResult<Response> {
    let entries = state.errlog.snapshot();
    Ok(Json(json!({ "entries": entries, "capacity": crate::errlog::CAPACITY })).into_response())
}

/// GET /api/items/:slug/resolutions — the resolution versions the SOURCE actually
/// offers (its real per-format heights, captured at probe time) and which are
/// already downloaded. Powers the per-item resolution multi-select.
pub async fn resolutions(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
    let id = item.id;
    let variant_rows = state.db.list_resolutions(id).await?;
    let downloaded: Vec<i64> = variant_rows.iter().map(|r| r.height).collect();
    // Per-variant on-disk sizes, so the card's size capsule can break the total
    // down into "1080p — 20.4 MB / 720p — 8.1 MB" without a second query.
    let variants: Vec<serde_json::Value> = variant_rows
        .iter()
        .map(|r| json!({ "height": r.height, "filesize": r.filesize }))
        .collect();

    // Source heights come from the probe done at submit (or a prior refresh). Use
    // the cache when we have it and kick off a background re-probe so the list
    // tracks the source over time; otherwise probe once now and store the result.
    let source_heights: Vec<i64> = match state.db.get_available_heights(id).await? {
        Some(h) if !h.is_empty() => {
            spawn_heights_refresh(state.clone(), item.clone());
            h
        }
        _ => probe_source_heights(&state, &item)
            .await
            .unwrap_or_default(),
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

    Ok(Json(json!({ "available": available, "downloaded": downloaded, "variants": variants }))
        .into_response())
}

/// Probe the source's available heights now and cache them. `None` on any
/// failure (SSRF guard / yt-dlp error) so the caller can degrade gracefully.
async fn probe_source_heights(state: &AppState, item: &crate::types::Item) -> Option<Vec<i64>> {
    if crate::net_guard::guard(&item.webpage_url, state.cfg.allow_private_dns)
        .await
        .is_err()
    {
        return None;
    }
    let cookie = crate::cookies::resolve(
        &state.cookies,
        state.cfg.cookies.as_deref(),
        &item.webpage_url,
    );
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

fn defer_resolution_removals(
    have: &std::collections::BTreeSet<i64>,
    desired: &std::collections::BTreeSet<i64>,
    to_add: &[i64],
) -> bool {
    !to_add.is_empty() && have.is_disjoint(desired)
}

/// PUT /api/items/:slug/resolutions — reconcile the item's downloaded resolutions
/// to the desired set: queue downloads for newly-selected heights, delete files
/// for deselected ones. Rejects an empty set (a video must keep ≥1 version;
/// deselecting everything must not silently fall back to the original).
pub async fn set_resolutions(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Json(req): Json<ResolutionsRequest>,
) -> AppResult<Response> {
    let item = item_by_slug(&state, &slug).await?;
    let id = item.id;

    if req.heights.len() > 16 {
        return Err(AppError::BadRequest(
            "at most 16 resolutions may be selected".into(),
        ));
    }

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
    // Replacing every downloaded variant would temporarily clear `filepath` and
    // force the client onto fragile upstream streaming. Keep the old files until
    // a requested replacement succeeds; each new job carries the same cleanup
    // list, so whichever lands first performs the atomic handoff.
    let deferred_removals = if defer_resolution_removals(&have, &desired, &to_add) {
        to_remove.clone()
    } else {
        Vec::new()
    };

    // Queue downloads for newly-selected resolutions highest-first: `to_add` comes
    // from a BTreeSet difference (ascending), so `.rev()` enqueues high→low. The
    // highest requested resolution therefore starts (and, at the common single-lane
    // concurrency, finishes) first; run_job's repoint_primary then serves it the
    // moment it lands, without waiting for the lower variants (Req 2/3).
    for h in to_add.iter().rev() {
        state
            .queue
            .enqueue_resolution_replacing(id, *h, deferred_removals.clone())
            .await;
    }

    // Make the persisted `target_height` authoritative the instant the request
    // returns. The worker only writes it when it actually picks up the variant
    // job (queue.rs run_job), so without this an immediate GET — which the UI
    // fires right after saving — still reports the OLD target and the
    // "downloading" capsule paints the stale height (e.g. 240p after a switch to
    // 720p). Pin it to the tallest newly-queued height, which is what the card
    // is now working toward.
    if let Some(target) = to_add.iter().copied().max() {
        state.db.set_target_height(id, Some(target)).await?;
    }

    // Remove deselected files immediately when another selected local version is
    // already available. A full replacement defers this cleanup to the jobs above.
    for h in to_remove.iter().filter(|h| !deferred_removals.contains(h)) {
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

#[cfg(test)]
mod tests {
    use super::defer_resolution_removals;
    use std::collections::BTreeSet;

    #[test]
    fn resolution_replacement_keeps_a_playable_primary_until_new_file_lands() {
        let have = BTreeSet::from([1920]);
        let desired = BTreeSet::from([568]);
        assert!(defer_resolution_removals(&have, &desired, &[568]));

        let have = BTreeSet::from([1920, 720]);
        let desired = BTreeSet::from([720, 568]);
        assert!(!defer_resolution_removals(&have, &desired, &[568]));
    }
}

/// The effective global container: env-pinned value wins, else the stored
/// setting, else the built-in default carried on Config.
pub(super) async fn global_container(state: &AppState) -> crate::config::Container {
    if state.cfg.container_user_set {
        return state.cfg.container;
    }
    match state.db.get_setting("container").await {
        Ok(Some(v)) => crate::config::Container::parse(&v).unwrap_or(state.cfg.container),
        _ => state.cfg.container,
    }
}

/// The effective global subtitle toggle: env-pinned value wins, else the stored
/// setting, else the Config default.
pub(super) async fn global_subs(state: &AppState) -> bool {
    if state.cfg.subs_user_set {
        return state.cfg.subs;
    }
    match state.db.get_setting("subs").await {
        Ok(Some(v)) => v == "1",
        _ => state.cfg.subs,
    }
}

/// GET /api/settings — runtime-adjustable settings.
///
/// `max_heights` is the current set of heights to download per item (`[0]` =
/// highest available, `[]` = stream-only / download nothing);
/// `max_heights_locked` is true when it's pinned to a single height by the
/// `ORCA_MAX_HEIGHT` env var and can't be changed from the UI. `container` /
/// `subs` follow the same shape, pinned by `ORCA_CONTAINER` / `ORCA_SUBS`.
/// `stream_quality` is the share-bandwidth cap and has no env pin.
pub async fn get_settings(State(state): State<AppState>) -> AppResult<Response> {
    let locked = state.cfg.max_height.is_some();
    let container = global_container(&state).await;
    let subs = global_subs(&state).await;
    let heights = match state.cfg.max_height {
        // An env pin is necessarily a single height and outranks the stored set.
        Some(h) => crate::resolution::HeightSet::from_heights(&[h]).unwrap_or_default(),
        None => match state.db.get_setting("max_heights").await? {
            Some(csv) => crate::resolution::HeightSet::parse(&csv),
            None => crate::resolution::HeightSet::parse("0"),
        },
    };
    let stream_quality = global_stream_quality(&state).await;
    Ok(Json(json!({
        "max_heights": heights.heights(),
        "max_heights_locked": locked,
        "stream_quality": stream_quality.as_str(),
        "container": container.ext(),
        "container_locked": state.cfg.container_user_set,
        "containers": crate::config::CONTAINERS.iter().map(|c| c.ext()).collect::<Vec<_>>(),
        "subs": subs,
        "subs_locked": state.cfg.subs_user_set,
        // Bytes, or null for uncapped. The UI renders this back into a number +
        // unit; bytes is the one representation that survives that round trip
        // without the unit choice mattering.
        "max_storage": crate::queue::resolve_max_storage(&state.cfg, &state.db).await,
        "max_storage_locked": state.cfg.max_storage.is_some(),
        // Throughput knobs. `concurrent_fragments` is the yt-dlp thread count per
        // download; `limit_rate` is the total rate cap in bytes/s (null = uncapped),
        // rendered back into a number + unit by the UI just like max_storage.
        "concurrent_fragments": crate::queue::resolve_concurrent_fragments(&state.cfg, &state.db).await,
        "concurrent_fragments_locked": state.cfg.concurrent_fragments_user_set,
        "limit_rate": crate::queue::resolve_limit_rate(&state.cfg, &state.db).await,
        "limit_rate_locked": state.cfg.limit_rate_user_set,
    }))
    .into_response())
}

/// The stored global share-bandwidth cap, or the built-in default.
async fn global_stream_quality(state: &AppState) -> crate::resolution::StreamQuality {
    state
        .db
        .get_setting("stream_quality")
        .await
        .ok()
        .flatten()
        .and_then(|v| crate::resolution::StreamQuality::parse(&v))
        .unwrap_or_default()
}

#[derive(Debug, Deserialize)]
pub struct SettingsRequest {
    /// New set of download heights: `[0]` = highest available, `[]` = download
    /// nothing (stream-only). Absent = leave as-is — which is why this is
    /// `Option<Vec<_>>` and not a bare `Vec`: an empty list is a real choice the
    /// user can make, and it must not be confused with "field not sent".
    #[serde(default)]
    pub max_heights: Option<Vec<i64>>,
    /// New global share-bandwidth cap. Absent = leave as-is.
    #[serde(default)]
    pub stream_quality: Option<String>,
    /// New global merge container (`"mkv"`, `"mp4"`, …). Absent = leave as-is.
    #[serde(default)]
    pub container: Option<String>,
    /// New global subtitle toggle. Absent = leave as-is.
    #[serde(default)]
    pub subs: Option<bool>,
    /// New storage cap in bytes; `Some(0)`/`Some(null)` clears it (unlimited),
    /// absent leaves it as-is. Double-`Option` for the same reason `max_heights`
    /// is an `Option<Vec>`: "set to unlimited" and "field not sent" are different
    /// requests and must not collapse into each other.
    #[serde(default, deserialize_with = "double_option")]
    pub max_storage: Option<Option<i64>>,
    /// New yt-dlp thread count per download (`--concurrent-fragments`). Absent =
    /// leave as-is; clamped to at least 1.
    #[serde(default)]
    pub concurrent_fragments: Option<i64>,
    /// New total download-rate cap in bytes/s; `Some(0)`/`Some(null)` clears it
    /// (unlimited), absent leaves it as-is. Double-`Option` for the same reason
    /// `max_storage` is: "set to unlimited" and "field not sent" differ.
    #[serde(default, deserialize_with = "double_option")]
    pub limit_rate: Option<Option<i64>>,
}

/// Distinguish an omitted field (`None`) from an explicit `null` (`Some(None)`).
fn double_option<'de, D>(de: D) -> Result<Option<Option<i64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

/// PUT /api/settings — update runtime settings. This is a *partial patch*: a
/// field absent from the body is left untouched, so saving one control can never
/// clobber another. Each field is rejected individually while env-pinned, so a
/// UI change can't silently contradict the operator's env var.
pub async fn put_settings(
    State(state): State<AppState>,
    Json(req): Json<SettingsRequest>,
) -> AppResult<Response> {
    if let Some(heights) = req.max_heights.as_deref() {
        if state.cfg.max_height.is_some() {
            return Err(AppError::BadRequest(
                "max_heights is pinned by the ORCA_MAX_HEIGHT environment variable".into(),
            ));
        }
        let set =
            crate::resolution::HeightSet::from_heights(heights).map_err(AppError::BadRequest)?;
        // Always store, even for the empty set: "" is the stream-only choice, and
        // clearing the row instead would silently reinstate the "highest" default.
        state
            .db
            .set_setting("max_heights", Some(&set.to_csv()))
            .await?;
    }

    if let Some(raw) = req.stream_quality.as_deref() {
        let q = crate::resolution::StreamQuality::parse(raw).ok_or_else(|| {
            AppError::BadRequest(format!(
                "stream_quality '{raw}' is invalid; valid options: {}",
                crate::resolution::StreamQuality::valid_list()
            ))
        })?;
        state
            .db
            .set_setting("stream_quality", Some(q.as_str()))
            .await?;
    }

    if let Some(raw) = req.container.as_deref() {
        if state.cfg.container_user_set {
            return Err(AppError::BadRequest(
                "container is pinned by the ORCA_CONTAINER environment variable".into(),
            ));
        }
        let c = crate::config::Container::parse(raw).ok_or_else(|| {
            AppError::BadRequest(format!(
                "container '{raw}' is invalid; valid options: {}",
                crate::config::Container::valid_list()
            ))
        })?;
        state.db.set_setting("container", Some(c.ext())).await?;
    }

    if let Some(subs) = req.subs {
        if state.cfg.subs_user_set {
            return Err(AppError::BadRequest(
                "subtitles are pinned by the ORCA_SUBS environment variable".into(),
            ));
        }
        state
            .db
            .set_setting("subs", Some(if subs { "1" } else { "0" }))
            .await?;
    }

    if let Some(bytes) = req.max_storage {
        if state.cfg.max_storage.is_some() {
            return Err(AppError::BadRequest(
                "max_storage is pinned by the ORCA_MAX_STORAGE environment variable".into(),
            ));
        }
        match bytes.filter(|b| *b > 0) {
            // A cap below what's already stored would park every future download on
            // arrival with no way back short of deleting things. Let the user set it
            // anyway (shrinking the cap is how you *start* a cleanup) but refuse the
            // nonsensical negative.
            Some(b) => {
                state
                    .db
                    .set_setting("max_storage", Some(&b.to_string()))
                    .await?
            }
            None => state.db.set_setting("max_storage", None).await?,
        }
    }

    if let Some(n) = req.concurrent_fragments {
        if state.cfg.concurrent_fragments_user_set {
            return Err(AppError::BadRequest(
                "concurrent_fragments is pinned by the ORCA_CONCURRENT_FRAGMENTS environment \
                 variable"
                    .into(),
            ));
        }
        if n < 1 {
            return Err(AppError::BadRequest(
                "concurrent_fragments must be at least 1".into(),
            ));
        }
        state
            .db
            .set_setting("concurrent_fragments", Some(&n.to_string()))
            .await?;
    }

    if let Some(bytes) = req.limit_rate {
        if state.cfg.limit_rate_user_set {
            return Err(AppError::BadRequest(
                "limit_rate is pinned by the ORCA_LIMIT_RATE environment variable".into(),
            ));
        }
        // Unlimited stores "0" (not a deleted row): the Config default is a
        // non-zero cap, so a missing row means "use the default", while an explicit
        // "0" is the user asking for no cap. resolve_limit_rate reads both.
        let stored = bytes.filter(|b| *b > 0).unwrap_or(0);
        state
            .db
            .set_setting("limit_rate", Some(&stored.to_string()))
            .await?;
    }

    get_settings(State(state)).await
}

/// GET /api/health — liveness (no auth).
pub async fn health(State(state): State<AppState>) -> Response {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "ytdlp": state.ytdlp_version,
        // Canonical public domain for share links; null when the operator
        // hasn't declared ORCA_PUBLIC_URL (UI falls back to its own origin).
        "public_url": state.cfg.public_url,
    }))
    .into_response()
}
