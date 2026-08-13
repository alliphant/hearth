/**
 * skills — Tier-1 procedural memory: a recipe solved once, written down as
 * DATA and read back as prose (2026-08-03).
 *
 * THE GAP THIS FILLS. Hearth has two speeds for "get better at something" and
 * nothing in between. Compiled tool code goes through `propose_code_change` →
 * deterministic gate → swarm → owner merge (correct, and expensive). Persona
 * YAML is edited by hand or through `persona_tuning` (cheap, and static — it
 * describes VOICE, explicitly "the WEAKEST layer" per that tool's own
 * description). Neither captures the thing that actually recurs: a specialist
 * works out a six-call sequence with the owner, gets it right, and by tomorrow
 * that sequence is gone. `capability_demand` already proves the inverse case is
 * worth ledgering (tool surface MISSES); this ledgers the HITS.
 *
 * THE ONE INVARIANT THAT MAKES THIS SAFE TO SHIP CHEAP:
 *
 *     A SKILL IS A DOCUMENT, NEVER A PROGRAM.
 *
 * The runtime NEVER executes a skill. It renders one into the prompt and the
 * model then makes each tool call itself, through the ordinary gated dispatch —
 * same capability check, same risk tier, same audit row, same proposal gate on
 * anything owner-tapped. So a skill cannot widen what a specialist may do. That
 * is why this needs no court and no merge, and why it can come alive
 * mid-session while Tier-2 (real hot-loaded tool code) still goes the long way
 * round.
 *
 * This is enforced, not just asserted: `validate_skill` rejects any step naming
 * a tool the specialist has not been granted, and `render_skill_body` re-checks
 * at read time, so a capability revoked AFTER a skill was learned degrades the
 * skill instead of quietly outliving the grant. An adversarial audit
 * (2026-08-04) attacked all three legs against the live 348-tool registry —
 * including forging `ctx.specialist_id`, the one `dispatch_only` tool, and
 * finding a second writer to the table — and could not break any of them.
 *
 * ONE CORRECTION FROM THAT AUDIT, worth stating because the original header
 * got it wrong. It claimed "the worst a bad skill can do is give bad advice,
 * which is the same blast radius as a bad persona line." It is NOT the same. A
 * persona line is owner-authored YAML under review; a skill's text is
 * model-authored at runtime, unreviewed, persistent, and lands in the same
 * system prompt. The grant invariant held, but the prompt's STRUCTURE was
 * forgeable — see `flatten_for_prompt`, which is the fix. The right reading is
 * narrower and still enough: a skill cannot widen REACH, so it needs no
 * capability review; but its text is untrusted input to the prompt and is
 * treated as such.
 *
 * AWARENESS vs BODY, the `load_tools` pattern. Carrying every skill body in
 * every prompt is the same bloat `dynamic_tools.ts` was written to kill. So
 * skills render in two tiers exactly as tools do: a one-line-per-skill
 * awareness block always, and `recall_skill` to pull the full body on demand.
 *
 * EARNED, NOT ASSUMED. A new skill is born `shadow` — rendered, but labelled
 * provisional, so the model treats it as a suggestion rather than doctrine.
 * `SHADOW_GRADUATION_USES` recorded successes promote it to `active`;
 * `AUTO_REVOKE_DISMISSALS` dismissals retire it. This is the trust-teeth
 * scored-week discipline applied to procedure, and it means a skill learned
 * from one lucky turn cannot harden into a rule.
 *
 * Pure and deterministic: no I/O, no LLM, no clock beyond what callers pass.
 * The store (`@memory/stores/skills`) supplies rows; this module decides shape,
 * legality, lifecycle, and rendering. Kill switch: HEARTH_SKILLS=0.
 */

/**
 * Flatten model-authored text before it is interpolated into a system prompt
 * (added 2026-08-04, after an adversarial audit).
 *
 * The original design leaned on a corollary: "the worst a bad skill can do is
 * give bad advice — the same blast radius as a bad persona line." That was
 * wrong in one specific, important way. A persona line is owner-authored YAML
 * under review. A skill's `trigger`/`title` are authored BY THE MODEL at
 * runtime, unreviewed, and were being concatenated into the system prompt
 * verbatim. The audit filed a skill whose trigger carried newlines, markdown
 * rules, bold headers and a forged "SYSTEM OVERRIDE" paragraph — all of which
 * rendered intact, and which ran past the `*(provisional)*` marker so that the
 * one label meant to mark a skill as unproven ended up orphaned on its own
 * line. Persistent, every turn.
 *
 * The tool-grant invariant was never at risk (capability checks are code, and
 * prose cannot reach them). What was at risk is the prompt's own structure. So
 * every model-authored string that reaches the prompt goes through here:
 * single line, no markdown structure characters that could forge a heading or
 * a rule, hard length cap. Content is preserved; STRUCTURE is not.
 */
