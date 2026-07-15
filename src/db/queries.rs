//! SQL query implementations. Workstream A owns this file. See docs/DATABASE.md.

use super::{Db, ListPage, ListQuery};
use crate::seal_import::{ImportOutcome, SealRecord};
use crate::types::{Client, Item, ItemResolution, ProbeResult, SiteCount, Source, Status, Website};
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
    let filepath: Option<String> = row.try_get("filepath")?;
    let local_available = filepath_exists(&filepath);

    Ok(Item {
        id: row.try_get("id")?,
        slug: row.try_get("resource_slug")?,
        extractor: row.try_get("extractor")?,
        video_id: row.try_get("video_id")?,
        archive_key: row.try_get("archive_key")?,
        title: row.try_get("title")?,
        uploader: row.try_get("uploader")?,
        webpage_url: row.try_get("webpage_url")?,
        thumbnail_url: row.try_get("thumbnail_url")?,
        duration: row.try_get("duration")?,
        filesize: row.try_get("filesize")?,
        height: row.try_get("height")?,
        source_max_height: row.try_get("source_max_height")?,
        source,
        status,
        error: row.try_get("error")?,
        created_at: row.try_get("created_at")?,
        completed_at: row.try_get("completed_at")?,
        public: row.try_get::<i64, _>("public")? != 0,
        public_slug: row.try_get("share_slug")?,
        public_until: row.try_get("public_until")?,
        public_hits: row.try_get("public_hits")?,
        playlist_index: row.try_get("playlist_index")?,
        total_filesize: row.try_get("total_filesize")?,
        filepath,
        local_available,
    })
}

/// True when `filepath` is set and points at a real file on disk.
fn filepath_exists(filepath: &Option<String>) -> bool {
    filepath
        .as_deref()
        .filter(|p| !p.is_empty())
        .map(|p| Path::new(p).is_file())
        .unwrap_or(false)
}

const SELECT_COLS: &str =
    "id, public_slug AS resource_slug, extractor, video_id, archive_key, title, uploader, \
    webpage_url, thumbnail_url, duration, filepath, filesize, height, source_max_height, source, \
    status, error, created_at, completed_at, public, share_slug, public_until, public_hits, \
    playlist_index, \
    COALESCE((SELECT SUM(filesize) FROM item_resolutions WHERE item_id = items.id), filesize, 0) \
      AS total_filesize";

