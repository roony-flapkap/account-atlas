import re
import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
src=open("src/template.html").read()
js=open("build/atlas.js").read()
s=src
def rep(a,b,n=1):
    global s
    c=s.count(a); assert c==n,(c,a[:70]); s=s.replace(a,b)

# 1. no skeleton of its own — the publish wraps the page in one
first=s.split("\n",1)[0]
assert first.startswith("<!doctype html>") and first.endswith("<body>")
s=s.split("\n",1)[1]
assert s.rstrip().endswith("</body></html>")
s=s.rstrip()[:-len("</body></html>")].rstrip()+"\n"

# 2. CSS
rep("svg.graph{display:block;width:100%;max-width:100%;height:auto;cursor:grab;touch-action:pan-y}",
    "svg.graph{display:block;width:100%;height:clamp(420px,72vh,940px);cursor:grab;touch-action:pan-y}")
rep("  /* pan-y, not none: a vertical touch drag over the plot must still scroll */",
    "  /* A fixed-height frame: the plot fits itself to the frame, never the\n     frame to the plot — a square map used to render taller than the screen.\n     pan-y, not none: a vertical touch drag over the plot still scrolls. */")
rep("  .gnode{cursor:move}", "  /* a record can be dragged by touch as well; the background still scrolls */\n  .gnode{cursor:move;touch-action:none}")
rep("  /* a company carries an account's name, so it is set a weight above */\n  .gnode.gco .glabel{font-size:6.75px;font-weight:600;fill:var(--ink)}", "  /* an account's name is set a weight above the records around it */\n  .gnode.ghub .glabel{font-size:9.5px;font-weight:600;fill:var(--ink)}")
rep("  .glabel{font-family:var(--mono);font-size:6px;fill:var(--ink-2);letter-spacing:.08em;text-transform:uppercase}",
    "  .glabel{font-family:var(--mono);font-size:8.5px;fill:var(--ink-2);letter-spacing:.08em;text-transform:uppercase}")
rep("  .gsubl{font-family:var(--mono);font-size:5px;fill:var(--dim-2);letter-spacing:.06em}",
    "  .gsubl{font-family:var(--mono);font-size:7px;fill:var(--dim-2);letter-spacing:.06em}\n"
    "  /* Zoomed far out a record's name is a few pixels of noise, so record\n"
    "     labels are withdrawn; account names hold their size on screen. */\n"
    "  svg.graph.glod .gnode:not(.ghub) .glabel,svg.graph.glod .gnode .gsubl{display:none}")
rep("""  .ghivelab{font-family:var(--mono);font-size:7px;fill:var(--dim-2);letter-spacing:.24em;
    text-transform:uppercase;text-anchor:middle;pointer-events:none}
""", "")
rep("""  /* the arrival flash when the view travels to a company already on the map */
""", "")
rep("""    fill:var(--node,var(--accent));font-family:var(--mono);font-size:5.2px;""",
    """    fill:var(--node,var(--accent));font-family:var(--mono);font-size:7px;""")
rep("""  .searchbox button:hover{background:var(--red);color:var(--void)}
""", """  .searchbox button:hover{background:var(--red);color:var(--void)}
  .searchbox.qbad{border-color:var(--amber);box-shadow:0 0 22px rgba(224,167,60,.3)}
  .qwrap{display:flex;flex-direction:column;align-items:stretch;gap:6px}
  .qerr{font-size:10px;letter-spacing:.06em;color:var(--amber);margin:0;max-width:62ch}
  .qerr:empty{display:none}
""")
rep("@media (max-width:560px){ .searchbox{width:100%} .searchbox input{min-width:0} }",
    "@media (max-width:560px){ .qwrap,.searchbox{width:100%} .searchbox input{min-width:0} }")
rep("""  .gstage{position:relative;padding:8px}
""", """  .gstage{position:relative;padding:8px}
  .gempty{position:absolute;inset:0;display:grid;place-items:center;margin:0;pointer-events:none;
    font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim-2)}
""")

rep("""  .acts{display:flex;gap:6px;flex-wrap:wrap}
""", "")
rep("""  .act.done{border-color:var(--green);color:var(--green)}
  .act.bad{border-color:var(--amber);color:var(--amber)}
""", "")

