/**
 * live_synthesis — the Second Brain's SELF-LIVE pass (autonomous, 2026-06-15 #3).
 *
 * The brain used to learn only at the nightly 04:20 distill; a capture that
 * landed at 2pm waited 14 hours to reach it. This makes it LIVE: when material
 * is routed onto a shelf (the `capture_routed` AppEvent), a debounced,
 * rate-limited, SCOPED re-distill of just THAT shelf fires soon — so the brain
 * consolidates new knowledge the moment it arrives, not overnight. No owner
 * surface; background, like every other autonomous pass.
 *
 * - DEBOUNCE collapses a burst (a museum visit → 30 photos → ONE distill once
 *   the burst settles).
 * - A per-shelf RATE LIMIT caps a busy shelf to one re-distill per interval, so
 *   a steady stream can't thrash the LLM.
 * - The distill is the existing pass scoped via `only_shelf_ids` + force, so
 *   per-topic idempotency still skips unchanged topics — only the freshly-fed
 *   topic re-runs.
 *
 * Fail-open (a distill error is logged, never propagated). Kill switch:
 * HEARTH_LIVE_SYNTHESIS=0.
 */
import type { AppEventBus } from '@app/events';

export function live_synthesis_enabled(): boolean {
  return process.env.HEARTH_LIVE_SYNTHESIS !== '0';
}

function env_ms(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Run a scoped distill of the given shelves. Injected so the driver is
 *  testable without the LLM; the real binding is
 *  `(ids) => synthesize_shelves(deps, { only_shelf_ids: ids, force: true })`. */
export type SynthesizeFn = (only_shelf_ids: string[]) => Promise<unknown>;

export interface LiveSynthesisOptions {
  debounce_ms?: number;
  min_interval_ms?: number;
}

export class LiveSynthesisDriver {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly last_run = new Map<string, number>();
  private readonly debounce_ms: number;
  private readonly min_interval_ms: number;

  constructor(
    private readonly synthesize: SynthesizeFn,
    opts: LiveSynthesisOptions = {},
  ) {
    this.debounce_ms = opts.debounce_ms ?? env_ms('HEARTH_LIVE_SYNTHESIS_DEBOUNCE_MS', 5 * 60_000);
    this.min_interval_ms =
      opts.min_interval_ms ?? env_ms('HEARTH_LIVE_SYNTHESIS_MIN_INTERVAL_MS', 15 * 60_000);
  }

  /** Subscribe to capture routing — each routed destination shelf gets nudged.
   *  Returns the unsubscribe fn. */
  attach(events: AppEventBus): () => void {
    return events.subscribe((e) => {
      if (e.type === 'capture_routed') {
        for (const id of e.specialist_ids) this.nudge(id);
      }
    });
  }

  /** Material landed on `shelf_id` — schedule (or reschedule) its re-distill. */
  nudge(shelf_id: string): void {
    if (!live_synthesis_enabled() || !shelf_id) return;
    const existing = this.timers.get(shelf_id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      shelf_id,
      setTimeout(() => this.fire(shelf_id), this.debounce_ms),
    );
  }

  private fire(shelf_id: string): void {
    this.timers.delete(shelf_id);
    const since = Date.now() - (this.last_run.get(shelf_id) ?? 0);
    if (since < this.min_interval_ms) {
      // Rate limit: defer to the earliest allowed time rather than run now.
      this.timers.set(
        shelf_id,
        setTimeout(() => this.fire(shelf_id), this.min_interval_ms - since),
      );
      return;
    }
    this.last_run.set(shelf_id, Date.now());
    void Promise.resolve(this.synthesize([shelf_id])).catch((err) =>
      console.error('[live-synthesis] distill failed:', shelf_id, err),
    );
  }

  /** Cancel all pending timers (clean shutdown / tests). */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
