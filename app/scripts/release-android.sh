#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for name in ORCA_ANDROID_KEYSTORE_PATH ORCA_ANDROID_KEYSTORE_PASSWORD ORCA_ANDROID_KEY_ALIAS ORCA_ANDROID_KEY_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 1
  fi
done

version="$(node -p "require('$repo_root/app/src-tauri/tauri.conf.json').version")"
npm --prefix "$repo_root/frontend" run build
(cd "$repo_root/app" && cargo tauri android build --apk --aab --target aarch64 armv7)

dist="$repo_root/dist/android/$version"
mkdir -p "$dist"
install -m 0644 "$repo_root/app/src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab" "$dist/orca-$version.aab"
install -m 0644 "$repo_root/app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk" "$dist/orca-$version.apk"
sha256sum "$dist/orca-$version.aab" "$dist/orca-$version.apk" > "$dist/SHA256SUMS"
echo "Release artifacts: $dist"
