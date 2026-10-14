# -*- coding: utf-8 -*-
"""对比实验：reqwest 同款特征（系统代理 + AIF UA）vs 直连，打 findTreeByNodeId。"""
import json
import ssl
import urllib.request

import disk_probe as dp  # noqa: F401  read_cookie 等

BASE = "https://51yunwei.com.cn"
SID = "PERSONAL_SPACE_c5deef62fa6e488fa54f69f49381d5db"
EX = "2c9480918bec2e01018bef9b28db00f9"
URL = f"{BASE}/DCP/nonlogin/knowledge/space/findTreeByNodeId.htm"
COOKIE = dp.read_cookie()
BODY = f"id={EX}&type=subject&spaceId={SID}".encode()


def go(label, use_proxy, ua):
    handlers = []
    if use_proxy:
        handlers.append(urllib.request.ProxyHandler({"http": "http://127.0.0.1:55063",
                                                     "https": "http://127.0.0.1:55063"}))
    else:
        handlers.append(urllib.request.ProxyHandler({}))
    handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(URL, data=BODY, method="POST")
    req.add_header("Cookie", COOKIE)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("User-Agent", ua)
    try:
        with opener.open(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace")
            print(f"[{label}] {r.status} len={len(body)} head={body[:180]!r}")
    except Exception as e:
        print(f"[{label}] EXC: {e}")


go("代理+应用UA", True, "AIF-Desktop-Client/0.1")
go("代理+浏览器UA", True, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
go("直连+应用UA", False, "AIF-Desktop-Client/0.1")
go("直连+浏览器UA", False, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
