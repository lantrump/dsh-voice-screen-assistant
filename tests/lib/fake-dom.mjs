// 假 DOM：在 vm 里跑真实的 renderer.js，不需要 Electron、不联网。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 元素桩。注意 innerHTML='' 必须真的清空子元素，否则会测出假重复。
export function makeEl(id) {
  const el = {
    id, value: '', textContent: '', options: [], style: {}, className: '',
    scrollTop: 0, scrollHeight: 0, checked: false,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.options.push(c); },
    focus() {}, getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0 }; },
    handlers: {},
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    click() { (this.handlers.click || []).forEach((fn) => fn({})); },
    keydown(key) { (this.handlers.keydown || []).forEach((fn) => fn({ key: key })); },
  };
  let html = '';
  el._htmlHistory = [];                     // 记录每次 set，便于断言"运行过程中曾经显示过什么"
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = v; el._htmlHistory.push(String(v)); if (v === '') el.options.length = 0; },
  });
  let text = '';
  el._textHistory = [];                     // 同理，textContent 也记一份（状态栏就是它）
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); el._textHistory.push(text); },
  });
  return el;
}

// 接口默认返回的两个模型（与真实 /models 结构一致）
export const DEFAULT_MODELS = {
  data: [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', input_modalities: ['text', 'image'], output_modalities: ['text'] },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', input_modalities: ['text'], output_modalities: ['text'] },
  ],
};

/**
 * 加载真实 renderer.js 到假 DOM 里。
 * opts.models       /models 的应答（默认两个模型）
 * opts.modelsStatus /models 的 HTTP 状态（默认 200）
 * opts.stored       localStorage 初始内容（默认空 key、默认模型）
 * opts.dsh          覆盖 window.dsh 上的接口
 * opts.screen       物理屏幕尺寸
 */
