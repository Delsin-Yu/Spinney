/*
 * check-resample — `cropResample`'s arithmetic, as a build-time guard
 * (`src/agent/imageResample.ts`, `docs/agents/plans/image-budget.md` §1–§3, §6).
 *
 * WHY IT EXISTS
 * The transform decides what the model actually sees: `read_image` crops to an optional
 * `rect` and downscales to `IMAGE_TARGET_MAX_SIDE` BEFORE the upload, so a wrong weight, a
 * silently-upscaled frame or an alpha channel dropped by an "optimisation" is invisible
 * until the model describes an image that is not there — and then it reads as a
 * hallucination, not as a bug. Three properties carry that promise:
 *
 *  - the downscale is an EXACT area average with integer coverage weights, so a
 *    non-integer factor (0.4, 0.512) can be compared PIXEL FOR PIXEL against an
 *    independent tool. PIL's BOX is only an approximation at a non-integer factor (it
 *    averages whole source pixels, not the region a destination pixel covers), so the
 *    fixtures' oracle is a separate integer-weight implementation written in Python, plus
 *    one case that is PIL's own `Image.reduce` at an integer factor (where BOX and the
 *    exact average coincide);
 *  - it never upscales: a crop that already fits comes back as it is, with `scale === 1`,
 *    because upscaling adds bytes without adding information;
 *  - the result never aliases the caller's buffer, a crop is byte-for-byte the source
 *    region, and a rect that hangs off the edge is clamped rather than read out of range.
 *
 * The 2x2, 3x3 and half-up expectations below are the ones written out by hand in this
 * file; the other synthetic cases are arithmetic over buffers built here (no fixtures), and
 * the section-1 cases are the fixtures' own hashes.
 *
 * HOW: plain node over `out/` (run `npm run compile` first). Every fixture read is a raw
 * PIL-produced RGBA file whose sha256 is asserted against `expect-resample.json` before it
 * is used, so the anchor is the file, not this guard. Paths are resolved from `__dirname`
 * (repo root = `path.join(__dirname, '..')`).
 *
 * Run: npm run check:resample   /   node tools/check-resample.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures', 'image');

// A missing `out/` is the one failure worth spelling out: every other line this guard prints
// is about arithmetic, and a raw MODULE_NOT_FOUND stack would read like a bug in it.
let R;
try {
  R = require(path.join(ROOT, 'out', 'agent', 'imageResample.js'));
} catch (e) {
  console.log('check-resample: crop + exact area average');
  console.log('');
  console.log(`FAIL check-resample: cannot load out/agent/imageResample.js (${e.message}) — run \`npm run compile\` first`);
  process.exit(1);
}

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label + (detail ? ' — ' + detail : ''));
  }
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// A throw (a module that changed shape, a fixture that moved) is still a failed guard, so it
// gets the same one-line verdict as a failed check instead of a stack trace.
process.on('uncaughtException', (e) => {
  console.log('');
  console.log(`FAIL check-resample: harness error — ${e && e.stack ? e.stack.split('\n')[0] : String(e)}`);
  process.exit(1);
});
const show = (data, i, n) => '[' + Array.from({ length: n }, (_, c) => data[i * 4 + c]).join(',') + ']';
const where = (i, width) => `pixel ${i} (x ${i % width}, y ${Math.floor(i / width)})`;

/** The first pixel of `data` that differs from `want` (a flat list of channel tuples). */
function firstPixelDiff(data, want, width, channels) {
  for (let i = 0; i < want.length; i++) {
    for (let c = 0; c < channels; c++) {
      if (data[i * 4 + c] !== want[i][c]) {
        return `${where(i, width)}: got ${show(data, i, channels)} want [${want[i].slice(0, channels).join(',')}]`;
      }
    }
  }
  return undefined;
}

/** A flat list of channel tuples → the bytes a hash can be taken over. */
function flatten(pixels, channels) {
  const out = Buffer.alloc(pixels.length * channels);
  let o = 0;
  for (const p of pixels) for (let c = 0; c < channels; c++) out[o++] = p[c];
  return out;
}

