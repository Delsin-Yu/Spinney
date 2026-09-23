/**
 * Remote-control crypto vectors.
 *
 * Computes remote/vectors/vectors.json: the shared artifact the TypeScript host,
 * the relay's C# selftest and the Kotlin Android app are checked against. The
 * authority for the bytes is remote/PROTOCOL.md.
 *
 * Deterministic by construction -- fixed tokens, fixed connection salts, fixed
 * plaintexts -- so running it twice must produce byte-identical output.
 *
 * Node built-ins only, plain ESM, no build step:
 *   node tools/gen-remote-vectors.mjs
 */
import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'remote', 'vectors', 'vectors.json');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const KDF_ITERATIONS = 600000;
const KDF_SALT = 'spinney-room-v1';
const HKDF_SALT = 'spinney-hkdf-v1';
const TAG_LENGTH = 16;
const NONCE_LENGTH = 12;
const SLICE_B64_MAX = 48000; // hard limit on one slice's base64 length
const SLICE_BYTES = 30000; // reference chunking: 30000 raw bytes -> exactly 40000 base64 chars
const SEALED_MAX = 16777216; // reassembled sealed frame hard cap

// Token 1 is the realistic case (64 lowercase hex chars, alphanumeric).
// Token 2 is non-ASCII and deliberately mixes 2-, 3- and 4-byte UTF-8 sequences:
// U+00E9 (e acute), U+043A..U+0447 (Cyrillic), U+5BC6/U+7801 (CJK), U+1D11E (a
// supplementary-plane character, i.e. a UTF-16 surrogate pair in Java/Kotlin).
// Token 3 is short, to pin that a weak token is still deterministic.
// Token 2 is spelled with \u escapes so this source file stays ASCII; the vector
// file carries the literal characters, and tokenUtf8Hex repeats their bytes.
const TOKENS = [
  '9f3a1c02b7d4e6850a1f3c9d2e5b8a47c6d0e9f1a2b3c4d5e6f708192a3b4c5d',
  'caf\u00e9-\u043a\u043b\u044e\u0447-\u5bc6\u7801-\u{1d11e}',
  'abc',
];

// One mirrored `agentItems` message, ~145 KB, to force several transport slices.
const MIRRORED_ITEMS = Array.from({ length: 1150 }, (_, i) => {
  const n = String(i).padStart(4, '0');
  return { kind: 'text', text: '[' + n + '] remote mirror line ' + '0123456789abcdef'.repeat(4) + ' ' + n };
});

// Every frame is fixed: the token, the peer ids, the sequence, the correlation id,
// the framing id and the connection salt are literals, never random. Types are the
// ones remote/PROTOCOL.md section 5 defines.
//
// `id` and `fid` are conceptually different and the vectors show both cases:
// frames[0] makes them equal (a sender choosing to), frames[1] and frames[2] keep
// them apart -- `id` is the request/response correlation id, `fid` is one frame's
// transport framing id and lives only as long as that frame's slices.
const FRAMES = [
  {
    token: TOKENS[0],
    type: 'ping',
    from: '9f3a1c02',
    to: '*',
    seq: 1,
    id: '0011223344556677',
    fid: '0011223344556677',
    connSaltHex: '1a2b3c4d',
    body: {},
  },
  {
    token: TOKENS[1],
    type: 'input',
    from: '9f3a1c02',
    to: '7b2f9d10',
    seq: 7,
    id: '0f1e2d3c4b5a6978',
    fid: 'a1b2c3d4e5f60718',
    connSaltHex: '5a6b7c8d',
    body: {
      sessionId: '0a1b2c3d4e5f6071',
      message: {
        type: 'userMessage',
        nodeId: 'c3a7f1d0-2f4b-4e8a-9b6c-0d1e2f3a4b5c',
        text: 'run the test suite',
      },
    },
  },
  {
    token: TOKENS[0],
    type: 'mirror',
    from: '9f3a1c02',
    to: '7b2f9d10',
    seq: 42,
    id: '5eed0000beefcafe',
    fid: 'c0ffee1234567890',
    connSaltHex: 'f0e1d2c3',
    body: {
      sessionId: '0a1b2c3d4e5f6071',
      message: {
        type: 'agentItems',
        nodeId: 'c3a7f1d0-2f4b-4e8a-9b6c-0d1e2f3a4b5c',
        items: MIRRORED_ITEMS,
      },
    },
  },
  {
    // A second connection with the same token as frames[0], and the same seq 1: `seq`
    // restarts on every connection, and the fresh connection salt is the only thing
    // that keeps that from reusing a nonce (PROTOCOL.md section 4). Small plaintext on
    // purpose -- the point is the salt, not the payload.
    token: TOKENS[0],
    type: 'hello',
    from: '9f3a1c02',
    to: '*',
    seq: 1,
    id: '2a3b4c5d6e7f8091',
    fid: '7f1e2d3c4b5a6978',
    connSaltHex: '9e8d7c6b',
    body: {
      deviceId: '6f1e2d3c4b5a69788796a5b4c3d2e1f0',
      deviceName: 'DESKTOP-4A2B',
      instanceId: 'pid-4242',
      workspace: 'd:\\Repos\\MinimalHost',
      appVersion: '0.1.0',
      proto: 1,
    },
  },
];

