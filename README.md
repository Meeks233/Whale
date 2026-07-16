# Orca

Orca is a self-hosted, cloud-native yt-dlp download manager. Submit a media URL
from the web UI, PWA, Android share sheet, or API; Orca probes it, deduplicates
it, downloads it in the background, and keeps searchable history and files on
storage you control.

Orca takes the practical mobile workflow popularized by
[Seal](https://github.com/JunkFood02/Seal) and moves it to an always-on server.
Seal remains the reference for an excellent local Android yt-dlp experience.
Orca reinterprets that workflow as a Rust/Axum service with a SQLite control
plane, persistent queue state, Docker deployment, remote browser clients, public
share links, and a thin Tauri Android client. Seal backup data can be imported;
Orca does not bundle Seal or require it at runtime.

## Capabilities

- yt-dlp metadata probing, playlists, multi-video posts, cookies, subtitles,
  thumbnails, format selection, polite pacing, rate limits, and concurrent
  fragments
- SQLite history with archive deduplication, search, pagination, retry,
  cancellation, resolution variants, and stream-only records
- TypeScript PWA embedded in the single Rust binary, with English, Simplified
  Chinese, and Traditional Chinese UI
- Local range streaming, authenticated online playback proxy, and rotating
  tokenless public links with expiry and access counts
- Per-site enablement, cookie jars, resolution defaults, privacy blur, and batch
  operations
- Android/Tauri shell with share-target quick submission, native permissions,
  playback, and progress notifications
- Non-root OCI image, health check, pinned yt-dlp checksum, SBOM/provenance, and
  CI-gated GHCR publishing

## Quick Start

```bash
mkdir orca && cd orca
curl -O https://raw.githubusercontent.com/Meeks233/Orca/main/docker-compose.yml
mkdir -p data downloads
sudo chown -R 10001:10001 data downloads
ORCA_TOKEN="$(openssl rand -hex 24)" docker compose up -d
```

The checked-in Compose file binds `127.0.0.1:8080` by default. Open
`http://127.0.0.1:8080`, enter the same token, and submit a URL. For LAN access,
change the port binding explicitly. For internet access, keep Orca on loopback
and put an HTTPS reverse proxy in front of it.

The image defaults to `ghcr.io/meeks233/orca:latest`. Set `ORCA_IMAGE` to a
version or immutable `sha-<full-commit>` tag for controlled deployments.

## Security Model

The owner token controls history, media, settings, cookies, sharing, archive data,
websites, and client approvals. The Web and Android clients derive an AES-GCM key
from it and encrypt authenticated JSON traffic. Self-registered clients are
pending by default; after approval their credential can only submit URLs.
Authenticated item routes use random 96/128-bit resource slugs, never sequential
database IDs. Public share capabilities are separate and rotate whenever a share
is created. Media streams retain bearer/query authentication so they remain
incrementally streamable; use HTTPS outside a trusted LAN.

Orca executes yt-dlp against user-provided URLs. Keep it behind authentication,
use HTTPS outside a trusted LAN, mount only dedicated data directories, and do
not expose the Docker socket. DNS answers resolving to private addresses are
blocked by default; `ORCA_ALLOW_PRIVATE_DNS=1` is an explicit compatibility
exception for fake-IP proxy environments.

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [User guide](docs/USER_GUIDE.md)
- [Configuration](docs/CONFIGURATION.md)
- [Deployment and operations](docs/DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [API](docs/API.md)
- [Database](docs/DATABASE.md)
- [Download pipeline](docs/DOWNLOAD_PIPELINE.md)
- [Android app](docs/ANDROID.md)
- [Seal import](docs/SEAL_IMPORT.md)
- [Development and release](docs/DEVELOPMENT.md)
- [Android store release](docs/RELEASING_ANDROID.md)
- [Privacy policy](docs/PRIVACY.md)
- [Attribution](docs/ATTRIBUTION.md)

## License

Copyright (C) 2026 Meeks233 and Orca contributors.

Orca is free software licensed under the GNU General Public License, version 3
or any later version (`GPL-3.0-or-later`). See [LICENSE](LICENSE),
[COPYRIGHT](COPYRIGHT), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Use Orca only for media you are authorized to access and download.
