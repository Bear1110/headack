import * as auth from './auth.js';
import * as store from './store.js';
import { openSpreadsheet, fetchEmail, ApiError } from './sheets.js';
import { OPTIONS, MED_BY_CODE, newId } from './schema.js';
import { createMedEditor, createHeadMap, medLabel, doseLabel } from './widgets.js';
import { t, getLang, setLang, initI18n, formatList, LANGS, dateLabel, clockLabel } from './i18n.js';
import { localDate, daysCovered, monthStats } from './stats.js';
import { createStatsView } from './statsview.js';
import { createQuickFlow } from './quickflow.js';
import { applyIcons, icon } from './icons.js';
import { APP_VERSION } from './version.js';
import { renderCalendar as calendarHtml } from './calendar.js';
import * as weather from './weather.js';

const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');
const isRtl = () => document.documentElement.dir === 'rtl';
// 一組 role=radio 按鈕：依 data-* 的值同步 aria-checked
const syncRadios = (selector, key, value) => document.querySelectorAll(selector).forEach((b) => b.setAttribute('aria-checked', String(b.dataset[key] === value)));

let sheet = null;
let syncState = 'idle'; // idle | syncing | error | offline
let authReady = false;
let editing = null; // 表單正在編輯的紀錄；null = 新增
let medEditor = null;
let headMap = null;

