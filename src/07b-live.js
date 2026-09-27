
  /* =====================================================================
     15. WHO IS SIGNED IN, WHAT CHANGED IN THE CRM, AND THE SQL CONSOLE
     The Worker hears of every change (webhooks, its 15-minute read, its
     nightly re-read, and any walk that finds something different) and
     tells open pages at once. Here a change is DRAWN where the map holds
     it — a deleted record struck through, a removed link fading, a new one
     glowing — and listed; "Refresh affected accounts" re-walks just the
     accounts it touched, which is what writes it into the canvas for good.
     ===================================================================== */
  const TYPE_NAME = { "0-2": "Company", "0-1": "Contact", "0-3": "Deal", "0-136": "Lead" };
  const CHWORD = { created: "new", updated: "changed", deleted: "deleted", restored: "restored", merged: "merged", linked: "linked", unlinked: "unlinked" };
  const CH = { list: [], filter: "canvas", pending: new Set(), refreshing: false, unread: 0, since: null };
  const FRESHEN = new Set();                  // records to read again, because HubSpot says they changed
  let freshenT = null;
  const chKey = () => "atlas.changes." + (CV.uid || "");

  function nameOf(key, label){
    const n = MAP.byKey[key];
    if (n) return n.e.label;
    if (label) return label;
    const [t, id] = String(key || "").split("/");
    return (TYPE_NAME[t] || "Record") + " " + (id || "");
  }
  const touchesCanvas = c => !!(MAP.byKey[c.key] || (c.other && MAP.byKey[c.other]));
  // the walked accounts a change reaches: the company itself, or the
  // accounts a record hangs from
  function accountsTouching(keys){
    const out = new Set();
    keys.forEach(k => {
      const n = k && MAP.byKey[k];
      if (!n) return;
      if (n.kind === "company"){ if (MAP.accounts[n.id]) out.add(n.id); }
      else n.companyIds.forEach(c => { if (MAP.accounts[c]) out.add(c); });
      if (n.home && MAP.byKey[n.home] && MAP.accounts[MAP.byKey[n.home].id]) out.add(MAP.byKey[n.home].id);
    });
    return out;
  }

  function applyChange(c){
    const n = MAP.byKey[c.key], o = c.other ? MAP.byKey[c.other] : null;
    let drew = false;
    if (c.kind === "deleted" || c.kind === "merged"){
      if (n && !n.gone){ n.gone = { kind: c.kind, at: c.at || null, other: c.other || null }; drew = true; }
    } else if (c.kind === "restored"){
      if (n && n.gone){ n.gone = null; drew = true; }
    } else if (c.kind === "unlinked"){
      const ed = n && o ? MAP.edgeSet[edgeId(c.key, c.other)] : null;
      if (ed && !ed.gone){ ed.gone = true; drew = true; }
    } else if (c.kind === "linked"){
      if (n && o){
        const had = MAP.edgeSet[edgeId(c.key, c.other)];
        if (!had){
          const ed = mergeEdge(c.key, c.other, n.kind === "company" || o.kind === "company" ? "member" : "link");
          if (ed){ ed.fresh = true; drew = true; }
        } else if (had.gone){ had.gone = false; drew = true; }
      }
    } else if (c.kind === "updated" || c.kind === "created"){
      if (n) FRESHEN.add(c.key);
    }
    accountsTouching([c.key, c.other]).forEach(id => CH.pending.add(id));
    return drew;
  }

  function onLive(batch){
    const list = (batch && batch.changes) || [];
    if (!list.length) return;
    let drew = false, mine = 0;
    list.forEach(c => {
      if (touchesCanvas(c)) mine++;
      if (applyChange(c)) drew = true;
      CH.list.unshift({ seq: c.seq || null, at: c.at || new Date().toISOString(), kind: c.kind, key: c.key, other: c.other || null,
                        label: c.label || null, other_label: c.other_label || null, detail: c.detail || null, source: c.source || null });
    });
    CH.list = CH.list.slice(0, 400);
    CH.unread += mine || (CH.filter === "all" ? list.length : 0);
    if (drew){ reindex(); VIEW.refresh(); }
    if (FRESHEN.size){ clearTimeout(freshenT); freshenT = setTimeout(freshen, 1200); }
    saveChLocal();
    paintChChip();
    if (!$("chpanel").hidden) paintCh();
  }

  // records HubSpot says changed are read again, and redrawn in place
  async function freshen(){
    const keys = [...FRESHEN].filter(k => MAP.byKey[k]).slice(0, 300);
    FRESHEN.clear();
    if (!keys.length) return;
    try {
      const r = await api("/api/records", { keys });
      const at = new Date().toISOString();
      (r.records || []).forEach(d => { if (validRecord(d) && MAP.byKey[d.k]) mergeNode(d, at); });
      (r.missing || []).forEach(k => { const n = MAP.byKey[k]; if (n && !n.gone) n.gone = { kind: "deleted", at, other: null }; });
      VIEW.refresh();
    } catch(e){}
  }

  // What the Worker's copy knows has gone from HubSpot, marked on whatever
  // this canvas holds — so a deletion shows after a reload too.
  async function markTombstones(){
    const keys = MAP.nodes.map(n => n.key);
    if (!keys.length) return;
    try {
      let drew = false;
      for (let i = 0; i < keys.length; i += 2000){
        const r = await api("/api/tombstones", { keys: keys.slice(i, i + 2000) });
        (r.gone || []).forEach(g => {
          const n = MAP.byKey[g.key];
          if (n && !n.gone){ n.gone = { kind: g.other ? "merged" : "deleted", at: g.at || null, other: g.other || null }; drew = true; }
        });
      }
      if (drew) VIEW.refresh();
    } catch(e){}
  }

  // What HubSpot said of links, oldest first, drawn again on a rebuilt map:
  // an opened-out record's saved snapshot can still hold a link HubSpot has
  // since removed, and that one stays marked as removed instead of looking live.
  function reapplyLinkMarks(){
    let drew = false;
    CH.list.slice().reverse().forEach(c => {
      if ((c.kind !== "linked" && c.kind !== "unlinked") || !c.other) return;
      const ed = MAP.edgeSet[edgeId(c.key, c.other)];
      if (!ed) return;
      if (c.kind === "unlinked" && !ed.gone){ ed.gone = true; drew = true; }
      else if (c.kind === "linked" && ed.gone){ ed.gone = false; drew = true; }
    });
    return drew;
  }

  function saveChLocal(){
    try { localStorage.setItem(chKey(), JSON.stringify({ list: CH.list.slice(0, 200), pending: [...CH.pending] })); } catch(e){}
  }
  function loadChLocal(){
    try {
      const v = JSON.parse(localStorage.getItem(chKey()) || "null");
      if (v && Array.isArray(v.list)) CH.list = v.list.filter(c => c && typeof c.key === "string" && CHWORD[c.kind]).slice(0, 200);
      if (v && Array.isArray(v.pending)) v.pending.forEach(id => { if (/^\d+$/.test(String(id))) CH.pending.add(String(id)); });
    } catch(e){}
  }

  /* ---------------- the chips and panels ---------------- */
  function mountChrome(me){
    const chips = document.querySelector(".chips");
    const add = html => { chips.insertAdjacentHTML("beforeend", html); return chips.lastElementChild; };
    add('<span class="chip on whochip" id="chipWho"><i></i><span id="chipWhoTxt"></span><button type="button" class="whoout" id="signOut">Sign out</button></span>');
    add('<button type="button" class="chip cvchip chchip" id="chipCh" title="What changed in HubSpot"><i></i><span id="chipChTxt">Changes</span><span class="cvcaret" aria-hidden="true">▾</span></button>');
    add('<button type="button" class="chip cvchip" id="chipSql" title="Read-only SQL against the copy of the CRM"><i></i><span>SQL console</span><span class="cvcaret" aria-hidden="true">▾</span></button>');
    const who = String(me.user.name || me.user.email);
    $("chipWhoTxt").textContent = who;
    $("chipWho").title = "Signed in as " + me.user.email + (me.user.expiresAt ? " · until " + dstr(when(me.user.expiresAt)) + " UTC" : "");
    document.querySelectorAll("[data-who]").forEach(el => { el.textContent = who; });

    document.body.insertAdjacentHTML("beforeend",
      '<div id="chpanel" class="cvp" hidden><div class="cvbox frame chbox" role="dialog" aria-modal="true" aria-labelledby="chtitle">' +
        '<div class="cvhead"><h2 id="chtitle">Changes in HubSpot</h2><button type="button" class="act" data-ch="close">Close</button></div>' +
        '<p class="cvlede" id="chlede"></p>' +
        '<div class="chbar"><div class="cvscope" role="radiogroup" aria-label="Which changes">' +
          '<button type="button" class="gm" role="radio" data-chf="canvas" aria-checked="true">On this canvas</button>' +
          '<button type="button" class="gm" role="radio" data-chf="all" aria-checked="false">Everything</button></div>' +
          '<button type="button" class="act go" id="chrefresh" data-ch="refresh"></button></div>' +
        '<div id="chlist" class="chlist"></div>' +
        '<p class="cvnote" id="chnote" role="status" aria-live="polite"></p>' +
      "</div></div>" +
      '<div id="sqlpanel" class="cvp" hidden><div class="cvbox frame sqlbox" role="dialog" aria-modal="true" aria-labelledby="sqltitle">' +
        '<div class="cvhead"><h2 id="sqltitle">SQL console</h2><button type="button" class="act" data-sq="close">Close</button></div>' +
        '<p class="cvlede">Read-only SQL against the Worker\'s copy of the CRM: <b>records</b>, <b>links</b> (both directions), <b>phones</b>, ' +
          '<b>changes</b>, <b>segments</b>, <b>segment_members</b>, <b>sync_state</b>. One SELECT at a time, 1,000 rows at most, logged. ' +
          'Canvases are not in it. Keys read <b>0-2/…</b> company · <b>0-1/…</b> contact · <b>0-3/…</b> deal · <b>0-136/…</b> lead. Ctrl+Enter runs.</p>' +
        '<div class="sqlex" id="sqlex"></div>' +
        '<textarea id="sqlq" rows="7" spellcheck="false" autocomplete="off" aria-label="SQL query"></textarea>' +
        '<div class="sqlbar"><button type="button" class="act go" data-sq="run">Run</button><button type="button" class="act" data-sq="csv" disabled>CSV</button>' +
          '<span class="sqlstat" id="sqlstat" role="status" aria-live="polite"></span></div>' +
        '<div class="sqlres" id="sqlres"></div>' +
      "</div></div>");

    $("signOut").addEventListener("click", e => { e.stopPropagation(); window.ATLAS.signOut(); });
    $("chipCh").addEventListener("click", openCh);
    $("chipSql").addEventListener("click", openSql);
    $("chpanel").addEventListener("click", e => {
      if (e.target === e.currentTarget){ closeCh(); return; }
      const f = e.target.closest && e.target.closest("[data-chf]");
      if (f){ CH.filter = f.getAttribute("data-chf"); paintCh(); return; }
      const g = e.target.closest && e.target.closest("[data-chgo]");
      if (g){ closeCh(); goToKey(g.getAttribute("data-chgo")); return; }
      const b = e.target.closest && e.target.closest("[data-ch]");
      if (!b) return;
      if (b.getAttribute("data-ch") === "close") closeCh();
      else if (b.getAttribute("data-ch") === "refresh") refreshAffected();
    });
    $("sqlpanel").addEventListener("click", e => {
      if (e.target === e.currentTarget){ closeSql(); return; }
      const x = e.target.closest && e.target.closest("[data-sqx]");
      if (x){ $("sqlq").value = SQL_EXAMPLES[Number(x.getAttribute("data-sqx"))].sql; $("sqlq").focus(); return; }
      const g = e.target.closest && e.target.closest("[data-sqgo]");
      if (g){ closeSql(); goToKey(g.getAttribute("data-sqgo")); return; }
      const b = e.target.closest && e.target.closest("[data-sq]");
      if (!b || b.disabled) return;
      const a = b.getAttribute("data-sq");
      if (a === "close") closeSql(); else if (a === "run") runSql(); else if (a === "csv") sqlCsv();
    });
    $("sqlq").addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)){ e.preventDefault(); runSql(); } });
    // Escape closes these first, before anything underneath hears it
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!$("sqlpanel").hidden){ e.stopImmediatePropagation(); closeSql(); }
      else if (!$("chpanel").hidden){ e.stopImmediatePropagation(); closeCh(); }
    }, true);
    $("sqlex").innerHTML = '<span class="sqlexl">Try</span>' + SQL_EXAMPLES.map((x, i) => '<button type="button" class="gm" data-sqx="' + i + '">' + esc(x.label) + "</button>").join("");
  }

  // a record key goes to its account: travelled to if it is walked here, walked if not
  function goToKey(key){
    const [t, id] = String(key || "").split("/");
    if (t === "0-2" && /^\d+$/.test(id || "")){ acquire({ kind: "company", value: id }); return; }
    const n = MAP.byKey[key];
    if (n){ if (PHASE !== "open") openMap(); VIEW.travelTo(key, true); return; }
    if (t === "0-1" && /^\d+$/.test(id || "")) acquire({ kind: "contact", value: id });
    else if (t === "0-3" && /^\d+$/.test(id || "")) acquire({ kind: "deal", value: id });
  }

  function paintChChip(){
    const c = $("chipCh"), t = $("chipChTxt");
    if (!c) return;
    const pend = [...CH.pending].filter(id => MAP.accounts[id]).length;
    t.textContent = "Changes" + (CH.unread ? " · " + fmt(CH.unread) + " new" : pend ? " · " + pend + " to refresh" : "");
    c.classList.toggle("live", !!CH.unread);
  }
  function openCh(){
    const p = $("chpanel");
    p.hidden = false; ROOT.classList.add("cvon");
    CH.unread = 0; paintChChip(); paintCh();
    routeTo("changes");
  }
  function closeCh(){ $("chpanel").hidden = true; if ($("cvpanel").hidden && $("segpanel").hidden && $("sqlpanel").hidden) ROOT.classList.remove("cvon"); routeTo(""); }
  function paintCh(){
    const pend = [...CH.pending].filter(id => MAP.accounts[id]);
    document.querySelectorAll("[data-chf]").forEach(b => b.setAttribute("aria-checked", String(b.getAttribute("data-chf") === CH.filter)));
    $("chlede").innerHTML = "Everything HubSpot reported since your last visit and while this page is open: new and deleted records, merges, links added and removed, and edits to what the map shows. " +
      "It arrives within seconds. A change to something on <b>" + esc(CV.cur ? CV.cur.name : "this canvas") + "</b> is drawn on the map at once; refreshing the accounts it touched writes it into the canvas.";
    const rb = $("chrefresh");
    rb.disabled = !pend.length || CH.refreshing || ACQUIRING;
    rb.textContent = CH.refreshing ? "Refreshing…" : pend.length ? "Refresh " + pend.length + " affected " + plural(pend.length, "account") : "Nothing to refresh";
    const rows = CH.list.filter(c => CH.filter === "all" || touchesCanvas(c));
    if (!rows.length){
      $("chlist").innerHTML = '<p class="cvnone">' + (CH.filter === "all" ? "Nothing has changed in HubSpot since your last visit." : "Nothing on this canvas has changed since your last visit.") + "</p>";
      return;
    }
    const go = (k, label) => MAP.byKey[k] || String(k).indexOf("0-2/") === 0
      ? '<button type="button" class="cvopen chgo" data-chgo="' + esc(k) + '">' + esc(label) + "</button>" : '<span class="chname">' + esc(label) + "</span>";
    $("chlist").innerHTML = rows.slice(0, 300).map(c => {
      const here = touchesCanvas(c);
      const what = go(c.key, nameOf(c.key, c.label)) + (c.other ? ' <span class="chsep">' + (c.kind === "merged" ? "into" : c.kind === "unlinked" ? "from" : "to") + "</span> " + go(c.other, nameOf(c.other, c.other_label)) : "");
      const fields = c.kind === "updated" && c.detail && Array.isArray(c.detail.fields) && c.detail.fields.length ? " · " + c.detail.fields.map(esc).join(", ") : "";
      return '<div class="cvrow chrow' + (here ? " here" : "") + '"><span class="cvname">' + what + '</span><span class="cvtag chk ' + esc(c.kind) + '">' + esc(CHWORD[c.kind] || c.kind) +
             '</span><span class="cvmeta">' + esc((TYPE_NAME[String(c.key).split("/")[0]] || "record").toLowerCase() + " · " + ago(c.at) + (c.source ? " · " + c.source : "")) + fields +
             (here ? " · on this canvas" : "") + "</span></div>";
    }).join("") + (rows.length > 300 ? '<p class="cvnone">and ' + fmt(rows.length - 300) + " more</p>" : "");
  }

  async function refreshAffected(){
    if (ACQUIRING || CH.refreshing) return;
    const ids = [...CH.pending].filter(id => MAP.accounts[id]);
    if (!ids.length) return;
    ACQUIRING = true; CH.refreshing = true; paintCh();
    let ok = 0, failed = 0;
    const note = t => { const n = $("chnote"); if (n) n.textContent = t || ""; };
    try {
      await stopExpansions();
      for (let i = 0; i < ids.length; i++){
        note("Re-walking " + (MAP.accounts[ids[i]].name || "company " + ids[i]) + " · " + (i + 1) + " of " + ids.length);
        try { const r = await walkCore(ids[i], QUIET_R); if (r.ok) ok++; else failed++; CH.pending.delete(ids[i]); }
        catch(e){ failed++; if (e && e.code === "no_identity") break; }
      }
      await rebuildFromStore();
      reapplyLinkMarks();
      await markTombstones();
      VIEW.refresh(); renderRoster(); paintGateMap();
      note(ok + " " + plural(ok, "account") + " refreshed" + (failed ? " · " + failed + " could not be read" : "") + ".");
    } finally { ACQUIRING = false; CH.refreshing = false; saveChLocal(); paintCh(); paintChChip(); }
  }

  /* ---------------- the SQL console ---------------- */
  const SQL_EXAMPLES = [
    { label: "People on 2+ companies", sql:
      "SELECT l.a AS contact, r.label AS name, count(*) AS companies\nFROM links l JOIN records r ON r.key = l.a\n" +
      "WHERE l.a >= '0-1/' AND l.a < '0-10' AND l.b >= '0-2/' AND l.b < '0-20'\nGROUP BY l.a HAVING count(*) > 1\nORDER BY companies DESC LIMIT 200" },
    { label: "Unattached, same number", sql:
      "SELECT p.key AS company, q.key AS contact, p.tail\nFROM phones p\nJOIN phones q ON q.tail = p.tail AND q.key >= '0-1/' AND q.key < '0-10'\n" +
      "WHERE p.key >= '0-2/' AND p.key < '0-20'\n  AND NOT EXISTS (SELECT 1 FROM links l WHERE l.a = q.key AND l.b = p.key)\nLIMIT 200" },
    { label: "Biggest accounts", sql:
      "SELECT l.a AS company, r.label AS name, count(*) AS contacts\nFROM links l JOIN records r ON r.key = l.a\n" +
      "WHERE l.a >= '0-2/' AND l.a < '0-20' AND l.b >= '0-1/' AND l.b < '0-10'\nGROUP BY l.a ORDER BY contacts DESC LIMIT 50" },
    { label: "Latest changes", sql: "SELECT seq, at, kind, key, other, source\nFROM changes ORDER BY seq DESC LIMIT 100" },
    { label: "Deleted in HubSpot", sql: "SELECT key, label, deleted_at, merged_into\nFROM records WHERE deleted_at IS NOT NULL\nORDER BY deleted_at DESC LIMIT 100" },
    { label: "The copy so far", sql: "SELECT job, status, detail, heartbeat, error\nFROM sync_state ORDER BY job" }
  ];
  const SQ = { last: null, running: false };
  function openSql(){
    const p = $("sqlpanel");
    p.hidden = false; ROOT.classList.add("cvon");
    if (!$("sqlq").value) $("sqlq").value = SQL_EXAMPLES[0].sql;
    setTimeout(() => { try { $("sqlq").focus(); } catch(e){} }, 30);
    routeTo("sql");
  }
  function closeSql(){ $("sqlpanel").hidden = true; if ($("cvpanel").hidden && $("segpanel").hidden && $("chpanel").hidden) ROOT.classList.remove("cvon"); routeTo(""); }
  async function runSql(){
    if (SQ.running) return;
    const sql = $("sqlq").value.trim();
    if (!sql) return;
    SQ.running = true;
    const stat = $("sqlstat");
    stat.className = "sqlstat"; stat.textContent = "Running…";
    try {
      const r = await api("/api/sql", { sql });
      SQ.last = r;
      stat.textContent = fmt(r.rows.length) + " " + plural(r.rows.length, "row") + (r.truncated ? " (the first 1,000)" : "") + " · " + fmt(r.ms) + " ms · " +
                         fmt(r.rowsRead) + " rows read · today " + fmt(r.readToday) + " of " + fmt(r.readBudget);
      const cell = v => {
        if (v == null) return '<td class="snull">null</td>';
        const s = String(v);
        return /^0-(1|2|3|136)\/\d+$/.test(s) ? '<td><button type="button" class="sqgo" data-sqgo="' + esc(s) + '">' + esc(s) + "</button></td>" : "<td>" + esc(s) + "</td>";
      };
      $("sqlres").innerHTML = r.columns.length
        ? '<table class="sqlt"><thead><tr>' + r.columns.map(c => "<th>" + esc(c) + "</th>").join("") + "</tr></thead><tbody>" +
          r.rows.map(row => "<tr>" + row.map(cell).join("") + "</tr>").join("") + "</tbody></table>"
        : '<p class="cvnone">No rows.</p>';
      $("sqlpanel").querySelector('[data-sq="csv"]').disabled = !r.rows.length;
    } catch(e){
      SQ.last = null;
      stat.className = "sqlstat bad";
      stat.textContent = (e && e.message) || "The query could not be run.";
      $("sqlres").innerHTML = "";
      $("sqlpanel").querySelector('[data-sq="csv"]').disabled = true;
    } finally { SQ.running = false; }
  }
  async function sqlCsv(){
    const r = SQ.last;
    if (!r) return;
    const q = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const text = [r.columns.map(q).join(",")].concat(r.rows.map(row => row.map(q).join(","))).join("\n");
    const dl = await use("downloads");
    if (dl) await dl.save({ filename: "atlas-sql-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".csv", data: new Blob([text], { type: "text/csv" }) });
  }

  /* ---------------- routes ---------------- */
  function handleRoute(r){
    if (!r) return;
    if (r.name === "company" && /^\d+$/.test(r.args[0] || "")){
      if (MAP.accounts[r.args[0]]){ if (PHASE !== "open") openMap(); VIEW.travelTo(companyKey(r.args[0]), true); }
      else acquire({ kind: "company", value: r.args[0] });
    }
    else if (r.name === "sql") openSql();
    else if (r.name === "changes") openCh();
    else if (r.name === "canvas" && r.args.length >= 2){
      const c = CV.list.find(x => x.scope === r.args[0] && x.id === r.args[1]);
      if (c && !sameCanvas(c, CV.cur)) openCanvas(c);
    }
  }

  function startLive(){
    loadChLocal();
    if (reapplyLinkMarks()) VIEW.refresh();
    window.ATLAS.onChanges(onLive);
    paintChChip();
  }
