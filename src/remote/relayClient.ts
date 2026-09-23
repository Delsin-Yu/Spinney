/**
 * The outbound room transport: one instance per (window, room).
 *
 * This module owns everything between "we have a room id and a key" and "a decoded
 * frame was handed to the service". It deliberately knows nothing about sessions,
 * webviews or VS Code — that is `remoteService.ts`.
 *
 * It owns:
 *   - the relay conversation: `POST /v1/room/{roomId}/join` for a peer id, then a
 *     `GET .../down` SSE subscription and `POST .../up` for every frame;
 *   - sealing and slicing (`src/remote/frames.ts`) and reassembly of inbound slices;
 *   - one replay window **per sender salt** (bounded, LRU — see {@link acceptSeq}), and the
 *     app-level `ping` that both proves liveness and keeps the SSE body non-idle (Node's
 *     `fetch` is undici, whose default `bodyTimeout` is 300 s measured between chunks — a
 *     silent stream would be killed by the runtime);
 *   - pacing its own POSTs: the relay answers 429 over a per-peer rate limit, and a
 *     10 MiB frame is hundreds of slices, so the transport must never burst;
 *   - reconnect with exponential backoff and jitter, re-join (a new peer id and a new
 *     connection salt, so a nonce can never be reused) and reporting it;
 *   - a bounded outbound queue: a peer that cannot keep up must never delay, block or
 *     fail the owner's own window.
 *
 * It does NOT own: which sessions are mirrored, who is in the room, or what to do
 * after a drop — those belong to `remoteService.ts`. The transport reports through
 * `onStatus` and the service decides.
 *
 * The shipped extension has zero runtime dependencies, so this uses the global
 * `fetch` and `node:crypto` only.
 *
 * THE CONNECTION SALT IS THE ENVELOPE'S OWN FIELD
 *
 * §4 makes the nonce `be64(seq) || be32(connection salt)` and §7 puts that salt on the
 * wire as `s` — 8 lowercase hex characters, in position 3 — precisely because a receiver
 * has to rebuild the nonce *before* it can decrypt anything. So this transport owns
 * exactly one thing about it: it draws a fresh random uint32 per connection, passes it to
 * `sealFrame`/`sliceSealed` so every slice of that connection carries it as `s`, and on the
 * receiving side it builds the nonce from `decodeSalt(slice.s)` — the **sender's** salt as
 * the envelope names it, never this connection's own and never anything derived from `fid`.
 * `fid` is opaque here (`newFrameId()`): a frame id that secretly carries key material is
 * how two implementations end up disagreeing about a frame that is perfectly valid.
 */
import { randomBytes } from 'node:crypto';

import {
  FRAME_MAX_BYTES,
  FRAME_VERSION,
  FrameAuthError,
  FrameReassembler,
  FrameReplayError,
  FrameSizeError,
  FrameSliceError,
  ReplayWindow,
  decodeFrame,
  decodeSalt,
  decodeSlice,
  encodeFrame,
  encodeSlice,
  newFrameId,
  openFrame,
  sealFrame,
  sliceSealed,
} from './frames';
import type { FrameEnvelope, Slice } from './frames';

/**
 * The app-level liveness interval, in milliseconds.
 *
 * 20 s is a constant and not a tunable: it is comfortably inside undici's 300 s
 * `bodyTimeout` (so a quiet room is never killed by the runtime) and short enough
 * that a half-open connection is noticed before a user does.
 *
 * Two things are timed off it, and neither is a knob: the application `ping` frame this
 * transport posts, which is the half-open detector *and* the reason the relay's
 * per-peer idle eviction (90 s) never fires; and the silent-stream watchdog
 * ({@link IDLE_STREAM_FACTOR} × this), which turns "the relay stopped writing" into a
 * visible reconnect instead of a five-minute wait for the runtime to kill the body.
 */
export const HEARTBEAT_MS = 20000;

/** How many `up` POSTs the transport may start per second, per peer. */
export const MAX_POST_PER_SECOND = 50;

/**
 * The number of POSTs a fresh connection may spend back to back before it is held to
 * {@link MAX_POST_PER_SECOND}.
 *
 * A burst exists because a frame is *slices*, not one body: 356 slices of an 8 MB photo
 * should leave the transport as one uninterrupted write, and a strict per-second ritual
 * would spread that over the whole second for no gain. It is small on purpose — the
 * relay's own bucket is 60/s with a burst of 120, and a client that spends its whole
 * burst on every frame is a client that gets 429'd.
 */
export const MAX_POST_BURST = 8;

/**
 * The outbound queue's byte bound.
 *
 * Equal to the largest frame the contract allows (`FRAME_MAX_BYTES`), so the queue can
 * always admit one maximal frame — a 10.7 MB phone photo is the sizing case in
 * `remote/PROTOCOL.md` §8, and a bound below it would make that photo unsendable
 * whenever the queue was not already empty. Everything past that is dropped, counted
 * in `status.dropped`, and left for the service to re-announce.
 */
