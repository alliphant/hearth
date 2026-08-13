/**
 * One-off: re-run a vault-stored capture through the VL endpoint to
 * prove what the classifier WOULD have seen if the doc-track shortcut
 * hadn't fired. Reads attachments from $HEARTH_VAULT_ROOT (defaults to
 * ~/vault-friday), drives through the live LLM router with vision.
 *
 *   bun run scripts/oneoff-vl-rerun.ts <vault-relative-attachment-path>
 *
 * Example:
 *   bun run scripts/oneoff-vl-rerun.ts _attachments/cordelia-c_7c4msww1vy.jpg
 *
 * Not registered as a smoke; throwaway diagnostic. Hits real the LLM host
 * Qwen3.6-27B via OPENAI_BASE_URL (no test-mode shortcut).
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ConfigLLMRouter } from '@core/router';
import { analyze_image_direct } from '@connectors/vl';

const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const ROLES_PATH = resolve(import.meta.dir, '..', 'config', 'llm-roles.yaml');

async function main(): Promise<void> {
  const rel = process.argv[2];
  if (!rel) {
    console.error('usage: bun run scripts/oneoff-vl-rerun.ts <vault-relative-path>');
    process.exit(1);
  }
  const abs = resolve(VAULT_ROOT, rel);
  if (!existsSync(abs)) {
    console.error(`image not found: ${abs}`);
    process.exit(1);
  }
  console.log(`VL re-run against ${abs}`);

  const llm = new ConfigLLMRouter(ROLES_PATH, {
    ollama_base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    openai_base_url: process.env.OPENAI_BASE_URL,
    openai_api_key: process.env.OPENAI_API_KEY,
  });

  const started = Date.now();
  const result = await analyze_image_direct(
    {
      image_path: abs,
      vault_root: VAULT_ROOT,
    },
    llm,
  );
  const elapsed_ms = Date.now() - started;

  console.log(`\nelapsed: ${elapsed_ms} ms\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
