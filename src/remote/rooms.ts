/**
 * rooms.ts — the room token's key schedule: the only place a token becomes key material.
 *
 * One token is one room (`docs/agents/plans/remote-control.md` §1, §10). Everything a
 * peer needs to meet in that room is derived here, and nothing derived here is ever sent
 * to the relay: the room **id** travels in the relay URL path as the routing credential,
 * while the two keys stay on the machines that hold the token. That split is why the
 * room id must be a one-way function of the token and why the derivation is deliberately
 * expensive: the room id is public, so the token is only as good as the cost of guessing
 * it from the id.
 *
 * The byte-level authority for the schedule is `remote/PROTOCOL.md` §3, and the values it
 * must produce are pinned for all three implementations (TypeScript, C#, Kotlin) by
 * `remote/vectors/vectors.json` — reproduced exactly by `node tools/check-remote.js`.
 *
 * `deriveRoom` is synchronous on purpose. PBKDF2-HMAC-SHA256 at 600000 iterations costs
 * a few hundred milliseconds; it is paid **once per connection**, in the connect path,
 * which is a point where the caller has nothing else to do — so a promise would buy
 * nothing but a block on a microtask and an `await` at every call site. The extension has
 * zero runtime dependencies, so this module imports `node:crypto` and nothing else, and
 * never `vscode` (a plain node script must be able to require it, which is how
 * `tools/check-remote.js` tests it).
 */

import { hkdfSync, pbkdf2Sync } from 'node:crypto';

/**
 * PBKDF2 iterations for the master key. Part of the wire contract (all three
 * implementations must derive the same bytes), so a change here is a breaking protocol
 * change, never a tuning knob. `src/remote/frames.ts` re-exports it so the transport
 * layer has one import for every contract constant.
 */
export const PBKDF2_ITERATIONS = 600000;

/** Bytes of the master key, i.e. the PBKDF2 output length. */
export const MASTER_KEY_BYTES = 32;
/** Bytes of each derived key (AES-256-GCM key and the handshake HMAC key). */
export const ENC_KEY_BYTES = 32;
export const MAC_KEY_BYTES = 32;
/** Bytes of the room id before it is encoded; 16 bytes is exactly 26 base32 characters. */
export const ROOM_ID_BYTES = 16;
/** Characters of the base32 room id — the length the relay URL path segment must have. */
export const ROOM_ID_CHARS = 26;

/**
 * Minimum token length, in **characters** (code points, not UTF-16 units). A weak token
 * is the one real weakness in this design: the token is a shared secret that people type,
 * and the room id is public.
 */
export const MIN_TOKEN_CHARS = 16;
/**
 * Minimum number of distinct characters in a token. This is a **typo guard, not an
 * entropy model**: it only refuses a token that is (nearly) one repeated character
 * (`aaaaaaaaaaaaaaaa`), which is what a slip on the keyboard produces. It deliberately
 * says nothing about the character *set* (a long passphrase of letters is fine) and
 * nothing about the distribution.
 */
export const MIN_DISTINCT_CHARS = 8;

/** PBKDF2 salt: the reason two different products of the same token cannot collide. */
const PBKDF2_SALT = 'spinney-room-v1';
/** HKDF salt: distinct from the PBKDF2 salt so a single key can never be reused across roles. */
const HKDF_SALT = 'spinney-hkdf-v1';
/** RFC 4648 base32, uppercase. The alphabet is fixed by the contract (the relay path). */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Why a token was refused, or `null` when it is usable.
 *
 * These are **codes, not sentences**: this module cannot call `vscode.l10n.t` (it must stay
 * loadable from plain node), so the connect dialog owns the wording and maps each code to
 * one localized string. A code is stable across languages; a sentence is not.
 */
export type TokenIssue = 'empty' | 'too-short' | 'too-few-distinct';

/** Everything one token yields. `encKey`/`macKey` never leave the machine that holds the token. */
export interface RoomKeys {
  /** Base32 routing credential — 26 characters, the relay URL path segment. */
  readonly roomId: string;
  /** AES-256-GCM key for the frame envelope. */
  readonly encKey: Buffer;
  /** HMAC-SHA256 key for the peer handshake (the relay is not trusted to vouch for a peer). */
  readonly macKey: Buffer;
}

/**
 * Judge a token before it is used to connect. Returns `null` when the token is usable.
 *
 * Applied by the UI **before** `deriveRoom`, not inside it: the derivation is a pure
 * function of the token's bytes, and a policy check hidden inside it would make a
 * deliberate re-derivation (a test, a vector) behave differently from a real connect.
 * The one thing `deriveRoom` refuses by itself is an empty token, because every empty
 * token would land in the same room.
 *
 * Length is counted in code points (`Array.from`), so a strong token written in a
 * non-Latin script is measured by what the user sees, not by UTF-16 surrogate pairs —
 * rejecting one would push users towards ASCII-only secrets for no cryptographic reason.
 */
