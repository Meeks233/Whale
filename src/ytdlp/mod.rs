//! yt-dlp subprocess integration: options, metadata probe, download.

pub mod download;
pub mod metadata;
pub mod options;

use crate::config::Config;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub use download::download;
pub use metadata::{probe, probe_heights};

#[derive(Debug, thiserror::Error)]
pub enum YtdlpError {
    #[error("probe failed: {0}")]
    Probe(String),
    #[error("download failed: {0}")]
    Download(String),
    #[error("yt-dlp not available: {0}")]
    Spawn(String),
    /// The download was cancelled (item deleted / re-queued) — the yt-dlp child
    /// was killed. Not a real failure: the caller should exit quietly.
    #[error("download cancelled")]
    Cancelled,
    /// yt-dlp exited successfully but produced no file — it skipped the download
    /// because the video's key is already in the `--download-archive` (a re-submit
    /// of something already downloaded). The existing local file, if any, is still
    /// valid; the caller decides whether to keep it or report a stale record.
    #[error("already downloaded (skipped by archive)")]
    AlreadyDownloaded,
    /// yt-dlp did not finish within the allotted time and was killed. Cookie-gated
    /// sources (X/Twitter) can wedge a `-g` resolve on an auth/GraphQL retry loop;
    /// without this bound the Axum handler — and the client's player — would hang
    /// forever. The caller surfaces this as a normal (recoverable) stream failure.
    #[error("timed out")]
    Timeout,
}

#[derive(Debug, Clone)]
struct CachedStreamUrl {
    value: String,
    expires_at: Instant,
}

type StreamUrlSlot = Arc<Mutex<Option<CachedStreamUrl>>>;

/// Short-lived direct-media URL cache. A per-item mutex collapses concurrent
/// video Range requests into one `yt-dlp -g` process while unrelated items still
/// resolve in parallel. URLs remain cached only briefly because CDN signatures
/// are time-limited and tied to this server's IP.
#[derive(Clone, Default)]
pub struct StreamUrlCache {
    slots: Arc<Mutex<HashMap<String, StreamUrlSlot>>>,
}

impl StreamUrlCache {
    pub async fn resolve(
        &self,
        key: &str,
        cfg: &Config,
        url: &str,
        cookies: Option<&Path>,
        playlist_index: Option<i64>,
    ) -> Result<String, YtdlpError> {
        let slot = {
            let mut slots = self.slots.lock().await;
            // Bound stale keys from a long-running server. Existing Arc handles
            // stay valid if a cleanup races an in-flight resolution.
            if slots.len() >= 128 && !slots.contains_key(key) {
                slots.clear();
            }
            slots
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };

        let mut cached = slot.lock().await;
        if let Some(hit) = cached.as_ref().filter(|v| v.expires_at > Instant::now()) {
            return Ok(hit.value.clone());
        }

        let value = resolve_stream_url(cfg, url, cookies, playlist_index).await?;
        *cached = Some(CachedStreamUrl {
            value: value.clone(),
            expires_at: Instant::now() + Duration::from_secs(120),
        });
        Ok(value)
    }
}

/// Turn a raw yt-dlp error into a message the user can act on.
///
/// Sites like X/Twitter serve video only to logged-in requests: a guest probe
/// gets the tweet but no media, so yt-dlp reports the cryptic "No video could be
/// found in this tweet". Left as-is that reads like a bug in Orca. When the
/// error matches a known "needs login" shape we append a short hint naming the
/// platform and pointing at the per-platform cookie setting — the actual fix.
/// Non-auth errors are returned unchanged.
pub fn explain_error(url: &str, raw: &str) -> String {
    if !looks_like_auth_required(raw) {
        return raw.to_string();
    }
    let site = crate::platform::from_url(url)
        .map(|p| p.name)
        .unwrap_or("this site");
    format!(
        "{raw} — {site} likely requires login for this content. Add your {site} account cookies in Settings → Cookies, then retry."
    )
}

