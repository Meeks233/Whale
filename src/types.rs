//! Shared serde DTOs — the API/DB contract types. See docs/MODULES.md §2.
//!
//! Do not change field names without updating API.md and DATABASE.md.

use serde::{Deserialize, Serialize};

/// Current Unix time in seconds (wall clock). Shared by the API (share expiry)
/// and the DB layer so timestamps are computed identically everywhere.
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// True while `item` is publicly reachable: flagged public and not past its
/// expiry (a `None` expiry means the share is permanent).
pub fn is_public_live(item: &Item) -> bool {
    item.public && item.public_until.is_none_or(|until| until > now_unix())
}

/// Lifecycle status of an item (also the DB `status` column).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Running,
    Completed,
    Failed,
    Duplicate,
}

impl Status {
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Queued => "queued",
            Status::Running => "running",
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::Duplicate => "duplicate",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "queued" => Some(Status::Queued),
            "running" => Some(Status::Running),
            "completed" => Some(Status::Completed),
            "failed" => Some(Status::Failed),
            "duplicate" => Some(Status::Duplicate),
            _ => None,
        }
    }
}

/// Where a record came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Download,
    SealImport,
}

impl Source {
    pub fn as_str(&self) -> &'static str {
        match self {
            Source::Download => "download",
            Source::SealImport => "seal-import",
        }
    }

    pub fn parse(s: &str) -> Option<Source> {
        match s {
            "download" => Some(Source::Download),
            "seal-import" => Some(Source::SealImport),
            _ => None,
        }
    }
}

/// One media record — the canonical row shape returned by the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: i64,
    pub extractor: String,
    pub video_id: String,
    pub archive_key: String,
    pub title: String,
    pub uploader: Option<String>,
    pub webpage_url: String,
    pub thumbnail_url: Option<String>,
    pub duration: Option<i64>,
    pub filepath: Option<String>,
    pub filesize: Option<i64>,
    pub source: Source,
    pub status: Status,
    pub error: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    /// When true, the media file streams without a token (shareable direct link).
    pub public: bool,
    /// Random, unguessable slug for the public link (`/api/p/:slug`). Set the
    /// first time an item is made public; `None` until then.
    pub public_slug: Option<String>,
    /// Unix timestamp when the public share auto-expires. `None` while public
    /// means a permanent share; ignored when `public` is false.
    pub public_until: Option<i64>,
    /// Count of external (tokenless) accesses to the public link. Persists across
    /// unshare/re-share so the owner can spot an abused link even after revoking.
    #[serde(default)]
    pub public_hits: i64,
    /// Computed (not stored): whether `filepath` currently points at a real file
    /// on disk. `false` when the local copy was pruned/backed away — the UI shows
    /// a cloud badge and falls back to upstream streaming (`/stream-url`).
    #[serde(default)]
    pub local_available: bool,
}

/// A self-registered client that authenticates with its own passphrase instead
/// of the owner token. Only the passphrase hash is ever stored/returned.
#[derive(Debug, Clone, Serialize)]
pub struct Client {
    pub id: i64,
    pub label: Option<String>,
    pub trusted: bool,
    pub created_at: i64,
    /// Per-extractor submission tally, most-submitted first.
    pub sites: Vec<SiteCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SiteCount {
    pub extractor: String,
    pub count: i64,
}

/// Request body for POST /api/clients/register (self-registration).
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub passphrase: String,
    #[serde(default)]
    pub label: Option<String>,
}

/// Result of the metadata probe (yt-dlp --dump-json).
#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub extractor: String,
    pub video_id: String,
    pub title: String,
    pub uploader: Option<String>,
    pub thumbnail_url: Option<String>,
    pub duration: Option<i64>,
    pub webpage_url: String,
}

impl ProbeResult {
    pub fn archive_key(&self) -> String {
        format!("{} {}", self.extractor, self.video_id)
    }
}

/// Live progress emitted during a download (SSE + in-memory only).
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub id: i64,
    pub status: Status,
    pub percent: Option<f32>,
    pub speed: Option<String>,
    pub eta: Option<String>,
    /// Which sub-download this tick belongs to: `"video"` or `"audio"` for a
    /// split (`bv*+ba`) download, `None` for a single progressive file. Lets the
    /// UI label the two 0→100% passes instead of showing the bar "jump" back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

/// Request body for POST /api/items.
#[derive(Debug, Deserialize)]
pub struct SubmitRequest {
    pub url: String,
    #[serde(default)]
    pub options: Option<SubmitOptions>,
}

#[derive(Debug, Default, Deserialize)]
pub struct SubmitOptions {
    pub force: Option<bool>,
}

/// Response body for POST /api/items (single item form).
#[derive(Debug, Serialize)]
pub struct SubmitResponse {
    pub item: Item,
    pub duplicate: bool,
}
