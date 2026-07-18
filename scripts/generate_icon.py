from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build"
OUT.mkdir(parents=True, exist_ok=True)

size = 512
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((18, 18, 494, 494), radius=112, fill=(245, 241, 234, 255))
draw.ellipse((70, 70, 442, 442), fill=(24, 22, 19, 255), outline=(49, 45, 40, 255), width=8)
for inset in range(92, 204, 15):
    shade = 44 if inset % 30 else 54
    draw.ellipse((inset, inset, size - inset, size - inset), outline=(shade, shade, shade, 255), width=3)
draw.ellipse((174, 174, 338, 338), fill=(177, 145, 101, 255), outline=(224, 207, 179, 255), width=5)
draw.ellipse((239, 239, 273, 273), fill=(27, 24, 20, 255))
bars = [30, 56, 88, 50, 112, 72, 42]
for index, height in enumerate(bars):
    x = 201 + index * 18
    draw.rounded_rectangle((x, 256 - height // 2, x + 8, 256 + height // 2), radius=4, fill=(249, 243, 232, 245))

image.save(OUT / "icon.png", optimize=True)
image.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
