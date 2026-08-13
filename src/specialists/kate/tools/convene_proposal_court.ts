/**
 * convene_proposal_court — Kate's daily Council tick (2026-07-02; engine:
 * src/core/proposal_court.ts).
 *
 * Kate, Beatrice (mechanism), and Mariah (evidence) sit as different-lens
 * skeptics over the AGED pending queue: internal/system kinds get decided on
 * consensus through the same effects an owner tap produces; stale offers of
 * any kind lapse (no XP effect); splits and floor-class items go to ONE
 * owner digest. The dense 27B takes a recused author's seat + breaks ties.
 *
 * NOT on Kate's LLM surfaces — the background job is the trigger; manual
 * catch-up via POST /api/specialists/kate/fire_background_job?name=proposal_court.
 * DARK behind HEARTH_PROPOSAL_COURT=1.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { convene_proposal_court, proposal_court_enabled, type CourtDeps } from '@core/proposal_court';
import { PrecedentStore } from '@memory/stores/precedent_cases';
import { ulid } from 'ulid';

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  examined: z.number(),
  approved: z.array(z.string()),
  rejected: z.array(z.string()),
  lapsed: z.array(z.string()),
  split: z.array(z.string()),
  /** Trust-teeth arms (auto-executes after the undo window; DARK behind
   *  HEARTH_TRUST_TEETH — always [] until armed). */
  armed: z.array(z.string()),
  owner_class: z.number(),
  /** Owner-queue triage gate (2026-07-04): cards the triage rung filed to
   *  the record (work logs / peer replies / self-declared duplicates —
   *  expired, no XP). */
  triaged_out: z.array(z.string()),
  /** Theme rollups created this convening (each supersedes its members). */
  rollups: z.array(z.string()),
  digest_id: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_convene_proposal_court(deps: CourtDeps): Tool<Input, Output> {
  return {
    name: 'convene_proposal_court',
    description:
      'Convene the Proposal Court: Kate + Beatrice + Mariah as different-lens skeptics over the aged ' +
      'pending queue — decide internal kinds on consensus, lapse stale offers, digest the rest. Job-only.',
    risk: 'write_internal',
    required_capabilities: ['convene_court'],
    volatile: true, // ledger + wall-clock dependent; never serve a cached tick
    input_schema: InputSchema,
    output_schema: OutputSchema,
    idempotency_key() {
      return `convene_proposal_court:${ulid()}`;
    },
    async execute(_input, ctx: ToolContext): Promise<Output> {
      const r = await convene_proposal_court(deps, { now: ctx.now });
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: 'kate',
        tool_name: 'proposal_court_convened',
        tool_input: {},
        execution_result: {
          enabled: r.enabled,
          examined: r.examined,
          approved: r.approved.length,
          rejected: r.rejected.length,
          lapsed: r.lapsed.length,
          split: r.split.length,
          armed: r.armed.length,
          owner_class: r.owner_class,
          triaged_out: r.triaged_out.length,
          rollups: r.rollups.length,
        },
      });
      const { cases: _cases, ...out } = r;
      return out;
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_convene_proposal_court({
    db: deps.db,
    proposals: deps.proposals,
    memory: deps.memory,
    llm: deps.llm,
    specialists: deps.specialists,
    inbox: deps.inbox,
    // For inlining a binding-proposal spec into the directed-build
    // instruction (2026-08-11 postmortem).
    vault_root: deps.vault_root,
    // Precedent memory (C3): household case law in the lens packs — evidence,
    // never a rule. Dark behind HEARTH_PRECEDENT; the embedder is optional
    // vector fidelity (text overlap otherwise).
    precedent: new PrecedentStore(deps.db),
    embedder: deps.embedder,
    // Conversion teeth (2026-07-20): court approvals of Beatrice specs FIRE
    // the directed build (the decide-route path) instead of only flagging.
    fire_directed_build: deps.fire_directed_build,
    // Risk-keyed floor (2026-07-20): the permanent owner floor reads the
    // dispatch tool's DECLARED registry risk, not just the name regex.
    tool_risk_of: (name) => deps.tool_registry.get(name)?.risk ?? null,
  }) as Tool;
}

// Keep the enabled-check exported for callers that want a cheap gate probe.
export { proposal_court_enabled };
