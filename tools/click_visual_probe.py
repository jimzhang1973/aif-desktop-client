# 无 CDP 验证：启动 → 模拟点击(切全屏/点消息) → 截图 + 窗口枚举
import ctypes
import ctypes.wintypes as wt
import subprocess
import time

from PIL import ImageGrab

u32 = ctypes.windll.user32
EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\release\aif-desktop-client.exe"

proc = subprocess.Popen([EXE])
print("launched:", proc.pid)


def find_windows(visible_only=False):
    found = []
    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(h, l):
        cls = ctypes.create_unicode_buffer(64)
        u32.GetClassNameW(h, cls, 64)
        if cls.value == "Tauri Window" and (not visible_only or u32.IsWindowVisible(h)):
            found.append(h)
        return True
    u32.EnumWindows(cb, 0)
    return found


def click(x, y):
    u32.SetCursorPos(int(x), int(y))
    time.sleep(0.15)
    u32.mouse_event(2, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    u32.mouse_event(4, 0, 0, 0, 0)  # LEFTUP


hwnd = 0
for i in range(40):
    time.sleep(1)
    if proc.poll() is not None:
        print("进程退出 code=", proc.returncode)
        break
    allw = find_windows()
    if allw:
        hwnd = allw[0]
        break
assert hwnd, "窗口未出现"
time.sleep(3)  # 等 bootstrap/自动登录

# 主窗口启动默认隐藏：用第二实例触发 single_instance → raise_main 唤起（等价托盘）
p2 = subprocess.Popen([EXE])
time.sleep(5)
p2.poll()
hwnds = find_windows(visible_only=True)
assert hwnds, "唤起后仍无窗口"
hwnd = hwnds[0]
time.sleep(2)

r = wt.RECT()
u32.GetWindowRect(hwnd, ctypes.byref(r))
W, H = r.right - r.left, r.bottom - r.top
print(f"window rect=({r.left},{r.top}) {W}x{H}")

# 1) 点右上「切换全屏」按钮：hide(─) 最右，mode 在其左侧
btn_mode_x = r.right - 52
btn_mode_y = r.top + 22
click(btn_mode_x, btn_mode_y)
time.sleep(4)
u32.GetWindowRect(hwnd, ctypes.byref(r))
print(f"after mode: rect=({r.left},{r.top}) {r.right-r.left}x{r.bottom-r.top} zoomed={u32.IsZoomed(hwnd)}")

# 2) 点列表第一条消息（左栏中部）
click(r.left + 150, r.top + 160)
time.sleep(7)

# 3) 枚举窗口（看是否有独立 conversation 窗口 = fallback）
wins = find_windows()
print("visible tauri windows:", len(wins))

# 4) 截图
u32.GetWindowRect(hwnd, ctypes.byref(r))
img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
img.save(r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\tools\pane_visual.png")
print("screenshot saved", img.size)
