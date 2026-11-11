// IMRC panel — Cloudflare Worker (single file) — Telegram login + stats

const TEHRAN = 12600000; // UTC+3:30
const SESSION_MS = 30 * 86400000;
const TOKEN_MS = 10 * 60000;
const CHANNEL = "@IMRC_Panel";           // کانال اجباری
const FREE_DNS = ["10.202.10.10, 78.157.42.101", "1.1.1.1, 1.0.0.1"];
const MTU_PRESETS = ["1280", "1350", "1400", "1420", "1450"];

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
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS config_log(
          id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, ts INTEGER, region TEXT)`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_cfglog ON config_log(tg_id, ts)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS subs(tg_id TEXT PRIMARY KEY, until INTEGER)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS user_limits(tg_id TEXT PRIMARY KEY, lim INTEGER, period TEXT, unlock INTEGER DEFAULT 0, until INTEGER)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS bans(tg_id TEXT PRIMARY KEY, reason TEXT, ts INTEGER)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS members(tg_id TEXT PRIMARY KEY, ok INTEGER, checked INTEGER)"),
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
  if (await db.prepare("SELECT 1 x FROM bans WHERE tg_id=?").bind(String(row.tg_id)).first()) return null;
  return row;
}

async function isBanned(db, tgId) {
  return !!(await db.prepare("SELECT 1 x FROM bans WHERE tg_id=?").bind(String(tgId)).first());
}

/* ---------------- channel membership ---------------- */
async function isMember(env, db, tgId, force = false) {
  tgId = String(tgId);
  const now = Date.now();
  if (!force) {
    const c = await db.prepare("SELECT ok,checked FROM members WHERE tg_id=?").bind(tgId).first();
    if (c && now - c.checked < (c.ok ? 600000 : 30000)) return !!c.ok;
  }
  let ok;
  try {
    const d = await tg(env, "getChatMember", { chat_id: CHANNEL, user_id: Number(tgId) });
    if (d.ok) {
      const st = d.result.status;
      ok = ["creator", "administrator", "member"].includes(st) || (st === "restricted" && d.result.is_member === true);
    } else if (/user not found|PARTICIPANT_ID_INVALID/i.test(d.description || "")) {
      ok = false;
    } else {
      return true; // خطای تنظیمات (مثلاً ربات ادمین نیست) → کاربرها قفل نشن
    }
  } catch (e) { return true; }
  await db.prepare("INSERT INTO members(tg_id,ok,checked) VALUES(?,?,?) ON CONFLICT(tg_id) DO UPDATE SET ok=excluded.ok, checked=excluded.checked")
    .bind(tgId, ok ? 1 : 0, now).run();
  return ok;
}
const JOIN_KB = (token) => ({
  inline_keyboard: [
    [{ text: "📢 عضویت در کانال", url: "https://t.me/" + CHANNEL.slice(1) }],
    ...(token ? [[{ text: "✅ عضو شدم", callback_data: "chk:" + token }]] : []),
  ],
});

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
  if (row.verified === 2 || (await isBanned(db, row.tg_id))) {
    await db.prepare("DELETE FROM login_tokens WHERE token=?").bind(token).run();
    return json({ status: "banned" });
  }
  const sid = randHex(16);
  await db.batch([
    db.prepare("INSERT INTO sessions(sid,tg_id,name,username,created) VALUES(?,?,?,?,?)").bind(sid, row.tg_id, row.name, row.username, now),
    db.prepare("DELETE FROM login_tokens WHERE token=?").bind(token),
  ]);
  return json({ status: "ok" }, 200, {
    "Set-Cookie": `imrc_sess=${sid}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
  });
}

