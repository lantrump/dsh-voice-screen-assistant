// 假 Electron + 假子进程：加载真实的 main.js，验证主进程逻辑（不启动界面）。
import Module from 'node:module';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { APP_DIR } from './fake-dom.mjs';

/**
 * 加载真实 main.js。
 * opts.takenHotkeys — 这些热键组合视为"已被别的程序占用"，注册会失败
 * 返回 { handlers, procs, hotkeys }：
 *   handlers — ipcMain 注册的处理器，用法 handlers['get-speech']({}, ...args)
 *   procs    — 被 spawn 出来的假子进程，支持 .out(str) / .err(str) / .reply(obj) / .emit('exit')
 *   hotkeys  — { registered: [...], taken: Set }，用于检查热键注册的结果
 */
export function loadMain(opts = {}) {
  const require = createRequire(import.meta.url);
  const procs = [];
  const taken = new Set(opts.takenHotkeys || []);
  const registered = [];
  const captureCalls = [];
  const winCalls = [];
  const sent = [];                       // 主进程发给渲染层的事件（webContents.send）
  const winListeners = {};               // 主进程挂在窗口上的 focus/blur
  const windows = [];                    // 创建过的 BrowserWindow（主窗口 + 观察框）
  const openPaths = [];                  // shell.openPath 真正启动过的路径
  const imageBuffers = [];               // nativeImage.createFromBuffer 收到的裸像素（检查画了没有）
  let winFocused = opts.windowFocused !== false;
  let handleSeq = 0;

  function fakeSpawn(cmd, args, opts) {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.cmd = cmd; p.args = args; p.opts = opts || {}; p.written = []; p.killed = false;
    p.stdin = { write: (s) => { p.written.push(String(s)); return true; } };
    p.kill = () => { p.killed = true; };
    p.out = (s) => p.stdout.emit('data', Buffer.from(s, 'utf8'));
    p.err = (s) => p.stderr.emit('data', Buffer.from(s, 'utf8'));
    p.reply = (obj) => p.out(JSON.stringify(obj) + '\n');
    procs.push(p);
    return p;
  }

  const handlers = {};
  const fakeElectron = {
    // 让 whenReady 的会调真的跑起来（main.js 在里面注册热键）
    app: { whenReady: () => ({ then: (fn) => { try { fn(); } catch (e) {} } }), on: () => {} },
    globalShortcut: {
      register: (acc, fn) => {
        if (taken.has(acc)) return false;
        registered.push(acc);
        return true;
      },
      unregisterAll: () => {},
    },
    BrowserWindow: class {
      static getAllWindows() { return windows.filter(w => !w.destroyed); }
      constructor(o) {
        this.opts = o || {};
        this.webContents = { send: (ch, payload) => sent.push({ ch, payload }) };
        this.handle = ++handleSeq;
        this.bounds = null; this.loadedUrl = ''; this.js = [];
        this.ignoreMouse = false; this.contentProtected = false;
        this.shown = 0; this.hidden = 0; this.destroyed = false;
        windows.push(this);
      }
      getNativeWindowHandle() {
        const b = Buffer.alloc(8); b.writeUInt32LE(this.handle, 0); return b;
      }
      loadFile() {} loadURL(u) { this.loadedUrl = u; return Promise.resolve(); }
      executeJavaScript(js) { this.js.push(js); return Promise.resolve(true); }
      setAlwaysOnTop() {} setContentProtection(v) { this.contentProtected = !!v; }
      setIgnoreMouseEvents(v) { this.ignoreMouse = !!v; }
      setBounds(b) { this.bounds = b; }
      on(ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); return this; }
      isDestroyed() { return this.destroyed; }
      isFocused() { return winFocused; }
      isVisible() { return true; }
      hide() { this.hidden++; winCalls.push('hide'); }
      showInactive() { this.shown++; winCalls.push('showInactive'); }
      destroy() { this.destroyed = true; }
      setPosition() {} setSize() {} minimize() {} blur() {} close() {}
    },
    ipcMain: { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { handlers[c] = f; } },
    // 逻辑尺寸 1536x960 + 缩放 1.25 => 物理 1920x1200（和真机一致）
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1536, height: 960 }, size: { width: 1536, height: 960 }, scaleFactor: 1.25 }),
      getCursorScreenPoint: () => opts.cursorPoint || { x: 0, y: 0 },
    },
    shell: {
      openPath: async (p) => { openPaths.push(p); return ''; },
      openExternal: async () => {},
    },
    desktopCapturer: {
      getSources: async (o) => { captureCalls.push(o); return opts.captureSources || []; },
    },
    // 假的 nativeImage：用 data URL 最后一个字符决定像素值，方便测"有变化/没变化"。
    // crop/resize 可链式（annotate-crop 要走 crop→resize→toBitmap→createFromBuffer），
    // 尺寸跟着参数走，这样准星下标就是【可以按下标断言】的——比拿真图做像素 diff 还硬。
    nativeImage: {
      createFromDataURL: (u) => {
        const url = String(u || '');
        const v = url ? url.charCodeAt(url.length - 1) : 0;
        const bitmap = (n) => { const b = Buffer.alloc(Math.max(4, n * 4)); b.fill(v); return b; };
        const sized = (w, h) => ({
          isEmpty: () => false,
          getSize: () => ({ width: w, height: h }),
          crop: (r) => sized(r.width, r.height),
          resize: (o) => sized(o.width, o.height),
          toBitmap: () => bitmap(w * h),
        });
        return Object.assign(sized(1920, 1200), {
          isEmpty: () => !url,
          toBitmap: () => bitmap(1920 * 1200),
        });
      },
      createFromBuffer: (buf, o) => {
        imageBuffers.push(buf);
        const w = (o && o.width) || 0, h = (o && o.height) || 0;
        return {
          isEmpty: () => !buf || !buf.length,
          getSize: () => ({ width: w, height: h }),
          toBitmap: () => buf,          // 返回同一个引用：画上去的准星能被断言到
          toJPEG: (q) => Buffer.from('JPEG' + String(q == null ? '' : q)),
          toDataURL: () => 'data:image/bmp;base64,AAAA',
        };
      },
    },
  };

  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === 'electron') return fakeElectron;
    if (req === 'child_process') return { spawn: fakeSpawn };
    return origLoad.apply(this, arguments);
  };
  // main.js 的 whenReady 里有一个每秒轮询前台窗口的 setInterval。
  // 测试里没有真实窗口，让它跑起来只会拖住事件循环（用例结束时进程退不掉）。
  const origSetInterval = global.setInterval;
  global.setInterval = () => 0;
  try {
    const entry = path.join(APP_DIR, 'main.js');
    delete require.cache[require.resolve(entry)];
    require(entry);
  } finally {
    Module._load = origLoad;
    global.setInterval = origSetInterval;
  }

  return {
    handlers, procs, sent, hotkeys: { registered, taken }, captureCalls, winCalls,
    windows, openPaths, imageBuffers,
    setWindowFocused(v) {
      winFocused = !!v;
      for (const fn of (winListeners[winFocused ? 'focus' : 'blur'] || [])) { try { fn(); } catch(e){} }
    },
    emitWindow(ev, ...args) {
      for (const fn of (winListeners[ev] || [])) { try { fn(...args); } catch(e){} }
    },
  };
}
