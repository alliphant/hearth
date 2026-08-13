/**
 * smoke:gift-loop — the People-accretion + LEARNED gift-budget substrate (Phase 3).
 *
 * Self-contained: temp db + vault, real MemoryClient, no LLM. Exercises:
 *   A. compute_learned_gift_budget — derived from a person's own recorded spend
 *      (NEVER hard-coded): no history → null/"ask"; costed gifts → median + range
 *      + confidence; recency (last 5); format helper.
 *   B. the pure accretion helpers (string-list dedup/cap, gift-history dedup).
 *   C. record_person_pref — creates a Person note, accretes likes + a costed
 *      gift, idempotency, the "nothing to record" guard, and (armed) feeds the
 *      owner's gift_budget user_model facet.
 *
 *   bun run smoke:gift-loop
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import {
  compute_learned_gift_budget,
  format_gift_budget,
  accrete_string_list,
  accrete_gift_history,
  type GiftHistoryEntry,
} from '@core/gift_budget';
import { record_person_pref } from '@specialists/kate/tools/record_person_pref';
import type { ToolContext } from '@core/tool';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  // ── A. compute_learned_gift_budget ────────────────────────────────────────
  const none = compute_learned_gift_budget([]);
  check('no history → amount null', none.amount === null);
  check('no history → confidence none', none.confidence === 'none');
  check('no history → basis says ask', /ask/i.test(none.basis));
  check('no history → format says not set', /not set/i.test(format_gift_budget(none)));

  // Uncosted gifts don't count (the budget is from real spend only).
  const uncosted = compute_learned_gift_budget([{ date: '2025-01-01', what: 'a card' }]);
  check('uncosted gifts → still no learned amount', uncosted.amount === null);

  const three = compute_learned_gift_budget([
    { date: '2024-12-25', what: 'book', cost: 30 },
    { date: '2025-06-10', what: 'speaker', cost: 60 },
    { date: '2025-12-25', what: 'jacket', cost: 90 },
  ]);
  check('three costed gifts → median amount (60)', three.amount === 60);
  check('range low/high observed (30–90)', three.low === 30 && three.high === 90);
  check('confidence med at 3 samples', three.confidence === 'med');
  check('format shows the range', /30–90/.test(format_gift_budget(three)));

  // Recency: only the most recent 5 inform it — an ancient cheap gift drops out.
  const recency = compute_learned_gift_budget([
    { date: '2010-01-01', what: 'ancient', cost: 5 },
    { date: '2025-01-01', what: 'a', cost: 100 },
    { date: '2025-02-01', what: 'b', cost: 100 },
    { date: '2025-03-01', what: 'c', cost: 100 },
    { date: '2025-04-01', what: 'd', cost: 100 },
    { date: '2025-05-01', what: 'e', cost: 100 },
  ]);
  check('recency: ancient cheap gift excluded → amount 100', recency.amount === 100);
  check('recency: sample capped at 5', recency.sample_n === 5);

  // ── B. accretion helpers ──────────────────────────────────────────────────
  const liked = accrete_string_list(['hiking'], ['Hiking', 'dark chocolate', 'hiking']);
  check('string-list dedups case-insensitively', liked.length === 2);
  check('string-list keeps the original casing', liked.includes('hiking') && liked.includes('dark chocolate'));

  const g0: GiftHistoryEntry[] = [{ date: '2025-06-10', what: 'speaker', cost: 60 }];
  const g1 = accrete_gift_history(g0, { date: '2025-12-25', what: 'jacket', cost: 90 });
  check('gift-history appends a new gift', g1.length === 2);
  const g2 = accrete_gift_history(g1, { date: '2025-06-10', what: 'Speaker', cost: 60 });
  check('gift-history dedups on (date, what)', g2.length === 2);

  // ── C. record_person_pref ─────────────────────────────────────────────────
  process.env.HEARTH_USER_MODEL = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-gift-loop-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const ctx = {
    memory,
    user: { id: 'jasper', tier: 'owner', display_name: 'Jasper' },
    intent_id: 'i1',
    now: new Date('2026-06-20T12:00:00Z'),
    specialist_id: 'kate',
  } as unknown as ToolContext;

  // New person + likes + a costed gift in one call.
  const r1 = await record_person_pref.execute(
    { person: 'Kim', likes: ['hiking', 'dark chocolate'], gift: { what: 'bluetooth speaker', cost: 60, occasion: 'birthday' } },
    ctx,
  );
  check('record_person_pref ok', r1.ok === true);
  check('created a new Person note', r1.created === true);
  check('applied likes + gift', r1.applied.includes('likes (+2)') && r1.applied.includes('gift'));

  const note = memory.read_note(r1.note_path!);
  check('person note carries the likes', JSON.stringify(note?.frontmatter?.likes) === JSON.stringify(['hiking', 'dark chocolate']));
  check('person note is household-stamped (shared entity)', note?.frontmatter?.private_to === 'household');
  const gh = note?.frontmatter?.gift_history as GiftHistoryEntry[];
  check('person note carries the costed gift', gh?.[0]?.cost === 60 && gh?.[0]?.what === 'bluetooth speaker');

  // The budget now learns from that recorded gift.
  const budget = compute_learned_gift_budget(gh);
  check('learned budget derived from the recorded gift (60)', budget.amount === 60);

  // The gift fed the owner's gift_budget facet (armed).
  const facet = memory.user_profiles.get_facet('jasper', 'gift_budget');
  check('gift_budget facet got an observation', (facet?.observations?.length ?? 0) === 1);

  // Accretion onto the existing note (a second like merges, not replaces).
  const r2 = await record_person_pref.execute({ person: 'Kim', likes: ['sci-fi novels'] }, ctx);
  check('second call updates the existing note (not created)', r2.created === false);
  const note2 = memory.read_note(r2.note_path!);
  check('likes accreted to 3', (note2?.frontmatter?.likes as string[]).length === 3);

  // The "nothing to record" guard.
  const r3 = await record_person_pref.execute({ person: 'Kim' }, ctx);
  check('empty pref → ok:false guard', r3.ok === false);

  delete process.env.HEARTH_USER_MODEL;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:gift-loop — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
