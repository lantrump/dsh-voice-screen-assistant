// agent 循环（"大脑"）：看→想→动→回看→继续，以及逐步确认、熔断、步数上限、随时叫停。
import { loadRenderer } from './lib/fake-dom.mjs';
import { createChecker } from './lib/check.mjs';

const c = createChecker();
// 正常等待：必须占住进程（否则 Node 会在 await 还没回来时就退出）
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 只给 Promise.race 当"陪跑"用：任务先结束时，这个输掉的定时器不该把进程继续吊着
// （以前每条这样的用例都要白等 2~3 秒，整个套件因此被拖长好几秒）
const raceSleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });

const CLICK_B = '{"action":"click","target":"选项B","x":281,"y":168}';
const DONE = '{"action":"done","reason":"题目都答完了"}';

// 每个用例都拿一个全新的 renderer 实例
function makeApp(opts = {}) {
  return loadRenderer(Object.assign({
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: { sources: async () => [{ id: 'screen:0:0', name: '屏幕' }] },   // 有捕捉源，截图才会产生数据
  }, opts));
}

// ---------- 1) 基本循环 ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  const capBefore = app.stats.captures;             // 启动时准备态自己会截一张，只比较增量
  const upBefore = app.stats.uploads;
  await app.sandbox.runTask('把这页选择题选上');
  c.ok('任务一开始就告诉你说话需要开麦克风、怎么中止',
    app.getEl('answer')._htmlHistory.some(h => h.includes('需要先开麦克风') && h.includes('要中止')),
    '答案栏这些时刻的内容都没提过停止方式');

  c.section('基本循环');
  c.eq('两步各问模型一次', app.stats.chatCalls, 2);
  c.eq('每步都重新截了一张图', app.stats.captures - capBefore, 2);
  c.eq('截图是内联进请求的（省掉每次上传往返）', app.stats.uploads - upBefore, 0);
  const parts = app.chats[0].body.messages[1].content;
  c.eq('请求里带的是 image_url，不是 file_id', parts[1].type, 'image_url');
  c.ok('图片是完整的内联 data URL', String(parts[1].image_url.url).indexOf('data:image/') === 0, String(parts[1].image_url.url).slice(0, 40));
  c.eq('模型给的动作被执行了', app.cmds, [{ cmd: 'click', x: 539, y: 201, button: 'left', double: false }]);
  const summary = app.getEl('answer').innerHTML;
  c.ok('结束时汇报了模型给的原因', summary.includes('题目都答完了'), summary.slice(0, 200));
  c.ok('结束时列出实际执行的步骤', summary.includes('选项B'), summary.slice(0, 200));
  c.eq('循环跑完后不再处于运行中', app.run('agent.running'), false);
}

// ---------- 2) 不再逐步确认：普通动作直接执行，只留实时流水让你盯着 ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);

  await app.sandbox.runTask('直接跑，我自己看');

  c.section('不再逐步确认');
  c.eq('普通点击直接执行了', app.cmds.filter(c => c.cmd === 'click').length, 1);
  c.ok('没有弹出确认框',
    !app.getEl('answer')._htmlHistory.some(h => h.includes('准备执行')),
    '出现了确认框');
  const log = app.getEl('answer')._htmlHistory.join('\n');
  c.ok('流水里记下了点了什么、落到哪', log.includes('点击「选项B」') && log.includes('落点 (539,201)'), log.slice(0, 300));
}

// ---------- 3) 普通动作直接执行（不再有"每步确认"） ----------
{
  const app = makeApp({ chatReplies: ['{"action":"click","target":"选项 C","x":500,"y":700}', DONE] });
  await sleep(10);

  await app.sandbox.runTask('选一个选项');

  c.section('普通动作直接执行');
  c.eq('直接就点了，不用你点任何同意', app.cmds.filter(c => c.cmd === 'click').length, 1);
  c.ok('流水里能看见这一步',
    app.getEl('answer')._htmlHistory.join('\n').includes('选项 C'),
    '流水里没有这一步');
}

// ---------- 4) 跑到一半按停止：要能立刻停 ----------
{
  const app = makeApp({ chatReplies: () => CLICK_B });
  await sleep(10);

  const run = app.sandbox.runTask('半路叫停');
  await sleep(60);
  app.getEl('actStop').click();                     // 相当于点小窗上的 ■
  await Promise.race([run, raceSleep(2000)]);

  c.section('随时叫停');
  c.eq('循环退出了（不卡死）', app.run('agent.running'), false);
  c.ok('没跑到步数上限', app.stats.chatCalls < 30, '实际问了 ' + app.stats.chatCalls + ' 次');
}

// ---------- 5) 全局热键（Ctrl+Alt+Q）叫停 ----------
{
  let app;
  app = makeApp({ chatReplies: (i) => { if (i === 1) app.requestStop(); return CLICK_B; } });
  await sleep(10);
  await app.sandbox.runTask('热键测试');

  c.section('全局热键');
  c.eq('热键按下后不再继续问模型', app.stats.chatCalls, 2);
  c.ok('状态里说明了已停止', app.getEl('answer').innerHTML.includes('已停止'), app.getEl('answer').innerHTML.slice(0, 200));
}

// ---------- 6) 模型回复看不懂：连续 3 次熔断 ----------
{
  const app = makeApp({ chatReplies: ['我想想啊', '还是不知道', '嗯……'] });
  await sleep(10);
  await app.sandbox.runTask('让模型胡言乱语');

  c.section('解析失败熔断');
  c.eq('试了 3 次就停', app.stats.chatCalls, 3);
  c.eq('一次动作都没执行', app.cmds.length, 0);
  c.ok('说明是连续看不懂', app.getEl('answer').innerHTML.includes('连续 3 步看不懂'), app.getEl('answer').innerHTML.slice(0, 200));
}

// ---------- 7) 执行失败：连续 3 次熔断 ----------
{
  const app = makeApp({
    chatReplies: [CLICK_B, CLICK_B, CLICK_B],
    dsh: { sources: async () => [{ id: 'screen:0:0', name: '屏幕' }], input: async () => { throw new Error('SendInput 失败'); } },
  });
  await sleep(10);
  await app.sandbox.runTask('让手一直失败');

  c.section('执行失败熔断');
  c.eq('试了 3 次就停', app.stats.chatCalls, 3);
  c.ok('说明是连续执行失败', app.getEl('answer').innerHTML.includes('连续 3 步执行失败'), app.getEl('answer').innerHTML.slice(0, 200));
}

// ---------- 7b) 管理员权限窗口：拦下不执行，但不当成故障，循环继续 ----------
{
  let calls = 0;
  const app = makeApp({
    chatReplies: [CLICK_B, CLICK_B, DONE],
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      input: async () => (++calls === 1
        ? { ok: false, code: 'elevated', hwnd: 4242, window: '设备管理器', pid: 99, error: '目标窗口是管理员权限' }
        : { ok: true }),
    },
  });
  await sleep(10);
  await app.sandbox.runTask('在设备管理器里操作');

  c.section('管理员权限窗口');
  c.eq('被拦后没有停下，接着问了下一步', app.stats.chatCalls, 3);
  const hist = String(app.chats[1].body.messages[1].content[0].text);
  c.ok('模型被告知这一步没有执行', hist.includes('没有执行') && hist.includes('管理员权限'), hist.slice(-500));
  c.ok('模型被明确要求不要重试', hist.includes('不要') && hist.includes('重试'), hist.slice(-500));
  c.ok('没有算成连续执行失败', !app.getEl('answer').innerHTML.includes('连续 3 步执行失败'), app.getEl('answer').innerHTML.slice(0, 300));
  c.eq('只提醒用户一次"需要手动操作"',
    app.run('agent.liveLines.filter(function(l){ return l.indexOf("需要你手动完成这一步") >= 0; }).length'), 1);
  c.ok('最后还是正常收工', app.getEl('answer').innerHTML.includes('题目都答完了'), app.getEl('answer').innerHTML.slice(0, 300));
}

// ---------- 7c) 管理员权限窗口：同一窗口连撞 3 次就停下问，不无限重试 ----------
{
  const blocked = { ok: false, code: 'elevated', hwnd: 4242, window: '设备管理器', pid: 99, error: '目标窗口是管理员权限' };
  const app = makeApp({
    chatReplies: () => CLICK_B,
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      input: async () => blocked,
    },
  });
  await sleep(10);
  await app.sandbox.runTask('反复撞管理员窗口');

  c.section('管理员权限窗口：不会无限重试');
  c.eq('撞了 3 次就停下问', app.stats.chatCalls, 3);
  c.ok('说明是管理员窗口拦下的', app.getEl('answer').innerHTML.includes('管理员权限窗口'), app.getEl('answer').innerHTML.slice(-400));
  c.ok('没有误报成执行失败熔断', !app.getEl('answer').innerHTML.includes('连续 3 步执行失败'), app.getEl('answer').innerHTML.slice(0, 300));
}

