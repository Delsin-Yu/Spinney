/*
 * check-image — slice A1's transform contract, as a build-time guard
 * (`docs/agents/plans/image-budget.md` §2, §3, §6).
 *
 * WHY IT EXISTS
 * `transformImage` decides what actually leaves for the provider, and three of its rules
 * are invisible until a real request pays for them:
 *
 *   - `changed: false` must mean the input bytes go up **verbatim**. A re-encode of an
 *     already-small image costs bytes, invalidates a cached prefix and buys nothing, so
 *     "nothing to do" has to be provable byte for byte, not "roughly equal".
 *   - the transformed pixels must BE the image — a PNG re-encode that is valid but shifted,
 *     channel-swapped or aliased is the one failure a byte count cannot see. Every
 *     transformed case here is compared against an independent oracle from
 *     `tools/gen-image-fixtures.py` (PIL crops, PIL's own box reduction, and an
 *     integer-weight area average written in Python), and the crop/resample arithmetic is
 *     pinned by `tools/check-resample.js` and `tools/check-png.js` in their own right.
 *   - a downscale-only transform that did not pay for itself must be discarded. Compression
 *     can lose to the source (a flat diagram, a screenshot, a small lossy JPEG re-encoded as
 *     PNG), and then the re-encode is a bigger upload in the one metric this slice exists
 *     for — so the source is returned verbatim, with a reason that says so. That reason is
 *     asserted per format, because a refactor that quietly starts re-encoding again would
 *     otherwise only show up as bytes on somebody's request.
 *   - a bad image must never throw and never be half-transformed: an unreadable PNG, a
 *     progressive JPEG, a GIF, or a `rect` the model made up all end as `changed: false`
 *     with a reason, and `readImageSize` still answers whatever the header really says.
 *
 * The fixtures are PIL's output (never this codec's), the expectations are committed in
 * `tools/fixtures/image/expect-image.json`, and nothing here needs python: the guard runs
 * on a machine that has only node and `out/`.
 *
 * Needs `out/` (run `npm run compile` first).
 *
 * Run: npm run check:image   /   node tools/check-image.js
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'image');
const T = require(path.join(ROOT, 'out', 'agent', 'imageTransform.js'));
const PNG = require(path.join(ROOT, 'out', 'agent', 'pngCodec.js'));
const Types = require(path.join(ROOT, 'out', 'agent', 'types.js'));

const problems = [];
const ok = (label, cond, detail) => {
  if (cond) console.log(`  [ok  ] ${label}${detail ? '  (' + detail + ')' : ''}`);
  else {
    console.log(`  [FAIL] ${label}${detail ? '  (' + detail + ')' : ''}`);
    problems.push(label + (detail ? ': ' + detail : ''));
  }
};
const section = (name) => console.log('\n-- ' + name + ' --');

const read = (name) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
const sha256 = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const hex = (bytes) => Buffer.from(bytes).toString('hex').slice(0, 40);
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const px = (p) => `${p[0]},${p[1]},${p[2]},${p[3]}`;
const close = (a, b, eps) => typeof a === 'number' && Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps);

/** Walk a PNG's chunks: structure, IHDR fields and every CRC (types.ts owns the polynomial). */
function pngStructure(bytes) {
  const bad = [];
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || SIG.some((v, i) => bytes[i] !== v)) bad.push('no PNG signature');
  const chunks = [];
  let off = 8;
  let ihdr = null;
  while (off + 8 <= bytes.length) {
    const len = Types.readU32BE(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (off + 12 + len > bytes.length) {
      bad.push(`${type} chunk overruns the file`);
      break;
    }
    const dataEnd = off + 8 + len;
    if (Types.readU32BE(bytes, dataEnd) !== Types.crc32(bytes.subarray(off + 4, dataEnd))) {
      bad.push(`bad CRC in ${type}`);
    }
    chunks.push(type + '(' + len + ')');
    if (type === 'IHDR') {
      ihdr = {
        width: Types.readU32BE(bytes, off + 8),
        height: Types.readU32BE(bytes, off + 12),
        bitDepth: bytes[off + 16],
        colourType: bytes[off + 17],
        compression: bytes[off + 18],
        filter: bytes[off + 19],
        interlace: bytes[off + 20],
      };
    }
    off = dataEnd + 4;
    if (type === 'IEND') break;
  }
  if (off !== bytes.length) bad.push(`${bytes.length - off} trailing byte(s) after the last chunk`);
  if (!ihdr) bad.push('no IHDR');
  return { bad, chunks, ihdr };
}

