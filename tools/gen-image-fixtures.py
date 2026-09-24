#!/usr/bin/env python3
"""gen-image-fixtures.py -- dev-only. (Re)generates `tools/fixtures/image/**` and the
expectations the three A1 guards read.

WHY PIL IS THE ORACLE
`docs/agents/plans/image-budget.md` section 6: "the decoder must not certify itself". A
hand-written PNG codec plus a hand-written guard can share a bug, so every expectation here
comes from somewhere else:

  * PNG fixtures are decoded with PIL (`Image.open(...).convert('RGBA')`) and the expectation
    is a sha256 over those RGBA bytes (plus explicit pixels for the small ones).
  * Resample expectations are PIL's own `crop` / `BOX` resize where those are defined
    (crop is exact; BOX == area average exactly when the factor is an integer), and an
    exact-integer-weight area average (below) where PIL's BOX is only an approximation
    (a non-integer factor, where BOX averages whole source pixels instead of weighting them
    by coverage).
  * Transform expectations are the same exact area average applied to the crop, so a
    transformed PNG's pixels can be checked against arithmetic nobody in `src/` wrote.

The hand-written PNGs (filter fixtures, 16-bit, packed bit depths, Adam7) are built here and
then round-tripped through PIL: the generator refuses to write expectations unless PIL decodes
the file back to the pattern it was built from. That is what makes them fixtures rather than
guesses.

Dev-only by construction: the guards never call python (they read the committed bytes), so a
machine without Pillow can still run `node tools/check-png.js`.

Run: /d/Utils/miniForge3/python tools/gen-image-fixtures.py
"""

import hashlib
import io
import json
import os
import struct
import zlib

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "image")
PIL_VERSION = Image.__version__

# --- PNG writing ---------------------------------------------------------------


def chunk(kind: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    )


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def forward_filter(bpp: int, kind: int, row: bytes, prev: bytes) -> bytes:
    """The PNG filtering rules, used only to BUILD fixtures (the TS side only reverses them)."""
    out = bytearray()
    for i, value in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prev[i] if prev else 0
        c = prev[i - bpp] if (prev and i >= bpp) else 0
        if kind == 0:
            v = value
        elif kind == 1:
            v = (value - a) & 0xFF
        elif kind == 2:
            v = (value - b) & 0xFF
        elif kind == 3:
            v = (value - ((a + b) >> 1)) & 0xFF
        else:
            v = (value - paeth(a, b, c)) & 0xFF
        out.append(v)
    return bytes(out)


def write_png(path, width, height, bit_depth, colour_type, rows, plte=None, trns=None):
    """rows: list of UNFILTERED raw scanline bytes (packed as the bit depth requires)."""
    raw = bytearray()
    prev = None
    for row in rows:
        # filter 0 here: these fixtures exist to pin pixel decoding, not filtering.
        raw += b"\x00" + row
        prev = row
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, colour_type, 0, 0, 0)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    if plte is not None:
        out += chunk(b"PLTE", plte)
    if trns is not None:
        out += chunk(b"tRNS", trns)
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(out)
    return out


def write_filtered_png(path, width, height, colour_type, pixels, bpp, filter_kinds):
    """One hand-written file whose rows use exactly `filter_kinds` (a filter each)."""
    raw = bytearray()
    prev = None
    for y in range(height):
        row = bytes(c for px in pixels[y] for c in px)
        raw += bytes([filter_kinds[y % len(filter_kinds)]]) + forward_filter(
            bpp, filter_kinds[y % len(filter_kinds)], row, prev
        )
        prev = row
    bplte = None
    if colour_type == 3:
        bplte = bytes(c for entry in PALETTE4 for c in entry)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, colour_type, 0, 0, 0)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    if bplte:
        out += chunk(b"PLTE", bplte)
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(out)
    return out


ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def adam7_png(path, width, height, pixels):
    """A real interlaced PNG (all filters 0) so the TS decoder's interlace refusal is
    provoked by the flag rather than by damaged data."""
    raw = bytearray()
    for x0, y0, dx, dy in ADAM7:
        for y in range(y0, height, dy):
            cols = list(range(x0, width, dx))
            if not cols:
                continue
            raw.append(0)
            for x in cols:
                raw += bytes(pixels[y][x])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 1)
    out = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(out)
    return out


# --- patterns (deterministic, no random) ---------------------------------------


def ladder(seed):
    state = [seed]

    def nxt():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7FFFFFFF
        return state[0]

    return nxt


