-- One row per Tohyee address.
-- install_hash and release_hash are SHA-256 hashes; the Worker never stores
-- the install ID, the release key or the tunnel token itself.
CREATE TABLE addresses (
  hostname      TEXT PRIMARY KEY,
  install_hash  TEXT UNIQUE,            -- NULL once the address is being released
  release_hash  TEXT,
  tunnel_id     TEXT,
  dns_record_id TEXT,
  port          INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  version       TEXT,
  status        TEXT NOT NULL CHECK (status IN ('creating', 'active', 'releasing', 'blocked')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX addresses_status ON addresses (status);

-- Daily counters for the rate limits. "name" is a hash, never an IP address.
CREATE TABLE counters (
  name  TEXT NOT NULL,
  day   TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  count INTEGER NOT NULL,
  PRIMARY KEY (name, day)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('registrations_open', '1');
