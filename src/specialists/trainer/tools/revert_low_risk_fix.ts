/**
 * revert_low_risk_fix — the inverse of apply_low_risk_fix.
 *
 * Given the audit_id of a prior `apply_low_risk_fix`, this looks up the
 * change it recorded and computes the MECHANICAL inverse YAML splice:
 *   - add_tool_to_{chat,deliberation}_surface → remove that `- tool` line
 *   - grant_capability                         → remove that `cap: true` line
 *   - enable_optin                             → flip `field: true` → false
 *
 * It routes through the SAME isolated branch/PR + Kate-review + owner-merge
 * gate as apply (open_change_pr → route_change_for_review) — a revert is a
 * change like any other, never a live-tree write. All three apply kinds are
 * single-line and mechanically reversible, so the surgical-splice approach
 * (one-line diff, every other byte untouched) carries straight over.
 *
 * Scope guard: only an `apply_low_risk_fix` audit row can be reverted, and
 * the inverse is verified to re-parse + to have actually removed/flipped the
 * target before a PR opens — a splice miss fails closed.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { parseDocument } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { Database } from 'bun:sqlite';
import { open_change_pr, resolve_git_config } from '../change_pipeline';
import { route_change_for_review } from '../review_routing';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import { LowRiskChangeSchema, type LowRiskChange } from './apply_low_risk_fix';

const SPECIALISTS_DIR = resolve(
  process.env.HEARTH_SPECIALISTS_DIR ?? './config/specialists',
);

const InputSchema = z.object({
  audit_id: z
    .string()
    .min(1)
    .describe(
      'The audit_log id of the apply_low_risk_fix you want to undo — the ' +
        '`audit_id` from its execution, or look it up in your audit lens.',
    ),
  rationale: z
    .string()
    .min(20)
    .max(1000)
    .describe('Why this fix should be reverted — shown to Kate on review.'),
});

const OutputSchema = z.object({
  // queued = the inverse was opened as a branch/PR and sent to Kate. NOT live.
  queued: z.boolean(),
  reverts_audit_id: z.string(),
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

export interface RevertLowRiskFixDeps {
  specialists: SpecialistRegistry;
  db: Database;
  inbox: SpecialistInbox;
  events: AppEventBus;
}

export type InversePatch = { applied: boolean; reason?: string; next_src?: string };

function leading_ws(line: string): string {
  return line.match(/^(\s*)/)?.[1] ?? '';
}

/** Index range [header+1, end) of the block whose header is at `header_idx`. */
function block_end(lines: string[], header_idx: number): number {
  const header_indent = leading_ws(lines[header_idx] ?? '').length;
  for (let i = header_idx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (leading_ws(line).length <= header_indent) return i;
  }
  return lines.length;
}

function remove_tool_from_surface(
  src: string,
  surface: 'tools_for_chat' | 'tools_for_deliberation',
  tool_name: string,
): InversePatch {
  const lines = src.split('\n');
  const header_idx = lines.findIndex((l) =>
    new RegExp(`^\\s+${surface}:\\s*$`).test(l),
  );
  if (header_idx < 0) {
    return { applied: false, reason: `proactive.${surface} block not found — nothing to revert` };
  }
  const end = block_end(lines, header_idx);
  // Match the bare list item exactly (allow a trailing comment), scoped to
  // this surface's block so a same-named item on another surface is safe.
  const item_re = new RegExp(`^\\s*-\\s+${escape_re(tool_name)}\\s*(?:#.*)?$`);
  for (let i = header_idx + 1; i < end; i++) {
    if (item_re.test(lines[i] ?? '')) {
      lines.splice(i, 1);
      return { applied: true, next_src: lines.join('\n') };
    }
  }
  return {
    applied: false,
    reason: `${tool_name} is not in proactive.${surface} — already reverted or hand-removed`,
  };
}

function remove_capability(src: string, capability: string): InversePatch {
  const lines = src.split('\n');
  const header_idx = lines.findIndex((l) => /^capabilities:\s*$/.test(l));
  if (header_idx < 0) {
    return { applied: false, reason: 'capabilities block not found — nothing to revert' };
  }
  const end = block_end(lines, header_idx);
  const cap_re = new RegExp(`^\\s+${escape_re(capability)}:\\s*true\\b.*$`);
  for (let i = header_idx + 1; i < end; i++) {
    if (cap_re.test(lines[i] ?? '')) {
      lines.splice(i, 1);
      return { applied: true, next_src: lines.join('\n') };
    }
  }
  return {
    applied: false,
    reason: `${capability} is not granted (or not true) — already reverted`,
  };
}

