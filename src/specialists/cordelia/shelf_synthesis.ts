/**
 * shelf_synthesis — Cordelia's nightly distill pass (consolidation cycle
 * Phase 1, 2026-06-14). The back-half of the knowledge metabolism's first
 * stage: after material is ACQUIRED and SHELVED, this CONSOLIDATES each
 * library shelf's accumulating raw notes into compact, cited, evergreen
 * "what we now know about X" syntheses.
 *
 * Why it earns its keep: a distilled note shelved through the same chunk +
 * embed primitives as every other library item becomes a HIGH-SIGNAL RAG
 * hit the moment it's written — it tends to outrank the raw fragments it
 * summarizes on a topic query. That is the measurable Phase-1 win.
 *
 * The load-bearing safety property is the per-user cordon. A synthesis note
 * NEVER mixes visibility buckets: the pass buckets a shelf's items by their
 * EXACT `private_to` value, clusters + distills WITHIN one bucket only, and
 * stamps the resulting note with that bucket's value. A note built from
 * `private_to: household` sources is stamped `household`; one built from
 * `private_to: <user_id>` sources is stamped that user. Unstamped sources
 * (shelf-wide reference material) produce an unstamped synthesis — which the
 * fail-closed cordon resolves owner-only on read, exactly as its sources do.
 * No cross-bucket combination, full stop: that is the one leak vector, and
 * the conservative default costs us almost nothing.
 *
 * Determinism: clustering is token-overlap grouping (no LLM), reusing the
 * demand-ledger idiom — the same shelf state always yields the same topics,
 * so a re-run verifies rather than reshuffles. Idempotency: a topic whose
 * source set hashes identical to its last synthesis skips the planner LLM.
 *
 * Write-time grounding gate (Phase 1.5): a synthesis is durable, high-signal
 * evidence that future turns ground against, so a fabrication here would
 * LAUNDER into the vault past the read-time fact critic (which trusts
 * retrieved notes). Before shelving, the distilled prose is checked against
 * its OWN sources with the semantic fact critic (assess_factual_grounding,
 * the brief_critic pattern): on findings, one tool-free re-distill grounded
 * in the sources; still flagged → the offending sentences are dropped and the
 * grounded remainder shelved, or the topic is rejected (shelved NOT at all)
 * when too little survives. A confirmed fabrication is never shelved.
 *
 * Selection rides the `clippings` projection (raw library items), which by
 * construction EXCLUDES our own `synthesis_note` output (AUXILIARY, never
 * projected) — so the pass can never re-synthesize its own syntheses.
 *
 * Kill switch: HEARTH_SHELF_SYNTHESIS=0 (returns enabled:false, touches
 * nothing). Deadline-bounded; capped per run for nightly fairness.
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { LoadedSpecialist } from '@core/specialist';
import { capitalize } from '@core/loops';
import { demand_tokens } from '@core/knowledge_demand';
import { assess_factual_grounding, type FactFinding } from '@core/fact_critic';
import { build_grounding_context, build_grounding_evidence } from '@core/provenance';
import { score_synthesis, type GroundingOutcome } from '@core/synthesis_health';
import {
  index_chunks,
  embed_chunks_best_effort,
  type LibraryRoutesDeps,
} from '@app/routes/library';
import { ShelfSynthesisStore } from '@memory/stores/shelf_synthesis';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

export function synthesis_enabled(): boolean {
  return process.env.HEARTH_SHELF_SYNTHESIS !== '0';
}

const DEFAULTS = {
  /** Shelves processed per run — nightly fairness, paired with the deadline. */
  max_shelves: 12,
  /** Most-recent raw items pulled per shelf for clustering. */
  max_items_per_shelf: 200,
  /** A cluster smaller than this isn't worth a synthesis (a single capture
   *  is already the note). */
  min_items_per_topic: 3,
  /** Wall-clock budget for the whole pass. */
  slice_ms: 4 * 60_000,
  /** Body excerpt fed to clustering + the distiller, per source. */
  excerpt_chars: 1500,
} as const;

/** Token-overlap threshold for two items to share a topic cluster (same
 *  coefficient the demand ledger uses). */
const CLUSTER_OVERLAP = 0.5;

