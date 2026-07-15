# Configuration

Environment variables are read at startup. Runtime resolution defaults are stored
in SQLite unless `WHALE_MAX_HEIGHT` pins them.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WHALE_TOKEN` | generated | Owner bearer token; generated value is logged at startup |
| `WHALE_ALLOW_WEAK_TOKEN` | `false` | Allow weak operator token for local development only |
| `WHALE_BIND` | `0.0.0.0:8080` | Server listen address inside the container |
| `WHALE_DATA_DIR` | `/data` | SQLite, archive, cookie, and state directory |
| `WHALE_DOWNLOAD_DIR` | `/downloads` | Download root and file-confinement boundary |
| `WHALE_PUBLIC_URL` | unset | Canonical HTTPS base used for public links |
| `WHALE_CLIENT_TOFU` | `false` | Automatically trust newly registered submit-only clients |
| `WHALE_ALLOW_PRIVATE_DNS` | `false` | Permit hostname DNS answers in reserved/private ranges for fake-IP proxies |
| `WHALE_CONCURRENCY` | `2` | Maximum jobs when polite mode is disabled |
| `WHALE_POLITE` | `true` | Serialize jobs and add an inter-download delay |
| `WHALE_SLEEP_MIN` / `WHALE_SLEEP_MAX` | `2` / `7` | Polite delay range in seconds |
| `WHALE_SLEEP_REQUESTS` | unset | yt-dlp delay between HTTP requests |
| `WHALE_CONCURRENT_FRAGMENTS` | `4` | yt-dlp fragments per job |
| `WHALE_LIMIT_RATE` | `10M` | Total rate cap; `0`, `none`, or `off` disables it |
| `WHALE_IMPERSONATE` | unset | yt-dlp client impersonation target |
| `WHALE_CONTAINER` | `mkv` | Output container: `mkv` or `mp4` |
| `WHALE_FORMAT` | `bv*+ba/b` | Custom yt-dlp format selector |
| `WHALE_MAX_HEIGHT` | unset | Positive pixel cap; `0`, `highest`, or `best` means uncapped |
| `WHALE_OUTPUT_TEMPLATE` | uploader/title/id | yt-dlp output template |
| `WHALE_SUBS` | `true` | Write/embed subtitles |
| `WHALE_AUTO_SUBS` | `false` | Include automatic subtitles |
| `WHALE_SUB_LANGS` | `all,-live_chat` | yt-dlp subtitle language expression |
| `WHALE_EMBED_THUMBNAIL` | `true` | Embed thumbnails |
| `WHALE_COOKIES` | unset | Global fallback cookies.txt path |
| `WHALE_YTDLP_PATH` | `yt-dlp` | yt-dlp executable |

`WHALE_FORMAT` is authoritative when explicitly set; Whale does not inject the
height cap into a custom selector. In polite mode effective concurrency is one.
The total rate limit is divided among effective concurrent jobs.
