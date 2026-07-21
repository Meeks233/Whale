//! Download worker: semaphore-bounded job loop + SSE broadcast. See docs/DOWNLOAD_PIPELINE.md §4.

use crate::archive::Archive;
use crate::config::Config;
use crate::cookies::CookieStore;
use crate::db::Db;
use crate::errlog::ErrorLog;
use crate::types::{ProgressEvent, Status};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, oneshot, Semaphore};

/// One queued download: an item, and optionally a specific resolution `height`
/// to fetch as an extra file (a "variant"). `height: None` is the item's primary
/// download.
#[derive(Debug)]
pub struct Job {
    pub id: i64,
    pub height: Option<i64>,
    /// Existing variants to remove only after this replacement downloads.
    pub remove_after: Vec<i64>,
}

/// In-flight downloads → their cancel signal, keyed by (item id, variant height).
/// Firing the `oneshot::Sender` kills that job's yt-dlp child (see `download()`);
/// registered while a job runs and removed when it finishes.
type Cancels = Arc<Mutex<HashMap<(i64, Option<i64>), oneshot::Sender<()>>>>;

/// Latest progress tick per running item id. SSE is fire-and-forget, so a client
/// that is not holding the stream open (the Android notification service polls
/// `GET /api/items/:slug` instead) had no way to read percent/speed/eta. This
/// cache lets a plain GET answer "how far along is this download right now".
type LiveProgress = Arc<Mutex<HashMap<i64, ProgressEvent>>>;

#[derive(Clone)]
pub struct Queue {
    tx: mpsc::Sender<Job>,
    events: broadcast::Sender<ProgressEvent>,
    cancels: Cancels,
    live: LiveProgress,
}

