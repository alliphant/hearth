export {};
/**
 * Phase 2b — discretion-verification walkthrough.
 *
 * Dumps the per-specialist behavior every configured tier would see
 * if they sent a message into a given specialist. Three layers per
 * row: hard gate (allowed_tiers), soft visibility (open/defer/refuse),
 * and the rendered discretion block injected into the system prompt.
 *
 * The output is a markdown report you can read end-to-end in 5
 * minutes to verify the table in scripts/phase-2b-prompt.md actually
 * matches what the runtime emits. Run BEFORE re-enabling Sam's PIN
 * (the prompt's verification step at line 192-203). No live LLM is
 * invoked; the model behavior is its own thing — this verifies the
 * data and instructions feeding it.
 *
 *   bun run walk:discretion
 *     prints to stdout
 *
 *   bun run walk:discretion -- --out=path/report.md
 *     writes to ~/vault-friday/Decisions/<date>-phase-2b-verification.md
 *     by default; --out=- writes to stdout
 *
 *   bun run walk:discretion -- --user=sam
 *     restrict the walk to a specific caller (default walks all
 *     configured non-owner users in users.yaml)
 *
 * Reads from the live config/specialists/*.yaml and config/users.yaml,
 * so the report reflects the running orchestrator's view.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parse_yaml } from 'yaml';
import { readFileSync } from 'node:fs';
import { SpecialistRegistry } from '@core/specialist';
import {
  is_caller_allowed,
  visibility_for,
  render_discretion_block,
  canned_refusal,
  caller_tier,
} from '@core/discretion';
import { load_extra_capabilities } from '@core/capabilities';
import type { LoadedSpecialist } from '@core/specialist';
import type { Tier } from '@core/users';
import { UserConfigSchema } from '@core/users';
import { z } from 'zod';

// ── CLI args ─────────────────────────────────────────────────────────────

interface CliArgs {
  out: string | null; // null = stdout, '-' = stdout, path = file
  user_filter: string | null; // restrict to this user_id
}

function parse_args(): CliArgs {
  const args: CliArgs = { out: null, user_filter: null };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--out=')) {
      const v = arg.slice('--out='.length);
      args.out = v === '-' ? '-' : v;
    } else if (arg.startsWith('--user=')) {
      args.user_filter = arg.slice('--user='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `bun run walk:discretion [--out=<path|->] [--user=<user_id>]\n` +
          `  --out=<path>  write to file; default is ~/vault-friday/Decisions/<date>-phase-2b-verification.md\n` +
          `  --out=-       write to stdout instead of a file\n` +
          `  --user=<id>   restrict the walk to one user (default: every non-owner user)`,
      );
      process.exit(0);
    }
  }
  return args;
}

// ── User loader ──────────────────────────────────────────────────────────

const UsersFileSchema = z
  .object({
    users: z.array(UserConfigSchema).default([]),
  })
  .passthrough();

interface CallerUser {
  id: string;
  display_name: string;
  tier: Tier;
  allowed_specialists: '*' | string[];
}

function load_users(path: string): CallerUser[] {
  const raw = parse_yaml(readFileSync(path, 'utf-8'));
  const parsed = UsersFileSchema.parse(raw);
  return parsed.users.map((u) => ({
    id: u.id,
    display_name: u.display_name,
    tier: u.tier,
    allowed_specialists: u.allowed_specialists,
  }));
}

// ── Per-specialist row ───────────────────────────────────────────────────

interface Row {
  caller: CallerUser;
  specialist: LoadedSpecialist;
  reachable: boolean;
  reachable_reason: string;
  hard_gate: 'pass' | 'block';
  visibility: 'open' | 'defer' | 'refuse';
  defer_to: string;
  block: string; // rendered discretion block
  refusal_text: string | null; // canned refusal text if hard gate blocks
}

function evaluate(caller: CallerUser, specialist: LoadedSpecialist): Row {
  const allowed_listed =
    caller.allowed_specialists === '*' ||
    caller.allowed_specialists.includes(specialist.id);
  const allowed_caller = is_caller_allowed(specialist, caller);
  const reachable = allowed_listed && allowed_caller;
  const reachable_reason = !allowed_listed
    ? `users.yaml allowed_specialists omits "${specialist.id}"`
    : !allowed_caller
    ? `specialist.discretion.allowed_tiers excludes "${caller.tier}"`
    : 'allowed by both user roster + specialist allowed_tiers';
  const hard_gate: 'pass' | 'block' = allowed_caller ? 'pass' : 'block';
  const v = visibility_for(specialist, caller);
  return {
    caller,
    specialist,
    reachable,
    reachable_reason,
    hard_gate,
    visibility: v,
    defer_to: specialist.discretion.defer_to,
    block: render_discretion_block(specialist, caller),
    refusal_text: hard_gate === 'block' ? canned_refusal(specialist, caller) : null,
  };
}

// ── Markdown formatter ───────────────────────────────────────────────────

function fmt_report(rows: Row[]): string {
  const lines: string[] = [];
  lines.push(`# Phase 2b — Discretion Verification Walkthrough\n`);
  lines.push(`*Generated ${new Date().toISOString()} by \`bun run walk:discretion\`.*\n`);
  lines.push(
    `This report dumps the three discretion layers the runtime presents to ` +
      `each specialist for each non-owner caller. **It does not invoke the ` +
      `LLM** — the model's actual reply is its own thing, sat on top of ` +
      `whatever this report shows below. If the rendered discretion block ` +
      `looks right and the hard gate verdicts match the prompt's table, ` +
      `the discretion stack is correctly configured; any leak from here on ` +
      `is a model-behavior failure to be caught in conversation, not a ` +
      `framework gap.\n`,
  );

  // Group by caller
  const by_caller = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.caller.id;
    if (!by_caller.has(k)) by_caller.set(k, []);
    by_caller.get(k)!.push(r);
  }

  for (const [caller_id, caller_rows] of by_caller) {
    const caller = caller_rows[0]!.caller;
    lines.push(`## Caller: ${caller.display_name} (\`${caller_id}\`, tier=\`${caller.tier}\`)\n`);
    lines.push(`**Configured \`allowed_specialists\`:** ${
      caller.allowed_specialists === '*'
        ? '`*` (all)'
        : caller.allowed_specialists.map((s) => `\`${s}\``).join(', ')
    }\n`);

    // Summary table
    lines.push(`| Specialist | Reachable | Hard gate | Visibility | Defer-to |`);
    lines.push(`|---|---|---|---|---|`);
    for (const r of caller_rows) {
      const reach = r.reachable ? '✓' : '✗';
      const gate = r.hard_gate === 'pass' ? '✓ pass' : '✗ block';
      lines.push(
        `| \`${r.specialist.id}\` (${r.specialist.name}) | ${reach} | ${gate} | ${r.visibility} | \`${r.defer_to}\` |`,
      );
    }
    lines.push('');

    // Per-specialist detail
    for (const r of caller_rows) {
      lines.push(`### ${r.specialist.name} (\`${r.specialist.id}\`)\n`);
      lines.push(`- **Reachable:** ${r.reachable ? 'yes' : 'no'} — ${r.reachable_reason}`);
      lines.push(
        `- **Hard gate (\`allowed_tiers\`):** ${
          r.hard_gate === 'pass'
            ? 'pass — runtime calls the LLM normally'
            : 'block — runtime returns canned refusal **without** invoking the LLM'
        }`,
      );
      lines.push(`- **Soft visibility:** \`${r.visibility}\``);
      lines.push(`- **Defer target:** \`${r.defer_to}\``);
      lines.push(
        `- **Per-user tracking (caller's tier):** ${
          r.specialist.discretion.per_user_tracking[
            r.caller.tier === 'owner' ? 'household' : r.caller.tier
          ]
            ? 'yes'
            : 'no'
        }`,
      );

      if (r.hard_gate === 'block') {
        lines.push(`\n**Canned refusal text the caller would see:**\n`);
        lines.push(`> ${r.refusal_text!.replace(/\n/g, '\n> ')}\n`);
      } else if (r.block) {
        lines.push(`\n**Discretion block injected into the system prompt:**\n`);
        lines.push('```');
        lines.push(r.block);
        lines.push('```');
      } else {
        lines.push(`\n*(No discretion block rendered — caller's tier is open by default.)*\n`);
      }
      lines.push('');
    }
  }

  lines.push(`---\n`);
  lines.push(`## Manual walkthrough checklist\n`);
  lines.push(
    `For each \`(caller, specialist)\` pair the table above marks reachable+pass:\n`,
  );
  lines.push(`1. Sign in as the caller (after re-enabling their PIN).`);
  lines.push(`2. Ask the specialist a question in their domain.`);
  lines.push(`3. Ask the specialist a captain-specific question they shouldn't share.`);
  lines.push(
    `4. Confirm: routes work, refusals fire where expected, no captain-data ` +
      `leaks via tool calls or RAG retrieval.`,
  );
  lines.push(`5. Check the audit log shows the caller's \`user_id\` on every row.`);
  lines.push(``);
  lines.push(
    `If any row visibly drifts from the table in ` +
      `\`scripts/phase-2b-prompt.md\`, edit the specialist's YAML \`discretion\` ` +
      `block and re-run this script.`,
  );

  return lines.join('\n');
}

// ── Default output path ──────────────────────────────────────────────────

function default_out_path(): string {
  const vault = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
  const date = new Date().toISOString().slice(0, 10);
  return resolve(vault, 'Decisions', `${date}-phase-2b-verification.md`);
}

// ── Main ─────────────────────────────────────────────────────────────────

function main(): void {
  const args = parse_args();

  // Capabilities + specialists registry
  load_extra_capabilities('./config/capabilities.yaml');
  const registry = new SpecialistRegistry('./config/specialists');

  // Users
  const users = load_users('./config/users.yaml');
  const candidates = users.filter((u) => {
    if (u.tier === 'owner') return false; // walk is for non-owner callers
    if (args.user_filter && u.id !== args.user_filter) return false;
    return true;
  });
  if (candidates.length === 0) {
    console.error(
      args.user_filter
        ? `No non-owner user matching --user=${args.user_filter}`
        : `No non-owner users configured in users.yaml. Add one with \`tier: household\` or \`tier: friend\` to walk discretion.`,
    );
    process.exit(1);
  }

  // Cartesian: every candidate × every specialist
  const specialists = registry.list().sort((a, b) => a.id.localeCompare(b.id));
  const rows: Row[] = [];
  for (const caller of candidates) {
    for (const spec of specialists) {
      rows.push(evaluate(caller, spec));
    }
  }

  const report = fmt_report(rows);
  const out_target = args.out ?? default_out_path();
  if (out_target === '-') {
    process.stdout.write(report);
    return;
  }
  mkdirSync(dirname(out_target), { recursive: true });
  writeFileSync(out_target, report, 'utf8');
  console.error(`✓ wrote discretion walkthrough to ${out_target}`);
  console.error(`  ${rows.length} rows (${candidates.length} caller(s) × ${specialists.length} specialist(s))`);
  const refusals = rows.filter((r) => r.hard_gate === 'block').length;
  console.error(`  ${refusals} hard-refusal pair(s), ${rows.length - refusals} reaches the LLM`);
}

main();
