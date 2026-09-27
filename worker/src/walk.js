// THE WALK, on the Worker: one company, its records, how they link to each
// other, what they reach outside it, and who shares its numbers without a
// link.
//
// From the copy, when it can: if the SQL copy holds the account's link lists
// WHOLE (link_sync, or a finished fill of that kind of link), the walk is a
// handful of queries and no HubSpot calls — the copy is kept current by
// webhooks, the 15-minute read and the nightly re-read. The page then asks
// for a live walk in the background, to be sure.
//
// Live otherwise: bulk reads (100 records or 1,000 association lists a
// call), independent reads side by side, and everything read lands in the
// copy, with what changed since the last read.
//
// Either way it reports as it goes through `say`, one event per console
// line, so the page's console still types the walk out live:
//   { t: "mode", mode } · { t: "prog", pct, label } · { t: "step", id, m }
//   { t: "end", id, note, st } · { t: "line", m, cls } · and last { t: "done", … }

import { hubspotClient, T, pool } from "./hubspot.js";
import { ASKFOR, lookups, shapeOf, dCompany, dContact, dDeal, dFromRow, toRow, recKey, phoneTail } from "./shape.js";
import { applyRecords, applyLinks, recordChanges, applyDeletions, recordsByKey, linksOf, sharingNumbers, typeRange } from "./graph.js";
import { announce } from "./hub.js";

const FOREIGN_DEALS = 60;       // deals this account's people are on elsewhere
const PROBES_LIVE = 5;          // phone searches, while the copy has no complete phone book

export async function walkAuto(env, cid, say, { user, mode = "auto" } = {}){
  if (mode !== "live"){
    const r = await walkFromCopy(env, String(cid), say, { user });
    if (r) return r;
  }
  return walk(env, cid, say, { user });
}

// ---------------------------------------------------------------- from the copy
// Is every list this walk would read held whole? Returns the reason if not.
async function copyHolds(env, pairs){
  if (!pairs.length) return true;
  const types = [...new Set(pairs.map(([k, t]) => k.split("/")[0] + ">" + t))];
  const jobs = types.flatMap(p => { const [a, b] = p.split(">"); return ["links:" + a + ">" + b, "links:" + b + ">" + a]; });
  const [js, ls] = await env.GRAPH.batch([
    env.GRAPH.prepare("SELECT job FROM sync_state WHERE job IN (SELECT value FROM json_each(?1)) AND (status = 'done' OR finished_at IS NOT NULL)").bind(JSON.stringify(jobs)),
    env.GRAPH.prepare("SELECT l.key AS key, l.to_type AS t FROM json_each(?1) j JOIN link_sync l ON l.key = json_extract(j.value,'$[0]') AND l.to_type = json_extract(j.value,'$[1]')")
      .bind(JSON.stringify(pairs))
  ]);
  const done = new Set((js.results || []).map(r => r.job));
  const whole = new Set((ls.results || []).map(r => r.key + "|" + r.t));
  return pairs.every(([k, t]) => {
    const a = k.split("/")[0];
    return whole.has(k + "|" + t) || done.has("links:" + a + ">" + t) || done.has("links:" + t + ">" + a);
  });
}

