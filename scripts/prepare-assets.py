"""
Velora Valley asset pipeline.

Converts the supplied brand assets (brochure, product photography, logo) into
optimised web images under public/images. Re-run whenever source assets change:

    python -I scripts/prepare-assets.py --src "C:/Users/<you>/Downloads"

Expected layout inside --src:
    Brochure - Velora Valley.pdf
    vvp1-inspect/                       (brochure product crops, 1000px)
    velora-valley-brochure-assets/logo/ (logo PNGs)
    Velora Valley Product Images-*/Velora Valley Product Images/  (packshots + ads)
"""
import argparse
import glob
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

ap = argparse.ArgumentParser()
ap.add_argument("--src", required=True)
ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "images"))
args = ap.parse_args()

SRC = args.src
OUT = os.path.abspath(args.out)
CROPS = os.path.join(SRC, "vvp1-inspect")
LOGOS = os.path.join(SRC, "velora-valley-brochure-assets", "logo")
_photo_roots = glob.glob(os.path.join(SRC, "Velora Valley Product Images*", "Velora Valley Product Images"))
PHOTOS = _photo_roots[0] if _photo_roots else None
BROCHURE = os.path.join(SRC, "Brochure - Velora Valley.pdf")


def save(img: Image.Image, rel: str, max_w: int = 1400, quality: int = 80):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if img.width > max_w:
        img = img.resize((max_w, round(img.height * max_w / img.width)), Image.LANCZOS)
    if rel.endswith(".png"):
        img.save(path, optimize=True)
    else:
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.mode else "RGB")
        img.save(path, "WEBP", quality=quality, method=6)
    print("  ->", rel, img.size)


def open_rgb(path):
    im = Image.open(path)
    return im.convert("RGB")


