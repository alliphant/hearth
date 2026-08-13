/**
 * smoke:proposal-loop-arms — the two arms that stop a proposal TEMPLATE from
 * sweeping the tool registry forever (2026-07-31).
 *
 * Background. "Add `candidates` to <tool> on error path" was filed 79 times
 * across 28 distinct tools between 2026-05-25 and 2026-07-29; exactly one
 * executed. Three defects fed each other:
 *
 *   1. the fix could never work — `ToolRegistry.invoke` dropped every Error
 *      property but `.message`, so the hint never reached the model, the
 *      process_miss recurred, and that miss was the evidence cited to file
 *      again. Fixed centrally in #231 (`with_candidates`).
 *   2. `dedup_key` was per-TOOL, so the sweep got one queue slot per tool in
 *      the registry and supersession never collapsed any of them.
 *   3. nothing checked the miss counts the rationale argued from, and the
 *      court demonstrably rewarded the confabulated version over the honest
 *      one ("Closes 0 open process_misses" got skipped; "closes 5 across
 *      Brigid, Maggie, and me" got approved).
 *
 * This locks arms 2 and 3: the pattern key, the re-file cooldown and its
 * new-evidence escape hatch, and the grounding stamp.
 *
 *   bun run smoke:proposal-loop-arms
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ProposalsStore, claimed_miss_count, grounding_note } from '@core/proposals';
import { compute_dedup_key } from '@core/proposal_render';
import type { Database } from 'bun:sqlite';

let passed = 0;
let failed = 0;
function check(label: string, cond: unknown, detail?: string): void {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++; }
}

/** The real shape trainer files, straight off a live payload_json row. */
function recovery_payload(tool: string, misses: string[] = []): Record<string, unknown> {
  return {
    slug: `connector-recovery-${tool.replace(/_/g, '-')}`,
    rel_path: `Knowledge/Trainer/binding-proposals/connector-recovery-${tool}.md`,
    summary: `Add optional \`candidates\` to \`${tool}\` output_schema; populated on error path.`,
    tool_name: tool,
    recovery_field_name: 'candidates',
    blast_radius: misses.length,
    cited_miss_ids: misses,
  };
}

const sig = (anchor: string) => ({ kind: 'recommendation', anchor }) as never;

function file(
  proposals: ProposalsStore,
  payload: Record<string, unknown>,
  rationale: string,
  anchor: string,
): string {
  return proposals.create({
    specialist_id: 'trainer',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload,
    rationale,
    signature: sig(anchor),
  });
}

function row(db: Database, id: string): { status: string; dedup_key: string | null; rationale_md: string } {
  return db
    .prepare(`SELECT status, dedup_key, rationale_md FROM proposals WHERE id = @id`)
    .get({ '@id': id }) as never;
}

const tmp = mkdtempSync(join(tmpdir(), 'hearth-loop-arms-'));
mkdirSync(join(tmp, 'vault'), { recursive: true });
const db = open_db(join(tmp, 'h.db'));
const proposals = new ProposalsStore(db);

console.log('→ ARM 1: the pattern key collapses a template sweep');
{
  const a = compute_dedup_key('recommendation', recovery_payload('read_note'));
  const b = compute_dedup_key('recommendation', recovery_payload('web_search'));
  check('two tools, ONE key', a === b && a === 'recommendation:pattern:connector_recovery:candidates', `${a} vs ${b}`);
  // A genuine per-tool contract fix is still its own subject.
  const rename = compute_dedup_key('recommendation', { tool_name: 'read_note', slug: 'rename-note-path' });
  check('a non-template tool recommendation stays per-tool', rename === 'recommendation:tool:read_note', String(rename));
  check('…and does not collide with the pattern key', rename !== a);
  // Kate's concern-keyed recommendations are untouched.
  const concern = compute_dedup_key('recommendation', { concern_key: 'radon', tool_name: 'ha_get_state' });
  check('an explicit concern_key still wins', concern === 'recommendation:concern:radon', String(concern));
}

console.log('→ ARM 1: a second tool now SUPERSEDES the first instead of queueing beside it');
{
  const first = file(proposals, recovery_payload('read_note'), 'read_note returns bare errors.', 'a1');
  const second = file(proposals, recovery_payload('web_search'), 'web_search returns bare errors.', 'a2');
  check('two distinct rows were created', first !== second);
  check('the earlier one is superseded', row(db, first).status === 'superseded', row(db, first).status);
  check('the later one is live', row(db, second).status !== 'superseded');
  check('both carry the pattern key', row(db, second).dedup_key === 'recommendation:pattern:connector_recovery:candidates');
}

