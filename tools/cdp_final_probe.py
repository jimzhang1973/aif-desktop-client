# 最终验证：env-var CDP → full 模式 → 点消息 → pane target + 截图
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import time
import urllib.request

import websocket
from PIL import ImageGrab

EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\release\aif-desktop-client.exe"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

env = dict(os.environ)
env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=9223"
proc = subprocess.Popen([EXE], env=env)
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


# 唤起主窗口（若隐藏）
ev("(async function(){ try { await window.__TAURI_INTERNALS__.invoke('plugin:window|show'); return 'ok'; } catch(e){ return 'ERR:'+e; } })()")
time.sleep(1)

print("click mode:", ev("(function(){var b=document.getElementById('btn-mode'); if(b){b.click(); return 'ok';} return 'no-btn(未登录?)';})()"))
time.sleep(4)
print("mode:", ev("(document.querySelector('.panel')||{}).className"), "innerW:", ev("window.innerWidth"))

print("click msg:", ev("""(function(){
  var item = document.querySelector('#content .li, #content .msg-row, #content .list-item');
  if (!item) return 'no item';
  item.click(); return 'clicked';
})()"""))
time.sleep(7)

print("pane dom:", ev("""JSON.stringify((function(e){if(!e) return null; var b=e.getBoundingClientRect(); var d=window.devicePixelRatio; return {phys:[Math.round(b.left*d),Math.round(b.top*d),Math.round(b.width*d),Math.round(b.height*d)]};})(document.querySelector('.web-pane')))"""))

# targets
data = json.load(opener.open("http://127.0.0.1:9223/json", timeout=5))
pane = None
for t in data:
    print("target:", t.get("type"), "|", t.get("url", "")[:80])
    if t.get("type") == "page" and t.get("url") != "http://tauri.localhost/" and not pane:
        pane = t

if pane:
    print("PANE TARGET OK:", pane.get("url", "")[:80])

# 截图
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
if target:
    r = wt.RECT()
    u32.GetWindowRect(target, ctypes.byref(r))
    img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
    img.save(r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\tools\pane_visual.png")
    print("screenshot saved", img.size)
ws.close()
