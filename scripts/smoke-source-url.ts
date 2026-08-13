/**
 * smoke:source-url — Kristi's source_url arg-spiral fix (2026-07-26).
 *
 * `source_url: z.string().url()` in an input_schema is the same class as the
 * banned `.regex()`: the model emits a real citation typed slightly wrong,
 * Zod rejects the WHOLE call, the model retries identically →
 * DUPLICATE_TOOL_CALL → spiral, and the write never lands. It was still
 * failing live on 2026-07-26.
 *
 * Fixed the documented way — permissive schema, normalize + typed recovery in
 * execute — NOT by dropping validation (`.min(1)` alone stores garbage and
 * quietly breaks the provenance this store exists for). This smoke pins both
 * halves: the recoveries that must succeed, and the rejects that must stay
 * honest with an actionable message.
 */
import { normalize_source_url, coerce_url } from '../src/specialists/kristi/tools/record_facts';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + msg);
  } else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

function main() {
  console.log('→ A. recovered — a correct citation typed slightly wrong');
  const recovered: Array<[string, string]> = [
    ['https://www.dell.com/precision-9', 'https://www.dell.com/precision-9'],
    ['dell.com/precision-9', 'https://dell.com/precision-9'],
    ['www.hp.com/z2-g1i', 'https://www.hp.com/z2-g1i'],
    ['//lenovo.com/thinkstation', 'https://lenovo.com/thinkstation'],
    ['  https://nvidia.com/dgx-spark  ', 'https://nvidia.com/dgx-spark'],
    ['http://example.com/a', 'http://example.com/a'],
  ];
  for (const [raw, want] of recovered) {
    const r = normalize_source_url(raw);
    ok(r.ok && r.url === want, `${JSON.stringify(raw)} → ${want}`);
  }
  // Trailing punctuation is how a link dies when it's quoted mid-sentence.
  for (const raw of ['https://dell.com/p9.', 'https://dell.com/p9,', 'https://dell.com/p9)', "https://dell.com/p9'"]) {
    const r = normalize_source_url(raw);
    ok(r.ok && r.url === 'https://dell.com/p9', `trailing punctuation stripped: ${JSON.stringify(raw)}`);
  }

  console.log('→ B. rejected — but honestly, with something to act on');
  for (const [raw, why] of [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['the dell website', 'prose, not a link'],
    ['ftp://dell.com/x', 'wrong protocol'],
    ['localhost', 'no real domain'],
  ] as Array<[string, string]>) {
    const r = normalize_source_url(raw);
    ok(!r.ok, `rejects ${why}: ${JSON.stringify(raw)}`);
    if (!r.ok) {
      ok(r.recovery.length > 40 && /re-call/i.test(r.recovery), `  …with an actionable recovery, not a bare error`);
      ok(r.recovery.includes('source_url'), '  …naming the field so the retry is targeted');
    }
  }
  const named = normalize_source_url('nope', 'citation_url');
  ok(!named.ok && named.recovery.includes('citation_url'), 'the field name is parameterized (reusable across tools)');
  const prose = normalize_source_url('the dell website');
  ok(!prose.ok && /notes/.test(prose.recovery), 'steers to `notes` rather than inventing a link — the anti-fabrication half');

  console.log('→ C. coerce_url — the non-load-bearing spots');
  ok(coerce_url('dell.com/x') === 'https://dell.com/x', 'coerces a bare host');
  ok(coerce_url('the dell website') === 'the dell website', 'keeps an unusable value verbatim rather than rejecting the call');
  ok(coerce_url('  https://a.com/b  ') === 'https://a.com/b', 'trims');

  console.log('→ D. the live failure that motivated this');
  // A trailing-comma'd link is EXACTLY what z.string().url() rejected while
  // being a perfectly good citation — the spiral starter.
  const live = normalize_source_url('https://www.dell.com/en-us/shop/precision-3590,');
  ok(live.ok && live.url === 'https://www.dell.com/en-us/shop/precision-3590', 'the 2026-07-26 shape now lands');

  console.log(`\n${failed === 0 ? '✓' : '✗'} smoke:source-url — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
