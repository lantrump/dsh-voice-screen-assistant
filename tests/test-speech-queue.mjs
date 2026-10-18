// 语音链路：识别结果不丢句、状态行不被当成用户说的话、服务掉线有提示、设备切换生效。
// 以及推按键说话（PTT）：T 什么时候算说话、按住/松开的时序、任务期间的收话方式。
import { loadMain } from './lib/fake-electron.mjs';
import { createChecker } from './lib/check.mjs';

const { handlers, procs, sent, setWindowFocused } = loadMain();
const c = createChecker();
const speech = () => handlers['get-speech']();
const on = (name, ...args) => handlers[name]({}, ...args);
const micProcs = () => procs.filter(p => String(p.args[0]).endsWith('whisper_server.py'));
const hookProcs = () => procs.filter(p => String(p.args[0]).endsWith('ptt_hook.py'));

on('set-mic', true);
const A = micProcs()[0];
const H = hookProcs()[0];
c.eq('启动了一个语音子进程', micProcs().length, 1);
c.ok('同时挂上全局键盘钩子（只盯 T）', !!H && H.args.some(a => String(a).includes('ptt_hook')), JSON.stringify(H && H.args));

c.section('识别结果队列');
A.out('[sr] loading model...\n');
c.eq('服务状态行不当作识别结果', speech().items, []);
A.out('[BLANK_AUDIO]\n');
c.eq('whisper 的方括号标签不当作识别结果', speech().items, []);
A.out('你好\n世界\n');
c.eq('轮询间隔内的两句都不丢', speech().items, ['你好', '世界']);
c.eq('取走后队列清空', speech().items, []);
A.out('半句');
c.eq('残句不提前出队', speech().items, []);
A.out('说完了\n');
c.eq('跨数据块的一句能拼回', speech().items, ['半句说完了']);
A.out('一样\n一样\n');
c.eq('重复的同一句不再被吞', speech().items, ['一样', '一样']);

c.section('服务异常');
A.out('[fatal] cannot resolve input device\n');
c.eq('fatal 上报为错误原因', speech().micError, 'cannot resolve input device');
c.eq('进程还活着时 micAlive 为真', speech().micAlive, true);

c.section('任务期间：切成"按住 T 才收"');
on('set-speech-mode', 'ptt');
c.ok('告诉语音服务进入 ptt 模式', A.written.join('').includes('mode ptt\n'), A.written.join(''));
A.out('[ptt] listening\n');
A.out('先别点右边那个\n');
c.eq('按住 T 说的话照样进队列（任务期间当指示用）', speech().items, ['先别点右边那个']);
on('set-speech-mode', 'auto');
c.ok('任务结束恢复自动听', A.written.join('').includes('mode auto\n'), A.written.join(''));

c.section('T 键什么时候算说话');
H.out('[ready] vk=84\n');
A.out('[sr] ready (dev=1, sr=48000, thresh=0.0100)\n');
const lastAllow = () => {
  const a = H.written.filter(x => x === 'allow 1\n' || x === 'allow 0\n');
  return a.length ? a[a.length - 1] === 'allow 1\n' : null;
};
on('ptt-context', { active: true, taskRunning: false });
c.eq('进运行态 → T 是说话键', lastAllow(), true);
setWindowFocused(false);
c.eq('切到别的窗口也照样全局收音（不用先把助手切到前台）', lastAllow(), true);
setWindowFocused(true);
c.eq('回到助手窗口 → 还是说话键', lastAllow(), true);
on('ptt-context', { active: false, taskRunning: false });
c.eq('还没进运行态 → 不用 T 说话', lastAllow(), false);
on('ptt-context', { active: true, taskRunning: true });
c.eq('任务进行中：不管焦点/输入框，T 都是说话', lastAllow(), true);
setWindowFocused(false);
c.eq('  任务中切走窗口也照样是说话', lastAllow(), true);

c.section('按住 / 松开的时序');
const pttEvents = () => sent.filter(x => x.ch === 'ptt-state').map(x => x.payload);
H.out('down\n');
c.ok('按下 T：告诉语音服务开始这一段', A.written.join('').includes('ptt down\n'), A.written.join(''));
c.eq('界面立刻收到"正在听"', pttEvents().pop().held, true);
H.out('up\n');
c.ok('松开 T：结束这一段去转写', A.written.join('').includes('ptt up\n'), A.written.join(''));
c.eq('界面收到"松开"', pttEvents().pop().held, false);

c.section('独占状态');
H.out('down\n');
A.out('[sr] exclusive off: 设备忙\n');
c.eq('没抢到独占要让界面知道（会议可能听到）', pttEvents().pop().exclusive, false);
A.out('[sr] exclusive on\n');
c.eq('抢到独占也如实上报', pttEvents().pop().exclusive, true);
H.out('up\n');
A.out('[ptt] busy\n');
c.eq('界面显示"识别中"', pttEvents().pop().busy, true);
A.out('[ptt] idle\n');
c.eq('识别结束后提示收起', pttEvents().pop().busy, false);

c.section('一按就松 = 在别处打 t（误触）');
const evBeforeTap = pttEvents().length;
H.out('down\n');
H.out('tap\n');
c.ok('让语音服务把这段直接丢掉（不转写）', A.written.join('').includes('ptt cancel\n'), A.written.join(''));
c.eq('界面不显示"正在听"', pttEvents().pop().held, false);
c.eq('也不会显示"识别中"', pttEvents().slice(evBeforeTap).some(e => e.busy === true), false);
c.eq('没有产生任何识别结果', speech().items, []);

c.section('换麦克风');
c.eq('换之前只有一套服务', [micProcs().length, hookProcs().length], [1, 1]);
on('set-mic-device', 3);
c.eq('运行中换设备会重启语音服务和钩子', [micProcs().length, hookProcs().length], [2, 2]);
const B = micProcs().pop();
c.eq('新进程被报告为存活', speech().micAlive, true);
A.emit('exit', null);
c.eq('旧进程退出不影响新进程', speech().micAlive, true);
A.out('[ptt] busy\n');                 // 旧进程的残留状态也不能污染界面
c.eq('  旧进程的输出不再生效', pttEvents().pop().busy, false);
B.out('新麦克风说的话\n');
c.eq('新进程的识别正常进队列', speech().items, ['新麦克风说的话']);

c.section('停止');
on('set-mic', false);
c.eq('停止后标记为不在运行', speech().micAlive, false);
c.ok('键盘钩子也一起停掉', procs.every(p => p.killed), procs.map(p => p.killed).join(','));

c.done();
