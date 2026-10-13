# 直接在 CDP 里调 maximize / 查 setLayoutMode 失败原因
import json
import subprocess
import time
import urllib.request

import websocket

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

ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
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
    res = r.get("result", {})
    if "exceptionDetails" in r:
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:300]
    return res.get("value")


# 1) 直接 invoke maximize，捕获异常
print("invoke maximize:", ev("(async function(){ try { await window.__TAURI_INTERNALS__.invoke('plugin:window|maximize'); return 'ok'; } catch(e) { return 'ERR: ' + String(e); } })()"))
time.sleep(2)
print("innerW after:", ev("window.innerWidth + 'x' + window.innerHeight + ' dpr=' + window.devicePixelRatio"))

# 2) click btn-mode 并捕获后续状态
print("click:", ev("(function(){var b=document.getElementById('btn-mode'); if(b){b.click(); return 'ok';} return 'no-btn';})()"))
time.sleep(3)
print("mode class:", ev("(document.querySelector('.panel')||{}).className"))
print("innerW:", ev("window.innerWidth + 'x' + window.innerHeight"))
# localStorage 布局
print("layout saved:", ev("localStorage.getItem('aif_layout')"))
ws.close()
