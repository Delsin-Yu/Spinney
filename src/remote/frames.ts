/**
 * frames.ts — the room's frame envelope: seal, slice, reassemble, open, and the replay
 * defence that sits in front of opening.
 *
 * A frame is one logical message. It is sealed **once** (AES-256-GCM, tag appended) and
 * then cut into transport slices of at most {@link SLICE_MAX_BASE64} base64 characters
 * each, because a single SSE event over a relay must stay small. Sealing once (never per
 * slice) is what makes a slice boundary a transport detail: the receiver reassembles by
 * `fid` and then opens the whole thing, so a re-slicing on any hop cannot invalidate the
 * tag. Where the slices are cut is the sender's choice and is deliberately not part of the
 * contract — a receiver concatenates and never inspects the boundaries, so two
 * implementations may chunk the same frame differently and still interoperate.
 *
 * Three layers, and keeping them apart is the whole design:
 *
 * - the **AAD** (`v|seq|fid`) — the three facts a receiver already has *before* it can
 *   decrypt, and therefore the only ones it can bind. It cannot be anything else: the
 *   sealed bytes are reassembled first and opened second, so an AAD naming `type`, `from`
 *   or `to` could never be reconstructed on the receiving side. Everything else about a
 *   frame lives **inside** the sealed plaintext and is authenticated by the GCM tag
 *   itself, which is why a peer that re-labels or retargets a frame cannot produce a valid
 *   tag for the plaintext it would have to change.
 * - the **transport envelope** per slice (`v`,`seq`,`s`,`fid`,`idx`,`last`,`b`) — framing
 *   only, forwarded verbatim by the relay, which learns traffic shape and nothing semantic.
 *   `s` is the connection salt: §4 makes the nonce `be64(seq) || be32(salt)`, and a receiver
 *   has to build that nonce *before* it can decrypt anything, so the salt must be readable
 *   on the envelope. It was implicit in an earlier draft and three implementations each
 *   invented a different private convention for it — the exact silent incompatibility the
 *   vectors exist to catch. One salt per **connection**, repeated on every slice it sends.
 * - the **logical frame JSON** (`v`,`type`,`id`,`from`,`to`,`body`) — sealed, so the relay
 *   never sees a type or a peer id.
 *
 * `idx`/`last` are deliberately not in the AAD: they describe a *slice*, and there is one
 * nonce per logical frame. A tampered `idx`/`last` cannot forge anything — it corrupts
 * reassembly, and the reassembled bytes then fail the tag.
 *
 * Error taxonomy: a caller must be able to tell the four failures apart, because they
 * mean different things to the transport. {@link FrameFormatError} — the bytes or the
 * caller's fields are not a frame (a bug or a protocol violation). {@link FrameSizeError}
 * — a hard cap was hit; never truncated, always refused. {@link FrameAuthError} — the tag
 * did not verify (tampered, or the wrong key/salt/AAD). {@link FrameReplayError} — the
 * sequence number is not fresh. {@link FrameSliceError} — the slice stream for one `fid`
 * is broken (out of order, duplicated, malformed, arriving after the final slice, or
 * carrying a `v`/`seq` that disagrees with the rest of its frame).
 *
 * `node:crypto` only, no `vscode`: this module runs in a plain node script too.
 *
 * The byte-level authority is `remote/PROTOCOL.md` §4 (sealing), §5 (the logical frame)
 * and §7 (the transport envelope and slicing); `remote/vectors/vectors.json` pins the
 * exact bytes, and `node tools/check-remote.js` reproduces them — including sealing the
 * reference plaintexts back into their reference `sealedHex`.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ENC_KEY_BYTES } from './rooms';

export { ENC_KEY_BYTES, PBKDF2_ITERATIONS } from './rooms';

/** The version carried in the AAD, the transport envelope and the logical frame. */
export const FRAME_VERSION = 1;
/** GCM tag length, appended to the ciphertext (`ciphertext || tag`). */
export const FRAME_TAG_BYTES = 16;
/** Nonce length: `be64 seq` (8) + `be32 salt` (4). The AES-GCM nonce size for this suite. */
export const NONCE_BYTES = 12;
/**
 * Hard cap on a **reassembled sealed frame**, in bytes (16 MiB). A frame that would cross
 * it is refused as a whole: the alternative — admitting the first 16 MiB — would hand the
 * caller a truncated ciphertext, and a truncated ciphertext is a frame that fails
 * authentication in a way nobody can diagnose.
 */
