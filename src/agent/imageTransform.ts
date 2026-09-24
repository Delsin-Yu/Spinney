/**
 * imageTransform.ts — what actually leaves for the provider, decided **before** the
 * upload.
 *
 * The vendored endpoint resizes every image to about 800×800 and charges a flat ~384
 * tokens for it (`invariants/vision-images.md`), so the pixels above that are thrown
 * away server-side — while the *bytes* we upload are what the request carries and what
 * the provider caps (200 MB per request; see `docs/agents/plans/image-budget.md`). A
 * client-side downscale therefore loses nothing the model would have seen, and an
 * optional `rect` turns the flat per-image token cost into a zoom.
 *
 * Pure and `vscode`-free (plus `node:zlib` inside the codec modules) so a plain-node
 * guard can drive it: `tools/check-image.js`.
 */

import { cropResample } from './imageResample';
import { decodeJpeg } from './jpegDecode';
import { decodePng, encodePng, isDecoded } from './pngCodec';
import { readU32BE } from './types';

/** A region of an image, in **source pixels**. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixels any decoder in this folder hands back: RGBA, row-major, `width * height * 4`. */
export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A decode that could not run: the reason is for the caller's log, never for the model. */
export interface DecodeFailure {
  error: string;
}

/**
 * What produced the bytes behind one uploaded image: the transform, recorded beside the
 * message (never inside a content part), so the budget is computable exactly and a copied
 * chain can rebuild the **same view** instead of inlining the raw source file.
 */
export interface ImageTransformRecord {
  /** The part of the source that was kept, when a `rect` was applied. */
  rect?: Rect;
  targetMaxSide: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}

/**
 * The longest side an image is reduced to. Deliberately above the ~800 px the endpoint
 * applies, so the server's own resize is a no-op for anything we send and a slightly
 * different server rule cannot cost the model detail. A measurement settles it
 * (`docs/agents/plans/image-budget.md` §6).
 */
export const IMAGE_TARGET_MAX_SIDE = 1024;

/** The outcome of one transform, whether or not it changed anything. */
export interface TransformOutcome {
  /** The bytes to upload: the transformed image, or the input when `changed` is false. */
  bytes: Uint8Array;
  mime: string;
  /** The result's own pixel size. */
  width: number;
  height: number;
  /** The source's pixel size, so the caller can report it (and the model can aim a rect). */
  sourceWidth: number;
  sourceHeight: number;
  /** The part of the source that was kept, when a `rect` was applied. */
  rect?: Rect;
  /** ≤ 1: 1 means "not resampled" (a crop that already fits, or nothing done). */
  scale: number;
  /** False ⇒ `bytes` is the input, verbatim. */
  changed: boolean;
  /** Why nothing changed (an unsupported variant, an already-small image), for the log. */
  reason?: string;
}

/** The PNG signature, byte-compared so a short file cannot read past its end. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** `IHDR` as a big-endian u32, so the header walk compares one number. */
const CHUNK_IHDR = 0x49484452;

/**
 * Rows between two `setImmediate` yields: the codec's own granularity
 * (`PNG_YIELD_ROWS` in `pngCodec.ts`, documented there). This module yields **around** the
 * resample rather than inside it, because `cropResample` is synchronous by contract — so
 * the two yield points here are "before the CPU-bound step" and "after it", which is what
 * keeps a caller's log line and repaint from waiting behind 12 M pixels.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Lower-case the mime and drop any parameters (`image/png; charset=binary`). */
function normaliseMime(mime: string): string {
  const semi = mime.indexOf(';');
  return (semi >= 0 ? mime.slice(0, semi) : mime).trim().toLowerCase();
}

/** PNG IHDR: width and height are the first two u32s of the first chunk. */
function pngHeaderSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  // 8 signature + 4 length + 4 type + 13 IHDR payload: anything shorter has no IHDR to read.
  if (bytes.length < 29) {
    return undefined;
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      return undefined;
    }
  }
  if (readU32BE(bytes, 8) !== 13 || readU32BE(bytes, 12) !== CHUNK_IHDR) {
    return undefined;
  }
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  // PNG caps a side at 2^31-1; 0 is not an image. Anything else is a corrupt header, and a
  // caller that printed it (or aimed a rect at it) would be quoting a number nobody read.
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    return undefined;
  }
  return { width, height };
}

/**
 * JPEG size, from the first SOFn segment. The walk is the marker list up to the scan:
 * standalone markers (SOI, RSTn, TEM) carry no length, SOS/EOI end the header, and every
 * other segment is skipped by its own big-endian length. Progressive files (SOF2) are
 * measured the same way — the *decoder* is what refuses them, not the header read, which
 * is exactly what lets the tool still report the source size of a file it will pass
 * through.
 */
function jpegHeaderSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let off = 2;
  while (off + 3 < bytes.length) {
    if (bytes[off] !== 0xff) {
      // Not at a marker: a damaged file, or padding before one. Resynchronise rather than
      // give up, because a false `undefined` costs the caller a source size it could read.
      off++;
      continue;
    }
    const marker = bytes[off + 1];
    if (marker === 0xff) {
      off++;
      continue;
    }
    off += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue; // standalone markers carry no payload
    }
    if (marker === 0xd9 || marker === 0xda) {
      return undefined; // EOI / start of scan: no SOF was found before the pixels
    }
    const length = (bytes[off] << 8) | bytes[off + 1];
    if (length < 2 || off + length > bytes.length) {
      return undefined;
    }
    // SOF0..SOF15, minus DHT (0xc4), JPG (0xc8) and DAC (0xcc), which share the range.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (length < 7) {
        return undefined;
      }
      const height = (bytes[off + 3] << 8) | bytes[off + 4];
      const width = (bytes[off + 5] << 8) | bytes[off + 6];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    off += length;
  }
  return undefined;
}

/**
 * The region `cropResample` will actually keep, computed here the same way it clamps, so
 * the recorded `rect` (the provenance a copied chain is rebuilt from) is a rect inside the
 * image even when the caller passed one that hangs over an edge.
 */
function keptRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.floor(rect.x) + Math.max(0, Math.floor(rect.w)));
  const y1 = Math.min(height, Math.floor(rect.y) + Math.max(0, Math.floor(rect.h)));
  return { x, y, w: Math.max(1, x1 - x), h: Math.max(1, y1 - y) };
}

/**
 * The pixel size of an image, read from its header alone (PNG IHDR, JPEG SOFn) — cheap
 * and synchronous, so `read_image` can validate a `rect` before decoding anything.
 * `undefined` for a format or a file this build cannot measure.
 */
export function readImageSize(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | undefined {
  const kind = normaliseMime(mime);
  if (kind === 'image/png') {
    return pngHeaderSize(bytes);
  }
  if (kind === 'image/jpeg' || kind === 'image/jpg') {
    return jpegHeaderSize(bytes);
  }
  // An unknown/absent mime: DeepSeek detects the format from the bytes anyway
  // (`detectImageMime`), so sniff the two signatures rather than answer nothing. GIF and
  // WebP are deliberately not measured here — they are never transformed, and a size the
  // caller cannot act on is just a number to mislead the result text with.
  return pngHeaderSize(bytes) ?? jpegHeaderSize(bytes);
}

/**
 * Validate a model-supplied `rect` against the source's pixel size: integers, inside the
 * image, at least 1×1 after clamping. A missing `rect` is legal (`{ rect: undefined }`);
 * a malformed one returns the sentence to hand back as a tool error.
 */
export function normalizeRect(
  raw: unknown,
  width: number,
  height: number,
): { rect?: Rect; error?: string } {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'rect must be an object {x, y, w, h} in pixels of the image.' };
  }
  const r = raw as Record<string, unknown>;
  const nums = ['x', 'y', 'w', 'h'].map((k) => r[k]);
  if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return { error: 'rect needs the numeric fields x, y, w and h (pixels of the image).' };
  }
  const [x0, y0, w0, h0] = nums as number[];
  // A non-positive w/h is its own mistake and says so: "outside the image" would send the
  // model looking for a coordinate error it did not make.
  if (w0 <= 0 || h0 <= 0) {
    return { error: 'rect needs a positive w and h (pixels of the image).' };
  }
  const x = Math.max(0, Math.floor(x0));
  const y = Math.max(0, Math.floor(y0));
  const x1 = Math.min(width, Math.ceil(x0 + w0));
  const y1 = Math.min(height, Math.ceil(y0 + h0));
  const w = x1 - x;
  const h = y1 - y;
  if (w <= 0 || h <= 0) {
    return { error: `rect is outside the image (${width}x${height}).` };
  }
  return { rect: { x, y, w, h } };
}

/**
 * Crop (when `rect` is given) and downscale (when the longest side exceeds
 * {@link IMAGE_TARGET_MAX_SIDE}), then re-encode. Never throws for a bad image: an
 * unreadable or unsupported input comes back as `changed: false` with the input bytes,
 * which keeps the caller's "attach what we have" behaviour and leaves the per-request
 * budget (`agent.ts`) as the backstop.
 *
 * The `changed: false` cases are not failures — they are the contract that keeps a small
 * image byte-identical on the wire, and each one carries a `reason` for the log. Only the
 * transform itself (crop, area-average downscale, PNG re-encode) produces new bytes.
 */
