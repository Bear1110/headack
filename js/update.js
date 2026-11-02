// 偵測網站有新部署，讓還開著舊版的分頁（尤其是加到主畫面、從背景叫回來的 App）提示重新整理。
// GitHub Pages 每次部署都會把所有檔案的 Last-Modified 設成部署時間。頁面載入時瀏覽器已經把它記在
// document.lastModified，之後回到前景時對頁面本身發 HEAD 比對，不同就代表網站已更新。
// 不需要手動改版本號。本機開發伺服器回的是檔案修改時間，改了 index.html 才會觸發。

/** 網站有新部署時呼叫 onUpdate()；之後每次回到前景都會再呼叫一次（不再重問伺服器）。 */
export function watchForUpdate(onUpdate) {
  const loaded = Date.parse(document.lastModified);
  let found = false;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (!found) {
      try {
        // HEAD 不經過 service worker（sw.js 只處理 GET），no-store 也略過 HTTP 快取
        const res = await fetch(location.pathname, { method: 'HEAD', cache: 'no-store' });
        const deployed = Date.parse(res.headers.get('Last-Modified'));
        found = res.ok && deployed > loaded; // 沒有 Last-Modified 時是 NaN，比較為 false
      } catch {
        return; // 離線
      }
    }
    if (found) onUpdate();
  });
}