async function verifyLogin(env, db, token, from, chatId) {
  const reply = (t, extra = {}) => tg(env, "sendMessage", { chat_id: chatId, text: t, ...extra }).catch(() => {});
  const tgId = String(from.id);
  if (await isBanned(db, tgId)) {
    await db.prepare("UPDATE login_tokens SET verified=2 WHERE token=?").bind(token).run();
    await reply("⛔ حساب تو مسدود شده و امکان ورود نداری.");
    return;
  }
  if (!(await isMember(env, db, tgId, true))) {
    await reply(`برای ورود باید عضو کانال ${CHANNEL} باشی.\nعضو شو و بعد دکمه‌ی «عضو شدم» رو بزن.`, { reply_markup: JOIN_KB(token) });
    return;
  }
  const name = clean([from.first_name, from.last_name].filter(Boolean).join(" "), 40);
  const username = clean(from.username, 32);
  const res = await db.prepare(
    "UPDATE login_tokens SET verified=1,tg_id=?,name=?,username=? WHERE token=? AND verified=0 AND created>?"
  ).bind(tgId, name, username, token, Date.now() - TOKEN_MS).run();
  const changed = res && res.meta ? res.meta.changes : 1;
  await reply(changed ? "✅ وارد شدی! برگرد به مرورگر." : "⌛ این لینک ورود منقضی شده. دوباره از سایت امتحان کن.");
}

async function tgWebhook(request, env) {
  if (!env.TG_WEBHOOK_SECRET || !safeEq(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TG_WEBHOOK_SECRET))
    return new Response("forbidden", { status: 403 });
  let upd;
  try { upd = await request.json(); } catch { return new Response("ok"); }
  const db = await getDB(env);

  const cq = upd && upd.callback_query;
  if (cq && cq.from) {
    const m = String(cq.data || "").match(/^chk:([a-f0-9]{24})$/);
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
    if (m) await verifyLogin(env, db, m[1], cq.from, cq.from.id);
    return new Response("ok");
  }

  const msg = upd && upd.message;
  if (!msg || !msg.from || !msg.chat) return new Response("ok");
  const text = String(msg.text || "");
  const m = text.match(/^\/start\s+([a-f0-9]{24})$/);
  if (!m) {
    if (text.startsWith("/start"))
      await tg(env, "sendMessage", { chat_id: msg.chat.id, text: "برای ورود، توی سایت روی «ورود با تلگرام» بزن." }).catch(() => {});
    return new Response("ok");
  }
  await verifyLogin(env, db, m[1], msg.from, msg.chat.id);
  return new Response("ok");
}

/* ---------------- settings / quota ---------------- */
const DEFAULTS = {
  free_limit: "1",
  sub_limit: "20",
  free_countries: "tr,de,ae",
  buy_text: "سقف ساخت کانفیگ رایگان امروز تموم شد.\nبرای ساخت بیشتر، اشتراک تهیه کن:\n\n💳 شماره کارت: 6219 8614 9829 6879\n👤 به نام: امیر رزاقی ساعی (بانک سامان)\n\nبعد از پرداخت، رسید رو به @IMRC_support بفرست تا اشتراکت فعال بشه.",
};
async function getSettings(db) {
  const rows = (await db.prepare("SELECT k,v FROM settings").all()).results || [];
  const o = { ...DEFAULTS };
  for (const r of rows) if (r.k in DEFAULTS) o[r.k] = r.v;
  return {
    free_limit: Math.max(0, parseInt(o.free_limit) || 0),
    sub_limit: Math.max(0, parseInt(o.sub_limit) || 0),
    free_countries: String(o.free_countries).toLowerCase().replace(/[^a-z,]/g, ""),
    buy_text: String(o.buy_text),
  };
}
const dayStartOf = (now) => Math.floor((now + TEHRAN) / 86400000) * 86400000 - TEHRAN;

const PERIODS = { day: "روز", week: "هفته", month: "ماه" };
function g2j(gy, gm, gd) {
  const g = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy > 1600 ? 979 : 0; gy -= gy > 1600 ? 1600 : 621;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) - 80 + gd + g[gm - 1];
  jy += 33 * Math.floor(days / 12053); days %= 12053;
  jy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jm, jd];
}
// شروع دوره به وقت ایران: روز / هفته (از شنبه) / ماه شمسی
function periodStartOf(now, period) {
  const ds = dayStartOf(now);
  if (period === "week") {
    const dow = new Date(now + TEHRAN).getUTCDay(); // 0=یکشنبه ... 6=شنبه
    return ds - ((dow + 1) % 7) * 86400000;
  }
  if (period === "month") {
    const t = new Date(now + TEHRAN);
    const jd = g2j(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())[1];
    return ds - (jd - 1) * 86400000;
  }
  return ds;
}

