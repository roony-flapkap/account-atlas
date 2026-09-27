-- The duplicate views, cheaper: "same number" and "people in common" are
-- worked out once, as sets of pairs, and joined — not asked once per
-- candidate pair, which read the phone and link tables thousands of times
-- (1.1 million rows a run on the live copy). A number on more than 20
-- companies (a switchboard, an agent) is no longer evidence of a duplicate.

DROP VIEW IF EXISTS duplicate_pairs;
CREATE VIEW duplicate_pairs AS
WITH ck AS MATERIALIZED (SELECT key, label, domain, owner_id, created_at, name_key, sound_key FROM company_keys),
sb AS MATERIALIZED (SELECT sound_key FROM ck WHERE length(name_key) >= 4 GROUP BY sound_key HAVING count(*) BETWEEN 2 AND 20),
db AS MATERIALIZED (SELECT domain FROM ck WHERE domain <> '' GROUP BY domain HAVING count(*) BETWEEN 2 AND 20),
pc AS MATERIALIZED (SELECT tail, key FROM phones WHERE key >= '0-2/' AND key < '0-20'),
phonepairs AS MATERIALIZED (
  SELECT p.key AS a, q.key AS b FROM pc p JOIN pc q ON q.tail = p.tail AND p.key < q.key
  WHERE p.tail IN (SELECT tail FROM pc GROUP BY tail HAVING count(*) BETWEEN 2 AND 20) GROUP BY 1, 2),
lc AS MATERIALIZED (SELECT a AS person, b AS company FROM links WHERE a >= '0-1/' AND a < '0-10' AND b >= '0-2/' AND b < '0-20'),
peoplepairs AS MATERIALIZED (
  SELECT l1.company AS a, l2.company AS b, count(*) AS n FROM lc l1 JOIN lc l2 ON l2.person = l1.person AND l1.company < l2.company GROUP BY 1, 2),
cand AS (
  SELECT x.key AS a, y.key AS b FROM ck x JOIN ck y ON y.sound_key = x.sound_key AND x.key < y.key WHERE x.sound_key IN (SELECT sound_key FROM sb)
  UNION SELECT x.key, y.key FROM ck x JOIN ck y ON y.domain = x.domain AND x.key < y.key WHERE x.domain IN (SELECT domain FROM db)
  UNION SELECT a, b FROM phonepairs
  UNION SELECT a, b FROM peoplepairs
),
ev AS (
  SELECT c.a, c.b, x.label AS a_label, y.label AS b_label,
    (x.name_key = y.name_key AND length(x.name_key) >= 4) AS same_name,
    (x.sound_key = y.sound_key AND length(x.name_key) >= 4) AS same_sound,
    (x.domain <> '' AND x.domain = y.domain) AS same_domain,
    (pp.a IS NOT NULL) AS same_phone,
    coalesce(sp.n, 0) AS shared_people,
    -- every signal is a plain 0 or 1: a NULL (an owner missing on one side) would blank the whole score
    coalesce(x.owner_id IS NOT NULL AND x.owner_id = y.owner_id, 0) AS same_owner,
    coalesce(abs(julianday(x.created_at) - julianday(y.created_at)) <= 2, 0) AS created_close
  FROM cand c JOIN ck x ON x.key = c.a JOIN ck y ON y.key = c.b
  LEFT JOIN phonepairs pp ON pp.a = c.a AND pp.b = c.b
  LEFT JOIN peoplepairs sp ON sp.a = c.a AND sp.b = c.b
)
SELECT a, b, a_label, b_label, same_name, same_sound, same_domain, same_phone, shared_people, same_owner, created_close,
  3 * same_name + 2 * (same_sound AND NOT same_name) + 3 * same_domain + 2 * same_phone
  + 2 * min(shared_people, 2) + same_owner + created_close AS score
FROM ev;

DROP VIEW IF EXISTS contact_duplicate_pairs;
CREATE VIEW contact_duplicate_pairs AS
WITH k AS MATERIALIZED (SELECT key, label, name_key, sound_key, owner_id, created_at FROM contact_keys),
sb AS MATERIALIZED (SELECT sound_key FROM k WHERE length(name_key) >= 5 GROUP BY sound_key HAVING count(*) BETWEEN 2 AND 30),
pk AS MATERIALIZED (SELECT tail, key FROM phones WHERE key >= '0-1/' AND key < '0-10'),
phonepairs AS MATERIALIZED (
  SELECT p.key AS a, q.key AS b FROM pk p JOIN pk q ON q.tail = p.tail AND p.key < q.key
  WHERE p.tail IN (SELECT tail FROM pk GROUP BY tail HAVING count(*) BETWEEN 2 AND 10) GROUP BY 1, 2),
lc AS MATERIALIZED (SELECT a AS person, b AS company FROM links WHERE a >= '0-1/' AND a < '0-10' AND b >= '0-2/' AND b < '0-20'),
cand AS (
  SELECT x.key AS a, y.key AS b FROM k x JOIN k y ON y.sound_key = x.sound_key AND x.key < y.key WHERE x.sound_key IN (SELECT sound_key FROM sb)
  UNION SELECT a, b FROM phonepairs
),
colleagues AS MATERIALIZED (
  SELECT DISTINCT c.a, c.b FROM cand c JOIN lc l1 ON l1.person = c.a JOIN lc l2 ON l2.person = c.b AND l2.company = l1.company),
ev AS (
  SELECT c.a, c.b, x.label AS a_label, y.label AS b_label,
    (x.name_key = y.name_key AND length(x.name_key) >= 5) AS same_name,
    (x.sound_key = y.sound_key AND length(x.name_key) >= 5) AS same_sound,
    (pp.a IS NOT NULL) AS same_phone,
    (co.a IS NOT NULL) AS same_company,
    coalesce(x.owner_id IS NOT NULL AND x.owner_id = y.owner_id, 0) AS same_owner
  FROM cand c JOIN k x ON x.key = c.a JOIN k y ON y.key = c.b
  LEFT JOIN phonepairs pp ON pp.a = c.a AND pp.b = c.b
  LEFT JOIN colleagues co ON co.a = c.a AND co.b = c.b
)
SELECT a, b, a_label, b_label, same_name, same_sound, same_phone, same_company, same_owner,
  3 * same_name + 2 * (same_sound AND NOT same_name) + 3 * same_phone + 2 * same_company + same_owner AS score
FROM ev;