export const MAX_QUEUE_BYTES = FRAME_MAX_BYTES;

/** First backoff step, in milliseconds. Jittered, so a roomful of windows does not return at once. */
export const RECONNECT_MIN_MS = 500;
/** Backoff cap. A relay that is down for a while is retried at most this often. */
export const RECONNECT_MAX_MS = 30000;

/** How long one `up` POST (or the `join`) may hang before it counts as a broken link. */
const POST_TIMEOUT_MS = 30000;
/** How often a 429'd POST is retried, doubling, before the link is declared unhealthy. */
const RATE_LIMIT_RETRY_MS = 250;
/** Cap on the 429 retry delay. */
const RATE_LIMIT_RETRY_MAX_MS = 2000;
/** Consecutive 429s tolerated for one slice before the connection is rebuilt. */
const RATE_LIMIT_RETRIES = 5;
/**
 * The silent-stream watchdog, as a multiple of the heartbeat. The relay writes a
 * `: ping` comment every 15 s, so a healthy stream is never idle for a whole heartbeat;
 * waiting twice the heartbeat before giving up keeps a slow proxy out of the story
 * while still landing far inside undici's 300 s.
 */
const IDLE_STREAM_FACTOR = 2;

export type TransportPhase =
  /** created, not started (or stopped for good) */
  | 'idle'
  /** joining the room */
  | 'connecting'
  /** joined and streaming */
  | 'online'
  /** the last attempt failed; `retryAt` says when the next one is due */
  | 'backoff'
  /** a failure the transport will not retry on its own (a malformed URL, a refusal) */
  | 'error';

/**
 * Everything the down-reader refused, by cause.
 *
 * `remote/PROTOCOL.md` §4 says the three failure kinds must stay distinguishable —
 * *too large*, *tampered* and *replayed* are three outcomes, never one string — and the
 * counts keep that promise visible from the outside: a room whose `auth` count climbs
 * after a reconnect is a room whose peers do not share a key, while a climbing `replay`
 * count is the relay (or a peer) echoing frames, and neither reads like the other.
 * `src/remote/frames.ts` already draws the taxonomy; this is only its tally.
 */
export interface InboundRefusalCounts {
  /** The line was not a slice at all (not JSON, an unknown key, a bad `v`/`seq`/`s`/`fid`/`idx`/`last`/`b`). */
  malformed: number;
  /**
   * One `fid`'s slice stream was broken: out of order, duplicated, after the final slice,
   * or a `v`/`seq`/`s` that disagrees with the slices already collected under that `fid`.
   * The `s` half is the one that matters most — two connections' slices spliced into one
   * frame would leave a nonce nobody can name.
   */
  slice: number;
  /** A hard cap: the slice cap, or the reassembled-frame cap. */
  size: number;
  /**
   * A `seq` that sender's own window had already accepted — the same sealed frame sent
   * twice. Per **sender salt**, never per receiving connection: see {@link acceptSeq} for
   * why one window keyed on `seq` alone silently mutes a room of three.
   */
  replay: number;
  /** The reassembled frame did not open: tampered bytes, or a salt/AAD/key that does not match. */
  auth: number;
  /** The frame opened but is not the six-key logical frame of §5. */
  envelope: number;
}

export interface TransportStatus {
  phase: TransportPhase;
  /** The peer id the relay assigned for this connection; null until joined. */
  peerId: string | null;
  /** When `phase === 'backoff'`: the epoch ms of the next attempt. */
  retryAt?: number;
  /** A short reason for `backoff` / `error`. English; the caller localizes its own UI. */
  error?: string;
  /**
   * Frames the outbound queue has dropped since the last `online`, because a peer or
   * the link could not keep up. The service reads this to decide that its mirror is
   * stale for someone and re-send the affected session's state.
   *
   * The window really is "since the last `online`": coming online is the one moment the
   * service re-announces anyway, so it is also the only moment at which a stale mirror
   * could exist without the service already knowing.
   */
  dropped: number;
  /**
   * Inbound slices/frames the reader refused since `start()`, by cause. Deliberately
   * **not** cleared by a reconnect: a reconnect is exactly when the tally is worth
   * reading.
   */
  inboundRefused: InboundRefusalCounts;
}

/** What a caller hands to `send`; the transport fills in `v`, `from` and `id`. */
export interface OutboundFrame {
  type: string;
  /** `*` to broadcast, else a peer id. */
  to: string;
  body: unknown;
  /** A correlation id; generated when omitted. */
  id?: string;
}

