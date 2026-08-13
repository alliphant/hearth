/**
 * smoke:process-misses — self-contained test of the closed-loop ledger.
 *
 * Exercises the ProcessMissStore lifecycle and the flag_process_miss
 * tool against a throwaway SQLite file. No orchestrator, no vault.
 *
 *   bun run smoke:process-misses
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ProcessMissStore } from '@core/process_misses';
import { create as create_flag_tool } from '@specialists/mariah/tools/flag_process_miss';
import { create as create_scan_tool } from '@specialists/mariah/tools/scan_program_health';
import { create as create_advance_tool } from '@specialists/mariah/tools/advance_process_miss';
import { create as create_patterns_tool } from '@specialists/mariah/tools/scan_program_patterns';
import { create as create_align_tool } from '@specialists/mariah/tools/scan_specialist_alignment';
import { create as create_flag_beatrice_tool } from '@specialists/kate/tools/flag_beatrice';
import { ConversationStore, SpecialistInbox } from '@memory/stores/conversations';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolContext } from '@core/tool';
import type { AppEvent } from '@app/events';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-misses-'));
const db = open_db(join(dir, 'test.db'));
const store = new ProcessMissStore(db);

try {
  // ── store: create + read ───────────────────────────────────────────────
  const id = store.create({
    subject_specialist_id: 'vivian',
    reporter: 'mariah',
    task_summary: 'reconcile the May bank statement',
    gap: 'used April figures',
    severity: 'high',
  });
  check('create returns a pm_ id', id.startsWith('pm_'));
  const row = store.get(id);
  check('miss starts at status open', row?.status === 'open');
  check('opening note is recorded', !!row && row.notes_md.includes('opened by mariah'));

  // ── store: list filters ────────────────────────────────────────────────
  check('list open_only finds the miss', store.list({ open_only: true }).some((m) => m.id === id));
  check(
    'list filters by subject',
    store.list({ subject_specialist_id: 'vivian' }).length === 1,
  );

  // ── store: lifecycle walk ──────────────────────────────────────────────
  store.update_status(id, 'routed', 'sending to Vivian for a redo', 'mariah');
  check('routed records routed_to', store.get(id)?.routed_to === 'mariah');
  store.update_status(id, 'redo_dispatched', 'Vivian re-running the reconciliation');
  store.update_status(id, 'verified', 'redo used the May figures — correct');
  const closed = store.update_status(id, 'closed', 'loop closed');
  check('walks the lifecycle to closed', closed.status === 'closed');
  check(
    'transition history accumulates in notes_md',
    (closed.notes_md.match(/->/g) ?? []).length >= 5,
  );

  // ── store: guards ──────────────────────────────────────────────────────
  check(
    'rejects an invalid transition',
    throws(() => store.update_status(id, 'open', 'closed is terminal')),
  );
  check(
    'rejects an unknown id',
    throws(() => store.update_status('pm_does_not_x', 'routed', 'x')),
  );

  // ── store: escalation branch ───────────────────────────────────────────
  const id2 = store.create({
    subject_specialist_id: 'anya',
    reporter: 'mariah',
    task_summary: 'summarize the visit notes',
    gap: 'same omission a third time',
    severity: 'medium',
  });
  store.update_status(id2, 'routed', 'recurring — not an instance problem');
  const esc = store.update_status(id2, 'escalated', 'to Beatrice for a structural fix');
  check('supports the escalation branch', esc.status === 'escalated');

  // ── store: evidence_ref chokepoint dedup (2026-06-09) ──────────────────
  const ref = 'round-ceiling:ruby:2026-W24';
  const dd1 = store.create({
    subject_specialist_id: 'ruby',
    reporter: 'orchestrator',
    task_summary: 'answer the trail question',
    gap: 'tool-round-ceiling exhaustion',
    severity: 'medium',
    evidence_ref: ref,
  });
  const dd2 = store.create({
    subject_specialist_id: 'ruby',
    reporter: 'orchestrator',
    task_summary: 'answer the council question',
    gap: 'tool-round-ceiling exhaustion again',
    severity: 'medium',
    evidence_ref: ref,
  });
  check('same evidence_ref on a live miss returns the same row', dd1 === dd2);
  check(
    'recurrence on a live miss is annotated, not duplicated',
    (store.get(dd1)?.notes_md ?? '').includes('recurred (reported by orchestrator)') &&
      store.list({ open_only: true }).filter((m) => m.evidence_ref === ref).length === 1,
  );
  store.update_status(dd1, 'routed', 'driving it');
  store.update_status(dd1, 'redo_dispatched', 'redo sent');
  store.update_status(dd1, 'verified', 'looked fixed');
  store.update_status(dd1, 'closed', 'closing the loop');
  const dd3 = store.create({
    subject_specialist_id: 'ruby',
    reporter: 'orchestrator',
    task_summary: 'answer the parks question',
    gap: 'exhausted again after the fix',
    severity: 'medium',
    evidence_ref: ref,
  });
  check('recurrence after close REOPENS the same row', dd3 === dd1);
  const reopened = store.get(dd1);
  check(
    'reopened miss is open again with the recurrence note',
    reopened?.status === 'open' && reopened.notes_md.includes('reopened by orchestrator'),
  );

  // ── tool: flag_process_miss ────────────────────────────────────────────
  const tool = create_flag_tool({ process_misses: store } as unknown as ToolDeps);
  check(
    'tool declares the write_process_miss capability',
    (tool.required_capabilities ?? []).includes('write_process_miss'),
  );
  const out = (await tool.execute(
    {
      subject_specialist_id: 'iris',
      task_summary: 'plan the EV day',
      gap: 'ignored the charge level',
      severity: 'medium',
    },
    { specialist_id: 'mariah', now: new Date() } as unknown as ToolContext,
  )) as { miss_id: string; status: string };
  check('tool opens a miss', out.miss_id.startsWith('pm_') && out.status === 'open');
  check(
    'tool-opened miss records its reporter',
    store.get(out.miss_id)?.reporter === 'mariah',
  );

  // ── scan_program_health: detection ─────────────────────────────────────
  const now_iso = new Date().toISOString();
  db.prepare(
    `INSERT INTO proposals
       (id, ts_created, specialist_id, kind, execution_kind, payload_json,
        rationale_md, status, execution_result_json)
     VALUES ('p_smoke1', @ts, 'vivian', 'action_proposal', 'dispatch', '{}',
        'pay the water bill', 'failed', '{"error":"gateway timeout"}')`,
  ).run({ '@ts': now_iso });
  db.prepare(
    `INSERT INTO scheduled_tasks
       (id, fire_at, intent, context_json, idempotency_key, attempts, status)
     VALUES ('flw_smoke1', @ts, 'deliver_followup', @ctx, 'idem_smoke1', 3, 'failed')`,
  ).run({
    '@ts': now_iso,
    '@ctx': JSON.stringify({
      body: { specialist_id: 'eleanor', summary: 'find the last-frost date' },
    }),
  });
  // A proposal Jasper approved 2 days ago that the system was meant to
  // auto-run (payload names a dispatch_tool) but never executed — the
  // stalled-approval signal. The dispatch retry the scan attempts fails
  // here (no tool registry in this harness), which is exactly the
  // "auto-dispatch failed" shape that opens a miss. A MANUAL proposal
  // with no dispatch_tool is deliberately NOT a miss since 2026-06-04 —
  // its "execution" is a human action surfaced in the queue (the old
  // fixture asserted the pre-fix behavior and went stale).
  const stale_iso = new Date(Date.now() - 48 * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO proposals
       (id, ts_created, ts_decided, specialist_id, kind, execution_kind,
        payload_json, rationale_md, status)
     VALUES ('p_smoke2', @old, @old, 'marguerite', 'action_proposal', 'dispatch',
        '{"dispatch_tool":"gedcom_import","dispatch_input":{}}',
        'import the family-tree GEDCOM', 'approved')`,
  ).run({ '@old': stale_iso });

  const scan = create_scan_tool({ db, process_misses: store } as unknown as ToolDeps);
  const scan_out = (await scan.execute({}, {} as ToolContext)) as {
    misses_opened: Array<{ subject_specialist_id: string; source: string }>;
    already_tracked: number;
  };
  check('scan opens a miss per distinct failure', scan_out.misses_opened.length === 3);
  check(
    'scan attributes the failed proposal to its specialist',
    scan_out.misses_opened.some(
      (m) => m.subject_specialist_id === 'vivian' && m.source === 'failed_proposal',
    ),
  );
  check(
    'scan attributes the failed follow-up to its specialist',
    scan_out.misses_opened.some(
      (m) => m.subject_specialist_id === 'eleanor' && m.source === 'failed_followup',
    ),
  );
  check(
    'scan catches an approved-but-never-executed proposal',
    scan_out.misses_opened.some(
      (m) => m.subject_specialist_id === 'marguerite' && m.source === 'stalled_approval',
    ),
  );
  const scan_out2 = (await scan.execute({}, {} as ToolContext)) as {
    misses_opened: unknown[];
    already_tracked: number;
  };
  check(
    'scan is idempotent — no double-flagging',
    scan_out2.misses_opened.length === 0 && scan_out2.already_tracked === 3,
  );

  // ── advance_process_miss: route -> redo -> verify -> close ─────────────
  const inbox = new SpecialistInbox(db);
  // Capture every inbox_message_added event so we can assert the
  // wake-on-flag side effect (severity routed at apply_miss_action).
  // Without these events Beatrice would never wake on an escalation
  // and Kate would never wake on a redo dispatch.
  const captured_events: AppEvent[] = [];
  const events_mock = {
    emit: (e: AppEvent) => {
      captured_events.push(e);
    },
    subscribe: () => () => {},
  };
  const advance = create_advance_tool({
    process_misses: store,
    inbox,
    events: events_mock,
  } as unknown as ToolDeps);
  const ctx_m = { specialist_id: 'mariah', now: new Date() } as unknown as ToolContext;
  const loop_id = store.create({
    subject_specialist_id: 'iris',
    reporter: 'mariah',
    task_summary: 'plan the EV day',
    gap: 'ignored the charge level',
    severity: 'medium',
  });
  await advance.execute({ miss_id: loop_id, action: 'route', note: 'mine to drive' }, ctx_m);
  await advance.execute(
    { miss_id: loop_id, action: 'dispatch_redo', note: 'redo with the charge level' },
    ctx_m,
  );
  check(
    'dispatch_redo flags the subject specialist inbox',
    inbox.unread_for('iris').some((m) => m.body_md.includes('Redo requested')),
  );
  check(
    'dispatch_redo emits inbox_message_added with severity=medium so Kate wakes off-schedule',
    captured_events.some(
      (e) =>
        e.type === 'inbox_message_added' &&
        e.to_specialist_id === 'iris' &&
        e.kind === 'flag' &&
        e.severity === 'medium',
    ),
  );
  await advance.execute({ miss_id: loop_id, action: 'verify', note: 'redo is correct' }, ctx_m);
  const done = (await advance.execute(
    { miss_id: loop_id, action: 'close', note: 'loop closed' },
    ctx_m,
  )) as { status: string };
  check('advance walks route -> redo -> verify -> close', done.status === 'closed');
  check(
    'advance rejects an out-of-order action',
    await rejects(() =>
      advance.execute({ miss_id: loop_id, action: 'route', note: 'too late' }, ctx_m),
    ),
  );

  // escalation flags Beatrice (trainer)
  const esc_id = store.create({
    subject_specialist_id: 'anya',
    reporter: 'mariah',
    task_summary: 'summarize the visit notes',
    gap: 'same omission again',
    severity: 'medium',
  });
  await advance.execute({ miss_id: esc_id, action: 'route', note: 'recurring' }, ctx_m);
  await advance.execute(
    { miss_id: esc_id, action: 'escalate', note: 'third time — structural' },
    ctx_m,
  );
  check(
    'escalate flags Beatrice (trainer)',
    inbox.unread_for('trainer').some((m) => m.body_md.includes('Recurring process miss')),
  );
  check(
    'escalate sets routed_to=trainer on the miss row',
    store.get(esc_id)?.routed_to === 'trainer',
  );
  check(
    'escalate emits inbox_message_added with severity=high so Beatrice wakes off-schedule',
    captured_events.some(
      (e) =>
        e.type === 'inbox_message_added' &&
        e.to_specialist_id === 'trainer' &&
        e.kind === 'flag' &&
        e.severity === 'high',
    ),
  );

  // ── flag_beatrice (Kate's structural-feedback flag) ────────────────────
  // Use a fresh event capture so we don't reread escalation events.
  const flag_events: AppEvent[] = [];
  const flag_events_mock = {
    emit: (e: AppEvent) => {
      flag_events.push(e);
    },
    subscribe: () => () => {},
  };
  const flag_beatrice = create_flag_beatrice_tool({
    inbox,
    events: flag_events_mock,
  } as unknown as ToolDeps);
  const flag_out = (await flag_beatrice.execute(
    {
      what_went_wrong:
        'Maggie keeps fabricating band members when music_top_artists returns empty.',
      subject: 'tool:music_top_artists',
      suspected_class: 'connector-affordance-gap',
    },
    { specialist_id: 'kate', now: new Date() } as unknown as ToolContext,
  )) as { inbox_message_id: string };
  check(
    'flag_beatrice lands a flag in trainer inbox',
    inbox
      .unread_for('trainer')
      .some(
        (m) =>
          m.id === flag_out.inbox_message_id &&
          m.from_specialist_id === 'kate' &&
          m.body_md.includes('Structural flag'),
      ),
  );
  check(
    'flag_beatrice emits inbox_message_added severity=high',
    flag_events.some(
      (e) =>
        e.type === 'inbox_message_added' &&
        e.to_specialist_id === 'trainer' &&
        e.kind === 'flag' &&
        e.severity === 'high',
    ),
  );
  // ux-feedback class threads Jasper's verbatim words through so
  // Beatrice's propose_persona_tuning can quote them directly.
  const ux_out = (await flag_beatrice.execute(
    {
      what_went_wrong:
        'Jasper called out Kate for inventing VTH parking conditions she could not source.',
      verbatim_feedback: 'How do you know about VTH lots filling fast?',
      subject: 'kate',
      suspected_class: 'ux-feedback',
    },
    { specialist_id: 'kate', now: new Date() } as unknown as ToolContext,
  )) as { inbox_message_id: string };
  const ux_row = inbox
    .unread_for('trainer')
    .find((m) => m.id === ux_out.inbox_message_id);
  check(
    'flag_beatrice ux-feedback class quotes verbatim words in body',
    !!ux_row && ux_row.body_md.includes('VTH lots filling fast'),
  );

  // ── scan_program_patterns: fuzzy detection ─────────────────────────────
  // Seed the three pattern shapes, then run the LLM-judgment scan.
  // HEARTH_TEST_MODE short-circuits the judgment to confirm every
  // gathered candidate, so the assertions stay deterministic.
  process.env.HEARTH_TEST_MODE = '1';
  const audit_ts = new Date().toISOString();
  const audit_stmt = db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, error)
     VALUES (@id, @ts, @i, 'iris', 'plan_ev_day', '{}', 'connector returned 500')`,
  );
  for (let n = 0; n < 4; n++) {
    audit_stmt.run({ '@id': `aud_pat_${n}`, '@ts': audit_ts, '@i': `intp_${n}` });
  }

  // marguerite accumulates three DISTINCT incidents of the SAME class — the
  // real repeated_miss_class shape under the coherent-class gate (2026-06-28):
  // one class token, ULID-suffixed so they're three separate ledger rows that
  // miss_class_key normalizes to `auth:missing-source-citation`.
  for (let n = 0; n < 3; n++) {
    store.create({
      subject_specialist_id: 'marguerite',
      reporter: 'mariah',
      task_summary: `genealogy task ${n}`,
      gap: `missed a source citation (instance ${n})`,
      severity: 'medium',
      evidence_ref: `auth:missing-source-citation:01KW36QABCDEF0${n}`,
    });
  }

  // A conversation where the user had to ask twice — a possible re-ask.
  const conversations = new ConversationStore(db);
  const conv = conversations.create('eleanor', 'frost dates');
  const msg_stmt = db.prepare(
    `INSERT INTO messages (id, conversation_id, ts, role, content_md)
     VALUES (@id, @cid, @ts, 'user', @c)`,
  );
  msg_stmt.run({
    '@id': 'msg_pat_1',
    '@cid': conv.id,
    '@ts': audit_ts,
    '@c': "When's the last frost date for the garden?",
  });
  msg_stmt.run({
    '@id': 'msg_pat_2',
    '@cid': conv.id,
    '@ts': new Date(Date.now() + 30 * 60_000).toISOString(),
    '@c': "I still don't have a frost date — can you actually answer this?",
  });

  const patterns = create_patterns_tool({
    db,
    process_misses: store,
  } as unknown as ToolDeps);
  const pat_out = (await patterns.execute({ lookback_hours: 168 }, {
    now: new Date(),
  } as unknown as ToolContext)) as {
    candidates_seen: number;
    already_tracked: number;
    misses_opened: Array<{
      pattern: string;
      subject_specialist_id: string;
      evidence_ref: string;
    }>;
  };
  check(
    'patterns scan detects the error cluster',
    pat_out.misses_opened.some(
      (m) =>
        m.pattern === 'error_pattern' &&
        m.evidence_ref === 'pattern:errors:iris:plan_ev_day',
    ),
  );
  check(
    'patterns scan detects the repeated miss class',
    pat_out.misses_opened.some(
      (m) =>
        m.pattern === 'repeated_miss_class' &&
        m.subject_specialist_id === 'marguerite',
    ),
  );
  check(
    'patterns scan detects the re-asked consult',
    pat_out.misses_opened.some((m) => m.pattern === 'reasked_consult'),
  );
  const pat_out2 = (await patterns.execute({ lookback_hours: 168 }, {
    now: new Date(),
  } as unknown as ToolContext)) as {
    misses_opened: unknown[];
    already_tracked: number;
  };
  check(
    'patterns scan is idempotent — no double-flagging',
    pat_out2.misses_opened.length === 0 && pat_out2.already_tracked >= 3,
  );

  // ── scan_specialist_alignment: roster check ────────────────────────────
  // Four fake specialists, each isolating one outcome. The registry and
  // roster shapes are stubbed — the tool only reads .list(),
  // .list_for_capabilities(), .proactive and .granted off them.
  const fake_tool_list = Array.from({ length: 16 }, (_, i) => ({
    name: `tool_${i}`,
  }));
  const fake_tool_registry = {
    list: () => fake_tool_list,
    list_for_capabilities: (g: ReadonlySet<string>) =>
      g.has('broad') ? fake_tool_list : fake_tool_list.slice(0, 3),
  };
  const fake_roster = [
    // broad grant, no curation -> uncurated_tool_surface. iris already
    // has audit rows (the patterns section logged them), so the
    // left-behind check stays quiet for her.
    {
      id: 'iris',
      name: 'Iris',
      granted: new Set(['broad']),
      source_path: '/nonexistent/iris.yaml',
      proactive: {
        deliberation_at: ['07:00'],
        tools_for_chat: [],
        tools_for_deliberation: [],
      },
    },
    // broad grant, curated, recent activity -> clean, no miss.
    {
      id: 'kate',
      name: 'Kate',
      granted: new Set(['broad']),
      source_path: '/nonexistent/kate.yaml',
      proactive: {
        deliberation_at: ['07:00'],
        tools_for_chat: ['tool_0', 'tool_1'],
        tools_for_deliberation: ['tool_0'],
      },
    },
    // narrow grant, but a typo'd curation entry -> dangling_curation_ref.
    {
      id: 'vera',
      name: 'Vera',
      granted: new Set(['narrow']),
      source_path: '/nonexistent/vera.yaml',
      proactive: {
        deliberation_at: [],
        tools_for_chat: ['tool_0', 'tool_typo_xyz'],
        tools_for_deliberation: [],
      },
    },
    // narrow grant, clean config, zero audited activity -> left_behind.
    {
      id: 'quill',
      name: 'Quill',
      granted: new Set(['narrow']),
      source_path: '/nonexistent/quill.yaml',
      proactive: {
        deliberation_at: [],
        tools_for_chat: ['tool_0'],
        tools_for_deliberation: [],
      },
    },
  ];
  const fake_specialists = { list: () => fake_roster };
  // Give kate and vera audited activity so only quill trips left_behind.
  const audit_clean = db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input)
     VALUES (@id, @ts, @i, @ag, 'turn', '{}')`,
  );
  for (const ag of ['kate', 'vera']) {
    audit_clean.run({
      '@id': `aud_align_${ag}`,
      '@ts': audit_ts,
      '@i': `inta_${ag}`,
      '@ag': ag,
    });
  }

  const align = create_align_tool({
    db,
    specialists: fake_specialists,
    tool_registry: fake_tool_registry,
    process_misses: store,
  } as unknown as ToolDeps);
  const align_out = (await align.execute({}, {
    now: new Date(),
  } as unknown as ToolContext)) as {
    misses_opened: Array<{ subject_specialist_id: string; finding: string }>;
    already_tracked: number;
  };
  check(
    'alignment scan flags the uncurated tool surface',
    align_out.misses_opened.some(
      (m) =>
        m.subject_specialist_id === 'iris' &&
        m.finding === 'uncurated_tool_surface',
    ),
  );
  check(
    'alignment scan flags the dangling curation ref',
    align_out.misses_opened.some(
      (m) =>
        m.subject_specialist_id === 'vera' &&
        m.finding === 'dangling_curation_ref',
    ),
  );
  check(
    'alignment scan flags the left-behind specialist',
    align_out.misses_opened.some(
      (m) => m.subject_specialist_id === 'quill' && m.finding === 'left_behind',
    ),
  );
  check(
    'alignment scan leaves a curated, active specialist alone',
    !align_out.misses_opened.some((m) => m.subject_specialist_id === 'kate'),
  );
  const align_out2 = (await align.execute({}, {
    now: new Date(),
  } as unknown as ToolContext)) as {
    misses_opened: unknown[];
    already_tracked: number;
  };
  check(
    'alignment scan is idempotent — no double-flagging',
    align_out2.misses_opened.length === 0 && align_out2.already_tracked === 3,
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:process-misses OK'
    : `\nsmoke:process-misses FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
