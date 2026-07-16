# Attribution and Provenance

## Seal

[Seal](https://github.com/JunkFood02/Seal) is a GPL-3.0-or-later Android video/audio
downloader and the primary product inspiration for Orca's submit, format, archive,
share-target, and mobile download workflow. Orca adds a server-owned Rust/Axum
architecture, SQLite history, Docker/OCI deployment, remote clients, web/PWA UI,
server-side media proxy, and public capability links.

Orca supports importing Seal backup conventions for interoperability. Seal is not
vendored, linked, or required at runtime. Contributors who adapt nontrivial Seal
source, text, or assets must identify the upstream file and revision here, preserve
its copyright notices, mark the modification, and confirm GPL compatibility before
merge. No such source-level adaptation has been identified in the current audit;
comments describing Seal-like behavior are design attribution, not a provenance
record.

## Other Components

- yt-dlp is downloaded into the OCI image from its upstream release and verified
  against the pinned SHA-256 checksum. yt-dlp carries its own Unlicense terms.
- FFmpeg, Python, Debian runtime packages, Rust crates, npm development tools,
  Tauri, Gradle, and Android dependencies retain their respective licenses.
- Tauri-generated Android scaffolding retains upstream/generated-file notices.
- UI glyphs described as Lucide icons follow the Lucide ISC license; app/site icon
  artwork must be reviewed before replacement or redistribution from another set.

`Cargo.lock`, `frontend/package-lock.json`, and Gradle files record exact versions
but are not substitutes for upstream license notices. Release artifacts should
include an SBOM and preserve license files emitted by their build ecosystems.

This document records technical provenance and is not legal advice.
