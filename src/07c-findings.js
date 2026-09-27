
  /* =====================================================================
     16. FINDINGS, IN THE CANVAS — and ADD TO CANVAS
     A sidebar inside the map, collapsible, with the Worker's findings
     listed one after another: smart duplicates, hidden links, ownership,
     data quality. Each opens to its rows (a row opens its account), and any
     list — a finding's, or a SQL result's — can be put on this canvas, a new
     one, or any other: it arrives as a set of companies, like a segment,
     that can be walked, meshed, refreshed (the query run again) or removed.
     ===================================================================== */
  const FD = { list: [], data: {}, open: new Set(), busy: new Set(), shown: {}, err: {}, notes: {} };
  const FD_SIDE = "atlas.findings.side";
  const findingTitle = id => { const f = FD.list.find(x => x.id === id); return f ? f.title : id; };
  const setWord = sg => sg.source ? (sg.source.kind === "sql" ? "sql" : "finding") : TYPEWORD[sg.type];

  function mountFindings(){
    const stage = document.querySelector("#gwrap .gstage");
    if (!stage || $("gside")) return;
    stage.insertAdjacentHTML("beforeend",
      '<aside class="gside" id="gside" aria-label="Findings">' +
        '<div class="gsidehead"><span class="gsidet">Findings</span>' +
          '<button type="button" class="act gsidex" id="gsidex" title="Hide the findings" aria-label="Hide the findings">Hide ⟩</button></div>' +
        '<p class="gsidelede">What the SQL copy shows that HubSpot does not. Open one to see it; any list can go onto a canvas.</p>' +
        '<div id="gsidelist" class="gsidelist"></div>' +
      "</aside>" +
      '<button type="button" class="gsidetab" id="gsidetab" title="Show the findings">⟨ Findings</button>');
    const chips = document.querySelector(".chips");
    if (chips) chips.insertAdjacentHTML("beforeend", '<button type="button" class="chip cvchip" id="chipFd" title="Findings: smart duplicates, hidden links, data quality"><i></i><span>Findings</span><span class="cvcaret" aria-hidden="true">▾</span></button>');
    let open = true;
    try { const v = localStorage.getItem(FD_SIDE); open = v == null ? window.innerWidth > 900 : v === "1"; } catch(e){}
    sideOpen(open, true);
    $("gsidex").addEventListener("click", () => sideOpen(false));
    $("gsidetab").addEventListener("click", () => sideOpen(true));
    $("chipFd").addEventListener("click", async () => { if (PHASE !== "open") await openMap(); sideOpen(true); $("gwrap").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); });
    $("gsidelist").addEventListener("click", fdClick);
    $("gsidelist").addEventListener("change", e => { const s = e.target.closest && e.target.closest(".atcsel"); if (s) atcSel(s); });
    loadFindings();
  }
  function sideOpen(on, quiet){
    $("gside").hidden = !on; $("gsidetab").hidden = !!on;
    $("gwrap").classList.toggle("sideon", !!on);
    if (!quiet){ try { localStorage.setItem(FD_SIDE, on ? "1" : "0"); } catch(e){} }
  }

  async function loadFindings(){
    try { const r = await api("/api/findings"); FD.list = r.findings || []; }
    catch(e){ FD.list = []; FD.err._list = (e && e.message) || "The findings could not be read."; }
    paintFindings();
  }

  // a row goes to its account: the first company in it, else its first record
  const rowKey = row => row.keys.find(k => k.indexOf("0-2/") === 0) || row.keys[0];
  function rowsHtml(f){
    const d = FD.data[f.id];
    if (FD.err[f.id]) return '<p class="cvnone bad">' + esc(FD.err[f.id]) + "</p>";
    if (!d) return '<p class="cvnone">' + (FD.busy.has(f.id) ? "Asking the copy…" : "") + "</p>";
    if (!d.rows.length) return '<p class="cvnone">Nothing found' + (f.waiting.length ? " in what is copied so far." : ".") + "</p>";
    const n = FD.shown[f.id] || 25;
    return d.rows.slice(0, n).map(row =>
      '<div class="fdr"><button type="button" class="fdgo" data-fdgo="' + esc(rowKey(row)) + '">' + esc(row.label) + "</button>" +
      (row.score > 1 ? '<span class="fds" title="score">' + esc(String(row.score)) + "</span>" : "") +
      (row.detail ? '<div class="fdd">' + esc(row.detail) + "</div>" : "") + "</div>").join("") +
      (d.rows.length > n ? '<button type="button" class="act fdmore" data-fdmore="' + esc(f.id) + '">Show ' + fmt(Math.min(d.rows.length - n, 100)) + " more · " + fmt(d.rows.length) + (d.more ? "+" : "") + " in all</button>" : "");
  }
  function paintFindings(){
    const host = $("gsidelist");
    if (!host) return;
    if (FD.err._list){ host.innerHTML = '<p class="cvnone bad">' + esc(FD.err._list) + "</p>"; return; }
    let group = "", html = "";
    FD.list.forEach(f => {
      if (f.group !== group){ group = f.group; html += '<p class="fdgroup">' + esc(group) + "</p>"; }
      const d = FD.data[f.id], open = FD.open.has(f.id);
      const count = d ? fmt(d.count) + (d.more ? "+" : "") : f.last ? fmt(f.last.count) + (f.last.more ? "+" : "") : "";
      html += '<section class="fd' + (open ? " open" : "") + '" data-fd="' + esc(f.id) + '">' +
        '<button type="button" class="fdh" data-fdo="' + esc(f.id) + '" aria-expanded="' + open + '">' +
          '<span class="fdt">' + esc(f.title) + "</span>" +
          '<span class="fdn' + (f.waiting.length ? " wait" : "") + '">' + (FD.busy.has(f.id) ? "…" : esc(count)) + "</span></button>" +
        (open ? '<div class="fdb">' +
          '<p class="fdl">' + esc(f.blurb) + "</p>" +
          (f.waiting.length ? '<p class="fdw">Still being copied: ' + esc(f.waiting.join(", ")) + ". This shows what is there so far.</p>" : "") +
          '<div class="fdrows">' + rowsHtml(f) + "</div>" +
          (d ? '<p class="fdmeta">' + (d.cached ? "as of " + esc(ago(d.at)) : "just now") + (d.rowsRead ? " · " + fmt(d.rowsRead) + " rows read" : "") + (d.note ? " · " + esc(d.note) : "") + "</p>" : "") +
          '<div class="fdacts">' + (d && d.rows.length ? atcHtml("f:" + f.id) : "") +
            '<button type="button" class="act" data-fdagain="' + esc(f.id) + '">Ask again</button>' +
            '<button type="button" class="act" data-fdsql="' + esc(f.id) + '">Open in SQL</button></div>' +
        "</div>" : "") + "</section>";
    });
    host.innerHTML = html || '<p class="cvnone">Loading the findings…</p>';
  }
  async function runFinding(id, fresh){
    if (FD.busy.has(id)) return;
    FD.busy.add(id); delete FD.err[id]; paintFindings();
    try { FD.data[id] = await api("/api/findings/" + encodeURIComponent(id), { fresh: !!fresh }); }
    catch(e){ FD.err[id] = e && e.code === "budget" ? e.message : "The copy could not answer · " + ((e && e.message) || "try again") + "."; }
    finally {
      FD.busy.delete(id);
      const f = FD.list.find(x => x.id === id), d = FD.data[id];
      if (f && d) f.last = { count: d.count, more: d.more, at: d.at };
      paintFindings();
    }
  }
  function fdClick(e){
    const t = e.target.closest ? e.target : null;
    if (!t) return;
    const o = t.closest("[data-fdo]");
    if (o){ const id = o.getAttribute("data-fdo");
      if (FD.open.has(id)) FD.open.delete(id); else { FD.open.add(id); if (!FD.data[id]) runFinding(id, false); }
      paintFindings(); return; }
    const g = t.closest("[data-fdgo]"); if (g){ goToKey(g.getAttribute("data-fdgo")); return; }
    const m = t.closest("[data-fdmore]"); if (m){ const id = m.getAttribute("data-fdmore"); FD.shown[id] = (FD.shown[id] || 25) + 100; paintFindings(); return; }
    const a = t.closest("[data-fdagain]"); if (a){ runFinding(a.getAttribute("data-fdagain"), true); return; }
    const s = t.closest("[data-fdsql]");
    if (s){ const f = FD.list.find(x => x.id === s.getAttribute("data-fdsql")); if (f){ openSql(); $("sqlq").value = f.sql; } return; }
    const go = t.closest(".atcgo"); if (go) atcGo(go);
  }

  /* ---------------- add to canvas ----------------
     One small form wherever a list is: which canvas (this one, a new one,
     any other), and for a new one its name. */
  function atcHtml(ctx){
    const others = CV.list.filter(c => !sameCanvas(c, CV.cur));
    return '<div class="atc" data-atc="' + esc(ctx) + '">' +
      '<select class="atcsel" aria-label="Which canvas">' +
        '<option value="this">This canvas · ' + esc(trunc(CV.cur ? CV.cur.name : "", 24)) + "</option>" +
        '<option value="new">A new canvas…</option>' +
        others.map(c => '<option value="' + esc(c.scope + ":" + c.id) + '">' + esc(trunc(c.name, 28)) + (c.scope === "private" ? " · private" : "") + "</option>").join("") +
      "</select>" +
      '<input class="atcname" type="text" maxlength="60" placeholder="NAME THE NEW CANVAS" hidden>' +
      '<button type="button" class="act go atcgo">Add to canvas</button>' +
      // the last word on this list survives the panel being drawn again
      '<span class="atcnote" role="status" aria-live="polite">' + esc(FD.notes[ctx] || "") + "</span></div>";
  }
  function atcSel(sel){ const f = sel.closest(".atc"); f.querySelector(".atcname").hidden = sel.value !== "new"; if (sel.value === "new") f.querySelector(".atcname").focus(); }
  // what a form adds: a finding's rows, or the SQL console's last result
  function atcSource(ctx){
    if (ctx.indexOf("f:") === 0){
      const id = ctx.slice(2), d = FD.data[id], f = FD.list.find(x => x.id === id);
      return d ? { title: f ? f.title : id, source: { kind: "finding", id }, keys: keysIn(d.rows.map(r => r.keys)) } : null;
    }
    if (ctx === "sql" && SQ.last){
      const name = ($("sqlname") && $("sqlname").value.trim()) || "SQL · " + trunc(SQ.lastSql.replace(/\s+/g, " "), 40);
      return { title: name, source: { kind: "sql", sql: SQ.lastSql }, keys: keysIn(SQ.last.rows) };
    }
    return null;
  }
  async function atcGo(btn){
    const f = btn.closest(".atc"), ctx = f.getAttribute("data-atc");
    // written to whichever copy of the form is on screen now
    const say = t => { FD.notes[ctx] = t || ""; document.querySelectorAll('.atc[data-atc="' + ctx + '"] .atcnote').forEach(n => { n.textContent = t || ""; }); };
    const src = atcSource(ctx);
    if (!src){ say("Nothing to add yet."); return; }
    if (!src.keys.length){ say("No records in this list."); return; }
    if (ACQUIRING){ say("A walk or a run is going — wait for it."); return; }
    const target = f.querySelector(".atcsel").value;
    btn.disabled = true;
    try {
      let c = CV.cur;
      if (target === "new"){
        const name = cvName(f.querySelector(".atcname").value || src.title);
        if (!name){ say("Name the new canvas."); return; }
        say("Making “" + name + "”…");
        c = await createCanvas(name, "shared", {});
      } else if (target !== "this"){
        c = CV.list.find(x => x.scope + ":" + x.id === target);
      }
      if (!c){ say("That canvas is not there any more."); return; }
      const moving = !sameCanvas(c, CV.cur);
      if (moving){ say("Opening “" + c.name + "”…"); closeSql(); if (!(await openCanvas(c))) { say("Could not open it."); return; } }
      say("Adding " + fmt(src.keys.length) + " " + plural(src.keys.length, "record") + "…");
      const r = await segDropIn({ id: "q" + Date.now().toString(36), name: src.title, type: "0-2", size: 0, live: false, source: src.source, keys: src.keys });
      if (!r.ok){ say("That did not complete · " + (r.why || "try again") + "."); return; }
      say("On “" + CV.cur.name + "”: " + fmt(r.count) + " " + plural(r.count, "company", "companies") + " in a field under the map.");
      if (PHASE !== "open") await openMap();
      paintFindings();
    } catch(e){ say("Could not add it — " + why(e) + "."); }
    finally { btn.disabled = false; }
  }
