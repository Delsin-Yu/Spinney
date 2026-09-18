/**
 * A coalescing, off-the-host-thread file writer.
 *
 * Two features of this repository need the same three properties, so they share one
 * implementation instead of growing two subtly different ones:
 *
 *  - **The answer is synchronous, the write is not.** The caller gets its path/size back
 *    immediately (a `[transcript] …` line, a `sessionStore.write()` return), while
 *    `mkdir`/`writeFile` go through `fs.promises` — the extension host has one JS thread
 *    and a 1 MB write on it is a stall the user sees (`invariants/streaming-perf.md`).
 *  - **A later body for one path replaces the pending one.** Only the last write to a
 *    file matters, so a burst cannot grow the queue without bound.
 *  - **A deletion wins over a write that is still pending** and neutralizes one already
 *    in flight (`tombstone`) — otherwise "the files are gone" is undone a moment later
 *    (`invariants/session-persistence.md`). A new write for that path clears the
 *    tombstone, because queueing it is what makes it exist again.
 *
 * `flush()` resolves when the queue is empty, and belongs at the hand-off points (a
 * reload, `deactivate`, the control plane's wait-for-finish) where losing the last write
 * would lose real content. A failed write is dropped, never thrown: this is a record of
 * something that already happened, and it must not break the turn that produced it.
 */
import * as fs from 'fs';
import * as path from 'path';

interface PendingWrite {
  /** Absolute directory, created on demand. */
  dir: string;
  /** The body, already serialized by the caller. */
  body: string;
  /**
   * Write `<file>.tmp` and then swap it in (`rm .bak` → `rename file .bak` →
   * `rename .tmp file`), so a reader always sees one complete generation and a crash
   * leaves either the old file or a `.tmp` nobody trusts. Every step is a rename.
   */
  atomic?: boolean;
  /** Resolves when this job settled — the caller's own attribution of its bytes. */
  settle: (result: WriteResult) => void;
}

/** What one queued write cost: its own milliseconds and characters. */
export interface WriteResult {
  file: string;
  /** Characters written (0 for a job that was replaced or cancelled before it ran). */
  chars: number;
  /** How long the bytes took to land (0 when the job never ran). */
  ms: number;
  /** True when the job was replaced by a newer body for the same path, or cancelled. */
  skipped: boolean;
  /** True when the write itself failed (the queue's policy is to drop it, never throw). */
  failed?: boolean;
}

export interface WriteOptions {
  atomic?: boolean;
}

/** Path -> the body queued for it (one entry per path; the last one wins). */
const pending = new Map<string, PendingWrite>();
/** The path whose bytes are past the point of recall, or null. */
let inFlight: string | null = null;
/** Paths deleted while a write for them was in flight (`'dir'` = the folder was removed). */
const tombstones = new Map<string, 'file' | 'dir'>();
/** The running drain, or null while the queue is idle. */
let drain: Promise<void> | null = null;

/** Is `file` inside `dir`? A folder delete covers everything below it. */
export function isUnder(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Queue one write. A later body for the same path **replaces** the pending one (the replaced
 * job settles as `skipped`, so nobody waits for it), and the returned promise resolves with
 * what *this* write cost — which is how a caller reports its own bytes instead of guessing
 * from global counters (a read of those was stolen by whichever caller resolved first, and
 * the activation-time layout migration drowned every persist in its 19 MB).
 */
export function queueWrite(dir: string, file: string, body: string, options: WriteOptions = {}): Promise<WriteResult> {
  tombstones.delete(file);
  const replaced = pending.get(file);
  let settle!: (result: WriteResult) => void;
  const done = new Promise<WriteResult>((resolve) => {
    settle = resolve;
  });
  pending.set(file, { dir, body, atomic: options.atomic === true, settle });
  // The job it replaces never runs: settling it is what keeps its awaiting caller from hanging.
  replaced?.settle({ file, chars: 0, ms: 0, skipped: true });
  if (!drain) {
    drain = drainWrites().finally(() => {
      drain = null;
    });
  }
  return done;
}

/** Write the queued bodies one by one, then apply any tombstone that a delete left. */
async function drainWrites(): Promise<void> {
  for (;;) {
    const next = pending.keys().next();
    if (next.done) {
      return;
    }
    const file = next.value;
    const job = pending.get(file);
    pending.delete(file);
    if (!job) {
      continue;
    }
    inFlight = file;
    const writeStartedAt = Date.now();
    let failed = false;
    try {
      await fs.promises.mkdir(job.dir, { recursive: true });
      if (job.atomic) {
        const tmp = `${file}.tmp`;
        await fs.promises.writeFile(tmp, job.body, 'utf8');
        try {
          await fs.promises.rm(`${file}.bak`, { force: true });
          await fs.promises.rename(file, `${file}.bak`);
        } catch {
          // No previous generation: the first write of this file.
        }
        await fs.promises.rename(tmp, file);
      } else {
        await fs.promises.writeFile(file, job.body, 'utf8');
      }
    } catch {
      // Best effort: the content is lost, never the turn. A failed atomic swap leaves the
      // `.bak` as the surviving generation, which is what it is there for.
      failed = true;
    }
    inFlight = null;
    job.settle({ file, chars: job.body.length, ms: Date.now() - writeStartedAt, skipped: false, failed });
    const tombstone = tombstones.get(file);
    if (tombstone) {
      tombstones.delete(file);
      await discardTombstoned(file, tombstone === 'dir');
    }
  }
}

/** Delete a tombstoned path again now that its write has landed. */
async function discardTombstoned(file: string, dropDir: boolean): Promise<void> {
  try {
    await fs.promises.rm(file, { force: true });
  } catch {
    return;
  }
  if (dropDir) {
    // The in-flight `mkdir` may have recreated the removed folder a moment before this
    // write landed; `rmdir` only succeeds while it is empty.
    try {
      await fs.promises.rmdir(path.dirname(file));
    } catch {
      // A sibling file is still there: nothing to clean up.
    }
  }
}

/**
 * Cancel every queued write covering the path(s) a deletion is about to remove, and
 * tombstone one already in flight. Returns how many writes that covered: a body that
 * only ever made it into the queue is gone too, and a caller reporting "removed" counts
 * it.
 */
export function cancelWrites(matches: (file: string) => boolean, kind: 'file' | 'dir'): number {
  let cancelled = 0;
  for (const file of [...pending.keys()]) {
    if (matches(file)) {
      const dropped = pending.get(file);
      pending.delete(file); // never written: the deletion already won
      dropped?.settle({ file, chars: 0, ms: 0, skipped: true });
      cancelled++;
    }
  }
  if (inFlight && matches(inFlight) && !tombstones.has(inFlight)) {
    tombstones.set(inFlight, kind);
    cancelled++;
  }
  return cancelled;
}

/** Resolve when every queued body, in-flight write and tombstone has settled. */
export async function flushWrites(): Promise<void> {
  while (drain) {
    await drain;
  }
}

/** Is a write for `file` queued but not yet complete? A queued write counts as present. */
export function hasPendingWrite(file: string): boolean {
  if (pending.has(file)) {
    return true;
  }
  return inFlight === file && !tombstones.has(file);
}