def cutout(path: str) -> Image.Image:
    """Remove a near-white studio background by flood-filling from the borders."""
    im = open_rgb(path)
    w, h = im.size
    key = (255, 0, 255)
    filled = im.copy()
    seeds = [(x, 0) for x in range(0, w, max(1, w // 40))] + [(x, h - 1) for x in range(0, w, max(1, w // 40))]
    seeds += [(0, y) for y in range(0, h, max(1, h // 40))] + [(w - 1, y) for y in range(0, h, max(1, h // 40))]
    for s in seeds:
        r, g, b = filled.getpixel(s)
        if (r, g, b) != key and min(r, g, b) > 225:
            ImageDraw.floodfill(filled, s, key, thresh=28)
    mask = Image.new("L", (w, h), 0)
    px_f = filled.load()
    px_m = mask.load()
    for y in range(h):
        for x in range(w):
            if px_f[x, y] != key:
                px_m[x, y] = 255
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    rgba = im.convert("RGBA")
    rgba.putalpha(mask)
    bbox = mask.point(lambda v: 255 if v > 40 else 0).getbbox()
    return rgba.crop(bbox) if bbox else rgba


def photo(*parts):
    if not PHOTOS:
        return None
    p = os.path.join(PHOTOS, *parts)
    return p if os.path.exists(p) else None


# --- 1. Brand -----------------------------------------------------------------
print("brand")
for name in ("velora-logo-forest.png", "velora-logo-cream.png"):
    src = os.path.join(LOGOS, name)
    if os.path.exists(src):
        logo = Image.open(src).convert("RGBA")
        save(logo, f"brand/{name.replace('velora-', '')}")
        # the leaf/valley mark on its own (left part of the lockup)
        mark = logo.crop((0, 0, 200, logo.height))
        bbox = mark.getbbox()
        save(mark.crop(bbox), f"brand/{name.replace('velora-logo', 'mark')}")

if os.path.exists(BROCHURE):
    import pymupdf  # noqa: E402

    doc = pymupdf.open(BROCHURE)

    def page_image(i):
        info = doc.extract_image(doc[i].get_images(full=True)[0][0])
        import io
        return Image.open(io.BytesIO(info["image"])).convert("RGB")

    cover = page_image(0)
    W, H = cover.size  # 2480 x 3508 (300dpi A4)
    save(cover.crop((0, int(H * 0.455), W, int(H * 0.80))), "brand/valley-wide.webp", max_w=2200, quality=78)
    save(cover.crop((0, 0, W, int(H * 0.27))), "brand/valley-sky.webp", max_w=2000, quality=74)
    save(cover.crop((int(W * 0.25), int(H * 0.44), W, int(H * 0.80))), "brand/valley-tall.webp", max_w=1600, quality=78)

# --- 2. Quality-process photography (from brochure page 2) ---------------------
print("process")
for stage in ("sourcing", "processing", "quality", "packaging", "distribution"):
    p = os.path.join(CROPS, f"proc-{stage}.jpg")
    if os.path.exists(p):
        save(open_rgb(p), f"process/{stage}.webp", max_w=900)

# --- 3. Products --------------------------------------------------------------
# slug -> { lifestyle crop, optional packshots/ads }
P = {
    "whole-wheat-chapati": {"lifestyle": "chapati.jpg"},
    "malabar-paratha": {"lifestyle": "paratha.jpg"},
    "ragi-malt": {"lifestyle": "ragimalt.jpg"},
    "roasted-super-seed-mix": {
        "lifestyle": "superseed.jpg",
        "front": ("superseed mix 200g", "super seed mix front.png"),
        "back": ("superseed mix 200g", "super seed mix back.png"),
        "gallery": [("superseed mix 200g", "SUPER SEED AD3.png"), ("superseed mix 200g", "SUPER SEED AD4.png")],
        "cut": True,
    },
    "premium-cashews": {
        "lifestyle": "cashews.jpg",
        "front": ("Cashews 250g", "cashew front.PNG"),
        "back": ("Cashews 250g", "cashew back.PNG"),
        "gallery": [("Cashews 250g", "cashew add2.PNG"), ("Cashews 250g", "cashew add3.PNG"), ("Cashews 250g", "cashew additional.PNG")],
        "cut": True,
    },
    "premium-black-raisins": {
        "lifestyle": "raisins.jpg",
        "front": ("Black Raisins", "black rasins front.PNG"),
        "back": ("Black Raisins", "raisins back.PNG"),
        "gallery": [("Black Raisins", "raisins additional image.PNG"), ("Black Raisins", "way to enjoy raisins.PNG")],
        "cut": True,
    },
    "california-almonds": {
        "lifestyle": "almonds.jpg",
        "front": ("Almonds 250g", "almonds front.PNG"),
        "back": ("Almonds 250g", "almond back.PNG"),
        "gallery": [("Almonds 250g", "almond add 5.png"), ("Almonds 250g", "almond add 1.PNG"), ("Almonds 250g", "almond 2.jpeg")],
        "cut": True,
    },
    "salted-roasted-pistachios": {
        "lifestyle": "pistachio.jpg",
        "front": ("Pistachio 250g", "PISTA FRONT.PNG"),
        "back": ("Pistachio 250g", "PISTA BACK.PNG"),
        "gallery": [("Pistachio 250g", "pista add5.png"), ("Pistachio 250g", "PISTA ADDITI.PNG"), ("Pistachio 250g", "pista add4.png")],
        "cut": True,
    },
    "arabian-premium-seedless-dates": {
        "lifestyle": "arabian-box.jpg",
        "front": ("Premium Seedless dates 500gm", "seedless box front.png"),
        "back": ("Premium Seedless dates 500gm", "seedless back 500g.png"),
        "gallery": [("Premium Seedless dates 500gm", "seedless ad2.PNG"), ("Premium Seedless dates 500gm", "seedless ad 1.png")],
        "cut": True,
    },
    "arabian-dates": {"lifestyle": "arabian-250.jpg"},
    "seedless-dates": {"lifestyle": "seedless.jpg"},
    "arabian-seeded-dates": {
        "lifestyle": "arabian-seeded.jpg",
        "front": ("1kg dates", "1kg dates front.png"),
        "back": ("1kg dates", "1kg dates back.png"),
        "gallery": [("1kg dates", "1kg dates add1.png"), ("1kg dates", "1kg dates add 3.png")],
        "cut": True,
    },
    "safawi-dates": {
        "lifestyle": "safawi.jpg",
        "front": ("Safawi Dates 500g", "safawi dates front.png"),
        "back": ("Safawi Dates 500g", "safawi dates nutritional facts.png"),
        "gallery": [("Safawi Dates 500g", "safawi add2.png"), ("Safawi Dates 500g", "SAFAWI ADD3.png"), ("Safawi Dates 500g", "safawi add 1.png")],
        "cut": True,
    },
    "kimia-dates": {
        "lifestyle": "kimia-500.jpg",
        "front": ("Kimia 500g", "kimia dates front].png"),
        "back": ("Kimia 500g", "mrp 500g kimia.PNG"),
        "gallery": [
            ("Kimia 500g", "Velora Valley Kimia Dates advertisement.png"),
            ("Kimia 500g", "kimia 500g marketing.png"),
            ("Kimia 500g", "Premium Kimia dates with natural elegance.png"),
        ],
        "variants": {"400g": "kimia-400.jpg", "250g": "kimia-250.jpg"},
        "extra_front": {"400g": ("kimia 400g white colour", "400g kimia front.png"), "250g": ("kimia 250g green", "250g date front.png")},
        "cut": True,
    },
    "fruit-and-nut-cookies": {"lifestyle": "cookies.jpg"},
    "osmania-biscuits": {"lifestyle": "osmania.jpg"},
    "ragi-biscuits": {"lifestyle": "ragi-biscuits.jpg"},
    "dates-chocolate": {"lifestyle": "dates-choc.jpg"},
    "dark-chocolate": {"lifestyle": "dark-choc.jpg"},
    "mixed-fruit-jam": {"lifestyle": "jam.jpg"},
    "candied-karonda-cherry": {"lifestyle": "karonda.jpg", "variants": {"200g": "cherry.jpg"}},
    "tutti-fruity": {"lifestyle": "tutti-100.jpg", "variants": {"200g": "tutti-200.jpg"}},
    "mixed-jelly-cubes": {"lifestyle": "jelly.jpg"},
    "flax-seeds": {"lifestyle": "flax.jpg"},
    "pumpkin-seeds": {"lifestyle": "pumpkin.jpg"},
    "muskmelon-seeds": {"lifestyle": "muskmelon.jpg"},
    "sabja-seeds": {"lifestyle": "sabja.jpg"},
    "watermelon-seeds": {"lifestyle": "watermelon.jpg"},
    "chia-seeds": {"lifestyle": "chia.jpg"},
    "sunflower-seeds": {"lifestyle": "sunflower.jpg"},
}

only = set(sys.argv[sys.argv.index("--only") + 1].split(",")) if "--only" in sys.argv else None

for slug, spec in P.items():
    if only and slug not in only:
        continue
    print(slug)
    base = f"products/{slug}"
    save(open_rgb(os.path.join(CROPS, spec["lifestyle"])), f"{base}/lifestyle.webp", max_w=1000)
    for label, crop in spec.get("variants", {}).items():
        save(open_rgb(os.path.join(CROPS, crop)), f"{base}/lifestyle-{label}.webp", max_w=1000)
    if spec.get("front") and photo(*spec["front"]):
        save(open_rgb(photo(*spec["front"])), f"{base}/front.webp", max_w=1000)
        if spec.get("cut"):
            save(cutout(photo(*spec["front"])), f"{base}/cutout.webp", max_w=800, quality=84)
    for label, src in spec.get("extra_front", {}).items():
        if photo(*src):
            save(open_rgb(photo(*src)), f"{base}/front-{label}.webp", max_w=1000)
    if spec.get("back") and photo(*spec["back"]):
        save(open_rgb(photo(*spec["back"])), f"{base}/back.webp", max_w=1000)
    for i, g in enumerate(spec.get("gallery", []), 1):
        if photo(*g):
            save(open_rgb(photo(*g)), f"{base}/gallery-{i}.webp", max_w=1100, quality=78)

print("done")
