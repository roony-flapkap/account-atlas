// Writing the SQL copy. Everything goes in as a handful of set-based
// statements over one JSON parameter (json_each), because the free plan
// allows 50 statements per invocation and 100 parameters per statement,
// and every row written counts against 100,000 a day. So: read what is
// there, write only what differs, and say what changed.

import { KIND_OF } from "./hubspot.js";

const now = () => new Date().toISOString();
const FIELDS = ["label", "sub", "owner_id", "creator_id", "stage", "pipeline", "amount", "tails"];
const J = v => JSON.stringify(v);
// every key of type t sorts inside [t + "/", t + "0"): "0-1/…" but not "0-136/…"
export const typeRange = t => [t + "/", t + "0"];

async function inChunks(list, size, fn){ for (let i = 0; i < list.length; i += size) await fn(list.slice(i, i + size)); }

// rows: from shape.toRow. Returns { created, updated, restored, known, changes }.
// `known` is the set of keys the copy already held before this call.
// The first fill's own path: no "what is there already?" read first (it
// cost a row read per record, most of them new). One statement inserts the
// new rows and rewrites a stored one only if something in it differs; phone
// endings are added if missing. Nothing is reported: the fill says nothing.
const SAME = FIELDS.map(f => "records." + f + " IS excluded." + f).join(" AND ");
async function fillRecords(env, rows, at){
  const stmts = [];
  await inChunks(rows, 400, part => { stmts.push(env.GRAPH.prepare(
    "INSERT INTO records (key, type, label, sub, owner_id, creator_id, stage, pipeline, amount, tails, created_at, hs_updated_at, synced_at, deleted_at) " +
    "SELECT json_extract(value,'$.key'), json_extract(value,'$.type'), json_extract(value,'$.label'), json_extract(value,'$.sub'), " +
    "json_extract(value,'$.owner_id'), json_extract(value,'$.creator_id'), json_extract(value,'$.stage'), json_extract(value,'$.pipeline'), " +
    "json_extract(value,'$.amount'), json_extract(value,'$.tails'), json_extract(value,'$.created_at'), json_extract(value,'$.hs_updated_at'), ?2, NULL " +
    "FROM json_each(?1) WHERE true " +
    "ON CONFLICT(key) DO UPDATE SET type = excluded.type, label = excluded.label, sub = excluded.sub, owner_id = excluded.owner_id, " +
    "creator_id = excluded.creator_id, stage = excluded.stage, pipeline = excluded.pipeline, amount = excluded.amount, tails = excluded.tails, " +
    "created_at = excluded.created_at, hs_updated_at = excluded.hs_updated_at, synced_at = excluded.synced_at, deleted_at = NULL, merged_into = NULL " +
    "WHERE NOT (" + SAME + ") OR records.deleted_at IS NOT NULL"
  ).bind(J(part), at)); });
  const tails = rows.flatMap(r => (r.tails ? r.tails.split(" ") : []).map(t => [t, r.key]));
  await inChunks(tails, 800, part => { stmts.push(env.GRAPH.prepare(
    "INSERT OR IGNORE INTO phones (tail, key) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?1)").bind(J(part))); });
  return stmts.length ? written(await env.GRAPH.batch(stmts)) : 0;
}

