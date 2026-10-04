// ⚠ 暫定 Schema：欄位設計另行討論，定案後只需改這個檔案與 i18n 文字。
//
// 原則：
// - 第一欄是唯一 ID，程式以 ID 辨識紀錄，不靠列號（使用者可能手動排序或刪列）。
// - 程式依「標題名稱」對應欄位，不依欄位順序，所以使用者搬動欄位不會壞。
// - 時間一律存 ISO 本地時間字串（YYYY-MM-DDTHH:mm）。
// - 多選欄位以「;」分隔的固定代碼儲存。

export const SCHEMA_VERSION = 1;

// 固定 sheetId：建立試算表時指定，之後即使使用者改了分頁名稱也找得到
export const RECORDS_SHEET_ID = 0;
export const SETTINGS_SHEET_ID = 1;

export const RECORD_COLUMNS = [
  'id',
  'start',       // 開始時間
  'end',         // 結束時間（空白 = 進行中）
  'intensity',   // 疼痛程度 0–10
  'type',        // 頭痛類型代碼
  'locations',   // 疼痛位置代碼，以 ; 分隔
  'pain_quality', // 疼痛感覺代碼，以 ; 分隔（描述症狀，不用來推測類型）
  'aura',        // 預兆（先兆）代碼，以 ; 分隔
  'symptoms',    // 伴隨症狀代碼，以 ; 分隔
  'meds',        // 每次用藥，以 ; 分隔；每筆為「代碼:用量:時機[:自訂名稱]」，例如 eve:1:early;sumatriptan:0.5:severe
  'med_effect',  // 用藥效果代碼
  'triggers',    // 誘發因子代碼，以 ; 分隔
  'notes',       // 自由文字
  'pressure_hpa',        // 頭痛開始那個小時的地面氣壓（Open-Meteo）
  'pressure_change_24h', // 與 24 小時前相比的氣壓變化
  'temp_c',              // 氣溫
  'humidity_pct',        // 相對濕度
  'created_at',
  'updated_at',
];

export const MULTI_FIELDS = ['locations', 'pain_quality', 'aura', 'symptoms', 'triggers'];
export const NUMERIC_FIELDS = ['intensity', 'pressure_hpa', 'pressure_change_24h', 'temp_c', 'humidity_pct'];

// 藥物目錄。顯示名稱在 locales 的 med.<code>。
// category 決定用藥過度提醒的門檻（ICHD-3）：simple 一般止痛藥 ≥15 天/月；其他類 ≥10 天/月。
// 品牌藥若含咖啡因或其他成分（例如 EVE、普拿疼加強錠）歸為 combination。
// form 決定用量單位（顆 / 包 / 噴 / 支）。
export const MEDS = [
  // 一般止痛藥
  { code: 'panadol', category: 'simple', form: 'tablet' },           // 普拿疼（乙醯胺酚）
  { code: 'paracetamol', category: 'simple', form: 'tablet' },
  { code: 'ibuprofen', category: 'simple', form: 'tablet' },
  { code: 'naproxen', category: 'simple', form: 'tablet' },
  { code: 'aspirin', category: 'simple', form: 'tablet' },
  { code: 'loxonin', category: 'simple', form: 'tablet' },           // 樂松（洛索洛芬）
  { code: 'mefenamic_acid', category: 'simple', form: 'tablet' },
  // 複方止痛藥
  { code: 'eve', category: 'combination', form: 'tablet' },          // 布洛芬 + 鎮靜成分 + 咖啡因
  { code: 'panadol_extra', category: 'combination', form: 'tablet' }, // 乙醯胺酚 + 咖啡因
  { code: 'saridon', category: 'combination', form: 'tablet' },      // 散利痛
  { code: 'combination', category: 'combination', form: 'tablet' },  // 其他複方
  // 翠普登類
  { code: 'sumatriptan', category: 'triptan', form: 'tablet' },
  { code: 'rizatriptan', category: 'triptan', form: 'tablet' },
  { code: 'zolmitriptan', category: 'triptan', form: 'tablet' },
  { code: 'eletriptan', category: 'triptan', form: 'tablet' },
  { code: 'sumatriptan_nasal', category: 'triptan', form: 'spray' },
  { code: 'sumatriptan_injection', category: 'triptan', form: 'injection' },
  { code: 'triptan', category: 'triptan', form: 'tablet' },          // 其他翠普登
  // 麥角類、鴉片類
  { code: 'ergotamine', category: 'ergot', form: 'tablet' },
  { code: 'tramadol', category: 'opioid', form: 'tablet' },
  // 自行輸入名稱（以一般止痛藥計）
  { code: 'other_med', category: 'simple', form: 'tablet' },
];

