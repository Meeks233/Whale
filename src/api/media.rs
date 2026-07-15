//! Media file streaming — range-capable playback + download. See docs/API.md.
//!
//! Two entry points:
//! - `GET /api/items/:id/file` — **token-required**, by sequential id (owner use).
//! - `GET /api/p/:slug` — **tokenless**, by the item's random public slug, and
//!   only while it is still flagged `public`. The slug is unguessable, so public
//!   items can't be discovered by enumerating ids.
//!
//! Serving is delegated to `tower_http::services::ServeFile`, which handles
//! Range/HEAD/Content-Type.

use super::AppState;
use crate::error::AppError;
use crate::types::Item;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use std::path::Path as FsPath;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// Browser-like UA for proxied upstream fetches. Some CDNs (X's `video.twimg.com`)
/// serve differently to a default library UA; matching a real browser keeps the
/// bytes flowing the same way they would in a normal player.
const PROXY_UA: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// GET /api/items/:id/file — stream by id. Requires a valid token (header or
/// `?token=`). Add `?download=1` to force a download (Content-Disposition).
pub async fn file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    req: Request,
) -> Result<Response, AppError> {
    let query = req.uri().query().unwrap_or("").to_string();
    let token = super::auth::extract_token(req.headers(), &query);
    if !token
        .as_deref()
        .is_some_and(|t| super::auth::ct_eq(t, &state.cfg.token))
    {
        return Err(AppError::Unauthorized);
    }
    let item = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    serve_item(&state.cfg.download_dir, item, req).await
}

/// GET /api/p/:slug — tokenless public stream, keyed by the item's random slug.
/// 404 if the slug is unknown or the item is no longer public.
pub async fn public_file(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    req: Request,
) -> Result<Response, AppError> {
    let item = state
        .db
        .find_by_public_slug(&slug)
        .await?
        .ok_or(AppError::NotFound)?;
    // Enforce expiry: a lapsed share 404s even before the periodic sweep runs.
    // Lazily flip it private on access so the DB record reflects reality.
    if item.public && !crate::types::is_public_live(&item) {
        let _ = state.db.set_public(item.id, false, None).await;
    }
    if !crate::types::is_public_live(&item) {
        return Err(AppError::NotFound);
    }
    // Tally external access so the owner can spot an abused link. Count a fresh
    // load or download once; skip seek/range continuations (a single video play
    // fires many partial requests) so the number tracks views, not chunks.
    // Best-effort: a DB failure here must not block serving.
    if is_fresh_access(&req) {
        let _ = state.db.bump_public_hits(item.id).await;
    }
    serve_item(&state.cfg.download_dir, item, req).await
}

/// True when a public request is a fresh load rather than a range continuation:
/// no `Range` header (download / initial fetch) or a range that starts at byte
/// 0 (the first request a media element makes). Later chunks (`bytes=N-`, N>0)
/// don't recount the same view.
fn is_fresh_access(req: &Request) -> bool {
    match req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        None => true,
        Some(r) => r.trim().replace(' ', "").starts_with("bytes=0-"),
    }
}