/// Generate a 32-char (128-bit) hex slug from OS randomness.
fn random_slug() -> anyhow::Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| anyhow::anyhow!("cannot read randomness for item slug: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

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

    // Persist the source's available heights (CSV, highest first) captured by the
    // probe, so the resolution picker reads them without re-probing. Empty vec →
    // empty string ("probed, none reported"); distinguishes from NULL (never probed).
    let heights_csv = heights_to_csv(&p.available_heights);

    // Assign the unguessable private resource slug up front. Public sharing uses
    // a separate rotating capability (`share_slug`).
    let slug = random_slug()?;

    let result = sqlx::query(
        "INSERT INTO items \
         (extractor, video_id, archive_key, title, uploader, webpage_url, thumbnail_url, \
          duration, source, status, created_at, playlist_index, available_heights, public_slug) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(p.playlist_index)
    .bind(heights_csv)
    .bind(&slug)
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

pub(super) async fn set_completed(
    db: &Db,
    id: i64,
    path: &str,
    size: i64,
    height: Option<i64>,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE items SET filepath = ?, filesize = ?, height = ?, status = 'completed', \
         completed_at = ?, error = NULL WHERE id = ?",
    )
    .bind(path)
    .bind(size)
    .bind(height)
    .bind(now_unix())
    .bind(id)
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Serialize a height list to the stored CSV form ("1080,720,360").
fn heights_to_csv(heights: &[i64]) -> String {
    heights
        .iter()
        .map(|h| h.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// Parse the stored CSV back into a height list, dropping any non-numeric junk.
fn heights_from_csv(csv: &str) -> Vec<i64> {
    csv.split(',')
        .filter_map(|s| s.trim().parse::<i64>().ok())
        .filter(|h| *h > 0)
        .collect()
}

/// The source's available heights for an item, or `None` if never probed (the
/// column is NULL). An empty `Vec` means "probed, source reported no heights".
pub(super) async fn get_available_heights(db: &Db, id: i64) -> anyhow::Result<Option<Vec<i64>>> {
    let row = sqlx::query("SELECT available_heights FROM items WHERE id = ?")
        .bind(id)
        .fetch_optional(&db.pool)
        .await?;
    Ok(row
        .and_then(|r| r.get::<Option<String>, _>("available_heights"))
        .map(|csv| heights_from_csv(&csv)))
}

/// Cache the source's available heights (CSV) discovered by a (re-)probe.
pub(super) async fn set_available_heights(db: &Db, id: i64, heights: &[i64]) -> anyhow::Result<()> {
    sqlx::query("UPDATE items SET available_heights = ? WHERE id = ?")
        .bind(heights_to_csv(heights))
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

/// Repoint an item's primary file (the one played / streamed / shared) at its
/// highest currently-downloaded resolution variant, so the card always shows the
/// best version it holds. No-op when the item has no resolution rows (guards
/// against nulling the primary out — see the EXISTS clause).
pub(super) async fn repoint_primary(db: &Db, id: i64) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE items SET filepath = best.filepath, filesize = best.filesize, height = best.height \
         FROM (SELECT filepath, filesize, height FROM item_resolutions \
               WHERE item_id = ? ORDER BY height DESC LIMIT 1) AS best \
         WHERE items.id = ?",
    )
    .bind(id)
    .bind(id)
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Clear an item's primary file pointer (filepath / filesize / height → NULL),
/// turning it into a stream-only ("None" resolution) record: the DB entry stays,
/// but the card shows no local file and playback falls back to upstream streaming
/// (`/stream-url`). Used when the user purges an item's local downloads.
pub(super) async fn clear_primary(db: &Db, id: i64) -> anyhow::Result<()> {
    sqlx::query("UPDATE items SET filepath = NULL, filesize = NULL, height = NULL WHERE id = ?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

/// Mark a freshly-probed item as a stream-only ("None" mode) record: completed,
/// with no local file. Used when the global default resolution is "None" — the
/// entry is kept for browsing/streaming but nothing is downloaded.
pub(super) async fn mark_stream_only(db: &Db, id: i64) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE items SET status = 'completed', completed_at = ?, \
         filepath = NULL, filesize = NULL, height = NULL, error = NULL WHERE id = ?",
    )
    .bind(now_unix())
    .bind(id)
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// All downloaded resolution variants for an item, highest height first.
pub(super) async fn list_resolutions(db: &Db, item_id: i64) -> anyhow::Result<Vec<ItemResolution>> {
    let rows = sqlx::query(
        "SELECT height, filepath, filesize FROM item_resolutions \
         WHERE item_id = ? ORDER BY height DESC",
    )
    .bind(item_id)
    .fetch_all(&db.pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(ItemResolution {
            height: r.try_get("height")?,
            filepath: r.try_get("filepath")?,
            filesize: r.try_get("filesize")?,
        });
    }
    Ok(out)
}

/// Record (or replace) one downloaded resolution variant.
pub(super) async fn upsert_resolution(
    db: &Db,
    item_id: i64,
    height: i64,
    filepath: &str,
    filesize: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO item_resolutions (item_id, height, filepath, filesize, created_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(item_id, height) DO UPDATE SET \
           filepath = excluded.filepath, filesize = excluded.filesize",
    )
    .bind(item_id)
    .bind(height)
    .bind(filepath)
    .bind(filesize)
    .bind(now_unix())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Remove a resolution variant, returning its stored file path (so the caller
/// can delete the file). `None` if that height wasn't recorded.
pub(super) async fn delete_resolution(
    db: &Db,
    item_id: i64,
    height: i64,
) -> anyhow::Result<Option<String>> {
    let row = sqlx::query(
        "DELETE FROM item_resolutions WHERE item_id = ? AND height = ? RETURNING filepath",
    )
    .bind(item_id)
    .bind(height)
    .fetch_optional(&db.pool)
    .await?;
    row.map(|r| r.try_get("filepath"))
        .transpose()
        .map_err(Into::into)
}

/// Read a settings value by key (`None` if unset).
pub(super) async fn get_setting(db: &Db, key: &str) -> anyhow::Result<Option<String>> {
    let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(&db.pool)
        .await?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}

/// Upsert a settings value; `None` deletes the key (reverts to the default).
pub(super) async fn set_setting(db: &Db, key: &str, value: Option<&str>) -> anyhow::Result<()> {
    match value {
        Some(v) => {
            sqlx::query(
                "INSERT INTO settings (key, value) VALUES (?, ?) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(key)
            .bind(v)
            .execute(&db.pool)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM settings WHERE key = ?")
                .bind(key)
                .execute(&db.pool)
                .await?;
        }
    }
    Ok(())
}

// ---- Website registry (migration 0014) ----------------------------------

fn row_to_website(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<Website> {
    let hosts_csv: String = row.try_get("hosts")?;
    Ok(Website {
        key: row.try_get("key")?,
        name: row.try_get("name")?,
        hosts: crate::websites::parse_hosts(&hosts_csv),
        login_url: row.try_get("login_url")?,
        enabled: row.try_get::<i64, _>("enabled")? != 0,
        max_height: row.try_get("max_height")?,
        no_download: row.try_get::<i64, _>("no_download")? != 0,
        blur: row.try_get::<i64, _>("blur")? != 0,
        sort: row.try_get("sort")?,
        cookie: None,
    })
}

/// All websites, in display order (then name).
pub(super) async fn list_websites(db: &Db) -> anyhow::Result<Vec<Website>> {
    let rows = sqlx::query(
        "SELECT key, name, hosts, login_url, enabled, max_height, no_download, blur, sort \
         FROM websites ORDER BY sort, name",
    )
    .fetch_all(&db.pool)
    .await?;
    rows.iter().map(row_to_website).collect()
}

/// Insert or update a website (keyed by `key`). `hosts` is stored as CSV.
pub(super) async fn upsert_website(db: &Db, w: &Website) -> anyhow::Result<()> {
    let hosts = crate::websites::hosts_to_csv(&w.hosts);
    sqlx::query(
        "INSERT INTO websites (key, name, hosts, login_url, enabled, max_height, no_download, blur, sort, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET \
           name = excluded.name, hosts = excluded.hosts, login_url = excluded.login_url, \
           enabled = excluded.enabled, max_height = excluded.max_height, \
           no_download = excluded.no_download, blur = excluded.blur, sort = excluded.sort",
    )
    .bind(&w.key)
    .bind(&w.name)
    .bind(hosts)
    .bind(&w.login_url)
    .bind(w.enabled as i64)
    .bind(w.max_height)
    .bind(w.no_download as i64)
    .bind(w.blur as i64)
    .bind(w.sort)
    .bind(now_unix())
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Fetch one website by key.
pub(super) async fn get_website(db: &Db, key: &str) -> anyhow::Result<Option<Website>> {
    let row = sqlx::query(
        "SELECT key, name, hosts, login_url, enabled, max_height, no_download, blur, sort \
         FROM websites WHERE key = ?",
    )
    .bind(key)
    .fetch_optional(&db.pool)
    .await?;
    row.as_ref().map(row_to_website).transpose()
}

/// Rewrite a path segment across every stored filepath (item primaries and
/// resolution variants). Used after a site merge relocates a download folder, so
/// the DB keeps pointing at the moved files. `from`/`to` are folder segments like
/// `/OldSite/` → `/NewSite/`.
pub(super) async fn rewrite_filepaths(db: &Db, from: &str, to: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE items SET filepath = REPLACE(filepath, ?, ?) WHERE filepath LIKE ?")
        .bind(from)
        .bind(to)
        .bind(format!("%{from}%"))
        .execute(&db.pool)
        .await?;
    sqlx::query(
        "UPDATE item_resolutions SET filepath = REPLACE(filepath, ?, ?) WHERE filepath LIKE ?",
    )
    .bind(from)
    .bind(to)
    .bind(format!("%{from}%"))
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// Delete a website by key. Returns true if a row was removed.
pub(super) async fn delete_website(db: &Db, key: &str) -> anyhow::Result<bool> {
    let res = sqlx::query("DELETE FROM websites WHERE key = ?")
        .bind(key)
        .execute(&db.pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Aggregate download stats: `(count, total_bytes)` over items that have a
/// recorded filesize (i.e. actually-downloaded records).
pub(super) async fn download_stats(db: &Db) -> anyhow::Result<(i64, i64)> {
    let row =
        sqlx::query("SELECT COUNT(filesize) AS n, COALESCE(SUM(filesize), 0) AS bytes FROM items")
            .fetch_one(&db.pool)
            .await?;
    Ok((row.try_get("n")?, row.try_get("bytes")?))
}

/// Flip an item's public flag. Every enable rotates the public capability; revoke
/// clears it so a previously copied URL can never become live again.
pub(super) async fn set_public(
    db: &Db,
    id: i64,
    public: bool,
    until: Option<i64>,
) -> anyhow::Result<()> {
    if public {
        sqlx::query(
            "UPDATE items SET public = 1, share_slug = ?, \
             public_until = ? WHERE id = ?",
        )
        .bind(random_slug()?)
        .bind(until)
        .bind(id)
        .execute(&db.pool)
        .await?;
    } else {
        sqlx::query(
            "UPDATE items SET public = 0, share_slug = NULL, public_until = NULL, \
             public_hits = 0 WHERE id = ?",
        )
        .bind(id)
        .execute(&db.pool)
        .await?;
    }
    Ok(())
}

/// Record one external access to a public link. Best-effort: a failure here
/// must never block serving the file, so callers ignore the error.
pub(super) async fn bump_public_hits(db: &Db, id: i64) -> anyhow::Result<()> {
    sqlx::query("UPDATE items SET public_hits = public_hits + 1 WHERE id = ?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

/// Disaster-recovery sweep: flip lapsed shares back to private so an expired
/// link 404s even if it's never accessed. Returns the number of shares expired.
/// Run at startup and on a periodic timer; expired capabilities are discarded.
/// Zeroes the access tally like an explicit unshare — the count is scoped to the
/// live share window, so an expired share drops its capsule.
pub(super) async fn expire_public_shares(db: &Db) -> anyhow::Result<u64> {
    let res = sqlx::query(
        "UPDATE items SET public = 0, share_slug = NULL, public_until = NULL, public_hits = 0 \
         WHERE public = 1 AND public_until IS NOT NULL AND public_until <= ?",
    )
    .bind(now_unix())
    .execute(&db.pool)
    .await?;
    Ok(res.rows_affected())
}

pub(super) async fn find_by_public_slug(db: &Db, slug: &str) -> anyhow::Result<Option<Item>> {
    let row = sqlx::query(&format!(
        "SELECT {SELECT_COLS} FROM items WHERE share_slug = ?"
    ))
    .bind(slug)
    .fetch_optional(&db.pool)
    .await?;
    row.map(|r| row_to_item(&r)).transpose()
}

pub(super) async fn find_by_slug(db: &Db, slug: &str) -> anyhow::Result<Option<Item>> {
    let row = sqlx::query(&format!(
        "SELECT {SELECT_COLS} FROM items WHERE public_slug = ?"
    ))
    .bind(slug)
    .fetch_optional(&db.pool)
    .await?;
    row.map(|r| row_to_item(&r)).transpose()
}

pub(super) async fn get(db: &Db, id: i64) -> anyhow::Result<Option<Item>> {
    let row = sqlx::query(&format!("SELECT {SELECT_COLS} FROM items WHERE id = ?"))
        .bind(id)
        .fetch_optional(&db.pool)
        .await?;

    row.map(|r| row_to_item(&r)).transpose()
}

/// One bound value for a dynamically-built search clause.
enum Bind {
    Text(String),
    Int(i64),
}

fn is_field(f: &str) -> bool {
    matches!(
        f.to_ascii_lowercase().as_str(),
        "id" | "user" | "uploader" | "title" | "platform" | "site" | "extractor" | "status"
    )
}

/// Split a search string into tokens, honoring double-quoted phrases so
/// `title:"never gonna"` stays one token.
fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for c in s.chars() {
        match c {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn like_clause(negate: bool, col: &str) -> String {
    if negate {
        format!("({col} IS NULL OR {col} NOT LIKE ?)")
    } else {
        format!("{col} LIKE ?")
    }
}

/// Parse an e621-style query into SQL clauses (`AND`-joined) and ordered binds.
/// Supported prefixes: `id:`, `user:`/`uploader:`, `title:`, `platform:`/`site:`/
/// `extractor:`, `status:`. A leading `-` negates a term. A bare word that is
/// exactly a status keyword (`queued`/`running`/`completed`/`failed`/`duplicate`)
/// filters by status; every other bare word fuzzily matches title OR uploader OR
/// platform (alias-folded, so `x`/`twitter` both surface the twitter extractor).
fn build_search(q: &str) -> (Vec<String>, Vec<Bind>) {
    let mut clauses = Vec::new();
    let mut binds = Vec::new();

    for raw in tokenize(q) {
        let (negate, tok) = match raw.strip_prefix('-') {
            Some(rest) if !rest.is_empty() => (true, rest.to_string()),
            _ => (false, raw),
        };
        let (field, value) = match tok.split_once(':') {
            Some((f, v)) if is_field(f) && !v.is_empty() => (f.to_ascii_lowercase(), v.to_string()),
            // A lone status word (e.g. `failed`) acts as a status filter so the
            // old status chips fold into the search syntax; anything else is a
            // fuzzy term.
            _ if Status::parse(&tok.to_ascii_lowercase()).is_some() => {
                ("status".to_string(), tok.clone())
            }
            _ => ("any".to_string(), tok.clone()),
        };
        let like = format!("%{value}%");

        match field.as_str() {
            "id" => match value.parse::<i64>() {
                Ok(n) => {
                    clauses.push(if negate {
                        "id <> ?".into()
                    } else {
                        "id = ?".into()
                    });
                    binds.push(Bind::Int(n));
                }
                // Non-numeric id can never match.
                Err(_) => clauses.push("1=0".into()),
            },
            "status" => match Status::parse(&value.to_ascii_lowercase()) {
                Some(s) => {
                    clauses.push(if negate {
                        "status <> ?".into()
                    } else {
                        "status = ?".into()
                    });
                    binds.push(Bind::Text(s.as_str().to_string()));
                }
                // An unknown status can never match.
                None => clauses.push("1=0".into()),
            },
            "user" | "uploader" => {
                clauses.push(like_clause(negate, "uploader"));
                binds.push(Bind::Text(like));
            }
            "title" => {
                clauses.push(like_clause(negate, "title"));
                binds.push(Bind::Text(like));
            }
            "platform" | "site" | "extractor" => {
                // Fold platform aliases (x→twitter, ig→instagram, …) so a search
                // for the site the user knows matches yt-dlp's extractor naming.
                let terms = crate::platform::extractor_search_terms(&value);
                let terms = if terms.is_empty() {
                    vec![value.clone()]
                } else {
                    terms
                };
                let parts: Vec<String> = terms
                    .iter()
                    .map(|t| {
                        binds.push(Bind::Text(format!("%{t}%")));
                        like_clause(negate, "extractor")
                    })
                    .collect();
                let joiner = if negate { " AND " } else { " OR " };
                clauses.push(format!("({})", parts.join(joiner)));
            }
            _ => {
                // Bare word: fuzzy match across title, uploader AND platform. The
                // extractor term is alias-folded so `x`/`twitter` both hit the
                // twitter extractor without an explicit `platform:` prefix.
                let terms = crate::platform::extractor_search_terms(&value);
                let ext_terms = if terms.is_empty() {
                    vec![value.clone()]
                } else {
                    terms
                };
                if negate {
                    let mut parts = vec![
                        "title NOT LIKE ?".to_string(),
                        "(uploader IS NULL OR uploader NOT LIKE ?)".to_string(),
                    ];
                    binds.push(Bind::Text(like.clone()));
                    binds.push(Bind::Text(like.clone()));
                    for t in &ext_terms {
                        parts.push("(extractor IS NULL OR extractor NOT LIKE ?)".to_string());
                        binds.push(Bind::Text(format!("%{t}%")));
                    }
                    clauses.push(format!("({})", parts.join(" AND ")));
                } else {
                    let mut parts = vec!["title LIKE ?".to_string(), "uploader LIKE ?".to_string()];
                    binds.push(Bind::Text(like.clone()));
                    binds.push(Bind::Text(like.clone()));
                    for t in &ext_terms {
                        parts.push("extractor LIKE ?".to_string());
                        binds.push(Bind::Text(format!("%{t}%")));
                    }
                    clauses.push(format!("({})", parts.join(" OR ")));
                }
            }
        }
    }
    (clauses, binds)
}

pub(super) async fn list(db: &Db, q: ListQuery) -> anyhow::Result<ListPage> {
    let (search_clauses, search_binds) = match q.q.as_deref() {
        Some(s) if !s.trim().is_empty() => build_search(s),
        _ => (Vec::new(), Vec::new()),
    };

    let mut sql = format!("SELECT {SELECT_COLS} FROM items WHERE 1=1");
    if q.status.is_some() {
        sql.push_str(" AND status = ?");
    }
    for c in &search_clauses {
        sql.push_str(" AND ");
        sql.push_str(c);
    }
    if q.before_id.is_some() {
        sql.push_str(" AND id < ?");
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC LIMIT ?");

    let mut query = sqlx::query(&sql);
    if let Some(status) = q.status {
        query = query.bind(status.as_str().to_string());
    }
    for b in search_binds {
        query = match b {
            Bind::Text(t) => query.bind(t),
            Bind::Int(n) => query.bind(n),
        };
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
        // Explicitly clear resolution variants too: the FK is `ON DELETE CASCADE`
        // but SQLite only enforces it with `foreign_keys = ON` (off by default
        // here), so don't rely on it — remove the rows ourselves.
        sqlx::query("DELETE FROM item_resolutions WHERE item_id = ?")
            .bind(id)
            .execute(&db.pool)
            .await?;
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
    // Imported items get the same unguessable slug as freshly probed ones, so
    // their media URLs are never keyed by the enumerable sequential id.
    let slug = random_slug()?;
    sqlx::query(
        "INSERT INTO items \
         (extractor, video_id, archive_key, title, uploader, webpage_url, filepath, \
          source, status, created_at, completed_at, public_slug) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'seal-import', 'completed', ?, ?, ?)",
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
    .bind(&slug)
    .execute(&db.pool)
    .await?;

    Ok(ImportOutcome {
        imported: 1,
        ..Default::default()
    })
}

// ---- Clients (self-registered passphrase auth) ----------------------------

/// SHA-256 hex of a passphrase. We never store the passphrase itself.
pub(crate) fn hash_passphrase(passphrase: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(passphrase.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Register (or return the existing) client by passphrase. When `auto_trust` is
/// set (TOFU), a freshly seen passphrase is trusted immediately.
pub(super) async fn register_client(
    db: &Db,
    passphrase: &str,
    label: Option<&str>,
    auto_trust: bool,
) -> anyhow::Result<Client> {
    let hash = hash_passphrase(passphrase);
    sqlx::query(
        "INSERT INTO clients (passphrase_hash, label, trusted, created_at) \
         VALUES (?, ?, ?, ?) ON CONFLICT(passphrase_hash) DO NOTHING",
    )
    .bind(&hash)
    .bind(label)
    .bind(auto_trust as i64)
    .bind(now_unix())
    .execute(&db.pool)
    .await?;

    let row = sqlx::query("SELECT id FROM clients WHERE passphrase_hash = ?")
        .bind(&hash)
        .fetch_one(&db.pool)
        .await?;
    let id: i64 = row.try_get("id")?;
    load_client(db, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("client vanished after insert"))
}

/// Resolve a passphrase to a *trusted* client id, or `None` if unknown/untrusted.
pub(super) async fn find_trusted_client_id(
    db: &Db,
    passphrase: &str,
) -> anyhow::Result<Option<i64>> {
    let hash = hash_passphrase(passphrase);
    let row = sqlx::query("SELECT id FROM clients WHERE passphrase_hash = ? AND trusted = 1")
        .bind(&hash)
        .fetch_optional(&db.pool)
        .await?;
    Ok(row.map(|r| r.get::<i64, _>("id")))
}

/// Trusted client passphrase hashes used to resolve an E2EE key id without
/// sending the passphrase or its authentication hash over the network.
pub(super) async fn trusted_client_auth_hashes(db: &Db) -> anyhow::Result<Vec<(i64, String)>> {
    let rows = sqlx::query("SELECT id, passphrase_hash FROM clients WHERE trusted = 1")
        .fetch_all(&db.pool)
        .await?;
    rows.into_iter()
        .map(|row| Ok((row.try_get("id")?, row.try_get("passphrase_hash")?)))
        .collect()
}

/// Mark a client trusted. Returns false if no such client.
pub(super) async fn trust_client(db: &Db, id: i64) -> anyhow::Result<bool> {
    let res = sqlx::query("UPDATE clients SET trusted = 1 WHERE id = ?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Delete a client (and its counts via ON DELETE CASCADE). Returns false if absent.
pub(super) async fn delete_client(db: &Db, id: i64) -> anyhow::Result<bool> {
    let res = sqlx::query("DELETE FROM clients WHERE id = ?")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Increment a client's per-extractor submission tally.
pub(super) async fn bump_site_count(
    db: &Db,
    client_id: i64,
    extractor: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO client_site_counts (client_id, extractor, count) VALUES (?, ?, 1) \
         ON CONFLICT(client_id, extractor) DO UPDATE SET count = count + 1",
    )
    .bind(client_id)
    .bind(extractor)
    .execute(&db.pool)
    .await?;
    Ok(())
}

/// All clients with their per-extractor counts, newest first.
pub(super) async fn list_clients(db: &Db) -> anyhow::Result<Vec<Client>> {
    let rows = sqlx::query("SELECT id FROM clients ORDER BY created_at DESC, id DESC")
        .fetch_all(&db.pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        if let Some(c) = load_client(db, r.get::<i64, _>("id")).await? {
            out.push(c);
        }
    }
    Ok(out)
}

/// Load one client (metadata + site counts).
async fn load_client(db: &Db, id: i64) -> anyhow::Result<Option<Client>> {
    let row = sqlx::query("SELECT id, label, trusted, created_at FROM clients WHERE id = ?")
        .bind(id)
        .fetch_optional(&db.pool)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let sites = sqlx::query(
        "SELECT extractor, count FROM client_site_counts WHERE client_id = ? ORDER BY count DESC, extractor ASC",
    )
    .bind(id)
    .fetch_all(&db.pool)
    .await?
    .into_iter()
    .map(|r| SiteCount { extractor: r.get("extractor"), count: r.get("count") })
    .collect();
    Ok(Some(Client {
        id: row.get("id"),
        label: row.get("label"),
        trusted: row.get::<i64, _>("trusted") != 0,
        created_at: row.get("created_at"),
        sites,
    }))
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
            playlist_index: None,
            available_heights: vec![1080, 720, 360],
        }
    }

    async fn temp_db() -> (Db, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect(dir.path()).await.unwrap();
        (db, dir)
    }

    #[tokio::test]
    async fn client_tofu_trust_and_site_counts() {
        let (db, _dir) = temp_db().await;

        // TOFU on: first registration is trusted immediately and idempotent.
        let c = db
            .register_client("supersecret", Some("phone"), true)
            .await
            .unwrap();
        assert!(c.trusted);
        let again = db.register_client("supersecret", None, true).await.unwrap();
        assert_eq!(again.id, c.id, "same passphrase reuses the row");
        assert_eq!(
            db.find_trusted_client_id("supersecret").await.unwrap(),
            Some(c.id)
        );
        assert_eq!(db.find_trusted_client_id("wrong").await.unwrap(), None);

        // TOFU off: pending until explicitly trusted.
        let p = db
            .register_client("pendingpass", None, false)
            .await
            .unwrap();
        assert!(!p.trusted);
        assert_eq!(
            db.find_trusted_client_id("pendingpass").await.unwrap(),
            None
        );
        assert!(db.trust_client(p.id).await.unwrap());
        assert_eq!(
            db.find_trusted_client_id("pendingpass").await.unwrap(),
            Some(p.id)
        );

        // Per-extractor tally accrues and sorts by count desc.
        db.bump_site_count(c.id, "youtube").await.unwrap();
        db.bump_site_count(c.id, "youtube").await.unwrap();
        db.bump_site_count(c.id, "twitter").await.unwrap();
        let loaded = db.list_clients().await.unwrap();
        let mine = loaded.iter().find(|x| x.id == c.id).unwrap();
        assert_eq!(mine.sites[0].extractor, "youtube");
        assert_eq!(mine.sites[0].count, 2);
        assert_eq!(mine.sites[1].extractor, "twitter");

        // Revoke removes trust and cascades counts.
        assert!(db.delete_client(c.id).await.unwrap());
        assert_eq!(
            db.find_trusted_client_id("supersecret").await.unwrap(),
            None
        );
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

    #[test]
    fn tokenize_honors_quotes() {
        assert_eq!(tokenize("a b c"), vec!["a", "b", "c"]);
        assert_eq!(
            tokenize(r#"title:"never gonna" up"#),
            vec!["title:never gonna", "up"]
        );
        assert_eq!(tokenize("  spaced   out  "), vec!["spaced", "out"]);
    }

    #[test]
    fn build_search_maps_fields() {
        let (c, _) = build_search("id:42");
        assert_eq!(c, vec!["id = ?"]);
        let (c, _) = build_search("user:rick");
        assert_eq!(c, vec!["uploader LIKE ?"]);
        let (c, _) = build_search("platform:youtube");
        assert_eq!(c, vec!["(extractor LIKE ?)"]);
        // Alias folds to the canonical extractor token (x → twitter).
        let (c, b) = build_search("platform:x");
        assert_eq!(c, vec!["(extractor LIKE ?)"]);
        assert!(matches!(&b[0], Bind::Text(s) if s == "%twitter%"));
        // Bare word now also fuzzily matches the platform/extractor column.
        let (c, _) = build_search("hello");
        assert_eq!(
            c,
            vec!["(title LIKE ? OR uploader LIKE ? OR extractor LIKE ?)"]
        );
        // A bare platform name (no prefix) folds into the extractor branch.
        let (c, b) = build_search("twitter");
        assert_eq!(
            c,
            vec!["(title LIKE ? OR uploader LIKE ? OR extractor LIKE ?)"]
        );
        assert!(matches!(&b[2], Bind::Text(s) if s == "%twitter%"));
        // Bare `x` alias-folds to the twitter extractor term.
        let (_, b) = build_search("x");
        assert!(matches!(&b[2], Bind::Text(s) if s == "%twitter%"));
    }

    #[test]
    fn build_search_status_syntax() {
        // Bare status word folds into a status filter (the old chips).
        let (c, b) = build_search("failed");
        assert_eq!(c, vec!["status = ?"]);
        assert!(matches!(&b[0], Bind::Text(s) if s == "failed"));
        // Explicit prefix works too.
        let (c, _) = build_search("status:completed");
        assert_eq!(c, vec!["status = ?"]);
        // Negation flips to <>.
        let (c, _) = build_search("-failed");
        assert_eq!(c, vec!["status <> ?"]);
        // Unknown status never matches.
        let (c, _) = build_search("status:bogus");
        assert_eq!(c, vec!["1=0"]);
    }

    #[test]
    fn build_search_negation_and_bad_id() {
        let (c, _) = build_search("-title:spam");
        assert_eq!(c, vec!["(title IS NULL OR title NOT LIKE ?)"]);
        // Non-numeric id matches nothing.
        let (c, b) = build_search("id:notanumber");
        assert_eq!(c, vec!["1=0"]);
        assert!(b.is_empty());
    }

    #[tokio::test]
    async fn search_filters_by_field() {
        let (db, _dir) = temp_db().await;
        let mut p = probe("youtube", "yt1", "Rick Astley Video");
        p.uploader = Some("RickC".into());
        db.insert_probe(&p, Source::Download).await.unwrap();
        let mut p2 = probe("twitter", "tw1", "A cat clip");
        p2.uploader = Some("CatLover".into());
        db.insert_probe(&p2, Source::Download).await.unwrap();

        let by_platform = db
            .list(ListQuery {
                q: Some("platform:twitter".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_platform.items.len(), 1);
        assert_eq!(by_platform.items[0].video_id, "tw1");

        // Alias search: `x` resolves to the twitter extractor.
        let by_alias = db
            .list(ListQuery {
                q: Some("platform:x".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_alias.items.len(), 1);
        assert_eq!(by_alias.items[0].video_id, "tw1");

        // Bare platform word (no prefix) folds to the extractor: `x` → twitter.
        let bare = db
            .list(ListQuery {
                q: Some("x".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(bare.items.len(), 1);
        assert_eq!(bare.items[0].video_id, "tw1");

        // Bare status word filters by status (both items are queued on insert).
        let queued = db
            .list(ListQuery {
                q: Some("queued".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(queued.items.len(), 2);
        let failed = db
            .list(ListQuery {
                q: Some("failed".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(failed.items.is_empty());

        let by_user = db
            .list(ListQuery {
                q: Some("user:rickc".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_user.items.len(), 1);
        assert_eq!(by_user.items[0].uploader.as_deref(), Some("RickC"));

        let by_title = db
            .list(ListQuery {
                q: Some("title:cat".into()),
                limit: 50,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(by_title.items.len(), 1);
        assert_eq!(by_title.items[0].video_id, "tw1");
    }

    #[tokio::test]
    async fn insert_assigns_unguessable_slug() {
        // Every item gets a 32-hex-char (128-bit) slug at creation — so media URLs
        // key off the slug, never the enumerable sequential id — and it's usable
        // for lookup immediately, before any sharing.
        let (db, _dir) = temp_db().await;
        let a = db
            .insert_probe(&probe("youtube", "s1", "One"), Source::Download)
            .await
            .unwrap();
        let b = db
            .insert_probe(&probe("youtube", "s2", "Two"), Source::Download)
            .await
            .unwrap();
        let sa = a.slug.clone();
        let sb = b.slug.clone();
        assert_eq!(sa.len(), 32);
        assert!(sa.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(sa, sb, "slugs are random, not derived from the id");
        // Resolvable before the item is ever made public.
        assert!(!a.public);
        assert_eq!(db.find_by_slug(&sa).await.unwrap().unwrap().id, a.id);
        assert!(a.public_slug.is_none());
    }

    #[tokio::test]
    async fn set_public_rotates_share_capability_and_looks_up() {
        let (db, _dir) = temp_db().await;
        let p = probe("youtube", "pub1", "Public me");
        let item = db.insert_probe(&p, Source::Download).await.unwrap();
        assert!(!item.public);
        assert_eq!(item.slug.len(), 32);
        assert!(item.public_slug.is_none());

        db.set_public(item.id, true, None).await.unwrap();
        let pubd = db.get(item.id).await.unwrap().unwrap();
        assert!(pubd.public);
        assert!(pubd.public_until.is_none());
        let first_share = pubd.public_slug.clone().expect("share capability");
        assert_eq!(first_share.len(), 32);

        let found = db.find_by_public_slug(&first_share).await.unwrap().unwrap();
        assert_eq!(found.id, item.id);

        // Revocation destroys the capability.
        db.set_public(item.id, false, None).await.unwrap();
        let priv_again = db.get(item.id).await.unwrap().unwrap();
        assert!(!priv_again.public);
        assert!(priv_again.public_slug.is_none());
        assert!(db
            .find_by_public_slug(&first_share)
            .await
            .unwrap()
            .is_none());

        // Re-sharing creates a different capability and records the expiry.
        let until = now_unix() + 7 * 86400;
        db.set_public(item.id, true, Some(until)).await.unwrap();
        let reshared = db.get(item.id).await.unwrap().unwrap();
        assert_ne!(reshared.public_slug.as_deref(), Some(first_share.as_str()));
        assert_eq!(reshared.public_until, Some(until));

        // Unknown slug → None.
        assert!(db.find_by_public_slug("deadbeef").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn public_hits_increment_and_reset_on_unshare() {
        let (db, _dir) = temp_db().await;
        let item = db
            .insert_probe(&probe("youtube", "hits", "Counted"), Source::Download)
            .await
            .unwrap();
        assert_eq!(db.get(item.id).await.unwrap().unwrap().public_hits, 0);

        db.set_public(item.id, true, None).await.unwrap();
        db.bump_public_hits(item.id).await.unwrap();
        db.bump_public_hits(item.id).await.unwrap();
        assert_eq!(db.get(item.id).await.unwrap().unwrap().public_hits, 2);

        // Unsharing zeroes the tally — the count is scoped to the live share
        // window, so the capsule disappears once sharing stops.
        db.set_public(item.id, false, None).await.unwrap();
        assert_eq!(db.get(item.id).await.unwrap().unwrap().public_hits, 0);

        // Re-sharing starts a fresh count.
        db.set_public(item.id, true, None).await.unwrap();
        assert_eq!(db.get(item.id).await.unwrap().unwrap().public_hits, 0);
    }

    #[tokio::test]
    async fn expire_public_shares_flips_lapsed_only() {
        let (db, _dir) = temp_db().await;

        // Already-lapsed share.
        let lapsed = db
            .insert_probe(&probe("youtube", "old", "Lapsed"), Source::Download)
            .await
            .unwrap();
        db.set_public(lapsed.id, true, Some(now_unix() - 10))
            .await
            .unwrap();
        db.bump_public_hits(lapsed.id).await.unwrap();

        // Future-dated and permanent shares must survive the sweep.
        let future = db
            .insert_probe(&probe("youtube", "fut", "Future"), Source::Download)
            .await
            .unwrap();
        db.set_public(future.id, true, Some(now_unix() + 86400))
            .await
            .unwrap();
        let forever = db
            .insert_probe(&probe("youtube", "perm", "Forever"), Source::Download)
            .await
            .unwrap();
        db.set_public(forever.id, true, None).await.unwrap();

        let expired = db.expire_public_shares().await.unwrap();
        assert_eq!(expired, 1);
        assert!(!db.get(lapsed.id).await.unwrap().unwrap().public);
        assert!(db.get(future.id).await.unwrap().unwrap().public);
        assert!(db.get(forever.id).await.unwrap().unwrap().public);

        // Expiry destroys the public capability.
        assert!(db
            .get(lapsed.id)
            .await
            .unwrap()
            .unwrap()
            .public_slug
            .is_none());
        // Access tally zeroed on expiry — capsule drops once the share lapses.
        assert_eq!(db.get(lapsed.id).await.unwrap().unwrap().public_hits, 0);
    }

    #[tokio::test]
    async fn repoint_primary_tracks_highest_downloaded() {
        let (db, _dir) = temp_db().await;
        let item = db
            .insert_probe(&probe("youtube", "res1", "Multi res"), Source::Download)
            .await
            .unwrap();

        // Two downloaded variants → primary points at the highest (720).
        db.upsert_resolution(item.id, 360, "/d/v_360.mkv", 10)
            .await
            .unwrap();
        db.upsert_resolution(item.id, 720, "/d/v_720.mkv", 30)
            .await
            .unwrap();
        db.repoint_primary(item.id).await.unwrap();
        let hi = db.get(item.id).await.unwrap().unwrap();
        assert_eq!(hi.height, Some(720));
        assert_eq!(hi.filepath.as_deref(), Some("/d/v_720.mkv"));
        assert_eq!(hi.filesize, Some(30));

        // Drop 720 → primary falls back to the next-highest remaining (360).
        db.delete_resolution(item.id, 720).await.unwrap();
        db.repoint_primary(item.id).await.unwrap();
        let lo = db.get(item.id).await.unwrap().unwrap();
        assert_eq!(lo.height, Some(360));
        assert_eq!(lo.filepath.as_deref(), Some("/d/v_360.mkv"));

        // No resolution rows left → repoint is a no-op (never nulls the primary).
        db.delete_resolution(item.id, 360).await.unwrap();
        db.repoint_primary(item.id).await.unwrap();
        let kept = db.get(item.id).await.unwrap().unwrap();
        assert_eq!(kept.filepath.as_deref(), Some("/d/v_360.mkv"));
    }

    #[tokio::test]
    async fn total_filesize_sums_variants() {
        let (db, _dir) = temp_db().await;
        let item = db
            .insert_probe(&probe("youtube", "tot", "Totals"), Source::Download)
            .await
            .unwrap();
        // No variants yet, but a primary filesize is set → total falls back to it.
        db.set_completed(item.id, "/d/primary.mkv", 100, Some(720))
            .await
            .unwrap();
        assert_eq!(db.get(item.id).await.unwrap().unwrap().total_filesize, 100);
        // Two variants → total is their sum (independent of the primary filesize).
        db.upsert_resolution(item.id, 720, "/d/v720.mkv", 100)
            .await
            .unwrap();
        db.upsert_resolution(item.id, 360, "/d/v360.mkv", 25)
            .await
            .unwrap();
        assert_eq!(db.get(item.id).await.unwrap().unwrap().total_filesize, 125);
    }

    #[tokio::test]
    async fn available_heights_round_trip() {
        let (db, _dir) = temp_db().await;
        // insert_probe seeds available_heights from the probe (see the `probe` helper).
        let item = db
            .insert_probe(&probe("youtube", "ah", "Heights"), Source::Download)
            .await
            .unwrap();
        assert_eq!(
            db.get_available_heights(item.id).await.unwrap(),
            Some(vec![1080, 720, 360])
        );
        // A refresh overwrites the cache.
        db.set_available_heights(item.id, &[2160, 720])
            .await
            .unwrap();
        assert_eq!(
            db.get_available_heights(item.id).await.unwrap(),
            Some(vec![2160, 720])
        );
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
