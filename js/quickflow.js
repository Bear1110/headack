// 發作當下的快速問答：一次一題、大按鈕、可跳過、每題答完就存。
// 給正在頭痛、沒耐心也不想看刺眼畫面的人用；事後的完整編輯仍用一般表單。
//
// 模式：
// - 'start'：按「頭痛開始了」之後 → 程度 → 位置 → 症狀 → 用藥
// - 'end'：按「結束了」時，若有用藥但沒填效果 → 只問「藥有效嗎？」
// 最後一題答完直接關閉，用提示訊息告知已記錄（不另外放一頁「完成」，少按一次）。

import { OPTIONS } from './schema.js';
import { createHeadMap } from './widgets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 預兆與伴隨症狀合成一題（欄位不同）
const SYMPTOM_CHOICES = [
  ...['visual', 'sensory', 'speech', 'motor'].map((c) => ({ field: 'aura', code: c, key: `opt.aura.${c}` })),
  ...['nausea', 'vomiting', 'photophobia', 'phonophobia', 'osmophobia', 'dizziness'].map((c) => ({ field: 'symptoms', code: c, key: `opt.symptoms.${c}` })),
];

export function createQuickFlow(dialog, { t, getRecord, saveRecord, frequentMeds, notify }) {
  let recordId = null;
  let steps = [];
  let index = 0;
  let headMap = null;
  let mode = 'start';

  const record = () => getRecord(recordId);
  const update = (patch) => {
    const r = record();
    if (r) saveRecord({ ...r, ...patch });
  };

  function open(id, openMode = 'start') {
    recordId = id;
    mode = openMode;
    steps = mode === 'end' ? ['effect'] : ['intensity', 'where', 'symptoms', 'meds'];
    index = 0;
    render();
    if (!dialog.open) dialog.showModal();
  }

  const close = () => dialog.close();
  const finish = () => {
    close();
    notify(t(mode === 'end' ? 'qf.doneEnd' : 'qf.doneStart'));
  };
  const next = () => {
    if (index >= steps.length - 1) return finish();
    index += 1;
    render();
  };

  // ---------- 每一題 ----------

  function intensityStep(r) {
    const btns = Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `
      <button type="button" class="qf-num i${n}" data-intensity="${n}" aria-pressed="${r.intensity === n}">${n}</button>`).join('');
    return `
      <h2>${esc(t('log.howBad'))}</h2>
      <div class="qf-scale"><span>${esc(t('qf.low'))}</span><span>${esc(t('qf.high'))}</span></div>
      <div class="qf-grid qf-intensity">${btns}</div>`;
  }

  function whereStep() {
    return `
      <h2>${esc(t('qf.where'))}</h2>
      <p class="qf-hint">${esc(t('qf.multiHint'))}</p>
      <div id="qf-head" class="qf-head"></div>`;
  }

  function symptomsStep(r) {
    const chips = SYMPTOM_CHOICES.map((c) => `
      <button type="button" class="qf-chip" data-field="${c.field}" data-code="${c.code}" aria-pressed="${(r[c.field] ?? []).includes(c.code)}">${esc(t(c.key))}</button>`).join('');
    const red = ['aura'].some((f) => (r[f] ?? []).some((c) => c === 'motor' || c === 'speech'));
    return `
      <h2>${esc(t('qf.symptoms'))}</h2>
      <p class="qf-hint">${esc(t('qf.multiHint'))}</p>
      <div class="qf-grid qf-chips">${chips}</div>
      ${red ? `<p class="qf-warning" role="alert">${esc(t('form.auraWarning'))}</p>` : ''}`;
  }

  function medsStep(r) {
    const taken = new Set((r.meds ?? []).map((m) => m.code));
    const btns = frequentMeds().slice(0, 6).map((c) => `
      <button type="button" class="qf-chip qf-med" data-med="${c}" aria-pressed="${taken.has(c)}">${esc(t(`med.${c}`))}</button>`).join('');
    return `
      <h2>${esc(t('qf.meds'))}</h2>
      <p class="qf-hint">${esc(t('qf.medsHint'))}</p>
      <div class="qf-grid qf-chips">${btns}</div>`;
  }

  function effectStep(r) {
    const btns = OPTIONS.med_effect.map((c) => `
      <button type="button" class="qf-big" data-effect="${c}" aria-pressed="${r.med_effect === c}">${esc(t(`opt.med_effect.${c}`))}</button>`).join('');
    return `
      <h2>${esc(t('qf.effect'))}</h2>
      <div class="qf-stack">${btns}</div>`;
  }

  // ---------- 畫面 ----------

  function render() {
    const r = record();
    if (!r) return close();
    const step = steps[index];
    const questions = steps.length;
    const body = {
      intensity: intensityStep, where: whereStep, symptoms: symptomsStep, meds: medsStep, effect: effectStep,
    }[step](r);

    // 多選題用「下一步」；單選題點了就自動前進，所以只有「跳過」
    const multi = ['where', 'symptoms', 'meds'].includes(step);
    const hasValue = step === 'meds' ? r.meds?.length : step === 'symptoms' ? (r.aura?.length || r.symptoms?.length) : true;
    const last = index === steps.length - 1;
    const nextLabel = step === 'meds' && !hasValue ? 'qf.noMeds' : last ? 'qf.finish' : 'qf.next';
    const footer = `<button type="button" class="qf-secondary" data-act="skip">${esc(t('qf.skip'))}</button>
         ${multi ? `<button type="button" class="qf-primary" data-act="next">${esc(t(nextLabel))}</button>` : ''}`;

    dialog.innerHTML = `
      <div class="qf">
        <header class="qf-top">
          <span class="qf-progress">${questions < 2 ? '' : esc(t('qf.step', { i: index + 1, n: questions }))}</span>
          <button type="button" class="qf-close" data-act="close" aria-label="${esc(t('import.close'))}">✕</button>
        </header>
        <div class="qf-body">${body}</div>
        <footer class="qf-foot">${footer}</footer>
      </div>`;

    if (step === 'where') {
      headMap = createHeadMap(dialog.querySelector('#qf-head'), { t });
      headMap.set(r.locations);
    }
    dialog.querySelector('.qf-body button, .qf-foot .qf-primary')?.focus({ preventScroll: true });
  }

  // ---------- 互動 ----------

  dialog.addEventListener('click', (e) => {
    const el = e.target.closest('button');
    if (!el) return;
    const r = record();
    if (!r) return close();
    const step = steps[index];

    if (el.dataset.intensity) {
      update({ intensity: Number(el.dataset.intensity) });
      render();
      setTimeout(next, 220); // 讓使用者看到自己點了哪個
      return;
    }
    if (el.dataset.effect) {
      update({ med_effect: el.dataset.effect });
      render();
      setTimeout(next, 220);
      return;
    }
    if (el.dataset.field) {
      const list = new Set(r[el.dataset.field] ?? []);
      if (list.has(el.dataset.code)) list.delete(el.dataset.code);
      else list.add(el.dataset.code);
      update({ [el.dataset.field]: [...list] });
      return render();
    }
    if (el.dataset.med) {
      const code = el.dataset.med;
      const meds = (r.meds ?? []).some((m) => m.code === code)
        ? r.meds.filter((m) => m.code !== code)
        // 用量先記 1，時機依疼痛程度推斷；事後可在完整表單修改
        : [...(r.meds ?? []), { code, amount: 1, timing: (r.intensity ?? 0) >= 7 ? 'severe' : 'early', name: '' }];
      update({ meds });
      return render();
    }

    switch (el.dataset.act) {
      case 'next':
        if (step === 'where' && headMap) update({ locations: headMap.get() });
        return next();
      case 'skip':
        return next();
      case 'close':
        if (step === 'where' && headMap) update({ locations: headMap.get() });
        return close();
      default:
    }
  });

  return { open };
}