export function flatten_for_prompt(s: string, max = 240): string {
  return s
    .replace(/[\r\n\t]+/g, ' ')
    // Leading markdown structure (#, >, -, *, =, |) can forge a heading, a
    // rule, a quote, or a table row mid-block. Strip it wherever it appears
    // after whitespace, not just at the string start.
    .replace(/(^|\s)[#>|=*_~`-]{2,}/g, '$1')
    .replace(/(^|\s)[#>|]/g, '$1')
    // Backticks would let a trigger close the code span the renderer opens.
    .replace(/`/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** Lifecycle. `shadow` renders as provisional; `retired` never renders. */
export type SkillStatus = 'shadow' | 'active' | 'retired';

/** One step of a recipe. Names an EXISTING tool — never a new capability. */
export interface SkillStep {
  /** A tool name the owning specialist is already granted. */
  tool: string;
  /** Why this step exists, one line. */
  purpose: string;
  /** How to fill the args — PROSE, never literal values (a skill that hardcodes
   *  an id is a cached answer, not a procedure). */
  args_note?: string;
}

export interface Skill {
  id: string;
  specialist_id: string;
  /** Stable kebab slug — the `recall_skill` key. Unique per specialist. */
  name: string;
  /** One-line human title. */
  title: string;
  /** WHEN to reach for this. The only field the awareness block renders. */
  trigger: string;
  steps: SkillStep[];
  /** How you know it actually worked — the completion check, in prose. */
  verification: string;
  status: SkillStatus;
  /** Where it came from: `conversation:<id>` / `eval:<task_id>`. */
  learned_from: string;
  invocations: number;
  successes: number;
  dismissals: number;
  ts_created: string;
  ts_last_used: string | null;
}

export type NewSkill = Pick<
  Skill,
  'specialist_id' | 'name' | 'title' | 'trigger' | 'steps' | 'verification' | 'learned_from'
>;

/* ------------------------------------------------------------------ */
/* Limits + kill switch                                                */
/* ------------------------------------------------------------------ */

/** Successful recorded uses before a shadow skill graduates to active. */
export const SHADOW_GRADUATION_USES = 3;

/** Dismissals that auto-retire a skill, at any status. */
export const AUTO_REVOKE_DISMISSALS = 2;

/** Library cap per specialist. Past this, learning REFUSES and names the
 *  coldest skill — an unbounded library is the failure mode Hermes's Curator
 *  exists to mop up, and refusing is cheaper than mopping. */
export const MAX_SKILLS_PER_SPECIALIST = 24;

/** A recipe longer than this is a workflow, not a skill — it belongs in code. */
export const MAX_STEPS = 12;

/** Below this many steps there is no procedure to remember — a one-call answer
 *  is what tools are FOR. (Hermes triggers skill capture at ~5 calls; we take
 *  3 because Hearth's tools are coarser.) */
export const MIN_STEPS = 3;

export function skills_enabled(): boolean {
  return process.env.HEARTH_SKILLS !== '0';
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface SkillValidation {
  ok: boolean;
  /** Human-readable, model-facing — this text goes back as the tool error. */
  problems: string[];
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Is this a legal skill for this specialist RIGHT NOW?
 *
 * `granted_tools` is the specialist's live granted tool-name set. Every step
 * must name one. This is the capability invariant in code: a skill can only
 * ever describe a path the specialist could already have walked.
 */
export function validate_skill(
  skill: NewSkill,
  granted_tools: ReadonlySet<string>,
  existing_count: number,
): SkillValidation {
  const problems: string[] = [];

  if (!SLUG_RE.test(skill.name)) {
    problems.push(`name '${skill.name}' must be a kebab-case slug (a-z, 0-9, hyphens).`);
  }
  if (skill.trigger.trim().length < 15) {
    problems.push('trigger must say WHEN to reach for this — one specific sentence, not a label.');
  }
  if (skill.verification.trim().length < 15) {
    problems.push(
      'verification must say how you KNOW it worked (what you re-read, what the result should show).',
    );
  }
  if (skill.steps.length < MIN_STEPS) {
    problems.push(
      `a ${skill.steps.length}-step recipe is not a procedure — skills start at ${MIN_STEPS} steps. ` +
        'A single call is what the tool itself is for.',
    );
  }
  if (skill.steps.length > MAX_STEPS) {
    problems.push(
      `${skill.steps.length} steps is a workflow, not a skill (cap ${MAX_STEPS}). ` +
        'Split it, or file a build request for real tool code.',
    );
  }
  if (existing_count >= MAX_SKILLS_PER_SPECIALIST) {
    problems.push(
      `you already hold ${existing_count} skills (cap ${MAX_SKILLS_PER_SPECIALIST}). ` +
        'Retire a cold one before learning another.',
    );
  }

  // THE capability invariant. Reported per-step so the model can fix the recipe
  // rather than guess which line offended.
  for (const [i, step] of skill.steps.entries()) {
    if (!granted_tools.has(step.tool)) {
      problems.push(
        `step ${i + 1} names '${step.tool}', which is not a tool you can call. ` +
          'A skill may only sequence tools you already hold.',
      );
    }
    if (step.purpose.trim().length < 8) {
      problems.push(`step ${i + 1} needs a purpose — why this call, in one line.`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/** What a recorded outcome does to a skill's status. Pure — the store applies it. */
export function next_status(skill: Pick<Skill, 'status' | 'successes' | 'dismissals'>): SkillStatus {
  if (skill.dismissals >= AUTO_REVOKE_DISMISSALS) return 'retired';
  if (skill.status === 'shadow' && skill.successes >= SHADOW_GRADUATION_USES) return 'active';
  return skill.status;
}

/**
 * The coldest skill — what `learn_skill` names when the library is full.
 * Never-used sorts before used; among used, oldest last-use wins. Deterministic
 * tie-break on name so the message doesn't flap between identical candidates.
 */
export function coldest_skill<T extends Pick<Skill, 'name' | 'invocations' | 'ts_last_used'>>(
  skills: readonly T[],
): T | null {
  if (skills.length === 0) return null;
  return [...skills].sort((a, b) => {
    if (a.invocations !== b.invocations) return a.invocations - b.invocations;
    const at = a.ts_last_used ?? '';
    const bt = b.ts_last_used ?? '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  })[0]!;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/**
 * The always-on awareness block: one line per renderable skill, plus the
 * pointer to `recall_skill`. Mirrors the dynamic-tool catalog — name +
 * trigger is enough to decide whether to pull the body.
 *
 * Returns '' when there is nothing to say, so the caller can concatenate
 * unconditionally without leaving a stray heading in the prompt.
 */
export function render_skill_awareness(skills: readonly Skill[]): string {
  const live = skills.filter((s) => s.status !== 'retired');
  if (live.length === 0) return '';
  const lines = live
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((s) => {
      // Provisional marker FIRST, so no amount of trigger text can push it off
      // its own line or orphan it (the audit's exact failure). Both fields are
      // flattened — they are model-authored and this is a system prompt.
      const provisional = s.status === 'shadow' ? '*(provisional)* ' : '';
      return `- \`${flatten_for_prompt(s.name, 60)}\` — ${provisional}${flatten_for_prompt(s.trigger)}`;
    });
  return (
    `**Procedures you have worked out before.** These are your own notes from ` +
    `solving something the long way — not rules, and not new abilities. Each one ` +
    `sequences tools you already hold. When the situation below matches, call ` +
    `\`recall_skill\` with the name to read the steps before you start; you still ` +
    `make every call yourself.\n\n${lines.join('\n')}`
  );
}

/**
 * The full body, pulled on demand. Steps naming a tool the specialist can no
 * longer call are rendered STRUCK with a warning rather than silently dropped:
 * a procedure with a hole in it is still useful context, and hiding the hole is
 * how a model ends up confidently walking off the end of a revoked grant.
 */
export function render_skill_body(skill: Skill, granted_tools: ReadonlySet<string>): string {
  const out: string[] = [];
  // Every model-authored field is flattened — see flatten_for_prompt. The body
  // reaches the prompt too (via recall_skill's result), so it is exactly as
  // injectable as the awareness block if left raw.
  out.push(`### ${flatten_for_prompt(skill.title, 120)}`);
  out.push('');
  out.push(`**When:** ${flatten_for_prompt(skill.trigger)}`);
  out.push('');
  if (skill.status === 'shadow') {
    out.push(
      `> Provisional — worked out ${skill.invocations === 0 ? 'once' : `${skill.invocations} time(s)`} ` +
        `and not yet proven. Follow it if it fits; abandon it the moment it doesn't, ` +
        `and say so rather than forcing the shape.`,
    );
    out.push('');
  }
  out.push('**Steps:**');
  let ungranted = 0;
  for (const [i, step] of skill.steps.entries()) {
    const ok = granted_tools.has(step.tool);
    if (!ok) ungranted++;
    const purpose = flatten_for_prompt(step.purpose, 200);
    const head = ok
      ? `${i + 1}. \`${step.tool}\` — ${purpose}`
      : `${i + 1}. ~~\`${step.tool}\`~~ — ${purpose} **(you can no longer call this — skip it and say what you couldn't do)**`;
    out.push(head);
    if (step.args_note) out.push(`   - ${flatten_for_prompt(step.args_note, 200)}`);
  }
  out.push('');
  out.push(`**Done when:** ${flatten_for_prompt(skill.verification)}`);
  if (ungranted > 0) {
    out.push('');
    out.push(
      `> ${ungranted} step(s) reference a tool you no longer hold. This procedure is ` +
        `stale — do the part you can, and report the gap rather than improvising around it.`,
    );
  }
  return out.join('\n');
}
