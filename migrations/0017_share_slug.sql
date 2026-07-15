-- Separate the private item resource identifier from the public share capability.
-- `public_slug` is retained as the private, authenticated resource slug because
-- migration 0015 already backfilled it for every item. Public links now use a
-- short-lived/revocable `share_slug` that is rotated whenever sharing is enabled.
ALTER TABLE items ADD COLUMN share_slug TEXT;
CREATE UNIQUE INDEX idx_items_share_slug ON items(share_slug) WHERE share_slug IS NOT NULL;

-- Preserve currently-live shares while invalidating their old resource-slug URL.
UPDATE items
SET share_slug = lower(hex(randomblob(16)))
WHERE public = 1;
