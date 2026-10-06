// The SQL console: read-only queries by signed-in teammates, against the CRM
// copy only (atlas-graph). Canvases, private or shared, live in the other
// database and cannot be reached from here.
//
// D1 has no read-only connection, so three locks, each enough alone for the
// common cases and together for the rest:
//   1. outside string literals and comments, one statement, starting SELECT
//      or WITH, and none of the words that write or change the schema;
//   2. the query runs wrapped as a subquery — SELECT * FROM (…) LIMIT n —
//      where an INSERT, a second statement or a PRAGMA is a syntax error;
//   3. even if both failed, it could only touch the copy, which the sync
//      rebuilds from HubSpot.
// Reads count against a daily allowance: the free plan allows 5 million.

import { addUsage, usageToday } from "./sync.js";

const MAX_ROWS = 1000;
const MAX_LEN = 20000;
const WRITES = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "ATTACH", "DETACH", "PRAGMA", "VACUUM", "REINDEX",
                "ANALYZE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "TRANSACTION", "UPSERT", "TRIGGER"];

export class SqlError extends Error { constructor(code, message){ super(message); this.code = code; } }

// the query with its literals and comments blanked out, for scanning only
export function skeleton(sql){
  let out = "", i = 0;
  while (i < sql.length){
    const c = sql[i], n = sql[i + 1];
    if (c === "-" && n === "-"){ const e = sql.indexOf("\n", i); i = e < 0 ? sql.length : e; out += " "; continue; }
    if (c === "/" && n === "*"){ const e = sql.indexOf("*/", i + 2); if (e < 0) throw new SqlError("bad_sql", "unclosed comment"); i = e + 2; out += " "; continue; }
    if (c === "'" || c === '"' || c === "`" || c === "["){
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;){
        if (j >= sql.length) throw new SqlError("bad_sql", "unclosed quote");
        if (sql[j] === close){ if (close !== "]" && sql[j + 1] === close){ j += 2; continue; } break; }
        j++;
      }
      // quoted identifiers keep a placeholder name; string literals become ''
      out += c === "'" ? "''" : "q";
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

export function checkSql(sql){
  sql = String(sql || "").trim().replace(/;\s*$/, "");
  if (!sql) throw new SqlError("bad_sql", "empty query");
  if (sql.length > MAX_LEN) throw new SqlError("bad_sql", "query too long");
  const s = skeleton(sql);
  if (s.indexOf(";") >= 0) throw new SqlError("not_allowed", "one statement at a time");
  if (!/^\s*(select|with)\b/i.test(s)) throw new SqlError("not_allowed", "only SELECT (or WITH … SELECT) queries");
  for (const w of WRITES) if (new RegExp("\\b" + w + "\\b", "i").test(s)) throw new SqlError("not_allowed", w + " is not allowed: this console only reads");
  // REPLACE is also a string function, so only the statement form is refused
  if (/\breplace\b(?!\s*\()/i.test(s)) throw new SqlError("not_allowed", "REPLACE is not allowed: this console only reads");
  return sql;
}

async function allowance(env){
  const budget = Number(env.SQL_READ_BUDGET) || 1000000;
  const used = (await usageToday(env)).sql_reads;
  if (used >= budget) throw new SqlError("budget", "today's SQL read allowance (" + budget.toLocaleString("en-US") + " rows) is spent; it resets at 00:00 UTC");
  return { budget, used };
}

export async function runSql(env, user, sql){
  const q = checkSql(sql);
  const { budget, used } = await allowance(env);
  const t0 = Date.now();
  let r;
  try { r = await env.GRAPH.prepare("SELECT * FROM (" + q + "\n) LIMIT " + (MAX_ROWS + 1)).all(); }
  catch(e){ throw new SqlError("sql_error", String(e && e.message || e).replace(/^D1_ERROR:\s*/, "").slice(0, 400)); }
  const objs = r.results || [];
  const columns = objs.length ? Object.keys(objs[0]) : [];
  const rows = objs.map(o => columns.map(c => o[c]));
  // what D1 itself read, which is what the daily allowance counts: a
  // count(*) returns one row but reads the whole table
  const rowsRead = Number(r.meta && r.meta.rows_read) || rows.length;
  const truncated = rows.length > MAX_ROWS;
  await addUsage(env, "sql_reads", rowsRead);
  await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'sql', ?3)")
    .bind(new Date().toISOString(), user.email, JSON.stringify({ sql: q.slice(0, 2000), rows: Math.min(rows.length, MAX_ROWS), read: rowsRead })).run();
  return { columns, rows: rows.slice(0, MAX_ROWS), truncated, ms: Date.now() - t0, rowsRead, readToday: used + rowsRead, readBudget: budget };
}

// Every record of one type in a query's result, however many rows: for a
// HubSpot list (lists.js). The query runs in full, with no row limit, and D1
// itself picks the keys out of the named columns — any number to a cell,
// split on spaces and commas as the page's keysIn reads them — and answers
// with their ids joined in one string, so the Worker does nothing per row
// (the free plan allows it 10 ms of CPU). A cell becomes a JSON array of its
// words for json_each: backslashes and quotes escaped, tabs, newlines and
// commas made spaces; a cell that still is not valid JSON is passed over.
const KEY_TYPES = ["0-1", "0-2", "0-3", "0-136"];
const WORDS = String.raw`'["' || replace(replace(replace(replace(replace(replace(replace(v, '\', '\\'), '"', '\"'), char(9), ' '), char(10), ' '), char(13), ' '), ',', ' '), ' ', '","') || '"]'`;
export async function sqlKeys(env, user, sql, columns, type){
  const q = checkSql(sql);
  if (KEY_TYPES.indexOf(type) < 0) throw new SqlError("bad_input", "a record type is 0-1, 0-2, 0-3 or 0-136");
  const cols = [...new Set((Array.isArray(columns) ? columns : []).map(String).filter(Boolean))];
  if (!cols.length || cols.length > 64) throw new SqlError("bad_input", "name the result's columns (1 to 64)");
  const { budget, used } = await allowance(env);
  // a column is named in backticks, its own doubled, so it cannot end the name
  // early; SQLite reads an unknown "name" in double quotes as a string, but
  // an unknown `name` is an error, so a wrong column is said, not missed
  const cell = cols.map(c => "coalesce(CAST(`" + c.replace(/`/g, "``") + "` AS TEXT), '')").join(" || ' ' || ");
  const pre = type + "/", from = pre.length + 1;
  const stmt =
    "SELECT count(*) AS n, group_concat(id) AS ids FROM (" +
      "SELECT DISTINCT substr(j.value, " + from + ") AS id " +
      "FROM (SELECT " + WORDS + " AS arr FROM (SELECT " + cell + " AS v FROM (" + q + "\n)) WHERE v GLOB '*0-[0-9]*/[0-9]*') r, " +
        "json_each(CASE WHEN json_valid(r.arr) THEN r.arr ELSE '[]' END) j " +
      "WHERE j.value GLOB '" + pre + "[0-9]*' AND substr(j.value, " + from + ") NOT GLOB '*[^0-9]*' AND length(j.value) <= " + (pre.length + 20) + ")";
  const t0 = Date.now();
  let r;
  try { r = await env.GRAPH.prepare(stmt).all(); }
  catch(e){ throw new SqlError("sql_error", String(e && e.message || e).replace(/^D1_ERROR:\s*/, "").slice(0, 400)); }
  const row = (r.results || [])[0] || {};
  const count = Number(row.n) || 0;
  const rowsRead = Number(r.meta && r.meta.rows_read) || 0;
  await addUsage(env, "sql_reads", rowsRead);
  await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'sql', ?3)")
    .bind(new Date().toISOString(), user.email, JSON.stringify({ sql: q.slice(0, 2000), for: "list", type, ids: count, read: rowsRead })).run();
  return { type, count, ids: count ? String(row.ids) : "", ms: Date.now() - t0, rowsRead, readToday: used + rowsRead, readBudget: budget };
}
