//! Platform (site) catalog + URL→platform detection for per-platform cookies.
//!
//! Detection is by URL **host** and is fully case-insensitive: hostnames are
//! case-insensitive per RFC 3986, so `X.COM`, `x.com`, and `www.X.com` all map
//! to the same platform. Aliases (e.g. `x.com` ⇄ `twitter.com`) share one
//! canonical `key`, so a cookie captured for X is reused for every twitter URL.

/// One supported site. `key` is the canonical id used as the cookie filename
/// and store key; it must be filesystem-safe (`[a-z0-9_]`).
#[derive(Debug, Clone, Copy)]
pub struct Platform {
    /// Canonical key (lowercase, filesystem-safe). Also the cookie file stem.
    pub key: &'static str,
    /// Human-readable name for the UI.
    pub name: &'static str,
    /// Registrable host suffixes, lowercase. A URL matches when its host equals
    /// a suffix or ends with `.<suffix>` (so subdomains like `m.`/`music.` match).
    pub hosts: &'static [&'static str],
    /// Login page to open for capturing cookies.
    pub login_url: &'static str,
}

/// The catalog of sites Whale offers per-platform cookies for. Ordered for the UI.
pub static CATALOG: &[Platform] = &[
    Platform {
        key: "youtube",
        name: "YouTube",
        hosts: &["youtube.com", "youtu.be", "youtube-nocookie.com"],
        login_url: "https://accounts.google.com/ServiceLogin?service=youtube",
    },
    Platform {
        // yt-dlp's extractor family for X is still "twitter"; both hosts alias here.
        key: "twitter",
        name: "X / Twitter",
        hosts: &["x.com", "twitter.com", "t.co"],
        login_url: "https://x.com/login",
    },
    Platform {
        key: "instagram",
        name: "Instagram",
        hosts: &["instagram.com", "instagr.am", "ig.me"],
        login_url: "https://www.instagram.com/accounts/login/",
    },
    Platform {
        key: "facebook",
        name: "Facebook",
        hosts: &["facebook.com", "fb.watch", "fb.com"],
        login_url: "https://www.facebook.com/login/",
    },
    Platform {
        key: "tiktok",
        name: "TikTok",
        hosts: &["tiktok.com"],
        login_url: "https://www.tiktok.com/login",
    },
    Platform {
        key: "bilibili",
        name: "Bilibili",
        hosts: &["bilibili.com", "b23.tv", "bilibili.tv"],
        login_url: "https://passport.bilibili.com/login",
    },
    Platform {
        key: "reddit",
        name: "Reddit",
        hosts: &["reddit.com", "redd.it"],
        login_url: "https://www.reddit.com/login/",
    },
    Platform {
        key: "twitch",
        name: "Twitch",
        hosts: &["twitch.tv"],
        login_url: "https://www.twitch.tv/login",
    },
    Platform {
        key: "vimeo",
        name: "Vimeo",
        hosts: &["vimeo.com"],
        login_url: "https://vimeo.com/log_in",
    },
    Platform {
        key: "niconico",
        name: "Niconico",
        hosts: &["nicovideo.jp", "nico.ms"],
        login_url: "https://account.nicovideo.jp/login",
    },
    Platform {
        key: "weibo",
        name: "Weibo",
        hosts: &["weibo.com", "weibo.cn"],
        login_url: "https://passport.weibo.com/",
    },
    Platform {
        key: "soundcloud",
        name: "SoundCloud",
        hosts: &["soundcloud.com"],
        login_url: "https://soundcloud.com/signin",
    },
    Platform {
        key: "dailymotion",
        name: "Dailymotion",
        hosts: &["dailymotion.com", "dai.ly"],
        login_url: "https://www.dailymotion.com/signin",
    },
];

/// Look up a platform by its canonical key. Case-insensitive so a stray
/// `Twitter` from an API caller still resolves.
pub fn by_key(key: &str) -> Option<&'static Platform> {
    CATALOG.iter().find(|p| p.key.eq_ignore_ascii_case(key))
}

/// Detect the platform for a URL by its host. Returns `None` for unknown sites
/// (which then fall back to the global cookies file, if any).
pub fn from_url(url: &str) -> Option<&'static Platform> {
    let host = host_of(url)?;
    CATALOG
        .iter()
        .find(|p| p.hosts.iter().any(|suffix| host_matches(&host, suffix)))
}

/// Extract the lowercased host from a URL, tolerating a missing scheme,
/// userinfo (`user@`), and a `:port` suffix.
fn host_of(url: &str) -> Option<String> {
    let s = url.trim();
    // Drop scheme.
    let s = s.split_once("://").map(|(_, rest)| rest).unwrap_or(s);
    // Authority ends at the first path/query/fragment delimiter.
    let authority = s.split(['/', '?', '#']).next().unwrap_or(s);
    // Drop userinfo.
    let authority = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    // Drop port (rightmost colon; also covers bare IPv4:port — good enough for our host set).
    let host = authority.split(':').next().unwrap_or(authority);
    let host = host.trim().trim_end_matches('.'); // tolerate a trailing FQDN dot
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// `host` matches `suffix` when it equals it or is a subdomain of it. Both are
/// assumed lowercase already.
fn host_matches(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_x_and_twitter_as_same_platform() {
        assert_eq!(from_url("https://x.com/user/status/1").unwrap().key, "twitter");
        assert_eq!(from_url("https://twitter.com/user/status/1").unwrap().key, "twitter");
        assert_eq!(
            from_url("https://mobile.twitter.com/user/status/1").unwrap().key,
            "twitter"
        );
    }

    #[test]
    fn detection_is_case_insensitive() {
        // Uppercase scheme/host must still resolve — this is the alias bug guard.
        assert_eq!(from_url("HTTPS://WWW.YOUTUBE.COM/watch?v=x").unwrap().key, "youtube");
        assert_eq!(from_url("https://YouTu.Be/abc").unwrap().key, "youtube");
        assert_eq!(from_url("https://X.COM/i/status/9").unwrap().key, "twitter");
    }

    #[test]
    fn matches_subdomains_but_not_lookalikes() {
        assert_eq!(from_url("https://music.youtube.com/watch?v=x").unwrap().key, "youtube");
        // A different registrable domain that merely contains the name must NOT match.
        assert!(from_url("https://notyoutube.com/watch?v=x").is_none());
        assert!(from_url("https://youtube.com.evil.example/x").is_none());
    }

    #[test]
    fn handles_missing_scheme_userinfo_and_port() {
        assert_eq!(from_url("youtu.be/abc").unwrap().key, "youtube");
        assert_eq!(from_url("https://user:pw@x.com:443/status/1").unwrap().key, "twitter");
    }

    #[test]
    fn unknown_host_is_none() {
        assert!(from_url("https://example.com/video/1").is_none());
        assert!(from_url("not a url").is_none());
        assert!(from_url("").is_none());
    }

    #[test]
    fn by_key_is_case_insensitive() {
        assert_eq!(by_key("Twitter").unwrap().key, "twitter");
        assert_eq!(by_key("YOUTUBE").unwrap().key, "youtube");
        assert!(by_key("nope").is_none());
    }

    #[test]
    fn all_keys_are_filesystem_safe_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for p in CATALOG {
            assert!(
                p.key.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "key {:?} is not filesystem-safe",
                p.key
            );
            assert!(seen.insert(p.key), "duplicate key {:?}", p.key);
        }
    }
}
