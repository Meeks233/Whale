//! In-memory dedup set backed by an append-only yt-dlp `--download-archive` file.
//! Workstream B owns this file. See docs/MODULES.md §3, docs/DATABASE.md §3.

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
            Err(e) => {
                return Err(e).with_context(|| format!("reading archive {}", path.display()))
            }
        };

        let file_existed = fs::metadata(path).await.is_ok();
        let on_disk: HashSet<String> = existing.iter().cloned().collect();

        let mut set: HashSet<String> = on_disk.clone();
        set.extend(seed);

        // Rewrite the file when the file is missing or its contents differ from the union.
        if !file_existed || set != on_disk {
            write_sorted(path, &set).await?;
        }

        Ok(Self {
            inner: std::sync::Arc::new(Inner {
                set: tokio::sync::Mutex::new(set),
                path: path.to_path_buf(),
            }),
        })
    }

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
