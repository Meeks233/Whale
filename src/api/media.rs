//! Media file streaming — range-capable playback + download. See docs/API.md.
//!
//! Two entry points:
//! - `GET /api/items/:slug/file` — **token-required**, by private random slug.
//! - `GET /api/p/:slug` — **tokenless**, by the item's random public slug, and
//!   only while it is still flagged `public`. The slug is unguessable, so public
//!   items can't be discovered by enumerating ids.
//!
//! Serving is delegated to `tower_http::services::ServeFile`, which handles
//! Range/HEAD/Content-Type.

use super::{emedia, AppState};
use crate::error::AppError;
use crate::types::{Item, Status};
use axum::body::{Body, Bytes};
use futures::StreamExt;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::header;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use std::net::SocketAddr;
use std::path::Path as FsPath;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// Peer IP from the connect-info extension, for the loopback plaintext fallback.
fn peer_ip(req: &Request) -> Option<std::net::IpAddr> {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip())
}

/// Browser-like UA for proxied upstream fetches. Some CDNs (X's `video.twimg.com`)
/// serve differently to a default library UA; matching a real browser keeps the
/// bytes flowing the same way they would in a normal player.
const PROXY_UA: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// Redirect hops allowed on a proxied upstream fetch before giving up.
const MAX_REDIRECTS: u32 = 5;

/// GET /api/items/:slug/file — stream by private slug. Requires a valid token (header or
/// `?token=`). Add `?download=1` to force a download (Content-Disposition).
pub async fn file(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    req: Request,
) -> Result<Response, AppError> {
    let query = req.uri().query().unwrap_or("").to_string();
    let path = req.uri().path().to_string();
    let session_key =
        super::auth::authenticate_media(&state, req.headers(), &query, peer_ip(&req), &path).await?;
    let item = state
        .db
        .find_by_slug(&slug)
        .await?
        .ok_or(AppError::NotFound)?;
    match session_key {
        // Secure channel: seal the file's bytes for the Service Worker to decrypt.
        Some(key) => {
            ensure_media_ready(item.status)?;
            let file_path = resolve_local_file(&state.cfg.download_dir, &item)?;
            let range = req
                .headers()
                .get(crate::e2ee::HEADER_RANGE_REQ)
                .and_then(|v| v.to_str().ok());
            emedia::serve_file(&key, &format!("file:{slug}"), &file_path, range).await
        }
        // Loopback plaintext fallback (local curl/download): serve the file directly.
        None => serve_item(&state.cfg.download_dir, item, req).await,
    }
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
    ensure_media_ready(item.status)?;
    // Tally external access so the owner can spot an abused link. Count a fresh
    // load or download once; skip seek/range continuations (a single video play
    // fires many partial requests) so the number tracks views, not chunks.
    // Best-effort: a DB failure here must not block serving.
    if is_fresh_access(&req) {
        let _ = state.db.bump_public_hits(item.id).await;
    }
    serve_item(
        &state.cfg.download_dir,
        cap_for_sharing(&state, item).await,
        req,
    )
    .await
}

/// Point an item at the copy a *share* link should serve: the tallest downloaded
/// variant within the effective `stream_quality` cap (per-site, else global).
///
/// Only public sharing goes through here. The owner's own playback and downloads
/// (`/api/items/:slug/file`) keep serving the primary — this cap exists to bound
/// what strangers cost the operator in upstream bandwidth, not to degrade the
/// library for the person who downloaded it.
///
/// Best-effort by design: if the variant lookup fails or the item has no recorded
/// variants (an imported or pre-0011 row), the item is returned untouched and the
/// primary is served. A share link must not 404 over a bandwidth preference.
async fn cap_for_sharing(state: &AppState, mut item: Item) -> Item {
    let variants = match state.db.list_resolutions(item.id).await {
        Ok(v) if !v.is_empty() => v,
        _ => return item,
    };
    let sites = state.db.list_websites().await.unwrap_or_default();
    let quality = crate::queue::resolve_stream_quality(&state.db, &sites, &item.webpage_url).await;
    if let Some(pick) = quality.pick(&variants) {
        item.filepath = Some(pick.filepath.clone());
        item.filesize = Some(pick.filesize);
        item.height = Some(pick.height);
    }
    item
}

