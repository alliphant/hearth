/**
 * /api/scrum/* — the scrum / dev-board API. Read AND write.
 *
 * Reads (web canvas + ad-hoc):
 *   GET   /api/scrum/board             structured board (lanes, say/do, split)
 *   GET   /api/scrum/board.md          markdown + mermaid the canvas polls
 *   GET   /api/scrum/llm-context.json  token-budgeted précis
 *   GET   /api/scrum/roadmap           { board, shipped } — pending + work-done history
 *
 * Writes (the "Claude API path" — a Claude Code session drives the board with an
 * owner-bound bearer device token; Beatrice also writes via her scrum_* tools):
 *   POST  /api/scrum/epic              create an epic
 *   PATCH /api/scrum/epic/:id          update fields
 *   POST  /api/scrum/epic/:id/move     move a lane (logs the transition, actor=claude)
 *   DELETE /api/scrum/epic/:id         soft-archive (remove from board, recoverable; refuses a committed epic)
 *   POST  /api/scrum/epic/:id/restore  un-archive back onto the board
 *   POST  /api/scrum/epic/:id/develop  "start developing" — move to in_progress + (backend) kick off Beatrice's build
 *   POST  /api/scrum/epics/score       batch-score many epics ({ items: [{epic_id,size,value|severity}] })
 *   POST  /api/scrum/sprint            { action: create | commit | close, ... }
 *
 * Owner-gated (the board is owner-only internal dev work). A bearer device token
 * bound to the owner authorizes these exactly like the owner's web session —
 * that's how a tokenless CLI agent gets a usable path to the board.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import {
  ScrumStore,
  LANES,
  type ScrumLane,
  type ScrumSize,
  type ScrumSeverity,
  type ScrumEpicType,
  type ScrumBoard,
  type ScrumEpicRow,
} from '@memory/stores/scrum';
import { render_scrum_canvas_md } from '@core/scrum_render';

export interface ScrumRoutesDeps {
  db: Database;
  /**
   * Kick off Beatrice's directed-build pipeline for an epic (the "start
   * developing" action). Fire-and-forget — the orchestrator wires this to a
   * detached `fire_deliberation_now('trainer', …, {instruction, tools})` so the
   * route returns immediately while she investigates + opens a reviewed PR.
   * Optional so legacy boots without the loop driver just report `building:false`.
   */
  fire_directed_build?: (directive: string, tools: string[]) => void;
}

/** Tools Beatrice gets for a card-triggered build (locate → edit/create, all review-gated).
 *  opencode_build (2026-07-18) is the preferred multi-file author — the OpenCode harness
 *  headless in a scratch worktree, submitted through the same open_change_pr gate. */
const BUILD_TOOLS = [
  'grep_codebase',
  'list_codebase',
  'read_codebase_file',
  'opencode_build',
  'propose_code_edit',
  'propose_code_change',
];

/** The directive a "start developing" click hands Beatrice. Follows the directed-build rules:
 *  anchor on real files first, edit existing files surgically, scope tight, review-gated. */
export function build_develop_directive(epic: ScrumEpicRow): string {
  const details = epic.description ? `\n\nDetails: ${epic.description}` : '';
  return [
    'Start developing this dev-board epic and ship it through your code-change pipeline.',
    '',
    `Epic: ${epic.title}${details}`,
    '',
    'For a multi-file or exploratory build, prefer ONE opencode_build call with a fully ' +
      'self-contained task (the epic title + details + concrete acceptance criteria + any ' +
      'file/dir hints — the harness sees only what you pass); it authors in a scratch ' +
      'worktree, pre-checks tsc with one repair round, and opens the PR through the normal ' +
      'gate. For a surgical single-file change, work directly: grep_codebase / ' +
      'list_codebase / read_codebase_file to locate the real files and anchor the exact ' +
      'shapes — do NOT author from memory — then propose_code_edit for surgical edits, ' +
      'propose_code_change only to create a new file. Keep it scoped to THIS epic. Either ' +
      "path opens a beatrice/* PR that routes through Kate's review and Jasper's merge " +
      'approval — nothing auto-merges, so favor a correct, minimal first PR over a broad one.',
  ].join('\n');
}

