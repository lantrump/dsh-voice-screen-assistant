// 主进程与"手"（desktop_ctl.py）的协议对接：请求应答配对、超时、进程退出。
// 说明：Python 侧由 test_desktop_ctl.py 验证，这里验证中间这层。
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './lib/fake-electron.mjs';
import { APP_DIR } from './lib/fake-dom.mjs';
import { createChecker } from './lib/check.mjs';

const { handlers, procs } = loadMain();
const c = createChecker();
const input = (cmd) => handlers['agent-input']({}, cmd);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lastWritten = (p) => JSON.parse(p.written[p.written.length - 1]);

c.section('按需启动');
const p1 = input({ cmd: 'pos' });
c.eq('首次调用才启动控制进程', procs.length, 1);
c.eq('启动的是 desktop_ctl.py', path.basename(procs[0].args[0]), 'desktop_ctl.py');
c.eq('写出的第一条协议带 id=1', lastWritten(procs[0]), { id: 1, cmd: 'pos' });
procs[0].reply({ id: 1, ok: true, x: 160, y: 422 });
c.eq('应答被正确解析', await p1, { id: 1, ok: true, x: 160, y: 422 });

c.section('并发与分片');
const a = input({ cmd: 'pos' });
const b = input({ cmd: 'ping' });
c.eq('id 单调递增', [lastWritten(procs[0]).id - 1, lastWritten(procs[0]).id], [2, 3]);
procs[0].reply({ id: 3, ok: true, pong: 'B' });
procs[0].reply({ id: 2, ok: true, pong: 'A' });
c.eq('乱序应答：请求 2 拿到自己的结果', (await a).pong, 'A');
c.eq('乱序应答：请求 3 拿到自己的结果', (await b).pong, 'B');

const d = input({ cmd: 'pos' });
const line = JSON.stringify({ id: 4, ok: true, x: 7, y: 8 });
procs[0].out(line.slice(0, 10));
await sleep(20);
procs[0].out(line.slice(10) + '\n');
c.eq('被切成两半的 JSON 能拼回', (await d).x, 7);

c.section('脏输出与失败');
const e = input({ cmd: 'pos' });
procs[0].out('[ctl] 一些日志\n');
procs[0].out('完全不是 JSON 的内容\n');
let settled = false;
e.then(() => { settled = true; }, () => { settled = true; });
await sleep(30);
c.eq('非协议输出不会被误当成结果', settled, false);
procs[0].reply({ id: 5, ok: true, x: 1, y: 2 });
c.eq('之后仍能正常应答', (await e).y, 2);

const f = input({ cmd: 'click', x: 1, y: 1 });
procs[0].reply({ id: 6, ok: false, error: 'SendInput 只送出 0/2 个事件' });
let errMsg = '';
try { await f; } catch (err) { errMsg = err.message; }
c.eq('执行失败会拒绝并带出原因', errMsg, 'SendInput 只送出 0/2 个事件');

c.section('进程死亡与自愈');
const g = input({ cmd: 'pos' });
let gone = '';
g.catch(err => { gone = err.message; });
procs[0].emit('exit', 1);
await sleep(20);
c.ok('进程退出时挂起的请求被拒绝', gone.includes('桌面控制进程已退出'), '实际信息：' + gone);

const h = input({ cmd: 'pos' });
c.eq('退出后再调用会重新拉起', procs.length, 2);
procs[1].reply({ id: lastWritten(procs[1]).id, ok: true, x: 3, y: 4 });
c.eq('新进程可正常应答', (await h).x, 3);

c.section('热键选择');
{
  // 全部空闲：应该用首选组合，停止键是 Ctrl+Alt+Space
  const free = loadMain();
  const labels = free.handlers['hotkey-labels']();
  c.eq('首选停止键是 Ctrl+Alt+Space', labels.labels.stop, 'Ctrl+Alt+Space');
  c.eq('停止键注册成功', labels.ok.stop, true);
}
{
  // Ctrl+Alt+Space 被别的程序占了：应该降级，并把降级后的组合报出来
  const takenApp = loadMain({ takenHotkeys: ['Control+Alt+Space'] });
  const labels = takenApp.handlers['hotkey-labels']();
  c.eq('Space 被占时降级到 Ctrl+Alt+Q', labels.labels.stop, 'Ctrl+Alt+Q');
  c.eq('降级后停止键仍可用', labels.ok.stop, true);
}
{
  // 停止键的候选全被占：必须明确报 false，不能假装成功
  const allTaken = loadMain({ takenHotkeys: ['Control+Alt+Space', 'Control+Alt+Q', 'Control+Alt+Shift+Q', 'Control+Alt+F12'] });
  const labels = allTaken.handlers['hotkey-labels']();
  c.eq('候选全被占时如实报告不可用', labels.ok.stop, false);
  c.eq('不可用时不给假的组合名', labels.labels.stop, '');
}

