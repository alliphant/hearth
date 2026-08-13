/**
 * smoke-expertise-audit — self-contained test of Beatrice's expertise-coverage
 * audit (NEXT.md 15c part C). Own temp DB, mocked planner judge, fixture
 * specialists. No running orchestrator needed.
 *
 *   bun run scripts/smoke-expertise-audit.ts
 *
 * Asserts:
 *   1. A thin (deepen:true) specialist → one expertise_gap miss per axis +
 *      ONE consolidated Cordelia inbox flag.
 *   2. A well-covered (deepen:true) specialist → no gap, no flag.
 *   3. Idempotency — a second run opens 0 new misses / 0 flags.
 *   4. Per-run flag cap (FLAG_CAP=3) — 4 thin specialists → only 3 flags.
 *   5. FAIL-OPEN — a throwing judge yields 0 gaps, never a fabricated finding.
 *   6. evidence_ref shape `<id>:expertise:<axis>` (so verify_fix_landed's
 *      `expertise` pattern matches).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ProcessMissStore } from '@core/process_misses';
import { SpecialistInbox } from '@memory/stores/conversations';
import {
  SpecialistConfigSchema,
  compile,
  type LoadedSpecialist,
  type SpecialistRegistry,
} from '@core/specialist';
import { make_audit_specialist_expertise } from '@specialists/trainer/tools/audit_specialist_expertise';
import type { ToolContext } from '@core/tool';
import type {
  LLMRouter,
  LLMRequest,
  LLMResponse,
  RoleResolution,
} from '@core/llm';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures++;
}

function fixture(id: string, name: string, deepen = true): LoadedSpecialist {
  const cfg = SpecialistConfigSchema.parse({
    id,
    name,
    role: 'Test analyst',
    voice: 'warm',
    persona:
      'A persona long enough to satisfy the schema minimum length for tests.',
    deepen,
    proactive: { mode: 'batched' },
  });
  return compile(cfg, `fixture/${id}.yaml`);
}

/** Minimal registry stub — the audit only calls list() + get(). */
function registry(specialists: LoadedSpecialist[]): SpecialistRegistry {
  const by_id = new Map(specialists.map((s) => [s.id, s]));
  return {
    list: () => specialists,
    get: (id: string) => by_id.get(id) ?? null,
  } as unknown as SpecialistRegistry;
}

/** Mocked planner judge: returns gaps for ids starting `thin`, none otherwise.
 *  `throws` makes complete() reject (fail-open path). */
function router(opts: { throws?: boolean } = {}): LLMRouter {
  const provider = {
    name: 'mock',
    async complete(req: LLMRequest): Promise<LLMResponse> {
      if (opts.throws) throw new Error('judge unavailable');
      const user = req.messages.map((m) => m.content).join('\n');
      const thin = /id:\s*thin/i.test(user);
      const content = thin
        ? JSON.stringify({
            gaps: [
              {
                axis: 'domain_coverage',
                gap_kind: 'shelf',
                severity: 'high',
                focus_areas: ['the counter-positioning lanes for this domain'],
                rationale: 'persona only describes the incumbent.',
              },
              {
                axis: 'source_tiers',
                gap_kind: 'spec',
                severity: 'medium',
                focus_areas: [],
                rationale: 'trusted_sources manifest is empty.',
              },
            ],
          })
        : JSON.stringify({ gaps: [] });
      return {
        content,
        tool_calls: [],
        finish_reason: 'stop',
        cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'mock' },
      };
    },
    async *stream() {
      throw new Error('unused');
    },
    capabilities() {
      return {
        supports_json_schema: false,
        supports_tool_calls: false,
        supports_thinking_mode: false,
        supports_vision: false,
        max_context: 8192,
        cost_per_1m_in_cents: 0,
        cost_per_1m_out_cents: 0,
      };
    },
  };
  return {
    for_role: (): RoleResolution =>
      ({ provider, defaults: {}, model: 'mock' }) as unknown as RoleResolution,
  } as unknown as LLMRouter;
}

