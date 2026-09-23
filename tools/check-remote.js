/*
 * check-remote — the transport-independent core of remote control, as a build-time guard.
 *
 * WHAT IT GUARDS. `src/remote/rooms.ts`, `src/remote/frames.ts` and
 * `src/remote/allowlist.ts` are the half of the feature that has no socket in it: the key
 * schedule, the frame envelope (seal / slice / reassemble / open), the replay window and
 * the two deny-by-default message tables. None of that is visible in the UI when it goes
 * wrong — a wrong HKDF `info` string or a shifted nonce still "works" against itself and
 * only breaks when a *second* implementation (the C# relay's peers, the Kotlin app) or a
 * *later* release talks to this one. So the contract is pinned here, in the open, by value:
 *
 *   1. the derivation (deterministic, 26 base32 characters, keys 32 bytes);
 *   2. the three layers, kept apart: the AAD `v|seq|fid`, the transport slice
 *      `{v,seq,fid,idx,last,b}`, and the sealed logical frame
 *      `{v,type,id,from,to,body}` — each with its key order and each with its refusals,
 *      plus the proof that an AAD naming `type`/`to` cannot open a frame (the receiver
 *      could never reconstruct it, so it must never be what a sender used);
 *   3. `id` and `fid` are independent — a frame whose correlation id differs from its
 *      framing id is normal, and nothing derives one from the other;
 *   4. a seal → open round trip, and the four failures told apart: a tampered AAD or salt
 *      must fail as AUTH, an oversized frame as SIZE, a replayed seq as REPLAY;
 *   5. slicing and reassembly, byte for byte, including the 16 MiB cap and the ordering
 *      rules (out-of-order, duplicate, slice after the final one, malformed base64, a
 *      `seq`/`v` that disagrees with the rest of its frame);
 *   6. the replay window's edges (at the floor, one below it, a duplicate);
 *   7. the allow-lists: `perfDiag`, `layoutDiagnostic`, `setNodeSize`, `copyNodeId`,
 *      `openExternal`, `pickImage`, `openModelTree` and `ready` are refused, `userMessage`
 *      and `stop` are accepted, and an unknown type is refused in both directions;
 *   8. `remote/vectors/vectors.json` — **when it exists and carries the post-fix shape** —
 *      every derivation, every sealed frame and every slice set reproduced from the file.
 *
 * The vectors file is written by the M0 milestone (`docs/agents/plans/remote-control.md`
 * §10-12) and may not be there yet: its absence is reported, never failed. The same is
 * true of a file that still carries the **pre-fix** shape (an 8-field AAD, no `to` in the
 * plaintext, slices without `seq`): that file predates the contract fix and is skipped
 * loudly rather than failed, so a regeneration running in parallel never shows up as a
 * false red. The new-shape reader is not left untested by that skip — section 9 runs it
 * over synthetic new-shape fixtures built here, so the path the regenerated file needs is
 * exercised on every run.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled modules).
 *
 * Run: node tools/check-remote.js
 */
const fs = require('fs');
const path = require('path');
const { createDecipheriv } = require('node:crypto');

const root = path.join(__dirname, '..');
const OUT = {
  rooms: path.join(root, 'out', 'remote', 'rooms.js'),
  frames: path.join(root, 'out', 'remote', 'frames.js'),
  allowlist: path.join(root, 'out', 'remote', 'allowlist.js'),
};
for (const [name, file] of Object.entries(OUT)) {
  if (!fs.existsSync(file)) {
    console.error(`check-remote: out/remote/${name}.js is missing — run \`npm run compile\` first.`);
    process.exit(1);
  }
}
const rooms = require(OUT.rooms);
const frames = require(OUT.frames);
const allowlist = require(OUT.allowlist);

const problems = [];
let checks = 0;
let skipped = 0;

/**
 * One assertion. Both lines are printed, because a guard that only speaks up when it
 * fails cannot be told apart from one that never ran.
 */
