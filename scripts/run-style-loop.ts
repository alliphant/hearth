/**
 * Run Kate's style learning loop out-of-band — invoked by systemd timers.
 *
 *   bun run scripts/run-style-loop.ts observe       — passive observation pass
 *   bun run scripts/run-style-loop.ts distill       — rebuild jasper_style_profile.md
 *   bun run scripts/run-style-loop.ts both          — observe, then distill
 *
 * Shares data/hearth.db with the orchestrator via SQLite WAL. Reads the
 * same llm-roles.yaml the orchestrator uses (defaults to local Ollama).
 *
 * Observer bookkeeping: the script tracks last-run time in
 * Knowledge/Kate/.style_observer_state.json and passes a since_iso with a
 * small overlap so consecutive runs see the same messages once and the
 * dedup inside append_style_observations suppresses double-bullets.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ConversationStore } from '@memory/stores/conversations';
import { ConfigLLMRouter } from '@core/router';
import { make_observe_jasper_voice } from '@specialists/kate/tools/observe_jasper_voice';
import { make_distill_jasper_style } from '@specialists/kate/tools/distill_jasper_style';
import type { ToolContext } from '@core/tool';
import { ulid } from 'ulid';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const ROLES_PATH =
  process.env.HEARTH_ROLES_PATH ?? './config/llm-roles.yaml';
const OLLAMA_URL =
  process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

const DEFAULT_LOOKBACK_HOURS = 24 * 7;
const RUN_OVERLAP_HOURS = 2;

const STATE_REL = 'Knowledge/Kate/.style_observer_state.json';

interface ObserverState {
  last_run_iso: string;
  last_messages_scanned: number;
  last_observations_appended: number;
}

function read_state(): ObserverState | null {
  const abs = resolve(VAULT_ROOT, STATE_REL);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as ObserverState;
  } catch {
    return null;
  }
}

function write_state(state: ObserverState): void {
  const abs = resolve(VAULT_ROOT, STATE_REL);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(state, null, 2), 'utf8');
}

function compute_since_iso(now: Date): string {
  const state = read_state();
  if (!state) {
    return new Date(
      now.getTime() - DEFAULT_LOOKBACK_HOURS * 3_600_000,
    ).toISOString();
  }
  const last = new Date(state.last_run_iso).getTime();
  return new Date(last - RUN_OVERLAP_HOURS * 3_600_000).toISOString();
}

function build_context(memory: MemoryClient, llm: ConfigLLMRouter): ToolContext {
  return {
    memory,
    llm,
    now: new Date(),
    intent_id: `style-loop-${ulid()}`,
  };
}

async function run_observe(
  memory: MemoryClient,
  llm: ConfigLLMRouter,
  conversations: ConversationStore,
): Promise<void> {
  const ctx = build_context(memory, llm);
  const since_iso = compute_since_iso(ctx.now);
  console.log(`[observe] since=${since_iso}`);
  const tool = make_observe_jasper_voice(VAULT_ROOT, conversations);
  const result = await tool.execute({ since_iso }, ctx);
  console.log(`[observe] result=${JSON.stringify(result)}`);
  write_state({
    last_run_iso: ctx.now.toISOString(),
    last_messages_scanned: result.messages_scanned,
    last_observations_appended: result.observations_appended,
  });
}

async function run_distill(
  memory: MemoryClient,
  llm: ConfigLLMRouter,
): Promise<void> {
  const ctx = build_context(memory, llm);
  console.log(`[distill] starting`);
  const tool = make_distill_jasper_style(VAULT_ROOT);
  const result = await tool.execute({}, ctx);
  console.log(`[distill] result=${JSON.stringify(result)}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'both';
  if (!['observe', 'distill', 'both'].includes(mode)) {
    console.error(`Usage: bun run scripts/run-style-loop.ts <observe|distill|both>`);
    process.exit(2);
  }

  console.log(`hearth style-loop starting (mode=${mode})`);
  console.log(`  vault:    ${VAULT_ROOT}`);
  console.log(`  db:       ${DB_PATH}`);
  console.log(`  roles:    ${ROLES_PATH}`);
  console.log(`  ollama:   ${OLLAMA_URL}`);

  const db = open_db(DB_PATH);
  const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });
  const conversations = new ConversationStore(db);
  const llm = new ConfigLLMRouter(ROLES_PATH, {
    ollama_base_url: OLLAMA_URL,
    openai_base_url: process.env.OPENAI_BASE_URL,
    openai_api_key: process.env.OPENAI_API_KEY,
  });

  if (mode === 'observe' || mode === 'both') {
    await run_observe(memory, llm, conversations);
  }
  if (mode === 'distill' || mode === 'both') {
    await run_distill(memory, llm);
  }

  console.log(`[done] mode=${mode}`);
}

main().catch((err) => {
  console.error(`[fatal]`, err);
  process.exit(1);
});
