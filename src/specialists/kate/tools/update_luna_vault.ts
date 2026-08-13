/**
 * update_luna_vault — Luna's house-steward ledger writer.
 *
 * Five kinds, five destinations, all under her own namespace. Maintenance
 * is a calendar plus a log: the *cadence* file says what the house needs
 * and when, the *log* says what was actually done. Keeping both current
 * is the core of the steward job — a cadence with no completion log
 * can't tell "due" from "done".
 *
 *   - `inventory`       → Knowledge/Luna/home-systems-inventory.md
 *                         OVERWRITES. The systems registry: furnace,
 *                         water heater, roof, appliances — brand /
 *                         model / serial / install date / filter sizes /
 *                         warranty window. Seeded as a template by
 *                         scripts/seed-luna-knowledge.ts; Luna re-emits
 *                         the full document as facts land.
 *   - `cadence`         → Knowledge/Luna/maintenance-cadence.md
 *                         OVERWRITES. Her forward maintenance calendar
 *                         (month-anchored, Pleasantville climate). She
 *                         refines it as the house teaches her — but the
 *                         full document is re-emitted each time, so the
 *                         calendar never decays into fragments.
 *   - `maintenance_log` → Knowledge/Luna/maintenance-log.md
 *                         Append-only dated record of completed work
 *                         ("furnace filter replaced, 16x25x1 MERV 11").
 *                         What the Monday pass reads to compute overdue.
 *                         Capped at 300 entries.
 *   - `provider`        → Knowledge/Luna/service-providers.md
 *                         Append-only contractor/service ledger entry
 *                         (trade, who, what they did, would-use-again).
 *                         Rich contact detail belongs on a Person note;
 *                         this is the trade-history index. Capped 200.
 *   - `memory`          → Knowledge/Luna/memory.md
 *                         Household-level observations + her own working
 *                         notes. Capped at 200.
 *
 * Capability: write_vault_luna. Paths are hardcoded so the grant can't
 * be misused to scribble elsewhere in the vault. Mirrors
 * update_astrid_vault — the per-specialist vault-writer idiom.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const KindEnum = z.enum(['note', 'inventory', 'cadence', 'maintenance_log', 'provider', 'memory']);

const InputSchema = z.object({
  kind: KindEnum.describe(
    "Where to write. `note` APPENDS one house fact to the running notes log (capped 400) — the CHEAP, DEFAULT landing for an incremental fact the owner just told you (an appliance model/serial, an order number, a price, who installed what). ONE fact per call; never rewrite a document for this. `inventory` OVERWRITES the structured home-systems registry with the FULL document — use it only to CONSOLIDATE (your Monday pass, or when asked to rebuild the inventory), never per-fact. `cadence` OVERWRITES the maintenance calendar (full document). `maintenance_log` appends one dated completed-work entry (capped 300). `provider` appends one contractor/service entry (capped 200). `memory` appends a working note (capped 200).",
  ),
  body: z
    .string()
    .min(1)
    .max(20_000)
    .describe(
      'Markdown body. For `note`, ONE house fact in a sentence or two (e.g. "Half-bath toilet: TOTO Nexus 1.28 GPF, order #2000116228 from BidetKing 12/8/22, installed by Thad Delveaux"). For `inventory` / `cadence`, the FULL document (these overwrite — never send a fragment). For `maintenance_log`, one completed task. For `provider`, one entry: trade, name, what they did, verdict. For `memory`, one short note.',
    ),
  title: z
    .string()
    .max(200)
    .optional()
    .describe('Optional human title for `inventory` / `cadence` (overrides the default header).'),
});

const OutputSchema = z.object({
  rel_path: z.string(),
  kind: z.string(),
  bytes_written: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const MAINTENANCE_LOG_HEADER = `# Maintenance log

Dated record of completed house maintenance — what was done, on which
system, with which parts/consumables. The Monday pass diffs this against
the cadence calendar to compute what's due or overdue. Newest first;
capped at 300 entries.

<!-- entries below -->
`;

const PROVIDERS_HEADER = `# Service providers

Contractor and service-visit ledger — trade, who, what they did, and
whether we'd use them again. Rich contact detail (phone, address) lives
on the provider's Person note; this is the trade-history index. Newest
first; capped at 200 entries.

<!-- entries below -->
`;

const MEMORY_HEADER = `# Luna's memory

Working notes from Luna — Hearth's house steward. Patterns the house is
teaching her, seasonal observations, things to fold into the next
cadence revision. Newest first; capped at 200 entries.

<!-- entries below -->
`;

const HOUSE_NOTES_HEADER = `# House notes

Incremental house facts captured as the owner shares them — appliance
models and serials, order numbers and prices, who installed what. The
cheap landing for one fact at a time; Luna's Monday pass folds the
confirmed ones into the structured home-systems inventory. Newest
first; capped at 400 entries.

<!-- entries below -->
`;

const MAX_LOG_ENTRIES = 300;
const MAX_PROVIDER_ENTRIES = 200;
const MAX_MEMORY_ENTRIES = 200;
const MAX_NOTE_ENTRIES = 400;

/** Prepend a `### `-headed entry under the `<!-- entries below -->` marker,
 *  dropping the oldest entries past `cap`. Shared with the nightly house
 *  ledger (distill_house_day) — same pack, same reload unit. */
