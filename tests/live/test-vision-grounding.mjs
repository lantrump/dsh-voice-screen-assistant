// 视觉定位实测（需要 key，会产生 API 费用，所以默认不跑）。
//
// 它验证整个项目最关键的技术前提：让视觉模型给出元素坐标时，
//   * 用"归一化坐标 0-1000"问 —— 能不能用？
//   * 用"图片像素坐标"问 —— 是不是明显更差？
// 后者是很多现成 agent 的做法，实测在这套模型上会崩。
//
// 用法：$env:DEEPSEEK_API_KEY="sk-..."; node tests/live/test-vision-grounding.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from '../lib/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '..', 'fixtures');
const key = process.env.DEEPSEEK_API_KEY;
const c = createChecker();

if (!key) {
  console.log('跳过：没有设置环境变量 DEEPSEEK_API_KEY');
  process.exit(0);
}

const spec = JSON.parse(fs.readFileSync(path.join(FIX, 'target.truth.json'), 'utf8'));
const png = fs.readFileSync(path.join(FIX, spec.image));
const REPEAT = 2;

async function upload() {
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('file', new Blob([png], { type: 'image/png' }), spec.image);
  const r = await fetch('https://api.deepseek.com/files', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form,
  });
  const j = JSON.parse(await r.text());
  if (!j.id) throw new Error('上传失败：' + JSON.stringify(j).slice(0, 200));
  return j.id;
}

async function ask(fileId, text) {
  const body = {
    model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 150,
    messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'file', file_id: fileId }] }],
  };
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) return null;
  const n = (JSON.parse(t).choices?.[0]?.message?.content || '').match(/-?\d+(\.\d+)?/g);
  return n && n.length >= 2 ? [parseFloat(n[0]), parseFloat(n[1])] : null;
}

const NORM = '用归一化坐标表示它的位置：x 和 y 均在 0 到 1000 之间，0 表示图片最左/最上，1000 表示最右/最下。只输出 JSON {"x": 数字, "y": 数字}，不要其他文字。';
const PIXEL = '以图片左上角为原点、单位为像素，只输出 JSON {"x": 数字, "y": 数字}，不要其他文字。';

async function measure(fileId, promptSuffix, toPixel) {
  const rows = [];
  for (const el of spec.elements) {
    const errs = [], hits = [];
    for (let i = 0; i < REPEAT; i++) {
      const n = await ask(fileId, `请找到${el.ask}。` + promptSuffix);
      if (!n) { errs.push(null); hits.push(false); continue; }
      const [px, py] = toPixel(n);
      const dx = px - el.truth[0], dy = py - el.truth[1];
      errs.push(Math.round(Math.hypot(dx, dy) * 10) / 10);
      hits.push(Math.abs(dx) <= el.hw && Math.abs(dy) <= el.hh);
    }
    rows.push({ key: el.key, errs, hits: hits.filter(Boolean).length, repeat: REPEAT });
  }
  return rows;
}

const fileId = await upload();
console.log('靶图: ' + spec.image + ` (${spec.width}x${spec.height})\n`);

const normRows = await measure(fileId, NORM, (n) => [n[0] / 1000 * spec.width, n[1] / 1000 * spec.height]);
const pxRows = await measure(fileId, PIXEL, (n) => [n[0], n[1]]);

const mean = (rows) => {
  const all = rows.flatMap(r => r.errs).filter(v => v !== null);
  return all.length ? Math.round(all.reduce((a, b) => a + b, 0) / all.length * 10) / 10 : null;
};
const hitRate = (rows) => {
  const h = rows.reduce((a, r) => a + r.hits, 0), t = rows.length * REPEAT;
  return `${h}/${t}`;
};

console.log('元素'.padEnd(14) + '真值'.padEnd(14) + '归一化误差'.padEnd(16) + '像素误差');
for (let i = 0; i < spec.elements.length; i++) {
  console.log(
    normRows[i].key.padEnd(14) +
    `(${spec.elements[i].truth})`.padEnd(14) +
    JSON.stringify(normRows[i].errs).padEnd(16) +
    JSON.stringify(pxRows[i].errs)
  );
}
console.log(`\n平均误差   归一化 = ${mean(normRows)} px   像素坐标 = ${mean(pxRows)} px`);
console.log(`点中率     归一化 = ${hitRate(normRows)}      像素坐标 = ${hitRate(pxRows)}`);

c.section('结论');
c.ok('归一化坐标能定位（平均误差 < 40px）', mean(normRows) !== null && mean(normRows) < 40, `实测 ${mean(normRows)} px`);
c.ok('每个元素都返回了可用于归一化的数字', normRows.every(r => r.errs.every(e => e !== null)));

c.done();
