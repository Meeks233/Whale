//! Per-platform cookie store: Netscape `cookies.txt` files under
//! `<data_dir>/cookies/`, auto-applied by URL. Mirrors Seal's per-site login,
//! adapted to a server: the browser can't read cross-origin login cookies, so
//! the user pastes/exports a `cookies.txt` once and Whale reuses it per platform.
//!
//! On-disk layout (one file per platform `key`):
//!   `<key>.txt`      → cookies present and **enabled** (default)
//!   `<key>.txt.off`  → cookies present but **disabled** (kept, not applied)
//! Toggling enabled/disabled is an atomic rename; there is no separate index.

use crate::platform;
use std::io;
use std::path::{Path, PathBuf};

/// Handle to the cookie directory. Cheap to clone (just a path).
#[derive(Clone, Debug)]
pub struct CookieStore {
    dir: PathBuf,
}

/// Per-platform status for the API/UI.
#[derive(Debug, Clone)]
pub struct StoredCookie {
    pub present: bool,
    pub enabled: bool,
    pub bytes: u64,
    pub updated_at: i64,
    /// Earliest non-session cookie expiry (unix seconds), parsed from the jar's
    /// Netscape expiry column. `None` when every cookie is a session cookie or
    /// no expiry is present. Drives the UI's "expiring/expired" reminder.
    pub expires_at: Option<i64>,
}

impl CookieStore {
    /// Store rooted at `<data_dir>/cookies`. Does not touch the filesystem.
    pub fn new(data_dir: &Path) -> Self {
        CookieStore {
            dir: data_dir.join("cookies"),
        }
    }

    /// Create the cookie directory if missing. Call once at startup.
    pub fn ensure_dir(&self) -> io::Result<()> {
        std::fs::create_dir_all(&self.dir)
    }

    fn enabled_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.txt"))
    }

    fn disabled_path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.txt.off"))
    }

    /// Path to the cookie file to hand yt-dlp, iff cookies exist **and** are
    /// enabled for `key`. This is what `resolve` consults.
    pub fn active_cookie(&self, key: &str) -> Option<PathBuf> {
        let p = self.enabled_path(key);
        p.exists().then_some(p)
    }

    /// Save (replace) cookies for `key`, enabling them. Accepts any of the common
    /// export shapes (Netscape `cookies.txt`, a JSON cookie export, or a raw
    /// `name=value; …` header string) and normalizes to a yt-dlp Netscape file;
    /// returns `Err` if it doesn't look like cookies in any of those forms.
    /// `default_domain` is the site's primary host, used only to attach a bare
    /// header string (which carries no domain) to the right site.
    pub fn set(&self, key: &str, raw: &str, default_domain: Option<&str>) -> Result<(), String> {
        let body = normalize_cookies(raw, default_domain)?;
        self.ensure_dir().map_err(|e| e.to_string())?;
        // Writing enabled clears any disabled copy so state is unambiguous.
        let _ = std::fs::remove_file(self.disabled_path(key));
        std::fs::write(self.enabled_path(key), body).map_err(|e| e.to_string())
    }

    /// Enable or disable existing cookies by renaming. No-op if none present.
    pub fn set_enabled(&self, key: &str, enabled: bool) -> io::Result<()> {
        let on = self.enabled_path(key);
        let off = self.disabled_path(key);
        match (enabled, on.exists(), off.exists()) {
            (true, false, true) => std::fs::rename(&off, &on),
            (false, true, false) => std::fs::rename(&on, &off),
            _ => Ok(()), // already in the desired state, or nothing to toggle
        }
    }

    /// Move a cookie jar from `from` to `to`, preserving its enabled/disabled
    /// state. Used when merging websites so the surviving site inherits the
    /// merged-away site's cookies. No-op if `from` has nothing.
    pub fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        self.ensure_dir()?;
        let on = self.enabled_path(from);
        let off = self.disabled_path(from);
        if on.exists() {
            std::fs::rename(&on, self.enabled_path(to))?;
        } else if off.exists() {
            std::fs::rename(&off, self.disabled_path(to))?;
        }
        Ok(())
    }

    /// Delete cookies for `key` (both enabled and disabled copies).
    pub fn remove(&self, key: &str) -> io::Result<()> {
        for p in [self.enabled_path(key), self.disabled_path(key)] {
            if p.exists() {
                std::fs::remove_file(p)?;
            }
        }
        Ok(())
    }

    /// Status for a single platform key.
    pub fn status(&self, key: &str) -> StoredCookie {
        let on = self.enabled_path(key);
        let off = self.disabled_path(key);
        let (path, enabled) = if on.exists() {
            (Some(on), true)
        } else if off.exists() {
            (Some(off), false)
        } else {
            (None, false)
        };
        let (bytes, updated_at) = path
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| (m.len(), mtime_secs(&m)))
            .unwrap_or((0, 0));
        // Cookie jars are small (a few KB); reading to compute the earliest
        // expiry on each status call is cheap and keeps expiry always current.
        let expires_at = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .as_deref()
            .and_then(earliest_expiry);
        StoredCookie {
            present: path.is_some(),
            enabled,
            bytes,
            updated_at,
            expires_at,
        }
    }
}

