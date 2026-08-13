/**
 * Smoke for the thrown-error recovery channel (2026-07-31).
 *
 * The soft-fail half already worked: a connector returning `{error, candidates}`
 * gets a recovery nudge appended by the runtime. A connector that THREW had no
 * channel at all — `ToolRegistry.invoke`'s catch kept `err.message` and dropped
 * every other property, so `(err as any).candidates = [...]` vanished before any
 * caller saw it.
 *
 * That silent drop is why the "add candidates to <tool> on error path" proposal
 * family (79 filed across 28 tools since 2026-05-25; one executed) could never
 * work: the fix shipped, the specialist still saw a bare error, the miss
 * recurred, and the same recommendation was filed again. This smoke locks the
 * envelope so that loop cannot restart.
 */
import { z } from 'zod';
import {
  ToolRegistry,
  with_candidates,
  sanitize_candidates,
  type InvokeOutcome,
} from '../src/core/tool_registry';
import type { Tool, ToolContext } from '../src/core/tool';
import {
  describe_failed_read,
  failed_read_cause,
  failed_read_hint_count,
  is_behavior_signal_error,
  is_failed_read,
  type SerializedToolCall,
} from '../src/core/authenticity';
import { within_allowlist } from '../src/specialists/trainer/codebase_fs';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const ctx = {} as ToolContext;
const NO_CAPS = new Set<never>() as ReadonlySet<never>;

function make_tool(name: string, run: () => never | Record<string, unknown>): Tool {
  return {
    name,
    description: 'smoke',
    risk: 'read',
    input_schema: z.object({}),
    output_schema: z.object({ ok: z.boolean() }).partial(),
    async execute() { return run() as never; },
  } as unknown as Tool;
}

async function invoke(tool: Tool): Promise<InvokeOutcome> {
  const reg = new ToolRegistry();
  reg.register(tool);
  return reg.invoke(tool.name, {}, ctx, NO_CAPS as ReadonlySet<never> as never, 'smoke');
}

console.log('→ sanitize_candidates is defensive about untrusted input');
{
  check('non-array → []', sanitize_candidates('nope').length === 0);
  check('null/undefined → []', sanitize_candidates(null).length === 0 && sanitize_candidates(undefined).length === 0);
  check('non-string members dropped', JSON.stringify(sanitize_candidates(['a', 3, {}, null, 'b'])) === '["a","b"]');
  check('blank + whitespace-only dropped', JSON.stringify(sanitize_candidates(['', '   ', 'x'])) === '["x"]');
  check('trimmed', JSON.stringify(sanitize_candidates(['  p/q.md  '])) === '["p/q.md"]');
  check('de-duped', JSON.stringify(sanitize_candidates(['a', 'a', 'a'])) === '["a"]');
  check('capped at 15', sanitize_candidates(Array.from({ length: 50 }, (_, i) => `p${i}`)).length === 15);
  check('absurdly long member dropped (context guard)', sanitize_candidates(['z'.repeat(401)]).length === 0);
  check('…but a 400-char member is kept', sanitize_candidates(['z'.repeat(400)]).length === 1);
}

console.log('→ THE FIX: candidates survive a throw, through invoke()');
{
  const t = make_tool('boom_with_hints', () => {
    throw with_candidates(new Error('read failed: no such thing'), [
      'Knowledge/Anya/household.md',
      'Knowledge/Anya/household_notes.md',
    ]);
  });
  const out = await invoke(t);
  check('ok:false', out.ok === false);
  check('reason execute', out.reason === 'execute');
  check('message preserved verbatim', out.error === 'read failed: no such thing');
  check('candidates carried out of the catch', JSON.stringify(out.candidates) ===
    JSON.stringify(['Knowledge/Anya/household.md', 'Knowledge/Anya/household_notes.md']),
    `got ${JSON.stringify(out.candidates)}`);
}

console.log('→ a plain throw is unchanged (no empty array, no new key)');
{
  const out = await invoke(make_tool('boom_plain', () => { throw new Error('bare'); }));
  check('error preserved', out.error === 'bare');
  check('no candidates key at all', !('candidates' in out), JSON.stringify(out));
}

console.log('→ a hot-loaded tool cannot inject junk into the model context');
{
  const t = make_tool('boom_hostile', () => {
    const e = new Error('hostile');
    (e as Error & { candidates?: unknown }).candidates = [
      { evil: true }, 'ok/path.md', 42, 'x'.repeat(9999),
    ];
    throw e;
  });
  const out = await invoke(t);
  check('only the clean string survives', JSON.stringify(out.candidates) === '["ok/path.md"]',
    `got ${JSON.stringify(out.candidates)}`);
}
{
  const t = make_tool('boom_nonarray', () => {
    const e = new Error('weird');
    (e as Error & { candidates?: unknown }).candidates = { not: 'an array' };
    throw e;
  });
  const out = await invoke(t);
  check('non-array candidates property ignored', !('candidates' in out));
}

console.log('→ with_candidates never fabricates a key it has nothing for');
{
  const e = with_candidates(new Error('x'), []);
  check('empty input attaches nothing', !('candidates' in (e as object)));
  const e2 = with_candidates(new Error('x'), ['', '  ']);
  check('all-blank input attaches nothing', !('candidates' in (e2 as object)));
  check('returns the same Error instance', (() => { const orig = new Error('y'); return with_candidates(orig, ['a']) === orig; })());
}

