// 多國語系。
//
// - 每個語言一個檔案：js/locales/<code>.js，export default { key: message }。
// - 英文（en）是基準與備援：其他語言缺少的 key 會顯示英文。
// - 新增語言：複製 en.js 翻譯 → 在下方 LANGS 登記 → 加進 sw.js 的 SHELL → 執行 node tools/check-locales.mjs 檢查缺漏。
// - 訊息可用 {name} 插入變數；需要單複數變化時寫成物件 { one: '...', other: '...' }，依 vars.n 以 Intl.PluralRules 選擇。
// - HTML 內用 data-i18n="key"（textContent）或 data-i18n-attr="attr:key,attr2:key2"。

import en from './locales/en.js';

// 顯示名稱用該語言自己的寫法
export const LANGS = {
  en: 'English',
  'zh-TW': '繁體中文',
  'zh-CN': '简体中文',
  ja: '日本語',
};

const RTL = new Set(['ar', 'he', 'fa', 'ur']);
const LANG_KEY = 'hl.lang';

// 瀏覽器語言 → 支援的語言
function resolveLang(tag) {
  if (!tag) return null;
  if (LANGS[tag]) return tag;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) {
    return /hant|tw|hk|mo/.test(lower) ? 'zh-TW' : 'zh-CN';
  }
  const base = lower.split('-')[0];
  return Object.keys(LANGS).find((k) => k.toLowerCase() === base) ?? null;
}

function detect() {
  try {
    const saved = resolveLang(localStorage.getItem(LANG_KEY));
    if (saved) return saved;
  } catch { /* ignore */ }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const hit = resolveLang(tag);
    if (hit) return hit;
  }
  return 'en';
}

let lang = 'en';
let messages = en;
let pluralRules = new Intl.PluralRules('en');

export function getLang() {
  return lang;
}

export async function setLang(next, { remember = true } = {}) {
  const target = resolveLang(next) ?? 'en';
  try {
    messages = target === 'en' ? en : (await import(`./locales/${target}.js`)).default;
    lang = target;
  } catch (e) {
    console.warn(`locale ${target} failed to load`, e); // 例如離線且尚未快取
    messages = en;
    lang = 'en';
  }
  pluralRules = new Intl.PluralRules(lang);
  if (remember) {
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
  }
  applyI18n();
}

export function initI18n() {
  return setLang(detect(), { remember: false });
}

export function t(key, vars = {}) {
  let msg = messages[key] ?? en[key] ?? key;
  if (typeof msg === 'object') msg = msg[pluralRules.select(Number(vars.n ?? 0))] ?? msg.other;
  return msg.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

// 依語言把清單接起來（中日文用「、」，英文用 ", "）。
// 不用 Intl.ListFormat：它在中文的 unit 樣式不加分隔、conjunction 樣式會在最後加「和」。
export function formatList(items) {
  return items.join(t('list.separator'));
}

// ---------- 日期與時間的顯示 ----------

const isZh = () => lang.startsWith('zh');

// 週幾：中文只寫「一二三」（不加「週」）；其他語言用短名稱
export function weekdayLabel(date) {
  return new Intl.DateTimeFormat(lang, { weekday: isZh() ? 'narrow' : 'short' }).format(date);
}

// 日期＋週幾，例如「10/6（二）」「Tue, 10/6」。year：加上年份；long：月份寫成「10月6日」
// 中文自己組字串：Intl 的 narrow 在簡體會變成「10/6二」，沒有分隔。
export function dateLabel(date, { year = false, long = false } = {}) {
  if (!isZh()) {
    return date.toLocaleDateString(lang, { ...(year ? { year: 'numeric' } : {}), month: long ? 'long' : 'numeric', day: 'numeric', weekday: 'short' });
  }
  const [y, m, d] = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  const day = long ? `${m}月${d}日` : `${year ? `${y}/` : ''}${m}/${d}`;
  return `${day}(${weekdayLabel(date)})`;
}

// 時間：12 小時制的語言一律用英文 AM/PM（中文的「上午／下午」佔兩個全形字，比較寬）
export function clockLabel(date) {
  const parts = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const i = parts.findIndex((p) => p.type === 'dayPeriod');
  if (i < 0) return parts.map((p) => p.value).join('');
  const ampm = date.getHours() < 12 ? 'AM' : 'PM';
  const rest = parts.filter((p) => p.type !== 'dayPeriod').map((p) => p.value).join('').trim();
  return i === 0 ? `${ampm} ${rest}` : `${rest} ${ampm}`;
}

export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang.split('-')[0]) ? 'rtl' : 'ltr';
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    for (const pair of el.dataset.i18nAttr.split(',')) {
      const [attr, key] = pair.split(':');
      el.setAttribute(attr, t(key));
    }
  });
}
