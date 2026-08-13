// Process-wide tracker of on-demand background-job / deliberation runs.
//
// The HTTP routes that fire a specialist's background jobs (and its
// deliberation pass) return BEFORE the job finishes — a browser scan or a
// configurator drive runs for minutes, past the nginx proxy read timeout, so
// awaiting it in the request would truncate the run. That left the Recon Desk
// gear unable to report ACTUAL completion: a detached job just said "running in
// background" forever.
//
// This tracker is the missing signal. The detached runner records `running`
// when a job starts and `ok`/`failed` when it concludes (the server is already
// awaiting each job sequentially inside the detached promise — it knows the
// real end). A client polls `GET /api/specialists/:id/background_jobs/status`
// and flips its spinner to a checkmark when the job's entry leaves `running`.
//
// In-memory by design: a run can only ever be `running` within a single
// orchestrator lifetime (a restart kills any in-flight run), and a completed
// run's result persists in the map until that job is re-triggered — which is
// exactly the "spinner while running, checkmark that sticks until next run"
// contract the gear wants. A restart/deploy clears the map; the audit log
// remains the durable record of what actually ran.

export type JobRunState = 'running' | 'ok' | 'failed';

export interface JobRunRecord {
  status: JobRunState;
  started_at: string; // ISO 8601 UTC
  finished_at?: string; // ISO 8601 UTC; absent while running
  duration_ms?: number;
  error?: string;
}

// Synthetic job name under which a specialist's deliberation pass is tracked,
// so the gear's "research pass" step polls the same status map as its jobs.
export const DELIBERATION_JOB_KEY = '__deliberation__';

class JobRunTracker {
  private readonly runs = new Map<string, JobRunRecord>();

  private key(specialist_id: string, job: string): string {
    // NUL (\x00) joins the two parts: it can never appear in a specialist id or
    // job name, so the composite key is collision-free. Written as the escape
    // sequence, never a literal NUL byte in source (see guard:encoding).
    return `${specialist_id}\x00${job}`;
  }

  /** Mark a job as running now (clears any prior checkmark for it). */
  start(specialist_id: string, job: string): void {
    this.runs.set(this.key(specialist_id, job), {
      status: 'running',
      started_at: new Date().toISOString(),
    });
  }

  /** Record a terminal outcome, preserving the original `started_at`. */
  finish(specialist_id: string, job: string, ok: boolean, error?: string): void {
    const k = this.key(specialist_id, job);
    const started_at = this.runs.get(k)?.started_at ?? new Date().toISOString();
    const finished_at = new Date().toISOString();
    this.runs.set(k, {
      status: ok ? 'ok' : 'failed',
      started_at,
      finished_at,
      duration_ms: Math.max(0, Date.parse(finished_at) - Date.parse(started_at)),
      error: ok ? undefined : error,
    });
  }

  /** The latest run for a single job, or undefined if it never ran. */
  get(specialist_id: string, job: string): JobRunRecord | undefined {
    return this.runs.get(this.key(specialist_id, job));
  }

  /** Every tracked job for a specialist, keyed by job name. */
  for_specialist(specialist_id: string): Record<string, JobRunRecord> {
    const out: Record<string, JobRunRecord> = {};
    const prefix = `${specialist_id}\x00`;
    for (const [k, v] of this.runs) {
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    }
    return out;
  }
}

// Single process-wide instance (mirrors the location_awareness cache pattern).
export const job_runs = new JobRunTracker();
