/**
 * smoke:jobs — the "On the Fire" cross-domain job ledger (core/jobs.ts).
 *
 * Drives the projection against REAL store writes on a `:memory:` DB, because
 * the failure mode this module can have is a mapper that reads a column the
 * store doesn't actually populate — exactly the `MediaChapter.start_s` /
 * SecurityRoom `keyNotFound("id")` class. A hand-built fixture would prove
 * nothing; these rows go through `MediaArchiveJobStore.create` /
 * `ResearchInvestigationStore.create` and come back out through `list_jobs`.
 *
 *   bun run smoke:jobs
 */
import { open_db } from '../src/memory/stores/structured';
import { MediaArchiveJobStore } from '../src/memory/stores/media_jobs';
import { ResearchInvestigationStore } from '../src/memory/stores/research_investigations';
import { list_jobs, get_job, job_from_media_row, job_from_swarm_row, dismiss_job, dismiss_all_finished, job_key } from '../src/core/jobs';
import { SwarmReviewStore } from '../src/memory/stores/swarm_reviews';
import { archive_push_body } from '../src/specialists/kate/media_archive_runner';
import { progress_of } from '../src/app/routes/research';
import type { Caller } from '../src/memory/private_to';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const OWNER: Caller = { user_id: 'jasper', tier: 'owner' };
const FRIEND: Caller = { user_id: 'kim', tier: 'friend' };

