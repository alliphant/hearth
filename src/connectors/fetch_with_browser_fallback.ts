/**
 * Two-stage URL fetcher: Firecrawl first, the workstation warmed-Firefox
 * (browse_url) on bot-block escalation.
 *
 * Per the the private dev log rule "try web_fetch_clean ONCE, escalate to
 * browse_url on the SAME URL on failure" — this helper mechanizes the
 * escalation for tools that ingest by URL. Mayo Clinic, Cleveland
 * Clinic, Harvard Health, and a long tail of clinical/research sites
 * return 403/406 to safe_fetch; Cloudflare and PerimeterX leak
 * telltale strings into response bodies. Anything bot-shaped retries
 * via browse_url — AND so does a Firecrawl-transport failure (timeout,
 * connection refused, reset). web_fetch_clean POSTs to FIRECRAWL, not
 * the target, so a transport error there means FIRECRAWL is down /
 * unreachable, and the workstation is a separate host that still reaches the
 * page independently — exactly the failover. (This is the Firecrawl-
 * OUTAGE case the old bot-block-only gate skipped: a dead worker makes
 * every scrape POST time out → "the operation timed out", which the
 * gate read as "target unreachable, the browser won't help" and gave
 * up, so nothing ever failed over during an outage.) A genuine target
 * DNS/refused failure surfaces as a Firecrawl JSON error ("no markdown"
 * / a scrape error), which the bot-block detector already escalates.
 *
 * Callers must hold `browse_web` capability if they want the fallback
 * — the underlying browse_url Tool gates on it. The helper returns
 * either Firecrawl markdown verbatim, browser-rendered text wrapped as
 * markdown (with the page title as an H1), or a structured error code
 * the caller maps to a skip-reason for its audit log.
 */
import { web_fetch_clean } from './firecrawl';
import { browse_url } from './avalanche';
import { fetch_cache_get, fetch_cache_put } from './fetch_cache';
import type { ToolContext } from '@core/tool';
import { fetch_permitted, type AttributionTier } from '@core/research_attribution';

/**
 * The slice of ToolContext both underlying tools actually read.
 * Accepting this narrower interface lets the URL ingest route handler
 * synthesize a context without a real specialist turn (it doesn't
 * have one — the user POSTed a multipart, not a specialist tool
 * call). `memory` is required because browse_url audits every call
 * via `ctx.memory.log_action` — the audit surface is non-negotiable.
 */
export interface FetchCtx {
  specialist_id?: string;
  intent_id: string;
  memory: import('@memory/client').MemoryClient;
}

/**
 * Why a fetch stopped short of the household browser.
 *
 * Rides on the EXISTING `failed` / `firecrawl` variants rather than becoming a
 * fifth `kind`, deliberately: seventeen callers narrow on this union, and the
 * safe default for a caller that has never heard of attribution is to treat a
 * refusal exactly as it treats a failure — skip the source and move on. Only
 * the research runner reads this field, to record an honest "chose not to look"
 * instead of a misleading "could not read".
 */
export interface AttributionRefusal {
  tier: AttributionTier;
  matched_host: string | null;
  reason: string;
}

export type FetchOutcome =
  | {
      kind: 'firecrawl';
      markdown: string;
      title: string | null;
      source_url: string;
      /** Set when the browser escalation was refused on attribution grounds,
       *  so this (possibly thin) anonymous result is what we chose to keep. */
      attribution_capped?: AttributionRefusal;
    }
  | { kind: 'browser'; markdown: string; title: string | null; source_url: string }
  | { kind: 'deferred'; reason: string; source_url: string }
  | { kind: 'failed'; reason: string; source_url: string; refused?: AttributionRefusal };

/**
 * Detect fetch failures worth retrying via the warmed-Firefox path.
 *
 * Two failure shapes count:
 *
 *   - **Explicit bot block** — status-code keywords (403, 406, 429,
 *     "forbidden"), bot-protection vendors (Cloudflare, PerimeterX),
 *     user-facing block strings (captcha, "access denied"). Firecrawl
 *     surfaces these as `HTTP 403: <body>` etc.
 *   - **Silent JS challenge** — sites that don't 403 outright but
 *     serve a JS interstitial Firecrawl can't render. The Firecrawl
 *     response wraps these as `success: false` or empty `data.markdown`,
 *     producing the literal error "Firecrawl returned no markdown".
 *     Mayo Clinic, Cleveland Clinic, Harvard Health all fall here —
 *     they don't openly bot-block, they just won't paint without JS.
 *
 * What does NOT match here: plain network/transport errors (timeout,
 * DNS failure, connection refused). Those are NOT bot-shaped — but they
 * ARE a Firecrawl-down signal, so they escalate via the SEPARATE
 * `is_firecrawl_unreachable` detector below (web_fetch_clean talks to
 * Firecrawl, not the target, so a transport error means Firecrawl is the
 * failed hop and the independent browser path can still reach the page).
 */
