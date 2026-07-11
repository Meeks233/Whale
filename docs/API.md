# API contract (REST + SSE)

Base path: `/api`. Static UI is served at `/`. All JSON. This contract is **frozen** — the
frontend and any share-shortcuts depend on it.

## Auth

Two accepted credentials, both sent the same way (bearer header or `?token=`):

1. The owner token (`WHALE_TOKEN`).
2. A **trusted client passphrase** — self-registered via `POST /api/clients/register`
   (see below). Behaves exactly like the token on every `/api/*` route.

- Preferred: header `Authorization: Bearer <token-or-passphrase>`.
- For GET links / SSE / share shortcuts where headers are awkward: `?token=<...>`.
- Missing/wrong credential → `401 {"error":"unauthorized"}`.

The static UI assets (`GET /`, `/app.js`, `/manifest.webmanifest`, `/sw.js`, icons) are
**served without auth** (they contain no data); every `/api/*` route requires the token.

## Errors

Uniform shape: `{ "error": "<machine_code>", "message": "<human detail>" }`.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | malformed body / missing url |
| 401 | `unauthorized` | bad/missing token |
| 404 | `not_found` | unknown item id |
| 422 | `probe_failed` | yt-dlp couldn't extract metadata (unsupported/live/private) |
| 500 | `internal` | unexpected |

## Endpoints

### `POST /api/items` — submit a URL
Body: `SubmitRequest`
```json
{ "url": "https://youtu.be/dQw4w9WgXcQ", "options": { "force": false } }
```
Behavior: probe → dedup → enqueue (see ARCHITECTURE §3).
- `202 Accepted` with `SubmitResponse`:
```json
{ "item": { "id": 42, "extractor": "youtube", "video_id": "dQw4w9WgXcQ",
            "archive_key": "youtube dQw4w9WgXcQ", "title": "…", "uploader": "…",
            "webpage_url": "…", "thumbnail_url": "…", "duration": 213,
            "filepath": null, "filesize": null, "source": "download",
            "status": "queued", "error": null, "created_at": 1751961600,
            "completed_at": null },
  "duplicate": false }
```
- If already known: `200 OK`, same shape, `"duplicate": true`, `item` = the existing record
  (no new download). A queued/running in-flight item also returns `duplicate:true`.
- Probe failure: `422 {"error":"probe_failed","message":"<yt-dlp stderr summary>"}`.
- **Playlists**: a playlist URL yields multiple `ProbeResult`s. Response is
  `202` with `{ "items": [Item, …], "duplicates": <n> }` (array form). Clients should accept
  both single (`item`) and batch (`items`) shapes. (See ARCHITECTURE §6.)

### `GET /api/items` — list history
Query params:
- `status` — optional filter (`queued|running|completed|failed|duplicate`)
- `q` — optional e621-style search (combines with `status`). Supported prefixes:
  `id:`, `user:`/`uploader:`, `title:`, `platform:`/`site:`/`extractor:`. Prefix a term with
  `-` to negate it; quote phrases (`title:"never gonna"`). Bare words match title OR uploader.
- `limit` — default 50, max 200
- `before_id` — keyset cursor (return rows with `id < before_id`)

`200`:
```json
{ "items": [ Item, … ], "next_cursor": 17 }
```
`next_cursor` is `null` when the last page was reached.

### `GET /api/items/:id` — one item
`200` → `Item`, or `404`.

### `POST /api/items/:id/retry` — re-queue a failed item
Only valid when `status = failed`. Resets to `queued` and enqueues. `200` → `Item`.
`409 {"error":"bad_request"}` if not in a retryable state.

### `POST /api/items/:id/public` — set the public flag
Body `{ "public": true|false }`. Only valid when `status = completed` and a `filepath` exists.
Making an item public assigns a random `public_slug` (kept stable across re-shares) and returns it
on the `Item`; the shareable link is then `GET /api/p/:slug`. `200` → `Item`,
`400 {"error":"bad_request"}` if the item isn't a completed file, `404` if unknown.

