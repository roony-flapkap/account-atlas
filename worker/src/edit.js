// Deleting from the map: two kinds of write to HubSpot (the only others make
// static lists, lists.js). Records are archived (HubSpot keeps them in its
// recycle bin for 90 days), and the associations between two records are
// removed. No record is ever created, edited or merged. Only the people named
// in EDITORS (a secret: comma-separated addresses) may do either; anyone else
// is answered 403, and the page shows them no delete controls.
//
// HubSpot first, then the copy. A record or link is marked gone in D1 only
// once HubSpot has taken the delete, and every open page hears of it at
// once. HubSpot's own webhooks for the same deletes come later and change
// nothing (hooks.js passes over a record already tombstoned; a link already
// gone is a no-op). Each action is audited with what it removed, so a link,
// which the recycle bin does not keep, can be put back by hand.

import { hubspotClient, T, KIND_OF } from "./hubspot.js";
import { ASKFOR, toRow, recKey } from "./shape.js";
import { applyDeletions, applyUnlinks, recordChanges, recordsByKey, linksOf } from "./graph.js";
import { announce } from "./hub.js";
import { HttpError } from "./errors.js";

const KINDS = [T.company, T.contact, T.deal, T.lead];
// MAX_UNLINK_ALL keeps one call inside the free plan's 10 ms of CPU and 50 subrequests
const MAX_DELETE = 500, MAX_UNLINK = 500, MAX_UNLINK_ALL = 2000, LIST_PER_KIND = 200, AUDIT_LINKS = 3000;
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
const now = () => new Date().toISOString();

function keyOf(k){
  const m = /^(0-\d+)\/(\d{1,20})$/.exec(String(k || ""));
  if (!m || !KIND_OF[m[1]]) throw new HttpError(400, "bad_input", "a record key is <type>/<id>");
  return [m[1], m[2]];
}

export function canEdit(env, user){
  const list = String(env.EDITORS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return !!(user && user.email) && list.indexOf(String(user.email).toLowerCase()) >= 0;
}
function mustEdit(env, user){
  if (!canEdit(env, user)) throw new HttpError(403, "not_editor", "only the Atlas's editors may delete in HubSpot");
}

async function audit(env, user, action, detail){
  await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, ?3, ?4)")
    .bind(now(), user.email, action, JSON.stringify(detail)).run();
}
const failure = (what, n, e) => ({ what, count: n, code: (e && e.code) || "hubspot_error", message: (e && e.message) || "HubSpot refused" });
// nothing went through: say why, as the error the page shows
function allFailed(failed){
  const f = failed[0];
  return new HttpError(f.code === "missing_scope" ? 403 : 502, f.code, f.message);
}

// ---------------------------------------------------------------- the plan
// What "delete it and its associated records" would take: the record and
// everything linked to it directly, read live from HubSpot (the map may not
// hold all of it), each with how many companies it is on. Nothing is
// deleted here. A company (when the record is not one) and a record on two
// or more companies start unticked: deleting a contact must not take its
// account with it, nor a deal another account still has, unless asked.
export async function deletePlan(env, user, key){
  mustEdit(env, user);
  const [t, id] = keyOf(key);
  const hs = hubspotClient(env);
  const others = KINDS.filter(x => x !== t);
  await hs.prepay("general", 1 + others.length * 4);
  const got = await Promise.all(others.map(to => hs.assoc(t, to, [id])));
  const more = {};
  let links = 0;
  const lists = others.map((to, i) => {
    const all = (got[i].get(id) || []).map(x => x.id);
    links += all.length;
    if (all.length > LIST_PER_KIND) more[KIND_OF[to]] = all.length - LIST_PER_KIND;
    return [to, all.slice(0, LIST_PER_KIND)];
  });
  const [self, ...reads] = await Promise.all([hs.batchRead(t, [id], ASKFOR[t])].concat(lists.map(([to, ids]) => hs.batchRead(to, ids, ASKFOR[to]))));
  if (!self.length) throw new HttpError(404, "not_found", "that record is no longer in HubSpot");
  const onCos = await Promise.all(lists.map(([to, ids]) => to === T.company || !ids.length ? null : hs.assoc(to, T.company, ids)));
  const me = toRow(t, self[0]);
  const items = [];
  lists.forEach(([to, ids], i) => {
    const byId = new Map(reads[i].map(x => [String(x.id), x]));
    for (const rid of ids){
      const x = byId.get(rid);
      if (!x) continue;                             // linked, but no longer reads back: already gone
      const row = toRow(to, x);
      const cos = to === T.company ? null : (onCos[i].get(rid) || []).length;
      const tick = to !== T.company && cos < 2;
      items.push({ key: row.key, kind: KIND_OF[to], label: row.label, sub: row.sub, companies: cos, tick,
                   why: to === T.company ? "account" : cos >= 2 ? "on " + cos + " companies" : null });
    }
  });
  return { key: me.key, kind: KIND_OF[t], label: me.label, sub: me.sub, links, items, more, calls: hs.stats.calls };
}