// ---------- 8) 不设步数上限：没做完就一直做，只有你叫停才停 ----------
{
  // 不靠"等一会儿看它跑了几步"（机器快慢会影响结果），
  // 而是在第 41 步主动叫停——旧的上限是 30，能跑到 41 就说明上限没了。
  let app;
  const STOP_AT = 41;
  app = makeApp({ chatReplies: (i) => { if (i + 1 >= STOP_AT) app.requestStop(); return '{"action":"wait","ms":1}'; } });
  await sleep(10);
  await app.sandbox.runTask('永远做不完的任务');

  c.section('不设步数上限');
  c.ok('跑过旧的 30 步还在继续', app.stats.chatCalls > 30, '实际只跑了 ' + app.stats.chatCalls + ' 步');
  c.eq('是我叫停才停的', app.stats.chatCalls, STOP_AT);
  c.eq('循环正常退出', app.run('agent.running'), false);
  c.ok('不再有"步数上限"这种收尾',
    !app.getEl('answer').innerHTML.includes('步数上限'),
    app.getEl('answer').innerHTML.slice(0, 200));
}

// ---------- 9) 模型接口报错：优雅收尾而不是崩 ----------
{
  const app = makeApp({ chatReplies: [CLICK_B] });
  app.setChatStatus(500);
  await sleep(10);
  await app.sandbox.runTask('接口挂了的任务');

  c.section('模型接口失败');
  c.eq('没有执行任何动作', app.cmds.filter(c => c.cmd === 'click').length, 0);
  c.ok('状态里说明了模型调用失败', app.getEl('answer').innerHTML.includes('模型调用失败'), app.getEl('answer').innerHTML.slice(0, 200));
  c.eq('循环正常退出', app.run('agent.running'), false);
}

// ---------- 10) 提交不再需要你按任何确认键 ----------
{
  const SUBMIT = '{"action":"click","target":"提交按钮","x":397,"y":825}';
  const app = makeApp({ chatReplies: [SUBMIT, '{"ok":true,"problems":[]}', DONE] });
  await sleep(10);

  await Promise.race([app.sandbox.runTask('提交测验'), raceSleep(3000)]);

  c.section('提交不需要确认');
  c.eq('直接就提交了', app.cmds.filter(c => c.cmd === 'click').length, 1);
  c.eq('循环正常退出', app.run('agent.running'), false);
}

// ---------- 11) 跑的过程中按 Ctrl+Alt+Q 能停 ----------
{
  const app = makeApp({ chatReplies: () => CLICK_B });
  await sleep(10);

  const run = app.sandbox.runTask('跑着的时候按停止');
  await sleep(50);
  app.requestStop();
  await Promise.race([run, raceSleep(3000)]);

  c.section('跑的过程中停止');
  c.eq('循环退出了', app.run('agent.running'), false);
  c.ok('没跑到步数上限', app.stats.chatCalls < 30, '实际问了 ' + app.stats.chatCalls + ' 次');
}

// ---------- 12) 停止热键按下后不再继续问模型 ----------
{
  let app;
  app = makeApp({ chatReplies: (i) => { if (i === 1) app.requestStop(); return CLICK_B; } });
  await sleep(10);
  await app.sandbox.runTask('按停止');

  c.section('停止热键生效');
  c.eq('按下后不再继续问模型', app.stats.chatCalls, 2);
  c.ok('流水里说明了已停止', app.getEl('answer')._htmlHistory.join('\n').includes('已停止'), '没有停止说明');
}

// ---------- 13) 让它"解释"：应该说而不是乱点 ----------
{
  const say = '我的理由是 f(3)=2×3+1=7，所以选 B。{"action":"say","text":"第 3 题选 B：f(3)=2×3+1=7"}';
  const app = makeApp({ chatReplies: [say, DONE] });
  await sleep(10);
  await app.sandbox.runTask('解释一下你为什么选这个');

  c.section('说话通道');
  c.eq('只说不动：没发出任何鼠标键盘指令', app.cmds.length, 0);
  c.ok('说的话进了日志', app.getEl('answer').innerHTML.includes('第 3 题选 B'), app.getEl('answer').innerHTML.slice(0, 300));
  c.ok('理由也记进了日志', app.getEl('answer').innerHTML.includes('f(3)=2×3+1=7'), app.getEl('answer').innerHTML.slice(0, 300));
}

// ---------- 14) say 不会被任何确认环节卡住 ----------
{
  const say = '{"action":"say","text":"我来说一句"}';
  const app = makeApp({ chatReplies: [say, DONE] });
  await sleep(10);

  const finished = await Promise.race([app.sandbox.runTask('解释').then(() => true), raceSleep(1000).then(() => false)]);
  c.section('say 不会被卡住');
  c.ok('说完就继续，不用等确认', finished, '1 秒内没跑完，说明 say 被卡住了');
}

// ---------- 15) 它给的理由要出现在流水里（你想知道它为什么这么点） ----------
{
  const app = makeApp({ chatReplies: ['我认为应该选 B。{"action":"click","target":"选项 B","x":397,"y":825}', DONE] });
  await sleep(10);

  await app.sandbox.runTask('看看它怎么想的');
  c.section('流水里带理由');
  c.ok('能看到它为什么这么选',
    app.getEl('answer')._htmlHistory.join('\n').includes('我认为应该选 B。'),
    app.getEl('answer').innerHTML.slice(0, 200));
}

// ---------- 16) 边做边说：一步里既说明又点击 ----------
{
  const app = makeApp({ chatReplies: ['{"action":"click","target":"B. 7","x":281,"y":168,"say":"f(3)=2×3+1=7，选 B"}', DONE] });
  await sleep(10);
  await app.sandbox.runTask('把这道题答了');

  c.section('边做边说');
  c.eq('点击照样执行了', app.cmds.length, 1);
  c.ok('摘要里保留着他当时的说明', app.getEl('answer').innerHTML.includes('f(3)=2×3+1=7，选 B'), app.getEl('answer').innerHTML.slice(0, 300));
}

// ---------- 17) 没让它解释时，机械动作不废话 ----------
{
  const app = makeApp({ chatReplies: ['{"action":"scroll","direction":"down","amount":2}', DONE] });
  await sleep(10);
  await app.sandbox.runTask('往下翻页');

  c.section('没说就不吭声');
  c.eq('滚动执行了', app.cmds.filter(c => c.cmd === 'scroll').length, 1);
  c.ok('日志里没有多出来的理由', !app.getEl('answer').innerHTML.includes('理由：'), app.getEl('answer').innerHTML.slice(0, 300));
}

// ---------- 18) 热键被占用时自动换一个，并把实际生效的组合显示出来 ----------
{
  const app = makeApp({
    chatReplies: [CLICK_B, DONE],
    hotkeyLabels: { labels: { stop: 'Ctrl+Alt+Shift+Q' }, ok: { stop: true } },
  });
  await sleep(10);
  await app.sandbox.loadHotkeys();

  await app.sandbox.runTask('看热键提示');
  const lines = app.getEl('answer')._htmlHistory.join('\n');

  c.section('热键被占用时自动换一个');
  c.ok('流水里告诉你实际生效的停止热键', lines.includes('Ctrl+Alt+Shift+Q'), lines.slice(0, 250));
  c.ok('用实际生效的组合更新了停止按钮的提示', app.getEl('actStop').title.includes('Ctrl+Alt+Shift+Q'), app.getEl('actStop').title);
}

// ---------- 19) 停止热键一个都注册不上时，要明确报警 ----------
{
  const app = makeApp({
    chatReplies: [CLICK_B, DONE],
    hotkeyLabels: { labels: { stop: '' }, ok: { stop: false } },
  });
  await sleep(10);
  await app.sandbox.loadHotkeys();

  await app.sandbox.runTask('热键不可用的情形');

  c.section('停止热键不可用时报警');
  c.ok('流水里说清楚只能用 ■ 停',
    app.getEl('answer')._htmlHistory.join('\n').includes('热键不可用'),
    app.getEl('answer')._htmlHistory.join('\n').slice(0, 250));
}

// ---------- 20) 每一步都留下取证文件（截图 + 模型原话 + 落点 + 结果） ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  await app.sandbox.runTask('取证测试');

  const steps = app.artifacts.filter(a => /^step-\d\d$/.test(a.file));
  const summary = app.artifacts.filter(a => a.file === 'summary');
  c.section('每一步留证据');
  c.eq('两步各写一份取证', steps.length, 2);
  c.eq('第一份带上了当时的截图', steps[0].dataUrl.indexOf('data:image/') === 0, true);
  c.eq('第一份记录了模型的原话', steps[0].json.raw, CLICK_B);
  c.eq('第一份记录了决定的落点', steps[0].json.at, '(539,201)');
  c.ok('第一份记录了执行结果', String(steps[0].json.result).indexOf('已执行') === 0, steps[0].json.result);
  c.eq('同一个任务写在同一个目录下', steps[0].run === steps[1].run, true);
  c.eq('最后写了一份总结', summary.length, 1);
  c.ok('总结里带上了模型名和热键', !!summary[0].json.model && !!summary[0].json.hotkeys, JSON.stringify(summary[0].json).slice(0, 150));
}