/** The sentinel bucket key for unstamped (shelf-wide) items — distinct from
 *  any real `private_to` string. */
const UNSTAMPED = '∅'; // ∅

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface ShelfItem {
  note_path: string;
  title: string;
  /** Raw `private_to` (null/'' for shelf-wide). The bucket key. */
  private_to: string | null;
  captured_at: string;
  mtime: string;
  excerpt: string;
  /** Source trust tier (1/2/null) — a health-score input. */
  trust_tier: 1 | 2 | null;
}

/** Body + the health-relevant frontmatter for one source note. */
interface SourceMeta {
  body: string;
  trust_tier: 1 | 2 | null;
}

interface TopicCluster {
  label: string;
  items: ShelfItem[];
}

export interface DistillInput {
  target: LoadedSpecialist;
  topic_label: string;
  sources: Array<{ note_path: string; title: string; excerpt: string }>;
  /**
   * Set on the SECOND (correction) call only — the write-time grounding
   * gate's re-distill. Carries the specifics the first synthesis stated
   * that the source notes do NOT support; the distiller must restate each
   * using only what the notes say, or drop it. Mirrors brief_critic's
   * tool-free correction re-prompt.
   */
  regrounding?: { flagged: string[] };
}

/** Produces the distilled prose for one topic, or null to skip (fail-open).
 *  The smoke seam: defaults to the planner-role LLM. */
export type Distiller = (input: DistillInput) => Promise<string | null>;

/** Judges a distilled synthesis against its source excerpts, returning the
 *  specifics the sources do NOT support (the fabrications). Smoke seam:
 *  defaults to the semantic fact critic (assess_factual_grounding). */
export type SynthesisAssessor = (
  prose: string,
  sources: Array<{ note_path: string; title: string; excerpt: string }>,
  target: LoadedSpecialist,
) => Promise<FactFinding[]>;

export interface ShelfSynthesisDeps {
  library_deps: LibraryRoutesDeps;
  /** Override the distiller (smoke). Default uses library_deps.llm. */
  distill_fn?: Distiller;
  /** Override the grounding assessor (smoke). Default uses the semantic
   *  fact critic against library_deps.llm. */
  assess_fn?: SynthesisAssessor;
}

export interface ShelfSynthesisOptions {
  now?: Date;
  /** Re-cluster every shelf even with no new items since last run. */
  force?: boolean;
  max_shelves?: number;
  max_items_per_shelf?: number;
  min_items_per_topic?: number;
  deadline_ms?: number;
  /** Restrict the pass to these specialist ids (the live, event-driven
   *  re-distill nudges ONE shelf the moment material lands; per-topic
   *  idempotency still skips unchanged topics). Undefined → all shelves. */
  only_shelf_ids?: string[];
}

export interface ShelfSynthesisResult {
  enabled: boolean;
  shelves_scanned: number;
  shelves_synthesized: number;
  syntheses_written: number;
  topics_skipped_unchanged: number;
  topics_below_min: number;
  distill_failures: number;
  /** Grounding gate: a re-distill grounded the flagged specifics cleanly. */
  grounding_corrected: number;
  /** Grounding gate: flagged sentences dropped; the grounded remainder shelved. */
  grounding_reduced: number;
  /** Grounding gate: too little survived grounding — the topic was NOT shelved. */
  grounding_rejected: number;
  notes: string[];
  skipped_reason?: string;
}

/* ------------------------------------------------------------------ */
/* Selection — raw items off the clippings projection                  */
/* ------------------------------------------------------------------ */

// System subfolders under a shelf — `_quarantine/` (quality-gate rejects),
// `_archive/` (soft-deleted), `_attachments/` (binaries), `_synthesis/` (our
// own output). A real library item is `library/<file>.md`; system items are
// `library/_<folder>/…`, i.e. an underscore immediately after `/library/`. The
// `LIKE @prefix` (`.../library/%`) sweeps them in, so exclude them explicitly —
// without this the pass synthesized quarantined smoke-test trash (the Vivian
// `_quarantine` note, found on the first live run 2026-06-14).
function sys_subfolder_pattern(shelf_prefix: string): string {
  return `${shelf_prefix}/\\_%`; // ESCAPE '\' → literal '_' right after /library/
}

