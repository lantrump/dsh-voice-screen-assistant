// 给 agent 装上"指针"：落点附近裁一块、放大、画准星 —— 纯像素数学 + IPC 链路 + 循环接线。
//
// 为什么要有这个：以前模型每步只有一个噪声布尔值当反馈（"落点附近变没变"，changedPixels>=20），
// 它分不清"点到旁边空白 / 本来就选中了 / 输入框只有光标在闪"，于是老点错、反复点同一个地方。
// 裁图带着【它上次点在哪】的准星，才是那个反馈的正解。
import annotate from '../lib/annotate.js';
import { loadRenderer } from './lib/fake-dom.mjs';
import { loadMain } from './lib/fake-electron.mjs';
import { createChecker } from './lib/check.mjs';

const c = createChecker();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CLICK_B = '{"action":"click","target":"选项B","x":281,"y":168}';
const DONE = '{"action":"done","reason":"题目都答完了"}';

function makeApp(opts = {}) {
  return loadRenderer(Object.assign({
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: { sources: async () => [{ id: 'screen:0:0', name: '屏幕' }] },
  }, opts));
}

const MAGENTA = { B: 255, G: 0, R: 255, A: 255 };
const pxAt = (buf, w, x, y) => { const i = (y * w + x) * 4; return { B: buf[i], G: buf[i + 1], R: buf[i + 2], A: buf[i + 3] }; };
const isMagenta = (p) => p.B === MAGENTA.B && p.G === MAGENTA.G && p.R === MAGENTA.R && p.A === MAGENTA.A;

// ---------- 1) clampRect：窗口尺寸不够就缩、位置越界就【平移】回来 ----------
c.section('clampRect');
c.eq('小小的窗口原样通过', annotate.clampRect({ x: 100, y: 100, w: 320, h: 200 }, 1920, 1200, 16, 16),
  { x: 100, y: 100, w: 320, h: 200 });
c.eq('左边越界 → 平移回 0（尺寸不变）', annotate.clampRect({ x: -200, y: 100, w: 320, h: 200 }, 1920, 1200, 16, 16),
  { x: 0, y: 100, w: 320, h: 200 });
c.eq('右边越界 → 贴住右边界', annotate.clampRect({ x: 1800, y: 100, w: 320, h: 200 }, 1920, 1200, 16, 16),
  { x: 1600, y: 100, w: 320, h: 200 });
c.eq('上边越界 → 平移回 0', annotate.clampRect({ x: 100, y: -50, w: 320, h: 200 }, 1920, 1200, 16, 16),
  { x: 100, y: 0, w: 320, h: 200 });
c.eq('下边越界 → 贴住下边界', annotate.clampRect({ x: 100, y: 1100, w: 320, h: 200 }, 1920, 1200, 16, 16),
  { x: 100, y: 1000, w: 320, h: 200 });
c.eq('窗口比源图还大 → 缩到源图', annotate.clampRect({ x: 0, y: 0, w: 9999, h: 9999 }, 1920, 1200, 16, 16),
  { x: 0, y: 0, w: 1920, h: 1200 });
c.eq('比下限还小 → 抬到下限', annotate.clampRect({ x: 0, y: 0, w: 2, h: 2 }, 1920, 1200, 16, 16),
  { x: 0, y: 0, w: 16, h: 16 });
c.eq('缺字段也不炸（全给默认）', annotate.clampRect({}, 1920, 1200, 16, 16), { x: 0, y: 0, w: 16, h: 16 });

// ---------- 2) crosshairIndex：按【源点】算，不是拿裁图几何中心算 ----------
c.section('crosshairIndex');
c.eq('落点在窗口正中：中心×倍数', annotate.crosshairIndex({ x: 260, y: 200 }, { x: 100, y: 100 }, 3), { cx: 480, cy: 300 });
// 贴边时 clampRect 把窗口平移了，落点变成偏心的——正是"必须按源点算"的原因
c.eq('贴右/下边：按源点算，落点偏心而不是居中', annotate.crosshairIndex({ x: 1900, y: 1150 }, { x: 1600, y: 1000 }, 3), { cx: 900, cy: 450 });
c.eq('倍数为 0 时按 1 倍兜底（不炸）', annotate.crosshairIndex({ x: 150, y: 150 }, { x: 100, y: 100 }, 0), { cx: 50, cy: 50 });