/** A synthetic RGBA image from a per-pixel function, so one case reads as one line. */
function makeImage(width, height, fn) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = fn(x, y);
      const o = (y * width + x) * 4;
      data[o] = p[0];
      data[o + 1] = p[1];
      data[o + 2] = p[2];
      data[o + 3] = p[3];
    }
  }
  return { width, height, data };
}

/** The sub-rectangle of an image, the way the guard would copy it itself. */
function subImage(img, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

// ---------------------------------------------------------------- the call ledger
// Every call goes through `resample`, so the shape invariants (exact byte count, 0 < scale
// <= 1, no aliasing, source untouched) are proven for every case at once rather than
// restated per case.
const calls = [];
let callNo = 0;
function resample(img, rect, targetMaxSide, label, mutatedByGuard) {
  const before = Buffer.from(img.data);
  const res = R.cropResample(img, rect, targetMaxSide);
  calls.push({ no: ++callNo, label, img, before, res, mutatedByGuard: !!mutatedByGuard });
  return res;
}

/**
 * The frozen formula transcribed literally: for every destination pixel, every source
 * pixel, both axes, straight from the plan text — no cached windows, and not one line
 * shared with the module. It answers the cases that have neither a fixture nor a
 * hand-computed expectation; section 1 is what proves this oracle itself right (its hashes
 * must equal the Python/PIL hashes in the JSON before it is used on synthetic input).
 * `rect` is assumed already clamped: the module's clamp is checked against itself.
 */
function slowAreaAverage(img, rect, targetMaxSide) {
  const cx = rect ? rect.x : 0;
  const cy = rect ? rect.y : 0;
  const w = rect ? rect.w : img.width;
  const h = rect ? rect.h : img.height;
  const scale = Math.min(1, targetMaxSide / Math.max(w, h));
  const dw = Math.max(1, Math.floor(w * scale + 0.5));
  const dh = Math.max(1, Math.floor(h * scale + 0.5));
  const out = new Uint8Array(dw * dh * 4);
  const den = w * h;
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      const acc = [0, 0, 0, 0];
      for (let k = 0; k < h; k++) {
        const wy = Math.max(0, Math.min((k + 1) * dh, (j + 1) * h) - Math.max(k * dh, j * h));
        if (!wy) continue;
        for (let c = 0; c < w; c++) {
          const wx = Math.max(0, Math.min((c + 1) * dw, (i + 1) * w) - Math.max(c * dw, i * w));
          if (!wx) continue;
          const p = ((cy + k) * img.width + cx + c) * 4;
          const wt = wx * wy;
          for (let ch = 0; ch < 4; ch++) acc[ch] += wt * img.data[p + ch];
        }
      }
      const o = (j * dw + i) * 4;
      for (let ch = 0; ch < 4; ch++) out[o + ch] = Math.round(acc[ch] / den);
    }
  }
  return { width: dw, height: dh, data: out, scale };
}

/** A `width x height` image whose every pixel is the same RGBA value. */
const constant = (width, height, px) => makeImage(width, height, () => px);

console.log('check-resample: crop + exact area average (fixtures: PIL and an independent oracle)');

// ================================================================ 1. the fixtures
let spec;
try {
  spec = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expect-resample.json'), 'utf8'));
} catch (e) {
  console.log(`FAIL check-resample: cannot read tools/fixtures/image/expect-resample.json (${e.message})`);
  process.exit(1);
}
const sourceCache = new Map();

console.log('-- the anchors: each .rgba file must be what the JSON recorded --');
for (const name of Object.keys(spec.sources)) {
  const meta = spec.sources[name];
  const file = path.join(FIXTURES, name + '.rgba');
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    ok(`anchor ${name}`, false, 'cannot read ' + file + ' (' + e.message + ')');
    continue;
  }
  const hash = sha256(bytes);
  const sizeOk = bytes.length === meta.width * meta.height * 4;
  ok(
    `anchor ${name}: sha256 of the .rgba file matches the JSON`,
    hash === meta.rgbaSha256 && sizeOk,
    `${meta.width}x${meta.height}, ${bytes.length} bytes, sha256 ${hash.slice(0, 16)}…${sizeOk ? '' : ' (length != w*h*4)'}`,
  );
  sourceCache.set(name, { width: meta.width, height: meta.height, data: bytes });
}
const sourceOf = (name) => sourceCache.get(name);

