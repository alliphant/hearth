export {};
/**
 * smoke:internal-action-gate — propose_action's internal-action gate
 * (2026-07-04, "Kate actually solves shit").
 *
 * Self-contained: temp SQLite + ProposalsStore + a real ToolRegistry holding
 * fixture tools of every risk tier (no LLM, no network). Asserts the
 * filing-time rule: an `action_proposal` naming a runnable tool whose
 * registry risk tier is read/write_internal is REJECTED with a steering
 * message (do it now / delegate it), while every legitimate card shape still
 * files —
 *   - send_external / spend_money dispatches (the permission floor)
 *   - dispatch_only tools (approval-gated by design, e.g. the merge gate)
 *   - requires_step_up / amount_cents specs (the permanent owner floor)
 *   - unknown tools + judgment-shaped specs naming no tool (fail-open)
 *   - system kinds (recommendation etc. — their own review flows)
 *   - a bare factory with no registry wired (fail-open)
 *   - HEARTH_INTERNAL_ACTION_GATE=0 (kill switch)
 * Classification is registry data (the tool's declared risk) — never a
 * keyword list. See propose_action.ts.
 *
 *   bun run smoke:internal-action-gate
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { open_db } from '@memory/stores/structured';
import { ProposalsStore } from '@core/proposals';
import { ToolRegistry } from '@core/tool_registry';
import type { Tool, ToolContext } from '@core/tool';
import type { RiskTier } from '@core/types';
import type { Capability } from '@core/capabilities';
import {
  make_propose_action,
  named_action_tool,
  INTERNAL_RISK_TIERS,
  type ProposeActionDeps,
} from '../src/specialists/kate/tools/propose_action';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

function fixture_tool(
  name: string,
  risk: RiskTier,
  opts: { dispatch_only?: boolean; caps?: string[] } = {},
): Tool {
  return {
    name,
    description: `${name} fixture`,
    risk,
    dispatch_only: opts.dispatch_only,
    required_capabilities: (opts.caps ?? []) as unknown as Capability[],
    input_schema: z.record(z.string(), z.unknown()),
    output_schema: z.record(z.string(), z.unknown()),
    idempotency_key: () => `${name}:fixture`,
    async execute() {
      return {};
    },
  } as Tool;
}

const dir = mkdtempSync(resolve(tmpdir(), 'hearth-internal-gate-'));
const db = open_db(resolve(dir, 'hearth.db'));

try {
  const proposals = new ProposalsStore(db);
  const registry = new ToolRegistry();
  registry.register(fixture_tool('fx_followup', 'write_internal'));
  registry.register(fixture_tool('fx_read_note', 'read'));
  registry.register(fixture_tool('fx_send_email', 'send_external'));
  registry.register(fixture_tool('fx_buy_thing', 'spend_money'));
  registry.register(
    fixture_tool('fx_merge_gate', 'write_internal', { dispatch_only: true }),
  );
  registry.register(
    fixture_tool('fx_gated_internal', 'write_internal', { caps: ['fx_special_cap'] }),
  );

  // Kate's fixture grant covers the plain tools but NOT fx_special_cap, so
  // the gate's two steering variants (do-it-now vs delegate-it) both fire.
  const specialists = {
    get: (id: string) =>
      id === 'kate' ? { granted: new Set(['write_proposals']) } : undefined,
  } as unknown as NonNullable<ProposeActionDeps['specialists']>;

  const gated = make_propose_action(proposals, {
    tool_registry: registry,
    specialists,
  });
  const bare = make_propose_action(proposals);

  const ctx = {
    intent_id: 'smoke-internal-gate',
    now: new Date(),
    specialist_id: 'kate',
  } as unknown as ToolContext;

  const row_count = (): number =>
    (db.prepare(`SELECT COUNT(*) n FROM proposals`).get() as { n: number }).n;

  let seq = 0;
  const file = async (
    tool: ReturnType<typeof make_propose_action>,
    over: Record<string, unknown> = {},
  ): Promise<{ id?: string; error?: string }> => {
    seq++;
    const input = {
      action_spec: { summary: `case ${seq}` },
      rationale: `Smoke case ${seq} — distinct rationale so re-fire collapse stays out of the way.`,
      kind: 'action_proposal',
      execution_kind: 'manual',
      category_signature: {
        kind: 'offer',
        category: 'social',
        anchor: `case-${seq}`,
      },
      ...over,
    };
    try {
      const parsed = tool.input_schema.parse(input);
      const out = await tool.execute(parsed, ctx);
      return { id: (out as { proposal_id: string }).proposal_id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  // ── pure helper ──────────────────────────────────────────────────────────
  check(
    'named_action_tool: top-level dispatch_tool wins',
    named_action_tool('a', { dispatch_tool: 'b', tool_name: 'c' }) === 'a',
  );
  check(
    'named_action_tool: nested dispatch_tool beats tool_name',
    named_action_tool(undefined, { dispatch_tool: 'b', tool_name: 'c' }) === 'b',
  );
  check(
    'named_action_tool: tool_name is the render-verb fallback',
    named_action_tool(undefined, { tool_name: ' c ' }) === 'c',
  );
  check(
    'named_action_tool: a spec naming no tool returns undefined',
    named_action_tool(undefined, { summary: 'judgment ask' }) === undefined,
  );
  check(
    'INTERNAL_RISK_TIERS is exactly the two internal tiers',
    INTERNAL_RISK_TIERS.has('read') &&
      INTERNAL_RISK_TIERS.has('write_internal') &&
      !INTERNAL_RISK_TIERS.has('send_external') &&
      !INTERNAL_RISK_TIERS.has('spend_money'),
  );

  // ── the gate rejects internal-actionable filings ─────────────────────────
  const before = row_count();
  const r1 = await file(gated, {
    dispatch_tool: 'fx_followup',
    dispatch_input: { note: 'remind Ceci about the food trucks' },
  });
  check(
    'a write_internal dispatch is rejected, not filed',
    r1.error != null && row_count() === before,
  );
  check(
    'the rejection names the tool and steers to a direct call now',
    (r1.error ?? '').includes('fx_followup') &&
      /call `fx_followup` yourself/i.test(r1.error ?? '') &&
      /no owner\s+approval/i.test((r1.error ?? '').replace(/\n/g, ' ')),
  );
  check(
    'the rejection names the permission floor, not a tool list',
    /send_external \/ spend_money \/\s*step-up/.test(r1.error ?? ''),
  );

  const r2 = await file(gated, { dispatch_tool: 'fx_read_note' });
  check('a read-tier dispatch is rejected too', r2.error != null);

  const r3 = await file(gated, {
    action_spec: { summary: 'offer', tool_name: 'fx_followup' },
  });
  check(
    'a manual card whose spec names an internal tool_name is rejected (the "Run <tool>" shape)',
    r3.error != null,
  );

  const r4 = await file(gated, {
    action_spec: {
      summary: 'offer',
      dispatch_tool: 'fx_followup',
      dispatch_input: {},
    },
  });
  check(
    'a dispatch_tool nested inside action_spec is rejected (the decide route would run it)',
    r4.error != null,
  );

  const r5 = await file(gated, { dispatch_tool: 'fx_gated_internal' });
  check(
    'an internal tool the filer cannot invoke still never cards — steered to delegate/flag',
    r5.error != null &&
      /missing capability: fx_special_cap/.test(r5.error ?? '') &&
      /delegate/i.test(r5.error ?? ''),
  );

  // ── every legitimate card shape still files ──────────────────────────────
  const s1 = await file(gated, {
    dispatch_tool: 'fx_send_email',
    dispatch_input: { to: 'ceci' },
  });
  check('a send_external dispatch files (the floor)', s1.id != null);
  check(
    'the send dispatch filed as a dispatch proposal',
    s1.id != null && proposals.get(s1.id)?.execution_kind === 'dispatch',
  );

  const s2 = await file(gated, { dispatch_tool: 'fx_buy_thing' });
  check('a spend_money dispatch files (the floor)', s2.id != null);

  const s3 = await file(gated, { dispatch_tool: 'fx_merge_gate' });
  check(
    'a dispatch_only internal tool files (approval-gated by design)',
    s3.id != null,
  );

  const s4 = await file(gated, {
    dispatch_tool: 'fx_followup',
    action_spec: { summary: 'step-up thing', requires_step_up: true },
  });
  check(
    'requires_step_up keeps the card even for an internal tool (the owner floor)',
    s4.id != null,
  );

  const s5 = await file(gated, {
    dispatch_tool: 'fx_followup',
    action_spec: { summary: 'costs money', amount_cents: 2500 },
  });
  check('a positive amount_cents keeps the card (the owner floor)', s5.id != null);

  const s6 = await file(gated, { dispatch_tool: 'fx_no_such_tool' });
  check('an unknown tool name fails open to filing', s6.id != null);

  const s7 = await file(gated, {
    action_spec: { summary: 'should we move the dentist?', options: ['yes', 'no'] },
  });
  check('a judgment-shaped spec naming no tool files untouched', s7.id != null);

  const s8 = await file(gated, {
    kind: 'recommendation',
    dispatch_tool: 'fx_followup',
  });
  check(
    'a system kind (recommendation) is outside the gate even with an internal dispatch',
    s8.id != null,
  );

  const s9 = await file(bare, { dispatch_tool: 'fx_followup' });
  check('a factory with no registry wired fails open (contract smokes)', s9.id != null);

  // ── kill switch ──────────────────────────────────────────────────────────
  process.env.HEARTH_INTERNAL_ACTION_GATE = '0';
  try {
    const k1 = await file(gated, { dispatch_tool: 'fx_followup' });
    check('HEARTH_INTERNAL_ACTION_GATE=0 disables the gate', k1.id != null);
  } finally {
    delete process.env.HEARTH_INTERNAL_ACTION_GATE;
  }
  const k2 = await file(gated, { dispatch_tool: 'fx_followup' });
  check('the gate re-arms when the kill switch is lifted', k2.error != null);

  // ── the sibling gates are untouched ──────────────────────────────────────
  const g1 = await file(gated, {
    action_spec: { summary: 'evening recap of the day' },
    category_signature: { kind: 'evening_brief', category: 'brief', anchor: 'g1' },
  });
  check(
    'the report-shape gate still rejects independently of this one',
    g1.error != null && /brief/i.test(g1.error ?? ''),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:internal-action-gate OK'
    : `\nsmoke:internal-action-gate FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
