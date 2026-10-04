// 檢查各語系檔與 en.js 的 key 是否一致、變數 {name} 是否對得上。
// 用法：node tools/check-locales.mjs

import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'locales');
const load = async (file) => (await import(pathToFileURL(path.join(dir, file)).href)).default;
const vars = (msg) => new Set(
  (typeof msg === 'object' ? Object.values(msg).join(' ') : msg).match(/\{\w+\}/g) ?? [],
);

const base = await load('en.js');
let problems = 0;

for (const file of (await readdir(dir)).filter((f) => f.endsWith('.js') && f !== 'en.js')) {
  const loc = await load(file);
  const missing = Object.keys(base).filter((k) => !(k in loc));
  const extra = Object.keys(loc).filter((k) => !(k in base));
  const badVars = Object.keys(base).filter((k) => k in loc
    && [...vars(base[k])].sort().join() !== [...vars(loc[k])].sort().join());
  for (const [label, keys] of [['missing', missing], ['extra', extra], ['variable mismatch', badVars]]) {
    if (keys.length) {
      problems += keys.length;
      console.log(`${file}: ${label}: ${keys.join(', ')}`);
    }
  }
}

console.log(problems ? `\n${problems} problem(s)` : 'All locales match en.js');
process.exit(problems ? 1 : 0);
