// IMRC Panel service worker
// قانون کلی: هیچ پاسخ API یا صفحه‌ی مخصوص ورود کش نمی‌شه (داده‌ی کاربر و سشن همیشه تازه از سرور میاد).
// فقط پوسته‌ی عمومی (صفحه‌های راهنما و وضعیت، آیکون‌ها، manifest) کش می‌شه تا آفلاین هم باز بشه.

const VERSION = "imrc-shell-v2";
const PAGES = ["/help.html", "/status.html", "/offline.html"];
const ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];
const SHELL = [...PAGES, ...ASSETS];

// صفحه‌ی آفلاین؛ اگه حتی اون هم کش نشده باشه، یک پاسخ 503 ساده (تا respondWith خالی نمونه)
function offlinePage() {
  return caches.match("/offline.html").then((hit) => hit || new Response("Offline", {
    status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // فونت و کتابخانه‌های CDN: مستقیم از شبکه
  if (url.pathname.startsWith("/api/")) return;    // API هرگز کش نمی‌شه

  // صفحه‌های عمومی: اول شبکه (تازه)، اگه نبود نسخه‌ی کش‌شده
  if (req.mode === "navigate" && PAGES.includes(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(() => caches.match(url.pathname).then((hit) => hit || offlinePage()))
    );
    return;
  }

  // بقیه‌ی navigation ها (پنل اصلی و ورود): اگه شبکه نبود، صفحه‌ی آفلاین
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => offlinePage()));
    return;
  }

  // آیکون‌ها و manifest: اول کش
  if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname).then((hit) => hit || fetch(req)));
  }
});

// اعلان مرورگر (Web Push): متن از سرور میاد؛ فقط عنوان، متن و آدرس داخل سایت
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: "IMRC", body: event.data ? event.data.text() : "" }; }
  const title = String(data.title || "IMRC").slice(0, 80);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(data.body || "").slice(0, 240),
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "imrc-" + (data.tag || "info"),
    data: { url: typeof data.url === "string" && /^\/(?!\/)/.test(data.url) ? data.url : "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      return self.clients.openWindow(url);
    })
  );
});
