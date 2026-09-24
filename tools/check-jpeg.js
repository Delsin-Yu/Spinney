/*
 * check-jpeg — the baseline JPEG decoder (`src/agent/jpeg{Entropy,Reconstruct,Decode}.ts`)
 * against an oracle that is not our own code, plus the failure shapes the caller relies on.
 *
 * WHY IT EXISTS
 * `imageTransform.ts` will hand JPEG bytes to `decodeJpeg` before an upload, and the only
 * thing that decides whether a decoded 4000x3000 photo is *right* is the pixels. A pure-JS
 * encoder/decoder pair can share a bug (docs/agents/plans/image-budget.md §6: "the decoder
 * must not certify itself"), so this guard never round-trips through our code for evidence:
 *
 *   - the fixtures in `tools/fixtures/jpeg/**` were written by PIL (libjpeg-turbo) — the
 *     independent encoder — together with PIL's own RGBA decode of each file, committed
 *     beside it (`manifest.json` names the expectation of every fixture). PIL is NOT
 *     needed at guard time; `tools/gen-jpeg-fixtures.py` regenerates both halves.
 *   - the negative fixtures are real variants too (progressive, truncated mid-scan, 4
 *     components), and the 12-bit / SOF1 / SOF2-patched cases are byte-patched copies of a
 *     committed baseline file, so the scope refusals are exercised without a 12-bit encoder.
 *
 * WHAT IT ASSERTS
 *   S1   the frozen seam: all four exports exist, `decodeJpegEntropy` returns either
 *        coefficients or `{error}` (never throws), `isCoefficients` agrees with the shape
 *   S2   plane geometry of every positive fixture: blockCols/blockRows match the frame's
 *        sampling factors, each plane is `blocks * 64` coefficients, every component's
 *        quantization table is present, dimensions match the manifest
 *   S3   `reconstructJpeg(decodeJpegEntropy(bytes))` is byte-identical to `decodeJpeg(bytes)`
 *        — the orchestrator adds the scope rules, not a second decode
 *   P1..  positive fixtures: our RGBA vs PIL's, per fixture the max and the mean channel
 *        difference over every pixel (or over the committed sample set for the large one),
 *        tolerance max <= 8, mean <= 1.5 (IDCT/rounding), and alpha == 255 everywhere
 *   C1   the upsampling CONTRACT, on the real fixtures: inside each chroma sample's footprint
 *        (2x2 for 4:2:0, 2x1 for 4:2:2) the RGB differences between two luma pixels are the
 *        same in R, G and B — i.e. chroma is repeated, not interpolated. A 4:4:4 fixture is
 *        the control: there the property must FAIL on most footprints, or the check is vacuous
 *   A1.. analytic coefficient sets built in this file: a DC-only grey block, a single AC
 *        coefficient against a hand-written IDCT sum, the level shift and clamping at both
 *        ends, the YCbCr matrix, grey->RGBA alpha, and a 2x2-subsampled set whose 2x2 luma
 *        footprints must all carry one chroma sample (the mapping entropy -> pixels, with
 *        entropy deliberately not involved)
 *   N1.. negatives: progressive (real + patched SOF2), patched SOF1, patched 12-bit, 4
 *        components (real CMYK), truncated (real, plus cuts at 90/50/10 %), non-JPEG bytes,
 *        empty input, SOI-only — every one must come back as `{error}` with a reason and
 *        must never throw
 *
 * Run: npm run check:jpeg   /   node tools/check-jpeg.js [fixtureDir] [outDir]
 *      Plain node over `out/` like every other guard: compile first (`npm run compile`),
 *      no vscode, no dependencies. Exit code is non-zero when any case fails.
 *
 *      argv[2] overrides the fixture directory and argv[3] the compiled module directory,
 *      so the same guard can be pointed at a MUTATED copy of `out/agent` outside the repo
 *      (see the `M` matrix in the report of slice A2: a guard that cannot fail proves
 *      nothing). Both default to the repo's own directories.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'fixtures', 'jpeg');
const OUT_AGENT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'out', 'agent');

// ---------------------------------------------------------------- report stream
const results = []; // { group, label, ok, detail }
let group = 'load';
const say = (label, ok, detail) => {
  results.push({ group, label, ok, detail: detail || '' });
  const tag = ok ? '[ok  ]' : '[FAIL]';
  console.log(`  ${tag} ${label}${detail ? '  (' + detail + ')' : ''}`);
  return ok;
};
const section = (title) => {
  group = title;
  console.log('');
  console.log(`-- ${title} --`);
};
const num = (v, digits) => (typeof v === 'number' && isFinite(v) ? v.toFixed(digits == null ? 3 : digits) : String(v));

// ---------------------------------------------------------------- the modules under test
let jpeg;
try {
  jpeg = {
    decodeJpeg: require(path.join(OUT_AGENT, 'jpegDecode.js')).decodeJpeg,
    entropy: require(path.join(OUT_AGENT, 'jpegEntropy.js')),
    reconstruct: require(path.join(OUT_AGENT, 'jpegReconstruct.js')).reconstructJpeg,
  };
} catch (e) {
  console.log('FAIL check-jpeg: could not load out/agent/jpeg*.js (' + e.message + ')');
  console.log('      run `npm run compile` first.');
  process.exit(1);
}
const { decodeJpeg, entropy, reconstruct } = jpeg;
const decodeJpegEntropy = entropy.decodeJpegEntropy;
const isCoefficients = entropy.isCoefficients;

/** Call `fn` and normalise "it threw" into a value the cases can assert on. */
function attempt(fn, ...args) {
  try {
    return { value: fn(...args) };
  } catch (e) {
    return { threw: e && e.message ? e.message : String(e) };
  }
}

