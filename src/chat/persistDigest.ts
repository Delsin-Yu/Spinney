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
 * The coverage rule:
 *
 *  - **Short strings are folded by value** (up to {@link DIGEST_VALUE_MAX}): ids, titles,
 *    statuses, tool names, flags — everything whose content can be rewritten in place.
 *  - **A long string inside `messages` is folded by a real hash** — a 64-bit-ish two-lane
 *    FNV-style fold over **every** character, in one pass, straight off the string (no copy,
 *    no allocation). `messages` are persisted **verbatim**, so a rewrite *anywhere* in a long
 *    prompt, assistant body or tool result has to be seen: a length + head/tail probe cannot
 *    see a change in the middle of one. This is exact for a string `content` **and** for every
 *    part of an array `content` (multimodal blocks: `text`, `image_url.url`, `file_id`),
 *    because everything below a `messages` key is folded on the exact path.
 *  - **A long string outside `messages` keeps the cheap probe**: length plus its first and
 *    last 32 characters. Those fields are display-only and derived (a clipped item, a title, a
 *    status), so they are rewritten head-to-tail whenever their message moves: length already
 *    tells, and the two probes catch a rewrite at either end without reading megabytes whose
 *    content the node's message fold has already covered exactly.
 *  - Arrays and objects are walked structurally (counts, then each element), so a pushed
 *    message, a new tool call or a changed scalar are all caught.
 *
 * Cost: exactness is linear — the fold reads every character of every long string under
 * `messages` (once per node per persist; see `dirtyNodesFor`, which walks every node of every
 * session being written). That is unavoidable: a change in the middle of a string cannot be
 * seen without looking at the string. What is avoided is the expensive part — no substring, no
 * join, no `Buffer`/crypto call, no allocation at all: one monomorphic `charCodeAt` loop with
 * two `Math.imul` per character, so the walk costs bytes read and no GC. Short strings (the
 * overwhelming majority of the object graph) and everything outside `messages` are unchanged.
 *
 * A *miss* here means a stale node file until that node changes again (and a fresh activation
 * rewrites everything once, because the digest map starts empty), so the coverage is pinned by
 * `tools/session-store-acceptance.js`: it perturbs **every field** of a realistic node and
 * requires the digest to move. Add a field to `TreeNode` and that guard tells you to cover it.
 */

/** Strings at or below this length are folded by value; longer ones by a hash or by two probes. */
export const DIGEST_VALUE_MAX = 512;
/**
 * How much of a long string's head and tail is folded (32 characters each). Used only outside
 * `messages`; inside them a long string is hashed whole.
 */
const DIGEST_PROBE = 32;

/** Lane A: FNV-1a over the mixed values. */
function laneA(hash: number, code: number): number {
  return Math.imul(hash ^ code, 16777619) >>> 0;
}

/** Lane B: a different mixing function, so a collision in A alone cannot hide a change. */
function laneB(hash: number, code: number): number {
  return Math.imul((hash + code) | 0, 2246822519) >>> 0;
}

/**
 * Fold one long string **exactly**: both lanes are carried over every character, in a single
 * pass over the string itself. Nothing is copied or allocated — no `slice`, no `substring`, no
 * `split` — so two equal strings fold identically and any difference moves both lanes.
 */
function foldTextExact(state: [number, number], text: string): void {
  let nextA = laneA(state[0], text.length);
  let nextB = laneB(state[1], text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    nextA = laneA(nextA, code);
    nextB = laneB(nextB, code);
  }
  state[0] = nextA;
  state[1] = nextB;
}

/**
 * Fold one string: by value when short (that is already exact); otherwise hashed whole on the
 * exact path, or length + head/tail probes on the cheap path.
 */
function foldText(state: [number, number], text: string, exact = false): void {
  if (text.length > DIGEST_VALUE_MAX) {
    if (exact) {
      foldTextExact(state, text);
      return;
    }
    const [a, b] = state;
    let nextA = laneA(a, text.length);
    let nextB = laneB(b, text.length);
    for (let i = 0; i < DIGEST_PROBE; i++) {
      nextA = laneA(nextA, text.charCodeAt(i));
      nextB = laneB(nextB, text.charCodeAt(i));
    }
    for (let i = text.length - DIGEST_PROBE; i < text.length; i++) {
      nextA = laneA(nextA, text.charCodeAt(i));
      nextB = laneB(nextB, text.charCodeAt(i));
    }
    state[0] = nextA;
    state[1] = nextB;
    return;
  }
  const [a, b] = state;
  let nextA = laneA(a, text.length);
  let nextB = laneB(b, text.length);
  for (let i = 0; i < text.length; i++) {
    nextA = laneA(nextA, text.charCodeAt(i));
    nextB = laneB(nextB, text.charCodeAt(i));
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

/**
 * Fold one field. `exact` says whether we are already inside `messages` — once we are, every
 * string below is hashed whole however long a path it sits on (a tool call, a content part).
 */
function fold(state: [number, number], key: string, value: unknown, exact: boolean): void {
  if (value === undefined) {
    return;
  }
  foldKey(state, key);
  // Entering `messages` (the array, then each element) turns the exact path on for good.
  const inMessages = exact || key === 'messages';
  if (typeof value === 'string') {
    foldText(state, value, inMessages);
    return;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    foldText(state, String(value), inMessages);
    return;
  }
  if (Array.isArray(value)) {
    foldText(state, `#${value.length}`, inMessages);
    for (let i = 0; i < value.length; i++) {
      fold(state, String(i), value[i], inMessages);
    }
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Sorted, so two structurally identical values fold identically whatever order their keys
    // happen to be in (a delete + re-add must not look like a change).
    const keys = Object.keys(record).sort();
    foldText(state, `{${keys.join(',')}}`, inMessages);
    for (const child of keys) {
      fold(state, child, record[child], inMessages);
    }
  }
}

function finish(state: [number, number]): string {
  return `${state[0].toString(36)}.${state[1].toString(36)}`;
}

/** A stable digest of one stored node (change detection only — not a cryptographic hash). */
export function nodeDigest(node: unknown): string {
  const state: [number, number] = [2166136261, 1013904223];
  fold(state, 'node', node, false);
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
    fold(state, key, record[key], false);
  }
  return finish(state);
}
