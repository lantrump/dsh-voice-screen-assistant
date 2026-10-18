# -*- coding: utf-8 -*-
"""desktop_ctl.py - 桌面操作执行器（agent 的"手"）。

从 stdin 逐行读 JSON 指令，执行鼠标/键盘动作，往 stdout 回一行 JSON 结果。
只依赖 Python 标准库 ctypes，不需要安装任何第三方包。

约定：
  * stdout 只输出协议 JSON，一行一条；日志和错误全部走 stderr，绝不污染协议。
  * 启动时设置 DPI 感知，确保坐标是"物理像素"，与截图尺寸一一对应
    （不设的话，125% 缩放下系统会替你换算，点击必偏）。

指令：
  {"id":1,"cmd":"ping"}
  {"id":2,"cmd":"pos"}
  {"id":3,"cmd":"move","x":800,"y":450}
  {"id":4,"cmd":"click","x":800,"y":450}
  {"id":5,"cmd":"click","x":800,"y":450,"button":"right","double":true}
  {"id":6,"cmd":"scroll","dy":-120}          # 负=向下滚，正=向上滚
  {"id":7,"cmd":"key","keys":"ctrl+v"}
  {"id":8,"cmd":"type","text":"中文也可以"}   # 默认：写剪贴板 + Ctrl+V（快）
  {"id":9,"cmd":"type","text":"第一步\\n第二步","lineByLine":true}   # 逐字敲，全程不碰剪贴板
  {"id":10,"cmd":"activate","app":"计算器"}    # 已经开着就切过去；没开返回 activated=false
"""
import sys, io, json, re, time, ctypes
from ctypes import wintypes

# 三个流都要显式设成 UTF-8。
# 特别注意 stdin：Windows 上 Python 默认用系统本地编码（中文系统是 GBK）解码 stdin，
# 而 Node 那边是按 UTF-8 写进来的——不包这一层，中文指令会变成乱码，
# 表现就是"填进去的词全是鬼画符"。stdout/stderr 同理。
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", line_buffering=True)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong

# ---------------- DPI 感知 ----------------
def set_dpi_aware():
    try:
        user32.SetProcessDpiAwarenessContext.argtypes = [wintypes.HANDLE]
        if user32.SetProcessDpiAwarenessContext(wintypes.HANDLE(-4)):   # PER_MONITOR_AWARE_V2
            return "per-monitor-v2"
    except Exception:
        pass
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(2)               # PROCESS_PER_MONITOR_DPI_AWARE
        return "per-monitor"
    except Exception:
        pass
    try:
        if user32.SetProcessDPIAware():
            return "system"
    except Exception:
        pass
    return "none"


# ---------------- SendInput 结构 ----------------
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]

class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]

class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTunion)]

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x0800, 0x1000
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
WHEEL_DELTA = 120

user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT


def _send(*inputs):
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    sent = user32.SendInput(n, arr, ctypes.sizeof(INPUT))
    if sent != n:
        raise OSError("SendInput 只送出 %d/%d 个事件（可能有更高权限的窗口拦截了输入）" % (sent, n))


def _mouse(flags, data=0):
    return INPUT(type=INPUT_MOUSE, u=_INPUTunion(mi=MOUSEINPUT(0, 0, data & 0xFFFFFFFF, flags, 0, 0)))


def _key_event(vk, up=False):
    flags = KEYEVENTF_KEYUP if up else 0
    return INPUT(type=INPUT_KEYBOARD, u=_INPUTunion(ki=KEYBDINPUT(vk, 0, flags, 0, 0)))


def _char_events(ch):
    """把一个字符转成 SendInput 事件（走 KEYEVENTF_UNICODE，不依赖键盘布局）。
    非 BMP 字符（emoji 之类）会编码成 UTF-16 代理对，所以可能出两个事件。"""
    outs = []
    raw = ch.encode("utf-16-le")
    for i in range(0, len(raw), 2):
        scan = int.from_bytes(raw[i:i + 2], "little")
        outs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTunion(ki=KEYBDINPUT(0, scan, KEYEVENTF_UNICODE, 0, 0))))
        outs.append(INPUT(type=INPUT_KEYBOARD, u=_INPUTunion(ki=KEYBDINPUT(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0))))
    return outs


