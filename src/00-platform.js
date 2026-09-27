/* =====================================================================
   0. THE PLATFORM — what the page stands on now that it is a site of its
   own: Google sign-in, the session, the Worker's API, the live change
   feed and the #/ routes. It also answers window.claude.use("db" | "user"
   | "downloads") the way the artifact runtime did, so the canvas code
   carried over unchanged. Everything the page learns comes from the
   Worker, and only after a sign-in it accepts.
   ===================================================================== */
(function(){
  "use strict";
  const CFG = Object.assign({ api: "", googleClientId: "" }, window.ATLAS_CONFIG || {});
  const API = String(CFG.api || "").replace(/\/+$/, "");
  const SKEY = "atlas.session.v1";
  const GIS = "https://accounts.google.com/gsi/client";
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const store = {
    get(k){ try { return JSON.parse(localStorage.getItem(k) || "null"); } catch(e){ return null; } },
    set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} },
    del(k){ try { localStorage.removeItem(k); } catch(e){} }
  };

  let session = store.get(SKEY);                 // { token, user }
  if (session && !(session.token && session.user && Date.parse(session.user.expiresAt) > Date.now() + 60000)) session = null;
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });
  const ATLAS = window.ATLAS = { config: CFG, me: null, ready, api, stream, signOut, onChanges, navigate, onRoute, route: null };

  /* ---------------- the API ---------------- */
  function fail(status, code, message){ const e = new Error(message || code); e.status = status; e.code = code; return e; }
  async function call(path, opts){
    opts = opts || {};
    if (!API) throw fail(0, "not_configured", "the site has no API address yet");
    const headers = {};
    if (session) headers.authorization = "Bearer " + session.token;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res;
    try {
      res = await fetch(API + path, { method: opts.method || (opts.body !== undefined ? "POST" : "GET"), headers,
                                      body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal });
    } catch(e){ throw fail(0, "unavailable", "the Atlas API could not be reached"); }
    if (res.status === 401){
      // the session ran out or was refused: sign in again
      if (session){ session = null; store.del(SKEY); showSignIn("Your session ended. Sign in again to carry on."); }
    }
    return res;
  }
  async function api(path, opts){
    const res = await call(path, opts);
    let data = null;
    try { data = await res.json(); } catch(e){}
    if (!res.ok){
      const er = (data && data.error) || {};
      throw fail(res.status, er.code || (res.status === 401 ? "no_identity" : "unavailable"), er.message || ("the API answered " + res.status));
    }
    return data;
  }
  // A streamed answer: one JSON object per line, handed over as each arrives.
  async function stream(path, body, onEvent){
    const res = await call(path, { body });
    if (!res.ok){
      let data = null; try { data = await res.json(); } catch(e){}
      const er = (data && data.error) || {};
      throw fail(res.status, er.code || "unavailable", er.message);
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;){
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0){
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line){ let ev; try { ev = JSON.parse(line); } catch(e){ continue; } onEvent(ev); }
      }
      if (done) break;
    }
    if (buf.trim()){ try { onEvent(JSON.parse(buf)); } catch(e){} }
  }

  /* ---------------- sign-in ---------------- */
  let gisLoaded = null;
  function loadGis(){
    if (gisLoaded) return gisLoaded;
    gisLoaded = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = GIS; s.async = true; s.onload = res; s.onerror = () => rej(fail(0, "unavailable", "Google sign-in could not be loaded"));
      document.head.appendChild(s);
    });
    return gisLoaded;
  }
  function overlay(){
    let el = document.getElementById("signin");
    if (el) return el;
    el = document.createElement("div");
    el.id = "signin"; el.className = "sgnin"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-labelledby", "sgnt");
    el.innerHTML =
      '<div class="sgnbox frame">' +
        '<p class="sgnk">FlapKap · HubSpot · Read-only</p>' +
        '<h2 id="sgnt">Account Atlas</h2>' +
        '<p class="sgnl">Sign in with your FlapKap Google account. Only verified <b>@flapkap.com</b> accounts are let in; the map and everything behind it stay with the Worker until you are.</p>' +
        '<div id="sgnbtn" class="sgnbtn"></div>' +
        '<p class="sgnnote" id="sgnnote" role="status" aria-live="polite"></p>' +
      "</div>";
    document.body.appendChild(el);
    return el;
  }
  const note = t => { const n = document.getElementById("sgnnote"); if (n) n.textContent = t || ""; };
  async function showSignIn(msg){
    document.documentElement.classList.add("sgnon");
    overlay();
    note(msg || "");
    if (!API || !CFG.googleClientId){ note("This site is not set up yet: its config has no " + (!API ? "API address" : "Google sign-in client") + "."); return; }
    try {
      await loadGis();
      google.accounts.id.initialize({
        client_id: CFG.googleClientId, callback: onCredential, hd: "flapkap.com",
        auto_select: true, cancel_on_tap_outside: false, use_fedcm_for_prompt: true, context: "signin"
      });
      const host = document.getElementById("sgnbtn");
      host.innerHTML = "";
      google.accounts.id.renderButton(host, { theme: "filled_black", size: "large", shape: "rectangular", text: "signin_with", logo_alignment: "left", width: 280 });
      google.accounts.id.prompt();
    } catch(e){ note(e.message || "Google sign-in could not be started."); }
  }
  async function onCredential(r){
    note("Checking…");
    try {
      const res = await fetch(API + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: r.credential }) });
      const data = await res.json().catch(() => null);
      if (!res.ok){
        const code = data && data.error && data.error.code;
        note(code === "wrong_domain" ? "That account is not a FlapKap one. Sign in with your @flapkap.com Google account."
           : code === "unverified" ? "That address is not verified with Google."
           : "Sign-in was refused" + (data && data.error ? ": " + data.error.message : "") + ".");
        return;
      }
      session = { token: data.token, user: data.user };
      store.set(SKEY, session);
      await start();
    } catch(e){ note("The Atlas API could not be reached. Try again in a moment."); }
  }
  function hideSignIn(){
    document.documentElement.classList.remove("sgnon");
    const el = document.getElementById("signin"); if (el) el.remove();
  }
  function signOut(){
    try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch(e){}
    session = null; store.del(SKEY);
    location.reload();
  }

  async function start(){
    try {
      const me = await api("/api/me");
      ATLAS.me = { user: me.user, portal: me.portal || "" };
      hideSignIn();
      readyResolve(ATLAS.me);
      live();
    } catch(e){
      if (e.code === "no_identity") return;       // showSignIn is already up
      showSignIn("The Atlas API could not be reached. Reload to try again.");
    }
  }

  /* ---------------- live changes ----------------
     A WebSocket to the Worker says as soon as something changes in the
     CRM; every (re)connect first catches up from the last seq this browser
     saw, so nothing is missed while the page was closed or offline. If the
     socket cannot be held, the feed is read once a minute instead. */
  const LISTEN = new Set();
  const seqKey = () => "atlas.seq." + (ATLAS.me ? ATLAS.me.user.uid : "");
  let lastSeq = 0, ws = null, backoff = 2000, pollT = null, pingT = null, catching = null;
  function onChanges(fn){ LISTEN.add(fn); return () => LISTEN.delete(fn); }
  function deliver(batch){ LISTEN.forEach(fn => { try { fn(batch); } catch(e){ console.error(e); } }); }
  function remember(seq){ if (seq > lastSeq){ lastSeq = seq; store.set(seqKey(), seq); } }
  function catchUp(){
    if (catching) return catching;
    catching = (async () => {
      try {
        for (let i = 0; i < 20; i++){
          const r = await api("/api/changes?since=" + lastSeq + "&limit=500");
          if (r.changes.length) deliver({ changes: r.changes, last: r.last, catchup: true });
          remember(r.last);
          if (r.changes.length < 500) break;
        }
      } catch(e){} finally { catching = null; }
    })();
    return catching;
  }
  function live(){
    const saved = store.get(seqKey());
    // the first visit starts from now: history before it is not "new"
    ATLAS.since = typeof saved === "number" ? saved : null;
    lastSeq = typeof saved === "number" ? saved : 0;
    (ATLAS.since == null ? api("/api/changes?since=0&limit=1").then(r => { remember(r.head); ATLAS.since = r.head; }).catch(() => {}) : Promise.resolve())
      .then(connect);
  }
  function connect(){
    if (!session || !("WebSocket" in window)){ poll(); return; }
    let sock;
    try { sock = new WebSocket(API.replace(/^http/, "ws") + "/api/live", ["atlas.v1", "bearer." + session.token]); }
    catch(e){ poll(); return; }
    ws = sock;
    sock.onopen = () => { backoff = 2000; clearInterval(pollT); pollT = null; catchUp();
                          clearInterval(pingT); pingT = setInterval(() => { try { sock.send("ping"); } catch(e){} }, 45000); };
    sock.onmessage = ev => {
      if (ev.data === "pong") return;
      let m; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if (!m || m.t !== "changes") return;
      // a gap (missed pushes) or a trimmed batch: read the feed instead
      if (m.more || (m.last - m.changes.length > lastSeq)) catchUp();
      else { deliver({ changes: m.changes, last: m.last, catchup: false }); remember(m.last); }
    };
    sock.onclose = () => {
      clearInterval(pingT);
      if (ws !== sock) return;
      ws = null; poll();
      setTimeout(connect, backoff); backoff = Math.min(60000, backoff * 2);
    };
  }
  function poll(){ if (!pollT) pollT = setInterval(catchUp, 60000); }

  /* ---------------- routes ----------------
     #/                      the gate
     #/company/<id>          an account: travel to it, or walk it
     #/canvas/<scope>/<id>   a canvas
     #/sql  ·  #/changes     the SQL console · what changed */
  const ROUTES = new Set();
  function parse(){
    const h = String(location.hash || "").replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean).map(decodeURIComponent);
    return { name: parts[0] || "", args: parts.slice(1), hash: "#/" + h };
  }
  function onRoute(fn){ ROUTES.add(fn); return () => ROUTES.delete(fn); }
  function navigate(hash, opts){
    const h = "#/" + String(hash || "").replace(/^#?\/?/, "");
    if (location.hash === h) return;
    if (opts && opts.replace) history.replaceState(null, "", h); else history.pushState(null, "", h);
    if (!(opts && opts.silent)) fire();
  }
  function fire(){ ATLAS.route = parse(); ROUTES.forEach(fn => { try { fn(ATLAS.route); } catch(e){ console.error(e); } }); }
  window.addEventListener("hashchange", fire);
  window.addEventListener("popstate", fire);
  ATLAS.route = parse();

  /* ---------------- window.claude.use, as the artifact runtime had it ---------------- */
  const E = e => { const x = { code: e.code || "unavailable", message: e.message }; return x; };
  const dbOp = body => api("/api/db", { body }).catch(e => { throw E(e); });
  function snap(id, exists, data){ return { id, exists, data: () => data === undefined ? undefined : JSON.parse(JSON.stringify(data)), metadata: {} }; }
  function docRef(path){
    const id = path.split("/").pop();
    return {
      id, path,
      get: () => dbOp({ op: "get", path }).then(r => snap(id, !!r.exists, r.exists ? r.data : undefined)),
      set: data => dbOp({ op: "set", path, data }).then(() => undefined),
      update: data => dbOp({ op: "update", path, data }).then(() => undefined),
      delete: () => dbOp({ op: "delete", path }).then(() => undefined),
      collection: sub => colRef(path + "/" + sub)
    };
  }
  function colRef(path){
    let n = 1000;
    const q = {
      path,
      limit(k){ n = k; return q; },
      doc: id => docRef(path + "/" + (id || Date.now().toString(36) + Math.random().toString(36).slice(2))),
      get: () => dbOp({ op: "list", path, limit: n }).then(r => {
        const docs = (r.docs || []).map(d => snap(d.id, true, d.data));
        return { docs, size: docs.length, empty: !docs.length };
      })
    };
    return q;
  }
  const DB = { doc: docRef, collection: colRef };
  const USER = { id: async () => (await ready).user.uid, isOwner: () => false, canEdit: () => true };
  const DOWNLOADS = {
    async save(o){
      const url = URL.createObjectURL(o.data);
      const a = document.createElement("a");
      a.href = url; a.download = o.filename || "download"; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: "saved" };
    }
  };
  window.claude = {
    async use(name){
      if (name === "downloads") return DOWNLOADS;
      await ready;
      return name === "db" ? DB : name === "user" ? USER : null;
    }
  };

  /* ---------------- boot ---------------- */
  if (session) start(); else showSignIn();
})();
