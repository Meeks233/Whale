//! yt-dlp download with progress parsing. Workstream E owns this file.
//! See docs/DOWNLOAD_PIPELINE.md §2–§3.

use super::YtdlpError;
use crate::config::Config;
use crate::types::{Item, ProgressEvent, Status};
use crate::ytdlp::options::download_args;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

const PREFIX: &str = "__ORCA__";

#[derive(Debug)]
pub struct DownloadOutcome {
    pub filepath: String,
    pub filesize: i64,
    /// Final video pixel height parsed from the `.last_res_<id>` sidecar, or
    /// `None` for audio-only downloads / when yt-dlp reported no height.
    pub height: Option<i64>,
}

/// Run a download for `item`. Progress ticks are sent on `progress` as they are
/// parsed from yt-dlp's stdout; the final outcome resolves when the process exits.
///
/// `cancel` lets the caller abort mid-download: firing it (or dropping its
/// `Sender`) kills the yt-dlp child and returns [`YtdlpError::Cancelled`]. The
/// queue wires this to item deletion so a deleted download stops fetching
/// instead of running on headlessly.
pub async fn download(
    cfg: &Config,
    item: &Item,
    cookies: Option<&Path>,
    progress: mpsc::Sender<ProgressEvent>,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
    variant: Option<i64>,
) -> Result<DownloadOutcome, YtdlpError> {
    // yt-dlp `--print-to-file` *appends*; clear any stale sidecar from a prior
    // run (e.g. a retry of this item) so we read only this run's final path. The
    // tag keys the sidecar per (item, resolution) so variant downloads of one
    // item don't clobber each other.
    let tag = crate::ytdlp::options::job_tag(item.id, variant);
    let sidecar = cfg.data_dir.join(format!(".last_path_{tag}"));
    let _ = std::fs::remove_file(&sidecar);
    let res_sidecar = cfg.data_dir.join(format!(".last_res_{tag}"));
    let _ = std::fs::remove_file(&res_sidecar);

    let mut child = tokio::process::Command::new(&cfg.ytdlp_path)
        .args(download_args(cfg, item, cookies, variant))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| YtdlpError::Spawn(format!("failed to run {}: {e}", cfg.ytdlp_path)))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| YtdlpError::Spawn("failed to capture stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| YtdlpError::Spawn("failed to capture stderr".to_string()))?;

    // Drain stderr concurrently, collecting lines for the error tail.
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut collected: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            collected.push(line);
        }
        collected
    });

    // Kill the child, reap it, and abort stderr draining — the shared teardown
    // for a cancelled download.
    async fn abort_child(child: &mut tokio::process::Child) {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    // Parse stdout line-by-line, forwarding progress events. Cancellation can
    // arrive at any point during the download, so race each read against it.
    // `stdout_lines` owns the taken pipe (independent of `child`), so the
    // cancel arm can touch `child` without a borrow conflict.
    let mut stdout_lines = BufReader::new(stdout).lines();
    loop {
        tokio::select! {
            biased;
            _ = &mut cancel => {
                abort_child(&mut child).await;
                stderr_task.abort();
                return Err(YtdlpError::Cancelled);
            }
            line = stdout_lines.next_line() => match line {
                Ok(Some(line)) => {
                    if let Some(ev) = parse_progress_line(item.id, &line) {
                        // Ignore send errors: receiver may have gone away.
                        let _ = progress.send(ev).await;
                    }
                }
                _ => break, // stdout closed → process is finishing
            },
        }
    }

    // Stdout is drained; wait for exit, still cancellable. Return an Option so the
    // `child`-touching teardown runs after the select's futures are dropped.
    let waited = tokio::select! {
        biased;
        _ = &mut cancel => None,
        s = child.wait() => Some(s.map_err(|e| YtdlpError::Spawn(format!("failed to wait on yt-dlp: {e}")))?),
    };
    let status = match waited {
        None => {
            abort_child(&mut child).await;
            stderr_task.abort();
            return Err(YtdlpError::Cancelled);
        }
        Some(s) => s,
    };
    let stderr_lines = stderr_task.await.unwrap_or_default();

    if status.success() {
        // Read the last non-empty line — the final file path yt-dlp moved into
        // place (a single entry per run, since multi-video posts are pinned to one
        // `--playlist-items` index). yt-dlp exits 0 but writes NO sidecar when it
        // skips the download because the key is already in the `--download-archive`
        // (a re-submit of something already downloaded). Surface that as
        // `AlreadyDownloaded` so the caller keeps the existing file instead of
        // marking the item failed with a cryptic "could not read sidecar" error.
        let filepath = match std::fs::read_to_string(&sidecar) {
            Ok(raw) => raw
                .lines()
                .rev()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(str::to_string),
            Err(_) => None,
        };
        let Some(filepath) = filepath else {
            return Err(YtdlpError::AlreadyDownloaded);
        };
        let filesize = std::fs::metadata(&filepath)
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        // Best-effort resolution: read the last non-empty line of the height
        // sidecar and parse it. Missing / "NA" (audio-only) → None.
        let height = std::fs::read_to_string(&res_sidecar)
            .ok()
            .and_then(|raw| {
                raw.lines()
                    .rev()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .and_then(|l| l.parse::<i64>().ok())
            })
            .filter(|h| *h > 0);
        Ok(DownloadOutcome {
            filepath,
            filesize,
            height,
        })
    } else {
        Err(YtdlpError::Download(error_tail(&stderr_lines)))
    }
}

