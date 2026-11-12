/* IMRC panel — English UI for the static labels of index.html.
 * کلید هر ترجمه متن فارسی همان عنصر است (بعد از نرمال‌سازی فاصله‌ها).
 * متن‌هایی که JS بعد از لود می‌سازه (پیام‌ها، لیست کشورها، راهنمای مرحله‌ای) فعلاً فارسی می‌مونن.
 */
(function(){
  const DICT = {
 "خوش آمدید": "Welcome",
 "کانفیگ WireGuard بهینه برای Call of Duty Mobile؛ با سرور، MTU و DNS مناسب رنکد.": "Optimized WireGuard config for Call of Duty Mobile, with a ranked-ready server, MTU and DNS.",
 "شروع معرفی": "Start tour",
 "سرورها بر اساس پینگ": "Servers by ping",
 "بهترین‌ها برای کالاف علامت دارند.": "The best picks for CODM are marked.",
 "یک‌کلیک بهینه": "One-click optimized",
 "رنکد، ترکیه، MTU کم؛ فایل همان لحظه دانلود می‌شود.": "Ranked, Turkey, low MTU; the file downloads instantly.",
 "ابزار کنار دست": "Tools at hand",
 "تست پینگ، بررسی کانفیگ، تایمر و حساسیت.": "Ping test, config check, timer and sensitivity.",
 "بعدی": "Next",
 "شش تم رنگی": "Six color themes",
 "از تنظیمات عوض کن.": "Change it in Settings.",
 "پالت فرمان": "Command palette",
 "Ctrl + K برای دسترسی سریع به هر کار.": "Ctrl + K for quick access to any action.",
 "یادداشت و تاریخچه": "Notes & history",
 "برای هر کانفیگ تگ و یادداشت نگه دار.": "Keep tags and notes for each config.",
 "آماده ورود": "Ready to go",
 "با بهترین تنظیمات وارد میدان شو.": "Enter the field with the best settings.",
 "ورود به پنل": "Log in to the panel",
 "رد کردن معرفی": "Skip intro",
 "پنل ساخت کانفیگ WireGuard برای کالاف دیوتی موبایل": "WireGuard config builder for Call of Duty Mobile",
 "رمز عبور": "Password",
 "دفعه بعد رمز نخواهد": "Don't ask for the password next time",
 "ورود": "Log in",
 "ورود مهمان": "Guest login",
 "ساخت کانفیگ": "Build config",
 "کالاف": "CODM",
 "آمار": "Stats",
 "تنظیمات": "Settings",
 "ابزارها": "Tools",
 "پالت فرمان (Ctrl+K)": "Command palette (Ctrl+K)",
 "تغییر تم": "Change theme",
 "تمام‌صفحه": "Fullscreen",
 "حالت مطالعه": "Reading mode",
 "راهنما": "Help",
 "میانبرها": "Shortcuts",
 "حالت مهمان": "Guest mode",
 "یک‌کلیک بهینه کالاف": "One-click CODM optimize",
 "رنکد، ترکیه، MTU کم؛ ساخت و دانلود همان لحظه": "Ranked, Turkey, low MTU; build and download instantly",
 "سرورها": "Servers",
 "مرتب بر اساس پینگ": "Sorted by ping",
 "ستاره‌دارها": "Starred",
 "پاک": "Clear",
 "پیشنهاد کالاف:": "CODM suggestion:",
 "تنظیمات اتصال": "Connection settings",
 "حالت بازی": "Game mode",
 "رنکد": "Ranked",
 "بتل‌رویال": "Battle Royale",
 "مالتی‌پلیر": "Multiplayer",
 "نام فایل": "File name",
 "نام خودکار": "Auto name",
 "حجم": "Data cap",
 "۲۰ گیگ": "20 GB",
 "۵۰ گیگ": "50 GB",
 "۱۰۰ گیگ": "100 GB",
 "نامحدود": "Unlimited",
 "مدت": "Duration",
 "۷ روز": "7 days",
 "۳۰ روز": "30 days",
 "۹۰ روز": "90 days",
 "۱ سال": "1 year",
 "DNS گیمینگ": "Gaming DNS",
 "الکترو (پیشنهادی CODM)": "Electro (recommended for CODM)",
 "MTU موبایل": "Mobile MTU",
 "1280 (کم‌پینگ)": "1280 (low ping)",
 "1400 (تعادل)": "1400 (balanced)",
 "MTU در کانفیگ باشد": "Include MTU in config",
 "DNS در کانفیگ باشد": "Include DNS in config",
 "پریست‌های آماده": "Ready presets",
 "رنکد حرفه‌ای": "Pro ranked",
 "کم‌پینگ مطلق": "Ultra low ping",
 "تورنمنت": "Tournament",
 "ساخت سریع": "Quick build",
 "ساخت و دانلود": "Build & download",
 "پینگ این سرور بالاست؛ برای رنکد توصیه نمی‌شود.": "This server's ping is high; not recommended for ranked.",
 "بلیط اتصال": "Connection ticket",
 "پینگ قبل": "Ping before",
 "پینگ بعد": "Ping after",
 "بهبود": "Improvement",
 "جیتر": "Jitter",
 "پکت‌لاست": "Packet loss",
 "کل کانفیگ": "Full config",
 "تلگرام": "Telegram",
 "واتساپ": "WhatsApp",
 "یادداشت خصوصی": "Private note",
 "ذخیره": "Save",
 "هنوز بلیطی صادر نشده": "No ticket yet",
 "یک سرور انتخاب کن و «ساخت و دانلود» را بزن؛ کانفیگ، QR و پینگ اینجا نمایش داده می‌شود.": "Pick a server and tap \"Build & download\"; the config, QR code and ping appear here.",
 "نکات کالاف": "CODM tips",
 "برای رنکد از سرور ترکیه یا آلمان استفاده کن.": "For ranked, use the Turkey or Germany server.",
 "MTU بین ۱۲۸۰ تا ۱۴۰۰ برای موبایل بهتر است.": "MTU between 1280 and 1400 works best on mobile.",
 "DNS الکترو یا کلودفلر معمولاً پینگ بهتری می‌دهند.": "Electro or Cloudflare DNS usually give better ping.",
 "قبل از رنکد پینگ باید زیر ۷۰ باشد.": "Before ranked, ping should be under 70.",
 "نقش": "Role",
 "تهاجمی، ورود اول": "Aggressive, first entry",
 "نگهداری نقطه": "Hold the point",
 "پشتیبانی تیم": "Team support",
 "دستگاه": "Device",
 "دستگاه ضعیف": "Low-end device",
 "پرچم‌دار": "Flagship",
 "حالت ویژه": "Special mode",
 "ریست رنک و بهترین زمان": "Rank reset & best time",
 "در حال محاسبه...": "Calculating...",
 "تخمین SR بر اساس پینگ": "SR estimate by ping",
 "ابتدا کانفیگ بسازید": "Build a config first",
 "هنوز داده‌ای وجود ندارد": "No data yet",
 "پینگ ۷ کانفیگ اخیر": "Ping of last 7 configs",
 "پرتکرارترین کشورها": "Most used countries",
 "دستاوردها": "Achievements",
 "هدف پینگ ماهانه": "Monthly ping goal",
 "ثبت": "Set",
 "سابقه‌ی حساب من (روی سرور)": "My account history (server)",
 "بروزرسانی": "Refresh",
 "فقط زمان و تنظیمات ساخت ذخیره می‌شه؛ کلید و متن کانفیگ روی سرور نیست.": "Only the time and build settings are saved; the key and config text are not stored on the server.",
 "برای دیدن سابقه، بروزرسانی را بزن": "Tap Refresh to see history",
 "تاریخچه کانفیگ‌ها": "Config history",
 "خروجی CSV": "CSV export",
 "تست پینگ زنده": "Live ping test",
 "شروع تست": "Start test",
 "میانگین ms": "Average ms",
 "جیتر ms": "Jitter ms",
 "افت بسته %": "Packet loss %",
 "اطلاعات اتصال و دستگاه": "Connection & device info",
 "بررسی کانفیگ WireGuard": "Check WireGuard config",
 "بررسی": "Check",
 "آخرین کانفیگ": "Last config",
 "تایمر بازی و یادآور استراحت": "Game timer & break reminder",
 "شروع": "Start",
 "صفر": "Reset",
 "یادآور هر": "Remind every",
 "دقیقه": "min",
 "ماشین‌حساب K/D و درصد برد": "K/D & win rate calculator",
 "محاسبه": "Calculate",
 "پیشنهاد حساسیت": "Sensitivity suggestion",
 "گوشی کوچک": "Small phone",
 "گوشی بزرگ": "Large phone",
 "تبلت": "Tablet",
 "تهاجمی": "Aggressive",
 "متعادل": "Balanced",
 "اسنایپر": "Sniper",
 "بساز": "Build",
 "تست زمان واکنش": "Reaction time test",
 "برای شروع بزنید": "Tap to start",
 "چک‌لیست قبل از مچ": "Pre-match checklist",
 "دفترچه یادداشت (لودات و نکات)": "Notebook (loadouts & tips)",
 "تم": "Theme",
 "اندازه متن": "Text size",
 "صدا و ویبره": "Sound & vibration",
 "صدا:": "Sound:",
 "روشن": "On",
 "ویبره:": "Vibration:",
 "نمایش": "Display",
 "حالت حرفه‌ای (مخفی کردن راهنماها)": "Pro mode (hide guides)",
 "مخفی کردن تاریخچه": "Hide history",
 "برنامه و زبان": "App & language",
 "📲 نصب روی گوشی": "📲 Install on phone",
 "❓ راهنما و سوالات": "❓ Help & FAQ",
 "🟢 وضعیت سرویس": "🟢 Service status",
 "پشتیبان‌گیری": "Backup",
 "بکاپ": "Backup",
 "بازگردانی": "Restore",
 "پخش مجدد معرفی": "Replay intro",
 "پاک کردن همه داده‌ها": "Clear all data",
 "میانبرهای کیبورد": "Keyboard shortcuts",
 "ذخیره یادداشت": "Save note",
 "1 تا 5": "1 to 5",
 "تعویض بخش": "Switch section",
 "کانفیگ آماده شد": "Config ready",
 "فایل دانلود شد": "File downloaded",
 "کپی کانفیگ": "Copy config",
 "باشه": "OK",
 "برای بهبود سرویس، آمار استفاده (به‌همراه نام تلگرام) ثبت می‌شود.": "To improve the service, usage stats (with your Telegram name) are recorded.",
 "رمز را وارد کنید": "Enter the password",
 "نام یا کد کشور": "Country name or code",
 "جستجوی کشور": "Search country",
 "مثلاً IMRC-8-20": "e.g. IMRC-8-20",
 "MTU دلخواه (اختیاری)": "Custom MTU (optional)",
 "MTU دلخواه": "Custom MTU",
 "یادداشت برای این کانفیگ": "Note for this config",
 "تگ‌ها (با کاما)": "Tags (comma-separated)",
 "تگ‌ها": "Tags",
 "مثلاً 55": "e.g. 55",
 "هدف پینگ": "Ping goal",
 "جستجو در تاریخچه": "Search history",
 "کانفیگ را اینجا بچسبانید...": "Paste the config here...",
 "کیل": "Kills",
 "دث": "Deaths",
 "برد": "Wins",
 "باخت": "Losses",
 "لودات، کالربندی، برنامه تمرین...": "Loadouts, sensitivity, practice plan...",
 "کوچک‌تر": "Smaller",
 "بزرگ‌تر": "Larger",
 "جستجوی دستور... (مثلاً: رنکد، تم، دانلود)": "Search commands... (e.g. ranked, theme, download)"
};
  const ATTRS = ["placeholder", "aria-label", "title"];
  const norm = s => String(s).replace(/\s+/g, " ").trim();
  const origText = new WeakMap();
  const origAttr = new WeakMap();

  function textNodes(){
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n){
        const p = n.parentNode;
        return p && p.nodeName !== "SCRIPT" && p.nodeName !== "STYLE" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const list = [];
    while (w.nextNode()) list.push(w.currentNode);
    return list;
  }

  function apply(en){
    for (const n of textNodes()) {
      if (!origText.has(n)) origText.set(n, n.nodeValue);
      const orig = origText.get(n);
      const key = norm(orig);
      if (en && key && DICT[key]) {
        const lead = orig.match(/^\s*/)[0], trail = orig.match(/\s*$/)[0];
        n.nodeValue = lead + DICT[key] + trail;
      } else {
        n.nodeValue = orig;
      }
    }
    for (const el of document.querySelectorAll("*")) {
      for (const a of ATTRS) {
        if (!el.hasAttribute(a)) continue;
        let o = origAttr.get(el);
        if (!o) { o = {}; origAttr.set(el, o); }
        if (!(a in o)) o[a] = el.getAttribute(a);
        const key = norm(o[a]);
        el.setAttribute(a, en && DICT[key] ? DICT[key] : o[a]);
      }
    }
  }

  function setLang(l){
    const en = l === "en";
    localStorage.setItem("IMRC_lang", en ? "en" : "fa");
    document.documentElement.lang = en ? "en" : "fa";
    document.documentElement.dir = en ? "ltr" : "rtl";
    apply(en);
    const b = document.getElementById("langToggle");
    if (b) b.textContent = en ? "فارسی" : "English";
  }

  window.toggleLang = function(){ setLang(document.documentElement.lang === "en" ? "fa" : "en"); };
  const pick = new URLSearchParams(location.search).get("lang") || localStorage.getItem("IMRC_lang") || "fa";
  setLang(pick);
})();
