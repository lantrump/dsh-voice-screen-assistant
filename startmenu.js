// 开始菜单快捷方式索引：给 open_app 用。
// 只认 .lnk，不去 PATH 里找 exe、也不执行任意命令——模型不需要知道安装路径。
const fs = require('fs');
const path = require('path');

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
}

function walk(dir, out, depth) {
  if (depth > 6) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out, depth + 1);
    else if (/\.lnk$/i.test(ent.name)) out.push(full);
  }
}

function listShortcuts(dirs) {
  const out = [];
  for (const d of dirs) if (d) walk(d, out, 0);
  return out;
}

// "vs code" / "vscode" 对 "Visual Studio Code"：按字母顺序能对上就算
function isSubsequence(q, s) {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

/** 返回 {ok:true, path, name} 或 {ok:false, reason, candidates} */
function findShortcut(query, dirs) {
  const q = norm(query);
  if (q.length < 2) return { ok: false, reason: 'empty', candidates: [] };
  const items = listShortcuts(dirs).map((p) => {
    const name = path.basename(p, '.lnk');
    return { path: p, name, n: norm(name) };
  });
  let hits = items.filter((it) => it.n === q);
  if (!hits.length) hits = items.filter((it) => it.n.startsWith(q));
  if (!hits.length) hits = items.filter((it) => it.n.includes(q));
  if (!hits.length) hits = items.filter((it) => isSubsequence(q, it.n));
  if (!hits.length) {
    const candidates = items
      .filter((it) => it.n.includes(q[0]))
      .sort((a, b) => a.n.length - b.n.length)
      .slice(0, 10)
      .map((it) => it.name);
    return { ok: false, reason: 'notfound', candidates };
  }
  hits.sort((a, b) => a.n.length - b.n.length);
  return { ok: true, path: hits[0].path, name: hits[0].name, matched: hits.length };
}

module.exports = { findShortcut, listShortcuts };
