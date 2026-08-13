/**
 * smoke:imessage-observer — the opt-in macOS iMessage observer. Self-contained:
 * an in-memory SQLite db for the REAL stores (opt-in / staging / observations),
 * a fake MemoryClient (seeded people, no vault), and a fake LLM. No network.
 *
 * Asserts the contracts that make this the most sensitive source safe:
 *   - the opt-in registry (default OFF) + its cordon,
 *   - the transient staging buffer (idempotent stage, drop, attempt cap),
 *   - the substance filter (structural skip/distill + judge fail-open),
 *   - the end-to-end distill: opted-in person → durable facts merged into the
 *     note + relationship observations (open loop / life event / topic) land,
 *     observations are owner-cordoned, and THE RAW IS DROPPED,
 *   - a NOT-opted person is dropped, never distilled,
 *   - the kill switch no-ops, and the cadence gate skips inside its interval.
 */
import { Database } from 'bun:sqlite';
import type { MemoryClient, PersonRow, PersonLookup } from '../src/memory/client';
import type { EnrichLLM } from '../src/core/person_enrichment';
import { sanitize_facts } from '../src/core/person_enrichment';
import {
  run_imessage_distill_sweep,
  window_substance_signal,
  assess_window_substance,
  extract_imessage_signals,
  render_transcript,
  signals_system,
} from '../src/core/imessage_distill';
import { ImessageStaging, ImessageOptIn, type StagedMessage } from '../src/memory/stores/imessage_staging';
import { PersonObservations } from '../src/memory/stores/person_observations';
import { PersonSynthesisStore } from '../src/memory/stores/person_synthesis';
import { create as create_distill_tool } from '../src/specialists/kate/tools/distill_imessage_observations';
import {
  run_people_synthesis_sweep,
  synthesize_person,
  synthesis_system,
  recurring_token_threads,
  merge_refinement,
} from '../src/core/people_synthesis';
import { create as create_synth_tool } from '../src/specialists/kate/tools/synthesize_person_dossiers';
import {
  run_scan_life_events,
  strip_life_event_prefix,
  create as create_life_events_tool,
} from '../src/specialists/kate/tools/scan_life_events';
import { assemble_meeting_prep } from '../src/core/people_prep';
import {
  run_scan_meeting_prep,
  create as create_meeting_prep_tool,
} from '../src/specialists/kate/tools/scan_meeting_prep';
import type { LLMRouter } from '../src/core/llm';
import type { NewProposal, CategorySignature } from '../src/core/proposals';

let pass = 0, fail = 0;
function check(n: string, c: boolean): void { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } }
function section(s: string): void { console.log(`\n${s}`); }

// ── fake memory (seeded people, no vault) ────────────────────────────────────
interface Entry { id: string; note_path: string; fm: Record<string, unknown> }
const entries = new Map<string, Entry>();
function seed(id: string, name: string, fm: Record<string, unknown>): void {
  entries.set(id, { id, note_path: `People/${name}.md`, fm: { type: 'person', id, name, relationship: 'friend', ...fm } });
}
seed('p_sara01', 'Sam', { private_to: 'household', likes: ['hiking'] });
seed('p_mike01', 'Mike', { private_to: 'household' }); // exists but NOT opted in

function to_row(e: Entry): PersonRow {
  const fm = e.fm;
  return {
    id: e.id, name: String(fm.name), preferred_name: null, relationship: String(fm.relationship ?? 'friend'),
    birthday: null, contact_cadence: null, last_contacted: null, sensitive: 0, friday_managed: 0, do_not_contact: 0,
    note_path: e.note_path, frontmatter_json: JSON.stringify(fm), mtime: '',
  };
}
const memory = {
  query_people: () => [...entries.values()].map(to_row),
  find_person: (crit: { id?: string }): PersonLookup | null => {
    const e = crit.id ? entries.get(crit.id) : undefined;
    return e ? { id: e.id, note_path: e.note_path, frontmatter: e.fm } : null;
  },
  upsert_note: (_path: string, fm: Record<string, unknown>) => {
    const id = String(fm.id);
    const prev = entries.get(id);
    if (prev) entries.set(id, { ...prev, fm });
  },
  append_to_note: () => {},
  log_action: () => 'audit_x',
} as unknown as MemoryClient;

// ── fake LLM: branches on the system prompt; canned per call type ────────────
let llm_calls = 0;
const llm: EnrichLLM = {
  for_role: () => ({
    provider: {
      complete: async (req) => {
        llm_calls++;
        const sys = req.messages.find((m) => m.role === 'system')?.content ?? req.messages.map((m) => m.content).join(' ');
        if (/DURABLE SIGNAL worth remembering/.test(sys)) {
          return { content: JSON.stringify({ has_signal: true, reason: 'real conversation' }) };
        }
        if (/extract durable facts a user stated/.test(sys)) {
          return { content: JSON.stringify({ interests: ['pottery'], dietary: ['gluten-free'] }) };
        }
        if (/durable relationship signal from a 1:1/.test(sys)) {
          return { content: JSON.stringify({
            open_loops: [{ summary: 'send the sourdough recipe', owed_by: 'me', due_hint: 'this weekend' }],
            life_events: [{ summary: 'started a new job at Acme' }],
            topics: [{ summary: 'her job hunt' }],
            style_notes: [{ summary: 'Sam writes in long warm paragraphs and always asks about the kids first' }],
          }) };
        }
        return { content: '{}' };
      },
    },
  }),
};

function mk(text: string, from_me = false, ts = '2026-06-22T18:00:00Z'): StagedMessage { return { text, ts, from_me }; }
const NOW = new Date('2026-06-22T20:00:00Z');

