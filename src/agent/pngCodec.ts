/**
 * pngCodec.ts — a minimal PNG decoder and encoder, on `node:zlib` alone.
 *
 * Why hand-written: the extension ships **no runtime dependency** at all
 * (`invariants/vendored-deps.md`), and PNG is the format this harness actually meets —
 * generated stills, screenshots, contact sheets. What it must do is narrow and defined:
 *
 *  - **decode**: 8-bit, non-interlaced, colour types 0 (grey), 2 (RGB), 3 (palette),
 *    4 (grey+alpha), 6 (RGBA), every filter (0–4), tRNS for the palette case. Anything
 *    else (16-bit, 1/2/4-bit, interlaced) is refused with a reason — the caller passes
 *    the original bytes through instead of guessing.
 *  - **encode**: 8-bit RGB or RGBA, non-interlaced, with adaptive per-row filtering
 *    (the minimum-sum-of-absolute-differences heuristic) because these bytes are the
 *    whole point.
 *
 * Pure, `vscode`-free, no `crypto`: `tools/check-image.js` drives it from plain node.
 * Fixtures live in `tools/fixtures/image/` and were produced by an **independent** tool
 * (PIL), never by this module.
 */

import * as zlib from 'node:zlib';
import { promisify } from 'node:util';

import { crc32, readU32BE } from './types';
import type { DecodeFailure, DecodedImage } from './imageTransform';

// The pixel shape is shared with the JPEG half: one `DecodedImage` for both formats, so
// `imageTransform.ts` never has to know which decoder produced the buffer.
export type { DecodeFailure, DecodedImage };

/**
 * The async `node:zlib` forms, always: a `*Sync` inflate/deflate of a multi-megabyte
 * sheet blocks the extension host's only thread for as long as it takes, which is the
 * blocked second `session-persistence.md` counts as a bug.
 */
const inflateAsync = promisify(zlib.inflate) as unknown as (buffer: Uint8Array) => Promise<Buffer>;
const deflateAsync = promisify(zlib.deflate) as unknown as (
  buffer: Uint8Array,
  options: { level: number },
) => Promise<Buffer>;

/**
 * Rows between two `setImmediate` yields inside this module's per-row loops.
 *
 * WHY this value: the host is single-threaded, and 4000×3000 is 12M pixels — unfiltering
 * or filtering that in one uninterrupted pass *is* the stall `docs/agents/plans/
 * image-budget.md` §6 names. 64 rows makes that impossible: even a 4000-px-wide RGBA row
 * is 16 KiB, so the work between two yields stays around 1 MiB (well under a frame),
 * while the `setImmediate` overhead — one event-loop turn per 64 rows, i.e. ~47 for a
 * 3000-row image — is negligible next to the row work itself.
 */
export const PNG_YIELD_ROWS = 64;

/** PNG magic. Byte-compared explicitly so a short file cannot read past its end. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Chunk types as big-endian u32s, so the walk compares one number instead of 4 bytes. */
const CHUNK_IHDR = 0x49484452;
const CHUNK_PLTE = 0x504c5445;
const CHUNK_IDAT = 0x49444154;
const CHUNK_IEND = 0x49454e44;
const CHUNK_TRNS = 0x74524e53;

/** Samples per pixel at bit depth 8, by colour type. Anything absent is refused. */
const CHANNELS: { [colourType: number]: number } = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Deflate level for the IDAT stream. 9, not the default 6: the encoded bytes are the
 * whole point of this slice (they are what the request carries, §1), an encode happens
 * once per attached image, and the extra search cost is bounded by the pixel count we
 * just walked anyway. Measured against PIL's own encoder by `tools/check-png.js`.
 */
const PNG_DEFLATE_LEVEL = 9;

/** Yield to the event loop (never `await` anything else here — order must not matter). */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** The PNG Paeth predictor, shared by the unfilter (decode) and the filter (encode). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** A chunk type as printable text, for a reason string that came from a corrupt file. */
function chunkName(type: number): string {
  let out = '';
  for (let i = 3; i >= 0; i--) {
    const code = (type >>> (i * 8)) & 0xff;
    out += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : '?';
  }
  return out;
}

/** Big-endian u32 write — `types.ts` only exports the read half. */
function writeU32BE(bytes: Uint8Array, off: number, value: number): void {
  bytes[off] = (value >>> 24) & 0xff;
  bytes[off + 1] = (value >>> 16) & 0xff;
  bytes[off + 2] = (value >>> 8) & 0xff;
  bytes[off + 3] = value & 0xff;
}

