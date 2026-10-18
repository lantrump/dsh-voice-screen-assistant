// 实测：点之前"用放大裁图再瞄一次"到底值不值？（需要 key，花钱，默认不跑）
//
// 背景：整屏定位对小目标不够准。2026-10-18 实测（n=15，3 个 11px 单选圆点）：
//   A  整屏 JPEG（产品口径，main.js toJPEG(88)）      平均 21.1px，点中 0/15
//   B  只给最大化窗口裁图（去掉 32px 标题栏）          平均  8.9px，点中 12/15
//   C  A 的答案当粗定位 → 320x200 放大 3 倍 → 裁图内重定位  平均 2.6px，点中 15/15
// 结论：整屏坐标有系统性偏上（平均 -21px），裁掉顶部非内容区会明显变好；
//       而"裁图单独成一次请求、坐标只相对裁图"几乎消灭了误差。
//       产品采用 C：renderer.js doAction 的 click 分支先调 refineClickPoint。
//
// 为什么不能把裁图塞进原来的动作请求：见 test-crop-feedback.mjs 的实测——
// 两张图 = 两个坐标空间，模型会串位（10.5px → 36.2px）。这里 C 能成立，恰恰是因为
// 裁图是【唯一】的图，坐标空间只有一个。
//
// 用法：$env:DEEPSEEK_API_KEY="sk-..."; node tests/live/test-click-refine.mjs
// 可选：REPEAT=5 增加每个元素的重复次数。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from '../lib/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const WORK = path.join(HERE, '_work');
const CROPS = path.join(WORK, 'click-refine');
const key = process.env.DEEPSEEK_API_KEY;
const c = createChecker();

if (!key) {
  console.log('跳过：没有设置环境变量 DEEPSEEK_API_KEY');
  process.exit(0);
}

const MODEL = 'deepseek-flash';
const REPEAT = Number(process.env.REPEAT || 3);
const spec = JSON.parse(fs.readFileSync(path.join(FIX, 'target.truth.json'), 'utf8'));
const DOTS = spec.elements.filter(e => e.hw <= 20);

// 模拟最大化窗口：去掉 32px 标题栏，宽度不变。这是最常见的真实情形。
const WIN = { x: 0, y: 32, w: spec.width, h: spec.height - 32 };

const SUFFIX = '\nx/y 用【这张图】的归一化坐标：x 和 y 均在 0 到 1000 之间，0 表示图片的最左/最上，1000 表示最右/最下。只输出 JSON {"x": 数字, "y": 数字}，不要其他文字。';

// 抽 x/y 必须走花括号配对取 JSON，不能取"全文前两个数字"——
// 模型爱写"从图2可以看出…"，第一个数字会变成图2，答案整个串位。
function extractXY(txt) {
  for (let i = 0; i < txt.length; i++) {
    if (txt[i] !== '{') continue;
    let d = 0;
    for (let k = i; k < txt.length; k++) {
      const ch = txt[k];
      if (ch === '{') d++;
      else if (ch === '}') { d--; if (d === 0) {
        try { const o = JSON.parse(txt.slice(i, k + 1));
          if (o.x != null && o.y != null && isFinite(Number(o.x)) && isFinite(Number(o.y)))
            return [Number(o.x), Number(o.y)];
        } catch (e) {}
        break;
      } }
    }
  }
  return null;
}

async function ask(images, text, maxTokens = 150) {
  const content = [{ type: 'text', text }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url } });
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, thinking: { type: 'disabled' }, max_tokens: maxTokens,
      messages: [{ role: 'user', content }] }),
  });
  const t = await r.text();
  if (!r.ok) return { err: 'HTTP ' + r.status + ' ' + t.slice(0, 120) };
  const txt = JSON.parse(t).choices?.[0]?.message?.content || '';
  return { txt: txt.trim(), xy: extractXY(txt) };
}

