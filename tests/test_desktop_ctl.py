# -*- coding: utf-8 -*-
"""desktop_ctl.py 的自测。

直接导入模块调 process_line()，绕开管道（受限环境下管道 stdio 会被拦）。

⚠️ 副作用：会让鼠标移动几下（结束前恢复原位），会覆盖你的剪贴板内容。
   不点击、不发送任何按键——所以不需要目标窗口。
"""
import sys, os, ctypes
from ctypes import wintypes

sys.dont_write_bytecode = True          # 不要在项目里留 __pycache__
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, APP_DIR)
import desktop_ctl as C   # 它自己会把 stdout 包成 utf-8；不要再包一层（会互相 GC 掉底层 buffer）

passed = failed = 0


def check(name, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print("PASS  " + name)
    else:
        failed += 1
        print("FAIL  %s\n        got  %r\n        want %r" % (name, got, want))


def read_clipboard():
    """读回剪贴板文本。只验证"中文真的进了剪贴板"；粘贴那一步需要目标窗口，这里测不了。"""
    u = ctypes.WinDLL("user32", use_last_error=True)
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.GlobalLock.argtypes = [wintypes.HGLOBAL]
    k.GlobalLock.restype = ctypes.c_void_p
    k.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    k.GlobalUnlock.restype = wintypes.BOOL
    u.GetClipboardData.argtypes = [wintypes.UINT]
    u.GetClipboardData.restype = wintypes.HANDLE
    if not u.OpenClipboard(None):
        return None
    try:
        h = u.GetClipboardData(13)          # CF_UNICODETEXT
        if not h:
            return None
        p = k.GlobalLock(h)
        if not p:
            return None
        try:
            return ctypes.wstring_at(p)
        finally:
            k.GlobalUnlock(h)
    finally:
        u.CloseClipboard()


ox, oy = C.cursor_pos()
print("原鼠标位置: (%d,%d)\n" % (ox, oy))

try:
    r = C.handle({"cmd": "ping"})
    check("ping 成功", r["ok"], True)
    check("DPI 感知已开启", C.DPI_MODE in ("per-monitor-v2", "per-monitor", "system"), True)
    w, h = r["screen"]["primary"]["w"], r["screen"]["primary"]["h"]
    check("报告的是物理像素（不是逻辑尺寸）", (w, h) != (0, 0), True)
    print("      DPI 模式 = %s   主屏物理尺寸 = %dx%d   虚拟桌面 = %sx%s"
          % (C.DPI_MODE, w, h, r["screen"]["virtual"]["w"], r["screen"]["virtual"]["h"]))
    print("      注：本机逻辑尺寸是 1536x960（= 物理 1920x1200 / 125%），")
    print("          坐标换算必须用这里报告的物理尺寸，不能用截图自身的像素尺寸。")

    fg = C.handle({"cmd": "foreground"})
    check("前台窗口查询成功", fg["ok"], True)
    check("前台窗口信息齐全", all(k in fg for k in ("hwnd", "pid", "app", "title")), True)
    check("前台窗口带类名和物理像素矩形（观察框要用）",
          (isinstance(fg["class"], str), isinstance(fg["rect"], dict),
           fg["rect"]["w"] > 0, fg["rect"]["h"] > 0), (True, True, True, True))
    check("前台窗口区分句柄进程和应用进程（UWP 用后者取名）",
          (isinstance(fg["pid"], int), isinstance(fg["appPid"], int)), (True, True))
    gone = C.handle({"cmd": "focus", "hwnd": 0})
    check("焦点目标不存在时不硬拉", (gone["ok"], gone["reason"]), (False, "gone"))

    # UWP：外框归 ApplicationFrameHost，应用名必须从 CoreWindow 的 pid 取
    check("普通窗口的应用 pid 就是窗口 pid", C.app_owner_pid("Chrome_WidgetWin_1", 111, 222), 111)
    check("UWP 外框用 CoreWindow 的 pid", C.app_owner_pid("ApplicationFrameWindow", 111, 222), 222)
    check("UWP 找不到 CoreWindow 时退回外框 pid", C.app_owner_pid("ApplicationFrameWindow", 111, 0), 111)

    # 激活已有窗口：标题匹配规则（不裸子串、整段匹配、分隔符分段、前缀单词边界）
    tm = C.title_matches
    check("标题完全一致", tm("Calculator", "calculator"), True)
    check("Windows 的「文档 - 程序名」分段", tm("Document1 - Word", "word"), True)
    check("带品牌后缀的分段以名字结尾", tm("New tab - Personal - Microsoft Edge", "edge"), True)
    check("冒号分段", tm("Chat | Slack", "slack"), True)
    check("前缀命中但必须在单词边界", tm("Visual Studio Code", "visual"), True)
    check("前缀后面紧接字母不算（visualstudio）", tm("visualstudio", "visual"), False)
    check("裸子串不算：source code review 不是 code", tm("source code review", "code"), False)
    check("空名字谁都不匹配", tm("Calculator", "  "), False)

    wins = [
        {"app": "explorer", "title": "计算器 - 文件资源管理器"},
        {"app": "calculator", "title": "计算器"},
        {"app": "notepad", "title": "计算器 - 记事本"},
    ]
    check("进程名精确匹配优先于标题匹配",
          C.select_app_window(wins, "calculator")["app"], "calculator")
    check("没有进程名匹配时才看标题（Z 序最前）",
          C.select_app_window(wins, "计算器")["app"], "explorer")
    check("什么都不匹配时返回 None", C.select_app_window(wins, "photoshop"), None)
    # 真的去枚举窗口并激活一个不可能存在的名字：必须安全地返回未激活，不能抢焦点
    check("activate 找不到已开窗口时如实返回 false",
          C.handle({"cmd": "activate", "app": "__no_such_app_9527__"}),
          {"ok": True, "activated": False})

    # 系统截图快捷键：按下去会弹截图工具盖住屏幕，必须拒绝（而且一个事件都不发）
    check("PrintScreen 被识别为截图快捷键", C.is_screenshot_combo(["printscreen"]), True)
    check("Alt+PrintScreen 也算", C.is_screenshot_combo(["alt", "prtsc"]), True)
    check("Win+Shift+S 算", C.is_screenshot_combo(["win", "shift", "s"]), True)
    check("普通组合键不当成截图键", C.is_screenshot_combo(["ctrl", "shift", "a"]), False)
    sent_events = []
    old_send = C._send
    C._send = lambda *evs: sent_events.extend(evs)
    try:
        for combo in ("printscreen", "alt+printscreen", "win+shift+s"):
            try:
                C.send_combo(combo)
                check("拒绝截图快捷键 %s" % combo, False, True)
            except ValueError:
                check("拒绝截图快捷键 %s" % combo, True, True)
        C.send_combo("ctrl+v")
    finally:
        C._send = old_send
    # 只剩 ctrl+v 的四个事件（ctrl 按下、v 按下、v 抬起、ctrl 抬起）
    check("被拒的截图快捷键一个事件都没发出去",
          sorted(ev.u.ki.wVk for ev in sent_events), [0x11, 0x11, 0x56, 0x56])

    for (tx, ty) in [(200, 200), (w - 40, h - 40), (10, h // 2)]:
        C.handle({"cmd": "move", "x": tx, "y": ty})
        p = C.handle({"cmd": "pos"})
        check("移动并读回 (%d,%d)" % (tx, ty), (p["x"], p["y"]), (tx, ty))

    check("向下滚无报错", C.handle({"cmd": "scroll", "dy": -120})["ok"], True)
    check("向上滚无报错", C.handle({"cmd": "scroll", "dy": 120})["ok"], True)
    check("横向滚无报错", C.handle({"cmd": "scroll", "dx": 120})["ok"], True)

    C.set_clipboard_text("中文测试 ABC 123")
    check("中文写进剪贴板并能读回", read_clipboard(), "中文测试 ABC 123")

    # 编码：中文指令是"从 stdin 的 UTF-8 字节"进来的。
    # 以前只包了 stdout/stderr，漏了 stdin —— Windows 会用 GBK 解码，中文全变鬼画符。
    # 这里模拟 stdin 真正收到的字节，走一遍解码 + 剪贴板，确保不再乱码。
    import json as _json
    raw = '{"id":7,"cmd":"type","text":"计算智能"}'.encode("utf-8")
    check("stdin 被显式设成 UTF-8", (C.sys.stdin.encoding or "").lower().replace("-", ""), "utf8")
    line = raw.decode(C.sys.stdin.encoding or "utf-8")
    check("UTF-8 中文经 stdin 解码后不乱码", _json.loads(line)["text"], "计算智能")
    C.set_clipboard_text(_json.loads(line)["text"])
    check("解码后的中文写进剪贴板仍然正确", read_clipboard(), "计算智能")

    r = C.process_line('{"id":8,"cmd":"fly"}')
    check("未知指令返回失败而不是崩溃", r["ok"], False)
    check("未知指令给出原因", "不认识的指令" in r.get("error", ""), True)
    check("未知指令保留 id，便于请求方配对", r["id"], 8)
    check("坏 JSON 也不崩", C.process_line('{ 这不是 json').get("ok"), False)
    check("空行返回 None", C.process_line('   '), None)
    check("失败后仍可继续服务", C.process_line('{"id":9,"cmd":"pos"}')["ok"], True)

    try:
        C.vk_of("nonsense")
        check("未知按键被拒绝", False, True)
    except ValueError:
        check("未知按键被拒绝", True, True)

    check("type 空字符串不报错", C.handle({"cmd": "type", "text": ""})["ok"], True)
    # clear 参数的管路（注意：这里【不能】用 clear=True 测，那会真的往当前焦点窗口发 Ctrl+A + 粘贴）
    check("type 接受 clear=false 参数", C.handle({"cmd": "type", "text": "", "clear": False})["ok"], True)

    # 拖拽的参数校验：缺参数必须报错，而且【不能真的去拖】（避免测试时误拖东西）
    bad = C.process_line('{"id":10,"cmd":"drag","fromX":10,"fromY":10}')
    check("drag 缺参数时报错", bad["ok"], False)
    check("drag 缺参数时说明缺哪个", "drag 缺少" in bad.get("error", ""), True)
    check("校验失败时鼠标没有被拖走", (C.cursor_pos()[0], C.cursor_pos()[1]) != (10, 10), True)

    # 组合点击：把底层发送拦住，只看事件序列（不真的碰鼠标键盘）。
    # 重点是修饰键必须在 finally 里松开——Ctrl 卡住的话，之后所有点击都会变成多选。
    real_send, real_move, real_check = C._send, C.move, C.check_point
    C.move = lambda x, y: (x, y)
    C.check_point = lambda pt, what: None

    events = []
    C._send = lambda *evs: events.extend(evs)
    try:
        C.click(100, 200, modifiers=["ctrl", "shift"])
    finally:
        C._send, C.move, C.check_point = real_send, real_move, real_check
    keys = [(ev.u.ki.wVk, ev.u.ki.dwFlags) for ev in events if ev.type == C.INPUT_KEYBOARD]
    mice = [ev.u.mi.dwFlags for ev in events if ev.type == C.INPUT_MOUSE]
    check("组合点击先按下修饰键（ctrl -> shift）", keys[:2], [(0x11, 0), (0x10, 0)])
    check("点击期间修饰键一直按着（中间没有松开）", mice, [C.MOUSEEVENTF_LEFTDOWN, C.MOUSEEVENTF_LEFTUP])
    check("点完倒序松开修饰键（shift -> ctrl）", keys[-2:], [(0x10, C.KEYEVENTF_KEYUP), (0x11, C.KEYEVENTF_KEYUP)])

    events = []
    state = {"armed": True}
    def flaky(*evs):
        if state["armed"] and any(ev.type == C.INPUT_MOUSE for ev in evs):
            state["armed"] = False           # 第一次要发鼠标事件时失败，模拟发送中断
            raise OSError("模拟发送失败")
        events.extend(evs)
    C._send = flaky
    C.move = lambda x, y: (x, y)
    C.check_point = lambda pt, what: None
    try:
        try:
            C.click(100, 200, modifiers=["ctrl"])
            check("点击发送失败时向上报错", False, True)
        except OSError:
            check("点击发送失败时向上报错", True, True)
    finally:
        C._send, C.move, C.check_point = real_send, real_move, real_check
    check("即使点击失败，Ctrl 也被松开（不会卡住）",
          [(ev.u.ki.wVk, ev.u.ki.dwFlags) for ev in events if ev.type == C.INPUT_KEYBOARD],
          [(0x11, 0), (0x11, C.KEYEVENTF_KEYUP)])
finally:
    C.move(ox, oy)
    back = C.cursor_pos()
    check("鼠标已恢复原位", (back[0], back[1]), (ox, oy))

print("\n%d passed, %d failed" % (passed, failed))
sys.exit(1 if failed else 0)