function nowLocal() {
  const d = new Date();
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${dateLabel(d)} ${clockLabel(d)}`;
}

function formatDuration(start, end) {
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (!(mins >= 0)) return '';
  return t('list.duration', { h: Math.floor(mins / 60), m: mins % 60 });
}

let toastTimer;
// action：{ label, run }，例如「復原」；有按鈕時停留久一點
function toast(msg, ms = 3000, action = null) {
  const el = $('#toast');
  el.innerHTML = `<span>${escapeHtml(msg)}</span>${action ? `<button type="button" class="toast-action">${icon(action.icon ?? 'undo')}${escapeHtml(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) {
    el.querySelector('.toast-action').addEventListener('click', () => {
      el.hidden = true;
      action.run();
    }, { once: true });
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? Math.max(ms, 6000) : ms);
}

// 手機上的觸覺回饋（支援的瀏覽器才會震動，例如 Android；iOS 網頁不支援，安靜略過）
const buzz = (ms = 20) => { try { navigator.vibrate?.(ms); } catch { /* ignore */ } };

// 刪除後可復原：把整筆紀錄當新紀錄加回去
function deleteWithUndo(record) {
  store.deleteRecord(record.id);
  trySync();
  toast(t('undo.deleted'), 6000, {
    label: t('undo.undo'),
    run: () => {
      store.saveRecord({ ...record, updated_at: new Date().toISOString() }, { isNew: true });
      trySync();
    },
  });
}

// ---------- 同步 ----------

async function trySync() {
  if (store.isDemo()) return render(); // 示範模式完全不連外
  const token = auth.getToken();
  if (!token) return render();
  if (!navigator.onLine) {
    syncState = 'offline';
    return render();
  }
  syncState = 'syncing';
  renderSync();
  try {
    if (!sheet) {
      sheet = await openSpreadsheet(token, { cachedId: store.getCachedSheetId(), title: t('app.sheetTitle') });
      store.setCachedSheetId(sheet.id);
    }
    const { conflicts } = await store.sync(sheet, token);
    syncState = 'idle';
    if (conflicts) toast(t('sync.conflicts', { n: conflicts }), 6000);
  } catch (e) {
    console.error(e);
    if (e instanceof ApiError && e.status === 401) {
      auth.invalidateToken(); // 權杖失效：等使用者按「重新連線」
      syncState = 'idle';
    } else {
      syncState = navigator.onLine ? 'error' : 'offline';
    }
  }
  render();
}

// 必須在點擊事件中同步呼叫（見 auth.requestToken）
function signIn() {
  auth.requestToken({ firstTime: !auth.getEmail() })
    .then(async (token) => {
      try {
        const email = await fetchEmail(token);
        const prev = auth.getEmail();
        if (prev && prev !== email) {
          // 換了帳號：改用新帳號的試算表。
          // TODO（待討論）：前一個帳號尚未同步的修改目前會送到新帳號。
          sheet = null;
          store.setCachedSheetId(null);
        }
        auth.setEmail(email);
      } catch (e) {
        console.warn('userinfo failed', e);
      }
      await trySync();
    })
    .catch((e) => {
      if (e.message === 'superseded') return;
      toast(e.message === 'popup_failed_to_open' ? t('error.popup') : t('error.auth'));
    });
}

function signOut() {
  auth.signOut();
  store.clearLocal();
  sheet = null;
  render();
}

// ---------- 紀錄操作 ----------

function save(record, isNew, { quiet = false } = {}) {
  const now = new Date().toISOString();
  record.updated_at = now;
  if (isNew) record.created_at = now;
  store.saveRecord(record, { isNew });
  if (!quiet) toast(t('log.saved'));
  trySync();
  fillWeather();
}

// ---------- 天氣 ----------

const weatherTried = new Set(); // 本次開啟頁面已查過的紀錄，避免重複請求
const hasWeather = (r) => r.pressure_hpa != null && r.pressure_hpa !== '';

// 為最近 48 小時內、還沒有天氣資料的紀錄補上天氣（背景執行，失敗就略過）
async function fillWeather() {
  if (store.isDemo() || weather.getPref() !== 'on' || !navigator.onLine) return;
  const due = store.getRecords().filter((r) => r.start && !hasWeather(r) && !weatherTried.has(r.id) && weather.isInWindow(r.start));
  if (!due.length) return;
  due.forEach((r) => weatherTried.add(r.id));
  let loc;
  try {
    loc = await weather.currentLocation();
  } catch (e) {
    console.warn('location unavailable', e);
    return;
  }
  let changed = false;
  for (const r of due) {
    try {
      const w = await weather.fetchWeather(r.start, loc);
      const current = store.getRecords().find((x) => x.id === r.id);
      if (w && current) {
        store.saveRecord({ ...current, ...w, updated_at: new Date().toISOString() }, { isNew: false });
        changed = true;
      }
    } catch (e) {
      console.warn('weather fetch failed', e);
    }
  }
  if (changed) trySync();
}

// 必須在點擊事件中呼叫（位置權限詢問）
function enableWeather() {
  weather.requestLocation()
    .then(() => {
      weather.setPref('on');
      render();
      fillWeather();
    })
    .catch(() => {
      weather.setPref('off');
      toast(t('weather.locationDenied'));
      render();
    });
}

function disableWeather() {
  weather.setPref('off');
  render();
}

function weatherSummary(r) {
  if (!hasWeather(r)) return '';
  const d = r.pressure_change_24h;
  return t('weather.summary', {
    p: r.pressure_hpa,
    d: d == null ? '—' : `${d > 0 ? '+' : ''}${d}`,
    t: r.temp_c ?? '—',
    h: r.humidity_pct ?? '—',
  });
}

function emptyRecord() {
  return {
    id: newId(), start: nowLocal(), end: '', intensity: null, type: '', locations: [], pain_quality: [], aura: [], symptoms: [],
    meds: [], med_effect: '', triggers: [], notes: '',
  };
}

// 先存檔（就算接下來什麼都不填，開始時間也已記下），再跳出一題一題的快速問答
let quickFlow = null;
function quickStart() {
  const record = emptyRecord();
  buzz(40);
  save(record, true, { quiet: true });
  quickFlow.open(record.id, 'start');
}

function setIntensity(id, value) {
  buzz(10);
  const r = store.getRecords().find((x) => x.id === id);
  if (!r) return;
  save({ ...r, intensity: value }, false);
}

function endRecord(id) {
  const r = store.getRecords().find((x) => x.id === id);
  if (!r) return;
  buzz();
  save({ ...r, end: nowLocal() }, false, { quiet: true });
  // 有吃藥但還沒填效果：結束當下最記得，問一題就好；否則提供「復原」（避免誤觸）
  if (r.meds?.length && !r.med_effect) quickFlow.open(id, 'end');
  else toast(t('undo.ended'), 6000, { label: t('undo.undo'), run: () => save({ ...r }, false, { quiet: true }) });
}

// ---------- 表單 ----------

function buildFormOptions() {
  const form = $('#record-form');
  // 選項少的欄位一律用膠囊按鈕：單選用 radio（再點一次可取消，見 bindEvents），複選用 checkbox
  const chips = (container, field, codes, type = 'checkbox') => {
    container.innerHTML = codes.map((c) => `<label class="chip"><input type="${type}" name="${field}" value="${c}"><span>${escapeHtml(t(`opt.${field}.${c}`))}</span></label>`).join('');
  };
  chips($('#type-options'), 'type', OPTIONS.type, 'radio');
  chips($('#effect-options'), 'med_effect', OPTIONS.med_effect, 'radio');
  chips($('#pain-quality-options'), 'pain_quality', OPTIONS.pain_quality);
  chips($('#triggers-options'), 'triggers', OPTIONS.triggers);
  chips($('#aura-options'), 'aura', OPTIONS.aura);
  chips($('#symptoms-options'), 'symptoms', OPTIONS.symptoms);
  medEditor?.render();
  headMap?.render();
}

// 常用藥：依過去紀錄的使用次數排序，不足的用語系預設補上
function frequentMeds() {
  const count = new Map();
  for (const r of store.getRecords()) {
    for (const m of r.meds ?? []) if (m.code !== 'other_med') count.set(m.code, (count.get(m.code) ?? 0) + 1);
  }
  const used = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const defaults = t('meds.defaults').split(',').map((c) => c.trim()).filter((c) => MED_BY_CODE[c]);
  return [...new Set([...used, ...defaults])];
}

// preset：新增時預先帶入的欄位（例如從日曆補登某一天）
// focus：開啟後聚焦的欄位（例如從「選擇結束時間」進來聚焦 end）
function openForm(record, preset = {}, { focus = '' } = {}) {
  editing = record;
  const r = record ?? { ...emptyRecord(), intensity: 5, ...preset };
  const form = $('#record-form');
  $('#form-title').textContent = t(record ? 'form.titleEdit' : 'form.titleNew');
  form.elements.start.value = r.start || '';
  form.elements.end.value = r.end || '';
  form.elements.intensity.value = r.intensity ?? 5;
  $('#intensity-out').textContent = form.elements.intensity.value;
  for (const field of ['type', 'med_effect']) {
    form.querySelectorAll(`input[name="${field}"]`).forEach((el) => { el.checked = el.value === r[field]; });
  }
  form.elements.notes.value = r.notes || '';
  medEditor.set(r.meds);
  headMap.set(r.locations);
  for (const field of ['triggers', 'aura', 'symptoms', 'pain_quality']) {
    form.querySelectorAll(`input[name="${field}"]`).forEach((el) => { el.checked = r[field]?.includes(el.value); });
  }
  updateAuraWarning();
  const w = weatherSummary(r);
  $('#form-weather').innerHTML = w ? `<strong>${escapeHtml(t('weather.title'))}</strong> ${escapeHtml(w)}` : '';
  $('#form-weather').hidden = !w;
  $('#btn-delete').hidden = !record;
  $('#form-error').hidden = true;
  $('#record-dialog').showModal();
  if (focus) form.elements[focus]?.focus();
}

function submitForm(e) {
  e.preventDefault();
  const form = $('#record-form');
  const f = form.elements;
  if (f.end.value && f.end.value < f.start.value) {
    $('#form-error').textContent = t('form.endBeforeStart');
    $('#form-error').hidden = false;
    return;
  }
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
  const record = {
    ...(editing ?? { id: newId() }),
    start: f.start.value,
    end: f.end.value,
    intensity: Number(f.intensity.value),
    type: form.querySelector('input[name="type"]:checked')?.value ?? '',
    pain_quality: checked('pain_quality'),
    locations: headMap.get(),
    meds: medEditor.get(),
    med_effect: form.querySelector('input[name="med_effect"]:checked')?.value ?? '',
    triggers: checked('triggers'),
    aura: checked('aura'),
    symptoms: checked('symptoms'),
    notes: f.notes.value.trim(),
  };
  save(record, !editing);
  $('#record-dialog').close();
}

// 單側無力、說話困難若是第一次出現，可能不是單純的偏頭痛預兆，提醒就醫
function updateAuraWarning() {
  const red = [...document.querySelectorAll('input[name="aura"]:checked')].some((el) => ['motor', 'speech'].includes(el.value));
  $('#aura-warning').hidden = !red;
}

// 不再跳確認視窗，改為刪除後提供「復原」
function deleteEditing() {
  if (!editing) return;
  const record = editing;
  $('#record-dialog').close();
  deleteWithUndo(record);
}

// ---------- 清空所有紀錄 ----------

function openClearDialog() {
  const n = store.getRecords().length;
  const linked = !store.isDemo() && !!auth.getEmail();
  $('#clear-body').textContent = t(linked ? 'clear.body' : 'clear.bodyLocal', { n });
  $('#clear-restore').textContent = t(linked ? 'clear.restore' : 'clear.restoreLocal');
  $('#clear-hint').textContent = t('clear.typeHint', { word: t('clear.word') });
  $('#clear-input').value = '';
  $('#btn-clear-confirm').disabled = true;
  $('#clear-error').hidden = true;
  $('#clear-dialog').showModal();
}

function onClearInput() {
  $('#btn-clear-confirm').disabled = $('#clear-input').value.trim().toLowerCase() !== t('clear.word').toLowerCase();
}

// 先清試算表、成功後才清本機；失敗時什麼都不刪。
// 有綁定帳號但權杖過期時，必須在這個點擊事件中同步開啟登入彈窗。
function confirmClear(e) {
  e.preventDefault();
  if ($('#btn-clear-confirm').disabled) return;
  const linked = !store.isDemo() && !!auth.getEmail();
  const tokenPromise = !linked ? Promise.resolve(null)
    : auth.hasValidToken() ? Promise.resolve(auth.getToken())
    : auth.requestToken();
  $('#btn-clear-confirm').disabled = true;
  tokenPromise
    .then(async (token) => {
      await store.whenIdle();
      if (token) {
        if (!sheet) {
          sheet = await openSpreadsheet(token, { cachedId: store.getCachedSheetId(), title: t('app.sheetTitle') });
          store.setCachedSheetId(sheet.id);
        }
        await sheet.clearAll(token);
      }
      store.clearRecords();
      calSelected = null;
      $('#clear-dialog').close();
      toast(t('clear.done'));
    })
    .catch((err) => {
      console.error(err);
      $('#clear-error').textContent = t('clear.failed');
      $('#clear-error').hidden = false;
      onClearInput();
    });
}

// ---------- 匯出 ----------

async function exportRecords() {
  importer ??= await import('./importer.js');
  const records = store.getRecords();
  const data = importer.buildExport(records);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `headache-log-${localDate(new Date())}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(t('export.done', { n: records.length }));
}

// ---------- 匯入 ----------

let importer = null; // 用到才載入
let importPrompt = '';
let pendingImport = [];

async function openImport() {
  importer ??= await import('./importer.js');
  importPrompt = importer.buildPrompt();
  const links = importer.aiLinks(importPrompt);
  $('#ai-chatgpt').href = links.chatgpt;
  $('#ai-claude').href = links.claude;
  $('#import-text').value = '';
  previewImport();
  $('#import-dialog').showModal();
}

function copyPrompt() {
  navigator.clipboard.writeText(importPrompt)
    .then(() => toast(t('import.copied')))
    .catch((e) => console.warn('clipboard', e));
}

// 貼上後即時解析與預覽，不需要另外按「預覽」
function previewImport() {
  const text = $('#import-text').value.trim();
  const box = $('#import-preview');
  const btn = $('#btn-import-confirm');
  pendingImport = [];
  btn.disabled = true;
  btn.textContent = t('import.title');
  if (!text) {
    box.innerHTML = '';
    return;
  }
  let result;
  try {
    result = importer.parseImport(text, store.getRecords());
  } catch {
    box.innerHTML = `<p class="error">${escapeHtml(t('import.noJson'))}</p>`;
    return;
  }
  pendingImport = result.records;
  const n = pendingImport.length;
  const shown = pendingImport.slice(0, 20).map((r) => {
    const parts = [formatDateTime(r.start), recordSummary(r), Number.isFinite(r.intensity) ? `${r.intensity}/10` : ''];
    return `<li>${escapeHtml(parts.filter(Boolean).join(' · '))}</li>`;
  }).join('');
  box.innerHTML = `
    <p class="ok">${escapeHtml(t('import.ready', { n }))}</p>
    ${result.duplicates ? `<p class="muted small">${escapeHtml(t('import.duplicates', { n: result.duplicates }))}</p>` : ''}
    ${result.errors.length ? `<p class="error small">${escapeHtml(t('import.errors', { n: result.errors.length }))}</p>` : ''}
    ${n ? `<ul>${shown}${n > 20 ? `<li class="muted">${escapeHtml(t('import.more', { n: n - 20 }))}</li>` : ''}</ul>` : ''}`;
  btn.disabled = !n;
  btn.textContent = t('import.confirm', { n });
}

function confirmImport(e) {
  e.preventDefault();
  if (!pendingImport.length) return;
  const now = new Date().toISOString();
  const list = pendingImport.map((r) => ({ ...r, created_at: now, updated_at: now }));
  store.importRecords(list);
  pendingImport = [];
  $('#import-dialog').close();
  toast(t('import.done', { n: list.length }));
  showView('list');
  trySync();
}

// ---------- 畫面 ----------

function renderSync() {
  const demo = store.isDemo();
  $('#demo-banner').hidden = !demo;
  if (demo) {
    $('#sync-status').textContent = '';
    $('#btn-signin').hidden = true;
    $('#btn-sync').hidden = true;
    $('#banner').hidden = true;
    return;
  }
  const hasToken = auth.hasValidToken();
  const email = auth.getEmail();
  const pending = store.pendingCount();
  const status = $('#sync-status');
  const banner = $('#banner');

  // 雲朵 icon + 未同步筆數；完整文字放在 title / aria-label（桌機另外顯示文字）
  let kind = '';
  let text = '';
  if (syncState === 'syncing') [kind, text] = ['cloudSync', t('sync.syncing')];
  else if (syncState === 'offline' || syncState === 'error') [kind, text] = ['cloudOff', t(syncState === 'offline' ? 'sync.offline' : 'sync.failed')];
  else if (pending) [kind, text] = [hasToken ? 'cloudUp' : 'cloudOff', t('sync.pending', { n: pending })];
  else if (hasToken) [kind, text] = ['cloudCheck', t('sync.synced')];
  status.innerHTML = kind ? `${icon(kind)}${pending ? `<span class="sync-count">${pending}</span>` : ''}<span class="sync-text">${escapeHtml(text)}</span>` : '';
  status.title = text;
  status.setAttribute('aria-label', text);
  status.dataset.kind = kind;

  const signinBtn = $('#btn-signin');
  signinBtn.hidden = hasToken;
  signinBtn.disabled = !authReady;
  // 窄螢幕顯示短版文字（由 CSS 切換）
  const full = t(email ? 'auth.reconnect' : 'auth.signIn');
  const short = email ? full : t('auth.signInShort');
  signinBtn.innerHTML = `<span class="label-full">${escapeHtml(full)}</span><span class="label-short">${escapeHtml(short)}</span>`;
  signinBtn.title = full;
  $('#btn-sync').hidden = !hasToken || !pending || syncState === 'syncing';

  let msg = '';
  if (!email && !(document.body.dataset.view === 'log' && needsBackup())) msg = t('auth.localOnly');
  else if (syncState === 'error') msg = t('sync.failed');
  else if (syncState === 'offline') msg = t('sync.offline');
  banner.textContent = msg;
  banner.hidden = !msg;
}

function renderOngoing() {
  const ongoing = store.getRecords().filter(isOngoing).sort((a, b) => b.start.localeCompare(a.start));
  const levels = Array.from({ length: 10 }, (_, i) => i + 1);
  $('#ongoing').innerHTML = ongoing.map((r) => {
    // 開始很久了還沒按結束：多半是睡著或忘了，問一句並提供補填結束時間
    const hours = Math.floor((Date.now() - new Date(r.start)) / 3600000);
    const stale = hours >= STALE_HOURS;
    return `
    <div class="card ongoing${stale ? ' stale' : ''}" data-id="${escapeHtml(r.id)}">
      <div><strong>${t('log.ongoing')}</strong> · ${escapeHtml(t('log.startedAt', { t: formatDateTime(r.start) }))}</div>
      ${stale ? `<p class="warning small ongoing-note">${icon('alert')}${escapeHtml(t('log.stale', { h: hours }))}</p>` : ''}
      <p class="label">${escapeHtml(t('log.peak'))}</p>
      <div class="intensity-pick" role="group" aria-label="${escapeHtml(t('form.intensity'))}">
        ${levels.map((n) => `<button type="button" class="i${n}" data-action="intensity" data-value="${n}" aria-pressed="${r.intensity === n}">${n}</button>`).join('')}
      </div>
      <div class="actions">
        <button class="btn" data-action="end">${t('log.end')}</button>
        ${stale
    ? `<button class="btn ghost" data-action="end-at">${t('log.endAt')}</button>`
    : `<button class="btn ghost" data-action="details">${t('log.details')}</button>`}
      </div>
    </div>`;
  }).join('');
}

// 沒有結束時間、且在 72 小時內開始，才算「進行中」（匯入的舊紀錄常沒有結束時間）
const ONGOING_WINDOW_MS = 72 * 3600 * 1000;
const STALE_HOURS = 12; // 超過這麼久還在「進行中」就提醒確認
function isOngoing(r) {
  return !!r.start && !r.end && Date.now() - new Date(r.start) < ONGOING_WINDOW_MS;
}

// 列表與匯入預覽共用的一行摘要
function recordSummary(r) {
  return [
    r.end ? formatDuration(r.start, r.end) : t(isOngoing(r) ? 'list.ongoing' : 'list.noEnd'),
    r.type ? t(`opt.type.${r.type}`) : '',
    r.meds?.length ? formatList(r.meds.map((m) => [medLabel(t, m), doseLabel(t, m)].filter(Boolean).join(' '))) : '',
    hasWeather(r) ? `${r.pressure_hpa} hPa${r.pressure_change_24h != null ? ` (${r.pressure_change_24h > 0 ? '+' : ''}${r.pressure_change_24h})` : ''}` : '',
  ].filter(Boolean).join(' · ');
}

// 列表只先顯示最近幾筆，避免紀錄多時頁面超長、看不到頁尾
const LIST_INITIAL = 20;
const LIST_STEP = 50;
let listLimit = LIST_INITIAL;

// 列表篩選：頭痛類型（與表單、統計相同的清單，附筆數）＋「有預兆」
const listFilter = { type: '', aura: false };

function renderListFilters(all) {
  const count = (pred) => all.filter(pred).length;
  const chip = (attrs, pressed, label, n, disabled = false) => `
    <button type="button" class="chip-toggle" ${attrs} aria-pressed="${pressed}" ${disabled ? 'disabled' : ''}>${label}<span class="chip-count">${n}</span></button>`;
  $('#list-filters').innerHTML = [
    chip('data-list-type=""', !listFilter.type, escapeHtml(t('st.allTypes')), all.length),
    ...OPTIONS.type.map((c) => {
      const n = count((r) => (r.type || 'unknown') === c);
      return chip(`data-list-type="${c}"`, listFilter.type === c, escapeHtml(t(`opt.type.${c}`)), n, !n && listFilter.type !== c);
    }),
    chip('data-list-aura', listFilter.aura, `${icon('aura')}${escapeHtml(t('list.auraOnly'))}`, count((r) => r.aura?.length), !listFilter.aura && !count((r) => r.aura?.length)),
  ].join('');
  $('#list-filters').hidden = !all.length;
}

function renderList() {
  const all = [...store.getRecords()].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  renderListFilters(all);
  if (!all.length) {
    $('#record-list').innerHTML = `<li class="muted">${t('list.empty')}</li>`;
    return;
  }
  const list = all.filter((r) => (!listFilter.type || (r.type || 'unknown') === listFilter.type) && (!listFilter.aura || r.aura?.length));
  if (!list.length) {
    $('#record-list').innerHTML = `<li class="muted">${t('list.noMatch')}</li>`;
    return;
  }
  const showType = hasMultipleTypes(all);
  const monthFmt = new Intl.DateTimeFormat(getLang(), { year: 'numeric', month: 'long' });
  let lastMonth = '';
  const rows = list.slice(0, listLimit).map((r) => {
    const ym = r.start.slice(0, 7);
    const header = ym !== lastMonth ? `<li class="list-month">${escapeHtml(monthFmt.format(new Date(`${ym}-01T00:00`)))}</li>` : '';
    lastMonth = ym;
    return header + recordItemHtml(r, { showType });
  });
  const rest = list.length - listLimit;
  $('#record-list').innerHTML = rows.join('')
    + (rest > 0 ? `<li class="list-more"><button type="button" class="btn ghost wide" data-more>${escapeHtml(t('list.more', { n: rest }))}</button></li>` : '');
}

// 列表與日曆共用的一列：
// - 左：疼痛程度色塊（掃視時的錨點）
// - 主行：日期、時間（未知時省略）、持續時間或「進行中」
// - 膠囊：用藥、預兆、類型（只有使用者紀錄裡有兩種以上類型時才顯示）、明顯的氣壓下降
// showType 由呼叫端依整體紀錄決定
const PRESSURE_DROP = -5;
function recordItemHtml(r, { showType = false } = {}) {
  const d = new Date(r.start);
  const date = dateLabel(d);
  const time = r.start.slice(11, 16) !== '00:00' ? clockLabel(d) : '';
  const when = r.end ? formatDuration(r.start, r.end) : '';
  const tag = (cls, content) => `<span class="tag ${cls}">${content}</span>`;
  const tags = [
    isOngoing(r) ? tag('ongoing', escapeHtml(t('list.ongoing'))) : '',
    ...(r.meds ?? []).map((m) => tag('med', `${icon('pill')}${escapeHtml([medLabel(t, m), doseLabel(t, m)].filter(Boolean).join(' '))}`)),
    r.aura?.length ? tag('aura', `${icon('aura')}${escapeHtml(t('list.auraBadge'))}`) : '',
    showType && r.type && r.type !== 'unknown' ? tag('type', escapeHtml(t(`opt.type.${r.type}`))) : '',
    Number.isFinite(r.pressure_change_24h) && r.pressure_change_24h <= PRESSURE_DROP
      ? tag('pressure', `${icon('weather')}${escapeHtml(t('list.pressureDrop', { d: Math.abs(r.pressure_change_24h) }))}`) : '',
  ].filter(Boolean).join('');
  const level = Number.isFinite(r.intensity) ? Math.min(10, Math.max(0, r.intensity)) : null;
  return `
    <li class="record" data-id="${escapeHtml(r.id)}">
      <span class="intensity ${level == null ? 'none' : `i${level}`}" ${level == null ? `title="${escapeHtml(t('cal.legendUnknown'))}"` : ''}>${level ?? '–'}</span>
      <div class="record-main">
        <div class="record-head">
          <span class="record-date">${escapeHtml(date)}</span>
          ${time ? `<span class="record-time">${escapeHtml(time)}</span>` : ''}
          ${when ? `<span class="record-dur">${escapeHtml(when)}</span>` : ''}
        </div>
        ${tags ? `<div class="record-tags">${tags}</div>` : ''}
      </div>
    </li>`;
}

// 使用者的紀錄裡有兩種以上（非「不確定」的）頭痛類型時，列表才顯示類型膠囊
function hasMultipleTypes(records) {
  return new Set(records.map((r) => r.type).filter((x) => x && x !== 'unknown')).size > 1;
}

// ---------- 日曆 ----------
//
// 兩種檢視（手機、電腦相同）：
// - 月：一次一個月，‹ › 或左右滑動切換，可一直往前；月份標籤是年月選擇器（直接跳）；旁邊的明細面板
//       沒選日期時列出整個月的紀錄，選了日期就列出當天的紀錄
// - 年：某一年 1–12 月的縮圖；點日期或月份標題會「往下鑽」到該月的月檢視（結果一定看得到）
//
// 狀態只有三個：檢視（calMode）、目前的月份（calMonth，年檢視取它的年份）、選取的日期。
// 一律透過 goCal() 改變狀態並重繪。

const CAL_KEY = 'hl.calMode';
const thisMonth = () => localDate(new Date()).slice(0, 7);
const shiftMonth = (ym, n) => localDate(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)).slice(0, 7);
let calMode = 'month';
try { if (localStorage.getItem(CAL_KEY) === 'year') calMode = 'year'; } catch { /* ignore */ }
let calMonth = thisMonth(); // 'YYYY-MM'
let calSelected = null; // 'YYYY-MM-DD'

