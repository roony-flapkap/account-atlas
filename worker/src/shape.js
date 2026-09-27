// HubSpot rows -> the page's map records, and -> rows of the SQL copy.
// The record shape is the page's own (src/02-model.js, packNode): short
// field names k kd id t l s c o cr ci hh f. Names of owners, users, stages
// and pipelines are read from HubSpot here, so the page embeds none.

import { T } from "./hubspot.js";

export const ASKFOR = {
  [T.company]: ["name","domain","phone","country","city","createdate","hubspot_owner_id","lifecyclestage","hs_created_by_user_id"],
  [T.contact]: ["firstname","lastname","email","phone","mobilephone","createdate","hubspot_owner_id","lifecyclestage","hs_object_source_label","hs_created_by_user_id"],
  [T.deal]:    ["dealname","dealstage","pipeline","amount","createdate","hubspot_owner_id","admin_app_user__id","hs_created_by_user_id","sdr_name_deal","sdr_handoff_to_bdr_deal"],
  [T.lead]:    ["hs_lead_name","hs_pipeline_stage","hs_pipeline","hubspot_owner_id","hs_createdate","hs_lead_source","hs_created_by_user_id"]
};

export const recKey = (t, id) => t + "/" + id;
export const phoneTail = s => { const d = String(s || "").replace(/[^0-9]/g, ""); return d.length >= 9 ? d.slice(-9) : ""; };
const isoOf = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const facts = list => list.filter(p => p && p[1] != null && p[1] !== "");
const aed = v => v ? "AED " + Number(v).toLocaleString("en-US") : null;

// ---------------------------------------------------------------- lookups
const LOOKUP_MS = 24 * 3600e3;
let memo = null;
export const EMPTY_LOOKUPS = { owners: {}, users: {}, gone: {}, pipeline: {}, dealStage: {}, leadStage: {} };

export async function lookups(env, hs, { refresh = false } = {}){
  if (!refresh && memo && Date.now() - memo.at < LOOKUP_MS) return memo.data;
  if (!refresh){
    const row = await env.GRAPH.prepare("SELECT data, at FROM lookups WHERE name = 'names'").first();
    if (row && Date.now() - Date.parse(row.at) < LOOKUP_MS){ memo = { at: Date.parse(row.at), data: JSON.parse(row.data) }; return memo.data; }
  }
  if (!hs) return memo ? memo.data : EMPTY_LOOKUPS;
  const data = { owners: {}, users: {}, gone: {}, pipeline: {}, dealStage: {}, leadStage: {} };
  const name = o => ((o.firstName || "") + " " + (o.lastName || "")).trim() || o.email || "owner " + o.id;
  // names are a nicety: if HubSpot will not give them (a scope missing, say),
  // records show owner ids and the walk goes on
  try {
    for (const archived of [false, true]){
      let after = null;
      do {
        const r = await hs.call("GET", "/crm/v3/owners?limit=500&archived=" + archived + (after ? "&after=" + encodeURIComponent(after) : ""));
        for (const o of (r && r.results) || []){
          (archived ? data.gone : data.owners)[o.id] = name(o);
          if (o.userId != null) data.users[o.userId] = name(o);
        }
        after = r && r.paging && r.paging.next && r.paging.next.after;
      } while (after);
    }
  } catch(e){ console.warn("owner names unavailable: " + (e && e.message)); }
  for (const [type, into] of [["deals", "dealStage"], [T.lead, "leadStage"]]){
    try {
      const r = await hs.call("GET", "/crm/v3/pipelines/" + type);
      for (const p of (r && r.results) || []){
        data.pipeline[p.id] = p.label;
        for (const s of p.stages || []) data[into][s.id] = s.label;
      }
    } catch(e){ /* a portal without that pipeline type */ }
  }
  const at = new Date().toISOString();
  await env.GRAPH.prepare("INSERT INTO lookups (name, data, at) VALUES ('names', ?1, ?2) ON CONFLICT(name) DO UPDATE SET data = excluded.data, at = excluded.at")
    .bind(JSON.stringify(data), at).run();
  memo = { at: Date.parse(at), data };
  return data;
}

const namer = L => ({
  owner: id => id ? (L.owners[id] || L.gone[id] || "owner " + id) : null,
  rep: id => id ? (L.gone[id] || L.owners[id] || "owner " + id) : null,
  maker: id => id ? (L.users[id] || "user " + id) : null
});

// ---------------------------------------------------------------- map records
export function contactName(x){
  const p = x.properties || {};
  return ((p.firstname || "") + " " + (p.lastname || "")).trim() || p.email || "Contact " + x.id;
}