rep("""  .cline.err,.cline.err .st,.cline.err .nt{color:var(--amber)}""",
    """  .cline.err,.cline.err .st,.cline.err .nt,.cline.warn .st,.cline.warn .nt{color:var(--amber)}""")
rep("""  svg.graph.gdrag .gscene,svg.graph.gmoving .gscene,svg.graph.gfly .gscene{transition:none}""",
    """  svg.graph.gdrag .gscene,svg.graph.gmoving .gscene,svg.graph.gfly .gscene{transition:none}
  svg.graph.gexport *{transition:none!important;animation:none!important}""")

# 3. markup: an error line under the search bar
rep("""    <div class="searchbox">
      <input id="q2" type="search" placeholder="ENTER DESIGNATION" autocomplete="off" spellcheck="false" aria-label="Record id, email address or admin-app user id">
      <button type="button" id="go2">Acquire</button>
    </div>""", """    <div class="qwrap">
      <div class="searchbox">
        <input id="q2" type="search" placeholder="ENTER DESIGNATION" autocomplete="off" spellcheck="false" aria-label="Record id, email address or admin-app user id">
        <button type="button" id="go2">Acquire</button>
      </div>
      <p class="qerr" id="qerr" role="status" aria-live="polite"></p>
    </div>""")

# 3b. canvases: the store chip opens them, the gate names the open one,
#     and one panel lists, makes, renames, copies and deletes them
rep("""        <span class="chip" id="chipDb"><i></i><span id="chipDbTxt">Map · checking…</span></span>""",
    """        <button type="button" class="chip cvchip" id="chipDb" title="Canvases — open, make, rename, copy or delete one"><i></i><span id="chipDbTxt">Map · checking…</span><span class="cvcaret" aria-hidden="true">▾</span></button>""")
rep("""      <span class="gsub">FlapKap · HubSpot · Read-only</span>
      <div class="gmodes\"""",
    """      <span class="gsub">FlapKap · HubSpot · Read-only</span>
      <button type="button" class="gcv" id="gcv" title="Canvases — open, make, rename, copy or delete one">Canvas · <span id="gcvname">Main map</span> ▾</button>
      <div class="gmodes\"""")
rep("""<!-- One tooltip for the whole page.""", """<!-- The canvases. One panel over everything, the deck included. -->
<div id="cvpanel" class="cvp" hidden>
  <div class="cvbox frame" role="dialog" aria-modal="true" aria-labelledby="cvtitle">
    <div class="cvhead">
      <h2 id="cvtitle">Canvases</h2>
      <button type="button" class="act" data-cv="close">Close</button>
    </div>
    <p class="cvlede">Each canvas is its own map — its own accounts, the records opened out on it, and how it is arranged — and every change is saved as you make it. Shared canvases are seen and changed by everyone the page is shared with; a private one only by you.</p>
    <div id="cvlist"></div>
    <div class="cvform">
      <label class="cvformlab" id="cvformlab" for="cvname">New canvas</label>
      <div class="cvfrow">
        <input id="cvname" type="text" maxlength="60" autocomplete="off" spellcheck="false" placeholder="NAME THE CANVAS">
        <div class="cvscope" role="radiogroup" aria-label="Who can see it">
          <button type="button" class="gm" role="radio" data-scope="shared" aria-checked="true">Shared</button>
          <button type="button" class="gm" role="radio" data-scope="private" aria-checked="false">Private</button>
        </div>
        <button type="button" class="act go" id="cvgo">Create</button>
        <button type="button" class="act" id="cvcancel" data-cv="cancel" hidden>Cancel</button>
      </div>
      <p class="cvnote" id="cvnote" role="status" aria-live="polite"></p>
    </div>
  </div>
</div>

<!-- One tooltip for the whole page.""")
rep("""The map itself is stored against this artifact and is readable by everyone it is shared with.</p>""",
    """The maps themselves are stored against this artifact.</p>
    <p><b>Canvases.</b> Every canvas is a separate map with its own accounts, its own opened-out records and its own arrangement — layout, dragged records and hives, filters and where the view was — all saved as they change. A <b>shared</b> canvas is read and changed by everyone the page is shared with; a <b>private</b> one lives under your own identity and nobody else can open it, the page's owner included. The map from before canvases is the shared <b>Main map</b>. Press the canvas chip under the title to switch, make, rename, copy or delete one.</p>""")
