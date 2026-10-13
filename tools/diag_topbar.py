# -*- coding: utf-8 -*-
from PIL import Image
full = Image.open("tools/_now_full.png").convert("RGB")
W, H = full.size

# 1) 白带内(y=115..180)找深色文字像素的 x 分布
print("--- dark text pixels in band y=115..185 (x clusters) ---")
cols = []
for x in range(0, W, 2):
    c = 0
    for y in range(115, 186, 2):
        r,g,b = full.getpixel((x,y))
        if r<120 and g<120 and b<130: c += 1
    if c >= 2: cols.append(x)
# 聚类
runs = []
for x in cols:
    if runs and x - runs[-1][1] <= 8: runs[-1][1] = x
    else: runs.append([x, x])
print("text x-runs:", runs[:30])

# 2) 白带内蓝色像素（logo badge）
print("--- blue pixels in band y=115..185 ---")
bl = []
for y in range(115, 186, 2):
    for x in range(0, 600, 2):
        r,g,b = full.getpixel((x,y))
        if b>200 and 30<=r<=110 and 90<=g<=170: bl.append((x,y))
print("count:", len(bl), "bbox:", (min(p[0] for p in bl), min(p[1] for p in bl), max(p[0] for p in bl), max(p[1] for p in bl)) if bl else None)

# 3) sidenav 区域(x=52..130)的蓝色 active pill（y=190..400）
print("--- blue pixels in sidenav x=52..130, y=190..450 ---")
bl2 = [(x,y) for y in range(190,451,2) for x in range(40,140,2)
       if (lambda p: p[2]>200 and 30<=p[0]<=110 and 90<=p[1]<=170)(full.getpixel((x,y)))]
print("count:", len(bl2), "bbox:", (min(p[0] for p in bl2), min(p[1] for p in bl2), max(p[0] for p in bl2), max(p[1] for p in bl2)) if bl2 else None)

# 4) 白带精确上下界（step1, x=600..1600 全白比例）
def wfrac(y):
    n=0;h=0
    for x in range(600,1600,3):
        r,g,b=full.getpixel((x,y)); n+=1
        if r>=249 and g>=249 and b>=249: h+=1
    return h/n
top = next(y for y in range(60,200) if wfrac(y)>0.8)
bot = next(y for y in range(top+20,300) if wfrac(y)<0.5)
print(f"\ntopbar band precise: y={top}..{bot}  height={bot-top} (expect 72 if topbar)")

# 5) sidenav 白列精确左右界（y=300..1200, step1）
def wfracx(x):
    n=0;h=0
    for y in range(300,1200,3):
        r,g,b=full.getpixel((x,y)); n+=1
        if r>=249 and g>=249 and b>=249: h+=1
    return h/n
left = next(x for x in range(0,200) if wfracx(x)>0.8)
right = next(x for x in range(left+20,400) if wfracx(x)<0.5)
print(f"sidenav white col precise: x={left}..{right}  width={right-left} (expect 78 if sidenav)")
