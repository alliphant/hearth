/**
 * HEARTH_TEST_MODE=1 fixtures for the deliberation pass.
 *
 * Each fixture matches on (specialist_id, slot) and inspects the ctx
 * (observations, inbox messages) to decide what to emit. The fixtures
 * are deterministic — given the same ctx they return the same envelope —
 * which is what smoke tests need.
 *
 * Real deliberation prompts are NOT here; this is only for tests.
 */

import type { DeliberationEnvelope } from './deliberation';

interface FixtureCtx {
  now: string;
  now_utc: string;
  slot: string;
  observations: Array<{ summary: string; severity: string; details?: Record<string, unknown> }>;
  unread_inbox: Array<{
    from: string;
    kind: string;
    body_md: string;
    related_proposal_id?: string;
    related_interrupt_id?: string;
  }>;
  open_process_misses?: Array<{
    id: string;
    subject_specialist_id: string;
    status: string;
    severity: string;
    task_summary: string;
    gap: string;
    routed_to: string | null;
  }>;
  vault_deltas: Array<{ path: string; mtime: string; title?: string }>;
  recent_memory_excerpts: string;
}

export function try_load_fixture(
  specialist_id: string,
  slot: string,
  ctx_raw: unknown,
): DeliberationEnvelope | null {
  const ctx = ctx_raw as FixtureCtx;

  // Anya: any observation about Bailey's medication → flag to Kate.
  if (specialist_id === 'anya') {
    const merrit_med = ctx.observations.find((o) =>
      o.summary.toLowerCase().includes('bailey') &&
      (o.summary.toLowerCase().includes('medication') || o.summary.toLowerCase().includes('dose')),
    );
    if (merrit_med) {
      return {
        summary_for_self: `Bailey medication window observed at ${slot}. Flagged to Kate.`,
        flags: [
          {
            to_specialist_id: 'kate',
            severity: 'medium-high',
            body_md: `Bailey medication window opens soon: ${merrit_med.summary}`,
          },
        ],
        proposals: [],
        interrupts: [],
      };
    }
    // Library deltas — Anya notices a new clipping in her namespace and
    // flags it to Kate. This is the path that proves
    // upload→awareness→deliberation→Kate is wired end-to-end.
    const lib_deltas = (ctx.vault_deltas ?? []).filter((d) =>
      d.path.includes('/library/') && !d.path.includes('_attachments'),
    );
    if (lib_deltas.length > 0) {
      const first = lib_deltas[0]!;
      const title = first.title ?? first.path.split('/').pop() ?? first.path;
      return {
        summary_for_self: `Reviewed ${lib_deltas.length} new library item(s) at ${slot}.`,
        flags: [
          {
            to_specialist_id: 'kate',
            severity: 'low',
            body_md: `New material in my library worth a heads-up: "${title}" (${first.path}). I'll read it before the next visit.`,
          },
        ],
        proposals: [],
        interrupts: [],
      };
    }
    return {
      summary_for_self: `Routine ${slot} check — nothing requiring attention.`,
      flags: [],
      proposals: [],
      interrupts: [],
    };
  }

  // Mariah: the autonomous miss-drive. Every deliberation pass she
  // reviews her open process misses and advances each one a single step
  // along its lifecycle. A miss whose gap reads as recurring goes to
  // Beatrice (escalate) rather than round-tripping another redo.
  if (specialist_id === 'mariah') {
    const misses = ctx.open_process_misses ?? [];
    const miss_actions: NonNullable<DeliberationEnvelope['miss_actions']> = [];
    for (const m of misses) {
      const recurring =
        m.gap.toLowerCase().includes('recurring') ||
        m.gap.toLowerCase().includes('again') ||
        m.gap.toLowerCase().includes('third time');
      if (m.status === 'open') {
        miss_actions.push({
          miss_id: m.id,
          action: 'route',
          note: `Taking ownership — ${m.subject_specialist_id} needs to close: ${m.gap}`,
        });
      } else if (m.status === 'routed') {
        if (recurring) {
          miss_actions.push({
            miss_id: m.id,
            action: 'escalate',
            note: 'This keeps recurring — handing it to Beatrice for a structural fix, not another redo.',
          });
        } else {
          miss_actions.push({
            miss_id: m.id,
            action: 'dispatch_redo',
            note: `Sending ${m.subject_specialist_id} a redo request with clearer footing.`,
          });
        }
      } else if (m.status === 'redo_dispatched') {
        miss_actions.push({
          miss_id: m.id,
          action: 'verify',
          note: 'Checking the redo actually closed the gap.',
        });
      } else if (m.status === 'verified') {
        miss_actions.push({
          miss_id: m.id,
          action: 'close',
          note: 'Redo is right — the loop is closed.',
        });
      }
      // `escalated` is Beatrice's now; nothing for Mariah to drive.
    }
    return {
      summary_for_self:
        miss_actions.length > 0
          ? `Drove ${miss_actions.length} open process miss(es) at ${slot}.`
          : `Program healthy at ${slot} — no open misses to drive.`,
      flags: [],
      proposals: [],
      interrupts: [],
      miss_actions,
    };
  }

  // Luna: a reactive home_arrival trigger pass (slot `trigger:home_arrival:*`).
  // The woken pass does a quick house read and drops a low-severity FYI to Kate
  // that the house is nominal — gives the reactive-triggers smoke an observable
  // end-to-end side effect (wake_deliberation_scoped → deliberation → inbox).
  if (specialist_id === 'luna' && slot.startsWith('trigger:home_arrival')) {
    return {
      summary_for_self: `Home-arrival pass (${slot}): quick house read, nothing urgent.`,
      flags: [
        {
          to_specialist_id: 'kate',
          severity: 'low',
          body_md:
            'Someone just got home — house systems look nominal (HVAC, doors, sensors all clear).',
        },
      ],
      proposals: [],
      interrupts: [],
    };
  }

  // Kate: triages her inbox and (at report-time slots) composes a brief.
  //   - report slots (07:00 etc.) → brief + inbox triage
  //   - triggered slots (escalation:* / wake) → inbox triage only, no
  //     brief. An off-schedule pass fired by a peer escalation still has
  //     to promote any interrupt waiting in her inbox; without this the
  //     escalation-triggered pass would silently consume the flag and
  //     leave nothing for a later scheduled pass to act on.
  if (specialist_id === 'kate') {
    const is_report =
      slot === '07:00' || slot === '12:30' || slot === '18:00' || slot === '22:00';
    const is_triggered = slot.startsWith('escalation:') || slot === 'wake';
    if (is_report || is_triggered) {
      const anya_flag = ctx.unread_inbox.find(
        (m) => m.from === 'anya' && m.body_md.toLowerCase().includes('bailey'),
      );
      // The perimeter escalation (2026-07-26): the security persona dissolved,
      // so its monitors now self-flag from 'kate'. Match on the interrupt
      // linkage rather than a sender id so a future fold can't silently stop
      // exercising this promote path.
      const perimeter_interrupt = ctx.unread_inbox.find((m) => m.related_interrupt_id);

      const env: DeliberationEnvelope = {
        summary_for_self: is_report
          ? `${slot} brief composed.`
          : `Off-schedule triage (${slot}).`,
        flags: [],
        proposals: [],
        interrupts: [],
      };

      if (is_report) {
        const attention_today: NonNullable<
          DeliberationEnvelope['morning_brief']
        >['sections']['attention_today'] = [];
        if (anya_flag) {
          attention_today.push({
            title: "Bailey's medication window",
            body: anya_flag.body_md.slice(0, 200),
            urgency: 'today',
            source_specialist_id: 'anya',
          });
        }
        env.morning_brief = {
          generated_at: ctx.now_utc,
          sections: {
            noticed:
              attention_today.length > 0
                ? 'Anya noticed Bailey is in a medication window soon.'
                : 'Quiet overnight. Nothing notable surfaced from the team.',
            attention_today,
            ready_for_review: [],
            watching:
              anya_flag || perimeter_interrupt
                ? 'Keeping an eye on the items above.'
                : 'Nothing in particular.',
          },
          mood: perimeter_interrupt ? 'attentive' : 'calm',
        };
      }

      // An escalated interrupt in the inbox → Kate promotes it to the owner.
      if (perimeter_interrupt && perimeter_interrupt.related_interrupt_id) {
        env.interrupts = [
          {
            severity: 'high',
            summary: `Promoted: ${perimeter_interrupt.body_md.slice(0, 80)}`,
            details_md: `Source interrupt ${perimeter_interrupt.related_interrupt_id} — Kate judged this worth promoting.`,
          },
        ];
      }

      return env;
    }
  }

  // Default: nothing to do.
  return {
    summary_for_self: `${specialist_id} routine ${slot}: nothing notable.`,
    flags: [],
    proposals: [],
    interrupts: [],
  };
}
