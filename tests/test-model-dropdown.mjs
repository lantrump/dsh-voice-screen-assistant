// 模型下拉框：列表来自接口、标注无视觉、记忆选择、模型下架后的回退、各种失败兜底。
import { loadRenderer, DEFAULT_MODELS } from './lib/fake-dom.mjs';
import { createChecker } from './lib/check.mjs';

const c = createChecker();
const M = (id, o = {}) => ({
  id, name: o.name || id,
  input_modalities: o.image ? ['text', 'image'] : ['text'],
  output_modalities: o.text === false ? ['embedding'] : ['text'],
});

// ---- 正常情况：上次选的能恢复 ----
let app = loadRenderer({ stored: { dsh_apikey: 'sk-test', dsh_model: 'deepseek-v4-pro' } });
await app.sandbox.loadModels();
c.eq('列表来自接口', app.getEl('modelSel').options.map(o => o.value), ['deepseek-flash', 'deepseek-v4-pro']);
c.eq('显示名称带 id', app.getEl('modelSel').options[0].textContent, 'DeepSeek-V4.1-Flash (deepseek-flash)');
c.eq('无视觉的被标注', app.getEl('modelSel').options[1].textContent.includes('无视觉'), true);
c.eq('有视觉的不标注', app.getEl('modelSel').options[0].textContent.includes('无视觉'), false);
c.eq('恢复上次选择', app.getEl('modelSel').value, 'deepseek-v4-pro');

// ---- 原选模型下架：退回"能看图"的那个，并写回存储 ----
app.run("state.model = 'deepseek-v4-flash-vision-exp'");
app.sandbox.localStorage.setItem('dsh_model', 'deepseek-v4-flash-vision-exp');
app.setModels({ data: [M('deepseek-v4-pro', { name: 'DeepSeek-V4-Pro' }), M('deepseek-flash', { name: 'DeepSeek-V4.1-Flash', image: true })] });
await app.sandbox.loadModels();
c.eq('退回支持图像的模型（哪怕它排第二）', app.getEl('modelSel').value, 'deepseek-flash');
c.eq('回退结果写回 localStorage', app.sandbox.localStorage.getItem('dsh_model'), 'deepseek-flash');

// ---- 非对话模型不进下拉框 ----
app.setModels({ data: [M('deepseek-flash', { image: true }), M('deepseek-embedding', { text: false })] });
await app.sandbox.loadModels();
c.eq('过滤掉非对话模型', app.getEl('modelSel').options.map(o => o.value), ['deepseek-flash']);

// ---- 失败兜底 ----
app.setModels({ data: [] });
await app.sandbox.loadModels();
c.eq('接口返回空列表时回退内置', app.getEl('modelSel').options.map(o => o.value), ['deepseek-flash']);

app.setModels(DEFAULT_MODELS, 401);
await app.sandbox.loadModels();
c.eq('接口报错（如 key 失效）时回退内置', app.getEl('modelSel').options.map(o => o.value), ['deepseek-flash']);

// ---- 没有 key 时不发请求，直接内置 ----
const noKey = loadRenderer({ stored: {} });
const before = noKey.stats.modelFetches;
await noKey.sandbox.loadModels();
c.eq('没有 key 时不去请求接口', noKey.stats.modelFetches, before);
c.eq('没有 key 时回退内置', noKey.getEl('modelSel').options.map(o => o.value), ['deepseek-flash']);

c.done();
