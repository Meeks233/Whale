//! yt-dlp download with progress parsing. Workstream E owns this file.
//! See docs/DOWNLOAD_PIPELINE.md §2–§3.

use super::YtdlpError;
use crate::config::Config;
use crate::types::{Item, ProgressEvent, Status};
use crate::ytdlp::options::download_args;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

const PREFIX: &str = "__WHALE__";

pub struct DownloadOutcome {
    pub filepath: String,
    pub filesize: i64,
}

/// Run a download for `item`. Progress ticks are sent on `progress` as they are
/// parsed from yt-dlp's stdout; the final outcome resolves when the process exits.
pub async fn download(
    cfg: &Config,
    item: &Item,
    progress: mpsc::Sender<ProgressEvent>,
) -> Result<DownloadOutcome, YtdlpError> {
    let mut child = tokio::process::Command::new(&cfg.ytdlp_path)
        .args(download_args(cfg, item))
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

    // Parse stdout line-by-line, forwarding progress events.
    let mut stdout_lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = stdout_lines.next_line().await {
        if let Some(ev) = parse_progress_line(item.id, &line) {
            // Ignore send errors: receiver may have gone away.
            let _ = progress.send(ev).await;
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| YtdlpError::Spawn(format!("failed to wait on yt-dlp: {e}")))?;
    let stderr_lines = stderr_task.await.unwrap_or_default();

    if status.success() {
        let sidecar = cfg.data_dir.join(format!(".last_path_{}", item.id));
        let filepath = std::fs::read_to_string(&sidecar)
            .map_err(|e| YtdlpError::Download(format!("could not read sidecar path: {e}")))?
            .trim()
            .to_string();
        let filesize = std::fs::metadata(&filepath)
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        Ok(DownloadOutcome { filepath, filesize })
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
/// `__WHALE__` progress line.
pub(crate) fn parse_progress_line(id: i64, line: &str) -> Option<ProgressEvent> {
    let rest = line.strip_prefix(PREFIX)?;
    let mut parts = rest.split('|');
    let pct = parts.next().unwrap_or("");
    let speed = parts.next().unwrap_or("");
    let eta = parts.next().unwrap_or("");
    Some(ProgressEvent {
        id,
        status: Status::Running,
        percent: parse_percent(pct),
        speed: clean(speed),
        eta: clean(eta),
    })
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
        let ev = parse_progress_line(7, "__WHALE__ 63.4%|4.02MiB/s|00:19").unwrap();
        assert_eq!(ev.id, 7);
        assert_eq!(ev.status, Status::Running);
        assert!((ev.percent.unwrap() - 63.4).abs() < 0.01);
        assert_eq!(ev.speed.as_deref(), Some("4.02MiB/s"));
        assert_eq!(ev.eta.as_deref(), Some("00:19"));
    }

    #[test]
    fn maps_na_and_unknown_to_none() {
        let ev = parse_progress_line(1, "__WHALE__100.0%|N/A|Unknown").unwrap();
        assert!((ev.percent.unwrap() - 100.0).abs() < 0.01);
        assert_eq!(ev.speed, None);
        assert_eq!(ev.eta, None);
    }

    #[test]
    fn non_whale_line_is_none() {
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
}
