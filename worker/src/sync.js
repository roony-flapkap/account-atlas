// Filling and keeping the SQL copy, on the free plan's terms: every minute a
// small slice (10 ms of CPU and 50 subrequests an invocation), and a daily
// write budget that stops the fill before D1's 100,000 rows — past that, D1
// stops answering until 00:00 UTC and the map would go dark.
//
//   backfill:<type>      every record, 100 a page, in id order
//   links:<from>><to>    every association, 500 records a call, from the copy's own keys
//   poll                 every 15 minutes: records modified since the last poll
//   nightly (02:00 UTC)  re-read every link and check every lead still exists
//                        (leads have no webhooks), then prune old rows
// A job resumes from its cursor, so a failed or cut-short slice costs nothing.

import { hubspotClient, T } from "./hubspot.js";
import { ASKFOR, toRow, recKey } from "./shape.js";
import { applyRecords, applyLinks, applyDeletions, recordChanges, typeRange } from "./graph.js";
import { announce } from "./hub.js";

const ORDER = [
  "backfill:0-2", "backfill:0-1", "backfill:0-3", "backfill:0-136",
  "links:0-2>0-1", "links:0-2>0-3", "links:0-2>0-136", "links:0-1>0-3", "links:0-1>0-136", "links:0-136>0-3"
];
const NIGHTLY = ["relink:0-2>0-1", "relink:0-2>0-3", "relink:0-2>0-136", "relink:0-1>0-3", "relink:0-1>0-136", "relink:0-136>0-3", "exists:0-136"];
const PAGES_PER_TICK = 3;
const LINK_IDS = 500;
const EXIST_IDS = 100;
const LEASE_MS = 90000;
const POLL_EVERY_MS = 15 * 60000;
const MODIFIED = { [T.company]: "hs_lastmodifieddate", [T.contact]: "lastmodifieddate", [T.deal]: "hs_lastmodifieddate", [T.lead]: "hs_lastmodifieddate" };

const day = () => new Date().toISOString().slice(0, 10);

export async function usageToday(env){
  const r = await env.APP.prepare("SELECT what, n FROM usage WHERE day = ?1").bind(day()).all();
  const o = { sync_writes: 0, hook_writes: 0, sql_reads: 0 };
  for (const row of r.results || []) o[row.what] = row.n;
  return o;
}
export async function addUsage(env, what, n){
  if (!n) return;
  await env.APP.prepare("INSERT INTO usage (day, what, n) VALUES (?1, ?2, ?3) ON CONFLICT(day, what) DO UPDATE SET n = n + excluded.n")
    .bind(day(), what, n).run();
}

async function job(env, name){
  return (await env.GRAPH.prepare("SELECT * FROM sync_state WHERE job = ?1").bind(name).first())
      || { job: name, cursor: null, status: "idle", detail: null };
}
async function saveJob(env, j){
  await env.GRAPH.prepare(
    "INSERT INTO sync_state (job, cursor, status, started_at, finished_at, heartbeat, error, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) " +
    "ON CONFLICT(job) DO UPDATE SET cursor = excluded.cursor, status = excluded.status, started_at = excluded.started_at, " +
    "finished_at = excluded.finished_at, heartbeat = excluded.heartbeat, error = excluded.error, detail = excluded.detail")
    .bind(j.job, j.cursor ?? null, j.status, j.started_at ?? null, j.finished_at ?? null, new Date().toISOString(), j.error ?? null, j.detail ?? null).run();
}

// One tick at a time, even if a slow one overlaps the next minute.
async function lease(env){
  const now = Date.now();
  const r = await env.GRAPH.prepare(
    "INSERT INTO sync_state (job, status, heartbeat) VALUES ('lease', 'running', ?1) ON CONFLICT(job) DO UPDATE SET status = 'running', heartbeat = ?1 " +
    "WHERE sync_state.status <> 'running' OR sync_state.heartbeat < ?2").bind(new Date(now).toISOString(), new Date(now - LEASE_MS).toISOString()).run();
  return (r.meta && r.meta.changes) > 0;
}
const release = env => env.GRAPH.prepare("UPDATE sync_state SET status = 'idle' WHERE job = 'lease'").run();

