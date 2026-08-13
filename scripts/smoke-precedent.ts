/**
 * smoke:precedent — Precedent memory / household case law (Kate self-direction
 * C3; src/core/precedent.ts + src/memory/stores/precedent_cases.ts) plus the
 * C6 fold-in on the proposal-filing critic.
 *
 * Self-contained: temp db + vault, a FAKE deterministic embedder (no GPU), a
 * scripted mock LLM for the critic judge (no live model). Exercises:
 *   - the kill switch (HEARTH_PRECEDENT off ⇒ indexer no-ops, recall empty,
 *     create() stamps nothing, court gather empty — byte-identical to today)
 *   - the indexer over all three sources (decided proposals / court-verdict
 *     audit rows / closed+verified misses), idempotency on re-run, and the
 *     outcome-confidence rendering (label honesty: a reason-less denial is
 *     WEAK; a verified miss is STRONG; a court decide is MODERATE)
 *   - per-source degradation: no embedder ⇒ text-only rows + token-overlap
 *     recall still works; fake embedder ⇒ vectors land + vector recall ranks;
 *     a THROWING embedder degrades recall to text (fail-open)
 *   - the cordon matrix on recall (owner sees system + own, never a member's;
 *     the member sees their own; system scope fails closed to NULL-only)
 *   - recall dedup (a proposal case + its court_verdict sibling never fill
 *     two slots)
 *   - the create() precedent stamp (precedent_json set, payload untouched)
 *   - the court lens-pack gather (block rendered when lit, empty map dark)
 *   - the critic C6 fold-in: decided-history candidates, the
 *     refile_of_denied verdict mapping, should_retire_refile's strong-label
 *     gate, and the deterministic temporal_sanity matrix
 *
 *   bun run smoke:precedent
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ProposalsStore, type ProposalRow } from '@core/proposals';
import { PrecedentStore } from '@memory/stores/precedent_cases';
import {
  run_precedent_index,
  recall_precedent_cases,
  match_precedent_text,
  gather_docket_precedent,
  render_precedent_block,
  precedent_enabled,
} from '@core/precedent';
import {
  assess_proposal,
  decided_candidates,
  should_retire_refile,
  temporal_sanity,
} from '@core/proposal_critic';
import type { Embedder } from '@core/embeddings';
import type { LLMRouter } from '@core/llm';
import { ulid } from 'ulid';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

/** Deterministic bag-of-words embedder — same text ⇒ same vector; shared
 *  tokens ⇒ high cosine. No network, no GPU. */
class FakeEmbedder implements Embedder {
  readonly enabled = true;
  readonly model = 'fake-bow-32';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(32).fill(0);
      for (const m of t.toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}/g)) {
        let h = 0;
        for (const ch of m[0]) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % 32] = (v[h % 32] ?? 0) + 1;
      }
      return v;
    });
  }
  async rerank(): Promise<number[] | null> {
    return null;
  }
}

class ThrowingEmbedder implements Embedder {
  readonly enabled = true;
  readonly model = 'thrower';
  async embed(): Promise<number[][]> {
    throw new Error('embeddings down');
  }
  async rerank(): Promise<number[] | null> {
    return null;
  }
}