console.log('-- the guard\'s own slow oracle reproduces the fixture hashes --');
{
  // Before the oracle is trusted on synthetic input, it must agree with the Python/PIL
  // expectations. The 2000-wide sheet is skipped: 65 M literal pair steps for no extra
  // information, since its expected bytes are compared below anyway.
  const bad = [];
  let checked = 0;
  for (const c of spec.cases) {
    const src = sourceOf(c.src);
    if (!src) continue;
    // The largest fixture case is the 2000x8 sheet (4 096 destination pixels); with the
    // mostly-empty windows the literal double loop still finishes in a fraction of a second.
    const rect = c.rect ? { x: c.rect[0], y: c.rect[1], w: c.rect[2], h: c.rect[3] } : undefined;
    const channels = c.rgba ? c.rgba[0].length : c.spots ? c.spots[0].length - 1 : 4;
    const slow = slowAreaAverage(src, rect, c.targetMaxSide);
    const hex = sha256(Buffer.from(slow.data));
    checked++;
    if (slow.width !== c.width || slow.height !== c.height) bad.push(`${c.name}: dims ${slow.width}x${slow.height} != ${c.width}x${c.height}`);
    else if (channels === 4 && hex !== c.rgbaSha256) bad.push(`${c.name}: sha256 ${hex.slice(0, 12)}… != ${c.rgbaSha256.slice(0, 12)}…`);
  }
  ok(
    'the slow oracle reproduces every fixture case it was run on',
    bad.length === 0,
    bad.length ? bad.join(' ; ') : `${checked} cases, exact byte count and RGBA hashes`,
  );
}

console.log('-- every fixture case, pixel for pixel --');
{
  const rectOf = (r) => (r ? { x: r[0], y: r[1], w: r[2], h: r[3] } : undefined);
  for (const c of spec.cases) {
    const src = sourceOf(c.src);
    if (!src) {
      ok(`case ${c.name}`, false, `source ${c.src} did not load`);
      continue;
    }
    const res = resample(src, rectOf(c.rect), c.targetMaxSide, c.name);
    const bad = [];
    const meta = spec.sources[c.src];
    if (res.width !== c.width || res.height !== c.height) {
      bad.push(`size ${res.width}x${res.height} want ${c.width}x${c.height}`);
    }
    if (Math.abs(res.scale - c.scale) > 1e-9) bad.push(`scale ${res.scale} want ${c.scale}`);
    if (!c.rect && res.data === src.data) bad.push('identity call returned the source buffer itself');
    const channels = c.rgba ? c.rgba[0].length : c.spots ? c.spots[0].length - 1 : 4;
    if (channels === 4) {
      const hex = sha256(Buffer.from(res.data));
      if (hex !== c.rgbaSha256) bad.push(`rgba sha256 ${hex.slice(0, 16)}… want ${c.rgbaSha256.slice(0, 16)}…`);
    } else if (c.rgba) {
      // A 3-channel oracle (PIL's own reduce of an opaque RGB source): the module still
      // returns RGBA, so the hash is over its RGB projection -- and alpha must stay 255.
      const hex = sha256(Buffer.from(res.data.filter((_, i) => i % 4 !== 3)));
      if (hex !== c.rgbaSha256) bad.push(`rgb sha256 ${hex.slice(0, 16)}… want ${c.rgbaSha256.slice(0, 16)}… (${c.oracle})`);
      for (let i = 0; i < res.width * res.height; i++) {
        if (res.data[i * 4 + 3] !== 255) {
          bad.push(`alpha ${res.data[i * 4 + 3]} at ${where(i, res.width)} (the source is opaque)`);
          break;
        }
      }
    }
    if (c.rgba) {
      const d = firstPixelDiff(res.data, c.rgba, c.width, channels);
      if (d) bad.push(d);
    } else if (c.spots) {
      for (const spot of c.spots) {
        const i = spot[0];
        for (let ch = 0; ch < channels; ch++) {
          if (res.data[i * 4 + ch] !== spot[1 + ch]) {
            bad.push(`${where(i, c.width)}: got ${show(res.data, i, channels)} want [${spot.slice(1).join(',')}]`);
            break;
          }
        }
      }
    } else {
      // No recorded pixels: the case is the identity, so compare against the source bytes.
      const same = res.width === meta.width && res.height === meta.height && Buffer.compare(Buffer.from(res.data), Buffer.from(src.data)) === 0;
      if (!same) bad.push('identity call did not return the source bytes');
    }
    ok(`case ${c.name} [${c.oracle}]`, bad.length === 0, bad.length ? bad.join(' ; ') : `${res.width}x${res.height}, ${res.data.length} bytes`);
  }
}