def type_line_by_line(text, clear=False, per_char=0.008, per_line=0.06):
    """一行一行用【真键盘】敲出来，不走剪贴板。

    为什么不用粘贴：
      · 粘贴是一瞬间整段糊上去，你看不见它写了什么；这个模式能一行行长出来。
      · 粘贴模式下想改一处，往往只能"全选 + 整段重贴"；一行一行敲可以只重敲那一行。

    缩进怎么保证不被编辑器搞乱（实测踩过的坑）：
      回车之后，代码编辑器（Monaco / VS Code 这类）会按上一行【自动缩进】，
      于是新行开头已经有一截空白。如果我们再敲原文里的前导空格，就会变成双倍缩进。
      所以每一行都先 Home -> Shift+End -> Delete 把这行清空，再逐字敲这一行的【原文】
      （含它自己的前导空格）。这样不管编辑器自动缩进成什么样，最终内容都等于我们要的那一行。

    注意：这个模式会【覆盖】落点所在的那一行开始的内容，所以落点要放在要开始写的那一行。
    """
    text = str(text)
    if clear:
        send_combo("ctrl+a")
        time.sleep(0.08)
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    typed = 0
    for idx, line in enumerate(lines):
        if idx > 0:
            send_combo("enter")
            time.sleep(per_line)
        # 清掉这一行（含编辑器刚自动缩进出来的空白），保证下面敲的字就是这一行的全部内容
        send_combo("home")
        send_combo("shift+end")
        send_combo("delete")
        for ch in line:
            _send(*_char_events(ch))
            typed += 1
            if per_char > 0:
                time.sleep(per_char)
    return {"chars": typed, "lines": len(lines), "mode": "lineByLine"}

# ---------------- 键盘 ----------------
KEYS = {
    "enter": 0x0D, "tab": 0x09, "esc": 0x1B, "escape": 0x1B, "space": 0x20,
    "backspace": 0x08, "delete": 0x2E, "insert": 0x2D,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "ctrl": 0x11, "control": 0x11, "alt": 0x12, "shift": 0x10, "win": 0x5B,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    "printscreen": 0x2C, "prtsc": 0x2C, "prtscr": 0x2C, "snapshot": 0x2C, "sysrq": 0x2C,
}

SCREENSHOT_KEYS = {"printscreen", "prtsc", "prtscr", "snapshot", "sysrq"}


def is_screenshot_combo(parts):
    """系统截图快捷键会弹出截图工具、盖住当前屏幕，还可能顺手抄走画面。
    PrintScreen 全家（含 Alt/Win 组合）和 Win+Shift+S 一律不替模型按。"""
    names = [str(p).strip().lower() for p in parts if str(p).strip()]
    if any(n in SCREENSHOT_KEYS for n in names):
        return True
    return "win" in names and "shift" in names and "s" in names


def vk_of(name):
    name = str(name).strip().lower()
    if name in KEYS:
        return KEYS[name]
    if len(name) == 1:
        return ord(name.upper())
    raise ValueError("不认识的按键: " + name)


def send_combo(combo):
    """发送形如 "ctrl+v" / "enter" / "ctrl+shift+a" 的组合键。"""
    parts = [p for p in str(combo).split("+") if p.strip()]
    if not parts:
        raise ValueError("空的按键组合")
    if is_screenshot_combo(parts):
        raise ValueError("拒绝发送系统截图快捷键（%s）：它会弹出截图工具盖住屏幕" % combo)
    vks = [vk_of(p) for p in parts]
    for vk in vks:                      # 按下（修饰键先按）
        _send(_key_event(vk, up=False))
    for vk in reversed(vks):            # 抬起（倒序）
        _send(_key_event(vk, up=True))


