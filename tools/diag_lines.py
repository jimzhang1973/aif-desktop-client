# -*- coding: utf-8 -*-
"""在全屏截图里找应用布局的特征线，反推应用内容在屏幕上的真实原点"""
from PIL import Image

full = Image.open("tools/_now_full.png").convert("RGB")
W, H = full.size
print(f"full shot {W}x{H}")

def is_line_c(px):  # #e5e7eb 边框线
    r,g,b = px
    return abs(r-229)<=6 and abs(g-231)<=6 and abs(b-235)<=6

# 1) 找竖直边框线：对每个 x，统计 y=300..1200 中连续满足 is_line 的比例
print("\n--- candidate vertical border lines (x, frac) frac>0.5 ---")
cands = []
for x in range(0, W):
    n=0; hit=0
    for y in range(300, 1200, 5):
        n+=1
        if is_line_c(full.getpixel((x,y))): hit+=1
    if hit/n > 0.5:
        cands.append((x, hit/n))
# 合并相邻
merged = []
for x, f in cands:
    if merged and x - merged[-1][1] <= 2:
        merged[-1][1] = x; merged[-1][2] = max(merged[-1][2], f)
    else:
        merged.append([x, x, f])
for x0, x1, f in merged:
    print(f"  x={x0}..{x1} frac={f:.2f}")

# 2) 找水平边框线：对每个 y，统计 x=400..1800 中满足 is_line 的比例
print("\n--- candidate horizontal border lines (y, frac) frac>0.5 ---")
cands = []
for y in range(0, min(400, H)):
    n=0; hit=0
    for x in range(400, 1800, 5):
        n+=1
        if is_line_c(full.getpixel((x,y))): hit+=1
    if hit/n > 0.5:
        cands.append((y, hit/n))
merged = []
for y, f in cands:
    if merged and y - merged[-1][1] <= 2:
        merged[-1][1] = y; merged[-1][2] = max(merged[-1][2], f)
    else:
        merged.append([y, y, f])
for y0, y1, f in merged:
    print(f"  y={y0}..{y1} frac={f:.2f}")

# 3) 顶栏白色带检测：每行纯白(>=250)占比（全宽）
print("\n--- rows with >70% near-white pixels (topbar 特征, 前 400 行) ---")
for y in range(0, 400, 4):
    n=0; hit=0
    for x in range(0, W, 6):
        r,g,b = full.getpixel((x,y))
        n+=1
        if r>=250 and g>=250 and b>=250: hit+=1
    if hit/n > 0.7:
        print(f"  y={y} whiteFrac={hit/n:.2f}")

# 4) 蓝色元素分布（粗图 24x16）
def bluish(px):
    r,g,b = px
    return b > 110 and (b-r) > 45 and (b-g) > 35
print("\n--- blue map 48x16 (top half) ---")
for gy in range(16):
    line=""
    for gx in range(48):
        c=0
        for y in range(gy*H//32, (gy+1)*H//32, 6):
            for x in range(gx*W//48, (gx+1)*W//48, 6):
                if bluish(full.getpixel((x,y))): c+=1
        line += "#" if c>5 else ("+" if c>0 else ".")
    print(f"  {line}")

# 5) 精确网格采样左上 360x360，每 30px
print("\n--- grid samples 0..360 step 30 (R,G,B) ---")
for y in range(0, 361, 30):
    row=[]
    for x in range(0, 361, 30):
        row.append(full.getpixel((x,y)))
    print(f"  y={y:3d} " + " ".join(f"{r:3d},{g:3d},{b:3d}" for r,g,b in row))
