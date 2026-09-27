// THE WALK, on the Worker: one company, its records, how they link to each
// other, what they reach outside it, and who shares its numbers without a
// link. The page's walkCore did this with ~12 connector searches and caps;
// here it is bulk reads (100 records or 1,000 association lists a call),
// no caps worth the name, and the answer lands in the SQL copy as well.
//
// It reports as it goes through `say`, one event per console line, so the
// page's console still types the walk out live:
//   { t: "prog", pct, label } · { t: "step", id, m } · { t: "end", id, note, st }
//   { t: "line", m, cls } · and last { t: "done", … the records and edges }

import { hubspotClient, T, pool } from "./hubspot.js";
import { ASKFOR, lookups, shapeOf, dCompany, dContact, dDeal, toRow, recKey, phoneTail } from "./shape.js";
import { applyRecords, applyLinks, recordChanges, applyDeletions, recordsByKey, sharingNumbers } from "./graph.js";
import { announce } from "./hub.js";

const FOREIGN_DEALS = 60;       // deals this account's people are on elsewhere
const PROBES_LIVE = 5;          // phone searches, while the copy has no complete phone book

export async function walk(env, cid, say, { user } = {}){
  const t0 = Date.now();
  cid = String(cid);
  const hs = hubspotClient(env);
  const L = await lookups(env, hs);
  const at = new Date().toISOString();
  const hubKey = recKey(T.company, cid);
  const nodes = new Map(), edges = new Map(), capped = [];
  let missed = 0, seq = 0;
  const take = d => { if (!nodes.has(d.k)) nodes.set(d.k, d); return d; };
  const join = (a, b, r) => { if (a === b || !nodes.has(a) || !nodes.has(b)) return; const id = a < b ? a + "|" + b : b + "|" + a;
                              const had = edges.get(id); if (!had || r === "member") edges.set(id, { a, b, r }); };
  const step = m => { const id = ++seq; say({ t: "step", id, m }); return id; };
  const end = (id, note, st = "ok") => say({ t: "end", id, note, st });
  const prog = (pct, label) => say({ t: "prog", pct, label });

  // ---- the company
  prog(16, "READING COMPANY RECORD");
  const sRead = step("READ COMPANY 0-2/" + cid);
  const [co] = await hs.batchRead(T.company, [cid], ASKFOR[T.company]);
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
  end(sRead, String(cp.name || cid).toUpperCase());
  take(dCompany(co, L));

  // ---- membership
  prog(28, "WALKING ASSOCIATIONS");
  const sAs = step("ASSOCIATED CONTACTS · DEALS · LEADS");
  const [aC, aD, aL] = await Promise.all([T.contact, T.deal, T.lead].map(t => hs.assoc(T.company, t, [cid])));
  const ids = { [T.contact]: aC.get(cid).map(x => x.id), [T.deal]: aD.get(cid).map(x => x.id), [T.lead]: aL.get(cid).map(x => x.id) };
  end(sAs, ids[T.contact].length + " CONTACTS · " + ids[T.deal].length + " DEALS · " + ids[T.lead].length + " LEADS");

  prog(38, "READING RECORDS");
  const sRec = step("READ " + (ids[T.contact].length + ids[T.deal].length + ids[T.lead].length) + " RECORDS");
  const [rC, rD, rL] = await Promise.all([T.contact, T.deal, T.lead].map(t => hs.batchRead(t, ids[t], ASKFOR[t])));
  end(sRec, "IN " + (Math.ceil(rC.length / 100) + Math.ceil(rD.length / 100) + Math.ceil(rL.length / 100) || 0) + " READS");
  const lost = ids[T.contact].length + ids[T.deal].length + ids[T.lead].length - rC.length - rD.length - rL.length;
  if (lost > 0) missed += lost;
  rC.forEach(x => join(hubKey, take(dContact(x, cid, hubKey, false, L)).k, "member"));
  rD.forEach(x => join(hubKey, take(shapeOf[T.deal](x, cid, hubKey, L)).k, "member"));
  rL.forEach(x => join(hubKey, take(shapeOf[T.lead](x, cid, hubKey, L)).k, "member"));

  // ---- how those records relate to each other, and what they reach outside
  prog(60, "MAPPING RECORDS TO EACH OTHER");
  const ourC = rC.map(x => String(x.id)), ourL = rL.map(x => String(x.id));
  const sLk = step("ASSOCIATION MESH · " + (ourC.length + ourL.length) + " RECORDS");
  const [cD, cL, lD, cCo] = await Promise.all([
    hs.assoc(T.contact, T.deal, ourC), hs.assoc(T.contact, T.lead, ourC), hs.assoc(T.lead, T.deal, ourL), hs.assoc(T.contact, T.company, ourC)
  ]);
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
  let links = 0;
  const lk = (a, b, r) => { const before = edges.size; join(a, b, r); if (edges.size > before) links++; };
  for (const c of ourC){
    const ck = recKey(T.contact, c);
    for (const d of cD.get(c) || []) lk(ck, recKey(T.deal, d.id), "link");
    for (const l of cL.get(c) || []) lk(ck, recKey(T.lead, l.id), "link");
  }
  for (const l of ourL) for (const d of lD.get(l) || []) lk(recKey(T.lead, l), recKey(T.deal, d.id), "link");
  end(sLk, links + " LINKS");

  prog(70, "REACHING OUTSIDE THE ACCOUNT");
  const sOut = step("LINKS LEAVING THIS ACCOUNT");
  let reached = 0;
  for (const c of ourC) for (const k of cCo.get(c) || []){
    if (k.id === cid) continue;
    const before = edges.size; join(recKey(T.contact, c), recKey(T.company, k.id), "member"); if (edges.size > before) reached++;
  }
  end(sOut, reached || rFD.length ? (rFC.length + " COMPANIES · " + rFD.length + " DEALS ELSEWHERE") : "NONE — SELF-CONTAINED",
      reached || rFD.length ? "warn" : "ok");

  // ---- records that share a number with this account but carry no link
  prog(80, "SWEEPING FOR DETACHED RECORDS");
  const tails = [...new Set([cp.phone].concat(rC.map(x => (x.properties || {}).phone), rC.map(x => (x.properties || {}).mobilephone))
    .map(phoneTail).filter(Boolean))];
  const book = await env.GRAPH.prepare("SELECT status FROM sync_state WHERE job = 'backfill:0-1'").first();
  const fromCopy = !!(book && book.status === "done");
  const sS = step("PHONE SWEEP · " + tails.length + " NUMBERS" + (fromCopy ? " · FROM THE COPY" : ""));
  const seen = new Set(ourC);
  let strays = [];
  if (fromCopy){
    strays = (await sharingNumbers(env, tails)).map(r => r.key).filter(k => k.startsWith(T.contact + "/")).map(k => k.split("/")[1]);
  } else {
    if (tails.length > PROBES_LIVE) capped.push("phone probes");
    await hs.reserve("search", Math.min(tails.length, PROBES_LIVE));
    const found = await pool(tails.slice(0, PROBES_LIVE), 2, async tail => {
      try { const r = await hs.call("POST", "/crm/v3/objects/" + T.contact + "/search",
              { query: tail, properties: ASKFOR[T.contact], limit: 10 }, "search", true); return (r && r.results) || []; }
      catch(e){ missed++; return []; }
    });
    strays = found.flat().map(x => String(x.id));
  }
  strays = [...new Set(strays)].filter(id => !seen.has(id));
  const rS = strays.length ? await hs.batchRead(T.contact, strays, ASKFOR[T.contact]) : [];
  rS.forEach(x => join(hubKey, take(dContact(x, null, hubKey, true, L)).k, "detached"));
  end(sS, rS.length + " UNATTACHED ON THESE NUMBERS", rS.length ? "warn" : "ok");
  if (missed) say({ t: "line", m: missed + " READS REFUSED · THIS ACCOUNT IS INCOMPLETE · RE-WALK IT TO FILL THE GAPS", cls: "err" });

  // ---- into the SQL copy, and what changed since it was last read
  prog(88, "WRITING TO THE COPY");
  const sW = step("SQL COPY");
  const rows = [toRow(T.company, co)].concat(rC.map(x => toRow(T.contact, x)), rD.map(x => toRow(T.deal, x)), rL.map(x => toRow(T.lead, x)),
    rFD.map(x => toRow(T.deal, x)), rFC.map(x => toRow(T.company, x)), rS.map(x => toRow(T.contact, x)));
  const rec = await applyRecords(env, rows, { source: "walk", at });
  const known = k => rec.known.has(k);
  const sets = [
    { from: hubKey, toType: T.contact, to: aC.get(cid).map(x => ({ key: recKey(T.contact, x.id), typeId: x.typeId, label: x.label })) },
    { from: hubKey, toType: T.deal, to: aD.get(cid).map(x => ({ key: recKey(T.deal, x.id), typeId: x.typeId, label: x.label })) },
    { from: hubKey, toType: T.lead, to: aL.get(cid).map(x => ({ key: recKey(T.lead, x.id), typeId: x.typeId, label: x.label })) }
  ];
  for (const c of ourC){
    const ck = recKey(T.contact, c);
    sets.push({ from: ck, toType: T.deal, to: (cD.get(c) || []).map(x => ({ key: recKey(T.deal, x.id), typeId: x.typeId, label: x.label })) });
    sets.push({ from: ck, toType: T.lead, to: (cL.get(c) || []).map(x => ({ key: recKey(T.lead, x.id), typeId: x.typeId, label: x.label })) });
    sets.push({ from: ck, toType: T.company, to: (cCo.get(c) || []).map(x => ({ key: recKey(T.company, x.id), typeId: x.typeId, label: x.label })) });
  }
  for (const l of ourL) sets.push({ from: recKey(T.lead, l), toType: T.deal, to: (lD.get(l) || []).map(x => ({ key: recKey(T.deal, x.id), typeId: x.typeId, label: x.label })) });
  const lnk = await applyLinks(env, sets, { source: "walk", at, emitFor: known });
  const changes = rec.changes.concat(lnk.changes);
  const last = await recordChanges(env, changes, "walk", at);
  if (changes.length) await announce(env, last, changes);
  end(sW, rec.created.length + " NEW · " + rec.updated.length + " CHANGED · " + lnk.added + " LINKS ADDED · " + lnk.removed + " REMOVED",
      changes.length ? "warn" : "ok");

  if (user) await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'walk', ?3)")
    .bind(at, user.email, JSON.stringify({ company: cid, calls: hs.stats.calls })).run().catch(() => {});

  return {
    ok: true, company: { id: cid, name: cp.name || "", domain: cp.domain || "" },
    nodes: [...nodes.values()], edges: [...edges.values()], capped, missed, changes: changes.length,
    stats: { calls: hs.stats.calls, search: hs.stats.search, waitedMs: hs.stats.waitedMs, ms: Date.now() - t0 }
  };
}