# ---------------- 剪贴板 ----------------
# 只给【粘贴模式】和长中文用：快、且任何程序都收得下。
# 注意：lineByLine 模式【完全不碰剪贴板】，中文也是逐字敲进去的
# （KEYEVENTF_UNICODE 能直接送任意 Unicode 字符，不依赖键盘布局，也不依赖输入法）。
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]


def set_clipboard_text(text):
    payload = str(text).encode("utf-16-le") + b"\x00\x00"
    if not user32.OpenClipboard(None):
        raise OSError("打不开剪贴板（可能被别的程序占用）")
    try:
        user32.EmptyClipboard()
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(payload))
        if not h:
            raise OSError("剪贴板内存分配失败")
        ptr = kernel32.GlobalLock(h)
        ctypes.memmove(ptr, payload, len(payload))
        kernel32.GlobalUnlock(h)
        if not user32.SetClipboardData(CF_UNICODETEXT, h):
            raise OSError("写入剪贴板失败")
    finally:
        user32.CloseClipboard()


# ---------------- 动作 ----------------
class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


def cursor_pos():
    pt = POINT()
    if not user32.GetCursorPos(ctypes.byref(pt)):
        raise OSError("GetCursorPos 失败")
    return pt.x, pt.y


# ---------------- 提权窗口检测（UIPI） ----------------
# 普通权限的进程往管理员窗口 SendInput 时，系统会把输入【静默丢掉】：
# 有的路径 SendInput 照样返回成功，目标窗口却什么也没收到；键盘按键还可能落回上一个窗口。
# 所以在发输入【之前】先比较目标窗口的完整性级别，比我们高就一律不发。
# 注意：这里只拦"发不进去"的窗口；截图/读屏不受影响。
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x0008
TokenIntegrityLevel = 25
GA_ROOT = 2
SW_RESTORE = 9
INTEGRITY_MEDIUM = 0x2000


class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", wintypes.DWORD)]


class TOKEN_MANDATORY_LABEL(ctypes.Structure):
    _fields_ = [("Label", SID_AND_ATTRIBUTES)]


class ElevatedWindow(OSError):
    """目标窗口的完整性级别比我们高，输入会被系统丢掉。"""
    def __init__(self, info, what):
        self.hwnd = int(info.get("hwnd") or 0)
        self.window = info.get("title") or ""
        self.pid = int(info.get("pid") or 0)
        OSError.__init__(self, "目标窗口「%s」是管理员权限，Windows 不允许普通程序向它发送%s"
                         % (self.window or "（没有标题）", what))


kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
advapi32.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
advapi32.OpenProcessToken.restype = wintypes.BOOL
advapi32.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                         wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
advapi32.GetTokenInformation.restype = wintypes.BOOL
advapi32.GetSidSubAuthorityCount.argtypes = [ctypes.c_void_p]
advapi32.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
advapi32.GetSidSubAuthority.argtypes = [ctypes.c_void_p, wintypes.DWORD]
advapi32.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)
user32.GetForegroundWindow.restype = wintypes.HWND
user32.WindowFromPoint.argtypes = [POINT]
user32.WindowFromPoint.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, ctypes.c_wchar_p, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetAncestor.restype = wintypes.HWND
kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindow.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.SetForegroundWindow.argtypes = [wintypes.HWND]
user32.SetForegroundWindow.restype = wintypes.BOOL
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.EnumChildWindows.argtypes = [wintypes.HWND, WNDENUMPROC, wintypes.LPARAM]
user32.EnumChildWindows.restype = wintypes.BOOL

# 窗口边框用 DWM 的"可见边框"而不是 GetWindowRect：Win10 起后者还包含那圈
# 看不见的调整大小热区（左右各多出 7px 左右），画观察框会偏出去。
DWMWA_EXTENDED_FRAME_BOUNDS = 9
DWMWA_CLOAKED = 14
try:
    dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
    dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD,
                                             ctypes.c_void_p, wintypes.DWORD]
    dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long
