/**
 * distill_house_day — the nightly house ledger (house-fusion Phase 3,
 * 2026-07-13).
 *
 * HA's recorder purges after ~10 days, so `house_thermal_history` can never
 * answer "worse than January". This job-only tool distills ONE finished local
 * day into a dated entry on `Knowledge/Luna/house-log.md` — the house
 * steward's instrument log — so seasonal baselines outlive the recorder:
 * outdoor context (temp / humidity / wind / gust / irradiance), HVAC duty +
 * cycles + setpoints, each zone's Newton loss fit, and the energy day
 * (counters read at their end-of-day values from history) with an
 * irradiance-normalized yield index. The Monday steward pass diffs these
 * entries ("basement τ fell 40h→22h"; "yield index down 20% at like sun —
 * panels dirty?"); RAG indexes them like every Luna ledger.
 *
 * Deterministic assembly over the SAME primitives the interactive tool uses
 * (fit_zone_loss / build_hvac_segments / the shared zone + entity config) so
 * the ledger and `house_thermal_history` can never disagree about a day.
 * Honesty rules carry over: a value that didn't resolve is written as `—`,
 * never fabricated; thin hvac coverage is flagged inline.
 *
 * Job-only (kate.yaml background_jobs, 05:10 daily — after the day fully
 * closes, before the 07:00 brief; catch-up via
 * fire_background_job?name=house_ledger). Idempotent per date: an entry that
 * already exists is skipped, so a re-fired job never duplicates. Optional
 * `date` input (YYYY-MM-DD) backfills a specific day while the recorder
 * still holds it.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { require_caller_tier } from '@core/tool_gates';
import { local_day_start, local_iso_date } from '@core/time';
import { fetch_ha_history, type HAHistoryPoint } from '@connectors/home_assistant';
import {
  house_zones,
  hvac_climate_entity,
  outdoor_temp_entity,
  outdoor_humidity_entity,
  outdoor_wind_entity,
  outdoor_gust_entity,
  outdoor_irradiance_entity,
} from '@connectors/house_climate';
import {
  to_series,
  to_climate_points,
  build_hvac_segments,
  fit_zone_loss,
  mean_between,
  estimate_step_kw,
  estimate_window_step_kw,
  classify_high_state_ms,
  degree_hours,
} from '@connectors/house_thermal';
import {
  energy_counter_entities,
  load_power_entity,
  ev_charger_state_entity,
  ev_charger_kw,
  ev_charging_state,
  state_windows,
} from '@connectors/house_energy';
import { append_with_cap } from './update_luna_vault';

const HOUSE_LOG_PATH = 'Knowledge/Luna/house-log.md';
const MAX_LOG_ENTRIES = 400; // > a year of nightly entries

const HOUSE_LOG_HEADER = `# House log

The house's nightly instrument log — one dated entry per day, written by
Kate's 05:10 house-ledger job from Home Assistant history: outdoor
conditions (Tempest), HVAC runtime + cycles + setpoints (ecobee), each
zone's heat-loss fit (Newton coefficient k and time constant τ — LOWER k /
HIGHER τ = the envelope holds temperature better), and the energy day
(Teslemetry counters; "yield index" = kWh generated ÷ mean irradiance, a
RELATIVE number for comparing days, not an absolute efficiency). HVAC
energy is estimated from whole-home load steps at run edges — the
ELECTRIC share only (a gas furnace shows just its blower). The envelope
index (estimated HVAC kWh ÷ degree-days) ASSUMES doors and windows are
closed when not in use and folds in solar/internal gains — read its
TREND, not the absolute; a falling index after a re-seal is money saved.
The EV line separates the car from the house. The charger's "In Use"
means PLUGGED IN, not charging (a full car sits connected for hours), so
charging time is classified from the whole-home load within plugged-in
windows (load ≥ idle baseline + ¾ of the EVSE's configured 5.76 kW —
30 A breaker, NEC 80% rule; "measured" is the load-step cross-check),
and EV kWh = charging minutes × the rate, never more than the day's
total usage. A usage spike with a matching EV number is a CHARGING day,
not a house problem; "house" in the Energy line is usage minus the car.
A "—"
means the value didn't resolve that day — never estimated. The recorder
only keeps ~10 days; this ledger is the long memory. Newest first; capped
at ${MAX_LOG_ENTRIES} entries.

<!-- entries below -->
`;

// ── Schemas ────────────────────────────────────────────────────────────────

const InputSchema = z
  .object({
    date: z
      .string()
      .optional()
      .describe(
        'Local day to distill as YYYY-MM-DD (must still be within recorder retention, ~10 days). Default: yesterday.',
      ),
  })
  .strict();

const OutputSchema = z.object({
  rel_path: z.string(),
  date: z.string(),
  /** True when the date already had an entry — nothing written. */
  skipped: z.boolean(),
  reason: z.string().optional(),
  bytes_written: z.number().int().optional(),
  summary: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ── Test seams (mirror house_thermal's) ────────────────────────────────────

type HistoryResult =
  | { ok: true; history: Record<string, HAHistoryPoint[]> }
  | { ok: false; reason: string };
type HistoryProvider = (
  entity_ids: string[],
  start_iso: string,
  opts?: { end_iso?: string; minimal?: boolean; significant_only?: boolean },
) => Promise<HistoryResult>;

let _history_provider: HistoryProvider = fetch_ha_history;
let _now: () => number = () => Date.now();

/** Test-only: swap the HA history provider for canned series. */
export function _test_set_history_provider(fn: HistoryProvider | null): void {
  _history_provider = fn ?? fetch_ha_history;
}
/** Test-only: pin "now" for deterministic windows. */
export function _test_set_now(fn: (() => number) | null): void {
  _now = fn ?? (() => Date.now());
}

// ── Formatting helpers ─────────────────────────────────────────────────────

const dash = '—';
const fmt = (x: number | null | undefined, digits = 1): string =>
  x === null || x === undefined ? dash : x.toFixed(digits);

/** Highest value among points inside [start, end] — the end-of-day reading of
 *  a daily counter that resets at midnight (monotonic within its day). */
function day_counter_value(
  points: HAHistoryPoint[],
  start_ms: number,
  end_ms: number,
): number | null {
  let best: number | null = null;
  for (const p of points) {
    const t = Date.parse(p.last_changed);
    if (!Number.isFinite(t) || t < start_ms || t > end_ms) continue;
    const v = Number.parseFloat(p.state);
    if (!Number.isFinite(v)) continue;
    if (best === null || v > best) best = v;
  }
  return best;
}

// ── Tool ────────────────────────────────────────────────────────────────────

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'distill_house_day',
    description:
      "Distill one finished local day of house telemetry into the Knowledge/Luna/house-log.md ledger (job-only; the 05:10 house_ledger background job is the trigger — manual catch-up via fire_background_job). Writes a dated entry: outdoor temp/humidity/wind/gust/irradiance, HVAC heating+cooling minutes / cycles / duty / setpoints, per-zone heat-loss fits (k + τ), and the energy day (generated / usage / imported / exported kWh, self-sufficiency, irradiance-normalized yield index). Idempotent per date — an existing entry is never duplicated. Optional `date` (YYYY-MM-DD) backfills a day still inside recorder retention.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_luna', 'read_house_climate', 'read_house_energy'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `distill_house_day:${input.date ?? 'yesterday'}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      require_caller_tier(ctx, ['owner', 'household']);

      // Resolve the target local day. Explicit dates anchor at UTC noon so
      // local_day_start lands on the same calendar date in the household TZ.
      let anchor: Date;
      if (input.date) {
        const parsed = Date.parse(`${input.date}T12:00:00Z`);
        if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}$/.test(input.date.trim())) {
          return {
            rel_path: HOUSE_LOG_PATH,
            date: input.date,
            skipped: true,
            reason: 'date must be ISO YYYY-MM-DD (e.g. 2026-07-12). Re-call with that shape or omit for yesterday.',
          };
        }
        anchor = new Date(parsed);
      } else {
        anchor = new Date(_now() - 24 * 3600_000);
      }
      const date_str = local_iso_date(anchor);
      // Completed days only — a partial entry for today would be locked in by
      // idempotency and read as the whole day forever.
      const today_str = local_iso_date(new Date(_now()));
      if (date_str >= today_str) {
        const out: Output = {
          rel_path: HOUSE_LOG_PATH,
          date: date_str,
          skipped: true,
          reason: `day ${date_str} isn't finished — the ledger distills completed days only (omit date for yesterday)`,
        };
        audit(ctx, input, out);
        return out;
      }
      const start = local_day_start(anchor);
      const start_ms = start.getTime();
      // Next local midnight (30h hop absorbs DST's 23/25h days).
      const end_ms = local_day_start(new Date(start_ms + 30 * 3600_000)).getTime();
      const start_iso = new Date(start_ms).toISOString();
      const end_iso = new Date(end_ms).toISOString();

      // Idempotency: one entry per date, ever.
      const abs = resolve(deps.vault_root, HOUSE_LOG_PATH);
      const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
      if (existing.includes(`### ${date_str}`)) {
        const out: Output = {
          rel_path: HOUSE_LOG_PATH,
          date: date_str,
          skipped: true,
          reason: 'entry already exists for this date',
        };
        audit(ctx, input, out);
        return out;
      }

      // ── fetch: climate (full attrs), series (minimal), counters (minimal) ──
      const climate_id = hvac_climate_entity();
      const zone_defs = house_zones();
      const counters = energy_counter_entities();

      const climate_fetch = await _history_provider([climate_id], start_iso, {
        end_iso,
        significant_only: false,
      });
      const series_fetch = await _history_provider(
        [
          ...zone_defs.map((zd) => zd.temp),
          outdoor_temp_entity(),
          outdoor_humidity_entity(),
          outdoor_wind_entity(),
          outdoor_gust_entity(),
          outdoor_irradiance_entity(),
          load_power_entity(),
          ev_charger_state_entity(),
          ...Object.values(counters),
        ],
        start_iso,
        { end_iso, minimal: true },
      );

      if (!climate_fetch.ok && !series_fetch.ok) {
        const out: Output = {
          rel_path: HOUSE_LOG_PATH,
          date: date_str,
          skipped: true,
          reason: `HA history unavailable: ${climate_fetch.reason} — nothing written (retry via fire_background_job?name=house_ledger)`,
        };
        audit(ctx, input, out);
        return out;
      }
      const hist = series_fetch.ok ? series_fetch.history : {};

      // ── HVAC ──
      const climate_points = climate_fetch.ok
        ? to_climate_points(climate_fetch.history[climate_id] ?? [])
        : [];
      const { runs, idle, known_ms } = build_hvac_segments(climate_points, start_ms, end_ms);
      const window_ms = end_ms - start_ms;
      const coverage = known_ms / window_ms;
      const heating_min = Math.round(
        runs.filter((r) => r.action === 'heating').reduce((s, r) => s + (r.end - r.start), 0) / 60000,
      );
      const cooling_min = Math.round(
        runs.filter((r) => r.action === 'cooling').reduce((s, r) => s + (r.end - r.start), 0) / 60000,
      );
      const heating_cycles = runs.filter((r) => r.action === 'heating').length;
      const cooling_cycles = runs.filter((r) => r.action === 'cooling').length;
      const setpoints = [...new Set(climate_points.map((p) => p.setpoint).filter((s): s is number => s !== null))];

      // ── outdoor ──
      const outdoor_series = to_series(hist[outdoor_temp_entity()] ?? []);
      const outdoor_vals = outdoor_series
        .filter((p) => p.t >= start_ms && p.t <= end_ms)
        .map((p) => p.v);
      const temp_mean = mean_between(outdoor_series, start_ms, end_ms);
      const humidity_mean = mean_between(to_series(hist[outdoor_humidity_entity()] ?? []), start_ms, end_ms);
      const wind_series = to_series(hist[outdoor_wind_entity()] ?? []);
      const wind_mean = mean_between(wind_series, start_ms, end_ms);
      const gust_vals = to_series(hist[outdoor_gust_entity()] ?? [])
        .filter((p) => p.t >= start_ms && p.t <= end_ms)
        .map((p) => p.v);
      const irradiance_mean = mean_between(
        to_series(hist[outdoor_irradiance_entity()] ?? []),
        start_ms,
        end_ms,
      );

      // ── zones ──
      const zone_lines: string[] = [];
      let usable_zones = 0;
      for (const zd of zone_defs) {
        const fit = fit_zone_loss(to_series(hist[zd.temp] ?? []), outdoor_series, idle, wind_series);
        if (fit.k_median !== null && fit.k_median > 0.001) {
          usable_zones++;
          const wind_bit =
            fit.k_calm !== null || fit.k_windy !== null
              ? ` [calm ${fit.k_calm !== null ? fit.k_calm.toFixed(4) : dash}/windy ${fit.k_windy !== null ? fit.k_windy.toFixed(4) : dash}]`
              : '';
          zone_lines.push(
            `${zd.label} k=${fit.k_median.toFixed(4)}/h τ=${(1 / fit.k_median).toFixed(1)}h (${fit.physical_ks.length} seg)${wind_bit}`,
          );
        } else {
          zone_lines.push(`${zd.label} ${dash}`);
        }
      }

      // ── energy day ──
      const generated = day_counter_value(hist[counters.solar_generated] ?? [], start_ms, end_ms);
      const imported = day_counter_value(hist[counters.grid_imported] ?? [], start_ms, end_ms);
      const exported = day_counter_value(hist[counters.grid_exported] ?? [], start_ms, end_ms);
      const usage = day_counter_value(hist[counters.home_usage] ?? [], start_ms, end_ms);
      const self_sufficiency =
        generated !== null && exported !== null && usage !== null && usage > 0
          ? Math.min(1, Math.max(0, generated - exported) / usage)
          : null;
      const yield_index =
        generated !== null && irradiance_mean !== null && irradiance_mean > 10
          ? generated / irradiance_mean
          : null;

      // ── EV charging (the car is not the house) ──
      // The charger's "In Use" means PLUGGED IN, not charging (a full car sits
      // connected for hours) — the load series says when it actually drew.
      const load_series = to_series(hist[load_power_entity()] ?? []);
      const ev_points = hist[ev_charger_state_entity()] ?? [];
      const ev_known = ev_points.length > 0;
      const ev_windows = state_windows(ev_points, ev_charging_state, start_ms, end_ms);
      const plugged_minutes = Math.round(
        ev_windows.reduce((s, w) => s + (w.end - w.start), 0) / 60000,
      );
      const ev_class = ev_known
        ? classify_high_state_ms(load_series, ev_windows, ev_charger_kw())
        : null;
      const charging_minutes = ev_class !== null ? Math.round(ev_class.high_ms / 60000) : null;
      const ev_sub_windows = ev_class?.sub_windows ?? [];
      const ev_edges = ev_sub_windows.flatMap((w) => [w.start, w.end]);
      let ev_kwh = charging_minutes !== null ? ev_charger_kw() * (charging_minutes / 60) : null;
      let ev_capped = false;
      // Invariant: the car cannot have taken more than the whole day's usage.
      if (ev_kwh !== null && usage !== null && ev_kwh > usage) {
        ev_kwh = usage;
        ev_capped = true;
      }

      // ── HVAC electrical signature + envelope cost ──
      const indoor_series = climate_points
        .filter((p) => p.current !== null)
        .map((p) => ({ t: p.t, v: p.current as number }));
      // Charger transitions near an hvac edge would masquerade as compressor
      // draw — excluded from the step estimate (and vice versa below).
      const cool_est = estimate_step_kw(load_series, runs, 'cooling', ev_edges);
      const heat_est = estimate_step_kw(load_series, runs, 'heating', ev_edges);
      const hvac_edges = runs.flatMap((r) => [r.start, r.end]);
      const ev_measured = estimate_window_step_kw(load_series, ev_sub_windows, hvac_edges);
      const cooling_kwh = cool_est.kw !== null ? cool_est.kw * (cooling_min / 60) : null;
      const heating_kwh_e = heat_est.kw !== null ? heat_est.kw * (heating_min / 60) : null;
      const cdh = degree_hours(outdoor_series, indoor_series, start_ms, end_ms, 'cooling').value;
      const hdh = degree_hours(outdoor_series, indoor_series, start_ms, end_ms, 'heating').value;
      const leak_cool = cooling_kwh !== null && cdh !== null && cdh > 12 ? cooling_kwh / (cdh / 24) : null;
      const leak_heat = heating_kwh_e !== null && hdh !== null && hdh > 12 ? heating_kwh_e / (hdh / 24) : null;

      // ── compose the entry ──
      const caveat_bits: string[] = [];
      if (climate_points.length === 0) caveat_bits.push('no thermostat history');
      else if (coverage < 0.5) caveat_bits.push(`hvac coverage ${(coverage * 100).toFixed(0)}% — duty undercounts`);
      if (outdoor_series.length === 0) caveat_bits.push('no outdoor history — zone fits skipped');
      if (ev_known && plugged_minutes > 0 && charging_minutes === null)
        caveat_bits.push(
          `charger plugged ${plugged_minutes} min but load data too thin to classify the charging share`,
        );
      if (ev_capped) caveat_bits.push('EV estimate capped at total usage — treat the split as approximate');

      const entry = [
        `### ${date_str}`,
        '',
        `- Outdoor: mean ${fmt(temp_mean)}° (${fmt(outdoor_vals.length ? Math.min(...outdoor_vals) : null)}–${fmt(
          outdoor_vals.length ? Math.max(...outdoor_vals) : null,
        )}), humidity ${fmt(humidity_mean, 0)}%, wind ${fmt(wind_mean)} avg / ${fmt(
          gust_vals.length ? Math.max(...gust_vals) : null,
        )} gust, irradiance ${fmt(irradiance_mean, 0)} W/m² mean`,
        `- HVAC: cooling ${cooling_min} min / ${cooling_cycles} cycles (${((cooling_min / 1440) * 100).toFixed(1)}% duty), heating ${heating_min} min / ${heating_cycles} cycles (${((heating_min / 1440) * 100).toFixed(1)}%); setpoints ${
          setpoints.length ? setpoints.join(', ') : dash
        }`,
        `- Zones: ${zone_lines.join('; ')}`,
        `- Energy: solar ${fmt(generated, 1)} kWh, usage ${fmt(usage, 1)}${
          usage !== null && ev_kwh !== null
            ? ` (house ${fmt(Math.max(0, usage - ev_kwh), 1)} + EV ${fmt(Math.min(usage, ev_kwh), 1)})`
            : ''
        }, imported ${fmt(imported, 1)}, exported ${fmt(
          exported,
          1,
        )} — self-sufficiency ${self_sufficiency !== null ? `${(self_sufficiency * 100).toFixed(0)}%` : dash}, yield index ${fmt(
          yield_index,
          3,
        )}`,
        ...(ev_known
          ? [
              `- EV charging: ${fmt(ev_kwh, 1)} kWh (charging ${
                charging_minutes !== null ? charging_minutes : dash
              } min of ${plugged_minutes} plugged @ ${ev_charger_kw()} kW config${
                ev_measured.kw !== null ? `; measured ≈${fmt(ev_measured.kw, 1)} kW` : ''
              })`,
            ]
          : []),
        `- HVAC energy: cooling ${fmt(cooling_kwh, 1)} kWh${cool_est.kw !== null ? ` (≈${fmt(cool_est.kw, 1)} kW draw)` : ''}, heating(electric) ${fmt(heating_kwh_e, 1)} kWh${heat_est.kw !== null ? ` (≈${fmt(heat_est.kw, 1)} kW)` : ''}`,
        `- Envelope index: cooling ${fmt(leak_cool, 2)} kWh/°F·day (${fmt(cdh, 0)} °F·h), heating ${fmt(leak_heat, 2)} kWh/°F·day (${fmt(hdh, 0)} °F·h)`,
        ...(caveat_bits.length ? [`- Caveats: ${caveat_bits.join('; ')}`] : []),
      ].join('\n');

      const final_content = append_with_cap(existing, HOUSE_LOG_HEADER, entry, MAX_LOG_ENTRIES);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, final_content, 'utf8');

      const summary = `cooling ${cooling_min}m/heating ${heating_min}m; ${usable_zones}/${zone_defs.length} zone fits; solar ${fmt(generated, 1)} kWh${ev_kwh !== null && ev_kwh > 0 ? `; EV ${fmt(ev_kwh, 1)} kWh` : ''}`;
      const out: Output = {
        rel_path: HOUSE_LOG_PATH,
        date: date_str,
        skipped: false,
        bytes_written: final_content.length,
        summary,
      };
      audit(ctx, input, out);
      return out;
    },
  };

  function audit(ctx: ToolContext, input: unknown, out: Output): void {
    ctx.memory?.log_action?.({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id || 'kate',
      tool_name: 'distill_house_day',
      tool_input: input as Record<string, unknown>,
      execution_result: {
        date: out.date,
        skipped: out.skipped,
        bytes_written: out.bytes_written ?? 0,
        summary: out.summary ?? out.reason ?? null,
      },
    });
  }
}