export const FRAME_MAX_BYTES = 16777216;
/** Maximum base64 characters in one transport slice (48000 is a multiple of 4, so every slice decodes on its own). */
export const SLICE_MAX_BASE64 = 48000;
/** Characters of a frame id: 16 lowercase hex. */
export const FRAME_ID_CHARS = 16;
/** Sliding-window width, per sender salt, of the replay defence. */
export const REPLAY_WINDOW_WIDTH = 64;
/**
 * How many frames may be mid-reassembly at once. Not a size cap: it exists so a peer that
 * opens frame ids and never sends their `last` slice cannot grow the reassembler without
 * bound (the mirror must never block, and it must never grow either).
 */
export const MAX_ASSEMBLIES = 64;
/** The `to` value meaning "every room member" — never a peer id. */
export const AAD_BROADCAST = '*';

const AES_ALGORITHM = 'aes-256-gcm';
const FRAME_ID_PATTERN = /^[0-9a-f]{16}$/;
const SALT_PATTERN = /^[0-9a-f]{8}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Base class of every frame failure, so a caller can catch the family in one place. */
export class FrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameError';
  }
}

/** The bytes or the caller's fields are not a frame: a bug, or a protocol violation. */
export class FrameFormatError extends FrameError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameFormatError';
  }
}

/** A hard cap (frame size, slice size, or the number of frames being reassembled) was hit. */
export class FrameSizeError extends FrameError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameSizeError';
  }
}

/** The GCM tag did not verify: tampered bytes, or a key/salt/AAD that does not match. */
export class FrameAuthError extends FrameError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameAuthError';
  }
}

/** The sequence number is not fresh: already accepted, or at or below the window floor. */
export class FrameReplayError extends FrameError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameReplayError';
  }
}

/** The slice stream for one frame id is broken. */
export class FrameSliceError extends FrameError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameSliceError';
  }
}

/**
 * The sealed logical frame: compact JSON, six keys, this order (`remote/PROTOCOL.md` §5).
 *
 * Everything semantic travels here — the `type`, the sender, the target — because that is
 * the only place it is hidden from the relay. `id` is the caller's own request/response
 * correlation id and `fid` (a slice field) is the transport's per-frame framing id: they
 * are independent, live for different lifetimes, and a sender that makes them equal is
 * making a choice, not following a rule.
 */
export interface FrameEnvelope {
  readonly v: typeof FRAME_VERSION;
  /** The remote-protocol message type (e.g. `mirror`, `input`, `ping`). */
  readonly type: string;
  /** The caller's correlation id; a `result` carries the `id` of the request it answers. */
  readonly id: string;
  /** The sending peer id. */
  readonly from: string;
  /** The addressed peer id, or {@link AAD_BROADCAST}. */
  readonly to: string;
  /** The message itself, verbatim — never re-shaped by the transport. */
  readonly body: unknown;
}

/**
 * The three facts the canonical AAD is built from, and nothing else: the version, the
 * frame's sequence number and its framing id.
 *
 * WHY it is this small: the AAD is built by the **receiver**, before it can decrypt
 * anything, out of what the transport envelope carries (and the envelope carries no
 * `type`, sender or target, or it would leak them). So these are the only fields that
 * *can* be bound. The rest of the frame is authenticated by the tag over the plaintext —
 * which is why an earlier, eight-field AAD was a bug rather than extra safety: it could
 * not be reconstructed on the receiving side at all.
 *
 * The type is an object rather than two parameters so {@link canonicalAad},
 * {@link sealFrame} and {@link sliceSealed} keep saying the same thing.
 */
export interface FrameAad {
  /** 1-based, monotonic per connection, never reused. */
  readonly seq: number;
  /** 16 lowercase hex characters, shared by every slice of this frame. */
  readonly fid: string;
}

/** One transport slice: the wire's seven keys, in the wire's order (`remote/PROTOCOL.md` §7). */
export interface Slice {
  readonly v: typeof FRAME_VERSION;
  /** The sequence number of the frame this slice belongs to — half the nonce, so not secret. */
  readonly seq: number;
  /** The connection salt, 8 lowercase hex — the other half of the nonce ({@link encodeSalt}). */
  readonly s: string;
  /** The frame this slice belongs to — the reassembly key. */
  readonly fid: string;
  /** 0-based position; slices arrive in order and exactly once. */
  readonly idx: number;
  /** True on the final slice only. */
  readonly last: boolean;
  /** Base64 of this slice's bytes, at most {@link SLICE_MAX_BASE64} characters. */
  readonly b: string;
}

/** Is this a well-formed frame id (16 lowercase hex)? Shared by the AAD, slices and the caller. */
export function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && FRAME_ID_PATTERN.test(value);
}

/**
 * A fresh frame id. 8 random bytes: a frame id is not a secret — it is an unguessable
 * *label*, so that two frames in flight at the same moment cannot be confused and a
 * hostile member cannot pre-open an assembly for someone else's frame.
 */
