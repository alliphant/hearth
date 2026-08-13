/**
 * Beatrice's autonomous low-risk fix tool — now ISOLATED + REVIEWED.
 *
 * The tool detects a bounded, low-risk config gap (add an existing tool to a
 * surface, grant a safe-listed read capability, flip an additive opt-in),
 * computes the surgical one-line YAML splice, verifies it re-parses, and then —
 * instead of writing the live working tree — opens an isolated `beatrice/*`
 * branch + PR via `open_change_pr` and files a `beatrice_changes` record for
 * Kate's skeptic review. Nothing goes live until Kate approves AND the owner
 * approves the merge in the Code Shop office (then Beatrice merges).
 *
 * This closes the old hole: the prior version `writeFileSync`'d the live config
 * (uncommitted), which could break the next `git pull --ff-only` deploy and had
 * no review gate. (Its "the container has no git" comment was stale — git is
 * available; `propose_code_change` already uses it.)
 *
 * The change is still STRUCTURALLY bounded — the enum + capability safe-set mean
 * Beatrice can't express an out-of-scope edit — but it now also passes through
 * the same human-and-Kate gate as code, with clean revert (delete the branch /
 * revert the merge) and zero live-tree drift.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { parseDocument } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolRegistry } from '@core/tool_registry';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { Database } from 'bun:sqlite';
import { open_change_pr, resolve_git_config } from '../change_pipeline';
import { route_change_for_review } from '../review_routing';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';

// Capabilities Beatrice may grant without human review. Read-only or
// pure-side-effect-free reads, plus consult primitives. Notably absent:
// every write_* token, send_email, send_sms, spend_money, web_action.
// Adding to this list is a code change Jasper reviews.
const AUTO_APPLY_SAFE_CAPABILITIES = new Set<string>([
  'read_vault',
  'read_calendar',
  'read_home_assistant',
  'read_my_location',
  'read_friday_system',
  'read_friday_pets',
  'read_finance_signals',
  'read_audit_log',
  'read_inbox',
  'read_plex_consumption',
  'read_plex_library',
  'read_music_listening',
  'read_meal_plan',
  'read_household_diets',
  'query_web',
  'query_maps',
  'consult_deep_model',
]);

const SPECIALISTS_DIR = resolve(
  process.env.HEARTH_SPECIALISTS_DIR ?? './config/specialists',
);

const AddToolChange = z.object({
  kind: z.union([
    z.literal('add_tool_to_chat_surface'),
    z.literal('add_tool_to_deliberation_surface'),
  ]),
  tool_name: z.string().min(1),
});

const GrantCapabilityChange = z.object({
  kind: z.literal('grant_capability'),
  capability: z.string().min(1),
});

// Additive boolean opt-ins under `proactive`: each only ever flips OFF→ON
// (never narrowing), each is a single mechanical line, none touches prompt
// text or external authority.
const EnableOptinChange = z.object({
  kind: z.literal('enable_optin'),
  field: z.enum(['research_workload', 'wake_on_flag', 'think_in_deliberation', 'intake_captures']),
});

/**
 * The structurally-bounded change union. Exported so `revert_low_risk_fix`
 * parses the change recorded on an apply audit row from the same schema —
 * one source of truth, no drift between apply and its inverse.
 */
export const LowRiskChangeSchema = z.union([
  AddToolChange,
  GrantCapabilityChange,
  EnableOptinChange,
]);
export type LowRiskChange = z.infer<typeof LowRiskChangeSchema>;

const InputSchema = z.object({
  target_specialist_id: z.string().min(1),
  change: LowRiskChangeSchema,
  rationale: z.string().min(20).max(1000),
  related_pattern_ids: z.array(z.string()).default([]),
});

