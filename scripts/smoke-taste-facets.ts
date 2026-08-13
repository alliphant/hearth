/**
 * smoke:taste-facets — Phase B of the executive-assistant endgame: the taste
 * & interests facets of the per-user model (music_taste / screen_taste / the
 * interests supplement) and the pull-evidence substrate that feeds them.
 *
 * Self-contained: temp db, scripted LLM, fixture payloads, injected Tautulli
 * transport — no network, no live model. Exercises:
 *   - taste_sources mappers: determinism (same input → same lines + cursor),
 *     grouping/caps/ordering, null on no data (the self-gating shape).
 *   - synthesize_facet source:'pull': provider absent / null / throwing →
 *     no_signal no-op; first pass distills with [1]..[n] numbered evidence +
 *     stores pull_cursor; unchanged cursor → skip (no LLM); changed cursor
 *     within the min-interval → too_soon; past it → re-distill.
 *   - interests supplement: below-threshold obs + changed cursor + past
 *     interval → fires with merged evidence; unchanged cursor → skip.
 *   - resolve_user_model: kate + maggie get the taste facets, iris doesn't;
 *     CORDON (another user sees nothing).
 *   - run_user_model_sweep threading: sources wired end-to-end; a user with
 *     no data is skipped, never errored.
 *   - plex fetch_screen_history_for_taste: unconfigured → null (fail-open),
 *     transport-fed rows project, upstream error → null (no partials).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { UserProfileStore } from '../src/memory/stores/user_profile';
import {
  record_observation,
  resolve_user_model,
  run_user_model_sweep,
  synthesize_facet,
  type ModelDeps,
  type PulledEvidence,
} from '../src/core/user_model';
import {
  interest_signal_evidence,
  music_evidence,
  screen_evidence,
  type ScreenPlayRow,
} from '../src/core/taste_sources';
import {
  _test_set_tautulli_transport,
  fetch_screen_history_for_taste,
} from '../src/connectors/plex';
import type { MusicContextSnapshot } from '../src/memory/client';
import type { StyleLLM } from '../src/core/user_style';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-taste-'));
const prev_um = process.env.HEARTH_USER_MODEL;
const prev_key = process.env.TAUTULLI_API_KEY;
const NOW = new Date('2026-07-04T09:30:00Z');

let llm_calls = 0;
let last_payload = '';
const llm: StyleLLM = {
  for_role() {
    return {
      defaults: { temperature: 0.4 },
      provider: {
        async complete(req: { messages: Array<{ role: string; content: string }> }) {
          llm_calls++;
          last_payload = req.messages[req.messages.length - 1]?.content ?? '';
          return { content: 'DISTILLED TASTE', cost: { model: 'mock' } };
        },
      },
    };
  },
} as unknown as StyleLLM;

// ── fixtures ────────────────────────────────────────────────────────────

const music_snap: MusicContextSnapshot = {
  user_id: 'jasper',
  captured_at: '2026-07-03T07:00:00Z',
  received_at: '2026-07-03T07:00:05Z',
  payload: {
    window_start: '2026-06-03',
    window_end: '2026-07-03',
    top_artists: [
      { artist: 'Radiohead', play_count: 42, last_played: '2026-07-01T20:00:00Z' },
      { artist: 'Khruangbin', play_count: 31 },
    ],
    recently_played: [
      { title: 'Weird Fishes', artist: 'Radiohead', album: 'In Rainbows', played_at: '2026-07-01T20:00:00Z' },
    ],
    starred_playlists: ['Deep Focus'],
    library_counts: { songs: 3200, albums: 260, artists: 410, playlists: 12 },
  },
};

const screen_rows: ScreenPlayRow[] = [
  { media_type: 'episode', title: 'Ep 1', grandparent_title: 'Severance', watched_at: '2026-06-20T02:00:00Z', watched_fraction: 1 },
  { media_type: 'episode', title: 'Ep 2', grandparent_title: 'Severance', watched_at: '2026-06-21T02:00:00Z', watched_fraction: 1 },
  { media_type: 'episode', title: 'Ep 9', grandparent_title: 'Taskmaster', watched_at: '2026-06-25T03:00:00Z', watched_fraction: 0.9 },
  { media_type: 'movie', title: 'Dune: Part Two', grandparent_title: '', watched_at: '2026-06-28T04:00:00Z', watched_fraction: 0.96 },
  { media_type: 'movie', title: 'Some Bad Film', grandparent_title: '', watched_at: '2026-06-29T04:00:00Z', watched_fraction: 0.2 },
  { media_type: 'track', title: 'A Song', grandparent_title: 'An Artist', watched_at: '2026-06-29T05:00:00Z', watched_fraction: 1 },
];

const mail_rows = [
  ...Array.from({ length: 4 }, (_, i) => ({
    from_addr: `news@email.theathletic.com`,
    from_name: 'The Athletic',
    triage_category: 'newsletter',
    i,
  })),
  { from_addr: 'oneoff@somewhere.com', from_name: 'One Off', triage_category: 'personal' },
];

const goods_rows = [
  { name: 'OSMO Pocket 3', category: 'electronics', merchant: 'B&H', purchase_date: '2026-06-15' },
  { name: 'Trail running shoes', category: null, merchant: 'REI', purchase_date: '2026-06-01' },
];

async function main(): Promise<void> {
  const db = open_db(join(dir, 'hearth.db'));
  const store = new UserProfileStore(db);
  process.env.HEARTH_USER_MODEL = '1';

  // ── 1. mappers: determinism + shape + self-gating ─────────────────────
  const m1 = music_evidence(music_snap);
  const m2 = music_evidence(music_snap);
  assert(m1 !== null, 'music: evidence from a real snapshot');
  assert(JSON.stringify(m1) === JSON.stringify(m2), 'music: deterministic (same input → same lines+cursor)');
  assert(m1!.cursor === music_snap.captured_at, 'music: cursor is the snapshot captured_at');
  assert(m1!.lines.some((l) => l.includes('Radiohead') && l.includes('42 plays')), 'music: top-artist line');
  assert(m1!.lines.some((l) => l.startsWith('library: 3200 songs')), 'music: library-counts line');
  assert(music_evidence(null) === null, 'music: null snapshot → null (self-gating)');
  assert(
    music_evidence({ ...music_snap, payload: { ...music_snap.payload, top_artists: [], recently_played: [], starred_playlists: [], library_counts: undefined } }) === null,
    'music: empty payload → null',
  );

  const s1 = screen_evidence(screen_rows);
  const s2 = screen_evidence(screen_rows);
  assert(s1 !== null, 'screen: evidence from history rows');
  assert(s1!.cursor === s2!.cursor, 'screen: deterministic cursor');
  const sev = s1!.lines.find((l) => l.startsWith('tv: Severance'));
  assert(sev != null && sev.includes('2 episodes'), 'screen: episodes grouped per show with counts');
  assert(s1!.lines.findIndex((l) => l.includes('Severance')) < s1!.lines.findIndex((l) => l.includes('Taskmaster')), 'screen: shows ordered by plays');
  assert(s1!.lines.some((l) => l.includes('Dune: Part Two') && l.includes('watched')), 'screen: completed movie is watched');
  assert(s1!.lines.some((l) => l.includes('Some Bad Film') && l.includes('sampled')), 'screen: abandoned movie is sampled');
  assert(!s1!.lines.some((l) => l.includes('A Song')), 'screen: music tracks excluded (music facet owns those)');
  assert(screen_evidence([]) === null && screen_evidence(null) === null, 'screen: no rows → null');

  const i1 = interest_signal_evidence({ mail: mail_rows, goods: goods_rows });
  assert(i1 !== null, 'interests: evidence from mail+goods');
  assert(i1!.lines.some((l) => l.includes('The Athletic') && l.includes('4 messages') && l.includes('newsletter')), 'interests: recurring sender clustered by root domain w/ top category');
  assert(!i1!.lines.some((l) => l.includes('One Off')), 'interests: one-off sender dropped (below recurring floor)');
  assert(i1!.lines.some((l) => l.includes('OSMO Pocket 3') && l.includes('electronics, B&H')), 'interests: purchase line with category+merchant');
  assert((i1!.lines.findIndex((l) => l.includes('OSMO'))) < (i1!.lines.findIndex((l) => l.includes('Trail running'))), 'interests: purchases newest-first');
  assert(interest_signal_evidence({ mail: [], goods: [] }) === null, 'interests: nothing → null');

  // ── 2. synthesize_facet source:'pull' gating ──────────────────────────
  let music_ret: PulledEvidence | null = m1;
  const deps: ModelDeps = {
    facets: store,
    llm,
    recent_user_messages: () => [],
    sources: {
      music: () => music_ret,
      screen: () => screen_evidence(screen_rows),
      throwing: () => {
        throw new Error('boom');
      },
    },
  };

  // provider missing entirely (no 'screen' key) → no_signal
  const no_provider = await synthesize_facet('jasper', 'screen_taste', { ...deps, sources: {} }, { now: NOW });
  assert(no_provider.updated === false && no_provider.reason === 'no_signal', 'pull: absent provider → no_signal no-op');

  // provider returns null → no_signal, no LLM
  llm_calls = 0;
  music_ret = null;
  const null_ret = await synthesize_facet('jasper', 'music_taste', deps, { now: NOW });
  assert(null_ret.updated === false && null_ret.reason === 'no_signal' && llm_calls === 0, 'pull: null evidence → no_signal, zero LLM');

  // first pass distills, numbered evidence, cursor stored
  music_ret = m1;
  llm_calls = 0;
  const first = await synthesize_facet('jasper', 'music_taste', deps, { now: NOW });
  assert(first.updated === true && llm_calls === 1, 'pull: first pass distills');
  assert(last_payload.includes('[1] ') && last_payload.includes('[2] '), 'pull: evidence enumerated [1]..[n] (citations idiom)');
  const mf = store.get_facet('jasper', 'music_taste');
  assert(mf?.summary === 'DISTILLED TASTE', 'pull: summary stored');
  assert(mf?.pull_cursor === m1!.cursor, 'pull: cursor stored on the facet');
  assert((mf?.sources ?? []).includes('music') && (mf?.sources ?? []).includes('pull'), 'pull: provenance carries source kind + provider key');

  // unchanged cursor → skip, no LLM
  llm_calls = 0;
  const unchanged = await synthesize_facet('jasper', 'music_taste', deps, { now: new Date('2026-07-20T09:30:00Z') });
  assert(unchanged.updated === false && unchanged.reason === 'unchanged' && llm_calls === 0, 'pull: unchanged cursor → skip, zero LLM');

  // changed cursor but inside the min-interval → too_soon
  music_ret = { lines: m1!.lines, cursor: 'changed-cursor-1' };
  const soon = await synthesize_facet('jasper', 'music_taste', deps, { now: new Date('2026-07-06T09:30:00Z') });
  assert(soon.updated === false && soon.reason === 'too_soon', 'pull: changed cursor within min-interval → too_soon');

  // changed cursor past the min-interval → re-distill
  llm_calls = 0;
  const redo = await synthesize_facet('jasper', 'music_taste', deps, { now: new Date('2026-07-20T09:30:00Z') });
  assert(redo.updated === true && llm_calls === 1, 'pull: changed cursor past interval → re-distill');
  assert(store.get_facet('jasper', 'music_taste')?.pull_cursor === 'changed-cursor-1', 'pull: cursor advanced');

  // throwing provider → no_signal (fail-open), never propagates
  const thrown = await synthesize_facet(
    'jasper',
    'screen_taste',
    { ...deps, sources: { screen: deps.sources!['throwing']! } },
    { now: NOW },
  );
  assert(thrown.updated === false && thrown.reason === 'no_signal', 'pull: throwing provider → no_signal (fail-open)');

  // ── 3. interests supplement gating ────────────────────────────────────
  // Prior summary + a handful of obs (below the 25 threshold) + supplement.
  let interest_ret: PulledEvidence | null = i1;
  const sup_deps: ModelDeps = {
    ...deps,
    sources: { interest_signals: () => interest_ret },
  };
  for (let i = 0; i < 5; i++) record_observation(store, 'supu', 'interests', `obs ${i}`, new Date('2026-06-20T00:00:00Z'));
  llm_calls = 0;
  const sup_first = await synthesize_facet('supu', 'interests', sup_deps, { now: NOW });
  assert(sup_first.updated === true, 'supplement: first pass fires (obs + pulled merged)');
  assert(last_payload.includes('obs 0') && last_payload.includes('The Athletic'), 'supplement: evidence merges observations + pulled lines');
  assert(last_payload.includes('[1] '), 'supplement: merged evidence is numbered');
  assert(store.get_facet('supu', 'interests')?.pull_cursor === i1!.cursor, 'supplement: cursor stored');

  // unchanged cursor + below-threshold obs → below_threshold skip, no LLM
  llm_calls = 0;
  const sup_same = await synthesize_facet('supu', 'interests', sup_deps, { now: new Date('2026-07-20T00:00:00Z') });
  assert(sup_same.updated === false && sup_same.reason === 'below_threshold' && llm_calls === 0, 'supplement: unchanged cursor + few obs → skip');

  // changed cursor, below-threshold obs, past interval → fires
  interest_ret = { lines: i1!.lines, cursor: 'mail-changed-2' };
  const sup_redo = await synthesize_facet('supu', 'interests', sup_deps, { now: new Date('2026-07-20T00:00:00Z') });
  assert(sup_redo.updated === true, 'supplement: changed cursor alone refreshes (past interval)');
  // changed cursor within interval → too_soon
  interest_ret = { lines: i1!.lines, cursor: 'mail-changed-3' };
  const sup_soon = await synthesize_facet('supu', 'interests', sup_deps, { now: new Date('2026-07-21T00:00:00Z') });
  assert(sup_soon.updated === false && sup_soon.reason === 'too_soon', 'supplement: changed cursor within interval → too_soon');
  // no provider at all → behaves exactly like the legacy interests facet
  const sup_legacy = await synthesize_facet('supu', 'interests', { ...deps, sources: {} }, { now: new Date('2026-07-22T00:00:00Z') });
  assert(sup_legacy.updated === false && sup_legacy.reason === 'below_threshold', 'supplement: absent provider → legacy observation gating');

  // ── 4. resolve: domain scoping + cordon ───────────────────────────────
  const rk = resolve_user_model(store, 'jasper', 'kate', NOW);
  const kkeys = rk.facets.map((f) => f.key);
  assert(kkeys.includes('music_taste'), 'resolve: kate reads music_taste');
  const rm = resolve_user_model(store, 'jasper', 'maggie', NOW);
  assert(rm.facets.some((f) => f.key === 'music_taste'), 'resolve: maggie reads music_taste');
  const ri = resolve_user_model(store, 'jasper', 'iris', NOW);
  assert(!ri.facets.some((f) => f.key === 'music_taste' || f.key === 'screen_taste'), 'resolve: iris is domain-scoped away from taste');
  const rs = resolve_user_model(store, 'sam', 'kate', NOW);
  assert(!rs.facets.some((f) => f.key === 'music_taste'), 'resolve: CORDON — sam sees none of jasper\'s taste');

  // ── 5. sweep threading end-to-end ─────────────────────────────────────
  const sweep = await run_user_model_sweep(['tasteu', 'nodatau'], {
    ...deps,
    sources: {
      music: (uid) => (uid === 'tasteu' ? music_evidence(music_snap) : null),
      screen: (uid) => (uid === 'tasteu' ? screen_evidence(screen_rows) : null),
    },
  }, { now: NOW });
  const updated = sweep.filter((r) => r.updated).map((r) => `${r.user_id}/${r.facet}`);
  assert(updated.includes('tasteu/music_taste') && updated.includes('tasteu/screen_taste'), 'sweep: taste facets refresh through the shared engine');
  assert(
    sweep.filter((r) => r.user_id === 'nodatau').every((r) => !r.updated),
    'sweep: a user with no taste data is skipped (no-op, no error)',
  );
  assert(
    sweep.some((r) => r.user_id === 'nodatau' && r.facet === 'music_taste' && r.reason === 'no_signal'),
    'sweep: the skip reason is honest no_signal',
  );

  // ── 6. plex fetch_screen_history_for_taste ────────────────────────────
  delete process.env.TAUTULLI_API_KEY;
  const unconfigured = await fetch_screen_history_for_taste({});
  assert(unconfigured === null, 'plex: unconfigured Tautulli → null (fail-open self-gating)');

  process.env.TAUTULLI_API_KEY = 'test-key';
  const seen_cmds: string[] = [];
  let saw_after = true;
  _test_set_tautulli_transport(async (cmd, params) => {
    seen_cmds.push(cmd);
    // Tautulli range reads must use `after` (since-date), never `start_date`
    // (an exact-day filter that silently returns ~0 rows — live bug 2026-07-04).
    if (typeof params.after !== 'string' || 'start_date' in params) saw_after = false;
    const mt = String(params.media_type);
    return {
      ok: true,
      data: {
        data: [
          mt === 'episode'
            ? { title: 'Ep 3', grandparent_title: 'Severance', media_type: 'episode', stopped: 1750000000, view_offset: 900000, duration: 1000000 }
            : { title: 'Heat', media_type: 'movie', stopped: 1750100000, watched_status: 1 },
        ],
      },
    };
  });
  const fetched = await fetch_screen_history_for_taste({});
  assert(seen_cmds.every((c) => c === 'get_history') && seen_cmds.length === 2, 'plex: fetcher uses get_history per media type');
  assert(saw_after, 'plex: range reads use `after` (since-date), never the exact-day start_date');
  assert(fetched !== null && fetched.length === 2, 'plex: transport rows projected (episode + movie)');
  assert(fetched!.some((r) => r.grandparent_title === 'Severance' && r.media_type === 'episode'), 'plex: episode row shape');
  const heat = fetched!.find((r) => r.title === 'Heat');
  assert(heat != null && heat.watched_fraction === 1, 'plex: watched_status → fraction 1');

  // upstream error on the second media type → null, never a partial
  _test_set_tautulli_transport(async (_cmd, params) => {
    if (String(params.media_type) === 'movie') return { ok: false, error: 'HTTP 500' };
    return { ok: true, data: { data: [{ title: 'Ep', grandparent_title: 'Show', media_type: 'episode', stopped: 1750000000 }] } };
  });
  assert((await fetch_screen_history_for_taste({})) === null, 'plex: upstream error → null (no skewed partials)');
  _test_set_tautulli_transport(null);

  db.close();
  console.log(`\n✅ smoke:taste-facets — ${pass} checks passed`);
}

main()
  .catch((e) => {
    console.error(`\n❌ smoke:taste-facets FAILED after ${pass} checks`);
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    if (prev_um === undefined) delete process.env.HEARTH_USER_MODEL;
    else process.env.HEARTH_USER_MODEL = prev_um;
    if (prev_key === undefined) delete process.env.TAUTULLI_API_KEY;
    else process.env.TAUTULLI_API_KEY = prev_key;
    _test_set_tautulli_transport(null);
    rmSync(dir, { recursive: true, force: true });
  });
