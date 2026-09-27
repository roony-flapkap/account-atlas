// The old artifact store, on D1. The page's canvas code was written against
// its contract, so the contract is kept exactly (tests/mocks/mock-db.js is
// the reference): paths alternate collection and document, update() needs
// the document to exist and merges nested objects, 256 KiB a document, and
// data/users/<uid>/ is private to that user — invisible to everyone else,
// and unwritable. Last writer wins; there are no transactions.

const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
const DOC_MAX = 262144;
const LIST_MAX = 1000;

export class StoreError extends Error {
  constructor(code, message){ super(message || code); this.code = code; }
}

function segs(path, parity){
  const a = String(path == null ? "" : path).split("/");
  for (const x of a) if (!SEG.test(x) || x === "." || x === "..") throw new StoreError("invalid_argument", "bad segment '" + x + "' in " + path);
  if (a.length % 2 !== parity) throw new StoreError("invalid_argument", "wrong parity for " + path + " (" + a.length + ")");
  if (a.length > 16) throw new StoreError("invalid_argument", "too deep");
  return a;
}
const foreign = (a, uid) => a[0] === "data" && a[1] === "users" && a.length > 2 && a[2] !== uid;

function merge(a, b){
  for (const k of Object.keys(b)){
    const v = b[k];
    if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) merge(a[k], v);
    else a[k] = v;
  }
  return a;
}

function body(data){
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new StoreError("invalid_argument", "a document is an object");
  const s = JSON.stringify(data);
  if (new TextEncoder().encode(s).length > DOC_MAX) throw new StoreError("invalid_argument", "document over 256 KiB");
  return s;
}

// One operation: { op: get|set|update|delete|list, path, data?, limit? }
export async function storeOp(env, user, req){
  const op = req && req.op, path = req && req.path;
  const at = new Date().toISOString();
  if (op === "list"){
    const a = segs(path, 1);
    if (foreign(a, user.uid)) return { docs: [] };
    const n = req.limit == null ? LIST_MAX : Number(req.limit);
    if (!(n >= 1 && n <= LIST_MAX)) throw new StoreError("invalid_argument", "limit");
    const r = await env.APP.prepare("SELECT path, data FROM docs WHERE parent = ?1 ORDER BY path LIMIT ?2").bind(path, n).all();
    const docs = [];
    for (const row of r.results || []){
      // the users collection lists only the caller's own entry
      if (foreign(row.path.split("/"), user.uid)) continue;
      docs.push({ id: row.path.slice(path.length + 1), data: JSON.parse(row.data) });
    }
    return { docs };
  }

  const a = segs(path, 0);
  const parent = a.slice(0, -1).join("/");
  if (op === "get"){
    if (foreign(a, user.uid)) return { exists: false };
    const row = await env.APP.prepare("SELECT data FROM docs WHERE path = ?1").bind(path).first();
    return row ? { exists: true, data: JSON.parse(row.data) } : { exists: false };
  }
  if (foreign(a, user.uid)) throw new StoreError("invalid_argument", "not your subtree");
  if (op === "set"){
    await env.APP.prepare(
      "INSERT INTO docs (path, parent, data, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5) " +
      "ON CONFLICT(path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
    ).bind(path, parent, body(req.data), at, user.email).run();
    return {};
  }
  if (op === "update"){
    if (!req.data || typeof req.data !== "object" || Array.isArray(req.data)) throw new StoreError("invalid_argument", "a document is an object");
    const row = await env.APP.prepare("SELECT data FROM docs WHERE path = ?1").bind(path).first();
    if (!row) throw new StoreError("invalid_argument", "update needs an existing document: " + path);
    await env.APP.prepare("UPDATE docs SET data = ?2, updated_at = ?3, updated_by = ?4 WHERE path = ?1")
      .bind(path, body(merge(JSON.parse(row.data), req.data)), at, user.email).run();
    return {};
  }
  if (op === "delete"){
    // like the artifact store: documents under this one are not deleted
    await env.APP.prepare("DELETE FROM docs WHERE path = ?1").bind(path).run();
    return {};
  }
  throw new StoreError("invalid_argument", "unknown op");
}
