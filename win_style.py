# -*- coding: utf-8 -*-
"""把助手窗口从 Alt+Tab 切换器里去掉。

参数: HWND（十进制或 0x 开头的十六进制）。
skipTaskbar 只管任务栏，Alt+Tab 仍会显示一个空白预览和窗口标题；
WS_EX_TOOLWINDOW 才是让窗口不进 Alt+Tab 的开关（工具窗口仍然可交互、可置顶）。
"""
import sys
import ctypes

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_FRAMECHANGED = 0x0020


def main():
    if len(sys.argv) < 2:
        return 2
    try:
        hwnd = int(sys.argv[1], 0)
    except Exception:
        return 2

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    if ctypes.sizeof(ctypes.c_void_p) == 8:
        get_long = user32.GetWindowLongPtrW
        set_long = user32.SetWindowLongPtrW
        get_long.restype = ctypes.c_ssize_t
        get_long.argtypes = [ctypes.c_void_p, ctypes.c_int]
        set_long.restype = ctypes.c_ssize_t
        set_long.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
    else:
        get_long = user32.GetWindowLongW
        set_long = user32.SetWindowLongW
        get_long.restype = ctypes.c_long
        get_long.argtypes = [ctypes.c_void_p, ctypes.c_int]
        set_long.restype = ctypes.c_long
        set_long.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]

    user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                    ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_uint]

    style = get_long(hwnd, GWL_EXSTYLE)
    set_long(hwnd, GWL_EXSTYLE, (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
    user32.SetWindowPos(hwnd, None, 0, 0, 0, 0,
                        SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED)
    return 0


if __name__ == "__main__":
    sys.exit(main())
