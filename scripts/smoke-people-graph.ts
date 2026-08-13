/**
 * smoke:people-graph — the relationship-and-role graph (Phase 0 of the People
 * reasoning substrate, 2026-06-22).
 *
 * Self-contained: a temp vault + on-disk SQLite, a REAL MemoryClient, and the
 * REAL ingestor projection (`rebuild`). No live orchestrator, no LLM. Exercises:
 *   - the pure normalizer (legacy {name,relation} + rich {to,predicate,…})
 *   - the provenance ↔ source codec
 *   - relation_edges_for (resolution, token fallback, dedup, no self-edge)
 *   - end-to-end projection of person-note `relations` → knowledge_edges
 *   - bidirectional read (touching) + assemble_relationships (incoming view)
 *   - the per-user cordon (owner has no god-view of a siloed person's ties)
 *   - record_relationship (told-first authoring + warm edge, same-turn read)
 *   - who_is (graph-walk read; person + place + not-found + cordon)
 *   - idempotent re-projection (remove a relation → its edge is gone)
 *   - unproject (delete a note → its outgoing edges are cleared)
 *
 *   bun run smoke:people-graph
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { unproject_note } from '@ingestor/project';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';
import type { Caller } from '@memory/private_to';
import {
  RELATES_TO,
  normalize_relation,
  make_edge_source,
  parse_edge_provenance,
  relation_edges_for,
  assemble_relationships,
  display_for_ref,
} from '@core/person_relations';
import { record_relationship } from '../src/specialists/kate/tools/record_relationship';
import { who_is } from '../src/specialists/kate/tools/who_is';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

function person_note(
  id: string,
  name: string,
  relationship: string,
  extra: string,
): string {
  return `---\ntype: person\nid: ${id}\nname: ${name}\nrelationship: ${relationship}\n${extra}---\n\nBody.\n`;
}

const SARA_RELATIONS = `private_to: household
relations:
  - to: Rosa Ito
    to_kind: person
    predicate: hairdresser
    provenance: told
  - to: "the salon"
    to_kind: place
    predicate: goes to salon
  - name: Mia
    relation: daughter
`;

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-people-graph-'));
  const vault = join(tmp, 'vault');
  const db_path = join(tmp, 'hearth.db');
  mkdirSync(join(vault, 'People'), { recursive: true });

  // ── 1. pure normalizer ────────────────────────────────────────────────────
  console.log('\n1. normalize_relation');
  const legacy = normalize_relation({ name: 'Mia', relation: 'daughter', birthday: '2015-04-02' });
  check('legacy {name,relation} → person/told', !!legacy && legacy.to === 'Mia' && legacy.to_kind === 'person' && legacy.predicate === 'daughter' && legacy.provenance === 'told' && legacy.confidence === 1);
  const rich = normalize_relation({ to: 'Rosa', to_kind: 'place', predicate: 'Hairdresser', provenance: 'inferred', confidence: 0.7 });
  check('rich entry → place/inferred, predicate lowercased', !!rich && rich.to_kind === 'place' && rich.predicate === 'hairdresser' && rich.provenance === 'inferred' && rich.confidence === 0.7);
  check('no target → null', normalize_relation({ predicate: 'friend' }) === null && normalize_relation('junk') === null);

  // ── 2. provenance ↔ source codec ──────────────────────────────────────────
  console.log('\n2. provenance codec');
  check('make_edge_source bare', make_edge_source('told') === 'told');
  check('make_edge_source with ref', make_edge_source('inferred', 'mail:mm1') === 'inferred:mail:mm1');
  check('parse prefixed', JSON.stringify(parse_edge_provenance('inferred:mail:mm1')) === JSON.stringify({ provenance: 'inferred', ref: 'mail:mm1' }));
  check('parse empty → told/null', JSON.stringify(parse_edge_provenance('')) === JSON.stringify({ provenance: 'told', ref: null }));
  check('parse unprefixed → told, ref kept', JSON.stringify(parse_edge_provenance('order:k')) === JSON.stringify({ provenance: 'told', ref: 'order:k' }));

  // ── 3. relation_edges_for (pure) ──────────────────────────────────────────
  console.log('\n3. relation_edges_for');
  const resolve_stub = (n: string): string => (n === 'Rosa Ito' ? 'People/Rosa Ito.md' : n);
  const edges3 = relation_edges_for(
    {
      relations: [
        { to: 'Rosa Ito', to_kind: 'person', predicate: 'Hairdresser' },
        { to: 'the salon', to_kind: 'place', predicate: 'goes to salon' },
        { to: 'Rosa Ito', to_kind: 'person', predicate: 'friend' }, // dup target → collapses
        { name: 'People/Sam.md' }, // resolves to self → dropped
      ],
    },
    'People/Sam.md',
    'household',
    resolve_stub,
  );
  check('dedup + self-drop → 2 edges', edges3.length === 2);
  const m = edges3.find((e) => e.to_ref === 'People/Rosa Ito.md');
  check('resolved target ref', !!m && m.context === 'hairdresser' && m.kind === RELATES_TO);
  const s = edges3.find((e) => e.to_ref === 'the salon');
  check('unresolved target kept as token', !!s && s.context === 'goes to salon');

  // ── 4. end-to-end projection via rebuild ──────────────────────────────────
  console.log('\n4. projection (relations → knowledge_edges)');
  writeFileSync(join(vault, 'People', 'Sam.md'), person_note('p_sara01', 'Sam', 'family', SARA_RELATIONS));
  writeFileSync(join(vault, 'People', 'Rosa Ito.md'), person_note('p_mich01', 'Rosa Ito', 'service', 'private_to: household\n'));
  writeFileSync(
    join(vault, 'People', 'Kim.md'),
    person_note('p_lee001', 'Kim', 'friend', 'private_to: kim\nrelations:\n  - to: Aztec\n    to_kind: place\n    predicate: works at\n'),
  );

  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root: vault, db });
  await rebuild(vault, memory, db);

  const sara_rows = db
    .prepare(`SELECT to_ref, context, source, private_to FROM knowledge_edges WHERE from_ref = ? AND kind = ? ORDER BY to_ref`)
    .all('People/Sam.md', RELATES_TO) as Array<{ to_ref: string; context: string; source: string; private_to: string }>;
  check('Sam → 3 relates-to edges', sara_rows.length === 3);
  check('Rosa resolved to note_path', sara_rows.some((r) => r.to_ref === 'People/Rosa Ito.md' && r.context === 'hairdresser'));
  check('place kept as token', sara_rows.some((r) => r.to_ref === 'the salon' && r.context === 'goes to salon'));
  check('legacy Mia → daughter token', sara_rows.some((r) => r.to_ref === 'Mia' && r.context === 'daughter'));
  check('edges carry told provenance', sara_rows.every((r) => parse_edge_provenance(r.source).provenance === 'told'));
  check('Sam edges stamped household', sara_rows.every((r) => r.private_to === 'household'));
  const lee_row = db.prepare(`SELECT private_to FROM knowledge_edges WHERE from_ref = ? AND kind = ?`).get('People/Kim.md', RELATES_TO) as { private_to: string } | undefined;
  check('Kim edge inherits friend cordon', lee_row?.private_to === 'kim');

  // ── 5. bidirectional read + assemble ──────────────────────────────────────
  console.log('\n5. bidirectional read (touching) + assemble');
  const owner: Caller = { user_id: 'jasper', tier: 'owner' };
  const people_by_path = new Map<string, string>();
  for (const p of memory.query_people({})) people_by_path.set(p.note_path, p.name);
  const display = (ref: string) => display_for_ref(ref, people_by_path, new Map());

  const on_michele = memory.knowledge_edges.touching('People/Rosa Ito.md', owner, RELATES_TO);
  const michele_rels = assemble_relationships('People/Rosa Ito.md', on_michele, display);
  check('Rosa has 1 incoming tie', michele_rels.length === 1);
  check('incoming view reads "Sam\'s hairdresser"', michele_rels[0]?.direction === 'incoming' && michele_rels[0]?.with === 'Sam' && michele_rels[0]?.role === 'hairdresser' && michele_rels[0]?.provenance === 'told');

  // ── 6. cordon ─────────────────────────────────────────────────────────────
  console.log('\n6. cordon (owner has no god-view)');
  check('owner cannot see Kim-siloed edge', memory.knowledge_edges.touching('People/Kim.md', owner, RELATES_TO).length === 0);
  const kim: Caller = { user_id: 'kim', tier: 'friend' };
  check('Kim can see his own edge', memory.knowledge_edges.touching('People/Kim.md', kim, RELATES_TO).length === 1);

  // ── 7. idempotent re-projection ───────────────────────────────────────────
  console.log('\n7. idempotent re-projection (remove a relation)');
  writeFileSync(
    join(vault, 'People', 'Sam.md'),
    person_note('p_sara01', 'Sam', 'family', 'private_to: household\nrelations:\n  - to: "the salon"\n    to_kind: place\n    predicate: goes to salon\n'),
  );
  await rebuild(vault, memory, db);
  const after = db.prepare(`SELECT to_ref FROM knowledge_edges WHERE from_ref = ? AND kind = ?`).all('People/Sam.md', RELATES_TO) as Array<{ to_ref: string }>;
  check('removed Rosa relation → edge gone', !after.some((r) => r.to_ref === 'People/Rosa Ito.md'));
  check('remaining edge stable (1)', after.length === 1);

  // ── 8. record_relationship (told-first authoring + warm edge) ─────────────
  console.log('\n8. record_relationship');
  const ctx = (c: Caller): ToolContext =>
    ({ memory, llm: null as unknown as LLMRouter, now: new Date(), intent_id: `i_${c.user_id}`, user: { id: c.user_id, tier: c.tier } } as ToolContext);
  const rec = await record_relationship.execute({ subject: 'Sam', target: 'Dr. Okafor', role: 'Pediatrician', target_kind: 'person' }, ctx(owner));
  check('recorded onto existing Sam note', rec.recorded && rec.subject_id === 'p_sara01' && rec.role === 'pediatrician');
  const warm = memory.knowledge_edges.touching('People/Sam.md', owner, RELATES_TO);
  check('warm edge visible same-turn (no rebuild)', warm.some((e) => e.context === 'pediatrician'));
  const sara_fm = memory.find_person({ id: 'p_sara01' })?.frontmatter as Record<string, unknown> | undefined;
  const sara_rel_arr = Array.isArray(sara_fm?.relations) ? (sara_fm!.relations as Array<Record<string, unknown>>) : [];
  check('relation appended to vault note (provenance told)', sara_rel_arr.some((r) => r.to === 'Dr. Okafor' && r.predicate === 'pediatrician' && r.provenance === 'told'));

  // ── 9. who_is ─────────────────────────────────────────────────────────────
  console.log('\n9. who_is');
  // re-create the Rosa tie so the bidirectional read has something to find
  await record_relationship.execute({ subject: 'Sam', target: 'Rosa Ito', role: 'hairdresser' }, ctx(owner));
  const wm = await who_is.execute({ name: 'Rosa Ito' }, ctx(owner));
  check('who_is finds Rosa (person)', wm.found && wm.kind === 'person');
  check('who_is shows incoming "Sam\'s hairdresser"', wm.relationships.some((r) => r.direction === 'incoming' && r.with === 'Sam' && r.role === 'hairdresser'));
  const ws = await who_is.execute({ name: 'Sam' }, ctx(owner));
  check('who_is Sam → outgoing hairdresser + pediatrician', ws.relationships.some((r) => r.role === 'hairdresser' && r.with === 'Rosa Ito') && ws.relationships.some((r) => r.role === 'pediatrician'));
  check('who_is unknown → found:false', !(await who_is.execute({ name: 'Nobody At All' }, ctx(owner))).found);
  check('who_is cordon: owner cannot see Kim', !(await who_is.execute({ name: 'Kim' }, ctx(owner))).found);
  check('who_is cordon: Kim sees himself', (await who_is.execute({ name: 'Kim' }, ctx(kim))).found);

  // ── 10. unproject (delete note → outgoing edges cleared) ──────────────────
  console.log('\n10. unproject clears outgoing edges');
  rmSync(join(vault, 'People', 'Sam.md'));
  unproject_note(resolve(vault, 'People', 'Sam.md'), { vault_root: vault, db, memory });
  check('Sam outgoing edges cleared on delete', db.prepare(`SELECT COUNT(*) AS n FROM knowledge_edges WHERE from_ref = ?`).get('People/Sam.md') as { n: number } && (db.prepare(`SELECT COUNT(*) AS n FROM knowledge_edges WHERE from_ref = ?`).get('People/Sam.md') as { n: number }).n === 0);

  db.close();
  rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? '✓' : '✗'} people-graph: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('\n✗ PEOPLE-GRAPH SMOKE FAILED:', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
