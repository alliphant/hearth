/**
 * smoke:research-office — the Research office tab's data route, in-process.
 *
 * Mounts create_research_router under /api/specialists with a fake-auth
 * middleware (no orchestrator). Seeds investigations directly via the store
 * for two users, then asserts the cordon matrix (owner has NO god-view; a
 * cross-user drill-in 404s, never leaking existence; unauth → 401; no
 * deep_research capability → 404; unknown specialist → 404), the active/recent
 * split, and the per-sub-question progress shape.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '../src/memory/stores/structured';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import { ResearchInvestigationStore } from '../src/memory/stores/research_investigations';
import { create_research_router } from '../src/app/routes/research';

let failures = 0;
function check(label: string, ok: boolean, extra?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : `  — ${extra}`}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-research-office-'));
const db = open_db(join(dir, 'smoke.db'));
load_extra_capabilities(join(import.meta.dir, '../config/capabilities.yaml'));

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'kate.yaml'),
  'id: kate\nname: Kate\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona for the research office smoke. Long enough to pass.\nproactive:\n  mode: reactive\ncapabilities:\n  deep_research: true\n',
);
writeFileSync(
  join(spec_dir, 'nocap.yaml'),
  'id: nocap\nname: NoCap\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona without the research grant. Long enough to pass.\nproactive:\n  mode: reactive\n',
);
const specialists = new SpecialistRegistry(spec_dir);

const store = new ResearchInvestigationStore(db);

// Seed: owner (jasper) has one active + one done; household member (sam) has
// one done — which the owner must NOT see.
const a = store.create({ subject: 'Dana Marsh', subject_kind: 'person', brief: 'b', requested_by: 'jasper', private_to: null });
store.update(a.id, {
  status: 'investigating',
  plan: { sub_questions: [{ id: 'sq_0', question: 'Background?' }, { id: 'sq_1', question: 'Reputation?' }] },
  findings: [
    { sub_question_id: 'sq_0', question: 'Background?', status: 'ok', findings: [{ text: 'LMT in Pleasantville', source_indices: [1] }], sources: [{ url: 'https://x.example/becca', title: 'X', fetched_ok: true }] },
  ],
});
// The progress trail is append-only + store-owned (two writers: the runner's
// slice and the cancel route), so a fixture seeds it the same way they do.
store.append_log(a.id, 'planned 2 sub-question(s)', 'investigated 2 sub-question(s) — 1 finding(s)');
const b = store.create({ subject: 'Trek Powerfly', subject_kind: 'product', brief: 'b', requested_by: 'jasper', private_to: null });
store.update(b.id, { status: 'done', dossier_md: '# Trek Powerfly\n\nA solid e-bike. [S1]', dossier_note_path: 'Knowledge/Kate/library/trek.md' });
const c = store.create({ subject: 'Dr Avery Stone', subject_kind: 'person', brief: 'b', requested_by: 'sam', private_to: 'sam' });
store.update(c.id, { status: 'done', dossier_md: '# Dr Stone\n\nPT.', dossier_note_path: 'Knowledge/Kate/library/stone.md' });

// ── the route, in-process ──────────────────────────────────────────────
let current_user: { id: string; tier: string } | null = { id: 'jasper', tier: 'owner' };
const app = new Hono();
app.use('*', async (ctx, next) => {
  if (current_user) ctx.set('user', current_user as never);
  await next();
});
app.route('/api/specialists', create_research_router({ db, specialists }));

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json().catch(() => null) };
};

// 1. Owner list — sees own active + recent, NOT sam's.
{
  const { status, body } = await get('/api/specialists/kate/research');
  check('owner gets 200', status === 200);
  const active_ids = (body?.active ?? []).map((i: { investigation_id: string }) => i.investigation_id);
  const recent_ids = (body?.recent ?? []).map((i: { investigation_id: string }) => i.investigation_id);
  check('active split contains the in-flight investigation', active_ids.includes(a.id));
  check('recent split contains the finished investigation', recent_ids.includes(b.id));
  check('owner does NOT see the household member\'s investigation (no god-view)', !active_ids.includes(c.id) && !recent_ids.includes(c.id));
  const av = (body?.active ?? []).find((i: { investigation_id: string }) => i.investigation_id === a.id);
  check('active view carries per-sub-question progress', av && av.sub_questions_total === 2 && av.sub_questions_answered === 1 && typeof av.progress === 'number');
}

// 2. Owner drill-in — own ok; cross-user 404 (no leak).
{
  const own = await get(`/api/specialists/kate/research/${a.id}`);
  check('owner drill-in to own → 200 with sub_questions', own.status === 200 && Array.isArray(own.body?.sub_questions) && own.body.sub_questions.length === 1);
  const cross = await get(`/api/specialists/kate/research/${c.id}`);
  check('owner drill-in to a household member\'s → 404 (never 403, no leak)', cross.status === 404);
}

// 3. Household member sees their own only.
{
  current_user = { id: 'sam', tier: 'household' };
  const { status, body } = await get('/api/specialists/kate/research');
  check('member gets 200', status === 200);
  const recent_ids = (body?.recent ?? []).map((i: { investigation_id: string }) => i.investigation_id);
  check('member sees their own finished investigation', recent_ids.includes(c.id));
  check('member does NOT see the owner\'s investigations', !recent_ids.includes(b.id));
  const own = await get(`/api/specialists/kate/research/${c.id}`);
  check('member drill-in to own → 200', own.status === 200);
}

// 4. Gating: unauth, no-capability specialist, unknown specialist.
{
  current_user = null;
  check('unauthenticated → 401', (await get('/api/specialists/kate/research')).status === 401);
  current_user = { id: 'jasper', tier: 'owner' };
  check('specialist without deep_research → 404', (await get('/api/specialists/nocap/research')).status === 404);
  check('unknown specialist → 404', (await get('/api/specialists/nosuch/research')).status === 404);
}

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:research-office OK' : `\nsmoke:research-office FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
