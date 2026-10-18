// 动作层（"神经"）：归一化坐标换算、动作解析容错、动作执行路由。
import fs from 'node:fs';
import path from 'node:path';
import { loadRenderer, APP_DIR } from './lib/fake-dom.mjs';
import { createChecker } from './lib/check.mjs';

// 明确用 1920x1200 物理尺寸，验证换算基准是"物理像素"而不是截图像素
const app = loadRenderer({ screen: { w: 1920, h: 1200 } });
const c = createChecker();
const { parseAction, normToPx, doAction } = app.sandbox;
const cmds = app.cmds;

c.section('归一化坐标 -> 物理像素');
c.eq('0 映射到最左', normToPx(0, 1920), 0);
c.eq('1000 映射到最右', normToPx(1000, 1920), 1919);
c.eq('500 -> 960（横向）', normToPx(500, 1920), 960);
c.eq('500 -> 600（纵向）', normToPx(500, 1200), 600);
c.eq('负数越界夹到 0', normToPx(-100, 1920), 0);
c.eq('超过 1000 夹到最右', normToPx(1500, 1920), 1919);
c.eq('字符串数字也认', normToPx('281', 1920), 539);
await c.throws('非数字坐标报错', () => normToPx('abc', 1920), '不是数字');

c.section('动作解析容错');
c.eq('裸 JSON', parseAction('{"action":"click","target":"选项B","x":281,"y":168}').action, 'click');
c.eq('前后裹解释文字', parseAction('我决定点 B。{"action":"click","target":"B","x":1,"y":2} 就这样').target, 'B');
c.eq('裹在代码块里', parseAction('```json\n{"action":"scroll","direction":"down","amount":3}\n```').direction, 'down');
c.eq('动作名大小写不敏感', parseAction('{"action":"CLICK","target":"x","x":1,"y":2}').action, 'click');
await c.throws('没有 JSON', () => parseAction('我不知道该怎么办'), '没有 JSON 动作');
await c.throws('JSON 损坏', () => parseAction('{"action":"click",}'), '不是合法 JSON');
await c.throws('不认识的动作', () => parseAction('{"action":"fly"}'), '不认识的动作');
c.eq('纯数组里没有动作', (() => { try { parseAction('[1,2,3]'); return 'ok'; } catch(e) { return 'throw'; } })(), 'throw');
// 实测里真实发生过：动作后面又跟了一段话、甚至第二个 JSON —— 不能因此白费一步
const twoJson = '{"action":"click","target":"确定","x":1,"y":2} 等等，截图里没看到弹窗。重新看：{"action":"click","target":"x","x":3,"y":4}';
c.eq('动作后面又跟一个 JSON 也能解析出第一个', parseAction(twoJson).target, '确定');
c.ok('并明确标注忽略了多余的动作', parseAction(twoJson).__reason.includes('已忽略'), parseAction(twoJson).__reason);
await c.throws('click 缺 target', () => parseAction('{"action":"click","x":1,"y":2}'), 'target');
await c.throws('click 缺坐标', () => parseAction('{"action":"click","target":"B"}'), 'x/y');
await c.throws('type 缺 text', () => parseAction('{"action":"type","x":1,"y":2}'), 'text');
await c.throws('type 缺坐标被拒（否则焦点跑掉，粘贴会落空）', () => parseAction('{"action":"type","text":"你好"}'), 'x/y');
await c.throws('scroll 方向非法', () => parseAction('{"action":"scroll","direction":"斜着","amount":1}'), 'direction');
await c.throws('scroll 格数必须为正', () => parseAction('{"action":"scroll","direction":"down","amount":0}'), 'amount');
await c.throws('done 是终止信号，不可执行', () => doAction({ action: 'done' }), '无法执行');

c.section('边做边说（say 字段）');
cmds.length = 0;
app.getEl('answer').innerHTML = '';
await doAction(parseAction('{"action":"click","target":"B. 7","x":281,"y":168,"say":"f(3)=2×3+1=7，只有 B 符合"}'));
c.eq('带 say 的点击照样执行', cmds.length, 1);
c.ok('说明同时显示了出来', app.getEl('answer').innerHTML.includes('只有 B 符合'), app.getEl('answer').innerHTML.slice(0, 120));

cmds.length = 0;
app.getEl('answer').innerHTML = '（原样）';
await doAction(parseAction('{"action":"scroll","direction":"down","amount":1}'));
c.eq('不带 say 的动作不吭声', app.getEl('answer').innerHTML, '（原样）');

