# API

The Web UI and Android app encrypt authenticated JSON requests and responses
with token-derived AES-256-GCM. `Authorization: Bearer <token>` remains supported
for CLI clients. Query-string owner auth is accepted only by media endpoints
because `<video>` and download links cannot set request headers. Errors are
`{"error":"code","message":"text"}`; internal details are logged, not returned.

## JSON E2EE

For an owner token or trusted-client passphrase, calculate `auth_hash =
SHA-256(credential)`, then:

- `key_id = SHA-256("orca-e2ee-kid-v1" || 0x00 || auth_hash)`, lowercase hex
- `key = SHA-256("orca-e2ee-key-v1" || 0x00 || auth_hash)`

Set `X-Orca-E2EE: 1` and `X-Orca-Key-Id: <key_id>`. When a request has a body,
set `X-Orca-Encrypted-Body: 1` and send a JSON envelope
`{"v":1,"n":"<base64 nonce>","c":"<base64 ciphertext+tag>"}`. Nonces are
12 random bytes and tags are 16 bytes. Request AAD is
`METHOD + "\n" + path_and_query`. Encrypted responses carry `X-Orca-E2EE: 1`
and use `status_code + "\n" + path_and_query` as AAD. Authentication failures
remain plaintext `401` responses because the server has not accepted a key.

The `key_id` is **not a credential**. It is derived by a public function and
travels in cleartext on every request, so it only names which key to use. Every
E2EE request must also carry `X-Orca-Auth`: base64 of an envelope sealing
`{"t":<unix seconds>,"n":"<unique nonce>"}` under `key`, with AAD
`"orca-auth-v1" + "\n" + METHOD + "\n" + path_and_query`. The server opens it to
prove you hold the key, rejects a `t` more than 300 seconds from its clock, and
refuses any nonce it has already seen inside that window. Without this, anyone
who observed a `key_id` could drive every bodyless side-effecting route (the
encrypted response they could not read would not stop the delete from happening).

SSE uses `?key_id=...&auth=...`, where `auth` is the same authenticator bound to
`GET` and the literal target `/api/events` — the real query string cannot be
bound, since it contains the authenticator. Each `progress` event data field is
an envelope with AAD `event\nprogress`. Legacy `?token=...` SSE remains available
to clients that cannot decrypt events. Media Range and streaming routes retain
query/header token authentication so bodies remain streaming rather than
buffered.

## Access Classes

- **Public**: no credential
- **Owner**: owner token only
- **Submitter**: owner token or trusted submit-only client
- **Capability**: live random public share slug

## Routes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | Public | Version, yt-dlp version, public URL |
| `POST` | `/api/clients/register` | Public | Register pending client passphrase |
| `POST` | `/api/items` | Submitter | Probe, deduplicate, enqueue URL |
| `GET` | `/api/items` | Owner | Paginated history |
| `GET` | `/api/items/:slug` | Owner | One item |
| `DELETE` | `/api/items/:slug?delete_file=true` | Owner | Delete row and optional files |
| `POST` | `/api/items/:slug/retry` | Owner | Retry failed or canceled item |
| `POST` | `/api/items/:slug/pause` | Owner | Park a queued/running download |
| `POST` | `/api/items/:slug/resume` | Owner | Re-queue a paused download |
| `POST` | `/api/items/:slug/cancel` | Owner | Abandon an outstanding download, discarding its partial |
| `POST` | `/api/queue/pause` | Owner | Park every queued/running download |
| `POST` | `/api/queue/resume` | Owner | Release every paused download, oldest first |
| `POST` | `/api/queue/cancel` | Owner | Abandon every outstanding download (incl. paused) |
| `GET`, `PUT` | `/api/items/:slug/resolutions` | Owner | Inspect/reconcile variants |
| `POST` | `/api/items/:slug/public` | Owner | Create, update, or revoke share |
| `GET` | `/api/items/:slug/file` | Owner query/header | Range stream or download |
| `GET` | `/api/stream/:slug` | Owner query/header | Online playback proxy |
| `GET` | `/api/stream/:slug/prepare` | Owner query/header | Warm stream URL cache |
| `GET` | `/api/p/:share_slug` | Capability | Live public file |
| `GET` | `/api/events?key_id=...&auth=...` | Owner query | Encrypted SSE progress |
| `GET` | `/api/stats` | Owner | Download count, bytes, storage cap, paused count |
| `GET` | `/api/logs` | Owner | Bounded recent errors |
| `GET`, `PUT` | `/api/settings` | Owner | Runtime resolution/storage defaults |
| `GET` | `/api/cookies` | Owner | Legacy cookie status list |
| `PUT`, `PATCH`, `DELETE` | `/api/cookies/:platform` | Owner | Legacy cookie management |
| `GET` | `/api/websites` | Owner | Website registry |
| `PUT`, `DELETE` | `/api/websites/:key` | Owner | Website management |
| `POST` | `/api/websites/merge` | Owner | Merge websites |
| `POST` | `/api/websites/validate` | Owner | Validate sample URL/cookies |
| `POST`, `PATCH`, `DELETE` | `/api/websites/:key/cookies` | Owner | Cookie jar management |
| `GET`, `POST`, `DELETE` | `/api/archive` | Owner | List/add/remove dedup keys |
| `POST` | `/api/archive/import` | Owner | Bulk archive import |
| `GET` | `/api/clients` | Owner | List clients and counts |
| `POST` | `/api/clients/:id/trust` | Owner | Approve pending client |
| `DELETE` | `/api/clients/:id` | Owner | Revoke client |

## Item Submission

```json
{"url":"https://example/video","options":{"force":false}}
```

A single result returns `200` for a duplicate or `202` for a new item:

```json
{"item":{"id":1,"slug":"128-bit-hex","status":"queued"},"duplicate":false}
```

Playlists return `{"items":[...],"duplicates":N}`. URLs are limited to 8192
bytes, request bodies to 16 KiB, and probes to 500 entries.

## Listing

`GET /api/items?limit=50&before_id=123&q=...&status=completed&local=true` returns
`{"items":[...],"next_cursor":123}`. `before_id` is an authenticated ordering
cursor, not a resource route identifier. `local=true` restricts the page to items
holding a downloaded file and `local=false` to stream-only ones; omitted, it does
not filter. It reads the `filepath` column rather than re-stating the disk, so a
row whose file vanished behind the server's back still matches `local=true` and
comes back with `local_available: false`.

## Sharing

`POST /api/items/:slug/public` accepts
`{"public":true,"expires_in_days":7}` where days is `7`, `30`, or `null` for
permanent. `{"public":false}` revokes the link and destroys its capability.

## SSE

`progress` events contain internal numeric `id`, status, percent, speed, ETA, and
phase. IDs correlate events to items already returned through an owner-authenticated
list; they are not accepted in item paths.
