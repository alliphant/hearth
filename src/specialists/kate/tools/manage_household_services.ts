/**
 * manage_household_services — the TOLD-FIRST write for the Services & Bills
 * ledger (2026-07-05, built to close the live gap: Kate collected the owner's
 * corrections in chat and had NO way to land them — the ledger was
 * mail-learner-only).
 *
 * ONE all-encompassing tool (the record_person_pref rule): every ledger
 * mutation the owner states in conversation goes through here —
 *   - add:        create (or update, if the vendor already exists —
 *                 create-or-update, never a "call X first" two-step)
 *   - update:     merge the stated fields onto the existing entry
 *   - deactivate: status → lapsed (cancelled/ended services keep history)
 *   - remove:     DELETE the note (for entries that were never the
 *                 household's — e.g. a mis-learned vendor)
 *   - list:       read back the current ledger for spot-checks
 *
 * Write path = EXACTLY the learner's (learn_household_services): frontmatter
 * → `stamp_private_to_if_needed(..., 'shared_entity')` (the ledger is the
 * communal family graph) → `upsert_note(service_note_path(anchor))`; the
 * ingestor projects to the household_services table. `source: 'manual'` +
 * confidence 1.0 — a told fact outranks any mail inference, and the learner's
 * classifier reads the existing ledger so it won't fight a manual entry.
 * Deletes go through `MemoryClient.delete_note` (the single vault-owning
 * delete path).
 *
 * Vendor resolution is deterministic: exact anchor → exact vendor
 * (case-insensitive) → unique substring. A miss or an ambiguous match
 * returns the current vendor roster as `candidates` (the connector
 * affordance pattern) — never a guess.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import { stamp_private_to_if_needed } from '@memory/private_to';
import {
  estimate_next_due,
  format_cents,
  service_id_for,
  service_note_path,
} from '@core/household_services';

const InputSchema = z.object({
  action: z
    .enum(['add', 'update', 'deactivate', 'remove', 'list'])
    .default('list')
    .describe(
      `'add' creates (or updates an existing vendor); 'update' merges stated ` +
        `fields; 'deactivate' marks a cancelled/ended service lapsed; 'remove' ` +
        `deletes an entry that was never ours; 'list' reads the ledger back.`,
    ),
  vendor: z
    .string()
    .optional()
    .describe(`The service/vendor name (e.g. "Pleasantville CityFiber", "T-Mobile").`),
  category: z
    .string()
    .optional()
    .describe(`e.g. internet, cellular, insurance, streaming, utilities, subscription.`),
  cadence: z
    .string()
    .optional()
    .describe(`Billing cadence: monthly, annual, quarterly, weekly, irregular.`),
  amount: z.coerce
    .number()
    .optional()
    .describe(`Typical bill amount in DOLLARS (e.g. 72.96). Converted to cents internally.`),
  autopay: z.boolean().optional(),
  account_hint: z
    .string()
    .optional()
    .describe(`Which account/card pays it, if the user mentioned one.`),
  status: z.enum(['active', 'lapsed', 'uncertain']).optional(),
  next_due: z
    .string()
    .optional()
    .describe(`Next expected bill date, ISO YYYY-MM-DD, if known.`),
  notes: z.string().optional().describe(`Any free-text detail worth keeping on the entry.`),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  vendor: z.string().optional(),
  note_path: z.string().optional(),
  /** Human-readable confirmation of exactly what changed. */
  message: z.string().optional(),
  services: z
    .array(
      z.object({
        vendor: z.string(),
        category: z.string().nullable(),
        cadence: z.string().nullable(),
        amount: z.string().nullable(),
        status: z.string(),
        source: z.string(),
      }),
    )
    .optional(),
  error: z.string().optional(),
  /** Recovery hint: the current vendor roster, for a missed/ambiguous match. */
  candidates: z.array(z.string()).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface ServiceRow {
  id: string;
  vendor: string;
  vendor_anchor: string;
  status: string;
  note_path: string;
  frontmatter_json: string;
}

function slug_anchor(vendor: string): string {
  const cleaned = vendor
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'service';
}

