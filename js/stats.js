// 統計全部在瀏覽器內計算。日期以紀錄的本地時間字串為準（YYYY-MM-DD 前綴）。

import { MED_BY_CODE, MOH_THRESHOLDS } from './schema.js';


const dayOf = (iso) => (iso ? iso.slice(0, 10) : null);

// 一筆紀錄涵蓋的所有日期（跨夜頭痛算兩天）
export function daysCovered(r) {
  const start = dayOf(r.start);
  if (!start) return [];
  const end = dayOf(r.end) || start;
  const days = [];
  const d = new Date(`${start}T00:00`);
  const last = new Date(`${end}T00:00`);
  while (d <= last && days.length < 31) {
    days.push(localDate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00`);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

// 兩個日期（YYYY-MM-DD）相差幾天：以當地午夜相減再四捨五入，遇到夏令時間也不會差一天
export function dayDiff(from, to) {
  return Math.round((new Date(`${to}T00:00`) - new Date(`${from}T00:00`)) / 86400000);
}

// 服藥那天相對於發作開始那天：0 = 當天、1 = 隔天…（頭痛可能持續好幾天，藥不一定當天吃）
export function medDayOffset(start, at) {
  return start && at ? dayDiff(start.slice(0, 10), at.slice(0, 10)) : 0;
}

// 第一次選服藥時間時預設哪一天：早於開始時間的多半是跨過午夜，算隔天
export function defaultMedDay(start, hhmm) {
  return start && hhmm < start.slice(11, 16) ? 1 : 0;
}

// month: 'YYYY-MM'
export function monthStats(records, month) {
  const inMonth = (day) => day.startsWith(month);
  const headacheDays = new Set();
  const medDays = new Set();
  const medDaysByCategory = {};
  const typeCounts = {};
  let intensitySum = 0;
  let intensityN = 0;
  let episodes = 0;

  for (const r of records) {
    const covered = daysCovered(r).filter(inMonth);
    if (!covered.length) continue;
    covered.forEach((d) => headacheDays.add(d));

    if (dayOf(r.start).startsWith(month)) {
      episodes += 1;
      const type = r.type || 'unknown';
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      if (Number.isFinite(r.intensity)) {
        intensitySum += r.intensity;
        intensityN += 1;
      }
    }

    // 暫定：用藥日 = 紀錄開始日（之後 Schema 可能改為每次服藥各自記時間）
    const medDay = dayOf(r.start);
    if (r.meds?.length && inMonth(medDay)) {
      medDays.add(medDay);
      for (const { code } of r.meds) {
        const cat = MED_BY_CODE[code]?.category ?? 'simple';
        (medDaysByCategory[cat] ??= new Set()).add(medDay);
      }
    }
  }

  // 藥物過度使用參考門檻（ICHD-3）：一般止痛藥 ≥15 天/月；其他各類 ≥10 天/月；
  // 多類合併使用（含一般止痛藥）合計 ≥10 天/月。
  const mohWarnings = [];
  for (const [cat, days] of Object.entries(medDaysByCategory)) {
    const limit = MOH_THRESHOLDS[cat] ?? 10;
    if (days.size >= limit) mohWarnings.push({ cat, n: days.size, limit });
  }
  const multiClass = Object.keys(medDaysByCategory).length > 1;
  if (!mohWarnings.length && multiClass && medDays.size >= 10) {
    mohWarnings.push({ cat: 'acuteMixed', n: medDays.size, limit: 10 });
  }

  return {
    headacheDays: headacheDays.size,
    medDays: medDays.size,
    episodes,
    avgIntensity: intensityN ? intensitySum / intensityN : null,
    typeCounts,
    mohWarnings,
  };
}
