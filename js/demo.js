// 示範模式的範例資料：以今天為基準往前約 7 個月（3 個月期間也有「前一段期間」可比較），固定亂數種子（每次產生的內容相同）。
// 刻意把每個欄位都填上，讓日曆、我的趨勢、看診摘要的每一張卡片都有內容可看。

import { localDate } from './stats.js';

const DAYS = 210;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const some = (rand, list, p) => list.filter(() => rand() < p);
const pad = (n) => String(n).padStart(2, '0');

function at(day, hour, minute) {
  return `${day}T${pad(hour)}:${pad(minute)}`;
}

function addMinutes(iso, minutes) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function buildDemoRecords() {
  const rand = rng(20261004);
  const records = [];
  const now = new Date();
  // 約 50–60 天前有一段叢集型發作期
  const clusterFrom = 56;
  const clusterTo = 45;

  for (let off = DAYS; off >= 1; off--) {
    const d = new Date(now);
    d.setDate(d.getDate() - off);
    const day = localDate(d);
    const inCluster = off <= clusterFrom && off >= clusterTo;
    if (!inCluster && rand() > 0.36) continue;

    let r;
    if (inCluster) {
      // 叢集型：半夜固定時段痛醒、單側眼窩鑽痛
      if (rand() > 0.85) continue;
      const start = at(day, 2, Math.floor(rand() * 50));
      r = {
        start, end: addMinutes(start, 45 + Math.floor(rand() * 60)), intensity: 8 + Math.floor(rand() * 3), type: 'cluster',
        locations: ['eye_r', 'temple_r'], pain_quality: ['boring', 'stabbing'], aura: [],
        symptoms: some(rand, ['dizziness'], 0.3),
        meds: rand() < 0.7 ? [{ code: 'sumatriptan_nasal', amount: 1, timing: 'severe', name: '' }] : [],
        triggers: some(rand, ['alcohol', 'sleep'], 0.3),
      };
      r.med_effect = r.meds.length ? pick(rand, ['good', 'complete', 'complete']) : '';
    } else if (rand() < 0.7) {
      // 偏頭痛：右側搏動性、怕光怕吵、有時有視覺預兆
      const start = at(day, pick(rand, [7, 9, 14, 16, 18]), Math.floor(rand() * 60));
      const early = rand() < 0.55;
      const med = early ? { code: 'eve', amount: pick(rand, [1, 1, 2]), timing: 'early', name: '' }
        : { code: 'sumatriptan', amount: 1, timing: 'severe', name: '' };
      r = {
        start, end: addMinutes(start, 180 + Math.floor(rand() * 600)), intensity: 5 + Math.floor(rand() * 5), type: 'migraine',
        locations: rand() < 0.75 ? ['temple_r', 'eye_r'] : ['temple_l', 'forehead_l'], pain_quality: ['pulsating'],
        aura: rand() < 0.22 ? ['visual'] : [],
        symptoms: some(rand, ['nausea', 'photophobia', 'phonophobia', 'activity'], 0.6),
        meds: rand() < 0.8 ? [med] : [],
        triggers: some(rand, ['sleep', 'stress', 'weather', 'skipped_meal', 'screen'], 0.3),
      };
      r.med_effect = r.meds.length ? (early ? pick(rand, ['good', 'complete', 'good', 'partial']) : pick(rand, ['partial', 'good', 'none'])) : '';
    } else {
      // 緊縮型：雙側壓迫感、下午到晚上
      const start = at(day, pick(rand, [13, 15, 17, 20]), Math.floor(rand() * 60));
      r = {
        start, end: addMinutes(start, 120 + Math.floor(rand() * 240)), intensity: 3 + Math.floor(rand() * 3), type: 'tension',
        locations: ['forehead_l', 'forehead_r', 'occiput_l', 'occiput_r'], pain_quality: ['pressing', 'dull'], aura: [],
        symptoms: some(rand, ['phonophobia'], 0.3),
        meds: rand() < 0.45 ? [{ code: 'panadol', amount: 1, timing: 'early', name: '' }] : [],
        triggers: some(rand, ['stress', 'screen', 'sleep'], 0.5),
      };
      r.med_effect = r.meds.length ? pick(rand, ['good', 'partial', 'complete']) : '';
    }

    // 天氣：偏頭痛發作前較常見氣壓下降
    const drop = r.type === 'migraine' ? -6 : -3;
    r.pressure_change_24h = Math.round((drop + rand() * 9) * 10) / 10;
    r.pressure_hpa = Math.round((1008 + rand() * 12) * 10) / 10;
    r.temp_c = Math.round((18 + rand() * 12) * 10) / 10;
    r.humidity_pct = Math.round(55 + rand() * 35);

    records.push({
      id: `demo-${records.length}`,
      med_effect: '',
      notes: '',
      ...r,
      created_at: new Date(r.start).toISOString(),
      updated_at: new Date(r.start).toISOString(),
    });
  }
  return records;
}
