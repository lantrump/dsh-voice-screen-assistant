const $ = (id) => document.getElementById(id);
const api = window.dsh;

const state = {
  apiKey: localStorage.getItem('dsh_apikey') || '',
  model: localStorage.getItem('dsh_model') || 'deepseek-flash',
  mode: localStorage.getItem('dsh_mode') || 'auto',     // auto=从话里分辨  qa=当问题  task=当任务
  runId: '',
  hotkeys: { stop: 'Ctrl+Alt+Space' },
  hotkeyOk: { stop: true },
  sources: [], selectedSourceId: null,
  micActive: false,
  speaking: false,
  active: false,
  previewDataUrl: null,
  history: [],
  taskMemory: loadMemory(),      // 跨任务的记忆：用户说"继续做"时靠它，重启也不丢
};

function s(h){ return String(h).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

/* enter/leave active */
async function enterActive(withMic){
  state.active = true;
  document.getElementById('setup').style.display = 'none';
  document.getElementById('active').style.display = 'flex';
  api.enterActive();
  api.setIgnoreMouse(true);   // 运行态默认穿透
  actStatus(withMic === false ? '就绪' : '本地语音已开启 · 按住 T 说话');
  if (withMic !== false && !state.micActive) { try { await enableMic(); } catch(e){} }
  sendPttContext();
}
async function leaveActive(){
  state.active = false;
  document.getElementById('setup').style.display = 'flex';
  document.getElementById('active').style.display = 'none';
  if (state.micActive) { await api.setMic(false); state.micActive = false; setMicUI(false); }
  api.setIgnoreMouse(false);   // 退出运行态恢复可交互
  api.leaveActive();
  sendPttContext();
}

/* sources */
async function loadSources(){
  const list = await api.sources();
  state.sources = list;
  const sel = document.getElementById('sourceSel'); sel.innerHTML = '';
  list.forEach(sv => { const o=document.createElement('option'); o.value=sv.id; o.textContent=sv.name.length>24?sv.name.slice(0,24)+'\u2026':sv.name; sel.appendChild(o); });
  const scr = list.find(x=>x.id.startsWith('screen'));
  if (scr) sel.value = scr.id;
  state.selectedSourceId = sel.value || (list[0] && list[0].id);
}
async function capturePreview(){
  if (!state.selectedSourceId) { document.getElementById('preview').innerHTML='<span class="ph">'+s('\u9009\u62e9\u6355\u6349\u6e90')+'</span>'; return; }
  const r = await api.capture({ sourceId: state.selectedSourceId });
  state.previewDataUrl = r.dataUrl;
  document.getElementById('preview').innerHTML = '<img src="'+r.dataUrl+'" />';
}
document.getElementById('btnRefresh').addEventListener('click', async () => { await loadSources(); await capturePreview(); });
document.getElementById('sourceSel').addEventListener('change', async (e) => { state.selectedSourceId=e.target.value; await capturePreview(); });

/* mics: clean list, 优先用上次选定的设备，没有才退回列表第一个 */
async function loadMics(){
  try {
    const list = await api.listMics() || [];
    const sel = document.getElementById('micSel'); sel.innerHTML = '';
    list.forEach(m => { const o=document.createElement('option'); o.value=String(m.id); o.textContent=(m.label||m.name); sel.appendChild(o); });
    const saved = localStorage.getItem('dsh_micdev');
    const pick = list.find(m => String(m.id) === saved) || list[0];
    if (pick) { sel.value = String(pick.id); await api.setMicDevice(pick.id); }
  } catch(e){}
}
document.getElementById('btnMicRefresh').addEventListener('click', () => loadMics());
document.getElementById('micSel').addEventListener('change', async (e) => { localStorage.setItem('dsh_micdev', e.target.value); await api.setMicDevice(e.target.value); });

/* api key */
function refreshKeyStatus(){ document.getElementById('keyStatus').textContent = state.apiKey ? '\u5df2\u8bbe\u7f6e' : '\u672a\u8bbe\u7f6e'; }
document.getElementById('btnKey').addEventListener('click', () => { document.getElementById('keyInput').value=state.apiKey; document.getElementById('keyModal').classList.add('show'); document.getElementById('keyInput').focus(); });
document.getElementById('keyCancel').addEventListener('click', () => document.getElementById('keyModal').classList.remove('show'));
document.getElementById('keySave').addEventListener('click', () => { const v=document.getElementById('keyInput').value.trim(); state.apiKey=v; localStorage.setItem('dsh_apikey',v); api.setApiKey(v); document.getElementById('keyModal').classList.remove('show'); refreshKeyStatus(); loadModels(); });
refreshKeyStatus();

/* model: 列表来自 /models，只把接口真报的模型列出来；无视觉的标出来别选错 */
const FALLBACK_MODELS = [{ id:'deepseek-flash', name:'DeepSeek-V4.1-Flash', vision:true }];
async function loadModels(){
  const sel = document.getElementById('modelSel');
  let list = null;
  if (state.apiKey) {
    try {
      const r = await fetch('https://api.deepseek.com/models', { headers: { Authorization: 'Bearer '+state.apiKey } });
      if (r.ok) {
        const j = await r.json();
        list = (j.data||[])
          .filter(m => (m.output_modalities || ['text']).includes('text'))   // 只留能对话的，别把非聊天模型列进来
          .map(m => ({ id:m.id, name:m.name||m.id, vision:(m.input_modalities||[]).includes('image') }));
      }
    } catch(e){}
  }
  if (!list || !list.length) list = FALLBACK_MODELS;
  sel.innerHTML = '';
  list.forEach(m => { const o=document.createElement('option'); o.value=m.id; o.textContent=m.name+' ('+m.id+')'+(m.vision?'':' \u00b7 \u65e0\u89c6\u89c9'); sel.appendChild(o); });
  if (!list.some(m => m.id === state.model)) {
    const pick = list.find(m => m.vision) || list[0];   // 原选的模型下架了：退回能看图的，别悄悄丢掉视觉
    state.model = pick.id;
    localStorage.setItem('dsh_model', state.model);
  }
  sel.value = state.model;
}
document.getElementById('modelSel').addEventListener('change', (e) => { state.model = e.target.value; localStorage.setItem('dsh_model', state.model); });
document.getElementById('btnModelRefresh').addEventListener('click', () => loadModels());

/* ===== 动作层（"神经"）：把大脑给的结构化动作变成真实操作 =====
   动作协议（大脑必须输出这样的 JSON）：
     {"action":"click","target":"选项B","x":281,"y":168}   x/y 为归一化坐标 0-1000
     {"action":"type","target":"答案框","text":"1982年"}    可选 x/y：先点框再打字
     {"action":"scroll","direction":"down","amount":3}      amount 为"格数"
     {"action":"key","keys":"enter"}
     {"action":"look","target":"要看的是什么","x":0到1000,"y":0到1000,"w":200,"h":150}  只放大给你看，不动鼠标
     {"action":"wait","ms":800}
     {"action":"open_app","app":"Visual Studio Code"}
     {"action":"open_url","url":"https://example.com"}
     {"action":"done","reason":"做完了"}                    终止信号，不执行
   坐标一律按"物理像素尺寸"换算（desktop_ctl 报告的），不能用截图的像素尺寸。 */
const ACTIONS = ['click','type','scroll','key','wait','say','drag','done','look','open_app','open_url'];
let screenPx = null;

async function screenPxSize(){
  if (!screenPx) {
    const r = await api.screenInfo();
    const p = r && r.screen && r.screen.primary;
    if (!p || !p.w || !p.h) throw new Error('拿不到屏幕物理尺寸');
    screenPx = { w: p.w, h: p.h };
  }
  return screenPx;
}

/* 归一化(0-1000) -> 物理像素。越界一律夹紧：模型给出界坐标时宁可不点，也不能点到屏幕外 */
function normToPx(n, size){
  const v = Number(n);
  if (!isFinite(v)) throw new Error('坐标不是数字：' + n);
  return Math.max(0, Math.min(size - 1, Math.round(v / 1000 * (size - 1))));
}

/* 容错解析：模型常在 JSON 外面裹解释文字或 ``` 代码块。
   只取"第一个 { 到最后一个 }"，所以一次给多个动作会解析失败并报错——
   这是故意的：一轮一个动作，才能每步回看验证。 */
/* 取出第一个完整的 JSON 对象（按大括号配平，跳过字符串里的括号）。
   模型经常在动作后面再补一段话、甚至再给一个 JSON——旧的贪心正则会把这些全吞进去，
   导致"不是合法 JSON"而白费一步。 */
function firstJsonObject(src){
  const start = String(src).indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 }; }
  }
  return null;
}

/* 模型有时不写 JSON，而是吐出一段【工具调用风格的标记文本】。它不是真正的
   tool_calls 字段（实测 hadToolCalls=false），是混在正文里的，得自己捞出来。
   实测 18 步里有 5 步栽在这上面。抓法：取所有 属性-值 对，第一个当动作名，其余当参数。 */
function parsePseudoCall(src){
  const s = String(src);
  const attr = 'name' + '\\s*=\\s*"';        // 拆开拼接，避免这段字面量干扰工具参数解析
  const re = new RegExp(attr + '([^"]+)"[^>]*>([\\s\\S]*?)<', 'gi');
  const pairs = [];
  let m;
  while ((m = re.exec(s))) pairs.push([m[1], m[2].trim()]);
  if (pairs.length < 2) return null;         // 至少要有动作名 + 一个参数
  const obj = { action: pairs[0][0] };
  for (let i = 1; i < pairs.length; i++) {
    const k = pairs[i][0];
    let v = pairs[i][1];
    if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    else if (/^true$/i.test(v)) v = true;
    else if (/^false$/i.test(v)) v = false;
    obj[k] = v;
  }
  return obj;
}

/* 动作别名：模型很自然地会写 right-click / double / input 这些，
   以前它们全被当成「不认识的动作」整条丢掉。 */
function normalizeAction(obj){
  if (!obj || typeof obj !== 'object') return obj;
  const name = String(obj.action || '').toLowerCase().replace(/[\s_]+/g, '-');
  const alias = {
    'right-click':  ['click', { button: 'right' }],
    'rightclick':   ['click', { button: 'right' }],
    'left-click':   ['click', {}],
    'leftclick':    ['click', {}],
    'double-click': ['click', { double: true }],
    'doubleclick':  ['click', { double: true }],
    'dblclick':     ['click', { double: true }],
    'double':       ['click', { double: true }],
    'input':        ['type', {}],
    'write':        ['type', {}],
    'fill':         ['type', {}],
    'press':        ['key', {}],
    'hotkey':       ['key', {}],
    'keypress':     ['key', {}],
    'mouse-scroll': ['scroll', {}],
    'finish':       ['done', {}],
    'complete':     ['done', {}],
    'open-app':     ['open_app', {}],
    'openapp':      ['open_app', {}],
    'launch':       ['open_app', {}],
    'open-url':     ['open_url', {}],
    'openurl':      ['open_url', {}],
    'browse':       ['open_url', {}],
  };
  if (alias[name]) {
    const out = Object.assign({}, obj, { action: alias[name][0] }, alias[name][1]);
    if (out.action === 'open_app' && out.app == null) {
      if (out.name != null) out.app = out.name;
      else if (out.target != null) out.app = out.target;
    }
    if (out.action === 'open_url' && out.url == null) {
      if (out.link != null) out.url = out.link;
      else if (out.target != null) out.url = out.target;
    }
    return out;
  }
  if (name === 'type') {                     // 字段名也常换：text / content / value
    const t = obj.text != null ? obj.text : (obj.content != null ? obj.content : obj.value);
    if (t != null) obj = Object.assign({}, obj, { text: t });
  }
  if (name === 'key') {                      // keys / key / combo
    const k = obj.keys != null ? obj.keys : (obj.key != null ? obj.key : obj.combo);
    if (k != null) obj = Object.assign({}, obj, { keys: k });
  }
  return Object.assign({}, obj, { action: name });
}

