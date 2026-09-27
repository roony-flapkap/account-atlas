
  /* =====================================================================
     5. THE MODEL
     Every node is keyed by the RECORD it is — "0-1/100000000003" — never
     by how it arrived. Walk a second company that shares a contact and the
     walk returns a key already here, so the contact gains a second EDGE
     instead of a second node. That is the whole point of the map.
     ===================================================================== */
  // segments: HubSpot segments imported onto this canvas, by list id, in
  // import order (segOrder) — each with the company keys it brought
  const MAP = { nodes: [], byKey: {}, edges: [], edgeSet: {}, accounts: {}, order: [], segments: {}, segOrder: [] };

  function resetMap(){
    MAP.nodes = []; MAP.byKey = {}; MAP.edges = []; MAP.edgeSet = {};
    MAP.accounts = {}; MAP.order = []; MAP.segments = {}; MAP.segOrder = [];
  }
  // A stub — a company known of but never walked — is DERIVED from the map,
  // never stored: a flag saved on a record went stale the moment the company
  // was walked or forgotten, and a forgotten account kept drawing as walked.
  const isStub = n => n.kind === "company" && !MAP.accounts[n.id];
  // what a record is drawn as, and what the legend filter hides it under
  const shapeKey = n => isStub(n) ? "stub" : n.kind;
  const filterKey = n => isStub(n) ? "stub" : (n.kind === "company" ? null : n.kind);

  // A node's own facts are stored RAW and escaped at render time: rows from
  // the store are untrusted by the platform's contract, and every viewer
  // can write them — so a malformed field is dropped, never trusted.
  const str = v => (v == null || typeof v === "object") ? "" : String(v);
  const cleanFacts = f => Array.isArray(f) ? f.filter(p => Array.isArray(p) && p.length >= 2).map(p => [str(p[0]), str(p[1])]) : [];
  const KINDS = ["company", "contact", "deal", "lead", "detached"];
  const validRecord = d => d && typeof d === "object" && typeof d.k === "string" && KINDS.indexOf(d.kd) >= 0 && d.id != null && typeof d.t === "string";

  function newNode(d, at){
    const n = {
      key: d.k, kind: d.kd, id: String(d.id), t: d.t,
      hh: typeof d.hh === "string" ? d.hh : null,   // the hive that FOUND it: a fallback home
      companyIds: [], home: null,                    // both derived from membership in reindex()
      mis: false, xd: false, parentKey: null, seq: MAP.nodes.length,
      segs: [],                                      // segments that brought it (companies)
      adj: [], edges: [],
      e: { label: str(d.l) || (d.kd === "company" ? "Company " : "Record ") + d.id, sub: str(d.s), url: recUrl(d.t, d.id),
           created: str(d.c) || null, ownerName: str(d.o) || null, creatorName: str(d.cr) || null,
           facts: cleanFacts(d.f), at: at || "" },
      x: 0, y: 0
    };
    MAP.nodes.push(n);
    MAP.byKey[n.key] = n;
    return n;
  }

  // Details come from the FRESHEST read of a record: documents load in
  // first-walk order, so an old snapshot from a newer account used to
  // overwrite what a recent re-walk of an older one had read.
  function mergeNode(d, at){
    const n = MAP.byKey[d.k];
    if (!n) return newNode(d, at);
    if (!n.hh && typeof d.hh === "string") n.hh = d.hh;
    // "detached" is the weakest claim: any read that attaches it wins
    if (n.kind === "detached" && d.kd !== "detached") n.kind = d.kd;
    if (!at || !n.e.at || at >= n.e.at){
      if (at) n.e.at = at;
      if (str(d.l)) n.e.label = str(d.l);
      if (str(d.s)) n.e.sub = str(d.s);
      if (str(d.c)) n.e.created = str(d.c);
      if (str(d.o)) n.e.ownerName = str(d.o);
      if (str(d.cr)) n.e.creatorName = str(d.cr);
      const f = cleanFacts(d.f);
      if (f.length) n.e.facts = f;
    }
    return n;
  }

  const edgeId = (a, b) => a < b ? a + "|" + b : b + "|" + a;
  function mergeEdge(a, b, rel){
    if (!a || !b || a === b) return null;
    const id = edgeId(a, b);
    const had = MAP.edgeSet[id];
    if (had){
      // membership outranks a bare link, and heals an "unattached" edge once
      // the company is found to really hold the record
      if (rel === "member") had.rel = "member";
      return had;
    }
    const ed = { id, a, b, rel, cross: false };
    MAP.edges.push(ed);
    MAP.edgeSet[id] = ed;
    return ed;
  }

  // Adjacency, membership and mis-association, recomputed across the WHOLE
  // map. Which companies a record is on is DERIVED from its membership
  // edges — never a stored list that only ever grew, which kept a record
  // ringed as shared long after it left the second company. Its home is
  // the first-walked company it is really on; only a record on none (a
  // phone-sweep find, a foreign deal) lives where it was found.
  function reindex(){
    const rank = {};
    MAP.order.forEach((cid, i) => { rank[companyKey(cid)] = i; });
    MAP.nodes.forEach(n => { n.edges = []; n.adj = []; n.companyIds = []; n.home = null; });
    const members = new Map();
    MAP.edges.forEach(ed => {
      const A = MAP.byKey[ed.a], B = MAP.byKey[ed.b];
      if (!A || !B) return;
      A.edges.push(ed); B.edges.push(ed);
      uniqPush(A.adj, ed.b); uniqPush(B.adj, ed.a);
      if (ed.rel === "member" && (A.kind === "company") !== (B.kind === "company")){
        const co = A.kind === "company" ? A : B, rec = co === A ? B : A;
        if (!members.has(rec)) members.set(rec, []);
        members.get(rec).push(co);
      }
    });
    MAP.nodes.forEach(n => {
      if (n.kind === "company"){ n.mis = false; return; }
      const cos = (members.get(n) || []).slice()
        .sort((a, b) => ((rank[a.key] ?? 1e6) - (rank[b.key] ?? 1e6)) || (a.seq - b.seq));
      n.companyIds = cos.map(c => c.id);
      n.home = cos.length ? cos[0].key : (n.hh && MAP.byKey[n.hh] ? n.hh : null);
      if (n.kind === "detached" && cos.length) n.kind = "contact";
      n.mis = n.kind === "detached" || cos.length > 1;
    });
    MAP.edges.forEach(ed => { ed.cross = crossOf(ed); });
  }

  // THE CROSS-HIVE EDGE: a membership from a record to a company other than
  // the one it lives in. The finding the map exists for.
  function crossOf(ed){
    if (ed.rel !== "member") return false;
    const A = MAP.byKey[ed.a], B = MAP.byKey[ed.b];
    if (!A || !B || (A.kind === "company") === (B.kind === "company")) return false;
    const co = A.kind === "company" ? A : B, rec = co === A ? B : A;
    return !!rec.home && rec.home !== co.key;
  }

  function hiveKeyOf(n, seen){
    if (n.kind === "company") return n.key;
    if (n.home && MAP.byKey[n.home]) return n.home;
    if (n.hh && MAP.byKey[n.hh]) return n.hh;
    // something opened out of a record lives where that record lives
    seen = seen || {};
    const P = n.parentKey && MAP.byKey[n.parentKey];
    if (P && !seen[P.key]){ seen[n.key] = 1; return hiveKeyOf(P, seen); }
    return null;
  }

  function mapCounts(){
    const c = { company: 0, contact: 0, deal: 0, lead: 0, detached: 0, shared: 0, stub: 0, echo: 0, cross: 0 };
    MAP.nodes.forEach(n => {
      c[n.kind] = (c[n.kind] || 0) + 1;
      if (n.kind !== "company" && n.companyIds.length > 1) c.shared++;
      if (isStub(n)) c.stub++;
    });
    MAP.edges.forEach(ed => { if (ed.rel === "link") c.echo++; if (ed.cross) c.cross++; });
    c.accounts = MAP.order.length;
    c.records = MAP.nodes.length;
    return c;
  }

  // What a node is, in one phrase — descriptive, never a verdict.
  function classify(n){
    if (!n) return "Record";
    if (n.kind === "company") return isStub(n) ? "Company · not walked yet" : "Account on the map";
    if (n.kind === "detached") return "Unattached · shares a number";
    const what = n.kind === "contact" ? "Person" : n.kind === "deal" ? "Commercial record" : "Lead record";
    if (n.companyIds.length > 1) return what + " · on " + n.companyIds.length + " accounts";
    return n.kind === "contact" ? "Associated person" : what;
  }
  const companyName = cid => { const c = MAP.byKey[companyKey(cid)]; return (c && c.e.label) || "Company " + cid; };

  /* =====================================================================
     6. PERSISTENCE — ONE DOCUMENT PER COMPANY, never one growing blob: the
     store is last-writer-wins, so two walks must never write the same
     document, and the whole map loads as one collection read.
     ===================================================================== */
  let DB_STATE = { known: false, up: false, why: "checking" };

  // Short field names: a document holds 256 KiB and a wide account can hold
  // several hundred records. The URL is derivable, so it is not stored.
  function packNode(n){
    const d = { k: n.key, kd: n.kind, id: n.id, t: n.t, l: n.e.label, ci: n.companyIds, hh: n.hh };
    if (n.e.sub) d.s = n.e.sub;
    if (n.e.created) d.c = n.e.created;
    if (n.e.ownerName) d.o = n.e.ownerName;
    if (n.e.creatorName) d.cr = n.e.creatorName;
    if (n.e.facts.length) d.f = n.e.facts;
    if (isStub(n)) d.st = 1;          // written for older readers; never read back
    return d;
  }
  function accountDoc(cid, keys, edgeIds, meta){
    const stamp = new Date().toISOString();
    const doc = {
      companyId: String(cid), name: meta.name || "", domain: meta.domain || "",
      walkedAt: stamp,
      // hives are set out in first-walk order, so this is carried forward
      firstWalkedAt: meta.first || stamp,
      capped: meta.capped || [],
      // reads that failed and were passed over: the walk is incomplete
      missed: meta.missed || 0,
      nodes: keys.map(k => MAP.byKey[k]).filter(Boolean).map(packNode),
      // only edges between records the map actually holds — a link to a
      // record outside the account used to be saved with nothing at one end
      edges: edgeIds.map(id => MAP.edgeSet[id]).filter(ed => ed && MAP.byKey[ed.a] && MAP.byKey[ed.b])
                    .map(ed => ({ a: ed.a, b: ed.b, r: ed.rel }))
    };
    // Shed detail before records: facts cost the inspector its detail and
    // come back on a re-walk, where a dropped record loses edges for good.
    // Measured in BYTES — an Arabic name is two or three per character.
    if (bytes(JSON.stringify(doc)) > DOC_BYTES){ doc.nodes.forEach(d => { delete d.f; }); doc.trimmed = "facts"; }
    if (bytes(JSON.stringify(doc)) > DOC_BYTES){ doc.nodes.forEach(d => { delete d.s; delete d.cr; }); doc.trimmed = "detail"; }
    return doc;
  }
  function applyDoc(doc){
    const at = str(doc.walkedAt);
    (Array.isArray(doc.nodes) ? doc.nodes : []).forEach(d => { if (validRecord(d)) mergeNode(d, at); });
    (Array.isArray(doc.edges) ? doc.edges : []).forEach(e => {
      if (e && typeof e.a === "string" && typeof e.b === "string" && ["member", "link", "detached"].indexOf(e.r) >= 0) mergeEdge(e.a, e.b, e.r);
    });
    const cid = String(doc.companyId);
    MAP.accounts[cid] = {
      id: cid, name: doc.name || "", domain: doc.domain || "",
      walkedAt: doc.walkedAt || null, firstWalkedAt: doc.firstWalkedAt || doc.walkedAt || null,
      capped: Array.isArray(doc.capped) ? doc.capped.map(str) : [], trimmed: str(doc.trimmed) || null,
      missed: Number(doc.missed) > 0 ? Math.floor(Number(doc.missed)) : 0
    };
    uniqPush(MAP.order, cid);
  }
  // loading, saving and forgetting live with the canvases (section 6b)
