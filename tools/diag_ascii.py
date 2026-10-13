import sys
from PIL import Image

path = sys.argv[1]
im = Image.open(path).convert("RGB")
W, H = im.size
print(f"FILE {path}\nSIZE {W}x{H}")

small = im.resize((100, 40))
chars = " .:-=+*#%@"
print("\n--- ASCII 100x40 (dark->bright) ---")
for y in range(40):
    row = ""
    for x in range(100):
        r, g, b = small.getpixel((x, y))
        lum = (r * 299 + g * 587 + b * 114) / 1000
        row += chars[min(9, int((255 - lum) / 25.6))]
    print(f"{int(y*H/40):5d}|{row}")

# column profile of the top strip: where does white start?
def lum(px):
    r, g, b = px
    return (r*299+g*587+b*114)/1000

print("\n--- per-row: leftmost light pixel & light fraction (every H/60) ---")
for y in range(0, H, max(1, H//60)):
    lf = 0
    leftmost = -1
    for x in range(0, W, 2):
        if lum(im.getpixel((x, y))) > 200:
            lf += 1
            if leftmost < 0:
                leftmost = x
    if leftmost >= 0:
        print(f"y={y:5d} leftmost_light={leftmost:5d} light_frac={lf/(W/2):.3f}")
