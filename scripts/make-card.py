"""Compose the 1200x600 catalog card: generated art + typeset title.

Usage: python scripts/make-card.py assets/card-art.jpg <anton.ttf> <archivo.ttf> <out.jpg>
"""
import random
import sys

from PIL import Image, ImageDraw, ImageFont

art, anton, archivo, out = sys.argv[1:5]
W, H = 1200, 600
YELLOW = (245, 209, 10)
IVORY = (232, 227, 217)

im = Image.open(art).convert("RGB").resize((W, H), Image.Resampling.LANCZOS)

# The generated art has a pale full-width seam at y~440; patch it with ground texture from below.
patch = im.crop((0, 452, W, 462))
im.paste(patch, (0, 434))

# Darken the title band a touch so the type sits on clean ground.
band = Image.new("RGBA", (W, H), (0, 0, 0, 0))
bd = ImageDraw.Draw(band)
for y in range(380, H):
    a = int(min(1, (y - 380) / 50) * 150)
    bd.line([(0, y), (W, y)], fill=(6, 6, 8, a))
im = Image.alpha_composite(im.convert("RGBA"), band).convert("RGB")
d = ImageDraw.Draw(im)


def tracked(text, font, cx, y, fill, tracking):
    widths = [d.textlength(c, font=font) for c in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = cx - total / 2
    for c, w in zip(text, widths):
        d.text((x, y), c, font=font, fill=fill)
        x += w + tracking


title = "TILED SESSIONS"
size = 114  # cap height ~100px, the references' title band is 73-87% of the card
title_font = ImageFont.truetype(anton, size)
tw = d.textlength(title, font=title_font)
l, t, r_, b = d.textbbox((0, 0), title, font=title_font)
title_top, title_bottom = 448, 448 + (b - t)
tx = (W - tw) / 2
d.text((tx, title_top - t), title, font=title_font, fill=YELLOW)

kick = ImageFont.truetype(archivo, 15)
kick.set_variation_by_axes([100, 800])
tracked("COMMUNITY DESKTOP PLUGIN", kick, W / 2, title_top - 24, IVORY, 2.6)

small = ImageFont.truetype(archivo, 13)
small.set_variation_by_axes([100, 500])
credit = "strnadchristopher"
d.text((tx + tw - d.textlength(credit, font=small), title_bottom + 10), credit, font=small, fill=(214, 210, 202))
print("title", size, round(tw), title_top, title_bottom)

# Print wear over the type so it belongs to the same surface as the art.
random.seed(7)
px = im.load()
for _ in range(26000):
    x, y = random.randrange(W), random.randrange(420, H)
    r, g, b = px[x, y]
    k = random.choice((0.25, 0.55, 0.7, 0.85, 1.2))
    px[x, y] = tuple(max(0, min(255, int(v * k))) for v in (r, g, b))

im.save(out, "JPEG", quality=90, optimize=True, progressive=True)
print(out, im.size)