const toPx = (n, rect) => [rect.x + n[0] / 1000 * rect.w, rect.y + n[1] / 1000 * rect.h];
const errOf = (p, el) => Math.round(Math.hypot(p[0] - el.truth[0], p[1] - el.truth[1]) * 10) / 10;
const hitOf = (p, el) => Math.abs(p[0] - el.truth[0]) <= el.hw && Math.abs(p[1] - el.truth[1]) <= el.hh;
const mean = (a) => { const v = a.filter(x => x != null); return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 : null; };

// ---------- 渲染 1) 整屏 JPEG（产品真实口径） 2) 窗口 JPEG ----------
fs.mkdirSync(CROPS, { recursive: true });
const reqPath = path.join(WORK, 'click-refine-requests.json');
async function render(jobs) {
  fs.writeFileSync(reqPath, JSON.stringify({ image: spec.image, jobs }, null, 2));
  let electron = null;
  try { const m = await import('electron'); electron = m.default; } catch (e) {}
  const spOpts = { encoding: 'utf8' };
  if (typeof electron !== 'string' || !fs.existsSync(electron)) {
    electron = path.resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    if (process.platform === 'win32') spOpts.shell = true;
  }
  // --no-sandbox：受限环境（无交互桌面会话）里 Chromium 沙箱会直接崩（STATUS_BREAKPOINT）。
  // 这个 helper 只解码本地 PNG 再写 JPEG，不碰网络和不受信内容。
  const sp = spawnSync(electron, ['--no-sandbox', path.join(HERE, 'render-crops.cjs'), reqPath, CROPS], spOpts);
  if (sp.status !== 0) { console.error('裁图失败：' + (sp.stdout || '') + (sp.stderr || '') + (sp.error || '')); process.exit(1); }
  return JSON.parse(fs.readFileSync(path.join(CROPS, 'manifest.json'), 'utf8'));
}
const man0 = await render([
  { name: 'full', point: [spec.width / 2, spec.height / 2], w: spec.width, h: spec.height, scale: 1, marked: false },
  { name: 'win', point: [WIN.x + WIN.w / 2, WIN.y + WIN.h / 2], w: WIN.w, h: WIN.h, scale: 1, marked: false },
]);
const cropsOf = (man) => Object.fromEntries(man.jobs.map(j => [j.name, j]));
const urlOf = (file) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(CROPS, file)).toString('base64');
const FULL = urlOf('full.jpg');
const WIN_URL = urlOf('win.jpg');
const fullRect = { x: 0, y: 0, w: spec.width, h: spec.height };

// ---------- 臂 A：整屏 JPEG（基线） ----------
console.log('\n=== A：整屏 JPEG（产品口径，基线） ===');
const trials = [];
for (const el of DOTS) {
  for (let i = 0; i < REPEAT; i++) {
    const r = await ask([FULL], `请找到${el.ask}。` + SUFFIX);
    const px = r.xy ? toPx(r.xy, fullRect) : null;
    const t = { key: el.key, rep: i, truth: el.truth, hw: el.hw, hh: el.hh,
                a: { raw: r.txt, norm: r.xy, px, err: px ? errOf(px, el) : null, hit: px ? hitOf(px, el) : false } };
    if (r.err) t.a.error = r.err;
    trials.push(t);
    console.log(`  ${el.key} #${i}: ${px ? '落点 ' + px.map(Math.round) + ' 误差 ' + t.a.err + 'px' + (t.a.hit ? ' ✓' : ' ✗') : '没解析'}`);
  }
}

// ---------- 臂 B：只给窗口裁图 ----------
console.log('\n=== B：只给窗口裁图（坐标相对裁图） ===');
const winRect = cropsOf(man0).win.rect;
for (const t of trials) {
  const el = DOTS.find(e => e.key === t.key);
  const r = await ask([WIN_URL], `请找到${el.ask}。` + SUFFIX);
  const px = r.xy ? toPx(r.xy, winRect) : null;
  t.b = { raw: r.txt, norm: r.xy, px, err: px ? errOf(px, el) : null, hit: px ? hitOf(px, el) : false };
  console.log(`  ${el.key} #${t.rep}: ${px ? '误差 ' + t.b.err + 'px' + (t.b.hit ? ' ✓' : ' ✗') : '没解析'}`);
}

