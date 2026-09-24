/*
 * check-png — the PNG codec (`src/agent/pngCodec.ts`), as a build-time guard.
 *
 * WHY IT EXISTS
 * The codec is the byte-saving half of the image budget (`docs/agents/plans/image-budget.md`
 * §1): `read_image` hands it a screenshot or a contact sheet and uploads whatever comes back,
 * so a wrong pixel or a lost alpha byte is quietly sent to the model, and a lazy encoder is
 * paid for in every request that carries that image. Nothing else in the tree reads these
 * bytes back — the webview draws the source FILE, never our re-encode — so this guard is the
 * only place either fact can be caught.
 *
 * The decoder must not certify itself (§6: "a pure-JS encoder + decoder pair can share a
 * bug"). Every expectation read here comes from `tools/fixtures/image/expect-png.json`, which
 * `tools/gen-image-fixtures.py` wrote from **PIL's** own decode/encode of the same files:
 *   - `rgbaSha256` hashes PIL's RGBA bytes and the explicit `rgba`/`spots` pixels are PIL's
 *     values, so a channel swap or a wrong filter cannot hide inside a round trip;
 *   - the encoder is measured against PIL's byte count on the one fixture where the IDAT
 *     dominates (240x160), instead of against itself;
 *   - the adaptive-filter heuristic is recomputed here from the source pixels, and the filter
 *     byte the encoder actually wrote has to be its argmin.
 *
 * WHAT IT ASSERTS
 *   D1  every `decode` fixture: size, RGBA sha256, every explicit pixel and every spot, and
 *       that the fixture's own IDAT filter bytes are the ones the JSON pins — the
 *       `png-filter-*` files must use exactly 0,1,2,3,4 (one per row), so all five filters
 *       are provably exercised rather than assumed
 *   R1  every `refuse` fixture: an `{error}` whose text matches the JSON's regex
 *       (16-bit, 1/2/4-bit, interlaced, bad CRC, truncation, bad signature"), never a throw
 *   R2  robustness: garbage in, `{error}` out, never a throw — empty, 3 bytes, signature-only,
 *       plain text, and every fixture cut at five lengths (a caller may hand over a partial
 *       download, and the tool result must stay an error line)
 *   E1  every `encode` fixture: our bytes re-decode to EXACTLY the fixture's pixels, that
 *       pixel hash equals PIL's `rgbaSha256`, and the byte count is reported against PIL's
 *   E2  encode structure, parsed here: signature, IHDR/IDAT/IEND and nothing else, the IHDR
 *       fields, every chunk CRC recomputed with the shipped `crc32`, nothing after IEND, plus
 *       a 1x1 round trip through the default (no `alpha`) path
 *   E3  the filtering heuristic is real: per row the written filter byte equals the argmin of
 *       the five guard-side MSAD scores, and not every row is filter 0
 *   H1  host responsiveness, the half no pixel check can see: the module asks the event loop
 *       for exactly `floor((rows-1) / PNG_YIELD_ROWS)` turns per decode/encode (counted by
 *       wrapping `setImmediate`), calls no `*Sync` zlib form, and still carries a
 *       `% PNG_YIELD_ROWS === 0` guard in BOTH row loops (read as text from `out/`, so a
 *       refactor that drops the yield fails here instead of in a frozen UI)
 *
 * Needs `out/` (run `npm run compile` first: it drives the compiled module).
 * Run: npm run check:png   /   node tools/check-png.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tools', 'fixtures', 'image');
const CODEC = path.join(ROOT, 'out', 'agent', 'pngCodec.js');
const TYPES = path.join(ROOT, 'out', 'agent', 'types.js');

const { decodePng, encodePng, PNG_YIELD_ROWS } = require(CODEC);
// The CRC the module stamps its chunks with, so the guard recomputes the same polynomial
// with the shipped implementation instead of a second copy of it.
const { crc32 } = require(TYPES);

const EXPECT = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expect-png.json'), 'utf8'));

// ------------------------------------------------------------------ report stream
const problems = [];
let checks = 0;
const ok = (label, pass, detail) => {
  checks++;
  if (pass) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label + (detail ? ': ' + detail : ''));
  }
  return pass;
};

// ------------------------------------------------------------------ small helpers
const read = (name) => fs.readFileSync(path.join(FIXTURES, name));
const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const u32 = (bytes, off) =>
  ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const short = (hash) => hash.slice(0, 12) + '...';

/** The guard's own chunk walk — deliberately written here, not imported from the module. */
function ownChunks(bytes) {
  const chunks = [];
  let off = 8;
  let end = bytes.length;
  while (off + 8 <= bytes.length) {
    const length = u32(bytes, off);
    // Read the type as four chars by hand: a plain `Uint8Array` (what encodePng returns)
    // has `Array.prototype.toString`, so `bytes.toString(...)` would ignore the args and
    // stringify the whole buffer instead of the chunk type.
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const crcAt = off + 8 + length;
    if (crcAt + 4 > bytes.length) break;
    const data = bytes.subarray(off + 8, crcAt);
    chunks.push({
      type,
      data,
      crcAt,
      crcOk: u32(bytes, crcAt) === crc32(bytes.subarray(off + 4, crcAt)),
      offset: off,
    });
    off = crcAt + 4;
    end = off;
    if (type === 'IEND') break;
  }
  return { chunks, end };
}

