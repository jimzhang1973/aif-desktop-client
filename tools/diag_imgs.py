# -*- coding: utf-8 -*-
from PIL import Image

def white_frac_row(im, y, x0, x1):
    n=0;h=0
    for x in range(x0, x1, 2):
        r,g,b = im.getpixel((x,y)); n+=1
        if r>=249 and g>=249 and b>=249: h+=1
    return h/n

def analyze(path, label):
    im = Image.open(path).convert("RGB")
    W,H = im.size
    print(f"\n===== {label} {W}x{H} =====")
    # 找顶栏白色带（跳过最顶可能含系统边框的几行）：全宽白比例>0.8 的连续行
    rows = [y for y in range(0, min(200,H)) if white_frac_row(im, y, 0, W) > 0.8]
    if rows:
        top, bot = min(rows), max(rows)
        hgt = bot - top
        scale = hgt / 48.0
        print(f"topbar band rows {top}..{bot} height={hgt}px -> scale={scale:.3f} -> 窗口宽 {W/scale:.0f} CSS x 高 {H/scale:.0f} CSS")
    else:
        print("no white band found in top 200 rows")
    # sidenav 白列（y 取顶栏下方到 80% 高）
    y0 = int(H*0.3); y1 = int(H*0.8)
    def wfrac_col(x):
        n=0;h=0
        for y in range(y0,y1,2):
            r,g,b = im.getpixel((x,y)); n+=1
            if r>=249 and g>=249 and b>=249: h+=1
        return h/n
    cols = [x for x in range(0, min(300,W)) if wfrac_col(x) > 0.8]
    if cols:
        print(f"sidenav white cols {min(cols)}..{max(cols)} -> {(max(cols)-min(cols))/1.0:.0f}px")
    # 右侧大空白区（web-pane 占位）检测：x>60% 区域是否大面积 #f4f6fb
    n=0;h=0
    for y in range(int(H*0.3), int(H*0.8), 4):
        for x in range(int(W*0.6), W-4, 4):
            r,g,b = im.getpixel((x,y)); n+=1
            if abs(r-244)<=6 and abs(g-246)<=6 and abs(b-251)<=6: h+=1
    print(f"right-area #f4f6fb frac = {h/n:.2f} (高→web-pane占位可见=full模式CSS)")

analyze("C:/Users/jim_j/.workbuddy/clipboard-images/clipboard-2026-10-12T08-15-15-045Z-7fe91ae6.png", "图1")
analyze("C:/Users/jim_j/.workbuddy/clipboard-images/clipboard-2026-10-12T08-15-15-049Z-d93e67db.png", "图2")
