# Configuration

All configuration is via environment variables (12-factor; friendly to Docker). Loaded once
by `Config::from_env()` at startup. No config file in v1.

## Variables

| Env var | Default | Required | Meaning |
|---|---|---|---|
| `WHALE_TOKEN` | *(random)* | no | Static bearer token for all `/api/*` routes. If unset, a strong random 32-char token is generated at startup and logged (set it to keep a stable token). |
| `WHALE_CLIENT_TOFU` | `true` | no | Trust-on-first-use for self-registered clients: a client that POSTs a new passphrase to `/api/clients/register` is trusted immediately (single-user / private-network default). **Set `false` if Whale is reachable from untrusted networks** — clients then land pending until the owner approves them with the token via `POST /api/clients/:id/trust`. |
| `WHALE_BIND` | `0.0.0.0:8080` | no | Listen address. |
| `WHALE_PUBLIC_URL` | — | no | Canonical public base URL the server is reachable at (e.g. `https://whale.example.com`). Used to build share links so they carry the real domain regardless of the origin the UI was loaded from. Unset → links use the UI's own origin. Trailing slashes are trimmed. |
| `WHALE_DATA_DIR` | `/data` | no | Holds `whale.db`, `archive.txt`, import files, sidecars. Mount a volume. |
| `WHALE_DOWNLOAD_DIR` | `/downloads` | no | Output directory for finished media. Mount a volume. |
| `WHALE_CONCURRENCY` | `2` | no | Max simultaneous downloads (semaphore permits). Ignored while `WHALE_POLITE` is on (forced to 1). |
| `WHALE_POLITE` | `true` | no | Polite/sequential mode: run one download at a time and wait a random pause between them, so the arrival-ordered queue doesn't look like a batch downloader. Set `false` for parallel downloads. |
| `WHALE_SLEEP_MIN` | `2` | no | Lower bound (seconds) of the random inter-download pause in polite mode. |
| `WHALE_SLEEP_MAX` | `7` | no | Upper bound (seconds) of the random inter-download pause (clamped to ≥ `WHALE_SLEEP_MIN`). |
| `WHALE_SLEEP_REQUESTS` | — | no | yt-dlp `--sleep-requests`: seconds between HTTP requests within a job. Omitted if unset. |
| `WHALE_IMPERSONATE` | — | no | yt-dlp `--impersonate` target (e.g. `chrome`) for TLS/client-fingerprint spoofing. UA is not otherwise overridden. Omitted if unset. |
| `WHALE_CONCURRENT_FRAGMENTS` | `4` | no | yt-dlp `--concurrent-fragments`: parallel fragment threads per job (Seal-style multi-threaded download). `1` disables. |
| `WHALE_LIMIT_RATE` | `10M` | no | Total download-rate cap, split evenly across `WHALE_CONCURRENCY` jobs and passed as per-job `--limit-rate`. `0`/`none`/`off` disables. |
| `WHALE_CONTAINER` | `mkv` | no | `mkv` (default) or `mp4`. See DOWNLOAD_PIPELINE.md. |
| `WHALE_OUTPUT_TEMPLATE` | `%(uploader,channel\|Unknown)s - %(title).150B [%(id)s].%(ext)s` | no | yt-dlp `-o` template. |
| `WHALE_FORMAT` | `bv*+ba/b` | no | yt-dlp `-f` selector. |
| `WHALE_SUBS` | `true` | no | Download+embed all real subtitles. |
| `WHALE_AUTO_SUBS` | `false` | no | Also fetch auto-generated captions (`--write-auto-subs`). |
| `WHALE_SUB_LANGS` | `all,-live_chat` | no | `--sub-langs` value. |
| `WHALE_EMBED_THUMBNAIL` | `true` | no | `--embed-thumbnail`. |
| `WHALE_COOKIES` | — | no | Path to a cookies.txt for auth-gated sites. |
| `WHALE_YTDLP_PATH` | `yt-dlp` | no | Path/name of the yt-dlp binary. |
| `WHALE_LOG` | `info` | no | `tracing` filter (`RUST_LOG`-style also honored). |

## `Config` struct (shape for `config.rs`)

```rust
pub struct Config {
    pub token: String,
    pub token_generated: bool,         // true if token was auto-generated
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub download_dir: PathBuf,
    pub concurrency: usize,
    pub concurrent_fragments: usize,   // yt-dlp --concurrent-fragments
    pub limit_rate: Option<String>,    // total rate cap; None disables
    pub container: Container,          // enum { Mkv, Mp4 }
    pub output_template: String,
    pub format: String,
    pub subs: bool,
    pub auto_subs: bool,
    pub sub_langs: String,
    pub embed_thumbnail: bool,
    pub cookies: Option<PathBuf>,
    pub ytdlp_path: String,
    pub ffmpeg_location: Option<PathBuf>,
}
```
Derived paths (not env): `db_path = data_dir/"whale.db"`, `archive_path = data_dir/"archive.txt"`.

## Validation at startup

- `WHALE_TOKEN`: if unset, a random 32-char token is generated and logged at `warn`.
- `data_dir` and `download_dir` exist & are writable (create if missing).
- `yt-dlp --version` succeeds (log + expose in `/api/health`); warn if `ffmpeg` missing
  (needed for merge/embed).
- `container` parses to the enum; unknown value → hard error listing valid options.