/** The per-row filter bytes of a PNG, read straight from its IDAT (never from the codec). */
function ownRowFilters(bytes) {
  const { chunks } = ownChunks(bytes);
  const ihdr = chunks[0] && chunks[0].type === 'IHDR' ? chunks[0].data : null;
  if (!ihdr) return null;
  const width = u32(ihdr, 0);
  const height = u32(ihdr, 4);
  const bitDepth = ihdr[8];
  const channels = CHANNELS[ihdr[9]];
  if (!channels) return null;
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);
  const rowBytes = ((width * channels * bitDepth) + 7) >> 3;
  const out = [];
  for (let y = 0; y < height; y++) out.push(raw[y * (rowBytes + 1)]);
  return out;
}

/** "f0:1 f1:1 f2:0 f3:0 f4:14" — how many rows used each filter. */
function filterCounts(filters) {
  const counts = [0, 0, 0, 0, 0];
  for (const f of filters) if (counts[f] !== undefined) counts[f]++;
  return counts.map((n, k) => `f${k}:${n}`).join(' ');
}

/** The first differing pixel, as "index (x,y) got [..] want [..]", or null when equal. */
function pixelDiff(data, width, index, want) {
  const at = index * 4;
  const got = [data[at], data[at + 1], data[at + 2], data[at + 3]];
  if (got.every((v, i) => v === want[i])) return null;
  const x = index % width;
  const y = Math.floor(index / width);
  return `pixel ${index} (x ${x}, y ${y}) got [${got}] want [${want}]`;
}

/** Compare two RGBA buffers pixel by pixel; returns the first mismatch or null. */
function dataDiff(got, want, width) {
  if (got.length !== want.length) {
    return `buffer is ${got.length} bytes, want ${want.length}`;
  }
  for (let i = 0; i < got.length; i += 4) {
    const index = i / 4;
    const diff = pixelDiff(
      got,
      width,
      index,
      [want[i], want[i + 1], want[i + 2], want[i + 3]],
    );
    if (diff) return diff;
  }
  return null;
}