export function newFrameId(): string {
  return randomBytes(FRAME_ID_CHARS / 2).toString('hex');
}

/**
 * The canonical AAD string: `v|seq|fid`, field order fixed, decimals unpadded — e.g.
 * `1|7|0011223344556677`. See {@link FrameAad} for why it is these three and no more.
 *
 * The `idx`/`last`/`type`/`from`/`to` fields the string used to carry are gone with the
 * bug that put them there, and a caller still passing them must fail **loudly**: an AAD
 * object with any key other than `seq`/`fid` is refused. Silently ignoring the extra keys
 * would let a stale call site keep authenticating under a shape the other implementations
 * do not use, which is a protocol split that only shows up as "frames from that peer never
 * open".
 */
export function canonicalAad(aad: FrameAad): string {
  for (const key of Object.keys(aad)) {
    if (key !== 'seq' && key !== 'fid') {
      throw new FrameFormatError(
        `the AAD is v|seq|fid; a "${key}" field is not part of it (it lives inside the sealed plaintext, where the tag covers it)`,
      );
    }
  }
  checkSeq(aad.seq);
  if (!isFrameId(aad.fid)) {
    throw new FrameFormatError(`AAD fid must be ${FRAME_ID_CHARS} lowercase hex characters, got ${JSON.stringify(aad.fid)}`);
  }
  return [FRAME_VERSION, aad.seq, aad.fid].join('|');
}

/**
 * The connection salt as it travels: 8 lowercase hex characters, big-endian uint32.
 *
 * WHY it is on the wire at all: the nonce is `be64(seq) || be32(salt)` (§4), and the nonce
 * is needed *before* anything can be decrypted, so the salt has to be readable on the
 * envelope (`s`). It is not secret — it is random, not confidential.
 *
 * **One salt per connection, never per frame.** Every frame a connection sends repeats the
 * same `s`, and `seq` restarts at 1 on every reconnect; the fresh salt is the only thing
 * that keeps a reconnect from reusing a nonce under the same `encKey`. Reusing a
 * (key, nonce) pair in AES-GCM is the one unrecoverable bug in this protocol — it leaks the
 * XOR of two plaintexts and the authentication subkey, so it is not a "wrong frame", it is
 * the key. A sender must therefore generate its salt with a CSPRNG once per connection and
 * never derive it from anything else.
 */
export function encodeSalt(salt: number): string {
  checkSalt(salt);
  return salt.toString(16).padStart(8, '0');
}

/**
 * Parse a wire salt ({@link encodeSalt}) back into the uint32 the nonce needs. Strict on
 * purpose: a sloppy `s` (wrong length, non-hex, uppercase) is a refusal, not a coercion —
 * silently reading `1A2B3C4D` or `1a2b3c4` as a number would have the receiver build a
 * *different* nonce than the sender and report the mismatch as tampering, which is the
 * wrong diagnosis for a transport bug.
 */
export function decodeSalt(hex: string): number {
  if (typeof hex !== 'string' || !SALT_PATTERN.test(hex)) {
    throw new FrameFormatError(`a wire salt must be 8 lowercase hex characters, got ${JSON.stringify(hex)}`);
  }
  return Number.parseInt(hex, 16);
}

/**
 * The 12-byte nonce: `be64 seq || be32 salt`. The salt is per connection and random, so
 * two connections that both start at `seq: 1` still use different nonces — which is the
 * whole point: an AES-GCM nonce must never repeat under one key, and the sequence number
 * alone would repeat on every reconnect. See {@link encodeSalt} for why that matters more
 * than anything else in this file.
 */
export function frameNonce(seq: number, salt: number): Buffer {
  checkSeq(seq);
  checkSalt(salt);
  const nonce = Buffer.alloc(NONCE_BYTES);
  nonce.writeBigUInt64BE(BigInt(seq), 0);
  nonce.writeUInt32BE(salt, 8);
  return nonce;
}

/** Input of {@link sealFrame}. */
export interface SealOptions {
  /** The room's `encKey` (`deriveRoom`). */
  readonly encKey: Uint8Array;
  /** The frame's sequence number and framing id — the whole AAD. */
  readonly aad: FrameAad;
  /**
   * This connection's random salt — the other half of the nonce, stamped onto every slice
   * as `s` ({@link encodeSalt}). The sender chose it, so it is passed in rather than
   * derived here: it must be one value per connection, and this module never sees a
   * connection.
   */
  readonly salt: number;
  /** The logical frame, as UTF-8 text (the JSON of a {@link FrameEnvelope}). */
  readonly plaintext: string;
}

