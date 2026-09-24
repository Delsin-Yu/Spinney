/**
 * jpegReconstruct.ts — the back half of the JPEG decoder: dequantize, IDCT, upsample,
 * colour-convert. Given the same coefficients it must always produce the same pixels.
 *
 * The three details that decide whether the output is *right* rather than merely
 * plausible, and the ones its guard checks:
 *
 *  - **dequantize before the IDCT**, with the table entry the component named (`tq`);
 *  - **chroma upsampling by repetition** (each chroma sample covers `maxH/h × maxV/v`
 *    luma samples) — the standard "box" filter for baseline files, not a bilinear guess
 *    that would soften everything;
 *  - **YCbCr → RGB with clamping**, and grey (`1`-component) files expanded to RGBA with
 *    alpha 255.
 *
 * Pure, `vscode`-free: `tools/check-jpeg.js` drives it, with PIL as the oracle.
 */

import type { JpegCoefficients } from './jpegEntropy';

/** Decoded pixels: `data` is RGBA, `width * height * 4` bytes, row-major. */
export interface JpegPixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * `C(u)·cos((2x+1)u·π/16)` for every (frequency, sample) pair — the separable kernel both
 * IDCT passes multiply by, built once at module load. `cos` is the only transcendental the
 * reconstruction needs, and calling it 64 times per block would dwarf the arithmetic it
 * feeds.
 */
const BASIS: Float64Array = (() => {
  const table = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const scale = u === 0 ? Math.SQRT1_2 : 1; // C(0) = 1/√2, C(k) = 1
    for (let x = 0; x < 8; x++) {
      table[u * 8 + x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
    }
  }
  return table;
})();

/**
 * The maths' single exit: already rounded, then held to a byte. Kept apart from the
 * transform so the two places that need it — the flat-block shortcut and the row pass —
 * cannot drift apart.
 */
