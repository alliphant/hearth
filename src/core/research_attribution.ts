/**
 * research_attribution — can the person we are researching find out we looked?
 * (Deep Research v2, 2026-07-31.)
 *
 * The owner's ask, verbatim: *"I don't want linkedin searches/browsing traced
 * back to me."*
 *
 * ## The actual risk, measured
 *
 * Firecrawl is anonymous, so today's LinkedIn fetches return the logged-out
 * guest view and nothing is attributable — the persisted body from the live
 * investigation `ri_3kq84nfd4mz0` is 549 characters of `Sign Up | LinkedIn`.
 *
 * That is not reassuring, it is the bug. `THIN_MARKDOWN_MIN` in
 * fetch_with_browser_fallback is **900**. A 549-character guest wall is a THIN
 * SHELL, and a thin shell **escalates to the warmed Firefox on the browser
 * host** — which keeps signed-in profiles by hand for paywalled sources. So the
 * existing code path walks from an anonymous fetch straight into a signed-in
 * profile view, and LinkedIn shows the subject who looked. The escalation that
 * exists to defeat bot walls is exactly the thing that would burn the
 * household's cover.
 *
 * ## The model
 *
 * Attribution is a property of the **(source, path)** pair, and both halves
 * matter:
 *
 *   - the PATH supplies identity or does not — Firecrawl carries no cookies,
 *     the household browser carries a profile;
 *   - the SOURCE decides whether that identity is disclosed — a signed-in
 *     Firefox on a static county site tells nobody anything; a signed-in
 *     Firefox on LinkedIn notifies the subject.
 *
 * So the tier is computed, never declared per-tool: `attribution_of(url, path)`.
 * The host table lives in config/research-sources.yaml, which is an inventory
 * of OUR OWN signed-in profiles — a fact about our infrastructure, not a
 * per-site carve-out (LAW #1). Adding a host is a config edit; nothing here
 * knows the word "LinkedIn".
 *
 * ## The rule
 *
 * An investigation carries a **cap**. The runner sets `passive` for every
 * PERSON subject, per the owner: an investigation into a person must never use
 * an attributable path. A fetch whose computed tier exceeds the cap is REFUSED
 * — not downgraded, not retried, not silently dropped. The refusal is recorded
 * with its reason so the dossier can say "LinkedIn was not read, because
 * reading it would have told him", which is a better answer than the page.
 *
 * Enforcement is in the fetch layer (fetch_with_browser_fallback), not in
 * calling convention, because a convention is one forgetful caller away from
 * being false.
 *
 * Kill switch: HEARTH_RESEARCH_ATTRIBUTION=0 → every fetch is permitted and the
 * behaviour is byte-identical to before this module existed.
 */
import {
  host_matches,
  host_of,
  research_roster,
  type AttributionTier,
} from '@core/research_roster';

export type { AttributionTier };

/**
 * How a fetch reaches a page.
 *
 * `anonymous` — Firecrawl, or any transport that carries no household session.
 * `household_browser` — the warmed Firefox on the browser host. Carries a
 *   per-specialist profile, and some of those profiles are signed in.
 */
export type FetchPath = 'anonymous' | 'household_browser';

export interface AttributionVerdict {
  tier: AttributionTier;
  /** The host rule that decided it, when one did. */
  matched_host: string | null;
  /** Plain-language reason, surfaced verbatim when a fetch is refused. */
  why: string;
}

export function attribution_enabled(): boolean {
  return process.env.HEARTH_RESEARCH_ATTRIBUTION !== '0';
}

/** Rank so caps compare with `>`. */
const RANK: Record<AttributionTier, number> = { passive: 0, attributable: 1 };

/**
 * What would fetching `url` over `path` disclose?
 *
 * The anonymous path is passive unconditionally — there is no identity to
 * disclose, so no host table can make it attributable. Only the browser path
 * consults the roster.
 */
export function attribution_of(url: string, path: FetchPath): AttributionVerdict {
  if (path === 'anonymous') {
    return {
      tier: 'passive',
      matched_host: null,
      why: 'anonymous fetch — carries no household session',
    };
  }
  const host = host_of(url);
  const roster = research_roster();
  if (host) {
    for (const rule of roster.attribution.hosts) {
      if (host_matches(host, rule.host)) {
        return {
          tier: rule.tier,
          matched_host: rule.host,
          why:
            rule.why.trim().length > 0
              ? rule.why.trim()
              : `the household browser holds a session for ${rule.host}`,
        };
      }
    }
  }
  return {
    tier: roster.attribution.default_browser_tier,
    matched_host: null,
    why: 'household browser, but no signed-in session is declared for this host',
  };
}

export interface PermissionVerdict {
  allowed: boolean;
  tier: AttributionTier;
  matched_host: string | null;
  /** Why it was refused — written to be read by the owner, not by a log. */
  reason: string;
}

/**
 * May we fetch `url` over `path` under `cap`?
 *
 * `cap` is the most disclosure this investigation is willing to incur.
 * `undefined` means uncapped (the pre-existing behaviour for every non-person
 * investigation and every non-research caller).
 */
export function fetch_permitted(
  url: string,
  path: FetchPath,
  cap: AttributionTier | undefined,
): PermissionVerdict {
  const verdict = attribution_of(url, path);
  if (!attribution_enabled() || cap === undefined) {
    return { allowed: true, tier: verdict.tier, matched_host: verdict.matched_host, reason: '' };
  }
  if (RANK[verdict.tier] <= RANK[cap]) {
    return { allowed: true, tier: verdict.tier, matched_host: verdict.matched_host, reason: '' };
  }
  return {
    allowed: false,
    tier: verdict.tier,
    matched_host: verdict.matched_host,
    reason:
      `not read: fetching this through the household browser would be ` +
      `${verdict.tier} — ${verdict.why}. This investigation is capped at ` +
      `${cap} because researching a person must not tell that person they are ` +
      `being researched.`,
  };
}

/**
 * The line the dossier shows for refused sources.
 *
 * Deliberately states the limit as a CHOICE rather than a failure: the reader
 * should understand that the source was reachable and was left alone on
 * purpose, so nobody "fixes" it later by turning the cap off.
 */
export function render_attribution_note(
  refused: ReadonlyArray<{ url: string; reason: string }>,
): string {
  if (refused.length === 0) return '';
  const lines = refused.map((r) => `- ${r.url}\n  ${r.reason}`);
  return (
    `### Sources deliberately not read\n\n` +
    `${refused.length} source(s) were reachable but left alone, because reading them ` +
    `would have been traceable to this household — and on a social network, shown to ` +
    `the person being researched.\n\n${lines.join('\n')}\n`
  );
}
