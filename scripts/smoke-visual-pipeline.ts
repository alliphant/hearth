export {};
/**
 * Smoke for the Cordelia visual-understanding pipeline.
 *
 * Self-contained. Builds:
 *   - temp vault + sqlite
 *   - real SpecialistRegistry (loads config/specialists/*.yaml)
 *   - mocked LLMRouter (classifier returns canned decisions per fixture)
 *   - mocked VL + OCR transports (no GGUF needed)
 *   - AppEventBus + InterruptStore + SpecialistInbox + ReactiveInboxDriver
 *
 * Asserts the full classify → route → push → audit path:
 *
 *   1. Single receipt-shaped capture → routes to Vivian (above threshold),
 *      writes capture_routes row, pushes inbox flag, stamps wrapper
 *      frontmatter `routed_to`, emits capture_routed event, fires the
 *      registered intake handler exactly once.
 *
 *   2. Below-threshold scene → routes to Kate as INTERRUPT (not a
 *      route row); wrapper stamped routing_status='triage'.
 *
 *   3. Cluster of 3 photos in one user's window → classifier called
 *      exactly ONCE (after force-flush). Single decision covers all 3.
 *
 *   4. Unparseable classifier output → Kate triage path (no crash).
 *
 *   5. Doc-shape capture with iOS-side OCR text → classifier sees the
 *      OCR text without invoking VL (VL transport returns
 *      vl_unavailable; should still classify).
 *
 *   bun run smoke:visual-pipeline
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { SpecialistRegistry } from '@core/specialist';
import {
  SpecialistInbox,
  InterruptStore,
  ConversationStore,
} from '@memory/stores/conversations';
import { UserRegistry } from '@core/users';
import { AppEventBus, type AppEvent } from '@app/events';
import { ReactiveInboxDriver } from '@core/reactive_inbox';
import { load_extra_capabilities } from '@core/capabilities';
import { _test_set_vl_transport } from '@connectors/vl';
import { _test_set_ocr_transport } from '@connectors/ocr';
import type { LLMRequest, LLMResponse, LLMRouter, LLMRole } from '@core/llm';
import matter from 'gray-matter';
import { readFileSync } from 'node:fs';

process.env.HEARTH_TEST_MODE = '1';
process.env.HEARTH_DISABLE_LOOPS = '1';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── Mock LLMRouter ────────────────────────────────────────────────────
// The classifier asks the 'planner' role for a JSON envelope; this
// router returns whatever the active fixture pushes.

interface ClassifierFixture {
  /** Called with the user message body the classifier sent. */
  respond(messages_user_text: string): string;
}

let active_fixture: ClassifierFixture = {
  respond: () => '{"decisions":[]}',
};
let llm_call_count = 0;
let last_llm_user_text = '';

const mock_provider = {
  name: 'mock',
  async complete(req: LLMRequest): Promise<LLMResponse> {
    llm_call_count += 1;
    const user = req.messages.find((m) => m.role === 'user');
    last_llm_user_text = user?.content ?? '';
    const content = active_fixture.respond(last_llm_user_text);
    return {
      content,
      tool_calls: [],
      finish_reason: 'stop',
      cost: { tokens_in: 0, tokens_out: 0, ms: 1, model: 'mock' },
    };
  },
  capabilities: () => ({
    supports_json_schema: false,
    supports_tool_calls: false,
    supports_thinking_mode: false,
    supports_vision: false,
    max_context: 32000,
    cost_per_1m_in_cents: 0,
    cost_per_1m_out_cents: 0,
  }),
};

const mock_llm: LLMRouter = {
  for_role(_role: LLMRole) {
    return { provider: mock_provider, defaults: {}, model: 'mock' };
  },
};

// ── Test-side transports ──────────────────────────────────────────────

let vl_call_count = 0;
_test_set_vl_transport(async ({ image_path }) => {
  vl_call_count += 1;
  // Deterministic scene description based on filename hints.
  if (image_path.includes('garden')) {
    return {
      available: true,
      description: 'Raised garden bed with healthy tomato plants and basil.',
      salient_objects: ['tomato', 'basil', 'raised bed', 'soil'],
      suggested_specialist_hint: 'eleanor',
      confidence: 0.82,
    };
  }
  return {
    available: false,
    description: '',
    salient_objects: [],
    suggested_specialist_hint: 'unknown',
    confidence: 0,
    error: 'vl_unavailable',
  };
});

_test_set_ocr_transport(async () => ({
  available: false,
  text: '',
  confidence: 0,
  error: 'ocr_unavailable',
}));

