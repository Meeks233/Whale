//! Subtitle sidecars — listing and serving the `.srt`/`.vtt` files yt-dlp writes
//! next to a downloaded video (`--write-subs`), so the in-app player can show
//! them as `<track>` elements.
//!
//! Design notes:
//! - **Nothing is written.** yt-dlp already both embeds subtitles into the media
//!   (`--embed-subs`, for offline playback) and keeps the standalone sidecar
//!   files (`--write-subs`). This module is read-only: it discovers those
//!   sidecars and serves them.
//! - **SRT is converted to WebVTT in-flight**, because `<track>` only accepts
//!   WebVTT. The conversion is a pure function over the response body — the file
//!   on disk stays in its original format.
//! - **No client-supplied path ever reaches the filesystem.** The requested lang
//!   tag is matched against the tags *discovered* by scanning the video's own
//!   directory, and the resulting path is re-checked through `safepath`.

use super::AppState;
use crate::error::AppError;
use crate::types::Item;
use axum::extract::{Path, Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use std::path::{Path as FsPath, PathBuf};

/// Sidecar extensions the browser can display once converted to WebVTT. Formats
/// we can't convert (`.ass`, `.ssa`) stay on disk and embedded, but aren't
/// offered for preview.
const PREVIEWABLE: &[&str] = &["vtt", "srt"];

/// Refuse to buffer an implausibly large subtitle file into memory.
const MAX_SUB_BYTES: u64 = 8 * 1024 * 1024;

/// One discovered sidecar.
struct Sub {
    /// The language tag from the filename (`…[id].en.vtt` → `en`).
    lang: String,
    path: PathBuf,
}

/// Scan the directory holding `video` for sidecars belonging to it. yt-dlp names
/// them `<video stem>.<lang>.<ext>`, so an exact `stem + '.'` prefix match keeps
/// a `Title [id] [720p].en.vtt` variant from being attributed to `Title [id].mkv`.
///
/// When a language has both a `.vtt` and a `.srt`, the `.vtt` wins (no conversion
/// needed). Results are sorted by lang for a stable order.
fn discover(video: &FsPath) -> Vec<Sub> {
    let (Some(dir), Some(stem)) = (video.parent(), video.file_stem().and_then(|s| s.to_str()))
    else {
        return Vec::new();
    };
    let prefix = format!("{stem}.");
    let mut found: Vec<Sub> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        // `rest` is `<lang>.<ext>`; both parts must be present and non-empty.
        let Some((lang, ext)) = rest.rsplit_once('.') else {
            continue;
        };
        let ext = ext.to_ascii_lowercase();
        if lang.is_empty() || !PREVIEWABLE.contains(&ext.as_str()) {
            continue;
        }
        match found.iter_mut().find(|s| s.lang == lang) {
            // Prefer the already-WebVTT copy over an SRT of the same language.
            Some(existing) => {
                if ext == "vtt" {
                    existing.path = path;
                }
            }
            None => found.push(Sub {
                lang: lang.to_string(),
                path,
            }),
        }
    }
    found.sort_by(|a, b| a.lang.cmp(&b.lang));
    found
}

/// Resolve an item to its confined on-disk video path, or `None` when it has no
/// local file (stream-only / not yet downloaded).
fn video_path(root: &FsPath, item: &Item) -> Option<PathBuf> {
    let stored = item.filepath.as_deref().filter(|p| !p.is_empty())?;
    crate::safepath::confined_file(root, stored)
}

