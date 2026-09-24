/**
 * jpegDecode.ts — JPEG in, RGBA out: the orchestrator over the entropy half
 * (`jpegEntropy.ts`) and the reconstruction half (`jpegReconstruct.ts`).
 *
 * It exists so `imageTransform.ts` sees one call and one failure shape for both formats,
 * and so the scope rules live in exactly one place: **baseline sequential, 8-bit, 1 or 3
 * components**. Everything else is `{ error }` — the transform then passes the original
 * bytes through, and the per-request budget stays the backstop.
 *
 * Pure, `vscode`-free. The oracle is PIL: `tools/check-jpeg.js` decodes the same fixture
 * with both and compares pixels (see `docs/agents/plans/image-budget.md` §6 — a codec
 * must not certify itself).
 */

import type { DecodeFailure, DecodedImage } from './imageTransform';
import { decodeJpegEntropy, isCoefficients } from './jpegEntropy';
import { reconstructJpeg } from './jpegReconstruct';

/** The frame header, as far as the scope rules care about it. */
interface FrameHeader {
  /** The SOFn marker byte (0xc0 is the only one we accept). */
  marker: number;
  precision: number;
  width: number;
  height: number;
  components: number;
}

/** SOF0–SOF15 minus the three markers in that range that are not frame headers. */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** The marker's usual name, so a refusal can name what it actually found. */
function frameMarkerName(marker: number): string {
  switch (marker) {
    case 0xc0:
      return 'SOF0 (baseline sequential)';
    case 0xc1:
      return 'SOF1 (extended sequential)';
    case 0xc2:
      return 'SOF2 (progressive)';
    case 0xc3:
      return 'SOF3 (lossless)';
    case 0xc5:
    case 0xc6:
    case 0xc7:
      return 'SOF' + (marker - 0xc0) + ' (differential)';
    case 0xc9:
    case 0xca:
    case 0xcb:
      return 'SOF' + (marker - 0xc0) + ' (arithmetic)';
    case 0xcd:
    case 0xce:
    case 0xcf:
      return 'SOF' + (marker - 0xc0) + ' (differential arithmetic)';
    default:
      return 'SOF' + (marker - 0xc0);
  }
}

/**
 * The scope gate: walk the marker segments up to the frame header and answer whether
 * this really is a baseline sequential 8-bit file with 1 or 3 components. It is done
 * here, before the entropy walk, so the refusal always names the *reason* (progressive,
 * 12-bit, 4 components …) instead of whatever the entropy decoder tripped over first —
 * and so no second decoder in this folder has to grow the same rules.
 *
 * It reads headers only; the entropy half is still the authority on damage.
 */
function readFrameHeader(bytes: Uint8Array): FrameHeader | DecodeFailure {
  if (bytes.length < 4) {
    return { error: 'not a JPEG: the file is empty or too short.' };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { error: 'not a JPEG: no SOI marker at the start of the file.' };
  }
  let i = 2;
  while (i + 1 < bytes.length) {
    // Fill bytes (0xff before a marker) are legal; the marker is the first non-0xff.
    if (bytes[i] !== 0xff) {
      return { error: `damaged JPEG: expected a marker at offset ${i}.` };
    }
    while (i < bytes.length && bytes[i] === 0xff) {
      i++;
    }
    if (i >= bytes.length) {
      break;
    }
    const marker = bytes[i];
    i++;
    if (marker === 0xd9) {
      return { error: 'damaged JPEG: it ends before any frame header (SOF0).' };
    }
    if (marker === 0xda) {
      return { error: 'no JPEG frame header (SOF0) before the first scan.' };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue; // TEM and the standalone markers (RSTn, SOI) carry no length.
    }
    if (i + 1 >= bytes.length) {
      break;
    }
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) {
      return { error: `damaged JPEG: the segment at offset ${i} claims ${length} bytes.` };
    }
    if (isFrameMarker(marker)) {
      if (marker !== 0xc0) {
        return {
          error:
            `${frameMarkerName(marker)} is not supported: only baseline sequential (SOF0) JPEGs are decoded.`,
        };
      }
      if (length < 8) {
        return { error: 'damaged JPEG: the SOF0 segment is too short.' };
      }
      const precision = bytes[i + 2];
      const height = (bytes[i + 3] << 8) | bytes[i + 4];
      const width = (bytes[i + 5] << 8) | bytes[i + 6];
      const components = bytes[i + 7];
      if (precision !== 8) {
        return {
          error: `${precision}-bit JPEG is not supported: only 8-bit precision is decoded.`,
        };
      }
      if (components !== 1 && components !== 3) {
        return {
          error: `${components}-component JPEG is not supported: 1 (greyscale) or 3 (YCbCr) only.`,
        };
      }
      if (width === 0 || height === 0) {
        return { error: 'damaged JPEG: the frame header declares a size of 0.' };
      }
      if (length < 8 + 3 * components) {
        return { error: 'damaged JPEG: the SOF0 segment does not hold its components.' };
      }
      return { marker, precision, width, height, components };
    }
    i += length;
  }
  return { error: 'damaged JPEG: no frame header (SOF0) was found.' };
}

/**
 * Decode a baseline JPEG into RGBA. `{ error }` covers every refusal and every damaged
 * file; it never throws.
 *
 * The one place the scope lives: the frame header decides first (so the reason names the
 * variant), then the entropy half reads the coefficients, then the reconstruction half
 * turns them into pixels. A file that survives the first step but is damaged usually
 * fails in the second; a damaged file that only breaks the maths (a short plane, an
 * impossible table index) is caught by the `try` rather than escaping as a throw — and
 * the outer `try` means even a bug in one of the halves still reaches the caller as an
 * error sentence instead of taking the extension host down.
 */
export function decodeJpeg(bytes: Uint8Array): DecodedImage | DecodeFailure {
  try {
    return decodeBaseline(bytes);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { error: `JPEG decode failed: ${reason}` };
  }
}

function decodeBaseline(bytes: Uint8Array): DecodedImage | DecodeFailure {
  const header = readFrameHeader(bytes);
  if ('error' in header) {
    return header;
  }
  const coefficients = decodeJpegEntropy(bytes);
  if (!isCoefficients(coefficients)) {
    return { error: coefficients.error };
  }
  if (coefficients.width !== header.width || coefficients.height !== header.height) {
    return { error: 'damaged JPEG: the scan disagrees with the frame header about the size.' };
  }
  const pixels = reconstructJpeg(coefficients);
  if (
    pixels.width !== header.width ||
    pixels.height !== header.height ||
    pixels.data.length !== pixels.width * pixels.height * 4 ||
    pixels.data.length !== coefficients.width * coefficients.height * 4
  ) {
    return { error: 'damaged JPEG: the reconstruction returned an inconsistent buffer.' };
  }
  return pixels;
}
