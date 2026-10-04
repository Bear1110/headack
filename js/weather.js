// 天氣：頭痛開始那個小時的氣壓、24 小時氣壓變化、氣溫、濕度。
//
// 資料來源 Open-Meteo（https://open-meteo.com）：免費、免金鑰、全球、可直接從瀏覽器呼叫，
// 授權 CC BY 4.0，需在畫面上標示來源。
// 不用台灣氣象署 API：需要金鑰（純前端無法保密，所有使用者共用額度），且只涵蓋台灣。
//
// 隱私：預設關閉，由使用者開啟；只送出四捨五入到 0.1 度（約 10 公里）的座標，不送任何健康資料，
// 試算表也不存位置。

const PREF_KEY = 'hl.weather';    // 'on' | 'off' | 未設定
const LOC_KEY = 'hl.weatherLoc';  // 最近一次取得的大約位置
const API = 'https://api.open-meteo.com/v1/forecast';

// 只查最近的紀錄：預報 API 的 past_days 可回溯數天，補登昨天的頭痛也查得到
export const WINDOW_MS = 48 * 3600 * 1000;

const round = (x, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;

export function getPref() {
  try { return localStorage.getItem(PREF_KEY); } catch { return null; }
}

export function setPref(value) {
  try { localStorage.setItem(PREF_KEY, value); } catch { /* ignore */ }
}

function cachedLocation() {
  try { return JSON.parse(localStorage.getItem(LOC_KEY) || 'null'); } catch { return null; }
}

// 第一次呼叫會跳出瀏覽器的位置權限詢問，請在點擊事件中呼叫
export function requestLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no_geolocation'));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: round(pos.coords.latitude), lon: round(pos.coords.longitude) };
        try { localStorage.setItem(LOC_KEY, JSON.stringify(loc)); } catch { /* ignore */ }
        resolve(loc);
      },
      reject,
      { enableHighAccuracy: false, maximumAge: 3600 * 1000, timeout: 15000 },
    );
  });
}

// 優先用目前位置；取不到時用上次的位置
export async function currentLocation() {
  try {
    return await requestLocation();
  } catch (e) {
    const cached = cachedLocation();
    if (cached) return cached;
    throw e;
  }
}

export function isInWindow(start) {
  const age = Date.now() - new Date(start).getTime();
  return age < WINDOW_MS && age > -3600 * 1000;
}

// start：紀錄的本地時間 "YYYY-MM-DDTHH:mm"。timezone=auto 讓 API 以該地點的當地時間回傳。
// 回傳要合併進紀錄的欄位，查不到時回傳 null。
export async function fetchWeather(start, loc) {
  const params = new URLSearchParams({
    latitude: loc.lat,
    longitude: loc.lon,
    hourly: 'surface_pressure,temperature_2m,relative_humidity_2m',
    past_days: '3',
    forecast_days: '1',
    timezone: 'auto',
  });
  const res = await fetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const { hourly } = await res.json();
  const i = hourly.time.indexOf(`${start.slice(0, 13)}:00`);
  if (i < 0) return null;
  const p = hourly.surface_pressure[i];
  const prev = i >= 24 ? hourly.surface_pressure[i - 24] : null;
  if (p == null) return null;
  return {
    pressure_hpa: round(p),
    pressure_change_24h: prev == null ? null : round(p - prev),
    temp_c: hourly.temperature_2m[i] == null ? null : round(hourly.temperature_2m[i]),
    humidity_pct: hourly.relative_humidity_2m[i] == null ? null : Math.round(hourly.relative_humidity_2m[i]),
  };
}
