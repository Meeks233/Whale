//! Seal backup parser + importer. Workstream H owns this file. See docs/SEAL_IMPORT.md.

use crate::archive::Archive;
use crate::config::Config;
use crate::db::Db;
use serde::Deserialize;
use std::path::Path;

/// One parsed Seal history record.
#[derive(Debug, Clone)]
pub struct SealRecord {
    pub title: String,
    pub author: Option<String>,
    pub url: String,
    pub path: String,
    pub extractor: String,
    /// Derived from `[id]` in the path, else a URL pattern, else None.
    pub video_id: Option<String>,
}

/// Result of importing a Seal record (per-record) or a whole run (aggregated).
#[derive(Debug, Clone, Copy, Default)]
pub struct ImportOutcome {
    pub imported: u64,
    pub skipped_dupes: u64,
    pub unparsable: u64,
}

/// Seal's `Backup` wrapper (`BackupUtil.kt`). Only `downloadHistory` is used.
#[derive(Debug, Deserialize)]
struct SealBackup {
    #[serde(rename = "downloadHistory")]
    download_history: Vec<DownloadedVideoInfo>,
}

/// One Seal `DownloadedVideoInfo` entry. `thumbnailUrl` is ignored.
#[derive(Debug, Deserialize)]
struct DownloadedVideoInfo {
    #[serde(rename = "videoTitle", default)]
    video_title: String,
    #[serde(rename = "videoAuthor", default)]
    video_author: Option<String>,
    #[serde(rename = "videoUrl", default)]
    video_url: String,
    #[serde(rename = "videoPath", default)]
    video_path: String,
    #[serde(default)]
    extractor: String,
}

pub async fn run_import(
    _cfg: &Config,
    db: &Db,
    archive: &Archive,
    file: &Path,
    archive_only: bool,
) -> anyhow::Result<ImportOutcome> {
    // `--archive-only` is accepted; v1 always runs the full import path (see SEAL_IMPORT.md §1).
    let _ = archive_only;

    let text = std::fs::read_to_string(file)?;
    let records = parse_records(&text);

    let mut agg = ImportOutcome::default();
    for mut rec in records {
        let unparsable = rec.video_id.is_none();
        if unparsable {
            // Synthetic key so the record still stores + shows in history (won't dedup variants).
            rec.video_id = Some(format!("url:{}", normalize_url(&rec.url)));
        }
        let archive_key = format!(
            "{} {}",
            rec.extractor,
            rec.video_id.as_deref().unwrap_or("")
        );

        let outcome = db.upsert_import(rec).await?;
        agg.imported += outcome.imported;
        agg.skipped_dupes += outcome.skipped_dupes;
        if unparsable {
            agg.unparsable += 1;
        }
        if outcome.imported > 0 {
            archive.insert(&archive_key).await?;
        }
    }
    Ok(agg)
}

/// Parse the input as a Seal JSON backup, or fall back to a plain URL list.
fn parse_records(text: &str) -> Vec<SealRecord> {
    match serde_json::from_str::<SealBackup>(text) {
        Ok(backup) => backup
            .download_history
            .into_iter()
            .map(record_from_info)
            .collect(),
        Err(_) => text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(record_from_url)
            .collect(),
    }
}

fn record_from_info(info: DownloadedVideoInfo) -> SealRecord {
    let extractor = if info.extractor.trim().is_empty() {
        extractor_from_url(&info.video_url)
    } else {
        normalize_extractor(&info.extractor)
    };
    let video_id = derive_video_id(&info.video_path, &info.video_url);
    SealRecord {
        title: info.video_title,
        author: info.video_author.filter(|a| !a.trim().is_empty()),
        url: info.video_url,
        path: info.video_path,
        extractor,
        video_id,
    }
}

fn record_from_url(url: &str) -> SealRecord {
    SealRecord {
        title: String::new(),
        author: None,
        url: url.to_string(),
        path: String::new(),
        extractor: extractor_from_url(url),
        video_id: derive_video_id("", url),
    }
}

// ---- derivation helpers (unit-tested without db/archive) ----

/// Derive the yt-dlp `id`: filename `[id]` first, then a URL pattern. `None` if neither.
pub(crate) fn derive_video_id(path: &str, url: &str) -> Option<String> {
    video_id_from_path(path).or_else(|| video_id_from_url(url))
}

/// Parse the trailing `[id].ext` token of `basename(path)` (Seal's default template).
pub(crate) fn video_id_from_path(path: &str) -> Option<String> {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    // Require an extension so we match `\[([^\[\]]+)\]\.[^.]+$`.
    let stem = base.rsplit_once('.')?.0;
    if !stem.ends_with(']') {
        return None;
    }
    let open = stem.rfind('[')?;
    let inner = &stem[open + 1..stem.len() - 1];
    if inner.is_empty() {
        return None;
    }
    Some(inner.to_string())
}

