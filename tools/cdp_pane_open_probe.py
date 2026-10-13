# 直接 invoke pane_open 抓真实错误 + 捕获 console
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


call("Runtime.enable")

def call_w(method, params=None):
    global _mid
    _mid += 1
    ws.send(json.dumps({"id": _mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _mid:
            return msg
        if msg.get("method") in ("Runtime.consoleAPICalled", "Runtime.exceptionThrown"):
            if msg["method"] == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                print("PAGE EXC:", json.dumps(d.get("exception", d), ensure_ascii=False)[:200])
            else:
                args = msg["params"].get("args", [])
                text = " ".join(str(a.get("value", a.get("description", "")))[:150] for a in args)
                print("PAGE LOG:", text[:250])


def ev(expr):
    r = call_w("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in r:
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:200]
    return r.get("result", {}).get("value")


# 进入 full 模式
ev("(function(){document.getElementById('btn-mode').click();})()")
time.sleep(3)
print("mode:", ev("(document.querySelector('.panel')||{}).className"))

# 直接调用 pane_open（带会话的 B/S 首页）
print("pane_open:", ev("""(async function(){
  try {
    await window.__TAURI_INTERNALS__.invoke('pane_open', {url: 'https://51yunwei.com.cn/AIF/user/index.htm', x: 604, y: 73, w: 1591, h: 1342});
    return 'ok';
  } catch(e) { return 'ERR: ' + String(e); }
})()"""))
time.sleep(6)

data = json.load(opener.open("http://127.0.0.1:9223/json", timeout=5))
for t in data:
    print("target:", t.get("type"), "|", t.get("url", "")[:80])
ws.close()
