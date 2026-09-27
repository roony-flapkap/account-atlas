-- The app's own data. Never reachable from the SQL console.

-- The old artifact store, one row per document, same rules: paths alternate
-- collection and document, data/users/<uid>/ is private to that user.
CREATE TABLE docs (
  path       TEXT PRIMARY KEY,
  parent     TEXT NOT NULL,       -- the collection the document sits in
  data       TEXT NOT NULL,       -- JSON
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX docs_parent ON docs(parent, path);

-- one row per canvas change, walk, segment import, SQL query and sync run
CREATE TABLE audit (
  at     TEXT NOT NULL,
  email  TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX audit_at ON audit(at);

-- HubSpot may deliver an event more than once; each is applied once
CREATE TABLE hook_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL
) WITHOUT ROWID;

-- what today has used of the free plan's daily allowance (UTC day)
CREATE TABLE usage (
  day          TEXT NOT NULL,
  what         TEXT NOT NULL,     -- sync_writes | hook_writes | sql_reads | hs_calls
  n            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, what)
) WITHOUT ROWID;
