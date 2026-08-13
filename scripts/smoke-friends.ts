/**
 * smoke:friends — self-contained proof of the Friends office route (read + CRUD).
 *
 * No orchestrator: an in-memory SQLite holds the flight watches, a fake
 * MemoryClient (backed by an in-memory people map) stands in for the projection
 * + vault writers, and the real create_friends_router is mounted in a Hono app
 * with fake auth. The WRITE routes invoke the REAL person/flight tools against
 * the fake, so stamping + schema validation + cordon are exercised end-to-end.
 *
 * Covers: the read cordon matrix, facts extraction, upcoming sort, per-user
 * flight linkage, drill-in 404-on-miss; and writes — create person, patch a
 * fact (read-after-write), track a flight (+ store row), write-cordon (can't
 * edit a hidden person), input validation, untrack, 401.
 */
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import type { LLMRouter } from '../src/core/llm';
import type { MemoryClient, PersonRow, PersonLookup } from '../src/memory/client';
import { TrackedFlightsStore } from '../src/memory/stores/flights';
import { create_friends_router, type UpcomingEvent } from '../src/app/routes/friends';

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); }
}
function section(s: string): void { console.log(`\n${s}`); }

// ── Fake MemoryClient backed by an in-memory people map ─────────────────────
interface Entry { id: string; note_path: string; fm: Record<string, unknown>; body: string }
const entries = new Map<string, Entry>();
function seed(id: string, name: string, relationship: string, extra: Record<string, unknown>): void {
  entries.set(id, {
    id, note_path: `People/${name}.md`, body: '',
    fm: { type: 'person', id, name, relationship, ...extra },
  });
}
seed('p_sara01', 'Sam', 'family', { private_to: 'household', tone: 'warm', birthday: '1990-06-25', likes: ['hiking', 'jazz'], dislikes: ['cilantro'], work: 'nurse', anniversaries: [{ date: '2015-09-01', what: 'wedding' }], relations: [{ name: 'Jasper', relation: 'partner', person_id: 'p_self01' }] });
seed('p_lee001', 'Kim', 'friend', { private_to: 'kim', likes: ['chess'] });
seed('p_sec001', 'Secret', 'acquaintance', { private_to: 'owner' });
// A GEDCOM-imported ancestor — must be EXCLUDED from Friends (it's an ancestry
// DB entry, not a contact). Marked by gedcom_xref (import_gedcom's stamp).
seed('p_anc001', 'Great Granny', 'family', { private_to: 'household', gedcom_xref: '@I9999@', birth_date: 'abt 1890' });
seed('p_old001', 'Olive', 'friend', { private_to: 'household', contact_cadence: 'weekly', last_contacted: '2020-01-01' });
seed('p_self01', 'Owner', 'self', { private_to: 'household' }); // the owner's own note — not a friend

function to_row(e: Entry): PersonRow {
  const fm = e.fm;
  return {
    id: e.id, name: String(fm.name), preferred_name: (fm.preferred_name as string) ?? null,
    relationship: String(fm.relationship ?? 'acquaintance'), birthday: (fm.birthday as string) ?? null,
    contact_cadence: (fm.contact_cadence as string) ?? null, last_contacted: (fm.last_contacted as string) ?? null,
    sensitive: 0, friday_managed: 0, do_not_contact: 0, note_path: e.note_path,
    frontmatter_json: JSON.stringify(fm), mtime: '',
  };
}

const UPCOMING: UpcomingEvent[] = [
  { kind: 'birthday', person_id: 'p_sara01', name: 'Sam', note_path: 'People/Sam.md', date: '06-25', days_until: 3 },
  { kind: 'anniversary', person_id: 'p_sara01', name: 'Sam', note_path: 'People/Sam.md', date: '09-01', days_until: 70, what: 'wedding' },
];

const memory = {
  query_people: (filter: { relationship?: string }) =>
    [...entries.values()].map(to_row).filter((r) => !filter.relationship || r.relationship === filter.relationship),
  upcoming_dates: () => UPCOMING,
  find_person: (crit: { id?: string; name?: string }): PersonLookup | null => {
    let e: Entry | undefined;
    if (crit.id) e = entries.get(crit.id);
    else if (crit.name) e = [...entries.values()].find((x) => String(x.fm.name).toLowerCase() === crit.name!.toLowerCase());
    return e ? { id: e.id, note_path: e.note_path, frontmatter: e.fm } : null;
  },
  upsert_note: (path: string, fm: Record<string, unknown>, _body: string) => {
    const id = String(fm.id);
    const prev = entries.get(id);
    entries.set(id, { id, note_path: path, fm, body: prev?.body ?? '' });
  },
  append_to_note: (path: string, text: string) => {
    const e = [...entries.values()].find((x) => x.note_path === path);
    if (e) e.body += text;
  },
  read_note: (path: string) => {
    const e = [...entries.values()].find((x) => x.note_path === path);
    return e ? { frontmatter: e.fm, body: e.body } : null;
  },
  // The Friends route now reads the relationship graph for each card; this
  // smoke covers list/cordon/edits, so a no-op edge store is enough (the graph
  // itself is exercised by smoke:people-graph).
  knowledge_edges: { from: () => [], to: () => [], touching: () => [] },
  log_action: () => 'audit_x',
} as unknown as MemoryClient;