/** Call decodePng and normalise the two shapes it may return. */
async function tryDecode(bytes) {
  try {
    const result = await decodePng(bytes);
    if (!result) return { threw: 'decodePng returned ' + String(result) };
    if (typeof result.error === 'string') return { error: result.error };
    if (typeof result.width !== 'number' || typeof result.height !== 'number') {
      return { threw: 'decodePng returned neither {error} nor {width,height,data}' };
    }
    return { decoded: result };
  } catch (err) {
    return { threw: err && err.message ? err.message : String(err) };
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ------------------------------------------------------------------ D1: decode fixtures
async function decodeFixtures() {
  console.log('');
  console.log('-- decode fixtures (PIL oracle) --');
  for (const [name, want] of Object.entries(EXPECT.decode)) {
    const bytes = read(name);
    const res = await tryDecode(bytes);
    if (res.threw) {
      ok(name, false, 'decodePng threw: ' + res.threw);
      continue;
    }
    if (res.error) {
      ok(name, false, 'refused a decodable file: "' + res.error + '"');
      continue;
    }
    const got = res.decoded;
    const notes = [];
    let pass = true;

    if (bytes.length !== want.bytes) {
      pass = false;
      notes.push(`fixture is ${bytes.length} bytes, JSON says ${want.bytes}`);
    }
    if (got.width !== want.width || got.height !== want.height) {
      pass = false;
      notes.push(`size ${got.width}x${got.height} want ${want.width}x${want.height}`);
    }
    const hash = sha256(got.data);
    if (hash !== want.rgbaSha256) {
      pass = false;
      notes.push(`rgba sha256 ${short(hash)} want ${short(want.rgbaSha256)}`);
    }
    if (got.data.length !== want.width * want.height * 4) {
      pass = false;
      notes.push(`data is ${got.data.length} bytes, want ${want.width * want.height * 4}`);
    }

    // The fixture's own filters, read from its IDAT: the JSON is pinned to the FILE, and the
    // png-filter-* files must really run the decoder through 0,1,2,3,4 one row each.
    const filters = ownRowFilters(bytes);
    if (!filters || filters.length !== want.rowFilters.length ||
        filters.some((f, i) => f !== want.rowFilters[i])) {
      pass = false;
      notes.push(`fixture filters [${filters}] != JSON [${want.rowFilters}]`);
    } else if (/^png-filter-/.test(name)) {
      const set = Array.from(new Set(filters)).sort((a, b) => a - b);
      if (set.join(',') !== '0,1,2,3,4') {
        pass = false;
        notes.push(`filter set ${set.join(',')} is not exactly 0,1,2,3,4`);
      }
    }

    if (want.rgba) {
      if (want.rgba.length !== want.width * want.height) {
        pass = false;
        notes.push(`JSON lists ${want.rgba.length} pixels, want ${want.width * want.height}`);
      }
      for (let i = 0; i < want.rgba.length; i++) {
        const diff = pixelDiff(got.data, want.width, i, want.rgba[i]);
        if (diff) {
          pass = false;
          notes.push(`explicit rgba: ${diff}`);
          break;
        }
      }
    }
    if (want.spots) {
      for (const [index, r, g, b, a] of want.spots) {
        const diff = pixelDiff(got.data, want.width, index, [r, g, b, a]);
        if (diff) {
          pass = false;
          notes.push(`spot: ${diff}`);
          break;
        }
      }
    }

    ok(
      name,
      pass,
      `${want.width}x${want.height} mode ${want.mode} · ` +
      `sha256 ${pass && hash === want.rgbaSha256 ? 'ok' : 'CHECK'} · ` +
        `filters ${filters ? filterCounts(filters) : '?'}` +
        (want.rgba ? ` · ${want.rgba.length} explicit pixels` : '') +
        (want.spots ? ` · ${want.spots.length} spots` : '') +
        (notes.length ? ' · ' + notes.join(' ; ') : ''),
    );
  }
}

// ------------------------------------------------------------------ R1: refusals
async function refuseFixtures() {
  console.log('');
  console.log('-- refuse fixtures (variant + damage) --');
  for (const [name, want] of Object.entries(EXPECT.refuse)) {
    const bytes = read(name);
    const res = await tryDecode(bytes);
    if (res.threw) {
      ok(name, false, 'decodePng threw instead of returning a reason: ' + res.threw);
      continue;
    }
    if (!res.error) {
      const got = `${res.decoded.width}x${res.decoded.height}`;
      ok(name, false, `accepted a file that must be refused (got ${got})`);
      continue;
    }
    const matches = new RegExp(want.reasonMustMatch, 'i').test(res.error);
    ok(name, matches,
      matches
        ? `refused, reason "${res.error}" matches /${want.reasonMustMatch}/i`
        : `reason "${res.error}" does not match /${want.reasonMustMatch}/i`);
  }
}

// ------------------------------------------------------------------ R2: robustness
async function robustness() {
  console.log('');
  console.log('-- robustness (never throw; always a reason) --');
  const garbage = [
    ['empty buffer', new Uint8Array(0)],
    ['3 bytes', new Uint8Array([0x89, 0x50, 0x4e])],
    ['signature only', PNG_SIG],
    ['plain text', Buffer.from('this is not a PNG, it is a sentence')],
    ['signature + 4 bytes', Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 0])])],
  ];
  for (const [label, bytes] of garbage) {
    const res = await tryDecode(bytes);
    const reason = res.threw
      ? 'threw: ' + res.threw
      : res.error ? `"${res.error}"` : 'DECODED (impossible)';
    ok('garbage: ' + label, !!res.error, `${bytes.length} bytes -> ${reason}`);
  }

  // Every fixture, cut short at five lengths: a partial file must stay an error line.
  const names = Object.keys(EXPECT.decode).concat(Object.keys(EXPECT.refuse));
  let slices = 0;
  const accepted = [];
  for (const name of names) {
    const bytes = read(name);
    const lengths = [1, 12, Math.floor(bytes.length / 2), bytes.length - 1, bytes.length - 4];
    for (const length of Array.from(new Set(lengths)).filter((n) => n >= 0 && n < bytes.length)) {
      slices++;
      const res = await tryDecode(bytes.subarray(0, length));
      if (res.threw) accepted.push(`${name}[0..${length}) threw: ${res.threw}`);
      else if (!res.error) {
        const got = `${res.decoded.width}x${res.decoded.height}`;
        accepted.push(`${name}[0..${length}) decoded ${got}`);
      }
    }
  }
  ok('slices: ' + names.length + ' fixtures cut at 5 lengths',
    accepted.length === 0,
    accepted.length
      ? `${accepted.length}/${slices} did not return {error} — ${accepted.slice(0, 3).join(' ; ')}`
      : `${slices}/${slices} returned {error}, none threw`);
}