function parseAction(text){
  const src = String(text || '');
  let obj = null;
  let before = '';
  const found = firstJsonObject(src);
  if (found) {
    try { obj = JSON.parse(found.text); } catch(e){ throw new Error('动作不是合法 JSON：' + e.message); }
    before = src.slice(0, src.indexOf('{')).replace(/`/g, '').replace(/^\s*json\s*/i, '').trim();
  } else {
    obj = parsePseudoCall(src);              // 退一步：认工具调用风格的标记文本
    if (!obj) throw new Error('回复里既没有 JSON 动作，也没有可识别的动作标记');
  }
  obj = normalizeAction(obj);
  const name = String(obj.action || '').toLowerCase();
  if (ACTIONS.indexOf(name) < 0) throw new Error('不认识的动作：' + obj.action);
  if (name === 'click') {
    if (obj.x == null || obj.y == null) throw new Error('click 缺少 x/y');
    if (!obj.target) throw new Error('click 必须说明 target（点的是什么）');
    if (obj.modifiers != null) {
      const list = Array.isArray(obj.modifiers) ? obj.modifiers : [obj.modifiers];
      const norm = [];
      for (const m of list) {
        const k = String(m).toLowerCase().replace(/[\s_+-]/g, '');
        const map = { ctrl:'ctrl', control:'ctrl', shift:'shift', alt:'alt' };
        if (!map[k]) throw new Error('click 的 modifiers 只能是 ctrl / shift / alt：' + m);
        if (norm.indexOf(map[k]) < 0) norm.push(map[k]);
      }
      obj = Object.assign({}, obj, { modifiers: norm });
    }
  }
  if (name === 'type') {
    if (!obj.text) throw new Error('type 缺少 text');
    if (obj.x == null || obj.y == null) throw new Error('type 必须带 x/y（输入框位置）：它会一步完成"点框 + 输入"');
  }
  if (name === 'scroll') {
    const dir = String(obj.direction || '').toLowerCase();
    if (['up','down','left','right'].indexOf(dir) < 0) throw new Error('scroll 的 direction 只能是 up/down/left/right');
    if (!(Number(obj.amount) > 0)) throw new Error('scroll 的 amount 必须是正数');
  }
  if (name === 'look') {
    if (obj.x == null || obj.y == null) throw new Error('look 缺少 x/y');
    if (!obj.target) throw new Error('look 必须说明 target（要看的是什么）');
  }
  if (name === 'key' && !obj.keys) throw new Error('key 缺少 keys');
  if (name === 'open_app') {
    if (!obj.app) throw new Error('open_app 缺少 app（程序名）');
  }
  if (name === 'open_url') {
    if (!obj.url) throw new Error('open_url 缺少 url');
    let ok = false;
    try { const u = new URL(String(obj.url)); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch(e){}
    if (!ok) throw new Error('open_url 只允许 http/https 网址：' + obj.url);
  }
  if (name === 'wait' && !(Number(obj.ms) >= 0)) throw new Error('wait 的 ms 必须是非负数');
  if (name === 'say' && !obj.text) throw new Error('say 缺少 text');
  if (name === 'drag') {
    if (obj.fromX == null || obj.fromY == null || obj.toX == null || obj.toY == null) throw new Error('drag 需要 fromX/fromY/toX/toY');
    if (!obj.target) throw new Error('drag 必须说明 target（拖的是什么）');
  }
  // JSON 之前的那句话、以及后面多出来的内容，都当作"理由"显示给人看
  const tail = found ? src.slice(found.end).trim() : '';
  const extra = tail && firstJsonObject(tail) ? '（它还多输出了一个动作，已忽略）' : '';
  const reason = (before + (tail ? ' ' + tail.replace(/`/g, '') : '')).trim() + extra;
  return Object.assign({}, obj, { action: name, __reason: reason.slice(0, 200) });
}

/* desktop_ctl 在发输入之前会查目标窗口是不是管理员权限；是就不发，
   回一个 code:'elevated' 的结果。这里把它转成带标记的异常：
   doAction 立刻中止，runTask 那边当成"这一步没执行"的观察继续，不记执行失败。 */
async function inputCmd(cmd){
  const r = await api.input(cmd);
  if (r && r.code === 'elevated') {
    const e = new Error(r.error || '目标窗口是管理员权限，输入被系统拦截');
    e.blocked = 'elevated';
    e.window = String(r.window || '');
    e.hwnd = r.hwnd || 0;
    throw e;
  }
  return r;
}

/* 每步给模型的一行事实：键盘焦点在哪个应用、窗口标题是什么。
   截图看不出焦点在谁身上（输入框的光标还会闪灭），这行文字补上这一块。 */
function foregroundNote(fg){
  if (!fg || fg.ok !== true) return '';
  if (!fg.hwnd) return '\n\n【当前前台窗口】（没有前台窗口）';
  if (fg.self) {
    return '\n\n【当前前台窗口】助手自己的窗口' +
      (fg.title ? '「' + String(fg.title).slice(0, 80) + '」' : '') +
      '\n⚠ 键盘焦点现在在助手自己的窗口上：下一步如果要按键，先点一下目标窗口把焦点交出去，不要直接发 key。';
  }
  const app = String(fg.app || '').slice(0, 60);
  const title = String(fg.title || '').slice(0, 160);
  return '\n\n【当前前台窗口】' + (app || '（未知应用）') + (title ? ' · 「' + title + '」' : '') +
    '\n（键盘焦点在这个窗口上；如果它不是你要操作的目标，先切过去再动手。）';
}

/* 发键盘前确认焦点不在助手自己身上。在的话先把焦点还回去，还不过去就明确拦下——
   不要往自己的输入框里打字。查询失败时放行：不能因为读不到焦点就把键盘堵死。 */
async function ensureKeyFocus(){
  if (typeof api.foregroundInfo !== 'function') return;
  let fg = null;
  try { fg = await api.foregroundInfo(); } catch(e) { return; }
  if (!fg || fg.ok !== true || !fg.self) return;
  try { if (api.restoreFocus) await api.restoreFocus(); } catch(e){}
  try { fg = await api.foregroundInfo(); } catch(e) { fg = null; }
  if (!fg || fg.ok !== true || !fg.self) return;
  const e = new Error('键盘焦点还在助手自己的窗口上，按键没有发出去');
  e.blocked = 'focus';
  throw e;
}

async function foregroundNow(){
  try { return api.foregroundInfo ? await api.foregroundInfo() : null; } catch(e) { return null; }
}

/* 打开程序/网址后等前台变一下：新窗口通常要 1-2 秒才起来，
   不等的话下一步截图还是旧界面，模型会以为没打开又去点一遍。
   浏览器开新标签时窗口句柄不变、标题会变——两个都看。 */
async function waitForegroundChanged(before, timeoutMs){
  const key = (fg) => fg && fg.ok === true ? (Number(fg.hwnd) || 0) + '|' + String(fg.title || '') : '';
  const beforeKey = key(before);
  if (!beforeKey) return false;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !agent.stop) {
    await new Promise(function(r){ setTimeout(r, 400); });
    const fg = await foregroundNow();
    if (key(fg) && key(fg) !== beforeKey) return true;
  }
  return false;
}

async function doAction(a){
  const sz = await screenPxSize();          // 注意别叫 s：会遮蔽全局的转义函数 s()
  // 动作自带的说明：边做边说我为什么这么做（可选，没说就不吭声）
  if (a.say) showAnswer(s(String(a.say)), 'done', true);
  if (a.action === 'click') {
    const bx = normToPx(a.x, sz.w), by = normToPx(a.y, sz.h);
    // 整屏定位对小目标（单选圆点、小图标）不够准：先用放大裁图把落点收紧一次再点。
    const rp = await refineClickPoint(sz, [bx, by], a.target);
    const x = rp ? rp[0] : bx, y = rp ? rp[1] : by;
    const cmd = { cmd:'click', x:x, y:y, button: a.button === 'right' ? 'right' : 'left', double: !!a.double };
    if (Array.isArray(a.modifiers) && a.modifiers.length) cmd.modifiers = a.modifiers;
    await inputCmd(cmd);
    const out = { target: a.target, at: '(' + x + ',' + y + ')', px: [x, y] };
    if (x !== bx || y !== by) out.refinedFrom = [bx, by];
    return out;
  }
  if (a.action === 'type') {
    let at = '', px = null;
    if (a.x != null && a.y != null) {
      const x = normToPx(a.x, sz.w), y = normToPx(a.y, sz.h);
      await inputCmd({ cmd:'click', x:x, y:y });          // 先点回输入框，否则焦点可能还停在助手窗口上
      at = '(' + x + ',' + y + ')'; px = [x, y];
    } else {
      await ensureKeyFocus();                            // 没给落点：至少确认键盘不会打到助手自己身上
    }
    const text = String(a.text);
    // 一行一行敲模式：写/改代码【强制】用它，不交给模型选（提示词写了它也不听，实测过）。
    // 并默认【不】全选——那样等于把整个文件删了重贴，正是用户嫌的那个
    // "每次就得重新删掉再全部复制一遍"。模型明确要整块替换（replace=true）时才全选。
    const isCode = looksLikeCode(a);
    // 默认就逐字真键盘敲：不少答题页禁粘贴（能打字、Ctrl+V 无效），逐字敲不发 paste 事件、拦不住；
    // 也符合"看得见它写了什么"。代码题强制逐字；其余默认也逐字，只有显式 lineByLine:false（超长文本/要快）才粘贴。
    const lineByLine = isCode || a.lineByLine !== false || a.how === 'line';
    const replace = lineByLine ? (a.replace === true) : (a.replace !== false);
    await inputCmd({ cmd:'type', text: text, clear: replace,
                      lineByLine: lineByLine, perChar: a.perChar });
    return { target: a.target || '', chars: text.length, at: at, px: px, replaced: replace,
             mode: lineByLine ? 'lineByLine' : 'paste', forced: isCode };
  }
  if (a.action === 'scroll') {
    const notches = Math.max(1, Math.round(Number(a.amount)));
    const step = 120 * notches;                 // Windows 滚轮一格 = 120
    const dir = String(a.direction).toLowerCase();
    const cmd = { cmd:'scroll' };
    if (dir === 'down') cmd.dy = -step;         // 负 = 向下
    else if (dir === 'up') cmd.dy = step;
    else if (dir === 'right') cmd.dx = step;
    else cmd.dx = -step;
    // 滚轮事件是发给"鼠标底下的那个窗口"的，所以必须先把光标挪过去。
    // 只移动、绝不点击：为了"获得焦点"去点空白处，很容易戳到题目选项。
    const tx = (a.x != null) ? normToPx(a.x, sz.w) : Math.round(sz.w / 2);
    const ty = (a.y != null) ? normToPx(a.y, sz.h) : Math.round(sz.h / 2);
    await inputCmd({ cmd:'move', x:tx, y:ty });
    await inputCmd(cmd);
    return { direction: dir, amount: notches, at: '(' + tx + ',' + ty + ')' };
  }
  if (a.action === 'key') {
    await ensureKeyFocus();
    await inputCmd({ cmd:'key', keys:String(a.keys) });
    return { keys: a.keys };
  }
  if (a.action === 'drag') {                                 // 拖拽：滑块、拖放、拖选文字都靠它
    const x1 = normToPx(a.fromX, sz.w), y1 = normToPx(a.fromY, sz.h);
    const x2 = normToPx(a.toX, sz.w),   y2 = normToPx(a.toY, sz.h);
    await inputCmd({ cmd:'drag', fromX:x1, fromY:y1, toX:x2, toY:y2 });
    return { target: a.target, at: '(' + x1 + ',' + y1 + ')->(' + x2 + ',' + y2 + ')', px: [x1, y1] };
  }
  if (a.action === 'say') {                                 // 只说话，不动电脑：这是 agent 的"回答通道"
    showAnswer(s(String(a.text)), 'done', true);
    return { said: String(a.text) };
  }
  if (a.action === 'look') {                                // 只放大给你看，不动鼠标：这是 agent 的"能指的眼镜"
    const px = [normToPx(a.x, sz.w), normToPx(a.y, sz.h)];
    const crop = await annotateCrop(cropRectFor(px, sz, a.w, a.h), px);
    return { looked: a.target, at: '(' + px[0] + ',' + px[1] + ')', crop: crop };
  }
  if (a.action === 'open_app' || a.action === 'open_url') {
    if (a.action === 'open_app' && typeof api.openApp !== 'function') throw new Error('这个版本还不能打开程序');
    if (a.action === 'open_url' && typeof api.openUrl !== 'function') throw new Error('这个版本还不能打开网址');
    const before = await foregroundNow();
    const r = a.action === 'open_app' ? await api.openApp(String(a.app)) : await api.openUrl(String(a.url));
    if (!r || r.ok !== true) throw new Error((r && r.error) || (a.action === 'open_app' ? '打开程序失败' : '打开网址失败'));
    const changed = await waitForegroundChanged(before, 4000);
    return a.action === 'open_app'
      ? { app: r.matched || a.app, at: r.path || '', changed: changed }
      : { url: r.url || a.url, changed: changed };
  }
  if (a.action === 'wait') {
    const ms = Math.min(10000, Math.max(0, Number(a.ms) || 0));
    // 切成小段等，每段看一眼停止标志：按停要立刻生效，不能让 ■ 在等 10 秒的时候像失灵。
    // ■ 会直接置 agent.stop；全局热键只置主进程的标志，要主动取一次才知道。
    const until = Date.now() + ms;
    while (!agent.stop && Date.now() < until) {
      await new Promise(function(r){ setTimeout(r, Math.min(100, until - Date.now())); });
      if (agent.stop) break;
      try { if (await api.stopRequested()) { agent.stop = true; break; } } catch(e){}
    }
    return { ms: ms, stopped: !!agent.stop };
  }
  throw new Error('无法执行的动作：' + a.action);
}

/* 裁图窗口：落点居中，默认 320x200 源像素（约占各边 1/6）。放大倍数见 annotateCrop。
   夹紧到源图边界的事交给主进程做（贴边时它会平移窗口而不是缩小），
   所以这里算出来的落点可能是偏心的——准星位置由 crosshairIndex 按源点算，不受影响。 */
function cropRectFor(px, sz, wNorm, hNorm){
  const w = Math.max(40, Math.min(sz.w, Math.round(Number(wNorm) / 1000 * sz.w) || 320));
  const h = Math.max(40, Math.min(sz.h, Math.round(Number(hNorm) / 1000 * sz.h) || 200));
  return { x: Math.round(px[0] - w / 2), y: Math.round(px[1] - h / 2), w: w, h: h };
}

/* 请主进程把落点附近裁一块、放大。拿不到就返回 null——
   这条链路是"锦上添花"的感知增强，失败了不能影响主循环（老版本没有它也能跑）。
   marked=false 时不画准星：读"控件选中了没有"必须不画（准星的圆环和控件的圆环同形同位）。 */
async function annotateCrop(rect, point, marked){
  if (!api.annotateCrop) return null;
  try {
    const r = await api.annotateCrop({ dataUrl: state.previewDataUrl || '', rect: rect,
      point: { x: point[0], y: point[1] }, scale: 3, marked: marked !== false });
    return (r && r.ok && r.dataUrl) ? r : null;
  } catch(e){ return null; }
}