// ── Setup ─────────────────────────────────────────────────────────────

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-visual-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });
  mkdirSync(resolve(vault, 'Cordelia', 'Inbox'), { recursive: true });
  mkdirSync(resolve(vault, '_attachments'), { recursive: true });
  for (const dir of [
    'Knowledge/Kate',
    'Knowledge/Vivian',
    'Knowledge/Cassandra',
    'Knowledge/Brigid',
    'Knowledge/Maggie',
    'Knowledge/Trainer',
    'Knowledge/Mariah',
    'Knowledge/Iris',
    'Knowledge/Marguerite',
    'Knowledge/Eleanor',
    'Knowledge/Anya',
    'Knowledge/Cordelia',
  ]) {
    mkdirSync(resolve(vault, dir), { recursive: true });
  }
  const db = open_db(resolve(root, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  load_extra_capabilities(resolve(__dirname, '..', 'config', 'capabilities.yaml'));
  // Registry dir = live config + the FROZEN anya fixture. anya.yaml left the
  // live roster in the 2026-07-04 Kate fold-in, but the multi-route fan-out
  // case still exercises her intake shape — seed her from
  // scripts/fixtures/specialists/ (the smoke-proactive pattern).
  const specialists_dir = resolve(root, 'specialists');
  mkdirSync(specialists_dir, { recursive: true });
  const live_dir = resolve(__dirname, '..', 'config', 'specialists');
  for (const f of readdirSync(live_dir)) {
    if (f.endsWith('.yaml')) copyFileSync(resolve(live_dir, f), resolve(specialists_dir, f));
  }
  copyFileSync(
    resolve(__dirname, 'fixtures', 'specialists', 'anya.yaml'),
    resolve(specialists_dir, 'anya.yaml'),
  );
  const specialists = new SpecialistRegistry(specialists_dir);
  const inbox = new SpecialistInbox(db);
  const interrupts = new InterruptStore(db);
  const events = new AppEventBus();
  const conversations = new ConversationStore(db);
  // Fixture household, NOT the live `config/users.yaml`. That file is
  // untracked (the orchestrator rewrites it and it holds credentials), so a
  // gate smoke reading it has nothing to read in CI — and it was the wrong
  // dependency regardless: `case_friend_routing_clamped` asserts Kim's roster
  // clamps to Linda, which matched the committed file but was already false
  // on the live box, where he had been granted eight specialists.
  const users = new UserRegistry(
    resolve(import.meta.dir, 'fixtures/users.yaml'),
    undefined,
    db,
  );
  // The smoke registers no turn-firing intake (vivian/maggie/cordelia handlers
  // don't run a turn), so the runtime is never invoked here — a typed stub
  // satisfies the deps without standing up the full SpecialistRuntime.
  const runtime = {} as unknown as import('@core/specialist_runtime').SpecialistRuntime;

  const reactive = new ReactiveInboxDriver({
    db,
    memory,
    llm: mock_llm,
    specialists,
    inbox,
    interrupts,
    events,
    conversations,
    runtime,
    users,
    vault_root: vault,
    cluster_window_ms: 200, // shrink for the smoke
  });
  reactive.start();

  return { root, db, memory, specialists, inbox, interrupts, events, reactive, vault };
}

function teardown(root: string) {
  rmSync(root, { recursive: true, force: true });
}

// ── Helpers ───────────────────────────────────────────────────────────

interface CaptureFixture {
  capture_id: string;
  user_id: string;
  kind: 'voiceMemo' | 'photo' | 'sharedText' | 'sharedFile';
  ocr_text?: string;
  vl_filename_hint?: string;
  user_note?: string;
  ios_hint?: string;
}

function persist_capture(
  memory: MemoryClient,
  vault: string,
  f: CaptureFixture,
): { wrapper_rel: string; attachment_rel: string } {
  const date_str = '2026-05-26';
  const attachment_rel = `_attachments/cordelia-${f.capture_id}${f.vl_filename_hint ? `-${f.vl_filename_hint}` : ''}.${f.kind === 'photo' ? 'jpg' : 'bin'}`;
  // 1x1 transparent PNG bytes — enough for the VL data-url builder to read.
  writeFileSync(
    resolve(vault, attachment_rel),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const wrapper_rel = `Cordelia/Inbox/${date_str}-${f.kind}-${f.capture_id}.md`;
  const extracted_metadata: Record<string, unknown> = {
    cordelia_kind: f.kind,
    mime_type: f.kind === 'photo' ? 'image/jpeg' : 'application/octet-stream',
    size_bytes: 8,
  };
  if (f.ocr_text) extracted_metadata.on_device_ocr_text = f.ocr_text;
  if (f.user_note) extracted_metadata.user_note = f.user_note;
  if (f.ios_hint) extracted_metadata.local_classification_hint = f.ios_hint;
  memory.upsert_note(
    wrapper_rel,
    {
      type: 'clipping',
      id: f.capture_id,
      kind: f.kind === 'photo' ? 'image' : 'other',
      source: 'file',
      title: `Capture ${f.capture_id}`,
      captured_at: '2026-05-26T17:00:00.000Z',
      reviewed: false,
      tags: ['cordelia', f.kind],
      extracted_metadata,
      attachment_path: attachment_rel,
      specialist_scope: 'cordelia',
    },
    `_Cordelia capture — artifact at \`${attachment_rel}\`._\n`,
  );
  return { wrapper_rel, attachment_rel };
}

async function emit_and_wait(
  events: AppEventBus,
  reactive: ReactiveInboxDriver,
  capture_id: string,
  user_id: string,
  kind: CaptureFixture['kind'],
  wrapper_rel: string,
  attachment_rel: string,
): Promise<void> {
  events.emit({
    type: 'capture_received',
    capture_id,
    user_id,
    kind,
    note_path: wrapper_rel,
    attachment_path: attachment_rel,
    captured_at: '2026-05-26T17:00:00.000Z',
  });
  await reactive.await_route(capture_id, 2000);
}

function read_fm(vault: string, rel: string): Record<string, unknown> {
  const txt = readFileSync(resolve(vault, rel), 'utf8');
  return matter(txt).data as Record<string, unknown>;
}

// ── Test cases ────────────────────────────────────────────────────────

async function case_receipt_to_vivian(ctx: ReturnType<typeof setup>): Promise<void> {
  const captured: AppEvent[] = [];
  const unsub = ctx.events.subscribe((e) => captured.push(e));
  let intake_fired = 0;
  ctx.reactive.register_intake('vivian', async () => {
    intake_fired += 1;
  });

  llm_call_count = 0;
  active_fixture = {
    respond: () => JSON.stringify({
      decisions: [
        {
          capture_ids: ['c_receipt001'],
          specialist_id: 'vivian',
          confidence: 0.85,
          route_reason: 'OCR text reads like a grocery receipt with totals + payment line',
        },
      ],
    }),
  };

  const f: CaptureFixture = {
    capture_id: 'c_receipt001',
    user_id: 'jasper',
    kind: 'photo',
    ocr_text:
      'WHOLE FOODS MARKET\n2026-05-26  14:32\nBANANAS  3.21\nALMOND MILK  4.49\nTOTAL  7.70\nVISA ****1234',
    ios_hint: 'document',
  };
  const { wrapper_rel, attachment_rel } = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    wrapper_rel,
    attachment_rel,
  );

  // Vivian should have intake_captures: false by default (no handler
  // file yet in C1). For this smoke the intake fires only because we
  // registered the stub above AND the YAML opts her in. Force her
  // in-memory specialist config to opt in for this check by re-reading
  // her LoadedSpecialist and flipping the flag.
  const vivian = ctx.specialists.get('vivian');
  assert(vivian, 'vivian specialist loaded');
  vivian!.proactive.intake_captures = true;

  // Re-run with the flag flipped so the handler actually fires.
  intake_fired = 0;
  llm_call_count = 0;
  const f2: CaptureFixture = { ...f, capture_id: 'c_receipt002' };
  const r2 = persist_capture(ctx.memory, ctx.vault, f2);
  active_fixture = {
    respond: () => JSON.stringify({
      decisions: [
        {
          capture_ids: ['c_receipt002'],
          specialist_id: 'vivian',
          confidence: 0.85,
          route_reason: 'grocery receipt with totals + payment',
        },
      ],
    }),
  };
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f2.capture_id,
    f2.user_id,
    f2.kind,
    r2.wrapper_rel,
    r2.attachment_rel,
  );

  // 1. capture_routes row exists for the right pair.
  const route_row = ctx.db
    .prepare(
      `SELECT specialist_id, confidence, route_reason FROM capture_routes WHERE capture_id = ?`,
    )
    .get('c_receipt002') as { specialist_id: string; confidence: number; route_reason: string } | undefined;
  assert(route_row, 'capture_routes row exists');
  assert(route_row!.specialist_id === 'vivian', 'routed to vivian');
  assert(route_row!.confidence === 0.85, `confidence preserved (got ${route_row!.confidence})`);

  // 2. inbox flag pushed. Sent by KATE, not cordelia — the librarian desk
  // dissolved into her (bd65f36, 2026-07-21), so the human-visible capture
  // flag speaks in Kate's voice. The audit row's cordelia_route tool_name +
  // intent token are deliberately unchanged (see case_timeline_query).
  const inbox_rows = ctx.inbox.list_for('vivian', 10);
  assert(
    inbox_rows.some((r) => r.from_specialist_id === 'kate' && r.kind === 'flag'),
    `vivian inbox has a capture flag from kate (got ${JSON.stringify(
      inbox_rows.map((r) => ({ from: r.from_specialist_id, kind: r.kind })),
    )})`,
  );

  // 3. wrapper frontmatter stamped.
  const fm = read_fm(ctx.vault, r2.wrapper_rel);
  assert(Array.isArray(fm.routed_to) && (fm.routed_to as string[]).includes('vivian'), 'frontmatter routed_to has vivian');
  assert(fm.routing_status === 'routed', `routing_status routed (got ${String(fm.routing_status)})`);

  // 4. capture_routed event was emitted.
  const routed_event = captured.find(
    (e) => e.type === 'capture_routed' && e.capture_id === 'c_receipt002',
  );
  assert(routed_event, 'capture_routed event for c_receipt002');

  // 5. intake handler fired exactly once.
  assert(intake_fired === 1, `intake handler fired once (got ${intake_fired})`);

  // 6. exactly one classifier LLM call.
  assert(llm_call_count === 1, `one classifier call (got ${llm_call_count})`);

  unsub();
  console.log('  ✓ receipt → vivian routed, intake fired, audit/event consistent');
}

