/**
 * library_pane — Cordelia's "Knowledge Desk" office (2026-06-10).
 *
 * Until now Cordelia's office was the ONE pane that composed nothing —
 * `compose_library_pane()` returned a single client `embed` block and
 * punted to the file browser. Every other specialist composes real
 * server-side sections; the Master Librarian had the thinnest surface in
 * the house. This builds her a composed office, reading ONLY committed,
 * stable stores (the capture clippings + the knowledge-demand ledger) so
 * it doesn't collide with the in-flight news/subscriptions backend — that
 * lands as the marked NEWS section below when its store exists.
 *
 * Lives in its own file (not specialist_pane.ts) so the concurrent
 * sessions sharing that file don't fight over it — the only edit there is
 * a one-line delegate. Types are imported type-only (erased at runtime,
 * so no import cycle with specialist_pane).
 *
 * Sections:
 *   1. Hero — awaiting-triage count (if any) else captures-this-week, her
 *      core throughput at a glance.
 *   2. Awaiting triage — captures Cordelia couldn't confidently route
 *      (below-threshold → Kate). The actionable backlog.
 *   3. Recently filed — routed captures + where they went.
 *   4. Knowledge gaps (OWNER-ONLY) — the demand-ledger topics: what the
 *      household keeps asking that the shelves don't have. Her acquisition
 *      worklist.
 *   5. [NEWS — insertion point] lights up when the subscriptions backend
 *      lands; renders nothing today (no clutter).
 *   6. Browse — the existing library file-browser embed, kept at the
 *      bottom so the utility survives.
 *
 * Every capture read honors the ONE visibility rule — cordon OR named
 * `shared_with` grant — via `MemoryClient.note_row_visible_to_caller`; the
 * gaps section is owner-only (it's a knowledge-management view, like Kate's
 * team-ops blocks).
 */

import type { Database } from 'bun:sqlite';
import type { PaneDocument, PaneBlock, PaneDeps } from './specialist_pane';
import type { Tier } from './users';
import { mine_knowledge_demand } from './knowledge_demand';
import { format_short_datetime } from './time';
import { compose_brain_tab } from './brain_pane';

interface CaptureRow {
  id: string;
  kind: string;
  title: string;
  captured_at: string;
  note_path: string;
  private_to: string | null;
  frontmatter_json: string;
}

interface ParsedCapture {
  id: string;
  kind: string;
  title: string;
  captured_at: string;
  routing_status: string | null;
  routed_to: string[];
}

const DEMAND_WINDOW_DAYS = 14;

