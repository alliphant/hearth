/**
 * smoke:synthesis-heal — self-contained test of the Second Brain self-heal pass
 * (#3, heal_syntheses). Temp vault + db + registry; seeds four syntheses on
 * four shelves and asserts the detection→action matrix:
 *
 *   - integrity ROT (a cited source deleted)      → delete + shelf reset (regen)
 *   - DEAD WEIGHT (weak + unused + old)           → prune (delete, no regen)
 *   - healthy but unused (sound + unused + old)   → KEPT (health protects)
 *   - used but weak (weak + USED + old)           → KEPT (usage protects)
 *
 * plus the kill switch, the per-note footprint deletion (file + chunks +
 * usage), and the shelf-state reset semantics.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { ShelfSynthesisStore } from '../src/memory/stores/shelf_synthesis';
import { capitalize } from '../src/core/loops';
import { heal_syntheses } from '../src/specialists/cordelia/synthesis_heal';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-heal-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
for (const id of ['eleanor', 'vivian', 'anya', 'iris', 'ruby']) {
  writeFileSync(
    join(spec_dir, `${id}.yaml`),
    `id: ${id}\nname: ${capitalize(id)}\nrole: Test\nvoice: warm\npersona: Test fixture persona, long enough to satisfy the loader.\nproactive:\n  mode: reactive\n`,
  );
}
const specialists = new SpecialistRegistry(spec_dir);

const NOW = new Date('2026-06-15T12:00:00Z');
const iso = (d: Date) => d.toISOString();
const days_ago = (n: number) => iso(new Date(NOW.getTime() - n * 86_400_000));
const chunks_of = (p: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = @p`).get({ '@p': p }) as { n: number }).n;

function seed_source(shelf: string, slug: string, tier?: 1 | 2): string {
  const p = `Knowledge/${shelf}/library/${slug}.md`;
  const fm: Record<string, unknown> = { type: 'clipping', title: slug, specialist_scope: shelf.toLowerCase() };
  if (tier) fm.trust_tier = tier;
  memory.upsert_note(p, fm, `${slug} body content with enough words to matter.`);
  return p;
}

function seed_synth(o: {
  shelf: string;
  slug: string;
  sources: string[];
  outcome?: 'clean' | 'corrected' | 'reduced';
  age_days: number;
}): string {
  const p = `Knowledge/${o.shelf}/library/_synthesis/${o.slug}.md`;
  memory.upsert_note(
    p,
    {
      type: 'synthesis_note',
      title: `${o.slug} — synthesis`,
      specialist_scope: o.shelf.toLowerCase(),
      topic_label: o.slug,
      synthesized_from: o.sources,
      synthesized_at: days_ago(o.age_days),
      derived: true,
      grounding_outcome: o.outcome ?? 'clean',
    },
    `# ${o.slug} — what we know\n\nDistilled prose for ${o.slug}.\n`,
  );
  db.prepare(`INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, 0, @c)`).run({
    '@p': p,
    '@c': `distilled prose for ${o.slug}`,
  });
  // Seed the shelf-state produced map so we can assert reset vs. keep semantics.
  const shelf_prefix = `Knowledge/${o.shelf}/library`;
  const store = new ShelfSynthesisStore(db);
  const st = store.get(shelf_prefix);
  store.put({ shelf_path: shelf_prefix, last_synthesized_at: days_ago(1), produced: { ...st.produced, [p]: 'seedhash' } });
  return p;
}

// ── 1. ROT (Eleanor): cites 3 sources, one of which is never created ────────
const eA = seed_source('Eleanor', 'tom-a', 1);
const eB = seed_source('Eleanor', 'tom-b', 1);
const E_ROT = seed_synth({ shelf: 'Eleanor', slug: 'tomato-blight', sources: [eA, eB, 'Knowledge/Eleanor/library/gone.md'], age_days: 5 });

// ── 2. DEAD WEIGHT (Vivian): 1 untiered source, old, unused → weak ──────────
const vA = seed_source('Vivian', 'old-laptop'); // untiered
const V_DEAD = seed_synth({ shelf: 'Vivian', slug: 'old-laptop-notes', sources: [vA], age_days: 170 });

// ── 3. HEALTHY-UNUSED (Anya): 3 Tier-1 sources, 60d, unused → sound, KEPT ────
const aA = seed_source('Anya', 'pet-a', 1);
const aB = seed_source('Anya', 'pet-b', 1);
const aC = seed_source('Anya', 'pet-c', 1);
const A_KEEP = seed_synth({ shelf: 'Anya', slug: 'pet-care', sources: [aA, aB, aC], age_days: 60 });

// ── 4. USED-BUT-WEAK (Iris): 1 untiered source, old, but USED → KEPT ────────
const iA = seed_source('Iris', 'route-a'); // untiered → weak like Vivian's
const I_KEEP = seed_synth({ shelf: 'Iris', slug: 'route-notes', sources: [iA], age_days: 170 });
memory.record_synthesis_retrievals([I_KEEP], iso(NOW)); // RECENT use protects it

// ── 5. COLD-ABANDONED (Ruby): weak, once used but cold >90d → cold-prune ─────
const rA = seed_source('Ruby', 'civic-a'); // untiered → weak
const R_COLD = seed_synth({ shelf: 'Ruby', slug: 'civic-notes', sources: [rA], age_days: 170 });
memory.record_synthesis_retrievals([R_COLD], days_ago(120)); // used, then cold

const heal_deps = { library_deps: { db, vault_root, memory, specialists } };

// ── kill switch first (no deletions) ────────────────────────────────────────
process.env.HEARTH_SYNTHESIS_HEAL = '0';
const off = await heal_syntheses(heal_deps, { now: NOW });
delete process.env.HEARTH_SYNTHESIS_HEAL;
check('kill switch: disabled, no scan, no action', !off.enabled && off.scanned === 0 && off.resynthesize_queued === 0 && off.pruned_dead_weight === 0);
check('kill switch: nothing deleted', existsSync(resolve(vault_root, E_ROT)) && existsSync(resolve(vault_root, V_DEAD)));

// ── the real pass ───────────────────────────────────────────────────────────
const r = await heal_syntheses(heal_deps, { now: NOW });

check('scanned all five syntheses', r.scanned === 5);
check('one rot → resynthesize queued', r.resynthesize_queued === 1);
check('two dead-weight → pruned (never-used + cold-abandoned)', r.pruned_dead_weight === 2);
check('only the rotted shelf was reset', r.shelves_reset.length === 1 && r.shelves_reset[0] === 'Knowledge/Eleanor/library');

// ROT: deleted everywhere + shelf reset for regeneration
check('ROT: note file deleted', !existsSync(resolve(vault_root, E_ROT)));
check('ROT: chunks deleted', chunks_of(E_ROT) === 0);
check('ROT: usage row deleted', memory.get_synthesis_usage([E_ROT]).size === 0);
{
  const st = new ShelfSynthesisStore(db).get('Knowledge/Eleanor/library');
  check('ROT: dropped from produced + last_synthesized_at reset to null (regen next pass)', !(E_ROT in st.produced) && st.last_synthesized_at === null);
}

// DEAD WEIGHT: deleted, but NOT regenerated (produced kept, shelf not reset)
check('DEAD: note file deleted', !existsSync(resolve(vault_root, V_DEAD)));
check('DEAD: chunks deleted', chunks_of(V_DEAD) === 0);
{
  const st = new ShelfSynthesisStore(db).get('Knowledge/Vivian/library');
  check('DEAD: produced entry KEPT + shelf NOT reset (stays pruned)', V_DEAD in st.produced && st.last_synthesized_at !== null);
}

// KEPT: healthy-unused (health protects) + RECENTLY-used weak (recency protects)
check('KEEP: healthy-unused synthesis survives (health protects)', existsSync(resolve(vault_root, A_KEEP)) && chunks_of(A_KEEP) === 1);
check('KEEP: weak synthesis used RECENTLY survives (recency protects)', existsSync(resolve(vault_root, I_KEEP)) && chunks_of(I_KEEP) === 1);
// self-cleaning: the recency complement — weak + used-but-COLD is abandoned
check('COLD-ABANDONED: weak synthesis cold >90d is pruned', !existsSync(resolve(vault_root, R_COLD)) && chunks_of(R_COLD) === 0);

// audit trail
{
  const rows = db
    .prepare(`SELECT execution_result FROM audit_log WHERE tool_name = 'synthesis_heal'`)
    .all() as Array<{ execution_result: string }>;
  const actions = rows.map((x) => JSON.parse(x.execution_result).action as string);
  const reasons = rows.map((x) => JSON.parse(x.execution_result).reason as string);
  check('audit: resynthesize + two prune rows', actions.includes('resynthesize') && actions.filter((a) => a === 'prune').length === 2 && rows.length === 3);
  check('audit: a cold-abandoned reason is recorded', reasons.some((r2) => r2.includes('abandoned')));
}

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nsmoke:synthesis-heal OK' : `\nsmoke:synthesis-heal FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
