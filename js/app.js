import * as auth from './auth.js';
import * as store from './store.js';
import { openSpreadsheet, fetchEmail, ApiError } from './sheets.js';
import { OPTIONS, MED_BY_CODE, newId } from './schema.js';
import { createMedEditor, createHeadMap, medLabel, doseLabel } from './widgets.js';
import { t, getLang, setLang, initI18n, formatList, LANGS } from './i18n.js';
import { monthStats, localDate, daysCovered } from './stats.js';
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
  return new Date(iso).toLocaleString(getLang(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(start, end) {
  const mins = Math.round((new Date(end) - new Date(start)) / 60000);
  if (!(mins >= 0)) return '';
  return t('list.duration', { h: Math.floor(mins / 60), m: mins % 60 });
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ---------- 同步 ----------

async function trySync() {
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
      sheet = await openSpreadsheet(token, { cachedId: store.getCachedSheetId(), title: t('app.title') });
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

function save(record, isNew) {
  const now = new Date().toISOString();
  record.updated_at = now;
  if (isNew) record.created_at = now;
  store.saveRecord(record, { isNew });
  toast(t('log.saved'));
  trySync();
  fillWeather();
}

// ---------- 天氣 ----------

const weatherTried = new Set(); // 本次開啟頁面已查過的紀錄，避免重複請求
const hasWeather = (r) => r.pressure_hpa != null && r.pressure_hpa !== '';

// 為最近 48 小時內、還沒有天氣資料的紀錄補上天氣（背景執行，失敗就略過）
async function fillWeather() {
  if (weather.getPref() !== 'on' || !navigator.onLine) return;
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
    id: newId(), start: nowLocal(), end: '', intensity: null, type: '', locations: [], aura: [], symptoms: [],
    meds: [], med_effect: '', triggers: [], notes: '',
  };
}

function quickStart() {
  save(emptyRecord(), true);
}

function setIntensity(id, value) {
  const r = store.getRecords().find((x) => x.id === id);
  if (!r) return;
  save({ ...r, intensity: value }, false);
}

function endRecord(id) {
  const r = store.getRecords().find((x) => x.id === id);
  if (!r) return;
  save({ ...r, end: nowLocal() }, false);
}

// ---------- 表單 ----------

function buildFormOptions() {
  const form = $('#record-form');
  const fillSelect = (select, field, codes) => {
    select.innerHTML = '<option value="">—</option>' + codes.map((c) => `<option value="${c}">${escapeHtml(t(`opt.${field}.${c}`))}</option>`).join('');
  };
  fillSelect(form.elements.type, 'type', OPTIONS.type);
  fillSelect(form.elements.med_effect, 'med_effect', OPTIONS.med_effect);
  const chips = (container, field, codes) => {
    container.innerHTML = codes.map((c) => `<label class="chip"><input type="checkbox" name="${field}" value="${c}"><span>${escapeHtml(t(`opt.${field}.${c}`))}</span></label>`).join('');
  };
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
  form.elements.type.value = r.type || '';
  form.elements.med_effect.value = r.med_effect || '';
  form.elements.notes.value = r.notes || '';
  medEditor.set(r.meds);
  headMap.set(r.locations);
  for (const field of ['triggers', 'aura', 'symptoms']) {
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
    type: f.type.value,
    locations: headMap.get(),
    meds: medEditor.get(),
    med_effect: f.med_effect.value,
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

function deleteEditing() {
  if (!editing || !confirm(t('form.confirmDelete'))) return;
  store.deleteRecord(editing.id);
  $('#record-dialog').close();
  trySync();
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
  const hasToken = auth.hasValidToken();
  const email = auth.getEmail();
  const pending = store.pendingCount();
  const status = $('#sync-status');
  const banner = $('#banner');

  if (syncState === 'syncing') status.textContent = t('sync.syncing');
  else if (pending) status.textContent = t('sync.pending', { n: pending });
  else if (hasToken) status.textContent = t('sync.synced');
  else status.textContent = '';

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

function renderList() {
  const list = [...store.getRecords()].sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  if (!list.length) {
    $('#record-list').innerHTML = `<li class="muted">${t('list.empty')}</li>`;
    return;
  }
  $('#record-list').innerHTML = list.map(recordItemHtml).join('');
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

function renderStats() {
  const input = $('#stats-month');
  if (!input.value) input.value = localDate(new Date()).slice(0, 7);
  const s = monthStats(store.getRecords(), input.value);
  const tile = (label, value) => `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${label}</div></div>`;
  const types = Object.entries(s.typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<li>${escapeHtml(t(`opt.type.${k}`))}<span>${n}</span></li>`).join('');
  const warnings = s.mohWarnings
    .map((w) => `<p class="warning">${escapeHtml(t('stats.mohWarning', { cat: t(`cat.${w.cat}`), n: w.n, limit: w.limit }))}</p>`).join('');
  $('#stats-body').innerHTML = `
    ${warnings}
    <div class="tiles">
      ${tile(t('stats.headacheDays'), s.headacheDays)}
      ${tile(t('stats.medDays'), s.medDays)}
      ${tile(t('stats.episodes'), s.episodes)}
      ${tile(t('stats.avgIntensity'), s.avgIntensity == null ? '—' : s.avgIntensity.toFixed(1))}
    </div>
    ${types ? `<div class="card"><h2>${t('stats.byType')}</h2><ul class="kv">${types}</ul></div>` : ''}`;
}

// 尚未決定是否記錄天氣、且已有紀錄時，在記錄頁詢問一次
function renderWeatherPrompt() {
  $('#weather-prompt').hidden = weather.getPref() != null || !store.getRecords().length;
}

function renderSettings() {
  $('#weather-toggle').checked = weather.getPref() === 'on';
  const email = auth.getEmail();
  $('#account-email').textContent = email || t('auth.localOnly');
  $('#btn-signout').hidden = !email;
  const link = $('#sheet-link');
  link.hidden = !sheet;
  if (sheet) link.href = sheet.url;
}

function render() {
  renderSync();
  renderOngoing();
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
    const li = e.target.closest('li[data-id]');
    if (li) openForm(store.getRecords().find((r) => r.id === li.dataset.id));
  });

  $('#record-form').addEventListener('submit', submitForm);
  $('#record-form').elements.intensity.addEventListener('input', (e) => { $('#intensity-out').textContent = e.target.value; });
  $('#btn-cancel').addEventListener('click', () => $('#record-dialog').close());
  $('#btn-delete').addEventListener('click', deleteEditing);

  $('#stats-month').addEventListener('change', renderStats);
  $('#view-calendar').addEventListener('click', onCalendarClick);

  $('#btn-weather-on').addEventListener('click', enableWeather);
  $('#btn-weather-off').addEventListener('click', disableWeather);
  $('#weather-toggle').addEventListener('change', (e) => (e.target.checked ? enableWeather() : disableWeather()));
  $('#aura-options').addEventListener('change', updateAuraWarning);

  $('#btn-import').addEventListener('click', openImport);
  $('#btn-copy-prompt').addEventListener('click', copyPrompt);
  $('#import-text').addEventListener('input', previewImport);
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
