from PIL import Image
import sys
def lum(px):
    r,g,b = px; return (r*299+g*587+b*114)/1000
def analyze(p, label):
    im = Image.open(p).convert("RGB"); W,H = im.size
    print(f"\n===== {label}  ({p.split('/')[-1]})  {W}x{H} =====")
    # top-left 60x60 avg color
    def avg(x0,y0,x1,y1):
        t=[0,0,0]; n=0
        for y in range(y0,y1,3):
            for x in range(x0,x1,3):
                r,g,b=im.getpixel((x,y)); t[0]+=r;t[1]+=g;t[2]+=b;n+=1
        return [v//n for v in t]
    print(f" top-left(0,0,60,60) avg = {avg(0,0,60,60)}")
    # per-row avg for first 200 rows across full width
    print(" rows 0..200: avg luminance (step 6)")
    for y in range(0, min(200,H), 6):
        a = avg(0,y,W,y+6)
        print(f"   y={y:4d} avg={a} lum={int(lum(a))}  topleft(0..120)={avg(0,y,120,y+6)}")
analyze("tools/_shot_client.png", "MY client-area shot")
analyze("tools/_state_maximized.png", "MY maximized full-screen shot")
