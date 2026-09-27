// The page's other reads: resolving what was typed to a company, opening a
// record out, records read fresh, the change feed, and segments. Each reads
// HubSpot in bulk and leaves what it read in the SQL copy.

import { hubspotClient, T, KIND_OF } from "./hubspot.js";
import { ASKFOR, lookups, shapeRecord, dContact, toRow, recKey } from "./shape.js";
import { applyRecords, applyLinks, recordChanges, recordsByKey } from "./graph.js";
import { announce } from "./hub.js";
import { HttpError } from "./errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOk = v => /^\d{1,20}$/.test(String(v || ""));
const typeOk = t => !!KIND_OF[t];

async function keep(env, rows, sets, source){
  const rec = await applyRecords(env, rows, { source });
  const lnk = sets.length ? await applyLinks(env, sets, { source }) : { changes: [] };
  const ch = rec.changes.concat(lnk.changes);
  if (ch.length){ const last = await recordChanges(env, ch, source); await announce(env, last, ch); }
  return ch.length;
}

// ---------------------------------------------------------------- resolve
// { kind: email|contact|deal|adminKey, value } -> { ok, id, via, steps } —
// every accepted identifier is exact; no name matching, as before.
export async function resolve(env, what){
  const hs = hubspotClient(env);
  const steps = [];
  const kind = what && what.kind, value = String(what && what.value || "").trim();
  const fail = (why, note) => { steps.push({ m: note || "LOOKUP", note: "NOT FOUND", st: "err" }); return { ok: false, why, steps }; };
  let contactIds = null, dealIds = null;
  if (kind === "email"){
    const r = await hs.search(T.contact, { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: value.toLowerCase() }] }],
                                           properties: ["firstname", "lastname", "email"], limit: 10 });
    const hits = (r && r.results) || [];
    if (!hits.length) return fail("No contact in HubSpot carries the address " + value + ".", "MATCH ADDRESS TO A CONTACT");
    if (hits.length > 1) return { ok: false, steps: [{ m: "MATCH ADDRESS TO A CONTACT", note: hits.length + " CONTACTS ON ONE ADDRESS", st: "err" }],
      why: hits.length + " contacts carry " + value + ". Which account you meant is not obvious — open one and acquire it by its record id: " + hits.map(h => h.id).join(", ") };
    steps.push({ m: "MATCH ADDRESS TO A CONTACT", note: ((hits[0].properties.firstname || "") + " " + (hits[0].properties.lastname || "")).trim().toUpperCase() || hits[0].id, st: "ok" });
    contactIds = [String(hits[0].id)];
  } else if (kind === "contact"){
    if (!idOk(value)) throw new HttpError(400, "bad_input", "a contact id is digits");
    steps.push({ m: "READ CONTACT RECORD", note: "CONTACT " + value, st: "ok" });
    contactIds = [value];
  } else if (kind === "adminKey"){
    if (!UUID_RE.test(value)) throw new HttpError(400, "bad_input", "an admin-app user id is a UUID");
    const r = await hs.search(T.deal, { filterGroups: [{ filters: [{ propertyName: "admin_app_user__id", operator: "EQ", value: value.toLowerCase() }] }],
                                        properties: ["dealname"], limit: 20 });
    const found = (r && r.results) || [];
    if (!found.length) return fail("No deal in HubSpot carries the admin-app user id " + value + ". Either the client has no HubSpot deal, or the key was never pasted onto it.",
                                   "TRACE KEY THROUGH DEAL RECORDS");
    steps.push({ m: "TRACE KEY THROUGH DEAL RECORDS", note: found.length + (found.length === 1 ? " DEAL" : " DEALS"), st: "ok" });
    dealIds = found.map(x => String(x.id));
  } else if (kind === "deal"){
    if (!idOk(value)) throw new HttpError(400, "bad_input", "a deal id is digits");
    steps.push({ m: "RESOLVE ACCOUNT FROM DEAL", note: "DEAL " + value, st: "ok" });
    dealIds = [value];
  } else throw new HttpError(400, "bad_input", "unknown kind");

  if (contactIds){
    const cos = (await hs.assoc(T.contact, T.company, contactIds)).get(contactIds[0]) || [];
    if (!cos.length){ steps.push({ m: "LOCATE PARENT COMPANY", note: "NO PARENT", st: "err" });
      return { ok: false, steps, why: "That contact belongs to no company, so there is no account to draw. The contact itself is record " + contactIds[0] + "." }; }
    steps.push({ m: "LOCATE PARENT COMPANY", note: cos.length > 1 ? cos.length + " COMPANIES" : "ONE COMPANY", st: "ok" });
    return { ok: true, id: cos[0].id, via: "reached through the contact", many: cos.length, steps };
  }
  const byDeal = await hs.assoc(T.deal, T.company, dealIds);
  let cos = dealIds.flatMap(d => byDeal.get(d) || []), via = "the deal";
  if (!cos.length){
    const byC = await hs.assoc(T.deal, T.contact, dealIds);
    const cts = dealIds.flatMap(d => byC.get(d) || []).map(x => x.id);
    if (cts.length){ const cc = await hs.assoc(T.contact, T.company, cts); cos = cts.flatMap(c => cc.get(c) || []); via = "a contact on the deal"; }
  }
  if (!cos.length){ steps.push({ m: "LOCATE PARENT COMPANY", note: "NO PARENT", st: "err" });
    return { ok: false, steps, why: "That deal has no company attached, and none of its contacts belong to one either — so there is no account to draw." }; }
  steps.push({ m: "LOCATE PARENT COMPANY", note: via.toUpperCase(), st: "ok" });
  return { ok: true, id: cos[0].id, via: "reached through " + via, steps };
}