/**
 * The site ACTIVELY REFUSED us — a hard bot block.
 *
 * Owner's rule (2026-07-31): a refusal must NOT escalate to waking a second
 * machine. Retrying a Cloudflare-walled page from another host on the same home
 * connection is bot-block evasion, and the thing it risks is the household's own
 * addresses — a whole residential range flagged because Hearth kept knocking
 * from a different door. When a site says no, Hearth takes no for an answer.
 */
export function is_hard_refusal(err: string | undefined): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  // Plain network/transport failures aren't a refusal — they're handled by
  // is_firecrawl_unreachable (Firecrawl is the down hop, not the target).
  if (
    e.includes('econnrefused') ||
    e.includes('enotfound') ||
    e.includes('etimedout') ||
    e.includes('getaddrinfo') ||
    e.includes('socket hang up')
  ) {
    return false;
  }
  return (
    // Status-code-shaped refusals
    e.includes('403') ||
    e.includes('406') ||
    e.includes('429') ||
    // Bot-protection vendors naming themselves
    e.includes('cloudflare') ||
    e.includes('perimeterx') ||
    // Human-facing block strings
    e.includes('forbidden') ||
    e.includes('captcha') ||
    e.includes('blocked') ||
    e.includes('access denied')
  );
}

/**
 * The site never refused us — the page just won't PAINT without a renderer.
 *
 * Categorically different from a refusal, and the distinction is the whole
 * point of the split: a public page behind a JS shell is served happily to any
 * browser, so rendering it with one is what an ordinary visitor does. No block
 * is being circumvented, so this may escalate.
 */
export function needs_rendering(err: string | undefined): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return e.includes('no markdown') || e.includes('empty body') || e.includes('javascript');
}

/**
 * @deprecated Kept only so nothing external breaks on the rename. Callers that
 * decide whether to WAKE A HOST must use the two predicates above — collapsing
 * them back into one is precisely the bug this split fixed.
 */
export function is_bot_block(err: string | undefined): boolean {
  return is_hard_refusal(err) || needs_rendering(err);
}

/**
 * Detect a Firecrawl-TRANSPORT failure — Firecrawl itself is down or
 * unreachable, as opposed to the target site refusing us.
 *
 * web_fetch_clean POSTs to the Firecrawl service (`FIRECRAWL_BASE_URL`),
 * NOT to the target page. So when its `error` is a transport failure
 * (the scrape POST timed out, the connection was refused/reset, the host
 * didn't resolve), the failed hop is Hearth→Firecrawl — Firecrawl is
 * down. A dead firecrawl-worker is the canonical case: the API enqueues a
 * job nothing picks up, so the POST times out → "The operation timed
 * out." (a worker can sit dead for days). the workstation is a completely
 * separate host that fetches the target itself, so it's exactly the
 * failover for this class — the browser CAN reach a page Firecrawl never
 * got the chance to.
 *
 * (Genuine target-unreachable failures — the page's own DNS/refused —
 * happen INSIDE Firecrawl and come back as a Firecrawl JSON error, caught
 * by is_bot_block's "no markdown" arm, not here.)
 */
export function is_firecrawl_unreachable(err: string | undefined): boolean {
  if (!err) return false;
  const e = err.toLowerCase();
  return (
    e.includes('timed out') ||
    e.includes('timeout') ||
    e.includes('etimedout') ||
    e.includes('econnrefused') ||
    e.includes('econnreset') ||
    e.includes('socket hang up') ||
    e.includes('enotfound') ||
    e.includes('getaddrinfo') ||
    e.includes('fetch failed') ||
    e.includes('network error')
  );
}