/** Concatenate the IDAT parts (a valid PNG may split the stream into several chunks). */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Everything a decode needs, as read from the chunk walk. */
interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlace: number;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  /** The concatenated IDAT payload, still deflated. */
  idat: Uint8Array;
}

/**
 * Walk the chunk list once, verifying **every** CRC as it goes. Stops at IEND, so
 * trailing garbage after the terminator is ignored the way every other reader does.
 */
function parseChunks(bytes: Uint8Array): { info?: PngInfo; error?: string } {
  let off = 8;
  let sawIhdr = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  for (;;) {
    if (off + 8 > bytes.length) {
      return {
        error: off >= bytes.length
          ? 'truncated PNG (no IEND chunk)'
          : 'truncated PNG (a chunk header is cut short)',
      };
    }
    const chunkStart = off;
    const length = readU32BE(bytes, off);
    const type = readU32BE(bytes, off + 4);
    const dataStart = off + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      return { error: `truncated PNG (the ${chunkName(type)} chunk overruns the file)` };
    }
    // CRC over the type + data, before anything in the chunk is trusted.
    if (readU32BE(bytes, dataEnd) !== crc32(bytes.subarray(off + 4, dataEnd))) {
      return { error: `corrupt PNG (bad CRC in the ${chunkName(type)} chunk)` };
    }
    off = dataEnd + 4;

    if (type === CHUNK_IHDR) {
      if (chunkStart !== 8) return { error: 'malformed PNG (IHDR is not the first chunk)' };
      if (sawIhdr) return { error: 'malformed PNG (a second IHDR chunk)' };
      if (length !== 13) return { error: `malformed PNG (IHDR is ${length} bytes, not 13)` };
      width = readU32BE(bytes, dataStart);
      height = readU32BE(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colourType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
      sawIhdr = true;
    } else if (type === CHUNK_PLTE) {
      palette = bytes.subarray(dataStart, dataEnd);
    } else if (type === CHUNK_TRNS) {
      transparency = bytes.subarray(dataStart, dataEnd);
    } else if (type === CHUNK_IDAT) {
      if (!sawIhdr) return { error: 'malformed PNG (IDAT before IHDR)' };
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === CHUNK_IEND) {
      if (!sawIhdr) return { error: 'malformed PNG (IEND before IHDR)' };
      if (idat.length === 0) return { error: 'truncated PNG (no IDAT chunk before IEND)' };
      return {
        info: {
          width, height, bitDepth, colourType, interlace,
          palette, transparency, idat: concat(idat),
        },
      };
    } else if (!sawIhdr) {
      return { error: `malformed PNG (${chunkName(type)} before IHDR)` };
    }
    // Any other chunk (gAMA, sRGB, pHYs …) is skipped: the walk only needs pixels.
  }
}

/** The tRNS colour key of colour types 0/2: one 16-bit sample each, low byte used. */
function colourKey(transparency: Uint8Array | undefined, samples: number): number[] | undefined {
  if (!transparency || transparency.length < samples * 2) return undefined;
  const key: number[] = [];
  // We decode 8-bit, and a colour key is compared against the *sample*: for an 8-bit
  // image the file's 16-bit key carries it in the low byte (the high byte is 0).
  for (let i = 0; i < samples; i++) key.push(transparency[i * 2 + 1]);
  return key;
}

