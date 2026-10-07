import { normalizeMeds, normalizeRecord } from './schema.js';

// 本機優先（local-first）：所有寫入先進 localStorage 的待送佇列並立即反映在畫面上，
// 有權杖、有網路時再同步到試算表。頭痛發作時存檔不必等登入或網路。

// 示範模式：用另一組儲存鍵（hl.demo.*），與真實紀錄完全隔離；切換時重新載入頁面
const DEMO_FLAG = 'hl.demoMode';
let demo = false;
try { demo = localStorage.getItem(DEMO_FLAG) === '1'; } catch { /* ignore */ }
const PREFIX = demo ? 'hl.demo.' : 'hl.';

const CACHE_KEY = `${PREFIX}records`;
const OUTBOX_KEY = `${PREFIX}outbox`;
const SHEET_KEY = `${PREFIX}sheetId`;

export function isDemo() {
  return demo;
}

// 進入示範：寫入範例資料（只放進示範用的儲存鍵）。呼叫後請重新載入頁面。
export function enterDemo(sampleRecords) {
  try {
    localStorage.setItem('hl.demo.records', JSON.stringify(sampleRecords));
    localStorage.setItem('hl.demo.outbox', '[]');
    localStorage.setItem(DEMO_FLAG, '1');
  } catch { /* ignore */ }
}

// 離開示範：丟掉示範資料。呼叫後請重新載入頁面。
export function exitDemo() {
  try {
    ['hl.demo.records', 'hl.demo.outbox', 'hl.demo.sheetId', DEMO_FLAG].forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 空間不足或無痕模式 */ }
}

// 舊版快取的欄位格式轉換
const migrate = (r) => normalizeRecord({ ...r, meds: normalizeMeds(r.meds), locations: r.locations ?? [], pain_quality: r.pain_quality ?? [], aura: r.aura ?? [], symptoms: r.symptoms ?? [] });

let records = read(CACHE_KEY, []).map(migrate);
let outbox = read(OUTBOX_KEY, []).map((op) => (op.record ? { ...op, record: migrate(op.record) } : op)); // 項目格式見 saveRecord 上方說明
const listeners = new Set();

function persist() {
  write(CACHE_KEY, records);
  write(OUTBOX_KEY, outbox);
  listeners.forEach((fn) => fn());
}

export function onChange(fn) {
  listeners.add(fn);
}

export function getRecords() {
  return records;
}

export function pendingCount() {
  return outbox.length;
}

export function getCachedSheetId() {
  return read(SHEET_KEY, null);
}

export function setCachedSheetId(id) {
  write(SHEET_KEY, id);
}

function applyUpsert(list, record) {
  const i = list.findIndex((r) => r.id === record.id);
  if (i >= 0) list[i] = record;
  else list.push(record);
}

// 待送佇列的項目：
// - { type: 'upsert', record, isNew }：新紀錄整筆送（雲端還沒有這一列）。舊版留下的整筆修改也是這個格式。
// - { type: 'patch', id, changes, base }：修改只記「改了哪些欄位」與改之前的值，同步時只寫這些欄位，
//   不會用本機的舊資料蓋掉別台裝置改過的其他欄位。
// - { type: 'delete', id }
const opId = (op) => op.id ?? op.record.id;
const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

export function saveRecord(record, { isNew }) {
  const old = records.find((r) => r.id === record.id);
  applyUpsert(records, record);
  const existing = outbox.find((op) => !inFlight.has(op) && op.type !== 'delete' && opId(op) === record.id);
  if (existing?.type === 'upsert') {
    existing.record = record; // 合併同一筆尚未送出的新增
  } else if (isNew || !old) {
    outbox.push({ type: 'upsert', record, isNew });
  } else {
    const changes = {};
    const base = {};
    for (const k of new Set([...Object.keys(old), ...Object.keys(record)])) {
      if (same(old[k], record[k])) continue;
      changes[k] = record[k] ?? '';
      base[k] = old[k] ?? '';
    }
    if (existing) { // 合併同一筆尚未送出的修改：base 保留最早的值
      for (const k of Object.keys(changes)) if (!(k in existing.base)) existing.base[k] = base[k];
      Object.assign(existing.changes, changes);
    } else if (Object.keys(changes).length) {
      outbox.push({ type: 'patch', id: record.id, changes, base });
    }
  }
  persist();
}

export function deleteRecord(id) {
  records = records.filter((r) => r.id !== id);
  const isQueued = (op) => !inFlight.has(op) && op.type !== 'delete' && opId(op) === id;
  const queuedNew = outbox.find((op) => isQueued(op) && op.isNew);
  outbox = outbox.filter((op) => !isQueued(op));
  if (!queuedNew) outbox.push({ type: 'delete', id }); // 還沒送出的新紀錄，直接丟掉即可
  persist();
}

// 匯入：一次加入多筆新紀錄（只觸發一次儲存與重繪）
export function importRecords(list) {
  for (const record of list) {
    applyUpsert(records, record);
    outbox.push({ type: 'upsert', record, isNew: true });
  }
  persist();
}

let syncing = null;
const inFlight = new Set(); // 正在送出的項目，不可再被合併或移除
const APPEND_BATCH = 500;

// 依序送出待送佇列，再從試算表讀回最新資料。任何一步失敗就停下，佇列保留到下次。
// 回傳 { conflicts }：有幾筆因為雲端有較新修改或已被刪除，而改採雲端版本
export function sync(sheet, token) {
  if (syncing) return syncing;
  syncing = (async () => {
    let conflicts = 0;
    try {
      while (outbox.length) {
        // 連續的新增合併成一次 append，避免大量匯入時撞到每分鐘請求上限
        const batch = [];
        for (const op of outbox) {
          if (!(op.type === 'upsert' && op.isNew) || batch.length >= APPEND_BATCH) break;
          batch.push(op);
        }
        const ops = batch.length ? batch : [outbox[0]];
        ops.forEach((op) => inFlight.add(op));
        const [op] = ops;
        if (batch.length) await sheet.append(token, batch.map((o) => o.record));
        else if (op.type === 'delete') await sheet.remove(token, op.id);
        else if (op.type === 'patch') { if (await sheet.patch(token, op.id, op.changes, op.base) !== 'ok') conflicts += 1; }
        else if (await sheet.update(token, op.record) !== 'ok') conflicts += 1;
        outbox = outbox.filter((o) => !inFlight.has(o));
        inFlight.clear();
        persist();
      }
      const { records: remote } = await sheet.readAll(token);
      // 讀取期間使用者可能又存了新東西：把仍在佇列中的變更疊回去
      records = remote;
      for (const op of outbox) {
        if (op.type === 'delete') records = records.filter((r) => r.id !== op.id);
        else if (op.type === 'patch') {
          const r = records.find((x) => x.id === op.id);
          if (r) applyUpsert(records, { ...r, ...op.changes });
        } else applyUpsert(records, op.record);
      }
      persist();
      return { conflicts };
    } finally {
      inFlight.clear();
      syncing = null;
    }
  })();
  return syncing;
}

// 等目前的同步結束（清空資料前呼叫，避免同步中途又把紀錄寫回去）
export function whenIdle() {
  return (syncing ?? Promise.resolve()).catch(() => {});
}

// 清空所有紀錄與待送佇列（保留試算表的綁定）
export function clearRecords() {
  records = [];
  outbox = [];
  persist();
}

// 換帳號或登出時清除本機資料
export function clearLocal() {
  records = [];
  outbox = [];
  try { localStorage.removeItem(SHEET_KEY); } catch { /* ignore */ }
  persist();
}