const ctx = {} as ToolContext; // the tool reads only input + deps

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hearth-expertise-'));
  const db = open_db(join(dir, 'test.db'));
  const misses = new ProcessMissStore(db);
  const inbox = new SpecialistInbox(db);
  const events = { emit: () => {} } as never;

  // ── Scenario A: thin + covered specialist ────────────────────────────────
  const specialists = [fixture('thin_expert', 'Thin Expert'), fixture('covered_expert', 'Covered Expert')];
  const tool = make_audit_specialist_expertise({
    specialists: registry(specialists),
    misses,
    inbox,
    events,
    llm: router(),
    db,
  });

  const r1 = await tool.execute({}, ctx);
  check('A: audited both specialists', r1.specialists_audited === 2);
  check('A: 2 gaps found (thin only)', r1.gaps_found === 2);
  check('A: 2 misses opened', r1.misses_opened.length === 2);
  check(
    'A: misses are all on thin_expert',
    r1.misses_opened.every((m) => m.specialist_id === 'thin_expert'),
  );
  check(
    'A: evidence_ref shape <id>:expertise:<axis>',
    r1.misses_opened.every((m) => m.evidence_ref.startsWith('thin_expert:expertise:')),
  );
  check('A: exactly ONE consolidated Cordelia flag', r1.cordelia_flags.length === 1);
  check(
    'A: flag targets thin_expert with 2 axes',
    r1.cordelia_flags[0]?.specialist_id === 'thin_expert' &&
      r1.cordelia_flags[0]?.axes.length === 2,
  );
  check(
    'A: process_miss rows persisted',
    misses.list().filter((m) => m.subject_specialist_id === 'thin_expert').length === 2,
  );
  check(
    'A: Cordelia inbox flag landed',
    inbox.unactioned_for('cordelia').some((row) => row.from_specialist_id === 'trainer'),
  );
  check(
    'A: covered_expert has no miss',
    misses.list().every((m) => m.subject_specialist_id !== 'covered_expert'),
  );

  // ── Scenario B: idempotency ───────────────────────────────────────────────
  const r2 = await tool.execute({}, ctx);
  check('B: 0 new gaps on re-run', r2.gaps_found === 0);
  check('B: 0 new misses on re-run', r2.misses_opened.length === 0);
  check('B: 0 new flags on re-run', r2.cordelia_flags.length === 0);
  check('B: already_tracked counts the 2 refs', r2.already_tracked === 2);
  check(
    'B: current_findings_refs still reports the active refs',
    r2.current_findings_refs.length === 2,
  );

  // ── Scenario C: per-run flag cap (FLAG_CAP=3) ─────────────────────────────
  const db2 = open_db(join(dir, 'cap.db'));
  const misses2 = new ProcessMissStore(db2);
  const inbox2 = new SpecialistInbox(db2);
  const four = ['thin_a', 'thin_b', 'thin_c', 'thin_d'].map((id) => fixture(id, id));
  const tool2 = make_audit_specialist_expertise({
    specialists: registry(four),
    misses: misses2,
    inbox: inbox2,
    events,
    llm: router(),
    db: db2,
  });
  const rc = await tool2.execute({}, ctx);
  check('C: 4 specialists × 2 gaps = 8 misses', rc.misses_opened.length === 8);
  check('C: Cordelia flags capped at 3', rc.cordelia_flags.length === 3);

  // ── Scenario D: fail-open on a throwing judge ─────────────────────────────
  const db3 = open_db(join(dir, 'failopen.db'));
  const misses3 = new ProcessMissStore(db3);
  const tool3 = make_audit_specialist_expertise({
    specialists: registry([fixture('thin_x', 'Thin X')]),
    misses: misses3,
    inbox: new SpecialistInbox(db3),
    events,
    llm: router({ throws: true }),
    db: db3,
  });
  const rd = await tool3.execute({}, ctx);
  check('D: fail-open → 0 gaps', rd.gaps_found === 0);
  check('D: fail-open → 0 misses', misses3.list().length === 0);

  // ── Scenario E: specialist_id override bypasses the deepen gate ────────────
  const db4 = open_db(join(dir, 'override.db'));
  const misses4 = new ProcessMissStore(db4);
  const tool4 = make_audit_specialist_expertise({
    specialists: registry([fixture('thin_optout', 'Thin Optout', /*deepen*/ false)]),
    misses: misses4,
    inbox: new SpecialistInbox(db4),
    events,
    llm: router(),
    db: db4,
  });
  const re_default = await tool4.execute({}, ctx);
  check('E: deepen:false skipped by default', re_default.specialists_audited === 0);
  const re_override = await tool4.execute({ specialist_id: 'thin_optout' }, ctx);
  check('E: specialist_id override audits it anyway', re_override.gaps_found === 2);

  rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
