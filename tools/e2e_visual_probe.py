# 端到端视觉验证：唤起 → 切full → 点消息 → resize 往返 → 截图序列
import ctypes
import ctypes.wintypes as wt
import subprocess
import time

from PIL import ImageGrab

u32 = ctypes.windll.user32
EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\release\aif-desktop-client.exe"
OUT = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\tools"

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
    u32.mouse_event(2, 0, 0, 0, 0)
    time.sleep(0.05)
    u32.mouse_event(4, 0, 0, 0, 0)


def shot(name, hwnd):
    r = wt.RECT()
    u32.GetWindowRect(hwnd, ctypes.byref(r))
    img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
    img.save(rf"{OUT}\{name}.png")
    print(f"saved {name}.png", img.size)


hwnd = 0
for i in range(40):
    time.sleep(1)
    allw = find_windows()
    if allw:
        hwnd = allw[0]
        break
assert hwnd, "窗口未出现"
time.sleep(3)

p2 = subprocess.Popen([EXE])
time.sleep(5)
p2.poll()
hwnd = find_windows(visible_only=True)[0]
time.sleep(2)

r = wt.RECT()
u32.GetWindowRect(hwnd, ctypes.byref(r))
print(f"win: ({r.left},{r.top}) {r.right-r.left}x{r.bottom-r.top} zoomed={u32.IsZoomed(hwnd)}")

# 步骤 A：点 mode 一次 → 应进入 full（若已 full 则切 mini，截图可辨）
click(r.right - 52, r.top + 22)
time.sleep(4)
u32.GetWindowRect(hwnd, ctypes.byref(r))
print(f"A(after mode1): zoomed={u32.IsZoomed(hwnd)} size={r.right-r.left}x{r.bottom-r.top}")
shot("v_A_mode1", hwnd)

# 若切到了 mini（窗口变小），再点一次回 full
u32.GetWindowRect(hwnd, ctypes.byref(r))
if not u32.IsZoomed(hwnd):
    click(r.right - 52, r.top + 22)
    time.sleep(4)
    print(f"A2(after mode2): zoomed={u32.IsZoomed(hwnd)}")

# 步骤 B：点第一条消息 → pane 打开
u32.GetWindowRect(hwnd, ctypes.byref(r))
click(r.left + 150, r.top + 160)
time.sleep(8)
shot("v_B_msg_opened", hwnd)

# 步骤 C：resize 往返（还原→最大化）→ 验证 pane 跟随
u32.ShowWindowAsync(hwnd, 9)  # SW_RESTORE
time.sleep(2)
u32.ShowWindowAsync(hwnd, 3)  # SW_MAXIMIZE
time.sleep(2)
shot("v_C_after_resize", hwnd)
u32.GetWindowRect(hwnd, ctypes.byref(r))
print(f"C: zoomed={u32.IsZoomed(hwnd)} size={r.right-r.left}x{r.bottom-r.top}")
