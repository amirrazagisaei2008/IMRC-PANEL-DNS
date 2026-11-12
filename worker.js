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
        env.DB.prepare("CREATE TABLE IF NOT EXISTS users(tg_id TEXT PRIMARY KEY, created INTEGER, logged INTEGER DEFAULT 0)"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS receipts(
          id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, ts INTEGER, file_id TEXT,
          plan TEXT, amount INTEGER, code TEXT, status TEXT DEFAULT 'pending', decided INTEGER, decided_by TEXT)`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_receipts_tg ON receipts(tg_id, status)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS pending_buy(tg_id TEXT PRIMARY KEY, plan TEXT, code TEXT, ts INTEGER)"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS discount_codes(
          code TEXT PRIMARY KEY, percent INTEGER, max_uses INTEGER DEFAULT 0, used INTEGER DEFAULT 0,
          expires INTEGER, active INTEGER DEFAULT 1, created INTEGER)`),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS refs(invitee TEXT PRIMARY KEY, referrer TEXT, ts INTEGER, rewarded INTEGER DEFAULT 0)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_tokens(token TEXT PRIMARY KEY, created INTEGER, verified INTEGER DEFAULT 0)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_sessions(sid TEXT PRIMARY KEY, created INTEGER)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS auth_fails(k TEXT PRIMARY KEY, fails INTEGER, first INTEGER, locked_until INTEGER)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS reminders(tg_id TEXT PRIMARY KEY, until INTEGER)"),
        env.DB.prepare("CREATE TABLE IF NOT EXISTS cap_alerts(tg_id TEXT, period_start INTEGER, PRIMARY KEY(tg_id, period_start))"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS tickets(
          id INTEGER PRIMARY KEY AUTOINCREMENT, tg_id TEXT, name TEXT, username TEXT,
          status TEXT DEFAULT 'open', created INTEGER, updated INTEGER)`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tickets_tg ON tickets(tg_id, status)"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS ticket_msgs(
          id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER, sender TEXT, text TEXT, ts INTEGER, admin_msg_id INTEGER)`),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_ticket_msgs_t ON ticket_msgs(ticket_id)"),
        env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_ticket_msgs_admin ON ticket_msgs(admin_msg_id)"),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS broadcasts(
          id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, target TEXT, status TEXT,
          total INTEGER, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, cursor TEXT DEFAULT '',
          created INTEGER, finished INTEGER)`),
      ]);
      for (const col of ["tg_id", "tg_name", "tg_username"]) {
        try { await env.DB.prepare(`ALTER TABLE visitors ADD COLUMN ${col} TEXT`).run(); } catch (e) { /* already exists */ }
      }
      // یک‌بار: کاربرهای قبلی رو به جدول users منتقل کن (قبلاً واردشده حساب می‌شن → برای دعوت جایزه نمی‌گیرن)
      const bf = await env.DB.prepare("SELECT v FROM settings WHERE k='users_backfill'").first();
      if (!bf) {
        await env.DB.batch([
          env.DB.prepare("INSERT OR IGNORE INTO users(tg_id,created,logged) SELECT tg_id, first_seen, 1 FROM visitors WHERE tg_id IS NOT NULL AND tg_id<>''"),
          env.DB.prepare("INSERT OR IGNORE INTO users(tg_id,created,logged) SELECT tg_id, created, 1 FROM sessions WHERE tg_id IS NOT NULL"),
          env.DB.prepare("INSERT OR IGNORE INTO settings(k,v) VALUES('users_backfill','1')"),
        ]);
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
  if (changed) await onFirstLogin(env, db, tgId);
  await reply(changed ? "✅ وارد شدی! برگرد به مرورگر." : "⌛ این لینک ورود منقضی شده. دوباره از سایت امتحان کن.");
}

const PENDING_MS = 86400000; // انتخاب پلن/کد تا ۲۴ ساعت معتبره
const fa = (n) => Number(n || 0).toLocaleString("fa-IR");
const isAdmin = (env, id) => !!env.ADMIN_TG_ID && String(id) === String(env.ADMIN_TG_ID);
const MAIN_KB = {
  inline_keyboard: [
    [{ text: "💳 خرید اشتراک", callback_data: "menu:plans" }],
    [{ text: "🎁 دعوت دوستان", callback_data: "menu:invite" }],
    [{ text: "🎫 پشتیبانی", callback_data: "menu:support" }],
  ],
};
const SUPPORT_HELP = "🎫 پیامت رو همین‌جا بنویس تا برای پشتیبانی فرستاده بشه. جوابت رو همین‌جا می‌گیری.";
const WELCOME = "سلام 👋\n\n🔐 برای ورود به پنل، توی سایت روی «ورود با تلگرام» بزن.\n\n💳 /plans — خرید اشتراک\n🎟 /code کد — ثبت کد تخفیف\n🎁 /invite — دعوت دوستان (روز رایگان)\n🧾 بعد از پرداخت، عکس رسید رو همین‌جا بفرست.";

async function tgWebhook(request, env) {
  if (!env.TG_WEBHOOK_SECRET || !safeEq(request.headers.get("X-Telegram-Bot-Api-Secret-Token"), env.TG_WEBHOOK_SECRET))
    return new Response("forbidden", { status: 403 });
  let upd;
  try { upd = await request.json(); } catch { return new Response("ok"); }
  const db = await getDB(env);

  const cq = upd && upd.callback_query;
  if (cq && cq.from) {
    await touchUser(env, db, cq.from).catch(() => {});
    await handleCallback(env, db, cq).catch((e) => console.error("callback", e));
    return new Response("ok");
  }

  const msg = upd && upd.message;
  if (!msg || !msg.from || !msg.chat) return new Response("ok");
  if (msg.chat.type !== "private") return new Response("ok");
  await touchUser(env, db, msg.from).catch(() => {});
  try {
    if (msg.photo) await handleReceipt(env, db, msg);
    else await handleText(env, db, msg, String(msg.text || "").trim());
  } catch (e) { console.error("message", e); }
  return new Response("ok");
}

async function touchUser(env, db, from) {
  const r = await db.prepare("INSERT OR IGNORE INTO users(tg_id,created,logged) VALUES(?,?,0)").bind(String(from.id), Date.now()).run();
  if (r.meta && r.meta.changes && !isAdmin(env, from.id)) {
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
    await notifyAdmin(env, db, `👤 کاربر جدید در ربات: ${name || "-"}${from.username ? " (@" + from.username + ")" : ""}\n🆔 ${from.id}`);
  }
}

// اعلان به ادمین (اگه تو تنظیمات روشن باشه)
async function notifyAdmin(env, db, text) {
  if (!env.ADMIN_TG_ID) return;
  const st = await getSettings(db);
  if (!st.admin_notify) return;
  await tg(env, "sendMessage", { chat_id: env.ADMIN_TG_ID, text }).catch(() => {});
}

async function handleText(env, db, msg, text) {
  const chatId = msg.chat.id, from = msg.from, tgId = String(from.id);
  const reply = (t, extra = {}) => tg(env, "sendMessage", { chat_id: chatId, text: t, ...extra }).catch(() => {});
  // ادمین روی اعلان یک تیکت Reply کنه → پاسخ به کاربر
  if (isAdmin(env, from.id) && msg.reply_to_message && text && await adminReplyFromTelegram(env, db, msg, text)) return;
  let m = text.match(/^\/start\s+([a-f0-9]{24})$/);
  if (m) return verifyLogin(env, db, m[1], from, chatId);
  m = text.match(/^\/start\s+adm_([a-f0-9]{24})$/);
  if (m) return verifyAdminLogin(env, db, m[1], from, chatId);
  m = text.match(/^\/start\s+ref_(\d{3,20})$/);
  if (m) {
    await recordReferral(db, tgId, m[1]).catch(() => {});
    return reply(WELCOME, { reply_markup: MAIN_KB });
  }
  if (/^\/start(\s|$)/.test(text)) return reply(WELCOME, { reply_markup: MAIN_KB });
  if (/^\/plans(\s|$)/.test(text)) return sendPlans(env, db, chatId);
  if (/^\/invite(\s|$)/.test(text)) return sendInvite(env, db, chatId, tgId);
  m = text.match(/^\/code(?:\s+(\S+))?$/i);
  if (m) return applyCode(env, db, chatId, tgId, m[1] || "");
  if (/^\/support(\s|$)/.test(text)) return reply(SUPPORT_HELP);
  if (!text || text.startsWith("/")) return reply("برای شروع /start رو بفرست. 👇", { reply_markup: MAIN_KB });
  if (isAdmin(env, from.id)) return reply("برای پاسخ به یک تیکت، روی اعلان همون تیکت Reply کن یا از پنل استفاده کن.");
  return supportMessage(env, db, msg, text);
}

async function handleCallback(env, db, cq) {
  const answer = (text = "") => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  const data = String(cq.data || "");
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id;
  const chk = data.match(/^chk:([a-f0-9]{24})$/);
  if (chk) {
    await answer();
    return verifyLogin(env, db, chk[1], cq.from, cq.from.id);
  }
  if (data === "menu:plans") { await answer(); return sendPlans(env, db, chatId); }
  if (data === "menu:invite") { await answer(); return sendInvite(env, db, chatId, String(cq.from.id)); }
  if (data === "menu:support") { await answer(); return tg(env, "sendMessage", { chat_id: chatId, text: SUPPORT_HELP }).catch(() => {}); }
  const buy = data.match(/^buy:([a-z0-9_]{1,16})$/);
  if (buy) { await answer(); return choosePlan(env, db, chatId, String(cq.from.id), buy[1]); }
  const dec = data.match(/^(rc|rj):(\d{1,12})(?::([a-z0-9_]{1,16}))?$/);
  if (dec) return adminDecide(env, db, cq, dec[1], Number(dec[2]), dec[3] || "", answer);
  await answer();
}

async function verifyAdminLogin(env, db, token, from, chatId) {
  const reply = (t) => tg(env, "sendMessage", { chat_id: chatId, text: t }).catch(() => {});
  if (!isAdmin(env, from.id)) return reply("⛔ این لینک فقط برای ادمین پنله.");
  const res = await db.prepare("UPDATE admin_tokens SET verified=1 WHERE token=? AND verified=0 AND created>?")
    .bind(token, Date.now() - TOKEN_MS).run();
  return reply(res.meta && res.meta.changes ? "✅ ورود ادمین تأیید شد. به مرورگر برگرد." : "⌛ این لینک منقضی شده. دوباره از پنل امتحان کن.");
}

// اولین ورود به سایت: کاربر رو ثبت می‌کنه و اگه با لینک دعوت اومده، به دعوت‌کننده جایزه می‌ده
async function onFirstLogin(env, db, tgId) {
  await db.prepare("INSERT OR IGNORE INTO users(tg_id,created,logged) VALUES(?,?,0)").bind(tgId, Date.now()).run();
  const up = await db.prepare("UPDATE users SET logged=1 WHERE tg_id=? AND logged=0").bind(tgId).run();
  if (!(up.meta && up.meta.changes)) return;
  const ref = await db.prepare("SELECT referrer FROM refs WHERE invitee=? AND rewarded=0").bind(tgId).first();
  if (!ref) return;
  await db.prepare("UPDATE refs SET rewarded=1 WHERE invitee=?").bind(tgId).run();
  const st = await getSettings(db);
  const known = await db.prepare("SELECT 1 x FROM users WHERE tg_id=?").bind(ref.referrer).first();
  if (!known || st.ref_days <= 0) return;
  const until = await grantSub(db, ref.referrer, st.ref_days);
  const when = new Date(until).toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
  await tg(env, "sendMessage", {
    chat_id: ref.referrer,
    text: `🎁 یکی از دوستانت با لینکت وارد پنل شد! ${fa(st.ref_days)} روز اشتراک رایگان گرفتی.\nاعتبار اشتراکت تا ${when}`,
  }).catch(() => {});
}

async function recordReferral(db, invitee, referrer) {
  if (invitee === String(referrer)) return;
  const u = await db.prepare("SELECT logged FROM users WHERE tg_id=?").bind(invitee).first();
  if (u && u.logged) return; // قبلاً وارد پنل شده، دعوت حساب نمی‌شه
  await db.prepare("INSERT OR IGNORE INTO refs(invitee,referrer,ts,rewarded) VALUES(?,?,?,0)")
    .bind(invitee, String(referrer), Date.now()).run();
}

async function sendInvite(env, db, chatId, tgId) {
  const st = await getSettings(db);
  const bot = await botUsername(env);
  const cnt = (await db.prepare("SELECT COUNT(*) n FROM refs WHERE referrer=? AND rewarded=1").bind(String(tgId)).first()).n;
  const head = st.ref_days > 0
    ? `🎁 به ازای هر دوستی که با این لینک وارد پنل بشه، ${fa(st.ref_days)} روز اشتراک رایگان می‌گیری.`
    : "🎁 دعوت دوستان فعلاً فعال نیست.";
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: `${head}\n\n🔗 لینک تو:\nhttps://t.me/${bot}?start=ref_${tgId}\n\n👥 تا الان ${fa(cnt)} نفر دعوت کردی.`,
  }).catch(() => {});
}

