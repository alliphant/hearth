/**
 * roster_gaps — unclaimed-domain evidence for Kate's staffing oversight
 * (2026-06-10).
 *
 * The hiring loop's missing half. `propose_hire` already turns "Kate
 * wants to hire X" into a reviewed packet (persona draft + Beatrice gap
 * analysis + owner approval); what didn't exist was the EVIDENCE side —
 * a deterministic answer to "what does this household keep needing that
 * NO current specialist owns?" Two signal sources, both already written
 * by the runtime:
 *
 *   - Cordelia's TRIAGE interrupts — every capture her classifier
 *     couldn't route above threshold falls through to Kate with the
 *     capture's own signals (route reason, OCR excerpt, VL description)
 *     in `details_md`. A recurring triage theme is literally "the
 *     household keeps capturing things nobody claims".
 *   - UNATTRIBUTED knowledge demand — the demand ledger's signals whose
 *     audit rows carry no specialist attribution (knowledge_demand.ts
 *     mines them; `specialist_id: null` topics are demand that didn't
 *     even land on a shelf to be found missing from).
 *
 * Clustering reuses the demand ledger's deterministic token-overlap
 * grouping — same window in, same topics out, so the refs cited in a
 * hire packet's rationale are re-verifiable.
 *
 * Consumed by the deliberation pass for specialists holding
 * `drive_roster_gaps` (Kate): topics clearing the evidence bar render
 * as a prompt section instructing her to file `propose_hire` packets
 * (or `flag_beatrice` when the gap is really a tool gap on an existing
 * specialist). Pending/recently-denied hire packets are listed in the
 * section so she doesn't re-file. Fail-open everywhere: a mining error
 * means no section, never a broken pass.
 */

import type { Database } from 'bun:sqlite';
import {
  cluster_demand,
  mine_demand_signals,
  type DemandSignal,
  type DemandTopic,
} from './knowledge_demand';
import { HIRING_PROPOSAL_KIND } from './hiring';

export interface RosterGapOptions {
  window_days: number;
  now: Date;
  max_topics: number;
}

export interface RosterGapReport {
  signals_scanned: number;
  topics: DemandTopic[];
}

/**
 * Driver kill-switch — DEFAULT OFF (2026-06-20).
 *
 * The roster-gap → `propose_hire` driver was disabled after it produced a
 * stream of nonsensical hire packets: the miner reads `search_empty` /
 * `rag_low_confidence` as "unclaimed household domains", but those signals
 * also fire for (a) opaque internal identifiers — capture ids (`c_*`,
 * `sp0rhc9trk`), a tool name (`absorb_interrupt`) — and (b) EXISTING
 * specialists' own empty shelf searches misattributed to `orchestrator`
 * (Kristi's ThinkStation research → "unclaimed workstation domain"). A
 * `search_empty` is a knowledge-ACQUISITION signal (Cordelia's job) or a
 * bug, never a STAFFING signal — so the evidence source is a category
 * error, and the small deliberation model can't tell id-noise from a real
 * role. Result: "Capture ID Resolver" / "Harper" / duplicate-Kristi/Maggie
 * packets, re-filed every pass (the prose "don't re-file / denied=no"
 * guards and the id-keyed dedup both failed as the proposed id drifted).
 *
 * OFF until the staffing-signal source is redesigned (the fix belongs at
 * this miner, not the persona). `HEARTH_ROSTER_GAPS=1` re-enables. The
 * mining functions + smoke stay intact so a redesign has a harness.
 */
export function roster_gaps_enabled(): boolean {
  return process.env.HEARTH_ROSTER_GAPS === '1';
}

