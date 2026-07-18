//! Encrypted media serving — chunked AEAD driven by Service-Worker windows.
//! See docs/SECURITY.md ("Media plane").
//!
//! `<video>`/`<img>`/`<track>` can't attach auth headers or decrypt bytes, so a
//! same-origin Service Worker fetches on their behalf: it asks for a plaintext
//! byte range (`X-Orca-Range`), the server seals the covering 64 KiB chunks under
//! a per-resource stream key and returns them as a plain `200`, and the SW
//! decrypts, reassembles, and answers the element with a normal `206`. The
//! transport (Cloudflare) sees only ciphertext and an opaque session id.

use crate::e2ee;
use crate::error::{AppError, AppResult};
use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::Response;
use std::path::Path as FsPath;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// At most this many chunks (1 MiB plaintext) are sealed per file response, so a
/// multi-gigabyte video never seals whole into memory. The SW requests further
/// windows as the element plays and seeks.
const WINDOW_CHUNKS: u64 = 16;
/// Maximum plaintext bytes in one window — what the upstream-proxy path buffers.
pub const WINDOW_MAX_BYTES: usize = WINDOW_CHUNKS as usize * e2ee::MEDIA_CHUNK;

/// Parse an `X-Orca-Range` value: `"start-end"` (end inclusive) or `"start-"`.
pub fn parse_range(v: &str) -> Option<(u64, Option<u64>)> {
    let (s, e) = v.split_once('-')?;
    let start = s.trim().parse::<u64>().ok()?;
    let e = e.trim();
    let end = if e.is_empty() {
        None
    } else {
        Some(e.parse::<u64>().ok()?)
    };
    Some((start, end))
}

/// The chunk span and byte read extent that satisfy a plaintext range request,
/// capped to one window. `None` when there is nothing to serve (empty resource,
/// or a start at/past EOF).
pub struct Window {
    pub i0: u64,
    pub i1: u64,
    pub read_start: u64,
    pub read_end: u64,
}

/// Plan the chunk window covering `[start, end]` of a `plain_len`-byte resource,
/// capped to one window. Shared by the file and upstream-proxy media paths.
pub fn plan(plain_len: u64, start: u64, end: Option<u64>) -> Option<Window> {
    if plain_len == 0 || start >= plain_len {
        return None;
    }
    let p = e2ee::MEDIA_CHUNK as u64;
    let i0 = start / p;
    let desired_end = end.unwrap_or(plain_len - 1).min(plain_len - 1).max(start);
    let cap_end = (i0 + WINDOW_CHUNKS) * p - 1;
    let end = desired_end.min(cap_end);
    let i1 = end / p;
    Some(Window {
        i0,
        i1,
        read_start: i0 * p,
        read_end: ((i1 + 1) * p).min(plain_len),
    })
}

/// Seal chunks `i0..=i1` from a plaintext `slab` that begins at `read_start`.
fn seal_slab(
    stream_key: &[u8; 32],
    plain_len: u64,
    i0: u64,
    i1: u64,
    read_start: u64,
    slab: &[u8],
) -> AppResult<Vec<u8>> {
    let p = e2ee::MEDIA_CHUNK as u64;
    let mut body =
        Vec::with_capacity(slab.len() + ((i1 - i0 + 1) as usize) * e2ee::MEDIA_TAG);
    for idx in i0..=i1 {
        let cs = (idx * p - read_start) as usize;
        let ce = (((idx + 1) * p).min(plain_len) - read_start) as usize;
        body.extend(e2ee::seal_chunk(stream_key, idx, &slab[cs..ce])?);
    }
    Ok(body)
}

fn respond(plain_len: u64, first_chunk: u64, body: Vec<u8>) -> AppResult<Response> {
    Response::builder()
        .status(StatusCode::OK)
        .header(e2ee::HEADER_E2EE, "1")
        .header(e2ee::HEADER_PLAIN_LEN, plain_len)
        .header(e2ee::HEADER_CHUNK, e2ee::MEDIA_CHUNK)
        .header(e2ee::HEADER_CHUNK_INDEX, first_chunk)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from(body))
        .map_err(|e| AppError::Internal(format!("media response build failed: {e}")))
}

