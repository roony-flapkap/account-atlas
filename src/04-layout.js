
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

  // What joins two hives: the records on both. A contact on companies A and
  // B, or a deal or lead linked to both, is one unit of pull between them.
  // Read straight off the model, so it is derived, never stored.
  function hiveLinks(hives){
    const isHive = new Set(hives.map(h => h.key)), w = new Map();
    const add = (a, b) => {
      if (!w.has(a)) w.set(a, new Map());
      w.get(a).set(b, (w.get(a).get(b) || 0) + 1);
    };
    MAP.nodes.forEach(n => {
      if (n.kind === "company") return;
      const cos = [...new Set(n.adj.filter(k => isHive.has(k)))];
      for (let i = 0; i < cos.length; i++) for (let j = 0; j < cos.length; j++) if (i !== j) add(cos[i], cos[j]);
    });
    return w;
  }

  // EVERY COMPANY IS ITS OWN HIVE. Hives are placed in first-walk order,
  // each beside the hives it shares records with (or, with none placed yet,
  // at the first clear point of an outward spiral). A new account therefore
  // never moves the ones before it. Accounts that share nothing with any
  // other wait in a band under the connected ones, so the middle of the map
  // is where the findings are. `pins` are hive centres fixed by a tidy
  // (see relaxHives): those hives stay put and the rest are placed around them.
  function layoutHives(aspect, opts){
    const pins = (opts && opts.pins) || {};
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

    const links = hiveLinks(hives);
    packHives(hives, ax, ay, links, pins);
    const hiveAt = new Map(hives.map(h => [h.key, h]));

    hives.forEach((h, i) => {
      const c = h.node;
      c.x = h.x; c.y = h.y; c.hive = h.key; c.parent = null; c.level = 0;
      c.room = 2 * h.outerR + G.hiveGap * 0.8;     // how wide its name may run
      // each ring starts facing away from the middle of the map
      const a0 = i === 0 ? -Math.PI / 2 : Math.atan2(h.y, h.x);
      const step = (Math.PI * 2) / Math.max(1, h.members.length);
      const slots = ringSlots(h, hiveAt, a0, step);
      h.members.forEach((n, j) => {
        const a = a0 + slots[j] * step;
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

  // Hives go on golden-angle spirals, each at the first point clear of every
  // hive already placed. A hive that shares records with hives already
  // placed spirals out from their middle (weighted by how much it shares),
  // so partners end up side by side; one with no placed partner uses the
  // spiral from the centre. Clearance is checked against a spatial grid, not
  // every hive; and a hive on the centre spiral starts where the last hive no
  // bigger than it was placed, since everything inside that was already
  // found taken. Checking every hive at every point from the centre grew
  // with the cube of the count: fine at 15 accounts, minutes at a segment's.
  function packHives(hives, ax, ay, links, pins){
    const CELL = 320, grid = new Map(), floors = [];
    const at = new Map(hives.map(h => [h.key, h])), placed = new Set();
    const span = (v, r) => [Math.floor((v - r) / CELL), Math.floor((v + r) / CELL)];
    const clash = (cx, cy, R) => {
      const pad = R + G.hiveGap / 2, [i0, i1] = span(cx, pad), [j0, j1] = span(cy, pad);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++){
        const list = grid.get(i + "," + j);
        if (list) for (const p of list) if (Math.hypot(p.x - cx, p.y - cy) < p.outerR + R + G.hiveGap) return true;
      }
      return false;
    };
    const put = h => {
      placed.add(h.key);
      const pad = h.outerR + G.hiveGap / 2, [i0, i1] = span(h.x, pad), [j0, j1] = span(h.y, pad);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++){
        const key = i + "," + j;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(h);
      }
    };
    const shares = h => links.has(h.key) && links.get(h.key).size > 0;
    // with any sharing on the map, the accounts that share nothing wait in the band
    const banding = hives.some(shares), band = [];
    // a tidy's pins first: those hives stay exactly where it put them
    hives.forEach(h => { const p = pins[h.key]; if (p && isFinite(p.x) && isFinite(p.y)){ h.x = p.x; h.y = p.y; put(h); } });
    hives.forEach(h => {
      if (placed.has(h.key)) return;
      if (banding && !shares(h)){ band.push(h); return; }
      let x = 0, y = 0;
      const partners = shares(h) ? [...links.get(h.key)].filter(([k]) => placed.has(k)) : [];
      if (partners.length){
        let cx = 0, cy = 0, tw = 0;
        partners.forEach(([k, w]) => { const p = at.get(k); cx += p.x * w; cy += p.y * w; tw += w; });
        cx /= tw; cy /= tw;
        // around one partner, nothing nearer than touching it can be free
        const one = partners.length === 1 ? at.get(partners[0][0]) : null;
        let k = one ? Math.floor(Math.pow((one.outerR + h.outerR + G.hiveGap) / (9 * Math.max(ax, ay)), 2)) : 1;
        // Of the first clear points around the partners (the golden angle
        // spreads them all round), the one nearest the partners and, a
        // little, the middle of the map: the first clear point alone strung
        // partners out in a long chain.
        let best = null, bestCost = Infinity, seen = 0;
        for (k = Math.max(1, k); k < 4000000 && seen < 24; k++){
          const rho = 9 * Math.sqrt(k), th = k * GOLDEN;
          const px = cx + rho * Math.cos(th) * ax, py = cy + rho * Math.sin(th) * ay;
          if (clash(px, py, h.outerR)) continue;
          seen++;
          let cost = 0;
          partners.forEach(([pk, w]) => { const p = at.get(pk); cost += w * Math.hypot(px - p.x, py - p.y); });
          cost = cost / tw + 0.6 * Math.hypot(px / ax, py / ay);
          if (cost < bestCost){ bestCost = cost; best = [px, py]; }
        }
        if (best){ x = best[0]; y = best[1]; }
      } else if (placed.size){
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
      h.x = x; h.y = y; put(h);
    });
    if (band.length){
      placeBand(band, hiveBounds([...placed].map(k => at.get(k))), ax / ay);
      band.forEach(put);
    }
  }
  const hiveBounds = hs => boundsOf(hs.map(h => ({ x0: h.x - h.outerR, x1: h.x + h.outerR, y0: h.y - h.outerR, y1: h.y + h.outerR })));
  // The band: hives sharing nothing with any other, in first-walk order, in
  // rows under everything else, as wide as the connected group or as a
  // screen-shaped block of their own, whichever is wider.
  function placeBand(band, b, asp){
    const x0 = isFinite(b.x0) ? b.x0 : 0, top = isFinite(b.y1) ? b.y1 + G.hiveGap * 2 : 0;
    const area = band.reduce((s, h) => s + Math.pow(2 * h.outerR + G.hiveGap, 2), 0);
    const width = Math.max(isFinite(b.x1) ? b.x1 - x0 : 0, Math.sqrt(area * (asp || 1.6)));
    let x = x0, y = top, rowH = 0;
    band.forEach(h => {
      const d = 2 * h.outerR;
      if (x > x0 && x + d > x0 + width){ x = x0; y += rowH + G.hiveGap; rowH = 0; }
      h.x = x + h.outerR; h.y = y + h.outerR;
      x += d + G.hiveGap; rowH = Math.max(rowH, d);
    });
  }

  // Which slot on its ring each member takes. A record that is also on
  // another account takes the free slot nearest the direction of that
  // account's hive, and a contact's own deals and leads follow it there; the
  // rest keep their order in the slots left. With no such records the ring is
  // exactly as before: slot j for member j.
  function ringSlots(h, hiveAt, a0, step){
    const m = h.members.length, plain = h.members.map((_, j) => j);
    if (m < 2) return plain;
    const want = new Map();                          // member index -> the angle it should face
    h.members.forEach((n, j) => {
      const far = n.adj.filter(k => k !== h.key && hiveAt.has(k)).map(k => hiveAt.get(k));
      if (!far.length) return;
      const dx = far.reduce((s, p) => s + p.x, 0) / far.length - h.x, dy = far.reduce((s, p) => s + p.y, 0) / far.length - h.y;
      if (Math.hypot(dx, dy) > 1) want.set(j, Math.atan2(dy, dx));
    });
    if (!want.size) return plain;
    let head = -1;
    h.members.forEach((n, j) => {
      if (n.kind === "contact" || n.kind === "detached") head = j;
      else if (head >= 0 && want.has(head) && !want.has(j) && n.adj.includes(h.members[head].key)) want.set(j, want.get(head));
    });
    const taken = new Array(m).fill(false), out = new Array(m);
    const slotOf = ang => { const s = Math.round((ang - a0) / step); return ((s % m) + m) % m; };
    [...want.entries()].sort((p, q) => p[1] - q[1] || p[0] - q[0]).forEach(([j, ang]) => {
      const s0 = slotOf(ang);
      for (let d = 0; d < m; d++){
        const a = (s0 + d) % m, b = (s0 - d + m) % m;
        if (!taken[a]){ taken[a] = true; out[j] = a; return; }
        if (!taken[b]){ taken[b] = true; out[j] = b; return; }
      }
    });
    let s = 0;
    h.members.forEach((n, j) => {
      if (out[j] !== undefined) return;
      while (taken[s]) s++;
      taken[s] = true; out[j] = s;
    });
    return out;
  }

  // THE TIDY ("Lay it out again" on the hives): every hive a circle that may
  // not overlap another, the records two hives share pulling them together
  // like a spring, settled over a few hundred small steps (Verlet steps with
  // damping, a broad-phase grid for the collisions), cooling as it goes. The
  // hives that share nothing are laid in the band again, under where the
  // rest settled. Nothing random: the same canvas always tidies the same.
  // Returns every hive's centre, to be kept as pins.
  function relaxHives(hives, links, aspect){
    const asp = clamp(aspect || 1.6, 0.55, 2.2), GAP = G.hiveGap;
    const shares = h => links.has(h.key) && links.get(h.key).size > 0;
    const group = hives.filter(shares), band = hives.filter(h => !shares(h));
    if (group.length >= 2){
      const P = group.map(h => ({ h, x: h.x, y: h.y, px: h.x, py: h.y, r: h.outerR }));
      const idx = new Map(P.map((p, i) => [p.h.key, i])), springs = [];
      group.forEach((h, i) => links.get(h.key).forEach((w, k) => { const j = idx.get(k); if (j !== undefined && j > i) springs.push([i, j, w]); }));
      const STEPS = 320, DAMP = 0.85;
      for (let s = 0; s < STEPS; s++){
        const t = 1 - s / STEPS;
        P.forEach(p => { const vx = (p.x - p.px) * DAMP, vy = (p.y - p.py) * DAMP; p.px = p.x; p.py = p.y; p.x += vx; p.y += vy; });
        springs.forEach(([i, j, w]) => {
          const a = P[i], b = P[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, rest = a.r + b.r + GAP;
          if (d <= rest) return;
          const f = Math.min(0.25, 0.04 * (1 + Math.log(w))) * (d - rest) * t / 2;
          a.x += dx / d * f; a.y += dy / d * f; b.x -= dx / d * f; b.y -= dy / d * f;
        });
        // a gentle pull to the middle keeps separate groups from drifting apart, wider than tall like the frame
        const cx = P.reduce((q, p) => q + p.x, 0) / P.length, cy = P.reduce((q, p) => q + p.y, 0) / P.length;
        P.forEach(p => { p.x += (cx - p.x) * 0.004 * t / asp; p.y += (cy - p.y) * 0.004 * t * asp; });
        collide(P, GAP);
      }
      for (let s = 0; s < 12; s++) collide(P, GAP);        // settled: nothing left overlapping
      P.forEach(p => { p.h.x = p.x; p.h.y = p.y; });
    }
    if (band.length) placeBand(band, group.length ? hiveBounds(group) : { x0: 0, y0: 0, x1: 0, y1: -G.hiveGap * 2 }, asp);
    const pins = {};
    hives.forEach(h => { pins[h.key] = { x: +h.x.toFixed(1), y: +h.y.toFixed(1) }; });
    return pins;
  }
  // push overlapping circles apart, half each, through a grid of cells
  function collide(P, gap){
    const CELL = 2 * Math.max(...P.map(p => p.r)) + gap, grid = new Map();
    const cell = p => Math.floor(p.x / CELL) + "," + Math.floor(p.y / CELL);
    P.forEach((p, i) => { const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    P.forEach((a, i) => {
      const gx = Math.floor(a.x / CELL), gy = Math.floor(a.y / CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++){
        const list = grid.get((gx + dx) + "," + (gy + dy));
        if (!list) continue;
        for (const j of list){
          if (j <= i) continue;
          const b = P[j], ex = b.x - a.x, ey = b.y - a.y, d = Math.hypot(ex, ey), need = a.r + b.r + gap;
          if (d >= need) continue;
          const ux = d ? ex / d : 1, uy = d ? ey / d : 0, push = (need - d) / 2;
          a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
        }
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
