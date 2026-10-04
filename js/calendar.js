// 日曆：最近 N 個月，每天依最痛程度上色，有用藥加記號。只產生 HTML，互動由 app.js 處理。

import { daysCovered, localDate, monthStats } from './stats.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 日期 → { count, max（最痛程度，未記錄為 null）, meds（當天開始的紀錄有用藥） }
export function buildDayMap(records) {
  const map = new Map();
  const entry = (day) => {
    if (!map.has(day)) map.set(day, { count: 0, max: null, meds: false });
    return map.get(day);
  };
  for (const r of records) {
    for (const day of daysCovered(r)) {
      const e = entry(day);
      e.count += 1;
      if (Number.isFinite(r.intensity)) e.max = Math.max(e.max ?? 0, r.intensity);
    }
    if (r.start && r.meds?.length) entry(r.start.slice(0, 10)).meds = true;
  }
  return map;
}

// 一週從哪天開始（0 = 週日）。支援 Intl.Locale 週資訊的瀏覽器依語系決定，否則週日。
function firstDayOfWeek(lang) {
  try {
    const loc = new Intl.Locale(lang);
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info?.firstDay) return info.firstDay % 7;
  } catch { /* ignore */ }
  return 0;
}

// 每天的無障礙說明文字
function dayLabel(t, lang, date, e) {
  const d = date.toLocaleDateString(lang, { month: 'long', day: 'numeric', weekday: 'short' });
  if (!e) return d;
  const parts = [t('cal.headache')];
  if (e.max != null) parts.push(`${e.max}/10`);
  if (e.meds) parts.push(t('cal.meds'));
  return `${d}: ${parts.join(', ')}`;
}

export function renderCalendar({ records, months, lang, t, selected }) {
  const dayMap = buildDayMap(records);
  const today = localDate(new Date());
  const firstDay = firstDayOfWeek(lang);
  const weekdayFmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow' });
  const monthFmt = new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'long' });

  // 週幾的標題（以 2023-01-01 週日為基準）
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(2023, 0, 1 + ((firstDay + i) % 7))));

  const now = new Date();
  const blocks = [];
  for (let m = 0; m < months; m++) {
    const first = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const ym = localDate(first).slice(0, 7);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() - firstDay + 7) % 7;
    const s = monthStats(records, ym);

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="cal-blank"></span>');
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(first.getFullYear(), first.getMonth(), d);
      const key = localDate(date);
      const e = dayMap.get(key);
      const classes = ['cal-day'];
      if (e) classes.push('has-headache', e.max != null ? `i${e.max}` : 'no-intensity');
      if (key === today) classes.push('today');
      if (key === selected) classes.push('selected');
      const future = key > today;
      cells.push(`
        <button type="button" class="${classes.join(' ')}" data-day="${key}" ${future ? 'disabled' : ''}
          aria-label="${esc(dayLabel(t, lang, date, e))}" aria-pressed="${key === selected}">
          <span class="cal-num">${d}</span>${e?.meds ? '<span class="cal-med" aria-hidden="true"></span>' : ''}
        </button>`);
    }

    blocks.push(`
      <section class="cal-month">
        <header class="cal-head">
          <h3>${esc(monthFmt.format(first))}</h3>
          <span class="muted small">${esc(t('cal.summary', { h: s.headacheDays, m: s.medDays }))}${s.mohWarnings.length ? ' <span class="cal-warn" title="' + esc(t('cal.mohHint')) + '">⚠</span>' : ''}</span>
        </header>
        <div class="cal-grid">
          ${weekdays.map((w) => `<span class="cal-wd">${esc(w)}</span>`).join('')}
          ${cells.join('')}
        </div>
      </section>`);
  }
  return blocks.join('');
}