export interface RelayTransportOptions {
  /** e.g. `https://relay.example.com` (a trailing slash is tolerated). */
  relayUrl: string;
  /** The 26-character room id from `rooms.ts` — the URL path segment. */
  roomId: string;
  /** The AEAD key from `deriveRoom()` (`RoomKeys.encKey`). */
  encKey: Uint8Array;
  /**
   * `sha256(machineId + roomId)`: stable per machine per room, never a raw id.
   *
   * It is threaded here because the service and the transport share one options object;
   * the transport itself puts nothing about a device on the wire. §5 seals the `hello`
   * body (which is where a device id belongs) and §7's envelope has no field for one,
   * so a raw material the service may keep is simply never needed by this layer.
   */
  deviceId: string;
  /** Every decoded inbound frame addressed to us or broadcast. */
  onFrame: (frame: FrameEnvelope) => void;
  /** Phase changes and the drop counter. */
  onStatus: (status: TransportStatus) => void;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam; defaults to `HEARTBEAT_MS`. */
  heartbeatMs?: number;
  /** Test seam; defaults to `MAX_POST_PER_SECOND`. */
  maxPostPerSecond?: number;
  /** Test seam; defaults to `MAX_QUEUE_BYTES`. */
  maxQueueBytes?: number;
}

/**
 * One room connection.
 *
 * `start()` after `stop()` is allowed (it is how a settings change is applied);
 * `stop()` is final until then and releases every timer and socket.
 *
 * Threading: every asynchronous continuation carries the connection's `epoch`, and
 * `epoch++` happens in exactly two places (`fail` and `stop`). A continuation whose
 * epoch is stale — a join that answers after the link was replaced, a reader loop that
 * wakes up after `stop()` — therefore returns instead of writing to a connection that no
 * longer exists. That single rule is what makes "start after stop" and "reconnect" safe
 * without a second state machine.
 */
export class RelayTransport {
  /** The plaintext of every frame waiting to be sealed and posted, and its byte count. */
  private queue: QueueItem[] = [];
  private queueBytes = 0;

  private phase: TransportPhase = 'idle';
  private peer: string | null = null;
  private retryAt: number | undefined;
  private lastError: string | undefined;
  private droppedOut = 0;
  private refused: InboundRefusalCounts = emptyRefusals();

  /** True while an attempt loop is live (connecting, online or backoff). */
  private running = false;
  private epoch = 0;
  private conn: AbortController | null = null;
  /**
   * This connection's salt — the fresh random uint32 §4 requires, stamped onto every
   * slice as `s`. Reused only if the connection is, which is the point of the nonce.
   */
  private salt = 0;
  private seq = 0;
  /**
   * One 64-wide replay window per **sender salt** (§4), least-recently-used and bounded at
   * {@link REPLAY_SALTS_MAX}. It is cleared with the connection: every join draws a fresh
   * salt and every sender's `seq` restarts at 1, so no window may outlive the link it
   * describes.
   */
  private readonly windows = new Map<number, ReplayWindow>();
  private readonly assembler = new FrameReassembler();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The pump's sleep-like wait for new work; there is no timer behind it. */
  private waiter: (() => void) | null = null;
  private tokens = 0;
  private tokensAt = 0;
  private attempt = 0;
  /** True while a frame has been taken off the queue and is not fully posted yet. */
  private inFlight = false;

  constructor(private readonly options: RelayTransportOptions) {}

  get status(): TransportStatus {
    const status: TransportStatus = {
      phase: this.phase,
      peerId: this.peer,
      dropped: this.droppedOut,
      inboundRefused: { ...this.refused },
    };
    if (this.retryAt !== undefined) {
      status.retryAt = this.retryAt;
    }
    if (this.lastError !== undefined) {
      status.error = this.lastError;
    }
    return status;
  }

  /** The relay-assigned peer id for the current connection, or null. */
  get peerId(): string | null {
    return this.peer;
  }

  /** Start (or restart) the connection. Idempotent while already running. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.attempt = 0;
    this.droppedOut = 0;
    this.refused = emptyRefusals();
    this.lastError = undefined;
    this.retryAt = undefined;
    this.peer = null;
    // A deliberate stop or a terminal error is not "the peer could not keep up", so the
    // frames still waiting are thrown away without touching the drop counter.
    this.clearQueue();
    this.epoch += 1;
    void this.connect(this.epoch);
  }

  /** Tear down for good: abort the stream, drop the queue, cancel every timer. */
  stop(): void {
    this.running = false;
    this.epoch += 1;
    this.abortConnection();
    this.clearTimers();
    this.clearQueue();
    this.inFlight = false;
    this.peer = null;
    this.retryAt = undefined;
    this.lastError = undefined;
    this.phase = 'idle';
    this.publish();
  }