// ---------- 3) paintCrosshair：环和臂上写洋红，中心留洞，长度不变 ----------
c.section('paintCrosshair');
{
  const W = 60, H = 60, cx = 30, cy = 30;
  const buf = Buffer.alloc(W * H * 4, 9);            // 底色全 9，方便看哪里被画过
  const before = buf.length;
  annotate.paintCrosshair(buf, W, H, cx, cy);
  c.eq('buffer 长度不变（原地改，不重新分配）', buf.length, before);
  c.ok('正中心是【空洞】，没被盖住（落点下面就是要看的控件）', !isMagenta(pxAt(buf, W, cx, cy)), JSON.stringify(pxAt(buf, W, cx, cy)));
  c.ok('d=2 也在洞里', !isMagenta(pxAt(buf, W, cx + 2, cy)));
  c.ok('圆环上（d≈6）是洋红', isMagenta(pxAt(buf, W, cx + 6, cy)), JSON.stringify(pxAt(buf, W, cx + 6, cy)));
  c.ok('环右上斜向也在', isMagenta(pxAt(buf, W, cx + 4, cy - 4)), JSON.stringify(pxAt(buf, W, cx + 4, cy - 4)));
  c.ok('四条臂上都是洋红', isMagenta(pxAt(buf, W, cx + 14, cy)) && isMagenta(pxAt(buf, W, cx - 14, cy)) &&
    isMagenta(pxAt(buf, W, cx, cy + 14)) && isMagenta(pxAt(buf, W, cx, cy - 14)));
  c.ok('环和臂之间（d≈8）留空，不是一整块', !isMagenta(pxAt(buf, W, cx + 8, cy)), JSON.stringify(pxAt(buf, W, cx + 8, cy)));
  c.ok('洋红的值就是 (B255,G0,R255,A255)：BGRA 顺序下 R/B 互换也不变', isMagenta(pxAt(buf, W, cx + 6, cy)));
}
{
  // 贴边：准星画到画布外不能越界写坏别的像素
  const W = 20, H = 20;
  const buf = Buffer.alloc(W * H * 4, 9);
  annotate.paintCrosshair(buf, W, H, 1, 1);
  c.eq('准星贴着左上角：buffer 长度仍然不变', buf.length, W * H * 4);
  c.ok('越界的部分被安全丢弃（没抛错、没写坏）', buf[0] === 9 || buf[0] === 255);
}
{
  // 自定义尺寸：w/h 给大一点应该看到更长的臂
  const W = 80, H = 80;
  const a = Buffer.alloc(W * H * 4, 9), b = Buffer.alloc(W * H * 4, 9);
  annotate.paintCrosshair(a, W, H, 40, 40, { hole: 5, ring: 7, gap: 9, arm: 10 });
  annotate.paintCrosshair(b, W, H, 40, 40, { hole: 5, ring: 7, gap: 9, arm: 20 });
  c.ok('arm 变大 → 臂更长', isMagenta(pxAt(b, W, 40 + 25, 40)) && !isMagenta(pxAt(a, W, 40 + 25, 40)));
}

// ---------- 3b) 准星随放大倍数一起放大（尺寸单位是【源像素】）----------
// 这条是承重的：如果准星按输出像素算，放大 3 倍后它会比它指的那个单选圆点还小，
// 一眼看不出"落点偏了多少"——而"看清偏了多少"正是这张图存在的全部理由。
c.section('准星尺寸随倍数走（源像素单位）');
{
  const W = 200, H = 200, cx = 100, cy = 100;
  const big = Buffer.alloc(W * H * 4, 9);
  annotate.paintCrosshair(big, W, H, cx, cy, { scale: 3 });
  c.ok('中心洞也跟着放大：d=10 仍在洞里', !isMagenta(pxAt(big, W, cx + 10, cy)));
  c.ok('圆环在 d≈18（源半径 5..7 × 3 = 15..21）', isMagenta(pxAt(big, W, cx + 18, cy)));
  c.ok('环和臂之间 d≈24 留空（源 gap 9 × 3 = 27）', !isMagenta(pxAt(big, W, cx + 24, cy)));
  c.ok('臂画到 d≈40（源 9..19 × 3 = 27..57）', isMagenta(pxAt(big, W, cx + 40, cy)));
  c.ok('臂有粗细（3 倍 → 3px 宽），不是一压 JPEG 就糊的 1px 细线',
    isMagenta(pxAt(big, W, cx + 40, cy + 1)) && !isMagenta(pxAt(big, W, cx + 40, cy + 3)));

  // 同样的源尺寸、只改倍数：同一个距离上"画不画"应该正好相反，这就是等比缩放的证明
  const one = Buffer.alloc(W * H * 4, 9);
  annotate.paintCrosshair(one, W, H, cx, cy, { scale: 1 });
  c.ok('d=10：3 倍时在洞里（不画），1 倍时在臂上（画）', !isMagenta(pxAt(big, W, cx + 10, cy)));
  c.ok('d=48：3 倍时在臂上（画），1 倍时早就出了臂（不画）',
    isMagenta(pxAt(big, W, cx + 48, cy)) && !isMagenta(pxAt(one, W, cx + 48, cy)));
}