export const MED_BY_CODE = Object.fromEntries(MEDS.map((m) => [m.code, m]));

// 服藥時機
export const MED_TIMINGS = ['prodrome', 'early', 'severe'];

// 用量選擇的步進
export const DOSE_STEP = 0.5;

// 疼痛位置。左右一律指「患者自己的」左右。
export const LOCATIONS = [
  'forehead_l', 'forehead_r', 'temple_l', 'temple_r', 'eye_l', 'eye_r', 'face_l', 'face_r',
  'vertex', 'occiput_l', 'occiput_r', 'neck_l', 'neck_r',
];

// 選項代碼（顯示文字在 locales）。後續可改由「設定」分頁自訂。
export const OPTIONS = {
  // 頭痛類型：使用者「被醫師告知」的類型，不是由本網站推測
  type: ['migraine', 'tension', 'cluster', 'other', 'unknown'],
  // 疼痛感覺（ICHD-3 診斷條件會參考疼痛性質，但這裡只記錄、不判斷）
  pain_quality: ['pulsating', 'pressing', 'stabbing', 'boring', 'burning', 'dull'],
  // 預兆：通常在頭痛前或頭痛時出現、持續 5–60 分鐘。motor / speech 第一次出現時需提醒就醫。
  aura: ['visual', 'sensory', 'speech', 'motor', 'other_aura'],
  // 伴隨症狀（ICHD-3 偏頭痛診斷條件會用到）
  symptoms: ['nausea', 'vomiting', 'photophobia', 'phonophobia', 'osmophobia', 'activity', 'dizziness'],
  med_effect: ['none', 'partial', 'good', 'complete'],
  triggers: ['sleep', 'stress', 'weather', 'menstruation', 'alcohol', 'skipped_meal', 'screen', 'other_trigger'],
};

export const MOH_THRESHOLDS = { simple: 15, triptan: 10, combination: 10, opioid: 10, ergot: 10 };

export function newId() {
  return crypto.randomUUID();
}

// ---------- 用藥欄位的序列化 ----------

const clean = (s) => String(s ?? '').replace(/[;:]/g, ' ').trim();

export function serializeMeds(meds) {
  return (meds ?? []).map((m) => {
    const parts = [m.code, m.amount ?? '', m.timing ?? ''];
    if (m.name) parts.push(clean(m.name));
    return parts.join(':').replace(/:+$/, '');
  }).join(';');
}

// 也接受舊格式（只有代碼，例如 "ibuprofen;triptan"）
export function parseMeds(text) {
  return String(text ?? '').split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [code, amount, timing, ...name] = s.split(':');
    const n = Number(amount);
    return {
      code: MED_BY_CODE[code] ? code : 'other_med',
      amount: amount && Number.isFinite(n) ? n : null,
      timing: MED_TIMINGS.includes(timing) ? timing : '',
      name: MED_BY_CODE[code] ? name.join(' ').trim() : (name.join(' ').trim() || code),
    };
  });
}

// 本機快取可能還是舊格式（代碼字串陣列），統一轉成物件陣列
export function normalizeMeds(v) {
  if (typeof v === 'string') return parseMeds(v);
  if (!Array.isArray(v)) return [];
  if (v.every((m) => typeof m === 'object' && m)) return v;
  return parseMeds(v.map((m) => (typeof m === 'string' ? m : serializeMeds([m]))).join(';'));
}

// ---------- 列 ↔ 物件 ----------

// 物件 → 依標題列順序排出的一列
export function recordToRow(record, headers) {
  return headers.map((h) => {
    const v = record[h];
    if (h === 'meds') return serializeMeds(v);
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(';');
    if (typeof v === 'number') return v;
    return String(v);
  });
}

// 一列 → 物件；ID 為空或格式不符的列回傳 null（讀取時略過）
export function rowToRecord(row, headers) {
  const r = {};
  headers.forEach((h, i) => {
    if (!h) return;
    r[h] = row[i] ?? '';
  });
  if (!r.id) return null;
  for (const f of MULTI_FIELDS) r[f] = r[f] ? String(r[f]).split(';').filter(Boolean) : [];
  r.meds = parseMeds(r.meds);
  for (const f of NUMERIC_FIELDS) r[f] = r[f] === '' || r[f] == null ? null : Number(r[f]);
  return r;
}
