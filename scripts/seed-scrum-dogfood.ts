/**
 * Seed Beatrice's scrum board with its OWN construction — the dogfood.
 *
 *   bun run scripts/seed-scrum-dogfood.ts          # default ./data/hearth.db
 *   HEARTH_DB_PATH=/docker/hearth/data/hearth.db bun run scripts/seed-scrum-dogfood.ts
 *
 * Creates the "Scrum Tool" project + Sprint 1 and files the ranked backend/iOS
 * feature breakdown of building this tool, with lanes reflecting reality (the
 * backend engine shipped; ceremonies in review; nginx + iOS polish pending).
 * Idempotent: if the project already exists it prints and exits without writing.
 */

import { open_db } from '@memory/stores/structured';
import {
  ScrumStore,
  type ScrumLane,
  type ScrumSize,
  type ScrumBoard,
} from '@memory/stores/scrum';

const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';

interface SeedEpic {
  title: string;
  board: ScrumBoard;
  size: ScrumSize;
  value: ScrumSize;
  lane: ScrumLane;
  description: string;
}

// The plan's backend-vs-iOS division, ranked. Lanes reflect current state.
const EPICS: SeedEpic[] = [
  { title: 'Scrum store + schema + lane-event log', board: 'backend', size: 'M', value: 'L', lane: 'done',
    description: 'ScrumStore over hearth.db: projects/epics/sprints/retros/notes + scrum_epic_events (write on every move). Deterministic ROI/severity ranking.' },
  { title: 'compose_scrum_pane — Code Shop "Scrum" tab', board: 'backend', size: 'M', value: 'L', lane: 'done',
    description: 'Board renders as a tab in Beatrice\'s Code Shop pane from existing PaneBlocks (tabs/list/hero_metric/stacked_strip/load_chart) — zero new iOS code.' },
  { title: 'Scrum tools (board read + epic/sprint/note writes)', board: 'backend', size: 'M', value: 'L', lane: 'done',
    description: 'scrum_board_read, scrum_epic_write, scrum_sprint_write, scrum_note_retro_write — gated on the manage_scrum capability.' },
  { title: '/api/scrum routes + board.md', board: 'backend', size: 'S', value: 'L', lane: 'done',
    description: 'Owner-gated board JSON, llm-context précis, and the markdown+mermaid render the web canvas polls.' },
  { title: 'scrum_decision proposal kind', board: 'backend', size: 'S', value: 'M', lane: 'done',
    description: 'Blocking judgment calls + sprint-commit gates ride the existing proposal/decide/push pipeline — one "awaiting you" queue. Render arms for title/summary/dedup/actions.' },
  { title: 'Web canvas page + vendored mermaid', board: 'backend', size: 'S', value: 'M', lane: 'done',
    description: 'planning-canvas-style live render under /app/scrum-canvas — same-origin, owner-gated, no CDN, no nginx alternation needed.' },
  { title: 'Ceremonies — standup job + groom/retro deliberation', board: 'backend', size: 'M', value: 'M', lane: 'review',
    description: 'Beatrice background_job writes the daily snapshot; grooming/retro run as deliberation passes on Forza and file scrum_decision proposals for commits.' },
  { title: 'Dogfood seed script', board: 'backend', size: 'S', value: 'S', lane: 'done',
    description: 'This script — seeds the board with its own construction so the tool tracks itself from sprint 1.' },
  { title: 'nginx /api/scrum alternation + deploy', board: 'backend', size: 'S', value: 'L', lane: 'sprint_backlog',
    description: 'Add `scrum` to /docker/nginx/locations.conf on the LLM host (single-file bind mount — edit + docker restart nginx, not reload). Only needed for /api/scrum/*; the web canvas works without it.' },
  { title: 'iOS polish — typed PaneKind case + scrum_decision dot color', board: 'ios', size: 'S', value: 'S', lane: 'product_backlog',
    description: 'Optional: add `case scrum`/typed styling + a scrum_decision kindColor. The board + decisions already render server-driven with no iOS change; this is cosmetic, needs a build bump.' },
];

function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const db = open_db(DB_PATH);
const store = new ScrumStore(db);

if (store.project_by_slug('scrum-tool')) {
  console.log('Scrum Tool project already exists — nothing to seed. (idempotent)');
  process.exit(0);
}

const project = store.create_project({
  name: 'Scrum Tool',
  slug: 'scrum-tool',
  description: "Beatrice's AI-run dev board for building Hearth — backend + iOS, ROI/severity-ranked.",
  board: 'backend',
});
console.log(`✓ project ${project.slug}`);

const sprint = store.create_sprint({
  label: 'Sprint 1',
  start_date: isoDate(0),
  end_date: isoDate(7),
  capacity_pts: 10,
});
console.log(`✓ ${sprint.label} (${sprint.start_date} → ${sprint.end_date})`);

const committed: string[] = [];
for (const e of EPICS) {
  const epic = store.create_epic({
    project_id: project.id,
    title: e.title,
    type: 'feature',
    size: e.size,
    value: e.value,
    board: e.board,
    description: e.description,
    lane: e.lane,
  });
  // Commit everything except the optional iOS-polish backlog item.
  if (e.lane !== 'product_backlog') committed.push(epic.id);
  console.log(`  · ${e.lane.padEnd(15)} ${e.board.padEnd(7)} ${e.size}/${e.value}  ${e.title}`);
}

store.commit_sprint(committed);
const board = store.read_board();
console.log(
  `✓ committed ${committed.length} epics — say/do ${board.say_do.shipped}/${board.say_do.committed}` +
    (board.say_do.pct != null ? ` (${board.say_do.pct}%)` : '') +
    ` · split ${board.split.backend} backend / ${board.split.ios} iOS`,
);
db.close();
console.log('\n✓ dogfood board seeded. Open Beatrice → Code Shop → Scrum, or /app/scrum-canvas.');