/* 点之前再瞄一眼：以模型给的点为中心裁 320x200、放大 3 倍，让它在【这张裁图里】
   重新给出目标中心，再映射回屏幕坐标。实测（tests/live，n=15，11px 单选圆点）：
   整屏 21.1px / 0 中 → 裁图内重定位 2.6px / 15 中。
   关键：裁图单独成一次请求、坐标只相对裁图。把它当成第二张图塞进原请求，
   模型会在两个坐标空间之间串位（2026-09-28 实测 10.5px → 36.2px）。
   失败/找不到就原样返回，绝不让这一步挡住点击。 */
async function refineClickPoint(sz, px, target){
  if (!state.apiKey || !state.previewDataUrl) return px;
  const rect = cropRectFor(px, sz);
  const crop = await annotateCrop(rect, px, false);     // 不画准星：别让它去对齐旧落点
  if (!crop) return px;
  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method:'POST', headers:{ Authorization:'Bearer ' + state.apiKey, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model: state.model, max_tokens: 80, thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: '你是看图定位的助手：只看图里的事实，不猜、不推测。' },
          { role: 'user', content: [
            { type: 'text', text: '这是屏幕某一小块区域的放大图（放大 3 倍）。\n' +
                '请找到「' + String(target || '').slice(0, 80) + '」，给出它可点击部分的中心' +
                '（圆形单选/复选框取圆心）。如果图里根本没有这个目标，x 和 y 都给 null。\n' +
                'x/y 用【这张图】的归一化坐标：0 到 1000，0=最左/最上，1000=最右/最下。\n' +
                '只输出 JSON {"x": 数字, "y": 数字}，不要其他文字。' },
            imageContent(crop.dataUrl),
          ]},
        ],
      }),
    });
    if (!resp.ok) return px;
    const j = await resp.json();
    const found = firstJsonObject(String((((j.choices || [])[0] || {}).message || {}).content || ''));
    if (!found) return px;
    const o = JSON.parse(found.text);
    if (o.x == null || o.y == null) return px;
    const nx = Number(o.x), ny = Number(o.y);
    if (!isFinite(nx) || !isFinite(ny) || nx < 0 || nx > 1000 || ny < 0 || ny > 1000) return px;
    const r = crop.rect || rect;
    return [Math.max(0, Math.min(sz.w - 1, Math.round(r.x + nx / 1000 * r.w))),
            Math.max(0, Math.min(sz.h - 1, Math.round(r.y + ny / 1000 * r.h)))];
  } catch(e){ return px; }
}

/* 拿落点放大图【单独】问一句"这一步生效了吗、正中间那个控件现在什么状态"，只要一句话。

   为什么单独一次调用、而不是把这张图塞进下一轮的动作请求（那正是原来的做法）：
   实测（tests/live/test-crop-feedback.mjs，n=9 单选圆点，两轮）——图塞进去以后模型会对着
   图上的十字重新犹豫，把一个本来已经点对的答案改偏（10.5px → 36.2px，最坏 90px 开外）；
   只给文字反馈则 10.1px，和"什么都不给"持平。但这张图【读控件状态】几乎不会错
   （同一批图判断题 36/36 全对）——这正是原来那个 changedPixels>=20 布尔值做不到的事。
   所以让这张图只干"读状态"这一件事，结论用【文字】回给模型：文字不干扰坐标。

   输入框里有没有字、单选/复选框勾没勾上，都靠它。失败就返回空串，不影响主循环。

   代价（2026-09-28 实测单次：图 = 960x600 裁图的 ~380 token，整屏 1920x1200 约 875 token）：
   每一步动作多约 413 token，等于动作请求（约 1227 token）的 +34%。换掉那个噪声布尔值，值。 */
async function readCropState(cropUrl, what){
  if (!cropUrl || !state.apiKey) return '';
  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method:'POST', headers:{ Authorization:'Bearer ' + state.apiKey, 'Content-Type':'application/json' },
      body: JSON.stringify({
        model: state.model, max_tokens: 120, thinking: { type: 'disabled' },
        messages: [
          // 这行系统提示同时是测试里"把状态判读和动作请求分开"的标记，别改（见 tests/lib/fake-dom.mjs）
          { role: 'system', content: '你是读图的助手：只看图里的事实，不猜、不推测。' },
          { role: 'user', content: [
            { type: 'text', text: '这是一小块区域的放大图（放大 3 倍），正中间那个位置就是要看的控件。\n' +
                // what 是 describeAction 给的，type 动作里会带上【整段敲进去的代码】——
                // 那会让这次读状态的请求白白涨几千 token，而且对"看图说状态"毫无用处。截断。
                '刚做过的动作是：' + String(what || '（没说是什么）').slice(0, 60) + '。\n' +
                '请用【一句话】说清正中间那个控件现在是什么状态：圆形单选/方形复选框要说清【已选中】还是【未选中】；' +
                '输入框要说清里面有没有文字、内容是什么；按钮要说清有没有按下的痕迹。\n' +
                '看不清就直接说看不清。不要推测、不要给坐标、不要输出 JSON。' },
            imageContent(cropUrl),
          ]},
        ],
      }),
    });
    if (!resp.ok) return '';
    const j = await resp.json();
    const t = String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
    return t.replace(/\s+/g, ' ').slice(0, 140);
  } catch(e){ return ''; }
}

/* 任务期间按住 T 说的话：标上是第几步之后听到的，帮模型判断哪句还是当下的要求。
   最多留最近 5 句——够它接住"点错了，是右边那个"，又不至于把上下文越拖越长。 */
function guidanceText(){
  if (!agent.guidance || !agent.guidance.length) return '';
  const lines = agent.guidance.map(function(g){ return '· （第' + g.step + '步后）' + g.text; });
  return '\n\n【用户在你做事期间说的话——如果是纠正或新要求，以它为准；已经过时的就忽略】\n' + lines.join('\n');
}

/* 组装这一轮的请求内容。
   图1 = 整屏截图（承重：所有定位都在它上面），固定在下标 1（有用例钉着这个位置）。
   图2 只有一种情况会来：模型自己用 look 要求凑近看。点完/打完不再自动附带落点放大图——
   那条路的结论已经由 readCropState 读成【文字】挂在"已执行步骤"里了，图反而会把坐标带偏。

   打包顺序是承重的，别改成"文字-图-文字-图"：2026-09-28 在同一批 9 条上实测（见 tests/live/test-crop-feedback.mjs），
   说明文字夹在两张图中间时，模型会改用最后看到的那张图（裁图）的坐标系，9/9 全答成裁图中心 (500,500)；
   把所有文字一次性前置、两张图随后，才是 6/9 点中。
   另外也别写"你上次对准了吗 / 给出修正后的位置"——那会诱导它把一个本来已经点对的答案挪偏。 */
function buildUserContent(taskText, mem, history, shot, crop, cropWhat, fgNote, guidance){
  const cropNote = crop
    ? '\n\n【这一轮有两张图】图1 = 整屏截图（承重：所有定位都在图1 上）；' +
      '图2 = 你上一步要求凑近看的地方（' + (cropWhat || '') + '），放大 3 倍，用来看清细节。\n' +
      'x/y 一律按【图1】整屏图的归一化坐标算；图2 只是给你看细节的，切忌拿图2 的坐标当答案。'
    : '';
  const parts = [
    { type: 'text', text: '任务：' + taskText +
      (mem ? '\n\n【之前这个会话里已经做过的事——只是背景，供你避免重复劳动】\n' + mem +
             '\n注意：上面是【它上次自己说的】，未经证实，不能当成"这件事已经做完"的证据；\n' +
             '也不能因为记忆里写着"已完成"就直接回 done——该动手还是要动手。' +
             '\n"继续做"就是接着上面最后停的地方往下做。'
           : '\n\n（这是本次会话的第一件事，没有之前的记忆）') +
      (guidance || '') +
      (fgNote || '') +
      '\n\n已执行步骤：\n' + history + cropNote + '\n\n请给出下一步动作。' },
    imageContent(shot),
  ];
  if (crop) parts.push(imageContent(crop));
  return parts;
}

/* ===== agent 循环（"大脑"）：看屏幕 -> 模型决定下一步 -> 执行 -> 回看 -> 继续 =====
   "回看"靠的是每一轮都重新截图：模型在决定下一步之前，先对照新截图和"已执行步骤"
   判断上一步有没有生效。这样不额外增加调用次数，又不会盲目重复同一个动作。 */
const AGENT_PROMPT = [
  '你是操作电脑的 agent。每轮你会收到：任务说明、你已经执行过的步骤、以及一张当前屏幕截图。',
  '你的工作：给出【下一个动作】，只输出一个 JSON 对象。',
  '',
  '每一步按这个顺序想（这是最重要的部分）：',
  '1. 这一步我要达成什么？那个目标在【当前屏幕上看得见】吗？',
  '   · 看不见 → 这一轮的动作就【必须是 scroll】，先把屏幕滚一滚去找它。此时【禁止点击任何东西】：',
  '     尤其不许去点右侧目录、章节/任务列表、页签、视频播放按钮、上一节/下一节这类"看起来能走"的东西——',
  '     那些不是在找题目，是在瞎逛。想滚哪块区域就把 x/y 给 scroll。',
  '   · 看得见 → 先估出它的位置，再点。',
  '2. 回头看"已执行步骤"：上一步生效了吗？',
  '   · 优先看「放大图判读：…」——那是我拿你上一步落点的放大图读出来的事实（生效没有、那个控件现在什么状态）。',
  '   · 只有「落点附近看不出变化」、没有判读时，先想想你点的是不是输入框——输入框只有光标在闪（而且会闪灭），本来就看不出变化。这种情况别重试同一个点，继续下一步。',
  '3. 一次只给一个动作，写进 JSON。',
  '',
  '可用动作（这就是你的"手"，用它们组合出各种操作）：',
  '  click   {"action":"click","target":"点什么（人话描述）","x":0到1000,"y":0到1000,"button":"left|right","double":true,"modifiers":["ctrl"]}',
  '  type    {"action":"type","target":"输入框","text":"要输入的内容","x":0到1000,"y":0到1000,"replace":true}   x/y 必填',
  '  type   默认就【一行一行敲】{"action":"type","target":"要输入的框","text":"内容","x":0到1000,"y":0到1000}',
  '          用真键盘逐字敲，用户能看着它写；不走剪贴板——所以答题页禁用粘贴（Ctrl+V 无效）也照样输得进。',
  '          它【不会】先全选，是"从落点那一行开始往下覆盖"，所以要改哪里就把落点放到哪一行。写代码一律用它。',
  '          只有明确要粘贴（超长文本、想快）才写 "lineByLine": false。',
  '',
  '  type 默认【不】先清空框：输入前先确认框是空的；框里有旧内容就先发一个 ctrl+a 全选再输。写 "replace": true 会让它先全选。',
  '',
  '带工具栏的网页富文本编辑器（超星作业框、UEditor 这类）有两条坑，务必记住：',
  '· 你在行首打「1. 」，编辑器会自动再加一个编号，显示成「1. 1. …」。这不是内容写了两遍，是自动编号叠加，',
  '  不要因此去删内容或整段重写。写条目就别打行首的「1./2.」：用「一、二、」和「·」列点，或点一下工具栏的编号按钮让它自己编号。',
  '· 整段覆盖旧内容：先点一行【确认在编辑框内部】的文字（不确定就 look 放大看），再 Ctrl+A，确认整段都高亮了再输入。',
  '  如果同一段内容整段重写了一次、屏幕上旧的还在，说明全选或落点出了问题：不要原样再写一遍（只会多出一份），先核对落点；还不行就用 say 说明，让我手动改。',
  '· 写完一大段内容不要来回滚动反复核对：type 返回的 chars 就是你敲进去的字数，长文本一屏看不全很正常。',
  '  滚到开头看一眼就够了；来回滚 2 次以上就是在空转，确认写进去了就直接进行下一步（比如提交）或 done。',
  '',
  '  scroll  {"action":"scroll","direction":"up|down|left|right","amount":格数,"x":0到1000,"y":0到1000}   x/y 可选：先把鼠标移过去再滚',
  '  drag    {"action":"drag","target":"拖的是什么","fromX":0到1000,"fromY":0到1000,"toX":0到1000,"toY":0到1000}',
  '  key     {"action":"key","keys":"tab / enter / space / esc / ctrl+tab / ctrl+l / f5 / 组合键"}',
  '  open_app {"action":"open_app","app":"程序名（开始菜单里的名字，如 Visual Studio Code）"}',
  '  open_url {"action":"open_url","url":"https://…"}   只允许 http/https',
  '  wait    {"action":"wait","ms":毫秒}',
  '  say     {"action":"say","text":"要说明的话"}',
  '  done    {"action":"done","reason":"完成情况，或为什么无法继续"}',
  '',
  '什么时候用哪个——这比动作本身更重要：',
  '· 键盘常常比鼠标可靠。点不中的东西先试键盘：Tab 换焦点、Space 勾选、Enter 确认、Esc 关弹窗或取消、',
  '  Ctrl+Tab 切标签页、Ctrl+W 关标签页、F5 刷新、PageDown/PageUp 翻页。',
  '· 右键能出上下文菜单；双击用于打开条目。',
  '· 要按住 Ctrl/Shift 再点（多选文件、Shift 连选一片、Ctrl 点链接开新标签）：click 加 "modifiers":["ctrl"] 或 ["shift"]。',
  '· 要打开程序或网页，优先用 open_app / open_url，不要再去任务栏、开始菜单里找图标点——那要好几步还容易点偏。',
  '  open_app 只认开始菜单里的快捷方式：找不到就如实失败并换一个名字，不要改用瞎点。',
  '· drag 用于：滑块、拖放排序、拖选文字、拖动滚动条。',
  '· 目标看不见 → 这一轮就只滚动，用 scroll 把它找出来。看不见还去点别的东西 = 原地打转，是最容易被骂的行为。',
  '',
  '任何动作都可以额外带一个 "say" 字段，一边做一边用一句话说明。例如：',
  '{"action":"click","target":"B. 7","x":281,"y":168,"say":"f(3)=2×3+1=7，只有 B 符合"}',
  '"say" 是可选的：答题、做选择、判断对错时要带上；只是机械操作（滚动、翻页、等待）就别废话。',
  '',
  '坐标规则：x/y 是【整个屏幕】的归一化坐标，0 表示最左/最上，1000 表示最右/最下。绝对不要给像素值。',
  '  有第二张图时，也一律按【图1 整屏图】算，第二张图只是给你看细节的、不要拿它的坐标当答案。',
  '',
  '关于你看到的图：图1 永远是整屏截图，所有定位都在它上面。',
  '· 多数时候只有这一张。你上一步动作的落点【不在图上画出来】——它变成了"已执行步骤"里的一句',
  '  「放大图判读：…」，那是机器拿落点放大图读出来的【事实】（点到了什么、那个控件现在什么状态），',
  '  比「落点附近看不出变化」那个布尔值可靠得多，判"上一步生效没有"以它为准。',
  '· 只有你用 look 要求凑近看时，才会多出第二张图（那块地方的放大图）。',
  '· 看不清某个地方（太小的圆圈、太密的行）→ 用 look 放大再看，不要靠猜。',
  '  look  {"action":"look","target":"要看的是什么","x":0到1000,"y":0到1000,"w":200,"h":150}',
  '       x/y 是位置，w/h 是要多大一块（可省略）。look 只放大给你看，不动鼠标。',
  '',
  '硬性要求：',
  '· 要选某个选项时，点【那行文字】的位置，而且要偏中间——不要点文字右边的空白（那通常点不动），也不要点左边那个小圆圈/小方框（太小，点不准）。',
  '· 复选框里已经勾上的，再点一次会【取消】；单选按钮点已经选中的那个不会取消（但也没意义）。',
  '  所以「放大图判读」说它已经选中/已经勾上了，就别再点它；要改答案去点【别的选项】。同一个选项不要点两次。',
  '  我刚点完一个选项，判读却说它【没选中】——那多半是没点中，位置往那行【文字中间】挪一点再点。',
  '· 要滚动就用 scroll，绝对不要为了"让页面获得焦点"去点空白处——滚轮不需要焦点，那种点击很容易戳到选项。',
  '· 提交/交卷这类不可逆操作之前先核对答案；提交后如果没过，先找出哪一题错了再改，不要反复提交。',
  '· 填空题一个空一个空来：点第 N 空 → 输入 → 看截图确认填对了 → 再点下一空。不要把几个空的值都打进同一个框。',
  '· 往代码编辑器里写代码/改代码：一律用 lineByLine，一行一行敲，别用粘贴。',
  '  · 粘贴是一瞬间整段糊上去，用户看不见你写了什么；一行一行敲他能看着，也能随时喊停。',
  '  · 粘贴模式下想改一处，往往只能"全选 + 整段重贴"（把整个文件先删掉）——这是一定要避免的。',
  '  · 一行一行敲是【从落点那一行开始往下覆盖】，所以改哪一行就把落点放在那一行，只重敲那一行。',
  '  · 内容必须是【完整文件】（从第一列的 class Solution: 开始），不要只贴方法体。',
  '    实测：贴了一段不带 class Solution: 开头的片段之后，编辑器第 1 行多出了 8 个空格，提交直接 IndentationError 0 分。',
  '  · 敲完必须看一眼第一行是不是【顶格】、前面有没有多出来空格。',
  '· 每轮还会给你一行【当前前台窗口】（应用名 + 窗口标题），它和截图是同一时刻的：键盘焦点就在那个窗口上。',
  '  如果它不是你要操作的目标，先切过去再动手；如果它写的是"助手自己的窗口"，说明按键会打到我身上——',
  '  先点一下目标窗口把焦点交出去，再按键。截图里不会出现助手自己的窗口。',
  '· done 是【收工信号】，只在"任务要我做的全部事情都已经做完"时才用。',
  '  · 如果你知道接下来该做什么（哪怕是"应该先去掉缩进、再重新提交"），那就【去做】，不要用 done 把话说完就停。',
  '  · 如果你认为已经不用做了，reason 里要指出截图上的【具体证据】（哪个位置显示了什么），不能只说"应该已经完成了"。',
  '  · 前面给你的"之前做过的事"是记忆，不是你不用动手的理由：它只帮你避免重复劳动，不代表这件事现在已经做完。',
  '· 只能依据当前这张截图。看不清或找不到，先用 scroll 找，再考虑 say 说明；done 不是用来逃避动手的。',
  '· 动作必须和你的理由一致：判断"不选 D"就不要去点 D。',
  '· 不要连续使用 wait，等一次就够。',
  '· 一律用简体中文。'
].join('\n');

