# Deployment and Operations

## Network

The production Compose file publishes loopback only. Use an HTTPS reverse proxy
for remote access and forward normal HTTP, Range, and SSE traffic without response
buffering. Do not expose Whale directly to the public internet over HTTP. Set
`WHALE_PUBLIC_URL` to the canonical HTTPS origin.

For deliberate LAN exposure, change the mapping to `8080:8080` and use a strong
token. Native clients allow plaintext HTTP only for private literals, localhost,
mDNS, or single-label LAN names.

## Storage

The image runs as UID/GID `10001` with all Linux capabilities dropped and
`no-new-privileges`. Prepare bind mounts accordingly:

```bash
install -d -o 10001 -g 10001 data downloads
```

Back up both directories together. SQLite, resolution rows, and archive state can
refer to files under the download root. Cookie files contain credentials and need
the same protection as the owner token.

## Images

CI publishes only after format, Clippy, tests, dependency audits, frontend type
checking/lint/audit, and committed-bundle verification pass. Available tags are
`latest`, `sha-<full-commit>`, and `v*` release tags. Images include OCI source,
revision, version, license, yt-dlp version, SBOM, and provenance metadata.

yt-dlp is pinned by `YTDLP_VERSION` and `YTDLP_SHA256`. The scheduled updater
validates the upstream stable tag and checksum, commits both pins, and lets the
normal gated CI publish the result.

## Health and Shutdown

`GET /api/health` is public and drives the container health check. SIGTERM and
Ctrl-C trigger Axum graceful shutdown. Active yt-dlp child cancellation is managed
for item deletion; orchestrators should still allow a normal shutdown grace period.

## Recovery

Restore a consistent `data/` and `downloads/` snapshot, then run the matching
image. Startup resets interrupted `running` rows to `queued`, reloads the archive,
applies migrations, and expires lapsed public shares.
