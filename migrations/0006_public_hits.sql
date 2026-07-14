-- External access counter for public shares. Increments on each tokenless load
-- of /api/p/:slug (a fresh page load or download — seek/range continuations are
-- not double-counted), so the owner can notice a link that's being hit far more
-- than expected (abuse). Persists across unshare/re-share so past access stays
-- visible even after the share is revoked. NOT NULL DEFAULT 0 keeps existing rows
-- valid and makes the increment safe without a NULL guard.
ALTER TABLE items ADD COLUMN public_hits INTEGER NOT NULL DEFAULT 0;
