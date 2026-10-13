# -*- coding: utf-8 -*-
"""显示主窗 -> 实测几何(全部显示器) -> 抓屏像素分析"""
import ctypes, time
from ctypes import wintypes
from PIL import ImageGrab

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", RECT), ("rcWork", RECT),
                ("dwFlags", wintypes.DWORD)]

MonProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(RECT), wintypes.LPARAM)
monitors = []
def mcb(hm, hdc, rc, l):
    monitors.append(rc.contents)
    return True
user32.EnumDisplayMonitors(0, 0, MonProc(mcb), 0)
print("=== monitors ===")
for i, m in enumerate(monitors):
    print(f"  [{i}] ({m.left},{m.top})-({m.right},{m.bottom})  {m.right-m.left}x{m.bottom-m.top}")

# 找主窗
EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def title_of(h):
    n = user32.GetWindowTextLengthW(h)
    b = ctypes.create_unicode_buffer(n+1); user32.GetWindowTextW(h, b, n+1)
    return b.value
main = []
def cb(h, l):
    t = title_of(h)
    if t in ("一表通小助手", "运维小助手", "巨鹏软件客户端"):
        main.append(h)
    return True
user32.EnumWindows(EnumProc(cb), 0)
print("main hwnd:", [hex(h) for h in main])
if not main:
    print("NOT FOUND"); raise SystemExit
h = main[0]

# 显示窗口（等价于托盘唤起对 hide 的反向操作）
user32.ShowWindow(h, 5)  # SW_SHOW
user32.SetForegroundWindow(h)
time.sleep(2.0)

wr = RECT(); user32.GetWindowRect(h, ctypes.byref(wr))
efb = RECT(); dwmapi.DwmGetWindowAttribute(h, 9, ctypes.byref(efb), ctypes.sizeof(efb))
cr = RECT(); user32.GetClientRect(h, ctypes.byref(cr))
pt = wintypes.POINT(0,0); user32.ClientToScreen(h, ctypes.byref(pt))
mi = MONITORINFO(); mi.cbSize = ctypes.sizeof(MONITORINFO)
user32.GetMonitorInfoW(user32.MonitorFromWindow(h, 2), ctypes.byref(mi))
print(f"\n=== after show ===")
print(f" winRect = ({wr.left},{wr.top})-({wr.right},{wr.bottom}) {wr.right-wr.left}x{wr.bottom-wr.top} zoomed={user32.IsZoomed(h)}")
print(f" EFB     = ({efb.left},{efb.top})-({efb.right},{efb.bottom}) {efb.right-efb.left}x{efb.bottom-efb.top}")
print(f" client  = {cr.right-cr.left}x{cr.bottom-cr.top} origin=({pt.x},{pt.y})")
print(f" monitor = ({mi.rcMonitor.left},{mi.rcMonitor.top})-({mi.rcMonitor.right},{mi.rcMonitor.bottom})")
print(f" work    = ({mi.rcWork.left},{mi.rcWork.top})-({mi.rcWork.right},{mi.rcWork.bottom})")

# 抓整个虚拟屏幕
vx = user32.GetSystemMetrics(76); vy = user32.GetSystemMetrics(77)
vw = user32.GetSystemMetrics(78); vh = user32.GetSystemMetrics(79)
full = ImageGrab.grab(bbox=(vx, vy, vx+vw, vy+vh), all_screens=True)
full.save("tools/_now_full.png")
print(f"\nfull virtual screen shot: {vw}x{vh} origin=({vx},{vy})")

# 在虚拟屏截图里裁出窗口 EFB 区域
ox, oy = efb.left - vx, efb.top - vy
win_img = full.crop((max(0,ox), max(0,oy), min(vw, ox+efb.right-efb.left), min(vh, oy+efb.bottom-efb.top)))
win_img.save("tools/_now_win.png")
W, H = win_img.size
print(f"win crop: {W}x{H} (crop origin in virtual = ({max(0,ox)},{max(0,oy)}); EFB origin=({efb.left},{efb.top}))")

def rowmean(y):
    n=0; s=[0,0,0]
    for x in range(0, W, 4):
        px = win_img.getpixel((x,y)); s[0]+=px[0]; s[1]+=px[1]; s[2]+=px[2]; n+=1
    return tuple(v//n for v in s)
def colmean(x, y0, y1):
    n=0; s=[0,0,0]
    for y in range(y0, min(y1,H), 4):
        px = win_img.getpixel((x,y)); s[0]+=px[0]; s[1]+=px[1]; s[2]+=px[2]; n+=1
    return tuple(v//n for v in s)

print("\n--- win crop rows 0..150 mean (0-72 应为 topbar) ---")
for y in range(0, 151, 10):
    print(f"  y={y:4d} {rowmean(y)}")
print("--- win crop cols 0..150 mean over y=80..H-100 (0-78 应为 sidenav) ---")
for x in range(0, 151, 10):
    print(f"  x={x:4d} {colmean(x, 80, H-100)}")
print("--- 角落采样 ---")
for (x,y) in [(2,2),(40,40),(80,40),(120,80),(200,100),(W-5,2),(2,H-5),(W//2,2)]:
    print(f"  ({x},{y}) = {win_img.getpixel((x,y))}")

# 显示器左上角 400x400（窗口外区域是什么）
tl = full.crop((max(0,0-vx), max(0,0-vy), max(0,0-vx)+400, max(0,0-vy)+400))
tl.save("tools/_now_topleft.png")
print("\n--- monitor top-left 400x400 samples ---")
for (x,y) in [(5,5),(60,60),(120,120),(200,200),(300,300),(380,380)]:
    print(f"  ({x},{y}) = {tl.getpixel((x,y))}")
