/**
 * The Android pairing fixture: shared vector 1's payload, as a QR PNG.
 *
 * The desktop is the half that holds the room token, so the desktop is the half that draws
 * the code; the phone proves it can read one by decoding this file with **zxing** in
 * `remote/android/core/src/test/resources/`. That makes the PNG a *checked-in test asset*
 * like the crypto vectors, and this script is its generator — the asset is never drawn by
 * hand, so it cannot drift from the codec it is supposed to pin.
 *
 * The payload is the repo's published test vector (`tools/check-remote.js`, and the same
 * three literals the Android tests assert), so printing it here leaks nothing. A *real* room's
 * payload is never printed and never leaves the two devices — see `src/remote/pairing.ts`.
 *
 * Deterministic by construction: one fixed payload, one fixed encoder, one fixed scale — so
 * running it twice must produce byte-identical output.
 *
 * Node built-ins only, plain ESM, and the compiled encoder (no build step of its own):
 *   npm run compile && node tools/gen-qr-fixture.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'remote', 'android', 'core', 'src', 'test', 'resources', 'pairing-fixture.png');

const PAIRING_MODULE = join(ROOT, 'out', 'remote', 'pairing.js');
const QR_MODULE = join(ROOT, 'out', 'remote', 'qr.js');
for (const [name, file] of [['pairing', PAIRING_MODULE], ['qr', QR_MODULE]]) {
  if (!existsSync(file)) {
    console.error(`gen-qr-fixture: out/remote/${name}.js is missing — run \`npm run compile\` first.`);
    process.exit(1);
  }
}
const { buildPairingPayload } = require(PAIRING_MODULE);
const { encodeQr, qrPng } = require(QR_MODULE);

// Shared vector 1, exactly as `tools/check-remote.js` and the Android tests spell it. The
// payload is built by the codec (never retyped into the fixture) and then checked against the
// literal, so the fixture is provably the vector and not a coincidence of encoding.
const EXPECTED =
  'spinney-pair:1?relay=https%3A%2F%2Frelay.example.com%3A8787&room=home%20%2B%20lab&token=a%20b%2Bc%2Fd%3F';
const payload = buildPairingPayload({
  relayUrl: 'https://relay.example.com:8787',
  roomName: 'home + lab',
  token: 'a b+c/d?',
});
if (payload !== EXPECTED) {
  console.error('gen-qr-fixture: the codec no longer reproduces shared vector 1 — refusing to write a fixture.');
  console.error(`  expected: ${EXPECTED}`);
  console.error(`  built:    ${payload}`);
  process.exit(1);
}

const code = encodeQr(payload);
const png = qrPng(code.modules);
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, png);

console.log(`wrote ${OUT_PATH}`);
console.log(`  payload:  ${payload}`);
console.log(`  bytes:    ${Buffer.byteLength(payload, 'utf8')}`);
console.log(`  version:  ${code.version} (level M, byte mode), mask ${code.mask}, ${code.size}x${code.size} modules`);
console.log(`  png:      ${png.length} bytes, ${code.modules.length} modules per side including the quiet zone`);
