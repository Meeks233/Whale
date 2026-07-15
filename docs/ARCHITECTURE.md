# Architecture

## Components

- `src/main.rs`: CLI, startup recovery, state assembly, HTTP listener, shutdown
- `src/api/`: Axum routes, owner/submitter boundaries, SSE, media proxy
- `src/db/`: SQLx/SQLite queries and migrations
- `src/queue.rs`: bounded job channel, concurrency semaphore, cancellation, events
- `src/ytdlp/`: argument construction, metadata probes, downloads, stream URL cache
- `src/archive.rs`: in-memory yt-dlp archive set plus durable sorted file
- `src/cookies.rs`, `src/websites.rs`: website registry and cookie jars
- `frontend/src/`: framework-free TypeScript UI and service worker
- `web/`: committed production bundle embedded by `rust-embed`
- `app/`: Tauri shell and Android share-target integration

## Request Flow

The public router exposes static assets, health, pending client registration, SSE
with owner query authentication, owner media endpoints with self-authentication,
and public capability links. The owner router accepts only the owner bearer header.
The submission router accepts owner or explicitly trusted client credentials.

Item database IDs are internal queue/foreign keys. Authenticated item routes use
the `items.public_slug` column as a private resource slug. Despite its historical
column name, it is not a public capability. `items.share_slug` is generated only
while a public share is live and is cleared on revoke or expiry.

## Persistence

SQLite stores media metadata, state, settings, websites, clients, variants, and
share metadata. `/data/archive.txt` is the yt-dlp dedup archive. `/data/cookies`
contains per-site jars. `/downloads` contains media and sidecars. File serving and
deletion canonicalize paths and require confinement under the configured download
root.

## Concurrency

Submissions probe at most two URLs concurrently, each with a 120-second timeout
and 500-entry playlist cap. Accepted jobs enter a 1024-slot channel. A semaphore
limits active downloads; polite mode forces one lane and adds random pacing.
Progress is broadcast through a bounded channel to SSE subscribers.

## Trust Boundaries

- owner token: full administrative authority
- trusted client passphrase: submit-only authority
- private item slug: non-enumerable identifier, still requires owner auth
- public share slug: bearer capability for one live local file
- cookies: secrets passed only to matching upstream domains under cookie scope
- yt-dlp/remote media: untrusted subprocess input and network data

The SSRF guard allows HTTP(S), rejects local/reserved literals and DNS answers,
and rechecks stored/upstream URLs. DNS rebinding after the check remains a residual
risk without an egress-filtering proxy or firewall. High-assurance deployments
should deny container access to private and metadata networks at the network layer.
