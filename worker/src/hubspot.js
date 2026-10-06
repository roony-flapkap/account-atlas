// HubSpot's REST API, with the private app's token. Every call takes a
// token from HubSpotGate first, so all Workers together stay under the
// portal's limits. Reads only — GET and the read-by-POST endpoints (batch
// read, search) — except for the writes in WRITES, which only a client made
// with { writes: true } can send, for the editors: archiving records and
// removing the associations between two records (edit.js), and making a
// static list and adding records to it (lists.js). No record is ever
// created, edited or merged.

const BASE = "https://api.hubapi.com";
// the REST paths accept object type ids, which is what record keys carry
export const T = { contact: "0-1", company: "0-2", deal: "0-3", lead: "0-136" };
export const KIND_OF = { "0-1": "contact", "0-2": "company", "0-3": "deal", "0-136": "lead" };
const READ_POSTS = [/\/batch\/read$/, /\/search$/];
const WRITES = [
  ["POST", /^\/crm\/v3\/objects\/0-\d+\/batch\/archive$/],
  ["POST", /^\/crm\/v4\/associations\/0-\d+\/0-\d+\/batch\/archive$/],
  ["POST", /^\/crm\/v3\/lists$/],
  ["PUT", /^\/crm\/v3\/lists\/\d+\/memberships\/add$/]
];

