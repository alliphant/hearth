import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolRegistry } from '@core/tool_registry';
import type { SpecialistRegistry } from '@core/specialist';
import type { ProposalsStore, ProposalKind, ProposalExecutionKind } from '@core/proposals';

const SignatureExtraValue = z.union([z.string(), z.number(), z.boolean()]);

const SignatureSchema = z
  .object({
    // Attribution is ambient — execute() resolves the filer from
    // ctx.specialist_id, mirroring deliberation.ts forcing
    // `specialist_id: specialist.id` on envelope proposals. The field
    // stays accepted (the model emits it; rejecting would seed an
    // arg-spiral) but is honored only for non-specialist callers
    // (smokes, dispatch contexts). The old `.default('kate')` made the
    // ctx fallback in execute() dead code AND let LLM-authored display
    // names and typos ('beatrice', 'maggia', 'all') land as live rows.
    specialist_id: z.string().optional(),
    kind: z.string(),
    category: z.string(),
    anchor: z.string().optional(),
    extras: z.record(z.string(), SignatureExtraValue).optional(),
  })
  .strict();

const InputSchema = z.object({
  action_spec: z.record(z.string(), z.unknown()),
  // OPTIONAL on purpose (2026-06-18). The voice-contract description below
  // asks for a rich first-person rationale and the model normally provides
  // one — but a hard `.min(1)` required field is an arg-spiral seed: under a
  // heavy deliberation pass the 35B intermittently omits it, hits
  // INPUT_VALIDATION_FAILED, retries identically, and the turn dies in
  // same_tool_spiral_exhaust → blank_turn_fallback — taking the whole pass
  // (including Kate's brief) down with it (14 jasper blank-turns in 14 days,
  // this being the dominant trigger). Per the arg-spiral rule: accept the
  // shape the model emits and DERIVE the omitted value in execute()
  // (`effective_rationale`) rather than rejecting. A weak auto-rationale is
  // far better than a dead turn.
  rationale: z.string().min(1).optional(),
  kind: z
    .enum([
      'draft_message',
      'action_proposal',
      'briefing',
      'recommendation',
      // Beatrice's structural-gap binding proposal (see ProposalKind
      // doc in src/core/proposals.ts). Persona prescribes this kind.
      'binding_proposal',
      // Beatrice's scrum-board blocking judgment call / sprint-commit gate.
      // Judgment call: execution_kind 'none' + action_spec.options. Commit
      // gate: dispatch_tool 'scrum_sprint_write' so approval runs the commit.
      'scrum_decision',
    ])
    .default('action_proposal'),
  execution_kind: z
    .enum(['manual', 'dispatch', 'web_action', 'composite', 'none'])
    .default('manual'),
  // When the action is a concrete tool the system should run on
  // approval, name it here. Setting `dispatch_tool` files the proposal
  // as a `dispatch` proposal — on approval the decide route invokes the
  // tool automatically (as the owning specialist). Omit both for a
  // manual recommendation a human will act on.
  dispatch_tool: z.string().optional(),
  dispatch_input: z.record(z.string(), z.unknown()).optional(),
  category_signature: SignatureSchema,
});

