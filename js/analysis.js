// 統計分析：給「我的趨勢」與「看診摘要」用。全部在瀏覽器內計算。
//
// 約定：
// - 「天數」類指標（頭痛天數、用藥天數）以日期計，跨夜頭痛算兩天，只計入範圍內的日期。
// - 「發作」類指標（次數、程度、症狀…）以開始日期落在範圍內的紀錄計。
// - 欄位沒填視為「未記錄」，不當成 0；每項都附上有資料的筆數 n，讓讀者知道樣本多大。
// - 開始時間剛好 00:00 的紀錄視為「時間不明」（多半是只有日期的匯入資料），不納入時段分析。

import { MED_BY_CODE, MOH_THRESHOLDS } from './schema.js';
import { daysCovered, localDate } from './stats.js';

export const DAYS_PER_MONTH = 30.44;
const EFFECTIVE = new Set(['good', 'complete']);

const dayOf = (iso) => iso.slice(0, 10);
const hasTime = (iso) => iso.length >= 16 && iso.slice(11, 16) !== '00:00';
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
};
const daysBetween = (from, to) => Math.round((new Date(`${to}T00:00`) - new Date(`${from}T00:00`)) / 86400000) + 1;

function median(sorted) {
  if (!sorted.length) return null;
  const m = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(m)] : (sorted[m - 1] + sorted[m]) / 2;
}
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- 範圍與篩選 ----------

export const RANGE_PRESETS = ['30d', '3m', '6m', '1y', 'all', 'custom'];

// 回傳 { from, to }（含頭尾的 YYYY-MM-DD）
export function resolveRange(state, records) {
  const today = localDate(new Date());
  const back = (months) => {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    d.setDate(d.getDate() + 1);
    return localDate(d);
  };
  switch (state.range) {
    case '30d': return { from: addDays(today, -29), to: today };
    case '6m': return { from: back(6), to: today };
    case '1y': return { from: back(12), to: today };
    case 'all': {
      const first = records.reduce((min, r) => (r.start && dayOf(r.start) < min ? dayOf(r.start) : min), today);
      return { from: first, to: today };
    }
    case 'custom':
      if (state.from && state.to && state.from <= state.to) return { from: state.from, to: state.to };
      return { from: back(3), to: today };
    default: return { from: back(3), to: today };
  }
}

