//! SSRF guard for user-submitted URLs.
//!
//! Every download starts from a URL the client hands us, which we then pass to
//! `yt-dlp`. yt-dlp's generic extractor will HTTP-GET whatever it's given and
//! follow redirects — so without a guard an authenticated caller can aim the
//! server at cloud metadata (`169.254.169.254`), loopback, or RFC-1918 hosts,
//! or non-HTTP schemes like `file://`. This module rejects those before we ever
//! spawn yt-dlp.
//!
//! Two layers:
//! - [`precheck`] is pure: scheme allowlist + literal-IP / localhost rejection.
//! - [`guard`] adds a DNS-resolution pass so `http://internal-name/` is caught
//!   when it resolves into a forbidden range. Resolution *errors* fail open
//!   (yt-dlp couldn't reach it either); a successful resolution to any private
//!   address fails closed.
//!
//! Residual risk: DNS rebinding (yt-dlp re-resolves later) is not defended here;
//! that needs a pinning HTTP proxy and is out of scope for a self-hosted tool.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Why a URL was refused. Carries a stable, user-facing reason string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlRejection {
    /// Scheme is missing or not `http`/`https`.
    BadScheme,
    /// The authority had no usable host.
    BadHost,
    /// Host is (or resolves to) a private/loopback/link-local/etc. address.
    PrivateAddress,
}

impl UrlRejection {
    pub fn reason(self) -> &'static str {
        match self {
            UrlRejection::BadScheme => "url must use http or https",
            UrlRejection::BadHost => "url has no valid host",
            UrlRejection::PrivateAddress => {
                "url points at a private, loopback, or link-local address"
            }
        }
    }
}

/// Pure, DNS-free checks: enforce the scheme allowlist and reject literal
/// internal IPs / localhost. Returns the lowercased host on success (which may
/// be a hostname still needing DNS validation — see [`guard`]).
pub fn precheck(url: &str) -> Result<String, UrlRejection> {
    let (scheme, rest) = url.split_once("://").ok_or(UrlRejection::BadScheme)?;
    if !matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https") {
        return Err(UrlRejection::BadScheme);
    }

    // Authority ends at the first path/query/fragment delimiter.
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..auth_end];
    // Drop any `userinfo@`.
    let hostport = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);

    // Extract host, honoring `[ipv6]:port` bracket form.
    let host = if let Some(after) = hostport.strip_prefix('[') {
        let end = after.find(']').ok_or(UrlRejection::BadHost)?;
        &after[..end]
    } else {
        hostport.split(':').next().unwrap_or(hostport)
    };
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return Err(UrlRejection::BadHost);
    }

    // Loopback / mDNS names never resolve to anything we want to fetch.
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err(UrlRejection::PrivateAddress);
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_forbidden_ip(ip) {
            return Err(UrlRejection::PrivateAddress);
        }
    }

    Ok(host)
}

/// Full guard: [`precheck`], then resolve hostnames and reject if any resolved
/// address is in a forbidden range. Intended to run once at submit time.
pub async fn guard(url: &str) -> Result<(), UrlRejection> {
    let host = precheck(url)?;

    // Literal IPs were already classified in precheck.
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }

    // Resolve the name. Port is irrelevant to the address classification.
    let target = format!("{host}:0");
    match tokio::net::lookup_host(target).await {
        Ok(addrs) => {
            for addr in addrs {
                if is_forbidden_ip(addr.ip()) {
                    return Err(UrlRejection::PrivateAddress);
                }
            }
            Ok(())
        }
        // Couldn't resolve → yt-dlp can't reach it either; don't block on a
        // transient/offline DNS failure.
        Err(_) => Ok(()),
    }
}

/// True if `ip` is anything other than a routable public address: loopback,
/// private, link-local, CGNAT, multicast, reserved, documentation, etc.
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_v4(v4),
        IpAddr::V6(v6) => is_forbidden_v6(v6),
    }
}

fn is_forbidden_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_unspecified()          // 0.0.0.0
        || ip.is_loopback()      // 127.0.0.0/8
        || ip.is_private()       // 10/8, 172.16/12, 192.168/16
        || ip.is_link_local()    // 169.254.0.0/16 (incl. cloud metadata)
        || ip.is_broadcast()     // 255.255.255.255
        || ip.is_documentation() // 192.0.2/24, 198.51.100/24, 203.0.113/24
        || ip.is_multicast()     // 224.0.0.0/4
        || o[0] == 0             // 0.0.0.0/8 "this network"
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 CGNAT
        || (o[0] == 198 && (o[1] & 0xfe) == 18)  // 198.18.0.0/15 benchmarking
        || o[0] >= 240 // 240.0.0.0/4 reserved (240–255)
}

