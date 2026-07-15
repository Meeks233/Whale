# Development and Release

## Layout

Rust code is in `src/`, migrations in `migrations/`, frontend source in
`frontend/src/`, committed frontend output in `web/`, and the Tauri application in
`app/`. `web/` is both embedded by the backend and packaged by Tauri.

## Checks

```bash
cargo +1.97.0 fmt --all -- --check
cargo +1.97.0 clippy --all-targets --all-features --locked -- -D warnings
cargo +1.97.0 test --locked
cd frontend && npm ci && npm run check && npm audit --audit-level=high
```

After frontend edits, commit the regenerated `web/` files. CI rebuilds and fails
when the bundle differs. New database changes require a new numbered migration;
never modify a migration that may have run in a released installation.

## Release Process

1. Update version metadata consistently in Rust/Tauri/Android when making a
   versioned release.
2. Run backend, frontend, dependency, workflow, Compose, and end-to-end checks.
3. Review generated assets, legal notices, source attribution, and `git diff`.
4. Push main. CI publishes `latest` and an immutable full-SHA image only after all
   required jobs succeed.
5. Create a signed `v*` tag from a verified main commit. CI publishes the version
   image tag; attach the exact source archive and checksums to binary releases.
6. Publish an Android release only when release signing secrets and versioning are
   configured. Never distribute the CI debug artifact as a release APK.

Scheduled yt-dlp updates commit only a version/checksum pair. They use the same CI
gate and image publisher as normal source changes.