function count_new_items(db: Database, shelf_prefix: string, since: string | null): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM clippings
        WHERE note_path LIKE @prefix
          AND note_path NOT LIKE @sys ESCAPE '\\'
          AND (@since IS NULL OR captured_at > @since)`,
    )
    .get({
      '@prefix': `${shelf_prefix}/%`,
      '@sys': sys_subfolder_pattern(shelf_prefix),
      '@since': since,
    }) as { n: number };
  return row.n;
}

function load_shelf_items(
  db: Database,
  read_meta: (path: string) => SourceMeta | null,
  shelf_prefix: string,
  max_items: number,
): ShelfItem[] {
  const rows = db
    .prepare(
      `SELECT note_path, title, private_to, captured_at, mtime FROM clippings
        WHERE note_path LIKE @prefix
          AND note_path NOT LIKE @sys ESCAPE '\\'
        ORDER BY captured_at DESC
        LIMIT @max`,
    )
    .all({
      '@prefix': `${shelf_prefix}/%`,
      '@sys': sys_subfolder_pattern(shelf_prefix),
      '@max': max_items,
    }) as Array<{
    note_path: string;
    title: string;
    private_to: string | null;
    captured_at: string;
    mtime: string;
  }>;
  const out: ShelfItem[] = [];
  for (const r of rows) {
    const meta = read_meta(r.note_path);
    if (!meta || meta.body.trim().length === 0) continue; // file gone / empty
    out.push({
      note_path: r.note_path,
      title: r.title,
      private_to: r.private_to && r.private_to.trim().length > 0 ? r.private_to.trim() : null,
      captured_at: r.captured_at,
      mtime: r.mtime,
      excerpt: meta.body.trim().slice(0, DEFAULTS.excerpt_chars),
      trust_tier: meta.trust_tier,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Bucketing + deterministic clustering                                */
/* ------------------------------------------------------------------ */

/** Group items by EXACT visibility bucket. The cordon's load-bearing step:
 *  a synthesis only ever combines sources that share one `private_to`. */
function bucket_by_visibility(items: ShelfItem[]): Map<string, ShelfItem[]> {
  const buckets = new Map<string, ShelfItem[]>();
  for (const it of items) {
    const key = it.private_to ?? UNSTAMPED;
    const list = buckets.get(key);
    if (list) list.push(it);
    else buckets.set(key, [it]);
  }
  return buckets;
}

/** Overlap coefficient |a∩b| / min(|a|,|b|) — forgiving on short notes. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / small.size;
}

/** Greedy deterministic clustering within a bucket. Items are visited in a
 *  stable order (note_path asc); each joins the first cluster it overlaps,
 *  else starts a new one. Label = the cluster's most-common tokens. */
function cluster_items(items: ShelfItem[]): TopicCluster[] {
  const sorted = [...items].sort((a, b) => (a.note_path < b.note_path ? -1 : 1));
  interface C {
    items: ShelfItem[];
    tokens: Set<string>;
    counts: Map<string, number>;
  }
  const clusters: C[] = [];
  for (const it of sorted) {
    const toks = demand_tokens(`${it.title} ${it.excerpt}`);
    if (toks.size === 0) continue;
    let home: C | null = null;
    for (const c of clusters) {
      if (overlap(toks, c.tokens) >= CLUSTER_OVERLAP) {
        home = c;
        break;
      }
    }
    if (!home) {
      home = { items: [], tokens: new Set(), counts: new Map() };
      clusters.push(home);
    }
    home.items.push(it);
    for (const t of toks) home.tokens.add(t); // overlap vocabulary (deduped set)
    // Label counts use RAW token frequency over the kept vocabulary, not
    // per-item presence — otherwise every shared token ties at item-count
    // and the label falls to alphabetical tie-break ("across blight common"
    // instead of the salient "tomato blight"). A word repeated across the
    // notes is what the topic is actually about.
    for (const w of `${it.title} ${it.excerpt}`.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (toks.has(w)) home.counts.set(w, (home.counts.get(w) ?? 0) + 1);
    }
  }
  return clusters.map((c) => ({
    label: label_of(c.counts),
    items: c.items,
  }));
}

function label_of(counts: Map<string, number>): string {
  return Array.from(counts.entries())
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .slice(0, 4)
    .map(([t]) => t)
    .join(' ');
}

/* ------------------------------------------------------------------ */
/* Note composition + cordon-safe shelving                             */
/* ------------------------------------------------------------------ */

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** A filename-safe tag for a visibility bucket, so the same topic in two
 *  buckets lands at two distinct (and stable) paths. */
function bucket_tag(bucket_key: string): string {
  if (bucket_key === UNSTAMPED) return 'shelf';
  return slugify(bucket_key) || 'scoped';
}

/** Stable, upsert-keyed path — no date prefix, so re-synthesizing a topic
 *  REPLACES its note in place rather than proliferating dated copies. */
function synthesis_note_path(shelf_prefix: string, bucket_key: string, label: string): string {
  return `${shelf_prefix}/_synthesis/${bucket_tag(bucket_key)}-${slugify(label) || 'topic'}.md`;
}

/** sha256 over the cluster's source identity — path + captured_at + mtime,
 *  sorted. Membership change OR an edited source flips it, re-triggering the
 *  distill; an unchanged set skips the LLM. */
function source_hash(items: ShelfItem[]): string {
  const h = createHash('sha256');
  for (const sig of items.map((i) => `${i.note_path}|${i.captured_at}|${i.mtime}`).sort()) {
    h.update(sig);
    h.update('\n');
  }
  return h.digest('hex');
}

function compose_body(label: string, prose: string, items: ShelfItem[]): string {
  const lines: string[] = [];
  lines.push(`# ${label} — what we know`);
  lines.push('');
  lines.push(prose.trim());
  lines.push('');
  lines.push(`## Sources (${items.length})`);
  for (const it of [...items].sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1))) {
    lines.push(`- **${it.title}** — \`${it.note_path}\``);
  }
  lines.push('');
  return lines.join('\n');
}

