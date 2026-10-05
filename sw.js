// Service worker：快取網站本身的檔案，讓「加到主畫面」與離線開啟可用。
// Google 的 API 與登入請求一律不經快取。
// 採「網路優先」，一般部署會自動拿到新版；SHELL 清單有增減時請把 VERSION 加一。

const VERSION = 'v22'; // 網站版本見 js/version.js
const CACHE = `headache-log-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'privacy.html',
  'terms.html',
  'faq.html',
  'css/styles.css',
  'js/app.js',
  'js/theme.js',
  'js/analysis.js',
  'js/charts.js',
  'js/statsview.js',
  'js/calendar.js',
  'js/auth.js',
  'js/config.js',
  'js/i18n.js',
  'js/icons.js',
  'js/version.js',
  'js/importer.js',
  'js/aianalysis.js',
  'js/widgets.js',
  'js/quickflow.js',
  'js/demo.js',
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
  'icons/logo.svg',
  'icons/bear.svg',
  'icons/logo.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // 安裝時略過 HTTP 快取（cache: 'reload'），避免把舊檔存進新版本的快取
  const fresh = SHELL.map((u) => new Request(u, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同源檔案：先用網路（拿到最新版並更新快取），失敗才用快取。
// GitHub Pages 設定 max-age=600，瀏覽器可能拿到 10 分鐘內的舊檔，造成新舊檔案混用
// （例如新的 index.html 配上舊的語系檔）。頁面與程式檔（HTML / JS / CSS）一律向伺服器確認
// （no-cache：沒變只回 304）；圖示、圖片等不影響版本一致性的檔案照常使用 HTTP 快取。
const MUST_MATCH = /(?:\/|\.html|\.js|\.css)$/;
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  let request = event.request;
  if (MUST_MATCH.test(url.pathname)) {
    // navigate 模式的 Request 不能複製，改用網址重新發出
    request = request.mode === 'navigate' ? new Request(url, { cache: 'no-cache' }) : new Request(request, { cache: 'no-cache' });
  }
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
