# -*- coding: utf-8 -*-
"""网盘目录树真机探测：复现 main.ts diskIndexAll/diskParentId 管道，定位文件不显示根因。
用法：python tools/disk_probe.py
只读探测，不写任何数据。"""
import ctypes
import ctypes.wintypes as wt
import json
import re
import ssl
import sys
import urllib.parse
import urllib.request

BASE = "https://51yunwei.com.cn"
ROOT = "AIF"
CRED_TARGET = "bs_session_cookie.aif-desktop-client"


def read_cookie():
    """凭据管理器 CredReadW 读 blob（UTF-16LE）"""
    advapi = ctypes.WinDLL("advapi32")
    cred = ctypes.c_void_p()
    if not advapi.CredReadW(CRED_TARGET, 1, 0, ctypes.byref(cred)):
        raise RuntimeError(f"CredReadW 失败 err={ctypes.GetLastError()}")
    blob = ctypes.cast(cred, ctypes.POINTER(ctypes.c_ubyte))
    # CREDENTIALW: Flags,Type,Persist(3*4+4 pad? 实际布局) — 用已知偏移不可靠，改为 CREDENTIALW 结构
    class CREDENTIALW(ctypes.Structure):
        _fields_ = [("Flags", wt.DWORD), ("Type", wt.DWORD), ("Persist", wt.DWORD),
                    ("dwDummy", wt.DWORD), ("Comment", ctypes.c_wchar_p),
                    ("LastWritten", wt.FILETIME), ("CredentialBlobSize", wt.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
                    ("AttrCount", wt.DWORD), ("Attrs", ctypes.c_void_p)]
        # LastWritten 是 FILETIME(8字节)，Comment 之前 4+4+4+4=16
    # 简化：直接按原 CREDENTIALW 定义
    class CRED(ctypes.Structure):
        _fields_ = [("Flags", wt.DWORD), ("Type", wt.DWORD), ("Persist", wt.DWORD),
                    ("Comment", ctypes.c_wchar_p), ("LastWritten", wt.FILETIME),
                    ("CredentialBlobSize", wt.DWORD),
                    ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
                    ("AttrCount", wt.DWORD), ("Attrs", ctypes.c_void_p)]
    ctypes.windll.advapi32.CredFree(cred)
    c = ctypes.cast(ctypes.c_void_p(), ctypes.POINTER(CRED))
    if not advapi.CredReadW(CRED_TARGET, 1, 0, ctypes.byref(c)):
        raise RuntimeError("CredReadW 重读失败")
    size = c.contents.CredentialBlobSize
    data = ctypes.string_at(c.contents.CredentialBlob, size)
    return data.decode("utf-16le").strip()


def post(url, cookie, data):
    ctx = ssl.create_default_context()
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Cookie", cookie)
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("User-Agent", "Mozilla/5.0 disk-probe")
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def get(url, cookie):
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url)
    req.add_header("Cookie", cookie)
    req.add_header("User-Agent", "Mozilla/5.0 disk-probe")
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def flex(text):
    """复现 disk.rs decode_flex"""
    t = text.strip()
    if t.startswith("%") or "%22" in t:
        t = urllib.parse.unquote(t)
    v = json.loads(t)
    if isinstance(v, str):
        v = json.loads(v)
    return v


def unwrap_data(val):
    """复现 disk.rs unwrap_data"""
    if isinstance(val, dict) and isinstance(val.get("data"), list):
        return val["data"]
    return val


def parse_nodes(val):
    """复现 disk.rs parse_nodes（取探测关心的字段）"""
    out = []
    for o in val:
        def gstr(*keys):
            for k in keys:
                s = o.get(k)
                if isinstance(s, str) and s.strip():
                    return s.strip()
            return ""
        out.append({
            "id": gstr("id"), "name": gstr("name", "menuName"),
            "pid": gstr("pid", "parentId"), "pids": gstr("pids"),
            "type": gstr("type"), "subtype": gstr("subtype", "type"),
            "subFileType": gstr("subFileType"), "isLeaf": o.get("isLeaf"),
        })
    return [n for n in out if n["id"]]