/** The oracle pixels of a case, or a hash-comparison when only the sha256 is committed. */
function comparePixels(label, got, width, cs) {
  if (cs.rgba) {
    const want = cs.rgba.flat();
    const bad = [];
    for (let i = 0; i < want.length && bad.length < 6; i++) {
      if (got[i] !== want[i]) {
        const p = Math.floor(i / 4);
        bad.push(`pixel (${p % width},${Math.floor(p / width)}) channel ${i % 4}: got ${got[i]} want ${want[i]}`);
      }
    }
    if (got.length !== want.length) bad.push(`length ${got.length} vs ${want.length}`);
    ok(label + ' pixels == oracle', bad.length === 0, bad.length ? bad.join(' ; ') : `${want.length / 4} px`);
    return;
  }
  if (cs.spots) {
    const bad = [];
    for (const [idx, r, g, b, a] of cs.spots) {
      const got4 = [got[idx * 4], got[idx * 4 + 1], got[idx * 4 + 2], got[idx * 4 + 3]];
      if (got4.join(',') !== [r, g, b, a].join(',')) bad.push(`spot ${idx}: got ${got4.join(',')} want ${r},${g},${b},${a}`);
    }
    ok(label + ' spot pixels == oracle', bad.length === 0, bad.length ? bad.join(' ; ') : `${cs.spots.length} spots`);
  }
  const gotSha = sha256(got);
  ok(label + ' rgba sha256 == oracle', gotSha === cs.rgbaSha256, gotSha === cs.rgbaSha256 ? gotSha.slice(0, 16) : `got ${gotSha.slice(0, 16)} want ${cs.rgbaSha256.slice(0, 16)}`);
}

