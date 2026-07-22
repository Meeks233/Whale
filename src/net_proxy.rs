//! Loopback HTTP proxy that puts `yt-dlp` behind our resolver.
//!
//! yt-dlp is a separate process with its own DNS stack: it has no flag for a
//! custom resolver, so neither our DoH answers nor the rebinding fix in
//! [`crate::net_guard`] reach it. What it *does* have is `--proxy`. So when DoH
//! is in use we run a minimal proxy on loopback and point yt-dlp at it — every
//! connection it makes is then resolved by [`net_guard::resolve_checked`], which
//! means yt-dlp gets the DoH answer (the point, on a network whose local DNS is
//! poisoned) and cannot be aimed at an internal address by a rebinding answer
//! (the bonus).
//!
//! Deliberately minimal: `CONNECT` tunnels, which is what every `https://` fetch
//! and fragment uses, plus absolute-form plain HTTP as a safety net. No caching,
//! no rewriting, no inspection — the bytes pass through untouched, so TLS (and
//! `--impersonate`'s fingerprint) is end-to-end exactly as without us.
//!
//! Only started in [`DnsMode::Doh`]. Under a fake-IP proxy or the plain system
//! resolver there is nothing to gain — yt-dlp's own resolver already agrees with
//! ours — so it stays off and yt-dlp runs exactly as it did before.

use crate::net_guard::{self, DnsMode};
use std::net::SocketAddr;
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// How long a proxied connection may take to establish upstream.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// Cap on the request head we buffer before giving up on a malformed client.
const MAX_HEAD: usize = 16 * 1024;

static PROXY_URL: OnceLock<String> = OnceLock::new();

/// `http://127.0.0.1:<port>` once [`start`] has brought the proxy up, else
/// `None` — which is the signal to leave yt-dlp's networking alone.
pub fn url() -> Option<&'static str> {
    PROXY_URL.get().map(String::as_str)
}

/// Bring the proxy up if this process resolves over DoH. Returns its URL, or
/// `None` when it isn't wanted (any other DNS mode) or couldn't bind — a proxy
/// we failed to start must not silently become a proxy yt-dlp can't reach.
pub async fn start(allow_private_dns: bool) -> Option<&'static str> {
    if allow_private_dns || !matches!(net_guard::mode().await, DnsMode::Doh(_)) {
        return None;
    }
    // Loopback only: this proxy resolves whatever it's asked to, so it must not
    // be reachable from off-box.
    let listener = match TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("DNS: could not start the yt-dlp proxy ({e}); yt-dlp will use its own resolver");
            return None;
        }
    };
    let port = listener.local_addr().ok()?.port();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((client, _)) => {
                    tokio::spawn(async move {
                        if let Err(e) = serve_conn(client).await {
                            tracing::debug!("yt-dlp proxy connection ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    tracing::warn!("yt-dlp proxy accept failed: {e}");
                    return;
                }
            }
        }
    });
    let url = PROXY_URL.get_or_init(|| format!("http://127.0.0.1:{port}"));
    tracing::info!("DNS: yt-dlp routed through the guarded proxy on {url}");
    Some(url)
}

async fn serve_conn(mut client: TcpStream) -> std::io::Result<()> {
    let (head, rest) = read_head(&mut client).await?;
    let request_line = head.lines().next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let (method, target) = match (parts.next(), parts.next()) {
        (Some(m), Some(t)) => (m.to_string(), t.to_string()),
        _ => return reply(&mut client, "400 Bad Request").await,
    };

    if method.eq_ignore_ascii_case("CONNECT") {
        // `CONNECT host:port` — the browser/yt-dlp form for everything https.
        let Some((host, port)) = split_authority(&target, 443) else {
            return reply(&mut client, "400 Bad Request").await;
        };
        let mut upstream = match dial(&host, port).await {
            Ok(s) => s,
            Err(e) => return reply(&mut client, e).await,
        };
        client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await?;
        // `rest` is whatever the client pipelined after the head — for CONNECT
        // that is already tunnel payload, so it belongs upstream first.
        if !rest.is_empty() {
            upstream.write_all(&rest).await?;
        }
        tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
        return Ok(());
    }

    // Absolute-form plain HTTP: `GET http://host/path HTTP/1.1`.
    let Some(after_scheme) = target.strip_prefix("http://") else {
        return reply(&mut client, "400 Bad Request").await;
    };
    let split = after_scheme.find('/').unwrap_or(after_scheme.len());
    let (authority, path) = after_scheme.split_at(split);
    let Some((host, port)) = split_authority(authority, 80) else {
        return reply(&mut client, "400 Bad Request").await;
    };
    let mut upstream = match dial(&host, port).await {
        Ok(s) => s,
        Err(e) => return reply(&mut client, e).await,
    };
    // Rewrite to origin-form and force a single exchange per connection: a
    // pooled client may reuse one proxy connection for a *different* host, and
    // this proxy has already committed to an upstream.
    let forwarded = rewrite_head(&head, &method, if path.is_empty() { "/" } else { path });
    upstream.write_all(forwarded.as_bytes()).await?;
    if !rest.is_empty() {
        upstream.write_all(&rest).await?;
    }
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

/// Resolve through the guard and connect. The `Err` is the status line to send
/// back, so a refusal reads as a proxy error rather than a hang.
async fn dial(host: &str, port: u16) -> Result<TcpStream, &'static str> {
    let ips = net_guard::resolve_checked(host)
        .await
        .map_err(|_| "403 Forbidden")?;
    let addrs: Vec<SocketAddr> = ips.into_iter().map(|ip| SocketAddr::new(ip, port)).collect();
    match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addrs[..])).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(_)) => Err("502 Bad Gateway"),
        Err(_) => Err("504 Gateway Timeout"),
    }
}

