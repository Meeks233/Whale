# Database

Orca uses SQLite at `$ORCA_DATA_DIR/orca.db` through SQLx. Migrations in
`migrations/` run automatically in lexical order and must never be edited after
release.

## Core Tables

- `items`: source identity, metadata, lifecycle, private resource slug, share state
- `item_resolutions`: one file/size per item and exact height
- `settings`: runtime key/value overrides
- `clients`, `client_site_counts`: hashed client credentials, trust, usage counts
- `websites`: editable site aliases and policy

`items.archive_key` is unique and normally `<extractor> <video_id>`. Integer item
IDs remain efficient internal primary/foreign keys. `public_slug` is the historic
column holding the private API resource slug; `share_slug` is the rotating public
capability. Both have partial unique indexes.

## State Invariants

- statuses are `queued`, `running`, `completed`, `failed`, or `duplicate`
- startup resets `running` rows to `queued`
- only completed rows with a local file can become public
- revoking or expiring a share clears `share_slug`, expiry, and hit count
- variant rows cascade when an item is deleted
- primary file fields point to the highest retained variant when variants exist
- API file availability is recomputed from storage; stored paths are never trusted
  for serving or deletion without canonical confinement

## Migration History

`0001` created items; `0002-0007` added public state, random slug, clients, expiry,
and access counts; `0008-0013` added playlist/resolution/settings/height data;
`0014-0016` added website policy and backfilled resource slugs; `0017` separated
rotating public share capabilities from private resource slugs.

## Backup

Stop writes or use SQLite's online backup tooling, then capture `orca.db`,
`archive.txt`, `cookies/`, and downloads consistently. Copying only the database
does not preserve cookies, dedup archive state, or media files.
