# -*- coding: utf-8 -*-
"""临时诊断：启动客户端 → 抓取窗口客户区与全屏截图。用完即删。"""
import ctypes, ctypes.wintypes as w, os, subprocess, time
from PIL import ImageGrab

EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\x86_64-pc-windows-msvc\release\aif-desktop-client.exe"
OUT = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\tools"

u = ctypes.windll.user32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try: u.SetProcessDPIAware()
    except Exception: pass

proc = subprocess.Popen([EXE])
print("pid", proc.pid, flush=True)
time.sleep(10)

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

info = []

def cb(h, l):
    pid = w.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(pid))
    if pid.value != proc.pid: return True
    cls = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, cls, 256)
    if cls.value != "Tauri Window": return True
    rw = RECT(); u.GetWindowRect(h, ctypes.byref(rw))
    rc = RECT(); u.GetClientRect(h, ctypes.byref(rc))
    org = POINT(0, 0); u.ClientToScreen(h, ctypes.byref(org))
    info.append((h, [rw.left, rw.top, rw.right, rw.bottom], [rc.right, rc.bottom], [org.x, org.y], bool(u.IsZoomed(h))))
    return True

u.EnumWindows(EnumProc(cb), 0)
print("main windows:", info, flush=True)

if info:
    h, rw, cwh, org, zm = info[0]
    # 客户区矩形（屏幕坐标）
    box = (org[0], org[1], org[0] + cwh[0], org[1] + cwh[1])
    ImageGrab.grab(bbox=box).save(os.path.join(OUT, "_shot_client.png"))
    print("client shot box:", box, flush=True)

ImageGrab.grab().save(os.path.join(OUT, "_shot_full.png"))
print("full shot saved", flush=True)

try:
    proc.terminate(); time.sleep(1); proc.kill()
except Exception: pass
print("DONE", flush=True)