  /**
   * Seal, slice and post one frame.
   *
   * Returns `false` when the frame was dropped instead of queued (not online, or the
   * bounded queue is full); the drop is counted in `status.dropped`. A frame that is
   * dropped is not retried — the caller re-sends state, never a half-delivered frame.
   *
   * Never throws, for the same reason the reader loop never throws: this is called from
   * the mirror seam, which runs on the local webview's path, and a mirror must not be
   * able to take the owner's window down. A frame the contract itself refuses (an empty
   * `type`, a missing body) is therefore a counted drop, not an exception.
   */
  send(frame: OutboundFrame): boolean {
    if (this.phase !== 'online' || this.peer === null) {
      return this.drop();
    }
    let plaintext: string;
    try {
      plaintext = encodeFrame({
        v: FRAME_VERSION,
        type: frame.type,
        id: frame.id ?? newFrameId(),
        from: this.peer,
        to: frame.to,
        body: frame.body,
      });
    } catch {
      return this.drop();
    }
    const bytes = Buffer.byteLength(plaintext, 'utf8');
    if (this.queueBytes + bytes > this.queueBound()) {
      return this.drop();
    }
    this.queue.push({ plaintext, bytes });
    this.queueBytes += bytes;
    this.wakePump();
    return true;
  }

  // ------------------------------------------------ the connection --------

  /** Join the room, then hand the connection to the reader loop and the outbound pump. */
  private async connect(epoch: number): Promise<void> {
    const problem = urlProblem(this.joinUrl());
    if (problem) {
      this.fail(`the relay URL is not usable: ${problem}`, false);
      return;
    }
    if (!this.live(epoch)) {
      return;
    }
    this.phase = 'connecting';
    this.retryAt = undefined;
    this.publish();

    const conn = new AbortController();
    this.conn = conn;
    // A relay that accepts the connection and then never answers `join` would otherwise
    // leave the transport parked in `connecting` for good: nothing else is armed yet, so
    // this request carries its own deadline (dropped as soon as the headers arrive, since
    // the body below must be allowed to finish).
    const guard = new AbortController();
    const forward = () => guard.abort();
    conn.signal.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    const deadline = this.after(POST_TIMEOUT_MS, () => {
      timedOut = true;
      guard.abort();
    });
    let response: Response;
    try {
      response = await this.fetch(this.joinUrl(), { method: 'POST', signal: guard.signal });
    } catch (err) {
      if (this.live(epoch) && !conn.signal.aborted) {
        this.fail(timedOut ? `join stayed unanswered for ${POST_TIMEOUT_MS} ms` : `join failed: ${reasonOf(err)}`, true);
      }
      return;
    } finally {
      this.clearTimer(deadline);
      conn.signal.removeEventListener('abort', forward);
    }
    if (!this.live(epoch)) {
      drainQuietly(response);
      return;
    }
    if (!response.ok) {
      const status = response.status;
      drainQuietly(response);
      // A 429 is "the room is full" and a 5xx is "the relay is unwell": both pass. Any
      // other status on `join` is the room id itself (the relay answers 404 for a
      // malformed one) or a refusal, and neither improves by waiting.
      this.fail(`join was refused with HTTP ${status}`, status === 429 || status >= 500);
      return;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      if (this.live(epoch)) {
        this.fail(`join answered unreadably: ${reasonOf(err)}`, true);
      }
      return;
    }
    if (!this.live(epoch)) {
      return;
    }
    const peer = peerIdOf(text);
    if (peer === null) {
      this.fail('join answered without a peer id (8 lowercase hex characters)', true);
      return;
    }

    // A new connection, from the salt up: `seq` starts at 1 and the salt is fresh, which
    // is what keeps a reconnect from reusing a nonce (§4). A reused salt here would be a
    // silent cryptographic failure, not a visible one — and now it is also visible on the
    // wire, because every slice of this connection carries it as `s`.
    this.peer = peer;
    this.salt = randomBytes(4).readUInt32BE(0);
    this.seq = 0;
    // One set of sender windows per connection, cleared with it: a reconnect mints a new
    // salt, every sender restarts its `seq` at 1, and a window that outlived its link would
    // refuse the new connection's frames.
    this.windows.clear();
    this.assembler.reset();
    this.tokens = 0;
    this.tokensAt = 0;
    this.attempt = 0;
    this.droppedOut = 0;
    this.lastError = undefined;
    this.phase = 'online';
    this.publish();

    const heartbeat = this.heartbeatMs();
    this.armIdle(epoch, heartbeat);
    this.scheduleHeartbeat(epoch, heartbeat);
    void this.readDown(epoch, conn, heartbeat);
    void this.pump(epoch, conn);
  }