function disable_optin(src: string, field: string): InversePatch {
  const lines = src.split('\n');
  const header_idx = lines.findIndex((l) => /^proactive:\s*$/.test(l));
  if (header_idx < 0) {
    return { applied: false, reason: 'proactive block not found — nothing to revert' };
  }
  const end = block_end(lines, header_idx);
  const field_re = new RegExp(`^(\\s+)${escape_re(field)}:\\s*true\\b(.*)$`);
  for (let i = header_idx + 1; i < end; i++) {
    const m = (lines[i] ?? '').match(field_re);
    if (m) {
      lines[i] = `${m[1]}${field}: false${m[2] ?? ''}`;
      return { applied: true, next_src: lines.join('\n') };
    }
  }
  return {
    applied: false,
    reason: `proactive.${field} is not true — already reverted`,
  };
}

function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compute the inverse splice for a recorded apply change. Pure + exported. */
export function invert_change(src: string, change: LowRiskChange): InversePatch {
  switch (change.kind) {
    case 'add_tool_to_chat_surface':
      return remove_tool_from_surface(src, 'tools_for_chat', change.tool_name);
    case 'add_tool_to_deliberation_surface':
      return remove_tool_from_surface(src, 'tools_for_deliberation', change.tool_name);
    case 'grant_capability':
      return remove_capability(src, change.capability);
    case 'enable_optin':
      return disable_optin(src, change.field);
  }
}

/** The marker the inverse touched — for the before/after excerpt. */
function marker_for(change: LowRiskChange): string {
  switch (change.kind) {
    case 'add_tool_to_chat_surface':
    case 'add_tool_to_deliberation_surface':
      return `- ${change.tool_name}`;
    case 'grant_capability':
      return `${change.capability}:`;
    case 'enable_optin':
      return `${change.field}:`;
  }
}

function excerpt(text: string, search: string): string {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.includes(search));
  if (idx < 0) return lines.slice(0, 8).join('\n');
  return lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 6)).join('\n');
}

/** Re-parse + confirm the inverse actually removed/flipped the target. */
function inverse_landed(next_src: string, change: LowRiskChange): boolean {
  const doc = parseDocument(next_src);
  if (doc.errors.length > 0) return false;
  switch (change.kind) {
    case 'grant_capability':
      return doc.getIn(['capabilities', change.capability]) !== true;
    case 'enable_optin':
      return doc.getIn(['proactive', change.field]) !== true;
    default: {
      const surface =
        change.kind === 'add_tool_to_chat_surface'
          ? 'tools_for_chat'
          : 'tools_for_deliberation';
      const raw = doc.getIn(['proactive', surface]) as unknown;
      const items =
        raw && typeof raw === 'object' && 'items' in raw
          ? (raw as { items: Array<{ value: string }> }).items.map((i) => i.value)
          : Array.isArray(raw)
            ? (raw as string[])
            : [];
      return !items.includes(change.tool_name);
    }
  }
}

function not_queued(yaml_path: string, reason: string, audit_id: string, before = ''): Output {
  return {
    queued: false,
    reverts_audit_id: audit_id,
    change_id: '',
    status: '',
    branch: '',
    pr_url: null,
    yaml_path,
    before_excerpt: before,
    after_excerpt: before,
    reason,
  };
}

