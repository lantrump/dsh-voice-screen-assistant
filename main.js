const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const annotate = require('./lib/annotate');
const { findShortcut } = require('./startmenu');

let win;
let apiKey = null;
let micProc = null;      // Python Whisper 服务子进程
let micOn = false;
let micDevice = null;    // 用户选定的输入设备 id
let speechQueue = [];    // 未读识别结果（渲染层轮询取走，避免两次识别挤在同一轮询间隔时丢句）
let speechSeq = 0;       // 识别结果累计条数
let speechMode = 'ptt';    // ptt=只有按住 T 才收（默认，任务内外都一样）；auto=一直听（保留给调试）
let micReady = false;    // whisper 模型已加载，可以收话
let micError = "";       // 语音服务最后的致命错误
let micErrBuf = "";      // stderr 尾部，用于进程异常退出时给出原因
let micExclusive = null; // 最近一次按住 T 是否真的独占了麦克风（null=还没试过）

/* 推按键说话（PTT）：ptt_hook.py 只盯 T 一个键。
   什么时候吞掉 T 由这里决定——任务进行中一律算说话；空闲时只有助手窗口在前台、
   而且没在输入框里打字才算。其余时候 T 原样放行，该怎么打字怎么打字。 */
let pttProc = null;      // 键盘钩子进程
let pttReady = false;    // 钩子已挂上
let pttHeld = false;     // 正按着 T
let pttBusy = false;     // 松开后正在转写
let pttAllowed = false;  // 当前是否把 T 当说话键
let pttContext = { active: false, taskRunning: false };   // 渲染层报上来的状态
let obsWin = null;       // 任务期间围住"正在看的那个窗口"的发光框
/* 点击穿透的状态：渲染层按鼠标悬停决定要不要接收点击，但 agent 自己点/滚的时候
   必须强制整窗穿透——否则面板压在提交按钮上，截图中看不见助手，鼠标却点到了助手自己。 */
let mouseWantIgnore = true;   // 渲染层最近一次希望的状态
let mousePassUntil = 0;       // 这之前强制穿透，渲染层改不回去

function createWindow() {
  win = new BrowserWindow({
    width: 400, height: 600, minWidth: 360, minHeight: 480,
    frame: false, alwaysOnTop: true, transparent: true, resizable: false, hasShadow: false,
    skipTaskbar: true,   // 任务栏按钮别人在共享画面里看得见（标题会暴露），直接不显示
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // 只留在你眼前的屏幕上：截图、录屏、桌面共享都抓不到这个窗口（WDA_EXCLUDEFROMCAPTURE），
  // 助手给自己截图时也就不会看见自己的面板。
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'renderer.html'));
  win.setAlwaysOnTop(true, 'screen-saver');   // 最高置顶级别
  win.on('focus', updatePttAllow);
  win.on('blur', updatePttAllow);
  win.on('ready-to-show', () => hideFromAltTab(win));
  // 主窗口没了，观察框也必须一起走；否则它会一直留在屏幕上，"所有窗口都关了"也永远不触发。
  win.on('closed', destroyObservation);
}

/* 任务栏靠 skipTaskbar，但 Alt+Tab 仍会露一个空白预览和窗口标题。
   Electron 没暴露改扩展样式的接口，交给 python/ctypes 加 WS_EX_TOOLWINDOW。 */
function hideFromAltTab(w) {
  try {
    if (!w || w.isDestroyed()) return;
    const h = w.getNativeWindowHandle();
    if (!h || !h.length) return;
    const hwnd = h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0));
    const proc = spawn(pythonCmd(), [path.join(__dirname, 'win_style.py'), '0x' + hwnd.toString(16)], { cwd: __dirname, stdio: 'ignore' });
    proc.on('error', () => {});
    proc.on('exit', (code) => { if (code) console.error('[style] 从 Alt+Tab 移除失败（code ' + code + '）'); });
  } catch (e) {}
}

/* ===== 观察框：任务进行中，把 agent 正在看的那个窗口圈出来 =====
   目的：用户能一眼看见"它现在在看哪个窗口"，而不是从流水账里猜。
   它本身是一块透明、点击穿透、且被排除在抓屏之外的置顶窗口——
   既不挡用户操作，也不会出现在 agent 自己每步看到的截图里。 */
const OBS_FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>'
  + 'html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;'
  + 'font-family:"Microsoft YaHei UI",system-ui,sans-serif;-webkit-user-select:none;user-select:none}'
  + '#frame{position:absolute;left:3px;top:3px;right:3px;bottom:3px;border-radius:10px;'
  + 'border:2px solid rgba(125,200,255,.95);'
  + 'box-shadow:0 0 14px 4px rgba(80,160,255,.55),inset 0 0 12px 3px rgba(80,160,255,.30)}'
  + '#label{position:absolute;left:12px;top:10px;max-width:calc(100% - 24px);'
  + 'padding:3px 10px;border-radius:9px;background:rgba(20,40,80,.82);color:#dff0ff;'
  + 'font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
  + 'box-shadow:0 0 8px rgba(80,160,255,.6)}'
  + '</style></head><body><div id="frame"></div><div id="label"></div></body></html>';