/// Heuristic: does this yt-dlp error indicate the content is gated behind a
/// login / age check rather than being a transient or genuinely-missing-media
/// failure? Matched case-insensitively against the error tail.
fn looks_like_auth_required(raw: &str) -> bool {
    let low = raw.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        // X/Twitter: a guest token can't see gated video.
        "no video could be found in this tweet",
        "nsfw",
        "age-restricted",
        "sign in to confirm your age",
        "sign in",
        "log in",
        "login required",
        "requires authentication",
        "requested content is not available",
        "this tweet is unavailable",
        "account is temporarily locked",
        "private video",
        "private account",
        // yt-dlp's own remediation advice, across extractors.
        "use --cookies",
        "--cookies-from-browser",
    ];
    NEEDLES.iter().any(|n| low.contains(n))
}

/// Resolve a direct, playable upstream URL for online streaming without
/// downloading (`yt-dlp -g`). Used when the local file is gone (backed away) and
/// the client wants to play from source.
///
/// We request a **progressive HTTP** format (`b[protocol^=http]/b`) so the
/// result is a single muxed URL a `<video>` can play — adaptive selectors would
/// return separate video+audio URLs that a bare `<video>` can't combine. The
/// URL is short-lived and IP-bound to this server; callers should not cache it.
pub async fn resolve_stream_url(
    cfg: &Config,
    url: &str,
    cookies: Option<&Path>,
    playlist_index: Option<i64>,
) -> Result<String, YtdlpError> {
    let mut cmd = tokio::process::Command::new(&cfg.ytdlp_path);
    cmd.arg("--ignore-config")
        .arg("--no-warnings")
        .arg("-f")
        .arg("b[protocol^=http]/b")
        .arg("-g");
    if playlist_index.is_none() {
        cmd.arg("--no-playlist");
    }
    // Multi-video post: pick this item's own video from the shared URL.
    if let Some(idx) = playlist_index {
        cmd.arg("--playlist-items").arg(idx.to_string());
    }
    if let Some(imp) = &cfg.impersonate {
        cmd.arg("--impersonate").arg(imp);
    }
    if let Some(c) = cookies {
        cmd.arg("--cookies").arg(c);
    }
    // End-of-options: a URL starting with `-` must not be read as a flag.
    cmd.arg("--").arg(url);

    // Bound the resolve so a cookie-gated source that wedges yt-dlp on an
    // auth/retry loop can't hang the handler (and the player) forever. kill_on_drop
    // reaps the child when the timeout drops the output future.
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(25), cmd.output())
        .await
        .map_err(|_| YtdlpError::Timeout)?
        .map_err(|e| YtdlpError::Spawn(format!("failed to run {}: {e}", cfg.ytdlp_path)))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        return Err(YtdlpError::Download(tail.trim().to_string()));
    }
    // `-g` prints one URL per line; the first is the (muxed) media stream.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
        .ok_or_else(|| YtdlpError::Download("yt-dlp -g returned no url".into()))
}

/// Run `yt-dlp --version`; used at startup and exposed via /api/health.
pub async fn version(cfg: &Config) -> anyhow::Result<String> {
    let out = tokio::process::Command::new(&cfg.ytdlp_path)
        .arg("--version")
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("failed to run {}: {e}", cfg.ytdlp_path))?;
    if !out.status.success() {
        anyhow::bail!(
            "yt-dlp --version failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod explain_tests {
    use super::*;

    #[test]
    fn x_gated_video_gets_cookie_hint() {
        let raw = "ERROR: [twitter] 2076991813915656399: No video could be found in this tweet";
        let msg = explain_error("https://x.com/i/status/2076991813915656399", raw);
        assert!(msg.starts_with(raw));
        assert!(msg.contains("X / Twitter"));
        assert!(msg.contains("Cookies"));
    }

    #[test]
    fn ordinary_error_is_unchanged() {
        let raw = "ERROR: Unable to download webpage: HTTP Error 500";
        assert_eq!(explain_error("https://x.com/i/status/9", raw), raw);
    }

    #[test]
    fn unknown_host_falls_back_to_generic_site_label() {
        let raw = "ERROR: Sign in to confirm you're not a bot";
        let msg = explain_error("https://example.com/v/1", raw);
        assert!(msg.contains("this site"));
    }
}
