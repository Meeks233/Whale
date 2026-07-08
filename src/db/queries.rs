//! SQL query implementations. Workstream A owns this file. See docs/DATABASE.md.

use super::{Db, ListPage, ListQuery};
use crate::seal_import::{ImportOutcome, SealRecord};
use crate::types::{Item, ProbeResult, Source, Status};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::Row;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Map a row from the `items` table to an `Item`.
fn row_to_item(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<Item> {
    let status_str: String = row.try_get("status")?;
    let source_str: String = row.try_get("source")?;
    let status = Status::parse(&status_str)
        .ok_or_else(|| anyhow::anyhow!("unknown status in db: {status_str}"))?;
    let source = Source::parse(&source_str)
        .ok_or_else(|| anyhow::anyhow!("unknown source in db: {source_str}"))?;

    Ok(Item {
        id: row.try_get("id")?,
        extractor: row.try_get("extractor")?,
        video_id: row.try_get("video_id")?,
        archive_key: row.try_get("archive_key")?,
        title: row.try_get("title")?,
        uploader: row.try_get("uploader")?,
        webpage_url: row.try_get("webpage_url")?,
        thumbnail_url: row.try_get("thumbnail_url")?,
        duration: row.try_get("duration")?,
        filepath: row.try_get("filepath")?,
        filesize: row.try_get("filesize")?,
        source,
        status,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        completed_at: row.try_get("completed_at")?,
    })
}

const SELECT_COLS: &str = "id, extractor, video_id, archive_key, title, uploader, \
    webpage_url, thumbnail_url, duration, filepath, filesize, source, status, error, \
    created_at, completed_at";

pub(super) async fn connect(data_dir: &Path) -> anyhow::Result<Db> {
    let opts = SqliteConnectOptions::new()
        .filename(data_dir.join("whale.db"))
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new().connect_with(opts).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(Db { pool })
}

pub(super) async fn insert_probe(db: &Db, p: &ProbeResult, source: Source) -> anyhow::Result<Item> {
    let now = now_unix();
    let archive_key = p.archive_key();

    let result = sqlx::query(
        "INSERT INTO items \
         (extractor, video_id, archive_key, title, uploader, webpage_url, thumbnail_url, \
          duration, source, status, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&p.extractor)
    .bind(&p.video_id)
    .bind(&archive_key)
    .bind(&p.title)
    .bind(&p.uploader)
    .bind(&p.webpage_url)
    .bind(&p.thumbnail_url)
    .bind(p.duration)
    .bind(source.as_str())
    .bind(Status::Queued.as_str())
    .bind(now)
    .execute(&db.pool)
    .await?;

    let id = result.last_insert_rowid();
    get(db, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("inserted item {id} vanished"))
}

pub(super) async fn find_by_archive_key(db: &Db, key: &str) -> anyhow::Result<Option<Item>> {
    let row = sqlx::query(&format!(
        "SELECT {SELECT_COLS} FROM items WHERE archive_key = ?"
    ))
    .bind(key)
    .fetch_optional(&db.pool)
    .await?;

    row.map(|r| row_to_item(&r)).transpose()
}

pub(super) async fn set_status(
    db: &Db,
    id: i64,
    status: Status,
    err: Option<&str>,
) -> anyhow::Result<()> {
    sqlx::query("UPDATE items SET status = ?, error = ? WHERE id = ?")
        .bind(status.as_str())
        .bind(err)
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

pub(super) async fn set_completed(db: &Db, id: i64, path: &str, size: i64) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE items SET filepath = ?, filesize = ?, status = 'completed', \
         completed_at = ?, error = NULL WHERE id = ?",
    )
    .bind(path)
    .bind(size)
    .bind(now_unix())
    .bind(id)
    .execute(&db.pool)
    .await?;
    Ok(())
}

pub(super) async fn get(db: &Db, id: i64) -> anyhow::Result<Option<Item>> {
    let row = sqlx::query(&format!("SELECT {SELECT_COLS} FROM items WHERE id = ?"))
        .bind(id)
        .fetch_optional(&db.pool)
        .await?;

    row.map(|r| row_to_item(&r)).transpose()
}

pub(super) async fn list(db: &Db, q: ListQuery) -> anyhow::Result<ListPage> {
    let mut sql = format!("SELECT {SELECT_COLS} FROM items WHERE 1=1");
    if q.status.is_some() {
        sql.push_str(" AND status = ?");
    }
    if q.q.is_some() {
        sql.push_str(" AND (title LIKE ? OR uploader LIKE ?)");
    }
    if q.before_id.is_some() {
        sql.push_str(" AND id < ?");
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");

    let mut query = sqlx::query(&sql);
    if let Some(status) = q.status {
        query = query.bind(status.as_str().to_string());
    }
    if let Some(ref term) = q.q {
        let like = format!("%{term}%");
        query = query.bind(like.clone()).bind(like);
    }
    if let Some(before_id) = q.before_id {
        query = query.bind(before_id);
    }
    query = query.bind(q.limit);

    let rows = query.fetch_all(&db.pool).await?;
    let items: Vec<Item> = rows
        .iter()
        .map(row_to_item)
        .collect::<anyhow::Result<_>>()?;

    let next_cursor = if q.limit > 0 && items.len() as i64 == q.limit {
        items.last().map(|i| i.id)
    } else {
        None
    };

    Ok(ListPage { items, next_cursor })
}

pub(super) async fn delete(db: &Db, id: i64) -> anyhow::Result<Option<Item>> {
    let existing = get(db, id).await?;
    if existing.is_some() {
        sqlx::query("DELETE FROM items WHERE id = ?")
            .bind(id)
            .execute(&db.pool)
            .await?;
    }
    Ok(existing)
}

pub(super) async fn reset_running_to_queued(db: &Db) -> anyhow::Result<Vec<i64>> {
    let rows = sqlx::query("SELECT id FROM items WHERE status = 'running'")
        .fetch_all(&db.pool)
        .await?;
    let ids: Vec<i64> = rows
        .iter()
        .map(|r| r.try_get::<i64, _>("id"))
        .collect::<Result<_, _>>()?;

    if !ids.is_empty() {
        sqlx::query("UPDATE items SET status = 'queued' WHERE status = 'running'")
            .execute(&db.pool)
            .await?;
    }
    Ok(ids)
}

pub(super) async fn all_archive_keys(db: &Db) -> anyhow::Result<Vec<String>> {
    let rows = sqlx::query("SELECT archive_key FROM items")
        .fetch_all(&db.pool)
        .await?;
    rows.iter()
        .map(|r| r.try_get::<String, _>("archive_key").map_err(Into::into))
        .collect()
}

pub(super) async fn upsert_import(db: &Db, rec: SealRecord) -> anyhow::Result<ImportOutcome> {
    let video_id = rec.video_id.clone().unwrap_or_default();
    let archive_key = format!("{} {}", rec.extractor, video_id);

    if find_by_archive_key(db, &archive_key).await?.is_some() {
        return Ok(ImportOutcome {
            skipped_dupes: 1,
            ..Default::default()
        });
    }

    let now = now_unix();
    sqlx::query(
        "INSERT INTO items \
         (extractor, video_id, archive_key, title, uploader, webpage_url, filepath, \
          source, status, created_at, completed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'seal-import', 'completed', ?, ?)",
    )
    .bind(&rec.extractor)
    .bind(&video_id)
    .bind(&archive_key)
    .bind(&rec.title)
    .bind(&rec.author)
    .bind(&rec.url)
    .bind(&rec.path)
    .bind(now)
    .bind(now)
    .execute(&db.pool)
    .await?;

    Ok(ImportOutcome {
        imported: 1,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ProbeResult, Source};

    fn probe(extractor: &str, video_id: &str, title: &str) -> ProbeResult {
        ProbeResult {
            extractor: extractor.to_string(),
            video_id: video_id.to_string(),
            title: title.to_string(),
            uploader: Some("uploader".to_string()),
            thumbnail_url: None,
            duration: Some(42),
            webpage_url: format!("https://example.com/{video_id}"),
        }
    }

    async fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect(dir.path()).await.unwrap();
        (db, dir)
    }

    #[tokio::test]
    async fn insert_and_find_round_trip() {
        let (db, _dir) = temp_db().await;
        let p = probe("youtube", "abc123", "Hello");
        let item = db.insert_probe(&p, Source::Download).await.unwrap();

        assert_eq!(item.archive_key, "youtube abc123");
        assert_eq!(item.status, Status::Queued);
        assert_eq!(item.source, Source::Download);
        assert_eq!(item.duration, Some(42));

        let found = db
            .find_by_archive_key("youtube abc123")
            .await
            .unwrap()
            .expect("item should exist");
        assert_eq!(found.id, item.id);
        assert_eq!(found.title, "Hello");
    }

    #[tokio::test]
    async fn upsert_import_dedups() {
        let (db, _dir) = temp_db().await;
        let rec = SealRecord {
            title: "Old Video".to_string(),
            author: Some("Someone".to_string()),
            url: "https://example.com/watch?v=xyz".to_string(),
            path: "/data/old.mp4".to_string(),
            extractor: "youtube".to_string(),
            video_id: Some("xyz".to_string()),
        };

        let first = db.upsert_import(rec.clone()).await.unwrap();
        assert_eq!(first.imported, 1);
        assert_eq!(first.skipped_dupes, 0);

        let second = db.upsert_import(rec).await.unwrap();
        assert_eq!(second.imported, 0);
        assert_eq!(second.skipped_dupes, 1);

        let item = db
            .find_by_archive_key("youtube xyz")
            .await
            .unwrap()
            .expect("imported item should exist");
        assert_eq!(item.status, Status::Completed);
        assert_eq!(item.source, Source::SealImport);
        assert_eq!(item.filepath.as_deref(), Some("/data/old.mp4"));
    }

    #[tokio::test]
    async fn list_ordering_and_keyset_pagination() {
        let (db, _dir) = temp_db().await;
        // Insert 3 items; created_at may collide, so ordering falls back to id DESC.
        let mut ids = Vec::new();
        for n in 0..3 {
            let p = probe("youtube", &format!("vid{n}"), &format!("Title {n}"));
            ids.push(db.insert_probe(&p, Source::Download).await.unwrap().id);
        }

        // Page 1: limit 2, expect the two highest ids (newest first).
        let page1 = db
            .list(ListQuery {
                limit: 2,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page1.items.len(), 2);
        assert_eq!(page1.items[0].id, ids[2]);
        assert_eq!(page1.items[1].id, ids[1]);
        assert_eq!(page1.next_cursor, Some(ids[1]));

        // Page 2: follow cursor, expect the remaining item; no further cursor.
        let page2 = db
            .list(ListQuery {
                limit: 2,
                before_id: page1.next_cursor,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(page2.items.len(), 1);
        assert_eq!(page2.items[0].id, ids[0]);
        assert_eq!(page2.next_cursor, None);
    }

    #[tokio::test]
    async fn reset_running_returns_ids() {
        let (db, _dir) = temp_db().await;
        let p = probe("youtube", "run1", "Running one");
        let item = db.insert_probe(&p, Source::Download).await.unwrap();
        db.set_status(item.id, Status::Running, None).await.unwrap();

        let reset = db.reset_running_to_queued().await.unwrap();
        assert_eq!(reset, vec![item.id]);

        let after = db.get(item.id).await.unwrap().unwrap();
        assert_eq!(after.status, Status::Queued);

        // Nothing running now -> empty.
        assert!(db.reset_running_to_queued().await.unwrap().is_empty());
    }
}
