/**
 * LlmRoleOverrideStore — make the model behind a role revertible in ONE call
 * (2026-08-01).
 *
 * THE PROBLEM. `config/llm-roles.yaml` is read ONCE, by `readFileSync` in the
 * `ConfigLLMRouter` constructor, with no chokidar watcher (unlike
 * SpecialistRegistry). So changing which model serves a role — the single most
 * consequential automated change the system can make to itself — required
 * `docker compose restart hearth-orchestrator`. "Instant model revert" was not
 * merely slow, it was structurally impossible: the thing you would want to undo
 * fastest was the thing that took a restart to undo at all.
 *
 * THE SHAPE. A store-backed override the router consults BEFORE the YAML, so
 * applying is a write and reverting is a write. The YAML remains the base and
 * the source of truth in git; an override is an explicitly temporary layer that
 * knows what it displaced (`prev_json`) and can always be lifted.
 *
 * WHY NOT A CHOKIDAR WATCHER ON THE YAML. It would make a pull change the live
 * model as a side effect of deploying unrelated code, which is a far worse
 * default than a restart. And it gives you no revert primitive — you would be
 * back to editing a file under time pressure. The override layer is additive
 * and leaves the deploy semantics of the YAML exactly as they are.
 *
 * ONE ACTIVE OVERRIDE PER ROLE. `reverted_at IS NULL` is the active predicate;
 * applying a second one auto-reverts the first, so the layer can never become a
 * stack nobody can reason about under pressure.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

/** The subset of a role's config an override may replace. */
export interface RoleOverridePatch {
  model?: string;
  base_url?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
  think?: boolean;
  concurrent?: boolean;
  max_concurrency?: number;
  context_window_tokens?: number;
}

export interface RoleOverrideRow {
  id: string;
  role: string;
  patch: RoleOverridePatch;
  /** The effective config at the moment it was applied — the revert record. */
  prev: Record<string, unknown> | null;
  reason: string;
  applied_by: string;
  applied_at: string;
  reverted_at: string | null;
  reverted_by: string | null;
}

interface RawRow {
  id: string;
  role: string;
  patch_json: string;
  prev_json: string | null;
  reason: string;
  applied_by: string;
  applied_at: string;
  reverted_at: string | null;
  reverted_by: string | null;
}

function hydrate(r: RawRow): RoleOverrideRow {
  let patch: RoleOverridePatch = {};
  try {
    patch = JSON.parse(r.patch_json) as RoleOverridePatch;
  } catch {
    /* a corrupt patch reads as empty — fail toward the base config */
  }
  let prev: Record<string, unknown> | null = null;
  if (r.prev_json) {
    try {
      prev = JSON.parse(r.prev_json) as Record<string, unknown>;
    } catch {
      prev = null;
    }
  }
  return {
    id: r.id,
    role: r.role,
    patch,
    prev,
    reason: r.reason,
    applied_by: r.applied_by,
    applied_at: r.applied_at,
    reverted_at: r.reverted_at,
    reverted_by: r.reverted_by,
  };
}

export class LlmRoleOverrideStore {
  constructor(private db: Database) {}

  /** Every currently-active override, keyed by role. Sync — the router's
   *  `for_role()` is sync and sits on the hot path. */
  active_map(): Map<string, RoleOverridePatch> {
    const rows = this.db
      .prepare(`SELECT * FROM llm_role_overrides WHERE reverted_at IS NULL`)
      .all() as RawRow[];
    const out = new Map<string, RoleOverridePatch>();
    for (const r of rows) out.set(r.role, hydrate(r).patch);
    return out;
  }

  active_for(role: string): RoleOverrideRow | null {
    const row = this.db
      .prepare(`SELECT * FROM llm_role_overrides WHERE role = @r AND reverted_at IS NULL LIMIT 1`)
      .get({ '@r': role }) as RawRow | null;
    // bun:sqlite returns null (not undefined) for no row.
    return row != null ? hydrate(row) : null;
  }

  /**
   * Apply an override, auto-reverting any active one for the same role so the
   * layer stays exactly one deep.
   */
  apply(input: {
    role: string;
    patch: RoleOverridePatch;
    prev?: Record<string, unknown> | null;
    reason: string;
    applied_by: string;
    now?: Date;
  }): RoleOverrideRow {
    const now = (input.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `UPDATE llm_role_overrides
            SET reverted_at = @now, reverted_by = @by
          WHERE role = @r AND reverted_at IS NULL`,
      )
      .run({ '@now': now, '@by': `superseded:${input.applied_by}`, '@r': input.role });

    const id = `lro_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO llm_role_overrides
           (id, role, patch_json, prev_json, reason, applied_by, applied_at)
         VALUES (@id, @r, @patch, @prev, @reason, @by, @at)`,
      )
      .run({
        '@id': id,
        '@r': input.role,
        '@patch': JSON.stringify(input.patch),
        '@prev': input.prev ? JSON.stringify(input.prev) : null,
        '@reason': input.reason.slice(0, 2000),
        '@by': input.applied_by,
        '@at': now,
      });
    return this.active_for(input.role)!;
  }

  /** Lift the active override for a role. Returns what was reverted, or null. */
  revert(role: string, by: string, now?: Date): RoleOverrideRow | null {
    const active = this.active_for(role);
    if (!active) return null;
    this.db
      .prepare(`UPDATE llm_role_overrides SET reverted_at = @now, reverted_by = @by WHERE id = @id`)
      .run({ '@now': (now ?? new Date()).toISOString(), '@by': by, '@id': active.id });
    return active;
  }

  /** History for a role (or all), newest first — the audit trail of what was
   *  tried and what was lifted. */
  history(opts: { role?: string; limit?: number } = {}): RoleOverrideRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const rows = opts.role
      ? (this.db
          .prepare(`SELECT * FROM llm_role_overrides WHERE role = @r ORDER BY applied_at DESC LIMIT @lim`)
          .all({ '@r': opts.role, '@lim': limit }) as RawRow[])
      : (this.db
          .prepare(`SELECT * FROM llm_role_overrides ORDER BY applied_at DESC LIMIT @lim`)
          .all({ '@lim': limit }) as RawRow[]);
    return rows.map(hydrate);
  }
}
