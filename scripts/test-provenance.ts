/**
 * Self-contained test for the claim-provenance validator
 * (src/core/provenance.ts) — Durable-Truth Phase 1.
 *
 * No LLM, no DB. Drives the extractor + grounding-check + redaction
 * surface directly. The load-bearing case is the Ponds Fire fabrication:
 * Ruby invented "PUC Order E-23734" and a verbatim DFPC quote when asked
 * who owns the power line that caused a local fire. This test reproduces
 * that reply against an empty/irrelevant grounding context and asserts
 * the validator (1) flags the invented order number AND the invented
 * quote as ungrounded, and (2) strips both from the user-facing text —
 * while leaving grounded specifics (a real order number quoted from a
 * tool result, the user's own words) untouched.
 *
 *   bun run smoke:provenance
 */

import {
  build_grounding_context,
  extract_claims,
  find_ungrounded_claims,
  enforce_provenance,
  provenance_retry_nudge,
  is_grounded,
  PROVENANCE_POLICY,
  type Claim,
} from '@core/provenance';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

function has_kind(claims: Claim[], kind: Claim['kind'], needle: string): boolean {
  return claims.some((c) => c.kind === kind && c.text.includes(needle));
}

let checks = 0;
function ok(label: string): void {
  checks++;
  console.log(`  ✓ ${label}`);
}

function main(): void {
  // ── 1. The Ponds Fire fabrication, ungrounded ──────────────────────
  // The real fire was April 23 2026, Pleasantville Light & Power
  // territory — NOT Xcel, and there is no PUC Order E-23734.
  const ruby_reply =
    'The Ponds Fire was caused by a power line owned by Xcel Energy, per ' +
    'PUC Order E-23734. The Colorado DFPC stated: "the fire originated from ' +
    'contact between vegetation and a 115kV transmission line." I am filing ' +
    'this to Knowledge/Pleasantville/incidents/xcel-ponds-fire.md.';

  // Grounding has only the user's question — nothing was actually fetched.
  const empty_grounding = build_grounding_context({
    user_message: 'who owns the power line that caused the Ponds Fire?',
  });

  const claims = extract_claims(ruby_reply);
  assert(
    has_kind(claims, 'identifier', 'E-23734'),
    `identifier extractor missed E-23734 (got: ${claims.map((c) => `${c.kind}:${c.text}`).join(', ')})`,
  );
  ok('extracts the invented order number E-23734 as an identifier');

  assert(
    has_kind(claims, 'quote', '115kV transmission line'),
    'quote extractor missed the fabricated DFPC quote',
  );
  ok('extracts the fabricated DFPC quote');

  const ungrounded = find_ungrounded_claims(ruby_reply, empty_grounding);
  assert(
    has_kind(ungrounded, 'identifier', 'E-23734'),
    'E-23734 should be ungrounded against empty context',
  );
  assert(
    has_kind(ungrounded, 'quote', '115kV transmission line'),
    'the DFPC quote should be ungrounded against empty context',
  );
  ok('both the order number and the quote resolve to NOTHING in grounding');

  const enforced = enforce_provenance(ruby_reply, empty_grounding);
  assert(
    !enforced.text.includes('E-23734'),
    `redaction left the order number in: ${enforced.text}`,
  );
  assert(
    !enforced.text.includes('115kV transmission line'),
    `redaction left the fabricated quote in: ${enforced.text}`,
  );
  assert(
    enforced.redacted.length >= 2,
    `expected >=2 redactions, got ${enforced.redacted.length}`,
  );
  ok('enforce_provenance STRIPS the invented order number and quote from the reply');

  // The retry nudge should name the specific ungrounded claims.
  const nudge = provenance_retry_nudge(ungrounded);
  assert(nudge.includes('E-23734'), 'nudge should name the order number');
  assert(nudge.includes('WILL BE REMOVED'), 'nudge should warn of removal');
  ok('retry nudge names the unsourced specifics and warns they will be removed');

  // ── 2. A grounded order number is NOT stripped ─────────────────────
  // Same shape, but this time a tool actually returned the order number.
  const grounded_reply =
    'Per the PUC docket, the relevant ruling is Order R-19-0455.';
  const real_grounding = build_grounding_context({
    tool_results: [
      JSON.stringify({
        url: 'https://puc.colorado.gov/proceedings',
        markdown: 'Decision No. R-19-0455 — In the Matter of the Investigation...',
      }),
    ],
    user_message: 'what was the PUC ruling?',
  });
  const grounded_ungrounded = find_ungrounded_claims(grounded_reply, real_grounding);
  assert(
    !has_kind(grounded_ungrounded, 'identifier', 'R-19-0455'),
    'a tool-sourced order number must NOT be flagged ungrounded',
  );
  const grounded_enforced = enforce_provenance(grounded_reply, real_grounding);
  assert(
    grounded_enforced.text.includes('R-19-0455'),
    'a grounded order number must survive redaction',
  );
  ok('a tool-sourced identifier (R-19-0455) is grounded and survives');

  // Dash-variant robustness: en-dash + spacing collapse to the same needle.
  assert(
    is_grounded(
      { kind: 'identifier', text: 'R–19 0455', token: 'R–19 0455', index: 0 },
      real_grounding,
    ),
    'identifier grounding should be robust to dash/space variants',
  );
  ok('identifier grounding is robust to dash/spacing variants');

  // ── 3. The user's own quote is grounded ────────────────────────────
  const echo_reply =
    'You said "I want the kitchen remodel done before Thanksgiving" — noted.';
  const echo_grounding = build_grounding_context({
    history: ['I want the kitchen remodel done before Thanksgiving, can you help?'],
    user_message: 'can you help with that?',
  });
  const echo_ungrounded = find_ungrounded_claims(echo_reply, echo_grounding);
  assert(
    !echo_ungrounded.some((c) => c.kind === 'quote'),
    'a quote echoing the conversation history must not be flagged',
  );
  ok('a quote drawn from conversation history is grounded');

  // ── 4. A clean reply with no load-bearing specifics is untouched ───
  const clean = 'I can help with that. What time works best for you?';
  const clean_result = enforce_provenance(clean, empty_grounding);
  assert(clean_result.text === clean, 'a clean reply must pass through unchanged');
  assert(clean_result.redacted.length === 0, 'a clean reply has no redactions');
  ok('a reply with no specifics passes through unchanged');

  // ── 5. Policy: identifiers/quotes enforce, dates/numbers flag ───────
  assert(PROVENANCE_POLICY.identifier === 'enforce', 'identifier must enforce');
  assert(PROVENANCE_POLICY.quote === 'enforce', 'quote must enforce');
  assert(PROVENANCE_POLICY.date === 'flag', 'date must flag');
  assert(PROVENANCE_POLICY.number === 'flag', 'number must flag');
  // A flag-tier ungrounded number is detected but NOT redacted.
  const num_reply = 'The repair will cost about $4,250.';
  const num_result = enforce_provenance(num_reply, empty_grounding);
  assert(
    num_result.all_ungrounded.some((c) => c.kind === 'number'),
    'an ungrounded figure should be detected (flag tier)',
  );
  assert(
    num_result.text === num_reply,
    'a flag-tier figure must NOT be redacted from the text',
  );
  ok('flag-tier (number) is detected but never redacted; enforce-tier is');

  console.log(`\n✓ PROVENANCE TEST PASSED (${checks} checks)`);
}

try {
  main();
} catch (err) {
  console.error(
    '\n✗ PROVENANCE TEST FAILED:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
