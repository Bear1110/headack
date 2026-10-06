// Google Identity Services（token model），純前端、沒有 refresh token。
//
// 重要限制：requestToken() 會開彈窗，必須在使用者點擊事件中「同步」呼叫
// （呼叫前不能有任何 await），否則會被瀏覽器的彈窗攔截擋掉。

import { CLIENT_ID, SCOPES } from './config.js';
import { isDemo } from './store.js';

const TOKEN_KEY = 'hl.token';
const EMAIL_KEY = 'hl.email';
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

let tokenClient = null;
let token = null;
let expiresAt = 0;
let pending = null; // { resolve, reject }

// 權杖存 localStorage（最多 1 小時），讓重新整理或從主畫面開啟時不必再按登入。
// 搭配 CSP 不載入第三方腳本以降低 XSS 風險。
function loadStored() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.expiresAt > Date.now() + EXPIRY_MARGIN_MS) {
      token = saved.token;
      expiresAt = saved.expiresAt;
    }
  } catch { /* 無痕模式等情況可能無法使用 storage */ }
}

function store() {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  } catch { /* ignore */ }
}

function waitForGis(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const script = document.getElementById('gis');
    const timer = setTimeout(() => reject(new Error('gis_load_timeout')), timeoutMs);
    script?.addEventListener('load', () => { clearTimeout(timer); resolve(); });
    script?.addEventListener('error', () => { clearTimeout(timer); reject(new Error('gis_load_failed')); });
  });
}

export async function initAuth() {
  loadStored();
  await waitForGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      const p = pending;
      pending = null;
      if (resp.error) return p?.reject(new Error(resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/drive.file')) {
        return p?.reject(new Error('scope_not_granted'));
      }
      token = resp.access_token;
      expiresAt = Date.now() + Number(resp.expires_in) * 1000;
      store();
      p?.resolve(token);
    },
    error_callback: (err) => {
      // 例如使用者關掉彈窗（popup_closed）或彈窗被擋（popup_failed_to_open）
      const p = pending;
      pending = null;
      p?.reject(new Error(err.type || 'auth_error'));
    },
  });
}

export function isAuthReady() {
  return tokenClient !== null;
}

// 示範模式（store.isDemo）從這裡就沒有帳號與權杖：呼叫端不必各自判斷，示範資料也不可能被同步或清到真實試算表
export function hasValidToken() {
  return !isDemo() && !!token && Date.now() < expiresAt - EXPIRY_MARGIN_MS;
}

export function getToken() {
  return hasValidToken() ? token : null;
}

export function getEmail() {
  if (isDemo()) return null;
  try { return localStorage.getItem(EMAIL_KEY); } catch { return null; }
}

export function setEmail(email) {
  try { localStorage.setItem(EMAIL_KEY, email); } catch { /* ignore */ }
}

// 必須在點擊事件中同步呼叫。
// 首次讓使用者選帳號（多帳號的人很常見），需要時 Google 會自動顯示同意畫面；
// 之後帶 prompt: '' 與 login_hint，彈窗通常一閃即關。
export function requestToken({ firstTime = false } = {}) {
  if (isDemo()) return Promise.reject(new Error('demo_mode'));
  if (!tokenClient) return Promise.reject(new Error('auth_not_ready'));
  if (pending) pending.reject(new Error('superseded'));
  const promise = new Promise((resolve, reject) => { pending = { resolve, reject }; });
  const hint = getEmail();
  tokenClient.requestAccessToken({
    prompt: firstTime ? 'select_account' : '',
    ...(hint ? { login_hint: hint } : {}),
  });
  return promise;
}

export function invalidateToken() {
  token = null;
  expiresAt = 0;
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

// 只清除本機狀態，不呼叫 revoke：撤銷授權會影響 drive.file 對既有試算表的存取，
// 需要時使用者可在 Google 帳戶的「第三方應用程式」頁面自行撤銷。（待討論）
export function signOut() {
  invalidateToken();
  try { localStorage.removeItem(EMAIL_KEY); } catch { /* ignore */ }
}
