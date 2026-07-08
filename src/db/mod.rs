//! Database handle: connect, migrate, and queries. See docs/DATABASE.md, docs/MODULES.md §3.

mod queries;

use crate::seal_import::{ImportOutcome, SealRecord};
use crate::types::{Item, ProbeResult, Source, Status};
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

    pub async fn set_completed(&self, id: i64, path: &str, size: i64) -> anyhow::Result<()> {
        queries::set_completed(self, id, path, size).await
    }

    pub async fn set_public(&self, id: i64, public: bool) -> anyhow::Result<()> {
        queries::set_public(self, id, public).await
    }

    pub async fn find_by_public_slug(&self, slug: &str) -> anyhow::Result<Option<Item>> {
        queries::find_by_public_slug(self, slug).await
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
}