/// GET /api/stream/:slug — **online playback proxy** (token-required).
///
/// Keyed by the item's unguessable random slug — the same scheme share links use
/// — never the sequential id, so the URL can't be used to enumerate other items
/// (`/api/items/2/stream`, `/api/items/3/stream`, …). The slug is owner-only
/// (it's returned only in the authenticated item payload) and the endpoint still
/// requires the token, so this is not a public capability like `/api/p/:slug`.
///
/// Resolves the upstream media URL with yt-dlp (carrying the platform cookies),
/// then fetches it *from this server* and streams the bytes back to the client.
/// This is the fix for stale online X/Twitter playback: the CDN URL yt-dlp hands
/// back is signed for this server's IP and expects the session cookies, so a
/// browser fetching it directly gets a stale/forbidden response. Proxying keeps
/// the fetch on the IP and session that resolved it.
///
/// The client's `Range` header is forwarded so the `<video>` can seek, and the
/// upstream's `Content-Type`/`Content-Length`/`Content-Range`/`Accept-Ranges`
/// are mirrored back so the media element plays exactly as it would from source.
pub async fn stream(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    req: Request,
) -> Result<Response, AppError> {
    let query = req.uri().query().unwrap_or("").to_string();
    let token = super::auth::extract_token(req.headers(), &query);
    if !token
        .as_deref()
        .is_some_and(|t| super::auth::ct_eq(t, &state.cfg.token))
    {
        return Err(AppError::Unauthorized);
    }
    let item = state.db.find_by_public_slug(&slug).await?.ok_or(AppError::NotFound)?;
    // Defense in depth: re-validate the stored page URL before yt-dlp fetches it.
    crate::net_guard::guard(&item.webpage_url).map_err(|r| AppError::BadRequest(r.reason().into()))?;
    let cookie = crate::cookies::resolve(&state.cookies, state.cfg.cookies.as_deref(), &item.webpage_url);
    let upstream =
        crate::ytdlp::resolve_stream_url(&state.cfg, &item.webpage_url, cookie.as_deref(), item.playlist_index)
            .await
            .map_err(|e| AppError::Internal(format!("stream url resolve failed: {e}")))?;
    // The resolved CDN URL is now our fetch target — guard it too so a poisoned
    // row can't make the *server* fetch an internal address (SSRF).
    crate::net_guard::guard(&upstream).map_err(|r| AppError::BadRequest(r.reason().into()))?;

    let host = crate::net_guard::precheck(&upstream)
        .map_err(|r| AppError::BadRequest(r.reason().into()))?;
    let cookie_header = cookie_header_for(cookie.as_deref(), &host);
    let range = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    proxy_upstream(&upstream, &item.webpage_url, cookie_header, range).await
}

/// Fetch `upstream` from this server and stream it back to the client, mirroring
/// the headers a `<video>` needs to play and seek. `referer` is the original
/// page URL (some CDNs gate on it); `cookie_header`, if present, carries the
/// session for cookie-gated media.
async fn proxy_upstream(
    upstream: &str,
    referer: &str,
    cookie_header: Option<String>,
    range: Option<String>,
) -> Result<Response, AppError> {
    let client = reqwest::Client::builder()
        // Follow CDN redirects, but never into an internal address (SSRF).
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if let Some(host) = attempt.url().host_str() {
                if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                    if crate::net_guard::is_forbidden_ip(ip) {
                        return attempt.error("redirect to forbidden address");
                    }
                }
            }
            if attempt.previous().len() >= 5 {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| AppError::Internal(format!("http client build failed: {e}")))?;

    let mut rb = client
        .get(upstream)
        .header(reqwest::header::USER_AGENT, PROXY_UA)
        .header(reqwest::header::REFERER, referer);
    if let Some(c) = cookie_header {
        rb = rb.header(reqwest::header::COOKIE, c);
    }
    if let Some(r) = &range {
        rb = rb.header(reqwest::header::RANGE, r.clone());
    }

    let resp = rb
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("upstream fetch failed: {e}")))?;

    let status = resp.status();
    let mut builder = Response::builder().status(status.as_u16());
    // Mirror only the headers a media element needs — copying blindly risks
    // forwarding hop-by-hop or CORS headers that fight our own response.
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
        header::CACHE_CONTROL,
    ] {
        if let Some(v) = resp.headers().get(&name) {
            if let Ok(s) = v.to_str() {
                builder = builder.header(name, s);
            }
        }
    }
    let body = Body::from_stream(resp.bytes_stream());
    builder
        .body(body)
        .map(IntoResponse::into_response)
        .map_err(|e| AppError::Internal(format!("proxy response build failed: {e}")))
}

/// Build a `Cookie:` header for a proxied request to `host` from a Netscape
/// `cookies.txt`, so the upstream fetch carries the same session the download
/// used. Only cookies whose domain matches `host` are included (`.x.com` matches
/// `x.com` and `video.x.com`); everything else is left out so unrelated cookies
/// never leak to a CDN. Returns `None` when there is no file or no match.
fn cookie_header_for(cookie_file: Option<&FsPath>, host: &str) -> Option<String> {
    let text = std::fs::read_to_string(cookie_file?).ok()?;
    let host = host.to_ascii_lowercase();
    let mut pairs = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            continue;
        }
        let domain = f[0].trim_start_matches('.').to_ascii_lowercase();
        if domain.is_empty() {
            continue;
        }
        let matches = host == domain || host.ends_with(&format!(".{domain}"));
        if matches {
            pairs.push(format!("{}={}", f[5], f[6]));
        }
    }
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

