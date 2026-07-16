# Android Store Release

## Fixed application identity

- Product: `Orca`
- Android application ID: `com.orca.app`
- Minimum SDK: 28
- Compile/target SDK: 36
- License: `GPL-3.0-or-later`

The application ID and Play App Signing key cannot be changed after the first
Play release. Confirm ownership of this ID before creating the Play listing.

## Version and source release

1. Update `version` in `app/src-tauri/tauri.conf.json` and
   `app/src-tauri/Cargo.toml`.
2. Ensure Android `versionCode` increases. Tauri currently maps `0.1.0` to
   `1000`; verify `app/src-tauri/gen/android/app/tauri.properties` after build.
3. Update Fastlane changelogs and `packaging/fdroid/com.orca.app.yml`.
4. Run the full CI suite, tag the exact commit as `vX.Y.Z`, and push the tag.

The tag starts `.github/workflows/android-release.yml`, which builds arm64-v8a
and armeabi-v7a APK/AAB artifacts, signs them with the protected upload key,
publishes checksums, and creates a GitHub Release.

## Signing

Create an upload key once and keep encrypted offline backups:

```bash
keytool -genkeypair -v -keystore orca-upload.jks -alias orca-upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

For a local signed release, export these variables and run
`app/scripts/release-android.sh`:

```text
ORCA_ANDROID_KEYSTORE_PATH
ORCA_ANDROID_KEYSTORE_PASSWORD
ORCA_ANDROID_KEY_ALIAS
ORCA_ANDROID_KEY_PASSWORD
```

Configure the same values as secrets in the protected GitHub environment
`android-release`; store the keystore itself as base64 in
`ORCA_ANDROID_KEYSTORE_BASE64`. Never commit a keystore, password, Play service
account JSON, or generated `dist/` content.

## Google Play

Current official requirements and setup:

- A Play Console account requires identity verification and a one-time USD 25
  registration fee.
- From 2026-08-31, new apps and updates must target Android 16 / API 36.
- Use Android App Bundles and enroll in Play App Signing. The repository key is
  the upload key, not the Play distribution key.
- Complete the privacy policy, Data safety, content rating, target audience,
  ads, app access, and intellectual-property declarations.
- Upload the first AAB manually so the package exists in Play Console. Enable
  the Android Publisher API, grant an app-scoped service account release access,
  then save its JSON as `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` in the protected
  `google-play` GitHub environment.
- Run the Android release workflow manually with `publish_play=true`; use the
  `internal` track first. Production is never the default.
- New personal accounts created after 2023-11-13 need a closed test with at
  least 12 continuously opted-in testers for 14 days before production access.

The store listing source is `fastlane/metadata/android/`. Before submission add
at least two representative phone screenshots for each promoted locale and
review the 512 px icon and 1024 x 500 feature graphic. The app is not designed
for children and must be described as a client for a user-controlled server,
not as a service for bypassing copyright or platform controls.

Official references:

- https://support.google.com/googleplay/android-developer/answer/6112435
- https://support.google.com/googleplay/android-developer/answer/11926878
- https://support.google.com/googleplay/android-developer/answer/14151465
- https://support.google.com/googleplay/android-developer/answer/10787469
- https://developer.android.com/studio/publish/app-signing

## F-Droid

F-Droid builds and signs its own APK from a public, tagged source revision. Make
the GitHub repository public, publish `vX.Y.Z`, test
`app/scripts/build-fdroid.sh` in a clean environment, then submit a merge request
to `fdroid/fdroiddata` using `packaging/fdroid/com.orca.app.yml` as the starting
metadata. Replace its tag reference with the exact release commit if requested
by review.

The app contains no proprietary SDK, analytics, advertising, or Google Play
Services dependency. Its required server is also GPL source and is
self-hostable, so no `NonFreeNet` anti-feature is expected. Reviewers still need
to validate the Tauri/Rust toolchain recipe and all downloaded build inputs.
F-Droid's APK has a different signing key from the Play APK, so switching stores
normally requires uninstalling the other build first.

Official references:

- https://f-droid.org/docs/Inclusion_Policy/
- https://f-droid.org/docs/Build_Metadata_Reference/
- https://gitlab.com/fdroid/fdroiddata/-/blob/master/CONTRIBUTING.md