/** 403 unless the caller is the owner. Returns a Response on block, else null. */
function _gate_owner(c: Context): Response | null {
  const u = c.get('user');
  if (!u || u.tier !== 'owner') {
    return c.json({ error: 'owner tier required' }, 403);
  }
  return null;
}

const SIZES: ScrumSize[] = ['S', 'M', 'L'];
const SEVERITIES: ScrumSeverity[] = ['critical', 'high', 'medium', 'low'];
const BOARDS: ScrumBoard[] = ['backend', 'ios'];

export function create_scrum_router(deps: ScrumRoutesDeps): Hono {
  const r = new Hono();
  const store = () => new ScrumStore(deps.db);

  // ── reads ──
  r.get('/board', (c) => _gate_owner(c) ?? c.json(store().read_board()));
  r.get('/llm-context.json', (c) => _gate_owner(c) ?? c.json(store().standup_precis()));
  r.get('/roadmap', (c) =>
    _gate_owner(c) ??
    c.json({ board: store().read_board(), shipped: store().shipped_history(), generated_at: new Date().toISOString() }),
  );
  r.get('/board.md', (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return c.body(render_scrum_canvas_md(store()));
  });

  // ── writes (owner / Claude-token only) ──
  r.post('/epic', async (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.project_slug !== 'string' || typeof b.title !== 'string') {
      return c.json({ error: 'project_slug and title are required' }, 400);
    }
    const s = store();
    const project = s.project_by_slug(b.project_slug);
    if (!project) {
      return c.json({ error: `unknown project_slug; known: ${s.list_projects().map((p) => p.slug).join(', ') || '(none)'}` }, 400);
    }
    const bad = _validate(b);
    if (bad) return c.json({ error: bad }, 400);
    const epic = s.create_epic({
      project_id: project.id,
      title: b.title,
      type: (b.type as ScrumEpicType) ?? 'feature',
      size: (b.size as ScrumSize) ?? null,
      value: (b.value as ScrumSize) ?? null,
      value_note: b.value_note ?? null,
      severity: (b.severity as ScrumSeverity) ?? null,
      description: b.description ?? null,
      board: (b.board as ScrumBoard) ?? null,
      lane: (b.lane as ScrumLane) ?? undefined,
    });
    return c.json({ epic_id: epic.id, lane: epic.lane }, 201);
  });

  r.patch('/epic/:id', async (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    const b = await c.req.json().catch(() => null);
    if (!b) return c.json({ error: 'body required' }, 400);
    const bad = _validate(b);
    if (bad) return c.json({ error: bad }, 400);
    try {
      const epic = store().update_epic(c.req.param('id'), {
        title: b.title, type: b.type, size: b.size, value: b.value,
        value_note: b.value_note, severity: b.severity, description: b.description, board: b.board,
      });
      return c.json({ epic_id: epic.id, lane: epic.lane });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  r.post('/epic/:id/move', async (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    const b = await c.req.json().catch(() => null);
    const to = b?.to_lane;
    if (!LANES.includes(to)) {
      return c.json({ error: `to_lane must be one of: ${LANES.join(', ')}` }, 400);
    }
    try {
      const epic = store().move_epic(c.req.param('id'), to as ScrumLane, 'claude');
      return c.json({ epic_id: epic.id, lane: epic.lane });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  r.delete('/epic/:id', (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    try {
      const epic = store().archive_epic(c.req.param('id'));
      return c.json({ epic_id: epic.id, archived: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  r.post('/epic/:id/restore', (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    try {
      const epic = store().unarchive_epic(c.req.param('id'));
      return c.json({ epic_id: epic.id, archived: false, lane: epic.lane });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  // "Start developing" — move the epic into In Progress and (for backend epics)
  // hand it to Beatrice's directed-build pipeline. She investigates + opens a
  // beatrice/* PR that still routes through Kate's review + the owner merge gate
  // — a click never merges code. iOS epics just move (her pipeline is the
  // backend repo; iOS work lives in hearth-ios).
  r.post('/epic/:id/develop', (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    const s = store();
    const epic = s.get_epic(c.req.param('id'));
    if (!epic) return c.json({ error: `No such epic: ${c.req.param('id')}` }, 404);
    const project = s.get_project(epic.project_id);
    const board = epic.board ?? project?.board ?? 'backend';
    let lane = epic.lane;
    // Pull it forward only from a queued lane — never drag review/done backward.
    if (epic.lane === 'product_backlog' || epic.lane === 'sprint_backlog') {
      lane = s.move_epic(epic.id, 'in_progress', 'claude').lane;
    }
    let building = false;
    if (board === 'backend' && deps.fire_directed_build) {
      deps.fire_directed_build(build_develop_directive(epic), BUILD_TOOLS);
      building = true;
    }
    return c.json({
      epic_id: epic.id,
      lane,
      board,
      building,
      note: building
        ? 'Beatrice is investigating — she’ll open a reviewed PR; nothing merges without your approval.'
        : board === 'ios'
          ? 'iOS epic — moved to In Progress; build it in the hearth-ios repo.'
          : 'Moved to In Progress.',
    });
  });

  r.post('/epics/score', async (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    const b = await c.req.json().catch(() => null);
    const items = b?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ error: 'items must be a non-empty array of { epic_id, size, value | severity }' }, 400);
    }
    for (const it of items) {
      if (!it || typeof it.epic_id !== 'string') return c.json({ error: 'each item needs an epic_id' }, 400);
      const bad = _validate(it);
      if (bad) return c.json({ error: `epic ${it.epic_id}: ${bad}` }, 400);
    }
    return c.json(store().score_epics(items));
  });

  r.post('/sprint', async (c) => {
    const blocked = _gate_owner(c);
    if (blocked) return blocked;
    const b = await c.req.json().catch(() => null);
    const s = store();
    try {
      if (b?.action === 'create') {
        if (!b.label || !b.start_date || !b.end_date) return c.json({ error: 'label, start_date, end_date required' }, 400);
        const sp = s.create_sprint({ label: b.label, start_date: b.start_date, end_date: b.end_date, capacity_pts: b.capacity_pts });
        return c.json({ sprint_id: sp.id, label: sp.label }, 201);
      }
      if (b?.action === 'commit') {
        if (!Array.isArray(b.epic_ids) || b.epic_ids.length === 0) return c.json({ error: 'epic_ids required' }, 400);
        const sp = s.commit_sprint(b.epic_ids, 'claude');
        return c.json({ sprint_id: sp.id, committed: sp.committed_ids.length });
      }
      if (b?.action === 'close') {
        const sp = s.close_sprint(b?.notes ?? null, 'claude');
        return c.json({ sprint_id: sp.id, closed: true });
      }
      return c.json({ error: "action must be 'create' | 'commit' | 'close'" }, 400);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  return r;
}

/** Light enum validation shared by create + update. Returns an error string or null. */
function _validate(b: Record<string, unknown>): string | null {
  if (b.type !== undefined && b.type !== 'feature' && b.type !== 'bug') return "type must be 'feature' | 'bug'";
  if (b.size !== undefined && b.size !== null && !SIZES.includes(b.size as ScrumSize)) return 'size must be S | M | L';
  if (b.value !== undefined && b.value !== null && !SIZES.includes(b.value as ScrumSize)) return 'value must be S | M | L';
  if (b.severity !== undefined && b.severity !== null && !SEVERITIES.includes(b.severity as ScrumSeverity)) return 'severity must be critical | high | medium | low';
  if (b.board !== undefined && b.board !== null && !BOARDS.includes(b.board as ScrumBoard)) return 'board must be backend | ios';
  return null;
}
