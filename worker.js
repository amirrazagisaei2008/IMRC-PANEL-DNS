// IMRC panel — Cloudflare Worker (single file)

// ---- database ----
// ساخت خودکار جدول‌ها (فقط بار اول)
let ready;
function getDB(env) {
  if (!env.DB) throw new Error("D1 binding با نام DB تنظیم نشده");
  if (!ready) {
    ready = env.DB.batch([
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
    ]).catch((e) => { ready = null; throw e; });
  }
  return ready.then(() => env.DB);
}

// ---- /api/track ----

const TYPES = new Set(["visit", "ping", "action", "config"]);
const clean = (v, n = 40) =>
  String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

function device(ua) {
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "?";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : "?";
  return os + " / " + br;
}

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function track({ request, env }) {
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 2000) return new Response(null, { status: 413 });
    body = JSON.parse(raw);
  } catch { return new Response(null, { status: 400 }); }

  const { vid, type } = body || {};
  const data = body?.data || {};
  if (!/^[a-zA-Z0-9-]{8,40}$/.test(vid || "") || !TYPES.has(type))
    return new Response(null, { status: 400 });

  const db = await getDB(env);
  const now = Date.now();
  const ua = request.headers.get("User-Agent") || "";
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ipHash = await sha(ip + (env.ADMIN_PASSWORD || "salt"));
  const country = request.cf?.country || "";
  const city = request.cf?.city || "";

  const name = type === "config" ? clean(data.name, 12) : "";
  const dv = type === "visit" ? 1 : 0;
  const dc = type === "config" ? 1 : 0;
  const da = type === "action" ? 1 : 0;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO visitors(vid,first_seen,last_seen,country,city,device,ip_hash,visits,configs,actions,last_name)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(vid) DO UPDATE SET
         last_seen=excluded.last_seen, country=excluded.country, city=excluded.city,
         device=excluded.device, ip_hash=excluded.ip_hash,
         visits=visits+excluded.visits, configs=configs+excluded.configs,
         actions=actions+excluded.actions,
         last_name=COALESCE(excluded.last_name,last_name)`
    ).bind(vid, now, now, country, city, device(ua), ipHash, dv, dc, da, name || null),
  ];

  if (type !== "ping") {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO events(ts,vid,type,name,region,mode,role,detail) VALUES(?,?,?,?,?,?,?,?)"
      ).bind(
        now, vid, type,
        type === "config" ? name : clean(data.name),
        clean(data.region, 8), clean(data.mode, 16), clean(data.role, 16), clean(data.detail, 60)
      )
    );
  }
  await db.batch(stmts);
  return new Response(null, { status: 204 });
}

// ---- /api/admin/stats ----

const TEHRAN = 12600000; // UTC+3:30
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function stats({ request, env }) {
  if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD تنظیم نشده" }, 500);
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!safeEq(auth, env.ADMIN_PASSWORD)) return json({ error: "رمز اشتباه است" }, 401);

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
    P("SELECT vid,first_seen,last_seen,country,city,device,visits,configs,actions,last_name FROM visitors ORDER BY last_seen DESC LIMIT 100"),
    P("SELECT ts,vid,type,name,region,mode,role,detail FROM events ORDER BY id DESC LIMIT 60"),
  ]);

  return json({
    now, dayStart, tehran: TEHRAN,
    totals: tot.results[0], online: online.results[0].n, today: today.results[0],
    daily: daily.results, regions: regions.results, modes: modes.results,
    visitors: visitors.results, events: events.results,
  });
}

// ---- router ----

const errJson = (o, s) =>
  new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/track")
        return request.method === "POST" ? await track({ request, env }) : new Response(null, { status: 405 });
      if (pathname === "/api/admin/stats")
        return request.method === "GET" ? await stats({ request, env }) : new Response(null, { status: 405 });
    } catch (e) {
      return errJson({ error: String((e && e.message) || e) }, 500);
    }
    return new Response("Not found", { status: 404 });
  },
};
