# -*- coding: utf-8 -*-
import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    user32.SetProcessDPIAware()

EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def title_of(h):
    n = user32.GetWindowTextLengthW(h)
    b = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(h, b, n + 1)
    return b.value

def exe_of(h):
    pid = wintypes.DWORD(); user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kh = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not kh: return f"pid{pid.value}(no-access)"
    buf = ctypes.create_unicode_buffer(520); size = wintypes.DWORD(520)
    ok = kernel32.QueryFullProcessImageNameW(kh, 0, buf, ctypes.byref(size))
    kernel32.CloseHandle(kh)
    return buf.value.replace("\\", "/").split("/")[-1] if ok else f"pid{pid.value}"

rows = []
def cb(h, l):
    t = title_of(h)
    if t or user32.IsWindowVisible(h):
        rows.append((h, t, bool(user32.IsWindowVisible(h))))
    return True
user32.EnumWindows(EnumProc(cb), 0)

hits = [(h, t, v) for (h, t, v) in rows if "aif-desktop" in exe_of(h)]
print("aif-desktop-client windows:", len(hits))
for h, t, v in hits:
    r = wintypes.RECT(); user32.GetWindowRect(h, ctypes.byref(r))
    print(f"  hwnd={hex(h)} visible={v} title={t!r} rect=({r.left},{r.top})-({r.right},{r.bottom}) {r.right-r.left}x{r.bottom-r.top}")
if not hits:
    # 兜底：列出前 30 个有标题的可见窗口，人工识别
    print("--- visible titled windows (top 30) ---")
    c = 0
    for h, t, v in rows:
        if v and t:
            print(f"  {hex(h)} {t!r} [{exe_of(h)}]")
            c += 1
            if c >= 30: break
