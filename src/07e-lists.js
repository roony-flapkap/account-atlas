
  /* =====================================================================
     17. HUBSPOT LISTS — for the Atlas's editors, as the deletes are.
     Wherever the Atlas shows a set of records — this canvas (the sidebar's
     Accounts tab), a finding, this canvas's findings, a SQL result — the
     records of one type can be made a static list in HubSpot: pick the
     type, name it (or keep the name it offers), press. The Worker makes the
     empty list, then the page adds the ids 10,000 a call, saying how far it
     has got. A SQL result or finding that was cut short is asked again in
     full first, and the Worker picks out just the ids. Nothing on the map
     changes, and no record in HubSpot does: the list is new, and HubSpot
     can restore it for 90 days if it is deleted.
     ===================================================================== */
  const HL = { sel: {}, name: {}, note: {}, busy: new Set() };
  const HL_TYPES = [["0-2", "companies", "company"], ["0-1", "contacts", "contact"], ["0-3", "deals", "deal"], ["0-136", "leads", "lead"]];
  const HL_ADD = 10000;
  const HL_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hlType = k => String(k).split("/")[0];
  const hlWords = t => HL_TYPES.find(x => x[0] === t) || HL_TYPES[1];

  // What a form would list: its records' keys, a title for the default
  // name, and, when what is in hand was cut short, the query that gives the
  // whole of it (a finding's own SQL comes with its LIMIT, taken off here).
  function hlSource(ctx){
    if (ctx === "cv") return CV.cur ? { title: CV.cur.name, keys: keysIn(canvasKeys()), from: { kind: "canvas", name: CV.cur.name } } : null;
    if (ctx.indexOf("f:") === 0){
      const id = ctx.slice(2), d = FD.data[id], f = FD.list.find(x => x.id === id);
      if (!d) return null;
      const src = { title: findingTitle(id), keys: keysIn(d.rows.map(r => r.keys)), from: { kind: "finding", id } };
      if (d.more && f && f.sql) Object.assign(src, { full: { sql: f.sql.replace(/\s+LIMIT\s+\d+\s*$/i, ""), columns: ["keys"] }, cut: d.rows.length });
      return src;
    }
    if (ctx.indexOf("c:") === 0){
      const id = ctx.slice(2), f = CFD.data && CFD.data.findings.find(x => x.id === id);
      return f ? { title: f.title + " · " + (CV.cur ? CV.cur.name : ""), keys: keysIn(f.rows.map(r => r.keys)), partial: !!f.more, from: { kind: "canvas-finding", id } } : null;
    }
    if (ctx === "sql" && SQ.last){
      const name = ($("sqlname") && $("sqlname").value.trim()) || "SQL";
      const src = { title: name, keys: keysIn(SQ.last.rows), from: { kind: "sql", sql: SQ.lastSql } };
      if (SQ.last.truncated) Object.assign(src, { full: { sql: SQ.lastSql, columns: SQ.last.columns }, cut: SQ.last.rows.length });
      return src;
    }
    return null;
  }
  function hlDefault(src, type){
    const d = new Date(), two = n => String(n).padStart(2, "0");
    return "Atlas · " + trunc(src ? src.title : "", 40) + " · " + hlWords(type)[1] + " · " + d.getDate() + " " + HL_MON[d.getMonth()] + " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }
  function hlNoteHtml(note){
    if (!note) return "";
    return esc(note.text) + (note.url ? ' <a class="hlopen" href="' + esc(note.url) + '" target="_blank" rel="noopener">Open it in HubSpot ↗</a>' : "");
  }

  function hlHtml(ctx){
    if (!CAN_EDIT) return "";
    // another canvas: what was said of this one's forms does not apply to it
    if (HL.at !== cvKey()){
      HL.at = cvKey();
      Object.keys(HL.note).concat(Object.keys(HL.name), Object.keys(HL.sel))
        .filter(k => (k === "cv" || k.indexOf("c:") === 0) && !HL.busy.has(k))
        .forEach(k => { delete HL.note[k]; delete HL.name[k]; delete HL.sel[k]; });
    }
    const src = hlSource(ctx);
    if (!src || !src.keys.length) return "";
    const n = {};
    src.keys.forEach(k => { const t = hlType(k); n[t] = (n[t] || 0) + 1; });
    const types = HL_TYPES.filter(([t]) => n[t]);
    if (!n[HL.sel[ctx]]) HL.sel[ctx] = types[0][0];
    const sel = HL.sel[ctx], busy = HL.busy.has(ctx), note = HL.note[ctx];
    // a count from rows that were cut short is a floor, not the total
    const plus = src.full ? "+" : "";
    const hint = src.full ? "This stopped at " + fmt(src.cut) + " rows: for a list it is asked again in full, which reads the copy again."
               : src.partial ? "Only the rows worked out here." : "";
    return '<div class="hl" data-hl="' + esc(ctx) + '">' +
      '<span class="hlk">HubSpot list</span>' +
      '<select class="hlsel" aria-label="Which records"' + (busy ? " disabled" : "") + ">" +
        types.map(([t, many]) => '<option value="' + t + '"' + (t === sel ? " selected" : "") + ">" + esc(many) + " · " + fmt(n[t]) + plus + "</option>").join("") +
      "</select>" +
      '<input class="hlname" type="text" maxlength="100" aria-label="Name the HubSpot list" placeholder="' + esc(hlDefault(src, sel)) + '" value="' +
        esc(HL.name[ctx] || "") + '"' + (busy ? " disabled" : "") + ">" +
      '<button type="button" class="act go hlgo"' + (busy ? " disabled" : "") + ">" + (busy ? "Making it…" : "Make the list") + "</button>" +
      (hint ? '<span class="hlhint">' + esc(hint) + "</span>" : "") +
      '<span class="hlnote' + (note && note.bad ? " bad" : "") + '" role="status" aria-live="polite">' + hlNoteHtml(note) + "</span></div>";
  }
  // every copy of a form on screen, drawn again from what is kept
  function hlPaint(ctx){
    document.querySelectorAll('.hl[data-hl="' + ctx + '"]').forEach(f => { f.outerHTML = hlHtml(ctx); });
  }
  function hlSay(ctx, text, bad, url){ HL.note[ctx] = { text, bad: !!bad, url: url || null }; hlPaint(ctx); }

  function hlWhy(e, name){
    const c = e && e.code;
    if (c === "name_taken") return "HubSpot already has a list called “" + name + "”. Give it another name.";
    if (c === "missing_scope") return "HubSpot refused: the Atlas's HubSpot app may not make lists yet (it needs the crm.lists.write scope). Nothing was made.";
    if (c === "not_editor") return "Only the Atlas's editors may make lists in HubSpot.";
    if (c === "bad_ticket") return "The hour for filling this list has passed. Make it again.";
    if (c === "budget") return e.message;
    if (c === "sql_error") return "The query could not be asked again in full: " + e.message + ".";
    if (c === "rate_limited") return "HubSpot is busy. Try again in a moment.";
    if (c === "no_identity") return "You are signed out. Sign in again, then try it.";
    return "It did not go through" + (e && e.message ? ": " + e.message : "") + ".";
  }

  async function hlGo(form){
    const ctx = form.getAttribute("data-hl");
    if (HL.busy.has(ctx)) return;
    const src = hlSource(ctx);
    if (!src){ hlSay(ctx, "Nothing to list yet.", true); return; }
    const type = form.querySelector(".hlsel").value, [, many, one] = hlWords(type);
    const name = ((HL.name[ctx] || "").replace(/\s+/g, " ").trim() || hlDefault(src, type)).slice(0, 100);
    HL.busy.add(ctx);
    let made = null, sent = 0, ids = [];
    try {
      if (src.full){
        hlSay(ctx, "Reading every " + one + " in the full result…");
        const r = await api("/api/lists/keys", { sql: src.full.sql, columns: src.full.columns, type });
        ids = r.ids ? r.ids.split(",") : [];
      } else ids = src.keys.filter(k => hlType(k) === type).map(k => k.split("/")[1]);
      if (!ids.length){ hlSay(ctx, "No " + many + " to list.", true); return; }
      hlSay(ctx, "Making “" + name + "” in HubSpot…");
      made = await api("/api/lists/create", { name, type, planned: ids.length, source: src.from });
      const url = segUrl(made.listId);
      let added = 0, missing = 0;
      for (; sent < ids.length; sent += HL_ADD){
        const part = ids.slice(sent, sent + HL_ADD);
        if (ids.length > HL_ADD) hlSay(ctx, "Adding " + many + " to “" + name + "” · " + fmt(sent + part.length) + " of " + fmt(ids.length) + "…", false, url);
        const r = await api("/api/lists/add", { ticket: made.ticket, ids: part });
        added += r.added || 0; missing += r.missing || 0;
      }
      // the next list starts from a fresh name
      HL.name[ctx] = "";
      hlSay(ctx, "Made “" + name + "” in HubSpot: " + fmt(added) + " " + plural(added, one, many) +
                 (missing ? " · " + fmt(missing) + " no longer in HubSpot, so not added" : "") + ".", false, url);
    } catch(e){
      // the list was made but not all of it went in: say how far it got, and where it is
      if (made) hlSay(ctx, "Made “" + name + "”, but it stopped after " + fmt(sent) + " of " + fmt(ids.length) + " " + many + " · " + hlWhy(e, name), true, segUrl(made.listId));
      else hlSay(ctx, hlWhy(e, name), true);
    } finally { HL.busy.delete(ctx); hlPaint(ctx); }
  }

  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest(".hlgo");
    if (b && !b.disabled) hlGo(b.closest(".hl"));
  });
  document.addEventListener("input", e => {
    const i = e.target.closest && e.target.closest(".hlname");
    if (i) HL.name[i.closest(".hl").getAttribute("data-hl")] = i.value;
  });
  document.addEventListener("change", e => {
    const s = e.target.closest && e.target.closest(".hlsel");
    if (!s) return;
    const f = s.closest(".hl"), ctx = f.getAttribute("data-hl");
    HL.sel[ctx] = s.value;
    f.querySelector(".hlname").placeholder = hlDefault(hlSource(ctx), s.value);
  });
  document.addEventListener("keydown", e => {
    const i = e.key === "Enter" && e.target.closest && e.target.closest(".hlname");
    if (i){ e.preventDefault(); hlGo(i.closest(".hl")); }
  });
