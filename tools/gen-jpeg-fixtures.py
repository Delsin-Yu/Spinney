#!/usr/bin/env python3
"""gen-jpeg-fixtures.py - dev-only generator for the `check:jpeg` fixtures.

The JPEG decoder in `src/agent/jpeg*.ts` must not certify itself
(`docs/agents/plans/image-budget.md` section 6), so its fixtures come from an
independent encoder (PIL's libjpeg) and each one is committed together with what
PIL decoded from it. `tools/check-jpeg.js` then compares our decoder's RGBA
against those committed expectations; PIL is not needed at guard time.

Run (PIL 12.3.0 lives in the repo's miniForge python):

    /d/Utils/miniForge3/python tools/gen-jpeg-fixtures.py

Regenerating rewrites `tools/fixtures/jpeg/**`: the JPEGs, the expectations and
`manifest.json` (which records the oracle version). Commit all three together.

Content is deterministic and deliberately chosen per fixture:

  * luma detail may be sharp (checkers, steps) - luma is never resampled, and our
    IDCT has to match libjpeg's on hard edges;
  * the 4:2:0 / 4:2:2 fixtures keep their structure in LUMA and their chroma gentle,
    because the oracle (libjpeg) upsamples chroma with its fancy triangle filter while
    the contract is box repetition (`jpegReconstruct.ts`): on a steep chroma ramp the two
    legitimately disagree by far more than the tolerance below, which would make a correct
    decoder fail. 4:4:4 and grayscale fixtures carry the sharp colour content, where the
    oracle is exact; the committed tolerance is 8 max / 1.5 mean.
"""

import json
import math
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "jpeg")


def clamp8(v):
    return 0 if v < 0 else (255 if v > 255 else int(round(v)))


