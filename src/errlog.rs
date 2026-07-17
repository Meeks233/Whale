//! In-memory ring buffer of recent operational errors (probe / download
//! failures) surfaced to the UI's diagnostics panel via `GET /api/logs`.
//!
//! Deliberately tiny and bounded: at most `CAPACITY` entries are retained, so it
//! can never grow unbounded on a long-lived server. Oldest entries are evicted
//! first; the API returns them newest-first. This complements — it does not
//! replace — the structured `tracing` logs, which remain the source of truth for
//! server-side debugging.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Most recent errors to retain (the goal: "record at most 90 error entries").
pub const CAPACITY: usize = 90;

/// How much a failure is Orca's fault, which is what the UI colours on.
///
/// The split is about *who can act on it*, not how loud it is: a `Warn` is a
/// dead end the user drove into (a private video, a link we don't support, a
/// login we have no cookies for) and Orca behaved correctly by refusing it. An
/// `Error` is Orca or its environment falling over (yt-dlp missing, a disk write
/// failing, a mux crashing) — nothing the user did caused it and nothing they
/// can do fixes it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// User-caused / expected refusal — amber in the UI.
    Warn,
    /// Orca or its environment broke — red in the UI.
    Error,
}

/// One recorded failure, shaped for direct JSON serialization to the UI.
#[derive(Clone, serde::Serialize)]
pub struct ErrorEntry {
    /// Unix seconds when the error was recorded.
    pub at: i64,
    /// Where it happened: `"probe"` (submit-time metadata read) or `"download"`.
    pub stage: &'static str,
    /// The URL involved (the canonicalized `webpage_url`).
    pub url: String,
    /// Detected platform key (e.g. `"twitter"`), or `"unknown"`.
    pub platform: String,
    /// The user-facing (already enriched) error message.
    pub message: String,
    /// Whose fault this was — drives the UI's amber/red treatment. Derived from
    /// `message`, so callers never have to classify by hand.
    pub severity: Severity,
}

/// Classify a failure message as user-caused (`Warn`) or Orca-caused (`Error`).
///
/// Matched case-insensitively against the enriched message. The default is
/// `Error`: an unrecognised failure is one we haven't proven is the user's
/// doing, and under-reporting our own breakage is the worse mistake — a red
/// entry that turns out to be benign costs a glance, an amber one that was
/// really a bug costs a bug report we never get.
pub fn classify(message: &str) -> Severity {
    let low = message.to_ascii_lowercase();

    // Orca/environment breakage wins over the user-caused needles below: a
    // message like "unsupported url" nested inside a yt-dlp crash is still our
    // crash, and these markers are far more specific than the generic ones.
    const OURS: &[&str] = &[
        "yt-dlp not available",
        "no such file or directory",
        "permission denied",
        "no space left",
        "disk quota exceeded",
        "read-only file system",
        "database is locked",
        "ffmpeg",
        "postprocessing",
        "panicked",
        "broken pipe",
    ];
    if OURS.iter().any(|n| low.contains(n)) {
        return Severity::Error;
    }

    // Dead ends the user drove into. Auth gating is deliberately included: Orca
    // did its job and told them to add cookies, which is a warning, not a bug.
    const THEIRS: &[&str] = &[
        // Login / age gating — mirrors ytdlp::looks_like_auth_required, plus the
        // hint text explain_error() appends.
        "requires login",
        "login required",
        "sign in",
        "log in",
        "requires authentication",
        "use --cookies",
        "--cookies-from-browser",
        "no video could be found in this tweet",
        "age-restricted",
        "nsfw",
        "private video",
        "private account",
        "account is temporarily locked",
        // The link itself is a dead end.
        "unsupported url",
        "is not a valid url",
        "unable to extract",
        "no video formats found",
        "video unavailable",
        "this video is not available",
        "requested content is not available",
        "this tweet is unavailable",
        "has been removed",
        "was deleted",
        "not found",
        "404",
        // Geo / paywall.
        "not available in your country",
        "geo restricted",
        "geo-restricted",
        "blocked in your country",
        "paid members",
        "subscribers only",
        // The user's own doing, literally.
        "cancelled",
        "canceled",
    ];
    if THEIRS.iter().any(|n| low.contains(n)) {
        return Severity::Warn;
    }

    Severity::Error
}

