/**
 * Text that stays **well-formed**, and cuts that never split a character.
 *
 * A JavaScript string is UTF-16, so every character outside the BMP (an emoji, a
 * rare glyph) is a *pair* of code units — and `slice(0, n)` cuts at a code-unit
 * boundary. One unpaired half can therefore survive a clip: a **lone surrogate**.
 * The string is still a valid JS string, so nothing local complains, and
 * `JSON.stringify` even writes it as a legal-looking escape (`"\ud83d"`). The
 * provider's reader does not accept it: serde_json (in its validating
 * `String` mode) requires a leading surrogate to be followed by a `\u` escape,
 * reports `unexpected end of hex escape` and rejects the **whole request** — the
 * 2026-09-24 incident, where a single clipped `📎` in a `search_transcripts` hit
 * turned every later request of that turn into an HTTP 400.
 *
 * So two rules:
 *  - cut text through {@link clipText} / {@link sliceText} / {@link tailText},
 *    never through `slice` (a cut at the head is a cut too: it can keep half a
 *    pair as easily as a cut at the tail);
 *  - pass anything that leaves this process through {@link wellFormed} /
 *    {@link wellFormedDeep} — a tool result, a paste, a stream chunk or an old
 *    stored message can each carry an unpaired half that came from elsewhere.
 *
 * Deliberately vscode-free and dependency-free: the rules are the part that can
 * be wrong, and `tools/check-unicode.js` drives them from a plain node script.
 */

/** What a lone surrogate becomes — the replacement character every other toolchain writes. */
const REPLACEMENT = '\uFFFD';

/** An unpaired leading surrogate, or an unpaired trailing one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Low half of a surrogate pair. */
const LOW_START = 0xdc00;
const LOW_END = 0xdfff;

/**
 * Replace every unpaired surrogate with U+FFFD. Well-formed text comes back
 * unchanged (as an equal string); a valid pair is one character and survives.
 */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, REPLACEMENT);
}

/**
 * `s` cut to at most `n` UTF-16 units, never in the middle of a pair — for a
 * caller that writes its own tail (a count, a marker). `n <= 0` is `''`.
 */
export function sliceText(s: string, n: number): string {
  if (n <= 0) {
    return '';
  }
  if (s.length <= n) {
    return s;
  }
  const last = s.charCodeAt(n - 1);
  const next = s.charCodeAt(n);
  const splitsPair = last >= 0xd800 && last <= 0xdbff && next >= LOW_START && next <= LOW_END;
  return s.slice(0, splitsPair ? n - 1 : n);
}

/**
 * `s`, cut to at most `n` UTF-16 units, with `tail` appended when it was longer.
 * Never splits a pair, and never returns an unpaired surrogate (in either the
 * kept half or the input).
 */
export function clipText(s: string, n: number, tail = '…'): string {
  if (s.length <= n) {
    return wellFormed(s);
  }
  return wellFormed(sliceText(s, n) + tail);
}

/**
 * The last `n` UTF-16 units of `s` — {@link sliceText}'s mirror for a cut at the
 * **head** (a background terminal's output tail, a rolling log). A pair that
 * straddles the cut is dropped whole, never kept as its lower half, and the
 * result is well-formed.
 */
export function tailText(s: string, n: number): string {
  if (n <= 0) {
    return '';
  }
  if (s.length <= n) {
    return wellFormed(s);
  }
  const start = s.length - n;
  const previous = s.charCodeAt(start - 1);
  const first = s.charCodeAt(start);
  const splitsPair = previous >= 0xd800 && previous <= 0xdbff && first >= LOW_START && first <= LOW_END;
  return wellFormed(s.slice(splitsPair ? start + 1 : start));
}

/**
 * {@link wellFormed} over a whole value, **copying** its containers: every string
 * inside an array/object tree is fixed and the input is left alone. Used at the
 * request boundary, where the caller keeps its own in-memory messages and only
 * the bytes on the wire change.
 *
 * Only plain objects and arrays are walked: anything else (`Buffer`, `Date`,
 * `Map`, a class instance) is a leaf and is returned as it is, because rebuilding
 * it would silently destroy it.
 */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return wellFormed(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => wellFormedDeep(entry)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '__proto__') {
        // Plain assignment would hit the inherited setter and drop the key (an own
        // `__proto__` is what `JSON.parse` of an old node file can produce), so the
        // one dangerous name is defined as a data property instead.
        Object.defineProperty(copy, key, {
          value: wellFormedDeep(entry),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        continue;
      }
      copy[key] = wellFormedDeep(entry);
    }
    return copy as T;
  }
  return value;
}
