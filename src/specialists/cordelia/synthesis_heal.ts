/**
 * synthesis_heal — the Second Brain's self-healing pass (loop #3, 2026-06-15).
 *
 * Distillation (shelf_synthesis) WRITES; the health scorer DETECTS; until now
 * nothing ACTED on decay — a "rotting" grade was shown in the office and left
 * to rot. This pass closes detection→action so the brain heals itself:
 *
 *   - INTEGRITY ROT — a synthesis whose cited sources have been DELETED is
 *     stale evidence (its prose still references gone notes). Heal deletes it
 *     (note + chunks + embeddings + usage) and RESETS its shelf's synthesis
 *     state, so the SAME nightly job's distill pass (which runs right after)
 *     regenerates a fresh, correctly-grounded synthesis from the surviving
 *     sources — or, if too few survive (cluster below the min), naturally
 *     leaves it gone. No re-distill machinery is duplicated here: deletion +
 *     shelf-reset hands the work back to the one distiller.
 *
 *   - DEAD WEIGHT — a synthesis that is unused (worth instrument: zero
 *     retrievals), old, AND already low-health is corpus clutter. Heal prunes
 *     it (delete, no regeneration). Conservative by design: a healthy or a
 *     recently-USED synthesis is KEPT even if unread — we never delete good
 *     evergreen knowledge just because nobody asked this month.
 *
 * Runs system-wide (no caller cordon — machine maintenance over every shelf's
 * syntheses regardless of visibility), deterministic, deadline-free but
 * action-capped for nightly fairness. Fail-open: a read/delete error on one
 * note is logged and skipped, never aborts the pass. Kill switch:
 * HEARTH_SYNTHESIS_HEAL=0.
 */
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import { capitalize } from '@core/loops';
import { score_synthesis, type GroundingOutcome, type HealthGrade } from '@core/synthesis_health';
import { ShelfSynthesisStore } from '@memory/stores/shelf_synthesis';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { AppEventBus } from '@app/events';

/** Heal touches only these five — declaring its own narrow deps (not the full
 *  LibraryRoutesDeps the distill pass needs) keeps the smoke honest and the
 *  dependency minimal. A full ShelfSynthesisDeps structurally satisfies it. */
export interface HealLibraryDeps {
  db: Database;
  vault_root: string;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  events?: AppEventBus;
}
export interface HealDeps {
  library_deps: HealLibraryDeps;
}

export function heal_enabled(): boolean {
  return process.env.HEARTH_SYNTHESIS_HEAL !== '0';
}

const DEFAULTS = {
  /** A synthesis NEVER used AND low-health AND at least this old is dead weight. */
  prune_disuse_days: 45,
  /** A synthesis once used but COLD this long AND low-health is abandoned dead
   *  weight (the recency complement — knowledge you used then stopped using). */
  prune_cold_days: 90,
  /** Per-run action cap (nightly fairness). */
  max_actions: 40,
} as const;

const GROUNDING = new Set<GroundingOutcome>(['clean', 'corrected', 'reduced']);
const LOW_HEALTH: ReadonlySet<HealthGrade> = new Set<HealthGrade>(['weak', 'rotting']);

export interface SynthesisHealResult {
  enabled: boolean;
  scanned: number;
  /** Rotting (cited sources deleted) → deleted + shelf reset for regeneration. */
  resynthesize_queued: number;
  /** Unused + old + low-health → pruned, no regeneration. */
  pruned_dead_weight: number;
  /** Shelves whose state was reset so the distill pass regenerates them. */
  shelves_reset: string[];
  notes: string[];
  skipped_reason?: string;
}

interface ShelfReset {
  /** synthesis-note paths to drop from the shelf's `produced` map. */
  drop: Set<string>;
}

/** Delete a synthesis note everywhere it lives: the vault file, its FTS chunks,
 *  its vector embeddings, and its usage row. (A `synthesis_note` is AUXILIARY —
 *  never projected to clippings/graph_edges — so these four are the whole
 *  footprint.) Best-effort per step. */
function delete_synthesis_everywhere(deps: HealLibraryDeps, note_path: string): void {
  try {
    const abs = resolve(deps.vault_root, note_path);
    if (existsSync(abs)) unlinkSync(abs);
  } catch (err) {
    console.error('[synthesis-heal] unlink failed:', note_path, err);
  }
  try {
    deps.db.prepare(`DELETE FROM chunks_fts WHERE note_path = @p`).run({ '@p': note_path });
  } catch (err) {
    console.error('[synthesis-heal] chunks_fts delete failed:', note_path, err);
  }
  deps.memory.delete_chunk_embeddings(note_path);
  deps.memory.delete_synthesis_usage(note_path);
}

