/**
 * A FIFO slot gate for outbound API requests — the one thing that keeps a
 * provider or a model card from being hit with more concurrent requests than the
 * user allows.
 *
 * Semantics (deliberately the same shape as `SubAgentPool`, which gates
 * sub-agents):
 *
 *   - `limit === 0` means **unlimited**: `acquire()` grants immediately and the
 *     gate only counts what is in flight (so the UI can still show "3 in flight").
 *   - A `limit` that drops below the number of granted slots never kills a request
 *     in flight; it just stops granting until the running count falls back under it.
 *   - Waiting is FIFO and abort-aware: `acquire(signal)` rejects when the signal
 *     aborts while queued, and a signal that is already aborted never queues at all.
 *     That is what makes Stop work on a request that is waiting for a slot rather
 *     than sending.
 *
 * There is no timeout and no priority: a request waits until a slot frees up. The
 * gates are keyed per request, never per turn, so holding one can never deadlock a
 * turn that is waiting for a tool result (a parent's own request has already
 * finished by the time its tools — sub-agents included — send theirs).
 */

export interface GateStats {
  /** The configured cap; `0` = unlimited. */
  limit: number;
  /** Slots granted right now (requests in flight, plus one per queued grant). */
  running: number;
  /** Requests waiting for a slot. */
  queued: number;
}

interface Waiter {
  resolve(): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Normalize a configured limit: a non-finite or negative value means unlimited. */
function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && Math.floor(limit) > 0 ? Math.floor(limit) : 0;
}

export class RequestGate {
  private limit: number;
  private running = 0;
  private readonly queue: Waiter[] = [];

  constructor(limit = 0) {
    this.limit = normalizeLimit(limit);
  }

  get stats(): GateStats {
    return { limit: this.limit, running: this.running, queued: this.queue.length };
  }

  /** Install a new cap; raising it wakes the queue, lowering it only stops new grants. */
  setLimit(limit: number): void {
    this.limit = normalizeLimit(limit);
    this.wake();
  }

  /**
   * Take a slot, waiting for one when the gate is at its cap. `onWait` is called
   * (once) only when the caller actually has to queue, so the UI can say so.
   *
   * An already-aborted request is refused **before** it can take a slot: it is not
   * going to be sent at all (Stop landed while it was being prepared), and letting
   * it hold a slot until the fetch notices would hand a doomed request the turn of
   * a live one.
   */
  acquire(signal?: AbortSignal, onWait?: () => void): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('request aborted before it could start'));
    }
    if (this.limit === 0 || this.running < this.limit) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const at = this.queue.indexOf(waiter);
          if (at >= 0) {
            this.queue.splice(at, 1);
          }
          reject(new Error('request aborted while waiting for a free slot'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      onWait?.();
    });
  }

  /** Give a slot back and hand it to the next waiter, if any. */
  release(): void {
    if (this.running > 0) {
      this.running--;
    }
    this.wake();
  }

  private wake(): void {
    while (this.queue.length > 0 && (this.limit === 0 || this.running < this.limit)) {
      const waiter = this.queue.shift() as Waiter;
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('request aborted while waiting for a free slot'));
        continue;
      }
      this.running++;
      waiter.resolve();
    }
  }
}
