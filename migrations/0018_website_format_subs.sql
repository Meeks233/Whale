-- Per-site overrides for the download container and subtitle capture, matching
-- the existing per-site `max_height` pattern (migration 0014 / 0016). Both are
-- NULLable on purpose: NULL = "follow the global setting", which is distinct
-- from an explicit per-site choice. Resolution order at download time is
-- env (ORCA_CONTAINER / ORCA_SUBS) > per-site > stored global > built-in default.
ALTER TABLE websites ADD COLUMN container TEXT;   -- 'mkv' | 'mp4' | 'webm' | 'mov' | 'avi' | 'flv'; NULL = follow global
ALTER TABLE websites ADD COLUMN subs INTEGER;     -- 1 = on, 0 = off, NULL = follow global