// ---------- 21) 捕捉源不是整个屏幕时，必须拒绝执行（否则坐标全是错的） ----------
{
  const app = makeApp({
    chatReplies: [CLICK_B],
    dsh: { sources: async () => [{ id: 'window:123:0', name: '某个窗口' }] },
  });
  await sleep(10);
  await app.sandbox.runTask('用窗口当捕捉源');

  c.section('捕捉源守卫');
  c.eq('一个动作都没执行', app.cmds.length, 0);
  c.eq('也没去问模型', app.stats.chatCalls, 0);
  c.ok('说明了原因并要求切回整个屏幕',
    app.getEl('answer')._htmlHistory.some(h => h.includes('整个屏幕') && h.includes('窗口')),
    app.getEl('answer').innerHTML.slice(0, 250));
}

// ---------- 22) 重复点击只提醒、不拦（拦下来会卡死任务，改成把事实说给它听） ----------
{
  // 2026-09-28 改：原来第二次重复点击会被【拦下】。实测里守卫连着拦几下就把整个任务判死了，
  // 用户看到的是"做题做得好好的它自己停了"——那正是"禁用感"的来源。现在只写一句提醒，动作照发。
  const A = '{"action":"click","target":"选项 A 劳动","x":137,"y":729}';
  const app = makeApp({ chatReplies: [A, A, DONE] });
  await sleep(10);
  await app.sandbox.runTask('别重复点');

  c.section('重复点击只提醒不拦');
  c.eq('两次点击都真的发出去了', app.cmds.length, 2);
  c.ok('提醒里点明了是重复点击', app.getEl('answer')._htmlHistory.some(h => h.includes('重复点击')), '历史里没有提醒');
  c.ok('并且明说这条只是提醒、不拦它',
    app.getEl('answer')._htmlHistory.some(h => h.includes('只是提醒，不拦')),
    '没有"只提醒不拦"的说明');
  c.eq('每步都留了取证', app.artifacts.filter(x => /^step-\d\d$/.test(x.file)).length >= 2, true);
}
{
  // 实测里真实发生过的：目标后面多了个后缀，落点还差了一倍。
  // 仍然要认得出是同一个地方——认出来了，给模型的提醒才是对的。
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"第2题选项 A 数据要素具有竞争性","x":242,"y":429}',
    '{"action":"click","target":"第2题选项 A 数据要素具有竞争性（取消勾选）","x":464,"y":514}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('加后缀重复点');
  c.eq('目标多了后缀、落点也差很远，两次都放行', app.cmds.length, 2);
  c.ok('但认出来是重复，提醒写进了给模型的历史',
    JSON.stringify(app.chats).includes('像是重复点击'), '历史里没有提醒');
}

// ---------- 23) 什么动作都不再问你：点、提交、滚动都是直接执行 ----------
{
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"选项 B 土地","x":264,"y":791}',
    '{"action":"click","target":"选项 C","x":500,"y":700}',
    '{"action":"scroll","direction":"down","amount":2}',
    DONE,
  ] });
  await sleep(10);

  await app.sandbox.runTask('全自动跑');

  c.section('全自动，一路不问');
  c.eq('两次点击都执行了', app.cmds.filter(c => c.cmd === 'click').length, 2);
  c.eq('滚动也执行了', app.cmds.filter(c => c.cmd === 'scroll').length, 1);
  c.ok('全程没有出现过确认框',
    !app.getEl('answer')._htmlHistory.some(h => h.includes('准备执行')),
    '出现了确认框');
}

// ---------- 24) 落点没变化时要告诉模型（否则它会一直点） ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, '{"action":"wait","ms":1}', DONE] });
  app.setImageDiff({ ok: true, changedPixels: 0, totalPixels: 1000 });   // 一点变化都没有
  await sleep(10);
  await app.sandbox.runTask('点了没反应');

  c.section('落点效果反馈');
  c.eq('确实去比对了落点附近', app.diffCalls.length, 1);
  c.eq('比对的是落点附近的小块，不是整屏', app.diffCalls[0].rect.w + 'x' + app.diffCalls[0].rect.h, '240x160');
  c.ok('把"看不出变化"写进了历史，并说明输入框属正常',
    JSON.stringify(app.chats).includes('落点附近看不出变化'),
    '模型收到的历史里没有这个信号');
}
{
  const app = makeApp({ chatReplies: [CLICK_B, '{"action":"wait","ms":1}', DONE] });
  app.setImageDiff({ ok: true, changedPixels: 800, totalPixels: 1000 });
  await sleep(10);
  await app.sandbox.runTask('点了有反应');
  c.ok('有变化时也如实说',
    JSON.stringify(app.chats).includes('落点附近有变化'),
    '模型收到的历史里没有变化信号');
}

// ---------- 24b) 重复点击的提醒不看"上次中没中"：两种都照发，只是提醒的内容要分对 ----------
{
  // 落点附近没变化 = 上次没点中 → 重点它是合理的（连提醒都不该有）
  const A = '{"action":"click","target":"A 个性化定制制造","x":140,"y":322}';
  const app = makeApp({ chatReplies: [A, A, DONE] });
  app.setImageDiff({ ok: true, changedPixels: 0, totalPixels: 1000 });
  await sleep(10);
  await app.sandbox.runTask('上次没点中，重点一次');
  c.section('没点中时重点');
  c.eq('两次点击都真的发出去了', app.cmds.filter(c => c.cmd === 'click').length, 2);
  c.ok('没点中的那次不算"重复"（不该给假提醒）',
    !JSON.stringify(app.chats).includes('像是重复点击'), '给了假提醒');
}
{
  // 对照：上次点中了（有变化）→ 再点很可能把勾取消 → 仍然放行，但提醒必须带上
  const A = '{"action":"click","target":"A 个性化定制制造","x":140,"y":322}';
  const app = makeApp({ chatReplies: [A, A, DONE] });
  app.setImageDiff({ ok: true, changedPixels: 800, totalPixels: 1000 });
  await sleep(10);
  await app.sandbox.runTask('上次点中了，重复点');
  c.section('点中了也放行，但给出对的提醒');
  c.eq('第二次没有被拦，两次都发出去了', app.cmds.filter(c => c.cmd === 'click').length, 2);
  c.ok('提醒说清了"再点一次可能把勾取消"',
    JSON.stringify(app.chats).includes('会把勾取消掉'), '模型收到的历史里没有这条提醒');
}

// ---------- 25) 卡住时【绝不自己停掉任务、也绝不替它动手】：只把事实说给它听 ----------
{
  // 实测里的真实事故：它正在做题，被守卫拦了几下，守卫直接把整个任务判死（"我卡住了"）；
  // 另一类是守卫"替你滚一屏"，屏幕上什么也没发生，用户只觉得它被禁用了。
  // 现在动作一律照发，只有真的空转（连滚 10 次）或跑很多步才停下问你。
  const A = '{"action":"click","target":"章节测验条目","x":200,"y":917}';
  let app;
  app = makeApp({ chatReplies: (i) => { if (i + 1 >= 12) app.requestStop(); return A; } });
  await sleep(10);
  await app.sandbox.runTask('一直点同一个地方');

  const clicks = app.cmds.filter(c => c.cmd === 'click').length;
  const scrolls = app.cmds.filter(c => c.cmd === 'scroll').length;
  const history = JSON.stringify(app.chats);
  const log = app.getEl('answer')._htmlHistory.join('\n');

  c.section('卡住也不会自己停、不替它动手');
  c.eq('我提了 12 次点击，12 次都真的发出去了', clicks, 12);
  c.eq('一次都没替它滚动', scrolls, 0);
  c.ok('给了它可选的换做法清单（选择权留给它）',
    history.includes('去点【别的选项】') && history.includes('改用键盘 Tab/Enter/Space'),
    '历史里没有换做法清单');
  c.eq('是我叫停才停的', app.stats.chatCalls, 12);
  c.ok('没有"我卡住了"这种自行停止',
    !app.getEl('answer').innerHTML.includes('我卡住了'),
    '出现了自行停止：' + log.slice(0, 300));
}

// ---------- 26) 滚动之后，同一个目标可以重新点 ----------
{
  const A = '{"action":"click","target":"章节测验条目","x":200,"y":917}';
  const S = '{"action":"scroll","direction":"down","amount":3}';
  const app = makeApp({ chatReplies: [A, S, A, DONE] });
  await sleep(10);
  await app.sandbox.runTask('滚动后再点同一个');

  c.section('滚动解除拦截');
  c.eq('滚动之后同一个目标能再点一次', app.cmds.filter(c => c.cmd === 'click').length, 2);
  c.eq('滚动本身没有附带任何点击', app.cmds.filter(c => c.cmd === 'scroll').length, 1);
}