async function shelve_synthesis(
  library_deps: LibraryRoutesDeps,
  note_path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<void> {
  library_deps.memory.upsert_note(note_path, frontmatter, body);
  const chunks = index_chunks(library_deps.db, note_path, body);
  await embed_chunks_best_effort(library_deps, note_path, chunks);
  library_deps.events?.emit({ type: 'search_index_updated' });
}

/* ------------------------------------------------------------------ */
/* Default distiller — planner-role LLM, fail-open                     */
/* ------------------------------------------------------------------ */

const DISTILL_SYSTEM =
  'You are a household librarian distilling several shelf notes that all concern ONE topic ' +
  'into a single compact, durable synthesis the specialist can rely on later.\n\n' +
  'Write 2–4 short paragraphs of plain prose: what is now known about this topic, grounded ' +
  'ONLY in the provided notes. Rules:\n' +
  '- Never invent facts, names, dates, places, or figures that are not in the notes.\n' +
  '- No headings, no preamble, no meta-commentary ("based on the notes", "in summary").\n' +
  '- If the notes disagree, say so plainly rather than papering over it.\n' +
  '- Prefer the durable, evergreen takeaways over one-off specifics.';

const CORRECTION_SYSTEM =
  'You are a fact-grounding editor for a librarian\'s topic synthesis. Your ' +
  'previous synthesis stated specifics that are NOT supported by the source ' +
  'notes — recalled from memory, which is fabrication. Rewrite the synthesis ' +
  'so each flagged specific is either (a) restated using ONLY what the source ' +
  'notes actually say, or (b) dropped. Add NO new facts, names, dates, or ' +
  'figures. Keep the same plain-prose shape, no headings, no meta-commentary.';

function make_default_distiller(library_deps: LibraryRoutesDeps): Distiller {
  return async ({ target, topic_label, sources, regrounding }) => {
    const llm = library_deps.llm;
    if (!llm) return null;
    let role;
    try {
      role = llm.for_role('planner');
    } catch {
      return null;
    }
    try {
      const listing = sources
        .map((s, i) => `[S${i + 1}] ${s.title}\n${s.excerpt}`)
        .join('\n\n---\n\n');
      const correcting = regrounding && regrounding.flagged.length > 0;
      const user = correcting
        ? `Specialist: ${target.name} — ${target.role}\n` +
          `Topic: ${topic_label}\n\n` +
          `Source notes (the ONLY facts you may state):\n\n${listing}\n\n` +
          `These specifics in your previous synthesis are NOT in the notes — ` +
          `restate each using only the notes, or drop it:\n` +
          regrounding!.flagged.map((f) => `- "${f}"`).join('\n') +
          '\n\nRewrite the grounded synthesis now.'
        : `Specialist: ${target.name} — ${target.role}\n` +
          `Topic: ${topic_label}\n\n` +
          `Shelf notes on this topic:\n\n${listing}\n\n` +
          'Write the synthesis now.';
      const resp = await role.provider.complete({
        messages: [
          { role: 'system', content: correcting ? CORRECTION_SYSTEM : DISTILL_SYSTEM },
          { role: 'user', content: user },
        ],
        temperature: correcting ? 0.1 : 0.2,
        max_tokens: 900,
        think: false,
        ...role.defaults,
      });
      const text = resp.content.trim();
      return text.length > 40 ? text : null;
    } catch {
      return null;
    }
  };
}

/* ------------------------------------------------------------------ */
/* Write-time grounding gate (Phase 1.5)                               */
/* ------------------------------------------------------------------ */

/** Default assessor: the semantic fact critic, with the SOURCE EXCERPTS as
 *  the evidence. No LLM (or a critic outage) → no findings → the prose passes
 *  (system-wide fail-open; the gate is only ever stricter on a confident
 *  flag). The conservatism for synthesis lives in the ACTION below — a
 *  confirmed fabrication is dropped/rejected, never shelved. */
async function default_assess(
  prose: string,
  blocks: string[],
  target: LoadedSpecialist,
  llm: LibraryRoutesDeps['llm'],
): Promise<FactFinding[]> {
  if (!llm) return [];
  const grounding = build_grounding_context({ verified: blocks });
  const evidence_text = build_grounding_evidence({ verified: blocks });
  const r = await assess_factual_grounding({
    reply: prose,
    grounding,
    evidence_text,
    llm,
    self_identity: `${target.name} — ${target.role}`,
  });
  return r.unsupported;
}

const MIN_GROUNDED_CHARS = 120;
const MIN_GROUNDED_RATIO = 0.4;

/** Drop any sentence that carries a flagged specific; keep the rest. */
function drop_flagged_sentences(prose: string, findings: FactFinding[]): string {
  const claims = findings.map((f) => f.claim.toLowerCase()).filter((c) => c.length >= 3);
  if (claims.length === 0) return prose;
  const sentences = prose.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => {
    const low = s.toLowerCase();
    return !claims.some((c) => low.includes(c));
  });
  return kept.join(' ').trim();
}

