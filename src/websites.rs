//! Helpers for the user-editable website registry (see migration `0014_websites`
//! and `types::Website`). Detection/host-matching logic that operates on the
//! DB-backed rows; the compile-time `platform::CATALOG` remains the seed and the
//! fallback for alias-search folding.

use crate::types::Website;

/// Normalize a host or domain suffix: lowercase, trim, drop a leading `www.` and a
/// trailing FQDN dot so `WWW.YouTube.com.` and `youtube.com` compare equal.
pub fn normalize_host(h: &str) -> String {
    let h = h.trim().trim_end_matches('.').to_ascii_lowercase();
    h.strip_prefix("www.").unwrap_or(&h).to_string()
}

/// Parse a comma/space/newline-separated host list into a deduped, normalized
/// vector (order preserved). This is the single dedup point the migration comment
/// refers to — every save funnels through here.
pub fn parse_hosts(raw: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for part in raw.split([',', ' ', '\n', '\t', ';']) {
        let h = normalize_host(part);
        if h.is_empty() {
            continue;
        }
        if seen.insert(h.clone()) {
            out.push(h);
        }
    }
    out
}

/// Serialize a host vector back to the stored comma-separated form.
pub fn hosts_to_csv(hosts: &[String]) -> String {
    hosts.join(",")
}

/// True when `host` equals `suffix` or is a subdomain of it (both normalized).
fn host_matches(host: &str, suffix: &str) -> bool {
    host == suffix || host.ends_with(&format!(".{suffix}"))
}

/// Extract the lowercased host from a URL (tolerant of missing scheme, userinfo,
/// and port), then strip a leading `www.`.
pub fn host_of(url: &str) -> Option<String> {
    let s = url.trim();
    let s = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let authority = s.split(['/', '?', '#']).next().unwrap_or(s);
    let authority = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
    let host = authority.split(':').next().unwrap_or(authority);
    let host = normalize_host(host);
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

/// Find the website in `list` that owns `url`'s host, if any.
pub fn detect<'a>(list: &'a [Website], url: &str) -> Option<&'a Website> {
    let host = host_of(url)?;
    list.iter()
        .find(|w| w.hosts.iter().any(|suffix| host_matches(&host, suffix)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn site(key: &str, hosts: &[&str]) -> Website {
        Website {
            key: key.into(),
            name: key.into(),
            hosts: hosts.iter().map(|h| h.to_string()).collect(),
            login_url: String::new(),
            enabled: true,
            max_height: None,
            no_download: false,
            blur: false,
            sort: 0,
            cookie: None,
        }
    }

    #[test]
    fn parse_hosts_dedups_and_normalizes() {
        let h = parse_hosts("YouTube.com, youtu.be\nwww.youtube.com ; youtube.com");
        assert_eq!(h, vec!["youtube.com".to_string(), "youtu.be".to_string()]);
    }

    #[test]
    fn detect_matches_subdomains_and_aliases() {
        let list = vec![
            site("twitter", &["x.com", "twitter.com"]),
            site("youtube", &["youtube.com", "youtu.be"]),
        ];
        assert_eq!(
            detect(&list, "https://x.com/i/status/1").unwrap().key,
            "twitter"
        );
        assert_eq!(
            detect(&list, "https://mobile.twitter.com/a").unwrap().key,
            "twitter"
        );
        assert_eq!(
            detect(&list, "https://music.youtube.com/watch?v=x")
                .unwrap()
                .key,
            "youtube"
        );
        assert!(detect(&list, "https://example.com/v").is_none());
    }
}