function ok(label, cond, detail) {
  checks++;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail === undefined ? '' : `  (${detail})`}`);
  if (!cond) {
    problems.push(label);
  }
  return cond;
}

/** Something this run could not judge, said out loud — never silently treated as a pass. */
function skip(label, detail) {
  skipped++;
  console.log(`  [warn] ${label}${detail === undefined ? '' : `  (${detail})`}`);
}

/** Does this call throw this family? For the places where several probes belong to one line. */
function throwsWith(fn, errorClass) {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof errorClass;
  }
}

/**
 * Assert that a call throws, and that it throws the *right* kind: telling 'too big' from
 * 'tampered' from 'replayed' is the whole point of the error taxonomy, so a check that
 * only sees "something was thrown" proves nothing.
 */
function fails(label, fn, errorClass) {
  let err = null;
  try {
    fn();
  } catch (thrown) {
    err = thrown;
  }
  if (!err) {
    ok(label, false, 'nothing was thrown');
    return null;
  }
  ok(label, errorClass ? err instanceof errorClass : true, err.name);
  return err;
}

/** Run a call that is expected to succeed, and hand back either its value or its error. */
function attempt(fn) {
  try {
    return { value: fn() };
  } catch (err) {
    return { err };
  }
}

const hex = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).toString('hex');
const toBuffer = (bytes) => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));

/**
 * A raw AEAD open that does **not** go through `frames.openFrame`, so the AAD this file
 * believes in can be checked against the sealed bytes themselves: a receiver-side bug in
 * the AAD builder would otherwise be invisible, because the same builder runs on both
 * sides of the round trip.
 */
function rawOpen(encKey, nonce, aad, sealed) {
  const bytes = toBuffer(sealed);
  const decipher = createDecipheriv('aes-256-gcm', toBuffer(encKey), toBuffer(nonce));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------------------
// 1. rooms: the key schedule
// ---------------------------------------------------------------------------------------
console.log('-- rooms: token → master → room id, and the two keys --');

const TOKEN = 'correct horse battery staple';
const derived = rooms.deriveRoom(TOKEN);
const again = rooms.deriveRoom(TOKEN);

ok('the derivation is deterministic', derived.roomId === again.roomId && hex(derived.encKey) === hex(again.encKey) && hex(derived.macKey) === hex(again.macKey), derived.roomId);
ok('roomId is 26 characters', derived.roomId.length === 26, String(derived.roomId.length));
ok('roomId is uppercase RFC 4648 base32, unpadded', /^[A-Z2-7]{26}$/.test(derived.roomId), derived.roomId);
ok('encKey and macKey are 32 bytes', derived.encKey.length === 32 && derived.macKey.length === 32, `${derived.encKey.length}/${derived.macKey.length}`);
ok('encKey and macKey are not the same key (HKDF info separates the roles)', hex(derived.encKey) !== hex(derived.macKey));
ok('the room id is not the key material', derived.roomId !== hex(derived.encKey).slice(0, 26).toUpperCase());

// The exported steps must compose to exactly the one-call derivation: a port that calls
// them separately (as the vectors check does) must not get a different room.
const composed = rooms.keysFromMaster(rooms.deriveMaster(TOKEN));
ok('keysFromMaster(deriveMaster(token)) === deriveRoom(token)', composed.roomId === derived.roomId && hex(composed.encKey) === hex(derived.encKey) && hex(composed.macKey) === hex(derived.macKey));
ok('roomIdOf is the base32 of roomIdBytes', rooms.roomIdOf(rooms.deriveMaster(TOKEN)) === derived.roomId);
ok('roomIdBytes is 16 bytes', rooms.roomIdBytes(rooms.deriveMaster(TOKEN)).length === 16);
fails('a master of the wrong length is refused (not silently re-derived)', () => rooms.keysFromMaster(Buffer.alloc(31)), Error);

const other = rooms.deriveRoom(`${TOKEN} x`);
ok('a different token is a different room', other.roomId !== derived.roomId && hex(other.encKey) !== hex(derived.encKey));

// A non-ASCII token must be usable unchanged, and "the literal bytes" means no implicit
// normalization: NFC and NFD spellings of the same word are two different tokens.
const nfc = rooms.deriveRoom('\u00e9');
const nfd = rooms.deriveRoom('e\u0301');
ok('a non-ASCII token derives a valid room id', /^[A-Z2-7]{26}$/.test(nfc.roomId), nfc.roomId);
ok('the token bytes are used verbatim (no NFC/NFD normalization)', nfc.roomId !== nfd.roomId);
fails('an empty token is refused (every empty token would share one room)', () => rooms.deriveRoom(''), Error);

console.log('-- rooms: the token-strength check the connect dialog uses --');
ok('a strong ASCII token passes', rooms.tokenIssue(TOKEN) === null, String(rooms.tokenIssue(TOKEN)));
ok('a strong non-ASCII token passes (no ASCII-only model)', rooms.tokenIssue('\u039a\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1-\u03ba\u03cc\u03c3\u03bc\u03b5-\u03c3\u03ae\u03bc\u03b5\u03c1\u03b1') === null);
ok('exactly the minimum length passes', rooms.tokenIssue('abcdefghijklmnop') === null, '16 characters');
ok('one character below the minimum is too-short', rooms.tokenIssue('abcdefghijklmno') === 'too-short');
ok('an empty token is empty', rooms.tokenIssue('') === 'empty');
ok('one repeated character is too-few-distinct', rooms.tokenIssue('a'.repeat(24)) === 'too-few-distinct');

console.log('-- rooms: the room-id validator (it arrives as a URL path segment) --');
ok('the derived id is valid', rooms.isValidRoomId(derived.roomId));
ok('lowercase is refused', !rooms.isValidRoomId(derived.roomId.toLowerCase()));
ok('25 and 27 characters are refused', !rooms.isValidRoomId(derived.roomId.slice(0, 25)) && !rooms.isValidRoomId(`${derived.roomId}A`));
ok('a character outside the alphabet is refused (0, 1, padding)', !rooms.isValidRoomId(`${derived.roomId.slice(0, 25)}0`) && !rooms.isValidRoomId(`${derived.roomId.slice(0, 25)}=`));
ok('a non-string is refused', !rooms.isValidRoomId(undefined) && !rooms.isValidRoomId(null) && !rooms.isValidRoomId(26));

// ---------------------------------------------------------------------------------------
// 2. the logical frame: six keys, `to` included, sealed
// ---------------------------------------------------------------------------------------
console.log('-- frames: the logical frame (v,type,id,from,to,body) --');

// Deliberately different on purpose: `id` is the caller's correlation id and `fid` is the
// transport's framing id, and the two live for different lengths of time.
const ID = 'aabbccddeeff0011';
const FID = '0123456789abcdef';
const FROM = '9f3a1c02';
const envelope = { v: 1, type: 'mirror', id: ID, from: FROM, to: '*', body: { sessionId: 's1', message: { type: 'delta', text: 'hi' } } };
const plaintext = frames.encodeFrame(envelope);

ok(
  'encodeFrame writes the six keys in the contract order, compactly',
  plaintext === '{"v":1,"type":"mirror","id":"aabbccddeeff0011","from":"9f3a1c02","to":"*","body":{"sessionId":"s1","message":{"type":"delta","text":"hi"}}}',
  plaintext,
);
ok('decodeFrame round-trips the envelope', JSON.stringify(frames.decodeFrame(plaintext)) === JSON.stringify(envelope));
ok('the plaintext carries `to` (a sealed field the relay never sees)', frames.decodeFrame(plaintext).to === '*');
ok('`to` may name a peer instead of the broadcast', frames.decodeFrame(frames.encodeFrame({ ...envelope, to: '7b2f9d10' })).to === '7b2f9d10');
ok(
  'the envelope carries no `fid` and the slice carries no `id` (the two are independent)',
  !JSON.stringify(envelope).includes('"fid"') && !('fid' in frames.decodeFrame(plaintext)) && !Object.prototype.hasOwnProperty.call(frames.sealAndSlice({ encKey: derived.encKey, aad: { seq: 1, fid: FID }, salt: 1, plaintext })[0], 'id'),
);
fails('decodeFrame refuses a version drift', () => frames.decodeFrame('{"v":2,"type":"mirror","id":"f","from":"p","to":"*","body":null}'), frames.FrameFormatError);
fails('decodeFrame refuses a missing `to` (the pre-fix five-key shape)', () => frames.decodeFrame('{"v":1,"type":"mirror","id":"aabbccddeeff0011","from":"9f3a1c02","body":null}'), frames.FrameFormatError);
fails('decodeFrame refuses a missing field', () => frames.decodeFrame('{"v":1,"type":"mirror","id":"aabbccddeeff0011","to":"*","body":null}'), frames.FrameFormatError);
fails('decodeFrame refuses an unknown key', () => frames.decodeFrame('{"v":1,"type":"mirror","id":"aabbccddeeff0011","from":"p","to":"*","body":null,"extra":1}'), frames.FrameFormatError);
fails('decodeFrame refuses non-JSON', () => frames.decodeFrame('not json'), frames.FrameFormatError);
fails('encodeFrame refuses an undefined body (JSON.stringify would drop the key)', () => frames.encodeFrame({ ...envelope, body: undefined }), frames.FrameFormatError);
fails('encodeFrame refuses an empty `to`', () => frames.encodeFrame({ ...envelope, to: '' }), frames.FrameFormatError);

// ---------------------------------------------------------------------------------------
// 3. the AAD: `v|seq|fid`, and nothing else
// ---------------------------------------------------------------------------------------
console.log('-- frames: the canonical AAD is v|seq|fid --');

const aad = { seq: 7, fid: FID };

ok('canonicalAad is v|seq|fid, decimals unpadded', frames.canonicalAad(aad) === `1|7|${FID}`, frames.canonicalAad(aad));
ok('canonicalAad has exactly three fields', frames.canonicalAad({ seq: 120, fid: FID }).split('|').length === 3, frames.canonicalAad({ seq: 120, fid: FID }));
ok('canonicalAad matches 1|<seq>|<16 hex>', /^1\|\d+\|[0-9a-f]{16}$/.test(frames.canonicalAad({ seq: 42, fid: 'c0ffee1234567890' })));
fails('the AAD refuses a `type` field (it lives inside the sealed plaintext)', () => frames.canonicalAad({ seq: 7, fid: FID, type: 'mirror' }), frames.FrameFormatError);
fails('the AAD refuses a `to` field', () => frames.canonicalAad({ seq: 7, fid: FID, to: '*' }), frames.FrameFormatError);
fails('the AAD refuses `idx`/`last` (they describe a slice, and the bind would be ambiguous)', () => frames.canonicalAad({ seq: 7, fid: FID, idx: 0, last: true }), frames.FrameFormatError);
fails('the AAD refuses a fid that is not 16 lowercase hex', () => frames.canonicalAad({ seq: 7, fid: FID.toUpperCase() }), frames.FrameFormatError);
fails('seq below 1 is refused (connections start at 1)', () => frames.canonicalAad({ seq: 0, fid: FID }), frames.FrameFormatError);

// ---------------------------------------------------------------------------------------
// 4. seal → open: the AAD is the three-field string, and only that string opens the frame
// ---------------------------------------------------------------------------------------
console.log('-- frames: seal → open, and the AAD that the receiver can actually rebuild --');

const SALT = 0x1a2b3c4d;
const encKey = derived.encKey;
const sealed = frames.sealFrame({ encKey, aad, salt: SALT, plaintext });

ok('seal → open returns the identical plaintext', frames.openFrame({ encKey, aad, salt: SALT, sealed }) === plaintext);
ok('the GCM tag is appended (sealed = plaintext + 16)', sealed.length === Buffer.byteLength(plaintext, 'utf8') + 16, `${sealed.length} bytes`);
ok(
  'the nonce is be64(seq) || be32(salt)',
  hex(frames.frameNonce(7, SALT)) === '00000000000000071a2b3c4d',
  hex(frames.frameNonce(7, SALT)),
);
fails('a salt outside uint32 is refused', () => frames.frameNonce(7, -1), frames.FrameFormatError);

// Checked with a raw AEAD, not through openFrame: the AAD the sender used has to be the
// one the file says it is, or the round trip would agree with itself and with nothing else.
ok('the sealed bytes really are bound to `1|seq|fid` (raw AEAD open)', rawOpen(encKey, frames.frameNonce(7, SALT), `1|7|${FID}`, sealed) === plaintext);
fails(
  'the pre-fix 8-field AAD cannot open a frame sealed under the new contract',
  () => rawOpen(encKey, frames.frameNonce(7, SALT), `1|mirror|${FROM}|*|7|${FID}|0|true`, sealed),
  Error,
);
fails('a frame sealed with a slice-shaped AAD cannot be opened with `1|seq|fid`', () => {
  const sliceShapedAad = `1|7|${FID}|0|true`;
  const cipher = require('node:crypto').createCipheriv('aes-256-gcm', encKey, frames.frameNonce(7, SALT));
  cipher.setAAD(Buffer.from(sliceShapedAad, 'utf8'));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return frames.openFrame({ encKey, aad, salt: SALT, sealed: Buffer.concat([body, cipher.getAuthTag()]) });
}, frames.FrameAuthError);

fails('a changed `seq` in the AAD is AUTH', () => frames.openFrame({ encKey, aad: { seq: 8, fid: FID }, salt: SALT, sealed }), frames.FrameAuthError);
fails('a changed `fid` in the AAD is AUTH', () => frames.openFrame({ encKey, aad: { seq: 7, fid: 'ffffffffffffffff' }, salt: SALT, sealed }), frames.FrameAuthError);
fails('another salt (another nonce) is AUTH', () => frames.openFrame({ encKey, aad, salt: SALT + 1, sealed }), frames.FrameAuthError);

const flipped = Buffer.from(sealed);
flipped[0] ^= 0x01;
fails('a flipped ciphertext byte is AUTH', () => frames.openFrame({ encKey, aad, salt: SALT, sealed: flipped }), frames.FrameAuthError);
const flippedTag = Buffer.from(sealed);
flippedTag[flippedTag.length - 1] ^= 0x01;
fails('a flipped tag byte is AUTH', () => frames.openFrame({ encKey, aad, salt: SALT, sealed: flippedTag }), frames.FrameAuthError);

const wrongKey = Buffer.from(encKey);
wrongKey[0] ^= 0x01;
fails('a wrong encKey is AUTH', () => frames.openFrame({ encKey: wrongKey, aad, salt: SALT, sealed }), frames.FrameAuthError);
fails('a key of the wrong size is a FORMAT error at the caller', () => frames.sealFrame({ encKey: encKey.subarray(0, 16), aad, salt: SALT, plaintext }), frames.FrameFormatError);
fails('a sealed buffer shorter than its tag is FORMAT (truncated on the wire)', () => frames.openFrame({ encKey, aad, salt: SALT, sealed: sealed.subarray(0, 8) }), frames.FrameFormatError);

// The taxonomy itself: every class is a FrameError, and AUTH is not confused with the rest.
const authErr = fails('AUTH is reported as AUTH and not as SIZE or REPLAY', () => frames.openFrame({ encKey, aad: { seq: 8, fid: FID }, salt: SALT, sealed }), frames.FrameAuthError);
ok(
  'AUTH is a FrameError, and not a SIZE / REPLAY / SLICE error',
  !!authErr && authErr instanceof frames.FrameError && !(authErr instanceof frames.FrameSizeError) && !(authErr instanceof frames.FrameReplayError) && !(authErr instanceof frames.FrameSliceError),
  authErr && authErr.name,
);
ok('every error class carries its own name', ['FrameFormatError', 'FrameSizeError', 'FrameAuthError', 'FrameReplayError', 'FrameSliceError'].every((name) => typeof frames[name] === 'function' && new frames[name]('x').name === name));

// ---------------------------------------------------------------------------------------
// 5. the caps
// ---------------------------------------------------------------------------------------
console.log('-- frames: the size caps (refused whole, never truncated) --');

ok('FRAME_MAX_BYTES is pinned to 16 MiB', frames.FRAME_MAX_BYTES === 16777216, String(frames.FRAME_MAX_BYTES));
ok('SLICE_MAX_BASE64 is pinned to 48000 (a multiple of 4)', frames.SLICE_MAX_BASE64 === 48000 && frames.SLICE_MAX_BASE64 % 4 === 0, String(frames.SLICE_MAX_BASE64));
ok('PBKDF2_ITERATIONS is re-exported here, pinned to 600000', frames.PBKDF2_ITERATIONS === 600000 && frames.PBKDF2_ITERATIONS === rooms.PBKDF2_ITERATIONS, String(frames.PBKDF2_ITERATIONS));

fails(
  'an oversized frame is SIZE before any seal',
  () => frames.sealFrame({ encKey, aad, salt: SALT, plaintext: 'x'.repeat(frames.FRAME_MAX_BYTES + 1) }),
  frames.FrameSizeError,
);
fails(
  'a plaintext whose tag would push the sealed frame over the cap is SIZE too',
  () => frames.sealFrame({ encKey, aad, salt: SALT, plaintext: 'x'.repeat(frames.FRAME_MAX_BYTES) }),
  frames.FrameSizeError,
);
const largest = frames.sealFrame({ encKey, aad, salt: SALT, plaintext: 'x'.repeat(frames.FRAME_MAX_BYTES - 16) });
ok('the largest frame that fits still seals (exactly FRAME_MAX_BYTES)', largest.length === frames.FRAME_MAX_BYTES, `${largest.length} bytes`);
fails('an oversized sealed buffer is SIZE on open, before returning anything', () => frames.openFrame({ encKey, aad, salt: SALT, sealed: Buffer.concat([largest, Buffer.alloc(1)]) }), frames.FrameSizeError);

// ---------------------------------------------------------------------------------------
// 6. slices: the wire envelope, and reassembly
// ---------------------------------------------------------------------------------------
console.log('-- frames: the transport slice {v,seq,s,fid,idx,last,b} --');

ok('encodeSalt is 8 lowercase hex, big-endian uint32', frames.encodeSalt(SALT) === '1a2b3c4d' && frames.encodeSalt(0) === '00000000' && frames.encodeSalt(0xffffffff) === 'ffffffff', frames.encodeSalt(SALT));
ok('decodeSalt(encodeSalt(x)) === x at both ends of the range', [0, 1, SALT, 0x7fffffff, 0xffffffff].every((value) => frames.decodeSalt(frames.encodeSalt(value)) === value), '0 .. 0xffffffff');
ok(
  'decodeSalt is strict: uppercase, wrong length and non-hex are refused, never coerced',
  ['1A2B3C4D', '1a2b3c4', '1a2b3c4d0', 'zzzzzzzz', '', ' 1a2b3c4d'].every((bad) => throwsWith(() => frames.decodeSalt(bad), frames.FrameFormatError)) &&
    throwsWith(() => frames.decodeSalt(undefined), frames.FrameFormatError),
  'a sloppy `s` would build a different nonce and report a transport bug as tampering',
);
ok(
  'encodeSalt refuses anything that is not a uint32',
  [-1, 1.5, 0x100000000, NaN, undefined].every((bad) => throwsWith(() => frames.encodeSalt(bad), frames.FrameFormatError)),
);
ok('the wire salt is the nonce\'s last 4 bytes', frames.encodeSalt(SALT) === hex(frames.frameNonce(7, SALT)).slice(16), hex(frames.frameNonce(7, SALT)));

const small = frames.sliceSealed(sealed, aad, SALT);
ok('a small frame is one slice, idx 0, last true', small.length === 1 && small[0].idx === 0 && small[0].last === true && small[0].b === sealed.toString('base64'), `${small.length} slice(s)`);
ok('every slice repeats the frame\'s v, seq, s and fid', small.every((s) => s.v === 1 && s.seq === 7 && s.s === '1a2b3c4d' && s.fid === FID));
ok(
  'encodeSlice writes the seven keys in the contract order, compactly',
  frames.encodeSlice(small[0]) === `{"v":1,"seq":7,"s":"1a2b3c4d","fid":"${FID}","idx":0,"last":true,"b":"${sealed.toString('base64')}"}`,
  frames.encodeSlice(small[0]),
);
ok('decodeSlice round-trips a slice', JSON.stringify(frames.decodeSlice(frames.encodeSlice(small[0]))) === JSON.stringify(small[0]));
fails('decodeSlice refuses a slice without `s` (the pre-salt wire shape)', () => frames.decodeSlice(`{"v":1,"seq":7,"fid":"${FID}","idx":0,"last":true,"b":"AAAA"}`), frames.FrameFormatError);
fails('decodeSlice refuses a slice without `seq` (the pre-fix wire shape)', () => frames.decodeSlice(`{"v":1,"s":"1a2b3c4d","fid":"${FID}","idx":0,"last":true,"b":"AAAA"}`), frames.FrameFormatError);
fails('decodeSlice refuses a short `s`', () => frames.decodeSlice(`{"v":1,"seq":7,"s":"1a2b3c4","fid":"${FID}","idx":0,"last":true,"b":"AAAA"}`), frames.FrameFormatError);
fails('decodeSlice refuses a non-hex `s`', () => frames.decodeSlice(`{"v":1,"seq":7,"s":"1a2b3c4g","fid":"${FID}","idx":0,"last":true,"b":"AAAA"}`), frames.FrameFormatError);
fails('decodeSlice refuses an uppercase `s`', () => frames.decodeSlice(`{"v":1,"seq":7,"s":"1A2B3C4D","fid":"${FID}","idx":0,"last":true,"b":"AAAA"}`), frames.FrameFormatError);
fails('decodeSlice refuses an unknown key', () => frames.decodeSlice(`{"v":1,"seq":7,"s":"1a2b3c4d","fid":"${FID}","idx":0,"last":true,"b":"AAAA","extra":1}`), frames.FrameFormatError);
fails('decodeSlice refuses a version drift', () => frames.decodeSlice(`{"v":2,"seq":7,"s":"1a2b3c4d","fid":"${FID}","idx":0,"last":true,"b":"AAAA"}`), frames.FrameFormatError);
fails('decodeSlice refuses a slice longer than the cap', () => frames.decodeSlice(`{"v":1,"seq":7,"s":"1a2b3c4d","fid":"${FID}","idx":0,"last":true,"b":"${'A'.repeat(frames.SLICE_MAX_BASE64 + 4)}"}`), frames.FrameSizeError);
fails('sliceSealed refuses a fid that is not 16 lowercase hex', () => frames.sliceSealed(sealed, { seq: 7, fid: 'NOTAFRAMEID' }, SALT), frames.FrameSliceError);
fails('sliceSealed refuses a salt that is not a uint32', () => frames.sliceSealed(sealed, aad, -1), frames.FrameFormatError);
fails('sliceSealed refuses an oversized buffer', () => frames.sliceSealed(Buffer.alloc(frames.FRAME_MAX_BYTES + 1), aad, SALT), frames.FrameSizeError);

const bigPlaintext = frames.encodeFrame({ ...envelope, body: { rows: 'y'.repeat(200000) } });
const bigSealed = frames.sealFrame({ encKey, aad, salt: SALT, plaintext: bigPlaintext });
const bigSlices = frames.sealAndSlice({ encKey, aad, salt: SALT, plaintext: bigPlaintext });
ok('a large frame is cut into several slices', bigSlices.length > 1, `${bigSlices.length} slices`);
ok(
  'every slice is at most SLICE_MAX_BASE64 characters, in order, last only on the final one',
  bigSlices.every((s, i) => s.idx === i && s.b.length <= frames.SLICE_MAX_BASE64 && s.b.length > 0 && s.last === (i === bigSlices.length - 1)),
);
ok('sealAndSlice stamps one salt across every slice it produces', bigSlices.every((s) => s.s === '1a2b3c4d') && bigSlices.length > 1, `${bigSlices.length} slice(s), s=${bigSlices[0].s}`);
ok('sealAndSlice seals once and slices that one ciphertext', Buffer.concat(bigSlices.map((s) => Buffer.from(s.b, 'base64'))).equals(bigSealed));

const reassembler = new frames.FrameReassembler();
let assembled = null;
let pending = 0;
for (const slice of bigSlices) {
  const out = reassembler.push(frames.decodeSlice(frames.encodeSlice(slice)));
  if (out === null) {
    pending++;
  } else {
    assembled = out;
  }
}
ok('reassembly returns the byte-identical sealed buffer', !!assembled && assembled.equals(bigSealed), assembled ? `${assembled.length} bytes` : 'nothing');
ok('every slice but the final one returned null (still incomplete)', pending === bigSlices.length - 1, `${pending} of ${bigSlices.length}`);
// The receiving side's only legitimate salt source: the envelope field the sender stamped,
// which is what the nonce's last 4 bytes must equal.
ok('the reassembled frame opens using decodeSalt(slice.s) as the salt', frames.openFrame({ encKey, aad, salt: frames.decodeSalt(bigSlices[0].s), sealed: assembled }) === bigPlaintext);

// Interleaved frames: reassembly is keyed by fid, so two frames in flight do not collide.
const otherAad = { seq: 9, fid: 'ffffffffffffffff' };
const interleaved = new frames.FrameReassembler();
const firstA = interleaved.push(bigSlices[0]);
const firstB = interleaved.push({ ...bigSlices[0], seq: otherAad.seq, fid: otherAad.fid });
let restB = null;
for (const slice of bigSlices.slice(1)) {
  restB = interleaved.push({ ...slice, seq: otherAad.seq, fid: otherAad.fid }) || restB;
}
ok('two frames interleaved by fid both reassemble', firstA === null && firstB === null && !!restB && restB.equals(bigSealed));

fails('the first slice of a frame must be idx 0', () => new frames.FrameReassembler().push(bigSlices[1]), frames.FrameSliceError);
fails('an out-of-order slice (a hole) is refused', () => {
  const r = new frames.FrameReassembler();
  r.push(bigSlices[0]);
  return r.push(bigSlices[2]);
}, frames.FrameSliceError);
fails('a duplicate slice is refused', () => {
  const r = new frames.FrameReassembler();
  r.push(bigSlices[0]);
  return r.push(bigSlices[0]);
}, frames.FrameSliceError);
fails('a slice after the final one is refused', () => {
  const r = new frames.FrameReassembler();
  for (const slice of bigSlices) {
    r.push(slice);
  }
  return r.push(bigSlices[1]);
}, frames.FrameSliceError);
fails('a slice whose seq disagrees with the rest of its frame is refused', () => {
  const r = new frames.FrameReassembler();
  r.push(bigSlices[0]);
  return r.push({ ...bigSlices[1], seq: 8 });
}, frames.FrameSliceError);
fails('a slice whose s disagrees with the rest of its frame is refused', () => {
  const r = new frames.FrameReassembler();
  r.push(bigSlices[0]);
  return r.push({ ...bigSlices[1], s: 'ffffffff' });
}, frames.FrameSliceError);
fails('a slice with an unreadable s is refused before any buffering', () => new frames.FrameReassembler().push({ ...bigSlices[0], s: '1a2b3c4' }), frames.FrameSliceError);
fails('a slice whose v disagrees with the contract is refused', () => new frames.FrameReassembler().push({ ...bigSlices[0], v: 2 }), frames.FrameSliceError);
fails('a slice whose b is not whole base64 is refused', () => new frames.FrameReassembler().push({ ...bigSlices[0], b: 'AAAA=' }), frames.FrameSliceError);
fails('a slice longer than SLICE_MAX_BASE64 is refused as SIZE', () => new frames.FrameReassembler().push({ ...bigSlices[0], b: 'A'.repeat(48004) }), frames.FrameSizeError);
fails('a slice with a malformed fid is refused', () => new frames.FrameReassembler().push({ ...bigSlices[0], fid: '0123456789ABCDEF' }), frames.FrameSliceError);

// Over the cap: the assembly is abandoned as a whole. 467 slices of 36 kB decode past 16 MiB.
fails(
  'a reassembly that would cross FRAME_MAX_BYTES is SIZE',
  () => {
    const r = new frames.FrameReassembler();
    const chunk = 'A'.repeat(frames.SLICE_MAX_BASE64);
    const perSlice = (frames.SLICE_MAX_BASE64 / 4) * 3;
    let out = null;
    for (let i = 0; i < Math.ceil(frames.FRAME_MAX_BYTES / perSlice) + 1; i++) {
      out = r.push({ v: 1, seq: 7, s: '1a2b3c4d', fid: FID, idx: i, last: false, b: chunk });
    }
    return out;
  },
  frames.FrameSizeError,
);
fails(
  'a peer that opens frames and never finishes them is bounded',
  () => {
    const r = new frames.FrameReassembler();
    for (let i = 0; i < frames.MAX_ASSEMBLIES + 1; i++) {
      r.push({ v: 1, seq: 7, s: '1a2b3c4d', fid: i.toString(16).padStart(16, '0'), idx: 0, last: false, b: 'AAAA' });
    }
  },
  frames.FrameSizeError,
);
ok('reset() forgets the half-assembled frames', (() => {
  const r = new frames.FrameReassembler();
  r.push(bigSlices[0]);
  r.reset();
  return r.push(bigSlices[0]) === null;
})());

// ---------------------------------------------------------------------------------------
// 7. the replay window
// ---------------------------------------------------------------------------------------
console.log('-- frames: the 64-wide replay window --');

ok('the window is 64 wide by default', frames.REPLAY_WINDOW_WIDTH === 64, String(frames.REPLAY_WINDOW_WIDTH));
{
  const window = new frames.ReplayWindow();
  ok('a fresh window starts at floor 0 and accepts seq 1', window.floor() === 0 && (window.accept(1), window.highestSeq === 1), `floor ${window.floor()}`);
  fails('a duplicate seq is REPLAY', () => window.accept(1), frames.FrameReplayError);
  fails('seq 0 is not a sequence number (FORMAT, not replay)', () => window.accept(0), frames.FrameFormatError);
  fails('a non-integer seq is FORMAT', () => window.accept(1.5), frames.FrameFormatError);
}
{
  const window = new frames.ReplayWindow();
  for (let seq = 1; seq <= 100; seq++) {
    window.accept(seq);
  }
  ok('after 1..100 the floor is 36 and the highest is 100', window.floor() === 36 && window.highestSeq === 100, `floor ${window.floor()}, highest ${window.highestSeq}`);
  fails('exactly at the floor is REPLAY', () => window.accept(36), frames.FrameReplayError);
  fails('one below the floor is REPLAY', () => window.accept(35), frames.FrameReplayError);
  fails('a duplicate inside the window is REPLAY', () => window.accept(100), frames.FrameReplayError);
  window.accept(101);
  ok('a newer seq slides the window (floor 37, highest 101)', window.floor() === 37 && window.highestSeq === 101, `floor ${window.floor()}, highest ${window.highestSeq}`);
  fails('the seq that just left the window is REPLAY', () => window.accept(37), frames.FrameReplayError);
}
{
  // Frames can overtake each other on a relay, so the window may not be a high-water mark.
  const window = new frames.ReplayWindow();
  window.accept(1);
  window.accept(3);
  ok('a reordered seq still inside the window is accepted', (window.accept(2), true), 'seq 2, after 1 and 3');
  ok('the window is not a high-water mark (floor 0, highest 3)', window.floor() === 0 && window.highestSeq === 3, `floor ${window.floor()}, highest ${window.highestSeq}`);
}
{
  const window = new frames.ReplayWindow();
  window.accept(1000);
  ok('a fresh window may start at any seq (a reconnected sender does not reset it)', window.floor() === 936, `floor ${window.floor()}`);
  fails('a seq from before the connection jump is REPLAY', () => window.accept(5), frames.FrameReplayError);
}
fails('a window width below 1 is refused', () => new frames.ReplayWindow(0), frames.FrameFormatError);

// The order the transport owes: the window runs before openFrame, or a replayed frame
// authenticates perfectly (same nonce, same bytes, same tag) and is decrypted twice.
{
  const window = new frames.ReplayWindow();
  window.accept(7);
  ok('a replayed frame would authenticate — which is why accept() comes first', frames.openFrame({ encKey, aad, salt: SALT, sealed }) === plaintext);
  fails('the window is what refuses it', () => window.accept(7), frames.FrameReplayError);
}

// ---------------------------------------------------------------------------------------
// 8. allowlist: the two deny-by-default tables
// ---------------------------------------------------------------------------------------
console.log('-- allowlist: deny by default, in both directions --');

const CONTROL = ['userMessage', 'forkTurn', 'stop', 'continueTurn', 'rolloverTurn', 'checkout', 'killAgent', 'killBackground', 'deleteBranch', 'loadAgentItems', 'setModel', 'setThinkingEffort'];
ok('every seeded control type is accepted from a peer', CONTROL.every((type) => allowlist.mayAcceptFromPeer(type)) && allowlist.ACCEPT_FROM_PEER.size === CONTROL.length, `${allowlist.ACCEPT_FROM_PEER.size} type(s)`);
for (const type of ['perfDiag', 'layoutDiagnostic', 'openExternal', 'pickImage', 'copyNodeId', 'setNodeSize']) {
  ok(`a peer may not submit "${type}"`, !allowlist.mayAcceptFromPeer(type));
}
ok('a peer may not submit the local settings page or the boot handshake', !allowlist.mayAcceptFromPeer('openModelTree') && !allowlist.mayAcceptFromPeer('ready'));
ok('a peer may not submit the destructive "clear"', !allowlist.mayAcceptFromPeer('clear'));
ok('an unknown type is refused in both directions', !allowlist.mayAcceptFromPeer('spinneyFutureThing') && !allowlist.mayMirrorToPeer('spinneyFutureThing'));
ok('an empty / non-string type is refused', !allowlist.mayAcceptFromPeer('') && !allowlist.mayMirrorToPeer(undefined) && !allowlist.mayAcceptFromPeer('delta') && !allowlist.mayMirrorToPeer('stop'));

ok('every type in MIRROR_TO_PEER may be mirrored', [...allowlist.MIRROR_TO_PEER].every((type) => allowlist.mayMirrorToPeer(type)), `${allowlist.MIRROR_TO_PEER.size} type(s)`);
ok(
  'the session, the stream and the chrome are on the mirror list',
  ['state', 'tree', 'path', 'nodeUpdate', 'agentItems', 'reset', 'delta', 'thinkingDelta', 'toolCallDelta', 'toolStart', 'toolEnd', 'usage', 'done', 'interrupted', 'error', 'agentStart', 'agentDone', 'user', 'notice', 'harnessNote', 'backgroundNotice', 'context', 'sessionStats', 'status', 'backgrounds'].every((type) => allowlist.mayMirrorToPeer(type)),
);
ok(
  '`config` and `balance` are mirrored whole (the model lists and the owner\'s credit line are session surface)',
  allowlist.mayMirrorToPeer('config') && allowlist.mayMirrorToPeer('balance'),
);
for (const type of ['probe', 'nudge', 'imagePicked', 'composerClear', 'panTo', 'background']) {
  ok(`host→webview "${type}" is never mirrored`, !allowlist.mayMirrorToPeer(type) && allowlist.MIRROR_REFUSED.has(type));
}
ok(
  'every refused type carries its reason',
  [...allowlist.MIRROR_REFUSED.values()].every((reason) => typeof reason === 'string' && reason.length > 20),
  `${allowlist.MIRROR_REFUSED.size} refused`,
);
ok('no type is both mirrored and refused', [...allowlist.MIRROR_REFUSED.keys()].every((type) => !allowlist.MIRROR_TO_PEER.has(type)));
ok('the two tables are disjoint (no type may both be mirrored and submitted)', CONTROL.every((type) => !allowlist.MIRROR_TO_PEER.has(type)) && [...allowlist.MIRROR_TO_PEER].every((type) => !allowlist.ACCEPT_FROM_PEER.has(type)));
ok(
  'nothing is left undecided, and the UNRESOLVED slot stays in place for the next type',
  Array.isArray(allowlist.UNRESOLVED_MIRROR_TYPES) &&
    allowlist.UNRESOLVED_MIRROR_TYPES.length === 0 &&
    allowlist.UNRESOLVED_MIRROR_TYPES.every((row) => !allowlist.MIRROR_TO_PEER.has(row.type) && !allowlist.MIRROR_REFUSED.has(row.type)),
  `${allowlist.UNRESOLVED_MIRROR_TYPES.length} undecided`,
);

// ---------------------------------------------------------------------------------------
// 9. remote/vectors/vectors.json — the cross-language vectors
// ---------------------------------------------------------------------------------------
const VECTORS = path.join(root, 'remote', 'vectors', 'vectors.json');
const vectorTally = { checked: 0, stale: 0 };

/** One PBKDF2 per distinct token: the derivation is the expensive half of the vectors. */
const masters = new Map();
function masterOf(token) {
  if (!masters.has(token)) {
    masters.set(token, rooms.deriveMaster(token));
  }
  return masters.get(token);
}

/**
 * One `derivations[]` entry: the schedule is the part of the contract the AAD fix did not
 * touch, so these entries are checked strictly whatever shape the rest of the file has.
 */
function checkDerivationEntry(entry, label) {
  const token = pickString(entry, ['token', 'tokenUtf8', 'password', 'secret']);
  if (token === null) {
    ok(`${label}: names its token`, false, `no token / tokenUtf8 field (keys: ${keysOf(entry)})`);
    return;
  }
  const master = masterOf(token);
  const keys = rooms.keysFromMaster(master);
  ok(`${label}: masterHex`, sameHex(entry.masterHex, master), show(entry.masterHex));
  ok(`${label}: roomIdBHex`, sameHex(entry.roomIdBHex, rooms.roomIdBytes(master)), show(entry.roomIdBHex));
  ok(`${label}: roomId`, entry.roomId === rooms.roomIdOf(master), `${show(entry.roomId)} vs ${rooms.roomIdOf(master)}`);
  ok(`${label}: encKeyHex`, sameHex(entry.encKeyHex, keys.encKey), show(entry.encKeyHex));
  ok(`${label}: macKeyHex`, sameHex(entry.macKeyHex, keys.macKey), show(entry.macKeyHex));
  vectorTally.checked++;
}

/**
 * One `seals[]` entry, in the post-fix shape: a three-field `aad` (`v|seq|fid`), a
 * `plaintextUtf8` carrying the six-key logical frame, and the sealed bytes.
 *
 * Returns false when the entry is still the pre-fix shape — the caller reports that as a
 * skipped file, not as a failure, because the regeneration is not this module's job.
 */
function checkSealEntry(entry, label) {
  const aadText = pickString(entry, ['aad', 'aadUtf8', 'aadText']);
  const token = pickString(entry, ['token', 'tokenUtf8', 'password']);
  const plaintextUtf8 = pickString(entry, ['plaintextUtf8', 'plaintext', 'logicalFrameUtf8']);
  const sealedHex = pickString(entry, ['sealedHex', 'sealed', 'ciphertextHex']);
  if (aadText === null || token === null || plaintextUtf8 === null || sealedHex === null) {
    ok(`${label}: names its aad / token / plaintextUtf8 / sealedHex`, false, `keys: ${keysOf(entry)}`);
    return true;
  }
  if (String(aadText).split('|').length !== 3) {
    return false;
  }
  const facts = aadFromText(aadText);
  if (facts === null) {
    ok(`${label}: the AAD is the post-fix canonical v|seq|fid`, false, aadText);
    return true;
  }
  ok(`${label}: the AAD is v|seq|fid`, frames.canonicalAad(facts) === aadText, aadText);
  ok(`${label}: the AAD names the frame's seq/fid and nothing else`, Object.keys(facts).join(',') === 'seq,fid');

  const entrySeq = pickNumber(entry, ['seq', 'sequence']);
  const entryFid = pickString(entry, ['fid', 'frameId']);
  ok(`${label}: the entry's seq agrees with its AAD`, entrySeq === null || entrySeq === facts.seq, `${entrySeq} vs ${facts.seq}`);
  ok(`${label}: the entry's fid agrees with its AAD`, entryFid === null || entryFid === facts.fid, `${entryFid} vs ${facts.fid}`);

  const salt = pickSalt(entry);
  const nonceHex = pickString(entry, ['nonceHex', 'nonce']);
  const nonce = nonceHex === null ? null : attempt(() => Buffer.from(padHex(nonceHex), 'hex'));
  ok(`${label}: carries its connection salt (salt, connSaltHex, or nonceHex)`, salt !== null, salt === null ? `keys: ${keysOf(entry)}` : `salt ${salt}`);
  if (salt === null) {
    return true;
  }
  if (nonce) {
    ok(
      `${label}: nonceHex is be64(seq) || be32(salt)`,
      !nonce.err && nonce.value.length === 12 && hex(nonce.value) === hex(frames.frameNonce(facts.seq, salt)),
      nonce.err ? nonce.err.message : hex(nonce.value),
    );
  } else {
    ok(`${label}: carries a nonceHex (the receiver rebuilds the nonce from seq + salt)`, false);
  }

  const key = rooms.keysFromMaster(masterOf(token)).encKey;
  const sealed = attempt(() => Buffer.from(padHex(sealedHex), 'hex'));
  const opened = attempt(() => frames.openFrame({ encKey: key, aad: facts, salt, sealed: sealed.value }));
  ok(
    `${label}: opens back to plaintextUtf8`,
    !opened.err && opened.value === plaintextUtf8,
    opened.err ? `${opened.err.name}: ${opened.err.message}` : `${String(opened.value).length} chars${opened.value === plaintextUtf8 ? '' : ' (differs)'}`,
  );
  // The same key, nonce and AAD must also *produce* these bytes: a sealer that agreed with
  // the file only on the way in would still be a second, incompatible protocol.
  const resealed = attempt(() => frames.sealFrame({ encKey: key, aad: facts, salt, plaintext: plaintextUtf8 }));
  ok(
    `${label}: sealFrame reproduces sealedHex byte for byte`,
    !resealed.err && hex(resealed.value) === padHex(sealedHex).toLowerCase(),
    resealed.err ? `${resealed.err.name}: ${resealed.err.message}` : show(hex(resealed.value)),
  );
  // The plaintext is the post-fix logical frame: six keys, `to` among them.
  const decoded = attempt(() => frames.decodeFrame(plaintextUtf8));
  ok(
    `${label}: the plaintext is the six-key logical frame (v,type,id,from,to,body)`,
    !decoded.err && Object.keys(JSON.parse(plaintextUtf8)).join(',') === 'v,type,id,from,to,body',
    decoded.err ? `${decoded.err.name}` : Object.keys(JSON.parse(plaintextUtf8)).join(','),
  );
  const peer = pickString(entry, ['peer', 'from']);
  ok(`${label}: the sealed frame's \`from\` is the entry's peer`, !decoded.err && peer === null ? true : !!decoded.value && decoded.value.from === peer, `${peer} vs ${decoded.value && decoded.value.from}`);
  // The transport envelope of the logical frame, as `remote/vectors/README.md` defines it:
  // the header `{v,seq,s,fid,idx,last}` (a part in `slices[].parts` is that object plus its
  // own `b`), key order fixed. Every field it names must be the one the AAD, the salt and
  // the nonce already imply — `s` included, since it is half the nonce.
  const envelopeHeader = pickObject(entry, ['envelope', 'env', 'slice', 'header']);
  const sealedBytes = Buffer.from(padHex(sealedHex), 'hex');
  const sliced = attempt(() => frames.sliceSealed(sealedBytes, { seq: facts.seq, fid: facts.fid }, salt));
  if (envelopeHeader === null) {
    skip(`${label}: no envelope header to check`, 'the entry pins the seal only');
  } else if (sliced.err) {
    ok(`${label}: the frame could be sliced for an envelope comparison`, false, sliced.err.name);
  } else {
    const keys = Object.keys(envelopeHeader);
    ok(
      `${label}: the envelope header is v,seq,s,fid,idx,last (a part adds its own b)`,
      keys.join(',') === 'v,seq,s,fid,idx,last' || keys.join(',') === 'v,seq,s,fid,idx,last,b',
      keys.join(','),
    );
    ok(
      `${label}: the envelope's v/seq/s/fid are the frame's own`,
      envelopeHeader.v === 1 && envelopeHeader.seq === facts.seq && envelopeHeader.fid === facts.fid && envelopeHeader.s === frames.encodeSalt(salt),
      `v ${envelopeHeader.v}, seq ${envelopeHeader.seq}/${facts.seq}, s ${envelopeHeader.s}/${frames.encodeSalt(salt)}, fid ${envelopeHeader.fid}/${facts.fid}`,
    );
    ok(
      `${label}: the header describes the logical frame as one unit (idx 0, last true)`,
      envelopeHeader.idx === 0 && envelopeHeader.last === true,
      `idx ${envelopeHeader.idx}, last ${envelopeHeader.last} (slices: ${sliced.value.length})`,
    );
    // When the entry does carry the payload, the header *is* the frame's single slice, and
    // it has to survive the wire codec like any other.
    if (typeof envelopeHeader.b === 'string') {
      const back = attempt(() => frames.decodeSlice(frames.encodeSlice(frames.decodeSlice(JSON.stringify(envelopeHeader)))));
      ok(`${label}: the envelope with a payload round-trips as a slice`, !back.err && back.value.b === envelopeHeader.b, back.err ? back.err.name : `${back.value.b.length} chars`);
    }
  }
  vectorTally.checked++;
  return true;
}

