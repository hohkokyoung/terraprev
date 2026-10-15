# Packs the Teaser frames (rendered by `npm run teaser`) into a looping animated WebP for the README.
# GitHub won't autoplay video, but it shows animated images; WebP keeps full colour at a small size.
#
#   python webp.py out/teaser ../docs/teaser.webp 20

import sys
from pathlib import Path

from PIL import Image

src, out, fps = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
frames = [Image.open(p).convert('RGB') for p in sorted(src.glob('*.jpeg'))]
if not frames:
    sys.exit(f'no frames in {src}')
frames[0].save(out, save_all=True, append_images=frames[1:], duration=round(1000 / fps), loop=0, quality=80, method=6)
print(f'{len(frames)} frames -> {out} ({out.stat().st_size / 1e6:.1f} MB)')
