# Whale app (Tauri 2)

A native Android/desktop shell that **reuses the exact `web/` UI** the Whale server
serves — one frontend codebase for browser, PWA, and app. The shell adds only:

- **Server URL** setting (`whale_api_base`) so the same UI talks to a remote Whale
  server cross-origin. Authenticated JSON traffic uses token-derived AES-GCM;
  media streams retain bearer/query authentication.
- **Android share sheet** integration: shared URLs are submitted to the server.

There is no separate app UI to maintain — edit `web/`, and both the browser and the app get it.

## Prerequisites (Linux, one-time)

| Tool | Version used | Notes |
|---|---|---|
| Rust + `rustup` | 1.97 | targets: `aarch64/armv7/i686/x86_64-linux-android` |
| `cargo-tauri` | 2.x | `cargo install tauri-cli --version "^2.0.0" --locked` |
| Android SDK | platform-tools, `platforms;android-34/35/36`, `build-tools;35.0.0` | via `sdkmanager` |
| Android NDK | `27.2.12479018` (r27c) | `sdkmanager "ndk;27.2.12479018"` |
| **JDK for Gradle** | **17–21** | ⚠️ Gradle 8.14 does **not** run on JDK 25. Install e.g. Temurin 21. |

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
export ANDROID_HOME="$HOME/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.2.12479018"
export JAVA_HOME="$HOME/jdks/jdk-21..."     # NOT a JDK 25 — Gradle rejects it
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

## Build

```sh
cd app
# Debug APK, arm64 only (fast). Drop --target for all ABIs.
cargo tauri android build --debug --apk --target aarch64
# Output:
#   src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

Desktop dev (loads the same UI in a desktop WebView):

```sh
cargo tauri dev
```

## Install & test on a device

```sh
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

1. Open **Whale** → tap ⚙ → set **Server URL** (e.g. `http://192.168.1.x:8080`) and your **API token** → Save.
2. The full web UI loads against your server (history, search, play, cloud-only fallback, etc.).
3. In any app (YouTube, browser, Twitter), **Share → Whale**. The URL is submitted to your
   server, which downloads it (respecting polite/sequential mode).

## Notes / caveats

- **minSdk 28** (Android 9+): required by the share-target plugin.
- **Cleartext HTTP** is enabled so a LAN `http://` server works; use HTTPS if exposed publicly.
- The generated `src-tauri/gen/android/` project is committed because we customize its
  `AndroidManifest.xml` (share intent-filter), `gradle.properties`, and `build.gradle.kts`
  (minSdk, cleartext). Re-running `cargo tauri android init` regenerates these — re-apply the
  three edits if you ever do.
- The share plugin requires `tauri_app_lib_name=whale_app_lib` in `gradle.properties`.
