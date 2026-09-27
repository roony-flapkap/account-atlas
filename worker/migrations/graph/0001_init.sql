-- The CRM copy. One row per HubSpot record, one row per link direction.
-- What the map derives (home hive, stub, cross edge, "on 2+ accounts") is
-- still derived, from these rows and a canvas's account list, never stored.
-- Personal details beyond a label and a phone tail are not copied: the
-- inspector reads them live from HubSpot when a record is opened.

-- key is "<objectTypeId>/<id>": 0-2 company, 0-1 contact, 0-3 deal, 0-136 lead
CREATE TABLE records (
  key           TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  label         TEXT,
  sub           TEXT,             -- domain for a company, stage for a deal …
  owner_id      TEXT,
  creator_id    TEXT,
  stage         TEXT,
  pipeline      TEXT,
  amount        TEXT,
  tails         TEXT,             -- its phone tails, space-separated: what to clear from phones on a change
  created_at    TEXT,
  hs_updated_at TEXT,
  synced_at     TEXT NOT NULL,
  deleted_at    TEXT,             -- a tombstone: the map shows it struck through
  merged_into   TEXT              -- the surviving record's key, after a merge
) WITHOUT ROWID;
-- no index on type: the key starts with it, so "every company" is a
-- primary-key range (key >= '0-2/' AND key < '0-20'). On the free plan
-- every index entry is a row written, and this one would cost 177,000.

-- last 9 digits of every number a company or contact carries (a contact
-- has a phone and a mobile), for finding records that share a number
-- but carry no link: the "unattached" ones
CREATE TABLE phones (
  tail TEXT NOT NULL,
  key  TEXT NOT NULL,
  PRIMARY KEY (tail, key)
) WITHOUT ROWID;

-- both directions stored, so a hop is one primary-key range scan
CREATE TABLE links (
  a         TEXT NOT NULL,
  b         TEXT NOT NULL,
  type_id   INTEGER,              -- HubSpot association type id, when known
  label     TEXT,                 -- HubSpot association label, when there is one
  synced_at TEXT NOT NULL,
  PRIMARY KEY (a, b)
) WITHOUT ROWID;

-- Everything that changed, in order. Pages read it from their last seq on,
-- and it feeds "what changed since your last visit". Kept 90 days.
CREATE TABLE changes (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,           -- when HubSpot says it happened
  kind   TEXT NOT NULL CHECK (kind IN ('created','updated','deleted','restored','merged','linked','unlinked')),
  key    TEXT NOT NULL,
  other  TEXT,                    -- the other end of a link, or the merge survivor
  detail TEXT,                    -- JSON: {prop, value} for an update
  source TEXT NOT NULL            -- webhook | poll | nightly | backfill
);
CREATE INDEX changes_key ON changes(key);

-- segments (HubSpot lists) and their members, read when a segment is imported
CREATE TABLE segments (
  list_id     TEXT PRIMARY KEY,
  name        TEXT,
  object_type TEXT,
  size        INTEGER,
  is_active   INTEGER,
  synced_at   TEXT
);
CREATE TABLE segment_members (
  list_id    TEXT NOT NULL,
  record_key TEXT NOT NULL,
  PRIMARY KEY (list_id, record_key)
) WITHOUT ROWID;

-- one row per sync job: where it got to, and how it went
CREATE TABLE sync_state (
  job         TEXT PRIMARY KEY,
  cursor      TEXT,
  status      TEXT NOT NULL DEFAULT 'idle',   -- idle | running | paused | done | error
  started_at  TEXT,
  finished_at TEXT,
  heartbeat   TEXT,                            -- a running job older than 10 minutes is reset
  error       TEXT,
  detail      TEXT
);

-- owner, user, pipeline and stage names, read from HubSpot; the page no longer embeds them
CREATE TABLE lookups (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  at   TEXT NOT NULL
);
