/**
 * MediaArchiveJobStore — the Media Archive runner ledger.
 *
 * A self-contained job queue (NOT a projected vault note — mirrors
 * ResearchInvestigationStore), one row per archive_url request. The detached
 * MediaArchiveRunner advances a row through its status machine; each phase
 * persists its output as a *_json column so a crash resumes from the last
 * committed phase. The table lives in structured.ts SCHEMA_SQL; reach the store
 * via `memory.media_jobs`.
 *
 * RETIRED 2026-07-29 — two columns this store no longer writes or reads:
 * `requester_tier` (recorded for a cordon that no longer consults tier at all —
 * `private_to` is the requester, @core/media/cordon — so it had zero readers) and
 * `force_owner_only` (the retired archive_url slot; see that file's header for why
 * it wasn't re-founded). Both are gone from SCHEMA_SQL, so a fresh database has
 * neither; an existing one keeps them as inert leftovers (`requester_tier` is
 * nullable and `force_owner_only` has a DEFAULT, so the INSERT below is valid
 * against both shapes). Deliberately NOT dropped by migration: `ALTER TABLE DROP
 * COLUMN` at boot is the failure class the boot-only-errors memory warns about,
 * and a column nothing writes is harmless where a broken boot is not.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { note_visible_to_caller, type Caller } from '../private_to';

export type MediaJobStatus =
  | 'pending'
  | 'probing'
  | 'classifying'
  | 'downloading'
  | 'filing'
  | 'indexing'
  | 'done'
  | 'failed'
  | 'cancelled';

/** The still-advancing statuses — the runner + sweep keep working these. */
export const OPEN_MEDIA_JOB_STATUSES: readonly MediaJobStatus[] = [
  'pending',
  'probing',
  'classifying',
  'downloading',
  'filing',
  'indexing',
];

const TERMINAL_MEDIA_JOB_STATUSES: readonly MediaJobStatus[] = ['done', 'failed', 'cancelled'];

/** Per-row runner scratch state (persisted as state_json). */
export interface MediaJobRunState {
  error_streak?: number;
  log?: string[];
}

