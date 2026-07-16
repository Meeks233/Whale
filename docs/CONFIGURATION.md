# Configuration

Environment variables are read at startup. Runtime resolution defaults are stored
in SQLite unless `ORCA_MAX_HEIGHT` pins them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORCA_TOKEN` | generated | Owner bearer token; generated value is logged at startup |
| `ORCA_ALLOW_WEAK_TOKEN` | `false` | Allow weak operator token for local development only |
| `ORCA_BIND` | `0.0.0.0:8080` | Server listen address inside the container |
| `ORCA_DATA_DIR` | `/data` | SQLite, archive, cookie, and state directory |
| `ORCA_DOWNLOAD_DIR` | `/downloads` | Download root and file-confinement boundary |
| `ORCA_PUBLIC_URL` | unset | Canonical HTTPS base used for public links |
| `ORCA_CLIENT_TOFU` | `false` | Automatically trust newly registered submit-only clients |
| `ORCA_ALLOW_PRIVATE_DNS` | `false` | Permit hostname DNS answers in reserved/private ranges for fake-IP proxies |
| `ORCA_CONCURRENCY` | `2` | Maximum jobs when polite mode is disabled |
| `ORCA_POLITE` | `true` | Serialize jobs and add an inter-download delay |
| `ORCA_SLEEP_MIN` / `ORCA_SLEEP_MAX` | `2` / `7` | Polite delay range in seconds |
| `ORCA_SLEEP_REQUESTS` | unset | yt-dlp delay between HTTP requests |
| `ORCA_CONCURRENT_FRAGMENTS` | `4` | yt-dlp fragments per job |
| `ORCA_LIMIT_RATE` | `10M` | Total rate cap; `0`, `none`, or `off` disables it |
| `ORCA_IMPERSONATE` | unset | yt-dlp client impersonation target |
| `ORCA_CONTAINER` | `mkv` | Output container: `mkv`, `mp4`, `webm`, `mov`, `avi`, or `flv`. When set, it overrides the global and per-site pickers in the UI |
| `ORCA_FORMAT` | `bv*+ba/b` | Custom yt-dlp format selector |
| `ORCA_MAX_HEIGHT` | unset | Positive pixel cap; `0`, `highest`, or `best` means uncapped |
| `ORCA_OUTPUT_TEMPLATE` | uploader/title/id | yt-dlp output template |
| `ORCA_SUBS` | `true` | Write/embed subtitles. When set, it overrides the global and per-site pickers in the UI |
| `ORCA_AUTO_SUBS` | `false` | Include automatic subtitles |
| `ORCA_SUB_LANGS` | `all,-live_chat` | yt-dlp subtitle language expression |
| `ORCA_EMBED_THUMBNAIL` | `true` | Embed thumbnails |
| `ORCA_COOKIES` | unset | Global fallback cookies.txt path |
| `ORCA_YTDLP_PATH` | `yt-dlp` | yt-dlp executable |

`ORCA_FORMAT` is authoritative when explicitly set; Orca does not inject the
height cap into a custom selector. In polite mode effective concurrency is one.
The total rate limit is divided among effective concurrent jobs.