const fixturePath = (name) => path.join(FIXTURE_DIR, name);
const readFixture = (name) => new Uint8Array(fs.readFileSync(fixturePath(name)));
const unsupported = (v) => v && typeof v === 'object' && typeof v.error === 'string' && v.error.length > 0;

// ---------------------------------------------------------------- pixel comparison
/**
 * Max and mean absolute channel difference between our RGBA and the committed
 * expectation, plus how many channels are over the tolerance. `fatal` collects the
 * structural faults (size, alpha) that make the numbers meaningless.
 */
function compareRgba(decoded, expect, expectKind) {
  const w = decoded.width;
  const h = decoded.height;
  let max = 0;
  let sum = 0;
  let n = 0;
  let over = 0;
  let nonOpaque = 0;
  const bump = (a, b) => {
    const d = a > b ? a - b : b - a;
    if (d > max) max = d;
    if (d > 8) over++;
    sum += d;
    n++;
  };
  if (expectKind === 'rgba') {
    for (let i = 0; i < w * h * 4; i++) bump(decoded.data[i], expect[i]);
    for (let i = 3; i < w * h * 4; i += 4) if (decoded.data[i] !== 255) nonOpaque++;
  } else {
    const stride = expect.stride;
    let k = 0;
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const o = (y * w + x) * 4;
        for (let c = 0; c < 4; c++) bump(decoded.data[o + c], expect.rgba[k++]);
      }
    }
    for (let y = 0; y < h; y++) {
      const o = (y * w + (w - 1)) * 4;
      for (let c = 0; c < 4; c++) bump(decoded.data[o + c], expect.rgba[k++]);
    }
    for (let i = 3; i < w * h * 4; i += 4) if (decoded.data[i] !== 255) nonOpaque++;
  }
  return { max, mean: n ? sum / n : NaN, channels: n, over, nonOpaque };
}

/** The sampling factors of a frame, from the fixture manifest's label. */
function samplingOf(entry) {
  const raw = entry.subsampling;
  if (entry.components === 1) return 'gray';
  if (raw === 0) return '4:4:4';
  if (raw === 1) return '4:2:2';
  if (raw === 2) return '4:2:0';
  return String(raw);
}

/**
 * C1 — the upsampling contract, measured on the real pixels: a chroma sample covers
 * `hx` by `vy` luma pixels, so two pixels inside one footprint differ by a pure luma
 * shift — the same delta in R, G and B (|dR-dG| and |dG-dB| <= tol). Bilinear chroma
 * (libjpeg's fancy filter, or a wrong mapping) breaks that equality.
 * Returns { flat, total } over every aligned footprint fully inside the image.
 */
function chromaFootprints(decoded, hx, vy, tol) {
  const { width: w, height: h, data } = decoded;
  let flat = 0;
  let total = 0;
  for (let y = 0; y + vy <= h; y += vy) {
    for (let x = 0; x + hx <= w; x += hx) {
      const o0 = (y * w + x) * 4;
      const r0 = data[o0];
      const g0 = data[o0 + 1];
      const b0 = data[o0 + 2];
      let ok = true;
      for (let yy = 0; yy < vy && ok; yy++) {
        for (let xx = 0; xx < hx && ok; xx++) {
          if (yy === 0 && xx === 0) continue;
          const o = ((y + yy) * w + (x + xx)) * 4;
          const dR = data[o] - r0;
          const dG = data[o + 1] - g0;
          const dB = data[o + 2] - b0;
          if (Math.abs(dR - dG) > tol || Math.abs(dG - dB) > tol) ok = false;
        }
      }
      total++;
      if (ok) flat++;
    }
  }
  return { flat, total };
}

