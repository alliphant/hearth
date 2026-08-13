/**
 * synthesis_health — the deterministic health + worthiness score for a
 * synthesis note (the self-governing synthesis-health loop, 2026-06-14).
 *
 * The score is the spine of the loop: the synthesis office RANKS by it, Mariah's
 * scan DETECTS on it, retrieval can use it as a re-rank PRIOR, and pruning GATES
 * on it. Two distinct axes Jasper named — they answer different questions and
 * drive different actions, so they're scored separately and only blended for a
 * headline number:
 *
 *   - HEALTH = is it SOUND, or rotting? grounding verdict at write, source
 *     breadth, source trust tiers, freshness/staleness, and integrity (do its
 *     cited sources still exist). A low health note is a RE-SYNTHESIZE / drop
 *     candidate.
 *   - WORTH = is it VALUED, or dead weight? retrieval usage — is anyone
 *     actually retrieving + citing it. A low worth note is a PRUNE candidate.
 *     Until the retrieval-usage instrument lands (loop Phase B), `retrieval_hits`
 *     is undefined and worth is NEUTRAL (0.5) — we never penalize a note for
 *     usage we can't yet measure.
 *
 * DETERMINISTIC + pure (no LLM, no clock — the caller passes `age_days`): the
 * same inputs always yield the same score, so a re-scan verifies rather than
 * drifts, matching the demand-ledger / clustering philosophy. An LLM
 * "worthiness judge" was deliberately rejected — expensive and non-reproducible.
 *
 * The DANGEROUS quadrant is high-worth + low-health: a popular but decaying or
 * fabrication-touched synthesis. Health is weighted above worth precisely so a
 * heavily-used rotting note can't score itself clean on usage alone.
 */

export type GroundingOutcome = 'clean' | 'corrected' | 'reduced';

export interface SynthesisHealthInputs {
  /** The write-time grounding gate verdict. */
  grounding_outcome: GroundingOutcome;
  /** Number of source notes the synthesis was built from. */
  source_count: number;
  /** Each source's trust tier (1 / 2 / null=untiered). Empty → unknown. */
  trust_tiers: Array<1 | 2 | null>;
  /** Days since `synthesized_at` (caller computes from `now` — keeps this pure).
   *  0 at write time. */
  age_days: number;
  /** How many of the cited sources STILL EXIST. Equals source_count at write
   *  time; drops as sources are deleted (the integrity / rot signal). */
  sources_present: number;
  /** Times this synthesis has been retrieved + used in a real turn. `undefined`
   *  until the usage instrument lands (loop Phase B) → worth is neutral. */
  retrieval_hits?: number;
  /** Days since the most recent retrieval (from `synthesis_usage.last_retrieved_at`).
   *  Recency-weights worth so heavily-used-but-COLD knowledge decays toward
   *  prune/de-prioritize — the brain ranks by CURRENT value, not lifetime count.
   *  `undefined` (never retrieved, or pre-instrument) → no recency penalty. */
  last_retrieval_age_days?: number;
}

export type HealthGrade = 'strong' | 'sound' | 'weak' | 'rotting';

export interface SynthesisHealth {
  /** Soundness, 0..1. */
  health: number;
  /** Value/usage, 0..1 (neutral 0.5 until usage is instrumented). */
  worth: number;
  /** Headline blend, 0..1 (health-weighted). */
  score: number;
  grade: HealthGrade;
  /** Human-readable factors driving the score — for the office + audit. */
  reasons: string[];
}

/* ------------------------------------------------------------------ */
/* Tunables (deterministic; documented so the scan/office agree)       */
/* ------------------------------------------------------------------ */

/** Source count at which breadth is "full" — more sources = more robust. */
const BREADTH_TARGET = 6;
/** Fresh until this many days, then linear decay. */
const FRESH_DAYS = 30;
/** Fully stale (freshness floor) at this age. */
const STALE_DAYS = 180;
const FRESHNESS_FLOOR = 0.3;
/** Retrieval hits at which worth is "fully proven." */
const USAGE_TARGET = 10;
/** Health is weighted above worth — a used-but-rotting note can't hide. */
const HEALTH_WEIGHT = 0.7;
/** Usage stays "warm" (full worth) up to this many days since last retrieval. */
const RECENT_USAGE_DAYS = 14;
/** Fully cold (recency floor) once unused this long. */
const COLD_USAGE_DAYS = 90;
const USAGE_RECENCY_FLOOR = 0.3;

/** Recency multiplier on worth: 1.0 when recently used, decaying linearly to
 *  USAGE_RECENCY_FLOOR once cold. `undefined` age → no penalty (unknown). */