export function tokenIssue(token: string): TokenIssue | null {
  if (typeof token !== 'string' || token.length === 0) {
    return 'empty';
  }
  const chars = Array.from(token);
  if (chars.length < MIN_TOKEN_CHARS) {
    return 'too-short';
  }
  if (new Set(chars).size < MIN_DISTINCT_CHARS) {
    return 'too-few-distinct';
  }
  return null;
}

/**
 * Is this string a well-formed room id? Checked on the way **in** as well as out: a room
 * id arrives as a URL path segment, so a hand-typed or proxied value that is the wrong
 * length or uses `0`/`1`/lowercase must be refused before it is used as a routing
 * credential (base32 has no `0`, `1` or case).
 */
export function isValidRoomId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== ROOM_ID_CHARS) {
    return false;
  }
  for (const char of value) {
    if (!BASE32_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}

/**
 * The schedule is fixed by the contract and is not parameterised:
 *
 *     master  = PBKDF2-HMAC-SHA256(password: token, salt: 'spinney-room-v1',
 *                                  iterations: 600000, dkLen: 32)
 *     roomIdB = HKDF-SHA256(master, salt: 'spinney-hkdf-v1', info: 'room', len: 16)
 *     encKey  = HKDF-SHA256(master, salt: 'spinney-hkdf-v1', info: 'enc',  len: 32)
 *     macKey  = HKDF-SHA256(master, salt: 'spinney-hkdf-v1', info: 'mac',  len: 32)
 *
 * It is exposed as three separate steps — master, room id, keys — and not only as
 * {@link deriveRoom}, for two reasons. The expensive half (PBKDF2) is then payable
 * **once** even when a caller needs more than one part of the result, and each step is
 * individually observable against `remote/vectors/vectors.json`, which pins exactly these
 * five values for each test token. A single opaque `deriveRoom` would force every port
 * (C#, Kotlin) and every check to re-implement the schedule to see inside it.
 *
 * The token is used as its UTF-8 bytes, untrimmed and unnormalized: the same string has
 * to produce the same room on every platform and in every language, and any implicit
 * transformation (case folding, NFC, trimming) would be a silent way for two machines to
 * land in different rooms while their users see the same token.
 *
 * Slow by design (see the module header) — one PBKDF2 per connection.
 */
export function deriveMaster(token: string): Buffer {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('deriveMaster: the room token is empty');
  }
  return pbkdf2Sync(
    Buffer.from(token, 'utf8'),
    Buffer.from(PBKDF2_SALT, 'utf8'),
    PBKDF2_ITERATIONS,
    MASTER_KEY_BYTES,
    'sha256',
  );
}

/** The 16 raw bytes HKDF gives the room id, before base32. */
export function roomIdBytes(master: Uint8Array): Buffer {
  return expand(checkMaster(master, 'roomIdBytes'), 'room', ROOM_ID_BYTES);
}

/** {@link roomIdBytes} as the routing credential: 26 uppercase base32 characters. */
export function roomIdOf(master: Uint8Array): string {
  return base32Encode(roomIdBytes(master));
}

/** The two keys, expanded from an already-derived master. */
export function keysFromMaster(master: Uint8Array): RoomKeys {
  const bytes = checkMaster(master, 'keysFromMaster');
  return {
    roomId: roomIdOf(bytes),
    encKey: expand(bytes, 'enc', ENC_KEY_BYTES),
    macKey: expand(bytes, 'mac', MAC_KEY_BYTES),
  };
}

/** Everything one token yields: the room id and the two keys. */
export function deriveRoom(token: string): RoomKeys {
  return keysFromMaster(deriveMaster(token));
}

/** One HKDF-SHA256 expansion step of the schedule. */
function expand(master: Buffer, info: string, length: number): Buffer {
  return Buffer.from(
    hkdfSync('sha256', master, Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(info, 'utf8'), length),
  );
}

/**
 * The master is 32 bytes of PBKDF2 output — the one input whose length the schedule fixes.
 * A wrong length here is a caller bug (a half-copied key, a truncated vector), and it is
 * caught before HKDF silently derives a different room from it.
 */
function checkMaster(master: Uint8Array, what: string): Buffer {
  const bytes = Buffer.isBuffer(master) ? master : Buffer.from(master);
  if (bytes.length !== MASTER_KEY_BYTES) {
    throw new Error(`${what}: the master key must be ${MASTER_KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * RFC 4648 base32, uppercase, **unpadded** — the length is derived from the bytes, so
 * 16 bytes is always 26 characters. Padding is deliberately absent: the id is a URL path
 * segment, and `=` there is escape-dependent (some proxies and Android HTTP stacks
 * normalize it differently), which would turn one room into two ids.
 */
function base32Encode(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
    // Keep only the bits that have not been emitted yet, or a later shift would carry
    // stale high bits into the next character.
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}