// ------------------------------------------------------------------ E2: encode structure
/** Parse our own output: signature, chunk order, IHDR fields, CRCs, nothing after IEND. */
function encodeStructure(name, bytes, wantType, width, height) {
  const notes = [];
  let pass = true;
  if (Buffer.compare(bytes.subarray(0, 8), PNG_SIG) !== 0) {
    pass = false;
    notes.push('bad signature');
  }
  const { chunks, end } = ownChunks(bytes);
  const types = chunks.map((c) => c.type);
  if (types.join(',') !== 'IHDR,IDAT,IEND') {
    pass = false;
    notes.push(`chunks are ${types.join(',')} (want IHDR,IDAT,IEND exactly — no ancillary chunk)`);
  }
  for (const chunk of chunks) {
    if (!chunk.crcOk) {
      pass = false;
      notes.push(`bad CRC in ${chunk.type}`);
      break;
    }
  }
  if (end !== bytes.length) {
    pass = false;
    notes.push(`${bytes.length - end} trailing bytes after IEND`);
  }
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) {
    pass = false;
    notes.push('no 13-byte IHDR');
  } else {
    const fields = {
      width: u32(ihdr.data, 0),
      height: u32(ihdr.data, 4),
      bitDepth: ihdr.data[8],
      colourType: ihdr.data[9],
      compression: ihdr.data[10],
      filter: ihdr.data[11],
      interlace: ihdr.data[12],
    };
    const bad = [];
    if (fields.width !== width || fields.height !== height) {
      bad.push(`size ${fields.width}x${fields.height} want ${width}x${height}`);
    }
    if (fields.bitDepth !== 8) bad.push(`bit depth ${fields.bitDepth} want 8`);
    if (fields.colourType !== wantType) bad.push(`colour type ${fields.colourType} want ${wantType}`);
    if (fields.compression !== 0) bad.push(`compression ${fields.compression} want 0`);
    if (fields.filter !== 0) bad.push(`filter method ${fields.filter} want 0`);
    if (fields.interlace !== 0) bad.push(`interlace ${fields.interlace} want 0`);
    if (bad.length) {
      pass = false;
      notes.push(bad.join(' ; '));
    }
    if (!notes.length) {
      notes.push(`IHDR ${fields.width}x${fields.height} bitDepth 8 colourType ${fields.colourType} ` +
        'compression 0 filter 0 interlace 0');
    }
  }
  const idat = chunks.filter((c) => c.type === 'IDAT');
  if (idat.length !== 1) {
    pass = false;
    notes.push(`${idat.length} IDAT chunks (want exactly 1)`);
  }
  const filterBytes = ownRowFilters(bytes);
  return {
    pass,
    detail: (notes.join(' ; ') || 'IHDR/IDAT/IEND, CRCs valid') +
      (filterBytes ? ` · filters ${filterCounts(filterBytes)}` : '') +
      ` · ${types.join('/')}, ${bytes.length} bytes`,
    filterBytes,
  };
}

