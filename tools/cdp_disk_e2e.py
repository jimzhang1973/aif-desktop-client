# -*- coding: utf-8 -*-
"""端到端验证：打开网盘 → 等加载 → dump 树结构 → 点目录展开 → 再 dump。"""
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
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:300]
    return r.get("result", {}).get("value")


call("Runtime.enable")

print("open disk tab:", ev("""(function(){
  const d = Array.from(document.querySelectorAll('[data-tab]')).find(e => e.dataset.tab === 'disk');
  if (d) { d.click(); return 'ok'; } return 'no';
})()"""))
time.sleep(8)


def dump_tree():
    return ev("""(function(){
      const items = Array.from(document.querySelectorAll('.disk-tree-item'));
      return items.map(it => {
        const tw = it.querySelector('.tw');
        const name = it.querySelector('.tname');
        const chk = !!it.querySelector('input.d-chk');
        return (tw ? tw.textContent : '') + (chk ? '[chk]' : '') + (name ? name.textContent : '');
      });
    })()""")


print("== 初始树 ==")
for line in dump_tree() or []:
    print(" ", line)

# 点击「例子」目录行展开
print("\nclick 例子:", ev("""(function(){
  const row = Array.from(document.querySelectorAll('.disk-tree-item')).find(it => it.textContent.includes('例子'));
  if (row) { row.click(); return 'clicked'; } return 'no';
})()"""))
time.sleep(4)

print("== 展开后 ==")
for line in dump_tree() or []:
    print(" ", line)
