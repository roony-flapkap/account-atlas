// FINDINGS: named, read-only questions over the copy, each answered as rows
// of { keys (the records involved), label (what), detail (why), score }.
// An answer is kept for an hour (a day for the three that scan whole tables;
// one row in lookups), so opening the panel
// does not spend the day's reads; "fresh" asks again. A finding that needs a
// part of the copy still being filled says so, and answers with what is there.

import { addUsage, usageToday, pairsPaused } from "./sync.js";
import { SqlError } from "./sql.js";

const TTL_MS = 60 * 60000;
// the heavy three read 240,000–480,000 rows a run on the full copy: their answer
// is kept a day, and Refresh asks again at most once an hour
const HEAVY_TTL_MS = 24 * 60 * 60000, HEAVY_REFRESH_MS = 60 * 60000;
const MAX_ROWS = 500;

// The duplicate pairs are costly to work out (~800,000 rows read: D1 counts
// its own working tables too), so they are worked out once a night into
// dup_company_pairs / dup_contact_pairs, and the findings read those.
const PAIRS = {
  "0-2": { table: "dup_company_pairs", view: "duplicate_pairs",
           cols: "a, b, a_label, b_label, same_name, same_sound, same_domain, same_phone, shared_people, same_owner, created_close, score" },
  "0-1": { table: "dup_contact_pairs", view: "contact_duplicate_pairs",
           cols: "a, b, a_label, b_label, same_name, same_sound, same_phone, same_company, same_owner, score" }
};
export async function rebuildPairs(env, t){
  const p = PAIRS[t];
  const res = await env.GRAPH.batch([
    env.GRAPH.prepare("DELETE FROM " + p.table),
    env.GRAPH.prepare("INSERT INTO " + p.table + " (" + p.cols + ") SELECT " + p.cols + " FROM " + p.view + " WHERE score >= 4")
  ]);
  const sum = k => res.reduce((s, r) => s + (Number(r && r.meta && r.meta[k]) || 0), 0);
  return { rows: Number(res[1].meta && res[1].meta.changes) || 0, read: sum("rows_read"), written: sum("rows_written") };
}
const JUNK_TAILS = "('000000000','111111111','222222222','123456789','987654321','999999999','012345678')";
const COMPANY = "'0-2/' AND %s < '0-20'", CONTACT = "'0-1/' AND %s < '0-10'", DEAL = "'0-3/' AND %s < '0-30'", LEAD = "'0-136/' AND %s < '0-1360'";
const range = (col, r) => col + " >= " + r.replace("%s", col);
// shared by the global findings and the canvas ones, so the two never word a thing differently
const DUP_CO_DETAIL =
  "trim((CASE WHEN p.same_name THEN 'same name · ' WHEN p.same_sound THEN 'sounds alike · ' ELSE '' END) || " +
  "(CASE WHEN p.same_domain THEN 'same website · ' ELSE '' END) || (CASE WHEN p.same_phone THEN 'same number · ' ELSE '' END) || " +
  "(CASE WHEN p.shared_people > 0 THEN p.shared_people || (CASE WHEN p.shared_people = 1 THEN ' person' ELSE ' people' END) || ' in common · ' ELSE '' END) || " +
  "(CASE WHEN p.same_owner THEN 'same owner · ' ELSE '' END) || (CASE WHEN p.created_close THEN 'created within 2 days' ELSE '' END), ' ·')";
const DUP_CT_DETAIL =
  "trim((CASE WHEN p.same_name THEN 'same name · ' WHEN p.same_sound THEN 'sounds alike · ' ELSE '' END) || " +
  "(CASE WHEN p.same_phone THEN 'same number · ' ELSE '' END) || (CASE WHEN p.same_company THEN 'same company · ' ELSE '' END) || " +
  "(CASE WHEN p.same_owner THEN 'same owner' ELSE '' END), ' ·')";
const JUNK_NAME = r => "(" + r + ".label IS NULL OR trim(" + r + ".label) = '' OR lower(trim(" + r + ".label)) IN " +
  "('test','testing','asdf','n/a','na','-','.','x','xx','xxx','none','null','unknown','company','deal','lead') " +
  "OR lower(" + r + ".label) LIKE 'test %' OR lower(" + r + ".label) LIKE '% test')";
