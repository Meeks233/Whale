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

    /// Save (replace) cookies for `key`, enabling them. Input is normalized to a
    /// valid Netscape file; returns `Err` if it doesn't look like `cookies.txt`.
    pub fn set(&self, key: &str, raw: &str) -> Result<(), String> {
        let body = normalize_netscape(raw)?;
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
        StoredCookie {
            present: path.is_some(),
            enabled,
            bytes,
            updated_at,
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
    if let Some(p) = platform::from_url(url) {
        if let Some(path) = store.active_cookie(p.key) {
            return Some(path);
        }
    }
    global.map(|p| p.to_path_buf())
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

        s.set("youtube", SAMPLE).unwrap();
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
    fn resolve_prefers_platform_then_global() {
        let (_d, s) = store();
        let global = PathBuf::from("/data/global.txt");

        // No platform cookie → global fallback.
        assert_eq!(
            resolve(&s, Some(&global), "https://x.com/i/status/1"),
            Some(global.clone())
        );

        // Platform cookie present → wins over global. Note x.com → key "twitter".
        s.set("twitter", SAMPLE).unwrap();
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
