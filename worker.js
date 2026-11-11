// IMRC panel — Cloudflare Worker (single file) — Telegram login + stats

const TEHRAN = 12600000; // UTC+3:30
const SESSION_MS = 30 * 86400000;
const TOKEN_MS = 10 * 60000;

/* ---------------- helpers ---------------- */
const json = (o, s = 200, headers = {}) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
const clean = (v, n = 40) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const randHex = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
function safeEq(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function device(ua) {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "?";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : "?";
  return os + " / " + br;
}
function cookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : "";
}

/* ---------------- database ---------------- */
let ready;
function getDB(env) {
  if (!env.DB) throw new Error("D1 binding با نام DB تنظیم نشده");
  if (!ready) {
    ready = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS visitors(
          vid TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER,
          country TEXT, city TEXT, device TEXT, ip_hash TEXT,
          visits INTEGER DEFAULT 0, configs INTEGER DEFAULT 0, actions INTEGER DEFAULT 0,
          last_name TEXT)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, vid TEXT, type TEXT,
          name TEXT, region TEXT, mode TEXT, role TEXT, detail TEXT)`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts)"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_tokens(
          token TEXT PRIMARY KEY, created INTEGER, verified INTEGER DEFAULT 0,
          tg_id TEXT, name TEXT, username TEXT)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions(
          sid TEXT PRIMARY KEY, tg_id TEXT, name TEXT, username TEXT, created INTEGER)`),
      ]);
      for (const col of ["tg_id", "tg_name", "tg_username"]) {
        try { await env.DB.prepare(`ALTER TABLE visitors ADD COLUMN ${col} TEXT`).run(); } catch (e) { /* already exists */ }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready.then(() => env.DB);
}

/* ---------------- telegram ---------------- */
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });
  return r.json();
}
let botName;
async function botUsername(env) {
  if (botName) return botName;
  const d = await tg(env, "getMe");
  if (!d.ok) throw new Error("BOT_TOKEN نامعتبر است");
  botName = d.result.username;
  return botName;
}

/* ---------------- sessions ---------------- */
async function getSession(env, request) {
  const sid = cookie(request, "imrc_sess");
  if (!/^[a-f0-9]{32}$/.test(sid)) return null;
  const db = await getDB(env);
  const row = await db.prepare("SELECT tg_id,name,username,created FROM sessions WHERE sid=?").bind(sid).first();
  if (!row || Date.now() - row.created > SESSION_MS) return null;
  return row;
}

/* ---------------- /api/auth/* ---------------- */
async function authStart(env) {
  if (!env.BOT_TOKEN) return json({ error: "BOT_TOKEN تنظیم نشده" }, 500);
  const db = await getDB(env);
  const now = Date.now();
  const token = randHex(12);
  await db.batch([
    db.prepare("DELETE FROM login_tokens WHERE created<?").bind(now - 3600000),
    db.prepare("INSERT INTO login_tokens(token,created,verified) VALUES(?,?,0)").bind(token, now),
  ]);
  const bot = await botUsername(env);
  return json({ token, bot, url: `https://t.me/${bot}?start=${token}` });
}

