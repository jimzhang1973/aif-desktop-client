# 只读诊断：枚举客户端进程的全部顶层窗口真实状态（visible/iconic/zoomed/cloaked/rect）
import ctypes
import subprocess
from ctypes import wintypes

u32 = ctypes.windll.user32

EXE = "巨鹏软件客户端.exe"
out = subprocess.check_output(
    ["tasklist", "/FI", f"IMAGENAME eq {EXE}", "/FO", "CSV"]
).decode("gbk", "ignore")
print("tasklist:", out.strip())
pids = []
for line in out.strip().splitlines()[1:]:
    try:
        pids.append(int(line.split('","')[1]))
    except Exception:
        pass
print("pids:", pids)
if not pids:
    # 兜底：旧 exe 名
    out = subprocess.check_output(["tasklist", "/FI", "IMAGENAME eq aif-desktop-client.exe", "/FO", "CSV"]).decode("gbk", "ignore")
    print("fallback:", out.strip())
    for line in out.strip().splitlines()[1:]:
        try:
            pids.append(int(line.split('","')[1]))
        except Exception:
            pass
    print("pids:", pids)


@ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
def cb(h, l):
    pid = wintypes.DWORD()
    u32.GetWindowThreadProcessId(h, ctypes.byref(pid))
    if pid.value in pids:
        buf = ctypes.create_unicode_buffer(256)
        u32.GetWindowTextW(h, buf, 256)
        cls = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(h, cls, 256)
        rect = wintypes.RECT()
        u32.GetWindowRect(h, ctypes.byref(rect))
        vis = u32.IsWindowVisible(h)
        ico = u32.IsIconic(h)
        zoom = u32.IsZoomed(h)
        cloaked = ctypes.c_uint()
        ctypes.windll.dwmapi.DwmGetWindowAttribute(h, 14, ctypes.byref(cloaked), 4)
        print(
            "HWND=0x%X class=%r title=%r vis=%s iconic=%s zoomed=%s cloaked=%s rect=(%d,%d)-(%d,%d)"
            % (h, cls.value, buf.value, vis, ico, zoom, cloaked.value,
               rect.left, rect.top, rect.right, rect.bottom)
        )
    return True


u32.EnumWindows(cb, 0)
