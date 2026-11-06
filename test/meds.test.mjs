// 用藥欄位的序列化：服藥時間（@YYYY-MM-DDTHHmm）要能來回轉換，且舊格式照常讀取
// 執行：node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeMeds, parseMeds } from '../js/schema.js';
import { medDayOffset, defaultMedDay, dayDiff } from '../js/stats.js';
import { medDayLabel } from '../js/widgets.js';

test('服藥時間來回轉換（含自訂藥名、沒有藥名、沒有時間）', () => {
  const meds = [
    { code: 'eve', amount: 1, timing: 'early', name: '', at: '2026-11-05T14:32' },
    { code: 'other_med', amount: 0.5, timing: '', name: 'Fioricet', at: '' },
    { code: 'other_med', amount: 1, timing: 'severe', name: 'Foo', at: '2026-11-06T01:05' },
  ];
  const text = serializeMeds(meds);
  assert.equal(text, 'eve:1:early::@2026-11-05T1432;other_med:0.5::Fioricet;other_med:1:severe:Foo:@2026-11-06T0105');
  assert.deepEqual(parseMeds(text), meds);
});

test('舊格式沒有服藥時間', () => {
  assert.deepEqual(parseMeds('eve:1:early;ibuprofen'), [
    { code: 'eve', amount: 1, timing: 'early', name: '', at: '' },
    { code: 'ibuprofen', amount: null, timing: '', name: '', at: '' },
  ]);
});

test('第一次選服藥時間：早於開始時間 → 預設隔天', () => {
  assert.equal(defaultMedDay('2026-11-05T09:00', '10:00'), 0);
  assert.equal(defaultMedDay('2026-11-05T23:10', '01:30'), 1);
  assert.equal(defaultMedDay('', '01:30'), 0);
});

test('服藥日相對於開始那天', () => {
  const t = (k, p) => ({ 'form.day0': '當天', 'form.day1': '隔天', 'form.dayN': `第 ${p?.n} 天` }[k]);
  assert.equal(medDayOffset('2026-11-05T09:00', '2026-11-05T23:00'), 0);
  assert.equal(medDayOffset('2026-11-05T23:00', '2026-11-06T01:00'), 1);
  assert.equal(medDayOffset('2026-10-31T09:00', '2026-11-02T10:00'), 2); // 跨月
  assert.equal(medDayOffset('2026-11-05T09:00', ''), 0);
  assert.equal(dayDiff('2026-03-07', '2026-03-09'), 2);
  assert.equal(medDayLabel(t, 1, '2026-11-05'), '隔天');
  assert.equal(medDayLabel(t, 2, '2026-11-05'), '第 3 天');
});
