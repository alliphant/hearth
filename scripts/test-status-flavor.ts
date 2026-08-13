/**
 * smoke:status-flavor — the contextual "thinking" line generator
 * (src/core/status_flavor.ts). Pure-function + mock-LLM, no live model:
 * the validate / denylist / gerund matrix, prompt construction, the fail-open
 * compose paths, and the non-blocking emit wrapper. Mirrors smoke:fact-critic /
 * smoke:complexity (manual asserts, exit non-zero on any FAIL).
 */
import {
  validate_status_phrase,
  build_status_messages,
  compose_status_flavor,
  maybe_upgrade_status_flavor,
  status_flavor_enabled,
} from '../src/core/status_flavor';
import type { LLMRouter, LLMResponse, ToolCallSpec } from '../src/core/llm';
import type { AppEvent, AppEventBus } from '../src/app/events';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

function resp_of(content: string): LLMResponse {
  return {
    content,
    tool_calls: [],
    finish_reason: 'stop',
    cost: { tokens_in: 0, tokens_out: 0, ms: 1, model: 'mock' },
  };
}

function mock_llm(complete: () => Promise<LLMResponse>): LLMRouter {
  return {
    for_role: () => ({
      provider: { name: 'mock', complete, capabilities: () => ({}) },
      defaults: {},
      model: 'mock',
    }),
  } as unknown as LLMRouter;
}

function throwing_for_role(): LLMRouter {
  return {
    for_role: () => {
      throw new Error('no such role');
    },
  } as unknown as LLMRouter;
}

const CALLS: ToolCallSpec[] = [
  { id: 't1', name: 'web_search', arguments: { query: 'cold brew thermal shock' } },
  { id: 't2', name: 'consult_deep_model', arguments: { question: 'Does rapid chilling crack the carafe?' } },
];

async function main(): Promise<void> {
  // ── validate_status_phrase matrix ───────────────────────────────────────
  check(
    'good gerund phrase passes verbatim',
    validate_status_phrase('Reconciling thermal shock concerns with cold brew') ===
      'Reconciling thermal shock concerns with cold brew',
  );
  check('strips wrapping quotes', validate_status_phrase('"Distilling the tasting notes"') === 'Distilling the tasting notes');
  check('strips trailing ellipsis', validate_status_phrase('Charting the roast curve…') === 'Charting the roast curve');
  check('hyphenated gerund passes', validate_status_phrase('Cross-referencing two brew methods') === 'Cross-referencing two brew methods');
  check('denylist: Terminating → null', validate_status_phrase('Terminating the brew process') === null);
  check('denylist: Connecting → null', validate_status_phrase('Connecting to the roaster') === null);
  check('denylist: Penetrating → null', validate_status_phrase('Penetrating the bean') === null);
  check('non-gerund lead → null', validate_status_phrase('The model weighs options') === null);
  check('lowercase lead → null', validate_status_phrase('reconciling the notes') === null);
  check('over-long → null', validate_status_phrase('Reconciling ' + 'x'.repeat(100)) === null);
  check('empty → null', validate_status_phrase('') === null);

  // ── build_status_messages ───────────────────────────────────────────────
  const msgs = build_status_messages({ user_message: 'how do I avoid cracking my carafe?', tool_calls: CALLS });
  const userMsg = msgs[1]?.content ?? '';
  check('prompt carries the user message', userMsg.includes('cracking my carafe'));
  check('prompt carries the deep-consult question', userMsg.includes('rapid chilling'));
  check('prompt lists the tool calls', userMsg.includes('web_search') && userMsg.includes('consult_deep_model'));

  // ── compose_status_flavor (env gating + fail-open) ──────────────────────
  delete process.env.HEARTH_STATUS_FLAVOR;
  check(
    'disabled → null (no LLM call)',
    (await compose_status_flavor({ user_message: 'x', tool_calls: CALLS }, mock_llm(async () => resp_of('Brewing happily')))) === null,
  );

  process.env.HEARTH_STATUS_FLAVOR = '1';
  check(
    'enabled + good response → phrase',
    (await compose_status_flavor({ user_message: 'x', tool_calls: CALLS }, mock_llm(async () => resp_of('Reconciling thermal shock concerns')))) ===
      'Reconciling thermal shock concerns',
  );
  check(
    'no tool calls → null',
    (await compose_status_flavor({ user_message: 'x', tool_calls: [] }, mock_llm(async () => resp_of('Pondering')))) === null,
  );
  check(
    'for_role throws → null (fail-open)',
    (await compose_status_flavor({ user_message: 'x', tool_calls: CALLS }, throwing_for_role())) === null,
  );
  check(
    'complete throws → null (fail-open)',
    (await compose_status_flavor({ user_message: 'x', tool_calls: CALLS }, mock_llm(async () => { throw new Error('endpoint down'); }))) === null,
  );
  check(
    'denylisted response → null',
    (await compose_status_flavor({ user_message: 'x', tool_calls: CALLS }, mock_llm(async () => resp_of('Terminating the carafe')))) === null,
  );

  // ── maybe_upgrade_status_flavor (non-blocking emit wrapper) ─────────────
  const emitted: AppEvent[] = [];
  const events = {
    emit: (e: AppEvent) => { emitted.push(e); },
    subscribe: () => () => {},
    current_active_streams: () => [],
    current_active_tool_calls: () => [],
    size: () => 0,
  } as unknown as AppEventBus;

  process.env.HEARTH_STATUS_FLAVOR = '1';
  await maybe_upgrade_status_flavor({
    llm: mock_llm(async () => resp_of('Foraging for the perfect ratio')),
    events,
    specialist_id: 'kate',
    specialist_name: 'Kate',
    conversation_id: 'c1',
    messages: [{ role: 'user', content: 'help me dial in cold brew' }],
    tool_calls: CALLS,
    ttl_seconds: 30,
  });
  check('upgrade emits exactly one specialist_status', emitted.length === 1 && emitted[0]?.type === 'specialist_status');
  check(
    'upgrade wraps as "<Name> is <lowercased gerund>…"',
    emitted.length === 1 && (emitted[0] as { status?: string }).status === 'Kate is foraging for the perfect ratio…',
  );

  emitted.length = 0;
  delete process.env.HEARTH_STATUS_FLAVOR;
  await maybe_upgrade_status_flavor({
    llm: mock_llm(async () => resp_of('Foraging for the perfect ratio')),
    events,
    specialist_id: 'kate',
    specialist_name: 'Kate',
    conversation_id: 'c1',
    messages: [{ role: 'user', content: 'x' }],
    tool_calls: CALLS,
    ttl_seconds: 30,
  });
  check('disabled → no emit', emitted.length === 0);
  check('status_flavor_enabled reads env at call time', status_flavor_enabled() === false);

  console.log(`\n${checks} checks`);
}

void main();
