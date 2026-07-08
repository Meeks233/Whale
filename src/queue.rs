//! Download worker: semaphore-bounded job loop + SSE broadcast. See docs/DOWNLOAD_PIPELINE.md §4.

use crate::archive::Archive;
use crate::config::Config;
use crate::cookies::CookieStore;
use crate::db::Db;
use crate::types::{ProgressEvent, Status};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Semaphore};

#[derive(Clone)]
pub struct Queue {
    tx: mpsc::UnboundedSender<i64>,
    events: broadcast::Sender<ProgressEvent>,
}

impl Queue {
    pub fn spawn(cfg: Config, db: Db, archive: Archive, cookies: CookieStore) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<i64>();
        let (events, _) = broadcast::channel::<ProgressEvent>(1024);
        let semaphore = Arc::new(Semaphore::new(cfg.concurrency.max(1)));

        let worker_events = events.clone();
        tokio::spawn(async move {
            while let Some(id) = rx.recv().await {
                let permit = match semaphore.clone().acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => break, // semaphore closed
                };
                let cfg = cfg.clone();
                let db = db.clone();
                let archive = archive.clone();
                let cookies = cookies.clone();
                let events = worker_events.clone();
                tokio::spawn(async move {
                    run_job(&cfg, &db, &archive, &cookies, &events, id).await;
                    drop(permit);
                });
            }
        });

        Queue { tx, events }
    }

    pub async fn enqueue(&self, item_id: i64) {
        let _ = self.tx.send(item_id);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ProgressEvent> {
        self.events.subscribe()
    }
}

async fn run_job(
    cfg: &Config,
    db: &Db,
    archive: &Archive,
    cookies: &CookieStore,
    events: &broadcast::Sender<ProgressEvent>,
    id: i64,
) {
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
    });

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

    // Auto-select the platform cookie for this URL (falls back to global).
    let cookie = crate::cookies::resolve(cookies, cfg.cookies.as_deref(), &item.webpage_url);
    let result = crate::ytdlp::download(cfg, &item, cookie.as_deref(), ptx).await;
    forwarder.abort();

    match result {
        Ok(out) => {
            if let Err(e) = db.set_completed(id, &out.filepath, out.filesize).await {
                tracing::error!("job {id}: set_completed failed: {e}");
            }
            if let Err(e) = archive.insert(&item.archive_key).await {
                tracing::error!("job {id}: archive insert failed: {e}");
            }
            let _ = events.send(ProgressEvent {
                id,
                status: Status::Completed,
                percent: Some(100.0),
                speed: None,
                eta: None,
            });
        }
        Err(e) => {
            let msg = e.to_string();
            tracing::warn!("job {id}: download failed: {msg}");
            if let Err(e) = db.set_status(id, Status::Failed, Some(&msg)).await {
                tracing::error!("job {id}: set_status(failed) failed: {e}");
            }
            let _ = events.send(ProgressEvent {
                id,
                status: Status::Failed,
                percent: None,
                speed: None,
                eta: None,
            });
        }
    }
}
