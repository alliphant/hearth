/**
 * smoke:program-patterns — Mariah's fuzzy detection pass, focused on the
 * repeated_miss_class COHERENT-CLASS gate (2026-06-28).
 *
 * Self-contained: temp db, real ProcessMissStore, TEST_MODE judge (confirms
 * every gathered candidate, so the gather thresholds ARE the test). Covers:
 *   - miss_class_key normalization (strip subject id / dated + id suffixes).
 *   - a specialist with 3 UNRELATED one-off misses → NO pattern:repeat (the
 *     2026-06-28 18-wide "fundamental deficits" fan-out is gone).
 *   - 3 misses of the SAME class → ONE pattern:repeat:<subject>:<class>, named.
 *   - dependency:* (infra) + pattern:* (self) misses excluded from the count.
 *   - idempotency: a re-run opens nothing new.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { ProcessMissStore } from '../src/core/process_misses';
import {
  make_scan_program_patterns,
  miss_class_key,
} from '../src/specialists/mariah/tools/scan_program_patterns';
import type { ToolContext } from '../src/core/tool';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

process.env.HEARTH_TEST_MODE = '1'; // judge confirms every gathered candidate

const dir = mkdtempSync(join(tmpdir(), 'hearth-patterns-'));
const db = open_db(join(dir, 'smoke.db'));
const misses = new ProcessMissStore(db);
const ctx: ToolContext = { memory: undefined as never, llm: undefined as never, now: new Date(), intent_id: ulid(), specialist_id: 'mariah' };

/* ------------------------------------------------------------------ */
/* 1. miss_class_key normalization                                     */
/* ------------------------------------------------------------------ */
check('class-key: strips the specialist id', miss_class_key('honesty:fabricated_save:kate', 'kate') === 'honesty:fabricated_save');
check('class-key: keeps a tool-scoped arg-mismatch', miss_class_key('arg-mismatch:read_note', 'iris') === 'arg-mismatch:read_note');
check('class-key: drops an ISO-week suffix', miss_class_key('round-ceiling:kate:2026-W26', 'kate') === 'round-ceiling');
check('class-key: drops an ISO-date suffix', miss_class_key('kristi-spec-reject:2026-06-28', 'kristi') === 'kristi-spec-reject');
check('class-key: strips a trailing ULID (the real recurring shape)', miss_class_key('auth:fab-after-read-failure-consult:01KW36QABCDEF01', 'eleanor') === 'auth:fab-after-read-failure-consult');
check('class-key: strips a trailing typed id (c_…)', miss_class_key('intake:bad-route:c_7c4msww1vy', 'cordelia') === 'intake:bad-route');
check('class-key: null on no ref', miss_class_key(null, 'kate') === null);
check('class-key: null when only the subject survives', miss_class_key('kate', 'kate') === null);

/* ------------------------------------------------------------------ */
/* 2. UNRELATED one-off misses → NO pattern:repeat (the fan-out fix)   */
/* ------------------------------------------------------------------ */
{
  // Eleanor: 3 misses, each a DIFFERENT class — the grab-bag that used to fan
  // out a generic "fundamental deficits" miss.
  misses.create({ subject_specialist_id: 'eleanor', reporter: 'kate', task_summary: 't', gap: 'moisture read failed', severity: 'medium', evidence_ref: 'arg-mismatch:read_note' });
  misses.create({ subject_specialist_id: 'eleanor', reporter: 'kate', task_summary: 't', gap: 'ceiling hit', severity: 'medium', evidence_ref: 'round-ceiling:eleanor:2026-W26' });
  misses.create({ subject_specialist_id: 'eleanor', reporter: 'kate', task_summary: 't', gap: 'spec reject', severity: 'low', evidence_ref: 'eleanor-spec-reject:2026-06-28' });
  // an infra-health miss against eleanor's domain — must NOT count toward her quality.
  misses.create({ subject_specialist_id: 'eleanor', reporter: 'kate', task_summary: 't', gap: 'firecrawl down', severity: 'high', evidence_ref: 'dependency:firecrawl:health' });

  const scan = make_scan_program_patterns(db, misses);
  const r = await scan.execute({ lookback_hours: 168 }, ctx);
  const repeat_for_eleanor = r.misses_opened.filter((o) => o.pattern === 'repeated_miss_class' && o.subject_specialist_id === 'eleanor');
  check('fan-out fix: 3 UNRELATED misses (+1 infra) → NO repeated_miss_class for eleanor', repeat_for_eleanor.length === 0);
}

/* ------------------------------------------------------------------ */
/* 3. SAME-class recurrence → ONE specific pattern:repeat              */
/* ------------------------------------------------------------------ */
{
  // A single ref dedups to ONE ledger row (chokepoint dedup) → below the floor.
  for (let i = 0; i < 3; i++) {
    misses.create({ subject_specialist_id: 'iris', reporter: 'kate', task_summary: 't', gap: `read_note failed run ${i}`, severity: 'medium', evidence_ref: 'arg-mismatch:read_note' });
  }
  check('same-class: iris (1 deduped row) stays below the floor', miss_class_key('arg-mismatch:read_note', 'iris') === 'arg-mismatch:read_note');

  // Maggie: 3 DISTINCT incidents of the SAME class — the real recurring shape
  // (ULID-suffixed refs, like eleanor's auth:fab-after-read-failure-consult ×4).
  misses.create({ subject_specialist_id: 'maggie', reporter: 'kate', task_summary: 't', gap: 'fab after read fail A', severity: 'medium', evidence_ref: 'auth:fab-after-read-failure-consult:01KW36QABCDEF01' });
  misses.create({ subject_specialist_id: 'maggie', reporter: 'kate', task_summary: 't', gap: 'fab after read fail B', severity: 'medium', evidence_ref: 'auth:fab-after-read-failure-consult:01KW36QABCDEF02' });
  misses.create({ subject_specialist_id: 'maggie', reporter: 'kate', task_summary: 't', gap: 'fab after read fail C', severity: 'medium', evidence_ref: 'auth:fab-after-read-failure-consult:01KW36QABCDEF03' });

  const scan = make_scan_program_patterns(db, misses);
  const r = await scan.execute({ lookback_hours: 168 }, ctx);
  const maggie = r.misses_opened.find((o) => o.pattern === 'repeated_miss_class' && o.subject_specialist_id === 'maggie');
  check('same-class: 3 distinct fab-after-read-failure incidents → ONE repeated_miss_class for maggie', !!maggie);
  check('same-class: evidence_ref names the specific class', maggie?.evidence_ref === 'pattern:repeat:maggie:auth:fab-after-read-failure-consult');
  // iris had only 1 surviving row (dedup) → below the floor → no candidate.
  check('same-class: iris (1 deduped row) → no candidate', !r.misses_opened.some((o) => o.subject_specialist_id === 'iris' && o.pattern === 'repeated_miss_class'));
}

/* ------------------------------------------------------------------ */
/* 4. Idempotency — a re-run opens nothing new                         */
/* ------------------------------------------------------------------ */
{
  const scan = make_scan_program_patterns(db, misses);
  const r = await scan.execute({ lookback_hours: 168 }, ctx);
  check('idempotent: re-run opens no new repeated_miss_class', !r.misses_opened.some((o) => o.pattern === 'repeated_miss_class'));
}

rmSync(dir, { recursive: true, force: true });
console.log('');
console.log(failures === 0 ? 'smoke:program-patterns OK' : `smoke:program-patterns FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
