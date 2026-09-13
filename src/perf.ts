/**
 * Lightweight performance instrumentation. Lines go to the "Agent Harness"
 * output channel (and nowhere else) so a long session can be diagnosed without
 * changing agent behaviour. Disabled sink = zero work besides the string concat
 * of the line itself, which we only do when a sink is set.
 *
 * Three layers, cheapest first:
 *
 *  - `perf()` / `timedSync()` — one line about one thing (request size, persist,
 *    a render step);
 *  - `beginOp()` / `opMark()` / `opTag()` — a **correlated trace of one
 *    user-visible operation**. A session switch happens half in the extension
 *    host (tab creation, HTML, runtime, persistence) and half in the webview
 *    (tree/path render, markdown, layout), so the op id travels with the repaint
 *    messages (`reset` / `tree` / `path`) and comes back as the webview's
 *    `perfDiag` report, which ends the op. The elapsed total is then "what the
 *    user waited for" and every mark says where it went;
 *  - `startLagWatch()` — the host's own event loop. A timer that fires late means
 *    the extension host was blocked (persist, a tree rebuild, stringifying a
 *    session), which is the other half of "the UI stutters" and is invisible in a
 *    `perf()` line: a blocked host writes nothing while it is blocked.
 *
 * Read the lines in View → Output → "Agent Harness"; see
 * `docs/agents/invariants/streaming-perf.md` for what to look for.
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

/** Default deadline for an op whose webview never reports back. */
const OP_TIMEOUT_MS = 20_000;

export interface PerfOpOptions {
  /**
   * The op is finished by the **webview**: {@link opTag} hands its id to the
   * repaint messages and the matching `perfDiag` report ends the op. Without it
   * the id is attached to nothing and only `end()` closes the op (a tab that was
   * already open needs no repaint at all).
   */
  awaitWebview?: boolean;
  /**
   * What the op is about (the session id, in practice). Only messages whose
   * subject matches carry its id ({@link opTag}), and {@link startRepaintOp} only
   * joins an op of the same subject — two tabs repainting at once (a window reload
   * restores several) are two operations, and with 80 stored sessions one tab's
   * repaint must never end another tab's op.
   */
  subject?: string;
  /** Auto-end guard (default 20 s), so a lost report cannot keep an op open. */
  timeoutMs?: number;
}

export interface PerfOp {
  readonly id: number;
  readonly label: string;
  readonly startedMs: number;
  readonly awaitingWebview: boolean;
  /** See {@link PerfOpOptions.subject}. */
  readonly subject?: string;
  readonly ended: boolean;
  /** Milliseconds since the op began. */
  elapsed(): number;
  /** Log one step of the op (`op#3 +12ms panel-html bytes=118345`). */
  mark(label: string, detail?: string): void;
  /** Close the op once (idempotent): `op#3 end 2210ms painted cards=37`. */
  end(detail?: string): void;
}

/** Keep a diagnostic timer from holding the extension host open. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

class Op implements PerfOp {
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(
    readonly id: number,
    readonly label: string,
    readonly startedMs: number,
    readonly awaitingWebview: boolean,
    readonly subject: string | undefined,
    timeoutMs: number,
  ) {
    this.timer = setTimeout(() => this.end('no webview report'), timeoutMs);
    unrefTimer(this.timer);
  }

  get ended(): boolean {
    return this.done;
  }

  elapsed(): number {
    return Date.now() - this.startedMs;
  }

  // Marks are still written after `end()` on purpose: the webview's report (or a
  // late `postMessage` resolution) arrives *after* the op closed and its elapsed
  // time is exactly what makes that line readable.
  mark(label: string, detail?: string): void {
    if (sink) {
      sink(`[perf] op#${this.id} +${this.elapsed()}ms ${label}${detail ? ` ${detail}` : ''}`);
    }
  }

  end(detail?: string): void {
    if (this.done) {
      return;
    }
    this.done = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (current === this) {
      current = null;
    }
    live.delete(this.id);
    if (sink) {
      sink(`[perf] op#${this.id} end ${this.elapsed()}ms${detail ? ` ${detail}` : ''}`);
    }
  }
}

/** The op a mark refers to without being handed one (`timedSync`, `opMark`). */
let current: PerfOp | null = null;
/** Ops the webview may still report on, by id. */
const live = new Map<number, PerfOp>();
let opSeq = 0;

/**
 * Begin a correlated operation. The op becomes the *ambient* one, so every
 * `timedSync` / `opMark` below it lands in the same block without threading a
 * handle through (`PanelManager` → `ChatPanel` → `SessionRuntime`).
 */
export function beginOp(label: string, detail?: string, opts: PerfOpOptions = {}): PerfOp {
  const op = new Op(
    ++opSeq,
    label,
    Date.now(),
    opts.awaitWebview === true,
    opts.subject,
    opts.timeoutMs ?? OP_TIMEOUT_MS,
  );
  current = op;
  live.set(op.id, op);
  if (sink) {
    sink(`[perf] op#${op.id} begin ${label}${detail ? ` ${detail}` : ''}`);
  }
  return op;
}

/** The ambient op, or `null` when nothing is being traced. */
export function currentOp(): PerfOp | null {
  return current;
}

/** Mark a step on the ambient op (a no-op when none is open). */
export function opMark(label: string, detail?: string): void {
  current?.mark(label, detail);
}

/**
 * The trace id to attach to a repaint message (`reset` / `tree` / `path`) so the
 * webview can measure the same operation and report it back. Empty while no
 * webview-facing op is open, and empty for a message of a *different* subject — an
 * unrelated repaint must never be measured as part of a switch, and (the sharper
 * half) must never hand the webview an id whose report would end someone else's op.
 */