function usage_recency_factor(age_days?: number): number {
  if (age_days === undefined) return 1.0;
  if (age_days <= RECENT_USAGE_DAYS) return 1.0;
  if (age_days >= COLD_USAGE_DAYS) return USAGE_RECENCY_FLOOR;
  const span = COLD_USAGE_DAYS - RECENT_USAGE_DAYS;
  return clamp01(1.0 - ((age_days - RECENT_USAGE_DAYS) / span) * (1.0 - USAGE_RECENCY_FLOOR));
}

const GROUNDING_SCORE: Record<GroundingOutcome, number> = {
  clean: 1.0,
  corrected: 0.75, // a fabrication was caught + re-grounded — slightly lower confidence
  reduced: 0.45, // fabrication couldn't be re-grounded; flagged sentences dropped
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/* ------------------------------------------------------------------ */
/* The score                                                           */
/* ------------------------------------------------------------------ */

export function score_synthesis(inputs: SynthesisHealthInputs): SynthesisHealth {
  const reasons: string[] = [];
  const n = Math.max(0, inputs.source_count);

  // 1. grounding verdict
  const grounding = GROUNDING_SCORE[inputs.grounding_outcome];
  if (inputs.grounding_outcome !== 'clean') {
    reasons.push(`grounding gate: ${inputs.grounding_outcome}`);
  }

  // 2. source breadth
  const breadth = n === 0 ? 0 : clamp01(n / BREADTH_TARGET);
  if (n > 0 && n < 3) reasons.push(`thin: only ${n} source(s)`);

  // 3. trust — fraction-weighted over known tiers (untiered counts low, not
  //    zero); no tier info at all → neutral.
  let trust: number;
  const tiered = inputs.trust_tiers;
  if (tiered.length === 0) {
    trust = 0.5;
  } else {
    const sum = tiered.reduce((acc, t) => acc + (t === 1 ? 1.0 : t === 2 ? 0.6 : 0.4), 0);
    trust = clamp01(sum / tiered.length);
    if (!tiered.some((t) => t === 1)) reasons.push('no Tier-1 sources');
  }

  // 4. freshness — fresh up to FRESH_DAYS, linear decay to FRESHNESS_FLOOR.
  let freshness: number;
  if (inputs.age_days <= FRESH_DAYS) {
    freshness = 1.0;
  } else if (inputs.age_days >= STALE_DAYS) {
    freshness = FRESHNESS_FLOOR;
    reasons.push(`stale: ${Math.round(inputs.age_days)} days old`);
  } else {
    const span = STALE_DAYS - FRESH_DAYS;
    freshness = clamp01(1.0 - ((inputs.age_days - FRESH_DAYS) / span) * (1.0 - FRESHNESS_FLOOR));
  }

  // 5. integrity — citing deleted sources is rot.
  const integrity = n === 0 ? 0 : clamp01(inputs.sources_present / n);
  if (inputs.sources_present < n) {
    reasons.push(`rotting: ${n - inputs.sources_present} of ${n} sources deleted`);
  }

  const health = clamp01((grounding + breadth + trust + freshness + integrity) / 5);

  // worth — usage, RECENCY-WEIGHTED; neutral until instrumented. Heavy use long
  // ago is worth less than a little use lately, so the read-path prior + prune
  // priority track CURRENT value, not lifetime count (self-ranking).
  let worth: number;
  if (inputs.retrieval_hits === undefined) {
    worth = 0.5;
  } else if (inputs.retrieval_hits === 0) {
    worth = 0;
    reasons.push('never retrieved');
  } else {
    const usage = clamp01(inputs.retrieval_hits / USAGE_TARGET);
    const recency = usage_recency_factor(inputs.last_retrieval_age_days);
    worth = clamp01(usage * recency);
    if (recency < 1) reasons.push(`cold: last used ${Math.round(inputs.last_retrieval_age_days ?? 0)}d ago`);
  }

  const score = clamp01(HEALTH_WEIGHT * health + (1 - HEALTH_WEIGHT) * worth);

  // grade — health-led; integrity collapse forces 'rotting' regardless.
  let grade: HealthGrade;
  if (integrity < 0.5) grade = 'rotting';
  else if (health >= 0.8 && worth >= 0.6) grade = 'strong';
  else if (health >= 0.6) grade = 'sound';
  else if (health >= 0.45) grade = 'weak';
  else grade = 'rotting';

  return {
    health: round2(health),
    worth: round2(worth),
    score: round2(score),
    grade,
    reasons,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
