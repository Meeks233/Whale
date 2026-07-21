# (syntax directive temporarily removed for an offline dev rebuild — the pinned
#  docker/dockerfile:1 frontend can't be pulled behind this host's fake-IP DNS
#  proxy; BuildKit's builtin frontend supports the cache mounts below. Restore
#  `# syntax=docker/dockerfile:1` as line 1 when network is available.)
# ---- builder ----
# Pinned by digest for reproducible builds (rust:1.97-bookworm as of 2026-07).
FROM rust:1.97-bookworm@sha256:a49aec4d4647c73d66a9684df1bd8a73a1eb4c0734b32b94df3f86361dd54ce7 AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock build.rs ./
COPY migrations ./migrations
COPY src ./src
COPY web ./web
# Cache mounts persist the cargo registry + target dir across builds, so an
# incremental rebuild only recompiles the `orca` crate instead of every
# dependency (minutes -> seconds in the dev loop). The compiled binary lives in
# the cache mount, so copy it to a normal path for the runtime stage to pick up.
#
# RUSTFLAGS enables inlined AES-NI + PCLMULQDQ (carry-less multiply for GHASH).
# Without them the RustCrypto AEAD backend uses runtime CPU detection, which
# blocks inlining and runs the whole E2EE symmetric layer (media sealing, API
# body encryption, per-request authenticators) at ~1/3 of hardware speed. These
# three features have shipped on every x86-64 CPU since ~2011 (AES-NI/PCLMULQDQ:
# Westmere/Bulldozer; SSSE3: 2006), so the binary stays portable to any realistic
# host — measured ~1.3x on GCM throughput here.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    RUSTFLAGS="-C target-feature=+aes,+ssse3,+pclmulqdq" cargo build --release --locked \
    && cp /app/target/release/orca /app/orca

# ---- runtime ----
# Pinned by digest for reproducible builds (debian:bookworm-slim as of 2026-07).
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818
ARG YTDLP_VERSION=2026.07.04
ARG VCS_REF=unknown
ARG IMAGE_VERSION=dev
LABEL org.opencontainers.image.title="Orca" \
      org.opencontainers.image.description="Self-hosted cloud-native yt-dlp downloader" \
      org.opencontainers.image.source="https://github.com/Meeks233/Orca" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.ytdlp="${YTDLP_VERSION}"
COPY YTDLP_SHA256 /tmp/YTDLP_SHA256
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg python3 ca-certificates curl \
    && curl --fail --location --retry 3 --retry-all-errors \
        "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
        -o /usr/local/bin/yt-dlp \
    && printf '%s  %s\n' "$(cat /tmp/YTDLP_SHA256)" /usr/local/bin/yt-dlp | sha256sum -c - \
    && chmod +x /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/YTDLP_SHA256
COPY --from=builder /app/orca /usr/local/bin/orca
RUN useradd -m -u 10001 orca && mkdir -p /data /downloads && chown orca /data /downloads
USER orca
ENV ORCA_DATA_DIR=/data ORCA_DOWNLOAD_DIR=/downloads ORCA_BIND=0.0.0.0:8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["orca"]
CMD ["serve"]