/// Serve one encrypted window of a local file. `resource` uniquely labels this
/// byte stream (e.g. `"file:<slug>"`) so its stream key can't collide with the
/// same item's thumbnail. `range` is the `X-Orca-Range` header value, if any.
pub async fn serve_file(
    session_key: &[u8; 32],
    resource: &str,
    path: &FsPath,
    range: Option<&str>,
) -> AppResult<Response> {
    let stream_key = e2ee::media_stream_key(session_key, resource);
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|_| AppError::NotFound)?;
    let plain_len = meta.len();
    let (start, end) = range.and_then(parse_range).unwrap_or((0, None));

    let Some(w) = plan(plain_len, start, end) else {
        // Empty file, or a seek at/past EOF: no chunks, but still report the size.
        return respond(plain_len, start / e2ee::MEDIA_CHUNK as u64, Vec::new());
    };

    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| AppError::NotFound)?;
    file.seek(std::io::SeekFrom::Start(w.read_start))
        .await
        .map_err(|_| AppError::Internal("media seek failed".into()))?;
    let mut slab = vec![0u8; (w.read_end - w.read_start) as usize];
    file.read_exact(&mut slab)
        .await
        .map_err(|_| AppError::Internal("media read failed".into()))?;

    let body = seal_slab(&stream_key, plain_len, w.i0, w.i1, w.read_start, &slab)?;
    respond(plain_len, w.i0, body)
}

/// Seal a plaintext `slab` covering chunks `w.i0..=w.i1` (fetched from an upstream
/// proxy) into an encrypted-media window response. `plain_len` is the resource's
/// total plaintext length so the SW can bound seeks.
pub fn serve_window(
    session_key: &[u8; 32],
    resource: &str,
    plain_len: u64,
    w: &Window,
    slab: &[u8],
) -> AppResult<Response> {
    let stream_key = e2ee::media_stream_key(session_key, resource);
    let body = seal_slab(&stream_key, plain_len, w.i0, w.i1, w.read_start, slab)?;
    respond(plain_len, w.i0, body)
}

/// Seal a whole in-memory blob (thumbnail, subtitle track) as one chunked stream.
/// Small resources fetched in a single SW request, so the window cap doesn't apply.
pub fn serve_bytes(session_key: &[u8; 32], resource: &str, bytes: &[u8]) -> AppResult<Response> {
    let stream_key = e2ee::media_stream_key(session_key, resource);
    let plain_len = bytes.len() as u64;
    let p = e2ee::MEDIA_CHUNK;
    let mut body = Vec::with_capacity(bytes.len() + bytes.len().div_ceil(p) * e2ee::MEDIA_TAG);
    for (idx, chunk) in bytes.chunks(p).enumerate() {
        body.extend(e2ee::seal_chunk(&stream_key, idx as u64, chunk)?);
    }
    respond(plain_len, 0, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("0-100"), Some((0, Some(100))));
        assert_eq!(parse_range("64-"), Some((64, None)));
        assert_eq!(parse_range("bad"), None);
    }

    #[test]
    fn window_covers_range_and_caps_to_one_window() {
        let p = e2ee::MEDIA_CHUNK as u64;
        // A small range inside chunk 0.
        let w = plan(10 * p, 100, Some(200)).unwrap();
        assert_eq!((w.i0, w.i1), (0, 0));
        // Open-ended from chunk 3 caps at WINDOW_CHUNKS chunks.
        let w = plan(1000 * p, 3 * p, None).unwrap();
        assert_eq!(w.i0, 3);
        assert_eq!(w.i1, 3 + WINDOW_CHUNKS - 1);
        // Seek to EOF yields nothing.
        assert!(plan(5 * p, 5 * p, None).is_none());
        assert!(plan(0, 0, None).is_none());
    }

    #[test]
    fn seal_slab_round_trips_each_chunk() {
        let key = e2ee::media_stream_key(&[3u8; 32], "file:abc");
        let stream = e2ee::media_stream_key(&[3u8; 32], "file:abc");
        assert_eq!(key, stream); // deterministic
        let p = e2ee::MEDIA_CHUNK as u64;
        let plain_len = 2 * p + 5;
        let slab: Vec<u8> = (0..plain_len).map(|i| (i % 251) as u8).collect();
        let body = seal_slab(&stream, plain_len, 0, 2, 0, &slab).unwrap();
        // Three chunks, three tags.
        assert_eq!(body.len(), plain_len as usize + 3 * e2ee::MEDIA_TAG);
        // Second chunk decrypts back to the right plaintext slice.
        let start = (p as usize) + e2ee::MEDIA_TAG;
        let ct1 = &body[start..start + p as usize + e2ee::MEDIA_TAG];
        let pt1 = e2ee::open_chunk(&stream, 1, ct1).unwrap();
        assert_eq!(pt1, &slab[p as usize..2 * p as usize]);
    }
}
