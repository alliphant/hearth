/**
 * Trust Ladder — the RPG XP/level layer over the autonomy graduation ladder
 * (2026-06-20). Jasper's framing: draft→tap→PIN stays the permanent floor (Kate
 * never silently sends/spends), but each accepted action awards XP weighted by
 * action × risk; XP levels her up PER SKILL (per category-signature); levels
 * gate (and, later, unlock) more capability. The closed loop reinforces her
 * doing the right things.
 *
 * This module is PURE — no import of proposals.ts (avoids a cycle). It owns:
 *   - the XP weighting (risk class × effect multiplier)
 *   - the XP→level derivation (0..3, presentation + the graduation XP gate)
 *   - the kill switch (HEARTH_TRUST_XP)
 *
 * The accrual (UPDATE category_signatures SET xp = …) and the
 * graduation gate (xp >= threshold, ANDed with the approval-count gate) live in
 * proposals.ts, which reads `AutonomyConfig.trust_xp` (these defaults, YAML-
 * overridable). DARK by default: off → no XP is written and graduation is
 * byte-identical to today.
 */

export type TrustEffect = 'approve' | 'approve_modified' | 'deny';
export type RiskClass = 'low' | 'medium' | 'high';

export interface TrustXpConfig {
  /** Base XP per accepted action, by the action's risk class. */
  base_xp_by_risk: Record<RiskClass, number>;
  /** Effect multiplier: a clean accept earns full; an edited accept earns
   *  partial (Kate's draft needed work); a denial SUBTRACTS (trust lost). */
  effect_multiplier: Record<TrustEffect, number>;
  /**
   * XP (per signature) required to be ELIGIBLE to graduate FROM each tier —
   * ANDed with the existing approval-count gate, never replacing it. Keyed by
   * the from-tier. A signature with the approvals but not the XP keeps
   * accruing; the recommendation simply isn't surfaced yet.
   */
  level_xp_thresholds: { tier2a: number; tier2b: number; tier2c: number };
}

export const TRUST_XP_DEFAULTS: TrustXpConfig = {
  base_xp_by_risk: { low: 1, medium: 3, high: 8 },
  effect_multiplier: { approve: 1, approve_modified: 0.4, deny: -1 },
  level_xp_thresholds: { tier2a: 8, tier2b: 30, tier2c: 80 },
};

/** Kill switch — when off, no XP is awarded and the XP graduation gate no-ops,
 *  leaving autonomy graduation byte-identical to pre-Trust-Ladder. */
export function trust_xp_enabled(): boolean {
  return process.env.HEARTH_TRUST_XP === '1';
}

/**
 * Derive the risk class of a proposed action from what the proposal carries —
 * money or a step-up-gated action is `high`; an externally-effecting dispatch
 * is `medium`; a draft / informational proposal is `low`. (We don't have the
 * tool's RiskTier on the proposal row, so this reads the proposal's own
 * risk-bearing fields, which the autonomy/PIN layer already keys on.)
 */
export function risk_class_for(p: {
  amount_cents?: number | null;
  requires_step_up?: boolean;
  execution_kind?: string | null;
}): RiskClass {
  if ((typeof p.amount_cents === 'number' && p.amount_cents > 0) || p.requires_step_up === true) {
    return 'high';
  }
  if (p.execution_kind === 'dispatch' || p.execution_kind === 'web_action') return 'medium';
  return 'low';
}

/** XP delta for one decided action. Positive on accept, negative on deny. */
export function xp_for(
  input: { effect: TrustEffect; risk: RiskClass },
  cfg: TrustXpConfig = TRUST_XP_DEFAULTS,
): number {
  return cfg.base_xp_by_risk[input.risk] * cfg.effect_multiplier[input.effect];
}

/**
 * Map accumulated XP → a 0..3 RPG level (presentation + the graduation XP
 * gate). Level N is reached once XP clears the threshold to LEAVE the
 * corresponding tier. Graduation itself still flows through
 * check_graduation_candidates (this is a gate, not the actuator).
 */
export function level_for(xp: number, cfg: TrustXpConfig = TRUST_XP_DEFAULTS): number {
  let lvl = 0;
  if (xp >= cfg.level_xp_thresholds.tier2a) lvl = 1;
  if (xp >= cfg.level_xp_thresholds.tier2b) lvl = 2;
  if (xp >= cfg.level_xp_thresholds.tier2c) lvl = 3;
  return lvl;
}

