# -*- coding: utf-8 -*-
"""临时诊断：启动客户端并用 Win32 读取窗口真实矩形/客户区/监视器/DPI。用完即删。"""
import ctypes, ctypes.wintypes as w, os, subprocess, sys, time

EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\x86_64-pc-windows-msvc\release\aif-desktop-client.exe"

u = ctypes.windll.user32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)   # PER_MONITOR_AWARE_V2
except Exception:
    try: u.SetProcessDPIAware()
    except Exception: pass

proc = subprocess.Popen([EXE])
print("pid", proc.pid, flush=True)
time.sleep(9)

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("rcMonitor", RECT), ("rcWork", RECT), ("dwFlags", ctypes.c_ulong)]

found = []

def cb(h, l):
    pid = w.DWORD()
    u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    if pid.value != proc.pid:
        return True
    cls = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, cls, 256)
    txt = ctypes.create_unicode_buffer(256); u.GetWindowTextW(h, txt, 256)

    rw = RECT(); u.GetWindowRect(h, ctypes.byref(rw))
    rc = RECT(); u.GetClientRect(h, ctypes.byref(rc))

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
    org = POINT(0, 0)
    u.ClientToScreen(h, ctypes.byref(org))

    # 窗口所属监视器（用 MONITOR_DEFAULTTONEAREST）
    MON = 2
    hmon = u.MonitorFromWindow(h, MON)
    mi = MONITORINFO(); mi.cbSize = ctypes.sizeof(MONITORINFO)
    u.GetMonitorInfoW(hmon, ctypes.byref(mi))

    style = u.GetWindowLongW(h, -16)
    exstyle = u.GetWindowLongW(h, -20)
    try:
        dpi = u.GetDpiForWindow(h)
    except Exception:
        dpi = 0

    found.append({
        "hwnd": h, "class": cls.value, "title": txt.value,
        "visible": bool(u.IsWindowVisible(h)),
        "zoomed(maximized)": bool(u.IsZoomed(h)),
        "iconic(minimized)": bool(u.IsIconic(h)),
        "windowRect": [rw.left, rw.top, rw.right, rw.bottom],
        "windowWH": [rw.right - rw.left, rw.bottom - rw.top],
        "clientWH": [rc.right, rc.bottom],
        "clientOriginScreen": [org.x, org.y],
        "clientOffsetInWindow": [org.x - rw.left, org.y - rw.top],
        "monitorRect": [mi.rcMonitor.left, mi.rcMonitor.top, mi.rcMonitor.right, mi.rcMonitor.bottom],
        "workRect": [mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom],
        "dpi": dpi, "style": hex(style & 0xffffffff), "exstyle": hex(exstyle & 0xffffffff),
    })
    return True

u.EnumWindows(EnumProc(cb), 0)
import json
print(json.dumps(found, ensure_ascii=False, indent=1), flush=True)

# 子窗口（多 webview 时会有子 HWND）
children = []
def ccb(h, l):
    if l == 0:
        return True
    cls = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, cls, 256)
    rw = RECT(); u.GetWindowRect(h, ctypes.byref(rw))
    children.append((h, cls.value, [rw.left, rw.top, rw.right, rw.bottom]))
    return True
for f in found:
    u.EnumChildWindows(f["hwnd"], ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)(ccb), 1)
print("children:", json.dumps(children, ensure_ascii=False), flush=True)

try:
    proc.terminate(); time.sleep(1); proc.kill()
except Exception: pass
print("DONE", flush=True)