c.section('只说话不动手（say）—— agent 的回答通道');
cmds.length = 0;
const said = await doAction(parseAction('{"action":"say","text":"第 3 题选 B：f(3)=2×3+1=7"}'));
c.eq('say 不产生任何鼠标键盘指令', cmds.length, 0);
c.eq('say 回传说了什么', said.said, '第 3 题选 B：f(3)=2×3+1=7');

c.section('JSON 前的理由');
c.eq('理由被抽出来', parseAction('我认为选 B，因为代入得 7。{"action":"say","text":"x"}').__reason, '我认为选 B，因为代入得 7。');
c.eq('没有前缀时理由为空', parseAction('{"action":"say","text":"x"}').__reason, '');
c.eq('包在代码块里时理由不带反引号', parseAction('```json\n{"action":"say","text":"x"}\n```').__reason, '');
await c.throws('say 缺 text', () => parseAction('{"action":"say"}'), 'text');

c.section('工具调用风格的标记文本（实测 18 步里 5 步栽在这上面）');
// 样本是【真实运行里失败过的原文】，导出成固定素材，避免手写失真
const realFailed = fs.readFileSync(path.join(APP_DIR, 'tests', 'fixtures', 'failed-reply-02.txt'), 'utf8');
const pa = parseAction(realFailed);
c.ok('真实失败样本现在能解析出动作名', pa.action === 'scroll' || pa.action === 'click', pa.action);
c.eq('这条样本解析成 scroll', pa.action, 'scroll');
c.ok('参数取到了（不再整条丢掉）', pa.direction === 'down' || pa.direction === 'up', String(pa.direction));
c.eq('数字参数自动转成数字', typeof pa.amount, 'number');

c.section('动作别名（模型很自然会这么写，以前全被丢）');
c.eq('right-click -> 右键点击', parseAction('{"action":"right-click","target":"x","x":1,"y":2}').button, 'right');
c.eq('double -> 双击', parseAction('{"action":"double","target":"x","x":1,"y":2}').double, true);
c.eq('dblclick -> 双击', parseAction('{"action":"dblclick","target":"x","x":1,"y":2}').double, true);
c.eq('input -> type', parseAction('{"action":"input","text":"hi","x":1,"y":2}').action, 'type');
c.eq('write -> type', parseAction('{"action":"write","text":"hi","x":1,"y":2}').action, 'type');
c.eq('press -> key', parseAction('{"action":"press","keys":"enter"}').action, 'key');
c.eq('content 字段当成 text', parseAction('{"action":"type","content":"hi","x":1,"y":2}').text, 'hi');
c.eq('key 字段当成 keys', parseAction('{"action":"key","key":"enter"}').keys, 'enter');
c.eq('别名动作照样会做参数校验', (() => { try { parseAction('{"action":"double","target":"x"}'); return 'ok'; } catch(e){ return 'throw'; } })(), 'throw');

c.section('动作执行');
cmds.length = 0;
const r1 = await doAction(parseAction('{"action":"click","target":"选项B","x":281,"y":168}'));
c.eq('click 换算成物理像素', cmds[0], { cmd: 'click', x: 539, y: 201, button: 'left', double: false });
c.eq('click 回传人话描述与落点（px 供落点效果比对用）', r1, { target: '选项B', at: '(539,201)', px: [539, 201] });

cmds.length = 0;
await doAction(parseAction('{"action":"click","target":"菜单","x":500,"y":500,"button":"right","double":true}'));
c.eq('右键与双击透传', [cmds[0].button, cmds[0].double], ['right', true]);