  /**
   * Any transport failure funnels through here: the phase is published with the reason,
   * everything the dead connection owned is released, and — when the failure is one that
   * can pass — the next attempt is scheduled with exponential backoff and jitter.
   *
   * Nothing is replayed. The service above re-announces and re-attaches on the next
   * `online`, and a repeated `input` would be a session acted on twice.
   */
  private fail(reason: string, retryable: boolean): void {
    if (!this.running) {
      return;
    }
    this.epoch += 1;
    this.abortConnection();
    this.clearTimers();
    this.assembler.reset();
    // A dead link's windows go with it: the next join draws a new salt and every sender
    // starts at `seq` 1 again (see {@link acceptSeq}).
    this.windows.clear();
    // Frames still queued belong to the connection that just died, and so does a frame
    // whose slices were half posted. Count them: the service has to know that what it
    // posted never left.
    this.droppedOut += this.queue.length + (this.inFlight ? 1 : 0);
    this.inFlight = false;
    this.clearQueue();
    this.peer = null;
    this.lastError = reason;

    if (!retryable) {
      this.running = false;
      this.retryAt = undefined;
      this.phase = 'error';
      this.publish();
      return;
    }

    this.attempt += 1;
    const delay = backoffDelay(this.attempt);
    this.retryAt = Date.now() + delay;
    this.phase = 'backoff';
    this.publish();
    const epoch = this.epoch;
    this.after(delay, () => {
      if (this.live(epoch)) {
        void this.connect(epoch);
      }
    });
  }

  // ------------------------------------------------ downstream --------

