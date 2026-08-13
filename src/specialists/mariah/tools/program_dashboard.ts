/**
 * program_dashboard — Mariah's strategic queue view, read first at every
 * deliberation slot.
 *
 * The closed-loop ledger held ~100 open misses on the first scan-storm
 * after Pass A landed. Walking those one-at-a-time (the original
 * advance_process_miss flow) would burn Mariah's entire deliberation
 * budget on routing decisions before she got to the actual work. This
 * tool replaces "list everything and triage from raw rows" with a
 * pre-digested PM dashboard: what's on fire, where the queue is
 * trending, and which fixes would close the most misses for the least
 * effort.
 *
 * Output is intentionally one structured object the LLM reads in one
 * pass — not a stream of separate queries. Each section is ordered so
 * the most important thing reads first; specifically, `leverage_targets`
 * is the section the LLM should act on:  "X pattern has N open misses
 * all subject=trainer → one fix closes N — start there."
 *
 * Read-only. No state changes; safe to call repeatedly. Cheap (~5
 * indexed SQL queries) so Mariah calls it at the top of every
 * deliberation, every consult about queue health, and any time she's
 * about to make a routing decision.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { CategorySignature, ProposalsStore } from '@core/proposals';
import { mine_knowledge_demand, type DemandTopic } from '@core/knowledge_demand';

const InputSchema = z.object({
  /** Window for MTTR + scan-cadence + trend calculations. Optional,
   *  default 30 days. */
  trend_days: z.coerce.number().int().positive().max(180).optional(),
});

const TYPE_BUCKET = z.object({
  label: z.string(),
  count: z.number(),
});

const LEVERAGE_TARGET = z.object({
  pattern: z.string(),
  open_count: z.number(),
  subject_specialist_id: z.string().nullable(),
  routed_to_summary: z.string(),
  /** Per-status counts inside the cluster so the LLM picks a legal
   *  batch action on the first try — open misses route, escalated
   *  misses verify/close, etc. Maps onto MISS_TRANSITIONS. */
  status_breakdown: z.record(z.string(), z.number()),
  /** Suggested batch_advance_misses action for the dominant status,
   *  pre-computed so a routing decision is at hand without the LLM
   *  re-deriving it from the transition table. */
  suggested_action: z.enum(['route', 'dispatch_redo', 'verify', 'close', 'escalate']),
  /** A one-line "you'd close N misses by doing X" hint Mariah reads
   *  before deciding where to spend her next deliberation cycle. */
  one_fix_hint: z.string(),
});

const SCAN_HEALTH = z.object({
  scan_name: z.string(),
  last_run_at: z.string().nullable(),
  hours_since_last: z.number().nullable(),
  newest_finding_count: z.number().nullable(),
});

const AUTH_TIER_DIST = z.object({
  good_count: z.number(),
  warn_count: z.number(),
  bad_count: z.number(),
  unscored_count: z.number(),
  median_score: z.number().nullable(),
  bottom_3: z.array(z.object({ specialist_id: z.string(), score: z.number() })),
});

// Behavioral-eval health (2026-06-14) — the same per-specialist pass-rate the
// graduation gate enforces (ProposalsStore.eval_health_by_specialist over the
// autonomy config's eval_health_window_days). A specialist with tasks_failing
// > 0 has a STANDING regression and is held from graduating until the eval
// goes green again. Only specialists with eval runs in the window appear.
const EVAL_HEALTH = z.object({
  specialist_id: z.string(),
  tasks_total: z.number(),
  tasks_passing: z.number(),
  tasks_failing: z.number(),
  /** 0..1. */
  pass_rate: z.number(),
  /** The failing tasks' ids — each maps to an open `eval:<id>` miss that
   *  Beatrice must close to reopen the specialist's graduation door. */
  failing_task_ids: z.array(z.string()),
  window_days: z.number(),
});

// Autonomy graduation lens — accelerator for Mariah. Everything below
// names a concrete move she can make THIS pass to advance a hire from
// tier2a → tier2b → tier2c → tier3, or to unblock a stuck signature.

const GRADUATION_CANDIDATE = z.object({
  specialist_id: z.string(),
  category: z.string(),
  current_tier: z.string(),
  proposed_tier: z.string(),
  approval_count: z.number(),
  signature_hash: z.string(),
  /** A copy-pasteable nudge Mariah can ship as her one-line reply when
   *  she surfaces this candidate to {{user_name}}. */
  one_line_hint: z.string(),
});

const NEAR_READY = z.object({
  specialist_id: z.string(),
  category: z.string(),
  current_tier: z.string(),
  approval_count: z.number(),
  approvals_to_next: z.number(),
  /** True when the signature meets the approval threshold but the
   *  specialist's authenticity score is below the gate. Approvals
   *  accumulate; the candidate is held, not lost. Beatrice fixes
   *  the persona/tool issue → score recovers → graduation surfaces. */
  blocked_by_authenticity: z.boolean(),
  authenticity_score: z.number().nullable(),
  /** True when the signature meets the approval threshold but the
   *  specialist has a standing behavioral-eval regression (a golden task
   *  whose latest run failed). Approvals accumulate; the candidate is held,
   *  not lost. Beatrice closes the eval:<task_id> miss → the next nightly
   *  run goes green → graduation surfaces. Sibling of blocked_by_authenticity. */
  blocked_by_eval: z.boolean(),
});

const SPECIALIST_AUTONOMY = z.object({
  specialist_id: z.string(),
  sig_count_by_tier: z.record(z.string(), z.number()),
  total_approvals: z.number(),
  graduations_ready_count: z.number(),
  held_by_authenticity_count: z.number(),
  /** Signatures held from graduating by a standing eval regression. */
  held_by_eval_count: z.number(),
  at_risk_count: z.number(),
  authenticity_score: z.number().nullable(),
  nearest_graduation: NEAR_READY.nullable(),
});