/** XP a signature must hold to graduate FROM `status`. Mirrors the
 *  approval-count `threshold_for` in proposals.ts. `status` is the autonomy
 *  tier string (kept loose to avoid importing the enum / a cycle). */
export function xp_threshold_for(status: string, cfg: TrustXpConfig = TRUST_XP_DEFAULTS): number | null {
  switch (status) {
    case 'tier2a':
      return cfg.level_xp_thresholds.tier2a;
    case 'tier2b':
      return cfg.level_xp_thresholds.tier2b;
    case 'tier2c':
      return cfg.level_xp_thresholds.tier2c;
    default:
      return null;
  }
}

// ── Specialist rank badges (Hearth badges, 2026-06-20) ───────────────────────
// A specialist's OVERALL standing — a copper→silver→gold→platinum→diamond badge
// from their TOTAL accrued XP (the sum of every accepted action across all their
// skills). Distinct from the per-signature graduation gate above: this is the
// gamified, user-facing rank shown on the chat surface + office. The level
// curve is its own progression (cost-to-next grows linearly), so early levels
// come fast and later ones are earned.

export interface RankTier {
  key: 'copper' | 'silver' | 'gold' | 'platinum' | 'diamond';
  name: string;
  /** First level (inclusive) at which this tier begins. */
  min_level: number;
}

export const RANK_TIERS: readonly RankTier[] = [
  { key: 'copper', name: 'Copper', min_level: 1 },
  { key: 'silver', name: 'Silver', min_level: 3 },
  { key: 'gold', name: 'Gold', min_level: 6 },
  { key: 'platinum', name: 'Platinum', min_level: 10 },
  { key: 'diamond', name: 'Diamond', min_level: 15 },
];

/** XP cost from level N → N+1 grows linearly: BASE × N. So cumulative XP to
 *  REACH level L is BASE × (L-1)L/2 (triangular). Tunable. */
const RANK_XP_BASE = 10;
const RANK_MAX_LEVEL = 999; // loop backstop

/** Cumulative XP required to reach `level` (level 1 = 0 XP). */
export function xp_to_reach_level(level: number, base = RANK_XP_BASE): number {
  if (level <= 1) return 0;
  return (base * (level - 1) * level) / 2;
}

/** The highest level whose cumulative XP requirement is met by `total_xp`. */
export function specialist_level_for(total_xp: number, base = RANK_XP_BASE): number {
  const xp = Math.max(0, total_xp);
  let level = 1;
  while (level < RANK_MAX_LEVEL && xp_to_reach_level(level + 1, base) <= xp) level++;
  return level;
}

export interface SpecialistRank {
  xp: number;
  level: number;
  tier: RankTier['key'];
  tier_name: string;
  /** XP earned INTO the current level (for the bar fill). */
  xp_into_level: number;
  /** XP span of the current level (bar denominator). */
  xp_for_level: number;
  /** XP remaining to the next level ("X to next"). */
  xp_to_next: number;
  /** Bar fill fraction [0,1]. */
  pct: number;
  /** The next tier the specialist is climbing toward (null at the top). */
  next_tier: { key: RankTier['key']; name: string; at_level: number } | null;
}

/** Compute a specialist's badge from their total accrued XP. Pure. */
export function compute_specialist_rank(total_xp: number, base = RANK_XP_BASE): SpecialistRank {
  const xp = Math.max(0, total_xp);
  const level = specialist_level_for(xp, base);
  const cur_start = xp_to_reach_level(level, base);
  const next_start = xp_to_reach_level(level + 1, base);
  const xp_into_level = xp - cur_start;
  const xp_for_level = Math.max(1, next_start - cur_start);
  const xp_to_next = Math.max(0, next_start - xp);
  const pct = Math.min(1, Math.max(0, xp_into_level / xp_for_level));
  const tier = [...RANK_TIERS].reverse().find((t) => level >= t.min_level) ?? RANK_TIERS[0]!;
  const next = RANK_TIERS.find((t) => t.min_level > level);
  return {
    xp,
    level,
    tier: tier.key,
    tier_name: tier.name,
    xp_into_level,
    xp_for_level,
    xp_to_next,
    pct,
    next_tier: next ? { key: next.key, name: next.name, at_level: next.min_level } : null,
  };
}