function assert(condition, message) {
  if (!condition) throw new Error('vector check failed: ' + message);
}

function utf8(text) {
  return Buffer.from(text, 'utf8');
}

// RFC 4648 base32, uppercase alphabet, no padding.
function base32NoPad(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function hkdf(ikm, info, length) {
  return Buffer.from(hkdfSync('sha256', ikm, utf8(HKDF_SALT), utf8(info), length));
}

function deriveToken(token) {
  const master = pbkdf2Sync(utf8(token), utf8(KDF_SALT), KDF_ITERATIONS, 32, 'sha256');
  const roomIdB = hkdf(master, 'room', 16);
  return {
    master,
    roomIdB,
    roomId: base32NoPad(roomIdB),
    encKey: hkdf(master, 'enc', 32),
    macKey: hkdf(master, 'mac', 32),
  };
}

// Nonce = uint64 big-endian frame sequence || uint32 big-endian connection salt.
function nonceFor(seq, connSaltHex) {
  const nonce = Buffer.alloc(NONCE_LENGTH);
  nonce.writeBigUInt64BE(BigInt(seq), 0);
  Buffer.from(connSaltHex, 'hex').copy(nonce, 8);
  return nonce;
}

// AES-256-GCM with the 16-byte tag appended after the ciphertext: the layout
// WebCrypto, .NET AesGcm and Java AES/GCM/NoPadding all produce.
function seal(encKey, nonce, aad, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', encKey, nonce);
  cipher.setAAD(utf8(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

function open(encKey, nonce, aad, sealed) {
  const tagAt = sealed.length - TAG_LENGTH;
  const decipher = createDecipheriv('aes-256-gcm', encKey, nonce);
  decipher.setAAD(utf8(aad));
  decipher.setAuthTag(sealed.subarray(tagAt));
  return Buffer.concat([decipher.update(sealed.subarray(0, tagAt)), decipher.final()]);
}

// The plaintext is the compact logical frame JSON, key order fixed by PROTOCOL.md section 5.
function plaintextFor(frame) {
  return (
    '{"v":1,"type":"' + frame.type + '","id":"' + frame.id + '","from":"' + frame.from +
    '","to":"' + frame.to + '","body":' + JSON.stringify(frame.body) + '}'
  );
}

// The canonical AAD is v|seq|fid: only the facts a receiver already has from the
// transport envelope before it decrypts (PROTOCOL.md section 4). `type`, `from` and `to`
// live inside the sealed plaintext; `idx` and `last` describe a slice, not the frame.
function aadFor(frame) {
  return ['1', String(frame.seq), frame.fid].join('|');
}

function isSaltHex(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value);
}

// The transport envelope (PROTOCOL.md section 7): key order fixed, and a slice is this
// object plus its own `b`. `s` is the connection salt, which the receiver must have
// before it can build the nonce and decrypt -- it is exactly the nonce's last 4 bytes.
function envelopeFor(frame, idx, last) {
  return { v: 1, seq: frame.seq, s: frame.connSaltHex, fid: frame.fid, idx, last };
}

function sliceSealed(frame, sealed) {
  const chunks = [];
  for (let offset = 0; offset < sealed.length; offset += SLICE_BYTES) {
    chunks.push(sealed.subarray(offset, offset + SLICE_BYTES));
  }
  assert(chunks.length > 0, 'a sealed frame must slice into at least one part (fid ' + frame.fid + ')');
  assert(
    chunks.length <= Math.ceil(SEALED_MAX / SLICE_BYTES),
    'a sealed frame may not need more slices than the ' + SEALED_MAX + ' byte cap allows (fid ' + frame.fid + ')'
  );
  return chunks.map((chunk, idx) => ({
    v: 1,
    seq: frame.seq,
    s: frame.connSaltHex,
    fid: frame.fid,
    idx,
    last: idx === chunks.length - 1,
    b: chunk.toString('base64'),
  }));
}

function reassemble(frame, fid, parts) {
  const salts = new Set();
  const chunks = parts.map((part, index) => {
    assert(
      Object.keys(part).join(',') === 'v,seq,s,fid,idx,last,b',
      'a slice must be a complete envelope minus its own b, got: ' + Object.keys(part).join(',')
    );
    assert(isSaltHex(part.s), 'slice ' + index + ' must carry an 8-character lowercase hex s (fid ' + fid + ')');
    salts.add(part.s);
    assert(
      part.v === 1 && part.seq === frame.seq && part.s === frame.connSaltHex && part.fid === fid,
      'slice ' + index + " envelope's v/seq/s/fid disagree with the frame (fid " + fid + ')'
    );
    assert(part.idx === index, 'slice ' + index + ' has idx ' + part.idx + ' (fid ' + fid + ')');
    assert(
      part.b.length < SLICE_B64_MAX,
      'slice ' + index + ' base64 length ' + part.b.length + ' >= ' + SLICE_B64_MAX + ' (fid ' + fid + ')'
    );
    assert(part.last === (index === parts.length - 1), 'only the final slice may set last (fid ' + fid + ')');
    return Buffer.from(part.b, 'base64');
  });
  assert(salts.size === 1, 'all parts of one fid must carry the same s, got ' + [...salts].join(', ') + ' (fid ' + fid + ')');
  return Buffer.concat(chunks);
}

function buildDerivations() {
  return TOKENS.map((token) => {
    const derived = deriveToken(token);
    assert(derived.roomId.length === 26, 'roomId for ' + JSON.stringify(token) + ' is ' + derived.roomId.length + ' chars, expected 26');
    assert(derived.roomId === base32NoPad(derived.roomIdB), 'roomId for ' + JSON.stringify(token) + ' is not the base32 of roomIdB');
    assert(derived.roomIdB.length === 16, 'roomIdB for ' + JSON.stringify(token) + ' is ' + derived.roomIdB.length + ' bytes, expected 16');
    return {
      token,
      masterHex: derived.master.toString('hex'),
      roomIdBHex: derived.roomIdB.toString('hex'),
      roomId: derived.roomId,
      encKeyHex: derived.encKey.toString('hex'),
      macKeyHex: derived.macKey.toString('hex'),
      // The token as its UTF-8 bytes, so the encoding a vector assumes is explicit.
      tokenUtf8Hex: utf8(token).toString('hex'),
    };
  });
}

function buildFrames() {
  return FRAMES.map((frame) => {
    const derived = deriveToken(frame.token);
    assert(isSaltHex(frame.connSaltHex), 'connSaltHex must be 8 lowercase hex chars');
    assert(/^[0-9a-f]{16}$/.test(frame.fid), 'fid must be 16 lowercase hex chars');
    assert(/^[0-9a-f]{16}$/.test(frame.id), 'id must be 16 lowercase hex chars');
    const aad = aadFor(frame);
    assert(aad.split('|').length === 3, 'the AAD must carry exactly 3 fields: ' + aad);
    const plaintext = plaintextFor(frame);
    assert(
      plaintext.startsWith(
        '{"v":1,"type":"' + frame.type + '","id":"' + frame.id + '","from":"' + frame.from +
        '","to":"' + frame.to + '","body":'
      ),
      'the logical frame JSON must keep the key order v,type,id,from,to,body: ' + plaintext.slice(0, 96)
    );
    const nonce = nonceFor(frame.seq, frame.connSaltHex);
    const sealed = seal(derived.encKey, nonce, aad, utf8(plaintext));
    assert(open(derived.encKey, nonce, aad, sealed).equals(utf8(plaintext)), 'seal round-trip mismatch for fid ' + frame.fid);
    assert(sealed.length <= SEALED_MAX, 'sealed frame for fid ' + frame.fid + ' exceeds the ' + SEALED_MAX + ' byte cap');
    const envelope = envelopeFor(frame, 0, true);
    assert(
      Object.keys(envelope).join(',') === 'v,seq,s,fid,idx,last',
      'the envelope key order must be v,seq,s,fid,idx,last, got: ' + Object.keys(envelope).join(',')
    );
    assert(envelope.s === frame.connSaltHex, 'envelope.s must be the frame connSaltHex (fid ' + frame.fid + ')');
    assert(isSaltHex(envelope.s), 'envelope.s must be 8 lowercase hex chars (fid ' + frame.fid + ')');
    assert(
      nonce.toString('hex').endsWith(envelope.s),
      'envelope.s must be the last 4 bytes of the nonce (nonceHex ' + nonce.toString('hex') + ', s ' + envelope.s + ', fid ' + frame.fid + ')'
    );
    return {
      frame,
      sealed,
      encKey: derived.encKey,
      entry: {
        token: frame.token,
        peer: frame.from,
        seq: frame.seq,
        connSaltHex: frame.connSaltHex,
        aad,
        plaintextUtf8: plaintext,
        nonceHex: nonce.toString('hex'),
        sealedHex: sealed.toString('hex'),
        envelope,
      },
    };
  });
}

function buildSlices(frames) {
  // Two manifests: the tiny frame (one part) and the large one (several parts).
  // Both re-use sealed frames from `seals`, so a slices entry and the seal it
  // belongs to are checkable against each other.
  const chosen = [frames[0], frames[2]];
  const entries = chosen.map((item) => {
    const parts = sliceSealed(item.frame, item.sealed);
    const sealed = reassemble(item.frame, item.frame.fid, parts);
    assert(sealed.equals(item.sealed), 'slice reassembly mismatch for fid ' + item.frame.fid);
    // The envelope alone must be enough to open the frame: the nonce comes from the
    // part's `s` and the AAD from the part's v/seq/fid, never from a side channel.
    const first = parts[0];
    const nonce = nonceFor(first.seq, first.s);
    const aad = ['1', String(first.seq), first.fid].join('|');
    assert(
      open(item.encKey, nonce, aad, sealed).equals(utf8(item.entry.plaintextUtf8)),
      'a slice set must open using only its envelope fields (fid ' + item.frame.fid + ')'
    );
    return { fid: item.frame.fid, sealedHex: item.sealed.toString('hex'), parts };
  });
  assert(entries.length === 2, 'expected exactly 2 slice manifests');
  assert(entries.some((entry) => entry.parts.length > 1), 'at least one slice manifest must need more than one part');
  return entries;
}

function build() {
  const derivations = buildDerivations();
  const frames = buildFrames();
  const slices = buildSlices(frames);
  const equal = frames.filter((item) => item.frame.id === item.frame.fid);
  const apart = frames.filter((item) => item.frame.id !== item.frame.fid);
  assert(equal.length > 0, 'the vectors must keep a frame whose id equals its fid (the sender chose to)');
  assert(apart.length > 0, 'the vectors must show at least one frame whose id differs from its fid');
  assert(
    slices.some((entry) => frames.some((item) => item.frame.fid === entry.fid && item.frame.id !== item.frame.fid)),
    'at least one slices[] entry must belong to a frame whose id differs from its fid'
  );
  assert(SLICE_BYTES * 8 / 6 < SLICE_B64_MAX, 'the reference chunking must stay inside the slice base64 limit');
  // The salt is per connection, not per token or per frame: show two connections of one
  // token, and the same seq on both, so a reader can see what makes the nonce fresh.
  const sameTokenTwoSalts = frames.some((a, i) =>
    frames.some((b, j) => j !== i && a.frame.token === b.frame.token && a.frame.connSaltHex !== b.frame.connSaltHex)
  );
  assert(sameTokenTwoSalts, 'the vectors must show one token on two connections with different salts');
  const sameSeqTwoSalts = frames.some((a, i) =>
    frames.some((b, j) => j !== i && a.frame.seq === b.frame.seq && a.frame.connSaltHex !== b.frame.connSaltHex)
  );
  assert(sameSeqTwoSalts, 'the vectors must show the same seq on two connections with different salts');
  const largePlaintextBytes = utf8(frames[2].entry.plaintextUtf8).length;
  assert(
    largePlaintextBytes >= 130000 && largePlaintextBytes <= 175000,
    'the large plaintext is ' + largePlaintextBytes + ' bytes, expected roughly 150 KB'
  );
  assert(slices[1].parts.length > 1, 'the large sealed frame must need more than one slice');
  assert(frames[0].entry.plaintextUtf8.length < 200, 'the tiny plaintext must stay tiny');
  assert(
    utf8(frames[1].entry.plaintextUtf8).length >= 180 && utf8(frames[1].entry.plaintextUtf8).length <= 260,
    'the mid plaintext should be roughly 200 bytes, got ' + utf8(frames[1].entry.plaintextUtf8).length
  );
  return {
    vectors: {
      version: 1,
      note: 'Generated by tools/gen-remote-vectors.mjs. Do not edit by hand.',
      params: {
        kdf: 'PBKDF2-HMAC-SHA256',
        kdfIterations: KDF_ITERATIONS,
        kdfSalt: KDF_SALT,
        hkdfHash: 'SHA-256',
        hkdfSalt: HKDF_SALT,
        aead: 'AES-256-GCM',
        tagLength: TAG_LENGTH,
        nonceLength: NONCE_LENGTH,
        sliceChunkBytes: SLICE_BYTES,
      },
      derivations,
      seals: frames.map((item) => item.entry),
      slices,
    },
    report: {
      roomIds: derivations.map((entry) => entry.roomId),
      sealBytes: frames.map((item) => item.sealed.length),
      sliceParts: slices.map((entry) => entry.parts.length),
      largePlaintextBytes,
      connections: frames.map((item) => 'seq ' + item.frame.seq + ' s ' + item.frame.connSaltHex + ' fid ' + item.frame.fid),
      idEqualsFid: equal.map((item) => item.frame.fid),
      idDiffersFromFid: apart.map((item) => item.frame.id + ' != ' + item.frame.fid),
    },
  };
}

function main() {
  const { vectors, report } = build();
  const json = JSON.stringify(vectors, null, 2) + '\n';
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json, 'utf8');
  console.log('wrote ' + OUT_PATH);
  console.log('  bytes:        ' + Buffer.byteLength(json, 'utf8'));
  console.log('  derivations:  ' + report.roomIds.length + ' (' + report.roomIds.join(', ') + ')');
  console.log('  seals:        ' + report.sealBytes.length + ' (' + report.sealBytes.join(', ') + ' sealed bytes)');
  console.log('  connections:  ' + report.connections.join(' | '));
  console.log('  slices:       ' + report.sliceParts.length + ' (' + report.sliceParts.join(' + ') + ' parts)');
  console.log('  large frame:  ' + report.largePlaintextBytes + ' plaintext bytes, ' + report.sliceParts[1] + ' slices');
  console.log('  id == fid:    ' + report.idEqualsFid.join(', '));
  console.log('  id != fid:    ' + report.idDiffersFromFid.join(', '));
}

try {
  main();
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
}
