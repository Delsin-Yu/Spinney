/*
 * remote-interop — the one test that puts **both implementations on a wire at once**.
 *
 * WHY THIS FILE EXISTS. Every layer of remote control is tested, and `remote/vectors/vectors.json`
 * pins the two implementations that hold a key to the same bytes. Neither of those facts is the
 * same as "a frame from one of them arrives intact at the other": the vectors prove *agreement on
 * values*, and the unit tests prove *behaviour in isolation*. What has never happened in this repo
 * is a frame crossing between the TypeScript host and the Kotlin client through the real relay —
 * and the whole design (`remote/PROTOCOL.md` §5: "there is one renderer, not two"; §7: SSE down,
 * POST up) rests on that crossing working.
 *
 * So this run stands up the **real relay** (`remote/server`, the JIT build), starts the **real
 * Kotlin client** as a peer (`remote/android/core`'s `InteropMain`, on a plain JVM — the transport
 * lives in `:core` precisely so this is possible), and becomes the **real TypeScript peer** itself
 * using the compiled transport (`out/remote/relayClient.js`, plus `frames.js` and `rooms.js`). It
 * then makes the two of them talk, and refuses to call anything a pass that it did not observe.
 *
 * WHAT IT PINS, case by case:
 *
 *   1. both peers join the same derived room, and the relay counts them as peers;
 *   2. a frame from the TypeScript peer arrives at the Kotlin peer **byte for byte** — the exact
 *      plaintext, compared as a whole and by sha256, for a small frame *and* for one large enough
 *      to need several slices;
 *   3. a frame from the Kotlin peer arrives at the TypeScript peer the same way: the driver reads
 *      the raw SSE stream of a second peer, reassembles and opens it with the **real** TypeScript
 *      crypto, and compares that plaintext with the one the Kotlin peer said it sent;
 *   4. both directions open the frame with the salt **read from the envelope's `s`** — and neither
 *      opens with the salt the pre-`s` convention would have inferred from `fid`. That is the
 *      assertion that would have failed under the old hidden-salt convention, and it is checked
 *      from both sides: the Kotlin peer reports the fid-derived salt and whether it opens (`false`),
 *      and the driver tries the same open in TypeScript and requires the auth failure;
 *   5. a **replay** is refused by the receiving side — in both directions, by re-posting the exact
 *      same slice lines — and a frame whose `s` was altered (the same sealed bytes, a neighbouring
 *      salt on the envelope) does **not** open, while the unaltered one does.
 *
 * Every await is bounded; anything that does not settle fails the run instead of hanging it. The
 * `finally` kills the relay, the Kotlin peer and every reader this script started, and the script
 * never calls `process.exit(0)` on the way out — a leaked process would keep the run alive, which
 * is itself the assertion that nothing was left behind.
 *
 * DEPENDENCIES: `out/` (this script compiles the extension itself when it is stale), the .NET SDK
 * for the relay (it builds the JIT dll when it is missing), and a JDK plus the Gradle wrapper for
 * the Kotlin peer (it builds `spinney-interop.jar` with `--no-daemon`, so no Gradle daemon is left
 * behind by a test run). All three build steps are skipped when their artifact is already current.
 *
 * Run: node tools/remote-interop.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ANDROID = path.join(ROOT, 'remote', 'android');
const OUT = path.join(ROOT, 'out', 'remote');
const RELAY_DIR = path.join(ROOT, 'remote', 'server');
const RELAY_DLL = path.join(RELAY_DIR, 'bin', 'Release', 'net10.0', 'spinney-relay.dll');
const INTEROP_JAR = path.join(ANDROID, 'core', 'build', 'libs', 'spinney-interop.jar');
const GRADLEW = path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const IS_WINDOWS = process.platform === 'win32';

/** The token is the room: this is a fixture, not a secret, and it never leaves loopback. */
const TOKEN = 'interop-kotlin-typescript-0001';
/** The large frame's payload: hex, so it is pure ASCII and 4 slices at the 30000-byte chunking. */
const LARGE_PAYLOAD_BYTES = 90_000;

let checks = 0;
let failures = 0;

