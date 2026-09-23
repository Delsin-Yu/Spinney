/*
 * relay-acceptance — the room transport against a real relay stub, as a dev-only
 * acceptance run (not a build guard, and not shipped in the `.vsix`).
 *
 * `src/remote/relayClient.ts` is the one module in the remote-control feature that owns a
 * socket, a clock and a queue at the same time, and every one of its properties is a
 * *failure* property: it must not be taken down by a hostile or broken relay, it must not
 * burst into the relay's rate limit, it must not let a peer that stopped reading delay
 * the window that owns the session, and it must rebuild itself with fresh key material
 * after a drop. None of that is visible in the pure-module guard (`tools/check-remote.js`
 * pins the crypto; this one pins the transport).
 *
 * So it does not stub the transport out. It stands up a **real relay** on an ephemeral
 * loopback port (`node:http`, no dependency) that speaks the four routes of
 * `remote/PROTOCOL.md` §7 — `join`, `down` (SSE), `up`, and the `: ping` comment — and
 * then drives the **real compiled** transport (`out/remote/relayClient.js`) against it,
 * with the real key schedule (`out/remote/rooms.js`) and the real frame envelope
 * (`out/remote/frames.js`). Both ends seal and open with the same `encKey`, so what the
 * stub decodes is what a peer in the room would decode.
 *
 * What it pins, case by case:
 *
 *   1. a clean join: `connecting` → `online`, the peer id is the 8 lowercase hex
 *      characters §2 promises, the relay saw the *derived* room id in the path, and
 *      `start()` twice is one join;
 *   2. the app-level `ping` arrives within one heartbeat while the room is quiet, repeats
 *      every heartbeat, and the relay's `: ping` comment lines are ignored rather than
 *      refused;
 *   3. an outbound frame arrives at the stub, opens under the same key, and carries the
 *      right `type`/`to`/`from`/`body` — including §7's seven-key slice line, in order,
 *      with `s` in position 3 and equal to the nonce's last 4 bytes (and a frame that
 *      needs a different salt does *not* open);
 *   4. the connection salt is one value per connection, named by the envelope's own `s`,
 *      and a fresh one per reconnect;
 *   5. an inbound frame arrives at `onFrame` with the same plaintext, addressed to us or
 *      broadcast, and one addressed to somebody else is ignored and not refused;
 *   6. a frame **large enough to need a dozen slices** survives the slice/reassemble path
 *      end to end, and two frames **interleaved** slice by slice both arrive intact (the
 *      reassembler is keyed by `fid`, and this is what proves it);
 *   7. a **replayed** slice set is refused by the replay window, a **tampered** byte
 *      fails as auth, a **malformed** line is refused as malformed — each counted as its
 *      own cause, each without a second delivery to `onFrame`, and none of them able to
 *      take the connection down; a slice whose **`s` disagrees with its frame** is
 *      refused by the reassembler (as a framing refusal, not as an auth failure) instead
 *      of being spliced into a frame; and the replay window is one per **sender salt**:
 *      two senders numbering from `seq` 1 both arrive, a sender that has sent 70 frames
 *      does not push a fresher sender out of its own window, an unauthenticated frame
 *      under a real salt does not burn that sender's window, and a genuine replay from
 *      the *same* sender is still refused (this last group is the regression case for the
 *      "a room of three renders one publisher" defect);
 *   8. a 429 is retried with a short backoff and the frame still arrives whole;
 *   9. **pacing**: a burst of frames is counted at the stub, and no one-second window
 *      holds more than the rate plus the burst allowance;
 *  10. **backpressure**: a peer that stops answering fills the bounded queue, `send`
 *      still returns immediately, the drops are counted, the event loop stays
 *      responsive, and the queue drains once the peer reads again;
 *  11. **reconnect**: the stub ends the down stream mid-flight, and the transport reports
 *      `backoff` with a reason and a `retryAt`, then joins again for a **new peer id and
 *      a new connection salt** — the silent crypto bug this case exists to catch — and a
 *      frame queued while it was offline is never replayed;
 *  12. a relay that stops writing (socket open, no bytes) is noticed by the
 *      silent-stream watchdog, which is the same clock that keeps undici's 300 s body
 *      timeout away;
 *  13. a non-2xx `join` is a status and never a throw: a 404 (the relay's answer to a
 *      malformed room id) is an `error` that is not retried, a 5xx is a `backoff` with a
 *      `retryAt`, and the scheduled retry joins;
 *  14. `stop()` releases the stream, cancels every timer, leaves no post behind, and
 *      `start()` after `stop()` works — and the run **exits on its own**, which is the
 *      only honest proof that no timer outlived the transport.
 *
 * Every await is bounded: a case that never settles fails the run instead of hanging it,
 * and the script deliberately never calls `process.exit(0)` on the way out.
 *
 * Needs `out/` (run `npm run compile` first: it requires the compiled modules).
 *
 * Run: node tools/relay-acceptance.js
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'remote');
for (const name of ['relayClient', 'frames', 'rooms']) {
  const file = path.join(OUT, `${name}.js`);
  if (!fs.existsSync(file)) {
    console.error(`relay-acceptance: out/remote/${name}.js is missing — run \`npm run compile\` first.`);
    process.exit(1);
  }
}
const relay = require(path.join(OUT, 'relayClient.js'));
const frames = require(path.join(OUT, 'frames.js'));
const rooms = require(path.join(OUT, 'rooms.js'));

const { RelayTransport, HEARTBEAT_MS, MAX_POST_PER_SECOND, MAX_POST_BURST, MAX_QUEUE_BYTES, RECONNECT_MAX_MS } = relay;

/** The room token. Fixed, so the run's room id and keys are reproducible. */
const TOKEN = 'relay acceptance token — 0011223344556677';
/** The heartbeat every case but one drives the transport with; small so the run is short. */
const HB = 400;
/** How often the stub writes its `: ping` comment. The relay's own default is 15 s. */
const COMMENT_MS = 100;

const problems = [];
let checks = 0;

/** One assertion. Both lines are printed, because a guard that only speaks up when it fails cannot be told apart from one that never ran. */
function ok(label, cond, detail) {
  checks += 1;
  console.log(`  [${cond ? 'ok  ' : 'FAIL'}] ${label}${detail === undefined ? '' : `  (${detail})`}`);
  if (!cond) {
    problems.push(label);
  }
  return cond;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A case that never settles must fail the gate rather than hang it. */
class Timeout extends Error {}
async function waitFor(label, check, timeoutMs = 5000, step = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = check();
    } catch {
      value = undefined;
    }
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      ok(`${label} (within ${timeoutMs} ms)`, false, 'timed out');
      throw new Timeout(label);
    }
    await sleep(step);
  }
}

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
const activeTimers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;

// ---------------------------------------------------------------------------------------
// The relay stub: the four routes of remote/PROTOCOL.md §7, on an ephemeral port
// ---------------------------------------------------------------------------------------
/**
 * A real HTTP relay, small but not fake: it mints peer ids, validates that the caller
 * joined, fans a verbatim `up` body out to the other peers as one SSE `data:` line, writes
 * the `: ping` comment, and can be told to misbehave in the specific ways the transport
 * claims to survive (429, no answer at all, a stream that ends, a stream that goes silent).
 *
 * Per-peer state, not global, because several transports are in this room at once and a
 * 429 forced for one of them must not be eaten by another's heartbeat.
 */
