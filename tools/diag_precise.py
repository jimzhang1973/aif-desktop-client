# -*- coding: utf-8 -*-
from PIL import Image
full = Image.open("tools/_now_full.png").convert("RGB")
W, H = full.size

def white_frac_row(y, x0=0, x1=None):
    x1 = x1 or W
    n=0; hit=0
    for x in range(x0, x1, 3):
        r,g,b = full.getpixel((x,y)); n+=1
        if r>=249 and g>=249 and b>=249: hit+=1
    return hit/n

def white_frac_col(x, y0, y1):
    n=0; hit=0
    for y in range(y0, y1, 3):
        r,g,b = full.getpixel((x,y)); n+=1
        if r>=249 and g>=249 and b>=249: hit+=1
    return hit/n

# 1) 顶栏白带精确边界（step1，全宽白比例>0.85 的行）
rows = [y for y in range(0, 300) if white_frac_row(y) > 0.85]
print("topbar band rows:", f"{min(rows)}..{max(rows)}" if rows else "NONE", f"count={len(rows)}")

# 2) 侧栏白列精确边界（在白带下方 y=300..1200，白比例>0.85 的列）
cols = [x for x in range(0, 500) if white_frac_col(x, 300, 1200) > 0.85]
print("sidenav band cols:", f"{min(cols)}..{max(cols)}" if cols else "NONE", f"count={len(cols)}")

# 3) 白带右端：顶栏在哪些 x 之后不再是白（取白带中间行）
if rows:
    ym = (min(rows)+max(rows))//2
    xs = [x for x in range(0, W, 2) if all(v>=249 for v in full.getpixel((x,ym)))]
    print(f"white row y={ym}: x from {min(xs)} to {max(xs)}, count={len(xs)}")

# 4) 侧栏右边界线 (#e5e7eb 宽容差)：在 y=300..1200 找 x 使该列大部分像素在 225-242 且 R<G<B
print("\n--- vertical line candidates x=150..350 (col mean, frac in [225..243]) ---")
for x in range(150, 351, 2):
    n=0; s=[0,0,0]; inr=0
    for y in range(300, 1200, 4):
        r,g,b = full.getpixel((x,y)); s[0]+=r; s[1]+=g; s[2]+=b; n+=1
        if 225<=r<=243 and 225<=g<=243 and 228<=b<=246: inr+=1
    m = (s[0]//n, s[1]//n, s[2]//n)
    if inr/n > 0.5:
        print(f"  x={x} mean={m} frac={inr/n:.2f}")

# 5) 白带下边界线：y=180..230 找行大部分像素在 [225..243]
print("--- horizontal line candidates y=170..260 ---")
for y in range(170, 261, 2):
    n=0; inr=0
    for x in range(400, 1800, 4):
        r,g,b = full.getpixel((x,y))
        n+=1
        if 225<=r<=243 and 225<=g<=243 and 228<=b<=246: inr+=1
    if inr/n > 0.5:
        print(f"  y={y} frac={inr/n:.2f}")

# 6) 顶部灰色区（0..白带顶）是什么：采样其颜色分布
from collections import Counter
cnt = Counter()
for y in range(0, 100, 4):
    for x in range(0, W, 8):
        cnt[full.getpixel((x,y))] += 1
print("\ntop strip (y<100) top colors:", cnt.most_common(6))
