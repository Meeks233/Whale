//! yt-dlp subprocess integration: options, metadata probe, download.

pub mod download;
pub mod metadata;
pub mod options;

use crate::config::Config;
use std::path::Path;

pub use download::download;
pub use metadata::probe;

#[derive(Debug, thiserror::Error)]
pub enum YtdlpError {
    #[error("probe failed: {0}")]
    Probe(String),
    #[error("download failed: {0}")]
    Download(String),
    #[error("yt-dlp not available: {0}")]
    Spawn(String),
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
) -> Result<String, YtdlpError> {
    let mut cmd = tokio::process::Command::new(&cfg.ytdlp_path);
    cmd.arg("--ignore-config")
        .arg("--no-warnings")
        .arg("-f")
        .arg("b[protocol^=http]/b")
        .arg("-g");
    if let Some(imp) = &cfg.impersonate {
        cmd.arg("--impersonate").arg(imp);
    }
    if let Some(c) = cookies {
        cmd.arg("--cookies").arg(c);
    }
    cmd.arg(url);

    let out = cmd
        .output()
        .await
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