/// UNIX seconds of a file's mtime, or 0 if unavailable.
fn mtime_secs(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Resolve the cookie file for a download of `url`: a platform-specific enabled
/// cookie wins; otherwise fall back to the global `WHALE_COOKIES` file (if set).
pub fn resolve(store: &CookieStore, global: Option<&Path>, url: &str) -> Option<PathBuf> {
    let key = platform::from_url(url).map(|p| p.key);
    resolve_keyed(store, global, key)
}

/// Resolve the cookie file when the caller has already determined the site `key`
/// (e.g. from the DB-backed website registry, which supports user-added sites the
/// static platform catalog doesn't). Falls back to the global cookie file.
pub fn resolve_keyed(store: &CookieStore, global: Option<&Path>, key: Option<&str>) -> Option<PathBuf> {
    if let Some(k) = key {
        if let Some(path) = store.active_cookie(k) {
            return Some(path);
        }
    }
    global.map(|p| p.to_path_buf())
}

/// Boolean → Netscape `TRUE`/`FALSE` flag column.
fn bool_flag(b: bool) -> &'static str {
    if b {
        "TRUE"
    } else {
        "FALSE"
    }
}

/// Earliest non-session cookie expiry (unix seconds) in a Netscape jar, or `None`
/// if every cookie is a session cookie (expiry `0`) or nothing parses. The 5th
/// tab field (index 4) is the expiry epoch.
fn earliest_expiry(contents: &str) -> Option<i64> {
    contents
        .lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') {
                return None;
            }
            let fields: Vec<&str> = l.split('\t').collect();
            if fields.len() < 7 {
                return None;
            }
            fields[4].trim().parse::<i64>().ok().filter(|e| *e > 0)
        })
        .min()
}

/// Detect the paste format and normalize to a yt-dlp Netscape `cookies.txt`.
/// Supports the three shapes users actually have on hand: a Netscape export, a
/// JSON export (EditThisCookie / Cookie-Editor / Puppeteer), or a raw `Cookie:`
/// header string. Mirrors what mature tools (yt-dlp, curl, browser extensions)
/// accept so the user never has to hand-convert.
fn normalize_cookies(raw: &str, default_domain: Option<&str>) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("cookie text is empty".to_string());
    }
    // JSON export: starts with `[` (array) or `{` (wrapper object).
    let first = trimmed.as_bytes()[0];
    if first == b'[' || first == b'{' {
        return json_to_netscape(trimmed);
    }
    // Netscape: at least one data line with the 7 tab-separated fields.
    let looks_netscape = trimmed.lines().any(|l| {
        let l = l.trim();
        !l.is_empty() && !l.starts_with('#') && l.split('\t').count() >= 7
    });
    if looks_netscape {
        return normalize_netscape(trimmed);
    }
    // Header string: `name=value; name2=value2` (carries no domain of its own).
    if trimmed.contains('=') {
        return header_to_netscape(trimmed, default_domain);
    }
    Err("does not look like cookies — paste a Netscape cookies.txt, a JSON cookie \
         export, or a \"name=value; …\" header string"
        .to_string())
}

