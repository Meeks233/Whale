//! yt-dlp subprocess integration: options, metadata probe, download.

pub mod download;
pub mod metadata;
pub mod options;

use crate::config::Config;

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
