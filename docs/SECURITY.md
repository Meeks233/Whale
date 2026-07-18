# Security — the Orca Secure Channel (OSC)

Orca is designed to be safe to run **over plain HTTP behind an untrusted TLS
terminator** — specifically a Cloudflare Tunnel, but the model holds for any
reverse proxy that terminates TLS in front of the app. The terminator is treated
as an **active man-in-the-middle**:

- Nothing it can log — the URL path and query string, request/response headers,
  or bodies — may carry the bearer token or any value that can be reversed to it.
- Traffic it captures today must stay secret **even if the token later leaks**
  (forward secrecy).
- It must not be able to read the media you download and play, or forge
  side-effecting requests.

This is real end-to-end encryption between the browser and the Orca process,
*inside* whatever transport carries it. Cloudflare (or any proxy) sees only
ephemeral public keys, an opaque rotating session id, and ciphertext.

It costs the operator **nothing new**: no extra environment variables, no key
files, no settings. The existing bearer token is the only shared secret, and it
is never transmitted.

## Why the old scheme wasn't enough

The previous design derived a *static* AES key straight from the token
(`key = SHA256("…key…" ‖ SHA256(token))`) and put a stable key id
(`SHA256("…kid…" ‖ SHA256(token))`) in the clear on every request. That leaked
two things to a TLS terminator:

1. **A permanent tracking handle.** The key id was the same on every request
   forever, and identical across sessions and devices.
2. **An offline guessing oracle.** Anyone who captured one request could grind
   token guesses against the key id offline, at their own pace.

And because the key was a pure function of the token, there was **no forward
secrecy**: one token compromise (or one successful offline guess) retroactively
decrypted every captured request and response ever made. On top of that, the
media plane (`/file`, `/thumb`, `/stream`, `/subs`) and the SSE stream carried
the **raw token in the URL query** — which a proxy logs verbatim.

## The construction

OSC is the mature, boring answer the industry already converged on for
"turn a shared secret into a forward-secret, mutually-authenticated channel over a
hostile transport": an **ephemeral-ECDH key agreement with the shared secret
mixed in as a pre-shared key** — the same shape as Noise's `NNpsk0` pattern,
TLS 1.3's `ECDHE-PSK`, and WireGuard's handshake.

### Handshake (`POST /api/session`)

```
client ── epk_c, n_c ─────────────▶ server          (both plaintext: public values)
client ◀───────── epk_s, n_s, sid ── server
```

- `epk_c`, `epk_s` — ephemeral **P-256** public keys, fresh per handshake.
- `n_c`, `n_s` — 16-byte random nonces.
- `sid` — an opaque 18-byte random **session id**. It replaces the key id: it is
  random, rotates every handshake, and reveals nothing about the token.