// ---------- 27) 换说法点同一个目标也要认得出（实测里它给同一个入口换了 10 种叫法） ----------
{
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"任务点区域的【测试】数字经济的概念与数字技术 标题文字","x":181,"y":921}',
    '{"action":"click","target":"任务点区域的【测试】数字经济的概念与数字技术 蓝色链接","x":210,"y":905}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('换说法');

  c.section('换说法也认得出是同一个地方');
  c.eq('两次都放行了（只提醒、不拦）', app.cmds.length, 2);
  c.ok('认出来是重复，提醒带上了', JSON.stringify(app.chats).includes('像是重复点击'), '历史里没有提醒');
}
{
  // 坐标只差 1%（实测里 9 个单位），也要认出来
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"页面左下角「章节测验」任务点行","x":211,"y":841}',
    '{"action":"click","target":"左下角任务点中的「章节测验」行","x":220,"y":843}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('坐标抖了一下');

  c.section('坐标抖动 1% 也算同一个地方');
  c.eq('两次都放行，但认得出是重复', app.cmds.length, 2);
  c.ok('提醒带上了', JSON.stringify(app.chats).includes('像是重复点击'), '历史里没有提醒');
}
{
  // 但相邻的两个选项（差 5% 以上）不能被误判成重复——误判就是给假提醒
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"A 劳动","x":100,"y":500}',
    '{"action":"click","target":"B 土地","x":100,"y":560}',
    '{"action":"click","target":"C 数据","x":100,"y":620}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('连着选三个不同选项');

  c.section('相邻选项不能误判');
  c.eq('三个不同选项都点到了', app.cmds.length, 3);
  c.ok('没有给出"重复点击"的假提醒',
    !JSON.stringify(app.chats).includes('像是重复点击'), '把相邻选项误判成了重复');
}

// ---------- 28) 速度：思考默认关掉（实测开着每步 1.5~6 秒，关掉稳定 ~1.0 秒） ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  await app.sandbox.runTask('思考模式');

  c.section('思考默认关掉（速度优先）');
  c.eq('请求里明确关掉了思考', app.chats[0].body.thinking, { type: 'disabled' });
  c.ok('max_tokens 留了余量', app.chats[0].body.max_tokens >= 1000, '实际 ' + app.chats[0].body.max_tokens);

  const sys = app.chats[0].body.messages[0].content;
  c.section('提示词把"用哪个动作"讲清楚');
  c.ok('把键盘当一等公民讲了', sys.includes('Tab 换焦点') && sys.includes('Enter 确认') && sys.includes('Esc'), '系统提示里没讲键盘');
  c.ok('讲了右键和双击', sys.includes('右键') && sys.includes('双击'), '没讲右键/双击');
  c.ok('讲了拖拽用在哪', sys.includes('drag 用于'), '没讲拖拽');
}

// ---------- 29) 运行中的流水账：让你盯着看它每一步点了哪儿 ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, '{"action":"scroll","direction":"down","amount":2}', DONE] });
  await sleep(10);
  await app.sandbox.runTask('看着它跑');

  const lines = app.getEl('answer')._htmlHistory.join('\n');
  c.section('运行中的流水账');
  c.ok('第 1 步：写了点了什么、落到哪', lines.includes('#1 点击「选项B」') && lines.includes('落点 (539,201)'), lines.slice(0, 300));
  c.ok('第 2 步：滚动也记了', lines.includes('#2') && lines.includes('滚动'), lines.slice(0, 400));
  c.ok('每一步都带序号，方便你喊停', lines.includes('#1 ') && lines.includes('#2 '), '没有序号');
}

// ---------- 30) 模型用"工具调用"格式回答时，要能翻译过来 ----------
{
  const app = makeApp({
    chatReplies: [CLICK_B, DONE],
    toolCallReply: { name: 'click', args: { target: '选项 B', x: 281, y: 168 } },   // content 为空，只有 tool_calls
  });
  await sleep(10);
  await app.sandbox.runTask('工具调用格式');

  c.section('工具调用格式也能接住');
  c.eq('动作被执行了', app.cmds.filter(x => x.cmd === 'click').length, 1);
  c.ok('日志里记下了它用了工具调用', JSON.stringify(app.artifacts).includes('hadToolCalls'), '取证里没有元信息');
}

// ---------- 31) 每步都记下 finish_reason 和思考开销（不然出问题只能猜） ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE], finishReason: 'length', reasoningTokens: 999 });
  await sleep(10);
  await app.sandbox.runTask('记录元信息');

  const step = app.artifacts.filter(a => a.file === 'step-01')[0];
  c.section('每步记下响应元信息');
  c.eq('记下了 finish_reason', step.json.meta.finish, 'length');
  c.eq('记下了思考消耗的 token', step.json.meta.reasoningTokens, 999);
}

// ---------- 32) 勾上「思考模式」时，agent 要真的去思考 ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  app.getEl('thinkToggle').checked = true;              // 用户主动勾上
  await app.sandbox.runTask('我要它多想一点');

  c.section('勾上思考才真的思考');
  c.eq('不再发送 disabled', app.chats[0].body.thinking, undefined);
}

// ---------- 33) 语音直接当任务：说完它去做，做完继续听下一件 ----------
{
  const spoken = [
    { items: ['把这道题的第一个选项选上'], micAlive: true },
    { items: ['再点一下 C'], micAlive: true },
    { items: [], micAlive: true },
  ];
  let speakIndex = 0;
  const app = makeApp({
    chatReplies: [CLICK_B, DONE, '{"action":"click","target":"选项 C","x":500,"y":700}', DONE],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash', dsh_mode: 'task' },
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      getSpeech: async () => (speakIndex < spoken.length ? spoken[speakIndex++] : { items: [], micAlive: true }),
    },
  });
  await sleep(10);
  app.run('state.active = true');
  app.run('state.micActive = true');

  await app.tick();                                  // 第一次轮询：第一句话 → 起一个任务
  c.section('语音当任务输入');
  c.eq('第一句语音被当成任务执行了', app.cmds.filter(x => x.cmd === 'click').length, 1);
  c.ok('任务用的是语音里那句话',
    app.getEl('answer')._htmlHistory.join('\n').includes('把这道题的第一个选项选上'),
    '流水里没有这句话');

  await app.tick();                                  // 第二次轮询：第二句话 → 再起一个任务
  c.section('做完继续听下一件');
  c.eq('第二句语音又起了一个任务', app.cmds.filter(x => x.cmd === 'click').length, 2);
  c.ok('跑完提示按住 T 说下一件事',
    app.getEl('actStatus').textContent.includes('按住 T 说下一件事'),
    '状态栏实际是：' + app.getEl('actStatus').textContent);
}

// ---------- 34) 问答模式下，同样的语音还是走问答 ----------
{
  const q = [{ items: ['这是什么题'], micAlive: true }, { items: [], micAlive: true }];
  let qi = 0;
  const app = makeApp({
    chatReplies: [CLICK_B],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash', dsh_mode: 'qa' },
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      getSpeech: async () => (qi < q.length ? q[qi++] : { items: [], micAlive: true }),
    },
  });
  await sleep(10);
  app.run('state.active = true');
  app.run('state.micActive = true');
  await app.tick();

  c.section('问答模式不受影响');
  c.eq('没有发起任何鼠标操作', app.cmds.length, 0);
  c.eq('只问了一次模型', app.stats.chatCalls, 1);
}

// ---------- 35) 自动判断 + 顺手纠正识别错字 ----------
{
  const app = makeApp({
    // 第一次：识别原文是繁体/错字，判断为"去干活"；第二次：判断为"问问题"
    chatReplies: ['{"fixed":"把这个选项选上","kind":"task"}', '{"action":"click","target":"A","x":100,"y":200}', '{"action":"done","reason":"好了"}', '{"fixed":"这道题选哪个","kind":"qa"}', '答案是 B。'],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },      // 不设 mode → 默认 auto
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      getSpeech: (() => {
        const q = [{ items: ['把這個選項選上'], micAlive: true }, { items: ['這道題選哪個'], micAlive: true }, { items: [], micAlive: true }];
        let i = 0; return async () => (i < q.length ? q[i++] : { items: [], micAlive: true });
      })(),
    },
  });
  await sleep(10);
  c.eq('默认就是自动判断', app.run('state.mode'), 'auto');
  app.run('state.active = true');
  app.run('state.micActive = true');

  await app.tick();
  const log1 = app.getEl('answer')._htmlHistory.join('\n');
  c.section('自动判断：要它干活');
  c.eq('判断为任务时真的去动手', app.cmds.filter(x => x.cmd === 'click').length, 1);
  c.ok('任务用的是【改写后】的句子，不是识别原文',
    log1.includes('任务：把这个选项选上') && !log1.includes('任务：把這個選項選上'),
    log1.slice(0, 200));
  c.ok('原始识别结果也留下来了，能看出是听错还是理解错',
    log1.includes('语音识别原文：「把這個選項選上」'),
    log1.slice(0, 200));
  c.ok('状态栏告诉了你它的判断',
    app.getEl('actStatus')._textHistory.some(t => t.includes('判断为：去做这件事')),
    '状态栏没显示判断结果');

  const clicksBefore = app.cmds.filter(x => x.cmd === 'click').length;
  await app.tick();
  c.section('自动判断：在问问题');
  c.eq('判断为问题时不去动鼠标', app.cmds.filter(x => x.cmd === 'click').length, clicksBefore);
}

// ---------- 36) 判不出来时，走安全的一侧（只回答，不动鼠标） ----------
{
  const app = makeApp({
    chatReplies: ['我不太确定', '答案是 B。'],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      getSpeech: (() => { const q = [{ items: ['嗯这个吧'], micAlive: true }, { items: [], micAlive: true }]; let i = 0; return async () => (i < q.length ? q[i++] : { items: [], micAlive: true }); })(),
    },
  });
  await sleep(10);
  app.run('state.active = true');
  app.run('state.micActive = true');
  await app.tick();

  c.section('判不出来时走安全的一侧');
  c.eq('没有动鼠标', app.cmds.length, 0);
}

