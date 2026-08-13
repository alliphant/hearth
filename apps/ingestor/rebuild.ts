/**
 * Full-vault rebuild driver.
 *
 * Truncates the projection tables (people, journal_entries, decisions,
 * clippings, places, graph_edges) and re-projects every .md file in the vault
 * through `project_note`. Used after schema changes, manual vault
 * edits made while the watcher was down, or just to verify the
 * watcher's running state matches a clean rebuild.
 *
 * Importable as a function so the test harness can call it against a
 * temp vault, and exposed as a CLI via scripts/ingestor-rebuild.ts.
 */

import { Glob } from 'bun';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import { project_note } from './project';
import { VaultIndex } from './vault_index';

export interface RebuildSummary {
  scanned: number;
  by_type: Record<string, number>;
  skipped: number;
  failed: number;
  ambiguous_links: number;
}

export async function rebuild(
  vault_root: string,
  memory: MemoryClient,
  db: Database,
): Promise<RebuildSummary> {
  // Wrap the truncates in a single transaction so a half-rebuild
  // doesn't leave the projection tables empty.
  db.exec(
    `BEGIN;
     DELETE FROM people;
     DELETE FROM journal_entries;
     DELETE FROM decisions;
     DELETE FROM clippings;
     DELETE FROM places;
     DELETE FROM household_goods;
     DELETE FROM household_services;
     DELETE FROM life_events;
     DELETE FROM media_items;
     DELETE FROM graph_edges;
     COMMIT;`,
  );

  const index = await VaultIndex.build(vault_root);

  const summary: RebuildSummary = {
    scanned: 0,
    by_type: {},
    skipped: 0,
    failed: 0,
    ambiguous_links: 0,
  };

  const glob = new Glob('**/*.md');
  for await (const abs of glob.scan({ cwd: vault_root, absolute: true })) {
    summary.scanned++;
    // 'bulk' suppresses the per-note project_note / ambiguous_link audit
    // rows (a full rebuild runs on every ingestor restart — per-note rows
    // here were ~4.5k audit entries + daily-markdown lines per boot); the
    // single rebuild_vault summary row below is the audit trail for this
    // pass. Failure rows still log per note.
    const outcome = project_note(abs, { vault_root, db, memory, index, audit_mode: 'bulk' });
    if (outcome.kind === 'projected') {
      summary.by_type[outcome.type] = (summary.by_type[outcome.type] ?? 0) + 1;
      summary.ambiguous_links += outcome.ambiguous_links.length;
    } else if (outcome.kind === 'skipped') {
      summary.skipped++;
    } else {
      summary.failed++;
    }
  }

  memory.log_action({
    intent_id: ulid(),
    agent: 'ingestor',
    tool_name: 'rebuild_vault',
    tool_input: { vault_root },
    execution_result: summary,
  });

  return summary;
}

export function format_summary(s: RebuildSummary): string {
  const types = Object.entries(s.by_type)
    .sort()
    .map(([t, n]) => `  ${t.padEnd(15)} ${n}`)
    .join('\n');
  return [
    `scanned: ${s.scanned}`,
    `projected by type:`,
    types || '  (none)',
    `skipped (no type / unknown type): ${s.skipped}`,
    `failed (read or schema): ${s.failed}`,
    `ambiguous wikilinks: ${s.ambiguous_links}`,
  ].join('\n');
}

// Helper for tests that need to project a single file without first
// running a full rebuild.
export { project_note, VaultIndex, resolve };
