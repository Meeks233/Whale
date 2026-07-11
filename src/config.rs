//! Configuration loaded from environment variables. See docs/CONFIG.md.

use anyhow::{anyhow, Context};
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mkv,
    Mp4,
}

impl Container {
    pub fn ext(&self) -> &'static str {
        match self {
            Container::Mkv => "mkv",
            Container::Mp4 => "mp4",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub token: String,
    /// True when `token` was randomly generated because `WHALE_TOKEN` was unset.
    pub token_generated: bool,
    /// Trust-on-first-use for self-registered clients: when true, a client that
    /// POSTs a new passphrase to `/api/clients/register` is trusted immediately
    /// (single-user / private-network default). Set false to require the owner
    /// to approve each client with the token before it can submit.
    pub client_tofu: bool,
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub download_dir: PathBuf,
    pub concurrency: usize,
    /// Polite mode: serialize downloads (one at a time) and wait a random
    /// `sleep_min..=sleep_max` seconds between them, to avoid looking like a
    /// batch downloader. Default on. Overrides `concurrency` to 1 while active.
    pub polite: bool,
    /// Inclusive bounds (seconds) for the random inter-download pause in polite mode.
    pub sleep_min: u64,
    pub sleep_max: u64,
    /// Passed to yt-dlp `--sleep-requests` (seconds between HTTP requests). `None` omits it.
    pub sleep_requests: Option<String>,
    /// Passed to yt-dlp `--impersonate` (TLS/client fingerprint, e.g. `chrome`). `None` omits it.
    pub impersonate: Option<String>,
    /// yt-dlp `--concurrent-fragments` (multi-threaded fragment download).
    pub concurrent_fragments: usize,
    /// Total download-rate cap (e.g. `"10M"`), split across `concurrency` jobs.
    /// `None` disables rate limiting.
    pub limit_rate: Option<String>,
    pub container: Container,
    pub output_template: String,
    pub format: String,
    pub subs: bool,
    pub auto_subs: bool,
    pub sub_langs: String,
    pub embed_thumbnail: bool,
    pub cookies: Option<PathBuf>,
    pub ytdlp_path: String,
    pub ffmpeg_location: Option<PathBuf>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) => matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        Err(_) => default,
    }
}

