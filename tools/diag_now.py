# -*- coding: utf-8 -*-
"""实时取证：窗口真实几何(DWM EFB) vs 显示器 / 抓屏像素分析左上角"""
import ctypes
from ctypes import wintypes
from PIL import ImageGrab, Image

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

EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def title_of(h):
    n = user32.GetWindowTextLengthW(h)
    b = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(h, b, n + 1)
    return b.value

targets = []
def cb(h, l):
    if user32.IsWindowVisible(h):
        t = title_of(h)
        if ("一表通" in t) or ("巨鹏" in t):
            targets.append((h, t))
    return True
user32.EnumWindows(EnumProc(cb), 0)
print("found windows:", [(hex(h), t) for h, t in targets])

DWMWA_EXTENDED_FRAME_BOUNDS = 9
for h, t in targets:
    wr = RECT(); user32.GetWindowRect(h, ctypes.byref(wr))
    efb = RECT(); dwmapi.DwmGetWindowAttribute(h, 9, ctypes.byref(efb), ctypes.sizeof(efb))
    cr = RECT(); user32.GetClientRect(h, ctypes.byref(cr))
    pt = wintypes.POINT(0, 0); user32.ClientToScreen(h, ctypes.byref(pt))
    mi = MONITORINFO(); mi.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(user32.MonitorFromWindow(h, 2), ctypes.byref(mi))
    dpi = user32.GetDpiForWindow(h)
    zoomed = user32.IsZoomed(h)
    print(f"\n=== {t} (hwnd {hex(h)}) ===")
    print(f" winRect   = ({wr.left},{wr.top})-({wr.right},{wr.bottom})  {wr.right-wr.left}x{wr.bottom-wr.top}")
    print(f" EFB(visible)= ({efb.left},{efb.top})-({efb.right},{efb.bottom})  {efb.right-efb.left}x{efb.bottom-efb.top}")
    print(f" client    = {cr.right-cr.left}x{cr.bottom-cr.top} origin_screen=({pt.x},{pt.y})")
    print(f" monitor   = ({mi.rcMonitor.left},{mi.rcMonitor.top})-({mi.rcMonitor.right},{mi.rcMonitor.bottom})")
    print(f" workArea  = ({mi.rcWork.left},{mi.rcWork.top})-({mi.rcWork.right},{mi.rcWork.bottom})")
    print(f" dpi={dpi} zoomed={zoomed}")
    # EFB 相对显示器的偏移（正=窗口起点在显示器内右下方；负=超出显示器左上）
    print(f" EFB offset vs monitor: dx={efb.left-mi.rcMonitor.left}, dy={efb.top-mi.rcMonitor.top}")
    print(f" EFB right-bottom overflow: dx={efb.right-mi.rcMonitor.right}, dy={efb.bottom-mi.rcMonitor.bottom}")

    # 抓 EFB 区域并分析左上角
    img = ImageGrab.grab(bbox=(efb.left, efb.top, efb.right, efb.bottom), all_screens=True)
    p = "tools/_now_win.png"
    img.save(p)
    W, H = img.size
    print(f"\n shot {p} = {W}x{H}")
    def rowmean(y, x0=0, x1=None):
        x1 = x1 or W
        n = 0; s = [0,0,0]
        for x in range(x0, x1, 4):
            px = img.getpixel((x, y)); s[0]+=px[0]; s[1]+=px[1]; s[2]+=px[2]; n+=1
        return tuple(v//n for v in s)
    def colmean(x, y0=0, y1=None):
        y1 = y1 or H
        n = 0; s = [0,0,0]
        for y in range(y0, y1, 4):
            px = img.getpixel((x, y)); s[0]+=px[0]; s[1]+=px[1]; s[2]+=px[2]; n+=1
        return tuple(v//n for v in s)
    print(" rows 0..130 (expect: 0-72=topbar 白色渐变带文字, 72+ = sidenav/content):")
    for y in list(range(0, 130, 6)):
        print(f"   y={y:4d} mean={rowmean(y)}")
    print(" cols 0..130 (expect: 0-78=sidenav 白色+右侧 #e5e7eb 边线):")
    for x in list(range(0, 130, 6)):
        print(f"   x={x:4d} mean={colmean(x, 80, min(H,900))}")
    # 蓝色品牌元素粗图（48x24 网格）
    def bluish(px):
        r,g,b = px[:3]
        return b > 110 and (b-r) > 45 and (b-g) > 35
    print(" blue-accent map (48x24):")
    for gy in range(24):
        line = ""
        for gx in range(48):
            c = 0
            for y in range(gy*H//24, (gy+1)*H//24, max(1,H//96)):
                for x in range(gx*W//48, (gx+1)*W//48, max(1,W//192)):
                    if bluish(img.getpixel((x,y))): c += 1
            line += "#" if c > 6 else ("+" if c > 0 else ".")
        print(f"   {line}")