/// Stream `item`'s file, honoring `?download=1` for an attachment disposition.
/// `root` is the configured download directory: the file is served only if it
/// canonicalizes to a real file inside it (path-traversal guard).
async fn serve_item(root: &FsPath, item: Item, req: Request) -> Result<Response, AppError> {
    let query = req.uri().query().unwrap_or("").to_string();
    let stored = match item.filepath.as_deref() {
        Some(p) if !p.is_empty() => p,
        _ => return Err(AppError::BadRequest("item has no downloaded file".into())),
    };
    // Confine to the download root: rejects `..`, absolute paths elsewhere, and
    // symlinks escaping the root (e.g. an imported Seal `videoPath` of /etc/passwd).
    let path = crate::safepath::confined_file(root, stored).ok_or(AppError::NotFound)?;

    let download = query.split('&').any(|p| p == "download=1");

    // ServeFile consumes the request (for its Range/If-* headers) and never errors.
    let served = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map_err(|_| AppError::Internal("file serve failed".into()))?;

    let (mut parts, body) = served.into_parts();
    if download {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if let Ok(val) = content_disposition(name).parse() {
                parts.headers.insert(header::CONTENT_DISPOSITION, val);
            }
        }
    }
    Ok(Response::from_parts(parts, Body::new(body)).into_response())
}

/// Build an attachment `Content-Disposition` with an RFC 5987 UTF-8 filename so
/// non-ASCII titles (CJK, emoji) survive intact.
fn content_disposition(name: &str) -> String {
    format!("attachment; filename*=UTF-8''{}", percent_encode(name))
}

/// Percent-encode everything outside the RFC 5987 `attr-char` set.
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let unreserved = b.is_ascii_alphanumeric()
            || matches!(b, b'-' | b'.' | b'_' | b'~' | b'!' | b'#' | b'$' | b'&' | b'+');
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_unicode_filename() {
        let d = content_disposition("朱炙 video [id].mkv");
        assert!(d.starts_with("attachment; filename*=UTF-8''"));
        assert!(!d.contains(' ') || d.contains("%20"));
        // ASCII-safe chars stay literal; spaces and CJK are percent-encoded.
        assert!(d.contains("%20"));
        assert!(d.contains(".mkv") || d.contains("mkv"));
    }

    #[test]
    fn ascii_filename_round_trips() {
        let d = content_disposition("Video-01_final.mp4");
        assert_eq!(d, "attachment; filename*=UTF-8''Video-01_final.mp4");
    }

    fn write_cookies(body: &str) -> tempfile::NamedTempFile {
        use std::io::Write;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(body.as_bytes()).unwrap();
        f
    }

    #[test]
    fn cookie_header_matches_domain_and_subdomain() {
        // A `.x.com` cookie applies to x.com and its CDN subdomains, not to an
        // unrelated host. Auth_token must ride to the upstream fetch.
        let f = write_cookies(
            "# Netscape HTTP Cookie File\n\
             .x.com\tTRUE\t/\tTRUE\t0\tauth_token\tSECRET\n\
             .x.com\tTRUE\t/\tTRUE\t0\tct0\tCSRF\n\
             .other.com\tTRUE\t/\tFALSE\t0\tnope\tXXX\n",
        );
        let h = cookie_header_for(Some(f.path()), "video.x.com").unwrap();
        assert!(h.contains("auth_token=SECRET"));
        assert!(h.contains("ct0=CSRF"));
        // Cookies for an unrelated domain never leak to this host.
        assert!(!h.contains("nope"));
    }

    #[test]
    fn cookie_header_none_when_no_match_or_no_file() {
        let f = write_cookies(
            "# Netscape HTTP Cookie File\n.x.com\tTRUE\t/\tTRUE\t0\tauth_token\tSECRET\n",
        );
        // Host belongs to a different site → no cookies selected.
        assert!(cookie_header_for(Some(f.path()), "youtube.com").is_none());
        // No file at all → None.
        assert!(cookie_header_for(None, "video.x.com").is_none());
    }
}
