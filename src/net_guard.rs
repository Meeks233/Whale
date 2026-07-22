//! SSRF guard for user-submitted URLs.
//!
//! Every download starts from a URL the client hands us, which we then pass to
//! `yt-dlp`. yt-dlp's generic extractor will HTTP-GET whatever it's given and
//! follow redirects — so without a guard an authenticated caller can aim the
//! server at cloud metadata (`169.254.169.254`), loopback, or RFC-1918 hosts,
//! or non-HTTP schemes like `file://`. This module rejects those before we ever
//! spawn yt-dlp.
//!
//! [`guard`] enforces a scheme allowlist, rejects literal internal addresses, and
//! resolves hostnames to reject internal DNS answers. Operators using a fake-IP
//! proxy can explicitly bypass only the DNS classification.
//!
//! # DNS rebinding
//!
//! A check-then-connect guard is a TOCTOU: the guard resolves a hostname, likes
//! the answer, and then the HTTP client resolves it *again* and gets whatever the
//! attacker's nameserver felt like returning the second time (`169.254.169.254`).
//! Closing that requires the connect-time resolution to be the checked one, so
//! this module owns both ends:
//!
//! - [`resolve_checked`] resolves over **Cloudflare DNS-over-HTTPS**
//!   (`https://1.1.1.1/dns-query`, authenticated by TLS and immune to a poisoned
//!   or hostile local resolver), rejects the host if *any* returned address is
//!   internal, and memoizes the surviving set under the answer's TTL.
//! - [`GuardedResolver`] is a `reqwest` DNS resolver backed by that same
//!   memo. Installed on the proxy client, it means the addresses hyper dials are
//!   the exact addresses the guard approved — one resolution, not two.
//!
//! The escape hatch (`allow_private_dns`, for fake-IP proxy setups) bypasses both
//! halves together and falls back to the system resolver.
//!
//! Caveat, deliberate: **`yt-dlp` resolves for itself.** It is a separate process
//! with its own DNS stack, so for submitted URLs the guard stays a pre-flight
//! check and the rebinding window remains open there. Pinning it would mean
//! teaching yt-dlp our resolver; the guard's job on that path is to reject the
//! obvious and the honest, not to be airtight.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

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
    let hostport = authority
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(authority);

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

/// Reject a URL that must not be fetched: a non-http(s) scheme, a literal
/// internal IP / localhost host, or a hostname that resolves to an internal
/// address. Returns the approved addresses, which [`GuardedResolver`] will hand
/// straight to the connector (empty when `allow_private_dns` waives the check).
pub async fn guard(url: &str, allow_private_dns: bool) -> Result<Vec<IpAddr>, UrlRejection> {
    let host = precheck(url)?;
    if allow_private_dns {
        return Ok(Vec::new());
    }
    resolve_checked(&host).await
}

/// Cloudflare's DoH endpoint, addressed by literal IP so resolving it needs no
/// resolver (and so a hostile local DNS can't redirect the resolver itself). The
/// certificate carries `1.1.1.1` as an IP SAN, so TLS still authenticates it.
const DOH_URL: &str = "https://1.1.1.1/dns-query";
/// Floor/ceiling on how long a DoH answer is trusted. The floor keeps a
/// 0-TTL answer from costing a DoH round trip per redirect hop; the ceiling keeps
/// a long TTL from outliving a legitimate address change.
const TTL_FLOOR: Duration = Duration::from_secs(10);
const TTL_CEIL: Duration = Duration::from_secs(300);
/// Entry cap for the memo; blown past only by a pathological redirect chain.
const CACHE_MAX: usize = 512;

/// host -> (approved addresses, when they stop being trusted).
type DnsCache = Mutex<HashMap<String, (Vec<IpAddr>, Instant)>>;

static CACHE: LazyLock<DnsCache> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The DoH client. Its own DNS is never exercised (literal-IP URL), so it can
/// safely use the default resolver without recursing into this module.
static DOH: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .ok()
});

