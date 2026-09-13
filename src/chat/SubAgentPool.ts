/**
 * A concurrency-limited slot pool for sub-agents. The main agent can run up to
 * `limit` level-1 sub-agents at once; additional tasks queue and run as slots
 * free up. Depth-2 sub-agents are NOT pool-limited (they run directly and are
 * capped by the per-parent `maxLevel2Subagents` budget instead).
 *
 * The limit is **mutable**: `spinney.maxConcurrentSubagents` can change
 * while the window is open, and the settings listener calls `setMaxConcurrent`.
 * Raising it wakes queued tasks right away; lowering it lets the tasks already
 * running finish (nothing is killed) and only starts new ones as the pool
 * drains back under the new limit.
 */
export class SubAgentPool {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  /** Always ≥ 1: a non-positive limit would make every task wait forever. */
  private maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = normalize(maxConcurrent);
  }

  /** The current limit (see `setMaxConcurrent`). */
  get limit(): number {
    return this.maxConcurrent;
  }

  get runningCount(): number {
    return this.running;
  }

  /** Change the limit in place; freed capacity is handed to queued tasks now. */
  setMaxConcurrent(maxConcurrent: number): void {
    this.maxConcurrent = normalize(maxConcurrent);
    while (this.queue.length > 0 && this.running < this.maxConcurrent) {
      this.running++;
      this.queue.shift()!();
    }
  }

  /** Acquire a slot (or wait in FIFO), run `fn`, then release. */
  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    // Over the limit (it was just lowered): free the slot instead of recycling
    // it, so the pool drains back to the new limit.
    if (this.running > this.maxConcurrent) {
      this.running--;
      return;
    }
    const next = this.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter (running count unchanged).
      next();
      return;
    }
    this.running--;
  }
}

/** Clamp to an integer ≥ 1; a non-finite value falls back to the minimum. */
function normalize(maxConcurrent: number): number {
  return Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 1;
}
