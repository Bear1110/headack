// 線條 icon（24×24、2px 筆畫、跟著文字顏色）。自己繪製，無外部授權問題。
// HTML 中寫 <span data-icon="名稱"></span>，由 applyIcons() 填入。

const PATHS = {
  log: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  stats: '<path d="M3 20h18M6.5 20v-8M12 20V5M17.5 20v-5"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/>',
  cloudCheck: '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M9.5 13.5l2 2 3.5-3.5"/>',
  cloudUp: '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M12 16v-5M9.5 13.5 12 11l2.5 2.5"/>',
  cloudSync: '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M9 14h.01M12 14h.01M15 14h.01"/>',
  cloudOff: '<path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.1 9.6 4.2 4.2 0 0 0 7 18z"/><path d="M3 3l18 18"/>',
  weather: '<circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1M12.2 3.8l-1 1"/><path d="M9 20h8a3.5 3.5 0 0 0 .5-6.96A5 5 0 0 0 8.2 12.4 3.8 3.8 0 0 0 9 20z"/>',
  importIcon: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  exportIcon: '<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>',
  demo: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  alert: '<path d="M12 3.5 22 20H2z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  install: '<path d="M12 3v11M7.5 9.5 12 14l4.5-4.5"/><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/>',
  addBox: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
};

export function icon(name, cls = '') {
  const p = PATHS[name];
  if (!p) return '';
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${p}</svg>`;
}

export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.firstElementChild) el.innerHTML = icon(el.dataset.icon);
  });
}