/// Resolve `host` to the set of addresses it is allowed to be dialed at, or
/// reject it. Answers are memoized under their TTL so the guard's resolution and
/// the connector's resolution are the *same* resolution — see the module docs.
pub async fn resolve_checked(host: &str) -> Result<Vec<IpAddr>, UrlRejection> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match is_forbidden_ip(ip) {
            true => Err(UrlRejection::PrivateAddress),
            false => Ok(vec![ip]),
        };
    }
    if let Some(ips) = cache_get(host) {
        return Ok(ips);
    }

    let (ips, ttl) = match doh_resolve(host).await {
        Some(answer) => answer,
        // DoH unreachable (blocked egress, captive network). Falling back to the
        // system resolver keeps the downloader working; the address check below
        // still applies, we just lose DoH's integrity guarantee.
        None => {
            tracing::warn!(host, "DoH resolution failed, falling back to system resolver");
            let addrs = tokio::net::lookup_host((host, 0))
                .await
                .map_err(|_| UrlRejection::BadHost)?;
            (addrs.map(|a| a.ip()).collect(), TTL_FLOOR)
        }
    };

    if ips.is_empty() {
        return Err(UrlRejection::BadHost);
    }
    // All-or-nothing: one internal address in the answer condemns the host. A
    // partial accept would let an attacker mix a public address in to get past
    // the guard and still win the connect race.
    if ips.iter().any(|ip| is_forbidden_ip(*ip)) {
        return Err(UrlRejection::PrivateAddress);
    }
    cache_put(host, &ips, ttl);
    Ok(ips)
}

fn cache_get(host: &str) -> Option<Vec<IpAddr>> {
    let cache = CACHE.lock().ok()?;
    cache
        .get(host)
        .filter(|(_, expiry)| *expiry > Instant::now())
        .map(|(ips, _)| ips.clone())
}

fn cache_put(host: &str, ips: &[IpAddr], ttl: Duration) {
    let Ok(mut cache) = CACHE.lock() else { return };
    if cache.len() >= CACHE_MAX {
        let now = Instant::now();
        cache.retain(|_, (_, expiry)| *expiry > now);
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
    }
    cache.insert(host.to_string(), (ips.to_vec(), Instant::now() + ttl));
}

/// Ask Cloudflare for `host`'s A and AAAA records. `None` means the DoH
/// transport itself failed (caller falls back); `Some` with an empty vec means
/// Cloudflare answered and the name has no addresses.
async fn doh_resolve(host: &str) -> Option<(Vec<IpAddr>, Duration)> {
    let client = DOH.as_ref()?;
    let (a, aaaa) = tokio::join!(doh_query(client, host, 1), doh_query(client, host, 28));
    if a.is_none() && aaaa.is_none() {
        return None;
    }
    let mut ips = Vec::new();
    let mut ttl = TTL_CEIL;
    for (records, record_ttl) in [a, aaaa].into_iter().flatten() {
        ips.extend(records);
        ttl = ttl.min(record_ttl);
    }
    Some((ips, ttl.clamp(TTL_FLOOR, TTL_CEIL)))
}