async fn reply(client: &mut TcpStream, status: &str) -> std::io::Result<()> {
    client
        .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
        .await
}

/// Read up to and including the blank line that ends the request head. Returns
/// the head and any bytes read past it.
async fn read_head(client: &mut TcpStream) -> std::io::Result<(String, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let n = client.read(&mut chunk).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "client closed before sending a request",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = find_head_end(&buf) {
            let rest = buf.split_off(end);
            return Ok((String::from_utf8_lossy(&buf).into_owned(), rest));
        }
        if buf.len() > MAX_HEAD {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "request head too large",
            ));
        }
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// `host:port` / bare `host` / `[v6]:port`, with `default_port` when absent.
fn split_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    let authority = authority.trim();
    if let Some(after) = authority.strip_prefix('[') {
        let end = after.find(']')?;
        let host = &after[..end];
        let port = match after[end + 1..].strip_prefix(':') {
            Some(p) => p.parse().ok()?,
            None => default_port,
        };
        return (!host.is_empty()).then(|| (host.to_string(), port));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (authority, default_port),
    };
    (!host.is_empty()).then(|| (host.to_string(), port))
}

/// Swap the absolute-form target for origin-form and pin the connection to one
/// exchange. Header values are otherwise passed through byte for byte.
fn rewrite_head(head: &str, method: &str, path: &str) -> String {
    let mut out = String::with_capacity(head.len());
    let mut lines = head.split("\r\n");
    let version = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(2))
        .unwrap_or("HTTP/1.1");
    out.push_str(&format!("{method} {path} {version}\r\n"));
    for line in lines {
        let name = line.split(':').next().unwrap_or("").trim();
        if name.eq_ignore_ascii_case("proxy-connection") || name.eq_ignore_ascii_case("connection") {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    // `split` left the trailing empty segment, so the head already ends blank;
    // insert Connection: close just before it.
    out.insert_str(out.len() - 2, "Connection: close\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_authority_handles_the_three_forms() {
        assert_eq!(
            split_authority("example.com:8443", 443),
            Some(("example.com".into(), 8443))
        );
        assert_eq!(
            split_authority("example.com", 80),
            Some(("example.com".into(), 80))
        );
        assert_eq!(
            split_authority("[2606:4700::1111]:443", 80),
            Some(("2606:4700::1111".into(), 443))
        );
        assert_eq!(
            split_authority("[2606:4700::1111]", 443),
            Some(("2606:4700::1111".into(), 443))
        );
        assert_eq!(split_authority("", 80), None);
        assert_eq!(split_authority("example.com:notaport", 80), None);
    }

    #[test]
    fn rewrite_head_produces_origin_form_and_one_exchange() {
        let head = "GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\n\
                    Proxy-Connection: keep-alive\r\nConnection: keep-alive\r\n\
                    User-Agent: yt-dlp\r\n\r\n";
        let out = rewrite_head(head, "GET", "/a?b=1");
        assert!(out.starts_with("GET /a?b=1 HTTP/1.1\r\n"));
        assert!(out.contains("Host: example.com\r\n"));
        assert!(out.contains("User-Agent: yt-dlp\r\n"));
        // The client's connection-reuse headers are replaced, not forwarded.
        assert!(!out.contains("keep-alive"));
        assert_eq!(out.matches("Connection: close").count(), 1);
        assert!(out.ends_with("Connection: close\r\n\r\n"));
    }

    #[test]
    fn head_end_is_the_blank_line() {
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n\r\nbody"), Some(18));
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n"), None);
    }

    /// The proxy must refuse to tunnel to an internal address even though the
    /// client asked nicely — this is the yt-dlp half of the SSRF guard.
    #[tokio::test]
    async fn connect_to_a_private_address_is_refused() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (client, _) = listener.accept().await.unwrap();
            let _ = serve_conn(client).await;
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n")
            .await
            .unwrap();
        let mut resp = String::new();
        client.read_to_string(&mut resp).await.unwrap();
        assert!(resp.starts_with("HTTP/1.1 403 Forbidden"), "{resp}");
    }

    /// A real tunnel, end to end: CONNECT through the proxy and complete a TLS
    /// handshake with the upstream. Cloudflare's trace endpoint reports the TLS
    /// version it saw, which also pins down that tunnelling doesn't downgrade
    /// anything — the bytes pass through, so the handshake is the client's and
    /// the origin's. `#[ignore]`d because it needs the network.
    #[tokio::test]
    #[ignore]
    async fn tunnels_a_real_request() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (client, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let _ = serve_conn(client).await;
                });
            }
        });

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://{addr}")).unwrap())
            .build()
            .unwrap();
        let resp = client
            .get("https://1.1.1.1/cdn-cgi/trace")
            .send()
            .await
            .unwrap();
        assert!(resp.status().is_success(), "{}", resp.status());
        let body = resp.text().await.unwrap();
        assert!(body.contains("tls=TLSv1.3"), "{body}");
    }
}
