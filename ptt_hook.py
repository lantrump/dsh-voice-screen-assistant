# -*- coding: utf-8 -*-
"""按住说话的全局键盘钩子：只盯一个键。

- 主进程通过 stdin 发 "allow 1" / "allow 0"，决定这个键现在是"说话"还是普通打字。
- 说话时按住：吞掉按键（不让 t 打进别的窗口），往 stdout 打 down；松开打 up。
- 从不记录、不上报别的按键；别人打的字一概放行。
- 注入的按键（agent 自己用 SendInput 打的）一律放行——不然它干活时打不出字母 t。
"""
import sys
import io
import time
import ctypes
from ctypes import wintypes as wt

VK = 0x54                    # 默认 T
WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP = 0x100, 0x101, 0x104, 0x105
LLKHF_INJECTED = 0x10
MOD_VKS = (0x11, 0x12, 0x10, 0x5B, 0x5C)   # Ctrl / Alt / Shift / Win

# 打字和说话靠按住时长区分：快速一按是打字（把 t 补发给前台程序），
# 按住超过 TAP_MS 才算说话。正常敲键的按下时长一般 60~120ms，按住说话远长于这个。
TAP_MS = 150

ALLOW = False
HELD = False
HELD_AT = 0.0


def emit(word):
    try:
        print(word, flush=True)
    except Exception:
        pass


def mods_down():
    """Ctrl/Alt/Shift/Win 按着的时候不算说话：Ctrl+T、Shift+T 这些快捷键照常放行。"""
    try:
        return any(user32.GetAsyncKeyState(vk) & 0x8000 for vk in MOD_VKS)
    except Exception:
        return False


def set_allow(on):
    global ALLOW, HELD
    ALLOW = bool(on)
    if not ALLOW and HELD:          # 说到一半焦点变了：把这句结束掉，别一直录
        HELD = False
        emit("up")


def replay_key():
    """把被吞掉的那次 T 补发给前台程序（打字场景）。注入事件带 injected 标记，不会再被自己吞。"""
    try:
        user32.keybd_event(VK, 0, 0, 0)
        user32.keybd_event(VK, 0, 2, 0)      # KEYEVENTF_KEYUP
    except Exception:
        pass


def handle_key(vk, msg, injected=False):
    """返回 True = 吞掉这个按键事件；False = 原样放行。"""
    global HELD, HELD_AT
    if vk != VK or not ALLOW or injected:
        return False
    if msg in (WM_KEYDOWN, WM_SYSKEYDOWN):
        if not HELD:
            if mods_down():         # 组合键里的 T 不是说话，原样放行
                return False
            HELD = True
            HELD_AT = time.monotonic()
            emit("down")            # 先开始录，免得吞掉句首
        return True                 # 自动重复也吞掉，但不重复报 down
    if msg in (WM_KEYUP, WM_SYSKEYUP):
        if HELD:
            held_ms = (time.monotonic() - HELD_AT) * 1000.0
            HELD = False
            if held_ms < TAP_MS:
                emit("tap")         # 一按就松：是打字，不是说话
                replay_key()
            else:
                emit("up")
            return True
        # 没吞过对应的按下（比如按下时还允许放行），松开也原样放行，
        # 否则别的程序会收到一个没有配对的 keyup。
        return False
    return False


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wt.DWORD), ("scanCode", wt.DWORD), ("flags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


def main():
    global VK
    global user32
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    if len(sys.argv) > 1:
        try:
            VK = int(sys.argv[1], 0)
        except Exception:
            pass

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, wt.WPARAM, wt.LPARAM)
    user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, ctypes.c_void_p, wt.DWORD]
    user32.SetWindowsHookExW.restype = ctypes.c_void_p
    user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int, wt.WPARAM, wt.LPARAM]
    user32.CallNextHookEx.restype = ctypes.c_ssize_t
    user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), ctypes.c_void_p, wt.UINT, wt.UINT]
    user32.TranslateMessage.argtypes = [ctypes.POINTER(wt.MSG)]
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(wt.MSG)]

    def hook_proc(nCode, wParam, lParam):
        if nCode == 0:
            try:
                kb = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
                if handle_key(kb.vkCode, wParam, bool(kb.flags & LLKHF_INJECTED)):
                    return 1
            except Exception:
                pass
        return user32.CallNextHookEx(None, nCode, wParam, lParam)

    proc = HOOKPROC(hook_proc)
    hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, proc, None, 0)
    if not hook:
        print("[fatal] SetWindowsHookEx failed: %d" % ctypes.get_last_error(), flush=True)
        sys.exit(1)

    def stdin_reader():
        try:
            for raw in sys.stdin:
                parts = raw.strip().lower().split()
                if len(parts) == 2 and parts[0] == "allow":
                    set_allow(parts[1] == "1")
        except Exception:
            pass

    import threading
    threading.Thread(target=stdin_reader, daemon=True).start()
    print("[ready] vk=%d" % VK, flush=True)

    msg = wt.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


if __name__ == "__main__":
    main()
