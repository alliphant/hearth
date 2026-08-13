#!/usr/bin/env bun
/**
 * set_credential — CLI for seeding user credentials.
 *
 * Per the 2026-05-25 BACKEND_AUTH_BRIEF (hearth-ios), legacy users
 * (`jasper`, `sam`) need email + password set before the bearer-auth
 * flow can run. There is no self-service registration endpoint in
 * day-1 — credentials land via this CLI.
 *
 * Usage:
 *
 *   bun run scripts/set_credential.ts --user jasper --email jasper@... --password 'xxxxx'
 *   bun run scripts/set_credential.ts --user sam  --email sam@...  --password 'xxxxx'
 *   bun run scripts/set_credential.ts --user sam  --pin '1234'
 *   bun run scripts/set_credential.ts --user jasper --email jasper@...     # email only
 *   bun run scripts/set_credential.ts --user jasper --clear-password
 *
 * Notes:
 *   - Password is argon2id-hashed via Bun.password (m=64MB, t=3, p=1).
 *   - Password minimum 10 chars; no composition rules.
 *   - PIN is SHA-256-hashed (existing format, shared with FRIDAY).
 *   - Updates config/users.yaml in place, preserving comments via the
 *     YAML Document API (same path as the /api/admin route).
 *   - Never echoes the password back. Pass it via --password "..." on
 *     the command line; for interactive entry use --prompt-password.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { UserRegistry } from '@core/users';

interface Args {
  user?: string;
  email?: string;
  password?: string;
  pin?: string;
  prompt_password?: boolean;
  clear_password?: boolean;
  clear_email?: boolean;
  // --create flags: bootstrap a brand-new user from terminal.
  create?: boolean;
  display_name?: string;
  tier?: 'owner' | 'household' | 'friend';
  role?: 'admin' | 'user' | 'guest';
  no_pin?: boolean;
  // Flip an existing user's must_change_password (and optionally
  // must_set_pin) so they're routed through the bootstrap setup
  // flow on next login even though admin set the credential
  // out-of-band.
  require_reset?: boolean;
  require_pin_reset?: boolean;
}

function _parse_args(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eat = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--user': out.user = eat(); break;
      case '--email': out.email = eat(); break;
      case '--password': out.password = eat(); break;
      case '--pin': out.pin = eat(); break;
      case '--prompt-password': out.prompt_password = true; break;
      case '--clear-password': out.clear_password = true; break;
      case '--clear-email': out.clear_email = true; break;
      case '--create': out.create = true; break;
      case '--display-name': out.display_name = eat(); break;
      case '--tier': {
        const v = eat();
        if (v !== 'owner' && v !== 'household' && v !== 'friend') {
          throw new Error(`--tier must be owner|household|friend`);
        }
        out.tier = v;
        break;
      }
      case '--role': {
        const v = eat();
        if (v !== 'admin' && v !== 'user' && v !== 'guest') {
          throw new Error(`--role must be admin|user|guest`);
        }
        out.role = v;
        break;
      }
      case '--no-pin': out.no_pin = true; break;
      case '--require-reset': out.require_reset = true; break;
      case '--require-pin-reset': out.require_pin_reset = true; break;
      case '-h': case '--help':
        console.log(`Usage:
  Update existing:
    bun run scripts/set_credential.ts --user <id> [--email <e>]
        [--password <p>|--prompt-password|--clear-password]
        [--pin <####>] [--clear-email]

  Create new (admin-issued bootstrap; must_change_password +
  must_set_pin land true so the user resets both on first login):
    bun run scripts/set_credential.ts --create --user <id>
        --display-name <"Name"> --email <e>
        --password <initial-p>  (or --prompt-password)
        [--tier owner|household|friend] [--role admin|user|guest]
        [--no-pin]   (skip the PIN-setup requirement on first login)`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

async function _read_password_interactively(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve_p) => {
    // ANSI sequence to hide echo — works on POSIX terms.
    process.stderr.write('Password: \x1b[8m');
    rl.question('', (answer) => {
      process.stderr.write('\x1b[0m\n');
      rl.close();
      resolve_p(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = _parse_args(process.argv.slice(2));
  if (!args.user) {
    console.error('set_credential: --user <id> is required');
    process.exit(2);
  }

  const users_path = resolve(
    process.env.HEARTH_USERS_PATH ?? './config/users.yaml',
  );
  const registry = new UserRegistry(users_path);

  // ── --create branch: append a brand-new user record ────────────────
  if (args.create) {
    if (!args.display_name) {
      console.error('--create requires --display-name "<Name>"');
      process.exit(2);
    }
    if (!args.email) {
      console.error('--create requires --email <addr>');
      process.exit(2);
    }
    let pw = args.password;
    if (args.prompt_password) pw = await _read_password_interactively();
    if (!pw || pw.length < 10) {
      console.error('--create requires --password (min 10 chars) or --prompt-password');
      process.exit(2);
    }
    try {
      const created = await registry.create_user({
        id: args.user,
        display_name: args.display_name,
        email: args.email,
        initial_password: pw,
        ...(args.tier ? { tier: args.tier } : {}),
        ...(args.role ? { role: args.role } : {}),
        ...(args.no_pin ? { require_pin: false } : {}),
      });
      console.log(
        `set_credential: created user "${created.id}" — email=${created.email}, ` +
          `must_change_password=${created.must_change_password}, ` +
          `must_set_pin=${created.must_set_pin}. ` +
          `Share the initial password with them; first login will route ` +
          `through the change-password${created.must_set_pin ? ' + set-pin' : ''} flow.`,
      );
      return;
    } catch (err) {
      console.error(`set_credential: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(9);
    }
  }

  const user = registry.get(args.user);
  if (!user) {
    console.error(`set_credential: user "${args.user}" not in users.yaml — use --create to add a new one`);
    process.exit(3);
  }

  const patch: Parameters<typeof registry.update_user>[1] = {};
  const changes: string[] = [];

  // ── Email ────────────────────────────────────────────────────────────
  if (args.clear_email) {
    patch.email = null;
    changes.push('email cleared');
  } else if (args.email !== undefined) {
    const normalized = args.email.trim().toLowerCase();
    if (!normalized.includes('@') || !normalized.includes('.')) {
      console.error(`set_credential: --email must look like an email; got "${args.email}"`);
      process.exit(4);
    }
    // Uniqueness check — duplicate emails would break /auth/login lookup.
    const existing = registry.resolve_by_email(normalized);
    if (existing && existing.id !== user.id) {
      console.error(`set_credential: email "${normalized}" already belongs to user "${existing.id}"`);
      process.exit(5);
    }
    patch.email = normalized;
    changes.push(`email set to ${normalized}`);
  }

  // ── Password ─────────────────────────────────────────────────────────
  if (args.clear_password) {
    patch.password_hash = null;
    changes.push('password cleared');
  } else if (args.password !== undefined || args.prompt_password) {
    let pw = args.password;
    if (args.prompt_password) {
      pw = await _read_password_interactively();
    }
    if (!pw || pw.length < 10) {
      console.error(`set_credential: password must be at least 10 chars`);
      process.exit(6);
    }
    const hash = await Bun.password.hash(pw, {
      algorithm: 'argon2id',
      memoryCost: 65536,
      timeCost: 3,
    });
    patch.password_hash = hash;
    changes.push('password set (argon2id)');
  }

  // ── PIN ──────────────────────────────────────────────────────────────
  if (args.pin !== undefined) {
    if (!/^\d{4,8}$/.test(args.pin)) {
      console.error(`set_credential: --pin must be 4-8 digits`);
      process.exit(7);
    }
    const pin_hash = createHash('sha256').update(args.pin).digest('hex');
    patch.pin_hash = pin_hash;
    changes.push('PIN set (sha256)');
  }

  // ── Bootstrap-flag flips ─────────────────────────────────────────────
  if (args.require_reset) {
    patch.must_change_password = true;
    changes.push('must_change_password = true (forces password reset on next login)');
  }
  if (args.require_pin_reset) {
    patch.must_set_pin = true;
    changes.push('must_set_pin = true (forces PIN setup on next login)');
  }

  if (Object.keys(patch).length === 0) {
    console.error('set_credential: nothing to change — pass at least one of --email/--password/--prompt-password/--pin/--clear-password/--clear-email/--require-reset/--require-pin-reset');
    process.exit(8);
  }

  registry.update_user(user.id, patch);
  console.log(`set_credential: ${user.id} — ${changes.join('; ')}`);
}

main().catch((err) => {
  console.error(`set_credential: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
