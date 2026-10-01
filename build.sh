#!/usr/bin/env bash
# Build the Atlas: src/*.js -> build/atlas.js -> build/atlas.html. Where the
# (local-only) tests are present, also the test pages in tests/pages/: the
# page with a mock injected.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build
python3 - <<'PY'
A="src/"
# 00-platform is its own script (sign-in, the API, live changes, routes);
# 01-core opens the page's one IIFE and 08-boot closes it.
view=open(A+"05-view.js").read().replace("    /*@@EXPAND@@*/", open(A+"06-expand.js").read())
parts=[open(A+"00-platform.js").read(), open(A+"01-core.js").read(), open(A+"02-model.js").read(), open(A+"02b-canvas.js").read(),
       open(A+"03-walk.js").read(), open(A+"03b-segments.js").read(), open(A+"04-layout.js").read(), view,
       open(A+"07-page.js").read(), open(A+"07b-live.js").read(), open(A+"07c-findings.js").read(), open(A+"07d-edit.js").read(),
       open(A+"08-boot.js").read()]
open("build/atlas.js","w").write("\n".join(parts))
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
