/**
 * smoke:attribution-rules — the substring-rule + retroactive re-stamp upgrade to
 * calendar owner attribution (Phase 3 ops, 2026-06-20).
 *
 * Replays the live gap: the owner says "Grant Taylor 6/30 is Sam's" but the
 * calendar title is "Appointment w/ Grant Taylor, DO" — the old exact-title
 * fingerprint never matched. Self-contained: temp db + vault, no LLM. Exercises:
 *   A. EventAttributions.record_substring / match_substring (contains, longest-
 *      wins, min-length guard) + best_match excludes substring rows.
 *   B. attribute_event_owner: a substring rule attributes a loosely-titled event.
 *   C. set_event_owner tool end-to-end: records the rule AND re-stamps existing
 *      matching life_events (owner set, uncertain cleared, cordon flipped) — the
 *      duplicate-note pair both fixed — so the table re-projects to the owner.
 *
 *   bun run smoke:attribution-rules
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { EventAttributions } from '@memory/stores/event_attributions';
import { attribute_event_owner, type AttributionMember } from '@core/calendar/attribution';
import { make_set_event_owner } from '@specialists/kate/tools/set_event_owner';
import type { ToolContext } from '@core/tool';
import type { UserRegistry } from '@core/users';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const MEMBERS: AttributionMember[] = [
  { id: 'jasper', display_name: 'Jasper', email: 'jasper@x.com' },
  { id: 'sam', display_name: 'Sam', email: 'sam@x.com' },
];
const users = {
  list: () => [
    { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
    { id: 'sam', display_name: 'Sam', tier: 'household' },
  ],
  get: (id: string) =>
    ({ jasper: { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
       sam: { id: 'sam', display_name: 'Sam', tier: 'household' } } as Record<string, unknown>)[id] ?? null,
  get_timezone: () => 'America/Denver',
} as unknown as UserRegistry;

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-attr-rules-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  // ── A. The store ──────────────────────────────────────────────────────────
  const store = new EventAttributions(db);
  check('record_substring returns true for a usable phrase', store.record_substring('becca', 'jasper') === true);
  check('match_substring CONTAINS a loose title', store.match_substring('appointment with becca sagall licensed massage therapist')?.user_id === 'jasper');
  check('match_substring misses an unrelated title', store.match_substring('dentist cleaning') === null);
  check('min-length guard rejects too-short phrases', store.record_substring('dr', 'sam') === false);
  // Longest-phrase-wins (most specific).
  store.record_substring('grant', 'jasper');
  store.record_substring('grant taylor', 'sam');
  check('longest matching phrase wins', store.match_substring('appointment w grant taylor do')?.user_id === 'sam');
  // best_match (exact tiers) must NOT return substring rows.
  check('best_match ignores substring rows', store.best_match({ title_norm: 'grant taylor', location_norm: '', weekday: '', hour: 0 }) === null);

  // ── B. attribute_event_owner uses the rule ────────────────────────────────
  const attributions = new EventAttributions(db); // 'grant taylor' → sam already recorded
  const attr = attribute_event_owner(
    { title: 'Appointment w/ Grant Taylor, DO', ts_start: '2026-06-30T18:00:00Z' },
    { members: MEMBERS, attributions, tz: 'America/Denver' },
  );
  check('a loosely-titled event attributes via the substring rule', attr.user_id === 'sam');
  check('the signal names the rule', attr.signals.some((s) => /rule "grant taylor"/.test(s)));

  // ── C. set_event_owner tool: record rule + RE-STAMP existing events ────────
  // Seed the live shape: TWO duplicate notes for one appointment, cordoned
  // differently (one jasper, one sam), both owner-uncertain.
  const le = (id: string, cordon: string) =>
    memory.upsert_note(`Household/Calendar/${id}.md`, {
      type: 'life_event', id, title: 'Appointment w/ Grant Taylor, DO', category: 'appointment',
      event_date: '2026-06-30T18:00:00Z', actionable: true, owner_uncertain: true, source: 'calendar', private_to: cordon,
    }, '# Appointment');
  le('le_gt0001', 'jasper');
  le('le_gt0002', 'sam');
  // An unrelated event that must NOT be touched.
  memory.upsert_note('Household/Calendar/le_other1.md', {
    type: 'life_event', id: 'le_other1', title: 'Team standup', category: 'meeting',
    event_date: '2026-06-22T18:00:00Z', source: 'calendar', private_to: 'household',
  }, '# standup');
  await rebuild(vault, memory, db);

  const tool = make_set_event_owner({ db, users, memory });
  const ctx = { memory, intent_id: 'i1', specialist_id: 'kate' } as unknown as ToolContext;
  const res = await tool.execute({ title: 'Grant Taylor', owner: 'sam' }, ctx);
  check('tool recorded', res.recorded === true && res.owner_user_id === 'sam');
  check('tool re-stamped BOTH duplicate notes', res.restamped === 2);
  check('tool note is honest about future + past', /auto-attribute/.test(res.note) && /Re-stamped 2/.test(res.note));

  // The notes themselves are re-stamped (owner + cordon flipped, uncertain cleared).
  for (const id of ['le_gt0001', 'le_gt0002']) {
    const note = memory.read_note(`Household/Calendar/${id}.md`);
    check(`${id}: owner set to sam`, note?.frontmatter?.owner === 'sam');
    check(`${id}: owner_uncertain cleared`, note?.frontmatter?.owner_uncertain === false);
    check(`${id}: re-cordoned to sam`, note?.frontmatter?.private_to === 'sam');
  }
  // The unrelated event is untouched.
  const other = memory.read_note('Household/Calendar/le_other1.md');
  check('unrelated event not re-stamped', other?.frontmatter?.owner === undefined && other?.frontmatter?.private_to === 'household');

  // After re-projection the life_events table reflects the new cordon (so the
  // followup scan would route the appointment to Sam).
  await rebuild(vault, memory, db);
  const cordons = db.prepare(`SELECT private_to FROM life_events WHERE id IN ('le_gt0001','le_gt0002')`).all() as Array<{ private_to: string }>;
  check('projected table re-cordoned both to sam', cordons.length === 2 && cordons.every((c) => c.private_to === 'sam'));

  // The forward rule now lives in the store too.
  check('a substring rule for "grant taylor" → sam is recorded', new EventAttributions(db).match_substring('appointment w grant taylor do')?.user_id === 'sam');

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:attribution-rules — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