// the shared_numbers view's own test for a placeholder number
const JUNK_TAIL = t => "(" + t + " IN " + JUNK_TAILS + " OR " + t + " GLOB '*0000000*' OR " + t + " GLOB '*1111111*' OR " + t + " GLOB '*9999999*')";

const PEOPLE_AND_COMPANIES = ["backfill:0-1", "links:0-2>0-1"];
export const FINDINGS = [
  { id: "dup-companies", group: "Duplicates", title: "Smart duplicate companies", pairs: "0-2",
    blurb: "Pairs that look like one business: a name that cleans up or sounds the same, the same website, the same number, people in common, the same owner, created days apart. Two signals at least; strongest first. Worked out each night.",
    needs: ["backfill:0-2"],
    sql: "SELECT p.a || ' ' || p.b AS keys, p.a_label || '  ↔  ' || p.b_label AS label, " + DUP_CO_DETAIL + " AS detail, p.score AS score " +
         // a pair one of whose records has since been deleted or merged is left out
         "FROM dup_company_pairs p JOIN records r1 ON r1.key = p.a AND r1.deleted_at IS NULL JOIN records r2 ON r2.key = p.b AND r2.deleted_at IS NULL " +
         "ORDER BY p.score DESC, p.a LIMIT " + MAX_ROWS },
  { id: "dup-contacts", group: "Duplicates", title: "Smart duplicate contacts", pairs: "0-1",
    blurb: "One person entered twice: the same or a sound-alike name, with the same number or on the same company. Worked out each night.",
    needs: PEOPLE_AND_COMPANIES,
    sql: "SELECT p.a || ' ' || p.b AS keys, p.a_label || '  ↔  ' || p.b_label AS label, " + DUP_CT_DETAIL + " AS detail, p.score AS score " +
         "FROM dup_contact_pairs p JOIN records r1 ON r1.key = p.a AND r1.deleted_at IS NULL JOIN records r2 ON r2.key = p.b AND r2.deleted_at IS NULL " +
         "ORDER BY p.score DESC, p.a LIMIT " + MAX_ROWS },
  { id: "shared-numbers", group: "Hidden links", title: "One number, many companies", heavy: true,
    blurb: "A phone number on three or more companies, or five or more records: an agent, an accountant, a typing office — or one owner behind several businesses.",
    needs: ["backfill:0-2", "backfill:0-1"],
    sql: "SELECT keys, 'Number ending ' || tail AS label, companies || ' companies · ' || contacts || ' contacts' AS detail, records AS score " +
         "FROM shared_numbers WHERE NOT junk AND (companies >= 3 OR records >= 5) ORDER BY records DESC LIMIT " + MAX_ROWS },
  { id: "connectors", group: "Hidden links", title: "People on 3+ companies", heavy: true,
    blurb: "One person on three or more companies: a group, a consultant, a shared finance mailbox — or contacts put on the wrong account.",
    needs: PEOPLE_AND_COMPANIES,
    sql: "SELECT l.a || ' ' || group_concat(l.b, ' ') AS keys, coalesce(r.label, 'Contact ' || substr(l.a, 5)) AS label, count(*) || ' companies' AS detail, count(*) AS score " +
         "FROM links l LEFT JOIN records r ON r.key = l.a WHERE " + range("l.a", CONTACT) + " AND " + range("l.b", COMPANY) + " " +
         "GROUP BY l.a HAVING count(*) >= 3 ORDER BY score DESC LIMIT " + MAX_ROWS },
  { id: "unattached", group: "Hidden links", title: "Unattached, same number", heavy: true,
    blurb: "A contact carrying a company's phone number with no link to it: activity logged against one is invisible from the other.",
    needs: PEOPLE_AND_COMPANIES,
    sql: "SELECT p.key || ' ' || q.key AS keys, coalesce(co.label, 'Company') || '  ·  ' || coalesce(ct.label, 'Contact ' || substr(q.key, 5)) AS label, " +
         "'number ending ' || p.tail AS detail, 1 AS score FROM phones p " +
         "JOIN phones q ON q.tail = p.tail AND " + range("q.key", CONTACT) + " " +
         "JOIN records co ON co.key = p.key LEFT JOIN records ct ON ct.key = q.key " +
         "WHERE " + range("p.key", COMPANY) + " AND p.tail NOT IN " + JUNK_TAILS + " " +
         "AND p.tail IN (SELECT tail FROM phones GROUP BY tail HAVING count(*) <= 6) " +
         "AND NOT EXISTS (SELECT 1 FROM links l WHERE l.a = q.key AND l.b = p.key) ORDER BY p.key LIMIT " + MAX_ROWS },
  { id: "deals-elsewhere", group: "Hidden links", title: "Deals with a contact from elsewhere",
    blurb: "A deal on one company whose contact is not on that company: the deal, or the person, may sit on the wrong account.",
    needs: ["links:0-2>0-3", "links:0-1>0-3", "links:0-2>0-1"],
    sql: "SELECT dc.b || ' ' || dc.a || ' ' || dp.b AS keys, coalesce(rd.label, 'Deal') || '  ·  ' || coalesce(rp.label, 'Contact ' || substr(dp.b, 5)) AS label, " +
         "'on ' || coalesce(rc.label, 'a company') || ', and the contact is not' AS detail, 1 AS score " +
         "FROM links dc JOIN links dp ON dp.a = dc.a " +
         "LEFT JOIN records rd ON rd.key = dc.a LEFT JOIN records rc ON rc.key = dc.b LEFT JOIN records rp ON rp.key = dp.b " +
         "WHERE " + range("dc.a", DEAL) + " AND " + range("dc.b", COMPANY) + " AND " + range("dp.b", CONTACT) + " " +
         "AND NOT EXISTS (SELECT 1 FROM links x WHERE x.a = dp.b AND x.b = dc.b) ORDER BY dc.a LIMIT " + MAX_ROWS },
  { id: "gone-owners", group: "Ownership", title: "Owned by people who left",
    blurb: "Records whose owner is no longer at FlapKap: nobody is following them up.",
    needs: [],
    sql: "WITH gone AS (SELECT j.key AS id, j.value AS name FROM lookups, json_each(lookups.data, '$.gone') j WHERE lookups.name = 'names') " +
         "SELECT r.key AS keys, coalesce(r.label, 'Record ' || substr(r.key, instr(r.key, '/') + 1)) AS label, 'owned by ' || gone.name || ' (left)' AS detail, 1 AS score " +
         "FROM records r JOIN gone ON gone.id = r.owner_id WHERE r.deleted_at IS NULL ORDER BY r.key LIMIT " + MAX_ROWS },
  { id: "junk", group: "Data quality", title: "Placeholder names and numbers",
    blurb: "Test records, names like “-” or “n/a”, and numbers like 000000000 or 123456789 on real records.",
    needs: [],
    sql: "SELECT r.key AS keys, coalesce(r.label, '(no name)') AS label, 'placeholder name' AS detail, 1 AS score FROM records r " +
         "WHERE r.deleted_at IS NULL AND r.key NOT LIKE '0-1/%' AND " + JUNK_NAME("r") + " " +
         "UNION ALL SELECT keys, 'Number ending ' || tail, 'a placeholder number on ' || records || ' records', records FROM shared_numbers WHERE junk " +
         "LIMIT " + MAX_ROWS },
  { id: "orphan-deals", group: "Data quality", title: "Deals on no company",
    blurb: "Deals nobody can find from an account.",
    needs: ["backfill:0-3", "links:0-2>0-3"],
    sql: "SELECT r.key AS keys, coalesce(r.label, 'Deal ' || substr(r.key, 5)) AS label, 'on no company' AS detail, 1 AS score FROM records r " +
         "WHERE " + range("r.key", DEAL) + " AND r.deleted_at IS NULL " +
         "AND NOT EXISTS (SELECT 1 FROM links l WHERE l.a = r.key AND " + range("l.b", COMPANY) + ") ORDER BY r.key LIMIT " + MAX_ROWS },
  { id: "orphan-leads", group: "Data quality", title: "Leads on no company",
    blurb: "Leads nobody can find from an account.",
    needs: ["backfill:0-136", "links:0-2>0-136"],
    sql: "SELECT r.key AS keys, coalesce(r.label, 'Lead ' || substr(r.key, 7)) AS label, 'on no company' AS detail, 1 AS score FROM records r " +
         "WHERE " + range("r.key", LEAD) + " AND r.deleted_at IS NULL " +
         "AND NOT EXISTS (SELECT 1 FROM links l WHERE l.a = r.key AND " + range("l.b", COMPANY) + ") ORDER BY r.key LIMIT " + MAX_ROWS }
];
const BY_ID = Object.fromEntries(FINDINGS.map(f => [f.id, f]));

