/**
 * Per-tier discretion gating (Phase 2b).
 *
 * Three layers, defense in depth:
 *
 *   1. **Hard boundary** (`allowed_tiers`). The runtime checks this
 *      BEFORE calling the LLM at all. Callers outside the list get a
 *      canned refusal — no model invocation, no token spend, no
 *      jailbreak surface. Used for structurally owner-only specialists
 *      (Cassandra, Vivian).
 *
 *   2. **Soft visibility** (per-tier `open` / `defer` / `refuse`). The
 *      LLM runs but its system prompt carries per-tier guidance
 *      rendered by `render_discretion_block`. The persona text never
 *      changes; the runtime injects the right rules per turn.
 *
 *   3. **Data filtering** (memory file path resolution, RAG
 *      `private_to`, per-user namespace stamping). Even if the LLM
 *      misbehaves, the data it sees was already filtered for the
 *      caller's tier. That work lives in `memory_files.ts` and
 *      `MemoryClient.retrieve_scoped_chunks`.
 *
 * This module owns layers 1 and 2. Layer 3 is plumbed independently
 * via the user_id thread.
 *
 * Architectural principle: discretion is CONFIGURATION (YAML +
 * runtime renderer), not PERSONA PROSE. The persona describes who
 * the specialist is; discretion describes who they help and how.
 * Editing personas to add per-user rules bakes one user's relationship
 * into prose read every turn for every user — wrong layer.
 */

import type { LoadedSpecialist, VisibilityBehavior } from './specialist';
import type { Tier } from './users';

/** Resolves the caller's tier. Defaults to `owner` when unset —
 *  preserves legacy single-user code paths (deliberation, scheduler,
 *  internal HTTP calls) without forcing them to know about tiers. */
export function caller_tier(user: { tier?: Tier } | undefined): Tier {
  return user?.tier ?? 'owner';
}

/**
 * Hard boundary check. Returns `true` if the caller may even reach
 * this specialist's LLM. The owner tier is always allowed (the
 * captain never gates against the system she owns); for other tiers,
 * `allowed_tiers` (when set) is the gate.
 *
 * When `allowed_tiers` is unset, this returns true for everyone — the
 * specialist relies on soft-visibility behavior instead. That's the
 * right default for most specialists; sensitive ones (Cassandra,
 * Vivian) declare `allowed_tiers: [owner]` to opt INTO hard gating.
 */
export function is_caller_allowed(
  specialist: LoadedSpecialist,
  user: { tier?: Tier } | undefined,
): boolean {
  const tier = caller_tier(user);
  if (tier === 'owner') return true;
  const allow = specialist.discretion.allowed_tiers;
  if (!allow) return true;
  return allow.includes(tier);
}

/**
 * Returns the soft-visibility behavior the specialist should exhibit
 * for the given caller. Owner is always 'open'. Other tiers look at
 * the YAML.
 */
export function visibility_for(
  specialist: LoadedSpecialist,
  user: { tier?: Tier } | undefined,
): VisibilityBehavior {
  const tier = caller_tier(user);
  if (tier === 'owner') return 'open';
  return specialist.discretion.visibility[tier];
}

/**
 * Canned refusal text emitted when `is_caller_allowed` returns false
 * — the response the user sees when the hard boundary fires. Crafted
 * to be specialist-voice-neutral (the LLM never runs in this path, so
 * we can't lean on persona); warm, brief, points at the alternative.
 *
 * Specialists with their own custom refusal can override this by
 * setting `discretion.refusal_message` in YAML — not implemented
 * today, kept simple by design (Cassandra and Vivian both work well
 * with the generic shape).
 */
export function canned_refusal(
  specialist: LoadedSpecialist,
  user: { display_name?: string } | undefined,
): string {
  const name = user?.display_name ?? 'you';
  const defer = specialist.discretion.defer_to;
  return (
    `I appreciate you asking, ${name}, but ${specialist.name}'s domain is ` +
    `reserved for the captain. ${defer === 'kate' ? 'Kate' : defer} is the ` +
    `right person for cross-household questions in this area — she can ` +
    `help you directly or route to me on your behalf when appropriate.`
  );
}

/**
 * Renders the per-turn discretion guidance into a system-prompt block.
 * Empty string for owner callers (no per-turn injection needed —
 * full visibility is the default behavior). For other tiers, emits
 * positive enabling guidance per the the private dev log standard ("when a
 * household member asks about X, share Y; defer Z to Kate") — never a
 * prohibition list.
 *
 * Generic across specialists by design — specializing per specialist
 * (Brigid sounds like Brigid declining; Maggie sounds like Maggie
 * declining) is a Phase 2b iteration, not a Commit 1 concern. The
 * persona text itself does most of the voice work; this block adds
 * the policy hooks.
 */
export function render_discretion_block(
  specialist: LoadedSpecialist,
  user: { id?: string; display_name?: string; tier?: Tier } | undefined,
): string {
  const tier = caller_tier(user);
  if (tier === 'owner') return '';

  const name = user?.display_name ?? user?.id ?? 'a household user';
  const v = visibility_for(specialist, user);
  const defer = specialist.discretion.defer_to;
  const tracks_separately =
    specialist.discretion.per_user_tracking[tier] === true;

  const lines: string[] = [
    `**You are currently talking to: ${name} (tier: ${tier}).**`,
    `${name} is not the captain. Your responses to them follow the ` +
      `discretion policy below — same warmth as always, with the right ` +
      `data scope for who they are.`,
  ];

  if (v === 'open') {
    lines.push(
      `**Visibility: open.** Help ${name} fully within your domain. ` +
        `Anything you'd tell the captain about your domain, you can tell ` +
        `${name}.`,
    );
  } else if (v === 'defer') {
    lines.push(
      `**Visibility: defer.** When ${name} asks about your domain, give a ` +
        `brief warm acknowledgement of what they're after, then route them ` +
        `to ${defer} who handles cross-household questions in this area. ` +
        `Don't disclose specifics — that's ${defer}'s judgment to make ` +
        `with the full context, not yours to pre-empt.`,
    );
  } else if (v === 'refuse') {
    lines.push(
      `**Visibility: refuse.** Your domain is reserved for the captain. ` +
        `Decline ${name}'s request courteously in your voice, name ${defer} ` +
        `as the right person for them to ask, and offer to be looped in by ` +
        `${defer} if that's what they want. Don't lecture or list rules — ` +
        `a warm one-paragraph decline lands better than a wall.`,
    );
  }

  if (tracks_separately && v !== 'refuse') {
    lines.push(
      `**Track ${name} separately.** Their data in your domain (notes, ` +
        `preferences, history) is theirs alone — never aggregated with ` +
        `the captain's, never visible to peers without ${name}'s scope. ` +
        `When you write to the vault for them, the runtime stamps the ` +
        `note as theirs automatically; you just need to write in their ` +
        `voice and frame.`,
    );
  }

  return lines.join('\n\n');
}
