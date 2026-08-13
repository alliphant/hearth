/**
 * smoke:kate-reflection — the walk-the-house reflection pass (C2 self-direction
 * spine): src/core/kate_reflection.ts + the kate_observations ledger.
 *
 * Self-contained: temp db (real ProposalsStore tables via open_db), scripted
 * LLM (no network/model). Asserts the load-bearing contracts:
 *   - kill switch (HEARTH_KATE_REFLECTION unset → no-op, no table writes)
 *   - envelope parse → ledger rows with intended vs applied dispositions
 *   - WATCH-ONLY soak: act/investigate/ask DOWNGRADE to watch (recorded intent)
 *   - anchor dedup: re-observation bumps times_seen, no new row
 *   - dismissed-stays-dismissed: a dismissed anchor is SUPPRESSED on re-observation
 *   - armed act: files an action_proposal ONCE (exists_for_signature dedup),
 *     capped at 2/pass
 *   - fail-CLOSED: garbled envelope files nothing
 *   - ignore semantics: recorded as resolved (dedup survives, not watched)
 *   - expire_stale: stale open watches age out
 *   - render_own_watchlist: cordon-filtered, '' when off/empty
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { ProposalsStore } from '../src/core/proposals';
import { KateObservations } from '../src/memory/stores/kate_observations';
import {
  run_reflection,
  parse_reflection_envelope,
  render_own_watchlist,
  score_initiative,
  type ReflectionDeps,
} from '../src/core/kate_reflection';
import type { LLMRouter } from '../src/core/llm';
import type { MemoryClient } from '../src/memory/client';

let checks = 0;
let fails = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) fails++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
}

function mock_llm(reply: string, opts?: { throws?: boolean }): LLMRouter {
  return {
    for_role: (_r: string) => ({
      provider: {
        complete: async () => {
          if (opts?.throws) throw new Error('endpoint down');
          return { content: reply };
        },
      },
      defaults: {},
    }),
  } as unknown as LLMRouter;
}

/** Minimal MemoryClient stand-in — compose_working_memory probes stores that
 *  all fail-open on a stub, and the engine treats the picture as best-effort. */
const memory_stub = {
  query_household_goods: () => [],
  events_within: () => [],
  birthdays_within: () => [],
} as unknown as MemoryClient;

