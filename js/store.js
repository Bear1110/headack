import { normalizeMeds } from './schema.js';

// 本機優先（local-first）：所有寫入先進 localStorage 的待送佇列並立即反映在畫面上，
// 有權杖、有網路時再同步到試算表。頭痛發作時存檔不必等登入或網路。

const CACHE_KEY = 'hl.records';
const OUTBOX_KEY = 'hl.outbox';
const SHEET_KEY = 'hl.sheetId';

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 空間不足或無痕模式 */ }
}

// 舊版快取的欄位格式轉換
const migrate = (r) => ({ ...r, meds: normalizeMeds(r.meds), locations: r.locations ?? [], aura: r.aura ?? [], symptoms: r.symptoms ?? [] });

let records = read(CACHE_KEY, []).map(migrate);
let outbox = read(OUTBOX_KEY, []).map((op) => (op.record ? { ...op, record: migrate(op.record) } : op)); // [{ type: 'upsert', record, isNew } | { type: 'delete', id }]
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

export function saveRecord(record, { isNew }) {
  applyUpsert(records, record);
  const existing = outbox.find((op) => !inFlight.has(op) && op.type === 'upsert' && op.record.id === record.id);
  if (existing) {
    existing.record = record; // 合併同一筆尚未送出的修改
  } else {
    outbox.push({ type: 'upsert', record, isNew });
  }
  persist();
}

export function deleteRecord(id) {
  records = records.filter((r) => r.id !== id);
  const isQueued = (op) => !inFlight.has(op) && op.type === 'upsert' && op.record.id === id;
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
export function sync(sheet, token) {
  if (syncing) return syncing;
  syncing = (async () => {
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
        else await sheet.update(token, op.record);
        outbox = outbox.filter((o) => !inFlight.has(o));
        inFlight.clear();
        persist();
      }
      const { records: remote } = await sheet.readAll(token);
      // 讀取期間使用者可能又存了新東西：把仍在佇列中的變更疊回去
      records = remote;
      for (const op of outbox) {
        if (op.type === 'delete') records = records.filter((r) => r.id !== op.id);
        else applyUpsert(records, op.record);
      }
      persist();
    } finally {
      inFlight.clear();
      syncing = null;
    }
  })();
  return syncing;
}

// 換帳號或登出時清除本機資料
export function clearLocal() {
  records = [];
  outbox = [];
  try { localStorage.removeItem(SHEET_KEY); } catch { /* ignore */ }
  persist();
}