c.section('组合点击（Ctrl/Shift 多选）');
c.eq('modifiers 原样透传', parseAction('{"action":"click","target":"文件A","x":10,"y":20,"modifiers":["ctrl"]}').modifiers, ['ctrl']);
c.eq('单个字符串也认，Control 归一化成 ctrl', parseAction('{"action":"click","target":"x","x":1,"y":2,"modifiers":"Control"}').modifiers, ['ctrl']);
c.eq('多个修饰键去重且保持顺序', parseAction('{"action":"click","target":"x","x":1,"y":2,"modifiers":["shift","ctrl","ctrl"]}').modifiers, ['shift', 'ctrl']);
await c.throws('未知修饰键被拒', () => parseAction('{"action":"click","target":"x","x":1,"y":2,"modifiers":["hyper"]}'), 'modifiers');
cmds.length = 0;
await doAction(parseAction('{"action":"click","target":"文件A","x":10,"y":20,"modifiers":["ctrl"]}'));
c.eq('执行时把修饰键带进指令', [cmds[0].cmd, cmds[0].modifiers], ['click', ['ctrl']]);
c.eq('人话描述里也写明组合键', app.sandbox.describeAction(parseAction('{"action":"click","target":"文件A","x":10,"y":20,"modifiers":["ctrl"]}')), 'ctrl + 点击「文件A」');
cmds.length = 0;
await doAction(parseAction('{"action":"click","target":"文件A","x":10,"y":20}'));
c.eq('不带修饰键时指令里没有这个字段（老行为不变）', 'modifiers' in cmds[0], false);

cmds.length = 0;
await doAction(parseAction('{"action":"type","target":"答案框","x":470,"y":577,"text":"1982年"}'));
c.eq('带坐标的 type 先点后打', cmds.map(x => x.cmd), ['click', 'type']);
c.eq('  先点到的位置', [cmds[0].x, cmds[0].y], [902, 692]);
c.eq('  再输入文本', cmds[1].text, '1982年');
c.eq('  默认走逐字敲，且不先全选（不整段覆盖）', [cmds[1].lineByLine, cmds[1].clear], [true, false]);
c.eq('  回报里带上落点，便于事后核对', (await doAction(parseAction('{"action":"type","target":"框","x":470,"y":577,"text":"x"}'))).at, '(902,692)');

cmds.length = 0;
const appended = await doAction(parseAction('{"action":"type","target":"框","x":470,"y":577,"text":"x","replace":false}'));
c.eq('明确要求追加时不覆盖', appended.replaced, false);
c.eq('  指令里 clear 为 false', cmds[cmds.length - 1].clear, false);

cmds.length = 0;
await doAction(parseAction('{"action":"scroll","direction":"down","amount":3}'));
c.eq('滚动前先把光标挪过去（滚轮事件发给鼠标底下的窗口）', cmds[0].cmd, 'move');
c.eq('  没给坐标时默认挪到屏幕中心', [cmds[0].x, cmds[0].y], [960, 600]);
c.eq('  然后才是滚轮', cmds[1], { cmd: 'scroll', dy: -360 });
c.eq('  全程没有点击', cmds.filter(x => x.cmd === 'click').length, 0);
cmds.length = 0;
await doAction(parseAction('{"action":"scroll","direction":"up","amount":1,"x":300,"y":400}'));
c.eq('给了坐标就把光标挪到那里', [cmds[0].x, cmds[0].y], [576, 480]);
c.eq('向上滚 1 格 = dy +120', cmds[1], { cmd: 'scroll', dy: 120 });
cmds.length = 0;
await doAction(parseAction('{"action":"scroll","direction":"right","amount":2}'));
c.eq('向右滚 2 格 = dx +240', cmds[1], { cmd: 'scroll', dx: 240 });
cmds.length = 0;
await doAction(parseAction('{"action":"scroll","direction":"left","amount":1}'));
c.eq('向左滚 1 格 = dx -120', cmds[1], { cmd: 'scroll', dx: -120 });

c.section('拖拽（滑块、拖放、拖选文字要用它）');
cmds.length = 0;
const dragged = await doAction(parseAction('{"action":"drag","target":"音量滑块","fromX":100,"fromY":500,"toX":400,"toY":500}'));
c.eq('换算成物理像素的起止点', cmds[0], { cmd: 'drag', fromX: 192, fromY: 600, toX: 768, toY: 600 });
c.eq('回报里带上起止点', dragged.at, '(192,600)->(768,600)');
await c.throws('drag 缺起止点被拒', () => parseAction('{"action":"drag","target":"滑块","fromX":1,"fromY":2}'), 'fromX/fromY/toX/toY');
await c.throws('drag 缺 target 被拒', () => parseAction('{"action":"drag","fromX":1,"fromY":2,"toX":3,"toY":4}'), 'target');

cmds.length = 0;
await doAction(parseAction('{"action":"key","keys":"enter"}'));
c.eq('按键透传', cmds[0], { cmd: 'key', keys: 'enter' });