/// Best-effort id from a URL: YouTube `v=` / `youtu.be/<id>` / `shorts/<id>`, else last segment.
pub(crate) fn video_id_from_url(url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    if let Some(id) = segment_after(url, "youtu.be/") {
        return Some(id.to_string());
    }
    if let Some(id) = segment_after(url, "/shorts/") {
        return Some(id.to_string());
    }
    if let Some(id) = query_param(url, "v") {
        return Some(id.to_string());
    }
    last_path_segment(url).map(str::to_string)
}

/// Lowercase the extractor, mapping display-name quirks (e.g. `"YouTube"` -> `youtube`).
pub(crate) fn normalize_extractor(extractor: &str) -> String {
    let e = extractor.trim();
    if e.is_empty() {
        "generic".to_string()
    } else {
        e.to_lowercase()
    }
}

fn extractor_from_url(url: &str) -> String {
    if url.contains("youtube.com") || url.contains("youtu.be") {
        "youtube".to_string()
    } else {
        "generic".to_string()
    }
}

fn normalize_url(url: &str) -> String {
    url.trim().to_string()
}

/// The token immediately following `marker`, up to the next `/ ? & #` delimiter.
fn segment_after<'a>(s: &'a str, marker: &str) -> Option<&'a str> {
    let idx = s.find(marker)?;
    let rest = &s[idx + marker.len()..];
    let end = rest.find(['/', '?', '&', '#']).unwrap_or(rest.len());
    let tok = &rest[..end];
    (!tok.is_empty()).then_some(tok)
}

fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    let q = url.split_once('?')?.1;
    let q = q.split('#').next().unwrap_or(q);
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key && !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn last_path_segment(url: &str) -> Option<&str> {
    let s = url.split(['?', '#']).next().unwrap_or(url);
    let s = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    // Require a path (at least one '/') so a bare host yields None.
    let slash = s.find('/')?;
    s[slash + 1..].rsplit('/').find(|seg| !seg.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_from_seal_filename() {
        assert_eq!(
            video_id_from_path("/storage/emulated/0/Download/Some Title [dQw4w9WgXcQ].mkv")
                .as_deref(),
            Some("dQw4w9WgXcQ")
        );
    }

    #[test]
    fn id_from_youtu_be() {
        assert_eq!(
            video_id_from_url("https://youtu.be/abc123").as_deref(),
            Some("abc123")
        );
    }

    #[test]
    fn id_from_watch_v() {
        assert_eq!(
            video_id_from_url("https://www.youtube.com/watch?v=xyz789").as_deref(),
            Some("xyz789")
        );
    }

    #[test]
    fn id_from_shorts() {
        assert_eq!(
            video_id_from_url("https://www.youtube.com/shorts/s12345").as_deref(),
            Some("s12345")
        );
    }

    #[test]
    fn watch_v_stops_at_extra_params() {
        assert_eq!(
            video_id_from_url("https://www.youtube.com/watch?v=xyz789&t=30s").as_deref(),
            Some("xyz789")
        );
    }

    #[test]
    fn extractor_display_name_normalized() {
        assert_eq!(normalize_extractor("YouTube"), "youtube");
        assert_eq!(normalize_extractor("  "), "generic");
    }

    #[test]
    fn unparsable_path_and_opaque_url_yield_none() {
        assert_eq!(
            derive_video_id("/downloads/plain video.mkv", "https://example.com/"),
            None
        );
    }

    #[test]
    fn path_without_bracket_id_falls_through_to_url() {
        // No `[id]` in the filename, but the URL carries one.
        assert_eq!(
            derive_video_id("/dl/My Clip.mp4", "https://youtu.be/ID9").as_deref(),
            Some("ID9")
        );
    }

    #[test]
    fn parse_records_reads_seal_json() {
        let json = r#"{
            "downloadHistory": [
                {
                    "id": 1,
                    "videoTitle": "Never Gonna",
                    "videoAuthor": "Rick",
                    "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    "videoPath": "/dl/Never Gonna [dQw4w9WgXcQ].mkv",
                    "extractor": "youtube"
                }
            ]
        }"#;
        let recs = parse_records(json);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].video_id.as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(recs[0].extractor, "youtube");
        assert_eq!(recs[0].author.as_deref(), Some("Rick"));
    }

    #[test]
    fn parse_records_falls_back_to_url_list() {
        let list = "https://youtu.be/abc123\n\n  https://www.youtube.com/shorts/s12345  \n";
        let recs = parse_records(list);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].video_id.as_deref(), Some("abc123"));
        assert_eq!(recs[0].extractor, "youtube");
        assert_eq!(recs[1].video_id.as_deref(), Some("s12345"));
    }
}