except Exception:
    dwmapi = None


def _token_integrity(hproc):
    tok = wintypes.HANDLE()
    if not advapi32.OpenProcessToken(hproc, TOKEN_QUERY, ctypes.byref(tok)):
        return None
    try:
        size = wintypes.DWORD(0)
        advapi32.GetTokenInformation(tok, TokenIntegrityLevel, None, 0, ctypes.byref(size))
        if not size.value:
            return None
        buf = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(tok, TokenIntegrityLevel, buf, size.value, ctypes.byref(size)):
            return None
        label = ctypes.cast(buf, ctypes.POINTER(TOKEN_MANDATORY_LABEL)).contents
        sid = label.Label.Sid
        cnt = advapi32.GetSidSubAuthorityCount(sid).contents.value
        if not cnt:
            return None
        return int(advapi32.GetSidSubAuthority(sid, cnt - 1).contents.value)
    finally:
        kernel32.CloseHandle(tok)


def _integrity_of_pid(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return None
    try:
        return _token_integrity(h)
    finally:
        kernel32.CloseHandle(h)


_OWN_IL = None


def own_integrity():
    global _OWN_IL
    if _OWN_IL is None:
        # 查不到就按普通权限算：宁可多拦，也不要让输入落进错误的窗口。
        _OWN_IL = _integrity_of_pid(kernel32.GetCurrentProcessId()) or INTEGRITY_MEDIUM
    return _OWN_IL


def integrity_of_hwnd(hwnd):
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return _integrity_of_pid(pid.value) if pid.value else None


def window_info(hwnd):
    root = user32.GetAncestor(hwnd, GA_ROOT) or hwnd     # 子窗口没有标题，用顶层窗口的
    n = user32.GetWindowTextLengthW(root)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(root, buf, n + 1)
    pid = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(root, ctypes.byref(pid))
    return {"hwnd": int(root), "title": buf.value, "pid": int(pid.value)}


def process_name(pid):
    """进程可执行文件的基本名（不带 .exe），拿不到就返回空串。"""
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not h:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return ""
        name = buf.value.replace("/", "\\").rsplit("\\", 1)[-1]
        return name[:-4] if name.lower().endswith(".exe") else name
    finally:
        kernel32.CloseHandle(h)


def window_class(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_rect(hwnd):
    """窗口在屏幕上的可见边框（物理像素）。"""
    r = wintypes.RECT()
    ok = False
    if dwmapi is not None:
        try:
            ok = dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), DWMWA_EXTENDED_FRAME_BOUNDS,
                                              ctypes.byref(r), ctypes.sizeof(r)) == 0
        except Exception:
            ok = False
    if not ok and not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return {"x": int(r.left), "y": int(r.top),
            "w": int(r.right - r.left), "h": int(r.bottom - r.top)}


def is_cloaked(hwnd):
    """UWP 关掉/挂起后窗口句柄还活着，但被系统"隐身"（cloaked），不是真在屏幕上。"""
    if dwmapi is None:
        return False
    val = wintypes.DWORD(0)
    try:
        rc = dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), DWMWA_CLOAKED,
                                          ctypes.byref(val), ctypes.sizeof(val))
    except Exception:
        return False
    return rc == 0 and val.value != 0


def core_window_pid(hwnd):
    """UWP 窗口真正属于的进程：ApplicationFrameWindow 归 ApplicationFrameHost，
    应用本体在它的 Windows.UI.Core.CoreWindow 子窗口里。"""
    found = []

    def cb(child, _):
        if window_class(int(child)) == "Windows.UI.Core.CoreWindow":
            pid = wintypes.DWORD(0)
            user32.GetWindowThreadProcessId(child, ctypes.byref(pid))
            if pid.value:
                found.append(int(pid.value))
                return False
        return True

    user32.EnumChildWindows(hwnd, WNDENUMPROC(cb), 0)
    return found[0] if found else 0


