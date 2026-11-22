# Colour emoji for the render. ffmpeg's subtitle renderer (libass) can't draw colour fonts, so the worker lays the
# text out with libass and draws the emoji itself, from the system's colour emoji font, on a transparent layer.
# Needs: pip install uharfbuzz freetype-py (and Pillow).
#
#   py emoji.py sheet <dir>    reads <dir>/sheet-job.json {"emoji": ["😂", "❤️‍🔥", ...]}
#     writes <dir>/e<i>.png (a tight colour image of each one it can colour) and <dir>/sheet.json {"colour": [i, ...]}
#   py emoji.py compose <dir>  reads <dir>/compose-job.json {"width": W, "height": H, "frames": [[{"i", "x", "y", "w", "h"}, ...], ...]}
#     writes <dir>/f<n>.png: a transparent W x H layer per frame with each emoji image fitted into its box
import json, os, sys

SIZE = 192


def font_path():
    if os.environ.get("EMOJI_FONT"):
        return os.environ["EMOJI_FONT"]
    for p in (os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "seguiemj.ttf"),
              "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", "/System/Library/Fonts/Apple Color Emoji.ttc"):
        if os.path.exists(p):
            return p
    raise SystemExit("no colour emoji font found (set EMOJI_FONT)")


def sheet(job):
    import freetype, uharfbuzz as hb
    from PIL import Image
    path = font_path()
    shaper = hb.Font(hb.Face(open(path, "rb").read()))
    face = freetype.Face(path)
    if face.is_scalable:
        face.set_pixel_sizes(0, SIZE)
    else:
        face.select_size(0)  # bitmap emoji fonts (Noto Color Emoji) have one fixed size
    colour = []
    for i, text in enumerate(job["emoji"]):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(shaper, buf, {})
        glyphs = [g.codepoint for g in buf.glyph_infos]
        # One coloured glyph or nothing: a sequence the font can't join (a flag on Windows) stays as text.
        if len(glyphs) != 1 or glyphs[0] == 0:
            continue
        try:
            face.load_glyph(glyphs[0], freetype.FT_LOAD_COLOR | freetype.FT_LOAD_RENDER)
        except freetype.FT_Exception:
            continue
        bm = face.glyph.bitmap
        if bm.pixel_mode != freetype.FT_PIXEL_MODE_BGRA or not bm.width or not bm.rows:
            continue
        img = Image.frombuffer("RGBA", (bm.width, bm.rows), bytes(bm.buffer), "raw", "BGRA", bm.pitch, 1)
        box = img.getbbox()
        if not box:
            continue
        img.crop(box).save(os.path.join(job["dir"], "e%d.png" % i))
        colour.append(i)
    with open(os.path.join(job["dir"], "sheet.json"), "w") as f:
        json.dump({"colour": colour}, f)


def compose(job):
    from PIL import Image
    images, cache = {}, {}
    for n, frame in enumerate(job["frames"]):
        layer = Image.new("RGBA", (job["width"], job["height"]), (0, 0, 0, 0))
        for b in frame:
            w, h = max(1, round(b["w"])), max(1, round(b["h"]))
            if b["i"] not in images:
                images[b["i"]] = Image.open(os.path.join(job["dir"], "e%d.png" % b["i"])).convert("RGBA")
            key = (b["i"], w, h)
            if key not in cache:
                cache[key] = images[b["i"]].resize((w, h), Image.LANCZOS)
            layer.alpha_composite(cache[key], (round(b["x"]), round(b["y"])))
        layer.save(os.path.join(job["dir"], "f%d.png" % n), optimize=False, compress_level=1)


if __name__ == "__main__":
    step, folder = sys.argv[1], sys.argv[2]
    with open(os.path.join(folder, step + "-job.json"), encoding="utf-8") as f:
        job = json.load(f)
    job["dir"] = folder
    {"sheet": sheet, "compose": compose}[step](job)
