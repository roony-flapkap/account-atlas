
  /* =====================================================================
     6b. CANVASES — each an independent map with its own walked accounts,
     its own records opened out by Expand search, and its own arrangement.
       shared   canvases/<id>                 everyone the page is shared with
       private  data/users/<viewer>/c_<id>    this viewer alone, owner included
     under each: accounts/<companyId>, expansions/<record> and segments/
     (s_<listId> plus its parts s_<listId>~p0…, ~m0… for what its mesh found). The map that
     existed before canvases is the shared canvas "main": its accounts stay
     in the root `accounts` collection, so nothing had to be moved.
     ===================================================================== */
  const MAIN_ID = "main";
  const CV = { cur: null, list: [], uid: null, skipped: [] };
  const LAST_KEY = "atlas.canvas";

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const cvName = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, 60);
  const sameCanvas = (a, b) => !!a && !!b && a.id === b.id && a.scope === b.scope;
  const isMain = c => c.scope === "shared" && c.id === MAIN_ID;
  const safeKey = k => String(k).replace(/[^A-Za-z0-9_\-.~:@+]/g, "_");

  function metaRef(db, c){
    return c.scope === "private" ? db.doc("data/users/" + CV.uid + "/c_" + c.id) : db.doc("canvases/" + c.id);
  }
  function accountsCol(db, c){ return isMain(c) ? db.collection("accounts") : metaRef(db, c).collection("accounts"); }
  function expansionsCol(db, c){ return metaRef(db, c).collection("expansions"); }
  function segmentsCol(db, c){ return metaRef(db, c).collection("segments"); }
  const segDocId = id => "s_" + safeKey(id);
  const why = e => String((e && e.code) || "unavailable").replace(/_/g, " ");
  // Copying or emptying a canvas is a run of writes, and the store meters
  // calls per viewer: a write turned away for pace or a passing fault is
  // tried again after a pause instead of leaving the copy half made.
  async function steady(fn){
    for (let i = 0; ; i++){
      try { return await fn(); }
      catch(e){
        const code = e && e.code;
        if (i >= 3 || (code !== "resource_exhausted" && code !== "unavailable")) throw e;
        await new Promise(r => setTimeout(r, 500 * (i + 1) + Math.random() * 400));   // not wait(): that one skips for reduced motion
      }
    }
  }

  // The arrangement is stored as ONE string, not an object: the store's
  // update merges nested objects key by key, so a record dragged and then
  // let go of — or a hive put back — would never leave a stored object.
  function readView(d){
    if (typeof d.v === "string"){ try { const v = JSON.parse(d.v); if (v && typeof v === "object") return v; } catch(e){} }
    return d.view && typeof d.view === "object" ? d.view : null;
  }
  function packView(v){
    v = v && typeof v === "object" ? v : {};
    let s = JSON.stringify(v);
    // positions are the one part that grows with the map; past the budget
    // the canvas keeps its layout, filters and camera and lets them go
    if (bytes(s) > DOC_BYTES - 8000) s = JSON.stringify(Object.assign({}, v, { pos: { ring: {}, tree: {} }, hoff: {} }));
    return s;
  }

  // Everything read back from the store is shaped before it is used: the
  // store is written by every viewer.
  function normCanvas(id, scope, d, exists){
    d = d && typeof d === "object" ? d : {};
    return {
      id: String(id), scope, exists: !!exists,
      name: cvName(str(d.name)) || (id === MAIN_ID && scope === "shared" ? "Main map" : "Untitled canvas"),
      count: typeof d.count === "number" ? d.count : null,
      createdAt: str(d.createdAt) || null, updatedAt: str(d.updatedAt) || null,
      view: readView(d)
    };
  }

  async function listCanvases(){
    const db = await use("db");
    const out = [];
    if (db){
      // both lists at once; either can fail without costing the other
      const none = { docs: [] };
      const read = path => { try { return db.collection(path).limit(1000).get().catch(() => none); } catch(e){ return none; } };
      const [shared, mine] = await Promise.all([read("canvases"), CV.uid ? read("data/users/" + CV.uid) : none]);
      shared.docs.forEach(s => { if (s.data()) out.push(normCanvas(s.id, "shared", s.data(), true)); });
      mine.docs.forEach(s => { if (/^c_/.test(s.id) && s.data()) out.push(normCanvas(s.id.slice(2), "private", s.data(), true)); });
    }
    // the original map is always there, whether or not it has a record yet
    if (!out.some(c => isMain(c))) out.push(normCanvas(MAIN_ID, "shared", null, false));
    // the open canvas stays the SAME object, refreshed from the read, so a
    // rename from the list reaches the chip, the gate and the roster
    const at = out.findIndex(c => sameCanvas(c, CV.cur));
    if (at >= 0){
      const f = out[at];
      Object.assign(CV.cur, { name: f.name, count: f.count, updatedAt: f.updatedAt, exists: f.exists });
      out[at] = CV.cur;
    }
    const rank = c => isMain(c) ? 0 : c.scope === "shared" ? 1 : 2;
    out.sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
    CV.list = out;
    return out;
  }

  // The canvas's own record. The Main map has none until it is first renamed
  // or arranged, so the first write creates it rather than merging into it.
  async function writeMeta(c, patch){
    const db = await use("db");
    if (!db) throw { code: "unavailable" };
    const body = Object.assign({}, patch, { updatedAt: new Date().toISOString() });
    if ("view" in body){ body.v = packView(body.view); delete body.view; }
    if (c.exists) await metaRef(db, c).update(body);
    else {
      await metaRef(db, c).set(Object.assign({ name: c.name, scope: c.scope, createdAt: c.createdAt || body.updatedAt,
                                               count: c.count || 0 }, body));
      c.exists = true;
    }
    c.updatedAt = body.updatedAt;
    ["name", "count", "view"].forEach(k => { if (k in patch) c[k] = patch[k]; });
  }

  async function createCanvas(name, scope, view, createdAt){
    const db = await use("db");
    if (!db) throw { code: "unavailable" };
    if (scope === "private" && !CV.uid) throw { code: "no_identity" };
    const c = normCanvas(newId(), scope, { name }, false);
    c.createdAt = createdAt || new Date().toISOString();
    await writeMeta(c, { name: c.name, count: 0, view: view || {} });
    CV.list.push(c);
    return c;
  }

  // Everything under a canvas, read in full — its accounts and its saved
  // expansions — for opening, copying or deleting it.
  async function canvasDocs(c){
    const db = await use("db");
    const [a, x, g] = await Promise.all([accountsCol(db, c).limit(1000).get(), expansionsCol(db, c).limit(1000).get(),
                                         segmentsCol(db, c).limit(1000).get()]);
    return { accounts: a.docs, expansions: x.docs, segments: g.docs };
  }

  async function duplicateCanvas(src, name, scope, view, onProgress, createdAt){
    const db = await use("db");
    const { accounts, expansions, segments } = await canvasDocs(src);
    const dst = await createCanvas(name, scope, view, createdAt);
    let done = 0;
    const total = accounts.length + expansions.length + segments.length;
    try {
      for (const s of accounts){ await steady(() => accountsCol(db, dst).doc(s.id).set(JSON.parse(JSON.stringify(s.data())))); onProgress && onProgress(++done, total); }
      for (const s of expansions){ await steady(() => expansionsCol(db, dst).doc(s.id).set(JSON.parse(JSON.stringify(s.data())))); onProgress && onProgress(++done, total); }
      for (const s of segments){ await steady(() => segmentsCol(db, dst).doc(s.id).set(JSON.parse(JSON.stringify(s.data())))); onProgress && onProgress(++done, total); }
      await writeMeta(dst, { count: accounts.length });
    } catch(e){
      // a copy that stopped part-way is not left behind looking complete
      try { await deleteCanvas(dst); } catch(x){ CV.list = CV.list.filter(c => !sameCanvas(c, dst)); }
      throw e;
    }
    return dst;
  }

  // A private canvas made SHARED — everyone the page is shared with can
  // then open and change it. It is copied whole (accounts, opened-out
  // records, segments, arrangement), and only once the copy is complete is
  // the private original deleted, so a failure part-way loses nothing.
  async function shareCanvas(c, view, onProgress){
    if (c.scope !== "private") throw { code: "not_private" };
    const dst = await duplicateCanvas(c, c.name, "shared", view, (i, n) => onProgress && onProgress("copy", i, n), c.createdAt);
    try { await deleteCanvas(c, (i, n) => onProgress && onProgress("clear", i, n)); }
    catch(e){ return { dst, leftover: true }; }
    return { dst, leftover: false };
  }

  // Deleting a document leaves the documents under it, so a canvas is
  // emptied first and its own record goes last.
  async function deleteCanvas(c, onProgress){
    const db = await use("db");
    const { accounts, expansions, segments } = await canvasDocs(c);
    let done = 0;
    const total = accounts.length + expansions.length + segments.length;
    for (const s of accounts){ await steady(() => accountsCol(db, c).doc(s.id).delete()); onProgress && onProgress(++done, total); }
    for (const s of expansions){ await steady(() => expansionsCol(db, c).doc(s.id).delete()); onProgress && onProgress(++done, total); }
    for (const s of segments){ await steady(() => segmentsCol(db, c).doc(s.id).delete()); onProgress && onProgress(++done, total); }
    await steady(() => metaRef(db, c).delete());
    CV.list = CV.list.filter(x => !sameCanvas(x, c));
  }

  /* ---------------- the current canvas's map ---------------- */
  async function saveAccount(doc){
    const db = await use("db");
    if (!db) return { ok: false, why: "no store in this view" };
    try {
      await accountsCol(db, CV.cur).doc(doc.companyId).set(doc);
      writeMeta(CV.cur, { count: MAP.order.length }).catch(() => {});
      return { ok: true };
    } catch(e){ return { ok: false, why: why(e) }; }
  }
  async function forgetAccount(cid){
    const db = await use("db");
    if (!db) return false;
    try { await accountsCol(db, CV.cur).doc(String(cid)).delete(); return true; } catch(e){ return false; }
  }

  // One document per record opened out: what came back, and the links from
  // the record to each. The record's own key names the document, so opening
  // it out again overwrites rather than piles up.
  async function saveExpansion(node, r){
    const db = await use("db");
    if (!db) return { ok: false, why: "no store in this view" };
    const nodes = r.keys.map(k => MAP.byKey[k]).filter(Boolean).map(n => {
      const d = packNode(n);
      if (r.fresh.indexOf(n.key) >= 0) d.p = node.key;    // it arrived from this record
      return d;
    });
    const edges = r.keys.map(k => MAP.edgeSet[edgeId(node.key, k)]).filter(Boolean).map(ed => ({ a: ed.a, b: ed.b, r: ed.rel }));
    const doc = { from: node.key, at: new Date().toISOString(), nodes, edges };
    if (bytes(JSON.stringify(doc)) > DOC_BYTES) doc.nodes.forEach(d => { delete d.f; });
    try { await expansionsCol(db, CV.cur).doc(safeKey(node.key)).set(doc); return { ok: true }; }
    catch(e){ return { ok: false, why: why(e) }; }
  }

  // A canvas, in one pass: its accounts merged oldest FIRST walk first — so
  // a record keeps the hive of the account that found it and every hive
  // goes back where it was — then its expansions in the order they were
  // made, each only if the record it came out of is still on the map.
  async function loadCanvas(c){
    CV.skipped = [];
    const db = await use("db");
    if (!db){ resetMap(); DB_STATE = { known: true, up: false, why: "not available in this view" }; return 0; }
    let got;
    try { got = await canvasDocs(c); }
    catch(e){ resetMap(); DB_STATE = { known: true, up: false, why: why(e) }; return 0; }
    // emptied only once the documents are in hand, and rebuilt in one go: an
    // empty map while they were read let a click on a record find nothing
    resetMap();
    DB_STATE = { known: true, up: true, why: "connected" };
    const first = d => String(d.firstWalkedAt || d.walkedAt || "");
    const docs = got.accounts.map(s => s.data()).filter(d => d && d.companyId)
      .sort((a, b) => first(a) < first(b) ? -1 : first(a) > first(b) ? 1 : 0);
    // one bad document costs its own account, never the whole canvas
    let n = 0;
    docs.forEach(d => { try { applyDoc(d); n++; } catch(e){} });
    applySegments(got.segments);
    got.expansions.map(s => ({ id: s.id, d: s.data() }))
      .filter(x => x.d && typeof x.d.from === "string")
      .sort((a, b) => String(a.d.at || "").localeCompare(String(b.d.at || "")))
      .forEach(x => {
        const from = MAP.byKey[x.d.from];
        if (!from){ CV.skipped.push(x.id); return; }
        try {
          const at = str(x.d.at);
          (Array.isArray(x.d.nodes) ? x.d.nodes : []).forEach(d => {
            if (!validRecord(d)) return;
            const isNew = !MAP.byKey[d.k];
            const m = mergeNode(d, at);
            if (isNew && typeof d.p === "string") m.parentKey = d.p;
          });
          (Array.isArray(x.d.edges) ? x.d.edges : []).forEach(e => {
            if (e && typeof e.a === "string" && typeof e.b === "string" && ["member", "link", "detached"].indexOf(e.r) >= 0) mergeEdge(e.a, e.b, e.r);
          });
          from.xd = true;
        } catch(e){}
      });
    reindex();
    return n;
  }
  /* ---------------- segments on the current canvas ---------------- */
  const SEG_TYPES = ["0-2", "0-1", "0-3"];
  const intOf = v => Number(v) > 0 ? Math.floor(Number(v)) : 0;
  function cleanMesh(m){
    if (!m || typeof m !== "object") return null;
    return { at: str(m.at) || null, found: intOf(m.found), done: intOf(m.done),
             pending: Array.isArray(m.pending) ? m.pending.map(str).filter(v => /^\d+$/.test(v)).slice(0, 5000) : [],
             linked: intOf(m.linked), outside: intOf(m.outside) };
  }
  // where a set on the canvas came from, when it is not a HubSpot segment:
  // a SQL query (run again on refresh) or a finding (asked again)
  function cleanSource(s){
    if (!s || typeof s !== "object") return null;
    if (s.kind === "sql" && typeof s.sql === "string" && s.sql.trim()) return { kind: "sql", sql: s.sql.slice(0, 20000) };
    if (s.kind === "finding" && /^[a-z0-9-]{1,40}$/.test(String(s.id || ""))) return { kind: "finding", id: s.id };
    return null;
  }
  // A segment is a meta document plus parts, each part under the size a
  // document may be. The members' parts (~p) are written on import and on
  // refresh; the mesh's (~m) as it runs, so a stopped mesh keeps its work.
  function applySegments(snaps){
    const byId = {};
    (snaps || []).forEach(s => { try { byId[s.id] = s.data(); } catch(e){} });
    const metas = Object.keys(byId).filter(id => /^s_[^~]+$/.test(id)).map(id => byId[id])
      .filter(d => d && typeof d.listId === "string" && SEG_TYPES.indexOf(d.type) >= 0)
      .sort((a, b) => String(a.importedAt || "").localeCompare(String(b.importedAt || "")));
    metas.forEach(d => {
      const seg = { id: d.listId, name: str(d.name) || "Segment " + d.listId, type: d.type, size: intOf(d.size), live: !!d.live,
                    importedAt: str(d.importedAt) || null, refreshedAt: str(d.refreshedAt) || null, capped: !!d.capped,
                    parts: intOf(d.parts), meshParts: intOf(d.meshParts), mesh: cleanMesh(d.mesh), members: [], traced: intOf(d.traced),
                    source: cleanSource(d.source), meshNodes: new Set(), meshEdges: new Set() };
      const apply = (part, at, isMember) => {
        if (!part || typeof part !== "object") return;
        (Array.isArray(part.nodes) ? part.nodes : []).forEach(r => {
          if (!validRecord(r)) return;
          const isNew = !MAP.byKey[r.k];
          const m = mergeNode(r, at);
          if (isNew && typeof r.p === "string") m.parentKey = r.p;
          if (isMember && m.kind === "company"){ uniqPush(m.segs, seg.id); uniqPush(seg.members, m.key); }
          if (!isMember) seg.meshNodes.add(m.key);
        });
        (Array.isArray(part.edges) ? part.edges : []).forEach(e => {
          if (e && typeof e.a === "string" && typeof e.b === "string" && ["member", "link", "detached"].indexOf(e.r) >= 0){
            const ed = mergeEdge(e.a, e.b, e.r);
            if (ed && !isMember) seg.meshEdges.add(ed.id);
          }
        });
      };
      try {
        for (let i = 0; i < seg.parts; i++) apply(byId[segDocId(seg.id) + "~p" + i], seg.refreshedAt || seg.importedAt, true);
        for (let i = 0; i < seg.meshParts; i++) apply(byId[segDocId(seg.id) + "~m" + i], seg.mesh && seg.mesh.at, false);
      } catch(e){}
      MAP.segments[seg.id] = seg;
      uniqPush(MAP.segOrder, seg.id);
    });
  }
  function chunkPayload(nodes, edges){
    const parts = [];
    let cur = { nodes: [], edges: [] }, size = 64;
    const push = (kind, item) => {
      const b = bytes(JSON.stringify(item)) + 1;
      if (size + b > DOC_BYTES && (cur.nodes.length || cur.edges.length)){ parts.push(cur); cur = { nodes: [], edges: [] }; size = 64; }
      cur[kind].push(item); size += b;
    };
    nodes.forEach(n => push("nodes", n));
    edges.forEach(e => push("edges", e));
    if (cur.nodes.length || cur.edges.length || !parts.length) parts.push(cur);
    return parts;
  }
  // kind "p": the members; "m": what the mesh traced
  async function writeSegmentParts(seg, kind, nodes, edges){
    const db = await use("db");
    if (!db) throw { code: "unavailable" };
    const col = segmentsCol(db, CV.cur), key = kind === "p" ? "parts" : "meshParts";
    const parts = chunkPayload(nodes, edges), old = seg[key] || 0;
    for (let i = 0; i < parts.length; i++){ const body = parts[i]; await steady(() => col.doc(segDocId(seg.id) + "~" + kind + i).set(body)); }
    for (let i = parts.length; i < old; i++){ try { await steady(() => col.doc(segDocId(seg.id) + "~" + kind + i).delete()); } catch(e){} }
    seg[key] = parts.length;
  }
  async function writeSegmentMeta(seg){
    const db = await use("db");
    if (!db) throw { code: "unavailable" };
    const body = { listId: seg.id, name: seg.name, type: seg.type, size: seg.size, live: !!seg.live,
                   importedAt: seg.importedAt, refreshedAt: seg.refreshedAt || null, capped: !!seg.capped,
                   parts: seg.parts || 0, meshParts: seg.meshParts || 0, mesh: seg.mesh || null,
                   count: seg.members.length, traced: seg.traced || 0, source: seg.source || null };
    await steady(() => segmentsCol(db, CV.cur).doc(segDocId(seg.id)).set(body));
  }
  async function deleteSegmentDocs(seg){
    const db = await use("db");
    if (!db) throw { code: "unavailable" };
    const col = segmentsCol(db, CV.cur);
    // the meta first: a segment without it is never read back, whatever is left
    await steady(() => col.doc(segDocId(seg.id)).delete());
    for (let i = 0; i < (seg.parts || 0); i++){ try { await steady(() => col.doc(segDocId(seg.id) + "~p" + i).delete()); } catch(e){} }
    for (let i = 0; i < (seg.meshParts || 0); i++){ try { await steady(() => col.doc(segDocId(seg.id) + "~m" + i).delete()); } catch(e){} }
  }

  async function rebuildFromStore(){
    const n = await loadCanvas(CV.cur);
    paintDbChip();
    return n;
  }
  // expansions whose record has left the map, found by the last load
  async function pruneExpansions(){
    const db = await use("db");
    if (!db) return;
    for (const id of CV.skipped){ try { await expansionsCol(db, CV.cur).doc(id).delete(); } catch(e){} }
    CV.skipped = [];
  }

  // which canvas this viewer had open last — a per-viewer convenience
  function rememberCanvas(c){ try { localStorage.setItem(LAST_KEY, JSON.stringify({ id: c.id, scope: c.scope })); } catch(e){} }
  function recalledCanvas(){ try { return JSON.parse(localStorage.getItem(LAST_KEY) || "null"); } catch(e){ return null; } }
