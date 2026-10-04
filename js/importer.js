// 匯入：使用者把自己在別處的頭痛資料（筆記、其他 App、聊天紀錄）交給任一 AI，
// 搭配本網站產生的提示詞轉成 JSON，再貼回來匯入。
//
// 本網站不會把使用者的資料送給任何 AI：提示詞裡只有格式說明，資料由使用者自己貼到 AI。
// 解析刻意寬鬆：允許 ```json 圍欄、前後說明文字、各語言的選項名稱。

import { OPTIONS, MEDS, MED_TIMINGS, LOCATIONS, newId } from './schema.js';
import en from './locales/en.js';
import zhTW from './locales/zh-TW.js';
import zhCN from './locales/zh-CN.js';
import ja from './locales/ja.js';

export const IMPORT_FORMAT = 'headache-log';
export const IMPORT_VERSION = 1;

const ALL_LOCALES = [en, zhTW, zhCN, ja];
const MED_CODES = MEDS.map((m) => m.code);

// ---------- 提示詞 ----------

// 選項只列英文名稱：AI 能自行對應各語言的寫法，且網址參數不會因編碼中文而過長
export function buildPrompt() {
  const list = (prefix, codes) => codes.map((c) => `  - ${c}: ${en[`${prefix}.${c}`]}`).join('\n');
  const timings = MED_TIMINGS.map((x) => `"${x}" (${en[`timing.${x}`]})`).join(', ');

  return `You are helping me import my headache history into a headache diary app.
After this message I will paste my notes. Convert every headache episode in them into JSON in exactly this format, and reply with ONLY the JSON in a single code block:

{
  "format": "${IMPORT_FORMAT}",
  "version": ${IMPORT_VERSION},
  "records": [
    {
      "start": "2026-09-30T14:30",
      "end": "2026-09-30T18:00",
      "intensity": 6,
      "type": "migraine",
      "locations": ["temple_r", "eye_r"],
      "aura": ["visual"],
      "symptoms": ["nausea", "photophobia"],
      "meds": [
        { "code": "eve", "amount": 1, "timing": "early" },
        { "code": "other_med", "name": "Fioricet", "amount": 0.5, "timing": "severe" }
      ],
      "med_effect": "good",
      "triggers": ["sleep"],
      "notes": ""
    }
  ]
}

Rules:
- One record per headache episode.
- "start" is required. Use local time "YYYY-MM-DDTHH:mm". If only the date is known, use "YYYY-MM-DD". If the year is not stated, ask me instead of guessing.
- "end": same format, or "" if unknown.
- "intensity": integer 0-10, or null if unknown. Convert other scales (e.g. mild/moderate/severe ≈ 3/6/9).
- "type": one of these codes, or "" if unknown:
${list('opt.type', OPTIONS.type)}
- "locations": where it hurt, as a list of codes ("_l" / "_r" = my own left / right), or []:
${list('loc', LOCATIONS)}
- "aura": aura symptoms before or during the headache (usually 5-60 min), list of codes, or []:
${list('opt.aura', OPTIONS.aura)}
- "symptoms": other symptoms during the headache, list of codes, or []:
${list('opt.symptoms', OPTIONS.symptoms)}
- "meds": one object per dose taken.
  - "code": from the list below. Map brand names to the matching code. If nothing matches, use "other_med" and put the real name in "name".
  - "amount": number of tablets / sprays / injections (0.5 steps), or null if unknown.
  - "timing": one of ${timings}, or "".
${list('med', MED_CODES)}
- "med_effect": one code, or "":
${list('opt.med_effect', OPTIONS.med_effect)}
- "triggers": list of codes. Unlisted triggers → "other_trigger" and describe them in "notes".
${list('opt.triggers', OPTIONS.triggers)}
- "notes": anything else worth keeping, in the original language of my notes.
- Do not invent data that is not in my notes.

My notes:
`;
}

// 直接開啟 AI 並帶入提示詞（只含格式說明，不含使用者資料）
export function aiLinks(prompt) {
  const q = encodeURIComponent(prompt);
  return {
    chatgpt: `https://chatgpt.com/?q=${q}`,
    claude: `https://claude.ai/new?q=${q}`,
  };
}

// ---------- 解析 ----------

// 從貼上的文字中取出 JSON（容許 ``` 圍欄與前後說明文字）
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(body); } catch { /* 往下嘗試 */ }
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end <= start) throw new Error('no_json');
  return JSON.parse(body.slice(start, end + 1));
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

// 顯示名稱拆出別名：「Sumatriptan（英明格）」→ Sumatriptan、英明格
const aliases = (label) => [label, ...label.split(/[（）()、／/]/)].map(norm).filter((s) => s.length > 1);

// 代碼或任一語言的顯示名稱（含括號內的品牌名）→ 代碼；先登記者優先
function buildLookup(prefix, codes) {
  const map = new Map();
  for (const c of codes) map.set(norm(c), c);
  for (const c of codes) {
    for (const loc of ALL_LOCALES) {
      const label = loc[`${prefix}.${c}`];
      if (typeof label !== 'string') continue;
      for (const a of aliases(label)) if (!map.has(a)) map.set(a, c);
    }
  }
  return map;
}