/// A cheaply-cloneable handle to the shared ring buffer.
#[derive(Clone)]
pub struct ErrorLog {
    inner: Arc<Mutex<VecDeque<ErrorEntry>>>,
}

impl ErrorLog {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VecDeque::with_capacity(CAPACITY))),
        }
    }

    /// Record one error, evicting the oldest when already at capacity.
    pub fn push(&self, stage: &'static str, url: &str, platform: &str, message: &str) {
        let entry = ErrorEntry {
            at: crate::types::now_unix(),
            stage,
            url: url.to_string(),
            platform: platform.to_string(),
            message: message.to_string(),
            severity: classify(message),
        };
        // Tolerate a poisoned lock: a panic elsewhere must not wedge error
        // recording (these critical sections are trivial and never panic).
        let mut q = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        while q.len() >= CAPACITY {
            q.pop_front();
        }
        q.push_back(entry);
    }

    /// Snapshot of all retained entries, newest first, for the API.
    pub fn snapshot(&self) -> Vec<ErrorEntry> {
        let q = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        q.iter().rev().cloned().collect()
    }
}

impl Default for ErrorLog {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_oldest_beyond_capacity() {
        let log = ErrorLog::new();
        for i in 0..(CAPACITY + 5) {
            log.push("probe", &format!("https://x.com/{i}"), "twitter", "boom");
        }
        let snap = log.snapshot();
        assert_eq!(snap.len(), CAPACITY);
        // Newest-first: the last pushed URL is at the front.
        assert_eq!(snap[0].url, format!("https://x.com/{}", CAPACITY + 4));
        // The oldest 5 were evicted; entry #5 is now the tail.
        assert_eq!(snap.last().unwrap().url, "https://x.com/5");
    }

    #[test]
    fn classifies_user_dead_ends_as_warn() {
        for msg in [
            "ERROR: Private video. Sign in if you've been granted access",
            "ERROR: Unsupported URL: https://example.com/page",
            "ERROR: Video unavailable",
            "ERROR: This video is not available in your country",
            "ERROR: [twitter] No video could be found in this tweet — X likely requires login for this content. Add your X account cookies in Settings → Cookies, then retry.",
            "ERROR: Unable to extract initial player response",
            "download cancelled",
        ] {
            assert_eq!(classify(msg), Severity::Warn, "expected Warn for {msg:?}");
        }
    }

    #[test]
    fn classifies_our_breakage_as_error() {
        for msg in [
            "yt-dlp not available: program not found",
            "ERROR: unable to open for writing: [Errno 28] No space left on device",
            "ERROR: Postprocessing: ffmpeg exited with code 1",
            "failed to write file: Permission denied (os error 13)",
            "database is locked",
        ] {
            assert_eq!(classify(msg), Severity::Error, "expected Error for {msg:?}");
        }
    }

    #[test]
    fn unrecognised_failures_default_to_error() {
        // The safe default: don't quietly downgrade something we can't explain.
        assert_eq!(classify("something inexplicable happened"), Severity::Error);
    }

    #[test]
    fn our_breakage_wins_over_user_needles() {
        // "Unsupported URL" nested inside an ffmpeg postprocessing crash is still
        // our crash — the specific marker must beat the generic one.
        assert_eq!(
            classify("ERROR: Postprocessing: ffmpeg died handling Unsupported URL"),
            Severity::Error
        );
    }

    #[test]
    fn push_records_the_derived_severity() {
        let log = ErrorLog::new();
        log.push(
            "probe",
            "https://x.com/1",
            "twitter",
            "ERROR: Private video",
        );
        log.push(
            "download",
            "https://x.com/2",
            "twitter",
            "yt-dlp not available",
        );
        let snap = log.snapshot();
        assert_eq!(snap[0].severity, Severity::Error);
        assert_eq!(snap[1].severity, Severity::Warn);
    }

    #[test]
    fn snapshot_is_newest_first() {
        let log = ErrorLog::new();
        log.push("probe", "a", "twitter", "first");
        log.push("download", "b", "youtube", "second");
        let snap = log.snapshot();
        assert_eq!(snap[0].message, "second");
        assert_eq!(snap[1].message, "first");
    }
}
