//! URL canonicalization for submitted links. Strips tracking params and folds
//! per-platform URL variants (short links, mobile hosts, `?si=`/`?s=` refs,
//! `utm_*`) to a stable canonical form before probing.
//!
//! Ported from the prior Flutter client's `UrlUtils.normalize` so links shared
//! from any client canonicalize identically. Kept deliberately conservative:
//! only well-known shapes are rewritten; anything unrecognized has just its
//! tracking query params stripped, and an unparseable string is returned as-is.

/// Cross-site tracking query parameters removed from every URL, whatever the
/// host. These are analytics/ad-click/share-provenance markers that never carry
/// content — see the tarnhelm ruleset this list is modelled on. Per-platform
/// rules below handle the params that ARE meaningful on a given site.
const TRACKING: &[&str] = &[
    // Google Analytics / Urchin campaign tags.
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "utm_name",
    "utm_reader",
    "utm_referrer",
    "utm_social",
    "utm_swu",
    // Ad-network click identifiers.
    "gclid",
    "gclsrc",
    "dclid",
    "fbclid",
    "msclkid",
    "yclid",
    "twclid",
    "ttclid",
    "igshid",
    "igsh",
    // Email / marketing-automation trackers.
    "mc_cid",
    "mc_eid",
    "mkt_tok",
    "_hsenc",
    "_hsmi",
    "vero_id",
    "oly_anon_id",
    "oly_enc_id",
    // Generic referral / share-provenance markers.
    "ref",
    "ref_src",
    "ref_url",
    "referrer",
    "source",
    "feature",
    "spm",
    "spm_id_from",
    "scm",
    "vd_source",
    "share_source",
    "share_medium",
    "share_plat",
    "share_tag",
    "share_from",
    "share_token",
];

/// Canonicalize a submitted URL. Returns the original (trimmed) string when it
/// can't be parsed as `scheme://host…`.
pub fn normalize(url: &str) -> String {
    // Drop trailing punctuation that often clings to a shared/pasted link.
    let trimmed = url
        .trim()
        .trim_end_matches(&['.', ',', ';', '!', ']', ')'][..]);
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
    // Sites whose query string is pure tracking / share provenance: the path is
    // the whole address, so drop the query entirely. Short-link hosts (b23.tv,
    // vm.tiktok.com, instagr.am, redd.it, …) are intentionally NOT rewritten —
    // their code can only be expanded by following the redirect, which yt-dlp
    // does at probe time; here we just clear their query so the resolver gets a
    // clean short link.
    if host.contains("tiktok.com")
        || host.contains("xiaohongshu.com")
        || host.contains("instagram.com")
        || host.contains("threads.net")
        || host.contains("reddit.com")
        || host.contains("redd.it")
        || host.contains("weibo.com")
        || host.contains("weibo.cn")
        || host.contains("pixiv.net")
    {
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
        self.query
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
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
    let host = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);
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
    let kept: Vec<&(String, String)> = p
        .query
        .iter()
        .filter(|(k, _)| !TRACKING.contains(&k.as_str()))
        .collect();
    if kept.is_empty() {
        return strip_query(p);
    }
    let q = kept
        .iter()
        .map(|(k, v)| {
            if v.is_empty() {
                k.clone()
            } else {
                format!("{k}={v}")
            }
        })
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
    // /shorts/<id>, /embed/<id>, /live/<id>  → canonical watch URL
    for marker in ["shorts", "embed", "live"] {
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
    // Preserve the multi-part page selector (?p=N): it names WHICH part of a
    // multi-video collection, so it's content, not tracking. Everything else in
    // the query (spm_id_from, vd_source, share_*, buvid, …) is dropped.
    let page = p
        .query_get("p")
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()));
    let suffix = page.map(|v| format!("?p={v}")).unwrap_or_default();
    // Keep only the BV id path, on www.
    if let Some(bv) = p.segments().iter().find(|s| s.starts_with("BV")) {
        return format!("https://www.bilibili.com/video/{bv}{suffix}");
    }
    format!("https://www.bilibili.com{}{}", p.path, suffix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_short_and_shorts_and_watch() {
        assert_eq!(
            normalize("https://youtu.be/dQw4w9WgXcQ?si=abc"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        assert_eq!(
            normalize("https://www.youtube.com/shorts/aqz-KE-bpKQ"),
            "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
        );
        assert_eq!(
            normalize("https://m.youtube.com/watch?v=9bZkp7q19f0&feature=share&t=10"),
            "https://www.youtube.com/watch?v=9bZkp7q19f0"
        );
        assert_eq!(
            normalize("https://www.youtube.com/embed/abc123"),
            "https://www.youtube.com/watch?v=abc123"
        );
    }

    #[test]
    fn twitter_and_x_status() {
        assert_eq!(
            normalize("https://x.com/user/status/123?s=20"),
            "https://twitter.com/i/status/123"
        );
        assert_eq!(
            normalize("https://twitter.com/user/status/123"),
            "https://twitter.com/i/status/123"
        );
        assert_eq!(
            normalize("https://mobile.twitter.com/foo/status/9/photo/1"),
            "https://twitter.com/i/status/9"
        );
    }

    #[test]
    fn bilibili_keeps_bv() {
        assert_eq!(
            normalize("https://m.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.788"),
            "https://www.bilibili.com/video/BV1xx411c7mD"
        );
    }

    #[test]
    fn bilibili_keeps_page_selector() {
        // ?p=N picks a part of a multi-video collection — content, not tracking.
        assert_eq!(
            normalize("https://www.bilibili.com/video/BV1xx411c7mD?p=3&vd_source=abc&spm_id_from=333"),
            "https://www.bilibili.com/video/BV1xx411c7mD?p=3"
        );
    }

    #[test]
    fn bilibili_short_link_left_for_resolver() {
        // b23.tv codes can only be expanded by following the redirect (yt-dlp does
        // that): don't rewrite the host/path, just strip tracking from the query.
        assert_eq!(
            normalize("https://b23.tv/AbCdEf?share_source=copy_web"),
            "https://b23.tv/AbCdEf"
        );
    }

    #[test]
    fn youtube_live_becomes_watch() {
        assert_eq!(
            normalize("https://www.youtube.com/live/abc123?si=xyz&feature=share"),
            "https://www.youtube.com/watch?v=abc123"
        );
    }

    #[test]
    fn instagram_and_reddit_drop_query() {
        assert_eq!(
            normalize("https://www.instagram.com/reel/Cabc123/?igshid=abc&utm_source=ig_web"),
            "https://www.instagram.com/reel/Cabc123/"
        );
        assert_eq!(
            normalize("https://www.reddit.com/r/videos/comments/xyz/title/?share_id=abc"),
            "https://www.reddit.com/r/videos/comments/xyz/title/"
        );
    }

    #[test]
    fn generic_strips_modern_ad_trackers() {
        assert_eq!(
            normalize("https://example.com/watch?id=5&fbclid=x&gclid=y&mc_eid=z"),
            "https://example.com/watch?id=5"
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
        assert_eq!(
            normalize("https://example.com/v?utm_medium=a"),
            "https://example.com/v"
        );
        // No query, unknown host → untouched (but trailing punctuation stripped).
        assert_eq!(
            normalize("https://example.com/video/1)."),
            "https://example.com/video/1"
        );
    }

    #[test]
    fn unparseable_returned_as_is() {
        assert_eq!(normalize("not a url"), "not a url");
        assert_eq!(normalize("  spaced  "), "spaced");
    }
}
