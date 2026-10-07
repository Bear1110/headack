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

  // 找出紀錄所在的列與雲端版本
  async #locate(token, id) {
    const { records, rowIndexById } = await this.readAll(token);
    const rowIndex = rowIndexById.get(id) ?? null;
    return { rowIndex, remote: rowIndex == null ? null : records.find((r) => r.id === id) };
  }

  // 寫入或刪除前再讀一次該列的 ID：另一台裝置可能剛好增刪了前面的列，造成列號位移
  async #idAt(token, rowIndex) {
    const range = `${this.recordsRange}!${colLetter(this.headers.indexOf('id'))}${rowIndex + 1}`;
    const data = await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`);
    return String(data.values?.[0]?.[0] ?? '');
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

  // 更新一筆。回傳：
  // - 'ok'
  // - 'deleted'：雲端已找不到（在別的裝置或試算表裡被刪除）→ 刪除為準，不重新新增
  // - 'stale'：雲端版本的修改時間比較新 → 以最後編輯為準，不覆蓋
  async update(token, record) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rowIndex, remote } = await this.#locate(token, record.id);
      if (rowIndex == null) return 'deleted';
      if (remote?.updated_at && record.updated_at && String(remote.updated_at) > String(record.updated_at)) return 'stale';
      if (await this.#idAt(token, rowIndex) !== record.id) continue; // 列號位移，重新找
      const range = `${this.recordsRange}!A${rowIndex + 1}`;
      await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: { values: [recordToRow(record, this.headers)] },
      });
      return 'ok';
    }
    throw new Error('row_moved');
  }

  // 只寫入本機改過的欄位（changes），其他欄位保留雲端的值。每個欄位：
  // - 雲端那格還是改之前的值（base）→ 別台沒動過，直接套用
  // - 別台也改了同一格 → 以最後編輯為準（比較整列的 updated_at）
  // 回傳 'ok'、'deleted'（雲端已刪除），或 'stale'（至少一格保留了別台較新的修改）
  async patch(token, id, changes, base) {
    const cell = (field, v) => String(recordToRow({ [field]: v }, [field])[0]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rowIndex, remote } = await this.#locate(token, id);
      if (rowIndex == null) return 'deleted';
      const remoteNewer = String(remote.updated_at ?? '') > String(changes.updated_at ?? '');
      const merged = { ...remote };
      let lost = false;
      for (const [field, v] of Object.entries(changes)) {
        if (field === 'updated_at') continue;
        if (!remoteNewer || cell(field, remote[field]) === cell(field, base[field])) merged[field] = v;
        else lost = true;
      }
      if (!remoteNewer) merged.updated_at = changes.updated_at;
      if (await this.#idAt(token, rowIndex) !== id) continue; // 列號位移，重新找
      const range = `${this.recordsRange}!A${rowIndex + 1}`;
      await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: { values: [recordToRow(merged, this.headers)] },
      });
      return lost ? 'stale' : 'ok';
    }
    throw new Error('row_moved');
  }

  // 清空所有紀錄：只清除標題列以下的內容，保留試算表檔案與標題列。
  // 之後 append 會從第 2 列重新開始寫。
  async clearAll(token) {
    const range = `${this.recordsRange}!A2:ZZ`;
    await api(token, `${SHEETS}/${this.id}/values/${encodeURIComponent(range)}:clear`, { method: 'POST', body: {} });
  }

  // 找不到該 ID 視為已刪除；刪除前同樣確認列號沒有位移
  async remove(token, id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rowIndex } = await this.#locate(token, id);
      if (rowIndex == null) return 'ok';
      if (await this.#idAt(token, rowIndex) !== id) continue; // 列號位移，重新找
      await api(token, `${SHEETS}/${this.id}:batchUpdate`, {
        method: 'POST',
        body: { requests: [{ deleteDimension: { range: { sheetId: RECORDS_SHEET_ID, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 } } }] },
      });
      return 'ok';
    }
    throw new Error('row_moved');
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
