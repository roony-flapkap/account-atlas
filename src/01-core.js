(function(){
  "use strict";

  /* =====================================================================
     1. CONFIG
     ===================================================================== */
  /*@@TABLES@@*/
  // Which HubSpot account, and who is at the keys: both from the Worker once
  // signed in. The page is public, so it carries neither.
  let PORTAL = "";
  let OPERATOR = "—";
  const REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // What one walk may spend. 200 is HubSpot's ceiling on a search page; the
  // rest are API calls against a shared daily quota, and a walk that hits
  // one says so in its console and on the account's own entry.
  const CAP = { obj: 200, link: 40, leadDeal: 20, foreign: 16, probe: 5 };
  // Opening a record out: 3 reads of up to 40 results each, and at most 60
  // records per press of Expand search · all.
  const EXPAND = { limit: 40, reads: 3, perPress: 60 };
  // a walk older than this reads as a museum piece rather than a picture
  const STALE_MS = 14 * 86400000;
  // A document is capped at 256 KiB; leave headroom for the envelope.
  const DOC_BYTES = 240000;

  // Plot geometry, in world units (1 unit = 1 screen px at zoom 1).
  const G = {
    r: 8, rCo: 14, rStub: 9,        // marker radii
    charW: 5.8,                     // one label character at 8.5px mono
    ringChars: 22, treeChars: 20, coChars: 26,
    arc: 24,                        // ring spacing per member
    ringMin: 70,
    hiveGap: 56,                    // clear space between two hives
    treeX: 164, treeY: 100, treeSub: 64, treeWrap: 10, blockGap: 120,
    lodK: 0.5,                      // below this zoom, record labels hide
    kMin: 0.05, kMax: 6
  };
  const GOLDEN = 2.399963229728653;

  /* =====================================================================
     2. UTILITIES
     ===================================================================== */
  const $ = id => document.getElementById(id);
  const SVGNS = "http://www.w3.org/2000/svg";
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmt = n => (n == null || isNaN(n)) ? "—" : Number(n).toLocaleString("en-US");
  const f1 = v => (Math.round(v * 10) / 10).toString();
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const trunc = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const uniqPush = (arr, v) => { if (v != null && arr.indexOf(v) < 0) arr.push(v); return arr; };
  const plural = (n, one, many) => n === 1 ? one : (many || one + "s");
  const wait = ms => new Promise(r => setTimeout(r, REDUCED ? 0 : ms));
  // a real pause, for pacing and retries — wait() is theatre and skips for reduced motion
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const now = () => (window.performance && performance.now) ? performance.now() : Date.now();
  const bytes = s => (window.TextEncoder ? new TextEncoder().encode(s).length : s.length * 3);

  const owner = id => id ? (OWNERS[id] || "owner " + id) : null;
  const repPlain = id => id ? (GONE[id] || OWNERS[id] || "owner " + id) : null;
  const maker = id => id ? (USERS[id] || "user " + id) : null;
  const dealStage = id => (id && STAGES.dealStage[id]) || null;
  const leadStage = id => (id && STAGES.leadStage[id]) || null;
  const pipeName = id => (id && STAGES.pipeline[id]) || null;
  const recUrl = (t, id) => "https://app.hubspot.com/contacts/" + PORTAL + "/record/" + t + "/" + id;
  const recKey = (t, id) => t + "/" + id;
  const companyKey = id => recKey("0-2", id);

  function when(ts){ if (!ts) return null; const d = new Date(ts); return isNaN(d) ? null : d; }
  function isoOf(v){ const d = when(v); return d ? d.toISOString() : null; }
  function dstr(d){
    if (!d) return "—";
    const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return d.getUTCDate() + " " + m[d.getUTCMonth()] + " " + d.getUTCFullYear() + "  " +
           String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  }
  function ago(ts){
    const d = when(ts); if (!d) return "never";
    const mins = Math.round(Math.max(0, Date.now() - d.getTime()) / 60000);
    if (mins < 2) return "just now";
    if (mins < 90) return mins + "m ago";
    const hrs = Math.round(mins / 60);
    return hrs < 36 ? hrs + "h ago" : Math.round(hrs / 24) + "d ago";
  }
  const isStale = ts => !!ts && (Date.now() - new Date(ts).getTime() > STALE_MS);
  const phoneTail = s => { const d = String(s || "").replace(/[^0-9]/g, ""); return d.length >= 9 ? d.slice(-9) : d; };

  /* =====================================================================
     3. SERVICES — each resolves null when this view cannot run it, and
     nothing blocks the first paint on any of them.
     ===================================================================== */
  const cap = {};
  function use(name){
    if (!cap[name]){
      cap[name] = Promise.resolve()
        .then(() => (window.claude && window.claude.use) ? window.claude.use(name) : null)
        .catch(() => null);
    }
    return cap[name];
  }
  // Long runs (a segment's batch walk, its mesh) set a gap between calls:
  // the portal's search limit is five a second, SHARED by every integration
  // searching it, so a run keeps well under it. Single walks do not wait.
  const PACE = { gap: 0, last: 0 };
  async function hubspot(args){
    const ns = await use("mcp");
    if (!ns) throw { code: "no_connector" };
    const call = async () => {
      if (PACE.gap){ const w = PACE.last + PACE.gap - Date.now(); if (w > 0) await sleep(w); }
      PACE.last = Date.now();
      return ns.callTool("HubSpot", "search_crm_objects", Object.assign({
        chatInsights: { userIntent: "Map how the accounts in this portal connect to each other", satisfaction: "NEUTRAL" }
      }, args));
    };
    let r;
    try { r = await call(); }
    catch(e){
      // One retry, and only for a failure the platform stamps as worth
      // repeating (HubSpot throttling arrives as one). Everything else is
      // the caller's to report. These are all reads, so a repeat is safe.
      if (!(e && e.retryable === true)) throw e;
      await sleep(Math.min(60000, Number(e.retryAfterMs) || 1200 + Math.random() * 1600));
      r = await call();
    }
    return (r && r.payload) ? r.payload : r;
  }
  // Every page of one search, up to `max` rows. HubSpot pages by offset and
  // stops at 10,000 results for any one query.
  async function hubspotAll(args, max, onPage){
    const out = [], lim = Math.min(200, args.limit || 200);
    let offset = 0, total = null;
    while (out.length < max){
      const r = await hubspot(Object.assign({}, args, { limit: lim }, offset ? { offset } : {}));
      const rows = (r && r.results) || [];
      if (r && r.total != null) total = Number(r.total);
      rows.forEach(x => out.push(x));
      if (onPage) onPage(out.length, total);
      const next = r && r.offset != null ? Number(r.offset) : NaN;
      if (rows.length < lim || !(next > offset) || next >= 10000) break;
      offset = next;
    }
    return { rows: out.slice(0, max), total };
  }
  // An association filter takes at most 100 ids, so a longer list is read
  // in slices and the answers merged. Sent whole, 150 contacts made both
  // outside-the-account reads fail — silently, as "self-contained".
  async function byAssoc(objectType, fromType, ids, properties, limit, op){
    const out = [], seen = new Set();
    for (let i = 0; i < ids.length; i += 100){
      const slice = ids.slice(i, i + 100);
      const r = await hubspot({
        objectType,
        filterGroups: [{ associatedWith: [{ objectType: fromType, operator: op === "IN" || slice.length > 1 ? "IN" : "EQUAL",
                                           objectIdValues: slice.map(Number) }] }],
        properties, limit
      });
      ((r && r.results) || []).forEach(x => { if (!seen.has(String(x.id))){ seen.add(String(x.id)); out.push(x); } });
    }
    return out;
  }

  /* =====================================================================
     4. THE DECK AND ITS CONSOLE
       gate  a bare field    run  the console, doors shut    open  the map
     ===================================================================== */
  const ROOT = document.documentElement;
  let PHASE = "";
  function setPhase(p, state){
    PHASE = p;
    ROOT.setAttribute("data-phase", p);
    if (state) ROOT.setAttribute("data-state", state); else ROOT.removeAttribute("data-state");
    if (p === "gate"){
      $("ghint").innerHTML = hintFor();
      paintGateMap();
      setTimeout(focusGate, 80);
    }
  }
  function focusGate(){ try { $("q").focus(); $("q").select(); } catch(e){} }

  // A walk is a sequence of real calls, so it is logged as one: each step
  // opens live, then closes with its own elapsed time and what it returned.
  const CON = { log: [], cap: 19, pct: 0, label: "", seq: 0, painted: 0, open: null };
  function clock(){
    const d = new Date();
    return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map(v => String(v).padStart(2, "0")).join(":");
  }
  function meter(pct){
    const cells = 26, on = clamp(Math.round(cells * pct / 100), 0, cells);
    return "█".repeat(on) + "░".repeat(cells - on);
  }
  function paintLog(){
    let html = "", high = CON.painted;
    if (CON.log.length){
      html = '<div class="clog">' + CON.log.map((l, i) => {
        const live = l.st === "run" && i === CON.log.length - 1;
        // the console repaints in full, so only a line never painted types in
        const fresh = l.n > CON.painted;
        if (l.n > high) high = l.n;
        let token = l.st === "ok" ? "[ OK ]" : l.st === "err" ? "[ FAIL ]" : l.st === "warn" ? "[ !! ]" : l.st === "run" ? "[ ·· ]" : "";
        if (l.ms != null) token += "  " + l.ms + "MS";
        return '<div class="cline' + (l.st ? " " + l.st : "") + (live ? " now" : "") + (fresh ? " fresh" : "") + '">' +
               '<span class="t">' + esc(l.t) + "</span>" +
               '<span class="m">' + l.m + (l.note ? ' <span class="nt">· ' + l.note + "</span>" : "") + "</span>" +
               '<span class="st">' + esc(token) + "</span></div>";
      }).join("") + "</div>" +
      '<div class="pbar"><span class="fill">' + meter(CON.pct) + "</span>" +
      '<span class="pct">' + String(Math.round(CON.pct)).padStart(3, "0") + "%</span>" +
      '<span class="pl">' + esc(CON.label) + "</span></div>";
    }
    document.querySelectorAll("[data-console]").forEach(b => { b.innerHTML = html; });
    CON.painted = high;
  }
  function logPush(o){
    o.t = clock(); o.n = ++CON.seq;
    CON.log.push(o);
    if (CON.log.length > CON.cap) CON.log.shift();
    paintLog();
    return o;
  }
  // `msg` is markup: every caller escapes what it did not write itself
  const logLine = (msg, cls, live) => logPush({ m: msg, st: cls === "err" ? "err" : (live ? "run" : "") });
  const logStep = msg => (CON.open = logPush({ m: msg, st: "run", t0: now() }));
  // `bad` is true for a failure, or "warn" for a step that worked and found
  // something worth seeing — which used to be printed as a FAIL
  function stepEnd(o, note, bad){
    if (!o) return;
    o.st = bad === "warn" ? "warn" : bad ? "err" : "ok";
    if (o.t0 != null) o.ms = Math.round(now() - o.t0);
    if (note) o.note = note;
    if (CON.open === o) CON.open = null;
    paintLog();
  }
  const stepOk = (o, note) => stepEnd(o, note, false);
  function prog(pct, label){ CON.pct = pct; if (label != null) CON.label = label; paintLog(); }
  function logReset(){ CON.log = []; CON.pct = 0; CON.label = ""; CON.open = null; paintLog(); }

  // A failed walk leaves the console up so the reason stays readable, and
  // puts the prompt back underneath it.
  function fail(html){
    logLine(String(html), "err");
    if (PHASE !== "run") return;
    prog(CON.pct, "HALTED");
    logLine("AWAITING NEW DESIGNATION", "", true);
    setPhase("run", "error");
    setTimeout(focusGate, 120);
  }
