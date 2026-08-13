// ⚠ FIXTURE-ONLY since the 2026-07-04 Anya fold-in: no live specialist
// registers this handler (the orchestrator's register_awareness list dropped
// it). It survives because smoke-proactive.ts + smoke-digestion.ts drive it
// against their seeded anya fixture specialist. Delete only alongside those
// smoke fixtures.
/**
 * Anya's awareness handler (Prompt 6c).
 *
 * Anya cares about Bailey and Mango. Signals:
 *   - Animals/Bailey.md mtime + frontmatter — chronic case, higher severity.
 *   - Animals/Mango.md mtime + frontmatter.
 *   - Medication schedule in frontmatter: if a dose is due within next 4h
 *     and ts_last_dose suggests it hasn't been given, that's a medium-high
 *     suggestion to flag.
 *   - Upcoming vet appointments (CalDAV) within 48h with no question_list:
 *     deferred to the deliberation pass — awareness stays sync + filesystem.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import type { AwarenessHandler, AwarenessHandlerDeps, AwarenessObservation, Severity } from '@core/loops';

function vault_root(deps: AwarenessHandlerDeps): string {
  return (deps.memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
}

interface MedicationSchedule {
  name?: string;
  /** Next dose due ISO string. */
  next_due?: string;
  /** ISO of last administered dose. */
  ts_last_dose?: string;
  /** Frequency in hours. */
  every_hours?: number;
}

interface AnimalFrontmatter {
  medications?: MedicationSchedule[];
}

export const anya_awareness: AwarenessHandler = {
  specialist_id: 'anya',
  async run(deps: AwarenessHandlerDeps): Promise<AwarenessObservation | null> {
    try {
      const root = vault_root(deps);
      const last = deps.last_run_at?.getTime() ?? 0;
      const now = new Date();
      const four_hours_ms = 4 * 60 * 60 * 1000;

      const animals = ['Bailey', 'Mango'];
      const observations: Array<{
        animal: string;
        reason: string;
        severity: Severity;
        med_due: boolean;
        // Set when this observation is urgent enough to escalate.
        // Each gets a dedupe_key tied to the specific dose so the same
        // upcoming dose doesn't re-fire as awareness re-ticks.
        escalation?: { dedupe_key: string; reason: string; suggested_action?: string };
      }> = [];

      for (const animal of animals) {
        const path = resolve(root, 'Animals', `${animal}.md`);
        if (!existsSync(path)) continue;
        const st = statSync(path);
        const fm_text = readFileSync(path, 'utf8');
        const fm = matter(fm_text).data as AnimalFrontmatter;

        // Medication-due check (any animal).
        for (const med of fm.medications ?? []) {
          if (!med.next_due) continue;
          const next_due = new Date(med.next_due);
          const ms_until = next_due.getTime() - now.getTime();
          if (ms_until < -24 * 60 * 60 * 1000) continue; // skip ancient overdues
          if (ms_until > four_hours_ms) continue;
          // Has the last_dose been given since last next_due window?
          const last_dose = med.ts_last_dose ? new Date(med.ts_last_dose) : null;
          const previous_window_start = new Date(next_due.getTime() - (med.every_hours ?? 12) * 60 * 60 * 1000);
          if (last_dose && last_dose >= previous_window_start) continue;
          const minutes_label =
            ms_until < 0
              ? `OVERDUE by ${Math.round(-ms_until / (60 * 1000))}m`
              : `due in ${Math.round(ms_until / (60 * 1000))}m`;
          const obs_entry: typeof observations[number] = {
            animal,
            reason: `${med.name ?? 'medication'} ${minutes_label}`,
            severity: 'medium-high',
            med_due: true,
          };
          // Escalate to Kate when overdue OR within 60 minutes.
          // 4-hour window stays as informational flag only (no Kate
          // off-schedule deliberation — her regular cadence handles it).
          const hour_ms = 60 * 60 * 1000;
          if (ms_until < 0 || ms_until <= hour_ms) {
            obs_entry.severity = ms_until < 0 ? 'high' : 'medium-high';
            // Dedupe key includes the specific dose-due timestamp
            // (rounded to the hour) so a slipping dose generates one
            // escalation per scheduled time, not one per 60-second tick.
            const dose_hour = Math.floor(next_due.getTime() / hour_ms);
            obs_entry.escalation = {
              dedupe_key: `med-${animal.toLowerCase()}-${(med.name ?? 'rx').toLowerCase().replace(/\s+/g, '-')}-${dose_hour}`,
              reason:
                ms_until < 0
                  ? `${animal}'s ${med.name ?? 'medication'} is OVERDUE by ${Math.round(-ms_until / (60 * 1000))} minutes (scheduled ${next_due.toISOString()}). Last administered: ${last_dose?.toISOString() ?? 'unknown'}.`
                  : `${animal}'s ${med.name ?? 'medication'} is due in ${Math.round(ms_until / (60 * 1000))} minutes (scheduled ${next_due.toISOString()}). Last administered: ${last_dose?.toISOString() ?? 'unknown'}.`,
              suggested_action:
                ms_until < 0
                  ? `Alert Jasper now via interrupt — dose was missed.`
                  : `Remind Jasper via interrupt or queued message — dose imminent.`,
            };
          }
          observations.push(obs_entry);
        }

        if (st.mtimeMs > last) {
          observations.push({
            animal,
            reason: 'note changed since last awareness',
            severity: animal === 'Bailey' ? 'medium' : 'low',
            med_due: false,
          });
        }
      }

      if (observations.length === 0) return null;

      // Pick the max severity for the rolled-up observation.
      const severity = observations.reduce<Severity>((acc, o) => {
        const order = { low: 1, medium: 2, 'medium-high': 3, high: 4 } as const;
        return order[o.severity] > order[acc] ? o.severity : acc;
      }, 'low');

      const summary = observations.map((o) => `${o.animal}: ${o.reason}`).join(' · ');

      const out: AwarenessObservation = {
        ts: now.toISOString(),
        summary,
        severity,
        details: { observations },
      };
      // A med-due flag is interrupt-territory only if it's overdue or very near.
      // Awareness stays conservative — flag, don't interrupt; deliberation
      // can choose to escalate.
      if (observations.some((o) => o.med_due)) {
        out.suggests_inbox_to = 'kate';
      }
      // Urgent escalation to Kate for overdue / imminent doses. Picks
      // the FIRST escalation in this pass — Kate's deliberation will
      // see all unread inbox flags anyway, but the escalate_to_kate
      // field carries one explicit dedupe key per turn.
      const first_escalation = observations.find((o) => o.escalation);
      if (first_escalation?.escalation) {
        out.escalate_to_kate = first_escalation.escalation;
      }
      return out;
    } catch (err) {
      return {
        ts: new Date().toISOString(),
        summary: 'anya awareness handler error',
        severity: 'low',
        details: { error_message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