c.section('从 Alt+Tab 里移除');
{
  const app = loadMain();
  app.emitWindow('ready-to-show');
  const p = app.procs.find(x => String(x.args[0]).endsWith('win_style.py'));
  c.ok('窗口显示时调起 win_style.py', !!p, JSON.stringify(app.procs.map(x => x.args[0])));
  c.ok('把本窗口 HWND 以 0x 开头传进去', /^0x[0-9a-f]+$/i.test(String(p && p.args[1])), String(p && p.args[1]));
}

c.section('截图分辨率');
{
  // 缩图会让小字和密集的行糊在一起，是"说点 B 却点到 A"这类错一行的根源
  const shot = loadMain({
    captureSources: [{
      id: 'screen:0:0', name: '整个屏幕',
      thumbnail: { toJPEG: () => Buffer.from([0xFF, 0xD8, 0xFF]), toDataURL: () => 'data:image/png;base64,AAAA' },
    }],
  });
  const r = await shot.handlers['capture']({}, {});
  c.eq('按物理分辨率截图（1536x960 逻辑 x1.25 = 1920x1200）', shot.captureCalls[0].thumbnailSize, { width: 1920, height: 1200 });
  c.eq('编码成 JPEG 以控制体积', r.dataUrl.slice(0, 23), 'data:image/jpeg;base64,');
  c.eq('截图时【不】隐藏助手窗口（隐藏会让窗口每步闪一下）', shot.winCalls.length, 0);
}

c.section('取证文件落盘');
{
  const app = loadMain();
  const runId = 'test_' + Date.now();
  const dir = path.join(APP_DIR, 'runs', runId);
  const r = app.handlers['run-artifact']({}, {
    run: runId, file: 'step-01', json: { hello: 'world' },
    dataUrl: 'data:image/jpeg;base64,' + Buffer.from([1, 2, 3]).toString('base64'),
  });
  c.eq('写入成功', r.ok, true);
  c.eq('json 落盘', fs.existsSync(path.join(dir, 'step-01.json')), true);
  c.eq('截图落盘', fs.existsSync(path.join(dir, 'step-01.jpg')), true);
  c.eq('json 内容正确', JSON.parse(fs.readFileSync(path.join(dir, 'step-01.json'), 'utf8')).hello, 'world');
  c.eq('截图字节还原正确', fs.readFileSync(path.join(dir, 'step-01.jpg')).length, 3);

  // 目录/文件名里的非法字符必须被过滤，不能穿越出去
  app.handlers['run-artifact']({}, { run: '.._evil', file: '../x', json: {} });
  c.eq('非法字符被删掉（.._evil -> _evil，../x -> x）', fs.existsSync(path.join(APP_DIR, 'runs', '_evil', 'x.json')), true);
  c.eq('没有写到 runs 目录外面', fs.existsSync(path.join(APP_DIR, 'evil')), false);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(APP_DIR, 'runs', '_evil'), { recursive: true, force: true });
  // 只清测试自己造的东西；runs/ 里可能有真实任务的取证数据，绝不能碰
  c.eq('测试造的目录清掉了', fs.existsSync(dir), false);
  c.eq('测试造的那个目录也清掉了', fs.existsSync(path.join(APP_DIR, 'runs', '_evil')), false);
  c.eq('真实任务的取证数据没被动过', fs.existsSync(path.join(APP_DIR, 'runs')), true);
}

c.section('落点效果比对');
{
  const app = loadMain();
  const rect = { x: 100, y: 100, w: 10, h: 10 };
  const same = app.handlers['image-diff']({}, { a: 'data:image/jpeg;base64,AA', b: 'data:image/jpeg;base64,AA', rect: rect });
  c.eq('两张一样的图：0 个像素不同', same.changedPixels, 0);
  c.eq('总像素数就是裁剪区域的像素数', same.totalPixels, 100);

  const diff = app.handlers['image-diff']({}, { a: 'data:image/jpeg;base64,AA', b: 'data:image/jpeg;base64,Az', rect: rect });
  c.eq('内容差别大：整块都算不同', diff.changedPixels, 100);

  c.eq('图解码不出来时如实报错，不假装没变化', app.handlers['image-diff']({}, { a: '', b: '' }).ok, false);
}

