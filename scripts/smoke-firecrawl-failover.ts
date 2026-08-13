/**
 * smoke:firecrawl-failover — the Firecrawl→the workstation OUTAGE failover gate.
 *
 * Pure-function. The bug this guards: a dead firecrawl-worker makes every
 * web_fetch_clean time out ("The operation timed out."), and the old
 * is_bot_block-only gate read a timeout as "target unreachable, the browser
 * won't help" — so NOTHING failed over to the workstation during a Firecrawl OUTAGE,
 * exactly when the failover was needed (the user-visible "Kate keeps saying
 * Firecrawl is down" with the workstation sitting idle). web_fetch_clean POSTs to
 * Firecrawl (NOT the target), so a transport error means Firecrawl is the down
 * hop and the independent browser CAN reach the page. is_firecrawl_unreachable
 * is the new detector; the fetch helper escalates on is_bot_block OR it.
 */
import { is_bot_block, is_firecrawl_unreachable } from '../src/connectors/fetch_with_browser_fallback';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// The exact escalation decision fetch_with_browser_fallback uses.
const escalatable = (err: string | undefined): boolean => is_bot_block(err) || is_firecrawl_unreachable(err);

// 1. THE outage signature — the literal error a dead worker produces (verified
//    against the live incident's error sample 2026-06-26).
check('outage: "The operation timed out." → firecrawl-unreachable', is_firecrawl_unreachable('The operation timed out.'));
check('outage: "The operation timed out." → escalatable', escalatable('The operation timed out.'));
check('outage: timeout is NOT mis-classified as a bot block', !is_bot_block('The operation timed out.'));

// 2. Every Firecrawl-transport shape escalates (Firecrawl is the down hop;
//    the workstation is a separate host that still reaches the page).
for (const e of [
  'fetch failed',
  'ECONNREFUSED 127.0.0.1:3002',
  'ECONNRESET',
  'socket hang up',
  'getaddrinfo ENOTFOUND firecrawl',
  'ETIMEDOUT',
  'network error',
]) {
  check(`transport: "${e}" → escalatable`, escalatable(e));
}

// 3. Bot walls still escalate (unchanged), via is_bot_block — not the new path.
for (const e of ['HTTP 403: Forbidden', 'Cloudflare challenge', 'request blocked', 'Firecrawl returned no markdown']) {
  check(`botwall: "${e}" → escalatable`, escalatable(e));
  check(`botwall: "${e}" → bot_block true`, is_bot_block(e));
}

// 4. The two detectors don't bleed: a pure bot wall isn't "firecrawl-unreachable",
//    and a pure transport failure isn't a "bot block".
check('split: 403 is a bot block, not firecrawl-unreachable', is_bot_block('HTTP 403') && !is_firecrawl_unreachable('HTTP 403'));
check('split: ECONNREFUSED is firecrawl-unreachable, not a bot block', is_firecrawl_unreachable('ECONNREFUSED') && !is_bot_block('ECONNREFUSED'));

// 5. A non-error never escalates (don't burn a browser session on success).
check('empty: undefined → not escalatable', !escalatable(undefined));
check('empty: "" → not escalatable', !escalatable(''));

console.log(failures === 0 ? '\nsmoke:firecrawl-failover OK' : `\nsmoke:firecrawl-failover FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