async function quotaInfo(db, tgId) {
  const now = Date.now();
  const id = String(tgId);
  const st = await getSettings(db);
  const sub = await db.prepare("SELECT until FROM subs WHERE tg_id=?").bind(id).first();
  const subActive = !!(sub && sub.until > now);
  const ul = await db.prepare("SELECT lim,period,unlock,until FROM user_limits WHERE tg_id=?").bind(id).first();
  const custom = !!(ul && (!ul.until || ul.until > now));
  const period = custom && PERIODS[ul.period] ? ul.period : "day";
  const limit = custom ? ul.lim : (subActive ? st.sub_limit : st.free_limit);
  const periodStart = periodStartOf(now, period);
  const used = (await db.prepare("SELECT COUNT(*) n FROM config_log WHERE tg_id=? AND ts>=?").bind(id, periodStart).first()).n;
  const unlock = subActive || (custom && !!ul.unlock);
  return {
    used, limit, remaining: Math.max(0, limit - used), period, periodStart,
    custom, unlock, sub: subActive, sub_until: subActive ? sub.until : null,
    buy_text: st.buy_text, free_countries: st.free_countries,
  };
}

async function me(request, env) {
  const sess = await getSession(env, request);
  if (!sess) return json({ error: "login" }, 401);
  const db = await getDB(env);
  if (!(await isMember(env, db, sess.tg_id))) return json({ error: "join" }, 403);
  const q = await quotaInfo(db, sess.tg_id);
  return json({ name: sess.name, username: sess.username, ...q, free_countries: q.free_countries.split(",").filter(Boolean) });
}

async function memberCheck(request, env) {
  const sess = await getSession(env, request);
  if (!sess) return json({ error: "login" }, 401);
  const db = await getDB(env);
  return json({ ok: await isMember(env, db, sess.tg_id, true) });
}

/* ---------------- config generation (server side) ---------------- */
const P4 = { fr: "51.158", de: "138.201", ae: "94.200", tr: "45.32", iq: "185.66", fi: "65.108", jp: "160.16", us: "104.248", sa: "185.25", gb: "51.140", kr: "141.164", om: "185.93" };
const P6 = {
  fr: ["2a01:4f8:1:abcd"], de: ["2a01:4f8:1:4321"], ae: ["2a0c:4b00:1234:5678"], tr: ["2a0c:4b00:aaaa:bbbb"],
  jp: ["2400:8901:abcd:1234"], us: ["2604:a880:4:abcd"], sa: ["2a0c:4b00:5a00:1234"], gb: ["2a00:23c8:abcd:1234"],
};
const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
function wgKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  b[0] &= 248; b[31] &= 127; b[31] |= 64;
  let bin = ""; for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}
const addr4 = (c) => `${P4[c] || "94.100"}.${rnd(255)}.${rnd(255)}`;
function addr6(c) {
  const a = P6[c] || ["2a0c:4b00:cccc:dddd"];
  const h = () => rnd(65536).toString(16).padStart(4, "0");
  return `${a[rnd(a.length)]}:${h()}:${h()}:${h()}:${h()}`;
}
function buildConfig({ region, dns, mtu, mode, role }) {
  const v4 = addr4(region), v6 = addr6(region);
  let iface = `PrivateKey = ${wgKey()}\nAddress = ${v4}/32, ${v6}/128`;
  if (dns) iface += `\nDNS = ${dns}`;
  if (mtu) iface += `\nMTU = ${mtu}`;
  const now = new Date().toISOString().slice(0, 10);
  return `# IMRC CODM Pro Ultra Config\n# Game Mode: ${mode.toUpperCase()} | Role: ${role.toUpperCase()}\n# Built: ${now}\n# Optimized for Call of Duty Mobile\n\n[Interface]\n${iface}\n\n[Peer]\nPublicKey = ${wgKey()}\nEndpoint = ${v4}:51820\n# LowLatency=true | PacketPriority=game`;
}
const MODES = new Set(["ranked", "br", "mp"]);
const ROLES = new Set(["attacker", "defender", "support"]);

