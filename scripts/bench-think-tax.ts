/**
 * Benchmark: measure the "think tax" for a specialist's deliberation
 * — same persona, same user prompt, same tool schemas, run TWICE:
 * once with thinking ON, once with thinking OFF. Reports duration,
 * tokens-in, tokens-out, and a short content preview so we can sanity-
 * check the responses match.
 *
 * Usage:
 *   bun run scripts/bench-think-tax.ts [specialist_id]
 * Defaults to 'trainer'.
 *
 * The benchmark hits the same LLM router the orchestrator uses, with
 * the same role (specialist_deliberation), so timing is apples-to-
 * apples with a real deliberation pass. The prompt is a stripped-down
 * synthetic — long enough to be representative, simple enough to be
 * reproducible.
 */
import { SpecialistRegistry } from '@core/specialist';
import { ConfigLLMRouter } from '@core/router';
import type { LLMRequest } from '@core/llm';

const SPECIALIST_ID = process.argv[2] ?? 'trainer';

const ROLES_PATH = process.env.HEARTH_ROLES_PATH ?? '/home/jasper/hearth/config/llm-roles.yaml';
const SPECIALISTS_DIR = '/home/jasper/hearth/config/specialists';

async function main() {
  const registry = new SpecialistRegistry(SPECIALISTS_DIR);
  const specialist = registry.get(SPECIALIST_ID);
  if (!specialist) {
    console.error(`unknown specialist: ${SPECIALIST_ID}`);
    process.exit(1);
  }

  const router = new ConfigLLMRouter(ROLES_PATH, {
    ollama_base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    openai_base_url: process.env.OPENAI_API_BASE_URL ?? 'http://localhost:8000/api/v1',
    openai_api_key: process.env.OPENAI_API_KEY ?? 'lemonade',
  });

  const system_prompt =
    `You are ${specialist.name}.\n\n${specialist.persona}`;

  const user_prompt =
    `This is your scheduled 00:00 reflection. Review what's accumulated and decide:
  (a) what (if anything) is worth flagging to Kate or another specialist,
  (b) what proposals you should prepare for Jasper's review,
  (c) what observations you should commit to memory.

Be conservative. Most of the time the answer is 'nothing needs attention'.

Context:
\`\`\`json
{
  "now": "${new Date().toISOString()}",
  "slot": "00:00",
  "observations": [],
  "unread_inbox": [
    {
      "id": "01KS0RR5WZBENCH",
      "ts": "${new Date().toISOString()}",
      "from": "cassandra",
      "kind": "flag",
      "body_md": "Jasper gave UX feedback to me (cassandra): \\"You missed it — Jasper's Office camera was offline and in your posture_findings. Concise doesn't mean dismissing findings. Lead with anomalies even when one exists.\\" This is a persona-tuning consult per my new persona instructions."
    }
  ],
  "vault_deltas": [],
  "recent_memory_excerpts": "(empty)"
}
\`\`\`

Reply with a brief recap in your voice, then a SINGLE JSON code block with this exact shape (omit fields you don't need; arrays may be empty):
\`\`\`json
{
  "summary_for_self": "",
  "flags": [],
  "proposals": [],
  "interrupts": []
}
\`\`\`
`;

  const resolved = router.for_role('specialist_deliberation');
  console.log(`Provider: ${resolved.provider.name}  Model: ${resolved.model}`);

  async function run(think: boolean) {
    const req: LLMRequest = {
      messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: user_prompt },
      ],
      temperature: resolved.defaults.temperature ?? 0.3,
      max_tokens: resolved.defaults.max_tokens ?? 2000,
      think,
    };
    const t0 = performance.now();
    const resp = await resolved.provider.complete(req);
    const ms = Math.round(performance.now() - t0);
    return { ms, resp };
  }

  console.log(`Benchmark for ${SPECIALIST_ID} — persona is ${specialist.persona.length} chars`);
  console.log(`System prompt length: ${system_prompt.length} chars`);
  console.log(`User prompt length: ${user_prompt.length} chars`);
  console.log('');

  for (const think of [true, false]) {
    console.log(`── think=${think} ──`);
    try {
      const { ms, resp } = await run(think);
      console.log(`  duration: ${ms}ms (${(ms / 1000).toFixed(1)}s)`);
      console.log(`  tokens_in: ${resp.cost?.tokens_in ?? '?'}`);
      console.log(`  tokens_out: ${resp.cost?.tokens_out ?? '?'}`);
      console.log(`  thinking length: ${resp.thinking?.length ?? 0} chars`);
      console.log(`  content length: ${resp.content?.length ?? 0} chars`);
      console.log(`  finish_reason: ${resp.finish_reason}`);
      console.log(`  content preview: ${(resp.content || '').slice(0, 250).replace(/\n/g, ' ⏎ ')}`);
      console.log('');
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
      console.log('');
    }
  }
}

main().catch((err) => {
  console.error('bench crashed:', err);
  process.exit(1);
});
