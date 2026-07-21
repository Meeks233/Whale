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
        max_height: Option<i64>,
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

        let value = resolve_stream_url(cfg, url, cookies, playlist_index, max_height).await?;
        *cached = Some(CachedStreamUrl {
            value: value.clone(),
            expires_at: Instant::now() + Duration::from_secs(120),
        });
        Ok(value)
    }
}

/// One subtitle track available at the source for an online (cloud-only) item.
/// `url` is a direct, time-limited CDN URL; `ext` is the on-CDN format we know how
/// to turn into WebVTT (`vtt` needs none, `srt` a light rewrite).
#[derive(Debug, Clone)]
pub struct RemoteSub {
    pub lang: String,
    pub url: String,
    pub ext: String,
}

#[derive(Debug, Clone)]
struct CachedSubs {
    value: Arc<Vec<RemoteSub>>,
    expires_at: Instant,
}

type SubSlot = Arc<Mutex<Option<CachedSubs>>>;

/// Short-lived cache of the subtitle tracks a `--dump-json` probe found at the
/// source. Mirrors `StreamUrlCache`: a per-item mutex collapses the list request
/// and the follow-up track fetch into one yt-dlp process, and the URLs expire
/// quickly because CDN subtitle links are signed and IP-bound just like the media.
#[derive(Clone, Default)]
pub struct SubtitleCache {
    slots: Arc<Mutex<HashMap<String, SubSlot>>>,
}

impl SubtitleCache {
    pub async fn resolve(
        &self,
        key: &str,
        cfg: &Config,
        url: &str,
        cookies: Option<&Path>,
        playlist_index: Option<i64>,
    ) -> Result<Arc<Vec<RemoteSub>>, YtdlpError> {
        let slot = {
            let mut slots = self.slots.lock().await;
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
        let value = Arc::new(resolve_subtitles(cfg, url, cookies, playlist_index).await?);
        *cached = Some(CachedSubs {
            value: value.clone(),
            expires_at: Instant::now() + Duration::from_secs(120),
        });
        Ok(value)
    }
}

/// Probe the source for its subtitle tracks without downloading (`yt-dlp
/// --dump-single-json --skip-download`). Manual subtitles win over automatic
/// captions for the same language; within a language we take the first track
/// whose format we can serve (`vtt`, else `srt`). Languages with only formats we
/// can't convert (`ttml`, `srv3`, …) are dropped rather than offered and then
/// failing to load.
pub async fn resolve_subtitles(
    cfg: &Config,
    url: &str,
    cookies: Option<&Path>,
    playlist_index: Option<i64>,
) -> Result<Vec<RemoteSub>, YtdlpError> {
    let mut cmd = tokio::process::Command::new(&cfg.ytdlp_path);
    cmd.arg("--ignore-config")
        .arg("--no-warnings")
        .arg("--skip-download")
        .arg("--dump-single-json");
    if playlist_index.is_none() {
        cmd.arg("--no-playlist");
    }
    if let Some(idx) = playlist_index {
        cmd.arg("--playlist-items").arg(idx.to_string());
    }
    if let Some(imp) = &cfg.impersonate {
        cmd.arg("--impersonate").arg(imp);
    }
    if let Some(c) = cookies {
        cmd.arg("--cookies").arg(c);
    }
    cmd.arg("--").arg(url);
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(25), cmd.output())
        .await
        .map_err(|_| YtdlpError::Timeout)?
        .map_err(|e| YtdlpError::Spawn(format!("failed to run {}: {e}", cfg.ytdlp_path)))?;
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        return Err(YtdlpError::Download(tail.trim().to_string()));
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| YtdlpError::Download(format!("dump-json parse failed: {e}")))?;
    Ok(parse_subtitles(&json))
}

