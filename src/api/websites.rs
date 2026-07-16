//! Website Management handlers — the DB-backed successor to the per-platform
//! cookies page. Lists the editable website registry (migration 0014) with each
//! site's cookie status merged in, and supports create/update/delete, enable/
//! disable, per-site cookie import, site merging (with download-folder migration),
//! and reachability validation. All routes require the bearer token.

use super::AppState;
use crate::error::{AppError, AppResult};
use crate::types::{CookieStatus, Website};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

/// GET /api/websites — the full registry, each site carrying its cookie status.
pub async fn list(State(state): State<AppState>) -> AppResult<Response> {
    let mut sites = state.db.list_websites().await.map_err(internal)?;
    for w in &mut sites {
        w.cookie = Some(cookie_status(&state, &w.key));
    }
    Ok(Json(json!({ "websites": sites })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct WebsiteBody {
    pub name: Option<String>,
    /// Free-form host list (comma/space/newline separated); deduped on save.
    pub hosts: Option<String>,
    pub login_url: Option<String>,
    pub enabled: Option<bool>,
    /// Per-site resolution cap; `0`/negative clears it (follow global).
    pub max_height: Option<i64>,
    /// Per-site merge container; an empty string clears it (follow global).
    pub container: Option<String>,
    /// Per-site subtitle capture; `null` is indistinguishable from "absent" in
    /// JSON, so clearing back to "follow global" uses `subs_global: true`.
    pub subs: Option<bool>,
    #[serde(default)]
    pub subs_global: bool,
    pub no_download: Option<bool>,
    pub blur: Option<bool>,
    pub sort: Option<i64>,
}

/// PUT /api/websites/:key — create or update a website. Merges the provided
/// fields onto the existing row (or sensible defaults for a brand-new site).
pub async fn upsert(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<WebsiteBody>,
) -> AppResult<Response> {
    let key = safe_key(&key)?;
    let existing = state.db.get_website(&key).await.map_err(internal)?;
    let base = existing.unwrap_or(Website {
        key: key.clone(),
        name: key.clone(),
        hosts: Vec::new(),
        login_url: String::new(),
        enabled: true,
        max_height: None,
        container: None,
        subs: None,
        no_download: false,
        blur: false,
        sort: 999,
        cookie: None,
    });
    let hosts = match body.hosts {
        Some(raw) => crate::websites::parse_hosts(&raw),
        None => base.hosts,
    };
    let w = Website {
        key: key.clone(),
        name: body
            .name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(base.name),
        hosts,
        login_url: body.login_url.unwrap_or(base.login_url),
        enabled: body.enabled.unwrap_or(base.enabled),
        max_height: match body.max_height {
            Some(h) if h > 0 => Some(h),
            Some(_) => None, // 0/negative explicitly clears the per-site cap
            None => base.max_height,
        },
        container: match body.container.as_deref().map(str::trim) {
            // Empty string explicitly clears the per-site container.
            Some("") => None,
            Some(c) => Some(
                crate::config::Container::parse(c)
                    .ok_or_else(|| {
                        AppError::BadRequest(format!(
                            "container '{c}' is invalid; valid options: {}",
                            crate::config::Container::valid_list()
                        ))
                    })?
                    .ext()
                    .to_string(),
            ),
            None => base.container,
        },
        subs: if body.subs_global {
            None // explicitly back to "follow global"
        } else {
            // Absent means "leave as-is"; present means pin it on/off.
            body.subs.or(base.subs)
        },
        no_download: body.no_download.unwrap_or(base.no_download),
        blur: body.blur.unwrap_or(base.blur),
        sort: body.sort.unwrap_or(base.sort),
        cookie: None,
    };
    state.db.upsert_website(&w).await.map_err(internal)?;
    Ok(Json(with_cookie(&state, w)).into_response())
}

/// DELETE /api/websites/:key — remove a website and its cookie jar.
pub async fn delete(State(state): State<AppState>, Path(key): Path<String>) -> AppResult<Response> {
    let key = safe_key(&key)?;
    let removed = state.db.delete_website(&key).await.map_err(internal)?;
    let _ = state.cookies.remove(&key); // best-effort cookie cleanup
    Ok(Json(json!({ "deleted": removed })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct CookieBody {
    pub cookies: String,
}

/// POST /api/websites/:key/cookies — import (replace) this site's cookies.
pub async fn set_cookies(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<CookieBody>,
) -> AppResult<Response> {
    let key = safe_key(&key)?;
    // The site's primary host lets a bare `name=value; …` header paste (which
    // carries no domain) attach to the right site.
    let default_domain = state
        .db
        .get_website(&key)
        .await
        .ok()
        .flatten()
        .and_then(|w| w.hosts.into_iter().next());
    state
        .cookies
        .set(&key, &body.cookies, default_domain.as_deref())
        .map_err(AppError::BadRequest)?;
    Ok(Json(json!({ "key": key, "cookie": cookie_status(&state, &key) })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct CookieToggle {
    pub enabled: bool,
}

/// PATCH /api/websites/:key/cookies — enable/disable existing cookies.
pub async fn toggle_cookies(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<CookieToggle>,
) -> AppResult<Response> {
    let key = safe_key(&key)?;
    if !state.cookies.status(&key).present {
        return Err(AppError::NotFound);
    }
    state
        .cookies
        .set_enabled(&key, body.enabled)
        .map_err(internal)?;
    Ok(Json(json!({ "key": key, "cookie": cookie_status(&state, &key) })).into_response())
}

/// DELETE /api/websites/:key/cookies — remove this site's cookies (keep the site).
pub async fn delete_cookies(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> AppResult<Response> {
    let key = safe_key(&key)?;
    state.cookies.remove(&key).map_err(internal)?;
    Ok(Json(json!({ "key": key, "cookie": cookie_status(&state, &key) })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct MergeBody {
    pub target: String,
    pub sources: Vec<String>,
}

/// POST /api/websites/merge — fold `sources` into `target`: union their hosts,
/// migrate each source's download folder into the target's, adopt a source cookie
/// if the target has none, then delete the sources. Handles the "different domains,
/// same site" duplicate cleanup.
pub async fn merge(
    State(state): State<AppState>,
    Json(body): Json<MergeBody>,
) -> AppResult<Response> {
    let target_key = safe_key(&body.target)?;
    let mut target = state
        .db
        .get_website(&target_key)
        .await
        .map_err(internal)?
        .ok_or(AppError::NotFound)?;

    for src_key in &body.sources {
        let src_key = safe_key(src_key)?;
        if src_key == target_key {
            continue;
        }
        let Some(src) = state.db.get_website(&src_key).await.map_err(internal)? else {
            continue;
        };
        // Union hosts (dedup happens in parse_hosts on the joined CSV).
        let joined = format!(
            "{},{}",
            crate::websites::hosts_to_csv(&target.hosts),
            crate::websites::hosts_to_csv(&src.hosts)
        );
        target.hosts = crate::websites::parse_hosts(&joined);
        // Migrate the source's download folder into the target's, best-effort.
        migrate_download_folder(&state, &src, &target);
        // Adopt the source cookie only if the target has none of its own.
        if !state.cookies.status(&target_key).present && state.cookies.status(&src_key).present {
            let _ = state.cookies.rename(&src_key, &target_key);
        }
        let _ = state.cookies.remove(&src_key);
        state.db.delete_website(&src_key).await.map_err(internal)?;
    }
    state.db.upsert_website(&target).await.map_err(internal)?;
    Ok(Json(with_cookie(&state, target)).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ValidateBody {
    /// A sample URL for the site (validates reachability + that cookies work).
    pub url: String,
}

/// POST /api/websites/validate — probe a sample URL with the site's resolved
/// cookie to confirm it's reachable and the cookies/settings are correct.
pub async fn validate(
    State(state): State<AppState>,
    Json(body): Json<ValidateBody>,
) -> AppResult<Response> {
    let url = crate::url_normalize::normalize(&body.url);
    if crate::net_guard::guard(&url, state.cfg.allow_private_dns)
        .await
        .is_err()
    {
        return Ok(Json(
            json!({ "ok": false, "error": "URL is not allowed (blocked host/scheme)" }),
        )
        .into_response());
    }
    let cookie = crate::cookies::resolve(&state.cookies, state.cfg.cookies.as_deref(), &url);
    match crate::ytdlp::probe(&state.cfg, &url, cookie.as_deref()).await {
        Ok(probes) if !probes.is_empty() => {
            let p = &probes[0];
            Ok(Json(json!({
                "ok": true,
                "extractor": p.extractor,
                "title": p.title,
                "had_cookies": cookie.is_some(),
            }))
            .into_response())
        }
        Ok(_) => {
            Ok(Json(json!({ "ok": false, "error": "no media found at that URL" })).into_response())
        }
        Err(e) => {
            let msg = crate::ytdlp::explain_error(&url, &e.to_string());
            Ok(Json(json!({ "ok": false, "error": msg })).into_response())
        }
    }
}

// ---- helpers -------------------------------------------------------------

/// Validate a website/cookie key is filesystem-safe (`[a-z0-9_]`), lowercasing it.
/// Guards against path traversal since the key becomes a cookie filename stem.
fn safe_key(key: &str) -> Result<String, AppError> {
    let k = key.trim().to_ascii_lowercase();
    if !k.is_empty()
        && k.len() <= 40
        && k.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        Ok(k)
    } else {
        Err(AppError::BadRequest(format!("invalid website key '{key}'")))
    }
}

fn cookie_status(state: &AppState, key: &str) -> CookieStatus {
    let st = state.cookies.status(key);
    CookieStatus {
        present: st.present,
        enabled: st.enabled,
        bytes: st.bytes,
        updated_at: st.updated_at,
        expires_at: st.expires_at,
    }
}

fn with_cookie(state: &AppState, mut w: Website) -> serde_json::Value {
    w.cookie = Some(cookie_status(state, &w.key));
    json!({ "website": w })
}

fn internal<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Internal(e.to_string())
}

/// Move a source website's on-disk download subfolder into the target's,
/// merging files, then rewrite affected item filepaths in the DB. Best-effort:
/// silently skips when the source folder doesn't exist.
fn migrate_download_folder(state: &AppState, src: &Website, target: &Website) {
    let root = &state.cfg.download_dir;
    let src_dir = root.join(folder_name(&src.name, &src.key));
    let dst_name = folder_name(&target.name, &target.key);
    let dst_dir = root.join(&dst_name);
    if !src_dir.is_dir() || src_dir == dst_dir {
        return;
    }
    let _ = std::fs::create_dir_all(&dst_dir);
    if let Ok(entries) = std::fs::read_dir(&src_dir) {
        for entry in entries.flatten() {
            let from = entry.path();
            let to = dst_dir.join(entry.file_name());
            let _ = std::fs::rename(&from, &to);
        }
    }
    let _ = std::fs::remove_dir(&src_dir);
    // Rewrite DB filepaths that pointed into the old folder. Fire-and-forget on a
    // clone so the merge response isn't blocked on the sweep.
    let db = state.db.clone();
    let src_seg = format!("/{}/", folder_name(&src.name, &src.key));
    let dst_seg = format!("/{dst_name}/");
    tokio::spawn(async move {
        let _ = db.rewrite_filepaths(&src_seg, &dst_seg).await;
    });
}

/// The download subfolder name Orca would use for a site (Title-cased key/name).
fn folder_name(name: &str, key: &str) -> String {
    let seed = if name.trim().is_empty() { key } else { name };
    let cleaned: String = seed.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if cleaned.is_empty() {
        return "Other".to_string();
    }
    let mut chars = cleaned.chars();
    chars
        .next()
        .map(|f| f.to_ascii_uppercase().to_string() + chars.as_str())
        .unwrap_or_else(|| "Other".to_string())
}