/// Convert a JSON cookie export (bare array, or `{ "cookies": [...] }`) to
/// Netscape. Reads the common EditThisCookie/Cookie-Editor field names.
fn json_to_netscape(raw: &str) -> Result<String, String> {
    let val: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid JSON cookies: {e}"))?;
    let arr = match &val {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Object(o) => o
            .get("cookies")
            .and_then(|c| c.as_array())
            .cloned()
            .ok_or("JSON object has no \"cookies\" array")?,
        _ => return Err("JSON is not a cookie array".to_string()),
    };
    let mut lines = Vec::new();
    for c in &arr {
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let domain = c.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() || domain.is_empty() {
            continue;
        }
        let value = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
        let path = c.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let secure = c.get("secure").and_then(|v| v.as_bool()).unwrap_or(false);
        // A cookie applies to subdomains when it is not host-only (or its domain
        // carries the conventional leading dot).
        let host_only = c
            .get("hostOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(!domain.starts_with('.'));
        let include_sub = !host_only || domain.starts_with('.');
        // Expiry may be `expirationDate` (float secs) or `expires`; 0 = session.
        let expiry = c
            .get("expirationDate")
            .or_else(|| c.get("expires"))
            .and_then(|v| v.as_f64())
            .map(|f| f as i64)
            .filter(|e| *e > 0)
            .unwrap_or(0);
        let flag_domain = if include_sub && !domain.starts_with('.') {
            format!(".{domain}")
        } else {
            domain.to_string()
        };
        lines.push(format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}",
            flag_domain,
            bool_flag(include_sub),
            path,
            bool_flag(secure),
            expiry,
            name,
            value
        ));
    }
    if lines.is_empty() {
        return Err("JSON cookie export contained no usable cookies".to_string());
    }
    Ok(format!("# Netscape HTTP Cookie File\n{}\n", lines.join("\n")))
}

/// Convert a raw `Cookie:` header string (`a=b; c=d`) to Netscape, attaching every
/// pair to `default_domain` (the site's primary host) since the string has none.
fn header_to_netscape(raw: &str, default_domain: Option<&str>) -> Result<String, String> {
    let host = default_domain.map(|h| {
        let h = h.trim().trim_start_matches('.').to_ascii_lowercase();
        format!(".{h}") // leading dot → also applies to subdomains
    });
    let Some(domain) = host else {
        return Err("a \"name=value; …\" header needs a site to attach to — add \
                    this site's domain first, then paste"
            .to_string());
    };
    let mut lines = Vec::new();
    for pair in raw.split([';', '\n']) {
        let pair = pair.trim();
        if pair.is_empty() || pair.starts_with('#') {
            continue;
        }
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // Secure + session (expiry 0): the safe default for pasted auth cookies.
        lines.push(format!("{}\tTRUE\t/\tTRUE\t0\t{}\t{}", domain, name, value.trim()));
    }
    if lines.is_empty() {
        return Err("no name=value pairs found in the header string".to_string());
    }
    Ok(format!("# Netscape HTTP Cookie File\n{}\n", lines.join("\n")))
}