export async function transformImage(input: {
  bytes: Uint8Array;
  mime: string;
  rect?: Rect;
}): Promise<TransformOutcome> {
  const bytes = input.bytes;
  const mime = input.mime;
  const kind = normaliseMime(mime);
  const header = readImageSize(bytes, mime);
  const headerWidth = header ? header.width : 0;
  const headerHeight = header ? header.height : 0;

  /**
   * Nothing to do — and the whole point of the `changed: false` contract: the bytes go up
   * exactly as they arrived, so a small image is uploaded byte-identical and no cached
   * prefix is invalidated by a pointless re-encode. The size is filled in from the header
   * whenever it is readable, so the caller can still report "800x600, unchanged".
   *
   * `width`/`height` default to the header's size; the caller passes the decoded size when
   * the header could not be read but the decode worked.
   */
  const unchanged = (reason: string, width = headerWidth, height = headerHeight): TransformOutcome => ({
    bytes,
    mime,
    width,
    height,
    sourceWidth: headerWidth || width,
    sourceHeight: headerHeight || height,
    rect: input.rect,
    scale: 1,
    changed: false,
    reason,
  });

  if (kind !== 'image/png' && kind !== 'image/jpeg') {
    return unchanged(`${mime || 'unknown mime type'} is not PNG or JPEG: passed through unchanged`);
  }

  // One call and one failure shape for both formats. A JPEG goes through A2's decoder
  // (`jpegDecode.ts`); while that refuses a file — progressive, 12-bit, damaged — the
  // answer is the same as for an unsupported format: bytes through, reason for the log.
  const decoded = kind === 'image/png' ? await decodePng(bytes) : decodeJpeg(bytes);
  if (!isDecoded(decoded)) {
    return unchanged(`${kind} pass-through: ${decoded.error}`);
  }

  // The decoded size wins over the header's: a decoder that disagrees with IHDR/SOFn has
  // already refused the file, and what is in the buffer is what gets cropped.
  const sourceWidth = decoded.width;
  const sourceHeight = decoded.height;
  const rect = input.rect;
  const wholeImage =
    !rect || (rect.x === 0 && rect.y === 0 && rect.w === sourceWidth && rect.h === sourceHeight);
  if (wholeImage && Math.max(sourceWidth, sourceHeight) <= IMAGE_TARGET_MAX_SIDE) {
    return unchanged(
      `${sourceWidth}x${sourceHeight} needs no transform: within ${IMAGE_TARGET_MAX_SIDE} px on its` +
        ` longest side${rect ? ' and the rect is the whole image' : ''}`,
    );
  }

  // Before the one CPU-bound step (a sync crop+resample) and after the encode: the event
  // loop gets a turn either side, so the caller's status line is not painted behind it.
  await yieldToEventLoop();
  const resampled = cropResample(
    { width: sourceWidth, height: sourceHeight, data: decoded.data },
    rect,
    IMAGE_TARGET_MAX_SIDE,
  );
  // No `alpha` option: `encodePng` drops the channel itself when every alpha byte is 255,
  // so an opaque screenshot re-encodes as colour type 2 instead of carrying a channel the
  // request pays for and nothing can see. The pixels are the same either way.
  const out = await encodePng({ width: resampled.width, height: resampled.height, data: resampled.data });
  await yieldToEventLoop();

  // A downscale that did not pay for itself is not a transform, it is a bigger upload in the
  // one metric this feature exists for. Compression can lose to the source: a flat diagram or
  // a screenshot is a few KB as PNG and several times that once it has been resampled and
  // re-filtered, and a small lossy JPEG re-encoded as PNG is worse still (there is a JPEG
  // decoder, no encoder). So with no `rect`, an encode that is not *strictly* smaller than
  // the input is thrown away and the original goes up unchanged — which costs the model
  // nothing, because the endpoint resizes to about 800x800 itself (`image-budget.md` §2), so
  // it would have seen the same picture either way and only the bytes differ.
  //
  // A `rect` is never dropped this way: the crop is a view the model asked for, so a cropped
  // result is returned even when it is bigger than the file it came from.
  if (!rect && out.length >= bytes.length) {
    return unchanged(
      `the re-encode would not have been smaller (${out.length} >= ${bytes.length} bytes): kept the` +
        ` original ${sourceWidth}x${sourceHeight}`,
      sourceWidth,
      sourceHeight,
    );
  }

  return {
    bytes: out,
    // A transformed image is PNG, whichever format came in: the re-encode is ours, and
    // saying `image/jpeg` about PNG bytes would be the one lie the upload cannot survive.
    mime: 'image/png',
    width: resampled.width,
    height: resampled.height,
    sourceWidth,
    sourceHeight,
    rect: rect ? keptRect(rect, sourceWidth, sourceHeight) : undefined,
    scale: resampled.scale,
    changed: true,
  };
}
