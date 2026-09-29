/**
 * qr.ts — a QR Code encoder written as this repo's own source (ISO/IEC 18004), plus the PNG
 * writer that turns its module matrix into a file.
 *
 * WHY OWN SOURCE. The extension ships no runtime dependency at all
 * (`docs/agents/invariants/vendored-deps.md`), and `media/vendor/` is reserved for frozen npm
 * tarballs that carry a PROVENANCE file — so a QR library is not an option, vendored or
 * resolved. What is needed here is a small, cold path: one command, one room token, one photo.
 *
 * THE SUBSET. Byte mode, error-correction level **M**, versions **1..10**. That is the whole
 * of it: a `spinney-pair:1?…` payload is ASCII-percent-encoded text, and the largest payload
 * this repo can build is the version-10 ceiling (213 bytes at level M). Anything larger is
 * refused by name (`encodeQr` reports the byte count), never truncated and never emitted as a
 * code that could not carry it. Level M is the level the phone's scanner is told to expect.
 *
 * WHAT IS PROVEN, AND WHERE. This module's **structure** is checked by `tools/check-qr.js`:
 * the format-information bits are decoded back to (level M, the mask this encoder chose), the
 * finder/separator/timing/alignment patterns and the 4-module quiet zone are asserted where
 * §6 puts them, and every block's Reed-Solomon syndromes are evaluated to zero with a separate
 * GF(256) implementation in that script. The **decode** is proven elsewhere and not here: the
 * Android half reads `remote/android/core/src/test/resources/pairing-fixture.png` (written by
 * `tools/gen-qr-fixture.mjs`) with zxing. No decoder runs in this repository, so nothing in
 * this file should be read as one having been run.
 */
import * as zlib from 'node:zlib';

import { crc32 } from '../agent/types';

/**
 * Light modules on each side of the symbol — 4X, ISO/IEC 18004 §6.3.2.3 / §8.1. The quiet
 * zone is part of the code, not decoration: a scanner cannot find the symbol without it, so
 * {@link encodeQr} bakes it into the matrix it returns and {@link qrPng} therefore needs no
 * margin logic of its own.
 */
export const QR_QUIET_ZONE = 4;

/**
 * Pixels per module in {@link qrPng}. Eight is the smallest scale that also makes one module
 * exactly one byte of a 1-bit scanline, and it turns the largest supported version (57
 * modules + the quiet zone, 520 px) into an image a phone camera resolves comfortably.
 */
export const QR_PIXEL_SCALE = 8;

/** The highest version this encoder implements. See the module header for why 10. */
export const QR_MAX_VERSION = 10;

/** Byte mode's 4-bit mode indicator (§8.4.1, Table 2). */
const MODE_BYTE = 0b0100;

/** Level M's two format bits — L=01, M=00, Q=11, H=10 (§8.9, Table 12). */
const EC_LEVEL_M_BITS = 0b00;

/** One block group of a version's error-correction structure (§8.5, Table 9). */
interface BlockGroup {
  readonly blocks: number;
  readonly dataCodewords: number;
}

/** One version's structure at level M: total codewords, EC per block, and the data blocks. */
interface VersionSpec {
  readonly totalCodewords: number;
  readonly ecCodewordsPerBlock: number;
  /** Short blocks **first** — the order the interleaving in §8.6 walks them in. */
  readonly groups: readonly BlockGroup[];
}

/**
 * The version/level structure of Table 9, level M only, versions 1..10, indexed by
 * `version - 1`. `totalCodewords` is every codeword of the symbol (data + EC); the groups
 * reproduce the table's `(c, k, r)` rows (`c` = blocks, `k` = data codewords per block) with
 * both groups present where the table has two. `tools/check-qr.js` re-derives each entry from
 * the two rounded halves Table 9 publishes (`(total, ec)` and the module count), so a typo
 * here cannot survive it.
 */
