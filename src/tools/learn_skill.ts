import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolRegistry } from '@core/tool_registry';
import type { SpecialistRegistry } from '@core/specialist';
import { SkillsStore } from '@memory/stores/skills';
import { CONSULT_TOOL_NAME } from '@core/specialist_runtime';
import {
  coldest_skill,
  skills_enabled,
  validate_skill,
  MAX_STEPS,
  MIN_STEPS,
  type NewSkill,
} from '@core/skills';

/**
 * learn_skill — write down a procedure you just worked out (2026-08-03).
 *
 * The Tier-1 half of the self-improvement loop (docs/design-hearth-self-evolution.md).
 * A skill is a DOCUMENT, never a program: nothing here creates a capability, a
 * tool, or an execution path. It records a sequence over tools the specialist
 * ALREADY holds, and `validate_skill` rejects the write if any step names a
 * tool this specialist cannot call. That check is the whole safety story —
 * which is why this tool needs no court, no merge, and no owner tap.
 *
 * A refusal is returned as data (`learned: false` + `problems`), not thrown:
 * the model needs to read WHY and fix the recipe, and an exception reaches it
 * as a bare error string with the detail compacted away.
 */

const StepSchema = z.object({
  tool: z.string().min(1).max(80).describe('An existing tool name you can already call.'),
  purpose: z.string().min(8).max(300).describe('Why this call, in one line.'),
  args_note: z
    .string()
    .max(300)
    .optional()
    .describe('How to fill the args NEXT time — prose, never literal ids from this run.'),
});

const InputSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(60)
    .describe("Stable kebab slug, e.g. 'trace-a-missing-delivery'. Re-using a name REPLACES it."),
  title: z.string().min(3).max(120),
  trigger: z
    .string()
    .min(15)
    .max(600)
    .describe('WHEN to reach for this — one specific sentence describing the situation.'),
  steps: z.array(StepSchema).min(MIN_STEPS).max(MAX_STEPS),
  verification: z
    .string()
    .min(15)
    .max(600)
    .describe('How you KNOW it worked — what you re-read, what the result should show.'),
});

