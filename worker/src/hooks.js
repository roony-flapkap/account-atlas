// HubSpot webhooks: the portal tells us as things happen. The private app is
// subscribed (see ../docs/pages-worker-setup.md) to, for companies, contacts
// and deals: creation, deletion, merge, restore, associationChange, and
// propertyChange on the fields the map draws. Leads have no webhooks for a
// private app; the 15-minute read and the nightly re-read cover them.
//
// Only HubSpot can post here: every request must carry a valid signature
// made with the app's client secret — v3 (timestamped, refused after five
// minutes) or v1 (no timestamp; a replay is caught by the event id, since
// each event is applied once).

import { hubspotClient, T } from "./hubspot.js";
import { ASKFOR, toRow, recKey } from "./shape.js";
import { applyRecords, applyOneLink, applyDeletions, recordChanges } from "./graph.js";
import { announce } from "./hub.js";
import { addUsage } from "./sync.js";

const enc = new TextEncoder();
const TYPE_OF = { contact: T.contact, company: T.company, deal: T.deal, lead: T.lead, line_item: null, ticket: null };
const MAX_AGE_MS = 5 * 60 * 1000;

function safeEq(a, b){
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const b64 = buf => { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };

// HubSpot signs the URI with these characters decoded
function hubspotUri(url){
  return url.replace(/%3A/gi, ":").replace(/%2F/gi, "/").replace(/%3F/gi, "?").replace(/%40/gi, "@").replace(/%21/gi, "!")
            .replace(/%24/gi, "$").replace(/%27/gi, "'").replace(/%28/gi, "(").replace(/%29/gi, ")").replace(/%2A/gi, "*")
            .replace(/%2C/gi, ",").replace(/%3B/gi, ";");
}

export async function verifySignature(req, body, env, nowMs = Date.now()){
  const secret = env.HUBSPOT_CLIENT_SECRET;
  if (!secret) return { ok: false, why: "HUBSPOT_CLIENT_SECRET is not set" };
  const v3 = req.headers.get("x-hubspot-signature-v3");
  if (v3){
    const ts = Number(req.headers.get("x-hubspot-request-timestamp"));
    if (!(ts > 0) || Math.abs(nowMs - ts) > MAX_AGE_MS) return { ok: false, why: "stale or missing timestamp" };
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(req.method + hubspotUri(req.url) + body + ts));
    return safeEq(b64(mac), v3) ? { ok: true, v: 3 } : { ok: false, why: "bad v3 signature" };
  }
  const v1 = req.headers.get("x-hubspot-signature");
  const ver = (req.headers.get("x-hubspot-signature-version") || "v1").toLowerCase();
  if (v1 && ver === "v1"){
    const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(secret + body)));
    return safeEq(h, v1.toLowerCase()) ? { ok: true, v: 1 } : { ok: false, why: "bad v1 signature" };
  }
  if (v1 && ver === "v2"){
    const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(secret + req.method + req.url + body)));
    return safeEq(h, v1.toLowerCase()) ? { ok: true, v: 2 } : { ok: false, why: "bad v2 signature" };
  }
  return { ok: false, why: "unsigned" };
}

// "contact.deletion" (legacy) or "object.deletion" with objectTypeId (generic)
function parse(ev){
  const [obj, what] = String(ev.subscriptionType || "").split(".");
  const t = obj === "object" ? String(ev.objectTypeId || "") : TYPE_OF[obj];
  return { t, what, id: ev.objectId != null ? String(ev.objectId) : null };
}