/**
 * One `slices[]` entry: the parts must carry `v`/`seq`/`fid` (post-fix) and reassemble to
 * `sealedHex`, byte for byte. Returns false for a pre-fix entry (no `seq` anywhere), which
 * the caller reports as skipped.
 */
function checkSlicesEntry(entry, label) {
  const sealedHex = pickString(entry, ['sealedHex', 'sealed', 'sealedFrameHex']);
  const parts = arrayOf(entry, ['slices', 'parts', 'chunks', 'pieces']);
  if (!sealedHex || !parts) {
    ok(`${label}: names its sealedHex and its slices[]`, false, `keys: ${keysOf(entry)}`);
    return true;
  }
  const entryFid = pickString(entry, ['fid', 'frameId']);
  const entrySeq = pickNumber(entry, ['seq', 'sequence']);
  const entrySalt = pickString(entry, ['s', 'connSaltHex', 'saltHex']);
  if (entrySeq === null && !parts.some((part) => part && typeof part === 'object' && 'seq' in part)) {
    return false;
  }
  if (entrySalt === null && !parts.some((part) => part && typeof part === 'object' && 's' in part)) {
    // The pre-salt slice shape (the salt was implicit, and each implementation guessed):
    // reported as skipped rather than failed, because the regeneration is not this file's job.
    return false;
  }
  const built = attempt(() =>
    parts.map((part, idx) => {
      const last = idx === parts.length - 1;
      const fields = part && typeof part === 'object' ? part : {};
      return {
        v: pickNumber(fields, ['v']) ?? pickNumber(entry, ['v']) ?? 1,
        seq: pickNumber(fields, ['seq', 'sequence']) ?? entrySeq,
        s: pickString(fields, ['s', 'connSaltHex', 'saltHex']) ?? entrySalt,
        fid: pickString(fields, ['fid', 'frameId']) || entryFid || FID,
        idx: pickNumber(fields, ['idx', 'index']) ?? idx,
        last: pickBool(fields, ['last', 'final']) ?? last,
        b: typeof part === 'string' ? part : pickString(fields, ['b', 'data', 'b64', 'base64', 'body']) ?? '',
      };
    }),
  );
  if (built.err || !built.value.every((slice) => frames.isFrameId(slice.fid) && throwsWith(() => frames.decodeSalt(slice.s), frames.FrameFormatError) === false)) {
    ok(`${label}: every part names a 16-character lowercase hex fid and an 8-hex salt`, false, entryFid ? show(entryFid) : `keys: ${keysOf(entry)}`);
    return true;
  }
  ok(
    `${label}: every slice repeats the frame's v, seq, s and fid`,
    built.value.every((slice) => slice.v === built.value[0].v && slice.seq === built.value[0].seq && slice.s === built.value[0].s && slice.fid === built.value[0].fid),
    `v ${built.value[0].v}, seq ${built.value[0].seq}, s ${built.value[0].s}`,
  );
  ok(
    `${label}: last is on the final slice only`,
    built.value.every((slice, idx) => slice.last === (idx === built.value.length - 1)),
  );
  const roundTripped = built.value.every((slice) => {
    const text = attempt(() => frames.encodeSlice(slice));
    return !text.err && JSON.stringify(frames.decodeSlice(text.value)) === JSON.stringify(slice);
  });
  ok(`${label}: every part survives encodeSlice → decodeSlice (the wire shape)`, roundTripped);
  const run = attempt(() => {
    const reassembler = new frames.FrameReassembler();
    let out = null;
    for (const slice of built.value) {
      out = reassembler.push(slice) || out;
    }
    return out;
  });
  ok(
    `${label}: ${parts.length} slice(s) reassemble to sealedHex`,
    !run.err && !!run.value && run.value.equals(Buffer.from(padHex(sealedHex), 'hex')),
    run.err ? `${run.err.name}: ${run.err.message}` : run.value ? `${run.value.length} bytes` : 'incomplete',
  );
  vectorTally.checked++;
  return true;
}

