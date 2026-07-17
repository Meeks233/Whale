//! Configuration loaded from environment variables. See docs/CONFIGURATION.md.

use anyhow::{anyhow, Context};
use std::net::SocketAddr;
use std::path::PathBuf;

/// A merge container yt-dlp can mux into (`--merge-output-format`). Mirrors
/// yt-dlp's accepted set; `Mkv` is the default because it holds every codec
/// combination and any number of subtitle tracks without re-encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
    Mkv,
    Mp4,
    Webm,
    Mov,
    Avi,
    Flv,
}

/// Every container the UI offers, in menu order.
pub const CONTAINERS: &[Container] = &[
    Container::Mkv,
    Container::Mp4,
    Container::Webm,
    Container::Mov,
    Container::Avi,
    Container::Flv,
];

impl Container {
    pub fn ext(&self) -> &'static str {
        match self {
            Container::Mkv => "mkv",
            Container::Mp4 => "mp4",
            Container::Webm => "webm",
            Container::Mov => "mov",
            Container::Avi => "avi",
            Container::Flv => "flv",
        }
    }

    /// Parse a stored/env container name, case-insensitively. `None` for anything
    /// outside the known set.
    pub fn parse(s: &str) -> Option<Container> {
        let s = s.trim().to_ascii_lowercase();
        CONTAINERS.iter().copied().find(|c| c.ext() == s)
    }

    /// Comma-separated list of valid names, for error messages.
    pub fn valid_list() -> String {
        CONTAINERS
            .iter()
            .map(|c| c.ext())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub token: String,
    /// True when `token` was randomly generated because `ORCA_TOKEN` was unset.
    pub token_generated: bool,
    /// Trust-on-first-use for self-registered clients: when true, a client that
    /// POSTs a new passphrase to `/api/clients/register` is trusted immediately
    /// (explicit private-network opt-in). The secure default requires the owner
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
    /// True when `ORCA_CONTAINER` was set explicitly by the operator. It then
    /// overrides the stored global setting and every per-site override, and the
    /// UI shows the picker as locked.
    pub container_user_set: bool,
    pub output_template: String,
    pub format: String,
    /// True when `ORCA_FORMAT` was set explicitly by the operator. The
    /// resolution cap (`max_height`) is only injected into the *default* format
    /// — an explicit custom format is an escape hatch we pass through verbatim.
    pub format_user_set: bool,
    /// Max video pixel height passed in via `ORCA_MAX_HEIGHT` (e.g. 1080). When
    /// `Some`, it is authoritative and overrides any UI-stored value (an env var
    /// the operator "actively passed in" wins). `None` = follow the stored
    /// setting, defaulting to highest.
    pub max_height: Option<i64>,
    /// Ceiling (bytes) on the total size of everything downloaded, from
    /// `ORCA_MAX_STORAGE` (e.g. `500GB`, `1.5TB`, or a plain byte count). Same
    /// lock semantics as `max_height`: when `Some`, it overrides the UI-stored
    /// value and the Settings field goes read-only. `None` = follow the stored
    /// setting, which itself defaults to unlimited.
    pub max_storage: Option<i64>,
    pub subs: bool,
    /// True when `ORCA_SUBS` was set explicitly by the operator — same lock
    /// semantics as `container_user_set`.
    pub subs_user_set: bool,
    pub auto_subs: bool,
    pub sub_langs: String,
    pub embed_thumbnail: bool,
    pub cookies: Option<PathBuf>,
    pub ytdlp_path: String,
    /// Compatibility escape hatch for fake-IP DNS proxies. When false (default),
    /// hostnames resolving to non-public addresses are rejected before yt-dlp.
    pub allow_private_dns: bool,
    /// Canonical public base URL the server is reachable at (e.g.
    /// `https://orca.example.com`), declared by the operator. Used to build
    /// share links so they carry the real domain instead of whatever origin
    /// the UI happens to be loaded from. `None` falls back to the UI origin.
    pub public_url: Option<String>,
}

