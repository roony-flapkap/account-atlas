-- Which records the copy holds a COMPLETE list of links for, per kind of
-- record at the other end. A link change is only reported for these (or
-- once the first fill of that kind of link is done): a company first met as
-- a stub has one link known, and meeting the rest later is not a change.
-- Written by walks, expands and meshes; the fill says it with its job state.
CREATE TABLE link_sync (
  key     TEXT NOT NULL,
  to_type TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (key, to_type)
) WITHOUT ROWID;
