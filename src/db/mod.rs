//! Database handle: connect, migrate, and queries. See docs/DATABASE.md.

mod queries;

use crate::seal_import::{ImportOutcome, SealRecord};
use crate::types::{Client, Item, ItemResolution, ProbeResult, Source, Status, Website};
use std::path::Path;

/// Query parameters for listing items (keyset pagination).
#[derive(Debug, Clone, Default)]
pub struct ListQuery {
    pub status: Option<Status>,
    pub q: Option<String>,
    pub limit: i64,
    pub before_id: Option<i64>,
}

/// One page of items plus the next keyset cursor.
#[derive(Debug, Clone)]
pub struct ListPage {
    pub items: Vec<Item>,
    pub next_cursor: Option<i64>,
}

#[derive(Clone)]
pub struct Db {
    pub(crate) pool: sqlx::SqlitePool,
}

impl Db {
    pub async fn connect(data_dir: &Path) -> anyhow::Result<Self> {
        queries::connect(data_dir).await
    }

    pub async fn insert_probe(&self, p: &ProbeResult, source: Source) -> anyhow::Result<Item> {
        queries::insert_probe(self, p, source).await
    }

    pub async fn find_by_archive_key(&self, key: &str) -> anyhow::Result<Option<Item>> {
        queries::find_by_archive_key(self, key).await
    }

    pub async fn set_status(
        &self,
        id: i64,
        status: Status,
        err: Option<&str>,
    ) -> anyhow::Result<()> {
        queries::set_status(self, id, status, err).await
    }

    pub async fn set_completed(
        &self,
        id: i64,
        path: &str,
        size: i64,
        height: Option<i64>,
    ) -> anyhow::Result<()> {
        queries::set_completed(self, id, path, size, height).await
    }

    /// The source's cached available heights, or `None` if never probed.
    pub async fn get_available_heights(&self, id: i64) -> anyhow::Result<Option<Vec<i64>>> {
        queries::get_available_heights(self, id).await
    }

    /// Cache the source's available heights discovered by a (re-)probe.
    pub async fn set_available_heights(&self, id: i64, heights: &[i64]) -> anyhow::Result<()> {
        queries::set_available_heights(self, id, heights).await
    }

    /// Repoint the item's primary file at its highest downloaded resolution.
    pub async fn repoint_primary(&self, id: i64) -> anyhow::Result<()> {
        queries::repoint_primary(self, id).await
    }

    /// Clear the item's primary file pointer (stream-only / "None" mode).
    pub async fn clear_primary(&self, id: i64) -> anyhow::Result<()> {
        queries::clear_primary(self, id).await
    }

    /// Mark a freshly-probed item as a completed stream-only record (no download).
    pub async fn mark_stream_only(&self, id: i64) -> anyhow::Result<()> {
        queries::mark_stream_only(self, id).await
    }

    /// All downloaded resolution variants for an item (highest first).
    pub async fn list_resolutions(&self, item_id: i64) -> anyhow::Result<Vec<ItemResolution>> {
        queries::list_resolutions(self, item_id).await
    }

    /// Record (or replace) one downloaded resolution variant.
    pub async fn upsert_resolution(
        &self,
        item_id: i64,
        height: i64,
        filepath: &str,
        filesize: i64,
    ) -> anyhow::Result<()> {
        queries::upsert_resolution(self, item_id, height, filepath, filesize).await
    }

    /// Remove a resolution variant, returning its file path for deletion.
    pub async fn delete_resolution(
        &self,
        item_id: i64,
        height: i64,
    ) -> anyhow::Result<Option<String>> {
        queries::delete_resolution(self, item_id, height).await
    }

    /// Read a runtime setting value by key (`None` if unset).
    pub async fn get_setting(&self, key: &str) -> anyhow::Result<Option<String>> {
        queries::get_setting(self, key).await
    }

    /// Upsert a runtime setting; `None` clears it (reverts to the default).
    pub async fn set_setting(&self, key: &str, value: Option<&str>) -> anyhow::Result<()> {
        queries::set_setting(self, key, value).await
    }