export async function tick(env, { now = Date.now(), nightly = false } = {}){
  if (!(await lease(env))) return { skipped: "another tick is running" };
  const report = { did: [] };
  try {
    const hs = hubspotClient(env);
    const budget = Number(env.SYNC_WRITE_BUDGET) || 80000;
    if (nightly){ await startNightly(env); report.did.push("nightly queued"); }

    // the 15-minute read goes first: it is what keeps the copy current
    const poll = await job(env, "poll");
    const lastPoll = poll.heartbeat ? Date.parse(poll.heartbeat) : 0;
    if (now - lastPoll >= POLL_EVERY_MS){ report.did.push(await pollChanges(env, hs, poll)); }

    const used = await usageToday(env);
    if (used.sync_writes >= budget){ report.did.push("write budget spent for today (" + used.sync_writes + ")"); return report; }

    for (const name of ORDER.concat(NIGHTLY)){
      const j = await job(env, name);
      if (j.status === "done" || (name.startsWith("relink") || name.startsWith("exists")) && j.status !== "queued" && j.status !== "running") continue;
      if (name.startsWith("links:") && !(await ready(env, name))) continue;
      const res = await slice(env, hs, j);
      await addUsage(env, "sync_writes", res.writes || 0);
      report.did.push(name + ": " + res.note);
      break;                                   // one slice a tick
    }
    return report;
  } finally { await release(env); }
}

// a type's links wait until its records are all in
async function ready(env, name){
  const from = name.split(":")[1].split(">")[0];
  return (await job(env, "backfill:" + from)).status === "done";
}

async function slice(env, hs, j){
  const [kind, spec] = j.job.split(":");
  j.status = "running"; j.started_at = j.started_at || new Date().toISOString(); j.error = null;
  try {
    let res;
    if (kind === "backfill") res = await backfillSlice(env, hs, j, spec);
    else if (kind === "links" || kind === "relink") res = await linkSlice(env, hs, j, spec, kind === "relink");
    else if (kind === "exists") res = await existsSlice(env, hs, j, spec);
    await saveJob(env, j);
    return res;
  } catch(e){
    j.error = String(e && e.message || e).slice(0, 500);
    j.status = "running";                     // retried next tick, from the same cursor
    await saveJob(env, j);
    return { note: "error: " + j.error, writes: 0 };
  }
}

async function backfillSlice(env, hs, j, t){
  let after = j.cursor, rows = [], pages = 0;
  while (pages < PAGES_PER_TICK){
    const page = await hs.listPage(t, ASKFOR[t], after);
    rows.push(...page.results.map(x => toRow(t, x)));
    pages++; after = page.after;
    if (!after) break;
  }
  const res = await applyRecords(env, rows, { source: "backfill", emit: false });
  const d = JSON.parse(j.detail || "{}"); d.records = (d.records || 0) + rows.length; j.detail = JSON.stringify(d);
  j.cursor = after;
  if (!after){ j.status = "done"; j.finished_at = new Date().toISOString(); }
  return { note: rows.length + " records", writes: res.writes };
}

// the copy's own keys of a type, in order, after a cursor
async function keysAfter(env, t, cursor, n){
  const [lo, hi] = typeRange(t);
  const r = await env.GRAPH.prepare("SELECT key FROM records WHERE key > ?1 AND key < ?2 AND deleted_at IS NULL ORDER BY key LIMIT ?3")
    .bind(cursor && cursor > lo ? cursor : lo, hi, n).all();
  return (r.results || []).map(x => x.key);
}

async function linkSlice(env, hs, j, spec, relink){
  const [from, to] = spec.split(">");
  const keys = await keysAfter(env, from, j.cursor, LINK_IDS);
  if (!keys.length){ j.status = "done"; j.finished_at = new Date().toISOString(); j.cursor = null; return { note: "complete", writes: 0 }; }
  const ids = keys.map(k => k.split("/")[1]);
  const got = await hs.assoc(from, to, ids);
  const sets = ids.map(id => ({ from: recKey(from, id), toType: to,
    to: (got.get(id) || []).map(x => ({ key: recKey(to, x.id), typeId: x.typeId, label: x.label })) }));
  // the first fill says nothing; a re-read says what it found different
  const res = await applyLinks(env, sets, { source: relink ? "nightly" : "backfill", emitFor: () => relink });
  if (res.changes.length){ const last = await recordChanges(env, res.changes, "nightly"); await announce(env, last, res.changes); }
  j.cursor = keys[keys.length - 1];
  const d = JSON.parse(j.detail || "{}"); d.records = (d.records || 0) + keys.length; d.links = (d.links || 0) + res.added; j.detail = JSON.stringify(d);
  if (keys.length < LINK_IDS){ j.status = "done"; j.finished_at = new Date().toISOString(); j.cursor = null; }
  return { note: keys.length + " records, +" + res.added + " −" + res.removed + " links", writes: res.writes };
}

