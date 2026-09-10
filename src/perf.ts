/**
 * Lightweight performance instrumentation. Lines go to the "Agent Harness"
 * output channel (and nowhere else) so a long session can be diagnosed without
 * changing agent behaviour. Disabled sink = zero work besides the string concat
 * of the line itself, which we only do when a sink is set.
 */

export type PerfSink = (line: string) => void;

let sink: PerfSink | null = null;

export function setPerfSink(fn: PerfSink | null): void {
  sink = fn;
}

/**
 * Write a plain line to the same channel as {@link perf}, without the `[perf]`
 * prefix. Used for diagnostics that must reach the user (the prompt-template
 * guard reports an unresolved placeholder here before throwing). A no-op when no
 * sink is installed.
 */
export function harnessLog(line: string): void {
  sink?.(line);
}

export function perf(line: string | (() => string)): void {
  // A thunk is only evaluated when a sink is installed, so an expensive line
  // (JSON sizes, byte counts) costs nothing when perf logging is off.
  if (!sink) {
    return;
  }
  sink(`[perf] ${typeof line === 'function' ? line() : line}`);
}

export function nowMs(): number {
  return Date.now();
}

/** Time a synchronous block and log `label` with elapsed ms plus optional extra. */
export function timedSync<T>(label: string, fn: () => T, extra?: string): T {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - t0;
    perf(extra ? `${label} ${ms}ms ${extra}` : `${label} ${ms}ms`);
  }
}
