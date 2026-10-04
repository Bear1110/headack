// 檢查多國語系：
// 1. 各語系檔與 en.js 的 key 是否一致、變數 {name} 是否對得上
// 2. index.html 的 data-i18n / data-i18n-attr，以及 JS 中 t('固定字串') 用到的 key 都存在於 en.js
// 用法：node tools/check-locales.mjs

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'js', 'locales');
const load = async (file) => (await import(pathToFileURL(path.join(dir, file)).href)).default;
const vars = (msg) => new Set(
  (typeof msg === 'object' ? Object.values(msg).join(' ') : msg).match(/\{\w+\}/g) ?? [],
);

const base = await load('en.js');
let problems = 0;
const report = (label, keys) => {
  if (!keys.length) return;
  problems += keys.length;
  console.log(`${label}: ${keys.join(', ')}`);
};

for (const file of (await readdir(dir)).filter((f) => f.endsWith('.js') && f !== 'en.js')) {
  const loc = await load(file);
  report(`${file}: missing`, Object.keys(base).filter((k) => !(k in loc)));
  report(`${file}: extra`, Object.keys(loc).filter((k) => !(k in base)));
  report(`${file}: variable mismatch`, Object.keys(base).filter((k) => k in loc
    && [...vars(base[k])].sort().join() !== [...vars(loc[k])].sort().join()));
}

// 實際用到的 key（動態組出的 key，例如 t(`opt.type.${c}`)，無法靜態檢查，略過）
const used = new Set();
const html = await readFile(path.join(root, 'index.html'), 'utf8');
for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(key);
for (const [, pairs] of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
  for (const pair of pairs.split(',')) used.add(pair.split(':')[1]);
}
const jsDir = path.join(root, 'js');
for (const file of (await readdir(jsDir)).filter((f) => f.endsWith('.js'))) {
  const src = await readFile(path.join(jsDir, file), 'utf8');
  for (const [, key] of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(key);
}
report('used but missing in en.js', [...used].filter((k) => !(k in base)).sort());

console.log(problems ? `\n${problems} problem(s)` : `All locales match en.js; all ${used.size} statically used keys exist`);
process.exit(problems ? 1 : 0);
