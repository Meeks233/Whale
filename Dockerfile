# ---- builder ----
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
COPY web ./web
RUN cargo build --release --locked

# ---- runtime ----
FROM debian:bookworm-slim
ARG YTDLP_VERSION=2026.07.04
LABEL org.opencontainers.image.ytdlp="${YTDLP_VERSION}"
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg python3 ca-certificates curl \
    && curl -L "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
        -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/whale /usr/local/bin/whale
RUN useradd -m -u 10001 whale && mkdir -p /data /downloads && chown whale /data /downloads
USER whale
ENV WHALE_DATA_DIR=/data WHALE_DOWNLOAD_DIR=/downloads WHALE_BIND=0.0.0.0:8080
VOLUME ["/data", "/downloads"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fsS http://localhost:8080/api/health || exit 1
ENTRYPOINT ["whale"]
CMD ["serve"]
