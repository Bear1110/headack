// 偵測網站有新部署，讓還開著舊版的分頁（尤其是加到主畫面、從背景叫回來的 App）提示重新整理。
// GitHub Pages 每次部署都會把所有檔案的 Last-Modified 設成部署時間，所以拿小檔案 version.js 的
// Last-Modified 當「部署戳記」：開啟時記下，之後回到前景時再問一次，不同就代表網站已更新。
// 不需要手動改版本號。本機開發伺服器回的是檔案修改時間，改了 version.js 才會觸發。
const PROBE = new URL('./version.js', import.meta.url);
const MIN_GAP = 5 * 60 * 1000; // 回到前景時，最多每 5 分鐘問一次

async function deployStamp() {
  try {
    // HEAD 不經過 service worker 的快取（sw.js 只處理 GET），no-store 也略過 HTTP 快取
    const res = await fetch(PROBE, { method: 'HEAD', cache: 'no-store' });
    return res.ok ? (res.headers.get('Last-Modified') ?? res.headers.get('ETag')) : null;
  } catch {
    return null; // 離線
  }
}

/** 網站有新部署時呼叫 onUpdate()（之後每次檢查到仍是舊版都會再呼叫）。 */
export async function watchForUpdate(onUpdate) {
  let loaded = await deployStamp();
  let lastCheck = Date.now();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < MIN_GAP) return;
    lastCheck = Date.now();
    const now = await deployStamp();
    if (!now) return;
    if (!loaded) loaded = now; // 開啟時離線：第一次連上時才記下
    else if (now !== loaded) onUpdate();
  });
}
