# -*- coding: utf-8 -*-
"""desktop_ctl.py 的「一行一行敲」（lineByLine）自测。

不需要鼠标键盘：把真正注入事件的 _send / send_combo / set_clipboard_text 换成
只记录不发送的桩，然后检查【发出去的按键序列】对不对。
真键盘注入那部分仍然只在 -Hardware 的 test_desktop_ctl.py 里跑。

为什么要这个模式（用户原话）：
  "他用剪贴板，每次就得重新删掉然后全部再复制一遍，能不能改一下，让他一行一行写出来我看"
"""
import sys, os

sys.dont_write_bytecode = True          # 不要在项目里留 __pycache__
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, APP_DIR)
import desktop_ctl as C

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print("PASS  " + name)
    else:
        failed += 1
        print("FAIL  %s\n        got  %r\n        want %r" % (name, got, want))


class Recorder(object):
    """把 _send / send_combo / set_clipboard_text 换成记录桩。"""

    def __init__(self):
        self.events = []        # 每次 _send 的事件数
        self.combos = []        # 每次 send_combo 的组合键
        self.clip = None

    def __enter__(self):
        self._send, self._combo, self._clip = C._send, C.send_combo, C.set_clipboard_text
        C._send = lambda *ev: self.events.append(len(ev))
        C.send_combo = lambda c: self.combos.append(c)
        C.set_clipboard_text = lambda t: self._clip_set(t)
        return self

    def _clip_set(self, t):
        self.clip = t

    def __exit__(self, *a):
        C._send, C.send_combo, C.set_clipboard_text = self._send, self._combo, self._clip
        return False


# ---------- 1) 字符 -> SendInput 事件（走 KEYEVENTF_UNICODE，不依赖键盘布局） ----------
print("\n--- 字符事件 ---")
ev = C._char_events("a")
check("普通字符出 2 个事件（按下+抬起）", len(ev), 2)
check("扫描码就是字符码", ev[0].u.ki.wScan, 0x61)
check("先是按下（UNICODE）", ev[0].u.ki.dwFlags, C.KEYEVENTF_UNICODE)
check("再是抬起（UNICODE|KEYUP）", ev[1].u.ki.dwFlags, C.KEYEVENTF_UNICODE | C.KEYEVENTF_KEYUP)

ev = C._char_events("中")
check("中文能直接敲（不用剪贴板）", ev[0].u.ki.wScan, 0x4E2D)

ev = C._char_events("\U0001F600")          # emoji：非 BMP，要拆成代理对
check("非 BMP 字符拆成 2 个扫描码 = 4 个事件", len(ev), 4)
check("代理对高位", ev[0].u.ki.wScan, 0xD83D)
check("代理对低位", ev[2].u.ki.wScan, 0xDE00)

# ---------- 2) 一行一行敲：按键序列 ----------
print("\n--- 一行一行敲 ---")
with Recorder() as r:
    res = C.type_line_by_line("a\nbb", clear=False, per_char=0, per_line=0)

check("返回里标明是逐行模式", res["mode"], "lineByLine")
check("统计了字符数", res["chars"], 3)
check("统计了行数", res["lines"], 2)
check("每行开头都先清空该行（Home/Shift+End/Delete）",
      r.combos, ["home", "shift+end", "delete", "enter", "home", "shift+end", "delete"])
check("逐字敲出来（每个字符按下+抬起 2 个事件，共 3 个字符）", r.events, [2, 2, 2])

# 关键正确性：原文里的【前导空格也要原样敲出来】。
# 因为每行开头已经用 Home/Shift+End/Delete 清空了，编辑器自动缩进出来的空白不会叠加。
r2 = Recorder()
with r2:
    C.type_line_by_line("    x = 1", clear=False, per_char=0, per_line=0)
check("缩进是原文的缩进（4 个前导空格一个不少）", sum(r2.events), len("    x = 1") * 2)

# ---------- 3) clear 的行为 ----------
print("\n--- clear ---")
with Recorder() as r:
    C.type_line_by_line("x", clear=False, per_char=0, per_line=0)
check("默认【不】全选（lineByLine 不该把整个文件删掉重贴）", "ctrl+a" in r.combos, False)

with Recorder() as r:
    C.type_line_by_line("x", clear=True, per_char=0, per_line=0)
check("显式要求 clear 时才全选", r.combos[0], "ctrl+a")

# ---------- 4) 指令路由 ----------
print("\n--- 指令路由 ---")
calls = []
_orig = C.type_line_by_line
C.type_line_by_line = lambda text, clear=False, per_char=0.008: (
    calls.append({"text": text, "clear": clear, "per_char": round(per_char, 4)})
    or {"chars": len(text), "lines": 1, "mode": "lineByLine"})
try:
    out = C.handle({"cmd": "type", "text": "class Solution:", "lineByLine": True, "perChar": 20})
    check("lineByLine=true 走逐行模式", out["mode"], "lineByLine")
    check("perChar 从毫秒换算成秒", calls[0]["per_char"], 0.02)
    check("没写 clear 时就不全选", calls[0]["clear"], False)
    check("内容原样传下去", calls[0]["text"], "class Solution:")
finally:
    C.type_line_by_line = _orig

with Recorder() as r:
    out = C.handle({"cmd": "type", "text": "1982年"})
check("不给 lineByLine 时默认走逐字敲（答题页禁粘贴也输得进）", out["mode"], "lineByLine")
check("默认模式下不碰剪贴板", r.clip, None)

with Recorder() as r:
    out = C.handle({"cmd": "type", "text": "x", "lineByLine": False})
check("显式 lineByLine=false 才走粘贴（超长文本/要快）", out["mode"], "paste")
check("粘贴模式下文本进了剪贴板", r.clip, "x")

with Recorder() as r:
    out = C.handle({"cmd": "type", "text": "x", "lineByLine": False, "clear": True})
check("粘贴模式先全选再粘（覆盖而不是追加）", r.combos, ["ctrl+a", "ctrl+v"])

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
