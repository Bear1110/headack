// 表單元件：用藥清單編輯器、疼痛位置頭部圖。
// 兩者都是「狀態在 JS、畫面每次整段重繪」的簡單元件，對外提供 set() / get()。

import { MEDS, MED_BY_CODE, MED_TIMINGS, DOSE_STEP } from './schema.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function medLabel(t, m) {
  return m.code === 'other_med' && m.name ? m.name : t(`med.${m.code}`);
}

export function doseLabel(t, m) {
  if (m.amount == null) return '';
  const form = MED_BY_CODE[m.code]?.form ?? 'tablet';
  return `${m.amount} ${t(`unit.${form}`, { n: m.amount })}`;
}

// ---------- 用藥 ----------

// getFrequent(): 依使用者過去紀錄排序的常用藥代碼（無紀錄時用語系預設）
export function createMedEditor(root, { t, getFrequent }) {
  let meds = [];

  const CATEGORY_ORDER = ['simple', 'combination', 'triptan', 'ergot', 'opioid'];

  function render() {
    const quick = getFrequent().slice(0, 4);
    const groups = CATEGORY_ORDER.map((cat) => {
      const opts = MEDS.filter((m) => m.category === cat && m.code !== 'other_med')
        .map((m) => `<option value="${m.code}">${esc(t(`med.${m.code}`))}</option>`).join('');
      return `<optgroup label="${esc(t(`cat.${cat}`))}">${opts}</optgroup>`;
    }).join('');

    root.innerHTML = `
      <div class="chips med-quick">
        ${quick.map((c) => `<button type="button" class="chip-btn" data-add="${c}">＋ ${esc(t(`med.${c}`))}</button>`).join('')}
      </div>
      <select class="med-add" aria-label="${esc(t('form.addMed'))}">
        <option value="">${esc(t('form.addMed'))}</option>
        ${groups}
        <option value="other_med">${esc(t('med.other_med'))}</option>
      </select>
      <ul class="med-list">
        ${meds.map((m, i) => `
          <li class="med-item" data-i="${i}">
            <div class="med-head">
              ${m.code === 'other_med'
                ? `<input type="text" class="med-name" value="${esc(m.name)}" placeholder="${esc(t('form.customMedName'))}" aria-label="${esc(t('form.customMedName'))}">`
                : `<strong>${esc(t(`med.${m.code}`))}</strong>`}
              <button type="button" class="icon-btn" data-act="remove" aria-label="${esc(t('form.remove'))}" title="${esc(t('form.remove'))}">✕</button>
            </div>
            <div class="med-controls">
              <div class="stepper" role="group" aria-label="${esc(t('form.dose'))}">
                <button type="button" data-act="less" aria-label="${esc(t('form.less'))}">−</button>
                <output>${esc(doseLabel(t, m) || '—')}</output>
                <button type="button" data-act="more" aria-label="${esc(t('form.more'))}">＋</button>
              </div>
              <div class="seg" role="radiogroup" aria-label="${esc(t('form.timing'))}">
                ${MED_TIMINGS.map((tm) => `<button type="button" role="radio" data-act="timing" data-v="${tm}" aria-checked="${m.timing === tm}">${esc(t(`timing.${tm}`))}</button>`).join('')}
              </div>
            </div>
          </li>`).join('')}
      </ul>`;
  }

  function add(code) {
    if (!MED_BY_CODE[code]) return;
    meds.push({ code, amount: 1, timing: '', name: '' });
    render();
    if (code === 'other_med') root.querySelector('.med-item:last-child .med-name')?.focus();
  }

  root.addEventListener('click', (e) => {
    const addBtn = e.target.closest('[data-add]');
    if (addBtn) return add(addBtn.dataset.add);
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const i = Number(btn.closest('.med-item').dataset.i);
    const m = meds[i];
    switch (btn.dataset.act) {
      case 'remove': meds.splice(i, 1); break;
      case 'less': m.amount = Math.max(DOSE_STEP, (m.amount ?? 1) - DOSE_STEP); break;
      case 'more': m.amount = Math.min(10, (m.amount ?? 0) + DOSE_STEP); break;
      case 'timing': m.timing = m.timing === btn.dataset.v ? '' : btn.dataset.v; break;
    }
    render();
  });

  root.addEventListener('change', (e) => {
    if (e.target.matches('.med-add') && e.target.value) add(e.target.value);
  });

  // 自訂藥名：直接更新狀態，不重繪（避免輸入中失去焦點）
  root.addEventListener('input', (e) => {
    if (!e.target.matches('.med-name')) return;
    meds[Number(e.target.closest('.med-item').dataset.i)].name = e.target.value;
  });

  return {
    set(list) { meds = (list ?? []).map((m) => ({ ...m })); render(); },
    get() { return meds.filter((m) => m.code !== 'other_med' || m.name.trim()).map((m) => ({ ...m, name: m.name?.trim() ?? '' })); },
    render,
  };
}

