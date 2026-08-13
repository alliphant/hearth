/**
 * smoke:person-enrichment — the self-maintaining dossier sweep. Fake LLM +
 * in-memory messages/conversations + an in-memory people map. No network.
 */
import { Database } from 'bun:sqlite';
import type { MemoryClient, PersonRow, PersonLookup } from '../src/memory/client';
import {
  run_person_enrichment_sweep,
  merge_facts,
  extract_person_facts,
  type EnrichLLM,
  type ExtractedFacts,
} from '../src/core/person_enrichment';

let pass = 0, fail = 0;
function check(n: string, c: boolean): void { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } }
function section(s: string): void { console.log(`\n${s}`); }

// ── people map (fake memory) ────────────────────────────────────────────────
interface Entry { id: string; note_path: string; fm: Record<string, unknown> }
const entries = new Map<string, Entry>();
function seed(id: string, name: string, fm: Record<string, unknown>): void {
  entries.set(id, { id, note_path: `People/${name}.md`, fm: { type: 'person', id, name, relationship: 'friend', ...fm } });
}
seed('p_sara01', 'Sam', { private_to: 'household', likes: ['hiking'] });
seed('p_lee012', 'Kim', { private_to: 'kim' }); // siloed to user "kim" — jasper can't enrich
seed('p_anc001', 'Granny', { private_to: 'household', gedcom_xref: '@I1@' }); // genealogy

function to_row(e: Entry): PersonRow {
  const fm = e.fm;
  return {
    id: e.id, name: String(fm.name), preferred_name: null, relationship: String(fm.relationship ?? 'friend'),
    birthday: null, contact_cadence: null, last_contacted: null, sensitive: 0, friday_managed: 0, do_not_contact: 0,
    note_path: e.note_path, frontmatter_json: JSON.stringify(fm), mtime: '',
  };
}
const memory = {
  query_people: () => [...entries.values()].map(to_row),
  find_person: (crit: { id?: string }): PersonLookup | null => {
    const e = crit.id ? entries.get(crit.id) : undefined;
    return e ? { id: e.id, note_path: e.note_path, frontmatter: e.fm } : null;
  },
  upsert_note: (_path: string, fm: Record<string, unknown>) => {
    const id = String(fm.id);
    const prev = entries.get(id);
    if (prev) entries.set(id, { ...prev, fm });
  },
  append_to_note: () => {},
  log_action: () => 'audit_x',
} as unknown as MemoryClient;

// ── fake LLM: returns canned facts (the merge + wiring is what's under test) ──
let llm_calls = 0;
const llm: EnrichLLM = {
  for_role: () => ({
    provider: {
      complete: async (req) => {
        llm_calls++;
        const u = req.messages.map((m) => m.content).join(' ');
        if (/Sam/.test(u)) {
          return { content: JSON.stringify({ interests: ['pottery'], dietary: ['gluten-free'], pets: [{ name: 'Biscuit', species: 'dog' }] } satisfies ExtractedFacts) };
        }
        return { content: '{}' };
      },
    },
  }),
};

// ── in-memory messages/conversations ────────────────────────────────────────
const db = new Database(':memory:');
db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT)');
db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, ts TEXT, role TEXT, content_md TEXT)');
const NOW = new Date('2026-06-22T12:00:00Z');
const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
db.exec("INSERT INTO conversations VALUES ('c_jasper','jasper'), ('c_lee','kim')");
db.prepare('INSERT INTO messages VALUES (@i,@c,@t,@r,@m)').run({ '@i': 'm1', '@c': 'c_jasper', '@t': recent, '@r': 'user', '@m': 'Sam is gluten-free now and she got a dog named Biscuit. She loves pottery.' });
// A message about Kim in JASON's convo — but Kim is kim-siloed, so jasper can't enrich Kim.
db.prepare('INSERT INTO messages VALUES (@i,@c,@t,@r,@m)').run({ '@i': 'm2', '@c': 'c_jasper', '@t': recent, '@r': 'user', '@m': 'Kim likes chess.' });

async function main(): Promise<void> {
  // ── A. pure merge_facts ──────────────────────────────────────────────────
  section('A. merge_facts (pure)');
  const m1 = merge_facts({ likes: ['hiking'] }, { interests: ['pottery', 'hiking'], dietary: ['vegan'] });
  check('interests→likes union-dedup (hiking already present)', (m1.patch.likes as string[]).join() === 'hiking,pottery' && (m1.patch.dietary as string[]).join() === 'vegan');
  check('added lists only the new', m1.added.includes('interest:pottery') && !m1.added.some((a) => a.includes('hiking')) && m1.added.includes('dietary:vegan'));
  const m2 = merge_facts({ likes: ['pottery'] }, { interests: ['pottery'] });
  check('no-op when nothing new (idempotent)', Object.keys(m2.patch).length === 0 && m2.added.length === 0);
  const m3 = merge_facts({ pets: [{ name: 'Max' }] }, { pets: [{ name: 'Max', species: 'cat' }, { name: 'Biscuit', species: 'dog' }] });
  check('objects dedup by key (Max exists, Biscuit added)', (m3.patch.pets as any[]).length === 2 && m3.added.includes('pet:Biscuit') && !m3.added.includes('pet:Max'));

  // ── B. extract_person_facts (fail-open) ──────────────────────────────────
  section('B. extract');
  const bad: EnrichLLM = { for_role: () => ({ provider: { complete: async () => ({ content: 'not json' }) } }) };
  check('bad JSON → null (fail-open)', (await extract_person_facts(bad, 'X', ['hi'])) === null);
  check('no snippets → null', (await extract_person_facts(llm, 'X', [])) === null);

  // ── C. sweep end-to-end ──────────────────────────────────────────────────
  section('C. sweep');
  process.env.HEARTH_PERSON_ENRICH = '0';
  const off = await run_person_enrichment_sweep({ db, memory, llm, now: () => NOW });
  check('dark by default (flag off → no-op)', off.people === 0 && off.facts === 0 && llm_calls === 0);

  process.env.HEARTH_PERSON_ENRICH = '1';
  const r1 = await run_person_enrichment_sweep({ db, memory, llm, now: () => NOW });
  check('enriched Sam (≥1 person, facts added)', r1.people === 1 && r1.facts >= 3);
  const sam = entries.get('p_sara01')!.fm;
  check('Sam gained interests/dietary/pets', (sam.likes as string[]).includes('pottery') && (sam.dietary as string[]).includes('gluten-free') && (sam.pets as any[]).some((p) => p.name === 'Biscuit'));
  check('cordon: Kim (kim-siloed) NOT enriched by jasper', !('likes' in entries.get('p_lee012')!.fm));
  check('genealogy (Granny) never touched', Object.keys(entries.get('p_anc001')!.fm).filter((k) => k === 'likes').length === 0);

  // ── D. idempotent re-run ─────────────────────────────────────────────────
  section('D. idempotency');
  const r2 = await run_person_enrichment_sweep({ db, memory, llm, now: () => NOW });
  check('re-run adds nothing (union-dedup)', r2.facts === 0);
  check('Sam still has exactly 1 Biscuit (no dup)', (entries.get('p_sara01')!.fm.pets as any[]).filter((p) => p.name === 'Biscuit').length === 1);

  console.log(`\n${fail === 0 ? '✅' : '❌'} person-enrichment: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
