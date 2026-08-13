/**
 * brain_pane — the "Second Brain" TAB for Cordelia's library office (2026-06-16).
 *
 * Cordelia's office uses the server-side `tabs` pane primitive (the Kate
 * News Desk / Ruby Politics Desk pattern): tab 1 is her Library (captures,
 * filing, demand gaps), tab 2 is this Brain — a SERVER-COMPOSED summary of
 * the synthesis layer (how much distilled knowledge exists, what's earning
 * its keep, what's freshest). iOS/macOS render the segmented tabs natively
 * (PaneTabsView), so the Brain finally appears off the web. The WEB office
 * UNWRAPS the primitive and drives its own tab bar, because its Brain tab is
 * the richer interactive knowledge-mesh CANVAS (/api/specialists/cordelia/brain,
 * app.js render_brain_view) — see app.js render_pane's library branch.
 *
 * Deliberately LIGHT and self-contained — it scans the synthesis notes +
 * the retrieval-usage store directly, rather than reusing build_brain_graph
 * (which lives in the app/routes layer, computes per-fact provenance + an
 * O(n²) cross-shelf cosine pass, and would invert core→route layering). The
 * tab is a SUMMARY; the web canvas remains the full graph. Lives in its own
 * file per the news_pane.ts extraction pattern — specialist_pane.ts is shared
 * across concurrent session lanes; the hook there stays tiny.
 *
 * OWNER-ONLY (the synthesis layer is private — same gate as the brain route)
 * and every synthesis is cordon-filtered with `note_visible_to_caller`, so
 * even the owner never sees another user's private synthesis (no god-view).
 */
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MemoryClient } from '@memory/client';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import type { PaneBlock } from './specialist_pane';
import { format_short_datetime } from './time';

export interface BrainTab {
  id: string;
  label: string;
  badge?: number;
  blocks: PaneBlock[];
}

interface SynthesisSummary {
  path: string;
  shelf: string; // the Knowledge/<Shelf>/ namespace dir, already display-cased
  title: string;
  topic: string;
  synthesized_at: string | null;
  grounding: string | null;
}

/**
 * Compose the Brain tab from the synthesis layer, or null when there's
 * nothing distilled yet (→ the library pane stays flat, no tabs block,
 * byte-identical to pre-Brain). Owner-only; pass the owner's caller.
 */
export function compose_brain_tab(opts: {
  memory: MemoryClient;
  vault_root: string;
  caller: Caller;
}): BrainTab | null {
  const { memory, vault_root, caller } = opts;
  // Fail-open: a caller with no vault_root wired (legacy/minimal PaneDeps in
  // some smokes) gets no Brain tab rather than a thrown resolve(undefined).
  if (!vault_root) return null;
  const knowledge_root = resolve(vault_root, 'Knowledge');
  if (!existsSync(knowledge_root)) return null;

  let namespaces: string[];
  try {
    namespaces = readdirSync(knowledge_root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }

  const syns: SynthesisSummary[] = [];
  const shelves = new Set<string>();
  for (const ns of namespaces) {
    const synth_rel = `Knowledge/${ns}/library/_synthesis`;
    if (!existsSync(resolve(vault_root, synth_rel))) continue;
    let files: string[];
    try {
      files = readdirSync(resolve(vault_root, synth_rel)).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of files) {
      const note_path = `${synth_rel}/${f}`;
      const note = memory.read_note(note_path);
      if (!note) continue;
      const fm = note.frontmatter as Record<string, unknown>;
      if (fm.type !== 'synthesis_note') continue;
      const private_to = typeof fm.private_to === 'string' ? fm.private_to : undefined;
      if (!note_visible_to_caller(private_to, caller)) continue; // owner has no god-view
      const topic = typeof fm.topic_label === 'string' ? fm.topic_label : f.replace(/\.md$/, '');
      syns.push({
        path: note_path,
        shelf: ns,
        title: typeof fm.title === 'string' ? fm.title : topic,
        topic,
        synthesized_at: typeof fm.synthesized_at === 'string' ? fm.synthesized_at : null,
        grounding: typeof fm.grounding_outcome === 'string' ? fm.grounding_outcome : null,
      });
      shelves.add(ns);
    }
  }
  if (syns.length === 0) return null;

  // Worth signal — real retrieval usage (one batched read). A synthesis the
  // team has drawn into a live answer is earning its keep; one never retrieved
  // is dead weight the self-heal loop will eventually prune.
  const usage = memory.get_synthesis_usage(syns.map((s) => s.path));
  const hits_for = (p: string) => usage.get(p)?.hits ?? 0;
  const valued = syns.filter((s) => hits_for(s.path) > 0).length;
  const corrected = syns.filter(
    (s) => s.grounding === 'corrected' || s.grounding === 'reduced',
  ).length;

  const blocks: PaneBlock[] = [];

  // 1. Hero — the size of the distilled layer.
  blocks.push({
    type: 'hero_metric',
    value: String(syns.length),
    label:
      syns.length === 1
        ? 'distilled synthesis'
        : `distilled syntheses across ${shelves.size} ${shelves.size === 1 ? 'shelf' : 'shelves'}`,
    delta_kind: 'neutral',
  });

  // 2. One-line health of the layer.
  const health_bits = [`${valued} drawn into a live answer`];
  if (corrected > 0) {
    health_bits.push(`${corrected} corrected for fabrication before shelving`);
  }
  blocks.push({
    type: 'text',
    body_md: `*The reading-layer the team answers FROM — ${health_bits.join(' · ')}.*`,
  });

  // 3. Most drawn-on — the syntheses earning their keep (worth axis).
  const by_use = syns
    .map((s) => ({ s, hits: hits_for(s.path) }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 6);
  if (by_use.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Most drawn-on',
      items: by_use.map(({ s, hits }) => ({
        title: s.topic || s.title,
        subtitle: `${s.shelf} · drawn into ${hits} answer${hits === 1 ? '' : 's'}`,
      })),
    });
  }

  // 4. Recently distilled — the freshest knowledge (ISO sorts lexically).
  const recent = syns
    .filter((s) => s.synthesized_at)
    .sort((a, b) => (b.synthesized_at as string).localeCompare(a.synthesized_at as string))
    .slice(0, 6);
  if (recent.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Recently distilled',
      items: recent.map((s) => ({
        title: s.topic || s.title,
        subtitle: `${s.shelf} · ${format_short_datetime(s.synthesized_at as string)}`,
      })),
    });
  }

  return { id: 'brain', label: 'The Brain', blocks };
}
