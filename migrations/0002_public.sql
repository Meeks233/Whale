-- Per-item public flag: when 1, the media file is streamable without a token.
ALTER TABLE items ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
