// 兩台裝置同步的測試：用假的 Google Sheets（攔截 fetch）跑真正的 store.js / sheets.js。
// 重點：本機拿舊資料做的修改（例如背景補天氣）不可以蓋掉別台裝置改過的其他欄位。
// 執行：node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Spreadsheet } from '../js/sheets.js';
import { RECORD_COLUMNS } from '../js/schema.js';

// ---------- 假的試算表：只實作 store / sheets 會用到的 values API ----------
function fakeSheets() {
  const rows = [[...RECORD_COLUMNS]];
  const cell = (ref) => {
    const [, col, row] = ref.match(/^([A-Z]+)(\d+)$/);
    return { col: [...col].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1, row: Number(row) - 1 };
  };
  globalThis.fetch = async (url, { method = 'GET', body } = {}) => {
    const range = decodeURIComponent(new URL(url).pathname.split('/values/')[1]);
    const values = body ? JSON.parse(body).values : null;
    const ref = range.split('!')[1]?.replace(/:.*/, '');
    let data = {};
    if (method === 'GET' && !ref) data = { values: rows };
    else if (method === 'GET') { const { col, row } = cell(ref); data = { values: [[rows[row]?.[col] ?? '']] }; }
    else if (method === 'POST') rows.push(...values);
    else if (method === 'PUT') { const { col, row } = cell(ref); values[0].forEach((v, i) => { (rows[row] ??= [])[col + i] = v; }); }
    return { ok: true, status: 200, json: async () => data };
  };
  return rows;
}

// 每台裝置各自一份 localStorage 與一份 store 模組
const storages = {};
let current = null;
globalThis.localStorage = {
  getItem: (k) => storages[current][k] ?? null,
  setItem: (k, v) => { storages[current][k] = String(v); },
  removeItem: (k) => { delete storages[current][k]; },
};
async function device(name) {
  storages[name] = {};
  current = name;
  const store = await import(`../js/store.js?device=${name}`);
  return (fn) => { current = name; return fn(store); };
}

const T = (h) => `2026-10-0${h < 24 ? 5 : 6}T${String(h % 24).padStart(2, '0')}:00:00.000Z`;
const base = { id: 'r1', start: '2026-10-05T23:50', end: '', intensity: 1, type: '', locations: [], pain_quality: [], aura: [], symptoms: [], meds: [], med_effect: '', triggers: [], notes: '', pressure_hpa: null, pressure_change_24h: null, temp_c: null, humidity_pct: null, created_at: T(0), updated_at: T(0) };

test('背景補天氣用的是舊資料，也不會蓋掉另一台早上的修改', async () => {
  const rows = fakeSheets();
  const sheet = new Spreadsheet('sid', { 0: 'records' });
  const desk = await device('desk');
  const phone = await device('phone');

  // 1. 半夜桌機新增等級 1，同步上去
  await desk((s) => { s.saveRecord({ ...base }, { isNew: true }); return s.sync(sheet, 'tok'); });
  // 2. 早上手機改成等級 4、填結束時間、加用藥
  await phone(async (s) => {
    await s.sync(sheet, 'tok');
    const r = s.getRecords()[0];
    s.saveRecord({ ...r, intensity: 4, end: '2026-10-06T09:00', meds: [{ code: 'panadol', amount: 1, timing: 'early', name: '' }], updated_at: T(32) }, { isNew: false });
    return s.sync(sheet, 'tok');
  });
  // 3. 晚上桌機還拿著舊的等級 1，背景補天氣（修改時間＝晚上）後同步
  const { conflicts } = await desk((s) => {
    const r = s.getRecords()[0];
    assert.equal(r.intensity, 1);
    s.saveRecord({ ...r, pressure_hpa: 1012.5, temp_c: 24, updated_at: T(43) }, { isNew: false });
    return s.sync(sheet, 'tok');
  });

  assert.equal(conflicts, 0);
  const row = Object.fromEntries(RECORD_COLUMNS.map((c, i) => [c, rows[1][i]]));
  assert.equal(row.intensity, 4);
  assert.equal(row.end, '2026-10-06T09:00');
  assert.match(String(row.meds), /panadol/);
  assert.equal(row.pressure_hpa, 1012.5);
  assert.equal(row.updated_at, T(43));
  // 桌機同步後也拿到合併後的版本
  await desk((s) => assert.equal(s.getRecords()[0].intensity, 4));
});

test('兩台改到同一格：以較晚的修改為準，另一台沒衝突的欄位照樣寫入', async () => {
  const rows = fakeSheets();
  const sheet = new Spreadsheet('sid', { 0: 'records' });
  const a = await device('a');
  const b = await device('b');
  await a((s) => { s.saveRecord({ ...base }, { isNew: true }); return s.sync(sheet, 'tok'); });
  await b((s) => s.sync(sheet, 'tok'));

  // a 先改（較早），但比較晚才同步；b 後改同一格並先同步
  a((s) => s.saveRecord({ ...s.getRecords()[0], intensity: 2, notes: '從 a', updated_at: T(30) }, { isNew: false }));
  await b((s) => { s.saveRecord({ ...s.getRecords()[0], intensity: 6, updated_at: T(31) }, { isNew: false }); return s.sync(sheet, 'tok'); });
  const { conflicts } = await a((s) => s.sync(sheet, 'tok'));

  const row = Object.fromEntries(RECORD_COLUMNS.map((c, i) => [c, rows[1][i]]));
  assert.equal(conflicts, 1);
  assert.equal(row.intensity, 6); // b 比較晚改
  assert.equal(row.notes, '從 a'); // b 沒動 notes，a 的修改保留
  assert.equal(row.updated_at, T(31));
});

test('尚未送出的修改會合併成一筆，刪除會取消它', async () => {
  fakeSheets();
  const sheet = new Spreadsheet('sid', { 0: 'records' });
  const a = await device('c');
  await a(async (s) => {
    s.saveRecord({ ...base }, { isNew: true });
    await s.sync(sheet, 'tok');
    s.saveRecord({ ...s.getRecords()[0], intensity: 3, updated_at: T(30) }, { isNew: false });
    s.saveRecord({ ...s.getRecords()[0], notes: 'x', updated_at: T(31) }, { isNew: false });
    assert.equal(s.pendingCount(), 1);
    s.deleteRecord('r1');
    assert.equal(s.pendingCount(), 1); // 只剩刪除
  });
});
