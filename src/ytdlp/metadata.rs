//! yt-dlp metadata probe. Workstream D owns this file. See docs/DOWNLOAD_PIPELINE.md §1.

use super::YtdlpError;
use crate::config::Config;
use crate::types::ProbeResult;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Semaphore;

/// How many trailing bytes of stderr to surface on failure.
const STDERR_TAIL: usize = 500;
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
static PROBE_SLOTS: OnceLock<Semaphore> = OnceLock::new();

async fn run_probe(cfg: &Config, args: &[String]) -> Result<std::process::Output, YtdlpError> {
    let slots = PROBE_SLOTS.get_or_init(|| Semaphore::new(2));
    let _permit = slots
        .acquire()
        .await
        .map_err(|_| YtdlpError::Spawn("probe limiter closed".into()))?;
    let mut command = tokio::process::Command::new(&cfg.ytdlp_path);
    command.args(args).kill_on_drop(true);
    tokio::time::timeout(PROBE_TIMEOUT, command.output())
        .await
        .map_err(|_| YtdlpError::Timeout)?
        .map_err(|e| YtdlpError::Spawn(format!("failed to run {}: {e}", cfg.ytdlp_path)))
}

/// Probe a URL; returns one ProbeResult per video (playlists → many).
/// `cookies` is the resolved cookie file for this URL (see `crate::cookies`).
pub async fn probe(
    cfg: &Config,
    url: &str,
    cookies: Option<&Path>,
) -> Result<Vec<ProbeResult>, YtdlpError> {
    let args = crate::ytdlp::options::probe_args(cfg, url, cookies);

    let output = run_probe(cfg, &args).await?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    if !output.status.success() || stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(YtdlpError::Probe(stderr_tail(&stderr)));
    }

    let results: Vec<ProbeResult> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(parse_dump_json_line)
        .collect();

    if results.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(YtdlpError::Probe(stderr_tail(&stderr)));
    }

    Ok(results)
}

/// Probe the distinct video pixel heights the source offers, highest first
/// (e.g. `[2160, 1440, 1080, 720, 480, 360]`), so the resolution picker can list
/// exactly what actually exists — no arbitrary standard-bucket guessing (which
/// double-listed a portrait video's true height alongside a same-label bucket).
/// Empty when no format reported a height (audio-only / unknown).
pub async fn probe_heights(
    cfg: &Config,
    url: &str,
    cookies: Option<&Path>,
) -> Result<Vec<i64>, YtdlpError> {
    let args = crate::ytdlp::options::probe_args(cfg, url, cookies);
    let output = run_probe(cfg, &args).await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(YtdlpError::Probe(stderr_tail(&stderr)));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut set: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    for line in stdout.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        for h in heights_from_json(&v) {
            set.insert(h);
        }
    }
    Ok(set.into_iter().rev().collect())
}

/// Distinct **real video** heights (>0) from a `--dump-json` object: the height
/// of every format that carries an actual video codec, plus the top-level
/// `height`, highest first. Shared by the probe parser (stored at submit) and
/// `probe_heights` (background/lazy refresh).
///
/// Formats whose `vcodec` is explicitly `"none"` are skipped — that excludes
/// audio-only streams and YouTube's storyboard/preview images (which otherwise
/// leak junk tiers like 27p/45p/90p into the picker). A format that omits
/// `vcodec` entirely (some extractors don't report it) is kept, since its height
/// is the only signal we have.
pub(crate) fn heights_from_json(v: &serde_json::Value) -> Vec<i64> {
    let mut set: std::collections::BTreeSet<i64> = std::collections::BTreeSet::new();
    if let Some(formats) = v.get("formats").and_then(|f| f.as_array()) {
        for f in formats {
            // Skip anything that isn't a real video stream: audio-only / storyboard
            // formats carry `vcodec: "none"`, and storyboard previews are `mhtml`
            // image sheets (some extractors label them only by ext) — both would
            // otherwise leak junk tiers like 27p/45p/90p into the picker.
            let vcodec_none = matches!(
                f.get("vcodec").and_then(|c| c.as_str()),
                Some("none") | Some("")
            );
            let image_ext = matches!(
                f.get("ext").and_then(|e| e.as_str()),
                Some("mhtml") | Some("jpg") | Some("png") | Some("webp")
            );
            if vcodec_none || image_ext {
                continue;
            }
            if let Some(h) = f.get("height").and_then(|h| h.as_i64()).filter(|h| *h > 0) {
                set.insert(h);
            }
        }
    }
    if let Some(h) = v.get("height").and_then(|h| h.as_i64()).filter(|h| *h > 0) {
        set.insert(h);
    }
    set.into_iter().rev().collect()
}

