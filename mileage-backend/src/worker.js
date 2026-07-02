/**
 * Mileage Sync — Cloudflare Worker + D1
 * -------------------------------------
 * Stores each user's mileage profile (settings + locations + entries) as a
 * single JSON blob, one row per user. Per-user isolation is enforced here in
 * the Worker: every profile query is scoped to the authenticated user's id.
 *
 * IMPORTANT: This backend only ever touches MILEAGE data. No PHI / CRM
 * interrogation data is ever sent here. Keep it that way.
 *
 * Endpoints (all JSON):
 *   POST /register  {username, password, inviteCode} -> {token, username}
 *   POST /login     {username, password}             -> {token, username}
 *   GET  /profile   (Authorization: Bearer <token>)  -> {data, version, updatedAt}
 *   PUT  /profile   {data, baseVersion, force?}      -> {version, updatedAt}
 *                                                       or 409 {error:'conflict', data, version, updatedAt}
 *
 * Secrets (set with `wrangler secret put`):
 *   JWT_SECRET   - random string used to sign session tokens
 *   INVITE_CODE  - shared code required to create a new account
 * Vars (wrangler.toml [vars]):
 *   ALLOWED_ORIGIN - comma-separated list of allowed CORS origins
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const TOKEN_TTL_SECONDS = 60 * 60 * 12; // 12h — short-lived so it doesn't linger on shared machines
const MAX_PROFILE_BYTES = 1_000_000;    // 1MB guard; real profiles are a few KB

// ---------- encoding helpers ----------
function b64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function hex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(h) {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

// ---------- password hashing (PBKDF2-SHA256) ----------
async function hashPassword(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return hex(bits);
}
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- JWT (HS256) ----------
async function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const data = b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return data + "." + b64url(sig);
}
async function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = parts[0] + "." + parts[1];
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let ok;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(parts[2]), enc.encode(data));
  } catch (e) {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(parts[1])));
  } catch (e) {
    return null;
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

// ---------- HTTP helpers ----------
function corsHeaders(origin, extra) {
  return Object.assign(
    {
      "Access-Control-Allow-Origin": origin || "",
      "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    },
    extra || {}
  );
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: corsHeaders(origin, { "Content-Type": "application/json" }),
  });
}
function pickOrigin(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const o = req.headers.get("Origin");
  if (o && allowed.includes(o)) return o;
  return allowed[0] || "";
}
function validUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_.-]{3,32}$/.test(u);
}

// ---------- data access ----------
async function getUserByName(env, username) {
  return await env.DB.prepare("SELECT id, username, pass_hash, pass_salt FROM users WHERE username = ?")
    .bind(username)
    .first();
}
async function authUser(req, env) {
  const hdr = req.headers.get("Authorization") || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const payload = await verifyJwt(m[1], env.JWT_SECRET);
  if (!payload || !payload.sub) return null;
  return payload; // { sub: userId, username }
}

// ---------- route handlers ----------
async function handleRegister(req, env, origin) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "bad_request" }, 400, origin);
  const { username, password, inviteCode } = body;
  if (!validUsername(username)) return json({ error: "invalid_username", message: "3-32 chars: letters, numbers, . _ -" }, 400, origin);
  if (typeof password !== "string" || password.length < 8) return json({ error: "weak_password", message: "Use at least 8 characters." }, 400, origin);
  if (!env.INVITE_CODE || inviteCode !== env.INVITE_CODE) return json({ error: "bad_invite", message: "Invite code is incorrect." }, 403, origin);
  if (await getUserByName(env, username)) return json({ error: "username_taken", message: "That username is taken." }, 409, origin);

  const salt = randomBytes(16);
  const passHash = await hashPassword(password, salt);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO users (id, username, pass_hash, pass_salt, created_at) VALUES (?,?,?,?,?)")
    .bind(id, username, passHash, hex(salt), now).run();
  await env.DB.prepare("INSERT INTO profiles (user_id, data, version, updated_at) VALUES (?,?,?,?)")
    .bind(id, "", 0, now).run();

  const nowS = Math.floor(Date.now() / 1000);
  const token = await signJwt({ sub: id, username, iat: nowS, exp: nowS + TOKEN_TTL_SECONDS }, env.JWT_SECRET);
  return json({ token, username }, 200, origin);
}

async function handleLogin(req, env, origin) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: "bad_request" }, 400, origin);
  const { username, password } = body;
  if (!validUsername(username) || typeof password !== "string") return json({ error: "bad_credentials" }, 401, origin);
  const user = await getUserByName(env, username);
  if (!user) return json({ error: "bad_credentials" }, 401, origin);
  const candidate = await hashPassword(password, hexToBytes(user.pass_salt));
  if (!timingSafeEqual(candidate, user.pass_hash)) return json({ error: "bad_credentials" }, 401, origin);

  const nowS = Math.floor(Date.now() / 1000);
  const token = await signJwt({ sub: user.id, username: user.username, iat: nowS, exp: nowS + TOKEN_TTL_SECONDS }, env.JWT_SECRET);
  return json({ token, username: user.username }, 200, origin);
}

async function handleGetProfile(req, env, origin) {
  const auth = await authUser(req, env);
  if (!auth) return json({ error: "unauthorized" }, 401, origin);
  const row = await env.DB.prepare("SELECT data, version, updated_at FROM profiles WHERE user_id = ?").bind(auth.sub).first();
  if (!row) return json({ data: "", version: 0, updatedAt: null }, 200, origin);
  return json({ data: row.data || "", version: row.version || 0, updatedAt: row.updated_at || null }, 200, origin);
}

async function handlePutProfile(req, env, origin) {
  const auth = await authUser(req, env);
  if (!auth) return json({ error: "unauthorized" }, 401, origin);
  const body = await req.json().catch(() => null);
  if (!body || typeof body.data !== "string") return json({ error: "bad_request" }, 400, origin);
  if (body.data.length > MAX_PROFILE_BYTES) return json({ error: "too_large" }, 413, origin);

  const row = await env.DB.prepare("SELECT version FROM profiles WHERE user_id = ?").bind(auth.sub).first();
  const current = row ? row.version || 0 : 0;
  const base = Number(body.baseVersion);

  // Optimistic concurrency: if the client's base version is stale and it isn't
  // forcing the write, return the server copy so the client can resolve (LWW).
  if (!body.force && Number.isFinite(base) && base !== current) {
    const full = await env.DB.prepare("SELECT data, version, updated_at FROM profiles WHERE user_id = ?").bind(auth.sub).first();
    return json({ error: "conflict", data: full ? full.data : "", version: current, updatedAt: full ? full.updated_at : null }, 409, origin);
  }

  const newVersion = current + 1;
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE profiles SET data = ?, version = ?, updated_at = ? WHERE user_id = ?")
    .bind(body.data, newVersion, now, auth.sub).run();
  return json({ version: newVersion, updatedAt: now }, 200, origin);
}

export default {
  async fetch(req, env) {
    const origin = pickOrigin(req, env);
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      if (path === "/register" && req.method === "POST") return await handleRegister(req, env, origin);
      if (path === "/login" && req.method === "POST") return await handleLogin(req, env, origin);
      if (path === "/profile" && req.method === "GET") return await handleGetProfile(req, env, origin);
      if (path === "/profile" && req.method === "PUT") return await handlePutProfile(req, env, origin);
      if (path === "/") return json({ ok: true, service: "mileage-sync" }, 200, origin);
      return json({ error: "not_found" }, 404, origin);
    } catch (err) {
      return json({ error: "server_error", detail: String((err && err.message) || err) }, 500, origin);
    }
  },
};
