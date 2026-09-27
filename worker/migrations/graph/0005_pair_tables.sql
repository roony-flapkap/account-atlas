-- The duplicate pairs, worked out once a night from the views and kept here,
-- so a finding or a console query reads a few thousand rows instead of the
-- ~800,000 the views read to compute them. Only pairs with two signals or
-- more (score >= 4) are kept.
CREATE TABLE dup_company_pairs (
  a TEXT NOT NULL, b TEXT NOT NULL, a_label TEXT, b_label TEXT,
  same_name INTEGER, same_sound INTEGER, same_domain INTEGER, same_phone INTEGER,
  shared_people INTEGER, same_owner INTEGER, created_close INTEGER, score INTEGER,
  PRIMARY KEY (a, b)
) WITHOUT ROWID;

CREATE TABLE dup_contact_pairs (
  a TEXT NOT NULL, b TEXT NOT NULL, a_label TEXT, b_label TEXT,
  same_name INTEGER, same_sound INTEGER, same_phone INTEGER, same_company INTEGER, same_owner INTEGER, score INTEGER,
  PRIMARY KEY (a, b)
) WITHOUT ROWID;
