# full 模式下点开消息 → 验证内嵌 pane webview 与占位 DOM 对齐
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
    if "exceptionDetails" in r:
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:200]
    return r.get("result", {}).get("value")


# 1) 确保进入 full（点击按钮走 setLayoutMode：class + maximize 一起生效）
print("click mode:", ev("(function(){var b=document.getElementById('btn-mode'); if(b){b.click(); return 'ok';} return 'no-btn';})()"))
time.sleep(4)
print("innerW:", ev("window.innerWidth"), "mode:", ev("(document.querySelector('.panel')||{}).className"))

# 2) 若不在消息 tab 先切过去，再点第一条
print("click msg:", ev("""(function(){
  var item = document.querySelector('#content .li, #content .msg-row, #content .list-item');
  if (!item) return 'no item';
  item.click(); return 'clicked';
})()"""))
time.sleep(6)

# 3) DOM 占位 rect（物理 = 逻辑×dpr）
print("pane dom:", ev("""JSON.stringify((function(e){if(!e) return null; var b=e.getBoundingClientRect(); var d=window.devicePixelRatio; return {logic:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)], phys:[Math.round(b.left*d),Math.round(b.top*d),Math.round(b.width*d),Math.round(b.height*d)]};})(document.querySelector('.web-pane')))"""))

# 4) 找 pane target 并查其视口
data = json.load(opener.open("http://127.0.0.1:9223/json", timeout=5))
for t in data:
    print("target:", t.get("type"), "|", t.get("url", "")[:80])

pane = next((t for t in data if t.get("type") == "page" and t.get("url") != "http://tauri.localhost/"), None)
if pane:
    ws2 = websocket.create_connection(pane["webSocketDebuggerUrl"], timeout=10, suppress_origin=True)
    _mid2 = 1000

    def call2(method, params=None):
        global _mid2
        _mid2 += 1
        ws2.send(json.dumps({"id": _mid2, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws2.recv())
            if msg.get("id") == _mid2:
                return msg.get("result", {})

    r = call2("Runtime.evaluate", {"expression": "JSON.stringify({w:window.innerWidth,h:window.innerHeight})", "returnByValue": True})
    print("pane webview 视口(逻辑):", r.get("result", {}).get("value"))
    ws2.close()
else:
    print("!! 无 pane target")
ws.close()