async function authCheck(env, url) {
  const token = url.searchParams.get("token") || "";
  if (!/^[a-f0-9]{24}$/.test(token)) return json({ status: "expired" });
  const db = await getDB(env);
  const now = Date.now();
  const row = await db.prepare("SELECT created,verified,tg_id,name,username FROM login_tokens WHERE token=?").bind(token).first();
  if (!row || now - row.created > TOKEN_MS) return json({ status: "expired" });
  if (!row.verified) return json({ status: "pending" });
  const sid = randHex(16);
  await db.batch([
    db.prepare("INSERT INTO sessions(sid,tg_id,name,username,created) VALUES(?,?,?,?,?)").bind(sid, row.tg_id, row.name, row.username, now),
    db.prepare("DELETE FROM login_tokens WHERE token=?").bind(token),
  ]);
  return json({ status: "ok" }, 200, {
    "Set-Cookie": `imrc_sess=${sid}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function tgWebhook(request, env) {
  if (!env.TG_WEBHOOK_SECRET || !safeEq(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TG_WEBHOOK_SECRET))
    return new Response("forbidden", { status: 403 });
  let upd;
  try { upd = await request.json(); } catch { return new Response("ok"); }
  const msg = upd && upd.message;
  if (!msg || !msg.from || !msg.chat) return new Response("ok");
  const text = String(msg.text || "");
  const reply = (t) => tg(env, "sendMessage", { chat_id: msg.chat.id, text: t }).catch(() => {});
  const m = text.match(/^\/start\s+([a-f0-9]{24})$/);
  if (!m) {
    if (text.startsWith("/start")) await reply("برای ورود، توی سایت روی «ورود با تلگرام» بزن.");
    return new Response("ok");
  }
  const db = await getDB(env);
  const name = clean([msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "), 40);
  const username = clean(msg.from.username, 32);
  const res = await db.prepare(
    "UPDATE login_tokens SET verified=1,tg_id=?,name=?,username=? WHERE token=? AND verified=0 AND created>?"
  ).bind(String(msg.from.id), name, username, m[1], Date.now() - TOKEN_MS).run();
  const changed = res && res.meta ? res.meta.changes : 1;
  await reply(changed ? "✅ وارد شدی! برگرد به مرورگر." : "⌛ این لینک ورود منقضی شده. دوباره از سایت امتحان کن.");
  return new Response("ok");
}

/* ---------------- /api/track ---------------- */
const TYPES = new Set(["visit", "ping", "action", "config"]);
async function track(request, env) {
  const sess = await getSession(env, request);
  if (!sess) return new Response(null, { status: 401 });
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2000) return new Response(null, { status: 413 });
    body = JSON.parse(raw);
  } catch { return new Response(null, { status: 400 }); }
  const type = body && body.type;
  const data = (body && body.data) || {};
  if (!TYPES.has(type)) return new Response(null, { status: 400 });

  const db = await getDB(env);
  const now = Date.now();
  const vid = "tg" + String(sess.tg_id).replace(/[^0-9]/g, "");
  const ua = request.headers.get("User-Agent") || "";
  const ipHash = await sha((request.headers.get("CF-Connecting-IP") || "") + (env.ADMIN_PASSWORD || "salt"));
  const country = (request.cf && request.cf.country) || "";
  const city = (request.cf && request.cf.city) || "";
  const name = type === "config" ? clean(data.name, 12) : "";
  const dv = type === "visit" ? 1 : 0, dc = type === "config" ? 1 : 0, da = type === "action" ? 1 : 0;

  const stmts = [
    db.prepare(
      `INSERT INTO visitors(vid,first_seen,last_seen,country,city,device,ip_hash,visits,configs,actions,last_name,tg_id,tg_name,tg_username)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(vid) DO UPDATE SET
         last_seen=excluded.last_seen, country=excluded.country, city=excluded.city,
         device=excluded.device, ip_hash=excluded.ip_hash,
         visits=visits+excluded.visits, configs=configs+excluded.configs, actions=actions+excluded.actions,
         last_name=COALESCE(excluded.last_name,last_name),
         tg_id=excluded.tg_id, tg_name=excluded.tg_name, tg_username=excluded.tg_username`
    ).bind(vid, now, now, country, city, device(ua), ipHash, dv, dc, da, name || null,
      String(sess.tg_id), sess.name || "", sess.username || ""),
  ];
  if (type !== "ping") {
    stmts.push(
      db.prepare("INSERT INTO events(ts,vid,type,name,region,mode,role,detail) VALUES(?,?,?,?,?,?,?,?)").bind(
        now, vid, type, type === "config" ? name : clean(data.name),
        clean(data.region, 8), clean(data.mode, 16), clean(data.role, 16), clean(data.detail, 60))
    );
  }
  await db.batch(stmts);
  return new Response(null, { status: 204 });
}

/* ---------------- /api/admin/* ---------------- */
function adminOk(request, env) {
  if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD تنظیم نشده" }, 500);
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!safeEq(auth, env.ADMIN_PASSWORD)) return json({ error: "رمز اشتباه است" }, 401);
  return null;
}

async function adminStats(env) {
  const db = await getDB(env);
  const now = Date.now();
  const dayStart = Math.floor((now + TEHRAN) / 86400000) * 86400000 - TEHRAN;
  const from14 = dayStart - 13 * 86400000;
  const P = (q, ...b) => db.prepare(q).bind(...b);
  const [tot, online, today, daily, regions, modes, visitors, events] = await db.batch([
    P("SELECT COUNT(*) v, COALESCE(SUM(visits),0) vis, COALESCE(SUM(configs),0) c, COALESCE(SUM(actions),0) a FROM visitors"),
    P("SELECT COUNT(*) n FROM visitors WHERE last_seen>?", now - 90000),
    P("SELECT (SELECT COUNT(*) FROM visitors WHERE last_seen>=?) v, (SELECT COUNT(*) FROM events WHERE type='config' AND ts>=?) c", dayStart, dayStart),
    P("SELECT CAST((ts+?)/86400000 AS INTEGER) d, COUNT(*) c FROM events WHERE type='config' AND ts>=? GROUP BY d ORDER BY d", TEHRAN, from14),
    P("SELECT region k, COUNT(*) c FROM events WHERE type='config' AND region<>'' GROUP BY region ORDER BY c DESC LIMIT 8"),
    P("SELECT mode k, COUNT(*) c FROM events WHERE type='config' AND mode<>'' GROUP BY mode ORDER BY c DESC LIMIT 8"),
    P("SELECT vid,first_seen,last_seen,country,city,device,visits,configs,actions,last_name,tg_id,tg_name,tg_username FROM visitors ORDER BY last_seen DESC LIMIT 100"),
    P("SELECT e.ts,e.vid,e.type,e.name,e.region,e.mode,e.role,e.detail,v.tg_name,v.tg_username FROM events e LEFT JOIN visitors v ON v.vid=e.vid ORDER BY e.id DESC LIMIT 60"),
  ]);
  return json({
    now, dayStart, tehran: TEHRAN,
    totals: tot.results[0], online: online.results[0].n, today: today.results[0],
    daily: daily.results, regions: regions.results, modes: modes.results,
    visitors: visitors.results, events: events.results,
  });
}

async function adminWebhook(request, env) {
  if (!env.BOT_TOKEN) return json({ error: "BOT_TOKEN تنظیم نشده" }, 500);
  if (!env.TG_WEBHOOK_SECRET) return json({ error: "TG_WEBHOOK_SECRET تنظیم نشده" }, 500);
  const url = new URL(request.url);
  const me = await tg(env, "getMe");
  if (!me.ok) return json({ error: "BOT_TOKEN نامعتبر است" }, 400);
  const r = await tg(env, "setWebhook", {
    url: url.origin + "/api/tg/webhook",
    secret_token: env.TG_WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  return json({ ok: !!r.ok, bot: me.result.username, description: r.description || "" }, r.ok ? 200 : 400);
}

/* ---------------- router ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/auth/start" && request.method === "POST") return await authStart(env);
      if (p === "/api/auth/check" && request.method === "GET") return await authCheck(env, url);
      if (p === "/api/tg/webhook" && request.method === "POST") return await tgWebhook(request, env);
      if (p === "/api/track" && request.method === "POST") return await track(request, env);
      if (p === "/api/admin/stats" && request.method === "GET") {
        const bad = adminOk(request, env); if (bad) return bad;
        return await adminStats(env);
      }
      if (p === "/api/admin/webhook" && request.method === "POST") {
        const bad = adminOk(request, env); if (bad) return bad;
        return await adminWebhook(request, env);
      }
      if (p.startsWith("/api/")) return new Response(null, { status: 405 });

      // پنل اصلی فقط برای کاربر واردشده
      if (p === "/" || p === "/index.html" || p === "/index") {
        const sess = await getSession(env, request);
        if (!sess) return Response.redirect(url.origin + "/login.html", 302);
        const res = await env.ASSETS.fetch(new Request(url.origin + "/", { headers: request.headers }));
        const h = new Headers(res.headers);
        h.set("Cache-Control", "no-store");
        return new Response(res.body, { status: res.status, headers: h });
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
