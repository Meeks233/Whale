-- Per-site privacy "blur" flag for the Website Management UI. When set, this
-- site's cards in the download history are visually blurred by default (for
-- sensitive sources), and revealed on hover (web) or tap (app). Existing rows
-- default to not-blurred.
ALTER TABLE websites ADD COLUMN blur INTEGER NOT NULL DEFAULT 0;
