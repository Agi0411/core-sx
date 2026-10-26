#!/usr/bin/env python3
"""Generate every Core SX icon from one source logo (white mark on black).

    python3 scripts/make-icons.py [assets/logo-source.png]

Outputs
  build/icon.png                 1024×1024 macOS-style app icon (transparent margin + soft shadow)
  build/icon.icns                16 … 1024 px (+@2x) — what electron-builder packs into the .app
  build/icon.ico                 Windows icon (16 … 256 px)
  src/renderer/assets/logo-tile.png   128×128 full-bleed tile used in the app's title bar
  public/favicon.png             64×64

Needs: Pillow, numpy   (pip install pillow numpy)
"""
import io, struct, sys, pathlib
import numpy as np
from PIL import Image, ImageChops, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'assets' / 'logo-source.png'
CANVAS, BODY, SS = 1024, 824, 4            # Apple's macOS icon grid: 824 px body inside a 1024 px canvas

def squircle_mask(size: int, n: float = 5.0) -> Image.Image:
    """continuous-corner rounded square (superellipse), anti-aliased by 4× supersampling"""
    s = size * SS
    ax = (np.arange(s, dtype=np.float32) + 0.5) / s * 2 - 1
    x, y = np.meshgrid(ax, ax)
    m = (np.abs(x) ** n + np.abs(y) ** n <= 1.0).astype(np.uint8) * 255
    return Image.fromarray(m, 'L').resize((size, size), Image.LANCZOS)

def extract_mark(path: pathlib.Path) -> Image.Image:
    """white-on-black logo → 'L' alpha mask, cropped to its bounding box"""
    lum = np.asarray(Image.open(path).convert('L'), dtype=np.float32)
    a = np.clip((lum - 18) / (232 - 18), 0, 1)             # clean up edge noise
    mask = Image.fromarray((a * 255).astype(np.uint8), 'L')
    box = mask.point(lambda v: 255 if v > 40 else 0).getbbox()
    return mask.crop(box)

def vgrad(h: int, w: int, top, bottom) -> np.ndarray:
    t = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    return (np.array(top, np.float32) * (1 - t) + np.array(bottom, np.float32) * t) * np.ones((1, w, 1), np.float32)

def tile(size: int, mark: Image.Image, mark_frac: float) -> Image.Image:
    """full-bleed squircle tile with the mark in the middle (RGBA, `size` px)"""
    mask = squircle_mask(size)
    bg = vgrad(size, size, (44, 45, 52), (4, 4, 6))
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    glow = np.exp(-(((xx - size / 2) / (size * .55)) ** 2 + ((yy - size * .12) / (size * .5)) ** 2)) * 26   # soft top light
    bg = np.clip(bg + glow[..., None], 0, 255)
    img = Image.fromarray(bg.astype(np.uint8), 'RGB').convert('RGBA')
    # thin top-lit edge, like system icons
    ring = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(max(3, size // 330 * 2 + 1))))
    fade = Image.fromarray((vgrad(size, size, (255,), (0,))[:, :, 0] * .34).astype(np.uint8), 'L')
    img.alpha_composite(Image.merge('RGBA', (Image.new('L', (size, size), 255),) * 3 + (ImageChops.multiply(ring, fade),)))
    # the mark: white with a hint of vertical gradient, soft shadow underneath
    mw = int(size * mark_frac); mh = int(mw * mark.height / mark.width)
    m = mark.resize((mw, mh), Image.LANCZOS)
    pos = ((size - mw) // 2, int((size - mh) / 2 - size * 0.004))
    shadow = Image.new('L', (size, size), 0); shadow.paste(m, (pos[0], pos[1] + max(2, size // 90)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size / 70)).point(lambda v: int(v * .55))
    img.alpha_composite(Image.merge('RGBA', (Image.new('L', (size, size), 0),) * 3 + (shadow,)))
    col = vgrad(mh, mw, (255, 255, 255), (206, 209, 220)).astype(np.uint8)
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0)); layer.paste(Image.fromarray(col, 'RGB'), pos, m)
    img.alpha_composite(layer)
    img.putalpha(ImageChops.multiply(img.getchannel('A'), mask))
    return img

def write_icns(img: Image.Image, path: pathlib.Path):
    """standard .icns container (same entries `iconutil` writes): PNG payloads, 16 … 1024 px incl. @2x"""
    entries = [('icp4', 16), ('icp5', 32), ('ic11', 32), ('ic12', 64), ('ic07', 128), ('ic13', 256), ('ic08', 256), ('ic14', 512), ('ic09', 512), ('ic10', 1024)]
    body = b''
    for kind, px in entries:
        buf = io.BytesIO(); img.resize((px, px), Image.LANCZOS).save(buf, format='PNG', optimize=True); data = buf.getvalue()
        body += kind.encode() + struct.pack('>I', len(data) + 8) + data
    path.write_bytes(b'icns' + struct.pack('>I', len(body) + 8) + body)

def main():
    mark = extract_mark(SRC)
    # --- app icon (macOS grid) ---
    body = tile(BODY, mark, 0.64)
    canvas = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    off = (CANVAS - BODY) // 2
    sh = Image.new('L', (CANVAS, CANVAS), 0); sh.paste(squircle_mask(BODY), (off, off + 14))
    sh = sh.filter(ImageFilter.GaussianBlur(20)).point(lambda v: int(v * .5))
    canvas.alpha_composite(Image.merge('RGBA', (Image.new('L', (CANVAS, CANVAS), 0),) * 3 + (sh,)))
    canvas.alpha_composite(body, (off, off))
    (ROOT / 'build').mkdir(exist_ok=True)
    canvas.save(ROOT / 'build' / 'icon.png')
    write_icns(canvas, ROOT / 'build' / 'icon.icns')
    canvas.save(ROOT / 'build' / 'icon.ico', format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    # --- in-app tile + favicon ---
    (ROOT / 'src' / 'renderer' / 'assets').mkdir(parents=True, exist_ok=True)
    tile(256, mark, 0.66).resize((128, 128), Image.LANCZOS).save(ROOT / 'src' / 'renderer' / 'assets' / 'logo-tile.png')
    (ROOT / 'public').mkdir(exist_ok=True)
    tile(256, mark, 0.66).resize((64, 64), Image.LANCZOS).save(ROOT / 'public' / 'favicon.png')
    print('icons written: build/icon.png|icns|ico, src/renderer/assets/logo-tile.png, public/favicon.png')

if __name__ == '__main__':
    main()
