# Getting Started

## Requirements

- Docker Engine with Compose v2
- two persistent directories writable by UID/GID `10001`
- a random owner token of at least 12 characters; 24 random bytes is recommended

## Install

```bash
git clone https://github.com/Meeks233/Orca.git
cd Orca
install -d -o 10001 -g 10001 data downloads
export ORCA_TOKEN="$(openssl rand -hex 24)"
docker compose up -d
```

`docker-compose.yml` listens on `127.0.0.1:8080`. Visit that address, open
Settings, enter `ORCA_TOKEN`, and save it. The token stays in browser local
storage and is mirrored to native app storage when running under Tauri.

## First Download

Paste an HTTP or HTTPS media URL and submit it. Orca normalizes common shared
URLs, rejects disallowed destinations, runs an yt-dlp metadata probe, checks the
SQLite/archive dedup key, then queues the download. Progress arrives over SSE.

Sites requiring login need a Netscape `cookies.txt` or supported JSON/header
cookie export. Add it under Website Management. Cookie jars are stored in
`/data/cookies`, not SQLite.

## Upgrade

Back up `data/` and `downloads/`, pull a new image, and recreate the service:

```bash
docker compose pull
docker compose up -d
```

Database migrations run automatically and only move forward. For predictable
rollback, deploy a `sha-<full-commit>` image tag and retain a matching data backup.
