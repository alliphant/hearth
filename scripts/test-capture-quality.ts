/**
 * Self-contained test for the capture quality gate
 * (src/connectors/capture_quality.ts) — #2b.
 *
 * No DB, no live LLM. Drives assess_capture_quality directly with the two
 * documented Ruby-bootstrap trash bodies + a real document + ambiguous
 * cases routed to a FakeRouter judge. Proves:
 *   - the trash cases reject DETERMINISTICALLY (no model call),
 *   - a download interstitial yields a follow_url,
 *   - a real document accepts without a judge call,
 *   - the ambiguous band routes to the judge and honors its verdict,
 *   - the gate FAILS OPEN when the judge errors / is absent,
 *   - 'minimal' mode only rejects near-empty bodies.
 *
 *   bun run smoke:capture-quality
 */

import {
  assess_capture_quality,
  link_ratio,
  prose_sentences,
  find_binary_link,
} from '@connectors/capture_quality';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMRouter,
  RoleResolution,
} from '@core/llm';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assert: ${msg}`);
}

let checks = 0;
function ok(label: string): void {
  checks++;
  console.log(`  ✓ ${label}`);
}

// ── FakeRouter: a judge whose verdict we control (test-concierge pattern) ──
class FakeProvider implements LLMProvider {
  name = 'fake';
  public calls = 0;
  constructor(private fixed: string) {}
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    return {
      content: this.fixed,
      tool_calls: [],
      finish_reason: 'stop',
      cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'fake' },
    };
  }
  capabilities() {
    return {
      supports_json_schema: false,
      supports_tool_calls: false,
      supports_thinking_mode: false,
      supports_vision: false,
      max_context: 4096,
      cost_per_1m_in_cents: 0,
      cost_per_1m_out_cents: 0,
    };
  }
}
class FakeRouter implements LLMRouter {
  constructor(public provider: FakeProvider) {}
  for_role(): RoleResolution {
    return { provider: this.provider, defaults: { temperature: 0.1 }, model: 'fake' };
  }
}

// The two documented Ruby trash captures (NEXT.md #2b).
const PDF_INTERSTITIAL =
  "The file 'ECON 2021 Offer Narratives.pdf' will begin downloading in a few seconds.";
const NAV_CHROME =
  '[Portal Home Page](/) | [Browse Data](/browse) | [Sign In](/login) | ' +
  '[About](/about) | [Contact](/contact) | [Datasets](/data) | [API](/api)';

// A real document — long, prose-dense, few links.
const REAL_DOC = Array.from(
  { length: 12 },
  (_, i) =>
    `Section ${i + 1}. The Pleasantville transportation master plan sets ` +
    `out a multimodal network that balances vehicle throughput with bicycle ` +
    `and pedestrian safety across the growth corridors over the next decade.`,
).join('\n\n');

// An ambiguous middle capture — over the 200-char hard-reject floor but
// under the 1200-char hard-accept bar, so it routes to the judge. (A
// portal blurb: looks plausibly real, but a judge would call it a shell.)
const AMBIGUOUS =
  'Welcome to the Open Data portal. Use the navigation above to explore ' +
  'datasets across departments. Sign in for full access to downloads and ' +
  'saved searches. Featured collections are updated weekly, and new ' +
  'releases are announced on the homepage. Browse by category, agency, or ' +
  'tag. Contact the data team with questions about formats, licensing, or ' +
  'access. This portal is maintained by the city and refreshed nightly ' +
  'from source systems.';

async function main(): Promise<void> {
  // ── 1. Structural helpers ──────────────────────────────────────────
  assert(link_ratio(NAV_CHROME) > 0.4, 'nav-chrome should be link-dense');
  assert(link_ratio(REAL_DOC) < 0.4, 'a real document should be prose-dense');
  assert(prose_sentences(REAL_DOC) >= 5, 'real doc should have many sentences');
  assert(
    find_binary_link(PDF_INTERSTITIAL, 'https://citygov.com/budget/2021')?.includes('.pdf'),
    'binary-link finder should resolve the named .pdf',
  );
  ok('structural helpers compute link-ratio / prose / binary-link');

  // ── 2. PDF interstitial → reject + follow_url, NO judge call ────────
  const judge_should_not_fire = new FakeProvider('{"is_substantive": true}');
  const v_int = await assess_capture_quality({
    body: PDF_INTERSTITIAL,
    source_url: 'https://citygov.com/budget/2021',
    mode: 'full',
    llm: new FakeRouter(judge_should_not_fire),
  });
  assert(!v_int.ok, 'interstitial must be rejected');
  assert(v_int.content_type === 'interstitial', `expected interstitial, got ${v_int.content_type}`);
  assert(!!v_int.follow_url && v_int.follow_url.includes('.pdf'), 'must surface the real .pdf follow_url');
  assert(judge_should_not_fire.calls === 0, 'short body must NOT reach the judge');
  ok('PDF interstitial → rejected, follow_url populated, judge NOT called');

  // ── 3. Nav-chrome shell → reject, NO judge call ────────────────────
  const judge2 = new FakeProvider('{"is_substantive": true}');
  const v_nav = await assess_capture_quality({
    body: NAV_CHROME,
    mode: 'full',
    llm: new FakeRouter(judge2),
  });
  assert(!v_nav.ok, 'nav-chrome must be rejected');
  assert(
    v_nav.content_type === 'nav_chrome' || v_nav.content_type === 'thin',
    `expected nav_chrome/thin, got ${v_nav.content_type}`,
  );
  assert(judge2.calls === 0, 'short body must NOT reach the judge');
  ok('nav-chrome shell → rejected deterministically (no judge)');

  // ── 4. Real document → accept, NO judge call ───────────────────────
  const judge3 = new FakeProvider('{"is_substantive": false, "content_type": "thin"}');
  const v_doc = await assess_capture_quality({
    body: REAL_DOC,
    mode: 'full',
    llm: new FakeRouter(judge3),
  });
  assert(v_doc.ok, 'a real document must be accepted');
  assert(judge3.calls === 0, 'a clearly-substantive doc must NOT reach the judge');
  ok('real document → accepted, judge NOT called');

  // ── 5. Ambiguous middle → routes to judge, honors verdict ──────────
  const judge_reject = new FakeProvider(
    '{"is_substantive": false, "content_type": "nav_chrome", "confidence": 0.9, "reason": "portal landing", "follow_url": null}',
  );
  const v_amb_reject = await assess_capture_quality({
    body: AMBIGUOUS,
    mode: 'full',
    llm: new FakeRouter(judge_reject),
  });
  assert(judge_reject.calls === 1, 'ambiguous body MUST reach the judge');
  assert(!v_amb_reject.ok && v_amb_reject.content_type === 'nav_chrome', 'judge reject must be honored');
  ok('ambiguous body → routed to judge; reject verdict honored');

  const judge_accept = new FakeProvider('{"is_substantive": true, "content_type": "document"}');
  const v_amb_ok = await assess_capture_quality({
    body: AMBIGUOUS,
    mode: 'full',
    llm: new FakeRouter(judge_accept),
  });
  assert(judge_accept.calls === 1 && v_amb_ok.ok, 'judge accept must be honored');
  ok('ambiguous body → judge accept verdict honored');

  // ── 6. Fail-open: garbage judge + absent llm both ACCEPT ───────────
  const judge_garbage = new FakeProvider('not json at all <think>hmm</think>');
  const v_garbage = await assess_capture_quality({
    body: AMBIGUOUS,
    mode: 'full',
    llm: new FakeRouter(judge_garbage),
  });
  assert(v_garbage.ok, 'unparseable judge output must FAIL OPEN (accept)');
  const v_no_llm = await assess_capture_quality({ body: AMBIGUOUS, mode: 'full' });
  assert(v_no_llm.ok, 'absent llm must FAIL OPEN (accept)');
  ok('fail-open: garbage judge AND absent llm both accept');

  // ── 7. minimal mode only rejects near-empty ────────────────────────
  const v_min_pass = await assess_capture_quality({ body: PDF_INTERSTITIAL, mode: 'minimal' });
  assert(v_min_pass.ok, 'minimal mode must NOT reject a deliberate short upload');
  const v_min_empty = await assess_capture_quality({ body: '   ', mode: 'minimal' });
  assert(!v_min_empty.ok, 'minimal mode must reject a near-empty upload');
  ok("minimal mode rejects only near-empty; otherwise accepts");

  console.log(`\n✓ CAPTURE-QUALITY TEST PASSED (${checks} checks)`);
}

main().catch((err: unknown) => {
  console.error('\n✗ CAPTURE-QUALITY TEST FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
