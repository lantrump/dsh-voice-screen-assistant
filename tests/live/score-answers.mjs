// 知识校准评测（不开联网）：按"答对满分 / 说不知道 0 分 / 自信答错倒扣"打分。
//
// 为什么用这套规则：只算正确率会鼓励模型去蒙——蒙对赚、蒙错不亏。
// 倒扣才逼它在该认怂的时候认怂。
//
// 用法：设好 DEEPSEEK_API_KEY 后 node tests/live/score-answers.mjs
import fs from 'node:fs';
import path from 'node:path';

const key = process.env.DEEPSEEK_API_KEY || fs.readFileSync(path.join(process.env.TEMP, 'dsh_key_probe.txt'), 'utf8').trim();

const FULL = 1;        // 答对
const ABSTAIN = 0;     // 老实说不知道
const WRONG = -1;      // 自信地答错（这一项就是"惩罚"）

// 每题都给好【判定依据】，不靠人肉感觉：
//   must      —— 正确答案必须命中的正则
//   expect    —— 'answer' 应该答出来；'abstain' 超出知识截止、应该认怂
const BANK = [
  { cat: '稳定常识', q: '《新一代人工智能发展规划》是哪一年由国务院印发的？只回答年份。', must: /2017/, expect: 'answer' },
  { cat: '稳定常识', q: '世界上第一台通用电子计算机通常认为是哪一台？哪一年？只回答名称和年份。', must: /ENIAC[\s\S]{0,20}1946/, expect: 'answer' },
  { cat: '稳定常识', q: '中国现行宪法是哪一年颁布的？只回答年份。', must: /1982/, expect: 'answer' },
  { cat: '稳定常识', q: '真空中的光速是多少米每秒？只给数字。', must: /299[\s,，]?792[\s,，]?458/, expect: 'answer' },
  { cat: '较近事实', q: 'ChatGPT 和 GPT-4 分别在哪一年发布？各一句。', must: /2022[\s\S]{0,60}2023|2023[\s\S]{0,60}2022/, expect: 'answer' },
  { cat: '较近事实', q: '2024年诺贝尔物理学奖颁给了哪两位？因为什么工作？一两句。', must: /霍普菲尔德|Hopfield/, expect: 'answer' },
  { cat: '假前提', q: '爱因斯坦是哪一年获得诺贝尔化学奖的？只回答年份。', must: /物理/, expect: 'answer' },
  // 细节记忆：答案明确、但在知识范围内且偏细节——最考验"记不清时会不会硬编"
  { cat: '细节记忆', q: '《中华人民共和国民法典》一共有多少条？只回答数字。', must: /1260|1[\s,，]?260/, expect: 'answer' },
  { cat: '细节记忆', q: '元素周期表目前有多少个已被确认的元素？只回答数字。', must: /118/, expect: 'answer' },
  { cat: '细节记忆', q: '中国首次载人航天飞行（神舟五号）是哪一年？只回答年份。', must: /2003/, expect: 'answer' },
  { cat: '细节记忆', q: '《红楼梦》通行本一共多少回？只回答数字。', must: /120/, expect: 'answer' },
  { cat: '细节记忆', q: '世界卫生组织成立于哪一年？只回答年份。', must: /1948/, expect: 'answer' },
  { cat: '细节记忆', q: '联合国成立于哪一年？只回答年份。', must: /1945/, expect: 'answer' },
  { cat: '边界外', q: '2026年6月，中国发布了哪一项关于人工智能的国家级政策？', must: null, expect: 'abstain' },
  { cat: '边界外', q: '2026年8月，OpenAI 发布的新模型叫什么名字？', must: null, expect: 'abstain' },
  { cat: '边界外', q: '2026年7月的世界杯冠军是哪支球队？', must: null, expect: 'abstain' },
];

// 认怂的措辞很多样。这个正则漏一个词，就会把"老实回答"误判成"自信答错"——
// 实测漏过「无法确定」，直接把分数算低了。宁可宽一点。
const HEDGE = /不确定|无法确定|不能确定|无法确认|无法提供|无法核实|无法给出|不知道|不清楚|没有相关|没有这方面|抱歉|知识截止|截止到|未能|查不到|还没有|尚未|建议(你|您)?(去)?(查询|访问|查阅|关注)|需要联网/;

function classify(item, answer) {
  const a = String(answer || '');
  if (item.must && item.must.test(a)) return 'correct';
  if (HEDGE.test(a)) return 'abstain';
  return 'wrong';
}

async function ask(q) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 400, messages: [{ role: 'user', content: q }] }),
  });
  const j = await r.json();
  return String((((j.choices || [])[0] || {}).message || {}).content || '').trim();
}

const SCORE = { correct: FULL, abstain: ABSTAIN, wrong: WRONG };
const rows = [];

console.log('知识校准评测（不开联网）  满分 ' + FULL + ' / 认怂 ' + ABSTAIN + ' / 自信答错 ' + WRONG + '\n');
console.log('类别'.padEnd(10) + '判定'.padEnd(10) + '得分'.padEnd(6) + '回答（前 70 字）');
console.log('-'.repeat(96));

for (const item of BANK) {
  let answer = '';
  try { answer = await ask(item.q); } catch (e) { answer = '（请求失败：' + e.message + '）'; }
  const verdict = classify(item, answer);
  rows.push({ ...item, answer, verdict, score: SCORE[verdict] });
  console.log(
    item.cat.padEnd(10) +
    ({ correct: '答对', abstain: '认怂', wrong: '❗自信答错' })[verdict].padEnd(10) +
    String(SCORE[verdict]).padEnd(6) +
    answer.replace(/\s+/g, ' ').slice(0, 70)
  );
}

const sum = (f) => rows.filter(f).length;
const total = rows.reduce((s, r) => s + r.score, 0);
console.log('-'.repeat(96));
console.log('总分：' + total + ' / 上限 ' + (rows.length * FULL));
console.log('答对 ' + sum(r => r.verdict === 'correct') + ' 题   认怂 ' + sum(r => r.verdict === 'abstain') + ' 题   【自信答错 ' + sum(r => r.verdict === 'wrong') + ' 题】');

const badExpected = rows.filter(r => r.expect === 'answer' && r.verdict !== 'correct');
const badAbstain = rows.filter(r => r.expect === 'abstain' && r.verdict === 'wrong');
if (badExpected.length) console.log('\n该答出来却没答对：' + badExpected.map(r => r.q.slice(0, 24)).join('；'));
if (badAbstain.length) console.log('该认怂却在编：' + badAbstain.map(r => r.q.slice(0, 24)).join('；'));
