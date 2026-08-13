/**
 * The unified per-user model — one bounded, cordoned picture of each user that
 * cheap signals feed and specialists read. See docs/design-per-user-model.md.
 *
 * Three layers, all cheap:
 *   - afferent:  record_observation() appends a cheap dated note to a facet.
 *   - synthesize: synthesize_facet() distills a facet's summary — the ONLY
 *     LLM-heavy step, threshold-gated (skips until enough new signal), refine-
 *     not-rebuild, cheap-tier, off-peak by the caller.
 *   - efferent:  resolve_user_model() returns the facets RELEVANT to a given
 *     specialist (universal + domain-scoped) for read-at-context injection —
 *     pure text, zero inference.
 *
 * Storage is the existing UserProfileStore facet substrate (detail.user_model);
 * the 'style' facet mirrors to the legacy detail.style_profile so the live
 * house-voice path is unbroken. Cordoned: callers pass the SPEAKER's user_id;
 * the owner has no god-view. DARK by default (HEARTH_USER_MODEL=1). Fail-open.
 */
import type { UserModelFacet } from '@memory/stores/user_profile';
import type { StyleLLM, StyleMessage } from '@core/user_style';

export function user_model_enabled(): boolean {
  return process.env.HEARTH_USER_MODEL === '1';
}

const SYNTH_THRESHOLD = 25; // new observations/messages before a re-distill fires
const SAMPLE_CAP = 40; // recent items fed to the distill (keeps prompt ~8K)
const OBS_CAP = 60; // raw observations retained per facet (rotated)
const STALE_DAYS = 45;
const LOOKBACK_MS = 14 * 24 * 3_600_000;
const MAX_SUMMARY = 1_000;

/** Floor between pull-driven re-distills (taste changes slowly; a daily
 *  snapshot must not mean a daily LLM call). Days, env-tunable. */
export function pull_min_interval_ms(): number {
  const d = Number.parseFloat(process.env.HEARTH_USER_MODEL_PULL_MIN_DAYS ?? '');
  return (Number.isFinite(d) && d >= 0 ? d : 7) * 86_400_000;
}

export interface FacetStore {
  get_facet(user_id: string, key: string): UserModelFacet | null;
  set_facet(user_id: string, key: string, facet: UserModelFacet): void;
}

/**
 * Evidence PULLED from a store at synthesis time (taste_sources.ts mappers)
 * — deterministic, bounded lines + a change cursor. The pull gate skips
 * synthesis when the cursor is unchanged since the last refresh, so an
 * unchanged store costs zero LLM.
 */
export interface PulledEvidence {
  lines: string[];
  cursor: string;
}

/** A pluggable evidence source keyed by FacetSpec.pull. Returning null (no
 *  data / unconfigured / error) self-gates the facet to a no-op. */
export type EvidenceSource = (
  user_id: string,
) => Promise<PulledEvidence | null> | PulledEvidence | null;

export interface ModelDeps {
  facets: FacetStore;
  llm: StyleLLM;
  /** Source for message-backed facets (e.g. style). */
  recent_user_messages: (user_id: string, since_iso: string, max: number) => StyleMessage[];
  /** Pull-evidence providers, keyed by FacetSpec.pull ('music', 'screen', …).
   *  Absent providers are a no-op for their facets — the self-gating shape. */
  sources?: Record<string, EvidenceSource>;
  /** LLM role; defaults to the interactive 'planner'. Use a cheap tier off-peak. */
  tier?: string;
}

interface FacetSpec {
  universal?: boolean;
  source: 'messages' | 'observations' | 'pull';
  /** For source:'pull' — the ModelDeps.sources key that feeds the facet.
   *  On an 'observations' facet it's a SUPPLEMENT: the pulled lines are
   *  merged into the evidence and a changed cursor can refresh the facet
   *  even when chat-observation flow alone is below threshold. */
  pull?: string;
  distill_system: string;
}

