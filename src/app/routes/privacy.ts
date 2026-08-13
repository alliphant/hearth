/**
 * /api/users/privacy — the member-facing *provable cordon* surface.
 *
 * `GET /api/users/privacy/report` runs the live privacy self-test for the
 * authenticated caller (see [privacy_self_test.ts](../../core/privacy_self_test.ts))
 * and returns the report the Settings → Privacy & Data panel renders. The
 * self-test exercises the real cordoned read surfaces AS the caller, so a
 * green report is a statement about production behaviour, not a promise.
 *
 * Mounted at `/api` (alongside the relay + specialists routers); the path
 * lives under the existing `/api/users/*` namespace, which is already in
 * the the LLM host nginx `/api/(...)` alternation — no nginx edit. Auth is
 * enforced upstream by the middleware (every `/api/*` path that isn't
 * `/api/auth` requires a session), so `c.get('user')` is always present.
 */

import { Hono } from 'hono';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import type { ConversationStore } from '@memory/stores/conversations';
import type { UserRegistry } from '@core/users';
import { run_privacy_self_test } from '@core/privacy_self_test';

export interface PrivacyRouterDeps {
  db: Database;
  memory: MemoryClient;
  proposals: ProposalsStore;
  conversations: ConversationStore;
  users: UserRegistry;
}

export function create_privacy_router(deps: PrivacyRouterDeps): Hono {
  const r = new Hono();

  r.get('/users/privacy/report', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);

    const caller = {
      user_id: user.id,
      tier: user.tier,
      display_name: user.display_name || user.id,
    };

    const report = run_privacy_self_test(
      {
        db: deps.db,
        memory: deps.memory,
        proposals: deps.proposals,
        conversations: deps.conversations,
        users: deps.users,
      },
      caller,
    );

    // Audit the run — the self-test is itself a read of the conscience.
    try {
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: 'privacy_self_test',
        tool_input: { tier: caller.tier },
        user_id: caller.user_id,
        execution_result: {
          overall_passed: report.overall_passed,
          probes: report.probes.map((p) => ({
            id: p.id,
            belonging_to_others: p.belonging_to_others,
            reachable_by_you: p.reachable_by_you,
            passed: p.passed,
          })),
        },
      });
    } catch {
      // Best-effort — never fail the member's privacy check on audit plumbing.
    }

    return c.json(report);
  });

  return r;
}
