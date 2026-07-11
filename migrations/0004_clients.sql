-- Self-registered clients (Android app, PWA) that authenticate with a
-- self-generated passphrase instead of the owner token. TOFU-trusted: see
-- WHALE_CLIENT_TOFU. Only the SHA-256 hash of the passphrase is stored.
CREATE TABLE clients (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    passphrase_hash TEXT NOT NULL UNIQUE,
    label           TEXT,
    trusted         INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

-- Per-extractor submission tally for each client (rate/abuse visibility).
CREATE TABLE client_site_counts (
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    extractor TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_id, extractor)
);
