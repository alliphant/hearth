/**
 * apply-event-owner.ts — CLI to apply a calendar owner-attribution rule OUTSIDE
 * a chat turn: records the substring rule + re-stamps existing matching
 * life_events, via the same `set_event_owner` tool Kate calls. For backfilling
 * rules the owner already stated (or any ops fix). Mirrors the orchestrator's
 * path resolution (HEARTH_VAULT_ROOT / HEARTH_DB_PATH / config/users.yaml).
 *
 *   bun run scripts/apply-event-owner.ts <owner> <title keyword...>
 *   bun run scripts/apply-event-owner.ts sam Grant Taylor
 */
import { ulid } from 'ulid';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { UserRegistry } from '@core/users';
import { make_set_event_owner } from '@specialists/kate/tools/set_event_owner';
import type { ToolContext } from '@core/tool';

const [owner, ...rest] = process.argv.slice(2);
const title = rest.join(' ').trim();
if (!owner || !title) {
  console.error('usage: bun run scripts/apply-event-owner.ts <owner> <title keyword...>');
  process.exit(1);
}

const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const db = open_db(DB_PATH);
const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });
const users = new UserRegistry(undefined, undefined, db);

const tool = make_set_event_owner({ db, users, memory });
const res = await tool.execute(
  { title, owner },
  { memory, intent_id: ulid(), specialist_id: 'kate' } as unknown as ToolContext,
);
console.log(JSON.stringify(res, null, 2));
db.close();
