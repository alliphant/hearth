import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolRegistry } from '@core/tool_registry';
import type { SpecialistRegistry } from '@core/specialist';
import { SkillsStore } from '@memory/stores/skills';
import { render_skill_body, skills_enabled, SHADOW_GRADUATION_USES } from '@core/skills';
import { ChangeWindowStore } from '@memory/stores/change_windows';
import { granted_tool_names } from './learn_skill';

/**
 * recall_skill — pull the full body of a procedure you wrote down, and report
 * how it went (2026-08-03).
 *
 * The read half of Tier-1. The prompt carries only name + trigger for each
 * skill (the `dynamic_tools` awareness/schema split, applied to procedure);
 * this loads the steps for the one that matches. Reading a skill executes
 * NOTHING — the model still makes each call itself, so every capability check,
 * risk tier, audit row, and owner tap along the way is untouched.
 *
 * The same tool carries the outcome report (`outcome`), deliberately: a
 * separate "rate this skill" tool is one the model reliably forgets to call,
 * and an unreported skill never graduates or retires — the ladder would be
 * decorative. Reporting on the NEXT recall is the honest compromise, and a
 * skill recalled once and never again stays provisional forever, which is the
 * correct reading of "we don't know if this works."
 */

const InputSchema = z.object({
  name: z.string().min(1).max(60).describe('The skill name from your procedures list.'),
  outcome: z
    .enum(['success', 'partial', 'dismissed'])
    .optional()
    .describe(
      "How the PREVIOUS use of this skill went, if you are recalling it again. 'dismissed' means it did not fit and you should stop being offered it.",
    ),
});

const OutputSchema = z.object({
  found: z.boolean(),
  body: z.string().optional(),
  status: z.string().optional(),
  note: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_recall_skill(deps: {
  skills: SkillsStore;
  specialists: SpecialistRegistry;
  tool_registry: ToolRegistry;
  /** Optional: absent → graduation still happens, it just goes unmeasured. */
  change_windows?: ChangeWindowStore;
}): Tool<Input, Output> {
  return {
    name: 'recall_skill',
    description:
      'Read the full steps of a procedure you previously wrote down with learn_skill. Call this when the situation in your procedures list matches what you are being asked now — before you start, not after. ' +
      'Reading a skill does nothing on its own: you still make every tool call yourself, and every normal permission still applies. ' +
      'If a step names something you can no longer do, the body says so — do the part you can and tell the user what you could not, rather than improvising around the gap. ' +
      "Pass `outcome` to report how the LAST use of this skill went; that is what promotes a provisional skill or retires one that keeps missing. Use 'dismissed' when it did not fit at all.",
    risk: 'read',
    required_capabilities: ['learn_skills'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',
    // NOT volatile (corrected 2026-08-04). It was, on the reasoning that the
    // body changes as outcomes land — but `outcome` is part of the args, so an
    // identical repeat call carries an identical reported outcome, and
    // bypassing the per-turn duplicate cache meant ONE reported dismissal
    // counted twice and could retire a skill on its own. Letting the cache do
    // its job is the fix: same args → same served result (no double count); a
    // different outcome → different key → executes normally.

    idempotency_key(input) {
      return `recall_skill:${input.name}:${input.outcome ?? 'none'}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!skills_enabled()) {
        return { found: false, note: 'Procedures are switched off right now (HEARTH_SKILLS=0).' };
      }
      const specialist_id = ctx.specialist_id;
      if (!specialist_id) {
        return { found: false, note: 'No owning specialist on this call — nothing to recall against.' };
      }

      // Record the previous outcome BEFORE reading, so a 'dismissed' that
      // retires the skill is reflected in what comes back — the model should
      // see that it just dropped this, not get a clean body implying otherwise.
      let status_after: string | null = null;
      if (input.outcome) {
        const before = deps.skills.get(specialist_id, input.name)?.status ?? null;
        status_after = deps.skills.record_outcome(specialist_id, input.name, input.outcome, ctx.now);
        // GRADUATION IS A MEASURABLE CHANGE (2026-08-04). shadow → active means
        // the prompt now carries this procedure as settled rather than
        // provisional — a real behavior change, and until now the only
        // automated change in the system that opened no change window, leaving
        // `change_measurement`'s delta arbiter blind to the whole learning
        // layer. Best-effort: a window that fails to open must never cost the
        // graduation itself.
        if (before === 'shadow' && status_after === 'active' && deps.change_windows) {
          try {
            deps.change_windows.open({
              kind: 'skill_graduation',
              ref: `${specialist_id}:${input.name}`,
              target: specialist_id,
              reason:
                `'${input.name}' graduated to active after ${SHADOW_GRADUATION_USES} reported successes — ` +
                `it now renders as settled procedure rather than provisional.`,
              applied_by: specialist_id,
              baseline: deps.change_windows.current_outcomes(),
              now: ctx.now,
            });
          } catch {
            /* the ledger is the observation, not the act */
          }
        }
      }

      const skill = deps.skills.get(specialist_id, input.name);
      if (!skill) {
        return {
          found: false,
          note: `No procedure named '${input.name}'. Check your procedures list — the names there are exact.`,
        };
      }
      if (skill.status === 'retired') {
        return {
          found: false,
          status: 'retired',
          note:
            `'${input.name}' has been retired${input.outcome === 'dismissed' ? ' — that dismissal was the last one it had' : ''}. ` +
            'Work it out fresh, and write down what actually works if it earns it.',
        };
      }

      const granted = granted_tool_names(deps.specialists, deps.tool_registry, specialist_id);
      return {
        found: true,
        status: skill.status,
        body: render_skill_body(skill, granted),
        note:
          status_after === 'active' && skill.status === 'active'
            ? 'This one has now worked enough times to stop being provisional.'
            : 'Follow it only as far as it fits; say so plainly if it stops fitting.',
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_recall_skill({
    skills: new SkillsStore(deps.db),
    specialists: deps.specialists,
    tool_registry: deps.tool_registry,
    change_windows: new ChangeWindowStore(deps.db),
  }) as unknown as Tool;
}