// ---------- 3c) paintCursor：把鼠标指针画进整屏截图 ----------
// 用户说"点这个"靠的是鼠标位置；截图 API 不带光标，不画的话模型根本不知道人在指哪。
c.section('paintCursor');
{
  const W = 120, H = 120, cx = 30, cy = 30;
  const buf = Buffer.alloc(W * H * 4, 0);
  annotate.paintCursor(buf, W, H, cx, cy);
  const alphaAt = (x, y) => pxAt(buf, W, x, y).A;
  c.eq('buffer 长度不变（原地画）', buf.length, W * H * 4);
  c.ok('箭头内部是黑色（高光描边之外）', pxAt(buf, W, cx + 1, cy + 2).B === 0 &&
    pxAt(buf, W, cx + 1, cy + 2).G === 0 && pxAt(buf, W, cx + 1, cy + 2).R === 0 &&
    alphaAt(cx + 1, cy + 2) === 255, JSON.stringify(pxAt(buf, W, cx + 1, cy + 2)));
  c.ok('箭头外侧有一圈白色描边（深色界面上也看得见）', pxAt(buf, W, cx - 1, cy + 2).R === 255 &&
    pxAt(buf, W, cx - 1, cy + 2).A === 255, JSON.stringify(pxAt(buf, W, cx - 1, cy + 2)));
  c.eq('远离指针的地方不动（背景保持透明）', alphaAt(cx + 50, cy + 50), 0);
  c.ok('箭头尖就在传入的坐标附近', alphaAt(cx, cy) === 255 || alphaAt(cx, cy + 1) === 255);

  // 高 DPI 截图（宽 3840）指针要等比放大，否则 2px 的小箭头压完 JPEG 就没了
  const one = Buffer.alloc(W * H * 4, 0), two = Buffer.alloc(W * H * 4, 0);
  annotate.paintCursor(one, W, H, cx, cy, { scale: 1 });
  annotate.paintCursor(two, W, H, cx, cy, { scale: 2 });
  c.eq('1 倍时长度 20 像素以外没有箭头', alphaAt(cx, cy + 30), 0);
  c.ok('2 倍时同一位置有箭头（等比放大）', two[(cy + 30) * W * 4 + cx * 4 + 3] === 255,
    JSON.stringify(pxAt(two, W, cx, cy + 30)));

  const edge = Buffer.alloc(20 * 20 * 4, 0);
  annotate.paintCursor(edge, 20, 20, 1, 1);
  c.eq('贴左上角时不越界写坏 buffer', edge.length, 20 * 20 * 4);
  c.ok('贴边时越界部分安全丢弃', edge[0] === 0 || edge[3] === 255);
}

// ---------- 4) annotate-crop IPC：crop → resize → 画准星 → createFromBuffer ----------
c.section('annotate-crop IPC');
{
  const { handlers } = loadMain();
  const r = handlers['annotate-crop']({}, {
    dataUrl: 'data:image/jpeg;base64,ZZZ',
    rect: { x: 100, y: 100, w: 320, h: 200 },
    point: { x: 260, y: 200 },
    scale: 3,
  });
  c.eq('成功', r.ok, true);
  c.eq('输出尺寸 = 源尺寸 × 倍数', [r.width, r.height], [960, 600]);
  c.eq('准星下标按源点算', r.crosshair, [480, 300]);
  c.eq('倍数原样带回', r.scale, 3);
  c.ok('回的是内联 JPEG data URL', String(r.dataUrl).indexOf('data:image/jpeg;base64,') === 0, String(r.dataUrl).slice(0, 40));
}
{
  const { handlers } = loadMain();
  const r = handlers['annotate-crop']({}, {
    dataUrl: 'data:image/jpeg;base64,ZZZ',
    rect: { x: 1800, y: 1100, w: 320, h: 200 },        // 贴右下角：主进程会先夹紧
    point: { x: 1900, y: 1150 },
    scale: 3,
  });
  c.eq('贴边时先夹紧窗口再裁（窗口平移，尺寸不变）', [r.width, r.height], [960, 600]);
  c.eq('夹紧之后落点偏心，准星跟着偏', r.crosshair, [900, 450]);
}
{
  const { handlers } = loadMain();
  c.eq('空输入 → ok:false（不抛错）', handlers['annotate-crop']({}, {}).ok, false);
  c.eq('空输入给了原因', handlers['annotate-crop']({}, {}).error, '图片解码失败');
}