export async function heal_syntheses(
  deps: HealDeps,
  opts: { now?: Date; prune_disuse_days?: number; prune_cold_days?: number; max_actions?: number } = {},
): Promise<SynthesisHealResult> {
  if (!heal_enabled()) {
    return {
      enabled: false,
      scanned: 0,
      resynthesize_queued: 0,
      pruned_dead_weight: 0,
      shelves_reset: [],
      notes: [],
      skipped_reason: 'HEARTH_SYNTHESIS_HEAL=0 — heal disabled by kill switch',
    };
  }

  const now = opts.now ?? new Date();
  const prune_days = opts.prune_disuse_days ?? DEFAULTS.prune_disuse_days;
  const prune_cold_days = opts.prune_cold_days ?? DEFAULTS.prune_cold_days;
  const max_actions = opts.max_actions ?? DEFAULTS.max_actions;
  const library_deps = deps.library_deps;
  const memory = library_deps.memory;

  const result: SynthesisHealResult = {
    enabled: true,
    scanned: 0,
    resynthesize_queued: 0,
    pruned_dead_weight: 0,
    shelves_reset: [],
    notes: [],
  };
  const shelf_resets = new Map<string, ShelfReset>();
  let actions = 0;

  for (const spec of library_deps.specialists.list()) {
    if (actions >= max_actions) break;
    const shelf_prefix = `Knowledge/${capitalize(spec.id)}/library`;
    const synth_rel = `${shelf_prefix}/_synthesis`;
    const synth_abs = resolve(library_deps.vault_root, synth_rel);
    if (!existsSync(synth_abs)) continue;
    let files: string[];
    try {
      files = readdirSync(synth_abs).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const f of files) {
      if (actions >= max_actions) break;
      const note_path = `${synth_rel}/${f}`;
      const note = memory.read_note(note_path);
      if (!note) continue;
      const fm = note.frontmatter as Record<string, unknown>;
      if (fm.type !== 'synthesis_note') continue;
      result.scanned++;

      const synthesized_from = Array.isArray(fm.synthesized_from)
        ? (fm.synthesized_from.filter((p) => typeof p === 'string') as string[])
        : [];
      const source_count = synthesized_from.length;
      if (source_count === 0) continue; // nothing to reason about

      // Integrity: how many cited sources still exist + their trust tiers.
      let present = 0;
      const trust_tiers: Array<1 | 2 | null> = [];
      for (const sp of synthesized_from) {
        const src = memory.read_note(sp);
        if (src) {
          present++;
          const tt = (src.frontmatter as Record<string, unknown>).trust_tier;
          trust_tiers.push(tt === 1 || tt === 2 ? tt : null);
        }
      }

      // ── Action 1: integrity rot — a cited source was deleted ──────────────
      if (present < source_count) {
        delete_synthesis_everywhere(library_deps, note_path);
        const r = shelf_resets.get(shelf_prefix) ?? { drop: new Set<string>() };
        r.drop.add(note_path);
        shelf_resets.set(shelf_prefix, r);
        result.resynthesize_queued++;
        result.notes.push(note_path);
        actions++;
        memory.log_action({
          intent_id: ulid(),
          agent: 'cordelia',
          tool_name: 'synthesis_heal',
          tool_input: { note_path, shelf: shelf_prefix },
          execution_result: {
            action: 'resynthesize',
            reason: `${source_count - present} of ${source_count} sources deleted`,
          },
        });
        continue;
      }

      // ── Action 2: dead weight — unused + old + low-health ─────────────────
      const synthesized_at = typeof fm.synthesized_at === 'string' ? fm.synthesized_at : null;
      const age_days = synthesized_at
        ? Math.max(0, (now.getTime() - Date.parse(synthesized_at)) / 86_400_000)
        : 0;
      const outcome: GroundingOutcome =
        typeof fm.grounding_outcome === 'string' && GROUNDING.has(fm.grounding_outcome as GroundingOutcome)
          ? (fm.grounding_outcome as GroundingOutcome)
          : 'clean';
      const usage = memory.get_synthesis_usage([note_path]).get(note_path);
      const hits = usage?.hits ?? 0;
      const last_retrieval_age_days = usage?.last_retrieved_at
        ? Math.max(0, (now.getTime() - Date.parse(usage.last_retrieved_at)) / 86_400_000)
        : undefined;
      const health = score_synthesis({
        grounding_outcome: outcome,
        source_count,
        trust_tiers,
        age_days,
        sources_present: present,
        retrieval_hits: hits,
        last_retrieval_age_days,
      });

      // Dead weight, two recency-aware shapes (both gated on low health, so good
      // evergreen knowledge is KEPT even when quiet): NEVER used + old, OR once
      // used but COLD this long (used then abandoned). Conservative by design.
      const never_used_old = hits === 0 && age_days > prune_days;
      const used_but_cold = last_retrieval_age_days !== undefined && last_retrieval_age_days > prune_cold_days;
      if ((never_used_old || used_but_cold) && LOW_HEALTH.has(health.grade)) {
        delete_synthesis_everywhere(library_deps, note_path);
        // Keep the shelf's `produced` entry so the topic is NOT regenerated —
        // dead weight stays pruned until its source set actually changes.
        result.pruned_dead_weight++;
        result.notes.push(note_path);
        actions++;
        memory.log_action({
          intent_id: ulid(),
          agent: 'cordelia',
          tool_name: 'synthesis_heal',
          tool_input: { note_path, shelf: shelf_prefix },
          execution_result: {
            action: 'prune',
            reason: never_used_old
              ? `unused (0 hits), ${Math.round(age_days)}d old, grade ${health.grade}`
              : `abandoned (cold ${Math.round(last_retrieval_age_days ?? 0)}d since last use), grade ${health.grade}`,
          },
        });
      }
    }
  }

  // ── Apply shelf-state resets so the distill pass regenerates the rot ──────
  // Drop each deleted note from `produced` (so its topic re-distills) and null
  // `last_synthesized_at` (so the shelf is re-scanned even with no NEW items —
  // a deletion, unlike an addition, wouldn't otherwise trip the cheap trigger).
  if (shelf_resets.size > 0) {
    const store = new ShelfSynthesisStore(library_deps.db);
    for (const [shelf_prefix, r] of shelf_resets) {
      const state = store.get(shelf_prefix);
      const produced = { ...state.produced };
      for (const p of r.drop) delete produced[p];
      store.put({ shelf_path: shelf_prefix, last_synthesized_at: null, produced });
      result.shelves_reset.push(shelf_prefix);
    }
  }

  library_deps.events?.emit({ type: 'search_index_updated' });
  return result;
}
