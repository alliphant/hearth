/**
 * smoke:signal-router — the shared cordoned deliver primitive (Phase 2a).
 *
 * Self-contained: temp db, real AppEventBus + SpecialistInbox + MemoryClient.
 * Exercises SignalRouter.deliver: cordoned inbox flag + inbox_message_added SSE
 * + the audit row, the originating_user_id cordon, and the severity default.
 *
 *   bun run smoke:signal-router
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { AppEventBus, type AppEvent } from '@app/events';
import { SpecialistInbox } from '@memory/stores/conversations';
import { SignalRouter } from '@core/signal_router/router';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-sigrouter-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const events = new AppEventBus();
  const inbox = new SpecialistInbox(db);
  const router = new SignalRouter({ events, memory, inbox });

  const seen: AppEvent[] = [];
  events.subscribe((e) => seen.push(e));

  // Deliver a cordoned signal from one source.
  const id = router.deliver({
    source: 'calendar',
    from_specialist_id: 'kate',
    to_specialist_id: 'iris',
    kind: 'flag',
    body_md: 'A trip landed on the calendar.',
    severity: 'medium-high',
    originating_user_id: 'sam',
    audit: { tool_name: 'calendar_signal', tool_input: { x: 1 } },
  });
  check('returns an inbox id', typeof id === 'string' && id.length > 0);

  // Inbox flag landed, scoped to the originating user (the cordon).
  const iris_unread = inbox.unread_for('iris', 10);
  check('flag delivered to the target specialist', iris_unread.some((m) => m.id === id));
  const row = iris_unread.find((m) => m.id === id)!;
  check('cordon stamped (originating_user_id)', row.originating_user_id === 'sam');
  check('body carried through', row.body_md.includes('trip landed'));

  // SSE emitted with the right severity.
  const evt = seen.find((e) => e.type === 'inbox_message_added' && e.message_id === id);
  check('inbox_message_added emitted', !!evt);
  check('severity carried through', evt && (evt as Extract<AppEvent, { type: 'inbox_message_added' }>).severity === 'medium-high');

  // Audit row written under the source's tool_name.
  const audit = db
    .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE tool_name = 'calendar_signal'`)
    .get() as { c: number };
  check('audit row written', audit.c === 1);

  // Severity defaults to 'medium' when omitted; cordon null = household-shared.
  const id2 = router.deliver({
    source: 'capture',
    from_specialist_id: 'cordelia',
    to_specialist_id: 'vivian',
    kind: 'fyi',
    body_md: 'shared',
  });
  const v = inbox.unread_for('vivian', 10).find((m) => m.id === id2)!;
  check('null cordon → household-shared (originating_user_id null)', v.originating_user_id === null);
  const evt2 = seen.find((e) => e.type === 'inbox_message_added' && e.message_id === id2);
  check('severity default medium', evt2 && (evt2 as Extract<AppEvent, { type: 'inbox_message_added' }>).severity === 'medium');

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:signal-router — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
