# -*- coding: utf-8 -*-
"""手动 invoke diskTree/diskNodes，验证 Rust → 前端返回内容。"""
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


print("hooked?", ev("String(window.__hooked)"))
print("calls len:", ev("window.__calls ? window.__calls.length : -1"))

SID = "PERSONAL_SPACE_c5deef62fa6e488fa54f69f49381d5db"
EXPR_TREE = ('window.__TAURI_INTERNALS__.invoke("disk_tree", {spaceId: "' + SID + '"})'
             '.then(v => JSON.stringify(v).slice(0,400)).catch(e => "ERR:" + e)')
print("disk_tree manual:", ev(EXPR_TREE, await_promise=True))

EX = "2c9480918bec2e01018bef9b28db00f9"
EXPR_NODES = ('window.__TAURI_INTERNALS__.invoke("disk_nodes", {spaceId: "' + SID
              + '", nodeId: "' + EX + '", nodeType: "subject"})'
              '.then(v => JSON.stringify(v).slice(0,600)).catch(e => "ERR:" + e)')
print("disk_nodes manual (例子):", ev(EXPR_NODES, await_promise=True))
