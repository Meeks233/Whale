# Third-Party Notices

Whale is distributed under GPL-3.0-or-later. It uses and redistributes components
under compatible or independent licenses, including:

| Component | Role | Upstream / license |
| --- | --- | --- |
| Seal | Workflow inspiration and backup interoperability | https://github.com/JunkFood02/Seal, GPL-3.0-or-later |
| yt-dlp | Media extractor/downloader in OCI image | https://github.com/yt-dlp/yt-dlp, Unlicense |
| FFmpeg | Media processing in OCI image | https://ffmpeg.org, LGPL/GPL depending on build |
| Axum, Tokio, SQLx, tower-http, reqwest, Tauri | Rust application dependencies | crates.io/upstream manifests |
| esbuild, TypeScript, ESLint | Frontend build tooling | npm package licenses |
| Lucide | UI icon paths | https://lucide.dev, ISC |
| Debian and Android/Gradle components | Runtime/build platform | individual package licenses |

Exact dependency versions are recorded in lockfiles and OCI SBOM attestations.
Copyright and license terms remain with their respective authors. Distributors are
responsible for preserving package license material and for the license profile of
the FFmpeg build they redistribute.