rep("""  .chip.warnc{border-color:var(--amber-line);color:var(--amber)} .chip.warnc i{background:var(--amber)}
""", """  .chip.warnc{border-color:var(--amber-line);color:var(--amber)} .chip.warnc i{background:var(--amber)}
  /* the store chip is the door to the canvases */
  .chip.cvchip{font-family:var(--mono);cursor:pointer;transition:border-color 140ms var(--ease),background 140ms var(--ease)}
  .chip.cvchip:hover{background:var(--panel-2);border-color:var(--red)}
  .cvcaret{font-size:9px;margin-left:-2px;opacity:.8}
""")
rep("""  .gmodes{display:flex;justify-content:center;gap:6px;margin:0 0 16px}""",
    """  .gmodes{display:flex;justify-content:center;gap:6px;margin:0 0 16px}
  .gcv{font-family:var(--mono);font-size:9px;letter-spacing:.2em;text-transform:uppercase;background:transparent;
    color:var(--dim);border:1px dashed var(--rule);padding:5px 12px;margin:-8px auto 16px;cursor:pointer;
    max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:all 130ms var(--ease)}
  .gcv span{color:var(--ink-2)}
  .gcv:hover{border-color:var(--red);color:var(--red)} .gcv:hover span{color:var(--red)}

  /* ---------- canvases panel ---------- */
  .cvp{position:fixed;inset:0;z-index:90;display:flex;justify-content:center;align-items:flex-start;overflow:auto;
    padding:clamp(16px,9vh,90px) 16px 16px;background:rgba(7,7,10,.78);backdrop-filter:blur(3px)}
  .cvp[hidden]{display:none}
  html.cvon{overflow:hidden}
  .cvbox{width:min(760px,100%);padding:16px 18px 18px;box-shadow:0 0 60px var(--accent-glow)}
  .cvhead{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid var(--rule);padding-bottom:9px}
  .cvhead h2{font-size:11px;font-weight:600;margin:0;letter-spacing:.26em;text-transform:uppercase;color:var(--red)}
  .cvhead h2::before{content:"// "}
  .cvlede{font-size:10.5px;color:var(--dim);letter-spacing:.04em;margin:10px 0 2px;max-width:80ch}
  .cvsec{font-size:9px;letter-spacing:.24em;text-transform:uppercase;color:var(--dim-2);margin:16px 0 6px}
  .cvrow{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"name tag" "meta acts";align-items:center;
    gap:5px 12px;padding:9px 11px;border:1px solid var(--rule);background:var(--panel);margin-top:-1px;position:relative}
  .cvrow.cur{border-color:var(--red-dim);background:var(--accent-film);z-index:1}
  .cvname{grid-area:name;min-width:0;display:flex;gap:6px;align-items:center}
  .cvopen{font-family:var(--mono);font-size:12px;letter-spacing:.06em;color:var(--ink);background:none;border:0;padding:0;
    cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
  .cvopen:hover,.cvrow.cur .cvopen{color:var(--red)}
  .cvtag{grid-area:tag;justify-self:end;font-size:8.5px;letter-spacing:.2em;text-transform:uppercase;padding:2px 7px;
    border:1px solid var(--rule);color:var(--dim)}
  .cvtag.private{border-color:var(--amber-line);color:var(--amber)}
  .cvmeta{grid-area:meta;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim-2);min-width:0}
  .cvacts{grid-area:acts;display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
  .cvacts .act,.cvname .act{padding:4px 9px;font-size:8.5px}
  .cvedit{flex:1 1 auto;min-width:0;font-family:var(--mono);font-size:12px;letter-spacing:.04em;background:var(--void);
    color:var(--ink);border:1px solid var(--red-dim);padding:4px 7px;outline:none}
  .cvedit:focus,#cvname:focus{box-shadow:0 0 18px var(--red-glow)}
  .cvnone{font-size:10px;color:var(--dim-2);letter-spacing:.06em;margin:0;padding:9px 11px;border:1px dashed var(--rule)}
  .cvform{margin-top:18px;border-top:1px solid var(--rule);padding-top:13px}
  .cvformlab{font-size:9.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--red);display:block;margin-bottom:8px}
  .cvfrow{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}
  #cvname{flex:1 1 220px;min-width:0;font-family:var(--mono);font-size:12px;letter-spacing:.06em;background:var(--void);
    color:var(--ink);border:1px solid var(--red-dim);padding:7px 10px;outline:none}
  #cvname::placeholder{color:var(--dim-2)}
  .cvscope{display:flex;gap:6px}
  .cvscope .gm{padding:5px 12px}
  .gm:disabled{opacity:.4;cursor:not-allowed}
  .cvnote{font-size:10px;letter-spacing:.06em;color:var(--amber);margin:10px 0 0;min-height:1.4em}
  @media (max-width:560px){
    .cvrow{grid-template-areas:"name tag" "meta meta" "acts acts"}
    .cvacts{justify-content:flex-start}
    .cvbox{padding:14px 12px 14px}
  }""")