const JOB_WORD = { "backfill:0-2": "companies", "backfill:0-1": "contacts", "backfill:0-3": "deals", "backfill:0-136": "leads",
  "links:0-2>0-1": "company–contact links", "links:0-2>0-3": "company–deal links", "links:0-2>0-136": "company–lead links",
  "links:0-1>0-3": "contact–deal links", "links:0-1>0-136": "contact–lead links", "links:0-136>0-3": "lead–deal links" };

async function jobStates(env){
  const r = await env.GRAPH.prepare("SELECT job, status FROM sync_state WHERE job LIKE 'backfill:%' OR job LIKE 'links:%'").all();
  return new Map((r.results || []).map(j => [j.job, j.status]));
}
const waitingFor = (f, jobs) => f.needs.filter(j => jobs.get(j) !== "done").map(j => JOB_WORD[j] || j);

async function cached(env, id){
  const row = await env.GRAPH.prepare("SELECT data, at FROM lookups WHERE name = ?1").bind("finding:" + id).first();
  if (!row) return null;
  try { return Object.assign(JSON.parse(row.data), { at: row.at }); } catch(e){ return null; }
}

export async function listFindings(env){
  const jobs = await jobStates(env);
  const r = await env.GRAPH.prepare("SELECT name, data, at FROM lookups WHERE name LIKE 'finding:%'").all();
  const seen = new Map();
  for (const row of r.results || []){ try { const d = JSON.parse(row.data); seen.set(row.name.slice(8), { count: d.count, more: d.more, at: row.at }); } catch(e){} }
  return { findings: FINDINGS.map(f => ({ id: f.id, group: f.group, title: f.title, blurb: f.blurb, sql: f.sql,
    waiting: waitingFor(f, jobs), last: seen.get(f.id) || null })) };
}

