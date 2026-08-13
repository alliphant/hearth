/**
 * cost_watch — Kristi's deterministic cost-move alarm.
 *
 * The deliberation prelude tells her to surface material cost moves, but that
 * relied on her NOTICING during a pass — judgment as the detector. This job
 * makes detection STRUCTURAL (the verified-leak-radar philosophy): every
 * morning, recompute the per-class street drift + the 6-month cost outlook,
 * compare against fixed materiality thresholds, and drop ONE consolidated flag
 * into Kristi's own inbox just before her 07:30 pass. The flag carries the
 * numbers; her pass owns the judgment (fold into a market_pull rationale,
 * propose_action when it shifts the buy/wait calculus, or note-and-watch).
 *
 * Pure math over the recorded series — no LLM, no web. Alerts dedupe through
 * sync_meta the way the scans do: an alert re-fires only when its ROUNDED
 * payload changes (the drift moved a bucket) or after a 7-day re-ping window,
 * so a persistent squeeze is one flag a week, not one a day.
 *
 * Exported pure pieces (decide_alerts / should_fire) keep the threshold +
 * dedup logic smoke-testable without a store or inbox.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore, type KristiWorkstationsStore } from '@memory/stores/kristi_workstations';

/** Materiality thresholds — tune from audited alerts, not intuition. */
export const CLASS_DRIFT_ALERT_PCT = 4; // |median class drift| %/mo, ≥2 fitted parts
export const OUTLOOK_ALERT_PCT = 5; // |projected 6-mo base-config move| %
export const OUTLOOK_ALERT_ABS = 300; // …or $ move, whichever trips first
export const REPING_DAYS = 7;

export interface CostAlert {
  key: string; // dedup key, e.g. 'class:memory' / 'platform:hp-z2-tower-g1i'
  /** Rounded-payload bucket — when this changes, the alert re-fires early. */
  bucket: string;
  line: string; // human line for the flag body
}

/** Threshold pass over the outlook — pure, deterministic. */
export function decide_alerts(outlook: ReturnType<KristiWorkstationsStore['cost_outlook']>): CostAlert[] {
  const alerts: CostAlert[] = [];
  for (const m of outlook.market_drift) {
    if (m.n_commodities >= 2 && Math.abs(m.monthly_pct) >= CLASS_DRIFT_ALERT_PCT) {
      alerts.push({
        key: `class:${m.commodity_class}`,
        bucket: `${Math.round(m.monthly_pct)}`,
        line:
          `**${m.commodity_class}** street prices are moving ${m.monthly_pct > 0 ? '▲ +' : '▼ '}${m.monthly_pct}%/mo ` +
          `(median fitted drift across ${m.n_commodities} tracked parts).`,
      });
    }
  }
  for (const p of outlook.platforms) {
    const p6 = p.projections.find((x) => x.months === 6);
    if (!p6) continue;
    if (Math.abs(p6.delta_pct) >= OUTLOOK_ALERT_PCT || Math.abs(p6.delta_abs) >= OUTLOOK_ALERT_ABS) {
      alerts.push({
        key: `platform:${p.model_id}`,
        bucket: `${Math.round(p6.delta_pct)}`,
        line:
          `**${p.vendor.toUpperCase()} ${p.model_id}** base config projects ${p6.delta_abs > 0 ? '+' : ''}$${Math.abs(p6.delta_abs).toFixed(0)} ` +
          `(${p6.delta_pct > 0 ? '+' : ''}${p6.delta_pct}%) by +6 mo if observed commodity drift holds ` +
          `(range $${p6.low.toFixed(0)}–$${p6.high.toFixed(0)}; confidence ${p.confidence}).`,
      });
    }
  }
  return alerts;
}

/** Dedup decision: fire when the alert is new, its bucket moved, or the
 *  re-ping window elapsed. Pure — the store supplies the prior. */
export function should_fire(
  prior: { content_hash: string | null; synced_at: string } | null,
  bucket: string,
  now_ms: number,
): boolean {
  if (!prior) return true;
  if ((prior.content_hash ?? '') !== bucket) return true;
  const age_days = (now_ms - Date.parse(prior.synced_at)) / 86_400_000;
  return !Number.isFinite(age_days) || age_days >= REPING_DAYS;
}

const InputSchema = z.object({}).strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  alerts_evaluated: z.number(),
  alerts_fired: z.number(),
  flagged: z.boolean(),
  lines: z.array(z.string()),
});
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'cost_watch',
    description:
      'BACKGROUND JOB. Deterministic cost-move alarm: recomputes the per-class street drift + 6-month cost outlook and, when a move crosses the materiality thresholds (class drift ≥4%/mo across ≥2 parts; projected base-config move ≥5% or ≥$300), drops ONE consolidated flag into Kristi\'s inbox ahead of her morning pass. Deduped — a persisting squeeze re-pings weekly or when the magnitude changes bucket. No LLM; the flag carries numbers, her pass owns the judgment.',
    risk: 'write_internal',
    required_capabilities: ['read_workstation_intel', 'write_workstation_intel'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    // Reporting-only: the fields are authoritative, but an alert fires only when projected drift crosses a threshold; quiet pricing is the normal case.
    yield: { produced: ['alerts_fired'], considered: ['alerts_evaluated'], armed: false },
    idempotency_key() {
      return `cost_watch:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(_input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const outlook = store.cost_outlook({ horizons_months: [6] });
      const alerts = decide_alerts(outlook);
      const now_ms = Date.now();

      const firing = alerts.filter((a) =>
        should_fire(store.get_source_sync(`cost_watch:${a.key}`), a.bucket, now_ms),
      );

      let flagged = false;
      if (firing.length > 0) {
        const body_md =
          `**Cost watch — ${firing.length} material move${firing.length === 1 ? '' : 's'}** (deterministic thresholds; ` +
          `detail in \`commodity_trends\` / \`cost_outlook\`):\n\n` +
          firing.map((a) => `- ${a.line}`).join('\n') +
          `\n\nFold into today's pass: cross-check direction against the analyst clippings, update the affected ` +
          `lane's market_pull rationale, and file a \`propose_action\` if this shifts the buy/wait calculus. ` +
          `Every figure above is an extrapolation of YOUR recorded street series — quote drifts with their window.`;
        const inbox_id = deps.inbox.push({
          from_specialist_id: 'kristi',
          to_specialist_id: 'kristi',
          kind: 'flag',
          body_md,
        });
        deps.events?.emit({
          type: 'inbox_message_added',
          message_id: inbox_id,
          from_specialist_id: 'kristi',
          to_specialist_id: 'kristi',
          kind: 'flag',
          severity: 'medium',
        });
        for (const a of firing) {
          store.record_source_sync(`cost_watch:${a.key}`, { content_hash: a.bucket, row_count: 1 });
        }
        flagged = true;
      }

      const out = {
        ok: true,
        alerts_evaluated: alerts.length,
        alerts_fired: firing.length,
        flagged,
        lines: firing.map((a) => a.line),
      };
      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'cost_watch',
        tool_input: {},
        execution_result: out,
      });
      return out;
    },
  };
}
