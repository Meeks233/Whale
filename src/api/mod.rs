//! HTTP router assembly + shared state. See docs/API.md.

mod archive;
pub mod auth;
mod clients;
mod cookies;
mod events;
mod items;
mod media;
mod subs;
mod websites;

use crate::archive::Archive;
use crate::config::Config;
use crate::cookies::CookieStore;
use crate::db::Db;
use crate::queue::Queue;
use axum::routing::{get, post, put};
use axum::{extract::DefaultBodyLimit, middleware, Router};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Config,
    pub db: Db,
    pub archive: Archive,
    pub queue: Queue,
    pub cookies: CookieStore,
    pub ytdlp_version: String,
    pub errlog: crate::errlog::ErrorLog,
    pub stream_urls: crate::ytdlp::StreamUrlCache,
    pub subtitle_urls: crate::ytdlp::SubtitleCache,
}

pub fn router(state: AppState) -> Router {
    // Owner-only routes. Trusted client credentials are deliberately excluded:
    // clients may submit, but cannot read history or administer the server.
    let protected = Router::new()
        .route("/api/items", get(items::list))
        .route("/api/items/:slug", get(items::get).delete(items::delete))
        .route("/api/items/:slug/retry", post(items::retry))
        .route("/api/items/:slug/pause", post(items::pause))
        .route("/api/items/:slug/resume", post(items::resume))
        .route("/api/items/:slug/cancel", post(items::cancel))
        // Global pause/resume/cancel: one signal, the backend decides what it covers.
        .route("/api/queue/pause", post(items::pause_all))
        .route("/api/queue/resume", post(items::resume_all))
        .route("/api/queue/cancel", post(items::cancel_all))
        .route(
            "/api/items/:slug/resolutions",
            get(items::resolutions).put(items::set_resolutions),
        )
        .route("/api/items/:slug/public", post(items::set_public))
        // The subtitle *listing* is ordinary JSON the UI fetches through the
        // E2EE-aware client, so it authenticates like every other read route.
        // Serving a track itself can't (a <track> sends no headers) — that route
        // self-authorizes via `?token=` and lives in `public` below.
        .route("/api/items/:slug/subs", get(subs::list))
        .route("/api/stats", get(items::stats))
        .route("/api/logs", get(items::logs))
        .route(
            "/api/settings",
            get(items::get_settings).put(items::put_settings),
        )
        .route("/api/cookies", get(cookies::list))
        .route(
            "/api/cookies/:platform",
            put(cookies::set)
                .patch(cookies::toggle)
                .delete(cookies::delete),
        )
        // Website Management: the editable site registry (successor to /api/cookies).
        .route("/api/websites", get(websites::list))
        .route("/api/websites/merge", post(websites::merge))
        .route("/api/websites/validate", post(websites::validate))
        .route(
            "/api/websites/:key",
            put(websites::upsert).delete(websites::delete),
        )
        .route(
            "/api/websites/:key/cookies",
            post(websites::set_cookies)
                .patch(websites::toggle_cookies)
                .delete(websites::delete_cookies),
        )
        .route(
            "/api/archive",
            get(archive::list)
                .put(archive::replace)
                .post(archive::add)
                .delete(archive::remove),
        )
        .route("/api/archive/import", post(archive::import))
        .route("/api/archive/restore", post(archive::restore))
        .route("/api/clients", get(clients::list))
        .route("/api/clients/:id/trust", post(clients::trust))
        .route("/api/clients/:id", axum::routing::delete(clients::delete))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_owner,
        ));

    let submissions = Router::new()
        .route("/api/items", post(items::submit))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_submitter,
        ));

    // Public routes: health (no auth) + SSE (auth via ?token= inside) + static UI.
    // File streaming self-authorizes (token OR item.public), so it lives here.
    let registration = Router::new()
        .route("/api/clients/register", post(clients::register))
        .layer(DefaultBodyLimit::max(8 * 1024));

    let public = Router::new()
        .route("/api/health", get(items::health))
        .route("/api/events", get(events::events))
        .route("/api/items/:slug/file", get(media::file))
        // One subtitle track for the player's <track> elements. Self-authorizes
        // via `?token=` like /file, because a <track> can't send headers.
        .route("/api/items/:slug/subs/:lang", get(subs::get))
        // Online-playback proxy keyed by the item's unguessable slug (not its
        // enumerable id). Self-authorizes via the token, like /file.
        // Thumbnail proxy + on-disk cache, keyed by the item's unguessable slug.
        // Self-authorizes via `?token=` like /file, because an <img> sends no
        // headers. Keeps the browser from ever hitting the source CDN directly.
        .route("/api/items/:slug/thumb", get(media::thumb))
        .route("/api/stream/:slug", get(media::stream))
        .route("/api/stream/:slug/prepare", get(media::prepare_stream))
        .route("/api/p/:slug", get(media::public_file))
        .fallback(crate::web::static_handler);

    Router::new()
        .merge(protected)
        .merge(submissions)
        .merge(registration)
        .merge(public)
        // Allow the native app's webview origin (and browsers on other origins)
        // to call the API. Auth is a bearer token, not cookies, so permissive
        // (no credentials) is safe here.
        .layer(CorsLayer::permissive())
        .with_state(state)
}