// ---------------------------------------------------------------- delete
export async function deleteRecords(env, user, keys){
  mustEdit(env, user);
  keys = [...new Set((Array.isArray(keys) ? keys : []).map(String))];
  if (!keys.length) throw new HttpError(400, "bad_input", "nothing to delete");
  if (keys.length > MAX_DELETE) throw new HttpError(400, "too_many", "at most " + MAX_DELETE + " records at a time");
  const byType = new Map();
  for (const k of keys){ const [t, id] = keyOf(k); if (!byType.has(t)) byType.set(t, []); byType.get(t).push(id); }
  // what the copy knew of them, for the audit: names, and the links that go with them
  const [before, links] = await Promise.all([recordsByKey(env, keys), linksOf(env, keys)]);

  const hs = hubspotClient(env, { writes: true });
  const done = [], failed = [];
  for (const [t, ids] of byType){
    const parts = chunk(ids, 100);
    for (let i = 0; i < parts.length; i++){
      try { await hs.archive(t, parts[i]); done.push(...parts[i].map(id => recKey(t, id))); }
      catch(e){ failed.push(failure(KIND_OF[t], parts.slice(i).flat().length, e)); break; }
    }
  }
  const at = now();
  const changes = done.length ? (await applyDeletions(env, done, { at })).map(c => Object.assign(c, { at })) : [];
  if (changes.length){ const last = await recordChanges(env, changes, "edit", at); await announce(env, last, changes); }
  await audit(env, user, "hs_delete", {
    deleted: done.map(k => [k, (before.get(k) || {}).label || null]),
    links: done.flatMap(k => (links.get(k) || []).map(l => [l.a, l.b, l.type_id, l.label])).slice(0, AUDIT_LINKS),
    failed
  });
  if (!done.length) throw allFailed(failed);
  return { deleted: done, failed, changes };
}

// ---------------------------------------------------------------- unlink
// pairs: [[keyA, keyB], …]. Every association between each pair goes, all
// labels, both directions.
export async function unlinkPairs(env, user, pairs){
  mustEdit(env, user);
  const seen = new Set(), list = [];
  for (const p of Array.isArray(pairs) ? pairs : []){
    if (!Array.isArray(p) || p.length !== 2) throw new HttpError(400, "bad_input", "a link is [keyA, keyB]");
    const [ta, ia] = keyOf(p[0]), [tb, ib] = keyOf(p[1]);
    const a = recKey(ta, ia), b = recKey(tb, ib);
    if (a === b) throw new HttpError(400, "bad_input", "a record has no link to itself");
    const id = a < b ? a + "|" + b : b + "|" + a;
    if (!seen.has(id)){ seen.add(id); list.push([a, b]); }
  }
  if (!list.length) throw new HttpError(400, "bad_input", "nothing to unlink");
  if (list.length > MAX_UNLINK) throw new HttpError(400, "too_many", "at most " + MAX_UNLINK + " links at a time");
  return unlinkNow(env, user, list, "hs_unlink", {});
}

// Unassociate a record from everything: every link it has to a company,
// contact, deal or lead, read live from HubSpot (the map may not hold them all).
export async function unlinkAll(env, user, key){
  mustEdit(env, user);
  const [t, id] = keyOf(key);
  const me = recKey(t, id);
  const hs = hubspotClient(env);
  const others = KINDS.filter(x => x !== t);
  const got = await Promise.all(others.map(to => hs.assoc(t, to, [id])));
  const pairs = others.flatMap((to, i) => (got[i].get(id) || []).map(x => [me, recKey(to, x.id)]));
  if (!pairs.length) return { unlinked: [], failed: [], changes: [] };
  if (pairs.length > MAX_UNLINK_ALL) throw new HttpError(400, "too_many", "it has " + pairs.length + " links; at most " + MAX_UNLINK_ALL + " go at a time");
  return unlinkNow(env, user, pairs, "hs_unlink_all", { key: me });
}

async function unlinkNow(env, user, pairs, action, extra){
  const hs = hubspotClient(env, { writes: true });
  // HubSpot removes associations per pair of object types
  const groups = new Map();
  for (const [a, b] of pairs){
    const g = a.split("/")[0] + ">" + b.split("/")[0];
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([a, b]);
  }
  const done = [], failed = [];
  for (const [g, list] of groups){
    const [ft, tt] = g.split(">");
    // hs.unlink packs a part into as few calls as HubSpot allows (100 records a call,
    // 100 links each): one record's whole list of a kind is usually one call
    const parts = chunk(list, 1000);
    for (let i = 0; i < parts.length; i++){
      try { await hs.unlink(ft, tt, parts[i].map(([a, b]) => [a.split("/")[1], b.split("/")[1]])); done.push(...parts[i]); }
      catch(e){ failed.push(failure(KIND_OF[ft] + "-" + KIND_OF[tt], parts.slice(i).flat().length, e)); break; }
    }
  }
  const at = now();
  const had = done.length ? await applyUnlinks(env, done) : [];
  const changes = done.map(([a, b]) => ({ kind: "unlinked", key: a, other: b, at }));
  if (changes.length){ const last = await recordChanges(env, changes, "edit", at); await announce(env, last, changes); }
  await audit(env, user, action, Object.assign({}, extra, {
    unlinked: done, had: had.map(l => [l.a, l.b, l.type_id, l.label]).slice(0, AUDIT_LINKS), failed
  }));
  if (!done.length) throw allFailed(failed);
  return { unlinked: done, failed, changes };
}
