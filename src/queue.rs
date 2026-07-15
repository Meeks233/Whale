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
#[derive(Debug, Clone, Copy)]
pub struct Job {
    pub id: i64,
    pub height: Option<i64>,
}

/// In-flight downloads → their cancel signal, keyed by (item id, variant height).
/// Firing the `oneshot::Sender` kills that job's yt-dlp child (see `download()`);
/// registered while a job runs and removed when it finishes.
type Cancels = Arc<Mutex<HashMap<(i64, Option<i64>), oneshot::Sender<()>>>>;

#[derive(Clone)]
pub struct Queue {
    tx: mpsc::UnboundedSender<Job>,
    events: broadcast::Sender<ProgressEvent>,
    cancels: Cancels,
}

impl Queue {
    pub fn spawn(cfg: Config, db: Db, archive: Archive, cookies: CookieStore, errlog: ErrorLog) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
        let (events, _) = broadcast::channel::<ProgressEvent>(1024);
        let semaphore = Arc::new(Semaphore::new(cfg.effective_concurrency()));
        let cancels: Cancels = Arc::new(Mutex::new(HashMap::new()));

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
                    run_job(&cfg, &db, &archive, &cookies, &events, &errlog, &cancels, job).await;
                    drop(permit);
                });
            }
        });

        Queue { tx, events, cancels }
    }

    /// Enqueue an item's primary download.
    pub async fn enqueue(&self, item_id: i64) {
        let _ = self.tx.send(Job { id: item_id, height: None });
    }

    /// Enqueue a specific-resolution variant download for an item (an extra file
    /// at `height`, kept alongside the primary).
    pub async fn enqueue_resolution(&self, item_id: i64, height: i64) {
        let _ = self.tx.send(Job { id: item_id, height: Some(height) });
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
        let keys: Vec<_> = map.keys().filter(|(id, _)| *id == item_id).copied().collect();
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

/// The effective max-height cap for a download: the env override if the operator
/// set `WHALE_MAX_HEIGHT` (always wins), else the per-site cap from the website
/// registry for this URL, else the UI-stored global `max_height`, else `None`
/// (highest).
async fn resolve_max_height(
    cfg: &Config,
    db: &Db,
    sites: &[crate::types::Website],
    url: &str,
) -> Option<i64> {
    if cfg.max_height.is_some() {
        return cfg.max_height;
    }
    // Per-site cap overrides the global setting when the site pins one.
    if let Some(h) = crate::websites::detect(sites, url).and_then(|w| w.max_height) {
        if h > 0 {
            return Some(h);
        }
    }
    db.get_setting("max_height")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|h| *h > 0)
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

    // Forward per-tick progress from the downloader into the broadcast.
    let (ptx, mut prx) = mpsc::channel::<ProgressEvent>(64);
    let fwd_events = events.clone();
    let forwarder = tokio::spawn(async move {
        while let Some(ev) = prx.recv().await {
            let _ = fwd_events.send(ev);
        }
    });

    // Load the website registry once for this job — it drives both the per-site
    // resolution cap and the per-site cookie selection (incl. user-added sites).
    let sites = db.list_websites().await.unwrap_or_default();
    let site_key = crate::websites::detect(&sites, &item.webpage_url).map(|w| w.key.clone());

    // Resolution cap: a variant pins exactly the requested height; the primary
    // uses the effective cap (env `WHALE_MAX_HEIGHT`, else per-site, else global).
    let cap = match variant {
        Some(h) => Some(h),
        None => resolve_max_height(cfg, db, &sites, &item.webpage_url).await,
    };
    let mut job_cfg = cfg.clone();
    job_cfg.format = cfg.format_capped(cap);

    // Register a cancel handle (keyed per item+variant) so a delete / deselect can
    // kill this download's yt-dlp child mid-flight instead of leaving it running.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert((id, variant), cancel_tx);

    // Auto-select this site's cookie via the registry key (falls back to global).
    let cookie = crate::cookies::resolve_keyed(cookies, cfg.cookies.as_deref(), site_key.as_deref());
    let result =
        crate::ytdlp::download(&job_cfg, &item, cookie.as_deref(), ptx, cancel_rx, variant).await;
    forwarder.abort();
    // Job is done (any outcome): drop its cancel registration.
    cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&(id, variant));

    match result {
        // Cancelled by a delete / deselect: the child was killed and the row is
        // (being) removed, so there's nothing to mark or report — exit quietly.
        Err(crate::ytdlp::YtdlpError::Cancelled) => {
            tracing::info!(job_id = id, variant = ?variant, "download cancelled");
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
                    id, status: Status::Completed, percent: None, speed: None, eta: None, phase: None,
                });
            } else if let Some(path) = existing.filter(|_| has_file) {
                tracing::info!(job_id = id, "primary skipped by archive; keeping existing local file");
                let size = std::fs::metadata(path)
                    .map(|m| m.len() as i64)
                    .unwrap_or(item.filesize.unwrap_or(0));
                let _ = db.set_completed(id, path, size, item.height).await;
                if let Some(h) = item.height {
                    let _ = db.upsert_resolution(id, h, path, size).await;
                    let _ = db.repoint_primary(id).await;
                }
                let _ = events.send(ProgressEvent {
                    id, status: Status::Completed, percent: Some(100.0), speed: None, eta: None, phase: None,
                });
            } else {
                let msg = "already in the download archive but the local file is missing — remove its dedup entry (Settings → Archive editor) to re-download";
                if let Err(e) = db.set_status(id, Status::Failed, Some(msg)).await {
                    tracing::error!(job_id = id, error = %e, "set_status(failed) failed");
                }
                let _ = events.send(ProgressEvent {
                    id, status: Status::Failed, percent: None, speed: None, eta: None, phase: None,
                });
            }
        }
        Ok(out) => match variant {
            // Primary download: mark the item completed and record its resolution.
            None => {
                if let Err(e) = db.set_completed(id, &out.filepath, out.filesize, out.height).await {
                    tracing::error!("job {id}: set_completed failed: {e}");
                }
                if let Some(h) = out.height {
                    let _ = db.upsert_resolution(id, h, &out.filepath, out.filesize).await;
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
                let _ = db.upsert_resolution(id, h, &out.filepath, out.filesize).await;
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
            // the raw yt-dlp error tail) — filter with `level=error target=whale::queue`
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