/// GET /api/items/:slug/subs — the item's previewable subtitle tracks. Owner-only
/// via the `require_owner` middleware (see `api::router`), so no token check here.
pub async fn list(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Response, AppError> {
    let item = state
        .db
        .find_by_slug(&slug)
        .await?
        .ok_or(AppError::NotFound)?;
    let tracks = match video_path(&state.cfg.download_dir, &item) {
        Some(video) => discover(&video)
            .into_iter()
            .map(|s| json!({ "lang": s.lang, "label": label_for(&s.lang) }))
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };
    Ok(Json(json!({ "subs": tracks })).into_response())
}

/// GET /api/items/:slug/subs/:lang — one track, always served as WebVTT.
pub async fn get(
    State(state): State<AppState>,
    Path((slug, lang)): Path<(String, String)>,
    req: Request,
) -> Result<Response, AppError> {
    check_token(&state, &req)?;
    drop(req);
    let item = state
        .db
        .find_by_slug(&slug)
        .await?
        .ok_or(AppError::NotFound)?;
    let video = video_path(&state.cfg.download_dir, &item).ok_or(AppError::NotFound)?;
    // The client's `lang` only ever selects among discovered tracks — it is never
    // joined into a path.
    let sub = discover(&video)
        .into_iter()
        .find(|s| s.lang == lang)
        .ok_or(AppError::NotFound)?;
    // Belt-and-braces: re-confine the path we're about to read.
    let path = crate::safepath::confined_file(
        &state.cfg.download_dir,
        sub.path.to_str().ok_or(AppError::NotFound)?,
    )
    .ok_or(AppError::NotFound)?;

    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_SUB_BYTES {
        return Err(AppError::BadRequest("subtitle file is too large".into()));
    }
    let raw = tokio::fs::read_to_string(&path)
        .await
        .map_err(|_| AppError::NotFound)?;
    let is_vtt = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("vtt"));
    let body = if is_vtt { raw } else { srt_to_vtt(&raw) };

    Ok((
        [
            (header::CONTENT_TYPE, "text/vtt; charset=utf-8"),
            (header::CACHE_CONTROL, "private, no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        body,
    )
        .into_response())
}

/// Token-gate a request, mirroring `media::file`'s auth (the token may ride in
/// the query, since a `<track>` element can't set headers).
///
/// Deliberately synchronous: a borrow of `Request` held across an `.await` would
/// make the handler future non-`Send`, so callers check first, then await.
fn check_token(state: &AppState, req: &Request) -> Result<(), AppError> {
    let query = req.uri().query().unwrap_or("");
    let token = super::auth::extract_token(req.headers(), query);
    if token
        .as_deref()
        .is_some_and(|t| super::auth::ct_eq(t, &state.cfg.token))
    {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}

/// Convert SubRip to WebVTT. The two formats share a cue structure, so this is a
/// header plus a timestamp punctuation fix:
/// - prepend the `WEBVTT` magic,
/// - drop the numeric cue counter lines (legal in VTT, but pointless),
/// - rewrite `00:00:01,000 --> 00:00:02,000` to use `.` for the decimal.
fn srt_to_vtt(srt: &str) -> String {
    let mut out = String::with_capacity(srt.len() + 16);
    out.push_str("WEBVTT\n\n");
    // Strip a UTF-8 BOM and normalize CRLF so line matching is predictable.
    let body = srt.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let mut lines = body.lines().peekable();
    while let Some(line) = lines.next() {
        // A bare integer directly followed by a timing line is SRT's cue counter.
        if line.trim().parse::<u64>().is_ok() && lines.peek().is_some_and(|n| n.contains("-->")) {
            continue;
        }
        if line.contains("-->") {
            out.push_str(&line.replace(',', "."));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

/// A human label for a language tag. yt-dlp emits BCP-47-ish tags (`en`,
/// `zh-Hans`, `en-orig`); rendering the tag itself is honest and needs no
/// embedded language table — the browser shows it in the track menu.
fn label_for(lang: &str) -> String {
    lang.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn srt_converts_to_vtt() {
        let srt =
            "1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n";
        let vtt = srt_to_vtt(srt);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:01.000 --> 00:00:02.500"));
        assert!(vtt.contains("Hello"));
        assert!(vtt.contains("World"));
        // Cue counters dropped.
        assert!(!vtt.contains("\n1\n"));
    }

    #[test]
    fn srt_handles_bom_and_crlf() {
        let srt = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n";
        let vtt = srt_to_vtt(srt);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("00:00:01.000 --> 00:00:02.000"));
        assert!(!vtt.contains('\r'));
    }

    /// A number that isn't a cue counter (dialogue that's just digits) survives.
    #[test]
    fn srt_keeps_numeric_dialogue() {
        let srt = "1\n00:00:01,000 --> 00:00:02,000\n42\n";
        let vtt = srt_to_vtt(srt);
        assert!(vtt.contains("42"));
    }

    #[test]
    fn discover_matches_only_this_videos_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("Up - Title [abc].mkv");
        fs::write(&video, b"v").unwrap();
        fs::write(dir.path().join("Up - Title [abc].en.vtt"), b"s").unwrap();
        fs::write(dir.path().join("Up - Title [abc].zh-Hans.srt"), b"s").unwrap();
        // A resolution variant's sidecar must not be attributed to the primary.
        fs::write(dir.path().join("Up - Title [abc] [720p].fr.vtt"), b"s").unwrap();
        // An unrelated video's sidecar.
        fs::write(dir.path().join("Other [xyz].de.vtt"), b"s").unwrap();
        // A format we can't convert is not offered for preview.
        fs::write(dir.path().join("Up - Title [abc].ja.ass"), b"s").unwrap();

        let langs: Vec<String> = discover(&video).into_iter().map(|s| s.lang).collect();
        assert_eq!(langs, vec!["en".to_string(), "zh-Hans".to_string()]);
    }

    #[test]
    fn discover_prefers_vtt_over_srt_for_same_lang() {
        let dir = tempfile::tempdir().unwrap();
        let video = dir.path().join("V [1].mkv");
        fs::write(&video, b"v").unwrap();
        fs::write(dir.path().join("V [1].en.srt"), b"s").unwrap();
        fs::write(dir.path().join("V [1].en.vtt"), b"s").unwrap();
        let subs = discover(&video);
        assert_eq!(subs.len(), 1);
        assert!(subs[0].path.to_str().unwrap().ends_with(".en.vtt"));
    }
}