export interface FetchWithFallbackOptions {
  /** Default 2500ms — long enough for JS-rendered widgets to paint. */
  browser_wait_ms?: number;
  /**
   * Title to use when both stages produce no usable title. Typically
   * the result-list title from web_search.
   */
  title_fallback?: string;
  /**
   * Skip Firecrawl entirely and fetch through the workstation's warmed
   * Firefox from the start (2026-06-10). For login-gated / paywalled
   * sources whose value depends on the browser profile being signed in
   * (a subscription with `fetch_via: 'browser'`), and for sites whose
   * Firecrawl extraction is known-broken. No Firecrawl fallback — if
   * the browser path fails, the fetch fails (Firecrawl would only see
   * the logged-out shell anyway).
   */
  browser_first?: boolean;
  /**
   * The most disclosure this fetch may incur (2026-07-31).
   *
   * `passive` refuses the household-browser path for any host the roster
   * declares identity-disclosing — the browser carries signed-in profiles, and
   * on a social network a signed-in view is shown to the person being viewed.
   * The research runner sets this for every PERSON subject.
   *
   * Undefined = uncapped, which is every pre-existing caller.
   */
  attribution_cap?: AttributionTier;
}

/**
 * Below this many characters a Firecrawl "success" is treated as a JS SHELL —
 * a 200 with some nav/cookie markdown but no real content (the Lenovo
 * PSREF/ThinkStation SPAs return ~750 chars; a real spec/lineup page is many
 * KB). A shell escalates to the warmed browser exactly like a hard bot-block,
 * which is the generalization that stopped silently dropping those pages. A page
 * that's legitimately this short loses nothing: we keep the richer of the two.
 */
const THIN_MARKDOWN_MIN = 900;

export async function fetch_with_browser_fallback(
  url: string,
  ctx: FetchCtx | ToolContext,
  opts: FetchWithFallbackOptions = {},
): Promise<FetchOutcome> {
  // Read-through page cache. browser_first BYPASSES it: those are login-gated
  // sources whose value is the signed-in render — a cached logged-out shell
  // would be wrong, so neither read nor write the cache for them. Only
  // successful firecrawl/browser outcomes are cached (deferred/failed retry).
  if (!opts.browser_first) {
    const hit = fetch_cache_get(url);
    if (hit) return hit;
    const outcome = await fetch_uncached(url, ctx, opts);
    // An attribution-capped result must NOT be cached. It is a deliberately
    // degraded read — the anonymous shell we kept because escalating would have
    // been traceable — and caching it would serve that shell to a later
    // UNCAPPED investigation that is entitled to the full page. (Reading FROM
    // the cache stays fine: a cached body is already on our disk and re-serving
    // it discloses nothing.)
    if (!(outcome.kind === 'firecrawl' && outcome.attribution_capped)) {
      fetch_cache_put(url, outcome);
    }
    return outcome;
  }
  return fetch_uncached(url, ctx, opts);
}

