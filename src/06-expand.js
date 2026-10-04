    /* ================= opening records out into the map =================
       A walk stops at its account's edge; a record can be asked for ITS
       associations, and whatever comes back is added to the same model by
       the same rules. The only gesture after a walk that spends quota, so
       it is always a deliberate press. Nothing it adds is saved. */
    let xcloseT = null;
    function xshow(head, colourKey){
      if (xcloseT){ clearTimeout(xcloseT); xcloseT = null; }
      xp.innerHTML = '<div class="xh">' + head + "</div>";
      if (colourKey) xp.style.setProperty("--node", nodeColour(colourKey)); else xp.style.removeProperty("--node");
      xp.classList.add("on");
    }
    function xclose(ms){
      if (xcloseT) clearTimeout(xcloseT);
      xcloseT = setTimeout(() => { xcloseT = null; xp.classList.remove("on"); }, ms || 900);
    }
    function xline(html, state){
      const row = document.createElement("div");
      row.className = "xl" + (state ? " " + state : "");
      row.innerHTML = '<span class="xm">' + html + '</span><span class="xs"></span>';
      xp.appendChild(row);
      xp.scrollTop = xp.scrollHeight;
      return row;
    }
    function xend(row, note, bad){
      if (!row) return;
      row.className = "xl " + (bad ? "err" : "ok");
      row.querySelector(".xs").textContent = note || (bad ? "[ FAIL ]" : "[ OK ]");
    }

    // every record asks for the three other kinds, in one call to the Worker
    const KIND_WORD = { contact: "contacts", company: "companies", deal: "deals", lead: "leads" };
    // spiral out from the record that fetched it and take the first place
    // with real room; if nothing clears, the roomiest place tried
    function freeSpot(anchor, self){
      // Where everything is, in 90-unit cells. A spot is free when nothing
      // is within 90, so it only needs its own 3x3 cells, not every record:
      // Expand all used to measure every spot against the whole map.
      const C = 90, cells = new Map();
      MAP.nodes.forEach(n => {
        if (n === self || !isFinite(n.x) || !isFinite(n.y)) return;
        const k = Math.floor(n.x / C) + "," + Math.floor(n.y / C);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(n);
      });
      const nearest = (x, y) => {
        let m = Infinity;
        const gx = Math.floor(x / C), gy = Math.floor(y / C);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++){
          const list = cells.get((gx + i) + "," + (gy + j));
          if (list) for (const n of list){ const d = Math.hypot(n.x - x, n.y - y); if (d < m) m = d; }
        }
        return m;
      };
      let best = { x: anchor.x + 100, y: anchor.y }, bestD = -1;
      for (let ring = 1; ring <= 6; ring++){
        const rad = 96 + ring * 52, steps = 9 + ring * 4;
        for (let j = 0; j < steps; j++){
          const a = (j / steps) * Math.PI * 2 + ring * 0.41;
          const x = anchor.x + rad * Math.cos(a), y = anchor.y + rad * Math.sin(a) * 0.72;
          const d = nearest(x, y);
          if (d >= 90) return { x, y };
          if (d > bestD){ bestD = d; best = { x, y }; }
        }
      }
      return best;
    }

    // ONE record's reads, merged into the model. The single press and
    // Expand all both drive this, so they cannot drift apart.
    async function expandOne(node, verbose){
      const self = node.kind === "detached" ? "contact" : node.kind;
      const want = ["contact", "company", "deal", "lead"].filter(k => k !== self);
      const r = { added: 0, linked: 0, failed: 0, known: 0, reads: 1, keys: [], fresh: [] };
      const row0 = verbose ? xline("Read " + want.map(k => KIND_WORD[k]).join(", "), "run") : null;
      let res;
      try { res = await api("/api/expand", { key: node.key, limit: EXPAND.limit }); }
      catch(e){ r.failed = 1; xend(row0, "[ FAIL ]", true); return r; }
      xend(row0, "[ OK ]");
      // what arrives from a record lives where that record lives
      const home = node.hive || hiveKeyOf(node);
      for (const type of want){
        const got = (res.found || {})[type] || { total: 0, records: [] };
        if (verbose) xline(esc(KIND_WORD[type]) + " · <b>" + got.records.length + "</b>" +
                           (got.total > got.records.length ? " of " + fmt(got.total) : "") + " found", "sum");
        for (const d0 of got.records){
          if (!validRecord(d0)) continue;
          const d = d0.kd === "company" ? d0 : Object.assign({}, d0, { hh: home });
          const had = MAP.byKey[d.k];
          if (had) r.known++;
          const m = mergeNode(d, new Date().toISOString());
          if (!had){
            // only a record that ARRIVED from this one hangs from it; one
            // already on the map keeps whatever placed it
            m.parentKey = node.key;
            m.x = node.x; m.y = node.y;
            ensureNode(m);
            const s = freeSpot(node, m);
            m.x = s.x; m.y = s.y;
            placeNode(m);
            r.added++; r.fresh.push(m.key);
          } else ensureNode(m);
          if (m === node) continue;
          uniqPush(r.keys, m.key);
          // a company on either end makes it a membership — which is what
          // reindex() reads a record's companies and home from
          const existed = MAP.edgeSet[edgeId(node.key, m.key)];
          const ed = mergeEdge(node.key, m.key, node.kind === "company" || m.kind === "company" ? "member" : "link");
          if (ed && !existed){ ensureEdge(ed); layEdges({ edges: [ed] }); r.linked++; }
        }
      }
      return r;
    }
    function markDone(n){ n.xd = true; if (n.el){ ensureNode(n); placeNode(n); } }
    // what a record's opening-out found is kept with the canvas
    async function saveOpened(node, r){
      try { return HOOKS.expanded ? await HOOKS.expanded(node, r) : { ok: false, why: "no store" }; }
      catch(e){ return { ok: false, why: "unavailable" }; }
    }
    function afterExpansion(){ GREW = true; reindex(); refresh(); }

    async function expandNode(node){
      // a walk or a segment run is rebuilding the model this would write into
      if (busy || !node || ACQUIRING) return;
      busy = true;
      const run = { kind: "one", stop: false }; run.done = new Promise(res => { run.finish = res; });
      XRUN = run;
      xshow("Opening out<b>" + esc(node.e.label) + "</b>", node.key);
      try {
        const r = await expandOne(node, true);
        const allFailed = r.failed >= r.reads;
        xline("<b>" + r.added + "</b> new " + plural(r.added, "record"), "sum");
        if (r.known) xline("<b>" + r.known + "</b> already on the map", "sum");
        xline("<b>" + r.linked + "</b> new " + plural(r.linked, "link"), "sum");
        // a record none of whose reads were answered keeps its button
        if (!allFailed) markDone(node);
        if (r.added || r.linked){ const rl = xline("Lay out", "run"); afterExpansion(); xend(rl, "[ OK ]"); }
        else if (!allFailed) xline("Nothing this map did not already hold", "sum");
        if (r.failed) xline(r.failed + " " + plural(r.failed, "read") + " refused", "err");
        if (!allFailed){
          const sv = await saveOpened(node, r);
          xline(sv.ok ? "Saved to this canvas" : "Not saved — " + esc(sv.why), sv.ok ? "sum" : "err");
        }
      } catch(e){
        xline("The expansion could not be completed", "err");
      } finally {
        busy = false; XRUN = null; run.finish();
        xclose(); paintXall();
      }
    }

    // ================= Expand search · all =================
    // The single press, run down the map. It works from a SNAPSHOT, so what
    // it adds waits for the next press — one level further out per press.
    // Eligible: every record SHOWN (the legend decides the scope) not yet
    // opened out. Companies are left out: a walked one's walk read exactly
    // this already, and one nobody walked is walked, not expanded.
    let allArm = null, allFlash = null;
    const eligible = () => MAP.nodes.filter(n => n.el && !n.xd && n.kind !== "company" && !isHidden(n));
    function paintXall(){
      const b = $("gxall");
      if (!b || XRUN || allArm || allFlash) return;
      const n = eligible().length;
      b.className = "gtool wide gall";
      b.disabled = n === 0;
      b.textContent = n ? "Expand search · all " + fmt(n) : "All expanded";
      b.title = n
        ? "Expand search on the " + fmt(n) + " " + plural(n, "record") + " shown that " + (n === 1 ? "has" : "have") +
          " not been opened out yet · one request each" + (n > EXPAND.perPress ? " · " + EXPAND.perPress + " records a press" : "")
        : "Every record shown has been opened out. Companies are walked, not expanded.";
    }
    function xallPress(b){
      if (XRUN){
        if (XRUN.kind !== "all") return;
        XRUN.stop = true;                 // the record in flight finishes; nothing after it starts
        b.textContent = "Stopping…"; b.disabled = true;
        return;
      }
      const list = eligible();
      if (!list.length || ACQUIRING) return;
      const take = Math.min(list.length, EXPAND.perPress);
      if (!allArm){
        b.className = "gtool wide gall arm";
        b.textContent = "Press again · " + (take < list.length ? "first " + take + " of " + fmt(list.length) : fmt(take) + " " + plural(take, "record")) +
                        " · " + fmt(take * EXPAND.reads) + " " + plural(take * EXPAND.reads, "request");
        allArm = setTimeout(() => { allArm = null; paintXall(); }, 4000);
        return;
      }
      clearTimeout(allArm); allArm = null;
      expandAll(list.slice(0, take), list.length);
    }
    async function expandAll(list, total){
      const b = $("gxall");
      const run = { kind: "all", stop: false }; run.done = new Promise(res => { run.finish = res; });
      XRUN = run; busy = true;
      const t = { added: 0, linked: 0, known: 0, failed: 0, done: 0, opened: 0, unsaved: 0, why: "" };
      let dead = 0, halted = false;
      xshow('Expanding search<b id="gxallh"></b>');
      const head = () => { const h = $("gxallh"); if (h) h.textContent = t.done + " / " + list.length + " records" + (total > list.length ? " · " + fmt(total) + " waiting" : ""); };
      const live = () => { if (!run.stop){ b.className = "gtool wide gall live"; b.disabled = false; b.textContent = "■ Stop · " + t.done + "/" + list.length; } };
      head(); live();
      try {
        for (const n of list){
          if (run.stop) break;
          // opened by hand, or gone from the map, since the snapshot
          if (n.xd || MAP.byKey[n.key] !== n){ t.done++; head(); live(); continue; }
          const row = xline(esc(trunc(n.e.label, 28)), "run");
          row.style.setProperty("--node", nodeColour(n.key));
          let r;
          try { r = await expandOne(n, false); } catch(e){ r = { added: 0, linked: 0, known: 0, failed: EXPAND.reads, reads: EXPAND.reads }; }
          t.added += r.added; t.linked += r.linked; t.known += r.known; t.failed += r.failed; t.done++;
          if (r.failed >= r.reads){
            xend(row, "[ FAIL ]", true);
            // three records in a row with nothing answered is the connector
            // or the quota, not bad luck — stop spending
            if (++dead >= 3){ halted = true; break; }
          } else {
            dead = 0; t.opened++;
            markDone(n);
            const sv = await saveOpened(n, r);
            if (!sv.ok){ t.unsaved++; t.why = sv.why; }
            xend(row, r.added ? "+" + r.added + " NEW" : r.linked ? "+" + r.linked + " " + plural(r.linked, "LINK") : "NOTHING NEW", !sv.ok);
          }
          head(); live();
        }
        xline("<b>" + t.opened + "</b> " + plural(t.opened, "record") + " opened out", "sum");
        xline("<b>" + t.added + "</b> new " + plural(t.added, "record") + " · <b>" + t.linked + "</b> new " + plural(t.linked, "link"), "sum");
        if (t.known) xline("<b>" + t.known + "</b> already on the map", "sum");
        if (t.added || t.linked){ const rl = xline("Lay out", "run"); afterExpansion(); xend(rl, "[ OK ]"); }
        if (halted) xline("HubSpot stopped answering · halted", "err");
        else if (run.stop && t.done < list.length) xline("Stopped · " + (list.length - t.done) + " not reached", "err");
        if (t.failed) xline(t.failed + " " + plural(t.failed, "read") + " refused", "err");
        if (t.unsaved) xline(t.unsaved + " not saved — " + esc(t.why), "err");
        else if (t.opened) xline("Saved to this canvas", "sum");
      } catch(e){
        xline("The run could not be completed", "err");
      } finally {
        busy = false; XRUN = null; run.finish();
        xclose(3200);
        const refused = !t.opened && t.failed > 0;
        b.className = "gtool wide gall flash" + (halted || refused ? " gbad" : "");
        b.disabled = true;
        b.textContent = halted ? "Halted" : refused ? "Refused · try again" : "Done · +" + fmt(t.added) + " new";
        allFlash = setTimeout(() => { allFlash = null; paintXall(); }, 2600);
      }
    }
