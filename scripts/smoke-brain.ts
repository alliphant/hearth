/**
 * smoke:brain — self-contained test of the Second Brain office-tab feed
 * (GET /api/specialists/:id/brain) + the build_brain_graph builder.
 *
 * Temp vault + db + registry; seeds synthesis notes (real frontmatter shape)
 * across a shelf and asserts: live health computed (grade present even with no
 * stamped score), per-fact extraction, source provenance (used_by + present),
 * the cordon (a private_to:<user> synthesis is hidden even from the owner),
 * fabrications_caught from grounding verdicts, integrity collapse → rotting,
 * and the route's owner / capability gating.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { build_brain_graph, create_brain_router } from '../src/app/routes/brain';
import { score_synthesis } from '../src/core/synthesis_health';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-brain-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'cordelia.yaml'),
  `id: cordelia
name: Cordelia
role: Librarian
voice: warm
persona: Test fixture persona, long enough to satisfy the loader.
proactive:
  mode: reactive
capabilities:
  write_vault_any_library: true
`,
);
writeFileSync(
  join(spec_dir, 'eleanor.yaml'),
  `id: eleanor
name: Eleanor
role: Garden
voice: warm
persona: Test fixture persona, long enough to satisfy the loader.
proactive:
  mode: reactive
`,
);
const specialists = new SpecialistRegistry(spec_dir);

const NOW = new Date('2026-06-14T22:00:00Z');
const iso = (d: Date) => d.toISOString();

// ── source notes (Eleanor's raw shelf) ─────────────────────────────────────
function seed_source(slug: string, title: string, tier?: 1 | 2, body?: string): string {
  const p = `Knowledge/Eleanor/library/${slug}.md`;
  const fm: Record<string, unknown> = { type: 'clipping', title, specialist_scope: 'eleanor' };
  if (tier) fm.trust_tier = tier;
  memory.upsert_note(p, fm, body ?? `${title}. Some grounded body content for ${slug}.`);
  return p;
}
// Topical source bodies so per-fact provenance (token overlap) has real signal.
const S = {
  tomA: seed_source('tom-a', 'Tomato blight basics', 1, 'Copper fungicide application slowed the early blight effectively on tomato plants this season.'),
  tomB: seed_source('tom-b', 'Early blight', 1, 'Base-only watering at the soil line helped reduce blight spread between plants.'),
  tomC: seed_source('tom-c', 'Leaf spot', 1, 'Remove infected leaves promptly to reduce the fungal spread across the bed.'),
  dripA: seed_source('drip-a', 'Drip schedule', 2),
  dripB: seed_source('drip-b', 'Emitter spacing'),
  compA: seed_source('comp-a', 'Compost bin'),
};
// A demand-ledger signal so gaps-as-voids surfaces a void on Eleanor's shelf.
memory.log_action({
  intent_id: 'demand-1',
  agent: 'eleanor',
  tool_name: 'rag_low_confidence',
  tool_input: { query_preview: 'rare orchid root rot fungal treatment options' },
  user_id: 'jasper',
});

// ── synthesis notes ────────────────────────────────────────────────────────
function seed_synth(o: {
  slug: string;
  topic: string;
  outcome: 'clean' | 'corrected' | 'reduced';
  sources: string[];
  prose: string;
  private_to?: string;
  age_days?: number;
}): string {
  const p = `Knowledge/Eleanor/library/_synthesis/${o.slug}.md`;
  const at = new Date(NOW.getTime() - (o.age_days ?? 0) * 86_400_000);
  const fm: Record<string, unknown> = {
    type: 'synthesis_note',
    title: `${o.topic} — synthesis`,
    specialist_scope: 'eleanor',
    topic_label: o.topic,
    synthesized_from: o.sources,
    source_hash: 'h',
    synthesized_at: iso(at),
    derived: true,
    grounding_outcome: o.outcome,
  };
  if (o.private_to) fm.private_to = o.private_to;
  const sources_block = o.sources.map((s) => `- **src** — \`${s}\``).join('\n');
  memory.upsert_note(
    p,
    fm,
    `# ${o.topic} — what we know\n\n${o.prose}\n\n## Sources (${o.sources.length})\n${sources_block}\n`,
  );
  return p;
}

const N_tomato = seed_synth({
  slug: 'shelf-tomato-blight',
  topic: 'tomato blight',
  outcome: 'clean',
  sources: [S.tomA, S.tomB, S.tomC],
  prose: 'Copper fungicide slowed the blight effectively. Base-only watering also helped. Remove infected leaves promptly to reduce spread.',
});
const N_drip = seed_synth({
  slug: 'shelf-drip-irrigation',
  topic: 'drip irrigation',
  outcome: 'reduced',
  sources: [S.dripA, S.dripB],
  prose: 'Drip emitters deliver water slowly at the base. Schedule for early morning to cut evaporation.',
});
seed_synth({
  slug: 'sam-rose-care',
  topic: 'rose care',
  outcome: 'clean',
  sources: [S.compA],
  prose: 'Prune roses in late winter above an outward facing bud.',
  private_to: 'sam',
});
const N_rot = seed_synth({
  slug: 'household-compost-rot',
  topic: 'compost rot',
  outcome: 'clean',
  // 4 cited, only compA exists → integrity collapse
  sources: [S.compA, 'Knowledge/Eleanor/library/gone-1.md', 'Knowledge/Eleanor/library/gone-2.md', 'Knowledge/Eleanor/library/gone-3.md'],
  prose: 'Kitchen scraps and leaf litter break down into rich humus over a season.',
});

// #2 worth instrument: simulate the read path retrieving the tomato synthesis
// eight times (drip + compost stay unretrieved → neutral worth). Eight hits →
// worth 0.8, which with its already-high health promotes the node to 'strong'.
for (let i = 0; i < 8; i++) memory.record_synthesis_retrievals([N_tomato], iso(NOW));

// ── 1. build_brain_graph — owner caller ────────────────────────────────────
const owner = { user_id: 'jasper', tier: 'owner' as const };
const g = build_brain_graph({ db, memory, vault_root, specialists }, owner, NOW);

check('graph returns nodes', g.nodes.length > 0);
check('cordon: sam-private synthesis is hidden from the owner', !g.nodes.some((n) => n.topic === 'rose care'));
check('owner sees the 3 shelf-wide / household-visible syntheses', g.nodes.length === 3);

const tom = g.nodes.find((n) => n.id === N_tomato)!;
check('node carries a LIVE health grade (no stamped score needed)', !!tom && ['strong', 'sound', 'weak', 'rotting'].includes(tom.health_grade));
check('clean + Tier-1 + fresh + well-USED tomato node grades strong (worth lifts it)', !!tom && tom.health_score >= 0.7 && tom.health_grade === 'strong');
check('node extracts individual facts (sentences)', !!tom && tom.facts.length === 3 && tom.facts[0]!.text.includes('Copper'));
check('v2: each fact maps to its OWN grounding source (per-fact provenance)', !!tom && tom.facts[0]!.sources.includes(0) && tom.facts[1]!.sources.includes(1) && tom.facts[2]!.sources.includes(2));
check('node carries its sources, all present', !!tom && tom.source_count === 3 && tom.sources.every((s) => s.present));

const rot = g.nodes.find((n) => n.id === N_rot)!;
check('integrity collapse → rotting grade', !!rot && rot.health_grade === 'rotting');
check('rotting node flags the deleted sources', !!rot && rot.sources.filter((s) => !s.present).length === 3 && rot.health_reasons.some((r) => r.includes('rotting')));

const drip = g.nodes.find((n) => n.id === N_drip)!;
check('reduced synthesis is counted as a caught fabrication', !!drip && drip.grounding_outcome === 'reduced');
check('metrics.fabrications_caught reflects the reduced node', g.metrics.fabrications_caught === 1);
check('metrics: 3 syntheses across 1 shelf', g.metrics.syntheses === 3 && g.metrics.shelves === 1);
check('metrics.by_grade sums to node count', g.metrics.by_grade.strong + g.metrics.by_grade.sound + g.metrics.by_grade.weak + g.metrics.by_grade.rotting === 3);

check('source provenance: a shared source records which syntheses used it', (() => {
  const comp = g.source_nodes.find((s) => s.path === S.compA);
  return !!comp && comp.used_by.includes(N_rot);
})());
check('v2: demand-ledger gaps surface per shelf (gaps-as-voids)', g.gaps.some((x) => x.shelf === 'eleanor' && x.label.length > 0));

// #2 worth instrument: usage feeds the scorer; unretrieved notes stay neutral.
check('worth: retrieved synthesis carries real usage_hits', tom.usage_hits === 8 && typeof tom.last_retrieved_at === 'string');
check('worth: a well-used synthesis scores worth above neutral', tom.worth === 0.8);
check('worth: an unretrieved synthesis stays neutral (0.5, never penalized)', drip.worth === 0.5 && drip.usage_hits === 0 && drip.last_retrieved_at === null);
check('worth: metrics.valued counts only retrieved syntheses', g.metrics.valued === 1);

// self-ranking: recency-weighted worth — same hits, but cold last-use scores
// lower than warm, so the read prior + prune priority track CURRENT value.
{
  const base = { grounding_outcome: 'clean' as const, source_count: 3, trust_tiers: [1, 1, 1] as Array<1 | 2 | null>, age_days: 0, sources_present: 3, retrieval_hits: 8 };
  const warm = score_synthesis({ ...base, last_retrieval_age_days: 2 });
  const cold = score_synthesis({ ...base, last_retrieval_age_days: 120 });
  check('self-ranking: warm usage keeps full worth', warm.worth === 0.8);
  check('self-ranking: cold usage decays worth (same hits)', cold.worth === 0.24 && cold.worth < warm.worth);
  check('self-ranking: cold note is flagged in reasons', cold.reasons.some((r) => r.includes('cold')));
}

// ── 1b. #4 cross-shelf connections — a synthesis on ANOTHER shelf sharing
//        vocabulary with tomato blight should link across shelves ────────────
writeFileSync(
  join(spec_dir, 'iris.yaml'),
  `id: iris
name: Iris
role: Routing
voice: warm
persona: Test fixture persona, long enough to satisfy the loader.
proactive:
  mode: reactive
`,
);
const specialists2 = new SpecialistRegistry(spec_dir);
const N_iris = 'Knowledge/Iris/library/_synthesis/shelf-blight-overlap.md';
memory.upsert_note(
  N_iris,
  {
    type: 'synthesis_note',
    title: 'copper blight — synthesis',
    specialist_scope: 'iris',
    topic_label: 'copper blight watering',
    synthesized_from: [S.tomA],
    synthesized_at: iso(NOW),
    derived: true,
    grounding_outcome: 'clean',
  },
  '# copper blight — what we know\n\nCopper fungicide and base watering reduce blight on infected leaves; remove them promptly to slow spread.\n',
);
const g2 = build_brain_graph({ db, memory, vault_root, specialists: specialists2 }, owner, NOW);
check('#4: overlapping syntheses on DIFFERENT shelves are linked', g2.connections.some((c) => (c.a === N_tomato && c.b === N_iris) || (c.a === N_iris && c.b === N_tomato)));
check('#4: metrics.cross_shelf_links matches the connection count', g2.metrics.cross_shelf_links === g2.connections.length && g2.connections.length >= 1);
check('#4: same-shelf pairs are NOT linked (cross-shelf only)', !g2.connections.some((c) => [N_tomato, N_drip, N_rot].includes(c.a) && [N_tomato, N_drip, N_rot].includes(c.b)));
const findEdge = (g: typeof g2) => g.connections.find((c) => (c.a === N_tomato && c.b === N_iris) || (c.a === N_iris && c.b === N_tomato));
check('#4: with no embeddings the edge is LEXICAL (token-overlap fallback)', findEdge(g2)?.kind === 'lexical');

// #4b self-aggregating: stored embeddings upgrade the edge to SEMANTIC (cosine).
memory.upsert_chunk_embeddings(N_tomato, [{ chunk_idx: 0, embedding: [1, 1, 0, 0] }], 'mock');
memory.upsert_chunk_embeddings(N_iris, [{ chunk_idx: 0, embedding: [1, 1, 1, 0] }], 'mock'); // cosine ≈ 0.82 > 0.62
const g3 = build_brain_graph({ db, memory, vault_root, specialists: specialists2 }, owner, NOW);
check('#4b self-aggregating: with embeddings the cross-shelf edge is SEMANTIC', findEdge(g3)?.kind === 'semantic');
await specialists2.close();

// ── 2. the route — gating ──────────────────────────────────────────────────
let current_user: { id: string; tier: string } | null = { id: 'jasper', tier: 'owner' };
const app = new Hono();
app.use('*', async (c, next) => {
  if (current_user) c.set('user', current_user as never);
  await next();
});
app.route('/api/specialists', create_brain_router({ db, memory, vault_root, specialists }));
const req = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { nodes?: unknown[] }) : null };
};

{
  const { status, body } = await req('/api/specialists/cordelia/brain');
  check('route: owner → 200 with the graph', status === 200 && Array.isArray(body?.nodes));
}
{
  const { status } = await req('/api/specialists/eleanor/brain');
  check('route: host without read_synthesis_brain → 404', status === 404);
}
{
  current_user = { id: 'sam', tier: 'household' };
  const { status } = await req('/api/specialists/cordelia/brain');
  check('route: non-owner tier → 403', status === 403);
}
{
  current_user = null;
  const { status } = await req('/api/specialists/cordelia/brain');
  check('route: unauthenticated → 401', status === 401);
}

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nsmoke:brain OK' : `\nsmoke:brain FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
