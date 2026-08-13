/**
 * One-way importer: NEXT.md → scrum board.
 *
 *   bun run scripts/import-next-to-scrum.ts
 *   NEXT_MD_PATH=/app/NEXT.md HEARTH_DB_PATH=/data/db/hearth.db bun run scripts/import-next-to-scrum.ts
 *
 * Parses NEXT.md's tiered entries (`0d. **Title** (scope) — body`) and upserts
 * one epic per entry into the "Roadmap (NEXT.md)" project, keyed `next:<id>` so
 * re-runs UPDATE in place (never duplicate) and preserve any lane/score the
 * human or Beatrice applied. One-way by design: NEXT.md stays the curated
 * source; this never writes back. Strikethrough (`~~...~~`) entries are DONE and
 * skipped. Board is inferred from the `(backend|ios|…)` scope tag.
 *
 * Run it again any time NEXT.md changes to refresh the board's backlog.
 */

import { readFileSync } from 'node:fs';
import { open_db } from '@memory/stores/structured';
import { ScrumStore, type ScrumBoard } from '@memory/stores/scrum';

const NEXT_PATH = process.env.NEXT_MD_PATH ?? './NEXT.md';
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const PROJECT = { name: 'Roadmap (NEXT.md)', slug: 'roadmap' };

interface ParsedEntry {
  id: string; // e.g. '0d', '14e'
  tier: number | null;
  title: string;
  board: ScrumBoard | null;
  body: string;
}

function stripMd(s: string): string {
  return s.replace(/`/g, '').replace(/~~/g, '').replace(/\*\*/g, '').trim();
}

function inferBoard(scope: string | null): ScrumBoard | null {
  if (!scope) return null;
  const s = scope.toLowerCase();
  const ios = s.includes('ios');
  const backend = s.includes('backend') || s.includes('infra') || s.includes('web');
  if (ios && !backend) return 'ios';
  if (backend || ios) return 'backend'; // "backend + ios" → backend (single partition)
  return null;
}

function parseNext(md: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const seen = new Set<string>();
  let tier: number | null = null;
  for (const raw of md.split('\n')) {
    // Track section: ONLY `## Tier N` sections hold real backlog entries. Any
    // other h2 (Bundle*/Cleanup*/Companion docs) leaves the Tier zone → stop
    // importing, so their numbered sub-lists + changelogs don't leak in.
    const h2 = raw.match(/^##\s+(.*)$/);
    if (h2) {
      const t = h2[1]!.match(/^Tier\s+(\d+)/i);
      tier = t ? Number(t[1]) : null;
      continue;
    }
    if (tier === null) continue;
    const m = raw.match(/^(\d+[a-z]?)\.\s+(.*)$/);
    if (!m) continue;
    const id = m[1]!;
    if (seen.has(id)) continue; // defensive: never two epics on one source_key
    const rest = m[2]!.trim();
    if (rest.startsWith('~~')) continue; // strikethrough = done
    const boldM = rest.match(/\*\*(.+?)\*\*/);
    if (!boldM) continue;
    const title = stripMd(boldM[1]!);
    if (!title) continue;
    seen.add(id);
    // scope tag: first (...) before the em-dash
    const afterBold = rest.slice((boldM.index ?? 0) + boldM[0].length);
    const scopeM = afterBold.match(/^\s*\(([^)]+)\)/);
    const board = inferBoard(scopeM ? scopeM[1]! : null);
    // body: text after the first em-dash (or the whole tail)
    const dash = afterBold.indexOf('—');
    const bodyRaw = dash >= 0 ? afterBold.slice(dash + 1) : afterBold;
    const body = stripMd(bodyRaw).slice(0, 600);
    out.push({ id, tier, title, board, body });
  }
  return out;
}

const md = readFileSync(NEXT_PATH, 'utf8');
const entries = parseNext(md);
if (entries.length === 0) {
  console.error(`No entries parsed from ${NEXT_PATH} — check the path/format.`);
  process.exit(1);
}

const db = open_db(DB_PATH);
const store = new ScrumStore(db);
const project = store.project_by_slug(PROJECT.slug) ?? store.create_project({ ...PROJECT, board: 'backend', description: 'Imported from NEXT.md (one-way; re-runnable).' });

let created = 0;
let updated = 0;
for (const e of entries) {
  const provenance = `_NEXT.md #${e.id}${e.tier ? ` · Tier ${e.tier}` : ''}_`;
  const description = `${provenance}\n\n${e.body}`;
  const { created: isNew } = store.upsert_epic_by_source(`next:${e.id}`, {
    project_id: project.id,
    title: e.title,
    type: 'feature',
    description,
    board: e.board,
  });
  if (isNew) created++;
  else updated++;
  console.log(`  ${isNew ? '＋' : '↻'} [${e.id}] ${(e.board ?? 'backend').padEnd(7)} ${e.title.slice(0, 72)}`);
}

db.close();
console.log(`\n✓ NEXT.md → board: ${created} created, ${updated} updated (${entries.length} active entries; strikethrough skipped) → project '${PROJECT.slug}'.`);
