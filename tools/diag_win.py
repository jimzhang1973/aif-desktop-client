from PIL import Image
p = "C:/Users/jim_j/.workbuddy/clipboard-images/clipboard-2026-10-12T06-45-43-788Z-827994f5.png"
im = Image.open(p).convert("RGB")
W, H = im.size
def lum(px):
    r,g,b = px
    return (r*299+g*587+b*114)/1000

# window left edge: scan a row in the middle of the white area
for y in (800, 1000, 1200):
    xs = [x for x in range(W) if lum(im.getpixel((x,y))) > 180]
    print(f"row y={y}: first_light={xs[0] if xs else None} last_light={xs[-1] if xs else None}")

# window top edge: scan a column well inside the white area
for x in (1600, 1900):
    ys = [y for y in range(H) if lum(im.getpixel((x,y))) > 180]
    print(f"col x={x}: first_light={ys[0] if ys else None} last_light={ys[-1] if ys else None}")

# horizontal luminance profile at several y (post-window-top), sampled every 20px
print("\n--- luminance profile (sampled x=240..900 step 10) ---")
for y in range(200, 300, 8):
    vals = []
    for x in range(240, 900, 10):
        vals.append(int(lum(im.getpixel((x,y)))/26))
    print(f"y={y:4d} " + "".join(" .:-=+*#%@"[min(9,v)] for v in vals))

print("\n--- luminance profile (sampled y=200..420 step 6) at x=300/500/800/1500 ---")
for x in (300, 500, 800, 1500):
    vals = []
    for y in range(190, 430, 6):
        vals.append(int(lum(im.getpixel((x,y)))/26))
    print(f"x={x:5d} " + "".join(" .:-=+*#%@"[min(9,v)] for v in vals))