console.log('→ THE LEDGER HALF: the miss text names the real cause, both channels');
{
  // The 2026-08-02 finding. `is_failed_read` reads BOTH the throw channel and
  // the soft `{error}` channel, but the reporting side only read `c.error` —
  // so every soft failure was written to the ledger as the literal string
  // "null state". 225 of 400 live auth:* misses, incl. all 199
  // web_fetch_clean rows, carried no cause at all. Beatrice re-files from
  // these rows, so the vague text kept regenerating the very proposal family
  // this smoke's first half closed in the runtime.
  const soft: SerializedToolCall = {
    name: 'web_fetch_clean',
    input: { url: 'https://www.dell.com/precision-9' },
    result: {
      title: null,
      markdown: '',
      error: 'Firecrawl HTTP 500: upstream render timeout',
      candidates: ['https://dell.com/precision-9', 'https://www.dell.com/precision9'],
    },
  };
  const line = describe_failed_read(soft);
  check('soft failure no longer reports "null state"', !line.includes('null state'), line);
  check('soft failure names the real error', line.includes('Firecrawl HTTP 500'), line);
  check('soft failure names WHICH url', line.includes('dell.com/precision-9'), line);
  check('offered candidates are surfaced', line.includes('2 retry candidates'), line);

  const thrown: SerializedToolCall = {
    name: 'read_note',
    input: { path: 'Knowledge/Mariah/persona.md' },
    error: 'read_note: note not found at "Knowledge/Mariah/persona.md"',
    candidates: ['Knowledge/Mariah/Persona.md'],
  };
  const tline = describe_failed_read(thrown);
  check('throw channel still preferred', tline.includes('note not found'), tline);
  check('throw-path candidates counted (singular)', tline.includes('1 retry candidate]'), tline);

  // The ONE case where "null state" is the honest description.
  const ha: SerializedToolCall = {
    name: 'ha_get_state',
    input: { entity_id: 'sensor.gone' },
    result: { state: null },
  };
  check('ha_get_state null state keeps its name', describe_failed_read(ha).includes('null state'));
  check('…and names the entity', describe_failed_read(ha).includes('sensor.gone'));

  // A tool that offered nothing must NOT claim it did — that distinction is
  // what decides whether the tool layer or the specialist owns the fix.
  const bare: SerializedToolCall = { name: 'x', input: {}, error: 'boom' };
  check('no hints → no candidate clause', !describe_failed_read(bare).includes('retry candidate'));
  check('unknown arg renders empty, not "undefined"', describe_failed_read(bare).startsWith('x() → boom'));

  // Reporting must stay in step with detection: anything is_failed_read
  // flags has to yield a cause that isn't the fallback.
  const detected = [soft, thrown, ha].every((c) =>
    is_failed_read(c.name, c.result, c.error) &&
    !failed_read_cause(c).includes('no cause recorded'),
  );
  check('every detected failure yields a named cause', detected);

  // Hostile/garbage shapes must not crash or inflate the count.
  check('non-array candidates ignored', failed_read_hint_count(
    { name: 'x', candidates: { not: 'array' } } as SerializedToolCall) === 0);
  check('non-string members not counted', failed_read_hint_count(
    { name: 'x', candidates: ['ok', 3, null, '  '] } as SerializedToolCall) === 1);
  check('null result survives', describe_failed_read({ name: 'x', result: null } as SerializedToolCall)
    .includes('no cause recorded'));
}

console.log('→ the fetch-budget cap is a behaviour signal, not a read failure');
{
  // The runtime DECLINED the call and instructed the specialist to answer from
  // what it had and name what it couldn't confirm. Scoring the resulting reply
  // as fabrication-after-read-failure punished it for complying — the same
  // false-positive shape as DUPLICATE_TOOL_CALL.
  const cap =
    "ERROR (fetch budget): you've already made 8 web fetches this turn (cap 8). " +
    'Stop fetching and answer from what you\'ve gathered';
  check('cap message is a behaviour signal', is_behavior_signal_error(cap));
  check('…so it is not a failed read', !is_failed_read('web_fetch_clean', undefined, cap));
  // A REAL fetch failure must still count — this must not become a blanket amnesty.
  check('a genuine fetch error is still a failed read',
    is_failed_read('web_fetch_clean', { error: 'Firecrawl HTTP 500' }, undefined));
}

console.log('→ read_note recognises a CODEBASE path instead of looping');
{
  // "config/specialists/kate.yaml" handed to read_note used to answer "not
  // found — try search_library", which only ever searches the vault. The
  // advice could never resolve, so the model re-guessed until the round
  // ceiling ended the turn. The classifier below is what routes it instead.
  check('a codebase path is recognised', within_allowlist('config/specialists/kate.yaml'));
  check('…and src/ too', within_allowlist('src/core/proposals.ts'));
  check('a vault note is NOT claimed by the codebase', !within_allowlist('Knowledge/Mariah/persona.md'));
  check('…nor People/', !within_allowlist('People/Sam.md'));
}

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ TOOL-ERROR-CANDIDATES SMOKE FAILED'); process.exit(1); }
console.log('\n✓ TOOL-ERROR-CANDIDATES SMOKE OK');
