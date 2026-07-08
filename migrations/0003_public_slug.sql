-- Random, unguessable slug for public sharing (so public links aren't derivable
-- from the sequential item id). Set when an item is first made public; access is
-- still gated by the `public` flag, so revoking hides it without changing the slug.
ALTER TABLE items ADD COLUMN public_slug TEXT;
CREATE UNIQUE INDEX idx_items_public_slug ON items(public_slug) WHERE public_slug IS NOT NULL;
