# 一体化：启动 → full 模式 → pane_open → 截图视觉验证
import json
import subprocess
import time
import urllib.request

import websocket
from PIL import ImageGrab

EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\release\aif-desktop-client.exe"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

proc = subprocess.Popen([EXE])
print("launched:", proc.pid)

page = None
for i in range(30):
    time.sleep(1)
    if proc.poll() is not None:
        print("进程退出 code=", proc.returncode)
        break
    try:
        data = json.load(opener.open("http://127.0.0.1:9223/json", timeout=2))
        pages = [t for t in data if t.get("type") == "page"]
        if pages:
            page = pages[0]
            break
    except Exception:
        pass
assert page, "CDP 未就绪"
time.sleep(3)

ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15, suppress_origin=True)
_mid = 0


def call(method, params=None):
    global _mid
    _mid += 1
    ws.send(json.dumps({"id": _mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _mid:
            return msg.get("result", {})


def ev(expr):
    r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in r:
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:200]
    return r.get("result", {}).get("value")


ev("(function(){document.getElementById('btn-mode') && document.getElementById('btn-mode').click();})()")
time.sleep(3)
print("mode:", ev("(document.querySelector('.panel')||{}).className"))
print("pane_open:", ev("""(async function(){
  try {
    await window.__TAURI_INTERNALS__.invoke('pane_open', {url: 'https://51yunwei.com.cn/AIF/user/index.htm', x: 604, y: 73, w: 1591, h: 1342});
    return 'ok';
  } catch(e) { return 'ERR: ' + String(e); }
})()"""))
time.sleep(8)

# 找窗口并截图
import ctypes
import ctypes.wintypes as wt
u32 = ctypes.windll.user32
target = None


@ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
def cb(h, l):
    global target
    cls = ctypes.create_unicode_buffer(64)
    u32.GetClassNameW(h, cls, 64)
    if cls.value == "Tauri Window" and u32.IsWindowVisible(h):
        target = h
    return True


u32.EnumWindows(cb, 0)
print("hwnd:", target)
if target:
    r = wt.RECT()
    u32.GetWindowRect(target, ctypes.byref(r))
    print("rect:", (r.left, r.top, r.right, r.bottom))
    img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
    img.save(r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\tools\pane_visual.png")
    print("saved", img.size)

data = json.load(opener.open("http://127.0.0.1:9223/json", timeout=5))
for t in data:
    print("target:", t.get("type"), "|", t.get("url", "")[:80])
ws.close()
