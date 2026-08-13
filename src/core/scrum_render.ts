/**
 * Deterministic markdown + mermaid render of Beatrice's scrum board — the
 * "view" half of the system, shared by:
 *   - the `/api/scrum/board.md` route (what the planning-canvas page polls)
 *   - the `daily_standup` background job (snapshot written to Beatrice's vault)
 *   - the `scrum_board_read` tool's human-readable summary
 *
 * Adapted from the planning-canvas-kit's legibility budget: ≤16 x-axis labels
 * (thinned with empty strings when longer), short labels (`d1` not a date). Pure
 * function of the store — no LLM, no I/O beyond the reads the store does.
 */

import {
  LANES,
  LANE_LABELS,
  type ScrumStore,
  type ScrumCard,
  type ScrumEpicRow,
} from '@memory/stores/scrum';

function card_line(c: ScrumCard): string {
  const bits: string[] = [];
  if (c.type === 'bug') bits.push(c.severity ? `${c.severity} bug` : 'bug');
  if (c.size) bits.push(c.size);
  if (c.roi != null) bits.push(`ROI ${c.roi.toFixed(1)}`);
  bits.push(c.board);
  if (c.unscored) bits.push('⚑ unscored');
  return `- **${escape_md(c.title)}** — ${bits.join(' · ')}`;
}

