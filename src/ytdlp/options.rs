//! Build yt-dlp argument vectors from Config. Workstream C owns this file.
//! See docs/DOWNLOAD_PIPELINE.md §1–§2.

use crate::config::Config;
use crate::types::Item;
use std::path::Path;

/// Args for the metadata probe (`yt-dlp --dump-json --skip-download ...`).
///
/// `cookies` is the already-resolved cookie file for this URL (per-platform
/// cookie if present, else the global one) — see `crate::cookies::resolve`.
pub fn probe_args(cfg: &Config, url: &str, cookies: Option<&Path>) -> Vec<String> {
    let _ = cfg; // kept for signature symmetry / future per-config probe flags
    let mut args: Vec<String> = vec![
        "--dump-json".into(),
        "--skip-download".into(),
        "--no-warnings".into(),
        "--ignore-config".into(),
        "--playlist-end".into(),
        "500".into(),
    ];
    if let Some(cookies) = cookies {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }
    // End-of-options: a URL starting with `-` must not be read as a flag.
    args.push("--".into());
    args.push(url.to_string());
    args
}

/// Per-job filename/sidecar tag: `<id>` for a normal download, `<id>_<height>`
/// for a specific-resolution variant, so concurrent variant downloads of one
/// item don't collide on the `.last_path_*` / `.last_res_*` sidecars.
pub(crate) fn job_tag(item_id: i64, variant: Option<i64>) -> String {
    match variant {
        Some(h) => format!("{item_id}_{h}"),
        None => item_id.to_string(),
    }
}