function obsFrameWindow() {
  if (obsWin && !obsWin.isDestroyed()) return obsWin;
  obsWin = new BrowserWindow({
    width: 240, height: 160, frame: false, transparent: true, resizable: false,
    movable: false, minimizable: false, maximizable: false, focusable: false,
    skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  obsWin.setAlwaysOnTop(true, 'screen-saver');
  obsWin.setIgnoreMouseEvents(true, { forward: true });   // 点击穿透：框住了也不能妨碍用户点里面的东西
  obsWin.setContentProtection(true);                      // 框本身不进截图，否则每步图里都多一圈发光边
  obsWin.on('ready-to-show', () => hideFromAltTab(obsWin));
  obsWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OBS_FRAME_HTML));
  obsWin.on('closed', () => { obsWin = null; });
  return obsWin;
}

/* 窗口矩形是物理像素，BrowserWindow.setBounds 要逻辑像素（DIP），得按缩放比换。 */
function observationBounds(rect) {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  const pad = 6;
  return {
    x: Math.round(Number(rect.x) / sf) - pad,
    y: Math.round(Number(rect.y) / sf) - pad,
    width: Math.max(80, Math.round(Number(rect.w) / sf) + pad * 2),
    height: Math.max(60, Math.round(Number(rect.h) / sf) + pad * 2),
  };
}

function showObservation(info) {
  const r = info && info.rect;
  if (!r || !(Number(r.w) > 0) || !(Number(r.h) > 0)) { hideObservation(); return; }
  const w = obsFrameWindow();
  try { w.setBounds(observationBounds(r)); } catch(e) {}
  try { w.showInactive(); } catch(e) {}                  // showInactive：不许把焦点从目标窗口抢走
  const label = [info.app, info.title].filter(Boolean).join(' · ').slice(0, 90) || '正在观察';
  try {
    const ret = w.executeJavaScript('document.getElementById("label").textContent = '
      + JSON.stringify(label) + ';', true);
    if (ret && typeof ret.catch === 'function') ret.catch(() => {});
  } catch(e) {}
}
function hideObservation() {
  if (obsWin && !obsWin.isDestroyed()) { try { obsWin.hide(); } catch(e) {} }
}
function destroyObservation() {
  const w = obsWin; obsWin = null;
  if (w && !w.isDestroyed()) { try { w.destroy(); } catch(e) {} }
}

function pythonCmd() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const cands = [
    'F:\\miniconda3\\python.exe',
    'C:\\ProgramData\\miniconda3\\python.exe',
    path.join(process.env.USERPROFILE || '', 'miniconda3', 'python.exe'),
  ];
  for (const p of cands) { if (p && fs.existsSync(p)) return p; }
  return 'python';
}

function startMic() {
  if (micProc) return;
  const script = path.join(__dirname, 'whisper_server.py');
  const micArgs = micDevice != null ? [script, String(micDevice)] : [script];  // 界面选了就用它，否则系统默认
  const proc = spawn(pythonCmd(), micArgs, { cwd: __dirname });
  micProc = proc; micOn = true; micError = ""; micErrBuf = ""; micReady = false; pttBusy = false; micExclusive = null;
  if (speechMode !== 'auto') sendMic('mode ' + speechMode);   // 任务还在跑时换麦克风：新进程也直接是"按住 T 才收"
  const buf = [];
  proc.stdout.on('data', (d) => {
    if (micProc !== proc) return;        // 旧进程被换掉后的残留输出不再生效
    buf.push(d.toString());
    let s = buf.join(''); let i;
    while ((i = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, i).trim(); s = s.slice(i + 1);
      if (!line) continue;
      if (line.startsWith('[')) {          // [sr]/[err]/[fatal]/[paused]/[ptt] 是服务状态，不能当成识别结果
        if (line.startsWith('[fatal]')) micError = line.slice(7).trim();
        if (line.startsWith('[sr] ready')) { micReady = true; updatePttAllow(); }
        // 独占成功/失败要在界面说清楚：失败时会议那边照样能听到，不能让用户以为被屏蔽了
        if (line === '[sr] exclusive on') { micExclusive = true; notifyPtt(); }
        else if (line.startsWith('[sr] exclusive off')) { micExclusive = false; notifyPtt(); }
        if (line.startsWith('[ptt]')) {
          pttBusy = line.slice(5).trim() === 'busy';
          notifyPtt();
        }
        continue;
      }
      speechQueue.push(line); speechSeq++;
      if (speechQueue.length > 20) speechQueue.shift();
    }
    buf.length = 0; buf.push(s);
  });
  proc.stderr.on('data', (d) => { micErrBuf = (micErrBuf + d.toString()).slice(-2000); });
  proc.on('error', (err) => {              // python 不存在等启动失败
    if (micProc !== proc) return;
    micProc = null; micOn = false; micReady = false; pttBusy = false;
    micError = 'Python 启动失败：' + (err && err.message ? err.message : err);
    updatePttAllow(); notifyPtt();
  });
  proc.on('exit', (code) => {
    if (micProc !== proc) return;          // 已被 stopMic 或新进程取代，不要动新进程
    micProc = null; micOn = false; micReady = false; pttBusy = false;
    if (!micError && code) {
      const tail = micErrBuf.trim().split('\n').filter(Boolean).pop();
      micError = tail ? tail.slice(0, 200) : ('语音服务异常退出（code ' + code + '）');
    }
    updatePttAllow(); notifyPtt();
  });
  startPttHook();
}
function stopMic() {
  const proc = micProc; micProc = null;    // 先摘引用，旧进程的 exit 就不会误伤后续启动的进程
  if (proc) { try { proc.kill(); } catch(e){} }
  micOn = false; micReady = false; speechQueue = []; micError = ""; micErrBuf = "";
  stopPttHook();
}

