
  /* =====================================================================
     7. HUBSPOT ROWS → MAP RECORDS
     Values are RAW here; they are escaped at render time.
     ===================================================================== */
  const ASKFOR = {
    COMPANY: ["name","domain","phone","country","city","createdate","hubspot_owner_id","lifecyclestage","hs_created_by_user_id"],
    CONTACT: ["firstname","lastname","email","phone","mobilephone","createdate","hubspot_owner_id","lifecyclestage","hs_object_source_label","hs_created_by_user_id"],
    DEAL:    ["dealname","dealstage","pipeline","amount","createdate","hubspot_owner_id","admin_app_user__id","hs_created_by_user_id","sdr_name_deal","sdr_handoff_to_bdr_deal"],
    LEAD:    ["hs_lead_name","hs_pipeline_stage","hubspot_owner_id","hs_createdate","hs_lead_source","hs_created_by_user_id"]
  };
  const facts = list => list.filter(p => p && p[1] != null && p[1] !== "");
  const aed = v => v ? "AED " + fmt(Number(v)) : null;
  function contactName(x){
    const p = x.properties || {};
    return x.displayName || ((p.firstname || "") + " " + (p.lastname || "")).trim() || "Contact " + x.id;
  }

  function dCompany(x){
    const p = x.properties || {};
    return {
      k: companyKey(x.id), kd: "company", id: String(x.id), t: "0-2",
      l: p.name || "Company " + x.id, s: p.domain || "",
      c: isoOf(p.createdate), o: owner(p.hubspot_owner_id), cr: maker(p.hs_created_by_user_id),
      // hh is a node KEY everywhere, never a bare record id
      ci: [], hh: companyKey(x.id),
      f: facts([["Domain", p.domain], ["Country", p.country], ["City", p.city],
                ["Owner", owner(p.hubspot_owner_id) || "unowned"],
                ["Created by", maker(p.hs_created_by_user_id)], ["Lifecycle", p.lifecyclestage]])
    };
  }
  function dContact(x, cid, home, detached){
    const p = x.properties || {};
    return {
      k: recKey("0-1", x.id), kd: detached ? "detached" : "contact", id: String(x.id), t: "0-1",
      l: contactName(x), s: p.hs_object_source_label || "",
      c: isoOf(p.createdate), o: owner(p.hubspot_owner_id), cr: maker(p.hs_created_by_user_id),
      ci: cid ? [String(cid)] : [], hh: home,
      f: facts([["Email", p.email], ["Phone", [p.phone, p.mobilephone].filter(Boolean).join(" · ")],
                ["Owner", owner(p.hubspot_owner_id) || "unowned"], ["Created by", maker(p.hs_created_by_user_id)],
                ["Lifecycle", p.lifecyclestage], ["Source", p.hs_object_source_label]])
    };
  }
  function dDeal(x, cid, home){
    const p = x.properties || {};
    // sdr_name_deal and sdr_handoff_to_bdr_deal hold OWNER ids — the only
    // record of who actually worked a deal, whoever owns it
    const side = id => id ? repPlain(id) + (GONE[id] ? " (left)" : "") : "not recorded";
    const hand = (p.sdr_name_deal || p.sdr_handoff_to_bdr_deal)
      ? side(p.sdr_name_deal) + " → " + side(p.sdr_handoff_to_bdr_deal) : null;
    return {
      k: recKey("0-3", x.id), kd: "deal", id: String(x.id), t: "0-3",
      l: p.dealname || "Deal " + x.id, s: aed(p.amount) || "",
      c: isoOf(p.createdate), o: owner(p.hubspot_owner_id), cr: maker(p.hs_created_by_user_id),
      ci: cid ? [String(cid)] : [], hh: home,
      f: facts([["Amount", aed(p.amount)], ["Stage", dealStage(p.dealstage)], ["Pipeline", pipeName(p.pipeline)],
                ["Owner", owner(p.hubspot_owner_id) || "unowned"], ["SDR → BDR", hand],
                ["Admin-app key", p.admin_app_user__id]])
    };
  }
  function dLead(x, cid, home){
    const p = x.properties || {};
    return {
      k: recKey("0-136", x.id), kd: "lead", id: String(x.id), t: "0-136",
      l: p.hs_lead_name || "Lead " + x.id, s: "",
      c: isoOf(p.hs_createdate), o: owner(p.hubspot_owner_id), cr: maker(p.hs_created_by_user_id),
      ci: cid ? [String(cid)] : [], hh: home,
      f: facts([["Stage", leadStage(p.hs_pipeline_stage)], ["Owner", owner(p.hubspot_owner_id) || "unowned"],
                ["Created by", maker(p.hs_created_by_user_id)], ["Source", p.hs_lead_source]])
    };
  }

  /* =====================================================================
     8. THE PROMPT — every accepted identifier is exact: a record id, an
     email, or the admin-app user id carried on a deal. No name matching.
     ===================================================================== */
  const UUID_RE  = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // A bare record id is the only ambiguous form; this says which it is.
  let IDMODE = "company";

  function resolveInput(raw){
    const q = String(raw || "").trim();
    if (!q) return null;
    const u = q.match(UUID_RE);
    if (u) return { kind: "adminKey", value: u[0].toLowerCase() };
    if (EMAIL_RE.test(q)) return { kind: "email", value: q.toLowerCase() };
    for (const [t, kind] of [["0-1", "contact"], ["0-2", "company"], ["0-3", "deal"]]){
      const m = q.match(new RegExp("/record/" + t + "/(\\d+)"));
      if (m) return { kind, value: m[1] };
    }
    if (/^\d{4,}$/.test(q)) return { kind: IDMODE === "contact" ? "contact" : "company", value: q };
    return null;
  }
  function hintFor(){
    // a bare number is a company here, so a deal is taken by its URL — the
    // hint used to offer "deal record id" and then read it as a company
    const base = IDMODE === "contact"
      ? "Contact record id &nbsp;·&nbsp; Email address &nbsp;·&nbsp; Record URL"
      : "Company record id &nbsp;·&nbsp; Deal or contact URL &nbsp;·&nbsp; Admin-app user id &nbsp;·&nbsp; Email";
    return base + " &nbsp;·&nbsp; Return to acquire" + (MAP.nodes.length ? " &nbsp;·&nbsp; Esc for the map" : "");
  }
  function setIdMode(m){
    IDMODE = m === "contact" ? "contact" : "company";
    document.querySelectorAll("[data-mode]").forEach(b =>
      b.setAttribute("aria-checked", b.getAttribute("data-mode") === IDMODE ? "true" : "false"));
    const ph = IDMODE === "contact" ? "ENTER EMAIL OR CONTACT ID" : "ENTER DESIGNATION";
    $("q").placeholder = ph; $("q2").placeholder = ph;
    $("ghint").innerHTML = hintFor();
    // the drawn cursor measures the placeholder while the field is empty
    $("q").dispatchEvent(new Event("input"));
  }
  function inputError(msg){
    // In the open map the gate is out of sight, so the refusal goes under
    // the search bar instead — before, it was written where nobody saw it.
    if (PHASE === "open"){
      const q = $("qerr");
      q.textContent = msg || "";
      if (msg){ const box = $("q2").parentNode; box.classList.add("qbad"); setTimeout(() => box.classList.remove("qbad"), 900); }
      return;
    }
    $("gerr").textContent = msg || "";
    if (msg && PHASE === "gate"){
      const f = $("q").parentNode;
      f.style.boxShadow = "0 0 38px rgba(224,167,60,.32)";
      setTimeout(() => { f.style.boxShadow = ""; }, 900);
    }
  }

  /* =====================================================================
     9. ACQUIRING — two outcomes and only two:
       already on the map -> nothing is re-walked, the VIEW TRAVELS to it
       not on the map     -> walk it, merge it, save it, then travel to it
     ===================================================================== */
  // One walk, re-walk or Forget at a time: each rebuilds the model the
  // others would be writing into.
  let ACQUIRING = false;
  let BOOT = null;                 // the restore from the store; a lookup waits for it

  function lookupFromInput(fromBar){
    const src = (fromBar && PHASE === "open") ? $("q2") : $("q");
    const raw = String(src.value || "").trim();
    if (!raw){ inputError("Enter a company record id or an admin-app user id."); if (PHASE !== "open") focusGate(); return; }
    const what = resolveInput(raw);
    if (!what){
      inputError(IDMODE === "contact"
        ? "Not a designation. In contact mode this takes an email address, a contact record id such as 100000000002, or a HubSpot record URL."
        : "Not a designation. Expected a company record id such as 100000000001, an admin-app user id such as " +
          "00000000-0000-4000-8000-000000000001, an email address, or a HubSpot record URL.");
      if (PHASE !== "open") focusGate();
      return;
    }
    inputError("");
    $("q").value = raw; $("q2").value = raw;
    acquire(what, { raw });
  }

  // `what` is always explicit here. Walk it and Re-walk used to go through
  // the text box, so in contact mode a company id was read as a contact.
  async function acquire(what, opts){
    opts = opts || {};
    // a lookup pasted while the map is still loading waits for it, or it
    // would re-walk an account that is already stored
    if (BOOT) await BOOT;
    if (ACQUIRING){
      // a segment run holds the lock for minutes; say so rather than ignore the press
      if (SEGJOB) inputError("A segment run is in progress. Stop it in Segments, or wait for it to finish.");
      return;
    }
    const cid = what.kind === "company" ? String(what.value) : null;
    if (cid && MAP.accounts[cid] && !opts.force){
      if (PHASE !== "open") await openMap();
      VIEW.travelTo(companyKey(cid), true);
      return;
    }
    ACQUIRING = true;
    try {
      await stopExpansions();
      VIEW.exitFull();               // a walk behind a fullscreen plot is a walk nobody sees
      const reopening = PHASE === "open";
      logReset();
      setPhase("run");
      if (reopening) await wait(720);
      logLine("SESSION <b>" + Math.random().toString(16).slice(2, 6).toUpperCase() + "-" +
              Math.random().toString(16).slice(2, 6).toUpperCase() + "</b> &middot; OPERATOR " + esc(OPERATOR));
      logLine("LINK &middot; HUBSPOT CONNECTOR &middot; <b>READ-ONLY</b>");
      logLine("CANVAS &middot; <b>" + esc(CV.cur.name).toUpperCase() + "</b> &middot; " + CV.cur.scope.toUpperCase() +
              " &middot; <b>" + MAP.order.length + "</b> " + plural(MAP.order.length, "ACCOUNT") +
              " &middot; <b>" + fmt(MAP.nodes.length) + "</b> RECORDS HELD");
      await wait(140);
      logLine("QUERY &middot; <b>" + esc(opts.raw || what.value) + "</b>" + (opts.force ? " &middot; RE-WALK" : ""));
      logLine("PARSE &middot; " + ({ adminKey: "ADMIN-APP USER ID", email: "CONTACT EMAIL ADDRESS",
        contact: "CONTACT RECORD ID", deal: "DEAL RECORD ID" }[what.kind] || "COMPANY RECORD ID"));
      prog(4, "RESOLVING TARGET");
      await wait(170);
      const target = cid ? { id: cid, via: null } : await resolveCompany(what);
      if (!target) return;
      if (MAP.accounts[String(target.id)] && !opts.force){
        logLine("ALREADY ON THE MAP &middot; <b>" + esc(MAP.accounts[String(target.id)].name || target.id) + "</b> &middot; NOTHING RE-WALKED");
        prog(100, "TRAVELLING");
        await openMap();
        VIEW.travelTo(companyKey(target.id), true);
        return;
      }
      await walkCompany(String(target.id), target.via, !!opts.force);
    } finally {
      ACQUIRING = false;
    }
  }

  // Resolve a contact, email, deal or admin-app key to its company.
  async function resolveCompany(what){
    const step = logStep({ adminKey: "TRACE KEY THROUGH DEAL RECORDS", email: "MATCH ADDRESS TO A CONTACT",
                           contact: "READ CONTACT RECORD" }[what.kind] || "RESOLVE ACCOUNT FROM DEAL");
    try {
      if (what.kind === "email" || what.kind === "contact"){
        let cIds;
        if (what.kind === "email"){
          const r = await hubspot({ objectType: "CONTACT",
            filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: what.value }] }],
            properties: ["firstname","lastname","email"], limit: 10 });
          const hits = (r && r.results) || [];
          if (!hits.length){ stepEnd(step, "NO CONTACT", true); fail("No contact in HubSpot carries the address <code>" + esc(what.value) + "</code>."); return null; }
          if (hits.length > 1){
            // the audit found no duplicate emails in this portal, so this is
            // worth stopping for rather than quietly picking one
            stepEnd(step, hits.length + " CONTACTS ON ONE ADDRESS", true);
            fail("<b>" + hits.length + " contacts</b> carry <code>" + esc(what.value) + "</code>. Which account you meant is not obvious — " +
                 "open one and acquire it by its record id: " + hits.map(h => esc(h.id)).join(", "));
            return null;
          }
          cIds = [hits[0].id];
          stepOk(step, esc(String(hits[0].displayName || hits[0].id).toUpperCase()));
        } else {
          cIds = [what.value];
          stepOk(step, "CONTACT " + esc(what.value));
        }
        prog(10, "LOCATING ACCOUNT");
        const s2 = logStep("LOCATE PARENT COMPANY");
        const cos = await byAssoc("COMPANY", "contacts", cIds, ["name"], 5, "IN");
        if (!cos.length){
          stepEnd(s2, "NO PARENT", true);
          fail("That contact belongs to no company, so there is no account to draw. The contact itself is record " + esc(cIds[0]) + ".");
          return null;
        }
        stepOk(s2, cos.length > 1 ? cos.length + " COMPANIES" : "ONE COMPANY");
        if (cos.length > 1) logLine("THAT CONTACT BELONGS TO <b>" + cos.length + "</b> COMPANIES &middot; OPENING THE FIRST &middot; " +
                                    "THE MAP WILL SHOW THE REST ONCE THEY ARE WALKED", "err");
        return { id: cos[0].id, via: "reached through the contact" };
      }

      let dealIds;
      if (what.kind === "adminKey"){
        const r = await hubspot({ objectType: "DEAL",
          filterGroups: [{ filters: [{ propertyName: "admin_app_user__id", operator: "EQ", value: what.value }] }],
          properties: ["dealname","admin_app_user__id"], limit: 20 });
        const found = (r && r.results) || [];
        if (!found.length){
          stepEnd(step, "NO CARRIER", true);
          fail("No deal in HubSpot carries the admin-app user id <code>" + esc(what.value) + "</code>. " +
               "Either the client has no HubSpot deal, or the key was never pasted onto it.");
          return null;
        }
        dealIds = found.map(r2 => r2.id);
        stepOk(step, found.length + " " + plural(found.length, "DEAL"));
      } else {
        dealIds = [what.value];
        stepOk(step, "DEAL " + esc(what.value));
      }
      prog(10, "LOCATING ACCOUNT");
      const s3 = logStep("LOCATE PARENT COMPANY");
      let via = "the deal";
      let cos = await byAssoc("COMPANY", "deals", dealIds, ["name"], 5, "IN");
      if (!cos.length){
        const cts = await byAssoc("CONTACT", "deals", dealIds, ["firstname"], 20, "IN");
        if (cts.length){ cos = await byAssoc("COMPANY", "contacts", cts.map(c => c.id), ["name"], 5, "IN"); via = "a contact on the deal"; }
      }
      if (!cos.length){
        stepEnd(s3, "NO PARENT", true);
        fail("That deal has no company attached, and none of its contacts belong to one either — so there is no account to draw.");
        return null;
      }
      stepOk(s3, via.toUpperCase());
      return { id: cos[0].id, via: "reached through " + via };
    } catch(err){
      stepEnd(CON.open, "LINK ERROR", true);
      fail(err && err.code === "no_connector"
        ? "The HubSpot connector is not available in this view, so nothing can be looked up."
        : "HubSpot could not answer that lookup.");
      return null;
    }
  }

  /* =====================================================================
     10. THE WALK — one company: its records, how they link to each other,
     and what any of them reach outside it, merged into the map by RECORD.
     walkCore does the reading, merging and saving and reports through R,
     so the console walk and a segment's batch walk are the SAME walk:
       R.step(label) -> handle · R.ok(h, note) · R.end(h, note, bad)
       R.prog(pct, label) · R.line(html, cls)
     ===================================================================== */
  const CONSOLE_R = { step: logStep, ok: stepOk, end: stepEnd, prog, line: logLine };
  const QUIET_R = { step: () => null, ok(){}, end(){}, prog(){}, line(){} };

  // -> { ok, why?, name, touched, shared, saved, missed }; a connector
  // failure on a read the walk cannot do without THROWS
  async function walkCore(cid, R){
    const touched = {}, edgeIds = {}, capped = [], at = new Date().toISOString();
    // a read that fails where the walk can carry on is counted, not hidden:
    // the account is then marked incomplete instead of looking finished
    let missed = 0;
    const take = d => { const n = mergeNode(d, at); touched[n.key] = 1; return n; };
    const join = (a, b, rel) => {
      if (!MAP.byKey[a] || !MAP.byKey[b]) return null;
      const ed = mergeEdge(a, b, rel); if (ed) edgeIds[ed.id] = 1; return ed;
    };
    const hubKey = companyKey(cid);

    R.prog(16, "READING COMPANY RECORD");
    const sRead = R.step("READ COMPANY 0-2/" + esc(cid));
    const cRes = await hubspot({ objectType: "COMPANY",
      filterGroups: [{ filters: [{ propertyName: "hs_object_id", operator: "EQ", value: cid }] }],
      properties: ASKFOR.COMPANY, limit: 1 });
    const co = ((cRes && cRes.results) || [])[0];
    if (!co){ R.end(sRead, "NOT READABLE", true); return { ok: false, why: "That company could not be read." }; }
    const cp = co.properties || {};
    R.ok(sRead, esc(String(cp.name || cid).toUpperCase()));
    take(dCompany(co));

    // ---- membership: every one of these records IS on this company
    const rows = {};
    for (const [pct, type, label] of [[28, "CONTACT", "CONTACTS"], [38, "DEAL", "DEALS"], [47, "LEAD", "LEADS"]]){
      R.prog(pct, "WALKING ASSOCIATIONS");
      const st = R.step("ASSOCIATED " + label);
      rows[type] = await byAssoc(type, "companies", [cid], ASKFOR[type], CAP.obj, "EQUAL");
      const full = rows[type].length >= CAP.obj;
      if (full) capped.push(label.toLowerCase());
      R.ok(st, rows[type].length + " LINKED" + (full ? " · CAPPED" : ""));
    }
    rows.CONTACT.forEach(x => join(hubKey, take(dContact(x, cid, hubKey)).key, "member"));
    rows.DEAL.forEach(x => join(hubKey, take(dDeal(x, cid, hubKey)).key, "member"));
    rows.LEAD.forEach(x => join(hubKey, take(dLead(x, cid, hubKey)).key, "member"));

    // ---- how those records relate to EACH OTHER: which contact is on
    // which deal is what tells you whether a deal has anybody to call
    R.prog(60, "MAPPING RECORDS TO EACH OTHER");
    const meshN = Math.min(rows.DEAL.length + rows.LEAD.length, CAP.link);
    const sLk = R.step("ASSOCIATION MESH &middot; " + meshN + " " + plural(meshN, "OBJECT"));
    let calls = 0, links = 0, meshCut = false, ldCut = false;
    const mesh = rows.DEAL.map(r => ["deals", "0-3", r.id]).concat(rows.LEAD.map(r => ["leads", "0-136", r.id]));
    for (const [as, t, id] of mesh){
      if (calls >= CAP.link){ meshCut = true; break; }
      calls++;
      try {
        (await byAssoc("CONTACT", as, [id], ["firstname"], CAP.obj, "EQUAL"))
          .forEach(r => { if (join(recKey("0-1", r.id), recKey(t, id), "link")) links++; });
      } catch(e){ missed++; }
    }
    // which deals a lead is on — asked separately, because the sweep above
    // is contact-keyed and would read one end as a contact
    let ldCalls = 0;
    for (const r0 of rows.LEAD){
      if (ldCalls >= CAP.leadDeal){ ldCut = true; break; }
      ldCalls++;
      try {
        (await byAssoc("DEAL", "leads", [r0.id], ["dealname"], CAP.obj, "EQUAL"))
          .forEach(r => { if (join(recKey("0-136", r0.id), recKey("0-3", r.id), "link")) links++; });
      } catch(e){ missed++; }
    }
    if (meshCut) capped.push("link mesh");
    if (ldCut) capped.push("lead-to-deal");
    R.ok(sLk, links + " " + plural(links, "LINK") + (meshCut || ldCut ? " · CAPPED" : ""));

    // ---- what this account's records reach OUTSIDE it. A foreign company
    // is a company node, and the contact reaching it now carries TWO
    // company ids — which is what rings it and draws the cross edge.
    const ourIds = rows.CONTACT.map(r => String(r.id));
    if (ourIds.length){
      R.prog(70, "REACHING OUTSIDE THE ACCOUNT");
      const sOut = R.step("LINKS LEAVING THIS ACCOUNT");
      const ourDeal = new Set(rows.DEAL.map(r => String(r.id)));
      const foreign = [];
      const some = ourIds.slice(0, CAP.obj);
      try { (await byAssoc("DEAL", "contacts", some, ASKFOR.DEAL, CAP.obj, "IN"))
              .forEach(r => { if (!ourDeal.has(String(r.id))) foreign.push({ row: r, kind: "deal" }); }); } catch(e){ missed++; }
      try { (await byAssoc("COMPANY", "contacts", some, ASKFOR.COMPANY, CAP.obj, "IN"))
              .forEach(r => { if (String(r.id) !== cid) foreign.push({ row: r, kind: "company" }); }); } catch(e){ missed++; }
      if (foreign.length > CAP.foreign) capped.push("records reached outside");
      let reached = 0;
      for (const fo of foreign.slice(0, CAP.foreign)){
        try {
          const who = await byAssoc("CONTACT", fo.kind === "deal" ? "deals" : "companies", [fo.row.id], ["firstname"], CAP.obj, "EQUAL");
          const parents = who.filter(r => ourIds.indexOf(String(r.id)) >= 0);
          if (!parents.length) continue;
          if (fo.kind === "company"){
            // a company known of but not walked: drawn, searchable, and it says so
            const fn = take(dCompany(fo.row));
            parents.forEach(r => join(recKey("0-1", r.id), fn.key, "member"));
          } else {
            const dn = take(dDeal(fo.row, null, hubKey));
            parents.forEach(r => join(recKey("0-1", r.id), dn.key, "link"));
          }
          reached++;
        } catch(e){ missed++; }
      }
      R.end(sOut, reached ? reached + " REACHING ELSEWHERE" : "NONE — SELF-CONTAINED", reached > 0 ? "warn" : false);
    }

    // ---- records that look like they belong here but carry no link
    const seen = new Set(ourIds);
    const probes = [];
    [cp.phone].concat(rows.CONTACT.map(r => (r.properties || {}).phone), rows.CONTACT.map(r => (r.properties || {}).mobilephone))
      .forEach(v => { const t = phoneTail(v); if (t.length >= 9) uniqPush(probes, t); });
    const sweepN = Math.min(probes.length, CAP.probe);
    R.prog(80, "SWEEPING FOR DETACHED RECORDS");
    const sS = R.step("PHONE SWEEP &middot; " + sweepN + " " + plural(sweepN, "NUMBER") + " OFF THIS ACCOUNT");
    if (probes.length > CAP.probe) capped.push("phone probes");
    let detachedN = 0;
    for (const probe of probes.slice(0, CAP.probe)){
      try {
        const r = await hubspot({ objectType: "CONTACT", query: probe, properties: ASKFOR.CONTACT, limit: 10 });
        ((r && r.results) || []).forEach(x => {
          if (seen.has(String(x.id))) return;
          seen.add(String(x.id));
          join(hubKey, take(dContact(x, null, hubKey, true)).key, "detached");
          detachedN++;
        });
      } catch(e){ missed++; }
    }
    R.end(sS, detachedN + " UNATTACHED ON THESE NUMBERS", detachedN > 0 ? "warn" : false);
    if (missed) R.line("<b>" + missed + "</b> " + plural(missed, "READ") + " REFUSED &middot; THIS ACCOUNT IS INCOMPLETE &middot; RE-WALK IT TO FILL THE GAPS", "err");

    // ---- merge and save
    R.prog(90, "MERGING INTO THE MAP");
    reindex();
    const prev = MAP.accounts[cid];
    MAP.accounts[cid] = { id: cid, name: cp.name || "", domain: cp.domain || "", walkedAt: new Date().toISOString(),
                          firstWalkedAt: (prev && prev.firstWalkedAt) || new Date().toISOString(), capped, trimmed: null, missed };
    uniqPush(MAP.order, cid);
    const sM = R.step("MERGE &middot; " + Object.keys(touched).length + " RECORDS");
    const shared = Object.keys(touched).filter(k => { const n = MAP.byKey[k]; return n && n.kind !== "company" && n.companyIds.length > 1; });
    R.ok(sM, shared.length ? shared.length + " ALSO ON ANOTHER ACCOUNT" : "NO OVERLAP WITH THE MAP");

    const sW = R.step("WRITE ACCOUNT DOCUMENT");
    const doc = accountDoc(cid, Object.keys(touched), Object.keys(edgeIds),
                           { name: cp.name, domain: cp.domain, capped, missed, first: MAP.accounts[cid].firstWalkedAt });
    MAP.accounts[cid].trimmed = doc.trimmed || null;
    const saved = await saveAccount(doc);
    if (saved.ok) R.ok(sW, "KEPT" + (doc.trimmed ? " · TRIMMED" : ""));
    else { R.end(sW, String(saved.why).toUpperCase(), true); R.line("THE MAP COULD NOT BE SAVED &middot; THIS WALK IS ON SCREEN ONLY", "err"); }
    return { ok: true, name: cp.name || "", touched: Object.keys(touched).length, shared: shared.length, saved, missed };
  }

  // The console walk: walkCore, then draw it and travel to it.
  async function walkCompany(cid, via, force){
    logLine("TARGET ACQUIRED &middot; <b>" + esc(cid) + "</b>" + (via ? " &middot; " + esc(via).toUpperCase() : ""));
    const hubKey = companyKey(cid);
    try {
      const res = await walkCore(cid, CONSOLE_R);
      if (!res.ok){ fail(res.why); return; }
      // A re-walk rebuilds the map from the store, so records that have
      // since left the account leave the map too; merging alone never
      // removed anything.
      if (force && res.saved.ok){
        const sR = logStep("RELOAD MAP FROM STORE");
        const n = await rebuildFromStore();
        stepOk(sR, n + " " + plural(n, "ACCOUNT"));
      }
      prog(96, "DRAWING");
      await openMap();
      logLine("MAP &middot; <b>" + MAP.order.length + "</b> ACCOUNTS &middot; <b>" + fmt(MAP.nodes.length) +
              "</b> RECORDS" + (res.shared ? " &middot; <b>" + res.shared + "</b> SHARED" : ""), res.shared ? "err" : "");
      prog(100, "COMPLETE");
      VIEW.travelTo(hubKey, true);
    } catch(err){
      // a connector failure carries a code; a bug in this page carries a stack
      const pageBug = !!(err && err.stack && !err.code);
      stepEnd(CON.open, pageBug ? "PAGE ERROR" : "WALK FAILED", true);
      // what a half-finished walk merged was never saved; put the map back
      // to what the store holds rather than show it as if it were
      if (DB_STATE.up){ try { await rebuildFromStore(); VIEW.refresh(); } catch(e){} }
      if (pageBug){
        logLine("THIS PAGE THREW WHILE WALKING &middot; <b>" + esc(String(err.name || "Error") + ": " + String(err.message || err)) + "</b>", "err");
        fail("Every read succeeded — the fault is in this page, not in HubSpot. Nothing already on the map was lost.");
      } else {
        fail(err && err.code === "no_connector" ? "The HubSpot connector is not available in this view."
          : "HubSpot could not complete the walk. Some of this account may not have loaded.");
      }
    }
  }
