/**
 * person_relations — the relationship-and-role layer of the Household Knowledge
 * Graph (2026-06-22, Phase 0 of the People reasoning substrate).
 *
 * A person note's `relations` frontmatter is the AUTHORITATIVE truth ("Rosa
 * is Sam's hairdresser"; "Rachel works at the salon"). This module is
 * the pure glue that turns those entries into typed `relates-to` edges in the
 * existing `knowledge_edges` store (NOT a parallel table — relationships are
 * just a new SOURCE feeding the one graph that goods/life-events already use),
 * and reads them back for the Friends card + Kate's `who_is`.
 *
 * Design contracts (mirroring the rest of the graph):
 *   - TOLD-FIRST + provenance-tagged. Every edge records told|observed|inferred
 *     (Phase 0 authors only `told`), so the owner can SEE what Kate believes vs
 *     guessed. Provenance rides `knowledge_edges.source` as a `<prov>:<ref>`
 *     prefix — no schema column added to the shared store.
 *   - PREDICATES ARE FREE-TEXT, not a frozen enum ("hairdresser", "daughter",
 *     "works at", "my salon"). The graph treats an edge as a labeled directed
 *     link; the role lives in `context`; reasoning reads the label. (The
 *     repo's "enable success, don't enumerate failures" rule.)
 *   - BACKWARD-COMPATIBLE. The legacy `{name, relation, birthday}` relation
 *     entry (what person_enrichment already writes) normalizes cleanly.
 *   - PURE. No db/LLM — resolution is injected, so it unit-tests with no I/O.
 */
import { basename } from 'node:path';
import type { EdgeUpsert, KnowledgeEdge } from '@memory/stores/knowledge_edges';

export const RELATES_TO = 'relates-to' as const;

export type RelationProvenance = 'told' | 'observed' | 'inferred';
const PROVENANCES = new Set<RelationProvenance>(['told', 'observed', 'inferred']);

export type EntityKind = 'person' | 'place';

/** A relation as the model/UI emits it, normalized to one canonical shape. */
export interface NormalizedRelation {
  /** Display name / token of the OTHER entity ("Rosa Ito", "the salon"). */
  to: string;
  to_kind: EntityKind;
  /** The human role/tie, lowercased + trimmed for edge-context consistency. */
  predicate: string;
  provenance: RelationProvenance;
  confidence: number;
  /** Optional asserting source — conversation/mail/capture id. */
  source_ref?: string;
}

// ── provenance ↔ knowledge_edges.source codec ───────────────────────────────

/** Encode provenance (+ optional ref) into the edge's `source` string. */
export function make_edge_source(provenance: RelationProvenance, ref?: string): string {
  return ref && ref.trim() ? `${provenance}:${ref.trim()}` : provenance;
}

/** Decode an edge's `source` into provenance + ref. Unprefixed → `told`
 *  (Phase 0 only authors told; a future observed/inferred carries its prefix). */
export function parse_edge_provenance(source: string | null | undefined): {
  provenance: RelationProvenance;
  ref: string | null;
} {
  const s = (source ?? '').trim();
  const m = s.match(/^(told|observed|inferred)(?::(.*))?$/);
  if (m) return { provenance: m[1] as RelationProvenance, ref: m[2]?.trim() || null };
  return { provenance: 'told', ref: s || null };
}

// ── normalization ───────────────────────────────────────────────────────────

function as_str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function as_kind(v: unknown): EntityKind | undefined {
  const s = as_str(v)?.toLowerCase();
  return s === 'place' || s === 'person' ? s : undefined;
}
function as_provenance(v: unknown): RelationProvenance | undefined {
  const s = as_str(v)?.toLowerCase() as RelationProvenance | undefined;
  return s && PROVENANCES.has(s) ? s : undefined;
}

/**
 * Normalize one `relations` entry into the canonical shape, tolerating both the
 * legacy `{name, relation, birthday}` form and the richer
 * `{to|target, to_kind|target_kind, predicate|role|relation, provenance,
 *   confidence, source}` form. Returns null when there's no usable target.
 */