const VERSIONS_M: readonly VersionSpec[] = [
  { totalCodewords: 26, ecCodewordsPerBlock: 10, groups: [{ blocks: 1, dataCodewords: 16 }] },
  { totalCodewords: 44, ecCodewordsPerBlock: 16, groups: [{ blocks: 1, dataCodewords: 28 }] },
  { totalCodewords: 70, ecCodewordsPerBlock: 26, groups: [{ blocks: 1, dataCodewords: 44 }] },
  { totalCodewords: 100, ecCodewordsPerBlock: 18, groups: [{ blocks: 2, dataCodewords: 32 }] },
  { totalCodewords: 134, ecCodewordsPerBlock: 24, groups: [{ blocks: 2, dataCodewords: 43 }] },
  { totalCodewords: 172, ecCodewordsPerBlock: 16, groups: [{ blocks: 4, dataCodewords: 27 }] },
  { totalCodewords: 196, ecCodewordsPerBlock: 18, groups: [{ blocks: 4, dataCodewords: 31 }] },
  {
    totalCodewords: 242,
    ecCodewordsPerBlock: 22,
    groups: [{ blocks: 2, dataCodewords: 38 }, { blocks: 2, dataCodewords: 39 }],
  },
  {
    totalCodewords: 292,
    ecCodewordsPerBlock: 22,
    groups: [{ blocks: 3, dataCodewords: 36 }, { blocks: 2, dataCodewords: 37 }],
  },
  {
    totalCodewords: 346,
    ecCodewordsPerBlock: 26,
    groups: [{ blocks: 4, dataCodewords: 43 }, { blocks: 1, dataCodewords: 44 }],
  },
];

/**
 * Alignment-pattern centre coordinates (Annex E, Table E.1), indexed by `version - 1`. The
 * three combinations that would land on a finder pattern are skipped when they are drawn.
 */
const ALIGNMENT_CENTERS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/**
 * Remainder bits after the interleaved codewords (Table 1), indexed by version: 0 for 1,
 * 7 for 2..6, 0 again from 7. They are written as light modules and are what make the module
 * count come out square.
 */
const REMAINDER_BITS: readonly number[] = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

/** The four penalty weights of §8.8.2, Table 11. */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** `modules[row][col]`, dark = true, quiet zone included. */
export interface QrCode {
  /** The version (1..10) this symbol was built at. */
  readonly version: number;
  /** The mask (0..7) whose bits the format information carries. */
  readonly mask: number;
  /** Modules per side **excluding** the quiet zone (17 + 4 × version). */
  readonly size: number;
  /**
   * `size + 2 * QR_QUIET_ZONE` rows of the same length, quiet zone included, so a renderer
   * can rasterize the whole code without knowing this module's rules.
   */
  readonly modules: readonly (readonly boolean[])[];
}

// ------------------------------------------------------------------ GF(256) and Reed-Solomon

/**
 * GF(256) with the primitive polynomial `x^8 + x^4 + x^3 + x^2 + 1` (0x11D) and α = 2, as
 * §8.5 requires — the tables are the log/antilog pair the multiplication below needs, and the
 * exponent table is doubled so `GF_LOG[a] + GF_LOG[b]` never needs a modulo.
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** The generator polynomials already built, one per EC length (they are pure). */
const GENERATORS = new Map<number, readonly number[]>();

/**
 * The RS generator polynomial of degree `n`: `∏ (x - α^i)` for `i = 0..n-1`, coefficients
 * highest degree first, the leading 1 of the `x^n` term included (§8.5.2).
 */
function ecGenerator(n: number): readonly number[] {
  const cached = GENERATORS.get(n);
  if (cached) {
    return cached;
  }
  let poly: number[] = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  GENERATORS.set(n, poly);
  return poly;
}

/**
 * The `ecLen` error-correction codewords of one block: the remainder of the block's data
 * polynomial divided by {@link ecGenerator} (§8.5.2), computed by the usual shift-register
 * synthetic division.
 */
function ecCodewords(data: readonly number[], ecLen: number): number[] {
  const generator = ecGenerator(ecLen);
  const remainder = new Array<number>(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) {
      remainder[i] ^= gfMul(generator[i + 1], factor);
    }
  }
  return remainder;
}

// ------------------------------------------------------------------ format and version information

/**
 * The 15 format-information bits of §8.9: 5 data bits `(level, mask)`, a 10-bit BCH(15,5)
 * remainder with generator `0x537`, then the `0x5412` mask that keeps the all-zero case from
 * being all light. The expected outputs for level M are the table's own (mask 0 → `0x5412`).
 */
function formatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return (((data << 10) | remainder) ^ 0x5412) & 0x7fff;
}

/** The 18 version-information bits of §8.10 (versions 7+): 6 data bits + a 12-bit BCH(12,6) with 0x1F25. */
function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return ((version << 12) | remainder) & 0x3ffff;
}

// ------------------------------------------------------------------ the symbol

/** How many data codewords a version carries at level M (the sum of Table 9's data rows). */
function dataCodewords(version: number): number {
  return VERSIONS_M[version - 1].groups.reduce((total, group) => total + group.blocks * group.dataCodewords, 0);
}

/** The character-count indicator's width: 8 bits for versions 1..9, 16 from version 10 (§8.4.2). */
function countIndicatorBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/**
 * The largest byte-mode payload a version holds at level M, header included. This is the
 * number the refusal quotes, so it is derived and not hard-coded.
 */
function capacityBytes(version: number): number {
  return Math.floor((dataCodewords(version) * 8 - 4 - countIndicatorBits(version)) / 8);
}

/** The smallest supported version whose byte-mode capacity fits, or a refusal naming the size. */
function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= QR_MAX_VERSION; version++) {
    if (byteLength <= capacityBytes(version)) {
      return version;
    }
  }
  throw new Error(
    `qr: ${byteLength} bytes of payload do not fit byte mode at error-correction level M in versions 1..${
      QR_MAX_VERSION
    } (version ${QR_MAX_VERSION} holds ${capacityBytes(QR_MAX_VERSION)} bytes, quiet zone aside); ` +
      'refusing rather than emitting a code that could not carry the payload',
  );
}

/** The data codewords of one version: mode, count, the UTF-8 bytes, terminator and padding (§8.4). */
function buildDataCodewords(bytes: Buffer, version: number): number[] {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const push = (value: number, width: number): void => {
    for (let i = width - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  push(MODE_BYTE, 4);
  push(bytes.length, countIndicatorBits(version));
  for (const byte of bytes) {
    push(byte, 8);
  }
  // Terminator: four light bits, shortened when the capacity is nearly full (§8.4.9).
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) {
    bits.push(0);
  }
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bits[i + j];
    }
    codewords.push(byte);
  }
  // The two alternating pad codewords of §8.4.9, to the end of the capacity.
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/** Blocks, their EC codewords, and the interleaving of §8.6 — data first, then EC. */
function interleave(data: readonly number[], version: number): number[] {
  const spec = VERSIONS_M[version - 1];
  const blocks: number[][] = [];
  let offset = 0;
  for (const group of spec.groups) {
    for (let block = 0; block < group.blocks; block++) {
      blocks.push(data.slice(offset, offset + group.dataCodewords));
      offset += group.dataCodewords;
    }
  }
  if (offset !== data.length) {
    throw new Error(`qr: internal — ${data.length} data codewords do not fill version ${version}'s block structure`);
  }
  const ecBlocks = blocks.map((block) => ecCodewords(block, spec.ecCodewordsPerBlock));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) {
      if (i < block.length) {
        out.push(block[i]);
      }
    }
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (const block of ecBlocks) {
      out.push(block[i]);
    }
  }
  if (out.length !== spec.totalCodewords) {
    throw new Error(`qr: internal — version ${version} interleaved to ${out.length} codewords, not ${spec.totalCodewords}`);
  }
  return out;
}

/** The i-th mask's inversion predicate (§8.8.1, Table 10), `x` a column and `y` a row. */
function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/**
 * One symbol: function patterns, the interleaved codewords placed in the zigzag of §8.7.3, all
 * eight masks scored by §8.8.2, and the lowest penalty applied. The quiet zone is added by
 * {@link encodeQr}, not here — this is the symbol alone.
 */
