/**
 * recall_precedent — household case law, on demand (Kate self-direction C3,
 * 2026-07-05; engine: src/core/precedent.ts).
 *
 * ONE comprehensive read over the decided history: how were similar
 * proposals, court cases, and process misses decided before? Returns cases
 * WITH outcome confidence ("denied, no reason recorded — weak precedent") —
 * label honesty is the contract, and precedent is evidence for the model's
 * judgment, never a decision rule. The model DECIDES to consult history
 * (LAW #1-clean); the injections at the court/create() chokepoints are the
 * deterministic-pipeline siblings.
 *
 * Cordon mirrors the proposals queue exactly: owner sees system cases + his
 * own; a household member sees only their own; no user in ctx fails CLOSED
 * to system cases only. Vector match when the embedder is live, deterministic
 * token overlap otherwise. DARK behind HEARTH_PRECEDENT.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { recall_precedent_cases, precedent_enabled } from '@core/precedent';
import { PrecedentStore, type PrecedentScope } from '@memory/stores/precedent_cases';

const InputSchema = z.object({
  situation: z
    .string()
    .min(3)
    .max(600)
    .describe('The situation to match against past cases, in plain words — e.g. "flag a stale presence sensor to Beatrice" or "gift proposal for a friend\'s birthday visit"'),
  k: z.coerce.number().int().min(1).max(10).default(5),
});

const CaseSchema = z.object({
  outcome: z.string(),
  confidence: z.string(),
  confidence_note: z.string(),
  decided_at: z.string(),
  kind: z.string(),
  specialist_id: z.string(),
  case: z.string(),
  similarity: z.number(),
  match_kind: z.string(),
});

const OutputSchema = z.object({
  enabled: z.boolean(),
  found: z.boolean(),
  cases: z.array(CaseSchema),
  note: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool {
  const store = new PrecedentStore(deps.db);
  const tool: Tool<Input, Output> = {
    name: 'recall_precedent',
    description:
      'Recall household case law — how similar past proposals, court cases, and process misses ' +
      'were DECIDED (approved/denied/lapsed/resolved), each with an outcome-confidence weight. ' +
      'Use before filing or judging a proposal, when weighing whether the household wants ' +
      'something, or when a situation feels familiar ("what did we do last time?"). Precedent is ' +
      'evidence, not a rule — a weak-confidence case (denied with no reason) should not settle ' +
      'anything on its own. Example: {situation: "offer to order a birthday gift before a visit", k: 5}.',
    risk: 'read',
    required_capabilities: ['recall_precedent'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.situation.toLowerCase().trim());
      h.update(String(input.k));
      return `recall_precedent:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!precedent_enabled()) {
        return {
          enabled: false,
          found: false,
          cases: [],
          note: 'Precedent memory is not enabled (HEARTH_PRECEDENT off) — no case index to read.',
        };
      }
      // Cordon: mirror the proposals queue. No user in ctx → system cases
      // only (fail closed, never wide).
      const scope: PrecedentScope = ctx.user
        ? { kind: 'viewer', user_id: ctx.user.id, tier: ctx.user.tier }
        : { kind: 'system' };
      const matches = await recall_precedent_cases({
        store,
        embedder: ctx.embedder ?? deps.embedder,
        situation: input.situation,
        scope,
        k: input.k,
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'orchestrator',
        tool_name: 'recall_precedent',
        tool_input: { situation_preview: input.situation.slice(0, 120), k: input.k },
        execution_result: {
          found: matches.length,
          outcomes: matches.map((m) => `${m.outcome} (${m.confidence})`),
        },
        user_id: ctx.user?.id,
      });

      return {
        enabled: true,
        found: matches.length > 0,
        cases: matches.map((m) => ({
          outcome: m.outcome,
          confidence: m.confidence,
          confidence_note: m.confidence_note,
          decided_at: m.decided_at,
          kind: m.kind,
          specialist_id: m.specialist_id,
          case: m.case_md,
          similarity: Number(m.similarity.toFixed(4)),
          match_kind: m.match_kind,
        })),
        note:
          matches.length > 0
            ? 'Precedent is evidence, not a rule — weigh each case by its stated confidence.'
            : 'No similar decided cases on record — this shape is new to the household.',
      };
    },
  };
  return tool as Tool;
}
