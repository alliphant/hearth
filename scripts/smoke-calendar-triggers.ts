/**
 * smoke:calendar-triggers — Kate's cross-domain calendar followups (Phase 3)
 * AND the learning loop it closes with the Trust Ladder.
 *
 * Self-contained: temp db + vault, no orchestrator. A MOCK planner LLM for the
 * gift ideas (deterministic). Exercises scan_calendar_followups:
 *   - birthday → gift: an upcoming birthday files a gift proposal carrying the
 *     LEARNED budget (median of recorded gift costs) + 2-3 ideas (mock LLM)
 *   - vacation → flights + welcome-back; appointment → prep
 *   - actionable/window filtering (a non-actionable meeting + a far vacation
 *     never file)
 *   - cordon scoping (household/birthday → owner-global; a member's appt → them)
 *   - edge dedup (a second run files nothing)
 *   - the no-LLM fallback (gift offer falls back to likes + budget, never fails)
 *   - the kill switch (HEARTH_CALENDAR_TRIGGERS off → no-op)
 *   - the LOOP: deciding a followup proposal accrues Trust-Ladder XP
 *
 *   bun run smoke:calendar-triggers
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { ProposalsStore } from '@core/proposals';
import { make_scan_calendar_followups } from '@specialists/kate/tools/scan_calendar_followups';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

// Mock planner LLM (deterministic). Routes by the SYSTEM prompt: the
// judgment gate (2026-07-20) gets an approve-all {"file":[...]} unless
// gate_verdict overrides; the gift brainstorm keeps its canned ideas.
let gate_verdict = 'approve_all';
const mock_llm = {
  for_role: () => ({
    provider: {
      complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
        const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
        if (sys.includes('guard') && sys.includes('attention')) {
          if (gate_verdict === 'approve_all') {
            const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
            const refs = [...user.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
            return { content: JSON.stringify({ file: refs }) };
          }
          return { content: gate_verdict };
        }
        return { content: '["a Front Range trail guide", "an artisan dark-chocolate box"]' };
      },
    },
    defaults: { temperature: 0.4 },
  }),
} as unknown as LLMRouter;

function payload_of(db: import('bun:sqlite').Database, pid: string): Record<string, unknown> {
  return JSON.parse((db.prepare(`SELECT payload_json FROM proposals WHERE id = @id`).get({ '@id': pid }) as { payload_json: string }).payload_json);
}
function user_of(db: import('bun:sqlite').Database, pid: string): string | null {
  return (db.prepare(`SELECT user_id FROM proposals WHERE id = @id`).get({ '@id': pid }) as { user_id: string | null }).user_id;
}

async function main(): Promise<void> {
  process.env.HEARTH_CALENDAR_TRIGGERS = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-cal-trig-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const proposals = new ProposalsStore(db);
  const now = new Date('2026-06-20T12:00:00Z');

  // ── People (birthdays + likes + gift_history for the learned budget) ───────
  memory.upsert_note('People/Kim.md', {
    type: 'person', id: 'p_lee001', name: 'Kim', relationship: 'friend',
    birthday: '06-28', // 8 days out
    likes: ['hiking', 'dark chocolate'],
    gift_history: [
      { date: '2024-06-28', what: 'book', cost: 40 },
      { date: '2025-06-28', what: 'speaker', cost: 60 },
    ],
    private_to: 'household',
  }, '');
  // A person with NO gift history → budget is "ask" (never hard-coded).
  memory.upsert_note('People/Dad.md', {
    type: 'person', id: 'p_dad001', name: 'Dad', relationship: 'family',
    birthday: '06-25', // 5 days out
    private_to: 'household',
  }, '');
  // The owner's OWN note (relationship self) — must never get a gift proposal.
  memory.upsert_note('People/Jasper.md', {
    type: 'person', id: 'p_self01', name: 'Jasper', relationship: 'self',
    birthday: '06-27', private_to: 'household',
  }, '');

  // ── life_events (vacation + appointment in window; meeting + far vacation out) ─
  const le = (fm: Record<string, unknown>) => memory.upsert_note(`Household/Calendar/${fm.id}.md`, { type: 'life_event', source: 'calendar', ...fm }, `# ${fm.title}`);
  le({ id: 'le_vac001', title: 'Maui getaway', category: 'vacation', owner: 'jasper', event_date: '2026-06-30T18:00:00Z', end_date: '2026-07-07T18:00:00Z', actionable: true, private_to: 'household' });
  le({ id: 'le_appt01', title: 'Dentist', category: 'appointment', owner: 'sam', event_date: '2026-06-22T18:00:00Z', location: 'Foothills Dental', actionable: true, private_to: 'sam' });
  le({ id: 'le_mtg001', title: 'standup', category: 'meeting', owner: 'jasper', event_date: '2026-06-21T18:00:00Z', actionable: false, private_to: 'household' });
  le({ id: 'le_vacfar', title: 'Winter trip', category: 'vacation', owner: 'jasper', event_date: '2026-09-01T18:00:00Z', actionable: true, private_to: 'household' });
  await rebuild(vault, memory, db);

  const OPTS = { birthday_within_days: 14, vacation_within_days: 45, appointment_within_days: 3 };
  const tool = make_scan_calendar_followups({ memory, proposals, llm: mock_llm });
  const ctx = { memory, now, intent_id: 'i1', specialist_id: 'kate' } as unknown as ToolContext;

  // ── 1. First run files the due followups ──────────────────────────────────
  const r1 = await tool.execute(OPTS, ctx);
  check('first run enabled', r1.enabled === true);
  // 2 birthdays (Kim, Dad — Jasper is self) + 1 vacation + 1 appointment.
  check('four followups filed (2 birthday + vacation + appointment)', r1.filed === 4);

  const all = r1.proposal_ids.map((pid) => ({ pid, p: payload_of(db, pid) }));
  const lee_gift = all.find((x) => x.p.followup_kind === 'birthday_gift' && x.p.person_name === 'Kim')!;
  const dad_gift = all.find((x) => x.p.followup_kind === 'birthday_gift' && x.p.person_name === 'Dad')!;
  const vac = all.find((x) => x.p.followup_kind === 'vacation_flights')!;
  const appt = all.find((x) => x.p.followup_kind === 'appointment_prep')!;

  check('owner self note never gets a gift proposal', !all.some((x) => x.p.person_name === 'Jasper'));

  // ── 2. The gift exemplar — learned budget + ideas ─────────────────────────
  check('Kim gift carries the LEARNED budget (median 40,60 = 50)', (lee_gift.p.budget as { amount: number }).amount === 50);
  check('Kim gift carries 2 brainstormed ideas (mock LLM)', Array.isArray(lee_gift.p.ideas) && (lee_gift.p.ideas as string[]).length === 2);
  check('Kim gift drew the likes', JSON.stringify(lee_gift.p.likes) === JSON.stringify(['hiking', 'dark chocolate']));
  const lee_rationale = proposals.get(lee_gift.pid)!.rationale_md ?? '';
  check('Kim gift rationale names an idea', /trail guide|chocolate/i.test(lee_rationale));

  // ── 3. No-LLM fallback (Dad: no gift history → budget "ask", no ideas) ─────
  check('Dad gift budget is null (no history → never hard-coded)', (dad_gift.p.budget as { amount: number | null }).amount === null);

  // ── 4. Cordon scoping ─────────────────────────────────────────────────────
  check('birthday gift is owner-global (user_id null)', user_of(db, lee_gift.pid) === null);
  check('household vacation followup is owner-global', user_of(db, vac.pid) === null);
  check('Sam’s personal appointment followup is scoped to Sam', user_of(db, appt.pid) === 'sam');

  // ── 5. Filtering: the meeting + far vacation never filed ───────────────────
  check('non-actionable meeting filed nothing', !all.some((x) => x.p.event_id === 'le_mtg001'));
  check('out-of-window vacation filed nothing', !all.some((x) => x.p.event_id === 'le_vacfar'));

  // ── 6. Edge dedup: a second run files nothing new ─────────────────────────
  const r2 = await tool.execute(OPTS, ctx);
  check('second run files NOTHING new (edge dedup)', r2.filed === 0);

  // ── 7. The judgment gate (2026-07-20) — fail-CLOSED without an LLM, and
  //       gating actually drops candidates. Fresh dbs so signatures don't
  //       dedup against the first run.
  const db2 = open_db(join(tmp, 'h2.db'));
  const mem2 = new MemoryClient({ vault_root: vault, db: db2 });
  const prop2 = new ProposalsStore(db2);
  await rebuild(vault, mem2, db2);
  const tool_nollm = make_scan_calendar_followups({ memory: mem2, proposals: prop2 });
  const r3 = await tool_nollm.execute(OPTS, { memory: mem2, now, intent_id: 'i2', specialist_id: 'kate' } as unknown as ToolContext);
  check('no-LLM run files NOTHING (judgment gate fail-CLOSED)', r3.filed === 0 && r3.due === 4);
  db2.close();

  const db2b = open_db(join(tmp, 'h2b.db'));
  const mem2b = new MemoryClient({ vault_root: vault, db: db2b });
  await rebuild(vault, mem2b, db2b);
  gate_verdict = '{"file":[0]}'; // approve only the first candidate
  const r3b = await make_scan_calendar_followups({ memory: mem2b, proposals: new ProposalsStore(db2b), llm: mock_llm })
    .execute(OPTS, { memory: mem2b, now, intent_id: 'i2b', specialist_id: 'kate' } as unknown as ToolContext);
  check('gate approves 1 of 4 → exactly 1 files (3 gated out)', r3b.filed === 1 && r3b.due === 4);
  gate_verdict = 'approve_all';
  db2b.close();

  // ── 8. The loop: deciding a followup accrues Trust-Ladder XP ───────────────
  process.env.HEARTH_TRUST_XP = '1';
  const h = proposals.get(lee_gift.pid)!.category_signature_hash!;
  const before = proposals.trust_level_for(h)!.xp;
  proposals.decide(lee_gift.pid, 'approve');
  const after = proposals.trust_level_for(h)!.xp;
  check('deciding the gift followup accrued XP (the closed loop)', after > before);
  delete process.env.HEARTH_TRUST_XP;

  // ── 9. Kill switch ────────────────────────────────────────────────────────
  delete process.env.HEARTH_CALENDAR_TRIGGERS;
  const db3 = open_db(join(tmp, 'h3.db'));
  const mem3 = new MemoryClient({ vault_root: vault, db: db3 });
  await rebuild(vault, mem3, db3);
  const r4 = await make_scan_calendar_followups({ memory: mem3, proposals: new ProposalsStore(db3), llm: mock_llm })
    .execute(OPTS, { memory: mem3, now, intent_id: 'i3', specialist_id: 'kate' } as unknown as ToolContext);
  check('kill switch OFF → tool no-ops', r4.enabled === false && r4.filed === 0);
  db3.close();

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:calendar-triggers — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
