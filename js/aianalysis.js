// AI 分析：把最近的紀錄整理成精簡文字 + 預設問題，交給使用者自己選的 AI（ChatGPT、Claude…）。
// 本網站不傳送任何資料：是使用者的瀏覽器開新分頁、把文字帶過去（或複製後自己貼上）。
// 紀錄用精簡代碼格式（AI 讀得懂、網址較短），備註保留原文；回覆語言依介面語言指定。

export const AI_PRESETS = ['overview', 'meds', 'doctor'];
export const AI_COUNTS = [30, 60, 90];

const LANG_NAMES = { en: 'English', 'zh-TW': 'Traditional Chinese (Taiwan)', 'zh-CN': 'Simplified Chinese', ja: 'Japanese' };

const TASKS = {
  overview: 'Summarize how often and how badly I get headaches, how this changes over time, and which patterns or possible triggers (time of day, weekday, triggers, weather) stand out.',
  meds: 'Review my medication use: on how many days per month I take each medication class, whether I am near the medication-overuse thresholds, and which medications and timings seem to work better.',
  doctor: 'Prepare a short summary I can show my doctor, followed by a list of questions I should ask at my next appointment.',
};

// 網址參數太長時可能被截斷：超過就改成「複製後自己貼上」
const MAX_URL_QUERY = 7000;

// 精簡格式：每筆一行、用內部代碼（AI 看得懂，也讓網址短很多）
function entryLine(r, includeNotes) {
  const sameDay = r.end && r.end.slice(0, 10) === r.start.slice(0, 10);
  const parts = [`${r.start.replace('T', ' ')}${r.end ? `-${sameDay ? r.end.slice(11) : r.end.replace('T', ' ')}` : ''}`];
  const add = (key, value) => { if (value !== '' && value != null) parts.push(`${key}=${value}`); };
  add('pain', Number.isFinite(r.intensity) ? r.intensity : '');
  add('type', r.type);
  add('loc', r.locations?.join(','));
  add('feel', r.pain_quality?.join(','));
  add('aura', r.aura?.join(','));
  add('sym', r.symptoms?.join(','));
  add('meds', r.meds?.map((m) => [
    m.code === 'other_med' && m.name ? m.name.replace(/[,;=|]/g, ' ') : m.code,
    Number.isFinite(m.amount) ? `x${m.amount}` : '',
    m.timing,
  ].filter(Boolean).join(' ')).join(','));
  add('effect', r.med_effect);
  add('trig', r.triggers?.join(','));
  add('dP', Number.isFinite(r.pressure_change_24h) ? r.pressure_change_24h : '');
  if (includeNotes && r.notes) add('notes', String(r.notes).replace(/\s+/g, ' ').trim());
  return parts.join(' | ');
}

// 回傳 { prompt, count }；records 會取開始時間最新的 count 筆，依時間由舊到新排列
export function buildAnalysisPrompt(records, { count, preset, lang, includeNotes }) {
  const recent = records
    .filter((r) => r.start)
    .sort((a, b) => b.start.localeCompare(a.start))
    .slice(0, count)
    .reverse();
  if (!recent.length) return { prompt: '', count: 0 };
  const from = recent[0].start.slice(0, 10);
  const to = recent[recent.length - 1].start.slice(0, 10);
  const prompt = `I keep a headache diary. Below are my ${recent.length} most recent entries (oldest first), from ${from} to ${to}.

Task: ${TASKS[preset] ?? TASKS.overview}

Please:
- Base everything on these entries. Cite dates or counts as evidence, and say when there is too little data to tell.
- Medication-overuse reference (ICHD-3): simple analgesics on 15 or more days per month, or triptans, ergots, opioids or combination analgesics on 10 or more days per month. Count days, not tablets; tablets of different drugs are not comparable.
- Do not diagnose. Point out what is worth discussing with a doctor. If anything suggests a red flag (sudden "worst ever" headache, new one-sided weakness, trouble speaking, fever with a stiff neck, headache after a head injury), tell me to seek medical care promptly.
- Reply in ${LANG_NAMES[lang] ?? 'English'}. Keep it concise, with short headings.

Entries:
${recent.map((r) => entryLine(r, includeNotes)).join('\n')}
`;
  return { prompt, count: recent.length };
}

// 開啟 AI 的網址：放得下就帶入提示詞，否則只開首頁（由呼叫端先複製到剪貼簿）
export function aiLinks(prompt) {
  const q = encodeURIComponent(prompt);
  const fits = q.length <= MAX_URL_QUERY;
  return {
    fits,
    chatgpt: fits ? `https://chatgpt.com/?q=${q}` : 'https://chatgpt.com/',
    claude: fits ? `https://claude.ai/new?q=${q}` : 'https://claude.ai/new',
  };
}