/** The `aad` string parsed into the facts it names, or null when it is not `1|seq|fid`. */
function aadFromText(text) {
  const parts = String(text).split('|');
  if (parts.length !== 3 || parts[0] !== '1') {
    return null;
  }
  const attemptFacts = attempt(() => frames.canonicalAad({ seq: Number(parts[1]), fid: parts[2] }));
  if (attemptFacts.err) {
    return null;
  }
  return { seq: Number(parts[1]), fid: parts[2] };
}

/** The connection salt, however an entry spells it. */
function pickSalt(entry) {
  const direct = pickNumber(entry, ['salt', 'nonceSalt', 'saltUint32']);
  if (direct !== null) {
    return direct;
  }
  const saltHex = pickString(entry, ['connSaltHex', 'saltHex', 'nonceSaltHex']);
  if (saltHex !== null && padHex(saltHex).length === 8) {
    return Number.parseInt(padHex(saltHex), 16);
  }
  const nonceHex = pickString(entry, ['nonceHex', 'nonce']);
  if (nonceHex !== null) {
    const bytes = attempt(() => Buffer.from(padHex(nonceHex), 'hex'));
    if (!bytes.err && bytes.value.length === 12) {
      return bytes.value.readUInt32BE(8);
    }
  }
  return null;
}