export async function applyRecords(env, rows, { source, emit = true, at = now() } = {}){
  const out = { created: [], updated: [], restored: [], known: new Set(), changes: [], writes: 0 };
  if (!rows.length) return out;
  if (source === "backfill" && !emit){ out.writes = await fillRecords(env, rows, at); return out; }
  const byKey = new Map(rows.map(r => [r.key, r]));
  const before = new Map();
  await inChunks([...byKey.keys()], 500, async keys => {
    const r = await env.GRAPH.prepare("SELECT key, " + FIELDS.join(", ") + ", deleted_at FROM records WHERE key IN (SELECT value FROM json_each(?1))")
      .bind(J(keys)).all();
    for (const row of r.results || []) before.set(row.key, row);
  });

  const write = [], tailsOff = [], tailsOn = [];
  for (const r of byKey.values()){
    const old = before.get(r.key);
    if (old) out.known.add(r.key);
    const diff = old ? FIELDS.filter(f => (old[f] ?? null) !== (r[f] ?? null)) : null;
    if (old && !diff.length && !old.deleted_at) continue;    // nothing to write
    write.push(r);
    if (!old) out.created.push(r.key);
    else if (old.deleted_at) out.restored.push(r.key);
    else out.updated.push(r.key);
    const was = new Set(old && old.tails ? old.tails.split(" ") : []), is = new Set(r.tails ? r.tails.split(" ") : []);
    for (const t of was) if (!is.has(t)) tailsOff.push([t, r.key]);
    for (const t of is) if (!was.has(t)) tailsOn.push([t, r.key]);
    if (emit && old){
      if (old.deleted_at) out.changes.push({ kind: "restored", key: r.key });
      else out.changes.push({ kind: "updated", key: r.key, detail: { fields: diff.filter(f => f !== "tails" && f !== "creator_id") } });
    }
    // a record the copy had not seen is NOT necessarily new in HubSpot (the
    // first walk of an account meets all of it), so "created" is left to
    // the callers that know: a creation webhook, or a poll that sees the
    // create date is after its last read
  }
  // an update that only touched fields nobody sees is not worth a change row
  out.changes = out.changes.filter(c => c.kind !== "updated" || c.detail.fields.length);

  const stmts = [];
  await inChunks(write, 400, part => {
    stmts.push(env.GRAPH.prepare(
      "INSERT INTO records (key, type, label, sub, owner_id, creator_id, stage, pipeline, amount, tails, created_at, hs_updated_at, synced_at, deleted_at) " +
      "SELECT json_extract(value,'$.key'), json_extract(value,'$.type'), json_extract(value,'$.label'), json_extract(value,'$.sub'), " +
      "json_extract(value,'$.owner_id'), json_extract(value,'$.creator_id'), json_extract(value,'$.stage'), json_extract(value,'$.pipeline'), " +
      "json_extract(value,'$.amount'), json_extract(value,'$.tails'), json_extract(value,'$.created_at'), json_extract(value,'$.hs_updated_at'), ?2, NULL " +
      "FROM json_each(?1) WHERE true " +
      "ON CONFLICT(key) DO UPDATE SET type = excluded.type, label = excluded.label, sub = excluded.sub, owner_id = excluded.owner_id, " +
      "creator_id = excluded.creator_id, stage = excluded.stage, pipeline = excluded.pipeline, amount = excluded.amount, tails = excluded.tails, " +
      "created_at = excluded.created_at, hs_updated_at = excluded.hs_updated_at, synced_at = excluded.synced_at, deleted_at = NULL, merged_into = NULL"
    ).bind(J(part), at));
  });
  if (tailsOff.length) stmts.push(env.GRAPH.prepare(
    "DELETE FROM phones WHERE (tail, key) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?1))").bind(J(tailsOff)));
  if (tailsOn.length) stmts.push(env.GRAPH.prepare(
    "INSERT OR IGNORE INTO phones (tail, key) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?1)").bind(J(tailsOn)));
  if (stmts.length) out.writes = written(await env.GRAPH.batch(stmts));
  return out;
}

// what D1 itself counts against the day's 100,000
const written = results => results.reduce((s, r) => s + (Number(r && r.meta && r.meta.rows_written) || 0), 0);

