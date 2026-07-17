//! In-memory dedup set backed by an append-only yt-dlp `--download-archive` file.
//! Persistent yt-dlp archive set. See docs/DATABASE.md.

use indexmap::IndexSet;
use std::path::{Path, PathBuf};

use anyhow::Context;
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
pub struct Archive {
    inner: std::sync::Arc<Inner>,
}

struct Inner {
    /// Dedup keys in the order they were recorded — oldest line first, matching
    /// the append-only file on disk. An `IndexSet` rather than a `HashSet`: dedup
    /// still needs O(1) membership, but the order a key was archived in is real
    /// information (it's when you downloaded that video), and the editor lists
    /// keys newest-first off the back of it. A plain set threw that away and could
    /// only ever offer alphabetical.
    set: tokio::sync::Mutex<IndexSet<String>>,
    path: PathBuf,
}

impl Archive {
    /// Read existing keys from `path` (if present), append any `seed` keys not
    /// already recorded, and rewrite the file whenever the result differs from
    /// what's on disk. Record order is preserved: existing lines keep their
    /// position and seeds land after them. The parent directory is created if
    /// needed.
    pub async fn load(path: &Path, seed: Vec<String>) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)
                    .await
                    .with_context(|| format!("creating archive dir {}", parent.display()))?;
            }
        }

        // Read current on-disk contents (missing file == empty).
        let existing: Vec<String> = match fs::read_to_string(path).await {
            Ok(contents) => contents
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e).with_context(|| format!("reading archive {}", path.display())),
        };

        let file_existed = fs::metadata(path).await.is_ok();

        let mut set: IndexSet<String> = existing.iter().cloned().collect();
        set.extend(seed);

        // Rewrite whenever the file isn't already the canonical form — one unique
        // key per line, in record order. This seeds new keys AND collapses any
        // duplicate lines (yt-dlp's own `--download-archive` write can coincide
        // with an app-side record). Comparing against `existing` catches exactly
        // that: a de-duplicated or seeded set no longer matches the lines read.
        let canonical: Vec<&String> = set.iter().collect();
        if !file_existed || existing.iter().collect::<Vec<_>>() != canonical {
            write_keys(path, &set).await?;
        }

        Ok(Self {
            inner: std::sync::Arc::new(Inner {
                set: tokio::sync::Mutex::new(set),
                path: path.to_path_buf(),
            }),
        })
    }

    /// Membership check. Only the tests observe the in-memory set directly;
    /// production dedup goes through the DB, so this is test-only.
    #[cfg(test)]
    pub async fn contains(&self, key: &str) -> bool {
        self.inner.set.lock().await.contains(key)
    }

    /// All dedup keys, newest record first — the order the manual archive editor
    /// shows them in. Newest-first because the key you want to find (and delete,
    /// to re-download something) is nearly always one you just archived, and a
    /// growing list buries it at the bottom otherwise. This is the one place the
    /// order is flipped; on disk the file stays append-ordered.
    pub async fn keys(&self) -> Vec<String> {
        self.inner.set.lock().await.iter().rev().cloned().collect()
    }

    /// Add `key` to the set and append it to the file. Idempotent: inserting an existing key
    /// is a no-op and never duplicates a line.
    pub async fn insert(&self, key: &str) -> anyhow::Result<()> {
        let mut set = self.inner.set.lock().await;
        if set.insert(key.to_string()) {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.inner.path)
                .await
                .with_context(|| format!("opening archive {}", self.inner.path.display()))?;
            file.write_all(format!("{key}\n").as_bytes())
                .await
                .with_context(|| format!("appending to archive {}", self.inner.path.display()))?;
        }
        Ok(())
    }

    /// Record a key that yt-dlp already wrote to the archive file itself via
    /// `--download-archive` on a completed download. Updates the in-memory set
    /// ONLY — the line is already on disk, so appending here (as `insert` would)
    /// duplicates it. Keeps `keys()`/`remove()` consistent without a file write,
    /// so recording a finished download costs no extra I/O.
    pub async fn mark_downloaded(&self, key: &str) {
        self.inner.set.lock().await.insert(key.to_string());
    }

    /// Remove `key` from the set and rewrite the file from the remaining keys. Used by DELETE.
    pub async fn remove(&self, key: &str) -> anyhow::Result<()> {
        let mut set = self.inner.set.lock().await;
        // `shift_remove`, not `swap_remove`: the latter is O(1) but fills the hole
        // with the last element, which would shuffle an unrelated key to a new
        // position and corrupt the record order this set exists to keep.
        if set.shift_remove(key) {
            write_keys(&self.inner.path, &set).await?;
        }
        Ok(())
    }

    /// Path of the single previous version kept beside the archive.
    fn backup_path(&self) -> PathBuf {
        let mut name = self.inner.path.file_name().unwrap_or_default().to_os_string();
        name.push(".bak");
        self.inner.path.with_file_name(name)
    }

    /// Whether there is a previous version to roll back to.
    pub async fn has_backup(&self) -> bool {
        fs::metadata(self.backup_path()).await.is_ok()
    }

    /// Replace the whole set with `keys`, copying the current version aside first.
    ///
    /// The archive decides what Orca will and won't re-download, so a bad hand
    /// edit is destructive and not otherwise recoverable — the copy is what backs
    /// the UI's Restore. Returns the number of keys now recorded.
    /// `keys` arrives in the editor's display order (newest first), so it is
    /// reversed back into record order before storing — the file stays
    /// append-ordered, and a save round-trips to the same list it showed.
    pub async fn replace(&self, keys: Vec<String>) -> anyhow::Result<usize> {
        let mut set = self.inner.set.lock().await;
        self.snapshot().await?;
        *set = keys.into_iter().rev().collect();
        write_keys(&self.inner.path, &set).await?;
        Ok(set.len())
    }

    /// Roll back to the previous version. The version being rolled back *from*
    /// becomes the new backup, so Restore is itself undoable. Returns the restored
    /// keys in editor order (newest first), matching `keys()`.
    pub async fn restore(&self) -> anyhow::Result<Vec<String>> {
        let backup = self.backup_path();
        let body = fs::read_to_string(&backup)
            .await
            .with_context(|| format!("reading archive backup {}", backup.display()))?;
        let restored: IndexSet<String> = body
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();

        let mut set = self.inner.set.lock().await;
        self.snapshot().await?;
        *set = restored;
        write_keys(&self.inner.path, &set).await?;

        Ok(set.iter().rev().cloned().collect())
    }

    /// Copy the archive as it stands on disk to the backup slot. A missing
    /// archive (nothing recorded yet) leaves any existing backup alone rather
    /// than erasing the only recoverable version with an empty one.
    async fn snapshot(&self) -> anyhow::Result<()> {
        match fs::read(&self.inner.path).await {
            Ok(body) => {
                let backup = self.backup_path();
                fs::write(&backup, body)
                    .await
                    .with_context(|| format!("writing archive backup {}", backup.display()))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(e).with_context(|| {
                    format!("reading archive {} for backup", self.inner.path.display())
                })
            }
        }
        Ok(())
    }
}

