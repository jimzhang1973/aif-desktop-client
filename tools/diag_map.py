# -*- coding: utf-8 -*-
from PIL import Image
full = Image.open("tools/_now_full.png").convert("RGB")
W, H = full.size

def cls(px):
    r,g,b = px
    if r>=249 and g>=249 and b>=249: return "W"                      # 白
    if abs(r-244)<=5 and abs(g-246)<=5 and abs(b-251)<=5: return "B" # 应用bg #f4f6fb
    if abs(r-227)<=6 and abs(g-227)<=6 and abs(b-227)<=6: return "G" # 桌面灰
    if b>200 and 30<=r<=110 and 90<=g<=170: return "b"               # 品牌蓝#3B82F6
    if r<100 and g<100 and b<100: return "K"                          # 深色
    if 225<=r<=243 and 225<=g<=243 and 228<=b<=247 and b>=r: return "-" # 边框灰#e5e7eb
    return "."

# 110 x 73 网格
gx, gy = 110, 73
print(f"map {gx}x{gy} (each cell {W//gx}x{H//gy} phys = {(W//gx)/1.5:.0f}x{(H//gy)/1.5:.0f} css)")
for cy in range(gy):
    line = ""
    for cx in range(gx):
        cnt = {}
        for y in range(cy*H//gy, (cy+1)*H//gy, max(1,H//gy//6)):
            for x in range(cx*W//gx, (cx+1)*W//gx, max(1,W//gx//6)):
                c = cls(full.getpixel((x,y)))
                cnt[c] = cnt.get(c,0)+1
        # 取占比最高的类
        best = max(cnt.items(), key=lambda kv: kv[1])
        line += best[0] if best[1] >= 3 else "."
    print(line)
