// HubSpotGate: the one place that counts HubSpot calls, shared by every
// Worker invocation (a counter in KV would be eventually consistent, and
// wrong under load). Two token buckets:
//   general  batch reads, list pages, associations — the private app's own
//            limit is 190 per 10 s on Pro/Enterprise (100 on Starter); run
//            at 9/s so a burst from a walk never meets it
//   search   CRM search — 5/s per portal, SHARED by every integration, so 3/s
// A caller reserves n calls and is told how long to wait before using them.
// Tokens may go into debt; the next caller then waits for the debt too.
// A 429 pauses the whole bucket for as long as HubSpot asked.
import { DurableObject } from "cloudflare:workers";

const RATES = { general: { perSec: 9, burst: 18 }, search: { perSec: 3, burst: 3 } };
const DAILY_MAX = 150000;          // this app's share of the portal's daily allowance

export class HubSpotGate extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    this.b = {};
    for (const k of Object.keys(RATES)) this.b[k] = { tokens: RATES[k].burst, at: Date.now(), pausedUntil: 0 };
    this.day = null; this.used = 0; this.unsaved = 0;
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get("usage");
      if (saved){ this.day = saved.day; this.used = saved.used; }
    });
  }

  today(){ return new Date().toISOString().slice(0, 10); }

  async reserve(kind, n){
    const r = RATES[kind] || RATES.general, b = this.b[kind] || this.b.general;
    const now = Date.now();
    const d = this.today();
    if (d !== this.day){ this.day = d; this.used = 0; }
    if (this.used + n > DAILY_MAX) throw new Error("daily HubSpot budget for this app is spent; it resets at 00:00 UTC");
    this.used += n; this.unsaved += n;
    if (this.unsaved >= 100){ this.unsaved = 0; await this.ctx.storage.put("usage", { day: this.day, used: this.used }); }

    b.tokens = Math.min(r.burst, b.tokens + (now - b.at) / 1000 * r.perSec);
    b.at = now;
    b.tokens -= n;
    const debt = b.tokens < 0 ? -b.tokens / r.perSec * 1000 : 0;
    return Math.ceil(Math.max(debt, b.pausedUntil - now));
  }

  async penalize(kind, ms){
    const b = this.b[kind] || this.b.general;
    b.pausedUntil = Math.max(b.pausedUntil, Date.now() + ms);
  }

  async usage(){
    const d = this.today();
    return { day: d, calls: d === this.day ? this.used : 0, dailyMax: DAILY_MAX };
  }
}