def app_owner_pid(klass, frame_pid, core_pid=0):
    """拿来做应用名的 pid。UWP 外框的名是 ApplicationFrameHost，必须换成里面的应用。"""
    if klass == "ApplicationFrameWindow" and core_pid:
        return int(core_pid)
    return int(frame_pid)


def window_app_pid(hwnd, klass, frame_pid):
    if klass != "ApplicationFrameWindow":
        return int(frame_pid)
    return app_owner_pid(klass, frame_pid, core_window_pid(hwnd))


def foreground_info():
    """当前前台窗口的应用名和标题。给模型当"我现在在哪个程序里"的事实。
    rect 是物理像素，和截图坐标同一套，可以直接用来画观察框。"""
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return {"ok": True, "hwnd": 0, "pid": 0, "appPid": 0, "app": "",
                "title": "", "class": "", "rect": None}
    root = user32.GetAncestor(hwnd, GA_ROOT) or hwnd
    info = window_info(root)
    klass = window_class(info["hwnd"])
    app_pid = window_app_pid(info["hwnd"], klass, info["pid"])
    return {"ok": True, "hwnd": int(info["hwnd"]), "pid": int(info["pid"]),
            "appPid": int(app_pid), "app": process_name(app_pid),
            "title": info["title"], "class": klass, "rect": window_rect(info["hwnd"])}


def focus_window(hwnd, expect_pid=0):
    """把焦点还给某个窗口。先核对 pid，避免 HWND 被回收后送给别的程序。"""
    hwnd = int(hwnd or 0)
    if not hwnd or not user32.IsWindow(hwnd):
        return {"ok": False, "reason": "gone"}
    info = window_info(hwnd)
    if expect_pid and int(info["pid"]) != int(expect_pid):
        return {"ok": False, "reason": "identity"}
    if int(user32.GetForegroundWindow() or 0) == hwnd:
        return {"ok": True, "already": True}
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
        time.sleep(0.06)
    # 单独点一下 Alt：让系统认为调用方刚有输入，解除跨进程 SetForegroundWindow 的限制。
    # 这一下落在当前前台窗口上（通常是小球），不会进到目标程序里。
    send_combo("alt")
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.08)
    fg = user32.GetForegroundWindow()
    root = user32.GetAncestor(fg, GA_ROOT) or fg
    ok = int(root or 0) == hwnd
    return {"ok": ok, "hwnd": int(fg or 0), "reason": "" if ok else "denied"}


SHELL_CLASSES = {"Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW"}
TITLE_SEPARATORS = re.compile(r"\s[-–—|:]\s")


def list_visible_windows():
    """按 Z 序（最前到最底）列出可见、有标题的顶层窗口。app 已经是真实应用名。"""
    found = []

    def cb(hwnd, _):
        hwnd = int(hwnd)
        if not user32.IsWindowVisible(hwnd) or is_cloaked(hwnd):
            return True
        klass = window_class(hwnd)
        if klass in SHELL_CLASSES:
            return True
        info = window_info(hwnd)
        if not info["title"] or info["hwnd"] != hwnd:
            return True
        app_pid = window_app_pid(hwnd, klass, info["pid"])
        found.append({"hwnd": hwnd, "pid": info["pid"], "appPid": app_pid,
                      "app": process_name(app_pid), "title": info["title"], "class": klass})
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found


def title_matches(title, wanted):
    """标题等于、"单词边界"开头、或冒号/破折号分出的某一段（含以它结尾）就是它。
    不做裸子串匹配：否则 "source code" 会被当成 "code"，激活错窗口。"""
    title = str(title).strip().lower()
    wanted = str(wanted).strip().lower()
    if not wanted:
        return False
    if title == wanted:
        return True
    if title.startswith(wanted):
        rest = title[len(wanted):]
        if not rest or not re.match(r"[a-z0-9_]", rest[0]):
            return True
    for segment in TITLE_SEPARATORS.split(title):
        text = segment.strip()
        if text == wanted or text.endswith(" " + wanted):
            return True
    return False