/// Take the tail of collected stderr lines as the error message.
fn error_tail(lines: &[String]) -> String {
    const MAX: usize = 15;
    let start = lines.len().saturating_sub(MAX);
    lines[start..].join("\n")
}

/// Parse one stdout line into a `ProgressEvent`, or `None` if it is not a
/// `__ORCA__` progress line.
pub(crate) fn parse_progress_line(id: i64, line: &str) -> Option<ProgressEvent> {
    let rest = line.strip_prefix(PREFIX)?;
    let mut parts = rest.split('|');
    let pct = parts.next().unwrap_or("");
    let speed = parts.next().unwrap_or("");
    let eta = parts.next().unwrap_or("");
    let vcodec = parts.next().unwrap_or("");
    let acodec = parts.next().unwrap_or("");
    Some(ProgressEvent {
        id,
        status: Status::Running,
        percent: parse_percent(pct),
        speed: clean(speed),
        eta: clean(eta),
        phase: phase_of(vcodec, acodec),
    })
}

/// Classify the current sub-download from the format's codecs. A `bv*+ba`
/// download runs two passes (0→100% each): the video-only stream (`vcodec` real,
/// `acodec` "none") then the audio-only stream (`acodec` real, `vcodec` "none").
/// A single progressive file carries both codecs → `None` (one continuous bar).
pub(crate) fn phase_of(vcodec: &str, acodec: &str) -> Option<String> {
    let has = |c: &str| !matches!(c.trim(), "" | "none" | "N/A" | "NA");
    match (has(vcodec), has(acodec)) {
        (true, false) => Some("video".to_string()),
        (false, true) => Some("audio".to_string()),
        _ => None,
    }
}

/// Parse yt-dlp's `_percent_str` (e.g. `" 63.4%"`) into an f32.
pub(crate) fn parse_percent(s: &str) -> Option<f32> {
    s.trim().trim_end_matches('%').trim().parse::<f32>().ok()
}

