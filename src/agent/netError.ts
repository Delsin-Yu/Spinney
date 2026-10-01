/**
 * The real reason behind a failed `fetch`.
 *
 * Node's `fetch` reports every network failure as `TypeError: fetch failed` and
 * puts the *actual* reason in `error.cause`: `ENOTFOUND`, `ECONNREFUSED`,
 * `ECONNRESET`, a `UND_ERR_*` undici code, a TLS code, `bad port`. Reporting
 * `error.message` alone therefore loses exactly the information needed to
 * diagnose a failure — a DNS problem, a refused connection and a TLS rejection
 * all read as "fetch failed".
 *
 * That is not hypothetical. The 2026-09-30 incident (session `mumykrpy4uzbpi`)
 * left 39 retries across two endpoints reading "Network error calling the API:
 * fetch failed", 2–7 ms each, and the cause — the only thing that would have
 * named the broken layer — was discarded on the way to the log and the chat
 * bubble. A bare `fetch failed` costs a whole investigation; `fetch failed
 * ENOTFOUND` ends it in one line.
 *
 * So the cause is surfaced verbatim, one level of nesting (a `cause` that is
 * itself an `AggregateError`, which is what undici throws when several
 * addresses are tried at once), clipped through {@link clipText} so a long
 * provider message cannot flood a bubble and no clip can leave a lone
 * surrogate in it.
 *
 * Deliberately dependency-free beyond the text helpers, so it stays testable
 * from a plain node script.
 */

import { clipText } from '../text';

/** Cap on the returned line. */
const MAX_MESSAGE = 200;
/** Cap on the cause chain rendered inside it. */
const MAX_CAUSE = 160;

/** Latitude for the non-standard fields a driver puts on its error. */
interface Errorish {
  code?: unknown;
  message?: unknown;
  address?: unknown;
  port?: unknown;
  errors?: unknown;
  cause?: unknown;
}

/** An error-shaped value, or undefined — `throw 'x'` and `throw null` both happen. */
function asErrorish(value: unknown): Errorish | undefined {
  return typeof value === 'object' && value !== null ? (value as Errorish) : undefined;
}

/** `value` as a string, or '' when it is not one (or is empty). */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** One short phrase for one error: its code, address, port and message. */
function phrase(error: unknown): string {
  const err = asErrorish(error);
  if (!err) {
    // A thrown primitive (`throw 'boom'`): itself, or nothing to say.
    return typeof error === 'string' ? error.trim() : '';
  }
  const code = text(err.code);
  const message = text(err.message);
  const host = [text(err.address), text(err.port)].filter(Boolean).join(':');
  const parts: string[] = [];
  if (code) {
    parts.push(code);
  }
  // Skip a message that only repeats the code ("connect ECONNREFUSED ..." keeps
  // the address, which is the useful part), and never render a bare "fetch failed".
  const useful = message && message !== code && message !== 'fetch failed' && !message.startsWith(`${code} `);
  if (useful) {
    parts.push(message);
  }
  if (host && !parts.some((part) => part.includes(host))) {
    parts.push(host);
  }
  return parts.join(' · ');
}

/**
 * Walk `error` and its cause tree, returning one short phrase per layer that
 * actually knows something, deepest-last. The nesting is not a fixed shape — an
 * undici failure is `TypeError('fetch failed')` whose `cause` is an
 * `AggregateError` (whose own `errors` array holds one `Error` per address
 * tried), and a TLS or DNS failure may be one level shallower — so the tree is
 * walked rather than assumed.
 */
function causeDetails(error: unknown, into: string[], seen: Set<unknown>, depth: number): void {
  if (depth > 4 || !error || typeof error !== 'object' || seen.has(error)) {
    return;
  }
  seen.add(error);
  const err = error as Errorish;
  const detail = phrase(err);
  // A layer with nothing to say (a bare `AggregateError`, or one that only
  // repeats the generic "fetch failed") contributes nothing.
  if (detail && !into.includes(detail)) {
    into.push(detail);
  }
  const nested: unknown[] = Array.isArray(err.errors)
    ? err.errors
    : err.cause === undefined
      ? []
      : [err.cause];
  for (const entry of nested) {
    if (entry !== error) {
      causeDetails(entry, into, seen, depth + 1);
    }
  }
}

/**
 * One diagnosable line for a failed `fetch`: the message a human reads, plus the
 * cause — the code, the message and the host it was talking to. Falls back to
 * the message alone when there is no cause to add, so this is always at least as
 * informative as `error.message`.
 */
export function describeFetchError(error: unknown): string {
  // The message the old code reported, unchanged — `Error.message` first, so a
  // `TypeError` does not grow a prefix and `assert`-style details are kept — and
  // `String()` for a thrown primitive (a Symbol refuses implicit coercion).
  const message = text(error instanceof Error ? error.message : undefined) || String(error);
  const details: string[] = [];
  causeDetails(error, details, new Set(), 0);
  // The first layer is usually the useless top-level message itself.
  const useful = details.filter((detail) => !message.includes(detail));
  const cause = clipText(useful.join('; '), MAX_CAUSE);
  return clipText(cause ? `${message} (${cause})` : message, MAX_MESSAGE);
}