/// True when a public request is a fresh load rather than a range continuation:
/// no `Range` header (download / initial fetch) or a range that starts at byte
/// 0 (the first request a media element makes). Later chunks (`bytes=N-`, N>0)
/// don't recount the same view.
fn is_fresh_access(req: &Request) -> bool {
    match req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
    {
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
    let path = req.uri().path().to_string();
    let session_key =
        super::auth::authenticate_media(&state, req.headers(), &query, peer_ip(&req), &path).await?;
    let (item, upstream, cookie) = resolve_stream_target(&state, &slug, height_param(&query)).await?;
    let cookie_header = cookie_header_for(cookie.as_deref(), &upstream);

    match session_key {
        // Secure channel: proxy the upstream window and seal it for the SW.
        Some(key) => {
            let range = req
                .headers()
                .get(crate::e2ee::HEADER_RANGE_REQ)
                .and_then(|v| v.to_str().ok());
            stream_encrypted(
                &key,
                &slug,
                &upstream,
                &item.webpage_url,
                cookie_header,
                range,
                state.cfg.allow_private_dns,
            )
            .await
        }
        // Loopback plaintext fallback: stream the bytes through directly.
        None => {
            let range = req
                .headers()
                .get(header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            // `proxy_upstream` guards the CDN URL and every redirect hop, so a
            // poisoned row can't make the *server* fetch an internal address.
            proxy_upstream(
                &upstream,
                &item.webpage_url,
                cookie_header,
                range,
                state.cfg.allow_private_dns,
                stream_pacing(&item),
            )
            .await
        }
    }
}

/// Proxy one plaintext window of an upstream stream and seal it under the media
/// stream key. A single ranged upstream fetch buffers the window (≤ ~1 MiB) and
/// its `Content-Range` reveals the total length, which lets the Service Worker
/// bound seeks — so cloud playback stays seekable end-to-end encrypted, the same
/// as a downloaded file.
async fn stream_encrypted(
    session_key: &[u8; 32],
    slug: &str,
    upstream: &str,
    referer: &str,
    cookie_header: Option<String>,
    range: Option<&str>,
    allow_private_dns: bool,
) -> Result<Response, AppError> {
    let p = crate::e2ee::MEDIA_CHUNK as u64;
    let (start, end) = range.and_then(emedia::parse_range).unwrap_or((0, None));
    let i0 = start / p;
    let read_start = i0 * p;
    // Fetch a full window from the chunk-aligned start; the upstream caps it at EOF.
    let window_bytes = super::emedia::WINDOW_MAX_BYTES;
    let fetch_range = format!("bytes={}-{}", read_start, read_start + window_bytes as u64 - 1);
    let (slab, total) = fetch_upstream_window(
        upstream,
        referer,
        cookie_header,
        &fetch_range,
        allow_private_dns,
        window_bytes,
    )
    .await?;
    let plain_len = total.unwrap_or(read_start + slab.len() as u64);
    let resource = format!("stream:{slug}");
    // Seek at/past EOF (or an upstream reporting a total below the window start):
    // report the size so the SW can re-clamp, but seal no chunks. Going through
    // `serve_window` with a zero-length window instead would ask the sealer to
    // index a chunk that lies beyond `plain_len` entirely.
    let Some(w) = emedia::plan(plain_len, start, end) else {
        return emedia::serve_empty(plain_len, i0);
    };
    let needed = (w.read_end - w.read_start) as usize;
    if slab.len() < needed {
        return Err(AppError::Internal("upstream returned a short window".into()));
    }
    emedia::serve_window(session_key, &resource, plain_len, &w, &slab[..needed])
}

/// Resolve and cache an online stream URL without fetching media bytes. The UI
/// calls this for a small number of visible cloud items so the later video GET
/// can start from the warm cache instead of waiting on a fresh Python process.
pub async fn prepare_stream(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    req: Request,
) -> Result<StatusCode, AppError> {
    let query = req.uri().query().unwrap_or("").to_string();
    let path = req.uri().path().to_string();
    // Auth only — no body is returned, so nothing to encrypt.
    super::auth::authenticate_media(&state, req.headers(), &query, peer_ip(&req), &path).await?;
    let _ = resolve_stream_target(&state, &slug, height_param(&query)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The optional `?h=<pixels>` streaming resolution cap the player appends. Any
/// non-positive or unparsable value means "no cap" (serve the best stream).
fn height_param(query: &str) -> Option<i64> {
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix("h="))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|h| *h > 0)
}

async fn resolve_stream_target(
    state: &AppState,
    slug: &str,
    max_height: Option<i64>,
) -> Result<(Item, String, Option<std::path::PathBuf>), AppError> {
    let item = state
        .db
        .find_by_slug(slug)
        .await?
        .ok_or(AppError::NotFound)?;
    ensure_streamable(item.status)?;
    // Defense in depth: re-validate the stored page URL before yt-dlp fetches it.
    crate::net_guard::guard(&item.webpage_url, state.cfg.allow_private_dns)
        .await
        .map_err(|r| AppError::BadRequest(r.reason().into()))?;
    let cookie = crate::cookies::resolve(
        &state.cookies,
        state.cfg.cookies.as_deref(),
        &item.webpage_url,
    );
    let upstream = state
        .stream_urls
        .resolve(
            // Fold the cap into the cache key so a 720p and a 1080p resolve of the
            // same item don't clobber each other's cached upstream URL.
            &format!("{slug}@{}", max_height.unwrap_or(0)),
            &state.cfg,
            &item.webpage_url,
            cookie.as_deref(),
            item.playlist_index,
            max_height,
        )
        .await
        .map_err(|e| AppError::Internal(format!("stream url resolve failed: {e}")))?;
    Ok((item, upstream, cookie))
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
    allow_private_dns: bool,
    pacing: Option<(u64, u64)>,
) -> Result<Response, AppError> {
    let resp = guarded_get(
        upstream,
        referer,
        cookie_header.as_deref(),
        range.as_deref(),
        allow_private_dns,
    )
    .await?;

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
    // Pace the egress: an initial burst so the player buffers and starts instantly,
    // then a throttle to a small multiple of the clip's real bitrate. A viewer who
    // seeks away or stops never costs the operator the whole file. Unranged bodies
    // (`bytes=0-` or none) are the ones that would otherwise pump the entire file at
    // link speed; when the rate is unknown we stream unthrottled.
    let body = match pacing {
        Some((rate, burst)) => paced_body(resp.bytes_stream(), rate, burst),
        None => Body::from_stream(resp.bytes_stream()),
    };
    builder = builder.header(header::CACHE_CONTROL, "private, no-store");
    builder
        .body(body)
        .map(IntoResponse::into_response)
        .map_err(|e| AppError::Internal(format!("proxy response build failed: {e}")))
}

/// Per-request egress pacing for online playback, in the spirit of nginx's
/// `limit_rate_after` + `limit_rate` (and roughly what YouTube does): let the
/// player pull an initial *burst* at full link speed so it buffers and starts
/// instantly, then cap the sustained rate to ~1.5× the clip's real bitrate. The
/// point is upstream-bandwidth thrift — a viewer who seeks away or abandons a clip
/// mid-play no longer costs the operator the whole file, only what was actually
/// watched plus one buffer's worth. Returns `(rate_bytes_per_sec, burst_bytes)`,
/// or `None` (stream unthrottled) when the bitrate can't be estimated.
///
/// Every ranged request gets its own burst + throttle, so seeks stay snappy: the
/// pacing is anchored at each response's start, exactly like nginx applies it per
/// connection.
fn stream_pacing(item: &Item) -> Option<(u64, u64)> {
    let bitrate_bps = estimate_bitrate_bps(item.filesize, item.duration, item.height)?;
    let (rate, burst) = pacing_for_bitrate(bitrate_bps);
    (rate > 0).then_some((rate, burst))
}

/// The rate/burst pair for a known bitrate (bits/sec). Split out from
/// `stream_pacing` so the arithmetic is unit-testable without a full `Item`.
fn pacing_for_bitrate(bitrate_bps: u64) -> (u64, u64) {
    // 1.5× the media bitrate: enough headroom that playback never starves even as
    // the buffer drains, while still shaving an abandoned watch. Tutorials and real
    // players land in the 1.3–2× band; 1.5 is the middle.
    let rate = (bitrate_bps / 8).saturating_mul(3) / 2; // bytes/sec
    // ~4 seconds of head-start at full speed, floored at 2 MiB so a low-bitrate
    // audio clip still starts instantly.
    let burst = rate.saturating_mul(4).max(2 * 1024 * 1024);
    (rate, burst)
}

/// Estimate a stream's bitrate in bits/sec. Prefer the true figure — filesize over
/// duration — and fall back to a resolution ladder of typical H.264/VP9 streaming
/// bitrates when either is missing, so a cloud-only item with no recorded filesize
/// still earns a sane cap. `None` when neither size+duration nor height is known.
fn estimate_bitrate_bps(
    filesize: Option<i64>,
    duration: Option<i64>,
    height: Option<i64>,
) -> Option<u64> {
    if let (Some(size), Some(dur)) = (filesize, duration) {
        if size > 0 && dur > 0 {
            return Some((size as u64).saturating_mul(8) / dur as u64);
        }
    }
    height.map(|h| match h {
        ..=360 => 1_000_000,
        361..=480 => 2_500_000,
        481..=720 => 5_000_000,
        721..=1080 => 8_000_000,
        1081..=1440 => 16_000_000,
        _ => 25_000_000,
    })
}

/// Wrap an upstream byte stream so it delivers `burst` bytes at full speed, then
/// throttles to `rate` bytes/sec. Pacing uses a virtual clock: the stream sleeps
/// only when it has run *ahead* of the schedule `(sent - burst) / rate`, so bursty
/// upstream chunks average out to the target rate without a fixed per-chunk delay.
fn paced_body<S>(inner: S, rate: u64, burst: u64) -> Body
where
    S: futures::Stream<Item = reqwest::Result<Bytes>> + Send + 'static,
{
    struct Pace<S> {
        inner: std::pin::Pin<Box<S>>,
        start: tokio::time::Instant,
        sent: u64,
        rate: u64,
        burst: u64,
    }
    let st = Pace {
        inner: Box::pin(inner),
        start: tokio::time::Instant::now(),
        sent: 0,
        rate,
        burst,
    };
    let stream = futures::stream::unfold(st, |mut st| async move {
        let next = st.inner.next().await;
        if let Some(Ok(chunk)) = &next {
            st.sent = st.sent.saturating_add(chunk.len() as u64);
            if st.rate > 0 && st.sent > st.burst {
                let owed = (st.sent - st.burst) as f64 / st.rate as f64;
                let elapsed = st.start.elapsed().as_secs_f64();
                if owed > elapsed {
                    tokio::time::sleep(std::time::Duration::from_secs_f64(owed - elapsed)).await;
                }
            }
        }
        next.map(|res| (res, st))
    });
    Body::from_stream(stream)
}

/// Shared redirect-following HTTP client for proxied upstream fetches. Redirects
/// are handled by hand at each call site so every hop can pass the async
/// DNS-resolving SSRF guard — reqwest's own redirect hook is synchronous and
/// can only see the literal URL, not what a hostname resolves to.
///
/// The client resolves through [`net_guard::GuardedResolver`], so the address it
/// dials is the one the guard checked rather than a second, re-attackable
/// lookup. `allow_private_dns` is baked in at first use; it comes from immutable
/// config, so the client built here is the client every later call wants.
async fn proxy_client(allow_private_dns: bool) -> Result<&'static reqwest::Client, AppError> {
    static CLIENT: tokio::sync::OnceCell<reqwest::Client> = tokio::sync::OnceCell::const_new();
    CLIENT
        .get_or_try_init(|| async {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .dns_resolver(crate::net_guard::GuardedResolver::new(allow_private_dns))
                .build()
        })
        .await
        .map_err(|e| AppError::Internal(format!("http client build failed: {e}")))
}

/// Fetch `upstream`, following redirects by hand so **every hop** passes the
/// resolving SSRF guard — a CDN redirect to a hostname that resolves to
/// `169.254.169.254` or `127.0.0.1` is the whole attack, and only a resolving
/// check sees it. This is the single choke point every proxied fetch goes
/// through (media stream, ranged window, thumbnail, subtitle track), so the guard
/// cannot be tightened in one path and forgotten in another.
///
/// Returns the final response with its body **unread**: the caller decides
/// whether to stream it through ([`proxy_upstream`]) or buffer it under a budget
/// ([`read_capped`]), and checks the status itself so it can phrase its own
/// user-facing error.
async fn guarded_get(
    upstream: &str,
    referer: &str,
    cookie_header: Option<&str>,
    range: Option<&str>,
    allow_private_dns: bool,
) -> Result<reqwest::Response, AppError> {
    let client = proxy_client(allow_private_dns).await?;
    let mut url = upstream.to_string();
    let mut redirects = 0;
    loop {
        crate::net_guard::guard(&url, allow_private_dns)
            .await
            .map_err(|r| AppError::BadRequest(r.reason().into()))?;

        let mut rb = client
            .get(&url)
            .header(reqwest::header::USER_AGENT, PROXY_UA)
            .header(reqwest::header::REFERER, referer);
        if let Some(c) = cookie_header {
            rb = rb.header(reqwest::header::COOKIE, c);
        }
        if let Some(r) = range {
            rb = rb.header(reqwest::header::RANGE, r);
        }
        let resp = rb
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("upstream fetch failed: {e}")))?;

        if !resp.status().is_redirection() {
            return Ok(resp);
        }
        let location = resp
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| AppError::Internal("upstream redirect without location".into()))?;
        // Resolve against the current URL so a relative Location works.
        let next = reqwest::Url::parse(&url)
            .and_then(|base| base.join(location))
            .map_err(|_| AppError::BadRequest("upstream redirect is not a valid url".into()))?;
        if !matches!(next.scheme(), "http" | "https") {
            return Err(AppError::BadRequest("upstream redirect scheme".into()));
        }
        url = next.into();
        redirects += 1;
        if redirects > MAX_REDIRECTS {
            return Err(AppError::BadRequest("too many upstream redirects".into()));
        }
    }
}