c.section('截图里标出鼠标位置');
{
  // 模型看不到系统光标，只能靠画进图里的这个箭头知道用户"指着哪"
  const cursorPoint = { x: 300, y: 200 };
  const app = loadMain({
    cursorPoint,
    captureSources: [{
      id: 'screen:0:0', name: '整个屏幕',
      thumbnail: {
        getSize: () => ({ width: 1920, height: 1200 }),
        toBitmap: () => Buffer.alloc(1920 * 1200 * 4),
        toJPEG: () => Buffer.from('RAW'),
        toDataURL: () => 'data:image/png;base64,RAW',
      },
    }],
  });
  const r = await app.handlers['capture']({}, {});
  c.eq('整屏截图仍然编码成 JPEG', r.dataUrl.slice(0, 23), 'data:image/jpeg;base64,');
  c.eq('截图走后处理（createFromBuffer 收到了画过指针的位图）', app.imageBuffers.length, 1);
  const bmp = app.imageBuffers[0];
  let painted = 0;
  // 逻辑坐标 (300,200) × 1.25 = 物理坐标 (375,250)：截图是物理像素，必须按这个画
  for (let y = 230; y < 300; y++) {
    for (let x = 355; x < 420; x++) if (bmp[(y * 1920 + x) * 4 + 3]) painted++;
  }
  c.ok('光标附近确实画上了东西', painted > 50, 'painted=' + painted);
  c.eq('按物理像素画（逻辑坐标原点上没有箭头）', bmp[(200 * 1920 + 300) * 4 + 3], 0);
  c.eq('远离光标的地方没被动', bmp[(800 * 1920 + 1000) * 4 + 3], 0);
}
{
  // 窗口截图是窗口局部坐标，不能把屏幕坐标的鼠标画上去
  const app = loadMain({
    captureSources: [{
      id: 'window:123:0', name: '记事本',
      thumbnail: {
        getSize: () => ({ width: 800, height: 600 }),
        toBitmap: () => Buffer.alloc(800 * 600 * 4),
        toJPEG: () => Buffer.from('RAW'),
        toDataURL: () => 'data:image/png;base64,RAW',
      },
    }],
  });
  const r = await app.handlers['capture']({}, { sourceId: 'window:123:0' });
  c.eq('窗口截图不画鼠标', app.imageBuffers.length, 0);
  c.eq('  原样编码', Buffer.from(r.dataUrl.split(',')[1], 'base64').toString(), 'RAW');
}

c.section('被观察窗口的发光边框');
{
  const app = loadMain();
  app.handlers['ptt-context']({}, { active: true, taskRunning: true, textInput: false });
  const p = app.handlers['foreground-info']({});
  c.eq('前台查询写进了控制进程', JSON.parse(app.procs[0].written[0]).cmd, 'foreground');
  app.procs[0].reply({ id: 1, ok: true, hwnd: 4242, pid: 777, app: 'notepad',
    title: '计算器 - 记事本', class: 'Notepad', rect: { x: 200, y: 100, w: 800, h: 600 } });
  const info = await p;
  c.eq('前台信息照旧返回', [info.ok, info.app, info.self], [true, 'notepad', false]);

  const obs = app.windows[1];
  c.ok('任务中多了一个观察框窗口', !!obs && app.windows.length === 2, 'windows=' + app.windows.length);
  c.eq('框的位置按逻辑像素换算并留边（200/1.25-6=154，800/1.25+12=652）', obs.bounds,
    { x: 154, y: 74, width: 652, height: 492 });
  c.eq('框点击穿透（不妨碍用户点里面的东西）', obs.ignoreMouse, true);
  c.eq('框被排除在抓屏之外', obs.contentProtected, true);
  c.eq('显示时不抢焦点', obs.shown, 1);
  c.ok('标签写明是哪个应用的哪个窗口', obs.js.join('').includes('notepad · 计算器 - 记事本'), obs.js.join(''));

  app.handlers['ptt-context']({}, { active: true, taskRunning: false, textInput: false });
  c.eq('任务结束立刻收起', obs.hidden, 1);

  // 前台是助手自己时不画框（框住小球没有意义，而且小球本来就不在截图里）
  app.handlers['ptt-context']({}, { active: true, taskRunning: true, textInput: false });
  const q = app.handlers['foreground-info']({});
  app.procs[0].reply({ id: 2, ok: true, hwnd: 99, pid: process.pid, app: 'electron',
    title: '助手', class: 'Chrome_WidgetWin_1', rect: { x: 0, y: 0, w: 400, h: 600 } });
  await q;
  c.eq('  自己没有重新弹出来', obs.shown, 1);
  c.eq('  而且把已有框收起了', obs.hidden, 2);
}