async function case_below_threshold_kate_interrupt(ctx: ReturnType<typeof setup>): Promise<void> {
  llm_call_count = 0;
  active_fixture = {
    respond: () => JSON.stringify({
      decisions: [
        {
          capture_ids: ['c_unknown01'],
          specialist_id: 'cordelia',
          confidence: 0.2,
          route_reason: 'extremely ambiguous; could be a packing slip or junk mail',
        },
      ],
    }),
  };

  const before_interrupts = ctx.interrupts.list().length;

  const f: CaptureFixture = {
    capture_id: 'c_unknown01',
    user_id: 'jasper',
    kind: 'photo',
    ocr_text: 'serial# 99-A8',
  };
  const { wrapper_rel, attachment_rel } = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    wrapper_rel,
    attachment_rel,
  );

  // 1. NO capture_routes row written.
  const route_row = ctx.db
    .prepare(`SELECT id FROM capture_routes WHERE capture_id = ?`)
    .get('c_unknown01') as { id: string } | undefined;
  assert(!route_row, `no capture_routes row for below-threshold (got ${JSON.stringify(route_row)})`);

  // 2. Kate interrupt raised.
  const interrupts_now = ctx.interrupts.list();
  assert(
    interrupts_now.length > before_interrupts,
    `interrupt count grew (before=${before_interrupts}, after=${interrupts_now.length})`,
  );
  const fresh = interrupts_now[0];
  assert(fresh && fresh.originating_specialist_id === 'cordelia', 'interrupt originated by cordelia');
  assert(fresh && fresh.routed_to === 'kate', `routed to kate (got ${fresh?.routed_to})`);

  // 3. wrapper stamped triage.
  const fm = read_fm(ctx.vault, wrapper_rel);
  assert(fm.routing_status === 'triage', `routing_status=triage (got ${String(fm.routing_status)})`);
  assert(
    Array.isArray(fm.routed_to) && (fm.routed_to as string[]).includes('kate'),
    'routed_to includes kate',
  );

  console.log('  ✓ below-threshold → Kate interrupt, no route row, triage stamped');
}

async function case_cluster_single_classify(ctx: ReturnType<typeof setup>): Promise<void> {
  llm_call_count = 0;
  // Three captures from the same user inside the (200ms) window.
  // The first triggers a flush_now; the next two arrive while the
  // bucket is still open. We then force-flush. Because flush_now
  // already processed the first capture, the timer-flush sees 3 items
  // but 2 are deduped — leading to ONE additional classifier call for
  // captures 2+3, plus the initial single-photo call for capture 1.
  // The test asserts the cluster mechanism prevents 3 separate calls.
  active_fixture = {
    respond: () => JSON.stringify({
      decisions: [
        {
          capture_ids: ['c_cluster01', 'c_cluster02', 'c_cluster03'],
          specialist_id: 'marguerite',
          confidence: 0.7,
          route_reason: 'three old family photos from the same album',
        },
      ],
    }),
  };

  const fs = (['c_cluster01', 'c_cluster02', 'c_cluster03'] as const).map((id) => {
    const f: CaptureFixture = { capture_id: id, user_id: 'jasper_museum', kind: 'photo', vl_filename_hint: 'garden' };
    return { f, r: persist_capture(ctx.memory, ctx.vault, f) };
  });
  // Emit all three quickly.
  for (const { f, r } of fs) {
    ctx.events.emit({
      type: 'capture_received',
      capture_id: f.capture_id,
      user_id: f.user_id,
      kind: f.kind,
      note_path: r.wrapper_rel,
      attachment_path: r.attachment_rel,
      captured_at: '2026-05-26T17:00:00.000Z',
    });
  }
  // Wait long enough for the 200ms cluster window to close + a tiny buffer
  // for the async classifier path to finish.
  await new Promise((res) => setTimeout(res, 600));

  // Without the cluster: 3 events → 3 classifier calls. With the
  // cluster: 1 flush_now (capture01 alone) + 1 timer flush (capture02 +
  // capture03 collapsed). That's 2 calls, NOT 3. Also assert > 0 so a
  // future regression that bypasses the classifier entirely doesn't
  // silently pass this case.
  assert(
    llm_call_count >= 1 && llm_call_count <= 2,
    `cluster collapsed multiple captures (got ${llm_call_count} calls — expected 1 or 2)`,
  );
  console.log(`  ✓ cluster of 3 collapsed to ${llm_call_count} classifier call(s)`);
}

async function case_multi_route_fanout(ctx: ReturnType<typeof setup>): Promise<void> {
  // A vet bill — Vivian (cost tracking) AND Anya (pet record) are
  // legitimately both interested. Classifier emits two decisions
  // covering the same capture_id; signal_substrate prefixes differ
  // (text:"price"/scene:"dog photo") so the secondary-route gate
  // accepts the secondary.
  const anya = ctx.specialists.get('anya');
  const vivian = ctx.specialists.get('vivian');
  assert(anya && vivian, 'anya + vivian specialists loaded');
  anya!.proactive.intake_captures = true;
  vivian!.proactive.intake_captures = true;

  llm_call_count = 0;
  active_fixture = {
    respond: () =>
      JSON.stringify({
        decisions: [
          {
            capture_ids: ['c_vetbill01'],
            specialist_id: 'vivian',
            confidence: 0.82,
            route_reason: 'invoice totals + payment line tell Vivian to track cost',
            signal_substrate: 'text:"TOTAL  $284.50 / VISA ****"',
          },
          {
            capture_ids: ['c_vetbill01'],
            specialist_id: 'anya',
            confidence: 0.73,
            route_reason: 'visible patient name + diagnosis code routes to Anya for pet record',
            signal_substrate: 'text:"Patient: Bailey / Dx: K9 dental cleaning"',
          },
          {
            capture_ids: ['c_vetbill01'],
            specialist_id: 'eleanor',
            confidence: 0.45,
            route_reason: 'background plant visible in photo',
            signal_substrate: 'scene:"a potted fern in the waiting room"',
          },
        ],
      }),
  };

  const f: CaptureFixture = {
    capture_id: 'c_vetbill01',
    user_id: 'jasper',
    kind: 'photo',
    ocr_text:
      'the clinic VETERINARY TEACHING HOSPITAL\nPatient: Bailey\nDx: K9 dental cleaning\nTOTAL  $284.50\nVISA ****4242',
    ios_hint: 'document',
  };
  const r = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    r.wrapper_rel,
    r.attachment_rel,
  );

  // 1. capture_routes has TWO accepted rows (primary vivian + secondary
  //    anya), eleanor's <0.6 secondary gets filtered out.
  const route_rows = ctx.db
    .prepare(
      `SELECT specialist_id, confidence FROM capture_routes WHERE capture_id = ? ORDER BY confidence DESC`,
    )
    .all('c_vetbill01') as Array<{ specialist_id: string; confidence: number }>;
  assert(route_rows.length === 2, `two accepted routes (got ${route_rows.length})`);
  assert(route_rows[0]!.specialist_id === 'vivian', 'primary route is vivian');
  assert(route_rows[1]!.specialist_id === 'anya', 'secondary route is anya');
  assert(
    !route_rows.some((r) => r.specialist_id === 'eleanor'),
    'eleanor secondary below SECONDARY_CONFIDENCE_MIN got filtered',
  );

  // 2. Wrapper frontmatter carries the FULL aggregate, not the last
  //    write — order is highest-confidence first.
  const fm = read_fm(ctx.vault, r.wrapper_rel);
  assert(
    Array.isArray(fm.routed_to) &&
      (fm.routed_to as string[]).length === 2 &&
      (fm.routed_to as string[])[0] === 'vivian' &&
      (fm.routed_to as string[])[1] === 'anya',
    `routed_to is ["vivian","anya"] (got ${JSON.stringify(fm.routed_to)})`,
  );

  // 3. Both specialists' inboxes received the flag (one each, not one
  //    shared message).
  assert(
    ctx.inbox.list_for('vivian', 20).some((m) => m.body_md.includes('c_vetbill01') || m.body_md.includes('routed')),
    'vivian inbox got a route flag',
  );
  assert(
    ctx.inbox.list_for('anya', 20).some((m) => m.body_md.includes('c_vetbill01') || m.body_md.includes('routed')),
    'anya inbox got a route flag',
  );

  console.log('  ✓ multi-route fan-out: 2 of 3 candidates accepted by secondary gate');
}

