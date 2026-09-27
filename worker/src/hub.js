// ChangeHub: open pages hold a WebSocket here and hear about CRM changes as
// they land (a webhook, the 15-minute read, a walk that found something
// different). Hibernating sockets cost nothing while nothing happens. A page
// that was away catches up from /api/changes?since=<seq> instead: the socket
// only ever says "these just happened, up to seq N".
import { DurableObject } from "cloudflare:workers";

export const WS_PROTOCOL = "atlas.v1";

export class ChangeHub extends DurableObject {
  async fetch(req){
    if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ email: req.headers.get("x-atlas-user") || null, at: Date.now() });
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": WS_PROTOCOL } });
  }

  async broadcast(message){
    let n = 0;
    for (const ws of this.ctx.getWebSockets()){ try { ws.send(message); n++; } catch(e){} }
    return n;
  }

  async listeners(){
    return this.ctx.getWebSockets().map(ws => (ws.deserializeAttachment() || {}).email).filter(Boolean);
  }

  async webSocketMessage(ws, msg){
    if (msg === "ping") ws.send("pong");
  }
  async webSocketClose(ws, code){ try { ws.close(code, "bye"); } catch(e){} }
}

// Tells every open page. Never fails the caller: the changes are already
// written, and a page that missed the push reads them on its next catch-up.
export async function announce(env, last, changes){
  if (!env.HUB || !changes || !changes.length) return 0;
  try {
    const hub = env.HUB.get(env.HUB.idFromName("all"));
    const slim = changes.slice(0, 300).map(c => ({ kind: c.kind, key: c.key, other: c.other || null, at: c.at || null }));
    return await hub.broadcast(JSON.stringify({ t: "changes", last, more: changes.length > slim.length, changes: slim }));
  } catch(e){ return 0; }
}
