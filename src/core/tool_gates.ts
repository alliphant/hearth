/**
 * Per-tool tier gates (Phase 2b Commit 4).
 *
 * Most tier discrimination in Hearth lives at the SPECIALIST layer —
 * `allowed_tiers` and the per-tier discretion block decide which
 * specialists a caller may reach, which is usually enough because each
 * specialist's tool surface is hand-picked for the work that
 * specialist does. But a few tools warrant a SECOND check at the tool
 * boundary as defense in depth:
 *
 *   - **Tools that any future specialist might be granted** by
 *     mistake — `query_audit_log`, anything reading the location
 *     snapshot. The right posture for these is "even if the
 *     specialist were misconfigured, the tool itself refuses."
 *     One missing line in a YAML grant should not become a leak.
 *
 *   - **Tools that bear personally-identifying or location-sensitive
 *     state** independent of which specialist holds them —
 *     `friday_status`, `plex_*`, `music_*`. These are the kind of
 *     data where the right ceiling is the household, not "whoever
 *     can reach Maggie."
 *
 * The helper this file exports is a single throw-with-clear-error
 * function the tool's `execute()` calls before doing anything else.
 * The thrown error gets surfaced to the LLM in its tool-call response
 * as an actionable hint ("you don't have access; ask Kate"); the
 * runtime then short-circuits the tool round.
 *
 * Architectural principle: the persona text + specialist hard refusal
 * are the FIRST line of defense; this file is the SECOND. The vault
 * `private_to` filter is the THIRD. Each independent layer covers
 * misconfigurations the others might miss.
 */

import type { Tier } from './users';
import type { ToolContext } from './tool';

export class CallerTierForbidden extends Error {
  constructor(
    readonly tool_name: string,
    readonly caller_tier: Tier,
    readonly allowed: readonly Tier[],
    readonly defer_to: string,
  ) {
    super(
      `TIER_FORBIDDEN: \`${tool_name}\` is restricted to [${allowed.join(
        ', ',
      )}] callers; your tier is "${caller_tier}". Don't retry — the ` +
        `tool will refuse identically every time. Either route this question ` +
        `to ${defer_to} via consult_specialist, or tell the user this is ` +
        `outside your scope and ${defer_to} handles it.`,
    );
    this.name = 'CallerTierForbidden';
  }
}

/**
 * Throws CallerTierForbidden if the caller's tier isn't in the allowed
 * list. Absent caller (deliberation / scheduler / legacy single-user
 * paths) defaults to owner, so internal callers pass without changes.
 *
 * Tool authors call this immediately at the top of `execute()`:
 *
 *   ```ts
 *   async execute(input, ctx) {
 *     require_caller_tier(ctx, ['owner'], 'kate');  // owner-only
 *     // ... rest of the tool
 *   }
 *   ```
 *
 * Or for tools the household tier may use but friends may not:
 *
 *   ```ts
 *   require_caller_tier(ctx, ['owner', 'household'], 'kate');
 *   ```
 *
 * The runtime catches the thrown error and surfaces the message to the
 * LLM as a tool error result — same path as any other execute() throw.
 * No special audit code path is needed.
 */
export function require_caller_tier(
  ctx: ToolContext,
  allowed: readonly Tier[],
  defer_to = 'kate',
): void {
  const tier: Tier = ctx.user?.tier ?? 'owner';
  if (allowed.includes(tier)) return;

  // Find the tool name from a sentinel symbol if the ctx carries one,
  // otherwise fall back to a generic message. ToolContext doesn't carry
  // tool_name today (and shouldn't — it's set per-call, not per-context)
  // so we accept a generic error here. The runtime's audit row already
  // captures tool_name separately.
  throw new CallerTierForbidden('this tool', tier, allowed, defer_to);
}
