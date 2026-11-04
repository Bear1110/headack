// 用藥欄位的序列化：服藥時間（@YYYY-MM-DDTHHmm）要能來回轉換，且舊格式照常讀取
// 執行：node --test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeMeds, parseMeds } from '../js/schema.js';
import { medTimeOnStart } from '../js/stats.js';

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

test('服藥時間早於開始時間 → 跨過午夜算隔天', () => {
  assert.equal(medTimeOnStart('2026-11-05T09:00', '10:00'), '2026-11-05T10:00');
  assert.equal(medTimeOnStart('2026-11-05T23:10', '01:30'), '2026-11-06T01:30');
  assert.equal(medTimeOnStart('2026-12-31T23:10', '00:30'), '2027-01-01T00:30');
  assert.equal(medTimeOnStart('2026-11-05T09:00', ''), '');
});