/** Evidence floor a cluster must clear before it's worth Kate's pass. */
export function roster_gap_min_evidence(): number {
  const n = Number.parseInt(process.env.HEARTH_ROSTER_GAP_MIN_EVIDENCE ?? '4', 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

export function roster_gap_window_days(): number {
  const n = Number.parseInt(process.env.HEARTH_ROSTER_GAP_WINDOW_DAYS ?? '21', 10);
  return Number.isFinite(n) && n > 0 ? n : 21;
}

/* ------------------------------------------------------------------ */
/* Signal mining                                                       */
/* ------------------------------------------------------------------ */

const TRIAGE_SUMMARY_MARKER = 'below routing threshold';

/**
 * Reduce a triage interrupt's details_md to its informative content —
 * the classifier's reason + the capture's own signals — dropping the
 * boilerplate frame lines so clustering keys on the capture, not on
 * "Cordelia couldn't confidently route".
 */
export function triage_text(details_md: string | null, summary: string): string {
  if (!details_md) return summary.slice(0, 240);
  const kept = details_md
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("Cordelia couldn't confidently route") &&
        !l.startsWith('OCR excerpt:') &&
        !l.startsWith('VL description:'),
    )
    .map((l) => l.replace(/^Reason:\s*/, ''));
  const text = kept.join(' ').replace(/\s+/g, ' ').trim();
  return (text.length > 0 ? text : summary).slice(0, 240);
}

/**
 * Pull the window's unclaimed-domain signals: Cordelia triage
 * interrupts + unattributed demand-ledger signals. All emitted with
 * `specialist_id: null` so `cluster_demand` groups them purely by
 * content — "unclaimed" is the whole point.
 */
export function mine_roster_gap_signals(
  db: Database,
  opts: Pick<RosterGapOptions, 'window_days' | 'now'>,
): DemandSignal[] {
  const cutoff_iso = new Date(
    opts.now.getTime() - opts.window_days * 86_400_000,
  ).toISOString();

  const out: DemandSignal[] = [];

  const triage_rows = db
    .prepare(
      `SELECT id, ts, summary, details_md, originating_user_id
         FROM interrupts
        WHERE originating_specialist_id = 'cordelia'
          AND summary LIKE '%' || @marker || '%'
          AND ts >= @cutoff
        ORDER BY ts DESC`,
    )
    .all({ '@marker': TRIAGE_SUMMARY_MARKER, '@cutoff': cutoff_iso }) as Array<{
    id: string;
    ts: string;
    summary: string;
    details_md: string | null;
    originating_user_id: string | null;
  }>;

  for (const r of triage_rows) {
    const text = triage_text(r.details_md, r.summary);
    if (!text) continue;
    out.push({
      // Triage is routing demand, not retrieval demand, but the signal
      // contract is shared — 'search_empty' kinds stay distinct below
      // via the ref prefix and the kinds breakdown.
      kind: 'rag_low_confidence',
      specialist_id: null,
      text,
      user_id: r.originating_user_id,
      ref: `interrupt:${r.id}`,
      ts: r.ts,
    });
  }

  // Unattributed demand — signals whose audit rows carry no specialist.
  const demand = mine_demand_signals(db, {
    window_days: opts.window_days,
    now: opts.now,
  }).filter((s) => s.specialist_id === null);
  out.push(...demand);

  out.sort((a, b) => (a.ts === b.ts ? (a.ref < b.ref ? 1 : -1) : a.ts < b.ts ? 1 : -1));
  return out;
}

/** Mine + cluster + apply the evidence floor. Deterministic. */
export function mine_roster_gaps(db: Database, opts: RosterGapOptions): RosterGapReport {
  const signals = mine_roster_gap_signals(db, opts);
  const topics = cluster_demand(signals, { max_topics: opts.max_topics }).filter(
    (t) => t.evidence_count >= roster_gap_min_evidence(),
  );
  return { signals_scanned: signals.length, topics };
}

/* ------------------------------------------------------------------ */
/* Hire-packet awareness (don't re-file)                               */
/* ------------------------------------------------------------------ */

export interface KnownHirePacket {
  proposal_id: string;
  status: string;
  headline: string;
  specialist_id_proposed: string | null;
}

/**
 * Hiring packets Kate has already filed — pending ones (don't
 * re-file) and recently-decided ones (a fresh denial means "Jasper
 * said no"; don't re-litigate next Monday). Hiring packets ride
 * `kind = HIRING_PROPOSAL_KIND` with a HiringPacket payload; the
 * payload's `specialist.id` distinguishes them from other
 * recommendation-kind proposals.
 */
export function known_hire_packets(
  db: Database,
  opts: Pick<RosterGapOptions, 'window_days' | 'now'>,
): KnownHirePacket[] {
  const cutoff_iso = new Date(
    opts.now.getTime() - opts.window_days * 86_400_000,
  ).toISOString();
  const rows = db
    .prepare(
      `SELECT id, status, payload_json, ts_created
         FROM proposals
        WHERE specialist_id = 'kate'
          AND kind = @kind
          AND (status = 'pending' OR ts_created >= @cutoff)
        ORDER BY ts_created DESC`,
    )
    .all({ '@kind': HIRING_PROPOSAL_KIND, '@cutoff': cutoff_iso }) as Array<{
    id: string;
    status: string;
    payload_json: string;
    ts_created: string;
  }>;

  const out: KnownHirePacket[] = [];
  for (const r of rows) {
    try {
      const payload = JSON.parse(r.payload_json) as {
        headline?: string;
        specialist?: { id?: string };
      };
      if (!payload.specialist?.id) continue; // not a hiring packet
      out.push({
        proposal_id: r.id,
        status: r.status,
        headline: payload.headline ?? `Hire ${payload.specialist.id}`,
        specialist_id_proposed: payload.specialist.id ?? null,
      });
    } catch {
      /* opportunistic — a malformed payload is not a hire packet */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Prompt rendering                                                    */
/* ------------------------------------------------------------------ */

/**
 * Render the deliberation prompt section. Empty string when no topic
 * clears the evidence floor — most passes, by design. The instructions
 * are self-contained (the propose_hire contract restated inline)
 * because this section appears rarely; Kate shouldn't need persona
 * memory of a workflow she runs a few times a year.
 */
export function render_roster_gap_section(
  report: RosterGapReport,
  packets: KnownHirePacket[],
  opts: Pick<RosterGapOptions, 'window_days'>,
): string {
  if (report.topics.length === 0) return '';

  const lines: string[] = [];
  lines.push('');
  lines.push('## Roster-gap report (staffing oversight)');
  lines.push('');
  lines.push(
    `Unclaimed-domain evidence from the last ${opts.window_days} days — ` +
      `demand NO current specialist owns. Sources: Cordelia's triage ` +
      `fallbacks (captures she couldn't route to anyone) and unattributed ` +
      `knowledge demand. ${report.signals_scanned} signals scanned; topics ` +
      `clearing the evidence floor:`,
  );
  lines.push('');
  for (const [i, t] of report.topics.entries()) {
    const kinds = Object.entries(t.kinds)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    const users = t.user_ids.length > 0 ? ` · users: ${t.user_ids.join(', ')}` : '';
    lines.push(
      `${i + 1}. **${t.label}** — ${t.evidence_count} signals (${kinds})${users}`,
    );
    for (const s of t.sample_texts) lines.push(`   - sample: "${s}"`);
    lines.push(`   - refs: ${t.refs.join(', ')}`);
  }
  lines.push('');
  if (packets.length > 0) {
    lines.push('Hire packets already filed — do NOT re-file these roles:');
    for (const p of packets) {
      lines.push(`  - ${p.headline} (\`${p.specialist_id_proposed}\`, ${p.status})`);
    }
    lines.push('');
  }
  lines.push(
    'For each topic that adds up to a coherent ROLE (a domain a new team ' +
      'member would own end-to-end):',
  );
  lines.push(
    '  - File ONE `propose_hire` packet THIS pass: snake_case `id`, `name`, ' +
      '`role`, `voice`, a `description` grounded in the evidence samples ' +
      'above (cite the refs), a tight `knowledge_scope`, a realistic ' +
      '`proactive` cadence, and a `capability_wishlist` of what the ' +
      'evidence shows the role needs. Beatrice splits the wishlist into ' +
      'day-1 vs build-queue; Jasper approves the packet.',
  );
  lines.push(
    '  - A topic that is really a TOOL or capability gap on an EXISTING ' +
      'specialist is a `flag_beatrice`, not a hire.',
  );
  lines.push(
    '  - A topic still ambiguous after reading the samples: one line in the ' +
      "brief's `watching`, no packet. A denied packet above means Jasper " +
      'already said no — fold that domain into `watching`, not a new packet.',
  );
  lines.push('');
  return lines.join('\n');
}
