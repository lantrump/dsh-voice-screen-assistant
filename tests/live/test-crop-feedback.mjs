// 实测：那张"落点放大图 + 十字准星"到底有没有用？（需要 key，花钱，默认不跑）
//
// 要回答的是产品里最要命的那个问题：模型第一步没点准之后，它能不能【看见自己偏了】并改正？
// 过去它每步只有一个噪声布尔值（"落点附近变没变"），分不清"点到旁边空白 / 本来就选中了 /
// 输入框只有光标在闪"——这就是"老点错、反复点同一个地方"的病根。
//
// 三个臂对比（都是同一个元素、同一个问题）：
//   A 只看整屏图            —— 基线：它自己猜有多准
//   B 整屏图 + 带准星的裁图  —— 曾经的做法；2026-09-28 实测【更差】，自动附带已撤掉
//   C 整屏图 + 告诉它上次答案 —— 对照组：没有图、只靠文字
//
// 2026-09-28 结论（n=9 单选圆点）：B 反而把本来点对的答案改偏（A 10.5px → B 36.2px，
// 最坏 90px 开外），C 却和 A 打平（10.1px / 5 中 4）。所以产品不再自动附带落点放大图——
// 这张图唯一站得住的本事是【读控件状态】（下面那个探针：18/18 全对），而读状态不该和
// 出坐标混在同一次请求里。哪天真跑出来 B 明显赢 A，就该回头重新考虑自动附带。
//
// 外加一个状态判断探针：裁图能不能让模型读出"这个单选控件选中了没有"。
//
// 用法：$env:DEEPSEEK_API_KEY="sk-..."; node tests/live/test-crop-feedback.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from '../lib/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '..', 'fixtures');
const WORK = path.resolve(HERE, '_work');
const CROPS = path.join(WORK, 'crops');
const key = process.env.DEEPSEEK_API_KEY;
const c = createChecker();

if (!key) {
  console.log('跳过：没有设置环境变量 DEEPSEEK_API_KEY');
  process.exit(0);
}

const MODEL = 'deepseek-flash';
const REPEAT = Number(process.env.REPEAT || 3);
const spec = JSON.parse(fs.readFileSync(path.join(FIX, 'target.truth.json'), 'utf8'));
const png = fs.readFileSync(path.join(FIX, spec.image));
const FULL = 'data:image/png;base64,' + png.toString('base64');
// 只测三个单选圆点：hw=11px，是这张图上最小的目标（约等于屏幕宽的 0.7%），最能看出区别
const DOTS = spec.elements.filter(e => e.hw <= 20);

fs.mkdirSync(CROPS, { recursive: true });

const SUFFIX_FULL = '\nx/y 用【图1】的归一化坐标：x 和 y 均在 0 到 1000 之间，0 表示图1 的最左/最上，1000 表示最右/最下。只输出 JSON {"x": 数字, "y": 数字}，不要其他文字。';

// 抽 x/y 必须走【花括号配对取 JSON】，不能取"全文前两个数字"。
// 踩过：模型爱写"从图2可以看出…"，于是第一个数字变成图2 的 2，答案整个串位，
// 上一轮实测把臂 B 冤枉成 149.9px，其实它答对了。产品的 firstJsonObject(renderer.js:146)
// 就是干这个的，这里照抄同一套逻辑。
function extractXY(txt) {
  for (let i = 0; i < txt.length; i++) {
    if (txt[i] !== '{') continue;
    let d = 0;
    for (let k = i; k < txt.length; k++) {
      const ch = txt[k];
      if (ch === '{') d++;
      else if (ch === '}') { d--; if (d === 0) {
        try { const o = JSON.parse(txt.slice(i, k + 1));
          const x = Number(o.x), y = Number(o.y);
          if (isFinite(x) && isFinite(y)) return [x, y];
        } catch (e) {}
        break;
      } }
    }
  }
  return null;
}