const ok = (label, condition, detail = '') => {
  checks += 1;
  if (condition) {
    console.log(`[ok  ] ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const info = (line) => console.log(`       ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const short = (text, n = 72) => (text.length <= n ? text : `${text.slice(0, n)}…(${text.length} bytes)`);

/** A promise that fails the run instead of hanging it. */
async function bounded(label, promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Poll until `probe` returns a truthy value; reject after `ms`. */
async function waitFor(label, probe, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${label} never happened within ${ms} ms`);
    await sleep(25);
  }
}

// ---------------------------------------------------------------------------------------------
// Processes: every child is tracked, every child is killed, and its output is kept for a failure.
// ---------------------------------------------------------------------------------------------

const children = [];

function start(name, command, args, options = {}) {
  // `shell: true` is required on Windows for a `.bat`/`.cmd` launcher (Node refuses to spawn one
  // directly since the 2024 command-injection fix): the Gradle wrapper and `npm.cmd` are both
  // batch files. The command and every argument here is a fixed literal, so no quoting is needed.
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: options.shell ?? false,
  });
  const record = { name, child, lines: [], stderr: [], exited: false };
  children.push(record);

  for (const [stream, sink] of [
    [child.stdout, record.lines],
    [child.stderr, record.stderr],
  ]) {
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', (line) => {
      sink.push(line);
      if (sink.length > 4000) sink.shift();
      if (options.echo) console.log(`       [${name}] ${line}`);
    });
  }
  child.on('exit', (code, signal) => {
    record.exited = true;
    record.code = code;
    record.signal = signal;
  });
  child.on('error', (error) => {
    record.exited = true;
    record.error = error;
  });
  return record;
}

/** Run a build step to completion, with a bounded budget, echoing its output as it goes. */
function run(label, command, args, cwd, timeoutMs, shell = false) {
  return new Promise((resolve, reject) => {
    const record = start(label, command, args, { cwd, echo: false, shell });
    const timer = setTimeout(() => {
      killTree(record);
      reject(new Error(`${label} did not finish within ${timeoutMs} ms (killed)`));
    }, timeoutMs);
    record.child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited ${code}\n${record.lines.slice(-20).join('\n')}\n${record.stderr.slice(-20).join('\n')}`));
      }
    });
    record.child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${label} could not start: ${error.message}`));
    });
  });
}

function killTree(record) {
  if (record.exited) return;
  try {
    record.child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  if (!IS_WINDOWS || record.child.pid === undefined) return;
  // A Windows child that ignores SIGTERM (a forked JVM, a Kestrel host) needs the tree killed,
  // and doing it synchronously means the `finally` block cannot leave one behind.
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(record.child.pid)], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* already gone */
  }
}

function killEverything() {
  for (const record of children) killTree(record);
}

// ---------------------------------------------------------------------------------------------
// The pieces this run needs to exist before it starts anything
// ---------------------------------------------------------------------------------------------

function newestMtime(dir, filter) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === '.gradle') continue;
      newest = Math.max(newest, newestMtime(full, filter));
      continue;
    }
    if (!filter(entry.name)) continue;
    newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

async function freePort() {
  return bounded(
    'a free loopback port',
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    }),
    5000,
  );
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinney-interop-'));
let relay = null;
let kotlin = null;
let rawReader = null;
let stopRawReader = null;
let transport = null;

try {
  // ---- preflight: the compiled TypeScript, the relay, the Kotlin jar --------------------------
  const srcNewest = newestMtime(path.join(ROOT, 'src', 'remote'), (name) => name.endsWith('.ts'));
  const outStale =
    ['relayClient.js', 'frames.js', 'rooms.js'].some((name) => !fs.existsSync(path.join(OUT, name))) ||
    ['relayClient.js', 'frames.js', 'rooms.js'].some((name) => fs.statSync(path.join(OUT, name)).mtimeMs < srcNewest);
  if (outStale) {
    console.log(`-- compiling the extension (out/ is missing or older than src/remote) --`);
    await run('npm run compile', IS_WINDOWS ? 'npm.cmd' : 'npm', ['run', 'compile'], ROOT, 180_000, IS_WINDOWS);
  }
  const frames = (await import(pathToFileURL(path.join(OUT, 'frames.js')).href)).default;
  const rooms = (await import(pathToFileURL(path.join(OUT, 'rooms.js')).href)).default;
  const relayClient = (await import(pathToFileURL(path.join(OUT, 'relayClient.js')).href)).default;
  ok('the compiled TypeScript transport is loadable', Boolean(frames?.openFrame && rooms?.deriveRoom && relayClient?.RelayTransport));

  // One PBKDF2 (600000 iterations): the driver derives the room the same way the host does.
  const keys = rooms.deriveRoom(TOKEN);
  const roomId = keys.roomId;

  if (!fs.existsSync(RELAY_DLL)) {
    console.log(`-- building the relay (dotnet build -c Release) --`);
    await run('dotnet build', 'dotnet', ['build', '-c', 'Release'], RELAY_DIR, 300_000);
  }
  ok('the relay dll exists', fs.existsSync(RELAY_DLL), short(RELAY_DLL));

  const jarNewest = Math.max(
    newestMtime(path.join(ANDROID, 'core', 'src'), (name) => name.endsWith('.kt')),
    fs.statSync(path.join(ANDROID, 'core', 'build.gradle.kts')).mtimeMs,
  );
  if (!fs.existsSync(INTEROP_JAR) || fs.statSync(INTEROP_JAR).mtimeMs < jarNewest) {
    console.log(`-- building the Kotlin peer jar (gradlew --offline --no-daemon :core:interopJar) --`);
    await run('gradlew', GRADLEW, ['--offline', '--no-daemon', '-q', ':core:interopJar'], ANDROID, 300_000, IS_WINDOWS);
  }
  ok('the Kotlin peer jar exists', fs.existsSync(INTEROP_JAR), `${short(INTEROP_JAR)}, ${fs.statSync(INTEROP_JAR).size} bytes`);

  // ---- the real relay ------------------------------------------------------------------------
  const port = await freePort();
  const relayUrl = `http://127.0.0.1:${port}`;
  relay = start('relay', 'dotnet', [RELAY_DLL, '--urls', relayUrl]);
  const health = await bounded(
    'the relay’s /healthz',
    (async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          const response = await fetch(`${relayUrl}/healthz`);
          if (response.ok) return await response.json();
        } catch {
          /* not listening yet */
        }
        if (Date.now() > deadline) throw new Error(`the relay never answered ${relayUrl}/healthz in 20 s`);
        await sleep(100);
      }
    })(),
    25_000,
  );
  ok('the relay is up and healthy', health.ok === true, `${relayUrl}, rooms=${health.rooms}, peers=${health.peers}`);
  info(`the room: ${roomId} (derived from the token by the real key schedule)`);

  // ---- the TypeScript peer: the real compiled transport --------------------------------------
  const received = [];
  const statuses = [];
  transport = new relayClient.RelayTransport({
    relayUrl,
    roomId,
    encKey: keys.encKey,
    deviceId: 'interop-device-typescript',
    // This peer is the publisher side of the interop run (it is the one announcing instances), so
    // it is the side that may bring the room into being on the relay (`/v2`'s `mode=create`). The
    // Kotlin peer below joins, and must not be able to create the room at all.
    joinMode: 'create',
    heartbeatMs: 5_000,
    onFrame: (frame) => received.push(frame),
    onStatus: (status) => statuses.push(status),
  });
  transport.start();
  const onlineStatus = await bounded(
    'the TypeScript peer to come online',
    waitFor('the TypeScript peer to come online', () => (transport.status.phase === 'online' ? transport.status : null), 15_000),
    20_000,
  );
  const tsPeer = onlineStatus.peerId;
  ok('the TypeScript peer joined the room', /^[0-9a-f]{8}$/.test(tsPeer ?? ''), `peer ${tsPeer}`);

  // ---- the Kotlin peer: a plain JVM, the jar built above -------------------------------------
  const largeBody = JSON.stringify({ payload: crypto.randomBytes(LARGE_PAYLOAD_BYTES / 2).toString('hex') });
  const largeFile = path.join(tempDir, 'large-body.json');
  fs.writeFileSync(largeFile, largeBody);

  // ---- the token: one spelling, one room — checked against the desktop's own rules ------------
  //
  // This is the defect that started this run's predecessor: the desktop trims a token, a phone
  // did not, and four spellings of one token became four rooms with neither device ever seeing the
  // other. The Kotlin side answers for its own normalisation here, the TypeScript side answers for
  // its own (`String.prototype.trim` + `tokenIssue`, the compiled `rooms.js`), and every spelling
  // is compared spelling by spelling.
  const typedToken = 'a1f3c9d2e5b8a470f3a1c02b7d4e685';
  const spellings = [
    typedToken, // as typed
    `${typedToken} `, // a trailing space
    `${typedToken}\n`, // what a phone paste produces
    `\n${typedToken}`, // a paste with a leading newline
    `\r\n\t${typedToken} \t`, // a copy that carried more than one
    `\u00A0${typedToken}\u00A0`, // a non-breaking space
    `\uFEFF${typedToken}\uFEFF`, // a byte-order mark: trimmed by JS, not whitespace to Kotlin
    typedToken[0].toUpperCase() + typedToken.slice(1), // the IME capitalised the first letter
    'short', // too short for either side
    'aaaaaaaaaaaaaaaa', // one character repeated: the keyboard slip
  ];
  const spellingsFile = path.join(tempDir, 'token-spellings.json');
  fs.writeFileSync(spellingsFile, JSON.stringify(spellings));

  const probe = start('token-probe', 'java', [
    '-cp',
    INTEROP_JAR,
    'dev.spinney.remote.core.InteropMain',
    '--probe-tokens-file',
    spellingsFile,
  ]);
  await bounded(
    'the Kotlin token probe to exit',
    waitFor('the Kotlin token probe to exit', () => (probe.exited ? true : null), 60_000),
    65_000,
  );
  const kotlinTokens = probe.lines
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((line) => line.event === 'token');
  ok('the Kotlin token probe answered for every spelling', kotlinTokens.length === spellings.length, `${kotlinTokens.length}/${spellings.length}`);

  for (const [index, spelling] of spellings.entries()) {
    const kotlin = kotlinTokens[index];
    if (!kotlin) continue;
    const label = `spelling #${index} (${JSON.stringify(spelling.length > 12 ? `${spelling.slice(0, 8)}…(${spelling.length})` : spelling)})`;
    // `String.prototype.trim` is what the desktop applies, and the harness applies the same
    // built-in — so the comparison is against the desktop's *rule*, not against a value the harness
    // took from Kotlin.
    const desktopTrimmed = spelling.trim();
    const desktopIssue = rooms.tokenIssue(desktopTrimmed);
    ok(
      `Kotlin and TypeScript trim ${label} to the same characters`,
      kotlin.normalized === desktopTrimmed,
      `kotlin=${JSON.stringify(kotlin.normalized)} js=${JSON.stringify(desktopTrimmed)}`,
    );
    ok(
      `…and the two implementations agree about the strength of ${label}`,
      (kotlin.issue ?? null) === (desktopIssue ?? null),
      `kotlin=${kotlin.issue ?? 'usable'} js=${desktopIssue ?? 'usable'}`,
    );
    if (desktopIssue === null) {
      ok(
        `…and derive the SAME room for ${label}`,
        kotlin.roomId === rooms.deriveRoom(desktopTrimmed).roomId,
        `room ${kotlin.roomId}`,
      );
      // The control: hashing the spelling the phone was actually handed would have been another
      // room, whenever the spelling was not already trimmed. That is the bug, still reproducible.
      if (spelling !== desktopTrimmed) {
        ok(
          '…while the untrimmed spelling would have been a different room (the defect this fixes)',
          rooms.deriveRoom(spelling).roomId !== kotlin.roomId,
          `${rooms.deriveRoom(spelling).roomId} vs ${kotlin.roomId}`,
        );
      }
    }
  }
  ok(
    'the two implementations carry the desktop’s own thresholds (16 characters, 8 distinct)',
    kotlinTokens[0]?.minChars === 16 && kotlinTokens[0]?.minDistinct === 8 && rooms.MIN_TOKEN_CHARS === 16 && rooms.MIN_DISTINCT_CHARS === 8,
    `kotlin=${kotlinTokens[0]?.minChars}/${kotlinTokens[0]?.minDistinct} ts=${rooms.MIN_TOKEN_CHARS}/${rooms.MIN_DISTINCT_CHARS}`,
  );
  ok(
    'the capitalised spelling is a real second room on both sides (so the IME had to be constrained, not the token guessed at)',
    kotlinTokens[7]?.roomId !== kotlinTokens[0]?.roomId && kotlinTokens[7]?.normalized === spellings[7],
    `${kotlinTokens[0]?.roomId} → ${kotlinTokens[7]?.roomId}`,
  );

  kotlin = start('kotlin', 'java', [
    '-cp',
    INTEROP_JAR,
    'dev.spinney.remote.core.InteropMain',
    '--relay',
    relayUrl,
    '--token',
    TOKEN,
    '--name',
    'interop-kotlin',
    '--send-file',
    largeFile,
    '--send-after-ms',
    '300',
    '--replay-after-ms',
    '700',
    '--nudge-salt-after-ms',
    '1500',
    '--exit-on-stdin',
    // A belt-and-braces timer, so a driver that dies cannot leave a JVM in the room for long. The
    // normal exit is the stdin EOF the `finally` causes.
    '--exit-after-ms',
    '60000',
  ], { stdin: true });

  const kotlinEvents = () =>
    kotlin.lines.filter((line) => line.startsWith('{')).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { event: 'unparsable', raw: line.slice(0, 200) };
      }
    });

  const kotlinOnline = await bounded(
    'the Kotlin peer to come online',
    waitFor('the Kotlin peer to come online', () => kotlinEvents().find((event) => event.event === 'online'), 25_000).catch((error) => {
      throw new Error(`${error.message}\nkotlin stdout:\n${kotlin.lines.join('\n')}\nkotlin stderr:\n${kotlin.stderr.join('\n')}`);
    }),
    30_000,
  );
  ok('the Kotlin peer joined the same room', /^[0-9a-f]{8}$/.test(kotlinOnline.peer ?? ''), `peer ${kotlinOnline.peer}, salt ${kotlinOnline.salt}`);
  ok(
    'the two peers are different peers in one room',
    kotlinOnline.peer !== tsPeer,
    `${tsPeer} vs ${kotlinOnline.peer}`,
  );

  // ---- the driver's own raw reader: a second peer, reading SSE itself -------------------------
  //
  // The TypeScript transport above proves "the API received a frame". This reader proves the
  // stronger thing: that the *bytes on the wire* from the Kotlin peer reassemble and open under
  // the real TypeScript crypto, byte for byte, and that the salt used to open them came off the
  // envelope. It is a second join, so the relay treats it as a second peer.
  const joinResponse = await bounded(
    'the raw reader’s join',
    fetch(`${relayUrl}/v1/room/${roomId}/join`, { method: 'POST' }),
    10_000,
  );
  const rawPeer = (await joinResponse.json()).peer;
  ok('the driver’s raw reader joined as its own peer', /^[0-9a-f]{8}$/.test(rawPeer ?? ''), `peer ${rawPeer}`);

  const rawLines = [];
  stopRawReader = new AbortController();
  const rawPromise = bounded(
    'the raw SSE read',
    (async () => {
      const response = await fetch(`${relayUrl}/v1/room/${roomId}/down?peer=${rawPeer}`, {
        headers: { accept: 'text/event-stream' },
        signal: stopRawReader.signal,
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.startsWith('data: ')) rawLines.push(line.slice(6).trim());
        }
      }
    })(),
    12_000,
  );
  rawPromise.catch(() => {
    /* the reader is aborted on the way out; that is not a failure */
  });

  const peersSeen = await bounded('the relay’s peer count', fetch(`${relayUrl}/healthz`).then((r) => r.json()), 5000);
  ok('the relay counts three peers in the room', peersSeen.peers >= 3, `peers=${peersSeen.peers}`);

  // ---- TypeScript → Kotlin: a small frame and a multi-slice one ------------------------------
  const smallId = frames.newFrameId();
  const smallBody = { payload: `SMALL-${crypto.randomBytes(8).toString('hex')}` };
  const smallPlaintext = frames.encodeFrame({ v: frames.FRAME_VERSION, type: 'interop', id: smallId, from: tsPeer, to: '*', body: smallBody });
  ok('the TypeScript peer sent the small frame', transport.send({ type: 'interop', id: smallId, to: '*', body: smallBody }) === true, short(smallBody.payload));

  const largeId = frames.newFrameId();
  const largeBodyTs = { payload: JSON.parse(largeBody).payload };
  const largePlaintextTs = frames.encodeFrame({ v: frames.FRAME_VERSION, type: 'interop', id: largeId, from: tsPeer, to: '*', body: largeBodyTs });
  ok('the TypeScript peer sent the multi-slice frame', transport.send({ type: 'interop', id: largeId, to: '*', body: largeBodyTs }) === true, `${largePlaintextTs.length} bytes of plaintext`);

  const kotlinFrame = (id) =>
    kotlinEvents().find((event) => event.event === 'frame' && event.id === id);  const smallAtKotlin = await bounded(
    'the small frame to arrive at the Kotlin peer',
    waitFor('the small frame to arrive at the Kotlin peer', () => kotlinFrame(smallId), 15_000).catch((error) => {
      throw new Error(`${error.message}\nkotlin stdout:\n${kotlin.lines.join('\n')}`);
    }),
    20_000,
  );
  ok(
    'the small frame arrived at the Kotlin peer byte for byte',
    smallAtKotlin.plaintext === smallPlaintext,
    `sha256 ${sha256(smallAtKotlin.plaintext).slice(0, 16)} on both sides, ${smallAtKotlin.bytes} bytes`,
  );
  ok(
    'the small frame’s sha256 matches what the TypeScript peer sealed',
    smallAtKotlin.sha256 === sha256(smallPlaintext),
    `${smallAtKotlin.sha256.slice(0, 16)}…`,
  );

  const largeAtKotlin = await bounded(
    'the multi-slice frame to arrive at the Kotlin peer',
    waitFor('the multi-slice frame to arrive at the Kotlin peer', () => kotlinFrame(largeId), 15_000).catch((error) => {
      throw new Error(`${error.message}\nkotlin stdout:\n${kotlin.lines.join('\n')}`);
    }),
    20_000,
  );
  ok(
    'the multi-slice frame arrived at the Kotlin peer byte for byte',
    largeAtKotlin.plaintext === largePlaintextTs,
    `${largeAtKotlin.bytes} bytes (sealed ${largePlaintextTs.length} + tag), sha256 ${sha256(largeAtKotlin.plaintext).slice(0, 16)}…`,
  );
  const kotlinSentSlices = await bounded(
    'the Kotlin peer to report its sent frame',
    waitFor('the Kotlin peer to report its sent frame', () => kotlinEvents().find((event) => event.event === 'sent'), 20_000),
    25_000,
  );
  ok(
    'the Kotlin peer’s own frame needed several slices',
    kotlinSentSlices.slices >= 3,
    `${kotlinSentSlices.slices} slices for ${JSON.parse(largeBody).payload.length} payload characters`,
  );

  // ---- the salt: read from the envelope, in both directions ----------------------------------
  //
  // The Kotlin peer reports the salt it opened each frame with, the salt the *old* convention
  // would have inferred from `fid`, and whether the frame opens under that one. All three are
  // facts about the frame it received, and together they say: the receiver used `s`.
  for (const [label, frame] of [['small', smallAtKotlin], ['multi-slice', largeAtKotlin]]) {
    ok(
      `the Kotlin peer read the ${label} frame’s salt from the envelope`,
      frame.path === 'envelope' && /^[0-9a-f]{8}$/.test(frame.salt),
      `salt ${frame.salt}`,
    );
    ok(
      `the Kotlin peer did NOT use the fid-derived salt for the ${label} frame`,
      frame.fidSaltWouldOpen === false,
      `fid ${frame.id === smallId ? 'of the small frame' : 'of the multi-slice frame'} would have implied salt ${frame.fidSalt}, the envelope carried ${frame.salt}`,
    );
    ok(
      `the ${label} frame’s envelope salt and its fid genuinely disagree (the old convention is distinguishable)`,
      frame.fidSalt !== frame.salt,
      `${frame.salt} vs ${frame.fidSalt}`,
    );
  }

  // ---- Kotlin → TypeScript: the raw stream, opened with the real TypeScript crypto -----------
  const sentEvent = kotlinSentSlices;

  /** Reassemble and open every slice set the raw reader saw, keyed by fid. */
  const openRaw = () => {
    const sealedByFid = new Map();
    const slicesByFid = new Map();
    for (const line of rawLines) {
      let slice;
      try {
        slice = frames.decodeSlice(line);
      } catch {
        continue;
      }
      slicesByFid.set(slice.fid, (slicesByFid.get(slice.fid) ?? 0) + 1);
      const assembler = sealedByFid.get(slice.fid) ?? new frames.FrameReassembler();
      sealedByFid.set(slice.fid, assembler);
      const sealed = assembler.push(slice);
      if (sealed) sealedByFid.set(`${slice.fid}:sealed`, { sealed, slice });
    }
    return { sealedByFid, slicesByFid };
  };

  const rawFromKotlin = await bounded(
    'the Kotlin peer’s slices to reach the driver’s raw reader',
    waitFor(
      'the Kotlin peer’s slices to reach the driver’s raw reader',
      () => {
        const { sealedByFid } = openRaw();
        for (const [key, value] of sealedByFid) {
          if (!key.endsWith(':sealed')) continue;
          try {
            const plaintext = frames.openFrame({
              encKey: keys.encKey,
              aad: { seq: value.slice.seq, fid: value.slice.fid },
              salt: frames.decodeSalt(value.slice.s),
              sealed: value.sealed,
            });
            if (plaintext === sentEvent.plaintext) return { ...value, plaintext };
          } catch {
            /* not open yet, or not this frame */
          }
        }
        return null;
      },
      20_000,
    ),
    25_000,
  );

  const fid = rawFromKotlin.slice.fid;
  const wireSalt = rawFromKotlin.slice.s;
  const sliceCount = openRaw().slicesByFid.get(fid) ?? 0;
  ok(
    'the Kotlin peer’s frame arrived at the TypeScript side byte for byte',
    rawFromKotlin.plaintext === sentEvent.plaintext,
    `${rawFromKotlin.plaintext.length} bytes, sha256 ${sha256(rawFromKotlin.plaintext).slice(0, 16)}… on both sides`,
  );
  ok(
    'the Kotlin peer’s frame needed several slices on the wire',
    sliceCount >= 3,
    `${sliceCount} slices observed by the driver, ${sentEvent.slices} reported by the Kotlin peer`,
  );
  ok(
    'the driver opened it with the salt read from the envelope’s `s`',
    wireSalt === sentEvent.salt && frames.decodeSalt(wireSalt) === frames.decodeSalt(sentEvent.salt),
    `envelope s=${wireSalt}, the Kotlin peer’s own connection salt=${sentEvent.salt}`,
  );

  // The negative control that makes the assertion above mean something: the same sealed bytes
  // must NOT open under the salt the pre-`s` convention would have inferred from `fid`.
  const fidDerivedSalt = Number.parseInt(fid.slice(0, 8), 16);
  let openedUnderFidSalt = false;
  try {
    frames.openFrame({
      encKey: keys.encKey,
      aad: { seq: rawFromKotlin.slice.seq, fid },
      salt: fidDerivedSalt,
      sealed: rawFromKotlin.sealed,
    });
    openedUnderFidSalt = true;
  } catch {
    openedUnderFidSalt = false;
  }
  ok(
    'the old hidden-salt convention (salt = the first 4 bytes of fid) cannot open the Kotlin peer’s frame',
    openedUnderFidSalt === false,
    `fid ${fid} would have implied salt ${frames.encodeSalt(fidDerivedSalt)}, the envelope carried ${wireSalt}`,
  );
  ok('…and the fid-derived salt really is a different salt', frames.encodeSalt(fidDerivedSalt) !== wireSalt);

  const tsReceived = received.filter((frame) => {
    try {
      return frames.encodeFrame(frame) === sentEvent.plaintext;
    } catch {
      return false;
    }
  });
  ok(
    'the TypeScript transport also delivered the Kotlin frame to its API layer',
    tsReceived.length === 1,
    tsReceived.length === 1
      ? `decoded frame ${tsReceived[0].type}/${tsReceived[0].id} from ${tsReceived[0].from}, re-encodes to the same bytes`
      : `delivered ${tsReceived.length} copies of the Kotlin peer’s frame`,
  );
  ok(
    'the Kotlin peer and the TypeScript transport agree on the frame id and sender',
    tsReceived.length === 1 && tsReceived[0].id === sentEvent.id && tsReceived[0].from === kotlinOnline.peer,
    `id ${sentEvent.id} from ${kotlinOnline.peer}`,
  );
  const before = received.length;
  // The frame type both sides carried (`interop`) is not a type either client dispatches: the
  // Kotlin peer decodes it (the crypto layers agree) and then refuses it at the dispatch layer,
  // which is the deny-by-default behaviour §6 asks for and worth pinning here.
  ok(
    'a frame of a type the client does not dispatch is still decoded and then refused as unknown',
    kotlinEvents().some((event) => event.event === 'refused' && event.reason === 'unknown-type'),
    kotlinEvents().filter((event) => event.event === 'refused').map((event) => event.reason).join(', '),
  );

  // ---- replay, in both directions ------------------------------------------------------------
  //
  // The Kotlin peer re-posts its own slices verbatim (its `replayed` event); the TypeScript side
  // must refuse the second delivery as a replay and not hand it to the API again.
  await bounded(
    'the Kotlin peer’s replay',
    waitFor('the Kotlin peer’s replay', () => kotlinEvents().find((event) => event.event === 'replayed'), 20_000),
    25_000,
  );
  await bounded(
    'the TypeScript side to refuse the replay',
    waitFor('the TypeScript side to refuse the replay', () => (transport.status.inboundRefused.replay >= 1 ? true : null), 15_000).catch((error) => {
      throw new Error(`${error.message}; inboundRefused=${JSON.stringify(transport.status.inboundRefused)}`);
    }),
    20_000,
  );
  ok(
    'a replay from the Kotlin peer is refused on the TypeScript side',
    transport.status.inboundRefused.replay >= 1 && received.length === before,
    `inboundRefused.replay=${transport.status.inboundRefused.replay}, frames delivered unchanged (${received.length})`,
  );

  // …and the same the other way: the driver re-posts the exact slice lines the TypeScript peer
  // sealed, and the Kotlin peer has to refuse the second delivery.
  const replayable = frames.sealAndSlice({
    encKey: keys.encKey,
    aad: { seq: 4211, fid: frames.newFrameId() },
    salt: 0x1a2b3c4d,
    plaintext: frames.encodeFrame({
      v: frames.FRAME_VERSION,
      type: 'interop',
      id: frames.newFrameId(),
      from: tsPeer,
      to: '*',
      body: { payload: `REPLAY-${crypto.randomBytes(6).toString('hex')}` },
    }),
  });
  const postSlices = async (slices) => {
    for (const slice of slices) {
      await fetch(`${relayUrl}/v1/room/${roomId}/up?peer=${tsPeer}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: frames.encodeSlice(slice),
      });
    }
  };
  await bounded('posting the replayable frame', postSlices(replayable), 10_000);
  await bounded(
    'the Kotlin peer to open it once',
    waitFor('the Kotlin peer to open the driver’s frame', () => kotlinEvents().filter((event) => event.event === 'frame' && event.to === '*' && event.from === tsPeer && event.plaintext?.includes('REPLAY-')).length >= 1, 15_000),
    20_000,
  );
  const openedBeforeReplay = kotlinEvents().filter((event) => event.event === 'frame').length;
  await bounded('posting the replay', postSlices(replayable), 10_000);
  await bounded(
    'the Kotlin peer to refuse the replay',
    waitFor(
      'the Kotlin peer to refuse the replay',
      () => kotlinEvents().some((event) => event.event === 'refused' && event.reason === 'REPLAYED'),
      15_000,
    ).catch((error) => {
      throw new Error(`${error.message}\nkotlin stdout:\n${kotlin.lines.join('\n')}`);
    }),
    20_000,
  );
  ok(
    'a replay from the driver is refused on the Kotlin side',
    kotlinEvents().some((event) => event.event === 'refused' && event.reason === 'REPLAYED') &&
      kotlinEvents().filter((event) => event.event === 'frame').length === openedBeforeReplay,
    `refusals: ${kotlinEvents().filter((event) => event.event === 'refused').map((event) => event.reason).join(', ')}`,
  );

  // ---- a neighbouring salt: the same sealed bytes, an envelope that lies about `s` -----------
  //
  // Two frames from the driver, both of them one logical frame of the same plaintext shape:
  //   - the control, sealed under `controlSalt` and stamped with it — it must open;
  //   - the liar, sealed under `otherSalt` but stamped with `controlSalt` — the receiver reads the
  //     stamp, builds the wrong nonce and must refuse it as tampering.
  // The pair is what makes "the receiver used `s`" a measurement: the control proves the bytes and
  // the AAD are fine, so the liar can only be failing on the salt.
  const controlSalt = 0x5e6f7a8b;
  const otherSalt = 0x5e6f7a8c;
  const saltPlaintext = frames.encodeFrame({
    v: frames.FRAME_VERSION,
    type: 'interop',
    id: frames.newFrameId(),
    from: tsPeer,
    to: '*',
    body: { payload: `SALT-${crypto.randomBytes(6).toString('hex')}` },
  });

  const controlAad = { seq: 4212, fid: frames.newFrameId() };
  const control = frames.sliceSealed(
    frames.sealFrame({ encKey: keys.encKey, aad: controlAad, salt: controlSalt, plaintext: saltPlaintext }),
    controlAad,
    controlSalt,
  );
  await bounded('posting the control frame', postSlices(control), 10_000);
  const controlOpened = await bounded(
    'the Kotlin peer to open the control frame',
    waitFor('the Kotlin peer to open the control frame', () => kotlinEvents().filter((event) => event.event === 'frame' && event.plaintext === saltPlaintext).length, 15_000).catch((error) => {
      throw new Error(`${error.message}\nkotlin stdout:\n${kotlin.lines.join('\n')}`);
    }),
    20_000,
  );
  ok(
    'the control frame under a known salt opens (so the next assertion is about the salt, not the bytes)',
    controlOpened === 1,
    `salt ${frames.encodeSalt(controlSalt)}`,
  );

  const liarAad = { seq: 4213, fid: frames.newFrameId() };
  const liar = frames.sliceSealed(
    frames.sealFrame({ encKey: keys.encKey, aad: liarAad, salt: otherSalt, plaintext: saltPlaintext }),
    liarAad,
    controlSalt, // the envelope claims a salt the frame was NOT sealed with
  );
  const framesBeforeSaltCase = kotlinEvents().filter((event) => event.event === 'frame').length;
  await bounded('posting the salt-mismatched frame', postSlices(liar), 10_000);
  const tamper = await bounded(
    'the Kotlin peer to refuse the salt-mismatched frame',
    waitFor(
      'the Kotlin peer to refuse the salt-mismatched frame',
      () => kotlinEvents().find((event) => event.event === 'refused' && event.reason === 'TAMPERED'),
      15_000,
    ).catch((error) => {
      throw new Error(`${error.message}\nkotlin stdout:\n${kotlin.lines.join('\n')}`);
    }),
    20_000,
  );
  ok(
    'a frame whose envelope claims a neighbouring salt does not open',
    tamper.reason === 'TAMPERED' && kotlinEvents().filter((event) => event.event === 'frame').length === framesBeforeSaltCase,
    `sealed under ${frames.encodeSalt(otherSalt)}, stamped ${frames.encodeSalt(controlSalt)}: ${short(tamper.detail, 100)}`,
  );

  // ---- the Kotlin peer’s own salt nudge, refused on the TypeScript side ----------------------
  await bounded(
    'the Kotlin peer’s salt nudge',
    waitFor('the Kotlin peer’s salt nudge', () => kotlinEvents().find((event) => event.event === 'saltedNudge'), 20_000),
    25_000,
  );
  await bounded(
    'the TypeScript side to refuse the nudged salt',
    waitFor(
      'the TypeScript side to refuse the nudged salt',
      () => (transport.status.inboundRefused.auth >= 1 ? true : null),
      15_000,
    ).catch((error) => {
      throw new Error(`${error.message}; inboundRefused=${JSON.stringify(transport.status.inboundRefused)}`);
    }),
    20_000,
  );
  ok(
    'the Kotlin peer’s frame re-stamped with a neighbouring salt is refused on the TypeScript side',
    transport.status.inboundRefused.auth >= 1,
    `inboundRefused=${JSON.stringify(transport.status.inboundRefused)}`,
  );

  // ---- the Kotlin peer leaves cleanly --------------------------------------------------------
  //
  // The harness says "I have finished asserting" by closing the peer's stdin; the peer stops the
  // transport and exits 0. That is the only honest proof that no thread and no timer outlived it.
  kotlin.child.stdin.end();
  await bounded(
    'the Kotlin peer to exit',
    waitFor('the Kotlin peer to exit', () => (kotlin.exited ? true : null), 20_000),
    25_000,
  );
  const exitEvent = kotlinEvents().find((event) => event.event === 'exit');
  ok('the Kotlin peer left on its own and cleanly', kotlin.exited && kotlin.code === 0 && Boolean(exitEvent), `exit code ${kotlin.code}, ${exitEvent?.reason ?? 'no exit event'}`);

  transport.stop();
  stopRawReader.abort();

  console.log('');
  console.log(`[ok  ] room ${roomId}: kotlin peer ${kotlinOnline.peer} (salt ${kotlinOnline.salt}) ↔ ts peer ${tsPeer}, ` +
    `${received.length} frame(s) delivered to the TypeScript API`);
  console.log(
    failures === 0
      ? `PASS remote-interop: ${checks}/${checks} checks — the Kotlin and TypeScript transports exchanged sealed frames through the real relay, byte for byte, opening each other’s salt from the envelope’s ` +
          '`s`'
      : `FAIL remote-interop: ${failures} of ${checks} checks failed`,
  );
} catch (error) {
  failures += 1;
  console.log('');
  console.log(`FAIL remote-interop: ${error?.message ?? error}`);
  for (const record of children) {
    if (record.lines.length === 0 && record.stderr.length === 0) continue;
    console.log(`       -- ${record.name} stdout (last 25 lines) --`);
    // Truncated: the Kotlin peer prints whole frame plaintexts, and a failure dump has to stay
    // readable enough that the divergence is visible rather than buried in 90 KB of payload.
    for (const line of record.lines.slice(-25)) console.log(`       ${short(line, 400)}`);
    if (record.stderr.length) {
      console.log(`       -- ${record.name} stderr (last 15 lines) --`);
      for (const line of record.stderr.slice(-15)) console.log(`       ${short(line, 400)}`);
    }
  }
} finally {
  try {
    transport?.stop?.();
  } catch {
    /* already stopped */
  }
  try {
    stopRawReader?.abort?.();
  } catch {
    /* already aborted */
  }
  killEverything();
  // Give the OS a moment to reap, then make sure nothing this script started can outlive it.
  await sleep(400);
  killEverything();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* a temp file that could not be removed is not a test failure */
  }
  if (failures > 0) process.exitCode = 1;
}
