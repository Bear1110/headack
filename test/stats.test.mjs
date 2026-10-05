// 統計邏輯的測試：這些數字會拿給醫師看，邊界條件（跨夜、跨月、用藥門檻）要釘住。
// 執行：node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysCovered, localDate, monthStats } from '../js/stats.js';
import { MEDS, MOH_THRESHOLDS, normalizeRecord } from '../js/schema.js';

// 依類別挑一個真實的藥品代碼，Schema 改了測試也不用跟著改
const codeOf = (category) => MEDS.find((m) => m.category === category).code;
const SIMPLE = codeOf('simple');
const TRIPTAN = codeOf('triptan');
const COMBO = codeOf('combination');

const rec = (start, extra = {}) => ({ id: start, start, ...extra });
const med = (code) => ({ code, amount: 1 });
// 在指定月份連續 n 天，每天一筆有用藥的紀錄
const medDaysIn = (month, n, codes, from = 1) =>
  Array.from({ length: n }, (_, i) => rec(`${month}-${String(from + i).padStart(2, '0')}T09:00`, { meds: codes.map(med) }));

// ---------- daysCovered ----------

test('沒有結束時間：只算開始那天', () => {
  assert.deepEqual(daysCovered(rec('2026-03-10T22:00')), ['2026-03-10']);
});

test('同一天結束：一天', () => {
  assert.deepEqual(daysCovered(rec('2026-03-10T08:00', { end: '2026-03-10T23:59' })), ['2026-03-10']);
});

test('跨夜：算兩天', () => {
  assert.deepEqual(daysCovered(rec('2026-03-10T22:00', { end: '2026-03-11T02:00' })), ['2026-03-10', '2026-03-11']);
});

test('跨月：日期逐日列出', () => {
  assert.deepEqual(daysCovered(rec('2026-01-31T20:00', { end: '2026-02-02T01:00' })), ['2026-01-31', '2026-02-01', '2026-02-02']);
});

test('沒有開始時間：空陣列', () => {
  assert.deepEqual(daysCovered({ id: 'x' }), []);
  assert.deepEqual(daysCovered({ id: 'x', start: '' }), []);
});

test('結束早於開始（資料有誤）：讀入時當作沒有結束，只算開始那天', () => {
  const r = normalizeRecord(rec('2026-03-10T08:00', { end: '2026-03-09T08:00' }));
  assert.equal(r.end, '');
  assert.deepEqual(daysCovered(r), ['2026-03-10']);
  assert.equal(normalizeRecord(rec('2026-03-10T08:00', { end: '2026-03-10T09:00' })).end, '2026-03-10T09:00');
});

test('超長區間最多 31 天，避免壞資料卡死', () => {
  assert.equal(daysCovered(rec('2026-01-01T00:00', { end: '2027-01-01T00:00' })).length, 31);
});

// ---------- localDate ----------

