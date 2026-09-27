// HubSpot's REST API, read-only, with the private app's token. Every call
// takes a token from HubSpotGate first, so all Workers together stay under
// the portal's limits. Nothing here writes to HubSpot: only GET and the
// read-by-POST endpoints (batch read, search) are ever used.

const BASE = "https://api.hubapi.com";
// the REST paths accept object type ids, which is what record keys carry
export const T = { contact: "0-1", company: "0-2", deal: "0-3", lead: "0-136" };
export const KIND_OF = { "0-1": "contact", "0-2": "company", "0-3": "deal", "0-136": "lead" };
const READ_POSTS = [/\/batch\/read$/, /\/search$/];

export class HubSpotError extends Error {
  constructor(status, code, message){ super(message || code); this.status = status; this.code = code; }
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

  // Reserve n calls of a kind before making them; one round trip to the
  // gate per batch of calls, because every round trip is a subrequest too.
  async function reserve(kind, n){
    if (!gate || !n) return;
    const wait = await gate.reserve(kind, n);
    if (wait > 0){ stats.waitedMs += wait; await sleep(wait); }
  }

  async function call(method, path, body, kind = "general", reserved = false){
    if (method !== "GET" && !(method === "POST" && READ_POSTS.some(re => re.test(path))))
      throw new HubSpotError(0, "not_read_only", "refusing a HubSpot call that could write: " + method + " " + path);
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
      let msg = ""; try { const j = await res.json(); msg = j.message || j.category || ""; } catch(e){}
      throw new HubSpotError(res.status, res.status === 429 ? "rate_limited" : res.status === 401 ? "bad_token"
        : res.status === 403 ? "missing_scope" : res.status === 404 ? "not_found" : "hubspot_error", msg || ("HubSpot answered " + res.status));
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

  return { call, batchRead, assoc, search, listPage, reserve, stats };
}