/// Trim a yt-dlp string field, mapping `N/A`/`Unknown`/empty to `None`.
pub(crate) fn clean(s: &str) -> Option<String> {
    let t = s.trim();
    match t {
        "" | "N/A" | "Unknown" => None,
        _ => Some(t.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_progress_line() {
        let ev = parse_progress_line(7, "__ORCA__ 63.4%|4.02MiB/s|00:19|vp9|none").unwrap();
        assert_eq!(ev.id, 7);
        assert_eq!(ev.status, Status::Running);
        assert!((ev.percent.unwrap() - 63.4).abs() < 0.01);
        assert_eq!(ev.speed.as_deref(), Some("4.02MiB/s"));
        assert_eq!(ev.eta.as_deref(), Some("00:19"));
        assert_eq!(ev.phase.as_deref(), Some("video"));
    }

    #[test]
    fn maps_na_and_unknown_to_none() {
        let ev = parse_progress_line(1, "__ORCA__100.0%|N/A|Unknown|none|opus").unwrap();
        assert!((ev.percent.unwrap() - 100.0).abs() < 0.01);
        assert_eq!(ev.speed, None);
        assert_eq!(ev.eta, None);
        assert_eq!(ev.phase.as_deref(), Some("audio"));
    }

    #[test]
    fn progressive_file_has_no_phase() {
        // Single file carrying both codecs → no phase label (one continuous bar).
        let ev = parse_progress_line(3, "__ORCA__ 10.0%|1MiB/s|00:05|avc1|mp4a").unwrap();
        assert_eq!(ev.phase, None);
    }

    #[test]
    fn non_orca_line_is_none() {
        assert!(parse_progress_line(1, "[download] 63.4% of 10MiB").is_none());
    }

    #[test]
    fn parse_percent_strips_space_and_sign() {
        assert!((parse_percent(" 63.4%").unwrap() - 63.4).abs() < 0.01);
    }

    #[test]
    fn parse_percent_rejects_garbage() {
        assert_eq!(parse_percent("N/A"), None);
    }

    // ---- Cancellation guarantee -------------------------------------------
    // Proves a delete stops the backend job WITHOUT needing a real download:
    // point `ytdlp_path` at a shell script that ignores its args and sleeps
    // ("forever"), start download(), fire the cancel, and assert it returns
    // `Cancelled` promptly (the child was killed). Run with `cargo test`.
    use crate::config::{Config, Container};
    use crate::types::{Item, Source, Status};
    use std::net::SocketAddr;
    use std::path::PathBuf;

    fn cancel_test_config(dir: &std::path::Path, ytdlp: &std::path::Path) -> Config {
        Config {
            token: "secret".into(),
            token_generated: false,
            public_url: None,
            client_tofu: true,
            bind: "0.0.0.0:8080".parse::<SocketAddr>().unwrap(),
            data_dir: dir.to_path_buf(),
            download_dir: dir.to_path_buf(),
            concurrency: 1,
            polite: false,
            sleep_min: 0,
            sleep_max: 0,
            sleep_requests: None,
            impersonate: None,
            concurrent_fragments: 1,
            limit_rate: None,
            container: Container::Mkv,
            container_user_set: false,
            output_template: "%(id)s.%(ext)s".into(),
            format: "b".into(),
            format_user_set: false,
            max_height: None,
            max_storage: None,
            subs: false,
            subs_user_set: false,
            auto_subs: false,
            sub_langs: "en".into(),
            embed_thumbnail: false,
            cookies: None,
            ytdlp_path: ytdlp.display().to_string(),
            allow_private_dns: false,
        }
    }

    fn cancel_test_item() -> Item {
        Item {
            id: 999,
            slug: "0123456789abcdef0123456789abcdef".into(),
            extractor: "youtube".into(),
            video_id: "x".into(),
            archive_key: "youtube x".into(),
            title: "t".into(),
            uploader: None,
            webpage_url: "https://example.com/watch?v=x".into(),
            thumbnail_url: None,
            duration: None,
            filepath: None,
            filesize: None,
            height: None,
            target_height: None,
            source_max_height: None,
            source: Source::Download,
            status: Status::Queued,
            error: None,
            created_at: 0,
            completed_at: None,
            public: false,
            public_slug: None,
            public_until: None,
            public_hits: 0,
            filename: None,
            local_available: false,
            total_filesize: 0,
            playlist_index: None,
        }
    }

    #[tokio::test]
    async fn cancel_kills_a_running_download() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("orca_cancel_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script: PathBuf = dir.join("fake-ytdlp.sh");
        // Ignores every yt-dlp arg it's handed and just blocks, standing in for a
        // long-running download.
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let cfg = cancel_test_config(&dir, &script);
        let item = cancel_test_item();
        let (ptx, _prx) = mpsc::channel::<ProgressEvent>(8);
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();

        let task =
            tokio::spawn(async move { download(&cfg, &item, None, ptx, cancel_rx, None).await });

        // Let the child spawn, then cancel it.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        cancel_tx.send(()).unwrap();

        // Must return quickly (well under the script's 30s sleep).
        let res = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("download() did not return within 5s of cancel")
            .expect("download task panicked");
        assert!(
            matches!(res, Err(YtdlpError::Cancelled)),
            "expected Cancelled, got {res:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