/// Buffer a response body into memory under a hard byte budget, streaming it
/// chunk by chunk and giving up the moment the budget is passed.
///
/// The budget has to be enforced *during* the read, not after it: every upstream
/// URL here is attacker-influenced (yt-dlp reports whatever the source page
/// declares as its media/thumbnail URL), a `Content-Length` is a claim rather
/// than a fact, and an upstream is free to ignore our `Range` entirely. Reading
/// the whole body first and measuring it afterwards means a single hostile row
/// can pull an arbitrary number of bytes into RAM before the check ever runs.
/// Dropping the response mid-stream closes the connection and stops the transfer.
async fn read_capped(
    mut resp: reqwest::Response,
    cap: usize,
    what: &str,
) -> Result<Vec<u8>, AppError> {
    let hint = resp.content_length().unwrap_or(0).min(cap as u64) as usize;
    let mut out: Vec<u8> = Vec::with_capacity(hint);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Internal(format!("{what} read failed: {e}")))?
    {
        if out.len() + chunk.len() > cap {
            return Err(AppError::BadRequest(format!("{what} is too large")));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Fetch one ranged window of an upstream stream into memory, guarding every
/// redirect hop for SSRF. Returns the buffered bytes and the resource's total
/// length parsed from `Content-Range` (`None` if the upstream didn't report it).
/// `cap` bounds the buffer so a hostile row can't stream an unbounded body into
/// memory.
async fn fetch_upstream_window(
    upstream: &str,
    referer: &str,
    cookie_header: Option<String>,
    range: &str,
    allow_private_dns: bool,
    cap: usize,
) -> Result<(Vec<u8>, Option<u64>), AppError> {
    let resp = guarded_get(
        upstream,
        referer,
        cookie_header.as_deref(),
        Some(range),
        allow_private_dns,
    )
    .await?;
    if !resp.status().is_success() {
        return Err(AppError::BadRequest("upstream stream error".into()));
    }
    // Total length lives after the slash in `Content-Range: bytes a-b/total`;
    // fall back to `Content-Length` for a non-ranged 200.
    let total = resp
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.rsplit('/').next())
        .and_then(|t| t.trim().parse::<u64>().ok())
        .or_else(|| {
            resp.headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok())
        });
    let bytes = read_capped(resp, cap, "upstream window").await?;
    Ok((bytes, total))
}