export function loadRenderer(opts = {}) {
  const src = fs.readFileSync(path.join(APP_DIR, 'renderer.js'), 'utf8');

  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };

  const cmds = [];                        // 记录所有发往"手"的指令
  const intervals = [];                   // setInterval 注册的回调，可用 tick() 手动触发
  const chats = [];                       // 记录每次发给模型的请求体
  const artifacts = [];                   // 记录每一步写下的取证文件
  const cropCalls = [];                   // 记录每次"裁落点附近并画准星"的请求
  const diffCalls = [];                   // 记录每次"落点附近有没有变化"的比较
  const stateReads = [];                  // 记录每次"单独问一句：这个控件现在什么状态"
  const refineCalls = [];                 // 记录每次"点之前先放大瞄一眼：目标中心在哪"
  let diffResult = opts.imageDiff || { ok: true, changedPixels: 500, totalPixels: 1000 };   // 默认：有变化
  let stateReadReply = opts.stateReadReply || '圆形单选控件：未选中';
  // 默认给 null 坐标 = 找不到目标 → 落点原样返回，这样不关心瞄准的老用例行为不变。
  let refineReply = opts.refineReply || '{"x":null,"y":null}';
  const stats = { screenInfo: 0, modelFetches: 0, chatCalls: 0, stateReads: 0, refineCalls: 0, captures: 0, uploads: 0, speechCalls: 0, modeCalls: [], pttContexts: [], restores: 0, openApps: [], openUrls: [] };
  let pttStateCb = null;
  let modelsPayload = opts.models || DEFAULT_MODELS;
  let modelsStatus = opts.modelsStatus == null ? 200 : opts.modelsStatus;
  const screen = opts.screen || { w: 1920, h: 1200 };

  // agent 循环用：按顺序喂给模型的回复（数组，或 (第几次) => 文本 的函数）
  const replies = opts.chatReplies || [];
  let replyIndex = 0;
  const nextReply = () => (typeof replies === 'function' ? replies(replyIndex++) : (replyIndex < replies.length ? replies[replyIndex++] : ''));
  let chatStatus = 200;

  // 全局热键叫停的模拟开关
  let stopFlag = false;
  // 当前前台窗口（前台信息是新增的观察项；默认给一个普通应用，保持老用例行为不变）
  let foreground = opts.foreground || { ok: true, hwnd: 111, pid: 222, app: 'Notepad', title: '未命名 - 记事本', self: false };

  const dsh = Object.assign({
    sources: async () => [],
    capture: async () => { stats.captures++; return { dataUrl: 'data:image/png;base64,AAAA' }; },
    listMics: async () => [],
    getSpeech: async () => ({ items: [], seq: 0, micAlive: true, micError: '' }),
    setSpeechMode: async (m) => ({ mode: m === 'ptt' ? 'ptt' : 'auto' }),
    setPttContext: (ctx) => { stats.pttContexts.push(ctx); return true; },
    onPttState: (cb) => { pttStateCb = cb; },
    getApiKey: async () => '',
    getMicDevice: async () => null,
    setMicDevice: async () => null,
    setMic: async () => true,
    setApiKey: async () => true,
    enterActive: async () => true,
    leaveActive: async () => true,
    setIgnoreMouse: async () => true,
    minimize: async () => true,
    close: async () => true,
    toSimplified: (t) => String(t),
    screenInfo: async () => { stats.screenInfo++; return { screen: { primary: { w: screen.w, h: screen.h }, virtual: { w: screen.w, h: screen.h } } }; },
    foregroundInfo: async () => (typeof foreground === 'function' ? foreground() : foreground),
    restoreFocus: async () => { stats.restores++; return { ok: true }; },
    openApp: async (name) => { stats.openApps.push(name); return { ok: true, matched: name, path: 'C:\\Start\\' + name + '.lnk' }; },
    openUrl: async (url) => { stats.openUrls.push(url); return { ok: true, url }; },
    input: async (cmd) => { cmds.push(cmd); return { ok: true }; },
    stopRequested: async () => { const v = stopFlag; stopFlag = false; return v; },
    clearStop: async () => { stopFlag = false; return true; },
    hotkeyLabels: async () => opts.hotkeyLabels || { labels: { stop: 'Ctrl+Alt+Space' }, ok: { stop: true } },
    runArtifact: async (msg) => { artifacts.push(msg); return { ok: true }; },
    imageDiff: async (msg) => { diffCalls.push(msg); return typeof diffResult === 'function' ? diffResult(msg) : diffResult; },
    // 裁落点附近 + 画准星。返回的 crosshair 按源点算，和真实现同一套公式。
    annotateCrop: async (msg) => {
      cropCalls.push(msg);
      const r = (msg && msg.rect) || {};
      const s = Math.max(1, Math.round(Number(msg && msg.scale) || 3));
      const pt = (msg && msg.point) || {};
      return {
        ok: true,
        dataUrl: 'data:image/jpeg;base64,CROP',
        width: Math.max(1, Math.round(Number(r.w) || 0)) * s,
        height: Math.max(1, Math.round(Number(r.h) || 0)) * s,
        crosshair: [Math.round((Number(pt.x) || 0) - (Number(r.x) || 0)) * s,
                    Math.round((Number(pt.y) || 0) - (Number(r.y) || 0)) * s],
        scale: s,
        marked: !(msg && msg.marked === false),
      };
    },
  }, opts.dsh || {});

  // 包一层只为了计数：测试要能证明"任务期间真的没去取语音"
  const rawGetSpeech = dsh.getSpeech;
  dsh.getSpeech = async (...a) => { stats.speechCalls++; return rawGetSpeech(...a); };
  const rawMode = dsh.setSpeechMode;
  dsh.setSpeechMode = async (m) => { stats.modeCalls.push(String(m)); return rawMode(m); };

  // 让每个假接口都【让出一次宏任务】再返回。
  // 真接口是 IPC / 网络，天然会让出主线程；假接口 immediate-resolve 的话，
  // agent 那种 `while + await` 的循环会变成纯微任务循环——定时器永远排不上队，
  // 测试里表现为"点停止没反应、整个进程卡死"，那是假环境的假象，不是产品行为。
  const YIELD_ASYNC = ['sources', 'capture', 'listMics', 'getSpeech', 'setSpeechMode', 'getApiKey', 'getMicDevice',
    'setMicDevice', 'setMic', 'setApiKey', 'enterActive', 'leaveActive', 'setIgnoreMouse', 'minimize', 'close',
    'screenInfo', 'foregroundInfo', 'restoreFocus', 'openApp', 'openUrl', 'input', 'stopRequested', 'clearStop', 'hotkeyLabels', 'runArtifact', 'imageDiff', 'annotateCrop'];
  for (const name of YIELD_ASYNC) {
    if (typeof dsh[name] !== 'function') continue;
    const f = dsh[name];
    dsh[name] = async (...a) => { await new Promise(r => setImmediate(r)); return f(...a); };
  }

  const sandbox = {
    console, setTimeout, clearTimeout,
    // setInterval 交给我们自己管：测试要能手动"走一拍"（语音轮询就靠它驱动）
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    Promise, JSON, Math, Date, String, Number, Object, Array, Error, Boolean, RegExp, isFinite, isNaN, parseFloat, parseInt,
    TextDecoder, FormData, Blob, URL,
    document: {
      getElementById: getEl,
      querySelector: () => makeEl('q'),
      addEventListener() {},
      createElement: (tag) => makeEl(tag),
    },
    localStorage: {
      store: Object.assign({}, opts.stored || {}),
      getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
      setItem(k, v) { this.store[k] = v; },
    },
    window: {},
    fetch: async (url, init) => {
      const u = String(url);
      if (u.startsWith('data:')) return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) };
      if (u.includes('/models')) {
        stats.modelFetches++;
        return { ok: modelsStatus === 200, status: modelsStatus, json: async () => modelsPayload };
      }
      if (u.includes('/files')) {
        stats.uploads++;
        return { ok: true, json: async () => ({ id: 'file-stub' }), text: async () => '{"id":"file-stub"}' };
      }
      if (u.includes('/chat/completions')) {
        let body = {};
        try { body = init && init.body ? JSON.parse(String(init.body)) : {}; } catch (e) {}
        // 「放大图判读」是【单独一次】调用，靠它的 system 提示词认出来。
        // 它不消耗 chatReplies、也【不计进 chatCalls】——否则每一步动作的预算会被这个副请求吃掉，
        // 而各用例里 `chatCalls < 30` 这类"没跑飞"的断言就会变得没意义。
        const msgs = body.messages || [];
        const sys = String((msgs[0] && msgs[0].content) || '');
        const isRefine = msgs[0] && msgs[0].role === 'system' && /定位的助手/.test(sys);
        if (isRefine) {
          stats.refineCalls++;
          refineCalls.push(body);
          const txt = typeof refineReply === 'function' ? refineReply(body) : refineReply;
          return { ok: true, json: async () => ({ choices: [{ message: { content: txt } }] }) };
        }
        const isStateRead = msgs[0] && msgs[0].role === 'system' && /读图的助手/.test(sys);
        if (isStateRead) {
          stats.stateReads++;
          stateReads.push(body);
          const txt = typeof stateReadReply === 'function' ? stateReadReply(body) : stateReadReply;
          return { ok: true, json: async () => ({ choices: [{ message: { content: txt } }] }) };
        }
        stats.chatCalls++;
        const content = nextReply();
        chats.push({ body, content });
        if (chatStatus !== 200) return { ok: false, status: chatStatus, text: async () => '模型返回了错误' };
        if (body.stream) return { ok: true, body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
        // 模拟"用工具调用格式回答"（content 为空，动作在 tool_calls 里）
        const tc = opts.toolCallReply && replyIndex === 1
          ? [{ id: 'call_1', type: 'function', function: { name: opts.toolCallReply.name, arguments: JSON.stringify(opts.toolCallReply.args) } }]
          : undefined;
        return { ok: true, json: async () => ({ choices: [{
          finish_reason: opts.finishReason || 'stop',
          message: { content: tc ? '' : content, tool_calls: tc },
        }], usage: { completion_tokens: 100, completion_tokens_details: { reasoning_tokens: opts.reasoningTokens || 0 } } }) };
      }
      if (u.includes('/anthropic/v1/messages')) {
        return { ok: true, json: async () => ({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 't', url: 'u' }] }] }) };
      }
      return { ok: false, status: 404, text: async () => '' };
    },
  };
  sandbox.window.dsh = dsh;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'renderer.js' });

  return {
    sandbox, getEl, cmds, chats, artifacts, diffCalls, cropCalls, stateReads, refineCalls, stats, dsh,
    setImageDiff(v) { diffResult = v; },
    setForeground(v) { foreground = v; },
    setStateReadReply(v) { stateReadReply = v; },
    setRefineReply(v) { refineReply = v; },
    setPttState(st) { if (pttStateCb) pttStateCb(st); },
    // 手动走一拍：触发所有 setInterval 回调（语音轮询就是这个）
    async tick() { for (const fn of intervals) { await fn(); } },
    setModels(payload, status = 200) { modelsPayload = payload; modelsStatus = status; },
    setChatStatus(code) { chatStatus = code; },
    requestStop() { stopFlag = true; },
    // 读写 renderer 里的词法变量（const/let 不会挂到 sandbox 上）
    run: (code) => vm.runInContext(code, sandbox),
  };
}
