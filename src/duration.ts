/**
 * Elapsed-time formatting for the duration readouts.
 *
 * One formatter for every chip that counts: background terminals, sub-agents and
 * tool calls all end up here, both for the harness messages that quote a duration
 * back to the agent ("finished in 3m 12s") and for the webview's elapsed chip.
 * Keeping it in one dependency-free module means the host and the webview can
 * mirror the exact same shape instead of drifting apart.
 *
 * The shape deliberately coarsens with magnitude. Sub-second numbers stay exact
 * ("420ms") because that is the range where the difference between 4ms and 420ms
 * is the whole story; a few seconds get one decimal (3.5s) because that is where
 * a human still reads the fraction; past ten seconds the tenth is noise, past a
 * minute the seconds are context and past an hour the minutes are. A single fixed
 * shape could not do this — it would either report a fast call as "0.4s" or a
 * long job as "7200s".
 *
 * The result is a locale-free token ("3m 12s"), not a sentence: no unit words, no
 * "ago", no Intl formatting. Callers concatenate it into a label or an English
 * harness message, so it must not depend on the host locale or carry punctuation
 * of its own.
 */
export function formatDuration(ms: number): string {
  // NaN/Infinity/negative are all "no duration measured"; clamp rather than
  // print "NaNms" or "-1s" into a user-facing chip.
  const t = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (t < 1000) {
    return `${Math.round(t)}ms`;
  }
  if (t < 10000) {
    // Round to the tenth first, then test: 9950 becomes 10.0 and must fall
    // through to the whole-second shape rather than print "10.0s".
    const secs = Math.round(t / 100) / 10;
    if (secs < 10) {
      return `${secs.toFixed(1)}s`;
    }
  }
  if (t < 60000) {
    const secs = Math.round(t / 1000);
    // 59600ms rounds up to 60s, i.e. a full minute: re-normalize so the readout
    // says "1m 0s" instead of the nonsensical "60s".
    return secs < 60 ? `${secs}s` : '1m 0s';
  }
  // Minutes and hours are truncated (not rounded): a chip reading "1h 0m" while
  // 59m 59s still remains would be a lie, and 3599999ms is exactly 59m 59s.
  const sec = Math.floor(t / 1000);
  if (t < 3600000) {
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }
  const min = Math.floor(t / 60000);
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
