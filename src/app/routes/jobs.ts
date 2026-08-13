/**
 * /api/jobs — "On the Fire": the cross-domain in-flight work ledger (2026-07-29).
 *
 * Backs the web dock's pill + panel and the iOS tab accessory + sheet. One list
 * for every long-running thing a human asked for — a media download next to a
 * research dive — so "is anything happening right now?" has an answer on a wall
 * instead of requiring the user to ask Kate to poll on their behalf.
 *
 * READ-ONLY over the domain stores (core/jobs.ts is a projection, not an
 * engine). The one write verb is CANCEL, and it DELEGATES: only the domain that
 * knows how to stand its runner down may stop it, so cancel forwards to the
 * research store's status write (the same path POST
 * /api/specialists/:id/research/:rid/cancel uses) and 409s for a domain that has
 * no stop. A generic "kill any job" verb would be a lie for a download that is
 * mid-ffmpeg.
 *
 * CORDON, per-requester (NOT owner-only): the owner has no god-view of a
 * household member's downloads, mirroring note_visible_to_caller everywhere
 * else. A drill-in miss and a cordon miss return the SAME 404 so the route can't
 * be used to probe for someone else's job.
 *
 * MOUNTED at /api/jobs → this DOES need `jobs` in the the LLM host nginx `/api/*`
 * alternation (/docker/nginx/locations.conf), unlike the research feed which
 * hid inside the existing /api/specialists namespace. Remember the single-file
 * bind-mount gotcha: `docker restart nginx`, not `nginx -s reload`.
 */
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { AppEventBus } from '@app/events';
import type { Caller } from '@memory/private_to';
import {
  list_jobs,
  get_job,
  emit_job_progress,
  job_from_investigation_row,
  dismiss_job,
  dismiss_all_finished,
  job_key,
} from '@core/jobs';
import {
  ResearchInvestigationStore,
  OPEN_INVESTIGATION_STATUSES,
} from '@memory/stores/research_investigations';
import { progress_of } from './research';

export interface JobsRouterDeps {
  db: Database;
  /** Optional — a cancel patches the ledger so the pill clears without a refetch. */
  events?: AppEventBus;
  /**
   * Reset a failed media job to `pending` and re-kick its runner. Injected
   * rather than imported so this router keeps no dependency on the media
   * pipeline's construction — the SAME reason cancel delegates to the research
   * store instead of reaching into the runner.
   */
  retry_media?: (job_id: string) => void;
}

