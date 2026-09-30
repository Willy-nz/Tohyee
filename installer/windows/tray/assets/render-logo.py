"""Renders ../../../../assets/logo.svg into the PNGs and ICO the server app embeds
(Windows Forms can't draw SVG). Needs Python with Playwright (Chromium) and Pillow:
    python installer/windows/tray/assets/render-logo.py      (from the repository root)
"""
import os
from playwright.sync_api import sync_playwright
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
svg = open(os.path.join(here, "..", "..", "..", "..", "assets", "logo.svg"), encoding="utf-8").read()
big_png = os.path.join(here, "logo-512.tmp.png")
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 512, "height": 512})
    page.set_content('<html><body style="margin:0;background:transparent">' + svg.replace("<svg ", '<svg width="512" height="512" ', 1) + "</body></html>")
    page.screenshot(path=big_png, omit_background=True, clip={"x": 0, "y": 0, "width": 512, "height": 512})
    browser.close()
big = Image.open(big_png).convert("RGBA")
for size in (32, 128):
    big.resize((size, size), Image.LANCZOS).save(os.path.join(here, f"logo-{size}.png"), optimize=True)
big.save(os.path.join(here, "tohyee.ico"), sizes=[(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
os.remove(big_png)