function clamp8(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Turn quantized coefficients into RGBA pixels. Never throws for a well-formed
 * coefficient set: 1 component is grey, 3 is YCbCr, anything else is refused by the
 * caller (`jpegDecode.ts`) before this runs.
 *
 * Shape: each plane is decoded **a block row at a time** into its own band buffer, and the
 * output rows that fall inside that block row are filled from it before it is replaced.
 * Every block is therefore transformed exactly once, only `count` small buffers exist at
 * any moment, and nothing shaped like a full plane is ever allocated — for a 4000×3000
 * photo that is a few hundred KB instead of ~18 MB on the single-threaded extension host.
 * The bands are also why the partial blocks at the right/bottom edge are safe: a sample
 * is read from a contiguous buffer at an index the geometry proved in range, so cropping
 * to `width`/`height` cannot walk into another plane.
 */
export function reconstructJpeg(coefficients: JpegCoefficients): JpegPixels {
  const components = coefficients.components;
  const quantTables = coefficients.quantTables;
  const planes = coefficients.planes;
  const blockCols = coefficients.blockCols;
  const blockRows = coefficients.blockRows;
  const width = coefficients.width;
  const height = coefficients.height;
  const maxH = coefficients.maxH;
  const maxV = coefficients.maxV;
  const count = components.length;

  // Everything below assumes the caller upheld its half of the seam (`jpegDecode.ts`
  // refuses non-baseline and non-grey/YCbCr files). A violation is a broken caller, not a
  // damaged file, so say what is wrong and stop rather than read past a plane and emit
  // plausible-looking garbage.
  if (!(width > 0) || !(height > 0)) {
    throw new Error(`jpegReconstruct: frame is ${width}x${height}`);
  }
  if (count !== 1 && count !== 3) {
    throw new Error(`jpegReconstruct: ${count} components, expected 1 (grey) or 3 (YCbCr)`);
  }
  if (!(maxH > 0) || !(maxV > 0)) {
    throw new Error(`jpegReconstruct: sampling factors ${maxH}x${maxV}`);
  }

  // Per component, everything the pixel loops index with, derived once.
  const sampleH = new Int32Array(count);
  const sampleV = new Int32Array(count);
  const blocksPerLine = new Int32Array(count);
  const bandStride = new Int32Array(count);
  const quantOf: Uint16Array[] = [];
  const planeOf: Int16Array[] = [];
  const bands: Uint8Array[] = [];
  // Which block row each band currently holds, so a row of a plane is transformed once.
  const loadedRow = new Int32Array(count).fill(-1);

  for (let c = 0; c < count; c++) {
    const component = components[c];
    const h = component.h;
    const v = component.v;
    if (!(h > 0) || !(v > 0)) {
      throw new Error(`jpegReconstruct: component ${c} has sampling factors ${h}x${v}`);
    }
    const cols = blockCols[c];
    const rows = blockRows[c];
    if (!(cols > 0) || !(rows > 0)) {
      throw new Error(`jpegReconstruct: component ${c} has a ${cols}x${rows} block grid`);
    }
    const plane = planes[c];
    const needed = cols * rows * 64;
    if (!plane || plane.length < needed) {
      throw new Error(
        `jpegReconstruct: component ${c} carries ${plane ? plane.length : 0} coefficients, ` +
          `the ${cols}x${rows} block grid needs ${needed}`,
      );
    }
    const quant = quantTables[component.quantTable];
    if (!quant || quant.length < 64) {
      throw new Error(
        `jpegReconstruct: component ${c} names quantisation table ${component.quantTable}, ` +
          'which this frame does not carry',
      );
    }
    // The block grid may overhang the frame — that is the padding every non-multiple-of-8
    // size carries — but it must at least cover it, or the sampling below would read past
    // the band.
    const occupiedW = Math.ceil((width * h) / maxH);
    const occupiedH = Math.ceil((height * v) / maxV);
    if (cols * 8 < occupiedW || rows * 8 < occupiedH) {
      throw new Error(
        `jpegReconstruct: component ${c} covers ${cols * 8}x${rows * 8} samples, ` +
          `the frame needs ${occupiedW}x${occupiedH} of it`,
      );
    }
    sampleH[c] = h;
    sampleV[c] = v;
    blocksPerLine[c] = cols;
    bandStride[c] = cols * 8;
    quantOf.push(quant);
    planeOf.push(plane);
    bands.push(new Uint8Array(cols * 64));
  }

  // Two 8×8 doubles, reused by every block: the dequantized coefficients and the
  // half-transformed result. Dequantizing in place would let the column pass overwrite a
  // coefficient before it had been read, hence the second array.
  const coeff = new Float64Array(64);
  const half = new Float64Array(64);

  function loadBand(c: number, blockRow: number): void {
    const plane = planeOf[c];
    const quant = quantOf[c];
    const band = bands[c];
    const stride = bandStride[c];
    const perLine = blocksPerLine[c];
    for (let block = 0; block < perLine; block++) {
      const base = (blockRow * perLine + block) * 64;
      let ac = false;
      for (let k = 0; k < 64; k++) {
        const value = plane[base + k] * quant[k];
        coeff[k] = value;
        if (k > 0 && value !== 0) ac = true;
      }
      const column = block * 8;
      if (!ac) {
        // Only the DC coefficient survived the quantiser, so the block is flat and the
        // IDCT is a division: f = F(0,0)/8 everywhere (C(0)C(0) = 1/2, two half-passes).
        // Smooth areas are all flat blocks, so skipping both passes here pays for the test
        // many times over.
        const flat = clamp8((coeff[0] / 8 + 128.5) | 0);
        for (let y = 0; y < 8; y++) {
          const at = y * stride + column;
          band.fill(flat, at, at + 8);
        }
        continue;
      }
      // Column pass: fold the eight horizontal frequencies of each coefficient row into
      // eight samples. Half of the formula's 1/4 lives here, the other half below.
      for (let v = 0; v < 8; v++) {
        const row = v * 8;
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let u = 0; u < 8; u++) sum += BASIS[u * 8 + x] * coeff[row + u];
          half[row + x] = sum * 0.5;
        }
      }
      // Row pass: the same transform down each column of the intermediate, written
      // straight into the band as bytes — rounded, level-shifted and clamped pixels are
      // the only form a sample ever needs to take.
      for (let y = 0; y < 8; y++) {
        const at = y * stride + column;
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let v = 0; v < 8; v++) sum += BASIS[v * 8 + y] * half[v * 8 + x];
          band[at + x] = clamp8((sum * 0.5 + 128.5) | 0);
        }
      }
    }
  }

  // The one output allocation. Both colour paths below fill it row by row; the sample row
  // an output row reads is `floor(y * v / maxV)`, and its block row is that over 8.
  const data = new Uint8Array(width * height * 4);

  if (count === 1) {
    const band = bands[0];
    const stride = bandStride[0];
    const h = sampleH[0];
    const v = sampleV[0];
    for (let y = 0; y < height; y++) {
      const sampleRow = ((y * v) / maxV) | 0;
      const blockRow = sampleRow >> 3;
      if (blockRow !== loadedRow[0]) {
        loadBand(0, blockRow);
        loadedRow[0] = blockRow;
      }
      const rowAt = (sampleRow & 7) * stride;
      let at = y * width * 4;
      for (let x = 0; x < width; x++) {
        // `x * h / maxH` is non-negative and small, so `| 0` is exactly Math.floor here;
        // for grey files h = maxH and this is the identity, but a luma plane is allowed to
        // be subsampled and must be expanded the same way chroma is.
        const value = band[rowAt + (((x * h) / maxH) | 0)];
        data[at++] = value;
        data[at++] = value;
        data[at++] = value;
        data[at++] = 255; // grey carries no alpha channel; the output always has one
      }
    }
    return { width, height, data };
  }

  const yBand = bands[0];
  const cbBand = bands[1];
  const crBand = bands[2];
  const yStride = bandStride[0];
  const cbStride = bandStride[1];
  const crStride = bandStride[2];
  const yH = sampleH[0];
  const yV = sampleV[0];
  const cbH = sampleH[1];
  const cbV = sampleV[1];
  const crH = sampleH[2];
  const crV = sampleV[2];

  for (let y = 0; y < height; y++) {
    // Each plane advances on its own schedule (4:2:0 moves chroma every other row), but
    // all of them are monotone in y, so a band is still loaded exactly once per block row.
    const yRow = ((y * yV) / maxV) | 0;
    const cbRow = ((y * cbV) / maxV) | 0;
    const crRow = ((y * crV) / maxV) | 0;
    if (yRow >> 3 !== loadedRow[0]) {
      loadBand(0, yRow >> 3);
      loadedRow[0] = yRow >> 3;
    }
    if (cbRow >> 3 !== loadedRow[1]) {
      loadBand(1, cbRow >> 3);
      loadedRow[1] = cbRow >> 3;
    }
    if (crRow >> 3 !== loadedRow[2]) {
      loadBand(2, crRow >> 3);
      loadedRow[2] = crRow >> 3;
    }
    const yAt = (yRow & 7) * yStride;
    const cbAt = (cbRow & 7) * cbStride;
    const crAt = (crRow & 7) * crStride;
    let at = y * width * 4;
    for (let x = 0; x < width; x++) {
      // Upsampling by repetition: every luma sample takes the chroma sample that covers
      // it, `floor(x * h / maxH)` — the box filter a baseline file's sampling factors
      // describe, not a bilinear guess that would invent chroma the encoder never sent.
      const luma = yBand[yAt + (((x * yH) / maxH) | 0)];
      const cb = cbBand[cbAt + (((x * cbH) / maxH) | 0)] - 128;
      const cr = crBand[crAt + (((x * crH) / maxH) | 0)] - 128;
      // The coefficients JFIF specifies (BT.601, full-range luma, chroma centred on 128),
      // clamped to a byte — the circles in a JPEG's reds are this line's fault, not a bug.
      const r = luma + 1.402 * cr;
      const g = luma - 0.344136 * cb - 0.714136 * cr;
      const b = luma + 1.772 * cb;
      data[at++] = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
      data[at++] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
      data[at++] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
      data[at++] = 255;
    }
  }
  return { width, height, data };
}