def smooth_rgb(w, h):
    """Colour for the subsampled (4:2:0 / 4:2:2) fixtures: strong LUMA structure, gentle
    CHROMA.

    Why that split: the oracle (libjpeg) upsamples chroma with its fancy triangle filter,
    while the contract here is box repetition (`jpegReconstruct.ts`), and the two differ by
    about (chroma step)/4 * 1.8 per channel - so a steep chroma ramp would put the fixture
    outside the tolerance for a *correct* decoder. Luma is never resampled, so the luma
    path can carry all the hard structure it likes: the checker and the step below are
    added equally to R, G and B (a pure luma change), which leaves chroma alone."""
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        fy = y / max(1, h - 1)
        for x in range(w):
            fx = x / max(1, w - 1)
            luma = 95 + 55 * fx + 35 * fy
            if ((x // 3) + (y // 3)) % 2 == 0:
                luma += 28
            else:
                luma -= 28
            if x < max(2, w // 4):
                luma -= 32
            r = luma + 18 * fx + 4 * math.sin(2 * math.pi * fy)
            g = luma - 6 + 10 * fy
            b = luma + 18 * fy + 4 * math.sin(2 * math.pi * fx)
            px[x, y] = (clamp8(r), clamp8(g), clamp8(b))
    return im


def detailed_rgb(w, h):
    """Colour with real texture: used where the oracle is exact (4:4:4)."""
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            fx = x / max(1, w - 1)
            fy = y / max(1, h - 1)
            r = 20 + 200 * fx
            g = 20 + 200 * fy
            b = 40 + 180 * (0.5 * fx + 0.5 * fy)
            if ((x // 5) + (y // 5)) % 2 == 0:
                r += 35
                g -= 25
                b += 25
            if x % 11 == 0:
                g += 30
            if y % 7 == 0:
                b -= 30
            px[x, y] = (clamp8(r), clamp8(g), clamp8(b))
    return im


def gray_pattern(w, h):
    """Grayscale with sharp structure: pure luma, so the oracle matches exactly."""
    im = Image.new("L", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            v = 40 + 175 * (0.5 * x / max(1, w - 1) + 0.5 * y / max(1, h - 1))
            if ((x // 4) + (y // 4)) % 2 == 0:
                v += 38
            else:
                v -= 30
            if x < 3 or y < 3 or x >= w - 3:
                v -= 40
            px[x, y] = clamp8(v)
    return im


def smooth_gray(w, h):
    im = Image.new("L", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            v = 25 + 205 * (0.5 * x / max(1, w - 1) + 0.5 * y / max(1, h - 1))
            if ((x // 8) + (y // 8)) % 2 == 0:
                v += 20
            px[x, y] = clamp8(v)
    return im


def write_expectation(name, im, stride=None):
    """PIL's own decode of the file just written, as the committed expectation."""
    rgba = im.convert("RGBA")
    w, h = rgba.size
    if stride is None:
        path = os.path.join(OUT, name + ".rgba")
        with open(path, "wb") as fh:
            fh.write(rgba.tobytes())
        return {"expectKind": "rgba", "expect": name + ".rgba",
                "expectBytes": os.path.getsize(path), "stride": 1}
    data = rgba.tobytes()
    samples = []
    for y in range(0, h, stride):
        for x in range(0, w, stride):
            o = (y * w + x) * 4
            samples.extend(data[o:o + 4])
    # The last column/row are where a decoder's edge handling shows, so sample them too.
    for y in range(h):
        for x in (w - 1,):
            o = (y * w + x) * 4
            samples.extend(data[o:o + 4])
    path = os.path.join(OUT, name + ".samples.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"width": w, "height": h, "stride": stride,
                   "tailColumn": True, "rgba": samples}, fh)
        fh.write("\n")
    return {"expectKind": "samples", "expect": name + ".samples.json",
            "expectBytes": os.path.getsize(path), "stride": stride}


def mcu_counts(w, h, hmax, vmax):
    return ((w + 8 * hmax - 1) // (8 * hmax)) * ((h + 8 * vmax - 1) // (8 * vmax))


def has_marker(data, marker):
    return bytes([0xFF, marker]) in data


def main():
    os.makedirs(OUT, exist_ok=True)
    for old in os.listdir(OUT):
        os.remove(os.path.join(OUT, old))

    fixtures = []

    def add(name, im, *, quality, subsampling, desc, stride=None, restart=None, tags=()):
        path = os.path.join(OUT, name + ".jpg")
        opts = {"quality": quality, "optimize": False}
        if im.mode in ("RGB", "CMYK"):
            opts["subsampling"] = subsampling
        if restart is not None:
            opts["restart_marker_blocks"] = restart
        im.save(path, "JPEG", **opts)
        data = open(path, "rb").read()
        # PIL must be able to read back what it wrote, otherwise the expectation is junk.
        with Image.open(path) as back:
            back.load()
            exp = write_expectation(name, back, stride)
        entry = {
            "file": name + ".jpg",
            "bytes": len(data),
            "width": im.size[0],
            "height": im.size[1],
            "mode": im.mode,
            "components": 1 if im.mode == "L" else (4 if im.mode == "CMYK" else 3),
            "subsampling": subsampling if im.mode != "L" else "1x1",
            "quality": quality,
            "restartIntervalBlocks": restart,
            "desc": desc,
        }
        entry.update(exp)
        fixtures.append(entry)
        print("  %-24s %6d B  %dx%d %s %s%s" % (
            name + ".jpg", len(data), im.size[0], im.size[1], im.mode, subsampling,
            " restart=%d" % restart if restart else ""))
        return entry

    print("write baseline fixtures")
    add("gray-16x16", gray_pattern(16, 16), quality=90, subsampling=None,
        desc="grayscale, sharp 4px checkers + steps: pure luma through the IDCT")
    add("gray-17x9", gray_pattern(17, 9), quality=90, subsampling=None,
        desc="grayscale at an odd size (17x9): partial MCUs on both axes")
    add("rgb-444-32x24", detailed_rgb(32, 24), quality=90, subsampling=0,
        desc="4:4:4 colour with texture and hard edges: the oracle is exact here")
    add("rgb-420-32x24", smooth_rgb(32, 24), quality=90, subsampling=2,
        desc="4:2:0 colour, smooth chroma (box vs the oracle's fancy upsampling)")
    add("rgb-420-17x9", smooth_rgb(17, 9), quality=90, subsampling=2,
        desc="4:2:0 at 17x9: chroma blocks overhang the frame on both axes")
    add("rgb-422-24x16", smooth_rgb(24, 16), quality=88, subsampling=1,
        desc="4:2:2 h2v1: horizontal-only upsampling (2 wide, 1 tall)")
    add("gray-restart-48x40", smooth_gray(48, 40), quality=88, subsampling=None,
        desc="grayscale with DRI/RSTn markers (restart every 2 MCUs)",
        restart=2)
    add("rgb-420-restart-32x24", smooth_rgb(32, 24), quality=88, subsampling=2,
        desc="4:2:0 with DRI/RSTn markers (restart every 3 MCUs)",
        restart=3)
    add("large-444-160x120", detailed_rgb(160, 120), quality=84, subsampling=0,
        desc="4:4:4 texture, sampled expectation (stride 4 + last column)",
        stride=4)

    # ------------------------------------------------ negative fixtures
    negatives = []

    def add_negative(name, im, *, quality, subsampling, desc, save_opts=None, **kw):
        path = os.path.join(OUT, name + ".jpg")
        opts = {"quality": quality}
        if im.mode == "RGB":
            opts["subsampling"] = subsampling
        if save_opts:
            opts.update(save_opts)
        im.save(path, "JPEG", **opts)
        data = open(path, "rb").read()
        entry = {"file": name + ".jpg", "bytes": len(data), "desc": desc}
        entry.update(kw)
        negatives.append(entry)
        print("  %-24s %6d B  %s" % (name + ".jpg", len(data), desc))
        return path, entry

    add_negative("progressive-444-32x24", detailed_rgb(32, 24), quality=85,
                 subsampling=0, desc="progressive (SOF2) - must be refused",
                 save_opts={"progressive": True}, why="progressive")

    # truncated: a valid baseline encode cut inside the scan, so the entropy stream
    # simply stops. PIL refuses it too (LOAD_TRUNCATED_IMAGES is off).
    tmp_path, entry = add_negative("truncated-420-32x24", smooth_rgb(32, 24),
                                   quality=85, subsampling=2,
                                   desc="valid 4:2:0 baseline cut mid-scan - must be refused",
                                   why="truncated")
    full = open(tmp_path, "rb").read()
    os.remove(tmp_path)
    sos = full.index(b"\xff\xda")
    body = sos + 14  # past the SOS header, inside the scan data
    cut = body + (len(full) - body) * 55 // 100
    path = os.path.join(OUT, "truncated-420-32x24.jpg")
    with open(path, "wb") as fh:
        fh.write(full[:cut])
    entry["bytes"] = cut
    entry["cutAt"] = cut

    add_negative("cmyk-32x24", detailed_rgb(32, 24).convert("CMYK"), quality=85,
                 subsampling=0, desc="4 components (CMYK) - must be refused",
                 why="components")

    # 12-bit precision, and SOF1 (extended sequential): synthesized by patching a
    # valid file, because no common encoder writes them. The guard patches these
    # itself; the committed fixture is only the source of the bytes.
    add_negative("baseline-444-16x16", gray_pattern(16, 16), quality=90,
                 subsampling=0, desc="plain 16x16 baseline - source for the guard's patched cases",
                 why="baseline-source")

    manifest = {
        "oracle": "PIL %s (libjpeg-turbo), /d/Utils/miniForge3/python" % Image.__version__,
        "generatedBy": "tools/gen-jpeg-fixtures.py",
        "tolerance": {"maxChannelDifference": 8, "meanChannelDifference": 1.5},
        "toleranceNote": "IDCT/rounding tolerance; the 4:2:0/4:2:2 fixtures keep their structure in luma and "
                         "their chroma gentle because the oracle upsamples chroma with libjpeg's fancy filter "
                         "while the contract is box repetition (jpegReconstruct.ts)",
        "fixtures": fixtures,
        "negatives": negatives,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=False)
        fh.write("\n")

    print("checks")
    problems = []
    for entry in fixtures:
        data = open(os.path.join(OUT, entry["file"]), "rb").read()
        if entry["bytes"] > 20 * 1024:
            problems.append("%s is %d B (want <= 20 KiB)" % (entry["file"], entry["bytes"]))
        if entry["restartIntervalBlocks"]:
            if not has_marker(data, 0xDD):
                problems.append("%s: no DRI marker" % entry["file"])
            if not has_marker(data, 0xD0):
                problems.append("%s: no RSTn marker" % entry["file"])
        if entry["components"] == 1:
            pass
    # the truncated fixture must really be unreadable to the oracle
    try:
        with Image.open(os.path.join(OUT, "truncated-420-32x24.jpg")) as im:
            im.load()
        problems.append("truncated fixture decodes fine in PIL - regenerate it (cut deeper)")
    except Exception as exc:  # noqa: BLE001 - any failure is what we want here
        print("  truncated fixture: PIL refuses it (%s)" % type(exc).__name__)
    # the progressive one must be readable, or it is not a progressive test
    with Image.open(os.path.join(OUT, "progressive-444-32x24.jpg")) as im:
        im.load()
        if not im.info.get("progressive"):
            problems.append("progressive fixture is not progressive")
    with Image.open(os.path.join(OUT, "cmyk-32x24.jpg")) as im:
        im.load()
        if im.mode != "CMYK":
            problems.append("cmyk fixture decodes as %s" % im.mode)

    if problems:
        print("FAIL generator self-check:")
        for p in problems:
            print("  - " + p)
        return 1
    print("ok: %d positive fixtures, %d negative fixtures, all <= 20 KiB"
          % (len(fixtures), len(negatives)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