/** Input of {@link openFrame}. */
export interface OpenOptions {
  readonly encKey: Uint8Array;
  readonly aad: FrameAad;
  /**
   * The connection salt the **sender** used. On the receiving side the only legitimate
   * source for it is the envelope's own field, `decodeSalt(slice.s)` — not a value this
   * side picked, and never a value read back out of the nonce it is trying to build. Taking
   * it from anywhere else is how two implementations end up disagreeing about a frame that
   * is perfectly valid.
   */
  readonly salt: number;
  /** `ciphertext || tag`, exactly what {@link sealFrame} returned. */
  readonly sealed: Uint8Array;
}

/**
 * Seal one logical frame: AES-256-GCM, tag appended, nonce from `seq` + `salt`, AAD from
 * {@link canonicalAad}. Nothing else — no compression, no padding, no re-encoding — so the
 * sealed bytes are a function of the frame and the key alone.
 *
 * The size check runs **before** any crypto: an oversized frame must fail as a `Size`
 * error at the sender, where it is a bug in the caller, rather than reach a receiver that
 * can only abandon it. The cap is applied to the sealed length (`plaintext + tag`), since
 * that is what a receiver has to reassemble.
 */
export function sealFrame(options: SealOptions): Buffer {
  const key = checkEncKey(options.encKey, 'sealFrame');
  const plaintext = Buffer.from(options.plaintext, 'utf8');
  if (plaintext.length > FRAME_MAX_BYTES - FRAME_TAG_BYTES) {
    throw new FrameSizeError(
      `sealFrame: ${plaintext.length} plaintext bytes would seal to more than FRAME_MAX_BYTES (${FRAME_MAX_BYTES}); a frame is refused whole, never truncated`,
    );
  }
  const cipher = createCipheriv(AES_ALGORITHM, key, frameNonce(options.aad.seq, options.salt));
  cipher.setAAD(Buffer.from(canonicalAad(options.aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]);
}

/**
 * Open a sealed frame and return its UTF-8 plaintext.
 *
 * A failure here is always reported as {@link FrameAuthError} — the wrong key, the wrong
 * salt, an AAD that does not match the one the sender sealed with, or tampered bytes. GCM
 * authenticates before it releases plaintext, so no partial output can ever escape this
 * function; the underlying reason is kept as `cause` for the diagnostics log, never
 * turned into a different error class, because a sender must not learn *which* field was
 * wrong from the failure alone.
 *
 * The caller owes this function one thing, and it is the **opposite** of what an earlier
 * draft of this file said: open the frame **first**, and advance the replay window only
 * after the tag verifies. The salt is public — it travels in the envelope (§7) — and the
 * window is keyed by it, so a caller that advanced first could be made to burn a real
 * sender's window with a garbage-tagged envelope that merely *claims* that sender's salt,
 * after which a keyless relay could mute that peer silently by exhausting its sequence
 * space. GCM is cheap next to that: unverified input must not move state. See the module
 * header.
 */
export function openFrame(options: OpenOptions): string {
  const key = checkEncKey(options.encKey, 'openFrame');
  const sealed = toBuffer(options.sealed);
  if (sealed.length < FRAME_TAG_BYTES) {
    throw new FrameFormatError(`openFrame: a sealed frame is at least ${FRAME_TAG_BYTES} bytes (the GCM tag), got ${sealed.length}`);
  }
  if (sealed.length > FRAME_MAX_BYTES) {
    throw new FrameSizeError(`openFrame: ${sealed.length} bytes exceeds FRAME_MAX_BYTES (${FRAME_MAX_BYTES})`);
  }
  // Validated before the key is used, so a malformed AAD is a *format* error and never
  // gets the chance to look like a tampering failure.
  const aad = canonicalAad(options.aad);
  const decipher = createDecipheriv(AES_ALGORITHM, key, frameNonce(options.aad.seq, options.salt));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.subarray(sealed.length - FRAME_TAG_BYTES));
  try {
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - FRAME_TAG_BYTES)),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (err) {
    throw new FrameAuthError(
      `frame ${options.aad.fid}#${options.aad.seq} failed authentication (wrong key, salt, nonce, AAD, or tampered bytes)`,
      { cause: err },
    );
  }
}

/**
 * Cut sealed bytes into transport slices. `sealed` must already be sealed — this is a
 * splitter, not a second crypto path, and it exists so the boundary rule (`at most
 * SLICE_MAX_BASE64` base64 characters, `idx` from 0, `last` on the final one, and the same
 * `v`/`seq`/`s`/`fid` on every slice) is written down in exactly one place.
 *
 * The salt is stamped here rather than left to the caller for the same reason the sequence
 * number is: a slice set whose parts disagree about `s` describes two connections at once,
 * and a receiver must never have to decide which of its own slices to believe.
 *
 * `SLICE_MAX_BASE64` is a multiple of 4, so every slice is whole base64: a receiver can
 * decode any slice on its own without carrying bits across slices. The chunk size is the
 * cap because a bigger slice is a bigger SSE event with nothing gained; the reference
 * vectors use 30000 raw bytes (40000 base64 characters), which is legal for the same
 * reason — the boundaries are the sender's choice.
 */
