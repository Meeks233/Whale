//! SSE progress stream handler. See docs/API.md `GET /api/events`.

use super::AppState;
use crate::error::AppError;
use axum::extract::{ConnectInfo, RawQuery, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::stream::Stream;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::sync::broadcast;

/// GET /api/events — one shared SSE stream of ProgressEvents. Browser `EventSource`
/// cannot set headers, so a secure-channel client carries its opaque session id and
/// a sealed authenticator in the query (`?sid=..&auth=..`). The sid names a session
/// but proves nothing on its own; the authenticator — which only a holder of the
/// session key could seal — is what authenticates and picks the encryption key.
/// The events are then sealed under that session key, so Cloudflare sees only
/// ciphertext. A loopback peer may instead pass a plaintext `?token=` for local
/// debugging.
pub async fn events(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RawQuery(query): RawQuery,
) -> Response {
    let q = query.unwrap_or_default();
    let encryption_key = if let Some(sid) = super::auth::query_param(&q, "sid") {
        let Some(auth) = super::auth::query_param(&q, "auth") else {
            return AppError::Unauthorized.into_response();
        };
        // The authenticator's target is the fixed route, not the live URL, whose
        // query string contains the authenticator itself and so can't bind it.
        match super::auth::resolve_session(&state, &sid, &auth, "GET", "/api/events", false).await {
            Ok((_client_id, key)) => Some(key),
            Err(e) => return e.into_response(),
        }
    } else {
        // Loopback plaintext fallback (`?token=`) for local debugging only.
        if !peer.ip().is_loopback() {
            return AppError::Unauthorized.into_response();
        }
        let token = super::auth::extract_token(&axum::http::HeaderMap::new(), &q);
        if !token
            .as_deref()
            .is_some_and(|t| super::auth::ct_eq(t, &state.cfg.token))
        {
            return AppError::Unauthorized.into_response();
        }
        None
    };

    let rx = state.queue.subscribe();
    let stream = progress_stream(rx, encryption_key);
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

fn progress_stream(
    rx: broadcast::Receiver<crate::types::ProgressEvent>,
    encryption_key: Option<[u8; 32]>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    futures::stream::unfold(rx, move |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let event = if let Some(key) = &encryption_key {
                        serde_json::to_vec(&ev)
                            .ok()
                            .and_then(|json| crate::e2ee::seal(key, &json, b"event\nprogress").ok())
                            .and_then(|data| String::from_utf8(data).ok())
                            .map(|data| Event::default().event("progress").data(data))
                            .unwrap_or_else(|| Event::default().comment("encrypt error"))
                    } else {
                        Event::default()
                            .event("progress")
                            .json_data(&ev)
                            .unwrap_or_else(|_| Event::default().comment("serialize error"))
                    };
                    return Some((Ok(event), rx));
                }
                // Dropped some messages under load — keep going.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                // Sender gone — end the stream.
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}
