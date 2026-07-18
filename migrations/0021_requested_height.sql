-- The resolution a prepare-card submission pinned for this item (goal 4). When
-- set, run_job's primary download uses it as the height cap instead of the
-- settings ladder (env > per-site > global) it would otherwise resolve. `0` means
-- "highest available" was explicitly chosen; NULL (the default) means no override,
-- i.e. follow settings exactly as before. Kept on the row so a retry re-fetches
-- the same resolution the user asked for.
ALTER TABLE items ADD COLUMN requested_height INTEGER;