// ------------------------------------------------------------------ E1 + E2: encode
const ENCODE_SECTION = {};

async function encodeFixtures() {
  console.log('');
  console.log('-- encode (round trip + size vs PIL) --');
  for (const [name, want] of Object.entries(EXPECT.encode)) {
    const source = read(name);
    const decoded = await tryDecode(source);
    if (!decoded.decoded) {
      ok(name, false, 'the fixture itself did not decode: ' + (decoded.error || decoded.threw));
      continue;
    }
    const input = decoded.decoded;
    const expectedType = want.alpha ? 6 : 2;
    let bytes;
    try {
      bytes = await encodePng(input, { alpha: want.alpha });
    } catch (err) {
      ok(name, false, 'encodePng threw: ' + (err && err.message ? err.message : String(err)));
      continue;
    }
    const structure = encodeStructure(name, bytes, expectedType, input.width, input.height);
    ok(name + ' [structure]', structure.pass, structure.detail);

    const back = await tryDecode(bytes);
    let pass = true;
    const notes = [];
    if (!back.decoded) {
      pass = false;
      notes.push('our own bytes did not decode: ' + (back.error || back.threw));
    } else {
      const diff = dataDiff(back.decoded.data, input.data, input.width);
      if (diff) {
        pass = false;
        notes.push('round trip differs: ' + diff);
      }
      if (back.decoded.width !== input.width || back.decoded.height !== input.height) {
        pass = false;
        notes.push(`round trip size ${back.decoded.width}x${back.decoded.height}`);
      }
      const hash = sha256(back.decoded.data);
      if (hash !== want.rgbaSha256) {
        pass = false;
        notes.push(`pixel sha256 ${short(hash)} want PIL's ${short(want.rgbaSha256)}`);
      }
    }

    const delta = bytes.length - want.pilBytes;
    const percent = want.pilBytes ? ((delta / want.pilBytes) * 100).toFixed(1) : '?';
    const sign = delta >= 0 ? '+' : '';
    const sizeNote = `${bytes.length} bytes vs PIL ${want.pilBytes} (${sign}${delta}, ${percent}%)`;
    // Only the 240x160 fixture is a fair size comparison: the two tiny files are mostly
    // chunk overhead (57 bytes of container), where a few bytes of deflate noise would make
    // the assertion flaky rather than meaningful — so those are reported, not asserted.
    const sizeMatters = input.width * input.height >= 240 * 160;
    if (sizeMatters && bytes.length > want.pilBytes) {
      pass = false;
      notes.push('bigger than PIL on the fixture where the IDAT dominates: ' + sizeNote);
    }
    ENCODE_SECTION[name] = { bytes: bytes.length, pil: want.pilBytes, delta, percent, sizeMatters };
    ok(
      name + ` [alpha:${want.alpha}]`,
      pass,
      `${input.width}x${input.height} · pixels identical to PIL's decode, ` +
      `sha256 ${short(want.rgbaSha256)} · ${sizeNote}` +
        (sizeMatters ? ' · asserted <= PIL' : ' · reported only (chunk overhead dominates)') +
        (notes.length ? ' · ' + notes.join(' ; ') : ''),
    );
  }

  // The degenerate size, through the default path (no `alpha` option): 1x1 opaque.
  const oneByOne = { width: 1, height: 1, data: new Uint8Array([17, 34, 51, 255]) };
  const bytes = await encodePng(oneByOne);
  const structure = encodeStructure('1x1 (synthesised)', bytes, 2, 1, 1);
  ok('1x1 (synthesised) [structure]', structure.pass, structure.detail);
  const back = await tryDecode(bytes);
  const diff = back.decoded
    ? dataDiff(back.decoded.data, oneByOne.data, 1)
    : 'did not decode: ' + (back.error || back.threw);
  ok('1x1 (synthesised) [round trip]', !diff,
    diff || 'opaque input with no `alpha` option -> colour type 2, pixels [17,34,51,255] back exactly');

  // The other half of the default rule: the same call with a translucent pixel must keep
  // the alpha channel, or a screenshot's rounded corners would come back opaque.
  const translucent = {
    width: 2,
    height: 2,
    data: new Uint8Array([9, 8, 7, 200, 0, 0, 0, 0, 255, 255, 255, 255, 4, 5, 6, 1]),
  };
  const rgbaBytes = await encodePng(translucent);
  const rgbaStructure = encodeStructure('2x2 (synthesised)', rgbaBytes, 6, 2, 2);
  ok('2x2 translucent, no `alpha` option [structure]', rgbaStructure.pass, rgbaStructure.detail);
  const rgbaBack = await tryDecode(rgbaBytes);
  const rgbaDiff = rgbaBack.decoded
    ? dataDiff(rgbaBack.decoded.data, translucent.data, 2)
    : 'did not decode: ' + (rgbaBack.error || rgbaBack.threw);
  ok('2x2 translucent, no `alpha` option [round trip]', !rgbaDiff,
    rgbaDiff || 'transparency present -> colour type 6, alpha 200/0/255/1 back exactly');
}

