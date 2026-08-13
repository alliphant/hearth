import type { z } from 'zod';
import type { RiskTier } from './types';
import type { MemoryClient } from '@memory/client';
import type { LLMRouter } from './llm';
import type { Capability } from './capabilities';

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  risk: RiskTier;
  /**
   * Capabilities a specialist must have granted to invoke this tool. The
   * field is optional so legacy Scribe/Concierge tools (which run inside a
   * fixed-persona agent and bypass the specialist runtime) need no change.
   * New tools intended for specialists should declare this explicitly.
   */
  required_capabilities?: readonly Capability[];
  /**
   * When true, the tool is registered for proposal-dispatch execution but
   * is NOT surfaced in the specialist's list_for_capabilities — i.e. the
   * LLM never sees it. Used for `send_external` / `spend_money` tools that
   * must only run after explicit user approval at the proposals/decide
   * endpoint. The specialist exposes a sibling tool that creates a
   * proposal whose payload names this tool as its `dispatch_tool`; the
   * decide handler then invokes this tool with the user's verdict
   * standing in for gateway approval.
   */
  dispatch_only?: boolean;
  /**
   * Per-tool character budget for the LLM-facing copy of the tool's
   * result. Full result always lands in the audit log unchanged; this
   * only caps what re-enters the LLM's context on the next round.
   *
   * - `undefined` (default) → 4000-char smart truncation (head + high-
   *   signal lines from the body).
   * - `number` → custom budget (use e.g. 2000 for reliably-bulky tools
   *   like `web_fetch_clean` / `browse_url`).
   * - `'full'` → no truncation; pass the serialized result through
   *   verbatim. Reserve for tools whose output shape is bounded and
   *   structured (small JSON, fixed-size lists) where every field
   *   carries weight.
   *
   * See `src/core/tool_result_compaction.ts` and
   * docs/design-tool-output-compression.md.
   */
  llm_budget?: 'full' | number;
  /**
   * Execution weight, for the runtime's per-turn heavy-call cap.
   *
   * - `undefined` / `'light'` (default) → uncapped (cheap DB reads,
   *   local lookups, structured queries).
   * - `'heavy'` → counts against a per-turn budget. Reserve for slow,
   *   context-bloating external fetches (`web_fetch_clean`, `browse_url`,
   *   `web_search`) where an unbounded research fan-out both lags the turn
   *   and piles raw page text into the prompt. Past the cap the runtime
   *   short-circuits further heavy calls with a synthesize-now nudge; the
   *   model keeps its light tools and its already-gathered results.
   */
  weight?: 'light' | 'heavy';
  /**
   * When true, an identical (tool, args) call later in the SAME turn
   * re-executes instead of being served from the runtime's per-turn
   * duplicate-call cache. Set this on tools whose result depends on
   * mutable session state the turn itself is changing — the workbench
   * family is the canonical case: `workbench_check {}` after a fix MUST
   * compile again, not re-serve the pre-fix verdict. Leave unset for
   * idempotent reads (the cache exists to absorb retry storms on those).
   */
  volatile?: boolean;
  /**
   * Declares which fields of this tool's RESULT carry its yield — the
   * "did this run actually produce anything?" signal that error rate
   * cannot see (2026-08-01).
   *
   * A capability can SUCCEED its way to zero output: `extract_meeting_votes`
   * ran 59 times, fetched 82 documents, recorded 3 votes, and returned
   * `ok: true` every single time. Every detector Hearth has agreed it was
   * healthy — `system_health` keys on error rate, `guard_feedback` fires on
   * guard catches, the miss ledger needs something to fail.
   *
   * `produced` names the result field(s) counting rows/artifacts WRITTEN.
   * `considered` names the field(s) counting the upstream work the run had
   * available. The distinction is the whole point: `considered: 0,
   * produced: 0` is HONEST IDLE (nothing to do — never a miss), while
   * `considered: 8, produced: 0` is the pathology (work arrived and nothing
   * came out).
   *
   * ONLY A DECLARATION ARMS THE ALARM. An undeclared tool falls back to a
   * name-convention reader (`src/core/capability_yield.ts`) whose zero is
   * REPORTED and never escalated, because the first live run proved a
   * convention read wrong two ways: a detector's correct output is zero
   * (`scan_system_health` returning `unhealthy: []` after checking 80
   * dependencies is the GOOD outcome), and the convention can match a
   * produced field while reading the WRONG one.
   *
   * `{ none: true, reason }` is the OTHER declaration, and it is not the same
   * as leaving this off. Absence means "nobody has looked at this yet";
   * `none` means "somebody looked and this tool has no row-writing purpose."
   * A pure read, a detector, a manual drill. Recording that judgment is what
   * lets `smoke:yield-coverage-lint` tell an un-triaged capability from a
   * deliberately-exempt one — without it the coverage gap silently re-opens
   * the next time someone adds a background job.
   */
  yield?:
    | {
        /** Result field(s) counting artifacts written. First present one wins. */
        produced: readonly string[];
        /**
         * Result field(s) counting upstream work available. First present wins.
         *
         * ⚠ AN ARMED CONTRACT WITHOUT THIS IS INERT. `barren` requires
         * `active_runs >= yield_min_active_runs()`, and a run only counts as
         * active when `considered > 0` — so `{ produced: ['x'] }` alone can
         * never escalate no matter how many zero-output runs it sees (8
         * consecutive zeros verdict `idle`). That silence is by design: with no
         * measure of whether work arrived, "produced 0" cannot be told from
         * "there was nothing to do", and guessing would page on quiet nights.
         *
         * Say `armed: false` when you mean reporting-only, so the intent is on
         * the record. `smoke:yield-coverage-lint` fails an armed-by-default
         * contract with no `considered`, because a declaration that silently
         * does nothing is precisely the class this subsystem exists to catch.
         */
        considered?: readonly string[];
        /**
         * Whether a sustained zero here should ESCALATE (file a miss + wake
         * Beatrice) or merely be reported. Defaults to `true`.
         *
         * Set `false` for a capability whose counts are genuinely meaningful —
         * so naming the fields beats the name-convention guess — but where a
         * zero run is a normal quiet night rather than a defect. Most scans
         * are this: they report real numbers AND legitimately find nothing.
         *
         * Without this there is no way to say "these are the right fields, but
         * don't page me" — you would have to choose between arming a tool that
         * is often correctly idle (a nightly false alarm that trains everyone
         * to ignore the signal) and exempting it (throwing away counts that are
         * worth watching). Both are worse than the truth.
         */
        armed?: boolean;
      }
    | {
        /** This capability writes nothing by design — exempt, deliberately. */
        none: true;
        /** Why. Read by a human triaging the roster; keep it one sentence. */
        reason: string;
      };
  /**
   * `I` / `O` are the PARSED (output) types — what `execute` receives and
   * returns. The schemas' own input types are left unconstrained
   * (`unknown`) so a schema that uses `.default()`, `.coerce`, or
   * `.transform()` — where the pre-parse input shape differs from the
   * parsed shape — still satisfies the interface. The registry always
   * `safeParse`s raw `unknown` input anyway.
   */
  input_schema: z.ZodType<I, z.ZodTypeDef, unknown>;
  output_schema: z.ZodType<O, z.ZodTypeDef, unknown>;
  idempotency_key(input: I): string;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolCall<I = unknown> {
  tool_name: string;
  input: I;
  idempotency_key: string;
  rationale: string;
}