function all_rows(db: Database): ServiceRow[] {
  return db
    .prepare(
      `SELECT id, vendor, vendor_anchor, status, note_path, frontmatter_json
         FROM household_services ORDER BY vendor COLLATE NOCASE`,
    )
    .all() as ServiceRow[];
}

/** Deterministic vendor resolution: anchor → exact name → unique substring. */
function resolve_row(rows: ServiceRow[], vendor: string): ServiceRow | 'ambiguous' | null {
  const needle = vendor.trim().toLowerCase();
  const anchor = slug_anchor(vendor);
  const by_anchor = rows.find((r) => r.vendor_anchor === anchor);
  if (by_anchor) return by_anchor;
  const exact = rows.filter((r) => r.vendor.trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return 'ambiguous';
  const contains = rows.filter(
    (r) =>
      r.vendor.toLowerCase().includes(needle) || needle.includes(r.vendor.toLowerCase()),
  );
  if (contains.length === 1) return contains[0]!;
  if (contains.length > 1) return 'ambiguous';
  return null;
}

function parse_fm(row: ServiceRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.frontmatter_json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function manual_body(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`# ${String(fm.vendor ?? 'Service')}`);
  lines.push('');
  if (fm.category) lines.push(`**Category**: ${String(fm.category)}`);
  if (fm.cadence) lines.push(`**Cadence**: ${String(fm.cadence)}`);
  if (typeof fm.typical_amount_cents === 'number') {
    lines.push(`**Typical amount**: ${format_cents(fm.typical_amount_cents)}`);
  }
  if (fm.account_hint) lines.push(`**Paid via**: ${String(fm.account_hint)}`);
  if (fm.notes) {
    lines.push('');
    lines.push(String(fm.notes));
  }
  lines.push('');
  lines.push(`_Recorded told-first via manage_household_services._`);
  return lines.join('\n');
}

export interface ManageHouseholdServicesDeps {
  db: Database;
  memory: MemoryClient;
}

export function make_manage_household_services(
  deps: ManageHouseholdServicesDeps,
): Tool<Input, Output> {
  return {
    name: 'manage_household_services',
    description:
      `THE write tool for the household Services & Bills ledger — call it the ` +
      `SAME TURN the user states a service fact ("we use X for internet, it's ` +
      `$100/mo", "cancel Twitch", "Cox isn't ours"). action:'add' creates or ` +
      `updates a vendor; 'update' merges fields (amount is in DOLLARS); ` +
      `'deactivate' marks a cancelled service lapsed; 'remove' deletes an entry ` +
      `that was never the household's; 'list' reads the ledger back. Saying ` +
      `"I'll update the ledger" without calling this records NOTHING.`,
    risk: 'write_internal',
    required_capabilities: ['write_household_services'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      for (const part of [
        input.action,
        input.vendor ?? '',
        String(input.amount ?? ''),
        input.status ?? '',
        input.cadence ?? '',
        input.notes ?? '',
      ]) {
        h.update(part);
        h.update('\n');
      }
      return `manage_household_services:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const rows = all_rows(deps.db);
      const roster = rows.map((r) => r.vendor);

      if (input.action === 'list') {
        return {
          ok: true,
          action: 'list',
          services: rows.map((r) => {
            const fm = parse_fm(r);
            return {
              vendor: r.vendor,
              category: (fm.category as string) ?? null,
              cadence: (fm.cadence as string) ?? null,
              amount:
                typeof fm.typical_amount_cents === 'number'
                  ? format_cents(fm.typical_amount_cents)
                  : null,
              status: r.status,
              source: (fm.source as string) ?? 'mail',
            };
          }),
        };
      }

      if (!input.vendor || input.vendor.trim().length === 0) {
        return {
          ok: false,
          action: input.action,
          error: `vendor is required for '${input.action}'`,
          candidates: roster,
        };
      }
      const vendor = input.vendor.trim();
      const resolved = resolve_row(rows, vendor);
      if (resolved === 'ambiguous') {
        return {
          ok: false,
          action: input.action,
          error: `"${vendor}" matches more than one ledger entry — re-call with the exact vendor name`,
          candidates: roster,
        };
      }

      // remove — delete the note; the ingestor unprojects on the unlink.
      if (input.action === 'remove') {
        if (!resolved) {
          return {
            ok: false,
            action: 'remove',
            error: `no ledger entry matches "${vendor}"`,
            candidates: roster,
          };
        }
        deps.memory.delete_note(resolved.note_path);
        deps.db
          .prepare(`DELETE FROM household_services WHERE id = @id`)
          .run({ '@id': resolved.id });
        return {
          ok: true,
          action: 'remove',
          vendor: resolved.vendor,
          message: `Removed ${resolved.vendor} from the services ledger.`,
        };
      }

      if ((input.action === 'update' || input.action === 'deactivate') && !resolved) {
        return {
          ok: false,
          action: input.action,
          error: `no ledger entry matches "${vendor}" — 'add' it, or re-call with a vendor from the roster`,
          candidates: roster,
        };
      }

      // add / update / deactivate — create-or-update through the learner's
      // exact note-write path. next_due must be a plausible ISO date; the
      // shape check lives HERE, never as a schema regex (the GBNF rule).
      if (input.next_due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.next_due)) {
        return {
          ok: false,
          action: input.action,
          error: `next_due must be ISO YYYY-MM-DD (got "${input.next_due}"). Re-call with the corrected date.`,
        };
      }
      const existing_fm = resolved ? parse_fm(resolved) : {};
      const anchor = resolved
        ? resolved.vendor_anchor
        : slug_anchor(vendor);
      const fm: Record<string, unknown> = {
        ...existing_fm,
        type: 'household_service',
        id: resolved?.id ?? service_id_for(anchor),
        vendor: resolved && input.action !== 'add' ? resolved.vendor : vendor,
        vendor_anchor: anchor,
        currency: (existing_fm.currency as string) ?? 'USD',
        // A told fact is ground truth.
        source: 'manual',
        confidence: 1.0,
        evidence_refs: (existing_fm.evidence_refs as string[]) ?? [],
        sender_domains: (existing_fm.sender_domains as string[]) ?? [],
        status:
          input.action === 'deactivate'
            ? 'lapsed'
            : (input.status ?? (existing_fm.status as string) ?? 'active'),
      };
      if (input.category !== undefined) fm.category = input.category;
      if (input.cadence !== undefined) fm.cadence = input.cadence;
      if (input.amount !== undefined) {
        if (!Number.isFinite(input.amount) || input.amount < 0) {
          return {
            ok: false,
            action: input.action,
            error: `amount must be a non-negative dollar figure (got ${input.amount})`,
          };
        }
        fm.typical_amount_cents = Math.round(input.amount * 100);
      }
      if (input.autopay !== undefined) fm.autopay = input.autopay;
      if (input.account_hint !== undefined) fm.account_hint = input.account_hint;
      if (input.notes !== undefined) fm.notes = input.notes;
      if (input.next_due !== undefined) {
        fm.next_due_estimate = input.next_due;
      } else if (!fm.next_due_estimate && typeof fm.cadence === 'string') {
        const due = estimate_next_due(
          (fm.last_bill_date as string) ?? null,
          fm.cadence,
          ctx.now,
          ctx.user?.timezone,
        );
        if (due) fm.next_due_estimate = due;
      }

      // The ledger is the communal family graph — the learner's exact stamp.
      const stamped = stamp_private_to_if_needed(
        fm,
        ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
        'shared_entity',
      );
      if (!stamped.private_to) stamped.private_to = 'household';

      const note_path = resolved?.note_path ?? service_note_path(anchor);
      deps.memory.upsert_note(note_path, stamped, manual_body(stamped));

      const verb =
        input.action === 'deactivate'
          ? 'Marked lapsed'
          : resolved
            ? 'Updated'
            : 'Added';
      const amount_part =
        typeof stamped.typical_amount_cents === 'number'
          ? ` at ${format_cents(stamped.typical_amount_cents as number)}${stamped.cadence ? `/${String(stamped.cadence)}` : ''}`
          : '';
      return {
        ok: true,
        action: input.action,
        vendor: String(stamped.vendor),
        note_path,
        message: `${verb} ${String(stamped.vendor)}${amount_part} in the services ledger.`,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_manage_household_services({ db: deps.db, memory: deps.memory }) as Tool;
}
