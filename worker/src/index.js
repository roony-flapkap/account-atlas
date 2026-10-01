// The Atlas API. Every /api route but /api/session and /api/health needs a
// session token (see auth.js). /hooks/hubspot is HubSpot's, and is checked
// by its signature instead.

import { AuthError, verifyGoogleIdToken, mintSession, readSession } from "./auth.js";
import { StoreError, storeOp } from "./store.js";
import { HttpError } from "./errors.js";
import { HubSpotError } from "./hubspot.js";
import { SqlError, runSql } from "./sql.js";
import { walkAuto } from "./walk.js";
import { resolve, expand, recordsFresh, changesSince, searchSegments, segmentMembers, segmentMesh, tombstones, companiesOf } from "./api.js";
import { listFindings, runFinding } from "./findings.js";
import { canEdit, deletePlan, deleteRecords, unlinkPairs, unlinkAll } from "./edit.js";
import { handleHook } from "./hooks.js";
import { tick, syncStatus } from "./sync.js";
import { WS_PROTOCOL } from "./hub.js";
export { HubSpotGate } from "./gate.js";
export { ChangeHub } from "./hub.js";
export { HttpError };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function allowedOrigin(req, env){
  const o = req.headers.get("origin");
  if (!o) return null;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.indexOf(o) >= 0 ? o : false;
}
function withCors(res, origin){
  if (!origin || res.webSocket) return res;
  const h = new Headers(res.headers);
  h.set("access-control-allow-origin", origin);
  h.set("vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}
export const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
const failure = (status, code, message) => json({ error: { code, message: message || code } }, status);

async function readJson(req, max = 300000){
  const len = Number(req.headers.get("content-length") || 0);
  if (len > max) throw new HttpError(413, "too_large", "request body too large");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "too_large", "request body too large");
  try { return JSON.parse(text || "{}"); } catch(e){ throw new HttpError(400, "bad_json", "request body is not JSON"); }
}

export async function signedIn(req, env){
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  const user = m ? await readSession(m[1], env) : null;
  if (!user) throw new HttpError(401, "no_identity", "sign in with your @" + env.ALLOWED_DOMAIN + " Google account");
  return user;
}

function errorOf(e){
  if (e instanceof HttpError) return [e.status, e.code, e.message];
  if (e instanceof AuthError) return [401, e.code, e.message];
  if (e instanceof StoreError) return [400, e.code, e.message];
  if (e instanceof SqlError) return [e.code === "budget" ? 429 : 400, e.code, e.message];
  if (e instanceof HubSpotError) return [502, e.code, e.message];
  console.error(e && e.stack || e);
  return [500, "internal", "something went wrong on the server"];
}

// The walk, streamed: one JSON line per console event, as each happens.
function streamed(ctx, run){
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const say = o => { w.write(enc.encode(JSON.stringify(o) + "\n")).catch(() => {}); };
  ctx.waitUntil((async () => {
    try { say(Object.assign({ t: "done" }, await run(say))); }
    catch(e){ const [status, code, message] = errorOf(e); say({ t: "error", status, code, message }); }
    finally { try { await w.close(); } catch(e){} }
  })());
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

async function route(req, env, ctx){
  const url = new URL(req.url);
  const p = url.pathname, M = req.method;

  if (p === "/api/health") return json({ ok: true });
  if (p === "/hooks/hubspot" && M === "POST") return handleHook(req, env, ctx);

  if (p === "/api/session" && M === "POST"){
    const b = await readJson(req, 8000);
    const who = await verifyGoogleIdToken(b.credential, env);
    const s = await mintSession(who, env);
    ctx.waitUntil(env.APP.prepare("INSERT INTO audit (at, email, action) VALUES (?1, ?2, 'sign_in')")
      .bind(new Date().toISOString(), who.email).run().catch(() => {}));
    return json(s);
  }

  // the live channel: a browser cannot put a header on a WebSocket, so the
  // session token rides as a subprotocol, "bearer.<token>"
  if (p === "/api/live"){
    const protos = (req.headers.get("sec-websocket-protocol") || "").split(",").map(s => s.trim());
    const tok = protos.find(s => s.startsWith("bearer."));
    const user = tok ? await readSession(tok.slice(7), env) : null;
    if (!user) throw new HttpError(401, "no_identity", "sign in first");
    if (protos.indexOf(WS_PROTOCOL) < 0) throw new HttpError(400, "bad_protocol", "expected " + WS_PROTOCOL);
    const h = new Headers(req.headers); h.set("x-atlas-user", user.email);
    return env.HUB.get(env.HUB.idFromName("all")).fetch(new Request(req, { headers: h }));
  }

  if (!p.startsWith("/api/")) return failure(404, "not_found", "no such route");
  const user = await signedIn(req, env);
  let m;
  // the HubSpot account id is given out only after sign-in: the public page carries none;
  // canEdit says whether this person may delete in HubSpot (edit.js)
  if (p === "/api/me" && M === "GET") return json({ user, portal: env.PORTAL_ID || null, canEdit: canEdit(env, user) });
  if (p === "/api/db" && M === "POST") return json(await storeOp(env, user, await readJson(req)));

  if (p === "/api/walk" && M === "POST"){
    const b = await readJson(req, 2000);
    if (!/^\d{1,20}$/.test(String(b.companyId || ""))) throw new HttpError(400, "bad_input", "a company id is digits");
    // auto: from the copy where it holds the account whole, live otherwise; live: always HubSpot
    const mode = b.mode === "live" ? "live" : "auto";
    return streamed(ctx, say => walkAuto(env, b.companyId, say, { user, mode }));
  }
  if (p === "/api/resolve" && M === "POST") return json(await resolve(env, await readJson(req, 2000)));
  if (p === "/api/expand" && M === "POST"){ const b = await readJson(req, 2000); return json(await expand(env, b.key, b.limit)); }
  if (p === "/api/records" && M === "POST"){ const b = await readJson(req, 50000); return json(await recordsFresh(env, b.keys)); }
  if (p === "/api/tombstones" && M === "POST"){ const b = await readJson(req, 200000); return json(await tombstones(env, b.keys)); }
  if (p === "/api/changes" && M === "GET") return json(await changesSince(env, url.searchParams.get("since"), url.searchParams.get("limit")));
  if (p === "/api/segments" && M === "GET")
    return json(await searchSegments(env, url.searchParams.get("q"), (url.searchParams.get("types") || "").split(",").filter(Boolean)));
  if ((m = /^\/api\/segments\/(\d+)\/members$/.exec(p)) && M === "POST"){
    const b = await readJson(req, 4000);
    return json(await segmentMembers(env, m[1], { type: b.type, after: b.after || null }));
  }
  if (p === "/api/mesh" && M === "POST"){ const b = await readJson(req, 200000); return json(await segmentMesh(env, b.companyIds)); }
  if (p === "/api/sql" && M === "POST"){ const b = await readJson(req, 30000); return json(await runSql(env, user, b.sql)); }
  if (p === "/api/findings" && M === "GET") return json(await listFindings(env));
  if ((m = /^\/api\/findings\/([a-z0-9-]+)$/.exec(p)) && M === "POST"){ const b = await readJson(req, 2000); return json(await runFinding(env, user, m[1], { fresh: !!b.fresh })); }
  if (p === "/api/companies-of" && M === "POST"){ const b = await readJson(req, 300000); return json(await companiesOf(env, b.keys)); }
  if (p === "/api/sync/status" && M === "GET") return json(await syncStatus(env));
  // deleting from the map: the editors only, and only these two kinds of write
  if (p === "/api/edit/plan" && M === "POST"){ const b = await readJson(req, 2000); return json(await deletePlan(env, user, b.key)); }
  if (p === "/api/edit/delete" && M === "POST"){ const b = await readJson(req, 60000); return json(await deleteRecords(env, user, b.keys)); }
  if (p === "/api/edit/unlink" && M === "POST"){ const b = await readJson(req, 80000); return json(await unlinkPairs(env, user, b.pairs)); }
  if (p === "/api/edit/unlink-all" && M === "POST"){ const b = await readJson(req, 2000); return json(await unlinkAll(env, user, b.key)); }
  return failure(404, "not_found", "no such route");
}

export default {
  async fetch(req, env, ctx){
    const origin = allowedOrigin(req, env);
    const isHook = new URL(req.url).pathname === "/hooks/hubspot";
    // a browser on any other site is turned away before anything runs
    if (origin === false && !isHook) return failure(403, "bad_origin", "this site may not call the Atlas API");
    if (req.method === "OPTIONS"){
      return withCors(new Response(null, { status: 204, headers: {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400"
      } }), origin);
    }
    let res;
    try { res = await route(req, env, ctx); }
    catch(e){ const [status, code, message] = errorOf(e); res = failure(status, code, message); }
    return withCors(res, origin);
  },

  async scheduled(event, env, ctx){
    ctx.waitUntil(tick(env, { nightly: event.cron === "0 2 * * *" }).then(r => console.log(JSON.stringify(r)), e => console.error(e && e.stack || e)));
  }
};
