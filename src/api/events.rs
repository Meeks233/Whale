//! SSE progress stream handler. See docs/API.md `GET /api/events`.

use super::AppState;
use crate::error::AppError;
use axum::extract::{RawQuery, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures::stream::Stream;
use std::convert::Infallible;
use std::time::Duration;
use tokio::sync::broadcast;

/// GET /api/events — one shared SSE stream of ProgressEvents. Browser SSE cannot
/// set headers, so encrypted clients send the key id in the query. The key id is
/// public — it names the key but proves nothing — so the client must also present
/// a sealed authenticator it could only have produced by holding that key.
pub async fn events(State(state): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let q = query.unwrap_or_default();
    let encryption_key = if let Some(requested_id) = super::auth::query_param(&q, "key_id") {
        let hash = crate::e2ee::auth_hash(&state.cfg.token);
        if !super::auth::ct_eq(&requested_id, &crate::e2ee::key_id(&hash)) {
            return AppError::Unauthorized.into_response();
        }
        let Some(auth) = super::auth::query_param(&q, "auth") else {
            return AppError::Unauthorized.into_response();
        };
        let key = crate::e2ee::encryption_key(&hash);
        // The target is the fixed route, not the real one: the live query string
        // contains this authenticator, so it cannot also be bound by it.
        if let Err(e) = crate::e2ee::verify_authenticator(
            &key,
            &auth,
            "GET",
            "/api/events",
            crate::types::now_unix(),
        ) {
            return e.into_response();
        }
        Some(key)
    } else {
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
