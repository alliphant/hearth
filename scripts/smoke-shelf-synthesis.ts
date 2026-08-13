/**
 * smoke:shelf-synthesis — self-contained test of Cordelia's nightly distill
 * pass (consolidation cycle Phase 1).
 *
 * Temp vault + db + specialist registry; the distiller is a deterministic
 * stub (no LLM), the embedder is a fake so embed-at-ingest is exercised too.
 * Seeds a shelf with raw clipping items across THREE visibility buckets and
 * asserts:
 *
 *   - the trigger (a shelf with nothing new is skipped without clustering),
 *   - one synthesis per (bucket, topic), and the CENTERPIECE: a synthesis
 *     note NEVER mixes visibility buckets — its private_to and every source
 *     it cites share one bucket,
 *   - the synthesis note is chunked into chunks_fts + embedded (searchable),
 *     is type:synthesis_note, and never re-enters the clippings projection,
 *   - idempotency (an unchanged topic skips the LLM),
 *   - change detection (a new item in a topic re-synthesizes only that one),
 *   - fail-open (a distiller outage skips topics, never the pass),
 *   - the kill switch, and the tool wrapper's output schema.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import type { Embedder } from '../src/core/embeddings';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';
import type { LibraryRoutesDeps } from '../src/app/routes/library';
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import {
  synthesize_shelves,
  ground_synthesis,
  type Distiller,
  type SynthesisAssessor,
  type ShelfSynthesisDeps,
} from '../src/specialists/cordelia/shelf_synthesis';
import { make_synthesize_shelves } from '../src/specialists/cordelia/tools/synthesize_shelves';
import type { FactFinding } from '../src/core/fact_critic';
import { score_synthesis } from '../src/core/synthesis_health';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-synth-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'eleanor.yaml'),
  `id: eleanor
name: Eleanor
role: Garden
voice: warm
persona: |
  Test fixture persona for the shelf-synthesis smoke. Long enough to pass.
proactive:
  mode: reactive
`,
);
const specialists = new SpecialistRegistry(spec_dir); // constructor loads synchronously

const fake_embedder: Embedder = {
  enabled: true,
  model: 'fake-embed',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  },
  async rerank(): Promise<number[]> {
    return [];
  },
};

const library_deps: LibraryRoutesDeps = {
  db,
  vault_root,
  memory,
  specialists,
  runtime: null as unknown as SpecialistRuntime, // synthesis never touches it
  conversations: null as unknown as ConversationStore,
  llm: undefined, // distiller is overridden below
  embedder: fake_embedder,
};

// Deterministic distiller — records what it was handed so we can assert the
// pass never mixes buckets at the INPUT, not just the output.
const distill_calls: Array<{ topic: string; source_paths: string[] }> = [];
const mock_distill: Distiller = async ({ topic_label, sources }) => {
  distill_calls.push({ topic: topic_label, source_paths: sources.map((s) => s.note_path) });
  return (
    `This shelf now covers ${topic_label}. Across ${sources.length} notes the durable ` +
    `takeaways are consistent and worth keeping for later reference. ` +
    `Drawn from: ${sources.map((s) => s.title).join('; ')}.`
  );
};

const deps: ShelfSynthesisDeps = { library_deps, distill_fn: mock_distill };

// ------------------------------------------------------------------
// Fixtures — three visibility buckets, two real topics + a singleton
// ------------------------------------------------------------------
const T0 = Date.parse('2026-06-14T00:00:00Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const NOON = new Date(T0 + 12 * 3_600_000);

let seed_idx = 0;
function seed_item(o: {
  slug: string;
  title: string;
  body: string;
  private_to: string | null;
  captured_at: string;
}): string {
  const note_path = `Knowledge/Eleanor/library/${o.slug}.md`;
  const fm: Record<string, unknown> = {
    type: 'clipping',
    id: `c_${o.slug}`,
    kind: 'url',
    source: 'url',
    title: o.title,
    captured_at: o.captured_at,
    reviewed: false,
    tags: [],
    specialist_scope: 'eleanor',
  };
  if (o.private_to) fm.private_to = o.private_to;
  memory.upsert_note(note_path, fm, o.body);
  db.prepare(
    `INSERT INTO clippings
       (id, kind, source, source_url, title, attachment_path, captured_at,
        reviewed, note_path, frontmatter_json, mtime, private_to)
     VALUES (@id, 'url', 'url', NULL, @title, NULL, @captured, 0, @note_path,
        @fm, @mtime, @private_to)`,
  ).run({
    '@id': `c_${o.slug}_${seed_idx++}`,
    '@title': o.title,
    '@captured': o.captured_at,
    '@note_path': note_path,
    '@fm': JSON.stringify(fm),
    '@mtime': o.captured_at,
    '@private_to': o.private_to,
  });
  return note_path;
}

// Strong, near-identical token bodies per topic so the deterministic
// token-overlap clustering groups them; near-zero cross-topic overlap.
const tomato_body = (extra: string) =>
  `Tomato early blight is a common fungal disease. Copper fungicide spray helps prevent ` +
  `tomato blight spreading across the leaves. Remove infected tomato leaves promptly. ${extra}`;
const drip_body = (extra: string) =>
  `Drip irrigation delivers water slowly through emitter lines. Space drip emitters evenly ` +
  `and schedule drip irrigation for early morning to reduce evaporation. ${extra}`;

// household bucket: tomato×3, drip×3, compost×1 (singleton)
const HH_TOMATO = [
  seed_item({ slug: 'hh-tom-a', title: 'Tomato blight prevention', body: tomato_body('Rotate beds yearly.'), private_to: 'household', captured_at: at(1) }),
  seed_item({ slug: 'hh-tom-b', title: 'Early blight on tomatoes', body: tomato_body('Mulch to limit soil splash.'), private_to: 'household', captured_at: at(2) }),
  seed_item({ slug: 'hh-tom-c', title: 'Tomato leaf spot treatment', body: tomato_body('Water at the base only.'), private_to: 'household', captured_at: at(3) }),
];
const HH_DRIP = [
  seed_item({ slug: 'hh-drip-a', title: 'Drip irrigation schedule', body: drip_body('Run 30 minutes per zone.'), private_to: 'household', captured_at: at(4) }),
  seed_item({ slug: 'hh-drip-b', title: 'Drip emitter spacing', body: drip_body('Twelve inches for clay soil.'), private_to: 'household', captured_at: at(5) }),
  seed_item({ slug: 'hh-drip-c', title: 'Drip line layout', body: drip_body('Loop the perimeter beds.'), private_to: 'household', captured_at: at(6) }),
];
seed_item({ slug: 'hh-compost', title: 'Compost bin notes', body: 'Kitchen scraps and leaf litter compost into rich humus over a season. Turn the bin weekly for aeration.', private_to: 'household', captured_at: at(7) });

// sam bucket: tomato×3 — the SAME topic, a DIFFERENT user. Must synthesize
// into its own note, never merged with the household tomato note.
const SARA_TOMATO = [
  seed_item({ slug: 'sam-tom-a', title: 'Tomato blight in my plot', body: tomato_body('Sam: south bed worst hit.'), private_to: 'sam', captured_at: at(8) }),
  seed_item({ slug: 'sam-tom-b', title: 'Tomato fungal leaf issue', body: tomato_body('Sam: tried neem oil too.'), private_to: 'sam', captured_at: at(9) }),
  seed_item({ slug: 'sam-tom-c', title: 'Tomato blight follow-up', body: tomato_body('Sam: copper worked best.'), private_to: 'sam', captured_at: at(10) }),
];

const ctx: ToolContext = {
  memory,
  llm: null as unknown as LLMRouter,
  now: NOON,
  intent_id: ulid(),
  specialist_id: 'cordelia',
};

// ------------------------------------------------------------------
// 1. First pass — trigger fires, 3 syntheses, no bucket mixing
// ------------------------------------------------------------------
const runA = await synthesize_shelves(deps, { now: NOON });
check('runA enabled + scanned the eleanor shelf', runA.enabled && runA.shelves_scanned === 1);
check('runA wrote exactly 3 syntheses (hh-tomato, hh-drip, sam-tomato)', runA.syntheses_written === 3);
check('runA counted the compost singleton as below-min', runA.topics_below_min >= 1);

const synth_notes = runA.notes.map((p) => ({ path: p, note: memory.read_note(p)! }));
check('all 3 synthesis notes were written to disk', synth_notes.every((s) => s.note !== null));
check(
  'every synthesis note is type:synthesis_note (AUXILIARY)',
  synth_notes.every((s) => (s.note.frontmatter as Record<string, unknown>).type === 'synthesis_note'),
);
check(
  'synthesis notes land under the _synthesis/ subfolder',
  synth_notes.every((s) => s.path.includes('/library/_synthesis/')),
);

// CENTERPIECE: no bucket mixing. For each note, its private_to and every
// cited source must belong to ONE bucket.
const path_bucket = new Map<string, string>();
for (const p of [...HH_TOMATO, ...HH_DRIP]) path_bucket.set(p, 'household');
for (const p of SARA_TOMATO) path_bucket.set(p, 'sam');
path_bucket.set('Knowledge/Eleanor/library/hh-compost.md', 'household');

let mixing = false;
for (const { note } of synth_notes) {
  const fm = note.frontmatter as Record<string, unknown>;
  const stamp = typeof fm.private_to === 'string' ? fm.private_to : '∅';
  const srcs = (fm.synthesized_from as string[]) ?? [];
  const src_buckets = new Set(srcs.map((s) => path_bucket.get(s) ?? '?'));
  // one bucket across sources, and the note's stamp matches it
  if (src_buckets.size !== 1) mixing = true;
  else if ([...src_buckets][0] !== stamp) mixing = true;
}
check('CENTERPIECE: no synthesis note mixes visibility buckets', !mixing);

// Identify the syntheses by the sources they cite (robust to label drift),
// not by guessing the slug.
const sf_of = (n: { frontmatter: Record<string, unknown> }): string[] =>
  (n.frontmatter.synthesized_from as string[]) ?? [];
const eq_set = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const find_synth = (expected: string[]) => synth_notes.find((s) => eq_set(sf_of(s.note), expected));

const hh_tomato = find_synth(HH_TOMATO);
const sara_tomato = find_synth(SARA_TOMATO);
const hh_drip = find_synth(HH_DRIP);
check('all three expected topics produced a synthesis', !!hh_tomato && !!sara_tomato && !!hh_drip);
check('household-tomato and sam-tomato are DISTINCT notes', !!hh_tomato && !!sara_tomato && hh_tomato.path !== sara_tomato.path);
check(
  'household-tomato stamped private_to:household, cites only household sources',
  !!hh_tomato && (hh_tomato.note.frontmatter as Record<string, unknown>).private_to === 'household',
);
check(
  'sam-tomato stamped private_to:sam, cites only sam sources',
  !!sara_tomato && (sara_tomato.note.frontmatter as Record<string, unknown>).private_to === 'sam',
);
check(
  'the distiller was never handed a mixed-bucket source set',
  distill_calls.every((c) => new Set(c.source_paths.map((p) => path_bucket.get(p))).size === 1),
);

// Searchable: chunks_fts + embeddings landed for a synthesis note.
const fts = db
  .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = ?`)
  .get(hh_tomato!.path) as { n: number };
check('synthesis note indexed into chunks_fts (searchable)', fts.n > 0);
const emb = db
  .prepare(`SELECT COUNT(*) AS n FROM chunk_embeddings WHERE note_path = ?`)
  .get(hh_tomato!.path) as { n: number };
check('synthesis note embedded (embed-at-ingest via embedder)', emb.n > 0);
const in_clip = db
  .prepare(`SELECT COUNT(*) AS n FROM clippings WHERE note_path = ?`)
  .get(hh_tomato!.path) as { n: number };
check('synthesis note never enters the clippings projection (no re-synthesis loop)', in_clip.n === 0);
check('source body cited in the synthesis (provenance present)', hh_tomato!.note.body.includes('hh-tom-a.md'));

// Phase 1.5: every shelved synthesis is marked derived + carries the gate's
// verdict. (No llm + no assess_fn here → default assessor returns [] → clean.)
check(
  'every synthesis note is marked derived:true (cite-through provenance)',
  synth_notes.every((s) => (s.note.frontmatter as Record<string, unknown>).derived === true),
);
check(
  'every synthesis note records grounding_outcome (the write-time gate ran)',
  synth_notes.every((s) => (s.note.frontmatter as Record<string, unknown>).grounding_outcome === 'clean'),
);
check(
  'every synthesis note carries a health_score (number 0..1)',
  synth_notes.every((s) => {
    const v = (s.note.frontmatter as Record<string, unknown>).health_score;
    return typeof v === 'number' && v >= 0 && v <= 1;
  }),
);
check(
  'every synthesis note is graded sound (3 untiered clean sources)',
  synth_notes.every((s) => (s.note.frontmatter as Record<string, unknown>).health_grade === 'sound'),
);

// ------------------------------------------------------------------
// 2. Idempotency — an unchanged topic skips the LLM
// ------------------------------------------------------------------
distill_calls.length = 0;
const runB = await synthesize_shelves(deps, { now: NOON, force: true });
check('runB (force) wrote nothing — all topics unchanged', runB.syntheses_written === 0);
check('runB skipped 3 topics as unchanged', runB.topics_skipped_unchanged === 3);
check('runB never called the distiller for an unchanged topic', distill_calls.length === 0);

// ------------------------------------------------------------------
// 3. Trigger — a shelf with nothing new is skipped without clustering
// ------------------------------------------------------------------
const runC = await synthesize_shelves(deps, { now: NOON });
check('runC (no force, nothing new) skips the shelf entirely', runC.shelves_scanned === 0 && runC.syntheses_written === 0);

// ------------------------------------------------------------------
// 4. Change detection — a new item re-synthesizes ONLY its topic
// ------------------------------------------------------------------
const NEW_TOM = seed_item({
  slug: 'hh-tom-d',
  title: 'Tomato blight resistant cultivars',
  body: tomato_body('Choose resistant varieties like Iron Lady.'),
  private_to: 'household',
  captured_at: at(12 * 60 + 30), // 12:30 — after NOON, before the run clock
});
distill_calls.length = 0;
const LATER = new Date(T0 + 13 * 3_600_000);
const runD = await synthesize_shelves(deps, { now: LATER });
check('runD re-synthesizes exactly the changed topic', runD.syntheses_written === 1);
check('runD skipped the two unchanged topics', runD.topics_skipped_unchanged === 2);
const rewritten = runD.notes.map((p) => memory.read_note(p)!).find((n) => sf_of(n).includes(NEW_TOM));
check(
  'household-tomato now cites 4 sources (the new item folded in)',
  !!rewritten && sf_of(rewritten).length === 4 && sf_of(rewritten).includes(NEW_TOM),
);
check(
  'runD only distilled the changed topic (with the new item)',
  distill_calls.length === 1 && distill_calls[0]!.source_paths.includes(NEW_TOM),
);

// ------------------------------------------------------------------
// 5. Tool wrapper output schema
// ------------------------------------------------------------------
const tool = make_synthesize_shelves(deps);
const tool_out = await tool.execute({ force: true, max_shelves: 12, min_items_per_topic: 3 }, ctx);
check('tool result validates against output_schema', tool.output_schema.safeParse(tool_out).success);
check('tool is volatile + job-gated by write_vault_any_library', tool.volatile === true && tool.required_capabilities?.includes('write_vault_any_library') === true);

// ------------------------------------------------------------------
// 5b. ground_synthesis — the write-time grounding gate (unit, no LLM)
// ------------------------------------------------------------------
const finding = (claim: string): FactFinding => ({ claim, kind: 'named_entity', reason: 'test' });
{
  const g = await ground_synthesis('Grounded prose about copper fungicide and base watering.', {
    assess: async () => [],
    redistill: async () => {
      throw new Error('clean prose must not re-distill');
    },
  });
  check('gate clean: grounded prose passes untouched', g.outcome === 'clean' && g.prose !== null && g.flagged.length === 0);
}
{
  const g = await ground_synthesis('First draft mentions the Iron Lady cultivar prominently here.', {
    assess: async (p) => (p.includes('Iron Lady') ? [finding('Iron Lady')] : []),
    redistill: async () => 'A grounded rewrite with no invented cultivar and plenty of real content to remain substantial.',
  });
  check('gate corrected: a re-distill that grounds the flag is accepted', g.outcome === 'corrected' && !!g.prose && !g.prose.includes('Iron Lady'));
}
{
  const bad =
    'Pruning roses in late winter above an outward facing bud encourages healthy airflow and is the consistent recommendation across these notes. ' +
    'The Rose Festival on Mars 2099 was the highlight of the season. ' +
    'Removing dead rose wood and crossing canes keeps the bush open and reduces disease pressure over the whole season.';
  const g = await ground_synthesis(bad, {
    assess: async (p) => (p.includes('Mars 2099') ? [finding('Mars 2099')] : []),
    redistill: async () => bad, // correction still carries the fabrication
  });
  check(
    'gate reduced: flagged sentence dropped, grounded remainder kept',
    g.outcome === 'reduced' && !!g.prose && !g.prose.includes('Mars 2099') && g.prose.includes('Pruning roses'),
  );
}
{
  const g = await ground_synthesis('The Rose Festival on Mars 2099.', {
    assess: async (p) => (p.includes('Mars 2099') ? [finding('Mars 2099')] : []),
    redistill: async () => 'The Rose Festival on Mars 2099.',
  });
  check('gate rejected: shelve nothing when too little survives grounding', g.outcome === 'rejected' && g.prose === null);
}

// ------------------------------------------------------------------
// 5c. Gate end-to-end: a fabrication in the distiller output is caught at
//     WRITE time (reduced + audited), never shelved verbatim. Fresh db.
// ------------------------------------------------------------------
const dir3 = mkdtempSync(join(tmpdir(), 'hearth-synth3-'));
const db3 = open_db(join(dir3, 'smoke.db'));
const memory3 = new MemoryClient({ vault_root: join(dir3, 'vault'), db: db3 });
const library_deps3: LibraryRoutesDeps = { ...library_deps, db: db3, vault_root: join(dir3, 'vault'), memory: memory3 };
const g_rose_body = (x: string) =>
  `Prune roses in late winter. Cut rose canes above an outward facing bud. Remove dead rose wood for airflow and shape across the rose bush. ${x}`;
function seed3(slug: string, title: string, body: string, captured_at: string): void {
  const note_path = `Knowledge/Eleanor/library/${slug}.md`;
  const fm = { type: 'clipping', id: `c_${slug}`, kind: 'url', source: 'url', title, captured_at, reviewed: false, tags: [], specialist_scope: 'eleanor', private_to: 'household' };
  memory3.upsert_note(note_path, fm, body);
  db3.prepare(
    `INSERT INTO clippings (id,kind,source,source_url,title,attachment_path,captured_at,reviewed,note_path,frontmatter_json,mtime,private_to)
     VALUES (@id,'url','url',NULL,@t,NULL,@c,0,@p,@f,@c,'household')`,
  ).run({ '@id': `c_${slug}`, '@t': title, '@c': captured_at, '@p': note_path, '@f': JSON.stringify(fm) });
}
seed3('g-rose-a', 'Rose pruning basics', g_rose_body('Start with oldest canes.'), at(1));
seed3('g-rose-b', 'Rose pruning timing', g_rose_body('Finish before bud break.'), at(2));
seed3('g-rose-c', 'Rose pruning cuts', g_rose_body('Angle each cut cleanly.'), at(3));
// Quarantined junk (quality-gate rejects) under _quarantine/ — same topic
// tokens as the real roses, so if NOT excluded they'd fold into the cluster.
// The first live run (2026-06-14) synthesized 11 such smoke-test fixtures.
function seed3q(slug: string, title: string, body: string, captured_at: string): void {
  const note_path = `Knowledge/Eleanor/library/_quarantine/${slug}.md`;
  const fm = { type: 'clipping', id: `c_${slug}`, kind: 'url', source: 'url', title, captured_at, reviewed: false, tags: [], specialist_scope: 'eleanor', private_to: 'household' };
  memory3.upsert_note(note_path, fm, body);
  db3.prepare(
    `INSERT INTO clippings (id,kind,source,source_url,title,attachment_path,captured_at,reviewed,note_path,frontmatter_json,mtime,private_to)
     VALUES (@id,'url','url',NULL,@t,NULL,@c,0,@p,@f,@c,'household')`,
  ).run({ '@id': `c_${slug}`, '@t': title, '@c': captured_at, '@p': note_path, '@f': JSON.stringify(fm) });
}
seed3q('q-rose-a', 'Quarantined rose junk a', g_rose_body('junk a'), at(4));
seed3q('q-rose-b', 'Quarantined rose junk b', g_rose_body('junk b'), at(5));
seed3q('q-rose-c', 'Quarantined rose junk c', g_rose_body('junk c'), at(6));

const FAB = 'Mars 2099';
const fab_body =
  'Pruning roses in late winter above an outward facing bud encourages airflow and is the consistent recommendation across these notes. ' +
  `The Rose Festival on ${FAB} was the highlight of the season. ` +
  'Removing dead rose wood and crossing canes keeps the bush open and reduces disease pressure over the whole season.';
const fab_distill: Distiller = async () => fab_body; // ignores regrounding → correction still carries the fab
const flag_fab: SynthesisAssessor = async (prose) => (prose.includes(FAB) ? [finding(FAB)] : []);

const runGate = await synthesize_shelves(
  { library_deps: library_deps3, distill_fn: fab_distill, assess_fn: flag_fab },
  { now: NOON },
);
check('gate e2e: the fabricated topic is REDUCED (1), not shelved verbatim', runGate.grounding_reduced === 1 && runGate.syntheses_written === 1);
const gate_note = runGate.notes.map((p) => memory3.read_note(p)!)[0];
check(
  'gate e2e: shelved synthesis is stamped grounding_outcome=reduced + derived',
  !!gate_note &&
    (gate_note.frontmatter as Record<string, unknown>).grounding_outcome === 'reduced' &&
    (gate_note.frontmatter as Record<string, unknown>).derived === true,
);
check('gate e2e: the fabrication is ABSENT from the shelved note', !!gate_note && !gate_note.body.includes(FAB));
check('gate e2e: the grounded content survives', !!gate_note && gate_note.body.includes('Pruning roses'));
check(
  'quarantine items are EXCLUDED from synthesis input (only the 3 real roses cited)',
  !!gate_note &&
    ((gate_note.frontmatter as Record<string, unknown>).synthesized_from as string[]).length === 3 &&
    !((gate_note.frontmatter as Record<string, unknown>).synthesized_from as string[]).some((p) => p.includes('_quarantine')),
);
const ga = db3.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name='synthesis_grounding'`).get() as { n: number };
check('gate e2e: a synthesis_grounding audit row was written', ga.n >= 1);
db3.close();
rmSync(dir3, { recursive: true, force: true });

// ------------------------------------------------------------------
// 5d. score_synthesis — the deterministic health/worthiness score (unit)
// ------------------------------------------------------------------
{
  const strong = score_synthesis({ grounding_outcome: 'clean', source_count: 6, trust_tiers: [1, 1, 1, 1, 1, 1], age_days: 0, sources_present: 6, retrieval_hits: 10 });
  check('score strong: clean + Tier-1 breadth + used', strong.grade === 'strong' && strong.health >= 0.9 && strong.worth >= 0.9);
}
{
  const sound = score_synthesis({ grounding_outcome: 'clean', source_count: 3, trust_tiers: [null, null, null], age_days: 0, sources_present: 3 });
  check('score sound: clean but thin/untiered, usage unknown → neutral worth', sound.grade === 'sound' && sound.worth === 0.5);
}
{
  const weak = score_synthesis({ grounding_outcome: 'reduced', source_count: 2, trust_tiers: [null, null], age_days: 100, sources_present: 2 });
  check('score weak: reduced grounding + thin + aging', weak.grade === 'weak');
}
{
  const rotting = score_synthesis({ grounding_outcome: 'clean', source_count: 4, trust_tiers: [1, 1, 1, 1], age_days: 0, sources_present: 1 });
  check('score rotting: integrity collapse (deleted sources) forces rotting', rotting.grade === 'rotting' && rotting.reasons.some((r) => r.includes('rotting')));
}
{
  const fresh = score_synthesis({ grounding_outcome: 'clean', source_count: 4, trust_tiers: [1, 1, 1, 1], age_days: 0, sources_present: 4 });
  const stale = score_synthesis({ grounding_outcome: 'clean', source_count: 4, trust_tiers: [1, 1, 1, 1], age_days: 200, sources_present: 4 });
  check('score: staleness decays health + is flagged', stale.health < fresh.health && stale.reasons.some((r) => r.includes('stale')));
}
{
  const unused = score_synthesis({ grounding_outcome: 'clean', source_count: 4, trust_tiers: [1, 1, 1, 1], age_days: 0, sources_present: 4, retrieval_hits: 0 });
  check('score: zero retrieval hits → worth 0 + flagged', unused.worth === 0 && unused.reasons.some((r) => r.includes('never retrieved')));
}
{
  const a = score_synthesis({ grounding_outcome: 'corrected', source_count: 5, trust_tiers: [1, 2, null, 1, 2], age_days: 45, sources_present: 4 });
  const b = score_synthesis({ grounding_outcome: 'corrected', source_count: 5, trust_tiers: [1, 2, null, 1, 2], age_days: 45, sources_present: 4 });
  check('score is deterministic (same inputs → same score)', JSON.stringify(a) === JSON.stringify(b));
}

// ------------------------------------------------------------------
// 6. Fail-open + kill switch — on a fresh db so state is clean
// ------------------------------------------------------------------
const dir2 = mkdtempSync(join(tmpdir(), 'hearth-synth2-'));
const db2 = open_db(join(dir2, 'smoke.db'));
const memory2 = new MemoryClient({ vault_root: join(dir2, 'vault'), db: db2 });
const library_deps2: LibraryRoutesDeps = { ...library_deps, db: db2, vault_root: join(dir2, 'vault'), memory: memory2 };

function seed2(slug: string, title: string, body: string, captured_at: string): void {
  const note_path = `Knowledge/Eleanor/library/${slug}.md`;
  const fm = { type: 'clipping', id: `c_${slug}`, kind: 'url', source: 'url', title, captured_at, reviewed: false, tags: [], specialist_scope: 'eleanor', private_to: 'household' };
  memory2.upsert_note(note_path, fm, body);
  db2.prepare(
    `INSERT INTO clippings (id, kind, source, source_url, title, attachment_path, captured_at, reviewed, note_path, frontmatter_json, mtime, private_to)
     VALUES (@id,'url','url',NULL,@t,NULL,@c,0,@p,@f,@c,'household')`,
  ).run({ '@id': `c_${slug}`, '@t': title, '@c': captured_at, '@p': note_path, '@f': JSON.stringify(fm) });
}
const rose_body = (extra: string) =>
  `Prune roses in late winter. Cut rose canes above an outward facing bud. Remove dead rose ` +
  `wood for better airflow and shape across the rose bush. ${extra}`;
seed2('rose-a', 'Rose pruning basics', rose_body('Start with the oldest canes.'), at(1));
seed2('rose-b', 'Rose pruning timing', rose_body('Finish before bud break.'), at(2));
seed2('rose-c', 'Rose pruning cuts', rose_body('Angle each cut cleanly.'), at(3));

const null_distill: Distiller = async () => null;
const runFail = await synthesize_shelves({ library_deps: library_deps2, distill_fn: null_distill }, { now: NOON });
check('fail-open: a distiller outage skips topics, never throws', runFail.enabled && runFail.syntheses_written === 0);
check('fail-open: the skipped topic is counted as a distill failure', runFail.distill_failures >= 1);

process.env.HEARTH_SHELF_SYNTHESIS = '0';
const runKill = await synthesize_shelves({ library_deps: library_deps2, distill_fn: mock_distill }, { now: NOON, force: true });
check('kill switch disables the pass (enabled:false, nothing written)', !runKill.enabled && runKill.syntheses_written === 0 && runKill.skipped_reason !== undefined);
delete process.env.HEARTH_SHELF_SYNTHESIS;

// ------------------------------------------------------------------
await specialists.close();
db.close();
db2.close();
rmSync(dir, { recursive: true, force: true });
rmSync(dir2, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\nsmoke:shelf-synthesis OK'
    : `\nsmoke:shelf-synthesis FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