/// Parse a human storage size — `500GB`, `1.5 TB`, `250mb`, or a plain byte
/// count — into bytes. Units are binary (1 GB = 1024³), matching the `fmtSize`
/// readout the UI has always shown, so a cap typed as "500 GB" and a usage
/// rendered as "499.8 GB" are measured on the same ruler. Returns `None` for
/// anything unparseable or negative.
pub fn parse_size(s: &str) -> Option<i64> {
    let s = s.trim().to_ascii_lowercase();
    let split = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let num: f64 = num.trim().parse().ok()?;
    if !num.is_finite() || num < 0.0 {
        return None;
    }
    let mult: f64 = match unit.trim().trim_end_matches('b').trim_end_matches('i') {
        "" => 1.0,
        "k" => 1024.0,
        "m" => 1024f64.powi(2),
        "g" => 1024f64.powi(3),
        "t" => 1024f64.powi(4),
        "p" => 1024f64.powi(5),
        _ => return None,
    };
    let bytes = num * mult;
    // i64 saturates well past any real disk; reject rather than wrap.
    if bytes > i64::MAX as f64 {
        return None;
    }
    Some(bytes as i64)
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
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
    /// Default name yt-dlp writes: "<uploader> - <date> - <title> [<id>].<ext>".
    ///
    /// Every field is truncated in BYTES (`.NB`), not characters: ext4 caps a
    /// name at 255 *bytes*, the tightest limit across the filesystems a download
    /// can land on (NTFS, APFS and exFAT count 255 characters instead), so a CJK
    /// title at 3 bytes/char runs out of room on ext4 first. The fields below sum
    /// to 182 bytes, which is what `ytdlp::options::NAME_MAX_BYTES` enforces —
    /// the slack covers what yt-dlp appends *after* the template (see there).
    ///
    /// The date falls back from upload_date to release_date to "0000-00-00" so
    /// the field never collapses and shift the rest of the name around.
    pub const DEFAULT_OUTPUT_TEMPLATE: &'static str = "%(uploader,channel,creator|Unknown).32B - \
         %(upload_date>%Y-%m-%d,release_date>%Y-%m-%d|0000-00-00)s - \
         %(title,description|Untitled).101B [%(id).30B].%(ext)s";

    pub fn from_env() -> anyhow::Result<Self> {
        let (token, token_generated) = match env_opt("ORCA_TOKEN") {
            Some(t) => (t, false),
            None => (random_token()?, true),
        };

        // Refuse to boot with a weak operator-set token. A generated token is
        // always 128-bit random and skips the check; a hand-picked one is run
        // through an industry-style weak-password screen (length, character
        // diversity, and a common-credential blocklist) so a guessable token
        // can't silently protect a server that streams cookies. The
        // `ORCA_ALLOW_WEAK_TOKEN` escape hatch exists only for local dev.
        if !token_generated && !env_bool("ORCA_ALLOW_WEAK_TOKEN", false) {
            if let Err(reason) = token_strength(&token) {
                return Err(anyhow!(
                    "ORCA_TOKEN is too weak: {reason}. Choose a longer, random \
                     token (e.g. `openssl rand -hex 24`), or set \
                     ORCA_ALLOW_WEAK_TOKEN=1 for local development only."
                ));
            }
        }

        let bind: SocketAddr = env_or("ORCA_BIND", "0.0.0.0:8080")
            .parse()
            .context("ORCA_BIND must be a valid socket address")?;

        let data_dir = PathBuf::from(env_or("ORCA_DATA_DIR", "/data"));
        let download_dir = PathBuf::from(env_or("ORCA_DOWNLOAD_DIR", "/downloads"));

        let concurrency: usize = env_or("ORCA_CONCURRENCY", "2")
            .parse()
            .context("ORCA_CONCURRENCY must be a positive integer")?;

        let client_tofu = env_bool("ORCA_CLIENT_TOFU", false);

        let polite = env_bool("ORCA_POLITE", true);
        let sleep_min: u64 = env_or("ORCA_SLEEP_MIN", "2")
            .parse()
            .context("ORCA_SLEEP_MIN must be a non-negative integer")?;
        let sleep_max: u64 = env_or("ORCA_SLEEP_MAX", "7")
            .parse()
            .context("ORCA_SLEEP_MAX must be a non-negative integer")?;
        let sleep_max = sleep_max.max(sleep_min);
        let sleep_requests = env_opt("ORCA_SLEEP_REQUESTS");
        let impersonate = env_opt("ORCA_IMPERSONATE");

        let concurrent_fragments: usize = env_or("ORCA_CONCURRENT_FRAGMENTS", "4")
            .parse()
            .context("ORCA_CONCURRENT_FRAGMENTS must be a positive integer")?;

        // Total rate cap across all concurrent jobs; empty/"0"/"none" disables it.
        let limit_rate = match env_opt("ORCA_LIMIT_RATE") {
            None => Some("10M".to_string()),
            Some(v) => match v.trim().to_ascii_lowercase().as_str() {
                "0" | "none" | "off" | "unlimited" => None,
                _ => Some(v.trim().to_string()),
            },
        };

        // An explicitly-passed ORCA_CONTAINER is authoritative and locks the
        // global/per-site pickers, mirroring how ORCA_MAX_HEIGHT behaves.
        let container_user_set = env_opt("ORCA_CONTAINER").is_some();
        let raw_container = env_or("ORCA_CONTAINER", "mkv");
        let container = Container::parse(&raw_container).ok_or_else(|| {
            anyhow!(
                "ORCA_CONTAINER '{raw_container}' is invalid; valid options: {}",
                Container::valid_list()
            )
        })?;

        // Default name: "<uploader> - <date> - <title> [<id>].<ext>".
        //
        // Every field is truncated in BYTES (`.NB`), not characters: ext4 caps a
        // name at 255 *bytes*, which is the tightest of the filesystems we can
        // land on (NTFS/APFS/exFAT count 255 UTF-16/UTF-8 characters), so a CJK
        // title at 3 bytes/char hits ext4 first. The budget below sums to 231
        // bytes, leaving room for what yt-dlp appends after the template:
        // ` [2160p]` for a resolution variant (8), the longest container ext (5),
        // a `.zh-Hant.vtt` subtitle sidecar (12), and a `.part` suffix (5).
        //
        // The date comes from upload_date, falling back to release_date, and is
        // dropped to "0000-00-00" when the extractor reports neither.
        let output_template = env_or("ORCA_OUTPUT_TEMPLATE", Config::DEFAULT_OUTPUT_TEMPLATE);
        let format_user_set = env_opt("ORCA_FORMAT").is_some();
        let format = env_or("ORCA_FORMAT", "bv*+ba/b");
        // Highest by default (unset). A value of 0 / "highest"/"best"/"none"
        // explicitly means no cap; any positive integer caps the height.
        let max_height = match env_opt("ORCA_MAX_HEIGHT") {
            None => None,
            Some(v) => match v.trim().to_ascii_lowercase().as_str() {
                "0" | "highest" | "best" | "none" | "max" => None,
                other => Some(other.trim_end_matches('p').parse::<i64>().context(
                    "ORCA_MAX_HEIGHT must be an integer height (e.g. 1080), 'highest', or 0",
                )?),
            },
        };
        // Unlimited by default (unset). "0"/"none"/"unlimited" say so explicitly.
        let max_storage = match env_opt("ORCA_MAX_STORAGE") {
            None => None,
            Some(v) => match v.trim().to_ascii_lowercase().as_str() {
                "0" | "none" | "unlimited" => None,
                other => Some(parse_size(other).ok_or_else(|| {
                    anyhow!(
                        "ORCA_MAX_STORAGE must be a size like 500GB, 1.5TB, a plain byte count, \
                         or 'unlimited'"
                    )
                })?),
            },
        };
        let subs_user_set = env_opt("ORCA_SUBS").is_some();
        let subs = env_bool("ORCA_SUBS", true);
        let auto_subs = env_bool("ORCA_AUTO_SUBS", false);
        let sub_langs = env_or("ORCA_SUB_LANGS", "all,-live_chat");
        let embed_thumbnail = env_bool("ORCA_EMBED_THUMBNAIL", true);
        let cookies = env_opt("ORCA_COOKIES").map(PathBuf::from);
        let ytdlp_path = env_or("ORCA_YTDLP_PATH", "yt-dlp");
        let allow_private_dns = env_bool("ORCA_ALLOW_PRIVATE_DNS", false);
        // Strip trailing slashes so it concatenates cleanly with `/api/p/:slug`.
        let public_url = env_opt("ORCA_PUBLIC_URL")
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
            container_user_set,
            output_template,
            format,
            format_user_set,
            max_height,
            max_storage,
            subs,
            subs_user_set,
            auto_subs,
            sub_langs,
            embed_thumbnail,
            cookies,
            ytdlp_path,
            allow_private_dns,
            public_url,
        })
    }

    pub fn archive_path(&self) -> PathBuf {
        self.data_dir.join("archive.txt")
    }

    /// The `-f` format value for a download, applying the effective resolution
    /// cap. `max_height` is the resolved cap (env override or stored setting);
    /// `None` means highest. A custom operator-set `ORCA_FORMAT` is always
    /// passed through untouched (the cap only shapes our default selector).
    pub fn format_capped(&self, max_height: Option<i64>) -> String {
        capped_format(&self.format, self.format_user_set, max_height)
    }

    /// Number of downloads allowed to run at once: forced to 1 in polite mode,
    /// otherwise the configured `concurrency`.
    pub fn effective_concurrency(&self) -> usize {
        if self.polite {
            1
        } else {
            self.concurrency.max(1)
        }
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
            // Best video+audio at/under the cap, then a capped progressive file.
            // If the source has no rendition under the cap, choose its smallest
            // video instead of silently jumping to the unrestricted best quality.
            format!("bv*[height<={h}]+ba/b[height<={h}]/wv*+ba/w")
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

/// Industry-style weak-secret screen for an operator-supplied `ORCA_TOKEN`,
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
        "orca",
        "orcatoken",
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
    let mut f = std::fs::File::open("/dev/urandom")
        .context("cannot open /dev/urandom to generate token")?;
    std::io::Read::read_exact(&mut f, &mut bytes)
        .context("cannot read randomness for token generation")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_size_handles_units_and_bare_bytes() {
        assert_eq!(parse_size("500GB"), Some(500 * 1024_i64.pow(3)));
        assert_eq!(parse_size("1.5TB"), Some((1.5 * 1024f64.powi(4)) as i64));
        // Case, spacing, and the GiB spelling all mean the same thing.
        assert_eq!(parse_size(" 250 mb "), Some(250 * 1024_i64.pow(2)));
        assert_eq!(parse_size("2gib"), parse_size("2GB"));
        assert_eq!(parse_size("2PB"), Some(2 * 1024_i64.pow(5)));
        // No unit = bytes.
        assert_eq!(parse_size("1048576"), Some(1048576));
        assert_eq!(parse_size("0"), Some(0));
    }

    #[test]
    fn parse_size_rejects_nonsense() {
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_size("lots"), None);
        assert_eq!(parse_size("10 bananas"), None);
        assert_eq!(parse_size("-5GB"), None);
        // Past i64: reject rather than silently wrap to a negative cap.
        assert_eq!(parse_size("99999999PB"), None);
    }

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
            "bv*[height<=1080]+ba/b[height<=1080]/wv*+ba/w"
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