Both sides compute the ECDH shared secret `Z` (the point's X coordinate) and:

```
session_key = HKDF-SHA256(
                 ikm  = Z,
                 salt = n_c ‖ n_s,
                 info = "orca-osc-v2-session\0" ‖ SHA256(token),
                 len  = 32)
```

The token (as `SHA256(token)`, the PSK) is mixed into the derivation, so **only a
token holder derives the same key**. `Z` is the sole high-entropy secret and the
source of forward secrecy — it exists only while the two ephemeral private keys
do, and both are discarded immediately after. A passive eavesdropper who never
learns `Z` gets **no offline oracle** for the token from anything on the wire.

Identity is proven lazily, keeping it off the wire: the server stashes the
psk-independent ECDH point under `sid` as *pending*, and the client's **first
authenticated request** (below) is what proves which token it holds. The server
tries each candidate token's derived key; the one that opens the request's
authenticator both authenticates and identifies the peer, and the session becomes
*active*. A wrong-token client derives a different key, so nothing opens — and a
failed candidate never even consumes the authenticator's single-use nonce. The
server is authenticated implicitly: only a token holder can seal a response the
client can open, so an impersonating proxy's replies simply fail to decrypt.

### Per-request authentication

Every request on an established session carries:

| Header | Meaning |
| --- | --- |
| `X-Orca-Sid` | the opaque session id |
| `X-Orca-Auth` | a **sealed authenticator** — `AES-GCM(session_key, {t, n})`, AAD-bound to `orca-auth-v1\n<METHOD>\n<target>` |
| `X-Orca-E2EE: 1` | marks the request as OSC |
| `X-Orca-Encrypted-Body: 1` | present when the body is sealed under the session key |

The authenticator is the credential (the sid alone proves nothing). It is bound
to the exact method + target, timestamped (±300 s skew window), and carries a
single-use nonce cached server-side — so a captured request can't be **replayed**
or **lifted onto another route**. Responses are sealed under the session key too,
AAD-bound to `<status>\n<target>`. This is the same `(method, target, timestamp,
nonce)` binding AWS SigV4 and RFC 9421 HTTP Message Signatures use.

The SSE stream (`GET /api/events`) can't set headers, so it carries `sid` + a
sealed authenticator in the query — both opaque — and the events are sealed under
the session key.

### The media plane

`<video>`, `<img>`, and `<track>` can't attach auth headers or decrypt bytes, so
a same-origin **Service Worker** stands in front of them. Elements point at
`/__m/...` URLs the worker owns; it fetches the encrypted media (adding the sid +
a sealed authenticator), decrypts, and hands the element plaintext. The token
never appears in a media URL again.

Media is encrypted as a **chunked AEAD stream** so it stays randomly seekable:

```
stream_key   = HKDF-SHA256(session_key, info = "orca-osc-v2-media\0" ‖ resource)
enc_chunk[i] = AES-GCM(stream_key, nonce = i, plaintext_chunk[i])   // 64 KiB + 16-byte tag
```

`resource` uniquely labels the byte stream (`file:<slug>`, `thumb:<slug>`,
`stream:<slug>`, `subs:<slug>:<lang>`) so two streams that share a slug get
independent keys and their chunk-0 nonces never collide. The chunk nonce is just
the chunk index — safe because each `stream_key` is unique per session + resource,
so no `(key, nonce)` pair is ever reused across differing plaintext.

The worker asks for a plaintext byte range (`X-Orca-Range`); the server seals the
covering chunks (capped to a 1 MiB window so a multi-gigabyte file never seals
whole into memory) and returns them as a plain `200` — the transport never sees
HTTP Range semantics whose byte math wouldn't match the ciphertext length. The
worker decrypts, reassembles, and answers the element with a normal `206`. Cloud
(not-downloaded) items proxy the upstream through the same chunked window, so
online playback is end-to-end encrypted and seekable just like a local file.

## Threat model & residual risks

- **Passive proxy / eavesdropper (incl. Cloudflare logs):** sees only ephemeral
  public keys, an opaque rotating sid, sealed authenticators, and ciphertext.
  Learns nothing about the token and gets no offline guessing oracle. Cannot read
  media. ✅
- **Forward secrecy:** a later token compromise does **not** decrypt previously
  captured traffic — the ephemeral ECDH secrets are long gone. ✅
- **Replay / request forgery:** the single-use, method+target-bound authenticator
  stops replays and cross-route lifting; a proxy can't forge a side-effecting call
  it couldn't seal. ✅
- **Active MITM offline dictionary attack:** an *active* MITM that substitutes its
  own ephemeral key and captures the client's first sealed request obtains an
  offline oracle to guess the token — the known limitation of ECDHE-PSK versus a
  full PAKE (SPAKE2 / CPace). Orca mitigates this the way TLS-PSK and WireGuard do:
  by **requiring a strong PSK**. A generated token is 128-bit random, and an
  operator-set `ORCA_TOKEN` is screened at boot (length, character variety, common-
  credential blocklist), putting the token far outside any feasible dictionary. A
  future upgrade to a balanced PAKE would remove even this residual.
- **Public share links (`/api/p/:slug`):** tokenless by design — a stranger with
  the link has no session — so those bytes are inherently visible to the proxy.
  Sharing an item is an explicit opt-out of proxy-invisibility for that one item.

## The loopback plaintext fallback

For local debugging (`curl`, scripts), a plaintext `Authorization: Bearer <token>`
(or `?token=` on media/SSE) is still honoured — **only when the peer connects on
the loopback interface** (`127.0.0.0/8`, `::1`). Any request arriving from off the
machine, i.e. anything a Cloudflare Tunnel would forward, must use OSC or it is
refused. A peer with no connection info is treated as remote (fail closed).

## Where the code lives

| Piece | File |
| --- | --- |
| AEAD envelope, key schedule, authenticator, chunk cipher | `src/e2ee.rs` |
| Handshake + in-memory session store | `src/session.rs`, `src/api/handshake.rs` |
| Auth middleware, session resolution, loopback gate | `src/api/auth.rs` |
| Encrypted media serving (chunked windows) | `src/api/emedia.rs`, `src/api/media.rs` |
| Encrypted SSE | `src/api/events.rs` |
| Client channel (handshake, encrypted fetch, session cache) | `frontend/src/e2ee.ts` |
| Service-worker media-decrypting proxy | `frontend/src/sw.ts` |
