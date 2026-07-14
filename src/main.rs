//! Whale — self-hosted yt-dlp cloud downloader. CLI dispatch: `serve` | `import`.

// The whole crate handles untrusted input (URLs, response headers, filenames,
// file contents); there is no reason to reach for `unsafe`. Forbid it outright
// so any future `unsafe` block is a hard compile error, not a review miss.
#![forbid(unsafe_code)]

mod api;
mod archive;
mod config;
mod cookies;
mod db;
mod error;
mod net_guard;
mod platform;
mod queue;
mod safepath;
mod seal_import;
mod types;
mod url_normalize;
mod web;
mod ytdlp;

use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "whale", version, about = "Self-hosted yt-dlp cloud downloader")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP server + download worker.
    Serve,
    /// Import a Seal backup JSON (or URL list) into the history.
    Import {
        /// Path to the Seal backup file.
        file: PathBuf,
        /// Only append archive keys + minimal rows; skip full metadata.
        #[arg(long)]
        archive_only: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("WHALE_LOG")
                .or_else(|_| tracing_subscriber::EnvFilter::try_from_default_env())
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let cfg = config::Config::from_env()?;

    match cli.command {
        Command::Serve => serve(cfg).await,
        Command::Import { file, archive_only } => import(cfg, file, archive_only).await,
    }
}

async fn serve(cfg: config::Config) -> anyhow::Result<()> {
    use anyhow::Context;

    std::fs::create_dir_all(&cfg.data_dir)
        .with_context(|| format!("cannot create data dir {}", cfg.data_dir.display()))?;
    std::fs::create_dir_all(&cfg.download_dir)
        .with_context(|| format!("cannot create download dir {}", cfg.download_dir.display()))?;

    if cfg.token_generated {
        tracing::warn!(
            "WHALE_TOKEN not set — generated a random access token: {}",
            cfg.token
        );
        tracing::warn!("Enter this token in the web UI to unlock it. Set WHALE_TOKEN in your environment to keep it stable across restarts.");
    }

    let ytdlp_version = ytdlp::version(&cfg).await?;
    tracing::info!("yt-dlp version: {ytdlp_version}");

    let db = db::Db::connect(&cfg.data_dir).await?;

    // Startup recovery: reset running -> queued, seed archive from DB keys, and
    // sweep any public shares that lapsed while the server was down.
    let requeue = db.reset_running_to_queued().await?;
    match db.expire_public_shares().await {
        Ok(n) if n > 0 => tracing::info!("expired {n} lapsed public share(s) on startup"),
        Ok(_) => {}
        Err(e) => tracing::warn!("public-share expiry sweep failed: {e}"),
    }
    let seed = db.all_archive_keys().await?;
    let archive = archive::Archive::load(&cfg.archive_path(), seed).await?;

    let cookie_store = cookies::CookieStore::new(&cfg.data_dir);
    cookie_store
        .ensure_dir()
        .with_context(|| "cannot create cookies dir")?;

    let queue = queue::Queue::spawn(cfg.clone(), db.clone(), archive.clone(), cookie_store.clone());
    for id in requeue {
        queue.enqueue(id).await;
    }

    // Periodic disaster-recovery sweep: flip lapsed public shares to private so
    // expired links stop serving even without an access to trigger lazy expiry.
    {
        let db = db.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                tick.tick().await;
                match db.expire_public_shares().await {
                    Ok(n) if n > 0 => tracing::info!("expired {n} lapsed public share(s)"),
                    Ok(_) => {}
                    Err(e) => tracing::warn!("public-share expiry sweep failed: {e}"),
                }
            }
        });
    }

    let state = api::AppState {
        cfg: cfg.clone(),
        db,
        archive,
        queue,
        cookies: cookie_store,
        ytdlp_version,
    };

    let bind = cfg.bind;
    let router = api::router(state);
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("whale listening on {bind}");
    axum::serve(listener, router).await?;
    Ok(())
}

async fn import(cfg: config::Config, file: PathBuf, archive_only: bool) -> anyhow::Result<()> {
    std::fs::create_dir_all(&cfg.data_dir)?;
    let db = db::Db::connect(&cfg.data_dir).await?;
    let seed = db.all_archive_keys().await?;
    let archive = archive::Archive::load(&cfg.archive_path(), seed).await?;

    let outcome = seal_import::run_import(&cfg, &db, &archive, &file, archive_only).await?;
    println!(
        "import complete: imported={} skipped_dupes={} unparsable={}",
        outcome.imported, outcome.skipped_dupes, outcome.unparsable
    );
    Ok(())
}