// 前一段同樣長度的期間（用來比較變好或變差）
export function previousRange({ from, to }) {
  const len = daysBetween(from, to);
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

// types：空陣列 = 全部；meds：'all' | 'with' | 'without' | 藥物代碼
export function filterRecords(records, { types = [], meds = 'all' }) {
  return records.filter((r) => {
    if (!r.start) return false;
    if (types.length && !types.includes(r.type || 'unknown')) return false;
    const list = r.meds ?? [];
    if (meds === 'with') return list.length > 0;
    if (meds === 'without') return list.length === 0;
    if (meds !== 'all') return list.some((m) => m.code === meds);
    return true;
  });
}

// ---------- 主要分析 ----------

export function analyze(records, { from, to }) {
  const inRange = (day) => day >= from && day <= to;
  const rangeDays = daysBetween(from, to);
  const attacks = records.filter((r) => inRange(dayOf(r.start))).sort((a, b) => a.start.localeCompare(b.start));
  const N = attacks.length;

  // 天數類
  const headacheDays = new Set();
  for (const r of records) for (const d of daysCovered(r)) if (inRange(d)) headacheDays.add(d);
  const medDays = new Set();
  const medDaysByCat = {};
  for (const r of attacks) {
    if (!r.meds?.length) continue;
    const d = dayOf(r.start);
    medDays.add(d);
    for (const m of r.meds) {
      const cat = MED_BY_CODE[m.code]?.category ?? 'simple';
      (medDaysByCat[cat] ??= new Set()).add(d);
    }
  }

  // 每月（範圍內的每個日曆月）
  const months = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00`); localDate(d) <= to; d.setMonth(d.getMonth() + 1)) {
    const ym = localDate(d).slice(0, 7);
    const last = localDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    const mFrom = from > `${ym}-01` ? from : `${ym}-01`;
    const mTo = to < last ? to : last;
    const inMonth = (day) => day.startsWith(ym);
    const byCat = {};
    for (const [cat, set] of Object.entries(medDaysByCat)) byCat[cat] = [...set].filter(inMonth).length;
    months.push({
      ym,
      days: daysBetween(mFrom, mTo),
      partial: mFrom !== `${ym}-01` || mTo !== last,
      headacheDays: [...headacheDays].filter(inMonth).length,
      medDays: [...medDays].filter(inMonth).length,
      medDaysByCat: byCat,
      attacks: attacks.filter((r) => inMonth(dayOf(r.start))).length,
    });
  }

  // 藥物過度使用：哪些月份、哪類藥達到門檻（只看完整月份才有意義，但部分月份達標也提示）
  const moh = [];
  for (const m of months) {
    for (const [cat, n] of Object.entries(m.medDaysByCat)) {
      const limit = MOH_THRESHOLDS[cat] ?? 10;
      if (n >= limit) moh.push({ ym: m.ym, cat, days: n, limit });
    }
    const classes = Object.values(m.medDaysByCat).filter((n) => n > 0).length;
    if (classes > 1 && m.medDays >= 10 && !moh.some((x) => x.ym === m.ym)) moh.push({ ym: m.ym, cat: 'acuteMixed', days: m.medDays, limit: 10 });
  }

  // 程度、持續時間
  const intensities = attacks.map((r) => r.intensity).filter(Number.isFinite).sort((a, b) => a - b);
  const intensityDist = Array(11).fill(0);
  intensities.forEach((v) => { intensityDist[Math.max(0, Math.min(10, Math.round(v)))] += 1; });
  const durations = attacks
    .filter((r) => r.end && hasTime(r.start))
    .map((r) => (new Date(r.end) - new Date(r.start)) / 60000)
    .filter((m) => m > 0 && m < 14 * 24 * 60)
    .sort((a, b) => a - b);

  // 時間分布
  const weekday = Array(7).fill(0);
  attacks.forEach((r) => { weekday[new Date(`${dayOf(r.start)}T00:00`).getDay()] += 1; });
  const hours = Array(24).fill(0);
  const timed = attacks.filter((r) => hasTime(r.start));
  timed.forEach((r) => { hours[Number(r.start.slice(11, 13))] += 1; });

  // 類型、位置、預兆、症狀、誘因
  const count = (getList) => {
    const out = {};
    let withAny = 0;
    for (const r of attacks) {
      const list = getList(r) ?? [];
      if (list.length) withAny += 1;
      for (const x of new Set(list)) out[x] = (out[x] ?? 0) + 1;
    }
    return { counts: out, withAny };
  };
  const types = count((r) => [r.type || 'unknown']).counts;
  const locations = count((r) => r.locations);
  const aura = count((r) => r.aura);
  const symptoms = count((r) => r.symptoms);
  const triggers = count((r) => r.triggers);

  let unilateral = 0;
  let bilateral = 0;
  for (const r of attacks) {
    const sides = new Set((r.locations ?? []).map((l) => l.slice(-2)).filter((s) => s === '_l' || s === '_r'));
    if (sides.size === 1) unilateral += 1;
    else if (sides.size === 2) bilateral += 1;
  }

  // 藥物：每種藥的使用次數、有效比例；依服藥時機比較有效比例
  const medMap = new Map();
  const timing = {};
  for (const r of attacks) {
    for (const m of r.meds ?? []) {
      const key = m.code === 'other_med' && m.name ? `other:${m.name}` : m.code;
      const e = medMap.get(key) ?? { key, code: m.code, name: m.code === 'other_med' ? m.name : '', doses: 0, attacks: new Set(), rated: 0, effective: 0 };
      e.doses += 1;
      if (!e.attacks.has(r.id)) {
        e.attacks.add(r.id);
        if (r.med_effect) {
          e.rated += 1;
          if (EFFECTIVE.has(r.med_effect)) e.effective += 1;
        }
      }
      medMap.set(key, e);
      if (m.timing && r.med_effect) {
        const t = (timing[m.timing] ??= { rated: 0, effective: 0 });
        t.rated += 1;
        if (EFFECTIVE.has(r.med_effect)) t.effective += 1;
      }
    }
  }
  const medsTable = [...medMap.values()]
    .map((e) => ({ ...e, attacks: e.attacks.size }))
    .sort((a, b) => b.doses - a.doses);

  // 天氣
  const withWeather = attacks.filter((r) => Number.isFinite(r.pressure_change_24h));
  const changes = withWeather.map((r) => r.pressure_change_24h);
  const weather = {
    n: withWeather.length,
    falling: changes.filter((c) => c < 0).length,
    sharpFall: changes.filter((c) => c <= -5).length,
    meanChange: changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null,
  };

  return {
    from, to, rangeDays, attacks: N,
    headacheDays: headacheDays.size,
    medDays: medDays.size,
    perMonth: (n) => (n / rangeDays) * DAYS_PER_MONTH,
    months, moh,
    chronicMonths: months.filter((m) => !m.partial && m.headacheDays >= 15).length,
    intensity: { n: intensities.length, median: median(intensities), mean: intensities.length ? intensities.reduce((a, b) => a + b, 0) / intensities.length : null, dist: intensityDist },
    duration: { n: durations.length, median: median(durations), p25: quantile(durations, 0.25), p75: quantile(durations, 0.75) },
    weekday, hours, timed: timed.length,
    types, locations, aura, symptoms, triggers, unilateral, bilateral,
    meds: medsTable, timing,
    weather,
    cluster: clusterAnalysis(attacks.filter((r) => r.type === 'cluster')),
  };
}

// 叢集型：把間隔 ≤ 14 天的發作串成同一個「發作期」，並看每天幾次、集中在幾點
function clusterAnalysis(attacks) {
  if (!attacks.length) return null;
  const perDay = new Map();
  for (const r of attacks) perDay.set(dayOf(r.start), (perDay.get(dayOf(r.start)) ?? 0) + 1);
  const days = [...perDay.keys()].sort();
  const bouts = [];
  for (const d of days) {
    const cur = bouts[bouts.length - 1];
    if (cur && daysBetween(cur.to, d) - 1 <= 14) {
      cur.to = d;
      cur.attackDays += 1;
      cur.attacks += perDay.get(d);
      cur.maxPerDay = Math.max(cur.maxPerDay, perDay.get(d));
    } else {
      bouts.push({ from: d, to: d, attackDays: 1, attacks: perDay.get(d), maxPerDay: perDay.get(d) });
    }
  }
  bouts.forEach((b) => { b.length = daysBetween(b.from, b.to); });
  const hours = Array(24).fill(0);
  const timed = attacks.filter((r) => hasTime(r.start));
  timed.forEach((r) => { hours[Number(r.start.slice(11, 13))] += 1; });
  return {
    attacks: attacks.length,
    bouts: bouts.reverse(), // 最近的在前
    maxPerDay: Math.max(...perDay.values()),
    meanPerAttackDay: attacks.length / perDay.size,
    hours, timed: timed.length,
  };
}