// ================================================================ 2. never upscale
console.log('-- 2. no upscale: a crop that already fits comes back untouched --');
{
  const small = makeImage(5, 3, (x, y) => [x * 40, y * 80, x + y, 255]);
  const wide = makeImage(2, 1000, (x, y) => [x * 100, y % 256, (x + y) % 256, 128]);
  const bad = [];
  for (const target of [5, 6, 100, 1024, 4096]) {
    const res = resample(small, undefined, target, `no-upscale 5x3 target ${target}`);
    if (res.width !== 5 || res.height !== 3 || res.scale !== 1) {
      bad.push(`5x3 target ${target}: ${res.width}x${res.height} scale ${res.scale}`);
    } else if (Buffer.compare(Buffer.from(res.data), Buffer.from(small.data)) !== 0) {
      bad.push(`5x3 target ${target}: bytes differ from the source`);
    }
  }
  const tall = resample(wide, undefined, 4096, 'no-upscale 2x1000 target 4096');
  if (tall.width !== 2 || tall.height !== 1000 || tall.scale !== 1) {
    bad.push(`2x1000 target 4096: ${tall.width}x${tall.height} scale ${tall.scale}`);
  } else if (Buffer.compare(Buffer.from(tall.data), Buffer.from(wide.data)) !== 0) {
    bad.push('2x1000 target 4096: bytes differ from the source');
  }
  // The wide fixture: 2000 px long side, so anything at or above 2000 is a no-op.
  const sheet = sourceOf('rs-wide-2000x8');
  for (const target of [2000, 2048, 4096]) {
    const res = resample(sheet, undefined, target, `no-upscale wide target ${target}`);
    if (res.width !== 2000 || res.height !== 8 || res.scale !== 1) {
      bad.push(`2000x8 target ${target}: ${res.width}x${res.height} scale ${res.scale}`);
    } else if (Buffer.compare(Buffer.from(res.data), Buffer.from(sheet.data)) !== 0) {
      bad.push(`2000x8 target ${target}: bytes differ from the source`);
    }
  }
  ok('a source smaller than the target is returned byte-identical with scale === 1', bad.length === 0,
    bad.length ? bad.join(' ; ') : '5x3 at targets 5..4096, 2x1000 at 4096, the 2000x8 sheet at 2000/2048/4096');
}

// ================================================================ 3. crop + no alias
console.log('-- 3. the crop contract, and a result that never aliases its input --');
{
  const small = sourceOf('rs-small-16x12');
  const rect = { x: 2, y: 3, w: 8, h: 6 };
  const crop = resample(small, rect, 1024, 'crop 8x6 of 16x12');
  const want = subImage(small, 2, 3, 8, 6);
  const sameCrop = crop.width === 8 && crop.height === 6 && Buffer.compare(Buffer.from(crop.data), Buffer.from(want)) === 0;
  ok('a crop-only call is the source region, byte for byte', sameCrop,
    sameCrop ? '8x6, scale ' + crop.scale : `${crop.width}x${crop.height}, ${crop.data.length} bytes vs ${want.length}`);

  // The identity, the crop and a real downscale: flip a byte of the input afterwards and the
  // result must not move. A result that aliased the source would change an upload after the
  // fact (the provenance record would then describe bytes that are not what was sent).
  const scratch = { width: small.width, height: small.height, data: Buffer.from(small.data) };
  // The three calls below are the only ones in this guard allowed to see their source
  // mutated (`mutatedByGuard`), because the flip is the point of the test and happens after
  // the call returned.
  const paths = [
    ['the identity (16x12, target 1024)', resample(scratch, undefined, 1024, 'alias check: identity', true)],
    ['the crop (8x6, target 1024)', resample(scratch, rect, 1024, 'alias check: crop', true)],
    ['a downscale (16x12, target 4)', resample(scratch, undefined, 4, 'alias check: downscale', true)],
  ];
  const snaps = paths.map(([, res]) => Buffer.from(res.data));
  scratch.data[17] ^= 0xff;
  scratch.data[0] ^= 0xff;
  const bad = [];
  paths.forEach(([label, res], i) => {
    if (res.data === scratch.data) bad.push(`${label}: the result IS the input buffer`);
    else if (Buffer.compare(Buffer.from(res.data), snaps[i]) !== 0) bad.push(`${label}: the result changed after the input was mutated`);
  });
  ok('a mutated input does not change an earlier result, and the result is not the input buffer', bad.length === 0,
    bad.length ? bad.join(' ; ') : 'identity, crop and downscale all hold their own bytes');
}