/* 不设"到点就杀"的步数上限：任务没做完就继续做，停不停由你决定（停止键 / ■）。
   但跑到很多步还在做时会【停下问你】要不要继续——那是问，不是判死（见循环里的 STEP_CAP）。
   另有三类真熔断仍然保留（连续看不懂回复、连续执行失败），它们判的是"机器出了故障"，
   与"跑了几步"无关。 */
const STEP_CAP = 60;
const agent = { running:false, stop:false, step:0, fails:0, donePushes:0, scrollN:0, scrollDir:'', scrollTotal:0, task:'', log:[], recentClicks:[], liveLines:[], guidance:[], submitBlocks:0, cropTarget:null, blockedN:0, blockedHwnd:null };

/* 运行中的实时流水账：让你一眼看到它每一步在点哪儿、坐标多少、生效没有。
   点错了你好及时叫停——这比事后看摘要有用得多。 */
function livePush(line){
  agent.liveLines.push(line);
  if (agent.liveLines.length > 60) agent.liveLines.shift();
  const bar = document.getElementById('answerbar');
  document.getElementById('answer').innerHTML = s(agent.liveLines.join('\n'));
  bar.style.display = 'block';
  bar.scrollTop = bar.scrollHeight;
}

function describeAction(a){
  if (a.action === 'click') {
    const mod = Array.isArray(a.modifiers) && a.modifiers.length ? a.modifiers.join('+') + ' + ' : '';
    return mod + '点击「' + a.target + '」';
  }
  if (a.action === 'type') return (a.target ? '在「' + a.target + '」' : '') + '输入「' + a.text + '」';
  if (a.action === 'scroll') return ({up:'向上',down:'向下',left:'向左',right:'向右'}[a.direction] || '') + '滚动 ' + a.amount + ' 格';
  if (a.action === 'key') return '按 ' + a.keys + ' 键';
  if (a.action === 'wait') return '等待 ' + a.ms + ' 毫秒';
  if (a.action === 'open_app') return '打开程序「' + a.app + '」';
  if (a.action === 'open_url') return '打开网址 ' + a.url;
  if (a.action === 'say') return '说：「' + String(a.text).slice(0, 60) + '」';
  if (a.action === 'drag') return '把「' + a.target + '」从 (' + a.fromX + ',' + a.fromY + ') 拖到 (' + a.toX + ',' + a.toY + ')';
  if (a.action === 'look') return '凑近看「' + a.target + '」';
  return a.action;
}

/* 一步的日志写成一行：既能给人看，也能当作下一轮给模型的"已执行步骤" */
function logLine(e){
  const chg = e.changed === true ? '  ｜ 落点附近有变化'
            : e.changed === false ? '  ｜ 落点附近看不出变化（点输入框时属正常，不要因此重试同一个点）' : '';
  // "放大图判读"是机器拿落点放大图读出来的【事实】（生效没有、那个控件现在什么状态），
  // 比上面那个布尔值可靠得多——它分得清"点到旁边空白 / 本来就选中了 / 输入框只有光标在闪"。
  const st = e.state ? '  ｜ 放大图判读：' + e.state : '';
  return '#' + e.n + ' ' + e.what + (e.result ? ' -> ' + e.result : '') + (e.reason ? '  理由：' + e.reason : '') + chg + st;
}

/* ===== 记忆 =====
   两个层次，缺一不可：
   ① 一件事内部：跑到第 20 步时，前 12 步的明细还在不在（以前只给最后 12 步，跑过就失忆）？
   ② 事件之间：用户说"继续做"，它得知道上一件事干到哪了（以前每起一个任务就全清空）。 */
function loadMemory(){
  try {
    const v = JSON.parse(localStorage.getItem('dsh_task_memory') || '[]');
    return Array.isArray(v) ? v : [];
  } catch(e){ return []; }
}
function saveMemory(){
  try { localStorage.setItem('dsh_task_memory', JSON.stringify(state.taskMemory.slice(-5))); } catch(e){}
}
/* 到目前为止做过的动作（去重 + 次数）。这是"别把做过的题再做一遍"最省 token 的说法。
   不用 Map：沙箱里不保证有，用普通对象就够了。 */
function didDigest(limit){
  const keys = [], counts = {};
  for (const e of agent.log) {
    const k = String(e.what || '').trim();
    if (!k) continue;
    if (counts[k] === undefined) { counts[k] = 0; keys.push(k); }
    counts[k]++;
  }
  const out = [];
  for (let i = 0; i < keys.length && out.length < (limit || 40); i++) {
    out.push('· ' + keys[i] + (counts[keys[i]] > 1 ? ' ×' + counts[keys[i]] : ''));
  }
  if (keys.length > out.length) out.push('· （另 ' + (keys.length - out.length) + ' 种动作没列出）');
  return out.join('\n');
}
/* 给模型看的"已执行步骤"：最后 12 步保留明细，更早的折叠成"做过什么"的摘要 */
function historyForModel(){
  const lines = agent.log.map(logLine);
  if (lines.length <= 12) return lines.join('\n') || '（还没有执行任何步骤）';
  const earlier = lines.slice(0, -12);
  return '【更早的 ' + earlier.length + ' 步——别重做，这里说的是你干过什么】\n' + didDigest(30) +
    '\n【更早那些步的明细（最后 25 条）】\n' + earlier.slice(-25).join('\n') +
    '\n【最近 12 步明细】\n' + lines.slice(-12).join('\n');
}
/* 之前几件事的记忆，拼成给模型看的一段话。
   措辞很重要：实测里它读到上一件事的"已提交并通过"，第一步就回 done 交差，一个动作都没做。
   所以这里必须写明"这是它上次自己说的、未经证实"，并点明"记忆≠这件事已经做完"。 */
function memoryText(){
  if (!state.taskMemory.length) return '';
  const parts = [];
  const recent = state.taskMemory.slice(-3);
  for (let i = 0; i < recent.length; i++) {
    const m = recent[i];
    parts.push('· 事情' + (i + 1) + '：' + (m.task || '（没说做什么）') +
      '\n  它当时做过的：' + (m.did || '（没有记录）') +
      '\n  它当时自己声称的结局：' + (m.ending || '（没记录）'));
  }
  const last = state.taskMemory[state.taskMemory.length - 1];
  if (last && last.tail) parts.push('· 最后一件事停在哪：\n' + last.tail);
  return parts.join('\n');
}
function rememberTask(ending){
  state.taskMemory.push({
    task: agent.task,
    ending: ending,
    did: didDigest(15),
    tail: agent.log.slice(-5).map(logLine).join('\n'),
    at: new Date().toISOString().slice(0, 19),
  });
  if (state.taskMemory.length > 5) state.taskMemory.shift();
  saveMemory();
}

/* 实时流水用的紧凑一行：重点是"点了什么、落到哪" */
function liveLine(e){
  const at = e.clickPx ? '  → 落点 (' + e.clickPx[0] + ',' + e.clickPx[1] + ')' : '';
  return '#' + e.n + ' ' + e.what + at + (e.reason ? ' ｜ ' + e.reason : '');
}

/* 目标是不是"输入框"类。输入框点中了也只有光标在闪（还会闪灭），看不出变化属正常；
   但按钮/选项这类，看不出变化就意味着【没点中】——实测里点选项右边的空白就是这样，
   超星只认点在文字上。两种情况要给出不同的判断，否则要么误报要么漏报。 */
function looksLikeTextField(action){
  return /输入框|填空|答案框|搜索框|文本框|编辑框|栏/.test(String(action.target || '') + ' ' + String(action.text || ''));
}