async function createConfig(request, env) {
  const sess = await getSession(env, request);
  if (!sess) return json({ error: "login" }, 401);
  let b;
  try { b = JSON.parse(await request.text()); } catch { return json({ error: "bad" }, 400); }
  const region = String(b.region || "").toLowerCase();
  if (!/^[a-z]{2}$/.test(region)) return json({ error: "کشور نامعتبر است" }, 400);
  const dns = b.dns ? String(b.dns) : "";
  if (dns && !/^[0-9a-fA-F:.,\s]{3,80}$/.test(dns)) return json({ error: "DNS نامعتبر است" }, 400);
  let mtu = "";
  if (b.mtu) { const n = parseInt(b.mtu); if (!(n >= 576 && n <= 1500)) return json({ error: "MTU نامعتبر است" }, 400); mtu = String(n); }
  const mode = MODES.has(b.mode) ? b.mode : "ranked";
  const role = ROLES.has(b.role) ? b.role : "attacker";
  const name = clean(b.name, 12);

  const db = await getDB(env);
  const now = Date.now();
  if (!(await isMember(env, db, sess.tg_id))) return json({ error: "join", message: `برای استفاده باید عضو کانال ${CHANNEL} باشی.` }, 403);
  const q = await quotaInfo(db, sess.tg_id);
  if (!q.unlock) {
    const locked = (what) => json({ error: "premium", message: `${what} مخصوص کاربران اشتراکه.\n\n${q.buy_text}` }, 403);
    if (!q.free_countries.split(",").includes(region)) return locked("این کشور");
    if (dns && !FREE_DNS.includes(dns.replace(/\s+/g, " ").trim())) return locked("این DNS");
    if (mtu && !MTU_PRESETS.includes(mtu)) return locked("MTU دلخواه");
  }
  // ثبت اتمیک: فقط اگر هنوز سهمیه مونده باشه
  const ins = await db.prepare(
    `INSERT INTO config_log(tg_id,ts,region)
     SELECT ?,?,? WHERE (SELECT COUNT(*) FROM config_log WHERE tg_id=? AND ts>=?) < ?`
  ).bind(String(sess.tg_id), now, region, String(sess.tg_id), q.periodStart, q.limit).run();
  const ok = ins && ins.meta ? ins.meta.changes > 0 : false;
  if (!ok) return json({ error: "limit", message: q.buy_text, used: q.used, limit: q.limit, period: q.period, sub: q.sub, custom: q.custom, unlock: q.unlock }, 429);

  const vid = "tg" + String(sess.tg_id).replace(/[^0-9]/g, "");
  const ua = request.headers.get("User-Agent") || "";
  const ipHash = await sha((request.headers.get("CF-Connecting-IP") || "") + (env.ADMIN_PASSWORD || "salt"));
  await db.batch([
    db.prepare(
      `INSERT INTO visitors(vid,first_seen,last_seen,country,city,device,ip_hash,visits,configs,actions,last_name,tg_id,tg_name,tg_username)
       VALUES(?,?,?,?,?,?,?,0,1,0,?,?,?,?)
       ON CONFLICT(vid) DO UPDATE SET last_seen=excluded.last_seen, configs=configs+1,
         last_name=COALESCE(excluded.last_name,last_name),
         tg_id=excluded.tg_id, tg_name=excluded.tg_name, tg_username=excluded.tg_username`
    ).bind(vid, now, now, (request.cf && request.cf.country) || "", (request.cf && request.cf.city) || "", device(ua), ipHash,
      name || null, String(sess.tg_id), sess.name || "", sess.username || ""),
    db.prepare("INSERT INTO events(ts,vid,type,name,region,mode,role,detail) VALUES(?,?,?,?,?,?,?,?)")
      .bind(now, vid, "config", name, region, mode, role, ""),
  ]);
  const config = buildConfig({ region, dns, mtu, mode, role });
  return json({ config, used: q.used + 1, limit: q.limit, remaining: Math.max(0, q.limit - q.used - 1), period: q.period, sub: q.sub, sub_until: q.sub_until, custom: q.custom, unlock: q.unlock });
}