async function sendPlans(env, db, chatId) {
  const st = await getSettings(db);
  const list = st.plans.map((p) => `• ${p.name} — ${fa(p.days)} روز: ${fa(p.price)} تومان`).join("\n");
  const kb = { inline_keyboard: st.plans.map((p) => [{ text: `${p.name} • ${fa(p.price)} تومان`, callback_data: "buy:" + p.key }]) };
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: `💳 پلن‌های اشتراک:\n\n${list}\n\n${st.pay_text}\n\nیکی از پلن‌ها رو انتخاب کن و بعد عکس رسید رو بفرست.`,
    reply_markup: kb,
  }).catch(() => {});
}

// کد تخفیف فعال (یا null)
async function activeCode(db, code) {
  if (!code) return null;
  const r = await db.prepare("SELECT code,percent,max_uses,used,expires,active FROM discount_codes WHERE code=?").bind(code).first();
  if (!r || !r.active || (r.expires && r.expires < Date.now()) || (r.max_uses > 0 && r.used >= r.max_uses)) return null;
  return r;
}
const priceAfter = (plan, row) => (row ? Math.round(plan.price * (100 - row.percent) / 100) : plan.price);
async function pendingCode(db, tgId) {
  const p = await db.prepare("SELECT code FROM pending_buy WHERE tg_id=? AND ts>?").bind(tgId, Date.now() - PENDING_MS).first();
  return p ? activeCode(db, p.code) : null;
}

async function choosePlan(env, db, chatId, tgId, key) {
  const reply = (t) => tg(env, "sendMessage", { chat_id: chatId, text: t }).catch(() => {});
  const st = await getSettings(db);
  const plan = st.plans.find((p) => p.key === key);
  if (!plan) return reply("این پلن دیگه وجود نداره. دوباره /plans رو بفرست.");
  await db.prepare("INSERT INTO pending_buy(tg_id,plan,code,ts) VALUES(?,?,NULL,?) ON CONFLICT(tg_id) DO UPDATE SET plan=excluded.plan, ts=excluded.ts")
    .bind(tgId, key, Date.now()).run();
  const row = await pendingCode(db, tgId);
  const price = priceAfter(plan, row);
  return reply(`✅ پلن «${plan.name}» (${fa(plan.days)} روز) انتخاب شد.\n💰 مبلغ: ${fa(price)} تومان${row ? ` (با کد ${row.code})` : ""}\n\n${st.pay_text}\n\nبعد از پرداخت، عکس رسید رو همین‌جا بفرست.`);
}

async function applyCode(env, db, chatId, tgId, raw) {
  const reply = (t) => tg(env, "sendMessage", { chat_id: chatId, text: t }).catch(() => {});
  const code = String(raw).toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32);
  if (!code) return reply("کد تخفیف رو بعد از /code بنویس. مثلاً: /code ABC123");
  const row = await activeCode(db, code);
  if (!row) return reply("❌ این کد معتبر نیست یا منقضی شده.");
  await db.prepare("INSERT INTO pending_buy(tg_id,plan,code,ts) VALUES(?,NULL,?,?) ON CONFLICT(tg_id) DO UPDATE SET code=excluded.code, ts=excluded.ts")
    .bind(tgId, code, Date.now()).run();
  return reply(`🎟 کد «${code}» ثبت شد: ${fa(row.percent)}٪ تخفیف.\nحالا پلن رو از /plans انتخاب کن و رسید رو بفرست.`);
}

