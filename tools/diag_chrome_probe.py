# 诊断：全屏模式下顶栏/侧栏缺失
# 核心手段：CDP 直接截「主 webview 自绘内容」（不含原生子 webview），
# 以区分「主 webview 没绘制顶栏/侧栏」 vs 「被原生面板 webview 覆盖」
import base64
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import time
import urllib.request

import websocket
from PIL import ImageGrab

EXE = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\src-tauri\target\x86_64-pc-windows-msvc\release\aif-desktop-client.exe"
OUT = r"C:\Users\jim_j\WorkBuddy\2026-10-11-09-08-27\aif-desktop-client\tools"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 1) 关闭已有实例（单实例锁会挡住第二个进程）
subprocess.run(["taskkill", "/F", "/IM", "aif-desktop-client.exe"], capture_output=True)
time.sleep(2)

env = dict(os.environ)
env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=9223"
proc = subprocess.Popen([EXE], env=env)
print("launched:", proc.pid)


def list_targets():
    try:
        return json.load(opener.open("http://127.0.0.1:9223/json", timeout=2))
    except Exception:
        return []


main_t = None
pages = []
for i in range(45):
    time.sleep(1)
    if proc.poll() is not None:
        print("进程退出 code=", proc.returncode)
        break
    pages = [t for t in list_targets() if t.get("type") == "page"]
    if pages:
        for t in pages:
            u = t.get("url", "")
            if "tauri.localhost" in u:
                main_t = t
                break
        if not main_t:
            main_t = pages[0]
        break
    if i % 5 == 0:
        print(f"  ...等待 target {i}s, 当前 targets={len(list_targets())}")
if not main_t:
    print("未获得 target；最后一次列举=")
    for t in list_targets():
        print("   ", t.get("type"), "|", t.get("url", "")[:100])
    raise SystemExit("CDP 主 target 未就绪")
print("main target url:", main_t.get("url"))
print("all page targets:", [t.get("url", "")[:60] for t in pages])
time.sleep(3)

ws = websocket.create_connection(main_t["webSocketDebuggerUrl"], timeout=20, suppress_origin=True)
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
        return "EXC: " + json.dumps(r["exceptionDetails"], ensure_ascii=False)[:300]
    return r.get("result", {}).get("value")


def snap(tag):
    """快照：关键元素是否存在 + 计算样式 + 物理 rect"""
    js = r"""JSON.stringify((function(){
  function info(sel){
    var e=document.querySelector(sel);
    if(!e) return 'MISSING';
    var b=e.getBoundingClientRect(); var s=getComputedStyle(e); var d=window.devicePixelRatio;
    return {rect:[Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)],
            phys:[Math.round(b.left*d),Math.round(b.top*d),Math.round(b.width*d),Math.round(b.height*d)],
            display:s.display, vis:s.visibility, opacity:s.opacity, z:s.zIndex, pos:s.position,
            bg:s.backgroundColor};
  }
  return {
    dpr: window.devicePixelRatio, inner:[window.innerWidth,window.innerHeight],
    layout: localStorage.getItem('aif_layout'),
    panel: (document.querySelector('.panel')||{}).className||'NO-PANEL',
    panelRect: info('.panel'), topbar: info('.topbar'), sidenav: info('.sidenav'),
    mainRow: info('.main-row'), content: info('.content'), webpane: info('.web-pane'),
    navBtns: document.querySelectorAll('.nav-btn').length,
    tblLogo: !!document.querySelector('.topbar .logo-badge'),
    tblTitle: (document.querySelector('.topbar .title')||{}).textContent||'',
    bodyLen: document.body.innerHTML.length
  };
})())"""
    print(f"--- SNAPSHOT [{tag}] ---")
    print(ev(js))
    return


def shot(name):
    r = call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
    data = r.get("data")
    if not data:
        print("screenshot FAIL", name, r)
        return
    with open(os.path.join(OUT, name), "wb") as f:
        f.write(base64.b64decode(data))
    print("main-webview shot saved:", name)


# 唤起窗口
ev("(async function(){ try { await window.__TAURI_INTERNALS__.invoke('plugin:window|show'); } catch(e){} return 'ok'; })()")
time.sleep(1.5)

# 2) 确保全屏模式
print("layout(localStorage):", ev("localStorage.getItem('aif_layout')"))
print("panel class:", ev("(document.querySelector('.panel')||{}).className"))
if "mode-full" not in (ev("(document.querySelector('.panel')||{}).className") or ""):
    print("切到全屏:", ev("(function(){var b=document.getElementById('btn-mode'); if(b){b.click(); return 'clicked';} return 'no-btn(未登录?)';})()"))
time.sleep(4)

snap("full-before-pane")
shot("diag_A_full_before_pane.png")

# 3) 点一条消息 → 打开内嵌面板
print("click msg:", ev(r"""(function(){
  var item=document.querySelector('#content .msg-row, #content .li, #content .list-item');
  if(!item) return 'no item';
  item.click(); return 'clicked:'+(item.getAttribute('data-url')||'');
})()"""))
time.sleep(7)

snap("full-after-pane")
shot("diag_B_full_after_pane.png")

# 4) 列出 targets，确认 pane 是否创建
print("--- TARGETS ---")
for t in list_targets():
    print(" ", t.get("type"), "|", t.get("url", "")[:90])

# 5) 整窗合成截图（含原生子 webview）
u32 = ctypes.windll.user32
target = []


@ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
def cb(h, l):
    cls = ctypes.create_unicode_buffer(64)
    u32.GetClassNameW(h, cls, 64)
    if cls.value == "Tauri Window" and u32.IsWindowVisible(h):
        target.append(h)
    return True


u32.EnumWindows(cb, 0)
if target:
    r = wt.RECT()
    u32.GetWindowRect(target[0], ctypes.byref(r))
    img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
    img.save(os.path.join(OUT, "diag_C_window.png"))
    print("window shot saved", img.size, "rect", r.left, r.top, r.right, r.bottom)
else:
    print("no Tauri Window found")

ws.close()

# 6) 收尾：关闭调试实例，按正常方式（无 CDP）重启，恢复用户现场
subprocess.run(["taskkill", "/F", "/IM", "aif-desktop-client.exe"], capture_output=True)
time.sleep(1.5)
subprocess.Popen([EXE], env=dict(os.environ))
print("restarted normally")
print("DONE")