/* 让模型决定下一步，返回它的原始回复文本 */
async function agentDecide(){
  await capturePreview();                                  // 每步都重新截图
  const shot = state.previewDataUrl || '';
  let fg = null;
  try { if (typeof api.foregroundInfo === 'function') fg = await api.foregroundInfo(); } catch(e) { fg = null; }
  // 用新截图和上一步动作前的截图比较【落点附近】：上一步到底有没有起作用。
  // 只看落点附近的小块，页面别处在动（比如视频）也不会干扰。
  const last = agent.log[agent.log.length - 1];
  if (last && last.clickPx && last.shotBefore && !last.diffDone) {
    last.diffDone = true;
    try {
      const r = await api.imageDiff({ a: last.shotBefore, b: shot,
        rect: { x: last.clickPx[0] - 120, y: last.clickPx[1] - 80, w: 240, h: 160 } });
      if (r && r.ok) {
        last.changed = r.changedPixels >= 20;
        // 措辞很关键，而且两种情况要分开说：
        //  · 点输入框：只有光标在闪（还会闪灭），看不出变化属正常——以前一律说"可能没生效"，
        //    模型就反复重试，被守卫拦到卡死。
        //  · 点选项/按钮：看不出变化就是【没点中】——实测里落点偏到选项文字右边的空白，
        //    超星只认点在文字上，于是选项没勾上，最后交卷才发现漏选。
        const input = looksLikeTextField(last || {});
        livePush('　　↳ ' + (last.changed
          ? '落点附近有变化'
          : input
            ? '落点附近看不出变化（点输入框只有光标闪动，属正常，别因此重试）'
            : '落点附近看不出变化 —— 很可能【没点中】：下次把落点放到那行【文字】上（偏中间），别点在文字右边的空白处'));
      } else {
        last.changed = null;                     // 没比成：不确定，别拿它当"没生效"的依据
      }
    } catch(e){}
    last.shotBefore = null;                                // 别一直攥着大图
  }
  // 上一步的落点放大图，两个用途分开走（为什么不合并成"把图塞进这一轮请求"见 readCropState 的注释）：
  //  · 点完/打完/拖完 → 图上【不画准星】，只让 readCropState 读一句"生效没有、控件什么状态"，
  //    结论写成文字挂在上一句日志上（logLine 会带给模型）。这一轮请求里【不放这张图】。
  //  · look（模型自己开口要看）→ 那是它的眼睛，图原样附带（带准星）。
  let crop = null, cropWhat = '', cropState = '';
  if (agent.cropTarget) {
    const ct = agent.cropTarget;
    agent.cropTarget = null;
    if (ct.crop) {
      crop = ct.crop;
      cropWhat = ct.what || '';
    } else if (ct.px) {
      try {
        const sz = await screenPxSize();
        const got = await annotateCrop(cropRectFor(ct.px, sz), ct.px, false);
        if (got) cropState = await readCropState(got.dataUrl, ct.what);
      } catch(e){ cropState = ''; }
      if (cropState && last) last.state = cropState;      // 挂到上一步那条日志上，history 才带得出去
    }
  }
  const history = historyForModel();
  const wantThink = document.getElementById('thinkToggle') ? document.getElementById('thinkToggle').checked : false;
  const mem = memoryText();
  const body = {
    model: state.model, max_tokens: 8000,
    messages: [
      { role: 'system', content: AGENT_PROMPT },
      { role: 'user', content: buildUserContent(agent.task, mem, history, shot, crop, cropWhat, foregroundNote(fg), guidanceText()) },
    ],
  };
  // 思考默认【关】：实测开着一分钟也跑不了几步（每步 1.5~6 秒且抖动大），
  // 关掉稳定在 ~1.0 秒/步。要更准可以在面板上勾「思考模式」自己试。
  if (!wantThink) body.thinking = { type: 'disabled' };
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST', headers:{ Authorization:'Bearer ' + state.apiKey, 'Content-Type':'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) { const t = await resp.text().catch(function(){ return ''; }); throw new Error('HTTP ' + resp.status + '：' + t.slice(0, 160)); }
  const j = await resp.json();
  const choice = (j.choices || [])[0] || {};
  const msg = choice.message || {};
  // 记下这次响应的元信息：出问题时不用再猜"到底是超长截断还是模型乱答"
  agent.lastMeta = {
    finish: choice.finish_reason,
    reasoningTokens: (j.usage && j.usage.completion_tokens_details && j.usage.completion_tokens_details.reasoning_tokens) || 0,
    completionTokens: (j.usage && j.usage.completion_tokens) || 0,
    hadToolCalls: !!(msg.tool_calls && msg.tool_calls.length),
    contentLength: String(msg.content || '').length,
  };
  if (msg.content) return msg.content;
  // 有些时候它不把动作写在 content 里，而是用【工具调用】的格式发出来——直接翻译成我们的动作
  const tc = (msg.tool_calls || [])[0];
  if (tc && tc.function) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch(e){}
    return JSON.stringify(Object.assign({ action: tc.function.name }, args));
  }
  return '';
}

/* 逐步确认整个去掉了（反馈：没用，还要我腾出手去点它，反而把要点的东西挡住）。
   现在它自己跑，你盯着流水账看，不对就按停止热键。 */

/* 每一步都留证据：当时的截图、模型的原话、决定点的位置、实际结果。
   出问题时可以直接看它到底看到了什么、为什么点那里，不用靠猜。 */
async function runLog(file, dataUrl, json){
  if (!state.runId) return;
  try { await api.runArtifact({ run: state.runId, file: file, dataUrl: dataUrl || '', json: json }); } catch(e){}
}

/* 重复点击守卫：复选框/单选框再点一次就是取消选择。
   实测里模型会在两步内把同一个选项点两次，把刚选好的又取消掉。
   目标文字和落点双重判断——因为同一个元素它给的坐标能差一倍。 */
/* 重复点击守卫：复选框/单选框再点一次就是取消选择，所以要拦。
   但判据必须看【上一次点它到底生效没有】：
     · 上次生效了（落点附近有变化）→ 再点就是把勾取消 → 拦
     · 上次压根没点中（落点附近没变化）→ 那次点击是被浪费的，重新点它是【合理】的 → 不能拦
   以前不管有没有点中都拦，结果和"提交前自查"互相打架：自查说"A 没选中，去补选"，
   守卫说"A 你点过了，不许点"，来回拉锯烧掉一半步数。
   所以 recentClicks 里存的是日志条目本身（同一个对象），好让它能读到后面算出来的 changed。 */
function repeatedClick(action){
  const key = String(action.target || '').replace(/\s+/g, '');
  const px = (action.x != null && action.y != null) ? [Number(action.x), Number(action.y)] : null;
  for (let i = agent.recentClicks.length - 1; i >= 0 && i >= agent.recentClicks.length - 4; i--) {
    const c = agent.recentClicks[i];
    if (c.changed === false) continue;              // 上次没生效（没点中）→ 允许重点
    if (key && c.key && sameTargetKey(key, c.key)) {
      // 实测：点完"提交按钮"弹出确认框，模型接着点"弹窗中的提交按钮"，
      // 文字几乎一样但那是【另一个东西】，被守卫连拦 3 次白白烧掉步数。
      // 带弹窗/确认标记的和不带的分开看。
      if (isDialogTarget(key) !== isDialogTarget(c.key)) continue;
      return { n: c.n, how: '点过「' + action.target + '」' };
    }
    if (px && c.norm) {
      const dx = Math.abs(c.norm[0] - px[0]), dy = Math.abs(c.norm[1] - px[1]);
      // 阈值 1.2%：模型对同一个目标的坐标抖动能到 1%，卡太紧会漏掉
      if (dx < 12 && dy < 12) return { n: c.n, how: '点过同一个位置' };
    }
  }
  return null;
}

/* 目标是不是"弹窗里的按钮"。弹窗按钮和页面上的同名按钮是两个不同的东西。 */
function isDialogTarget(t){
  return /弹窗|对话框|确认|提示框/.test(String(t || ''));
}

/* 模型很爱给同一个目标换说法（加「标题文字」「链接」「（取消勾选）」等后缀），
   精确比对会漏。所以：互相包含就算同一个，共同前缀够长也算同一个。 */
function sameTargetKey(a, b){
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  if (shorter.length >= 3 && longer.indexOf(shorter) >= 0) return true;
  let n = 0;
  while (n < shorter.length && shorter[n] === longer[n]) n++;
  return n >= 8 && n / shorter.length >= 0.6;
}

/* 这段文字像不像"代码"。用来【强制】走逐行敲。
   为什么必须由代码强制：实测里提示词写了"写代码一律用 lineByLine"，模型照样发
   {"action":"type","target":"代码编辑器（已全选，整块替换…）"}、不写 lineByLine，
   用户看到的就是"没有一行一行，还是啪一下整块糊上去"。靠嘴求它没用，这里直接替它决定。 */
function looksLikeCode(a){
  const target = String(a.target || '');
  const text = String(a.text || '');
  if (/编辑器|代码框|代码区|code\s*editor/i.test(target)) return true;
  return /class\s+Solution|^\s*def\s|^\s*import\s|^\s*from\s+\w+\s+import|^\s*return\s/m.test(text);
}
/* 这次任务里"点过、但落点附近【没有任何变化】"的选项。
   这类点击是【不敢确定】的：可能是没点中，也可能是它本来就已选中，光看落点分不出来。
   实测（数字经济治理那道多选）：连点 A/B/C/D 五个选项，落点全都没变化，
   提交前的自查却让模型去"整页比对"，模型回了个 ok:true —— 结果只选中 A、B，得 50 分。
   教训：小圆圈选没选中，靠模型扫一眼整页最不可靠；要把这些项【单独拎出来逐个问】，
   而且"没选中"这个结论由代码来拍板，不给模型说 ok 的机会。 */
function unconfirmedOptions(){
  const seen = {}, out = [];
  for (const e of agent.log) {
    if (e.changed !== false) continue;      // 只有"点了没反应"才需要追问
    if (!e.clickPx) continue;               // 不是点击动作（滚动/输入/等待都没有落点）
    const t = String(e.target || '').trim();
    if (!t) continue;
    if (!/选项|单选|多选|判断|^[A-D][.．、]|[A-D][.．、]\s/.test(t)) continue;
    if (seen[t]) continue;
    seen[t] = 1; out.push(t);
  }
  return out.slice(-8);
}

/* 交卷前自查：拿当前截图 + 自己这次做过的操作记录，逐题核对"打算选的"和"实际选中的"是否一致。
   实测里出现过"点了 D 但落点偏到右边空白，没点上，最后交卷才发现漏选"，
   所以提交这一步必须由代码强制拦一道，不能指望模型自己记得检查。 */
async function verifyBeforeSubmit(shot){
  const history = historyForModel();
  const risk = unconfirmedOptions();
  let ask = '你这次任务做过的操作记录：\n' + history
    + '\n\n请对照这张当前截图，逐题核对：记录里你打算选/填的答案，和截图里【实际选中】的是否完全一致。\n'
    + '（选中的选项一般是高亮/勾选状态，没选中的是灰的。填空看框里有没有字。）\n'
    + '只输出一个 JSON：{"ok": true 或 false, "unselected": ["没选中的选项原文"], "problems": ["具体哪一题哪里对不上", "..."]}\n'
    + '完全一致才 ok=true；有一点对不上就 ok=false。';
  if (risk.length) {
    // 这些项是"点了但没反应"的，别让它在整页里自己找——直接点名字问。
    ask += '\n\n【重点，必须逐条回答】下面这些选项你点过，但落点附近【一点变化都没有】，'
      + '所以无法确定到底选上没有。请只盯住它们，一个一个看截图里它们前面的圆圈/方框'
      + '（实心或打勾=已选中，空心=没选中），把【没选中】的原文照抄进 "unselected"；全都选中了就给空数组 []。\n'
      + risk.map(function(t){ return '· ' + t; }).join('\n');
  }
  const body = {
    model: state.model, max_tokens: 800,
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: '你是操作电脑的 agent，现在要做【交卷前的自查】。' },
      { role: 'user', content: [
        { type: 'text', text: ask },
        imageContent(shot),
      ]},
    ],
  };
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST', headers:{ Authorization:'Bearer ' + state.apiKey, 'Content-Type':'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  const ans = String((((j.choices || [])[0] || {}).message || {}).content || '');
  const found = firstJsonObject(ans);
  if (!found) throw new Error('自查结果不是 JSON');
  const o = JSON.parse(found.text);
  const unselected = Array.isArray(o.unselected) ? o.unselected.map(String).slice(0, 8) : [];
  // 代码拍板：它嘴上说 ok，但只要列出了"没选中"的项，就不算过。
  const problems = Array.isArray(o.problems) ? o.problems.map(String).slice(0, 8) : [];
  const ok = o.ok === true && unselected.length === 0;
  if (!ok && !problems.length) {
    for (const u of unselected) problems.push('「' + u + '」点了但没选中');
  }
  return { ok: ok, problems: problems, unselected: unselected };
}