function sendMic(cmd) {
  const proc = micProc;
  if (proc && proc.stdin && proc.stdin.writable !== false) {
    try { proc.stdin.write(cmd + '\n'); } catch(e){}
  }
}

/* ===== 推按键：键盘钩子 ===== */
function startPttHook() {
  if (pttProc) return;
  const script = path.join(__dirname, 'ptt_hook.py');
  const proc = spawn(pythonCmd(), [script], { cwd: __dirname });
  pttProc = proc; pttReady = false; pttHeld = false; pttAllowed = false;
  let buf = '';
  proc.stdout.on('data', (d) => {
    if (pttProc !== proc) return;        // 旧钩子被换掉后的残留输出不再生效
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      if (line.startsWith('[ready]')) { pttReady = true; updatePttAllow(); }
      else if (line === 'down') { pttHeld = true; micExclusive = null; sendMic('ptt down'); notifyPtt(); }
      else if (line === 'up') { pttHeld = false; sendMic('ptt up'); pttBusy = !!micProc; notifyPtt(); }
      // 一按就松 = 在别处打 t：丢掉这段音频，别让 whisper 把键声转成"没听清楚"
      else if (line === 'tap') { pttHeld = false; sendMic('ptt cancel'); notifyPtt(); }
    }
  });
  proc.stderr.on('data', (d) => {
    const t = d.toString().trim();
    if (t) console.error('[ptt] ' + t);
  });
  const dead = () => {
    if (pttProc !== proc) return;
    pttProc = null; pttReady = false; pttAllowed = false;
    if (pttHeld) { pttHeld = false; pttBusy = false; sendMic('ptt up'); }
    console.error('[ptt] 键盘钩子已退出，按住 T 说话不可用');
    notifyPtt();
  };
  proc.on('error', dead);
  proc.on('exit', dead);
}
function stopPttHook() {
  const proc = pttProc; pttProc = null; pttReady = false; pttAllowed = false;
  if (proc) { try { proc.kill(); } catch(e){} }
  if (pttHeld) { pttHeld = false; sendMic('ptt up'); }   // 钩子没了也要把这段结束掉
  pttBusy = false;
  notifyPtt();
}
function pttAllowedNow() {
  if (!pttProc || !pttReady || !micProc || !micReady) return false;
  // 运行态下 T 一律是说话：不用先切回助手窗口，任务内外都一样。
  // 运行态只有状态条和答案栏，没有输入框，不存在"在助手里打 t"的情况。
  return !!pttContext.active;
}
function updatePttAllow() {
  const next = pttAllowedNow();
  if (next === pttAllowed) return;
  pttAllowed = next;
  const proc = pttProc;
  if (proc && proc.stdin && proc.stdin.writable !== false) {
    try { proc.stdin.write((next ? 'allow 1' : 'allow 0') + '\n'); } catch(e){}
  }
  notifyPtt();
}
function notifyPtt() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('ptt-state', {
      held: pttHeld, busy: pttBusy, allowed: pttAllowed, mode: speechMode, exclusive: micExclusive,
    });
  } catch(e){}
}

/* ptt：没按 T 的音频由 python 直接丢掉（不是"识别出来再忽略"）。
   默认就是 ptt，任务开始/结束都不再切换——不按 T 永远收音。 */