const OutputSchema = z.object({
  // queued = the change was opened as a branch/PR and sent to Kate for review.
  // It is NOT live. false = a no-op (already present) or a validation refusal.
  queued: z.boolean(),
  change_id: z.string(),
  status: z.string(),
  branch: z.string(),
  pr_url: z.string().nullable(),
  yaml_path: z.string(),
  before_excerpt: z.string(),
  after_excerpt: z.string(),
  reason: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ApplyLowRiskFixDeps {
  tool_registry: ToolRegistry;
  specialists: SpecialistRegistry;
  db: Database;
  inbox: SpecialistInbox;
  events: AppEventBus;
}

function not_queued(yaml_path: string, reason: string, before = '', after = ''): Output {
  return {
    queued: false,
    change_id: '',
    status: '',
    branch: '',
    pr_url: null,
    yaml_path,
    before_excerpt: before,
    after_excerpt: after || before,
    reason,
  };
}

function specialist_yaml_path(id: string): string {
  return resolve(SPECIALISTS_DIR, `${id}.yaml`);
}

function load_doc(yaml_path: string): { doc: ReturnType<typeof parseDocument>; src: string } {
  const src = readFileSync(yaml_path, 'utf-8');
  return { doc: parseDocument(src), src };
}

type Patch = { applied: boolean; reason?: string; next_src?: string };

function leading_ws(line: string): string {
  return line.match(/^(\s*)/)?.[1] ?? '';
}

/**
 * SURGICALLY insert one line at the end of the block whose header is at
 * `header_idx` — splice into the source text, leaving every other byte
 * untouched. A splice produces a one-line diff (the yaml Document round-trip
 * reformats the whole file, which mangled anna/maggie on 2026-06-04).
 */
function insert_into_block(
  src: string,
  header_idx: number,
  build_line: (child_indent: string) => string,
): string {
  const lines = src.split('\n');
  const header_indent = leading_ws(lines[header_idx] ?? '').length;
  let last_child = header_idx;
  let child_indent = '  ';
  for (let i = header_idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const ws = leading_ws(line);
    if (ws.length <= header_indent) break;
    last_child = i;
    child_indent = ws;
  }
  lines.splice(last_child + 1, 0, build_line(child_indent));
  return lines.join('\n');
}

function surface_items(doc: ReturnType<typeof parseDocument>, surface: string): string[] {
  const raw = doc.getIn(['proactive', surface]) as unknown;
  return raw && typeof raw === 'object' && 'items' in raw
    ? (raw as { items: Array<{ value: string }> }).items.map((i) => i.value)
    : Array.isArray(raw)
      ? (raw as string[])
      : [];
}

function patch_chat_tool_surface(
  doc: ReturnType<typeof parseDocument>,
  src: string,
  surface: 'tools_for_chat' | 'tools_for_deliberation',
  tool_name: string,
): Patch {
  const proactive = doc.getIn(['proactive']) as unknown;
  if (!proactive || typeof proactive !== 'object') {
    return { applied: false, reason: 'specialist has no proactive block to extend' };
  }
  if (surface_items(doc, surface).includes(tool_name)) {
    return { applied: false, reason: `${tool_name} already in proactive.${surface}` };
  }
  const lines = src.split('\n');
  const header_idx = lines.findIndex((l) => new RegExp(`^\\s+${surface}:\\s*$`).test(l));
  if (header_idx < 0) {
    return { applied: false, reason: `${surface}: block header not found in source text` };
  }
  return { applied: true, next_src: insert_into_block(src, header_idx, (i) => `${i}- ${tool_name}`) };
}

function patch_capability_grant(
  doc: ReturnType<typeof parseDocument>,
  src: string,
  capability: string,
): Patch {
  if (doc.getIn(['capabilities', capability]) === true) {
    return { applied: false, reason: `${capability} already granted` };
  }
  const lines = src.split('\n');
  const header_idx = lines.findIndex((l) => /^capabilities:\s*$/.test(l));
  if (header_idx < 0) {
    return { applied: false, reason: 'capabilities: block header not found in source text' };
  }
  return { applied: true, next_src: insert_into_block(src, header_idx, (i) => `${i}${capability}: true`) };
}

function patch_boolean_optin(
  doc: ReturnType<typeof parseDocument>,
  src: string,
  field: string,
): Patch {
  if (doc.getIn(['proactive', field]) === true) {
    return { applied: false, reason: `proactive.${field} already true` };
  }
  const lines = src.split('\n');
  const header_idx = lines.findIndex((l) => /^proactive:\s*$/.test(l));
  if (header_idx < 0) {
    return { applied: false, reason: 'proactive: block header not found in source text' };
  }
  const field_re = new RegExp(`^(\\s+)${field}:\\s*(?:true|false)\\b(.*)$`);
  for (let i = header_idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() !== '' && !line.startsWith('#') && leading_ws(line).length === 0) break;
    const m = line.match(field_re);
    if (m) {
      lines[i] = `${m[1]}${field}: true${m[2] ?? ''}`;
      return { applied: true, next_src: lines.join('\n') };
    }
  }
  const child_indent = leading_ws(lines[header_idx + 1] ?? '  ') || '  ';
  lines.splice(header_idx + 1, 0, `${child_indent}${field}: true`);
  return { applied: true, next_src: lines.join('\n') };
}

/** A skimmable 8-line slice centered on the change, for the audit + review card. */
function excerpt(text: string, search: string): string {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.includes(search));
  if (idx < 0) return lines.slice(0, 8).join('\n');
  const start = Math.max(0, idx - 2);
  const end = Math.min(lines.length, idx + 6);
  return lines.slice(start, end).join('\n');
}