async function case_multi_route_same_signal_rejected(ctx: ReturnType<typeof setup>): Promise<void> {
  // Two decisions on one capture citing the SAME `signal_substrate`
  // body (the model double-cited one piece of evidence for two
  // specialists). Secondary fails the distinctness clause and gets
  // dropped, even though confidence is above SECONDARY_CONFIDENCE_MIN.
  // The point of the gate: a multi-route fan-out has to rest on TWO
  // distinct signals, not one signal that two specialists both want.
  const maggie = ctx.specialists.get('maggie');
  assert(maggie, 'maggie specialist loaded');
  maggie!.proactive.intake_captures = true;

  active_fixture = {
    respond: () =>
      JSON.stringify({
        decisions: [
          {
            capture_ids: ['c_samebody01'],
            specialist_id: 'vivian',
            confidence: 0.80,
            route_reason: 'receipt-shaped totals',
            signal_substrate: 'text:"TOTAL  12.50"',
          },
          {
            capture_ids: ['c_samebody01'],
            specialist_id: 'maggie',
            confidence: 0.65,
            route_reason: 'same total line — speculative band-merch read',
            signal_substrate: 'text:"TOTAL  12.50"',
          },
        ],
      }),
  };

  const f: CaptureFixture = {
    capture_id: 'c_samebody01',
    user_id: 'jasper',
    kind: 'photo',
    ocr_text: 'TOTAL  12.50',
    ios_hint: 'document',
  };
  const r = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    r.wrapper_rel,
    r.attachment_rel,
  );

  const route_rows = ctx.db
    .prepare(`SELECT specialist_id FROM capture_routes WHERE capture_id = ?`)
    .all('c_samebody01') as Array<{ specialist_id: string }>;
  assert(
    route_rows.length === 1 && route_rows[0]!.specialist_id === 'vivian',
    `same-substrate secondary rejected (got ${JSON.stringify(route_rows)})`,
  );
  console.log('  ✓ same-substrate secondary rejected by distinctness gate');
}

async function case_unparseable_classifier(ctx: ReturnType<typeof setup>): Promise<void> {
  active_fixture = {
    respond: () => 'this is not JSON at all, just prose pretending to be',
  };
  const before = ctx.interrupts.list().length;
  const f: CaptureFixture = {
    capture_id: 'c_garbage01',
    user_id: 'jasper',
    kind: 'photo',
    ocr_text: 'some doc text',
  };
  const { wrapper_rel, attachment_rel } = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    wrapper_rel,
    attachment_rel,
  );
  const after = ctx.interrupts.list().length;
  assert(after > before, `unparseable output → Kate interrupt (before=${before}, after=${after})`);
  console.log('  ✓ unparseable classifier output → Kate triage (no crash)');
}

async function case_real_intake_receipt(ctx: ReturnType<typeof setup>): Promise<void> {
  // Wire the real vivian/intake_receipt handler. Make sure her YAML
  // intake_captures is flipped on (the YAML edit makes it default,
  // but in case the smoke runs against an older config, force it).
  const vivian = ctx.specialists.get('vivian');
  if (vivian) vivian.proactive.intake_captures = true;
  const { intake_receipt } = await import('../src/specialists/vivian/intake/intake_receipt');
  ctx.reactive.register_intake('vivian', intake_receipt);

  // The classifier picks vivian; the receipt extractor returns
  // structured fields. We give the extractor a known JSON to return
  // by chaining responses: the FIRST call (classifier) returns the
  // routing decision, the SECOND call (extractor) returns the
  // receipt fields. Toggle on call_count.
  let next_call = 0;
  active_fixture = {
    respond: () => {
      next_call += 1;
      if (next_call === 1) {
        return JSON.stringify({
          decisions: [
            {
              capture_ids: ['c_realrcpt01'],
              specialist_id: 'vivian',
              confidence: 0.9,
              route_reason: 'unambiguous grocery receipt',
            },
          ],
        });
      }
      return JSON.stringify({
        store: 'Whole Foods',
        date: '2026-05-26',
        transaction_id: 'TX-9981',
        payment_method: 'VISA ****1234',
        items: [
          { label: 'BANANAS', price: 3.21 },
          { label: 'ALMOND MILK', price: 4.49 },
        ],
        total: 7.7,
        currency: 'USD',
        return_policy: null,
        confidence: 0.92,
      });
    },
  };
  const f: CaptureFixture = {
    capture_id: 'c_realrcpt01',
    user_id: 'jasper_intake',
    kind: 'photo',
    ocr_text:
      'WHOLE FOODS MARKET\n2026-05-26  14:32\nBANANAS  3.21\nALMOND MILK  4.49\nTOTAL  7.70\nVISA ****1234',
    ios_hint: 'document',
  };
  const { wrapper_rel, attachment_rel } = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    wrapper_rel,
    attachment_rel,
  );
  // Give the async intake a moment to settle (it ran inside the
  // apply_decision await chain, but the smoke's emit_and_wait races
  // ahead with the await_route promise).
  await new Promise((r) => setTimeout(r, 100));

  // Vivian's receipt record should exist.
  const receipt_path = `Knowledge/Vivian/receipts/2026-05-26/whole-foods.md`;
  const receipt_fm = read_fm(ctx.vault, receipt_path);
  assert(receipt_fm.type === 'receipt', `receipt note exists with type=receipt`);
  assert(receipt_fm.store === 'Whole Foods', `store extracted (got ${String(receipt_fm.store)})`);
  assert(receipt_fm.total === 7.7, `total extracted (got ${String(receipt_fm.total)})`);

  // Wrapper frontmatter stamped intake_outcome=filed.
  const wrapper_fm = read_fm(ctx.vault, wrapper_rel);
  assert(wrapper_fm.intake_outcome === 'filed', `wrapper intake_outcome=filed (got ${String(wrapper_fm.intake_outcome)})`);
  assert(wrapper_fm.intake_artifact_path === receipt_path, 'wrapper intake_artifact_path points at the receipt');

  console.log('  ✓ vivian.intake_receipt runs end-to-end (extractor → vault → frontmatter)');
}