export function make_revert_low_risk_fix(deps: RevertLowRiskFixDeps): Tool<Input, Output> {
  return {
    name: 'revert_low_risk_fix',
    description:
      'Undo a previously-applied low-risk config fix by its audit_id. Looks ' +
      'up the recorded change and opens the mechanical inverse (remove the ' +
      'added tool / drop the granted capability / flip the opt-in back to ' +
      'false) as an isolated branch + PR routed to Kate — it does NOT go ' +
      'live until Kate approves and the owner approves the merge. Use this ' +
      "when an apply_low_risk_fix didn't help or caused a regression. Only " +
      'apply_low_risk_fix changes are revertible this way.',
    risk: 'write_internal',
    required_capabilities: ['auto_apply_low_risk'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `revert_low_risk_fix:${input.audit_id}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (new CodeShopSettings(deps.db).get().paused) {
        return not_queued(
          '',
          'Beatrice is paused by the owner — no changes are being opened. Un-pause in the Code Shop gear.',
          input.audit_id,
        );
      }

      const row = deps.db
        .prepare(`SELECT tool_name, tool_input FROM audit_log WHERE id = ?`)
        .get(input.audit_id) as { tool_name: string; tool_input: string } | undefined;
      if (!row) {
        return not_queued('', `audit row ${input.audit_id} not found`, input.audit_id);
      }
      if (row.tool_name !== 'apply_low_risk_fix') {
        return not_queued(
          '',
          `audit row ${input.audit_id} is a '${row.tool_name}', not an apply_low_risk_fix — only apply_low_risk_fix changes are revertible here`,
          input.audit_id,
        );
      }

      let parsed: { target_specialist_id?: unknown; change?: unknown };
      try {
        parsed = JSON.parse(row.tool_input) as typeof parsed;
      } catch {
        return not_queued('', `audit row ${input.audit_id} has unparseable tool_input`, input.audit_id);
      }
      const target_specialist_id =
        typeof parsed.target_specialist_id === 'string' ? parsed.target_specialist_id : null;
      const change_parse = LowRiskChangeSchema.safeParse(parsed.change);
      if (!target_specialist_id || !change_parse.success) {
        return not_queued(
          '',
          `audit row ${input.audit_id} does not carry a recognizable low-risk change to invert`,
          input.audit_id,
        );
      }
      const change = change_parse.data;

      const yaml_path = resolve(SPECIALISTS_DIR, `${target_specialist_id}.yaml`);
      if (!existsSync(yaml_path)) {
        return not_queued(yaml_path, `target specialist file not found: ${yaml_path}`, input.audit_id);
      }
      if (!deps.specialists.get(target_specialist_id)) {
        return not_queued(
          yaml_path,
          `specialist '${target_specialist_id}' not in registry — wait a tick after a hire/fire`,
          input.audit_id,
        );
      }

      const src = readFileSync(yaml_path, 'utf-8');
      const marker = marker_for(change);
      const before_excerpt = excerpt(src, marker);
      const patch = invert_change(src, change);
      if (!patch.applied || !patch.next_src) {
        return not_queued(yaml_path, patch.reason ?? 'nothing to revert', input.audit_id, before_excerpt);
      }
      const next_src = patch.next_src;
      if (!inverse_landed(next_src, change)) {
        return not_queued(
          yaml_path,
          'inverse edit produced invalid YAML or did not remove the target — aborted',
          input.audit_id,
          before_excerpt,
        );
      }
      const after_excerpt = excerpt(next_src, marker);

      const rel_path = `config/specialists/${target_specialist_id}.yaml`;
      const branch = `beatrice/revert-low-risk-${target_specialist_id}-${ulid().toLowerCase().slice(-8)}`;
      const dedup_key = `revert_low_risk_fix:${input.audit_id}`;
      const pr_title = `chore(${target_specialist_id}): revert ${change.kind}`;
      const pr_body =
        `${input.rationale}\n\nReverts apply_low_risk_fix audit \`${input.audit_id}\` ` +
        `(${change.kind}); routed for Kate's skeptic review.`;

      const opened = await open_change_pr({
        branch_name: branch,
        pr_title,
        pr_body,
        files: [{ path: rel_path, contents: next_src }],
        triggered_by: 'beatrice',
        git: resolve_git_config(deps.db),
      });

      const audit_id = ctx.memory.log_action({
        intent_id: ctx.intent_id ?? `revert_low_risk_fix:${ulid()}`,
        agent: 'trainer',
        tool_name: 'revert_low_risk_fix',
        tool_input: { reverts_audit_id: input.audit_id, target_specialist_id, change, rationale: input.rationale },
        execution_result: { branch: opened.branch, pr_url: opened.pr_url, before_excerpt, after_excerpt },
        user_id: ctx.user?.id,
      });

      const { change: record } = route_change_for_review({
        db: deps.db,
        inbox: deps.inbox,
        events: deps.events,
        result: opened,
        origin: 'revert_low_risk_fix',
        change_kind: `revert_${change.kind}`,
        target_specialist_id,
        rationale_md: `Revert of audit ${input.audit_id}. ${input.rationale}`,
        dedup_key,
        audit_id,
      });

      return {
        queued: true,
        reverts_audit_id: input.audit_id,
        change_id: record.id,
        status: record.status,
        branch: record.branch,
        pr_url: record.pr_url,
        yaml_path,
        before_excerpt,
        after_excerpt,
        reason:
          `Opened ${record.branch} (PR ${record.pr_url ?? 'pending'}) reverting ${change.kind}, ` +
          'flagged Kate for review. It will NOT go live until Kate approves AND you approve the merge.',
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_revert_low_risk_fix({
    specialists: deps.specialists,
    db: deps.db,
    inbox: deps.inbox,
    events: deps.events,
  }) as Tool;
}