// sets: [{ from: key, toType: "0-1", to: [{ key, typeId, label }] }] — each the
// COMPLETE list of `from`'s associations to that type. Links in, links out.
// A difference is reported as a change only where the copy already held the
// complete list (link_sync, or the first fill of that kind of link is done):
// otherwise it is the copy learning, not HubSpot changing. `emit: false` (the
// first fill) reports nothing; `track: false` does not record completeness
// (the fill, whose job state says it instead, and saves the writes).
export async function applyLinks(env, sets, { source, emit = true, track = source !== "backfill", at = now() } = {}){
  const out = { added: 0, removed: 0, changes: [], writes: 0 };
  if (!sets.length) return out;
  // The first fill's own path: every link in, both ways, where it is not
  // already — no read of what is there, nothing reported, nothing removed
  // (the nightly re-read compares and removes, and says so).
  if (!emit && !track){
    const add = [];
    for (const s of sets) for (const x of s.to){
      add.push([s.from, x.key, x.typeId ?? null, x.label ?? null], [x.key, s.from, x.typeId ?? null, x.label ?? null]);
    }
    const stmts = [];
    await inChunks(add, 800, part => stmts.push(env.GRAPH.prepare(
      "INSERT OR IGNORE INTO links (a, b, type_id, label, synced_at) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), " +
      "json_extract(value,'$[2]'), json_extract(value,'$[3]'), ?2 FROM json_each(?1)").bind(J(part), at)));
    if (stmts.length){
      const res = await env.GRAPH.batch(stmts);
      out.writes = written(res);
      out.added = res.reduce((s, r) => s + (Number(r && r.meta && r.meta.changes) || 0), 0) / 2;
    }
    return out;
  }
  const complete = new Set();
  if (emit){
    const types = [...new Set(sets.map(s => s.from.split("/")[0] + ">" + s.toType))];
    const jobs = types.flatMap(p => { const [a, b] = p.split(">"); return ["links:" + a + ">" + b, "links:" + b + ">" + a]; });
    const [js, ls] = await env.GRAPH.batch([
      env.GRAPH.prepare("SELECT job FROM sync_state WHERE job IN (SELECT value FROM json_each(?1)) AND (status = 'done' OR finished_at IS NOT NULL)").bind(J(jobs)),
      env.GRAPH.prepare("SELECT l.key AS key, l.to_type AS t FROM json_each(?1) j JOIN link_sync l ON l.key = json_extract(j.value,'$[0]') AND l.to_type = json_extract(j.value,'$[1]')")
        .bind(J(sets.slice(0, 4000).map(s => [s.from, s.toType])))
    ]);
    const done = new Set((js.results || []).map(r => r.job));
    for (const p of types){ const [a, b] = p.split(">"); if (done.has("links:" + a + ">" + b) || done.has("links:" + b + ">" + a)) complete.add("*" + p); }
    for (const r of ls.results || []) complete.add(r.key + "|" + r.t);
  }
  const emitFor = s => emit && (complete.has(s.from + "|" + s.toType) || complete.has("*" + s.from.split("/")[0] + ">" + s.toType));
  const probe = sets.map(s => [s.from].concat(typeRange(s.toType)));
  const have = new Map();                         // "from|toType" -> Set(to)
  const slot = (from, t) => { const k = from + "|" + t; if (!have.has(k)) have.set(k, new Set()); return have.get(k); };
  await inChunks(probe, 300, async part => {
    const r = await env.GRAPH.prepare(
      "SELECT l.a AS a, l.b AS b FROM json_each(?1) j JOIN links l ON l.a = json_extract(j.value,'$[0]') " +
      "AND l.b >= json_extract(j.value,'$[1]') AND l.b < json_extract(j.value,'$[2]')").bind(J(part)).all();
    for (const row of r.results || []) slot(row.a, row.b.split("/")[0]).add(row.b);
  });

  const add = [], del = [], seen = new Set();
  for (const s of sets){
    const was = slot(s.from, s.toType), is = new Map(s.to.map(x => [x.key, x]));
    for (const [k, x] of is){
      if (was.has(k)) continue;
      const id = s.from < k ? s.from + "|" + k : k + "|" + s.from;
      if (seen.has("+" + id)) continue; seen.add("+" + id);
      add.push([s.from, k, x.typeId ?? null, x.label ?? null], [k, s.from, x.typeId ?? null, x.label ?? null]);
      if (emitFor(s)) out.changes.push({ kind: "linked", key: s.from, other: k });
    }
    for (const k of was){
      if (is.has(k)) continue;
      const id = s.from < k ? s.from + "|" + k : k + "|" + s.from;
      if (seen.has("-" + id)) continue; seen.add("-" + id);
      del.push([s.from, k], [k, s.from]);
      if (emitFor(s)) out.changes.push({ kind: "unlinked", key: s.from, other: k });
    }
  }
  out.added = add.length / 2; out.removed = del.length / 2;
  const stmts = [];
  await inChunks(add, 800, part => stmts.push(env.GRAPH.prepare(
    "INSERT INTO links (a, b, type_id, label, synced_at) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), " +
    "json_extract(value,'$[2]'), json_extract(value,'$[3]'), ?2 FROM json_each(?1) WHERE true " +
    "ON CONFLICT(a, b) DO UPDATE SET type_id = excluded.type_id, label = excluded.label, synced_at = excluded.synced_at").bind(J(part), at)));
  await inChunks(del, 800, part => stmts.push(env.GRAPH.prepare(
    "DELETE FROM links WHERE (a, b) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?1))").bind(J(part))));
  // from now on these lists are known whole, so a later difference is a change
  if (track) await inChunks(sets.map(s => [s.from, s.toType]), 800, part => stmts.push(env.GRAPH.prepare(
    "INSERT INTO link_sync (key, to_type, at) SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]'), ?2 FROM json_each(?1) WHERE true " +
    "ON CONFLICT(key, to_type) DO UPDATE SET at = excluded.at").bind(J(part), at)));
  if (stmts.length) out.writes = written(await env.GRAPH.batch(stmts));
  return out;
}

