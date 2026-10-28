/*
 * WalletEgg Service Worker
 *
 * 發版規則：每次修改任何 app shell 檔案（index.html、css、js、vendor、icons、manifest）後，
 * 除了更新 index.html 的 ?v= 版本號，也必須同步更新下方 APP_VERSION。
 * 瀏覽器只有在 sw.js 內容有變動時才會安裝新版 SW，否則已安裝的使用者會一直停在舊版。
 * 新增或刪除 app shell 檔案時，也要同步調整 SHELL_FILES。
 */
const APP_VERSION = "2026102802";
const CACHE_PREFIX = "walletegg-shell-";
const CACHE_NAME = CACHE_PREFIX + APP_VERSION;

// 相對於 sw.js 所在目錄（GitHub Pages 子路徑部署時也適用）
const SHELL_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/style.css",
  "js/store.js",
  "js/db.js",
  "js/lock.js",
  "js/services.js",
  "js/app.js",
  "js/pwa.js",
  "vendor/vue.global.prod.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  // 不呼叫 skipWaiting：新版進入 waiting，由頁面顯示更新提示，使用者確認後才切換
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_FILES.map((path) =>
          // cache: "reload" 略過 HTTP 快取，避免把 GitHub Pages / CDN 邊緣的舊檔存進新版 cache
          fetch(new Request(path, { cache: "reload" })).then((res) => {
            if (!res.ok) throw new Error("預快取失敗：" + path + "（HTTP " + res.status + "）");
            return cache.put(path, res);
          })
        )
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // 跨網域請求（匯率、股價 API、Proxy）一律不攔截，維持即時連網，避免拿到過期報價
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    const scopePath = new URL("./", self.location).pathname;
    // 只接管 App 本身的導覽（根目錄或 index.html），其他同源頁面（例如 docs/）直接走網路
    if (url.pathname !== scopePath && url.pathname !== scopePath + "index.html") return;
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match("index.html", { ignoreSearch: true }))
        .then((cached) => cached || fetch(req))
    );
    return;
  }

  // 同源資源 cache-first；ignoreSearch 讓 ?v= 版本參數仍可命中預快取
  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(req, { ignoreSearch: true }))
      .then((cached) => cached || fetch(req))
  );
});