function envelope(observations: unknown[]): string {
  return JSON.stringify({ observations });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kate-reflection-'));
  const db = open_db(join(dir, 'test.db'));
  const proposals = new ProposalsStore(db);
  const store = new KateObservations(db);
  const audits: Array<Record<string, unknown>> = [];
  const deps = (llm: LLMRouter): ReflectionDeps => ({
    db,
    memory: memory_stub,
    llm,
    proposals,
    observations: store,
    audit: (s) => audits.push(s),
  });
  const opts = { user_id: 'jasper', tier: 'owner' as const, timezone: 'America/Denver' };

  // ── parse (pure) ───────────────────────────────────────────────────────────
  const good = parse_reflection_envelope(
    envelope([
      { anchor: 'a:b', summary: 'something', rationale: 'why', evidence_refs: ['line'], disposition: 'watch' },
    ]),
  );
  check('parse: valid envelope → 1 observation', good !== null && good.length === 1);
  const fenced = parse_reflection_envelope('```json\n' + envelope([{ anchor: 'x:y', summary: 'abc', rationale: '', evidence_refs: [], disposition: 'ignore' }]) + '\n```');
  check('parse: fenced JSON tolerated', fenced !== null && fenced.length === 1);
  check('parse: garbage → null (fail-closed)', parse_reflection_envelope('I noticed some things!') === null);
  check(
    'parse: bad disposition dropped',
    (parse_reflection_envelope(envelope([{ anchor: 'x', summary: 'abc', rationale: '', evidence_refs: [], disposition: 'panic' }])) ?? []).length === 0,
  );

  // ── kill switch ────────────────────────────────────────────────────────────
  delete process.env.HEARTH_KATE_REFLECTION;
  delete process.env.HEARTH_KATE_REFLECTION_ACT;
  const off = await run_reflection(deps(mock_llm(envelope([]))), opts);
  check('kill switch: disabled → enabled:false, nothing ran', !off.enabled && !off.ran && store.counts().open === 0);

  // ── watch-only soak: downgrades + ledger writes ───────────────────────────
  process.env.HEARTH_KATE_REFLECTION = '1';
  const r1 = await run_reflection(
    deps(
      mock_llm(
        envelope([
          { anchor: 'Water Bill: Spike!', summary: 'Water bill landed 40% high', rationale: 'vs prior months', evidence_refs: ['bill line'], disposition: 'watch', recheck_when: 'next bill' },
          { anchor: 'garage:late-open', summary: 'Garage open past midnight again', rationale: 'third time', evidence_refs: ['sensor line'], disposition: 'act' },
          { anchor: 'junk:mail-volume', summary: 'Mail volume normal', rationale: '', evidence_refs: [], disposition: 'ignore' },
        ]),
      ),
    ),
    opts,
  );
  check('soak: ran with 3 observations, 3 new', r1.ran && r1.observations === 3 && r1.new_items === 3);
  check('soak: act DOWNGRADED to watch (no proposal filed)', r1.downgraded === 1 && r1.proposals_filed.length === 0);
  const garage = store.get_by_anchor('garage:late-open');
  check(
    'soak: ledger records intended=act / applied=watch',
    garage?.intended_disposition === 'act' && garage?.applied_disposition === 'watch' && garage?.status === 'open',
  );
  const ignored = store.get_by_anchor('junk:mail-volume');
  check('ignore → resolved (recorded, not watched)', ignored?.status === 'resolved');
  const water = store.get_by_anchor('water bill: spike!');
  check('anchor normalized + recheck_when kept', water !== null && water.recheck_when === 'next bill');

  // ── recurrence: same anchor bumps, no new row ─────────────────────────────
  const r2 = await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'water-bill:-spike!', summary: 'Still high', rationale: 'second read', evidence_refs: ['bill'], disposition: 'watch' }]))),
    opts,
  );
  check('recurrence: same anchor → recurring, not new', r2.recurring === 1 && r2.new_items === 0);
  check('recurrence: times_seen bumped', store.get_by_anchor('water bill: spike!')?.times_seen === 2);

  // ── dedup backstop: a FRESH anchor for a watched concern snaps onto it ─────
  await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'hyundai:bluelink:cancellation', summary: 'Bluelink cancel pending', rationale: '', evidence_refs: ['x'], disposition: 'watch' }]))),
    opts,
  );
  const rd = await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'hyundai:bluelink:stale', summary: 'Bluelink still unresolved', rationale: '', evidence_refs: ['x'], disposition: 'watch' }]))),
    opts,
  );
  check('dedup: anchor variant merged (recurring, not new)', rd.recurring === 1 && rd.new_items === 0);
  check('dedup: no splinter row for the variant anchor', store.get_by_anchor('hyundai:bluelink:stale') === null);
  check('dedup: concern accrued on the original row', store.get_by_anchor('hyundai:bluelink:cancellation')?.times_seen === 2);
  // false-merge guard: distinct concerns sharing ONE generic token stay separate.
  await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'amazon:payment:declined', summary: 'Amazon card declined', rationale: '', evidence_refs: ['x'], disposition: 'watch' }]))),
    opts,
  );
  const rn = await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'usenet:payment:error', summary: 'Usenet payment failed', rationale: '', evidence_refs: ['x'], disposition: 'watch' }]))),
    opts,
  );
  check('dedup: distinct concern sharing one generic token NOT merged', rn.new_items === 1 && store.get_by_anchor('usenet:payment:error') !== null);

  // ── `ignore` is TERMINAL, whatever the row was before ─────────────────────
  // The live failure (2026-08-02): a concern first raised as `watch`, then
  // ignored every night after, stayed `open` at times_seen 16 — she re-derived
  // "not worth attention" nightly and it never left her plate.
  await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'workspace:billing', summary: 'Workspace billing failed', rationale: '', evidence_refs: ['x'], disposition: 'watch' }]))),
    opts,
  );
  check('terminal: a watch starts open', store.get_by_anchor('workspace:billing')?.status === 'open');
  await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'workspace:billing', summary: 'Workspace billing — still nothing to do', rationale: '', evidence_refs: ['x'], disposition: 'ignore' }]))),
    opts,
  );
  const settled = store.get_by_anchor('workspace:billing');
  check('terminal: ignoring an OPEN row resolves it', settled?.status === 'resolved');
  check('terminal: the row keeps its history', (settled?.times_seen ?? 0) === 2);
  await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'workspace:billing', summary: 'Workspace billing now overdue 60 days', rationale: '', evidence_refs: ['x'], disposition: 'watch' }]))),
    opts,
  );
  check('terminal: a settled row still REOPENS when it changes', store.get_by_anchor('workspace:billing')?.status === 'open');

  // ── the dedup pool spans SETTLED anchors, not just open ones ──────────────
  // Without this, resolving an ignored row (above) hides it from the backstop
  // and tomorrow's pass re-coins a fresh variant — trading one bug for another.
  await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'sam:daughter:ct-status', summary: 'CT status check still due', rationale: '', evidence_refs: ['x'], disposition: 'ignore' }]))),
    opts,
  );
  check('pool: the ignored row is settled', store.get_by_anchor('sam:daughter:ct-status')?.status === 'resolved');
  const rs = await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'sam:daughter:ct-procedure', summary: 'CT procedure happened last night', rationale: '', evidence_refs: ['x'], disposition: 'ignore' }]))),
    opts,
  );
  check('pool: a variant of a SETTLED anchor merges, not splinters', rs.new_items === 0 && store.get_by_anchor('sam:daughter:ct-procedure') === null);
  check('pool: it accrued on the settled row', (store.get_by_anchor('sam:daughter:ct-status')?.times_seen ?? 0) === 2);

  // ── dismissed stays dismissed ─────────────────────────────────────────────
  const wid = store.get_by_anchor('water bill: spike!')!.id;
  store.set_status(wid, 'dismissed');
  const r3 = await run_reflection(
    deps(mock_llm(envelope([{ anchor: 'water-bill:-spike!', summary: 'high again', rationale: '', evidence_refs: ['x'], disposition: 'watch' }]))),
    opts,
  );
  check('dismissed: re-observation SUPPRESSED', r3.suppressed === 1 && store.get_by_anchor('water bill: spike!')?.status === 'dismissed');

  // ── armed act: proposal filed once, capped ────────────────────────────────
  process.env.HEARTH_KATE_REFLECTION_ACT = '1';
  const acts = envelope([
    { anchor: 'ev:soc-sensor-down', summary: 'EV SoC sensor dark 14h', rationale: 'trip planning blind', evidence_refs: ['sensor'], disposition: 'act' },
    { anchor: 'act:two', summary: 'Second actionable thing', rationale: 'r', evidence_refs: ['y'], disposition: 'act' },
    { anchor: 'act:three', summary: 'Third actionable thing', rationale: 'r', evidence_refs: ['z'], disposition: 'act' },
  ]);
  const r4 = await run_reflection(deps(mock_llm(acts)), opts);
  check('armed: files proposals through the gate', r4.proposals_filed.length === 2);
  check('armed: per-pass cap of 2 (third downgraded to watch)', r4.downgraded === 1);
  check(
    'armed: ledger applied = proposal:<id>',
    store.get_by_anchor('ev:soc-sensor-down')?.applied_disposition.startsWith('proposal:') === true,
  );
  const r5 = await run_reflection(deps(mock_llm(acts)), opts);
  check(
    'armed: exists_for_signature dedup — re-run files only the capped leftover (queue drains at cap rate)',
    r5.proposals_filed.length === 1,
  );
  const r5b = await run_reflection(deps(mock_llm(acts)), opts);
  check('armed: third run files ZERO (all signatures exist)', r5b.proposals_filed.length === 0);

  // ── fail-CLOSED paths ─────────────────────────────────────────────────────
  const before = store.counts();
  const rf = await run_reflection(deps(mock_llm('sorry, I got confused')), opts);
  check('garbled envelope: parse_failed, nothing filed', rf.parse_failed === true && !rf.ran);
  const rl = await run_reflection(deps(mock_llm('', { throws: true })), opts);
  check('LLM down: nothing filed, no throw', !rl.ran && rl.proposals_filed.length === 0);
  const after = store.counts();
  check('fail-closed: ledger untouched by failed passes', JSON.stringify(before) === JSON.stringify(after));

  // ── empty envelope is a good outcome ──────────────────────────────────────
  const re = await run_reflection(deps(mock_llm(envelope([]))), opts);
  check('empty observations: clean ran, nothing written', re.ran && re.observations === 0);

  // ── expiry ────────────────────────────────────────────────────────────────
  const old = new Date(Date.now() - 30 * 86_400_000);
  store.upsert({ anchor: 'stale:thing', summary: 'old watch', rationale: '', evidence_refs: [], intended_disposition: 'watch', applied_disposition: 'watch', now: old });
  const expired = store.expire_stale(21);
  check('expire_stale: 30-day-old open watch → expired', expired >= 1 && store.get_by_anchor('stale:thing')?.status === 'expired');

  // ── watchlist render (brief feed) ─────────────────────────────────────────
  const wl = render_own_watchlist(db, 'jasper');
  check('render_own_watchlist: carries open watches', wl.includes('Garage open past midnight'));
  store.upsert({ anchor: 'sam:private-thing', summary: 'member-private watch', rationale: '', evidence_refs: [], intended_disposition: 'watch', applied_disposition: 'watch', private_to: 'sam' });
  check('render: cordon — jasper does not see sam-private', !render_own_watchlist(db, 'jasper').includes('member-private'));
  check('render: sam sees her own', render_own_watchlist(db, 'sam').includes('member-private'));
  delete process.env.HEARTH_KATE_REFLECTION;
  check('render: kill switch → empty string', render_own_watchlist(db, 'jasper') === '');

  // ── audit hook fired per attempted pass ───────────────────────────────────
  check('audit hook fired for every enabled pass', audits.length >= 6);

  // ── attention earns rope: the engagement throttle ─────────────────────────
  // The caps were constants, so ignored initiative cost the same budget next
  // pass as acted-on initiative — the loop could not get quieter when wrong or
  // bolder when right. That is the roster-gaps shape, and it is why arming
  // `act` stayed too expensive to try.
  {
    const tdir = mkdtempSync(join(tmpdir(), 'hearth-initiative-'));
    const tdb = open_db(join(tdir, 'h.db'));
    const tstore = new KateObservations(tdb);
    const tprops = new ProposalsStore(tdb);
    const file = (anchor: string, status: string | null): void => {
      let applied = 'watch';
      if (status !== null) {
        const pid = tprops.create({
          specialist_id: 'kate',
          kind: 'action_proposal',
          execution_kind: 'manual',
          payload: { description: anchor },
          rationale: 'initiative',
          signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'kate_reflection', anchor },
          user_id: null,
        });
        tdb.prepare(`UPDATE proposals SET status=@s WHERE id=@id`).run({ '@s': status, '@id': pid });
        applied = `proposal:${pid}`;
      }
      tstore.upsert({
        anchor,
        summary: `s-${anchor}`,
        rationale: '',
        evidence_refs: [],
        intended_disposition: 'act',
        applied_disposition: applied,
      });
    };

    const cold = score_initiative(tstore, tprops);
    check('throttle: no evidence → caps UNCHANGED, never widened',
      cold.rate === null && cold.caps.proposals === 2 && cold.caps.asks === 2 && cold.caps.observations === 8);

    // A watch nobody was shown is not evidence — she cannot inflate her own
    // budget by noticing more.
    for (let i = 0; i < 6; i++) file(`unshown:${i}`, null);
    check('throttle: unfiled watches are not scorable',
      score_initiative(tstore, tprops).scored === 0);

    // Pending is not consent either.
    file('pending:1', 'pending');
    check('throttle: an undecided proposal is not evidence',
      score_initiative(tstore, tprops).scored === 0);

    for (let i = 0; i < 4; i++) file(`good:${i}`, 'approved');
    const wide = score_initiative(tstore, tprops);
    check('throttle: a good record widens the caps one notch',
      wide.rate === 1 && wide.caps.proposals === 3 && wide.caps.asks === 3 && wide.caps.observations === 10);

    for (let i = 0; i < 12; i++) file(`bad:${i}`, 'denied');
    const tight = score_initiative(tstore, tprops);
    check('throttle: a dismissed record falls back to watch-only',
      tight.rate !== null && tight.rate <= 0.25 && tight.caps.proposals === 0 && tight.caps.asks === 1);
    check('throttle: shrinking never stops her NOTICING (the evidence keeps coming)',
      tight.caps.observations >= 4);
    check('throttle: the verdict explains itself', tight.note.includes('watch-only'));

    for (let i = 0; i < 8; i++) file(`recover:${i}`, 'approved');
    const mid = score_initiative(tstore, tprops);
    check('throttle: a recovering record lands back at the default, not the ceiling',
      mid.rate !== null && mid.rate > 0.25 && mid.rate < 0.6 && mid.caps.proposals === 2);

    tdb.close();
    rmSync(tdir, { recursive: true, force: true });
  }

  delete process.env.HEARTH_KATE_REFLECTION_ACT;
  db.close();
  rmSync(dir, { recursive: true, force: true });

  console.log('─'.repeat(50));
  if (fails) {
    console.log(`  ${fails}/${checks} FAILED`);
    process.exit(1);
  }
  console.log(`  ✓ smoke:kate-reflection PASSED (${checks} checks)`);
}

void main();