function is_substantial(reduced: string, original: string): boolean {
  return reduced.length >= MIN_GROUNDED_CHARS && reduced.length >= original.length * MIN_GROUNDED_RATIO;
}

export type SynthesisOutcome = 'clean' | 'corrected' | 'reduced' | 'rejected';

export interface GroundedSynthesis {
  /** Prose to shelve, or null when the topic must NOT be shelved (rejected). */
  prose: string | null;
  outcome: SynthesisOutcome;
  /** Confirmed unsupported specifics that survived the correction pass. */
  flagged: FactFinding[];
}

/**
 * The write-time grounding gate. Mirrors brief_critic.critique_and_correct_brief:
 * assess the distilled prose against its sources; on findings, ONE tool-free
 * re-distill naming the flagged specifics; re-assess. If still flagged, DROP
 * the offending sentences and shelve the grounded remainder — unless too
 * little survives, in which case REJECT the topic (shelve nothing). A
 * synthesis persists and grounds future turns, so a confirmed fabrication is
 * never shelved; the system-wide fail-open (assessor outage → no findings)
 * keeps a transient critic blip from blocking the pass.
 */
export async function ground_synthesis(
  prose: string,
  deps: {
    assess: (prose: string) => Promise<FactFinding[]>;
    redistill: (flagged: FactFinding[]) => Promise<string | null>;
  },
): Promise<GroundedSynthesis> {
  const first = await deps.assess(prose);
  if (first.length === 0) return { prose, outcome: 'clean', flagged: [] };

  const redone = await deps.redistill(first);
  const base = redone ?? prose;
  const flagged = redone ? await deps.assess(redone) : first;
  if (redone && flagged.length === 0) return { prose: redone, outcome: 'corrected', flagged: [] };

  const reduced = drop_flagged_sentences(base, flagged);
  if (is_substantial(reduced, base)) return { prose: reduced, outcome: 'reduced', flagged };
  return { prose: null, outcome: 'rejected', flagged };
}

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