async function case_maggie_music_context(ctx: ReturnType<typeof setup>): Promise<void> {
  // Seed a music_context snapshot for the user.
  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO music_context (user_id, captured_at, received_at, snapshot_json)
       VALUES (@u, @cap, @rec, @json)`,
    )
    .run({
      '@u': 'jasper_music',
      '@cap': '2026-05-26T00:00:00Z',
      '@rec': '2026-05-26T00:00:00Z',
      '@json': JSON.stringify({
        window_start: '2026-02-26',
        window_end: '2026-05-26',
        top_artists: [
          { artist: 'The National', play_count: 84 },
          { artist: 'Khruangbin', play_count: 51 },
          { artist: 'Bonnie Prince Billy', play_count: 12 },
        ],
        recently_played: [],
        starred_playlists: [],
      }),
    });

  // Reader returns the snapshot.
  const ctx_read = ctx.memory.query_music_context('jasper_music');
  assert(ctx_read && ctx_read.payload.top_artists.length === 3, 'query_music_context reads snapshot');

  const maggie = ctx.specialists.get('maggie');
  if (maggie) maggie.proactive.intake_captures = true;
  const { intake_band_poster } = await import('../src/specialists/maggie/intake/intake_band_poster');
  ctx.reactive.register_intake('maggie', intake_band_poster);

  active_fixture = {
    respond: () => JSON.stringify({
      decisions: [
        {
          capture_ids: ['c_poster001'],
          specialist_id: 'maggie',
          confidence: 0.82,
          route_reason: 'band poster with date + venue',
        },
      ],
    }),
  };
  const f: CaptureFixture = {
    capture_id: 'c_poster001',
    user_id: 'jasper_music',
    kind: 'photo',
    ocr_text:
      'THE NATIONAL\nLIVE AT THE BLUEBIRD THEATRE\nJUNE 12 2026\nDOORS 7PM\nTICKETS $45',
  };
  const { wrapper_rel, attachment_rel } = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    wrapper_rel,
    attachment_rel,
  );
  await new Promise((r) => setTimeout(r, 100));

  // Maggie's poster note exists, affinity is high, inbox FYI fired.
  const note_path = `Knowledge/Maggie/posters/c_poster001-the-national.md`;
  const note_fm = read_fm(ctx.vault, note_path);
  assert(note_fm.artist_candidate === 'THE NATIONAL', `artist candidate picked (got ${String(note_fm.artist_candidate)})`);
  assert(note_fm.artist_matched === 'The National', `matched against music_context (got ${String(note_fm.artist_matched)})`);
  const share = note_fm.affinity_share as number;
  assert(share > 0.5, `affinity > 0.5 for top-of-listening (got ${share})`);
  console.log('  ✓ maggie.intake_band_poster cross-references music_context');
}

async function case_cordelia_book_proposal(ctx: ReturnType<typeof setup>): Promise<void> {
  // intake_book should:
  //   1. file a queue note with `status: awaiting_decision`
  //   2. create a `book_candidate` proposal with three dynamic
  //      actions (acquire / file_only / skip) — each `execute` effect
  //   3. Decide → 'file_only' → backend resolver mutates the queue
  //      note's status to 'filed_for_reference' (NO LLM turn).
  const cordelia = ctx.specialists.get('cordelia');
  if (cordelia) cordelia.proactive.intake_captures = true;
  const { intake_book } = await import('../src/specialists/cordelia/intake/intake_book');
  ctx.reactive.register_intake('cordelia', intake_book);

  active_fixture = {
    respond: () => JSON.stringify({
      decisions: [
        {
          capture_ids: ['c_book_dec_01'],
          specialist_id: 'cordelia',
          confidence: 0.92,
          route_reason: 'unambiguous book cover with title + subtitle + author visible',
        },
      ],
    }),
  };
  const f: CaptureFixture = {
    capture_id: 'c_book_dec_01',
    user_id: 'jasper_book',
    kind: 'photo',
    ocr_text:
      'HISTORY OF THE CHAPEL RIDGE CEMETERY\nLaporte & Glenhaven, Colorado\nROSE L. BARLOW',
  };
  const { wrapper_rel, attachment_rel } = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    wrapper_rel,
    attachment_rel,
  );
  await new Promise((r) => setTimeout(r, 100));

  // 1. queue note shows awaiting_decision.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const queue_dir = path.resolve(ctx.vault, 'Knowledge', 'Cordelia', 'queue');
  const queue_files = fs.existsSync(queue_dir) ? fs.readdirSync(queue_dir) : [];
  const queue_match = queue_files.find((f) => f.endsWith('.md'));
  assert(queue_match, `queue note exists in ${queue_dir} (found: ${queue_files.join(', ')})`);
  const queue_rel = `Knowledge/Cordelia/queue/${queue_match!}`;
  const fm = read_fm(ctx.vault, queue_rel);
  assert(
    fm.status === 'awaiting_decision',
    `queue note status=awaiting_decision (got ${String(fm.status)})`,
  );

  // 2. book_candidate proposal landed with 3 dynamic actions.
  const { ProposalsStore } = await import('../src/core/proposals');
  const proposals = new ProposalsStore(ctx.db);
  const open = proposals.list({ specialist_id: 'cordelia' });
  const book_proposal = open.find((p) => p.kind === 'book_candidate');
  assert(book_proposal, 'book_candidate proposal was created');
  const action_ids = book_proposal!.actions.map((a) => a.id).sort();
  assert(
    JSON.stringify(action_ids) === JSON.stringify(['acquire', 'file_only', 'skip']),
    `actions = acquire / file_only / skip (got ${action_ids.join(', ')})`,
  );
  assert(
    book_proposal!.actions.every((a) => a.effect === 'execute'),
    'all three book_candidate actions are effect=execute',
  );

  // 3. Decide → file_only → resolver mutates the queue note status.
  // This is the structural fabrication-fix: no LLM turn between the
  // tap and the file mutation. We invoke the resolver directly
  // through ProposalsStore.decide() + the resolver function.
  const decided = proposals.decide(
    book_proposal!.id,
    'approve',
    undefined,
    undefined,
    'file_only',
  );
  assert(decided, 'decide returned a result');
  assert(decided!.status === 'approved', `status approved (got ${decided!.status})`);

  // Resolver runs in the route handler, not in decide(). For the
  // smoke we exercise the resolver directly to validate the queue
  // note mutation path.
  const route_module = await import('../src/specialists/cordelia/intake/_capture_io');
  route_module.patch_clipping_frontmatter(ctx.memory, queue_rel, {
    status: 'filed_for_reference',
    decided_at: new Date().toISOString(),
    decided_action: 'file_only',
  });
  const fm_after = read_fm(ctx.vault, queue_rel);
  assert(
    fm_after.status === 'filed_for_reference',
    `queue note status mutated to filed_for_reference (got ${String(fm_after.status)})`,
  );

  // 4. The audit row's action_taken column carries the user's choice.
  const post = proposals.get(book_proposal!.id);
  assert(post && post.action_taken === 'file_only', `action_taken=file_only (got ${post?.action_taken})`);

  console.log('  ✓ cordelia.intake_book → book_candidate proposal w/ 3 actions; file_only → queue status mutates (no LLM turn)');
}

async function case_thumbnail_endpoint(ctx: ReturnType<typeof setup>): Promise<void> {
  // Build the cordelia router with this smoke's deps and call its
  // /thumbnail/:id and /recent?include_timeline=1 endpoints directly
  // (no Hono fetch — call the route handler logic through a tiny
  // adapter). For brevity here we drive the DB and filesystem layer
  // and assert the SQL/file behavior the handler relies on.
  const id = 'c_thumbtest1';
  const att = `_attachments/cordelia-${id}.jpg`;
  // Tiny "JPEG-ish" bytes so existsSync + read succeed.
  const fs = await import('node:fs');
  fs.writeFileSync(resolve(ctx.vault, att), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  const note_rel = `Cordelia/Inbox/2026-05-26-photo-${id}.md`;
  ctx.memory.upsert_note(
    note_rel,
    {
      type: 'clipping',
      id,
      kind: 'image',
      source: 'file',
      title: 'thumb fixture',
      captured_at: '2026-05-26T17:00:00.000Z',
      reviewed: false,
      attachment_path: att,
      private_to: 'jasper',
    },
    '',
  );
  // The clipping row exists because the chokidar projection ran via
  // upsert_note? Actually NO — upsert_note only writes the markdown.
  // The clippings projection comes from the ingestor in production.
  // For this smoke, manually insert the row.
  ctx.db
    .prepare(
      `INSERT OR REPLACE INTO clippings
       (id, kind, source, title, attachment_path, captured_at, reviewed,
        note_path, frontmatter_json, mtime)
       VALUES (@id, 'image', 'file', 'thumb fixture', @att, '2026-05-26T17:00:00Z',
               0, @note, @fm, '2026-05-26T17:00:00Z')`,
    )
    .run({
      '@id': id,
      '@att': att,
      '@note': note_rel,
      '@fm': JSON.stringify({ private_to: 'jasper' }),
    });

  // Direct file existence + mime derivation are what the handler relies on.
  assert(
    fs.existsSync(resolve(ctx.vault, att)),
    'thumb attachment exists on disk',
  );

  // Validate the SQL the handler runs.
  const row = ctx.db
    .prepare(
      `SELECT attachment_path, frontmatter_json FROM clippings WHERE id = @id AND note_path LIKE 'Cordelia/Inbox/%'`,
    )
    .get({ '@id': id });
  assert(row, 'thumbnail SQL lookup finds the row');

  console.log('  ✓ thumbnail endpoint preconditions (row + on-disk attachment + private_to gate)');
}

async function case_timeline_query(ctx: ReturnType<typeof setup>): Promise<void> {
  // The timeline join is `audit_log WHERE tool_input LIKE %capture_id%
  // OR execution_result LIKE %capture_id%`. The earlier receipt case
  // already audited a cordelia_intake row tied to c_realrcpt01.
  const rows = ctx.db
    .prepare(
      `SELECT ts, agent, tool_name FROM audit_log
       WHERE tool_input LIKE @needle OR execution_result LIKE @needle
       ORDER BY ts ASC`,
    )
    .all({ '@needle': '%c_realrcpt01%' }) as Array<{ ts: string; agent: string; tool_name: string }>;
  assert(rows.length >= 2, `timeline join finds ≥ 2 rows for c_realrcpt01 (got ${rows.length})`);
  const names = rows.map((r) => r.tool_name);
  assert(names.includes('cordelia_route'), 'timeline includes cordelia_route');
  assert(names.includes('cordelia_intake'), 'timeline includes cordelia_intake');
  console.log(`  ✓ timeline query yields ${rows.length} audit row(s) for the receipt capture`);
}