/* ---------------- /api/track ---------------- */
const TYPES = new Set(["visit", "ping", "action"]);
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
    P("SELECT v.vid,v.first_seen,v.last_seen,v.country,v.city,v.device,v.visits,v.configs,v.actions,v.last_name,v.tg_id,v.tg_name,v.tg_username,s.until sub_until,b.tg_id banned,ul.lim ul_lim,ul.period ul_period,ul.unlock ul_unlock,ul.until ul_until FROM visitors v LEFT JOIN subs s ON s.tg_id=v.tg_id LEFT JOIN bans b ON b.tg_id=v.tg_id LEFT JOIN user_limits ul ON ul.tg_id=v.tg_id ORDER BY v.last_seen DESC LIMIT 100"),
    P("SELECT e.ts,e.vid,e.type,e.name,e.region,e.mode,e.role,e.detail,v.tg_name,v.tg_username FROM events e LEFT JOIN visitors v ON v.vid=e.vid ORDER BY e.id DESC LIMIT 60"),
  ]);
  return json({
    now, dayStart, tehran: TEHRAN,
    totals: tot.results[0], online: online.results[0].n, today: today.results[0],
    daily: daily.results, regions: regions.results, modes: modes.results,
    visitors: visitors.results, events: events.results,
    settings: await getSettings(db),
  });
}

async function adminSub(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  const tgId = String(b.tg_id || "");
  const days = parseInt(b.days);
  if (!/^[0-9]{3,20}$/.test(tgId) || !(days >= 0 && days <= 3650)) return json({ error: "ورودی نامعتبر" }, 400);
  const db = await getDB(env);
  const now = Date.now();
  let until = null;
  if (days === 0) {
    await db.prepare("DELETE FROM subs WHERE tg_id=?").bind(tgId).run();
  } else {
    const cur = await db.prepare("SELECT until FROM subs WHERE tg_id=?").bind(tgId).first();
    until = Math.max(now, (cur && cur.until) || 0) + days * 86400000;
    await db.prepare("INSERT INTO subs(tg_id,until) VALUES(?,?) ON CONFLICT(tg_id) DO UPDATE SET until=excluded.until").bind(tgId, until).run();
    if (env.BOT_TOKEN) {
      const when = new Date(until).toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
      await tg(env, "sendMessage", { chat_id: tgId, text: `⭐ اشتراکت فعال شد.\nتا تاریخ ${when} می‌تونی روزانه تا ${(await getSettings(db)).sub_limit} کانفیگ بسازی.` }).catch(() => {});
    }
  }
  return json({ ok: true, until });
}

async function adminUserLimit(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  const tgId = String(b.tg_id || "");
  if (!/^[0-9]{3,20}$/.test(tgId)) return json({ error: "ورودی نامعتبر" }, 400);
  const db = await getDB(env);
  if (b.reset) {
    await db.prepare("DELETE FROM user_limits WHERE tg_id=?").bind(tgId).run();
    return json({ ok: true });
  }
  const lim = parseInt(b.limit), days = parseInt(b.days) || 0;
  const period = String(b.period || "");
  if (!(lim >= 0 && lim <= 1000) || !PERIODS[period] || !(days >= 0 && days <= 3650))
    return json({ error: "تعداد، دوره یا مدت نامعتبر است" }, 400);
  const unlock = b.unlock ? 1 : 0;
  const until = days ? Date.now() + days * 86400000 : null;
  await db.prepare(
    "INSERT INTO user_limits(tg_id,lim,period,unlock,until) VALUES(?,?,?,?,?) ON CONFLICT(tg_id) DO UPDATE SET lim=excluded.lim, period=excluded.period, unlock=excluded.unlock, until=excluded.until"
  ).bind(tgId, lim, period, unlock, until).run();
  if (env.BOT_TOKEN)
    await tg(env, "sendMessage", { chat_id: tgId, text: `⚙️ سقف ساخت کانفیگ تو تنظیم شد: ${lim} کانفیگ در هر ${PERIODS[period]}${unlock ? " (همه‌ی امکانات باز)" : ""}.` }).catch(() => {});
  return json({ ok: true, until });
}

