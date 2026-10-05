// 主題（淺色／深色）：在 <head> 以一般 script 載入，畫面畫出來之前就套用，避免閃一下。
// 偏好存在 localStorage（'light' / 'dark'；沒有＝跟隨系統），結果寫在 <html data-theme>，CSS 依此換色。
(() => {
  const KEY = 'hl.theme';
  const media = matchMedia('(prefers-color-scheme: dark)');
  const pref = () => {
    try {
      const v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch { return 'system'; }
  };
  const apply = () => {
    const p = pref();
    document.documentElement.dataset.theme = p === 'system' ? (media.matches ? 'dark' : 'light') : p;
  };
  apply();
  media.addEventListener('change', apply); // 跟隨系統時，系統切換就跟著換
  addEventListener('storage', (e) => { if (e.key === KEY) apply(); }); // 其他分頁改了設定

  // 給設定頁用
  window.headackTheme = {
    get: pref,
    set(v) {
      try {
        if (v === 'light' || v === 'dark') localStorage.setItem(KEY, v);
        else localStorage.removeItem(KEY);
      } catch { /* ignore */ }
      apply();
    },
  };
})();