# 3c. segments: a chip under the title, a button on the gate, one panel
rep("""        <span class="chip" id="chipHs"><i></i><span id="chipHsTxt">HubSpot · unverified</span></span>""",
    """        <span class="chip" id="chipHs"><i></i><span id="chipHsTxt">HubSpot · unverified</span></span>
        <button type="button" class="chip cvchip sgchip" id="chipSeg" title="Search HubSpot segments and bring one onto this canvas"><i></i><span id="chipSegTxt">Segments</span><span class="cvcaret" aria-hidden="true">▾</span></button>""")
rep("""      <button type="button" class="gcv" id="gcv" title="Canvases — open, make, rename, copy or delete one">Canvas · <span id="gcvname">Main map</span> ▾</button>""",
    """      <div class="gcvrow">
        <button type="button" class="gcv" id="gcv" title="Canvases — open, make, rename, copy or delete one">Canvas · <span id="gcvname">Main map</span> ▾</button>
        <button type="button" class="gcv" id="gseg" title="Search HubSpot segments and bring one onto this canvas">Segments · <span id="gsegtxt">import one</span> ▾</button>
      </div>""")
rep("""<!-- One tooltip for the whole page.""", """<!-- Segments: search HubSpot's, bring one onto the canvas, find its mesh, walk it. -->
<div id="segpanel" class="cvp segp" hidden>
  <div class="cvbox frame sgbox" role="dialog" aria-modal="true" aria-labelledby="sgtitle">
    <div class="cvhead">
      <h2 id="sgtitle">Segments</h2>
      <button type="button" class="act" data-sg="close">Close</button>
    </div>
    <div id="sglist">
      <p class="cvlede" id="sglede"></p>
      <div id="sgmine"></div>
      <div class="sgsearch">
        <input id="sgq" type="search" maxlength="200" autocomplete="off" spellcheck="false" placeholder="SEARCH HUBSPOT SEGMENTS BY NAME" aria-label="Search HubSpot segments by name">
        <div class="cvscope" role="radiogroup" aria-label="Segment type">
          <button type="button" class="gm" role="radio" data-sgt="all" aria-checked="true">All</button>
          <button type="button" class="gm" role="radio" data-sgt="0-2" aria-checked="false">Companies</button>
          <button type="button" class="gm" role="radio" data-sgt="0-1" aria-checked="false">Contacts</button>
          <button type="button" class="gm" role="radio" data-sgt="0-3" aria-checked="false">Deals</button>
        </div>
      </div>
      <div id="sgres"></div>
    </div>
    <div id="sgdetail" hidden></div>
    <p class="cvnote" id="sgnote" role="status" aria-live="polite"></p>
  </div>
</div>

<!-- One tooltip for the whole page.""")
rep("""The map from before canvases is the shared <b>Main map</b>. Press the canvas chip under the title to switch, make, rename, copy or delete one.</p>""",
    """The map from before canvases is the shared <b>Main map</b>. Press the canvas chip under the title to switch, make, rename, copy or delete one.</p>
    <p><b>Segments.</b> Search HubSpot's segments by name and bring one onto the canvas. <b>Drop in</b> reads its members (one read per 200) and lays its companies out in a field under the map, not walked; a contact or deal segment is traced to the companies its members are on (one read per 100). At most the 2,000 most recently created members are read. <b>Find the mesh</b> asks HubSpot which contacts on those companies are on more than one company (one read per 100 companies), then reads each one's companies (one read a person) and draws the links — linked companies leave the field. <b>Walk</b> walks the next 100 members in full, linked ones first, about 12 reads each. Every run is paced under three reads a second, can be stopped, and saves as it goes; a segment that is <b>live</b> in HubSpot can be read again to see who joined and who left.</p>""")