// ================================================================ 4. the weighting, by hand
console.log('-- 4. non-integer weighting: pure arithmetic, hand-checked where it matters --');
{
  // (a) the weights must be normalised: at every awkward scale a constant image has to come
  // back exactly constant. An off-by-one in the window sum (or a j*dw/i*sw mix-up) shows up
  // here as a drift of a few levels, which a noisy fixture can hide behind its own rounding.
  const flat = constant(25, 17, [37, 200, 5, 128]);
  const bad = [];
  const sizes = [];
  for (const target of [1, 2, 3, 6, 7, 10, 13, 16, 24]) {
    const res = resample(flat, undefined, target, `constant 25x17 target ${target}`);
    sizes.push(`${res.width}x${res.height}`);
    for (let i = 0; i < res.width * res.height; i++) {
      if (res.data[i * 4] !== 37 || res.data[i * 4 + 1] !== 200 || res.data[i * 4 + 2] !== 5 || res.data[i * 4 + 3] !== 128) {
        bad.push(`target ${target}: ${where(i, res.width)}: got ${show(res.data, i, 4)} want [37,200,5,128]`);
        break;
      }
    }
  }
  ok('a constant image stays exactly constant at every non-integer scale', bad.length === 0,
    bad.length ? bad.join(' ; ') : 'targets 1,2,3,6,7,10,13,16,24 -> ' + sizes.join(', '));
}
{
  // (b) 2x2 -> 1x1: the exact block average, no rounding needed (the divisor is the pixel
  // count and the weights are all 1).
  const two = makeImage(2, 2, (x, y) => [[10, 20, 30, 40], [50, 60, 70, 80], [90, 100, 110, 120], [130, 140, 150, 160]][y * 2 + x]);
  const res = resample(two, undefined, 1, '2x2 -> 1x1');
  const want = [[70, 80, 90, 100]];
  const d = res.width === 1 && res.height === 1 ? firstPixelDiff(res.data, want, 1, 4) : `size ${res.width}x${res.height}`;
  ok('a 2x2 block downscaled to 1x1 is the four-pixel average', !d, d ? String(d) : 'got [70,80,90,100]');
}
{
  // (c) 3x3 -> 2x2, hand-computed like (b) and the half-up case in (f). Weights in units of
  // 1/dw are x: j=0 -> [2,1,0], j=1 -> [0,1,2] (sum 3 = sw), the same on y, so den = 9 and
  //   (0,0) = (4*p00 + 2*p01 + 2*p10 + p11)/9      (1,0) = (2*p01 + 4*p02 + p11 + 2*p12)/9
  //   (0,1) = (2*p10 + p11 + 4*p20 + 2*p21)/9      (1,1) = (p11 + 2*p12 + 2*p21 + 4*p22)/9
  // Every component was computed from those four lines by hand (see the sources below), so a
  // wrong weight at a non-integer factor cannot hide behind this case's own arithmetic.
  //   p00 [10,240,5,200]  p01 [20,230,10,100]  p02 [30,220,15,50]
  //   p10 [40,210,20,200] p11 [50,200,25,100]  p12 [60,190,30,50]
  //   p20 [70,180,35,200] p21 [80,170,40,100]  p22 [90,160,45,50]
  const rows = [
    [[10, 240, 5, 200], [20, 230, 10, 100], [30, 220, 15, 50]],
    [[40, 210, 20, 200], [50, 200, 25, 100], [60, 190, 30, 50]],
    [[70, 180, 35, 200], [80, 170, 40, 100], [90, 160, 45, 50]],
  ];
  const three = makeImage(3, 3, (x, y) => rows[y][x]);
  const res = resample(three, undefined, 2, '3x3 -> 2x2 (hand-computed)');
  const want = [[23, 227, 12, 167], [37, 213, 18, 67], [63, 187, 32, 167], [77, 173, 38, 67]];
  const sizeBad = res.width === 2 && res.height === 2 ? undefined : `size ${res.width}x${res.height} want 2x2`;
  const d = sizeBad || firstPixelDiff(res.data, want, 2, 4);
  ok('a 3x3 downscaled to 2x2 equals the hand-computed weights', !d, d ? String(d) : 'got the four hand-computed pixels');
}
{
  // (d)+(e) one axis only. 3x1000 -> 999x... keeps dw == sw (2.997 rounds back to 3), so
  // every source column keeps its own weight and only the vertical windows change -- the
  // case where a shared or mis-indexed weight shows up as a horizontally smeared image.
  // The transpose covers the other axis the same way.
  const vImage = makeImage(3, 1000, (x, y) => [(x * 40 + y) % 256, (y * 7 + x * 3) % 256, (y % 5) * 50, 200]);
  const hImage = makeImage(1000, 3, (x, y) => [(x * 3 + y * 40) % 256, (x * 7 + y * 3) % 256, (x % 5) * 50, 200]);
  const vCase = resample(vImage, undefined, 999, 'vertical-only 3x1000 -> target 999');
  const hCase = resample(hImage, undefined, 999, 'horizontal-only 1000x3 -> target 999');
  const vSlow = slowAreaAverage(vImage, undefined, 999);
  const hSlow = slowAreaAverage(hImage, undefined, 999);
  const bad = [];
  if (vCase.width !== 3) bad.push(`vertical-only: width ${vCase.width} want 3 (the x axis must be untouched)`);
  if (hCase.height !== 3) bad.push(`horizontal-only: height ${hCase.height} want 3`);
  if (vCase.height !== 999) bad.push(`vertical-only: height ${vCase.height} want 999`);
  if (hCase.width !== 999) bad.push(`horizontal-only: width ${hCase.width} want 999`);
  if (Buffer.compare(Buffer.from(vCase.data), Buffer.from(vSlow.data)) !== 0) bad.push('vertical-only bytes differ from the slow oracle');
  if (Buffer.compare(Buffer.from(hCase.data), Buffer.from(hSlow.data)) !== 0) bad.push('horizontal-only bytes differ from the slow oracle');
  ok('a vertical-only and a horizontal-only non-integer case agree with the slow oracle', bad.length === 0,
    bad.length ? bad.join(' ; ') : `${vCase.width}x${vCase.height} and ${hCase.width}x${hCase.height}, scale ${hCase.scale}`);
}
{
  // (f) a destination of one pixel: the average of the whole crop, and the only place the
  // half-up rule is visible -- 8 pixels of 10 and 8 of 11 average to exactly 10.5 -> 11
  // (Python's `int(v/den + 0.5)` and `Math.round` agree by construction, and a
  // round-half-even implementation would give 10 here).
  const four = makeImage(4, 4, (x, y) => {
    const i = y * 4 + x;
    return [i < 8 ? 10 : 11, 100, i % 2 ? 200 : 0, 255];
  });
  const res = resample(four, undefined, 1, '4x4 -> 1x1 (half-up)');
  const want = [[11, 100, 100, 255]];
  const d = res.width === 1 && res.height === 1 ? firstPixelDiff(res.data, want, 1, 4) : `size ${res.width}x${res.height}`;
  ok('a destination of one pixel averages the crop and rounds 10.5 half-up', !d,
    d ? String(d) : 'got [11,100,100,255]');

  const one = makeImage(1, 1, () => [7, 8, 9, 10]);
  const keep = resample(one, undefined, 1, '1x1 source, target 1');
  const grow = resample(one, undefined, 8, '1x1 source, target 8');
  const oneBad = keep.width === 1 && keep.height === 1 && grow.width === 1 && grow.height === 1 &&
    Buffer.compare(Buffer.from(keep.data), Buffer.from(one.data)) === 0 &&
    Buffer.compare(Buffer.from(grow.data), Buffer.from(one.data)) === 0;
  ok('a 1x1 source stays 1x1 with its own bytes, even against a target of 8', oneBad,
    `${keep.width}x${keep.height} / ${grow.width}x${grow.height}, scale ${grow.scale}`);
}
{
  // (g) the rect edges. The clamp is checked against itself (a rect that hangs over the edge
  // must give exactly the bytes of its clamped form) and against the slow oracle, and a rect
  // that misses the image entirely must fall back to the whole image rather than to zeros or
  // to an out-of-range read.
  const src = sourceOf('rs-nonint-25x17');
  const bad = [];
  const edges = [
    ['x = 0 and w = the source width', { x: 0, y: 0, w: 25, h: 17 }, { x: 0, y: 0, w: 25, h: 17 }, 10],
    ['touching the right/bottom edge', { x: 21, y: 14, w: 4, h: 3 }, { x: 21, y: 14, w: 4, h: 3 }, 1024],
    ['hanging over the left/top edge', { x: -2, y: -2, w: 8, h: 8 }, { x: 0, y: 0, w: 6, h: 6 }, 1024],
    ['hanging over the right/bottom edge', { x: 20, y: 10, w: 100, h: 100 }, { x: 20, y: 10, w: 5, h: 7 }, 10],
    ['hanging over every edge', { x: -5, y: -3, w: 40, h: 30 }, { x: 0, y: 0, w: 25, h: 17 }, 6],
  ];
  for (const [label, loose, tight, target] of edges) {
    const got = resample(src, loose, target, `edge: ${label}`);
    const want = resample(src, tight, target, `edge: ${label} (clamped form)`);
    const slow = slowAreaAverage(src, tight, target);
    if (got.width !== want.width || got.height !== want.height) {
      bad.push(`${label}: ${got.width}x${got.height} vs the clamped form's ${want.width}x${want.height}`);
    } else if (Buffer.compare(Buffer.from(got.data), Buffer.from(want.data)) !== 0) {
      bad.push(`${label}: bytes differ from the clamped form ${tight.w}x${tight.h}@${tight.x},${tight.y}`);
    } else if (Buffer.compare(Buffer.from(got.data), Buffer.from(slow.data)) !== 0) {
      bad.push(`${label}: bytes differ from the slow oracle on the clamped rect`);
    }
  }
  const outside = resample(src, { x: 100, y: 100, w: 4, h: 4 }, 1024, 'edge: entirely outside');
  const srcMeta = spec.sources['rs-nonint-25x17'];
  const outsideOk = outside.width === srcMeta.width && outside.height === srcMeta.height &&
    outside.scale === 1 && Buffer.compare(Buffer.from(outside.data), Buffer.from(src.data)) === 0;
  if (!outsideOk) bad.push(`entirely outside: ${outside.width}x${outside.height} scale ${outside.scale} (want the whole 25x17 image)`);
  ok('edge rects are clamped to the image, and an empty one falls back to the whole image', bad.length === 0,
    bad.length ? bad.join(' ; ') : `${edges.length} clamped rects match the slow oracle; an off-image rect returns the whole ${srcMeta.width}x${srcMeta.height}`);
}
{
  // (h) the last defensive end: a source that does not carry `width * height * 4` bytes (a
  // decoder bug, a caller handing over a subarray) is padded rather than read past its end,
  // so the missing pixels come back as transparent black instead of as zeros written at a
  // random offset. The expectation is the slow oracle over the same padded image.
  const short = { width: 4, height: 4, data: new Uint8Array(20) };
  short.data.fill(255);
  const padded = { width: 4, height: 4, data: new Uint8Array(64) };
  padded.data.fill(255, 0, 20);
  const res = resample(short, undefined, 2, 'truncated source 4x4 with 20 bytes');
  const want = slowAreaAverage(padded, undefined, 2);
  const bad = [];
  if (res.width !== 2 || res.height !== 2) bad.push(`size ${res.width}x${res.height} want 2x2`);
  else if (Buffer.compare(Buffer.from(res.data), Buffer.from(want.data)) !== 0) bad.push('bytes differ from the slow oracle on the padded source');
  ok('a truncated source is padded, not read past its end', bad.length === 0,
    bad.length ? bad.join(' ; ') : 'the missing pixels arrive as transparent black, and no byte is undefined-derived');
}