// ---------------------------------------------------------------- expand
const OTHERS = [T.contact, T.company, T.deal, T.lead];
export async function expand(env, key, limit = 40){
  const [t, id] = String(key || "").split("/");
  if (!typeOk(t) || !idOk(id)) throw new HttpError(400, "bad_input", "a record key is <type>/<id>");
  const hs = hubspotClient(env);
  const L = await lookups(env, hs);
  const want = OTHERS.filter(x => x !== t);
  const got = await Promise.all(want.map(to => hs.assoc(t, to, [id])));
  const out = {}, rows = [], sets = [];
  await Promise.all(want.map(async (to, i) => {
    const all = got[i].get(id) || [];
    sets.push({ from: key, toType: to, to: all.map(x => ({ key: recKey(to, x.id), typeId: x.typeId, label: x.label })) });
    const read = await hs.batchRead(to, all.slice(0, limit).map(x => x.id), ASKFOR[to]);
    rows.push(...read.map(x => toRow(to, x)));
    out[KIND_OF[to]] = { total: all.length, records: read.map(x => shapeRecord(to, x, L)) };
  }));
  const changes = await keep(env, rows, sets, "expand");
  return { key, found: out, changes, calls: hs.stats.calls };
}

// ---------------------------------------------------------------- records, fresh
export async function recordsFresh(env, keys){
  keys = [...new Set((keys || []).map(String))].slice(0, 300);
  const byType = new Map();
  for (const k of keys){ const [t, id] = k.split("/"); if (typeOk(t) && idOk(id)){ if (!byType.has(t)) byType.set(t, []); byType.get(t).push(id); } }
  const hs = hubspotClient(env);
  const L = await lookups(env, hs);
  const records = [], rows = [];
  for (const [t, ids] of byType){
    const read = await hs.batchRead(t, ids, ASKFOR[t]);
    for (const x of read){ rows.push(toRow(t, x)); records.push(shapeRecord(t, x, L)); }
  }
  const back = new Set(records.map(r => r.k));
  const missing = keys.filter(k => !back.has(k));
  await keep(env, rows, [], "refresh");
  return { records, missing };
}

