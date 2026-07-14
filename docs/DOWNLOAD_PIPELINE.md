# Download pipeline (yt-dlp invocation, queue, progress)

## 1. yt-dlp: metadata probe

Command (built by `ytdlp::options::probe_args`):
```
yt-dlp --dump-json --skip-download --no-warnings --ignore-config \
       [--cookies <WHALE_COOKIES>] \
       <url>
```
- `--dump-json` prints one JSON object per video (playlists → one line each).
- Parse each line; map fields → `ProbeResult`:
  | ProbeResult | yt-dlp JSON key | notes |
  |---|---|---|
  | `extractor` | `extractor` | already lowercased (`youtube`) |
  | `video_id` | `id` | |
  | `title` | `title` | |
  | `uploader` | `uploader` else `channel` | either may be null |
  | `thumbnail_url` | `thumbnail` | single URL |
  | `duration` | `duration` | round to i64 seconds |
  | `webpage_url` | `webpage_url` | |
- Nonzero exit / no JSON → `YtdlpError::Probe(stderr_tail)` → API `422 probe_failed`.
- `--ignore-config` so host/user yt-dlp config never changes behavior (reproducible).

## 2. yt-dlp: download

Command (built by `ytdlp::options::download_args`), defaults reflecting the product spec:
```
yt-dlp \
  --ignore-config --no-warnings \
  -f "bv*+ba/b" \
  --merge-output-format mkv \
  --embed-subs --write-subs --sub-langs "all,-live_chat" \
  --embed-metadata --embed-thumbnail \
  --embed-chapters \
  -o "<WHALE_OUTPUT_TEMPLATE>" \
  --paths "home:<WHALE_DOWNLOAD_DIR>" --paths "temp:<WHALE_DOWNLOAD_DIR>/.part" \
  --download-archive "<WHALE_DATA_DIR>/archive.txt" \
  --no-simulate \
  --newline \
  --progress-template "download:__WHALE__%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s" \
  --print-to-file "after_move:filepath" "<data>/.last_path_<id>" \
  [--cookies <WHALE_COOKIES>] \
  [--write-auto-subs]                     # only if WHALE_AUTO_SUBS=true
  <webpage_url>
```

Rationale / notes:
- **Quality** `-f bv*+ba/b`: best video + best audio, fallback best combined.
- **Container** `--merge-output-format mkv` (default per design). If `WHALE_CONTAINER=mp4`,
  use `mp4` and accept mov_text subtitle conversion (documented tradeoff).
- **Subtitles**: `--write-subs --sub-langs "all,-live_chat"` downloads all real subs
  (excluding the noisy live-chat "subtitle"); `--embed-subs` muxes them in. Auto-generated
  captions are **off by default** (they explode to hundreds of auto-translated tracks with
  `all`); enable via `WHALE_AUTO_SUBS=true` → adds `--write-auto-subs`.
- **Filename** `-o` default:
  `%(uploader,channel|Unknown)s - %(title).150B [%(id)s].%(ext)s`
  (Seal-style author-title-[id]; `%(a,b|default)s` = altern: uploader, else channel, else
  literal "Unknown"; `.150B` truncates title to 150 bytes to stay under filesystem limits).
- **Archive** `--download-archive`: yt-dlp itself skips already-downloaded ids and writes new
  ones — a second safety net beyond Whale's own dedup. On `options.force=true`, **omit**
  `--download-archive` for that run so yt-dlp doesn't skip; Whale re-appends the key on success.
- **Progress** via `--newline --progress-template`: emit a machine-parseable line prefixed
  `__WHALE__` we can `starts_with`-detect and split on `|` → `(percent, speed, eta)`.
- **Final path capture** via `--print-to-file after_move:filepath`: yt-dlp writes the final
  post-merge/move path to a small sidecar file we read on success (robust vs. parsing stdout).
  `filesize` from `std::fs::metadata` on that path.
- **Temp isolation** via `--paths temp:...`: partial/`.part` files stay in `.part/` and are
  only moved into `WHALE_DOWNLOAD_DIR` when complete.

## 3. Progress parsing (`ytdlp::download`)

Spawn with `tokio::process::Command`, `stdout`/`stderr` piped, read stdout line-by-line:
```
for line in stdout.lines():
    if line.starts_with("__WHALE__"):
        let rest = &line["__WHALE__".len()..];
        let [pct, speed, eta] = rest.split('|');
        send ProgressEvent { id, status: Running,
                             percent: parse_percent(pct), speed: clean(speed), eta: clean(eta) }
```
- `_percent_str` looks like `" 63.4%"` → strip `%`/spaces → f32.
- `_speed_str` / `_eta_str` like `"4.02MiB/s"` / `"00:19"`; pass through, mapping yt-dlp's
  `"N/A"`/`"Unknown"` to `None`.
- On process exit: `0` → read sidecar path, `DownloadOutcome`; nonzero → `YtdlpError::Download`
  with the tail of stderr.

## 4. Job queue (`queue.rs`)

- `Queue::spawn(cfg, db, archive)` starts a worker loop and holds:
  - an `mpsc` channel of `item_id`s (the work queue),
  - a `tokio::sync::Semaphore` with `WHALE_CONCURRENCY` permits,
  - a `tokio::sync::broadcast::Sender<ProgressEvent>` for SSE fan-out.
- `enqueue(id)` pushes onto the mpsc. The loop pulls ids; for each, acquires a permit and
  spawns a task:
  ```
  db.set_status(id, Running)
  broadcast(ProgressEvent{ id, Running, .. })
  item = db.get(id)
  match ytdlp::download(cfg, item):
      Ok(out) => db.set_completed(id, out.filepath, out.filesize)
                 archive.insert(item.archive_key)
                 broadcast(Completed)
      Err(e)  => db.set_status(id, Failed, Some(e))
                 broadcast(Failed)
  drop(permit)
  ```
- Progress events from `download()`'s `mpsc::Receiver` are forwarded into the broadcast.
- **Backpressure**: the mpsc is unbounded (job ids are tiny); concurrency is bounded by the
  semaphore, not the channel.

## 5. Startup recovery

See DATABASE.md §4: reset `running`→`queued`, seed archive, re-enqueue. Because
`--download-archive` + `archive_key` are idempotent, re-running an interrupted job is safe.

## 6. yt-dlp / ffmpeg presence

- Path from `WHALE_YTDLP_PATH` (default `yt-dlp`).
- On `serve` startup, run `yt-dlp --version` once; log it and expose via `/api/health`. Fail
  fast with a clear error if yt-dlp is missing.