// Applies a delivery (up to 100 events). Records that were created, restored
// or changed are re-read in one batch per type, so the copy holds what
// HubSpot holds now — not whatever order the events arrived in.
export async function applyEvents(env, events, { at = new Date().toISOString() } = {}){
  // each event once, however often HubSpot sends it
  const fresh = [];
  const ids = events.map(e => String(e.eventId)).filter(Boolean);
  const seen = new Set();
  for (let i = 0; i < ids.length; i += 90){
    const part = ids.slice(i, i + 90);
    const r = await env.APP.prepare("SELECT id FROM hook_events WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(part)).all();
    for (const row of r.results || []) seen.add(row.id);
  }
  for (const e of events){ const id = String(e.eventId); if (!seen.has(id)){ seen.add(id); fresh.push(e); } }
  if (!fresh.length) return { applied: 0, changes: 0 };

  const reread = new Map();      // type -> Set(id)
  const want = (t, id) => { if (!reread.has(t)) reread.set(t, new Set()); reread.get(t).add(id); };
  const deleted = [], changes = [];
  // what this delivery costs the day's 100,000 rows written, counted so the
  // fill's daily cap leaves room for it (a deletion is about 3: the tombstone,
  // its links and its phone endings)
  let writes = 0;
  const DELETE_WRITES = 3;
  const merges = [], createdKeys = new Set();
  // oldest first, so a create-then-delete in one delivery ends deleted
  fresh.sort((a, b) => (a.occurredAt || 0) - (b.occurredAt || 0));
  for (const e of fresh){
    const { t, what, id } = parse(e);
    // an association change is described by its two ends, not by objectId
    if (!t || (!id && what !== "associationChange")) continue;
    const when = e.occurredAt ? new Date(e.occurredAt).toISOString() : at;
    if (what === "deletion" || what === "privacyDeletion"){ deleted.push({ key: recKey(t, id), at: when }); continue; }
    if (what === "merge"){
      const winner = recKey(t, String(e.primaryObjectId || e.newObjectId || id));
      const losers = (e.mergedObjectIds || []).map(String).map(x => recKey(t, x)).filter(k => k !== winner);
      merges.push({ winner, losers, at: when }); want(t, winner.split("/")[1]); continue;
    }
    if (what === "associationChange"){
      const ft = String(e.fromObjectTypeId || t), tt = String(e.toObjectTypeId || "");
      const toT = tt || assocTarget(e.associationType);
      if (!toT || !e.fromObjectId || !e.toObjectId) continue;
      const a = recKey(ft, String(e.fromObjectId)), b = recKey(toT, String(e.toObjectId));
      // HubSpot sends both sides of every link change; the second is a no-op
      const did = await applyOneLink(env, a, b, !!e.associationRemoved, { typeId: e.associationTypeId ?? null, at: when });
      if (did){ changes.push({ kind: e.associationRemoved ? "unlinked" : "linked", key: a, other: b, at: when }); writes += 2; }
      continue;
    }
    // creation, restore, propertyChange: read the record as it is now
    if (what === "creation") createdKeys.add(recKey(t, id));
    want(t, id);
  }

  for (const m of merges){ changes.push(...await applyDeletions(env, m.losers, { at: m.at, mergedInto: m.winner })); writes += m.losers.length * DELETE_WRITES; }
  const gone = new Set(deleted.map(d => d.key));
  if (reread.size){
    const hs = hubspotClient(env);
    for (const [t, set] of reread){
      const list = [...set].filter(id => !gone.has(recKey(t, id)));
      if (!list.length || !ASKFOR[t]) continue;
      const rows = (await hs.batchRead(t, list, ASKFOR[t])).map(x => toRow(t, x));
      const res = await applyRecords(env, rows, { source: "webhook", at });
      writes += res.writes || 0;
      changes.push(...res.created.filter(k => createdKeys.has(k)).map(k => ({ kind: "created", key: k })), ...res.changes);
    }
  }
  if (deleted.length){
    // a record already tombstoned (deleted from the map, or found gone by a
    // walk) has been reported once: HubSpot's own word on it changes nothing
    const r = await env.GRAPH.prepare("SELECT key FROM records WHERE key IN (SELECT value FROM json_each(?1)) AND deleted_at IS NOT NULL AND merged_into IS NULL")
      .bind(JSON.stringify(deleted.map(d => d.key))).all();
    const told = new Set((r.results || []).map(x => x.key));
    for (const d of deleted){
      if (told.has(d.key)) continue;
      told.add(d.key);
      changes.push(...await applyDeletions(env, [d.key], { at: d.at }));
      writes += DELETE_WRITES;
    }
  }

  const last = await recordChanges(env, changes, "webhook", at);
  // remember the events last, so a failure above makes HubSpot retry them
  for (let i = 0; i < fresh.length; i += 400){
    await env.APP.prepare("INSERT OR IGNORE INTO hook_events (id, at) SELECT value, ?2 FROM json_each(?1)")
      .bind(JSON.stringify(fresh.slice(i, i + 400).map(e => String(e.eventId))), at).run();
  }
  writes += changes.length + fresh.length;          // the change rows, and each event remembered once
  await addUsage(env, "hook_writes", writes);
  await announce(env, last, changes);
  return { applied: fresh.length, changes: changes.length, last };
}

// legacy association types are named like "CONTACT_TO_COMPANY"
function assocTarget(name){
  const m = /_TO_([A-Z]+)$/.exec(String(name || ""));
  return m ? { CONTACT: T.contact, COMPANY: T.company, DEAL: T.deal, LEAD: T.lead }[m[1]] || null : null;
}

export async function handleHook(req, env, ctx){
  const body = await req.text();
  if (body.length > 2_000_000) return new Response("too large", { status: 413 });
  const sig = await verifySignature(req, body, env);
  if (!sig.ok) return new Response(JSON.stringify({ error: { code: "bad_signature", message: sig.why } }), { status: 401 });
  let events;
  try { events = JSON.parse(body); } catch(e){ return new Response("not JSON", { status: 400 }); }
  if (!Array.isArray(events)) events = [events];
  // only this portal's events. Both sides trimmed: a stray newline in the
  // secret once dropped every event while still answering 204, so a drop is
  // also said out loud in the Worker's log
  const portal = String(env.PORTAL_ID || "").trim();
  const mine = events.filter(e => !portal || String(e.portalId).trim() === portal);
  if (mine.length < events.length){
    const others = [...new Set(events.filter(e => !mine.includes(e)).map(e => String(e.portalId)))];
    console.warn("webhook: dropped " + (events.length - mine.length) + " of " + events.length + " event(s) from portal(s) " + others.join(", "));
  }
  events = mine;
  // Applied before answering: a failure answers 500 and HubSpot sends the
  // events again (up to 10 times over a day). Answering first and applying
  // in the background would lose them for good on a failure.
  try { await applyEvents(env, events); }
  catch(e){ console.error("webhook apply failed", e && e.stack || e); return new Response("retry", { status: 500 }); }
  return new Response(null, { status: 204 });
}
