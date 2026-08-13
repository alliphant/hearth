/**
 * GET /api/specialists/:id/brain — Cordelia's "Second Brain" office tab feed.
 *
 * The whole synthesis layer as one navigable graph: every shelf's distilled
 * `synthesis_note` (Knowledge/<Spec>/library/_synthesis/*.md), grouped by shelf,
 * each carrying its live health score, its grounding verdict, its sources, and
 * its prose split into individual FACTS — so the web/iOS/macOS canvas can zoom
 * galaxy → shelf → synthesis → fact with provenance.
 *
 * Hosted on Cordelia's office (she weaves it) but the data spans ALL shelves.
 * Gated on `write_vault_any_library` — the Cordelia-only capability that lets
 * her synthesize across every shelf, so whoever can WRITE the brain can VIEW
 * it (no new token needed). OWNER-only on top (the synthesis layer is private).
 * Every node is additionally cordon-filtered with `note_visible_to_caller` —
 * even the owner never sees another user's private synthesis (no god-view).
 *
 * Health is computed LIVE here (not just read from the write-time stamp): real
 * age (freshness) + a source-existence check (integrity) means the view always
 * reflects CURRENT decay, and even pre-scorer notes show a grade. This is the
 * read-time re-score the self-governing loop's design calls for.
 *
 * Mounted at app.route('/api/specialists', …) — an EXISTING namespace, so no
 * nginx alternation change is needed.
 */
import { Hono } from 'hono';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { Tier } from '@core/users';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import { score_synthesis, type GroundingOutcome, type HealthGrade } from '@core/synthesis_health';
import { capitalize } from '@core/loops';
import { demand_tokens, mine_knowledge_demand } from '@core/knowledge_demand';
import { unpack_f32, cosine } from '@core/embeddings';

export interface BrainRouterDeps {
  db: Database;
  memory: MemoryClient;
  vault_root: string;
  specialists: SpecialistRegistry;
}

interface BrainSourceRef {
  path: string;
  title: string;
  present: boolean;
}

interface BrainNode {
  id: string;
  shelf: string;
  shelf_name: string;
  topic: string;
  title: string;
  grounding_outcome: GroundingOutcome | null;
  grounding_flagged: number;
  health_score: number;
  health_grade: HealthGrade;
  health_reasons: string[];
  /** Worth axis (0..1) — retrieval usage; 0.5 neutral until first retrieved. */
  worth: number;
  /** Times this synthesis has been retrieved into a turn's top-k. */
  usage_hits: number;
  /** ISO of the most recent retrieval, or null if never retrieved. */
  last_retrieved_at: string | null;
  private_to: string | null;
  age_days: number;
  source_count: number;
  sources: BrainSourceRef[];
  facts: Array<{ text: string; sources: number[] }>;
  prose: string;
  synthesized_at: string | null;
}

interface BrainSourceNode {
  path: string;
  title: string;
  shelf: string;
  present: boolean;
  used_by: string[];
}

/** A cross-shelf relationship between two syntheses — what makes the brain a
 *  MESH, not a stack of per-shelf summaries. `kind` records how it was found:
 *  SEMANTIC (embedding cosine — surprising, meaning-level links) when both
 *  syntheses carry stored vectors, else LEXICAL (token overlap) as the fallback.
 *  Both are deterministic + re-verify on a re-scan; neither hallucinates an edge
 *  the way an LLM edge-miner would. */
interface BrainConnection {
  a: string;
  b: string;
  weight: number;
  kind: 'semantic' | 'lexical';
}

/** A synthesis's vector = the average of its stored chunk embeddings (a
 *  synthesis is usually one chunk). Null when the corpus isn't embedded
 *  (HEARTH_RAG_VECTOR off, or not yet backfilled) → the pair falls back to
 *  lexical overlap. Sync, opportunistic — never a load-bearing dependency. */
function node_embedding(db: Database, note_path: string): Float32Array | null {
  const rows = db
    .prepare(`SELECT embedding FROM chunk_embeddings WHERE note_path = @p`)
    .all({ '@p': note_path }) as Array<{ embedding: Uint8Array }>;
  if (rows.length === 0) return null;
  let acc: Float32Array | null = null;
  for (const r of rows) {
    const v = unpack_f32(r.embedding);
    if (v.length === 0) continue;
    if (!acc) acc = new Float32Array(v.length);
    if (v.length !== acc.length) continue;
    for (let i = 0; i < acc.length; i++) acc[i]! += v[i]!;
  }
  return acc; // un-normalized average — cosine normalizes
}