function escape_md(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Thin a series to ≤max labels by blanking intermediate x labels. */
function thin_labels(labels: string[], max = 16): string[] {
  if (labels.length <= max) return labels;
  const step = Math.ceil(labels.length / max);
  return labels.map((l, i) => (i % step === 0 ? l : ''));
}

/**
 * Full canvas document — what the planning-canvas page renders. h1 sets the
 * page title (the canvas follows the doc's first `# `).
 */
export function render_scrum_canvas_md(store: ScrumStore): string {
  const board = store.read_board();
  const out: string[] = [];

  // ── header ──
  if (board.sprint) {
    const s = board.sprint;
    const pct = board.say_do.pct;
    out.push(
      `# Hearth Dev Board — ${s.label}`,
      '',
      `> Day **${s.day}/${s.total}** · Say/Do **${board.say_do.shipped}/${board.say_do.committed}**` +
        (pct != null ? ` (${pct}%)` : '') +
        ` · split **${board.split.backend}** backend / **${board.split.ios}** iOS · capacity ${s.capacity_pts} pts`,
      '',
    );
  } else {
    out.push('# Hearth Dev Board', '', '> No active sprint — groom the backlog to plan one.', '');
  }

  // ── burndown (mermaid xychart) ──
  const burn = store.burndown();
  if (burn.length > 1) {
    const labels = thin_labels(burn.map((p) => p.x));
    const ys = burn.map((p) => p.remaining);
    const ymax = Math.max(1, ...ys);
    out.push(
      '## Burndown',
      '',
      '```mermaid',
      'xychart-beta',
      `  title "Committed pts remaining"`,
      `  x-axis [${labels.map((l) => `"${l}"`).join(', ')}]`,
      `  y-axis "pts" 0 --> ${ymax}`,
      `  line [${ys.join(', ')}]`,
      '```',
      '',
    );
  }

  // ── backend / iOS split (mermaid pie) ──
  if (board.split.backend + board.split.ios > 0) {
    out.push(
      '## Committed split',
      '',
      '```mermaid',
      'pie showData',
      '  title Committed pts',
      `  "Backend" : ${board.split.backend}`,
      `  "iOS" : ${board.split.ios}`,
      '```',
      '',
    );
  }

  // ── lanes ──
  out.push('## Lanes', '');
  for (const lane of LANES) {
    const cards = board.lanes[lane];
    out.push(`### ${LANE_LABELS[lane]} (${cards.length})`);
    if (cards.length === 0) out.push('_empty_');
    else for (const c of cards.slice(0, 12)) out.push(card_line(c));
    if (cards.length > 12) out.push(`- _+${cards.length - 12} more_`);
    out.push('');
  }

  // ── ranked backlog table ──
  const backlog = board.lanes.product_backlog;
  if (backlog.length > 0) {
    out.push(
      '## Ranked backlog (grooming order)',
      '',
      '| # | Epic | Board | Type | Eff | Val | ROI | Quadrant |',
      '|---|------|-------|------|-----|-----|-----|----------|',
    );
    backlog.slice(0, 16).forEach((c, i) => {
      out.push(
        `| ${i + 1} | ${escape_md(c.title)} | ${c.board} | ${c.type} | ${c.size ?? '·'} | ` +
          `${c.type === 'bug' ? c.severity ?? '·' : c.value ?? '·'} | ` +
          `${c.roi != null ? c.roi.toFixed(1) : '·'} | ${c.quadrant} |`,
      );
    });
    out.push('');
  }

  out.push(`<sub>generated ${board.generated_at}</sub>`, '');
  return out.join('\n');
}

/**
 * Search-result list for the read tool's `query` path — id-forward so Beatrice
 * can act on a match (move/score) without asking the human to paste an id. One
 * line per match: backticked id first, then title + lane + project + scoring.
 */
export function render_scrum_search_md(
  store: ScrumStore,
  query: string,
  rows: ScrumEpicRow[],
): string {
  if (rows.length === 0) {
    return (
      `No epics match "${query}". Search a distinctive word or two from the title ` +
      `(not the whole pasted line), or read \`view: 'full'\` for the board.`
    );
  }
  const projects = new Map(store.list_projects().map((p) => [p.id, p]));
  const out: string[] = [`${rows.length} epic(s) matching "${query}":`, ''];
  for (const e of rows) {
    const bits: string[] = [LANE_LABELS[e.lane]];
    const proj = projects.get(e.project_id);
    if (proj) bits.push(proj.slug);
    bits.push(e.type === 'bug' ? (e.severity ? `${e.severity} bug` : 'bug') : 'feature');
    if (e.size) bits.push(`eff ${e.size}`);
    if (e.type !== 'bug' && e.value) bits.push(`val ${e.value}`);
    out.push(`- \`${e.id}\` — **${escape_md(e.title)}** · ${bits.join(' · ')}`);
  }
  return out.join('\n');
}

/**
 * Daily standup entry — a dated, self-contained snapshot of board state for the
 * `daily_standup` ceremony (appended to Beatrice's vault standup log). Pure
 * function of the store; the date label is passed in (the caller resolves the
 * recipient's local day via time.ts). Deterministic — it renders the board, it
 * doesn't reason about it.
 */
export function render_standup_entry_md(store: ScrumStore, date_label: string): string {
  const board = store.read_board();
  const out: string[] = [`## ${date_label} — standup`, ''];
  const sd = board.say_do;
  out.push(
    board.sprint
      ? `**Sprint ${board.sprint.label}** · day ${board.sprint.day}/${board.sprint.total} · ` +
          `Say/Do ${sd.shipped}/${sd.committed}` +
          (sd.pct != null ? ` (${sd.pct}%)` : '') +
          ` · split ${board.split.backend} backend / ${board.split.ios} iOS`
      : 'No active sprint.',
  );
  out.push('', 'Lanes: ' + LANES.map((l) => `${LANE_LABELS[l]} ${board.lanes[l].length}`).join(' · '));
  if (board.lanes.in_progress.length) {
    out.push('', '**In progress:**');
    for (const c of board.lanes.in_progress) out.push(`- ${escape_md(c.title)} (${c.board})`);
  }
  const next_up = board.lanes.product_backlog.slice(0, 5);
  if (next_up.length) {
    out.push('', '**Next up:**');
    for (const c of next_up) {
      out.push(
        `- ${escape_md(c.title)} — ${c.size ?? '·'} · ${c.board}` +
          (c.roi != null ? ` · ROI ${c.roi.toFixed(1)}` : ''),
      );
    }
  }
  const unscored = LANES.flatMap((l) => board.lanes[l]).filter((c) => c.unscored).length;
  if (unscored > 0) out.push('', `⚑ ${unscored} unscored epic(s).`);
  return out.join('\n');
}

/** Compact markdown summary for the read tool (no mermaid — Beatrice reasons over it). */
export function render_scrum_summary_md(store: ScrumStore): string {
  const p = store.standup_precis();
  const out: string[] = [];
  if (p.sprint) {
    out.push(
      `Sprint ${p.sprint.label} · day ${p.sprint.day}/${p.sprint.total} · ` +
        `Say/Do ${p.say_do.shipped}/${p.say_do.committed}` +
        (p.say_do.pct != null ? ` (${p.say_do.pct}%)` : '') +
        ` · split ${p.split.backend} backend / ${p.split.ios} iOS`,
    );
  } else {
    out.push('No active sprint.');
  }
  if (p.in_progress.length) {
    out.push('', 'In progress:');
    for (const c of p.in_progress) out.push(`- ${c.title} (${c.board})`);
  }
  if (p.next_up.length) {
    out.push('', 'Next up (ranked):');
    for (const c of p.next_up) {
      out.push(`- ${c.title} — ${c.size ?? '·'} · ${c.board}${c.roi != null ? ` · ROI ${c.roi.toFixed(1)}` : ''}`);
    }
  }
  if (p.unscored > 0) out.push('', `⚑ ${p.unscored} unscored epic(s) — assign size/value before ranking.`);
  return out.join('\n');
}
