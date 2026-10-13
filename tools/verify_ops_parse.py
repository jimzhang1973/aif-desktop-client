# 模拟 Rust extract_js_string + codeList 正则，验证 ops 数据解析
import re, json, io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

html = open("C:/Users/jim_j/WorkBuddy/2026-10-11-09-08-27/aif-desktop-client/tools/wb_sample.htm", encoding="utf-8").read()

def extract(marker):
    i = html.find(marker) + len(marker)
    out = []
    while i < len(html):
        c = html[i]
        if c == "\\":
            out.append(html[i + 1]); i += 2
        elif c == "'":
            break
        else:
            out.append(c); i += 1
    return "".join(out)

apps = json.loads(extract("var appList = mini.decode('"))
codes = json.loads(re.search(r"var\s+codeList\s*=\s*(\[.*?\]);", html, re.S).group(1))
for g in codes:
    sub = [a for a in apps if a.get("type") == g["id"]]
    print(g["name"], len(sub), [a["appsystemName"] for a in sub][:8])
print("总应用数:", len(apps))
