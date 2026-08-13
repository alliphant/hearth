/**
 * shelf_synthesis — per-shelf state for Cordelia's nightly distill pass
 * (consolidation cycle Phase 1, 2026-06-14).
 *
 * One row per library shelf (`Knowledge/<Target>/library`). Two jobs:
 *
 *   - `last_synthesized_at` — the cheap trigger. A shelf with no library
 *     item captured since this stamp is skipped WITHOUT clustering, so a
 *     quiet shelf costs one indexed COUNT, not an LLM pass.
 *   - `produced` — a map of synthesis-note path → the sha256 of the
 *     source set it was last built from. A topic whose sources are
 *     byte-identical to its last synthesis skips the planner LLM (the
 *     idempotency gate), without needing to read the note's frontmatter
 *     back off disk.
 *
 * Both are machine-owned: the runner is the only writer, and a re-run is
 * always safe. The table is declared in structured.ts SCHEMA_SQL (additive,
 * no SCHEMA_VERSION bump).
 */
import type { Database } from 'bun:sqlite';

export interface ShelfSynthesisState {
  shelf_path: string;
  last_synthesized_at: string | null;
  /** synthesis-note path → sha256 of the sources it was built from. */
  produced: Record<string, string>;
}

interface Row {
  shelf_path: string;
  last_synthesized_at: string | null;
  produced_json: string;
}

export class ShelfSynthesisStore {
  constructor(private readonly db: Database) {}

  /** Current state for a shelf — defaults (never synthesized) when absent. */
  get(shelf_path: string): ShelfSynthesisState {
    const row = this.db
      .prepare(
        `SELECT shelf_path, last_synthesized_at, produced_json
           FROM shelf_synthesis_state WHERE shelf_path = @p`,
      )
      .get({ '@p': shelf_path }) as Row | undefined;
    if (!row) {
      return { shelf_path, last_synthesized_at: null, produced: {} };
    }
    let produced: Record<string, string> = {};
    try {
      const parsed = JSON.parse(row.produced_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        produced = parsed as Record<string, string>;
      }
    } catch {
      /* corrupt JSON → treat as empty; the next pass re-produces */
    }
    return {
      shelf_path: row.shelf_path,
      last_synthesized_at: row.last_synthesized_at,
      produced,
    };
  }

  /** Persist the full state for a shelf (one write per shelf per pass). */
  put(state: ShelfSynthesisState): void {
    this.db
      .prepare(
        `INSERT INTO shelf_synthesis_state (shelf_path, last_synthesized_at, produced_json)
           VALUES (@p, @at, @j)
         ON CONFLICT(shelf_path) DO UPDATE SET
           last_synthesized_at = excluded.last_synthesized_at,
           produced_json = excluded.produced_json`,
      )
      .run({
        '@p': state.shelf_path,
        '@at': state.last_synthesized_at,
        '@j': JSON.stringify(state.produced),
      });
  }
}
