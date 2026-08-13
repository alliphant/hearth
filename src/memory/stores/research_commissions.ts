/**
 * ResearchCommissionStore — durable state for Cordelia's deep-research
 * commissions (2026-06-11).
 *
 * A commission is a multi-phase repository build: "make Astrid's shelf
 * authoritative on bicycle + e-bike repair, seeded with this service
 * manual." Too big for one tool call, so the runner
 * (src/specialists/cordelia/research_runner.ts) advances a commission in
 * bounded slices and persists progress here after every shelved
 * document — a restart resumes mid-subtopic instead of starting over.
 *
 * Status machine:
 *   pending → acquiring → synthesizing → done
 *                  ↘ failed (terminal, carries `error`)
 *   cancelled is terminal and only ever set by hand (no tool sets it
 *   today; the column exists so an operator UPDATE is honest state, not
 *   a deleted row).
 *
 * JSON columns (parsed defensively — a corrupt blob degrades to the
 * empty default, never throws):
 *   plan_json     CommissionPlan — the planner's subtopic decomposition
 *   state_json    CommissionRunState — runner cursors, judged domains,
 *                 seen URLs, capped progress log
 *   shelved_json  ShelvedDoc[] — what landed on the target's shelf
 *   proposed_json ProposedDomain[] — trusted_source_addition follow-ups
 *   skipped_json  SkippedDoc[] — capped; reasons for the report
 */
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';

export type CommissionStatus =
  | 'pending'
  | 'acquiring'
  | 'synthesizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export type CommissionDepth = 'standard' | 'deep';

/** Statuses the runner will still advance. */
export const OPEN_STATUSES: readonly CommissionStatus[] = [
  'pending',
  'acquiring',
  'synthesizing',
];

export interface CommissionSubtopic {
  title: string;
  /** 1-2 search queries, phrased as a user would ask. */
  queries: string[];
  rationale?: string;
}

export interface CommissionPlan {
  subtopics: CommissionSubtopic[];
}

export interface JudgedDomain {
  tier: 1 | 2;
  avg: number;
  reason: string;
  suggested_cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly';
}

export interface CommissionRunState {
  /** Seed URLs are processed before any subtopic. */
  seeds_done?: boolean;
  /** Index into plan.subtopics of the next subtopic to work. */
  subtopic_cursor?: number;
  /** URLs already fetched or deliberately skipped this commission. */
  seen_urls?: string[];
  /** Out-of-roster domains the source judge cleared (domain → verdict). */
  judged_domains?: Record<string, JudgedDomain>;
  /** Out-of-roster domains the judge scored below the floor. */
  rejected_domains?: string[];
  /** Set when the judge was unreachable last slice — roster-only mode. */
  judge_down?: boolean;
  /** Consecutive errored slices; MAX_ERROR_STREAK of them → failed. */
  error_streak?: number;
  /** Capped human-readable progress trail for the status tool. */
  log?: string[];
}

export interface ShelvedDoc {
  url: string;
  title: string;
  wrapper_note_path: string;
  trust_tier: 1 | 2 | null;
  subtopic: string;
}

export interface ProposedDomain {
  domain: string;
  proposal_id: string;
  suggested_tier: 1 | 2;
}

export interface SkippedDoc {
  url: string;
  reason: string;
  subtopic: string;
}

