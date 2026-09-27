
  /* ---------------- boot ----------------
     Nothing is read before a sign-in the Worker accepts. Then the canvas
     this viewer had open last (or the Main map) is read back from the store
     and drawn, what HubSpot has deleted since is marked on it, the live
     change feed starts, and the address bar's #/ route is followed. An
     empty canvas leaves the gate up. */
  setPhase("gate");
  BOOT = (async function boot(){
    if (!window.ATLAS) throw new Error("the page's platform did not load");
    const me = await window.ATLAS.ready;
    PORTAL = String(me.portal || "");
    OPERATOR = String(me.user.name || me.user.email || "—").toUpperCase();
    mountChrome(me);
    logReset();
    const sR = logStep("RESTORE CANVAS FROM STORE");
    // how full the SQL copy is; the map does not wait for it
    paintHsChip(); setInterval(paintHsChip, 5 * 60000);
    let n = 0;
    try {
      const u = await use("user");
      CV.uid = u ? await u.id() : null;
      await listCanvases();
      const want = recalledCanvas();
      CV.cur = CV.list.find(c => want && c.id === want.id && c.scope === want.scope) || CV.list.find(isMain);
      VIEW.setViewState(CV.cur.view);
      n = await loadCanvas(CV.cur);
    } catch(e){
      DB_STATE = { known: true, up: false, why: "unreadable" };
      if (!CV.cur) CV.cur = normCanvas(MAIN_ID, "shared", null, false);
    }
    paintGateMap();
    markTombstones();
    if (!n && !MAP.nodes.length){ stepOk(sR, DB_STATE.up ? "EMPTY" : String(DB_STATE.why).toUpperCase()); logReset(); return; }
    setPhase("run");
    logLine("SESSION <b>RESTORE</b> &middot; OPERATOR " + esc(OPERATOR));
    const sg = MAP.segOrder.length;
    stepOk(sR, esc(CV.cur.name).toUpperCase() + " &middot; " + n + " " + plural(n, "ACCOUNT") + (sg ? " &middot; " + sg + " " + plural(sg, "SEGMENT") : ""));
    const c = mapCounts();
    logLine("RECORDS &middot; <b>" + fmt(c.records) + "</b> &middot; LINKS &middot; <b>" + fmt(MAP.edges.length) + "</b>");
    if (c.shared) logLine("<b>" + c.shared + "</b> " + plural(c.shared, "RECORD") + " ON MORE THAN ONE ACCOUNT", "err");
    prog(100, "MAP RESTORED");
    await openMap();
  })().catch(e => { if (e) console.error(e); }).then(() => {
    BOOT = null;
    if (!window.ATLAS || !window.ATLAS.me) return;
    startLive();
    window.ATLAS.onRoute(handleRoute);
    handleRoute(window.ATLAS.route);
  });
})();