/// GET /api/items/:slug/thumb — **thumbnail proxy + cache**. Authenticates via the
/// secure channel (Service Worker headers) or the loopback `?token=` fallback,
/// because an `<img>` can't send an Authorization header.
///
/// The frontend used to point `<img src>` straight at the upstream thumbnail URL
/// (e.g. `pbs.twimg.com`), which broke the moment a browser or an ad/tracker
/// blocker refused that host — and leaked the fact that you'd saved something to
/// that CDN. This route makes the backend the sole fetcher: on first request it
/// pulls the bytes from the item's recorded `thumbnail_url` (through the SSRF
/// guard, exactly like `/stream`), stashes them under `data_dir/thumbs/<slug>`,
/// and serves them. Every later request is a local file read.
pub async fn thumb(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    req: Request,
) -> Result<Response, AppError> {
    let query = req.uri().query().unwrap_or("").to_string();
    let path = req.uri().path().to_string();
    let session_key =
        super::auth::authenticate_media(&state, req.headers(), &query, peer_ip(&req), &path).await?;
    let item = state
        .db
        .find_by_slug(&slug)
        .await?
        .ok_or(AppError::NotFound)?;
    let upstream = match item.thumbnail_url.as_deref() {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return Err(AppError::NotFound),
    };

    let dir = state.cfg.data_dir.join("thumbs");
    // `sanitize_slug` reduces the slug to a single alnum/-/_ path component, so
    // the cache file can never escape `dir` even if the slug scheme changes.
    let cache_path = dir.join(sanitize_slug(&slug));

    let bytes = match tokio::fs::read(&cache_path).await {
        Ok(b) if !b.is_empty() => b,
        _ => {
            let fetched = fetch_thumbnail(&upstream, &item.webpage_url, state.cfg.allow_private_dns)
                .await?;
            let _ = tokio::fs::create_dir_all(&dir).await;
            let _ = tokio::fs::write(&cache_path, &fetched).await;
            fetched
        }
    };

    match session_key {
        // Secure channel: seal the image; the Service Worker decrypts it to a blob.
        Some(key) => emedia::serve_bytes(&key, &format!("thumb:{slug}"), &bytes),
        // Loopback plaintext fallback.
        None => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, sniff_image_type(&bytes))
            .header(header::CACHE_CONTROL, "private, max-age=604800, immutable")
            .body(Body::from(bytes))
            .map(IntoResponse::into_response)
            .map_err(|e| AppError::Internal(format!("thumb response build failed: {e}"))),
    }
}