async function main(): Promise<void> {
  delete process.env.HEARTH_PRECEDENT;
  delete process.env.HEARTH_PROPOSAL_CRITIC;
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-precedent-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'h.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);
  const store = new PrecedentStore(db);

  const mk = (over: {
    specialist_id?: string;
    kind?: 'action_proposal' | 'trusted_source_addition' | 'calendar_event' | 'briefing';
    rationale: string;
    payload?: unknown;
    user_id?: string | null;
    anchor: string;
  }): string =>
    proposals.create({
      specialist_id: over.specialist_id ?? 'kate',
      kind: over.kind ?? 'action_proposal',
      execution_kind: 'none',
      payload: over.payload ?? { description: over.rationale.slice(0, 80) },
      rationale: over.rationale,
      signature: {
        specialist_id: over.specialist_id ?? 'kate',
        kind: over.kind ?? 'action_proposal',
        category: 'smoke',
        anchor: over.anchor,
      },
      user_id: over.user_id ?? null,
    });

  // ── A. kill switch — dark ⇒ byte-identical to today ─────────────────────
  console.log('A. kill switch (HEARTH_PRECEDENT off)');
  check('flag reads off', !precedent_enabled());
  const dark_run = await run_precedent_index({ db, store });
  check('indexer no-ops dark', dark_run.enabled === false && dark_run.scanned === 0);
  check('store empty after dark run', store.counts().total === 0);
  check('sync text match returns [] dark', match_precedent_text(db, 'anything at all', { proposal_user_id: null, k: 3 }).length === 0);
  const dark_recall = await recall_precedent_cases({
    store, situation: 'anything', scope: { kind: 'system' }, k: 3,
  });
  check('recall returns [] dark', dark_recall.length === 0);
  const p_dark = mk({ rationale: 'Order fancy chocolate for the neighbor', anchor: 'dark-1' });
  check('create() stamps nothing dark', proposals.get(p_dark)?.precedent_json == null);

  // ── B. seed the decided history + index it ──────────────────────────────
  console.log('B. index the decided history');
  process.env.HEARTH_PRECEDENT = '1';

  const p_gift = mk({ rationale: 'Order a birthday gift for Heather before her visit — flowers and a card from the shop she likes', anchor: 'gift-1' });
  proposals.decide(p_gift, 'approve', undefined, undefined, 'approve');
  const p_deny_reason = mk({ rationale: 'Subscribe to the premium weather alerts service for storm warnings', anchor: 'weather-sub' });
  proposals.decide(p_deny_reason, 'deny', undefined, 'we already get the same alerts free via NWS', 'reject');
  const p_deny_bare = mk({ rationale: 'Buy a second robot vacuum for the upstairs bedrooms', anchor: 'vac-2' });
  proposals.decide(p_deny_bare, 'deny');
  const p_lapsed = mk({ rationale: 'Return-window reminder for the espresso machine purchase', anchor: 'esp-1' });
  proposals.expire_one(p_lapsed, 'window passed');
  const p_court = mk({
    kind: 'trusted_source_addition',
    specialist_id: 'cordelia',
    rationale: 'Add roastmagazine.org as a tier-2 coffee industry source for the culinary rack',
    payload: { target_specialist_id: 'brigid', domain: 'roastmagazine.org', tier: 2 },
    anchor: 'roast-1',
  });
  proposals.decide(p_court, 'approve', undefined, 'proposal court consensus: mariah=approve, trainer=approve, kate=approve', 'approve');
  const p_sara = mk({ rationale: 'Book Sam her hair appointment with Rosa at the salon', user_id: 'sam', anchor: 'hair-1' });
  proposals.decide(p_sara, 'approve', undefined, undefined, 'approve');

  // Court-verdict audit rows: one for a still-pending SPLIT case, one the
  // sibling of the court-decided proposal above (recall must dedupe it).
  const p_split = mk({
    kind: 'trusted_source_addition',
    specialist_id: 'cordelia',
    rationale: 'Add beanscenemag.com.au as a coffee trade source — paywalled and rarely relevant',
    payload: { target_specialist_id: 'brigid', domain: 'beanscenemag.com.au', tier: 2 },
    anchor: 'bean-1',
  });
  memory.log_action({
    intent_id: ulid(), agent: 'kate', tool_name: 'proposal_court_verdict',
    tool_input: { proposal_id: p_split, kind: 'trusted_source_addition' },
    execution_result: { outcome: 'split', votes: ['mariah=approve', 'trainer=reject', 'kate=abstain'] },
  });
  memory.log_action({
    intent_id: ulid(), agent: 'kate', tool_name: 'proposal_court_verdict',
    tool_input: { proposal_id: p_court, kind: 'trusted_source_addition' },
    execution_result: { outcome: 'approved', votes: ['mariah=approve', 'trainer=approve', 'kate=approve'] },
  });
  // A no-position verdict must NOT index.
  memory.log_action({
    intent_id: ulid(), agent: 'kate', tool_name: 'proposal_court_verdict',
    tool_input: { proposal_id: p_split, kind: 'trusted_source_addition' },
    execution_result: { outcome: 'owner_class', votes: [] },
  });

  // Closed + verified process misses (system-side → NULL cordon).
  const miss_ins = db.prepare(
    `INSERT INTO process_misses (id, ts_created, ts_updated, subject_specialist_id, reporter,
       task_summary, gap, severity, status, routed_to, evidence_ref, notes_md)
     VALUES (@id, @ts, @ts, @subject, 'mariah', @task, @gap, 'medium', @status, NULL, @ref, @notes)`,
  );
  const now_iso = new Date().toISOString();
  miss_ins.run({
    '@id': 'pm_smokeclosed01', '@ts': now_iso, '@subject': 'eleanor',
    '@task': 'Garden irrigation schedule fabricated after a sensor read failure',
    '@gap': 'answered over a failed read instead of admitting the gap',
    '@status': 'closed', '@ref': 'smoke:irrigation',
    '@notes': '[open→routed] routed to trainer\n[routed→closed] recovery hint shipped on the sensor tool',
  });
  miss_ins.run({
    '@id': 'pm_smokeverif01', '@ts': now_iso, '@subject': 'vivian',
    '@task': 'Receipt totals drifting from extracted line items',
    '@gap': 'extractor rounded per-line instead of on the total',
    '@status': 'verified', '@ref': 'smoke:receipts',
    '@notes': '[closed→verified] verify_fix_landed re-ran the scan — evidence_ref no longer appears',
  });

  const run1 = await run_precedent_index({ db, store });
  check('indexer enabled', run1.enabled === true);
  // 7 decided proposals (gift, deny_reason, deny_bare, lapsed, court, sam, dark-1 is still pending → NOT counted)
  // + 2 verdict rows (split + approved; owner_class skipped) + 2 misses.
  check(`scanned all sources (got ${run1.scanned})`, run1.scanned === 10);
  check('all new on first run', run1.indexed_new === 10 && run1.updated === 0);
  check('no embedder ⇒ nothing embedded', run1.embedded === 0 && run1.embed_pending === 10);
  check('no source errors', run1.source_errors.length === 0);

  const by_source = (sid: string) =>
    db.prepare(`SELECT * FROM precedent_cases WHERE source_id = @s`).get({ '@s': sid }) as
      | { outcome: string; confidence: string; confidence_note: string; case_md: string; user_id: string | null }
      | null;
  const c_gift = by_source(p_gift);
  check('owner approve ⇒ strong', c_gift?.outcome === 'approved' && c_gift.confidence === 'strong');
  const c_bare = by_source(p_deny_bare);
  check('reason-less denial ⇒ weak + honest note', c_bare?.confidence === 'weak' && c_bare.confidence_note.includes('no reason recorded'));
  const c_reason = by_source(p_deny_reason);
  check('reasoned owner denial ⇒ strong', c_reason?.outcome === 'denied' && c_reason.confidence === 'strong');
  const c_lapsed = by_source(p_lapsed);
  check('expired ⇒ lapsed + weak', c_lapsed?.outcome === 'lapsed' && c_lapsed.confidence === 'weak');
  const c_court = by_source(p_court);
  check('court decide ⇒ moderate', c_court?.confidence === 'moderate' && c_court.confidence_note.includes('court'));
  const c_verified = by_source('pm_smokeverif01');
  check('verified miss ⇒ strong', c_verified?.outcome === 'resolved (verified)' && c_verified.confidence === 'strong');
  const c_sara = by_source(p_sara);
  check('cordon inherited from the proposal', c_sara?.user_id === 'sam');

  // ── C. idempotency ───────────────────────────────────────────────────────
  console.log('C. idempotency');
  const run2 = await run_precedent_index({ db, store });
  check('re-run indexes nothing new', run2.indexed_new === 0 && run2.updated === 0 && run2.scanned === 10);
  // A source that CHANGED re-renders (decide the split proposal now).
  proposals.decide(p_split, 'deny', undefined, 'paywalled, low fit', 'reject');
  const run3 = await run_precedent_index({ db, store });
  check('a newly-decided proposal indexes as new', run3.indexed_new === 1);

  // ── D. text recall + dedup (no embedder) ────────────────────────────────
  console.log('D. text recall + dedup');
  const owner_scope = { kind: 'viewer', user_id: 'jasper', tier: 'owner' } as const;
  const r_gift = await recall_precedent_cases({
    store, situation: 'order a birthday gift of flowers before a visit', scope: owner_scope, k: 3,
  });
  check('text recall finds the gift case first', r_gift[0]?.outcome === 'approved' && r_gift[0]?.match_kind === 'text');
  const r_roast = await recall_precedent_cases({
    store, situation: 'add roastmagazine.org coffee industry source to the culinary rack', scope: owner_scope, k: 5,
  });
  const roast_hits = r_roast.filter((m) => m.proposal_id === p_court);
  check('proposal + court_verdict siblings dedupe to one slot', roast_hits.length === 1);

  // ── E. cordon matrix ─────────────────────────────────────────────────────
  console.log('E. cordon matrix');
  const sara_situation = 'book a hair appointment with Rosa at the salon';
  const r_owner = await recall_precedent_cases({ store, situation: sara_situation, scope: owner_scope, k: 5 });
  check('owner never sees the member-cordoned case', !r_owner.some((m) => m.proposal_id === p_sara));
  const r_sara = await recall_precedent_cases({
    store, situation: sara_situation, scope: { kind: 'viewer', user_id: 'sam', tier: 'household' }, k: 5,
  });
  check('the member sees their own case', r_sara.some((m) => m.proposal_id === p_sara));
  check('member sees ONLY their own (no system cases)', r_sara.every((m) => m.proposal_id === p_sara));
  const r_system = await recall_precedent_cases({
    store, situation: sara_situation, scope: { kind: 'system' }, k: 5,
  });
  check('system scope fails closed to NULL-only', !r_system.some((m) => m.proposal_id === p_sara));

  // ── F. embedding path + degradation ─────────────────────────────────────
  console.log('F. embeddings + degradation');
  const fake = new FakeEmbedder();
  const run4 = await run_precedent_index({ db, store, embedder: fake });
  check('back-fill embeds every pending case', run4.embedded >= 11 && run4.embed_pending === 0);
  const r_vec = await recall_precedent_cases({
    store, embedder: fake,
    situation: 'order a birthday gift for Heather before her visit flowers card shop',
    scope: owner_scope, k: 3,
  });
  check('vector recall ranks the gift case first', r_vec[0]?.proposal_id === p_gift && r_vec[0]?.match_kind === 'vector');
  const r_throw = await recall_precedent_cases({
    store, embedder: new ThrowingEmbedder(),
    situation: 'order a birthday gift of flowers before a visit', scope: owner_scope, k: 3,
  });
  check('throwing embedder degrades to text recall', r_throw.length > 0 && r_throw[0]?.match_kind === 'text');

  // ── G. the create() stamp ────────────────────────────────────────────────
  console.log('G. create() precedent stamp');
  const p_new = mk({ rationale: 'Order a birthday gift for the upcoming visit — flowers from the same shop', anchor: 'gift-2' });
  const row_new = proposals.get(p_new);
  check('precedent_json stamped on file', typeof row_new?.precedent_json === 'string');
  const stamped = JSON.parse(row_new?.precedent_json ?? '{}') as { matches?: Array<{ outcome: string; note: string }> };
  check('stamp carries matches with outcomes + notes', Array.isArray(stamped.matches) && stamped.matches.length >= 1 && typeof stamped.matches[0]?.outcome === 'string');
  check('payload untouched by the stamp', !(row_new?.payload_json ?? '').includes('precedent'));
  const p_sara2 = mk({ rationale: 'Book Sam another hair appointment with Rosa at the salon', user_id: 'sam', anchor: 'hair-2' });
  const stamped_sara = JSON.parse(proposals.get(p_sara2)?.precedent_json ?? '{}') as {
    matches?: Array<{ source_id: string }>;
  };
  check("a member's filing may cite the member's own case", (stamped_sara.matches ?? []).some((m) => m.source_id === p_sara));
  const p_jasper2 = mk({ rationale: 'Book a hair appointment with Rosa at the salon', user_id: 'jasper', anchor: 'hair-3' });
  const stamped_jasper = JSON.parse(proposals.get(p_jasper2)?.precedent_json ?? 'null') as {
    matches?: Array<{ source_id: string }>;
  } | null;
  check("another user's filing never cites the member's case", !(stamped_jasper?.matches ?? []).some((m) => m.source_id === p_sara));

  // ── H. court lens-pack gather ────────────────────────────────────────────
  console.log('H. court gather');
  const docket_row = proposals.get(p_new);
  if (!docket_row) throw new Error('docket row missing');
  const blocks = await gather_docket_precedent({ store, embedder: fake, docket: [docket_row] });
  const block = blocks.get(p_new);
  check('gather renders a block for the docket case', typeof block === 'string' && block.includes('precedent (household case law'));
  check('block carries the outcome tally', (block ?? '').includes('approved'));
  check('render_precedent_block empty on no matches', render_precedent_block([]) === '');
  delete process.env.HEARTH_PRECEDENT;
  const dark_blocks = await gather_docket_precedent({ store, embedder: fake, docket: [docket_row] });
  check('gather dark ⇒ empty map', dark_blocks.size === 0);
  process.env.HEARTH_PRECEDENT = '1';

  // ── I. critic C6 fold-in ─────────────────────────────────────────────────
  console.log('I. critic C6 — decided-history dedup + temporal sanity');
  process.env.HEARTH_PROPOSAL_CRITIC = '1';
  const denied_row = proposals.get(p_deny_reason);
  const bare_row = proposals.get(p_deny_bare);
  const lapsed_row = proposals.get(p_lapsed);
  if (!denied_row || !bare_row || !lapsed_row) throw new Error('seed rows missing');

  const p_refile = mk({ rationale: 'Subscribe to the premium weather alerts service for storm warnings again', anchor: 'weather-sub-2' });
  const refile_row = proposals.get(p_refile);
  if (!refile_row) throw new Error('refile row missing');
  const dc = decided_candidates(refile_row, [denied_row, lapsed_row]);
  check('decided_candidates surfaces the similar denial', dc.some((r) => r.id === p_deny_reason));
  check('decided_candidates skips the unrelated lapse', !dc.some((r) => r.id === p_lapsed));

  let responder: () => string = () => '{"verdict":"keep","duplicate_index":null,"decided_index":null,"reason":"x"}';
  const mock_llm = {
    for_role: () => ({
      provider: { complete: async () => ({ content: responder() }) },
      defaults: {},
    }),
  } as unknown as LLMRouter;

  responder = () => '{"verdict":"refile_of_denied","duplicate_index":null,"decided_index":1,"reason":"same ask, denied last month"}';
  const v_refile = await assess_proposal({ proposal: refile_row, open: [], decided: [denied_row], llm: mock_llm });
  check('refile verdict maps back to OUR decided id', v_refile.action === 'refile_of_denied' && v_refile.duplicate_of === p_deny_reason);
  responder = () => '{"verdict":"refile_of_denied","duplicate_index":null,"decided_index":9,"reason":"bad index"}';
  const v_bad = await assess_proposal({ proposal: refile_row, open: [], decided: [denied_row], llm: mock_llm });
  check('out-of-range decided_index fails open to keep', v_bad.action === 'keep');

  const now = new Date();
  check('strong label (recent reasoned denial) retires', should_retire_refile(denied_row, now) === true);
  check('reason-less denial never auto-retires', should_retire_refile(bare_row, now) === false);
  check('a lapse never auto-retires', should_retire_refile(lapsed_row, now) === false);
  db.prepare(`UPDATE proposals SET ts_decided = @ts WHERE id = @id`).run({
    '@ts': new Date(now.getTime() - 60 * 86_400_000).toISOString(),
    '@id': p_deny_reason,
  });
  const stale_denied = proposals.get(p_deny_reason);
  check('an old denial ages out of the retire window', stale_denied != null && should_retire_refile(stale_denied, now) === false);

  const past = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const future = new Date(now.getTime() + 3 * 86_400_000).toISOString();
  const t1 = temporal_sanity({ kind: 'calendar_event', payload_json: JSON.stringify({ ts_start: past, ts_end: past }) }, now);
  check('calendar event already ended ⇒ stale', t1.stale === true);
  const t2 = temporal_sanity({ kind: 'calendar_event', payload_json: JSON.stringify({ ts_start: future, ts_end: future }) }, now);
  check('future calendar event ⇒ not stale', t2.stale === false);
  const t3 = temporal_sanity({ kind: 'briefing', payload_json: JSON.stringify({ for_event: past, topic: 'prep' }) }, now);
  check('briefing for a past event ⇒ stale', t3.stale === true);
  const t4 = temporal_sanity({ kind: 'action_proposal', payload_json: JSON.stringify({ description: 'receipt', purchased_at: past }) }, now);
  check('a past date in an untyped payload is NOT stale (no generic scan)', t4.stale === false);
  const t5 = temporal_sanity({ kind: 'calendar_event', payload_json: 'not json' }, now);
  check('unparseable payload ⇒ not stale (fail-open)', t5.stale === false);

  delete process.env.HEARTH_PRECEDENT;
  delete process.env.HEARTH_PROPOSAL_CRITIC;
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsmoke:precedent — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