// leads have no webhooks: a lead that no longer reads back has been deleted
async function existsSlice(env, hs, j, t){
  const keys = await keysAfter(env, t, j.cursor, EXIST_IDS);
  if (!keys.length){ j.status = "done"; j.finished_at = new Date().toISOString(); j.cursor = null; return { note: "complete", writes: 0 }; }
  const back = new Set((await hs.batchRead(t, keys.map(k => k.split("/")[1]), ["hs_object_id"])).map(x => recKey(t, x.id)));
  const gone = keys.filter(k => !back.has(k));
  let writes = 0;
  if (gone.length){
    const ch = await applyDeletions(env, gone);
    const last = await recordChanges(env, ch, "nightly");
    await announce(env, last, ch);
    writes += gone.length * 3;
  }
  j.cursor = keys[keys.length - 1];
  if (keys.length < EXIST_IDS){ j.status = "done"; j.finished_at = new Date().toISOString(); j.cursor = null; }
  return { note: keys.length + " checked, " + gone.length + " gone", writes };
}

// Records modified since the last poll, every type, oldest first. The search
// API stops at 10,000 results a query, so each type moves its own cursor
// forward by what it read, and a burst bigger than a slice is read over
// several polls.
async function pollChanges(env, hs, poll){
  const cur = JSON.parse(poll.cursor || "{}");
  const start = Date.now();
  const allChanges = [];
  let n = 0, writes = 0;
  for (const t of [T.company, T.contact, T.deal, T.lead]){
    const since = cur[t] || start - POLL_EVERY_MS;   // the first poll looks back one interval
    const r = await hs.search(t, {
      filterGroups: [{ filters: [{ propertyName: MODIFIED[t], operator: "GT", value: String(since) }] }],
      sorts: [{ propertyName: MODIFIED[t], direction: "ASCENDING" }],
      properties: ASKFOR[t].concat(MODIFIED[t]), limit: 200
    });
    const results = (r && r.results) || [];
    if (!results.length){ cur[t] = Math.max(since, start - 60000); continue; }
    const rows = results.map(x => toRow(t, x));
    const res = await applyRecords(env, rows, { source: "poll" });
    // a record the copy had never held is only "created" if it is new since the last poll
    const fresh = new Set(rows.filter(r0 => r0.created_at && Date.parse(r0.created_at) > since).map(r0 => r0.key));
    allChanges.push(...res.changes, ...res.created.filter(k => fresh.has(k)).map(k => ({ kind: "created", key: k })));
    writes += res.writes;
    n += results.length;
    const newest = Math.max(...results.map(x => Date.parse((x.properties || {})[MODIFIED[t]] || x.updatedAt) || since));
    cur[t] = Math.max(since, newest);
  }
  if (allChanges.length){ const last = await recordChanges(env, allChanges, "poll"); await announce(env, last, allChanges); }
  await addUsage(env, "sync_writes", writes);
  poll.cursor = JSON.stringify(cur); poll.status = "idle";
  await saveJob(env, poll);
  return "poll: " + n + " modified, " + allChanges.length + " changes";
}

async function startNightly(env){
  for (const name of NIGHTLY){
    const j = await job(env, name);
    // a re-read waits until the first fill of those links is complete
    if (name.startsWith("relink:") && (await job(env, name.replace("relink:", "links:"))).status !== "done") continue;
    if (name.startsWith("exists:") && (await job(env, "backfill:" + name.split(":")[1])).status !== "done") continue;
    j.status = "queued"; j.cursor = null; j.started_at = new Date().toISOString(); j.finished_at = null; j.error = null;
    await saveJob(env, j);
  }
  const cut = new Date(Date.now() - 90 * 86400e3).toISOString();
  await env.GRAPH.prepare("DELETE FROM changes WHERE at < ?1").bind(cut).run();
  await env.APP.prepare("DELETE FROM hook_events WHERE at < ?1").bind(new Date(Date.now() - 3 * 86400e3).toISOString()).run();
  await env.APP.prepare("DELETE FROM usage WHERE day < ?1").bind(new Date(Date.now() - 30 * 86400e3).toISOString().slice(0, 10)).run();
}

export async function syncStatus(env){
  const r = await env.GRAPH.prepare("SELECT job, status, cursor, started_at, finished_at, heartbeat, error, detail FROM sync_state WHERE job <> 'lease' ORDER BY job").all();
  const jobs = (r.results || []).map(j => Object.assign(j, { detail: j.detail ? JSON.parse(j.detail) : null }));
  // counted by the fill as it goes: count(*) would read every row, and the
  // free plan allows 5 million reads a day
  const filled = t => { const j = jobs.find(x => x.job === "backfill:" + t); return { records: (j && j.detail && j.detail.records) || 0, done: !!(j && j.status === "done") }; };
  let gate = null;
  try { gate = await env.GATE.get(env.GATE.idFromName("portal")).usage(); } catch(e){}
  return {
    jobs,
    copy: { companies: filled(T.company), contacts: filled(T.contact), deals: filled(T.deal), leads: filled(T.lead) },
    today: Object.assign(await usageToday(env), { writeBudget: Number(env.SYNC_WRITE_BUDGET) || 80000, sqlReadBudget: Number(env.SQL_READ_BUDGET) || 1000000 }),
    hubspot: gate
  };
}