c.section('open_app 优先激活已开着的窗口');
{
  const app = loadMain();
  const p = app.handlers['open-app']({}, 'Notepad');
  c.eq('先问桌面控制进程有没有现成窗口', JSON.parse(app.procs[0].written[0]),
    { id: 1, cmd: 'activate', app: 'Notepad' });
  app.procs[0].reply({ id: 1, ok: true, activated: true, app: 'notepad', title: '无标题 - 记事本' });
  const r = await p;
  c.eq('切过去而不是再开一个副本', r,
    { ok: true, activated: true, matched: 'notepad', title: '无标题 - 记事本' });
  c.eq('没有启动任何新程序', app.openPaths.length, 0);

  const p2 = app.handlers['open-app']({}, '__no_such_app_9527__');
  app.procs[0].reply({ id: 2, ok: true, activated: false });
  const r2 = await p2;
  c.eq('没有现成窗口时仍然走开始菜单（这里本来就没有）', r2.ok, false);
  c.eq('  确实没有乱启动东西', app.openPaths.length, 0);
}

c.section('中文指令的编码（中文打进去变乱码就是这个坑）');
{
  const app = loadMain();                       // 单独一个实例，别和前面的 procs 混
  const p = app.handlers['agent-input']({}, { cmd: 'type', text: '计算智能' });
  c.eq('启动 python 时强制 UTF-8（双保险）',
    [app.procs[0].opts.env.PYTHONUTF8, app.procs[0].opts.env.PYTHONIOENCODING], ['1', 'utf-8']);
  c.eq('写入的 JSON 里中文原样带过去', JSON.parse(app.procs[0].written[0]).text, '计算智能');
  app.procs[0].reply({ id: 1, ok: true, chars: 4 });
  await p;
}

c.section('默认就是"按住 T 才收"');
{
  const app = loadMain();
  app.handlers['set-mic']({}, true);                 // 开麦 → 起一个 whisper 进程（同时挂键盘钩子）
  const mic = app.procs.find(p => String(p.args[0]).endsWith('whisper_server.py'));
  mic.out('第一句话\n');
  c.eq('开麦时就告诉 python 用 ptt（不用等任务开始）', mic.written, ['mode ptt\n']);
  c.eq('正常时能收到识别结果', app.handlers['get-speech']({}).items, ['第一句话']);

  c.eq('再切 ptt 仍然如实回报', app.handlers['set-speech-mode']({}, 'ptt').mode, 'ptt');
  c.eq('确实往 whisper 进程又写了一次 mode ptt', mic.written, ['mode ptt\n', 'mode ptt\n']);
  mic.out('按住 T 说的一句话\n');
  c.eq('ptt 下按住 T 说的这句仍然进队（给任务当指示）',
    app.handlers['get-speech']({}).items, ['按住 T 说的一句话']);
  c.eq('并且如实回报当前模式', app.handlers['get-speech']({}).mode, 'ptt');

  app.handlers['set-speech-mode']({}, 'auto');
  c.eq('显式切回自动听时写 mode auto', mic.written, ['mode ptt\n', 'mode ptt\n', 'mode auto\n']);
  mic.out('恢复之后这句话要收到\n');
  c.eq('恢复后立刻能收到', app.handlers['get-speech']({}).items, ['恢复之后这句话要收到']);
}
{
  // 任务还在跑的时候换麦克风：新进程必须一上来就是 ptt
  const app = loadMain();
  app.handlers['set-mic']({}, true);
  app.handlers['set-speech-mode']({}, 'ptt');
  app.handlers['set-mic-device']({}, 7);             // 换设备 → 重启服务
  const mics = app.procs.filter(p => String(p.args[0]).endsWith('whisper_server.py'));
  const fresh = mics[mics.length - 1];
  c.ok('换设备后新起的语音进程立刻就是 ptt',
    fresh !== mics[0] && fresh.written.indexOf('mode ptt\n') >= 0,
    JSON.stringify(fresh.written));
}

c.section('agent 点击时助手浮窗强制穿透');
{
  // 实测（2026-10-18）：答案栏压在超星右上角「提交」上。截图里看不到助手，
  // 但鼠标移动过去时渲染层会把窗口切成"可交互"，下一次点击就被助手自己接住了。
  const app = loadMain();
  const win = app.windows[0];
  app.handlers['set-ignore-mouse']({}, false);       // 模拟"鼠标停在答案栏上"
  c.eq('平时鼠标在面板上时窗口可交互', win.ignoreMouse, false);

  const p = app.handlers['agent-input']({}, { cmd: 'click', x: 1846, y: 122 });
  c.eq('点击发出时窗口立刻切成点击穿透', win.ignoreMouse, true);

  app.handlers['set-ignore-mouse']({}, false);       // 鼠标还在面板上，渲染层要求恢复交互
  c.eq('穿透期间渲染层改不回交互', win.ignoreMouse, true);

  app.procs[0].reply({ id: 1, ok: true, x: 1846, y: 122 });
  c.eq('点击请求正常结束', (await p).ok, true);

  app.handlers['ptt-context']({}, { active: true, taskRunning: false, textInput: false });
  c.eq('任务停了（暂停/停止）立刻恢复可交互，窗口拖得动', win.ignoreMouse, false);
}

c.done();
