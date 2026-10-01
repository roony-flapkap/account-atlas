
  /* =====================================================================
     13. THE VIEW — mounted once, then kept in step with the model. Walks,
     expansions and a Forget all change MAP and call refresh(); the view
     makes the DOM match (creating, updating and removing elements by key)
     rather than being torn down and rebuilt, so filters, fullscreen, the
     held record and the camera all survive a walk.
     Nothing in here calls HubSpot except the two expansion paths.
     ===================================================================== */
  const TIP = $("tip");
  let XRUN = null;                         // a running expansion: { stop, done }
  async function stopExpansions(){ if (XRUN){ XRUN.stop = true; await XRUN.done; } }

  function createView(host, hooks){
    // what the page is told about: an arrangement changed (so it can be
    // saved), a record was opened out (so what it found can be kept)
    const HOOKS = hooks || {};
    const changed = () => { if (HOOKS.viewChanged) HOOKS.viewChanged(); };
    host.innerHTML =
      '<div class="sh"><h2>The map</h2><p class="hint">Every company is its own hive. A record sits in the hive of the account that first walked it and reaches across to any other it belongs to — <b>that red dashed line is the finding</b>: the same person, or the same deal, on two accounts. Inside a hive, a link between two records that both hang off the company is already said by their spokes and is drawn as a faint echo.</p></div>' +
      '<div class="graphwrap gwrap frame" id="gwrap" data-hide="">' +
        '<div class="gbar"><span class="gread" id="gread"></span><span class="gtools">' +
          '<button type="button" class="gtool wide gall" id="gxall" data-z="xall" disabled>Expand search · all</button>' +
          '<button type="button" class="gtool wide gmode" data-lay="ring" aria-pressed="true">Hives</button>' +
          '<button type="button" class="gtool wide gmode" data-lay="tree" aria-pressed="false">Hierarchy</button>' +
          '<button type="button" class="gtool wide gnames" data-z="names" aria-pressed="true" title="Hide the records’ names">Names</button>' +
          '<button type="button" class="gtool wide" data-z="full" title="Expand the map to fill the screen">Expand</button>' +
          '<button type="button" class="gtool wide" data-z="png" title="Save the map as a PNG">PNG</button>' +
          '<button type="button" class="gtool" data-z="out" aria-label="Zoom out" title="Zoom out">&minus;</button>' +
          '<button type="button" class="gtool" data-z="in" aria-label="Zoom in" title="Zoom in">+</button>' +
          '<button type="button" class="gtool" data-z="fit" aria-label="Fit the map to the frame" title="Fit to frame">&#9678;</button>' +
          '<button type="button" class="gtool" id="gundo" data-z="relayout" title="Lay it out again" disabled>&#8634;</button>' +
        "</span></div>" +
        '<div class="gstage">' +
          '<div class="gclip" id="gclip"><div class="gpan" id="gpan"><svg class="graph" id="gsvg" role="application" aria-label="Map of the accounts walked so far">' +
            '<g class="gscene" id="gscene"><g id="gfields"></g><g id="ghalos"></g><g id="gedges"></g><g id="gsparks"></g><g id="gnodes"></g>' +
              '<g class="reticle" id="greticle"><g class="ret-spin"><rect x="-17" y="-17" width="34" height="34"/>' +
              '<rect x="-12" y="-12" width="24" height="24" transform="rotate(45)"/></g>' +
              '<path class="ret-c" d="M-23,-15 L-23,-23 L-15,-23 M15,-23 L23,-23 L23,-15 M23,15 L23,23 L15,23 M-15,23 L-23,23 L-23,15"/></g>' +
              // an editor's unlink control: it rides the link nearest the cursor
              '<g class="gunlink" id="gunlink" aria-hidden="true"><circle class="guhit" r="14"/><circle class="gub" r="8.5"/>' +
              '<path class="gut" d="M-3.4,-2.6 H3.4 M-1.2,-2.6 V-3.8 H1.2 V-2.6 M-2.6,-2.6 L-2.1,3.7 H2.1 L2.6,-2.6 M-0.8,-0.7 V2 M0.8,-0.7 V2"/></g>' +
            "</g></svg></div></div>" +
          '<p class="gempty" id="gempty" hidden>The map is empty — acquire a company to start it</p>' +
          '<div class="ginsp" id="ginsp"></div>' +
          '<div class="gexp" id="gexp"></div>' +
          '<div class="gtoast" id="gtoast" role="status" aria-live="polite" hidden></div>' +
        "</div>" +
        '<div class="legend" id="glegend"></div>' +
        '<p class="ghint2">Hover a record to read it · <b>click to open it in full</b> · drag it to move it — drag a company and its hive comes with it · ' +
          'drag the background to pan · <b>Expand search, under a record, opens out its own associations</b> · ' +
          '<b>Expand search · all</b> does that for every record shown, one level out a press · ' +
          '<b>a red dashed line is a record that belongs to two accounts</b> · Esc lets go · ctrl-scroll to zoom</p>' +
      "</div>";

    // the frame the map sits in: it never moves, so sizes and pointer
    // positions are read from it even while the picture itself is scaled
    // .gpan carries the picture during a gesture: an HTML box, because
    // scaling the <svg> itself made Chromium lay out all its text again
    const wrap = $("gwrap"), svg = $("gsvg"), scene = $("gscene"), box = $("gclip"), panel = $("gpan");
    const gFields = $("gfields"), gHalos = $("ghalos"), gEdges = $("gedges"), gSparks = $("gsparks"), gNodes = $("gnodes");
    const ret = $("greticle"), read = $("gread"), insp = $("ginsp"), xp = $("gexp"), legend = $("glegend"), unl = $("gunlink");

    // Names off: every record's name and second line go but the held,
    // hovered, picked and neighbouring ones'. Kept per viewer, as a convenience.
    const NAMES_KEY = "atlas.names.v1";
    let namesOn = true;
    try { namesOn = localStorage.getItem(NAMES_KEY) !== "0"; } catch(e){}
    function setNames(on, quiet){
      namesOn = !!on;
      svg.classList.toggle("gnonames", !namesOn);
      const b = wrap.querySelector('[data-z="names"]');
      if (b){ b.setAttribute("aria-pressed", String(namesOn)); b.title = namesOn ? "Hide the records’ names" : "Show the records’ names"; }
      if (!quiet){ try { localStorage.setItem(NAMES_KEY, namesOn ? "1" : "0"); } catch(e){} }
    }
    setNames(namesOn, true);

    // view state that outlives any single refresh
    let MODE = "ring", GEO = { mode: "ring", hives: [], fields: [], bounds: boundsOf([]) };
    let POS = { ring: {}, tree: {} };      // wherever the reader has dragged a single record
    let HOFF = {};                         // how far the reader has dragged each hive, as an offset
    let SEL = null, GREW = false;
    let K = 1, TX = 0, TY = 0, camSet = false, vbW = 1, vbH = 1, labelK = null;
    let pendingCam = null;                 // a saved camera, applied at the next layout
    let busy = false, lastMove = null, tipKey = null, flying = null;
    const nodeEls = new Map(), edgeEls = new Map(), sparkEls = new Map();

    /* ---------------- camera ---------------- */
    // The viewBox is kept equal to the element's own pixel size, so one
    // viewBox unit is one CSS pixel and there is never a letterbox. Before,
    // a fixed viewBox was letterboxed in fullscreen and every pointer
    // conversion — drag, zoom-at-cursor, the expand buttons — was off by
    // the letterbox margin.
    function measure(){
      const r = box.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w === vbW && h === vbH) return false;
      // keep whatever was at the middle of the frame at the middle
      TX += (w - vbW) / 2; TY += (h - vbH) / 2;
      vbW = w; vbH = h;
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      return true;
    }
    // `live`: in the middle of a gesture (a wheel, a pan, a glide to a
    // record). Moving the map means re-laying-out and repainting every record
    // and edge in it — measured on a 920-record canvas, that was nearly all
    // of a frame's time. So during a gesture the picture as last drawn is
    // moved and scaled whole (the graphics card does that for next to
    // nothing), and the map itself is moved once, when the gesture ends.
    // Zoomed out fast, the edges of the frame can show empty for a moment,
    // until that one redraw.
    let labelsDirty = false, cK = 1, cTX = 0, cTY = 0, preview = false;
    function commitCamera(){
      // Swapping the moved picture for the redrawn map must not animate: the
      // scene's slide (for the zoom buttons) would start from where the
      // gesture began and replay the whole move. So the swap is made with
      // transitions off, and they are only let back once the new position
      // has been taken as the starting point.
      const was = preview;
      if (was) svg.classList.add("gsnap");
      scene.setAttribute("transform", "translate(" + f1(TX) + "," + f1(TY) + ") scale(" + (Math.round(K * 1e4) / 1e4) + ")");
      cK = K; cTX = TX; cTY = TY;
      if (was){
        panel.style.transform = ""; preview = false;
        void getComputedStyle(scene).transform;     // the new position, settled before transitions return
        svg.classList.remove("gsnap");
      }
    }
    function apply(live){
      if (live){
        const s = K / cK;
        panel.style.transform = "translate(" + f1(TX - cTX * s) + "px," + f1(TY - cTY * s) + "px) scale(" + (Math.round(s * 1e5) / 1e5) + ")";
        preview = true;
        if (labelK !== K) labelsDirty = true;
        return;
      }
      commitCamera();
      svg.classList.toggle("glod", K < G.lodK);
      svg.classList.toggle("glodsub", K < G.lodSub);
      if (labelK !== K || labelsDirty){ labelK = K; labelsDirty = false; scaleHubLabels(); scaleFieldLabels(); }
    }
    function zoomAt(vx, vy, f, live){
      const K2 = clamp(K * f, G.kMin, G.kMax);
      if (K2 === K) return;
      TX = vx - (vx - TX) * (K2 / K); TY = vy - (vy - TY) * (K2 / K);
      K = K2; camSet = true; apply(live); changed();
    }
    // While the reader zooms, pans or drags, the map goes quiet: no
    // transitions, no animations, no second lines — an SVG repaints whole,
    // so anything moving on it is paid for on every frame. It all comes
    // back 150 ms after the gesture stops.
    let quietT = null;
    function gesture(){
      if (uEd) linkHide();
      if (!svg.classList.contains("gquiet")) svg.classList.add("gquiet");
      clearTimeout(quietT);
      quietT = setTimeout(settle, 150);
    }
    function settle(){
      clearTimeout(quietT); quietT = null;
      svg.classList.remove("gquiet");
      // the one real redraw, at wherever the gesture left the map
      if (preview || labelsDirty) apply(false);
    }
    function toView(e){
      const r = box.getBoundingClientRect();
      return { x: (e.clientX - r.left) * vbW / (r.width || 1), y: (e.clientY - r.top) * vbH / (r.height || 1) };
    }
    const toWorld = v => ({ x: (v.x - TX) / K, y: (v.y - TY) / K });
    function fitView(){
      const b = GEO.bounds;
      if (!isFinite(b.x0)) return;
      const bw = Math.max(200, b.x1 - b.x0), bh = Math.max(160, b.y1 - b.y0);
      K = clamp(Math.min(vbW / bw, vbH / bh) * 0.94, G.kMin, 2.2);
      TX = vbW / 2 - K * (b.x0 + b.x1) / 2; TY = vbH / 2 - K * (b.y0 + b.y1) / 2;
      camSet = true; apply();
    }
    // The view eases across to a record and the zoom is NOT touched — the
    // scale is the reader's.
    function travelTo(key, flash){
      const n = MAP.byKey[key];
      if (!n) return;
      if (SEL && SEL !== key){ SEL = null; paint(); }
      const x0 = TX, y0 = TY, x1 = vbW / 2 - K * n.x, y1 = vbH / 2 - K * n.y;
      const land = () => {
        camSet = true; changed();
        if (!flash) return;
        SEL = key; paint();
        ret.classList.remove("land"); void ret.getBoundingClientRect(); ret.classList.add("land");
        setTimeout(() => ret.classList.remove("land"), 700);
      };
      if (flying) cancelAnimationFrame(flying);
      if (REDUCED || (Math.abs(x1 - x0) < 2 && Math.abs(y1 - y0) < 2)){ TX = x1; TY = y1; apply(); land(); return; }
      svg.classList.add("gfly");
      const t0 = now(), DUR = 460;
      (function step(){
        const t = Math.min(1, (now() - t0) / DUR), e = 1 - Math.pow(1 - t, 3);
        // the glide moves the picture; the map is moved once, on arrival
        TX = x0 + (x1 - x0) * e; TY = y0 + (y1 - y0) * e; apply(t < 1);
        if (t < 1) flying = requestAnimationFrame(step);
        else { flying = null; svg.classList.remove("gfly"); land(); }
      })();
    }
    // The inspector covers the left of the plot: slide a record held under
    // it into the clear. Panning only — never the reader's zoom.
    function bringIntoView(key){
      const n = MAP.byKey[key];
      if (!n) return;
      const xNow = TX + K * n.x;
      if (xNow > vbW / 3) return;
      const clear = (insp.getBoundingClientRect().width || 0) + 70;
      if (xNow < clear){ TX += clear - xNow; apply(); }
    }

    /* ---------------- keeping the DOM in step with the model ---------------- */
    const isHidden = n => { const f = filterKey(n); return !!f && (" " + wrap.getAttribute("data-hide") + " ").indexOf(" " + f + " ") >= 0; };

    function ensureNode(n){
      let el = nodeEls.get(n.key);
      if (!el){
        el = document.createElementNS(SVGNS, "g");
        el.setAttribute("data-k", n.key); el.setAttribute("tabindex", "0"); el.setAttribute("role", "button");
        el.setAttribute("class", "gnode gitem");
        el.setAttribute("transform", "translate(" + f1(n.x) + "," + f1(n.y) + ")");
        gNodes.appendChild(el);
        nodeEls.set(n.key, el);
      }
      // A record can change what it is — detached becomes attached, a
      // company gets walked, a record is opened out — so its marker is
      // redrawn when that happens instead of staying as it was first drawn.
      const sig = shapeKey(n) + "|" + (n.e.sub ? 1 : 0) + "|" + (n.xd ? 1 : 0);
      if (el._sig !== sig){
        el.innerHTML = nodeInner(n);
        el._sig = sig;
        el.style.setProperty("--node", kindColour(shapeKey(n)));
      }
      ["company", "contact", "deal", "lead", "detached"].forEach(k => el.classList.toggle("n-" + k, n.kind === k));
      el.classList.toggle("n-stub", isStub(n));
      el.classList.toggle("gmis", !!n.mis);
      el.classList.toggle("gdone", !!n.xd);
      // deleted or merged away in HubSpot since it was read: struck through, kept until the account is refreshed
      el.classList.toggle("ggone", !!n.gone);
      n.el = el; n.lab = el.querySelector(".glabel"); n.subEl = el.querySelector(".gsubl");
      return el;
    }
    function ensureEdge(ed){
      let p = edgeEls.get(ed.id);
      if (!p){
        p = document.createElementNS(SVGNS, "path");
        p.setAttribute("data-e", ed.id);
        p.setAttribute("d", "M0,0");
        gEdges.appendChild(p);
        edgeEls.set(ed.id, p);
      }
      ed.el = p;
      return p;
    }
    function sync(){
      const live = new Set();
      MAP.nodes.forEach(n => { ensureNode(n); live.add(n.key); });
      nodeEls.forEach((el, k) => { if (!live.has(k)){ el.remove(); nodeEls.delete(k); } });
      const liveE = new Set();
      MAP.edges.forEach(ed => { if (MAP.byKey[ed.a] && MAP.byKey[ed.b]){ ensureEdge(ed); liveE.add(ed.id); } });
      edgeEls.forEach((p, id) => { if (!liveE.has(id)){ p.remove(); edgeEls.delete(id); } });
      if (SEL && !MAP.byKey[SEL]) SEL = null;
    }

    /* ---------------- placing ---------------- */
    function placeNode(n){
      if (!n.el) return;
      n.el.setAttribute("transform", "translate(" + f1(n.x) + "," + f1(n.y) + ")");
      const r = nodeR(n);
      const hub = MAP.byKey[n.hive];
      // Company names sit under their marker; in the hierarchy everything
      // does. On a ring a label runs outward along its own spoke, so a busy
      // ring no longer stacks its names on top of each other at the top and
      // bottom. The angle is read from where the node IS, so a dragged
      // record keeps up.
      // only an ACCOUNT's own name is scaled for the overview — a company
      // somebody merely reaches is labelled like any other record
      // a company waiting in a segment's field is labelled like a record,
      // not scaled like an account: a field is hundreds of them
      n.below = n.kind === "company" && !n.field && (!hub || hub === n);
      const below = MODE === "tree" || n.below || !!n.field;
      n.el.classList.toggle("ghub", n.below);
      const setText = (el, text, x, y, anchor, rot) => {
        if (!el) return;
        el.textContent = text;
        el.setAttribute("x", x); el.setAttribute("y", y); el.setAttribute("text-anchor", anchor);
        if (rot) el.setAttribute("transform", "rotate(" + f1(rot) + ")"); else el.removeAttribute("transform");
        el.style.removeProperty("font-size");
      };
      if (below){
        const cap = n.below ? G.coChars : G.treeChars;
        setText(n.lab, trunc(n.e.label, cap), "0", f1(r + 13), "middle", 0);
        setText(n.subEl, trunc(n.e.sub, cap), "0", f1(r + 23), "middle", 0);
        if (n.below) scaleHubLabel(n);
      } else {
        let ang = 0;
        if (hub && hub !== n) ang = Math.atan2(n.y - hub.y, n.x - hub.x);
        const flip = Math.cos(ang) < 0;
        const rot = ang * 180 / Math.PI + (flip ? 180 : 0);
        const x = f1(flip ? -(r + 6) : r + 6), anchor = flip ? "end" : "start";
        setText(n.lab, trunc(n.e.label, G.ringChars), x, n.subEl ? "-1" : "3", anchor, rot);
        setText(n.subEl, trunc(n.e.sub, G.ringChars), x, "8", anchor, rot);
      }
    }
    // An account's name holds its size ON SCREEN as the map zooms out, so
    // the overview still says which hive is which when record labels are
    // too small to read and have been withdrawn.
    // It is also cut to the room its hive has on screen, so two neighbouring
    // accounts' names do not run into each other at a distance.
    function scaleHubLabel(n){
      if (!n.lab) return;
      const s = Math.max(1, 1.05 / K), r = nodeR(n), fs = 9.5 * s, ss = 7 * s;
      const fit = n.room ? Math.floor(n.room / (fs * 0.68)) : G.coChars;
      n.lab.textContent = trunc(n.e.label, clamp(fit, 4, G.coChars));
      if (n.subEl) n.subEl.textContent = trunc(n.e.sub, clamp(Math.floor((n.room || 999) / (ss * 0.68)), 4, G.coChars));
      n.lab.style.fontSize = f1(fs) + "px";
      n.lab.setAttribute("y", f1(r + 4 + fs));
      if (n.subEl){ n.subEl.style.fontSize = f1(ss) + "px"; n.subEl.setAttribute("y", f1(r + 7 + fs + ss)); }
    }
    function scaleHubLabels(){ MAP.nodes.forEach(n => { if (n.below && n.el) scaleHubLabel(n); }); }

    // An edge's shape, as its end and control points: a straight line, a
    // curve (an echo), or the hierarchy's S-bend. It is drawn from these,
    // and measured against the cursor for the unlink control.
    function edgeGeo(A, B, ed){
      if (MODE === "tree"){
        const my = (A.y + B.y) / 2;
        return [A, { x: A.x, y: my }, { x: B.x, y: my }, B];
      }
      // an echo bows toward the middle of ITS OWN hive
      const c = ed.rel === "link" && A.hive && A.hive === B.hive ? MAP.byKey[A.hive] : null;
      if (c && c !== A && c !== B) return [A, { x: c.x + ((A.x + B.x) / 2 - c.x) * 0.34, y: c.y + ((A.y + B.y) / 2 - c.y) * 0.34 }, B];
      return [A, B];
    }
    function edgeD(A, B, ed){
      const g = edgeGeo(A, B, ed), P = p => f1(p.x) + "," + f1(p.y);
      return "M" + P(g[0]) + (g.length === 4 ? " C" + P(g[1]) + " " + P(g[2]) + " " + P(g[3]) : g.length === 3 ? " Q" + P(g[1]) + " " + P(g[2]) : " L" + P(g[1]));
    }
    // Weight and the filter classes are written together from the edge's
    // CURRENT state. The filter classes used to be fixed at creation, so an
    // edge that became cross-account never answered the cross filter, links
    // to a stub stayed behind when stubs were hidden, and "echo" hid the
    // structural links in the hierarchy instead of the actual echoes.
    function layEdges(only){
      const near = SEL ? new Set([SEL].concat((MAP.byKey[SEL] || {}).adj || [])) : null;
      (only ? only.edges : MAP.edges).forEach(ed => {
        const p = ed.el, A = MAP.byKey[ed.a], B = MAP.byKey[ed.b];
        if (!p || !A || !B) return;
        const d = edgeD(A, B, ed);
        p.setAttribute("d", d);
        const placing = B.parent === A.key || A.parent === B.key;
        const w = ed.rel === "detached" ? "edetach" : ed.cross ? "ecross" : placing ? "eplace" : "eecho";
        const touches = !!SEL && (ed.a === SEL || ed.b === SEL);
        const cls = ["gedge", "gitem", w, "n-" + A.kind, "n-" + B.kind];
        if (isStub(A) || isStub(B)) cls.push("n-stub");
        if (ed.rel === "detached") cls.push("n-detached");
        if (w === "eecho") cls.push("n-echo");
        if (ed.cross) cls.push("n-cross");
        // a link HubSpot has removed fades; one it has added (not yet walked in) glows
        if (ed.gone) cls.push("egone"); else if (ed.pend) cls.push("epend"); else if (ed.fresh) cls.push("efresh");
        if (ed === uEd) cls.push("eunl");
        if (touches) cls.push("glit"); else if (near) cls.push("gdim");
        p.setAttribute("class", cls.join(" "));
        const s = sparkEls.get(ed.id);
        if (touches){
          // a lit connection wears the colour of the record at its far end
          const col = nodeColour(ed.a === SEL ? ed.b : ed.a);
          p.style.setProperty("--node", col);
          if (s){ s.style.setProperty("--node", col); s.setAttribute("d", d); tuneSpark(s); }
        } else p.style.removeProperty("--node");
      });
    }
    // one short lit dash in an enormous gap, timed by the path's own length
    function tuneSpark(s){
      let L = 0;
      try { L = Math.round(s.getTotalLength()); } catch(e){}
      if (L > 0){
        s.style.setProperty("--sl", "18 " + L);
        s.style.setProperty("--so", (L + 18) + "px");
        s.style.setProperty("--sd", clamp(L / 170, 0.7, 2.6).toFixed(2) + "s");
      }
    }
    function drawSparks(){
      gSparks.textContent = ""; sparkEls.clear();
      if (!SEL || !MAP.byKey[SEL] || REDUCED) return;
      MAP.byKey[SEL].edges.forEach(ed => {
        const s = document.createElementNS(SVGNS, "path");
        s.setAttribute("class", "gspark on");
        gSparks.appendChild(s); sparkEls.set(ed.id, s);
      });
    }
    // A segment's field: a dashed frame and the segment's name, which holds
    // its size on screen as the map zooms out, like an account's does.
    function drawFields(){
      gFields.innerHTML = (GEO.fields || []).map(f =>
        '<g class="gfield" data-f="' + esc(f.id) + '"><rect class="gfbox" x="' + f1(f.x0) + '" y="' + f1(f.y0) + '" width="' + f1(f.x1 - f.x0) +
        '" height="' + f1(f.y1 - f.y0) + '"/><text class="gflab" x="' + f1(f.x0 + 18) + '" y="' + f1(f.y0 + 30) + '"></text></g>').join("");
      scaleFieldLabels();
    }
    function scaleFieldLabels(){
      (GEO.fields || []).forEach(f => {
        const t = gFields.querySelector('[data-f="' + CSS.escape(f.id) + '"] .gflab');
        if (!t) return;
        // the name may run past a narrow field: nothing is placed to its right
        const fs = 12 * Math.max(1, 1.05 / K), room = Math.max(48, Math.floor((f.x1 - f.x0 - 36) / (fs * 0.66)));
        t.textContent = trunc("Segment · " + f.name + " · " + fmt(f.count) + " not linked yet", room);
        t.style.fontSize = f1(fs) + "px";
        t.setAttribute("y", f1(f.y0 + 14 + fs));
      });
    }
    function drawHalos(){
      gHalos.style.display = MODE === "tree" ? "none" : "";
      gHalos.innerHTML = GEO.hives.map(h => {
        const acc = MAP.accounts[h.node.id];
        return '<circle class="ghalo' + (acc && isStale(acc.walkedAt) ? " stale" : "") + '" data-h="' + esc(h.key) +
               '" cx="' + f1(h.node.x) + '" cy="' + f1(h.node.y) + '" r="' + f1(h.ringR + 30) + '"/>';
      }).join("");
    }
    function moveHalo(h){
      const c = gHalos.querySelector('[data-h="' + CSS.escape(h.key) + '"]');
      if (c){ c.setAttribute("cx", f1(h.node.x)); c.setAttribute("cy", f1(h.node.y)); }
    }
    function placeReticle(){
      const n = SEL && MAP.byKey[SEL];
      if (!n){ ret.classList.remove("on"); return; }
      ret.setAttribute("transform", "translate(" + f1(n.x) + "," + f1(n.y) + ") scale(" + (Math.round(nodeR(n) / G.r * 100) / 100) + ")");
      ret.classList.add("on");
    }

    // A dragged hive is kept as an OFFSET, not as positions: a hive that
    // later gains records then grows where the reader put it, rather than
    // splitting between where it was dragged and where the layout wants it.
    function applyHiveOffsets(){
      if (MODE !== "ring") return;
      GEO.hives.forEach(h => {
        const o = HOFF[h.key];
        if (!o) return;
        h.x += o.x; h.y += o.y;
        [h.node].concat(h.members, h.sats.map(s => s.node)).forEach(n => { n.x += o.x; n.y += o.y; });
      });
      if (Object.keys(HOFF).length)
        GEO.bounds = boundsOf(GEO.hives.map(h => ({ x0: h.x - h.outerR, x1: h.x + h.outerR, y0: h.y - h.outerR, y1: h.y + h.outerR }))
                              .concat(MAP.nodes.filter(n => !n.hive).map(boxOf), GEO.fields || []));
    }
    function relayout(fit){
      GEO = MODE === "tree" ? layoutTree() : layoutHives(vbW / vbH);
      applyHiveOffsets();
      const ov = POS[MODE];
      MAP.nodes.forEach(n => { const p = ov[n.key]; if (p){ n.x = p.x; n.y = p.y; } });
      MAP.nodes.forEach(placeNode);
      drawHalos();
      drawFields();
      paint();
      if (!fit && !camSet && pendingCam){
        // a canvas reopens where it was left: the saved centre and zoom
        K = clamp(Number(pendingCam.k) || 1, G.kMin, G.kMax);
        TX = vbW / 2 - K * (Number(pendingCam.x) || 0); TY = vbH / 2 - K * (Number(pendingCam.y) || 0);
        camSet = true; apply();
      } else if (fit || !camSet) fitView(); else apply();
      pendingCam = null;
      updateTools();
      nearPass(lastMove);
      linkPass(lastMove);
    }

    /* ---------------- selection ---------------- */
    function paint(){
      const near = SEL ? new Set([SEL].concat((MAP.byKey[SEL] || {}).adj || [])) : null;
      MAP.nodes.forEach(n => {
        if (!n.el) return;
        n.el.classList.toggle("gdim", !!near && !near.has(n.key));
        n.el.classList.toggle("gsel", SEL === n.key);
        // the held record's neighbours keep their names when the map is zoomed out
        n.el.classList.toggle("gadj", !!near && near.has(n.key) && SEL !== n.key);
      });
      drawSparks();
      layEdges();
      placeReticle();
      if (SEL) wrap.style.setProperty("--node", nodeColour(SEL)); else wrap.style.removeProperty("--node");
      read.innerHTML = readout(SEL);
      paintInspector();
    }
    const letGo = () => { SEL = null; paint(); };

    function readout(key){
      const n = key && MAP.byKey[key];
      if (!n){
        const c = mapCounts();
        return c.accounts || c.records
          ? '<span class="gcls">Map</span> · <b>' + c.accounts + " " + plural(c.accounts, "account") + "</b> · " +
            fmt(c.records) + " records" + (c.shared ? " · " + c.shared + " on more than one" : "")
          : "No record held";
      }
      return '<span class="gcls">' + esc(classify(n)) + "</span> · <b>" + esc(n.e.label) + "</b>" +
             (n.e.sub ? " · " + esc(n.e.sub) : "") + " · id " + esc(n.id);
    }
    function tipHtml(key){
      const n = MAP.byKey[key];
      if (!n) return "";
      let rows = "";
      const row = (k, v, bad) => { if (v) rows += '<div class="tr"><span class="tk">' + esc(k) + '</span><span class="tv' + (bad ? " bad" : "") + '">' + esc(v) + "</span></div>"; };
      if (n.kind === "company"){
        const acc = MAP.accounts[n.id];
        if (acc && acc.walkedAt) row("Walked", ago(acc.walkedAt)); else row("Walked", "never — press Walk it under it", true);
      }
      row("Created", n.e.created ? dstr(when(n.e.created)) + " UTC" : null);
      row("Created by", n.e.creatorName);
      row("Owner", n.e.ownerName);
      if (n.kind !== "company" && n.companyIds.length > 1) row("On accounts", n.companyIds.map(companyName).join(" · "), true);
      if (n.segs.length) row("Segment", n.segs.map(id => MAP.segments[id] ? MAP.segments[id].name : id).join(" · "));
      if (n.kind === "detached") row("Attached to", "nothing on this map", true);
      if (n.gone) row("In HubSpot", goneText(n), true);
      return '<div class="tc">' + esc(classify(n)) + '</div><div class="tn">' + esc(n.e.label) + "</div>" +
             (n.e.sub ? '<div class="ts">' + esc(n.e.sub) + "</div>" : "") +
             (rows || '<div class="tr"><span class="tnone">Nothing more was read about this record.</span></div>') +
             '<div class="tfoot"><span class="tpre">Click for the full record</span></div>';
    }
    function paintInspector(){
      const n = SEL && MAP.byKey[SEL];
      // the content stays on the way out, so it does not empty mid-slide
      if (!n){ insp.classList.remove("on"); return; }
      // drawn from the copy, which keeps no emails or phones: ask for them once
      if (!n.e.facts.length && HOOKS.needFacts) HOOKS.needFacts(n);
      const link = (k, label) => '<button type="button" class="ilink" data-goto="' + esc(k) + '" style="--lnk:' + nodeColour(k) + '">' + esc(label) + "</button>";
      let rows = n.e.facts.map(f => '<div class="irow"><span class="il">' + esc(f[0]) + '</span><span class="iv2">' + esc(f[1]) + "</span></div>").join("");
      if (n.e.created) rows += '<div class="irow"><span class="il">Created</span><span class="iv2">' + esc(dstr(when(n.e.created))) + " UTC</span></div>";
      if (n.kind !== "company" && n.companyIds.length){
        rows += '<div class="irow"><span class="il">On accounts</span><span class="iv2">' + n.companyIds.map(cid => {
          const k = companyKey(cid);
          return MAP.byKey[k] ? link(k, MAP.byKey[k].e.label) : esc("Company " + cid);
        }).join(' <span class="inone">·</span> ') + "</span></div>";
      }
      if (n.segs.length){
        rows += '<div class="irow"><span class="il">Segment</span><span class="iv2">' +
          n.segs.map(id => esc(MAP.segments[id] ? MAP.segments[id].name : "Segment " + id)).join(' <span class="inone">·</span> ') + "</span></div>";
      }
      let walkLine = "";
      const acc = n.kind === "company" ? MAP.accounts[n.id] : null;
      if (n.kind === "company"){
        walkLine = '<div class="irow"><span class="il">Walked</span><span class="iv2">' +
          (acc && acc.walkedAt ? esc(dstr(when(acc.walkedAt))) + " UTC · " + esc(ago(acc.walkedAt)) : "never") +
          (acc && acc.capped && acc.capped.length ? " · hit a cap on " + esc(acc.capped.join(", ")) : "") +
          (acc && acc.missed ? ' · <span class="ibad">' + acc.missed + " " + plural(acc.missed, "read") + " refused — re-walk to complete</span>" : "") + "</span></div>";
      }
      const linked = n.adj.filter(k => MAP.byKey[k] && !isHidden(MAP.byKey[k]));
      const linkHtml = linked.length
        ? linked.slice(0, 16).map(k => link(k, MAP.byKey[k].e.label)).join(' <span class="inone">·</span> ') +
          (linked.length > 16 ? ' <span class="inone">and ' + (linked.length - 16) + " more</span>" : "")
        : '<span class="inone">nothing on this map</span>';
      let note = "";
      if (n.gone) note = goneText(n) + ". It stays on the map, struck through, until the account it belongs to is refreshed or re-walked.";
      else if (n.kind === "detached") note = "Carries a phone number used on an account here but links to nothing on the map. Activity logged against it is invisible from the account sharing that number.";
      else if (isStub(n) && n.field) note = "Brought in by a segment and not walked yet. Nothing on the map links to it so far. Walk it, or use Segments to find the links or walk the segment in batches.";
      else if (isStub(n)) note = "A record on the map belongs to this company, but it has never been walked. Press Walk it to bring it onto the map.";
      else if (n.companyIds.length > 1) note = "This record belongs to " + n.companyIds.length + " accounts on the map. Either the same person works for two businesses, or one of the two company records is a duplicate.";
      let acts = '<a class="act" href="' + esc(n.e.url) + '" target="_blank" rel="noopener noreferrer">Open in HubSpot</a>';
      if (n.kind === "company"){
        acts += '<button type="button" class="act go" data-act="walk" data-cid="' + esc(n.id) + '">' + (acc ? "Re-walk" : "Walk it") + "</button>";
        if (acc) acts += '<button type="button" class="act" data-act="forget" data-cid="' + esc(n.id) + '">Forget</button>';
      }
      acts += '<button type="button" class="act" data-goto="">Let go</button>';
      const list = insp.querySelector(".edlist"), listTop = list ? list.scrollTop : 0;
      insp.innerHTML =
        '<div class="ik"><span>' + esc(classify(n)) + '</span><span class="iid">record ' + esc(n.id) + "</span></div>" +
        '<div class="iv">' + esc(n.e.label) + "</div>" +
        (note ? '<div class="isub' + (n.mis || n.gone || n.kind === "detached" ? " bad" : "") + '">' + esc(note) + "</div>" : "") +
        rows + walkLine +
        '<div class="irow"><span class="il">Linked to</span><span class="iv2">' + linkHtml + "</span></div>" +
        '<div class="iacts">' + acts + "</div>" +
        // deleting in HubSpot: the editors' section (07d-edit.js), empty for everyone else
        (HOOKS.editHtml ? HOOKS.editHtml(n) : "");
      const list2 = insp.querySelector(".edlist");
      if (list2 && listTop) list2.scrollTop = listTop;
      insp.classList.add("on");
    }

    /* ---------------- legend and toolbar ---------------- */
    function paintLegend(){
      const c = mapCounts(), hide = " " + wrap.getAttribute("data-hide") + " ";
      const btn = (kind, mark, text, on) => on || hide.indexOf(" " + kind + " ") >= 0
        ? '<button type="button" class="lg" data-tog="' + kind + '" aria-pressed="' + (hide.indexOf(" " + kind + " ") < 0) + '">' + mark + esc(text) + "</button>" : "";
      legend.innerHTML =
        '<span class="lg static">' + swatch("company") + "Accounts</span>" +
        btn("contact", swatch("contact"), "Contacts", c.contact) +
        btn("lead", swatch("lead"), "Leads", c.lead) +
        btn("deal", swatch("deal"), "Deals", c.deal) +
        btn("detached", swatch("detached"), "Unattached, same number", c.detached) +
        btn("stub", swatch("stub"), "Known, not walked", c.stub) +
        btn("cross", lineSwatch("ecross"), "On more than one account", c.cross) +
        btn("echo", lineSwatch("eecho"), "Already said by another link", MAP.edges.length) +
        (c.shared ? '<span class="lg static">' + ringSwatch() + "Mis-associated</span>" : "");
    }
    function updateTools(){
      const undo = $("gundo");
      if (undo) undo.disabled = !Object.keys(POS[MODE]).length && !(MODE === "ring" && Object.keys(HOFF).length) && !GREW;
      wrap.querySelectorAll("[data-lay]").forEach(b => b.setAttribute("aria-pressed", String(b.getAttribute("data-lay") === MODE)));
      paintXall();
    }

    function refresh(opts){
      opts = opts || {};
      measure();
      const empty = !MAP.nodes.length;
      $("gempty").hidden = !empty;
      sync();
      paintLegend();
      if (empty){
        GEO = { mode: MODE, hives: [], fields: [], bounds: boundsOf([]) };
        gHalos.textContent = ""; gFields.textContent = ""; SEL = null; paint(); updateTools();
        return;
      }
      relayout(!!opts.fit);
    }

    /* ---------------- hover, tooltip and the expand buttons ---------------- */
    function tipAt(e){
      const r = TIP.getBoundingClientRect();
      let x = e.clientX + 16, y = e.clientY + 18;
      // flip rather than clamp, or it would sit on the record it describes
      if (x + r.width > window.innerWidth - 10) x = e.clientX - r.width - 16;
      if (y + r.height > window.innerHeight - 10) y = e.clientY - r.height - 18;
      TIP.style.left = Math.max(8, x) + "px"; TIP.style.top = Math.max(8, y) + "px";
    }
    function tipShow(key, e){
      if (key !== tipKey){ tipKey = key; TIP.innerHTML = tipHtml(key); TIP.style.setProperty("--node", nodeColour(key)); }
      TIP.classList.add("on"); tipAt(e);
    }
    function tipHide(){ tipKey = null; TIP.classList.remove("on"); }

    // The expand button belongs to the ONE record nearest the cursor —
    // measured to the record or to its button, whichever is nearer — and
    // fades in with that nearness. On a busy ring every neighbour in range
    // used to raise its own button, a stack of them on top of each other.
    // A record hidden by a filter is never picked.
    let picked = null;
    function nearPass(e){
      let pick = null, pickD = Infinity, v = 0;
      if (e){
        const w = toWorld(toView(e));
        const full = 24 / K, fade = 66 / K;
        MAP.nodes.forEach(n => {
          if (!n.el || isHidden(n)) return;
          const dx = Math.abs(w.x - n.x);
          const d = Math.min(Math.max(dx, Math.abs(w.y - n.y)), Math.max(dx, Math.abs(w.y - (n.y + btnDrop(n)))));
          if (d < fade && d < pickD){ pickD = d; pick = n; }
        });
        if (pick) v = pickD <= full ? 1 : (fade - pickD) / (fade - full);
      }
      if (picked && picked !== pick && picked.el){
        picked.el.style.removeProperty("--near"); picked.el.classList.remove("gnear", "gpick");
      }
      picked = pick;
      if (pick){ pick.el.style.setProperty("--near", v.toFixed(3)); pick.el.classList.add("gnear", "gpick"); }
    }

    const hitNode = e => { const t = e.target && e.target.closest && e.target.closest("[data-k]"); return t ? MAP.byKey[t.getAttribute("data-k")] : null; };
    const hitButton = e => !!(e.target && e.target.closest && e.target.closest(".gxb"));
    const hitUnlink = e => !!(e.target && e.target.closest && e.target.closest(".gunlink"));

    /* ---------------- unlinking, from the link itself ----------------
       For the Atlas's editors: near a link, a delete control rides it at
       the point nearest the cursor, and a click removes that association in
       HubSpot (after a moment in which it can be undone: 07d-edit.js). Only
       links that are HubSpot associations get one, never a shared-number
       line, a link already removed, or one hidden by a filter or the zoom;
       and never at a record or its expand button, which keep the cursor. */
    let uEd = null, uRaf = 0, uEv = null;
    const U_REACH = 16;                     // how near the link, in screen pixels
    const bez = (g, t) => {
      const u = 1 - t;
      return g.length === 3
        ? { x: u * u * g[0].x + 2 * u * t * g[1].x + t * t * g[2].x, y: u * u * g[0].y + 2 * u * t * g[1].y + t * t * g[2].y }
        : { x: u * u * u * g[0].x + 3 * u * u * t * g[1].x + 3 * u * t * t * g[2].x + t * t * t * g[3].x,
            y: u * u * u * g[0].y + 3 * u * u * t * g[1].y + 3 * u * t * t * g[2].y + t * t * t * g[3].y };
    };
    // the point of an edge nearest to p (a curve is followed as 24 short lines)
    function nearestOn(g, p){
      const pts = g.length === 2 ? g : Array.from({ length: 25 }, (_, i) => bez(g, i / 24));
      let bx = 0, by = 0, bd = Infinity;
      for (let i = 0; i + 1 < pts.length; i++){
        const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
        const t = L ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / L, 0, 1) : 0;
        const x = a.x + t * dx, y = a.y + t * dy, d = Math.hypot(p.x - x, p.y - y);
        if (d < bd){ bd = d; bx = x; by = y; }
      }
      return { x: bx, y: by, d: bd };
    }
    function linkHide(){
      if (uEd && uEd.el) uEd.el.classList.remove("eunl");
      uEd = null; unl.classList.remove("on");
    }
    // at most once a frame, however fast the mouse moves
    function linkLater(e){ uEv = e; if (!uRaf) uRaf = requestAnimationFrame(() => { uRaf = 0; linkPass(uEv); }); }
    function linkPass(e){
      if (!e || !HOOKS.canEdit || !HOOKS.canEdit() || drag || pan || svg.classList.contains("gquiet")){ linkHide(); return; }
      const w = toWorld(toView(e)), reach = U_REACH / K;
      // a record, or the picked record's expand button, has the cursor
      if (MAP.nodes.some(n => n.el && !isHidden(n) && Math.hypot(w.x - n.x, w.y - n.y) < nodeR(n) + 10 / K)){ linkHide(); return; }
      if (picked && Math.abs(w.x - picked.x) < 52 && Math.abs(w.y - picked.y - btnDrop(picked)) < 15){ linkHide(); return; }
      const hide = " " + (wrap.getAttribute("data-hide") || "") + " ", lod = K < G.lodK;
      let best = null, bp = null, bd = Infinity;
      MAP.edges.forEach(ed => {
        if (ed.rel === "detached" || ed.gone || ed.pend || !ed.el) return;
        const A = MAP.byKey[ed.a], B = MAP.byKey[ed.b];
        if (!A || !B || A.gone || B.gone) return;
        const g = edgeGeo(A, B, ed);
        // a box around the edge first: nearly all are nowhere near
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const q of g){ if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
        if (w.x < x0 - reach || w.x > x1 + reach || w.y < y0 - reach || w.y > y1 + reach) return;
        // hidden by a legend filter (its n-* classes), or an echo withdrawn at this zoom
        for (const c of ed.el.classList) if (c.startsWith("n-") && hide.indexOf(" " + c.slice(2) + " ") >= 0) return;
        if (lod && ed.el.classList.contains("n-echo") && !ed.el.classList.contains("glit")) return;
        const p = nearestOn(g, w);
        if (p.d > reach || p.d >= bd) return;
        // not where the link runs into a record
        if (Math.hypot(p.x - A.x, p.y - A.y) < nodeR(A) + 8 / K || Math.hypot(p.x - B.x, p.y - B.y) < nodeR(B) + 8 / K) return;
        best = ed; bp = p; bd = p.d;
      });
      if (!best){ linkHide(); return; }
      if (uEd !== best){ if (uEd && uEd.el) uEd.el.classList.remove("eunl"); uEd = best; best.el.classList.add("eunl"); }
      // the same size on screen at any zoom
      unl.setAttribute("transform", "translate(" + f1(bp.x) + "," + f1(bp.y) + ") scale(" + (Math.round(1e4 / K) / 1e4) + ")");
      unl.classList.add("on");
    }
    function tipLink(ed, e){
      const k = "unlink|" + ed.id;
      if (tipKey !== k){
        tipKey = k;
        const A = MAP.byKey[ed.a], B = MAP.byKey[ed.b];
        TIP.innerHTML = '<div class="tc">Remove this link in HubSpot</div><div class="tn">' + esc(A ? A.e.label : ed.a) + "</div>" +
          '<div class="ts">and ' + esc(B ? B.e.label : ed.b) + "</div>" +
          '<div class="tfoot"><span class="tpre">Click to unlink · 5 s to undo · both records stay</span></div>';
        TIP.style.setProperty("--node", "var(--alert)");
      }
      TIP.classList.add("on"); tipAt(e);
    }

    svg.addEventListener("mouseover", e => {
      const n = hitNode(e); if (!n) return;
      n.el.classList.add("ghot");
      if (!SEL) read.innerHTML = readout(n.key);
    });
    svg.addEventListener("mouseout", e => {
      const n = hitNode(e); if (n && n.el) n.el.classList.remove("ghot");
      if (!SEL) read.innerHTML = readout(null);
    });
    svg.addEventListener("mousemove", e => {
      const n = hitNode(e);
      if (n) tipShow(n.key, e); else if (uEd && hitUnlink(e)) tipLink(uEd, e); else tipHide();
      lastMove = { clientX: e.clientX, clientY: e.clientY };
      nearPass(e);
      linkLater(lastMove);
    });
    // the cursor has gone, so a later relayout must not revive a button for it
    svg.addEventListener("mouseleave", () => { tipHide(); lastMove = null; nearPass(null); linkHide(); });

    /* ---------------- pressing, dragging, panning ---------------- */
    let pan = null, drag = null, moved = false, pressHeld = false;
    svg.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      moved = false;                      // cleared FIRST, or a press on a button inherits the last drag
      if (hitButton(e) || hitUnlink(e)) return;
      const n = hitNode(e), v = toView(e);
      if (n){
        // the press holds the record, so a drag lights its paths on the way
        pressHeld = SEL === n.key;
        if (!pressHeld){ SEL = n.key; paint(); bringIntoView(n.key); }
        // dragging a company drags its whole hive with it
        const h = MODE === "ring" && n.kind === "company" ? GEO.hives.find(q => q.node === n) : null;
        const group = h ? [n].concat(h.members, h.sats.map(s => s.node)) : [n];
        drag = { n, h, v, start: group.map(m => ({ m, x: m.x, y: m.y })),
                 off: h ? Object.assign({ x: 0, y: 0 }, HOFF[h.key]) : null };
      } else {
        pressHeld = false;
        pan = { v, tx: TX, ty: TY };
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
    function onMove(e){
      const src = drag || pan;
      if (!src) return;
      const v = toView(e), dx = v.x - src.v.x, dy = v.y - src.v.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4){ moved = true; svg.classList.add(drag ? "gmoving" : "gdrag"); tipHide(); }
      if (!moved) return;
      gesture();
      if (drag){
        drag.start.forEach(s => {
          s.m.x = s.x + dx / K; s.m.y = s.y + dy / K;
          // a hive moves as an offset; a single record as a position
          if (!drag.h || POS[MODE][s.m.key]) POS[MODE][s.m.key] = { x: s.m.x, y: s.m.y };
        });
        if (drag.h){
          HOFF[drag.h.key] = { x: drag.off.x + dx / K, y: drag.off.y + dy / K };
          drag.start.forEach(s => placeNode(s.m)); moveHalo(drag.h); layEdges();
        }
        else {
          placeNode(drag.n);
          // a hive centre on its own (the hierarchy) re-sides its records' labels
          if (drag.n.kind === "company") MAP.nodes.forEach(m => { if (m.hive === drag.n.key) placeNode(m); });
          layEdges(drag.n.kind === "company" ? null : drag.n);
        }
        if (SEL === drag.n.key) placeReticle();
      } else {
        TX = pan.tx + dx; TY = pan.ty + dy; camSet = true; apply(true);
      }
    }
    function onUp(){
      // let go: the map is drawn where the pan left it, straight away
      if (preview) settle();
      if (drag && moved) updateTools();
      if (moved) changed();
      drag = null; pan = null;
      svg.classList.remove("gdrag", "gmoving");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    }
    svg.addEventListener("click", e => {
      if (moved) return;                  // a drag does nothing when let go
      if (hitUnlink(e)){
        e.preventDefault();
        const ed = uEd;
        linkHide(); tipHide();
        if (ed && HOOKS.unlink) HOOKS.unlink(ed);
        return;
      }
      const n = hitNode(e);
      if (n && hitButton(e)){
        e.preventDefault();
        if (isStub(n)) acquire({ kind: "company", value: n.id });
        else expandNode(n);
        return;
      }
      if (!n){ if (SEL) letGo(); return; }
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey){ openRecord(n); return; }
      if (pressHeld) letGo();
    });
    svg.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
      const n = hitNode(e); if (!n) return;
      e.preventDefault();
      if (SEL === n.key){ letGo(); return; }
      SEL = n.key; paint(); bringIntoView(n.key);
    });
    // The shape is not a link, so opening one means making a throwaway
    // anchor outside the SVG, which the browser treats as a normal click.
    function openRecord(n){
      const a = document.createElement("a");
      a.href = n.e.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      document.body.appendChild(a); a.click(); a.remove();
    }
    svg.addEventListener("dblclick", e => e.preventDefault());
    svg.addEventListener("dragstart", e => e.preventDefault());
    // A plain wheel scrolls the page; ctrl/cmd-wheel zooms.
    // A wheel sends dozens of events a second; they are gathered and the
    // map is zoomed once per frame, by all of them together.
    let wheelAcc = null;
    svg.addEventListener("wheel", e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const v = toView(e);
      gesture();
      if (!wheelAcc){
        wheelAcc = { x: v.x, y: v.y, f: 1 };
        requestAnimationFrame(() => { const w = wheelAcc; wheelAcc = null; zoomAt(w.x, w.y, w.f, true); });
      }
      wheelAcc.x = v.x; wheelAcc.y = v.y;
      wheelAcc.f *= Math.exp(-e.deltaY * 0.0022);
    }, { passive: false });

    wrap.addEventListener("click", e => {
      const b = e.target && e.target.closest && e.target.closest("[data-z],[data-tog],[data-goto],[data-lay],[data-act],[data-ed]");
      if (!b) return;
      if (b.hasAttribute("data-ed")){
        if (!b.disabled && HOOKS.editAct) HOOKS.editAct(b.getAttribute("data-ed"), b, SEL ? MAP.byKey[SEL] : null);
        return;
      }
      if (b.hasAttribute("data-act")){
        const act = b.getAttribute("data-act"), cid = b.getAttribute("data-cid");
        if (act === "walk") acquire({ kind: "company", value: cid }, { force: !!MAP.accounts[cid] });
        if (act === "forget"){
          // destructive, and undone only by walking it again, so it asks twice
          if (!b.classList.contains("arm")){
            b.classList.add("arm"); b.textContent = "Press again to forget";
            setTimeout(() => { if (b.isConnected){ b.classList.remove("arm"); b.textContent = "Forget"; } }, 4000);
            return;
          }
          dropAccount(cid);
        }
        return;
      }
      if (b.hasAttribute("data-lay")){
        const lay = b.getAttribute("data-lay");
        if (lay !== MODE){ MODE = lay; relayout(true); changed(); }
        return;
      }
      if (b.hasAttribute("data-z")){
        const z = b.getAttribute("data-z");
        if (z === "fit"){ fitView(); changed(); }
        else if (z === "xall") xallPress(b);
        else if (z === "png") savePng(b);
        else if (z === "names") setNames(!namesOn);
        else if (z === "full") isFull() ? exitFull() : enterFull();
        else if (z === "relayout"){ POS[MODE] = {}; if (MODE === "ring") HOFF = {}; GREW = false; relayout(true); changed(); }
        else zoomAt(vbW / 2, vbH / 2, z === "in" ? 1.3 : 1 / 1.3);
        return;
      }
      if (b.hasAttribute("data-tog")){
        const kind = b.getAttribute("data-tog");
        const cur = (wrap.getAttribute("data-hide") || "").split(/\s+/).filter(Boolean);
        const at = cur.indexOf(kind);
        if (at < 0) cur.push(kind); else cur.splice(at, 1);
        wrap.setAttribute("data-hide", cur.join(" "));
        b.setAttribute("aria-pressed", String(at >= 0));
        if (SEL && isHidden(MAP.byKey[SEL])) letGo(); else paint();
        paintXall();
        changed();
        return;
      }
      if (b.hasAttribute("data-goto")){
        const to = b.getAttribute("data-goto") || null;
        SEL = to; paint();
        if (to) travelTo(to, false);
      }
    });

    /* ---------------- fullscreen ---------------- */
    // A CSS overlay is the mechanism; the Fullscreen API is asked for on top
    // of it, because it is not granted in every embedding.
    const isFull = () => wrap.classList.contains("gfull");
    function fullLabel(){ const b = wrap.querySelector('[data-z="full"]'); if (b) b.textContent = isFull() ? "Collapse" : "Expand"; }
    function enterFull(){
      if (isFull()) return;
      wrap.classList.add("gfull");
      ROOT.classList.add("gfullon");
      // a fullscreened element is the only thing painted, so the tooltip moves in
      wrap.appendChild(TIP);
      if (wrap.requestFullscreen){ try { const p = wrap.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch(e){} }
      fullLabel();
    }
    function exitFull(){
      if (!isFull()) return false;
      wrap.classList.remove("gfull");
      ROOT.classList.remove("gfullon");
      document.body.appendChild(TIP);
      if (document.fullscreenElement && document.exitFullscreen){ try { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); } catch(e){} }
      fullLabel();
      return true;
    }
    // Escape in native fullscreen is the browser's; bring the overlay back into step
    document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) exitFull(); });

    // the frame changes size with the window and with fullscreen
    if (window.ResizeObserver) new ResizeObserver(() => { if (measure()){ apply(); nearPass(null); } }).observe(svg);
    else window.addEventListener("resize", () => { if (measure()) apply(); });

    /* ---------------- the map as a PNG ---------------- */
    // An <img> gets none of this page's stylesheet, so every computed style
    // is written onto a clone first. The whole map is exported at zoom 1
    // with record labels showing, whatever the camera is doing.
    const PNGPROPS = ["fill","fill-opacity","stroke","stroke-width","stroke-opacity","stroke-dasharray","stroke-linecap",
                      "opacity","display","visibility","font-family","font-size","font-weight","letter-spacing","text-anchor","text-transform"];
    function plotToPng(){
      return new Promise((resolve, reject) => {
        const held = SEL, k0 = K;
        // transitions off first: read mid-fade, every record the selection
        // had dimmed was baked into the picture nearly invisible
        svg.classList.add("gexport");
        SEL = null; paint();
        svg.classList.remove("glod"); K = 1; scaleHubLabels();
        void svg.getBoundingClientRect();
        const clone = svg.cloneNode(true);
        const src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
        for (let i = 0; i < src.length && i < dst.length; i++){
          const cs = getComputedStyle(src[i]);
          dst[i].setAttribute("style", PNGPROPS.map(p => { const v = cs.getPropertyValue(p); return v ? p + ":" + v + ";" : ""; }).join(""));
        }
        K = k0; labelK = null; apply();
        SEL = held; paint();
        svg.classList.remove("gexport");
        const b = GEO.bounds;
        const x0 = b.x0 - 40, y0 = b.y0 - 40, w = Math.max(200, b.x1 - b.x0 + 80), h = Math.max(160, b.y1 - b.y0 + 80);
        clone.querySelector("#gscene").removeAttribute("transform");
        clone.querySelectorAll(".glabel").forEach(t => { t.textContent = String(t.textContent || "").toUpperCase(); });
        clone.querySelectorAll(".gxb,.reticle,.gunlink").forEach(t => t.remove());
        clone.setAttribute("xmlns", SVGNS);
        clone.setAttribute("viewBox", [x0, y0, w, h].map(f1).join(" "));
        clone.setAttribute("width", Math.round(w)); clone.setAttribute("height", Math.round(h));
        // big maps come down in scale rather than outgrowing a canvas
        const scale = Math.min(2, 8000 / Math.max(w, h));
        const cv = document.createElement("canvas");
        cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
        const ctx = cv.getContext("2d");
        ctx.fillStyle = getComputedStyle(ROOT).getPropertyValue("--void").trim() || "#07070A";
        ctx.fillRect(0, 0, cv.width, cv.height);
        const img = new Image();
        img.onload = () => {
          try { ctx.drawImage(img, 0, 0, cv.width, cv.height); cv.toBlob(bl => bl ? resolve(bl) : reject({ code: "encode" }), "image/png"); }
          catch(e){ reject({ code: "draw" }); }
        };
        img.onerror = () => reject({ code: "render" });
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
      });
    }
    async function savePng(btn){
      const was = btn.textContent;
      btn.disabled = true; btn.textContent = "…";
      const done = (label, bad) => {
        btn.classList.toggle("gbad", !!bad); btn.textContent = label;
        setTimeout(() => { btn.classList.remove("gbad"); btn.textContent = was; btn.disabled = false; }, 2600);
      };
      try {
        const blob = await plotToPng();
        // the sandbox blocks page-started downloads, so this goes out as a Blob
        const dl = await use("downloads");
        if (!dl){ done("no saving", true); return; }
        const tag = HOOKS.fileTag ? HOOKS.fileTag() : "";
        const res = await dl.save({ filename: "account-atlas-" + (tag ? tag + "-" : "") + new Date().toISOString().slice(0, 10) + "-" + MODE + ".png", data: blob });
        done(res && res.status === "delivered" ? "sent" : "saved", false);
      } catch(err){
        const code = (err && err.code) || "";
        done(code === "declined" ? "cancelled" : code === "rate_limited" ? "try again" : code === "too_large" ? "too large" : "could not save", true);
      }
    }

    /*@@EXPAND@@*/

    // a record ticked or unticked in the delete checklist
    insp.addEventListener("change", e => {
      const c = e.target && e.target.closest && e.target.closest("[data-edk]");
      if (c && HOOKS.editTick) HOOKS.editTick(c.getAttribute("data-edk"), c.checked);
    });

    measure();
    return {
      refresh, travelTo, exitFull, letGo,
      hasSelection: () => !!SEL,
      // what an edit changes without moving anything: the inspector, the links' marks
      repaintInspector: () => paintInspector(),
      repaintEdges: () => layEdges(),
      resetPositions(){ POS = { ring: {}, tree: {} }; HOFF = {}; GREW = false; SEL = null; },
      // The arrangement a canvas saves: layout, dragged records and hives,
      // filters, and where the camera was — its centre in the map, so it
      // reopens on the same place whatever size the frame is then.
      getViewState(){
        return { mode: MODE, pos: POS, hoff: HOFF, hide: wrap.getAttribute("data-hide") || "",
                 cam: camSet ? { k: +K.toFixed(4), x: +((vbW / 2 - TX) / K).toFixed(1), y: +((vbH / 2 - TY) / K).toFixed(1) } : null };
      },
      setViewState(s){
        s = s && typeof s === "object" ? s : {};
        const pts = o => {
          const out = {};
          if (o && typeof o === "object") Object.keys(o).forEach(k => { const p = o[k]; if (p && isFinite(p.x) && isFinite(p.y)) out[k] = { x: +p.x, y: +p.y }; });
          return out;
        };
        MODE = s.mode === "tree" ? "tree" : "ring";
        POS = { ring: pts(s.pos && s.pos.ring), tree: pts(s.pos && s.pos.tree) };
        HOFF = pts(s.hoff);
        const hide = typeof s.hide === "string" ? s.hide.split(/\s+/).filter(k => ["contact","deal","lead","detached","stub","cross","echo"].indexOf(k) >= 0).join(" ") : "";
        wrap.setAttribute("data-hide", hide);
        SEL = null; GREW = false; camSet = false;
        pendingCam = s.cam && isFinite(s.cam.k) && isFinite(s.cam.x) && isFinite(s.cam.y) ? s.cam : null;
        exitFull();
      }
    };
  }