// ---------- 37) 任务执行中：按住 T 说的话只当"指示"，不另起任务 ----------
{
  const app = makeApp({
    chatReplies: ['A', CLICK_B, DONE],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      getSpeech: (() => { const q = [{ items: ['把这个选上'], micAlive: true }, { items: [], micAlive: true }]; let i = 0; return async () => (i < q.length ? q[i++] : { items: [], micAlive: true }); })(),
    },
  });
  await sleep(10);
  app.run('state.active = true');
  app.run('state.micActive = true');
  app.run('agent.running = true');              // 假装任务正在跑
  const chatsBefore = app.stats.chatCalls;

  await app.tick();

  c.section('任务执行中：插入的话只当指示');
  c.eq('不会再发起"判断这是不是新任务"的调用', app.stats.chatCalls, chatsBefore);
  c.eq('没有动鼠标', app.cmds.length, 0);
  c.ok('把它说的话记成了对当前任务的补充',
    app.getEl('answer')._htmlHistory.join('\n').includes('你说：把这个选上'),
    '流水里没有这句');
  c.eq('  这句话进了 agent 的指示列表', app.run('agent.guidance').map(g => g.text), ['把这个选上']);
}
// ---------- 37b) 任务中说「暂停」：立刻停，不当成补充指示 ----------
{
  const app = makeApp({
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      getSpeech: (() => { const q = [{ items: ['先暂停一下'], micAlive: true }, { items: [], micAlive: true }]; let i = 0; return async () => (i < q.length ? q[i++] : { items: [], micAlive: true }); })(),
    },
  });
  await sleep(10);
  app.run('state.active = true');
  app.run('state.micActive = true');
  app.run('agent.running = true');
  await app.tick();

  c.section('说「暂停」就停');
  c.eq('停止标志立刻置上', app.run('agent.stop'), true);
  c.eq('没有把它当成对任务的补充指示', app.run('agent.guidance').length, 0);
  c.ok('状态栏直接说明已暂停', app.getEl('actStatus').textContent.includes('已暂停'), app.getEl('actStatus').textContent);
}
{
  // 一直保持 ptt：环境音不收、只收按住 T 的；任务结束也不回自动听
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  await app.sandbox.runTask('收话模式');

  c.section('收话模式的时序');
  c.eq('任务开始时切到 ptt', app.stats.modeCalls[0], 'ptt');
  c.eq('任务结束时也保持 ptt（不回自动听）', app.stats.modeCalls[app.stats.modeCalls.length - 1], 'ptt');
  c.ok('中间没有把麦克风关掉、也没切回 auto', app.stats.modeCalls.every(v => v === 'ptt'), JSON.stringify(app.stats.modeCalls));
}
{
  // 任务进行中按住 T 说的话，要真的带进下一步给模型的请求里
  let speakIndex = 0;
  const app = makeApp({
    chatReplies: [CLICK_B, DONE],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      getSpeech: async () => (speakIndex++ === 0 ? { items: ['别点右边那个'], micAlive: true } : { items: [], micAlive: true }),
    },
  });
  await sleep(10);
  app.run('state.active = true');
  app.run('state.micActive = true');
  const running = app.sandbox.runTask('任务中插话');
  await app.tick();                            // 任务跑着的时候收到一句插话
  await app.tick();
  await running;

  c.section('插话会带进下一步判断');
  const text = app.chats.map(ch => ch.body.messages[1].content[0].text).join('\n---\n');
  c.ok('请求里带上了用户说的话', text.includes('别点右边那个'), text.slice(0, 400));
  c.ok('并标明了是任务进行中说的', text.includes('做事期间'), text.slice(0, 400));
}
{
  // 按住 T 时必须有明显的视觉反馈：正在听 → 识别中 → 收起
  const app = makeApp({ chatReplies: [DONE] });
  await sleep(10);
  c.section('按住 T 时的提示');
  app.setPttState({ held: true });
  c.eq('按下时立刻亮出来', app.getEl('pttHud').className, 'show');
  c.ok('独占还没拿到时先让人等一下，别急着说', app.getEl('pttText').textContent.includes('拿麦克风'), app.getEl('pttText').textContent);
  app.setPttState({ held: true, exclusive: true });
  c.ok('抢到独占后提示松开结束', app.getEl('pttText').textContent.includes('松开'), app.getEl('pttText').textContent);
  app.setPttState({ held: true, exclusive: false });
  c.ok('没抢到独占时明确警告（会议也能听到）', app.getEl('pttText').textContent.includes('未独占'), app.getEl('pttText').textContent);
  app.setPttState({ held: false, busy: true });
  c.eq('松开后变成"识别中"', app.getEl('pttHud').className, 'show busy');
  c.ok('识别中的文字对得上', app.getEl('pttText').textContent.includes('识别中'), app.getEl('pttText').textContent);
  app.setPttState({ held: false, busy: false });
  c.eq('识别结束提示收起', app.getEl('pttHud').className, '');
}

// ---------- 38) 交卷前强制自查：对不上就不许提交 ----------
{
  const SUBMIT = '{"action":"click","target":"提交按钮","x":397,"y":825}';
  const app = makeApp({
    // 调用次序：选A → 选B → 【提出提交】→ 自查(不通过) → 改选C → 【再提出提交】→ 自查(通过) → 真提交 → 完成
    chatReplies: [
      '{"action":"click","target":"选项 A","x":100,"y":500}',
      '{"action":"click","target":"选项 B","x":100,"y":560}',
      '{"action":"click","target":"提交按钮","x":397,"y":825}',
      '{"ok":false,"problems":["第 2 题你应该选 B、C，但截图里只有 B 被选中"]}',
      '{"action":"click","target":"选项 C","x":100,"y":620}',
      '{"action":"click","target":"提交按钮","x":397,"y":825}',
      '{"ok":true,"problems":[]}',
      '{"action":"done","reason":"交完了"}',
    ],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: { sources: async () => [{ id: 'screen:0:0', name: '屏幕' }] },
  });
  await sleep(10);
  await app.sandbox.runTask('做完并提交');

  const clicks = app.cmds.filter(x => x.cmd === 'click');
  const log = app.getEl('answer')._htmlHistory.join('\n');

  c.section('交卷前强制自查');
  c.ok('自查没过时把问题说了出来',
    log.includes('提交前自查没过') && log.includes('第 2 题你应该选 B、C'),
    '没看到自查不通过的说明');
  c.eq('自查没过之后先把漏选的补上（选项 C 被点了）',
    clicks.filter(x => x.x === 192).length >= 1, true);
  c.ok('自查通过后放行提交', log.includes('交卷前自查通过'), '没看到自查通过的说明');
  c.eq('最后确实提交了', clicks.filter(x => x.x === 762).length, 1);
}
{
  // 自查一路不过：最多拦 3 次，之后放行（不能永远卡在提交那一步）
  const SUBMIT = '{"action":"click","target":"提交按钮","x":397,"y":825}';
  const BAD = '{"ok":false,"problems":["对不上"]}';
  const app = makeApp({
    // 次序：提出提交 → 自查不过（第1次）→ 提出提交 → 自查不过（第2次）
    //       → 提出提交 → 自查不过（第3次）→ 提出提交 → 自查不过但已达上限 → 放行
    chatReplies: [SUBMIT, BAD, SUBMIT, BAD, SUBMIT, BAD, SUBMIT, BAD, '{"action":"done","reason":"算了"}'],
    stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-flash' },
    dsh: { sources: async () => [{ id: 'screen:0:0', name: '屏幕' }] },
  });
  await sleep(10);
  await app.sandbox.runTask('怎么都对不上');
  c.section('自查不会把任务卡死');
  c.eq('拦了三次之后还是放行了提交', app.cmds.filter(x => x.x === 762).length, 1);
  c.ok('并且告诉你自查没过、让你自己核对',
    app.getEl('answer')._htmlHistory.join('\n').includes('自己核对'),
    '没有提示你自己核对');
}

