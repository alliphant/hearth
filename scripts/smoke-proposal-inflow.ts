export {};
/**
 * smoke:proposal-inflow — the proposal-queue inflow guards.
 *
 * Self-contained: temp SQLite, ProposalsStore only. Exercises the
 * 2026-06-10 noise-audit mechanisms:
 *   - re-fire collapse on stable content: same signature + same rationale
 *     but a volatile payload (briefing body_md) collapses to one row; the
 *     pre-fix byte-payload check missed exactly this (the "Kate pending
 *     interrupts escalation" twins)
 *   - briefing dedup_key: a re-prepared briefing on the same topic
 *     supersedes the stale unread offer
 *   - safety: distinct subjects stay independent (two drafts to the same
 *     recipient; two scouted source domains — the live scout pair that a
 *     fuzzy matcher would have wrongly eaten)
 *   - FYI TTL: a pending card whose action set offers no decision expires
 *     after the TTL; decision cards and snoozed rows never do
 *   - terminal rows don't block a deliberate re-file
 *   - root-cause supersession on pm_* miss refs: a systemic re-filing whose
 *     validated refs cover an open row's refs supersedes it (cross-kind,
 *     slug drift irrelevant); narrow fixes and fabricated ids never do
 *   - attribution canonicalization (2026-06-10): with the registry resolver
 *     wired, a display-name/alias filer normalizes to the registered id
 *     ('Beatrice' → 'trainer'), an unresolvable filer throws
 *     UnknownSpecialistError, a garbage SIGNATURE owner falls back to the
 *     filer, and propose_action attributes to ctx.specialist_id over the
 *     LLM-authored signature value (the live 'beatrice'/'maggia'/'all' rows)
 *
 *   bun run smoke:proposal-inflow
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { ProcessMissStore } from '@core/process_misses';
import {
  ProposalsStore,
  UnknownSpecialistError,
  hash_signature,
  type CategorySignature,
} from '@core/proposals';
import { SpecialistRegistry } from '@core/specialist';
import { load_extra_capabilities } from '@core/capabilities';
import { make_propose_action } from '../src/specialists/kate/tools/propose_action';
import type { ToolContext } from '@core/tool';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(resolve(tmpdir(), 'hearth-inflow-'));
const db = open_db(resolve(dir, 'hearth.db'));

function briefing_sig(topic: string): CategorySignature {
  return {
    specialist_id: 'kate',
    kind: 'briefing',
    category: 'briefing',
    anchor: topic.slice(0, 40),
  };
}

function backdate(id: string, hours: number): void {
  const ts = new Date(Date.now() - hours * 3_600_000).toISOString();
  db.prepare(`UPDATE proposals SET ts_created = @ts WHERE id = @id`).run({
    '@ts': ts,
    '@id': id,
  });
}

try {
  const proposals = new ProposalsStore(db);

  // ── re-fire collapse: volatile payload, identical stated content ────────
  const topic_a = 'Kate pending interrupts escalation 2026-06-10 16:30';
  const refire = (body_md: string): string =>
    proposals.create({
      specialist_id: 'kate',
      kind: 'briefing',
      execution_kind: 'none',
      payload: { topic: topic_a, depth: 'quick', body_md, consulted: [] },
      rationale: `Briefing on "${topic_a}" at quick depth.`,
      signature: briefing_sig(topic_a),
    });
  const first = refire('Synthesized body, take one.');
  const second = refire('Synthesized body, take TWO — the LLM never repeats itself.');
  check('a re-fire with a volatile payload collapses to the existing row', first === second);
  const open_briefings = db
    .prepare(`SELECT COUNT(*) n FROM proposals WHERE kind = 'briefing' AND status = 'pending'`)
    .get() as { n: number };
  check('only one briefing row exists after the re-fire', open_briefings.n === 1);

  // ── regression: a malformed envelope reaches create() with no rationale ──
  // The live 2026-06-22 crash: a trainer deliberation envelope omitted a
  // proposal's `rationale_md`, so the deliberation loop called create() with
  // `rationale: undefined`, which crashed norm_refire_text on the re-fire-
  // collapse path (`undefined is not an object (evaluating 'text.toLowerCase')`)
  // and silently lost the proposal. create() must defend its own contract:
  // coerce the rationale, file the row, never throw. `undefined as unknown as
  // string` reproduces exactly what the typed-but-unvalidated envelope hands it.
  const malformed_topic = 'no-rationale regression 2026-06-22';
  let rationale_less_id = '';
  let create_threw = false;
  try {
    rationale_less_id = proposals.create({
      specialist_id: 'kate',
      kind: 'briefing',
      execution_kind: 'none',
      payload: { topic: malformed_topic, depth: 'quick', body_md: 'x', consulted: [] },
      rationale: undefined as unknown as string,
      signature: briefing_sig(malformed_topic),
    });
  } catch {
    create_threw = true;
  }
  check(
    'create() does not crash on an undefined rationale (the live norm_refire_text TypeError)',
    !create_threw && rationale_less_id.length > 0,
  );
  check(
    'the rationale-less proposal still files, with rationale coerced to empty',
    proposals.get(rationale_less_id)?.rationale_md === '',
  );

  // ── briefing supersession: same topic, genuinely re-prepared ────────────
  const reprep = proposals.create({
    specialist_id: 'kate',
    kind: 'briefing',
    execution_kind: 'none',
    payload: { topic: topic_a, depth: 'thorough', body_md: 'Deeper pass.', consulted: ['mariah'] },
    rationale: `Briefing on "${topic_a}" at thorough depth.`,
    signature: briefing_sig(topic_a),
  });
  check('a re-prepared briefing on the same topic is a NEW row', reprep !== first);
  const old_row = proposals.get(first);
  check(
    'the stale offer is superseded by the re-prep',
    old_row?.status === 'superseded' && old_row?.superseded_by === reprep,
  );

  // ── safety: distinct subjects stay independent ──────────────────────────
  const draft = (text: string): string =>
    proposals.create({
      specialist_id: 'kate',
      kind: 'draft_message',
      execution_kind: 'manual',
      payload: { recipient: 'Sam', body: text },
      rationale: `Draft to Sam: ${text}`,
      signature: { specialist_id: 'kate', kind: 'draft_message', category: 'social', anchor: 'sam' },
    });
  const d1 = draft('Dinner Friday?');
  const d2 = draft('Ski day Sunday?');
  check(
    'two different drafts to the same recipient both live',
    d1 !== d2 &&
      proposals.get(d1)?.status === 'pending' &&
      proposals.get(d2)?.status === 'pending',
  );

  const scout = (domain: string): string =>
    proposals.create({
      specialist_id: 'cordelia',
      kind: 'trusted_source_addition',
      execution_kind: 'manual',
      payload: { target_specialist_id: 'kristi', domain, suggested_tier: 1 },
      rationale: `Source scout for Kristi rates ${domain} worth adding.`,
      signature: { specialist_id: 'cordelia', kind: 'trusted_source_addition', category: 'sources', anchor: domain },
    });
  const s1 = scout('spec.org');
  const s2 = scout('ul.com');
  check(
    'two scouted domains from one run both live (the live scout pair)',
    s1 !== s2 &&
      proposals.get(s1)?.status === 'pending' &&
      proposals.get(s2)?.status === 'pending',
  );

  // ── FYI TTL: no-decision cards expire; decisions and snoozes never ──────
  const topic_b = 'Morning brief - June 10';
  const stale_fyi = proposals.create({
    specialist_id: 'kate',
    kind: 'briefing',
    execution_kind: 'none',
    payload: { topic: topic_b, depth: 'quick', body_md: 'Old news.', consulted: [] },
    rationale: `Briefing on "${topic_b}" at quick depth.`,
    signature: briefing_sig(topic_b),
  });
  // A genuine decision card (recommendation = apply/defer/reject actions).
  // Filed by a DOMAIN specialist so the Kate pre-review gate (trainer-only)
  // doesn't apply — this case tests FYI-vs-decision, not the gate, so the row
  // must be a plain owner-visible `pending`.
  const stale_decision = proposals.create({
    specialist_id: 'vivian',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { tool_name: 'read_note', summary: 'Add candidates on 404.' },
    rationale: 'read_note should return candidates on a missing path.',
    signature: { specialist_id: 'vivian', kind: 'recommendation', category: 'connector', anchor: 'read_note' },
  });
  const snoozed_fyi = proposals.create({
    specialist_id: 'kate',
    kind: 'briefing',
    execution_kind: 'none',
    payload: { topic: 'Garden week ahead', depth: 'quick', body_md: 'Frost risk.', consulted: [] },
    rationale: 'Briefing on "Garden week ahead" at quick depth.',
    signature: briefing_sig('Garden week ahead'),
  });
  db.prepare(`UPDATE proposals SET snoozed_until = @su WHERE id = @id`).run({
    '@su': new Date(Date.now() + 3_600_000).toISOString(),
    '@id': snoozed_fyi,
  });
  for (const id of [stale_fyi, stale_decision, snoozed_fyi]) backdate(id, 72);
  // The superseded/live rows from earlier sections are recent — untouched.

  const expired = proposals.expire_stale_fyi(48);
  check('the stale FYI briefing expires', expired.includes(stale_fyi));
  check(
    'expiry is reflected on the row',
    proposals.get(stale_fyi)?.status === 'expired',
  );
  check(
    'a stale DECISION card never expires',
    !expired.includes(stale_decision) && proposals.get(stale_decision)?.status === 'pending',
  );
  check(
    'a snoozed FYI is exempt (explicit defer wins)',
    !expired.includes(snoozed_fyi),
  );
  check(
    'fresh rows are untouched by the sweep',
    proposals.get(reprep)?.status === 'pending' && proposals.get(d1)?.status === 'pending',
  );

  // ── snooze WAKES when its window passes ─────────────────────────────────
  // `snoozed_until` used to be write-only: every reader tested `IS NULL` to
  // EXCLUDE a deferred card and nothing ever compared it to the clock, so
  // "Decide later" was a one-way door — no wake, no TTL (exempt above), and
  // invisible to the Court, which lists `pending`. Two live rows had been
  // deferred since 2026-05-26 and 2026-06-23 against a documented
  // "snooze 24h, reappears tomorrow".
  proposals.snooze(snoozed_fyi, new Date(Date.now() + 3_600_000).toISOString());
  check(
    'a snooze whose window has NOT passed stays deferred',
    proposals.wake_snoozed().length === 0 &&
      proposals.get(snoozed_fyi)?.status === 'snoozed',
  );
  db.prepare(`UPDATE proposals SET snoozed_until = @su WHERE id = @id`).run({
    '@su': new Date(Date.now() - 60_000).toISOString(),
    '@id': snoozed_fyi,
  });
  const woken = proposals.wake_snoozed();
  check('a snooze past its window wakes', woken.includes(snoozed_fyi));
  const woke_row = proposals.get(snoozed_fyi);
  check(
    'the woken row returns to plain pending with the window cleared',
    woke_row?.status === 'pending' && woke_row?.snoozed_until === null,
  );
  check('waking is idempotent — a second sweep finds nothing', proposals.wake_snoozed().length === 0);

  // ── terminal rows don't block a deliberate re-file ──────────────────────
  proposals.decide(d1, 'deny');
  const d1_again = draft('Dinner Friday?');
  check(
    'a denied proposal does not block an identical re-file',
    d1_again !== d1 && proposals.get(d1_again)?.status === 'pending',
  );

  // ── root-cause supersession on pm_* miss refs ────────────────────────────
  const misses = new ProcessMissStore(db);
  const mk_miss = (n: number): string =>
    misses.create({
      subject_specialist_id: 'kate',
      reporter: 'mariah',
      task_summary: `task ${n}`,
      gap: `tool-round ceiling exhaust ${n}`,
      severity: 'medium',
      evidence_ref: `smoke-inflow:${n}`,
    });
  const m1 = mk_miss(1);
  const m2 = mk_miss(2);
  const m3 = mk_miss(3);

  const systemic = (
    slug: string,
    refs: string[],
    kind: 'binding_proposal' | 'recommendation' = 'binding_proposal',
  ): string =>
    proposals.create({
      specialist_id: 'trainer',
      kind,
      execution_kind: 'manual',
      payload: {
        slug,
        rel_path: `Knowledge/Trainer/binding-proposals/${slug}.md`,
        summary: `Fix for ${slug}`,
        closes_miss_ids: refs,
      },
      rationale: `Systemic fix ${slug} closing ${refs.length} miss(es).`,
      signature: {
        specialist_id: 'trainer',
        kind: 'binding_proposal',
        category: 'structural',
        anchor: slug,
      },
    });

  // The live failure shape: same fix, drifted slug — dedup_key misses it,
  // the shared pm_* refs catch it.
  const b1 = systemic('research-efficiency-injection', [m1, m2]);
  const b2 = systemic('runtime-research-efficiency-injection', [m1, m2, m3]);
  const b1_row = proposals.get(b1);
  check(
    'a slug-drifted refiling citing the same misses supersedes',
    b2 !== b1 && b1_row?.status === 'superseded' && b1_row?.superseded_by === b2,
  );

  // Cross-kind: a recommendation restating the same miss cluster.
  const r1 = systemic('same-cause-restated', [m1, m2, m3], 'recommendation');
  check(
    'a cross-kind restatement of the same cluster supersedes',
    proposals.get(b2)?.status === 'superseded' &&
      proposals.get(b2)?.superseded_by === r1,
  );

  // Unstructured citation: refs in the rationale prose, no payload field.
  const prose = proposals.create({
    specialist_id: 'trainer',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { summary: 'Same cluster, restated in prose.' },
    rationale: `One root cause spans ${m1}, ${m2} and ${m3}: sequential tool calls.`,
    signature: {
      specialist_id: 'trainer',
      kind: 'recommendation',
      category: 'systemic',
      anchor: 'ceiling-cluster',
    },
  });
  check(
    'prose-cited refs supersede too (no structured field needed)',
    proposals.get(r1)?.status === 'superseded' &&
      proposals.get(r1)?.superseded_by === prose,
  );

  // A narrow fix citing one miss of a broad cluster must NOT displace it.
  // (These are trainer system-kind specs, so they're born `pending_kate_review`
  // — awaiting Kate's gate — which is still "open" for supersession purposes.)
  const narrow = systemic('narrow-fix', [m1]);
  check(
    'a narrow fix never displaces the broad cluster proposal',
    proposals.get(prose)?.status === 'pending_kate_review' &&
      proposals.get(narrow)?.status === 'pending_kate_review',
  );

  // Fabricated refs (right shape, not in the ledger) trigger nothing.
  const fabricated = systemic('fabricated-refs', ['pm_999999999999']);
  check(
    'fabricated refs can never trigger supersession',
    proposals.get(prose)?.status === 'pending_kate_review' &&
      proposals.get(narrow)?.status === 'pending_kate_review' &&
      proposals.get(fabricated)?.status === 'pending_kate_review',
  );

  // ── attribution canonicalization ─────────────────────────────────────────
  // The real roster: asserts trainer.yaml's display name / aliases actually
  // resolve, which is the mapping the live incident depended on. Post-freeze
  // capability tokens load from the YAML first (as orchestrator boot does)
  // or the real specialist configs fail validation.
  load_extra_capabilities(resolve(import.meta.dir, '..', 'config', 'capabilities.yaml'));
  const registry = new SpecialistRegistry(
    resolve(import.meta.dir, '..', 'config', 'specialists'),
  );
  check(
    "resolve_id: registered id passes through ('kate')",
    registry.resolve_id('kate') === 'kate',
  );
  check(
    "resolve_id: display name resolves ('Beatrice' → 'trainer')",
    registry.resolve_id('Beatrice') === 'trainer' &&
      registry.resolve_id('beatrice') === 'trainer',
  );
  check(
    "resolve_id: alias resolves ('bea' → 'trainer')",
    registry.resolve_id('bea') === 'trainer',
  );
  check(
    "resolve_id: typo and non-id return null ('maggia', 'all')",
    registry.resolve_id('maggia') === null && registry.resolve_id('all') === null,
  );

  // Everything above this point ran WITHOUT a resolver — that IS the
  // fail-open check (self-contained stores accept ids as-is). Wire it now.
  proposals.set_specialist_resolver((cand) => registry.resolve_id(cand));

  const attribution_sig = (owner: string): CategorySignature => ({
    specialist_id: owner,
    kind: 'recommendation',
    category: 'runtime-efficiency',
    anchor: 'attribution-smoke',
  });
  const display_name_row = proposals.create({
    specialist_id: 'Beatrice',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { summary: 'Filed under a display name.' },
    rationale: 'Display-name filer must land under the registered id.',
    signature: attribution_sig('beatrice'),
  });
  const dn_row = proposals.get(display_name_row);
  check(
    "a display-name filer lands under the registered id ('Beatrice' → 'trainer')",
    dn_row?.specialist_id === 'trainer',
  );
  check(
    'the signature owner is canonicalized too (hash matches the trainer sig)',
    dn_row?.category_signature_hash === hash_signature(attribution_sig('trainer')),
  );

  let threw: unknown = null;
  try {
    proposals.create({
      specialist_id: 'maggia',
      kind: 'recommendation',
      execution_kind: 'manual',
      payload: { summary: 'Typo filer.' },
      rationale: 'An unresolvable filer must throw, not land.',
      signature: attribution_sig('maggia'),
    });
  } catch (err) {
    threw = err;
  }
  check(
    "an unresolvable filer throws UnknownSpecialistError ('maggia')",
    threw instanceof UnknownSpecialistError && threw.candidate === 'maggia',
  );

  const garbage_sig_row = proposals.create({
    specialist_id: 'trainer',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { summary: 'Valid filer, garbage signature owner.' },
    rationale: 'A garbage signature owner falls back to the filer.',
    signature: attribution_sig('all'),
  });
  check(
    "a garbage SIGNATURE owner falls back to the validated filer ('all' → 'trainer')",
    proposals.get(garbage_sig_row)?.category_signature_hash ===
      hash_signature(attribution_sig('trainer')),
  );

  // propose_action: ctx.specialist_id WINS over the LLM-authored signature
  // value — the exact live shape (trainer's turn authored 'beatrice').
  const propose_action = make_propose_action(proposals);
  const tool_ctx = {
    intent_id: 'smoke-inflow',
    now: new Date(),
    specialist_id: 'trainer',
  } as unknown as ToolContext;
  const { proposal_id } = await propose_action.execute(
    {
      action_spec: { summary: 'Close the ceiling-miss cluster.' },
      rationale: 'I want to fix the round-ceiling cluster at the runtime layer.',
      kind: 'recommendation',
      execution_kind: 'manual',
      category_signature: {
        specialist_id: 'beatrice', // LLM-authored display name — must lose to ctx
        kind: 'structural_gap',
        category: 'runtime-efficiency',
        anchor: 'attribution-smoke-tool',
      },
    },
    tool_ctx,
  );
  check(
    'propose_action attributes to ctx.specialist_id over the authored value',
    proposals.get(proposal_id)?.specialist_id === 'trainer',
  );
  await registry.close();
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:proposal-inflow OK'
    : `\nsmoke:proposal-inflow FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