export function make_apply_low_risk_fix(deps: ApplyLowRiskFixDeps): Tool<Input, Output> {
  return {
    name: 'apply_low_risk_fix',
    description:
      "Propose a structurally-bounded YAML edit to one specialist's config. " +
      "ONLY use this when you've identified a clearly low-risk gap: an existing registered tool should appear in a specialist's chat/deliberation surface, OR an already-safe-listed read capability should be granted, OR an additive proactive opt-in should be flipped on. " +
      "Allowed changes: (a) add_tool_to_chat_surface; (b) add_tool_to_deliberation_surface; (c) grant_capability (auto-apply safe set — read-only + consult only; never write_*/send_*/spend_*); (d) enable_optin (research_workload, wake_on_flag, think_in_deliberation, intake_captures), never OFF. " +
      "The change is opened as an isolated branch + PR and sent to Kate for skeptic review — it does NOT go live until Kate approves and the owner approves the merge in the Code Shop office. Returns the change_id + branch. " +
      "If your fix is OUTSIDE this scope — write capability, persona/addendum prompt text, trusted_sources, code — use propose_code_change (also reviewed) instead.",
    risk: 'write_internal',
    required_capabilities: ['auto_apply_low_risk'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.target_specialist_id);
      h.update('\n');
      h.update(JSON.stringify(input.change));
      return `apply_low_risk_fix:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const yaml_path = specialist_yaml_path(input.target_specialist_id);
      if (new CodeShopSettings(deps.db).get().paused) {
        return not_queued(yaml_path, 'Beatrice is paused by the owner — no changes are being opened. Un-pause in the Code Shop gear.');
      }
      if (!existsSync(yaml_path)) {
        return not_queued(yaml_path, `target specialist file not found: ${yaml_path}`);
      }

      const target = deps.specialists.get(input.target_specialist_id);
      if (!target) {
        return not_queued(
          yaml_path,
          `specialist '${input.target_specialist_id}' not in registry yet — wait a tick after a hire`,
        );
      }

      const { doc, src } = load_doc(yaml_path);
      let result: Patch;
      let search_marker: string;

      if (input.change.kind === 'grant_capability') {
        const cap = input.change.capability;
        if (!AUTO_APPLY_SAFE_CAPABILITIES.has(cap)) {
          return not_queued(
            yaml_path,
            `'${cap}' is NOT in the auto-apply safe-set — use propose_code_change/write_binding_proposal. Safe-set: ${[...AUTO_APPLY_SAFE_CAPABILITIES].join(', ')}`,
          );
        }
        result = patch_capability_grant(doc, src, cap);
        search_marker = `${cap}:`;
      } else if (input.change.kind === 'enable_optin') {
        result = patch_boolean_optin(doc, src, input.change.field);
        search_marker = `${input.change.field}:`;
      } else {
        const tool_name = input.change.tool_name;
        const tool = deps.tool_registry.get(tool_name);
        if (!tool) {
          return not_queued(
            yaml_path,
            `tool '${tool_name}' not in registry — register the tool first (code change), then re-run`,
          );
        }
        const missing = (tool.required_capabilities ?? []).filter((c) => !target.granted.has(c));
        if (missing.length > 0) {
          return not_queued(
            yaml_path,
            `'${input.target_specialist_id}' is missing capabilities required by '${tool_name}': ${missing.join(', ')}. Grant those first.`,
          );
        }
        const surface =
          input.change.kind === 'add_tool_to_chat_surface' ? 'tools_for_chat' : 'tools_for_deliberation';
        result = patch_chat_tool_surface(doc, src, surface, tool_name);
        search_marker = `- ${tool_name}`;
      }

      const before_excerpt = excerpt(src, search_marker);

      if (!result.applied || !result.next_src) {
        return not_queued(yaml_path, result.reason ?? 'no change', before_excerpt);
      }

      const next_src = result.next_src;

      // Safety net: re-parse the spliced text and confirm the change landed
      // before opening a PR. A splice bug must fail closed.
      const verify = parseDocument(next_src);
      if (verify.errors.length > 0) {
        return not_queued(
          yaml_path,
          `surgical edit produced invalid YAML — aborted: ${verify.errors[0]?.message ?? 'parse error'}`,
          before_excerpt,
        );
      }
      const landed =
        input.change.kind === 'grant_capability'
          ? verify.getIn(['capabilities', input.change.capability]) === true
          : input.change.kind === 'enable_optin'
            ? verify.getIn(['proactive', input.change.field]) === true
            : surface_items(
                verify,
                input.change.kind === 'add_tool_to_chat_surface' ? 'tools_for_chat' : 'tools_for_deliberation',
              ).includes(input.change.tool_name);
      if (!landed) {
        return not_queued(
          yaml_path,
          'post-edit verification failed — change not present after splice; aborted',
          before_excerpt,
        );
      }

      const after_excerpt = excerpt(next_src, search_marker);

      // Open the change as an isolated branch + PR — NO live-tree write.
      const change_kind = input.change.kind;
      const rel_path = `config/specialists/${input.target_specialist_id}.yaml`;
      const branch = `beatrice/low-risk-${input.target_specialist_id}-${change_kind}-${ulid().toLowerCase().slice(-8)}`;
      const dedup_key = `apply_low_risk_fix:${input.target_specialist_id}:${createHash('sha256').update(JSON.stringify(input.change)).digest('hex').slice(0, 12)}`;
      const pr_title = `chore(${input.target_specialist_id}): ${change_kind}`;
      const pr_body = `${input.rationale}\n\nLow-risk config change proposed by Beatrice via apply_low_risk_fix; routed for Kate's skeptic review.`;

      const opened = await open_change_pr({
        branch_name: branch,
        pr_title,
        pr_body,
        files: [{ path: rel_path, contents: next_src }],
        triggered_by: 'beatrice',
        git: resolve_git_config(deps.db),
        db: deps.db,
      });

      const audit_id = ctx.memory.log_action({
        intent_id: ctx.intent_id ?? `apply_low_risk_fix:${ulid()}`,
        agent: 'trainer',
        tool_name: 'apply_low_risk_fix',
        tool_input: {
          target_specialist_id: input.target_specialist_id,
          change: input.change,
          rationale: input.rationale,
          related_pattern_ids: input.related_pattern_ids,
        },
        execution_result: { branch: opened.branch, pr_url: opened.pr_url, before_excerpt, after_excerpt },
        user_id: ctx.user?.id,
      });

      const { change } = route_change_for_review({
        db: deps.db,
        inbox: deps.inbox,
        events: deps.events,
        result: opened,
        origin: 'apply_low_risk_fix',
        change_kind,
        target_specialist_id: input.target_specialist_id,
        rationale_md: input.rationale,
        dedup_key,
        audit_id,
      });

      return {
        queued: true,
        change_id: change.id,
        status: change.status,
        branch: change.branch,
        pr_url: change.pr_url,
        yaml_path,
        before_excerpt,
        after_excerpt,
        reason:
          `Opened ${change.branch} (PR ${change.pr_url ?? 'pending'}) and flagged Kate for skeptic review. ` +
          'It will NOT go live until Kate approves AND you approve the merge in the Code Shop office.',
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_apply_low_risk_fix({
    tool_registry: deps.tool_registry,
    specialists: deps.specialists,
    db: deps.db,
    inbox: deps.inbox,
    events: deps.events,
  }) as Tool;
}