/** The facet taxonomy. Grows over time; each is the same observe→gate→distill→read shape. */
export const FACET_REGISTRY: Record<string, FacetSpec> = {
  style: {
    universal: true,
    source: 'messages',
    distill_system:
      `Distill how this person likes to be COMMUNICATED WITH, from messages they wrote. ` +
      `3-6 sentences, plain prose, no lists. Cover directness vs cushioning, how terse or ` +
      `expansive they want replies, humor (dry? none? profanity-comfortable?), formality, ` +
      `emotional register. This is about REGISTER — how to talk to them — never facts to ` +
      `recite back. Infer only from evidence; if thin, say what little holds. Refine the ` +
      `prior, don't discard it. Output ONLY the profile prose.`,
  },
  interests: {
    source: 'observations',
    pull: 'interest_signals',
    distill_system:
      `Distill what this person is genuinely INTO — recurring topics, passions, projects ` +
      `they return to — from these observations of what they actually do (things they ` +
      `captured, bought, subscribe to, keep coming back to). 2-4 sentences, prose, no ` +
      `lists. A real interest is something they RETURN to, not a one-off purchase or a ` +
      `newsletter they merely tolerate — judge durability, not volume. This is context for ` +
      `understanding them, NOT a checklist to mention back. Evidence only. Refine the prior.`,
  },
  music_taste: {
    source: 'pull',
    pull: 'music',
    distill_system:
      `Distill this person's MUSIC taste from the numbered listening evidence — the ` +
      `artists, genres, and moods they RETURN to; stable favorites vs a current rotation. ` +
      `3-5 sentences, plain prose, no lists. Bias to DURABLE taste: a years-deep library ` +
      `signal outweighs last week's binge; you may note a clearly-recent kick as current, ` +
      `not defining. Ground every claim in the numbered evidence — never invent an artist ` +
      `or genre the lines don't support. This is context for anticipating (a concert, a ` +
      `gift, a recommendation), NEVER a checklist to recite back. Refine the prior.`,
  },
  screen_taste: {
    source: 'pull',
    pull: 'screen',
    distill_system:
      `Distill this person's MOVIES & TV taste from the numbered watch-history evidence — ` +
      `the genres and kinds of stories they reach for, shows they stay with vs sample, ` +
      `comfort rewatches. 3-5 sentences, plain prose, no lists. Bias to DURABLE taste over ` +
      `last week's binge: returning to a show and finishing films count more than one ` +
      `play. Ground every claim in the numbered evidence — never invent a title or genre ` +
      `the lines don't support. Context for anticipating (a premiere they'd care about, a ` +
      `recommendation), NEVER a checklist to recite back. Refine the prior.`,
  },
  routines: {
    source: 'observations',
    distill_system:
      `Distill this person's rhythms and ROUTINES — when they're active, recurring patterns ` +
      `in their days and weeks, habits — from these observations. 2-4 sentences, prose, no ` +
      `lists. Useful for anticipating, never for nagging. Evidence only. Refine the prior.`,
  },
  gift_budget: {
    source: 'observations',
    distill_system:
      `Distill this person's GIFT-GIVING patterns from these observations of gifts they've ` +
      `given (recipient, occasion, amount, how it landed). 2-4 sentences, prose, no lists. ` +
      `Cover their typical spend by relationship (close family vs friends vs acquaintances), ` +
      `what kinds of gifts they reach for, and any signal about generosity or restraint. This ` +
      `is context for helping them give well — never a number to recite back. Evidence only; ` +
      `if thin, say what little holds. Refine the prior.`,
  },
};

export const UNIVERSAL_FACETS = Object.keys(FACET_REGISTRY).filter((k) => FACET_REGISTRY[k]!.universal);

/** Which facets each specialist reads, beyond the universal ones. */
export const DOMAIN_FACETS: Record<string, string[]> = {
  kate: ['interests', 'routines', 'gift_budget', 'music_taste', 'screen_taste'],
  iris: ['routines'],
  brigid: ['interests'],
  maggie: ['interests', 'music_taste', 'screen_taste'],
  eleanor: ['interests'],
};

/**
 * The default LLM role for the nightly sweep — a CHEAP tier, run off-peak.
 * `planner` resolves to the interactive 9B (idle at 3-4am), which is plenty
 * for facet distillation; override to the 1.5B CPU tier with
 * HEARTH_USER_MODEL_TIER=status_flavor when that endpoint is live.
 */
export function user_model_sweep_tier(): string {
  return process.env.HEARTH_USER_MODEL_TIER || 'planner';
}

const EPOCH = '1970-01-01T00:00:00.000Z';