const OutputSchema = z.object({
  learned: z.boolean(),
  skill_id: z.string().optional(),
  status: z.string().optional(),
  problems: z.array(z.string()).optional(),
  note: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** The tool names this specialist may actually call — the capability invariant's
 *  input. Fails CLOSED to an empty set: if we cannot resolve grants we cannot
 *  prove a step is legal, and learning nothing is the safe outcome. */
export function granted_tool_names(
  specialists: SpecialistRegistry,
  tool_registry: ToolRegistry,
  specialist_id: string,
): Set<string> {
  const spec = specialists.get(specialist_id);
  if (!spec) return new Set();
  const names = new Set(tool_registry.list_for_capabilities(spec.granted).map((t) => t.name));
  // `consult_specialist` is REAL and callable, but the runtime synthesizes it
  // per turn rather than registering it — so it was invisible here and any
  // recipe with an "ask a teammate first" step was refused (2026-08-04 audit).
  // The invariant is "a skill may only name tools the specialist can actually
  // call"; this one qualifies, so leaving it out was a false negative, not
  // safety. `load_tools` is deliberately NOT added — it loads a schema, it is
  // not a step in a procedure.
  names.add(CONSULT_TOOL_NAME);
  return names;
}

export function make_learn_skill(deps: {
  skills: SkillsStore;
  specialists: SpecialistRegistry;
  tool_registry: ToolRegistry;
}): Tool<Input, Output> {
  return {
    name: 'learn_skill',
    description:
      'Write down a multi-step procedure you just worked out, so you can recall it next time instead of re-deriving it. ' +
      `Use this AFTER you have actually solved something the long way — ${MIN_STEPS}+ tool calls that worked — not before, and not for a single call (that is what the tool itself is for). ` +
      'A skill records a SEQUENCE over tools you already hold; it does not create any new ability, and steps naming a tool you cannot call are rejected. ' +
      'Write `trigger` as the situation ("when someone asks where a parcel is and the tracking number is stale"), NOT as a label ("delivery lookup"). ' +
      'Write `args_note` as prose about how to fill args next time — never paste this run\'s literal ids, which would make the skill a cached answer instead of a procedure. ' +
      'New skills are provisional until they have worked a few times. Re-using an existing name REPLACES that skill and resets its track record.',
    risk: 'write_internal',
    required_capabilities: ['learn_skills'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      return `learn_skill:${input.name}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!skills_enabled()) {
        return { learned: false, note: 'Skill learning is switched off right now (HEARTH_SKILLS=0).' };
      }
      const specialist_id = ctx.specialist_id;
      if (!specialist_id) {
        return {
          learned: false,
          note: 'No owning specialist on this call — a skill belongs to whoever learned it, so there is nowhere to file this.',
        };
      }
      // File only under a specialist that actually holds the grant. The tool's
      // own `required_capabilities` gate the CALLER, not the id the call names,
      // so without this a row could be filed under a specialist who can never
      // render it — an invisible skill that only ever wastes a library slot.
      const owner = deps.specialists.get(specialist_id);
      if (!owner?.granted.has('learn_skills')) {
        return {
          learned: false,
          note: `'${specialist_id}' does not hold the procedural-memory grant, so a skill filed there would never be read.`,
        };
      }

      const candidate: NewSkill = {
        specialist_id,
        name: input.name,
        title: input.title,
        trigger: input.trigger,
        steps: input.steps,
        verification: input.verification,
        learned_from: ctx.conversation_id ? `conversation:${ctx.conversation_id}` : 'unknown',
      };

      const granted = granted_tool_names(deps.specialists, deps.tool_registry, specialist_id);
      const existing = deps.skills.all_for(specialist_id);

      // Retirement is DURABLE. Re-learning a retired name used to resurrect it
      // as `shadow`, which meant AUTO_REVOKE_DISMISSALS was never containment —
      // a skill the specialist had twice found useless could be reinstated by
      // writing the same name again. A retired name is spent; pick another.
      const retired = existing.find((s) => s.name === input.name && s.status === 'retired');
      if (retired) {
        return {
          learned: false,
          note:
            `'${input.name}' was retired after it kept missing — that name is spent, and re-using it ` +
            `would quietly undo the retirement. If you genuinely have a better procedure for this, ` +
            `file it under a different name so it starts from zero on its own merits.`,
        };
      }

      // A replacement does not consume a new slot — count the library as it
      // would stand AFTER the write, or renaming into a full library becomes
      // impossible to fix. `replacing` MUST be computed over the LIVE set: it
      // is subtracted from count_live(), so counting a retired same-name row as
      // a replacement subtracted a slot that was never occupied and let the
      // library reach the cap + 1.
      const replacing = existing.some((s) => s.name === input.name && s.status !== 'retired');
      const live_count = deps.skills.count_live(specialist_id) - (replacing ? 1 : 0);

      const verdict = validate_skill(candidate, granted, live_count);
      if (!verdict.ok) {
        const cold = coldest_skill(existing.filter((s) => s.status !== 'retired'));
        const hint =
          cold && live_count >= 1 && verdict.problems.some((p) => p.includes('cap'))
            ? ` Coldest skill you hold: '${cold.name}' (${cold.invocations} use(s)).`
            : '';
        return {
          learned: false,
          problems: verdict.problems,
          note: `Not learned — fix these and call again.${hint}`,
        };
      }

      const skill_id = deps.skills.create(candidate, ctx.now);
      return {
        learned: true,
        skill_id,
        status: 'shadow',
        note:
          `Filed '${input.name}' as provisional. It will show in your procedures list from the next turn; ` +
          `recall it with recall_skill when the situation matches, and report honestly how it went — ` +
          `it earns its place by working, and retires itself if it doesn't.`,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_learn_skill({
    skills: new SkillsStore(deps.db),
    specialists: deps.specialists,
    tool_registry: deps.tool_registry,
  }) as unknown as Tool;
}