if (!fs.existsSync(VECTORS)) {
  console.log('-- remote/vectors/vectors.json: not written yet — the cross-language vectors are NOT checked --');
  console.log('   (expected while M0 is in flight; re-run this check once it lands)');
} else {
  console.log('-- remote/vectors/vectors.json: the cross-language crypto vectors --');
  const loaded = attempt(() => JSON.parse(fs.readFileSync(VECTORS, 'utf8')));
  if (loaded.err) {
    ok('vectors.json parses', false, loaded.err.message);
  } else {
    const vectors = loaded.value;
    const derivations = arrayOf(vectors, ['derivations']) || [];
    ok('the file carries a derivations[] array', derivations.length > 0, `${derivations.length} entry(ies)`);
    derivations.forEach((entry, i) => checkDerivationEntry(entry, `derivations[${i}]`));

    const seals = arrayOf(vectors, ['seals', 'frames', 'sealedFrames']);
    if (!seals) {
      skip('no seals[] array — the sealed-frame vectors were not checked');
    } else {
      const fresh = seals.filter((entry, i) => checkSealEntry(entry, `seals[${i}]`));
      if (fresh.length === 0) {
        skip(
          'seals[] still carries the pre-fix shape — 8-field AAD, no `to` in plaintextUtf8',
          `${seals.length} entry(ies) skipped; regenerate remote/vectors/vectors.json`,
        );
      }
      // `seq` restarts at 1 on every connection, so a fresh `s` per connection is the whole
      // replay defence: two frames that share a token and a seq must not share a salt (or a
      // nonce). This is checked across entries, which is where the pair actually lives.
      const byConnection = new Map();
      seals.forEach((entry, i) => {
        const token = pickString(entry, ['token', 'tokenUtf8', 'password']);
        const seq = pickNumber(entry, ['seq', 'sequence']);
        const nonceHex = pickString(entry, ['nonceHex', 'nonce']);
        if (token === null || seq === null || nonceHex === null) {
          return;
        }
        const group = `${token}|${seq}`;
        if (!byConnection.has(group)) {
          byConnection.set(group, []);
        }
        byConnection.get(group).push({ label: `seals[${i}]`, nonceHex: padHex(nonceHex), s: pickSalt(entry) });
      });
      for (const [group, framesOnGroup] of byConnection) {
        if (framesOnGroup.length < 2) {
          continue;
        }
        ok(
          `two frames that share a token and a seq (${group.split('|')[1]}) get different salts and nonces`,
          new Set(framesOnGroup.map((f) => f.s)).size === framesOnGroup.length && new Set(framesOnGroup.map((f) => f.nonceHex)).size === framesOnGroup.length,
          framesOnGroup.map((f) => `${f.label}: s ${f.s}`).join(' | '),
        );
      }
    }

    const sliceSets = arrayOf(vectors, ['slices', 'sliceSets', 'chunked', 'sliceVectors']);
    if (!sliceSets) {
      skip('no slices[] array — the slicing vectors were not checked');
    } else {
      const fresh = sliceSets.filter((entry, i) => checkSlicesEntry(entry, `slices[${i}]`));
      if (fresh.length === 0) {
        skip(
          'slices[] still carries the pre-salt shape — no `s` on the parts',
          `${sliceSets.length} entry(ies) skipped; regenerate remote/vectors/vectors.json`,
        );
      }
    }
  }
}

