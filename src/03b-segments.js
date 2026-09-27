
  /* =====================================================================
     10b. SEGMENTS — a HubSpot segment brought onto the canvas.
       drop in   its companies land in a field, unwalked (1 read / 200)
                 contact and deal segments are traced to their companies
                 first (1 read / 100 members)
       mesh      scan: contacts on 2+ companies among the members
                 (1 read / 100 companies), then trace each one's companies
                 (1 read / person) — the links appear on the map
       walk      the next 100 members walked in full, ~12 reads each
     Every run holds the same lock as a walk, runs paced (PACE.gap), can be
     stopped, and saves as it goes. Nothing is written to HubSpot.
     ===================================================================== */
  const SEGCAP = 2000;          // members read per segment
  const SEGWALK = 100;          // companies per press of Walk
  // ms between calls in a run: under 3 a second (a test page may shorten it)
  const SEGPACE = typeof window.__atlasPace === "number" ? window.__atlasPace : 340;
  const SEGKIND = {
    "0-2": { obj: "COMPANY", assoc: "companies", one: "company", many: "companies", props: ["name", "domain"] },
    "0-1": { obj: "CONTACT", assoc: "contacts",  one: "contact", many: "contacts",  props: ["firstname", "lastname", "email"] },
    "0-3": { obj: "DEAL",    assoc: "deals",     one: "deal",    many: "deals",     props: ["dealname"] }
  };
  const segUrl = id => "https://app.hubspot.com/contacts/" + PORTAL + "/objectLists/" + encodeURIComponent(id);
  const cidOf = key => String(key).slice(4);            // "0-2/123" -> "123"

  // the run in progress, and whoever wants to hear about it (the panel, the chip)
  let SEGJOB = null;
  const SEGWATCH = new Set();
  const segEmit = () => SEGWATCH.forEach(f => { try { f(); } catch(e){} });
  const SEGROWS = new Map();    // list id -> Map(contact id -> row) found by a mesh scan, this session

  function segFromRow(x){
    const p = x.properties || {};
    return { id: str(p.hs_list_id), name: str(p.hs_list_name) || "Segment " + str(p.hs_list_id), type: str(p.hs_object_type_id),
             size: Number(p.hs_list_size) || 0, live: p.hs_is_active_list === "true", updated: str(p.hs_lastmodifieddate) || null };
  }
  async function searchSegments(q, types){
    const args = {
      objectType: "OBJECT_LIST", limit: 40,
      properties: ["hs_list_name", "hs_list_id", "hs_list_size", "hs_object_type_id", "hs_is_active_list", "hs_lastmodifieddate"],
      filterGroups: [{ filters: [{ propertyName: "hs_object_type_id", operator: "IN", values: types }] }],
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }]
    };
    if (q) args.query = String(q).slice(0, 200);
    const r = await hubspot(args);
    return { rows: ((r && r.results) || []).map(segFromRow).filter(s => s.id && SEGKIND[s.type]), total: r && r.total != null ? Number(r.total) : null };
  }

  // a company as the field draws it: a name and a domain, nothing more
  const dStub = x => { const p = x.properties || {}; return { k: companyKey(x.id), kd: "company", id: String(x.id), t: "0-2",
                                                              l: p.name || "Company " + x.id, s: p.domain || "", ci: [], hh: companyKey(x.id) }; };
  const packStub = n => ({ k: n.key, kd: "company", id: n.id, t: "0-2", l: n.e.label, s: n.e.sub || "", ci: [], hh: n.key });

  // Rough costs, shown on every button before it is pressed.
  function segCost(seg, what){
    const size = Math.min(seg.size || 0, SEGCAP);
    if (what === "drop") return Math.max(1, Math.ceil(size / 200)) + (seg.type === "0-2" ? 0 : Math.ceil(size / 100));
    if (what === "scan") return Math.max(1, Math.ceil(((MAP.segments[seg.id] || {}).members || []).length / 100));
    if (what === "trace"){ const m = (MAP.segments[seg.id] || {}).mesh; return m ? m.pending.length : 0; }
    if (what === "walk") return segWalkable(seg).slice(0, SEGWALK).length * 12;
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
    SEGJOB = job; ACQUIRING = true; PACE.gap = SEGPACE;
    segEmit();
    return job;
  }
  function segEnd(job){
    PACE.gap = 0; ACQUIRING = false; SEGJOB = null;
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
      const m = await hubspotAll({ objectType: K.obj, properties: K.props, limit: 200,
        filterGroups: [{ filters: [{ propertyName: "ilsListIds", operator: "EQ", value: meta.id }] }],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }] },
        SEGCAP, (n, total) => { job.n = n; if (total != null) job.of = Math.min(total, SEGCAP); segEmit(); });
      const rows = m.rows, total = m.total != null ? m.total : rows.length;
      const capped = total > rows.length;
      segLog(job, "<b>" + fmt(rows.length) + "</b> " + (rows.length === 1 ? K.one : K.many) +
                  (capped ? " · the " + fmt(SEGCAP) + " most recently created of " + fmt(total) : ""), capped ? "warn" : "");
      let companies = rows;
      if (meta.type !== "0-2"){
        segLog(job, "Tracing " + K.many + " to their companies");
        const found = new Map();
        job.n = 0; job.of = rows.length;
        for (let i = 0; i < rows.length; i += 100){
          if (job.stop) break;
          const ids = rows.slice(i, i + 100).map(x => Number(x.id));
          const r = await hubspotAll({ objectType: "COMPANY", properties: ["name", "domain"], limit: 200,
            filterGroups: [{ associatedWith: [{ objectType: K.assoc, operator: "IN", objectIdValues: ids }] }] }, 5000);
          r.rows.forEach(c => found.set(String(c.id), c));
          job.n = Math.min(i + 100, rows.length); job.note = fmt(found.size) + " companies"; segEmit();
        }
        if (job.stop){ segLog(job, "Stopped before the companies were all found · nothing was imported", "err"); return (result = { ok: false, why: "stopped" }); }
        companies = [...found.values()];
        segLog(job, "<b>" + fmt(companies.length) + "</b> " + plural(companies.length, "company", "companies") + " on them");
      }
      const at = new Date().toISOString();
      const seg = had || { id: meta.id, parts: 0, meshParts: 0, mesh: null, meshNodes: new Set(), meshEdges: new Set(), members: [] };
      const before = new Set(seg.members);
      Object.assign(seg, { name: meta.name, type: meta.type, size: total, live: !!meta.live, capped,
                           importedAt: seg.importedAt || at, refreshedAt: had ? at : null,
                           traced: meta.type === "0-2" ? 0 : rows.length, members: [] });
      companies.forEach(x => {
        const n = mergeNode(dStub(x), at);
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

  // MESH, part one: which contacts on these companies are on another
  // company too. HubSpot counts a contact's companies, so this is one read
  // per 100 members — but it cannot say WHICH companies.
  async function segMeshScan(id){
    const seg = MAP.segments[id];
    if (!seg || !(await segReady())) return { ok: false, why: "busy" };
    const ids = seg.members.map(k => Number(cidOf(k)));
    const job = segStart("scan", seg, ids.length);
    const found = new Map();
    try {
      segLog(job, "Looking for people on more than one company among <b>" + fmt(ids.length) + "</b> members");
      for (let i = 0; i < ids.length; i += 100){
        if (job.stop) break;
        const r = await hubspotAll({ objectType: "CONTACT", properties: ASKFOR.CONTACT, limit: 200,
          filterGroups: [{ associatedWith: [{ objectType: "companies", operator: "IN", objectIdValues: ids.slice(i, i + 100) }],
                           filters: [{ propertyName: "number_of_associated_companies", operator: "GT", value: "1" }] }] }, 5000);
        r.rows.forEach(x => found.set(String(x.id), x));
        job.n = Math.min(i + 100, ids.length); job.note = fmt(found.size) + " found"; segEmit();
      }
      const traced = new Set([...seg.meshNodes].filter(k => k.indexOf("0-1/") === 0).map(cidOf));
      const complete = !(job.stop && job.n < ids.length);
      let pending = [...found.keys()].filter(c => !traced.has(c));
      // a scan stopped part-way only ADDS to what an earlier scan queued
      if (!complete && seg.mesh) pending = [...new Set(seg.mesh.pending.concat(pending))].filter(c => !traced.has(c));
      pending = pending.slice(0, 5000);
      const rows = SEGROWS.get(seg.id) || new Map();
      found.forEach((v, k) => rows.set(k, v));
      SEGROWS.set(seg.id, rows);
      const foundN = complete ? found.size : Math.max(found.size, (seg.mesh && seg.mesh.found) || 0);
      seg.mesh = Object.assign({ at: null, found: 0, done: 0, pending: [], linked: 0, outside: 0 }, seg.mesh || {},
                               { found: foundN, pending, done: traced.size });
      segLog(job, job.stop && job.n < ids.length ? "Stopped · " + fmt(job.n) + " of " + fmt(ids.length) + " members looked at" : "Done", job.stop ? "err" : "ok");
      segLog(job, "<b>" + fmt(found.size) + "</b> " + plural(found.size, "person", "people") + " on more than one company" +
                  (traced.size ? " · " + fmt(traced.size) + " already traced" : "") +
                  (pending.length ? " · <b>" + fmt(pending.length) + "</b> to trace, one read each" : ""));
      try { await writeSegmentMeta(seg); } catch(e){}
      return { ok: true, found: found.size, pending: pending.length };
    } catch(e){
      segLog(job, "HubSpot could not answer · " + esc(why(e)), "err");
      return { ok: false, why: why(e) };
    } finally { segEnd(job); }
  }

  // contacts a scan found but whose rows this session never saw (the page
  // was reloaded between the two parts): read back 100 at a time
  async function segContactRows(seg, ids){
    const rows = SEGROWS.get(seg.id) || new Map();
    const missing = ids.filter(c => !rows.has(c));
    for (let i = 0; i < missing.length; i += 100){
      // a person whose row cannot be read is still traced, under their id
      try {
        const r = await hubspot({ objectType: "CONTACT", properties: ASKFOR.CONTACT, limit: 100,
          filterGroups: [{ filters: [{ propertyName: "hs_object_id", operator: "IN", values: missing.slice(i, i + 100) }] }] });
        ((r && r.results) || []).forEach(x => rows.set(String(x.id), x));
      } catch(e){}
    }
    SEGROWS.set(seg.id, rows);
    return rows;
  }

  // MESH, part two: each person's companies — the links themselves.
  async function segMeshTrace(id){
    const seg = MAP.segments[id];
    if (!seg || !seg.mesh || !seg.mesh.pending.length || !(await segReady())) return { ok: false, why: "busy" };
    const list = seg.mesh.pending.slice();
    const job = segStart("trace", seg, list.length);
    let linked = 0, outside = 0, failed = 0, dead = 0, halted = false, sinceSave = 0;
    const save = async () => { sinceSave = 0; try { await segSaveMesh(seg); return true; } catch(e){ segLog(job, "Not saved — " + esc(why(e)), "err"); return false; } };
    try {
      segLog(job, "Tracing <b>" + fmt(list.length) + "</b> " + plural(list.length, "person", "people") + " to their companies");
      const rows = await segContactRows(seg, list);
      const at = new Date().toISOString();
      seg.mesh.at = at;
      for (const c of list){
        if (job.stop) break;
        let cos;
        try { cos = await byAssoc("COMPANY", "contacts", [c], ["name", "domain"], 100, "EQUAL"); dead = 0; }
        catch(e){
          failed++;
          // three in a row with nothing answered is the connector or the quota
          if (++dead >= 3){ halted = true; break; }
          continue;
        }
        const onMap = cos.find(x => MAP.byKey[companyKey(x.id)]) || cos[0];
        const cn = mergeNode(dContact(rows.get(c) || { id: c, properties: {} }, onMap ? onMap.id : null, onMap ? companyKey(onMap.id) : null), at);
        seg.meshNodes.add(cn.key);
        cos.forEach(x => {
          const k = companyKey(x.id);
          if (!MAP.byKey[k]){ outside++; mergeNode(dStub(x), at); }
          seg.meshNodes.add(k);
          const fresh = !MAP.edgeSet[edgeId(cn.key, k)];
          const ed = mergeEdge(cn.key, k, "member");
          if (ed){ seg.meshEdges.add(ed.id); if (fresh) linked++; }
        });
        seg.mesh.pending = seg.mesh.pending.filter(p => p !== c);
        seg.mesh.done++; job.n++;
        job.note = fmt(linked) + " links · " + fmt(outside) + " outside the segment";
        segEmit();
        // what is traced is kept as it goes, so a stop or a closed tab loses little
        if (++sinceSave >= 25){ reindex(); segShow(false); await save(); }
      }
      seg.mesh.linked += linked; seg.mesh.outside += outside;
      reindex();
      await save();
      const st = segStats(seg.id);
      segLog(job, halted ? "HubSpot stopped answering · halted" : job.stop && seg.mesh.pending.length ? "Stopped · " + fmt(seg.mesh.pending.length) + " left to trace" : "Done",
             halted || job.stop ? "err" : "ok");
      segLog(job, "<b>" + fmt(linked) + "</b> new " + plural(linked, "link") + " · <b>" + fmt(outside) + "</b> " +
                  plural(outside, "company", "companies") + " outside the segment reached · <b>" + fmt(st.linked) + "</b> of " +
                  fmt(st.members) + " members now linked" + (failed ? " · " + failed + " " + plural(failed, "read") + " refused" : ""));
      return { ok: true, linked, outside };
    } catch(e){
      segLog(job, "The trace could not be completed · " + esc(why(e)), "err");
      try { await save(); } catch(x){}
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
      segLog(job, "Walking <b>" + fmt(list.length) + "</b> " + plural(list.length, "company", "companies") + " · about " + fmt(list.length * 12) + " reads");
      for (const k of list){
        if (job.stop) break;
        const cid = cidOf(k);
        if (MAP.accounts[cid]){ job.n++; continue; }          // walked by hand since the list was made
        const label = MAP.byKey[k] ? MAP.byKey[k].e.label : cid;
        try {
          const res = await walkCore(cid, QUIET_R);
          // HubSpot answered that the company cannot be read (merged, deleted):
          // not a failing connector, and not worth trying again this session
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
          if (e && e.code === "no_connector"){ halted = true; break; }
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
      SEGROWS.delete(seg.id);
      await rebuildFromStore();
      return { ok: true };
    } catch(e){ return { ok: false, why: why(e) }; }
    finally { segEnd(job); segShow(true); paintGateMap(); }
  }
