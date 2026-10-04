// Service worker：快取網站本身的檔案，讓「加到主畫面」與離線開啟可用。
// Google 的 API 與登入請求一律不經快取。
// 採「網路優先」，一般部署會自動拿到新版；SHELL 清單有增減時請把 VERSION 加一。

const VERSION = 'v5';
const CACHE = `headache-log-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'privacy.html',
  'css/styles.css',
  'js/app.js',
  'js/auth.js',
  'js/config.js',
  'js/i18n.js',
  'js/importer.js',
  'js/widgets.js',
  'js/weather.js',
  'js/schema.js',
  'js/sheets.js',
  'js/stats.js',
  'js/store.js',
  'js/locales/en.js',
  'js/locales/zh-TW.js',
  'js/locales/zh-CN.js',
  'js/locales/ja.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同源檔案：先用網路（拿到最新版並更新快取），失敗才用快取
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
