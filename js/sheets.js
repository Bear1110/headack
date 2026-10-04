// Google Sheets / Drive REST 呼叫。直接用 fetch，不載入 gapi，減少第三方腳本。

import { APP_PROPERTY } from './config.js';
import {
  RECORD_COLUMNS, RECORDS_SHEET_ID, SETTINGS_SHEET_ID, SCHEMA_VERSION,
  recordToRow, rowToRecord,
} from './schema.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(token, url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  return res.status === 204 ? null : res.json();
}

const quoteTitle = (title) => `'${title.replace(/'/g, "''")}'`;

export async function fetchEmail(token) {
  const info = await api(token, 'https://www.googleapis.com/oauth2/v3/userinfo');
  return info.email;
}

// 在使用者雲端硬碟找本網站建立的試算表（drive.file 只看得到本網站建立或使用者選取的檔案）
async function findSpreadsheet(token) {
  const q = `appProperties has { key='${APP_PROPERTY.key}' and value='${APP_PROPERTY.value}' } and trashed = false`;
  const url = `${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`;
  const { files } = await api(token, url);
  return files[0]?.id ?? null;
}

async function createSpreadsheet(token, title) {
  const header = (values) => ({
    rowData: [{ values: values.map((v) => ({ userEnteredValue: { stringValue: v }, userEnteredFormat: { textFormat: { bold: true } } })) }],
  });
  const sheet = await api(token, SHEETS, {
    method: 'POST',
    body: {
      properties: { title },
      sheets: [
        {
          properties: { sheetId: RECORDS_SHEET_ID, title: 'records', gridProperties: { frozenRowCount: 1 } },
          data: [{ startRow: 0, startColumn: 0, ...header(RECORD_COLUMNS) }],
        },
        {
          properties: { sheetId: SETTINGS_SHEET_ID, title: 'settings', gridProperties: { frozenRowCount: 1 } },
          data: [{
            startRow: 0, startColumn: 0,
            rowData: [
              header(['key', 'value']).rowData[0],
              { values: [{ userEnteredValue: { stringValue: 'schema_version' } }, { userEnteredValue: { numberValue: SCHEMA_VERSION } }] },
            ],
          }],
        },
      ],
    },
  });
  await api(token, `${DRIVE}/${sheet.spreadsheetId}`, {
    method: 'PATCH',
    body: { appProperties: { [APP_PROPERTY.key]: APP_PROPERTY.value } },
  });
  return sheet.spreadsheetId;
}

// 依固定 sheetId 找出目前的分頁名稱（使用者可能改過名稱）
async function getSheetTitles(token, spreadsheetId) {
  const meta = await api(token, `${SHEETS}/${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title)`);
  const titles = {};
  for (const s of meta.sheets) titles[s.properties.sheetId] = s.properties.title;
  if (!titles[RECORDS_SHEET_ID]) throw new Error('records_sheet_missing');
  return titles;
}

// 綁定一份試算表後的操作介面
export class Spreadsheet {
  constructor(id, titles) {
    this.id = id;
    this.titles = titles;
    this.headers = null;
  }

  get url() {
    return `https://docs.google.com/spreadsheets/d/${this.id}/edit`;
  }

  get recordsRange() {
    return quoteTitle(this.titles[RECORDS_SHEET_ID]);
  }

  // 讀回整張紀錄表。回傳 { records, rowIndexById }；rowIndex 為 0 起算（0 = 標題列）
  async readAll(token) {
    const data = await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(this.recordsRange)}?valueRenderOption=UNFORMATTED_VALUE`);
    const rows = data.values ?? [];
    this.headers = (rows[0] ?? []).map((h) => String(h).trim());
    await this.#ensureHeaders(token);
    const records = [];
    const rowIndexById = new Map();
    rows.slice(1).forEach((row, i) => {
      const r = rowToRecord(row, this.headers);
      if (!r || rowIndexById.has(r.id)) return;
      records.push(r);
      rowIndexById.set(r.id, i + 1);
    });
    return { records, rowIndexById };
  }

  // 若使用者刪掉了某些欄位標題（或日後 Schema 新增欄位），把缺的欄位補在最右邊
  async #ensureHeaders(token) {
    const missing = RECORD_COLUMNS.filter((c) => !this.headers.includes(c));
    if (!missing.length) return;
    const startCol = this.headers.length;
    this.headers = [...this.headers, ...missing];
    await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(`${this.recordsRange}!${colLetter(startCol)}1`)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: { values: [missing] },
    });
  }

  async #findRow(token, id) {
    const { rowIndexById } = await this.readAll(token);
    return rowIndexById.get(id) ?? null;
  }

  // 一次新增一或多筆
  async append(token, recordOrList) {
    if (!this.headers) await this.readAll(token);
    const list = Array.isArray(recordOrList) ? recordOrList : [recordOrList];
    await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(this.recordsRange)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { values: list.map((r) => recordToRow(r, this.headers)) },
    });
  }

  // 找不到該 ID（例如使用者在試算表裡刪掉了）就改為新增
  async update(token, record) {
    const rowIndex = await this.#findRow(token, record.id);
    if (rowIndex == null) return this.append(token, record);
    const range = `${this.recordsRange}!A${rowIndex + 1}`;
    await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: { values: [recordToRow(record, this.headers)] },
    });
  }

  // 找不到該 ID 視為已刪除
  async remove(token, id) {
    const rowIndex = await this.#findRow(token, id);
    if (rowIndex == null) return;
    await api(token, `${SHEETS}/${this.id}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [{
          deleteDimension: {
            range: { sheetId: RECORDS_SHEET_ID, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
          },
        }],
      },
    });
  }
}

function colLetter(index) {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// 找到（或建立）使用者的試算表。cachedId 來自 localStorage，失效時重新搜尋。
// title 只在新建時使用（依當下介面語言）。
export async function openSpreadsheet(token, { cachedId, title }) {
  if (cachedId) {
    try {
      return new Spreadsheet(cachedId, await getSheetTitles(token, cachedId));
    } catch (e) {
      if (!(e instanceof ApiError) || ![403, 404].includes(e.status)) throw e;
    }
  }
  let id = await findSpreadsheet(token);
  if (!id) id = await createSpreadsheet(token, title);
  return new Spreadsheet(id, await getSheetTitles(token, id));
}
