//! Shared serde DTOs — the API/DB contract types. See docs/MODULES.md §2.
//!
//! Do not change field names without updating API.md and DATABASE.md.

use serde::{Deserialize, Serialize};

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
    pub audio_only: Option<bool>,
    pub force: Option<bool>,
}

/// Response body for POST /api/items (single item form).
#[derive(Debug, Serialize)]
pub struct SubmitResponse {
    pub item: Item,
    pub duplicate: bool,
}
