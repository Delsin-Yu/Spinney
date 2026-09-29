/*
 * check-qr — the QR encoder (`src/remote/qr.ts`) and the Android pairing fixture, as a
 * build-time guard.
 *
 * WHAT IT GUARDS, AND WHY A ROUND TRIP WOULD PROVE NOTHING. The desktop draws the room's
 * token as a QR code and the phone reads it out of a photo; if a single module is wrong, the
 * phone either reads nothing or — far worse — reads a *different* token, which is a different
 * room, which is the silent failure the pairing code exists to remove. The encoder is this
 * repo's own source (`media/vendor/` is only for frozen npm tarballs), so there is no upstream
 * to trust and no decoder in the repository: this script is where the structure is checked.
 *
 * The checks below are written against ISO/IEC 18004 and **not** against the encoder: the
 * layout, the GF(256) arithmetic, the de-interleaving and the CRC-32 are re-implemented here,
 * bitwise where it matters, so an encoder *implementation* bug cannot certify itself by
 * re-running. An independent implementation is still not an independent source of truth — a
 * shared misreading of the spec would pass both — which is exactly why the decode check below
 * does not live here.
 *
 * WHAT IT ASSERTS
 *   P1  version choice: every version 1..10 is selected at its capacity boundary and nowhere
 *       earlier, and a payload past version 10 is refused with the byte count in the message
 *   L1  the finder patterns and their light separators sit at the three corners §6.3.3 puts
 *       them, module for module
 *   L2  the timing patterns alternate along row 6 and column 6, between the finders
 *   L3  every alignment pattern of Annex E is the 5x5 shape, at the centres Table E.1 names,
 *       and there are exactly as many as its corner rule allows (the three finder corners are
 *       skipped, and the finder check above would fail if one were drawn through them)
 *   L4  the always-dark module is at (8, size-8) and the 4-module quiet zone is light on all
 *       four sides
 *   F1  the format-information bits — read from **both** copies — pass their BCH(15,5) check,
 *       decode to error-correction level M, and name the mask the encoder reported
 *   V1  versions 7..10 carry the BCH(18,6) version information in both of its two blocks
 *   C1  the data modules are read back through the §8.7.3 zigzag with an independent unmask,
 *       the remainder bits are light, and the codeword count is the version's total
 *   C2  every block, de-interleaved here, has Reed-Solomon syndromes that all evaluate to
 *       zero — the property a codeword from a wrong generator polynomial fails
 *   C3  the byte-mode header and the payload bits round-trip to the input text, and the
 *       terminator plus the 0xEC/0x11 pad codewords of §8.4.9 are exactly what follows
 *   S1  a sweep over a payload of every length 1..213: the format mask, the codeword count,
 *       the remainder bits, the header and the payload all read back correctly for every one
 *       of them, and the sweep selects every version and all **eight** masks — so no mask
 *       predicate goes untested and the data path is not checked on one lucky payload shape
 *   G1  the geometry adds up: function modules + codeword bits + remainder bits is size², and
 *       the level-M block table sums to the version's total codeword count
 *   N1  `qrPng` writes a well-formed 1-bit greyscale PNG: signature, IHDR/IDAT/IEND and
 *       nothing else, every chunk CRC recomputed bitwise here, nothing after IEND, and the
 *       documented refusals for an empty and a ragged matrix
 *   X1  `remote/android/core/src/test/resources/pairing-fixture.png` — the asset the Android
 *       half decodes with zxing — inflates to exactly the module matrix vector 1 encodes to,
 *       so the committed fixture cannot drift from the codec
 *
 * WHAT IT DOES NOT PROVE. That a *reader* accepts these symbols. No decoder runs in this
 * repository: the Android app decodes the fixture with zxing, and that is where the decode is
 * proven. See the module header of `src/remote/qr.ts`.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled modules).
 *
 * Run: node tools/check-qr.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = {
  qr: path.join(ROOT, 'out', 'remote', 'qr.js'),
  pairing: path.join(ROOT, 'out', 'remote', 'pairing.js'),
};
for (const [name, file] of Object.entries(OUT)) {
  if (!fs.existsSync(file)) {
    console.error(`check-qr: out/remote/${name}.js is missing — run \`npm run compile\` first.`);
    process.exit(1);
  }
}
const qr = require(OUT.qr);
const { buildPairingPayload } = require(OUT.pairing);

const FIXTURE = path.join(ROOT, 'remote', 'android', 'core', 'src', 'test', 'resources', 'pairing-fixture.png');

const problems = [];
let checks = 0;

/** One assertion. Both lines are printed, so a guard that only speaks up when it fails is visible too. */
function ok(label, cond, detail) {
  checks++;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail === undefined ? '' : `  (${detail})`}`);
  if (!cond) {
    problems.push(label);
  }
  return cond;
}

// ---------------------------------------------------------------------------------------
// Reference material, re-stated here from ISO/IEC 18004 rather than imported from the encoder.
// ---------------------------------------------------------------------------------------

/** Table E.1, indexed by version - 1. */
const ALIGNMENT_CENTERS = [
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

/** The level-M rows of Table 9, indexed by version - 1 (a second copy on purpose: see G1). */
const STRUCTURE_M = [
  { totalCodewords: 26, ecPerBlock: 10, groups: [{ blocks: 1, dataCodewords: 16 }] },
  { totalCodewords: 44, ecPerBlock: 16, groups: [{ blocks: 1, dataCodewords: 28 }] },
  { totalCodewords: 70, ecPerBlock: 26, groups: [{ blocks: 1, dataCodewords: 44 }] },
  { totalCodewords: 100, ecPerBlock: 18, groups: [{ blocks: 2, dataCodewords: 32 }] },
  { totalCodewords: 134, ecPerBlock: 24, groups: [{ blocks: 2, dataCodewords: 43 }] },
  { totalCodewords: 172, ecPerBlock: 16, groups: [{ blocks: 4, dataCodewords: 27 }] },
  { totalCodewords: 196, ecPerBlock: 18, groups: [{ blocks: 4, dataCodewords: 31 }] },
  { totalCodewords: 242, ecPerBlock: 22, groups: [{ blocks: 2, dataCodewords: 38 }, { blocks: 2, dataCodewords: 39 }] },
  { totalCodewords: 292, ecPerBlock: 22, groups: [{ blocks: 3, dataCodewords: 36 }, { blocks: 2, dataCodewords: 37 }] },
  { totalCodewords: 346, ecPerBlock: 26, groups: [{ blocks: 4, dataCodewords: 43 }, { blocks: 1, dataCodewords: 44 }] },
];

/** Table 1: the bits after the interleaved codewords, indexed by version. */
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

const MODE_BYTE = 0b0100;
const PAD_CODEWORDS = [0xec, 0x11];

/** GF(256), primitive polynomial 0x11D, built bitwise here (see the file header). */
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
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** The mask predicates of §8.8.1, Table 10 — the check's own copy. */
function maskBit(mask, x, y) {
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

/** The function-module map of one version, laid out here from §6 (the encoder's is not consulted). */
function functionModules(version) {
  const size = version * 4 + 17;
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      fn[y][x] = true;
    }
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        mark(cx + dx, cy + dy);
      }
    }
  }
  const centers = ALIGNMENT_CENTERS[version - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          mark(cx + dx, cy + dy);
        }
      }
    }
  }
  for (let i = 0; i <= 5; i++) mark(8, i);
  mark(8, 7);
  mark(8, 8);
  mark(7, 8);
  for (let i = 9; i < 15; i++) mark(14 - i, 8);
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) mark(8, size - 15 + i);
  mark(8, size - 8);
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      mark(a, b);
      mark(b, a);
    }
  }
  return { fn, size };
}

/** `modules[y][x]` of the symbol alone (the quiet zone is stripped). */
const symbolAt = (code, x, y) => code.modules[y + qr.QR_QUIET_ZONE][x + qr.QR_QUIET_ZONE];

/**
 * One of the two format-information copies of §8.9, decoded here: the 15 bits are read from the
 * modules the spec puts them in, the `0x5412` mask is removed, and the BCH(15,5) remainder is
 * recomputed so a mis-placed or corrupt bit cannot pass as a (level, mask) pair.
 */
function readFormatInfo(code, copy) {
  const size = code.size;
  const bits = [];
  if (copy === 1) {
    for (let i = 0; i <= 5; i++) bits.push(symbolAt(code, 8, i));
    bits.push(symbolAt(code, 8, 7), symbolAt(code, 8, 8), symbolAt(code, 7, 8));
    for (let i = 9; i < 15; i++) bits.push(symbolAt(code, 14 - i, 8));
  } else {
    for (let i = 0; i < 8; i++) bits.push(symbolAt(code, size - 1 - i, 8));
    for (let i = 8; i < 15; i++) bits.push(symbolAt(code, 8, size - 15 + i));
  }
  const word = bits.reduce((value, bit, i) => value | (bit ? 1 << i : 0), 0);
  const data = (word ^ 0x5412) >>> 10;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits15 = ((data << 10) | remainder) ^ 0x5412;
  return { word, ecBits: (data >>> 3) & 3, mask: data & 7, wellFormed: word === (bits15 & 0x7fff) };
}

/** §8.7.3 read back: walk the zigzag, unmask, and return the codeword bits plus the tail. */
function readCodewords(code) {
  const { fn, size } = functionModules(code.version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) {
          bits.push(symbolAt(code, x, y) !== maskBit(code.mask, x, y));
        }
      }
    }
  }
  const totalCodewords = STRUCTURE_M[code.version - 1].totalCodewords;
  const totalBits = totalCodewords * 8;
  const remainder = bits.slice(totalBits);
  const codewords = [];
  for (let i = 0; i < totalBits; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | (bits[i + j] ? 1 : 0);
    }
    codewords.push(byte);
  }
  return { codewords, remainder, functionCount: fn.flat().filter(Boolean).length };
}

/** The blocks of one version at level M, de-interleaved here from the raw codewords. */
function deinterleave(codewords, version) {
  const spec = STRUCTURE_M[version - 1];
  const dataLengths = [];
  for (const group of spec.groups) {
    for (let b = 0; b < group.blocks; b++) {
      dataLengths.push(group.dataCodewords);
    }
  }
  const data = dataLengths.map(() => []);
  const ec = dataLengths.map(() => []);
  let at = 0;
  const longest = Math.max(...dataLengths);
  for (let i = 0; i < longest; i++) {
    for (let b = 0; b < dataLengths.length; b++) {
      if (i < dataLengths[b]) {
        data[b].push(codewords[at++]);
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < dataLengths.length; b++) {
      ec[b].push(codewords[at++]);
    }
  }
  return { data, ec, spec };
}

/** Horner evaluation of one block at α^0 … α^(ecPerBlock-1); all zero iff the block is a codeword. */
function syndromes(block, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = GF_EXP[i];
    let acc = 0;
    for (const byte of block) {
      acc = gfMul(acc, x) ^ byte;
    }
    out.push(acc);
  }
  return out;
}

/** CRC-32 (PNG §5.3), bitwise, so it cannot inherit a table's mistake from the encoder's module. */
function crc32Bitwise(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (c ^ byte) >>> 0;
    for (let k = 0; k < 8; k++) {
      c = ((c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)) >>> 0;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

const readU32 = (bytes, off) => ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;

/** Parse a PNG into its chunks, verifying the signature and every chunk CRC (nothing after IEND). */
function parsePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => bytes[i] === b)) {
    return { error: 'bad PNG signature' };
  }
  const chunks = [];
  let off = 8;
  for (;;) {
    if (off + 12 > bytes.length) {
      return { error: 'truncated PNG (a chunk header overruns the file)' };
    }
    const length = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (off + 12 + length > bytes.length) {
      return { error: `truncated PNG (${type} chunk overruns the file)` };
    }
    const data = bytes.subarray(off + 8, off + 8 + length);
    const crc = readU32(bytes, off + 8 + length);
    if (crc !== crc32Bitwise(bytes.subarray(off + 4, off + 8 + length))) {
      return { error: `bad CRC in the ${type} chunk` };
    }
    chunks.push({ type, data });
    off += 12 + length;
    if (type === 'IEND') {
      break;
    }
  }
  return { chunks, trailing: bytes.length - off };
}

/** The module matrix a 1-bit greyscale PNG of a QR code holds, sampled from each module block. */
function pngModules(bytes) {
  const parsed = parsePng(bytes);
  if (parsed.error) {
    return { error: parsed.error };
  }
  const { chunks, trailing } = parsed;
  if (trailing !== 0) {
    return { error: `${trailing} byte(s) after IEND` };
  }
  const types = chunks.map((c) => c.type);
  const expected = ['IHDR', 'IDAT', 'IEND'];
  if (types.length !== expected.length || types.some((t, i) => t !== expected[i])) {
    return { error: `chunks are ${types.join(', ')}, expected IHDR, IDAT, IEND` };
  }
  const ihdr = chunks[0].data;
  const width = readU32(ihdr, 0);
  const height = readU32(ihdr, 4);
  if (ihdr[8] !== 1 || ihdr[9] !== 0 || ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) {
    return { error: `IHDR is ${ihdr[8]}-bit, colour type ${ihdr[9]}, compression ${ihdr[10]}, filter ${ihdr[11]}, interlace ${ihdr[12]}` };
  }
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  } catch (err) {
    return { error: `IDAT does not inflate: ${err.message}` };
  }
  const scale = qr.QR_PIXEL_SCALE;
  if (width % scale !== 0 || height % scale !== 0) {
    return { error: `${width}x${height} is not a whole number of ${scale}px modules` };
  }
  const stride = 1 + Math.ceil(width / 8);
  if (raw.length !== stride * height) {
    return { error: `inflated ${raw.length} bytes, expected ${stride * height}` };
  }
  // 1-bit greyscale sample 1 is white, i.e. a *light* module — the matrix this script compares
  // against says `true` = dark, so the sample is inverted here, once, and everything below
  // works in dark/light.
  const darkAt = (px, py) => ((raw[py * stride + 1 + (px >> 3)] >> (7 - (px & 7))) & 1) === 0;
  const moduleAt = (col, row) => darkAt(col * scale + (scale >> 1), row * scale + (scale >> 1));
  for (let py = 0; py < height; py++) {
    if (raw[py * stride] !== 0) {
      return { error: `scanline ${py} carries filter ${raw[py * stride]}, expected 0` };
    }
    for (let px = 0; px < width; px++) {
      if (darkAt(px, py) !== moduleAt(Math.floor(px / scale), Math.floor(py / scale))) {
        return { error: `pixel (${px}, ${py}) is not uniform across its module` };
      }
    }
  }
  const cols = width / scale;
  const rows = height / scale;
  const matrix = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => moduleAt(c, r)));
  return { width, height, matrix, cols, rows };
}

// ---------------------------------------------------------------------------------------
// P1 — version choice, and the refusal past version 10.
// ---------------------------------------------------------------------------------------
console.log('-- pairing: version choice, and the refusal that names the size --');
const capacity = (version) => {
  const spec = STRUCTURE_M[version - 1];
  const data = spec.groups.reduce((n, g) => n + g.blocks * g.dataCodewords, 0);
  return Math.floor((data * 8 - 4 - (version <= 9 ? 8 : 16)) / 8);
};
for (let version = 1; version <= 10; version++) {
  const atCeiling = qr.encodeQr('a'.repeat(capacity(version)));
  const overCeiling = version < 10 ? qr.encodeQr('a'.repeat(capacity(version) + 1)) : null;
  ok(
    `P1 version ${version} holds ${capacity(version)} bytes and not one more`,
    atCeiling.version === version && (version === 10 || overCeiling.version > version),
    version === 10 ? 'version 10 is the ceiling' : `one more byte → version ${overCeiling.version}`,
  );
}
let refused = null;
try {
  qr.encodeQr('a'.repeat(capacity(10) + 1));
} catch (err) {
  refused = err.message;
}
ok(
  'P1 a payload past version 10 is refused, and the message names the byte count',
  refused !== null && refused.includes(String(capacity(10) + 1)) && refused.includes(String(capacity(10))),
  refused,
);

// ---------------------------------------------------------------------------------------
// The codes every later section reads: the fixture's payload, and one per version.
// ---------------------------------------------------------------------------------------
const VECTOR_1 = buildPairingPayload({
  relayUrl: 'https://relay.example.com:8787',
  roomName: 'home + lab',
  token: 'a b+c/d?',
});
ok(
  'P1 the fixture payload is shared vector 1, built by the codec',
  VECTOR_1 ===
    'spinney-pair:1?relay=https%3A%2F%2Frelay.example.com%3A8787&room=home%20%2B%20lab&token=a%20b%2Bc%2Fd%3F',
  VECTOR_1,
);
const codes = [];
for (let version = 1; version <= 10; version++) {
  codes.push(qr.encodeQr('q'.repeat(capacity(version))));
}
ok(
  'P1 one code per version 1..10 was built',
  codes.every((code, i) => code.version === i + 1),
  codes.map((c) => `v${c.version}/m${c.mask}`).join(' '),
);

// ---------------------------------------------------------------------------------------
// L1..L4 — the layout of §6, module by module.
// ---------------------------------------------------------------------------------------
console.log('-- layout: the finder, timing, alignment and quiet-zone modules --');
for (const code of codes) {
  const size = code.size;
  let findersOk = true;
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) {
          continue;
        }
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (symbolAt(code, x, y) !== (ring !== 2 && ring !== 4)) {
          findersOk = false;
        }
      }
    }
  }
  ok(`L1 v${code.version}: three finder patterns and their light separators`, findersOk);
}
for (const code of codes) {
  let timingOk = true;
  for (let i = 8; i <= code.size - 9; i++) {
    if (symbolAt(code, i, 6) !== (i % 2 === 0) || symbolAt(code, 6, i) !== (i % 2 === 0)) {
      timingOk = false;
    }
  }
  ok(`L2 v${code.version}: the timing patterns alternate between the finders`, timingOk);
}
for (const code of codes) {
  const size = code.size;
  const centers = ALIGNMENT_CENTERS[code.version - 1];
  let drawn = 0;
  let alignmentOk = true;
  for (const cy of centers) {
    for (const cx of centers) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) {
        continue;
      }
      drawn++;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (symbolAt(code, cx + dx, cy + dy) !== (Math.max(Math.abs(dx), Math.abs(dy)) !== 1)) {
            alignmentOk = false;
          }
        }
      }
    }
  }
  const expected = centers.length * centers.length - (centers.length > 0 ? 3 : 0);
  ok(
    `L3 v${code.version}: ${drawn} alignment pattern(s), the 5x5 shape Table E.1 places`,
    alignmentOk && drawn === Math.max(0, expected),
    `expected ${Math.max(0, expected)}`,
  );
}
for (const code of codes) {
  const size = code.size;
  let quietOk = symbolAt(code, 8, size - 8) === true;
  for (let i = 0; i < code.modules.length; i++) {
    for (let j = 0; j < code.modules.length; j++) {
      const onBorder =
        i < qr.QR_QUIET_ZONE ||
        j < qr.QR_QUIET_ZONE ||
        i >= code.modules.length - qr.QR_QUIET_ZONE ||
        j >= code.modules.length - qr.QR_QUIET_ZONE;
      if (onBorder && code.modules[i][j]) {
        quietOk = false;
      }
    }
  }
  ok(`L4 v${code.version}: the always-dark module and a light quiet zone on all four sides`, quietOk);
}

// ---------------------------------------------------------------------------------------
// F1 / V1 — the format and version information, decoded and BCH-checked here.
// ---------------------------------------------------------------------------------------
console.log('-- format and version information: decoded back to (level M, the chosen mask) --');
for (const code of codes) {
  const results = [1, 2].map((copy) => readFormatInfo(code, copy));
  const good =
    results.every((r) => r.wellFormed && r.ecBits === 0) &&
    results[0].mask === results[1].mask &&
    results[0].mask === code.mask;
  ok(
    `F1 v${code.version}: both format copies BCH-check to level M, mask ${results[0].mask}`,
    good,
    `copy1 0x${results[0].word.toString(16).padStart(4, '0')} copy2 0x${results[1].word.toString(16).padStart(4, '0')}, encoder said mask ${code.mask}`,
  );
}
for (const code of codes.filter((c) => c.version >= 7)) {
  const size = code.size;
  const readVersion = (topRight) => {
    let value = 0;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      const bit = topRight ? symbolAt(code, a, b) : symbolAt(code, b, a);
      value |= bit ? 1 << i : 0;
    }
    return value;
  };
  const decoded = [readVersion(true), readVersion(false)].map((word) => {
    const data = word >>> 12;
    let remainder = data;
    for (let i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    return { version: data, wellFormed: word === (((data << 12) | remainder) & 0x3ffff) };
  });
  ok(
    `V1 v${code.version}: both version-information blocks BCH-check to ${code.version}`,
    decoded.every((d) => d.wellFormed && d.version === code.version),
    decoded.map((d) => `${d.version}${d.wellFormed ? '' : '!'}`).join(' / '),
  );
}

// ---------------------------------------------------------------------------------------
// C1..C3 — codewords, Reed-Solomon, and the byte-mode payload.
// ---------------------------------------------------------------------------------------
console.log('-- codewords: read back independently, de-interleaved, syndromes evaluated --');
for (const code of codes) {
  const { codewords, remainder, functionCount } = readCodewords(code);
  const spec = STRUCTURE_M[code.version - 1];
  ok(
    `C1 v${code.version}: ${codewords.length} codewords through the zigzag, ${remainder.length} light remainder bit(s)`,
    codewords.length === spec.totalCodewords &&
      remainder.length === REMAINDER_BITS[code.version] &&
      remainder.every((bit) => bit === false),
  );
  const { data, ec } = deinterleave(codewords, code.version);
  const allZero = data.every((block, i) => syndromes([...block, ...ec[i]], spec.ecPerBlock).every((s) => s === 0));
  ok(`C2 v${code.version}: every one of the ${data.length} block(s) has all-zero RS syndromes`, allZero);
}

console.log('-- codewords: the mode/length header, the payload, and the §8.4.9 padding --');
for (const code of codes) {
  const text = 'q'.repeat(capacity(code.version));
  const bytes = Buffer.from(text, 'utf8');
  const { codewords } = readCodewords(code);
  const { data } = deinterleave(codewords, code.version);
  const stream = data.flat();
  const bits = [];
  for (const byte of stream) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }
  const take = (at, width) => bits.slice(at, at + width).reduce((value, bit) => (value << 1) | bit, 0);
  const mode = take(0, 4);
  const countWidth = code.version <= 9 ? 8 : 16;
  const count = take(4, countWidth);
  const payload = [];
  for (let i = 0; i < count; i++) {
    payload.push(take(4 + countWidth + i * 8, 8));
  }
  const headerOk = mode === MODE_BYTE && count === bytes.length;
  const payloadOk = Buffer.from(payload).equals(bytes);
  // §8.4.9: zeros to the byte boundary, then the two pad codewords alternating from 0xEC.
  let at = 4 + countWidth + count * 8;
  while (at % 8 !== 0 && bits[at] === 0) {
    at++;
  }
  const padded = at % 8 === 0;
  const pads = [];
  for (; at < bits.length; at += 8) {
    pads.push(take(at, 8));
  }
  const padsOk = pads.every((byte, i) => byte === PAD_CODEWORDS[i % 2]);
  ok(
    `C3 v${code.version}: byte-mode header + ${count} payload byte(s) + ${pads.length} pad codeword(s) round-trip`,
    headerOk && payloadOk && padded && padsOk,
    `mode ${mode.toString(2).padStart(4, '0')}, pad ${pads.map((b) => b.toString(16)).join(' ')}`,
  );
}

// A capacity-length payload leaves no room for pad codewords, so the alternating 0xEC/0x11
// fill of §8.4.9 is checked on a payload that does leave room — the common case in practice.
{
  const text = 'spinney';
  const code = qr.encodeQr(text);
  const { codewords } = readCodewords(code);
  const { data } = deinterleave(codewords, code.version);
  const bitsUsed = 4 + (code.version <= 9 ? 8 : 16) + Buffer.byteLength(text, 'utf8') * 8;
  const padFrom = Math.ceil((bitsUsed + 4) / 8); // the 4-bit terminator, then to a codeword boundary
  const pads = data.flat().slice(padFrom);
  ok(
    `C3 v${code.version}: a short payload is filled with ${pads.length} alternating pad codeword(s)`,
    pads.length > 1 && pads.every((byte, i) => byte === PAD_CODEWORDS[i % 2]),
    pads.map((b) => b.toString(16).padStart(2, '0')).join(' '),
  );
}

// The fixture's own payload, read back: the same three checks the per-version codes above get,
// on the one string the Android half will actually see.
{
  const code = qr.encodeQr(VECTOR_1);
  const spec = STRUCTURE_M[code.version - 1];
  const { codewords, remainder } = readCodewords(code);
  const { data, ec } = deinterleave(codewords, code.version);
  const stream = data.flat();
  const bits = [];
  for (const byte of stream) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }
  const take = (at, width) => bits.slice(at, at + width).reduce((value, bit) => (value << 1) | bit, 0);
  const countWidth = code.version <= 9 ? 8 : 16;
  const count = take(4, countWidth);
  const payload = Buffer.from(Array.from({ length: count }, (_, i) => take(4 + countWidth + i * 8, 8)));
  ok(
    'C3 vector 1: the payload read back out of the symbol is the payload that built it',
    take(0, 4) === MODE_BYTE &&
      payload.toString('utf8') === VECTOR_1 &&
      codewords.length === spec.totalCodewords &&
      remainder.length === REMAINDER_BITS[code.version] &&
      data.every((block, i) => syndromes([...block, ...ec[i]], spec.ecPerBlock).every((s) => s === 0)),
    `${payload.length} bytes, v${code.version}, mask ${code.mask}`,
  );
}

// ---------------------------------------------------------------------------------------
// S1 — the data path over the whole range, so all eight masks are actually exercised.
// ---------------------------------------------------------------------------------------
console.log('-- sweep: payloads of every length 1..213, which is where all eight masks appear --');
{
  const failures = [];
  const masksSeen = new Set();
  const versionsSeen = new Set();
  // Deliberately varied bytes, not one repeated character: a uniform payload selects only
  // masks 0,2,3,4,5,6 (measured), which would leave two of the eight predicates never run.
  const textOf = (length) => Array.from({ length }, (_, i) => String.fromCharCode(33 + ((i * 11) % 94))).join('');
  for (let length = 1; length <= capacity(10); length++) {
    const text = textOf(length);
    const code = qr.encodeQr(text);
    masksSeen.add(code.mask);
    versionsSeen.add(code.version);
    const spec = STRUCTURE_M[code.version - 1];
    const { codewords, remainder } = readCodewords(code);
    const { data, ec } = deinterleave(codewords, code.version);
    const bits = [];
    for (const byte of data.flat()) {
      for (let i = 7; i >= 0; i--) {
        bits.push((byte >> i) & 1);
      }
    }
    const take = (at, width) => bits.slice(at, at + width).reduce((value, bit) => (value << 1) | bit, 0);
    const countWidth = code.version <= 9 ? 8 : 16;
    const count = take(4, countWidth);
    const payload = Buffer.from(Array.from({ length: count }, (_, i) => take(4 + countWidth + i * 8, 8)));
    const good =
      codewords.length === spec.totalCodewords &&
      remainder.length === REMAINDER_BITS[code.version] &&
      remainder.every((bit) => bit === false) &&
      take(0, 4) === MODE_BYTE &&
      count === length &&
      payload.toString('utf8') === text &&
      data.every((block, i) => syndromes([...block, ...ec[i]], spec.ecPerBlock).every((s) => s === 0)) &&
      readFormatInfo(code, 1).mask === code.mask &&
      readFormatInfo(code, 1).wellFormed;
    if (!good) {
      failures.push(`${length} bytes → v${code.version}/m${code.mask}`);
    }
  }
  ok(
    `S1 all ${capacity(10)} payloads read back with zero syndromes, the right header and the format mask they were built with`,
    failures.length === 0,
    failures.slice(0, 5).join(' | '),
  );
  ok(
    'S1 the sweep exercises all eight masks and all ten versions',
    masksSeen.size === 8 && versionsSeen.size === 10,
    `masks ${[...masksSeen].sort().join(',')}; versions ${[...versionsSeen].sort((a, b) => a - b).join(',')}`,
  );
}

// ---------------------------------------------------------------------------------------
// G1 — the geometry and the block table add up.
// ---------------------------------------------------------------------------------------
console.log('-- geometry: function modules, codeword bits, remainder bits and the block table --');
for (const code of codes) {
  const spec = STRUCTURE_M[code.version - 1];
  const { functionCount } = readCodewords(code);
  const dataBits = spec.totalCodewords * 8;
  const remainder = REMAINDER_BITS[code.version];
  const tableSum = spec.groups.reduce((n, g) => n + g.blocks * (g.dataCodewords + spec.ecPerBlock), 0);
  ok(
    `G1 v${code.version}: ${functionCount} function + ${dataBits} codeword + ${remainder} remainder = ${code.size * code.size} modules, table sums to ${spec.totalCodewords}`,
    functionCount + dataBits + remainder === code.size * code.size && tableSum === spec.totalCodewords,
  );
}

// ---------------------------------------------------------------------------------------
// N1 — the PNG writer.
// ---------------------------------------------------------------------------------------
console.log('-- png: qrPng writes a well-formed 1-bit greyscale PNG --');
{
  const code = qr.encodeQr(VECTOR_1);
  const png = qr.qrPng(code.modules);
  const parsed = parsePng(png);
  const side = code.modules.length * qr.QR_PIXEL_SCALE;
  ok('N1 the PNG wraps IHDR/IDAT/IEND with valid CRCs and nothing after IEND', !parsed.error && parsed.trailing === 0, parsed.error);
  if (!parsed.error) {
    const ihdr = parsed.chunks[0].data;
    ok(
      `N1 IHDR is ${side}x${side}, 1-bit greyscale, non-interlaced`,
      parsed.chunks.map((c) => c.type).join(',') === 'IHDR,IDAT,IEND' &&
        readU32(ihdr, 0) === side &&
        readU32(ihdr, 4) === side &&
        ihdr[8] === 1 &&
        ihdr[9] === 0 &&
        ihdr[10] === 0 &&
        ihdr[11] === 0 &&
        ihdr[12] === 0,
    );
  }
  const decoded = pngModules(png);
  ok(
    'N1 the PNG rasterizes back to the module matrix it was given',
    !decoded.error && decoded.matrix.every((row, y) => row.every((cell, x) => cell === code.modules[y][x])),
    decoded.error,
  );
  const refusals = [];
  try {
    qr.qrPng([]);
  } catch (err) {
    refusals.push(err.message);
  }
  try {
    qr.qrPng([[true, false], [true]]);
  } catch (err) {
    refusals.push(err.message);
  }
  ok(
    'N1 an empty and a ragged matrix are refused',
    refusals.length === 2 && /empty/.test(refusals[0]) && /rectangular/.test(refusals[1]),
    refusals.join(' | '),
  );
}

// ---------------------------------------------------------------------------------------
// X1 — the checked-in Android fixture is vector 1's code.
// ---------------------------------------------------------------------------------------
console.log('-- fixture: remote/android/core/src/test/resources/pairing-fixture.png --');
{
  const exists = fs.existsSync(FIXTURE);
  ok(
    'X1 the fixture exists (the Android half decodes it with zxing)',
    exists,
    exists ? `${fs.statSync(FIXTURE).size} bytes` : `missing: ${FIXTURE}; run \`node tools/gen-qr-fixture.mjs\``,
  );
  if (exists) {
    const decoded = pngModules(fs.readFileSync(FIXTURE));
    const expected = qr.encodeQr(VECTOR_1);
    if (decoded.error) {
      ok('X1 the fixture is a readable 1-bit greyscale PNG', false, decoded.error);
    } else {
      ok('X1 the fixture is a readable 1-bit greyscale PNG', true, `${decoded.width}x${decoded.height}`);
      ok(
        'X1 the fixture carries exactly the modules vector 1 encodes to',
        decoded.rows === expected.modules.length &&
          decoded.cols === expected.modules[0].length &&
          decoded.matrix.every((row, y) => row.every((cell, x) => cell === expected.modules[y][x])),
        `v${expected.version}, mask ${expected.mask}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------
// The verdict. Printed after every check, so a PASS always means "all of them ran".
// ---------------------------------------------------------------------------------------
if (problems.length) {
  console.error(`\ncheck-qr: FAIL — ${problems.length} of ${checks} check(s) failed:`);
  for (const label of problems) {
    console.error(`  - ${label}`);
  }
  process.exit(1);
}
console.log(`check-qr: OK — ${checks} checks; vector 1 is v${qr.encodeQr(VECTOR_1).version}/mask ${qr.encodeQr(VECTOR_1).mask}.`);
console.log('  structure verified here; the decode is Android zxing reading the fixture, not this script.');