function buildSymbol(version: number, codewords: readonly number[]): { mask: number; size: number; modules: boolean[][] } {
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const setFunctionModule = (x: number, y: number, dark: boolean): void => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Timing patterns first (§6.3.3): dark on even coordinates, alternating either way; the
  // finder patterns below overwrite their ends, which is what "no alternation between the
  // finder patterns" means.
  for (let i = 0; i < size; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Finder patterns and their separators (§6.3.3), a 9×9 block per centre: the 7×7 pattern
  // plus a light ring, i.e. dark exactly when the Chebyshev distance is 0, 1 or 3.
  const drawFinder = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) {
          continue;
        }
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        setFunctionModule(x, y, ring !== 2 && ring !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns (§6.3.6 / Annex E): the 5×5 shape, at every centre combination except
  // the three that would overlap a finder (those are the three Table E.1 corners the
  // dedicated finder patterns already cover).
  const centers = ALIGNMENT_CENTERS[version - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      const onFinder =
        (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
      if (onFinder) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Format information (§8.9) in both of its two copies, plus the module at (8, size-8) that
  // is always dark. Called once with a dummy mask first: that is what reserves these modules
  // as function modules before data placement, and the real bits are drawn per candidate below.
  const drawFormatBits = (mask: number, target: boolean[][]): void => {
    const bits = formatBits(mask);
    const put = (col: number, row: number, index: number): void => {
      target[row][col] = ((bits >>> index) & 1) !== 0;
      isFunction[row][col] = true;
    };
    for (let i = 0; i <= 5; i++) {
      put(8, i, i);
    }
    put(8, 7, 6);
    put(8, 8, 7);
    put(7, 8, 8);
    for (let i = 9; i < 15; i++) {
      put(14 - i, 8, i);
    }
    for (let i = 0; i < 8; i++) {
      put(size - 1 - i, 8, i);
    }
    for (let i = 8; i < 15; i++) {
      put(8, size - 15 + i, i);
    }
    target[size - 8][8] = true;
    isFunction[size - 8][8] = true;
  };
  drawFormatBits(0, modules);

  // Version information (§8.10): two 3×6 blocks for versions 7 and up.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, dark);
      setFunctionModule(b, a, dark);
    }
  }

  // Data placement (§8.7.3): two-module-wide columns from the right edge, alternating up and
  // down, skipping the vertical timing column. The unmasked bits go in first; masking is per
  // candidate below. The remainder bits are never written, i.e. they stay light (§8.4.9).
  const totalBits = codewords.length * 8;
  let placed = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && placed < totalBits) {
          modules[y][x] = ((codewords[placed >> 3] >>> (7 - (placed & 7))) & 1) !== 0;
          placed++;
        }
      }
    }
  }
  if (placed !== totalBits) {
    throw new Error(`qr: internal — placed ${placed} of ${totalBits} codeword bits in version ${version}`);
  }

  // All eight masks, scored by §8.8.2; the lowest wins, and a tie keeps the lower mask number
  // (the order this loop visits them in).
  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice());
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskBit(mask, x, y)) {
          candidate[y][x] = !candidate[y][x];
        }
      }
    }
    drawFormatBits(mask, candidate);
    const score = penaltyScore(candidate, size);
    if (!best || score < best.score) {
      best = { mask, modules: candidate, score };
    }
  }
  if (!best) {
    throw new Error('qr: internal — no mask was scored');
  }
  return { mask: best.mask, size, modules: best.modules };
}

/**
 * The §8.8.2 mask penalty, all four rules. The finder-like rule (N3) is evaluated over the
 * run-length history of each line rather than by matching an 11-module window, because the
 * spec's "preceded or followed by light area 4 modules wide" also holds at the symbol edge —
 * the quiet zone is that light area, and a window scan alone would miss it.
 */
