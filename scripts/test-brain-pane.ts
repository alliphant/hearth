/**
 * smoke:brain-pane — self-contained test of Cordelia's "Second Brain" TAB
 * (compose_brain_tab in src/core/brain_pane.ts), the server-block summary of
 * the synthesis layer that makes the Brain office render on iOS/macOS.
 *
 * Temp vault + db. Seeds synthesis_note files across shelves (one owner-
 * visible, one household, one OTHER-user-private), records retrieval usage,
 * then asserts: the tab is composed with id 'brain', the hero counts only
 * VISIBLE syntheses (the cordon drops the other-user-private one — the owner
 * has no god-view), "Most drawn-on" surfaces the retrieved synthesis, the
 * shelf labels are right, an empty synthesis layer yields null, and a
 * non-owner gets nothing (the gate is at the library composer). No LLM, no net.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { compose_brain_tab } from '../src/core/brain_pane';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-brainpane-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });

const NOW = Date.now();
const iso = (days_ago: number): string => new Date(NOW - days_ago * 86_400_000).toISOString();

function seed_synthesis(o: {
  shelf: string;
  slug: string;
  topic: string;
  days_ago: number;
  grounding?: string;
  private_to?: string;
}): string {
  const path = `Knowledge/${o.shelf}/library/_synthesis/${o.slug}.md`;
  memory.upsert_note(
    path,
    {
      type: 'synthesis_note',
      title: `${o.topic} — what we know`,
      topic_label: o.topic,
      synthesized_at: iso(o.days_ago),
      grounding_outcome: o.grounding ?? 'clean',
      synthesized_from: [`Knowledge/${o.shelf}/library/src-${o.slug}.md`],
      ...(o.private_to ? { private_to: o.private_to } : {}),
    },
    `# ${o.topic} — what we know\n\nA distilled fact about ${o.topic}.\n\n## Sources\n- [[src-${o.slug}]]\n`,
  );
  return path;
}

const OWNER = { user_id: 'jasper', tier: 'owner' as const };
const FRIEND = { user_id: 'kim', tier: 'friend' as const };

// Empty vault → null (flat library pane, byte-identical to pre-Brain).
check('empty synthesis layer → null', compose_brain_tab({ memory, vault_root, caller: OWNER }) === null);

const ev = seed_synthesis({ shelf: 'Vivian', slug: 'ev-charging', topic: 'EV charging economics', days_ago: 1 });
seed_synthesis({ shelf: 'Anya', slug: 'pet-meds', topic: 'Pet medication schedules', days_ago: 5, grounding: 'corrected' });
seed_synthesis({ shelf: 'Astrid', slug: 'kim-secret', topic: "Kim's private regimen", days_ago: 2, private_to: 'kim' });

// Two retrieval hits on the EV synthesis — it's earning its keep.
memory.record_synthesis_retrievals([ev], iso(0));
memory.record_synthesis_retrievals([ev], iso(0));

const tab = compose_brain_tab({ memory, vault_root, caller: OWNER });
check('owner gets a Brain tab', tab !== null && tab.id === 'brain' && tab.label === 'The Brain');

const hero = tab?.blocks.find((b) => b.type === 'hero_metric') as { value: string; label: string } | undefined;
check('hero counts only VISIBLE syntheses (cordon drops kim-private) → 2', hero?.value === '2');
check('hero names the shelf count (2 shelves: Vivian, Anya)', /2 shelves/.test(hero?.label ?? ''));

const lists = (tab?.blocks ?? []).filter((b) => b.type === 'list') as Array<{
  title?: string;
  items: Array<{ title: string; subtitle?: string }>;
}>;
const drawn = lists.find((l) => l.title === 'Most drawn-on');
check('"Most drawn-on" surfaces the retrieved EV synthesis', !!drawn && drawn.items.some((i) => /EV charging/.test(i.title)));
check('"Most drawn-on" shows the hit count + shelf', !!drawn && drawn.items.some((i) => /Vivian/.test(i.subtitle ?? '') && /2 answers/.test(i.subtitle ?? '')));

const recent = lists.find((l) => l.title === 'Recently distilled');
check('"Recently distilled" is newest-first (EV, 1d, leads)', recent?.items[0]?.title === 'EV charging economics');
check('cordon: the kim-private synthesis never appears for the owner', !JSON.stringify(tab).includes('private regimen'));

// A friend viewing the same layer sees their OWN private synthesis but not
// the household/owner ones — proves the cordon is symmetric, not owner-only.
const friend_tab = compose_brain_tab({ memory, vault_root, caller: FRIEND });
check("friend sees only their own private synthesis", friend_tab !== null && JSON.stringify(friend_tab).includes('private regimen') && !JSON.stringify(friend_tab).includes('EV charging'));

rmSync(dir, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\nsmoke:brain-pane FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✓ smoke:brain-pane — all checks passed');
