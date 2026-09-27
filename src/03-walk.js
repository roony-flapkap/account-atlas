
  /* =====================================================================
     7. RECORDS come from the Worker already shaped as the map keeps them
     (k kd id t l s c o cr ci hh f — see packNode), with owner, user and
     stage names written in. Values are RAW; they are escaped at render time.
     ===================================================================== */

  /* =====================================================================
     8. THE PROMPT — every accepted identifier is exact: a record id, an
     email, or the admin-app user id carried on a deal. No name matching.
     ===================================================================== */
  const UUID_RE  = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // A bare record id is the only ambiguous form; this says which it is.
  let IDMODE = "company";

  function resolveInput(raw){
    const q = String(raw || "").trim();
    if (!q) return null;
    const u = q.match(UUID_RE);
    if (u) return { kind: "adminKey", value: u[0].toLowerCase() };
    if (EMAIL_RE.test(q)) return { kind: "email", value: q.toLowerCase() };
    for (const [t, kind] of [["0-1", "contact"], ["0-2", "company"], ["0-3", "deal"]]){
      const m = q.match(new RegExp("/record/" + t + "/(\\d+)"));
      if (m) return { kind, value: m[1] };
    }
    if (/^\d{4,}$/.test(q)) return { kind: IDMODE === "contact" ? "contact" : "company", value: q };
    return null;
  }
  function hintFor(){
    // a bare number is a company here, so a deal is taken by its URL — the
    // hint used to offer "deal record id" and then read it as a company
    const base = IDMODE === "contact"
      ? "Contact record id &nbsp;·&nbsp; Email address &nbsp;·&nbsp; Record URL"
      : "Company record id &nbsp;·&nbsp; Deal or contact URL &nbsp;·&nbsp; Admin-app user id &nbsp;·&nbsp; Email";
    return base + " &nbsp;·&nbsp; Return to acquire" + (MAP.nodes.length ? " &nbsp;·&nbsp; Esc for the map" : "");
  }
  function setIdMode(m){
    IDMODE = m === "contact" ? "contact" : "company";
    document.querySelectorAll("[data-mode]").forEach(b =>
      b.setAttribute("aria-checked", b.getAttribute("data-mode") === IDMODE ? "true" : "false"));
    const ph = IDMODE === "contact" ? "ENTER EMAIL OR CONTACT ID" : "ENTER DESIGNATION";
    $("q").placeholder = ph; $("q2").placeholder = ph;
    $("ghint").innerHTML = hintFor();
    // the drawn cursor measures the placeholder while the field is empty
    $("q").dispatchEvent(new Event("input"));
  }
  function inputError(msg){
    // In the open map the gate is out of sight, so the refusal goes under
    // the search bar instead — before, it was written where nobody saw it.
    if (PHASE === "open"){
      const q = $("qerr");
      q.textContent = msg || "";
      if (msg){ const box = $("q2").parentNode; box.classList.add("qbad"); setTimeout(() => box.classList.remove("qbad"), 900); }
      return;
    }
    $("gerr").textContent = msg || "";
    if (msg && PHASE === "gate"){
      const f = $("q").parentNode;
      f.style.boxShadow = "0 0 38px rgba(224,167,60,.32)";
      setTimeout(() => { f.style.boxShadow = ""; }, 900);
    }
  }

  /* =====================================================================
     9. ACQUIRING — two outcomes and only two:
       already on the map -> nothing is re-walked, the VIEW TRAVELS to it
       not on the map     -> walk it, merge it, save it, then travel to it
     ===================================================================== */
  // One walk, re-walk or Forget at a time: each rebuilds the model the
  // others would be writing into.
  let ACQUIRING = false;
  let BOOT = null;                 // the restore from the store; a lookup waits for it

  function lookupFromInput(fromBar){
    const src = (fromBar && PHASE === "open") ? $("q2") : $("q");
    const raw = String(src.value || "").trim();
    if (!raw){ inputError("Enter a company record id or an admin-app user id."); if (PHASE !== "open") focusGate(); return; }
    const what = resolveInput(raw);
    if (!what){
      inputError(IDMODE === "contact"
        ? "Not a designation. In contact mode this takes an email address, a contact record id such as 100000000002, or a HubSpot record URL."
        : "Not a designation. Expected a company record id such as 100000000001, an admin-app user id such as " +
          "00000000-0000-4000-8000-000000000001, an email address, or a HubSpot record URL.");
      if (PHASE !== "open") focusGate();
      return;
    }
    inputError("");
    $("q").value = raw; $("q2").value = raw;
    acquire(what, { raw });
  }

  // `what` is always explicit here. Walk it and Re-walk used to go through
  // the text box, so in contact mode a company id was read as a contact.
  async function acquire(what, opts){
    opts = opts || {};
    // a lookup pasted while the map is still loading waits for it, or it
    // would re-walk an account that is already stored
    if (BOOT) await BOOT;
    if (ACQUIRING){
      // a segment run holds the lock for minutes; say so rather than ignore the press
      if (SEGJOB) inputError("A segment run is in progress. Stop it in Segments, or wait for it to finish.");
      return;
    }
    const cid = what.kind === "company" ? String(what.value) : null;
    if (cid && MAP.accounts[cid] && !opts.force){
      if (PHASE !== "open") await openMap();
      VIEW.travelTo(companyKey(cid), true);
      routeTo("company/" + cid);
      return;
    }
    ACQUIRING = true;
    try {
      await stopExpansions();
      VIEW.exitFull();               // a walk behind a fullscreen plot is a walk nobody sees
      const reopening = PHASE === "open";
      logReset();
      setPhase("run");
      if (reopening) await wait(720);
      logLine("SESSION <b>" + Math.random().toString(16).slice(2, 6).toUpperCase() + "-" +
              Math.random().toString(16).slice(2, 6).toUpperCase() + "</b> &middot; OPERATOR " + esc(OPERATOR));
      logLine("LINK &middot; ATLAS API &middot; HUBSPOT <b>READ-ONLY</b>");
      logLine("CANVAS &middot; <b>" + esc(CV.cur.name).toUpperCase() + "</b> &middot; " + CV.cur.scope.toUpperCase() +
              " &middot; <b>" + MAP.order.length + "</b> " + plural(MAP.order.length, "ACCOUNT") +
              " &middot; <b>" + fmt(MAP.nodes.length) + "</b> RECORDS HELD");
      await wait(140);
      logLine("QUERY &middot; <b>" + esc(opts.raw || what.value) + "</b>" + (opts.force ? " &middot; RE-WALK" : ""));
      logLine("PARSE &middot; " + ({ adminKey: "ADMIN-APP USER ID", email: "CONTACT EMAIL ADDRESS",
        contact: "CONTACT RECORD ID", deal: "DEAL RECORD ID" }[what.kind] || "COMPANY RECORD ID"));
      prog(4, "RESOLVING TARGET");
      await wait(170);
      const target = cid ? { id: cid, via: null } : await resolveCompany(what);
      if (!target) return;
      if (MAP.accounts[String(target.id)] && !opts.force){
        logLine("ALREADY ON THE MAP &middot; <b>" + esc(MAP.accounts[String(target.id)].name || target.id) + "</b> &middot; NOTHING RE-WALKED");
        prog(100, "TRAVELLING");
        await openMap();
        VIEW.travelTo(companyKey(target.id), true);
        routeTo("company/" + target.id);
        return;
      }
      await walkCompany(String(target.id), target.via, !!opts.force);
    } finally {
      ACQUIRING = false;
    }
  }

  // Resolve a contact, email, deal or admin-app key to its company: one call,
  // whose steps are told back into the console as they were taken.
  async function resolveCompany(what){
    let r;
    const sWait = logStep({ adminKey: "TRACE KEY THROUGH DEAL RECORDS", email: "MATCH ADDRESS TO A CONTACT",
                            contact: "READ CONTACT RECORD" }[what.kind] || "RESOLVE ACCOUNT FROM DEAL");
    try { r = await api("/api/resolve", { kind: what.kind, value: what.value }); }
    catch(err){
      stepEnd(sWait, "LINK ERROR", true);
      fail(err && err.code === "no_identity" ? "You are signed out. Sign in again, then acquire it."
         : "HubSpot could not answer that lookup" + (err && err.message ? " · " + esc(err.message) : "") + ".");
      return null;
    }
    // the first step is the one already on screen; the rest follow it
    (r.steps || []).forEach((s, i) => {
      const h = i === 0 ? sWait : logStep(esc(s.m));
      stepEnd(h, esc(s.note || ""), s.st === "err" ? true : s.st === "warn" ? "warn" : false);
    });
    if (!r.ok){ fail(esc(r.why || "Nothing matched.")); return null; }
    prog(10, "LOCATING ACCOUNT");
    if (r.many > 1) logLine("THAT CONTACT BELONGS TO <b>" + r.many + "</b> COMPANIES &middot; OPENING THE FIRST &middot; " +
                            "THE MAP WILL SHOW THE REST ONCE THEY ARE WALKED", "err");
    return { id: String(r.id), via: r.via || null };
  }

  /* =====================================================================
     10. THE WALK — one company: its records, how they link to each other,
     what they reach outside it, and who shares its numbers without a link.
     The Worker reads it (bulk reads, into its SQL copy) and streams each
     step as it goes; walkCore merges what comes back by RECORD and saves it.
     It reports through R, so the console walk and a segment's batch walk
     are the SAME walk:
       R.step(label) -> handle · R.ok(h, note) · R.end(h, note, bad)
       R.prog(pct, label) · R.line(html, cls)
     ===================================================================== */
  const CONSOLE_R = { step: logStep, ok: stepOk, end: stepEnd, prog, line: logLine };
  const QUIET_R = { step: () => null, ok(){}, end(){}, prog(){}, line(){} };

  // -> { ok, why?, name, touched, shared, saved, missed, mode, changes }; a
  // failure the walk cannot carry on from THROWS.
  // opts.mode: "auto" (from the Worker's copy where it holds the account
  // whole, live otherwise) or "live" (always HubSpot). opts.canvas: merge
  // only if that canvas is still the open one — a background walk must never
  // write into a canvas the reader has since switched to.
  async function walkCore(cid, R, opts){
    opts = opts || {};
    const touched = {}, edgeIds = {}, at = new Date().toISOString();
    const handles = new Map();
    let done = null, bad = null;
    await apiStream("/api/walk", { companyId: String(cid), mode: opts.mode || "auto" }, ev => {
      if (ev.t === "mode"){ if (ev.mode === "copy") R.line("LINK &middot; <b>SQL COPY</b> &middot; KEPT CURRENT FROM HUBSPOT &middot; NO HUBSPOT CALLS"); }
      else if (ev.t === "prog") R.prog(ev.pct, ev.label);
      else if (ev.t === "step") handles.set(ev.id, R.step(esc(ev.m)));
      else if (ev.t === "end") R.end(handles.get(ev.id), esc(ev.note || ""), ev.st === "err" ? true : ev.st === "warn" ? "warn" : false);
      else if (ev.t === "line") R.line(esc(ev.m), ev.cls);
      else if (ev.t === "done") done = ev;
      else if (ev.t === "error") bad = ev;
    });
    if (bad) throw { code: bad.code || "unavailable", message: bad.message };
    if (!done) throw { code: "unavailable", message: "the walk ended without an answer" };
    if (!done.ok) return { ok: false, why: done.why || "That company could not be read." };
    if (opts.canvas && !sameCanvas(opts.canvas, CV.cur)) return { ok: false, why: "the canvas changed while it was being read" };
    if (opts.onlyIfKept && !MAP.accounts[String(cid)]) return { ok: false, why: "it was taken off the map meanwhile" };

    // ---- merge, by record: a key already here gains edges, not a twin
    R.prog(90, "MERGING INTO THE MAP");
    // a record the walk read back is in HubSpot now, whatever was said of it before
    (done.nodes || []).forEach(d => { if (validRecord(d)){ const n = mergeNode(d, at); touched[n.key] = 1; n.gone = null; } });
    (done.edges || []).forEach(e => {
      if (!MAP.byKey[e.a] || !MAP.byKey[e.b] || ["member", "link", "detached"].indexOf(e.r) < 0) return;
      const ed = mergeEdge(e.a, e.b, e.r); if (ed){ edgeIds[ed.id] = 1; ed.gone = false; ed.fresh = false; }
    });
    reindex();
    const co = done.company || {};
    const capped = Array.isArray(done.capped) ? done.capped : [], missed = Number(done.missed) || 0;
    const prev = MAP.accounts[cid];
    MAP.accounts[cid] = { id: cid, name: co.name || "", domain: co.domain || "", walkedAt: new Date().toISOString(),
                          firstWalkedAt: (prev && prev.firstWalkedAt) || new Date().toISOString(), capped, trimmed: null, missed };
    uniqPush(MAP.order, cid);
    const sM = R.step("MERGE &middot; " + Object.keys(touched).length + " RECORDS");
    const shared = Object.keys(touched).filter(k => { const n = MAP.byKey[k]; return n && n.kind !== "company" && n.companyIds.length > 1; });
    R.ok(sM, shared.length ? shared.length + " ALSO ON ANOTHER ACCOUNT" : "NO OVERLAP WITH THE MAP");

    const sW = R.step("WRITE ACCOUNT DOCUMENT");
    const doc = accountDoc(cid, Object.keys(touched), Object.keys(edgeIds),
                           { name: co.name, domain: co.domain, capped, missed, first: MAP.accounts[cid].firstWalkedAt });
    MAP.accounts[cid].trimmed = doc.trimmed || null;
    const saved = await saveAccount(doc);
    if (saved.ok) R.ok(sW, "KEPT" + (doc.trimmed ? " · TRIMMED" : ""));
    else { R.end(sW, String(saved.why).toUpperCase(), true); R.line("THE MAP COULD NOT BE SAVED &middot; THIS WALK IS ON SCREEN ONLY", "err"); }
    if (done.stats) R.line((done.mode === "copy" ? "SQL COPY &middot; " : "HUBSPOT &middot; <b>" + fmt(done.stats.calls) + "</b> " + plural(done.stats.calls, "CALL") + " &middot; ") +
                           fmt(done.stats.ms) + "MS" + (done.changes ? " &middot; <b>" + done.changes + "</b> CHANGED SINCE THE LAST READ" : ""), done.changes ? "err" : "");
    return { ok: true, name: co.name || "", touched: Object.keys(touched).length, shared: shared.length, saved, missed,
             mode: done.mode || "live", changes: Number(done.changes) || 0 };
  }

  // The console walk: walkCore, then draw it and travel to it.
  async function walkCompany(cid, via, force){
    logLine("TARGET ACQUIRED &middot; <b>" + esc(cid) + "</b>" + (via ? " &middot; " + esc(via).toUpperCase() : ""));
    const hubKey = companyKey(cid);
    try {
      // a re-walk is a deliberate read of HubSpot; an ordinary walk takes the copy where it can
      const res = await walkCore(cid, CONSOLE_R, { mode: force ? "live" : "auto" });
      if (!res.ok){ fail(esc(res.why)); return; }
      // drawn from the copy: HubSpot is asked again quietly, and the map follows if it differs
      if (res.mode === "copy") setTimeout(() => backgroundCheck(cid), 400);
      // A re-walk rebuilds the map from the store, so records that have
      // since left the account leave the map too; merging alone never
      // removed anything.
      if (force && res.saved.ok){
        const sR = logStep("RELOAD MAP FROM STORE");
        const n = await rebuildFromStore();
        stepOk(sR, n + " " + plural(n, "ACCOUNT"));
      }
      prog(96, "DRAWING");
      await openMap();
      logLine("MAP &middot; <b>" + MAP.order.length + "</b> ACCOUNTS &middot; <b>" + fmt(MAP.nodes.length) +
              "</b> RECORDS" + (res.shared ? " &middot; <b>" + res.shared + "</b> SHARED" : ""), res.shared ? "err" : "");
      prog(100, "COMPLETE");
      VIEW.travelTo(hubKey, true);
      routeTo("company/" + cid);
    } catch(err){
      // a failure from the Worker carries a code; a bug in this page carries a stack
      const pageBug = !!(err && err.stack && !err.code);
      stepEnd(CON.open, pageBug ? "PAGE ERROR" : "WALK FAILED", true);
      // what a half-finished walk merged was never saved; put the map back
      // to what the store holds rather than show it as if it were
      if (DB_STATE.up){ try { await rebuildFromStore(); VIEW.refresh(); } catch(e){} }
      if (pageBug){
        logLine("THIS PAGE THREW WHILE WALKING &middot; <b>" + esc(String(err.name || "Error") + ": " + String(err.message || err)) + "</b>", "err");
        fail("Every read succeeded — the fault is in this page, not in HubSpot. Nothing already on the map was lost.");
      } else {
        fail(err && err.code === "no_identity" ? "You are signed out. Sign in again, then walk it."
          : "HubSpot could not complete the walk" + (err && err.message ? " · " + esc(err.message) : "") + ". Nothing already on the map was lost.");
      }
    }
  }