function parse_fm(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function as_str_array(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function compose_library_pane(
  db: Database,
  user_id: string,
  deps: PaneDeps,
): PaneDocument {
  // Cordelia is household-visible, so a non-owner viewer defaults to
  // household tier — sees household + their own captures, never the
  // owner's private ones. (PaneDeps carries only the owner/non-owner
  // split today; if a friend-tier viewer ever reaches this office, the
  // owner-only gates below still protect the sensitive sections, and the
  // visibility rule still blocks owner-private captures.)
  const tier: Tier = deps.viewer_is_owner ? 'owner' : 'household';
  const caller = { user_id, tier };

  const rows = db
    .prepare(
      `SELECT id, kind, title, captured_at, note_path, private_to, frontmatter_json
         FROM clippings
        WHERE note_path LIKE 'Cordelia/Inbox/%'
        ORDER BY captured_at DESC
        LIMIT 40`,
    )
    .all() as CaptureRow[];

  const visible: ParsedCapture[] = [];
  for (const r of rows) {
    const fm = parse_fm(r.frontmatter_json);
    const pt =
      r.private_to ??
      (typeof fm.private_to === 'string' ? fm.private_to : undefined) ??
      undefined;
    // The ONE rule, list-read flavour: the cordon, OR a named `shared_with`
    // grant claimed by the projection and then CONFIRMED against the live note
    // (so a revoke is authoritative here the instant it is written, exactly as
    // it is in media browse/recent). Costs zero extra file reads unless a row's
    // projected frontmatter actually names this caller.
    if (!deps.memory.note_row_visible_to_caller({ ...r, private_to: pt ?? null }, caller)) continue;
    visible.push({
      id: r.id,
      kind: r.kind,
      title: r.title,
      captured_at: r.captured_at,
      routing_status: typeof fm.routing_status === 'string' ? fm.routing_status : null,
      routed_to: as_str_array(fm.routed_to),
    });
  }

  const week_ago = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const this_week = visible.filter((c) => c.captured_at >= week_ago).length;
  const triage = visible.filter((c) => c.routing_status === 'triage');
  const filed = visible.filter((c) => c.routing_status === 'routed' || c.routed_to.length > 0);

  const blocks: PaneBlock[] = [];

  // 1. Hero — backlog-first (triage), else throughput.
  if (triage.length > 0) {
    blocks.push({
      type: 'hero_metric',
      value: `${triage.length} to triage`,
      label: 'captures awaiting a routing decision',
      delta_kind: 'neutral',
    });
  } else {
    blocks.push({
      type: 'hero_metric',
      value: String(this_week),
      label: this_week === 1 ? 'capture filed this week' : 'captures filed this week',
      delta_kind: 'up_good',
    });
  }

  // 2. Awaiting triage — the actionable backlog (Cordelia → Kate).
  if (triage.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Awaiting triage',
      items: triage.slice(0, 8).map((c) => ({
        title: c.title || `(${c.kind})`,
        subtitle: `captured ${format_short_datetime(c.captured_at)} · no confident shelf yet`,
        thumb_capture_id: c.id,
      })),
    });
  }

  // 3. Recently filed — routed captures + destination.
  blocks.push(
    filed.length > 0
      ? {
          type: 'list',
          title: 'Recently filed',
          items: filed.slice(0, 8).map((c) => {
            const where = c.routed_to.length > 0 ? `→ ${c.routed_to.join(', ')}` : 'filed';
            return {
              title: c.title || `(${c.kind})`,
              subtitle: `${where} · ${format_short_datetime(c.captured_at)}`,
              thumb_capture_id: c.id,
            };
          }),
        }
      : { type: 'list', title: 'Recently filed', items: [{ title: '—', subtitle: 'Nothing filed yet.' }] },
  );

  // 4. Knowledge gaps — OWNER-ONLY (a knowledge-management view). The
  // committed demand ledger: what the household keeps asking that the
  // shelves don't satisfy. Cordelia's acquisition worklist.
  if (deps.viewer_is_owner) {
    let gap_items: Array<{ title: string; subtitle?: string }> = [];
    try {
      const { topics } = mine_knowledge_demand(db, {
        window_days: DEMAND_WINDOW_DAYS,
        now: new Date(),
        max_topics: 5,
      });
      gap_items = topics.map((t) => {
        const kinds = Object.entries(t.kinds).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
        const who = t.specialist_id ? `${t.specialist_id} · ` : '';
        return {
          title: t.label || '(unlabeled demand)',
          subtitle: `${who}${t.evidence_count} signal${t.evidence_count === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}`,
        };
      });
    } catch {
      gap_items = [];
    }
    blocks.push({
      type: 'list',
      title: 'Knowledge gaps',
      items:
        gap_items.length > 0
          ? gap_items
          : [{ title: '—', subtitle: 'No gaps surfaced — the shelves are keeping up.' }],
    });
  }

  // 5. NEWS — insertion point. When the subscriptions/news backend lands
  // (the in-flight sources_store + refresh_subscriptions lane), compose a
  // "Latest briefing" list here from the curated, citation-backed items,
  // prioritized by the demand topics above. Renders nothing today — no
  // placeholder clutter. (See architecture.md "The Watch Desk" sibling
  // pattern + the 2026-06-10 ship log.)

  // 6. Browse — keep the file-browser embed so the utility survives.
  blocks.push({ type: 'embed', view: 'library' });

  // The office is TABBED via the server `tabs` primitive (the Kate News
  // Desk pattern): Library | The Brain. The Brain tab is a SERVER-composed
  // summary of the synthesis layer, so it renders on iOS/macOS natively
  // (PaneTabsView) — the web UNWRAPS the primitive and shows its richer
  // knowledge-mesh canvas instead (app.js render_pane's library branch).
  // Owner-only + cordon-filtered. An empty synthesis layer → null → flat
  // library pane (byte-identical to pre-Brain).
  const brain_tab = deps.viewer_is_owner
    ? compose_brain_tab({ memory: deps.memory, vault_root: deps.vault_root, caller })
    : null;
  const final_blocks: PaneBlock[] = brain_tab
    ? [
        {
          type: 'tabs',
          tabs: [
            { id: 'library', label: 'Library', blocks },
            brain_tab,
          ],
        },
      ]
    : blocks;

  return {
    pane_kind: 'library',
    title: 'Knowledge Desk',
    subtitle: 'Captures, what they fed, and what the shelves still need',
    blocks: final_blocks,
    generated_at: new Date().toISOString(),
  };
}