// ------------------------------------------------------------------ R3: the yield
/**
 * The codec must not walk a document without handing the event loop back
 * (`docs/agents/plans/image-budget.md` §6: a blocked second is a bug). Both halves:
 * count the turns the codec actually asks for while decoding a 160-row fixture, and read
 * the shipped module for the two things that must not change — an async-only zlib call
 * and a `% PNG_YIELD_ROWS` guard inside each row loop.
 */
async function responsiveness() {
  console.log('');
  console.log('-- host responsiveness (the per-row yield) --');
  const names = ['png-rgb-240x160.png', 'png-rgb-24x16.png'];
  const realSetImmediate = global.setImmediate;
  for (const name of names) {
    const bytes = read(name);
    let yields = 0;
    // The module yields with the global `setImmediate`, so counting it here counts the
    // codec's own hand-backs (the inflate await is a thread-pool job, not a setImmediate).
    global.setImmediate = (fn, ...args) => {
      yields++;
      return realSetImmediate(fn, ...args);
    };
    try {
      await tryDecode(bytes);
    } finally {
      global.setImmediate = realSetImmediate;
    }
    const height = EXPECT.decode[name].height;
    // The module yields when `(row + 1) % PNG_YIELD_ROWS === 0`, skipping the last row:
    // exactly floor((height - 1) / PNG_YIELD_ROWS) hand-backs per decode.
    const want = Math.floor((height - 1) / PNG_YIELD_ROWS);
    ok(`${name} yielded to the event loop while decoding`, yields === want,
      `${yields} yields for ${height} rows, PNG_YIELD_ROWS=${PNG_YIELD_ROWS}` +
      ` (want exactly ${want}${want ? '' : ': shorter than one slice'})`);
  }

  // The encode half's yield: the filter loop is the same shape, so measure it the same way.
  const encoded = await tryDecode(read('png-rgb-240x160.png'));
  if (encoded.decoded) {
    let yields = 0;
    global.setImmediate = (fn, ...args) => {
      yields++;
      return realSetImmediate(fn, ...args);
    };
    try {
      await encodePng(encoded.decoded, { alpha: false });
    } finally {
      global.setImmediate = realSetImmediate;
    }
    const want = Math.floor((encoded.decoded.height - 1) / PNG_YIELD_ROWS);
    ok('encodePng also yields while filtering', yields === want,
      `${yields} yields for ${encoded.decoded.height} rows during encode (want exactly ${want})`);
  }

  const compiled = fs.readFileSync(CODEC, 'utf8');
  ok('the shipped module never calls a *Sync zlib form',
    !/\b(?:inflate|deflate)(?:Raw)?Sync\b/.test(compiled),
    'no inflateSync/deflateSync in out/agent/pngCodec.js' +
    ' (a *Sync call blocks the host for the whole document)');
  const yieldsInSource = (compiled.match(/%\s*(?:exports\.)?PNG_YIELD_ROWS === 0/g) || []).length;
  ok('both row loops (decode and encode) carry the yield',
    yieldsInSource >= 2,
    `${yieldsInSource} "% PNG_YIELD_ROWS === 0" sites in out/agent/pngCodec.js ` +
    '(want >= 2: unfilter/expand + filter)');
}

