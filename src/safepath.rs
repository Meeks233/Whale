//! Path-traversal guard for on-disk media files.
//!
//! Item file paths come from several sources — yt-dlp's post-move path, and,
//! crucially, the `videoPath` field of an imported Seal backup, which is fully
//! attacker-controllable. Serving or deleting a stored path verbatim lets a
//! crafted import point at `/etc/passwd` (readable tokenlessly once the item is
//! flipped public) or delete arbitrary files via `?delete_file=true`.
//!
//! [`confined_file`] is the single choke point: it canonicalizes the stored path
//! (resolving `..` and symlinks) and only returns it if it names a real file
//! **inside** the configured download root. Everything else — missing file,
//! null byte, absolute path elsewhere, symlink escaping the root — returns
//! `None`, which callers surface as 404 / no-op.

use std::path::{Path, PathBuf};

/// Return the canonical path of `stored` iff it resolves to an existing regular
/// file located within `root`. Returns `None` for a missing file, a null byte,
/// or any path that escapes `root` (via `..`, an absolute path, or a symlink).
pub fn confined_file(root: &Path, stored: &str) -> Option<PathBuf> {
    if stored.is_empty() || stored.as_bytes().contains(&0) {
        return None;
    }
    // canonicalize() resolves `..` and symlinks and requires the path to exist,
    // so a symlink pointing outside `root` is caught by the containment check.
    let canon_root = root.canonicalize().ok()?;
    let canon = Path::new(stored).canonicalize().ok()?;
    if !canon.starts_with(&canon_root) {
        return None;
    }
    if !canon.is_file() {
        return None;
    }
    Some(canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn accepts_file_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("video.mkv");
        fs::write(&f, b"data").unwrap();
        let got = confined_file(dir.path(), f.to_str().unwrap());
        assert_eq!(got, Some(f.canonicalize().unwrap()));
    }

    #[test]
    fn accepts_nested_file_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("a/b");
        fs::create_dir_all(&sub).unwrap();
        let f = sub.join("clip.mp4");
        fs::write(&f, b"x").unwrap();
        assert!(confined_file(dir.path(), f.to_str().unwrap()).is_some());
    }

    #[test]
    fn rejects_absolute_path_outside_root() {
        let dir = tempfile::tempdir().unwrap();
        // A real file that exists but lives outside the download root.
        assert_eq!(confined_file(dir.path(), "/etc/hostname"), None);
    }

    #[test]
    fn rejects_dotdot_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().parent().unwrap().join("secret.txt");
        fs::write(&outside, b"s").unwrap();
        let escape = format!("{}/../secret.txt", dir.path().display());
        assert_eq!(confined_file(dir.path(), &escape), None);
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn rejects_symlink_escaping_root() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().parent().unwrap().join("target.bin");
        fs::write(&outside, b"t").unwrap();
        let link = dir.path().join("inside.mkv");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(confined_file(dir.path(), link.to_str().unwrap()), None);
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn rejects_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.mkv");
        assert_eq!(confined_file(dir.path(), missing.to_str().unwrap()), None);
    }

    #[test]
    fn rejects_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            confined_file(dir.path(), dir.path().to_str().unwrap()),
            None
        );
    }

    #[test]
    fn rejects_empty_and_null_byte() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(confined_file(dir.path(), ""), None);
        assert_eq!(confined_file(dir.path(), "video\0.mkv"), None);
    }
}