async function adminBan(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  const tgId = String(b.tg_id || "");
  if (!/^[0-9]{3,20}$/.test(tgId)) return json({ error: "ورودی نامعتبر" }, 400);
  const db = await getDB(env);
  if (b.ban) {
    await db.batch([
      db.prepare("INSERT INTO bans(tg_id,reason,ts) VALUES(?,?,?) ON CONFLICT(tg_id) DO UPDATE SET reason=excluded.reason, ts=excluded.ts").bind(tgId, clean(b.reason, 100), Date.now()),
      db.prepare("DELETE FROM sessions WHERE tg_id=?").bind(tgId),
    ]);
    if (env.BOT_TOKEN) await tg(env, "sendMessage", { chat_id: tgId, text: "⛔ دسترسی تو به پنل مسدود شد." }).catch(() => {});
  } else {
    await db.prepare("DELETE FROM bans WHERE tg_id=?").bind(tgId).run();
    if (env.BOT_TOKEN) await tg(env, "sendMessage", { chat_id: tgId, text: "✅ مسدودیتت برداشته شد. می‌تونی دوباره وارد پنل بشی." }).catch(() => {});
  }
  return json({ ok: true });
}

async function adminSettings(request, env) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  const fl = parseInt(b.free_limit), sl = parseInt(b.sub_limit);
  if (!(fl >= 0 && fl <= 1000) || !(sl >= 0 && sl <= 1000)) return json({ error: "سقف باید بین ۰ تا ۱۰۰۰ باشد" }, 400);
  const fc = String(b.free_countries || "").toLowerCase().replace(/[^a-z,]/g, "").replace(/,+/g, ",").replace(/^,|,$/g, "");
  if (!/^[a-z]{2}(,[a-z]{2})*$/.test(fc)) return json({ error: "کشورهای رایگان باید کد دو حرفی و با ویرگول جدا باشد (مثل tr,de,ae)" }, 400);
  const text = String(b.buy_text || "").replace(/[\u0000-\u0008]/g, "").trim().slice(0, 400) || DEFAULTS.buy_text;
  const db = await getDB(env);
  await db.batch([
    db.prepare("INSERT INTO settings(k,v) VALUES('free_limit',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(fl)),
    db.prepare("INSERT INTO settings(k,v) VALUES('sub_limit',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(sl)),
    db.prepare("INSERT INTO settings(k,v) VALUES('free_countries',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(fc),
    db.prepare("INSERT INTO settings(k,v) VALUES('buy_text',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(text),
  ]);
  return json({ ok: true });
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
    allowed_updates: ["message", "callback_query"],
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
      if (p === "/api/me" && request.method === "GET") return await me(request, env);
      if (p === "/api/member/check" && request.method === "GET") return await memberCheck(request, env);
      if (p === "/api/admin/userlimit" && request.method === "POST") {
        const bad = adminOk(request, env); if (bad) return bad;
        return await adminUserLimit(request, env);
      }
      if (p === "/api/admin/ban" && request.method === "POST") {
        const bad = adminOk(request, env); if (bad) return bad;
        return await adminBan(request, env);
      }
      if (p === "/api/config/create" && request.method === "POST") return await createConfig(request, env);
      if (p === "/api/admin/sub" && request.method === "POST") {
        const bad = adminOk(request, env); if (bad) return bad;
        return await adminSub(request, env);
      }
      if (p === "/api/admin/settings" && request.method === "POST") {
        const bad = adminOk(request, env); if (bad) return bad;
        return await adminSettings(request, env);
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
        if (!(await isMember(env, await getDB(env), sess.tg_id))) return Response.redirect(url.origin + "/login.html?join=1", 302);
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