async function runTask(task, originVoice){
  if (agent.running) { actStatus('已有任务在跑'); return; }
  if (!state.apiKey) { showAnswer('请先设置 API Key', 'warn', true); return; }
  task = String(task || '').trim();
  if (!task) { actStatus('请先填写任务'); return; }
  // 坐标是按【整个屏幕】算的。如果捕捉源选的是某个窗口，图里的归一化坐标和屏幕坐标对不上，点哪都错。
  const srcId = String(state.selectedSourceId || '');
  if (srcId && srcId.indexOf('screen') !== 0) {
    const sname = (state.sources.filter(function(x){ return x.id === srcId; })[0] || {}).name || srcId;
    actStatus('捕捉源不是整个屏幕，已中止');
    showAnswer('捕捉源现在选的是「' + sname + '」，这是某个窗口，不是整个屏幕。\n\n坐标是按整个屏幕算的，用窗口当捕捉源会点错位置。请把「捕捉」下拉框切回「整个屏幕」再跑。', 'warn', true);
    return;
  }

  agent.running = true; agent.stop = false; agent.step = 0; agent.fails = 0; agent.donePushes = 0;
  agent.scrollN = 0; agent.scrollDir = ''; agent.scrollTotal = 0;
  agent.log = []; agent.recentClicks = []; agent.liveLines = []; agent.task = task;
  agent.guidance = [];
  agent.verifiedSubmit = false; agent.submitBlocks = 0;
  agent.cropTarget = null;
  agent.blockedN = 0; agent.blockedHwnd = null;
  state.runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + Math.random().toString(36).slice(2, 6);
  try { await api.clearStop(); } catch(e){}
  if (!state.active) await enterActive(false);
  // 任务期间切到 ptt：环境音由 python 直接丢掉，只有按住 T 说的那段会被收。
  // 注意顺序——先切模式再开麦，麦克风刚起来的那个进程一上来就是 ptt，不会先听一段。
  try { await api.setSpeechMode('ptt'); } catch(e){}
  // 任务模式下必须开着麦克风：做完一个还要接着听下一件，不能让你退出重进
  if (state.mode === 'task' && !state.micActive) { try { await enableMic(); } catch(e){} }
  sendPttContext();
  actStatus('任务开始');
  livePush('任务：' + task);
  // 有记忆就先亮出来：你说"继续做"时，能一眼看出它到底记不记得上一件事
  const memNote = memoryText();
  if (memNote) {
    livePush('🧠 记得之前做过：' + state.taskMemory.slice(-3).map(function(m){ return '「' + (m.task || '') + '」'; }).join('、'));
  } else {
    livePush('🧠 没有之前的记忆（这是本次会话第一件事）');
  }
  // 这是语音来的任务就把原话也记下来：你能看出它是"听错了"还是"理解错了"
  if (originVoice) livePush('（语音识别原文：「' + originVoice + '」）');
  livePush(state.micActive
    ? '任务期间按住 T 说话：说的会带进下一步判断（不用等它做完）；要中止就 ' + (state.hotkeyOk.stop === false ? '点状态条上的 ■（热键不可用）' : '按 ' + state.hotkeys.stop + '、点 ■') + '，或按住 T 说「暂停」'
    : '「按住 T 说话」需要先开麦克风；要中止就 ' + (state.hotkeyOk.stop === false ? '点状态条上的 ■（热键不可用）' : '按 ' + state.hotkeys.stop + '，或点 ■'));
  livePush('');

  // 把键盘焦点从小球还给用户刚才在用的窗口：否则第一步若是纯按键，会打到助手自己身上。
  try { if (api.restoreFocus) await api.restoreFocus(); } catch(e){}

  let ending = '任务结束';
  try {
    while (!agent.stop) {
      // 先把主线程让出去一次（宏任务，不是微任务）。
      // 这是必须的：万一每步都快得几乎不花时间（接口秒回、图片缓存命中），
      // 光靠 await 只会在微任务队列里打转，setTimeout / 你点 ■ / 热键全排不上队——
      // 表现就是"它自己停不下来、界面也点不动"。让一次的成本约 1ms，相对每步的真实耗时可以忽略。
      await new Promise(function(r){ setTimeout(r, 0); });
      let hitHotkey = false;
      try { hitHotkey = await api.stopRequested(); } catch(e){}
      if (hitHotkey) { agent.stop = true; break; }

      // 跑了很多步还在做 → 停下【问你】，不是判它死。
      // 原来这里有个"步数上限到了就停"的硬熔断，问题在于它把"正在干的活"也一并杀掉了
      // （实测它一边写代码一边被上限砍断）。现在改成问一句，你点一下继续就能接着跑。
      if (agent.step >= STEP_CAP) {
        ending = '停下来问你：已经跑了 ' + agent.step + ' 步，它还在做。要继续吗？' +
          '（想让它接着做就再按一次开始/说"继续"；不想了就按停止键）';
        livePush('⏸ ' + ending);
        break;
      }

      agent.step++;
      const rec = { step:agent.step, task:agent.task, shot:'', raw:'', action:null, at:'', result:'' };
      try {
        actStatus('第 ' + agent.step + ' 步：看屏幕…');
        let raw;
        try { raw = await agentDecide(); }
        catch(e){ rec.result = '模型调用失败：' + e.message; ending = rec.result; break; }
        rec.raw = raw;
        rec.shot = state.previewDataUrl || '';
        rec.meta = agent.lastMeta || null;      // finish_reason / 思考开销：出问题时一眼就能看出是哪类

        let action;
        try { action = parseAction(raw); }
        catch(e){
          rec.result = '回复无法解析：' + e.message;
          agent.fails++;
          agent.log.push({ n:agent.step, what:'（回复无法解析）', result:e.message });
          if (agent.fails >= 3) { ending = '连续 3 步看不懂模型的回复，已停止'; break; }
          actStatus('第 ' + agent.step + ' 步：回复无法解析，重试');
          continue;
        }
        rec.action = action;
        if (action.action === 'done') {
          // done 就是收工信号。实测（LeetCode 那次）它把 done 当成了"交差/解释"用：
          //  ① 看着记忆里上一件事的"已提交并通过"，第一步就回 done，一个动作都没发；
          //  ② 明明已经把修法写清楚了（"取消缩进后重新提交"），却回 done 说"就此停止并说明"。
          // 用户要的是"能动手就动手"。所以这两种 done 一律推回去让它干活。
          const doneReason = String(action.reason || '');
          const didSomething = agent.log.some(function(e){ return String(e.result || '').indexOf('已执行') === 0; });
          const describesNextMove = /下一步|接下来|然后|应该先|可以先|建议|需要先|可以继续|还需|尚未|有待|修正|修复/.test(doneReason);
          // 实测原话（2801 题那次收尾）："仍停留在「执行出错」的提交结果页…我无法通过滚动或点击
          // 取得可验证的可靠落点…故在此说明停止。" —— 理由里自己都说没做完，却用 done 收工。
          const admitsUnfinished = /无法|没法|做不到|放弃|尚未|还没|没能|未能/.test(doneReason);
          if (agent.donePushes < 2 && (!didSomething || describesNextMove || admitsUnfinished)) {
            agent.donePushes++;
            rec.result = '它想收工，但活还没干 —— 已推回去';
            const why = !didSomething ? '一个动作都还没执行'
                      : admitsUnfinished ? '理由里自己都说没做完'
                      : '只是把下一步写在了嘴里';
            agent.log.push({ n:agent.step, what:'（想结束，被推回去接着做）', result:
              (didSomething ? '' : '你到这一步【一个动作都还没执行】。\n') +
              (admitsUnfinished ? '你自己的 reason 里都写着做不到/还没完成，那就更不能收工了。\n' : '') +
              '这条任务是让我动手做的，不是让我说明的。\n' +
              '· 如果你确实认为不用做，请在 reason 里指出截图上的【具体证据】（哪个位置显示了什么），并且不要说"无法/没能/尚未"。\n' +
              '· 如果还有该做的事（包括你自己在 reason 里写到的"下一步/应该/需要先/无法…"），那就【现在就去做那个动作】，不要用 done 收尾。\n' +
              '· 找不到入口时：换页签、用键盘（Ctrl+F / Tab）、或者先滚回去看看整页结构，别急着收工。' });
            livePush('↩ 它想收工但活没干（' + why + '），推回去继续');
            actStatus('第 ' + agent.step + ' 步：推回去继续做');
            continue;
          }
          rec.result = '任务结束';
          ending = '完成：' + (doneReason || '（模型没说原因）');
          break;
        }

        // 交卷前自查：由代码强制拦一道，不能指望模型自己记得检查。
        // 每次都查（不能拦一次就放过，否则它重试一下就把检查绕过去了）；
        // 弹窗里那个"确认提交"不查——那时截图被弹窗挡着，看不到选项，查了必然对不上。
        const targetText = String(action.target || '');
        const isDialogConfirm = /弹窗|对话框|确认/.test(targetText);
        const isSubmit = action.action === 'click' && /提交|交卷/.test(targetText) && !isDialogConfirm;
        if (isSubmit) {
          actStatus('交卷前自查…');
          let v = null;
          try { v = await verifyBeforeSubmit(state.previewDataUrl); } catch(e){ v = null; }
          if (v && v.ok === false && agent.submitBlocks < 3) {
            agent.submitBlocks++;
            rec.result = '交卷前自查没过，已拦下';
            // 如果是"点了没选中"这一类，必须说清怎么补：把落点放到那行【文字中间】再点一次，
            // 而且点完要看到落点附近有变化才算数（光说"你点过了"它只会再点一次同样的位置）。
            const how = v.unselected.length
              ? '\n其中这些是【点了但没选中】的，请重新点它们的【文字中间】（不要点右边的空白，也不要点小圆圈）：\n- '
                + v.unselected.join('\n- ') + '\n点完我会告诉你落点附近有没有变化；没变化就说明还没点中，要调整位置再点。'
              : '\n改完再提交。';
            agent.log.push({ n:agent.step, what:'（提交前自查没过，已拦下）',
              result:'先别提交，下面这些对不上：\n- ' + (v.problems.join('\n- ') || '（它没说是哪里）') + how });
            livePush('⛔ 提交前自查没过（第 ' + agent.submitBlocks + ' 次）：' + (v.problems.join('；') || '（没说是哪里）'));
            continue;
          }
          if (v && v.ok === true) livePush('✅ 交卷前自查通过');
          else if (v && v.ok === false) livePush('⚠ 自查三次都没过，还是交了——你在页面上自己核对一下');
          else livePush('（自查没跑成，直接交）');
        }

        // 同一段大文本反复"整段重写"：实测（2026-10-18 超星作业框）全选没选中编辑框时，
        // 每重写一次就多出一份内容，它却越写越急、写到 60 步。这里不替它动手，只把事实说清；
        // 第三次同样的重写直接停下问你——再写一遍结果不会变。
        if (action.action === 'type' && String(action.text || '').length >= 200) {
          const sameText = agent.log.filter(function(e){
            return e.text === action.text && String(e.result || '').indexOf('已执行') === 0;
          }).length;
          if (sameText >= 2) {
            ending = '停下来问你：同一段内容已经整段重写了 ' + sameText + ' 次，屏幕上的旧内容还是没被覆盖。' +
              '这多半是「点的地方不在编辑框里」或「Ctrl+A 没选中整段」，再写一遍只会再多一份。' +
              '你手动看一眼/改一下，然后说"继续"或直接说新要求。';
            livePush('⏸ ' + ending);
            break;
          }
          if (sameText >= 1) {
            agent.log.push({ n:agent.step, what:'（提醒：同一段内容整段重写第 2 次）', result:
              '这段内容你前面已经整段写过一次了，屏幕上却还是旧的/多出来一份——说明「全选」没选中编辑框里的内容，或者点的地方根本不在编辑框里。\n' +
              '· 原样再写一遍不会变好，只会再多一份。\n' +
              '· 先把光标点进【确认在编辑框内】的一行文字（用 look 放大确认），再 Ctrl+A；按完看一眼整段是不是都高亮了。\n' +
              '· 还是选不中的话，不要再重写：用 say 说明情况，让我手动改。' });
            livePush('#' + agent.step + ' ⚠ 同一段内容第 2 次整段重写（再重复就停下问你）');
          }
        }

        // ===== 守卫这一层的原则：可以【停下问你】，绝不【替模型动手】 =====
        // 2026-09-28 改。原来这些守卫会自己滚一屏、自己换视角，用户看到的是"状态栏打个 ⛔，
        // 屏幕上啥也没发生"——那正是"禁用感"的来源。现在一律降级成【把事实说给它听】，
        // 让它自己决定；只有真的在空转（连着滚 10 次）或跑太多步（60 步）才停下问你。
        // 事实来源是「放大图判读」（readCropState），比原来那个 changedPixels>=20 的布尔值可靠。

        // 连着朝同一个方向滚很多次 = 在空转（实测：53 步里它自己滚了 31 次，最长连着 15 次）。
        // 第 5 次起只告知、不拦（继续往下执行）；第 10 次停下问你。
        if (action.action === 'scroll') {
          const sdir = String(action.direction || 'down').toLowerCase();
          if (agent.scrollDir === sdir) agent.scrollN++; else { agent.scrollDir = sdir; agent.scrollN = 1; }
          agent.scrollTotal++;
          if (agent.scrollN >= 10) {
            ending = '停下来问你：它已经连着朝【' + sdir + '】滚了 ' + agent.scrollN +
              ' 次，什么都没找到。我把它停下了——你要么给它指个路（说一句"在哪个页签/面板里"），要么按停止键。';
            livePush('⏸ ' + ending);
            break;
          }
          // 来回滚（上上下下）同样是在空转：实测写完整段答案后来回滚了 10 次"核对"。
          if (agent.scrollTotal >= 10) {
            ending = '停下来问你：它已经连着滚了 ' + agent.scrollTotal +
              ' 次（来回滚也算），还在原地核对/找东西。我把它停下了——给它指个路，' +
              '或者说一句"写好了，直接提交/收尾"，也可以按停止键。';
            livePush('⏸ ' + ending);
            break;
          }
          if (agent.scrollN === 5) {
            agent.log.push({ n:agent.step, what:'（连着滚了很多次，提醒一句）', result:
              '你已经连着朝【' + sdir + '】滚了 5 次，什么都没找到。再滚多半也没用——\n' +
              '· 要找的东西很可能压根不在可滚动区域里：在别的页签/面板里？（→ 先切过去）\n' +
              '· 当前页是"提交结果页"之类，编辑器在「代码」页签里？\n' +
              '· 也许该用键盘：Ctrl+F 找文字、PageDown/PageUp 翻页。\n' +
              '· 都试过还找不到，就用 say 说清你【到底在找什么】。\n' +
              '这条只是提醒，不拦你——下一步给什么动作你自己定。' });
            livePush('#' + agent.step + ' ⚠ 连着滚了 5 次还没找到（只提醒，不拦）');
          }
          // 来回滚的第 6 次：把"长文本不需要反复核对"这个事实明说一遍。
          if (agent.scrollTotal === 6) {
            agent.log.push({ n:agent.step, what:'（提醒：连着滚了 6 次）', result:
              '你已经连着滚了 6 次（来回滚也算），还停在原地。\n' +
              '· 如果是在找东西：换做法——切页签、用 Ctrl+F/PageDown/PageUp，或者直接说清在找什么。\n' +
              '· 如果是在核对刚写好的长文本：别再滚了。type 返回的 chars 就是你敲进去的字数，' +
              '一屏看不全很正常，确认写进去了就进行下一步（比如提交）或 done。\n' +
              '这条只是提醒，不拦你。' });
            livePush('#' + agent.step + ' ⚠ 连着滚了 6 次（来回滚也算），只提醒、不拦');
          }
        } else if (action.action !== 'wait') {
          // wait 不算"换了件事"：它常常夹在"滚一下→等加载→再滚"中间，
          // 要是 wait 就清零，连滚计数永远到不了 5，这条提醒就废了。
          agent.scrollN = 0; agent.scrollDir = ''; agent.scrollTotal = 0;
        }

        // 重复点击：只提醒、不拦。理由：
        //  · 拦下来会卡死任务（实测里守卫连着拦几下就把整个任务判死了，用户看到"做题做得好好的它自己停了"）；
        //  · 单选按钮重复点无害；复选框的真实状态「放大图判读」会告诉它——靠事实管比靠机器拦靠谱。
        if (action.action === 'click') {
          const dup = repeatedClick(action);
          if (dup) {
            agent.log.push({ n:agent.step, what:'（提醒：像是重复点击）', result:
              '「' + (action.target || '') + '」你刚才已经点过（第 ' + dup.n + ' 步）。' +
              '先看上面那句「放大图判读」：它要是说这项已经选中/已经勾上了，再点一次会把勾取消掉——' +
              '要改答案就去点【别的选项】，不要重复点这一个。\n' +
              '也可以换做法：① 不在当前视野里？（→ scroll 去找）② 被弹窗挡住了？（→ 先关掉）' +
              '③ 压根不可点？（→ 改用键盘 Tab/Enter/Space）④ 该右键或双击？\n' +
              '这条只是提醒，不拦你——你自己判断。' });
            livePush('#' + agent.step + ' ⚠ 像是重复点击（只提醒，不拦）：' + (action.target || ''));
          }
        }

        // 确认环节已全部去掉：它自己跑，你盯着流水账，不对就按停止热键

        // 逐行敲代码要花十几秒，这期间如果状态栏不动，看起来就像卡死了。
        // 所以先把"正在一行一行敲"明说出来，用户才知道该盯着看。
        const willTypeCode = action.action === 'type' && action.lineByLine !== false;
        actStatus('第 ' + agent.step + ' 步：' + (willTypeCode
          ? '正在一行一行敲代码（' + String(action.text || '').split('\n').length + ' 行，慢工出细活）…'
          : describeAction(action)));
        if (willTypeCode) {
          livePush('⌨️ 第 ' + agent.step + ' 步：一行一行敲代码（' + String(action.text || '').split('\n').length +
                   ' 行，约 ' + Math.round(String(action.text || '').length * 8 / 1000) + ' 秒）…');
        }
        try {
          const shotBefore = state.previewDataUrl || '';
          const res = await doAction(action);
          agent.fails = 0;
          // 真的改动了状态的动作才算"绕开了"，say/wait 不能用来给同一个窗口的重试清零
          if (res && res.px) { agent.blockedN = 0; agent.blockedHwnd = null; }
          // 留出重绘时间再让下一轮截图。【这是修一个真 bug】：上一步的"动作前"截图是在动作那一刻截的，
          // 而"动作后"的帧在下一轮循环刚开头就截了——中间几乎零间隔。页面重绘稍慢就被判成"没变化"
          // （changedPixels < 20），于是模型被假坏消息骗着去重试同一个点。只对会改变状态的动作等
          // （click/type/drag 才返回 px），滚动/等待不拖时间。
          if (res && res.px && !agent.stop) await new Promise(function(r){ setTimeout(r, 300); });
          // 滚动之后页面变了：同一个目标可以再点一次，之前的"没点中"也就不算数了
          if (action.action === 'scroll') agent.recentClicks = [];
          // 下一步要做的"感知"分两种，都借 cropTarget 这个口子传递，但去向不同：
          //  · look（模型主动要看）→ 交出原图，下一步原样附带给模型（带准星）。
          //  · 会改变状态的动作（click/type/drag 返回落点 px）→ 下一步只把这一小块裁下来
          //    【单独问一句】"生效没有、控件现在什么状态"，结论是【文字】，不附带图。
          //    实测把图塞进动作请求会把坐标带偏，所以这两条路必须分开（见 readCropState 注释）。
          if (res && res.crop) agent.cropTarget = { crop: res.crop.dataUrl, what: describeAction(action) };
          else if (res && res.px) agent.cropTarget = { px: res.px, what: describeAction(action) };
          rec.at = (res && res.at) ? res.at : '';
          if (res && res.crop) rec.crop = res.crop.dataUrl;      // 单独写一份取证，别塞进 json
          // 注意：look 的结果里带着整张裁图的 dataUrl，直接 JSON.stringify 会把流水账撑爆，所以单独说
          rec.result = action.action === 'say' ? '说了话'
                     : action.action === 'look' ? ('已放大' + (res && res.at ? ' ' + res.at : '') + '（没动鼠标）')
                     : ('已执行 ' + JSON.stringify(res));
          // 只说"指令发出去了"，不说"成功"——是否真的生效要靠下一步看截图才知道
          if (action.action === 'click') {
            const entry = { n:agent.step, what:describeAction(action), reason:action.say || action.__reason || '',
                            result: '已执行 ' + JSON.stringify(res),
                            target: String(action.target || ''), text: String(action.text || ''),
                            clickPx: (res && res.px) ? res.px : null,
                            key: String(action.target || '').replace(/\s+/g, ''),
                            norm: [Number(action.x), Number(action.y)],
                            shotBefore: shotBefore };
            agent.log.push(entry);
            agent.recentClicks.push(entry);        // 存同一个对象：后面的 changed 会写到它身上
            if (agent.recentClicks.length > 8) agent.recentClicks.shift();
          } else if (action.action === 'look') {
            agent.log.push({ n:agent.step, what:describeAction(action), reason:action.say || action.__reason || '',
                             result: '已放大' + (res && res.at ? ' ' + res.at : '') + '（没动鼠标）',
                             target: String(action.target || ''), text: String(action.text || '') });
          } else if (action.action !== 'say') {
            agent.log.push({ n:agent.step, what:describeAction(action), reason:action.say || action.__reason || '',
                             result: '已执行 ' + JSON.stringify(res),
                             target: String(action.target || ''), text: String(action.text || '') });
          } else {
            agent.log.push({ n:agent.step, what:describeAction(action), reason:action.say || action.__reason || '', result: '' });
          }
          if (action.action === 'say') livePush('💬 ' + String(action.text));
          else livePush(liveLine(agent.log[agent.log.length - 1]));
        } catch(e){
          if (e && e.blocked === 'elevated') {
            // 提权窗口：Windows 根本不会把输入送进去。这不是"机器坏了"，不记失败、不重试，
            // 当成一条"没执行"的事实交给模型；同一窗口连撞 3 次才停下问你。
            const win = e.window ? '「' + e.window + '」' : '目标窗口';
            const first = agent.blockedHwnd !== e.hwnd;
            if (first) { agent.blockedHwnd = e.hwnd; agent.blockedN = 0; }
            agent.blockedN++;
            const advice = first
              ? '这一步【没有执行】（不是失败，是 Windows 不允许）：' + win + '是管理员权限窗口，' +
                '普通程序发不进去点击和键盘输入。\n' +
                '· 不要重试这个动作：再发一次结果不会变。\n' +
                '· 需要人动手：用 say 说清楚"请点哪里 / 输入什么"，说完等我做完——下一轮截图会显示结果。\n' +
                '· 任务里如果有不涉及这个窗口的步骤，可以先去那些。\n' +
                '· 不要把这一步当成已完成。'
              : '这一步【仍然没有执行】：还是同一个管理员权限窗口，输入发不进去。' +
                '不要重试，按上一步说的做（用 say 请我手动操作，或先做别的）。';
            agent.log.push({ n:agent.step, what:describeAction(action), result:advice });
            rec.result = '被系统拦下（管理员权限窗口，未执行）';
            livePush('#' + agent.step + ' ⛔ ' + describeAction(action) + ' 没有执行：' + win + '是管理员权限窗口');
            if (first) livePush('　　这个窗口我操作不了（系统拦着）。需要你手动完成这一步，做完我接着看。');
            if (agent.blockedN >= 3) {
              ending = '停下来问你：它连续 3 次想操作' + win + '，都被系统拦下了。' +
                '这一步需要你手动做；做完说"继续"（或再按一次开始），我接着来。';
              livePush('⏸ ' + ending);
              break;
            }
          } else if (e && e.blocked === 'focus') {
            // 焦点还在助手自己身上：按键没有发出去。这不是故障，是一条"没执行"的事实；
            // 模型下一步先点目标窗口就能恢复，所以不计执行失败。
            const advice = '这一步【没有执行】：键盘焦点还在助手自己的窗口上，按键没有发出去。\n' +
              '· 下一步先点一下目标窗口或输入框（click，或带 x/y 的 type），把焦点交过去，再按这个键。\n' +
              '· 不要重复发同一个 key：焦点没变，结果不会变。';
            agent.log.push({ n:agent.step, what:describeAction(action), result:advice });
            rec.result = '被焦点检查拦下（未执行）';
            livePush('#' + agent.step + ' ⛔ ' + describeAction(action) + ' 没有执行：键盘焦点还在助手窗口上');
          } else {
            rec.result = '执行失败：' + e.message;
            agent.fails++;
            agent.log.push({ n:agent.step, what:describeAction(action), result:'失败：' + e.message });
            livePush('#' + agent.step + ' ' + describeAction(action) + ' → 失败：' + e.message);
            if (agent.fails >= 3) { ending = '连续 3 步执行失败，已停止'; break; }
          }
        }
      } finally {
        const name = 'step-' + String(rec.step).padStart(2, '0');
        const recForLog = Object.assign({}, rec); delete recForLog.shot; delete recForLog.crop;   // 图单独存，别塞进 json 里
        await runLog(name, rec.shot, recForLog);   // 走哪条路都要留下证据
        // 放大裁图另存一份：出问题时能看见"模型当时到底把准星画在哪"，不用靠猜
        if (rec.crop) await runLog(name + '-crop', rec.crop, { n: rec.step, what: rec.action ? describeAction(rec.action) : '' });
      }
    }
    if (agent.stop) ending = '已停止';
  } catch(e) {
    ending = '任务异常终止：' + e.message;
  } finally {
    agent.running = false;
    // 把这件事记进记忆：下一句"继续做"才有东西可继续
    try { rememberTask(ending); } catch(e){}
    // 任务停了也保持 ptt：不按 T 就不收音，不会变回"一直听"。
    try { await api.setSpeechMode('ptt'); } catch(e){}
    sendPttContext();
    const listening = state.mode === 'task' && state.micActive;
    actStatus(ending + (listening ? '　｜　按住 T 说下一件事' : ''));
    await runLog('summary', '', { task:agent.task, ending:ending, steps:agent.step, hotkeys:state.hotkeys, log:agent.log, model:state.model });
    showAnswer(ending + '\n\n实际执行 ' + agent.log.length + ' 步（"已执行"只表示指令发出去了，是否真生效要看下一步对截图的判断）：\n' + (agent.log.map(logLine).join('\n') || '（无）'), 'done', true);
  }
}
/* 热键实际生效的组合由主进程决定（可能因为被占用而换过），启动时问一次 */
async function loadHotkeys(){
  try {
    const r = await api.hotkeyLabels();
    if (r && r.labels) {
      if (r.labels.stop) state.hotkeys.stop = r.labels.stop;
      if (r.ok) state.hotkeyOk = r.ok;
      document.getElementById('actStop').title = '停止（也可以用热键 ' + state.hotkeys.stop + '）';
      if (state.hotkeyOk.stop === false) document.getElementById('actStop').title = '停止（热键都被占用，只能用这个按钮）';
    }
  } catch(e){}
}
document.getElementById('btnRunTask').addEventListener('click', function(){ runTask(document.getElementById('taskInput').value); });
document.getElementById('taskInput').addEventListener('keydown', function(e){ if (e.key === 'Enter') runTask(document.getElementById('taskInput').value); });
document.getElementById('modeSel').addEventListener('change', function(e){
  state.mode = e.target.value;
  localStorage.setItem('dsh_mode', state.mode);
  actStatus(state.mode === 'task' ? '语音用途：一律当任务'
    : state.mode === 'qa' ? '语音用途：一律当问题' : '语音用途：自动判断');
});