// ------------------------------------------------------------------ E3: the heuristic
/** The PNG MSAD score of all five filters for one row (signed bytes; see the encoder). */
function msadScores(row, prev, bpp) {
  const scores = [];
  for (let k = 0; k < 5; k++) {
    let score = 0;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const sample = row[i];
      let value;
      if (k === 0) value = sample;
      else if (k === 1) value = sample - a;
      else if (k === 2) value = sample - b;
      else if (k === 3) value = sample - ((a + b) >> 1);
      else value = sample - paeth(a, b, c);
      value &= 0xff;
      score += value < 128 ? value : 256 - value;
    }
    scores.push(score);
  }
  return scores;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

async function filteringHeuristic() {
  console.log('');
  console.log('-- adaptive filtering (MSAD, recomputed here) --');
  const name = 'png-rgb-240x160.png';
  const want = EXPECT.encode[name];
  const decoded = await tryDecode(read(name));
  if (!decoded.decoded) {
    ok('filter heuristic on ' + name, false, 'the fixture did not decode');
    return;
  }
  const image = decoded.decoded;
  const bytes = await encodePng(image, { alpha: want.alpha });
  const written = ownRowFilters(bytes);
  if (!written) {
    ok('filter heuristic on ' + name, false, 'could not read the filter bytes back out of our own IDAT');
    return;
  }

  const channels = want.alpha ? 4 : 3;
  const bpp = channels;
  const rowBytes = image.width * channels;
  const prev = new Uint8Array(rowBytes);
  const row = new Uint8Array(rowBytes);
  const mismatches = [];
  let nonZero = 0;
  for (let y = 0; y < image.height; y++) {
    const src = y * image.width * 4;
    for (let x = 0; x < image.width; x++) {
      row[x * channels] = image.data[src + x * 4];
      row[x * channels + 1] = image.data[src + x * 4 + 1];
      row[x * channels + 2] = image.data[src + x * 4 + 2];
      if (channels === 4) row[x * channels + 3] = image.data[src + x * 4 + 3];
    }
    const scores = msadScores(row, prev, bpp);
    // argmin, ties to the lowest filter number — the rule the encoder documents.
    let argmin = 0;
    for (let k = 1; k < 5; k++) if (scores[k] < scores[argmin]) argmin = k;
    if (written[y] !== argmin) {
      const detail = `${written[y]} vs argmin ${argmin} [${scores.join(',')}]`;
      mismatches.push(`row ${y}: wrote filter ${detail}`);
    }
    if (written[y] !== 0) nonZero++;
    prev.set(row);
  }
  ok(`${name} rows choose the argmin of the five MSAD scores`,
    mismatches.length === 0,
    mismatches.length
      ? `${mismatches.length}/${image.height} rows wrong — ${mismatches.slice(0, 3).join(' ; ')}`
      : `all ${image.height} rows: written filter == argmin of [${filterCounts(written)}]`);
  ok(`${name} is not "always filter 0"`, nonZero > 0,
    `${nonZero}/${image.height} rows use a non-zero filter`);

  // Cross-check against the *other* encoder's choice: libpng (behind PIL) applies the same
  // MSAD heuristic, so where these disagree one of the two is not doing what it documents.
  const pilFilters = EXPECT.decode[name].rowFilters;
  const differing = written.filter((f, i) => f !== pilFilters[i]).length;
  ok(`${name} agrees with PIL/libpng's own filter choice`, differing === 0,
    differing === 0
      ? `all ${image.height} rows identical to PIL's [${filterCounts(pilFilters)}]`
      : `${differing}/${image.height} rows differ ` +
        `(ours [${filterCounts(written)}] vs PIL [${filterCounts(pilFilters)}])`);
}

