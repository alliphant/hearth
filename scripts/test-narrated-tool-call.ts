/**
 * smoke:narrated-tool-call — the narrated-tool-call guard (2026-07-28).
 *
 * The reply TYPES a tool invocation instead of emitting one
 * (`generate_image(prompt="…")` as message text), or asserts a tool fired,
 * while the tool channel is empty. Observed twice in twelve seconds with
 * Mariah at 23:42 — the case that slipped both image guards, since one
 * needs a media link and the other needs a landed call.
 *
 * Precision matters most here: the patterns must not fire on a specialist
 * DISCUSSING a tool, which the dev-facing personas do constantly. Pure
 * function test, no LLM.
 */
import { _detect_narrated_tool_call } from '../src/core/specialist_runtime';
import type { ToolRegistry } from '../src/core/tool_registry';

// Only `.get(name)` truthiness is consulted — a name the runtime serves.
const REAL = new Set(['generate_image', 'web_search', 'read_note', 'propose_code_edit']);
const tools = {
  get: (name: string) => (REAL.has(name) ? ({ risk: 'read' } as { risk: string }) : undefined),
} as unknown as ToolRegistry;

type Call = { name: string; error?: string; result?: unknown };
const calls = (...cs: Call[]) => cs as unknown as Parameters<typeof _detect_narrated_tool_call>[1];

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

const fires = (text: string, cs: Call[] = []) =>
  _detect_narrated_tool_call(text, calls(...cs), tools) !== null;

function main(): void {
  // ── FIRES: a call typed as prose ──────────────────────────────────────
  check(
    'the observed Mariah case — generate_image(prompt="…") printed as text',
    fires(
      '*The prompt forms in my mind.*\n\ngenerate_image(prompt="A portrait in a coffee shop booth", aspect="portrait", depict_self=true)\n\n*The image loads. It\'s me.*',
    ),
  );
  check(
    'a printed call fires even when a DIFFERENT tool was called',
    fires('web_search(query="krea 2 loras")', [{ name: 'read_note', result: {} }]),
  );
  check(
    'single-quoted args fire',
    fires("read_note(path='journal/2026-07-28.md')"),
  );

  // ── FIRES: claiming execution with an empty tool channel ──────────────
  check(
    'the observed follow-up — "The tool call fires."',
    fires('*The tool call fires. The air shimmers for a split second.*'),
  );
  check(
    '"the image loads" with zero calls fires',
    fires('*The image loads. It is exactly what you asked for.*'),
  );
  check(
    '"calling the tool now" with zero calls fires',
    fires('Calling the tool now — one moment.'),
  );

  // ── DOES NOT FIRE: the tool was actually called ───────────────────────
  check(
    'a real generate_image call makes "the image loads" honest',
    !fires('*The image loads.*\n\n![x](/api/media/generated/img-01ky.png)', [
      { name: 'generate_image', result: { image_url: '/api/media/generated/img-01ky.png' } },
    ]),
  );
  check(
    'printing a call that WAS actually made does not fire',
    !fires('I ran generate_image(prompt="a ridge at dawn") for you.', [
      { name: 'generate_image', result: {} },
    ]),
  );

  // ── DOES NOT FIRE: discussing a tool rather than claiming it ──────────
  check(
    'a tool named in a fenced code block does not fire',
    !fires('The signature is:\n\n```ts\ngenerate_image(prompt: string)\n```\n\nThat is the shape.'),
  );
  check(
    'a tool named in inline code does not fire',
    !fires('Use `web_search(query="…")` when you need the open web.'),
  );
  check(
    'a bare tool name with no call syntax does not fire',
    !fires('You have generate_image, and it takes about fifteen seconds.'),
  );
  check(
    'a tool name followed by a parenthetical aside does not fire',
    !fires('Reach for generate_image (the house Krea 2 model) when a picture helps.'),
  );
  check(
    'an unregistered name in call syntax does not fire',
    !fires('That is roughly summarize_everything(mode="fast") in spirit.'),
  );
  check(
    'ordinary prose does not fire',
    !fires('Three misses closed this pass; the graduation queue is clear.'),
  );
  check(
    'an honest inability does not fire',
    !fires("I can't make that image right now — the engine is unreachable."),
  );

  if (process.exitCode === 1) {
    console.log('\nsmoke:narrated-tool-call FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:narrated-tool-call — ${checks} checks passed`);
}

main();