c.section('打开程序/网址');
c.eq('open_app 解析', parseAction('{"action":"open_app","app":"Visual Studio Code"}').app, 'Visual Studio Code');
c.eq('launch 别名，name 字段也认', parseAction('{"action":"launch","name":"Notepad"}').app, 'Notepad');
c.eq('open_url 解析', parseAction('{"action":"open_url","url":"https://example.com"}').url, 'https://example.com');
c.eq('open-url 别名，target 字段也认', parseAction('{"action":"open-url","target":"http://a.b"}').url, 'http://a.b');
await c.throws('open_app 缺程序名', () => parseAction('{"action":"open_app"}'), 'app');
await c.throws('open_url 缺网址', () => parseAction('{"action":"open_url"}'), 'url');
await c.throws('open_url 拒绝 file://', () => parseAction('{"action":"open_url","url":"file:///C:/x.html"}'), 'http/https');
await c.throws('open_url 拒绝 javascript:', () => parseAction('{"action":"open_url","url":"javascript:alert(1)"}'), 'http/https');

const oldFg = { ok: true, hwnd: 10, pid: 1, app: 'explorer', title: '旧窗口', self: false };
let fgN = 0;
app.setForeground(() => (++fgN === 1 ? oldFg : { ok: true, hwnd: 20, pid: 2, app: 'Code', title: '新窗口', self: false }));
app.stats.openApps.length = 0;
const tOpen = Date.now();
const rOpen = await doAction(parseAction('{"action":"open_app","app":"Visual Studio Code"}'));
c.eq('open_app 交给主进程去启动', app.stats.openApps, ['Visual Studio Code']);
c.eq('回报匹配到的快捷方式名', rOpen.app, 'Visual Studio Code');
c.eq('等到了前台变化', rOpen.changed, true);
c.ok('不会傻等满 4 秒', Date.now() - tOpen < 2500, (Date.now() - tOpen) + 'ms');

let fgM = 0;
app.setForeground(() => (++fgM === 1 ? oldFg : { ok: true, hwnd: 10, pid: 1, app: 'chrome', title: '新标签页', self: false }));
app.stats.openUrls.length = 0;
const rUrl = await doAction(parseAction('{"action":"open_url","url":"https://example.com/a?b=1"}'));
c.eq('open_url 交给主进程', app.stats.openUrls, ['https://example.com/a?b=1']);
c.eq('浏览器句柄没变、标题变了也算打开成功', rUrl.changed, true);

const origOpenApp = app.dsh.openApp;
app.dsh.openApp = async () => ({ ok: false, error: '开始菜单里没有「Photoshop」的快捷方式' });
await c.throws('启动失败把原因交给模型', () => doAction(parseAction('{"action":"open_app","app":"Photoshop"}')), '开始菜单里没有');
app.dsh.openApp = origOpenApp;
app.setForeground({ ok: true, hwnd: 111, pid: 222, app: 'Notepad', title: '未命名 - 记事本', self: false });

const t0 = Date.now();
await doAction(parseAction('{"action":"wait","ms":60}'));
c.ok('wait 真的等了', Date.now() - t0 >= 55);

c.section('等待可被打断');
const t1 = Date.now();
setTimeout(() => app.run('agent.stop = true'), 120);
const w1 = await doAction(parseAction('{"action":"wait","ms":5000}'));
c.ok('按停后立刻结束，不等满 5 秒', Date.now() - t1 < 1000, (Date.now() - t1) + 'ms');
c.eq('回报里标明是被停止打断的', w1.stopped, true);
c.eq('仍回报原本要等的时长', w1.ms, 5000);
app.run('agent.stop = false');

const t1b = Date.now();
setTimeout(() => app.requestStop(), 120);           // 模拟全局热键：只置主进程标志，不直接置 agent.stop
const w2 = await doAction(parseAction('{"action":"wait","ms":5000}'));
c.ok('全局热键也能打断等待', Date.now() - t1b < 1000, (Date.now() - t1b) + 'ms');
c.eq('  并将 agent.stop 置位（后续循环会退出）', app.run('agent.stop'), true);
app.run('agent.stop = false');

const t2 = Date.now();
setTimeout(() => app.run('agent.stop = true'), 80);
c.eq('wait 有 10 秒上限', (await doAction(parseAction('{"action":"wait","ms":999999}'))).ms, 10000);
c.ok('上限路径同样能被打断', Date.now() - t2 < 1000, (Date.now() - t2) + 'ms');
app.run('agent.stop = false');
c.eq('屏幕尺寸只问一次（缓存生效）', app.stats.screenInfo, 1);

c.done();