// ------------------------------------------------------------------ main
async function main() {
  console.log('check-png: the PNG codec against PIL-produced fixtures');
  console.log('  module   : ' + CODEC);
  console.log('  fixtures : ' + FIXTURES);
  console.log('  yields to the event loop every ' + PNG_YIELD_ROWS + ' rows (PNG_YIELD_ROWS)');
  console.log('  fixtures: ' + Object.keys(EXPECT.decode).length + ' decode · ' +
    Object.keys(EXPECT.refuse).length + ' refuse · ' + Object.keys(EXPECT.encode).length + ' encode');

  await decodeFixtures();
  await refuseFixtures();
  await robustness();
  await encodeFixtures();
  await filteringHeuristic();
  await responsiveness();

  console.log('');
  const sizes = Object.entries(ENCODE_SECTION)
    .map(([n, s]) => `${n} ${s.bytes}B vs PIL ${s.pil}B (${s.delta >= 0 ? '+' : ''}${s.delta})`)
    .join(' · ');
  console.log('bytes   : ' + sizes);
  console.log('');

  if (problems.length) {
    console.log(
      'FAIL check-png: ' + problems.length + '/' + checks + ' checks failed — first: ' + problems[0],
    );
    process.exit(1);
  }
  console.log('PASS check-png: ' + checks + '/' + checks + ' checks (' +
    Object.keys(EXPECT.decode).length + ' decode fixtures pixel-identical to PIL, ' +
    Object.keys(EXPECT.refuse).length + ' refusals, garbage + slices never threw, ' +
    Object.keys(EXPECT.encode).length + ' encodes round-tripped, structure and CRCs valid, ' +
    'adaptive filtering == MSAD argmin)');
  process.exit(0);
}

main().catch((err) => {
  console.log('');
  const detail = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
  console.log('FAIL check-png: harness error — ' + detail);
  process.exit(1);
});