// One link at a time, from a webhook: added or removed, both directions.
export async function applyOneLink(env, a, b, removed, { typeId = null, label = null, at = now() } = {}){
  if (removed){
    const r = await env.GRAPH.prepare("DELETE FROM links WHERE (a = ?1 AND b = ?2) OR (a = ?2 AND b = ?1)").bind(a, b).run();
    return (r.meta && r.meta.changes) > 0;
  }
  const had = await env.GRAPH.prepare("SELECT 1 FROM links WHERE a = ?1 AND b = ?2").bind(a, b).first();
  if (had) return false;
  await env.GRAPH.prepare("INSERT OR IGNORE INTO links (a, b, type_id, label, synced_at) VALUES (?1, ?2, ?3, ?4, ?5), (?2, ?1, ?3, ?4, ?5)")
    .bind(a, b, typeId, label, at).run();
  return true;
}

// Links removed in HubSpot from the map (edit.js): [[a, b], …], both
// directions, in one statement. What the copy held of them is returned
// first, so the audit can say what was there.
export async function applyUnlinks(env, pairs){
  const out = [];
  await inChunks(pairs, 400, async part => {
    const both = part.flatMap(([a, b]) => [[a, b], [b, a]]);
    const [had] = await env.GRAPH.batch([
      env.GRAPH.prepare("SELECT l.a AS a, l.b AS b, l.type_id AS type_id, l.label AS label FROM json_each(?1) j " +
        "JOIN links l ON l.a = json_extract(j.value,'$[0]') AND l.b = json_extract(j.value,'$[1]')").bind(J(part)),
      env.GRAPH.prepare("DELETE FROM links WHERE (a, b) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?1))").bind(J(both))
    ]);
    out.push(...(had.results || []));
  });
  return out;
}

