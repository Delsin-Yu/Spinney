/**
 * The digest that decides whether a stored node (or a session's header) has to be
 * re-serialized.
 *
 * Why it exists: a session holds its whole API history (a real one is ~18 MB), and the v2
 * store keeps **one file per node** so a turn end can write the turn's own node instead of
 * the whole session. That needs an answer to "which nodes changed?", and computing it runs on
 * the very host thread we are trying to keep free — so it is a **numeric fold**, not a
 * string: two 32-bit lanes mixed in place, a ~13-character result per node. The first version
 * built a string of every field of every node and joined it, which allocated megabytes per
 * write and cost 83 ms of blocked host — more than the payload it was there to avoid.
 *
 * The coverage rule, and its one deliberate compromise:
 *
 *  - **Short strings are folded by value** (up to {@link DIGEST_VALUE_MAX}): ids, titles,
 *    statuses, tool names, flags — everything whose content can be rewritten in place.
 *  - **Long strings are folded by length plus their first and last 32 characters.** In this
 *    data model a long string is append-only (streamed text and reasoning grow a character at
 *    a time, tool arguments accumulate, a tool result is written once), so length already
 *    tells; the two probes catch a rewrite at either end without hashing megabytes.
 *  - Arrays and objects are walked structurally (counts, then each element), so a pushed
 *    message, a new tool call or a changed scalar are all caught.
 *
 * A *miss* here means a stale node file until that node changes again (and a fresh activation
 * rewrites everything once, because the digest map starts empty), so the coverage is pinned by
 * `tools/session-store-acceptance.js`: it perturbs **every field** of a realistic node and
 * requires the digest to move. Add a field to `TreeNode` and that guard tells you to cover it.
 */

/** Strings at or below this length are folded by value; longer ones by length + two probes. */
export const DIGEST_VALUE_MAX = 512;
/** How much of a long string's head and tail is folded (32 characters each). */
const DIGEST_PROBE = 32;

/** Lane A: FNV-1a over the mixed values. */
function laneA(hash: number, code: number): number {
  return Math.imul(hash ^ code, 16777619) >>> 0;
}

/** Lane B: a different mixing function, so a collision in A alone cannot hide a change. */
function laneB(hash: number, code: number): number {
  return Math.imul((hash + code) | 0, 2246822519) >>> 0;
}

/** Fold one string: by value when short, by length + head/tail probes when long. */
function foldText(state: [number, number], text: string): void {
  const [a, b] = state;
  let nextA = laneA(a, text.length);
  let nextB = laneB(b, text.length);
  if (text.length <= DIGEST_VALUE_MAX) {
    for (let i = 0; i < text.length; i++) {
      nextA = laneA(nextA, text.charCodeAt(i));
      nextB = laneB(nextB, text.charCodeAt(i));
    }
  } else {
    for (let i = 0; i < DIGEST_PROBE; i++) {
      nextA = laneA(nextA, text.charCodeAt(i));
      nextB = laneB(nextB, text.charCodeAt(i));
    }
    for (let i = text.length - DIGEST_PROBE; i < text.length; i++) {
      nextA = laneA(nextA, text.charCodeAt(i));
      nextB = laneB(nextB, text.charCodeAt(i));
    }
  }
  state[0] = nextA;
  state[1] = nextB;
}

/** Fold one key marker (a field name, an index, a type tag) — always short. */
function foldKey(state: [number, number], key: string): void {
  state[0] = laneA(state[0], 31);
  state[1] = laneB(state[1], 31);
  foldText(state, key);
}

function fold(state: [number, number], key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  foldKey(state, key);
  if (typeof value === 'string') {
    foldText(state, value);
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    foldText(state, String(value));
    return;
  }
  if (Array.isArray(value)) {
    foldText(state, `#${value.length}`);
    for (let i = 0; i < value.length; i++) {
      fold(state, String(i), value[i]);
    }
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Sorted, so two structurally identical values fold identically whatever order their keys
    // happen to be in (a delete + re-add must not look like a change).
    const keys = Object.keys(record).sort();
    foldText(state, `{${keys.join(',')}}`);
    for (const child of keys) {
      fold(state, child, record[child]);
    }
  }
}

function finish(state: [number, number]): string {
  return `${state[0].toString(36)}.${state[1].toString(36)}`;
}

/** A stable digest of one stored node (change detection only — not a cryptographic hash). */
export function nodeDigest(node: unknown): string {
  const state: [number, number] = [2166136261, 1013904223];
  fold(state, 'node', node);
  return finish(state);
}

/**
 * A stable digest of a session's **header** — everything about it except its nodes, which have
 * their own files and their own digests.
 */
export function sessionHeaderDigest(session: unknown): string {
  const state: [number, number] = [2166136261, 1013904223];
  const record = (session ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (key === 'nodes') {
      continue;
    }
    fold(state, key, record[key]);
  }
  return finish(state);
}
