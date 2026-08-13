/**
 * The Politics Desk tools — Ruby's promotion (2026-06-10 #2) from civic
 * correspondent to politics correspondent. Pleasantville coverage keeps its
 * whole existing machinery (civic_items / corridor matching / the meeting
 * scan); these two tools own the OTHER altitudes:
 *
 *   - record_politics_item — capture a state (Colorado) / national / world
 *     development into the scoped ledger, optionally with Ruby's `take_md`
 *     (her grounded read — what it is, why it matters, who it helps or
 *     hurts, with the receipts). Fact-kinds require a citing url; takes
 *     are sticky (a later bare re-record never wipes one).
 *   - query_politics_desk — read the desk back by scope, takes included.
 *
 * The office renders these as the Colorado / Nation & World tabs and rolls
 * the highest-interest items (with takes, tap-to-expand) into The Brief.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { get_ruby_civic_store } from '@memory/stores/ruby_civic';
import { EVIDENCE_READ_TOOLS, quote_in_evidence } from '../civic_analysis';

const FACT_KINDS = new Set(['bill', 'election', 'ruling', 'executive', 'policy', 'event']);

// ── record_politics_item ─────────────────────────────────────────────────────

const RecordInputSchema = z
  .object({
    scope: z
      .enum(['state', 'national', 'world'])
      .describe('state = Colorado; national = US federal politics; world = international. Pleasantville items go to record_civic_item, not here.'),
    kind: z
      .enum(['bill', 'election', 'ruling', 'executive', 'policy', 'event', 'watching'])
      .default('event'),
    title: z.string().min(1).max(300),
    summary: z.string().max(600).optional().describe('The facts, neutral, one or two sentences.'),
    take_md: z
      .string()
      .max(2_000)
      .optional()
      .describe("Your read: what it actually means, who it helps or hurts, grounded in the cited source. Spicy is fine; uncited isn't."),
    event_at: z.string().max(25).optional().describe('ISO date of the vote/ruling/election when known.'),
    url: z.string().url().max(500).optional().describe('The citing document/article. REQUIRED for every kind except watching.'),
    evidence_quote: z
      .string()
      .max(400)
      .optional()
      .describe('REQUIRED for every kind except watching: a VERBATIM sentence from a page you read this turn that states the fact. Verified against what you actually fetched.'),
    source: z.string().max(120).optional().describe("Source name, e.g. 'Colorado Sun', 'leg.colorado.gov', 'AP'."),
    interest_score: z.number().min(0).max(1).default(0.5),
    dedup_key: z.string().max(120).optional(),
  })
  .strict();

const RecordOutputSchema = z.object({
  ok: z.boolean(),
  stored: z.boolean(),
  reason: z.string().optional(),
  error: z.string().optional(),
});

type RecordInput = z.infer<typeof RecordInputSchema>;
type RecordOutput = z.infer<typeof RecordOutputSchema>;

export const record_politics_item: Tool<RecordInput, RecordOutput> = {
  name: 'record_politics_item',
  description:
    "Capture a state (Colorado) / national / world political development into your Politics Desk — the office's Colorado and Nation & World tabs, and (at high interest) The Brief rollup. Pass take_md with your grounded read whenever you have one — that's what the household opens the office FOR; a bare headline is half the job. Fact kinds (bill/election/ruling/executive/policy/event) REQUIRE url AND evidence_quote — a verbatim sentence from a page you read this turn stating the fact (verified against what you actually fetched; read the source first). 'watching' is your radar and may be uncited. Re-recording refreshes (idempotent on scope+title); an empty take never wipes an existing one; a dismissed item stays dismissed. Pleasantville items go to record_civic_item instead.",
  risk: 'write_internal',
  required_capabilities: ['write_civic_intel'],
  input_schema: RecordInputSchema,
  output_schema: RecordOutputSchema,

  idempotency_key(input) {
    return `record_politics_item:${input.scope}:${input.title.toLowerCase().trim().slice(0, 60)}`;
  },

  async execute(input, ctx: ToolContext): Promise<RecordOutput> {
    try {
      // Evidence-quote gate (the StreetMedia fabrication class, applied to
      // the desk's fact-kinds): the claim must trace to something this
      // turn actually read — checked against the turn's audited read
      // results, no re-fetch. 'watching' stays the honest home for an
      // unconfirmed lead.
      if (FACT_KINDS.has(input.kind)) {
        const quote = (input.evidence_quote ?? '').trim();
        if (quote.length < 12) {
          return {
            ok: false,
            stored: false,
            reason: `kind '${input.kind}' asserts a fact and requires evidence_quote — a verbatim sentence from the page that states it. Fetch the source, quote it, or record as kind 'watching'.`,
          };
        }
        const evidence = ctx.memory.audit_evidence_for_intent(ctx.intent_id, EVIDENCE_READ_TOOLS);
        if (evidence.length === 0 || !quote_in_evidence(quote, evidence)) {
          return {
            ok: false,
            stored: false,
            reason:
              evidence.length === 0
                ? "no source was read this turn — web_fetch_clean the page you're citing first, then re-record with its exact sentence as evidence_quote (or use kind 'watching')."
                : "evidence_quote does not appear in anything read this turn — copy the EXACT sentence from the fetched page, don't paraphrase. If no page states it, it's kind 'watching' or it doesn't ship.",
          };
        }
      }
      const verdict = get_ruby_civic_store().record_politics_item(input);
      return { ok: verdict.stored, stored: verdict.stored, reason: verdict.reason };
    } catch (err) {
      return {
        ok: false,
        stored: false,
        error: (err as Error).message,
        reason: `Validation failed: ${(err as Error).message}. Check the schema for required fields and types, then re-call.`,
      };
    }
  },
};

// ── query_politics_desk ──────────────────────────────────────────────────────

const QueryInputSchema = z
  .object({
    scope: z.enum(['state', 'national', 'world']).optional().describe('Omit for all three scopes.'),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

const QueryOutputSchema = z.object({
  ok: z.boolean(),
  count: z.number(),
  counts_by_scope: z.record(z.string(), z.number()),
  rows: z.array(z.record(z.string(), z.unknown())),
  error: z.string().optional(),
});

type QueryInput = z.infer<typeof QueryInputSchema>;
type QueryOutput = z.infer<typeof QueryOutputSchema>;

export const query_politics_desk: Tool<QueryInput, QueryOutput> = {
  name: 'query_politics_desk',
  description:
    "Read your Politics Desk back: the state / national / world items you're tracking, highest interest first, each with its take_md (your prior read) and citing url. First call on a state-or-bigger politics question — answer from the desk + its citations before reaching for the open web, and notice items whose take is empty (those are takes you owe).",
  risk: 'read',
  required_capabilities: ['read_civic_intel'],
  input_schema: QueryInputSchema,
  output_schema: QueryOutputSchema,

  idempotency_key(input) {
    return `query_politics_desk:${input.scope ?? 'all'}:${input.limit}`;
  },

  async execute(input, _ctx: ToolContext): Promise<QueryOutput> {
    try {
      const store = get_ruby_civic_store();
      const rows = store.list_politics_items({ scope: input.scope, limit: input.limit });
      return {
        ok: true,
        count: rows.length,
        counts_by_scope: store.politics_counts_by_scope(),
        rows: rows as unknown as Array<Record<string, unknown>>,
      };
    } catch (err) {
      return { ok: false, count: 0, counts_by_scope: {}, rows: [], error: (err as Error).message };
    }
  },
};