  /**
   * Read the SSE body, forever.
   *
   * Every failure inside the loop — a malformed line, a half-assembled frame, a slice
   * whose `s` disagrees with the rest of its `fid`, a tag that does not verify, a sequence
   * number already seen — is *data*, not an exception: it is refused, counted and
   * forgotten, because a hostile or broken relay must not be able to take the transport
   * out of the room. What comes out of the loop is a frame opened under the envelope's own
   * facts: the AAD from `seq`/`fid`, and the nonce's other half from `s`.
   *
   * The only things that end the loop are the stream ending, the body going silent for
   * longer than the watchdog allows, and `stop()`.
   */
  private async readDown(epoch: number, conn: AbortController, heartbeat: number): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await this.fetch(this.downUrl(), {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
        signal: conn.signal,
      });
      if (!this.live(epoch)) {
        drainQuietly(response);
        return;
      }
      if (!response.ok) {
        drainQuietly(response);
        this.fail(`down was refused with HTTP ${response.status}`, true);
        return;
      }
      if (!response.body) {
        this.fail('down had no stream body', true);
        return;
      }
      reader = response.body.getReader();
      const stream = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await stream.read();
        if (!this.live(epoch)) {
          return;
        }
        if (done) {
          this.fail('the relay closed the stream', true);
          return;
        }
        // Anything at all counts as liveness, including the relay's `: ping` comment:
        // that comment is precisely what keeps undici's body timeout away.
        this.armIdle(epoch, heartbeat);
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf('\n');
        while (at !== -1) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf('\n');
          this.consumeLine(line);
        }
      }
    } catch (err) {
      if (this.live(epoch)) {
        this.fail(`the down stream failed: ${reasonOf(err)}`, true);
      }
    } finally {
      try {
        await reader?.cancel();
      } catch {
        // The stream is already gone; there is nothing to release.
      }
    }
  }

  /** One SSE line: a comment, an unknown field, or a slice. */
  private consumeLine(raw: string): void {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith(':')) {
      // A comment (`: ping` every 15 s from the relay) and a blank line between events.
      return;
    }
    if (!line.startsWith('data:')) {
      // `event:`, `id:`, `retry:` — nothing this contract defines. Ignore, never fail.
      return;
    }
    const payload = line.slice(5).trim();

    let slice: Slice;
    try {
      slice = decodeSlice(payload);
    } catch (err) {
      this.refuse(kindOf(err, 'malformed'));
      return;
    }

    let sealed: Buffer | null;
    try {
      sealed = this.assembler.push(slice);
    } catch (err) {
      this.refuse(err instanceof FrameSizeError ? 'size' : err instanceof FrameSliceError ? 'slice' : 'malformed');
      return;
    }
    if (!sealed) {
      return;
    }

    // The sender's salt, as its own envelope names it (§7) — not ours, and not anything
    // derived from `fid`: a frame from another connection was sealed under another nonce, and
    // guessing it is how a valid frame gets reported as tampering.
    const salt = decodeSalt(slice.s);

    let plaintext: string;
    try {
      plaintext = openFrame({
        encKey: this.options.encKey,
        aad: { seq: slice.seq, fid: slice.fid },
        salt,
        sealed,
      });
    } catch (err) {
      this.refuse(err instanceof FrameAuthError ? 'auth' : err instanceof FrameSizeError ? 'size' : 'malformed');
      return;
    }

    // Only *after* the tag verified: see {@link acceptSeq} for why an unauthenticated frame
    // must not move any window, and for why the window is per sender salt.
    try {
      this.acceptSeq(salt, slice.seq);
    } catch (err) {
      this.refuse(err instanceof FrameReplayError ? 'replay' : 'malformed');
      return;
    }

    let frame: FrameEnvelope;
    try {
      frame = decodeFrame(plaintext);
    } catch {
      this.refuse('envelope');
      return;
    }
    // The relay fans every frame out to the whole room; §5's `to` is the addressing
    // that survived the seal. A frame for someone else is normal traffic, not a refusal.
    if (frame.to !== '*' && frame.to !== this.peer) {
      return;
    }
    try {
      this.options.onFrame(frame);
    } catch {
      // A service bug must not close the room either.
    }
  }

  // ------------------------------------------------ upstream --------

  /**
   * Drain the queue forever, one slice at a time.
   *
   * The pump is where sealing, slicing, pacing and the 429 retry live, and it is a
   * separate loop precisely so that `send` can stay a synchronous, non-blocking
   * enqueue: the caller's webview never waits for a socket.
   */
  private async pump(epoch: number, conn: AbortController): Promise<void> {
    while (this.live(epoch)) {
      const item = this.queue.shift();
      if (!item) {
        await this.waitForWork(epoch);
        continue;
      }
      this.queueBytes -= item.bytes;
      this.inFlight = true;
      // `fid` derives nothing: it is a per-frame label (`newFrameId()`), and the salt
      // travels in its own envelope field, one value for the whole connection.
      const fid = newFrameId();
      this.seq += 1;
      const aad = { seq: this.seq, fid };
      let lines: string[];
      try {
        lines = sliceSealed(
          sealFrame({ encKey: this.options.encKey, aad, salt: this.salt, plaintext: item.plaintext }),
          aad,
          this.salt,
        ).map((slice) => encodeSlice(slice));
      } catch {
        // The contract refused this frame at the sender (it is over FRAME_MAX_BYTES).
        // There is nothing to post and nothing to retry: count it and move on.
        this.inFlight = false;
        this.drop();
        continue;
      }
      for (const line of lines) {
        if (!this.live(epoch)) {
          // The link died (or `stop()` ran) between two slices of this frame; `fail()`
          // counts the half-delivered frame, `stop()` deliberately does not.
          return;
        }
        await this.pace(epoch, conn.signal);
        if (!this.live(epoch)) {
          return;
        }
        const outcome = await this.postSlice(epoch, conn, line);
        if (outcome !== 'ok') {
          return;
        }
      }
      this.inFlight = false;
    }
  }

  /** One `up` POST, with the 429 retry the relay's rate limit requires. */
  private async postSlice(epoch: number, conn: AbortController, line: string): Promise<'ok' | 'abandoned' | 'failed'> {
    const url = this.upUrl();
    for (let attempt = 0; ; attempt += 1) {
      if (!this.live(epoch)) {
        return 'abandoned';
      }
      // One controller per POST, aborted either by the connection dying or by this
      // POST's own timeout: without the second, a relay that reads the body and then
      // never answers would wedge the pump for as long as the socket lives.
      const post = new AbortController();
      const onAbort = () => post.abort();
      conn.signal.addEventListener('abort', onAbort, { once: true });
      let timedOut = false;
      const deadline = this.after(POST_TIMEOUT_MS, () => {
        timedOut = true;
        post.abort();
      });
      try {
        const response = await this.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: line,
          signal: post.signal,
        });
        const status = response.status;
        try {
          // Read it: a body left unread keeps the socket out of the pool, and the
          // relay's answers are three bytes of JSON.
          await response.arrayBuffer();
        } catch {
          // Not ours to read; the status is what matters.
        }
        if (response.ok) {
          return 'ok';
        }
        if (status === 429 && attempt < RATE_LIMIT_RETRIES) {
          // Rate-limited, not refused: the frame is *this* close to being delivered, so
          // it is retried with a short (doubling) backoff rather than dropped.
          await this.sleep(Math.min(RATE_LIMIT_RETRY_MS * 2 ** attempt, RATE_LIMIT_RETRY_MAX_MS), conn.signal);
          if (!this.live(epoch)) {
            return 'abandoned';
          }
          continue;
        }
        this.fail(
          status === 429
            ? `up was rate-limited (HTTP 429) ${RATE_LIMIT_RETRIES + 1} times in a row`
            : `up was refused with HTTP ${status}`,
          true,
        );
        return 'failed';
      } catch (err) {
        // An abort because the connection was replaced or stopped is not a failure of
        // this POST; it is the reason it is going away.
        if (!this.live(epoch) || conn.signal.aborted) {
          return 'abandoned';
        }
        this.fail(timedOut ? `an up POST stayed unanswered for ${POST_TIMEOUT_MS} ms` : `up failed: ${reasonOf(err)}`, true);
        return 'failed';
      } finally {
        this.clearTimer(deadline);
        conn.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * Spend one POST from the token bucket, waiting when the bucket is empty.
   *
   * The bucket is the whole defence against the relay's per-peer limit: a 10 MiB frame
   * is 356 slices, and 356 POSTs in a burst would be one 429 after another. The wait is
   * abortable, so `stop()` and a reconnect never leave the pump parked on a sleep.
   */
  private async pace(epoch: number, signal: AbortSignal): Promise<void> {
    for (;;) {
      const now = Date.now();
      const rate = this.postRate();
      if (this.tokensAt === 0) {
        this.tokensAt = now;
        this.tokens = MAX_POST_BURST;
      } else {
        this.tokens = Math.min(MAX_POST_BURST, this.tokens + ((now - this.tokensAt) * rate) / 1000);
        this.tokensAt = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) * 1000) / rate), signal);
      if (!this.live(epoch)) {
        return;
      }
    }
  }

  // ------------------------------------------------ the clocks --------

  /** The application `ping`, one per heartbeat, through the same queue as everything else. */
  private scheduleHeartbeat(epoch: number, heartbeat: number): void {
    this.heartbeatTimer = this.after(heartbeat, () => {
      this.heartbeatTimer = null;
      if (!this.live(epoch)) {
        return;
      }
      this.send({ type: 'ping', to: '*', body: {} });
      this.scheduleHeartbeat(epoch, heartbeat);
    });
  }

  /** (Re)arm the silent-stream watchdog; called for every chunk that arrives. */
  private armIdle(epoch: number, heartbeat: number): void {
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleTimer = this.after(heartbeat * IDLE_STREAM_FACTOR, () => {
      this.idleTimer = null;
      if (this.live(epoch)) {
        this.fail(`the relay sent nothing for ${heartbeat * IDLE_STREAM_FACTOR} ms`, true);
      }
    });
  }

  // ------------------------------------------------ plumbing --------

  /** Refuse one inbound slice/frame, count why, and tell the service. */
  private refuse(kind: keyof InboundRefusalCounts): void {
    this.refused[kind] += 1;
    this.publish();
  }

  /** Count one dropped outbound frame and tell the service about it. */
  private drop(): boolean {
    this.droppedOut += 1;
    this.publish();
    return false;
  }

  /**
   * Advance the replay window of the sender `salt` names, or throw {@link FrameReplayError}.
   *
   * ONE window per **sender**, never one per receiving connection. Every peer seals under its
   * own random salt and starts its own `seq` at 1, so a single window keyed on `seq` alone
   * refuses the second publisher's very first frame as a replay of the first publisher's
   * `seq` 1 — and once one peer has sent more than 64 frames, drops every later sender below
   * its floor. A room would look healthy and render exactly one member: the defect this
   * method exists to prevent, measured in a room of three.
   *
   * It is deliberately called **after** the tag has verified (`Connection.openSealed` in the
   * Kotlin peer does the same, for the same stated reason): a window advanced by an
   * unauthenticated frame would let the relay burn a sender's sequence with one forged
   * envelope — the victim's salt is public, it travels as `s` — and the genuine frames after
   * it would then be refused as replays. Unverified input must not move state.
   */
  private acceptSeq(salt: number, seq: number): void {
    let window = this.windows.get(salt);
    if (window) {
      // Touch it: this map *is* the LRU order (a Map keeps insertion order, so re-insert).
      this.windows.delete(salt);
    } else {
      window = new ReplayWindow();
      if (this.windows.size >= REPLAY_SALTS_MAX) {
        const oldest = this.windows.keys().next();
        if (!oldest.done) {
          this.windows.delete(oldest.value);
        }
      }
    }
    this.windows.set(salt, window);
    window.accept(seq);
  }

  private publish(): void {
    const status = this.status;
    try {
      this.options.onStatus(status);
    } catch {
      // The service's own callback must not be able to take the room down.
    }
  }

  private live(epoch: number): boolean {
    return this.running && epoch === this.epoch;
  }

  private abortConnection(): void {
    const conn = this.conn;
    this.conn = null;
    conn?.abort();
    // Wake the pump: it may be parked on `waitForWork` with nothing left to do.
    this.wakePump();
  }

  private clearQueue(): void {
    this.queue = [];
    this.queueBytes = 0;
  }

  private waitForWork(epoch: number): Promise<void> {
    if (!this.live(epoch)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const previous = this.waiter;
      this.waiter = resolve;
      // A previous pump (now stale) is woken too, so it can see its own epoch and leave.
      previous?.();
    });
  }

  private wakePump(): void {
    const wake = this.waiter;
    this.waiter = null;
    wake?.();
  }

  /** A tracked timer, so `stop()` can prove it left none behind. */
  private after(ms: number, run: () => void): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      run();
    }, Math.max(0, ms));
    this.timers.add(handle);
    return handle;
  }

  private clearTimer(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
    this.timers.delete(handle);
  }

  private clearTimers(): void {
    for (const handle of this.timers) {
      clearTimeout(handle);
    }
    this.timers.clear();
    this.heartbeatTimer = null;
    this.idleTimer = null;
  }

  /** A sleep that ends early on abort, and is always registered as a timer. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimer(handle);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const handle = this.after(ms, finish);
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  private heartbeatMs(): number {
    const value = this.options.heartbeatMs;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : HEARTBEAT_MS;
  }

  private postRate(): number {
    const value = this.options.maxPostPerSecond;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : MAX_POST_PER_SECOND;
  }

  private queueBound(): number {
    const value = this.options.maxQueueBytes;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : MAX_QUEUE_BYTES;
  }

  private base(): string {
    return String(this.options.relayUrl ?? '').replace(/\/+$/, '');
  }

  /** One request, through the caller's seam when one was supplied (`options.fetchImpl`). */
  private fetch(url: string, init: RequestInit): Promise<Response> {
    const impl = this.options.fetchImpl ?? fetch;
    return impl(url, init);
  }

  private joinUrl(): string {
    return `${this.base()}/v1/room/${this.options.roomId}/join`;
  }

  private downUrl(): string {
    return `${this.base()}/v1/room/${this.options.roomId}/down?peer=${encodeURIComponent(this.peer ?? '')}`;
  }

  private upUrl(): string {
    return `${this.base()}/v1/room/${this.options.roomId}/up?peer=${encodeURIComponent(this.peer ?? '')}`;
  }
}