export async function runFinding(env, user, id, { fresh = false } = {}){
  const f = BY_ID[id];
  if (!f) throw new SqlError("bad_input", "no such finding");
  const jobs = await jobStates(env);
  const waiting = waitingFor(f, jobs);
  const c0 = await cached(env, id);
  const age = c0 ? Date.now() - Date.parse(c0.at) : Infinity;
  if (!fresh && age < (f.heavy ? HEAVY_TTL_MS : TTL_MS)) return Object.assign(c0, { id, waiting, cached: true });
  if (fresh && f.heavy && age < HEAVY_REFRESH_MS){
    const next = new Date(Date.parse(c0.at) + HEAVY_REFRESH_MS).toISOString().slice(11, 16);
    return Object.assign(c0, { id, waiting, cached: true, note: "worked out " + Math.max(1, Math.round(age / 60000)) + " min ago; it can be asked again from " + next + " UTC" });
  }
  // the duplicate lists come from the nightly tables: until the first night, there is nothing to read
  let pairsAt = null;
  if (f.pairs){
    const j = await env.GRAPH.prepare("SELECT finished_at FROM sync_state WHERE job = ?1").bind("pairs:" + f.pairs).first();
    pairsAt = (j && j.finished_at) || null;
    if (!pairsAt) return { id, waiting, count: 0, more: false, rows: [], at: new Date().toISOString(), cached: false, rowsRead: 0,
                           note: pairsPaused(env) ? "the nightly rebuild of this list is paused for now, and there is no list yet"
                                                  : "the first list is worked out tonight, at 02:00 UTC, and every night after" };
  }
  const budget = Number(env.SQL_READ_BUDGET) || 1000000;
  const used = (await usageToday(env)).sql_reads;
  if (used >= budget){
    if (c0) return Object.assign(c0, { id, waiting, cached: true, note: "today's read allowance is spent; this is the last answer" });
    throw new SqlError("budget", "today's read allowance (" + budget.toLocaleString("en-US") + " rows) is spent; it resets at 00:00 UTC");
  }
  const t0 = Date.now();
  let r;
  try { r = await env.GRAPH.prepare(f.sql).all(); }
  catch(e){ throw new SqlError("sql_error", String(e && e.message || e).replace(/^D1_ERROR:\s*/, "").slice(0, 400)); }
  const rows = (r.results || []).map(x => ({ keys: String(x.keys || "").split(" ").filter(Boolean), label: x.label || "", detail: x.detail || "", score: Number(x.score) || 0 }));
  const read = Number(r.meta && r.meta.rows_read) || rows.length;
  await addUsage(env, "sql_reads", read);
  const out = { count: rows.length, more: rows.length >= MAX_ROWS, rows, ms: Date.now() - t0, rowsRead: read };
  if (pairsAt) out.note = "the pairs were worked out " + pairsAt.slice(0, 16).replace("T", " ") + " UTC" +
                          (pairsPaused(env) ? "; the nightly rebuild is paused for now" : "");
  const at = new Date().toISOString();
  await env.GRAPH.prepare("INSERT INTO lookups (name, data, at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO UPDATE SET data = excluded.data, at = excluded.at")
    .bind("finding:" + id, JSON.stringify(out), at).run();
  if (user) await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'finding', ?3)")
    .bind(at, user.email, JSON.stringify({ id, rows: rows.length, read })).run().catch(() => {});
  return Object.assign(out, { id, waiting, at, cached: false });
}

