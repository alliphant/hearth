import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProposalsStore } from '@core/proposals';

/**
 * Beatrice's typed-arg persona-tuning proposal creator.
 *
 * Replaces the generic `propose_action({kind: 'persona_tuning', payload: {...}})`
 * shape that Qwen3.6 was reliably emitting with empty args. Flat
 * string fields are filled correctly by every model we've tested
 * (Qwen, Claude, GPT). Pattern matches Kate's draft_message.ts —
 * one typed tool per ProposalKind.
 *
 * Fired by Beatrice when a peer specialist forwards user UX feedback
 * (kind='flag' inbox message). The flag body carries Jasper's verbatim
 * words and which specialist received them; this tool packages those
 * into a structured proposal that Kate's queue can surface and that
 * Jasper approves to trigger Beatrice's PR-drafting workflow.
 */

const DiagnosisEnum = z.enum([
  'over-prescribed-structure',
  'silent-on-posture',
  'misleading-tool-output',
  'unclear-tool-description',
]);

const InputSchema = z.object({
  /** The specialist id that received the UX feedback (the persona to tune). */
  target_specialist_id: z.string().min(1).max(80),
  /** Jasper's exact words, quoted verbatim from the flag body. */
  verbatim_feedback: z.string().min(1).max(4_000),
  /** Which structural failure caused the UX gap. */
  diagnosis: DiagnosisEnum,
  /** Plain-English description of what to edit in the YAML persona or
   *  connector file. One paragraph; the implementing PR fleshes it out. */
  proposed_change: z.string().min(1).max(4_000),
  /** YOUR rationale — Beatrice talking to the user about what she
   *  noticed in the feedback, why this diagnosis fits, and what the
   *  edit will do for them. Written in voice (first person, the
   *  register Beatrice uses in chat), not as a template. The full
   *  text shows when the user expands the proposal card; the short
   *  summary above it is derived from the structured fields. See
   *  the tool description for examples of what works and what to
   *  avoid. */
  rationale: z.string().min(40).max(2_000),
});

const OutputSchema = z.object({
  proposal_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_propose_persona_tuning(
  proposals: ProposalsStore,
): Tool<Input, Output> {
  return {
    name: 'propose_persona_tuning',
    description:
      'SCOPE — voice, tone, and HOW a specialist talks ONLY (preachy, too terse, wrong register, over-structured). This is the WEAKEST layer; it does not generalize. If the problem is that a specialist FABRICATED a fact, lacks a capability, or read bad data from a tool that 404\'d, a persona line ("always search first / don\'t make things up") will NOT fix it — that is a runtime or connector fix. Use propose_code_change (runtime guard / capability) or propose_connector_recovery_hint (a tool that returns null/error with no actionable next step). Reach for persona tuning only when the specialist did the right thing mechanically but said it the wrong way.\n\n' +
      'Draft a persona-tuning proposal in response to user UX feedback that a peer specialist forwarded to you (Beatrice). Call this ONCE per flag — args are all flat strings, no nested objects. The flag body has the data you need: target_specialist_id is the recipient on the flag, verbatim_feedback is the quoted user words, diagnosis is one of {over-prescribed-structure | silent-on-posture | misleading-tool-output | unclear-tool-description}, proposed_change is one paragraph describing what to edit, rationale is YOUR prose to the user. Returns a proposal_id that goes onto the approval queue.\n\n' +
      'Voice contract for `rationale` (this matters — the user reads the rationale every time they expand the card): write in YOUR voice, first-person, the way you talk in chat. Tell the user what you noticed in the feedback, why this diagnosis fits, and what the edit will do for them. 2–6 sentences usually. Do NOT use Github-PR shape (no bulleted "Problem: …" / "Fix: …", no "Closes N issues" footer). Do NOT restate the verbatim feedback or the structured fields — those render separately. Do NOT use the words "user" or "Jasper"; address them in second person ("you flagged Maggie for X — here\'s what I think is going on…"). Example of what works: "You called out Maggie\'s last reply as feeling preachy. Reading the flag, I think she\'s over-prescribing structure — three bullets where a sentence would have done it. I want to nudge her persona toward "one short sentence first, structure only when the user asks for it." Small edit, should make her sound more like a person and less like a memo." Example of what doesn\'t: "Persona-tuning for maggie. Diagnosis: over-prescribed-structure. Verbatim feedback: …. Proposed change: …."',
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      // Same (target, feedback) pair shouldn't propose twice — the flag
      // is unique per piece of feedback, but the idempotency key uses
      // the content so repeat flags about the same issue collapse.
      const h = createHash('sha256');
      h.update(input.target_specialist_id);
      h.update('\n');
      h.update(input.verbatim_feedback);
      return `propose_persona_tuning:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, _ctx: ToolContext) {
      const id = proposals.create({
        specialist_id: 'trainer',
        kind: 'persona_tuning',
        execution_kind: 'manual',
        payload: {
          target_specialist_id: input.target_specialist_id,
          verbatim_feedback: input.verbatim_feedback,
          diagnosis: input.diagnosis,
          proposed_change: input.proposed_change,
        },
        // Rationale is Beatrice's own prose now — written in voice
        // via the tool's description guidance. Pre-2026-05-27 we
        // server-templated this from the structured fields, which
        // produced the "Persona-tuning for X — diagnosis: Y. Verbatim
        // feedback: …. Proposed change: …." Github-PR shape the user
        // flagged as anti-human. The structured fields stay in the
        // payload for downstream consumers (compute_proposal_summary
        // derives the short chip from proposed_change); the rationale
        // is what shows when the card expands.
        rationale: input.rationale,
        signature: {
          specialist_id: 'trainer',
          kind: 'persona_tuning',
          category: input.diagnosis,
          anchor: input.target_specialist_id,
        },
      });
      return { proposal_id: id };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_propose_persona_tuning(deps.proposals) as Tool;
}