// ---------- 38b) 提交只做一轮：交过之后不许再交一遍 ----------
{
  // 实测 2026-10-22：确认提交后页面刷新慢，它又去点右上角提交，连交三轮，任务永远不结束。
  const SUBMIT = '{"action":"click","target":"提交按钮","x":397,"y":825}';
  const CONFIRM = '{"action":"click","target":"弹窗里的提交按钮","x":590,"y":585}';
  const app = makeApp({
    chatReplies: [
      SUBMIT, '{"ok":true,"problems":[]}',   // 第一次提交（带自查）
      CONFIRM,                               // 弹窗里确认 = 第二轮点击
      SUBMIT,                                // 想再交一次：必须被拦
      '{"action":"done","reason":"页面显示已提交，任务结束"}',
    ],
  });
  await sleep(10);
  await app.sandbox.runTask('做完并提交');

  const clicks = app.cmds.filter(x => x.cmd === 'click');
  const log = app.getEl('answer')._htmlHistory.join('\n');
  c.section('提交只做一轮');
  c.eq('前两次（提交 + 弹窗确认）正常发出', clicks.length, 2);
  c.ok('第三次提交被拦下，没有真的点出去', log.includes('已拦下重复提交'), '没看到拦下的记录');
  c.ok('并告诉模型先核对结果、不许再点提交',
    JSON.stringify(app.chats).includes('不许再点提交'), '历史里没有这句');
  c.ok('任务正常收尾，不会一直交下去', app.getEl('answer').innerHTML.includes('页面显示已提交'),
    app.getEl('answer').innerHTML.slice(0, 200));
}
{
  const SUBMIT = '{"action":"click","target":"提交按钮","x":397,"y":825}';
  const CONFIRM = '{"action":"click","target":"弹窗里的提交按钮","x":590,"y":585}';
  const app = makeApp({
    chatReplies: [
      SUBMIT, '{"ok":true,"problems":[]}',
      CONFIRM,
      SUBMIT, SUBMIT,   // 连撞两次 → 停下来问你
    ],
  });
  await sleep(10);
  await app.sandbox.runTask('怎么交都交不上');

  c.section('重复提交撞两次就停下问你');
  c.eq('只真正交了两轮，没有一次接一次地交', app.cmds.filter(x => x.cmd === 'click').length, 2);
  c.ok('收尾是停下来问你，不是继续交卷',
    app.getEl('answer').innerHTML.includes('停下来问你'), app.getEl('answer').innerHTML.slice(0, 200));
}
{
  // 对照：改了答案再交是正常流程（LeetCode 那种"没过→改代码→再提交"），不能被当成重复提交。
  const SUBMIT = '{"action":"click","target":"提交按钮","x":397,"y":825}';
  const CONFIRM = '{"action":"click","target":"弹窗里的提交按钮","x":590,"y":585}';
  const EDIT = '{"action":"type","target":"答案编辑框","text":"改好了","x":500,"y":500}';
  const app = makeApp({
    chatReplies: [
      SUBMIT, '{"ok":true,"problems":[]}',
      CONFIRM,
      EDIT,                                  // 改了内容 → 重新提交的计数清零
      SUBMIT, '{"ok":true,"problems":[]}',
      '{"action":"done","reason":"改完重新提交后，页面显示已通过"}',
    ],
  });
  await sleep(10);
  await app.sandbox.runTask('改完再提交');

  const log = app.getEl('answer')._htmlHistory.join('\n');
  const submits = app.cmds.filter(x => x.cmd === 'click' && x.x === 762);   // 提交按钮的落点
  c.section('改过答案之后可以再提交');
  c.eq('改了内容之后的提交没有被拦（提交按钮点了两次）', submits.length, 2);
  c.ok('没有被误拦成重复提交', !log.includes('已拦下重复提交'), '改了内容还是被拦了');
}

// ---------- 39) 找不到目标时不替它滚动：只把事实（有没有点中 / 控件什么状态）说给它 ----------
{
  // 实测里真实发生过的：题看不到，它却去点右侧目录、播放按钮。以前守卫会"替你滚一屏"，
  // 现在不替它动手——把每一步"没点中"的判读摆出来，滚不滚由它自己决定。
  const A = '{"action":"click","target":"右侧目录里的第 1 章","x":880,"y":300}';
  const B = '{"action":"click","target":"右侧目录里的第 2 章","x":880,"y":360}';
  const Cc = '{"action":"click","target":"右侧目录里的第 3 章","x":880,"y":420}';
  const app = makeApp({ chatReplies: [A, B, Cc, DONE] });
  app.setImageDiff({ ok: true, changedPixels: 0, totalPixels: 1000 });   // 三次都没点中
  await sleep(10);
  await app.sandbox.runTask('把题做完');

  const clicks = app.cmds.filter(x => x.cmd === 'click').length;
  const scrolls = app.cmds.filter(x => x.cmd === 'scroll').length;
  const history = JSON.stringify(app.chats);

  c.section('没点中也不替它滚动，只把事实说给它');
  c.eq('三次点击都照它的意思发出去了', clicks, 3);
  c.eq('一次都没替它滚动', scrolls, 0);
  c.ok('"落点附近看不出变化"如实写进了历史', history.includes('落点附近看不出变化'), '历史里没有这个信号');
  c.ok('放大图判读也带上了（比那个布尔值可靠的事实）', history.includes('放大图判读'), '历史里没有放大图判读');
}
{
  // 对照：点得中就一直点，绝不插手
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"选项 A","x":100,"y":500}',
    '{"action":"click","target":"选项 B","x":100,"y":560}',
    '{"action":"click","target":"选项 C","x":100,"y":620}',
    DONE,
  ] });
  app.setImageDiff({ ok: true, changedPixels: 800, totalPixels: 1000 });   // 每次都点中了
  await sleep(10);
  await app.sandbox.runTask('连着选三个');

  c.section('点得中就不插手');
  c.eq('三次点击都真的发出去了', app.cmds.filter(x => x.cmd === 'click').length, 3);
  c.eq('一次滚动都没有', app.cmds.filter(x => x.cmd === 'scroll').length, 0);
}
{
  // 它自己滚过之后，画面变了：新画面里的点击必须放行（否则会陷入"点不动→滚→还是点不动"）
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"第 1 章","x":880,"y":300}',
    '{"action":"click","target":"第 2 章","x":880,"y":360}',
    '{"action":"scroll","direction":"down","amount":3}',
    '{"action":"click","target":"题目选项 B","x":200,"y":400}',
    DONE,
  ] });
  app.setImageDiff({ ok: true, changedPixels: 0, totalPixels: 1000 });
  await sleep(10);
  await app.sandbox.runTask('滚一下再点');

  c.section('滚动之后点击重新放行');
  c.eq('滚动之后的那次点击执行了', app.cmds.filter(x => x.cmd === 'click').length, 3);
  c.eq('只滚了一次', app.cmds.filter(x => x.cmd === 'scroll').length, 1);
}
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  await app.sandbox.runTask('看看提示词');
  const sys = app.chats[0].body.messages[0].content;
  c.section('提示词里滚动是第一优先');
  c.ok('看不见目标时必须是 scroll，并点名禁止点目录/播放按钮',
    sys.includes('必须是 scroll') && sys.includes('视频播放按钮') && sys.includes('瞎逛'),
    '系统提示里没把滚动写成第一选择');
}

// ---------- 40) 弹窗里的按钮 ≠ 页面上同名的按钮（别给假提醒） ----------
{
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"确定按钮","x":397,"y":584}',
    '{"action":"click","target":"弹窗中的确定按钮","x":591,"y":585}',
    '{"action":"click","target":"弹窗中的确定按钮","x":590,"y":586}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('弹窗里的按钮');

  c.section('弹窗按钮不当成页面按钮的重复');
  c.eq('三次都发出去了（只提醒、不拦）', app.cmds.filter(x => x.cmd === 'click').length, 3);
  c.ok('页面按钮和弹窗按钮没有互相误判成重复',
    !JSON.stringify(app.chats).includes('点过「确定按钮」'), '把弹窗按钮误判成了页面按钮');
  c.ok('但弹窗里连点两次给了提醒',
    JSON.stringify(app.chats).includes('像是重复点击'), '弹窗内重复点击没有提醒');
}

// ---------- 41) 记忆之一：跨任务。"继续做"必须知道上一件事干到哪了 ----------
{
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"第 1 章章节测验","x":200,"y":300}',
    DONE,
    '{"action":"wait","ms":1}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('把第 1 章的章节测验做完');
  await app.sandbox.runTask('继续做');

  const lastAsk = app.chats[app.chats.length - 1].body.messages[1].content[0].text;
  const log = app.getEl('answer')._htmlHistory.join('\n');

  c.section('记忆：跨任务');
  c.ok('"继续做"时带上了上一件事的原话', lastAsk.includes('把第 1 章的章节测验做完'), lastAsk.slice(0, 400));
  c.ok('并且说了上一件事做过什么、结局如何',
    lastAsk.includes('做过的') && lastAsk.includes('结局'), lastAsk.slice(0, 400));
  c.ok('界面上也亮出了"它记得"',
    log.includes('记得之前做过') && log.includes('把第 1 章的章节测验做完'), '流水里没提记忆');
  c.ok('第一件事时如实说"没有之前的记忆"',
    log.includes('没有之前的记忆'), '流水里没有这句');
  c.ok('记忆写进了 localStorage（重启也不丢）',
    String(app.sandbox.localStorage.getItem('dsh_task_memory') || '').includes('把第 1 章的章节测验做完'),
    'localStorage 里没有记忆');
}

// ---------- 42) 记忆之二：一件事内部跑长了也不能失忆（以前只记最后 12 步） ----------
{
  const app = makeApp({ chatReplies: (i) => (i < 16 ? '{"action":"wait","ms":1}' : DONE) });
  await sleep(10);
  await app.sandbox.runTask('跑很多步');

  const lastAsk = app.chats[app.chats.length - 1].body.messages[1].content[0].text;
  c.section('记忆：一件事内部');
  c.ok('更早的步骤没有被丢掉，而是折叠成摘要', lastAsk.includes('更早的'), lastAsk.slice(0, 300));
  c.ok('摘要里明确说了"别重做"', lastAsk.includes('别重做'), lastAsk.slice(0, 300));
}

