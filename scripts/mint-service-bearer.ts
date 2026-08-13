export {};
/**
 * the always-on host a long-lived device bearer token for an internal service caller.
 *
 * Pass 8 follow-up — pipecat's HearthLLMService needs to authenticate to
 * Hearth's `/api/conversations/*` and `/api/events` endpoints. The
 * existing iOS pattern (DeviceStore-backed bearer in
 * `Authorization: Bearer <token>`) is the right surface: long-lived,
 * revocable per-row, parity with how iOS does it. This CLI creates the
 * device row and prints the bearer ONCE — store it in the pipecat
 * compose env (`HEARTH_INTERNAL_BEARER`) and forget it.
 *
 *   bun run mint:service-bearer -- --user=jasper --name=voice_pipecat
 *
 * The token doesn't roll automatically. Revoke via direct SQL on the
 * `devices` row (set `revoked_at = ?`) and re-mint when needed.
 *
 * Reads the same DB the orchestrator does (`HEARTH_DB_PATH` /
 * `./data/hearth.db`). No LLM, no chokidar — pure DB write + audit
 * row + print.
 */

import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { DeviceStore } from '@core/devices';
import { ulid } from 'ulid';
import { resolve } from 'node:path';

// ── CLI args ────────────────────────────────────────────────────────────────

function parse_args(argv: string[]): { user: string; name: string } {
  const out = { user: 'jasper', name: 'voice_pipecat' };
  for (const a of argv) {
    const m = a.match(/^--(user|name)=(.+)$/);
    if (m && m[1] && m[2]) {
      (out as Record<string, string>)[m[1]] = m[2];
    }
  }
  return out;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { user, name } = parse_args(process.argv.slice(2));
  const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  const VAULT_ROOT =
    process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;

  const db = open_db(resolve(DB_PATH));
  const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });
  const devices = new DeviceStore(db);

  const { device_id, token } = await devices.create({ user_id: user, name });

  // Audit the mint so the trail exists if the token is ever leaked.
  memory.log_action({
    intent_id: ulid(),
    agent: 'orchestrator',
    tool_name: 'mint_service_bearer',
    tool_input: { user_id: user, name, device_id },
    execution_result: { device_id, token_prefix: token.slice(0, 8) + '…' },
  });

  // Print to stdout — caller redirects / copies. Print to stderr the
  // copy/paste hint so `bun run mint:service-bearer | head -1` works.
  process.stdout.write(token + '\n');
  process.stderr.write(
    `\nMinted device ${device_id} for user=${user} name=${name}\n` +
      `Paste this into the pipecat compose env:\n` +
      `  - HEARTH_INTERNAL_BEARER=${token}\n` +
      `Revoke later:\n` +
      `  sqlite3 ${DB_PATH} "UPDATE devices SET revoked_at=datetime('now') WHERE id='${device_id}'"\n`,
  );
}

main().catch((err) => {
  console.error('mint:service-bearer failed:', err);
  process.exit(1);
});