export function append_with_cap(
  existing: string,
  header: string,
  entry: string,
  cap: number,
): string {
  let content = existing.length > 0 ? existing : header;
  if (!content.startsWith('# ')) content = header + '\n' + content;

  const marker = '<!-- entries below -->';
  const idx = content.indexOf(marker);
  const insert_at = idx >= 0 ? idx + marker.length : content.length;
  const prefix = content.slice(0, insert_at);
  const suffix = content.slice(insert_at);
  let next = `${prefix}\n\n${entry}\n${suffix}`;

  const headers = [...next.matchAll(/^### /gm)];
  if (headers.length > cap) {
    const cutoff = headers[cap];
    if (cutoff && cutoff.index !== undefined) {
      next = next.slice(0, cutoff.index);
    }
  }
  return next;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'update_luna_vault',
    description:
      "Write into Luna's house-steward ledgers. `kind=note` is the CHEAP DEFAULT for an incremental house fact the owner just told you (appliance model/serial, order number, price, who installed what) — appends ONE fact to Knowledge/Luna/house-notes.md (capped 400); never rewrite a document for a single fact. `kind=inventory` OVERWRITES Knowledge/Luna/home-systems-inventory.md with the FULL systems registry — use only to CONSOLIDATE (the Monday pass or an explicit rebuild), never per fact. `kind=cadence` OVERWRITES the full forward maintenance calendar. `kind=maintenance_log` appends one dated completed-work entry (capped 300). `kind=provider` appends one contractor/service entry (capped 200). `kind=memory` appends a working note (capped 200). Only say you saved something if you actually called this tool THIS turn.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_luna'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.kind);
      h.update('\n');
      h.update(input.body);
      if (input.title) h.update(`\n${input.title}`);
      return `update_luna_vault:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const ts = (ctx.now ?? new Date()).toISOString();
      let rel_path: string;
      let final_content: string;

      if (input.kind === 'note') {
        rel_path = 'Knowledge/Luna/house-notes.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const entry = `### ${ts}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, HOUSE_NOTES_HEADER, entry, MAX_NOTE_ENTRIES);
      } else if (input.kind === 'inventory') {
        rel_path = 'Knowledge/Luna/home-systems-inventory.md';
        const title = input.title ?? 'Home systems inventory';
        final_content =
          `---\ntype: house_inventory\nupdated: ${ts}\n---\n\n` +
          `# ${title}\n\n_Updated ${ts} by Luna._\n\n${input.body.trim()}\n`;
      } else if (input.kind === 'cadence') {
        rel_path = 'Knowledge/Luna/maintenance-cadence.md';
        const title = input.title ?? 'Maintenance cadence';
        final_content =
          `---\ntype: house_cadence\nupdated: ${ts}\n---\n\n` +
          `# ${title}\n\n_Updated ${ts} by Luna._\n\n${input.body.trim()}\n`;
      } else if (input.kind === 'maintenance_log') {
        rel_path = 'Knowledge/Luna/maintenance-log.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const entry = `### ${ts}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, MAINTENANCE_LOG_HEADER, entry, MAX_LOG_ENTRIES);
      } else if (input.kind === 'provider') {
        rel_path = 'Knowledge/Luna/service-providers.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const entry = `### ${ts}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, PROVIDERS_HEADER, entry, MAX_PROVIDER_ENTRIES);
      } else {
        rel_path = 'Knowledge/Luna/memory.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const entry = `### ${ts}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, MEMORY_HEADER, entry, MAX_MEMORY_ENTRIES);
      }

      const abs = resolve(deps.vault_root, rel_path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, final_content, 'utf8');

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'luna',
        tool_name: 'update_luna_vault',
        tool_input: {
          kind: input.kind,
          rel_path,
          title: input.title,
          bytes: final_content.length,
        },
        execution_result: { rel_path, bytes_written: final_content.length },
      });

      return { rel_path, kind: input.kind, bytes_written: final_content.length };
    },
  };
}
