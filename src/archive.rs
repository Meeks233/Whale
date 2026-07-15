//! In-memory dedup set backed by an append-only yt-dlp `--download-archive` file.
//! Persistent yt-dlp archive set. See docs/DATABASE.md.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::Context;
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
pub struct Archive {
    inner: std::sync::Arc<Inner>,
}

struct Inner {
    set: tokio::sync::Mutex<HashSet<String>>,
    path: PathBuf,
}

impl Archive {
    /// Read existing keys from `path` (if present), union with `seed`, and rewrite the file
    /// (sorted, one key per line) whenever the union differs from what's on disk. The parent
    /// directory is created if needed.
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

        let mut set: HashSet<String> = existing.iter().cloned().collect();
        set.extend(seed);

        // Rewrite whenever the file isn't already the canonical sorted-unique form:
        // this seeds new keys AND collapses any duplicate lines (yt-dlp's own
        // `--download-archive` write can coincide with an app-side record).
        let mut canonical: Vec<String> = set.iter().cloned().collect();
        canonical.sort();
        if !file_existed || existing != canonical {
            write_sorted(path, &set).await?;
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

    /// All dedup keys, sorted — for the manual archive editor.
    pub async fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.inner.set.lock().await.iter().cloned().collect();
        keys.sort();
        keys
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
        if set.remove(key) {
            write_sorted(&self.inner.path, &set).await?;
        }
        Ok(())
    }
}

/// Write `keys` to `path`, one per line, sorted for deterministic output.
async fn write_sorted(path: &Path, keys: &HashSet<String>) -> anyhow::Result<()> {
    let mut sorted: Vec<&String> = keys.iter().collect();
    sorted.sort();
    let mut body = String::new();
    for k in sorted {
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
        // Simulate the yt-dlp + app double-write: duplicate (and unsorted) lines.
        fs::write(&path, "twitter b\ntwitter a\ntwitter b\ntwitter a\n")
            .await
            .unwrap();

        let archive = Archive::load(&path, vec![]).await.unwrap();
        let contents = fs::read_to_string(&path).await.unwrap();
        // Canonicalized: sorted, one line each.
        assert_eq!(
            contents.lines().collect::<Vec<_>>(),
            vec!["twitter a", "twitter b"]
        );
        assert!(archive.contains("twitter a").await);
        assert!(archive.contains("twitter b").await);
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