/**
 * Mine cross-shelf links: for every pair of syntheses on DIFFERENT shelves,
 * SELF-AGGREGATE by relatedness — embedding cosine when both are vectorized
 * (meaning-level: "battery degradation" ↔ "winter range" with no shared words),
 * else token overlap. Above the bar, an edge — a vet-bill cost note (Vivian)
 * tying to a pet-health note (Anya). Capped per node + globally so the canvas
 * stays a constellation, not a hairball (the cap, not the threshold, is the
 * safety — only each node's strongest few survive). Same-shelf adjacency is
 * skipped (a shelf is already one lobe). Threshold tunable:
 * HEARTH_BRAIN_SEMANTIC_MIN (default 0.62).
 */
function compute_cross_shelf_links(db: Database, nodes: BrainNode[]): BrainConnection[] {
  const LEXICAL_MIN = 0.25;
  const semantic_min_raw = Number.parseFloat(process.env.HEARTH_BRAIN_SEMANTIC_MIN ?? '');
  const SEMANTIC_MIN = Number.isFinite(semantic_min_raw) ? semantic_min_raw : 0.62;
  const PER_NODE = 2;
  const GLOBAL_CAP = 30;
  const toks = nodes.map((n) => demand_tokens(`${n.topic} ${n.prose}`));
  const embs = nodes.map((n) => node_embedding(db, n.id)); // n.id === note_path
  const edges: BrainConnection[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const ni = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j++) {
      const nj = nodes[j]!;
      if (ni.shelf === nj.shelf) continue; // cross-shelf only
      const ea = embs[i];
      const eb = embs[j];
      let w: number;
      let kind: 'semantic' | 'lexical';
      let min: number;
      if (ea && eb) {
        w = cosine(ea, eb);
        kind = 'semantic';
        min = SEMANTIC_MIN;
      } else {
        const a = toks[i]!;
        const b = toks[j]!;
        if (a.size === 0 || b.size === 0) continue;
        const [small, large] = a.size <= b.size ? [a, b] : [b, a];
        let inter = 0;
        for (const t of small) if (large.has(t)) inter++;
        w = inter / small.size;
        kind = 'lexical';
        min = LEXICAL_MIN;
      }
      if (w >= min) edges.push({ a: ni.id, b: nj.id, weight: Math.round(w * 100) / 100, kind });
    }
  }
  // Strongest first; keep at most PER_NODE per node and GLOBAL_CAP total.
  edges.sort((x, y) => y.weight - x.weight);
  const per = new Map<string, number>();
  const kept: BrainConnection[] = [];
  for (const e of edges) {
    if (kept.length >= GLOBAL_CAP) break;
    const ca = per.get(e.a) ?? 0;
    const cb = per.get(e.b) ?? 0;
    if (ca >= PER_NODE || cb >= PER_NODE) continue;
    kept.push(e);
    per.set(e.a, ca + 1);
    per.set(e.b, cb + 1);
  }
  return kept;
}

const GROUNDING = new Set(['clean', 'corrected', 'reduced']);

/** The "what we know" prose — between the `# … — what we know` heading and the
 *  `## Sources` block. */
