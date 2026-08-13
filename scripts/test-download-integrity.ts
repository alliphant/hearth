/**
 * Self-contained test for the download integrity gate
 * (src/connectors/download_integrity.ts).
 *
 * No DB, no live LLM. Drives assess_download_integrity directly with
 * crafted byte buffers + a FakeRouter judge. Proves:
 *   - real binary bytes (a %PDF, a PNG) accept WITHOUT a judge call,
 *   - asked-for-a-PDF-but-got-HTML (the FCGOV stub) rejects
 *     DETERMINISTICALLY with a follow_url and NO judge call,
 *   - a 0-byte file rejects as thin,
 *   - text expected + text body routes to the intent judge and honors it,
 *   - the gate FAILS OPEN when the judge errors / is absent,
 *   - 'off' mode always accepts.
 *
 *   bun run smoke:download-integrity
 */

import {
  assess_download_integrity,
  sniff_format,
  expected_kind,
} from '@connectors/download_integrity';
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

// ── FakeRouter (capture-quality test pattern) ──────────────────────────
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

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// A minimal-but-valid %PDF byte header.
const PDF_BYTES = enc('%PDF-1.7\n%âãÏÓ\n1 0 obj<< /Type /Catalog >>endobj\n');
// PNG 8-byte signature.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
// The FCGOV failure: a request for a budget PDF that returned an HTML
// download-landing page instead of the file.
const HTML_STUB =
  '<!DOCTYPE html><html><head><title>Download</title></head><body>' +
  "<p>Your download of <a href=\"/files/2021-budget.pdf\">2021-budget.pdf</a> " +
  'will begin shortly. If it does not, click the link above.</p></body></html>';
// A legitimate text file the caller actually wanted (no extension hint).
const REAL_TEXT =
  'Zone 2 training keeps heart rate in the aerobic base where fat oxidation ' +
  'peaks. Hold a conversational pace for 45–90 minutes, three to five times ' +
  'a week, to build mitochondrial density without accumulating fatigue.';

async function main(): Promise<void> {
  // ── 1. Sniffer + expected-kind helpers ─────────────────────────────
  assert(sniff_format(PDF_BYTES) === 'pdf', 'must sniff %PDF as pdf');
  assert(sniff_format(PNG_BYTES) === 'png', 'must sniff PNG signature');
  assert(sniff_format(enc(HTML_STUB)) === 'html', 'must sniff html stub');
  assert(sniff_format(new Uint8Array(0)) === 'empty', 'empty bytes → empty');
  assert(expected_kind('2021-budget.pdf', null).binary === true, 'pdf ext → binary');
  assert(expected_kind('notes.md', null).binary === false, 'md ext → text');
  assert(expected_kind(null, null).binary === null, 'no ext → unknown');
  ok('sniffer + expected-kind helpers classify formats and intents');

  // ── 2. Real binary bytes → accept, NO judge call ────────────────────
  const judge0 = new FakeProvider('{"matches_intent": false, "content_type": "thin"}');
  const v_pdf = await assess_download_integrity({
    bytes: PDF_BYTES,
    filename: 'budget.pdf',
    url: 'https://citygov.com/budget/2021.pdf',
    description: 'the 2021 city budget',
    llm: new FakeRouter(judge0),
  });
  assert(v_pdf.ok && v_pdf.sniffed_format === 'pdf', 'real PDF must accept');
  assert(judge0.calls === 0, 'real binary must NOT reach the judge');
  ok('real PDF bytes → accepted, judge NOT called');

  // ── 3. Asked-for-PDF, got HTML stub → reject + follow_url, NO judge ──
  const judge1 = new FakeProvider('{"matches_intent": true}');
  const v_stub = await assess_download_integrity({
    bytes: enc(HTML_STUB),
    filename: '2021-budget.pdf',
    url: 'https://citygov.com/budget/2021',
    description: 'the 2021 city budget PDF',
    llm: new FakeRouter(judge1),
  });
  assert(!v_stub.ok, 'PDF-but-got-HTML must be rejected');
  assert(v_stub.content_type === 'redirect_stub', `expected redirect_stub, got ${v_stub.content_type}`);
  assert(!!v_stub.follow_url && v_stub.follow_url.includes('.pdf'), 'must surface the real .pdf follow_url');
  assert(judge1.calls === 0, 'a type mismatch must reject deterministically, no judge');
  ok('PDF intent + HTML body → rejected deterministically, follow_url populated');

  // ── 4. Empty file → reject as thin ──────────────────────────────────
  const v_empty = await assess_download_integrity({ bytes: new Uint8Array(0), filename: 'x.pdf' });
  assert(!v_empty.ok && v_empty.content_type === 'thin', 'empty file must reject as thin');
  ok('0-byte file → rejected as thin');

  // ── 5. Text intent + text body → routes to judge, honors verdict ────
  const judge_reject = new FakeProvider(
    '{"matches_intent": false, "content_type": "login_wall", "confidence": 0.9, "reason": "sign-in page", "follow_url": null}',
  );
  const v_text_reject = await assess_download_integrity({
    bytes: enc(REAL_TEXT),
    filename: 'zone2.txt',
    url: 'https://example.com/zone2',
    description: 'zone 2 training notes',
    llm: new FakeRouter(judge_reject),
  });
  assert(judge_reject.calls === 1, 'text body MUST reach the intent judge');
  assert(!v_text_reject.ok && v_text_reject.content_type === 'login_wall', 'judge reject must be honored');
  ok('text intent + text body → routed to judge; reject honored');

  const judge_accept = new FakeProvider('{"matches_intent": true, "content_type": "match"}');
  const v_text_ok = await assess_download_integrity({
    bytes: enc(REAL_TEXT),
    filename: 'zone2.txt',
    description: 'zone 2 training notes',
    llm: new FakeRouter(judge_accept),
  });
  assert(judge_accept.calls === 1 && v_text_ok.ok, 'judge accept must be honored');
  ok('text intent + text body → judge accept honored');

  // ── 6. Fail-open: garbage judge + absent llm both ACCEPT ────────────
  const judge_garbage = new FakeProvider('not json <think>hmm</think>');
  const v_garbage = await assess_download_integrity({
    bytes: enc(REAL_TEXT),
    filename: 'zone2.txt',
    description: 'zone 2 training notes',
    llm: new FakeRouter(judge_garbage),
  });
  assert(v_garbage.ok, 'unparseable judge output must FAIL OPEN (accept)');
  const v_no_llm = await assess_download_integrity({
    bytes: enc(REAL_TEXT),
    filename: 'zone2.txt',
    description: 'zone 2 training notes',
  });
  assert(v_no_llm.ok, 'absent llm must FAIL OPEN (accept)');
  ok('fail-open: garbage judge AND absent llm both accept');

  // ── 7. 'off' mode always accepts ────────────────────────────────────
  const v_off = await assess_download_integrity({
    bytes: enc(HTML_STUB),
    filename: 'budget.pdf',
    mode: 'off',
  });
  assert(v_off.ok, "'off' mode must always accept");
  ok("'off' mode bypasses the gate");

  console.log(`\n✓ DOWNLOAD-INTEGRITY TEST PASSED (${checks} checks)`);
}

main().catch((err: unknown) => {
  console.error('\n✗ DOWNLOAD-INTEGRITY TEST FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
