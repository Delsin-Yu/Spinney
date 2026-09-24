/**
 * imageResample.ts — crop and downscale an RGBA buffer, in memory, deterministically.
 *
 * Two rules, both load-bearing:
 *
 *  - **Area average, never nearest** on downscale. These images are contact sheets whose
 *    tiles are judged by the model; nearest-neighbour thinning invents aliasing the model
 *    then reports as image content.
 *  - **Never upscale.** A crop smaller than the target is returned as it is: upscaling
 *    adds bytes without adding information, and the provider's flat per-image token cost
 *    means there is nothing to gain by filling the frame.
 *
 * Pure, `vscode`-free, `node:zlib` not even needed here: `tools/check-image.js` drives it.
 */

import type { Rect } from './imageTransform';

/** What a crop+resample produced: `data` is RGBA, `width * height * 4` bytes. */
export interface ResampleResult {
  width: number;
  height: number;
  data: Uint8Array;
  /** The factor applied (`min(1, target / longestSide)`), 1 when only cropped. */
  scale: number;
}

/**
 * `Math.floor(v)` for a usable number, else `fallback`: a rect that arrived as `NaN` or a
 * non-number must not propagate into an index, and the caller's normalisation is the
 * first line of defence, not the only one.
 */
function floorOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
}

/**
 * The source bytes with a guaranteed `width * height * 4` length. A truncated buffer (a
 * decoder bug, a caller passing a subarray) would otherwise read `undefined` and write
 * zeros at a random offset, which is exactly the garbage this module promises never to
 * produce. The copy happens only in that case.
 */
function rgbaBytes(data: Uint8Array, width: number, height: number): Uint8Array {
  const need = width * height * 4;
  if (data.length >= need) {
    return data;
  }
  const padded = new Uint8Array(need);
  padded.set(data.subarray(0, Math.min(data.length, need)));
  return padded;
}

/**
 * Crop `src` to `rect` (or the whole image when omitted) and, if the result's longest
 * side exceeds `targetMaxSide`, area-average it down to fit.
 *
 * `rect` is clamped to the source here too, and a degenerate/empty one falls back to the
 * whole image — a wrong rect must never read outside the buffer or come back as a frame
 * of garbage. The result never aliases `src.data`: an upload that shared the caller's
 * buffer would change under a later mutation of it.
 */