fn env_opt(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let (token, token_generated) = match env_opt("WHALE_TOKEN") {
            Some(t) => (t, false),
            None => (random_token()?, true),
        };

        let bind: SocketAddr = env_or("WHALE_BIND", "0.0.0.0:8080")
            .parse()
            .context("WHALE_BIND must be a valid socket address")?;

        let data_dir = PathBuf::from(env_or("WHALE_DATA_DIR", "/data"));
        let download_dir = PathBuf::from(env_or("WHALE_DOWNLOAD_DIR", "/downloads"));

        let concurrency: usize = env_or("WHALE_CONCURRENCY", "2")
            .parse()
            .context("WHALE_CONCURRENCY must be a positive integer")?;

        let client_tofu = env_bool("WHALE_CLIENT_TOFU", true);

        let polite = env_bool("WHALE_POLITE", true);
        let sleep_min: u64 = env_or("WHALE_SLEEP_MIN", "2")
            .parse()
            .context("WHALE_SLEEP_MIN must be a non-negative integer")?;
        let sleep_max: u64 = env_or("WHALE_SLEEP_MAX", "7")
            .parse()
            .context("WHALE_SLEEP_MAX must be a non-negative integer")?;
        let sleep_max = sleep_max.max(sleep_min);
        let sleep_requests = env_opt("WHALE_SLEEP_REQUESTS");
        let impersonate = env_opt("WHALE_IMPERSONATE");

        let concurrent_fragments: usize = env_or("WHALE_CONCURRENT_FRAGMENTS", "4")
            .parse()
            .context("WHALE_CONCURRENT_FRAGMENTS must be a positive integer")?;

        // Total rate cap across all concurrent jobs; empty/"0"/"none" disables it.
        let limit_rate = match env_opt("WHALE_LIMIT_RATE") {
            None => Some("10M".to_string()),
            Some(v) => match v.trim().to_ascii_lowercase().as_str() {
                "0" | "none" | "off" | "unlimited" => None,
                _ => Some(v.trim().to_string()),
            },
        };

        let container = match env_or("WHALE_CONTAINER", "mkv").to_ascii_lowercase().as_str() {
            "mkv" => Container::Mkv,
            "mp4" => Container::Mp4,
            other => {
                return Err(anyhow!(
                    "WHALE_CONTAINER '{other}' is invalid; valid options: mkv, mp4"
                ))
            }
        };

        let output_template = env_or(
            "WHALE_OUTPUT_TEMPLATE",
            "%(uploader,channel|Unknown)s - %(title).150B [%(id)s].%(ext)s",
        );
        let format = env_or("WHALE_FORMAT", "bv*+ba/b");
        let subs = env_bool("WHALE_SUBS", true);
        let auto_subs = env_bool("WHALE_AUTO_SUBS", false);
        let sub_langs = env_or("WHALE_SUB_LANGS", "all,-live_chat");
        let embed_thumbnail = env_bool("WHALE_EMBED_THUMBNAIL", true);
        let cookies = env_opt("WHALE_COOKIES").map(PathBuf::from);
        let ytdlp_path = env_or("WHALE_YTDLP_PATH", "yt-dlp");
        let ffmpeg_location = env_opt("WHALE_FFMPEG_LOCATION").map(PathBuf::from);

        Ok(Config {
            token,
            token_generated,
            client_tofu,
            bind,
            data_dir,
            download_dir,
            concurrency,
            polite,
            sleep_min,
            sleep_max,
            sleep_requests,
            impersonate,
            concurrent_fragments,
            limit_rate,
            container,
            output_template,
            format,
            subs,
            auto_subs,
            sub_langs,
            embed_thumbnail,
            cookies,
            ytdlp_path,
            ffmpeg_location,
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("whale.db")
    }

    pub fn archive_path(&self) -> PathBuf {
        self.data_dir.join("archive.txt")
    }

    /// Number of downloads allowed to run at once: forced to 1 in polite mode,
    /// otherwise the configured `concurrency`.
    pub fn effective_concurrency(&self) -> usize {
        if self.polite { 1 } else { self.concurrency.max(1) }
    }

    /// Per-job `--limit-rate` value in bytes/s: the configured total cap divided
    /// across the effective concurrent jobs so their combined throughput stays
    /// under it. Returns `None` if rate limiting is disabled or unparseable.
    pub fn per_job_limit_rate(&self) -> Option<String> {
        let total = parse_rate(self.limit_rate.as_deref()?)?;
        let per = total / (self.effective_concurrency() as u64);
        Some(per.max(1).to_string())
    }

    /// A random inter-download pause for polite mode, uniform in
    /// `[sleep_min, sleep_max]` seconds. `Duration::ZERO` when polite is off.
    pub fn polite_delay(&self) -> std::time::Duration {
        if !self.polite {
            return std::time::Duration::ZERO;
        }
        let span = self.sleep_max.saturating_sub(self.sleep_min);
        let extra = if span == 0 { 0 } else { rand_below(span + 1) };
        std::time::Duration::from_secs(self.sleep_min + extra)
    }
}

/// Uniform random integer in `0..bound` (bound > 0) from OS randomness.
/// Rejection-sampled to avoid modulo bias.
fn rand_below(bound: u64) -> u64 {
    if bound <= 1 {
        return 0;
    }
    let zone = u64::MAX - (u64::MAX % bound);
    loop {
        let mut b = [0u8; 8];
        if std::io::Read::read_exact(
            &mut std::fs::File::open("/dev/urandom").expect("open /dev/urandom"),
            &mut b,
        )
        .is_err()
        {
            return 0;
        }
        let v = u64::from_le_bytes(b);
        if v < zone {
            return v % bound;
        }
    }
}

/// Parse a human rate string (`"10M"`, `"500K"`, `"1.5MiB"`, `"1048576"`) into
/// bytes/second. K/M/G are treated as binary (1024) multiples, matching yt-dlp.
fn parse_rate(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let digits_end = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, suffix) = s.split_at(digits_end);
    let value: f64 = num.parse().ok()?;
    let mult: f64 = match suffix.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * mult) as u64)
}

/// Generate a 32-character (128-bit) hex token from OS randomness.
fn random_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; 16];
    let mut f =
        std::fs::File::open("/dev/urandom").context("cannot open /dev/urandom to generate token")?;
    std::io::Read::read_exact(&mut f, &mut bytes)
        .context("cannot read randomness for token generation")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rate_handles_suffixes() {
        assert_eq!(parse_rate("10M"), Some(10 * 1024 * 1024));
        assert_eq!(parse_rate("500K"), Some(500 * 1024));
        assert_eq!(parse_rate("1048576"), Some(1048576));
        assert_eq!(parse_rate("1.5MiB"), Some((1.5 * 1024.0 * 1024.0) as u64));
        assert_eq!(parse_rate("garbage"), None);
    }

    #[test]
    fn rand_below_stays_in_range() {
        for _ in 0..200 {
            assert!(rand_below(6) < 6);
        }
        assert_eq!(rand_below(1), 0);
        assert_eq!(rand_below(0), 0);
    }

    #[test]
    fn random_token_is_32_hex_chars() {
        let t = random_token().unwrap();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, random_token().unwrap());
    }
}
