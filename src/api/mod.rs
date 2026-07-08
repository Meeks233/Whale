//! HTTP router assembly + shared state. See docs/API.md.

pub mod auth;
mod cookies;
mod events;
mod items;

use crate::archive::Archive;
use crate::config::Config;
use crate::cookies::CookieStore;
use crate::db::Db;
use crate::queue::Queue;
use axum::routing::{get, post, put};
use axum::{middleware, Router};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub db: Db,
    pub archive: Archive,
    pub queue: Queue,
    pub cookies: CookieStore,
    pub ytdlp_version: String,
}

pub fn router(state: AppState) -> Router {
    // Routes requiring the bearer token.
    let protected = Router::new()
        .route("/api/items", post(items::submit).get(items::list))
        .route("/api/items/:id", get(items::get).delete(items::delete))
        .route("/api/items/:id/retry", post(items::retry))
        .route("/api/cookies", get(cookies::list))
        .route(
            "/api/cookies/:platform",
            put(cookies::set).patch(cookies::toggle).delete(cookies::delete),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    // Public routes: health (no auth) + SSE (auth via ?token= inside) + static UI.
    let public = Router::new()
        .route("/api/health", get(items::health))
        .route("/api/events", get(events::events))
        .fallback(crate::web::static_handler);

    Router::new()
        .merge(protected)
        .merge(public)
        .with_state(state)
}
