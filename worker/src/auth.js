// Sign-in. The page gets a Google ID token (Google Identity Services), posts
// it once to /api/session, and gets back this Worker's own session token,
// which it sends as a Bearer header from then on. No cookies: the page and
// the Worker are on different sites, and cross-site cookies are what broke
// sign-in on Safari and Firefox before.

const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = ["accounts.google.com", "https://accounts.google.com"];
const SKEW = 60; // seconds of clock drift allowed either way

export class AuthError extends Error {
  constructor(code, message){ super(message || code); this.code = code; }
}

const enc = new TextEncoder();
export function b64u(bytes){
  let s = ""; const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(str){
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
const json64 = str => JSON.parse(new TextDecoder().decode(unb64u(str)));

// Google rotates its keys; they are cached for as long as Google says.
let jwksCache = { keys: null, until: 0 };
export async function googleKeys(now = Date.now()){
  if (jwksCache.keys && now < jwksCache.until) return jwksCache.keys;
  const r = await fetch(GOOGLE_JWKS);
  if (!r.ok) throw new AuthError("keys_unavailable", "Google's signing keys could not be read");
  const age = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  const body = await r.json();
  jwksCache = { keys: body.keys || [], until: now + (age ? Number(age[1]) : 3600) * 1000 };
  return jwksCache.keys;
}

// Verifies a Google ID token and returns who it is, or throws. Only a
// verified address on the allowed Workspace domain gets through: the `hd`
// claim is set by Google for Workspace accounts, and the address itself
// must end in the domain too (a personal Gmail has no `hd`).
export async function verifyGoogleIdToken(idToken, env, opts = {}){
  const now = Math.floor((opts.now || Date.now()) / 1000);
  const getKeys = opts.getKeys || googleKeys;
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new AuthError("malformed", "not a token");
  let head, claims;
  try { head = json64(parts[0]); claims = json64(parts[1]); } catch(e){ throw new AuthError("malformed", "unreadable token"); }
  if (head.alg !== "RS256") throw new AuthError("bad_alg", "unexpected signing algorithm");

  const jwk = (await getKeys()).find(k => k.kid === head.kid);
  if (!jwk) throw new AuthError("unknown_key", "token signed with an unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) throw new AuthError("bad_signature", "token signature does not verify");

  if (!env.GOOGLE_CLIENT_ID || claims.aud !== env.GOOGLE_CLIENT_ID) throw new AuthError("bad_audience", "token was issued for another app");
  if (GOOGLE_ISS.indexOf(claims.iss) < 0) throw new AuthError("bad_issuer", "token not issued by Google");
  if (!(claims.exp + SKEW > now)) throw new AuthError("expired", "token has expired");
  if (claims.iat && claims.iat - SKEW > now) throw new AuthError("not_yet", "token issued in the future");

  const domain = String(env.ALLOWED_DOMAIN || "").toLowerCase();
  const email = String(claims.email || "").toLowerCase();
  if (!domain) throw new AuthError("no_domain", "ALLOWED_DOMAIN is not configured");
  if (claims.email_verified !== true) throw new AuthError("unverified", "email address not verified");
  if (String(claims.hd || "").toLowerCase() !== domain || !email.endsWith("@" + domain))
    throw new AuthError("wrong_domain", "only @" + domain + " accounts may sign in");

  return { email, name: claims.name || email, picture: claims.picture || null };
}

// A stable, opaque id per person, used for their private canvases
// (data/users/<uid>/…), so an address never appears in a store path.
export async function uidFor(email){
  const h = await crypto.subtle.digest("SHA-256", enc.encode(String(email).toLowerCase()));
  return "u_" + [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(env){
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new AuthError("no_secret", "SESSION_SECRET is missing or too short");
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintSession(who, env, nowMs = Date.now()){
  const hours = Number(env.SESSION_HOURS) || 12;
  const body = { e: who.email, n: who.name, p: who.picture, u: await uidFor(who.email), x: Math.floor(nowMs / 1000) + hours * 3600 };
  const head = b64u(enc.encode(JSON.stringify(body)));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(head)));
  return { token: head + "." + sig, user: sessionUser(body) };
}

const sessionUser = b => ({ email: b.e, name: b.n, picture: b.p, uid: b.u, expiresAt: new Date(b.x * 1000).toISOString() });

// Returns the signed-in user, or null for anything missing, forged or expired.
export async function readSession(token, env, nowMs = Date.now()){
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(env), unb64u(parts[1]), enc.encode(parts[0])); } catch(e){ return null; }
  if (!ok) return null;
  let body; try { body = json64(parts[0]); } catch(e){ return null; }
  if (!(body.x > Math.floor(nowMs / 1000))) return null;
  // the domain rule is re-checked here too, so narrowing ALLOWED_DOMAIN takes effect at once
  const domain = String(env.ALLOWED_DOMAIN || "").toLowerCase();
  if (!domain || !String(body.e || "").endsWith("@" + domain)) return null;
  return sessionUser(body);
}