rep("""  .gcv:hover{border-color:var(--red);color:var(--red)} .gcv:hover span{color:var(--red)}""",
    """  .gcv:hover{border-color:var(--red);color:var(--red)} .gcv:hover span{color:var(--red)}
  .gcvrow{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;margin:-8px 0 16px}
  .gcvrow .gcv{margin:0}""")
rep("""  .cvnote{font-size:10px;letter-spacing:.06em;color:var(--amber);margin:10px 0 0;min-height:1.4em}""",
    """  .cvnote{font-size:10px;letter-spacing:.06em;color:var(--amber);margin:10px 0 0;min-height:1.4em}
  .cvnone.bad{color:var(--amber);border-color:var(--amber-line)}

  /* ---------- segments ---------- */
  .chip.sgchip.live{border-color:var(--amber-line);color:var(--amber)} .chip.sgchip.live i{background:var(--amber);animation:blink 1.1s steps(2) infinite}
  .sgbox{width:min(860px,100%)}
  .sgsearch{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;margin:16px 0 4px}
  #sgq{flex:1 1 260px;min-width:0;font-family:var(--mono);font-size:12px;letter-spacing:.06em;background:var(--void);color:var(--ink);
    border:1px solid var(--red-dim);padding:7px 10px;outline:none}
  #sgq:focus{box-shadow:0 0 18px var(--red-glow)}
  #sgq::placeholder{color:var(--dim-2)}
  #sgres{max-height:min(46vh,460px);overflow:auto}
  .sgon{color:var(--accent);margin-left:6px}
  .sgback{margin:12px 0 4px}
  .sghead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 2px}
  .sghead h3{font-size:14px;font-weight:600;letter-spacing:.06em;color:var(--ink);margin:0}
  .sgmeta{font-size:10px;letter-spacing:.08em;color:var(--dim);margin:4px 0 0}
  .sgmeta a{color:var(--accent)}
  .sgstats{display:flex;flex-wrap:wrap;gap:6px 16px;margin:12px 0 0;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
  .sgstats b{color:var(--accent);font-weight:500}
  .sgsteps{margin-top:14px;border-top:1px solid var(--rule)}
  .sgstep{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:6px 12px;align-items:center;padding:11px 0;border-bottom:1px solid var(--rule)}
  .sgn{font-size:11px;color:var(--red);border:1px solid var(--red-dim);width:22px;height:22px;display:grid;place-items:center}
  .sgsd b{display:block;font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink);font-weight:600;margin-bottom:3px}
  .sgsd span{font-size:10.5px;color:var(--dim);letter-spacing:.03em}
  .sgstep .act{white-space:nowrap}
  .sgstep .act + .act{margin-left:6px}
  .sgcost{opacity:.7;letter-spacing:.08em}
  .sgjob{margin-top:14px;border:1px solid var(--rule);background:var(--void);padding:10px 12px}
  .sgjob.live{border-color:var(--amber-line)}
  .sgjt{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--amber)}
  .sgstop{font-size:9.5px;color:var(--dim)}
  .sgbar{height:3px;background:var(--rule);margin:8px 0}
  .sgbar span{display:block;height:100%;background:var(--amber);transition:width 200ms linear}
  .sglog{max-height:180px;overflow:auto;font-size:10px;letter-spacing:.04em;color:var(--ink-2)}
  .sgl{padding:2px 0} .sgl .t{color:var(--dim-2);margin-right:8px}
  .sgl b{color:var(--ink);font-weight:500}
  .sgl.ok{color:var(--green)} .sgl.err{color:var(--amber)} .sgl.warn{color:var(--amber)}
  .sgfoot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;font-size:10px;color:var(--dim)}
  @media (max-width:560px){
    .sgstep{grid-template-columns:24px minmax(0,1fr)}
    .sgstep .act{grid-column:2;justify-self:start;white-space:normal}
  }
  /* a segment's field on the map */
  .gfbox{fill:none;stroke:var(--c-stub);stroke-opacity:.5;stroke-dasharray:5 5;stroke-width:1.2}
  .gflab{font-family:var(--mono);font-size:12px;fill:var(--dim);letter-spacing:.18em;text-transform:uppercase;pointer-events:none}
  .gwrap[data-hide~="stub"] #gfields{display:none}
  .ibad{color:var(--amber)}""")