// ---------- 43) 实测复盘：点了 C、D 却没选上，自查必须拦住（不能靠模型扫一眼整页） ----------
{
  // 真实事故（2026-09-27 14:47 那次）：连点 A/B/C/D 五个选项，落点附近【全没变化】
  // （A、B 是上次残留已选中；C、D 是压根没点中）。自查让模型"整页比对"，模型回了 ok:true，
  // 结果只选中 A、B，本题得 50 分。
  const C_CLICK = '{"action":"click","target":"多选题选项 C. 数字经济下的平台","x":480,"y":535}';
  const SUBMIT = '{"action":"click","target":"提交按钮","x":397,"y":825}';
  const app = makeApp({ chatReplies: [
    C_CLICK,
    SUBMIT,
    // 自查读到的截图：C 没选中 —— 而且它嘴上还说 ok:true（代码要能推翻这个 ok）
    '{"ok":true,"unselected":["多选题选项 C. 数字经济下的平台"],"problems":[]}',
    C_CLICK,
    SUBMIT,
    '{"ok":true,"unselected":[],"problems":[]}',
    DONE,
  ] });
  app.setImageDiff({ ok: true, changedPixels: 0, totalPixels: 1000 });    // 点了没反应
  await sleep(10);
  await app.sandbox.runTask('把这道多选做完');

  const checkAsk = app.chats[2].body.messages[1].content[0].text;
  const log = app.getEl('answer')._htmlHistory.join('\n');

  c.section('自查：点了没选中的必须揪出来');
  c.ok('自查把"点了但没反应"的选项单独点名追问',
    checkAsk.includes('一点变化都没有') && checkAsk.includes('多选题选项 C. 数字经济下的平台'),
    checkAsk.slice(-300));
  c.ok('自查要求逐个回答，并给了 unselected 字段', checkAsk.includes('unselected'), checkAsk.slice(-200));
  c.ok('模型嘴上说 ok:true，代码照样不放过', log.includes('提交前自查没过'), log.slice(-400));
  c.ok('并且说清了怎么补：点文字中间、看落点有没有变化',
    JSON.stringify(app.chats).includes('重新点它们的【文字中间】'), '没告诉它怎么补');
  c.eq('补点之后才真的提交', app.cmds.filter(x => x.cmd === 'click' && x.x === 762).length, 1);
}
{
  // 对照：选项都点中了（落点有变化）→ 不该额外追问，直接按模型的判断走
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"多选题选项 A. 平台垄断","x":200,"y":500}',
    '{"action":"click","target":"提交按钮","x":397,"y":825}',
    '{"ok":true,"unselected":[],"problems":[]}',
    DONE,
  ] });
  app.setImageDiff({ ok: true, changedPixels: 900, totalPixels: 1000 });   // 点中了
  await sleep(10);
  await app.sandbox.runTask('正常作答');

  c.section('自查：没问题的别瞎拦');
  c.ok('不额外追问（没有"点了但没反应"的项）',
    !app.chats[2].body.messages[1].content[0].text.includes('一点变化都没有'),
    '不该追问却追问了');
  c.eq('提交正常放行', app.cmds.filter(x => x.cmd === 'click' && x.x === 762).length, 1);
}

// ---------- 44) done 不许拿来"交差"（实测它看着记忆第一步就喊完事，一个动作都没做） ----------
{
  const app = makeApp({ chatReplies: [
    '{"action":"done","reason":"2801 题已提交并通过，任务已完成，无需再操作。"}',   // 嘴上完事
    '{"action":"click","target":"代码编辑器","x":500,"y":500}',                      // 被推回去后真动手
    '{"action":"done","reason":"已通过"}',
  ] });
  await sleep(10);
  await app.sandbox.runTask('把这道题做出来');

  const log = app.getEl('answer')._htmlHistory.join('\n');
  c.section('done 不许用来交差');
  c.ok('第一步就喊完事，被推回去', log.includes('推回去'), log.slice(-400));
  c.ok('并且指出它一个动作都没做', JSON.stringify(app.chats).includes('一个动作都还没执行'), '没指出它没动手');
  c.ok('推回去之后真的动手了', app.cmds.filter(x => x.cmd === 'click').length === 1, '还是没动手');
  c.eq('真做完之后才允许收工', app.stats.chatCalls, 3);
  c.eq('循环正常退出', app.run('agent.running'), false);
}
{
  // 实测原话："修复只需去掉缩进…下一步动作就是点第1行开头…就此停止并说明"
  // ——它是知道的，只是用 done 把话说完就停了。这种必须推回去让它去做。
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"代码编辑器","x":500,"y":500}',
    '{"action":"done","reason":"修复只需去掉外层缩进，下一步动作就是点第1行开头、再重新输入顶格版本。就此停止并说明。"}',
    '{"action":"type","target":"代码编辑器","text":"class Solution:","x":500,"y":500}',
    '{"action":"done","reason":"改完并提交通过"}',
  ] });
  await sleep(10);
  await app.sandbox.runTask('继续改这道题');

  const log = app.getEl('answer')._htmlHistory.join('\n');
  c.section('把"下一步"写在嘴里不给收工');
  c.ok('识别出它只是在描述下一步', log.includes('只是把下一步写在了嘴里'), log.slice(-400));
  c.ok('推回去之后真的去输入了', app.cmds.filter(x => x.cmd === 'type').length === 1, '还是没动手');
}
{
  // 推两次就够了——绝不能因为这条规则让它永远收不了工（那是变相卡死）
  const app = makeApp({ chatReplies: () => '{"action":"done","reason":"还需要先修一下缩进"}' });
  await sleep(10);
  await app.sandbox.runTask('一直想收工');
  c.section('推两次就放手');
  c.eq('最多推两次（不会卡死）', app.stats.chatCalls, 3);
  c.eq('循环正常退出', app.run('agent.running'), false);
}
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  await app.sandbox.runTask('看看提示词');
  const sys = app.chats[0].body.messages[0].content;
  c.section('提示词把这次的教训写进去了');
  c.ok('讲清了 done 的边界', sys.includes('done 是【收工信号】') && sys.includes('不要用 done 把话说完就停'), '没讲 done 的边界');
  c.ok('讲清了记忆不是免做理由', sys.includes('不代表这件事现在已经做完'), '没讲记忆的定位');
  c.ok('讲清了代码要一行一行敲、别做像素手术、别整段重贴',
    sys.includes('lineByLine') && sys.includes('一行一行敲') &&
    sys.includes('整段重贴') && sys.includes('class Solution:') && sys.includes('IndentationError'),
    '没讲代码编辑的规矩');
}