/** One frame waiting for the pump: the sealed plaintext, built once by `send`. */
interface QueueItem {
  readonly plaintext: string;
  readonly bytes: number;
}

function emptyRefusals(): InboundRefusalCounts {
  return { malformed: 0, slice: 0, size: 0, replay: 0, auth: 0, envelope: 0 };
}

/**
 * How many senders' replay windows one receiving connection remembers — §8's "peers per
 * room", i.e. room for one window per peer that could ever talk to us.
 *
 * WHY a bound at all: §4 makes the window per **connection salt**, and every peer seals under
 * its own random salt (`s`), so a receiving connection meets as many salts as it has peers.
 * The map is not growable by the relay — a salt only earns a window once a frame under it
 * verified the GCM tag, and that needs `encKey`, which is derived from the room token — but a
 * bound is still what stops a bug, or a future route, from growing it without limit.
 *
 * Eviction is least-recently-used, and its cost is stated rather than hidden: a sender whose
 * window was evicted starts from a blank one, so a frame it sent *before* the eviction could
 * be delivered a second time. That is exactly why this bound is not a security boundary —
 * filling sixteen windows takes sixteen authenticated connections, which takes the room token,
 * which (§9) already buys full control of every publisher in the room. What the bound defends
 * is memory, not the room; the replay defence that matters is *within* one salt, and eviction
 * never touches it.
 *
 * `remote/android/core/.../ReplayWindow.kt` (`ReplayWindows`, `Protocol.PEERS_PER_ROOM`) uses
 * the same number for the same reason: two implementations that disagreed here would render a
 * different set of peers out of one room.
 */