// 改變日曆狀態（未指定的保持不變；月份不會超過本月）並重繪
function goCal({ mode = calMode, month = calMonth, selected = null } = {}) {
  if (mode !== calMode) {
    calMode = mode;
    try { localStorage.setItem(CAL_KEY, mode); } catch { /* ignore */ }
  }
  calMonth = month > thisMonth() ? thisMonth() : month;
  calSelected = selected;
  renderCalendarView();
}

// 導覽列標籤：年檢視是年份文字；月檢視是原生年月選擇器（就地更新，正在操作時不重建，避免關掉選單）
function renderCalLabel() {
  const label = $('#cal-label');
  if (calMode === 'year') {
    label.innerHTML = `<span class="cal-label-text">${calMonth.slice(0, 4)}</span>`;
    return;
  }
  let input = $('#cal-month-input');
  if (!input) {
    label.innerHTML = `<input type="month" id="cal-month-input" aria-label="${escapeHtml(t('cal.pickMonth'))}">`;
    input = $('#cal-month-input');
  }
  input.max = thisMonth();
  if (document.activeElement !== input && input.value !== calMonth) input.value = calMonth;
}

function renderCalendarView() {
  const year = calMode === 'year';
  $('#view-calendar').classList.toggle('year', year);
  syncRadios('.cal-mode [data-cal-mode]', 'calMode', calMode);
  renderCalLabel();
  // 已在最新的月份／年份：不能再往後，也不需要「今天」
  const cur = year ? calMonth.slice(0, 4) : calMonth;
  const now = year ? thisMonth().slice(0, 4) : thisMonth();
  $('#cal-next').disabled = cur >= now;
  $('#cal-today').disabled = cur === now;

  const months = year ? Array.from({ length: 12 }, (_, i) => `${cur}-${pad(i + 1)}`) : [calMonth];
  $('#calendar-months').innerHTML = calendarHtml({ records: store.getRecords(), months, lang: getLang(), t, selected: calSelected, linkMonths: year });
  renderDayDetail();
}

