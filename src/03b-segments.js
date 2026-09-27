
  /* =====================================================================
     10b. SEGMENTS — a HubSpot segment brought onto the canvas.
       drop in   its companies land in a field, unwalked (the members, 250
                 a read; a contact or deal segment is traced to the
                 companies its members are on, 1,000 a read)
       mesh      which people on these companies are on another company
                 too, and which — bulk reads, however many there are; the
                 links appear on the map
       walk      the next 100 members walked in full, one after another
     Every run holds the same lock as a walk, can be stopped, and saves as
     it goes. The Worker paces every HubSpot call; nothing is written to it.
     ===================================================================== */
  const SEGCAP = 2000;          // members read per segment
  const SEGWALK = 100;          // companies per press of Walk
  const SEGKIND = {
    "0-2": { one: "company", many: "companies" },
    "0-1": { one: "contact", many: "contacts" },
    "0-3": { one: "deal",    many: "deals" }
  };
  const segUrl = id => "https://app.hubspot.com/contacts/" + PORTAL + "/objectLists/" + encodeURIComponent(id);
  const cidOf = key => String(key).slice(4);            // "0-2/123" -> "123"

  // the run in progress, and whoever wants to hear about it (the panel, the chip)
  let SEGJOB = null;
  const SEGWATCH = new Set();
  const segEmit = () => SEGWATCH.forEach(f => { try { f(); } catch(e){} });

  async function searchSegments(q, types){
    const r = await api("/api/segments?q=" + encodeURIComponent(String(q || "").slice(0, 200)) + "&types=" + encodeURIComponent(types.join(",")));
    const rows = ((r && r.rows) || []).map(s => ({ id: str(s.id), name: str(s.name) || "Segment " + str(s.id), type: str(s.type),
      size: Number(s.size) || 0, live: !!s.live, updated: str(s.updated) || null })).filter(s => s.id && SEGKIND[s.type]);
    return { rows, total: r && r.total != null ? Number(r.total) : null };
  }

  // a company as the field draws it: a name and a domain, nothing more
  const dStub = c => ({ k: companyKey(c.id), kd: "company", id: String(c.id), t: "0-2",
                        l: str(c.name) || "Company " + c.id, s: str(c.domain), ci: [], hh: companyKey(c.id) });
  const packStub = n => ({ k: n.key, kd: "company", id: n.id, t: "0-2", l: n.e.label, s: n.e.sub || "", ci: [], hh: n.key });

  // Rough HubSpot calls, shown on every button before it is pressed.
  function segCost(seg, what){
    const size = Math.min(seg.size || 0, SEGCAP);
    if (what === "drop") return Math.max(1, Math.ceil(size / 250)) + (seg.type === "0-2" ? 0 : Math.ceil(size / 1000)) + Math.ceil(size / 100);
    if (what === "scan"){ const n = ((MAP.segments[seg.id] || {}).members || []).length; return Math.max(1, 3 * Math.ceil(n / 1000) + Math.ceil(n / 150)); }
    if (what === "walk") return segWalkable(seg).slice(0, SEGWALK).length * 15;
    return 0;
  }
  // LINKED: the company shares a record — a person, a deal — with another
  // company. Its own contacts do not count: every walked account has those.
  const isLinked = n => n.adj.some(k => { const m = MAP.byKey[k]; return m && m.kind !== "company" && m.companyIds.length > 1; });
  const SEGSKIP = new Set();    // members HubSpot could not read this session (merged, deleted)
  const segWalkable = seg => {
    const s = MAP.segments[seg.id];
    if (!s) return [];
    const left = s.members.filter(k => !MAP.accounts[cidOf(k)] && MAP.byKey[k] && !SEGSKIP.has(k));
    // members already linked go first: they are where the mesh is
    return left.filter(k => isLinked(MAP.byKey[k])).concat(left.filter(k => !isLinked(MAP.byKey[k])));
  };
  function segStats(id){
    const s = MAP.segments[id];
    if (!s) return null;
    const on = s.members.filter(k => MAP.byKey[k]);
    return { members: on.length, walked: on.filter(k => MAP.accounts[cidOf(k)]).length,
             linked: on.filter(k => isLinked(MAP.byKey[k])).length, mesh: s.mesh };
  }

  /* ---------------- runs ---------------- */
  function segStart(kind, seg, of){
    const job = { kind, seg, stop: false, n: 0, of: of || 0, note: "", log: [], t0: Date.now() };
    job.done = new Promise(res => { job.finish = res; });
    SEGJOB = job; ACQUIRING = true;
    segEmit();
    return job;
  }
  function segEnd(job){
    ACQUIRING = false; SEGJOB = null;
    job.finish(); segEmit();
  }
  function segLog(job, html, cls){
    job.log.push({ html, cls: cls || "", t: clock() });
    if (job.log.length > 40) job.log.shift();
    segEmit();
  }
  // A run may start only when nothing else is rebuilding the model. The
  // claim is made BEFORE the first await: checked after it, two presses
  // during boot both got through, and the first to end freed the lock
  // under the second.
  let SEGPENDING = false;
  const segBusy = () => !!SEGJOB || SEGPENDING;
  async function segReady(){
    if (ACQUIRING || segBusy()) return false;
    SEGPENDING = true; segEmit();
    try { if (BOOT) await BOOT; await stopExpansions(); }
    finally { SEGPENDING = false; }
    // the caller starts its run in this same tick, so nothing can slip in
    return !(ACQUIRING || SEGJOB);
  }
  async function segSaveMembers(seg){
    const nodes = seg.members.map(k => MAP.byKey[k]).filter(Boolean).map(packStub);
    await writeSegmentParts(seg, "p", nodes, []);
    await writeSegmentMeta(seg);
  }
  async function segSaveMesh(seg){
    const nodes = [...seg.meshNodes].map(k => MAP.byKey[k]).filter(Boolean)
      .map(n => n.kind === "company" ? packStub(n) : packNode(n));
    const edges = [...seg.meshEdges].map(id => MAP.edgeSet[id]).filter(Boolean).map(ed => ({ a: ed.a, b: ed.b, r: ed.rel }));
    await writeSegmentParts(seg, "m", nodes, edges);
    await writeSegmentMeta(seg);
  }
  function segShow(fit){
    VIEW.refresh({ fit: !!fit });
    renderRoster(); paintDbChip();
  }

  // DROP IN — or, for a segment already here, REFRESH: members read again,
  // who joined is added, who left is taken off.
  async function segDropIn(meta){
    if (!(await segReady())) return { ok: false, why: "busy" };
    const K = SEGKIND[meta.type];
    const had = MAP.segments[meta.id];
    const job = segStart(had ? "refresh" : "drop", meta, Math.min(meta.size, SEGCAP));
    let left = 0, joined = 0, result = { ok: false };
    try {
      segLog(job, (had ? "Reading the members again · " : "Reading members · ") + "<b>" + esc(meta.name) + "</b>");
      const found = new Map();
      let members = 0, traced = 0, after = null;
      do {
        if (job.stop) break;
        const r = await api("/api/segments/" + encodeURIComponent(meta.id) + "/members", { type: meta.type, after });
        members += Number(r.members) || 0; traced += Number(r.traced) || 0;
        // a member company deleted in HubSpot is not brought in
        ((r && r.companies) || []).forEach(c => { if (c && c.id && !c.deleted) found.set(String(c.id), c); });
        after = r.after || null;
        job.n = members; if (members > job.of) job.of = members;
        job.note = fmt(found.size) + " " + plural(found.size, "company", "companies"); segEmit();
      } while (after && members < SEGCAP);
      if (job.stop && after){ segLog(job, "Stopped before the members were all read · nothing was imported", "err"); return (result = { ok: false, why: "stopped" }); }
      const total = Math.max(meta.size || 0, members);
      const capped = !!after;
      segLog(job, "<b>" + fmt(members) + "</b> " + (members === 1 ? K.one : K.many) +
                  (capped ? " · the first " + fmt(members) + " of " + fmt(total) : ""), capped ? "warn" : "");
      if (meta.type !== "0-2") segLog(job, "<b>" + fmt(found.size) + "</b> " + plural(found.size, "company", "companies") + " on them");
      const companies = [...found.values()];
      const at = new Date().toISOString();
      const seg = had || { id: meta.id, parts: 0, meshParts: 0, mesh: null, meshNodes: new Set(), meshEdges: new Set(), members: [] };
      const before = new Set(seg.members);
      Object.assign(seg, { name: meta.name, type: meta.type, size: total, live: !!meta.live, capped,
                           importedAt: seg.importedAt || at, refreshedAt: had ? at : null,
                           traced: meta.type === "0-2" ? 0 : traced, members: [] });
      companies.forEach(c => {
        const n = mergeNode(dStub(c), at);
        uniqPush(n.segs, seg.id); uniqPush(seg.members, n.key);
        if (!before.has(n.key)) joined++;
      });
      const now = new Set(seg.members);
      before.forEach(k => { if (!now.has(k)){ left++; const n = MAP.byKey[k]; if (n) n.segs = n.segs.filter(id => id !== seg.id); } });
      MAP.segments[seg.id] = seg; uniqPush(MAP.segOrder, seg.id);
      reindex();
      if (had) segLog(job, "<b>+" + fmt(joined) + "</b> joined · <b>−" + fmt(left) + "</b> left since " + esc(ago(had.refreshedAt || had.importedAt)));
      let saved = false;
      try { await segSaveMembers(seg); saved = true; segLog(job, "Saved to this canvas", "ok"); }
      catch(e){ segLog(job, "Not saved — " + esc(why(e)) + " · it is on screen only", "err"); }
      // Who left may be on the map only because the segment put them there.
      // Saved: the canvas is read back without them. Not saved: reading back
      // would bring the OLD members back (or blank the map if the store is
      // down), so they are taken off here instead.
      if (left){
        if (saved) await rebuildFromStore();
        else {
          const gone = new Set([...before].filter(k => !now.has(k) && !MAP.accounts[cidOf(k)] && MAP.byKey[k] && !MAP.byKey[k].segs.length && !MAP.byKey[k].adj.length));
          if (gone.size){ MAP.nodes = MAP.nodes.filter(n => !gone.has(n.key)); gone.forEach(k => { delete MAP.byKey[k]; }); reindex(); }
        }
      }
      result = { ok: true, count: seg.members.length, joined, left };
    } catch(e){
      segLog(job, "HubSpot could not answer · " + esc(why(e)), "err");
      result = { ok: false, why: why(e) };
    } finally {
      segEnd(job);
      segShow(true);
      if (result.ok && PHASE !== "open" && MAP.nodes.length) openMap();
    }
    return result;
  }

  // THE MESH: which people on these companies are on another company too,
  // and which companies — in one run. The connector could say only how many
  // companies a person was on, then needed a read per person to say which.
  async function segMeshScan(id){
    const seg = MAP.segments[id];
    if (!seg || !(await segReady())) return { ok: false, why: "busy" };
    const ids = seg.members.map(cidOf);
    const job = segStart("scan", seg, ids.length);
    try {
      segLog(job, "Looking for people on more than one company among <b>" + fmt(ids.length) + "</b> members");
      const r = await api("/api/mesh", { companyIds: ids });
      const at = new Date().toISOString();
      let linked = 0, outside = 0;
      ((r && r.outside) || []).forEach(c => {
        const k = companyKey(c.id);
        if (!MAP.byKey[k]){ mergeNode(dStub(c), at); outside++; }
        seg.meshNodes.add(k);
      });
      const people = ((r && r.people) || []).filter(p => p && validRecord(p.record));
      people.forEach(p => {
        const cn = mergeNode(p.record, at);
        seg.meshNodes.add(cn.key);
        (p.companies || []).forEach(cid => {
          const k = companyKey(cid);
          if (!MAP.byKey[k]) return;
          seg.meshNodes.add(k);
          const fresh = !MAP.edgeSet[edgeId(cn.key, k)];
          const ed = mergeEdge(cn.key, k, "member");
          if (ed){ seg.meshEdges.add(ed.id); if (fresh) linked++; }
        });
      });
      seg.mesh = { at, found: people.length, done: people.length, pending: [], linked, outside };
      job.n = ids.length; job.note = fmt(linked) + " " + plural(linked, "link"); segEmit();
      reindex();
      try { await segSaveMesh(seg); } catch(e){ segLog(job, "Not saved — " + esc(why(e)), "err"); }
      const st = segStats(seg.id);
      segLog(job, job.stop ? "Done · a mesh is one read, so stopping had nothing to stop" : "Done", "ok");
      segLog(job, "<b>" + fmt(people.length) + "</b> " + plural(people.length, "person", "people") + " on more than one company · <b>" +
                  fmt(linked) + "</b> new " + plural(linked, "link") + " · <b>" + fmt(outside) + "</b> " + plural(outside, "company", "companies") +
                  " outside the segment reached · <b>" + fmt(st.linked) + "</b> of " + fmt(st.members) + " members now linked" +
                  (r && r.calls ? " · " + fmt(r.calls) + " HubSpot " + plural(r.calls, "call") : ""));
      return { ok: true, found: people.length, linked, outside };
    } catch(e){
      segLog(job, "HubSpot could not answer · " + esc(why(e)), "err");
      return { ok: false, why: why(e) };
    } finally { segEnd(job); segShow(true); }
  }

  // WALK the next members, in full, one after another — the same walk as
  // the console's, told to be quiet.
  async function segWalk(id){
    const seg = MAP.segments[id];
    if (!seg || !(await segReady())) return { ok: false, why: "busy" };
    const list = segWalkable(seg).slice(0, SEGWALK);
    if (!list.length) return { ok: false, why: "nothing left" };
    const job = segStart("walk", seg, list.length);
    let walked = 0, failed = 0, unsaved = 0, incomplete = 0, dead = 0, halted = false, full = false, threw = false;
    try {
      segLog(job, "Walking <b>" + fmt(list.length) + "</b> " + plural(list.length, "company", "companies") + " · about " + fmt(list.length * 15) + " HubSpot calls");
      for (const k of list){
        if (job.stop) break;
        const cid = cidOf(k);
        if (MAP.accounts[cid]){ job.n++; continue; }          // walked by hand since the list was made
        const label = MAP.byKey[k] ? MAP.byKey[k].e.label : cid;
        try {
          const res = await walkCore(cid, QUIET_R);
          // HubSpot answered that the company cannot be read (merged, deleted):
          // not a failing link, and not worth trying again this session
          if (!res.ok){ failed++; SEGSKIP.add(k); segLog(job, esc(trunc(label, 34)) + " · could not be read · skipped", "err"); }
          else {
            walked++; dead = 0;
            if (!res.saved.ok) unsaved++;
            // a full store saves nothing more: walking on would only spend reads
            if (!res.saved.ok && /quota/.test(String(res.saved.why))){
              segLog(job, "The page’s store is full · walks are no longer kept · halted. Remove a segment or canvas you no longer need.", "err");
              halted = full = true; job.n++; break;
            }
            if (res.missed) incomplete++;
            segLog(job, esc(trunc(res.name || label, 34)) + " · " + res.touched + " records" + (res.shared ? " · <b>" + res.shared + " shared</b>" : "") +
                        (res.missed ? " · incomplete" : ""), res.missed || !res.saved.ok ? "warn" : "");
          }
        } catch(e){
          failed++; dead++; threw = true;
          segLog(job, esc(trunc(label, 34)) + " · " + esc(why(e)), "err");
          if (e && e.code === "no_identity"){ halted = true; break; }
        }
        job.n++; job.note = fmt(walked) + " walked" + (failed ? " · " + failed + " failed" : "");
        segEmit();
        if (dead >= 3){ halted = true; break; }
        if (walked && walked % 5 === 0) segShow(false);
      }
      const leftN = segWalkable(seg).length;
      segLog(job, full ? "Halted · the store is full" : halted ? "HubSpot stopped answering · halted" : job.stop ? "Stopped" : "Done", halted || job.stop ? "err" : "ok");
      segLog(job, "<b>" + fmt(walked) + "</b> walked" + (incomplete ? " · " + incomplete + " incomplete" : "") + (failed ? " · " + failed + " failed" : "") +
                  (unsaved ? " · " + unsaved + " not saved" : "") + " · <b>" + fmt(leftN) + "</b> left in the segment");
      // a walk that threw part-way left records merged but never saved:
      // the canvas is read back so the map shows only what is kept
      if (threw && DB_STATE.up){ try { await rebuildFromStore(); } catch(e){} }
      return { ok: true, walked, failed };
    } finally { segEnd(job); segShow(true); }
  }

  // Take a segment off the canvas: its field goes, and so does anything
  // only it put there. Accounts walked from it stay — they are walks.
  async function segRemove(id){
    const seg = MAP.segments[id];
    if (!seg || !(await segReady())) return { ok: false, why: "busy" };
    const job = segStart("remove", seg, 1);
    try {
      await deleteSegmentDocs(seg);
      await rebuildFromStore();
      return { ok: true };
    } catch(e){ return { ok: false, why: why(e) }; }
    finally { segEnd(job); segShow(true); paintGateMap(); }
  }