export interface MediaJobRow {
  id: string;
  url: string;
  status: MediaJobStatus;
  requested_by: string | null;
  private_to: string | null;
  conversation_id: string | null;
  user_note: string | null;
  quality_override: string | null;
  audio_only: number; // 0 | 1
  state: MediaJobRunState;
  probe: unknown | null;
  category: unknown | null;
  quality: unknown | null;
  download: unknown | null;
  nsfw: unknown | null;
  media_item_id: string | null;
  note_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateMediaJobInput {
  url: string;
  requested_by?: string | null;
  private_to?: string | null;
  conversation_id?: string | null;
  user_note?: string | null;
  quality_override?: string | null;
  audio_only?: boolean;
}

interface RawJobRow {
  id: string;
  url: string;
  status: string;
  requested_by: string | null;
  private_to: string | null;
  conversation_id: string | null;
  user_note: string | null;
  quality_override: string | null;
  audio_only: number;
  state_json: string | null;
  probe_json: string | null;
  category_json: string | null;
  quality_json: string | null;
  download_json: string | null;
  nsfw_json: string | null;
  media_item_id: string | null;
  note_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function parse_json<T>(raw: string | null, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class MediaArchiveJobStore {
  constructor(private db: Database) {}

  private hydrate(r: RawJobRow): MediaJobRow {
    return {
      id: r.id,
      url: r.url,
      status: r.status as MediaJobStatus,
      requested_by: r.requested_by,
      private_to: r.private_to,
      conversation_id: r.conversation_id,
      user_note: r.user_note,
      quality_override: r.quality_override,
      audio_only: r.audio_only,
      state: parse_json<MediaJobRunState>(r.state_json, {}),
      probe: parse_json<unknown>(r.probe_json, null),
      category: parse_json<unknown>(r.category_json, null),
      quality: parse_json<unknown>(r.quality_json, null),
      download: parse_json<unknown>(r.download_json, null),
      nsfw: parse_json<unknown>(r.nsfw_json, null),
      media_item_id: r.media_item_id,
      note_path: r.note_path,
      error: r.error,
      created_at: r.created_at,
      updated_at: r.updated_at,
      completed_at: r.completed_at,
    };
  }

  create(input: CreateMediaJobInput): MediaJobRow {
    const id = `ma_${ulid().toLowerCase().slice(-12)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO media_archive_jobs
         (id, url, status, requested_by, private_to, conversation_id, user_note,
          quality_override, audio_only, created_at, updated_at)
         VALUES
         (@id, @url, 'pending', @requested_by, @private_to, @conversation_id, @user_note,
          @quality_override, @audio_only, @created_at, @updated_at)`,
      )
      .run({
        '@id': id,
        '@url': input.url,
        '@requested_by': input.requested_by ?? null,
        '@private_to': input.private_to ?? null,
        '@conversation_id': input.conversation_id ?? null,
        '@user_note': input.user_note ?? null,
        '@quality_override': input.quality_override ?? null,
        '@audio_only': input.audio_only ? 1 : 0,
        '@created_at': now,
        '@updated_at': now,
      });
    const row = this.get(id);
    if (!row) throw new Error('media_archive_jobs: row not re-readable after insert');
    return row;
  }

  get(id: string): MediaJobRow | null {
    const r = this.db
      .prepare('SELECT * FROM media_archive_jobs WHERE id = @id')
      .get({ '@id': id }) as RawJobRow | undefined;
    return r != null ? this.hydrate(r) : null;
  }

  list(opts?: {
    statuses?: readonly MediaJobStatus[];
    requested_by?: string;
    limit?: number;
  }): MediaJobRow[] {
    const clauses: string[] = [];
    const params: Record<string, string | number> = {};
    if (opts?.statuses && opts.statuses.length > 0) {
      const placeholders = opts.statuses.map((_, i) => `@s${i}`);
      opts.statuses.forEach((s, i) => {
        params[`@s${i}`] = s;
      });
      clauses.push(`status IN (${placeholders.join(', ')})`);
    }
    if (opts?.requested_by) {
      clauses.push('requested_by = @rb');
      params['@rb'] = opts.requested_by;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    // Open-status sweeps drain oldest-first (fair); default is newest-first.
    const order = opts?.statuses ? 'created_at ASC' : 'created_at DESC';
    const rows = this.db
      .prepare(`SELECT * FROM media_archive_jobs ${where} ORDER BY ${order}`)
      .all(params) as RawJobRow[];
    const out = rows.map((r) => this.hydrate(r));
    return opts?.limit ? out.slice(0, opts.limit) : out;
  }

  /**
   * Cordoned list for a caller — the requester OR the private_to cordon. No owner
   * god-view.
   *
   * `limit` bounds the RETURNED slice, not the scan: visibility is decided on the
   * hydrated row, so every row is read and hydrated first and the slice comes after
   * the filter. Limiting in SQL would bound rows before the cordon ran and could
   * hand back fewer than the caller's own newest `limit` jobs — callers that report
   * a saturated read to the user (rescan_media_metadata's `MAX_JOB_SCAN`) depend on
   * this ordering being filter-then-slice.
   *
   * Cordon only — no `shared_with` (media sharing, 2026-07-29). A grant is
   * written onto the ITEM's note and grants read access to the item; a job row
   * is the requester's own pipeline state (the url they submitted, its retries,
   * its failure reason), it is not the thing that was shared, and it exists
   * before any note does. Sharing a clip does not enrol the grantee in the
   * sharer's download queue.
   */
  list_for_user(caller: Caller, opts?: { limit?: number }): MediaJobRow[] {
    const rows = this.db
      .prepare('SELECT * FROM media_archive_jobs ORDER BY created_at DESC')
      .all({}) as RawJobRow[];
    return rows
      .map((r) => this.hydrate(r))
      .filter(
        (r) =>
          (caller.user_id != null && r.requested_by === caller.user_id) ||
          note_visible_to_caller(r.private_to ?? undefined, caller),
      )
      .slice(0, opts?.limit ?? 50);
  }

  /** Re-file collapse: an OPEN job for the same url + same requester. */
  find_open_for_url(url: string, requested_by: string | null): MediaJobRow | null {
    const rows = this.db
      .prepare('SELECT * FROM media_archive_jobs WHERE url = @url ORDER BY created_at DESC')
      .all({ '@url': url }) as RawJobRow[];
    for (const r of rows) {
      const row = this.hydrate(r);
      if (!OPEN_MEDIA_JOB_STATUSES.includes(row.status)) continue;
      if ((requested_by ?? null) === (row.requested_by ?? null)) return row;
    }
    return null;
  }

  update(
    id: string,
    patch: Partial<{
      status: MediaJobStatus;
      state: MediaJobRunState;
      probe: unknown;
      category: unknown;
      quality: unknown;
      download: unknown;
      nsfw: unknown;
      media_item_id: string;
      note_path: string;
      error: string | null;
    }>,
  ): void {
    const sets: string[] = ['updated_at = @updated_at'];
    const params: Record<string, string | number | null> = {
      '@id': id,
      '@updated_at': new Date().toISOString(),
    };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      params['@status'] = patch.status;
      if (TERMINAL_MEDIA_JOB_STATUSES.includes(patch.status)) {
        sets.push('completed_at = @completed_at');
        params['@completed_at'] = new Date().toISOString();
      }
    }
    if (patch.state !== undefined) {
      sets.push('state_json = @state_json');
      params['@state_json'] = JSON.stringify(patch.state);
    }
    if (patch.probe !== undefined) {
      sets.push('probe_json = @probe_json');
      params['@probe_json'] = JSON.stringify(patch.probe);
    }
    if (patch.category !== undefined) {
      sets.push('category_json = @category_json');
      params['@category_json'] = JSON.stringify(patch.category);
    }
    if (patch.quality !== undefined) {
      sets.push('quality_json = @quality_json');
      params['@quality_json'] = JSON.stringify(patch.quality);
    }
    if (patch.download !== undefined) {
      sets.push('download_json = @download_json');
      params['@download_json'] = JSON.stringify(patch.download);
    }
    if (patch.nsfw !== undefined) {
      sets.push('nsfw_json = @nsfw_json');
      params['@nsfw_json'] = JSON.stringify(patch.nsfw);
    }
    if (patch.media_item_id !== undefined) {
      sets.push('media_item_id = @media_item_id');
      params['@media_item_id'] = patch.media_item_id;
    }
    if (patch.note_path !== undefined) {
      sets.push('note_path = @note_path');
      params['@note_path'] = patch.note_path;
    }
    if (patch.error !== undefined) {
      sets.push('error = @error');
      params['@error'] = patch.error;
    }
    this.db.prepare(`UPDATE media_archive_jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
}

/** Cap the run-state log to the last N lines (mirrors the research runner's push_log). */
export function push_media_log(state: MediaJobRunState, line: string, cap = 40): void {
  const log = state.log ?? [];
  log.push(line);
  state.log = log.slice(-cap);
}