export async function walkFromCopy(env, cid, say, { user } = {}){
  const t0 = Date.now();
  const hubKey = recKey(T.company, cid);
  const coRow = (await recordsByKey(env, [hubKey])).get(hubKey);
  if (!coRow || coRow.deleted_at || !coRow.label) return null;
  const own = (await linksOf(env, [hubKey])).get(hubKey) || [];
  const of = t => own.filter(l => l.b.startsWith(t + "/")).map(l => l.b);
  const contacts = of(T.contact), deals = of(T.deal), leads = of(T.lead);
  const pairs = [[hubKey, T.contact], [hubKey, T.deal], [hubKey, T.lead]]
    .concat(contacts.flatMap(k => [[k, T.deal], [k, T.lead], [k, T.company]]), leads.map(k => [k, T.deal]));
  if (!(await copyHolds(env, pairs))) return null;

  const id = { n: 0 };
  const step = m => { const i = ++id.n; say({ t: "step", id: i, m }); return i; };
  const end = (i, note, st = "ok") => say({ t: "end", id: i, note, st });
  say({ t: "mode", mode: "copy", asOf: coRow.synced_at });
  say({ t: "prog", pct: 30, label: "READING THE COPY" });
  const s1 = step("READ ACCOUNT FROM THE SQL COPY · 0-2/" + cid);
  const L = await lookups(env, null);
  const nodes = new Map(), edges = new Map(), capped = [];
  const take = d => { if (!nodes.has(d.k)) nodes.set(d.k, d); return nodes.get(d.k); };
  const join = (a, b, r) => { if (a === b || !nodes.has(a) || !nodes.has(b)) return; const k = a < b ? a + "|" + b : b + "|" + a;
                              const had = edges.get(k); if (!had || r === "member") edges.set(k, { a, b, r }); };
  const theirs = await linksOf(env, contacts.concat(leads));
  const foreignDeals = new Set(), foreignCos = new Set(), ourDeal = new Set(deals);
  for (const c of contacts) for (const l of theirs.get(c) || []){
    if (l.b.startsWith(T.deal + "/") && !ourDeal.has(l.b)) foreignDeals.add(l.b);
    if (l.b.startsWith(T.company + "/") && l.b !== hubKey) foreignCos.add(l.b);
  }
  let fd = [...foreignDeals];
  if (fd.length > FOREIGN_DEALS){ capped.push("deals reached outside"); fd = fd.slice(0, FOREIGN_DEALS); }
  const rows = await recordsByKey(env, [hubKey].concat(contacts, deals, leads, fd, [...foreignCos]));
  const row = k => rows.get(k);
  take(dFromRow(coRow, L));
  for (const k of contacts.concat(deals, leads)){
    const r = row(k); if (!r || r.deleted_at) continue;
    const d = dFromRow(r, L); d.ci = [cid]; d.hh = hubKey;
    join(hubKey, take(d).k, "member");
  }
  for (const k of fd){ const r = row(k); if (r && !r.deleted_at){ const d = dFromRow(r, L); d.hh = hubKey; take(d); } }
  for (const k of foreignCos){ const r = row(k); if (r && !r.deleted_at) take(dFromRow(r, L)); }
  for (const c of contacts) for (const l of theirs.get(c) || []){
    if (l.b.startsWith(T.company + "/")) join(c, l.b, "member");
    else join(c, l.b, "link");
  }
  for (const k of leads) for (const l of theirs.get(k) || []) if (l.b.startsWith(T.deal + "/")) join(k, l.b, "link");
  end(s1, contacts.length + " CONTACTS · " + deals.length + " DEALS · " + leads.length + " LEADS · NO HUBSPOT CALLS");

  // who shares a number with it but carries no link — as far as the copy's
  // phone book goes: complete once contacts are all copied
  say({ t: "prog", pct: 70, label: "SWEEPING FOR DETACHED RECORDS" });
  const book = await env.GRAPH.prepare("SELECT status FROM sync_state WHERE job = 'backfill:0-1'").first();
  const tails = [...new Set([coRow].concat(contacts.map(row)).filter(Boolean).flatMap(r => String(r.tails || "").split(" ")).filter(Boolean))];
  const s2 = step("PHONE SWEEP · " + tails.length + " NUMBERS · FROM THE COPY" + (book && book.status === "done" ? "" : " · CONTACTS STILL BEING COPIED"));
  const mine = new Set(contacts);
  const strays = [...new Set((await sharingNumbers(env, tails)).map(r => r.key).filter(k => k.startsWith(T.contact + "/") && !mine.has(k)))];
  const sRows = await recordsByKey(env, strays);
  let detached = 0;
  for (const k of strays){ const r = sRows.get(k); if (!r || r.deleted_at) continue;
    const d = dFromRow(r, L); d.kd = "detached"; d.hh = hubKey; join(hubKey, take(d).k, "detached"); detached++; }
  end(s2, detached + " UNATTACHED ON THESE NUMBERS", detached ? "warn" : "ok");

  if (user) await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'walk', ?3)")
    .bind(new Date().toISOString(), user.email, JSON.stringify({ company: cid, mode: "copy", calls: 0, ms: Date.now() - t0 })).run().catch(() => {});
  return {
    ok: true, mode: "copy", asOf: coRow.synced_at, company: { id: cid, name: coRow.label || "", domain: coRow.sub || "" },
    nodes: [...nodes.values()], edges: [...edges.values()], capped, missed: 0, changes: 0,
    stats: { calls: 0, search: 0, waitedMs: 0, ms: Date.now() - t0 }
  };
}