export function dCompany(x, L){
  const p = x.properties || {}, N = namer(L);
  return {
    k: recKey(T.company, x.id), kd: "company", id: String(x.id), t: T.company,
    l: p.name || "Company " + x.id, s: p.domain || "",
    c: isoOf(p.createdate), o: N.owner(p.hubspot_owner_id), cr: N.maker(p.hs_created_by_user_id),
    ci: [], hh: recKey(T.company, x.id),
    f: facts([["Domain", p.domain], ["Country", p.country], ["City", p.city],
              ["Owner", N.owner(p.hubspot_owner_id) || "unowned"],
              ["Created by", N.maker(p.hs_created_by_user_id)], ["Lifecycle", p.lifecyclestage]])
  };
}
export function dContact(x, cid, home, detached, L){
  const p = x.properties || {}, N = namer(L);
  return {
    k: recKey(T.contact, x.id), kd: detached ? "detached" : "contact", id: String(x.id), t: T.contact,
    l: contactName(x), s: p.hs_object_source_label || "",
    c: isoOf(p.createdate), o: N.owner(p.hubspot_owner_id), cr: N.maker(p.hs_created_by_user_id),
    ci: cid ? [String(cid)] : [], hh: home,
    f: facts([["Email", p.email], ["Phone", [p.phone, p.mobilephone].filter(Boolean).join(" · ")],
              ["Owner", N.owner(p.hubspot_owner_id) || "unowned"], ["Created by", N.maker(p.hs_created_by_user_id)],
              ["Lifecycle", p.lifecyclestage], ["Source", p.hs_object_source_label]])
  };
}
export function dDeal(x, cid, home, L){
  const p = x.properties || {}, N = namer(L);
  // sdr_name_deal and sdr_handoff_to_bdr_deal hold OWNER ids — the only
  // record of who actually worked a deal, whoever owns it
  const side = id => id ? N.rep(id) + (L.gone[id] ? " (left)" : "") : "not recorded";
  const hand = (p.sdr_name_deal || p.sdr_handoff_to_bdr_deal) ? side(p.sdr_name_deal) + " → " + side(p.sdr_handoff_to_bdr_deal) : null;
  return {
    k: recKey(T.deal, x.id), kd: "deal", id: String(x.id), t: T.deal,
    l: p.dealname || "Deal " + x.id, s: aed(p.amount) || "",
    c: isoOf(p.createdate), o: N.owner(p.hubspot_owner_id), cr: N.maker(p.hs_created_by_user_id),
    ci: cid ? [String(cid)] : [], hh: home,
    f: facts([["Amount", aed(p.amount)], ["Stage", L.dealStage[p.dealstage] || null], ["Pipeline", L.pipeline[p.pipeline] || null],
              ["Owner", N.owner(p.hubspot_owner_id) || "unowned"], ["SDR → BDR", hand], ["Admin-app key", p.admin_app_user__id]])
  };
}
export function dLead(x, cid, home, L){
  const p = x.properties || {}, N = namer(L);
  return {
    k: recKey(T.lead, x.id), kd: "lead", id: String(x.id), t: T.lead,
    l: p.hs_lead_name || "Lead " + x.id, s: "",
    c: isoOf(p.hs_createdate), o: N.owner(p.hubspot_owner_id), cr: N.maker(p.hs_created_by_user_id),
    ci: cid ? [String(cid)] : [], hh: home,
    f: facts([["Stage", L.leadStage[p.hs_pipeline_stage] || null], ["Owner", N.owner(p.hubspot_owner_id) || "unowned"],
              ["Created by", N.maker(p.hs_created_by_user_id)], ["Source", p.hs_lead_source]])
  };
}
// A record on its own, with no account around it (no home, not unattached).
export function shapeRecord(t, x, L){
  if (t === T.company) return dCompany(x, L);
  if (t === T.contact) return dContact(x, null, null, false, L);
  return t === T.deal ? dDeal(x, null, null, L) : dLead(x, null, null, L);
}
export const shapeOf = { [T.company]: dCompany, [T.contact]: dContact, [T.deal]: dDeal, [T.lead]: dLead };

// A record from the SQL copy alone (no live read): enough to draw it. No
// facts: the copy keeps no emails or phone numbers, so the page reads a
// record's details from HubSpot when it is opened.
export function dFromRow(r, L){
  const [t, id] = r.key.split("/");
  const kd = { [T.company]: "company", [T.contact]: "contact", [T.deal]: "deal", [T.lead]: "lead" }[t];
  const N = namer(L);
  const s = kd === "deal" ? (aed(r.amount) || "") : kd === "lead" ? "" : (r.sub || "");
  return { k: r.key, kd, id, t, l: r.label || (kd === "company" ? "Company " : kd === "contact" ? "Contact " : kd === "deal" ? "Deal " : "Lead ") + id, s,
           c: r.created_at || null, o: N.owner(r.owner_id), cr: N.maker(r.creator_id), ci: [], hh: kd === "company" ? r.key : null, f: [] };
}

// ---------------------------------------------------------------- SQL copy rows
export function toRow(t, x){
  const p = x.properties || {};
  const tails = [...new Set((t === T.contact ? [p.phone, p.mobilephone] : t === T.company ? [p.phone] : []).map(phoneTail).filter(Boolean))];
  const label = t === T.company ? p.name : t === T.contact ? contactName(x) : t === T.deal ? p.dealname : p.hs_lead_name;
  return {
    key: recKey(t, x.id), type: t, label: label || null,
    sub: t === T.company ? (p.domain || null) : t === T.contact ? (p.hs_object_source_label || null) : null,
    owner_id: p.hubspot_owner_id || null, creator_id: p.hs_created_by_user_id || null,
    stage: t === T.deal ? (p.dealstage || null) : t === T.lead ? (p.hs_pipeline_stage || null) : null,
    pipeline: t === T.deal ? (p.pipeline || null) : t === T.lead ? (p.hs_pipeline || null) : null,
    amount: t === T.deal ? (p.amount || null) : null,
    tails: tails.join(" ") || null,
    created_at: isoOf(p.createdate || p.hs_createdate),
    hs_updated_at: isoOf(x.updatedAt || p.hs_lastmodifieddate || p.lastmodifieddate)
  };
}