// ---------------------------------------------------------------- the companies of some records
// A SQL result or a finding names records of every kind; a canvas holds
// companies. Company keys stand; a contact, deal or lead stands for the
// companies it is on — from the copy's links, and from HubSpot (in bulk) for
// what the copy has not linked yet.
export async function companiesOf(env, keys){
  keys = [...new Set((keys || []).map(String))].filter(k => { const [t, id] = k.split("/"); return typeOk(t) && idOk(id); }).slice(0, 5000);
  const cos = new Set(keys.filter(k => k.startsWith(T.company + "/")).map(k => k.split("/")[1]));
  const others = keys.filter(k => !k.startsWith(T.company + "/"));
  const from = { companies: cos.size, contacts: 0, deals: 0, leads: 0 };
  for (const k of others) from[{ [T.contact]: "contacts", [T.deal]: "deals", [T.lead]: "leads" }[k.split("/")[0]]]++;
  const linked = new Set();
  for (let i = 0; i < others.length; i += 500){
    const r = await env.GRAPH.prepare("SELECT a, b FROM links WHERE a IN (SELECT value FROM json_each(?1)) AND b >= '0-2/' AND b < '0-20'")
      .bind(JSON.stringify(others.slice(i, i + 500))).all();
    for (const x of r.results || []){ cos.add(x.b.split("/")[1]); linked.add(x.a); }
  }
  const hs = hubspotClient(env);
  const unknown = others.filter(k => !linked.has(k));
  for (const t of [T.contact, T.deal, T.lead]){
    const ids = unknown.filter(k => k.startsWith(t + "/")).map(k => k.split("/")[1]);
    if (!ids.length) continue;
    const m = await hs.assoc(t, T.company, ids.slice(0, 3000));
    for (const list of m.values()) for (const x of list) cos.add(x.id);
  }
  return { companies: await companyStubs(env, hs, [...cos].slice(0, 5000)), from };
}

// ---------------------------------------------------------------- tombstones
// Which of these records the copy knows are gone from HubSpot (deleted, or
// merged into another), so a canvas can show it after a reload too.
export async function tombstones(env, keys){
  keys = [...new Set((keys || []).map(String))].filter(k => { const [t, id] = k.split("/"); return typeOk(t) && idOk(id); }).slice(0, 2000);
  const gone = [];
  for (let i = 0; i < keys.length; i += 500){
    const r = await env.GRAPH.prepare("SELECT key, deleted_at, merged_into FROM records WHERE key IN (SELECT value FROM json_each(?1)) AND deleted_at IS NOT NULL")
      .bind(JSON.stringify(keys.slice(i, i + 500))).all();
    for (const x of r.results || []) gone.push({ key: x.key, at: x.deleted_at, other: x.merged_into || null });
  }
  return { gone };
}

// ---------------------------------------------------------------- changes
export async function changesSince(env, since, limit = 500, keys = null){
  since = Math.max(0, Number(since) || 0);
  limit = Math.min(1000, Math.max(1, Number(limit) || 500));
  const r = await env.GRAPH.prepare(
    "SELECT c.seq, c.at, c.kind, c.key, c.other, c.detail, c.source, r.label AS label, o.label AS other_label " +
    "FROM changes c LEFT JOIN records r ON r.key = c.key LEFT JOIN records o ON o.key = c.other " +
    "WHERE c.seq > ?1 ORDER BY c.seq LIMIT ?2").bind(since, limit).all();
  let rows = (r.results || []).map(x => Object.assign(x, { detail: x.detail ? JSON.parse(x.detail) : null }));
  if (keys && keys.length){ const s = new Set(keys); rows = rows.filter(x => s.has(x.key) || s.has(x.other)); }
  const top = await env.GRAPH.prepare("SELECT max(seq) AS m FROM changes").first();
  return { changes: rows, last: rows.length ? rows[rows.length - 1].seq : since, head: (top && top.m) || 0 };
}

// ---------------------------------------------------------------- segments
export async function searchSegments(env, q, types){
  const hs = hubspotClient(env);
  const allowed = (types && types.length ? types : [T.company, T.contact, T.deal]).filter(typeOk);
  const r = await hs.call("POST", "/crm/v3/lists/search", { query: String(q || "").slice(0, 200), count: 40, offset: 0,
                                                             additionalProperties: ["hs_list_size", "hs_lastmodifieddate"] });
  const rows = ((r && r.lists) || []).map(l => ({
    id: String(l.listId), name: l.name || "Segment " + l.listId, type: String(l.objectTypeId || ""),
    size: Number((l.additionalProperties || {}).hs_list_size || l.size || 0), live: l.processingType === "DYNAMIC",
    updated: l.updatedAt || (l.additionalProperties || {}).hs_lastmodifieddate || null
  })).filter(s => allowed.indexOf(s.type) >= 0);
  return { rows, total: r && r.total != null ? Number(r.total) : rows.length };
}