export const REPLAY_SALTS_MAX = 16;

/**
 * Exponential backoff with jitter, capped.
 *
 * The jitter covers the upper half of the interval rather than being uniform over all of
 * it: the delay is never near zero (a retry storm against a relay that is coming back up
 * is how a small outage becomes a large one) and a roomful of windows that lost the same
 * relay does not return in lockstep.
 */
export function backoffDelay(attempt: number): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(Math.max(attempt, 1) - 1, 6));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** The `join` answer, or `null` when it is not the 8 lowercase hex characters §2 promises. */
function peerIdOf(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const peer = (parsed as { peer?: unknown } | null)?.peer;
  return typeof peer === 'string' && /^[0-9a-f]{8}$/.test(peer) ? peer : null;
}

/** Turn any thrown value into one short line for the status. */
function reasonOf(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

/** Map a `frames.ts` failure onto its tally, with the caller's fallback for anything else. */
function kindOf(err: unknown, fallback: keyof InboundRefusalCounts): keyof InboundRefusalCounts {
  if (err instanceof FrameReplayError) {
    return 'replay';
  }
  if (err instanceof FrameAuthError) {
    return 'auth';
  }
  if (err instanceof FrameSizeError) {
    return 'size';
  }
  if (err instanceof FrameSliceError) {
    return 'slice';
  }
  return fallback;
}

/** Release a response this connection no longer wants, without ever throwing at the caller. */
function drainQuietly(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Nothing to release.
  }
}

/** Is this a URL `fetch` can use? An unusable one is an `error`, never a retry loop. */
function urlProblem(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `${parsed.protocol} is not http or https`;
    }
    return null;
  } catch {
    return 'it is not an absolute URL';
  }
}