/* mic */
function setMicUI(on){  document.getElementById('micDot').className = on ? 'listening' : '';
  document.getElementById('micLabel').textContent = on ? '\u6309\u4f4f T \u8bf4\u8bdd' : '\u672a\u5f00\u542f';
  document.getElementById('btnMic').textContent = on ? '\u{1F399} \u5173\u95ed\u8bed\u97f3' : '\u{1F399} \u5f00\u542f\u8bed\u97f3';
}
async function enableMic(){
  if (state.micActive) { await api.setMic(false); state.micActive=false; setMicUI(false); return; }
  try { await api.setMic(true); state.micActive=true; setMicUI(true); }
  catch(e){ actStatus('mic err: '+e.message); }
}
document.getElementById('btnMic').addEventListener('click', () => enableMic());

/* ===== 推按键说话：状态上报 + “正在听”提示 =====
   按 T 算不算说话由主进程统一判断（只看是否在运行态），这里只上报自己的状态，
   并在按住时把提示显示得足够明显。 */
function sendPttContext(){
  if (typeof api.setPttContext !== 'function') return;
  try {
    api.setPttContext({
      active: !!state.active,
      taskRunning: !!agent.running,
    });
  } catch(e){}
}

function setPttHud(st){
  const hud = document.getElementById('pttHud');
  const txt = document.getElementById('pttText');
  if (!hud || !txt) return;
  if (st && st.held) {
    hud.className = 'show';
    if (st.exclusive === false) txt.textContent = '正在听你说…（⚠ 未独占，会议那边也能听到）';
    else if (st.exclusive == null) txt.textContent = '正在拿麦克风…（等这行字变了再说话）';
    else txt.textContent = '正在听你说…（松开 T 结束）';
  }
  else if (st && st.busy) { hud.className = 'show busy'; txt.textContent = '识别中…'; }
  else hud.className = '';
}
if (typeof api.onPttState === 'function') api.onPttState(setPttHud);

