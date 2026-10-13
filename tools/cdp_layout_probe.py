# 一体化：启动实例(带内置调试口) → 等 CDP → 抓 mini/full 两态布局
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
            print("CDP ready:", page.get("title"))
            break
    except Exception:
        pass
assert page, "CDP 未就绪"

time.sleep(3)  # 等前端 bootstrap / 自动登录
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
    r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    return r.get("result", {}).get("value")


def rect(sel):
    return ("(function(e){if(!e) return null; var b=e.getBoundingClientRect();"
            "var s=getComputedStyle(e);"
            "return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)]"
            "+' disp='+s.display+' flex='+s.flex+' w='+s.width;})"
            f"(document.querySelector('{sel}'))")


SNAP = (
    "JSON.stringify({"
    "innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio,"
    "mode: (document.querySelector('.panel')||{}).className,"
    f"sidenav: {rect('.sidenav')},"
    f"content: {rect('.content')},"
    f"pane: {rect('.web-pane')},"
    f"card: {rect('#content .li')},"
    f"listWrap: {rect('#content > div')}"
    "})"
)

print("== mini ==")
print(ev(SNAP))

print("click btn-mode:", ev("(function(){var b=document.getElementById('btn-mode'); if(b){b.click(); return 'ok';} return 'no-btn';})()"))
time.sleep(4)

print("== full ==")
print(ev(SNAP))

ws.close()
