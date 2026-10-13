# -*- coding: utf-8 -*-
"""临时诊断：带 CDP 启动客户端，直接读取 DOM 几何数值。用完即删。"""
import json, os, subprocess, sys, time, urllib.request

EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\x86_64-pc-windows-msvc\release\aif-desktop-client.exe"
PORT = 9224

# 直连 localhost，绕开系统代理（否则 CDP 会返回 502）
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

env = dict(os.environ)
env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={PORT}"

proc = subprocess.Popen([EXE], env=env)
print("pid", proc.pid, flush=True)


def targets():
    try:
        with opener.open(f"http://127.0.0.1:{PORT}/json", timeout=2) as r:
            return json.load(r)
    except Exception:
        return []


JS = r"""
(() => {
  const box = (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect();
    return {x:+r.x.toFixed(1), y:+r.y.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1)}; };
  const cs = (s, props) => { const e = document.querySelector(s); if (!e) return null;
    const c = getComputedStyle(e); const o = {}; props.forEach(p => o[p] = c[p]); return o; };
  return JSON.stringify({
    viewport: {innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio,
               outerW: window.outerWidth, outerH: window.outerHeight,
               screenW: screen.width, screenH: screen.height,
               availW: screen.availWidth, availH: screen.availHeight},
    scroll: {docTop: document.documentElement.scrollTop, docLeft: document.documentElement.scrollLeft,
             bodyTop: document.body.scrollTop, bodyLeft: document.body.scrollLeft},
    visualViewport: window.visualViewport ? {w: visualViewport.width, h: visualViewport.height,
             ox: visualViewport.offsetLeft, oy: visualViewport.offsetTop, scale: visualViewport.scale} : null,
    layout: localStorage.getItem('aif_layout'),
    panelClass: document.querySelector('.panel') ? document.querySelector('.panel').className : '(no .panel)',
    boxes: {app: box('#app'), panel: box('.panel'), topbar: box('.topbar'), mainRow: box('.main-row'),
            sidenav: box('.sidenav'), content: box('.content'), webPane: box('.web-pane'), hint: box('.pane-hint')},
    styles: {
      app: cs('#app', ['display','height','position','margin','transform']),
      panel: cs('.panel', ['display','flexDirection','height','width','position','margin','transform','overflow','background']),
      topbar: cs('.topbar', ['display','height','flex','position','visibility','opacity','margin']),
      mainRow: cs('.main-row', ['display','flexDirection','flex','height','margin','position']),
      sidenav: cs('.sidenav', ['display','width','flex','position','margin','background','visibility']),
      content: cs('.content', ['display','width','flex','overflowY','background','margin','position'])
    },
    panelChildren: document.querySelector('.panel') ? [...document.querySelector('.panel').children].map(e => e.className || e.tagName) : null,
    panelHtmlHead: document.querySelector('.panel') ? document.querySelector('.panel').outerHTML.slice(0, 420) : null
  }, null, 1);
})()
"""

ws = None
try:
    tgt = None
    for i in range(25):
        time.sleep(1)
        if proc.poll() is not None:
            print("进程退出 code=", proc.returncode, flush=True); sys.exit(1)
        ts = targets()
        for t in ts:
            if t.get("type") == "page":
                tgt = t; break
        if tgt:
            print("target:", tgt.get("url"), flush=True); break
    if not tgt:
        print("未找到 CDP target", flush=True); sys.exit(2)

    import websocket
    ws = websocket.create_connection(tgt["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                        "params": {"expression": JS, "returnByValue": True, "awaitPromise": True}}))
    while True:
        msg = json.loads(ws.recv())
        if msg.get("id") == 1:
            res = msg.get("result", {}).get("result", {})
            print(res.get("value") or json.dumps(msg, ensure_ascii=False, indent=1), flush=True)
            break
finally:
    try:
        if ws: ws.close()
    except Exception: pass
    try:
        proc.terminate(); time.sleep(1); proc.kill()
    except Exception: pass
print("DONE", flush=True)