function penaltyScore(modules: readonly (readonly boolean[])[], size: number): number {
  let result = 0;
  const history = new Array<number>(7).fill(0);

  const addRun = (runLength: number): void => {
    let run = runLength;
    if (history[0] === 0) {
      // The first run of a line is preceded by the light quiet zone.
      run += size;
    }
    history.copyWithin(1, 0, 6);
    history[0] = run;
  };
  const countFinderPatterns = (): number => {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
      (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
    );
  };
  const line = (at: (i: number) => boolean): void => {
    history.fill(0);
    let runColor = false;
    let runLength = 0;
    for (let i = 0; i < size; i++) {
      const color = at(i);
      if (color === runColor) {
        runLength++;
        if (runLength === 5) {
          result += PENALTY_N1;
        } else if (runLength > 5) {
          result++;
        }
      } else {
        addRun(runLength);
        // A run that just ended light closes a finder-like sequence (1011101 is dark-light-dark...).
        if (!runColor) {
          result += countFinderPatterns() * PENALTY_N3;
        }
        runColor = color;
        runLength = 1;
      }
    }
    // Close the line: a trailing dark run, then the light quiet zone.
    if (runColor) {
      addRun(runLength);
      runLength = 0;
    }
    addRun(runLength + size);
    result += countFinderPatterns() * PENALTY_N3;
  };

  for (let y = 0; y < size; y++) {
    line((x) => modules[y][x]);
  }
  for (let x = 0; x < size; x++) {
    line((y) => modules[y][x]);
  }

  // N2: every 2×2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y][x];
      if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
        result += PENALTY_N2;
      }
    }
  }

  // N4: how far the dark proportion is from 50%, in 5% steps.
  let dark = 0;
  for (const row of modules) {
    for (const color of row) {
      if (color) {
        dark++;
      }
    }
  }
  const total = size * size;
  const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
  return result + k * PENALTY_N4;
}

// ------------------------------------------------------------------ public API

/**
 * Encode `text` as a level-M byte-mode QR Code, versions 1..10.
 *
 * Throws when the text does not fit version 10 at level M; the message names the byte count
 * and the ceiling, because a silently truncated symbol is a code that scans to the wrong
 * string. The returned matrix includes the 4-module quiet zone on every side.
 */
export function encodeQr(text: string): QrCode {
  const bytes = Buffer.from(text, 'utf8');
  const version = chooseVersion(bytes.length);
  const codewords = interleave(buildDataCodewords(bytes, version), version);
  const symbol = buildSymbol(version, codewords);
  const side = symbol.size + QR_QUIET_ZONE * 2;
  const modules: boolean[][] = Array.from({ length: side }, () => new Array<boolean>(side).fill(false));
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      modules[y + QR_QUIET_ZONE][x + QR_QUIET_ZONE] = symbol.modules[y][x];
    }
  }
  return { version, mask: symbol.mask, size: symbol.size, modules };
}

/** The PNG signature, §5.2 of the PNG specification. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: length, type, data, and the CRC over type+data (PNG §5.3). */
function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Rasterize a module matrix — one cell per pixel, `true` = dark — into a 1-bit greyscale PNG
 * (§11.2.2 of the PNG specification: bit depth 1, colour type 0, samples MSB first, 1 = white).
 *
 * `zlib.deflateSync` is deliberate here: the input is bounded by {@link QR_MAX_VERSION} and
 * {@link QR_PIXEL_SCALE} (the largest code is 520×520 px, ~34 KB of scanlines), not by
 * user data, so it cannot become the multi-megabyte block that `agent/pngCodec.ts` uses the
 * async forms to avoid. The scanlines are written with filter type 0 (None): a 1-bit QR image
 * is two flat runs per row with one colour change at most, and filtering buys nothing on it.
 */
export function qrPng(matrix: readonly (readonly boolean[])[]): Buffer {
  const height = matrix.length;
  const width = matrix[0]?.length ?? 0;
  if (height === 0 || width === 0) {
    throw new Error('qrPng: the matrix is empty');
  }
  for (const row of matrix) {
    if (row.length !== width) {
      throw new Error('qrPng: the matrix is not rectangular');
    }
  }
  const pixelWidth = width * QR_PIXEL_SCALE;
  const pixelHeight = height * QR_PIXEL_SCALE;
  const stride = 1 + Math.ceil(pixelWidth / 8);
  const raw = Buffer.alloc(stride * pixelHeight);
  for (let py = 0; py < pixelHeight; py++) {
    const source = matrix[Math.floor(py / QR_PIXEL_SCALE)];
    const base = py * stride;
    for (let px = 0; px < pixelWidth; px++) {
      // A light module has to be a sample of 1 (white) in 1-bit greyscale.
      if (!source[Math.floor(px / QR_PIXEL_SCALE)]) {
        raw[base + 1 + (px >> 3)] |= 0x80 >> (px & 7);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pixelWidth, 0);
  ihdr.writeUInt32BE(pixelHeight, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale
  // Bytes 10..12 stay 0: deflate compression, adaptive filtering, no interlace.
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
