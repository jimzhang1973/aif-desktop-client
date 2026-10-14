# -*- coding: utf-8 -*-
"""CDP 挂载运行中应用：打开网盘页，dump diskSt + 树 DOM + console 日志。只读调试。"""
import json
import time
import urllib.request

import websocket

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
pages = json.load(opener.open("http://127.0.0.1:9223/json", timeout=5))
page = next(t for t in pages if t.get("type") == "page")
print("page url:", page["url"])

ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=15, suppress_origin=True)
_mid = 0
CONSOLE = []


def call(method, params=None):
    global _mid
    _mid += 1
    ws.send(json.dumps({"id": _mid, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("method") == "Runtime.consoleAPICalled":
            p = msg["params"]
            txt = " ".join(str(a.get("value", a.get("description", "")))[:120] for a in p.get("args", []))
            CONSOLE.append(f"[{p.get('type')}] {txt[:200]}")
        if msg.get("method") == "Runtime.exceptionThrown":
            d = msg["params"]["exceptionDetails"]
            CONSOLE.append("[EXC] " + json.dumps(d, ensure_ascii=False)[:300])
        if msg.get("id") == _mid:
            return msg.get("result", {})


def ev(expr, timeout_await=False):
    r = call("Runtime.evaluate", {"expression": expr, "returnByValue": True,
                                  "awaitPromise": timeout_await, "timeout": 15000})
    if "exceptionDetails" in r:
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:400]
    return r.get("result", {}).get("value")


call("Runtime.enable")

# 1) 应用当前状态
print("== 基本状态 ==")
print("mode btn exists:", ev("!!document.getElementById('btn-mode')"))
print("nav items:", ev("Array.from(document.querySelectorAll('[data-tab], .nav a, nav button')).map(e=>e.dataset.tab||e.textContent.trim()).slice(0,20)"))

# 2) 打开网盘 tab（找导航入口）
r = ev("""(function(){
  const links = Array.from(document.querySelectorAll('a,button,[data-tab]'));
  const disk = links.find(e => /网盘|disk/i.test((e.dataset&&e.dataset.tab)||e.textContent||''));
  if (disk) { disk.click(); return 'clicked:'+(disk.dataset.tab||disk.textContent.trim()); }
  return 'no-disk-link';
})()""")
print("open disk:", r)
time.sleep(5)

# 3) dump diskSt
print("\n== diskSt ==")
st = ev("""JSON.stringify((function(){
  if (typeof diskSt === 'undefined') return 'NO diskSt global';
  return {
    spaceId: diskSt.spaceId,
    spaces: (diskSt.spaces||[]).map(s=>s.name),
    roots: (diskSt.roots||[]).map(r=>({id:r.id, name:r.name, nodeType:r.nodeType})),
    flatCount: diskSt.flat ? diskSt.flat.size : 'n/a',
    childrenKeys: diskSt.children ? Array.from(diskSt.children.entries()).map(([k,v])=>k+':'+v.length) : [],
    loaded: diskSt.loaded ? Array.from(diskSt.loaded) : [],
    expanded: diskSt.expanded ? Array.from(diskSt.expanded) : []
  };
})())""")
print(st)

# diskSt 可能不是全局变量 —— 尝试从模块作用域找（Vite dev 下通过 import.meta 无从访问，退路：查 DOM）
print("\n== 树 DOM ==")
tree_html = ev("document.getElementById('disk-tree') ? document.getElementById('disk-tree').innerHTML.slice(0, 2500) : 'NO #disk-tree'")
print(tree_html)

print("\n== disk-log ==")
print(ev("document.getElementById('disk-log') ? document.getElementById('disk-log').innerHTML.slice(0,800) : 'no log'"))

print("\n== 空间下拉 ==")
print(ev("document.getElementById('disk-space') ? Array.from(document.getElementById('disk-space').options).map(o=>o.value.slice(0,20)+'/'+o.text) : 'no sel'"))

print("\n== console ==")
for c in CONSOLE[-25:]:
    print(c)