export interface CommissionRow {
  id: string;
  target_specialist_id: string;
  title: string;
  brief: string;
  seed_urls: string[];
  depth: CommissionDepth;
  status: CommissionStatus;
  requested_by: string | null;
  private_to: string | null;
  plan: CommissionPlan | null;
  state: CommissionRunState;
  shelved: ShelvedDoc[];
  proposed: ProposedDomain[];
  skipped: SkippedDoc[];
  index_note_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RawRow {
  id: string;
  target_specialist_id: string;
  title: string;
  brief: string;
  seed_urls: string;
  depth: string;
  status: string;
  requested_by: string | null;
  private_to: string | null;
  plan_json: string | null;
  state_json: string;
  shelved_json: string;
  proposed_json: string;
  skipped_json: string;
  index_note_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function parse_json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function to_row(raw: RawRow): CommissionRow {
  return {
    id: raw.id,
    target_specialist_id: raw.target_specialist_id,
    title: raw.title,
    brief: raw.brief,
    seed_urls: parse_json<string[]>(raw.seed_urls, []),
    depth: raw.depth === 'deep' ? 'deep' : 'standard',
    status: (
      ['pending', 'acquiring', 'synthesizing', 'done', 'failed', 'cancelled'] as const
    ).includes(raw.status as CommissionStatus)
      ? (raw.status as CommissionStatus)
      : 'failed',
    requested_by: raw.requested_by,
    private_to: raw.private_to,
    plan: parse_json<CommissionPlan | null>(raw.plan_json, null),
    state: parse_json<CommissionRunState>(raw.state_json, {}),
    shelved: parse_json<ShelvedDoc[]>(raw.shelved_json, []),
    proposed: parse_json<ProposedDomain[]>(raw.proposed_json, []),
    skipped: parse_json<SkippedDoc[]>(raw.skipped_json, []),
    index_note_path: raw.index_note_path,
    error: raw.error,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    completed_at: raw.completed_at,
  };
}

/** Opaque 12-char id with the rc_ type prefix (mirrors ap_/sch_). */
function new_commission_id(): string {
  const alphabet = 'abcdefghjkmnpqrstvwxyz0123456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `rc_${out}`;
}

export interface CreateCommissionInput {
  target_specialist_id: string;
  title: string;
  brief: string;
  seed_urls?: string[];
  depth?: CommissionDepth;
  requested_by?: string | null;
  private_to?: string | null;
}

export class ResearchCommissionStore {
  constructor(private db: Database) {}

  create(input: CreateCommissionInput): CommissionRow {
    const now = new Date().toISOString();
    const id = new_commission_id();
    this.db
      .prepare(
        `INSERT INTO research_commissions
           (id, target_specialist_id, title, brief, seed_urls, depth, status,
            requested_by, private_to, state_json, shelved_json, proposed_json,
            skipped_json, created_at, updated_at)
         VALUES (@id, @target, @title, @brief, @seeds, @depth, 'pending',
                 @requested_by, @private_to, '{}', '[]', '[]', '[]', @now, @now)`,
      )
      .run({
        '@id': id,
        '@target': input.target_specialist_id,
        '@title': input.title,
        '@brief': input.brief,
        '@seeds': JSON.stringify(input.seed_urls ?? []),
        '@depth': input.depth ?? 'standard',
        '@requested_by': input.requested_by ?? null,
        '@private_to': input.private_to ?? null,
        '@now': now,
      });
    const row = this.get(id);
    if (!row) throw new Error(`research_commissions: insert of ${id} not readable back`);
    return row;
  }

  get(id: string): CommissionRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM research_commissions WHERE id = @id`)
      .get({ '@id': id }) as RawRow | null;
    return raw ? to_row(raw) : null;
  }

  list(opts: { statuses?: readonly CommissionStatus[]; limit?: number } = {}): CommissionRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    let rows: RawRow[];
    if (opts.statuses && opts.statuses.length > 0) {
      const placeholders = opts.statuses.map(() => '?').join(', ');
      rows = this.db
        .prepare(
          `SELECT * FROM research_commissions
            WHERE status IN (${placeholders})
            ORDER BY created_at ASC LIMIT ?`,
        )
        .all(...opts.statuses, limit) as RawRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM research_commissions ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit) as RawRow[];
    }
    return rows.map(to_row);
  }

  /**
   * Re-file collapse (mirrors the proposals-inflow contract): an OPEN
   * commission for the same target with the same normalized brief is the
   * same ask — return it instead of minting a twin.
   */
  find_open_duplicate(target_specialist_id: string, brief: string): CommissionRow | null {
    const norm = brief.trim().toLowerCase().replace(/\s+/g, ' ');
    for (const row of this.list({ statuses: OPEN_STATUSES, limit: 50 })) {
      if (row.target_specialist_id !== target_specialist_id) continue;
      if (row.brief.trim().toLowerCase().replace(/\s+/g, ' ') === norm) return row;
    }
    return null;
  }

  /**
   * Persist a partial update. Only the provided fields change;
   * updated_at always bumps. Terminal statuses stamp completed_at.
   */
  update(
    id: string,
    patch: Partial<{
      status: CommissionStatus;
      plan: CommissionPlan;
      state: CommissionRunState;
      shelved: ShelvedDoc[];
      proposed: ProposedDomain[];
      skipped: SkippedDoc[];
      index_note_path: string;
      error: string | null;
    }>,
  ): void {
    const sets: string[] = ['updated_at = @now'];
    const binds: Record<string, unknown> = { '@id': id, '@now': new Date().toISOString() };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      binds['@status'] = patch.status;
      if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'cancelled') {
        sets.push('completed_at = @completed');
        binds['@completed'] = new Date().toISOString();
      }
    }
    if (patch.plan !== undefined) {
      sets.push('plan_json = @plan');
      binds['@plan'] = JSON.stringify(patch.plan);
    }
    if (patch.state !== undefined) {
      sets.push('state_json = @state');
      binds['@state'] = JSON.stringify(patch.state);
    }
    if (patch.shelved !== undefined) {
      sets.push('shelved_json = @shelved');
      binds['@shelved'] = JSON.stringify(patch.shelved);
    }
    if (patch.proposed !== undefined) {
      sets.push('proposed_json = @proposed');
      binds['@proposed'] = JSON.stringify(patch.proposed);
    }
    if (patch.skipped !== undefined) {
      sets.push('skipped_json = @skipped');
      binds['@skipped'] = JSON.stringify(patch.skipped);
    }
    if (patch.index_note_path !== undefined) {
      sets.push('index_note_path = @index_path');
      binds['@index_path'] = patch.index_note_path;
    }
    if (patch.error !== undefined) {
      sets.push('error = @error');
      binds['@error'] = patch.error;
    }
    this.db
      .prepare(`UPDATE research_commissions SET ${sets.join(', ')} WHERE id = @id`)
      .run(binds as never);
  }
}
