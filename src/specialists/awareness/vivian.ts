/**
 * Vivian's awareness handler (Prompt 6c).
 *
 * For v0 6c, Vivian's signal sources are constrained — Plaid wiring is
 * Prompt 10. What we can do now:
 *
 *   - Watch Knowledge/Finance/transactions.md mtime (if user maintains it).
 *   - Watch Accounts/ note mtimes for hand-edited balance changes.
 *   - Inspect CalDAV (via cached read) for upcoming financial events —
 *     this requires the connector path which awareness can't reach
 *     synchronously without an LLM round; for awareness, we restrict
 *     ourselves to filesystem signals and defer the calendar check to
 *     Vivian's deliberation pass.
 *
 * Suggests inbox-to-Kate when a balance change or transactions ingest
 * appears.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AwarenessHandler, AwarenessHandlerDeps, AwarenessObservation } from '@core/loops';

function vault_root(deps: AwarenessHandlerDeps): string {
  return (deps.memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
}

export const vivian_awareness: AwarenessHandler = {
  specialist_id: 'vivian',
  async run(deps: AwarenessHandlerDeps): Promise<AwarenessObservation | null> {
    try {
      const root = vault_root(deps);
      const last = deps.last_run_at?.getTime() ?? 0;
      const changes: Array<{ path: string; mtime: number }> = [];

      const transactions_path = resolve(root, 'Knowledge', 'Finance', 'transactions.md');
      if (existsSync(transactions_path)) {
        const m = statSync(transactions_path).mtimeMs;
        if (m > last) {
          changes.push({ path: 'Knowledge/Finance/transactions.md', mtime: m });
        }
      }

      const accounts_dir = resolve(root, 'Accounts');
      if (existsSync(accounts_dir)) {
        for (const f of readdirSync(accounts_dir)) {
          if (!f.endsWith('.md')) continue;
          const m = statSync(resolve(accounts_dir, f)).mtimeMs;
          if (m > last) changes.push({ path: `Accounts/${f}`, mtime: m });
        }
      }

      if (changes.length === 0) return null;

      const has_transactions_change = changes.some((c) => c.path.endsWith('transactions.md'));
      const account_count = changes.filter((c) => c.path.startsWith('Accounts/')).length;

      return {
        ts: new Date().toISOString(),
        summary:
          (has_transactions_change ? 'New transactions to review.' : '') +
          (account_count > 0 ? ` ${account_count} account note(s) changed.` : ''),
        severity: has_transactions_change ? 'low' : 'low',
        details: { changes: changes.map((c) => c.path) },
        suggests_inbox_to: 'kate',
      };
    } catch (err) {
      return {
        ts: new Date().toISOString(),
        summary: 'vivian awareness handler error',
        severity: 'low',
        details: { error_message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