async function fetch_uncached(
  url: string,
  ctx: FetchCtx | ToolContext,
  opts: FetchWithFallbackOptions = {},
): Promise<FetchOutcome> {
  const tool_ctx = ctx as ToolContext; // narrow ctx satisfies both tools' actual reads

  // ATTRIBUTION GATE (2026-07-31). The household browser carries signed-in
  // profiles; the roster says which hosts turn that into a disclosure. Checked
  // HERE — before either browser call — so no caller can forget it.
  const browser_gate = fetch_permitted(url, 'household_browser', opts.attribution_cap);

  // Browser-first: the caller knows Firecrawl is useless here (login-
  // gated source, signed-in profile required). Straight to the workstation.
  if (opts.browser_first) {
    // Browser-first has no anonymous fallback by construction, so a refusal
    // here is terminal for this URL — which is the correct outcome, not a
    // degradation: the whole point of browser-first is the signed-in render.
    if (!browser_gate.allowed) {
      return {
        kind: 'failed',
        reason: browser_gate.reason,
        source_url: url,
        refused: {
          tier: browser_gate.tier,
          matched_host: browser_gate.matched_host,
          reason: browser_gate.reason,
        },
      };
    }
    const browsed = await browse_url.execute(
      { url, wait_ms: opts.browser_wait_ms ?? 2500 },
      tool_ctx,
    );
    if (browsed.deferred) {
      return { kind: 'deferred', reason: browsed.defer_reason ?? 'Jasper at the keyboard', source_url: url };
    }
    if (browsed.error || !browsed.text) {
      return {
        kind: 'failed',
        reason: `browser-first fetch failed: ${browsed.error ?? 'empty text'}`,
        source_url: url,
      };
    }
    const title = browsed.title ?? opts.title_fallback ?? null;
    return {
      kind: 'browser',
      markdown: `# ${title ?? url}\n\n${browsed.text}\n`,
      title,
      source_url: url,
    };
  }

  const fetched = await web_fetch_clean.execute({ url }, tool_ctx);

  // A usable Firecrawl result we can fall back to if the browser can't beat it.
  const firecrawl: Extract<FetchOutcome, { kind: 'firecrawl' }> | null =
    fetched.markdown && !fetched.error
      ? { kind: 'firecrawl', markdown: fetched.markdown, title: fetched.title, source_url: url }
      : null;

  // Rich enough → done, no browser session needed.
  if (firecrawl && firecrawl.markdown.trim().length >= THIN_MARKDOWN_MIN) {
    return firecrawl;
  }

  // Decide whether to escalate. A thin-but-200 shell escalates just like a
  // bot-shaped error; so does a Firecrawl-transport failure — Firecrawl is the
  // down hop, and the workstation reaches the page on a separate host (the outage
  // failover). The only no-escalate case is a non-thin failure that's neither
  // bot-shaped nor a Firecrawl-down signal.
  const thin = firecrawl !== null; // had markdown, but under the shell threshold

  // A HARD REFUSAL ends the attempt here, before any escalation — and that
  // matters because escalating can WAKE A SLEEPING GPU BOX to retry from a
  // second host. Owner's rule (2026-07-31): power the box on when the always-on host is
  // genuinely the problem, never to skate around a bot block. Retrying a
  // Cloudflare wall from another machine on the same home connection is
  // evasion, and the cost of getting it wrong is the household's own IPs.
  //
  // The two legitimate escalations remain:
  //   - Firecrawl unreachable → the always-on host's worker is the down hop. This IS "the always-on host
  //     being the issue"; the workstation reaches the page from a separate host as
  //     genuine outage failover.
  //   - Needs rendering → the site never refused, it just won't paint without
  //     JS. Serving it to a real browser is what any visitor's browser does.
  if (is_hard_refusal(fetched.error)) {
    return {
      kind: 'failed',
      // Named plainly so the specialist reports a refusal rather than a
      // mystery, and nobody re-adds a retry thinking it was a transport blip.
      reason: `the site refused automated access (${fetched.error ?? 'bot block'}) — not retried from another host`,
      source_url: url,
    };
  }
  const escalatable = needs_rendering(fetched.error) || is_firecrawl_unreachable(fetched.error);
  if (!thin && !escalatable) {
    return { kind: 'failed', reason: fetched.error ?? 'empty markdown', source_url: url };
  }

  // The escalation is exactly where the cover gets burned. LinkedIn's
  // logged-out guest wall measured 549 characters on the live investigation
  // — under THIN_MARKDOWN_MIN — so `thin` is true and, without this gate, the
  // very next statement opens the subject's profile in a signed-in browser and
  // LinkedIn tells him. Refusing here keeps the anonymous read we already have.
  if (!browser_gate.allowed) {
    const refusal = {
      tier: browser_gate.tier,
      matched_host: browser_gate.matched_host,
      reason: browser_gate.reason,
    };
    if (firecrawl) return { ...firecrawl, attribution_capped: refusal };
    return { kind: 'failed', reason: browser_gate.reason, source_url: url, refused: refusal };
  }

  // Escalate to the warmed Firefox on the SAME url.
  const browsed = await browse_url.execute(
    { url, wait_ms: opts.browser_wait_ms ?? 2500 },
    tool_ctx,
  );
  if (browsed.deferred) {
    // Defer (retry when the browser is free) rather than lock in a thin shell.
    return { kind: 'deferred', reason: browsed.defer_reason ?? 'Jasper at the keyboard', source_url: url };
  }
  if (browsed.error || !browsed.text) {
    // Browser couldn't improve it: keep the thin Firecrawl content if we had
    // any (better than nothing for indexing), else report the failure.
    return (
      firecrawl ?? {
        kind: 'failed',
        reason: `firecrawl bot-blocked, browse_url also failed: ${browsed.error ?? 'empty text'}`,
        source_url: url,
      }
    );
  }
  const title = browsed.title ?? fetched.title ?? opts.title_fallback ?? null;
  const title_line = title ?? url;
  // The text converter uses the first non-empty line as the title;
  // prepending an H1 gives it a clean title without disturbing the body.
  const markdown = `# ${title_line}\n\n${browsed.text}\n`;
  // If the browser somehow rendered LESS than the thin shell, keep the richer.
  if (firecrawl && markdown.trim().length < firecrawl.markdown.trim().length) {
    return firecrawl;
  }
  return { kind: 'browser', markdown, title, source_url: url };
}