/// Last ~`STDERR_TAIL` chars of stderr, trimmed. Char-boundary safe.
fn stderr_tail(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.len() <= STDERR_TAIL {
        return trimmed.to_string();
    }
    // Find a char boundary at or after the target start so we don't split a char.
    let mut start = trimmed.len() - STDERR_TAIL;
    while start < trimmed.len() && !trimmed.is_char_boundary(start) {
        start += 1;
    }
    trimmed[start..].to_string()
}

/// Parse one `--dump-json` line into a `ProbeResult`. Isolated for unit testing
/// without invoking yt-dlp. Returns `None` if the line is not a usable JSON object.
pub(crate) fn parse_dump_json_line(line: &str) -> Option<ProbeResult> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;

    let extractor = v.get("extractor")?.as_str()?.to_string();
    let video_id = v.get("id")?.as_str()?.to_string();
    let title = v.get("title")?.as_str()?.to_string();
    let webpage_url = v.get("webpage_url")?.as_str()?.to_string();

    // uploader, else channel.
    let uploader = v
        .get("uploader")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("channel").and_then(|x| x.as_str()))
        .map(|s| s.to_string());

    let thumbnail_url = v
        .get("thumbnail")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let duration = v
        .get("duration")
        .and_then(|x| x.as_f64())
        .map(|d| d.round() as i64);

    // 1-based position within a playlist/multi-video post, when present. Whether
    // it's actually needed for download disambiguation is decided in `submit`
    // (only when siblings share a webpage_url).
    let playlist_index = v.get("playlist_index").and_then(|x| x.as_i64());

    // Distinct source heights, captured now so the resolution picker reads them
    // from the DB instead of re-probing on first open.
    let available_heights = heights_from_json(&v);

    Some(ProbeResult {
        extractor,
        video_id,
        title,
        uploader,
        thumbnail_url,
        duration,
        webpage_url,
        playlist_index,
        available_heights,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_video_line() {
        let line = r#"{"extractor":"youtube","id":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","uploader":"Rick Astley","channel":"RickAstleyVEVO","thumbnail":"https://i.ytimg.com/vi/dQw4w9WgXcQ/maxres.jpg","duration":213.0,"webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}"#;

        let r = parse_dump_json_line(line).expect("should parse");
        assert_eq!(r.extractor, "youtube");
        assert_eq!(r.video_id, "dQw4w9WgXcQ");
        assert_eq!(r.title, "Never Gonna Give You Up");
        assert_eq!(r.uploader.as_deref(), Some("Rick Astley"));
        assert_eq!(
            r.thumbnail_url.as_deref(),
            Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/maxres.jpg")
        );
        assert_eq!(r.duration, Some(213));
        assert_eq!(r.webpage_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert_eq!(r.archive_key(), "youtube dQw4w9WgXcQ");
    }

    #[test]
    fn uploader_falls_back_to_channel() {
        let line = r#"{"extractor":"youtube","id":"abc123","title":"Clip","uploader":null,"channel":"Some Channel","webpage_url":"https://example.com/watch?v=abc123"}"#;

        let r = parse_dump_json_line(line).expect("should parse");
        assert_eq!(r.uploader.as_deref(), Some("Some Channel"));
    }

    #[test]
    fn uploader_missing_key_falls_back_to_channel() {
        let line = r#"{"extractor":"youtube","id":"abc123","title":"Clip","channel":"Only Channel","webpage_url":"https://example.com/watch?v=abc123"}"#;

        let r = parse_dump_json_line(line).expect("should parse");
        assert_eq!(r.uploader.as_deref(), Some("Only Channel"));
    }

    #[test]
    fn duration_rounds_to_nearest_second() {
        let line =
            r#"{"extractor":"youtube","id":"x","title":"t","webpage_url":"u","duration":212.6}"#;
        let r = parse_dump_json_line(line).expect("should parse");
        assert_eq!(r.duration, Some(213));

        let line2 =
            r#"{"extractor":"youtube","id":"x","title":"t","webpage_url":"u","duration":212.4}"#;
        let r2 = parse_dump_json_line(line2).expect("should parse");
        assert_eq!(r2.duration, Some(212));
    }

    #[test]
    fn parses_playlist_index_for_multi_video_entry() {
        // A tweet with two clips: each entry carries its 1-based playlist_index.
        let line = r#"{"extractor":"twitter","id":"111","title":"clip #2","webpage_url":"https://x.com/u/status/9","playlist_index":2,"n_entries":2}"#;
        let r = parse_dump_json_line(line).expect("should parse");
        assert_eq!(r.playlist_index, Some(2));

        // Standalone video: no playlist_index field.
        let solo = r#"{"extractor":"youtube","id":"y","title":"t","webpage_url":"u"}"#;
        assert_eq!(parse_dump_json_line(solo).unwrap().playlist_index, None);
    }

    #[test]
    fn missing_duration_and_thumbnail_are_none() {
        let line = r#"{"extractor":"generic","id":"y","title":"t","webpage_url":"u"}"#;
        let r = parse_dump_json_line(line).expect("should parse");
        assert_eq!(r.duration, None);
        assert_eq!(r.thumbnail_url, None);
        assert_eq!(r.uploader, None);
    }

    #[test]
    fn invalid_line_returns_none() {
        assert!(parse_dump_json_line("not json").is_none());
        // Missing required field `id`.
        assert!(
            parse_dump_json_line(r#"{"extractor":"youtube","title":"t","webpage_url":"u"}"#)
                .is_none()
        );
    }

    #[test]
    fn heights_from_json_collects_distinct_desc() {
        // Real video formats (vcodec present, or omitted) count; storyboard images
        // and audio (vcodec "none") are skipped so junk tiers don't leak in.
        let v: serde_json::Value = serde_json::from_str(
            r#"{"height":720,"formats":[
                {"height":1080,"vcodec":"vp9"},{"height":720,"vcodec":"avc1"},
                {"height":720,"vcodec":"avc1"},{"height":null,"vcodec":"vp9"},
                {"height":360},
                {"height":90,"vcodec":"none"},{"height":45,"vcodec":"none"},
                {"height":180,"ext":"mhtml"},
                {"height":0,"acodec":"opus","vcodec":"none"}]}"#,
        )
        .unwrap();
        assert_eq!(heights_from_json(&v), vec![1080, 720, 360]);
        // Only storyboard/audio (vcodec none) → empty.
        let audio: serde_json::Value = serde_json::from_str(
            r#"{"formats":[{"height":45,"vcodec":"none"},{"acodec":"opus","vcodec":"none"}]}"#,
        )
        .unwrap();
        assert!(heights_from_json(&audio).is_empty());
    }

    #[test]
    fn stderr_tail_truncates_to_last_chars() {
        let long = "x".repeat(1000);
        let tail = stderr_tail(&long);
        assert_eq!(tail.len(), STDERR_TAIL);
    }
}