// sub: HubSpot's subCategory, where it gives one (e.g. ILS.DUPLICATE_LIST_NAMES)
export class HubSpotError extends Error {
  constructor(status, code, message, sub){ super(message || code); this.status = status; this.code = code; this.sub = sub || null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

// Runs async jobs at most `width` at a time (the runtime allows 6 open
// connections per invocation; the gate is what keeps the rate down).
export async function pool(items, width, fn){
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length){ const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

export function hubspotClient(env, opts = {}){
  const gate = env.GATE ? env.GATE.get(env.GATE.idFromName("portal")) : null;
  const stats = { calls: 0, search: 0, retries: 0, waitedMs: 0 };
  // calls already paid for at the gate, spent before asking it again
  const credit = { general: 0, search: 0 };

  // Reserve n calls of a kind before making them; one round trip to the
  // gate per batch of calls, because every round trip is a subrequest too.
  async function reserve(kind, n){
    if (!gate || !n) return;
    const take = Math.min(credit[kind] || 0, n);
    credit[kind] = (credit[kind] || 0) - take;
    if (n - take <= 0) return;
    const wait = await gate.reserve(kind, n - take);
    if (wait > 0){ stats.waitedMs += wait; await sleep(wait); }
  }
  // A walk knows roughly what it will spend: paying once up front saves a
  // round trip to the gate at every step.
  async function prepay(kind, n){
    if (!gate || !n) return;
    const wait = await gate.reserve(kind, n);
    credit[kind] = (credit[kind] || 0) + n;
    if (wait > 0){ stats.waitedMs += wait; await sleep(wait); }
  }

  async function call(method, path, body, kind = "general", reserved = false){
    if (method !== "GET" && !(method === "POST" && READ_POSTS.some(re => re.test(path))))
      throw new HubSpotError(0, "not_read_only", "refusing a HubSpot call that could write: " + method + " " + path);
    return send(method, path, body, kind, reserved);
  }
  // the writes in WRITES, and only for a client made to send them
  async function write(path, body, method = "POST"){
    if (!opts.writes || !WRITES.some(([m, re]) => m === method && re.test(path)))
      throw new HubSpotError(0, "not_allowed", "refusing a HubSpot write: " + method + " " + path);
    return send(method, path, body, "general", false);
  }

  async function send(method, path, body, kind, reserved){
    if (!env.HUBSPOT_TOKEN) throw new HubSpotError(0, "no_token", "HUBSPOT_TOKEN is not set");
    if (!reserved) await reserve(kind, 1);
    for (let attempt = 0; ; attempt++){
      stats.calls++; if (kind === "search") stats.search++;
      let res;
      try {
        // HUBSPOT_BASE is set only by local runs (a synthetic HubSpot on this machine); never in production
        res = await (opts.fetch || fetch)((env.HUBSPOT_BASE || BASE) + path, {
          method,
          headers: { authorization: "Bearer " + env.HUBSPOT_TOKEN, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20000)
        });
      } catch(e){
        if (attempt < 1){ stats.retries++; await sleep(800); continue; }
        throw new HubSpotError(0, "unreachable", "HubSpot did not answer");
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      if (res.status === 429 && attempt < 3){
        // HubSpot says how long; the whole gate pauses, not just this call
        const ra = Number(res.headers.get("retry-after"));
        const ms = ra > 0 ? ra * 1000 : 1000 * (attempt + 1);
        stats.retries++;
        if (gate) await gate.penalize(kind, ms);
        await sleep(ms);
        continue;
      }
      if (res.status >= 500 && attempt < 1){ stats.retries++; await sleep(1000); continue; }
      let msg = "", sub = null; try { const j = await res.json(); msg = j.message || j.category || ""; sub = j.subCategory || null; } catch(e){}
      throw new HubSpotError(res.status, res.status === 429 ? "rate_limited" : res.status === 401 ? "bad_token"
        : res.status === 403 ? "missing_scope" : res.status === 404 ? "not_found" : "hubspot_error", msg || ("HubSpot answered " + res.status), sub);
    }
  }

  // Records by id, 100 a call. Missing or archived ids are simply absent.
  async function batchRead(type, ids, properties){
    ids = [...new Set(ids.map(String))];
    if (!ids.length) return [];
    const parts = chunk(ids, 100);
    await reserve("general", parts.length);
    const pages = await pool(parts, 4, p => call("POST", "/crm/v3/objects/" + type + "/batch/read",
      { inputs: p.map(id => ({ id })), properties }, "general", true));
    return pages.flatMap(r => (r && r.results) || []);
  }

  // Associations by id, 1,000 a call: Map<fromId, [{ id, typeId, label }]>.
  // Unlike the connector's search, this says WHICH input each result is
  // linked to — the gap that cost one search per contact before.
  async function assoc(from, to, ids){
    ids = [...new Set(ids.map(String))];
    const out = new Map(ids.map(id => [id, []]));
    if (!ids.length) return out;
    const parts = chunk(ids, 1000);
    await reserve("general", parts.length);
    const pages = await pool(parts, 3, p => call("POST", "/crm/v4/associations/" + from + "/" + to + "/batch/read",
      { inputs: p.map(id => ({ id })) }, "general", true));
    const more = [];
    for (const r of pages) for (const row of (r && r.results) || []){
      const id = String(row.from && row.from.id);
      const list = out.get(id) || [];
      for (const x of row.to || []) list.push(link(x));
      out.set(id, list);
      if (row.paging && row.paging.next && row.paging.next.after) more.push([id, row.paging.next.after]);
    }
    // an input with more than a page of associations continues one by one
    for (let [id, after] of more){
      while (after){
        const r = await call("GET", "/crm/v4/objects/" + from + "/" + id + "/associations/" + to + "?limit=500&after=" + encodeURIComponent(after));
        for (const x of (r && r.results) || []) out.get(id).push(link(x));
        after = r && r.paging && r.paging.next && r.paging.next.after;
      }
    }
    return out;
  }
  const link = x => {
    const t = (x.associationTypes || []).find(a => a.label) || (x.associationTypes || [])[0] || {};
    return { id: String(x.toObjectId), typeId: t.typeId == null ? null : Number(t.typeId), label: t.label || null };
  };

  const search = (type, body) => call("POST", "/crm/v3/objects/" + type + "/search", body, "search");

  // A page of every record of a type, in id order, 100 at a time.
  async function listPage(type, properties, after, extra = ""){
    const q = "limit=100&properties=" + encodeURIComponent(properties.join(",")) + (after ? "&after=" + encodeURIComponent(after) : "") + extra;
    const r = await call("GET", "/crm/v3/objects/" + type + "?" + q);
    return { results: (r && r.results) || [], after: r && r.paging && r.paging.next && r.paging.next.after || null };
  }

  const client = { call, batchRead, assoc, search, listPage, reserve, prepay, stats };
  if (!opts.writes) return client;

  // Records archived, 100 a call: HubSpot keeps them in its recycle bin for
  // 90 days. Archiving is idempotent, so a retried call does no harm.
  async function archive(type, ids){
    for (const p of chunk([...new Set(ids.map(String))], 100))
      await write("/crm/v3/objects/" + type + "/batch/archive", { inputs: p.map(id => ({ id })) });
  }
  // Every association (all labels) between each pair: [[fromId, toId], …].
  async function unlink(from, to, pairs){
    const by = new Map();
    for (const [a, b] of pairs){ if (!by.has(String(a))) by.set(String(a), []); by.get(String(a)).push(String(b)); }
    const inputs = [];
    for (const [a, list] of by) for (const p of chunk(list, 100)) inputs.push({ from: { id: a }, to: p.map(id => ({ id })) });
    for (const p of chunk(inputs, 100)) await write("/crm/v4/associations/" + from + "/" + to + "/batch/archive", { inputs: p });
  }
  // A static list, empty: HubSpot answers { list: { listId, … } }. A name
  // already taken is refused (400, subCategory ILS.DUPLICATE_LIST_NAMES).
  const createList = (name, type) => write("/crm/v3/lists", { name, objectTypeId: type, processingType: "MANUAL" });
  // Records into a static list by id. HubSpot answers { recordsIdsAdded (sic),
  // recordIdsMissing }, leaving out whichever is empty; one call took 100,000
  // ids when tried, so the caller's size is what limits it.
  const addToList = (listId, ids) => write("/crm/v3/lists/" + listId + "/memberships/add", ids.map(String), "PUT");
  return Object.assign(client, { archive, unlink, createList, addToList });
}