// ---------- 5) 循环接线：点前瞄准一次、点后读状态一次，但绝不把图塞进动作请求（实测有害） ----------
// 2026-09-28 实测（tests/live/test-crop-feedback.mjs，n=9）：把落点放大图塞进"要它出坐标"的请求里，
// 模型会对着十字重新犹豫，把本来点对的答案改偏（平均误差 10.5px → 36.2px）；只给文字反而 10.1px。
// 所以这条路拆成两半：裁图【单独】问一句"生效没有 / 控件什么状态"，把结论当【文字】交给下一步；
// 图本身不塞进动作请求。这一节就钉住这两件事，别又把图塞回去。
c.section('循环接线：点完单独读状态，动作请求里不放裁图');
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  await app.sandbox.runTask('把这页选择题选上');

  // ① 动作请求里永远只有一张整屏图
  const parts0 = app.chats[0].body.messages[1].content;
  c.eq('第一步只有一张整屏图', parts0.filter(p => p.type === 'image_url').length, 1);

  const parts1 = app.chats[1].body.messages[1].content;
  c.eq('第二步仍然只有一张整屏图（裁图没被塞进来）', parts1.filter(p => p.type === 'image_url').length, 1);
  c.eq('第二步的图就是那张干净整屏图', parts1[1].image_url.url, 'data:image/png;base64,AAAA');
  c.ok('文字里没有出现「图2」的裁图说明', !parts1[0].text.includes('图2'), parts1[0].text.slice(0, 120));

  // ② 两个副请求都跑了：点前放大瞄一次，点后再读一次状态。都不带准星。
  c.eq('点前瞄准 + 点后读状态，各裁一块', app.cropCalls.length, 2);
  c.eq('两次裁图都不带准星（准星和单选控件的圆环同形同位，画上就读不准）',
    [app.cropCalls[0].marked, app.cropCalls[1].marked], [false, false]);
  c.eq('瞄准裁图以原落点为圆心', app.cropCalls[0].point, { x: 539, y: 201 });
  c.eq('读状态裁图以实际落点为圆心', app.cropCalls[1].point, { x: 539, y: 201 });
  c.eq('点前单独问了瞄准模型一次', app.stats.refineCalls, 1);
  c.eq('点后单独问了一次"现在什么状态"', app.stats.stateReads, 1);
  c.ok('读到的状态作为【文字】写进了给模型的历史',
    JSON.stringify(app.chats).includes('放大图判读'), '历史里没有放大图判读');
  c.ok('这条状态没有变成第二张图',
    app.chats[1].body.messages[1].content.filter(p => p.type === 'image_url').length === 1,
    '动作请求里多出了图');

  // 这是纪律：整屏图必须一直是干净的（预览、diff、取证、自查都靠它）
  c.eq('state.previewDataUrl 仍是干净整屏图', app.run('state.previewDataUrl'), 'data:image/png;base64,AAAA');
  c.eq('逐步取证没被打乱', app.artifacts.filter(a => /^step-\d\d$/.test(a.file)).length, 2);
  c.eq('没有产生 step-NN-crop 取证（裁图只用于读状态，不当作这一步的图证据）',
    app.artifacts.filter(a => /-crop$/.test(a.file)).length, 0);
}

// ---------- 5a) 点前瞄准：裁图内的归一化坐标要正确映射回屏幕 ----------
// 实测（tests/live，n=15，11px 单选圆点）：整屏 21.1px / 0 中 → 裁图内重定位 2.6px / 15 中。
// 这一节钉住映射：裁图不是整屏，坐标必须按【裁切框 + 裁图尺寸】换算回去。
c.section('点前瞄准：裁图坐标映射回屏幕');
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  app.setRefineReply('{"x":600,"y":500}');
  await sleep(10);
  await app.sandbox.runTask('把这页选择题选上');

  // 原落点 (539,201)；裁图 320x200 以它为中心 → 裁切框 {x:379,y:101}
  // 裁图内的 (600,500) → 379 + 600/1000 × 320 = 571，101 + 500/1000 × 200 = 201
  const click = app.cmds.find(c => c.cmd === 'click');
  c.eq('点击用的是瞄准后的落点', click, { cmd: 'click', x: 571, y: 201, button: 'left', double: false });
  c.eq('读状态也用瞄准后的落点', app.cropCalls[1].point, { x: 571, y: 201 });
}
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  app.setRefineReply('图里找不到');                 // 解析不出来 → 必须回退原落点
  await sleep(10);
  await app.sandbox.runTask('把这页选择题选上');
  const click = app.cmds.find(c => c.cmd === 'click');
  c.eq('瞄准失败时按原落点点击（锦上添花不能挡住点击）', click.x + ',' + click.y, '539,201');
}

