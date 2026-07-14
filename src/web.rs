//! Embedded static frontend assets (rust-embed) + Axum static handler. See docs/FRONTEND.md.

use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "web/"]
pub struct Assets;

/// Serve an embedded asset. `/` maps to `index.html`; unknown paths 404.
/// Auth-free by design (assets contain no data — see docs/API.md).
///
/// Sends a content-hash `ETag` with `Cache-Control: no-cache` so browsers (and
/// the network-first service worker) revalidate on every load and pick up code
/// edits immediately — a 304 when unchanged, fresh bytes when the hash moves.
pub async fn static_handler(headers: HeaderMap, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match Assets::get(path) {
        Some(content) => {
            let etag = format!(
                "\"{}\"",
                content
                    .metadata
                    .sha256_hash()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>()
            );

            if headers
                .get(header::IF_NONE_MATCH)
                .is_some_and(|v| v.as_bytes() == etag.as_bytes())
            {
                return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
            }

            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [
                    (header::CONTENT_TYPE, mime.as_ref().to_owned()),
                    (header::CACHE_CONTROL, "no-cache".to_owned()),
                    (header::ETAG, etag),
                ],
                content.data.into_owned(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