const OutputSchema = z.object({
  proposal_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * The rationale to hash + store. Returns the model's rationale when present
 * (the norm); otherwise derives a non-empty one from the action_spec so an
 * omitted field can't seed an arg-spiral (see the schema note). Pure +
 * deterministic so it's identical in idempotency_key and execute.
 */
export function effective_rationale(input: Pick<Input, 'rationale' | 'action_spec' | 'kind'>): string {
  if (input.rationale && input.rationale.trim().length > 0) return input.rationale.trim();
  const spec = (input.action_spec ?? {}) as Record<string, unknown>;
  for (const k of ['summary', 'rationale', 'description', 'title', 'reason', 'note', 'subject']) {
    const v = spec[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return `Proposed ${input.kind.replace(/_/g, ' ')} — see the action details.`;
}

/**
 * A proposal is "report-shaped" — a brief, scan recap, digest, or status
 * flag — when it carries no executable action and self-declares as
 * informational. Those belong in the brief (the deliberation morning_brief
 * envelope, persisted to the briefs table and surfaced via /api/briefs) or, for
 * an ad-hoc heads-up, a normal chat reply in the Kate thread — NOT the
 * "awaiting your nod" queue, where they render a meaningless "Run" button and
 * inflate autonomy-graduation counts for a signature that should never
 * auto-approve.
 *
 * Detected only for `action_proposal` (every other kind has a real
 * resolver). Signal sources, drawn from what Kate's deliberation has
 * actually emitted: the category signature's kind/category, a nested
 * `action_spec.kind.{type,kind,category}` (e.g. `civic_briefing`,
 * `evening_brief`), and a `status_flag` subject. A named `dispatch_tool`
 * is always a real action and never reaches this check.
 */
const REPORT_SHAPE = /brief|scan|digest|recap/i;

function is_report_shaped(
  kind: string,
  sig: { kind?: string; category?: string },
  action_spec: Record<string, unknown>,
): boolean {
  if (kind !== 'action_proposal') return false;
  const labels: Array<string | undefined> = [sig.kind, sig.category];
  const inner = action_spec?.kind;
  if (inner && typeof inner === 'object') {
    const k = inner as Record<string, unknown>;
    labels.push(
      typeof k.type === 'string' ? k.type : undefined,
      typeof k.kind === 'string' ? k.kind : undefined,
      typeof k.category === 'string' ? k.category : undefined,
    );
  }
  if (labels.some((l) => typeof l === 'string' && REPORT_SHAPE.test(l))) {
    return true;
  }
  const subject = action_spec?.subject;
  return Boolean(
    subject &&
      typeof subject === 'object' &&
      (subject as Record<string, unknown>).type === 'status_flag',
  );
}

/**
 * A self-addressed note — an `action_proposal` whose only "action" is a
 * message to the proposing specialist herself (e.g. Kate filing a FRIDAY
 * status note addressed `to: kate`). That's an internal FYI, never a user
 * decision, so it doesn't belong in the queue. Recipient id is read from
 * the shapes deliberation emits: recipient.{id,specialist_id},
 * recipient_id, to.{specialist_id,id}, to_specialist_id, or a bare `to`.
 */
function addressed_to_self(
  self_id: string,
  action_spec: Record<string, unknown>,
): boolean {
  if (!self_id) return false;
  const obj = (v: unknown): Record<string, unknown> | undefined =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  const recipient = obj(action_spec?.recipient);
  const to = obj(action_spec?.to);
  const candidates: Array<unknown> = [
    recipient?.id,
    recipient?.specialist_id,
    action_spec?.recipient_id,
    to?.specialist_id,
    to?.id,
    action_spec?.to_specialist_id,
    typeof action_spec?.to === 'string' ? action_spec.to : undefined,
  ];
  const self = self_id.toLowerCase();
  return candidates.some((c) => typeof c === 'string' && c.toLowerCase() === self);
}

/**
 * The internal-action gate (2026-07-04, "Kate actually solves shit").
 *
 * An `action_proposal` whose named executable action is INTERNAL — the
 * registry says the tool's declared risk tier is `read`/`write_internal` —
 * needs NO owner approval under the standing permission floor (only
 * send_external / spend_money / step-up do). Carding it parks work the
 * specialist could do RIGHT NOW behind a meaningless approve tap; that's
 * how the queue hit ~77 pending, mostly "want me to…?" offers whose
 * underlying action was a promise_followup / record_person_pref /
 * set_event_owner away. The gate rejects the filing with a steering
 * message; the model reads it and calls the tool directly. Nothing
 * expressible is lost: dispatch execution runs with the SAME filer
 * capabilities the direct call uses, so any dispatch this gate rejects
 * would have been runnable inline (or would have failed identically on
 * approval).
 *
 * Classification is REGISTRY DATA — the named tool's `risk` — never a
 * keyword list (LAW #1). Exclusions, each load-bearing:
 *   - `kind !== 'action_proposal'` — system kinds (binding_proposal,
 *     recommendation, scrum_decision…) have review flows of their own.
 *   - `dispatch_only` tools run ONLY via approval by design (the merge
 *     gate) — never steer those to a direct call.
 *   - `requires_step_up: true` or a positive `amount_cents` in the spec
 *     marks the permanent owner floor regardless of the named tool's tier.
 *   - unknown tool / no registry wired → fail-open to filing (we can't
 *     classify what we can't resolve; a judgment-shaped proposal naming
 *     no tool is untouched — that's the addenda's job, not the gate's).
 *
 * Kill switch: HEARTH_INTERNAL_ACTION_GATE=0 (read at call time).
 */
export const INTERNAL_RISK_TIERS: ReadonlySet<string> = new Set(['read', 'write_internal']);

export function internal_action_gate_enabled(): boolean {
  return process.env.HEARTH_INTERNAL_ACTION_GATE !== '0';
}

/**
 * The tool an action_proposal names as its executable action, wherever the
 * model put it: the top-level `dispatch_tool` arg, a `dispatch_tool` nested
 * inside action_spec (the decide route reads it from the payload, so a
 * nested one is just as live), or `tool_name` (what the card's "Run <tool>"
 * approve verb renders from — see proposal_render.compute_proposal_actions).
 * A spec that names no tool returns undefined and the gate stays out of it.
 */
export function named_action_tool(
  dispatch_tool: string | undefined,
  action_spec: Record<string, unknown>,
): string | undefined {
  const spec = action_spec ?? {};
  const candidates: unknown[] = [dispatch_tool, spec.dispatch_tool, spec.tool_name];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

export interface ProposeActionDeps {
  /** Live tool registry — the risk-tier source for the internal-action
   *  gate. Optional so bare constructions (contract smokes) compile and
   *  fail open to filing. */
  tool_registry?: Pick<ToolRegistry, 'get' | 'check'>;
  /** Specialist registry — resolves the filer's granted set so the
   *  rejection can steer accurately ("call it now" vs "delegate it"). */
  specialists?: Pick<SpecialistRegistry, 'get'>;
}

export function make_propose_action(
  proposals: ProposalsStore,
  deps: ProposeActionDeps = {},
): Tool<Input, Output> {
  return {
    name: 'propose_action',
    description:
      'Create a structured proposal of any kind. Use when you have a concrete action or recommendation worth queuing for the user to approve, deny, or edit. Only actions that genuinely need the user\'s permission belong here — sending something out of the household, spending money, step-up actions, or a real judgment call between options. Internal work (a reminder/follow-up, recording a fact, attributing an event, a note, a flag to a teammate) never needs a proposal: call the tool that does it, then tell the user what you did. Provide a category_signature so similar proposals accumulate toward autonomy graduation. If the action is a concrete tool the system should run, pass `dispatch_tool` (the tool name) and `dispatch_input` (its arguments) — the proposal is then filed as a dispatch proposal and EXECUTES AUTOMATICALLY when the user approves it. Omit them for a manual recommendation a human will carry out.\n\n' +
      'Voice contract for `rationale` (this matters — the user reads the rationale every time they expand the card): write in YOUR voice, first-person, the way you talk in chat. Tell them what you noticed, what you want to do about it, and why. 2–5 sentences usually. Address them in second person ("you mentioned X yesterday — I want to…"). Do NOT use Github-PR shape (no bulleted "Problem: …" / "Fix: …", no "Closes N issues" footer). Do NOT restate the action_spec fields — those render separately under the rationale. Do NOT log routine bookkeeping as a proposal ("Cordelia routed two captures, logging for the record. No action needed.") — if there\'s nothing for the user to act on, don\'t file a proposal at all. Example of what works: "You mentioned the vet bill from Tuesday — I want to push it to Vivian so it lands on next month\'s budget instead of slipping into general expenses. She\'ll need to know it\'s a one-off, not the start of a vet-bill pattern." Example of what doesn\'t: "Problem: vet bill uncategorized. Fix: route to Vivian. Impact: budget accuracy."\n\n' +
      'When a binding_proposal / recommendation / persona_tuning addresses open process misses, include `closes_miss_ids` in action_spec: the pm_* ids copied VERBATIM from the ledger. That set is the proposal\'s durable subject — a later filing citing the same misses supersedes the open card instead of stacking a duplicate, so citing them keeps the queue clean. Never compose or guess an id.',
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(JSON.stringify(input.action_spec));
      h.update('\n');
      h.update(effective_rationale(input));
      h.update('\n');
      h.update(input.dispatch_tool ?? '');
      return `propose_action:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext) {
      // The filing specialist is ambient context: ctx.specialist_id is
      // the canonical registered id the runtime threads into every
      // specialist turn, and it WINS over whatever the LLM wrote in
      // category_signature.specialist_id. The authored field was pure
      // noise in practice — trainer's turns filed live rows under
      // 'beatrice' (display name), 'maggia' (typo), and 'all'
      // (2026-06-08..10), breaking per-specialist queue filters and
      // signature/autonomy attribution. The LLM value is honored only
      // when there is no specialist context (dispatch contexts, smoke
      // scripts), where ProposalsStore.create()'s registry resolver
      // still normalizes display names/aliases and rejects unknowns.
      // Falls back to "kate" when both are absent (historical default).
      const filer =
        ctx.specialist_id ?? input.category_signature.specialist_id ?? 'kate';
      const sig = { ...input.category_signature, specialist_id: filer };

      // Beatrice (trainer) is a self-improvement / meta agent: her output is
      // a SYSTEM-kind proposal (binding_proposal / persona_tuning /
      // recommendation), which is owner-global AND flows through Kate's review
      // before it lands as a fix. `action_proposal` is the one kind that is
      // NOT a system kind and NOT reviewed — it surfaces a raw card straight
      // to the owner queue. That's exactly how 16 "Cordelia has 8 read-failure
      // misses" cards leaked in (2026-06-15). A process miss is resolved
      // INSIDE the loop — Mariah drives it (route/escalate), Beatrice fixes it
      // with her system-kind tools, Kate reviews — never carded to the owner.
      // So refuse action_proposal from trainer at the tool layer and point her
      // at the right path. (binding_proposal et al. pass straight through.)
      if (filer === 'trainer' && input.kind === 'action_proposal') {
        throw new Error(
          'Beatrice does not file action_proposal — that posts a raw card to ' +
            "the owner's queue, bypassing Kate's review and the internal loop. " +
            'For a process miss, resolve it inside the loop: diagnose the fix ' +
            'class and use the matching system-kind tool — ' +
            'propose_connector_recovery_hint (connector affordance gap), ' +
            'propose_persona_tuning (persona gap), apply_low_risk_fix (config ' +
            'gap, no proposal), or write_binding_proposal then ' +
            "propose_action({ kind: 'binding_proposal', … }) (tooling gap). A " +
            'miss you cannot fix yet stays in Mariah’s ledger for her to ' +
            'route or re-escalate — do not card it to the owner.',
        );
      }

      // A named dispatch_tool makes this a real dispatch proposal: the
      // decide route reads `dispatch_tool` / `dispatch_input` from the
      // payload and runs the tool on approval. Force execution_kind so
      // an LLM can't file a runnable action as un-runnable `manual`.
      const has_dispatch =
        typeof input.dispatch_tool === 'string' && input.dispatch_tool.length > 0;

      // Guard: propose_action queues an ACTION the user decides on with a
      // concrete outcome — not a report. A brief, scan recap, or status
      // flag belongs in the brief (persisted + surfaced via /api/briefs),
      // never the approval queue. A dispatch_tool is always a real action, so
      // it bypasses this. Otherwise reject report-shaped payloads and point
      // the caller at the brief.
      if (
        !has_dispatch &&
        input.kind === 'action_proposal' &&
        (is_report_shaped(input.kind, sig, input.action_spec) ||
          addressed_to_self(filer, input.action_spec))
      ) {
        throw new Error(
          'This is a report or a note to yourself, not an action awaiting the ' +
            "user's decision — it does not belong in the proposal queue. Put it " +
            'in your brief (the noticed / attention_today / watching sections — ' +
            'the brief is persisted and surfaced to the user on its own), or send ' +
            'it as a normal chat reply in your thread. Reserve propose_action for a ' +
            'concrete action the USER approves to execute: route something to a ' +
            'specialist, add a calendar event, send a draft, or run a tool via ' +
            'dispatch_tool.',
        );
      }

      // The internal-action gate — see the doc block above INTERNAL_RISK_TIERS.
      // An action_proposal naming a runnable tool whose registry risk tier is
      // internal (read / write_internal) is work the specialist should DO, not
      // card: the permission floor is send_external / spend_money / step-up
      // only. Rejection is a steering error the model acts on this turn.
      if (input.kind === 'action_proposal' && deps.tool_registry && internal_action_gate_enabled()) {
        const spec = input.action_spec as Record<string, unknown>;
        const named = named_action_tool(input.dispatch_tool, spec);
        const named_tool = named ? deps.tool_registry.get(named) : undefined;
        const owner_floor =
          spec.requires_step_up === true ||
          (typeof spec.amount_cents === 'number' && spec.amount_cents > 0);
        if (
          named &&
          named_tool &&
          !named_tool.dispatch_only &&
          INTERNAL_RISK_TIERS.has(named_tool.risk) &&
          !owner_floor
        ) {
          const floor_line =
            `\`${named}\` is ${named_tool.risk} — internal work needs no owner ` +
            'approval (the permission floor is send_external / spend_money / ' +
            'step-up only), so it does not belong in the proposal queue. ';
          const filer_cfg = deps.specialists?.get(filer);
          const missing = filer_cfg
            ? deps.tool_registry.check(named, filer_cfg.granted)
            : null;
          if (missing) {
            throw new Error(
              floor_line +
                `You can't run it yourself (missing capability: ${missing}) — ` +
                'hand it to the teammate who owns it instead: delegate the task ' +
                'or flag their inbox, then tell the user what you set in motion. ' +
                'Do not re-file this proposal.',
            );
          }
          throw new Error(
            floor_line +
              `Do it NOW: call \`${named}\` yourself this turn` +
              (has_dispatch ? ' with the input you attached as dispatch_input' : '') +
              ', then tell the user what you did (in your reply, or your brief ' +
              'when deliberating). Reserve proposals for actions that send ' +
              'externally, spend money, or need step-up — and for a genuine ' +
              'judgment call between options, prefer present_questions.',
          );
        }
      }

      const execution_kind: ProposalExecutionKind = has_dispatch
        ? 'dispatch'
        : (input.execution_kind as ProposalExecutionKind);
      const payload = has_dispatch
        ? {
            ...input.action_spec,
            dispatch_tool: input.dispatch_tool,
            dispatch_input: input.dispatch_input ?? {},
          }
        : input.action_spec;

      const id = proposals.create({
        specialist_id: filer,
        kind: input.kind as ProposalKind,
        // Cordon to the originating user. create() forces NULL for system
        // kinds (e.g. 'recommendation'), so this is a no-op for those.
        user_id: ctx.user?.id ?? null,
        execution_kind,
        payload,
        rationale: effective_rationale(input),
        signature: sig,
      });
      return { proposal_id: id };
    },
  };
}