export function sliceSealed(sealed: Uint8Array, aad: FrameAad, salt: number): Slice[] {
  checkSeq(aad.seq);
  if (!isFrameId(aad.fid)) {
    throw new FrameSliceError(`sliceSealed: fid must be ${FRAME_ID_CHARS} lowercase hex characters, got ${JSON.stringify(aad.fid)}`);
  }
  const s = encodeSalt(salt);
  const bytes = toBuffer(sealed);
  if (bytes.length > FRAME_MAX_BYTES) {
    throw new FrameSizeError(`sliceSealed: ${bytes.length} bytes exceeds FRAME_MAX_BYTES (${FRAME_MAX_BYTES})`);
  }
  const base64 = bytes.toString('base64');
  const slices: Slice[] = [];
  if (base64.length === 0) {
    return [{ v: FRAME_VERSION, seq: aad.seq, s, fid: aad.fid, idx: 0, last: true, b: '' }];
  }
  for (let start = 0; start < base64.length; start += SLICE_MAX_BASE64) {
    slices.push({
      v: FRAME_VERSION,
      seq: aad.seq,
      s,
      fid: aad.fid,
      idx: slices.length,
      last: false,
      b: base64.slice(start, start + SLICE_MAX_BASE64),
    });
  }
  const final = slices[slices.length - 1];
  slices[slices.length - 1] = { ...final, last: true };
  return slices;
}

/** Seal a logical frame and slice it in one step — the sender's normal path. */
export function sealAndSlice(options: SealOptions): Slice[] {
  return sliceSealed(sealFrame(options), options.aad, options.salt);
}

/**
 * Encode one slice as the transport line the relay forwards verbatim: compact JSON with
 * exactly the seven keys `v`,`seq`,`s`,`fid`,`idx`,`last`,`b`, in that order
 * (`remote/PROTOCOL.md` §7). A canonical byte shape is what lets two implementations
 * produce the same line for the same slice, and it keeps the relay's job to "move this
 * string" — it never parses one.
 */
export function encodeSlice(slice: Slice): string {
  if (slice?.v !== FRAME_VERSION) {
    throw new FrameFormatError(`encodeSlice: v must be ${FRAME_VERSION}, got ${String(slice?.v)}`);
  }
  checkSeq(slice.seq);
  decodeSalt(slice.s);
  if (!isFrameId(slice.fid)) {
    throw new FrameFormatError(`encodeSlice: fid must be ${FRAME_ID_CHARS} lowercase hex characters, got ${JSON.stringify(slice.fid)}`);
  }
  if (!Number.isSafeInteger(slice.idx) || slice.idx < 0) {
    throw new FrameFormatError(`encodeSlice: idx must be an integer >= 0, got ${String(slice.idx)}`);
  }
  if (typeof slice.last !== 'boolean') {
    throw new FrameFormatError(`encodeSlice: last must be a boolean, got ${String(slice.last)}`);
  }
  checkSlicePayload(slice.b, `encodeSlice: ${slice.fid}#${slice.idx}`);
  return JSON.stringify({ v: slice.v, seq: slice.seq, s: slice.s, fid: slice.fid, idx: slice.idx, last: slice.last, b: slice.b });
}

/**
 * Parse one transport line. Unknown keys are refused, like the logical frame's decoder:
 * this envelope is a fixed seven-key contract, and an eighth key would travel to a receiver
 * that does not know it while every implementation kept working. A missing or sloppy `s` is
 * refused for the same reason — it is half the nonce, and guessing it would report a
 * transport bug as tampering.
 */