/* ---------------- this canvas ----------------
   The same kinds of question asked of one canvas's records, worked out when
   asked. Every one starts from the canvas's keys (one json_each parameter)
   and reaches the rest of the copy only by key lookups (records by key,
   links by their first end, phone endings by number), so a run reads rows in
   proportion to the canvas, not the portal. A match outside the canvas is
   kept: the page marks it "elsewhere". */
const MAX_CANVAS_KEYS = 6000, CANVAS_ROWS = 200;
const KEY_RE = /^0-(1|2|3|136)\/\d{1,20}$/;
const K_CTE = "k(key) AS (SELECT DISTINCT value FROM json_each(?1))";
const inK = col => col + " IN (SELECT key FROM k)";
// a record's phone endings, one row each (they are digits, so they make safe JSON)
const tailsOf = r => "json_each('[\"' || replace(" + r + ".tails, ' ', '\",\"') || '\"]')";
const lim = " LIMIT " + CANVAS_ROWS;

export const CANVAS_FINDINGS = [
  { id: "cv-dup-companies", group: "Duplicates", title: "Duplicates of its companies",
    blurb: "Companies here that look like another company, here or elsewhere: the same signals as the global list, from the same nightly pairs.",
    sql: "WITH " + K_CTE + " SELECT p.a || ' ' || p.b AS keys, p.a_label || '  ↔  ' || p.b_label AS label, " + DUP_CO_DETAIL + " AS detail, p.score AS score " +
         "FROM dup_company_pairs p WHERE (" + inK("p.a") + " OR " + inK("p.b") + ") " +
         "AND EXISTS (SELECT 1 FROM records r1 WHERE r1.key = p.a AND r1.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM records r2 WHERE r2.key = p.b AND r2.deleted_at IS NULL) " +
         "ORDER BY p.score DESC, p.a" + lim },
  { id: "cv-dup-contacts", group: "Duplicates", title: "Duplicates of its contacts",
    blurb: "People here entered twice, here or elsewhere: the same or a sound-alike name, with the same number or on the same company.",
    sql: "WITH " + K_CTE + " SELECT p.a || ' ' || p.b AS keys, p.a_label || '  ↔  ' || p.b_label AS label, " + DUP_CT_DETAIL + " AS detail, p.score AS score " +
         "FROM dup_contact_pairs p WHERE (" + inK("p.a") + " OR " + inK("p.b") + ") " +
         "AND EXISTS (SELECT 1 FROM records r1 WHERE r1.key = p.a AND r1.deleted_at IS NULL) AND EXISTS (SELECT 1 FROM records r2 WHERE r2.key = p.b AND r2.deleted_at IS NULL) " +
         "ORDER BY p.score DESC, p.a" + lim },
  { id: "cv-shared-numbers", group: "Hidden links", title: "Its numbers, on records elsewhere",
    blurb: "A phone number on a record here that is also on records not on this canvas: a link HubSpot does not show.",
    sql: "WITH " + K_CTE + ", " +
         "t AS (SELECT r.key AS rk, j.value AS tail FROM k JOIN records r ON r.key = k.key, " + tailsOf("r") + " j " +
               "WHERE r.tails IS NOT NULL AND r.deleted_at IS NULL AND NOT " + JUNK_TAIL("j.value") + "), " +
         "o AS (SELECT t.tail, t.rk, p.key AS other FROM t JOIN phones p ON p.tail = t.tail WHERE p.key NOT IN (SELECT key FROM k)) " +
         "SELECT replace(group_concat(DISTINCT rk), ',', ' ') || ' ' || replace(group_concat(DISTINCT other), ',', ' ') AS keys, 'Number ending ' || tail AS label, " +
         "count(DISTINCT other) || ' elsewhere · ' || count(DISTINCT CASE WHEN " + range("other", COMPANY) + " THEN other END) || ' of them companies' AS detail, " +
         "count(DISTINCT other) AS score FROM o GROUP BY tail ORDER BY score DESC" + lim },
  { id: "cv-connectors", group: "Hidden links", title: "Its people on 3+ companies",
    blurb: "A contact here on three or more companies: a group, a consultant, a shared mailbox — or a contact on the wrong account.",
    sql: "WITH " + K_CTE + " SELECT l.a || ' ' || group_concat(l.b, ' ') AS keys, coalesce(r.label, 'Contact ' || substr(l.a, 5)) AS label, " +
         "count(*) || ' companies' AS detail, count(*) AS score " +
         "FROM k JOIN links l ON l.a = k.key LEFT JOIN records r ON r.key = l.a " +
         "WHERE " + range("k.key", CONTACT) + " AND " + range("l.b", COMPANY) + " GROUP BY l.a HAVING count(*) >= 3 ORDER BY score DESC" + lim },
  { id: "cv-unattached", group: "Hidden links", title: "Unattached, same number as its companies",
    blurb: "A contact carrying the number of a company here, with no link to it. Numbers on more than six records are left out.",
    sql: "WITH " + K_CTE + ", " +
         "t AS (SELECT r.key AS co, r.label AS colabel, j.value AS tail FROM k JOIN records r ON r.key = k.key, " + tailsOf("r") + " j " +
               "WHERE " + range("k.key", COMPANY) + " AND r.tails IS NOT NULL AND r.deleted_at IS NULL AND NOT " + JUNK_TAIL("j.value") + " " +
               "AND (SELECT count(*) FROM phones c WHERE c.tail = j.value) <= 6) " +
         "SELECT t.co || ' ' || q.key AS keys, coalesce(t.colabel, 'Company') || '  ·  ' || coalesce(ct.label, 'Contact ' || substr(q.key, 5)) AS label, " +
         "'number ending ' || t.tail AS detail, 1 AS score " +
         "FROM t JOIN phones q ON q.tail = t.tail AND " + range("q.key", CONTACT) + " LEFT JOIN records ct ON ct.key = q.key " +
         "WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.a = q.key AND l.b = t.co) ORDER BY t.co" + lim },
  { id: "cv-deals-elsewhere", group: "Hidden links", title: "Its deals with a contact from elsewhere",
    blurb: "A deal here on a company whose contact is not on that company: the deal, or the person, may sit on the wrong account.",
    sql: "WITH " + K_CTE + " SELECT dc.b || ' ' || dc.a || ' ' || dp.b AS keys, coalesce(rd.label, 'Deal') || '  ·  ' || coalesce(rp.label, 'Contact ' || substr(dp.b, 5)) AS label, " +
         "'on ' || coalesce(rc.label, 'a company') || ', and the contact is not' AS detail, 1 AS score " +
         "FROM k JOIN links dc ON dc.a = k.key AND " + range("dc.b", COMPANY) + " JOIN links dp ON dp.a = k.key AND " + range("dp.b", CONTACT) + " " +
         "LEFT JOIN records rd ON rd.key = k.key LEFT JOIN records rc ON rc.key = dc.b LEFT JOIN records rp ON rp.key = dp.b " +
         "WHERE " + range("k.key", DEAL) + " AND NOT EXISTS (SELECT 1 FROM links x WHERE x.a = dp.b AND x.b = dc.b) ORDER BY k.key" + lim },
  { id: "cv-gone-owners", group: "Ownership", title: "Owned by people who left",
    blurb: "Records here whose owner is no longer at FlapKap: nobody is following them up.",
    sql: "WITH " + K_CTE + ", gone AS (SELECT j.key AS id, j.value AS name FROM lookups, json_each(lookups.data, '$.gone') j WHERE lookups.name = 'names') " +
         "SELECT r.key AS keys, coalesce(r.label, 'Record ' || substr(r.key, instr(r.key, '/') + 1)) AS label, 'owned by ' || gone.name || ' (left)' AS detail, 1 AS score " +
         "FROM k JOIN records r ON r.key = k.key AND r.deleted_at IS NULL JOIN gone ON gone.id = r.owner_id ORDER BY r.key" + lim },
  { id: "cv-junk", group: "Data quality", title: "Placeholder names and numbers",
    blurb: "Records here named like “test” or “n/a”, or carrying a number like 000000000.",
    sql: "WITH " + K_CTE + " SELECT r.key AS keys, coalesce(r.label, '(no name)') AS label, 'placeholder name' AS detail, 1 AS score " +
         "FROM k JOIN records r ON r.key = k.key WHERE r.deleted_at IS NULL AND r.key NOT LIKE '0-1/%' AND " + JUNK_NAME("r") + " " +
         "UNION ALL SELECT r.key, coalesce(r.label, '(no name)'), 'a placeholder number, ending ' || j.value, 1 " +
         "FROM k JOIN records r ON r.key = k.key, " + tailsOf("r") + " j WHERE r.tails IS NOT NULL AND r.deleted_at IS NULL AND " + JUNK_TAIL("j.value") + lim }
];

