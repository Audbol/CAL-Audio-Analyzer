"""
Builds the CAL logo set in docs/brand: the mark, the wordmark for dark and light backgrounds and the GitHub
social preview. Text is converted to outlines (Inter), so the SVGs look the same everywhere.
Usage: pip install fonttools brotli && python3 scripts/make-logo.py   (then node scripts/render-logo.mjs for PNGs)
"""
import math, os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2')
OUT = os.path.join(ROOT, 'docs', 'brand')
_fonts = {}

def font(w):
    if w not in _fonts:
        f = TTFont(SRC)
        f.flavor = None
        _fonts[w] = instancer.instantiateVariableFont(f, {'wght': w})
    return _fonts[w]

def text(s, w, size, x, y, track=0.0, anchor='start'):
    """SVG path data for `s` at baseline (x, y); track = extra spacing in em."""
    f = font(w)
    gs = f.getGlyphSet()
    cmap = f.getBestCmap()
    upm = f['head'].unitsPerEm
    k = size / upm
    hmtx = f['hmtx']
    names = [cmap[ord(c)] for c in s]
    width = sum(hmtx[n][0] * k for n in names) + track * size * (len(s) - 1)
    if anchor == 'middle':
        x -= width / 2
    elif anchor == 'end':
        x -= width
    pen = SVGPathPen(gs)
    cx = x
    for n in names:
        tp = TransformPen(pen, (k, 0, 0, -k, cx, y))
        gs[n].draw(tp)
        cx += hmtx[n][0] * k + track * size
    return pen.getCommands(), width

# ---- The mark: a tile with spectrum bars and a measured response curve over them -----------------------
def curve_y(x):
    """A measured response: a broad hump, a narrow dip, a resonance peak, then flat."""
    g = lambda c, w: math.exp(-((x - c) / w) ** 2)
    settle = 1 / (1 + math.exp(-(x - 384) / 16))
    return 292 - 104 * g(200, 44) - 120 * g(336, 32) - 46 * settle

def curve_path():
    xs = [100 + i * 2 for i in range(159)]
    return 'M' + ' L'.join(f'{x} {curve_y(x):.1f}' for x in xs)

BARS = [0.34, 0.52, 0.44, 0.64, 0.56, 0.72, 0.58]

def mark(x=0, y=0, s=1.0, tile=True, uid='m'):
    """The mark in a 512 box, placed at (x, y) and scaled by s."""
    g = [f'<g transform="translate({x} {y}) scale({s})">']
    if tile:
        g.append(f'<rect width="512" height="512" rx="116" fill="url(#{uid}-tile)"/>')
        g.append(f'<rect x="6" y="6" width="500" height="500" rx="110" fill="none" stroke="url(#{uid}-edge)" stroke-width="4"/>')
    # Spectrum bars along the bottom
    bw, gap, x0, base = 36, 11, 94, 380
    for i, h in enumerate(BARS):
        bh = h * 170
        g.append(f'<rect x="{x0 + i * (bw + gap)}" y="{base - bh:.1f}" width="{bw}" height="{bh:.1f}" rx="7" fill="url(#{uid}-bar)"/>')
    # The response curve with a soft glow, and a measurement point on its peak
    c = curve_path()
    g.append(f'<path d="{c}" fill="none" stroke="#4d9fff" stroke-opacity="0.35" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" filter="url(#{uid}-blur)"/>')
    g.append(f'<path d="{c}" fill="none" stroke="url(#{uid}-line)" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>')
    g.append(f'<circle cx="336" cy="{curve_y(336):.1f}" r="22" fill="#ffffff"/><circle cx="336" cy="{curve_y(336):.1f}" r="11" fill="#2f86ff"/>')
    g.append('</g>')
    return '\n'.join(g)

def defs(uid='m', light=False):
    return f'''<defs>
  <linearGradient id="{uid}-tile" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#121a2a"/><stop offset="1" stop-color="#03050a"/>
  </linearGradient>
  <linearGradient id="{uid}-edge" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#3b5d92" stop-opacity="0.7"/><stop offset="1" stop-color="#1a2234" stop-opacity="0.6"/>
  </linearGradient>
  <linearGradient id="{uid}-bar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2f86ff" stop-opacity="0.42"/><stop offset="1" stop-color="#2f86ff" stop-opacity="0.04"/>
  </linearGradient>
  <linearGradient id="{uid}-line" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#4d9fff"/><stop offset="1" stop-color="#7fe0ff"/>
  </linearGradient>
  <filter id="{uid}-blur" filterUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><feGaussianBlur stdDeviation="12"/></filter>
</defs>'''

def save(name, w, h, body):
    with open(os.path.join(OUT, name), 'w') as fh:
        fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">\n{body}\n</svg>\n')

# 1. The mark alone (app icon, avatar)
save('cal-mark.svg', 512, 512, defs() + mark())

# 2. Wordmarks (for dark and light backgrounds): mark, "CAL", "AUDIO ANALYZER"
def wordmark(light):
    ink = '#0b1220' if light else '#ffffff'
    sub = '#4a5568' if light else '#9aa6b8'
    cal, cw = text('CAL', 800, 150, 300, 168, track=0.04)
    tag, tw = text('AUDIO ANALYZER', 600, 40, 304, 236, track=0.22)
    W = int(300 + max(cw, tw) + 24)
    body = defs() + mark(0, 8, 0.5)
    body += f'\n<path d="{cal}" fill="{ink}"/>\n<path d="{tag}" fill="{sub}"/>'
    return W, 272, body

w, hh, b = wordmark(False)
save('cal-logo-dark.svg', w, hh, b)   # for dark backgrounds (white text)
w, hh, b = wordmark(True)
save('cal-logo-light.svg', w, hh, b)  # for light backgrounds (dark text)

# 3. Social preview (GitHub: 1280 × 640)
W, H = 1280, 640
grid = []
for i in range(1, 16):
    gx = 80 * i
    grid.append(f'<line x1="{gx}" y1="0" x2="{gx}" y2="{H}" stroke="#ffffff" stroke-opacity="{0.05 if i % 4 else 0.08}"/>')
for i in range(1, 8):
    gy = 80 * i
    grid.append(f'<line x1="0" y1="{gy}" x2="{W}" y2="{gy}" stroke="#ffffff" stroke-opacity="0.05"/>')
cal, cw = text('CAL', 800, 168, 0, 0, track=0.04)
total = 236 + 36 + cw
left = (W - max(total, 0)) / 2
cal, cw = text('CAL', 800, 168, left + 272, 316, track=0.04)
tag, tw = text('AUDIO ANALYZER', 600, 44, left + 276, 384, track=0.22)
line1, _ = text('Live sound and room acoustics, measured.', 500, 34, W / 2, 500, anchor='middle')
line2, _ = text('Transfer function  ·  Spectrum  ·  SPL  ·  Room acoustics  ·  Alignment  ·  EQ', 450, 24, W / 2, 548, track=0.01, anchor='middle')
body = defs('s') + f'''
<rect width="{W}" height="{H}" fill="url(#bg)"/>
<defs>
  <radialGradient id="bg" cx="0.5" cy="0.35" r="0.8">
    <stop offset="0" stop-color="#0f1a2e"/><stop offset="1" stop-color="#020306"/>
  </radialGradient>
</defs>
{''.join(grid)}
{mark(left, 156, 236 / 512, uid='s')}
<path d="{cal}" fill="#ffffff"/>
<path d="{tag}" fill="#9aa6b8"/>
<path d="{line1}" fill="#e6ebf2"/>
<path d="{line2}" fill="#7d8899"/>'''
save('social-preview.svg', W, H, body)
print('ok')
