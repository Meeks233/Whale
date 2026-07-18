# API

The Web UI and Android app talk to the server over the **Orca Secure Channel
(OSC)** — a forward-secret, mutually-authenticated end-to-end encrypted channel
that carries no token or token-derived value on the wire, so it is safe over
plain HTTP behind an untrusted TLS terminator (e.g. a Cloudflare Tunnel). The
full design and threat model live in [SECURITY.md](SECURITY.md); this section is
the wire reference. A plaintext `Authorization: Bearer <token>` (and `?token=` on
media/SSE) is honoured **only for loopback peers**, for local CLI/debugging.
Errors are `{"error":"code","message":"text"}`; internal details are logged, not
returned.

## Handshake — `POST /api/session`

Unauthenticated. The client sends a fresh ephemeral **P-256** public key and a
16-byte nonce; the server replies with its own and an opaque session id:

```
→ { "epk": "<base64 SEC1 uncompressed>", "n": "<base64 16B>" }
← { "epk": "<base64 SEC1 uncompressed>", "n": "<base64 16B>", "sid": "<opaque>" }
```

Both derive `Z` = the ECDH shared X coordinate, then
`session_key = HKDF-SHA256(ikm=Z, salt=n_c‖n_s, info="orca-osc-v2-session\0"‖SHA256(token))`.
`Z` is the only high-entropy secret and the source of forward secrecy; the token
(as `SHA256(token)`) is mixed in so only a token holder derives the same key. The
client discards its ephemeral private key immediately. Nothing token-derived is
ever sent — the `sid` is random and rotates every handshake.

## JSON requests

Set `X-Orca-E2EE: 1`, `X-Orca-Sid: <sid>`, and `X-Orca-Auth: <authenticator>`.
The **authenticator** is base64 of an envelope sealing
`{"t":<unix seconds>,"n":"<unique nonce>"}` under `session_key` with AAD
`"orca-auth-v1" + "\n" + METHOD + "\n" + path_and_query`. The sid only *names* a
session; the authenticator is the credential — the server rejects a `t` more than
300 s from its clock and refuses any nonce seen inside that window, so a captured
request can't be replayed or lifted onto another route.

On the first request of a freshly handshaken session the server tries each
candidate token's derived key; the one that opens the authenticator authenticates
and identifies the peer, promoting the session to active (identity never travels
in cleartext).

Bodies use a JSON envelope `{"v":1,"n":"<base64 12B nonce>","c":"<base64
ciphertext+16B tag>"}`, flagged with `X-Orca-Encrypted-Body: 1` and AAD
`METHOD + "\n" + path_and_query`. Encrypted responses carry `X-Orca-E2EE: 1` and
use `status_code + "\n" + path_and_query` as AAD. Authentication failures stay
plaintext `401` (no session key was accepted).

## SSE — `GET /api/events?sid=...&auth=...`

`EventSource` can't set headers, so the sid and authenticator ride in the query
(both opaque). The authenticator is bound to `GET` and the literal target
`/api/events`. Each `progress` event data field is an envelope with AAD
`event\nprogress`, sealed under the session key.

## Media plane

`<video>`/`<img>`/`<track>`/download links point at same-origin `/__m/...` URLs a
**Service Worker** owns. It fetches the encrypted media (`X-Orca-Sid` +
authenticator, plus `X-Orca-Range: <start>-<end>` for a plaintext byte range),
decrypts the chunked AEAD stream, and hands the element plaintext. Each 64 KiB
chunk is `AES-GCM(HKDF(session_key, "orca-osc-v2-media\0"‖resource), nonce=index,
chunk)`; the server returns the covering chunks (capped to a 1 MiB window) as a
plain `200` with `X-Orca-Plain-Len`, `X-Orca-Chunk`, and `X-Orca-Chunk-Index`
headers. The token never appears in a media URL.

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
| `POST` | `/api/session` | Public | OSC handshake (ephemeral ECDH) |
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
| `GET` | `/api/items/:slug/file` | Owner (OSC/loopback) | Encrypted range stream or download |
| `GET` | `/api/stream/:slug` | Owner (OSC/loopback) | Encrypted online playback proxy |
| `GET` | `/api/stream/:slug/prepare` | Owner (OSC/loopback) | Warm stream URL cache |
| `GET` | `/api/p/:share_slug` | Capability | Live public file |
| `GET` | `/api/events?sid=...&auth=...` | Owner (OSC) | Encrypted SSE progress |
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
