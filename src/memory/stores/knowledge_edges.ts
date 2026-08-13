/**
 * KnowledgeEdges — the TYPED / inferred edge layer of the Household Knowledge
 * Graph (2026-06-20).
 *
 * The vault's `graph_edges` table holds the human/wikilink structure (a note's
 * `[[target]]` links, projected for free by the ingestor). This store is its
 * complement: machine-INFERRED, typed relations the enricher derives — a good
 * is `owned-by` a person, was `purchased-from` a merchant, `implies` a
 * follow-up. Each edge carries a `kind`, a `confidence`, and the `source` that
 * asserted it, so a reader (Kate's running picture, a reactive trigger) can
 * reason over typed connections, not just adjacency.
 *
 * `from_ref` / `to_ref` are free refs — a vault note_path when the endpoint is
 * a note, or an entity token (e.g. a merchant name) when it isn't yet. Self-
 * contained additive table (CREATE IF NOT EXISTS in the ctor; no SCHEMA_SQL
 * edit, no SCHEMA_VERSION bump); named-sigil binds. Cordon: every edge carries
 * `private_to`, mirroring the node it describes.
 */
import { Database } from 'bun:sqlite';
import { note_visible_to_caller, type Caller } from '@memory/private_to';

export type EdgeKind =
  | 'owned-by'
  | 'purchased-from'
  | 'gifted-to'
  | 'attending' // a life_event → a participant (the event is attended-by this person/member)
  | 'located-at' // a life_event → a Place (the event happens at this place)
  | 'implies'
  | 'relates-to'; // a person → a person/place, the human role/tie carried in `context`
  // (hairdresser / daughter / works-at / my-salon). The relationship graph
  // (src/core/person_relations.ts) projects person-note `relations` into these;
  // `source` carries a provenance prefix (told|observed|inferred).

export interface KnowledgeEdge {
  from_ref: string;
  to_ref: string;
  kind: EdgeKind;
  confidence: number;
  source: string;
  context: string | null;
  private_to: string;
  created_at: string;
  updated_at: string;
}

export interface EdgeUpsert {
  from_ref: string;
  to_ref: string;
  kind: EdgeKind;
  confidence?: number;
  source: string;
  context?: string | null;
  private_to: string;
}

interface Row {
  from_ref: string;
  to_ref: string;
  kind: string;
  confidence: number;
  source: string;
  context: string | null;
  private_to: string;
  created_at: string;
  updated_at: string;
}

function hydrate(r: Row): KnowledgeEdge {
  return { ...r, kind: r.kind as EdgeKind };
}

export class KnowledgeEdges {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS knowledge_edges (
         from_ref TEXT NOT NULL,
         to_ref TEXT NOT NULL,
         kind TEXT NOT NULL,
         confidence REAL NOT NULL DEFAULT 1.0,
         source TEXT NOT NULL DEFAULT '',
         context TEXT,
         private_to TEXT NOT NULL DEFAULT 'household',
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (from_ref, to_ref, kind)
       )`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_kedges_from ON knowledge_edges(from_ref)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_kedges_to ON knowledge_edges(to_ref)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_kedges_kind ON knowledge_edges(kind)`);
  }

  /** Insert or refresh a typed edge (idempotent on from+to+kind). */
  upsert(e: EdgeUpsert): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO knowledge_edges
           (from_ref, to_ref, kind, confidence, source, context, private_to, created_at, updated_at)
         VALUES
           (@from_ref, @to_ref, @kind, @confidence, @source, @context, @private_to, @now, @now)
         ON CONFLICT(from_ref, to_ref, kind) DO UPDATE SET
           confidence = @confidence, source = @source, context = @context,
           private_to = @private_to, updated_at = @now`,
      )
      .run({
        '@from_ref': e.from_ref,
        '@to_ref': e.to_ref,
        '@kind': e.kind,
        '@confidence': e.confidence ?? 1.0,
        '@source': e.source,
        '@context': e.context ?? null,
        '@private_to': e.private_to,
        '@now': now,
      });
  }

  /** Edges OUT of a ref, cordon-filtered for the caller. */
  from(from_ref: string, caller: Caller, kind?: EdgeKind): KnowledgeEdge[] {
    const rows = (
      kind
        ? (this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE from_ref = @f AND kind = @k`)
            .all({ '@f': from_ref, '@k': kind }) as Row[])
        : (this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE from_ref = @f`)
            .all({ '@f': from_ref }) as Row[])
    ).map(hydrate);
    return rows.filter((e) => note_visible_to_caller(e.private_to, caller));
  }

  /** Edges INTO a ref, cordon-filtered for the caller. */
  to(to_ref: string, caller: Caller, kind?: EdgeKind): KnowledgeEdge[] {
    const rows = (
      kind
        ? (this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE to_ref = @t AND kind = @k`)
            .all({ '@t': to_ref, '@k': kind }) as Row[])
        : (this.db
            .prepare(`SELECT * FROM knowledge_edges WHERE to_ref = @t`)
            .all({ '@t': to_ref }) as Row[])
    ).map(hydrate);
    return rows.filter((e) => note_visible_to_caller(e.private_to, caller));
  }

  /** Every edge touching a ref (out OR in), cordon-filtered, deduped on
   *  (from,to,kind). The relationship graph reads undirected — "Rosa is
   *  Sam's hairdresser" surfaces from both Sam's and Rosa's note. */
  touching(ref: string, caller: Caller, kind?: EdgeKind): KnowledgeEdge[] {
    const seen = new Set<string>();
    const out: KnowledgeEdge[] = [];
    for (const e of [...this.from(ref, caller, kind), ...this.to(ref, caller, kind)]) {
      const key = `${e.from_ref} ${e.to_ref} ${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  }

  /** Replace ALL edges authored on one source note for one kind — delete then
   *  re-insert in a single transaction. This is the idempotent re-projection
   *  primitive the ingestor calls when a note's `relations` change (so removing
   *  a relation from the note removes its edge). Keyed by `from_ref` because a
   *  note authors only its OUTGOING relations; inbound edges belong to other
   *  notes and reproject with them. NOT cordon-filtered — projection is a
   *  trusted, system-level write. */
  replace_from(from_ref: string, kind: EdgeKind, edges: EdgeUpsert[]): void {
    const run = this.db.transaction((items: EdgeUpsert[]) => {
      this.db
        .prepare(`DELETE FROM knowledge_edges WHERE from_ref = @f AND kind = @k`)
        .run({ '@f': from_ref, '@k': kind });
      for (const e of items) this.upsert(e);
    });
    run(edges);
  }
}