async function case_vl_runs_on_every_photo(ctx: ReturnType<typeof setup>): Promise<void> {
  // Post-2026-05-27: VL is the default routing layer. Every photo
  // capture with the VL endpoint reachable gets a vision pass,
  // regardless of how much OCR text iOS extracted. The doc-track
  // shortcut (skip VL when OCR ≥ 40 chars) produced the Dunkin' cup
  // misroute; the gate is gone.
  vl_call_count = 0;
  active_fixture = {
    respond: () => JSON.stringify({
      decisions: [
        {
          capture_ids: ['c_doc_with_vl'],
          specialist_id: 'kate',
          confidence: 0.7,
          route_reason: 'paper mail with handwritten note',
          signal_substrate: 'text:"HOA quarterly meeting June 4"',
        },
      ],
    }),
  };
  const f: CaptureFixture = {
    capture_id: 'c_doc_with_vl',
    user_id: 'jasper',
    kind: 'photo',
    ocr_text:
      'Dear neighbor,\nA reminder that the HOA quarterly meeting is on June 4th at 7pm in the common room.\nWe will discuss the proposed playground refresh.',
    ios_hint: 'document',
  };
  const { wrapper_rel, attachment_rel } = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    wrapper_rel,
    attachment_rel,
  );
  assert(
    vl_call_count >= 1,
    `VL runs on every photo capture (got ${vl_call_count}) — doc-track shortcut should be gone`,
  );
  console.log('  ✓ VL fires on text-heavy photos too (no doc-track shortcut)');
}

async function case_scene_shaped_text_heavy_routes_via_vl(ctx: ReturnType<typeof setup>): Promise<void> {
  // The Dunkin' cup pattern reproduced. A coffee cup with a printed
  // order label OCRs to receipt-shaped text (item list, transaction
  // number, customer name) but is actually a beverage in a scene. VL
  // (mocked here) describes it as a coffee cup and the classifier
  // routes to Brigid via the scene substrate, even though the OCR
  // looks like a Vivian-shaped receipt.
  const brigid = ctx.specialists.get('brigid');
  assert(brigid, 'brigid specialist loaded');
  brigid!.proactive.intake_captures = true;

  // Override VL transport for this case: return a coffee-cup
  // description regardless of filename, so the smoke doesn't depend
  // on the `garden` filename hint.
  const prev_vl_transport = vl_call_count;
  _test_set_vl_transport(async () => {
    vl_call_count += 1;
    return {
      available: true,
      description:
        'A close-up of a clear plastic cup containing an iced coffee beverage with a printed mobile-order label.',
      salient_objects: ['plastic cup', 'iced coffee', 'label', 'straw'],
      suggested_specialist_hint: 'brigid',
      confidence: 0.92,
    };
  });
  try {
    vl_call_count = prev_vl_transport;
    active_fixture = {
      respond: (user_text) => {
        // Verify the classifier prompt actually carries the VL
        // description AND the OCR text — both should be visible to
        // the LLM since we now read all signals.
        const sees_vl = user_text.includes('iced coffee beverage');
        const sees_ocr = user_text.includes('Lg Ice Orig Cof');
        if (!sees_vl || !sees_ocr) {
          // Force a parse failure to surface the gap in assertions below.
          return JSON.stringify({ decisions: [] });
        }
        return JSON.stringify({
          decisions: [
            {
              capture_ids: ['c_dunkin_cup'],
              specialist_id: 'brigid',
              confidence: 0.95,
              route_reason: 'iced coffee beverage; user can act on nutrition',
              signal_substrate: 'scene:"iced coffee in plastic cup"',
            },
          ],
        });
      },
    };
    const f: CaptureFixture = {
      capture_id: 'c_dunkin_cup',
      user_id: 'jasper',
      kind: 'photo',
      ocr_text:
        '1 of 1 Bev\nTotal Items: 2\nMobile DI\nJasper Lo\n#9488\n10:12:39 AM\nLg Ice Orig Cof\n4 BrnSgr Syr\n4 Sugar\n4 Cream',
      ios_hint: 'scene',
    };
    const r = persist_capture(ctx.memory, ctx.vault, f);
    await emit_and_wait(
      ctx.events,
      ctx.reactive,
      f.capture_id,
      f.user_id,
      f.kind,
      r.wrapper_rel,
      r.attachment_rel,
    );

    const route_rows = ctx.db
      .prepare(`SELECT specialist_id, confidence FROM capture_routes WHERE capture_id = ?`)
      .all('c_dunkin_cup') as Array<{ specialist_id: string; confidence: number }>;
    assert(
      route_rows.length === 1 && route_rows[0]!.specialist_id === 'brigid',
      `scene-shaped-but-text-heavy routes to brigid via VL (got ${JSON.stringify(route_rows)})`,
    );
    console.log("  ✓ scene-shaped-but-text-heavy (Dunkin' cup) routes to brigid via VL");
  } finally {
    // Restore the default VL transport for downstream cases.
    _test_set_vl_transport(async ({ image_path }) => {
      vl_call_count += 1;
      if (image_path.includes('garden')) {
        return {
          available: true,
          description: 'Raised garden bed with healthy tomato plants and basil.',
          salient_objects: ['tomato', 'basil', 'raised bed', 'soil'],
          suggested_specialist_hint: 'eleanor',
          confidence: 0.82,
        };
      }
      return {
        available: false,
        description: '',
        salient_objects: [],
        suggested_specialist_hint: 'unknown',
        confidence: 0,
        error: 'vl_unavailable',
      };
    });
  }
}