/// Write `keys` to `path`, one per line, in record order — the same append-only
/// shape yt-dlp writes, so its own `--download-archive` appends stay consistent
/// with ours. Output is deterministic because `IndexSet` iteration is.
async fn write_keys(path: &Path, keys: &IndexSet<String>) -> anyhow::Result<()> {
    let mut body = String::new();
    for k in keys {
        body.push_str(k);
        body.push('\n');
    }
    fs::write(path, body)
        .await
        .with_context(|| format!("writing archive {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_seed_contains_insert_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");

        // Seed two keys -> file has them.
        let archive = Archive::load(
            &path,
            vec!["youtube aaa".to_string(), "youtube bbb".to_string()],
        )
        .await
        .unwrap();

        let contents = fs::read_to_string(&path).await.unwrap();
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines, vec!["youtube aaa", "youtube bbb"]); // sorted

        // contains true/false.
        assert!(archive.contains("youtube aaa").await);
        assert!(archive.contains("youtube bbb").await);
        assert!(!archive.contains("youtube ccc").await);

        // insert a new key -> contains true AND a fresh load sees it.
        archive.insert("youtube ccc").await.unwrap();
        assert!(archive.contains("youtube ccc").await);

        let reloaded = Archive::load(&path, vec![]).await.unwrap();
        assert!(reloaded.contains("youtube ccc").await);

        // insert existing key twice -> only one line for it.
        archive.insert("youtube ccc").await.unwrap();
        archive.insert("youtube ccc").await.unwrap();

        let contents = fs::read_to_string(&path).await.unwrap();
        let count = contents.lines().filter(|l| *l == "youtube ccc").count();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn load_collapses_duplicate_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");
        // Simulate the yt-dlp + app double-write: the same key written twice.
        fs::write(&path, "twitter b\ntwitter a\ntwitter b\ntwitter a\n")
            .await
            .unwrap();

        let archive = Archive::load(&path, vec![]).await.unwrap();
        let contents = fs::read_to_string(&path).await.unwrap();
        // Canonicalized: one line each, and each key holds the position it was
        // FIRST recorded at — collapsing duplicates must not reorder the archive.
        assert_eq!(
            contents.lines().collect::<Vec<_>>(),
            vec!["twitter b", "twitter a"]
        );
        assert!(archive.contains("twitter a").await);
        assert!(archive.contains("twitter b").await);
        // The editor reads it back newest-recorded first.
        assert_eq!(archive.keys().await, vec!["twitter a", "twitter b"]);
    }

    /// The editor shows newest-first, saves what it showed, and must get the same
    /// list back — i.e. `replace` un-reverses exactly what `keys` reversed. A
    /// half-applied flip here would silently invert the archive on every save.
    #[tokio::test]
    async fn editor_order_round_trips_through_replace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");
        // Recorded oldest → newest.
        fs::write(&path, "youtube old\nyoutube mid\nyoutube new\n")
            .await
            .unwrap();

        let archive = Archive::load(&path, vec![]).await.unwrap();
        let shown = archive.keys().await;
        assert_eq!(shown, vec!["youtube new", "youtube mid", "youtube old"]);

        // Save the list untouched: the file keeps its record order…
        archive.replace(shown.clone()).await.unwrap();
        let contents = fs::read_to_string(&path).await.unwrap();
        assert_eq!(
            contents.lines().collect::<Vec<_>>(),
            vec!["youtube old", "youtube mid", "youtube new"]
        );
        // …and the editor sees exactly what it sent.
        assert_eq!(archive.keys().await, shown);
    }

    #[tokio::test]
    async fn mark_downloaded_updates_set_without_appending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");
        // yt-dlp already wrote the line via --download-archive.
        fs::write(&path, "twitter x\n").await.unwrap();
        let archive = Archive::load(&path, vec![]).await.unwrap();

        // Mirroring it must NOT append a second line, but the set must know it so
        // a later remove() can rewrite the file without it.
        archive.mark_downloaded("twitter x").await;
        let contents = fs::read_to_string(&path).await.unwrap();
        assert_eq!(contents.lines().filter(|l| *l == "twitter x").count(), 1);

        archive.remove("twitter x").await.unwrap();
        let after = fs::read_to_string(&path).await.unwrap();
        assert!(
            after.lines().all(|l| l != "twitter x"),
            "delete frees the key"
        );
    }

    #[tokio::test]
    async fn replace_swaps_the_set_and_backs_up_the_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");
        let archive = Archive::load(&path, vec!["youtube aaa".into(), "youtube bbb".into()])
            .await
            .unwrap();
        assert!(!archive.has_backup().await, "nothing to roll back to yet");

        // A hand edit that drops a key and adds another.
        let count = archive
            .replace(vec!["youtube bbb".into(), "twitter ccc".into()])
            .await
            .unwrap();
        assert_eq!(count, 2);
        assert!(!archive.contains("youtube aaa").await, "dropped key frees up");
        assert!(archive.contains("twitter ccc").await);
        assert_eq!(
            fs::read_to_string(&path).await.unwrap().lines().collect::<Vec<_>>(),
            vec!["twitter ccc", "youtube bbb"]
        );

        // The version that was replaced is recoverable.
        assert!(archive.has_backup().await);
        assert_eq!(
            fs::read_to_string(dir.path().join("archive.txt.bak"))
                .await
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            vec!["youtube aaa", "youtube bbb"]
        );
    }

    #[tokio::test]
    async fn restore_rolls_back_and_is_itself_undoable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");
        let archive = Archive::load(&path, vec!["youtube aaa".into()]).await.unwrap();

        archive.replace(vec!["twitter ccc".into()]).await.unwrap();

        // Regret medicine: back to the pre-edit version.
        let keys = archive.restore().await.unwrap();
        assert_eq!(keys, vec!["youtube aaa".to_string()]);
        assert!(archive.contains("youtube aaa").await);
        assert!(!archive.contains("twitter ccc").await);
        // …and the version we rolled back FROM is now the backup, so a second
        // Restore returns to it rather than dead-ending.
        assert_eq!(archive.restore().await.unwrap(), vec!["twitter ccc".to_string()]);

        // The set survives a reload from disk, not just in memory.
        let reloaded = Archive::load(&path, vec![]).await.unwrap();
        assert!(reloaded.contains("twitter ccc").await);
    }

    #[tokio::test]
    async fn snapshot_of_a_missing_archive_keeps_the_existing_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");
        let archive = Archive::load(&path, vec!["youtube aaa".into()]).await.unwrap();
        archive.replace(vec!["youtube bbb".into()]).await.unwrap();

        // Archive file goes missing (wiped volume, manual delete). Replacing must
        // not overwrite the only recoverable version with an empty snapshot.
        fs::remove_file(&path).await.unwrap();
        archive.replace(vec!["youtube ccc".into()]).await.unwrap();

        assert_eq!(archive.restore().await.unwrap(), vec!["youtube aaa".to_string()]);
    }

    #[tokio::test]
    async fn remove_rewrites_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("archive.txt");
        let archive = Archive::load(&path, vec!["a".to_string(), "b".to_string()])
            .await
            .unwrap();

        archive.remove("a").await.unwrap();
        assert!(!archive.contains("a").await);

        let contents = fs::read_to_string(&path).await.unwrap();
        assert_eq!(contents.lines().collect::<Vec<_>>(), vec!["b"]);
    }
}
