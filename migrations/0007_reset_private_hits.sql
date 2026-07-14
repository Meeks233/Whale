-- The public-hit counter is now scoped to the live share window: it resets to
-- zero on unshare/expiry so the access capsule only shows while a link is
-- actively shared. Older rows unshared before that rule accumulated a stale
-- tally that kept the capsule pinned (e.g. a test video shared once long ago).
-- Zero the count for anything not currently public so history matches the new
-- semantics; live shares keep their in-window count.
UPDATE items SET public_hits = 0 WHERE public = 0;