fn is_forbidden_v6(ip: Ipv6Addr) -> bool {
    // IPv4-mapped / -compatible addresses reuse the v4 classification.
    if let Some(v4) = ip.to_ipv4() {
        return is_forbidden_v4(v4);
    }
    let s = ip.segments();
    ip.is_unspecified()                    // ::
        || ip.is_loopback()                // ::1
        || ip.is_multicast()               // ff00::/8
        || (s[0] & 0xfe00) == 0xfc00       // fc00::/7 unique-local
        || (s[0] & 0xffc0) == 0xfe80       // fe80::/10 link-local
        || (s[0] == 0x2001 && s[1] == 0x0db8) // 2001:db8::/32 documentation
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn rejects_non_http_schemes() {
        for u in [
            "file:///etc/passwd",
            "ftp://ftp.example.com/x",
            "gopher://x/",
            "dict://localhost:11211/",
            "not a url",
            "//scheme-relative/x",
        ] {
            assert_eq!(precheck(u).unwrap_err(), UrlRejection::BadScheme, "{u}");
        }
    }

    #[test]
    fn rejects_internal_literal_ips_and_localhost() {
        for u in [
            "http://127.0.0.1/",
            "http://127.0.0.1:8090/admin",
            "https://10.0.0.5/",
            "http://192.168.1.1/",
            "http://172.16.9.9/",
            "http://169.254.169.254/latest/meta-data/", // cloud metadata
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[::1]:80/x",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://localhost/",
            "http://api.localhost/",
            "http://printer.local/",
            "http://user:pass@127.0.0.1/", // userinfo must not smuggle host
        ] {
            assert_eq!(precheck(u).unwrap_err(), UrlRejection::PrivateAddress, "{u}");
        }
    }

    #[test]
    fn allows_public_hosts() {
        for u in [
            "https://www.youtube.com/watch?v=abc",
            "http://8.8.8.8/",
            "https://1.1.1.1/",
            "https://[2606:4700:4700::1111]/",
            "https://example.com:8443/path?q=1",
        ] {
            assert!(precheck(u).is_ok(), "{u}");
        }
    }

    #[test]
    fn ipv4_mapped_v6_is_classified_as_v4() {
        assert!(is_forbidden_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(is_forbidden_ip("::ffff:10.0.0.1".parse().unwrap()));
        assert!(!is_forbidden_ip("::ffff:8.8.8.8".parse().unwrap()));
    }

    proptest! {
        // Every address in the RFC-1918 / loopback / link-local / CGNAT blocks
        // is forbidden regardless of the host octets.
        #[test]
        fn all_private_v4_forbidden(b in 0u8..=255, c in 0u8..=255, d in 0u8..=255) {
            prop_assert!(is_forbidden_v4(Ipv4Addr::new(10, b, c, d)));
            prop_assert!(is_forbidden_v4(Ipv4Addr::new(192, 168, c, d)));
            prop_assert!(is_forbidden_v4(Ipv4Addr::new(127, b, c, d)));
            prop_assert!(is_forbidden_v4(Ipv4Addr::new(169, 254, c, d)));
            prop_assert!(is_forbidden_v4(Ipv4Addr::new(100, 64 | (b & 0x3f), c, d)));
        }

        // 172.16.0.0/12 (second octet 16..=31) is forbidden; 172.32+ is public.
        #[test]
        fn v4_172_block_boundary(b in 0u8..=255, c in 0u8..=255, d in 0u8..=255) {
            let ip = Ipv4Addr::new(172, b, c, d);
            prop_assert_eq!(is_forbidden_v4(ip), (16..=31).contains(&b));
        }

        // A submitted URL whose host is any private literal is always rejected.
        #[test]
        fn precheck_rejects_private_urls(b in 0u8..=255, c in 0u8..=255, d in 0u8..=255) {
            let url = format!("http://10.{b}.{c}.{d}/path");
            prop_assert_eq!(precheck(&url).unwrap_err(), UrlRejection::PrivateAddress);
        }
    }
}