export function opTag(subject?: string): { traceId?: number } {
  const op = current;
  if (!op || !op.awaitingWebview) {
    return {};
  }
  if (subject !== undefined && op.subject !== undefined && op.subject !== subject) {
    return {};
  }
  return { traceId: op.id };
}

/**
 * Start a repaint op for `subject` unless one is already open **for it** — the
 * common case is joining it: a cold switch opened the op and its `postAllState`
 * repaint belongs to that same operation, which the webview's paint report ends.
 * A repaint of another subject gets an op of its own (the earlier one stays open
 * until its own report or the deadline).
 *
 * @returns the op the caller should be part of.
 */
export function startRepaintOp(label: string, subject: string, detail?: string, timeoutMs?: number): PerfOp {
  const op = current;
  if (op && op.awaitingWebview && op.subject === subject) {
    return op;
  }
  // `subject` may already have an op open that is **not** the ambient one: a window
  // reload restores several tabs at once, so tab A's op (opened when its panel was
  // adopted) can still be waiting for A's `ready` while tab B's repaint has since
  // become ambient. Join A's op rather than opening a second one for A — the
  // webview's single paint report can close only one, so the other would linger to
  // the 20 s deadline (`no webview report`).
  for (const candidate of live.values()) {
    if (candidate.awaitingWebview && candidate.subject === subject) {
      current = candidate;
      return candidate;
    }
  }
  return beginOp(label, detail ?? `session=${subject}`, { awaitWebview: true, subject, timeoutMs });
}

/**
 * Run `fn` only while an op is open. For a measurement that costs real work
 * (stringifying a payload just to learn its size) the zero-cost case has to be
 * the default: nobody is reading the line, so do not pay for it.
 */
export function opMeasure<T>(fn: () => T): T | undefined {
  return current ? fn() : undefined;
}

/** Mark a message's size on the ambient op (`bytes=N`), only while one is open. */
export function opPayload(label: string, message: unknown): void {
  const op = current;
  if (!op) {
    return;
  }
  let size = 'bytes=?';
  try {
    size = `bytes=${JSON.stringify(message)?.length ?? 0}`;
  } catch {
    /* a payload that cannot be serialized is a bug elsewhere; not this line's job */
  }
  op.mark(label, size);
}

/** Time a synchronous block and log `label` with elapsed ms plus optional extra. */
export function timedSync<T>(label: string, fn: () => T, extra?: string): T {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - t0;
    // Inside a traced op the mark is worth more than its own line: it lands in
    // the op's block, next to the op's own elapsed time.
    if (current) {
      current.mark(label, `${ms}ms${extra ? ` ${extra}` : ''}`);
    } else {
      perf(extra ? `${label} ${ms}ms ${extra}` : `${label} ${ms}ms`);
    }
  }
}

/**
 * Write a `perfDiag` report from the webview (`media/main.js`) into the output
 * channel. A report carrying the id of a live op lands *inside* that op's block;
 * a `paint` report ends it, because "the frame is on screen" is the moment the
 * user stops looking at the previous session.
 */
export function logWebviewReport(where: string, report: Record<string, unknown>): void {
  if (!sink) {
    return;
  }
  const kind = typeof report.kind === 'string' ? report.kind : 'report';
  const detail = fieldsOf(report, ['type', 'kind', 'traceId']);
  const traceId = Number(report.traceId);
  const op = Number.isFinite(traceId) ? live.get(traceId) : undefined;
  if (!op) {
    perf(`webview-${kind} ${where}${detail ? ` ${detail}` : ''}`);
    return;
  }
  op.mark(`webview-${kind}`, detail);
  if (kind === 'paint' && op.awaitingWebview) {
    // `end Nms` is then the whole wall-clock of the operation — from the click to
    // the frame that showed the new session — and the line above it says where the
    // time went.
    op.end('painted');
  }
}

/** `key=value key2=value2` for a diagnostics object; values are clipped. */
function fieldsOf(record: Record<string, unknown>, skip: readonly string[]): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (skip.includes(key) || value === undefined || value === null || value === '') {
      continue;
    }
    const text = typeof value === 'object' ? safeJson(value) : String(value);
    parts.push(`${key}=${text.length > 120 ? `${text.slice(0, 120)}…` : text}`);
  }
  return parts.join(' ');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '?';
  }
}

/**
 * Watch the host's own event loop. A timer that fires late means the extension
 * host was blocked — a `persist` write, a tree rebuild, a large stringify — and
 * that stall is what the user feels as a stutter. One line per stall burst, so a
 * blocked host is attributable even though it wrote nothing while blocked.
 *
 * @returns a stopper (call it from `dispose`).
 */
export function startLagWatch(intervalMs = 250, thresholdMs = 120): () => void {
  let expected = Date.now() + intervalMs;
  let stalls = 0;
  let worst = 0;
  let lastStall = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + intervalMs;
    if (lag > thresholdMs) {
      stalls++;
      worst = Math.max(worst, lag);
      lastStall = now;
      return;
    }
    // Report once the stall is over, so the worst lag of a burst is one line.
    if (stalls > 0 && now - lastStall > 2 * intervalMs) {
      perf(`lag blocked ${worst}ms (${stalls} late tick${stalls === 1 ? '' : 's'})`);
      stalls = 0;
      worst = 0;
    }
  }, intervalMs);
  unrefTimer(timer);
  return () => clearInterval(timer);
}
