/**
 * SkillsStore — the procedural-memory ledger (2026-08-03).
 *
 * One row per skill a specialist has worked out and written down. The shape,
 * legality, lifecycle rules, and rendering all live in `@core/skills` (pure);
 * this file is persistence and nothing else.
 *
 * Rows are per-specialist and never shared: a skill Kate worked out is Kate's,
 * because the capability invariant that makes skills safe (`validate_skill`
 * checks every step against the OWNER's granted tools) is only meaningful
 * against one specialist's grants. Cross-specialist reuse would need a
 * re-validation pass that does not exist yet — see the design doc's "not built"
 * list rather than assuming it works.
 *
 * `steps_json` rather than a child table: steps are read and written as one
 * unit, always, and a skill with a dangling step row is worse than a skill with
 * a corrupt blob (the blob fails loudly at hydrate; the dangle renders a hole).
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import {
  next_status,
  type NewSkill,
  type Skill,
  type SkillStatus,
  type SkillStep,
} from '@core/skills';

interface RawRow {
  id: string;
  specialist_id: string;
  name: string;
  title: string;
  trigger_text: string;
  steps_json: string;
  verification: string;
  status: string;
  learned_from: string;
  invocations: number;
  successes: number;
  dismissals: number;
  ts_created: string;
  ts_last_used: string | null;
}

function hydrate(r: RawRow): Skill {
  let steps: SkillStep[] = [];
  try {
    const parsed = JSON.parse(r.steps_json) as unknown;
    // Guard the ELEMENTS, not just the parse. A blob that parses to an array of
    // strings/nulls would otherwise reach the renderer, where `step.tool` is
    // undefined — `granted_tools.has(undefined)` is false, so it renders as a
    // struck "you can no longer call this" step rather than admitting the row
    // is corrupt. Filtering here keeps a bad row from impersonating a revoked
    // grant.
    if (Array.isArray(parsed)) {
      steps = (parsed as unknown[]).filter(
        (s): s is SkillStep =>
          typeof s === 'object' && s !== null &&
          typeof (s as SkillStep).tool === 'string' &&
          typeof (s as SkillStep).purpose === 'string',
      );
    }
  } catch {
    /* A corrupt blob yields a 0-step skill. `render_skill_body` shows an empty
     * recipe rather than throwing mid-prompt-build — a bad row must never take
     * a turn down with it. */
  }
  return {
    id: r.id,
    specialist_id: r.specialist_id,
    name: r.name,
    title: r.title,
    trigger: r.trigger_text,
    steps,
    verification: r.verification,
    status: r.status as SkillStatus,
    learned_from: r.learned_from,
    invocations: r.invocations,
    successes: r.successes,
    dismissals: r.dismissals,
    ts_created: r.ts_created,
    ts_last_used: r.ts_last_used,
  };
}

export class SkillsStore {
  constructor(private db: Database) {}

  /** Everything a specialist holds, retired included (the Curator's view). */
  all_for(specialist_id: string): Skill[] {
    return (
      this.db
        .prepare(`SELECT * FROM skills WHERE specialist_id = @s ORDER BY name ASC`)
        .all({ '@s': specialist_id }) as RawRow[]
    ).map(hydrate);
  }

  /** What renders into a prompt — shadow + active, never retired. */
  live_for(specialist_id: string): Skill[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM skills
            WHERE specialist_id = @s AND status != 'retired'
            ORDER BY name ASC`,
        )
        .all({ '@s': specialist_id }) as RawRow[]
    ).map(hydrate);
  }

  get(specialist_id: string, name: string): Skill | null {
    const r = this.db
      .prepare(`SELECT * FROM skills WHERE specialist_id = @s AND name = @n`)
      .get({ '@s': specialist_id, '@n': name }) as RawRow | undefined;
    return r ? hydrate(r) : null;
  }

  count_live(specialist_id: string): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM skills WHERE specialist_id = @s AND status != 'retired'`,
      )
      .get({ '@s': specialist_id }) as { n: number };
    return r.n;
  }

  /**
   * Write a new skill, born `shadow`. Re-learning an existing NAME overwrites
   * the recipe and RESETS the ladder to shadow — a rewritten procedure has not
   * earned the old one's track record, and inheriting it is how a good skill's
   * reputation launders a bad edit.
   *
   * NOTE: this will happily resurrect a RETIRED name, which would make
   * `AUTO_REVOKE_DISMISSALS` toothless. The refusal lives at the `learn_skill`
   * tool (its only caller), where the model can be told why. Anything else
   * calling this directly must make the same check — or, better, call through
   * the tool.
   */
  create(skill: NewSkill, now = new Date()): string {
    const existing = this.get(skill.specialist_id, skill.name);
    const id = existing?.id ?? `sk_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO skills
           (id, specialist_id, name, title, trigger_text, steps_json, verification,
            status, learned_from, invocations, successes, dismissals, ts_created, ts_last_used)
         VALUES (@id, @s, @n, @t, @trig, @steps, @ver, 'shadow', @from, 0, 0, 0, @ts, NULL)
         ON CONFLICT (specialist_id, name) DO UPDATE SET
           title = @t, trigger_text = @trig, steps_json = @steps, verification = @ver,
           status = 'shadow', learned_from = @from,
           invocations = 0, successes = 0, dismissals = 0, ts_created = @ts, ts_last_used = NULL`,
      )
      .run({
        '@id': id,
        '@s': skill.specialist_id,
        '@n': skill.name,
        '@t': skill.title.slice(0, 200),
        '@trig': skill.trigger.slice(0, 1_000),
        '@steps': JSON.stringify(skill.steps),
        '@ver': skill.verification.slice(0, 1_000),
        '@from': skill.learned_from.slice(0, 200),
        '@ts': now.toISOString(),
      });
    return id;
  }

  /**
   * Record what happened when a skill was recalled. `outcome` is the model's
   * own report, which is exactly why a 'success' is worth only one rung and a
   * 'dismissed' is worth a retirement at 2 — the cheap direction to be wrong in
   * is dropping a good skill, not keeping a bad one.
   *
   * Returns the status AFTER the update so a caller can tell the model it just
   * graduated (or lost) a skill.
   */
  record_outcome(
    specialist_id: string,
    name: string,
    outcome: 'success' | 'partial' | 'dismissed',
    now = new Date(),
  ): SkillStatus | null {
    const current = this.get(specialist_id, name);
    if (!current) return null;
    const successes = current.successes + (outcome === 'success' ? 1 : 0);
    const dismissals = current.dismissals + (outcome === 'dismissed' ? 1 : 0);
    const status = next_status({ status: current.status, successes, dismissals });
    this.db
      .prepare(
        `UPDATE skills
            SET invocations = invocations + 1,
                successes = @suc, dismissals = @dis, status = @st, ts_last_used = @ts
          WHERE specialist_id = @s AND name = @n`,
      )
      .run({
        '@suc': successes,
        '@dis': dismissals,
        '@st': status,
        '@ts': now.toISOString(),
        '@s': specialist_id,
        '@n': name,
      });
    return status;
  }

  /** Explicit retirement (the owner's call, or the model retiring its own). */
  retire(specialist_id: string, name: string): boolean {
    const res = this.db
      .prepare(`UPDATE skills SET status = 'retired' WHERE specialist_id = @s AND name = @n`)
      .run({ '@s': specialist_id, '@n': name });
    return res.changes > 0;
  }
}
