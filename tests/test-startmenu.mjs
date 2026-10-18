// 开始菜单快捷方式查找：open_app 只认 .lnk 名字，不碰安装路径、不执行命令。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createChecker } from './lib/check.mjs';

const require = createRequire(import.meta.url);
const { findShortcut } = require('../startmenu.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-startmenu-'));
const sub = path.join(dir, 'Accessories');
fs.mkdirSync(sub);
for (const n of ['Visual Studio Code.lnk', 'Notepad.lnk', 'Code.lnk', '微信.lnk', 'Word.lnk']) {
  fs.writeFileSync(path.join(dir, n), '');
}
fs.writeFileSync(path.join(sub, 'Calculator.lnk'), '');

const c = createChecker();
const find = (q) => findShortcut(q, [dir]);

c.section('按名字找快捷方式');
c.eq('精确名字', find('Notepad').name, 'Notepad');
c.eq('大小写不敏感', find('notepad').name, 'Notepad');
c.eq('空格/标点不影响', find('note pad').name, 'Notepad');
c.eq('中文名字', find('微信').name, '微信');
c.eq('子目录里的也能找到', find('Calculator').name, 'Calculator');
c.eq('返回的是真实存在的文件', fs.existsSync(find('Notepad').path), true);

c.section('简称与优先级');
c.eq('VS Code -> Visual Studio Code（按字母顺序对上）', find('VS Code').name, 'Visual Studio Code');
c.eq('vscode -> Visual Studio Code', find('vscode').name, 'Visual Studio Code');
c.eq('有精确匹配时不用简称（code -> Code）', find('code').name, 'Code');

c.section('找不到时说清楚');
const miss = find('Photoshop');
c.eq('找不到就返回失败', miss.ok, false);
c.eq('  原因是没找到', miss.reason, 'notfound');
c.ok('  并给出相近候选，方便换个名字', Array.isArray(miss.candidates), String(miss.candidates));
c.eq('单字符不搜（避免误启动）', find('v').reason, 'empty');
c.eq('空名字不搜', find('  ').reason, 'empty');

fs.rmSync(dir, { recursive: true, force: true });
c.done();
