//! Shared serde DTOs for the API and database contracts. See docs/API.md.
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
    /// Held back rather than fetched: either the user pressed pause, or the
    /// storage cap left no room (see `queue::storage_state`). The record — and
    /// with it online playback via `/api/stream/:slug` — stays fully usable; only
    /// the local copy is deferred. Resuming re-enqueues, and yt-dlp picks the
    /// `.part` file back up where it stopped.
    Paused,
    Completed,
    Failed,
    Duplicate,
}

impl Status {
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Queued => "queued",
            Status::Running => "running",
            Status::Paused => "paused",
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::Duplicate => "duplicate",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "queued" => Some(Status::Queued),
            "running" => Some(Status::Running),
            "paused" => Some(Status::Paused),
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
    /// Random 128-bit resource identifier used by every authenticated item URL.
    /// The sequential database id remains internal and is never accepted in a path.
    pub slug: String,
    pub extractor: String,
    pub video_id: String,
    pub archive_key: String,
    pub title: String,
    pub uploader: Option<String>,
    pub webpage_url: String,
    pub thumbnail_url: Option<String>,
    pub duration: Option<i64>,
    #[serde(default, skip_serializing)]
    pub filepath: Option<String>,
    /// Computed (not stored): the basename of `filepath` — i.e. the exact name
    /// `/file?download=1` puts in `Content-Disposition`, and therefore the name
    /// the Android app writes into `Downloads/Orca`. Paired with `filesize` it is
    /// the fingerprint the app matches its folder listing against, so a copy
    /// saved by an older build (which predates the local-file registry) is still
    /// recognised as local. `None` when there is no local file.
    #[serde(default)]
    pub filename: Option<String>,
    pub filesize: Option<i64>,
    /// Downloaded video pixel height (e.g. 720, 1080, 2160), used to label the
    /// item's resolution in the UI. `None` for audio-only / not-yet-completed /
    /// imported records.
    pub height: Option<i64>,
    /// Highest pixel height the source offers, probed once (lazily, when the
    /// resolution picker is first opened) and cached so the picker needn't
    /// re-probe yt-dlp on every open. `None` until first probed.
    #[serde(default)]
    pub source_max_height: Option<i64>,
    pub source: Source,
    pub status: Status,
    pub error: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    /// When true, the media file streams without a token (shareable direct link).
    pub public: bool,
    /// Random, unguessable capability for the public link (`/api/p/:slug`). It is
    /// rotated on every share and cleared on revoke/expiry.
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
    /// Computed (not stored): total bytes across **all** downloaded resolution
    /// variants of this item (falls back to `filesize` when no variant rows
    /// exist). The size capsule shows this so a multi-resolution item reflects
    /// its combined on-disk footprint, not just the primary file.
    #[serde(default)]
    pub total_filesize: i64,
    /// 1-based position of this video within a multi-video post whose entries
    /// share one `webpage_url` (e.g. a tweet with two clips). Passed to yt-dlp as
    /// `--playlist-items` so download/stream targets only this video. `None` for a
    /// standalone item, where the URL already identifies a single video.
    #[serde(default)]
    pub playlist_index: Option<i64>,
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

/// One entry in the user-editable website registry (see migration
/// `0014_websites`). Powers the Website Management window: per-site cookies,
/// resolution cap, enable/disable, editable alternate domains, and merging.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Website {
    pub key: String,
    pub name: String,
    /// Registrable domain suffixes / aliases (a URL matches when its host equals
    /// or is a subdomain of any of these). Deduped on save.
    pub hosts: Vec<String>,
    pub login_url: String,
    pub enabled: bool,
    /// Per-site set of download heights as CSV (see `crate::resolution::HeightSet`);
    /// `None` follows the global `max_heights` setting. `Some("")` is the empty
    /// set — stream-only, no local files — which is why this is the sole source
    /// of truth for what used to be the separate `no_download` flag.
    #[serde(default)]
    pub max_heights: Option<String>,
    /// Per-site share-bandwidth cap (`"lowest"`/`"lower"`/`"higher"`/`"highest"`);
    /// `None` follows the global `stream_quality` setting.
    #[serde(default)]
    pub stream_quality: Option<String>,
    /// Per-site merge container (`"mkv"`, `"mp4"`, …); `None` follows the global
    /// container setting.
    #[serde(default)]
    pub container: Option<String>,
    /// Per-site subtitle capture; `None` follows the global `subs` setting.
    #[serde(default)]
    pub subs: Option<bool>,
    /// Per-site privacy blur: when set, this site's cards are blurred by default
    /// in the history and revealed on hover (web) / tap (app).
    #[serde(default)]
    pub blur: bool,
    #[serde(default)]
    pub sort: i64,
    /// Computed (not stored): cookie presence/state for this site, merged in by
    /// the API from the on-disk cookie jar. `None` in DB-only contexts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie: Option<CookieStatus>,
}

/// Cookie jar state for a website, surfaced to the management UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CookieStatus {
    pub present: bool,
    pub enabled: bool,
    pub bytes: u64,
    pub updated_at: i64,
    /// Earliest non-session cookie expiry (unix seconds), or `None` if the jar is
    /// all session cookies. The UI reminds the user near/after this time.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// One downloaded resolution variant of an item (see `item_resolutions`).
#[derive(Debug, Clone, Serialize)]
pub struct ItemResolution {
    pub height: i64,
    pub filepath: String,
    pub filesize: i64,
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
    /// 1-based position within a multi-entry probe, when yt-dlp reported one.
    /// Only meaningful (and only stored on the `Item`) when several entries share
    /// the same `webpage_url`; otherwise `None`. See `Item::playlist_index`.
    pub playlist_index: Option<i64>,
    /// Distinct video pixel heights the source offers, highest first, parsed from
    /// this probe's `formats` list. Captured up front (yt-dlp already enumerates
    /// formats to pick the default) so the resolution picker needn't re-probe.
    /// Empty when the source reported no per-format heights (e.g. audio-only).
    pub available_heights: Vec<i64>,
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