function setSpeechMode(mode) {
  speechMode = mode === 'ptt' ? 'ptt' : 'auto';
  sendMic('mode ' + speechMode);
  notifyPtt();
  return { mode: speechMode };
}

/* ===== 桌面操作执行器（agent 的"手"）：desktop_ctl.py，按需启动 ===== */
let ctlProc = null, ctlSeq = 0, ctlPending = new Map(), ctlErrBuf = "";
let stopRequested = false;      // 全局热键置位，由 agent 循环取走
// 用户最近一个"不是助手自己"的前台窗口。任务开始时把键盘焦点还给它，
// 否则第一步若是纯按键（回车/Ctrl+C），会打到助手自己的输入框里。
let lastOtherForeground = null;
let fgSampling = false, fgRetryAt = 0;

/* 全局热键：agent 自己动鼠标时，这是唯一不抢焦点、随时能干预的手段。
   但热键会被别的程序先抢走（Windows 是先到先得），所以给一串候选挨个试，
   并把真正生效的组合告诉界面——否则用户按了没反应，还以为是按错了。 */
const HOTKEY_CANDIDATES = {
  stop:  ['Control+Alt+Space', 'Control+Alt+Q', 'Control+Alt+Shift+Q', 'Control+Alt+F12'],
};
const hotkeyLabels = { stop: '' };
const hotkeyOk = { stop: false };
const hotkeyActions = {
  stop: () => { stopRequested = true; },
};

function registerHotkeys() {
  for (const name of ['stop']) {
    for (const acc of HOTKEY_CANDIDATES[name]) {
      let ok = false;
      try { ok = globalShortcut.register(acc, hotkeyActions[name]); } catch (e) { ok = false; }
      if (ok) { hotkeyOk[name] = true; hotkeyLabels[name] = acc.replace(/Control/g, 'Ctrl'); break; }
    }
    if (!hotkeyOk[name]) console.error('热键全部候选都被占用：' + name + ' -> ' + HOTKEY_CANDIDATES[name].join(' / '));
  }
  console.log('[hotkeys] ' + JSON.stringify(hotkeyLabels));
}

function startCtl() {
  if (ctlProc) return ctlProc;
  const script = path.join(__dirname, 'desktop_ctl.py');
  // PYTHONUTF8/PYTHONIOENCODING：双保险。python 那边也显式包了 UTF-8，
  // 但万一以后改动漏了，这两个环境变量能让它默认就走 UTF-8，中文不会变乱码。
  const env = Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  const proc = spawn(pythonCmd(), [script], { cwd: __dirname, env: env });
  ctlProc = proc; ctlErrBuf = "";
  const buf = [];
  proc.stdout.on('data', (d) => {
    buf.push(d.toString());
    let s = buf.join(''); let i;
    while ((i = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, i).trim(); s = s.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch(e) { continue; }   // 不是协议 JSON 就忽略，绝不误当结果
      const p = ctlPending.get(msg.id);
      if (!p) continue;
      ctlPending.delete(msg.id);
      // 管理员窗口拦下不是故障，而是一条结果：原样 resolve 给 renderer，
      // 让它当成"这一步没执行"的观察继续循环（reject 会把 code/window 丢在 IPC 边界上）。
      if (msg.ok || msg.code === 'elevated') p.resolve(msg);
      else p.reject(new Error(msg.error || '桌面操作失败'));
    }
    buf.length = 0; buf.push(s);
  });
  proc.stderr.on('data', (d) => { ctlErrBuf = (ctlErrBuf + d.toString()).slice(-2000); });
  const failAll = (err) => {
    if (ctlProc !== proc) return;          // 已被 stopCtl 或新进程取代
    ctlProc = null;
    for (const p of ctlPending.values()) p.reject(err);
    ctlPending.clear();
  };
  proc.on('error', (e) => failAll(new Error('桌面控制启动失败：' + (e && e.message ? e.message : e))));
  proc.on('exit', (code) => {
    const tail = ctlErrBuf.trim().split('\n').filter(Boolean).pop();
    failAll(new Error('桌面控制进程已退出' + (code ? '（code ' + code + '）' : '') + (tail ? '：' + tail.slice(0, 200) : '')));
  });
  return proc;
}

function ctlSend(cmd, timeoutMs = 10000) {
  const proc = startCtl();
  const id = ++ctlSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ctlPending.delete(id); reject(new Error('桌面操作超时：' + cmd.cmd)); }, timeoutMs);
    ctlPending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
    });
    try { proc.stdin.write(JSON.stringify(Object.assign({ id }, cmd)) + '\n'); }
    catch (e) { clearTimeout(timer); ctlPending.delete(id); reject(e); }
  });
}
function stopCtl() {
  const proc = ctlProc; ctlProc = null;     // 同样先摘引用
  if (proc) { try { proc.kill(); } catch(e){} }
  for (const p of ctlPending.values()) p.reject(new Error('桌面控制已停止'));
  ctlPending.clear();
}