/// Pick one servable track per language from a dump-json result, preferring manual
/// `subtitles` over `automatic_captions`. Split out for unit testing against fixed
/// JSON without spawning yt-dlp.
fn parse_subtitles(json: &serde_json::Value) -> Vec<RemoteSub> {
    // Servable formats, in order of preference (vtt needs no conversion).
    const SERVABLE: &[&str] = &["vtt", "srt"];
    let pick_from = |map: &serde_json::Value, out: &mut Vec<RemoteSub>, seen: &mut Vec<String>| {
        let Some(obj) = map.as_object() else { return };
        for (lang, tracks) in obj {
            if seen.iter().any(|l| l == lang) {
                continue;
            }
            let Some(arr) = tracks.as_array() else { continue };
            // Take the most-preferred servable format present for this language.
            let mut chosen: Option<RemoteSub> = None;
            let mut chosen_rank = usize::MAX;
            for tr in arr {
                let ext = tr.get("ext").and_then(|e| e.as_str()).unwrap_or("");
                let url = tr.get("url").and_then(|u| u.as_str()).unwrap_or("");
                if url.is_empty() {
                    continue;
                }
                if let Some(rank) = SERVABLE.iter().position(|s| s.eq_ignore_ascii_case(ext)) {
                    if rank < chosen_rank {
                        chosen_rank = rank;
                        chosen = Some(RemoteSub {
                            lang: lang.clone(),
                            url: url.to_string(),
                            ext: ext.to_ascii_lowercase(),
                        });
                    }
                }
            }
            if let Some(sub) = chosen {
                seen.push(lang.clone());
                out.push(sub);
            }
        }
    };
    let mut out = Vec::new();
    let mut seen = Vec::new();
    pick_from(&json["subtitles"], &mut out, &mut seen);
    pick_from(&json["automatic_captions"], &mut out, &mut seen);
    out.sort_by(|a, b| a.lang.cmp(&b.lang));
    out
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
    max_height: Option<i64>,
) -> Result<String, YtdlpError> {
    let mut cmd = tokio::process::Command::new(&cfg.ytdlp_path);
    // A resolution cap is a *preference* (`<=?`), so a source that doesn't report
    // heights still resolves rather than 404-ing the player; without a cap we keep
    // the original "best single HTTP stream".
    let fmt = match max_height {
        Some(h) if h > 0 => {
            format!("b[height<=?{h}][protocol^=http]/b[height<=?{h}]/b[protocol^=http]/b")
        }
        _ => "b[protocol^=http]/b".to_string(),
    };
    cmd.arg("--ignore-config")
        .arg("--no-warnings")
        .arg("-f")
        .arg(&fmt)
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

#[cfg(test)]
mod subtitle_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prefers_vtt_and_manual_over_auto_and_skips_unservable() {
        let j = json!({
            "subtitles": {
                "en": [
                    { "ext": "ttml", "url": "https://cdn/en.ttml" },
                    { "ext": "vtt",  "url": "https://cdn/en.vtt" },
                    { "ext": "srt",  "url": "https://cdn/en.srt" }
                ],
                "fr": [ { "ext": "srt", "url": "https://cdn/fr.srt" } ],
                "de": [ { "ext": "srv3", "url": "https://cdn/de.srv3" } ]
            },
            "automatic_captions": {
                "en": [ { "ext": "vtt", "url": "https://cdn/en.auto.vtt" } ],
                "es": [ { "ext": "vtt", "url": "https://cdn/es.auto.vtt" } ]
            }
        });
        let subs = parse_subtitles(&j);
        let by: std::collections::HashMap<_, _> =
            subs.iter().map(|s| (s.lang.as_str(), s)).collect();
        // en: manual vtt wins over its srt and over the auto-caption.
        assert_eq!(by["en"].ext, "vtt");
        assert_eq!(by["en"].url, "https://cdn/en.vtt");
        // fr: only srt available, still offered.
        assert_eq!(by["fr"].ext, "srt");
        // de: only an unservable format → dropped.
        assert!(!by.contains_key("de"));
        // es: present only as an automatic caption → included.
        assert_eq!(by["es"].url, "https://cdn/es.auto.vtt");
        // Sorted by lang.
        let langs: Vec<_> = subs.iter().map(|s| s.lang.as_str()).collect();
        assert_eq!(langs, vec!["en", "es", "fr"]);
    }

    #[test]
    fn missing_maps_yield_no_tracks() {
        assert!(parse_subtitles(&json!({})).is_empty());
        assert!(parse_subtitles(&json!({ "subtitles": {} })).is_empty());
    }

    #[test]
    fn tracks_without_a_url_are_ignored() {
        let j = json!({ "subtitles": { "en": [ { "ext": "vtt" } ] } });
        assert!(parse_subtitles(&j).is_empty());
    }
}