// ---------------------------------------------------------------- live
export async function walk(env, cid, say, { user } = {}){
  const t0 = Date.now();
  cid = String(cid);
  const hs = hubspotClient(env);
  const at = new Date().toISOString();
  const hubKey = recKey(T.company, cid);
  const nodes = new Map(), edges = new Map(), capped = [], timing = {};
  let missed = 0, seq = 0;
  const take = d => { if (!nodes.has(d.k)) nodes.set(d.k, d); return d; };
  const join = (a, b, r) => { if (a === b || !nodes.has(a) || !nodes.has(b)) return; const id = a < b ? a + "|" + b : b + "|" + a;
                              const had = edges.get(id); if (!had || r === "member") edges.set(id, { a, b, r }); };
  const step = m => { const id = ++seq; say({ t: "step", id, m }); return { id, t: Date.now() }; };
  const end = (h, note, st = "ok") => { timing[h.id] = Date.now() - h.t; say({ t: "end", id: h.id, note, st }); };
  const prog = (pct, label) => say({ t: "prog", pct, label });
  say({ t: "mode", mode: "live" });

  // one visit to the rate gate for what a walk usually spends
  await hs.prepay("general", 12);
  const pL = lookups(env, hs);

  // ---- the company, and what is on it — side by side
  prog(16, "READING COMPANY RECORD");
  const sRead = step("READ COMPANY 0-2/" + cid + " · ITS CONTACTS · DEALS · LEADS");
  const [cos, aC, aD, aL] = await Promise.all([hs.batchRead(T.company, [cid], ASKFOR[T.company])]
    .concat([T.contact, T.deal, T.lead].map(t => hs.assoc(T.company, t, [cid]))));
  const co = cos[0];
  if (!co){
    end(sRead, "NOT IN HUBSPOT", "err");
    // gone from HubSpot: if the copy still held it, it is a deletion nobody told us about
    const had = (await recordsByKey(env, [hubKey])).get(hubKey);
    if (had && !had.deleted_at){
      const ch = await applyDeletions(env, [hubKey], { at });
      const last = await recordChanges(env, ch, "walk", at);
      await announce(env, last, ch);
    }
    return { ok: false, why: "That company is not in HubSpot — it may have been deleted or merged." };
  }
  const cp = co.properties || {};
  const ids = { [T.contact]: aC.get(cid).map(x => x.id), [T.deal]: aD.get(cid).map(x => x.id), [T.lead]: aL.get(cid).map(x => x.id) };
  end(sRead, String(cp.name || cid).toUpperCase() + " · " + ids[T.contact].length + " CONTACTS · " + ids[T.deal].length + " DEALS · " + ids[T.lead].length + " LEADS");
  const ourC = ids[T.contact], ourL = ids[T.lead];

  // ---- everything that depends only on those ids starts at once:
  //      the records themselves, and how they link to each other and outside
  prog(40, "READING RECORDS AND THEIR LINKS");
  const sRec = step("READ " + (ourC.length + ids[T.deal].length + ourL.length) + " RECORDS · AND HOW THEY LINK");
  const pRC = hs.batchRead(T.contact, ourC, ASKFOR[T.contact]);
  const pRD = hs.batchRead(T.deal, ids[T.deal], ASKFOR[T.deal]);
  const pRL = hs.batchRead(T.lead, ourL, ASKFOR[T.lead]);
  const pMesh = Promise.all([hs.assoc(T.contact, T.deal, ourC), hs.assoc(T.contact, T.lead, ourC), hs.assoc(T.lead, T.deal, ourL), hs.assoc(T.contact, T.company, ourC)]);

  // the phone sweep needs the contacts' numbers, and nothing else: it starts
  // as soon as they are read, alongside the rest
  const book = await env.GRAPH.prepare("SELECT status FROM sync_state WHERE job = 'backfill:0-1'").first();
  const fromCopy = !!(book && book.status === "done");
  const pSweep = pRC.then(async rC => {
    const tails = [...new Set([cp.phone].concat(rC.map(x => (x.properties || {}).phone), rC.map(x => (x.properties || {}).mobilephone))
      .map(phoneTail).filter(Boolean))];
    let strays;
    if (fromCopy) strays = (await sharingNumbers(env, tails)).map(r => r.key).filter(k => k.startsWith(T.contact + "/")).map(k => k.split("/")[1]);
    else {
      if (tails.length > PROBES_LIVE) capped.push("phone probes");
      const probe = tails.slice(0, PROBES_LIVE);
      await hs.reserve("search", probe.length);
      const found = await pool(probe, probe.length || 1, async tail => {
        try { const r = await hs.call("POST", "/crm/v3/objects/" + T.contact + "/search",
                { query: tail, properties: ASKFOR[T.contact], limit: 10 }, "search", true); return (r && r.results) || []; }
        catch(e){ missed++; return []; }
      });
      strays = found.flat().map(x => String(x.id));
    }
    const seen = new Set(ourC);
    strays = [...new Set(strays)].filter(id => !seen.has(id));
    return { tails, rS: strays.length ? await hs.batchRead(T.contact, strays, ASKFOR[T.contact]) : [] };
  });

  const [rC, rD, rL, mesh, L] = await Promise.all([pRC, pRD, pRL, pMesh, pL]);
  const [cD, cL, lD, cCo] = mesh;
  const lost = ourC.length + ids[T.deal].length + ourL.length - rC.length - rD.length - rL.length;
  if (lost > 0) missed += lost;
  take(dCompany(co, L));
  rC.forEach(x => join(hubKey, take(dContact(x, cid, hubKey, false, L)).k, "member"));
  rD.forEach(x => join(hubKey, take(shapeOf[T.deal](x, cid, hubKey, L)).k, "member"));
  rL.forEach(x => join(hubKey, take(shapeOf[T.lead](x, cid, hubKey, L)).k, "member"));
  end(sRec, rC.length + rD.length + rL.length + " READ");

  // ---- what they reach outside the account
  prog(66, "REACHING OUTSIDE THE ACCOUNT");
  const sOut = step("LINKS LEAVING THIS ACCOUNT");
  const ourDeal = new Set(rD.map(x => String(x.id)));
  const foreignDeals = new Set(), foreignCos = new Set();
  for (const c of ourC){
    for (const d of cD.get(c) || []) if (!ourDeal.has(d.id)) foreignDeals.add(d.id);
    for (const k of cCo.get(c) || []) if (k.id !== cid) foreignCos.add(k.id);
  }
  let fd = [...foreignDeals];
  if (fd.length > FOREIGN_DEALS){ capped.push("deals reached outside"); fd = fd.slice(0, FOREIGN_DEALS); }
  const [rFD, rFC] = await Promise.all([hs.batchRead(T.deal, fd, ASKFOR[T.deal]), hs.batchRead(T.company, [...foreignCos], ASKFOR[T.company])]);
  rFD.forEach(x => take(dDeal(x, null, hubKey, L)));
  rFC.forEach(x => take(dCompany(x, L)));
  let links = 0, reached = 0;
  const lk = (a, b, r) => { const before = edges.size; join(a, b, r); return edges.size > before; };
  for (const c of ourC){
    const ck = recKey(T.contact, c);
    for (const d of cD.get(c) || []) if (lk(ck, recKey(T.deal, d.id), "link")) links++;
    for (const l of cL.get(c) || []) if (lk(ck, recKey(T.lead, l.id), "link")) links++;
    for (const k of cCo.get(c) || []) if (k.id !== cid && lk(ck, recKey(T.company, k.id), "member")) reached++;
  }
  for (const l of ourL) for (const d of lD.get(l) || []) if (lk(recKey(T.lead, l), recKey(T.deal, d.id), "link")) links++;
  end(sOut, links + " LINKS INSIDE · " + (reached || rFD.length ? rFC.length + " COMPANIES · " + rFD.length + " DEALS ELSEWHERE" : "NONE LEAVING — SELF-CONTAINED"),
      reached || rFD.length ? "warn" : "ok");

  // ---- records that share a number with this account but carry no link
  prog(80, "SWEEPING FOR DETACHED RECORDS");
  const sS = step("PHONE SWEEP" + (fromCopy ? " · FROM THE COPY" : ""));
  const { tails, rS } = await pSweep;
  rS.forEach(x => join(hubKey, take(dContact(x, null, hubKey, true, L)).k, "detached"));
  end(sS, tails.length + " NUMBERS · " + rS.length + " UNATTACHED ON THEM", rS.length ? "warn" : "ok");
  if (missed) say({ t: "line", m: missed + " READS REFUSED · THIS ACCOUNT IS INCOMPLETE · RE-WALK IT TO FILL THE GAPS", cls: "err" });

  // ---- into the SQL copy, and what changed since it was last read
  prog(88, "WRITING TO THE COPY");
  const sW = step("SQL COPY");
  const rows = [toRow(T.company, co)].concat(rC.map(x => toRow(T.contact, x)), rD.map(x => toRow(T.deal, x)), rL.map(x => toRow(T.lead, x)),
    rFD.map(x => toRow(T.deal, x)), rFC.map(x => toRow(T.company, x)), rS.map(x => toRow(T.contact, x)));
  const rec = await applyRecords(env, rows, { source: "walk", at });
  const set = (from, toType, list) => ({ from, toType, to: (list || []).map(x => ({ key: recKey(toType, x.id), typeId: x.typeId, label: x.label })) });
  const sets = [set(hubKey, T.contact, aC.get(cid)), set(hubKey, T.deal, aD.get(cid)), set(hubKey, T.lead, aL.get(cid))];
  for (const c of ourC){
    const ck = recKey(T.contact, c);
    sets.push(set(ck, T.deal, cD.get(c)), set(ck, T.lead, cL.get(c)), set(ck, T.company, cCo.get(c)));
  }
  for (const l of ourL) sets.push(set(recKey(T.lead, l), T.deal, lD.get(l)));
  const lnk = await applyLinks(env, sets, { source: "walk", at });
  const changes = rec.changes.concat(lnk.changes);
  const last = await recordChanges(env, changes, "walk", at);
  if (changes.length) await announce(env, last, changes);
  end(sW, rec.created.length + " NEW · " + rec.updated.length + " CHANGED · " + lnk.added + " LINKS ADDED · " + lnk.removed + " REMOVED",
      changes.length ? "warn" : "ok");

  if (user) await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'walk', ?3)")
    .bind(at, user.email, JSON.stringify({ company: cid, mode: "live", calls: hs.stats.calls, ms: Date.now() - t0, waited: hs.stats.waitedMs, steps: timing })).run().catch(() => {});

  return {
    ok: true, mode: "live", company: { id: cid, name: cp.name || "", domain: cp.domain || "" },
    nodes: [...nodes.values()], edges: [...edges.values()], capped, missed, changes: changes.length,
    stats: { calls: hs.stats.calls, search: hs.stats.search, waitedMs: hs.stats.waitedMs, ms: Date.now() - t0 }
  };
}