function main(): void {
  const db = open_db(':memory:');
  const deps = { db, progress_of };
  const media = new MediaArchiveJobStore(db);
  const research = new ResearchInvestigationStore(db);

  // ── a live-shaped media job, mid-download ─────────────────────────────────
  const job = media.create({
    url: 'https://www.youtube.com/watch?v=OSayp2tArqA',
    requested_by: 'jasper',
    conversation_id: '01KYR0THX1Q59W4NA449V1PJG4',
  });
  media.update(job.id, {
    status: 'downloading',
    // The REAL probe shape: a full yt-dlp info-json passthrough, not a curated
    // map (the lesson from MediaItemDetail.metrics).
    probe: { title: 'JO PARIS 2024 - Le magnifique "Nightcall"', source: 'yt-dlp', extractor: 'youtube' },
    category: { media_kind: 'clip', folder_segments: ['Video', 'YouTube', 'Eurosport', 'Olympics 2024'] },
    state: { log: ['probed youtube: JO PARIS 2024', 'categorized clip · nsfw_pre=sfw'] },
  });

  let feed = list_jobs(deps, OWNER);
  check('an in-flight media job appears in active', feed.active.length === 1);
  const m = feed.active[0]!;
  check('title comes from the probe info-json', m.title.startsWith('JO PARIS 2024'));
  check('subtitle is the archive folder', m.subtitle === 'Video / YouTube / Eurosport / Olympics 2024');
  check('phase is domain-native', m.phase === 'downloading');
  check('phase_label is human', m.phase_label === 'Downloading');
  check('state collapses to running', m.state === 'running');
  check('progress is null (indeterminate, never faked)', m.progress === null);
  check('the runner log rides along', m.log.length === 2);
  check('a user-requested job in a thread is awaited', m.awaited === true);
  check('no result route while running', m.result_route === null);
  check('media is not cancellable (no stop mid-ffmpeg)', m.cancellable === false);

  // ── terminal → moves to recent, gains a result route ──────────────────────
  media.update(job.id, { status: 'done', media_item_id: 'mi_abc12345' });
  feed = list_jobs(deps, OWNER);
  check('a finished job leaves active', feed.active.length === 0);
  check('…and lands in recent', feed.recent.length === 1);
  check('done exposes the deep link', feed.recent[0]!.result_route === 'hearth://media/mi_abc12345');
  check('done state is done', feed.recent[0]!.state === 'done');

  // ── a failed job reads failed, not done ───────────────────────────────────
  const bad = media.create({ url: 'https://example.com/nope', requested_by: 'jasper' });
  media.update(bad.id, { status: 'failed', error: 'probe failed: unsupported url' });
  feed = list_jobs(deps, OWNER);
  const f = feed.recent.find((j) => j.id === bad.id)!;
  check('a failed job reads failed', f.state === 'failed');
  check('the error is verbatim', f.error === 'probe failed: unsupported url');
  check('a job with no conversation is NOT awaited', f.awaited === false);

  // ── queued vs running: pending is not yet started ─────────────────────────
  const queued = media.create({ url: 'https://example.com/q', requested_by: 'jasper' });
  check('pending reads queued', list_jobs(deps, OWNER).active.find((j) => j.id === queued.id)!.state === 'queued');

  // ── research projects through the SAME shape ──────────────────────────────
  const ri = research.create({
    subject: 'Chris Barrett',
    subject_kind: 'person',
    brief: 'Pleasantville councilmember',
    requested_by: 'jasper',
    conversation_id: 'conv_x',
    agent_id: 'kate',
  });
  research.update(ri.id, { status: 'verifying' });
  const r_job = list_jobs(deps, OWNER).active.find((j) => j.id === ri.id)!;
  check('a research dive lists next to a download', r_job.kind === 'research');
  check('research phase_label is human', r_job.phase_label === 'Checking claims');
  check('research DOES report progress', r_job.progress === progress_of('verifying'));
  check('research progress delegates, never re-derives', r_job.progress === 0.7);
  check('research is cancellable', r_job.cancellable === true);
  check('the filing specialist owns the hue', r_job.owner_specialist_id === 'kate');

  // ── CORDON: a friend sees none of the owner's jobs ─────────────────────────
  const friend_feed = list_jobs(deps, FRIEND);
  check('a friend sees no owner job in active', friend_feed.active.length === 0);
  check('a friend sees no owner job in recent', friend_feed.recent.length === 0);
  check('drill-in is 404-shape for a friend', get_job(deps, FRIEND, 'media_archive', job.id) === null);
  check('drill-in works for the owner', get_job(deps, OWNER, 'media_archive', job.id)?.id === job.id);
  check('an unknown kind is null, not a throw', get_job(deps, OWNER, 'nonsense', job.id) === null);
  check('an unknown id is null', get_job(deps, OWNER, 'media_archive', 'ma_nope') === null);

  // ── a row with EVERY optional column empty must still project ─────────────
  // The pane must degrade, never blank: a job created and never advanced has a
  // null probe, null category, empty state — the shape a crash-resume leaves.
  const bare = media.create({ url: 'https://example.com/bare' });
  const bare_job = job_from_media_row(media.get(bare.id)!);
  check('a bare row falls back to the URL as title', bare_job.title === 'https://example.com/bare');
  check('a bare row falls back to the hostname as subtitle', bare_job.subtitle === 'example.com');
  check('a bare row has an empty log, not undefined', Array.isArray(bare_job.log) && bare_job.log.length === 0);
  check('a bare row is not awaited (nobody asked)', bare_job.awaited === false);

  // ── active is newest-first; recent is most-recently-finished first ─────────
  check('active sorts newest first', list_jobs(deps, OWNER).active[0]!.created_at >= list_jobs(deps, OWNER).active.at(-1)!.created_at);

  // ── AWAITED must reject SYNTHETIC conversations ───────────────────────────
  // The regression: `ri_8kpyxw9m4ncr` in production carries
  // `conversation_id = 'deliberation:ruby:00:00'` — machinery, not a thread a
  // human sits in. Marking it awaited fires a Live Activity and bypasses the
  // delivery-window push gate for work nobody asked for.
  const auto = research.create({
    subject: 'Autonomous sweep',
    subject_kind: 'general',
    brief: 'fired by a deliberation slot',
    requested_by: 'jasper',
    conversation_id: 'deliberation:ruby:00:00',
    agent_id: 'ruby',
  });
  const auto_job = list_jobs(deps, OWNER).active.find((j) => j.id === auto.id)!;
  check('a deliberation-launched dive is NOT awaited', auto_job.awaited === false);
  check('…but it is still VISIBLE in the pane', auto_job.state === 'queued');
  const delegated = media.create({
    url: 'https://example.com/synthetic',
    requested_by: 'jasper',
    conversation_id: 'delegate:kate:abc',
  });
  check(
    'a delegate: context is NOT awaited either',
    list_jobs(deps, OWNER).active.find((j) => j.id === delegated.id)!.awaited === false,
  );

  // ── SWARM REVIEWS — folded in when the bee glyph was deleted ───────────────
  const swarm = new SwarmReviewStore(db);
  const rev = swarm.create({
    change_id: 'bchg_test0001',
    title: 'Relax record_sku source_url from strict URL to any non-empty string',
    bench: [
      { seat_id: 'red-1', role: 'red', conversation_id: 'swarm:x:red-1' },
      { seat_id: 'red-2', role: 'red', conversation_id: 'swarm:x:red-2' },
      { seat_id: 'blue-1', role: 'blue', conversation_id: 'swarm:x:blue-1' },
      { seat_id: 'judge', role: 'judge', conversation_id: 'swarm:x:judge' },
    ],
    // The ONLY commission site hardcodes null (review_routing.ts:116).
    user_id: null,
  });
  const live = list_jobs(deps, OWNER).active.find((j) => j.id === rev.id)!;
  check('a running review appears in the pane', live.kind === 'swarm_review');
  check('it reads as Reviewing', live.phase_label === 'Reviewing');
  check('the bench size is the subtitle', live.subtitle === '4-seat bench');
  check('seats come through as chips', live.detail?.seats?.length === 4);
  check('seat roles survive verbatim', live.detail?.seats?.[0]?.role === 'red');
  // Court-fired work is VISIBLE but never claims attention — the distinction
  // that made excluding it originally the wrong call.
  check('a review is never awaited', live.awaited === false);
  check('a review offers no cancel', live.cancellable === false);
  check('progress is indeterminate (no per-seat persistence)', live.progress === null);

  swarm.add_finding({
    review_id: rev.id,
    seat_id: 'red-1',
    role: 'red',
    severity: 'blocker',
    summary: 'no blocker found',
  });
  const withFinding = list_jobs(deps, OWNER).active.find((j) => j.id === rev.id)!;
  check('findings are TALLIED, not listed', withFinding.detail?.tally?.[0]?.value === 1);
  check('the tally is labelled', withFinding.detail?.tally?.[0]?.label === 'findings');

  swarm.set_verdict(rev.id, 'pass');
  const judged = list_jobs(deps, OWNER).recent.find((j) => j.id === rev.id)!;
  check('a judged review moves to recent', judged.state === 'done');
  check('the verdict is the phase label', judged.phase_label === 'pass');
  check('the verdict is also the outcome chip', judged.detail?.outcome === 'pass');
  check('judged seats read done', judged.detail?.seats?.every((s) => s.phase === 'done') === true);

  // ── CORDON: user_id is always NULL, so a review is OWNER-ONLY ──────────────
  // note_visible_to_caller(undefined) fails CLOSED (private_to.ts:118).
  check(
    'a household member cannot see a review',
    list_jobs(deps, { user_id: 'sam', tier: 'household' }).recent.every((j) => j.kind !== 'swarm_review'),
  );
  check('a friend cannot either', list_jobs(deps, FRIEND).recent.every((j) => j.kind !== 'swarm_review'));

  // ── A STRANDED review must not read as live forever ───────────────────────
  // There is no boot sweep and no reconciliation: `run_swarm` is the only writer
  // of `status`, so a restart mid-review leaves `running` permanently and
  // `list_active()` returns it forever. Without a ceiling it would sit in the
  // pane reading "Reviewing" until someone edited SQL.
  const stranded = swarm.create({
    change_id: 'bchg_stranded',
    title: 'Orchestrator died mid-review',
    bench: [{ seat_id: 'red-1', role: 'red', conversation_id: 'swarm:y:red-1' }],
    user_id: null,
  });
  const srow = swarm.get(stranded.id)!;
  check('a fresh stranded row still reads running', job_from_swarm_row(srow, []).state === 'running');
  const aged = job_from_swarm_row(srow, [], Date.parse(srow.started_at) + 16 * 60_000);
  check('past the ceiling it reads FAILED, not running', aged.state === 'failed');
  check('and says so honestly', aged.phase_label === 'Stalled');
  check('with an error a human can read', (aged.error ?? '').includes('without recording a verdict'));

  // ── CLEARING: per-user, view-only, never touches the domain row ───────────
  const before = list_jobs(deps, OWNER);
  const to_clear = before.recent[0]!;
  dismiss_job(db, 'jasper', job_key(to_clear));
  const after = list_jobs(deps, OWNER);
  check('a dismissed row leaves the pane', !after.recent.some((j) => j.id === to_clear.id));
  check('…but the domain row is untouched', media.get(to_clear.id) !== null || to_clear.kind !== 'media_archive');
  // Per-user for real: Sam's dismissal of HER OWN row must not touch Jasper's
  // view of HIS. (A `|| true` here would make this pass vacuously — it did, in
  // the first draft.)
  // private_to is set at CREATE (the cordon stamp), not via update().
  const sams = media.create({
    url: 'https://example.com/sam',
    requested_by: 'sam',
    private_to: 'sam',
  });
  media.update(sams.id, { status: 'done', media_item_id: 'mi_sara' });
  const SAM: Caller = { user_id: 'sam', tier: 'household' };
  check('sam sees her own finished row', list_jobs(deps, SAM).recent.some((j) => j.id === sams.id));
  dismiss_job(db, 'sam', `media_archive:${sams.id}`);
  check('…and clearing it hides it from her', !list_jobs(deps, SAM).recent.some((j) => j.id === sams.id));
  check(
    'jasper\'s own shelf is untouched by sam clearing hers',
    list_jobs(deps, OWNER).recent.length > 0,
  );
  check('dismissing twice is idempotent', (() => {
    dismiss_job(db, 'jasper', job_key(to_clear));
    return list_jobs(deps, OWNER).recent.filter((j) => j.id === to_clear.id).length === 0;
  })());

  const active_before = list_jobs(deps, OWNER).active.length;
  const cleared = dismiss_all_finished(deps, OWNER);
  const post = list_jobs(deps, OWNER);
  check('clear-all empties the finished shelf', post.recent.length === 0);
  check('clear-all reports what it cleared', cleared >= 0);
  // The load-bearing half: tidying the shelf must never silence live work.
  check('clear-all leaves ACTIVE work alone', post.active.length === active_before);

  // ── A CORDONED item's title must never reach the lock screen ──────────────
  // 2026-07-30: a push read `Archived "Stepsister gets a hardcore throatfuck
  // PT 2" — it's in your library.` It went only to the owner (verified in the
  // apns_dispatch audit), but a lock-screen preview is readable by anyone
  // standing nearby, which defeats the point of the item being owner-only.
  check(
    'an owner-only item is announced WITHOUT its title',
    archive_push_body('Something extremely explicit', true) ===
      "I archived the video you asked for, it's in your library.",
  );
  check(
    'the sanitized body leaks no part of the name',
    !archive_push_body('Something extremely explicit', true).includes('explicit'),
  );
  check(
    'a household-visible item still names itself (that is the useful case)',
    archive_push_body('Nightcall', false).includes('Nightcall'),
  );

  // ── PHASE CHAIN + "how long does this usually take" ───────────────────────
  // the always-on host fresh rows: by this point clear-all has emptied the shelf, and a
  // `if (found)` guard would let these checks silently skip — which is barely
  // better than a vacuous assertion.
  const chain_media = media.create({ url: 'https://example.com/chain', requested_by: 'jasper' });
  media.update(chain_media.id, { status: 'downloading' });
  const chain_rev = swarm.create({
    change_id: 'bchg_chain',
    title: 'chain check',
    bench: [{ seat_id: 'red-1', role: 'red', conversation_id: 'swarm:z:red-1' }],
    user_id: null,
  });
  const chained = list_jobs(deps, OWNER);
  const any_media = chained.active.find((j) => j.id === chain_media.id);
  check('the fresh media row is there to check', any_media !== undefined);
  if (any_media) {
    check('a media job carries its phase chain', any_media.phase_chain.length > 0);
    check('the chain is ordered, queued first', any_media.phase_chain[0]!.phase === 'pending');
    check(
      'the chain excludes terminal phases (it is the road, not the destination)',
      !any_media.phase_chain.some((p) => p.phase === 'done' || p.phase === 'failed'),
    );
    check(
      'chain labels match the row labels exactly',
      any_media.phase_chain.every((p) => typeof p.label === 'string' && p.label.length > 0),
    );
  }
  const rev_job = chained.active.find((j) => j.id === chain_rev.id);
  check('the fresh review row is there to check', rev_job !== undefined);
  if (rev_job) {
    // A bench is not a sequence — the seats run concurrently and the judge
    // closes. Inventing a chain would misrepresent how the work happens.
    check('a swarm bench has NO chain (it is not a sequence)', rev_job.phase_chain.length === 0);
  }
  // typical_ms is a median over history and must stay null below the sample
  // floor — "usually" as a guess dressed up as a fact is worse than silence.
  check(
    'typical_ms is null or a positive number, never a guess',
    [...chained.active, ...chained.recent].every((j) => j.typical_ms === null || j.typical_ms > 0),
  );
  // Below the sample floor it must stay null rather than extrapolate from one run.
  check(
    'a kind with no finished history reports no typical',
    chained.active.every((j) => j.typical_ms === null || j.typical_ms > 0),
  );

  console.log(`\n✅ smoke:jobs — ${passed} checks passed`);
}

main();