test('localDate 補零', () => {
  assert.equal(localDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(localDate(new Date(2026, 11, 25)), '2026-12-25');
});

// ---------- monthStats：頭痛天數、次數、強度 ----------

test('沒有紀錄：全部為零，平均強度為 null', () => {
  assert.deepEqual(monthStats([], '2026-03'), {
    headacheDays: 0, medDays: 0, episodes: 0, avgIntensity: null, typeCounts: {}, mohWarnings: [],
  });
});

test('同一天兩次頭痛：天數 1、次數 2', () => {
  const s = monthStats([rec('2026-03-10T08:00', { end: '2026-03-10T10:00' }), rec('2026-03-10T20:00')], '2026-03');
  assert.equal(s.headacheDays, 1);
  assert.equal(s.episodes, 2);
});

test('跨夜頭痛：兩天、一次', () => {
  const s = monthStats([rec('2026-03-10T22:00', { end: '2026-03-11T03:00' })], '2026-03');
  assert.equal(s.headacheDays, 2);
  assert.equal(s.episodes, 1);
});

test('跨月頭痛：兩個月都算頭痛天，但只算在開始那個月的次數與強度', () => {
  const records = [rec('2026-01-31T22:00', { end: '2026-02-01T03:00', intensity: 8 })];
  const jan = monthStats(records, '2026-01');
  const feb = monthStats(records, '2026-02');
  assert.equal(jan.headacheDays, 1);
  assert.equal(jan.episodes, 1);
  assert.equal(jan.avgIntensity, 8);
  assert.equal(feb.headacheDays, 1);
  assert.equal(feb.episodes, 0);
  assert.equal(feb.avgIntensity, null);
});

test('其他月份的紀錄不計入', () => {
  const s = monthStats([rec('2026-02-28T08:00'), rec('2026-04-01T08:00')], '2026-03');
  assert.equal(s.headacheDays, 0);
  assert.equal(s.episodes, 0);
});

test('平均強度只算有數字的紀錄', () => {
  const s = monthStats([
    rec('2026-03-01T08:00', { intensity: 4 }),
    rec('2026-03-02T08:00', { intensity: 8 }),
    rec('2026-03-03T08:00'),
    rec('2026-03-04T08:00', { intensity: null }),
  ], '2026-03');
  assert.equal(s.avgIntensity, 6);
  assert.equal(s.episodes, 4);
});

test('類型統計：沒填的歸為 unknown', () => {
  const s = monthStats([
    rec('2026-03-01T08:00', { type: 'migraine' }),
    rec('2026-03-02T08:00', { type: 'migraine' }),
    rec('2026-03-03T08:00', { type: 'tension' }),
    rec('2026-03-04T08:00'),
  ], '2026-03');
  assert.deepEqual(s.typeCounts, { migraine: 2, tension: 1, unknown: 1 });
});

// ---------- monthStats：用藥天數與藥物過度使用（MOH）門檻 ----------

test('用藥天數：同一天吃兩次算一天；沒用藥的不算', () => {
  const s = monthStats([
    rec('2026-03-01T08:00', { meds: [med(SIMPLE)] }),
    rec('2026-03-01T20:00', { meds: [med(SIMPLE)] }),
    rec('2026-03-02T08:00'),
  ], '2026-03');
  assert.equal(s.medDays, 1);
  assert.equal(s.headacheDays, 2);
});

test('一般止痛藥：14 天不警告、15 天警告', () => {
  assert.equal(MOH_THRESHOLDS.simple, 15);
  assert.deepEqual(monthStats(medDaysIn('2026-03', 14, [SIMPLE]), '2026-03').mohWarnings, []);
  assert.deepEqual(monthStats(medDaysIn('2026-03', 15, [SIMPLE]), '2026-03').mohWarnings, [{ cat: 'simple', n: 15, limit: 15 }]);
});

test('翠普登：9 天不警告、10 天警告', () => {
  assert.equal(MOH_THRESHOLDS.triptan, 10);
  assert.deepEqual(monthStats(medDaysIn('2026-03', 9, [TRIPTAN]), '2026-03').mohWarnings, []);
  assert.deepEqual(monthStats(medDaysIn('2026-03', 10, [TRIPTAN]), '2026-03').mohWarnings, [{ cat: 'triptan', n: 10, limit: 10 }]);
});

test('複方：10 天警告', () => {
  assert.deepEqual(monthStats(medDaysIn('2026-03', 10, [COMBO]), '2026-03').mohWarnings, [{ cat: 'combination', n: 10, limit: 10 }]);
});

test('多類合併：各自未達門檻，但合計 ≥10 天就警告', () => {
  const records = [...medDaysIn('2026-03', 6, [SIMPLE], 1), ...medDaysIn('2026-03', 5, [TRIPTAN], 10)];
  const s = monthStats(records, '2026-03');
  assert.equal(s.medDays, 11);
  assert.deepEqual(s.mohWarnings, [{ cat: 'acuteMixed', n: 11, limit: 10 }]);
});

test('多類合併：合計 9 天不警告', () => {
  const records = [...medDaysIn('2026-03', 5, [SIMPLE], 1), ...medDaysIn('2026-03', 4, [TRIPTAN], 10)];
  assert.deepEqual(monthStats(records, '2026-03').mohWarnings, []);
});

test('單一類別已達門檻時，不再重複報合併警告', () => {
  const records = [...medDaysIn('2026-03', 10, [TRIPTAN], 1), ...medDaysIn('2026-03', 2, [SIMPLE], 15)];
  const s = monthStats(records, '2026-03');
  assert.equal(s.mohWarnings.length, 1);
  assert.equal(s.mohWarnings[0].cat, 'triptan');
});

test('同一天吃兩類藥：合併計算時同一天只算一次', () => {
  const s = monthStats(medDaysIn('2026-03', 9, [SIMPLE, TRIPTAN]), '2026-03');
  assert.equal(s.medDays, 9);
  assert.deepEqual(s.mohWarnings, []);
});

test('不認得的藥品代碼：視為一般止痛藥（門檻 15）', () => {
  assert.deepEqual(monthStats(medDaysIn('2026-03', 14, ['mystery_pill']), '2026-03').mohWarnings, []);
  assert.equal(monthStats(medDaysIn('2026-03', 15, ['mystery_pill']), '2026-03').mohWarnings[0].cat, 'simple');
});

test('用藥日以開始日為準：跨月的頭痛，藥算在開始那個月', () => {
  const records = [rec('2026-01-31T22:00', { end: '2026-02-01T03:00', meds: [med(SIMPLE)] })];
  assert.equal(monthStats(records, '2026-01').medDays, 1);
  assert.equal(monthStats(records, '2026-02').medDays, 0);
});
