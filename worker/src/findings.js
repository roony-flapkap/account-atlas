// FINDINGS: named, read-only questions over the copy, each answered as rows
// of { keys (the records involved), label (what), detail (why), score }.
// An answer is kept for an hour (one row in lookups), so opening the panel
// does not spend the day's reads; "fresh" asks again. A finding that needs a
// part of the copy still being filled says so, and answers with what is there.

import { addUsage, usageToday } from "./sync.js";
import { SqlError } from "./sql.js";

const TTL_MS = 60 * 60000;
// the duplicate findings read ~800,000 rows a run on the live copy (D1 counts
// its own working tables too): kept longer, and asked again at most this often
const HEAVY_TTL_MS = 6 * 60 * 60000;
const HEAVY_GAP_MS = 15 * 60000;
const MAX_ROWS = 500;
const JUNK_TAILS = "('000000000','111111111','222222222','123456789','987654321','999999999','012345678')";
const COMPANY = "'0-2/' AND %s < '0-20'", CONTACT = "'0-1/' AND %s < '0-10'", DEAL = "'0-3/' AND %s < '0-30'", LEAD = "'0-136/' AND %s < '0-1360'";
const range = (col, r) => col + " >= " + r.replace("%s", col);

const PEOPLE_AND_COMPANIES = ["backfill:0-1", "links:0-2>0-1"];
export const FINDINGS = [
  { id: "dup-companies", group: "Duplicates", title: "Smart duplicate companies", heavy: true,
    blurb: "Pairs that look like one business: a name that cleans up or sounds the same, the same website, the same number, people in common, the same owner, created days apart. Two signals at least; strongest first.",
    needs: ["backfill:0-2"],
    sql: "SELECT a || ' ' || b AS keys, a_label || '  ↔  ' || b_label AS label, " +
         "trim((CASE WHEN same_name THEN 'same name · ' WHEN same_sound THEN 'sounds alike · ' ELSE '' END) || " +
         "(CASE WHEN same_domain THEN 'same website · ' ELSE '' END) || (CASE WHEN same_phone THEN 'same number · ' ELSE '' END) || " +
         "(CASE WHEN shared_people > 0 THEN shared_people || (CASE WHEN shared_people = 1 THEN ' person' ELSE ' people' END) || ' in common · ' ELSE '' END) || " +
         "(CASE WHEN same_owner THEN 'same owner · ' ELSE '' END) || (CASE WHEN created_close THEN 'created within 2 days' ELSE '' END), ' ·') AS detail, score " +
         "FROM duplicate_pairs WHERE score >= 4 ORDER BY score DESC, a LIMIT " + MAX_ROWS },
  { id: "dup-contacts", group: "Duplicates", title: "Smart duplicate contacts", heavy: true,
    blurb: "One person entered twice: the same or a sound-alike name, with the same number or on the same company.",
    needs: PEOPLE_AND_COMPANIES,
    sql: "SELECT a || ' ' || b AS keys, a_label || '  ↔  ' || b_label AS label, " +
         "trim((CASE WHEN same_name THEN 'same name · ' WHEN same_sound THEN 'sounds alike · ' ELSE '' END) || " +
         "(CASE WHEN same_phone THEN 'same number · ' ELSE '' END) || (CASE WHEN same_company THEN 'same company · ' ELSE '' END) || " +
         "(CASE WHEN same_owner THEN 'same owner' ELSE '' END), ' ·') AS detail, score " +
         "FROM contact_duplicate_pairs WHERE score >= 4 ORDER BY score DESC, a LIMIT " + MAX_ROWS },
  { id: "shared-numbers", group: "Hidden links", title: "One number, many companies",
    blurb: "A phone number on three or more companies, or five or more records: an agent, an accountant, a typing office — or one owner behind several businesses.",
    needs: ["backfill:0-2", "backfill:0-1"],
    sql: "SELECT keys, 'Number ending ' || tail AS label, companies || ' companies · ' || contacts || ' contacts' AS detail, records AS score " +
         "FROM shared_numbers WHERE NOT junk AND (companies >= 3 OR records >= 5) ORDER BY records DESC LIMIT " + MAX_ROWS },
  { id: "connectors", group: "Hidden links", title: "People on 3+ companies",
    blurb: "One person on three or more companies: a group, a consultant, a shared finance mailbox — or contacts put on the wrong account.",
    needs: PEOPLE_AND_COMPANIES,
    sql: "SELECT l.a || ' ' || group_concat(l.b, ' ') AS keys, coalesce(r.label, 'Contact ' || substr(l.a, 5)) AS label, count(*) || ' companies' AS detail, count(*) AS score " +
         "FROM links l LEFT JOIN records r ON r.key = l.a WHERE " + range("l.a", CONTACT) + " AND " + range("l.b", COMPANY) + " " +
         "GROUP BY l.a HAVING count(*) >= 3 ORDER BY score DESC LIMIT " + MAX_ROWS },
  { id: "unattached", group: "Hidden links", title: "Unattached, same number",
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
    sql: "SELECT key AS keys, coalesce(label, '(no name)') AS label, 'placeholder name' AS detail, 1 AS score FROM records " +
         "WHERE deleted_at IS NULL AND key NOT LIKE '0-1/%' AND (label IS NULL OR trim(label) = '' OR lower(trim(label)) IN ('test','testing','asdf','n/a','na','-','.','x','xx','xxx','none','null','unknown','company','deal','lead') " +
         "OR lower(label) LIKE 'test %' OR lower(label) LIKE '% test') " +
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
  if (fresh && f.heavy && age < HEAVY_GAP_MS)
    return Object.assign(c0, { id, waiting, cached: true, note: "asked less than 15 minutes ago — this is that answer (each run reads ~800,000 rows)" });
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
  const at = new Date().toISOString();
  await env.GRAPH.prepare("INSERT INTO lookups (name, data, at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO UPDATE SET data = excluded.data, at = excluded.at")
    .bind("finding:" + id, JSON.stringify(out), at).run();
  if (user) await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'finding', ?3)")
    .bind(at, user.email, JSON.stringify({ id, rows: rows.length, read })).run().catch(() => {});
  return Object.assign(out, { id, waiting, at, cached: false });
}