/** Unfilter every row and expand it to RGBA, yielding to the event loop every N rows. */
async function unfilterAndExpand(
  info: PngInfo,
  raw: Uint8Array,
): Promise<DecodedImage | DecodeFailure> {
  const { width, height, colourType } = info;
  const channels = CHANNELS[colourType];
  const rowBytes = width * channels;
  const out = new Uint8Array(width * height * 4);
  const cur = new Uint8Array(rowBytes);
  const prev = new Uint8Array(rowBytes);
  const bpp = channels; // one byte per sample at bit depth 8

  const palette = info.palette;
  const trns = info.transparency;
  const paletteEntries = palette ? Math.floor(palette.length / 3) : 0;
  const greyKey = colourType === 0 ? colourKey(trns, 1)?.[0] : undefined;
  const rgbKey = colourType === 2 ? colourKey(trns, 3) : undefined;

  for (let y = 0; y < height; y++) {
    const base = y * (rowBytes + 1);
    const filter = raw[base];
    if (filter > 4) return { error: `corrupt PNG (unknown row filter ${filter} on row ${y})` };
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const x = raw[base + 1 + i];
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else value = x + paeth(a, b, c);
      cur[i] = value & 0xff;
    }

    const dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      const at = dst + x * 4;
      if (colourType === 0) {
        const grey = cur[x];
        out[at] = grey;
        out[at + 1] = grey;
        out[at + 2] = grey;
        out[at + 3] = greyKey !== undefined && grey === greyKey ? 0 : 255;
      } else if (colourType === 2) {
        const r = cur[x * 3];
        const g = cur[x * 3 + 1];
        const b = cur[x * 3 + 2];
        out[at] = r;
        out[at + 1] = g;
        out[at + 2] = b;
        out[at + 3] = rgbKey && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2] ? 0 : 255;
      } else if (colourType === 3) {
        const index = cur[x];
        if (!palette || index >= paletteEntries) {
          return { error: `corrupt PNG (palette index ${index} is out of range on row ${y})` };
        }
        out[at] = palette[index * 3];
        out[at + 1] = palette[index * 3 + 1];
        out[at + 2] = palette[index * 3 + 2];
        // A tRNS shorter than the palette leaves the tail entries opaque.
        out[at + 3] = trns && index < trns.length ? trns[index] : 255;
      } else if (colourType === 4) {
        const grey = cur[x * 2];
        out[at] = grey;
        out[at + 1] = grey;
        out[at + 2] = grey;
        out[at + 3] = cur[x * 2 + 1];
      } else {
        out[at] = cur[x * 4];
        out[at + 1] = cur[x * 4 + 1];
        out[at + 2] = cur[x * 4 + 2];
        out[at + 3] = cur[x * 4 + 3];
      }
    }

    prev.set(cur);
    if ((y + 1) % PNG_YIELD_ROWS === 0 && y + 1 < height) await yieldToEventLoop();
  }

  return { width, height, data: out };
}

async function decodeInner(bytes: Uint8Array): Promise<DecodedImage | DecodeFailure> {
  if (bytes.length < PNG_SIGNATURE.length) {
    return { error: 'not a PNG (shorter than the 8-byte signature)' };
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return { error: 'not a PNG (bad signature)' };
  }

  const parsed = parseChunks(bytes);
  if (!parsed.info) return { error: parsed.error ?? 'unreadable PNG' };
  const info = parsed.info;

  if (info.bitDepth !== 8) {
    return { error: `unsupported ${info.bitDepth}-bit PNG (this decoder reads 8-bit only)` };
  }
  if (info.interlace !== 0) {
    return { error: 'interlaced PNG (Adam7) is not supported' };
  }
  const channels = CHANNELS[info.colourType];
  if (channels === undefined) {
    return { error: `unsupported PNG colour type ${info.colourType} (0/2/3/4/6 only)` };
  }
  if (info.width === 0 || info.height === 0) {
    return { error: `malformed PNG (${info.width}x${info.height} is empty)` };
  }

  const expected = (info.width * channels + 1) * info.height;
  let raw: Uint8Array;
  try {
    raw = await inflateAsync(info.idat);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `corrupt PNG (the IDAT deflate stream is unreadable: ${detail})` };
  }
  if (raw.length !== expected) {
    // The scanline count is fixed by IHDR, so a different length means the file lied:
    // a short stream would silently leave rows black, a long one hides trailing data.
    const edge = raw.length < expected ? 'truncated' : 'oversized';
    return {
      error:
        `corrupt PNG (IDAT inflates to ${raw.length} bytes, expected ${expected}` +
        ` — ${edge} image data)`,
    };
  }

  return unfilterAndExpand(info, raw);
}

/**
 * Decode a PNG into RGBA. Returns a reason instead of throwing when the file is
 * well-formed but uses a variant this decoder does not implement.
 */
export async function decodePng(bytes: Uint8Array): Promise<DecodedImage | DecodeFailure> {
  try {
    return await decodeInner(bytes);
  } catch (err) {
    // The contract is a reason string, never a throw: `transformImage` passes the
    // original bytes through on `{ error }`, and a crash would take the tool call with it.
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `unreadable PNG (${detail})` };
  }
}

/** True when every alpha byte is 255 — an RGBA image that needs no alpha channel. */
function isOpaque(pixels: Uint8Array, count: number): boolean {
  for (let i = 3; i < count; i += 4) {
    if (pixels[i] !== 255) return false;
  }
  return true;
}

