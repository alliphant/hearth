/**
 * CLI to enqueue a one-shot scheduled task.
 *
 * Examples:
 *   bun run scheduler:add \
 *     --fire-at "2026-05-20T07:00:00Z" \
 *     --endpoint "POST /api/evals/run" \
 *     --idempotency-key "eval-rerun-2026-07-06"
 *
 *   bun run scheduler:add \
 *     --fire-at "2026-05-20T07:00:00Z" \
 *     --endpoint "POST /scribe/append_journal_entry" \
 *     --body '{"body":"automated test","tags":[]}' \
 *     --idempotency-key "test-2026-05-20"
 *
 * Idempotency keys are UNIQUE in scheduled_tasks, so re-running with
 * the same key is a no-op.
 */

import { ulid } from 'ulid';
import { open_db } from '@memory/stores/structured';

interface Args {
  fire_at?: string;
  endpoint?: string;
  body?: string;
  idempotency_key?: string;
  intent?: string;
  max_attempts?: number;
}

function parse_args(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--fire-at':
        out.fire_at = next;
        i++;
        break;
      case '--endpoint':
        out.endpoint = next;
        i++;
        break;
      case '--body':
        out.body = next;
        i++;
        break;
      case '--idempotency-key':
        out.idempotency_key = next;
        i++;
        break;
      case '--intent':
        out.intent = next;
        i++;
        break;
      case '--max-attempts':
        out.max_attempts = parseInt(next ?? '3', 10);
        i++;
        break;
    }
  }
  return out;
}

function die(msg: string): never {
  console.error(`scheduler-add: ${msg}`);
  process.exit(2);
}

function main(): void {
  const args = parse_args(process.argv.slice(2));
  if (!args.fire_at) die('--fire-at required (ISO 8601, e.g. 2026-05-20T07:00:00Z)');
  if (!args.endpoint) die('--endpoint required (e.g. "GET /agents/concierge/brief?days=14")');
  if (!args.idempotency_key)
    die('--idempotency-key required (unique per logical task)');

  const fire_at_d = new Date(args.fire_at);
  if (Number.isNaN(fire_at_d.getTime())) die(`invalid --fire-at: ${args.fire_at}`);

  const parts = args.endpoint.trim().split(/\s+/, 2);
  let method = 'GET';
  let path: string;
  if (parts.length === 2 && /^(GET|POST)$/i.test(parts[0]!)) {
    method = parts[0]!.toUpperCase();
    path = parts[1]!;
  } else {
    path = args.endpoint;
  }

  let body_obj: unknown = undefined;
  if (args.body) {
    try {
      body_obj = JSON.parse(args.body);
    } catch (err) {
      die(`--body must be valid JSON: ${(err as Error).message}`);
    }
  }
  if (method === 'GET' && body_obj !== undefined) {
    die('--body is invalid for GET endpoints');
  }

  const context = { method, path, body: body_obj };
  const intent = args.intent ?? path;

  const db_path = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  const db = open_db(db_path);

  // Insert; ON CONFLICT(idempotency_key) DO NOTHING for idempotency.
  const id = `sch_${ulid().toLowerCase().slice(-12)}`;
  const result = db
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, fire_at, intent, context_json, idempotency_key, max_attempts, attempts, status)
       VALUES (@id, @fire_at, @intent, @ctx, @idem, @max, 0, 'pending')
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .run({
      '@id': id,
      '@fire_at': fire_at_d.toISOString(),
      '@intent': intent,
      '@ctx': JSON.stringify(context),
      '@idem': args.idempotency_key,
      '@max': args.max_attempts ?? 3,
    });

  if ((result.changes ?? 0) === 0) {
    console.log(
      `scheduler-add: idempotency_key "${args.idempotency_key}" already scheduled — no-op.`,
    );
  } else {
    console.log(
      `scheduler-add: scheduled ${id} at ${fire_at_d.toISOString()} → ${method} ${path}`,
    );
  }
  db.close();
}

main();