/// Ceiling on a buffered thumbnail. Real cover art is tens to hundreds of KB;
/// this is roomy enough for any of it while keeping a `thumbnail_url` that
/// actually points at a multi-gigabyte file — the source page declares that URL,
/// so it is attacker-influenced — from being pulled into RAM and written to the
/// on-disk cache.
const MAX_THUMB_BYTES: usize = 8 * 1024 * 1024;

/// Fetch an upstream thumbnail into memory, guarding every redirect hop for SSRF
/// and bounding the buffer at [`MAX_THUMB_BYTES`]. The caller writes it to the
/// cache and serves it.
async fn fetch_thumbnail(
    upstream: &str,
    referer: &str,
    allow_private_dns: bool,
) -> Result<Vec<u8>, AppError> {
    let resp = guarded_get(upstream, referer, None, None, allow_private_dns).await?;
    if !resp.status().is_success() {
        return Err(AppError::BadRequest("thumbnail upstream error".into()));
    }
    read_capped(resp, MAX_THUMB_BYTES, "thumbnail").await
}

/// Fetch an upstream thumbnail and encode it as a `data:` URI, or `None` on any
/// failure. Powers the clipboard/prepare preview cards, which have no item slug
/// yet (so the cached `/thumb` route can't serve them) and can't point an `<img>`
/// straight at the CDN host (blocked/leaky — the very reason `/thumb` exists). A
/// missing thumbnail must never fail the preview, hence the swallowed errors.
pub(super) async fn thumbnail_data_uri(
    upstream: &str,
    referer: &str,
    allow_private_dns: bool,
) -> Option<String> {
    if upstream.is_empty() {
        return None;
    }
    let bytes = fetch_thumbnail(upstream, referer, allow_private_dns).await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    let mime = sniff_image_type(&bytes);
    if mime == "application/octet-stream" {
        return None; // not an image we recognise — don't hand the UI garbage
    }
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// Fetch a small upstream text resource (a subtitle track) fully into memory,
/// SSRF-guarding every redirect hop the way `proxy_upstream` does and carrying the
/// session `cookie_header` for cookie-gated CDNs. `max_bytes` caps the buffer so a
/// hostile row can't stream an unbounded body into memory. Returns the raw bytes;
/// the caller decodes and converts them.
pub(super) async fn fetch_upstream_bytes(
    upstream: &str,
    referer: &str,
    cookie_header: Option<String>,
    allow_private_dns: bool,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    let resp = guarded_get(
        upstream,
        referer,
        cookie_header.as_deref(),
        None,
        allow_private_dns,
    )
    .await?;
    if !resp.status().is_success() {
        return Err(AppError::BadRequest("subtitle upstream error".into()));
    }
    read_capped(resp, max_bytes, "subtitle file").await
}

/// Best-effort image content-type from the leading magic bytes. Falls back to a
/// generic octet-stream, which browsers still render for an `<img>`.
fn sniff_image_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

/// Reduce a slug to a safe single path component for the cache filename. Slugs
/// are already random tokens, but this keeps a stray separator from escaping.
fn sanitize_slug(slug: &str) -> String {
    slug.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Build a scope-correct `Cookie:` header for an upstream URL from a Netscape
/// cookies.txt. Domain, host-only, path, Secure, and expiry rules are enforced.
pub(super) fn cookie_header_for(cookie_file: Option<&FsPath>, upstream: &str) -> Option<String> {
    let text = std::fs::read_to_string(cookie_file?).ok()?;
    let url = reqwest::Url::parse(upstream).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let path = url.path();
    let secure_request = url.scheme() == "https";
    let now = crate::types::now_unix();
    let mut pairs = Vec::new();
    for line in text.lines() {
        let mut line = line.trim();
        if let Some(rest) = line.strip_prefix("#HttpOnly_") {
            line = rest;
        } else if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 7 {
            continue;
        }
        let raw_domain = f[0];
        let domain = raw_domain.trim_start_matches('.').to_ascii_lowercase();
        if domain.is_empty() {
            continue;
        }
        let include_subdomains = f[1].eq_ignore_ascii_case("TRUE") || raw_domain.starts_with('.');
        let domain_matches =
            host == domain || (include_subdomains && host.ends_with(&format!(".{domain}")));
        let cookie_path = if f[2].is_empty() { "/" } else { f[2] };
        let path_matches = path == cookie_path
            || path
                .strip_prefix(cookie_path)
                .is_some_and(|rest| cookie_path.ends_with('/') || rest.starts_with('/'));
        let secure = f[3].eq_ignore_ascii_case("TRUE");
        let unexpired = f[4]
            .parse::<i64>()
            .ok()
            .is_none_or(|expiry| expiry == 0 || expiry > now);
        if domain_matches && path_matches && (!secure || secure_request) && unexpired {
            pairs.push(format!("{}={}", f[5], f[6]));
        }
    }
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

/// Stream `item`'s file, honoring `?download=1` for an attachment disposition.
/// `root` is the configured download directory: the file is served only if it
/// canonicalizes to a real file inside it (path-traversal guard).
async fn serve_item(root: &FsPath, item: Item, req: Request) -> Result<Response, AppError> {
    ensure_media_ready(item.status)?;
    let query = req.uri().query().unwrap_or("").to_string();
    let path = resolve_local_file(root, &item)?;

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
    parts
        .headers
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    parts
        .headers
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    Ok(Response::from_parts(parts, Body::new(body)).into_response())
}

/// Confine an item's stored path to the download root, rejecting `..`, absolute
/// paths elsewhere, and symlinks escaping the root (e.g. an imported Seal
/// `videoPath` of /etc/passwd). Shared by the encrypted and plaintext file paths.
fn resolve_local_file(root: &FsPath, item: &Item) -> Result<std::path::PathBuf, AppError> {
    let stored = match item.filepath.as_deref() {
        Some(p) if !p.is_empty() => p,
        _ => return Err(AppError::BadRequest("item has no downloaded file".into())),
    };
    crate::safepath::confined_file(root, stored).ok_or(AppError::NotFound)
}

/// Gate for the routes that serve a LOCAL file (`/file`, public shares): there
/// has to be a finished download on disk to send.
fn ensure_media_ready(status: Status) -> Result<(), AppError> {
    if status == Status::Completed {
        Ok(())
    } else {
        Err(AppError::BadRequest("item media is not ready".into()))
    }
}

/// Gate for online playback (`/stream`), which is a different question: that
/// route proxies from the SOURCE — yt-dlp resolves the upstream URL and we pass
/// the bytes through — so it needs no local file at all.
///
/// Which is why `paused` streams. A download parked by the storage cap is the
/// case the cap's whole promise rests on: "recorded, still watchable, just not
/// downloaded yet". Holding it to the local-file rule made the item unplayable
/// precisely when there was no copy coming, breaking the one thing pausing was
/// supposed to preserve. Queued/running are excluded on purpose — a file IS on
/// its way, and racing the download with a second upstream fetch just doubles the
/// bandwidth for a video that's about to be local anyway.
fn ensure_streamable(status: Status) -> Result<(), AppError> {
    if matches!(status, Status::Completed | Status::Paused) {
        Ok(())
    } else {
        Err(AppError::BadRequest("item media is not ready".into()))
    }
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
            || matches!(
                b,
                b'-' | b'.' | b'_' | b'~' | b'!' | b'#' | b'$' | b'&' | b'+'
            );
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
    fn bitrate_prefers_true_size_over_duration() {
        // 10 MB over 40 s = 2 Mbit/s — the true figure wins over the height ladder.
        assert_eq!(
            estimate_bitrate_bps(Some(10 * 1000 * 1000), Some(40), Some(1080)),
            Some(2_000_000)
        );
    }

    #[test]
    fn bitrate_falls_back_to_resolution_ladder() {
        // No usable size/duration → height picks the tier.
        assert_eq!(estimate_bitrate_bps(None, None, Some(1080)), Some(8_000_000));
        assert_eq!(estimate_bitrate_bps(Some(0), Some(0), Some(720)), Some(5_000_000));
        // Nothing to go on at all → unthrottled.
        assert_eq!(estimate_bitrate_bps(None, None, None), None);
    }

    #[test]
    fn pacing_is_one_and_a_half_bitrate_with_a_floored_burst() {
        // 8 Mbit/s → 1 MB/s; ×1.5 = 1.5 MB/s; burst = 4 s = 6 MB (> 2 MiB floor).
        assert_eq!(pacing_for_bitrate(8_000_000), (1_500_000, 6_000_000));
        // A tiny-bitrate clip still gets the 2 MiB burst floor so playback starts fast.
        assert_eq!(pacing_for_bitrate(1_000_000).1, 2 * 1024 * 1024);
    }

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

    #[test]
    fn media_is_served_only_after_completion() {
        assert!(ensure_media_ready(Status::Completed).is_ok());
        for status in [
            Status::Queued,
            Status::Running,
            // A paused item has no local file to serve, however streamable it is.
            Status::Paused,
            Status::Failed,
            Status::Duplicate,
        ] {
            assert!(ensure_media_ready(status).is_err());
        }
    }

    /// Online playback proxies from the source, so it must NOT be held to the
    /// local-file rule: a download the storage cap parked is still watchable,
    /// which is the entire promise the cap makes.
    #[test]
    fn paused_items_still_stream_from_source() {
        assert!(ensure_streamable(Status::Completed).is_ok());
        assert!(ensure_streamable(Status::Paused).is_ok());
        for status in [
            Status::Queued,
            Status::Running,
            Status::Failed,
            Status::Duplicate,
        ] {
            assert!(ensure_streamable(status).is_err());
        }
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
        let h = cookie_header_for(Some(f.path()), "https://video.x.com/media/1").unwrap();
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
        assert!(cookie_header_for(Some(f.path()), "https://youtube.com/watch").is_none());
        // No file at all → None.
        assert!(cookie_header_for(None, "https://video.x.com/media").is_none());
    }

    #[test]
    fn cookie_header_enforces_host_path_secure_and_expiry() {
        let f = write_cookies(
            "x.com\tFALSE\t/account\tTRUE\t0\thost_only\tA\n\
             .x.com\tTRUE\t/\tFALSE\t1\texpired\tB\n\
             .x.com\tTRUE\t/media\tTRUE\t4102444800\tvalid\tC\n",
        );
        let h = cookie_header_for(Some(f.path()), "https://video.x.com/media/1").unwrap();
        assert_eq!(h, "valid=C");
        assert!(cookie_header_for(Some(f.path()), "http://video.x.com/media/1").is_none());
        assert!(cookie_header_for(Some(f.path()), "https://video.x.com/other").is_none());
    }
}