/** One PNG chunk: length + type + data + CRC (over type + data). */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32BE(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeU32BE(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode RGBA (or RGB, when `alpha` is false) as a non-interlaced 8-bit PNG.
 */
export async function encodePng(
  image: DecodedImage,
  options?: { alpha?: boolean },
): Promise<Uint8Array> {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`encodePng: bad image size ${width}x${height}`);
  }
  const pixels = image.data;
  const rgba = pixels.length === width * height * 4;
  if (!rgba && pixels.length !== width * height * 3) {
    throw new Error(
      `encodePng: data is ${pixels.length} bytes, expected ${width * height * 4} (RGBA)`,
    );
  }
  // No `alpha` option means "as few channels as the pixels allow": an image that is
  // wholly opaque has nothing to gain from an alpha channel the model would never see.
  const keepAlpha = options?.alpha ?? !(rgba && isOpaque(pixels, pixels.length));
  const channels = keepAlpha ? 4 : 3;
  const colourType = keepAlpha ? 6 : 2;
  const rowBytes = width * channels;
  const bpp = channels; // one byte per sample at bit depth 8
  const srcStride = rgba ? 4 : 3;

  const raw = new Uint8Array((rowBytes + 1) * height);
  const cur = new Uint8Array(rowBytes);
  const prev = new Uint8Array(rowBytes);
  const candidates: Uint8Array[] = [];
  for (let k = 0; k < 5; k++) candidates.push(new Uint8Array(rowBytes));

  for (let y = 0; y < height; y++) {
    const src = y * width * srcStride;
    if (channels === 3) {
      if (rgba) {
        for (let x = 0; x < width; x++) {
          cur[x * 3] = pixels[src + x * 4];
          cur[x * 3 + 1] = pixels[src + x * 4 + 1];
          cur[x * 3 + 2] = pixels[src + x * 4 + 2];
        }
      } else {
        cur.set(pixels.subarray(src, src + rowBytes));
      }
    } else if (rgba) {
      cur.set(pixels.subarray(src, src + rowBytes));
    } else {
      // RGB input asked for an alpha channel: the missing samples are opaque.
      for (let x = 0; x < width; x++) {
        cur[x * 4] = pixels[src + x * 3];
        cur[x * 4 + 1] = pixels[src + x * 3 + 1];
        cur[x * 4 + 2] = pixels[src + x * 3 + 2];
        cur[x * 4 + 3] = 255;
      }
    }

    // Adaptive filtering, the whole point of this encoder: build all five candidates,
    // score each by the minimum-sum-of-absolute-differences heuristic, keep the smallest.
    let best = 0;
    let bestScore = Infinity;
    for (let k = 0; k < 5; k++) {
      const filtered = candidates[k];
      let score = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const sample = cur[i];
        let value: number;
        if (k === 0) value = sample;
        else if (k === 1) value = sample - a;
        else if (k === 2) value = sample - b;
        else if (k === 3) value = sample - ((a + b) >> 1);
        else value = sample - paeth(a, b, c);
        value &= 0xff;
        filtered[i] = value;
        // The heuristic scores the filtered bytes as SIGNED (PNG spec 12.8, libpng's
        // `png_write_find_filter`): 0xfe means -2, so it contributes 2, not 254.
        score += value < 128 ? value : 256 - value;
      }
      // Strict `<` keeps the lowest filter number on a tie, as the spec requires.
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    const base = y * (rowBytes + 1);
    raw[base] = best;
    raw.set(candidates[best], base + 1);

    prev.set(cur);
    if ((y + 1) % PNG_YIELD_ROWS === 0 && y + 1 < height) await yieldToEventLoop();
  }

  const compressed = await deflateAsync(raw, { level: PNG_DEFLATE_LEVEL });

  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colourType;
  ihdr[10] = 0; // compression method: deflate, the only one defined
  ihdr[11] = 0; // filter method: the only one defined
  ihdr[12] = 0; // interlace: none

  // IHDR + one IDAT + IEND, no ancillary chunk: the provider only wants pixels, and
  // every extra chunk is bytes the request pays for (§1).
  const signature = new Uint8Array(PNG_SIGNATURE);
  return concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

/** Narrow a decode result without a cast at every call site. */
export function isDecoded(value: DecodedImage | DecodeFailure): value is DecodedImage {
  return (value as DecodeFailure).error === undefined;
}