document.getElementById('actStop').addEventListener('click', () => {
  if (agent.running) { agent.stop = true; actStatus('正在停止…'); return; }
  leaveActive();
});

/* 一次调用做两件事：把语音识别的错字/繁体/漏字改写成语义明确的指令，并判断他要它干活还是问问题。
   实测（真实样本）：识别成「然後開始張竭測音」的，能还原成「然后开始章节测试」。
   判不出来就按【问问题】处理——那是安全的一侧：不会去动你的鼠标。 */
const UTTER_PROMPT = '下面是麦克风语音识别的原始结果，可能有同音错别字、繁体字、漏字，甚至整句都不通。'
  + '请结合常见的使用场景，推测说话人真正想表达什么，写成一条通顺、明确的简体中文指令（不要添加原话里没有的要求）。'
  + '然后判断说话人是想让我【操作电脑去完成一件事】还是【问一个问题】。\n'
  + '只输出一个 JSON：{"fixed":"改写后的句子","kind":"task 或 qa"}\n\n识别原文：';

async function understandUtterance(text){
  const body = {
    model: state.model, max_tokens: 200,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: UTTER_PROMPT + text }],
  };
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST', headers:{ Authorization:'Bearer ' + state.apiKey, 'Content-Type':'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const j = await resp.json();
  const ans = String((((j.choices || [])[0] || {}).message || {}).content || '');
  const found = firstJsonObject(ans);
  if (!found) throw new Error('判断结果不是 JSON');
  const o = JSON.parse(found.text);
  return {
    fixed: (o.fixed ? String(o.fixed).trim() : String(text)),
    kind: /task/i.test(String(o.kind || '')) ? 'task' : 'qa',
  };
}

/* 任务期间说这些词就是"暂停"，不是给模型的补充指示：立刻停，别再动鼠标。 */
const PAUSE_RE = /(暂停|停一下|停下来|先停|停止|别动|停停)/;
/* 除了暂停，任务期间按住 T 说的话记下来，下一次问模型时带上。
   它不打断任务，也不会被当成"下一件事"——只是让你能在旁边指挥。 */
function addGuidance(said){
  const t = String(said || '').trim();
  if (!t) return;
  agent.guidance.push({ step: agent.step, text: t });
  if (agent.guidance.length > 5) agent.guidance.shift();
  livePush('🎤 你说：' + t + '（已带进下一步判断）');
}

/* speech poll: 一次取走间隔内所有识别结果（不再丢句），服务掉线立刻反馈 */
setInterval(async () => {
  if (!state.active || !state.micActive) return;
  try {
    const st = await api.getSpeech();
    if (!st) return;
    if (st.micAlive === false) {          // 只有明确回报掉线才算掉线，字段缺失不当掉线
      state.micActive = false; setMicUI(false);
      actStatus('\u8bed\u97f3\u670d\u52a1\u5df2\u505c\u6b62');
      showAnswer(st.micError ? ('\u8bed\u97f3\u670d\u52a1\u5df2\u505c\u6b62\uff1a'+st.micError) : '\u8bed\u97f3\u670d\u52a1\u5df2\u505c\u6b62\uff0c\u8bf7\u91cd\u65b0\u5f00\u542f\u8bed\u97f3', 'error', true);
      return;
    }
    const items = (st.items || []).map(function(x){ return String(x).trim(); }).filter(Boolean);
    if (!items.length) return;
    // 任务执行中：队列里只会有按住 T 说的话（whisper 在 ptt 模式，环境音根本不收）。
    // 这些话是对当前任务的补充/纠正，带进下一步判断，不另起一个任务。
    if (agent.running) {
      for (const said of items) {
        if (PAUSE_RE.test(said)) {
          agent.stop = true;
          livePush('⏸ 你说「' + said + '」，任务停在这里（窗口现在可以拖了）');
          actStatus('已暂停 · 按住 T 说下一步');
          break;
        }
        addGuidance(said);
      }
      return;
    }
    for (const said of items) {
      // 自动判断：先把识别错字改过来（顺手），再决定是"干活"还是"问问题"
      let mode = state.mode, useText = said;
      if (mode === 'auto') {
        actStatus('听你说…');
        const u = await understandUtterance(said).catch(function(){ return { fixed: said, kind: 'qa' }; });
        useText = u.fixed || said;
        mode = u.kind;
        actStatus(mode === 'task' ? '判断为：去做这件事' : '判断为：回答这个问题');
      }
      if (mode === 'task') {
        // 语音当任务用：说完它自己去做；跑完不退出，继续听下一件
        await runTask(useText, said === useText ? '' : said);
      } else {
        actStatus('\u6b63\u5728\u5904\u7406\u8bed\u97f3...');
        await onUserInput(useText, true);
      }
    }
  } catch(e){}
}, 250);

/* submit */
async function onUserInput(text, fromVoice){
  if (!state.apiKey) { showAnswer('\u8bf7\u5148\u8bbe\u7f6e API Key','warn',true); return; }
  if (state.speaking) { showAnswer('\u601d\u8003\u4e2d\uff0c\u8bf7\u7a0d\u5019','warn',true); return; }
  state.speaking = true;
  showAnswer('', 'thinking', true); actStatus('\u601d\u8003\u4e2d...');
  // 每次说话都重新截当前屏幕，不用缓存的旧截图
  await capturePreview();
  let dataUrl = state.previewDataUrl;
  actStatus('\u601d\u8003\u4e2d...');
  const wantWeb = document.getElementById('webToggle') ? document.getElementById('webToggle').checked : false;
  let searchInfo='';
  if (wantWeb) { searchInfo = await deepseekSearch(text); }
  if (searchInfo) actStatus('\u5df2\u641c\u7d22\uff0c\u7efc\u5408\u56de\u7b54...');
  try { const reply = await askModel(text, dataUrl, searchInfo, state.history);
    if (reply) { state.history.push({role:'user',content:text},{role:'assistant',content:reply}); }
    showAnswer(reply,'done',true); }
  catch(e){ console.error('USERINPUT ERR:', e); showAnswer('\u8bf7\u6c42\u51fa\u9519\uff1a'+e.message,'error',true); }
  finally { state.speaking=false; }
}

/* deepseek search (自判断) - anthropic /messages + web_search */
async function deepseekSearch(query){
  try {
    const body={ model:state.model, thinking:{type:'disabled'}, max_tokens:600, tools:[{type:'web_search_20250305',name:'web_search'}], messages:[{role:'user',content:'请搜索：'+query+'，只返回搜索结果，用简体中文'}] };
    const resp=await fetch('https://api.deepseek.com/anthropic/v1/messages',{method:'POST',headers:{Authorization:'Bearer '+state.apiKey,'Content-Type':'application/json','anthropic-version':'2023-06-01'},body:JSON.stringify(body)});
    if(!resp.ok) return '';
    const j=await resp.json();
    const blocks=j.content||[];
    const items=[];
    for(const b of blocks){
      if(b.type==='web_search_tool_result'){
        const res=b.content||[];
        for(const r of res){ if(r.type==='web_search_result'&&r.title){ items.push({title:r.title,url:r.url}); } }
      }
    }
    if(items.length===0) return '';   // 模型判断不需要搜索
    return '相关搜索结果：\n'+items.slice(0,6).map(i=>'- '+i.title+' ('+i.url+')').join('\n');
  } catch(e){ return ''; }
}
/* 把截图内联进请求（base64）。实测比先传 /files 再引用快约 340ms/次——
   那是一次纯粹的往返，白送的。 */
function imageContent(dataUrl){
  return { type: 'image_url', image_url: { url: String(dataUrl || '') } };
}

/* model: 视觉问答 */
async function askModel(userText, imageDataUrl, searchInfo, history){
  const thinking = document.getElementById('thinkToggle') ? document.getElementById('thinkToggle').checked : false;
  const sysPrompt = '你是一个屏幕助手。用户说话时，请求会附带一张用户当前屏幕的截图，你一定要看那张截图并结合它回答。你是能看到屏幕截图的，不要说自己没有截图能力。回答要克制：只回答用户明确问的问题，简洁直接，不要主动扩展、不要主动做用户没要求的事，不要开场白或多余格式。始终使用简体中文，不要输出繁体字。抗幻觉：你必须只依据请求中附带的那张当前截图回答；历史对话只是参考的文字，不是图片，不要把它当成图片内容或编造。如果截图里看不清、没有你要找的东西，或你不确定，就直接说\u201c看不清/不确定\u201d，绝对不要猜测、编造或脑补画面里不存在的内容。如果用户指出你回答错误或说“不对”，你要重新审视当前截图，承认可能看错或判断有误，耐心重新判断，绝对不要固执坚持、不要辩解或犟。';
  const userTextFull = searchInfo ? (userText+'\n\n[参考资料,基于搜索]:\n'+searchInfo+'\n\n请引用这些资料简明回答我原问题。') : userText;
  let content=[{type:'text',text:userTextFull}];
  if (imageDataUrl) content.push(imageContent(imageDataUrl));
  const histMsgs = (history||[]).map(m=>m.role==='assistant'?{role:'assistant',content:m.content}:{role:'user',content:m.content});
  const messages=[{role:'system',content:sysPrompt},...histMsgs,{role:'user',content}];
  const base={ model:state.model, stream:true, max_tokens:2000, messages };
  if(!thinking){ base.thinking={type:'disabled'}; }
  return await streamChat(base);
}

/* stream chat */
async function streamChat(body){
  const resp=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+state.apiKey,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!resp.ok){ const txt=await resp.text().catch(()=>''); let d=txt; try{ d=JSON.parse(txt)?.error?.message||txt; }catch(x){} throw new Error('HTTP '+resp.status+' : '+d); }
  if(!resp.body){ const j=await resp.json(); return j.choices?.[0]?.message?.content||''; }
  const reader=resp.body.getReader(); const dec=new TextDecoder();
  let buffer=''; let answer=''; let reasoning='';
  try {
    while(true){
      const r=await reader.read(); if(r.done) break;
      buffer+=dec.decode(r.value,{stream:true});
      let idx;
      while((idx=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,idx).trim(); buffer=buffer.slice(idx+1);
        if(!line.startsWith('data:')) continue;
        const data=line.slice(5).trim();
        if(data==='[DONE]'){ return answer.trim(); }
        try {
          const chunk=JSON.parse(data); const d=chunk.choices?.[0]?.delta;
          if(d && d.reasoning_content){ reasoning+=d.reasoning_content; actStatus('\u601d\u8003\u4e2d...'); }
          if(d && d.content){ answer+=d.content; actStatus('\u56de\u7b54\u4e2d...'); showAnswer(answer,'live',true); }
        }catch(x){}
      }
    }
  } catch(streamErr){ console.error('STREAM ERR:', streamErr); }
  return answer.trim();
}

/* answer display */
function actStatus(t){ document.getElementById('actStatus').textContent=t; }
function showAnswer(text, kind, expand){
  const bar=document.getElementById('answerbar'); const ans=document.getElementById('answer');
  if (expand) bar.style.display='block';
  if (kind==='live'||kind==='error'||kind==='warn'||kind==='done'||kind===void 0){ try{ text=api.toSimplified(text); }catch(x){} }
  if (kind==='live'){ ans.innerHTML=s(text)+'<span class="cursor"></span>'; }
  else if (kind==='thinking'){ ans.innerHTML=s('\u601d\u8003\u4e2d...'); }
  else if (kind==='error'){ ans.innerHTML='<span style="color:#ff8a8a">'+s(text)+'</span>'; }
  else if (kind==='warn'){ ans.innerHTML='<span style="color:#ffce6b">'+s(text)+'</span>'; }
  else { ans.innerHTML=s(text); }
  bar.scrollTop=bar.scrollHeight;
}
document.getElementById('ansClose').addEventListener('click',()=>{ document.getElementById('answerbar').style.display='none'; });
document.getElementById('btnMin').addEventListener('click',()=>api.minimize());
document.getElementById('btnClose').addEventListener('click',()=>api.close());
document.getElementById('btnStart').addEventListener('click',()=>enterActive());

/* 点击穿透：鼠标在状态条/答案栏内才接收(可交互)，其余穿透(不挡点下面) */
function updateMousePass(e){
  try {
    const sb=document.querySelector('.statusbar');
    const ab=document.getElementById('answerbar');
    let inInt=false;
    if (sb){ const r=sb.getBoundingClientRect(); if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom) inInt=true; }
    if (ab&&ab.style.display!=='none'){ const r=ab.getBoundingClientRect(); if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom) inInt=true; }
    api.setIgnoreMouse(!inInt);
  } catch(x){}
}
document.addEventListener('mousemove', (e)=>{ if(state.active) updateMousePass(e); });

(async () => {
  await loadSources(); await capturePreview(); refreshKeyStatus(); await loadMics(); await loadModels(); await loadHotkeys();
  document.getElementById('modeSel').value = state.mode;      // 恢复上次选的语音用途
  const key = await api.getApiKey(); if (key) state.apiKey = key;
})();