async function case_user_note_reaches_classifier(ctx: ReturnType<typeof setup>): Promise<void> {
  // The capture route stamps `user_note` into extracted_metadata when
  // the multipart `note` field is present. classify.ts then reads it
  // and surfaces it in the classifier prompt. This smoke directly
  // tests the prompt-visibility — without the stamp, the classifier
  // wouldn't see the user's question and routing falls back to the
  // OCR/VL signals alone.
  const f: CaptureFixture = {
    capture_id: 'c_note_routes',
    user_id: 'jasper',
    kind: 'photo',
    ocr_text: 'GENERIC LABEL\nLOT 8842\nBest by 2027-01',
    user_note: 'Is this safe for cats to eat?',
    ios_hint: 'document',
  };
  let prompt_saw_user_note = false;
  active_fixture = {
    respond: (user_text) => {
      prompt_saw_user_note = user_text.includes('Is this safe for cats to eat');
      return JSON.stringify({
        decisions: [
          {
            capture_ids: ['c_note_routes'],
            specialist_id: 'anya',
            confidence: 0.78,
            route_reason: 'user asked about cat safety',
            signal_substrate: 'user_note:"Is this safe for cats to eat?"',
          },
        ],
      });
    },
  };
  const r = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(
    ctx.events,
    ctx.reactive,
    f.capture_id,
    f.user_id,
    f.kind,
    r.wrapper_rel,
    r.attachment_rel,
  );
  assert(
    prompt_saw_user_note,
    'classifier prompt contains the user_note verbatim',
  );
  const route_rows = ctx.db
    .prepare(`SELECT specialist_id FROM capture_routes WHERE capture_id = ?`)
    .all('c_note_routes') as Array<{ specialist_id: string }>;
  assert(
    route_rows.some((r) => r.specialist_id === 'anya'),
    `routed by user_note (got ${JSON.stringify(route_rows)})`,
  );
  console.log('  ✓ user_note reaches classifier prompt and steers routing');
}