async function ask(images, text, maxTokens = 150) {
  const content = [{ type: 'text', text: text }];
  for (const url of images) content.push({ type: 'image_url', image_url: { url: url } });
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, thinking: { type: 'disabled' }, max_tokens: maxTokens,
      messages: [{ role: 'user', content: content }] }),
  });
  const t = await r.text();
  if (!r.ok) return { err: 'HTTP ' + r.status + ' ' + t.slice(0, 120) };
  const txt = JSON.parse(t).choices?.[0]?.message?.content || '';
  return { txt: txt.trim(), xy: extractXY(txt) };
}

const toPx = (n) => [n[0] / 1000 * spec.width, n[1] / 1000 * spec.height];
const errOf = (p, el) => Math.round(Math.hypot(p[0] - el.truth[0], p[1] - el.truth[1]) * 10) / 10;
const hitOf = (p, el) => Math.abs(p[0] - el.truth[0]) <= el.hw && Math.abs(p[1] - el.truth[1]) <= el.hh;

const mean = (a) => {
  const v = a.filter(x => x != null);
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length * 10) / 10 : null;
};

// ---------------- 第 1 轮：只看整屏图，让它自己猜 ----------------
console.log('=== 第 1 轮：只看整屏图（臂 A / 基线）===');
const trials = [];
for (const el of DOTS) {
  for (let i = 0; i < REPEAT; i++) {
    const r = await ask([FULL], `请找到${el.ask}。` + SUFFIX_FULL);
    const px = r.xy ? toPx(r.xy) : null;
    const t = { key: el.key, rep: i, truth: el.truth, hw: el.hw, hh: el.hh,
                a: { raw: r.txt, norm: r.xy, px: px, err: px ? errOf(px, el) : null, hit: px ? hitOf(px, el) : false } };
    if (r.err) t.a.error = r.err;
    trials.push(t);
    console.log(`  ${el.key} #${i}: ${px ? '落点 ' + px.map(v => Math.round(v)) + ' 误差 ' + t.a.err + 'px' + (t.a.hit ? ' ✓' : ' ✗') : '没解析出来：' + JSON.stringify(r.txt).slice(0, 80)}`);
  }
}

// ---------------- 生成裁图：以它自己的落点为圆心 ----------------
const round1 = { image: spec.image, jobs: trials.map((t, i) => ({
  name: 'aim-' + i, point: [Math.round(t.a.px[0]), Math.round(t.a.px[1])], marked: true, scale: 3,
})) };
// 状态判断用的两张：真值处未选中 vs 合成的选中态。
// 这里【故意不画准星】：准星自己那个洋红圆环，和单选按钮的圆环是同一个形状同一个位置，
// 画上去就分不清"你看到的圆环是控件本身还是我画的标记"——状态判断会被这个混淆污染。
DOTS.forEach((el, i) => {
  round1.jobs.push({ name: 'state-no-' + i, point: el.truth, marked: false, scale: 3 });
  round1.jobs.push({ name: 'state-yes-' + i, point: el.truth, marked: false, select: true, scale: 3 });
});
const reqPath = path.join(WORK, 'requests.json');
fs.writeFileSync(reqPath, JSON.stringify(round1, null, 2));