const ZERO: Omit<ShelfSynthesisResult, 'enabled' | 'skipped_reason'> = {
  shelves_scanned: 0,
  shelves_synthesized: 0,
  syntheses_written: 0,
  topics_skipped_unchanged: 0,
  topics_below_min: 0,
  distill_failures: 0,
  grounding_corrected: 0,
  grounding_reduced: 0,
  grounding_rejected: 0,
  notes: [],
};

export async function synthesize_shelves(
  deps: ShelfSynthesisDeps,
  opts: ShelfSynthesisOptions = {},
): Promise<ShelfSynthesisResult> {
  if (!synthesis_enabled()) {
    return {
      enabled: false,
      ...ZERO,
      notes: [],
      skipped_reason: 'HEARTH_SHELF_SYNTHESIS=0 — synthesis disabled by kill switch',
    };
  }

  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.deadline_ms ?? DEFAULTS.slice_ms);
  const min_items = opts.min_items_per_topic ?? DEFAULTS.min_items_per_topic;
  const max_items = opts.max_items_per_shelf ?? DEFAULTS.max_items_per_shelf;
  const max_shelves = opts.max_shelves ?? DEFAULTS.max_shelves;

  const library_deps = deps.library_deps;
  const db = library_deps.db;
  const memory = library_deps.memory;
  const store = new ShelfSynthesisStore(db);
  const distill = deps.distill_fn ?? make_default_distiller(library_deps);
  const read_meta = (p: string): SourceMeta | null => {
    const note = memory.read_note(p);
    if (!note) return null;
    const tt = (note.frontmatter as Record<string, unknown>).trust_tier;
    return { body: note.body, trust_tier: tt === 1 || tt === 2 ? tt : null };
  };

  const result: ShelfSynthesisResult = { enabled: true, ...ZERO, notes: [] };
  let shelves_done = 0;

  for (const spec of library_deps.specialists.list()) {
    if (opts.only_shelf_ids && !opts.only_shelf_ids.includes(spec.id)) continue;
    if (shelves_done >= max_shelves || Date.now() > deadline) break;
    const shelf_prefix = `Knowledge/${capitalize(spec.id)}/library`;
    const state = store.get(shelf_prefix);

    // Cheap trigger: a shelf with nothing new since last run is skipped
    // WITHOUT clustering (one indexed COUNT, no LLM).
    if (!opts.force && count_new_items(db, shelf_prefix, state.last_synthesized_at) === 0) {
      continue;
    }

    result.shelves_scanned++;
    shelves_done++;

    const items = load_shelf_items(db, read_meta, shelf_prefix, max_items);
    if (items.length === 0) {
      store.put({ ...state, last_synthesized_at: now.toISOString() });
      continue;
    }

    const produced = { ...state.produced };
    let wrote_here = 0;

    for (const [bucket_key, bucket_items] of bucket_by_visibility(items)) {
      if (Date.now() > deadline) break;
      for (const cluster of cluster_items(bucket_items)) {
        if (Date.now() > deadline) break;
        if (cluster.items.length < min_items) {
          result.topics_below_min++;
          continue;
        }
        const note_path = synthesis_note_path(shelf_prefix, bucket_key, cluster.label);
        const hash = source_hash(cluster.items);
        if (produced[note_path] === hash) {
          result.topics_skipped_unchanged++;
          continue;
        }
        const srcs = cluster.items.map((i) => ({
          note_path: i.note_path,
          title: i.title,
          excerpt: i.excerpt,
        }));
        const prose = await distill({ target: spec, topic_label: cluster.label, sources: srcs });
        if (!prose) {
          result.distill_failures++;
          continue; // fail-open: a distiller outage skips the topic, never the pass
        }

        // Write-time grounding gate (Phase 1.5): a synthesis becomes durable,
        // high-signal evidence, so a fabrication here would launder into the
        // vault and ground future turns. Verify the prose against its OWN
        // sources before shelving; correct, or drop what isn't grounded.
        const blocks = srcs.map((s) => `[${s.title}]\n${s.excerpt}`);
        const grounded = await ground_synthesis(prose, {
          assess: (p) =>
            deps.assess_fn
              ? deps.assess_fn(p, srcs, spec)
              : default_assess(p, blocks, spec, library_deps.llm),
          redistill: (flagged) =>
            distill({
              target: spec,
              topic_label: cluster.label,
              sources: srcs,
              regrounding: { flagged: flagged.map((f) => f.claim) },
            }),
        });

        // The source set was processed deterministically either way — record
        // the hash so an unchanged shelf doesn't re-burn the LLM next pass (a
        // rejected topic stays raw-but-searchable; a changed source set
        // re-triggers via a new hash).
        produced[note_path] = hash;

        if (grounded.outcome === 'reduced' || grounded.outcome === 'rejected') {
          library_deps.memory.log_action({
            intent_id: ulid(),
            agent: 'cordelia',
            tool_name: 'synthesis_grounding',
            tool_input: { shelf: shelf_prefix, topic: cluster.label, note_path },
            execution_result: {
              outcome: grounded.outcome,
              flagged: grounded.flagged.map((f) => `${f.kind}:${f.claim}`).slice(0, 8),
            },
          });
        }
        if (!grounded.prose) {
          result.grounding_rejected++;
          continue; // too little survived grounding — shelve nothing
        }
        if (grounded.outcome === 'corrected') result.grounding_corrected++;
        else if (grounded.outcome === 'reduced') result.grounding_reduced++;

        // Deterministic health/worthiness score (self-governing loop spine).
        // At write time the note is fresh (age 0) and all sources exist; the
        // decay axes (freshness, integrity) bite later when Mariah re-scores.
        // Worth is neutral until the retrieval-usage instrument lands.
        const health = score_synthesis({
          grounding_outcome: (grounded.outcome === 'rejected'
            ? 'reduced'
            : grounded.outcome) as GroundingOutcome,
          source_count: cluster.items.length,
          trust_tiers: cluster.items.map((i) => i.trust_tier),
          age_days: 0,
          sources_present: cluster.items.length,
        });

        const frontmatter: Record<string, unknown> = {
          type: 'synthesis_note',
          title: `${cluster.label} — synthesis`,
          specialist_scope: spec.id,
          topic_label: cluster.label,
          synthesized_from: srcs.map((s) => s.note_path),
          source_hash: hash,
          synthesized_at: now.toISOString(),
          // Derived, second-order artifact — a reader should cite THROUGH it
          // to the primary source it points at, not the synthesis as if it
          // were primary. Also records the grounding gate's verdict.
          derived: true,
          grounding_outcome: grounded.outcome,
          ...(grounded.outcome === 'reduced' ? { grounding_flagged: grounded.flagged.length } : {}),
          // Health/worthiness (the loop's spine): the office ranks by it, the
          // scan detects on it, retrieval can prior on it, pruning gates on it.
          health_score: health.score,
          health_grade: health.grade,
          ...(health.reasons.length > 0 ? { health_reasons: health.reasons } : {}),
        };
        // Cordon stamp: the bucket's exact visibility. Unstamped bucket →
        // omit (the synthesis inherits its sources' fail-closed visibility).
        if (bucket_key !== UNSTAMPED) frontmatter.private_to = bucket_key;

        await shelve_synthesis(
          library_deps,
          note_path,
          frontmatter,
          compose_body(cluster.label, grounded.prose, cluster.items),
        );
        result.syntheses_written++;
        result.notes.push(note_path);
        wrote_here++;
      }
    }

    store.put({ shelf_path: shelf_prefix, last_synthesized_at: now.toISOString(), produced });
    if (wrote_here > 0) result.shelves_synthesized++;
  }

  return result;
}