/// One DoH query for a single record type, over the JSON API (`application/dns-json`)
/// so no wire-format DNS codec is needed. Returns the addresses and the smallest
/// TTL in the answer.
async fn doh_query(client: &reqwest::Client, host: &str, rtype: u16) -> Option<(Vec<IpAddr>, Duration)> {
    let resp = client
        .get(DOH_URL)
        .query(&[("name", host), ("type", &rtype.to_string())])
        .header(reqwest::header::ACCEPT, "application/dns-json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = serde_json::from_slice(&resp.bytes().await.ok()?).ok()?;
    let mut ips = Vec::new();
    let mut ttl = TTL_CEIL;
    // CNAME hops share the answer section; keep only records of the type asked
    // for, whose `data` is then always a bare address.
    for answer in body["Answer"].as_array().into_iter().flatten() {
        if answer["type"].as_u64() != Some(rtype as u64) {
            continue;
        }
        if let Some(ip) = answer["data"].as_str().and_then(|d| d.parse::<IpAddr>().ok()) {
            ips.push(ip);
            if let Some(secs) = answer["TTL"].as_u64() {
                ttl = ttl.min(Duration::from_secs(secs));
            }
        }
    }
    Some((ips, ttl))
}

/// `reqwest` DNS resolver that answers from [`resolve_checked`], so the addresses
/// hyper connects to are exactly the ones the guard approved. Install it on any
/// client that fetches user-influenced URLs.
pub struct GuardedResolver {
    allow_private_dns: bool,
}

impl GuardedResolver {
    pub fn new(allow_private_dns: bool) -> Arc<Self> {
        Arc::new(Self { allow_private_dns })
    }
}

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_ascii_lowercase();
        let allow_private_dns = self.allow_private_dns;
        Box::pin(async move {
            if allow_private_dns {
                let addrs: Vec<SocketAddr> =
                    tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
                return Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs);
            }
            let ips = resolve_checked(&host)
                .await
                .map_err(|r| std::io::Error::other(r.reason()))?;
            // Port 0: reqwest substitutes the URL's port, or the scheme default.
            Ok(Box::new(ips.into_iter().map(|ip| SocketAddr::new(ip, 0))) as reqwest::dns::Addrs)
        })
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
            assert_eq!(
                precheck(u).unwrap_err(),
                UrlRejection::PrivateAddress,
                "{u}"
            );
        }
    }

    #[tokio::test]
    async fn guard_resolves_hosts_and_keeps_compatibility_escape_hatch() {
        assert!(guard("https://1.1.1.1/x", false).await.is_ok());
        assert!(guard("https://example.com/x", true).await.is_ok());
        assert_eq!(
            guard("http://127.0.0.1/", false).await.unwrap_err(),
            UrlRejection::PrivateAddress
        );
        assert_eq!(
            guard("file:///etc/passwd", false).await.unwrap_err(),
            UrlRejection::BadScheme
        );
    }

    #[tokio::test]
    async fn resolve_checked_classifies_literal_hosts_without_dns() {
        assert_eq!(
            resolve_checked("8.8.8.8").await.unwrap(),
            vec!["8.8.8.8".parse::<IpAddr>().unwrap()]
        );
        assert_eq!(
            resolve_checked("169.254.169.254").await.unwrap_err(),
            UrlRejection::PrivateAddress
        );
    }

    /// Live DoH check — `#[ignore]`d because it needs the network. Run with
    /// `cargo test -- --ignored resolves_over_doh`.
    ///
    /// The rebinding case: `127.0.0.1.nip.io` is a *public* name whose A record
    /// is loopback, i.e. exactly the answer a rebinding attacker returns. Only a
    /// resolving guard catches it.
    #[tokio::test]
    #[ignore]
    async fn resolves_over_doh() {
        assert_eq!(
            resolve_checked("127.0.0.1.nip.io").await.unwrap_err(),
            UrlRejection::PrivateAddress
        );
        let ips = resolve_checked("www.youtube.com").await.unwrap();
        assert!(!ips.is_empty());
        assert!(ips.iter().all(|ip| !is_forbidden_ip(*ip)));
    }

    // A cached answer is what both the guard and the connector read, so an entry
    // must survive until its TTL and never outlive it.
    #[test]
    fn cache_honors_ttl() {
        let public: Vec<IpAddr> = vec!["9.9.9.9".parse().unwrap()];
        cache_put("fresh.test", &public, Duration::from_secs(60));
        cache_put("stale.test", &public, Duration::from_millis(0));
        assert_eq!(cache_get("fresh.test"), Some(public));
        assert_eq!(cache_get("stale.test"), None);
        assert_eq!(cache_get("never-inserted.test"), None);
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
