
  /* =====================================================================
     11. MARKERS — one table, one drawing function, and both the plot and
     the legend call it, so a shape is never described as something it is
     not drawn as. Shape says what a record is; a dashed outline says it is
     not attached where it should be.
     ===================================================================== */
  const SHAPE = {
    company:  { form: "diamond",  col: "--c-company",  fill: .34 },
    contact:  { form: "circle",   col: "--c-contact",  fill: .30 },
    deal:     { form: "square",   col: "--c-deal",     fill: .30 },
    lead:     { form: "triangle", col: "--c-lead",     fill: .30 },
    detached: { form: "circle",   col: "--c-detached", fill: .12, dash: "2.5 2" },
    stub:     { form: "diamond",  col: "--c-stub",     fill: .10, dash: "2.5 2" }
  };
  const nodeR = n => n.kind === "company" ? (isStub(n) ? G.rStub : G.rCo) : G.r;
  const kindColour = k => "var(" + (SHAPE[k] || SHAPE.contact).col + ")";
  const nodeColour = key => { const n = MAP.byKey[key]; return n ? kindColour(shapeKey(n)) : ""; };
  function markerSvg(kind, r){
    const s = SHAPE[kind] || SHAPE.contact, c = "var(" + s.col + ")";
    const a = ' fill="' + c + '" fill-opacity="' + s.fill + '" stroke="' + c + '" stroke-width="' +
              (kind === "company" ? 2 : 1.7) + '"' + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : "");
    if (s.form === "square"){ const q = r * 0.9; return '<rect class="gmk" x="' + f1(-q) + '" y="' + f1(-q) + '" width="' + f1(2*q) + '" height="' + f1(2*q) + '"' + a + "/>"; }
    if (s.form === "diamond"){ const d = r * 1.2; return '<path class="gmk" d="M0,' + f1(-d) + " L" + f1(d) + ",0 L0," + f1(d) + " L" + f1(-d) + ',0 Z"' + a + "/>"; }
    // a triangle sits on its base, so it never reads as a tipped square
    if (s.form === "triangle") return '<path class="gmk" d="M0,' + f1(-r*1.2) + " L" + f1(r*1.08) + "," + f1(r*0.78) + " L" + f1(-r*1.08) + "," + f1(r*0.78) + ' Z"' + a + "/>";
    return '<circle class="gmk" r="' + f1(r) + '"' + a + "/>";
  }
  const swatch = kind => '<svg class="lgs" viewBox="-11 -11 22 22" aria-hidden="true">' + markerSvg(kind, 7) + "</svg>";
  const lineSwatch = w => '<svg class="lgs wide" viewBox="0 0 18 9" aria-hidden="true"><path class="gedge ' + w + '" d="M0,4.5 L18,4.5"/></svg>';
  const ringSwatch = () => '<svg class="lgs" viewBox="-11 -11 22 22" aria-hidden="true"><circle class="gring" r="8.5"/><circle r="3.4" fill="var(--dim)"/></svg>';
  const btnDrop = n => nodeR(n) + 34;

  // The inside of a node, written once for every node however it arrived.
  function nodeInner(n){
    const r = nodeR(n);
    return '<circle class="gring" r="' + f1(r * 1.75) + '"/>' + markerSvg(shapeKey(n), r) +
      '<text class="glabel"></text>' + (n.e.sub ? '<text class="gsubl"></text>' : "") +
      '<g class="gxb" transform="translate(0,' + f1(btnDrop(n)) + ')">' +
        '<rect class="gxbhit" x="-50" y="-13" width="100" height="26"/>' +
        '<rect class="gxbb" x="-45" y="-9" width="90" height="18"/>' +
        '<text class="gxbt" y="2.6">&#9656; ' + (isStub(n) ? "Walk it" : n.xd ? "Expanded" : "Expand search") + "</text>" +
      "</g>";
  }

  /* =====================================================================
     12. LAYOUTS — a layout puts every node somewhere AND names each node's
     parent. Edge weight is derived from that: the edge that places a node
     is drawn at full weight and any other edge between records is a faint
     echo — except a cross-account edge, which is never quietened.
     Both layouts work in world units around the origin; the camera does
     the fitting, so a layout never depends on the size of the screen.
     ===================================================================== */
  const labelLen = (n, cap) => Math.min(cap, String(n.e.label || "").length);
  const held = n => (n.parentKey && MAP.byKey[n.parentKey]) ? n.parentKey : null;
  const bySeq = (a, b) => a.seq - b.seq;

  // Which companies are hives, what sits on each ring, what hangs off it.
  // A company is a hive once walked or once it has records of its own; one
  // nobody walked and nothing hangs off is a SATELLITE on the branch of the
  // record that reaches it.
  // A company a SEGMENT brought, that nobody walked and nothing yet links
  // to, is not a hive of its own: it waits in its segment's FIELD, a grid
  // under the segment's name. Walk it, or let the mesh link it, and it
  // leaves the field for a hive or a satellite — the connected ones stand
  // out of the crowd by moving.
  function hiveModel(){
    const members = new Map(), loose = [];
    MAP.nodes.forEach(n => {
      n.field = null;
      if (n.kind === "company") return;
      const h = hiveKeyOf(n);
      if (h){ if (!members.has(h)) members.set(h, []); members.get(h).push(n); }
      else loose.push(n);
    });
    const keys = [], isKey = new Set();
    const addKey = k => { if (!isKey.has(k)){ isKey.add(k); keys.push(k); } };
    MAP.order.forEach(cid => { if (MAP.byKey[companyKey(cid)]) addKey(companyKey(cid)); });
    const sats = [], fieldOf = new Map();
    MAP.nodes.forEach(c => {
      if (c.kind !== "company" || isKey.has(c.key)) return;
      const anchor = members.has(c.key) ? null
        : c.adj.find(k => MAP.byKey[k] && MAP.byKey[k].kind !== "company" && hiveKeyOf(MAP.byKey[k]));
      if (anchor){ sats.push({ node: c, anchor }); return; }
      const seg = !members.has(c.key) && c.segs.find(id => MAP.segments[id]);
      if (seg){ if (!fieldOf.has(seg)) fieldOf.set(seg, []); fieldOf.get(seg).push(c); c.field = seg; return; }
      addKey(c.key);
    });
    const hives = clusterOrder(keys, isKey).map(k => ({ key: k, node: MAP.byKey[k], members: orderMembers(members.get(k) || []), sats: [] }));
    const byKey = new Map(hives.map(h => [h.key, h]));
    sats.forEach(s => {
      const h = byKey.get(hiveKeyOf(MAP.byKey[s.anchor]));
      if (h) h.sats.push(s); else loose.push(s.node);
    });
    const byLabel = (a, b) => String(a.e.label).localeCompare(String(b.e.label)) || bySeq(a, b);
    const fields = MAP.segOrder.filter(id => fieldOf.has(id))
      .map(id => ({ id, name: MAP.segments[id].name, nodes: fieldOf.get(id).sort(byLabel) }));
    return { hives, loose, fields };
  }

  // Walked accounts keep their first-walk order, so a new walk never moves
  // an old one. The other hives — companies a segment's mesh or a walk
  // reached — are grouped by what joins them: every company sharing a
  // person with another lands next to it on the spiral, biggest cluster
  // first, instead of across the map from it.
  function clusterOrder(keys, isKey){
    const walked = new Set(MAP.order.map(companyKey));
    const rest = keys.filter(k => !walked.has(k));
    if (rest.length < 3) return keys;
    const up = new Map();
    const find = k => { let r = k; while (up.has(r) && up.get(r) !== r) r = up.get(r); let c = k; while (up.has(c) && up.get(c) !== r){ const n = up.get(c); up.set(c, r); c = n; } return r; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) up.set(ra, rb); };
    rest.forEach(k => up.set(k, k));
    MAP.nodes.forEach(n => {
      if (n.kind === "company") return;
      const cos = n.adj.filter(k => up.has(k));
      for (let i = 1; i < cos.length; i++) union(cos[0], cos[i]);
    });
    const groups = new Map();
    rest.forEach(k => { const r = find(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); });
    const ordered = [...groups.values()].sort((a, b) => b.length - a.length || MAP.byKey[a[0]].seq - MAP.byKey[b[0]].seq);
    return keys.filter(k => walked.has(k)).concat(...ordered);
  }

  // Ring order puts a contact's own leads and deals beside it, so the echo
  // between them is a short chord rather than a line across the hive.
  function orderMembers(list){
    const inList = new Map(list.map(n => [n.key, n]));
    const people = list.filter(n => n.kind === "contact").sort(bySeq);
    const out = [], used = new Set();
    const add = n => { if (!used.has(n.key)){ used.add(n.key); out.push(n); } };
    people.forEach(p => {
      add(p);
      p.adj.map(k => inList.get(k)).filter(m => m && (m.kind === "lead" || m.kind === "deal")).sort(bySeq).forEach(add);
    });
    list.filter(n => n.kind === "lead" || n.kind === "deal").sort(bySeq).forEach(add);
    list.filter(n => n.kind === "detached").sort(bySeq).forEach(add);   // the anomalies together
    list.forEach(add);
    return out;
  }

  // EVERY COMPANY IS ITS OWN HIVE. Hives are packed in first-walk order:
  // each takes the first place on an outward spiral where it clears every
  // hive already placed. A new account therefore never moves the ones
  // before it, and nothing is spaced by the widest ring on the map.
  function layoutHives(aspect){
    const { hives, loose, fields } = hiveModel();
    // the spiral is stretched to the frame's shape — wide on a desk, tall on a phone
    const asp = clamp(aspect || 1.6, 0.55, 2.2), ax = Math.sqrt(asp), ay = 1 / ax;
    hives.forEach(h => {
      const m = h.members.length;
      h.ringR = Math.max(G.ringMin, m * G.arc / (2 * Math.PI));
      const lab = m ? 16 + Math.max(...h.members.map(n => labelLen(n, G.ringChars))) * G.charW : 30;
      h.labR = h.ringR + lab;
      if (h.sats.length){
        h.satR = h.labR + 30;
        h.outerR = h.satR + 18 + Math.max(...h.sats.map(s => labelLen(s.node, G.ringChars))) * G.charW;
      } else h.outerR = h.labR;
      // the company's own name is set under its marker and must fit too
      h.outerR = Math.max(h.outerR, 16 + labelLen(h.node, G.coChars) * G.charW * 0.6);
    });

    packHives(hives, ax, ay);

    hives.forEach((h, i) => {
      const c = h.node;
      c.x = h.x; c.y = h.y; c.hive = h.key; c.parent = null; c.level = 0;
      c.room = 2 * h.outerR + G.hiveGap * 0.8;     // how wide its name may run
      // each ring starts facing away from the middle of the map
      const a0 = i === 0 ? -Math.PI / 2 : Math.atan2(h.y, h.x);
      const step = (Math.PI * 2) / Math.max(1, h.members.length);
      h.members.forEach((n, j) => {
        const a = a0 + j * step;
        n.x = h.x + h.ringR * Math.cos(a); n.y = h.y + h.ringR * Math.sin(a);
        n.hive = h.key; n.level = 1;
        // what it was opened out of wins, so an arrival hangs from its fetcher
        n.parent = held(n) || h.key;
      });
      // Satellites stand beyond the ring's labels, in line with the record
      // that reaches them — never on top of that record's own label.
      if (h.sats.length){
        const sep = 26 / h.satR;
        const list = h.sats.map(s => {
          const P = MAP.byKey[s.anchor];
          return { s, a: Math.atan2(P.y - h.y, P.x - h.x) };
        }).sort((p, q) => p.a - q.a);
        for (let j = 1; j < list.length; j++) if (list[j].a < list[j - 1].a + sep) list[j].a = list[j - 1].a + sep;
        list.forEach(({ s, a }) => {
          const n = s.node;
          n.x = h.x + h.satR * Math.cos(a); n.y = h.y + h.satR * Math.sin(a);
          n.hive = h.key; n.level = 2; n.parent = s.anchor;
        });
      }
    });

    const hb = boundsOf(hives.map(h => ({ x0: h.x - h.outerR, x1: h.x + h.outerR, y0: h.y - h.outerR, y1: h.y + h.outerR })));
    const boxes = placeFields(fields, hb, asp);
    const bounds = boundsOf([hb].concat(boxes));
    placeLoose(loose, bounds);
    return { mode: "ring", hives, fields: boxes, bounds: boundsOf([bounds].concat(loose.map(boxOf))) };
  }

  // Hives go on an outward golden-angle spiral, each at the first point
  // clear of every hive already placed. Clearance is checked against a
  // spatial grid, not every hive; and a hive starts its search where the
  // last hive no bigger than it was placed, since everything inside that
  // was already found taken. Checking every hive at every point from the
  // centre grew with the cube of the count: fine at 15 accounts, minutes
  // at a segment's worth.
  function packHives(hives, ax, ay){
    const CELL = 320, grid = new Map(), floors = [];
    const span = (v, r) => [Math.floor((v - r) / CELL), Math.floor((v + r) / CELL)];
    const clash = (cx, cy, R) => {
      const pad = R + G.hiveGap / 2, [i0, i1] = span(cx, pad), [j0, j1] = span(cy, pad);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++){
        const list = grid.get(i + "," + j);
        if (list) for (const p of list) if (Math.hypot(p.x - cx, p.y - cy) < p.outerR + R + G.hiveGap) return true;
      }
      return false;
    };
    hives.forEach((h, n) => {
      let x = 0, y = 0;
      if (n){
        const cls = Math.floor(h.outerR / 25);
        let k = 1;
        for (let c = 0; c <= cls; c++) if (floors[c] > k) k = floors[c];
        for (; k < 4000000; k++){
          const rho = 9 * Math.sqrt(k), th = k * GOLDEN;
          const cx = rho * Math.cos(th) * ax, cy = rho * Math.sin(th) * ay;
          if (!clash(cx, cy, h.outerR)){ x = cx; y = cy; break; }
        }
        floors[cls] = Math.max(floors[cls] || 0, k);
      }
      h.x = x; h.y = y;
      const pad = h.outerR + G.hiveGap / 2, [i0, i1] = span(x, pad), [j0, j1] = span(y, pad);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++){
        const key = i + "," + j;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(h);
      }
    });
  }

  // Each segment's field: a grid shaped like the frame, under the hives.
  const FIELD = { w: 172, h: 66, head: 54, gap: 140 };
  function placeFields(fields, hb, asp){
    let y = isFinite(hb.y1) ? hb.y1 + FIELD.gap : 0;
    const x0 = isFinite(hb.x0) ? hb.x0 : 0;
    return fields.map(f => {
      const n = f.nodes.length;
      const cols = clamp(Math.round(Math.sqrt(n * (asp || 1.6) * FIELD.h / FIELD.w)), 1, 80);
      f.nodes.forEach((c, i) => {
        c.x = x0 + FIELD.w / 2 + (i % cols) * FIELD.w;
        c.y = y + FIELD.head + Math.floor(i / cols) * FIELD.h;
        c.hive = null; c.level = 1; c.parent = null; c.room = FIELD.w;
      });
      const rows = Math.ceil(n / cols);
      const box = { id: f.id, name: f.name, count: n, x0: x0 - 20, y0: y, x1: x0 + cols * FIELD.w + 20, y1: y + FIELD.head + rows * FIELD.h };
      y = box.y1 + FIELD.gap;
      return box;
    });
  }

  // Records with no hive at all — rare — wait in a row under the map.
  function placeLoose(loose, b){
    loose.forEach((n, i) => {
      n.x = (isFinite(b.x0) ? b.x0 : 0) + 90 + i * 190;
      n.y = (isFinite(b.y1) ? b.y1 : 0) + 110;
      n.hive = null; n.level = 1;
      n.parent = held(n) || (n.adj.find(k => MAP.byKey[k]) || null);
    });
  }
  const boxOf = n => ({ x0: n.x - 90, x1: n.x + 90 + labelLen(n, G.ringChars) * G.charW, y0: n.y - 40, y1: n.y + 40 });
  function boundsOf(boxes){
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    boxes.forEach(q => { b.x0 = Math.min(b.x0, q.x0); b.y0 = Math.min(b.y0, q.y0); b.x1 = Math.max(b.x1, q.x1); b.y1 = Math.max(b.y1, q.y1); });
    return b;
  }

  // THE HIERARCHY, one block per account, in the order the funnel runs:
  // the company, the people on it, the leads they became, the deals those
  // became, and last any company somebody reaches that nobody walked.
  // Long rows wrap, and the blocks flow into a grid shaped like a screen —
  // one row of every contact on the map made a strip too thin to read.
  function layoutTree(){
    const { hives, loose, fields } = hiveModel();
    const holderOf = {};
    MAP.edges.forEach(ed => {
      if (ed.rel !== "link") return;
      const A = MAP.byKey[ed.a], B = MAP.byKey[ed.b];
      if (!A || !B) return;
      if (A.kind === "contact" && holderOf[B.key] === undefined) holderOf[B.key] = A.key;
      if (B.kind === "contact" && holderOf[A.key] === undefined) holderOf[A.key] = B.key;
    });
    const blocks = hives.map(h => {
      const people = h.members.filter(n => n.kind === "contact" || n.kind === "detached");
      const pos = new Map(people.map((n, i) => [n.key, i]));
      const parentOf = n => held(n) || (holderOf[n.key] && MAP.byKey[holderOf[n.key]] ? holderOf[n.key] : h.key);
      const byParent = (a, b) => ((pos.get(parentOf(a)) ?? 1e6) - (pos.get(parentOf(b)) ?? 1e6)) || bySeq(a, b);
      h.node.parent = null; h.node.hive = h.key; h.node.level = 0;
      h.node.room = Math.max(G.treeX, h.members.length ? Math.min(h.members.length, G.treeWrap) * G.treeX : 0) + G.blockGap * 0.8;
      people.forEach(n => { n.parent = held(n) || h.key; n.level = 1; n.hive = h.key; });
      const leads = h.members.filter(n => n.kind === "lead"), deals = h.members.filter(n => n.kind === "deal");
      leads.concat(deals).forEach(n => { n.parent = parentOf(n); n.level = n.kind === "lead" ? 2 : 3; n.hive = h.key; });
      h.sats.forEach(s => { s.node.parent = s.anchor; s.node.level = 4; s.node.hive = h.key; });
      return packBlock([[h.node], people, leads.sort(byParent), deals.sort(byParent),
                        h.sats.map(s => s.node).sort((a, b) => (pos.get(a.parent) ?? 1e6) - (pos.get(b.parent) ?? 1e6))]);
    });
    fields.forEach(f => {
      f.nodes.forEach(n => { n.parent = null; n.level = 1; n.hive = null; n.room = G.treeX; });
      const b = packBlock([f.nodes], FIELD.head);
      b.field = f;
      blocks.push(b);
    });
    if (loose.length){
      loose.forEach(n => { n.parent = held(n) || null; n.level = 1; n.hive = null; });
      blocks.push(packBlock([loose]));
    }
    // flow the blocks into rows about as wide as a screen is to its height
    const area = blocks.reduce((s, b) => s + (b.w + G.blockGap) * (b.h + G.blockGap), 0);
    const target = Math.max(Math.max(0, ...blocks.map(b => b.w)), Math.sqrt(area * 1.9));
    let x = 0, y = 0, rowH = 0;
    const boxes = [];
    blocks.forEach(b => {
      if (x > 0 && x + b.w > target){ x = 0; y += rowH + G.blockGap; rowH = 0; }
      b.items.forEach(it => { it.n.x = x + b.w / 2 + it.dx; it.n.y = y + it.dy; });
      if (b.field) boxes.push({ id: b.field.id, name: b.field.name, count: b.field.nodes.length,
                                x0: x - 10, y0: y - 10, x1: x + b.w + 10, y1: y + b.h });
      x += b.w + G.blockGap; rowH = Math.max(rowH, b.h);
    });
    const bounds = boundsOf(MAP.nodes.map(n => ({ x0: n.x - G.treeX / 2, x1: n.x + G.treeX / 2, y0: n.y - 30, y1: n.y + 50 })).concat(boxes));
    return { mode: "tree", hives: [], fields: boxes, bounds };
  }
  function packBlock(rows, headroom){
    const items = [];
    let y = headroom || 0, w = G.treeX;
    rows.filter(r => r.length).forEach(row => {
      for (let i = 0; i < row.length; i += G.treeWrap){
        const chunk = row.slice(i, i + G.treeWrap);
        w = Math.max(w, chunk.length * G.treeX);
        chunk.forEach((n, j) => items.push({ n, dx: (j - (chunk.length - 1) / 2) * G.treeX, dy: y }));
        y += (i + G.treeWrap < row.length) ? G.treeSub : G.treeY;
      }
    });
    return { items, w, h: Math.max(0, y - G.treeY) + 60 };
  }
