export {};
/**
 * smoke:hiring — the agentic hiring flow, end to end.
 *
 * Self-contained: a temp vault + SQLite, kate & trainer configs copied
 * into a temp specialists dir. Exercises:
 *   - propose_hire (Kate) → consults analyze_capability_gaps (Beatrice)
 *     → files a two-tier hiring packet as a Proposal
 *   - the gap analysis splitting a wishlist into day-1 vs build-queue
 *   - approving the proposal and POST /from-packet materializing the
 *     specialist + flagging the build queue to Beatrice
 *   - the persona shape gate: a drafter that returns reasoning-shaped
 *     output (the Harper chain-of-thought leak, 2026-06-10) is retried
 *     once and then lands on the deterministic template, never stored
 *
 * HEARTH_TEST_MODE=1 templates the persona so there is no LLM call.
 *
 *   bun run smoke:hiring
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { SpecialistRegistry } from '@core/specialist';
import { ProposalsStore } from '@core/proposals';
import { SpecialistInbox } from '@memory/stores/conversations';
import { ToolRegistry } from '@core/tool_registry';
import { load_extra_capabilities } from '@core/capabilities';
import { create as create_analyze } from '@specialists/trainer/tools/analyze_capability_gaps';
import { make_propose_hire } from '@specialists/kate/tools/propose_hire';
import { create_hire_router } from '../src/app/routes/hire';
import {
  HiringPacketSchema,
  draft_persona_validated,
  validate_persona_draft,
} from '@core/hiring';
import type { ToolDeps } from '@core/tool_deps';
import type { Tool, ToolContext } from '@core/tool';
import type { SpecialistRuntime } from '@core/specialist_runtime';

process.env.HEARTH_TEST_MODE = '1';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(resolve(tmpdir(), 'hearth-hiring-'));
const vault = resolve(dir, 'vault');
mkdirSync(vault, { recursive: true });
const specialists_dir = resolve(dir, 'specialists');
mkdirSync(specialists_dir, { recursive: true });

// Copy kate & trainer configs into the temp specialists dir.
const seed_dir = resolve(import.meta.dir, '..', 'config', 'specialists');
for (const id of ['kate', 'trainer']) {
  writeFileSync(
    resolve(specialists_dir, `${id}.yaml`),
    readFileSync(resolve(seed_dir, `${id}.yaml`), 'utf8'),
    'utf8',
  );
}
load_extra_capabilities(resolve(import.meta.dir, '..', 'config', 'capabilities.yaml'));

const db = open_db(resolve(dir, 'hearth.db'));

try {
  const specialists = new SpecialistRegistry(specialists_dir);
  const proposals = new ProposalsStore(db);
  const inbox = new SpecialistInbox(db);
  const tools = new ToolRegistry();

  // Register the two new tools into the registry.
  const tool_deps = { db, proposals, specialists, tool_registry: tools } as unknown as ToolDeps;
  tools.register(create_analyze(tool_deps));
  tools.register(make_propose_hire(proposals, specialists, tools) as Tool);

  const kate = specialists.get('kate');
  const trainer = specialists.get('trainer');
  check('kate and trainer configs loaded', !!kate && !!trainer);
  if (!kate || !trainer) throw new Error('setup: kate/trainer missing');

  const ctx = { now: new Date(), intent_id: 'smoke-hiring' } as unknown as ToolContext;

  // ── analyze_capability_gaps: direct consult ────────────────────────────
  const gap_out = await tools.invoke(
    'analyze_capability_gaps',
    { capability_wishlist: ['read_vault', 'totally_made_up_capability'] },
    ctx,
    trainer.granted,
    'trainer',
  );
  check('analyze_capability_gaps runs for Beatrice', gap_out.ok === true);
  const gaps = gap_out.result as { day_1: string[]; build_queue: string[] };
  check(
    'gap analysis puts a known token on day-1',
    gaps.day_1.includes('read_vault'),
  );
  check(
    'gap analysis puts an unknown token on the build queue',
    gaps.build_queue.includes('totally_made_up_capability'),
  );

  // ── propose_hire: Kate files a hiring packet ───────────────────────────
  const hire_out = await tools.invoke(
    'propose_hire',
    {
      id: 'harper',
      name: 'Harper',
      role: 'Travel Coordinator',
      voice: 'warm',
      description:
        'Plans and tracks travel — flights, lodging, itineraries — and keeps trip logistics from slipping.',
      capability_wishlist: ['read_home_assistant', 'read_calendar', 'read_garage_camera'],
    },
    ctx,
    kate.granted,
    'kate',
  );
  check('propose_hire runs for Kate', hire_out.ok === true);
  const hire = hire_out.result as {
    proposal_id: string;
    day_1_capabilities: string[];
    build_queue: string[];
  };
  check(
    'propose_hire splits the wishlist two ways',
    hire.day_1_capabilities.includes('read_home_assistant') &&
      hire.day_1_capabilities.includes('read_calendar') &&
      hire.build_queue.includes('read_garage_camera'),
  );

  // The proposal carries a valid hiring packet.
  const proposal = proposals.get(hire.proposal_id);
  check('propose_hire filed a proposal', !!proposal && proposal.status === 'pending');
  const packet = HiringPacketSchema.safeParse(
    JSON.parse(proposal?.payload_json ?? '{}'),
  );
  check('the proposal payload is a valid hiring packet', packet.success);
  check(
    'the packet carries a drafted persona',
    packet.success && packet.data.specialist.persona.includes('Harper'),
  );

  // ── from-packet: approve, then materialize ─────────────────────────────
  const hire_router = create_hire_router({
    specialists_dir,
    vault_root: vault,
    specialists,
    runtime: {} as unknown as SpecialistRuntime,
    proposals,
    inbox,
  });

  // Before approval, /from-packet refuses.
  const early = await hire_router.request('/from-packet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposal_id: hire.proposal_id }),
  });
  check('/from-packet refuses an un-approved packet', early.status === 409);

  proposals.decide(hire.proposal_id, 'approve');
  const res = await hire_router.request('/from-packet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposal_id: hire.proposal_id }),
  });
  check('/from-packet materializes the specialist (200)', res.status === 200);
  const body = (await res.json()) as { id: string; build_queue_flagged: number };
  check('the new specialist is registered', specialists.has('harper'));

  const harper = specialists.get('harper');
  check(
    'day-1 capabilities are granted',
    !!harper && harper.granted.has('read_home_assistant') && harper.granted.has('read_calendar'),
  );
  check(
    'build-queue capability is NOT granted',
    !!harper && !harper.granted.has('read_garage_camera' as never),
  );
  check(
    'the harper.yaml file was written',
    existsSync(resolve(specialists_dir, 'harper.yaml')),
  );

  check(
    'the build queue is flagged to Beatrice (trainer)',
    inbox
      .unread_for('trainer')
      .some(
        (m) => m.body_md.includes('New tool needed') && m.body_md.includes('read_garage_camera'),
      ),
  );
  check('from-packet reports the build-queue count', body.build_queue_flagged === 1);
  check(
    'the proposal is marked executed',
    proposals.get(hire.proposal_id)?.status === 'executed',
  );

  // Re-running /from-packet is rejected — the proposal is no longer approved.
  const again = await hire_router.request('/from-packet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposal_id: hire.proposal_id }),
  });
  check('/from-packet is not replayable', again.status === 409);

  // ── persona shape gate: reasoning dumps never become personas ──────────
  // Mirrors the live Harper packet (2026-06-10) whose stored persona began
  // "Here's a thinking process: 1. Analyze User Input…".
  const REASONING_DUMP =
    "Here's a thinking process: 1. Analyze User Input: The user wants a " +
    'Capture Routing Specialist named Harper. 2. Identify the persona ' +
    'requirements: 150-300 words, second person, warm prose. 3. Draft: open ' +
    'with the name and role, describe how she handles captures, close ' +
    'warmly. 4. Review the draft against the constraints before output.';
  const VALID_PERSONA =
    "You are Harper, the household's Capture Routing Specialist. You watch " +
    'every photo, voice memo, and shared link that lands in the inbox and ' +
    'make sure each one reaches the right colleague with the right context. ' +
    'You are precise about evidence — you cite the signal that drove a ' +
    'routing call rather than guessing — and warm with people, because a ' +
    'capture is always a small act of trust. You are new here: your library ' +
    'and memory start empty, and you get up to speed as Jasper adds materials.';

  check(
    'shape gate rejects a reasoning dump',
    validate_persona_draft(REASONING_DUMP, 'Harper').ok === false,
  );
  check(
    'shape gate accepts a real persona',
    validate_persona_draft(VALID_PERSONA, 'Harper').ok === true,
  );
  check(
    'shape gate accepts a markdown-decorated opener',
    validate_persona_draft(`**${VALID_PERSONA}**`, 'Harper').ok === true,
  );
  check(
    'shape gate rejects a leaked think tag',
    validate_persona_draft(`<think>plan it</think>\n${VALID_PERSONA}`, 'Harper').ok === false,
  );
  check(
    'shape gate rejects a runaway draft past the word budget',
    validate_persona_draft('You are Harper, ' + 'detail '.repeat(460), 'Harper').ok === false,
  );
  check(
    'shape gate rejects a draft that never names the hire',
    validate_persona_draft(
      VALID_PERSONA.replaceAll('Harper', 'the new specialist'),
      'Harper',
    ).ok === false,
  );
  check(
    'shape gate rejects a degenerate stub',
    validate_persona_draft('You are Harper.', 'Harper').ok === false,
  );

  // ── draft → validate → retry-once → fallback, with scripted drafters ───
  const TEMPLATE_FALLBACK = 'TEMPLATE-FALLBACK';

  let dump_calls = 0;
  let saw_nudge = false;
  const dump_result = await draft_persona_validated({
    name: 'Harper',
    fallback: TEMPLATE_FALLBACK,
    log_label: 'smoke-hiring',
    attempt: async (retry_nudge) => {
      dump_calls++;
      if (retry_nudge) saw_nudge = true;
      return REASONING_DUMP;
    },
  });
  check(
    'a persistent reasoning dump lands on the template fallback',
    dump_result === TEMPLATE_FALLBACK,
  );
  check('the dump path retried exactly once', dump_calls === 2);
  check('the retry carried the corrective nudge', saw_nudge);

  let recover_calls = 0;
  const recover_result = await draft_persona_validated({
    name: 'Harper',
    fallback: TEMPLATE_FALLBACK,
    log_label: 'smoke-hiring',
    attempt: async () => (++recover_calls === 1 ? REASONING_DUMP : VALID_PERSONA),
  });
  check('a corrected retry is accepted', recover_result === VALID_PERSONA);

  let clean_calls = 0;
  const clean_result = await draft_persona_validated({
    name: 'Harper',
    fallback: TEMPLATE_FALLBACK,
    log_label: 'smoke-hiring',
    attempt: async () => {
      clean_calls++;
      return VALID_PERSONA;
    },
  });
  check(
    'a clean first draft is stored as-is, one call only',
    clean_result === VALID_PERSONA && clean_calls === 1,
  );

  const throw_result = await draft_persona_validated({
    name: 'Harper',
    fallback: TEMPLATE_FALLBACK,
    log_label: 'smoke-hiring',
    attempt: async () => {
      throw new Error('drafter offline');
    },
  });
  check('a throwing drafter lands on the template fallback', throw_result === TEMPLATE_FALLBACK);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:hiring OK'
    : `\nsmoke:hiring FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