// The new-shape reader above must be exercised even while the real file is stale: these
// three synthetic entries are built from this run's own fixtures and run through the very
// same functions, so a bug in `aadFromText` / `checkSealEntry` / `checkSlicesEntry` cannot
// hide behind a skipped file.
console.log('-- vectors reader self-test: the post-fix shape it expects from the regenerated file --');
checkDerivationEntry(
  { token: TOKEN, masterHex: hex(rooms.deriveMaster(TOKEN)), roomIdBHex: hex(rooms.roomIdBytes(rooms.deriveMaster(TOKEN))), roomId: derived.roomId, encKeyHex: hex(derived.encKey), macKeyHex: hex(derived.macKey) },
  'self-test derivations[0]',
);
const selfSeal = {
  token: TOKEN,
  peer: FROM,
  seq: 7,
  connSaltHex: SALT.toString(16).padStart(8, '0'),
  aad: frames.canonicalAad(aad),
  plaintextUtf8: plaintext,
  nonceHex: hex(frames.frameNonce(7, SALT)),
  sealedHex: hex(sealed),
  envelope: { v: 1, seq: 7, s: frames.encodeSalt(SALT), fid: FID, idx: 0, last: true },
};
ok('the self-test seal entry is checked by the strict reader (not skipped)', checkSealEntry(selfSeal, 'self-test seals[0]'));
const selfSlices = { fid: FID, seq: 7, sealedHex: hex(bigSealed), parts: bigSlices.map((slice) => ({ v: slice.v, idx: slice.idx, last: slice.last, b: slice.b })) };
ok('the self-test slice entry is checked by the strict reader (not skipped)', checkSlicesEntry({ ...selfSlices, s: frames.encodeSalt(SALT) }, 'self-test slices[0]'));
// A stale-shape entry must be *detected*, or the skip above would be indistinguishable
// from a reader that never looks.
ok('a pre-fix seal entry is detected as stale, not silently accepted', checkSealEntry({ ...selfSeal, aad: `1|mirror|${FROM}|*|7|${FID}|0|true` }, 'self-test seals[stale]') === false);
ok('a pre-salt slices entry is detected as stale, not silently accepted', checkSlicesEntry(selfSlices, 'self-test slices[stale]') === false);
ok('a pre-seq slices entry is detected as stale, not silently accepted', checkSlicesEntry({ sealedHex: hex(bigSealed), parts: bigSlices.map((slice) => ({ idx: slice.idx, last: slice.last, b: slice.b })) }, 'self-test slices[stale-seq]') === false);

