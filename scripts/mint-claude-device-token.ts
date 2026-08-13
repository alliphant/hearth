/**
 * the always-on host a long-lived bearer device token bound to the OWNER, for a Claude Code
 * session to drive the scrum board API (`/api/scrum/*`). Run this on the LLM host
 * (it writes a row to the live `devices` table — a credential):
 *
 *   bun run scripts/mint-claude-device-token.ts
 *   # or write it straight to a 0600 secret file:
 *   SCRUM_TOKEN_OUT=/docker/hearth/secrets/claude-scrum-token \
 *     HEARTH_DB_PATH=/docker/hearth/data/hearth.db \
 *     bun run scripts/mint-claude-device-token.ts
 *
 * The token is printed ONCE (never logged). Store it 0600 where a session can
 * read it, then query the board with it, e.g. on the box (no nginx needed):
 *
 *   curl -s -H "Authorization: Bearer $(cat /docker/hearth/secrets/claude-scrum-token)" \
 *        http://localhost:7700/api/scrum/roadmap
 *
 * SCOPE NOTE: this is a full OWNER bearer (the board API gates on owner tier;
 * a bearer maps to its user, and Hearth has no per-API token scoping today). It
 * therefore authorizes the whole owner API surface, not just scrum. Treat it as
 * a privileged secret; revoke by deleting the device row (its name is below) or
 * via /auth/devices. Rotate by re-running this and replacing the stored file.
 */

import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { UserRegistry } from '@core/users';
import { DeviceStore } from '@core/devices';

const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const DEVICE_NAME = 'claude-code-scrum';

const db = open_db(DB_PATH);
const users = new UserRegistry(undefined, undefined, db);
const owner = users.list().find((u) => u.tier === 'owner');
if (!owner) {
  console.error('No owner-tier user found in config/users.yaml — cannot mint.');
  process.exit(1);
}

const devices = new DeviceStore(db);
const { device_id, token } = await devices.create({ user_id: owner.id, name: DEVICE_NAME });

console.log(`\n✓ minted device token for owner '${owner.id}' (device '${DEVICE_NAME}', id ${device_id})`);
const out = process.env.SCRUM_TOKEN_OUT;
if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, token + '\n', { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`✓ wrote token (0600) → ${out}`);
  console.log(`\nUse it:\n  curl -s -H "Authorization: Bearer $(cat ${out})" http://localhost:7700/api/scrum/roadmap`);
} else {
  console.log('\nTOKEN (shown once — store it 0600, never commit):\n');
  console.log('  ' + token + '\n');
  console.log('Then:\n  curl -s -H "Authorization: Bearer <token>" http://localhost:7700/api/scrum/roadmap');
}
db.close();
