// 統計頁：篩選列 + 兩個子分頁
// - 我的趨勢：使用者自己評估「變好還是變差、什麼時候痛、藥有沒有效」
// - 看診摘要：醫師會看的數據（頭痛天數、用藥天數與過度使用、發作特徵、叢集型、治療反應），可列印

import { OPTIONS, MOH_THRESHOLDS, MED_BY_CODE } from './schema.js';
import { RANGE_PRESETS, resolveRange, previousRange, filterRecords, analyze } from './analysis.js';
import { columnChart, tableView, proportionList, attachTooltips, applyProportions } from './charts.js';
import { medLabel } from './widgets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATE_KEY = 'hl.statsState';
const MED_CATS = ['simple', 'combination', 'triptan', 'ergot', 'opioid'];

function loadState() {
  const def = { tab: 'self', range: '3m', from: '', to: '', types: [], meds: 'all' };
  try { return { ...def, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}') }; } catch { return def; }
}

export function createStatsView(root, { t, getLang, getRecords, onAiAnalysis }) {
  let state = loadState();
  const save = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ } };

  const lang = () => getLang();
  const fmt1 = (v) => (Math.round(v * 10) / 10).toLocaleString(lang());
  const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '—');
  const nOf = (n, total) => `${pct(n, total)}（${t('st.nOf', { n, total })}）`;
  const dateText = (day) => new Date(`${day}T00:00`).toLocaleDateString(lang(), { year: 'numeric', month: 'numeric', day: 'numeric' });
  const monthLabel = (ym, withYear) => new Date(`${ym}-01T00:00`).toLocaleDateString(lang(), withYear ? { year: 'numeric', month: 'short' } : { month: 'short' });
  const durText = (min) => t('list.duration', { h: Math.floor(min / 60), m: Math.round(min % 60) });
  // 圖表先放佔位元素，等版面排好後再依實際寬度繪製（見 render()）
  let chartSpecs = [];
  const chart = (spec) => {
    chartSpecs.push(spec);
    return `<div class="chart-slot" data-chart="${chartSpecs.length - 1}"></div>`;
  };

  // ---------- 篩選列 ----------

  function filtersHtml(records, range) {
    // 與表單相同的類型清單與順序；附上筆數，0 筆的變淡（未填類型算在「不確定」）
    const typeCount = Object.fromEntries(OPTIONS.type.map((c) => [c, 0]));
    for (const r of records) {
      const day = r.start?.slice(0, 10);
      if (day && day >= range.from && day <= range.to) typeCount[r.type || 'unknown'] = (typeCount[r.type || 'unknown'] ?? 0) + 1;
    }
    const medCodes = [...new Set(records.flatMap((r) => (r.meds ?? []).map((m) => m.code)))];
    const rangeBtns = RANGE_PRESETS.map((p) => `<button type="button" role="radio" data-range="${p}" aria-checked="${state.range === p}">${esc(t(`st.r${p}`))}</button>`).join('');
    return `
      <div class="stats-filters">
        <div class="filter-group">
          <span class="filter-label">${esc(t('st.range'))}</span>
          <div class="seg range-seg" role="radiogroup" aria-label="${esc(t('st.range'))}">${rangeBtns}</div>
          ${state.range === 'custom' ? `
            <div class="custom-range">
              <label><span>${esc(t('st.from'))}</span><input type="date" data-custom="from" value="${esc(state.from)}"></label>
              <label><span>${esc(t('st.to'))}</span><input type="date" data-custom="to" value="${esc(state.to)}"></label>
            </div>` : ''}
        </div>
        <div class="filter-row">
          <div class="filter-group">
            <span class="filter-label">${esc(t('st.types'))} <span class="filter-hint">${esc(t('st.typesHint'))}</span></span>
            <div class="chips">
              <button type="button" class="chip-toggle" data-type="" aria-pressed="${!state.types.length}">${esc(t('st.allTypes'))}</button>
              ${OPTIONS.type.map((c) => {
                const on = state.types.includes(c);
                return `<button type="button" class="chip-toggle" data-type="${c}" aria-pressed="${on}" ${typeCount[c] || on ? '' : 'disabled'}>${esc(t(`opt.type.${c}`))}<span class="chip-count">${typeCount[c]}</span></button>`;
              }).join('')}
            </div>
          </div>
          <label class="filter-group">
            <span class="filter-label">${esc(t('st.meds'))}</span>
            <select data-meds>
              ${['all', 'with', 'without'].map((v) => `<option value="${v}" ${state.meds === v ? 'selected' : ''}>${esc(t(`st.meds_${v}`))}</option>`).join('')}
              ${medCodes.length ? `<optgroup label="${esc(t('st.medsOnly'))}">${medCodes.map((c) => `<option value="${c}" ${state.meds === c ? 'selected' : ''}>${esc(t(`med.${c}`))}</option>`).join('')}</optgroup>` : ''}
            </select>
          </label>
        </div>
      </div>
      <div class="seg stats-tabs" role="tablist">
        ${['self', 'doctor'].map((tab) => `<button type="button" role="tab" data-tab="${tab}" aria-selected="${state.tab === tab}" aria-checked="${state.tab === tab}">${esc(t(`st.tab_${tab}`))}</button>`).join('')}
      </div>`;
  }

  // ---------- 共用片段 ----------

  const card = (title, body, extra = '') => `<section class="card stat-card ${extra}"><h2>${esc(title)}</h2>${body}</section>`;
  const notEnough = (hint = '') => `<p class="muted small">${esc(hint ? t('st.notEnoughWith', { hint }) : t('st.notEnough'))}</p>`;

  function monthsChart(a, { withMeds, ref }) {
    const withYear = a.months.length > 12 || a.months[0]?.ym.slice(0, 4) !== a.months[a.months.length - 1]?.ym.slice(0, 4);
    const labels = a.months.map((m) => monthLabel(m.ym, withYear));
    const series = [{ name: t('st.seriesHeadache'), values: a.months.map((m) => m.headacheDays), cls: 's1' }];
    if (withMeds) series.push({ name: t('st.seriesMeds'), values: a.months.map((m) => m.medDays), cls: 's2' });
    const head = [t('st.colMonth'), ...series.map((s) => s.name)];
    const rows = a.months.map((m, i) => [labels[i] + (m.partial ? '*' : ''), ...series.map((s) => s.values[i])]);
    // 超過兩年：X 軸只在每年 1 月標年份（完整月份仍在提示與表格中）
    const long = a.months.length > 24;
    const axis = long ? { showLabel: (i) => a.months[i].ym.endsWith('-01') || i === 0, axisLabel: (i) => a.months[i].ym.slice(0, 4) } : {};
    return chart({ labels, series, ref, ...axis, title: series.map((s) => s.name).join(' / ') })
      + (a.months.some((m) => m.partial) ? `<p class="muted small">${esc(t('st.partialNote'))}</p>` : '')
      + tableView(t('st.table'), head, rows);
  }

  function weekdayChart(a) {
    const fmtW = new Intl.DateTimeFormat(lang(), { weekday: 'short' });
    const labels = Array.from({ length: 7 }, (_, i) => fmtW.format(new Date(2023, 0, 1 + i)));
    return chart({ labels, series: [{ name: t('st.attacks'), values: a.weekday, cls: 's1' }], height: 170, title: t('st.weekdayTitle') })
      + tableView(t('st.table'), [t('st.colWeekday'), t('st.attacks')], labels.map((l, i) => [l, a.weekday[i]]));
  }

  function hourChart(hours, timed, total, title) {
    if (!timed) return notEnough(t('st.hourNote', { n: total }));
    const labels = hours.map((_, h) => String(h));
    return chart({ labels, series: [{ name: t('st.attacks'), values: hours, cls: 's1' }], height: 170, showLabel: (i) => i % 3 === 0, title })
      + (total > timed ? `<p class="muted small">${esc(t('st.hourNote', { n: total - timed }))}</p>` : '')
      + tableView(t('st.table'), [t('st.colHour'), t('st.attacks')], labels.map((l, i) => [`${l}:00`, hours[i]]).filter((r) => r[1]));
  }

  // 以藥物為單位：使用天數（主要指標）、總量與單日最多（只在同一種藥之間比較）、有效比例
  function medsTable(a) {
    if (!a.meds.length) return notEnough();
    const amount = (v, m) => (m.unknownAmount && !v ? '—' : `${fmt1(v)}${m.unknownAmount ? '+' : ''}`);
    const rows = a.meds.map((m) => `
      <tr>
        <th scope="row">${esc(medLabel(t, m))}</th>
        <td class="num">${m.days}</td>
        <td class="num">${amount(m.totalAmount, m)}</td>
        <td class="num">${amount(m.maxPerDay, m)}</td>
        <td class="num">${m.rated ? `${pct(m.effective, m.rated)} <span class="muted">(${m.rated})</span>` : '—'}</td>
      </tr>`).join('');
    return `
      <div class="table-wrap"><table>
        <thead><tr><th>${esc(t('st.colMed'))}</th><th class="num">${esc(t('st.colDays'))}</th><th class="num">${esc(t('st.colTotal'))}</th><th class="num">${esc(t('st.colMaxDay'))}</th><th class="num">${esc(t('st.colEffective'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="muted small">${esc(t('st.doseNote'))}</p>
      <p class="muted small">${esc(t('st.effectiveNote'))}</p>`;
  }

  function deltaHtml(cur, prev) {
    if (prev == null) return '';
    const d = Math.round((cur - prev) * 10) / 10;
    if (!d) return `<div class="tile-delta">${esc(t('st.same'))}</div>`;
    // 頭痛、用藥天數減少是好事
    const good = d < 0;
    return `<div class="tile-delta ${good ? 'good' : 'bad'}">${good ? '↓' : '↑'} ${esc(t(good ? 'st.deltaDown' : 'st.deltaUp', { v: fmt1(Math.abs(d)) }))}</div>`;
  }

  // ---------- 我的趨勢 ----------

  function selfHtml(a, prev) {
    const perM = (n) => a.perMonth(n);
    const tile = (label, value, delta = '') => `<div class="tile"><div class="tile-value">${value}</div><div class="tile-label">${esc(label)}</div>${delta}</div>`;
    const tiles = `
      <div class="tiles">
        ${tile(t('st.headacheDaysPerMonth'), fmt1(perM(a.headacheDays)), prev && deltaHtml(perM(a.headacheDays), prev.perMonth(prev.headacheDays)))}
        ${tile(t('st.medDaysPerMonth'), fmt1(perM(a.medDays)), prev && deltaHtml(perM(a.medDays), prev.perMonth(prev.medDays)))}
        ${tile(t('st.attacks'), a.attacks)}
        ${tile(t('st.avgIntensity'), a.intensity.n ? `${fmt1(a.intensity.mean)}<small>/10</small>` : '—')}
      </div>
      ${prev ? `<p class="muted small">${esc(t('st.vsPrev', { from: dateText(prev.from), to: dateText(prev.to) }))}</p>` : ''}`;

    // 服藥時機與效果：每列分母不同（該時機有填效果的筆數）
    const timingRows = Object.entries(a.timing);
    const timingHtml = timingRows.length
      ? `<ul class="prop-list">${timingRows.map(([k, v]) => `
          <li><span class="prop-label">${esc(t(`timing.${k}`))}</span>
          <span class="prop-track"><span class="prop-fill" data-pct="${((v.effective / v.rated) * 100).toFixed(1)}"></span></span>
          <span class="prop-value">${esc(nOf(v.effective, v.rated))}</span></li>`).join('')}</ul>
          <p class="muted small">${esc(t('st.timingNote'))}</p>`
      : notEnough(t('st.timingHint'));

    const trig = Object.entries(a.triggers.counts).sort((x, y) => y[1] - x[1]).slice(0, 8)
      .map(([k, n]) => ({ label: t(`opt.triggers.${k}`), n }));

    const w = a.weather;
    const weatherHtml = w.n
      ? `<p>${esc(t('st.weatherBody', { n: w.n, f: Math.round((w.falling / w.n) * 100), s: Math.round((w.sharpFall / w.n) * 100), m: fmt1(w.meanChange) }))}</p>`
      : `<p class="muted small">${esc(t('st.weatherNone'))}</p>`;

    const mohMonths = new Set(a.moh.map((x) => x.ym)).size;
    return `
      ${mohMonths ? `<p class="warning">⚠ ${esc(t('st.mohMonths', { n: mohMonths }))} ${esc(t('st.mohLimits'))}</p>` : ''}
      ${tiles}
      ${card(t('st.trendTitle'), monthsChart(a, { withMeds: true }))}
      <div class="stat-grid">
        ${card(t('st.weekdayTitle'), weekdayChart(a))}
        ${card(t('st.hourTitle'), hourChart(a.hours, a.timed, a.attacks, t('st.hourTitle')))}
      </div>
      <div class="stat-grid">
        ${card(t('st.medEffectTitle'), medsTable(a))}
        ${card(t('st.timingTitle'), timingHtml)}
      </div>
      <div class="stat-grid">
        ${card(t('st.triggersTitle'), trig.length ? proportionList(trig, a.attacks, nOf) : notEnough(t('st.triggersHint')))}
        ${card(t('st.weatherTitle'), weatherHtml)}
      </div>
      ${card(t('ai.title'), `<p class="muted small">${esc(t('ai.desc'))}</p><button type="button" class="btn" data-ai>${esc(t('ai.start'))}</button>`, 'ai-card')}`;
  }

  // 藥物類別說明：只列出表格中出現的類別，並標出使用者在這段期間用過哪些藥
  function catLegend(cats, meds) {
    if (!cats.length) return '';
    const items = cats.map((c) => {
      const used = meds.filter((m) => (MED_BY_CODE[m.code]?.category ?? 'simple') === c).map((m) => medLabel(t, m));
      return `
        <li>
          <strong>${esc(t(`cat.${c}`))}</strong>
          <span class="muted">（${esc(t('st.catLimit', { n: MOH_THRESHOLDS[c] ?? 10 }))}）</span>
          ${esc(t(`catDesc.${c}`))}
          ${used.length ? `<div class="cat-used">${esc(t('st.catUsed', { list: used.join(t('list.separator')) }))}</div>` : ''}
        </li>`;
    }).join('');
    return `<ul class="cat-legend small">${items}</ul>`;
  }

  // ---------- 看診摘要 ----------

  function doctorHtml(a, filtersText) {
    const kf = (label, value) => `<div class="kf"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
    const medPerMonth = fmt1(a.perMonth(a.medDays));
    const keyFigures = `
      <dl class="key-figures">
        ${kf(t('st.kfPeriod'), esc(`${dateText(a.from)} – ${dateText(a.to)}（${t('st.days', { n: a.rangeDays })}）`))}
        ${kf(t('st.kfHeadacheDays'), esc(t('st.kfDaysVal', { n: a.headacheDays, m: fmt1(a.perMonth(a.headacheDays)) })))}
        ${kf(t('st.kfAttacks'), esc(String(a.attacks)))}
        ${kf(t('st.kfChronic'), esc(t('st.kfChronicVal', { n: a.chronicMonths })))}
        ${kf(t('st.kfMedDays'), esc(t('st.kfDaysVal', { n: a.medDays, m: medPerMonth })))}
        ${kf(t('st.kfRedose'), a.redose.of ? esc(t('st.kfRedoseVal', { p: pct(a.redose.n, a.redose.of), n: a.redose.n, total: a.redose.of })) : `<span class="muted">${esc(t('st.notRecorded'))}</span>`)}
        ${kf(t('st.kfIntensity'), a.intensity.n ? esc(t('st.kfIntensityVal', { v: fmt1(a.intensity.median), n: a.intensity.n })) : `<span class="muted">${esc(t('st.notRecorded'))}</span>`)}
        ${kf(t('st.kfDuration'), a.duration.n ? esc(t('st.kfDurationVal', { m: durText(a.duration.median), a: durText(a.duration.p25), b: durText(a.duration.p75), n: a.duration.n })) : `<span class="muted">${esc(t('st.notRecorded'))}</span>`)}
      </dl>`;

    // 每月急性用藥天數（依類別），達門檻標 ⚠
    const cats = MED_CATS.filter((c) => a.months.some((m) => m.medDaysByCat[c]));
    // 超過 12 個月時只列有用藥的月份，避免表格過長
    const listMonths = a.months.length > 12 ? a.months.filter((m) => m.medDays > 0) : a.months;
    const medRows = listMonths.map((m) => {
      const cells = cats.map((c) => {
        const n = m.medDaysByCat[c] ?? 0;
        const over = n >= (MOH_THRESHOLDS[c] ?? 10);
        return `<td class="num ${over ? 'over' : ''}">${n || ''}${over ? ' ⚠' : ''}</td>`;
      }).join('');
      return `<tr><th scope="row">${esc(monthLabel(m.ym, true))}${m.partial ? '*' : ''}</th>${cells}<td class="num">${m.medDays || ''}</td></tr>`;
    }).join('');
    const medByClass = cats.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>${esc(t('st.colMonth'))}</th>${cats.map((c) => `<th class="num" title="${esc(t(`catDesc.${c}`))}">${esc(t(`cat.${c}`))}</th>`).join('')}<th class="num">${esc(t('st.colTotal'))}</th></tr></thead>
        <tbody>${medRows}</tbody>
      </table></div>
      ${listMonths.length < a.months.length ? `<p class="muted small">${esc(t('st.onlyMedMonths'))}</p>` : ''}
      ${catLegend(cats, a.meds)}
      <p class="muted small">${esc(t('st.medDaysWhy'))}</p>
      <p class="muted small">${esc(t('st.mohNote'))}</p>
      ${a.moh.length ? `<p class="warning small">⚠ ${esc(t('st.mohMonths', { n: new Set(a.moh.map((x) => x.ym)).size }))}</p>` : ''}` : notEnough();

    // 發作特徵
    const N = a.attacks;
    const feat = [
      { label: t('st.unilateral'), n: a.unilateral },
      { label: t('st.withAura'), n: a.aura.withAny },
      ...OPTIONS.symptoms.map((s) => ({ label: t(`opt.symptoms.${s}`), n: a.symptoms.counts[s] ?? 0 })),
    ];
    const types = Object.entries(a.types).sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ label: t(`opt.type.${k}`), n }));
    const locs = Object.entries(a.locations.counts).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => ({ label: t(`loc.${k}`), n }));
    const quality = OPTIONS.pain_quality.map((q) => ({ label: t(`opt.pain_quality.${q}`), n: a.painQuality.counts[q] ?? 0 })).filter((x) => x.n);
    const auraTypes = Object.entries(a.aura.counts).sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ label: t(`opt.aura.${k}`), n }));

    // 叢集型
    const c = a.cluster;
    const clusterHtml = c ? card(t('st.clusterTitle'), `
      <p>${esc(t('st.clusterSummary', { a: c.attacks, b: c.bouts.length, m: c.maxPerDay }))}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>${esc(t('st.colBout'))}</th><th class="num">${esc(t('st.colBoutDays'))}</th><th class="num">${esc(t('st.colAttackDays'))}</th><th class="num">${esc(t('st.colMaxPerDay'))}</th></tr></thead>
        <tbody>${c.bouts.map((b) => `<tr><th scope="row">${esc(`${dateText(b.from)} – ${dateText(b.to)}`)}</th><td class="num">${b.length}</td><td class="num">${b.attackDays}</td><td class="num">${b.maxPerDay}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small">${esc(t('st.boutNote'))}</p>
      <h3>${esc(t('st.clusterHours'))}</h3>
      ${hourChart(c.hours, c.timed, c.attacks, t('st.clusterHours'))}`) : '';

    return `
      <header class="report-head">
        <div>
          <h2>${esc(t('st.reportTitle'))}</h2>
          <p class="muted small">${esc(filtersText)} · ${esc(t('st.generated', { d: dateText(new Date().toISOString().slice(0, 10)) }))}</p>
        </div>
        <button type="button" class="btn ghost small no-print" data-print>${esc(t('st.print'))}</button>
      </header>
      ${card(t('st.keyFigures'), keyFigures)}
      ${card(t('st.monthlyDaysTitle'), monthsChart(a, { withMeds: false, ref: { value: 15, label: t('st.ref15') } }))}
      ${card(t('st.medByClassTitle'), medByClass)}
      <div class="stat-grid">
        ${card(t('st.featuresTitle'), N ? proportionList(feat, N, nOf)
          + (quality.length ? `<h3>${esc(t('st.painQualityTitle'))}</h3>${proportionList(quality, N, nOf)}` : '')
          + `<p class="muted small">${esc(t('st.featuresNote', { n: N }))}</p>` : notEnough())}
        ${card(t('st.typesTitle'), proportionList(types, N, nOf) + (auraTypes.length ? `<h3>${esc(t('form.aura'))}</h3>${proportionList(auraTypes, N, nOf)}` : '') + (locs.length ? `<h3>${esc(t('form.locations'))}</h3>${proportionList(locs, N, nOf)}` : ''))}
      </div>
      ${clusterHtml}
      ${card(t('st.treatmentTitle'), medsTable(a))}
      <p class="muted small report-foot">${esc(t('st.reportFooter'))}</p>`;
  }

  // ---------- 主要繪製 ----------

  function render() {
    chartSpecs = [];
    const all = getRecords();
    const range = resolveRange(state, all);
    const records = filterRecords(all, state);
    const a = analyze(records, range);
    const prevRange = state.range === 'all' ? null : previousRange(range);
    const prev = prevRange ? analyze(records, prevRange) : null;
    const hasPrev = prev && prev.attacks > 0;

    const typeText = state.types.length ? state.types.map((x) => t(`opt.type.${x}`)).join(t('list.separator')) : t('st.allTypes');
    const medText = ['all', 'with', 'without'].includes(state.meds) ? t(`st.meds_${state.meds}`) : t(`med.${state.meds}`);
    const filtersText = `${dateText(range.from)} – ${dateText(range.to)} · ${typeText} · ${medText}`;

    const body = !a.attacks
      ? `<p class="muted empty-state">${esc(t('st.noData'))}</p>`
      : state.tab === 'doctor' ? doctorHtml(a, filtersText) : selfHtml(a, hasPrev ? prev : null);

    root.innerHTML = `${filtersHtml(all, range)}<div class="stats-body" data-tab="${state.tab}">${body}</div>`;
    drawCharts();
    applyProportions(root);
  }

  function drawCharts() {
    root.querySelectorAll('.chart-slot').forEach((slot) => {
      const spec = chartSpecs[Number(slot.dataset.chart)];
      if (spec && slot.clientWidth) slot.innerHTML = columnChart({ ...spec, width: slot.clientWidth });
    });
  }

  // ---------- 事件 ----------

  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-ai]')) return onAiAnalysis?.();
    const el = e.target.closest('[data-range],[data-type],[data-tab],[data-print]');
    if (!el) return;
    if (el.dataset.print !== undefined) return window.print();
    if (el.dataset.range) state.range = el.dataset.range;
    if (el.dataset.tab) state.tab = el.dataset.tab;
    if (el.dataset.type !== undefined) {
      const v = el.dataset.type;
      if (!v) state.types = [];
      else state.types = state.types.includes(v) ? state.types.filter((x) => x !== v) : [...state.types, v];
    }
    save();
    render();
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-meds]')) state.meds = e.target.value;
    if (e.target.matches('[data-custom]')) state[e.target.dataset.custom] = e.target.value;
    save();
    render();
  });
  attachTooltips(root);

  // 圖表寬度跟著容器
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (root.offsetParent) drawCharts(); }, 150);
  });

  return { render };
}