// کاربر عکس رسید می‌فرسته → برای ادمین فوروارد با دکمه‌ی تأیید هر پلن
async function handleReceipt(env, db, msg) {
  const chatId = msg.chat.id, from = msg.from, tgId = String(from.id);
  const reply = (t) => tg(env, "sendMessage", { chat_id: chatId, text: t }).catch(() => {});
  if (!env.ADMIN_TG_ID) return reply("پشتیبانی فعلاً در دسترس نیست. کمی بعد دوباره امتحان کن.");
  if (await isBanned(db, tgId)) return reply("⛔ دسترسی تو به پنل مسدود شده.");
  const open = await db.prepare("SELECT COUNT(*) n FROM receipts WHERE tg_id=? AND status='pending'").bind(tgId).first();
  if (open.n >= 3) return reply("⏳ سه رسید قبلی‌ت هنوز بررسی نشدن. لطفاً صبر کن.");

  const st = await getSettings(db);
  const pend = await db.prepare("SELECT plan,code FROM pending_buy WHERE tg_id=? AND ts>?").bind(tgId, Date.now() - PENDING_MS).first();
  const plan = pend && pend.plan ? st.plans.find((p) => p.key === pend.plan) || null : null;
  const codeRow = await pendingCode(db, tgId);
  const amount = plan ? priceAfter(plan, codeRow) : null;
  const photo = msg.photo[msg.photo.length - 1];

  const ins = await db.prepare("INSERT INTO receipts(tg_id,ts,file_id,plan,amount,code,status) VALUES(?,?,?,?,?,?,'pending')")
    .bind(tgId, Date.now(), photo.file_id, plan ? plan.key : null, amount, codeRow ? codeRow.code : null).run();
  const id = ins.meta.last_row_id;
  await db.prepare("DELETE FROM pending_buy WHERE tg_id=?").bind(tgId).run();

  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const caption = `🧾 رسید #${id}\n👤 ${name || "-"}${from.username ? " (@" + from.username + ")" : ""}\n🆔 ${tgId}\n📦 پلن: ${plan ? `${plan.name} (${fa(plan.days)} روز)` : "انتخاب نشده"}\n💰 مبلغ: ${amount !== null ? fa(amount) + " تومان" : "—"}${codeRow ? "\n🎟 کد: " + codeRow.code : ""}\n\nیکی از پلن‌ها رو برای تأیید بزن:`;
  const kb = {
    inline_keyboard: [
      ...st.plans.map((p) => [{ text: `✅ تأیید ${p.name} (${fa(p.days)} روز)`, callback_data: `rc:${id}:${p.key}` }]),
      [{ text: "❌ رد", callback_data: `rj:${id}` }],
    ],
  };
  const r = await tg(env, "sendPhoto", { chat_id: env.ADMIN_TG_ID, photo: photo.file_id, caption, reply_markup: kb }).catch(() => ({ ok: false }));
  if (!r.ok) {
    await db.prepare("DELETE FROM receipts WHERE id=?").bind(id).run();
    return reply("⚠️ رسیدت ارسال نشد. چند دقیقه دیگه دوباره بفرست.");
  }
  return reply(`✅ رسیدت ثبت شد (#${id}).\nبعد از بررسی، اشتراکت فعال می‌شه و خبرش رو می‌گیری.`);
}

// ادمین روی دکمه‌ی زیر رسید می‌زنه
async function adminDecide(env, db, cq, action, id, planKey, answer) {
  if (!isAdmin(env, cq.from.id)) return answer("⛔ فقط ادمین می‌تونه این رو بزنه.");
  const rec = await db.prepare("SELECT * FROM receipts WHERE id=?").bind(id).first();
  if (!rec) return answer("رسید پیدا نشد.");
  if (rec.status !== "pending") return answer(`این رسید قبلاً بررسی شده (${rec.status}).`);
  const now = Date.now(), by = String(cq.from.id);

  if (action === "rj") {
    const res = await db.prepare("UPDATE receipts SET status='rejected', decided=?, decided_by=? WHERE id=? AND status='pending'").bind(now, by, id).run();
    if (!res.meta.changes) return answer("قبلاً بررسی شده.");
    await tg(env, "sendMessage", { chat_id: rec.tg_id, text: "❌ رسیدت تأیید نشد. اگه فکر می‌کنی اشتباهه، به @IMRC_support پیام بده." }).catch(() => {});
    await stampReceipt(env, cq, "❌ رد شد");
    return answer("رد شد.");
  }

  const st = await getSettings(db);
  const plan = st.plans.find((p) => p.key === planKey);
  if (!plan) return answer("پلن نامعتبره.");
  // مبلغ ثبت‌شده‌ی رسید فقط وقتی معتبره که همون پلنی باشه که ادمین تأیید می‌کنه؛ وگرنه قیمت پلن تأییدشده (با کد) حساب می‌شه
  const amount = rec.amount !== null && rec.plan === plan.key ? rec.amount : priceAfter(plan, await activeCode(db, rec.code));
  const res = await db.prepare("UPDATE receipts SET status='approved', plan=?, amount=?, decided=?, decided_by=? WHERE id=? AND status='pending'")
    .bind(plan.key, amount, now, by, id).run();
  if (!res.meta.changes) return answer("قبلاً بررسی شده.");
  if (rec.code) await db.prepare("UPDATE discount_codes SET used=used+1 WHERE code=? AND (max_uses=0 OR used<max_uses)").bind(rec.code).run();
  const until = await grantSub(db, rec.tg_id, plan.days);
  const when = new Date(until).toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
  await tg(env, "sendMessage", {
    chat_id: rec.tg_id,
    text: `⭐ پرداختت تأیید شد!\nپلن ${plan.name}: ${fa(plan.days)} روز اشتراک.\nاعتبار تا ${when}\n\nحالا برگرد به پنل و کانفیگ بساز.`,
  }).catch(() => {});
  await stampReceipt(env, cq, `✅ تأیید شد: ${plan.name} (${fa(plan.days)} روز)`);
  return answer("اشتراک فعال شد ✅");
}