export function cropResample(
  src: { width: number; height: number; data: Uint8Array },
  rect: Rect | undefined,
  targetMaxSide: number,
): ResampleResult {
  const sw = src.width;
  const sh = src.height;
  // A source with no pixels cannot be cropped into anything: `0` is the honest size and
  // still keeps `width * height * 4` exact.
  if (!(sw >= 1) || !(sh >= 1)) {
    return { width: 0, height: 0, data: new Uint8Array(0), scale: 1 };
  }

  // ---- the kept region, clamped to the source ----
  // The intersection of `[x, x + w)` with the image, not a rejection: a rect hanging over a
  // side keeps the part that is inside (the model aims a coarse zoom and reads the result
  // text, so the clamped frame is the one it asked for). Both edges come from the
  // *requested* x, exactly as `normalizeRect` computes them, so a rect this module is
  // handed by any other caller is cropped the same way.
  const rx = rect ? floorOr(rect.x, 0) : 0;
  const ry = rect ? floorOr(rect.y, 0) : 0;
  const wantW = rect ? floorOr(rect.w, sw) : sw;
  const wantH = rect ? floorOr(rect.h, sh) : sh;
  const x0 = Math.max(0, rx);
  const y0 = Math.max(0, ry);
  const croppedW = Math.min(sw, rx + Math.max(0, wantW)) - x0;
  const croppedH = Math.min(sh, ry + Math.max(0, wantH)) - y0;
  const empty = croppedW < 1 || croppedH < 1;
  const kx = empty ? 0 : x0;
  const ky = empty ? 0 : y0;
  const kw = empty ? sw : croppedW;
  const kh = empty ? sh : croppedH;

  // ---- the destination size ----
  // `Math.floor(v + 0.5)` is `Math.round` written out; the fixtures' Python oracle writes
  // it the same way (`int(v + 0.5)`), so the two agree digit for digit. A non-positive or
  // `NaN` target would make the size `NaN`, and one pixel is the smallest honest answer.
  const target = targetMaxSide > 0 ? targetMaxSide : 1;
  const scale = Math.min(1, target / Math.max(kw, kh));
  const dw = Math.max(1, Math.floor(kw * scale + 0.5));
  const dh = Math.max(1, Math.floor(kh * scale + 0.5));

  const data = rgbaBytes(src.data, sw, sh);

  if (dw === kw && dh === kh) {
    // The rounded destination equals the crop: nothing was resampled, so `scale` is
    // reported as exactly 1 rather than the 0.997 that produced the same size. A caller
    // reading `scale` can then trust it as "this is the crop, untouched". The copy is also
    // what keeps the result from aliasing the source.
    const out = new Uint8Array(kw * kh * 4);
    const stride = kw * 4;
    for (let y = 0; y < kh; y++) {
      const from = ((ky + y) * sw + kx) * 4;
      out.set(data.subarray(from, from + stride), y * stride);
    }
    return { width: kw, height: kh, data: out, scale: 1 };
  }

  // ---- exact area average, integer coverage weights ----
  // For destination column j and source column i:
  //   wx = max(0, min((i+1)*dw, (j+1)*sw) - max(i*dw, j*sw))     (the same for wy over dh/sh)
  // in units of 1/dw of a source pixel, so the weights are exact integers and the value is
  //   round_half_up( sum_i sum_k wx*wy*v / (sw*sh) ).
  // Coverage weights, and not a plain box average, are what a NON-INTEGER factor needs: at
  // scale 0.4 every destination pixel straddles four source pixels with different shares,
  // and counting them equally (PIL's BOX, or "take every 2.5th column") biases the result
  // toward the whole-pixel positions — the weights are the only way the average is the true
  // area of the region the destination pixel covers, which is why the guard can compare a
  // 0.4 factor against an independent oracle pixel for pixel.
  // Both axes sum to sw and sh, so each destination pixel's weights sum to sw*sh and the
  // divisor is just the crop's source pixel count. Every intermediate is an exact integer
  // in float64: one destination pixel's weighted sum is at most 255*sw*sh (well below
  // 2^53 for any image this harness meets), so the single division is the only rounding.
  const colIdx: Int32Array[] = new Array(dw);
  const colWt: Int32Array[] = new Array(dw);
  for (let j = 0; j < dw; j++) {
    const idx: number[] = [];
    const wt: number[] = [];
    const lo = Math.floor((j * kw) / dw);
    const hi = Math.ceil(((j + 1) * kw) / dw);
    for (let i = lo; i < hi && i < kw; i++) {
      const cover = Math.min((i + 1) * dw, (j + 1) * kw) - Math.max(i * dw, j * kw);
      if (cover > 0) {
        idx.push(i);
        wt.push(cover);
      }
    }
    colIdx[j] = Int32Array.from(idx);
    colWt[j] = Int32Array.from(wt);
  }
  const rowIdx: Int32Array[] = new Array(dh);
  const rowWt: Int32Array[] = new Array(dh);
  for (let j = 0; j < dh; j++) {
    const idx: number[] = [];
    const wt: number[] = [];
    const lo = Math.floor((j * kh) / dh);
    const hi = Math.ceil(((j + 1) * kh) / dh);
    for (let i = lo; i < hi && i < kh; i++) {
      const cover = Math.min((i + 1) * dh, (j + 1) * kh) - Math.max(i * dh, j * kh);
      if (cover > 0) {
        idx.push(i);
        wt.push(cover);
      }
    }
    rowIdx[j] = Int32Array.from(idx);
    rowWt[j] = Int32Array.from(wt);
  }

  const out = new Uint8Array(dw * dh * 4);
  const acc = new Float64Array(dw * 4);
  const den = kw * kh;
  const srcStride = sw * 4;
  for (let jy = 0; jy < dh; jy++) {
    acc.fill(0);
    const rows = rowIdx[jy];
    const rowWeights = rowWt[jy];
    // Only the source rows this destination row's window covers, so the cost stays linear
    // in the crop's pixels: a 4000x3000 sheet is ~12 M integer multiply-adds, not 12 M per
    // destination column. This function is sync by contract and so cannot yield to the
    // event loop; a measured blocked second here would move the codec to a worker thread
    // (`docs/agents/plans/image-budget.md` §6).
    for (let k = 0; k < rows.length; k++) {
      const wy = rowWeights[k];
      const srcBase = (ky + rows[k]) * srcStride;
      for (let jx = 0; jx < dw; jx++) {
        const cols = colIdx[jx];
        const colWeights = colWt[jx];
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let m = 0; m < cols.length; m++) {
          const w = colWeights[m] * wy;
          const p = srcBase + (kx + cols[m]) * 4;
          r += w * data[p];
          g += w * data[p + 1];
          b += w * data[p + 2];
          a += w * data[p + 3];
        }
        const q = jx * 4;
        acc[q] += r;
        acc[q + 1] += g;
        acc[q + 2] += b;
        acc[q + 3] += a;
      }
    }
    // One division, then round half-up. All four channels average alike, alpha included
    // and un-premultiplied: the oracle (and PIL's own reduce) is straight-alpha too.
    const outBase = jy * dw * 4;
    for (let q = 0; q < dw * 4; q++) {
      out[outBase + q] = Math.round(acc[q] / den);
    }
  }
  return { width: dw, height: dh, data: out, scale };
}
