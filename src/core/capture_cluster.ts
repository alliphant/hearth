/**
 * Capture cluster buffer — collapses bursts of captures from the same
 * user into a single classification batch.
 *
 * The guiding case: museum visit, 30 photos in 10 minutes. We want
 * one routed item to Marguerite, not 30 separate proposals.
 *
 * Mechanics:
 *
 *   - Per-user buffer keyed `cordelia_cluster:<user_id>`.
 *   - First capture arms a 5-minute sliding window. Each new capture
 *     in the window resets the timer.
 *   - When the window closes, the whole batch fires through the
 *     classifier as one unit.
 *   - SINGLE-PHOTO bypass: if a capture arrives and no buffer exists
 *     yet, it processes immediately (no wait). The buffer is created
 *     simultaneously so the *second* capture (if any) collapses into
 *     the first's bucket and the cluster handler dedups.
 *
 * The classifier sees `CaptureClusterItem[]` and produces one
 * `CordeliaRoutingDecision` per coherent subgroup — i.e. a cluster
 * can fan out to multiple specialists when the photos legitimately
 * span domains. This module's only job is the buffering.
 */

export interface CaptureClusterItem {
  capture_id: string;
  user_id: string;
  kind: 'voiceMemo' | 'photo' | 'sharedText' | 'sharedFile';
  note_path: string;
  attachment_path: string | null;
  captured_at: string;
}

export interface ClusterReady {
  user_id: string;
  items: CaptureClusterItem[];
  closed_at_ms: number;
}

export type ClusterFlushHandler = (ready: ClusterReady) => Promise<void> | void;

interface Bucket {
  user_id: string;
  items: CaptureClusterItem[];
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

export class CaptureCluster {
  private buckets = new Map<string, Bucket>();
  private window_ms: number;
  private flush_handler: ClusterFlushHandler | null = null;

  constructor(window_ms = DEFAULT_WINDOW_MS) {
    this.window_ms = window_ms;
  }

  on_flush(handler: ClusterFlushHandler): void {
    this.flush_handler = handler;
  }

  /**
   * Enqueue a capture. Returns:
   *
   *   - `'flush_now'` when this is the first capture in a fresh
   *     bucket — the caller should fire the classifier on this single
   *     capture immediately, while the bucket stays armed to absorb
   *     any follow-up captures into the same cluster.
   *   - `'buffered'` when a bucket already existed; this capture
   *     joins it and the existing timer is reset (sliding window).
   */
  enqueue(item: CaptureClusterItem): 'flush_now' | 'buffered' {
    const key = item.user_id;
    const existing = this.buckets.get(key);
    if (!existing) {
      const bucket: Bucket = { user_id: item.user_id, items: [item], timer: null };
      this.buckets.set(key, bucket);
      this.arm_timer(bucket);
      return 'flush_now';
    }
    existing.items.push(item);
    this.arm_timer(existing); // resets the sliding window
    return 'buffered';
  }

  /**
   * Test seam: forcibly close any open bucket for a user RIGHT NOW
   * (don't wait for the timer). Smoke tests use this to assert the
   * cluster-collapse path deterministically.
   */
  async flush_now_for(user_id: string): Promise<void> {
    const bucket = this.buckets.get(user_id);
    if (!bucket) return;
    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }
    this.buckets.delete(user_id);
    if (this.flush_handler) {
      await this.flush_handler({
        user_id,
        items: bucket.items,
        closed_at_ms: Date.now(),
      });
    }
  }

  /** Stop pending timers. Outstanding buckets are dropped (their
   *  captures are still persisted; just no follow-up classification). */
  stop(): void {
    for (const b of this.buckets.values()) {
      if (b.timer) clearTimeout(b.timer);
    }
    this.buckets.clear();
  }

  /** Test-only: how many users currently have open buckets. */
  open_count(): number {
    return this.buckets.size;
  }

  private arm_timer(bucket: Bucket): void {
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => {
      // Snapshot + delete BEFORE awaiting the handler so a slow
      // classifier doesn't block fresh captures from arming a new
      // bucket for the same user.
      const snapshot: ClusterReady = {
        user_id: bucket.user_id,
        items: bucket.items.slice(),
        closed_at_ms: Date.now(),
      };
      this.buckets.delete(bucket.user_id);
      if (!this.flush_handler) return;
      Promise.resolve(this.flush_handler(snapshot)).catch((err) => {
        console.error('[capture_cluster] flush handler failed:', err);
      });
    }, this.window_ms);
    // Detach so the timer doesn't keep the event loop alive during
    // shutdown (Bun's setTimeout returns a Timer that supports unref).
    if (typeof (bucket.timer as { unref?: () => void }).unref === 'function') {
      (bucket.timer as { unref: () => void }).unref();
    }
  }
}
