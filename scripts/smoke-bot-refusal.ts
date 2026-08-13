/**
 * smoke:bot-refusal — the line between "the always-on host is down" and "the site said no".
 *
 * Owner's rule (2026-07-31): Hearth may power on the GPU box when the always-on host is
 * genuinely the problem, and must NEVER wake a second host to retry a page that
 * refused us. Retrying a Cloudflare wall from another machine on the same home
 * connection is bot-block evasion, and what it risks is the household's own IP
 * range getting flagged.
 *
 * `is_bot_block` used to collapse both cases into one predicate, so a 403
 * escalated exactly like a dead worker. These checks keep them apart.
 *
 *   bun run smoke:bot-refusal
 */
import {
  is_hard_refusal,
  needs_rendering,
  is_firecrawl_unreachable,
} from '../src/connectors/fetch_with_browser_fallback';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function main(): void {
  // ── REFUSALS — must never wake a host ─────────────────────────────────────
  for (const err of [
    'HTTP 403: Forbidden',
    'HTTP 429: Too Many Requests',
    'HTTP 406: Not Acceptable',
    'Attention Required! | Cloudflare',
    'PerimeterX blocked this request',
    'Access Denied',
    'please complete the captcha',
  ]) {
    check(`refusal: ${err.slice(0, 38)}`, is_hard_refusal(err) === true);
    check(`  …and is NOT treated as a render problem`, needs_rendering(err) === false);
  }

  // ── RENDERING — the site never refused, it just needs JS ──────────────────
  for (const err of ['no markdown returned', 'empty body', 'requires javascript']) {
    check(`render-only: ${err}`, needs_rendering(err) === true);
    check(`  …and is NOT a refusal`, is_hard_refusal(err) === false);
  }

  // ── TRANSPORT — the always-on host's worker is the down hop. THIS is "the always-on host is the issue" ─
  for (const err of ['ECONNREFUSED', 'ENOTFOUND firecrawl', 'ETIMEDOUT', 'socket hang up']) {
    check(`transport, not a refusal: ${err}`, is_hard_refusal(err) === false);
  }
  check('a dead firecrawl IS the escalatable case', is_firecrawl_unreachable('ECONNREFUSED') === true);

  // ── The specific trap: "blocked" inside an otherwise ordinary message ─────
  check('the word "blocked" alone is a refusal', is_hard_refusal('request blocked') === true);
  check('an empty error is neither', !is_hard_refusal(undefined) && !needs_rendering(undefined));

  // ── The two predicates must never both claim the same error ───────────────
  // If they overlap, the escalation gate becomes ambiguous and the refusal arm
  // can be bypassed by whichever check runs second.
  const samples = [
    'HTTP 403: Forbidden',
    'cloudflare',
    'no markdown returned',
    'requires javascript',
    'ECONNREFUSED',
    'ETIMEDOUT',
  ];
  check(
    'refusal and render-needed are mutually exclusive on every sample',
    samples.every((e) => !(is_hard_refusal(e) && needs_rendering(e))),
  );

  console.log(`\n✅ smoke:bot-refusal — ${passed} checks passed`);
}

main();