// ---------- 臂 C：以 A 的答案为圆心，裁图内重定位 ----------
const refJobs = trials.map((t, i) => t.a.px
  ? { name: 'ref-' + i, point: [Math.round(t.a.px[0]), Math.round(t.a.px[1])], w: 320, h: 200, scale: 3, marked: false }
  : null).filter(Boolean);
const man1 = await render(refJobs);
const jobsOf = cropsOf(man1);
console.log('\n=== C：粗定位 + 320x200×3 裁图内重定位 ===');
for (let i = 0; i < trials.length; i++) {
  const t = trials[i];
  const el = DOTS.find(e => e.key === t.key);
  const job = jobsOf['ref-' + i];
  if (!t.a.px || !job) {
    t.c = { skip: '无粗定位', px: t.a.px, err: t.a.err, hit: t.a.hit, fallback: true };
    continue;
  }
  // 提示词和 renderer.js refineClickPoint 保持一致，测的才是产品真正发出去那句话。
  const r = await ask([urlOf(job.file)],
    '这是屏幕某一小块区域的放大图（放大 3 倍）。\n' +
    `请找到「${el.ask}」，给出它可点击部分的中心（圆形单选/复选框取圆心）。如果图里根本没有这个目标，x 和 y 都给 null。\n` +
    SUFFIX);
  const px = r.xy ? toPx(r.xy, job.rect) : null;
  t.c = px
    ? { raw: r.txt, norm: r.xy, px, err: errOf(px, el), hit: hitOf(px, el), inside: true }
    : { raw: r.txt, px: t.a.px, err: t.a.err, hit: t.a.hit, fallback: true };
  console.log(`  ${el.key} #${t.rep}: ${px ? '误差 ' + t.c.err + 'px' + (t.c.hit ? ' ✓' : ' ✗') : '回退粗定位'}`);
}

// ---------- 汇总 ----------
const n = trials.length;
const arm = (a) => ({
  mean: mean(trials.map(t => t[a] && t[a].err)),
  hits: trials.filter(t => t[a] && t[a].hit).length,
});
const A = arm('a'), B = arm('b'), C = arm('c');

console.log(`\n========== 汇总（n=${n}，3 个 11px 圆点 × ${REPEAT}）==========`);
console.log(`A 整屏 JPEG        ${String(A.mean).padStart(6)}px   点中 ${A.hits}/${n}   ← 产品基线`);
console.log(`B 窗口裁图         ${String(B.mean).padStart(6)}px   点中 ${B.hits}/${n}   ← dsh-orb 的窗口观察`);
console.log(`C 裁图内重定位     ${String(C.mean).padStart(6)}px   点中 ${C.hits}/${n}   ← 产品现在采用`);
console.log('参考（2026-10-18，n=15）：A 21.1px 0/15 ｜ B 8.9px 12/15 ｜ C 2.6px 15/15');

fs.writeFileSync(path.join(WORK, 'click-refine.results.json'), JSON.stringify(
  { at: new Date().toISOString(), model: MODEL, repeat: REPEAT, winRect,
    summary: { A, B, C, n }, trials }, null, 2));
console.log('\n明细 → tests/live/_work/click-refine.results.json');

c.section('实测结论');
c.ok('裁图内重定位比整屏定位更准（平均误差更低）', C.mean != null && A.mean != null && C.mean < A.mean,
  `A=${A.mean}px C=${C.mean}px`);
c.ok('裁图内重定位把 11px 小目标基本都点中', C.hits >= Math.ceil(n * 0.8), `${C.hits}/${n}`);
console.log('（参考，不作判定）B=' + B.mean + 'px ' + B.hits + '/' + n +
  ' —— 窗口观察的收益主要是少看无关窗口；它不额外花调用，但需要换截屏链路。');
c.done();