export function decodeSlice(text: string): Slice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new FrameFormatError('decodeSlice: the transport line is not JSON', { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FrameFormatError('decodeSlice: the transport line is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'v' && key !== 'seq' && key !== 's' && key !== 'fid' && key !== 'idx' && key !== 'last' && key !== 'b') {
      throw new FrameFormatError(`decodeSlice: unknown slice key ${JSON.stringify(key)}`);
    }
  }
  if (record.v !== FRAME_VERSION) {
    throw new FrameFormatError(`decodeSlice: v must be ${FRAME_VERSION}, got ${JSON.stringify(record.v)}`);
  }
  checkSeq(record.seq);
  decodeSalt(record.s as string);
  if (!isFrameId(record.fid)) {
    throw new FrameFormatError(`decodeSlice: fid must be ${FRAME_ID_CHARS} lowercase hex characters, got ${JSON.stringify(record.fid)}`);
  }
  if (!Number.isSafeInteger(record.idx) || (record.idx as number) < 0) {
    throw new FrameFormatError(`decodeSlice: idx must be an integer >= 0, got ${JSON.stringify(record.idx)}`);
  }
  if (typeof record.last !== 'boolean') {
    throw new FrameFormatError(`decodeSlice: last must be a boolean, got ${JSON.stringify(record.last)}`);
  }
  checkSlicePayload(record.b, `decodeSlice: ${record.fid}#${String(record.idx)}`);
  return {
    v: FRAME_VERSION,
    seq: record.seq,
    s: record.s as string,
    fid: record.fid,
    idx: record.idx as number,
    last: record.last,
    b: record.b as string,
  };
}

/**
 * Reassembles slices into the sealed bytes they were cut from, keyed by `fid`, so several
 * frames may be in flight at once and interleave.
 *
 * What it refuses, and why each one is not negotiable:
 *
 * - a slice whose `idx` is not the next one expected — including a duplicate, and
 *   including the first slice of a frame that does not start at 0. Slices are ordered and
 *   delivered exactly once; silently accepting a hole would mean reassembling a frame that
 *   never existed, which then fails authentication with no explanation.
 * - a slice whose `v`, `seq` or `s` disagrees with the slices already collected under its
 *   `fid` (`remote/PROTOCOL.md` §7 makes a mismatch an error). `fid` is only a label a
 *   hostile relay can reuse, and `seq` + `s` are what make the frame's nonce and AAD
 *   unique: mixing two frames' slices under one id would otherwise hand the caller a buffer
 *   that cannot be opened, with the sender blamed for it. The `s` check is the one that
 *   matters most — a receiver that accepted two salts under one `fid` would be reading a
 *   frame whose nonce it can only guess.
 * - a slice for a frame that is already complete: the frame was returned to the caller, so
 *   the slice belongs to nothing.
 * - a `b` that is not whole base64, or longer than {@link SLICE_MAX_BASE64} (a `Size`
 *   error: it is the slice cap, not a stream-ordering problem). A lenient decode (Node
 *   ignores invalid characters) would turn a malformed slice into a shorter frame — a
 *   tampering-shaped failure instead of a transport-shaped one.
 * - crossing {@link FRAME_MAX_BYTES}, and opening more than {@link MAX_ASSEMBLIES} frames
 *   at once. Both abandon the whole assembly: a partial buffer is never handed out.
 *
 * No timers: a pure module owns no clock. A connection that goes away calls {@link reset}.
 */
export class FrameReassembler {
  private readonly pending = new Map<string, { seq: number; s: string; parts: Buffer[]; bytes: number }>();

  /**
   * Feed one slice. Returns the sealed bytes when this slice completes its frame, or
   * `null` while the frame is still incomplete.
   */
  push(slice: Slice): Buffer | null {
    if (slice?.v !== FRAME_VERSION) {
      throw new FrameSliceError(`a slice must carry v ${FRAME_VERSION}, got ${JSON.stringify(slice?.v)}`);
    }
    if (!isFrameId(slice.fid)) {
      throw new FrameSliceError(`a slice must carry a ${FRAME_ID_CHARS}-character lowercase hex fid, got ${JSON.stringify(slice.fid)}`);
    }
    const { fid, seq, idx, last, b } = slice;
    checkSeq(seq);
    try {
      decodeSalt(slice.s);
    } catch {
      // Re-thrown inside this class's own family: a slice with an unreadable salt is a
      // broken slice stream first, and the caller of `push` catches slice errors.
      throw new FrameSliceError(`slice ${fid}#${String(idx)}: s must be 8 lowercase hex characters, got ${JSON.stringify(slice.s)}`);
    }
    if (!Number.isSafeInteger(idx) || idx < 0) {
      throw new FrameSliceError(`slice ${fid}#${String(idx)}: idx must be an integer >= 0`);
    }
    if (typeof last !== 'boolean') {
      throw new FrameSliceError(`slice ${fid}#${idx}: last must be a boolean`);
    }
    if (typeof b !== 'string' || b.length % 4 !== 0 || !BASE64_PATTERN.test(b)) {
      throw new FrameSliceError(`slice ${fid}#${idx}: b must be whole base64`);
    }
    if (b.length > SLICE_MAX_BASE64) {
      throw new FrameSizeError(`slice ${fid}#${idx}: ${b.length} base64 characters exceeds SLICE_MAX_BASE64 (${SLICE_MAX_BASE64})`);
    }
    let open = this.pending.get(fid);
    if (!open) {
      if (idx !== 0) {
        throw new FrameSliceError(`slice ${fid}#${idx}: the first slice of a frame must be idx 0 (or the frame was already completed)`);
      }
      if (this.pending.size >= MAX_ASSEMBLIES) {
        throw new FrameSizeError(`${MAX_ASSEMBLIES} frames are already being reassembled; refusing ${fid} rather than growing without bound`);
      }
      open = { seq, s: slice.s, parts: [], bytes: 0 };
      this.pending.set(fid, open);
    } else if (open.seq !== seq || open.s !== slice.s) {
      this.pending.delete(fid);
      throw new FrameSliceError(
        `slice ${fid}#${idx}: carries seq ${seq}/s ${slice.s}, but the slices already collected under ${fid} carry seq ${open.seq}/s ${open.s}; one frame is one seq and one connection salt`,
      );
    } else if (idx !== open.parts.length) {
      throw new FrameSliceError(`slice ${fid}#${idx}: expected idx ${open.parts.length} (slices arrive in order, exactly once)`);
    }
    const chunk = Buffer.from(b, 'base64');
    if (open.bytes + chunk.length > FRAME_MAX_BYTES) {
      this.pending.delete(fid);
      throw new FrameSizeError(
        `frame ${fid}: ${open.bytes + chunk.length} reassembled bytes exceeds FRAME_MAX_BYTES (${FRAME_MAX_BYTES}); the frame is abandoned`,
      );
    }
    open.parts.push(chunk);
    open.bytes += chunk.length;
    if (!last) {
      return null;
    }
    this.pending.delete(fid);
    return Buffer.concat(open.parts, open.bytes);
  }