function extract_prose(body: string): string {
  const after_heading = body.replace(/^#[^\n]*\n+/, '');
  const before_sources = after_heading.split(/\n##\s+sources/i)[0] ?? after_heading;
  return before_sources.trim();
}

/** Prose → individual facts (sentences). The atom the canvas zooms to. */
function split_facts(prose: string): string[] {
  return prose
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3)
    .slice(0, 40);
}

/**
 * Per-fact provenance (v2): for each fact, the source indices (into the node's
 * own `sources`) whose body+title it best overlaps — deterministic token
 * containment, no LLM, reproducible. This is what lets the canvas draw a ray
 * from ONE fact to the specific source(s) that ground it, instead of lighting
 * every source the synthesis used.
 */
function fact_provenance(
  facts: string[],
  src_tokens: Array<Set<string>>,
): Array<{ text: string; sources: number[] }> {
  return facts.map((text) => {
    const ft = demand_tokens(text);
    if (ft.size === 0) return { text, sources: [] };
    const scored = src_tokens
      .map((st, i) => {
        if (st.size === 0) return { i, ov: 0 };
        let inter = 0;
        for (const t of ft) if (st.has(t)) inter++;
        return { i, ov: inter / ft.size };
      })
      .filter((x) => x.ov >= 0.25)
      .sort((a, b) => b.ov - a.ov);
    return { text, sources: scored.slice(0, 3).map((x) => x.i) };
  });
}

function as_grade_key(g: HealthGrade): keyof BrainGraph['metrics']['by_grade'] {
  return g;
}

/** A demand-ledger gap (v2 "gaps as voids") — what the brain is hungry to
 *  learn on a shelf, surfaced as a dark void near that lobe. */
interface BrainGap {
  shelf: string;
  label: string;
  evidence: number;
  trend: 'growing' | 'steady' | 'declining' | 'new';
  sample: string;
}

export interface BrainGraph {
  generated_at: string;
  metrics: {
    syntheses: number;
    source_links: number;
    fabrications_caught: number;
    cross_shelf_links: number;
    shelves: number;
    /** Syntheses retrieved into a turn at least once (the worth signal). */
    valued: number;
    by_grade: { strong: number; sound: number; weak: number; rotting: number };
  };
  shelves: Array<{ id: string; name: string; count: number }>;
  nodes: BrainNode[];
  source_nodes: BrainSourceNode[];
  gaps: BrainGap[];
  connections: BrainConnection[];
}

export function build_brain_graph(
  deps: BrainRouterDeps,
  caller: Caller,
  now: Date = new Date(),
): BrainGraph {
  const nodes: BrainNode[] = [];
  const shelf_counts = new Map<string, { name: string; count: number }>();
  const source_index = new Map<string, BrainSourceNode>();

  for (const spec of deps.specialists.list()) {
    const ns = capitalize(spec.id);
    const synth_rel = `Knowledge/${ns}/library/_synthesis`;
    const synth_abs = resolve(deps.vault_root, synth_rel);
    if (!existsSync(synth_abs)) continue;
    let files: string[];
    try {
      files = readdirSync(synth_abs).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const f of files) {
      const note_path = `${synth_rel}/${f}`;
      const note = deps.memory.read_note(note_path);
      if (!note) continue;
      const fm = note.frontmatter as Record<string, unknown>;
      if (fm.type !== 'synthesis_note') continue;

      // Cordon — even the owner never sees another user's private synthesis.
      const private_to = typeof fm.private_to === 'string' ? fm.private_to : undefined;
      if (!note_visible_to_caller(private_to, caller)) continue;

      const outcome: GroundingOutcome | null =
        typeof fm.grounding_outcome === 'string' && GROUNDING.has(fm.grounding_outcome)
          ? (fm.grounding_outcome as GroundingOutcome)
          : null;
      const synthesized_from = Array.isArray(fm.synthesized_from)
        ? (fm.synthesized_from.filter((p) => typeof p === 'string') as string[])
        : [];
      const synthesized_at = typeof fm.synthesized_at === 'string' ? fm.synthesized_at : null;

      // Resolve sources for title + LIVE trust/integrity inputs.
      const sources: BrainSourceRef[] = [];
      const trust_tiers: Array<1 | 2 | null> = [];
      const src_tokens: Array<Set<string>> = [];
      let present_count = 0;
      for (const sp of synthesized_from) {
        const src = deps.memory.read_note(sp);
        const present = src !== null;
        if (present) present_count++;
        const sfm = (src?.frontmatter ?? {}) as Record<string, unknown>;
        const stitle = typeof sfm.title === 'string' ? sfm.title : sp.split('/').pop() ?? sp;
        const tt = sfm.trust_tier;
        trust_tiers.push(tt === 1 || tt === 2 ? tt : null);
        src_tokens.push(demand_tokens(`${stitle} ${src?.body ?? ''}`));
        sources.push({ path: sp, title: stitle, present });

        const sn = source_index.get(sp) ?? {
          path: sp,
          title: stitle,
          shelf: spec.id,
          present,
          used_by: [],
        };
        sn.used_by.push(note_path);
        source_index.set(sp, sn);
      }

      const age_days = synthesized_at
        ? Math.max(0, (now.getTime() - Date.parse(synthesized_at)) / 86_400_000)
        : 0;
      // Worth axis (loop Phase B): real retrieval usage, recency-weighted.
      const usage = deps.memory.get_synthesis_usage([note_path]).get(note_path);
      const last_retrieval_age_days = usage?.last_retrieved_at
        ? Math.max(0, (now.getTime() - Date.parse(usage.last_retrieved_at)) / 86_400_000)
        : undefined;
      const health = score_synthesis({
        grounding_outcome: outcome ?? 'clean',
        source_count: synthesized_from.length,
        trust_tiers,
        age_days,
        sources_present: present_count,
        ...(usage ? { retrieval_hits: usage.hits, last_retrieval_age_days } : {}),
      });

      const prose = extract_prose(note.body);
      const facts = fact_provenance(split_facts(prose), src_tokens);
      const node: BrainNode = {
        id: note_path,
        shelf: spec.id,
        shelf_name: spec.name,
        topic: typeof fm.topic_label === 'string' ? fm.topic_label : f.replace(/\.md$/, ''),
        title: typeof fm.title === 'string' ? fm.title : f.replace(/\.md$/, ''),
        grounding_outcome: outcome,
        grounding_flagged: typeof fm.grounding_flagged === 'number' ? fm.grounding_flagged : 0,
        health_score: health.score,
        health_grade: health.grade,
        health_reasons: health.reasons,
        worth: health.worth,
        usage_hits: usage?.hits ?? 0,
        last_retrieved_at: usage?.last_retrieved_at ?? null,
        private_to: private_to ?? null,
        age_days: Math.round(age_days * 10) / 10,
        source_count: synthesized_from.length,
        sources,
        facts,
        prose,
        synthesized_at,
      };
      nodes.push(node);

      const sc = shelf_counts.get(spec.id) ?? { name: spec.name, count: 0 };
      sc.count++;
      shelf_counts.set(spec.id, sc);
    }
  }

  const connections = compute_cross_shelf_links(deps.db, nodes);
  const by_grade = { strong: 0, sound: 0, weak: 0, rotting: 0 };
  let source_links = 0;
  let fabrications_caught = 0;
  let valued = 0;
  for (const n of nodes) {
    by_grade[as_grade_key(n.health_grade)]++;
    source_links += n.source_count;
    if (n.usage_hits > 0) valued++;
    if (n.grounding_outcome === 'corrected' || n.grounding_outcome === 'reduced') {
      fabrications_caught++;
    }
  }

  // Gaps-as-voids (v2): the demand ledger's view of what the brain is HUNGRY to
  // learn per shelf (rag-low-confidence + empty searches), cordon-filtered — a
  // gap whose evidence is all from one non-owner user is theirs, not the owner's.
  const owner_id = caller.tier === 'owner' ? caller.user_id : undefined;
  let gaps: BrainGap[] = [];
  try {
    const demand = mine_knowledge_demand(deps.db, { window_days: 30, now, max_topics: 40 });
    gaps = demand.topics
      .filter((t) => t.specialist_id)
      .filter((t) => !t.sole_user_id || t.sole_user_id === owner_id)
      .slice(0, 14)
      .map((t) => ({
        shelf: t.specialist_id as string,
        label: t.label,
        evidence: t.evidence_count,
        trend: t.trend_direction,
        sample: t.sample_texts[0] ?? '',
      }));
  } catch {
    gaps = [];
  }

  return {
    generated_at: now.toISOString(),
    metrics: {
      syntheses: nodes.length,
      source_links,
      fabrications_caught,
      cross_shelf_links: connections.length,
      shelves: shelf_counts.size,
      valued,
      by_grade,
    },
    shelves: [...shelf_counts.entries()]
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count),
    nodes,
    source_nodes: [...source_index.values()],
    gaps,
    connections,
  };
}

export function create_brain_router(deps: BrainRouterDeps): Hono {
  const r = new Hono();

  r.get('/:id/brain', (c) => {
    const user = c.get('user') as { id?: string; tier?: Tier } | undefined;
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    if (user.tier !== 'owner') return c.json({ error: 'owner only' }, 403);
    const id = c.req.param('id');
    const host = deps.specialists.get(id);
    if (!host || !host.granted.has('write_vault_any_library')) {
      return c.json({ error: 'no synthesis brain for this specialist' }, 404);
    }
    const graph = build_brain_graph(deps, { user_id: user.id, tier: user.tier });
    return c.json(graph);
  });

  return r;
}
