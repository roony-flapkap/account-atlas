  /* =====================================================================
     16. DELETING FROM THE MAP — for the Atlas's editors only (the Worker's
     EDITORS; /api/me says canEdit, and the Worker checks it on every call).
     Two kinds of write to HubSpot, and only these: a record archived (its
     recycle bin keeps it 90 days), and the association between two records
     removed. From the map:
       · a link: the control that rides it (section 13). It goes five
         seconds after the click unless Undo is pressed; nothing is asked.
       · a record, in the inspector: Delete record, and Delete with
         associated records, which list what would go, ticked or not, and
         delete only what is ticked; and Unassociate from all, which asks
         twice, as Forget does.
     Whatever HubSpot takes is drawn at once (struck through, faded), then
     the accounts it touched are walked again so it leaves the map, and an
     account that was deleted is taken off the canvas.
     ===================================================================== */
  const ED = { del: null, armAll: null, note: null, pend: new Map(), toastT: null, done: null };
  const UNDO_MS = 5000;
  const ED_KIND = { company: "Company", contact: "Contact", deal: "Deal", lead: "Lead" };
  const kindOfKey = k => ({ "0-2": "company", "0-1": "contact", "0-3": "deal", "0-136": "lead" })[String(k).split("/")[0]] || "contact";
  const labelOr = (label, key) => label || (ED_KIND[kindOfKey(key)] || "Record") + " " + String(key).split("/")[1];
  const paintEd = () => VIEW.repaintInspector();

  function editWhy(e){
    const c = e && e.code;
    if (c === "missing_scope") return "HubSpot refused: the Atlas's HubSpot app may not delete yet (a write scope is missing). Nothing was changed.";
    if (c === "not_editor") return "Only the Atlas's editors may delete in HubSpot.";
    if (c === "not_found") return "That record is no longer in HubSpot.";
    if (c === "rate_limited") return "HubSpot is busy. Try again in a moment.";
    if (c === "no_identity") return "You are signed out. Sign in again, then try it.";
    return "It did not go through" + (e && e.message ? ": " + e.message : "") + ".";
  }

  /* ---------------- the toast, at the foot of the map ---------------- */
  function toast(html, opts){
    const t = $("gtoast");
    if (!t) return;
    opts = opts || {};
    clearTimeout(ED.toastT);
    t.innerHTML = html;
    t.classList.toggle("bad", !!opts.bad);
    t.hidden = false;
    if (opts.ms) ED.toastT = setTimeout(() => { t.hidden = true; }, opts.ms);
  }
  function toastPending(){
    const jobs = [...ED.pend.values()];
    if (!jobs.length) return;
    const what = jobs.length === 1
      ? "<b>" + esc(jobs[0].names[0]) + "</b> and <b>" + esc(jobs[0].names[1]) + "</b>"
      : "<b>" + jobs.length + " links</b>";
    toast('<span>Unlinking ' + what + " in HubSpot in a moment</span>" +
          '<button type="button" class="act" data-ed="undo">Undo' + (jobs.length > 1 ? " all" : "") + "</button>");
  }

  // What HubSpot took, said at once; the map catching up says so when it has
  // (settleEdits). Said BEFORE landed(), which can finish there and then.
  function doneToast(html, bad){
    ED.done = { html, bad: !!bad };
    if (ED.pend.size){ toastPending(); return; }
    toast("<span>" + html + " Updating the map…</span>", { bad });
  }

  /* ---------------- a link: the control on it ---------------- */
  function queueUnlink(ed){
    if (!CAN_EDIT || !ed || ed.pend || ed.gone || ed.rel === "detached") return;
    const A = MAP.byKey[ed.a], B = MAP.byKey[ed.b];
    if (!A || !B) return;
    ed.pend = true;
    VIEW.repaintEdges();
    // the accounts it touches, read now: the map may be rebuilt before it goes
    const job = { a: ed.a, b: ed.b, names: [A.e.label, B.e.label], accounts: accountsTouching([ed.a, ed.b]), cv: CV.cur };
    job.t = setTimeout(() => sendUnlink(job), UNDO_MS);
    ED.pend.set(ed.id, job);
    toastPending();
  }
  function undoUnlinks(){
    ED.pend.forEach((job, id) => { clearTimeout(job.t); const ed = MAP.edgeSet[id]; if (ed) ed.pend = false; });
    ED.pend.clear();
    VIEW.repaintEdges();
    toast("<span>Kept. Nothing was changed in HubSpot.</span>", { ms: 3500 });
  }
  async function sendUnlink(job){
    const id = edgeId(job.a, job.b);
    ED.pend.delete(id);
    const settleEdge = () => { const ed = MAP.edgeSet[id]; if (ed) ed.pend = false; };
    try {
      const r = await api("/api/edit/unlink", { pairs: [[job.a, job.b]] });
      settleEdge();
      doneToast("Unlinked <b>" + esc(job.names[0]) + "</b> and <b>" + esc(job.names[1]) + "</b> in HubSpot.");
      landed(r.changes || [], job.accounts, [], job.cv);
    } catch(e){
      settleEdge(); VIEW.repaintEdges();
      toast("<span>" + esc(editWhy(e)) + "</span>", { bad: true, ms: 9000 });
    }
  }

  /* ---------------- a record: the inspector's section ---------------- */
  const selfItem = n => ({ key: n.key, kind: n.kind === "detached" ? "contact" : n.kind, label: n.e.label, why: "this record", on: true, self: true });

  function editHtml(n){
    if (!CAN_EDIT || !n) return "";
    // a checklist belongs to the record it was opened for
    if (ED.del && ED.del.key !== n.key && ED.del.state !== "sending") ED.del = null;
    if (ED.armAll && ED.armAll !== n.key) ED.armAll = null;
    const note = ED.note && ED.note.key === n.key ? '<p class="iednote' + (ED.note.bad ? " bad" : "") + '">' + esc(ED.note.text) + "</p>" : "";
    if (ED.del && ED.del.key === n.key) return deletePanel(ED.del);
    if (n.gone) return note ? '<div class="ied">' + note + "</div>" : "";
    const armed = ED.armAll === n.key;
    return '<div class="ied"><div class="iedk">HubSpot · delete</div><div class="iacts">' +
      '<button type="button" class="act warn" data-ed="del-self">Delete record</button>' +
      '<button type="button" class="act warn" data-ed="del-all">Delete with associated records</button>' +
      '<button type="button" class="act warn' + (armed ? " arm" : "") + '" data-ed="unlink-all">' +
        (armed ? "Press again to unassociate" : "Unassociate from all") + "</button>" +
      "</div>" + note + "</div>";
  }

  function deletePanel(d){
    const head = '<div class="iedk">' + (d.mode === "all" ? "Delete it and its associated records" : "Delete this record") + " · in HubSpot</div>";
    const cancel = '<button type="button" class="act" data-ed="del-cancel"' + (d.state === "sending" ? " disabled" : "") + ">Cancel</button>";
    if (d.state === "loading")
      return '<div class="ied on">' + head + '<p class="iednote">Reading what is linked to it in HubSpot…</p><div class="iacts">' + cancel + "</div></div>";
    if (d.state === "error")
      return '<div class="ied on">' + head + '<p class="iednote bad">' + esc(d.msg) + '</p><div class="iacts">' + cancel + "</div></div>";
    const on = d.items.filter(x => x.on).length, sending = d.state === "sending";
    const rows = d.items.map(x =>
      '<label class="edrow' + (x.on ? "" : " off") + (x.self ? " self" : "") + '"><input type="checkbox" data-edk="' + esc(x.key) + '"' +
        (x.on ? " checked" : "") + (sending ? " disabled" : "") + ">" +
        '<span class="edkind" style="--node:' + kindColour(x.kind) + '">' + esc(ED_KIND[x.kind] || "Record") + "</span>" +
        '<span class="edname">' + esc(labelOr(x.label, x.key)) + "</span>" +
        (x.why ? '<span class="edwhy">' + esc(x.why) + "</span>" : "") + "</label>").join("");
    const more = Object.keys(d.more || {}).map(k => fmt(d.more[k]) + " more " + plural(d.more[k], k)).join(" · ");
    return '<div class="ied on">' + head +
      (d.items.length > 3 ? '<div class="edall">Tick <button type="button" data-ed="tick-all"' + (sending ? " disabled" : "") + ">all</button> · " +
                            '<button type="button" data-ed="tick-none"' + (sending ? " disabled" : "") + ">none</button></div>" : "") +
      '<div class="edlist">' + rows + "</div>" +
      (more ? '<p class="iednote">And ' + esc(more) + ", not listed, so not deleted.</p>" : "") +
      (d.mode === "all" ? '<p class="iednote">Unticked: companies, and records on two or more companies. Tick them if you mean them.</p>' : "") +
      '<p class="iednote">Their links go with them. HubSpot keeps deleted records in its recycle bin for 90 days.</p>' +
      (d.err ? '<p class="iednote bad">' + esc(d.err) + "</p>" : "") +
      '<div class="iacts"><button type="button" class="act danger" data-ed="del-go"' + (on && !sending ? "" : " disabled") + ">" +
        (sending ? "Deleting…" : "Delete " + on + " " + plural(on, "record")) + "</button>" + cancel + "</div></div>";
  }

  function editTick(key, on){
    const d = ED.del;
    if (!d || d.state !== "ready") return;
    const x = d.items.find(i => i.key === key);
    if (x) x.on = !!on;
    paintEd();
  }

  function editAct(act, btn, n){
    if (act === "undo"){ undoUnlinks(); return; }
    if (!CAN_EDIT || !n) return;
    if (act === "del-self"){
      ED.armAll = null; ED.note = null;
      ED.del = { key: n.key, mode: "self", state: "ready", items: [selfItem(n)], more: {} };
      paintEd(); return;
    }
    if (act === "del-all"){
      ED.armAll = null; ED.note = null;
      ED.del = { key: n.key, mode: "all", state: "loading", items: [], more: {} };
      paintEd(); planFor(n, ED.del); return;
    }
    if (act === "del-cancel"){ ED.del = null; paintEd(); return; }
    if (act === "tick-all" || act === "tick-none"){
      if (ED.del && ED.del.state === "ready"){ ED.del.items.forEach(x => { x.on = act === "tick-all"; }); paintEd(); }
      return;
    }
    if (act === "del-go"){ sendDelete(n, ED.del); return; }
    if (act === "unlink-all"){
      // it removes every link the record has, so it asks twice
      if (ED.armAll !== n.key){
        ED.armAll = n.key; ED.note = null; paintEd();
        setTimeout(() => { if (ED.armAll === n.key){ ED.armAll = null; paintEd(); } }, 4000);
        return;
      }
      ED.armAll = null;
      sendUnlinkAll(n);
    }
  }

  async function planFor(n, d){
    try {
      const r = await api("/api/edit/plan", { key: n.key });
      if (ED.del !== d) return;                     // cancelled, or another record held meanwhile
      d.items = [selfItem(n)].concat((r.items || []).map(x => ({ key: x.key, kind: x.kind, label: x.label, why: x.why, on: !!x.tick })));
      d.more = r.more || {};
      d.state = "ready";
    } catch(e){
      if (ED.del !== d) return;
      d.state = "error"; d.msg = editWhy(e);
    }
    paintEd();
  }

  async function sendDelete(n, d){
    if (!d || d.state !== "ready") return;
    const keys = d.items.filter(x => x.on).map(x => x.key);
    if (!keys.length) return;
    d.state = "sending"; d.err = null; paintEd();
    // read before anything changes: the accounts it touches, the walked companies among it
    const accounts = accountsTouching(keys), cv = CV.cur;
    try {
      const r = await api("/api/edit/delete", { keys });
      if (ED.del === d) ED.del = null;
      const drop = (r.deleted || []).filter(k => k.indexOf("0-2/") === 0).map(k => k.split("/")[1]).filter(id => MAP.accounts[id]);
      const left = (r.failed || []).reduce((s, f) => s + (Number(f.count) || 0), 0);
      if (left) ED.note = { key: n.key, bad: true, text: left + " " + plural(left, "record") + " could not be deleted: " + editWhy(r.failed[0]) };
      const k = (r.deleted || []).length;
      doneToast("Deleted <b>" + k + " " + plural(k, "record") + "</b> in HubSpot" + (left ? ", " + left + " not" : "") + ".", !!left);
      landed(r.changes || [], accounts, drop, cv);
    } catch(e){
      d.state = "ready"; d.err = editWhy(e);
    }
    paintEd();
  }

  async function sendUnlinkAll(n){
    ED.note = { key: n.key, text: "Unassociating it in HubSpot…" }; paintEd();
    const accounts = accountsTouching([n.key].concat(n.adj)), cv = CV.cur, name = n.e.label;
    try {
      const r = await api("/api/edit/unlink-all", { key: n.key });
      const k = (r.unlinked || []).length;
      ED.note = k ? null : { key: n.key, text: "It has no links in HubSpot." };
      if ((r.failed || []).length) ED.note = { key: n.key, bad: true, text: "Some links could not be removed: " + editWhy(r.failed[0]) };
      if (k){
        doneToast("Unassociated <b>" + esc(name) + "</b> from " + k + " " + plural(k, "record") + " in HubSpot.");
        landed(r.changes || [], accounts, [], cv);
      }
    } catch(e){ ED.note = { key: n.key, bad: true, text: editWhy(e) }; }
    paintEd();
  }

  /* ---------------- after HubSpot has taken it ----------------
     Drawn at once from what the Worker says changed: the same marks a
     change from HubSpot gets (07b-live.js). Then the accounts it touched
     are walked again, live, and the map rebuilt from the store, so what
     went leaves the map for every viewer of the canvas; a deleted account
     is taken off it. That waits for any walk or run holding the lock, and
     is dropped if the reader has moved to another canvas meanwhile. */
  const SETTLE = { ids: new Set(), drop: new Set(), cv: null, running: false };
  function landed(changes, accounts, drop, cv){
    let drew = false;
    changes.forEach(c => { if (applyChange(c)) drew = true; });
    if (drew){ reindex(); VIEW.refresh(); }
    if (SETTLE.cv && !sameCanvas(SETTLE.cv, cv)){ SETTLE.ids.clear(); SETTLE.drop.clear(); }
    SETTLE.cv = cv;
    accounts.forEach(id => SETTLE.ids.add(String(id)));
    drop.forEach(id => { SETTLE.drop.add(String(id)); SETTLE.ids.delete(String(id)); });
    if (!SETTLE.running) settleEdits();
  }
  async function settleEdits(){
    SETTLE.running = true;
    try {
      while (SETTLE.ids.size || SETTLE.drop.size){
        if (ACQUIRING){ await sleep(800); continue; }
        if (!sameCanvas(SETTLE.cv, CV.cur)){ SETTLE.ids.clear(); SETTLE.drop.clear(); break; }
        const drop = [...SETTLE.drop], ids = [...SETTLE.ids].filter(id => drop.indexOf(id) < 0);
        SETTLE.drop.clear(); SETTLE.ids.clear();
        ACQUIRING = true;
        try {
          for (const cid of drop) if (MAP.accounts[cid]){ await forgetAccount(cid); CH.pending.delete(cid); }
          await rewalkAccounts(ids, () => {}, { drop: drop.length > 0 });
        } catch(e){} finally { ACQUIRING = false; saveChLocal(); paintChChip(); }
      }
    } finally {
      SETTLE.running = false;
      const d = ED.done;
      ED.done = null;
      if (d && !ED.pend.size) toast("<span>" + d.html + " The map is up to date.</span>", { bad: d.bad, ms: 6000 });
    }
  }
