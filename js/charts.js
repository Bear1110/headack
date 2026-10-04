// 輕量圖表（inline SVG），不載入外部套件。
//
// 規格（依資料視覺化指引）：
// - 長條最寬 24px，資料端 4px 圓角、基線端方角；相鄰長條間留 2px 以上空隙
// - 格線、軸線為 1px 實線，顏色低調；參考線同樣是 1px 實線並直接標註
// - 兩個以上系列一定有圖例；單一系列不放圖例（標題已說明）
// - 每根長條都可 hover / 鍵盤聚焦，顯示數值提示；並附「表格」檢視，數值不必靠 hover 才看得到
// - 文字一律用文字色，不用資料色

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 漂亮的刻度：0 開始，最多約 4 格
function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

// 長條上方圓角、下方方角的路徑
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * 直條圖（單一或多系列並排）
 * @param {object} o
 * @param {string[]} o.labels       X 軸類別
 * @param {{name:string, values:number[], cls:string}[]} o.series  cls 為 CSS 類別（決定顏色）
 * @param {number} o.width
 * @param {number} [o.height]
 * @param {{value:number, label:string}} [o.ref]  參考線
 * @param {(i:number)=>boolean} [o.showLabel]     哪些 X 軸標籤要顯示（太密時跳著顯示）
 * @param {(i:number)=>string} [o.axisLabel]      X 軸上實際顯示的文字（預設同 labels；長期間可只顯示年份）
 * @param {(v:number)=>string} [o.fmt]
 * @param {string} o.title          給無障礙用的圖表說明
 */
export function columnChart({ labels, series, width, height = 200, ref, showLabel, axisLabel, fmt = String, title }) {
  const pad = { top: 16, right: 8, bottom: 26, left: 30 };
  const W = Math.max(240, width);
  const H = height;
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = Math.max(1, ref?.value ?? 0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const y = (v) => pad.top + plotH - (v / top) * plotH;

  const n = labels.length;
  const band = plotW / n;
  const groupGap = Math.max(2, band * 0.25);
  const barW = Math.min(24, Math.max(2, (band - groupGap) / series.length - 2));
  const groupW = barW * series.length + 2 * (series.length - 1);
  const every = showLabel ?? ((i) => n <= 12 || i % Math.ceil(n / 12) === 0);

  const grid = ticks.map((tv) => `
    <line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${y(tv)}" y2="${y(tv)}"/>
    <text class="tick" x="${pad.left - 6}" y="${y(tv) + 4}" text-anchor="end">${esc(fmt(tv))}</text>`).join('');

  const bars = labels.map((label, i) => {
    const x0 = pad.left + band * i + (band - groupW) / 2;
    return series.map((s, k) => {
      const v = s.values[i] ?? 0;
      const x = x0 + k * (barW + 2);
      const tip = series.length > 1 ? `${label}｜${s.name}: ${fmt(v)}` : `${label}: ${fmt(v)}`;
      // 熱區比長條大：整個類別寬度、整個繪圖高度
      return `
        <g class="bar ${s.cls}" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
          <rect class="hit" x="${pad.left + band * i + (band / series.length) * k}" y="${pad.top}" width="${band / series.length}" height="${plotH}"/>
          <path d="${barPath(x, y(v), barW, pad.top + plotH - y(v))}"/>
        </g>`;
    }).join('');
  }).join('');

  const xLabels = labels.map((label, i) => (every(i) ? `
    <text class="tick" x="${pad.left + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${esc(axisLabel ? axisLabel(i) : label)}</text>` : '')).join('');

  const refLine = ref ? `
    <line class="ref" x1="${pad.left}" x2="${W - pad.right}" y1="${y(ref.value)}" y2="${y(ref.value)}"/>
    <text class="ref-label" x="${W - pad.right}" y="${y(ref.value) - 4}" text-anchor="end">${esc(ref.label)}</text>` : '';

  const legend = series.length > 1 ? `
    <div class="legend">${series.map((s) => `<span><i class="key ${s.cls}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';

  return `
    ${legend}
    <svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
      ${grid}
      <line class="axis" x1="${pad.left}" x2="${W - pad.right}" y1="${pad.top + plotH}" y2="${pad.top + plotH}"/>
      ${bars}
      ${refLine}
      ${xLabels}
    </svg>`;
}

/**
 * 表格檢視（收在 <details> 裡）
 * @param {string} summary
 * @param {string[]} head
 * @param {(string|number)[][]} rows
 */
export function tableView(summary, head, rows) {
  return `
    <details class="table-view">
      <summary>${esc(summary)}</summary>
      <div class="table-wrap"><table>
        <thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td class="num">${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </details>`;
}

/**
 * 比例清單（橫條）：「噁心 45%（9/20）」
 * @param {{label:string, n:number}[]} items
 * @param {number} total  分母
 * @param {(n:number,total:number)=>string} fmt
 */
export function proportionList(items, total, fmt) {
  if (!items.length) return '';
  return `<ul class="prop-list">${items.map(({ label, n }) => {
    const pct = total ? (n / total) * 100 : 0;
    return `
      <li>
        <span class="prop-label">${esc(label)}</span>
        <span class="prop-track"><span class="prop-fill" data-pct="${pct.toFixed(1)}"></span></span>
        <span class="prop-value">${esc(fmt(n, total))}</span>
      </li>`;
  }).join('')}</ul>`;
}

// 比例橫條的寬度：CSP 不允許 HTML 內的 style 屬性，改由 JS 設定（CSSOM 不受限制）
export function applyProportions(root) {
  root.querySelectorAll('.prop-fill[data-pct]').forEach((el) => { el.style.width = `${el.dataset.pct}%`; });
}

// ---------- 提示框（全頁共用一個） ----------

let tooltip;
function ensureTooltip() {
  if (tooltip) return tooltip;
  tooltip = document.createElement('div');
  tooltip.className = 'chart-tip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);
  return tooltip;
}

function show(target, x, y) {
  const tip = ensureTooltip();
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  target.classList.add('active');
}

function hide(target) {
  if (tooltip) tooltip.hidden = true;
  target?.classList.remove('active');
}

// 在容器上掛一次即可：滑鼠、觸控、鍵盤聚焦都會顯示提示
export function attachTooltips(root) {
  let current = null;
  root.addEventListener('pointermove', (e) => {
    const bar = e.target.closest('[data-tip]');
    if (bar !== current) hide(current);
    current = bar;
    if (bar) show(bar, e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', () => { hide(current); current = null; });
  root.addEventListener('focusin', (e) => {
    const bar = e.target.closest('[data-tip]');
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    show(bar, r.left + r.width / 2, r.top);
    current = bar;
  });
  root.addEventListener('focusout', () => { hide(current); current = null; });
  window.addEventListener('scroll', () => hide(current), { passive: true });
}