const FRAGMENTATION_CLUSTER = z.object({
  specialist_id: z.string(),
  category: z.string(),
  signature_count: z.number(),
  total_approvals: z.number(),
  /** True when the summed approvals would clear the tier2b bar
   *  if the signature encoding weren't splitting them up. A
   *  structural acceleration opportunity for Beatrice. */
  would_graduate_if_merged: z.boolean(),
  one_fix_hint: z.string(),
});

const PROPOSAL_THROUGHPUT = z.object({
  specialist_id: z.string(),
  created: z.number(),
  approved: z.number(),
  denied: z.number(),
  edited: z.number(),
  pending: z.number(),
  /** Age of the OLDEST pending proposal in hours. A long tail here is
   *  the most direct unblock — when {{user_name}} clears the backlog,
   *  approval_counts roll forward and graduations surface. */
  oldest_pending_age_hours: z.number().nullable(),
});

const TURN_HEALTH = z.object({
  specialist_id: z.string(),
  blank_turn_total: z.number(),
  /** rounds_used >= tool_round_ceiling — the per-specialist round
   *  budget was actually exhausted. Spinning, retry-storming, or
   *  genuinely doing too much in one turn. Beatrice's lever: tool
   *  surface curation / max_tool_rounds bump / persona discipline. */
  ceiling_hits: z.number(),
  /** tool_calls_count == 0 — the model produced empty content without
   *  ever calling a tool. Usually persona-prompt confusion or a
   *  stale-history poison. Beatrice's lever: persona tuning. */
  blank_starts: z.number(),
  /** Tier the specialist is currently funneling proposals toward —
   *  ceiling exhaustion blocks earning approvals AT this tier, so
   *  surfacing it together helps Mariah prioritize. */
  current_highest_tier: z.string().nullable(),
});

