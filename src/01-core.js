(function(){
  "use strict";

  /* =====================================================================
     1. CONFIG
     ===================================================================== */
  // Which HubSpot account, and who is at the keys: both from the Worker once
  // signed in. The page is public, so it carries neither.
  let PORTAL = "";
  let OPERATOR = "—";
  // whether this person is one of the Atlas's editors, who may delete in
  // HubSpot from the map (section 16); the Worker checks it again on every call
  let CAN_EDIT = false;
  const REDUCED = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // Opening a record out: one request to the Worker, up to 40 records of
  // each other kind drawn, and at most 60 records per press of Expand
  // search · all. (A walk's own limits are the Worker's, and it says when
  // one is reached.)
  const EXPAND = { limit: 40, reads: 1, perPress: 60 };
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
    face: 75 * Math.PI / 180,       // a crowd facing one partner fits within this either side of it
    hiveGap: 56,                  // clear space between two hives
    treeX: 164, treeY: 100, treeSub: 64, treeWrap: 10, blockGap: 120,
    lodK: 0.8,                      // below this zoom, record names hide (held, hovered and neighbouring ones stay)
    lodSub: 1.2,                    // below this zoom, records' second lines hide
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

  // owner, user and stage names arrive already written on each record: the
  // Worker reads them from HubSpot, so the page carries no table of people
  // the portal is hosted in HubSpot's EU data centre, so its pages are on app-eu1
  const HS_APP = "https://app-eu1.hubspot.com";
  const recUrl = (t, id) => HS_APP + "/contacts/" + PORTAL + "/record/" + t + "/" + id;
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
     3. SERVICES — the store, the user and downloads come through
     window.claude.use (see 00-platform.js); HubSpot only through the
     Worker, which reads it in bulk, keeps its SQL copy, and paces every
     call itself. Nothing here talks to HubSpot directly.
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
  // An API call: a GET with no body, a POST with one. A failure carries the
  // Worker's error code (no_identity, unavailable, rate_limited, …).
  function api(path, body){
    if (!window.ATLAS) return Promise.reject({ code: "unavailable", message: "the page's platform did not load" });
    return window.ATLAS.api(path, body === undefined ? undefined : { body });
  }
  // A streamed call: one event per line, as the Worker sends them.
  function apiStream(path, body, onEvent){
    if (!window.ATLAS) return Promise.reject({ code: "unavailable" });
    return window.ATLAS.stream(path, body, onEvent);
  }
  // The address bar follows what is on screen (#/company/123, #/sql …),
  // without that counting as a navigation of its own.
  function routeTo(hash){ if (window.ATLAS) window.ATLAS.navigate(hash, { replace: true, silent: true }); }

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