// حذف دکمه‌ها از پیام ادمین و ثبت نتیجه روی همون پیام
async function stampReceipt(env, cq, note) {
  const m = cq.message;
  if (!m) return;
  await tg(env, "editMessageCaption", {
    chat_id: m.chat.id,
    message_id: m.message_id,
    caption: `${m.caption || ""}\n\n${note}`.slice(0, 1000),
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

/* ---------------- settings / quota ---------------- */
const DEFAULTS = {
  free_limit: "1",
  sub_limit: "20",
  free_countries: "tr,de,ae",
  buy_text: "سقف ساخت کانفیگ رایگان امروز تموم شد.\nبرای ساخت بیشتر، اشتراک تهیه کن:\n\n💳 از ربات تلگرام پلن رو انتخاب کن (/plans) و بعد از پرداخت، عکس رسید رو همان‌جا بفرست.",
  pay_text: "💳 شماره کارت: 6219 8614 9829 6879\n👤 به نام: امیر رزاقی ساعی (بانک سامان)",
  plans: "w|هفتگی|7|50000\nm|ماهانه|30|150000\nq|سه‌ماهه|90|400000",
  ref_days: "2",
  remind_days: "3",
  admin_notify: "1",
  status_level: "ok",
  status_note: "",
};
const STATUS_LEVELS = new Set(["ok", "degraded", "down"]);
const PLAN_KEY = /^[a-z0-9_]{1,16}$/;
// هر خط: کلید|نام|روز|قیمت(تومان)
function parsePlans(text) {
  const out = [];
  for (const line of String(text || "").split(/\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split("|").map((s) => s.trim());
    if (parts.length !== 4) throw new Error("هر پلن باید به شکل کلید|نام|روز|قیمت باشه");
    const [key, name, days, price] = parts;
    const d = parseInt(days), p = parseInt(price);
    if (!PLAN_KEY.test(key)) throw new Error(`کلید پلن «${key}» نامعتبره (فقط حروف انگلیسی کوچک، عدد و _)`);
    if (!name || name.length > 30) throw new Error(`نام پلن «${key}» نامعتبره`);
    if (!(d >= 1 && d <= 3650)) throw new Error(`تعداد روز پلن «${key}» باید بین ۱ تا ۳۶۵۰ باشه`);
    if (!(p >= 0 && p <= 100000000)) throw new Error(`قیمت پلن «${key}» نامعتبره`);
    if (out.some((x) => x.key === key)) throw new Error(`کلید تکراری: ${key}`);
    out.push({ key, name: name.replace(/[<>]/g, ""), days: d, price: p });
  }
  if (!out.length || out.length > 6) throw new Error("بین ۱ تا ۶ پلن لازمه");
  return out;
}
const plansToText = (plans) => plans.map((p) => `${p.key}|${p.name}|${p.days}|${p.price}`).join("\n");
async function getSettings(db) {
  const rows = (await db.prepare("SELECT k,v FROM settings").all()).results || [];
  const o = { ...DEFAULTS };
  for (const r of rows) if (r.k in DEFAULTS) o[r.k] = r.v;
  let plans;
  try { plans = parsePlans(o.plans); } catch (e) { plans = parsePlans(DEFAULTS.plans); }
  return {
    free_limit: Math.max(0, parseInt(o.free_limit) || 0),
    sub_limit: Math.max(0, parseInt(o.sub_limit) || 0),
    free_countries: String(o.free_countries).toLowerCase().replace(/[^a-z,]/g, ""),
    buy_text: String(o.buy_text),
    pay_text: String(o.pay_text),
    ref_days: Math.min(365, Math.max(0, parseInt(o.ref_days) || 0)),
    remind_days: Math.min(30, Math.max(0, parseInt(o.remind_days) || 0)),
    admin_notify: o.admin_notify !== "0",
    status_level: STATUS_LEVELS.has(o.status_level) ? o.status_level : "ok",
    status_note: String(o.status_note || "").slice(0, 200),
    plans,
    plans_text: plansToText(plans),
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

// وقتی کاربر به سقف می‌رسه، ادمین یک بار در هر دوره خبر می‌گیره
async function capAlert(env, db, sess, q) {
  const r = await db.prepare("INSERT OR IGNORE INTO cap_alerts(tg_id,period_start) VALUES(?,?)").bind(String(sess.tg_id), q.periodStart).run();
  if (!(r.meta && r.meta.changes)) return;
  const who = sess.name || (sess.username ? "@" + sess.username : String(sess.tg_id));
  await notifyAdmin(env, db, `🚧 ${who} (${sess.tg_id}) به سقف ${fa(q.limit)} کانفیگ در ${PERIODS[q.period]} رسید.`);
}

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
  if (!ok) {
    await capAlert(env, db, sess, q).catch(() => {});
    return json({ error: "limit", message: q.buy_text, used: q.used, limit: q.limit, period: q.period, sub: q.sub, custom: q.custom, unlock: q.unlock }, 429);
  }

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
const ADMIN_SESSION_MS = 7 * 86400000;
const LOCK_IP = { max: 5, win: 15 * 60000, lock: 15 * 60000 };          // ۵ رمز اشتباه از یک IP → ۱۵ دقیقه قفل
const LOCK_GLOBAL = { max: 30, win: 60 * 60000, lock: 30 * 60000 };    // ۳۰ اشتباه کل در ساعت → ۳۰ دقیقه قفل رمز برای همه

async function lockedUntil(db, keys) {
  const now = Date.now();
  let until = 0;
  for (const k of keys) {
    const r = await db.prepare("SELECT locked_until FROM auth_fails WHERE k=?").bind(k).first();
    if (r && r.locked_until > now) until = Math.max(until, r.locked_until);
  }
  return until;
}
async function bumpFail(db, k, o) {
  const now = Date.now();
  const r = await db.prepare("SELECT fails,first FROM auth_fails WHERE k=?").bind(k).first();
  let fails = 1, first = now;
  if (r && now - r.first < o.win) { fails = r.fails + 1; first = r.first; }
  let locked = 0;
  if (fails >= o.max) { locked = now + o.lock; fails = 0; first = now; }
  await db.prepare("INSERT INTO auth_fails(k,fails,first,locked_until) VALUES(?,?,?,?) ON CONFLICT(k) DO UPDATE SET fails=excluded.fails, first=excluded.first, locked_until=excluded.locked_until")
    .bind(k, fails, first, locked).run();
}

// ورود ادمین: کوکی نشست (از تلگرام) یا Bearer با رمز. رمز اشتباه قفل می‌شه.
async function adminAuth(request, env) {
  if (!env.ADMIN_PASSWORD && !env.ADMIN_TG_ID) return json({ error: "ADMIN_PASSWORD یا ADMIN_TG_ID تنظیم نشده" }, 500);
  const db = await getDB(env);
  const sid = cookie(request, "imrc_admin");
  if (/^[a-f0-9]{32}$/.test(sid)) {
    const row = await db.prepare("SELECT created FROM admin_sessions WHERE sid=?").bind(sid).first();
    if (row && Date.now() - row.created < ADMIN_SESSION_MS) return null;
  }
  const auth = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!env.ADMIN_PASSWORD || !auth) return json({ error: "login" }, 401);
  const ipKey = "ip:" + (await sha(request.headers.get("CF-Connecting-IP") || "none"));
  const until = await lockedUntil(db, [ipKey, "global"]);
  if (until) {
    const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return json({ error: `به‌خاطر تلاش‌های زیاد قفل شده. ${fa(mins)} دقیقه دیگه امتحان کن.`, locked: true }, 429);
  }
  if (safeEq(auth, env.ADMIN_PASSWORD)) {
    await db.prepare("DELETE FROM auth_fails WHERE k=?").bind(ipKey).run();
    return null;
  }
  await bumpFail(db, ipKey, LOCK_IP);
  await bumpFail(db, "global", LOCK_GLOBAL);
  return json({ error: "رمز اشتباه است" }, 401);
}

// ورود ادمین با تلگرام
async function adminTgStart(env) {
  if (!env.ADMIN_TG_ID || !env.BOT_TOKEN) return json({ error: "ADMIN_TG_ID یا BOT_TOKEN تنظیم نشده" }, 500);
  const db = await getDB(env);
  const now = Date.now(), token = randHex(12);
  await db.batch([
    db.prepare("DELETE FROM admin_tokens WHERE created<?").bind(now - 3600000),
    db.prepare("INSERT INTO admin_tokens(token,created,verified) VALUES(?,?,0)").bind(token, now),
  ]);
  const bot = await botUsername(env);
  return json({ token, url: `https://t.me/${bot}?start=adm_${token}` });
}

async function adminTgCheck(env, url) {
  const token = url.searchParams.get("token") || "";
  if (!/^[a-f0-9]{24}$/.test(token)) return json({ status: "expired" });
  const db = await getDB(env);
  const now = Date.now();
  const row = await db.prepare("SELECT created,verified FROM admin_tokens WHERE token=?").bind(token).first();
  if (!row || now - row.created > TOKEN_MS) return json({ status: "expired" });
  if (!row.verified) return json({ status: "pending" });
  const sid = randHex(16);
  await db.batch([
    db.prepare("INSERT INTO admin_sessions(sid,created) VALUES(?,?)").bind(sid, now),
    db.prepare("DELETE FROM admin_sessions WHERE created<?").bind(now - ADMIN_SESSION_MS),
    db.prepare("DELETE FROM admin_tokens WHERE token=?").bind(token),
  ]);
  return json({ status: "ok" }, 200, {
    "Set-Cookie": `imrc_admin=${sid}; Path=/; Max-Age=${ADMIN_SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict`,
  });
}

async function adminLogout(request, env) {
  const sid = cookie(request, "imrc_admin");
  if (/^[a-f0-9]{32}$/.test(sid)) {
    const db = await getDB(env);
    await db.prepare("DELETE FROM admin_sessions WHERE sid=?").bind(sid).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": "imrc_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
}

async function adminCodes(request, env) {
  const db = await getDB(env);
  if (request.method === "GET") {
    const r = await db.prepare("SELECT code,percent,max_uses,used,expires,active,created FROM discount_codes ORDER BY created DESC LIMIT 200").all();
    return json({ codes: r.results || [] });
  }
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return json({ error: "کد باید ۳ تا ۳۲ کاراکتر انگلیسی یا عدد باشه" }, 400);
  if (b.disable !== undefined) {
    await db.prepare("UPDATE discount_codes SET active=? WHERE code=?").bind(b.disable ? 0 : 1, code).run();
    return json({ ok: true });
  }
  const pct = parseInt(b.percent), max = parseInt(b.max_uses) || 0, days = parseInt(b.days) || 0;
  if (!(pct >= 1 && pct <= 100)) return json({ error: "درصد تخفیف باید بین ۱ تا ۱۰۰ باشه" }, 400);
  if (!(max >= 0 && max <= 100000) || !(days >= 0 && days <= 3650)) return json({ error: "مقادیر نامعتبره" }, 400);
  const exp = days ? Date.now() + days * 86400000 : null;
  try {
    await db.prepare("INSERT INTO discount_codes(code,percent,max_uses,used,expires,active,created) VALUES(?,?,?,0,?,1,?)")
      .bind(code, pct, max, exp, Date.now()).run();
  } catch { return json({ error: "این کد قبلاً ساخته شده" }, 409); }
  return json({ ok: true, code });
}

// افزودن روز اشتراک (اگر از قبل اشتراک داره، روی تاریخ فعلی اضافه می‌شه)
async function grantSub(db, tgId, days) {
  const now = Date.now();
  const cur = await db.prepare("SELECT until FROM subs WHERE tg_id=?").bind(String(tgId)).first();
  const until = Math.max(now, (cur && cur.until) || 0) + days * 86400000;
  await db.prepare("INSERT INTO subs(tg_id,until) VALUES(?,?) ON CONFLICT(tg_id) DO UPDATE SET until=excluded.until")
    .bind(String(tgId), until).run();
  return until;
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
  if (days === 0) {
    await db.prepare("DELETE FROM subs WHERE tg_id=?").bind(tgId).run();
    return json({ ok: true, until: null });
  }
  const until = await grantSub(db, tgId, days);
  if (env.BOT_TOKEN) {
    const when = new Date(until).toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
    await tg(env, "sendMessage", { chat_id: tgId, text: `⭐ اشتراکت فعال شد.\nتا تاریخ ${when} می‌تونی روزانه تا ${(await getSettings(db)).sub_limit} کانفیگ بسازی.` }).catch(() => {});
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
  const fl = parseInt(b.free_limit), sl = parseInt(b.sub_limit), rd = parseInt(b.ref_days);
  if (!(fl >= 0 && fl <= 1000) || !(sl >= 0 && sl <= 1000)) return json({ error: "سقف باید بین ۰ تا ۱۰۰۰ باشد" }, 400);
  if (!(rd >= 0 && rd <= 365)) return json({ error: "روز جایزه‌ی دعوت باید بین ۰ تا ۳۶۵ باشه" }, 400);
  const fc = String(b.free_countries || "").toLowerCase().replace(/[^a-z,]/g, "").replace(/,+/g, ",").replace(/^,|,$/g, "");
  if (!/^[a-z]{2}(,[a-z]{2})*$/.test(fc)) return json({ error: "کشورهای رایگان باید کد دو حرفی و با ویرگول جدا باشد (مثل tr,de,ae)" }, 400);
  const text = String(b.buy_text || "").replace(/[\u0000-\u0008]/g, "").trim().slice(0, 400) || DEFAULTS.buy_text;
  const payText = String(b.pay_text || "").replace(/[\u0000-\u0008]/g, "").trim().slice(0, 400) || DEFAULTS.pay_text;
  let plans;
  try { plans = parsePlans(String(b.plans || "")); } catch (e) { return json({ error: e.message }, 400); }
  const remind = parseInt(b.remind_days);
  if (!(remind >= 0 && remind <= 30)) return json({ error: "یادآوری باید بین ۰ تا ۳۰ روز باشه" }, 400);
  const stLevel = String(b.status_level || "ok");
  if (!STATUS_LEVELS.has(stLevel)) return json({ error: "وضعیت سرویس نامعتبره" }, 400);
  const stNote = String(b.status_note || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 200);
  const db = await getDB(env);
  const up = (k, v) => db.prepare("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, v);
  await db.batch([
    up("free_limit", String(fl)),
    up("sub_limit", String(sl)),
    up("free_countries", fc),
    up("buy_text", text),
    up("plans", plansToText(plans)),
    up("pay_text", payText),
    up("ref_days", String(rd)),
    up("remind_days", String(remind)),
    up("admin_notify", b.admin_notify ? "1" : "0"),
    up("status_level", stLevel),
    up("status_note", stNote),
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

/* ---------------- پشتیبانی (تیکت) ---------------- */
const TICKET_RATE = { max: 5, win: 600000 }; // حداکثر ۵ پیام در ۱۰ دقیقه از هر کاربر

async function supportMessage(env, db, msg, text) {
  const chatId = msg.chat.id, from = msg.from, tgId = String(from.id);
  const reply = (t) => tg(env, "sendMessage", { chat_id: chatId, text: t }).catch(() => {});
  if (text.length > 1000) return reply("پیامت خیلی طولانیه (حداکثر ۱۰۰۰ کاراکتر).");
  if (!env.ADMIN_TG_ID) return reply("پشتیبانی فعلاً در دسترس نیست.");
  if (await isBanned(db, tgId)) return reply("⛔ دسترسی تو مسدود شده.");
  const recent = await db.prepare(
    "SELECT COUNT(*) n FROM ticket_msgs m JOIN tickets t ON t.id=m.ticket_id WHERE t.tg_id=? AND m.sender='user' AND m.ts>?"
  ).bind(tgId, Date.now() - TICKET_RATE.win).first();
  if (recent.n >= TICKET_RATE.max) return reply("⏳ پیام‌های زیادی فرستادی. چند دقیقه دیگه دوباره بفرست.");

  const now = Date.now();
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  let t = await db.prepare("SELECT id FROM tickets WHERE tg_id=? AND status='open' ORDER BY id DESC LIMIT 1").bind(tgId).first();
  if (!t) {
    const r = await db.prepare("INSERT INTO tickets(tg_id,name,username,status,created,updated) VALUES(?,?,?,'open',?,?)")
      .bind(tgId, name, from.username || "", now, now).run();
    t = { id: r.meta.last_row_id };
  }
  const mr = await db.prepare("INSERT INTO ticket_msgs(ticket_id,sender,text,ts) VALUES(?,?,?,?)").bind(t.id, "user", text, now).run();
  await db.prepare("UPDATE tickets SET updated=? WHERE id=?").bind(now, t.id).run();

  const cap = `🎫 تیکت #${t.id} — ${name || "-"}${from.username ? " (@" + from.username + ")" : ""}\n🆔 ${tgId}\n\n${text}\n\nبرای پاسخ، روی همین پیام Reply کن یا از پنل پاسخ بده.`;
  const sent = await tg(env, "sendMessage", { chat_id: env.ADMIN_TG_ID, text: cap }).catch(() => ({ ok: false }));
  if (sent.ok) await db.prepare("UPDATE ticket_msgs SET admin_msg_id=? WHERE id=?").bind(sent.result.message_id, mr.meta.last_row_id).run();
  return reply(`✅ پیامت برای پشتیبانی ثبت شد (تیکت #${t.id}). به‌زودی جواب می‌گیری.`);
}

// پاسخ ادمین (از پنل یا Reply تلگرام) → ارسال به کاربر
async function ticketReply(env, db, id, text) {
  const t = await db.prepare("SELECT id,tg_id FROM tickets WHERE id=?").bind(id).first();
  if (!t) return { error: "تیکت پیدا نشد", status: 404 };
  const now = Date.now();
  await db.prepare("INSERT INTO ticket_msgs(ticket_id,sender,text,ts) VALUES(?,?,?,?)").bind(id, "admin", text, now).run();
  await db.prepare("UPDATE tickets SET status='open', updated=? WHERE id=?").bind(now, id).run();
  const r = await tg(env, "sendMessage", { chat_id: t.tg_id, text: `💬 پاسخ پشتیبانی (تیکت #${id}):\n\n${text}` }).catch(() => ({ ok: false }));
  return { ok: true, delivered: !!r.ok };
}

async function adminReplyFromTelegram(env, db, msg, text) {
  const row = await db.prepare("SELECT ticket_id FROM ticket_msgs WHERE admin_msg_id=? AND sender='user'").bind(msg.reply_to_message.message_id).first();
  if (!row) return false;
  const res = await ticketReply(env, db, row.ticket_id, text.slice(0, 3500));
  await tg(env, "sendMessage", {
    chat_id: msg.chat.id,
    text: res.delivered ? `✅ پاسخ برای تیکت #${row.ticket_id} فرستاده شد.` : `⚠️ پاسخ ذخیره شد ولی به کاربر نرسید (احتمالاً ربات رو بلاک کرده).`,
  }).catch(() => {});
  return true;
}

async function adminTickets(env, url) {
  const db = await getDB(env);
  const status = url.searchParams.get("status") === "closed" ? "closed" : "open";
  const r = await db.prepare(`SELECT t.id,t.tg_id,t.name,t.username,t.status,t.updated,
      (SELECT text FROM ticket_msgs m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) last,
      (SELECT sender FROM ticket_msgs m WHERE m.ticket_id=t.id ORDER BY m.id DESC LIMIT 1) last_sender
    FROM tickets t WHERE t.status=? ORDER BY t.updated DESC LIMIT 100`).bind(status).all();
  return json({ tickets: r.results || [] });
}

async function adminTicket(request, env, url) {
  const db = await getDB(env);
  if (request.method === "GET") {
    const id = parseInt(url.searchParams.get("id"));
    if (!(id > 0)) return json({ error: "bad" }, 400);
    const t = await db.prepare("SELECT id,tg_id,name,username,status,updated FROM tickets WHERE id=?").bind(id).first();
    if (!t) return json({ error: "تیکت پیدا نشد" }, 404);
    const msgs = await db.prepare("SELECT sender,text,ts FROM ticket_msgs WHERE ticket_id=? ORDER BY id").bind(id).all();
    return json({ ticket: t, messages: msgs.results || [] });
  }
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  const id = parseInt(b.id);
  if (!(id > 0)) return json({ error: "bad" }, 400);
  if (b.action === "close") {
    await db.prepare("UPDATE tickets SET status='closed', updated=? WHERE id=?").bind(Date.now(), id).run();
    return json({ ok: true });
  }
  if (b.action === "reply") {
    const text = String(b.text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (!text || text.length > 3500) return json({ error: "متن پاسخ باید بین ۱ تا ۳۵۰۰ کاراکتر باشه" }, 400);
    const res = await ticketReply(env, db, id, text);
    if (res.error) return json({ error: res.error }, res.status);
    return json({ ok: true, delivered: res.delivered });
  }
  return json({ error: "عملیات نامعتبر" }, 400);
}

/* ---------------- یادآوری انقضا (Cron) ---------------- */
const REMIND_BATCH = 15;
async function runReminders(env) {
  if (!env.BOT_TOKEN) return;
  const db = await getDB(env);
  const st = await getSettings(db);
  if (st.remind_days <= 0) return;
  const now = Date.now();
  const rows = (await db.prepare(
    `SELECT s.tg_id, s.until FROM subs s LEFT JOIN reminders r ON r.tg_id=s.tg_id
     WHERE s.until>? AND s.until<=? AND (r.until IS NULL OR r.until<>s.until)
       AND s.tg_id NOT IN (SELECT tg_id FROM bans)
     ORDER BY s.until LIMIT ?`
  ).bind(now, now + st.remind_days * 86400000, REMIND_BATCH).all()).results || [];
  for (const r of rows) {
    const days = Math.max(1, Math.ceil((r.until - now) / 86400000));
    const when = new Date(r.until).toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" });
    const res = await tg(env, "sendMessage", {
      chat_id: r.tg_id,
      text: `⏰ اشتراکت ${fa(days)} روز دیگه تموم می‌شه (تا ${when}).\nبرای تمدید، /plans رو بفرست.`,
    }).catch(() => ({ ok: false }));
    if (res.error_code === 429) break;
    // موفق یا کاربر بلاکمون کرده → دیگه تکرار نشه
    if (res.ok || res.error_code === 403) {
      await db.prepare("INSERT INTO reminders(tg_id,until) VALUES(?,?) ON CONFLICT(tg_id) DO UPDATE SET until=excluded.until")
        .bind(r.tg_id, r.until).run();
    }
  }
}

/* ---------------- پیام همگانی (Cron) ---------------- */
const BROADCAST_BATCH = 15;
const BC_TARGETS = ["all", "sub", "free"];
// گیرنده‌ها: همه‌ی کاربرهای ربات / فقط دارای اشتراک / فقط بدون اشتراک (ادمین و بن‌شده‌ها حذف)
function audience(target, now, adminId) {
  let sql = "tg_id<>? AND tg_id NOT IN (SELECT tg_id FROM bans)";
  const p = [String(adminId || "")];
  if (target === "sub") { sql += " AND tg_id IN (SELECT tg_id FROM subs WHERE until>?)"; p.push(now); }
  if (target === "free") { sql += " AND tg_id NOT IN (SELECT tg_id FROM subs WHERE until>?)"; p.push(now); }
  return { sql, p };
}

async function runBroadcasts(env) {
  if (!env.BOT_TOKEN) return;
  const db = await getDB(env);
  const bc = await db.prepare("SELECT * FROM broadcasts WHERE status='running' ORDER BY id LIMIT 1").first();
  if (!bc) return;
  const a = audience(bc.target, Date.now(), env.ADMIN_TG_ID);
  const rows = (await db.prepare(`SELECT tg_id FROM users WHERE ${a.sql} AND tg_id>? ORDER BY tg_id LIMIT ?`)
    .bind(...a.p, bc.cursor || "", BROADCAST_BATCH).all()).results || [];
  if (!rows.length) {
    await db.prepare("UPDATE broadcasts SET status='done', finished=? WHERE id=?").bind(Date.now(), bc.id).run();
    const d = await db.prepare("SELECT sent,failed FROM broadcasts WHERE id=?").bind(bc.id).first();
    await notifyAdmin(env, db, `📣 پیام همگانی #${bc.id} تموم شد.\n✅ ارسال شد: ${fa(d.sent)}\n❌ ناموفق: ${fa(d.failed)}`);
    return;
  }
  let sent = 0, failed = 0, cursor = bc.cursor || "";
  for (const r of rows) {
    const res = await tg(env, "sendMessage", { chat_id: r.tg_id, text: bc.text }).catch(() => ({ ok: false }));
    if (res.ok) sent++;
    else if (res.error_code === 429) break; // محدودیت تلگرام: دفعه‌ی بعد از همین‌جا ادامه می‌ده
    else failed++;
    cursor = r.tg_id;
  }
  await db.prepare("UPDATE broadcasts SET sent=sent+?, failed=failed+?, cursor=? WHERE id=?").bind(sent, failed, cursor, bc.id).run();
}

async function adminBroadcasts(request, env) {
  const db = await getDB(env);
  if (request.method === "GET") {
    const r = await db.prepare("SELECT id,text,target,status,total,sent,failed,created,finished FROM broadcasts ORDER BY id DESC LIMIT 20").all();
    return json({ broadcasts: r.results || [] });
  }
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad" }, 400); }
  if (b.cancel) {
    await db.prepare("UPDATE broadcasts SET status='cancelled', finished=? WHERE id=? AND status='running'").bind(Date.now(), parseInt(b.id) || 0).run();
    return json({ ok: true });
  }
  const text = String(b.text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (!text || text.length > 3500) return json({ error: "متن باید بین ۱ تا ۳۵۰۰ کاراکتر باشه" }, 400);
  if (!BC_TARGETS.includes(b.target)) return json({ error: "گروه گیرنده نامعتبره" }, 400);
  const now = Date.now();
  const a = audience(b.target, now, env.ADMIN_TG_ID);
  const cnt = await db.prepare(`SELECT COUNT(*) n FROM users WHERE ${a.sql}`).bind(...a.p).first();
  if (!cnt.n) return json({ error: "هیچ گیرنده‌ای برای این گروه نیست" }, 400);
  const res = await db.prepare("INSERT INTO broadcasts(text,target,status,total,sent,failed,cursor,created) VALUES(?,?, 'running',?,0,0,'',?)")
    .bind(text, b.target, cnt.n, now).run();
  return json({ ok: true, id: res.meta.last_row_id, total: cnt.n });
}

/* ---------------- گزارش، کاربران، خروجی (فاز ۳) ---------------- */
const USER_PAGE = 50;
const USER_FILTERS = ["all", "sub", "expired", "never", "banned", "new7", "inactive30"];
const USER_COLS = `v.vid,v.first_seen,v.last_seen,v.country,v.city,v.device,v.visits,v.configs,v.actions,v.last_name,v.tg_id,v.tg_name,v.tg_username,s.until sub_until,b.tg_id banned,ul.lim ul_lim,ul.period ul_period,ul.unlock ul_unlock,ul.until ul_until`;
const USER_FROM = "FROM visitors v LEFT JOIN subs s ON s.tg_id=v.tg_id LEFT JOIN bans b ON b.tg_id=v.tg_id LEFT JOIN user_limits ul ON ul.tg_id=v.tg_id";
const userStatus = (r, now) => (r.banned ? "مسدود" : r.sub_until > now ? "اشتراک فعال" : r.sub_until ? "منقضی" : "رایگان");
const fmtDate = (ms) => (ms ? new Date(ms + TEHRAN).toISOString().slice(0, 16).replace("T", " ") : "");

// فیلتر + جستجو. q بدون % و _ (تا LIKE بی‌اثر بشه)
function userWhere(url, now) {
  const f = url.searchParams.get("filter");
  const filter = USER_FILTERS.includes(f) ? f : "all";
  const q = String(url.searchParams.get("q") || "").replace(/[%_\\]/g, "").trim().slice(0, 40);
  const like = q ? `%${q}%` : "";
  let cond = { sql: "1=1", p: [] };
  if (filter === "sub") cond = { sql: "s.until > ?", p: [now] };
  if (filter === "expired") cond = { sql: "s.until IS NOT NULL AND s.until <= ?", p: [now] };
  if (filter === "never") cond = { sql: "s.until IS NULL", p: [] };
  if (filter === "banned") cond = { sql: "b.tg_id IS NOT NULL", p: [] };
  if (filter === "new7") cond = { sql: "v.first_seen >= ?", p: [now - 7 * 86400000] };
  if (filter === "inactive30") cond = { sql: "v.last_seen < ?", p: [now - 30 * 86400000] };
  return {
    sql: `${cond.sql} AND (? = '' OR v.tg_name LIKE ? OR v.tg_username LIKE ? OR v.last_name LIKE ? OR v.tg_id LIKE ? OR v.city LIKE ?)`,
    p: [...cond.p, q, like, like, like, like, like],
  };
}

async function adminUsers(env, url) {
  const db = await getDB(env);
  const now = Date.now();
  const w = userWhere(url, now);
  const page = Math.max(0, parseInt(url.searchParams.get("page")) || 0);
  const total = (await db.prepare(`SELECT COUNT(*) n ${USER_FROM} WHERE ${w.sql}`).bind(...w.p).first()).n;
  const rows = (await db.prepare(`SELECT ${USER_COLS} ${USER_FROM} WHERE ${w.sql} ORDER BY v.last_seen DESC LIMIT ? OFFSET ?`)
    .bind(...w.p, USER_PAGE, page * USER_PAGE).all()).results || [];
  return json({
    users: rows.map((r) => ({ ...r, status: userStatus(r, now) })),
    total, page, pages: Math.max(1, Math.ceil(total / USER_PAGE)),
  });
}

// ---- گزارش درآمد: روزها و ماه‌های شمسی به وقت تهران ----
const JFMT = new Intl.DateTimeFormat("en-u-ca-persian", { year: "numeric", month: "numeric", timeZone: "UTC" });
const JLABEL = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "long", timeZone: "UTC" });
const DLABEL = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { day: "numeric", month: "short", timeZone: "UTC" });
const dayDate = (d) => new Date(d * 86400000 + 12 * 3600000); // ظهر همون روز تهران (بی‌خطر از مرز تاریخ)
const jKey = (d) => {
  const p = JFMT.formatToParts(dayDate(d));
  return Number(p.find((x) => x.type === "year").value) * 100 + Number(p.find((x) => x.type === "month").value);
};

async function buildReport(db, now) {
  const today = Math.floor((now + TEHRAN) / 86400000);
  const from = (today - 400) * 86400000 - TEHRAN;
  const P = (q, ...b) => db.prepare(q).bind(...b);
  const [rev, rej, cfg, usr, tot] = await db.batch([
    P("SELECT CAST((decided+?)/86400000 AS INTEGER) d, COALESCE(SUM(amount),0) a, COUNT(*) n FROM receipts WHERE status='approved' AND decided>=? GROUP BY d", TEHRAN, from),
    P("SELECT CAST((decided+?)/86400000 AS INTEGER) d, COUNT(*) n FROM receipts WHERE status='rejected' AND decided>=? GROUP BY d", TEHRAN, from),
    P("SELECT CAST((ts+?)/86400000 AS INTEGER) d, COUNT(*) n FROM config_log WHERE ts>=? GROUP BY d", TEHRAN, from),
    P("SELECT CAST((created+?)/86400000 AS INTEGER) d, COUNT(*) n FROM users WHERE created>=? GROUP BY d", TEHRAN, from),
    P("SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM receipts WHERE status='approved'"),
  ]);
  const day = {};
  const at = (d) => (day[d] ||= { amount: 0, n: 0, rej: 0, cfg: 0, usr: 0 });
  for (const r of rev.results) { const x = at(r.d); x.amount = r.a; x.n = r.n; }
  for (const r of rej.results) at(r.d).rej = r.n;
  for (const r of cfg.results) at(r.d).cfg = r.n;
  for (const r of usr.results) at(r.d).usr = r.n;

  const daily = [];
  for (let d = today - 29; d <= today; d++) {
    const x = at(d);
    daily.push({ d, label: DLABEL.format(dayDate(d)), amount: x.amount, n: x.n });
  }
  const months = new Map();
  for (let d = today - 400; d <= today; d++) {
    const k = jKey(d);
    if (!months.has(k)) months.set(k, { key: k, label: JLABEL.format(dayDate(d)), amount: 0, n: 0, rej: 0, cfg: 0, usr: 0 });
    const m = months.get(k), x = day[d];
    if (x) { m.amount += x.amount; m.n += x.n; m.rej += x.rej; m.cfg += x.cfg; m.usr += x.usr; }
  }
  const monthly = [...months.values()].slice(-12).reverse();
  const cur = monthly[0];
  const t = day[today] || { amount: 0, n: 0 };
  return {
    daily, monthly,
    today: { amount: t.amount, n: t.n },
    month: { amount: cur.amount, n: cur.n },
    total: { amount: tot.results[0].a, n: tot.results[0].n },
  };
}

// ---- خروجی CSV (با BOM تا اکسل فارسی رو درست باز کنه) ----
function csvResponse(name, headers, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return String(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // جلوگیری از اجرای فرمول توسط اکسل
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = "\uFEFF" + [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function adminExport(env, url) {
  const type = url.searchParams.get("type");
  const db = await getDB(env);
  const now = Date.now();
  const stamp = new Date(now + TEHRAN).toISOString().slice(0, 10);
  if (type === "users") {
    const w = userWhere(url, now);
    const rows = (await db.prepare(`SELECT ${USER_COLS} ${USER_FROM} WHERE ${w.sql} ORDER BY v.last_seen DESC LIMIT 20000`).bind(...w.p).all()).results || [];
    return csvResponse(`users-${stamp}.csv`,
      ["آیدی تلگرام", "نام", "یوزرنیم", "کشور", "شهر", "دستگاه", "اولین بازدید", "آخرین فعالیت", "تعداد کانفیگ", "وضعیت اشتراک", "اشتراک تا", "سقف اختصاصی"],
      rows.map((r) => [
        r.tg_id, r.tg_name || r.last_name || "", r.tg_username || "", r.country, r.city, r.device,
        fmtDate(r.first_seen), fmtDate(r.last_seen), r.configs, userStatus(r, now),
        r.sub_until ? fmtDate(r.sub_until) : "",
        r.ul_lim != null && (!r.ul_until || r.ul_until > now) ? `${r.ul_lim} در ${PERIODS[r.ul_period] || ""}` : "",
      ]));
  }
  if (type === "receipts") {
    const rows = (await db.prepare(`SELECT r.id, r.tg_id, r.ts, r.decided, r.plan, r.amount, r.code, r.status, r.decided_by, v.tg_name
      FROM receipts r LEFT JOIN visitors v ON v.tg_id=r.tg_id ORDER BY r.id DESC LIMIT 20000`).all()).results || [];
    return csvResponse(`receipts-${stamp}.csv`,
      ["شماره رسید", "آیدی تلگرام", "نام", "زمان ارسال", "زمان بررسی", "پلن", "مبلغ (تومان)", "کد تخفیف", "وضعیت", "بررسی‌کننده"],
      rows.map((r) => [r.id, r.tg_id, r.tg_name || "", fmtDate(r.ts), fmtDate(r.decided), r.plan || "", r.amount ?? "", r.code || "", r.status, r.decided_by || ""]));
  }
  if (type === "monthly") {
    const rep = await buildReport(db, now);
    return csvResponse(`monthly-${stamp}.csv`,
      ["ماه (شمسی)", "درآمد (تومان)", "تعداد پرداخت", "رسید رد‌شده", "کاربر جدید", "کانفیگ ساخته‌شده"],
      rep.monthly.map((m) => [m.label, m.amount, m.n, m.rej, m.usr, m.cfg]));
  }
  return json({ error: "نوع خروجی نامعتبره" }, 400);
}

/* ---------------- وضعیت سرویس و سابقه‌ی کانفیگ (فاز ۴) ---------------- */
const HEARTBEAT_MAX_AGE = 3 * 60000; // اگه کرون بیشتر از این ساکت باشه، مشکوک می‌شه
const SEVERITY = { ok: 0, degraded: 1, down: 2 };
const worst = (list) => list.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "ok");

async function heartbeat(db) {
  await db.prepare("INSERT INTO settings(k,v) VALUES('cron_ts',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(String(Date.now())).run();
}

// وضعیت عمومی: بدون ورود قابل مشاهده است، پس فقط اطلاعات عمومی برمی‌گردونه
async function serviceStatus(env) {
  const now = Date.now();
  let db = null, dbOk = false, dbMs = null;
  try {
    db = await getDB(env);
    const t0 = Date.now();
    await db.prepare("SELECT 1 x").first();
    dbOk = true;
    dbMs = Date.now() - t0;
  } catch (e) { dbOk = false; }

  const dbStatus = !dbOk ? "down" : dbMs > 1500 ? "degraded" : "ok";
  let cronStatus = "degraded";
  if (dbOk) {
    const row = await db.prepare("SELECT v FROM settings WHERE k='cron_ts'").first();
    if (row && now - Number(row.v) <= HEARTBEAT_MAX_AGE) cronStatus = "ok";
  }
  const st = dbOk ? await getSettings(db) : { status_level: "ok", status_note: "" };
  const components = [
    { id: "api", status: "ok" },
    { id: "database", status: dbStatus, ms: dbOk ? dbMs : null },
    { id: "cron", status: cronStatus },
  ];
  const notice = st.status_level !== "ok" || st.status_note
    ? { level: st.status_level, text: st.status_note } : null;
  return {
    overall: worst([...components.map((c) => c.status), st.status_level]),
    updated: now,
    components,
    notice,
  };
}

// سابقه‌ی ساخت کانفیگ‌های همین حساب (فقط زمان و تنظیمات؛ کلید خصوصی ذخیره نمی‌شه)
async function configHistory(request, env) {
  const sess = await getSession(env, request);
  if (!sess) return json({ error: "login" }, 401);
  const db = await getDB(env);
  const vid = "tg" + String(sess.tg_id).replace(/[^0-9]/g, "");
  const rows = (await db.prepare(
    "SELECT ts,region,mode,role,name FROM events WHERE vid=? AND type='config' ORDER BY ts DESC, id DESC LIMIT 50"
  ).bind(vid).all()).results || [];
  return json({ items: rows });
}

// صفحه‌های استاتیک جدید (/status و /help) از فایل‌های Public سرو می‌شن
async function pageAsset(request, env, path) {
  const url = new URL(request.url);
  return env.ASSETS.fetch(new Request(url.origin + path, { headers: request.headers }));
}

/* ---------------- router ---------------- */
export default {
  // اجرای هر دقیقه (wrangler.jsonc → triggers): یادآوری انقضا و ارسال پیام همگانی
  async scheduled(event, env) {
    try { await heartbeat(await getDB(env)); } catch (e) { console.error("heartbeat", e); }
    try { await runReminders(env); } catch (e) { console.error("reminders", e); }
    try { await runBroadcasts(env); } catch (e) { console.error("broadcasts", e); }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/auth/start" && request.method === "POST") return await authStart(env);
      if (p === "/api/auth/check" && request.method === "GET") return await authCheck(env, url);
      if (p === "/api/tg/webhook" && request.method === "POST") return await tgWebhook(request, env);
      if (p === "/api/track" && request.method === "POST") return await track(request, env);
      if (p === "/api/admin/stats" && request.method === "GET") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminStats(env);
      }
      if (p === "/api/status" && request.method === "GET") return json(await serviceStatus(env), 200, { "Cache-Control": "no-store" });
      if (p === "/api/configs/history" && request.method === "GET") return await configHistory(request, env);
      if ((p === "/status" || p === "/help") && request.method === "GET") return await pageAsset(request, env, p + ".html");
      if (p === "/api/me" && request.method === "GET") return await me(request, env);
      if (p === "/api/member/check" && request.method === "GET") return await memberCheck(request, env);
      if (p === "/api/admin/userlimit" && request.method === "POST") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminUserLimit(request, env);
      }
      if (p === "/api/admin/ban" && request.method === "POST") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminBan(request, env);
      }
      if (p === "/api/config/create" && request.method === "POST") return await createConfig(request, env);
      if (p === "/api/admin/sub" && request.method === "POST") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminSub(request, env);
      }
      if (p === "/api/admin/settings" && request.method === "POST") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminSettings(request, env);
      }
      if (p === "/api/admin/webhook" && request.method === "POST") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminWebhook(request, env);
      }
      if (p === "/api/admin/users" && request.method === "GET") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminUsers(env, url);
      }
      if (p === "/api/admin/report" && request.method === "GET") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return json(await buildReport(await getDB(env), Date.now()));
      }
      if (p === "/api/admin/export" && request.method === "GET") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminExport(env, url);
      }
      if (p === "/api/admin/tickets" && request.method === "GET") {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminTickets(env, url);
      }
      if (p === "/api/admin/ticket" && (request.method === "GET" || request.method === "POST")) {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminTicket(request, env, url);
      }
      if ((p === "/api/admin/broadcasts" && request.method === "GET") || (p === "/api/admin/broadcast" && request.method === "POST")) {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminBroadcasts(request, env);
      }
      if (p === "/api/admin/tg/start" && request.method === "POST") return await adminTgStart(env);
      if (p === "/api/admin/tg/check" && request.method === "GET") return await adminTgCheck(env, url);
      if (p === "/api/admin/logout" && request.method === "POST") return await adminLogout(request, env);
      if (p === "/api/admin/codes" && (request.method === "GET" || request.method === "POST")) {
        const bad = await adminAuth(request, env); if (bad) return bad;
        return await adminCodes(request, env);
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