def disk_parent_id(n):
    """复现 main.ts diskParentId"""
    if n["pid"]:
        return n["pid"]
    chain = [s.strip() for s in (n["pids"] or "").split(",")
             if s.strip() and s.strip() != n["id"]]
    return chain[-1] if chain else ""


def main():
    cookie = read_cookie()
    print(f"[1] cookie 读到 {len(cookie)} 字符，前 24: {cookie[:24]}...")

    # 个人空间 spaceId
    html = get(f"{BASE}/{ROOT}/knowledge/personal/view.htm", cookie)
    m = re.search(r"var spaceId = '([^']+)'", html)
    if not m:
        print("!! 未找到 spaceId，页面片段：")
        for line in html.splitlines():
            if "spaceId" in line:
                print("   ", line[:160])
        sys.exit(1)
    space_id = m.group(1)
    print(f"[2] spaceId = {space_id}")

    # 目录树根
    val = flex(post(f"{BASE}/{ROOT}/nonlogin/knowledge/space/findTree.htm", cookie,
                    {"spaceId": space_id}))
    roots = parse_nodes(unwrap_data(val))
    print(f"[3] findTree 返回 {len(roots)} 个根: {[r['name'] for r in roots]}")

    # 逐根拉子树
    all_nodes = {}   # id -> node
    raw_by_root = {}
    for r in roots:
        val = flex(post(f"{BASE}/{ROOT}/nonlogin/knowledge/space/findTreeByNodeId.htm",
                        cookie, {"id": r["id"], "type": "subject", "spaceId": space_id}))
        nodes = parse_nodes(unwrap_data(val))
        raw_by_root[r["id"]] = nodes
        for n in nodes:
            all_nodes.setdefault(n["id"], n)
        print(f"[4] 根「{r['name']}」({r['id'][:12]}…): {len(nodes)} 节点, "
              f"subject {sum(1 for n in nodes if n['type']=='subject')}, "
              f"article {sum(1 for n in nodes if n['type']!='subject')}")

    # 复现 diskIndexAll：pid/pids 挂载
    children = {}
    root_ids = {r["id"] for r in roots}
    orphans = []
    for n in all_nodes.values():
        if n["id"] in root_ids:
            continue
        pid = disk_parent_id(n)
        if not pid:
            orphans.append((n, "无 pid/pids"))
            continue
        children.setdefault(pid, []).append(n)

    # 诊断输出
    print("\n===== 挂载结果 =====")
    for pid, kids in children.items():
        p = all_nodes.get(pid) or next((r for r in roots if r["id"] == pid), None)
        pname = p["name"] if p else "??"
        ptype = p["type"] if p else "??"
        print(f"  「{pname}」({ptype}) <- {len(kids)} 子: "
              + ", ".join(f"{k['name']}({k['type']}/{k['subtype']})" for k in kids[:8]))

    if orphans:
        print(f"\n!! {len(orphans)} 个孤儿节点（挂不上父目录）:")
        for n, why in orphans[:10]:
            print(f"  {n['name']} type={n['type']} pid={n['pid']!r} pids={n['pids']!r} ({why})")

    # 检查 article 节点 type 字段实际值
    types = {}
    for n in all_nodes.values():
        types[n["type"]] = types.get(n["type"], 0) + 1
    print(f"\n[type 分布] {types}")

    # 抽样原始 JSON（找一篇文章看全部字段）
    for r in roots:
        val = flex(post(f"{BASE}/{ROOT}/nonlogin/knowledge/space/findTreeByNodeId.htm",
                        cookie, {"id": r["id"], "type": "subject", "spaceId": space_id}))
        raw = unwrap_data(val)
        arts = [o for o in raw if isinstance(o, dict) and o.get("type") not in (None, "subject")]
        if arts:
            print(f"\n===== 原始 article JSON 样本（根「{r['name']}」）=====")
            print(json.dumps(arts[0], ensure_ascii=False, indent=1)[:1200])
            subj = [o for o in raw if isinstance(o, dict) and o.get("type") == "subject"]
            if subj:
                print("===== 原始 subject JSON 样本 =====")
                print(json.dumps(subj[0], ensure_ascii=False, indent=1)[:800])
            break


if __name__ == "__main__":
    main()
