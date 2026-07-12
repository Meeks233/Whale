//! URL canonicalization for submitted links. Strips tracking params and folds
//! per-platform URL variants (short links, mobile hosts, `?si=`/`?s=` refs,
//! `utm_*`) to a stable canonical form before probing.
//!
//! Ported from the prior Flutter client's `UrlUtils.normalize` so links shared
//! from any client canonicalize identically. Kept deliberately conservative:
//! only well-known shapes are rewritten; anything unrecognized has just its
//! tracking query params stripped, and an unparseable string is returned as-is.

/// Tracking query parameters removed from otherwise-untouched URLs.
const TRACKING: &[&str] = &[
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "ref_src",
    "ref_url",
    "source",
    "feature",
    "spm_id_from",
];

/// Canonicalize a submitted URL. Returns the original (trimmed) string when it
/// can't be parsed as `scheme://host…`.
pub fn normalize(url: &str) -> String {
    // Drop trailing punctuation that often clings to a shared/pasted link.
    let trimmed = url.trim().trim_end_matches(&['.', ',', ';', '!', ']', ')'][..]);
    let Some(parts) = split(trimmed) else {
        return trimmed.to_string();
    };
    let host = parts.host.as_str();

    if host.contains("youtube.com") || host.contains("youtu.be") {
        return normalize_youtube(&parts);
    }
    if host.contains("twitter.com") || host.contains("x.com") {
        return normalize_twitter(&parts);
    }
    if host.contains("bilibili.com") {
        return normalize_bilibili(&parts);
    }
    if host.contains("tiktok.com") || host.contains("xiaohongshu.com") {
        return strip_query(&parts);
    }
    strip_tracking(&parts)
}

/// The pieces of a URL we care about. `query` preserves order.
struct Parts {
    scheme: String,
    host: String, // lowercased, userinfo/port removed
    path: String, // includes leading '/', or "" when absent
    query: Vec<(String, String)>,
}

impl Parts {
    fn segments(&self) -> Vec<&str> {
        self.path.split('/').filter(|s| !s.is_empty()).collect()
    }
    fn query_get(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// Split `scheme://authority/path?query#frag` into the parts we use. Returns
/// `None` if there's no `://` (we don't rewrite scheme-relative inputs).
fn split(url: &str) -> Option<Parts> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    // Authority ends at the first path/query/fragment delimiter.
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..auth_end];
    let after = &rest[auth_end..];

    // host = authority without userinfo and port.
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = host.split(':').next().unwrap_or(host).to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }

    // Drop the fragment, then split path and query.
    let after = after.split('#').next().unwrap_or(after);
    let (path, query_str) = match after.split_once('?') {
        Some((p, q)) => (p, q),
        None => (after, ""),
    };

    Some(Parts {
        scheme: scheme.to_ascii_lowercase(),
        host,
        path: path.to_string(),
        query: parse_query(query_str),
    })
}

fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|kv| !kv.is_empty())
        .map(|kv| match kv.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (kv.to_string(), String::new()),
        })
        .collect()
}

/// `scheme://host/path` with the query dropped entirely.
fn strip_query(p: &Parts) -> String {
    format!("{}://{}{}", p.scheme, p.host, p.path)
}

/// Keep everything but the known tracking params. Drops the `?` when nothing
/// meaningful remains.
fn strip_tracking(p: &Parts) -> String {
    let kept: Vec<&(String, String)> =
        p.query.iter().filter(|(k, _)| !TRACKING.contains(&k.as_str())).collect();
    if kept.is_empty() {
        return strip_query(p);
    }
    let q = kept
        .iter()
        .map(|(k, v)| if v.is_empty() { k.clone() } else { format!("{k}={v}") })
        .collect::<Vec<_>>()
        .join("&");
    format!("{}://{}{}?{}", p.scheme, p.host, p.path, q)
}

