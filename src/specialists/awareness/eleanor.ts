/**
 * Eleanor's awareness handler (Prompt 6c).
 *
 * Garden signals:
 *   - Yard project notes (Projects/yard prefix) mtime — flag low.
 *   - Frost-risk during shoulder seasons via HA weather sensors — needs
 *     a connector round-trip which awareness avoids; deferred to her
 *     deliberation pass to use ha_get_state.
 *   - Soil moisture below threshold — same deferral.
 *
 * For v0 6c, awareness emits when yard files changed; richer signals come
 * from Eleanor's batched deliberation passes (06:30 and 18:30).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AwarenessHandler, AwarenessHandlerDeps, AwarenessObservation } from '@core/loops';

function vault_root(deps: AwarenessHandlerDeps): string {
  return (deps.memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
}

export const eleanor_awareness: AwarenessHandler = {
  specialist_id: 'eleanor',
  async run(deps: AwarenessHandlerDeps): Promise<AwarenessObservation | null> {
    try {
      const root = vault_root(deps);
      const last = deps.last_run_at?.getTime() ?? 0;
      const projects_dir = resolve(root, 'Projects');
      if (!existsSync(projects_dir)) return null;

      const changes: string[] = [];
      for (const entry of readdirSync(projects_dir)) {
        if (!entry.startsWith('yard')) continue;
        const full = resolve(projects_dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
          // Walk one level deep.
          for (const f of readdirSync(full)) {
            if (!f.endsWith('.md')) continue;
            const m = statSync(resolve(full, f)).mtimeMs;
            if (m > last) changes.push(`${entry}/${f}`);
          }
        } else if (st.isFile() && entry.endsWith('.md') && st.mtimeMs > last) {
          changes.push(entry);
        }
      }

      if (changes.length === 0) return null;

      return {
        ts: new Date().toISOString(),
        summary: `Noted ${changes.length} yard project update(s).`,
        severity: 'low',
        details: { changed_paths: changes },
      };
    } catch (err) {
      return {
        ts: new Date().toISOString(),
        summary: 'eleanor awareness handler error',
        severity: 'low',
        details: { error_message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