console.log('→ ARM 2: a declined subject cannot simply come back');
{
  // Decline the live one, the way 54 of the 79 actually ended.
  db.prepare(
    `UPDATE proposals SET status = 'acknowledged', ts_decided = @ts
     WHERE dedup_key = 'recommendation:pattern:connector_recovery:candidates'
       AND status != 'superseded'`,
  ).run({ '@ts': new Date().toISOString() });

  const refile = file(proposals, recovery_payload('ocr_image'), 'ocr_image returns bare errors.', 'a3');
  const r = row(db, refile);
  check('the re-file is suppressed (returns the declined id, no new row)', r.status === 'acknowledged', r.status);

  // …and the suppression is not a permanent gag: NEW validated evidence files.
  // A real ledger row — the cooldown's escape hatch validates against the
  // actual process_misses table, so a fixture has to be a real row.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO process_misses
       (id, ts_created, ts_updated, subject_specialist_id, reporter,
        task_summary, gap, severity, status)
     VALUES ('pm_abcdef123456', @ts, @ts, 'kate', 'mariah',
             'analyze_image failure', 'bare error, no recovery path', 'medium', 'open')`,
  ).run({ '@ts': now });
  const with_new = file(
    proposals,
    recovery_payload('analyze_image', ['pm_abcdef123456']),
    'analyze_image: a real open miss traces to this — pm_abcdef123456.',
    'a4',
  );
  check('a re-file citing a NEW validated miss files normally', with_new !== refile && row(db, with_new).status !== 'acknowledged');

  // A fabricated id must NOT buy passage.
  const fabricated = file(
    proposals,
    recovery_payload('unifi_topology', ['pm_zzzzzzzzzzzz']),
    'unifi_topology: closes pm_zzzzzzzzzzzz.',
    'a5',
  );
  check('a FABRICATED miss id does not unlock the cooldown', row(db, fabricated).status === 'acknowledged' || fabricated === refile,
    `status=${row(db, fabricated).status}`);
}

console.log('→ ARM 3: claimed_miss_count reads what the filer actually asserted');
{
  check('structured blast_radius wins', claimed_miss_count({ blast_radius: 5 }, 'whatever') === 5);
  check('prose digits', claimed_miss_count({}, 'Closes 5 open process_misses.') === 5);
  check('prose words', claimed_miss_count({}, 'Four open misses trace to this shape.') === 4);
  check('an honest zero is a claim of zero, not "no claim"', claimed_miss_count({ blast_radius: 0 }, 'x') === 0);
  check('no numeric claim → null', claimed_miss_count({}, 'This connector returns bare errors.') === null);
}

console.log('→ ARM 3: the grounding stamp corrects overclaims and stays silent otherwise');
{
  check('accurate citation → no stamp', grounding_note(['pm_a'], new Set(['pm_a']), 1) === null);
  check('no claim, no citations → no stamp', grounding_note([], new Set(), null) === null);
  const over = grounding_note([], new Set(), 5);
  check('claims 5, cites none → stamped', over !== null && over.includes('claims to close 5') && over.includes('cites no pm_* miss ids'), String(over));
  const fake = grounding_note(['pm_a', 'pm_b'], new Set(['pm_a']), 2);
  check('cites 2, only 1 real → stamped with both counts', fake !== null && fake.includes('cites 2 pm_* ids, 1 of which exist'), String(fake));
  check('an honest under-claim is never stamped', grounding_note(['pm_a', 'pm_b'], new Set(['pm_a', 'pm_b']), 1) === null);
}

console.log('→ ARM 3: the stamp lands on the stored row, and keeps the filer\'s own words');
{
  const id = file(
    proposals,
    { concern_key: `grounding-${Date.now()}`, blast_radius: 7 },
    'Closes 7 open process_misses across the roster.',
    'a6',
  );
  const stored = row(db, id).rationale_md;
  check('the filer\'s sentence survives verbatim', stored.startsWith('Closes 7 open process_misses across the roster.'));
  check('the system line is appended', stored.includes('[GROUNDING — system-verified at filing]'), stored.slice(0, 200));
  check('and it states the ledger truth', stored.includes('claims to close 7'));
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ PROPOSAL-LOOP-ARMS SMOKE FAILED'); process.exit(1); }
console.log('\n✓ PROPOSAL-LOOP-ARMS SMOKE OK');