// ---------- 45) 写代码【强制】一行一行敲：模型不写 lineByLine 也照样逐行 ----------
{
  // 实测：提示词里写了"写代码一律用 lineByLine"，模型照样发
  // {"action":"type","target":"代码编辑器（已全选，整块替换…）"}、一个 lineByLine 都不写。
  // 别再靠嘴求它——这里由代码替它决定。
  const app = makeApp({ chatReplies: [
    '{"action":"type","target":"代码编辑器（已全选，整块替换）","text":"class Solution:\\n    def f(self):\\n        return 1","x":500,"y":500,"replace":false}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('把这题重写一遍');

  const t = app.cmds.filter(x => x.cmd === 'type')[0];
  const log = app.getEl('answer')._htmlHistory.join('\n');
  c.section('写代码强制逐行敲');
  c.ok('模型没写 lineByLine，代码还是走逐行', !!t && t.lineByLine === true, JSON.stringify(t));
  c.ok('而且默认不整段全选（不再"删掉整个文件重贴"）', !!t && t.clear !== true, JSON.stringify(t));
  c.ok('界面上明说了"正在一行一行敲"（否则像卡死）', log.includes('一行一行敲'), log.slice(-300));
}
{
  // 模型明确要整块替换时，全选仍然要做（否则新代码会盖在旧代码上面）
  const app = makeApp({ chatReplies: [
    '{"action":"type","target":"代码编辑器","text":"class Solution:\\n    pass","x":500,"y":500,"replace":true}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('整块替换');
  const t = app.cmds.filter(x => x.cmd === 'type')[0];
  c.section('要整块替换时仍然全选');
  c.eq('逐行敲 + 先全选', [t.lineByLine, t.clear], [true, true]);
}
{
  // 对照：普通填空也走逐字敲——答题页常禁粘贴，逐字敲才输得进（这才是默认）
  const app = makeApp({ chatReplies: [
    '{"action":"type","target":"填空题答案框","text":"1982年","x":470,"y":577}',
    DONE,
  ] });
  await sleep(10);
  await app.sandbox.runTask('填个空');
  const t = app.cmds.filter(x => x.cmd === 'type')[0];
  c.section('普通填空默认也逐字敲');
  c.eq('默认逐字敲、且不先全选', [t.lineByLine, t.clear], [true, false]);
}

// ---------- 45b) 同一段大文本整段重写：第二次只提醒，第三次停下问你 ----------
{
  // 实测（2026-10-18 超星作业框）：全选没选中编辑框时，每重写一次就多出一份内容，
  // 它却越写越急、写到 60 步。同样的整段内容重写两遍还没变，第三遍就直接停下问。
  const big = '第四章 信息率失真函数 思维导图\n' + '· 失真函数、平均失真、R(D) 的定义与性质\n'.repeat(10);
  const T = JSON.stringify({ action:'type', target:'富文本编辑区', text: big, x:500, y:600, replace:true });
  const app = makeApp({ chatReplies: [T, T, T, DONE] });
  await sleep(10);
  await app.sandbox.runTask('把这段整段重写');

  const log = app.getEl('answer')._htmlHistory.join('\n');
  c.section('同一段内容反复整段重写');
  c.eq('同样的重写只真的执行了 2 次', app.cmds.filter(x => x.cmd === 'type').length, 2);
  c.ok('第二次给了提醒', log.includes('同一段内容第 2 次整段重写'), log.slice(-500));
  c.ok('第三次停下问你', log.includes('同一段内容已经整段重写了 2 次'), log.slice(-500));
  c.eq('循环正常退出', app.run('agent.running'), false);
}

// ---------- 46) 一直翻腾：前几次只提醒，到第 10 次才停下问你（不再中途拦死） ----------
{
  // 实测那次 53 步里它自己滚了 31 次（最长连滚 15 次），全程在页面上翻腾。
  // 第 5 次起只提醒，不拦；第 10 次停下问你——那是问，不是判死。
  const S = '{"action":"scroll","direction":"down","amount":3}';
  let app;
  app = makeApp({ chatReplies: (i) => { if (i + 1 >= 8) app.requestStop(); return S; } });
  await sleep(10);
  await app.sandbox.runTask('一直往下滚');

  const scrolls = app.cmds.filter(x => x.cmd === 'scroll').length;
  c.section('连滚 5 次只提醒、不拦');
  c.eq('提了 8 次滚动，8 次都放行了', scrolls, 8);
  c.ok('第 5 次时提醒它换做法（切页签/用键盘）',
    JSON.stringify(app.chats).includes('连着朝') && JSON.stringify(app.chats).includes('Ctrl+F') &&
    JSON.stringify(app.chats).includes('页签'),
    '没有提醒');
}
{
  // 一直滚下去（用户不叫停）→ 第 10 次停下问你
  const S = '{"action":"scroll","direction":"down","amount":3}';
  const app = makeApp({ chatReplies: () => S });
  await sleep(10);
  await app.sandbox.runTask('滚个没完');

  const scrolls = app.cmds.filter(x => x.cmd === 'scroll').length;
  c.section('连滚 10 次才停下问你');
  c.eq('第 10 次没有真的滚出去，停在这儿了', scrolls, 9);
  c.ok('收尾是"停下来问你"，不是判死',
    app.getEl('answer').innerHTML.includes('停下来问你'), app.getEl('answer').innerHTML.slice(0, 300));
  c.ok('并告诉了你可以怎么继续（指路 / 按停止键）',
    app.getEl('answer').innerHTML.includes('指个路') && app.getEl('answer').innerHTML.includes('停止键'),
    app.getEl('answer').innerHTML.slice(0, 300));
}

// ---------- 46b) 来回滚（上上下下）也是空转：第 10 次停下问你 ----------
{
  // 实测（2026-10-18 超星作业框）：写完一大段答案后来回滚了 10 次"核对"，
  // 原来的守卫只数"同一方向"，上上下下每次都清零，完全拦不住。
  const app = makeApp({ chatReplies: (i) => '{"action":"scroll","direction":"' + (i % 2 ? 'down' : 'up') + '","amount":3}' });
  await sleep(10);
  await app.sandbox.runTask('来回滚动核对');

  const scrolls = app.cmds.filter(x => x.cmd === 'scroll').length;
  c.section('来回滚也算空转');
  c.eq('第 10 次没有真的滚出去，停在这儿了', scrolls, 9);
  c.ok('收尾说的是"来回滚也算"',
    app.getEl('answer').innerHTML.includes('来回滚也算'), app.getEl('answer').innerHTML.slice(-300));
  c.ok('第 6 次提醒过长文本不用反复核对',
    JSON.stringify(app.chats).includes('type 返回的 chars'), '没有提醒');
}

// ---------- 47) 理由里自己都说"没做完"，就不许收工 ----------
{
  // 实测原话（2801 题那次）："仍停留在执行出错页…我无法取得可靠落点，故在此说明停止。"
  const GIVEUP = '{"action":"done","reason":"当前页面仍停留在执行出错的提交结果页，编辑器里还残留缩进；要继续改代码需要真实编辑并重新提交，但我无法通过滚动或点击取得可靠落点，故在此说明停止。"}';
  const app = makeApp({ chatReplies: [
    '{"action":"click","target":"代码页签","x":800,"y":120}',
    GIVEUP,
    '{"action":"type","target":"代码编辑器","text":"class Solution:\\n    pass","x":500,"y":500,"replace":true}',
    '{"action":"done","reason":"改完并提交，已通过"}',
  ] });
  await sleep(10);
  await app.sandbox.runTask('重新做这道题');

  const log = app.getEl('answer')._htmlHistory.join('\n');
  c.section('自己说没做完就不许收工');
  c.ok('识别出"理由里自己都说没做完"', log.includes('理由里自己都说没做完'), log.slice(-400));
  c.ok('推回去之后真的去改代码了',
    app.cmds.filter(x => x.cmd === 'type').length === 1, '还是没改代码');
}

// ---------- 48) 每步告诉模型当前前台窗口 ----------
{
  const app = makeApp({ chatReplies: [CLICK_B, DONE] });
  await sleep(10);
  await app.sandbox.runTask('看看现在在哪个窗口');

  c.section('前台窗口信息');
  const text = String(app.chats[0].body.messages[1].content[0].text);
  c.ok('每步都带上了应用名和窗口标题',
    text.includes('【当前前台窗口】') && text.includes('Notepad') && text.includes('未命名 - 记事本'),
    text.slice(0, 500));
  c.ok('任务开始时把键盘焦点还回去', app.stats.restores >= 1, 'restoreFocus 没被调用');
}

// ---------- 49) 按键前焦点在助手身上：先还回去，再按 ----------
{
  let fgCalls = 0;
  const selfFg = { ok: true, hwnd: 999, pid: 1, app: 'electron', title: '助手', self: true };
  const appFg = { ok: true, hwnd: 111, pid: 222, app: 'Notepad', title: '未命名 - 记事本', self: false };
  const app = makeApp({
    chatReplies: ['{"action":"key","keys":"enter"}', DONE],
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      // 观察时是普通窗口；按键前检查发现焦点在助手身上；还回去之后又变回普通窗口。
      foregroundInfo: async () => {
        const seq = [appFg, selfFg, appFg, appFg];
        return seq[Math.min(fgCalls++, seq.length - 1)];
      },
    },
  });
  await sleep(10);
  await app.sandbox.runTask('按回车');

  c.section('按键前确认焦点');
  c.eq('焦点还回去之后真的按了键', app.cmds.filter(x => x.cmd === 'key').length, 1);
  c.ok('按键前调用过 restoreFocus', app.stats.restores >= 2, 'restores=' + app.stats.restores);
}

// ---------- 50) 焦点还不过去：按键不发，告诉模型先点窗口 ----------
{
  let fgCalls = 0;
  const selfFg = { ok: true, hwnd: 999, pid: 1, app: 'electron', title: '助手', self: true };
  const appFg = { ok: true, hwnd: 111, pid: 222, app: 'Notepad', title: '未命名 - 记事本', self: false };
  const app = makeApp({
    chatReplies: ['{"action":"key","keys":"enter"}', CLICK_B, DONE],
    dsh: {
      sources: async () => [{ id: 'screen:0:0', name: '屏幕' }],
      // 观察 #1 普通；按键检查 #2 助手；restore 后 #3 还是助手；下一步观察 #4 普通。
      foregroundInfo: async () => {
        const seq = [appFg, selfFg, selfFg, appFg];
        return seq[Math.min(fgCalls++, seq.length - 1)];
      },
      restoreFocus: async () => ({ ok: false }),
    },
  });
  await sleep(10);
  await app.sandbox.runTask('按回车但焦点在小球上');

  c.section('焦点拉不回来就不按键');
  c.eq('这一步没有发 key', app.cmds.filter(x => x.cmd === 'key').length, 0);
  c.eq('没有当成执行故障熔断', app.stats.chatCalls, 3);
  const hist = String(app.chats[1].body.messages[1].content[0].text);
  c.ok('模型被告知没有执行、先点窗口',
    hist.includes('没有执行') && hist.includes('键盘焦点') && hist.includes('先点一下目标窗口'),
    hist.slice(-700));
  c.eq('后面的点击照常执行', app.cmds.filter(x => x.cmd === 'click').length, 1);
  c.ok('收尾正常', app.getEl('answer').innerHTML.includes('题目都答完了'), app.getEl('answer').innerHTML.slice(-300));
}

c.done();
