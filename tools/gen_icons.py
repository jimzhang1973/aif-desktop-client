# -*- coding: utf-8 -*-
"""生成 AIF 桌面客户端图标：蓝底圆角方块 + 白色对话气泡 + 信封 + 橙色提醒圆点。
输出覆盖 src-tauri/icons/ 下全套尺寸（png / ico / icns 不在范围内则跳过）。"""
import os
from PIL import Image, ImageDraw

ICON_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")

# 配色
BG_TOP = (47, 108, 255)      # 顶部蓝
BG_BOT = (24, 78, 214)       # 底部深蓝
WHITE = (255, 255, 255)
ENVELOPE_BODY = (93, 168, 255)   # 信封浅蓝
ENVELOPE_LINE = (36, 96, 210)    # 信封描边
BADGE = (255, 122, 40)           # 提醒橙
BADGE_RING = (255, 255, 255)


def rounded_gradient(size: int) -> Image.Image:
    """蓝底垂直渐变圆角方块（圆角半径约 22%）"""
    s4 = size * 4  # 4x 超采样抗锯齿
    img = Image.new("RGBA", (s4, s4), (0, 0, 0, 0))
    grad = Image.new("RGBA", (s4, s4))
    gd = ImageDraw.Draw(grad)
    for y in range(s4):
        t = y / (s4 - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3)) + (255,)
        gd.line([(0, y), (s4, y)], fill=c)
    mask = Image.new("L", (s4, s4), 0)
    md = ImageDraw.Draw(mask)
    r = int(s4 * 0.22)
    md.rounded_rectangle([0, 0, s4 - 1, s4 - 1], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)
    return img


def draw_glyph(size: int, alert: bool = False) -> Image.Image:
    """在 size×size 画布上画白色对话气泡 + 蓝色信封 + 橙色提醒点。
    alert=True：闪烁帧——橙色提醒点放大为「感叹号」徽标，视觉上明显区别于常态。"""
    s = size * 4
    img = rounded_gradient(size)
    d = ImageDraw.Draw(img)

    # ---- 对话气泡（白色圆角矩形 + 左下小尾巴）----
    bx0, by0 = int(s * 0.16), int(s * 0.22)
    bx1, by1 = int(s * 0.84), int(s * 0.70)
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=int(s * 0.10), fill=WHITE)
    # 尾巴：左下角小三角（圆角处理用椭圆近似）
    tail = [(int(s * 0.26), by1 - 2), (int(s * 0.38), by1 - 2), (int(s * 0.24), int(s * 0.84))]
    d.polygon(tail, fill=WHITE)

    # ---- 信封（浅蓝矩形 + 白色 V 形折线）----
    ex0, ey0 = int(s * 0.27), int(s * 0.32)
    ex1, ey1 = int(s * 0.73), int(s * 0.60)
    d.rounded_rectangle([ex0, ey0, ex1, ey1], radius=int(s * 0.035), fill=ENVELOPE_BODY,
                        outline=ENVELOPE_LINE, width=max(2, s // 100))
    # V 形：从左上角到中点，再到右上角
    mid_y = (ey0 + ey1) // 2 + int(s * 0.02)
    d.line([(ex0 + s // 120, ey0 + s // 120), ((ex0 + ex1) // 2, mid_y),
            (ex1 - s // 120, ey0 + s // 120)], fill=WHITE, width=max(3, s // 70), joint="curve")

    # ---- 右上角提醒圆点（橙，白描边）----
    cx, cy = int(s * 0.78), int(s * 0.24)
    r = int(s * 0.09)
    if alert:
        # 闪烁帧：徽标放大并绘制白色感叹号
        r = int(s * 0.145)
        d.ellipse([cx - r - s // 55, cy - r - s // 55, cx + r + s // 55, cy + r + s // 55], fill=BADGE_RING)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BADGE)
        lw = max(3, s // 55)
        d.line([(cx, cy - int(r * 0.55)), (cx, cy + int(r * 0.18))], fill=WHITE, width=lw)
        d.ellipse([cx - lw // 2, cy + int(r * 0.4), cx + lw // 2, cy + int(r * 0.4) + lw], fill=WHITE)
    else:
        d.ellipse([cx - r - s // 60, cy - r - s // 60, cx + r + s // 60, cy + r + s // 60], fill=BADGE_RING)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=BADGE)

    return img.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, name: str, size: int):
    img.save(os.path.join(ICON_DIR, name))


def main():
    master = draw_glyph(1024)
    # Tauri/打包常用尺寸
    for name, size in [
        ("icon.png", 512),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("Square30x30Logo.png", 30),
        ("Square44x44Logo.png", 44),
        ("Square71x71Logo.png", 71),
        ("Square89x89Logo.png", 89),
        ("Square107x107Logo.png", 107),
        ("Square142x142Logo.png", 142),
        ("Square150x150Logo.png", 150),
        ("Square284x284Logo.png", 284),
        ("Square310x310Logo.png", 310),
        ("StoreLogo.png", 50),
    ]:
        master.resize((size, size), Image.LANCZOS).save(os.path.join(ICON_DIR, name))
    # Windows exe 图标（多尺寸 ico）
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw_glyph(sz) for sz in ico_sizes]
    frames[-1].save(os.path.join(ICON_DIR, "icon.ico"),
                    sizes=[(sz, sz) for sz in ico_sizes])
    # 托盘闪烁帧（新消息提醒徽标放大 + 感叹号）
    draw_glyph(512, alert=True).save(os.path.join(ICON_DIR, "icon_alert.png"))
    print("icons generated ->", os.path.abspath(ICON_DIR))


if __name__ == "__main__":
    main()