function sanitize(raw: string): string {
  let t = (raw ?? '').trim();
  const fence = t.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
  if (fence) t = fence[1]!.trim();
  t = t.replace(/^(here(?:'s| is)[^\n:]*:?\s*)/i, '').trim();
  if (t.length > MAX_SUMMARY) t = t.slice(0, MAX_SUMMARY).trim() + '…';
  return t;
}

function confidence_from(n: number): UserModelFacet['confidence'] {
  return n >= 50 ? 'high' : n >= 15 ? 'med' : 'low';
}

/**
 * Afferent intake — append a cheap dated observation to a note-backed facet.
 * Creates a stub facet (empty summary) if absent; observations accumulate until
 * synthesis produces a summary. Capped/rotated. Cordoned by user_id.
 */
export function record_observation(
  store: FacetStore,
  user_id: string,
  key: string,
  text: string,
  now: Date,
): void {
  const body = (text ?? '').trim();
  if (!body) return;
  const prior = store.get_facet(user_id, key);
  const observations = [...(prior?.observations ?? []), { ts: now.toISOString(), text: body }].slice(-OBS_CAP);
  store.set_facet(user_id, key, {
    summary: prior?.summary ?? '',
    confidence: prior?.confidence ?? 'low',
    last_refreshed: prior?.last_refreshed ?? '',
    last_read: prior?.last_read,
    sources: prior?.sources,
    count_at_refresh: prior?.count_at_refresh,
    observations,
    pull_cursor: prior?.pull_cursor,
  });
}

export interface SynthResult {
  user_id: string;
  facet: string;
  updated: boolean;
  reason?:
    | 'below_threshold'
    | 'no_signal'
    | 'unknown_facet'
    | 'llm_error'
    | 'empty'
    | 'unchanged'
    | 'too_soon';
  new_count?: number;
  summary_chars?: number;
}

/**
 * Synthesize (or refine) one facet. Threshold-gated: skips unless ≥ SYNTH_THRESHOLD
 * new observations/messages since last refresh (so slow-changing facets rarely fire).
 * Fail-open: any shortfall leaves the prior facet untouched.
 */
export async function synthesize_facet(
  user_id: string,
  key: string,
  deps: ModelDeps,
  opts: { now: Date; threshold?: number },
): Promise<SynthResult> {
  const spec = FACET_REGISTRY[key];
  if (!spec) return { user_id, facet: key, updated: false, reason: 'unknown_facet' };
  const prior = deps.facets.get_facet(user_id, key);
  const since = prior?.last_refreshed || EPOCH;
  const threshold = opts.threshold ?? SYNTH_THRESHOLD;

  // Pulled evidence (source:'pull' facets + observation supplements),
  // resolved up front. Absent provider / no data / a throw → null — the
  // facet self-gates to a no-op (the gift_budget shape; no kill switch).
  let pulled: PulledEvidence | null = null;
  if (spec.pull) {
    try {
      pulled = (await deps.sources?.[spec.pull]?.(user_id)) ?? null;
      if (pulled && pulled.lines.length === 0) pulled = null;
    } catch {
      pulled = null;
    }
  }

  let sample: string[];
  let new_count: number;
  if (spec.source === 'messages') {
    const window_since = new Date(opts.now.getTime() - LOOKBACK_MS).toISOString();
    let recent: StyleMessage[];
    try {
      recent = deps.recent_user_messages(user_id, window_since, SAMPLE_CAP);
    } catch {
      recent = [];
    }
    sample = recent.map((m) => (m.content_md ?? '').trim()).filter(Boolean);
    new_count = (() => {
      try {
        return deps.recent_user_messages(user_id, since, 500).length;
      } catch {
        return sample.length;
      }
    })();
  } else if (spec.source === 'pull') {
    if (!pulled) return { user_id, facet: key, updated: false, reason: 'no_signal' };
    if (prior?.summary) {
      // Cursor gate first (an unchanged store never costs an LLM call), then
      // the min-interval floor (a daily-changing store re-distills weekly).
      if (pulled.cursor === prior.pull_cursor) {
        return { user_id, facet: key, updated: false, reason: 'unchanged' };
      }
      const age = opts.now.getTime() - new Date(prior.last_refreshed || EPOCH).getTime();
      if (age < pull_min_interval_ms()) {
        return { user_id, facet: key, updated: false, reason: 'too_soon' };
      }
    }
    sample = pulled.lines.slice(0, SAMPLE_CAP);
    new_count = sample.length;
  } else {
    const obs = prior?.observations ?? [];
    sample = obs.slice(-SAMPLE_CAP).map((o) => o.text.trim()).filter(Boolean);
    // strictly AFTER the last refresh — observations at the refresh instant were
    // already consumed (else a just-refreshed facet re-counts its own evidence).
    new_count = obs.filter((o) => o.ts > since).length;
    if (pulled) {
      // Supplement: merge the pulled lines into the evidence. A changed
      // cursor can refresh the facet even when observation flow alone is
      // below threshold — but no more than once per min-interval.
      if (prior?.summary && new_count < threshold) {
        const cursor_changed = pulled.cursor !== prior.pull_cursor;
        const age = opts.now.getTime() - new Date(prior.last_refreshed || EPOCH).getTime();
        if (!cursor_changed) {
          return { user_id, facet: key, updated: false, reason: 'below_threshold', new_count };
        }
        if (age < pull_min_interval_ms()) {
          return { user_id, facet: key, updated: false, reason: 'too_soon', new_count };
        }
      }
      sample = [...sample, ...pulled.lines];
    }
  }

  if (!pulled && prior?.summary && new_count < threshold) {
    return { user_id, facet: key, updated: false, reason: 'below_threshold', new_count };
  }
  if (sample.length === 0) {
    return { user_id, facet: key, updated: false, reason: 'no_signal', new_count };
  }

  // Pull-fed facets enumerate evidence [1]..[n] (the citations idiom — the
  // distill prompts tell the model to ground every claim in a numbered line).
  const evidence = pulled
    ? sample.map((s, i) => `[${i + 1}] ${s}`).join('\n')
    : sample.map((s) => `- ${s}`).join('\n');
  const payload =
    `## prior\n${prior?.summary?.trim() || '(none — first pass)'}\n\n## evidence\n` +
    evidence.slice(0, 36_000);

  let content: string;
  try {
    const role = deps.llm.for_role(deps.tier ?? 'planner');
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: spec.distill_system },
        { role: 'user', content: payload },
      ],
      temperature: role.defaults.temperature,
    });
    content = resp.content ?? '';
  } catch {
    return { user_id, facet: key, updated: false, reason: 'llm_error', new_count };
  }

  const summary = sanitize(content);
  if (!summary) return { user_id, facet: key, updated: false, reason: 'empty', new_count };

  deps.facets.set_facet(user_id, key, {
    summary,
    confidence: confidence_from(sample.length),
    last_refreshed: opts.now.toISOString(),
    last_read: prior?.last_read,
    sources: pulled && spec.pull ? [spec.source, spec.pull] : [spec.source],
    count_at_refresh: new_count,
    observations: prior?.observations,
    pull_cursor: pulled ? pulled.cursor : prior?.pull_cursor,
  });
  return { user_id, facet: key, updated: true, new_count, summary_chars: summary.length };
}