fn normalize_youtube(p: &Parts) -> String {
    let segs = p.segments();
    // youtu.be/<id>
    if p.host.contains("youtu.be") {
        if let Some(id) = segs.first() {
            return format!("https://www.youtube.com/watch?v={id}");
        }
    }
    // /shorts/<id>  and  /embed/<id>  → canonical watch URL
    for marker in ["shorts", "embed"] {
        if let Some(i) = segs.iter().position(|s| *s == marker) {
            if let Some(id) = segs.get(i + 1) {
                return format!("https://www.youtube.com/watch?v={id}");
            }
        }
    }
    // watch?v=<id> — keep only v, discarding stray `?si=` glued onto the value.
    if let Some(v) = p.query_get("v") {
        let clean = v.split('?').next().unwrap_or(v);
        return format!("https://www.youtube.com/watch?v={clean}");
    }
    // Unknown YouTube shape: just strip tracking.
    strip_tracking(p)
}

fn normalize_twitter(p: &Parts) -> String {
    let segs = p.segments();
    // …/status/<id> → canonical i/status form (host-agnostic).
    if let Some(i) = segs.iter().position(|s| *s == "status") {
        if let Some(id) = segs.get(i + 1) {
            return format!("https://twitter.com/i/status/{id}");
        }
    }
    // Otherwise normalize host to twitter.com and drop the query.
    format!("https://twitter.com{}", p.path)
}

fn normalize_bilibili(p: &Parts) -> String {
    // Keep only the BV id path, on www, no params.
    if let Some(bv) = p.segments().iter().find(|s| s.starts_with("BV")) {
        return format!("https://www.bilibili.com/video/{bv}");
    }
    format!("https://www.bilibili.com{}", p.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_short_and_shorts_and_watch() {
        assert_eq!(normalize("https://youtu.be/dQw4w9WgXcQ?si=abc"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert_eq!(normalize("https://www.youtube.com/shorts/aqz-KE-bpKQ"), "https://www.youtube.com/watch?v=aqz-KE-bpKQ");
        assert_eq!(
            normalize("https://m.youtube.com/watch?v=9bZkp7q19f0&feature=share&t=10"),
            "https://www.youtube.com/watch?v=9bZkp7q19f0"
        );
        assert_eq!(normalize("https://www.youtube.com/embed/abc123"), "https://www.youtube.com/watch?v=abc123");
    }

    #[test]
    fn twitter_and_x_status() {
        assert_eq!(normalize("https://x.com/user/status/123?s=20"), "https://twitter.com/i/status/123");
        assert_eq!(normalize("https://twitter.com/user/status/123"), "https://twitter.com/i/status/123");
        assert_eq!(normalize("https://mobile.twitter.com/foo/status/9/photo/1"), "https://twitter.com/i/status/9");
    }

    #[test]
    fn bilibili_keeps_bv() {
        assert_eq!(
            normalize("https://m.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.788"),
            "https://www.bilibili.com/video/BV1xx411c7mD"
        );
    }

    #[test]
    fn tiktok_strips_query() {
        assert_eq!(
            normalize("https://www.tiktok.com/@u/video/72?is_copy_url=1&is_from_webapp=v1"),
            "https://www.tiktok.com/@u/video/72"
        );
    }

    #[test]
    fn generic_strips_tracking_only() {
        assert_eq!(
            normalize("https://example.com/watch?id=5&utm_source=x&ref=y"),
            "https://example.com/watch?id=5"
        );
        // Nothing but tracking → query dropped.
        assert_eq!(normalize("https://example.com/v?utm_medium=a"), "https://example.com/v");
        // No query, unknown host → untouched (but trailing punctuation stripped).
        assert_eq!(normalize("https://example.com/video/1)."), "https://example.com/video/1");
    }

    #[test]
    fn unparseable_returned_as_is() {
        assert_eq!(normalize("not a url"), "not a url");
        assert_eq!(normalize("  spaced  "), "spaced");
    }
}