// ================================================================ 5. the scale contract
console.log('-- 5. the scale contract --');
{
  const bad = [];
  const seen = [];
  const cases = [
    [16, 12, 1024],
    [25, 17, 25],
    [16, 12, 15.9], // rounds back to 16x12: nothing was resampled, so scale must be exactly 1
    [25, 17, 24.9],
    [25, 17, 10],
    [17, 25, 10],
    [2000, 8, 1024],
    [5, 4, 1],
  ];
  for (const [w, h, target] of cases) {
    const img = makeImage(w, h, (x, y) => [x % 256, y % 256, (x + y) % 256, 255]);
    const res = resample(img, undefined, target, `scale ${w}x${h} target ${target}`);
    const want = Math.min(1, target / Math.max(w, h));
    const dw = Math.max(1, Math.floor(w * want + 0.5));
    const dh = Math.max(1, Math.floor(h * want + 0.5));
    seen.push(`${w}x${h}@${target}->${res.width}x${res.height} scale ${res.scale}`);
    if (res.width !== dw || res.height !== dh) bad.push(`${w}x${h} target ${target}: size ${res.width}x${res.height} want ${dw}x${dh}`);
    if (dw === w && dh === h) {
      if (res.scale !== 1) bad.push(`${w}x${h} target ${target}: nothing was resampled but scale is ${res.scale}, not exactly 1`);
    } else if (Math.abs(res.scale - want) > 1e-12) {
      bad.push(`${w}x${h} target ${target}: scale ${res.scale} want ${want}`);
    } else if (!(res.scale < 1)) {
      bad.push(`${w}x${h} target ${target}: a resample reported scale ${res.scale}`);
    }
  }
  ok('scale is exactly 1 when the destination equals the crop, else min(1, target / longest side)', bad.length === 0,
    bad.length ? bad.join(' ; ') : seen.join(' · '));
}
{
  // A source with no pixels at all: the answer must still be exact (0x0, an empty buffer, and
  // a `scale` that was not read off a division by zero). A decoder never produces one, so this
  // only has to be sane, not useful.
  const none = resample({ width: 0, height: 0, data: new Uint8Array(0) }, undefined, 1024, 'empty source');
  const good = none.width === 0 && none.height === 0 && none.data.length === 0 && none.scale === 1;
  ok('a source with no pixels returns 0x0 with scale 1', good,
    good ? '0x0, 0 bytes' : `${none.width}x${none.height}, ${none.data.length} bytes, scale ${none.scale}`);
}