/// Args for a download run. `cookies` is the resolved cookie file for the item's
/// URL (per-platform if present, else global) — see `crate::cookies::resolve`.
///
/// `variant` is `Some(height)` when downloading a specific resolution version
/// (a second/third copy of the same video): it suffixes the output filename with
/// `[<height>p]` so it doesn't overwrite the primary file, and tags the sidecars.
pub fn download_args(
    cfg: &Config,
    item: &Item,
    cookies: Option<&Path>,
    variant: Option<i64>,
) -> Vec<String> {
    let tag = job_tag(item.id, variant);
    // Suffix the filename with the resolution for variant downloads so the copies
    // sit side by side (…[id].mkv and …[id] [720p].mkv).
    let output_template = match variant {
        Some(h) => cfg
            .output_template
            .replace(".%(ext)s", &format!(" [{h}p].%(ext)s")),
        None => cfg.output_template.clone(),
    };
    let mut args: Vec<String> = vec![
        "--ignore-config".into(),
        "--no-warnings".into(),
        "-f".into(),
        cfg.format.clone(),
        "--merge-output-format".into(),
        cfg.container.ext().into(),
    ];

    if cfg.subs {
        args.push("--embed-subs".into());
        args.push("--write-subs".into());
        args.push("--sub-langs".into());
        args.push(cfg.sub_langs.clone());
    }

    // Multi-threaded fragment download (Seal-style).
    if cfg.concurrent_fragments > 1 {
        args.push("--concurrent-fragments".into());
        args.push(cfg.concurrent_fragments.to_string());
    }

    // Rate limiting: total cap split across concurrent jobs (bytes/s).
    if let Some(rate) = cfg.per_job_limit_rate() {
        args.push("--limit-rate".into());
        args.push(rate);
    }

    // Anti-batch pacing (belt-and-suspenders alongside the queue-level delay):
    // yt-dlp's own inter-request sleep. UA is intentionally NOT overridden —
    // yt-dlp already presents browser UAs per extractor.
    if let Some(sr) = &cfg.sleep_requests {
        args.push("--sleep-requests".into());
        args.push(sr.clone());
    }
    // Optional TLS/client-fingerprint impersonation for sites that fingerprint it.
    if let Some(imp) = &cfg.impersonate {
        args.push("--impersonate".into());
        args.push(imp.clone());
    }

    // Multi-video post: several items share one webpage_url, so restrict this run
    // to the item's own video by position. Absent for standalone items (the URL
    // already names a single video).
    if let Some(idx) = item.playlist_index {
        args.push("--playlist-items".into());
        args.push(idx.to_string());
    }

    args.push("--embed-metadata".into());

    if cfg.embed_thumbnail {
        args.push("--embed-thumbnail".into());
    }

    args.push("--embed-chapters".into());

    args.push("-o".into());
    args.push(output_template);

    // Self-organise the download directory by site: each item's files land in a
    // per-platform subfolder (YouTube/, Twitter/, …) derived from its extractor.
    let site_dir = crate::platform::download_folder(&item.extractor);
    args.push("--paths".into());
    args.push(format!("home:{}/{}", cfg.download_dir.display(), site_dir));
    args.push("--paths".into());
    args.push(format!("temp:{}/.part", cfg.download_dir.display()));

    // The download archive dedups against already-fetched videos. A resolution
    // variant is a *deliberate* re-download of a video whose key is already in
    // the archive, so it must bypass the archive entirely — otherwise yt-dlp
    // skips it ("already recorded") and writes no file. Only the primary download
    // records/consults the archive.
    if variant.is_none() {
        args.push("--download-archive".into());
        args.push(cfg.archive_path().display().to_string());
    }

    args.push("--no-simulate".into());
    args.push("--newline".into());

    // Trailing vcodec/acodec of the format being downloaded let us label the
    // video vs audio pass of a split `bv*+ba` download (see parse_progress_line).
    args.push("--progress-template".into());
    args.push(
        "download:__ORCA__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.vcodec)s|%(info.acodec)s"
            .into(),
    );

    args.push("--print-to-file".into());
    args.push("after_move:filepath".into());
    args.push(format!("{}/.last_path_{}", cfg.data_dir.display(), tag));

    // Capture the final video height (e.g. 1080) so the UI can label the item's
    // resolution. Written to its own sidecar; empty/"NA" for audio-only.
    args.push("--print-to-file".into());
    args.push("after_move:%(height)s".into());
    args.push(format!("{}/.last_res_{}", cfg.data_dir.display(), tag));

    if let Some(cookies) = cookies {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }

    if cfg.auto_subs {
        args.push("--write-auto-subs".into());
    }

    // End-of-options: a URL starting with `-` must not be read as a flag.
    args.push("--".into());
    args.push(item.webpage_url.clone());
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Container;
    use crate::types::{Item, Source, Status};
    use std::net::SocketAddr;
    use std::path::PathBuf;

    fn test_config() -> Config {
        Config {
            token: "secret".into(),
            token_generated: false,
            public_url: None,
            client_tofu: true,
            bind: "0.0.0.0:8080".parse::<SocketAddr>().unwrap(),
            data_dir: PathBuf::from("/data"),
            download_dir: PathBuf::from("/downloads"),
            concurrency: 2,
            polite: false,
            sleep_min: 2,
            sleep_max: 7,
            sleep_requests: None,
            impersonate: None,
            concurrent_fragments: 4,
            limit_rate: Some("10M".into()),
            container: Container::Mkv,
            output_template: "%(uploader,channel|Unknown)s - %(title).150B [%(id)s].%(ext)s".into(),
            format: "bv*+ba/b".into(),
            format_user_set: false,
            max_height: None,
            subs: true,
            auto_subs: false,
            sub_langs: "all,-live_chat".into(),
            embed_thumbnail: true,
            cookies: None,
            ytdlp_path: "yt-dlp".into(),
            allow_private_dns: false,
        }
    }

    fn test_item() -> Item {
        Item {
            id: 42,
            slug: "0123456789abcdef0123456789abcdef".into(),
            extractor: "youtube".into(),
            video_id: "abc123".into(),
            archive_key: "youtube abc123".into(),
            title: "Test Video".into(),
            uploader: Some("Uploader".into()),
            webpage_url: "https://example.com/watch?v=abc123".into(),
            thumbnail_url: None,
            duration: Some(120),
            filepath: None,
            filesize: None,
            height: None,
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
            local_available: false,
            total_filesize: 0,
            playlist_index: None,
        }
    }

    /// Find the index of `needle` in `args`, asserting it exists.
    fn pos(args: &[String], needle: &str) -> usize {
        args.iter()
            .position(|a| a == needle)
            .unwrap_or_else(|| panic!("arg {needle:?} not found in {args:?}"))
    }

    #[test]
    fn probe_args_shape() {
        let cfg = test_config();
        let url = "https://example.com/watch?v=abc123";
        let args = probe_args(&cfg, url, None);
        assert_eq!(args.first().unwrap(), "--dump-json");
        assert_eq!(args.last().unwrap(), url);
        // no cookies resolved → no --cookies flag
        assert!(!args.iter().any(|a| a == "--cookies"));
    }

    #[test]
    fn probe_args_with_cookies() {
        let cfg = test_config();
        let url = "https://example.com/x";
        let cookies = PathBuf::from("/data/cookies.txt");
        let args = probe_args(&cfg, url, Some(&cookies));
        let ci = pos(&args, "--cookies");
        assert_eq!(args[ci + 1], "/data/cookies.txt");
        assert_eq!(args.last().unwrap(), url);
    }

    #[test]
    fn download_args_key_flags_in_order() {
        let cfg = test_config();
        let item = test_item();
        let args = download_args(&cfg, &item, None, None);

        // --merge-output-format immediately followed by "mkv"
        let mi = pos(&args, "--merge-output-format");
        assert_eq!(args[mi + 1], "mkv");

        // -f immediately followed by "bv*+ba/b"
        let fi = pos(&args, "-f");
        assert_eq!(args[fi + 1], "bv*+ba/b");

        // subs on
        assert!(args.iter().any(|a| a == "--embed-subs"));
        let sl = pos(&args, "--sub-langs");
        assert_eq!(args[sl + 1], "all,-live_chat");

        // thumbnail on
        assert!(args.iter().any(|a| a == "--embed-thumbnail"));

        // multi-threaded fragments
        let cf = pos(&args, "--concurrent-fragments");
        assert_eq!(args[cf + 1], "4");

        // rate limit: 10M total / concurrency 2 = 5 MiB/s per job
        let lr = pos(&args, "--limit-rate");
        assert_eq!(args[lr + 1], (5 * 1024 * 1024).to_string());

        // archive present
        let ai = pos(&args, "--download-archive");
        assert_eq!(args[ai + 1], "/data/archive.txt");

        // progress template present
        assert!(args.iter().any(|a| a
            == "download:__ORCA__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.vcodec)s|%(info.acodec)s"));

        // print-to-file sidecar path uses item id
        let pi = pos(&args, "--print-to-file");
        assert_eq!(args[pi + 1], "after_move:filepath");
        assert_eq!(args[pi + 2], "/data/.last_path_42");

        // paths: home is the per-site subfolder (test_item's extractor is youtube)
        let phi = pos(&args, "--paths");
        assert_eq!(args[phi + 1], "home:/downloads/Youtube");

        // relative order: -f before --merge-output-format before --download-archive
        assert!(fi < mi);
        assert!(mi < ai);

        // ends with the webpage_url
        assert_eq!(args.last().unwrap(), &item.webpage_url);
    }

    #[test]
    fn download_args_pins_playlist_index_when_set() {
        let cfg = test_config();
        let mut item = test_item();
        // Standalone item → no --playlist-items.
        assert!(!download_args(&cfg, &item, None, None)
            .iter()
            .any(|a| a == "--playlist-items"));
        // Multi-video post entry → pinned to its position.
        item.playlist_index = Some(2);
        let args = download_args(&cfg, &item, None, None);
        let pi = pos(&args, "--playlist-items");
        assert_eq!(args[pi + 1], "2");
    }

    #[test]
    fn download_args_respects_toggles() {
        let mut cfg = test_config();
        cfg.subs = false;
        cfg.embed_thumbnail = false;
        cfg.auto_subs = true;
        cfg.container = Container::Mp4;
        let item = test_item();
        let cookies = PathBuf::from("/data/c.txt");
        let args = download_args(&cfg, &item, Some(&cookies), None);

        assert!(!args.iter().any(|a| a == "--embed-subs"));
        assert!(!args.iter().any(|a| a == "--write-subs"));
        assert!(!args.iter().any(|a| a == "--embed-thumbnail"));
        assert!(args.iter().any(|a| a == "--write-auto-subs"));

        let mi = pos(&args, "--merge-output-format");
        assert_eq!(args[mi + 1], "mp4");

        let ci = pos(&args, "--cookies");
        assert_eq!(args[ci + 1], "/data/c.txt");

        assert_eq!(args.last().unwrap(), &item.webpage_url);
    }
}
