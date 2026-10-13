from PIL import Image
p = "C:/Users/jim_j/.workbuddy/clipboard-images/clipboard-2026-10-12T06-45-43-788Z-827994f5.png"
im = Image.open(p).convert("RGB")
WX, WY = 266, 266   # window client top-left on screen (physical)
def lum(px):
    r,g,b = px
    return (r*299+g*587+b*114)/1000
print(f"window origin on screen = ({WX},{WY}); size = {2196-WX}x{1416-WY} phys = {(2196-WX)/1.5:.0f}x{(1416-WY)/1.5:.0f} CSS")

# 1) horizontal scan for a vertical border line (sidenav right edge ~ DOM x=53 -> phys +79)
print("\n--- avg RGB per column, x=266..420 (phys), y=360..900 ---")
for x in range(266, 421, 2):
    tot = [0,0,0]; n=0
    for y in range(360, 900, 7):
        r,g,b = im.getpixel((x,y)); tot[0]+=r; tot[1]+=g; tot[2]+=b; n+=1
    avg = [t//n for t in tot]
    print(f" x={x:4d} rel={(x-WX)/1.5:6.1f}css avg={avg} lum={int(lum(avg))}")

# 2) vertical scan for a horizontal border line (topbar bottom ~ DOM y=49 -> phys +73)
print("\n--- avg RGB per row, y=266..360 (phys), x=900..1900 ---")
for y in range(266, 361, 2):
    tot=[0,0,0]; n=0
    for x in range(900, 1900, 11):
        r,g,b = im.getpixel((x,y)); tot[0]+=r; tot[1]+=g; tot[2]+=b; n+=1
    avg=[t//n for t in tot]
    print(f" y={y:4d} rel={(y-WY)/1.5:6.1f}css avg={avg} lum={int(lum(avg))}")
