# Seal Import

Whale can import media history from a Seal backup JSON file:

```bash
whale import /path/to/seal-backup.json
```

The parser accepts recognized Seal record arrays and falls back to URL lists. It
normalizes extractor display names, derives video IDs from known URLs or Seal-style
`[id]` filenames, creates completed `seal-import` rows, assigns random private
resource slugs, and updates the dedup archive. Existing archive keys are skipped.

Imported file paths are metadata only. Whale serves or deletes a path only when it
canonicalizes to a real file inside `WHALE_DOWNLOAD_DIR`; external paths and
escaping symlinks are rejected.

`--archive-only` is accepted by the current CLI for compatibility but does not
change behavior yet. Import currently reads the input file as a whole. For very
large backups, allocate memory accordingly and back up the Whale data directory
before import.

Format compatibility does not require Seal at runtime. See [Attribution](ATTRIBUTION.md)
for the project relationship and provenance policy.