### `GET /api/items/:id/file` — stream / download by id (token required)
Range-capable playback (used as the `<video>` source) and download, keyed by the sequential id.
**Requires a valid token** (`Authorization: Bearer` **or** `?token=`) — the id is never a tokenless
surface. Use `/api/p/:slug` for tokenless public sharing.
- Honors `Range`/`If-*` (returns `206 Partial Content`); `Content-Type` from the file extension.
- Add `?download=1` to force a browser save (`Content-Disposition: attachment`, RFC 5987 UTF-8 filename).
- `401` without a valid token; `400` if the item has no file yet; `404` if missing.

### `GET /api/items/:id/stream-url` — resolve upstream stream URL (token required)
For **online playback without downloading**, used when the local file is gone (backed away):
runs `yt-dlp -g` for a progressive HTTP format and returns `{ "url": "<direct media url>" }`.
The URL is short-lived and bound to the server's IP — resolve it fresh each time, don't cache.
`500 {"error":"internal"}` if resolution fails (unsupported/expired/geo-blocked).

> Item JSON carries a computed **`local_available`** boolean: `true` when `filepath` points at a
> real file on disk, `false` once the local copy is pruned. The UI shows a cloud badge and falls
> back to `/stream-url` when it's `false`.

### `GET/POST/DELETE /api/archive` — manual dedup editor (token required)
The dedup set uses **Seal's scheme**: one `"<extractor> <id>"` key per item (identical to yt-dlp
`--download-archive`). For ex-Seal users on top of the Seal-backup CLI import.
- `GET` → `{ "keys": ["youtube abc123", …] }` (sorted).
- `POST { "key": "youtube abc123" }` → add (idempotent). A future submit matching the key dedups.
  `400` if the key isn't shaped `extractor id`.
- `DELETE { "key": "youtube abc123" }` → remove, so that item can re-download.

### `POST /api/clients/register` — self-register a client (**no token**)
Body `{ "passphrase": "<≥8 chars>", "label": "<optional>" }`. The client generates its own
passphrase; the server stores only its SHA-256 hash. With `WHALE_CLIENT_TOFU=true` (default) the
client is trusted immediately (`200`); otherwise it's pending (`202`) until the owner approves it.
Idempotent: re-registering the same passphrase returns the existing client. Returns the `Client`
(`{id,label,trusted,created_at,sites:[{extractor,count}]}`).

### `GET /api/clients` — list clients + per-site counts (token required)
`{ "clients": [Client, …] }`, newest first. `sites` is the per-extractor submission tally.

### `POST /api/clients/:id/trust` — approve a pending client (token required)
`200 {"trusted": true}` or `404`.

### `DELETE /api/clients/:id` — revoke a client (token required)
Deletes the client and its counts (cascade). `200 {"deleted": true}` or `404`.

### `GET /api/p/:slug` — tokenless public stream
Streams a public item by its random `public_slug`. **No token needed**, but only resolves while the
item is still flagged `public` (revoking makes it `404` without changing the slug). Same
`Range`/`?download=1` behavior as the id route. `404` if the slug is unknown or no longer public.
Because the slug is unguessable, public items can't be discovered by enumerating ids.

### `DELETE /api/items/:id` — remove a record
Query: `delete_file` (bool, default `false`). Removes the DB row; if `delete_file=true` and a
`filepath` exists, deletes the file too. Removes the `archive_key` from the archive set so a
future submit can re-download. `200 {"deleted": true}` or `404`.

### `GET /api/events` — SSE progress stream
`Content-Type: text/event-stream`. Auth via `?token=`. Emits `ProgressEvent` JSON per tick:
```
event: progress
data: {"id":42,"status":"running","percent":63.4,"speed":"4.02MiB/s","eta":"00:19"}

event: progress
data: {"id":42,"status":"completed","percent":100.0,"speed":null,"eta":null}
```
- One shared stream for all items (client filters by `id`).
- A terminal `status` (`completed`/`failed`/`duplicate`) is always emitted so the UI can
  finalize a row without polling.
- Heartbeat comment line every ~15s to keep proxies from closing the connection.

### `GET /api/health` — liveness
`200 {"status":"ok","version":"…","ytdlp":"<version>"}` — no auth. Used by Docker healthcheck.

## Content types & CORS

- Requests/responses `application/json` unless noted.
- CORS: same-origin by default (UI is served by the same server). A permissive dev CORS layer
  may be toggled by config but is off in production.