# 3d. sharing a private canvas, in the footer
rep("""Press the canvas chip under the title to switch, make, rename, copy or delete one.</p>
    <p><b>Segments.</b>""", """Press the canvas chip under the title to switch, make, rename, copy or delete one. A private canvas can be <b>shared with everyone</b> in one press: it moves to the shared list, whole, and the private original is removed.</p>
    <p><b>Segments.</b>""")

# 3e. the footer, as the site works now: through the Worker, with its SQL copy
FOOTER = """<footer>
    <p><b>What it does.</b> Walks one company's association graph — its contacts, deals and leads, how those link to each other, what any of them reach outside the account, and who shares its numbers without a link — then merges the result into a map that is kept between sessions. Walking a second company that shares a contact draws the two as one figure joined by that person.</p>
    <p><b>Reads only.</b> HubSpot is read through the Atlas API with one read-only app for the whole team, so everyone signed in sees what that app can see; nothing is ever written back. Only verified @flapkap.com Google accounts get in. The API keeps a SQL copy of the CRM, kept current by HubSpot's own notices within seconds, a re-read every 15 minutes and a full re-check every night.</p>
    <p><b>Changes.</b> Anything that changes in HubSpot — a record created, edited, deleted or merged, a link added or removed — arrives on this page as it happens. What touches this canvas is drawn at once: a deleted record struck through, a removed link faded, a new one glowing. <b>Refresh affected accounts</b>, under Changes, re-walks just the accounts it touched, which writes it into the canvas for good.</p>
    <p><b>Canvases.</b> Every canvas is a separate map with its own accounts, its own opened-out records and its own arrangement — layout, dragged records and hives, filters and where the view was — all saved as they change. A <b>shared</b> canvas is read and changed by everyone signed in; a <b>private</b> one only by you. A private canvas can be <b>shared with everyone</b> in one press: it moves to the shared list, whole, and the private original is removed.</p>
    <p><b>Segments.</b> Search HubSpot's segments by name and bring one onto the canvas. <b>Drop in</b> reads its members and lays their companies out in a field under the map, not walked; a contact or deal segment is traced to the companies its members are on. At most 2,000 members are read. <b>Find the mesh</b> finds the people on more than one of those companies, and which, in a few bulk reads, and draws the links. <b>Walk</b> walks the next 100 members in full, linked ones first.</p>
    <p><b>SQL console.</b> Ask the copy directly: read-only, one SELECT at a time, at most 1,000 rows, logged. Canvases are not in it. <b>Times are UTC</b>, as HubSpot's API returns them — not the UTC+4 that CSV exports render.</p>
    <svg class="fkmark" role="img" aria-label="FlapKap"><use href="#fkmark"/></svg>
  </footer>"""
assert s.count("<footer>") == 1 and s.count("</footer>") == 1
s = re.sub(r"<footer>.*?</footer>", lambda m: FOOTER, s, flags=re.S)

# 4. the script, into the one placeholder the template keeps for it
rep("/*@@ATLAS@@*/", "@@ATLAS@@")
s=s.replace("@@ATLAS@@", js)
# build/, not dist/: dist/atlas.html is the old artifact (version 7), kept
# locally as it was published and never rebuilt
os.makedirs("build", exist_ok=True)
open("build/atlas.html","w").write(s)

# 5. the site for GitHub Pages: a whole document of its own, with its config
#    beside it. Kept out of search engines, and it sends no referrer.
k=s.index("</style>\n")+len("</style>\n")
head, body = s[:k], s[k:]
web=('<!doctype html>\n<html lang="en"><head>\n<meta charset="utf-8">\n'
     '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
     '<meta name="robots" content="noindex,nofollow">\n<meta name="referrer" content="no-referrer">\n'
     + head + '<script src="config.js"></script>\n</head><body>\n' + body + "</body></html>\n")
os.makedirs("build/web", exist_ok=True)
open("build/web/index.html","w").write(web)
open("build/web/config.js","w").write(open("web/config.js").read())
open("build/web/.nojekyll","w").write("")
print("built", len(s), "bytes,", s.count("\n"), "lines, and build/web/")