  /** Forget every half-assembled frame (connection closed, or resynced). */
  reset(): void {
    this.pending.clear();
  }
}

/**
 * The replay defence: one instance per **sender salt** — the salt an outgoing envelope
 * names — 64 sequences wide. The caller owns the map from salt to window (bounded, one
 * entry per sender); this class knows nothing about senders.
 *
 * It is a sliding window rather than a high-water mark because frames can overtake each
 * other on a relay (two slices of a slow frame behind a fast one), so "must be greater
 * than the last one seen" would refuse legitimate traffic. The window is exactly
 * `REPLAY_WINDOW_WIDTH` wide: `(floor, highest]`, where `floor() = max(0, highest -
 * width)`.
 *
 * A sequence number **at** the floor is refused, not accepted, which is what makes the
 * window's edges unambiguous: the acceptable range is `floor + 1 .. highest` inclusive,
 * i.e. at most `width` values, and every other sequence number is either too old or a
 * duplicate. On a fresh window `floor()` is 0 and `accept(1)` is the only possible start,
 * because the contract starts every connection at `seq = 1`.
 *
 * A `seq` below 1 or not an integer is a `Format` error, not a replay: it is not a
 * sequence number at all, and reporting it as a replay would hide a protocol bug behind a
 * hostile-peer story.
 *
 * The class owns no clock and no I/O; a Set is used instead of a bitmask because the
 * window is 64 wide and the pruning rule (`drop everything at or below the new floor`) is
 * what matters, not the storage.
 */
export class ReplayWindow {
  private readonly width: number;
  private readonly seen = new Set<number>();
  private highest = 0;

  constructor(width: number = REPLAY_WINDOW_WIDTH) {
    if (!Number.isSafeInteger(width) || width < 1) {
      throw new FrameFormatError(`ReplayWindow: width must be a positive integer, got ${String(width)}`);
    }
    this.width = width;
  }

  /** The largest sequence number accepted so far (0 while nothing has been). */
  get highestSeq(): number {
    return this.highest;
  }

  /** The first sequence number that is out of the window — refused if presented. */
  floor(): number {
    return Math.max(0, this.highest - this.width);
  }

  /** Accept one sequence number, or throw {@link FrameReplayError}. Call before `openFrame`. */
  accept(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new FrameFormatError(`ReplayWindow: seq must be an integer >= 1, got ${String(seq)}`);
    }
    const floor = this.floor();
    if (seq <= floor) {
      throw new FrameReplayError(
        `seq ${seq} is at or below the replay window floor (${floor}); the highest accepted on this connection is ${this.highest}`,
      );
    }
    if (this.seen.has(seq)) {
      throw new FrameReplayError(`seq ${seq} was already accepted on this connection salt`);
    }
    this.seen.add(seq);
    if (seq > this.highest) {
      this.highest = seq;
      const cut = this.floor();
      for (const seen of this.seen) {
        if (seen <= cut) {
          this.seen.delete(seen);
        }
      }
    }
  }
}