export interface ResolvedFacet {
  key: string;
  summary: string;
  confidence: UserModelFacet['confidence'];
  stale: boolean;
}

/**
 * Efferent read — the facets relevant to this specialist for THIS user
 * (universal + domain-scoped), each a short summary. Pure read, zero inference.
 * Domain-scoped + cordoned: callers pass the SPEAKER's user_id.
 */
export function resolve_user_model(
  store: FacetStore,
  user_id: string,
  specialist_id: string,
  now: Date,
): { facets: ResolvedFacet[] } {
  const keys = [...new Set([...UNIVERSAL_FACETS, ...(DOMAIN_FACETS[specialist_id] ?? [])])];
  const out: ResolvedFacet[] = [];
  for (const key of keys) {
    const f = store.get_facet(user_id, key);
    if (!f || !f.summary.trim()) continue;
    const age_days = f.last_refreshed
      ? (now.getTime() - new Date(f.last_refreshed).getTime()) / 86_400_000
      : Infinity;
    out.push({ key, summary: f.summary.trim(), confidence: f.confidence, stale: age_days > STALE_DAYS });
  }
  return { facets: out };
}

/**
 * The nightly tick — walk a set of users × the facet taxonomy and synthesize
 * each. The heavy lifting is `synthesize_facet`, which is itself threshold-gated
 * (skips a facet that hasn't accumulated enough new signal — no LLM), so a quiet
 * night across the household is mostly SQLite counts and a few cheap distills.
 * Designed to run off-peak on a cheap tier (the Kate `sweep_user_models`
 * background job at 03:30; the manual `run-user-model-sweep.ts` driver).
 *
 * Contracts:
 *   - DARK by default: a no-op (returns []) unless HEARTH_USER_MODEL=1.
 *   - FAIL-OPEN + ISOLATED: one user's (or one facet's) failure never aborts
 *     the sweep; every shortfall returns a SynthResult with a `reason`.
 *   - CORDONED by construction: each facet is read/written under its own
 *     user_id; no cross-user reach.
 */
export async function run_user_model_sweep(
  user_ids: string[],
  deps: ModelDeps,
  opts: { now: Date; facets?: string[]; threshold?: number },
): Promise<SynthResult[]> {
  if (!user_model_enabled()) return [];
  const keys = opts.facets ?? Object.keys(FACET_REGISTRY);
  const out: SynthResult[] = [];
  for (const user_id of [...new Set(user_ids.filter(Boolean))]) {
    for (const key of keys) {
      try {
        out.push(
          await synthesize_facet(user_id, key, deps, {
            now: opts.now,
            ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
          }),
        );
      } catch {
        out.push({ user_id, facet: key, updated: false, reason: 'llm_error' });
      }
    }
  }
  return out;
}