function startStub(encKey) {
  const state = {
    joinRoomIds: [],
    joins: [],
    joinAttempts: 0,
    ups: [],
    downs: new Map(),
    comments: 0,
    joinStatuses: [],
    forced: new Map(),
    stalled: new Set(),
    held: [],
    silenced: new Set(),
    sockets: new Set(),
    /**
     * The stub's own connection salt — one peer, one connection — stamped onto every
     * slice it sends as `s` (`remote/PROTOCOL.md` §4/§7). Drawn from a CSPRNG once, never
     * derived: a reused (key, nonce) pair in GCM is unrecoverable.
     */
    salt: randomBytes(4).readUInt32BE(0),
    /** Per-sender frame counters, keyed by the salt the sender seals under. */
    senders: new Map(),
  };

  const json = (res, status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };
  const readBody = (req) =>
    new Promise((resolve) => {
      const parts = [];
      req.on('data', (chunk) => parts.push(chunk));
      req.on('end', () => resolve(Buffer.concat(parts)));
      req.on('error', () => resolve(Buffer.concat(parts)));
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const peer = url.searchParams.get('peer');

    if (req.method === 'GET' && parts[0] === 'healthz') {
      json(res, 200, { ok: true, rooms: 1, peers: state.joins.length, uptimeMs: 1 });
      return;
    }
    if (parts[0] !== 'v1' || parts[1] !== 'room' || parts.length !== 4) {
      json(res, 404, { error: 'no-such-route' });
      return;
    }
    state.joinRoomIds.push(parts[2]);

    if (req.method === 'POST' && parts[3] === 'join') {
      await readBody(req);
      state.joinAttempts += 1;
      const forced = state.joinStatuses.shift();
      if (forced && forced !== 200) {
        json(res, forced, { error: 'forced' });
        return;
      }
      const minted = randomBytes(4).toString('hex');
      state.joins.push({ at: Date.now(), peer: minted });
      json(res, 200, { peer: minted });
      return;
    }

    if (req.method === 'GET' && parts[3] === 'down') {
      if (!state.joins.some((join) => join.peer === peer)) {
        json(res, 404, { error: 'unknown-peer' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.flushHeaders();
      res.write(': ready\n\n');
      const entry = { peer, res, timer: null, comments: 0 };
      state.downs.set(peer, entry);
      if (!state.silenced.has(peer)) {
        entry.timer = setInterval(() => {
          if (res.writableEnded) {
            return;
          }
          entry.comments += 1;
          state.comments += 1;
          res.write(': ping\n\n');
        }, COMMENT_MS);
      }
      res.on('close', () => {
        clearInterval(entry.timer);
        entry.timer = null;
        if (state.downs.get(peer) === entry) {
          state.downs.delete(peer);
        }
      });
      return;
    }

    if (req.method === 'POST' && parts[3] === 'up') {
      const raw = await readBody(req);
      state.ups.push({ at: Date.now(), peer, body: raw.toString('utf8') });
      if (state.stalled.has(peer)) {
        // Read, never answered: exactly what a peer (or a link) that cannot keep up
        // looks like from the sender's side.
        state.held.push({ peer, res });
        return;
      }
      const queue = state.forced.get(peer);
      const forced = queue && queue.length ? queue.shift() : 0;
      if (forced) {
        json(res, forced, { error: 'forced' });
        return;
      }
      json(res, 202, { ok: true });
      return;
    }

    json(res, 404, { error: 'no-such-route' });
  });

  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        joinCount: () => state.joins.length,
        joinAttempts: () => state.joinAttempts,
        upCount: () => state.ups.length,
        upsFrom: (index) => state.ups.slice(index),
        heldCount: (peer2) => state.held.filter((entry) => entry.peer === peer2).length,
        downPeers: () => [...state.downs.keys()],
        async waitForDown(peer2, ms = 3000) {
          await waitFor(`the stub has a down stream for ${peer2}`, () => state.downs.has(peer2), ms);
        },
        /** Stop writing on this peer's stream without closing the socket: a relay that went quiet. */
        silence(peer2) {
          state.silenced.add(peer2);
          const entry = state.downs.get(peer2);
          if (entry) {
            clearInterval(entry.timer);
            entry.timer = null;
          }
        },
        /** End this peer's stream mid-flight, which is what a relay restart looks like. */
        endDown(peer2) {
          const entry = state.downs.get(peer2);
          if (entry) {
            clearInterval(entry.timer);
            entry.timer = null;
            entry.res.end();
          }
        },
        /** Answer the next `n` POSTs from this peer with `status` (429 in this run). */
        force(peer2, status, n = 1) {
          const queue = state.forced.get(peer2) ?? [];
          for (let i = 0; i < n; i++) {
            queue.push(status);
          }
          state.forced.set(peer2, queue);
        },
        /** Stop answering this peer's POSTs at all, and record what was left hanging. */
        stall(peer2) {
          state.stalled.add(peer2);
        },
        release(peer2) {
          state.stalled.delete(peer2);
          const mine = state.held.filter((entry) => entry.peer === peer2);
          state.held = state.held.filter((entry) => entry.peer !== peer2);
          for (const entry of mine) {
            if (!entry.res.writableEnded) {
              json(entry.res, 202, { ok: true });
            }
          }
          return mine.length;
        },
        /**
         * Seal one logical frame the way a peer would, and hand back its wire lines.
         *
         * `saltHex` names the *sender*: every peer in a room seals under its own random salt
         * and numbers its own frames from `seq` 1, which is what a receiving side has to key
         * its replay window on. The default is this stub's own salt, so the single-sender
         * cases read the same as before.
         */
        seal(envelope, saltHex = frames.encodeSalt(state.salt)) {
          const sender = state.senders.get(saltHex) ?? { salt: frames.decodeSalt(saltHex), seq: 0 };
          sender.seq += 1;
          state.senders.set(saltHex, sender);
          // Opaque and per-frame: `fid` is a reassembly label and derives nothing, least
          // of all the salt — that is what `s` is for.
          const fid = frames.newFrameId();
          const aad = { seq: sender.seq, fid };
          const sealed = frames.sealFrame({ encKey, aad, salt: sender.salt, plaintext: frames.encodeFrame(envelope) });
          // `sliceSealed` takes the connection salt as its third argument and stamps it
          // onto every slice as `s`; the receiver builds the nonce from that field
          // (`remote/PROTOCOL.md` §4, §7). `sender.salt` is the same value the seal above
          // used, which is the point — one nonce per logical frame.
          const slices = frames.sliceSealed(sealed, aad, sender.salt);
          return {
            envelope,
            fid,
            saltHex,
            seq: sender.seq,
            salt: sender.salt,
            slices,
            lines: slices.map((slice) => frames.encodeSlice(slice)),
          };
        },
        /** One raw SSE line to one peer, as the `data:` payload of an event. */
        writeLine(peer2, payload) {
          this.writeRaw(peer2, `data: ${payload}`);
        },
        /** One line verbatim — a comment, or a field the contract never defined. */
        writeRaw(peer2, text) {
          const entry = state.downs.get(peer2);
          if (!entry || entry.res.writableEnded) {
            throw new Error(`the stub has no open down stream for ${peer2}`);
          }
          entry.res.write(`${text}\n\n`);
        },
        /** One comment line (`: ping`) — what the relay writes every 15 s. */
        writeComment(peer2, text = 'ping') {
          this.writeRaw(peer2, `: ${text}`);
        },
        writeAll(peer2, spec) {
          for (const line of spec.lines) {
            this.writeLine(peer2, line);
          }
        },
        push(peer2, envelope) {
          const spec = this.seal(envelope);
          this.writeAll(peer2, spec);
          return spec;
        },
        sendRaw(peer2, payload) {
          this.writeLine(peer2, payload);
        },
        sendField(peer2, text) {
          this.writeRaw(peer2, text);
        },
        async close() {
          for (const entry of [...state.downs.values()]) {
            clearInterval(entry.timer);
            entry.res.destroy();
          }
          state.downs.clear();
          for (const socket of state.sockets) {
            socket.destroy();
          }
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------------------
// The stub side of the wire: decode what the transport posted, independently
// ---------------------------------------------------------------------------------------
/**
 * Every frame the stub received, decoded from the wire with the room key — the same
 * `decodeSlice` → `FrameReassembler` → `openFrame` → `decodeFrame` order a peer uses, so
 * a slice line the transport got wrong shows up here as a decode failure rather than as a
 * passing test.
 */
function receivedFrames(stub, encKey) {
  const byFid = new Map();
  for (const up of stub.state.ups) {
    let slice;
    try {
      slice = frames.decodeSlice(up.body);
    } catch (err) {
      byFid.set(`bad:${up.at}`, { error: err, peer: up.peer, raw: up.body, at: up.at });
      continue;
    }
    const entry = byFid.get(slice.fid) ?? { slices: [], peer: up.peer, at: up.at, raw: up.body };
    entry.slices.push(slice);
    byFid.set(slice.fid, entry);
  }
  const out = [];
  for (const [fid, entry] of byFid) {
    if (entry.error) {
      out.push(entry);
      continue;
    }
    let sealed = null;
    let failure = null;
    try {
      const reassembler = new frames.FrameReassembler();
      for (const slice of entry.slices) {
        sealed = reassembler.push(slice) || sealed;
      }
    } catch (err) {
      failure = err;
    }
    if (failure || !sealed) {
      out.push({ fid, peer: entry.peer, at: entry.at, raw: entry.raw, error: failure ?? new Error('incomplete') });
      continue;
    }
    try {
      // The nonce's other half comes off the wire: `decodeSalt(slice.s)`, the sender's
      // own salt field. Nothing here reads a salt out of `fid`.
      const salt = frames.decodeSalt(entry.slices[0].s);
      const text = frames.openFrame({
        encKey,
        aad: { seq: entry.slices[0].seq, fid },
        salt,
        sealed,
      });
      out.push({
        fid,
        peer: entry.peer,
        at: entry.at,
        raw: entry.raw,
        slice: entry.slices[0],
        slices: entry.slices.length,
        salt,
        saltHex: entry.slices[0].s,
        frame: frames.decodeFrame(text),
      });
    } catch (err) {
      out.push({ fid, peer: entry.peer, at: entry.at, raw: entry.raw, error: err });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The status snapshot shape the service codes against, asserted rather than assumed. */
function isStatusShaped(status) {
  return (
    status &&
    ['idle', 'connecting', 'online', 'backoff', 'error'].includes(status.phase) &&
    (status.peerId === null || typeof status.peerId === 'string') &&
    typeof status.dropped === 'number' &&
    status.inboundRefused &&
    ['malformed', 'slice', 'size', 'replay', 'auth', 'envelope'].every((kind) => typeof status.inboundRefused[kind] === 'number') &&
    (status.retryAt === undefined || typeof status.retryAt === 'number') &&
    (status.error === undefined || typeof status.error === 'string')
  );
}

/** Flip one base64 character, keeping it inside the alphabet: the same length, different bytes. */
function tamper(line) {
  const parsed = JSON.parse(line);
  const at = 8;
  const ch = parsed.b[at];
  parsed.b = `${parsed.b.slice(0, at)}${ch === 'A' ? 'B' : 'A'}${parsed.b.slice(at + 1)}`;
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------
let finished = false;
process.on('exit', (code) => {
  // A script that ends while an await is still pending exits 0 with no output at all —
  // which is exactly how a leaked timer or a deadlocked queue would look.
  if (!finished && code === 0) {
    console.log('\nFAIL relay-acceptance: the run ended early — something never resolved');
    process.exitCode = 1;
  }
});

(async () => {
  // One PBKDF2 per run: the transport takes the key, not the token, and this run uses the
  // real schedule so the room id on the wire is a real routing credential.
  const started = Date.now();
  const keys = rooms.deriveRoom(TOKEN);
  const stub = await startStub(keys.encKey);
  const timerBaseline = activeTimers();
  console.log(`-- the room: ${keys.roomId} on ${stub.url} (derived in ${Date.now() - started} ms) --`);
  ok('the derivation gives a 26-character base32 room id', /^[A-Z2-7]{26}$/.test(keys.roomId), keys.roomId);
  ok('HEARTBEAT_MS is still the frozen 20 s constant', HEARTBEAT_MS === 20000, `${HEARTBEAT_MS} ms`);
  ok('MAX_POST_PER_SECOND is still 50', MAX_POST_PER_SECOND === 50, String(MAX_POST_PER_SECOND));
  ok('the queue bound admits one maximal frame', MAX_QUEUE_BYTES === frames.FRAME_MAX_BYTES && MAX_QUEUE_BYTES === 16777216, String(MAX_QUEUE_BYTES));
  ok('the burst allowance is a small, positive number', MAX_POST_BURST >= 1 && MAX_POST_BURST <= 32, String(MAX_POST_BURST));
  ok('the reconnect cap is finite and above the first step', RECONNECT_MAX_MS >= 5000, `${RECONNECT_MAX_MS} ms`);

  // The four transports this run needs. They differ only in the seams they set: the
  // heartbeat is 400 ms so the whole run is seconds, the pacing rate is the contract's
  // 50, and the two link-failure cases get a transport whose heartbeat cannot get in the
  // way of what they are measuring.
  const statuses = [];
  const received = [];
  let onlineAt = 0;
  const make = (overrides) =>
    new RelayTransport({
      relayUrl: stub.url,
      roomId: keys.roomId,
      encKey: keys.encKey,
      deviceId: 'device-0000000000000000',
      heartbeatMs: HB,
      onFrame: (frame) => received.push(frame),
      onStatus: (status) => {
        statuses.push(status);
        if (status.phase === 'online' && onlineAt === 0) {
          onlineAt = Date.now();
        }
      },
      ...overrides,
    });
  const main = make({});
  const rateLimited = make({ heartbeatMs: 60000 });
  const stalled = make({ heartbeatMs: 60000, maxPostPerSecond: 200, maxQueueBytes: 16384 });
  const quiet = make({});

  const onlineOf = (transport, label) =>
    waitFor(label, () => (transport.status.phase === 'online' ? transport.status : null), 6000).then((status) => {
      onlineAt = 0;
      return status.peerId;
    });

  // ---------------------------------------------------------------- 1. a clean join
  console.log('-- 1. a clean join: connecting → online, with the peer id the relay minted --');
  main.start();
  const onlineOne = await waitFor('the transport goes online', () => (main.status.phase === 'online' ? main.status : null), 6000);
  ok('start() published `connecting` before `online`', statuses.some((s) => s.phase === 'connecting') && statuses.findIndex((s) => s.phase === 'online') > 0, statuses.map((s) => s.phase).join(' → '));
  ok('the relay saw exactly one join', stub.joinAttempts() === 1, `${stub.joinAttempts()} join request(s)`);
  ok('the join used the derived room id as the URL path segment', stub.state.joinRoomIds.every((id) => id === keys.roomId), stub.state.joinRoomIds[0]);
  ok('the peer id is the 8 lowercase hex characters §2 promises', /^[0-9a-f]{8}$/.test(onlineOne.peerId), onlineOne.peerId);
  ok('status.peerId and get peerId() agree', main.peerId === onlineOne.peerId && main.status.peerId === onlineOne.peerId, String(main.peerId));
  ok('online carries no retryAt, no error, no drops', onlineOne.retryAt === undefined && onlineOne.error === undefined && onlineOne.dropped === 0 && sum(onlineOne.inboundRefused) === 0);
  ok('every status snapshot has the shape the service codes against', statuses.every(isStatusShaped), `${statuses.length} snapshot(s)`);
  await stub.waitForDown(onlineOne.peerId);
  ok('the transport subscribed to the down stream', stub.downPeers().includes(onlineOne.peerId));

  const peerOne = onlineOne.peerId;
  main.start();
  await sleep(150);
  ok('start() twice is a no-op', stub.joinAttempts() === 1 && main.peerId === peerOne, `${stub.joinAttempts()} join request(s)`);

  // ---------------------------------------------------------------- 2. the heartbeat
  console.log('-- 2. the app-level ping, while the room is otherwise quiet --');
  const refusedBeforePing = { ...main.status.inboundRefused };
  const pings = () => receivedFrames(stub, keys.encKey).filter((f) => f.frame && f.frame.type === 'ping');
  const firstPing = await waitFor('a ping frame reaches the stub', () => pings().find((p) => p.at >= onlineAt), HB * 4 + 1000);
  ok(
    `the ping arrived within one heartbeat of coming online`,
    firstPing.at - onlineAt <= HB + 400,
    `${firstPing.at - onlineAt} ms (heartbeat ${HB} ms)`,
  );
  ok('the ping is `{type:"ping", to:"*", body:{}}`', firstPing.frame.to === '*' && firstPing.frame.body !== null && typeof firstPing.frame.body === 'object' && Object.keys(firstPing.frame.body).length === 0, JSON.stringify(firstPing.frame));
  ok('the ping is sealed by this connection (its `from` is our peer id)', firstPing.frame.from === peerOne, firstPing.frame.from);
  const secondPing = await waitFor('a second ping', () => pings().filter((p) => p.at > firstPing.at)[0], HB * 4 + 1000);
  ok('the ping repeats every heartbeat', secondPing.at - firstPing.at <= HB * 1.5 + 200, `${secondPing.at - firstPing.at} ms apart`);
  ok(
    'the relay\'s `: ping` comments were ignored, not refused',
    JSON.stringify(main.status.inboundRefused) === JSON.stringify(refusedBeforePing) && stub.state.comments > 3,
    `${stub.state.comments} comment(s) seen, refusals unchanged`,
  );

  // ---------------------------------------------------------------- 3. outbound
  console.log('-- 3. an outbound frame arrives at the stub and opens under the same key --');
  const helloBody = { deviceId: 'device-0000000000000000', deviceName: 'acceptance-host', instanceId: 'pid-1', workspace: 'D:\\Repos\\MinimalHost', appVersion: '0.1.0', proto: 1 };
  ok('send() reports the frame as queued', main.send({ type: 'hello', to: '*', body: helloBody }) === true);
  const hello = await waitFor('the hello reaches the stub', () => receivedFrames(stub, keys.encKey).find((f) => f.frame && f.frame.type === 'hello' && f.frame.body && f.frame.body.instanceId === 'pid-1'));
  ok('the stub decoded it with the room key (one key schedule, both ends)', !!hello.frame);
  ok('  … the `from` is this connection\'s peer id', hello.frame.from === peerOne, hello.frame.from);
  ok('  … `to` is the broadcast', hello.frame.to === '*');
  ok('  … the body travelled byte for byte', JSON.stringify(hello.frame.body) === JSON.stringify(helloBody));
  ok('  … the correlation id is 16 hex characters, and not the framing id', /^[0-9a-f]{16}$/.test(hello.frame.id) && hello.frame.id !== hello.fid, `${hello.frame.id} vs ${hello.fid}`);
  ok('  … a small frame is one slice', hello.slices === 1, `${hello.slices} slice(s)`);
  ok('  … the wire line is §7\'s seven keys, in order', Object.keys(JSON.parse(hello.raw)).join(',') === 'v,seq,s,fid,idx,last,b', Object.keys(JSON.parse(hello.raw)).join(','));
  ok('  … and the AAD facts it carries are the slice\'s own', hello.slice.v === frames.FRAME_VERSION && hello.slice.idx === 0 && hello.slice.last === true);
  ok('  … `s` is 8 lowercase hex characters, in position 3', /^[0-9a-f]{8}$/.test(hello.slice.s) && frames.encodeSalt(frames.decodeSalt(hello.slice.s)) === hello.slice.s, hello.slice.s);
  ok(
    '  … and `s` really is the nonce\'s last 4 bytes',
    frames.frameNonce(hello.slice.seq, frames.decodeSalt(hello.slice.s)).toString('hex').endsWith(hello.slice.s),
    frames.frameNonce(hello.slice.seq, frames.decodeSalt(hello.slice.s)).toString('hex'),
  );

  const droppedBeforeBadFrame = main.status.dropped;
  let badFrame = null;
  let badThrew = false;
  try {
    badFrame = main.send({ type: '', to: '*', body: {} });
  } catch {
    badThrew = true;
  }
  ok(
    'a frame the contract itself refuses is a counted drop, never a throw into the caller',
    badThrew === false && badFrame === false && main.status.dropped === droppedBeforeBadFrame + 1,
    `returned ${badFrame}, dropped ${main.status.dropped}`,
  );

  // ---------------------------------------------------------------- 4. the connection salt
  console.log('-- 4. one salt per connection, read from the envelope --');
  main.send({ type: 'hello', to: '*', body: { ...helloBody, instanceId: 'pid-2' } });
  const hello2 = await waitFor('the second hello reaches the stub', () => receivedFrames(stub, keys.encKey).find((f) => f.frame && f.frame.body && f.frame.body.instanceId === 'pid-2'));
  ok('the salt travels in the envelope, and the stub opened the frame with it', frames.decodeSalt(hello.slice.s) === hello.salt && frames.encodeSalt(hello.salt) === hello.slice.s, `s=${hello.slice.s}`);
  ok('  … and it is a uint32', Number.isInteger(hello.salt) && hello.salt >= 0 && hello.salt <= 0xffffffff, `0x${hello.salt.toString(16)}`);
  ok('  … the same `s` on the next frame of the same connection', hello.slice.s === hello2.slice.s, `${hello.slice.s} vs ${hello2.slice.s}`);
  ok('  … while the framing ids differ frame to frame and derive nothing', hello.fid !== hello2.fid && !hello.fid.startsWith(hello.slice.s), `${hello.fid} vs ${hello2.fid} (salt ${hello.slice.s})`);
  const peerOneSalts = new Set(receivedFrames(stub, keys.encKey).filter((f) => f.peer === peerOne && !f.error).map((f) => f.salt));
  ok('one connection = one salt, whatever the frame', peerOneSalts.size === 1, `${peerOneSalts.size} salt(s) across ${receivedFrames(stub, keys.encKey).filter((f) => f.peer === peerOne).length} frame(s)`);
  ok(
    'a frame does NOT open under a neighbouring salt (the salt is the nonce, not decoration)',
    (() => {
      const raw = JSON.parse(hello.raw);
      // `>>> 0` matters: a bitwise `^` on a salt whose high bit is set (any salt ≥ 0x80000000,
      // which is half of them) yields a *negative* int32, which `frames.ts` refuses as a
      // malformed salt — a format error, not the auth failure this check is about.
      const neighbour = ((frames.decodeSalt(raw.s) ^ 1) >>> 0);
      try {
        frames.openFrame({ encKey: keys.encKey, aad: { seq: raw.seq, fid: raw.fid }, salt: neighbour, sealed: Buffer.from(raw.b, 'base64') });
        return false;
      } catch (err) {
        return err instanceof frames.FrameAuthError;
      }
    })(),
    'salt ^ 1 is an auth failure',
  );

  // ---------------------------------------------------------------- 5. inbound, addressed
  console.log('-- 5. a frame from the stub arrives at onFrame, verbatim --');
  const mirror = { v: 1, type: 'mirror', id: '0011223344556677', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'delta', text: 'hello from the room' } } };
  stub.push(peerOne, mirror);
  const gotMirror = await waitFor('the broadcast frame arrives', () => received.find((f) => f.id === mirror.id));
  ok('the sealed frame round-tripped exactly', JSON.stringify(gotMirror) === JSON.stringify(mirror), JSON.stringify(gotMirror).slice(0, 80));

  const direct = { ...mirror, id: 'aabbccddeeff0001', to: peerOne, body: { sessionId: 's-1', message: { type: 'delta', text: 'addressed to me' } } };
  const elsewhere = { ...mirror, id: 'aabbccddeeff0002', to: 'deadbeef', body: { sessionId: 's-2', message: { type: 'delta', text: 'somebody else' } } };
  const refusedBeforeRouting = { ...main.status.inboundRefused };
  stub.push(peerOne, direct);
  stub.push(peerOne, elsewhere);
  await waitFor('the frame addressed to us arrives', () => received.find((f) => f.id === direct.id));
  await sleep(200);
  ok('a frame addressed to this peer id is delivered', received.some((f) => f.id === direct.id));
  ok(
    'a frame addressed to another peer is ignored, and not counted as a refusal',
    !received.some((f) => f.id === elsewhere.id) && JSON.stringify(main.status.inboundRefused) === JSON.stringify(refusedBeforeRouting),
    JSON.stringify(main.status.inboundRefused),
  );

  // ---------------------------------------------------------------- 6. slicing, interleaving
  console.log('-- 6. a frame that needs a dozen slices, and two frames interleaved by fid --');
  const bigText = randomBytes(400 * 1024).toString('base64');
  const big = { v: 1, type: 'mirror', id: 'aabbccddeeff0003', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'agentItems', text: bigText } } };
  const bigSpec = stub.push(peerOne, big);
  ok('the stub really cut that frame into a dozen slices', bigSpec.slices.length >= 10, `${bigSpec.slices.length} slices, ${bigSpec.lines[0].length} characters for the longest wire line`);
  const gotBig = await waitFor('the large frame arrives', () => received.find((f) => f.id === big.id), 8000);
  ok('the reassembled plaintext is byte-identical', gotBig.body.message.text === bigText && JSON.stringify(gotBig) === JSON.stringify(big), `${bigText.length} characters`);
  ok(
    '  … and every slice line was under the §8 slice cap and the relay\'s body cap',
    bigSpec.lines.every((line) => JSON.parse(line).b.length <= frames.SLICE_MAX_BASE64 && Buffer.byteLength(line) < 65536),
    `longest line ${Math.max(...bigSpec.lines.map((line) => Buffer.byteLength(line)))} bytes (relay cap 65536)`,
  );

  const interA = { v: 1, type: 'mirror', id: 'aabbccddeeff0004', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'agentItems', text: `${'A'.repeat(100 * 1024)}` } } };
  const interB = { v: 1, type: 'mirror', id: 'aabbccddeeff0005', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'agentItems', text: `${'B'.repeat(100 * 1024)}` } } };
  const specA = stub.seal(interA);
  const specB = stub.seal(interB);
  ok('both interleaved frames need more than one slice', specA.slices.length > 1 && specB.slices.length > 1, `${specA.slices.length} + ${specB.slices.length}`);
  for (let i = 0; i < Math.max(specA.lines.length, specB.lines.length); i += 1) {
    if (specA.lines[i]) {
      stub.writeLine(peerOne, specA.lines[i]);
    }
    if (specB.lines[i]) {
      stub.writeLine(peerOne, specB.lines[i]);
    }
  }
  // The loop writes each pair A[i], B[i], so A's final slice leaves first and A must be
  // handed over first — the interleaving must not have reordered anything within a frame.
  const gotInterA = await waitFor('the first interleaved frame arrives', () => received.find((f) => f.id === interA.id), 8000);
  const gotInterB = await waitFor('the second interleaved frame arrives', () => received.find((f) => f.id === interB.id), 8000);
  ok('both interleaved frames arrived intact (the reassembler is keyed by fid)', gotInterA.body.message.text === interA.body.message.text && gotInterB.body.message.text === interB.body.message.text);
  ok(
    'the arrival order follows each frame\'s last slice',
    received.indexOf(gotInterA) < received.indexOf(gotInterB),
    `A at ${received.indexOf(gotInterA)}, B at ${received.indexOf(gotInterB)}`,
  );

  // ---------------------------------------------------------------- 7. replay, tamper, malformed
  console.log('-- 7. a replay, a tampered byte and a malformed line: refused, counted, not fatal --');
  const replayable = { v: 1, type: 'mirror', id: 'aabbccddeeff0006', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'notice', text: 'replay me' } } };
  const replaySpec = stub.push(peerOne, replayable);
  await waitFor('the frame the replay case uses arrives', () => received.find((f) => f.id === replayable.id));
  const beforeReplay = { ...main.status.inboundRefused };
  stub.writeAll(peerOne, replaySpec);
  await waitFor('the replay is counted', () => main.status.inboundRefused.replay === beforeReplay.replay + 1, 4000);
  ok('the replay window refused the second delivery of the same sealed frame', main.status.inboundRefused.replay === beforeReplay.replay + 1, `replay ${main.status.inboundRefused.replay}`);
  ok('  … it was classified as a replay, not as tampering or a malformed line', main.status.inboundRefused.auth === beforeReplay.auth && main.status.inboundRefused.malformed === beforeReplay.malformed && main.status.inboundRefused.slice === beforeReplay.slice);
  ok('  … and the frame was handed over exactly once', received.filter((f) => f.id === replayable.id).length === 1, `${received.filter((f) => f.id === replayable.id).length} delivery/ies`);

  const tamperTarget = { v: 1, type: 'mirror', id: 'aabbccddeeff0007', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'notice', text: 'do not trust me' } } };
  const tamperSpec = stub.seal(tamperTarget);
  tamperSpec.lines = tamperSpec.lines.map(tamper);
  const beforeTamper = { ...main.status.inboundRefused };
  stub.writeAll(peerOne, tamperSpec);
  await waitFor('the tampered frame is refused as auth', () => main.status.inboundRefused.auth === beforeTamper.auth + 1, 4000);
  ok('a tampered byte fails authentication', main.status.inboundRefused.auth === beforeTamper.auth + 1);
  ok('  … it is not mistaken for a replay', main.status.inboundRefused.replay === beforeTamper.replay);
  ok('  … and its plaintext never reached onFrame', !received.some((f) => f.id === tamperTarget.id));

  const beforeMalformed = { ...main.status.inboundRefused };
  stub.sendRaw(peerOne, '{"v":1,"seq":1,"fid":"not-a-frame-id","idx":0,"last":true,"b":"AAAA"}');
  stub.sendRaw(peerOne, 'this is not JSON at all');
  stub.sendField(peerOne, 'event: something the contract never defined');
  stub.writeComment(peerOne, 'ping again');
  await waitFor('both malformed lines are counted', () => main.status.inboundRefused.malformed === beforeMalformed.malformed + 2, 4000);
  ok('a malformed slice line is refused as malformed (twice)', main.status.inboundRefused.malformed === beforeMalformed.malformed + 2, `malformed ${main.status.inboundRefused.malformed}`);
  ok('  … an unknown SSE field and a comment are ignored, not refused', sum(main.status.inboundRefused) === sum(beforeMalformed) + 2, JSON.stringify(main.status.inboundRefused));

  // ---------------------------------------------------------------- 7b. a disagreeing `s`
  console.log('-- 7b. a slice whose `s` disagrees with its frame is refused, never spliced in --');
  // The payloads of these slices are a valid sealed frame under the frame's own salt, so a
  // reassembler that accepted the stray `s` would hand over a perfectly openable frame —
  // which is exactly the splice §7's "same `v`, `seq`, `s` and `fid`" rule forbids: two
  // connections' slices read as one frame whose nonce nobody can name.
  const spliceTarget = { v: 1, type: 'mirror', id: 'aabbccddeeff0009', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'agentItems', text: 'S'.repeat(120 * 1024) } } };
  const spliceSpec = stub.seal(spliceTarget);
  ok('the frame the splice case needs has several slices', spliceSpec.slices.length > 2, `${spliceSpec.slices.length} slices`);
  const straySalt = frames.encodeSalt((frames.decodeSalt(spliceSpec.saltHex) ^ 1) >>> 0);
  const beforeSplice = { ...main.status.inboundRefused };
  stub.writeLine(peerOne, spliceSpec.lines[0]);
  stub.writeLine(peerOne, frames.encodeSlice({ ...spliceSpec.slices[1], s: straySalt }));
  for (let i = 2; i < spliceSpec.lines.length; i += 1) {
    stub.writeLine(peerOne, spliceSpec.lines[i]);
  }
  // The mismatch, and then every slice that followed it: the assembly was abandoned, so
  // the rest of that stream belongs to nothing. Nothing was reassembled and nothing opened.
  const strayRefusals = spliceSpec.slices.length - 1;
  await waitFor(
    'the disagreeing salt is refused as a broken slice stream',
    () => main.status.inboundRefused.slice === beforeSplice.slice + strayRefusals,
    4000,
  );
  ok('the reassembler refused the slice whose `s` disagrees with its frame', main.status.inboundRefused.slice === beforeSplice.slice + strayRefusals, `slice ${main.status.inboundRefused.slice} (+${strayRefusals} of ${spliceSpec.slices.length})`);
  ok('  … as a framing refusal, NOT as an auth failure: no tag was ever checked', main.status.inboundRefused.auth === beforeSplice.auth && main.status.inboundRefused.replay === beforeSplice.replay && main.status.inboundRefused.size === beforeSplice.size);
  ok('  … and the spliced frame never reached onFrame', !received.some((f) => f.id === spliceTarget.id));
  ok('  … and the stray salt was well formed and different, so only the `s` check could refuse it', /^[0-9a-f]{8}$/.test(straySalt) && straySalt !== spliceSpec.saltHex, `${spliceSpec.saltHex} → ${straySalt}`);

  // ---------------------------------------------------------------- 7c. one window per sender
  console.log('-- 7c. one replay window per SENDER salt: a room of three is not half-mute --');
  // REGRESSION, and the reason this case exists: the transport used to keep ONE window per
  // receiving connection and feed it every sender's `seq`. Every peer seals under its own salt
  // and starts its own `seq` at 1 (§4), so a second sender's first frame collided with the
  // first sender's `seq` 1 — and once one peer had sent more than 64 frames, every later
  // sender fell below the window's floor. Measured in a real room of three: a third member's
  // broadcast never arrived and `inboundRefused.replay` went +1. A two-peer room never shows it.
  //
  // The three sub-cases below are the whole defect: two senders at `seq` 1, a flooded sender
  // next to a fresh one, and a genuine replay that must still be refused.
  const senderA = frames.encodeSalt(0x5a17a001);
  const senderB = frames.encodeSalt(0x5a17b002);
  const frameOf = (id, from, marker) => ({
    v: 1,
    type: 'mirror',
    id,
    from,
    to: '*',
    body: { sessionId: 's-1', message: { type: 'delta', text: marker } },
  });
  const refusedBeforeRoom = { ...main.status.inboundRefused };

  const firstA = frameOf('aabbccddeeff0011', 'aa000001', 'sender A, first frame');
  const firstB = frameOf('aabbccddeeff0012', 'bb000002', 'sender B, first frame');
  const specA1 = stub.seal(firstA, senderA);
  const specB1 = stub.seal(firstB, senderB);
  ok('both senders really start their own numbering at seq 1', specA1.seq === 1 && specB1.seq === 1 && senderA !== senderB, `${senderA}/seq ${specA1.seq} and ${senderB}/seq ${specB1.seq}`);
  stub.writeAll(peerOne, specA1);
  stub.writeAll(peerOne, specB1);
  await waitFor('both senders\u2019 first frames arrive', () => received.find((f) => f.id === firstA.id) && received.find((f) => f.id === firstB.id), 6000);
  ok('two senders each starting at seq 1 are BOTH accepted', received.some((f) => f.id === firstA.id) && received.some((f) => f.id === firstB.id), 'the second one used to be dropped as a replay');
  ok('  … and neither was counted as a replay', main.status.inboundRefused.replay === refusedBeforeRoom.replay, JSON.stringify(main.status.inboundRefused));

  // A sender that has already sent more than the 64-wide window: its floor is now far above
  // another sender's fresh `seq`, which is the second half of the defect.
  const FLOOD = 70;
  const floodBefore = { ...main.status.inboundRefused };
  for (let i = 0; i < FLOOD; i += 1) {
    stub.writeAll(peerOne, stub.seal(frameOf(`aabbccdd0000${i.toString(16).padStart(4, '0')}`, 'aa000001', `flood ${i}`), senderA));
  }
  await waitFor(
    'the flooded sender\u2019s frames all arrive',
    () => received.filter((f) => f.body.sessionId === 's-1' && typeof f.body.message.text === 'string' && f.body.message.text.startsWith('flood ')).length === FLOOD,
    10000,
  );
  ok(`a sender that has sent ${FLOOD} frames is accepted frame after frame (its own window keeps up)`, main.status.inboundRefused.replay === floodBefore.replay, `replay ${main.status.inboundRefused.replay}`);

  const freshB = frameOf('aabbccddeeff0013', 'bb000002', 'sender B, fresh frame');
  const specB2 = stub.seal(freshB, senderB);
  stub.writeAll(peerOne, specB2);
  await waitFor('the second sender\u2019s fresh frame still arrives', () => received.find((f) => f.id === freshB.id), 6000);
  ok(
    'a flooded sender does NOT push another sender out of its own window',
    received.some((f) => f.id === freshB.id) && main.status.inboundRefused.replay === floodBefore.replay,
    `B at seq ${specB2.seq} under ${senderB}, after A reached seq ${FLOOD + 1}; replay ${main.status.inboundRefused.replay}`,
  );

  // The defence that must NOT have been weakened: the same sender, the same sealed frame, twice.
  const beforeSameSenderReplay = { ...main.status.inboundRefused };
  const deliveriesOfB = received.filter((f) => f.id === freshB.id).length;
  stub.writeAll(peerOne, specB2);
  await waitFor('the same sender\u2019s repeat is counted as a replay', () => main.status.inboundRefused.replay === beforeSameSenderReplay.replay + 1, 4000);
  ok('a genuine replay from the SAME sender is still refused', main.status.inboundRefused.replay === beforeSameSenderReplay.replay + 1, `replay ${main.status.inboundRefused.replay}`);
  ok('  … and it was not delivered a second time', received.filter((f) => f.id === freshB.id).length === deliveriesOfB, `${deliveriesOfB} delivery/ies`);
  ok('  … and it was classified as a replay, not as auth or a broken stream', main.status.inboundRefused.auth === beforeSameSenderReplay.auth && main.status.inboundRefused.slice === beforeSameSenderReplay.slice);

  // An unauthenticated frame must not move a sender's window: the salt is public (it travels
  // as `s`), so a relay could otherwise burn a victim's sequence with one forged envelope and
  // have every genuine frame after it refused as a replay. The Kotlin peer orders it the same
  // way — "verify the tag, then advance the replay window; unverified input must not move state".
  const victim = frames.encodeSalt(0x5a17c003);
  const victimFirst = frameOf('aabbccddeeff0014', 'cc000003', 'victim, first frame');
  stub.writeAll(peerOne, stub.seal(victimFirst, victim));
  await waitFor('the victim\u2019s first frame arrives', () => received.find((f) => f.id === victimFirst.id), 6000);
  const beforeForgery = { ...main.status.inboundRefused };
  stub.writeLine(
    peerOne,
    frames.encodeSlice({
      v: 1,
      seq: 100000,
      s: victim,
      fid: frames.newFrameId(),
      idx: 0,
      last: true,
      b: Buffer.from('not a real GCM tag, and not a real frame body').toString('base64'),
    }),
  );
  await waitFor('the forged envelope is refused as auth', () => main.status.inboundRefused.auth === beforeForgery.auth + 1, 4000);
  const victimSecond = frameOf('aabbccddeeff0015', 'cc000003', 'victim, second frame');
  stub.writeAll(peerOne, stub.seal(victimSecond, victim));
  await waitFor('the victim\u2019s next genuine frame still arrives', () => received.find((f) => f.id === victimSecond.id), 6000);
  ok('an unauthenticated frame under a real salt does not burn that sender\u2019s window', received.some((f) => f.id === victimSecond.id) && main.status.inboundRefused.replay === beforeForgery.replay, `the forged seq 100000 was refused as auth; the victim\u2019s seq 2 still arrived`);

  // The bound itself: one window per peer (§8: 16 peers per room), LRU-evicted. Seventeen
  // senders all deliver; the cost of the bound is stated rather than hidden — the first
  // sender's window was evicted, so the very frame it already sent can be delivered again.
  // That is why the bound is a memory bound and not a security boundary (see
  // `REPLAY_SALTS_MAX` in the transport, and the same comment in the Kotlin peer).
  const many = [];
  for (let i = 0; i < 17; i += 1) {
    const salt = frames.encodeSalt(0x5b000000 + i);
    const frame = frameOf(`aabbccdd0011${i.toString(16).padStart(2, '0')}`, 'dd000004', `sender ${i}`);
    many.push({ salt, frame, spec: stub.seal(frame, salt) });
  }
  for (const entry of many) {
    stub.writeAll(peerOne, entry.spec);
  }
  await waitFor(
    'seventeen senders all deliver',
    () => many.every((entry) => received.some((f) => f.id === entry.frame.id)),
    10000,
  );
  ok('a room of seventeen senders still delivers every sender', many.every((entry) => received.some((f) => f.id === entry.frame.id)), `${many.length} senders, one frame each`);

  const evicted = many[0];
  const replayOfEvicted = { ...main.status.inboundRefused };
  stub.writeAll(peerOne, evicted.spec); // the exact same sealed frame, under the evicted salt
  await waitFor(
    'the evicted sender\u2019s frame is accepted again (the bound forgets)',
    () => received.filter((f) => f.id === evicted.frame.id).length === 2,
    6000,
  );
  ok(
    'the least-recently-used window was evicted, and its frame is accepted once more — the bound is memory, not security',
    received.filter((f) => f.id === evicted.frame.id).length === 2 && main.status.inboundRefused.replay === replayOfEvicted.replay,
    `seventeen salts, sixteen windows; the first sender's window was forgotten, so its own seq 1 was fresh again`,
  );

  const survivor = { v: 1, type: 'mirror', id: 'aabbccddeeff0008', from: 'feedbeef', to: '*', body: { sessionId: 's-1', message: { type: 'delta', text: 'still here' } } };
  stub.push(peerOne, survivor);
  const gotSurvivor = await waitFor('a frame sent after all of that still arrives', () => received.find((f) => f.id === survivor.id));
  ok('none of it took the connection down', main.status.phase === 'online' && gotSurvivor.id === survivor.id, `phase ${main.status.phase}`);

  // ---------------------------------------------------------------- 8. a 429 is retried
  console.log('-- 8. a 429 is retried with a short backoff, not dropped --');
  rateLimited.start();
  const ratePeer = await onlineOf(rateLimited, 'the second transport goes online');
  const droppedBefore429 = rateLimited.status.dropped;
  stub.force(ratePeer, 429, 3);
  ok('send() queues the frame', rateLimited.send({ type: 'resync', to: '*', body: { sessionId: 's-1' } }) === true);
  const resent = await waitFor('the frame still arrives after three 429s', () => receivedFrames(stub, keys.encKey).find((f) => f.peer === ratePeer && f.frame && f.frame.type === 'resync'), 8000);
  ok('the rate-limited frame was delivered whole, not dropped', !!resent.frame && JSON.stringify(resent.frame.body) === JSON.stringify({ sessionId: 's-1' }));
  ok('  … and nothing was counted as a drop', rateLimited.status.dropped === droppedBefore429, `dropped ${rateLimited.status.dropped}`);
  ok('  … and the room is still online', rateLimited.status.phase === 'online');

  // ---------------------------------------------------------------- 9. pacing
  console.log('-- 9. pacing: ninety frames leave at the configured rate, not at once --');
  const PACED = 90;
  const upsBeforePacing = stub.upCount();
  const droppedBeforePacing = main.status.dropped;
  let paced = 0;
  for (let i = 0; i < PACED; i += 1) {
    if (main.send({ type: 'resync', to: '*', body: { sessionId: 's-pace', n: i } })) {
      paced += 1;
    }
  }
  ok('every pacing frame was queued', paced === PACED, `${paced}/${PACED}`);
  await waitFor(
    'all of them reached the stub',
    () => stub.upsFrom(upsBeforePacing).filter((up) => up.peer === main.peerId).length >= PACED,
    20000,
  );
  const pacedTimes = stub.upsFrom(upsBeforePacing).filter((up) => up.peer === main.peerId).map((up) => up.at).sort((a, b) => a - b);
  const span = pacedTimes[pacedTimes.length - 1] - pacedTimes[0];
  const floor = ((PACED - MAX_POST_BURST) / MAX_POST_PER_SECOND) * 1000 * 0.75;
  ok('the burst was spread over the time the rate requires', span >= floor, `${span} ms for ${PACED} POSTs (floor ${Math.round(floor)} ms)`);
  let worst = 0;
  for (let i = 0; i < pacedTimes.length; i += 1) {
    let count = 0;
    for (let j = i; j < pacedTimes.length && pacedTimes[j] - pacedTimes[i] < 1000; j += 1) {
      count += 1;
    }
    worst = Math.max(worst, count);
  }
  // The ceiling is not a guess: a token bucket can spend its whole burst at the start of
  // any one-second window and still refill `rate` times inside it, this transport adds at
  // most three heartbeats in the same second, and a timer is never exactly on time.
  const ceiling = MAX_POST_PER_SECOND + MAX_POST_BURST + 10;
  ok('the ceiling is a rate, not a hope: no one-second window held more than the rate plus the burst allowance', worst <= ceiling, `${worst} POST(s) in the worst 1 s window (ceiling ${ceiling}, an unpaced sender posts ${PACED})`);
  ok('nothing was dropped while pacing', main.status.dropped === droppedBeforePacing, `dropped ${main.status.dropped - droppedBeforePacing} during the burst`);

  // ---------------------------------------------------------------- 10. backpressure
  console.log('-- 10. backpressure: a peer that stops answering cannot make send() wait --');
  stalled.start();
  const slowPeer = await onlineOf(stalled, 'the third transport goes online');
  stub.stall(slowPeer);
  let refused = 0;
  let accepted = 0;
  let slowestSend = 0;
  const slowStart = Date.now();
  for (let i = 0; i < 300; i += 1) {
    const sentAt = Date.now();
    const good = stalled.send({ type: 'mirror', to: '*', body: { sessionId: 's-slow', n: i, pad: 'p'.repeat(240) } });
    slowestSend = Math.max(slowestSend, Date.now() - sentAt);
    if (good) {
      accepted += 1;
    } else {
      refused += 1;
    }
  }
  const sendElapsed = Date.now() - slowStart;
  ok('a full queue refuses the frame instead of accepting it', refused > 0 && accepted > 0, `${accepted} queued, ${refused} refused`);
  ok('every send returned immediately (never waiting for the stalled link)', slowestSend < 100, `slowest send ${slowestSend} ms`);
  ok('the whole burst never blocked the caller', sendElapsed < 2000, `${sendElapsed} ms for 300 sends`);
  ok('the drops are counted', stalled.status.dropped >= refused, `dropped ${stalled.status.dropped} ≥ refused ${refused}`);
  ok('the transport is still online: a stalled up path is not a dead connection', stalled.status.phase === 'online', stalled.status.phase);
  const probeStart = Date.now();
  await sleep(50);
  ok('the event loop stayed responsive throughout', Date.now() - probeStart < 400, `${Date.now() - probeStart} ms for a 50 ms sleep`);
  ok('the stub is holding the POSTs it never answered', stub.heldCount(slowPeer) >= 1, `${stub.heldCount(slowPeer)} held`);
  const released = stub.release(slowPeer);
  ok('the held POSTs were answered on release', released >= 1, `${released} released`);
  await waitFor(
    'the queue drains once the peer reads again',
    () => receivedFrames(stub, keys.encKey).filter((f) => f.frame && f.frame.body && f.frame.body.sessionId === 's-slow').length >= accepted,
    20000,
  );
  ok('send() works again after the queue drained', stalled.send({ type: 'resync', to: '*', body: { sessionId: 's-slow', drain: true } }) === true);

  // ---------------------------------------------------------------- 11. reconnect
  console.log('-- 11. reconnect: backoff, then a new peer id and a fresh connection salt --');
  const saltBeforeDrop = [...peerOneSalts][0];
  const joinsBefore = stub.joinCount();
  const statusesBefore = statuses.length;
  stub.endDown(peerOne);
  const backoff = await waitFor('the transport reports backoff', () => statuses.slice(statusesBefore).find((s) => s.phase === 'backoff'), 6000);
  ok('a stream that ends mid-flight is a backoff, not a silent death', backoff.phase === 'backoff');
  ok('  … with a reason and a retryAt in the future', typeof backoff.error === 'string' && backoff.error.length > 0 && Number.isFinite(backoff.retryAt) && backoff.retryAt > Date.now() && backoff.retryAt <= Date.now() + RECONNECT_MAX_MS, `retryAt in ${backoff.retryAt - Date.now()} ms — ${backoff.error}`);
  ok('  … and the dead peer id is not kept', backoff.peerId === null && main.peerId === null);
  ok('  … and a send while offline is refused, and counted', main.send({ type: 'resync', to: '*', body: { sessionId: 's-offline' } }) === false && main.status.dropped > 0, `dropped ${main.status.dropped}`);
  const onlineTwo = await waitFor('the transport is online again', () => (main.status.phase === 'online' ? main.status : null), 6000);
  ok('the relay accepted a second join', stub.joinCount() === joinsBefore + 1, `${stub.joinCount() - joinsBefore} join(s)`);
  ok('the new peer id is a fresh one', onlineTwo.peerId !== peerOne && /^[0-9a-f]{8}$/.test(onlineTwo.peerId), `${peerOne} → ${onlineTwo.peerId}`);
  main.send({ type: 'hello', to: '*', body: { ...helloBody, instanceId: 'pid-after-reconnect' } });
  const afterDrop = await waitFor('a frame from the new connection reaches the stub', () => receivedFrames(stub, keys.encKey).find((f) => f.frame && f.frame.body && f.frame.body.instanceId === 'pid-after-reconnect'), 6000);
  ok(
    'the reconnected transport seals with a FRESH connection salt, named in its own envelope',
    afterDrop.salt !== saltBeforeDrop && frames.decodeSalt(afterDrop.slice.s) === afterDrop.salt && frames.encodeSalt(afterDrop.salt) === afterDrop.slice.s,
    `${frames.encodeSalt(saltBeforeDrop)} → ${afterDrop.slice.s}`,
  );
  const newPeerFrames = () => receivedFrames(stub, keys.encKey).filter((f) => f.peer === onlineTwo.peerId && !f.error);
  ok('  … and one salt again for the new connection', new Set(newPeerFrames().map((f) => f.salt)).size === 1, `${new Set(newPeerFrames().map((f) => f.salt)).size} salt(s)`);
  ok('nothing was replayed across the reconnect: every frame arrived once', new Set(receivedFrames(stub, keys.encKey).filter((f) => !f.error).map((f) => f.fid)).size === receivedFrames(stub, keys.encKey).filter((f) => !f.error).length);
  ok('a frame dropped while offline is never sent later', !receivedFrames(stub, keys.encKey).some((f) => f.frame && f.frame.body && f.frame.body.sessionId === 's-offline'));
  const peerTwo = onlineTwo.peerId;

  // ---------------------------------------------------------------- 12. a silent relay
  console.log('-- 12. a relay that stops writing is noticed, not waited out --');
  quiet.start();
  const quietPeer = await onlineOf(quiet, 'the silent-case transport goes online');
  await stub.waitForDown(quietPeer);
  stub.silence(quietPeer);
  const silentAt = Date.now();
  const silentBackoff = await waitFor('the transport notices the silence', () => (quiet.status.phase === 'backoff' ? quiet.status : null), HB * 8);
  ok('a stream that goes silent is a backoff, not a five-minute wait', Date.now() - silentAt <= HB * 6 + 500, `${Date.now() - silentAt} ms with a ${HB} ms heartbeat`);
  ok('  … and the reason says so', /nothing|silent/i.test(silentBackoff.error ?? ''), silentBackoff.error);
  quiet.stop();
  await sleep(150);

  // ---------------------------------------------------------------- 13. a refused join
  console.log('-- 13. a non-2xx join is a status, never a throw into the caller --');
  const refusedTransport = make({ heartbeatMs: 60000 });
  const joinsBeforeRefusal = stub.joinAttempts();
  stub.state.joinStatuses.push(404);
  let startThrew = false;
  try {
    refusedTransport.start();
  } catch {
    startThrew = true;
  }
  const errorStatus = await waitFor('the transport reports the refused join', () => (refusedTransport.status.phase === 'error' ? refusedTransport.status : null), 5000);
  ok('a 404 on join (the relay\'s answer for a malformed room id) is an `error`, never a throw', startThrew === false && errorStatus.phase === 'error' && /404/.test(errorStatus.error ?? ''), errorStatus.error);
  ok('  … with no retryAt: it will not retry a refusal on its own', errorStatus.retryAt === undefined && errorStatus.peerId === null);
  await sleep(HB * 2);
  ok('  … and it really did not retry', stub.joinAttempts() === joinsBeforeRefusal + 1, `${stub.joinAttempts() - joinsBeforeRefusal} join request(s)`);
  ok('  … every status it published still has the documented shape', statuses.every(isStatusShaped));

  stub.state.joinStatuses.push(503);
  refusedTransport.start();
  const willRetry = await waitFor('a 5xx join is a backoff, not an error', () => (refusedTransport.status.phase === 'backoff' ? refusedTransport.status : null), 5000);
  ok('a 5xx on join is a `backoff`, with a retryAt in the future', Number.isFinite(willRetry.retryAt) && willRetry.retryAt > Date.now() && /503/.test(willRetry.error ?? ''), `retry in ${willRetry.retryAt - Date.now()} ms — ${willRetry.error}`);
  const recovered = await waitFor('the scheduled retry joins once the relay answers', () => (refusedTransport.status.phase === 'online' ? refusedTransport.status : null), 6000);
  ok('the retry after the backoff joined, and start() from `error` works', /^[0-9a-f]{8}$/.test(recovered.peerId), recovered.peerId);
  refusedTransport.send({ type: 'resync', to: '*', body: { sessionId: 's-refused', recovered: true } });
  const recoveredFrame = await waitFor('the recovered connection posts a frame', () => receivedFrames(stub, keys.encKey).find((f) => f.frame && f.frame.body && f.frame.body.sessionId === 's-refused'), 6000);
  ok('  … and that connection seals with its own fresh salt', recoveredFrame.salt !== saltBeforeDrop && frames.decodeSalt(recoveredFrame.slice.s) === recoveredFrame.salt, `s=${recoveredFrame.slice.s}`);
  refusedTransport.stop();

  // ---------------------------------------------------------------- 14. stop, start, exit
  console.log('-- 14. stop() releases everything, and start() after stop() works --');
  const countsFor = (peer) => stub.state.ups.filter((up) => up.peer === peer).length;
  const peerBeforeStop = main.peerId;
  const upsBeforeStop = countsFor(peerBeforeStop);
  main.stop();
  ok('stop() publishes idle with no peer', main.status.phase === 'idle' && main.status.peerId === null, main.status.phase);
  // A POST that was already on the wire when `stop()` ran still arrives; what must not
  // happen is a *new* one, which is exactly what a heartbeat or a pump timer that
  // survived `stop()` would produce. Counted per peer, because the other transports in
  // this run are still posting.
  await sleep(150);
  const upsAfterStop = countsFor(peerBeforeStop);
  ok('the requests already in flight are all there is', upsAfterStop - upsBeforeStop <= 2, `${upsAfterStop - upsBeforeStop} straggler POST(s)`);
  await sleep(HB * 3);
  ok('no heartbeat or POST survived stop()', countsFor(peerBeforeStop) === upsAfterStop, `${countsFor(peerBeforeStop) - upsAfterStop} post(s) in ${HB * 3} ms after stop()`);
  ok('the down stream was released', !stub.downPeers().includes(peerTwo), `${stub.downPeers().length} stream(s) left, all of them other transports`);
  main.start();
  const onlineThree = await waitFor('start() after stop() reconnects', () => (main.status.phase === 'online' ? main.status : null), 6000);
  ok('start() after stop() joins again, with a fresh peer id', onlineThree.peerId !== peerTwo && /^[0-9a-f]{8}$/.test(onlineThree.peerId), `${peerTwo} → ${onlineThree.peerId}`);

  rateLimited.stop();
  stalled.stop();
  quiet.stop();
  main.stop();
  await sleep(150);
  const timersAtEnd = activeTimers();
  ok('every transport is stopped and no timer outlived them', timersAtEnd <= timerBaseline, `${timersAtEnd} timer(s) vs a baseline of ${timerBaseline}`);

  await stub.close();

  console.log('');
  finished = true;
  if (problems.length) {
    console.log(`FAIL relay-acceptance: ${problems.length} of ${checks} check(s) failed:`);
    for (const label of problems) {
      console.log(`  - ${label}`);
    }
    process.exit(1);
  }
  console.log(
    `PASS relay-acceptance: ${checks}/${checks} checks — a real relay on an ephemeral port drove the compiled transport through ` +
      'a clean join, slicing and interleaved reassembly, replay/tamper/malformed refusals, a 429, pacing, backpressure, ' +
      'a refused join, a reconnect with fresh key material, and its silent-stream watchdog',
  );
  // Deliberately no `process.exit(0)`: the run has to end on its own, and a timer or a
  // socket that outlived `stop()` is exactly what would keep it alive. The watchdog is
  // unref'd, so a clean run exits before it can fire.
  const watchdog = setTimeout(() => {
    console.log('FAIL relay-acceptance: the run did not exit on its own within 3000 ms — something left a timer or a socket behind');
    process.exit(1);
  }, 3000);
  watchdog.unref?.();
})().catch((err) => {
  finished = true;
  console.log('');
  console.log(`FAIL relay-acceptance: ${err instanceof Timeout ? 'a case timed out' : err && err.message ? err.message : String(err)}`);
  if (!(err instanceof Timeout) && err && err.stack) {
    console.log(String(err.stack).split('\n').slice(1, 4).join('\n'));
  }
  process.exit(1);
});
