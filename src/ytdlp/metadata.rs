//! yt-dlp metadata probe. Workstream D owns this file. See docs/DOWNLOAD_PIPELINE.md §1.

use super::YtdlpError;
use crate::config::Config;
use crate::types::ProbeResult;
use std::path::Path;

/// How many trailing bytes of stderr to surface on failure.
const STDERR_TAIL: usize = 500;

/// Probe a URL; returns one ProbeResult per video (playlists → many).
/// `cookies` is the resolved cookie file for this URL (see `crate::cookies`).
pub async fn probe(
    cfg: &Config,
    url: &str,
    cookies: Option<&Path>,
) -> Result<Vec<ProbeResult>, YtdlpError> {
    let args = crate::ytdlp::options::probe_args(cfg, url, cookies);

    let output = tokio::process::Command::new(&cfg.ytdlp_path)
        .args(&args)
        .output()
        .await
        .map_err(|e| YtdlpError::Spawn(format!("failed to run {}: {e}", cfg.ytdlp_path)))?;

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

    Some(ProbeResult {
        extractor,
        video_id,
        title,
        uploader,
        thumbnail_url,
        duration,
        webpage_url,
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
        assert_eq!(
            r.webpage_url,
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
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
        let line = r#"{"extractor":"youtube","id":"x","title":"t","webpage_url":"u","duration":212.6}"#;
        let r = parse_dump_json_line(line).expect("should parse");
        assert_eq!(r.duration, Some(213));

        let line2 = r#"{"extractor":"youtube","id":"x","title":"t","webpage_url":"u","duration":212.4}"#;
        let r2 = parse_dump_json_line(line2).expect("should parse");
        assert_eq!(r2.duration, Some(212));
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
        assert!(parse_dump_json_line(r#"{"extractor":"youtube","title":"t","webpage_url":"u"}"#).is_none());
    }

    #[test]
    fn stderr_tail_truncates_to_last_chars() {
        let long = "x".repeat(1000);
        let tail = stderr_tail(&long);
        assert_eq!(tail.len(), STDERR_TAIL);
    }
}