const specialists = {
  get: (id: string) =>
    id === 'kate' ? { granted: new Set(['read_vault', 'write_vault_general', 'track_flights']) }
    : id === 'nogrant' ? { granted: new Set<string>() } : undefined,
} as unknown as Parameters<typeof create_friends_router>[0]['specialists'];

const db = new Database(':memory:');
const flights = new TrackedFlightsStore(db);
let current_user: { id?: string; tier?: string } | undefined;

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const app = new Hono<{ Variables: { user: { id?: string; tier?: string } } }>();
  app.use('*', async (c, next) => { if (current_user) c.set('user', current_user); await next(); });
  app.route('/api/specialists', create_friends_router({ db, memory, specialists, llm: {} as LLMRouter }));
  const init: RequestInit = { method };
  if (body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
  const res = await app.request(path, init);
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* */ }
  return { status: res.status, body: parsed };
}
const GET = (p: string) => req('GET', p);

async function main(): Promise<void> {
  // ── A. read: cordon + assembly ───────────────────────────────────────────
  section('A. read — cordon + assembly');
  current_user = { id: 'jasper', tier: 'owner' };
  const owner = await GET('/api/specialists/kate/friends');
  const names = (owner.body.friends as any[]).map((f) => f.name);
  check('owner sees Sam + Secret, NOT Kim', names.includes('Sam') && names.includes('Secret') && !names.includes('Kim'));
  check('genealogy (gedcom_xref) EXCLUDED from list', !names.includes('Great Granny'));
  check('own self note INCLUDED in list (the "You" rung)', names.includes('Owner'));
  const selfDrill = await GET('/api/specialists/kate/friends/p_self01');
  check('self drill-in → 200 (you can see your own baseline)', selfDrill.status === 200);
  const ancDrill = await GET('/api/specialists/kate/friends/p_anc001');
  check('genealogy drill-in → 404', ancDrill.status === 404);
  const ancPatch = await req('POST', '/api/specialists/kate/friends/p_anc001', { patch: { x: 1 } });
  check('genealogy patch → 404 (not editable here)', ancPatch.status === 404);
  // Re-tier: changing relationship re-buckets the person into a new rung.
  const retier = await req('POST', '/api/specialists/kate/friends/p_sec001', { patch: { relationship: 'friend' } });
  const retierRead = await GET('/api/specialists/kate/friends/p_sec001');
  check('re-tier via patch{relationship} works', retier.status === 200 && retierRead.body.friend.relationship === 'friend');
  const sam = (owner.body.friends as any[]).find((f) => f.name === 'Sam');
  check('likes surfaced as interests; work stays a generic fact', sam.interests?.length === 2 && sam.facts.work === 'nurse' && !('likes' in sam.facts) && !('private_to' in sam.facts));
  check('upcoming sorted, next_in_days=3', sam.upcoming.length === 2 && sam.next_in_days === 3);
  current_user = { id: 'kim', tier: 'friend' };
  const kim = await GET('/api/specialists/kate/friends');
  check('friend kim sees ONLY Kim', (kim.body.friends as any[]).map((f) => f.name).join() === 'Kim');

  // ── B. create person ─────────────────────────────────────────────────────
  section('B. create');
  current_user = { id: 'jasper', tier: 'owner' };
  const created = await req('POST', '/api/specialists/kate/friends', { name: 'Dana Marsh', relationship: 'service' });
  check('create → 201 + id', created.status === 201 && /^p_/.test(created.body.id));
  const afterCreate = await GET('/api/specialists/kate/friends');
  check('new person appears in list', (afterCreate.body.friends as any[]).some((f) => f.name === 'Dana Marsh'));
  const noName = await req('POST', '/api/specialists/kate/friends', { relationship: 'friend' });
  check('create without name → 400', noName.status === 400);

  // ── C. patch a fact (read-after-write) ───────────────────────────────────
  section('C. update fact');
  const patched = await req('POST', '/api/specialists/kate/friends/p_sara01', { patch: { hobby: 'pottery' } });
  check('patch → 200', patched.status === 200);
  const reSara = await GET('/api/specialists/kate/friends/p_sara01');
  check('fact persisted (read-after-write)', reSara.body.friend.facts.hobby === 'pottery');
  const emptyPatch = await req('POST', '/api/specialists/kate/friends/p_sara01', {});
  check('empty update → 400', emptyPatch.status === 400);

  // ── D. write cordon ──────────────────────────────────────────────────────
  section('D. write cordon');
  const hiddenPatch = await req('POST', '/api/specialists/kate/friends/p_lee001', { patch: { x: 1 } });
  check('owner CANNOT patch kim-siloed person → 404', hiddenPatch.status === 404);

  // ── E. track + untrack a flight ──────────────────────────────────────────
  section('E. flights');
  const tracked = await req('POST', '/api/specialists/kate/friends/p_sara01/flight', { flight_no: 'UA2245', label: 'visit' });
  check('track → tracked:true', tracked.body.tracked === true);
  check('watch row created for jasper↔Sam', flights.list_for_person('jasper', 'p_sara01').length === 1);
  const noFlight = await req('POST', '/api/specialists/kate/friends/p_sara01/flight', {});
  check('track without flight_no → 400', noFlight.status === 400);
  const fid = flights.list_for_person('jasper', 'p_sara01')[0]!.id;
  const untracked = await req('DELETE', `/api/specialists/kate/friends/p_sara01/flight/${fid}`);
  check('untrack → untracked:true', untracked.body.untracked === true);
  check('watch removed', flights.list_for_person('jasper', 'p_sara01').length === 0);

  // ── G. enriched view + structured CRUD ───────────────────────────────────
  section('G. enriched + structured');
  current_user = { id: 'jasper', tier: 'owner' };
  const list2 = await GET('/api/specialists/kate/friends');
  const olive = (list2.body.friends as any[]).find((f) => f.name === 'Olive');
  check('overdue computed (cadence vs last_contacted)', olive && olive.overdue === true);
  check('overdue sorts to the front', (list2.body.friends as any[])[0].overdue === true);
  // structured pets
  const addPet = await req('POST', '/api/specialists/kate/friends/p_sara01/list', { field: 'pets', item: { name: 'Max', species: 'dog' } });
  check('list-add pet → 200', addPet.status === 200);
  const withPet = await GET('/api/specialists/kate/friends/p_sara01');
  check('pet persisted (structured)', (withPet.body.friend.pets || []).some((p: any) => p.name === 'Max' && p.species === 'dog'));
  // important date → shows in upcoming as kind:'date'
  await req('POST', '/api/specialists/kate/friends/p_sara01/list', { field: 'important_dates', item: { date: '2026-12-25', what: 'surgery' } });
  const withDate = await GET('/api/specialists/kate/friends/p_sara01');
  check('important_date in upcoming (kind:date)', (withDate.body.friend.upcoming || []).some((e: any) => e.kind === 'date' && e.what === 'surgery'));
  // interest (likes) + dietary
  await req('POST', '/api/specialists/kate/friends/p_sara01/list', { field: 'likes', item: 'pottery' });
  await req('POST', '/api/specialists/kate/friends/p_sara01/list', { field: 'dietary', item: 'gluten-free' });
  const withGift = await GET('/api/specialists/kate/friends/p_sara01');
  check('interest + dietary persisted', withGift.body.friend.interests.includes('pottery') && withGift.body.friend.dietary.includes('gluten-free'));
  // list-remove a pet
  await req('POST', '/api/specialists/kate/friends/p_sara01/list/remove', { field: 'pets', index: 0 });
  const noPet = await GET('/api/specialists/kate/friends/p_sara01');
  check('list-remove pet works', (noPet.body.friend.pets || []).length === 0);
  // bad field / bad index
  const badField = await req('POST', '/api/specialists/kate/friends/p_sara01/list', { field: 'evil', item: 'x' });
  check('unknown list field → 400', badField.status === 400);
  const badIdx = await req('POST', '/api/specialists/kate/friends/p_sara01/list/remove', { field: 'likes', index: 99 });
  check('bad index → 400', badIdx.status === 400);
  // contacted resets overdue
  await req('POST', '/api/specialists/kate/friends/p_old001/contacted', {});
  const olive2 = (await GET('/api/specialists/kate/friends')).body.friends.find((f: any) => f.name === 'Olive');
  check('contacted clears overdue', olive2 && olive2.overdue === false && olive2.days_since_contact === 0);
  // interaction log → note_body
  await req('POST', '/api/specialists/kate/friends/p_sara01', { body_append: '- 2026-06-22: had coffee' });
  const withNote = await GET('/api/specialists/kate/friends/p_sara01');
  check('note_body returned in drill-in', (withNote.body.friend.note_body || '').includes('had coffee'));

  // ── F. gating ────────────────────────────────────────────────────────────
  section('F. gating');
  const nogrant = await GET('/api/specialists/nogrant/friends');
  check('no read_vault → 404', nogrant.status === 404);
  current_user = undefined;
  const unauth = await GET('/api/specialists/kate/friends');
  check('unauthenticated → 401', unauth.status === 401);

  console.log(`\n${fail === 0 ? '✅' : '❌'} friends smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
