#!/usr/bin/env bash
# Build the Atlas: src/*.js -> build/atlas.js -> build/atlas.html. Where the
# (local-only) tests are present, also the test pages in tests/pages/: the
# page with a mock injected.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
python3 - <<'PY'
A="src/"
# No name tables in the page: owner, user and stage names come from the
# Worker after sign-in. Empty ones until the page stops asking for them.
tables=["  const OWNERS = {};", "  const USERS = {};", "  const STAGES = {\"pipeline\":{},\"dealStage\":{},\"leadStage\":{}};", "  const GONE = {};"]
core=open(A+"01-core.js").read().replace("  /*@@TABLES@@*/", "\n".join(tables))
view=open(A+"05-view.js").read().replace("    /*@@EXPAND@@*/", open(A+"06-expand.js").read())
parts=[core, open(A+"02-model.js").read(), open(A+"02b-canvas.js").read(), open(A+"03-walk.js").read(),
       open(A+"03b-segments.js").read(), open(A+"04-layout.js").read(), view, open(A+"07-page.js").read()]
open("build/atlas.js","w").write("".join(parts))
PY
node --check build/atlas.js
python3 build.py >/dev/null
if [ -d tests/mocks ]; then
  mkdir -p tests/pages
  python3 - <<'PY'
s=open("build/atlas.html").read()
base=open("tests/mocks/mock-db.js").read()
for mock,out in (("mock-func.js","func-new.html"),("mock-func2.js","func2-new.html"),("mock-big.js","big-new.html"),("mock-seg.js","seg-new.html")):
    m=open("tests/mocks/"+mock).read()
    open("tests/pages/"+out,"w").write('<meta charset="utf-8">'+s.replace("<title>Account Atlas</title>","<script>"+base+"\n"+m+"</script><title>Account Atlas</title>",1))
PY
  echo "built build/atlas.html and tests/pages/*"
else
  echo "built build/atlas.html"
fi