function selfWindowHandles() {
  const handles = [];
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      const buf = w.getNativeWindowHandle();
      const h = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
      if (h) handles.push(h);
    } catch(e) {}
  }
  return handles;
}
function isSelfWindow(info) {
  if (!info) return false;
  if (info.pid && Number(info.pid) === process.pid) return true;
  return selfWindowHandles().includes(Number(info.hwnd) || 0);
}
function rememberOtherForeground(info) {
  const hwnd = Number(info && info.hwnd) || 0;
  const pid = Number(info && info.pid) || 0;
  if (!hwnd || !pid) return;
  lastOtherForeground = {
    hwnd: hwnd,
    pid: pid,
    app: String(info.app || '').slice(0, 80),
    title: String(info.title || '').slice(0, 200),
  };
}
/* 空闲时每秒记一次前台窗口。任务开始时用它把焦点还给用户刚才在用的窗口。
   有桌面命令在排队就跳过：逐行敲字可能要好几秒，不能把前台查询堆在它后面。 */
function sampleForeground() {
  if (fgSampling || ctlPending.size > 0 || Date.now() < fgRetryAt) return;
  fgSampling = true;
  ctlSend({ cmd: 'foreground' }, 1500).then((info) => {
    if (info && info.ok && !isSelfWindow(info)) rememberOtherForeground(info);
  }).catch(() => {
    fgRetryAt = Date.now() + 30000;       // Python 起不来时别每秒撞一次
  }).finally(() => { fgSampling = false; });
}