// ---------------------------------------------------------------- synthetic coefficients
/** Build a coefficient set the way the seam describes it (no encoder involved). */
function synth({ width, height, comps, blocks, quant }) {
  const maxH = comps.reduce((m, c) => Math.max(m, c.h), 1);
  const maxV = comps.reduce((m, c) => Math.max(m, c.v), 1);
  const blockCols = comps.map((c) => Math.ceil(width / (8 * maxH)) * c.h);
  const blockRows = comps.map((c) => Math.ceil(height / (8 * maxV)) * c.v);
  const planes = comps.map((_, ci) => {
    const plane = new Int16Array(blockCols[ci] * blockRows[ci] * 64);
    if (blocks && blocks[ci]) blocks[ci](plane, blockCols[ci], blockRows[ci]);
    return plane;
  });
  const quantTables = [null, null, null, null];
  for (const c of comps) if (!quantTables[c.quantTable]) quantTables[c.quantTable] = Uint16Array.from(quant);
  return {
    width,
    height,
    maxH,
    maxV,
    components: comps.map((c, i) => ({ id: i + 1, h: c.h, v: c.v, quantTable: c.quantTable })),
    quantTables,
    planes,
    blockCols,
    blockRows,
  };
}

/** The IDCT written straight from the spec, for the analytic comparison. */
function idctReference(coeff) {
  const out = new Float64Array(64);
  const C = (k) => (k === 0 ? 1 / Math.SQRT2 : 1);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          sum += C(u) * C(v) * coeff[v * 8 + u] * Math.cos(((2 * x + 1) * u * Math.PI) / 16) * Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        }
      }
      out[y * 8 + x] = sum / 4;
    }
  }
  return out;
}

