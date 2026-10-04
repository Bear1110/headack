import * as auth from './auth.js';
import * as store from './store.js';
import { openSpreadsheet, fetchEmail, ApiError } from './sheets.js';
import { OPTIONS, MED_BY_CODE, newId } from './schema.js';
import { createMedEditor, createHeadMap, medLabel, doseLabel } from './widgets.js';
import { t, getLang, setLang, initI18n, formatList, LANGS } from './i18n.js';
import { localDate, daysCovered, monthStats } from './stats.js';
import { createStatsView } from './statsview.js';
import { createQuickFlow } from './quickflow.js';
import { applyIcons, icon } from './icons.js';
import { renderCalendar as calendarHtml } from './calendar.js';
import * as weather from './weather.js';

const $ = (sel) => document.querySelector(sel);
const pad = (n) => String(n).padStart(2, '0');

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
  // 不是今年的紀錄加上年份（匯入的舊資料可能跨好幾年）
  const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {};
  return d.toLocaleString(getLang(), { ...year, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
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
  el.innerHTML = `<span>${escapeHtml(msg)}</span>${action ? `<button type="button" class="toast-action">${icon('undo')}${escapeHtml(action.label)}</button>` : ''}`;
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
    await store.sync(sheet, token);
    syncState = 'idle';
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
function openForm(record, preset = {}) {
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
  if (!email) msg = t('auth.localOnly');
  else if (syncState === 'error') msg = t('sync.failed');
  else if (syncState === 'offline') msg = t('sync.offline');
  banner.textContent = msg;
  banner.hidden = !msg;
}

function renderOngoing() {
  const ongoing = store.getRecords().filter(isOngoing).sort((a, b) => b.start.localeCompare(a.start));
  const levels = Array.from({ length: 10 }, (_, i) => i + 1);
  $('#ongoing').innerHTML = ongoing.map((r) => `
    <div class="card ongoing" data-id="${escapeHtml(r.id)}">
      <div><strong>${t('log.ongoing')}</strong> · ${escapeHtml(t('log.startedAt', { t: formatDateTime(r.start) }))}</div>
      <p class="label">${escapeHtml(t('log.howBad'))}</p>
      <div class="intensity-pick" role="group" aria-label="${escapeHtml(t('form.intensity'))}">
        ${levels.map((n) => `<button type="button" class="i${n}" data-action="intensity" data-value="${n}" aria-pressed="${r.intensity === n}">${n}</button>`).join('')}
      </div>
      <div class="actions">
        <button class="btn" data-action="end">${t('log.end')}</button>
        <button class="btn ghost" data-action="details">${t('log.details')}</button>
      </div>
    </div>`).join('');
}

// 沒有結束時間、且在 72 小時內開始，才算「進行中」（匯入的舊紀錄常沒有結束時間）
const ONGOING_WINDOW_MS = 72 * 3600 * 1000;
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

function renderList() {
  const list = [...store.getRecords()].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  if (!list.length) {
    $('#record-list').innerHTML = `<li class="muted">${t('list.empty')}</li>`;
    return;
  }
  const rest = list.length - listLimit;
  $('#record-list').innerHTML = list.slice(0, listLimit).map(recordItemHtml).join('')
    + (rest > 0 ? `<li class="list-more"><button type="button" class="btn ghost wide" data-more>${escapeHtml(t('list.more', { n: rest }))}</button></li>` : '');
}

// 列表與日曆共用的一列
function recordItemHtml(r) {
  return `
    <li class="record" data-id="${escapeHtml(r.id)}">
      <div class="record-main">
        <div>${escapeHtml(formatDateTime(r.start))}</div>
        <div class="muted small">${escapeHtml(recordSummary(r))}</div>
      </div>
      ${Number.isFinite(r.intensity) ? `<span class="intensity i${Math.min(10, Math.max(0, r.intensity))}">${r.intensity}</span>` : ''}
    </li>`;
}

// ---------- 日曆 ----------

const CAL_KEY = 'hl.calMonths';
let calMonths = 3;
try { calMonths = Number(localStorage.getItem(CAL_KEY)) === 6 ? 6 : 3; } catch { /* ignore */ }
let calSelected = null; // 'YYYY-MM-DD'

function renderCalendarView() {
  document.querySelectorAll('.cal-range [data-months]').forEach((b) => {
    b.setAttribute('aria-checked', String(Number(b.dataset.months) === calMonths));
  });
  const records = store.getRecords();
  const box = $('#calendar-months');
  box.innerHTML = calendarHtml({ records, months: calMonths, lang: getLang(), t, selected: calSelected });

  // 選取的日期：在該月下方顯示當天紀錄
  const btn = calSelected && box.querySelector(`[data-day="${calSelected}"]`);
  if (!btn) return;
  const dayRecords = records
    .filter((r) => daysCovered(r).includes(calSelected))
    .sort((a, b) => a.start.localeCompare(b.start));
  const title = new Date(`${calSelected}T00:00`).toLocaleDateString(getLang(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  btn.closest('.cal-month').insertAdjacentHTML('beforeend', `
    <div class="cal-detail">
      <h4>${escapeHtml(title)}</h4>
      ${dayRecords.length
        ? `<ul class="record-list">${dayRecords.map(recordItemHtml).join('')}</ul>`
        : `<p class="muted small">${escapeHtml(t('cal.noEntries'))}</p>`}
      <button type="button" class="btn ghost small" data-add-day="${calSelected}">＋ ${escapeHtml(t('cal.addForDay'))}</button>
    </div>`);
}

function onCalendarClick(e) {
  const range = e.target.closest('[data-months]');
  if (range) {
    calMonths = Number(range.dataset.months);
    try { localStorage.setItem(CAL_KEY, String(calMonths)); } catch { /* ignore */ }
    return renderCalendarView();
  }
  const day = e.target.closest('[data-day]');
  if (day) {
    calSelected = calSelected === day.dataset.day ? null : day.dataset.day;
    return renderCalendarView();
  }
  const item = e.target.closest('li[data-id]');
  if (item) return openForm(store.getRecords().find((r) => r.id === item.dataset.id));
  const add = e.target.closest('[data-add-day]');
  if (add) {
    // 補登：日期用選取的那天，時間先帶目前時間
    const now = nowLocal();
    openForm(null, { start: `${add.dataset.addDay}T${now.slice(11)}` });
  }
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
  const m = monthStats(records, today.slice(0, 7));
  const parts = [];
  if (!records.some(isOngoing)) parts.push(since <= 0 ? t('home.today') : t('home.since', { n: since }));
  parts.push(t('home.month', { h: m.headacheDays, m: m.medDays }));
  el.textContent = parts.join(' · ');
  el.classList.toggle('alert', m.mohWarnings.length > 0);
}

// 新使用者（還沒有任何紀錄）在首頁看到一句理念，有紀錄後就收起來
function renderTagline() {
  const fresh = !store.getRecords().length && !store.isDemo();
  $('#tagline').hidden = !fresh;
  $('#btn-try-demo').hidden = !fresh;
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

function renderSettings() {
  $('#btn-demo').textContent = t(store.isDemo() ? 'demo.exit' : 'demo.enter');
  $('#weather-toggle').checked = weather.getPref() === 'on';
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
  renderOngoing();
  renderHomeSummary();
  renderTagline();
  renderWeatherPrompt();
  renderList();
  renderCalendarView();
  renderStats();
  renderSettings();
}

// 語言切換後重建由 JS 產生的文字（靜態文字由 i18n.applyI18n 處理）
function refreshLanguage() {
  $('#copyright').textContent = t('footer.copyright', { year: new Date().getFullYear() });
  buildFormOptions();
  render();
}

// 版面（手機 / 桌機）由 CSS 依 body[data-view] 決定
function showView(name) {
  document.body.dataset.view = name;
  window.scrollTo(0, 0);
  if (name === 'stats') statsView?.render(); // 隱藏時量不到圖表寬度，切過來再畫一次
  // 手機上月份是單欄、本月在最下面：切到日曆時直接捲到本月
  if (name === 'calendar' && matchMedia('(max-width: 599px)').matches) {
    document.querySelector('#calendar-months .cal-month:last-child')?.scrollIntoView({ block: 'start' });
  }
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
    else openForm(store.getRecords().find((r) => r.id === id));
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

  statsView = createStatsView($('#view-stats'), { t, getLang, getRecords: store.getRecords });
  quickFlow = createQuickFlow($('#quick-dialog'), {
    t,
    getRecord: (id) => store.getRecords().find((r) => r.id === id),
    saveRecord: (r) => save(r, false, { quiet: true }),
    frequentMeds,
    notify: (msg) => toast(msg, 5000),
    discard: (id) => {
      const r = store.getRecords().find((x) => x.id === id);
      if (r) deleteWithUndo(r);
    },
  });
  $('#view-calendar').addEventListener('click', onCalendarClick);

  $('#btn-weather-on').addEventListener('click', enableWeather);
  $('#btn-weather-off').addEventListener('click', disableWeather);
  $('#weather-toggle').addEventListener('change', (e) => (e.target.checked ? enableWeather() : disableWeather()));
  $('#aura-options').addEventListener('change', updateAuraWarning);

  $('#btn-clear').addEventListener('click', openClearDialog);
  $('#btn-try-demo').addEventListener('click', enterDemo);
  $('#btn-demo-exit').addEventListener('click', exitDemo);
  $('#btn-demo').addEventListener('click', () => (store.isDemo() ? exitDemo() : enterDemo()));
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