const OutputSchema = z.object({
  generated_at: z.string(),
  trend_window_days: z.number(),
  // Top of pile: what's open right now, summarized at the right zoom.
  open_total: z.number(),
  open_by_severity: z.object({ high: z.number(), medium: z.number(), low: z.number() }),
  open_by_age: z.object({
    today: z.number(),
    last_3_days: z.number(),
    last_week: z.number(),
    over_week: z.number(),
  }),
  open_by_status: z.array(TYPE_BUCKET),
  open_by_subject_specialist: z.array(TYPE_BUCKET),
  open_by_pattern: z.array(TYPE_BUCKET),
  // The PM lens: where's the highest yield per fix.
  leverage_targets: z.array(LEVERAGE_TARGET),
  // Trend: is the loop converging?
  trend: z.object({
    opened_in_window: z.number(),
    closed_in_window: z.number(),
    escalated_in_window: z.number(),
    net_change: z.number(),
    mean_time_to_close_hours: z.number().nullable(),
  }),
  // Operational health of the scans themselves.
  scan_health: z.array(SCAN_HEALTH),
  // Authenticity tier distribution — the social-incentive layer.
  authenticity: AUTH_TIER_DIST,
  // Behavioral-eval health — per-specialist golden-task pass-rate over the
  // graduation gate's window. A specialist with tasks_failing > 0 has a
  // STANDING regression and is held from graduating (see autonomy_pipeline's
  // held_by_eval_count + near_ready's blocked_by_eval). Each failing task is
  // an open eval:<task_id> miss for Beatrice; route there to reopen the door.
  // Empty = no specialist has eval history in the window (e.g. before the
  // first nightly run) — the gate fails OPEN, nothing is blocked on evals.
  eval_health: z.array(EVAL_HEALTH),

  // ── Autonomy acceleration lens ────────────────────────────────
  // Signatures that pass every gate RIGHT NOW. Mariah's job is to
  // surface each as a graduation recommendation (or hand them to
  // {{user_name}} as a batch). Empty list = no graduations pending;
  // non-empty list IS the highest-leverage move available this pass.
  graduation_ready: z.array(GRADUATION_CANDIDATE),
  // Closest-to-graduating signatures across the whole roster. Tells
  // Mariah which categories are likely to graduate next and which
  // specialist needs more reps in which lane.
  near_ready: z.array(NEAR_READY),
  // Per-specialist autonomy progress. Sorted by graduations_ready
  // descending, then by total_approvals descending — the specialist
  // with the most accumulated trust reads first.
  autonomy_pipeline: z.array(SPECIALIST_AUTONOMY),
  // (specialist, category) pairs split across multiple low-count
  // signatures whose merged approvals would graduate. A structural
  // opportunity — Beatrice can widen the signature encoding so
  // legitimate-equivalent payloads accumulate into one count.
  signature_fragmentation: z.array(FRAGMENTATION_CLUSTER),
  // Per-specialist momentum in the trend window. Silent specialists
  // (created == 0) need persona/capability help; high-pending
  // specialists are waiting on {{user_name}} review.
  proposal_throughput: z.array(PROPOSAL_THROUGHPUT),
  // Per-specialist mechanism-failure rate. Specialists hitting the
  // tool-round ceiling are mechanism-blocked from earning approvals;
  // route to Beatrice via flag_beatrice with suspected_class
  // 'persona-gap' or 'tool-description-gap'.
  turn_health: z.array(TURN_HEALTH),
  // Stalled-approved (2026-06-14): proposals sitting at status='approved' with
  // ts_executed NULL — a manual/advisory kind that was approved but never
  // reached a terminal state. The decide route now stamps these `acknowledged`
  // and a boot triage cleared the legacy pile, so this should read 0; a
  // non-zero count means a new code path is leaving approvals un-terminated
  // (distinct from `pending`, which is legitimately awaiting human action).
  stalled_approved: z.number(),
  // Escalations Beatrice has sat on for 14+ days — the structural-fix
  // queue is STUCK, not working. Your move: re-flag Beatrice on the
  // oldest with the concrete blocker named, and surface a flag to Kate
  // so the stall reaches the owner's brief instead of aging silently.
  stuck_escalations: z.array(
    z.object({
      miss_id: z.string(),
      subject_specialist_id: z.string(),
      days_escalated: z.number(),
      gap_preview: z.string(),
    }),
  ),
  // Misses the store REOPENED in the trend window — a fix the loop
  // thought landed didn't hold (recurrence on the same evidence_ref).
  // Treat a reopen as a higher-priority signal than a fresh miss: the
  // first fix attempt already failed once.
  reopened_recent: z.array(
    z.object({
      miss_id: z.string(),
      subject_specialist_id: z.string(),
      status: z.string(),
      reopen_count: z.number(),
    }),
  ),
  // Knowledge-demand TREND (2026-06-14): gaps mined from the audit trail
  // whose evidence is ACCRUING this window (`new` or `growing`, recent
  // half vs older). A leading program signal — route the top one to
  // Cordelia (flag/curate) before the gap hardens into repeated
  // fabrication misses. Empty when nothing is trending up. Read-only mine
  // of the same ledger Cordelia's 04:00 pass uses.
  knowledge_demand_trend: z.array(
    z.object({
      specialist_id: z.string().nullable(),
      label: z.string(),
      evidence_count: z.number(),
      recent_evidence: z.number(),
      prior_evidence: z.number(),
      trend_direction: z.enum(['growing', 'steady', 'declining', 'new']),
    }),
  ),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const SCAN_TOOL_NAMES: readonly string[] = [
  'scan_program_health',
  'scan_program_patterns',
  'scan_specialist_alignment',
  'scan_specialist_authenticity',
  'audit_connector_affordances',
];

/**
 * Parse the pattern segment out of an `evidence_ref`. Refs follow a
 * `prefix:pattern[:id]` convention emitted by the scan tools — e.g.
 * `auth:fab-after-read-failure:01KS...` → `fab-after-read-failure`;
 * `roster:dangling-tool:iris` → `dangling-tool`;
 * `affordance:no-recovery-hint:web_search` → `no-recovery-hint`. Returns
 * `'other'` when the ref doesn't match the convention so we always have
 * a bucket key.
 */
function pattern_of(evidence_ref: string | null): string {
  if (!evidence_ref) return 'manual';
  const parts = evidence_ref.split(':');
  if (parts.length < 2) return 'other';
  return parts[1] ?? 'other';
}

/** Stable ordering for severity counts so the LLM reads high→low. */
function sort_severity(rows: Array<{ severity: string; n: number }>): {
  high: number;
  medium: number;
  low: number;
} {
  const out = { high: 0, medium: 0, low: 0 };
  for (const r of rows) {
    if (r.severity === 'high') out.high = r.n;
    else if (r.severity === 'medium') out.medium = r.n;
    else if (r.severity === 'low') out.low = r.n;
  }
  return out;
}

function hours_between(a_iso: string, b_iso: string): number {
  return (new Date(a_iso).getTime() - new Date(b_iso).getTime()) / 3_600_000;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : sorted[mid] ?? null;
}

/**
 * Pull the threshold for the next tier given the current tier. Mirrors
 * the private `threshold_for` on ProposalsStore — kept in sync via the
 * shared autonomy config.
 */
function next_approval_threshold(
  proposals: ProposalsStore,
  current: string,
): number | null {
  const cfg = proposals.config();
  switch (current) {
    case 'tier2a':
      return cfg.min_approvals_for_tier2b;
    case 'tier2b':
      return cfg.min_approvals_for_tier2c;
    case 'tier2c':
      return cfg.min_approvals_for_tier3;
    default:
      return null;
  }
}

function next_authenticity_threshold(
  proposals: ProposalsStore,
  current: string,
): number | null {
  const cfg = proposals.config();
  switch (current) {
    case 'tier2a':
      return cfg.min_authenticity_score_for_tier2b;
    case 'tier2b':
      return cfg.min_authenticity_score_for_tier2c;
    case 'tier2c':
      return cfg.min_authenticity_score_for_tier3;
    default:
      return null;
  }
}

export function make_program_dashboard(
  db: Database,
  proposals: ProposalsStore,
): Tool<Input, Output> {
  return {
    name: 'program_dashboard',
    description:
      "Mariah's strategic queue view — call this FIRST at the start of " +
      'every deliberation slot, before any routing decision. Returns a ' +
      'pre-digested snapshot covering BOTH closed-loop health AND ' +
      'autonomy graduation: open totals by severity/age/status/subject/' +
      'pattern; leverage_targets (where one fix would close N misses); ' +
      'graduation_ready (signatures that pass every gate RIGHT NOW — ' +
      "surface as a recommendation to accelerate the hire's autonomy); " +
      'near_ready (closest-to-graduating signatures); autonomy_pipeline ' +
      '(per-specialist progress + nearest milestone); ' +
      'signature_fragmentation (categories whose approvals are splitting ' +
      "across multiple signatures and won't graduate without Beatrice " +
      'widening the encoding); proposal_throughput (per-specialist ' +
      'momentum + oldest pending review); turn_health (per-specialist ' +
      'blank_turn_fallback rate — mechanism-blocked specialists who ' +
      "can't earn approvals); trend; scan freshness; authenticity " +
      'distribution; eval_health (per-specialist golden-task pass-rate — a ' +
      'standing regression holds graduation, route the failing task to ' +
      'Beatrice); knowledge_demand_trend (knowledge gaps whose ' +
      'evidence is ACCRUING this window — route the top one to Cordelia ' +
      'before it hardens into repeated fabrication misses). Read-only; ' +
      'cheap; safe to call repeatedly. The output is one object the LLM ' +
      'reads in one pass.',
    risk: 'read',
    required_capabilities: ['read_audit_log'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key() {
      return 'program_dashboard';
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const now = new Date();
      const trend_days = input.trend_days ?? 30;
      const trend_since = new Date(
        now.getTime() - trend_days * 86_400_000,
      ).toISOString();
      const today_since = new Date(now.getTime() - 86_400_000).toISOString();
      const three_days_since = new Date(
        now.getTime() - 3 * 86_400_000,
      ).toISOString();
      const week_since = new Date(now.getTime() - 7 * 86_400_000).toISOString();

      // ── Open misses, the big picture ────────────────────────────────
      const open_rows = db
        .prepare(
          `SELECT id, severity, status, subject_specialist_id, routed_to,
                  evidence_ref, ts_created
             FROM process_misses
            WHERE status != 'closed'`,
        )
        .all() as Array<{
        id: string;
        severity: string;
        status: string;
        subject_specialist_id: string;
        routed_to: string | null;
        evidence_ref: string | null;
        ts_created: string;
      }>;

      const open_total = open_rows.length;
      const sev_buckets = new Map<string, number>();
      const status_buckets = new Map<string, number>();
      const subject_buckets = new Map<string, number>();
      const pattern_buckets = new Map<string, number>();
      const age_buckets = { today: 0, last_3_days: 0, last_week: 0, over_week: 0 };
      // Per-pattern aggregation for leverage_targets: count + dominant
      // subject + routed_to summary + per-status breakdown.
      const pattern_meta = new Map<
        string,
        {
          count: number;
          subject_counts: Map<string, number>;
          routed_counts: Map<string, number>;
          status_counts: Map<string, number>;
        }
      >();

      for (const row of open_rows) {
        sev_buckets.set(row.severity, (sev_buckets.get(row.severity) ?? 0) + 1);
        status_buckets.set(row.status, (status_buckets.get(row.status) ?? 0) + 1);
        subject_buckets.set(
          row.subject_specialist_id,
          (subject_buckets.get(row.subject_specialist_id) ?? 0) + 1,
        );
        const pat = pattern_of(row.evidence_ref);
        pattern_buckets.set(pat, (pattern_buckets.get(pat) ?? 0) + 1);

        let pm = pattern_meta.get(pat);
        if (!pm) {
          pm = {
            count: 0,
            subject_counts: new Map(),
            routed_counts: new Map(),
            status_counts: new Map(),
          };
          pattern_meta.set(pat, pm);
        }
        pm.count++;
        pm.subject_counts.set(
          row.subject_specialist_id,
          (pm.subject_counts.get(row.subject_specialist_id) ?? 0) + 1,
        );
        const routed_key = row.routed_to ?? '(unrouted)';
        pm.routed_counts.set(
          routed_key,
          (pm.routed_counts.get(routed_key) ?? 0) + 1,
        );
        pm.status_counts.set(
          row.status,
          (pm.status_counts.get(row.status) ?? 0) + 1,
        );

        if (row.ts_created >= today_since) age_buckets.today++;
        else if (row.ts_created >= three_days_since) age_buckets.last_3_days++;
        else if (row.ts_created >= week_since) age_buckets.last_week++;
        else age_buckets.over_week++;
      }

      const open_by_severity_arr = [...sev_buckets.entries()].map(
        ([severity, n]) => ({ severity, n }),
      );
      const open_by_status = [...status_buckets.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
      const open_by_subject_specialist = [...subject_buckets.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
      const open_by_pattern = [...pattern_buckets.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

      // ── Leverage targets ───────────────────────────────────────────
      // The top-N patterns by open_count. For each: name the dominant
      // subject + the dominant routed_to, and synthesize a "one-fix
      // hint" the LLM can act on. We bias toward patterns whose blast-
      // radius >= 3 — singles don't earn a leverage label.
      const leverage_min = 3;
      // Map a dominant status to the legal batch action that moves it
      // forward. Mariah reads this and passes it straight into
      // batch_advance_misses without re-deriving from MISS_TRANSITIONS.
      const SUGGESTED_ACTION_BY_STATUS: Record<
        string,
        'route' | 'dispatch_redo' | 'verify' | 'close' | 'escalate'
      > = {
        open: 'route',
        routed: 'escalate', // routed to mariah; structural fix lives w/ Beatrice
        redo_dispatched: 'verify',
        verified: 'close',
        escalated: 'verify', // verify_fix_landed if/when the fix shipped
      };
      const leverage_targets = [...pattern_meta.entries()]
        .filter(([, m]) => m.count >= leverage_min)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 8)
        .map(([pat, m]) => {
          const dominant_subject = [...m.subject_counts.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0];
          const dominant_routed = [...m.routed_counts.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0];
          const dominant_status = [...m.status_counts.entries()].sort(
            (a, b) => b[1] - a[1],
          )[0];
          const status_breakdown: Record<string, number> = {};
          for (const [s, n] of m.status_counts) status_breakdown[s] = n;
          const suggested_action =
            SUGGESTED_ACTION_BY_STATUS[dominant_status?.[0] ?? 'open'] ?? 'route';
          const routed_summary = dominant_routed
            ? `${dominant_routed[0]} (${dominant_routed[1]} of ${m.count})`
            : '(unrouted)';
          const subject_summary = dominant_subject
            ? dominant_subject[0]
            : null;
          let hint: string;
          if (pat === 'no-recovery-hint') {
            hint =
              `${m.count} connectors lack structured recovery hints — ` +
              `Beatrice can templatize the ha_get_state \`candidates\` fix ` +
              `via propose_connector_recovery_hint to close many in one PR class.`;
          } else if (pat === 'fab-after-read-failure' || pat === 'fab-after-read-failure-consult') {
            hint =
              `${m.count} fabrication-after-read-failure findings — the ` +
              `upstream fix is the connector affordance audit; pair with ` +
              `the no-recovery-hint cluster above. Routing the cluster as ` +
              `one batch is fine.`;
          } else if (pat === 'thinking-only-consult') {
            hint =
              `${m.count} thinking-only-consult findings — the live ` +
              `ghost-promise guard catches new instances. Historical batch ` +
              `can be closed once the offending convs are deleted or the ` +
              `subject confirms they won't be replayed.`;
          } else if (pat === 'empty-args') {
            hint =
              `${m.count} dropped-args findings — almost always a sign of ` +
              `an uncurated tool surface OR a tool schema with refs. ` +
              `Cross-reference scan_specialist_alignment's ` +
              `uncurated_tool_surface findings before opening individual fixes.`;
          } else if (pat === 'uncurated-chat') {
            hint =
              `${m.count} specialists with uncurated chat tool surfaces — ` +
              `Beatrice's propose_persona_tuning class fits; route to her.`;
          } else if (pat === 'dangling-tool') {
            hint =
              `${m.count} dangling tools_for_chat/deliberation refs — typo ` +
              `fixes; can batch-route to Beatrice or close after a quick check.`;
          } else if (pat === 'persona-tool-gap') {
            hint =
              `${m.count} persona-prescribed-but-not-granted tool mentions — ` +
              `Beatrice picks per case (grant vs persona edit vs curation add).`;
          } else {
            hint =
              `${m.count} open misses share pattern \`${pat}\` — likely a ` +
              `single root cause; consider batch-routing.`;
          }
          return {
            pattern: pat,
            open_count: m.count,
            subject_specialist_id: subject_summary,
            routed_to_summary: routed_summary,
            status_breakdown,
            suggested_action,
            one_fix_hint: hint,
          };
        });

      // ── Trend window ───────────────────────────────────────────────
      const opened_row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM process_misses WHERE ts_created >= @t`,
        )
        .get({ '@t': trend_since }) as { n: number };
      const closed_row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM process_misses
            WHERE status = 'closed' AND ts_updated >= @t`,
        )
        .get({ '@t': trend_since }) as { n: number };
      const escalated_row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM process_misses
            WHERE status = 'escalated' AND ts_updated >= @t`,
        )
        .get({ '@t': trend_since }) as { n: number };

      // MTTR — for misses closed in window, mean hours from open → close.
      const closed_rows = db
        .prepare(
          `SELECT ts_created, ts_updated FROM process_misses
            WHERE status = 'closed' AND ts_updated >= @t`,
        )
        .all({ '@t': trend_since }) as Array<{
        ts_created: string;
        ts_updated: string;
      }>;
      const mttr_hours =
        closed_rows.length > 0
          ? Math.round(
              closed_rows.reduce(
                (acc, r) => acc + hours_between(r.ts_updated, r.ts_created),
                0,
              ) / closed_rows.length,
            )
          : null;

      // ── Scan health ────────────────────────────────────────────────
      const scan_health: z.infer<typeof SCAN_HEALTH>[] = [];
      for (const scan_name of SCAN_TOOL_NAMES) {
        const last = db
          .prepare(
            `SELECT ts, execution_result FROM audit_log
              WHERE tool_name = @t
              ORDER BY ts DESC LIMIT 1`,
          )
          .get({ '@t': scan_name }) as
          | { ts: string; execution_result: string | null }
          | undefined;
        let last_run_at: string | null = null;
        let hours_since_last: number | null = null;
        let newest_finding_count: number | null = null;
        if (last) {
          last_run_at = last.ts;
          hours_since_last =
            Math.round(hours_between(now.toISOString(), last.ts) * 10) / 10;
          if (last.execution_result) {
            try {
              const er = JSON.parse(last.execution_result) as Record<
                string,
                unknown
              >;
              const misses_opened = er.misses_opened;
              if (Array.isArray(misses_opened)) {
                newest_finding_count = misses_opened.length;
              }
            } catch {
              /* leave null */
            }
          }
        }
        scan_health.push({
          scan_name,
          last_run_at,
          hours_since_last,
          newest_finding_count,
        });
      }

      // ── Authenticity tier distribution ─────────────────────────────
      let auth: z.infer<typeof AUTH_TIER_DIST> = {
        good_count: 0,
        warn_count: 0,
        bad_count: 0,
        unscored_count: 0,
        median_score: null,
        bottom_3: [],
      };
      // Reused by the autonomy_pipeline + near_ready sections below.
      const auth_scores_map = new Map<string, number>();
      try {
        const score_rows = db
          .prepare(
            `SELECT specialist_id, score FROM authenticity_scores ORDER BY score ASC`,
          )
          .all() as Array<{ specialist_id: string; score: number }>;
        for (const r of score_rows) {
          auth_scores_map.set(r.specialist_id, r.score);
          if (r.score >= 85) auth.good_count++;
          else if (r.score >= 70) auth.warn_count++;
          else auth.bad_count++;
        }
        auth.median_score = median(score_rows.map((r) => r.score));
        auth.bottom_3 = score_rows.slice(0, 3).map((r) => ({
          specialist_id: r.specialist_id,
          score: r.score,
        }));
      } catch {
        /* table may not exist on a pre-Pass-B db */
      }

      // ── Behavioral-eval health ─────────────────────────────────────
      // The SAME per-specialist health the graduation gate enforces (one
      // computation, the autonomy config's window) — so the surfaced
      // pass-rate IS the gate. Specialists with a standing regression
      // (tasks_failing > 0) are held below; those with no runs in the
      // window are absent (unknown → gate fails open).
      const eval_health_map = proposals.eval_health_by_specialist(now);
      const eval_health: z.infer<typeof EVAL_HEALTH>[] = [...eval_health_map.values()]
        .map((h) => ({
          specialist_id: h.specialist_id,
          tasks_total: h.tasks_total,
          tasks_passing: h.tasks_passing,
          tasks_failing: h.tasks_failing,
          pass_rate: Math.round(h.pass_rate * 100) / 100,
          failing_task_ids: h.failing_task_ids,
          window_days: h.window_days,
        }))
        // Worst first — a specialist with a live regression reads before the
        // all-green ones.
        .sort((a, b) => a.pass_rate - b.pass_rate || b.tasks_failing - a.tasks_failing);
      const eval_unhealthy = new Set(
        [...eval_health_map.values()].filter((h) => h.tasks_failing > 0).map((h) => h.specialist_id),
      );

      // ── Autonomy acceleration lens ─────────────────────────────────
      // Pull every category_signature with at least one approval — those
      // are the ones in motion. Tier3 signatures are terminal so no need
      // to render them here unless the LLM cares about history.
      const sig_rows = db
        .prepare(
          `SELECT hash, signature_json, approval_count, edit_count,
                  denial_count, autonomy_status
             FROM category_signatures
            WHERE autonomy_status IN ('tier2a','tier2b','tier2c','tier3')`,
        )
        .all() as Array<{
        hash: string;
        signature_json: string;
        approval_count: number;
        edit_count: number;
        denial_count: number;
        autonomy_status: string;
      }>;

      const parsed_sigs: Array<{
        hash: string;
        sig: CategorySignature;
        approval_count: number;
        edit_count: number;
        denial_count: number;
        autonomy_status: string;
      }> = [];
      for (const r of sig_rows) {
        try {
          parsed_sigs.push({
            hash: r.hash,
            sig: JSON.parse(r.signature_json) as CategorySignature,
            approval_count: r.approval_count,
            edit_count: r.edit_count,
            denial_count: r.denial_count,
            autonomy_status: r.autonomy_status,
          });
        } catch {
          /* skip malformed row */
        }
      }

      // graduation_ready: signatures that pass every gate. The store
      // owns the gate logic (excluded categories, amount cap, sensitive
      // recipient, web-action toggle, authenticity); we just render.
      const ready = proposals.check_graduation_candidates();
      const graduation_ready = ready.map((c) => ({
        specialist_id: c.signature.specialist_id,
        category: c.signature.category,
        current_tier: c.current_status,
        proposed_tier: c.proposed_status,
        approval_count: c.approval_count,
        signature_hash: c.signature_hash,
        one_line_hint:
          `${c.signature.specialist_id}'s \`${c.signature.category}\` ` +
          `signature has ${c.approval_count} approvals — ready to graduate ` +
          `${c.current_status} → ${c.proposed_status}. Surface this as a ` +
          `recommendation proposal.`,
      }));

      // near_ready: signatures one or two approvals away. Pulls every
      // signature whose gap-to-next is ≤ 2 OR whose authenticity is
      // holding back an otherwise-eligible candidate.
      const near_ready_arr: z.infer<typeof NEAR_READY>[] = [];
      for (const s of parsed_sigs) {
        const threshold = next_approval_threshold(proposals, s.autonomy_status);
        if (threshold === null) continue; // tier3 — terminal
        const gap = threshold - s.approval_count;
        const auth_score = auth_scores_map.get(s.sig.specialist_id) ?? null;
        const auth_threshold = next_authenticity_threshold(
          proposals,
          s.autonomy_status,
        );
        const auth_blocked =
          gap <= 0 &&
          auth_threshold !== null &&
          auth_score !== null &&
          auth_score < auth_threshold;
        // Eval-held: earned the approval bar but a standing behavioral
        // regression holds the door (same gate check_graduation_candidates
        // applies). The signal is more important than gap — surface it.
        const eval_blocked = gap <= 0 && eval_unhealthy.has(s.sig.specialist_id);
        // Surface if within reach OR held (authenticity or eval) — a held
        // signal means the door is closed despite earning the bar.
        if (gap > 2 && !auth_blocked && !eval_blocked) continue;
        near_ready_arr.push({
          specialist_id: s.sig.specialist_id,
          category: s.sig.category,
          current_tier: s.autonomy_status,
          approval_count: s.approval_count,
          approvals_to_next: Math.max(0, gap),
          blocked_by_authenticity: auth_blocked,
          authenticity_score: auth_score,
          blocked_by_eval: eval_blocked,
        });
      }
      near_ready_arr.sort((a, b) => {
        // Held first (door closed despite earning the bar — authenticity or
        // eval), then by smallest gap.
        const a_held = a.blocked_by_authenticity || a.blocked_by_eval;
        const b_held = b.blocked_by_authenticity || b.blocked_by_eval;
        if (a_held !== b_held) return a_held ? -1 : 1;
        return a.approvals_to_next - b.approvals_to_next;
      });
      const near_ready = near_ready_arr.slice(0, 12);

      // autonomy_pipeline: per-specialist rollup.
      const per_specialist = new Map<
        string,
        {
          sig_count_by_tier: Map<string, number>;
          total_approvals: number;
          graduations_ready_count: number;
          held_by_authenticity_count: number;
          held_by_eval_count: number;
          at_risk_count: number;
          nearest_graduation: z.infer<typeof NEAR_READY> | null;
        }
      >();
      const ensure = (spec_id: string) => {
        let r = per_specialist.get(spec_id);
        if (!r) {
          r = {
            sig_count_by_tier: new Map(),
            total_approvals: 0,
            graduations_ready_count: 0,
            held_by_authenticity_count: 0,
            held_by_eval_count: 0,
            at_risk_count: 0,
            nearest_graduation: null,
          };
          per_specialist.set(spec_id, r);
        }
        return r;
      };
      for (const s of parsed_sigs) {
        const r = ensure(s.sig.specialist_id);
        r.sig_count_by_tier.set(
          s.autonomy_status,
          (r.sig_count_by_tier.get(s.autonomy_status) ?? 0) + 1,
        );
        r.total_approvals += s.approval_count;
        if (s.denial_count > 0) r.at_risk_count++;
      }
      for (const c of ready) {
        const r = ensure(c.signature.specialist_id);
        r.graduations_ready_count++;
      }
      for (const n of near_ready_arr) {
        const r = ensure(n.specialist_id);
        if (n.blocked_by_authenticity) r.held_by_authenticity_count++;
        if (n.blocked_by_eval) r.held_by_eval_count++;
        // Keep the smallest-gap (or authenticity-held) row as the
        // nearest_graduation pointer.
        if (
          r.nearest_graduation === null ||
          (n.blocked_by_authenticity && !r.nearest_graduation.blocked_by_authenticity) ||
          (!n.blocked_by_authenticity &&
            !r.nearest_graduation.blocked_by_authenticity &&
            n.approvals_to_next < r.nearest_graduation.approvals_to_next)
        ) {
          r.nearest_graduation = n;
        }
      }
      const autonomy_pipeline: z.infer<typeof SPECIALIST_AUTONOMY>[] = [
        ...per_specialist.entries(),
      ]
        .map(([specialist_id, v]) => {
          const tier_counts: Record<string, number> = {};
          for (const [t, n] of v.sig_count_by_tier) tier_counts[t] = n;
          return {
            specialist_id,
            sig_count_by_tier: tier_counts,
            total_approvals: v.total_approvals,
            graduations_ready_count: v.graduations_ready_count,
            held_by_authenticity_count: v.held_by_authenticity_count,
            held_by_eval_count: v.held_by_eval_count,
            at_risk_count: v.at_risk_count,
            authenticity_score: auth_scores_map.get(specialist_id) ?? null,
            nearest_graduation: v.nearest_graduation,
          };
        })
        .sort((a, b) => {
          if (a.graduations_ready_count !== b.graduations_ready_count) {
            return b.graduations_ready_count - a.graduations_ready_count;
          }
          return b.total_approvals - a.total_approvals;
        });

      // signature_fragmentation: (specialist, category) pairs with
      // multiple signatures. Surfaces when a single category's
      // approvals are splitting across hash-distinct payload shapes —
      // a Beatrice-fix opportunity (widen the canonical encoding).
      const tier2b_threshold = proposals.config().min_approvals_for_tier2b;
      const frag_buckets = new Map<
        string,
        {
          specialist_id: string;
          category: string;
          signature_count: number;
          total_approvals: number;
        }
      >();
      for (const s of parsed_sigs) {
        const key = `${s.sig.specialist_id}|${s.sig.category}`;
        let b = frag_buckets.get(key);
        if (!b) {
          b = {
            specialist_id: s.sig.specialist_id,
            category: s.sig.category,
            signature_count: 0,
            total_approvals: 0,
          };
          frag_buckets.set(key, b);
        }
        b.signature_count++;
        b.total_approvals += s.approval_count;
      }
      const signature_fragmentation: z.infer<typeof FRAGMENTATION_CLUSTER>[] = [
        ...frag_buckets.values(),
      ]
        .filter((b) => b.signature_count >= 2 && b.total_approvals >= 2)
        .sort((a, b) => b.total_approvals - a.total_approvals)
        .slice(0, 10)
        .map((b) => {
          const would_graduate = b.total_approvals >= tier2b_threshold;
          const hint = would_graduate
            ? `${b.specialist_id}/${b.category}: ${b.signature_count} ` +
              `signatures totaling ${b.total_approvals} approvals — ` +
              `would clear tier2b if merged. Flag Beatrice to widen the ` +
              `signature encoding for this category.`
            : `${b.specialist_id}/${b.category}: ${b.signature_count} ` +
              `signatures totaling ${b.total_approvals} approvals — ` +
              `splitting reduces graduation velocity; flag Beatrice if the ` +
              `payload shapes are semantically equivalent.`;
          return {
            specialist_id: b.specialist_id,
            category: b.category,
            signature_count: b.signature_count,
            total_approvals: b.total_approvals,
            would_graduate_if_merged: would_graduate,
            one_fix_hint: hint,
          };
        });

      // proposal_throughput: per-specialist activity in the window.
      const throughput_rows = db
        .prepare(
          `SELECT specialist_id, status, ts_created, modifications_json
             FROM proposals
            WHERE ts_created >= @t`,
        )
        .all({ '@t': trend_since }) as Array<{
        specialist_id: string;
        status: string;
        ts_created: string;
        modifications_json: string | null;
      }>;
      const pending_oldest = db
        .prepare(
          `SELECT specialist_id, MIN(ts_created) AS oldest
             FROM proposals
            WHERE status = 'pending'
         GROUP BY specialist_id`,
        )
        .all() as Array<{ specialist_id: string; oldest: string }>;
      const oldest_pending_by_spec = new Map<string, string>();
      for (const r of pending_oldest) oldest_pending_by_spec.set(r.specialist_id, r.oldest);
      const throughput_by_spec = new Map<
        string,
        {
          created: number;
          approved: number;
          denied: number;
          edited: number;
          pending: number;
        }
      >();
      for (const r of throughput_rows) {
        let agg = throughput_by_spec.get(r.specialist_id);
        if (!agg) {
          agg = { created: 0, approved: 0, denied: 0, edited: 0, pending: 0 };
          throughput_by_spec.set(r.specialist_id, agg);
        }
        agg.created++;
        if (r.status === 'approved' || r.status === 'executed' || r.status === 'acknowledged')
          agg.approved++;
        else if (r.status === 'denied') agg.denied++;
        else if (r.status === 'pending' || r.status === 'snoozed') agg.pending++;
        if (r.modifications_json && r.modifications_json !== 'null') agg.edited++;
      }
      const proposal_throughput: z.infer<typeof PROPOSAL_THROUGHPUT>[] = [
        ...throughput_by_spec.entries(),
      ]
        .map(([specialist_id, v]) => {
          const oldest = oldest_pending_by_spec.get(specialist_id);
          const oldest_age =
            oldest
              ? Math.round(hours_between(now.toISOString(), oldest) * 10) / 10
              : null;
          return {
            specialist_id,
            created: v.created,
            approved: v.approved,
            denied: v.denied,
            edited: v.edited,
            pending: v.pending,
            oldest_pending_age_hours: oldest_age,
          };
        })
        .sort((a, b) => b.created - a.created);

      // turn_health: per-specialist mechanism-failure rate.
      const turn_rows = db
        .prepare(
          `SELECT agent, tool_input
             FROM audit_log
            WHERE tool_name = 'blank_turn_fallback' AND ts >= @t`,
        )
        .all({ '@t': trend_since }) as Array<{
        agent: string;
        tool_input: string | null;
      }>;
      const turn_by_spec = new Map<
        string,
        { total: number; ceiling: number; blank: number }
      >();
      for (const r of turn_rows) {
        let agg = turn_by_spec.get(r.agent);
        if (!agg) {
          agg = { total: 0, ceiling: 0, blank: 0 };
          turn_by_spec.set(r.agent, agg);
        }
        agg.total++;
        let rounds: number | null = null;
        let tool_calls: number | null = null;
        let ceiling: number | null = null;
        if (r.tool_input) {
          try {
            const parsed = JSON.parse(r.tool_input) as {
              rounds_used?: number;
              tool_calls_count?: number;
              tool_round_ceiling?: number;
            };
            if (typeof parsed.rounds_used === 'number') rounds = parsed.rounds_used;
            if (typeof parsed.tool_calls_count === 'number') tool_calls = parsed.tool_calls_count;
            if (typeof parsed.tool_round_ceiling === 'number') ceiling = parsed.tool_round_ceiling;
          } catch {
            /* leave null */
          }
        }
        // Post-fix audit rows carry tool_round_ceiling alongside the
        // real rounds_used. Pre-fix rows have neither — rounds_used was
        // tool-call count, which against the old default-10 threshold
        // classified parallel-tool-call turns as ceiling hits. Fall
        // back to the old shape for those; they roll off the trend
        // window in ~14d.
        if (rounds !== null && ceiling !== null && rounds >= ceiling) agg.ceiling++;
        else if (rounds !== null && ceiling === null && rounds >= 10) agg.ceiling++;
        else if (tool_calls === 0) agg.blank++;
        else if (tool_calls === null && rounds === 0) agg.blank++;
      }
      // Pull each specialist's highest current tier for context.
      const highest_tier_by_spec = new Map<string, string>();
      for (const s of parsed_sigs) {
        const cur = highest_tier_by_spec.get(s.sig.specialist_id);
        // tier ordering: tier3 > tier2c > tier2b > tier2a
        const ord: Record<string, number> = {
          tier2a: 0,
          tier2b: 1,
          tier2c: 2,
          tier3: 3,
        };
        if (!cur || (ord[s.autonomy_status] ?? 0) > (ord[cur] ?? 0)) {
          highest_tier_by_spec.set(s.sig.specialist_id, s.autonomy_status);
        }
      }
      const turn_health: z.infer<typeof TURN_HEALTH>[] = [...turn_by_spec.entries()]
        .map(([specialist_id, v]) => ({
          specialist_id,
          blank_turn_total: v.total,
          ceiling_hits: v.ceiling,
          blank_starts: v.blank,
          current_highest_tier: highest_tier_by_spec.get(specialist_id) ?? null,
        }))
        .sort((a, b) => b.blank_turn_total - a.blank_turn_total);

      // ── Stuck escalations + reopened misses (loop-latency lenses) ───
      const stuck_cutoff = new Date(now.getTime() - 14 * 86_400_000).toISOString();
      const stuck_escalations = (
        db
          .prepare(
            `SELECT id, subject_specialist_id, ts_updated, gap
               FROM process_misses
              WHERE status = 'escalated' AND ts_updated <= @cutoff
              ORDER BY ts_updated ASC LIMIT 15`,
          )
          .all({ '@cutoff': stuck_cutoff }) as Array<{
          id: string;
          subject_specialist_id: string;
          ts_updated: string;
          gap: string;
        }>
      ).map((r) => ({
        miss_id: r.id,
        subject_specialist_id: r.subject_specialist_id,
        days_escalated: Math.floor(
          (now.getTime() - new Date(r.ts_updated).getTime()) / 86_400_000,
        ),
        gap_preview: r.gap.slice(0, 120),
      }));
      const reopened_recent = (
        db
          .prepare(
            `SELECT id, subject_specialist_id, status, notes_md
               FROM process_misses
              WHERE notes_md LIKE '%reopened by%' AND ts_updated >= @since
              ORDER BY ts_updated DESC LIMIT 15`,
          )
          .all({ '@since': trend_since }) as Array<{
          id: string;
          subject_specialist_id: string;
          status: string;
          notes_md: string;
        }>
      ).map((r) => ({
        miss_id: r.id,
        subject_specialist_id: r.subject_specialist_id,
        status: r.status,
        reopen_count: (r.notes_md.match(/reopened by/g) ?? []).length,
      }));

      // Accruing knowledge gaps (read-only mine of the demand ledger).
      // Surface only what's trending UP — new gaps first, then growing —
      // so Mariah routes a hardening gap to Cordelia before it becomes
      // repeated fabrication misses. Fail-open: a mining hiccup never
      // breaks the dashboard.
      let knowledge_demand_trend: Array<{
        specialist_id: string | null;
        label: string;
        evidence_count: number;
        recent_evidence: number;
        prior_evidence: number;
        trend_direction: DemandTopic['trend_direction'];
      }> = [];
      try {
        const rank = (d: DemandTopic['trend_direction']): number =>
          d === 'new' ? 0 : d === 'growing' ? 1 : 2;
        knowledge_demand_trend = mine_knowledge_demand(db, {
          window_days: trend_days,
          now,
          max_topics: 40,
        })
          .topics.filter(
            (t) => t.trend_direction === 'new' || t.trend_direction === 'growing',
          )
          .sort(
            (a, b) =>
              rank(a.trend_direction) - rank(b.trend_direction) ||
              b.recent_evidence - a.recent_evidence,
          )
          .slice(0, 6)
          .map((t) => ({
            specialist_id: t.specialist_id,
            label: t.label,
            evidence_count: t.evidence_count,
            recent_evidence: t.recent_evidence,
            prior_evidence: t.prior_evidence,
            trend_direction: t.trend_direction,
          }));
      } catch {
        /* fail-open — demand trend is a nice-to-have lens */
      }

      // Stalled-approved: a global count (not window-scoped — the stuck pile
      // is mostly old) of approvals that never reached a terminal state.
      const stalled_approved = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM proposals WHERE status = 'approved' AND ts_executed IS NULL`,
          )
          .get() as { n: number }
      ).n;

      return {
        generated_at: now.toISOString(),
        trend_window_days: trend_days,
        open_total,
        open_by_severity: sort_severity(open_by_severity_arr),
        open_by_age: age_buckets,
        open_by_status,
        open_by_subject_specialist,
        open_by_pattern,
        leverage_targets,
        trend: {
          opened_in_window: opened_row.n,
          closed_in_window: closed_row.n,
          escalated_in_window: escalated_row.n,
          net_change: opened_row.n - closed_row.n,
          mean_time_to_close_hours: mttr_hours,
        },
        scan_health,
        authenticity: auth,
        eval_health,
        graduation_ready,
        near_ready,
        autonomy_pipeline,
        signature_fragmentation,
        proposal_throughput,
        turn_health,
        stuck_escalations,
        reopened_recent,
        knowledge_demand_trend,
        stalled_approved,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_program_dashboard(deps.db, deps.proposals) as Tool;
}
