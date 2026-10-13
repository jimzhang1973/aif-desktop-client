# -*- coding: utf-8 -*-
"""临时诊断：对比「最大化」与「还原后」两种窗口状态下的渲染。用完即删。"""
import ctypes, ctypes.wintypes as w, os, subprocess, time
from PIL import ImageGrab

EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\x86_64-pc-windows-msvc\release\aif-desktop-client.exe"
OUT = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\tools"

u = ctypes.windll.user32
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try: u.SetProcessDPIAware()
    except Exception: pass

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

SW_RESTORE, SW_MAXIMIZE = 9, 3
HWND_TOP = 0
SWP_NOZORDER, SWP_SHOWWINDOW = 0x0004, 0x0040

proc = subprocess.Popen([EXE])
print("pid", proc.pid, flush=True)

EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)

def find_main():
    res = []
    def cb(h, l):
        pid = w.DWORD(); u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value != proc.pid: return True
        cls = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, cls, 256)
        if cls.value == "Tauri Window": res.append(h)
        return True
    u.EnumWindows(EnumProc(cb), 0)
    return res[0] if res else None

def dump(h, tag):
    rw = RECT(); u.GetWindowRect(h, ctypes.byref(rw))
    rc = RECT(); u.GetClientRect(h, ctypes.byref(rc))
    org = POINT(0, 0); u.ClientToScreen(h, ctypes.byref(org))
    print(f"[{tag}] winRect={[rw.left,rw.top,rw.right,rw.bottom]} clientWH={[rc.right,rc.bottom]} "
          f"clientOrigin={[org.x,org.y]} zoomed={bool(u.IsZoomed(h))}", flush=True)
    return (org.x, org.y, rc.right, rc.bottom)

def shot(h, name):
    u.SetForegroundWindow(h); time.sleep(1.2)
    ImageGrab.grab().save(os.path.join(OUT, name))
    print("saved", name, flush=True)

h = None
for _ in range(40):
    time.sleep(1)
    h = find_main()
    if h: break
assert h, "no main window"

time.sleep(8)
dump(h, "maximized")
shot(h, "_state_maximized.png")

# 还原并移动到屏幕中间偏左上，模拟非最大化窗口
u.ShowWindow(h, SW_RESTORE); time.sleep(1.5)
u.SetWindowPos(h, HWND_TOP, 260, 200, 1700, 1050, SWP_NOZORDER | SWP_SHOWWINDOW)
time.sleep(2.5)
dump(h, "restored")
shot(h, "_state_restored.png")

# 再最大化一次，看是否恢复
u.ShowWindow(h, SW_MAXIMIZE); time.sleep(2.5)
dump(h, "re-maximized")
shot(h, "_state_remax.png")

try: proc.terminate(); time.sleep(1); proc.kill()
except Exception: pass
print("DONE", flush=True)
