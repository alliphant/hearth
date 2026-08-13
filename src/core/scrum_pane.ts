/**
 * Scrum-board PaneBlocks — the "Scrum" tab of Beatrice's Code Shop office.
 *
 * The board folds into `compose_codeshop_pane` as a tab (Office · Scrum)
 * rather than a standalone pane_kind: Beatrice has one office, and this is the
 * grooming surface within it. Built entirely from EXISTING PaneBlock primitives
 * (hero_metric / load_chart / stacked_strip / list) so iOS + web render it with
 * no new code. Open `scrum_decision` proposals surface as an "Awaiting you" list
 * that deep-links into the proposal — the same queue the rest of Hearth uses.
 */

import type { Database } from 'bun:sqlite';
import type { PaneBlock } from './specialist_pane';
import {
  ScrumStore,
  LANE_LABELS,
  type ScrumCard,
  type ScrumLane,
} from '@memory/stores/scrum';

interface OpenDecision {
  id: string;
  title: string | null;
  summary: string | null;
}

/** Open (undecided, non-superseded) scrum_decision proposals — the decision queue. */
export function open_scrum_decisions(db: Database): OpenDecision[] {
  return db
    .prepare(
      `SELECT id, title, summary FROM proposals
        WHERE kind = 'scrum_decision' AND status = 'pending' AND superseded_by IS NULL
        ORDER BY ts_created DESC LIMIT 10`,
    )
    .all() as OpenDecision[];
}

function card_subtitle(c: ScrumCard): string {
  const bits: string[] = [];
  if (c.type === 'bug') bits.push(c.severity ? `${c.severity} bug` : 'bug');
  if (c.size) bits.push(c.size);
  if (c.roi != null) bits.push(`ROI ${c.roi.toFixed(1)}`);
  bits.push(c.board);
  const base = bits.join(' · ');
  return c.unscored ? `⚑ unscored · ${base}` : base;
}

function card_item(c: ScrumCard): {
  title: string;
  subtitle: string;
  detail_md?: string;
} {
  const detail = [c.description, c.value_note ? `_${c.value_note}_` : null]
    .filter((x): x is string => !!x)
    .join('\n\n');
  return {
    title: c.title,
    subtitle: card_subtitle(c),
    ...(detail ? { detail_md: detail } : {}),
  };
}

function lane_list(label: string, cards: ScrumCard[], cap: number): PaneBlock | null {
  if (cards.length === 0) return null;
  const items = cards.slice(0, cap).map(card_item);
  if (cards.length > cap) {
    items.push({ title: `+${cards.length - cap} more`, subtitle: '' });
  }
  return { type: 'list', title: `${label} (${cards.length})`, items };
}

/** The ordered blocks that make up the Scrum tab. */
export function scrum_pane_blocks(db: Database): PaneBlock[] {
  const store = new ScrumStore(db);
  const board = store.read_board();
  const blocks: PaneBlock[] = [];

  // Hero — say/do for the open sprint.
  if (board.sprint) {
    const sd = board.say_do;
    blocks.push({
      type: 'hero_metric',
      value: `${sd.shipped}/${sd.committed}`,
      label: `say/do · ${board.sprint.label} · day ${board.sprint.day}/${board.sprint.total}`,
      ...(sd.pct != null ? { delta: `${sd.pct}%` } : {}),
      delta_kind: 'neutral',
    });
  } else {
    blocks.push({
      type: 'hero_metric',
      value: '—',
      label: 'no active sprint',
      delta_kind: 'neutral',
    });
  }

  // Burndown — committed pts remaining per elapsed day.
  const burn = store.burndown();
  if (burn.length > 1) {
    blocks.push({
      type: 'load_chart',
      title: 'Burndown · pts remaining',
      points: burn.map((p) => ({ x: p.x, y: p.remaining, label: p.x, detail: `${p.remaining} pts` })),
      kind: 'sparkline',
      height_hint: 'sm',
    });
  }

  // Backend / iOS committed split.
  if (board.split.backend + board.split.ios > 0) {
    blocks.push({
      type: 'stacked_strip',
      title: 'Committed split',
      segments: [
        { label: 'Backend', value: board.split.backend, hue: 'z1' },
        { label: 'iOS', value: board.split.ios, hue: 'z2' },
      ],
    });
  }

  // Awaiting you — open scrum_decision proposals (deep-link into the queue).
  const decisions = open_scrum_decisions(db);
  if (decisions.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Awaiting you',
      items: decisions.map((d) => ({
        title: d.title ?? 'Scrum decision',
        ...(d.summary ? { subtitle: d.summary } : {}),
        deep_link: `hearth://proposal/${d.id}`,
      })),
    });
  }

  // Lanes — active work first, then the ranked backlog, then done (capped).
  const order: ScrumLane[] = [
    'in_progress',
    'review',
    'sprint_backlog',
    'product_backlog',
    'done',
  ];
  for (const lane of order) {
    const blk = lane_list(LANE_LABELS[lane], board.lanes[lane], lane === 'done' ? 5 : 8);
    if (blk) blocks.push(blk);
  }

  return blocks;
}

/** The Scrum tab for `compose_codeshop_pane`'s top-level tabs block. */
export function scrum_pane_tab(db: Database): {
  id: string;
  label: string;
  badge?: number;
  blocks: PaneBlock[];
} {
  const badge = open_scrum_decisions(db).length;
  return {
    id: 'scrum',
    label: 'Scrum',
    ...(badge > 0 ? { badge } : {}),
    blocks: scrum_pane_blocks(db),
  };
}
