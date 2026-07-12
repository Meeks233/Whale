//! HTTP router assembly + shared state. See docs/API.md.

pub mod auth;
mod archive;
mod clients;
mod cookies;
mod events;
mod items;
mod media;

use crate::archive::Archive;
use crate::config::Config;
use crate::cookies::CookieStore;
use crate::db::Db;
use crate::queue::Queue;
use axum::routing::{get, post, put};
use axum::{middleware, Router};
use tower_http::cors::CorsLayer;

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
        .route("/api/items/:id/public", post(items::set_public))
        .route("/api/items/:id/stream-url", get(media::stream_url))
        .route("/api/cookies", get(cookies::list))
        .route(
            "/api/cookies/:platform",
            put(cookies::set).patch(cookies::toggle).delete(cookies::delete),
        )
        .route(
            "/api/archive",
            get(archive::list).post(archive::add).delete(archive::remove),
        )
        .route("/api/clients", get(clients::list))
        .route("/api/clients/:id/trust", post(clients::trust))
        .route("/api/clients/:id", axum::routing::delete(clients::delete))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    // Public routes: health (no auth) + SSE (auth via ?token= inside) + static UI.
    // File streaming self-authorizes (token OR item.public), so it lives here.
    let public = Router::new()
        .route("/api/health", get(items::health))
        .route("/api/clients/register", post(clients::register))
        .route("/api/events", get(events::events))
        .route("/api/items/:id/file", get(media::file))
        .route("/api/p/:slug", get(media::public_file))
        .fallback(crate::web::static_handler);

    Router::new()
        .merge(protected)
        .merge(public)
        // Allow the native app's webview origin (and browsers on other origins)
        // to call the API. Auth is a bearer token, not cookies, so permissive
        // (no credentials) is safe here.
        .layer(CorsLayer::permissive())
        .with_state(state)
}
