-- Read-only views over the copy, for the Findings and the SQL console.
-- Views cost no writes: every one is worked out when it is read.
--
-- company_keys / contact_keys: each record with a cleaned name (legal
-- suffixes, punctuation, spacing and "Al"/"El" gone), a sound-alike key (the
-- cleaned name without its vowels: Noor = Nour = Nur), and a cleaned website.

CREATE VIEW company_keys AS
WITH c AS (
  SELECT key, substr(key, 5) AS id, label, owner_id, creator_id, created_at, tails,
    lower(trim(coalesce(sub, ''))) AS d,
    ' ' || lower(replace(replace(replace(replace(replace(replace(replace(replace(coalesce(label, ''),
      '.', ' '), ',', ' '), '-', ' '), '&', ' '), '(', ' '), ')', ' '), '''', ''), '/', ' ')) || ' ' AS n
  FROM records
  WHERE key >= '0-2/' AND key < '0-20' AND deleted_at IS NULL
),
k AS (
  SELECT key, id, label, owner_id, creator_id, created_at, tails, d,
    replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(
      n, ' l l c ', ' '), ' llc ', ' '), ' fze ', ' '), ' fzco ', ' '), ' fzc ', ' '), ' fz ', ' '), ' ltd ', ' '),
      ' limited ', ' '), ' co ', ' '), ' company ', ' '), ' trading ', ' '), ' est ', ' '), ' establishment ', ' '),
      ' group ', ' '), ' holding ', ' '), ' holdings ', ' '), ' the ', ' '), ' inc ', ' '), ' corp ', ' '), ' spc ', ' '),
      ' wll ', ' '), ' al ', ' '), ' el ', ' ') AS clean
  FROM c
),
g AS (
  SELECT key, id, label, owner_id, creator_id, created_at, tails,
    replace(clean, ' ', '') AS nk,
    replace(replace(replace(d, 'https://', ''), 'http://', ''), 'www.', '') AS dom
  FROM k
),
h AS (
  SELECT key, id, label, owner_id, creator_id, created_at, tails,
    CASE WHEN nk LIKE 'al%' AND length(nk) > 5 THEN substr(nk, 3) ELSE nk END AS name_key,
    CASE WHEN instr(dom, '/') > 0 THEN substr(dom, 1, instr(dom, '/') - 1) ELSE dom END AS dom
  FROM g
)
SELECT key, id, label, owner_id, creator_id, created_at, tails,
  CASE WHEN dom IN ('', 'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'live.com') THEN '' ELSE dom END AS domain,
  name_key,
  substr(name_key, 1, 1) || replace(replace(replace(replace(replace(replace(substr(name_key, 2), 'a', ''), 'e', ''), 'i', ''), 'o', ''), 'u', ''), 'y', '') AS sound_key
FROM h;

CREATE VIEW contact_keys AS
WITH c AS (
  SELECT key, substr(key, 5) AS id, label, owner_id, created_at, tails,
    ' ' || lower(replace(replace(replace(replace(replace(coalesce(label, ''), '.', ' '), ',', ' '), '-', ' '), '''', ''), '_', ' ')) || ' ' AS n
  FROM records
  WHERE key >= '0-1/' AND key < '0-10' AND deleted_at IS NULL
),
g AS (
  SELECT key, id, label, owner_id, created_at, tails,
    replace(replace(replace(replace(replace(replace(replace(replace(
      n, ' mr ', ' '), ' mrs ', ' '), ' ms ', ' '), ' dr ', ' '), ' eng ', ' '), ' al ', ' '), ' el ', ' '), ' ', '') AS name_key
  FROM c
)
SELECT key, id, label, owner_id, created_at, tails, name_key,
  substr(name_key, 1, 1) || replace(replace(replace(replace(replace(replace(substr(name_key, 2), 'a', ''), 'e', ''), 'i', ''), 'o', ''), 'u', ''), 'y', '') AS sound_key
FROM g;

-- every phone ending on more than one record, and whether it is a placeholder
CREATE VIEW shared_numbers AS
SELECT tail, count(*) AS records,
  sum(key >= '0-2/' AND key < '0-20') AS companies,
  sum(key >= '0-1/' AND key < '0-10') AS contacts,
  (tail IN ('000000000', '111111111', '222222222', '123456789', '987654321', '999999999', '012345678')
   OR tail GLOB '*0000000*' OR tail GLOB '*1111111*' OR tail GLOB '*9999999*') AS junk,
  group_concat(key, ' ') AS keys
FROM phones
GROUP BY tail
HAVING count(*) > 1;

-- Pairs of companies that may be one business, with the evidence for each
-- and a score. Candidates come from four directions (a sound-alike name, the
-- same website, the same number, a shared person), each block capped at 20
-- so a generic name ("Restaurant") or a switchboard number does not pair
-- everything with everything. A score of 4 or more needs two signals.
CREATE VIEW duplicate_pairs AS
WITH ck AS MATERIALIZED (SELECT key, label, domain, owner_id, created_at, name_key, sound_key FROM company_keys),
sb AS MATERIALIZED (SELECT sound_key FROM ck WHERE length(name_key) >= 4 GROUP BY sound_key HAVING count(*) BETWEEN 2 AND 20),
db AS MATERIALIZED (SELECT domain FROM ck WHERE domain <> '' GROUP BY domain HAVING count(*) BETWEEN 2 AND 20),
pc AS MATERIALIZED (SELECT tail, key FROM phones WHERE key >= '0-2/' AND key < '0-20'),
pb AS MATERIALIZED (SELECT tail FROM pc GROUP BY tail HAVING count(*) BETWEEN 2 AND 20),
lc AS MATERIALIZED (SELECT a AS person, b AS company FROM links WHERE a >= '0-1/' AND a < '0-10' AND b >= '0-2/' AND b < '0-20'),
cand AS (
  SELECT x.key AS a, y.key AS b FROM ck x JOIN ck y ON y.sound_key = x.sound_key AND x.key < y.key WHERE x.sound_key IN (SELECT sound_key FROM sb)
  UNION SELECT x.key, y.key FROM ck x JOIN ck y ON y.domain = x.domain AND x.key < y.key WHERE x.domain IN (SELECT domain FROM db)
  UNION SELECT p.key, q.key FROM pc p JOIN pc q ON q.tail = p.tail AND p.key < q.key WHERE p.tail IN (SELECT tail FROM pb)
  UNION SELECT l1.company, l2.company FROM lc l1 JOIN lc l2 ON l2.person = l1.person AND l1.company < l2.company
),
ev AS (
  SELECT c.a, c.b, x.label AS a_label, y.label AS b_label,
    (x.name_key = y.name_key AND length(x.name_key) >= 4) AS same_name,
    (x.sound_key = y.sound_key AND length(x.name_key) >= 4) AS same_sound,
    (x.domain <> '' AND x.domain = y.domain) AS same_domain,
    EXISTS (SELECT 1 FROM pc p JOIN pc q ON q.tail = p.tail WHERE p.key = c.a AND q.key = c.b) AS same_phone,
    (SELECT count(*) FROM lc l1 JOIN lc l2 ON l2.person = l1.person WHERE l1.company = c.a AND l2.company = c.b) AS shared_people,
    -- every signal is a plain 0 or 1: a NULL (an owner missing on one side) would blank the whole score
    coalesce(x.owner_id IS NOT NULL AND x.owner_id = y.owner_id, 0) AS same_owner,
    coalesce(abs(julianday(x.created_at) - julianday(y.created_at)) <= 2, 0) AS created_close
  FROM cand c JOIN ck x ON x.key = c.a JOIN ck y ON y.key = c.b
)
SELECT a, b, a_label, b_label, same_name, same_sound, same_domain, same_phone, shared_people, same_owner, created_close,
  3 * same_name + 2 * (same_sound AND NOT same_name) + 3 * same_domain + 2 * same_phone
  + 2 * min(shared_people, 2) + same_owner + created_close AS score
FROM ev;

-- The same for contacts: one person entered twice.
CREATE VIEW contact_duplicate_pairs AS
WITH k AS MATERIALIZED (SELECT key, label, name_key, sound_key, owner_id, created_at FROM contact_keys),
sb AS MATERIALIZED (SELECT sound_key FROM k WHERE length(name_key) >= 5 GROUP BY sound_key HAVING count(*) BETWEEN 2 AND 30),
pk AS MATERIALIZED (SELECT tail, key FROM phones WHERE key >= '0-1/' AND key < '0-10'),
pb AS MATERIALIZED (SELECT tail FROM pk GROUP BY tail HAVING count(*) BETWEEN 2 AND 10),
lc AS MATERIALIZED (SELECT a AS person, b AS company FROM links WHERE a >= '0-1/' AND a < '0-10' AND b >= '0-2/' AND b < '0-20'),
cand AS (
  SELECT x.key AS a, y.key AS b FROM k x JOIN k y ON y.sound_key = x.sound_key AND x.key < y.key WHERE x.sound_key IN (SELECT sound_key FROM sb)
  UNION SELECT p.key, q.key FROM pk p JOIN pk q ON q.tail = p.tail AND p.key < q.key WHERE p.tail IN (SELECT tail FROM pb)
),
ev AS (
  SELECT c.a, c.b, x.label AS a_label, y.label AS b_label,
    (x.name_key = y.name_key AND length(x.name_key) >= 5) AS same_name,
    (x.sound_key = y.sound_key AND length(x.name_key) >= 5) AS same_sound,
    EXISTS (SELECT 1 FROM pk p JOIN pk q ON q.tail = p.tail WHERE p.key = c.a AND q.key = c.b) AS same_phone,
    EXISTS (SELECT 1 FROM lc l1 JOIN lc l2 ON l2.company = l1.company WHERE l1.person = c.a AND l2.person = c.b) AS same_company,
    coalesce(x.owner_id IS NOT NULL AND x.owner_id = y.owner_id, 0) AS same_owner
  FROM cand c JOIN k x ON x.key = c.a JOIN k y ON y.key = c.b
)
SELECT a, b, a_label, b_label, same_name, same_sound, same_phone, same_company, same_owner,
  3 * same_name + 2 * (same_sound AND NOT same_name) + 3 * same_phone + 2 * same_company + same_owner AS score
FROM ev;