    /// Aggregate `(download_count, total_bytes)` across recorded downloads.
    pub async fn download_stats(&self) -> anyhow::Result<(i64, i64)> {
        queries::download_stats(self).await
    }

    /// All websites in the editable registry (display order).
    pub async fn list_websites(&self) -> anyhow::Result<Vec<Website>> {
        queries::list_websites(self).await
    }

    /// Fetch one website by key.
    pub async fn get_website(&self, key: &str) -> anyhow::Result<Option<Website>> {
        queries::get_website(self, key).await
    }

    /// Insert or update a website.
    pub async fn upsert_website(&self, w: &Website) -> anyhow::Result<()> {
        queries::upsert_website(self, w).await
    }

    /// Delete a website by key.
    pub async fn delete_website(&self, key: &str) -> anyhow::Result<bool> {
        queries::delete_website(self, key).await
    }

    /// Rewrite a folder path segment across all stored filepaths (after a merge).
    pub async fn rewrite_filepaths(&self, from: &str, to: &str) -> anyhow::Result<()> {
        queries::rewrite_filepaths(self, from, to).await
    }

    pub async fn set_public(
        &self,
        id: i64,
        public: bool,
        until: Option<i64>,
    ) -> anyhow::Result<()> {
        queries::set_public(self, id, public, until).await
    }

    /// Flip lapsed public shares back to private (disaster-recovery sweep).
    pub async fn expire_public_shares(&self) -> anyhow::Result<u64> {
        queries::expire_public_shares(self).await
    }

    /// Record one external access to a public link (best-effort).
    pub async fn bump_public_hits(&self, id: i64) -> anyhow::Result<()> {
        queries::bump_public_hits(self, id).await
    }

    pub async fn find_by_public_slug(&self, slug: &str) -> anyhow::Result<Option<Item>> {
        queries::find_by_public_slug(self, slug).await
    }

    /// Resolve an authenticated API resource by its unguessable slug.
    pub async fn find_by_slug(&self, slug: &str) -> anyhow::Result<Option<Item>> {
        queries::find_by_slug(self, slug).await
    }

    pub async fn get(&self, id: i64) -> anyhow::Result<Option<Item>> {
        queries::get(self, id).await
    }

    pub async fn list(&self, q: ListQuery) -> anyhow::Result<ListPage> {
        queries::list(self, q).await
    }

    pub async fn delete(&self, id: i64) -> anyhow::Result<Option<Item>> {
        queries::delete(self, id).await
    }

    pub async fn reset_running_to_queued(&self) -> anyhow::Result<Vec<i64>> {
        queries::reset_running_to_queued(self).await
    }

    pub async fn all_archive_keys(&self) -> anyhow::Result<Vec<String>> {
        queries::all_archive_keys(self).await
    }

    pub async fn upsert_import(&self, rec: SealRecord) -> anyhow::Result<ImportOutcome> {
        queries::upsert_import(self, rec).await
    }

    pub async fn register_client(
        &self,
        passphrase: &str,
        label: Option<&str>,
        auto_trust: bool,
    ) -> anyhow::Result<Client> {
        queries::register_client(self, passphrase, label, auto_trust).await
    }

    pub async fn find_trusted_client_id(&self, passphrase: &str) -> anyhow::Result<Option<i64>> {
        queries::find_trusted_client_id(self, passphrase).await
    }

    pub async fn trusted_client_auth_hashes(&self) -> anyhow::Result<Vec<(i64, String)>> {
        queries::trusted_client_auth_hashes(self).await
    }

    pub async fn trust_client(&self, id: i64) -> anyhow::Result<bool> {
        queries::trust_client(self, id).await
    }

    pub async fn delete_client(&self, id: i64) -> anyhow::Result<bool> {
        queries::delete_client(self, id).await
    }

    pub async fn bump_site_count(&self, client_id: i64, extractor: &str) -> anyhow::Result<()> {
        queries::bump_site_count(self, client_id, extractor).await
    }

    pub async fn list_clients(&self) -> anyhow::Result<Vec<Client>> {
        queries::list_clients(self).await
    }
}
