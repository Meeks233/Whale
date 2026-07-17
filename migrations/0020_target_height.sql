-- The height a running download is aiming for, written when the job starts and
-- read by the card's live "downloading 1080p" chip. Distinct from `height`,
-- which is the height of the file that actually landed: while a download is in
-- flight there is no file yet, so `height` is still NULL and cannot answer
-- "what quality am I getting?".
ALTER TABLE items ADD COLUMN target_height INTEGER;
