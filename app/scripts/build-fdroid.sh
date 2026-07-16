#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
unset ORCA_ANDROID_KEYSTORE_PATH ORCA_ANDROID_KEYSTORE_PASSWORD ORCA_ANDROID_KEY_ALIAS ORCA_ANDROID_KEY_PASSWORD
npm --prefix "$repo_root/frontend" ci
npm --prefix "$repo_root/frontend" run build
(cd "$repo_root/app" && cargo tauri android build --apk --target aarch64 armv7)