const lookups = {
  type: buildLookup('opt.type', OPTIONS.type),
  meds: buildLookup('med', MED_CODES),
  med_effect: buildLookup('opt.med_effect', OPTIONS.med_effect),
  triggers: buildLookup('opt.triggers', OPTIONS.triggers),
  locations: buildLookup('loc', LOCATIONS),
  aura: buildLookup('opt.aura', OPTIONS.aura),
  symptoms: buildLookup('opt.symptoms', OPTIONS.symptoms),
  timing: buildLookup('timing', MED_TIMINGS),
};

function toList(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  return String(v).split(/[,;、，]/);
}

// 一次用藥：接受物件 { code / name, amount, timing } 或單純的藥名字串
function normMed(item) {
  const obj = typeof item === 'object' && item ? item : { code: item };
  if (!norm(obj.code) && !norm(obj.name)) return null;
  const code = lookups.meds.get(norm(obj.code)) ?? lookups.meds.get(norm(obj.name)) ?? 'other_med';
  const amount = Number(obj.amount);
  const hasAmount = obj.amount != null && obj.amount !== '' && Number.isFinite(amount) && amount > 0;
  return {
    code,
    amount: hasAmount ? Math.round(amount * 2) / 2 : null,
    timing: lookups.timing.get(norm(obj.timing)) ?? '',
    name: code === 'other_med' ? String(obj.name || obj.code || '').trim() : '',
  };
}

// 時間 → "YYYY-MM-DDTHH:mm"；只有日期時補 00:00
function normTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const p = (n) => String(n).padStart(2, '0');
  const [, y, mo, d, h = '0', mi = '0'] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}`;
}

// 天氣欄位：匯入本網站匯出的檔案時保留（AI 整理的資料通常沒有）
const WEATHER_FIELDS = ['pressure_hpa', 'pressure_change_24h', 'temp_c', 'humidity_pct'];
function weatherFields(raw) {
  const out = {};
  for (const f of WEATHER_FIELDS) {
    const v = Number(raw[f]);
    if (raw[f] !== '' && raw[f] != null && Number.isFinite(v)) out[f] = v;
  }
  return out;
}

// ---------- 匯出 ----------

// 匯出格式與匯入格式相同，可直接匯回本網站，或交給 AI / 其他工具使用
const EXPORT_FIELDS = ['start', 'end', 'intensity', 'type', 'locations', 'aura', 'symptoms', 'meds', 'med_effect', 'triggers', 'notes', ...WEATHER_FIELDS, 'created_at', 'updated_at'];
export function buildExport(records) {
  const list = [...records]
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''))
    .map((r) => {
      const out = {};
      for (const f of EXPORT_FIELDS) {
        let v = r[f];
        if (v == null || v === '') continue;
        if (f === 'meds') v = v.map((m) => Object.fromEntries(Object.entries(m).filter(([, x]) => x !== '' && x != null)));
        if (Array.isArray(v) && !v.length) continue;
        out[f] = v;
      }
      return out;
    });
  return {
    format: IMPORT_FORMAT,
    version: IMPORT_VERSION,
    exported_at: new Date().toISOString(),
    records: list,
  };
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'not_object' };
  const start = normTime(raw.start ?? raw.date);
  if (!start) return { error: 'bad_start' };
  let end = normTime(raw.end);
  if (end === null || (end && end < start)) end = '';

  let intensity = raw.intensity === '' || raw.intensity == null ? null : Math.round(Number(raw.intensity));
  if (!Number.isFinite(intensity)) intensity = null;
  else intensity = Math.min(10, Math.max(0, intensity));

  // 未知的誘發因子 → other_trigger，原文放進備註
  const extraNotes = [];
  const triggers = new Set();
  for (const item of toList(raw.triggers)) {
    if (!norm(item)) continue;
    const code = lookups.triggers.get(norm(item));
    if (code) triggers.add(code);
    else {
      triggers.add('other_trigger');
      extraNotes.push(String(item).trim());
    }
  }

  const meds = toList(raw.meds).map(normMed).filter(Boolean);
  const codes = (field) => [...new Set(toList(raw[field]).map((x) => lookups[field].get(norm(x))).filter(Boolean))];
  const locations = codes('locations');
  const aura = codes('aura');
  const symptoms = codes('symptoms');
  const type = lookups.type.get(norm(raw.type)) ?? '';
  const med_effect = lookups.med_effect.get(norm(raw.med_effect)) ?? '';
  const notes = [String(raw.notes ?? '').trim(), ...extraNotes].filter(Boolean).join('; ');

  return {
    record: {
      id: newId(), start, end, intensity, type, locations, aura, symptoms, meds, med_effect, triggers: [...triggers], notes,
      ...weatherFields(raw),
    },
  };
}

// 回傳 { records, duplicates, errors: [{ index, error }] }
// 與既有紀錄（或同批）開始時間「且」備註都相同者視為重複，略過。
// 只比開始時間不夠：只有日期的舊資料，同一天可能有好幾次發作（例如叢集型頭痛）。
export function parseImport(text, existing) {
  const data = extractJson(text);
  const rows = Array.isArray(data) ? data : data?.records;
  if (!Array.isArray(rows)) throw new Error('no_records');

  const key = (r) => `${r.start}|${String(r.notes ?? '').trim()}`;
  const seen = new Set(existing.map(key));
  const records = [];
  const errors = [];
  let duplicates = 0;
  rows.forEach((raw, index) => {
    const { record, error } = normalize(raw);
    if (error) return errors.push({ index, error });
    if (seen.has(key(record))) return duplicates++;
    seen.add(key(record));
    records.push(record);
  });
  records.sort((a, b) => a.start.localeCompare(b.start));
  return { records, duplicates, errors };
}
