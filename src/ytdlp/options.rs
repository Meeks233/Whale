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
    ];
    if let Some(cookies) = cookies {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }
    args.push(url.to_string());
    args
}

/// Args for a download run. `cookies` is the resolved cookie file for the item's
/// URL (per-platform if present, else global) — see `crate::cookies::resolve`.
pub fn download_args(cfg: &Config, item: &Item, cookies: Option<&Path>) -> Vec<String> {
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

    args.push("--embed-metadata".into());

    if cfg.embed_thumbnail {
        args.push("--embed-thumbnail".into());
    }

    args.push("--embed-chapters".into());

    args.push("-o".into());
    args.push(cfg.output_template.clone());

    args.push("--paths".into());
    args.push(format!("home:{}", cfg.download_dir.display()));
    args.push("--paths".into());
    args.push(format!("temp:{}/.part", cfg.download_dir.display()));

    args.push("--download-archive".into());
    args.push(cfg.archive_path().display().to_string());

    args.push("--no-simulate".into());
    args.push("--newline".into());

    args.push("--progress-template".into());
    args.push(
        "download:__WHALE__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
            .into(),
    );

    args.push("--print-to-file".into());
    args.push("after_move:filepath".into());
    args.push(format!("{}/.last_path_{}", cfg.data_dir.display(), item.id));

    if let Some(cookies) = cookies {
        args.push("--cookies".into());
        args.push(cookies.display().to_string());
    }

    if cfg.auto_subs {
        args.push("--write-auto-subs".into());
    }

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
            bind: "0.0.0.0:8080".parse::<SocketAddr>().unwrap(),
            data_dir: PathBuf::from("/data"),
            download_dir: PathBuf::from("/downloads"),
            concurrency: 2,
            container: Container::Mkv,
            output_template: "%(uploader,channel|Unknown)s - %(title).150B [%(id)s].%(ext)s".into(),
            format: "bv*+ba/b".into(),
            subs: true,
            auto_subs: false,
            sub_langs: "all,-live_chat".into(),
            embed_thumbnail: true,
            cookies: None,
            ytdlp_path: "yt-dlp".into(),
            ffmpeg_location: None,
        }
    }

    fn test_item() -> Item {
        Item {
            id: 42,
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
            source: Source::Download,
            status: Status::Queued,
            error: None,
            created_at: 0,
            completed_at: None,
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
        let args = download_args(&cfg, &item, None);

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

        // archive present
        let ai = pos(&args, "--download-archive");
        assert_eq!(args[ai + 1], "/data/archive.txt");

        // progress template present
        assert!(args.iter().any(|a| a
            == "download:__WHALE__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"));

        // print-to-file sidecar path uses item id
        let pi = pos(&args, "--print-to-file");
        assert_eq!(args[pi + 1], "after_move:filepath");
        assert_eq!(args[pi + 2], "/data/.last_path_42");

        // paths
        let phi = pos(&args, "--paths");
        assert_eq!(args[phi + 1], "home:/downloads");

        // relative order: -f before --merge-output-format before --download-archive
        assert!(fi < mi);
        assert!(mi < ai);

        // ends with the webpage_url
        assert_eq!(args.last().unwrap(), &item.webpage_url);
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
        let args = download_args(&cfg, &item, Some(&cookies));

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
