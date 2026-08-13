/**
 * purge_person — the one place that removes a person everywhere (2026-06-23).
 *
 * Shared by the `delete_person` tool (Kate, on request) and the Friends-tab
 * DELETE route (the "Remove contact" button), so both delete the SAME way. It
 * removes the vault note (the ingestor also unprojects on the unlink; we clear
 * the projection synchronously so the office updates immediately) plus the
 * person's SQLite-only data the unproject pass doesn't touch: relationship +
 * wikilink edges referencing the note, their observations, and their tracked
 * flights. Idempotent + best-effort per table (a missing table → 0, never a throw).
 *
 * One table is NULLED rather than deleted: `research_investigations.person_id`.
 * An investigation is history worth keeping even once the person note is gone —
 * see the comment at that entry. When you add a table that references a person,
 * decide which it is: meaningless-without-them → DELETE; independently
 * meaningful → NULL the link.
 *
 * Callers MUST cordon-check (resolve the person + `note_visible_to_caller`)
 * BEFORE calling this — purge is the trusted mechanism, not the gate.
 */
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';

export interface PurgeTarget {
  id: string;
  note_path: string;
}

export interface PurgeResult {
  note_removed: boolean;
  rows: Record<string, number>;
}

export function purge_person(
  db: Database,
  memory: Pick<MemoryClient, 'delete_note'>,
  person: PurgeTarget,
): PurgeResult {
  let note_removed = false;
  try {
    memory.delete_note(person.note_path);
    note_removed = true;
  } catch {
    /* best-effort — the projection cleanup below still runs */
  }
  const del = (sql: string, bind: Record<string, string>): number => {
    try {
      return db.prepare(sql).run(bind).changes ?? 0;
    } catch {
      return 0; // missing table / legacy db — never block a delete
    }
  };
  const rows: Record<string, number> = {
    people: del('DELETE FROM people WHERE id = @id', { '@id': person.id }),
    knowledge_edges: del(
      'DELETE FROM knowledge_edges WHERE from_ref = @p OR to_ref = @p',
      { '@p': person.note_path },
    ),
    graph_edges: del(
      'DELETE FROM graph_edges WHERE from_path = @p OR to_path = @p',
      { '@p': person.note_path },
    ),
    person_observations: del('DELETE FROM person_observations WHERE person_id = @id', { '@id': person.id }),
    person_synthesis: del('DELETE FROM person_synthesis WHERE person_id = @id', { '@id': person.id }),
    tracked_flights: del('DELETE FROM tracked_flights WHERE person_id = @id', { '@id': person.id }),
    // NULLED, not deleted (2026-07-30). An investigation is real history — it
    // ran, it cost tokens, and its cited dossier is still shelved and
    // searchable; only the person LINK becomes invalid when the note goes. Every
    // other table here holds data that is meaningless without the person, so it
    // is deleted; this one is not. Before this, deleting a person left a
    // dangling `research_investigations.person_id` pointing at a row that no
    // longer existed — surfaced by the 2026-07-29 public-figure cleanup, where
    // two deleted CD-3 candidate shells had investigations pointing at them.
    research_investigations: del(
      'UPDATE research_investigations SET person_id = NULL WHERE person_id = @id',
      { '@id': person.id },
    ),
  };
  return { note_removed, rows };
}