// ================================================================ the ledger
console.log('-- every call made above --');
{
  const shape = [], alias = [], mutated = [];
  for (const c of calls) {
    const { res, img } = c;
    // `0x0` is the documented answer for a source with no pixels; every other call must be at
    // least 1x1 with exactly `width * height * 4` bytes.
    const empty = res.width === 0 && res.height === 0 && res.data.length === 0;
    const shapeOk = empty || (res.width >= 1 && res.height >= 1 && res.data.length === res.width * res.height * 4);
    if (!shapeOk) shape.push(`${c.label}: ${res.width}x${res.height} ${res.data.length} bytes`);
    if (!(res.scale > 0) || res.scale > 1) shape.push(`${c.label}: scale ${res.scale}`);
    if (res.data === img.data) alias.push(c.label);
    if (!c.mutatedByGuard && Buffer.compare(Buffer.from(img.data), c.before) !== 0) mutated.push(c.label);
  }
  ok(`${calls.length} calls: width*height*4 bytes and 0 < scale <= 1`, shape.length === 0, shape.join(' ; '));
  ok('no result shares the caller\'s buffer', alias.length === 0, alias.join(' ; '));
  ok('no call mutated the source buffer', mutated.length === 0, mutated.join(' ; '));
}

console.log('');
if (problems.length) {
  console.log(`FAIL check-resample: ${problems.length} check(s) failed`);
  for (const p of problems) console.log('   · ' + p);
  process.exit(1);
}
console.log('PASS check-resample: the crop is the source region byte for byte, the downscale is an exact integer-weight area average (pixel-exact against PIL and the JSON oracle), the result never upscales and never aliases its input');