// 月檢視旁的明細：選了日期 → 當天紀錄；沒選 → 整個月的紀錄（年檢視不顯示，點日期會進入月檢視）
function renderDayDetail() {
  const panel = $('#cal-detail');
  panel.hidden = calMode === 'year';
  if (calMode === 'year') return;
  const all = store.getRecords();
  const showType = hasMultipleTypes(all);
  const items = (calSelected
    ? all.filter((r) => daysCovered(r).includes(calSelected))
    : all.filter((r) => r.start?.startsWith(calMonth)))
    .sort((a, b) => b.start.localeCompare(a.start));
  const title = calSelected
    ? dateLabel(new Date(`${calSelected}T00:00`), { long: true })
    : t('cal.monthEntries', { n: items.length });
  panel.innerHTML = `
    <div class="cal-detail-head">
      <h4>${escapeHtml(title)}</h4>
      ${calSelected ? `<button type="button" class="link-btn" data-clear-day>${escapeHtml(t('cal.showMonth'))}</button>` : ''}
    </div>
    ${items.length
      ? `<ul class="record-list">${items.map((r) => recordItemHtml(r, { showType })).join('')}</ul>`
      : `<p class="muted small">${escapeHtml(t(calSelected ? 'cal.noEntries' : 'cal.noEntriesMonth'))}</p>`}
    ${calSelected ? `<button type="button" class="btn ghost small" data-add-day="${calSelected}">＋ ${escapeHtml(t('cal.addForDay'))}</button>` : ''}`;
}

