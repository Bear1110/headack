// 部署前必填：Google Cloud Console → API 和服務 → 憑證 → OAuth 2.0 用戶端 ID（網頁應用程式）
// 用戶端 ID 本來就會公開在前端，放在這裡沒有安全問題；真正的保護是「已授權的 JavaScript 來源」設定。
export const CLIENT_ID = '576618087940-fe39h5hmt7dpipukp2sjpkf30r27q89h.apps.googleusercontent.com';

// drive.file：只能存取本網站建立或使用者親自選取的檔案（非敏感權限）
// openid email：顯示目前登入的帳號（多帳號使用者需要知道資料存在哪個帳號），並用於續期時的 login_hint
export const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email';

// 標記在試算表的 Drive appProperties 上，用來找回網站建立的那份檔案
export const APP_PROPERTY = { key: 'headacheLog', value: '1' };
