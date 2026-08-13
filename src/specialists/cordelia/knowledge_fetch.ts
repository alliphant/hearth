/**
 * knowledge_fetch — the Second Brain's self-FETCHING pass (autonomous, 2026-06-15).
 *
 * The brain notices its own weak spots and fills them WITHOUT being asked and
 * WITHOUT bothering the owner. It reads the demand ledger (the deterministic
 * miner over `rag_low_confidence` + empty `search_library` + eval failures +
 * citation gaps), ranks the strongest evidence-backed gaps that map to a real
 * shelf, and runs Cordelia's acquisition sprint on each in **silent** mode —
 * shelve in-roster survivors, SUPPRESS the out-of-roster proposals. So a
 * background fetch never puts an item in the owner's queue (the no-noise
 * contract); the freshly-shelved material is consolidated by the distill pass
 * that runs right after.
 *
 * Cordon: a gap whose evidence is all from one non-owner user carries
 * `sole_user_id`; it's threaded to `private_to_user_id` so the acquired
 * material shelves at THAT user's visibility, never wider.
 *
 * Deterministic gap selection (the miner is pure); the acquisition itself is
 * the only non-deterministic step (web search), injected so the smoke can
 * exercise the orchestration without a network. Action-capped (acquisition is
 * expensive), fail-open per topic. Kill switch: HEARTH_SYNTHESIS_FETCH=0.
 */
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { LLMRouter } from '@core/llm';
import type { ToolContext } from '@core/tool';
import { mine_knowledge_demand } from '@core/knowledge_demand';

export function fetch_enabled(): boolean {
  return process.env.HEARTH_SYNTHESIS_FETCH !== '0';
}

const DEFAULTS = {
  /** Gaps acquired per run — acquisition is expensive (web search + fetch). */
  max_topics: 3,
  /** A gap needs at least this much demand evidence to be worth a sprint. */
  min_evidence: 2,
  /** In-roster candidates fetched + shelved per topic (acquire's own cap is 5). */
  max_candidates: 4,
  /** Demand-mining window. */
  window_days: 30,
} as const;

/** The acquisition call — `acquire_knowledge.execute`, injected so the pass is
 *  testable without a network. Returns the sprint's shelved survivors. */
export type AcquireFn = (
  input: {
    topic: string;
    specialist_id: string;
    max_candidates: number;
    private_to_user_id?: string;
    silent: boolean;
  },
  ctx: ToolContext,
) => Promise<{ shelved: unknown[]; proposed?: unknown[] } | null>;

export interface FetchDeps {
  db: Database;
  memory: MemoryClient;
  llm?: LLMRouter;
  acquire: AcquireFn;
}

export interface FetchForGapsResult {
  enabled: boolean;
  gaps_considered: number;
  topics_fetched: number;
  items_shelved: number;
  notes: string[];
  skipped_reason?: string;
}

export async function fetch_for_gaps(
  deps: FetchDeps,
  opts: { now?: Date; max_topics?: number; min_evidence?: number; owner_id?: string } = {},
): Promise<FetchForGapsResult> {
  if (!fetch_enabled()) {
    return {
      enabled: false,
      gaps_considered: 0,
      topics_fetched: 0,
      items_shelved: 0,
      notes: [],
      skipped_reason: 'HEARTH_SYNTHESIS_FETCH=0 — self-fetch disabled by kill switch',
    };
  }

  const now = opts.now ?? new Date();
  const max_topics = opts.max_topics ?? DEFAULTS.max_topics;
  const min_evidence = opts.min_evidence ?? DEFAULTS.min_evidence;

  // Deterministic gap ranking: strongest-evidence first, must map to a real
  // shelf (specialist_id) and clear the evidence floor.
  const demand = mine_knowledge_demand(deps.db, { window_days: DEFAULTS.window_days, now, max_topics: 40 });
  const gaps = demand.topics
    .filter((t): t is typeof t & { specialist_id: string } => !!t.specialist_id && t.evidence_count >= min_evidence)
    .slice(0, max_topics);

  const result: FetchForGapsResult = {
    enabled: true,
    gaps_considered: gaps.length,
    topics_fetched: 0,
    items_shelved: 0,
    notes: [],
  };

  for (const g of gaps) {
    const ctx = { memory: deps.memory, llm: deps.llm, now, intent_id: ulid() } as unknown as ToolContext;
    // Cordon only a NON-OWNER sole user — their private demand shelves at their
    // visibility. An owner-sole (or mixed) gap shelves shelf-wide (the demand-
    // ledger design: only a non-owner sole user carries the private hint).
    const cordon = g.sole_user_id && g.sole_user_id !== opts.owner_id ? g.sole_user_id : undefined;
    let shelved = 0;
    try {
      const r = await deps.acquire(
        {
          topic: g.label,
          specialist_id: g.specialist_id,
          max_candidates: DEFAULTS.max_candidates,
          ...(cordon ? { private_to_user_id: cordon } : {}),
          silent: true, // the no-noise contract — no proposals from a background sprint
        },
        ctx,
      );
      shelved = Array.isArray(r?.shelved) ? r!.shelved.length : 0;
      result.topics_fetched++;
      result.items_shelved += shelved;
      result.notes.push(`${g.specialist_id}:${g.label} → ${shelved} shelved`);
    } catch (err) {
      console.error('[knowledge-fetch] acquire failed (non-fatal):', g.label, err);
    }
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'cordelia',
      tool_name: 'knowledge_fetch',
      tool_input: {
        topic: g.label,
        specialist_id: g.specialist_id,
        evidence: g.evidence_count,
        private_to: cordon ?? null,
      },
      execution_result: { shelved, silent: true },
      ...(cordon ? { user_id: cordon } : {}),
    });
  }

  return result;
}
