# -*- coding: utf-8 -*-
"""hook invoke 抓 disk_* 实际返回 + dump diskSt（经窗口暴露）。"""
import json
import time
import urllib.request

import websocket

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
pages = json.load(opener.open("http://127.0.0.1:9223/json", timeout=5))
page = next(t for t in pages if t.get("type") == "page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
_mid = 0


def call(method, params=None):
    global _mid
    _mid += 1
    ws.send(json.dumps({"id": _mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == _mid:
            return msg.get("result", {})


def ev(expr, await_promise=False):
    r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                  "awaitPromise": await_promise})
    if "exceptionDetails" in r:
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:400]
    return r.get("result", {}).get("value")


HOOK = """
(function(){
  if (window.__hooked) return 'already';
  const orig = window.__TAURI_INTERNALS__.invoke;
  window.__calls = [];
  window.__TAURI_INTERNALS__.invoke = function(cmd, args, opts){
    const p = orig.call(this, cmd, args, opts);
    if (cmd.indexOf('disk') === 0) {
      window.__calls.push({cmd, args, state: 'pending'});
      p.then(res => {
        const c = window.__calls[window.__calls.length - 1];
        if (c && c.cmd === cmd) { c.state = 'ok'; c.res = res; }
      }, err => {
        const c = window.__calls[window.__calls.length - 1];
        if (c && c.cmd === cmd) { c.state = 'err'; c.err = String(err); }
      });
    }
    return p;
  };
  window.__hooked = true;
  return 'hooked';
})()
"""

print("hook:", ev(HOOK))
print("refresh:", ev('document.getElementById("disk-refresh") ? (document.getElementById("disk-refresh").click(), "clicked") : "no-btn"'))
time.sleep(9)

raw = ev('JSON.stringify(window.__calls || [], (k, v) => (typeof v === "string" && v.length > 130) ? v.slice(0, 130) + "..." : v)')
print("calls raw type:", type(raw).__name__)
try:
    data = json.loads(raw) if isinstance(raw, str) else []
    for c in data:
        print("---", c.get("cmd"), "state:", c.get("state"), "args:", json.dumps(c.get("args"), ensure_ascii=False)[:150])
        if c.get("err"):
            print("   ERR:", c["err"][:250])
        res = c.get("res")
        if isinstance(res, list):
            print("   count:", len(res))
            for n in res[:3]:
                print("   node:", json.dumps(n, ensure_ascii=False)[:240])
        elif res is not None:
            print("   res:", json.dumps(res, ensure_ascii=False)[:240])
except Exception as e:
    print("parse fail:", e, "| raw:", str(raw)[:400])

# 树 DOM 再看一眼
print("\ntree:", ev('document.getElementById("disk-tree") ? document.getElementById("disk-tree").innerHTML.length + " chars, items=" + document.querySelectorAll(".disk-tree-item").length : "no tree"'))
print("log:", ev('document.getElementById("disk-log") ? document.getElementById("disk-log").textContent.slice(0,400) : "no log"'))
