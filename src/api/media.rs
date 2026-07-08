//! Media file streaming — range-capable playback + download. See docs/API.md.
//!
//! Access is granted when the request carries a valid token (Authorization
//! header or `?token=`) OR the item is flagged `public`. Serving is delegated to
//! `tower_http::services::ServeFile`, which handles Range/HEAD/Content-Type.

use super::AppState;
use crate::error::AppError;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use std::path::Path as FsPath;
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// GET /api/items/:id/file — stream the downloaded media (supports Range).
/// Public route: authorizes via token OR the item's `public` flag.
/// Add `?download=1` to force a browser download (Content-Disposition attachment).
pub async fn file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    req: Request,
) -> Result<Response, AppError> {
    let query = req.uri().query().unwrap_or("").to_string();
    let token = super::auth::extract_token(req.headers(), &query);
    let authed = token.as_deref() == Some(state.cfg.token.as_str());

    let item = state.db.get(id).await?.ok_or(AppError::NotFound)?;
    if !authed && !item.public {
        return Err(AppError::Unauthorized);
    }

    let path = match item.filepath.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return Err(AppError::BadRequest("item has no downloaded file".into())),
    };
    if !FsPath::new(&path).is_file() {
        return Err(AppError::NotFound);
    }

    let download = query.split('&').any(|p| p == "download=1");

    // ServeFile consumes the request (for its Range/If-* headers) and never errors.
    let served = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map_err(|_| AppError::Internal("file serve failed".into()))?;

    let (mut parts, body) = served.into_parts();
    if download {
        if let Some(name) = FsPath::new(&path).file_name().and_then(|n| n.to_str()) {
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
}