/**
 * Encode the logical frame as the compact JSON of `remote/PROTOCOL.md` §5 — key order
 * exactly `v`,`type`,`id`,`from`,`to`,`body`, no whitespace. A canonical byte shape is what
 * lets two implementations of the same frame produce the same plaintext (and therefore the
 * same ciphertext), which is what the cross-language vectors check.
 *
 * `to` is validated as a non-empty string, not as "an 8-hex peer id": the *form* of a peer
 * id is the relay's contract, and hard-coding it here would make a second implementation's
 * peer naming a breaking change to this file. `body` must be present —
 * `JSON.stringify` silently drops an `undefined` property, which would ship a five-key
 * frame that the receiver refuses.
 */
export function encodeFrame(frame: FrameEnvelope): string {
  if (frame?.v !== FRAME_VERSION) {
    throw new FrameFormatError(`encodeFrame: v must be ${FRAME_VERSION}, got ${String(frame?.v)}`);
  }
  checkTextField('type', frame.type);
  checkTextField('id', frame.id);
  checkTextField('from', frame.from);
  checkTextField('to', frame.to);
  if (frame.body === undefined) {
    throw new FrameFormatError('encodeFrame: body is missing (an undefined body would be dropped by JSON.stringify)');
  }
  return JSON.stringify({ v: frame.v, type: frame.type, id: frame.id, from: frame.from, to: frame.to, body: frame.body });
}

/**
 * Parse the logical frame. Unknown keys are refused rather than ignored: this envelope is a
 * fixed six-key contract, and a seventh key would silently travel to a receiver that does
 * not know it while every implementation kept working — the exact drift the strictness
 * exists to surface.
 */
export function decodeFrame(text: string): FrameEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new FrameFormatError('decodeFrame: the plaintext is not JSON', { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FrameFormatError('decodeFrame: the plaintext is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'v' && key !== 'type' && key !== 'id' && key !== 'from' && key !== 'to' && key !== 'body') {
      throw new FrameFormatError(`decodeFrame: unknown envelope key ${JSON.stringify(key)}`);
    }
  }
  if (record.v !== FRAME_VERSION) {
    throw new FrameFormatError(`decodeFrame: v must be ${FRAME_VERSION}, got ${JSON.stringify(record.v)}`);
  }
  checkTextField('type', record.type);
  checkTextField('id', record.id);
  checkTextField('from', record.from);
  checkTextField('to', record.to);
  if (!('body' in record)) {
    throw new FrameFormatError('decodeFrame: body is missing');
  }
  return {
    v: FRAME_VERSION,
    type: record.type,
    id: record.id,
    from: record.from,
    to: record.to,
    body: record.body,
  };
}

/** Envelope fields are sealed payload, so only "present and a non-empty string" is required. */
function checkTextField(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FrameFormatError(`${name} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

/** The contract starts every connection at `seq = 1`; 0 is not a sequence number. */
function checkSeq(seq: unknown): asserts seq is number {
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
    throw new FrameFormatError(`seq must be an integer >= 1, got ${String(seq)}`);
  }
}

/** A salt is a uint32 the caller generated per connection; anything else is a bug at the caller. */
function checkSalt(salt: unknown): asserts salt is number {
  if (!Number.isSafeInteger(salt) || (salt as number) < 0 || (salt as number) > 0xffffffff) {
    throw new FrameFormatError(`the connection salt must be an unsigned 32-bit integer, got ${String(salt)}`);
  }
}

/** A slice payload is base64 of at most one slice's worth of bytes. */
function checkSlicePayload(b: unknown, where: string): void {
  if (typeof b !== 'string' || b.length % 4 !== 0 || !BASE64_PATTERN.test(b)) {
    throw new FrameFormatError(`${where}: b must be whole base64`);
  }
  if (b.length > SLICE_MAX_BASE64) {
    throw new FrameSizeError(`${where}: ${b.length} base64 characters exceeds SLICE_MAX_BASE64 (${SLICE_MAX_BASE64})`);
  }
}

/**
 * The key is a caller bug, not a frame failure, but it is reported in the same taxonomy so
 * no call site has to distinguish "Node threw a RangeError" from "the frame was refused".
 */
function checkEncKey(encKey: Uint8Array, what: string): Buffer {
  const key = toBuffer(encKey);
  if (key.length !== ENC_KEY_BYTES) {
    throw new FrameFormatError(`${what}: encKey must be ${ENC_KEY_BYTES} bytes for AES-256-GCM, got ${key.length}`);
  }
  return key;
}

/** Views into the caller's memory where possible: a 16 MiB frame is not copied for a type tag. */
function toBuffer(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new FrameFormatError(`expected bytes, got ${typeof bytes}`);
}