export function create_jobs_router(deps: JobsRouterDeps): Hono {
  const r = new Hono();
  const jobs_deps = { db: deps.db, progress_of };

  const caller_of = (c: {
    get: (k: 'user') => { id?: string; tier?: string } | undefined;
  }): Caller | null => {
    const user = c.get('user');
    if (!user) return null;
    return { user_id: user.id, tier: (user.tier ?? 'friend') as Caller['tier'] };
  };

  // The feed — active + recent, cordon-filtered. The client polls this on
  // foreground and patches from `job_progress` in between.
  r.get('/', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    return c.json(list_jobs(jobs_deps, caller));
  });

  // Drill-in — one job with its FULL log (the feed truncates to 8 lines).
  r.get('/:kind/:id', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    const job = get_job(jobs_deps, caller, c.req.param('kind'), c.req.param('id'));
    // Unknown kind, unknown id, and "not yours" are all the same 404 — never
    // leak that someone else's job exists.
    if (!job) return c.json({ error: 'not found' }, 404);
    return c.json(job);
  });

  // Cancel — delegated to the owning domain. Gated identically to the reads:
  // being able to STOP work is the same information as being able to see it.
  r.post('/:kind/:id/cancel', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    const kind = c.req.param('kind');
    const id = c.req.param('id');
    const job = get_job(jobs_deps, caller, kind, id);
    if (!job) return c.json({ error: 'not found' }, 404);

    if (kind !== 'research') {
      // Honest refusal, not a silent no-op: a download mid-ffmpeg has no stop,
      // and pretending otherwise would leave the UI showing a cancel that did
      // nothing. `cancellable` on the Job tells clients not to offer the button.
      return c.json({ error: `${kind} jobs cannot be cancelled`, cancellable: false }, 409);
    }

    const store = new ResearchInvestigationStore(deps.db);
    const row = store.get(id);
    if (!row) return c.json({ error: 'not found' }, 404);
    // Idempotent — a double-tap, or a client retrying a request whose response
    // it lost, must not read as an error.
    if (!OPEN_INVESTIGATION_STATUSES.includes(row.status)) {
      return c.json({ job_id: id, state: job.state, cancelled: row.status === 'cancelled' });
    }
    // append_log, never a whole-state write: the runner is the other writer of
    // this column and a full persist from either side deletes the other's lines.
    store.append_log(id, `cancelled by ${caller.user_id} from the jobs ledger while ${row.status}`);
    store.update(id, { status: 'cancelled' });
    const after = store.get(id);
    if (after) emit_job_progress(deps.events, job_from_investigation_row(after, progress_of));
    return c.json({
      job_id: id,
      state: 'cancelled',
      cancelled: true,
      note: 'cancelled — the runner stops at its next phase boundary',
    });
  });

  // Clear ONE finished row from this caller's pane. Per-user and view-only: the
  // domain row is untouched, so the download stays in the library and the
  // dossier stays on the shelf. Idempotent.
  r.post('/:kind/:id/dismiss', (c) => {
    const caller = caller_of(c);
    if (!caller || !caller.user_id) return c.json({ error: 'unauthenticated' }, 401);
    const kind = c.req.param('kind');
    const id = c.req.param('id');
    const job = get_job(jobs_deps, caller, kind, id);
    // Same 404-shape as the reads — dismissing must not reveal that someone
    // else's job exists.
    if (!job) return c.json({ error: 'not found' }, 404);
    const terminal = job.state === 'done' || job.state === 'failed' || job.state === 'cancelled';
    if (!terminal) {
      // Hiding live work would be a footgun: the next job_progress patch puts it
      // straight back, so the button would look broken. Stop it instead.
      return c.json(
        { error: 'that one is still running', hint: job.cancellable ? 'cancel it instead' : null },
        409,
      );
    }
    dismiss_job(deps.db, caller.user_id, job_key(job));
    return c.json({ job_id: id, dismissed: true });
  });

  // Clear everything finished. Active work is deliberately left alone — "clear
  // all" should tidy the shelf, never silence something still in flight.
  r.post('/clear', (c) => {
    const caller = caller_of(c);
    if (!caller || !caller.user_id) return c.json({ error: 'unauthenticated' }, 401);
    const cleared = dismiss_all_finished(jobs_deps, caller);
    return c.json({ cleared });
  });

  // Retry a FAILED media download by re-running the domain's own pipeline.
  //
  // Delegated, like cancel: this route does not reimplement archiving, it resets
  // the row to `pending` through the media store and re-kicks the detached
  // runner — the same two steps `archive_url` performs. Safe to press twice
  // (the tool dedups an in-flight job for the same URL), and only offered where
  // a retry is meaningful: a research dive that failed mid-way is resumable by
  // its own runner, and a swarm review is court-fired.
  r.post('/retry', async (c) => {
    const caller = caller_of(c);
    if (!caller || !caller.user_id) return c.json({ error: 'unauthenticated' }, 401);
    const body = (await c.req.json().catch(() => null)) as { kind?: string; id?: string } | null;
    const kind = body?.kind ?? '';
    const id = body?.id ?? '';
    const job = get_job(jobs_deps, caller, kind, id);
    if (!job) return c.json({ error: 'not found' }, 404);
    if (kind !== 'media_archive') {
      return c.json({ error: `${kind} jobs cannot be retried`, retryable: false }, 409);
    }
    if (job.state !== 'failed') {
      return c.json({ error: 'that one did not fail', state: job.state }, 409);
    }
    if (!deps.retry_media) {
      // The router was built without the runner deps (the smoke harness). Say
      // so rather than silently no-op.
      return c.json({ error: 'retry is not wired on this deployment' }, 501);
    }
    deps.retry_media(id);
    return c.json({ job_id: id, retrying: true });
  });

  return r;
}