export async function runCanvasFindings(env, user, keys){
  const clean = [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(k => KEY_RE.test(k)))];
  if (!clean.length) throw new SqlError("bad_input", "no records to ask about");
  const asked = clean.slice(0, MAX_CANVAS_KEYS);
  const budget = Number(env.SQL_READ_BUDGET) || 1000000;
  if ((await usageToday(env)).sql_reads >= budget)
    throw new SqlError("budget", "today's read allowance (" + budget.toLocaleString("en-US") + " rows) is spent; it resets at 00:00 UTC");
  const t0 = Date.now(), ks = JSON.stringify(asked);
  let res;
  try { res = await env.GRAPH.batch(CANVAS_FINDINGS.map(f => env.GRAPH.prepare(f.sql).bind(ks))); }
  catch(e){ throw new SqlError("sql_error", String(e && e.message || e).replace(/^D1_ERROR:\s*/, "").slice(0, 400)); }
  let read = 0;
  const findings = CANVAS_FINDINGS.map((f, i) => {
    const r = res[i] || {};
    read += Number(r.meta && r.meta.rows_read) || 0;
    const rows = (r.results || []).map(x => ({ keys: String(x.keys || "").split(" ").filter(Boolean), label: x.label || "", detail: x.detail || "", score: Number(x.score) || 0 }));
    return { id: f.id, group: f.group, title: f.title, blurb: f.blurb, count: rows.length, more: rows.length >= CANVAS_ROWS, rows };
  });
  await addUsage(env, "sql_reads", read);
  // the duplicate lists are only as fresh as the nightly pairs
  const pj = await env.GRAPH.prepare("SELECT max(finished_at) AS at FROM sync_state WHERE job IN ('pairs:0-2', 'pairs:0-1')").first();
  const note = pj && pj.at ? "duplicates as worked out " + pj.at.slice(0, 16).replace("T", " ") + " UTC" + (pairsPaused(env) ? " (their nightly rebuild is paused)" : "") : "";
  const at = new Date().toISOString();
  if (user) await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'finding', ?3)")
    .bind(at, user.email, JSON.stringify({ id: "canvas", records: asked.length, read })).run().catch(() => {});
  return { findings, records: asked.length, trimmed: clean.length > asked.length, rowsRead: read, ms: Date.now() - t0, at, note };
}