/// Validate + normalize pasted cookie text into a yt-dlp-acceptable Netscape
/// file: yt-dlp requires the magic header line and tab-separated fields.
fn normalize_netscape(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("cookie text is empty".to_string());
    }
    // A real cookie line has 7 tab-separated fields. Reject space-only pastes,
    // which yt-dlp would silently ignore, leaving the user confused.
    let looks_valid = trimmed.lines().any(|l| {
        let l = l.trim();
        !l.is_empty() && !l.starts_with('#') && l.split('\t').count() >= 7
    });
    if !looks_valid {
        return Err(
            "does not look like a Netscape cookies.txt (need tab-separated fields — \
             export with a \"Get cookies.txt\" browser extension)"
                .to_string(),
        );
    }
    let has_header = {
        let first = trimmed.lines().next().unwrap_or("").trim();
        first.starts_with("# Netscape HTTP Cookie File") || first.starts_with("# HTTP Cookie File")
    };
    let body = if has_header {
        trimmed.to_string()
    } else {
        format!("# Netscape HTTP Cookie File\n{trimmed}")
    };
    Ok(format!("{body}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str =
        ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc123\n.youtube.com\tTRUE\t/\tFALSE\t0\tHSID\txyz";

    fn store() -> (tempfile::TempDir, CookieStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = CookieStore::new(dir.path());
        s.ensure_dir().unwrap();
        (dir, s)
    }

    #[test]
    fn set_get_toggle_remove_roundtrip() {
        let (_d, s) = store();
        assert!(s.active_cookie("youtube").is_none());

        s.set("youtube", SAMPLE, None).unwrap();
        let path = s.active_cookie("youtube").expect("enabled after set");
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.starts_with("# Netscape HTTP Cookie File"));
        assert!(written.contains("SID\tabc123"));

        // Disable → not active, but still present.
        s.set_enabled("youtube", false).unwrap();
        assert!(s.active_cookie("youtube").is_none());
        let st = s.status("youtube");
        assert!(st.present && !st.enabled);

        // Re-enable.
        s.set_enabled("youtube", true).unwrap();
        assert!(s.active_cookie("youtube").is_some());

        // Remove clears both copies.
        s.remove("youtube").unwrap();
        assert!(!s.status("youtube").present);
    }

    #[test]
    fn header_is_prepended_when_missing() {
        assert!(normalize_netscape(SAMPLE)
            .unwrap()
            .starts_with("# Netscape HTTP Cookie File"));
        // Existing header is not duplicated.
        let with = format!("# Netscape HTTP Cookie File\n{SAMPLE}");
        let out = normalize_netscape(&with).unwrap();
        assert_eq!(out.matches("# Netscape HTTP Cookie File").count(), 1);
    }

    #[test]
    fn rejects_non_cookie_text() {
        assert!(normalize_netscape("").is_err());
        assert!(normalize_netscape("just some words here").is_err());
        // Space-separated (not tabs) is rejected.
        assert!(normalize_netscape(".youtube.com TRUE / TRUE 0 SID abc").is_err());
    }

    #[test]
    fn accepts_json_cookie_export() {
        let json = r#"[
            {"domain":".youtube.com","name":"SID","value":"abc","path":"/","secure":true,"expirationDate":2000000000.5,"hostOnly":false},
            {"domain":"x.com","name":"auth_token","value":"tok","path":"/","secure":true}
        ]"#;
        let out = normalize_cookies(json, None).unwrap();
        assert!(out.starts_with("# Netscape HTTP Cookie File"));
        assert!(out.contains(".youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tabc"));
        // host-only cookie gets a leading dot only when include-subdomains; here
        // hostOnly defaults true (no leading dot on domain) → FALSE flag, host kept.
        assert!(out.contains("x.com\tFALSE\t/\tTRUE\t0\tauth_token\ttok"));
    }

    #[test]
    fn accepts_header_string_with_domain() {
        let out = normalize_cookies("auth_token=tok; ct0=csrf", Some("x.com")).unwrap();
        assert!(out.contains(".x.com\tTRUE\t/\tTRUE\t0\tauth_token\ttok"));
        assert!(out.contains(".x.com\tTRUE\t/\tTRUE\t0\tct0\tcsrf"));
        // Without a domain a bare header string is rejected with a hint.
        assert!(normalize_cookies("auth_token=tok", None).is_err());
    }

    #[test]
    fn earliest_expiry_picks_min_nonzero() {
        let body = ".a.com\tTRUE\t/\tFALSE\t2000000000\tA\t1\n\
                    .a.com\tTRUE\t/\tFALSE\t0\tSESS\t2\n\
                    .a.com\tTRUE\t/\tFALSE\t1900000000\tB\t3";
        assert_eq!(earliest_expiry(body), Some(1900000000));
        // All-session jar → no expiry.
        assert_eq!(earliest_expiry(".a.com\tTRUE\t/\tFALSE\t0\tSESS\t2"), None);
    }

    #[test]
    fn resolve_prefers_platform_then_global() {
        let (_d, s) = store();
        let global = PathBuf::from("/data/global.txt");

        // No platform cookie → global fallback.
        assert_eq!(
            resolve(&s, Some(&global), "https://x.com/i/status/1"),
            Some(global.clone())
        );

        // Platform cookie present → wins over global. Note x.com → key "twitter".
        s.set("twitter", SAMPLE, None).unwrap();
        let got = resolve(&s, Some(&global), "https://x.com/i/status/1").unwrap();
        assert!(got.ends_with("twitter.txt"));

        // Disabled platform cookie → falls back to global again.
        s.set_enabled("twitter", false).unwrap();
        assert_eq!(
            resolve(&s, Some(&global), "https://twitter.com/i/status/1"),
            Some(global.clone())
        );

        // Unknown host + no global → nothing.
        assert!(resolve(&s, None, "https://example.com/v/1").is_none());
    }
}