// 點日期：年檢視往下鑽到該月；月檢視只更新選取與明細（不重繪整個月曆）
function selectDay(day) {
  if (calMode === 'year') return goCal({ mode: 'month', month: day.slice(0, 7), selected: day });
  calSelected = calSelected === day ? null : day;
  document.querySelectorAll('#calendar-months .cal-day.selected').forEach((b) => {
    b.classList.remove('selected');
    b.setAttribute('aria-pressed', 'false');
  });
  const btn = calSelected && $('#calendar-months').querySelector(`[data-day="${calSelected}"]`);
  btn?.classList.add('selected');
  btn?.setAttribute('aria-pressed', 'true');
  renderDayDetail();
  // 手機上明細在月曆下方：不在畫面內就捲過去
  const panel = $('#cal-detail');
  if (calSelected && panel.getBoundingClientRect().top > window.innerHeight - 120) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 往前／往後一個月（年檢視一次一年）
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// 換月份／年份時，新內容從移動的方向滑入一小段，看得出是往前還是往後（dir：-1 往前、1 往後）
function slideCalendar(dir) {
  if (reduceMotion.matches) return;
  const x = dir * (isRtl() ? -1 : 1) * 24;
  $('#calendar-months').animate(
    [{ transform: `translateX(${x}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' },
  );
}

// 往前／往後一個月（年檢視一年）；已在本月時不動
function stepCalendar(n) {
  const before = calMonth;
  goCal({ month: shiftMonth(calMonth, calMode === 'year' ? 12 * n : n) });
  if (calMonth !== before) slideCalendar(n);
}

function onCalendarClick(e) {
  const el = e.target.closest('[data-cal-mode],#cal-prev,#cal-next,#cal-today,[data-open-month],[data-day],[data-clear-day],li[data-id],[data-add-day]');
  if (!el) return;
  if (el.dataset.calMode) return goCal({ mode: el.dataset.calMode });
  if (el.id === 'cal-prev') return stepCalendar(-1);
  if (el.id === 'cal-next') return stepCalendar(1);
  if (el.id === 'cal-today') {
    goCal({ month: thisMonth() });
    return slideCalendar(1);
  }
  if (el.dataset.openMonth) return goCal({ mode: 'month', month: el.dataset.openMonth });
  if (el.dataset.day) return selectDay(el.dataset.day);
  if (el.hasAttribute('data-clear-day')) return goCal();
  if (el.dataset.id) return openForm(store.getRecords().find((r) => r.id === el.dataset.id));
  // 補登：日期用選取的那天，時間先帶目前時間
  if (el.dataset.addDay) openForm(null, { start: `${el.dataset.addDay}T${nowLocal().slice(11)}` });
}

// 月檢視可以左右滑動切換月份（往右滑 = 上個月）
function bindCalendarSwipe() {
  const box = $('#calendar-months');
  let x0 = null;
  let y0 = null;
  box.addEventListener('touchstart', (e) => { [x0, y0] = [e.touches[0].clientX, e.touches[0].clientY]; }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (x0 == null || calMode !== 'month') return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    stepCalendar((dx > 0) !== isRtl() ? -1 : 1);
  }, { passive: true });
}

// 統計頁由 statsview.js 負責（篩選、我的趨勢、看診摘要）
let statsView = null;
function renderStats() {
  statsView?.render();
}

// 尚未決定是否記錄天氣、且已有紀錄時，在記錄頁詢問一次
// 首頁近況：距離上次頭痛幾天、本月頭痛與用藥天數（用藥達門檻時醒目提示）
function renderHomeSummary() {
  const records = store.getRecords().filter((r) => r.start);
  const el = $('#home-summary');
  el.hidden = !records.length;
  if (!records.length) return;
  const today = localDate(new Date());
  const lastDay = records.reduce((max, r) => {
    const d = (r.end || r.start).slice(0, 10);
    return d > max ? d : max;
  }, '');
  const since = Math.round((new Date(`${today}T00:00`) - new Date(`${lastDay}T00:00`)) / 86400000);
  const m = monthStats(records, thisMonth());
  const parts = [];
  if (!records.some(isOngoing)) parts.push(since <= 0 ? t('home.today') : t('home.since', { n: since }));
  parts.push(t('home.month', { h: m.headacheDays, m: m.medDays }));
  el.textContent = parts.join(' · ');
  el.classList.toggle('alert', m.mohWarnings.length > 0);
}

// 有紀錄但還沒登入：首頁顯示「尚未備份」卡片（比頂部橫幅更具體：幾筆、會怎麼遺失）
const needsBackup = () => !store.isDemo() && !auth.getEmail() && store.getRecords().length > 0;
function renderBackupCard() {
  const show = needsBackup();
  $('#backup-card').hidden = !show;
  if (show) $('#backup-body').textContent = t('backup.body', { n: store.getRecords().length });
  $('#btn-backup').disabled = !authReady;
}

// 新使用者（還沒有任何紀錄）在首頁看到一句理念，有紀錄後就收起來
function renderTagline() {
  const fresh = !store.getRecords().length && !store.isDemo();
  $('#tagline').hidden = !fresh;
  $('#btn-try-demo').hidden = !fresh;
}

// ---------- AI 分析 ----------

const AI_KEY = 'hl.ai';
let ai = null; // 用到才載入
let aiPrompt = '';
const aiState = (() => {
  try { return { preset: 'overview', count: 30, notes: true, ...JSON.parse(localStorage.getItem(AI_KEY) || '{}') }; } catch { return { preset: 'overview', count: 30, notes: true }; }
})();

async function openAiDialog() {
  ai ??= await import('./aianalysis.js');
  const chip = (field, value, labelText) => `<label class="chip"><input type="radio" name="${field}" value="${value}"><span>${escapeHtml(labelText)}</span></label>`;
  $('#ai-presets').innerHTML = ai.AI_PRESETS.map((p) => chip('ai-preset', p, t(`ai.p_${p}`))).join('');
  $('#ai-counts').innerHTML = ai.AI_COUNTS.map((n) => chip('ai-count', n, t('ai.countN', { n }))).join('');
  $(`#ai-presets input[value="${aiState.preset}"]`).checked = true;
  $(`#ai-counts input[value="${aiState.count}"]`).checked = true;
  $('#ai-notes').checked = aiState.notes;
  updateAiPrompt();
  $('#ai-dialog').showModal();
}

function updateAiPrompt() {
  aiState.preset = $('#ai-presets input:checked')?.value ?? 'overview';
  aiState.count = Number($('#ai-counts input:checked')?.value ?? 30);
  aiState.notes = $('#ai-notes').checked;
  try { localStorage.setItem(AI_KEY, JSON.stringify(aiState)); } catch { /* ignore */ }
  const { prompt, count } = ai.buildAnalysisPrompt(store.getRecords(), { ...aiState, includeNotes: aiState.notes, lang: getLang() });
  aiPrompt = prompt;
  const links = ai.aiLinks(prompt);
  $('#ai-open-chatgpt').href = links.chatgpt;
  $('#ai-open-claude').href = links.claude;
  $('#ai-privacy').textContent = t('ai.privacy', { n: count });
  $('#ai-hint').textContent = t(links.fits ? 'ai.hintFilled' : 'ai.hintPaste');
  $('#ai-preview').textContent = prompt;
}

// 開啟 AI 前一律先複製（內容太長、網址放不下時，使用者貼上即可）
function copyAiPrompt() {
  navigator.clipboard?.writeText(aiPrompt).then(() => toast(t('ai.copied'))).catch(() => {});
}

// ---------- 加到主畫面 ----------

// Chrome / Edge / Android 會先發出 beforeinstallprompt，留著等使用者按按鈕時再顯示
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstall() {
  $('#btn-install').hidden = isStandalone();
}

async function install() {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') toast(t('install.done'));
    return;
  }
  // 不支援直接安裝：依裝置顯示步驟
  const steps = isIOS()
    ? [`${icon('share')} ${escapeHtml(t('install.ios1'))}`, `${icon('addBox')} ${escapeHtml(t('install.ios2'))}`]
    : /Android/i.test(navigator.userAgent)
      ? [escapeHtml(t('install.android'))]
      : [escapeHtml(t('install.desktop', { key: /Mac/i.test(navigator.platform) ? '⌘ + D' : 'Ctrl + D' }))];
  $('#install-steps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  $('#install-dialog').showModal();
}

// ---------- 分享網站 ----------

// 只分享網站網址（不含任何紀錄）。支援的瀏覽器叫出系統分享面板，否則複製連結
async function shareSite() {
  const url = document.querySelector('link[rel="canonical"]')?.href ?? location.href;
  const data = { title: t('share.name'), text: t('share.text'), url };
  try {
    if (navigator.share) return await navigator.share(data);
    await navigator.clipboard.writeText(url);
    toast(t('share.copied'));
  } catch (e) {
    if (e?.name !== 'AbortError') toast(t('share.failed')); // 使用者關掉分享面板不算失敗
  }
}

// ---------- 示範模式 ----------

async function enterDemo() {
  const { buildDemoRecords } = await import('./demo.js');
  store.enterDemo(buildDemoRecords());
  location.reload();
}

function exitDemo() {
  store.exitDemo();
  location.reload();
}

function renderWeatherPrompt() {
  $('#weather-prompt').hidden = store.isDemo() || weather.getPref() != null || !store.getRecords().length;
}

// js/theme.js 在 <head> 同步載入，headackTheme 一定存在
function renderThemeChoice() {
  syncRadios('[data-theme-choice]', 'themeChoice', headackTheme.get());
}

function renderSettings() {
  $('#btn-demo').textContent = t(store.isDemo() ? 'demo.exit' : 'demo.enter');
  $('#weather-toggle').checked = weather.getPref() === 'on';
  renderThemeChoice();
  const email = auth.getEmail();
  $('#account-email').textContent = email || t('auth.localOnly');
  $('#btn-signout').hidden = !email;
  $('#btn-clear').disabled = !store.getRecords().length;
  $('#btn-export').disabled = !store.getRecords().length;
  const link = $('#sheet-link');
  link.hidden = !sheet;
  if (sheet) link.href = sheet.url;
}

function render() {
  renderSync();
  renderInstall();
  renderOngoing();
  renderHomeSummary();
  renderBackupCard();
  renderTagline();
  renderWeatherPrompt();
  renderList();
  if (document.body.dataset.view === 'calendar') renderCalendarView(); // 隱藏時不畫，切過去時再畫
  renderStats();
  renderSettings();
}

// 語言切換後重建由 JS 產生的文字（靜態文字由 i18n.applyI18n 處理）
function refreshLanguage() {
  $('#copyright').textContent = t('footer.copyright', { year: new Date().getFullYear() });
  $('#footer-version').textContent = `v${APP_VERSION}`;
  $('#app-version').textContent = t('settings.version', { v: APP_VERSION });
  buildFormOptions();
  render();
}

// 版面（手機 / 桌機）由 CSS 依 body[data-view] 決定
function showView(name) {
  document.body.dataset.view = name;
  renderSync(); // 首頁與其他分頁的提醒方式不同
  window.scrollTo(0, 0);
  if (name === 'stats') statsView?.render(); // 隱藏時量不到圖表寬度，切過來再畫一次
  if (name === 'calendar') renderCalendarView();
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}

// ---------- 啟動 ----------

function bindEvents() {
  medEditor = createMedEditor($('#med-editor'), { t, getFrequent: frequentMeds });
  headMap = createHeadMap($('#head-map'), { t });

  $('#btn-signin').addEventListener('click', signIn);
  $('#btn-sync').addEventListener('click', trySync);
  $('#btn-signout').addEventListener('click', signOut);
  $('#btn-quick-start').addEventListener('click', quickStart);
  $('#btn-full').addEventListener('click', () => openForm(null));
  $('#fab').addEventListener('click', () => openForm(null));

  $('#ongoing').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('[data-id]').dataset.id;
    if (btn.dataset.action === 'end') endRecord(id);
    else if (btn.dataset.action === 'intensity') setIntensity(id, Number(btn.dataset.value));
    else openForm(store.getRecords().find((r) => r.id === id), {}, { focus: btn.dataset.action === 'end-at' ? 'end' : '' });
  });

  $('#list-filters').addEventListener('click', (e) => {
    const typeBtn = e.target.closest('[data-list-type]');
    if (typeBtn) listFilter.type = typeBtn.dataset.listType;
    else if (e.target.closest('[data-list-aura]')) listFilter.aura = !listFilter.aura;
    else return;
    listLimit = LIST_INITIAL;
    renderList();
  });
  $('#record-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) {
      listLimit += LIST_STEP;
      return renderList();
    }
    const li = e.target.closest('li[data-id]');
    if (li) openForm(store.getRecords().find((r) => r.id === li.dataset.id));
  });

  $('#record-form').addEventListener('submit', submitForm);
  // 單選膠囊：點已選的那一個可以取消（radio 預設不能取消）
  $('#record-form').addEventListener('pointerdown', (e) => {
    const input = e.target.closest('label.chip')?.querySelector('input[type="radio"]');
    if (input) input.dataset.wasChecked = String(input.checked);
  });
  $('#record-form').addEventListener('click', (e) => {
    const input = e.target.closest('input[type="radio"]');
    if (input?.dataset.wasChecked === 'true') input.checked = false;
    if (input) delete input.dataset.wasChecked;
  });
  $('#record-form').elements.intensity.addEventListener('input', (e) => { $('#intensity-out').textContent = e.target.value; });
  $('#btn-cancel').addEventListener('click', () => $('#record-dialog').close());
  $('#btn-delete').addEventListener('click', deleteEditing);

  statsView = createStatsView($('#view-stats'), { t, getLang, getRecords: store.getRecords, onAiAnalysis: openAiDialog });
  $('#ai-presets').addEventListener('change', updateAiPrompt);
  $('#ai-counts').addEventListener('change', updateAiPrompt);
  $('#ai-notes').addEventListener('change', updateAiPrompt);
  $('#ai-open-chatgpt').addEventListener('click', copyAiPrompt);
  $('#ai-open-claude').addEventListener('click', copyAiPrompt);
  $('#ai-copy').addEventListener('click', copyAiPrompt);
  quickFlow = createQuickFlow($('#quick-dialog'), {
    t,
    getRecord: (id) => store.getRecords().find((r) => r.id === id),
    saveRecord: (r) => save(r, false, { quiet: true }),
    frequentMeds,
    notify: (msg) => (needsBackup()
      ? toast(msg, 8000, { label: t('backup.short'), icon: 'cloudUp', run: signIn })
      : toast(msg, 5000)),
    discard: (id) => {
      const r = store.getRecords().find((x) => x.id === id);
      if (r) deleteWithUndo(r);
    },
  });
  $('#view-calendar').addEventListener('click', onCalendarClick);
  $('#view-calendar').addEventListener('change', (e) => {
    if (e.target.id === 'cal-month-input' && e.target.value) goCal({ month: e.target.value });
  });
  bindCalendarSwipe();

  $('#btn-weather-on').addEventListener('click', enableWeather);
  $('#btn-weather-off').addEventListener('click', disableWeather);
  $('#weather-toggle').addEventListener('change', (e) => (e.target.checked ? enableWeather() : disableWeather()));
  $('.theme-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    headackTheme.set(btn.dataset.themeChoice);
    renderThemeChoice();
  });
  $('#aura-options').addEventListener('change', updateAuraWarning);

  $('#btn-clear').addEventListener('click', openClearDialog);
  $('#btn-backup').addEventListener('click', signIn);
  $('#btn-install').addEventListener('click', install);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    renderInstall();
  });
  $('#btn-try-demo').addEventListener('click', enterDemo);
  $('#btn-demo-exit').addEventListener('click', exitDemo);
  $('#btn-demo').addEventListener('click', () => (store.isDemo() ? exitDemo() : enterDemo()));
  $('#btn-share').addEventListener('click', shareSite);
  $('#clear-input').addEventListener('input', onClearInput);
  $('#clear-form').addEventListener('submit', confirmClear);
  $('#btn-clear-cancel').addEventListener('click', () => $('#clear-dialog').close());

  $('#btn-import').addEventListener('click', openImport);
  $('#btn-copy-prompt').addEventListener('click', copyPrompt);
  $('#import-text').addEventListener('input', previewImport);
  // 直接選擇匯出的 JSON 檔：讀進文字框，沿用同一套解析與預覽
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('#import-text').value = await file.text();
    e.target.value = '';
    previewImport();
  });
  $('#btn-export').addEventListener('click', exportRecords);
  $('#import-form').addEventListener('submit', confirmImport);
  $('#btn-import-close').addEventListener('click', () => $('#import-dialog').close());

  const langSelect = $('#lang-select');
  langSelect.innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  langSelect.addEventListener('change', async () => {
    await setLang(langSelect.value);
    refreshLanguage();
  });

  document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  window.addEventListener('online', () => { trySync(); fillWeather(); });
  window.addEventListener('offline', () => { syncState = 'offline'; renderSync(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trySync(); });
  store.onChange(render);
}

async function init() {
  applyIcons();
  bindEvents();
  await initI18n();
  $('#lang-select').value = getLang();
  refreshLanguage();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  try {
    await auth.initAuth();
    authReady = true;
  } catch (e) {
    console.warn('GIS unavailable (offline?)', e); // 離線時仍可本機記錄
  }
  render();
  trySync();
  fillWeather();
}

init();