export interface ToolContext {
  memory: MemoryClient;
  llm: LLMRouter;
  now: Date;
  intent_id: string;
  /**
   * Conversation the tool was invoked within. Populated by the specialist
   * runtime; absent for tools invoked outside a conversation (e.g.
   * dispatch-only execution, scheduler-driven scripts). Tools that need
   * to write back to the conversation (promise_followup) must check this.
   */
  conversation_id?: string;
  /**
   * Specialist whose turn invoked the tool. Same caveats as
   * conversation_id — absent in non-specialist contexts.
   */
  specialist_id?: string;
  /**
   * Phase 2b — the calling user (id + tier). Set by the specialist
   * runtime when the turn carries a `user`. Tools that write to the
   * vault should pass this into `MemoryClient.upsert_note` so the
   * `private_to` stamp lands automatically; tools that mutate
   * external state should pass the user id into `log_action` so the
   * audit row attributes correctly.
   *
   * Absent for system-initiated tool calls (deliberation, scheduler,
   * test fixtures). Treat absence as legacy owner-default behavior.
   */
  user?: { id: string; tier: import('./users').Tier; timezone?: string };
  /**
   * RAG embedder (Pass 7). Set by the specialist runtime so tools like
   * `search_library` fuse vector search with FTS via `retrieve_hybrid`.
   * Absent → the tool uses a NoopEmbedder (FTS-only). Optional so the
   * many non-runtime ToolContext construction sites compile unchanged.
   */
  embedder?: import('./embeddings').Embedder;
  /**
   * Cancellation for tools that make their own long-running calls (2026-08-05).
   *
   * Set by the specialist runtime to the turn's own signal, so pressing Stop
   * actually cancels an in-flight model call inside a tool — before this,
   * `consult_deep_model` held a 300s `deep_consult` request that no cancel
   * could reach, and the slot stayed occupied long after the user had left.
   *
   * The escalate-on-evidence path narrows it further for its one forced call:
   * `AbortSignal.any([turn_signal, AbortSignal.timeout(budget)])`, so the deep
   * leg is bounded by HEARTH_ESCALATE_BUDGET_MS rather than by the role's
   * timeout. Tools that ignore it behave exactly as before.
   */
  signal?: AbortSignal;
}