app.whenReady().then(() => {
  registerHotkeys();          // 先注册，窗口一起来就能问到实际生效的组合
  createWindow();
  setInterval(sampleForeground, 1000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { stopMic(); stopCtl(); globalShortcut.unregisterAll(); if (process.platform !== 'darwin') app.quit(); });

/* IPC */
/* 截图按【物理分辨率】取，不要缩小。
   缩图会让小字和密集的行糊在一起——那正是"说点 B 结果点到 A"这类错一行的根源。
   编码用 JPEG 控制体积（1920x1200 的 PNG base64 有好几 MB，每步都传太慢）。

   注意：这里【不】在截图时临时把助手窗口藏起来。
   窗口已经在 createWindow 里用 setContentProtection 从所有抓屏里排除了：
   既不挡 agent 要看的内容，也不会每截一次闪一下。 */
function fullScreenPx() {
  const d = screen.getPrimaryDisplay();
  return {
    width: Math.round(d.size.width * (d.scaleFactor || 1)),
    height: Math.round(d.size.height * (d.scaleFactor || 1)),
  };
}
function thumbToDataUrl(img) {
  try { return 'data:image/jpeg;base64,' + img.toJPEG(88).toString('base64'); }
  catch (e) { return img.toDataURL(); }
}

/* Windows 抓屏不含光标图层。用户说"点这个"时，模型得知道鼠标现在压在哪——
   否则它只能从文字里猜"这个"是哪个。把指针按屏幕坐标画回整屏图里。
   只画整屏截图：窗口截图是窗口自己的局部坐标，鼠标屏幕坐标贴上去是错的。 */
function markCursor(img, src) {
  try {
    if (!src || !String(src.id || '').startsWith('screen')) return img;
    if (!img || typeof img.getSize !== 'function' || typeof img.toBitmap !== 'function') return img;
    const size = img.getSize();
    if (!size || !(size.width > 0) || !(size.height > 0)) return img;
    const pt = screen.getCursorScreenPoint();
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return img;
    // getCursorScreenPoint 给的是逻辑像素（DIP），截图是物理像素；125% 缩放下差 1.25 倍，
    // 不换算的话指针会画偏一大截（比如点在右边，箭头出现在里面）。
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const cx = Math.round(pt.x * sf), cy = Math.round(pt.y * sf);
    if (cx < 0 || cy < 0 || cx >= size.width || cy >= size.height) return img;   // 在别的屏上：本图里没有它
    const bmp = img.toBitmap();
    if (!bmp || bmp.length < size.width * size.height * 4) return img;
    annotate.paintCursor(bmp, size.width, size.height, cx, cy,
      { scale: Math.max(1, Math.round(size.width / 1920)) });
    return nativeImage.createFromBuffer(bmp, { width: size.width, height: size.height });
  } catch (e) {
    return img;     // 画不上指针也不能让截图失败：agent 宁可看不到光标，也不能看不见屏幕
  }
}

ipcMain.handle('capture', async (e, opts) => {
  const sources = await desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize: fullScreenPx() });
  const src = opts && opts.sourceId ? sources.find(s => s.id === opts.sourceId) : (sources.find(s => s.id.startsWith('screen')) || sources[0]);
  if (!src) throw new Error('no capture source');
  return { id: src.id, name: src.name, dataUrl: thumbToDataUrl(markCursor(src.thumbnail, src)) };
});
ipcMain.handle('sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize: { width: 320, height: 180 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});
ipcMain.handle('screen-size', () => { const p = screen.getPrimaryDisplay().workAreaSize; return { width: p.width, height: p.height }; });
ipcMain.handle('get-pos', () => { if (!win) return {x:0,y:0}; const p = win.getPosition(); return {x:p[0], y:p[1]}; });

ipcMain.on('set-pos', (e, x, y) => { if (win) win.setPosition(Math.round(x), Math.round(y)); });
ipcMain.on('resize', (e, w, h) => { if (win) win.setSize(Math.round(w), Math.round(h)); });
function applyMouseIgnore() {
  const ignore = Date.now() < mousePassUntil ? true : mouseWantIgnore;
  if (win) { try { win.setIgnoreMouseEvents(ignore, { forward: true }); } catch(x){} }
  return ignore;
}
ipcMain.handle('set-ignore-mouse', (e, ignore) => { mouseWantIgnore = !!ignore; return applyMouseIgnore(); });
ipcMain.handle('minimize', () => { if (win) win.minimize(); });
ipcMain.handle('close', () => { if (win) win.close(); });
ipcMain.handle('set-api-key', (e, k) => { apiKey = k; return true; });
ipcMain.handle('get-api-key', () => apiKey);
ipcMain.handle('list-mics', async () => {
  const { execFileSync } = require('child_process');
  const script = path.join(__dirname, 'list_mics.py');
  try {
    const out = execFileSync(pythonCmd(), [script], { encoding: 'utf8', timeout: 8000 });
    return JSON.parse(out);
  } catch (e) { return []; }
});
ipcMain.handle('set-mic-device', (e, dev) => {
  const next = (dev == null || dev === '') ? null : Number(dev);
  const changed = next !== micDevice;
  micDevice = next;
  if (changed && micOn) { stopMic(); startMic(); }   // 正在听时换设备：按新设备重启服务
  return micDevice;
});
ipcMain.handle('get-mic-device', () => micDevice);
ipcMain.handle('set-mic', (e, on) => { if (on) { startMic(); micOn = true; } else { stopMic(); } return micOn; });
ipcMain.handle('get-speech', () => {
  const items = speechQueue; speechQueue = [];
  return { items, seq: speechSeq, micAlive: !!micProc, micError, micReady, mode: speechMode };
});
ipcMain.handle('set-speech-mode', (e, mode) => setSpeechMode(mode));
/* 渲染层报来的"现在在干什么"：是否在运行态、任务是否在跑。
   T 算不算说话只看运行态（见 pttAllowedNow）；taskRunning 用来收起观察框、恢复拖拽。 */
ipcMain.on('ptt-context', (e, ctx) => {
  pttContext = {
    active: !!(ctx && ctx.active),
    taskRunning: !!(ctx && ctx.taskRunning),
  };
  if (!pttContext.taskRunning) {
    hideObservation();                              // 任务结束：圈出来的框立刻收起
    // 暂停/停止后立刻还回鼠标：别让最后一步点击的强制穿透把窗口拖不动。
    // 这里直接把整窗设成可交互，你随手就能拖；鼠标再动时渲染层会照常按位置修正。
    mousePassUntil = 0; mouseWantIgnore = false; applyMouseIgnore();
  }
  updatePttAllow();
});
/* agent 的点击/拖拽/滚轮落在物理坐标上。助手浮窗永远置顶且截图里看不见自己，
   所以面板压住目标（实测：超星右上角的「提交」）时，输入会被助手自己接住，点多少次都没反应。
   发这类动作前把整窗切成点击穿透，期间不接受渲染层"鼠标在面板上就恢复交互"的改回。 */
ipcMain.handle('agent-input', async (e, cmd) => {
  const kind = String((cmd && cmd.cmd) || '');
  const needsPass = kind === 'click' || kind === 'drag' || kind === 'scroll';
  if (needsPass) {
    mousePassUntil = Date.now() + (kind === 'drag' ? 1200 : 600);
    applyMouseIgnore();
  }
  try {
    return await ctlSend(cmd);
  } finally {
    if (needsPass) {
      const left = Math.max(0, mousePassUntil - Date.now());
      setTimeout(function(){ if (Date.now() >= mousePassUntil) applyMouseIgnore(); }, left + 30);
    }
  }
});
ipcMain.handle('screen-info', () => ctlSend({ cmd: 'ping' }));   // 物理像素尺寸：坐标换算的基准
ipcMain.handle('foreground-info', async () => {
  try {
    const info = await ctlSend({ cmd: 'foreground' }, 3000);
    if (!info || info.ok !== true) return { ok: false, error: (info && info.error) || '读取前台窗口失败' };
    const self = isSelfWindow(info);
    if (!self) rememberOtherForeground(info);
    // 只有任务进行中才圈：空闲时用户自己在用电脑，多一个框只会碍眼。
    if (pttContext.taskRunning && !self && info.rect) {
      showObservation({ app: String(info.app || ''), title: String(info.title || ''), rect: info.rect });
    } else {
      hideObservation();
    }
    return {
      ok: true,
      hwnd: Number(info.hwnd) || 0,
      pid: Number(info.pid) || 0,
      app: String(info.app || ''),
      title: String(info.title || ''),
      self: self,
    };
  } catch(e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});
ipcMain.handle('restore-focus', async () => {
  const target = lastOtherForeground;
  if (target) {
    try {
      const r = await ctlSend({ cmd: 'focus', hwnd: target.hwnd, pid: target.pid }, 4000);
      if (r && r.ok) return { ok: true, hwnd: target.hwnd, app: target.app, title: target.title };
      if (r && (r.reason === 'gone' || r.reason === 'identity')) lastOtherForeground = null;
    } catch(e) { /* 超时/读不到：退回 blur，别把任务卡死 */ }
  }
  try { if (win && !win.isDestroyed()) win.blur(); } catch(e) {}
  return { ok: false };
});
function startMenuDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  if (process.env.ProgramData) dirs.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return dirs;
}

ipcMain.handle('open-app', async (e, name) => {
  const q = String(name || '').trim();
  if (!q) return { ok: false, error: '缺少程序名' };
  // 已经开着就切过去，不要再启动一个副本：用户之前打开的文档、填了一半的表单
  // 都在原来那个窗口里，新开一个副本等于把它们藏起来。
  try {
    const r = await ctlSend({ cmd: 'activate', app: q }, 3000);
    if (r && r.ok && r.activated) {
      return { ok: true, activated: true, matched: r.app || q, title: r.title || '' };
    }
  } catch (e2) { /* 没有现成窗口、或控制进程不可用：继续走启动 */ }
  const found = findShortcut(q, startMenuDirs());
  if (!found.ok) {
    const near = found.candidates && found.candidates.length
      ? '；开始菜单里相近的有：' + found.candidates.join('、') : '';
    return { ok: false, error: '开始菜单里没有「' + q + '」的快捷方式（从商店安装的应用可能没有）' + near };
  }
  let err = '';
  try { err = await shell.openPath(found.path); }
  catch (e2) { err = e2 && e2.message ? e2.message : String(e2); }
  if (err) return { ok: false, error: '启动「' + found.name + '」失败：' + err };
  return { ok: true, matched: found.name, path: found.path };
});

ipcMain.handle('open-url', async (e, url) => {
  const raw = String(url || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (e2) { return { ok: false, error: '不是合法网址：' + raw }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '只允许 http/https 网址（拒绝 ' + parsed.protocol + '）' };
  }
  try {
    await shell.openExternal(parsed.href);
    return { ok: true, url: parsed.href };
  } catch (e2) {
    return { ok: false, error: '打开网址失败：' + (e2 && e2.message ? e2.message : String(e2)) };
  }
});

ipcMain.handle('stop-requested', () => { const v = stopRequested; stopRequested = false; return v; });
ipcMain.handle('clear-stop', () => { stopRequested = false; return true; });
ipcMain.handle('hotkey-labels', () => ({ labels: hotkeyLabels, ok: hotkeyOk }));

/* 比较两张截图在指定区域有没有变化。
   agent 唯一能拿到的"我刚才那下到底有没有用"的反馈——没有它，点了没反应就会一直点。
   只看落点附近的小块，这样页面别处（比如正在播放的视频）在动也不会干扰判断。 */
ipcMain.handle('image-diff', (e, msg) => {
  try {
    const A = nativeImage.createFromDataURL(String((msg && msg.a) || ''));
    const B = nativeImage.createFromDataURL(String((msg && msg.b) || ''));
    if (A.isEmpty() || B.isEmpty()) return { ok: false, error: '图片解码失败' };
    const r = msg && msg.rect;
    const bytes = (img) => {
      let i = img;
      if (r) {
        const s = i.getSize();
        const x = Math.max(0, Math.min(s.width - 1, Math.round(r.x)));
        const y = Math.max(0, Math.min(s.height - 1, Math.round(r.y)));
        const w = Math.max(1, Math.min(s.width - x, Math.round(r.w)));
        const h = Math.max(1, Math.min(s.height - y, Math.round(r.h)));
        i = i.crop({ x: x, y: y, width: w, height: h });
      }
      return i.toBitmap();
    };
    const a = bytes(A), b = bytes(B);
    const n = Math.min(a.length, b.length);
    let diff = 0, px = 0;
    for (let i = 0; i + 3 < n; i += 4) {
      px++;
      if (Math.abs(a[i] - b[i]) > 32 || Math.abs(a[i+1] - b[i+1]) > 32 || Math.abs(a[i+2] - b[i+2]) > 32) diff++;
    }
    return { ok: true, changedPixels: diff, totalPixels: px };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 给 agent 装上"指针"：把落点附近裁一块、放大、在落点画个准星。
   目的不是让它看得更清（整屏图它本来就有），而是让它在图里【看见自己上次点在哪】——
   没有这个，它只能靠文字描述重新定位，误差约屏幕宽度的 1%，于是"老点错、反复点同一个地方"。
   dataUrl 由调用方显式传进来，主进程不存"最后一张截图"这类全局状态（保持无状态、可测）。 */
ipcMain.handle('annotate-crop', (e, msg) => {
  try {
    const img = nativeImage.createFromDataURL(String((msg && msg.dataUrl) || ''));
    if (img.isEmpty()) return { ok: false, error: '图片解码失败' };
    const src = img.getSize();
    const rect = annotate.clampRect((msg && msg.rect) || {}, src.width, src.height, 16, 16);
    const scale = Math.max(1, Math.round(Number(msg && msg.scale) || 3));
    const cropped = img
      .crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
      .resize({ width: rect.w * scale, height: rect.h * scale });
    const out = cropped.getSize();
    const bmp = cropped.toBitmap();
    const pt = (msg && msg.point) || {};
    const c = annotate.crosshairIndex({ x: Number(pt.x), y: Number(pt.y) }, rect, scale);
    // marked:false 时不画准星。读"这个控件选中了没有"必须不画：准星那个洋红圆环
    // 和单选控件本身的圆环同形同位，画上去就分不清看到的是控件还是标记。
    const marked = !(msg && msg.marked === false);
    if (marked) annotate.paintCrosshair(bmp, out.width, out.height, c.cx, c.cy, { scale: scale });
    const outImg = nativeImage.createFromBuffer(bmp, { width: out.width, height: out.height });
    return {
      ok: true,
      dataUrl: 'data:image/jpeg;base64,' + outImg.toJPEG(85).toString('base64'),
      width: out.width, height: out.height, crosshair: [c.cx, c.cy], scale: scale, marked: marked,
      rect: rect,   // 夹紧后的真实裁切框：调用方要把裁图坐标映射回屏幕，必须用它，不能用请求时那个
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 调试取证：把 agent 每一步"看到的截图 + 模型原话 + 决定点的位置 + 结果"写到 runs/ 下。
   出问题时可以直接看它到底看到了什么，不用靠猜。 */
ipcMain.handle('run-artifact', (e, msg) => {
  try {
    const run = String((msg && msg.run) || 'unknown').replace(/[^0-9A-Za-z_\-]/g, '');
    const file = String((msg && msg.file) || 'x').replace(/[^0-9A-Za-z_\-]/g, '');
    const dir = path.join(__dirname, 'runs', run);
    fs.mkdirSync(dir, { recursive: true });
    if (msg && msg.json !== undefined) fs.writeFileSync(path.join(dir, file + '.json'), JSON.stringify(msg.json, null, 2), 'utf8');
    if (msg && msg.dataUrl) {
      const b64 = String(msg.dataUrl).split(',')[1] || '';
      if (b64) fs.writeFileSync(path.join(dir, file + '.jpg'), Buffer.from(b64, 'base64'));
    }
    return { ok: true, dir: dir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
/* 运行态小窗自动贴主屏右上角：点完「开始捕捉」不用再手动拖。 */
function placeTopRight(width, height) {
  if (!win) return;
  const a = screen.getPrimaryDisplay().workArea;
  const m = 8;
  win.setPosition(Math.round(a.x + a.width - width - m), Math.round(a.y + m));
}
ipcMain.handle('enter-active', () => {
  if (win) {
    win.setResizable(true); win.setSize(300, 260); win.setResizable(false);
    placeTopRight(300, 260);
  }
  return true;
});
ipcMain.handle('leave-active', () => {
  if (win) {
    win.setResizable(true); win.setSize(400, 600, true); win.setResizable(false);
    // 退出运行态窗口会变宽；原来贴着右边缘的话会有一半跑出屏幕，往回挪进来。
    const a = screen.getPrimaryDisplay().workArea;
    const p = win.getPosition();
    const nx = Math.max(a.x, Math.min(p[0], a.x + a.width - 400));
    const ny = Math.max(a.y, Math.min(p[1], a.y + a.height - 600));
    if (nx !== p[0] || ny !== p[1]) win.setPosition(Math.round(nx), Math.round(ny));
  }
  return true;
});