def select_app_window(windows, wanted):
    """先按进程名精确匹配，再按标题匹配；windows 按 Z 序，所以同分时用最前面的。"""
    name = str(wanted or "").strip().lower()
    if not name:
        return None
    for w in windows:
        if str(w.get("app", "")).lower() == name:
            return w
    for w in windows:
        if title_matches(w.get("title", ""), name):
            return w
    return None


def activate_app(name):
    """已开着的程序就切过去（保留用户开着的窗口和状态），没开才算失败交给上层去启动。"""
    target = select_app_window(list_visible_windows(), name)
    if not target:
        return {"ok": True, "activated": False}
    res = focus_window(target["hwnd"])
    if not res.get("ok"):
        return {"ok": True, "activated": False, "reason": res.get("reason", "")}
    return {"ok": True, "activated": True, "hwnd": target["hwnd"],
            "app": target["app"], "title": target["title"]}


def _check_target(hwnd, what):
    if not hwnd:
        return
    il = integrity_of_hwnd(hwnd)
    if il is not None and il > own_integrity():
        raise ElevatedWindow(window_info(hwnd), what)


def check_point(pt, what):
    """点击/滚轮/拖拽：看落点下面实际是哪个窗口。"""
    _check_target(user32.WindowFromPoint(POINT(int(pt[0]), int(pt[1]))), what)


def check_foreground(what):
    """键盘输入：看当前前台窗口。"""
    _check_target(user32.GetForegroundWindow(), what)


def move(x, y):
    if not user32.SetCursorPos(int(x), int(y)):
        raise OSError("SetCursorPos 失败 (%s,%s)" % (x, y))
    return cursor_pos()


