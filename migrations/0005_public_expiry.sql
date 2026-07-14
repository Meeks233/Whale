-- Expiry for public shares (Baidu-netdisk style: 7d / 30d / permanent).
-- `public_until` is a Unix timestamp after which the share auto-expires; NULL
-- means the share never expires (permanent) while `public = 1`. The item goes
-- private again once `public = 0` regardless of this column. Access is gated by
-- both `public = 1` AND (public_until IS NULL OR public_until > now), so a lapsed
-- link 404s even before the periodic sweep flips the flag.
ALTER TABLE items ADD COLUMN public_until INTEGER;
