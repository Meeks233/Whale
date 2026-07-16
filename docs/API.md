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

SSE uses `?key_id=...`; each `progress` event data field is an envelope with
AAD `event\nprogress`. Legacy `?token=...` SSE remains available to clients that
cannot decrypt events. Media Range and streaming routes retain query/header
token authentication so bodies remain streaming rather than buffered.

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
| `POST` | `/api/items/:slug/retry` | Owner | Retry failed item |
| `GET`, `PUT` | `/api/items/:slug/resolutions` | Owner | Inspect/reconcile variants |
| `POST` | `/api/items/:slug/public` | Owner | Create, update, or revoke share |
| `GET` | `/api/items/:slug/file` | Owner query/header | Range stream or download |
| `GET` | `/api/stream/:slug` | Owner query/header | Online playback proxy |
| `GET` | `/api/stream/:slug/prepare` | Owner query/header | Warm stream URL cache |
| `GET` | `/api/p/:share_slug` | Capability | Live public file |
| `GET` | `/api/events?key_id=...` | Owner query | Encrypted SSE progress |
| `GET` | `/api/stats` | Owner | Download count and bytes |
| `GET` | `/api/logs` | Owner | Bounded recent errors |
| `GET`, `PUT` | `/api/settings` | Owner | Runtime resolution default |
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

`GET /api/items?limit=50&before_id=123&q=...&status=completed` returns
`{"items":[...],"next_cursor":123}`. `before_id` is an authenticated ordering
cursor, not a resource route identifier.

## Sharing

`POST /api/items/:slug/public` accepts
`{"public":true,"expires_in_days":7}` where days is `7`, `30`, or `null` for
permanent. `{"public":false}` revokes the link and destroys its capability.

## SSE

`progress` events contain internal numeric `id`, status, percent, speed, ETA, and
phase. IDs correlate events to items already returned through an owner-authenticated
list; they are not accepted in item paths.
