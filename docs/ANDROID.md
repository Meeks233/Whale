# Android App

The `app/` Tauri 2 shell embeds the committed `web/` bundle and connects to a
remote Whale server selected in Settings. The generated Android project includes
the normal WebView activity plus a share-target activity for background URL
submission.

## Behavior

- receives `ACTION_SEND` text and URL intents
- mirrors server base and owner token into private native storage
- derives an AES-256-GCM key locally for encrypted quick-submit and status APIs;
  the owner token is never sent by those JSON requests
- submits from the share sheet without opening the WebView
- polls the returned random item slug and updates one stable notification slot
- masks notification titles for privacy-blurred websites
- requests notification/media permissions through the native plugin
- supports immersive in-app playback and Android back behavior

The UI rejects plaintext HTTP for public IPs and public-looking DNS names. HTTP is
allowed for private IP literals, localhost/mDNS, and single-label LAN names. Use
HTTPS for any remote deployment.

## Local Build

Requirements are JDK 21, Android platform 36, build-tools 35.0.0, NDK
27.2.12479018, Rust 1.97, and Tauri CLI 2.11.4.

```bash
cd app
cargo tauri android build --debug --apk --target aarch64 armv7
```

The debug APK is for development and CI artifacts only. It is debug-signed and is
never attached to a GitHub Release. A public Android release requires a protected
release keystore, non-debuggable release build, version derived from the tag, and
published checksums; that signing policy is intentionally not automated without
repository secrets.

The Gradle wrapper distribution checksum is pinned. Generated Android sources are
tracked because they contain Whale-specific share-target and permission behavior.