// ---------- 5b) 读状态时绝不把整段代码带进去 ----------
// type 动作的说明里带着【整段敲进去的代码】。读状态只要知道"刚输入了点什么"，
// 带上全文会让这次请求白白涨几千 token——所以说明必须截断。这条钉住这个截断。
c.section('读状态不夹带整段代码');
{
  const CODE = 'class Solution:\n    def f(self, x):\n        return x + 1\n' + '    # 填充行\n'.repeat(40);
  const app = makeApp({ chatReplies: [
    JSON.stringify({ action: 'type', target: '代码编辑器', text: CODE, x: 500, y: 400, lineByLine: true }),
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('改这道题');

  c.eq('输入之后也去读了一次状态', app.stats.stateReads, 1);
  const texts = ((app.stateReads[0] || {}).messages || [])
    .filter(m => m.role === 'user')
    .flatMap(m => (Array.isArray(m.content) ? m.content : [m.content]))
    .filter(p => p && p.type === 'text').map(p => p.text).join('');
  c.ok('动作说明被截短了，没夹带整段代码', texts.length < CODE.length,
    '读状态请求里的文字 ' + texts.length + ' 字符，而代码本身就 ' + CODE.length + ' 字符');
}

// ---------- 6) 滚动/等待这类不动鼠标的动作，更不会有裁图 ----------
c.section('滚动/等待不带裁图');
{
  const app = makeApp({ chatReplies: ['{"action":"scroll","direction":"down","amount":3}', DONE] });
  await sleep(10);
  await app.sandbox.runTask('往下滚一屏');
  c.eq('滚动之后没有裁图请求', app.cropCalls.length, 0);
  c.eq('第二步仍然只有一张整屏图', app.chats[1].body.messages[1].content.filter(p => p.type === 'image_url').length, 1);
}

// ---------- 7) look：只看不动鼠标，且它的裁图会带到下一步 ----------
c.section('look 动作');
{
  const app = makeApp({ chatReplies: [
    '{"action":"look","target":"第 2 题的小圆点","x":281,"y":168,"w":200,"h":150}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('看不清，凑近看看');

  c.eq('look 一步都没动鼠标键盘', app.cmds.length, 0);
  c.eq('look 真的去裁了一块', app.cropCalls.length, 1);
  c.eq('look 的窗口按 w/h 换算：横向 200/1000 × 1920 = 384', app.cropCalls[0].rect.w, 384);
  c.eq('look 的窗口按 w/h 换算：纵向 150/1000 × 1200 = 180', app.cropCalls[0].rect.h, 180);
  const parts1 = app.chats[1].body.messages[1].content;
  c.eq('look 的裁图带给了下一步', parts1.filter(p => p.type === 'image_url').length, 2);
  c.eq('第二步的图2 就是 look 那张', parts1[2].image_url.url, 'data:image/jpeg;base64,CROP');
  c.ok('流水账里说清了「凑近看」且没动鼠标', app.getEl('answer')._htmlHistory.join('\n').includes('凑近看'), '流水里没有这一步');
  c.ok('流水账没被整张裁图撑爆', app.getEl('answer').innerHTML.length < 5000,
    '流水账长度 ' + app.getEl('answer').innerHTML.length);
  c.eq('look 只裁一次，没有 look→look 打转', app.cropCalls.length, 1);
}

// ---------- 8) look 的参数校验 ----------
c.section('look 参数校验');
{
  const app = makeApp({ chatReplies: [] });
  await sleep(10);
  await c.throws('缺 x/y → 报错', () => app.sandbox.parseAction('{"action":"look","target":"那儿"}'), 'look 缺少 x/y');
  await c.throws('缺 target → 报错', () => app.sandbox.parseAction('{"action":"look","x":10,"y":10}'), 'look 必须说明 target');
  const a = app.sandbox.parseAction('{"action":"look","target":"那儿","x":10,"y":10}');
  c.eq('合法 look 解析出来就是 look', a.action, 'look');
}

c.done();