// ---------- 疼痛位置 ----------

// 頭部圖：正面（看著對方，所以患者的右邊在畫面左側）與背面（從後面看，左右與畫面一致）。
// 區塊是用矩形裁切在頭形內，形狀簡單但點選範圍明確。
const HEAD = { cx: 100, cy: 105, rx: 70, ry: 88 };
const FRONT_ZONES = [
  ['forehead_r', 30, 17, 70, 58], ['forehead_l', 100, 17, 70, 58],
  ['temple_r', 30, 75, 32, 55], ['eye_r', 62, 75, 38, 55], ['eye_l', 100, 75, 38, 55], ['temple_l', 138, 75, 32, 55],
  ['face_r', 30, 130, 70, 63], ['face_l', 100, 130, 70, 63],
];
const BACK_ZONES = [
  ['vertex', 30, 17, 140, 45],
  ['occiput_l', 30, 62, 70, 131], ['occiput_r', 100, 62, 70, 131],
];
const NECK_ZONES = [['neck_l', 72, 180, 28, 52], ['neck_r', 100, 180, 28, 52]];

function headSvg(id, zones, neckZones, leftLabel, rightLabel, title, t, selected) {
  const zone = ([code, x, y, w, h], clip) => `
    <rect class="zone" data-zone="${code}" x="${x}" y="${y}" width="${w}" height="${h}" ${clip ? `clip-path="url(#${id}-clip)"` : ''}
      role="checkbox" tabindex="0" aria-checked="${selected.has(code)}" aria-label="${esc(t(`loc.${code}`))}"><title>${esc(t(`loc.${code}`))}</title></rect>`;
  return `
    <figure class="head">
      <svg viewBox="0 0 200 240" aria-label="${esc(title)}">
        <defs><clipPath id="${id}-clip"><ellipse cx="${HEAD.cx}" cy="${HEAD.cy}" rx="${HEAD.rx}" ry="${HEAD.ry}"/></clipPath></defs>
        <rect class="neck" x="72" y="170" width="56" height="62" rx="8"/>
        ${neckZones.map((z) => zone(z, false)).join('')}
        <ellipse class="ear" cx="28" cy="110" rx="9" ry="20"/><ellipse class="ear" cx="172" cy="110" rx="9" ry="20"/>
        <ellipse class="skull" cx="${HEAD.cx}" cy="${HEAD.cy}" rx="${HEAD.rx}" ry="${HEAD.ry}"/>
        ${zones.map((z) => zone(z, true)).join('')}
        ${id.endsWith('front') ? `
          <g class="face-lines" aria-hidden="true">
            <path d="M68 104 q13 -8 26 0 M106 104 q13 -8 26 0"/>
            <path d="M100 118 v20 q-4 4 -8 2"/>
            <path d="M84 162 q16 8 32 0"/>
          </g>` : ''}
        <ellipse class="outline" cx="${HEAD.cx}" cy="${HEAD.cy}" rx="${HEAD.rx}" ry="${HEAD.ry}"/>
        <text class="side" x="8" y="22">${esc(leftLabel)}</text>
        <text class="side" x="192" y="22" text-anchor="end">${esc(rightLabel)}</text>
      </svg>
      <figcaption>${esc(title)}</figcaption>
    </figure>`;
}

export function createHeadMap(root, { t }) {
  let selected = new Set();

  function render() {
    const L = t('form.sideL');
    const R = t('form.sideR');
    root.innerHTML = `
      <div class="heads">
        ${headSvg('head-front', FRONT_ZONES, [], R, L, t('form.front'), t, selected)}
        ${headSvg('head-back', BACK_ZONES, NECK_ZONES, L, R, t('form.back'), t, selected)}
      </div>
      <p class="muted small loc-summary">${[...selected].map((c) => esc(t(`loc.${c}`))).join(t('list.separator')) || '—'}</p>`;
  }

  function toggle(code) {
    if (selected.has(code)) selected.delete(code);
    else selected.add(code);
    render();
    root.querySelector(`[data-zone="${code}"]`)?.focus();
  }

  root.addEventListener('click', (e) => {
    const z = e.target.closest('[data-zone]');
    if (z) toggle(z.dataset.zone);
  });
  root.addEventListener('keydown', (e) => {
    const z = e.target.closest('[data-zone]');
    if (z && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      toggle(z.dataset.zone);
    }
  });

  return {
    set(list) { selected = new Set(list ?? []); render(); },
    get() { return [...selected]; },
    render,
  };
}