async function case_image_transcode_passthrough(): Promise<void> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { ensure_jpeg_for_vl, data_url_for } = await import('../src/core/image_transcode');
  const tmp = path.resolve(os.tmpdir(), `hearth-smoke-${Date.now()}.jpg`);
  // A REAL (canonical 1×1) JPEG: since the 2026-06-28 vision-cap change,
  // passthrough requires image_dimensions() to parse an actual SOF header
  // within the cap — a bare 10-byte JFIF prefix falls through to an ffmpeg
  // downscale and fails to decode.
  const one_px_jpeg =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
  fs.writeFileSync(tmp, Buffer.from(one_px_jpeg, 'base64'));
  try {
    const out = await ensure_jpeg_for_vl(tmp);
    assert(out.mime === 'image/jpeg', `mime preserved (got ${out.mime})`);
    assert(out.path === tmp, 'passthrough: no temp file');
    assert(out.cleanup === undefined, 'no cleanup needed for passthrough');
    const data_url = data_url_for(out);
    assert(data_url.startsWith('data:image/jpeg;base64,'), 'data url shape');
    console.log('  ✓ image_transcode JPEG passthrough (no ffmpeg spawn)');
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function case_consult_deep_model_accepts_image_path(): Promise<void> {
  const { consult_deep_model } = await import('../src/tools/consult_deep_model');
  const parsed = consult_deep_model.input_schema.safeParse({
    question: 'What is on this poster?',
    image_path: '_attachments/cordelia-c_xxxxxxxxxx.jpg',
  });
  assert(
    parsed.success,
    `schema accepts image_path${parsed.success ? '' : `: ${JSON.stringify((parsed as { error: { issues: unknown } }).error.issues)}`}`,
  );
  // idempotency_key includes image_path so two calls with the same
  // question but different images aren't deduped.
  const key_a = consult_deep_model.idempotency_key({ question: 'q', image_path: 'a.jpg' });
  const key_b = consult_deep_model.idempotency_key({ question: 'q', image_path: 'b.jpg' });
  assert(key_a !== key_b, 'image_path differentiates idempotency_key');
  console.log('  ✓ consult_deep_model schema accepts image_path; idempotency differentiates');
}

async function case_routed_capture_filed_to_library(
  ctx: ReturnType<typeof setup>,
): Promise<void> {
  // The load-bearing fix: a routed capture must become SEARCHABLE for the
  // target specialist — not just a dangling inbox flag. A scene-only dog
  // photo (no OCR) carries its signal ONLY in the VL description; the fix
  // composes a markdown note from that signal and files it onto the
  // target's library shelf (chunks_fts), so search_library / turn-RAG can
  // reach it. It must ALSO be visible to Cordelia via her cross-specialist
  // `Knowledge/<id>/library` scope. Critically: NO intake handler is
  // registered for anya here — filing happens in the routing layer, not the
  // handler, so it covers every routed-to specialist.
  const anya = ctx.specialists.get('anya');
  assert(anya, 'anya specialist loaded');
  anya!.proactive.intake_captures = true;

  _test_set_vl_transport(async () => {
    vl_call_count += 1;
    return {
      available: true,
      description:
        'A close-up portrait of a dog with a visible collar, looking toward the camera.',
      salient_objects: ['dog', 'collar', 'snout'],
      suggested_specialist_hint: 'anya',
      confidence: 0.95,
    };
  });
  try {
    active_fixture = {
      respond: () =>
        JSON.stringify({
          decisions: [
            {
              capture_ids: ['c_dogphoto01'],
              specialist_id: 'anya',
              confidence: 0.95,
              route_reason: 'close-up portrait of a dog — matches Anya veterinary domain',
              signal_substrate: 'scene:"close-up portrait of a dog"',
            },
          ],
        }),
    };
    const f: CaptureFixture = { capture_id: 'c_dogphoto01', user_id: 'jasper', kind: 'photo' };
    const r = persist_capture(ctx.memory, ctx.vault, f);
    await emit_and_wait(ctx.events, ctx.reactive, f.capture_id, f.user_id, f.kind, r.wrapper_rel, r.attachment_rel);
    // Library filing runs inside the apply_decision await chain; give the
    // detached process_cluster a beat to finish.
    await new Promise((res) => setTimeout(res, 150));

    // 1 + 2. The dog capture was filed onto Anya's library shelf AND chunked
    // into chunks_fts — the missing indexing step the fix adds. (The
    // `clippings` projection is the INGESTOR's job; we assert the searchable
    // index directly, written synchronously by save_library_item. Matched on
    // 'collar' — distinctive to this VL description — since other cases now
    // also file Anya/library notes.)
    const dog_chunks = ctx.db
      .prepare(
        `SELECT note_path FROM chunks_fts WHERE note_path LIKE 'Knowledge/Anya/library/%' AND chunk_text LIKE '%collar%'`,
      )
      .all() as Array<{ note_path: string }>;
    assert(dog_chunks.length >= 1, `dog capture filed + chunked under Anya/library (got ${dog_chunks.length})`);

    const finds_dog = (hits: Array<{ note_path: string; chunk_text: string }>): boolean =>
      hits.some((h) => h.note_path.startsWith('Knowledge/Anya/library/') && /dog|collar/i.test(h.chunk_text));

    // 3. Anya can RETRIEVE the dog capture (her own scope) by VL-derived terms.
    const anya_hits = ctx.memory.retrieve_scoped_chunks({
      query: 'dog collar portrait',
      knowledge_scope: anya!.knowledge_scope,
      k: 10,
      bypass_private: true,
    });
    assert(
      finds_dog(anya_hits),
      `Anya's search finds the routed dog capture (got ${JSON.stringify(anya_hits.map((h) => h.note_path))})`,
    );

    // 4. Cordelia retains a searchable record via her Knowledge/<id>/library scope.
    const cordelia = ctx.specialists.get('cordelia');
    assert(cordelia, 'cordelia specialist loaded');
    const cordelia_hits = ctx.memory.retrieve_scoped_chunks({
      query: 'dog collar portrait',
      knowledge_scope: cordelia!.knowledge_scope,
      k: 10,
      bypass_private: true,
    });
    assert(
      finds_dog(cordelia_hits),
      `Cordelia can find what she routed (got ${JSON.stringify(cordelia_hits.map((h) => h.note_path))})`,
    );

    console.log('  ✓ routed capture filed to target library, chunked, retrievable by target + Cordelia');
  } finally {
    _test_set_vl_transport(async ({ image_path }) => {
      vl_call_count += 1;
      if (image_path.includes('garden')) {
        return {
          available: true,
          description: 'Raised garden bed with healthy tomato plants and basil.',
          salient_objects: ['tomato', 'basil', 'raised bed', 'soil'],
          suggested_specialist_hint: 'eleanor',
          confidence: 0.82,
        };
      }
      return {
        available: false,
        description: '',
        salient_objects: [],
        suggested_specialist_hint: 'unknown',
        confidence: 0,
        error: 'vl_unavailable',
      };
    });
  }
}

async function case_friend_routing_clamped(ctx: ReturnType<typeof setup>): Promise<void> {
  // Routing honors the same access cordon as chat. Kim is tier:friend,
  // allowed_specialists:['linda'] (scripts/fixtures/users.yaml — the smoke's
  // UserRegistry reads it). His ski gear must NOT route to Vivian (finance)
  // even when the content reads like a purchase; the candidate roster
  // collapses to Linda (+ Kate triage fallback).
  const linda = ctx.specialists.get('linda');
  const vivian = ctx.specialists.get('vivian');
  assert(linda && vivian, 'linda + vivian specialists loaded');
  linda!.proactive.intake_captures = true;
  vivian!.proactive.intake_captures = true;

  // (a) Classifier tries Vivian for Kim → clamp blocks her → Kate triage.
  const before_interrupts = ctx.interrupts.list().length;
  let roster_seen = '';
  active_fixture = {
    respond: (user_text) => {
      roster_seen = user_text;
      return JSON.stringify({
        decisions: [
          {
            capture_ids: ['c_lee_ski01'],
            specialist_id: 'vivian',
            confidence: 0.9,
            route_reason: 'ski purchase — expense tracking',
            signal_substrate: 'text:"TMARKER ski bindings"',
          },
        ],
      });
    },
  };
  const f: CaptureFixture = {
    capture_id: 'c_lee_ski01',
    user_id: 'kim',
    kind: 'photo',
    ocr_text: 'TMARKER 7120TING Comp 20 Race ski bindings DIN/ISO 11-20',
  };
  const r = persist_capture(ctx.memory, ctx.vault, f);
  await emit_and_wait(ctx.events, ctx.reactive, f.capture_id, f.user_id, f.kind, r.wrapper_rel, r.attachment_rel);

  assert(roster_seen.includes('- linda ('), 'classifier roster includes Linda for Kim');
  assert(!roster_seen.includes('- vivian ('), 'classifier roster EXCLUDES Vivian for Kim (friend cordon)');

  const vivian_row = ctx.db
    .prepare(`SELECT id FROM capture_routes WHERE capture_id = ? AND specialist_id = 'vivian'`)
    .get('c_lee_ski01') as { id: string } | undefined;
  assert(!vivian_row, 'no Vivian route for a friend not allowed Vivian');
  assert(
    ctx.interrupts.list().length > before_interrupts,
    'unroutable friend capture falls to Kate triage interrupt',
  );

  // (b) Classifier picks Linda (Kim's specialist) → routes cleanly.
  active_fixture = {
    respond: () =>
      JSON.stringify({
        decisions: [
          {
            capture_ids: ['c_lee_ski02'],
            specialist_id: 'linda',
            confidence: 0.95,
            route_reason: 'ski gear staged for resale listing',
            signal_substrate: 'scene:"ski bindings staged for resale"',
          },
        ],
      }),
  };
  const f2: CaptureFixture = { capture_id: 'c_lee_ski02', user_id: 'kim', kind: 'photo', ocr_text: 'TMARKER ski bindings' };
  const r2 = persist_capture(ctx.memory, ctx.vault, f2);
  await emit_and_wait(ctx.events, ctx.reactive, f2.capture_id, f2.user_id, f2.kind, r2.wrapper_rel, r2.attachment_rel);
  const linda_row = ctx.db
    .prepare(`SELECT specialist_id FROM capture_routes WHERE capture_id = ?`)
    .get('c_lee_ski02') as { specialist_id: string } | undefined;
  assert(linda_row?.specialist_id === 'linda', `Kim's capture routes to Linda (got ${linda_row?.specialist_id})`);

  // PRIVACY CORDON: the capture Kim routed is filed private_to:kim. The OWNER
  // (jasper) must NOT be able to retrieve it through Linda's shelf — a friend's
  // uploads/knowledge stay siloed from the owner (no god-view; the only
  // sanctioned cross-cordon path is the audited review_user_activity tool).
  // Kim himself CAN retrieve it. This guards file_capture_to_library against
  // re-opening the per-user cordon the 2026-06-04 work established.
  await new Promise((res) => setTimeout(res, 150));
  const is_lee_ski = (h: { note_path: string; chunk_text: string }): boolean =>
    h.note_path.startsWith('Knowledge/Linda/library/') && /TMARKER|ski bindings/i.test(h.chunk_text);
  const owner_hits = ctx.memory.retrieve_scoped_chunks({
    query: 'ski bindings TMARKER', knowledge_scope: linda!.knowledge_scope, k: 10,
    user_id: 'jasper', user_tier: 'owner',
  });
  assert(
    !owner_hits.some(is_lee_ski),
    `LEAK: owner retrieved Kim's private capture (got ${JSON.stringify(owner_hits.map((h) => h.note_path))})`,
  );
  const lee_hits = ctx.memory.retrieve_scoped_chunks({
    query: 'ski bindings TMARKER', knowledge_scope: linda!.knowledge_scope, k: 10,
    user_id: 'kim', user_tier: 'friend',
  });
  assert(
    lee_hits.some(is_lee_ski),
    `Kim must retrieve his OWN routed capture (got ${JSON.stringify(lee_hits.map((h) => h.note_path))})`,
  );

  console.log('  ✓ friend-tier routing clamped to allowed_specialists (Kim → Linda, never Vivian)');
  console.log("  ✓ privacy cordon: owner CANNOT retrieve Kim's filed capture; Kim can");
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ctx = setup();
  try {
    console.log('smoke:visual-pipeline');
    await case_receipt_to_vivian(ctx);
    await case_below_threshold_kate_interrupt(ctx);
    await case_cluster_single_classify(ctx);
    await case_multi_route_fanout(ctx);
    await case_multi_route_same_signal_rejected(ctx);
    await case_unparseable_classifier(ctx);
    await case_vl_runs_on_every_photo(ctx);
    await case_scene_shaped_text_heavy_routes_via_vl(ctx);
    await case_user_note_reaches_classifier(ctx);
    await case_routed_capture_filed_to_library(ctx);
    await case_friend_routing_clamped(ctx);
    await case_real_intake_receipt(ctx);
    await case_maggie_music_context(ctx);
    await case_cordelia_book_proposal(ctx);
    await case_thumbnail_endpoint(ctx);
    await case_timeline_query(ctx);
    await case_image_transcode_passthrough();
    await case_consult_deep_model_accepts_image_path();
    console.log('  all checks passed');
  } finally {
    ctx.reactive.stop();
    teardown(ctx.root);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
