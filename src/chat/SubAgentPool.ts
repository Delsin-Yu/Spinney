/**
 * A concurrency-limited slot pool for sub-agents. The main agent can run up to
 * `maxConcurrent` level-1 sub-agents at once; additional tasks queue and run as
 * slots free up. Depth-2 sub-agents are NOT pool-limited (they run directly and
 * are capped by the per-parent `maxLevel2Subagents` budget instead).
 */
export class SubAgentPool {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  /** Always ≥ 1: a non-positive limit would make every task wait forever. */
  readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Number.isFinite(maxConcurrent) ? Math.max(1, Math.floor(maxConcurrent)) : 1;
  }

  get runningCount(): number {
    return this.running;
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
    const next = this.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter (running count unchanged).
      next();
    } else {
      this.running--;
    }
  }
}