impl Queue {
    pub fn spawn(
        cfg: Config,
        db: Db,
        archive: Archive,
        cookies: CookieStore,
        errlog: ErrorLog,
    ) -> Self {
        let (tx, mut rx) = mpsc::channel::<Job>(1024);
        let (events, _) = broadcast::channel::<ProgressEvent>(1024);
        let semaphore = Arc::new(Semaphore::new(cfg.effective_concurrency()));
        let cancels: Cancels = Arc::new(Mutex::new(HashMap::new()));
        let live: LiveProgress = Arc::new(Mutex::new(HashMap::new()));

        // Mirror the broadcast into `live` from a plain subscriber, so no job code
        // has to know this cache exists. A terminal tick drops the entry: the DB
        // row is authoritative once a download stops running.
        let live_writer = live.clone();
        let mut live_rx = events.subscribe();
        tokio::spawn(async move {
            loop {
                match live_rx.recv().await {
                    Ok(ev) => {
                        let mut map = live_writer.lock().unwrap_or_else(|e| e.into_inner());
                        if matches!(ev.status, Status::Completed | Status::Failed) {
                            map.remove(&ev.id);
                        } else {
                            map.insert(ev.id, ev);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });

        let worker_events = events.clone();
        let worker_cancels = cancels.clone();
        tokio::spawn(async move {
            let mut first = true;
            while let Some(job) = rx.recv().await {
                let permit = match semaphore.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => break, // semaphore closed
                };
                // Polite pacing: wait a random 2–7s (config) between downloads so
                // the arrival-ordered queue doesn't look like a batch downloader.
                // Skipped before the very first job to avoid a cold-start stall.
                if !first {
                    let delay = cfg.polite_delay();
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                }
                first = false;
                let cfg = cfg.clone();
                let db = db.clone();
                let archive = archive.clone();
                let cookies = cookies.clone();
                let events = worker_events.clone();
                let errlog = errlog.clone();
                let cancels = worker_cancels.clone();
                tokio::spawn(async move {
                    run_job(
                        &cfg, &db, &archive, &cookies, &events, &errlog, &cancels, job,
                    )
                    .await;
                    drop(permit);
                });
            }
        });

        Queue {
            tx,
            events,
            cancels,
            live,
        }
    }

    /// Latest progress tick for a running item, if one is in flight.
    pub fn live_progress(&self, item_id: i64) -> Option<ProgressEvent> {
        self.live
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&item_id)
            .cloned()
    }

    /// Enqueue an item's primary download.
    pub async fn enqueue(&self, item_id: i64) {
        let _ = self
            .tx
            .send(Job {
                id: item_id,
                height: None,
                remove_after: Vec::new(),
            })
            .await;
    }

    /// Enqueue a variant and remove `remove_after` only after it lands. This keeps
    /// the current primary playable throughout a resolution replacement.
    pub async fn enqueue_resolution_replacing(
        &self,
        item_id: i64,
        height: i64,
        remove_after: Vec<i64>,
    ) {
        let _ = self
            .tx
            .send(Job {
                id: item_id,
                height: Some(height),
                remove_after,
            })
            .await;
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ProgressEvent> {
        self.events.subscribe()
    }

    /// Cancel every in-flight download for an item (primary + any resolution
    /// variants), killing their yt-dlp children. Returns `true` if at least one
    /// running job was signalled. Called on delete so the backend stops fetching
    /// a video the user no longer wants.
    pub fn cancel(&self, item_id: i64) -> bool {
        let mut map = self.cancels.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<_> = map
            .keys()
            .filter(|(id, _)| *id == item_id)
            .copied()
            .collect();
        let mut any = false;
        for k in keys {
            if let Some(tx) = map.remove(&k) {
                any |= tx.send(()).is_ok();
            }
        }
        any
    }

    /// Cancel just one specific-resolution variant download (used when the user
    /// deselects a resolution that's still downloading).
    pub fn cancel_variant(&self, item_id: i64, height: i64) -> bool {
        if let Some(tx) = self
            .cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(item_id, Some(height)))
        {
            tx.send(()).is_ok()
        } else {
            false
        }
    }
}

/// Fraction still free at which new downloads stop starting: the record is kept
/// (and stays streamable), but the fetch is parked as `Paused` until space frees
/// up. A reserve rather than a hard 100% wall, because the *predicted* size of a
/// download isn't known until it lands — this leaves room for the one in flight.
pub const STORAGE_BLOCK_FREE: f64 = 0.05;

/// The effective storage cap in bytes: `ORCA_MAX_STORAGE` if the operator set it
/// (always wins), else the UI-stored global, else unlimited (`None`). Mirrors the
/// `resolve_max_heights` precedence ladder.
pub async fn resolve_max_storage(cfg: &Config, db: &Db) -> Option<i64> {
    if let Some(bytes) = cfg.max_storage {
        return Some(bytes);
    }
    db.get_setting("max_storage")
        .await
        .ok()
        .flatten()
        .and_then(|v| crate::config::parse_size(&v))
        .filter(|b| *b > 0)
}

/// `(used_bytes, limit_bytes)` for the storage readout. `limit` is `None` when
/// nothing caps the install.
pub async fn storage_usage(cfg: &Config, db: &Db) -> (i64, Option<i64>) {
    let used = db.download_stats().await.map(|(_, b)| b).unwrap_or(0);
    (used, resolve_max_storage(cfg, db).await)
}

/// True once free space has fallen under the `STORAGE_BLOCK_FREE` reserve, i.e.
/// new downloads must be recorded-but-paused instead of fetched. Always false on
/// an uncapped install.
pub async fn storage_full(cfg: &Config, db: &Db) -> bool {
    let (used, limit) = storage_usage(cfg, db).await;
    match limit {
        Some(limit) if limit > 0 => (limit - used) as f64 <= limit as f64 * STORAGE_BLOCK_FREE,
        _ => false,
    }
}

/// Throw away the half-finished files of a cancelled download.
///
/// This is the whole of the difference between cancel and pause. Both kill the
/// yt-dlp child; pause then leaves the `.part` files alone precisely so
/// `--continue` can pick the transfer back up, which is exactly what a cancel
/// must NOT allow — an abandoned download that quietly kept its bytes would be a
/// pause wearing another name, and would hold disk against the storage cap for a
/// file nobody is waiting for.
///
/// Every partial lives directly in `<download_dir>/.part` (see `download_args`),
/// named from the output template, which ends in `[<video_id>]` — that tag is how
/// an item's own fragments are told apart from every other download's. Matching
/// is confined to that one flat directory and to entries that are files, so a
/// pathological video id can only ever fail to match, never reach outside.
/// Best-effort throughout: a partial we cannot remove is litter, not a reason to
/// refuse the cancel the user asked for.
pub fn discard_partials(download_dir: &std::path::Path, video_id: &str) -> usize {
    if video_id.is_empty() {
        return 0;
    }
    let tag = format!("[{video_id}]");
    let part_dir = download_dir.join(".part");
    let Ok(entries) = std::fs::read_dir(&part_dir) else {
        return 0; // no partials yet — nothing to discard
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.contains(&tag) || !entry.path().is_file() {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(e) => tracing::warn!(file = name, error = %e, "failed to discard partial"),
        }
    }
    removed
}

/// The effective set of download heights for a URL: the env override if the
/// operator set `ORCA_MAX_HEIGHT` (always wins, and is necessarily a single
/// height), else the per-site set from the website registry, else the UI-stored
/// global `max_heights`, else "highest available".
///
/// An empty set means stream-only. Note the difference between a site that pins
/// the empty set (`Some("")` → download nothing) and one that follows global
/// (`None` → whatever the global says); collapsing those two is the bug this
/// ladder exists to avoid.
pub async fn resolve_max_heights(
    cfg: &Config,
    db: &Db,
    sites: &[crate::types::Website],
    url: &str,
) -> crate::resolution::HeightSet {
    use crate::resolution::HeightSet;
    if let Some(h) = cfg.max_height {
        return HeightSet::from_heights(&[h]).unwrap_or_default();
    }
    if let Some(csv) = crate::websites::detect(sites, url).and_then(|w| w.max_heights.clone()) {
        return HeightSet::parse(&csv);
    }
    match db.get_setting("max_heights").await.ok().flatten() {
        Some(csv) => HeightSet::parse(&csv),
        // Unset global = highest available, matching the pre-multi-select default.
        None => HeightSet::parse("0"),
    }
}

/// The effective share-bandwidth cap for a URL: per-site override, else the
/// UI-stored global, else the built-in default (`Higher`). There is no env knob
/// for this one — it is a sharing policy, not a deployment constant.
pub async fn resolve_stream_quality(
    db: &Db,
    sites: &[crate::types::Website],
    url: &str,
) -> crate::resolution::StreamQuality {
    use crate::resolution::StreamQuality;
    if let Some(q) = crate::websites::detect(sites, url)
        .and_then(|w| w.stream_quality.clone())
        .and_then(|s| StreamQuality::parse(&s))
    {
        return q;
    }
    db.get_setting("stream_quality")
        .await
        .ok()
        .flatten()
        .and_then(|v| StreamQuality::parse(&v))
        .unwrap_or_default()
}

/// The effective merge container for a download, same precedence ladder as
/// `resolve_max_height`: `ORCA_CONTAINER` > per-site override > UI-stored global
/// > the built-in default carried on Config.
async fn resolve_container(
    cfg: &Config,
    db: &Db,
    sites: &[crate::types::Website],
    url: &str,
) -> crate::config::Container {
    if cfg.container_user_set {
        return cfg.container;
    }
    if let Some(c) = crate::websites::detect(sites, url)
        .and_then(|w| w.container.as_deref())
        .and_then(crate::config::Container::parse)
    {
        return c;
    }
    db.get_setting("container")
        .await
        .ok()
        .flatten()
        .and_then(|v| crate::config::Container::parse(&v))
        .unwrap_or(cfg.container)
}

/// Whether to capture subtitles for a download: `ORCA_SUBS` > per-site override
/// > UI-stored global > the Config default (on).
async fn resolve_subs(cfg: &Config, db: &Db, sites: &[crate::types::Website], url: &str) -> bool {
    if cfg.subs_user_set {
        return cfg.subs;
    }
    if let Some(s) = crate::websites::detect(sites, url).and_then(|w| w.subs) {
        return s;
    }
    db.get_setting("subs")
        .await
        .ok()
        .flatten()
        .map(|v| v == "1")
        .unwrap_or(cfg.subs)
}

/// Effective multi-threaded fragment count: `ORCA_CONCURRENT_FRAGMENTS` if the
/// operator pinned it (always wins), else the UI-stored global, else the Config
/// default. Clamped to at least 1.
pub async fn resolve_concurrent_fragments(cfg: &Config, db: &Db) -> usize {
    if cfg.concurrent_fragments_user_set {
        return cfg.concurrent_fragments;
    }
    db.get_setting("concurrent_fragments")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .map(|n| n.max(1))
        .unwrap_or(cfg.concurrent_fragments)
}

/// Effective total download-rate cap in bytes/s, or `None` for unlimited:
/// `ORCA_LIMIT_RATE` if the operator pinned it (always wins), else the UI-stored
/// global (a plain byte count, or `""`/`"0"` = unlimited), else the Config
/// default. Mirrors `resolve_max_storage`.
pub async fn resolve_limit_rate(cfg: &Config, db: &Db) -> Option<i64> {
    if cfg.limit_rate_user_set {
        return cfg
            .limit_rate
            .as_deref()
            .and_then(crate::config::parse_rate)
            .map(|b| b as i64);
    }
    match db.get_setting("limit_rate").await.ok().flatten() {
        Some(v) => v.parse::<i64>().ok().filter(|b| *b > 0),
        None => cfg
            .limit_rate
            .as_deref()
            .and_then(crate::config::parse_rate)
            .map(|b| b as i64),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_job(
    cfg: &Config,
    db: &Db,
    archive: &Archive,
    cookies: &CookieStore,
    events: &broadcast::Sender<ProgressEvent>,
    errlog: &ErrorLog,
    cancels: &Cancels,
    job: Job,
) {
    let id = job.id;
    let variant = job.height; // Some(h) → an extra resolution copy; None → primary.

    let item = match db.get(id).await {
        Ok(Some(item)) => item,
        Ok(None) => {
            tracing::warn!("job {id}: item vanished before download");
            return;
        }
        Err(e) => {
            tracing::error!("job {id}: db.get failed: {e}");
            return;
        }
    };

    // A pause or a cancel that landed after this job was queued: the job is
    // already sitting in the channel and can't be pulled back out, so honour the
    // decision here instead. Neither status may be overwritten by the Running
    // write below — that would restart the very download the user just stopped.
    if matches!(item.status, Status::Paused | Status::Canceled) {
        tracing::info!(job_id = id, variant = ?variant, status = item.status.as_str(),
            "job skipped: item is not to be downloaded");
        return;
    }

    // Only the primary download owns the item's status. A variant is fetched for
    // an already-completed item, so it must not flip the card back to "running"
    // in the DB (it still shows live progress via the forwarded SSE ticks).
    if variant.is_none() {
        if let Err(e) = db.set_status(id, Status::Running, None).await {
            tracing::error!("job {id}: failed to mark running: {e}");
            return;
        }
        let _ = events.send(ProgressEvent {
            id,
            status: Status::Running,
            percent: None,
            speed: None,
            eta: None,
            phase: None,
        });
    }

    // Forward per-tick progress from the downloader into the broadcast.
    let (ptx, mut prx) = mpsc::channel::<ProgressEvent>(64);
    let fwd_events = events.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(ev) = prx.recv().await {
            let _ = fwd_events.send(ev);
        }
    });

    // Load the website registry once for this job — it drives the per-site
    // resolution cap, container, subtitle toggle, and cookie selection (incl.
    // user-added sites).
    let sites = db.list_websites().await.unwrap_or_default();
    let site_key = crate::websites::detect(&sites, &item.webpage_url).map(|w| w.key.clone());

    // Resolution cap: a variant pins exactly the requested height; the primary
    // takes the tallest height of the effective set (env `ORCA_MAX_HEIGHT`, else
    // per-site, else global), so the item's own file is its best copy and any
    // shorter picks arrive as variants enqueued alongside it. `HIGHEST` (0) and an
    // empty set both mean "no cap" here — an empty set never reaches a download
    // in the first place (submit keeps it stream-only).
    let cap = match variant {
        Some(h) => {
            // A variant is a resolution upgrade against an already-completed item.
            // Its status never flips to Running, so the card's live chip has only
            // `target_height` to name the quality being fetched — record the exact
            // height this variant pins so the chip reads e.g. "1080p", not a bare
            // spinner, for any client that (re)loads the row mid-download.
            if let Err(e) = db.set_target_height(id, Some(h)).await {
                tracing::warn!(job_id = id, error = %e, "failed to record variant target height");
            }
            Some(h)
        }
        None => {
            // A prepare-card submission pins one height for this item (goal 4):
            // honour it as the cap in place of the settings ladder. `Some(0)` is an
            // explicit "highest available", so it caps at nothing like HIGHEST does.
            let heights = match item.requested_height {
                Some(h) => crate::resolution::HeightSet::single_requested(h).unwrap_or_default(),
                None => resolve_max_heights(cfg, db, &sites, &item.webpage_url).await,
            };
            // What this run is aiming for, snapped against the heights the source
            // actually offers, and recorded for the card's live chip. It is NOT the
            // cap below: the cap can be "no cap" (HIGHEST) or a 4320 the source
            // never had, neither of which is a quality a user can be told to
            // expect. Best-effort — a chip is not worth failing a download over.
            let available = db
                .get_available_heights(id)
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
            let target = heights
                .resolve(&available)
                .first()
                .copied()
                .filter(|h| *h > 0);
            if let Err(e) = db.set_target_height(id, target).await {
                tracing::warn!(job_id = id, error = %e, "failed to record target height");
            }
            heights.heights().first().copied().filter(|h| *h > 0)
        }
    };
    let mut job_cfg = cfg.clone();
    job_cfg.format = cfg.format_capped(cap);
    // Container and subtitle capture resolve identically for a variant and the
    // primary — a 720p copy of a video should land in the same container, with
    // the same subtitles, as the original.
    job_cfg.container = resolve_container(cfg, db, &sites, &item.webpage_url).await;
    job_cfg.subs = resolve_subs(cfg, db, &sites, &item.webpage_url).await;
    // Global throughput knobs: thread count and total rate cap, both UI-adjustable
    // unless env-pinned. The rate is stored/resolved as bytes/s; per_job_limit_rate
    // then divides it across the concurrent jobs.
    job_cfg.concurrent_fragments = resolve_concurrent_fragments(cfg, db).await;
    job_cfg.limit_rate = resolve_limit_rate(cfg, db)
        .await
        .map(|bytes| bytes.to_string());

    // Register a cancel handle (keyed per item+variant) so a delete / deselect can
    // kill this download's yt-dlp child mid-flight instead of leaving it running.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert((id, variant), cancel_tx);

    // Auto-select this site's cookie via the registry key (falls back to global).
    let cookie =
        crate::cookies::resolve_keyed(cookies, cfg.cookies.as_deref(), site_key.as_deref());
    let result =
        crate::ytdlp::download(&job_cfg, &item, cookie.as_deref(), ptx, cancel_rx, variant).await;
    forwarder.abort();
    // Job is done (any outcome): drop its cancel registration.
    cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&(id, variant));

    match result {
        // Cancelled by a delete / deselect / pause: the child was killed, and the
        // caller has already put the row in its intended state (removed, or marked
        // Paused) — so there's nothing to mark or report here. Writing a status
        // now would race that caller and clobber it; exit quietly instead.
        Err(crate::ytdlp::YtdlpError::Cancelled) => {
            tracing::info!(job_id = id, variant = ?variant, "download cancelled");
            // Broadcast the item's SETTLED status as the terminal tick so the live
            // chip clears on EVERY connected client — not just the caller that made
            // the HTTP request. The cancel/pause handler has already written the new
            // status (Canceled / Paused) before killing the child, so reading it back
            // here reports the truth without racing anyone; a running tick can't
            // re-arm the row because this runs AFTER `forwarder.abort()` and is thus
            // the last event for this job. Without this, a cancel/pause fired from one
            // client left every OTHER client frozen on the last running frame (the
            // "dead progress" bug). If the row is gone (a delete), db.get is None and
            // we stay quiet — the delete path notifies clients itself, and reporting a
            // fabricated Completed would be worse than silence.
            if let Some(it) = db.get(id).await.ok().flatten() {
                let _ = events.send(ProgressEvent {
                    id,
                    status: it.status,
                    percent: None,
                    speed: None,
                    eta: None,
                    phase: None,
                });
            }
        }
        // yt-dlp skipped the download because the archive already has this key (a
        // re-submit / force of something already downloaded). Don't fail the item:
        // if the local file is still there it's genuinely complete — keep it
        // completed and clear any stale error. Variants bypass the archive, so this
        // only applies to a primary download.
        Err(crate::ytdlp::YtdlpError::AlreadyDownloaded) => {
            let existing = item.filepath.as_deref().filter(|p| !p.is_empty());
            let has_file = existing
                .map(|p| std::path::Path::new(p).is_file())
                .unwrap_or(false);
            if variant.is_some() {
                // Shouldn't happen (archive bypassed for variants) — just clear the
                // transient running state.
                let _ = events.send(ProgressEvent {
                    id,
                    status: Status::Completed,
                    percent: None,
                    speed: None,
                    eta: None,
                    phase: None,
                });
            } else if let Some(path) = existing.filter(|_| has_file) {
                tracing::info!(
                    job_id = id,
                    "primary skipped by archive; keeping existing local file"
                );
                let size = std::fs::metadata(path)
                    .map(|m| m.len() as i64)
                    .unwrap_or(item.filesize.unwrap_or(0));
                let _ = db.set_completed(id, path, size, item.height).await;
                if let Some(h) = item.height {
                    let _ = db.upsert_resolution(id, h, path, size).await;
                    let _ = db.repoint_primary(id).await;
                }
                let _ = events.send(ProgressEvent {
                    id,
                    status: Status::Completed,
                    percent: Some(100.0),
                    speed: None,
                    eta: None,
                    phase: None,
                });
            } else {
                let msg = "already in the download archive but the local file is missing — remove its dedup entry (Settings → Archive editor) to re-download";
                if let Err(e) = db.set_status(id, Status::Failed, Some(msg)).await {
                    tracing::error!(job_id = id, error = %e, "set_status(failed) failed");
                }
                let _ = events.send(ProgressEvent {
                    id,
                    status: Status::Failed,
                    percent: None,
                    speed: None,
                    eta: None,
                    phase: None,
                });
            }
        }
        Ok(out) => match variant {
            // Primary download: mark the item completed and record its resolution.
            None => {
                if let Err(e) = db
                    .set_completed(id, &out.filepath, out.filesize, out.height)
                    .await
                {
                    tracing::error!("job {id}: set_completed failed: {e}");
                }
                if let Some(h) = out.height {
                    let _ = db
                        .upsert_resolution(id, h, &out.filepath, out.filesize)
                        .await;
                    // Keep the item's primary pointed at its highest downloaded
                    // version (a re-download at a higher cap should surface it).
                    let _ = db.repoint_primary(id).await;
                }
                // yt-dlp already recorded this key in the `--download-archive` file;
                // mirror it into the in-memory set only (appending would duplicate
                // the on-disk line).
                archive.mark_downloaded(&item.archive_key).await;
                let _ = events.send(ProgressEvent {
                    id,
                    status: Status::Completed,
                    percent: Some(100.0),
                    speed: None,
                    eta: None,
                    phase: None,
                });
            }
            // Variant download: record the extra file under the REQUESTED height
            // (matches the UI checkbox), leaving the item's own status untouched.
            Some(h) => {
                let _ = db
                    .upsert_resolution(id, h, &out.filepath, out.filesize)
                    .await;
                // A replacement is now safely playable. Only now remove the old
                // variants that the user deselected; if the download had failed,
                // this block would never run and the old primary would survive.
                for old_height in &job.remove_after {
                    if let Ok(Some(path)) = db.delete_resolution(id, *old_height).await {
                        if let Some(path) = crate::safepath::confined_file(&cfg.download_dir, &path)
                        {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                }
                // A newly-fetched variant may now be the highest version the item
                // holds — repoint the primary so the card shows the best one (Req 3).
                let _ = db.repoint_primary(id).await;
                // Clear the transient running state on the card.
                let _ = events.send(ProgressEvent {
                    id,
                    status: Status::Completed,
                    percent: Some(100.0),
                    speed: None,
                    eta: None,
                    phase: None,
                });
            }
        },
        Err(e) => {
            let raw = e.to_string();
            // Enrich the stored/displayed message: a login-gated download (e.g. an
            // X video that probed OK but needs cookies to fetch) gets an actionable
            // "add your cookies" hint instead of a cryptic yt-dlp tail.
            let msg = crate::ytdlp::explain_error(&item.webpage_url, &raw);
            // Structured error event: one greppable record per failure carrying
            // the fields you need to debug it (job id, source, url, extractor,
            // the raw yt-dlp error tail) — filter with `level=error target=orca::queue`
            // instead of scraping interpolated strings.
            tracing::error!(
                job_id = id,
                variant = ?variant,
                url = %item.webpage_url,
                extractor = %item.extractor,
                archive_key = %item.archive_key,
                error = %raw,
                "download failed"
            );
            // Mirror into the UI-visible error log (bounded, newest-first).
            errlog.push("download", &item.webpage_url, &item.extractor, &msg);
            // A variant failure must not fail the whole item (its primary file is
            // fine) — just clear the transient running state. A primary failure
            // marks the item Failed as before.
            if variant.is_none() {
                let existing = item.filepath.as_deref().filter(|p| !p.is_empty());
                let has_existing =
                    existing.and_then(|p| std::fs::metadata(p).ok().map(|m| (p, m.len() as i64)));
                if let Some((path, size)) = has_existing {
                    // A forced refresh may fail while its previous completed file
                    // is still intact. Restore that known-good media instead of
                    // stranding the row in Failed with an unusable local file.
                    match db.set_completed(id, path, size, item.height).await {
                        Ok(()) => {
                            let _ = events.send(ProgressEvent {
                                id,
                                status: Status::Completed,
                                percent: Some(100.0),
                                speed: None,
                                eta: None,
                                phase: None,
                            });
                        }
                        Err(e) => {
                            tracing::error!(job_id = id, error = %e, "restore completed file failed");
                            if let Err(status_error) =
                                db.set_status(id, Status::Failed, Some(&msg)).await
                            {
                                tracing::error!(job_id = id, error = %status_error, "set_status(failed) failed");
                            }
                            let _ = events.send(ProgressEvent {
                                id,
                                status: Status::Failed,
                                percent: None,
                                speed: None,
                                eta: None,
                                phase: None,
                            });
                        }
                    }
                } else {
                    if let Err(e) = db.set_status(id, Status::Failed, Some(&msg)).await {
                        tracing::error!(job_id = id, error = %e, "set_status(failed) failed");
                    }
                    let _ = events.send(ProgressEvent {
                        id,
                        status: Status::Failed,
                        percent: None,
                        speed: None,
                        eta: None,
                        phase: None,
                    });
                }
            } else {
                let _ = events.send(ProgressEvent {
                    id,
                    status: Status::Completed,
                    percent: None,
                    speed: None,
                    eta: None,
                    phase: None,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &std::path::Path) {
        std::fs::write(path, b"partial").unwrap();
    }

    /// The partial directory is shared by every in-flight download, so a cancel
    /// has to take its own item's fragments and nothing else. The `[<video_id>]`
    /// tag the output template puts in every name is what tells them apart.
    #[test]
    fn discard_partials_takes_only_the_matching_items_fragments() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join(".part");
        std::fs::create_dir_all(&part).unwrap();

        let mine = [
            "Chan - 2026-01-01 - Clip [abc123].mp4.part",
            "Chan - 2026-01-01 - Clip [abc123].f137.mp4.part-Frag2.part",
            "Chan - 2026-01-01 - Clip [abc123] [720p].mkv.part",
        ];
        let theirs = [
            "Chan - 2026-01-01 - Other [zzz999].mp4.part",
            // A near-miss: the id appears, but not as the template's tag.
            "Chan - abc123 - Not tagged [zzz999].mp4.part",
        ];
        for name in mine.iter().chain(theirs.iter()) {
            touch(&part.join(name));
        }

        assert_eq!(discard_partials(dir.path(), "abc123"), 3);
        for name in mine {
            assert!(!part.join(name).exists(), "{name} should be gone");
        }
        for name in theirs {
            assert!(
                part.join(name).exists(),
                "{name} belongs to another download"
            );
        }
    }

    /// An item with no partials (nothing downloaded yet, or no `.part` dir at all)
    /// is a no-op, not an error — cancelling it still has to succeed.
    #[test]
    fn discard_partials_is_a_no_op_when_there_is_nothing_to_discard() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(discard_partials(dir.path(), "abc123"), 0);
        std::fs::create_dir_all(dir.path().join(".part")).unwrap();
        assert_eq!(discard_partials(dir.path(), "abc123"), 0);
        // An empty video id must never match "[]" or sweep the directory.
        touch(&dir.path().join(".part").join("Something [].mp4.part"));
        assert_eq!(discard_partials(dir.path(), ""), 0);
    }
}