// A slice of a segment's members, traced to their companies. The page calls
// again with `after` until it has what it wants (at most 8 pages of 250 a
// call, so a call stays inside the free plan's 50 subrequests).
export async function segmentMembers(env, listId, { type, after = null, pages = 8 } = {}){
  if (!idOk(listId)) throw new HttpError(400, "bad_input", "a list id is digits");
  if (!typeOk(type)) throw new HttpError(400, "bad_input", "unknown segment type");
  const hs = hubspotClient(env);
  const ids = [];
  let cursor = after;
  for (let i = 0; i < Math.min(8, pages); i++){
    const r = await hs.call("GET", "/crm/v3/lists/" + listId + "/memberships?limit=250" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""));
    for (const m of (r && r.results) || []) ids.push(String(typeof m === "object" ? (m.recordId ?? m.id) : m));
    cursor = r && r.paging && r.paging.next && r.paging.next.after || null;
    if (!cursor) break;
  }
  // members kept in the copy, so a segment is a join too
  if (ids.length) await env.GRAPH.prepare("INSERT OR IGNORE INTO segment_members (list_id, record_key) SELECT ?1, value FROM json_each(?2)")
    .bind(String(listId), JSON.stringify(ids.map(id => recKey(type, id)))).run();

  let companyIds = ids, traced = 0;
  if (type !== T.company){
    const m = await hs.assoc(type, T.company, ids);
    companyIds = [...new Set(ids.flatMap(id => (m.get(id) || []).map(x => x.id)))];
    traced = ids.length;
  }
  return { members: ids.length, traced, companies: await companyStubs(env, hs, companyIds), after: cursor };
}

// names and domains: from the copy where it has them, from HubSpot for the rest
async function companyStubs(env, hs, ids){
  const have = await recordsByKey(env, ids.map(id => recKey(T.company, id)));
  const need = ids.filter(id => { const r = have.get(recKey(T.company, id)); return !r || !r.label; });
  const read = need.length ? await hs.batchRead(T.company, need, ASKFOR[T.company]) : [];
  if (read.length) await applyRecords(env, read.map(x => toRow(T.company, x)), { source: "segment" });
  const fresh = new Map(read.map(x => [String(x.id), x]));
  return ids.map(id => {
    const x = fresh.get(id), r = have.get(recKey(T.company, id));
    if (x) return { id, name: x.properties.name || "Company " + id, domain: x.properties.domain || "", deleted: false };
    if (r) return { id, name: r.label || "Company " + id, domain: r.sub || "", deleted: !!r.deleted_at };
    return null;                                    // not in HubSpot any more
  }).filter(Boolean);
}

// THE MESH, in one go: which people on these companies are on another
// company too, and which. Bulk associations answer both halves at once —
// the connector needed one search per person for the second.
export async function segmentMesh(env, companyIds){
  companyIds = [...new Set((companyIds || []).map(String).filter(idOk))].slice(0, 5000);
  const hs = hubspotClient(env);
  const L = await lookups(env, hs);
  const coContacts = await hs.assoc(T.company, T.contact, companyIds);
  const contactIds = [...new Set(companyIds.flatMap(c => (coContacts.get(c) || []).map(x => x.id)))];
  const cCos = await hs.assoc(T.contact, T.company, contactIds);
  const shared = contactIds.filter(c => (cCos.get(c) || []).length > 1);
  const people = await hs.batchRead(T.contact, shared, ASKFOR[T.contact]);
  const members = new Set(companyIds);
  const outsideIds = [...new Set(shared.flatMap(c => cCos.get(c).map(x => x.id)).filter(id => !members.has(id)))];
  const outside = await companyStubs(env, hs, outsideIds);

  // into the copy: each member company's complete contact list, and each
  // contact's complete company list
  const sets = companyIds.map(c => ({ from: recKey(T.company, c), toType: T.contact, to: (coContacts.get(c) || []).map(x => ({ key: recKey(T.contact, x.id), typeId: x.typeId, label: x.label })) }))
    .concat(contactIds.map(c => ({ from: recKey(T.contact, c), toType: T.company, to: (cCos.get(c) || []).map(x => ({ key: recKey(T.company, x.id), typeId: x.typeId, label: x.label })) })));
  await keep(env, people.map(x => toRow(T.contact, x)), sets, "segment");

  const byId = new Map(people.map(x => [String(x.id), x]));
  return {
    looked: companyIds.length, contacts: contactIds.length,
    people: shared.map(c => {
      const cos = cCos.get(c).map(x => x.id);
      const home = cos.find(id => members.has(id)) || cos[0];
      return { record: dContact(byId.get(c) || { id: c, properties: {} }, home, recKey(T.company, home), false, L), companies: cos };
    }),
    outside, calls: hs.stats.calls
  };
}