// 直接问 electron 包要可执行文件的真路径：node_modules/.bin/electron 在 Windows 上是个
// 没有扩展名的 shell 脚本，spawnSync 不套 shell 是跑不起来的（踩过）。
let electron = null;
try { const m = await import('electron'); electron = m.default; } catch (e) {}
const spOpts = { encoding: 'utf8' };
if (typeof electron !== 'string' || !fs.existsSync(electron)) {
  electron = path.resolve(HERE, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (process.platform === 'win32') spOpts.shell = true;
}
console.log('\n=== 生成落点放大图（真 nativeImage，和产品同一条链路）===');
const sp = spawnSync(electron, [path.join(HERE, 'render-crops.cjs'), reqPath, CROPS], spOpts);
console.log((sp.stdout || '').trim() || (sp.stderr || '').trim());
if (sp.status !== 0) { console.log('裁图生成失败，中止'); process.exit(1); }
const cropUrl = (file) => 'data:image/jpeg;base64,' + fs.readFileSync(path.join(CROPS, file)).toString('base64');
const man = JSON.parse(fs.readFileSync(path.join(CROPS, 'manifest.json'), 'utf8'));

// ---------------- 第 2 轮：臂 B（带准星的裁图）和臂 C（只靠文字）----------------
console.log('\n=== 第 2 轮：告诉它"你上次点在这儿"，看它能不能改正 ===');
for (const t of trials) {
  const el = DOTS.find(e => e.key === t.key);
  const i = trials.indexOf(t);
  const n1 = t.a.norm;
  if (!n1) { t.b = { skip: '第1轮没解析出坐标' }; t.c = t.b; continue; }

  const withCrop = await ask([FULL, cropUrl('aim-' + i + '.jpg')],
    '图1 是整个页面。图2 是同一个页面上你上一次落点附近的放大图（放大 3 倍），' +
    '正中间那个洋红色圆环/十字的中心就是你上一次的落点。\n' +
    `任务：${el.ask}。你的上一次落点正好压在它上面了吗？如果没有，给出【修正后】的位置。` + SUFFIX_FULL);
  const pb = withCrop.xy ? toPx(withCrop.xy) : null;
  t.b = { raw: withCrop.txt, norm: withCrop.xy, px: pb, err: pb ? errOf(pb, el) : null, hit: pb ? hitOf(pb, el) : false };
  if (withCrop.err) t.b.error = withCrop.err;

  const noCrop = await ask([FULL],
    `图1 是整个页面。你上一次给出的答案是 x=${Math.round(n1[0])}, y=${Math.round(n1[1])}（归一化 0-1000，相对于图1）。\n` +
    `任务：${el.ask}。请再看一眼这张图，给出【修正后】的位置。` + SUFFIX_FULL);
  const pc = noCrop.xy ? toPx(noCrop.xy) : null;
  t.c = { raw: noCrop.txt, norm: noCrop.xy, px: pc, err: pc ? errOf(pc, el) : null, hit: pc ? hitOf(pc, el) : false };
  if (noCrop.err) t.c.error = noCrop.err;

  console.log(`  ${el.key} #${t.rep}: A ${t.a.err}px${t.a.hit ? '✓' : '✗'} → B ${t.b.err}px${t.b.hit ? '✓' : '✗'} ｜ 对照 C ${t.c.err}px${t.c.hit ? '✓' : '✗'}`);
}

// ---------------- 状态判断探针：裁图能不能读出"选中了没有" ----------------
console.log('\n=== 状态判断：只给放大图，问那个单选控件选中了没有 ===');
const Q = '这是一小块区域的放大图（放大 3 倍）。正中间那个洋红色圆环/十字指着的是一个圆形单选控件（radio）。\n' +
  '问：这个圆形控件现在是【选中】状态吗（也就是这个选项已经被选上了）？\n' +
  '只回答三个词之一：选中 / 没选中 / 看不清。不要其他文字。';
const stateRows = [];
for (let i = 0; i < DOTS.length; i++) {
  const row = { key: DOTS[i].key, no: [], yes: [] };
  for (let r = 0; r < REPEAT; r++) {
    const a = await ask([cropUrl('state-no-' + i + '.jpg')], Q, 12);
    const b = await ask([cropUrl('state-yes-' + i + '.jpg')], Q, 12);
    row.no.push((a.txt || '').replace(/\s/g, '').slice(0, 6));
    row.yes.push((b.txt || '').replace(/\s/g, '').slice(0, 6));
  }
  stateRows.push(row);
  console.log(`  ${row.key}: 未选中→答 ${JSON.stringify(row.no)}   合成选中→答 ${JSON.stringify(row.yes)}`);
}

// ---------------- 汇总 ----------------
const errsA = trials.map(t => t.a.err), errsB = trials.map(t => t.b && t.b.err), errsC = trials.map(t => t.c && t.c.err);
const hitsA = trials.filter(t => t.a.hit).length, hitsB = trials.filter(t => t.b && t.b.hit).length, hitsC = trials.filter(t => t.c && t.c.hit).length;
const nT = trials.length;

console.log('\n========== 汇总 ==========');
console.log(`            平均误差    点中率`);
console.log(`A 只看整屏     ${String(mean(errsA)).padStart(6)}px    ${hitsA}/${nT}`);
console.log(`B 整屏+裁图    ${String(mean(errsB)).padStart(6)}px    ${hitsB}/${nT}   ← 产品现在的做法`);
console.log(`C 整屏+只说话  ${String(mean(errsC)).padStart(6)}px    ${hitsC}/${nT}   ← 对照组`);

const stateOk = (arr, want) => arr.filter(v => v === want).length;
let sNo = 0, sYes = 0, sTot = 0;
for (const r of stateRows) { sNo += stateOk(r.no, '没选中'); sYes += stateOk(r.yes, '选中'); sTot += r.no.length + r.yes.length; }
console.log(`\n状态判断：未选中判对 ${sNo}/${nT}，合成选中判对 ${sYes}/${nT}（合计 ${sNo + sYes}/${sTot}）`);

fs.writeFileSync(path.join(WORK, 'results.json'), JSON.stringify(
  { at: new Date().toISOString(), model: MODEL, repeat: REPEAT, spec: { image: spec.image, width: spec.width, height: spec.height },
    summary: { A: { meanErr: mean(errsA), hits: hitsA }, B: { meanErr: mean(errsB), hits: hitsB }, C: { meanErr: mean(errsC), hits: hitsC }, n: nT,
               state: { noCorrect: sNo, yesCorrect: sYes, total: sTot } },
    trials: trials, state: stateRows }, null, 2));

// 基线：把"只看整屏图"的数字冻结下来。没有它，"变好了"就没法证伪。
const basePath = path.join(FIX, 'target.baseline.json');
const before = fs.existsSync(basePath) ? JSON.parse(fs.readFileSync(basePath, 'utf8')) : null;
const baseline = {
  recordedAt: new Date().toISOString(), source: 'tests/live/test-crop-feedback.mjs 臂A（只看整屏图，归一化坐标）',
  model: MODEL, repeat: REPEAT, elements: DOTS.length, trials: nT,
  meanErrorPx: mean(errsA), hitRate: hitsA + '/' + nT,
  perElement: DOTS.map((el, i) => ({ key: el.key, errs: trials.filter(t => t.key === el.key).map(t => t.a.err) })),
};
fs.writeFileSync(basePath, JSON.stringify(baseline, null, 2));
console.log('\n基线已存 → tests/fixtures/target.baseline.json');
if (before && before.meanErrorPx != null) console.log(`  上次基线 ${before.meanErrorPx}px / ${before.hitRate} → 这次 ${baseline.meanErrorPx}px / ${baseline.hitRate}`);
console.log('明细 → tests/live/_work/results.json（含每张裁图，可自己看）');

c.section('实测结论');
// 这张图靠不靠谱，看的是"读状态"那一条——它是裁图唯一站得住的本事，
// 也是想拿它替换那个噪声布尔值的全部理由。八成算及格线。
c.ok('状态判断够用（≥80% 判对）', (sNo + sYes) / sTot >= 0.8, `${sNo + sYes}/${sTot}`);
c.ok('臂 A 基线已记录（"变好了"要有得比）', mean(errsA) != null, `A=${mean(errsA)}px ${hitsA}/${nT}`);
console.log('（参考，不作判定）B=' + mean(errsB) + 'px ' + hitsB + '/' + nT +
  ' ｜ C=' + mean(errsC) + 'px ' + hitsC + '/' + nT +
  '  —— B 若明显赢过 A，才值得再谈"自动附带落点放大图"。');

c.done();
