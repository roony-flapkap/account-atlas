
  /* =====================================================================
     14. THE PAGE AROUND THE MAP
     ===================================================================== */
  const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const VIEW = createView($("atlas"), {
    viewChanged: scheduleViewSave,
    expanded: (node, r) => saveExpansion(node, r),
    needFacts: n => fetchFacts(n),
    fileTag: () => CV.cur ? slug(CV.cur.name) : ""
  });

  let SAVE_NOTE = "";
  function paintDbChip(){
    const chip = $("chipDb"), txt = $("chipDbTxt");
    const name = CV.cur ? CV.cur.name : "Map";
    chip.className = "chip cvchip" + (!DB_STATE.known ? "" : DB_STATE.up && !SAVE_NOTE ? " on" : " warnc");
    if (!DB_STATE.known) txt.textContent = name + " · checking…";
    else if (!DB_STATE.up) txt.textContent = name + " · not saved · " + DB_STATE.why;
    else {
      const n = MAP.order.length;
      txt.textContent = name + (CV.cur && CV.cur.scope === "private" ? " · private" : "") + " · " +
                        n + " " + plural(n, "account") + " · " + fmt(MAP.nodes.length) + " records" + (SAVE_NOTE ? " · " + SAVE_NOTE : "");
    }
    const g = $("gcvname");
    if (g) g.textContent = name + (CV.cur && CV.cur.scope === "private" ? " · private" : "");
    paintSegChip();
  }
  // HubSpot, through the Worker: whether it answers, and how far its SQL
  // copy of the CRM has filled
  async function paintHsChip(){
    const chip = $("chipHs"), txt = $("chipHsTxt");
    try {
      const s = await api("/api/sync/status");
      const c = (s && s.copy) || {}, kinds = ["companies", "contacts", "deals", "leads"];
      const all = kinds.every(k => c[k] && c[k].done);
      const n = kinds.reduce((t, k) => t + ((c[k] && c[k].records) || 0), 0);
      chip.className = "chip on";
      txt.textContent = "HubSpot · read-only · " + (all ? "SQL copy complete" : "SQL copy filling · " + fmt(n) + " records");
      chip.title = kinds.map(k => k + " " + fmt((c[k] || {}).records || 0) + ((c[k] || {}).done ? " (all)" : "")).join(" · ") +
        (s.today ? " · today " + fmt(s.today.sync_writes) + " of " + fmt(s.today.writeBudget) + " rows written" : "");
    } catch(e){
      chip.className = "chip off";
      txt.textContent = "HubSpot · " + (e && e.code === "no_identity" ? "sign in" : "not reachable");
    }
  }
  // what the canvas already holds, so the gate is never blank over work done
  function paintGateMap(){
    const p = $("gmapline"), c = mapCounts();
    paintDbChip();
    const segs = MAP.segOrder.length;
    if (!c.records){
      p.innerHTML = DB_STATE.known && !DB_STATE.up ? "The map cannot be saved in this view — walks will not be kept"
                                                    : "This canvas is empty · acquire a company or import a segment to start it";
      return;
    }
    p.innerHTML = "<b>" + c.accounts + "</b> " + plural(c.accounts, "account") + (segs ? " &nbsp;·&nbsp; <b>" + segs + "</b> " + plural(segs, "segment") : "") +
                  " on this canvas &nbsp;·&nbsp; <b>" + fmt(c.records) + "</b> records" + (c.shared ? " &nbsp;·&nbsp; <b>" + c.shared + "</b> on more than one" : "");
  }

  // the accounts on this canvas, newest walk first, each a way in
  function renderRoster(){
    const host = $("roster");
    if (!MAP.order.length){ host.innerHTML = ""; return; }
    const rows = MAP.order.map(cid => MAP.accounts[cid]).filter(Boolean)
      .sort((a, b) => String(b.walkedAt || "").localeCompare(String(a.walkedAt || "")))
      .map(a => '<button type="button" class="rz' + (isStale(a.walkedAt) ? " stale" : "") + '" data-goto="' + esc(companyKey(a.id)) + '">' +
                '<span class="rn">' + esc(a.name || "Company " + a.id) + "</span>" +
                '<span class="rd">walked <b>' + esc(ago(a.walkedAt)) + "</b>" +
                (a.capped && a.capped.length ? " · capped" : "") + (a.trimmed ? " · trimmed" : "") + "</span></button>").join("");
    host.innerHTML = '<div class="sh"><h2>On this canvas</h2><p class="hint">' + MAP.order.length + " " + plural(MAP.order.length, "account") +
      " walked on <b>" + esc(CV.cur ? CV.cur.name : "this canvas") + "</b>. Press one to travel to it — nothing is re-read. " +
      "A walk older than a fortnight is marked; hold the company and press <b>Re-walk</b> to refresh it.</p></div>" +
      '<div class="roster frame">' + rows + "</div>";
  }

  // The doors only part once the map is built behind them: the seam is
  // struck first and runs out to both edges, and only then do they move.
  async function openMap(){
    renderRoster();
    VIEW.refresh();
    paintDbChip();
    if (PHASE === "open") return;
    await wait(200);
    const o = logStep("OPEN");
    await wait(240);
    setPhase("run", "arm");
    await wait(620);
    stepOk(o, "MAP ON SCREEN");
    setPhase("open", "arm");
    window.scrollTo(0, 0);
  }

  // Forgetting an account forgets its DOCUMENT, and other documents may
  // still name the same records — so the canvas is rebuilt from what is
  // left, which is the only version of this that cannot leave an orphan.
  async function dropAccount(cid){
    if (ACQUIRING) return;
    ACQUIRING = true;
    try {
      await stopExpansions();
      if (!(await forgetAccount(cid))){ paintDbChip(); return; }
      VIEW.resetPositions();
      await rebuildFromStore();
      await pruneExpansions();         // what was opened out of records that left with it
      writeMeta(CV.cur, { count: MAP.order.length }).catch(() => {});
      renderRoster();
      VIEW.refresh({ fit: true });
      paintGateMap();
    } finally { ACQUIRING = false; }
  }

  /* ---------------- saving the arrangement ----------------
     Every change to the arrangement — a drag, a layout, a filter, the
     camera — is saved with the canvas a moment after it settles. */
  let viewTimer = null, viewPaused = false;
  function scheduleViewSave(){
    // while a canvas is being moved, its old record is about to go
    if (!DB_STATE.up || !CV.cur || viewPaused) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(saveViewNow, 1200);
  }
  async function saveViewNow(){
    clearTimeout(viewTimer); viewTimer = null;
    const c = CV.cur;
    if (!c || !DB_STATE.up) return;
    try { await writeMeta(c, { view: VIEW.getViewState() }); if (SAVE_NOTE){ SAVE_NOTE = ""; paintDbChip(); } }
    catch(e){ SAVE_NOTE = "arrangement not saved"; paintDbChip(); }
  }
  async function flushViewSave(){ if (viewTimer) await saveViewNow(); }

  /* ---------------- opening a canvas ---------------- */
  async function openCanvas(c){
    if (BOOT) await BOOT;               // never two loads racing into one map
    if (ACQUIRING){ cvNote("A walk is running — wait for it to finish, then switch."); return false; }
    ACQUIRING = true;
    try {
      await stopExpansions();
      await flushViewSave();
      CV.cur = c; SAVE_NOTE = "";
      rememberCanvas(c);
      VIEW.setViewState(c.view);
      const n = await loadCanvas(c);
      markTombstones();
      closeCanvasPanel();
      renderRoster(); paintGateMap();
      // a canvas holding only a segment's field is not empty
      if (n || MAP.nodes.length){
        if (PHASE !== "open"){
          logReset(); setPhase("run");
          logLine("CANVAS &middot; <b>" + esc(c.name).toUpperCase() + "</b> &middot; " + c.scope.toUpperCase());
          logLine("RECORDS &middot; <b>" + fmt(MAP.nodes.length) + "</b> &middot; LINKS &middot; <b>" + fmt(MAP.edges.length) + "</b>");
          prog(100, "CANVAS OPEN");
          await openMap();
        } else VIEW.refresh();
      } else {
        VIEW.refresh();
        logReset(); setPhase("gate");
      }
      return true;
    } finally { ACQUIRING = false; }
  }

  /* ---------------- the canvases panel ---------------- */
  const CVF = { mode: "new", src: null, scope: "shared" };   // the form at the foot of the panel
  const cvNote = msg => { const n = $("cvnote"); if (n) n.textContent = msg || ""; };
  async function openCanvasPanel(){
    const p = $("cvpanel");
    p.hidden = false;
    ROOT.classList.add("cvon");
    paintCanvasPanel();
    if (BOOT){ cvNote("Loading canvases…"); await BOOT; }
    cvNote(DB_STATE.up ? "Loading canvases…" : "Canvases need the page's store, which is not available in this view.");
    if (DB_STATE.up){ await listCanvases(); cvNote(""); }
    paintCanvasPanel();
    const cur = p.querySelector(".cvrow.cur .cvopen");
    (cur || $("cvname")).focus();
  }
  function closeCanvasPanel(){
    $("cvpanel").hidden = true;
    if ($("segpanel").hidden) ROOT.classList.remove("cvon");
    setForm("new");
  }
  function setForm(mode, src){
    CVF.mode = mode; CVF.src = src || null;
    CVF.scope = src ? src.scope : "shared";
    if (CVF.scope === "private" && !CV.uid) CVF.scope = "shared";
    $("cvformlab").textContent = mode === "dup" ? "Duplicate “" + src.name + "” as" : "New canvas";
    $("cvname").value = mode === "dup" ? cvName(src.name + " copy") : "";
    $("cvgo").textContent = mode === "dup" ? "Duplicate" : "Create";
    $("cvcancel").hidden = mode !== "dup";
    paintScope();
  }
  function paintScope(){
    document.querySelectorAll("[data-scope]").forEach(b => {
      b.setAttribute("aria-checked", String(b.getAttribute("data-scope") === CVF.scope));
      if (b.getAttribute("data-scope") === "private"){
        b.disabled = !CV.uid;
        b.title = CV.uid ? "Only you will see it" : "Private canvases need you signed in to this page's organization";
      }
    });
  }
  function paintCanvasPanel(){
    const row = c => {
      const cur = sameCanvas(c, CV.cur);
      const bits = [c.count != null ? c.count + " " + plural(c.count, "account") : null,
                    c.updatedAt ? "saved " + ago(c.updatedAt) : null, cur ? "open now" : null].filter(Boolean);
      return '<div class="cvrow' + (cur ? " cur" : "") + '" data-cid="' + esc(c.id) + '" data-cs="' + c.scope + '">' +
        '<span class="cvname"><button type="button" class="cvopen" data-cv="open">' + esc(c.name) + "</button></span>" +
        '<span class="cvtag ' + c.scope + '">' + c.scope + "</span>" +
        '<span class="cvmeta">' + esc(bits.join(" · ")) + "</span>" +
        '<span class="cvacts">' + (cur ? "" : '<button type="button" class="act" data-cv="open">Open</button>') +
          '<button type="button" class="act" data-cv="rename">Rename</button>' +
          '<button type="button" class="act" data-cv="dup">Duplicate</button>' +
          (c.scope === "private" ? '<button type="button" class="act" data-cv="share" title="Move it to the shared list: everyone the page is shared with can open and change it">Share with everyone</button>' : "") +
          (isMain(c) ? "" : '<button type="button" class="act" data-cv="delete">Delete</button>') +
        "</span></div>";
    };
    const shared = CV.list.filter(c => c.scope === "shared"), mine = CV.list.filter(c => c.scope === "private");
    $("cvlist").innerHTML =
      '<p class="cvsec">Shared · everyone the page is shared with</p>' + shared.map(row).join("") +
      '<p class="cvsec">Private · only you</p>' +
      (mine.length ? mine.map(row).join("") : '<p class="cvnone">' + (CV.uid ? "No private canvases yet." : "Not available — you are not signed in to this page's organization.") + "</p>");
    paintScope();
  }
  const rowCanvas = el => { const r = el.closest(".cvrow"); return r ? CV.list.find(c => c.id === r.getAttribute("data-cid") && c.scope === r.getAttribute("data-cs")) : null; };

  async function cvAction(b){
    const act = b.getAttribute("data-cv"), c = rowCanvas(b);
    if (act === "close"){ closeCanvasPanel(); return; }
    if (act === "cancel"){ setForm("new"); return; }
    if (!c) return;
    if (act === "open"){ if (!sameCanvas(c, CV.cur)) await openCanvas(c); else closeCanvasPanel(); return; }
    if (act === "dup"){ setForm("dup", c); $("cvname").focus(); $("cvname").select(); return; }
    if (act === "rename"){
      const slot = b.closest(".cvrow").querySelector(".cvname");
      slot.innerHTML = '<input class="cvedit" maxlength="60" aria-label="Canvas name"><button type="button" class="act go" data-cv="save">Save</button>' +
                       '<button type="button" class="act" data-cv="undo">Cancel</button>';
      const inp = slot.querySelector("input");
      inp.value = c.name; inp.focus(); inp.select();
      return;
    }
    if (act === "undo"){ paintCanvasPanel(); return; }
    if (act === "save"){
      const name = cvName(b.closest(".cvrow").querySelector(".cvedit").value);
      if (!name){ cvNote("A canvas needs a name."); return; }
      try { await writeMeta(c, { name }); cvNote(""); } catch(e){ cvNote("Could not rename it — " + why(e) + "."); }
      paintCanvasPanel(); paintDbChip(); if (sameCanvas(c, CV.cur)) renderRoster();
      return;
    }
    if (act === "share"){
      // it makes private work visible to everyone the page is shared with, so it asks twice
      if (!b.classList.contains("arm")){
        b.classList.add("arm"); b.textContent = "Press again · everyone with the page will see it";
        setTimeout(() => { if (b.isConnected){ b.classList.remove("arm"); b.textContent = "Share with everyone"; } }, 4000);
        return;
      }
      if (ACQUIRING){ cvNote("A walk or a segment run is going — wait for it to finish."); return; }
      const wasCur = sameCanvas(c, CV.cur);
      ACQUIRING = true;
      let res = null;
      try {
        if (wasCur){ await stopExpansions(); await flushViewSave(); viewPaused = true; }
        res = await shareCanvas(c, wasCur ? VIEW.getViewState() : c.view,
          (stage, i, n) => cvNote((stage === "copy" ? "Copying “" : "Clearing the private copy of “") + c.name + "” · " + i + " of " + n));
      } catch(e){
        cvNote(e && e.code === "quota_exceeded" ? "The page’s store is full — delete a canvas you no longer need, then try again. “" + c.name + "” is still private."
             : "Could not share it — " + why(e) + ". It is still private.");
      } finally { ACQUIRING = false; viewPaused = false; }
      if (!res){ paintCanvasPanel(); return; }
      if (wasCur) await openCanvas(res.dst);
      cvNote(res.leftover ? "“" + c.name + "” is shared, but its private copy could not be cleared — delete that one from the list."
                          : "“" + c.name + "” is shared: everyone the page is shared with can now open and change it.");
      paintCanvasPanel();
      return;
    }
    if (act === "delete"){
      // destructive, and nothing brings a canvas back, so it asks twice
      if (!b.classList.contains("arm")){
        b.classList.add("arm"); b.textContent = "Press again to delete";
        setTimeout(() => { if (b.isConnected){ b.classList.remove("arm"); b.textContent = "Delete"; } }, 4000);
        return;
      }
      if (ACQUIRING){ cvNote("A walk is running — wait for it to finish."); return; }
      const wasCur = sameCanvas(c, CV.cur);
      if (wasCur) await stopExpansions();
      try {
        await deleteCanvas(c, (i, n) => cvNote("Deleting “" + c.name + "” · " + i + " of " + n));
        cvNote("Deleted “" + c.name + "”.");
      } catch(e){ cvNote("Could not delete it — " + why(e) + "."); return; }
      if (wasCur) await openCanvas(CV.list.find(isMain));
      paintCanvasPanel();
    }
  }
  async function cvSubmit(){
    const name = cvName($("cvname").value);
    if (!name){ cvNote("Give the canvas a name."); $("cvname").focus(); return; }
    if (!DB_STATE.up){ cvNote("Canvases need the page's store, which is not available in this view."); return; }
    if (ACQUIRING){ cvNote("A walk is running — wait for it to finish."); return; }
    $("cvgo").disabled = true;
    try {
      let c;
      if (CVF.mode === "dup"){
        const src = CVF.src;
        if (sameCanvas(src, CV.cur)) await flushViewSave();
        c = await duplicateCanvas(src, name, CVF.scope, sameCanvas(src, CV.cur) ? VIEW.getViewState() : src.view,
                                  (i, n) => cvNote("Copying “" + src.name + "” · " + i + " of " + n));
      } else c = await createCanvas(name, CVF.scope, {});
      cvNote("");
      await openCanvas(c);
    } catch(e){
      cvNote(e && e.code === "no_identity" ? "Private canvases need you signed in to this page's organization."
           : e && e.code === "quota_exceeded" ? "The page's store is full — delete a canvas you no longer need, then try again."
           : "Could not make the canvas — " + why(e) + ".");
    } finally { $("cvgo").disabled = false; }
  }

  /* ---------------- the segments panel ---------------- */
  const SGS = { view: "list", q: "", type: "all", rows: [], total: null, loading: false, err: "", sel: null,
                arm: null, armT: null, logs: {}, seq: 0 };
  const sgNote = msg => { $("sgnote").textContent = msg || ""; };
  const TYPEWORD = { "0-2": "companies", "0-1": "contacts", "0-3": "deals" };
  const JOBWORD = { drop: "Dropping in", refresh: "Refreshing", scan: "Finding shared people", trace: "Tracing people", walk: "Walking", remove: "Removing" };
  const dur = ms => { const s = Math.round(ms / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s"; };

  function paintSegChip(){
    const c = $("chipSeg"), t = $("chipSegTxt"), g = $("gsegtxt");
    const n = MAP.segOrder.length;
    let txt = "Segments" + (n ? " · " + n + " on this canvas" : "");
    if (SEGJOB) txt = "Segments · " + (JOBWORD[SEGJOB.kind] || "Working").toLowerCase() + (SEGJOB.of ? " " + fmt(SEGJOB.n) + "/" + fmt(SEGJOB.of) : "") + "…";
    if (t) t.textContent = txt;
    if (c) c.classList.toggle("live", !!SEGJOB);
    if (g) g.textContent = n ? n + " on this canvas" : "import one";
  }
  async function openSegPanel(){
    const p = $("segpanel");
    p.hidden = false;
    ROOT.classList.add("cvon");
    sgNote("");
    paintSegPanel();
    if (SGS.view === "list"){
      if (!SGS.rows.length && !SGS.loading) runSegSearch();
      setTimeout(() => { try { $("sgq").focus(); } catch(e){} }, 30);
    }
  }
  function closeSegPanel(){ $("segpanel").hidden = true; if ($("cvpanel").hidden) ROOT.classList.remove("cvon"); }
  let sgTimer = null;
  function queueSegSearch(){ clearTimeout(sgTimer); sgTimer = setTimeout(runSegSearch, 350); }
  async function runSegSearch(){
    const seq = ++SGS.seq;
    SGS.loading = true; SGS.err = ""; paintSegList();
    try {
      const types = SGS.type === "all" ? ["0-2", "0-1", "0-3"] : [SGS.type];
      const r = await searchSegments(SGS.q.trim(), types);
      if (seq !== SGS.seq) return;                 // a later search has overtaken this one
      SGS.rows = r.rows; SGS.total = r.total;
    } catch(e){
      if (seq !== SGS.seq) return;
      SGS.rows = []; SGS.total = null;
      SGS.err = e && e.code === "no_identity" ? "You are signed out, so segments cannot be searched. Sign in again."
              : "HubSpot could not answer the search · " + why(e) + ".";
    } finally { if (seq === SGS.seq){ SGS.loading = false; paintSegList(); } }
  }
  function segBadge(id){
    const st = segStats(id);
    return st ? '<span class="sgon">on this canvas · ' + fmt(st.members) + "</span>" : "";
  }
  function paintSegList(){
    const name = CV.cur ? CV.cur.name : "this canvas";
    $("sglede").innerHTML = "Import a HubSpot segment onto <b>" + esc(name) + "</b>. Its companies land in a field under the map, unwalked. " +
      "Then find the people they share, or walk them in batches of " + SEGWALK + ". Contact and deal segments come in as the companies they are on. " +
      "HubSpot is only read.";
    const mine = MAP.segOrder.map(id => MAP.segments[id]).filter(Boolean);
    $("sgmine").innerHTML = mine.length
      ? '<p class="cvsec">On this canvas</p>' + mine.map(sg => {
          const st = segStats(sg.id);
          const bits = [fmt(st.members) + " " + (st.members === 1 ? "company" : "companies"), fmt(st.walked) + " walked", fmt(st.linked) + " linked",
                        sg.mesh && sg.mesh.pending.length ? fmt(sg.mesh.pending.length) + " people to trace" : null].filter(Boolean);
          return '<div class="cvrow sgrow" data-sgid="' + esc(sg.id) + '" data-mine="1"><span class="cvname"><button type="button" class="cvopen" data-sg="open">' +
                 esc(sg.name) + '</button></span><span class="cvtag">' + esc(TYPEWORD[sg.type]) + '</span><span class="cvmeta">' + esc(bits.join(" · ")) +
                 '</span><span class="cvacts"><button type="button" class="act" data-sg="open">Open</button></span></div>';
        }).join("")
      : "";
    document.querySelectorAll("[data-sgt]").forEach(b => b.setAttribute("aria-checked", String(b.getAttribute("data-sgt") === SGS.type)));
    const res = $("sgres");
    if (SGS.err){ res.innerHTML = '<p class="cvnone bad">' + esc(SGS.err) + "</p>"; return; }
    if (SGS.loading && !SGS.rows.length){ res.innerHTML = '<p class="cvnone">Searching…</p>'; return; }
    const head = '<p class="cvsec">' + (SGS.q.trim() ? "Matching “" + esc(SGS.q.trim()) + "”" : "Recently updated") +
                 (SGS.total != null ? " · " + fmt(SGS.total) + (SGS.total > SGS.rows.length ? ", first " + SGS.rows.length + " shown" : "") : "") +
                 (SGS.loading ? " · searching…" : "") + "</p>";
    res.innerHTML = head + (SGS.rows.length ? SGS.rows.map(r =>
      '<div class="cvrow sgrow" data-sgid="' + esc(r.id) + '"><span class="cvname"><button type="button" class="cvopen" data-sg="open">' + esc(r.name) +
      '</button></span><span class="cvtag">' + esc(TYPEWORD[r.type]) + '</span><span class="cvmeta">' + esc(fmt(r.size) + " " + (r.size === 1 ? "member" : "members") +
      " · " + (r.live ? "live" : "static") + (r.updated ? " · updated " + ago(r.updated) : "")) + " " + segBadge(r.id) +
      '</span><span class="cvacts"><button type="button" class="act" data-sg="open">Open</button></span></div>').join("")
      : '<p class="cvnone">No segment matches. Segments are searched by name.</p>');
  }
  // once a segment is on the canvas, its last read is the better word on its name and size
  function selMeta(){
    const s = SGS.sel, m = s && MAP.segments[s.id];
    return s ? (m ? Object.assign({}, s, { name: m.name, size: m.size || s.size, live: m.live }) : s) : null;
  }
  function paintSegDetail(){
    const meta = selMeta(), host = $("sgdetail");
    if (!meta){ host.innerHTML = ""; return; }
    const seg = MAP.segments[meta.id], st = segStats(meta.id), busy = segBusy(), mineRunning = SEGJOB && SEGJOB.seg.id === meta.id;
    const tooBig = meta.size > SEGCAP;
    const armed = k => SGS.arm === meta.id + ":" + k;
    const btn = (k, label, cost, on, extra) => '<button type="button" class="act' + (k === "walk" || k === "drop" || k === "scan" ? " go" : "") +
      (armed(k) ? " arm" : "") + '" data-sg="' + k + '"' + (on && !busy ? "" : " disabled") + ">" +
      esc(armed(k) ? "Press again · " + label : label) + (cost != null ? ' <span class="sgcost">· ' + esc(cost) + "</span>" : "") + "</button>" + (extra || "");
    const reads = n => "about " + fmt(n) + " HubSpot " + plural(n, "call");
    let steps = "";
    // 1 · drop in / refresh
    steps += '<div class="sgstep"><span class="sgn">1</span><div class="sgsd"><b>' + (seg ? "Refresh the members" : "Drop in") + "</b><span>" +
      (seg ? "Read the segment again: who joined is added, who left is taken off." + (seg.refreshedAt || seg.importedAt ? " Last read " + esc(ago(seg.refreshedAt || seg.importedAt)) + "." : "")
           : "Its " + (meta.type === "0-2" ? "companies" : "members’ companies") + " land in a field under the map, not walked yet." +
             (tooBig ? " Only the first " + fmt(SEGCAP) + " of " + fmt(meta.size) + " are read." : "")) +
      "</span></div>" + btn("drop", seg ? "Refresh" : "Drop in", reads(segCost(meta, "drop")), meta.size > 0) + "</div>";
    // 2 · mesh
    let meshBtn, meshTxt;
    if (!seg) { meshTxt = "After it is dropped in: find the people on more than one of its companies, and draw their links."; meshBtn = btn("scan", "Find shared people", null, false); }
    else if (seg.mesh && seg.mesh.found){
      meshTxt = fmt(seg.mesh.found) + " shared " + plural(seg.mesh.found, "person", "people") + " found and drawn · " + fmt(st.linked) + " of " + fmt(st.members) + " members linked. Scan again after a refresh.";
      meshBtn = btn("scan", "Scan again", reads(segCost(meta, "scan")), true);
    } else if (seg.mesh){
      meshTxt = "No one is on more than one of these companies.";
      meshBtn = btn("scan", "Scan again", reads(segCost(meta, "scan")), true);
    } else {
      meshTxt = "Find the people on more than one of its companies, and which companies they are on — a handful of bulk reads, however many there are — and draw the links.";
      meshBtn = btn("scan", "Find shared people", reads(segCost(meta, "scan")), st.members > 0);
    }
    steps += '<div class="sgstep"><span class="sgn">2</span><div class="sgsd"><b>Find the mesh</b><span>' + esc(meshTxt) + "</span></div>" + meshBtn + "</div>";
    // 3 · walk
    const left = seg ? segWalkable(meta).length : 0, next = Math.min(left, SEGWALK);
    steps += '<div class="sgstep"><span class="sgn">3</span><div class="sgsd"><b>Walk</b><span>' +
      (seg ? (left ? "Walk the next " + fmt(next) + " in full, linked ones first — " + fmt(left) + " not walked yet. A second or two a company; " +
                     "it can be stopped and picks up where it stopped."
                   : "Every member is walked.")
           : "After it is dropped in: walk its companies in batches of " + SEGWALK + ", about 15 HubSpot calls each.") + "</span></div>" +
      btn("walk", "Walk next " + fmt(next || SEGWALK), seg && left ? reads(segCost(meta, "walk")) : null, !!(seg && left)) + "</div>";
    const stats = st ? '<div class="sgstats"><span><b>' + fmt(st.members) + "</b> on this canvas</span><span><b>" + fmt(st.walked) + "</b> walked</span><span><b>" +
      fmt(st.linked) + "</b> linked to another company</span>" + (seg.traced ? "<span>traced from <b>" + fmt(seg.traced) + "</b> " + TYPEWORD[meta.type] + "</span>" : "") + "</div>" : "";
    // the run in progress, or the last one on this segment
    const job = mineRunning ? SEGJOB : null, log = job ? job.log : SGS.logs[meta.id];
    let jobHtml = "";
    if (job || (log && log.length)){
      const pct = job && job.of ? clamp(job.n / job.of * 100, 0, 100) : job ? 8 : 100;
      jobHtml = '<div class="sgjob' + (job ? " live" : "") + '">' +
        (job ? '<div class="sgjt"><span>' + esc(JOBWORD[job.kind] || "Working") + (job.of ? " · " + fmt(job.n) + " / " + fmt(job.of) : "") +
               (job.note ? " · " + esc(job.note) : "") + " · " + dur(Date.now() - job.t0) + "</span>" +
               (job.stop ? '<span class="sgstop">stopping…</span>' : '<button type="button" class="act" data-sg="stop">■ Stop</button>') + "</div>" +
               '<div class="sgbar"><span style="width:' + pct.toFixed(1) + '%"></span></div>' : "") +
        '<div class="sglog">' + (log || []).map(l => '<div class="sgl ' + esc(l.cls) + '"><span class="t">' + esc(l.t) + "</span>" + l.html + "</div>").join("") + "</div></div>";
    }
    const other = SEGJOB && !mineRunning ? '<p class="cvnone">A run on “' + esc(SEGJOB.seg.name) + "” is in progress. Actions here wait for it.</p>" : "";
    host.innerHTML =
      '<button type="button" class="act sgback" data-sg="back">‹ All segments</button>' +
      '<div class="sghead"><h3>' + esc(meta.name) + '</h3><span class="cvtag">' + esc(TYPEWORD[meta.type]) + "</span></div>" +
      '<p class="sgmeta">' + fmt(meta.size) + " " + plural(meta.size, "member") + " in HubSpot · " + (meta.live ? "live — it updates itself" : "static") +
        (meta.updated ? " · updated " + esc(ago(meta.updated)) : "") +
        ' · <a href="' + esc(segUrl(meta.id)) + '" target="_blank" rel="noopener noreferrer">Open in HubSpot</a></p>' +
      stats + other + '<div class="sgsteps">' + steps + "</div>" + jobHtml +
      (seg ? '<div class="sgfoot">' + btn("remove", "Remove from this canvas", null, true) +
             '<span>Its field goes. Accounts walked from it stay on the canvas.</span></div>' : "");
    // the log reads newest last; keep the newest in sight
    const lg = host.querySelector(".sglog"); if (lg) lg.scrollTop = lg.scrollHeight;
  }
  function paintSegPanel(){
    $("sglist").hidden = SGS.view !== "list";
    $("sgdetail").hidden = SGS.view !== "detail";
    if (SGS.view === "list") paintSegList(); else paintSegDetail();
  }
  function segArm(key){
    if (SGS.arm === key){ clearTimeout(SGS.armT); SGS.arm = null; return true; }
    SGS.arm = key; clearTimeout(SGS.armT);
    SGS.armT = setTimeout(() => { SGS.arm = null; if (!$("segpanel").hidden) paintSegPanel(); }, 4000);
    paintSegPanel();
    return false;
  }
  async function segAction(b){
    const act = b.getAttribute("data-sg");
    if (act === "close"){ closeSegPanel(); return; }
    if (act === "back"){ SGS.view = "list"; SGS.arm = null; paintSegPanel(); if (!SGS.rows.length) runSegSearch(); return; }
    if (act === "open"){
      const row = b.closest("[data-sgid]"), id = row && row.getAttribute("data-sgid");
      const hit = SGS.rows.find(r => r.id === id) || (MAP.segments[id] && Object.assign({ updated: null }, MAP.segments[id]));
      if (!hit) return;
      SGS.sel = { id: hit.id, name: hit.name, type: hit.type, size: hit.size, live: hit.live, updated: hit.updated || null };
      SGS.view = "detail"; SGS.arm = null; sgNote(""); paintSegPanel();
      return;
    }
    if (act === "stop"){ if (SEGJOB){ SEGJOB.stop = true; segEmit(); } return; }
    const meta = selMeta();
    if (!meta) return;
    if (segBusy()){ sgNote("A run is in progress — stop it or wait for it."); return; }
    if (ACQUIRING){ sgNote("A walk is running — wait for it to finish."); return; }
    if (!DB_STATE.up) sgNote("The page’s store is not available in this view: what you import will not be kept.");
    let r;
    if (act === "drop"){ r = await segDropIn(meta); if (r.ok && !MAP.segments[meta.id]) r = { ok: false, why: "not kept" }; }
    else if (act === "scan") r = await segMeshScan(meta.id);
    else if (act === "walk"){ if (!segArm(meta.id + ":walk")) return; r = await segWalk(meta.id); }
    else if (act === "remove"){
      if (!segArm(meta.id + ":remove")) return;
      r = await segRemove(meta.id);
      if (r.ok){ sgNote("“" + meta.name + "” was taken off this canvas."); }
    }
    if (r && !r.ok && r.why !== "busy") sgNote("That did not complete · " + r.why + ".");
    paintSegPanel();
  }
  // every step of a run repaints the chip, and the panel when it is open
  SEGWATCH.add(() => {
    if (SEGJOB) SGS.logs[SEGJOB.seg.id] = SEGJOB.log;
    paintSegChip();
    if (!$("segpanel").hidden) paintSegPanel();
  });

  /* ---------------- wiring ---------------- */
  $("go2").addEventListener("click", () => lookupFromInput(true));
  $("q2").addEventListener("keydown", e => { if (e.key === "Enter") lookupFromInput(true); });
  $("q2").addEventListener("input", () => { $("qerr").textContent = ""; });
  // pasting an id is the normal gesture here, so it acts without a second key
  $("q2").addEventListener("paste", () => setTimeout(() => lookupFromInput(true), 30));
  $("q").addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); lookupFromInput(false); } });
  $("q").addEventListener("paste", () => setTimeout(() => lookupFromInput(false), 30));
  $("atlas").addEventListener("click", e => {
    const b = e.target && e.target.closest && e.target.closest(".rz[data-goto]");
    if (!b) return;
    VIEW.travelTo(b.getAttribute("data-goto"), true);
    $("gwrap").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  });
  document.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { setIdMode(b.getAttribute("data-mode")); focusGate(); }));
  $("chipDb").addEventListener("click", openCanvasPanel);
  $("gcv").addEventListener("click", openCanvasPanel);
  $("cvpanel").addEventListener("click", e => {
    if (e.target === e.currentTarget){ closeCanvasPanel(); return; }        // the backdrop
    const b = e.target.closest && e.target.closest("[data-cv]");
    if (b) cvAction(b);
    const s = e.target.closest && e.target.closest("[data-scope]");
    if (s && !s.disabled){ CVF.scope = s.getAttribute("data-scope"); paintScope(); }
  });
  $("cvpanel").addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.classList.contains("cvedit")){ e.preventDefault(); cvAction(e.target.parentNode.querySelector('[data-cv="save"]')); }
    if (e.key === "Enter" && e.target.id === "cvname"){ e.preventDefault(); cvSubmit(); }
  });
  $("cvgo").addEventListener("click", cvSubmit);
  $("chipSeg").addEventListener("click", openSegPanel);
  $("gseg").addEventListener("click", openSegPanel);
  $("segpanel").addEventListener("click", e => {
    if (e.target === e.currentTarget){ closeSegPanel(); return; }        // the backdrop
    const t = e.target.closest && e.target.closest("[data-sgt]");
    if (t){ SGS.type = t.getAttribute("data-sgt"); runSegSearch(); return; }
    const b = e.target.closest && e.target.closest("[data-sg]");
    if (b && !b.disabled) segAction(b);
  });
  // Stop answers on the press itself: the button is repainted with every
  // step of a run, and a click spanning a repaint was lost
  $("segpanel").addEventListener("pointerdown", e => {
    const b = e.target.closest && e.target.closest('[data-sg="stop"]');
    if (b && SEGJOB){ SEGJOB.stop = true; segEmit(); }
  });
  $("sgq").addEventListener("input", () => { SGS.q = $("sgq").value; queueSegSearch(); });
  $("sgq").addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); clearTimeout(sgTimer); SGS.q = $("sgq").value; runSegSearch(); } });
  // the arrangement is written before the page goes, not lost with it
  window.addEventListener("pagehide", () => { if (viewTimer) saveViewNow(); });

  // The native caret is hidden and a block cursor drawn in its place, at the
  // end of whatever is on screen — the value, or the placeholder.
  (function cursor(){
    const q = $("q"), cur = $("gcur"), mir = $("gmirror");
    function place(){
      mir.textContent = q.value || q.placeholder || "";
      const tw = Math.min(mir.offsetWidth, Math.max(0, q.clientWidth - 10));
      cur.style.transform = "translateX(" + (q.offsetLeft + (q.clientWidth + tw) / 2 + 3) + "px)";
    }
    ["input", "keyup", "click", "focus", "blur", "change"].forEach(ev => q.addEventListener(ev, place));
    window.addEventListener("resize", place);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place).catch(() => {});
    place();
  })();

  // Escape lets go of one thing at a time, innermost first: the canvases
  // panel (or a rename in it), a held record, the expanded plot, the map.
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("segpanel").hidden){
      if (SGS.view === "detail"){ SGS.view = "list"; SGS.arm = null; paintSegPanel(); }
      else closeSegPanel();
      return;
    }
    if (!$("cvpanel").hidden){
      if (e.target.classList && e.target.classList.contains("cvedit")) paintCanvasPanel();
      else if (CVF.mode === "dup") setForm("new");
      else closeCanvasPanel();
      return;
    }
    if (PHASE === "open" && VIEW.hasSelection()){ VIEW.letGo(); return; }
    if (PHASE === "open" && VIEW.exitFull()) return;
    if (PHASE === "open"){ logReset(); setPhase("gate"); }
    else if (PHASE === "gate" && MAP.nodes.length) setPhase("open");
    else if (PHASE === "run" && ROOT.getAttribute("data-state") === "error"){ logReset(); setPhase("gate"); }
  });