async function main() {
  console.log('check-image: transformImage / readImageSize / normalizeRect');
  console.log('  fixtures: ' + FIXTURES);
  const expect = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expect-image.json'), 'utf8'));
  const files = expect.files;
  const cases = expect.cases;

  ok('IMAGE_TARGET_MAX_SIDE is the documented 1024', T.IMAGE_TARGET_MAX_SIDE === 1024, String(T.IMAGE_TARGET_MAX_SIDE));

  // ---------------------------------------------------------------- readImageSize
  section('readImageSize: the header alone, synchronous');
  {
    const bad = [];
    for (const [name, meta] of Object.entries(files)) {
      const got = T.readImageSize(read(name), meta.mime);
      if (meta.mime === 'image/gif' || meta.mime === 'image/webp') {
        if (got !== undefined) bad.push(`${name}: ${JSON.stringify(got)} (expected undefined for ${meta.mime})`);
      } else if (!got || got.width !== meta.width || got.height !== meta.height) {
        bad.push(`${name}: ${JSON.stringify(got)} want ${meta.width}x${meta.height}`);
      }
    }
    ok('every fixture the header can measure', bad.length === 0, bad.length ? bad.join(' ; ') : `${Object.keys(files).length} files`);
    ok('a mime with parameters is still understood', JSON.stringify(T.readImageSize(read('tm-small-40x30.png'), 'image/png; charset=binary')) === '{"width":40,"height":30}');
    ok('an unknown mime sniffs the signature', JSON.stringify(T.readImageSize(read('tm-photo-1200x800.jpg'), 'application/octet-stream')) === '{"width":1200,"height":800}');
    ok('the header read is not an integrity check', JSON.stringify(T.readImageSize(read('tm-malformed.png'), 'image/png')) === '{"width":40,"height":30}', 'a flipped IDAT byte leaves IHDR honest');
    ok('a file truncated inside IHDR has no size', T.readImageSize(read('tm-small-40x30.png').subarray(0, 20), 'image/png') === undefined);
    ok('a truncation that leaves IHDR intact still reads', JSON.stringify(T.readImageSize(read('png-malformed-truncated.png'), 'image/png')) === '{"width":24,"height":16}', 'the size is a header read, not a validation');
    ok('garbage has no size', T.readImageSize(new Uint8Array([1, 2, 3]), 'image/png') === undefined);
    ok('an empty buffer has no size', T.readImageSize(new Uint8Array(0), 'image/jpeg') === undefined);
    ok('a PNG whose first chunk is not IHDR has no size', T.readImageSize(read('png-malformed-signature.png'), 'image/png') === undefined);
  }

  // ---------------------------------------------------------------- normalizeRect
  section('normalizeRect: the rect the caller already validated');
  {
    const show = (v) => JSON.stringify(v);
    ok('no rect is legal', show(T.normalizeRect(undefined, 40, 30)) === '{}' && show(T.normalizeRect(null, 40, 30)) === '{}');
    const exact = T.normalizeRect({ x: 10, y: 5, w: 20, h: 15 }, 40, 30);
    ok('an inside rect is kept as given', show(exact) === '{"rect":{"x":10,"y":5,"w":20,"h":15}}', show(exact));
    const clamped = T.normalizeRect({ x: -5, y: -5, w: 1e6, h: 1e6 }, 100, 50);
    ok('an oversized rect clamps to the image', show(clamped) === '{"rect":{"x":0,"y":0,"w":100,"h":50}}', show(clamped));
    const frac = T.normalizeRect({ x: 1.6, y: 2.4, w: 3.2, h: 3.2 }, 40, 30);
    ok('fractional edges round outwards to cover the pixels', show(frac) === '{"rect":{"x":1,"y":2,"w":4,"h":4}}', show(frac));
    const casesBad = [
      ['a rect with no fields', { foo: 1 }, 40, 30],
      ['a rect with a missing field', { x: 0, y: 0, w: 4 }, 40, 30],
      ['a non-numeric field', { x: '0', y: 0, w: 4, h: 4 }, 40, 30],
      ['a NaN field', { x: NaN, y: 0, w: 4, h: 4 }, 40, 30],
      ['a non-positive w', { x: 0, y: 0, w: 0, h: 4 }, 40, 30],
      ['a negative h', { x: 0, y: 0, w: 4, h: -2 }, 40, 30],
      ['a rect entirely to the right', { x: 1000, y: 0, w: 10, h: 10 }, 40, 30],
      ['a rect entirely below', { x: 0, y: 500, w: 10, h: 10 }, 40, 30],
      ['a string', 'rect', 40, 30],
      ['an array', [0, 0, 4, 4], 40, 30],
      ['a number', 7, 40, 30],
    ];
    const bad = [];
    for (const [label, raw, w, h] of casesBad) {
      const got = T.normalizeRect(raw, w, h);
      if (typeof got.error !== 'string' || !got.error.length || got.rect) bad.push(`${label}: ${show(got)}`);
      else if (/[a-z0-9_]+\.[a-z0-9_.]+$|^%/.test(got.error)) bad.push(`${label}: reason looks like an l10n key: ${got.error}`);
    }
    ok('every malformed rect returns a sentence, not a rect', bad.length === 0, bad.length ? bad.join(' ; ') : `${casesBad.length} malformed shapes`);
    ok('the sentence names the fields it wants', /x, y, w and h/.test(T.normalizeRect({}, 40, 30).error));
    ok('a zero size says so instead of "outside the image"', /positive w and h/.test(T.normalizeRect({ x: 0, y: 0, w: 0, h: 0 }, 40, 30).error));
  }

  // ---------------------------------------------------------------- transformImage: the fixture cases
  section('transformImage: the PIL-oracle cases');
  {
    for (const cs of cases) {
      const meta = files[cs.src];
      const bytes = read(cs.src);
      const rect = cs.rect ? { x: cs.rect[0], y: cs.rect[1], w: cs.rect[2], h: cs.rect[3] } : undefined;
      let out;
      try {
        out = await T.transformImage({ bytes, mime: meta.mime, rect });
      } catch (err) {
        ok(`${cs.name}: no throw`, false, String((err && err.message) || err));
        continue;
      }
      if (cs.expectChanged === false) {
        // `reasonMustMatch` is what makes the size-clamp cases real: a future refactor that
        // starts re-encoding a source that grows the upload must fail here, loudly, instead
        // of quietly reintroducing the defect this rule exists for.
        const reasonOk = !cs.reasonMustMatch || new RegExp(cs.reasonMustMatch, 'i').test(out.reason || '');
        const dimsOk = cs.width === undefined || (out.width === cs.width && out.height === cs.height);
        const good =
          out.changed === false &&
          out.mime === meta.mime &&
          out.scale === 1 &&
          same(out.bytes, bytes) &&
          typeof out.reason === 'string' &&
          out.reason.length > 0 &&
          reasonOk &&
          dimsOk;
        ok(
          `${cs.name}: verbatim pass-through`,
          good,
          `${good ? '' : 'WRONG BEHAVIOUR: '}changed=${out.changed} ${out.width}x${out.height} ` +
            `${cs.width !== undefined ? 'want ' + cs.width + 'x' + cs.height + ' ' : ''}scale=${out.scale} ` +
            `mime=${out.mime} bytes-identical=${same(out.bytes, bytes)} reason "${out.reason}"` +
            (cs.reasonMustMatch ? ` (must match /${cs.reasonMustMatch}/i)` : ''),
        );
      } else {
        const rectOk = cs.rect
          ? out.rect && out.rect.x === rect.x && out.rect.y === rect.y && out.rect.w === rect.w && out.rect.h === rect.h
          : out.rect === undefined;
        const good =
          out.changed === true &&
          out.mime === 'image/png' &&
          out.sourceWidth === meta.width &&
          out.sourceHeight === meta.height &&
          rectOk;
        ok(
          `${cs.name}: changed, ${out.width}x${out.height}, scale ${typeof out.scale === 'number' ? out.scale.toFixed(4) : out.scale}`,
          good && out.width === cs.width && out.height === cs.height && close(out.scale, cs.scale),
          `changed=${out.changed} mime=${out.mime} ${out.width}x${out.height} want ${cs.width}x${cs.height} ` +
            `scale ${out.scale} want ${cs.scale} source ${out.sourceWidth}x${out.sourceHeight} rect ${JSON.stringify(out.rect)}`,
        );
        const dec = await PNG.decodePng(out.bytes);
        if (dec.error) {
          ok('  … result decodes', false, dec.error);
          continue;
        }
        ok('  … result decodes to its own size', dec.width === out.width && dec.height === out.height, `${dec.width}x${dec.height}`);
        // A JPEG crop has no pixel oracle (our decode of a lossy file is not byte-reproducible
        // against PIL's), so its case carries none and only the shape is asserted.
        if (cs.rgba || cs.spots || cs.rgbaSha256) {
          comparePixels('  … result', dec.data, dec.width, cs);
        }
        const st = pngStructure(out.bytes);
        ok('  … result is a well-formed PNG', st.bad.length === 0, st.bad.length ? st.bad.join(' ; ') : st.chunks.join(' '));
      }
    }
  }

  // ---------------------------------------------------------------- the crop contract
  section('the crop contract: the kept region is reported and applied');
  {
    const meta = files['tm-small-40x30.png'];
    const bytes = read('tm-small-40x30.png');
    const out = await T.transformImage({ bytes, mime: meta.mime, rect: { x: 10, y: 5, w: 20, h: 15 } });
    ok('the recorded rect is the region that was kept', JSON.stringify(out.rect) === '{"x":10,"y":5,"w":20,"h":15}', JSON.stringify(out.rect));
    const clamped = await T.transformImage({ bytes, mime: meta.mime, rect: { x: 30, y: 20, w: 100, h: 100 } });
    ok(
      'a rect hanging over an edge reports the clamped region',
      JSON.stringify(clamped.rect) === '{"x":30,"y":20,"w":10,"h":10}' && clamped.width === 10 && clamped.height === 10,
      JSON.stringify(clamped.rect) + ` -> ${clamped.width}x${clamped.height}`,
    );
    const whole = await T.transformImage({ bytes, mime: meta.mime, rect: { x: 0, y: 0, w: 40, h: 30 } });
    ok(
      'a rect around the whole image changes nothing (byte-identical)',
      whole.changed === false && same(whole.bytes, bytes),
      `changed=${whole.changed} reason "${whole.reason}"`,
    );
    ok('  … and the source size is still reported', whole.width === 40 && whole.height === 30 && whole.sourceWidth === 40 && whole.sourceHeight === 30);
    const cropped = await T.transformImage({ bytes: out.bytes, mime: out.mime, rect: { x: 0, y: 0, w: 20, h: 15 } });
    ok('cropping an already-small region is a no-op again', cropped.changed === false, `changed=${cropped.changed} reason "${cropped.reason}"`);
  }

  // ---------------------------------------------------------------- the size clamp
  section('a re-encode that would grow the upload is discarded (no rect only)');
  {
    // The defect this rule fixes: a downscale-only transform could quintuple the bytes in the
    // very metric the slice exists for. Each format gets its own case, and the reason string is
    // asserted so the clamp cannot silently disappear.
    const grows = [
      ['tm-tall-600x1500.png (flat PNG)', 'image/png', 'tm-tall-600x1500.png'],
      ['tm-wide-2000x8.png (flat PNG)', 'image/png', 'tm-wide-2000x8.png'],
      ['tm-photo-1200x800.jpg (small lossy JPEG)', 'image/jpeg', 'tm-photo-1200x800.jpg'],
    ];
    for (const [label, mime, file] of grows) {
      const bytes = read(file);
      const out = await T.transformImage({ bytes, mime });
      const good =
        out.changed === false &&
        same(out.bytes, bytes) &&
        out.mime === mime &&
        out.scale === 1 &&
        /the re-encode would not have been smaller/i.test(out.reason || '') &&
        out.width === files[file].width &&
        out.height === files[file].height;
      ok(`${label}: source kept verbatim`, good, `${bytes.length} B in, ${out.bytes.length} B out, changed=${out.changed}, reason "${out.reason}"`);
    }
    // The contrast: the same file under a `rect` is a view the model asked for, so it is
    // returned even though the PNG is bigger than the JPEG it came from.
    const jpg = read('tm-photo-1200x800.jpg');
    const cropped = await T.transformImage({ bytes: jpg, mime: 'image/jpeg', rect: { x: 100, y: 50, w: 600, h: 400 } });
    ok(
      'a JPEG under a rect is still transformed (a crop is never dropped for size)',
      cropped.changed === true && cropped.mime === 'image/png' && cropped.width === 600 && cropped.height === 400 && cropped.bytes.length > jpg.length,
      `${jpg.length} B JPEG -> ${cropped.bytes.length} B PNG (bigger, and kept), 600x400`,
    );
    const wide = read('tm-wide-2000x8.png');
    const wholeRect = await T.transformImage({ bytes: wide, mime: 'image/png', rect: { x: 0, y: 0, w: 2000, h: 8 } });
    ok(
      'a PNG under a rect is still transformed (same file, opposite answer)',
      wholeRect.changed === true && wholeRect.bytes.length > wide.length && wholeRect.width === 1024,
      `the same ${wide.length} B file: no rect -> 654 B verbatim, with a rect -> ${wholeRect.bytes.length} B PNG`,
    );
    // And the fixture that makes the opposite branch real: a downscale that IS smaller.
    const noisy = read('tm-noisy-1400x120.png');
    const shrunk = await T.transformImage({ bytes: noisy, mime: 'image/png' });
    ok(
      'a downscale that pays for itself is still performed',
      shrunk.changed === true && shrunk.bytes.length < noisy.length && shrunk.width === 1024 && shrunk.height === 88,
      `${noisy.length} B -> ${shrunk.bytes.length} B, ${shrunk.sourceWidth}x${shrunk.sourceHeight} -> ${shrunk.width}x${shrunk.height}`,
    );
  }

  // ---------------------------------------------------------------- idempotence
  section('a transformed image is already transformed');
  {
    for (const src of ['tm-noisy-1400x120.png', 'tm-wide-2000x8.png']) {
      const bytes = read(src);
      const first = await T.transformImage({ bytes, mime: files[src].mime });
      const second = await T.transformImage({ bytes: first.bytes, mime: first.mime });
      ok(
        `${src}: ${bytes.length} B -> ${first.bytes.length} B -> ${second.bytes.length} B (no second pass)`,
        second.changed === false && same(second.bytes, first.bytes),
        `changed ${first.changed}/${second.changed}, reason "${second.reason}"`,
      );
    }
  }

  // ---------------------------------------------------------------- never throws
  section('a bad image is a reason, never a throw');
  {
    const shapes = [
      ['an empty buffer', new Uint8Array(0), 'image/png'],
      ['three bytes', new Uint8Array([1, 2, 3]), 'image/png'],
      ['the PNG signature alone', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
      ['the PNG signature and a truncated IHDR', read('tm-small-40x30.png').subarray(0, 20), 'image/png'],
      ['a JPEG signature alone', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
      ['a truncated JPEG', read('tm-photo-1200x800.jpg').subarray(0, 400), 'image/jpeg'],
      ['a PNG under a JPEG mime', read('tm-small-40x30.png'), 'image/jpeg'],
      ['a GIF under a PNG mime', read('tm-anim-8x8.gif'), 'image/png'],
      ['raw RGBA bytes', read('rs-wide-2000x8.rgba'), 'application/octet-stream'],
      ['an empty mime on a real JPEG', read('tm-photo-1200x800.jpg'), ''],
      ['a rect on an unreadable file', read('tm-malformed.png'), 'image/png', { x: 0, y: 0, w: 10, h: 10 }],
      ['a rect on a GIF', read('tm-anim-8x8.gif'), 'image/gif', { x: 0, y: 0, w: 4, h: 4 }],
    ];
    const bad = [];
    for (const [label, bytes, mime, rect] of shapes) {
      try {
        const out = await T.transformImage({ bytes, mime, rect });
        if (typeof out.changed !== 'boolean' || !(out.bytes instanceof Uint8Array)) bad.push(`${label}: ${JSON.stringify({ changed: out.changed, bytes: typeof out.bytes })}`);
        else if (!out.changed && (typeof out.reason !== 'string' || !out.reason.length)) bad.push(`${label}: unchanged without a reason`);
        else if (out.changed && out.mime !== 'image/png') bad.push(`${label}: changed but mime ${out.mime}`);
        else if (!out.changed && !same(out.bytes, bytes)) bad.push(`${label}: unchanged but the bytes differ`);
      } catch (err) {
        bad.push(`${label} threw: ${(err && err.message) || err}`);
      }
    }
    ok(`${shapes.length} damaged/lying inputs return an outcome`, bad.length === 0, bad.length ? bad.join(' ; ') : 'no throw, no missing reason');
  }

  section('every fixture in the folder survives the transform');
  {
    const bad = [];
    const names = fs.readdirSync(FIXTURES);
    const mimeOf = (name) => {
      const lower = name.toLowerCase();
      if (lower.endsWith('.png')) return 'image/png';
      if (lower.endsWith('.jpg')) return 'image/jpeg';
      if (lower.endsWith('.gif')) return 'image/gif';
      if (lower.endsWith('.webp')) return 'image/webp';
      if (lower.endsWith('.json')) return 'application/json';
      return 'application/octet-stream';
    };
    for (const name of names) {
      const bytes = read(name);
      const mime = mimeOf(name);
      try {
        const out = await T.transformImage({ bytes, mime });
        if (!out.changed && !same(out.bytes, bytes)) bad.push(`${name}: unchanged but the bytes differ`);
        if (out.changed) {
          const dec = await PNG.decodePng(out.bytes);
          if (dec.error) bad.push(`${name}: changed but not decodable (${dec.error})`);
        }
        // the transformed form must itself be a fixed point (never larger on a second pass)
        if (out.changed) {
          const again = await T.transformImage({ bytes: out.bytes, mime: out.mime });
          if (again.changed) bad.push(`${name}: a second pass changed it again`);
        }
      } catch (err) {
        bad.push(`${name} threw: ${(err && err.message) || err}`);
      }
    }
    ok(`${names.length} files in tools/fixtures/image`, bad.length === 0, bad.length ? bad.join(' ; ') : 'no throw, results consistent');
  }

  // ---------------------------------------------------------------- sizes
  section('what the transform costs in bytes (reported, not asserted)');
  {
    for (const [file, mime] of [
      ['tm-noisy-1400x120.png', 'image/png'],
      ['tm-tall-600x1500.png', 'image/png'],
      ['tm-wide-2000x8.png', 'image/png'],
      ['tm-photo-1200x800.jpg', 'image/jpeg'],
    ]) {
      const bytes = read(file);
      const out = await T.transformImage({ bytes, mime });
      console.log(
        `  [info] ${file}: ${bytes.length} B -> ${out.bytes.length} B (${out.sourceWidth}x${out.sourceHeight}` +
          (out.changed ? ` -> ${out.width}x${out.height})` : ', kept verbatim)'),
      );
    }
    const small = read('tm-small-40x30.png');
    console.log(`  [info] tm-small-40x30.png: ${small.length} B, unchanged (a crop would re-encode it: ` +
      `${(await T.transformImage({ bytes: small, mime: 'image/png', rect: { x: 0, y: 0, w: 20, h: 30 } })).bytes.length} B)`);
  }

  console.log('');
  if (problems.length) {
    console.log(`FAIL check-image: ${problems.length} check(s) failed`);
    for (const p of problems.slice(0, 12)) console.log('   · ' + p);
    process.exit(1);
  }
  console.log('PASS check-image: readImageSize reads PNG/JPEG headers only, normalizeRect refuses every malformed rect, ' +
    'nothing-to-do is byte-identical, a re-encode that would grow the upload is discarded (a rect never is), and ' +
    'every transformed case matches its independent pixel oracle');
  process.exit(0);
}

main().catch((err) => {
  console.log('');
  console.log('FAIL check-image: harness error — ' + ((err && err.stack) || String(err)));
  process.exit(1);
});