// A record deleted (or archived) in HubSpot: kept as a tombstone so a canvas
// that holds it can show it struck through; its links and numbers go.
export async function applyDeletions(env, keys, { at = now(), mergedInto = null } = {}){
  // every one is reported, even a record the copy has not filled in yet:
  // a canvas may hold it, and the page must hear that it has gone
  const changes = keys.map(k => mergedInto ? { kind: "merged", key: k, other: mergedInto } : { kind: "deleted", key: k });
  if (!keys.length) return changes;
  // targeted deletes only: links are keyed (a, b) and phones (tail, key), so
  // "WHERE b IN …" or "WHERE key IN …" would read the whole table
  const [nb, tl] = await env.GRAPH.batch([
    env.GRAPH.prepare("SELECT a, b FROM links WHERE a IN (SELECT value FROM json_each(?1))").bind(J(keys)),
    env.GRAPH.prepare("SELECT key, tails FROM records WHERE key IN (SELECT value FROM json_each(?1)) AND tails IS NOT NULL").bind(J(keys))
  ]);
  const pairs = [];
  for (const r of nb.results || []) pairs.push([r.a, r.b], [r.b, r.a]);
  const tails = [];
  for (const r of tl.results || []) for (const t of String(r.tails).split(" ")) if (t) tails.push([t, r.key]);
  await env.GRAPH.batch([
    // a record the copy never held still gets a tombstone, so a canvas holding it learns
    env.GRAPH.prepare("INSERT INTO records (key, type, synced_at, deleted_at, merged_into) " +
      "SELECT value, substr(value, 1, instr(value, '/') - 1), ?2, ?2, ?3 FROM json_each(?1) WHERE true " +
      "ON CONFLICT(key) DO UPDATE SET deleted_at = excluded.deleted_at, merged_into = excluded.merged_into, synced_at = excluded.synced_at, tails = NULL")
      .bind(J(keys), at, mergedInto),
    env.GRAPH.prepare("DELETE FROM links WHERE (a, b) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?1))").bind(J(pairs)),
    env.GRAPH.prepare("DELETE FROM phones WHERE (tail, key) IN (SELECT json_extract(value,'$[0]'), json_extract(value,'$[1]') FROM json_each(?1))").bind(J(tails))
  ]);
  return changes;
}

// Change rows, in order. Returns the last seq written (0 if none).
export async function recordChanges(env, list, source, at = now()){
  if (!list.length) return 0;
  let last = 0;
  await inChunks(list, 500, async part => {
    const r = await env.GRAPH.prepare(
      "INSERT INTO changes (at, kind, key, other, detail, source) SELECT json_extract(value,'$.at'), json_extract(value,'$.kind'), " +
      "json_extract(value,'$.key'), json_extract(value,'$.other'), json_extract(value,'$.detail'), ?2 FROM json_each(?1)")
      .bind(J(part.map(c => ({ at: c.at || at, kind: c.kind, key: c.key, other: c.other || null, detail: c.detail ? J(c.detail) : null }))), source).run();
    last = Math.max(last, Number(r.meta && r.meta.last_row_id) || 0);
  });
  return last;
}

// ---------------------------------------------------------------- reads
export async function recordsByKey(env, keys){
  const out = new Map();
  await inChunks([...new Set(keys)], 500, async part => {
    const r = await env.GRAPH.prepare("SELECT * FROM records WHERE key IN (SELECT value FROM json_each(?1))").bind(J(part)).all();
    for (const row of r.results || []) out.set(row.key, row);
  });
  return out;
}
export async function linksOf(env, keys){
  const out = new Map(keys.map(k => [k, []]));
  await inChunks([...new Set(keys)], 500, async part => {
    const r = await env.GRAPH.prepare("SELECT a, b, type_id, label FROM links WHERE a IN (SELECT value FROM json_each(?1))").bind(J(part)).all();
    for (const row of r.results || []) out.get(row.a).push(row);
  });
  return out;
}
export async function sharingNumbers(env, tails){
  if (!tails.length) return [];
  const r = await env.GRAPH.prepare("SELECT tail, key FROM phones WHERE tail IN (SELECT value FROM json_each(?1))").bind(J([...new Set(tails)])).all();
  return r.results || [];
}
export const kindOfKey = k => KIND_OF[String(k).split("/")[0]];