// ------------------------------------------------ vectors helpers ----

/** A hex string from the file, compared case- and prefix-insensitively. */
function sameHex(value, expected) {
  const normalised = typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : null;
  return normalised !== null && normalised === hex(expected);
}

function padHex(value) {
  const text = String(value).replace(/^0x/i, '');
  return text.length % 2 === 1 ? `0${text}` : text;
}

function show(value) {
  return typeof value === 'string' ? value.slice(0, 40) : String(value);
}

function keysOf(value) {
  return value && typeof value === 'object' ? Object.keys(value).join(', ') : String(value);
}

function pickString(value, names) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const name of names) {
    if (typeof value[name] === 'string') {
      return value[name];
    }
  }
  return null;
}

function pickNumber(value, names) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const name of names) {
    if (typeof value[name] === 'number' && Number.isFinite(value[name])) {
      return value[name];
    }
  }
  return null;
}

function pickBool(value, names) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const name of names) {
    if (typeof value[name] === 'boolean') {
      return value[name];
    }
  }
  return null;
}

function arrayOf(value, names) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const name of names) {
    if (Array.isArray(value[name])) {
      return value[name];
    }
  }
  return null;
}

function pickObject(value, names) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const name of names) {
    const candidate = value[name];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// The verdict. Printed after every check, so a PASS always means "all of them ran".
// ---------------------------------------------------------------------------------------
if (problems.length) {
  console.error(`\ncheck-remote: FAIL — ${problems.length} of ${checks} check(s) failed:`);
  for (const label of problems) {
    console.error(`  - ${label}`);
  }
  process.exit(1);
}

console.log(`check-remote: OK — ${checks} checks${skipped ? `, ${skipped} skipped` : ''}; room id ${derived.roomId} for the fixed test token.`);
console.log(`  mirror list: ${allowlist.MIRROR_TO_PEER.size} type(s); control list: ${allowlist.ACCEPT_FROM_PEER.size} type(s); refused: ${allowlist.MIRROR_REFUSED.size}.`);
if (allowlist.UNRESOLVED_MIRROR_TYPES.length === 0) {
  console.log('  [UNRESOLVED] none — every host→webview type of the shipped protocol is classified.');
} else {
  for (const row of allowlist.UNRESOLVED_MIRROR_TYPES) {
    console.log(`  [UNRESOLVED] host→webview "${row.type}": ${row.question}`);
  }
}
if (!fs.existsSync(VECTORS)) {
  console.log('  [UNRESOLVED] remote/vectors/vectors.json is not written yet: re-run this check after M0 lands it.');
}