const pixel = (px, x, y) => {
  const o = (y * px.width + x) * 4;
  return [px.data[o], px.data[o + 1], px.data[o + 2], px.data[o + 3]];
};
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// ---------------------------------------------------------------- main
function main() {
  console.log('check-jpeg: baseline JPEG decoder (entropy + reconstruct + orchestrator)');
  console.log('  fixtures : ' + FIXTURE_DIR);
  console.log('  out/agent: ' + OUT_AGENT);
  const manifestPath = path.join(FIXTURE_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log('FAIL check-jpeg: no manifest.json in the fixture directory — run tools/gen-jpeg-fixtures.py');
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('  oracle   : ' + manifest.oracle);
  console.log('  tolerance: max channel difference <= ' + manifest.tolerance.maxChannelDifference + ', mean <= ' + manifest.tolerance.meanChannelDifference);
  const tolMax = manifest.tolerance.maxChannelDifference;
  const tolMean = manifest.tolerance.meanChannelDifference;

  // ================================================================ S1 seam
  section('S1 the frozen seam');
  say('decodeJpeg / decodeJpegEntropy / isCoefficients / reconstructJpeg are functions',
    typeof decodeJpeg === 'function' && typeof decodeJpegEntropy === 'function' &&
    typeof isCoefficients === 'function' && typeof reconstruct === 'function',
    'decodeJpeg=' + typeof decodeJpeg + ' decodeJpegEntropy=' + typeof decodeJpegEntropy +
    ' isCoefficients=' + typeof isCoefficients + ' reconstructJpeg=' + typeof reconstruct);
  {
    const gamma = readFixture('gray-16x16.jpg');
    const good = attempt(decodeJpegEntropy, gamma);
    const bad = attempt(decodeJpegEntropy, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const threw = [good.threw, bad.threw].filter(Boolean);
    say('decodeJpegEntropy returns coefficients for a good file and {error} for a bad one, never throwing',
      !threw.length && !unsupported(good.value) && unsupported(bad.value),
      threw.length ? 'threw: ' + threw.join(' | ')
        : (unsupported(good.value) ? 'good file refused: ' + good.value.error : 'bad input -> "' + bad.value.error + '"'));
    if (!threw.length) {
      say('isCoefficients agrees with the returned shape',
        isCoefficients(good.value) === true && isCoefficients(bad.value) === false,
        'good -> ' + isCoefficients(good.value) + ', error -> ' + isCoefficients(bad.value));
    }
  }

  // ================================================================ S2/S3 positive fixtures
  const decoded = new Map();
  section('S2/S3 coefficients and the orchestrator, per positive fixture');
  let worstMax = 0;
  let worstMean = 0;
  for (const entry of manifest.fixtures) {
    const bytes = readFixture(entry.file);
    const label = entry.file + ' (' + entry.width + 'x' + entry.height + ' ' + samplingOf(entry) + ')';

    const started = Date.now();
    const got = attempt(decodeJpeg, bytes);
    const ms = Date.now() - started;
    if (got.threw) {
      say('P ' + label, false, 'decodeJpeg threw: ' + got.threw);
      continue;
    }
    if (unsupported(got.value)) {
      say('P ' + label, false, 'decodeJpeg refused it: ' + got.value.error);
      continue;
    }
    const px = got.value;
    decoded.set(entry.file, px);
    if (px.width !== entry.width || px.height !== entry.height) {
      say('P ' + label, false, 'decoded ' + px.width + 'x' + px.height + ', manifest says ' + entry.width + 'x' + entry.height);
      continue;
    }

    // ---- geometry of the seam
    const coeff = attempt(decodeJpegEntropy, bytes);
    if (coeff.threw || unsupported(coeff.value)) {
      say('S2 ' + label, false, coeff.threw ? 'threw: ' + coeff.threw : 'refused: ' + coeff.value.error);
    } else {
      const c = coeff.value;
      const maxH = c.components.reduce((m, k) => Math.max(m, k.h), 1);
      const maxV = c.components.reduce((m, k) => Math.max(m, k.v), 1);
      const want = c.components.map((k) => [
        Math.ceil(c.width / (8 * maxH)) * k.h,
        Math.ceil(c.height / (8 * maxV)) * k.v,
      ]);
      const faults = [];
      if (c.components.length !== entry.components) faults.push(c.components.length + ' components, want ' + entry.components);
      if (c.maxH !== maxH || c.maxV !== maxV) faults.push('maxH/maxV ' + c.maxH + 'x' + c.maxV);
      for (let i = 0; i < c.components.length; i++) {
        if (c.blockCols[i] !== want[i][0] || c.blockRows[i] !== want[i][1]) {
          faults.push('block grid c' + i + ' = ' + c.blockCols[i] + 'x' + c.blockRows[i] + ', want ' + want[i][0] + 'x' + want[i][1]);
        }
        if (!c.planes[i] || c.planes[i].length !== want[i][0] * want[i][1] * 64) {
          faults.push('plane c' + i + ' length ' + (c.planes[i] ? c.planes[i].length : 'missing'));
        }
        const tq = c.components[i].quantTable;
        if (!c.quantTables[tq] || c.quantTables[tq].length !== 64) faults.push('quant table ' + tq + ' missing');
      }
      say('S2 ' + label, faults.length === 0,
        faults.length ? faults.join('; ')
          : 'components ' + c.components.length + ', maxH/maxV ' + c.maxH + '/' + c.maxV +
            ', planes ' + c.planes.map((p, i) => c.blockCols[i] + 'x' + c.blockRows[i]).join(' + ') +
            ', quant tables ' + c.quantTables.filter(Boolean).length);

      const again = attempt(reconstruct, c);
      let same = false;
      let detail = 'reconstructJpeg threw: ' + again.threw;
      if (!again.threw) {
        const q = again.value;
        same = q.width === px.width && q.height === px.height && q.data.length === px.data.length;
        if (same) {
          for (let i = 0; i < px.data.length; i++) if (px.data[i] !== q.data[i]) { same = false; detail = 'first differing byte at ' + i; break; }
          if (same) detail = px.data.length + ' bytes identical';
        } else {
          detail = 'size mismatch ' + q.width + 'x' + q.height + ' vs ' + px.width + 'x' + px.height;
        }
      }
      say('S3 ' + label, same, 'reconstructJpeg(decodeJpegEntropy(bytes)) == decodeJpeg(bytes): ' + detail);
    }

    // ---- pixels against PIL
    const expect = entry.expectKind === 'rgba'
      ? new Uint8Array(fs.readFileSync(fixturePath(entry.expect)))
      : JSON.parse(fs.readFileSync(fixturePath(entry.expect), 'utf8'));
    const cmp = compareRgba(px, expect, entry.expectKind);
    worstMax = Math.max(worstMax, cmp.max);
    worstMean = Math.max(worstMean, cmp.mean);
    const ok = cmp.max <= tolMax && cmp.mean <= tolMean && cmp.nonOpaque === 0;
    say('P ' + label, ok,
      'PIL oracle: max ' + cmp.max + ', mean ' + num(cmp.mean) + ' over ' + cmp.channels + ' channels' +
      (cmp.over ? ', ' + cmp.over + ' over ' + tolMax : '') +
      (cmp.nonOpaque ? ', ' + cmp.nonOpaque + ' non-opaque alpha bytes' : ', alpha all 255') +
      ', ' + ms + ' ms, fixture ' + entry.bytes + ' B, ' +
      (entry.expectKind === 'rgba' ? 'every pixel' : 'committed samples (stride ' + expect.stride + ' + last column)'));
  }

  // ================================================================ C1 upsampling contract
  section('C1 chroma repetition, measured on the real pixels');
  {
    let checked = 0;
    for (const entry of manifest.fixtures) {
      const kind = samplingOf(entry);
      const px = decoded.get(entry.file);
      if (!px) continue;
      if (kind === 'gray') {
        say('C1 ' + entry.file + ' (grey, no chroma to upsample)', true,
          'every sample is luma; the colour path is covered by the analytic cases below');
        continue;
      }
      // The control uses the 2x2 footprint on the 4:4:4 fixture: a decoder that (wrongly)
      // treated it as subsampled would look chroma-flat there, so the property must fail.
      const [hx, vy] = kind === '4:2:2' ? [2, 1] : [2, 2];
      const { flat, total } = chromaFootprints(px, hx, vy, 2);
      if (kind === '4:4:4') {
        const ok = total > 0 && flat < total * 0.6;
        say('C1 ' + entry.file + ' (4:4:4 control: the property must NOT hold)', ok,
          flat + '/' + total + ' 2x2 footprints look chroma-flat; a check that always passes would be vacuous');
      } else {
        const ok = total > 0 && flat === total;
        say('C1 ' + entry.file + ' (' + kind + ': one chroma sample per ' + hx + 'x' + vy + ' luma)', ok,
          flat + '/' + total + ' footprints carry a single repeated chroma sample (R/G/B deltas equal)');
        checked += total;
      }
    }
    say('C1 footprints measured', checked > 0, checked + ' chroma footprints over the subsampled fixtures');
  }

  // ================================================================ A analytic coefficients
  section('A analytic coefficient sets (no encoder involved)');
  const QUANT = Array.from({ length: 64 }, () => 1);
  {
    // Grey, 8x8, one block, quantization entry 0 = 8: the IDCT of a DC-only block is
    // constant = dequant(dc)/8 + 128 = dc + 128 (that is what pins the 1/8 scale and the
    // level shift at once), and it must clamp at both ends.
    const quant = Uint8Array.from([8].concat(QUANT.slice(1)));
    const cases = [-200, -128, -1, 0, 1, 127, 200];
    const faults = [];
    for (const d of cases) {
      const grid = synth({
        width: 8, height: 8, comps: [{ h: 1, v: 1, quantTable: 0 }], quant,
        blocks: [(plane) => { plane[0] = d; }],
      });
      const px = attempt(reconstruct, grid);
      if (px.threw) { faults.push('dc ' + d + ': threw ' + px.threw); continue; }
      const want = clamp8(d + 128);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const [r, g, b, a] = pixel(px.value, x, y);
          if (r !== want || g !== want || b !== want || a !== 255) {
            faults.push('dc ' + d + ' at ' + x + ',' + y + ' = ' + [r, g, b, a].join(',') + ' want ' + want + ',255');
            x = 8; y = 8;
          }
        }
      }
    }
    say('A grey DC-only block: flat value = dc + 128, clamped, alpha 255', faults.length === 0,
      faults.length ? faults.join('; ') : 'all ' + cases.length + ' DC values * every one of 64 pixels');
  }
  {
    // One AC coefficient against the IDCT sum written out in this file: this is the only
    // check of the coefficient ORDER (zigzag already undone) and of the cosine scale.
    const faults = [];
    for (const idx of [1, 2, 7, 8, 9, 63]) {
      const amp = 8;
      const plane = new Int16Array(64);
      plane[idx] = amp;
      const grid = synth({
        width: 8, height: 8, comps: [{ h: 1, v: 1, quantTable: 0 }], quant: QUANT,
        blocks: [(p) => p.set(plane)],
      });
      const px = attempt(reconstruct, grid);
      if (px.threw) { faults.push('index ' + idx + ': threw ' + px.threw); continue; }
      const want = idctReference(plane);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const got = pixel(px.value, x, y)[0];
          const exp = clamp8(want[y * 8 + x] + 128);
          if (Math.abs(got - exp) > 1) {
            faults.push('index ' + idx + ' at ' + x + ',' + y + ': got ' + got + ' want ' + exp);
            x = 8; y = 8;
          }
        }
      }
    }
    say('A a single AC coefficient matches the hand-written IDCT sum (all 64 pixels, +/-1)', faults.length === 0,
      faults.length ? faults.join('; ') : 'indices 1,2,7,8,9,63 (u,v = 1,0 / 2,0 / 7,0 / 0,1 / 1,1 / 7,7)');
  }
  {
    // The colour matrix, one chroma step at a time, DC-only so the sample is flat.
    const quant = Uint8Array.from([8].concat(QUANT.slice(1)));
    const grey = (d) => (plane) => { plane[0] = d; };
    const faults = [];
    // [Y, Cb, Cr] as quantized DC (each +/- 1 quant unit == 1 sample step)
    const sets = [[0, 0, 0], [127, 0, 0], [0, 1, 0], [0, 0, 1], [0, 8, -8], [127, 127, 127], [127, -128, 127]];
    for (const [y, cb, cr] of sets) {
      const grid = synth({
        width: 8, height: 8,
        comps: [{ h: 1, v: 1, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }],
        quant,
        blocks: [grey(y), grey(cb), grey(cr)],
      });
      const px = attempt(reconstruct, grid);
      if (px.threw) { faults.push('[Y ' + y + ' Cb ' + cb + ' Cr ' + cr + '] threw ' + px.threw); continue; }
      const Y = clamp8(y + 128);
      const Cb = clamp8(cb + 128);
      const Cr = clamp8(cr + 128);
      const want = [
        clamp8(Y + 1.402 * (Cr - 128)),
        clamp8(Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128)),
        clamp8(Y + 1.772 * (Cb - 128)),
        255,
      ];
      const got = pixel(px.value, 3, 4);
      const delta = got.map((v, i) => Math.abs(v - want[i]));
      if (Math.max(...delta) > 1) faults.push('Y' + Y + ' Cb' + Cb + ' Cr' + Cr + ': got ' + got.join(',') + ' want ' + want.join(','));
    }
    say('A YCbCr -> RGB matrix (level shift, each channel, both clamp ends, +/-1)', faults.length === 0,
      faults.length ? faults.join('; ')
        : 'neutral grey is exactly 128/128/128; Y=255 with Cb=0/Cr=255 clamps to 255/208/28');
  }
  {
    // 4:2:0 by construction: 2x2 luma footprints must carry ONE chroma sample, and the
    // footprint boundary must land where floor(x * hc / maxH) says, i.e. on even luma
    // coordinates -- which is exactly what a "nearest" bug gets wrong at odd offsets.
    const luma = (p) => {
      // A distinct DC per 8x8 block (in the padded 2x2 grid) so luma is never flat.
      for (let b = 0; b < p.length / 64; b++) p[b * 64] = (b % 4) * 3;
    };
    const chroma = (v) => (p) => {
      for (let i = 0; i < 8; i++) p[i] = v + i * 2;
    };
    const grid = synth({
      width: 16, height: 16,
      comps: [{ h: 2, v: 2, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }],
      quant: QUANT,
      blocks: [luma, chroma(-40), chroma(-20)],
    });
    const px = attempt(reconstruct, grid);
    if (px.threw) {
      say('A 4:2:0 mapping: one chroma sample per 2x2 luma footprint', false, 'threw ' + px.threw);
    } else {
      const { flat, total } = chromaFootprints(px.value, 2, 2, 2);
      // and the footprints must differ from each other, or "flat" would be trivial
      const rowA = pixel(px.value, 0, 0);
      const rowB = pixel(px.value, 2, 0);
      const colB = pixel(px.value, 0, 2);
      const differs = rowB[0] !== rowA[0] || colB[0] !== rowA[0];
      say('A 4:2:0 mapping: one chroma sample per 2x2 luma footprint', flat === total && total > 0 && differs,
        flat + '/' + total + ' footprints chroma-flat, neighbouring footprints differ: ' +
        [rowA, rowB, colB].map((p) => p.slice(0, 3).join(',')).join(' | '));
    }
  }
  {
    // A 1x1 chroma plane for an odd size (17x9, so 3x2 luma blocks): the cropped edge
    // must not read past the plane or wrap a row.
    const grid = synth({
      width: 17, height: 9,
      comps: [{ h: 2, v: 2, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }],
      quant: QUANT,
      blocks: [(p) => { for (let i = 0; i < p.length; i++) p[i] = (i % 7) - 3; },
        (p) => { for (let i = 0; i < p.length; i++) p[i] = (i % 5) - 2; },
        (p) => { for (let i = 0; i < p.length; i++) p[i] = (i % 3) - 1; }],
    });
    const px = attempt(reconstruct, grid);
    if (px.threw) {
      say('A odd size 17x9 through the seam (3x2 luma blocks, padded chroma)', false, 'threw ' + px.threw);
    } else {
      const ok = px.value.width === 17 && px.value.height === 9 && px.value.data.length === 17 * 9 * 4;
      say('A odd size 17x9 through the seam (3x2 luma blocks, padded chroma)', ok,
        (ok ? '17x9, ' + px.value.data.length + ' bytes; ' : '') +
        'blockCols/blockRows ' + grid.blockCols.join('/') + ' and ' + grid.blockRows.join('/'));
    }
  }
  {
    // Determinism: the same coefficients twice, byte for byte.
    const grid = synth({
      width: 24, height: 16,
      comps: [{ h: 2, v: 2, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }],
      quant: QUANT,
      blocks: [(p) => { for (let i = 0; i < p.length; i++) p[i] = ((i * 13) % 17) - 8; },
        (p) => { for (let i = 0; i < p.length; i++) p[i] = ((i * 7) % 11) - 5; },
        (p) => { for (let i = 0; i < p.length; i++) p[i] = ((i * 5) % 9) - 4; }],
    });
    const a = attempt(reconstruct, grid);
    const b = attempt(reconstruct, grid);
    let same = !a.threw && !b.threw;
    if (same) for (let i = 0; i < a.value.data.length; i++) if (a.value.data[i] !== b.value.data[i]) { same = false; break; }
    say('A determinism: the same coefficients decode to the same bytes', same,
      same ? a.value.data.length + ' bytes twice' : 'threw or differed');
  }

  {
    section('S4 host cost and allocation shape');
    // The path `read_image` actually takes: a 12 MP photo. Nothing here is a timing
    // assertion (a slow machine must not fail the build); it pins the *shape* — the block
    // grid, a full-IDCT run (not the flat-block shortcut) and exactly width*height*4 bytes
    // out — and reports the cost, because a codec that allocates per pixel would show up
    // here as seconds (the extension host is single-threaded, plan §6).
    const textured = (p, cols) => {
      for (let b = 0; b < p.length / 64; b++) {
        p[b * 64] = (b % 7) - 3;
        p[b * 64 + 1] = (b % 5) - 2;
        p[b * 64 + 9] = (b % 3) - 1;
      }
    };
    const t0 = Date.now();
    const grid = synth({
      width: 4000, height: 3000,
      comps: [{ h: 2, v: 2, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }, { h: 1, v: 1, quantTable: 0 }],
      quant: QUANT,
      blocks: [textured, textured, textured],
    });
    const tCoeff = Date.now();
    const px = attempt(reconstruct, grid);
    const tDone = Date.now();
    if (px.threw) {
      say('S4 12 MP 4:2:0 (4000x3000) coefficient set reconstructs', false, 'threw ' + px.threw);
    } else {
      const q = px.value;
      const ok = q.width === 4000 && q.height === 3000 && q.data.length === 4000 * 3000 * 4 &&
        q.data[3] === 255 && q.data[q.data.length - 1] === 255;
      say('S4 12 MP 4:2:0 (4000x3000) coefficient set reconstructs', ok,
        'block grid ' + grid.blockCols.join('/') + ' x ' + grid.blockRows[0] + ', ' +
        q.data.length + ' bytes out, ' + (tDone - t0) + ' ms total (' + (tCoeff - t0) + ' ms building the synthetic coefficients)');
    }
  }

  // ================================================================ N negatives
  section('N refusals (all must be {error}, never a throw)');
  // `want` is the reason the *oracle of the contract* expects: a decoder that refuses
  // everything, or refuses for the wrong reason, is as broken as one that decodes garbage.
  const REASONS = {
    progressive: /progressive/i,
    truncated: /truncat|ends before|past the end|claims|cuts off/i,
    components: /component/i,
    notajpeg: /not a JPEG|too short|damaged|frame header/i,
  };
  const negatives = [];
  for (const entry of manifest.negatives) {
    if (entry.why === 'baseline-source') continue; // patched below, not a case of its own
    negatives.push({ label: entry.file, bytes: readFixture(entry.file), want: REASONS[entry.why] });
  }
  {
    // Patch a committed baseline file: the encoder variants we cannot produce with PIL.
    const base = readFixture('baseline-444-16x16.jpg');
    const findSof = (buf) => {
      for (let i = 2; i < buf.length - 1; i++) if (buf[i] === 0xff && buf[i + 1] === 0xc0) return i + 1;
      return -1;
    };
    const at = findSof(base);
    const patched = (mutate, label, want) => {
      const copy = Uint8Array.from(base);
      mutate(copy, at);
      negatives.push({ label, bytes: copy, want });
    };
    negatives.push({ label: 'baseline-444-16x16.jpg (unchanged control)', bytes: base, expectImage: true });
    // SOF0 body offsets from the marker byte: +1/+2 length, +3 precision, +4/+5 height,
    // +6/+7 width, +8 component count.
    patched((b, p) => { b[p] = 0xc2; }, 'patched SOF2 (progressive) in a baseline file', REASONS.progressive);
    patched((b, p) => { b[p] = 0xc1; }, 'patched SOF1 (extended sequential) in a baseline file', /SOF1|extended sequential/i);
    patched((b, p) => { b[p] = 0xc3; }, 'patched SOF3 (lossless) in a baseline file', /SOF3|lossless/i);
    patched((b, p) => { b[p + 3] = 12; }, 'patched 12-bit precision in a baseline file', /12-bit|precision/i);
    patched((b, p) => { b[p + 8] = 4; }, 'patched 4 components in a baseline file', REASONS.components);
    patched((b, p) => { b[p + 8] = 2; }, 'patched 2 components in a baseline file', REASONS.components);
    patched((b, p) => { b[p + 4] = 0; b[p + 5] = 0; }, 'patched 0 height in a baseline file', /size of 0|height/i);
    patched((b, p) => { b[p] = 0xd8; }, 'patched a standalone marker where the frame header was', REASONS.notajpeg);
  }
  {
    const good = readFixture('rgb-444-32x24.jpg');
    negatives.push({ label: 'rgb-444-32x24.jpg cut at 90 %', bytes: good.slice(0, Math.floor(good.length * 0.9)), want: REASONS.truncated });
    negatives.push({ label: 'rgb-444-32x24.jpg cut at 50 %', bytes: good.slice(0, Math.floor(good.length * 0.5)), want: REASONS.truncated });
    negatives.push({ label: 'rgb-444-32x24.jpg cut at 10 %', bytes: good.slice(0, Math.floor(good.length * 0.1)), want: REASONS.notajpeg });
    negatives.push({ label: 'SOI only (two bytes)', bytes: new Uint8Array([0xff, 0xd8]), want: REASONS.notajpeg });
  }
  negatives.push({ label: 'empty input', bytes: new Uint8Array(0), want: REASONS.notajpeg });
  negatives.push({ label: 'plain text ("hello world")', bytes: new Uint8Array(Buffer.from('hello world', 'utf8')), want: REASONS.notajpeg });
  negatives.push({ label: 'a PNG (89 50 4E 47 ...)', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), want: REASONS.notajpeg });

  for (const neg of negatives) {
    const got = attempt(decodeJpeg, neg.bytes);
    if (got.threw) {
      say('N ' + neg.label, false, 'decodeJpeg THREW: ' + got.threw);
      continue;
    }
    if (neg.expectImage) {
      say('N ' + neg.label, !unsupported(got.value), unsupported(got.value) ? 'refused a valid file: ' + got.value.error : 'decodes (control)');
      continue;
    }
    if (!unsupported(got.value)) {
      say('N ' + neg.label, false, 'returned an image (' + got.value.width + 'x' + got.value.height + ') instead of {error} — a damaged file must not become pixels');
      continue;
    }
    const reason = got.value.error;
    const okReason = !neg.want || neg.want.test(reason);
    say('N ' + neg.label, okReason,
      (okReason ? 'error: ' : 'error names the wrong reason (' + neg.want + '): ') + reason);
  }
  {
    // The entropy half must make the same promise on its own (the seam's contract).
    const bad = [];
    for (const neg of negatives) {
      if (neg.expectImage) continue;
      const got = attempt(decodeJpegEntropy, neg.bytes);
      if (got.threw) bad.push(neg.label + ' threw');
      else if (!unsupported(got.value)) bad.push(neg.label + ' returned coefficients');
    }
    say('N decodeJpegEntropy refuses every one of them too, without throwing', bad.length === 0,
      bad.length ? bad.join('; ') : negatives.filter((n) => !n.expectImage).length + ' inputs, all {error}');
  }

  // ================================================================ summary
  const fails = results.filter((r) => !r.ok);
  const byGroup = new Map();
  for (const r of results) {
    const g = byGroup.get(r.group) || { n: 0, bad: 0 };
    g.n++;
    if (!r.ok) g.bad++;
    byGroup.set(r.group, g);
  }
  console.log('');
  console.log('-- per group --');
  for (const [g, v] of byGroup) {
    const label = g + ': ' + (v.n - v.bad) + '/' + v.n + ' cases';
    console.log((v.bad ? '  [FAIL] ' : '  [ok  ] ') + label);
    if (v.bad) for (const r of results.filter((q) => q.group === g && !q.ok)) console.log('         · ' + r.label + ': ' + r.detail);
  }
  console.log('');
  console.log('summary : ' + results.length + ' cases (' + (results.length - fails.length) + ' pass) · ' +
    manifest.fixtures.length + ' PIL-oracle fixtures · worst max ' + worstMax + ' · worst mean ' + num(worstMean) +
    ' · tolerance max ' + tolMax + ' / mean ' + tolMean);
  console.log('');
  if (fails.length) {
    const first = fails[0];
    console.log('FAIL check-jpeg: ' + fails.length + '/' + results.length + ' cases failed — first: ' + first.label + ': ' + first.detail);
    return 1;
  }
  console.log('PASS check-jpeg: ' + results.length + ' cases, ' + manifest.fixtures.length + ' fixtures against PIL ' +
    ' (worst max channel difference ' + worstMax + ', worst mean ' + num(worstMean) + ', tolerance ' + tolMax + '/' + tolMean + ')');
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.log('');
  console.log('FAIL check-jpeg: harness error — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  process.exit(1);
}