def rgb_gradient(w, h):
    """A smooth ramp with a diagonal ripple: structured, so PNG filtering has something to
    win and PIL's encoder is a fair size comparison."""
    return [
        [(x * 255 // max(1, w - 1), y * 255 // max(1, h - 1), (x * 7 + y * 13) % 256) for x in range(w)]
        for y in range(h)
    ]


def rgba_noise(w, h, seed):
    nxt = ladder(seed)
    out = []
    for y in range(h):
        row = []
        for x in range(w):
            row.append(((nxt() >> 7) & 0xFF, (nxt() >> 5) & 0xFF, (nxt() >> 3) & 0xFF, 30 + (x * 200 // max(1, w - 1)) % 226))
        out.append(row)
    return out


def rgb_noise(w, h, seed):
    nxt = ladder(seed)
    return [[((nxt() >> 7) & 0xFF, (nxt() >> 5) & 0xFF, (nxt() >> 3) & 0xFF) for _ in range(w)] for _ in range(h)]


def rgba_ramp(w, h):
    return [
        [(x * 255 // max(1, w - 1), y * 255 // max(1, h - 1), (x + y) % 256, 255 - (x * 255 // max(1, w - 1)) // 2)
         for x in range(w)]
        for y in range(h)
    ]


# --- the exact area-average oracle ---------------------------------------------
# Integer coverage weights: source pixel i and destination pixel j share
#   overlap = max(0, min((i+1)*dw, (j+1)*sw) - max(i*dw, j*sw))
# units of 1/dw of a source pixel, so the weights are exact integers and the result is
#   sum(wx*wy*v) / (sw*sh), rounded half-up -- all exact in float64 for any real image.
# TS mirrors this arithmetic (see imageResample.ts), which is why a non-integer factor can
# be compared pixel for pixel instead of approximately.


def axis_weights(src, dst):
    out = []
    for j in range(dst):
        pairs = []
        for i in range(src):
            lo = max(i * dst, j * src)
            hi = min((i + 1) * dst, (j + 1) * src)
            if hi > lo:
                pairs.append((i, hi - lo))
        out.append(pairs)
    return out


def area_resample(pixels, sw, sh, dw, dh):
    xw = axis_weights(sw, dw)
    yw = axis_weights(sh, dh)
    # The weights are in units of 1/dw of a source pixel, so one destination pixel's weights
    # sum to sw (and one destination row's to sh): the divisor is just the source pixel count.
    den_x = sw
    den_y = sh
    channels = len(pixels[0][0])
    den = den_x * den_y
    out = []
    for j in range(dh):
        row = []
        for i in range(dw):
            num = [0.0] * channels
            for k, wy in yw[j]:
                src_row = pixels[k]
                for xi, wx in xw[i]:
                    px = src_row[xi]
                    w = wx * wy
                    for c in range(channels):
                        num[c] += w * px[c]
            row.append(tuple(int(v / den + 0.5) for v in num))
        out.append(row)
    return out


def dst_dims(width, height, target_max_side):
    """The destination size for a crop of `width` x `height`: the TS side scales by
    min(1, target / longest side) and rounds each side half-up (JS Math.round)."""
    scale = min(1.0, target_max_side / max(width, height))
    dw = max(1, int(width * scale + 0.5))
    dh = max(1, int(height * scale + 0.5))
    return dw, dh, (1.0 if (dw == width and dh == height) else scale)


def flat(pixels):
    return bytes(c for row in pixels for px in row for c in px)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def spots(pixels, width, count=8):
    """A handful of explicit pixels, so a guard failure can name a value instead of a hash."""
    total = len(pixels) * width
    picked = sorted({(i * 7919) % total for i in range(count)})
    out = []
    for idx in picked:
        y, x = divmod(idx, width)
        out.append([idx] + list(pixels[y][x]))
    return out


def save_pil(img, name, **kwargs):
    path = os.path.join(OUT, name)
    img.save(path, "PNG", **kwargs)
    return path


PALETTE4 = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (10, 20, 30), (200, 100, 50)]


def rgba_of(img):
    return img.convert("RGBA").tobytes()


def size_of(name):
    return os.path.getsize(os.path.join(OUT, name))


def idat_filters(path):
    """The per-row filter bytes of a committed PNG, read straight from its IDAT."""
    data = open(path, "rb").read()
    off, raw = 8, b""
    while off + 8 <= len(data):
        ln = struct.unpack(">I", data[off : off + 4])[0]
        kind = data[off + 4 : off + 8]
        if kind == b"IDAT":
            raw += data[off + 8 : off + 8 + ln]
        off += 12 + ln
    raw = zlib.decompress(raw)
    return raw


def png_row_filters(path, width, height):
    """The fixture's own filter bytes, so the JSON pins which filter the decoder met."""
    data = open(path, "rb").read()
    bit_depth, colour_type = data[24], data[25]
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[colour_type]
    row_bytes = (width * channels * bit_depth + 7) // 8
    raw = idat_filters(path)
    return [raw[y * (row_bytes + 1)] for y in range(height)]


def main():
    os.makedirs(OUT, exist_ok=True)
    png_expect, rs_expect, tm_expect = {}, {}, {}
    notes = []

    # ============================== png group ==============================

    # PIL wrote these: the decoder is checked against another encoder's bytes.
    gradient = Image.new("RGB", (24, 16))
    gradient.putdata([px for row in rgb_gradient(24, 16) for px in row])
    save_pil(gradient, "png-rgb-24x16.png")

    # A larger structured image, so the encoder's adaptive filtering can be compared with PIL's
    # own encoder at a size where the IDAT dominates the file (24x16 is mostly chunk overhead).
    big = Image.new("RGB", (240, 160))
    big.putdata([(x * 255 // 239, y * 255 // 159, ((x // 16 + y // 16) % 2) * 180 + (x * y) % 60)
                 for y in range(160) for x in range(240)])
    save_pil(big, "png-rgb-240x160.png")

    rgba_ramp_img = Image.new("RGBA", (9, 7))
    rgba_ramp_img.putdata([px for row in rgba_ramp(9, 7) for px in row])
    save_pil(rgba_ramp_img, "png-rgba-9x7.png")

    grey = Image.new("L", (16, 5))
    grey.putdata([(x * 15 + y * 40) % 256 for y in range(5) for x in range(16)])
    save_pil(grey, "png-grey-16x5.png")

    # PIL's own palette output is bit depth 4 when six colours fit (Pillow packs it), which is
    # the packed variant the decoder must refuse -- so it is a fixture on its own.
    pal = Image.new("P", (5, 4))
    pal.putpalette(bytes(c for e in PALETTE4 for c in e))
    pal.putdata([0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1])
    save_pil(pal, "png-palette-4bit.png", transparency=bytes([0, 255, 128, 255, 200, 255]))

    # An 8-bit palette with a full tRNS, hand-written so the bit depth stays 8 (Pillow would
    # pack it): entry 1 is fully transparent, entry 3 half, the rest opaque.
    write_png(
        os.path.join(OUT, "png-palette-trns.png"), 5, 4, 8, 3,
        [bytes([0, 1, 2, 3, 4]), bytes([5, 0, 1, 2, 3]), bytes([4, 5, 0, 1, 2]), bytes([3, 4, 5, 0, 1])],
        plte=bytes(c for e in PALETTE4 for c in e), trns=bytes([255, 0, 255, 128, 255, 200]),
    )
    with Image.open(os.path.join(OUT, "png-palette-trns.png")) as im:
        im.load()
        alphas = [im.convert("RGBA").getpixel((x, y))[3] for y in range(4) for x in range(5)]
        if alphas != [255, 0, 255, 128, 255, 200, 255, 0, 255, 128, 255, 200, 255, 0, 255,
                      128, 255, 200, 255, 0]:
            raise SystemExit("png-palette-trns.png tRNS did not decode as expected: %s" % alphas)

    grey_trns = Image.new("L", (4, 3))
    grey_trns.putdata([0, 2, 5, 9, 2, 3, 2, 15, 1, 2, 7, 2])
    save_pil(grey_trns, "png-grey-trns.png", transparency=2)
    with Image.open(os.path.join(OUT, "png-grey-trns.png")) as im:
        im.load()
        if [im.convert("RGBA").getpixel((x, y))[3] for y in range(3) for x in range(4)] != [
            255, 0, 255, 255, 0, 255, 0, 255, 255, 0, 255, 0
        ]:
            raise SystemExit("png-grey-trns.png colour-key transparency did not decode as expected")

    one = Image.new("RGB", (1, 1))
    one.putdata([(17, 34, 51)])
    save_pil(one, "png-1x1.png")

    # Packed nibbles, hand-written: a 4-bit palette PNG (refused) and a 1-bit grey PNG.
    px4 = [[(x * 3 + y) % 6 for x in range(5)] for y in range(3)]
    rows4 = []
    for row in px4:
        packed = bytearray()
        for i in range(0, len(row), 2):
            hi = row[i] & 0x0F
            lo = (row[i + 1] if i + 1 < len(row) else 0) & 0x0F
            packed.append((hi << 4) | lo)
        rows4.append(bytes(packed))
    write_png(
        os.path.join(OUT, "png-bit4-palette.png"), 5, 3, 4, 3, rows4,
        plte=bytes(c for e in PALETTE4 for c in e),
    )

    px1 = [[(x + y) % 2 for x in range(9)] for y in range(3)]
    rows1 = []
    for row in px1:
        packed = bytearray(2)
        for i, v in enumerate(row):
            if v:
                packed[i // 8] |= 0x80 >> (i % 8)
        rows1.append(bytes(packed))
    write_png(os.path.join(OUT, "png-bit1-grey.png"), 9, 3, 1, 0, rows1)

    # 16-bit grey, hand-written (PIL writes one too, but this pins the exact bit depth).
    rows16 = []
    for y in range(3):
        row = bytearray()
        for x in range(4):
            row += struct.pack(">H", (x * 4096 + y * 8192) & 0xFFFF)
        rows16.append(bytes(row))
    write_png(os.path.join(OUT, "png-16bit-grey.png"), 4, 3, 16, 0, rows16)

    # Interlaced (Adam7) RGB.
    inter = rgb_gradient(5, 5)
    adam7_png(os.path.join(OUT, "png-interlaced-rgb.png"), 5, 5, inter)

    # Rows filtered one way each: 0...4 in order, on every pixel layout the decoder must
    # handle (bpp 1 for grey and palette, 3 for RGB, 4 for RGBA).
    filt_px_rgb = [[((x * 17 + y * 29 + x * y * 3) % 256, (x * 5 + y * 91) % 256, (x * 37 + y * 11) % 256) for x in range(8)] for y in range(5)]
    write_filtered_png(os.path.join(OUT, "png-filter-rgb.png"), 8, 5, 2, filt_px_rgb, 3, [0, 1, 2, 3, 4])
    filt_px_rgba = [[(c, (c * 3) % 256, (c * 7) % 256, 255 - c) for c in row] for row in
                    [[(x * 31 + y * 7) % 256 for x in range(8)] for y in range(5)]]
    write_filtered_png(os.path.join(OUT, "png-filter-rgba.png"), 8, 5, 6, filt_px_rgba, 4, [0, 1, 2, 3, 4])
    filt_px_grey = [[((x * 33 + y * 57) % 256,) for x in range(8)] for y in range(5)]
    write_filtered_png(os.path.join(OUT, "png-filter-grey.png"), 8, 5, 0, filt_px_grey, 1, [0, 1, 2, 3, 4])
    filt_px_pal = [[((x * 3 + y) % 6,) for x in range(8)] for y in range(5)]
    write_filtered_png(os.path.join(OUT, "png-filter-palette.png"), 8, 5, 3, filt_px_pal, 1, [0, 1, 2, 3, 4])

    # A palette with a tRNS shorter than the palette: the tail entries stay opaque.
    pal_short = [[0, 1, 2, 3], [1, 2, 3, 0], [2, 3, 0, 1]]
    rows_short = [bytes(row) for row in pal_short]
    write_png(
        os.path.join(OUT, "png-palette-trns-short.png"), 4, 3, 8, 3, rows_short,
        plte=bytes(c for e in PALETTE4 for c in e), trns=bytes([0, 128]),
    )

    # Malformed variants derived from a known-good file: a flipped IDAT byte (bad CRC and a
    # broken stream), a truncation, and a wrong signature.
    src = open(os.path.join(OUT, "png-rgb-24x16.png"), "rb").read()
    bad_crc = bytearray(src)
    bad_crc[len(bad_crc) // 2] ^= 0xFF
    open(os.path.join(OUT, "png-malformed-crc.png"), "wb").write(bytes(bad_crc))
    open(os.path.join(OUT, "png-malformed-truncated.png"), "wb").write(src[: len(src) - 24])
    bad_sig = bytearray(src)
    bad_sig[1] ^= 0x01
    open(os.path.join(OUT, "png-malformed-signature.png"), "wb").write(bytes(bad_sig))

    decodable = [
        "png-rgb-24x16.png",
        "png-rgb-240x160.png",
        "png-rgba-9x7.png",
        "png-grey-16x5.png",
        "png-palette-trns.png",
        "png-palette-trns-short.png",
        "png-grey-trns.png",
        "png-1x1.png",
        "png-filter-rgb.png",
        "png-filter-rgba.png",
        "png-filter-grey.png",
        "png-filter-palette.png",
    ]
    for name in decodable:
        path = os.path.join(OUT, name)
        with Image.open(path) as im:
            im.load()
            width, height = im.size
            mode = im.mode
            rgba = rgba_of(im)
        assert len(rgba) == width * height * 4, (name, len(rgba), width, height)
        entry = {
            "width": width,
            "height": height,
            "mode": mode,
            "bytes": size_of(name),
            "rgbaSha256": sha(rgba),
            "rowFilters": png_row_filters(path, width, height),
            "spots": spots([[rgba[i : i + 4] for i in range(0, len(rgba), 4)]], width),
        }
        if width * height <= 64:
            entry["rgba"] = [list(rgba[i : i + 4]) for i in range(0, len(rgba), 4)]
        png_expect[name] = entry

    # The hand-written files must decode back to exactly what they were built from.
    def assert_roundtrip(name, pixels):
        """The hand-written file is a fixture only if PIL decodes it back to the pattern."""
        with Image.open(os.path.join(OUT, name)) as im:
            im.load()
            got = im.convert("RGBA")
            for y, row in enumerate(pixels):
                for x, px in enumerate(row):
                    if len(px) == 1:
                        want = [px[0], px[0], px[0], 255]
                    elif len(px) == 3:
                        want = list(px) + [255]
                    else:
                        want = list(px)
                    if list(got.getpixel((x, y))) != want:
                        notes.append("ROUNDTRIP MISMATCH %s at (%d,%d): PIL %s want %s"
                                     % (name, x, y, got.getpixel((x, y)), want))
                        return False
        return True

    if not assert_roundtrip("png-filter-rgb.png", filt_px_rgb):
        raise SystemExit("png-filter-rgb.png did not round-trip through PIL")
    if not assert_roundtrip("png-filter-rgba.png", filt_px_rgba):
        raise SystemExit("png-filter-rgba.png did not round-trip through PIL")
    if not assert_roundtrip("png-filter-grey.png", filt_px_grey):
        raise SystemExit("png-filter-grey.png did not round-trip through PIL")
    # a 1-bit grey sample is 0 or 255 after PNG's bit-depth expansion, not 0 or 1
    if not assert_roundtrip("png-bit1-grey.png", [[(255 if v else 0,) for v in row] for row in px1]):
        raise SystemExit("png-bit1-grey.png did not round-trip through PIL")
    if not assert_roundtrip("png-interlaced-rgb.png", inter):
        raise SystemExit("png-interlaced-rgb.png did not round-trip through PIL")
    with Image.open(os.path.join(OUT, "png-filter-palette.png")) as im:
        im.load()
        if [im.convert("RGB").getpixel((x, y)) for y in range(5) for x in range(8)] != [
            PALETTE4[filt_px_pal[y][x][0]] for y in range(5) for x in range(8)
        ]:
            raise SystemExit("png-filter-palette.png did not round-trip through PIL")
    with Image.open(os.path.join(OUT, "png-palette-trns-short.png")) as im:
        im.load()
        alphas = [im.convert("RGBA").getpixel((x, y))[3] for y in range(3) for x in range(4)]
        if alphas != [0, 128, 255, 255, 128, 255, 255, 0, 255, 255, 0, 128]:
            raise SystemExit("png-palette-trns-short.png tRNS did not decode as expected: %s" % alphas)
    with Image.open(os.path.join(OUT, "png-16bit-grey.png")) as im:
        im.load()
        if im.size != (4, 3) or "16" not in repr(im.mode) and im.mode != "I":
            raise SystemExit("png-16bit-grey.png did not decode as 16-bit: %s %s" % (im.size, im.mode))
        notes.append("png-16bit-grey.png: PIL reads it as mode %s" % im.mode)
    with Image.open(os.path.join(OUT, "png-bit4-palette.png")) as im:
        im.load()
        if [im.convert("RGB").getpixel((x, y)) for y in range(3) for x in range(5)] != [
            PALETTE4[px4[y][x]] for y in range(3) for x in range(5)
        ]:
            raise SystemExit("png-bit4-palette.png did not round-trip through PIL")

    png_expect_refuse = {
        "png-16bit-grey.png": {"width": 4, "height": 3, "reasonMustMatch": "16-bit"},
        "png-bit4-palette.png": {"width": 5, "height": 3, "reasonMustMatch": "4-bit"},
        "png-palette-4bit.png": {"width": 5, "height": 4, "reasonMustMatch": "4-bit"},
        "png-bit1-grey.png": {"width": 9, "height": 3, "reasonMustMatch": "1-bit"},
        "png-interlaced-rgb.png": {"width": 5, "height": 5, "reasonMustMatch": "interlac"},
        "png-malformed-crc.png": {"reasonMustMatch": "CRC"},
        "png-malformed-truncated.png": {"reasonMustMatch": "truncat"},
        "png-malformed-signature.png": {"reasonMustMatch": "signature"},
    }

    png_out = {
        "generator": "tools/gen-image-fixtures.py",
        "pillow": PIL_VERSION,
        "oracle": "PIL decode via Image.open(...).convert('RGBA'); rgbaSha256 hashes those bytes. "
                  "rowFilters are the fixture's own filter bytes (they pin which filter the decoder met).",
        "decode": png_expect,
        "refuse": png_expect_refuse,
        "encode": {
            "png-rgb-24x16.png": {"alpha": False, "pilBytes": size_of("png-rgb-24x16.png"),
                                  "rgbaSha256": png_expect["png-rgb-24x16.png"]["rgbaSha256"]},
            "png-rgba-9x7.png": {"alpha": True, "pilBytes": size_of("png-rgba-9x7.png"),
                                 "rgbaSha256": png_expect["png-rgba-9x7.png"]["rgbaSha256"]},
            "png-rgb-240x160.png": {"alpha": False, "pilBytes": size_of("png-rgb-240x160.png"),
                                    "rgbaSha256": png_expect["png-rgb-240x160.png"]["rgbaSha256"]},
        },
    }
    notes.append("PIL's own PNG encoder on png-rgb-24x16.png uses filters %s"
                 % png_expect["png-rgb-24x16.png"]["rowFilters"])

    # ============================== resample group ==============================

    sources = {}

    def rs_source(name, pixels, width, height, seed_note):
        img = Image.new("RGBA", (width, height))
        img.putdata([px for row in pixels for px in row])
        save_pil(img, name + ".png")
        raw = rgba_of(img)
        with open(os.path.join(OUT, name + ".rgba"), "wb") as fh:
            fh.write(raw)
        sources[name] = {"width": width, "height": height, "rgbaSha256": sha(raw), "note": seed_note}
        return img

    small = rgba_noise(16, 12, 7)
    small_img = rs_source("rs-small-16x12", small, 16, 12, "pseudo-random RGBA with an alpha ramp")
    # An opaque source for the cases whose oracle is PIL's own resize: Pillow premultiplies
    # alpha before a non-nearest resize, so only an opaque image is a clean BOX oracle.
    opaque = rgb_noise(16, 12, 23)
    opaque_img = Image.new("RGB", (16, 12))
    opaque_img.putdata([px for row in opaque for px in row])
    save_pil(opaque_img, "rs-opaque-16x12.png")
    with open(os.path.join(OUT, "rs-opaque-16x12.rgba"), "wb") as fh:
        fh.write(rgba_of(opaque_img))
    sources["rs-opaque-16x12"] = {"width": 16, "height": 12, "rgbaSha256": sha(rgba_of(opaque_img)),
                                  "note": "opaque RGB noise (alpha 255): PIL's BOX is an exact oracle here"}
    nonint = rgba_noise(25, 17, 11)
    rs_source("rs-nonint-25x17", nonint, 25, 17, "pseudo-random RGBA, non-integer downscale")
    tall = [[nonint[y][x] for y in range(17)] for x in range(25)]  # 17x25 transpose of the same noise
    rs_source("rs-tall-17x25", tall, 17, 25, "transpose of rs-nonint, non-integer vertical downscale")
    wide = rgba_noise(2000, 8, 13)
    rs_source("rs-wide-2000x8", wide, 2000, 8, "pseudo-random RGBA, wide and thin")

    cases = []

    def pil_crop_case(src_pixels, rect, sw, sh, name, src):
        x, y, w, h = rect
        expect = [row[x : x + w] for row in src_pixels[y : y + h]]
        cases.append({
            "name": name, "src": src, "rect": rect, "targetMaxSide": 1024,
            "width": w, "height": h, "scale": 1, "oracle": "pil-crop",
            "rgbaSha256": sha(flat(expect)),
            "rgba": [list(px) for row in expect for px in row] if w * h <= 128 else None,
            "spots": spots(expect, w) if w * h > 128 else None,
        })

    pil_crop_case(small, [2, 3, 8, 6], 16, 12, "rs-small crop 8x6 (PIL crop)", "rs-small-16x12")

    # An integer factor is where PIL's own box reduction is exactly the area average, so this
    # case is checked pixel for pixel against PIL's output (`Image.reduce`). `Image.resize(BOX)`
    # is recorded too and agrees within +-1: Pillow's resampler two-passes through 8-bit
    # intermediates, which is a rounding of its own, not a different filter.
    box = opaque_img.reduce(4)
    box_pixels = [[box.getpixel((x, y)) for x in range(4)] for y in range(3)]
    exact_pixels = area_resample(opaque, 16, 12, 4, 3)
    if [tuple(p) for row in box_pixels for p in row] != [tuple(p) for row in exact_pixels for p in row]:
        raise SystemExit("PIL reduce and the exact area oracle disagree on rs-opaque-16x12")
    resize_box = opaque_img.resize((4, 3), Image.BOX).convert("RGB").tobytes()
    diff_resize = max(
        (abs(a - b) for a, b in zip(resize_box, flat(exact_pixels))), default=0
    )
    if diff_resize > 1:
        raise SystemExit("PIL resize(BOX) is off the exact average by more than 1: %d" % diff_resize)
    notes.append("rs-opaque 16x12 -> 4x3: PIL reduce == the exact area average (pixel for pixel); "
                 "PIL resize(BOX) stays within +-1 (%d)" % diff_resize)
    cases.append({
        "name": "rs-opaque 16x12 -> 4x3 (scale 0.25, integer factor)",
        "src": "rs-opaque-16x12", "rect": None, "targetMaxSide": 4,
        "width": 4, "height": 3, "scale": 0.25, "oracle": "pil-reduce (PIL's own box reduction)",
        "rgbaSha256": sha(flat(box_pixels)), "rgba": [list(p) for row in box_pixels for p in row],
    })
    # A whole-image call with no rect and nothing to do: identity, scale 1.
    cases.append({
        "name": "rs-small 16x12, no rect, target 1024 -> untouched", "src": "rs-small-16x12", "rect": None,
        "targetMaxSide": 1024, "width": 16, "height": 12, "scale": 1, "oracle": "identity (same source bytes)",
        "rgbaSha256": sources["rs-small-16x12"]["rgbaSha256"], "rgba": None,
    })

    def exact_case(name, src, src_pixels, rect, target, oracle_note):
        x, y, w, h = rect
        crop = [row[x : x + w] for row in src_pixels[y : y + h]]
        dw, dh, scale = dst_dims(w, h, target)
        expect = area_resample(crop, w, h, dw, dh)
        entry = {
            "name": "%s (scale %s)" % (name, ("%g" % scale)), "src": src, "rect": rect,
            "targetMaxSide": target, "width": dw, "height": dh, "scale": scale,
            "oracle": oracle_note, "rgbaSha256": sha(flat(expect)),
        }
        if dw * dh <= 128:
            entry["rgba"] = [list(p) for row in expect for p in row]
        else:
            entry["spots"] = spots(expect, dw)
        cases.append(entry)
        return expect

    n25 = exact_case("rs-nonint 25x17 -> target 10", "rs-nonint-25x17", nonint, [0, 0, 25, 17], 10,
                     "exact area average (python integer weights)")
    t17 = exact_case("rs-tall 17x25 -> target 10", "rs-tall-17x25", tall, [0, 0, 17, 25], 10,
                     "exact area average (python integer weights)")
    w2000 = exact_case("rs-wide 2000x8 -> target 1024", "rs-wide-2000x8", wide, [0, 0, 2000, 8], 1024,
                       "exact area average (python integer weights)")
    c25 = exact_case("rs-nonint crop 25x17 rect(3,2,20,13) -> target 10", "rs-nonint-25x17", nonint,
                     [3, 2, 20, 13], 10, "exact area average (python integer weights)")

    # A non-integer factor with an opaque source, where PIL's BOX is a plain whole-pixel box
    # average: recorded (not asserted) so the JSON says why those cases do not use PIL.
    box11 = opaque_img.resize((11, 8), Image.BOX).convert("RGB").tobytes()
    exact11 = flat([[(p[0], p[1], p[2]) for p in row] for row in area_resample(opaque, 16, 12, 11, 8)])
    diff11 = sum(1 for a, b in zip(box11, exact11) if a != b)
    notes.append("rs-opaque 16x12 -> 11x8 (scale 0.6875): PIL BOX differs from the exact area average in "
                 "%d/264 channels (BOX averages whole source pixels, area weights them by coverage)" % diff11)
    if diff11 == 0:
        raise SystemExit("no BOX/area difference at a non-integer factor: pick noisier content")
    notes.append("rs-nonint 25x17 -> 10x7: the oracle is the exact area average, not PIL (BOX plus Pillow's "
                 "premultiplied alpha would differ; also see the case list)")
    notes.append("n25=%d t17=%d c25=%d channels computed with exact integer weights"
                 % (len(flat(n25)), len(flat(t17)), len(flat(c25))))

    rs_out = {
        "generator": "tools/gen-image-fixtures.py",
        "pillow": PIL_VERSION,
        "oracle": "cases tagged pil-crop / pil-box are PIL's own output; exact-area(py) is an integer-weight "
                  "area average computed here (BOX is only an approximation at a non-integer factor).",
        "sources": sources,
        "cases": cases,
    }

    # ============================== transform group ==============================

    tm_files = {}

    tm_small = rgba_ramp(40, 30)
    tm_small_img = Image.new("RGBA", (40, 30))
    tm_small_img.putdata([px for row in tm_small for px in row])
    save_pil(tm_small_img, "tm-small-40x30.png")
    tm_files["tm-small-40x30.png"] = {"mime": "image/png", "width": 40, "height": 30}

    tm_wide_w, tm_wide_h = 2000, 8
    tm_wide = [[((x * 7 + y * 3) % 256, (x * 3) % 256, (x + y * 40) % 256, 255 - (x * 255 // 2000) // 3)
                for x in range(tm_wide_w)] for y in range(tm_wide_h)]
    tm_wide_img = Image.new("RGBA", (tm_wide_w, tm_wide_h))
    tm_wide_img.putdata([px for row in tm_wide for px in row])
    save_pil(tm_wide_img, "tm-wide-2000x8.png")
    tm_files["tm-wide-2000x8.png"] = {"mime": "image/png", "width": tm_wide_w, "height": tm_wide_h}

    tm_tall_w, tm_tall_h = 600, 1500
    tm_tall = [[((x * 5) % 256, (y * 11) % 256, (x * 13 + y * 3) % 256, 255)
                for x in range(tm_tall_w)] for y in range(tm_tall_h)]
    tm_tall_img = Image.new("RGB", (tm_tall_w, tm_tall_h))
    tm_tall_img.putdata([(px[0], px[1], px[2]) for row in tm_tall for px in row])
    save_pil(tm_tall_img, "tm-tall-600x1500.png")
    tm_files["tm-tall-600x1500.png"] = {"mime": "image/png", "width": tm_tall_w, "height": tm_tall_h}

    # A photo-like noisy image (1400x120): its pixels barely compress, so the PNG is ~300 KB
    # and a 1024x88 downscale of it is smaller -- that is the evidence a downscale CAN pay for
    # itself, and it is the fixture the shrinking path is asserted on.
    tm_noisy_w, tm_noisy_h = 1400, 120
    # Four channels with a fully opaque alpha, like every other transform expectation: the
    # oracle is hashed over RGBA (a decoded buffer), so a 3-tuple pattern would hash differently
    # for an image whose pixels are identical.
    tm_noisy = [[((x * 37 + y * 53 + (x * y) % 251) % 256,
                  (x * 11 + y * 97 + (x * x) % 241) % 256,
                  (x * 5 + y * 3 + (y * y) % 239) % 256, 255) for x in range(tm_noisy_w)]
                for y in range(tm_noisy_h)]
    tm_noisy_img = Image.new("RGBA", (tm_noisy_w, tm_noisy_h))
    tm_noisy_img.putdata([px for row in tm_noisy for px in row])
    save_pil(tm_noisy_img, "tm-noisy-1400x120.png")
    tm_files["tm-noisy-1400x120.png"] = {"mime": "image/png", "width": tm_noisy_w, "height": tm_noisy_h}

    # JPEG: a smooth photo-like gradient (small file), baseline and progressive.
    photo = Image.new("RGB", (1200, 800))
    photo.putdata([((x * 255 // 1199), (y * 255 // 799), (x * 3 + y * 5) % 256) for y in range(800) for x in range(1200)])
    photo.save(os.path.join(OUT, "tm-photo-1200x800.jpg"), "JPEG", quality=70)
    photo.save(os.path.join(OUT, "tm-photo-1200x800-progressive.jpg"), "JPEG", quality=70, progressive=True)
    photo.resize((300, 200)).save(os.path.join(OUT, "tm-webp-300x200.webp"), "WEBP", quality=70)
    tm_files["tm-photo-1200x800.jpg"] = {"mime": "image/jpeg", "width": 1200, "height": 800}
    tm_files["tm-photo-1200x800-progressive.jpg"] = {"mime": "image/jpeg", "width": 1200, "height": 800, "progressive": True}
    tm_files["tm-webp-300x200.webp"] = {"mime": "image/webp", "width": 300, "height": 200}

    gif_frames = [Image.new("P", (8, 8), 0), Image.new("P", (8, 8), 1)]
    gif_frames[0].save(os.path.join(OUT, "tm-anim-8x8.gif"), "GIF", save_all=True,
                       append_images=gif_frames[1:], duration=100, loop=0)
    tm_files["tm-anim-8x8.gif"] = {"mime": "image/gif", "width": 8, "height": 8}

    # 16-bit / interlaced / malformed PNGs: the transform must pass them through.
    rows16b = []
    for y in range(6):
        row = bytearray()
        for x in range(5):
            row += struct.pack(">HHH", (x * 8000) & 0xFFFF, (y * 12000) & 0xFFFF, ((x + y) * 4000) & 0xFFFF)
        rows16b.append(bytes(row))
    write_png(os.path.join(OUT, "tm-16bit-rgb.png"), 5, 6, 16, 2, rows16b)
    tm_files["tm-16bit-rgb.png"] = {"mime": "image/png", "width": 5, "height": 6, "unsupported": "16-bit"}
    with Image.open(os.path.join(OUT, "tm-16bit-rgb.png")) as im:
        im.load()
        notes.append("tm-16bit-rgb.png: PIL reads it as %s %s" % (im.mode, im.size))

    inter2 = rgb_gradient(9, 7)
    adam7_png(os.path.join(OUT, "tm-interlaced-rgb.png"), 9, 7, inter2)
    tm_files["tm-interlaced-rgb.png"] = {"mime": "image/png", "width": 9, "height": 7, "unsupported": "interlaced"}
    with Image.open(os.path.join(OUT, "tm-interlaced-rgb.png")) as im:
        im.load()
        if im.size != (9, 7):
            raise SystemExit("tm-interlaced-rgb.png did not decode through PIL")

    good = open(os.path.join(OUT, "tm-small-40x30.png"), "rb").read()
    broken = bytearray(good)
    broken[len(broken) // 2] ^= 0x5A
    open(os.path.join(OUT, "tm-malformed.png"), "wb").write(bytes(broken))
    # The flipped byte is in the IDAT: the header is intact, so its size is still readable
    # even though the file is not (that is the whole reason the tool may report a source size
    # for a file it is about to pass through).
    tm_files["tm-malformed.png"] = {"mime": "image/png", "width": 40, "height": 30, "unsupported": "corrupt"}

    tm_cases = []

    def tm_resize_case(label, src, pixels, rect, sw, sh):
        """A case whose destination pixels are the exact area average of the kept region."""
        x, y, w, h = rect or [0, 0, sw, sh]
        crop = [row[x : x + w] for row in pixels[y : y + h]]
        dw, dh, scale = dst_dims(w, h, 1024)
        tm_cases.append({"name": label, "src": src, "rect": rect, "expectChanged": True,
                         "width": dw, "height": dh, "scale": scale,
                         "rgbaSha256": sha(flat(area_resample(crop, w, h, dw, dh))),
                         "oracle": "exact area average (python integer weights) over the kept region"})

    # small image, no rect: byte-identical passthrough ("nothing to do")
    tm_cases.append({"name": "tm-small 40x30, no rect -> byte-identical", "src": "tm-small-40x30.png",
                     "rect": None, "expectChanged": False, "width": 40, "height": 30})
    # crop only (still inside the target)
    crop = [row[10:30] for row in tm_small[5:20]]
    tm_cases.append({"name": "tm-small crop rect(10,5,20,15) -> 20x15, scale 1", "src": "tm-small-40x30.png",
                     "rect": [10, 5, 20, 15], "expectChanged": True, "width": 20, "height": 15, "scale": 1,
                     "rgbaSha256": sha(flat(crop)), "oracle": "PIL crop (pixels unchanged)"})

    # The downscale that pays for itself: photo-like pixels, so the source PNG (300 KB) is far
    # bigger than the resampled one. This is what keeps the transform ITSELF covered now that
    # the two flat fixtures below are dropped by the size clamp.
    tm_resize_case("tm-noisy 1400x120, no rect (a downscale that shrinks)", "tm-noisy-1400x120.png",
                   tm_noisy, None, tm_noisy_w, tm_noisy_h)

    # A downscale that would GROW the upload. These fixtures are flat/compressible (and the
    # JPEG is small and lossy), so the re-encode is several times the source; the contract is
    # then that the original bytes go up unchanged, because the endpoint resizes to ~800x800
    # itself -- the model sees the same thing either way and only the bytes differ.
    def tm_grow_case(label, src, sw, sh):
        tm_cases.append({"name": label, "src": src, "rect": None, "expectChanged": False,
                         "width": sw, "height": sh, "sourceWidth": sw, "sourceHeight": sh,
                         "reasonMustMatch": "the re-encode would not have been smaller",
                         "oracle": "the source's own bytes (the re-encode was discarded)"})

    tm_grow_case("tm-tall 600x1500, no rect (the re-encode would be 5x bigger)",
                 "tm-tall-600x1500.png", tm_tall_w, tm_tall_h)
    tm_grow_case("tm-wide 2000x8, no rect (the re-encode would be 3x bigger)",
                 "tm-wide-2000x8.png", tm_wide_w, tm_wide_h)
    tm_grow_case("tm-photo small baseline JPEG, no rect (a PNG re-encode would be 10x bigger)",
                 "tm-photo-1200x800.jpg", 1200, 800)

    # ... and a `rect` is never dropped that way: the crop is what the model asked for, so a
    # cropped result comes back even when it is bigger than the file it came from.
    tm_resize_case("tm-wide rect(0,0,2000,8) (the whole image: a rect is not dropped)",
                   "tm-wide-2000x8.png", tm_wide, [0, 0, 2000, 8], 2000, 8)
    tm_resize_case("tm-wide rect(500,0,1500,8) (crop + downscale)", "tm-wide-2000x8.png", tm_wide,
                   [500, 0, 1500, 8], 2000, 8)
    tm_cases.append({"name": "tm-tall rect(100,200,500,800) (a crop bigger than the source file)",
                     "src": "tm-tall-600x1500.png", "rect": [100, 200, 500, 800], "expectChanged": True,
                     "width": 500, "height": 800, "scale": 1,
                     "rgbaSha256": sha(flat([row[100:600] for row in tm_tall[200:1000]])),
                     "oracle": "PIL crop (pixels unchanged)"})
    # A JPEG under a rect is still transformed (and comes back as PNG). Its pixels are our
    # decode of a lossy file, so only the size, the mime and re-decodability are asserted.
    tm_cases.append({"name": "tm-photo baseline JPEG rect(100,50,600,400) (a crop is kept)",
                     "src": "tm-photo-1200x800.jpg", "rect": [100, 50, 600, 400],
                     "expectChanged": True, "width": 600, "height": 400, "scale": 1,
                     "sourceWidth": 1200, "sourceHeight": 800,
                     "oracle": "no pixel oracle: a lossy decode is not reproducible byte for byte"})
    tm_cases.append({"name": "tm-photo progressive JPEG (A2 refuses progressive)", "src": "tm-photo-1200x800-progressive.jpg",
                     "rect": None, "expectChanged": False, "sourceWidth": 1200, "sourceHeight": 800})
    tm_cases.append({"name": "tm-anim GIF passes through", "src": "tm-anim-8x8.gif", "rect": None, "expectChanged": False})
    tm_cases.append({"name": "tm-webp passes through", "src": "tm-webp-300x200.webp", "rect": None, "expectChanged": False})
    tm_cases.append({"name": "tm-16bit-rgb passed through, size still read", "src": "tm-16bit-rgb.png",
                     "rect": None, "expectChanged": False, "sourceWidth": 5, "sourceHeight": 6})
    tm_cases.append({"name": "tm-interlaced-rgb passed through, size still read", "src": "tm-interlaced-rgb.png",
                     "rect": None, "expectChanged": False, "sourceWidth": 9, "sourceHeight": 7})
    tm_cases.append({"name": "tm-malformed passed through", "src": "tm-malformed.png",
                     "rect": None, "expectChanged": False})

    # Whether a no-rect downscale is worth uploading is a byte count, and only the real codec
    # can answer it: these numbers are therefore NOTES, not assertions. PIL's BOX resize is not
    # even a proxy for the pixels here -- at a non-integer factor it averages whole source pixels
    # instead of weighting them by coverage, and on tm-tall's modulo sawtooths that smooths the
    # result by up to 138 per channel (our resample matches the exact-area oracle byte for byte,
    # which the guards check). The guards assert the real sizes of OUR encoder's output.
    def pil_downscale_png_bytes(img, sw, sh):
        dw, dh, _ = dst_dims(sw, sh, 1024)
        buf = io.BytesIO()
        img.resize((dw, dh), Image.BOX).save(buf, "PNG", compress_level=9)
        return len(buf.getvalue())

    downsized = {
        "tm-tall-600x1500.png": pil_downscale_png_bytes(tm_tall_img, tm_tall_w, tm_tall_h),
        "tm-wide-2000x8.png": pil_downscale_png_bytes(tm_wide_img, tm_wide_w, tm_wide_h),
        "tm-photo-1200x800.jpg": pil_downscale_png_bytes(photo, 1200, 800),
        "tm-noisy-1400x120.png": pil_downscale_png_bytes(tm_noisy_img, tm_noisy_w, tm_noisy_h),
    }
    for name in sorted(downsized):
        notes.append("%s: source %d B, PIL's BOX of the downscale %d B (a reference only - the "
                     "guards assert our own encoder's bytes)"
                     % (name, size_of(name), downsized[name]))

    tm_out = {
        "generator": "tools/gen-image-fixtures.py",
        "pillow": PIL_VERSION,
        "oracle": "result pixels are the exact integer-weight area average of the crop; a crop-only case is a "
                  "PIL crop. The result bytes are our own PNG, so the guard decodes them with decodePng "
                  "(itself PIL-anchored by check-png). expectChanged false + reasonMustMatch means the input "
                  "bytes come back verbatim: either there was nothing to do, or the re-encode would not have "
                  "been smaller than the source and was discarded (that second rule only applies with no rect).",
        "files": tm_files,
        "cases": tm_cases,
    }

    with open(os.path.join(OUT, "expect-png.json"), "w", encoding="utf-8") as fh:
        json.dump(png_out, fh, indent=1)
        fh.write("\n")
    with open(os.path.join(OUT, "expect-resample.json"), "w", encoding="utf-8") as fh:
        json.dump(rs_out, fh, indent=1)
        fh.write("\n")
    with open(os.path.join(OUT, "expect-image.json"), "w", encoding="utf-8") as fh:
        json.dump(tm_out, fh, indent=1)
        fh.write("\n")

    print("wrote %d files to %s (Pillow %s)" % (len(os.listdir(OUT)), OUT, PIL_VERSION))
    for line in notes:
        print("  note: " + line)


if __name__ == "__main__":
    main()
