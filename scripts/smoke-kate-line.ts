/**
 * smoke:kate-line — Kate-authors-the-line (src/core/kate_line.ts): the push
 * funnel's voice pass. Pure — mocked LLM, no network. Asserts the contract
 * that makes it safe to arm: the model owns ONLY the voice; code owns the
 * exemptions and the fact guard, and every miss falls back to the original
 * template (worst case = today's push, byte-identical).
 */
import {
  apply_kate_voice,
  rewrite_acceptable,
  is_voice_exempt,
} from '../src/core/kate_line';
import type { LLMRouter } from '../src/core/llm';

let checks = 0;
let fails = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) fails++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
}

function mock_llm(reply: string, opts?: { throws?: boolean; count?: { n: number } }): LLMRouter {
  return {
    for_role: (_r: string) => ({
      provider: {
        complete: async () => {
          if (opts?.count) opts.count.n++;
          if (opts?.throws) throw new Error('endpoint down');
          return { content: reply };
        },
      },
      defaults: {},
    }),
  } as unknown as LLMRouter;
}

const TEMPLATE = 'Cox bill $55.04 is due July 10. Reply to confirm or defer.';
const VOICED = 'Cox wants their $55.04 by July 10 — say the word and I confirm it, or we let it sit.';

async function main(): Promise<void> {
  // ── pure guards ────────────────────────────────────────────────────────────
  check('exempt: severity high', is_voice_exempt({ kind: 'ad_hoc', severity: 'high' }));
  check('exempt: approval_request', is_voice_exempt({ kind: 'approval_request', severity: 'medium' }));
  check('exempt: test', is_voice_exempt({ kind: 'test' }));
  check('not exempt: medium ad_hoc', !is_voice_exempt({ kind: 'ad_hoc', severity: 'medium' }));
  check('fact guard: verbatim numbers pass', rewrite_acceptable(TEMPLATE, VOICED));
  check('fact guard: dropped amount → reject', !rewrite_acceptable(TEMPLATE, 'Cox bill is due July 10 — want me to confirm?'));
  check('fact guard: altered amount → reject', !rewrite_acceptable(TEMPLATE, 'Cox wants $55.40 by July 10.'));
  check('fact guard: runaway length → reject', !rewrite_acceptable(TEMPLATE, VOICED + ' ' + 'and another thing — '.repeat(30)));
  check('fact guard: markdown fence → reject', !rewrite_acceptable(TEMPLATE, '```' + VOICED + '```'));
  check('fact guard: near-empty → reject', !rewrite_acceptable(TEMPLATE, 'ok'));

  // ── the pass, end to end ───────────────────────────────────────────────────
  const ctx = { kind: 'ad_hoc', severity: 'medium' };

  delete process.env.HEARTH_KATE_LINES;
  const count_off = { n: 0 };
  const off = await apply_kate_voice(mock_llm(VOICED, { count: count_off }), TEMPLATE, ctx, 'Jasper');
  check('kill switch off: original text, LLM never called', off === TEMPLATE && count_off.n === 0);

  process.env.HEARTH_KATE_LINES = '1';
  check('no llm wired: original text', (await apply_kate_voice(undefined, TEMPLATE, ctx, 'Jasper')) === TEMPLATE);

  const count_high = { n: 0 };
  const high = await apply_kate_voice(mock_llm(VOICED, { count: count_high }), '⚠️ Take cover: 70 mph gusts.', { kind: 'ad_hoc', severity: 'high' }, 'Jasper');
  check('severity high: byte-exact, LLM never called', high === '⚠️ Take cover: 70 mph gusts.' && count_high.n === 0);

  const voiced = await apply_kate_voice(mock_llm(VOICED), TEMPLATE, ctx, 'Jasper');
  check('happy path: voiced rewrite ships', voiced === VOICED);

  const quoted = await apply_kate_voice(mock_llm(`"${VOICED}"`), TEMPLATE, ctx, 'Jasper');
  check('quote-wrapped rewrite: unwrapped and shipped', quoted === VOICED);

  check('fact-guard miss falls back to template', (await apply_kate_voice(mock_llm('Bill due soon, I handled it.'), TEMPLATE, ctx, 'Jasper')) === TEMPLATE);
  check('LLM throws: template, no throw', (await apply_kate_voice(mock_llm('', { throws: true }), TEMPLATE, ctx, 'Jasper')) === TEMPLATE);
  check('empty rewrite: template', (await apply_kate_voice(mock_llm('   '), TEMPLATE, ctx, 'Jasper')) === TEMPLATE);
  check('tiny original: skipped (no model call)', (await apply_kate_voice(mock_llm(VOICED), 'Ping.', ctx, 'Jasper')) === 'Ping.');

  delete process.env.HEARTH_KATE_LINES;

  console.log('─'.repeat(50));
  if (fails) {
    console.log(`  ${fails}/${checks} FAILED`);
    process.exit(1);
  }
  console.log(`  ✓ smoke:kate-line PASSED (${checks} checks)`);
}

void main();