export function normalize_relation(raw: unknown): NormalizedRelation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const to = as_str(o.to) ?? as_str(o.target) ?? as_str(o.name) ?? as_str(o.who);
  if (!to) return null;
  const predicate =
    as_str(o.predicate) ?? as_str(o.role) ?? as_str(o.relation) ?? as_str(o.relationship) ?? 'related';
  const conf = typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : 1;
  return {
    to,
    to_kind: as_kind(o.to_kind) ?? as_kind(o.target_kind) ?? as_kind(o.kind) ?? 'person',
    predicate: predicate.toLowerCase().trim(),
    provenance: as_provenance(o.provenance) ?? 'told',
    confidence: conf,
    source_ref: as_str(o.source_ref) ?? as_str(o.source),
  };
}

// ── projection: a note's relations → knowledge_edges upserts ────────────────

/**
 * Build the `relates-to` edge upserts for ONE person note's `relations`.
 * `resolve(name, kind)` maps a target name to a stable ref — a vault note_path
 * when it resolves, else the raw name token (the graph stores free refs, so an
 * un-created "the salon" is still a queryable edge endpoint).
 *
 * Dedups on the target ref: the edge PK is (from_ref, to_ref, kind), so at most
 * one relates-to edge per (subject, target) pair — re-asserting a different role
 * updates it (last-write-wins on `context`). Self-edges are dropped.
 */
export function relation_edges_for(
  fm: Record<string, unknown>,
  from_ref: string,
  private_to: string,
  resolve: (name: string, kind: EntityKind) => string,
): EdgeUpsert[] {
  const rels = Array.isArray(fm.relations) ? fm.relations : [];
  const out: EdgeUpsert[] = [];
  const seen = new Set<string>();
  for (const raw of rels) {
    const n = normalize_relation(raw);
    if (!n) continue;
    const to_ref = resolve(n.to, n.to_kind);
    if (!to_ref || to_ref === from_ref || seen.has(to_ref)) continue;
    seen.add(to_ref);
    out.push({
      from_ref,
      to_ref,
      kind: RELATES_TO,
      context: n.predicate,
      confidence: n.confidence,
      source: make_edge_source(n.provenance, n.source_ref),
      private_to,
    });
  }
  return out;
}

// ── read: edges → display views ─────────────────────────────────────────────

export interface RelationshipView {
  /** Display name of the OTHER endpoint. */
  with: string;
  with_kind: EntityKind;
  /** The role/tie label. */
  role: string;
  /** Relative to the subject this view was assembled for. */
  direction: 'outgoing' | 'incoming';
  provenance: RelationProvenance;
  confidence: number;
}

/** Resolve an edge ref to a display name + kind, given path→name maps for known
 *  people/places. Falls back to the note basename, then the raw token. */
export function display_for_ref(
  ref: string,
  people_by_path: Map<string, string>,
  places_by_path: Map<string, string>,
): { name: string; kind: EntityKind } {
  const p = people_by_path.get(ref);
  if (p) return { name: p, kind: 'person' };
  const pl = places_by_path.get(ref);
  if (pl) return { name: pl, kind: 'place' };
  if (/^People\//i.test(ref)) return { name: basename(ref).replace(/\.md$/i, ''), kind: 'person' };
  if (/^Places\//i.test(ref)) return { name: basename(ref).replace(/\.md$/i, ''), kind: 'place' };
  return { name: ref, kind: 'person' };
}

/**
 * Assemble the relationship views for a subject from the edges touching it.
 * `self_ref` is the subject's own ref (note_path); `display(ref)` resolves the
 * OTHER endpoint. Sorted: told before inferred, then by role.
 */
export function assemble_relationships(
  self_ref: string,
  edges: KnowledgeEdge[],
  display: (ref: string) => { name: string; kind: EntityKind },
): RelationshipView[] {
  const out: RelationshipView[] = [];
  for (const e of edges) {
    const other_ref = e.from_ref === self_ref ? e.to_ref : e.from_ref;
    const { name, kind } = display(other_ref);
    const { provenance } = parse_edge_provenance(e.source);
    out.push({
      with: name,
      with_kind: kind,
      role: e.context ?? 'related',
      direction: e.from_ref === self_ref ? 'outgoing' : 'incoming',
      provenance,
      confidence: e.confidence,
    });
  }
  const rank: Record<RelationProvenance, number> = { told: 0, observed: 1, inferred: 2 };
  out.sort((a, b) => rank[a.provenance] - rank[b.provenance] || a.role.localeCompare(b.role));
  return out;
}