async function main(): Promise<void> {
  const db = new Database(':memory:');
  const opt = new ImessageOptIn(db);
  const stage = new ImessageStaging(db);
  const obs = new PersonObservations(db);

  // ── A. opt-in registry (default OFF + cordon) ────────────────────────────
  section('A. opt-in registry');
  check('default OFF (no row → not enabled)', !opt.is_enabled('p_sara01'));
  opt.set('p_sara01', 'jasper', 'jasper', true);
  check('set → enabled', opt.is_enabled('p_sara01'));
  check('is_enabled_for matches owner', opt.is_enabled_for('p_sara01', 'jasper'));
  check('is_enabled_for rejects another user', !opt.is_enabled_for('p_sara01', 'sam'));
  opt.set('p_sara01', 'jasper', 'jasper', false);
  check('toggle OFF', !opt.is_enabled('p_sara01'));
  opt.set('p_sara01', 'jasper', 'jasper', true);
  const owner_view = opt.enabled_set({ user_id: 'jasper', tier: 'owner' });
  const sara_view = opt.enabled_set({ user_id: 'sam', tier: 'household' });
  check('enabled_set: owner sees own opt-in', owner_view.has('p_sara01'));
  check('enabled_set: another user does NOT (cordon)', !sara_view.has('p_sara01'));

  // ── B. staging buffer (idempotent stage / drop / attempt cap / cursor) ────
  section('B. staging buffer');
  const win = { person_id: 'p_sara01', user_id: 'jasper', private_to: 'jasper', chat_guid: 'g1', window_start: 'a', window_end: 'b', messages: [mk('hi'), mk('there', true)] };
  const s1 = stage.stage(win);
  const s2 = stage.stage(win);
  check('stage is_new on first', s1.is_new);
  check('identical re-stage collapses (idempotent on hash)', !s2.is_new && s1.id === s2.id);
  check('count is 1 after dup', stage.count() === 1);
  stage.stage({ ...win, window_end: 'c' }); // a different window
  check('different window → new row', stage.count() === 2);
  check('pending_person_ids', stage.pending_person_ids().join() === 'p_sara01');
  const pend = stage.pending_for_person('p_sara01');
  check('pending_for_person hydrates messages', pend.length === 2 && pend[0]!.messages.length === 2 && pend[0]!.messages[1]!.from_me === true);
  stage.bump_attempts(pend.map((p) => p.id));
  stage.bump_attempts(pend.map((p) => p.id));
  stage.bump_attempts(pend.map((p) => p.id));
  check('exhausted_ids at attempt cap', stage.exhausted_ids(3).length === 2);
  check('drop removes rows', stage.drop(pend.map((p) => p.id)) === 2 && stage.count() === 0);
  stage.set_meta('k', 'v');
  check('meta cursor round-trips', stage.get_meta('k') === 'v' && stage.get_meta('missing') === null);

  // ── C. substance filter (structural + judge, fail-open) ──────────────────
  section('C. substance filter');
  const trivial = [mk('k', true), mk('lol'), mk('omw', true)];
  const rich = [mk('I just accepted the offer at Acme, start in two weeks!'), mk('that is amazing, congrats!', true), mk('we should celebrate — dinner Saturday?')];
  check('structural: all-trivial → skip', window_substance_signal(trivial).verdict === 'skip');
  check('structural: rich → distill', window_substance_signal(rich).verdict === 'distill');
  check('structural: single substantive → judge', window_substance_signal([mk('Can you send me that long sourdough recipe you mentioned the other day?')]).verdict === 'judge');
  check('assess: skip → false', (await assess_window_substance({ messages: trivial, transcript: 'x', llm })) === false);
  check('assess: distill → true (no llm call)', (await assess_window_substance({ messages: rich, transcript: 'x' })) === true);
  const denier: EnrichLLM = { for_role: () => ({ provider: { complete: async () => ({ content: JSON.stringify({ has_signal: false }) }) } }) };
  check('assess: judge says no → false', (await assess_window_substance({ messages: [mk('a single medium message here that is substantive enough')], transcript: 'x', llm: denier })) === false);
  const thrower: EnrichLLM = { for_role: () => ({ provider: { complete: async () => { throw new Error('down'); } } }) };
  check('assess: judge outage → fail-open true', (await assess_window_substance({ messages: [mk('a single medium message here that is substantive enough')], transcript: 'x', llm: thrower })) === true);
  check('assess: ambiguous + no llm → fail-open true', (await assess_window_substance({ messages: [mk('a single medium message here that is substantive enough')], transcript: 'x' })) === true);

  // ── D. signal extraction (parse + fail-open) ─────────────────────────────
  section('D. signal extraction');
  const sig = await extract_imessage_signals(llm, 'Sam', 'Me: hi\nSam: I start at Acme soon');
  check('extracts open_loops/life_events/topics', !!sig && sig.open_loops.length === 1 && sig.life_events.length === 1 && sig.topics.length === 1);
  check('open_loop owed_by/due parsed', sig!.open_loops[0]!.owed_by === 'me' && sig!.open_loops[0]!.due_hint === 'this weekend');
  // C. style_notes — how they COMMUNICATE, extracted where the raw voice still exists.
  check('extracts style_notes (how they communicate)', sig!.style_notes.length === 1 && /long warm paragraphs/.test(sig!.style_notes[0]!.summary));
  const sig_nostyle = await extract_imessage_signals(
    { for_role: () => ({ provider: { complete: async () => ({ content: JSON.stringify({ open_loops: [], life_events: [], topics: [] }) }) } }) },
    'X', 'Me: hi',
  );
  check('style_notes absent → [] (never fabricated)', !!sig_nostyle && sig_nostyle.style_notes.length === 0);
  const sig_manystyle = await extract_imessage_signals(
    { for_role: () => ({ provider: { complete: async () => ({ content: JSON.stringify({ style_notes: [{ summary: 'a' }, { summary: 'b' }, { summary: 'c' }, { summary: 'd' }, { summary: 'e' }] }) }) } }) },
    'X', 'Me: hi',
  );
  check('style_notes capped at 3 per window', sig_manystyle!.style_notes.length === 3);
  const badllm: EnrichLLM = { for_role: () => ({ provider: { complete: async () => ({ content: 'not json' }) } }) };
  check('bad JSON → null (fail-open)', (await extract_imessage_signals(badllm, 'X', 'Me: hi')) === null);
  check('empty transcript → null', (await extract_imessage_signals(llm, 'X', '   ')) === null);
  check('render_transcript attributes speakers', render_transcript([mk('hello', false), mk('hey', true)], 'Sam') === 'Sam: hello\nMe: hey');
  // sanitize_facts: upsert_person_note rejects null/free-form dates and trips the
  // WHOLE patch, so unknown birthdays / dateless entries must be stripped at the source.
  const sf = sanitize_facts({
    interests: ['hiking'],
    relations: [{ name: 'Mara', relation: 'sister', birthday: null as unknown as string }, { name: 'Jo', relation: 'friend', birthday: '1990-04-02' }],
    important_dates: [{ date: null as unknown as string, what: 'x' }, { date: '06-14', what: 'move-in' }],
  });
  check('sanitize_facts drops null birthday, keeps name+relation', !('birthday' in sf.relations![0]!) && sf.relations![0]!.name === 'Mara');
  check('sanitize_facts keeps a valid birthday', sf.relations![1]!.birthday === '1990-04-02');
  check('sanitize_facts drops dateless important_date, keeps valid', sf.important_dates!.length === 1 && sf.important_dates![0]!.date === '06-14');
  check('sanitize_facts leaves other facts untouched', JSON.stringify(sf.interests) === JSON.stringify(['hiking']));
  const sigsys = signals_system('Sam Reed');
  check('signals prompt is per-contact (names them)', sigsys.includes('Sam Reed'));
  check('signals prompt bans role-word output', sigsys.includes('NEVER the words "the contact", "the owner", or "Me"'));
  check('signals prompt asks for style about THEM, not the owner', /style_notes/.test(sigsys) && /NEVER the \n?owner's|NEVER the owner's/.test(sigsys));

  // ── E. distill end-to-end ────────────────────────────────────────────────
  section('E. distill sweep');
  process.env.HEARTH_IMESSAGE_DISTILL_MIN_INTERVAL_H = '0'; // disable cadence gate for this section
  // Stage substantive windows for Sam (opted in) AND Mike (NOT opted in).
  stage.stage({ person_id: 'p_sara01', user_id: 'jasper', private_to: 'jasper', chat_guid: 'gs', window_end: 'e1', messages: rich });
  stage.stage({ person_id: 'p_mike01', user_id: 'jasper', private_to: 'jasper', chat_guid: 'gm', window_end: 'e2', messages: rich });

  process.env.HEARTH_IMESSAGE_OBSERVER = '0';
  const off = await run_imessage_distill_sweep({ db, memory, llm, now: () => NOW });
  check('dark by default (flag off → no-op, nothing consumed)', !off.enabled && off.people === 0 && stage.count() === 2);

  process.env.HEARTH_IMESSAGE_OBSERVER = '1';
  const r = await run_imessage_distill_sweep({ db, memory, llm, now: () => NOW });
  check('enabled run distilled exactly the opted-in person', r.enabled && !r.skipped && r.people === 1);
  check('observations recorded (loop+event+topic+style)', r.observations === 4);
  check('facts merged (≥2)', r.facts >= 2);
  check('Sam note gained pottery + gluten-free', (entries.get('p_sara01')!.fm.likes as string[]).includes('pottery') && (entries.get('p_sara01')!.fm.dietary as string[]).includes('gluten-free'));
  const sara_obs = obs.list_for_person('p_sara01', { user_id: 'jasper', tier: 'owner' }, { limit: 20 });
  check('observations are iMessage-sourced', sara_obs.length === 4 && sara_obs.every((o) => o.source_type === 'imessage'));
  check('an open_loop carries direction', sara_obs.some((o) => o.kind === 'open_loop' && /you owe Sam/.test(o.summary)));
  check('a life_event + a topic landed', sara_obs.some((o) => o.kind === 'life_event') && sara_obs.some((o) => o.kind === 'topic'));
  check('a style observation landed, low-confidence by design', sara_obs.some((o) => o.kind === 'style' && /How they communicate/.test(o.summary) && o.confidence === 0.4));
  check('cordon: observations are owner-only (private_to = uploader)', sara_obs.every((o) => o.private_to === 'jasper'));
  const sara_obs_other = obs.list_for_person('p_sara01', { user_id: 'sam', tier: 'household' }, { limit: 20 });
  check('cordon: another user sees NONE of the iMessage observations', sara_obs_other.length === 0);
  check('RAW DROPPED — staging fully consumed', stage.count() === 0);
  check('NOT-opted Mike: no observations', obs.list_for_person('p_mike01', { user_id: 'jasper', tier: 'owner' }, { limit: 20 }).length === 0);

  // ── F. idempotent re-distill + cadence gate ──────────────────────────────
  section('F. idempotency + cadence');
  // Re-stage the SAME Sam window and re-run (gate still 0) — observations
  // collapse on their content hash; no duplicates.
  stage.stage({ person_id: 'p_sara01', user_id: 'jasper', private_to: 'jasper', chat_guid: 'gs', window_end: 'e1', messages: rich });
  const r2 = await run_imessage_distill_sweep({ db, memory, llm, now: () => NOW });
  check('re-distill adds no duplicate observations', obs.list_for_person('p_sara01', { user_id: 'jasper', tier: 'owner' }, { limit: 50 }).length === 4 && r2.observations === 0);
  // Now arm the cadence gate and confirm a fresh window is NOT consumed.
  process.env.HEARTH_IMESSAGE_DISTILL_MIN_INTERVAL_H = '168';
  stage.stage({ person_id: 'p_sara01', user_id: 'jasper', private_to: 'jasper', chat_guid: 'gs2', window_end: 'e9', messages: rich });
  const r3 = await run_imessage_distill_sweep({ db, memory, llm, now: () => NOW });
  check('cadence gate skips inside interval', r3.enabled && r3.skipped && r3.people === 0);
  check('cadence skip leaves raw un-consumed', stage.count() === 1);

  // ── G. job-tool registration shape (guards the Tool wired into Kate's pack) ─
  section('G. job-tool shape');
  const tool = create_distill_tool({ db } as never);
  check('tool name', tool.name === 'distill_imessage_observations');
  check('tool is write_internal + volatile', tool.risk === 'write_internal' && tool.volatile === true);
  check('tool gated on write_vault_general', (tool.required_capabilities ?? []).includes('write_vault_general'));
  process.env.HEARTH_IMESSAGE_OBSERVER = '0';
  const darkTool = await tool.execute({}, { memory, llm, now: NOW, intent_id: 'x' } as never);
  check('tool dark no-op when flag off', darkTool.enabled === false);

  // ── H. people synthesis pass (promote / decay / gate / followups) ─────────
  section('H. synthesis pass');
  process.env.HEARTH_PEOPLE_SYNTHESIS = '1';
  process.env.HEARTH_PEOPLE_SYNTHESIS_MIN_INTERVAL_H = '0';
  const NOW2 = new Date('2026-06-24T20:00:00Z');

  // A contact with a THIN dossier (no pets, no job) but a RICH, mixed stream:
  // a durable+recurring DOG theme, a durable JOB fact, an actionable open loop,
  // a trivial errand loop (not a followup), and a trivial topic (decay).
  seed('p_lee010', 'Kim', { private_to: 'household', likes: ['Stardew Valley'] });
  const db2 = new Database(':memory:');
  const obs2 = new PersonObservations(db2);
  const syn2 = new PersonSynthesisStore(db2);
  const rec2 = (kind: string, summary: string, source_ref: string, observed_at: string, conf = 0.6): void => {
    obs2.record({ person_id: 'p_lee010', user_id: 'jasper', kind, summary, source_type: 'imessage', source_ref, confidence: conf, private_to: 'jasper', observed_at });
  };
  rec2('open_loop', 'Open loop — you owe Kim: book daycare for Mango', 'sr_loop', '2026-06-24T10:00:00Z', 0.7);
  rec2('open_loop', 'Open loop — you owe Kim: buy spring mix and cheddar', 'sr_errand', '2026-06-24T10:01:00Z', 0.7);
  rec2('topic', 'Talk about: Kim is the ACS liaison for the global defense COE', 'sr_job', '2026-06-24T10:02:00Z');
  rec2('topic', "Talk about: Kim's dog Mango and her daycare", 'sr_dog1', '2026-06-24T10:03:00Z');
  rec2('topic', "Talk about: Kim's dog Bailey's health and antibiotics", 'sr_dog2', '2026-06-24T10:04:00Z');
  rec2('topic', "Talk about: a friend's trouble spelling Kim's name", 'sr_triv', '2026-06-24T10:05:00Z');

  // Pure-function guards: the gate prompt + the deterministic recurrence hint.
  const ssys = synthesis_system('Kim');
  check('synthesis prompt names the contact + carries the durability gate', ssys.includes('Kim') && /6-12 months/.test(ssys) && /RECURRENCE/.test(ssys));
  const threads = recurring_token_threads(obs2.all_active_for_person('p_lee010'));
  check('recurrence hint surfaces the recurring dog/mango thread', threads.some((t) => /"dog"|"mango"/.test(t)));

  // Regression: a pet the model returns WITHOUT a species must not carry
  // `species: undefined` — js-yaml THROWS "[object Undefined]" on dump, which
  // silently lost Sam's dogs on the live 2026-06-24 run. Omit the absent key.
  const speciesless: EnrichLLM = { for_role: () => ({ provider: { complete: async () => ({ content: JSON.stringify({ summary: 'x', themes: [], facts: { pets: [{ name: 'Mango' }] }, followups: [], decay: [] }) }) } }) };
  const sres = await synthesize_person(speciesless, 'Kim', '(thin)', obs2.all_active_for_person('p_lee010'), []);
  const kira_pet = sres?.facts.pets?.[0];
  check('a speciesless pet omits the key (no undefined → no YAML dump throw)', !!kira_pet && kira_pet.name === 'Mango' && !('species' in kira_pet) && !('notes' in kira_pet));

  // Fake synthesis LLM: resolves followup/decay refs by NEEDLE in the enumerated
  // prompt, so it's robust to observation ordering (tests the real ref→row map).
  let synth_calls = 0;
  let last_synth_prompt = '';
  const synthLLM: EnrichLLM = {
    for_role: () => ({ provider: { complete: async (req) => {
      synth_calls++;
      const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
      if (!/curate a durable relationship DOSSIER/.test(sys)) return { content: '{}' };
      last_synth_prompt = user;
      const refOf = (needle: string): number => { const m = user.match(new RegExp(`\\[(\\d+)\\][^\\n]*${needle}`, 'i')); return m ? Number(m[1]) : 0; };
      return { content: JSON.stringify({
        summary: 'Kim is a close friend deep in a demanding defense-tech career who dotes on two dogs.',
        themes: ['Kim actively manages the health and care of two dogs, Mango and Bailey.', 'Kim works in defense technology as an ACS liaison.'],
        communication: 'Kim texts in short bursts, opens with a joke, and gets straight to logistics.',
        facts: { pets: [{ name: 'Mango', species: 'dog' }, { name: 'Bailey', species: 'dog' }], interests: ['gaming'] },
        followups: [{ ref: refOf('book daycare'), action: 'book daycare for Mango', due_hint: 'this week' }],
        decay: [refOf('spelling')],
      }) };
    } } }),
  };

  // Fake proposals store with REAL signature dedup (the edge-dedup contract).
  const filed: NewProposal[] = [];
  const filed_sigs = new Set<string>();
  const sig_key = (s: CategorySignature): string => `${s.specialist_id}|${s.kind}|${s.category}|${s.anchor ?? ''}`;
  const proposals = {
    create: (p: NewProposal): string => { filed.push(p); filed_sigs.add(sig_key(p.signature)); return `pr_${filed.length}`; },
    exists_for_signature: (s: CategorySignature): boolean => filed_sigs.has(sig_key(s)),
  };

  const h = await run_people_synthesis_sweep({ db: db2, memory, llm: synthLLM, proposals, now: () => NOW2 });
  check('sweep synthesized exactly the active person', h.enabled && !h.skipped && h.people === 1);
  check('PROMOTE facts: Kim note gained pets Mango + Bailey', (() => { const pets = entries.get('p_lee010')!.fm.pets as Array<{ name: string }>; return Array.isArray(pets) && pets.some((p) => p.name === 'Mango') && pets.some((p) => p.name === 'Bailey'); })());
  check('PROMOTE facts count reflects merges (pets + interest)', h.facts >= 2);
  const lee_syn = syn2.get_for_person('p_lee010', { user_id: 'jasper', tier: 'owner' });
  check('PROMOTE narrative: synthesis row stored with summary + themes', !!lee_syn && lee_syn.summary.length > 0 && lee_syn.themes.length === 2);
  check('narrative carries the recurring dog theme', !!lee_syn && lee_syn.themes.some((t) => /dog/i.test(t)));
  check('CORDON: another household member sees NO synthesis (owner-only)', syn2.get_for_person('p_lee010', { user_id: 'sam', tier: 'household' }) === null);
  check('FOLLOWUP: one open-loop action_proposal filed', filed.length === 1 && filed[0]!.kind === 'action_proposal');
  check('FOLLOWUP: anchored to the open loop\'s source_ref (edge key)', filed[0]!.signature.anchor === 'p_lee010:sr_loop' && filed[0]!.signature.category === 'open_loop_followup');
  check('FOLLOWUP: only the ACTIONABLE loop (errand loop not filed)', filed.every((p) => (p.payload as { observation_id?: string }).observation_id !== undefined) && filed.length === 1);
  check('DECAY: the trivial topic was dismissed', !obs2.all_active_for_person('p_lee010').some((o) => o.source_ref === 'sr_triv'));
  check('DECAY: durable observations survive (job + dog topics still active)', obs2.all_active_for_person('p_lee010').some((o) => o.source_ref === 'sr_job') && obs2.all_active_for_person('p_lee010').some((o) => o.source_ref === 'sr_dog1'));
  check('COMMUNICATION: the "how they talk" portrait is stored', !!lee_syn && /short bursts/.test(lee_syn.communication));
  check('first pass is revision 1', !!lee_syn && lee_syn.revision === 1);

  // ── H2. dossier DEPTH: refine-not-rebuild + the decayed-observation corpus ──
  // The pass used to hand the model only the currently-active observations and
  // then overwrite the row, so a portrait could never outgrow one night's window
  // (a live dossier read source_observation_count: 4 after weeks of messages).
  section('H2. dossier depth');

  // A. REFINE — the next pass is anchored on the dossier it already wrote.
  // NB: keep this observation EARLIER than the sr_trip/sr_loop2 fixtures below —
  // the dirty-gate cursor is the newest active observation, so a later timestamp
  // here would make those (older) fixtures look already-synthesized.
  rec2('topic', 'Talk about: Kim started climbing on weekends', 'sr_climb', '2026-06-24T10:30:00Z');
  const h_refine = await run_people_synthesis_sweep({ db: db2, memory, llm: synthLLM, proposals, now: () => NOW2 });
  check('REFINE: prompt carries the prior portrait as the anchor', /The dossier as it stands \(revision \d+\)/.test(last_synth_prompt) && /defense-tech career/.test(last_synth_prompt));
  check('REFINE: prompt carries the prior communication portrait', /How they communicate: Kim texts in short bursts/.test(last_synth_prompt));
  check('REFINE: system prompt forbids restarting from scratch', /REFINE, DO NOT REBUILD/.test(synthesis_system('Kim')));
  const lee_syn2 = syn2.get_for_person('p_lee010', { user_id: 'jasper', tier: 'owner' });
  check('REFINE: revision increments with each pass (depth counter)', h_refine.people === 1 && !!lee_syn2 && lee_syn2.revision > lee_syn!.revision);

  // B. HISTORY — decayed observations stay available to the pass as context.
  check('HISTORY: the decayed trivial topic is in the corpus', obs2.history_for_person('p_lee010').some((o) => o.source_ref === 'sr_triv'));
  check('HISTORY: the corpus holds ONLY retired rows', obs2.history_for_person('p_lee010').every((o) => o.dismissed));
  check('HISTORY: it rides the prompt as UNNUMBERED background', /Background \(older observations, already retired/.test(last_synth_prompt) && /- \(topic, [\d-]+\) Talk about: a friend's trouble spelling/.test(last_synth_prompt));
  check('HISTORY: background is never given a [n] label (decay refs stay unambiguous)', !/\[\d+\][^\n]*trouble spelling/.test(last_synth_prompt));
  check('HISTORY: the "noticed" surface still shows only active rows', !obs2.list_for_person('p_lee010', { user_id: 'jasper', tier: 'owner' }, { limit: 50 }).some((o) => o.source_ref === 'sr_triv'));
  check('DEPTH: evidence count now spans window + retired corpus', !!lee_syn2 && lee_syn2.source_observation_count > obs2.all_active_for_person('p_lee010').length);

  // A. NO-REGRESS — a thin refine pass must never blank an earned portrait.
  const earned = syn2.get_for_person('p_lee010', { user_id: 'jasper', tier: 'owner' })!;
  const blanked = merge_refinement(earned, { summary: '  ', themes: [], communication: '', facts: {}, followups: [], decay: [] });
  check('NO-REGRESS: an empty refine keeps the prior summary/themes/communication', blanked.summary === earned.summary && blanked.themes.length === earned.themes.length && blanked.communication === earned.communication);
  const improved = merge_refinement(earned, { summary: 'deeper portrait', themes: ['t'], communication: 'clearer voice', facts: {}, followups: [], decay: [] });
  check('NO-REGRESS: a real refinement still wins', improved.summary === 'deeper portrait' && improved.communication === 'clearer voice');
  const first_pass = merge_refinement(null, { summary: 's', themes: [], communication: '', facts: {}, followups: [], decay: [] });
  check('NO-REGRESS: a first pass with no prior is unaffected', first_pass.summary === 's' && first_pass.themes.length === 0);

  // B. RETENTION — the floor under the corpus (keep evidence ≠ keep an archive).
  const db_prune = new Database(':memory:');
  const obs_prune = new PersonObservations(db_prune);
  obs_prune.record({ person_id: 'p_lee010', user_id: 'jasper', kind: 'topic', summary: 'ancient', source_type: 'imessage', source_ref: 'old', confidence: 0.5, private_to: 'jasper', observed_at: '2024-01-01T00:00:00Z' });
  obs_prune.record({ person_id: 'p_lee010', user_id: 'jasper', kind: 'topic', summary: 'recent', source_type: 'imessage', source_ref: 'new', confidence: 0.5, private_to: 'jasper', observed_at: '2026-06-24T00:00:00Z' });
  obs_prune.dismiss_many(obs_prune.all_active_for_person('p_lee010').map((o) => o.id));
  obs_prune.record({ person_id: 'p_lee010', user_id: 'jasper', kind: 'open_loop', summary: 'still open from long ago', source_type: 'imessage', source_ref: 'live', confidence: 0.7, private_to: 'jasper', observed_at: '2024-01-01T00:00:00Z' });
  const pruned_n = obs_prune.prune_dismissed(NOW2, 365);
  check('RETENTION: a dismissed row past the window is hard-deleted', pruned_n === 1 && !obs_prune.history_for_person('p_lee010').some((o) => o.source_ref === 'old'));
  check('RETENTION: a recent dismissed row is kept as corpus', obs_prune.history_for_person('p_lee010').some((o) => o.source_ref === 'new'));
  check('RETENTION: an ACTIVE row is never pruned, however old', obs_prune.all_active_for_person('p_lee010').some((o) => o.source_ref === 'live'));
  check('RETENTION: 0 days disables the prune', obs_prune.prune_dismissed(NOW2, 0) === 0);
  db_prune.close();

  // Edge-dedup: a NEW observation makes Kim dirty again; the SAME open loop must
  // NOT re-file the followup (exists_for_signature).
  rec2('topic', "Talk about: Kim's upcoming trip", 'sr_trip', '2026-06-24T11:00:00Z');
  const h2 = await run_people_synthesis_sweep({ db: db2, memory, llm: synthLLM, proposals, now: () => NOW2 });
  check('re-sweep is dirty (new obs) → re-synthesizes', h2.people === 1);
  check('FOLLOWUP edge-dedup: same open loop does not re-file', filed.length === 1);

  // Dirty-gate: no new observation → an unchanged contact costs no synthesis.
  const before_calls = synth_calls;
  const h3 = await run_people_synthesis_sweep({ db: db2, memory, llm: synthLLM, proposals, now: () => NOW2 });
  check('dirty-gate: unchanged contact is skipped (no LLM call, people 0)', h3.people === 0 && synth_calls === before_calls);

  // Followups independently disableable (themes/facts-only run).
  process.env.HEARTH_PEOPLE_SYNTHESIS_FOLLOWUPS = '0';
  rec2('open_loop', 'Open loop — you owe Kim: confirm the venue', 'sr_loop2', '2026-06-24T12:00:00Z', 0.7);
  const synthLLM2: EnrichLLM = { for_role: () => ({ provider: { complete: async (req) => {
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    const refOf = (needle: string): number => { const m = user.match(new RegExp(`\\[(\\d+)\\][^\\n]*${needle}`, 'i')); return m ? Number(m[1]) : 0; };
    return { content: JSON.stringify({ summary: 'x', themes: [], facts: {}, followups: [{ ref: refOf('confirm the venue'), action: 'confirm venue' }], decay: [] }) };
  } } }) };
  const h4 = await run_people_synthesis_sweep({ db: db2, memory, llm: synthLLM2, proposals, now: () => NOW2 });
  check('FOLLOWUPS disabled: no new proposal despite an actionable loop', h4.people === 1 && filed.length === 1);
  delete process.env.HEARTH_PEOPLE_SYNTHESIS_FOLLOWUPS;

  // Isolated db: deterministic decay backstop + fail-open + kill switch.
  const db3 = new Database(':memory:');
  const obs3 = new PersonObservations(db3);
  const syn3 = new PersonSynthesisStore(db3);
  // An old `mention` (TTL 7d) is aged out; a fresh `topic` survives.
  obs3.record({ person_id: 'p_old01', user_id: 'jasper', kind: 'mention', summary: 'mentioned in conversation', source_type: 'chat', source_ref: 'm1', confidence: 0.6, private_to: 'jasper', observed_at: '2026-05-01T00:00:00Z' });
  obs3.record({ person_id: 'p_lee010', user_id: 'jasper', kind: 'topic', summary: 'fresh topic', source_type: 'imessage', source_ref: 'fresh1', confidence: 0.5, private_to: 'jasper', observed_at: '2026-06-24T09:00:00Z' });
  const thrower2: EnrichLLM = { for_role: () => ({ provider: { complete: async () => { throw new Error('deep tier down'); } } }) };
  const hfail = await run_people_synthesis_sweep({ db: db3, memory, llm: thrower2, now: () => NOW2 });
  check('DETERMINISTIC DECAY: a 54-day-old mention is aged out (TTL 7d)', hfail.decayed >= 1 && obs3.all_active_for_person('p_old01').length === 0);
  check('DETERMINISTIC DECAY: a same-day topic survives', obs3.all_active_for_person('p_lee010').some((o) => o.source_ref === 'fresh1'));
  check('FAIL-OPEN: a deep-tier outage synthesizes nobody, never throws', hfail.enabled && hfail.people === 0 && syn3.get_for_person('p_lee010', { user_id: 'jasper', tier: 'owner' }) === null);

  // Cadence gate: inside the interval, the whole sweep skips.
  process.env.HEARTH_PEOPLE_SYNTHESIS_MIN_INTERVAL_H = '168';
  const hcad = await run_people_synthesis_sweep({ db: db2, memory, llm: synthLLM, proposals, now: () => NOW2 });
  check('cadence gate skips inside interval', hcad.enabled && hcad.skipped && hcad.people === 0);
  process.env.HEARTH_PEOPLE_SYNTHESIS_MIN_INTERVAL_H = '0';

  // Kill switch.
  process.env.HEARTH_PEOPLE_SYNTHESIS = '0';
  const hoff = await run_people_synthesis_sweep({ db: db3, memory, llm: synthLLM, proposals, now: () => NOW2 });
  check('kill switch: dark → no-op', !hoff.enabled && hoff.people === 0);

  // Job-tool shape (guards the Tool wired into Kate's pack + the YAML job).
  const synth_tool = create_synth_tool({ db: db2, proposals } as never);
  check('synth tool name', synth_tool.name === 'synthesize_person_dossiers');
  check('synth tool is write_internal + volatile', synth_tool.risk === 'write_internal' && synth_tool.volatile === true);
  check('synth tool gated on write_vault_general', (synth_tool.required_capabilities ?? []).includes('write_vault_general'));
  const darkSynth = await synth_tool.execute({}, { memory, llm: synthLLM, now: NOW2, intent_id: 'x' } as never);
  check('synth tool dark no-op when flag off', darkSynth.enabled === false);

  delete process.env.HEARTH_PEOPLE_SYNTHESIS;
  delete process.env.HEARTH_PEOPLE_SYNTHESIS_MIN_INTERVAL_H;
  db2.close();
  db3.close();

  // ── I. life-event proactive offers (Phase C) ─────────────────────────────
  section('I. life-event offers');
  check('strip_life_event_prefix drops the "Life event —" lead', strip_life_event_prefix('Life event — Kim is traveling to Bali') === 'Kim is traveling to Bali');
  process.env.HEARTH_LIFE_EVENT_OFFERS = '1';
  const db4 = new Database(':memory:');
  const obs4 = new PersonObservations(db4);
  // p_lee010 is already seeded (section H). Stage three life events: one actionable
  // + recent (travel), one recent but NOT actionable (a transient cold), one
  // actionable but OUTSIDE the recency window (an old move).
  const recL = (summary: string, source_ref: string, observed_at: string): void => {
    obs4.record({ person_id: 'p_lee010', user_id: 'jasper', kind: 'life_event', summary, source_type: 'imessage', source_ref, confidence: 0.6, private_to: 'jasper', observed_at });
  };
  recL('Life event — Kim is traveling to Bali and Korea.', 'le_travel', '2026-06-24T10:00:00Z');
  recL('Life event — Kim caught a cold last week', 'le_cold', '2026-06-24T10:01:00Z');
  recL('Life event — Kim moved into a new apartment downtown', 'le_old', '2026-05-01T00:00:00Z');

  // Fake triage LLM: resolves refs by NEEDLE (order-independent), marks travel
  // actionable + the cold not.
  const triageLLM = { for_role: () => ({ provider: { complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    if (!/triaging life events/.test(sys)) return { content: '{}' };
    const refOf = (needle: string): number => { const m = user.match(new RegExp(`\\[(\\d+)\\][^\\n]*${needle}`, 'i')); return m ? Number(m[1]) : 0; };
    return { content: JSON.stringify({ events: [
      { ref: refOf('Bali'), warrants_offer: true, kind: 'travel', offer: 'wish them a great trip and check their flights' },
      { ref: refOf('cold'), warrants_offer: false, kind: 'health', offer: 'check in' },
    ] }) };
  } } }) } as unknown as LLMRouter;

  const le_filed: NewProposal[] = [];
  const le_sigs = new Set<string>();
  const le_sig_key = (s: CategorySignature): string => `${s.specialist_id}|${s.kind}|${s.category}|${s.anchor ?? ''}`;
  const le_proposals = {
    create: (p: NewProposal): string => { le_filed.push(p); le_sigs.add(le_sig_key(p.signature)); return `pr_${le_filed.length}`; },
    exists_for_signature: (s: CategorySignature): boolean => le_sigs.has(le_sig_key(s)),
  } as unknown as import('../src/core/proposals').ProposalsStore;
  const NOW4 = new Date('2026-06-25T12:00:00Z');
  const le_deps = { db: db4, memory, proposals: le_proposals, llm: triageLLM, now: () => NOW4 };

  const i1 = await run_scan_life_events(le_deps, 21);
  check('recency gate: the 55-day-old move is excluded (2 candidates, not 3)', i1.candidates === 2);
  check('ACTIONABILITY: only the travel milestone filed (cold skipped)', i1.filed === 1 && le_filed.length === 1);
  check('offer is a cordoned action_proposal anchored on the observation', le_filed[0]!.kind === 'action_proposal' && le_filed[0]!.signature.anchor === 'p_lee010:le_travel' && le_filed[0]!.signature.category === 'life_event_offer');
  check('offer payload carries kind + the Want-me-to phrasing', (le_filed[0]!.payload as { life_event_kind?: string }).life_event_kind === 'travel' && /Want me to wish them a great trip/.test(le_filed[0]!.rationale));
  check('rationale strips the body\'s trailing period (no "Korea.. Want me to")', !le_filed[0]!.rationale.includes('..') && /Korea\. Want me to/.test(le_filed[0]!.rationale));
  check('offer cordoned to the observation owner', le_filed[0]!.user_id === 'jasper');

  const i2 = await run_scan_life_events(le_deps, 21);
  check('edge-dedup: the same travel event does not re-offer', i2.filed === 0);

  // Fail-CLOSED: an LLM outage offers NOTHING (a proactive surface skips on noise).
  const db5 = new Database(':memory:');
  new PersonObservations(db5).record({ person_id: 'p_lee010', user_id: 'jasper', kind: 'life_event', summary: 'Life event — Kim got engaged', source_type: 'imessage', source_ref: 'le_eng', confidence: 0.6, private_to: 'jasper', observed_at: '2026-06-24T10:00:00Z' });
  const thrower_le = { for_role: () => ({ provider: { complete: async () => { throw new Error('planner down'); } } }) } as unknown as LLMRouter;
  const ifail_filed: NewProposal[] = [];
  const ifail = await run_scan_life_events({ db: db5, memory, proposals: { create: (p: NewProposal) => { ifail_filed.push(p); return 'x'; }, exists_for_signature: () => false } as unknown as import('../src/core/proposals').ProposalsStore, llm: thrower_le, now: () => NOW4 }, 21);
  check('FAIL-CLOSED: an LLM outage files no offers (1 candidate, 0 filed)', ifail.candidates === 1 && ifail.filed === 0 && ifail_filed.length === 0);

  // Kill switch + tool shape.
  process.env.HEARTH_LIFE_EVENT_OFFERS = '0';
  const ioff = await run_scan_life_events(le_deps, 21);
  check('kill switch: dark → no-op', !ioff.enabled && ioff.filed === 0);
  const le_tool = create_life_events_tool({ db: db4, proposals: le_proposals } as never);
  check('scan_life_events tool shape', le_tool.name === 'scan_life_events' && le_tool.risk === 'write_internal' && le_tool.volatile === true && (le_tool.required_capabilities ?? []).includes('monitor_life_events'));
  const darkLE = await le_tool.execute({ within_days: 21 }, { memory, llm: triageLLM, now: NOW4, intent_id: 'x' } as never);
  check('scan_life_events dark no-op when flag off', darkLE.enabled === false);
  delete process.env.HEARTH_LIFE_EVENT_OFFERS;
  db4.close();
  db5.close();

  // ── J. "before you see them" meeting prep (Phase B) ──────────────────────
  section('J. meeting prep');
  const db6 = new Database(':memory:');
  const obs6 = new PersonObservations(db6);
  const syn6 = new PersonSynthesisStore(db6);
  // Kim: an open loop + a synthesis narrative + (in the note) an overdue cadence.
  obs6.record({ person_id: 'p_lee010', user_id: 'jasper', kind: 'open_loop', summary: 'Open loop — you owe Kim: email Chris Barrett re the vote', source_type: 'imessage', source_ref: 'ol1', confidence: 0.7, private_to: 'jasper', observed_at: '2026-06-24T10:00:00Z' });
  syn6.upsert({ person_id: 'p_lee010', user_id: 'jasper', summary: 'Kim is a close friend in a demanding tech career.', themes: ['Kim is traveling to Bali and Korea.', 'Kim works in defense tech.'], communication: 'Kim texts in short bursts and opens with a joke.', source_observation_count: 5, last_observation_ts: '2026-06-24T10:00:00Z', private_to: 'jasper' });

  const owner_caller = { user_id: 'jasper', tier: 'owner' } as import('../src/memory/private_to').Caller;
  // Pure-assembly: with content vs without.
  const prep = assemble_meeting_prep({ db: db6, person_id: 'p_lee010', person_name: 'Kim', fm: { contact_cadence: 'weekly', last_contacted: '2026-06-01' }, caller: owner_caller, now: NOW2, event: { title: 'Dinner with Kim', when_iso: '2026-06-26T19:00:00Z' } });
  check('assemble: has_content with loops/themes/overdue', prep.has_content === true);
  check('assemble: header names the meeting', /\*\*Seeing Kim\*\* — Dinner with Kim/.test(prep.markdown));
  check('assemble: surfaces the open loop', /Open with you:/.test(prep.markdown) && /email Chris Barrett/.test(prep.markdown));
  check('assemble: surfaces what to bring up (themes)', /Worth bringing up:/.test(prep.markdown) && /Bali/.test(prep.markdown));
  check('assemble: flags overdue against the weekly cadence', prep.overdue_days !== null && /overdue for your weekly cadence/.test(prep.markdown));
  check('assemble: carries HOW THEY TALK from the dossier', /\*\*How they talk:\*\* Kim texts in short bursts/.test(prep.markdown) && /short bursts/.test(prep.communication));
  const prep_empty = assemble_meeting_prep({ db: db6, person_id: 'p_nobody', person_name: 'Nobody', fm: {}, caller: owner_caller, now: NOW2 });
  check('assemble: has_content false when nothing to say', prep_empty.has_content === false);
  // A communication portrait alone must not manufacture a prep card on the edge.
  const db6b = new Database(':memory:');
  new PersonSynthesisStore(db6b).upsert({ person_id: 'p_solo', user_id: 'jasper', summary: '', themes: [], communication: 'Talks fast.', source_observation_count: 1, last_observation_ts: null, private_to: 'jasper' });
  const prep_comms_only = assemble_meeting_prep({ db: db6b, person_id: 'p_solo', person_name: 'Solo', fm: {}, caller: owner_caller, now: NOW2 });
  check('assemble: communication alone is not enough to surface a prep', prep_comms_only.has_content === false && !/How they talk/.test(prep_comms_only.markdown));
  db6b.close();
  // cordon: a different user sees none of Kim's owner-private prep.
  const prep_other = assemble_meeting_prep({ db: db6, person_id: 'p_lee010', person_name: 'Kim', fm: {}, caller: { user_id: 'sam', tier: 'household' } as import('../src/memory/private_to').Caller, now: NOW2 });
  check('assemble: CORDON — another user gets no owner-private content', prep_other.open_loops.length === 0 && prep_other.ask_about.length === 0);

  // The scan: an event naming Kim → a briefing; one naming a contentless person → none.
  process.env.HEARTH_MEETING_PREP = '1';
  const memory_j = {
    // Full names → exercises first-name-when-unique matching; a genealogy ancestor
    // (note_path '-ancestor.md') must be excluded from the candidate set.
    query_people: () => [
      { id: 'p_lee010', name: 'Kim Reyes', preferred_name: 'Kim', relationship: 'friend', note_path: 'People/Kim.md', frontmatter_json: JSON.stringify({ type: 'person', relationship: 'friend' }) },
      { id: 'p_mara01', name: 'Mara Quinn', preferred_name: null, relationship: 'friend', note_path: 'People/Mara.md', frontmatter_json: '{}' },
      { id: 'p_self01', name: 'Jasper', preferred_name: null, relationship: 'self', note_path: 'People/Jasper.md', frontmatter_json: '{}' },
      { id: 'p_anc001', name: 'Joseph Rioux', preferred_name: null, relationship: 'family', note_path: 'People/Joseph-Rioux-ancestor.md', frontmatter_json: '{}' },
    ],
    upcoming_life_events_uncordoned: () => [
      { id: 'ev1', title: 'Dinner with Kim', event_date: '2026-06-26T19:00:00Z', owner: 'jasper', private_to: 'jasper', frontmatter_json: '{}', category: null },
      { id: 'ev2', title: 'Lunch with Mara', event_date: '2026-06-26T12:00:00Z', owner: 'jasper', private_to: 'jasper', frontmatter_json: '{}', category: null },
      { id: 'ev3', title: 'Coffee with Jasper', event_date: '2026-06-26T09:00:00Z', owner: 'jasper', private_to: 'jasper', frontmatter_json: '{}', category: null },
      { id: 'ev4', title: "Joseph's family reunion", event_date: '2026-06-26T15:00:00Z', owner: 'jasper', private_to: 'jasper', frontmatter_json: '{}', category: null },
      { id: 'ev5', title: "Kim's Birthday", event_date: '2026-06-26T00:00:00Z', owner: 'jasper', private_to: 'jasper', frontmatter_json: '{}', category: 'birthday' },
      { id: 'ev6', title: 'Kim Payday', event_date: '2026-06-26T00:00:00Z', owner: 'jasper', private_to: 'jasper', frontmatter_json: '{}', category: null },
    ],
    read_note: (path: string) => path === 'People/Kim.md' ? { frontmatter: { contact_cadence: 'weekly', last_contacted: '2026-06-01' }, body: '' } : { frontmatter: {}, body: '' },
    log_action: () => 'a',
  } as unknown as MemoryClient;
  // Fake meeting-gate LLM: a "with"/social title is a meeting; "Payday"/reminder is not.
  const gateLLM = { for_role: () => ({ provider: { complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
    const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
    if (!/social MEETING or VISIT/.test(sys)) return { content: '{}' };
    const results: Array<{ ref: number; is_meeting: boolean }> = [];
    for (const line of user.split('\n')) {
      const m = line.match(/^\[(\d+)\] event "([^"]*)"/);
      if (!m) continue;
      const title = m[2]!.toLowerCase();
      results.push({ ref: Number(m[1]), is_meeting: /dinner|lunch|coffee|visit|beer|drinks|brunch|breakfast/.test(title) && !/payday|bill|reminder/.test(title) });
    }
    return { content: JSON.stringify({ results }) };
  } } }) } as unknown as LLMRouter;
  const mp_filed: NewProposal[] = [];
  const mp_sigs = new Set<string>();
  const mp_key = (s: CategorySignature): string => `${s.specialist_id}|${s.kind}|${s.category}|${s.anchor ?? ''}`;
  const mp_proposals = { create: (p: NewProposal): string => { mp_filed.push(p); mp_sigs.add(mp_key(p.signature)); return `pr_${mp_filed.length}`; }, exists_for_signature: (s: CategorySignature): boolean => mp_sigs.has(mp_key(s)) } as unknown as import('../src/core/proposals').ProposalsStore;
  const mp_deps = { db: db6, memory: memory_j, proposals: mp_proposals, llm: gateLLM, now: () => NOW2 };

  const j1 = await run_scan_meeting_prep(mp_deps, 3);
  check('scan: name-matched 3 candidates (Kim×2 + Mara); self + genealogy + birthday excluded', j1.meetings === 3);
  check('scan: GATE — only the real meeting filed (Dinner✓; "Kim Payday" gated out; Mara empty)', j1.filed === 1 && mp_filed.length === 1 && (mp_filed[0]!.payload as { event_name?: string }).event_name === 'Dinner with Kim');
  check('scan: filed a briefing kind, cordon-scoped + anchored on person+event', mp_filed[0]!.kind === 'briefing' && mp_filed[0]!.user_id === 'jasper' && mp_filed[0]!.signature.category === 'meeting_prep' && /^p_lee010:dinner with kim/.test(mp_filed[0]!.signature.anchor ?? ''));
  check('scan: the matched person is the full-name contact (Kim Reyes), not a genealogy hit', (mp_filed[0]!.payload as { person_id?: string; person_name?: string }).person_id === 'p_lee010' && (mp_filed[0]!.payload as { person_name?: string }).person_name === 'Kim Reyes');
  check('scan: briefing payload keys topic+for_event (self-expiry/supersession)', (mp_filed[0]!.payload as { topic?: string; for_event?: string }).topic === 'prep:Kim Reyes' && !!(mp_filed[0]!.payload as { for_event?: string }).for_event);
  check('scan: rationale is the assembled heads-up', /Seeing Kim Reyes/.test(mp_filed[0]!.rationale) && /email Chris Barrett/.test(mp_filed[0]!.rationale));

  const j2 = await run_scan_meeting_prep(mp_deps, 3);
  check('scan: edge-dedup — same meeting does not re-file', j2.filed === 0);

  // Fail-CLOSED: no LLM gate → no preps (a proactive surface skips on outage).
  const mp_filed2: NewProposal[] = [];
  const mp_proposals2 = { create: (p: NewProposal): string => { mp_filed2.push(p); return 'x'; }, exists_for_signature: (): boolean => false } as unknown as import('../src/core/proposals').ProposalsStore;
  const jfc = await run_scan_meeting_prep({ db: db6, memory: memory_j, proposals: mp_proposals2, llm: undefined, now: () => NOW2 }, 3);
  check('scan: FAIL-CLOSED — no LLM gate → no preps despite name matches', jfc.meetings === 3 && jfc.filed === 0 && mp_filed2.length === 0);

  process.env.HEARTH_MEETING_PREP = '0';
  const joff = await run_scan_meeting_prep(mp_deps, 3);
  check('scan: kill switch → no-op', !joff.enabled && joff.filed === 0);
  const mp_tool = create_meeting_prep_tool({ db: db6, proposals: mp_proposals } as never);
  check('scan_meeting_prep tool shape', mp_tool.name === 'scan_meeting_prep' && mp_tool.risk === 'write_internal' && mp_tool.volatile === true && (mp_tool.required_capabilities ?? []).includes('monitor_meeting_prep'));
  delete process.env.HEARTH_MEETING_PREP;
  db6.close();

  delete process.env.HEARTH_IMESSAGE_OBSERVER;
  delete process.env.HEARTH_IMESSAGE_DISTILL_MIN_INTERVAL_H;
  db.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'} imessage-observer: ${pass} passed, ${fail} failed (${llm_calls} llm calls)`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
