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

/// GET /api/events — one shared SSE stream of ProgressEvents. Auth via `?token=`.
pub async fn events(State(state): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let q = query.unwrap_or_default();
    let token = super::auth::extract_token(&axum::http::HeaderMap::new(), &q);
    if !token
        .as_deref()
        .is_some_and(|t| super::auth::ct_eq(t, &state.cfg.token))
    {
        return AppError::Unauthorized.into_response();
    }

    let rx = state.queue.subscribe();
    let stream = progress_stream(rx);
    Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

fn progress_stream(
    rx: broadcast::Receiver<crate::types::ProgressEvent>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    futures::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let event = Event::default()
                        .event("progress")
                        .json_data(&ev)
                        .unwrap_or_else(|_| Event::default().comment("serialize error"));
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
