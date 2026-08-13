/**
 * Semaphore — an N-slot FIFO async semaphore.
 *
 * Acquirers `await acquire()` and receive a `release` function; up to
 * `max_concurrency` run at once and the rest queue FIFO until a slot frees.
 * `release` is idempotent (a double-release on an error+finally path can't
 * free a slot twice and over-admit waiters). Pure, dependency-free, in-process.
 *
 * This is the shared primitive behind both the inference endpoint mutex
 * (`HostMutex` re-exports it — see [llm_serializer.ts](./llm_serializer.ts))
 * and the Firecrawl scrape limiter ([firecrawl.ts](../connectors/firecrawl.ts)):
 * one place to bound how many concurrent requests hit a shared backend, with
 * backpressure (callers queue) instead of a stampede that overloads it.
 *
 * `max_concurrency = 1` is a strict mutex (one holder at a time). Use the
 * helper `with_slot(fn)` to run a thunk under a slot with guaranteed release.
 */
export class Semaphore {
  private readonly max: number;
  /** Slots currently held (running inside acquire()..release()). */
  private active = 0;
  /** FIFO queue of waiters parked because all slots were busy. */
  private readonly waiters: Array<() => void> = [];
  /** How many acquirers are currently waiting (lock held + queued).
   *  Exposed for diagnostics — never used for control flow. */
  private depth = 0;

  constructor(max_concurrency = 1) {
    this.max = Math.max(1, Math.floor(max_concurrency));
  }

  /** Acquirers in flight (running + queued) — for diagnostics / tests. */
  current_depth(): number {
    return this.depth;
  }

  /** Waiters parked because all slots are busy (depth minus the running set). */
  queued(): number {
    return Math.max(0, this.depth - this.active);
  }

  /** Configured slot count (for diagnostics / tests). */
  max_slots(): number {
    return this.max;
  }

  async acquire(): Promise<() => void> {
    this.depth += 1;
    if (this.active < this.max) {
      this.active += 1;
    } else {
      // All slots busy — park until a release hands us one.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      // We were handed the slot directly; `active` already accounts for it.
    }
    let released = false;
    return () => {
      // Idempotent: a double-release (e.g. stream finally + error path)
      // must not free a slot twice and over-admit waiters.
      if (released) return;
      released = true;
      this.depth -= 1;
      const next = this.waiters.shift();
      if (next) {
        // Hand the freed slot straight to the next waiter — `active`
        // stays constant, so the slot is never double-counted.
        next();
      } else {
        this.active -= 1;
      }
    };
  }

  /** Run `fn` under a slot, releasing on success OR throw. */
  async with_slot<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
