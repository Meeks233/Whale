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
    /// True when `WHALE_FORMAT` was set explicitly by the operator. The
    /// resolution cap (`max_height`) is only injected into the *default* format
    /// — an explicit custom format is an escape hatch we pass through verbatim.
    pub format_user_set: bool,
    /// Max video pixel height passed in via `WHALE_MAX_HEIGHT` (e.g. 1080). When
    /// `Some`, it is authoritative and overrides any UI-stored value (an env var
    /// the operator "actively passed in" wins). `None` = follow the stored
    /// setting, defaulting to highest.
    pub max_height: Option<i64>,
    pub subs: bool,
    pub auto_subs: bool,
    pub sub_langs: String,
    pub embed_thumbnail: bool,
    pub cookies: Option<PathBuf>,
    pub ytdlp_path: String,
    /// Canonical public base URL the server is reachable at (e.g.
    /// `https://whale.example.com`), declared by the operator. Used to build
    /// share links so they carry the real domain instead of whatever origin
    /// the UI happens to be loaded from. `None` falls back to the UI origin.
    pub public_url: Option<String>,
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

        // Refuse to boot with a weak operator-set token. A generated token is
        // always 128-bit random and skips the check; a hand-picked one is run
        // through an industry-style weak-password screen (length, character
        // diversity, and a common-credential blocklist) so a guessable token
        // can't silently protect a server that streams cookies. The
        // `WHALE_ALLOW_WEAK_TOKEN` escape hatch exists only for local dev.
        if !token_generated && !env_bool("WHALE_ALLOW_WEAK_TOKEN", false) {
            if let Err(reason) = token_strength(&token) {
                return Err(anyhow!(
                    "WHALE_TOKEN is too weak: {reason}. Choose a longer, random \
                     token (e.g. `openssl rand -hex 24`), or set \
                     WHALE_ALLOW_WEAK_TOKEN=1 for local development only."
                ));
            }
        }

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
        let format_user_set = env_opt("WHALE_FORMAT").is_some();
        let format = env_or("WHALE_FORMAT", "bv*+ba/b");
        // Highest by default (unset). A value of 0 / "highest"/"best"/"none"
        // explicitly means no cap; any positive integer caps the height.
        let max_height = match env_opt("WHALE_MAX_HEIGHT") {
            None => None,
            Some(v) => match v.trim().to_ascii_lowercase().as_str() {
                "0" | "highest" | "best" | "none" | "max" => None,
                other => Some(
                    other
                        .trim_end_matches('p')
                        .parse::<i64>()
                        .context("WHALE_MAX_HEIGHT must be an integer height (e.g. 1080), 'highest', or 0")?,
                ),
            },
        };
        let subs = env_bool("WHALE_SUBS", true);
        let auto_subs = env_bool("WHALE_AUTO_SUBS", false);
        let sub_langs = env_or("WHALE_SUB_LANGS", "all,-live_chat");
        let embed_thumbnail = env_bool("WHALE_EMBED_THUMBNAIL", true);
        let cookies = env_opt("WHALE_COOKIES").map(PathBuf::from);
        let ytdlp_path = env_or("WHALE_YTDLP_PATH", "yt-dlp");
        // Strip trailing slashes so it concatenates cleanly with `/api/p/:slug`.
        let public_url = env_opt("WHALE_PUBLIC_URL")
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty());

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
            format_user_set,
            max_height,
            subs,
            auto_subs,
            sub_langs,
            embed_thumbnail,
            cookies,
            ytdlp_path,
            public_url,
        })
    }

    pub fn archive_path(&self) -> PathBuf {
        self.data_dir.join("archive.txt")
    }

    /// The `-f` format value for a download, applying the effective resolution
    /// cap. `max_height` is the resolved cap (env override or stored setting);
    /// `None` means highest. A custom operator-set `WHALE_FORMAT` is always
    /// passed through untouched (the cap only shapes our default selector).
    pub fn format_capped(&self, max_height: Option<i64>) -> String {
        capped_format(&self.format, self.format_user_set, max_height)
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

/// Build the `-f` value from a base format and an optional height cap. A custom
/// operator format (`user_set`) is passed through verbatim; the cap only shapes
/// our default selector. `None` / non-positive height means no cap.
fn capped_format(base: &str, user_set: bool, max_height: Option<i64>) -> String {
    match max_height {
        Some(h) if !user_set && h > 0 => {
            // Best video+audio at/under the cap, then a capped progressive file,
            // then fall back to the best available so a source whose smallest
            // rendition exceeds the cap still downloads.
            format!("bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b")
        }
        _ => base.to_string(),
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

/// Industry-style weak-secret screen for an operator-supplied `WHALE_TOKEN`,
/// modelled on password-strength guidance (NIST SP 800-63B: length first, plus a
/// breached/common-credential blocklist). The bearer token is the *only* thing
/// standing between the internet and a server that streams saved cookies, so a
/// guessable one is refused at boot rather than silently accepted.
///
/// A high-entropy token also defeats offline/rainbow-table attacks on any leaked
/// token hash: the point of a precomputed table is to invert *guessable* inputs,
/// and these rules force the token out of that space.
///
/// Returns `Err(reason)` describing the first failed rule.
fn token_strength(token: &str) -> Result<(), String> {
    // 1. Length: the single biggest factor in resisting guessing. 12 is the
    //    floor; a generated token is 32 hex chars, so this only bites hand-picks.
    if token.chars().count() < 12 {
        return Err("it is shorter than 12 characters".to_string());
    }

    // 2. Common-credential blocklist (compile-time). Lowercased before compare so
    //    "Password1" and "PASSWORD1" are both caught. Kept small but covers the
    //    obvious dev placeholders and perennial top-of-the-breach-list entries.
    const WEAK: &[&str] = &[
        "test-token",
        "testtoken",
        "changeme",
        "password",
        "password1",
        "passw0rd",
        "letmein",
        "secret",
        "default",
        "admin",
        "administrator",
        "whale",
        "whaletoken",
        "token",
        "bearer",
        "12345678",
        "123456789",
        "1234567890",
        "qwertyui",
        "qwerty123",
        "iloveyou",
    ];
    let low = token.to_ascii_lowercase();
    if WEAK.contains(&low.as_str()) {
        return Err("it is a commonly-used / placeholder value".to_string());
    }

    // 3. Character variety: reject low-entropy strings that pass on length alone
    //    (e.g. "aaaaaaaaaaaa" or "abababababab"). Require at least 5 distinct
    //    characters, which every random hex/base64 token comfortably clears.
    let distinct = low.chars().collect::<std::collections::BTreeSet<_>>().len();
    if distinct < 5 {
        return Err("it repeats too few distinct characters".to_string());
    }

    Ok(())
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
    fn capped_format_injects_height_only_for_default_format() {
        // Default format + a cap → height-limited selector with a fallback.
        assert_eq!(
            capped_format("bv*+ba/b", false, Some(1080)),
            "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b"
        );
        // No cap (None or 0) → untouched default.
        assert_eq!(capped_format("bv*+ba/b", false, None), "bv*+ba/b");
        assert_eq!(capped_format("bv*+ba/b", false, Some(0)), "bv*+ba/b");
        // A custom operator format is passed through even with a cap set.
        assert_eq!(
            capped_format("bestvideo+bestaudio", true, Some(720)),
            "bestvideo+bestaudio"
        );
    }

    #[test]
    fn token_strength_flags_weak_and_accepts_strong() {
        // Too short.
        assert!(token_strength("short").is_err());
        // Common / placeholder values (case-insensitive).
        assert!(token_strength("test-token").is_err());
        assert!(token_strength("ChangeMe").is_err());
        assert!(token_strength("password1").is_err());
        // Long but low-variety.
        assert!(token_strength("aaaaaaaaaaaaaaaa").is_err());
        assert!(token_strength("abababababababab").is_err());
        // A generated-style token and a decent passphrase pass.
        assert!(token_strength(&random_token().unwrap()).is_ok());
        assert!(token_strength("correct-horse-battery-staple-42").is_ok());
    }

    #[test]
    fn random_token_is_32_hex_chars() {
        let t = random_token().unwrap();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, random_token().unwrap());
    }
}