def click(x, y, button="left", double=False, modifiers=None):
    """modifiers 里的键（ctrl/shift/alt）会在点击期间按住，松手顺序反过来。
    必须放在 finally 里松：中途出错时如果 Ctrl 还按着，之后所有点击都会变成多选。"""
    check_point((x, y), "鼠标点击")
    move(x, y)
    time.sleep(0.03)                    # 让目标窗口先收到移动，避免拖拽误判
    down, up = (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP) if button == "right" else (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    vks = [vk_of(m) for m in (modifiers or [])]
    times = 2 if double else 1
    try:
        for vk in vks:
            _send(_key_event(vk, up=False))
        for _ in range(times):
            _send(_mouse(down), _mouse(up))
            if double:
                time.sleep(0.05)
    finally:
        for vk in reversed(vks):
            try:
                _send(_key_event(vk, up=True))
            except Exception:
                pass                    # 已经出错了，别再被"松键也失败"盖掉原始错误
    return cursor_pos()


def scroll(dy=0, dx=0):
    """dy 负=向下滚，正=向上滚；dx 正=向右滚。"""
    check_point(cursor_pos(), "滚轮")     # 滚轮事件发给鼠标底下的窗口
    if dy:
        _send(_mouse(MOUSEEVENTF_WHEEL, int(dy)))
    if dx:
        _send(_mouse(MOUSEEVENTF_HWHEEL, int(dx)))
    return True


def drag(x1, y1, x2, y2):
    """按住左键从 A 拖到 B。分步移动，否则很多程序认不出这是拖拽。"""
    check_point((x1, y1), "拖拽")
    move(x1, y1)
    time.sleep(0.05)
    _send(_mouse(MOUSEEVENTF_LEFTDOWN))
    steps = 12
    for i in range(1, steps + 1):
        move(x1 + (x2 - x1) * i // steps, y1 + (y2 - y1) * i // steps)
        time.sleep(0.012)
    time.sleep(0.05)
    _send(_mouse(MOUSEEVENTF_LEFTUP))
    return cursor_pos()


def screen_info():
    g = user32.GetSystemMetrics
    return {
        "primary": {"w": g(0), "h": g(1)},
        "virtual": {"x": g(76), "y": g(77), "w": g(78), "h": g(79)},
        "dpi": g(88),                   # SM_CXVIRTUALSCREEN 之外的粗略参考
    }


# ---------------- 主循环 ----------------
def handle(msg):
    cmd = str(msg.get("cmd", "")).lower()
    if cmd == "ping":
        return {"ok": True, "pid": kernel32.GetCurrentProcessId(), "dpi_aware": DPI_MODE, "screen": screen_info()}
    if cmd == "foreground":
        return foreground_info()
    if cmd == "focus":
        return focus_window(msg.get("hwnd"), msg.get("pid"))
    if cmd == "activate":
        return activate_app(msg.get("app", ""))
    if cmd == "pos":
        x, y = cursor_pos()
        return {"ok": True, "x": x, "y": y}
    if cmd == "move":
        x, y = move(msg["x"], msg["y"])
        return {"ok": True, "x": x, "y": y}
    if cmd == "click":
        x, y = click(msg["x"], msg["y"], msg.get("button", "left"), bool(msg.get("double", False)),
                     msg.get("modifiers") or [])
        return {"ok": True, "x": x, "y": y}
    if cmd == "scroll":
        scroll(msg.get("dy", 0), msg.get("dx", 0))
        return {"ok": True}
    if cmd == "drag":
        for f in ("fromX", "fromY", "toX", "toY"):
            if msg.get(f) is None:
                raise ValueError("drag 缺少 " + f)
        x, y = drag(int(msg["fromX"]), int(msg["fromY"]), int(msg["toX"]), int(msg["toY"]))
        return {"ok": True, "x": x, "y": y}
    if cmd == "key":
        check_foreground("键盘输入")
        send_combo(msg["keys"])
        return {"ok": True}
    if cmd == "type":
        check_foreground("键盘输入")
        text = str(msg.get("text", ""))
        # 默认一行一行敲（真键盘，不走剪贴板）：不少答题页禁粘贴（能打字、Ctrl+V 无效），
        # 逐字敲发的是键盘事件、页面没有 paste 可拦；也符合"看得见它写了什么"。显式 lineByLine=false 才粘贴。
        if msg.get("lineByLine", True):
            per_char = msg.get("perChar")
            per_char = 0.008 if per_char is None else max(0.0, float(per_char)) / 1000.0
            res = type_line_by_line(text, bool(msg.get("clear")), per_char)
            return {"ok": True, "chars": res["chars"], "lines": res["lines"], "mode": res["mode"]}
        # clear=True 时先全选再粘贴 —— 粘贴是【追加】不是覆盖，
        # 不清空的话，同一个框里重复输入会越叠越长（实测把三个空的值叠进了第一个空）。
        if msg.get("clear"):
            send_combo("ctrl+a")
            time.sleep(0.06)
        if text:
            set_clipboard_text(text)
            time.sleep(0.05)
            send_combo("ctrl+v")
        return {"ok": True, "chars": len(text), "mode": "paste"}
    raise ValueError("不认识的指令: " + cmd)


DPI_MODE = set_dpi_aware()


def process_line(line):
    """处理一行协议消息，任何异常都转成 {"ok":false}，绝不中断服务。"""
    line = line.strip()
    if not line:
        return None
    msg_id = None
    try:
        msg = json.loads(line)
        msg_id = msg.get("id")
        result = handle(msg)
        result["id"] = msg_id
    except ElevatedWindow as e:
        # 不是故障：目标窗口是管理员权限，输入被系统拦住。带上窗口信息，交给上层决定怎么说。
        result = {"id": msg_id, "ok": False, "code": "elevated",
                  "hwnd": e.hwnd, "window": e.window, "pid": e.pid, "error": str(e)}
    except Exception as e:
        result = {"id": msg_id, "ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:200])}
    return result


def main():
    print("[ctl] ready dpi=%s screen=%s" % (DPI_MODE, screen_info()["primary"]), file=sys.stderr, flush=True)
    for line in sys.stdin:
        result = process_line(line)
        if result is not None:
            print(json.dumps(result, ensure_ascii=False), flush=True)
    print("[ctl] stdin 结束，退出", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
