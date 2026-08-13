/**
 * commission_research — file a durable deep-research commission
 * (2026-06-11).
 *
 * This is Cordelia's "spin off a research task" surface: the caller
 * hands a BRIEF ("build Astrid an authoritative bicycle + e-bike
 * repair repository — Bosch drive systems, hydraulic brakes,
 * drivetrain service"), a target specialist, and optionally SEED
 * documents (direct PDF/DOCX links the user handed over — a service
 * manual, a spec sheet). The tool files a `research_commissions` row
 * and kicks a detached background run immediately; the runner
 * (research_runner.ts) plans subtopics, fans out searches, fetches +
 * quality-gates + shelves documents onto the TARGET's library
 * (chunked + embedded → searchable), then synthesizes a repository
 * guide and flags the target's inbox. Progress is durable — restarts
 * resume, and the nightly advance_research_commissions job sweeps
 * anything unfinished.
 *
 * Trust posture: a commission is owner-initiated work, so judge-
 * cleared out-of-roster domains may shelve directly (verdict
 * recorded); roster-worthy ones ALSO file trusted_source_addition
 * proposals so the standing roster catches up. Denied domains are
 * never used; the source-judge being down degrades to roster-only.
 * Friend-tier callers are refused (commissions spend real acquisition
 * budget and write to shared shelves).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ResearchCommissionStore } from '@memory/stores/research_commissions';
import {
  kick_commission_detached,
  research_enabled,
  runner_deps_from,
  type ResearchRunnerDeps,
} from '../research_runner';

const InputSchema = z.object({
  brief: z
    .string()
    .min(10)
    .max(2000)
    .describe(
      'The research commission, phrased as the outcome wanted: what domain to ' +
        'cover, for what use, any specifics worth honoring ("bicycle and e-bike ' +
        'repair for a Trek Powerfly FS — Bosch drive system service, hydraulic ' +
        'brake bleeds, drivetrain wear"). The planner decomposes this into ' +
        'subtopics; richer briefs plan better.',
    ),
  target_specialist_id: z
    .string()
    .min(1)
    .describe("Whose shelf the repository is built on. Lowercase id ('astrid', 'iris')."),
  title: z
    .string()
    .min(3)
    .max(120)
    .optional()
    .describe('Short display label ("Bike + e-bike repair"). Derived from the brief when omitted.'),
  seed_urls: z
    .array(z.string().url())
    .max(10)
    .default([])
    .describe(
      'Documents the user handed over — direct PDF/DOCX links or pages. ' +
        'Fetched FIRST and shelved at Tier 1 (a hand-delivered manual is ' +
        'pre-trusted, like add_trusted_source). Pass the exact URL, query ' +
        'string and all.',
    ),
  depth: z
    .enum(['standard', 'deep'])
    .default('standard')
    .describe(
      'standard = up to 5 subtopics / ~12 documents; deep = up to 8 subtopics ' +
        '/ ~24 documents. Use deep only when the user asks for exhaustive coverage.',
    ),
});

const OutputSchema = z.object({
  commission_id: z.string().optional(),
  title: z.string().optional(),
  target_specialist_id: z.string(),
  status: z.string().optional(),
  /** True when an OPEN commission with the same brief already existed —
   *  that one is returned; nothing new was filed. */
  already_existed: z.boolean(),
  enabled: z.boolean(),
  next_action: z.string(),
  error: z.string().optional(),
  known_specialist_ids: z.array(z.string()).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function derive_title(brief: string): string {
  const first = brief.split(/[.\n]/)[0] ?? brief;
  const trimmed = first.trim().replace(/\s+/g, ' ');
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}

export function make_commission_research(deps: ResearchRunnerDeps): Tool<Input, Output> {
  return {
    name: 'commission_research',
    description:
      'Spin off a durable deep-research commission: hand it a brief + target specialist (+ optional seed document URLs — direct PDF links welcome) and a background runner plans subtopics, searches, fetches, quality-gates, and shelves a whole document repository onto the target\'s library, then writes a repository guide and flags them. Use for multi-facet repository builds ("make Astrid an expert on bicycle and e-bike repair"), for any request that arrives with seed documents, or when a topic needs more than ~5 documents of coverage — for ONE measured gap use acquire_knowledge, for broadening an existing shelf use curate_for_specialist. Runs in the background over minutes: reply that the commission is filed and check list_research_commissions later — do NOT wait, retry, or re-file after success.',
    risk: 'write_internal',
    required_capabilities: ['run_research_commissions', 'write_vault_any_library', 'query_web'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.brief.trim().toLowerCase());
      h.update(`:${input.target_specialist_id}:${input.depth}`);
      h.update(`:${input.seed_urls.slice().sort().join('|')}`);
      return `commission_research:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const memory = deps.library_deps.memory;
      const agent = ctx.specialist_id ?? 'cordelia';
      const base = {
        target_specialist_id: input.target_specialist_id,
        already_existed: false,
        enabled: research_enabled(),
      };

      if (ctx.user?.tier === 'friend') {
        return {
          ...base,
          error: 'research commissions are owner/household-only',
          next_action:
            'Tell the user a commission needs a household member to request it — ' +
            'offer a one-off lookup (web_search + ingest_to_library) instead.',
        };
      }

      const target = deps.specialists.get(input.target_specialist_id);
      if (!target) {
        return {
          ...base,
          error: `unknown specialist_id "${input.target_specialist_id}"`,
          known_specialist_ids: deps.specialists.list().map((s) => s.id).sort(),
          next_action: 'Retry with one of known_specialist_ids.',
        };
      }

      const store = new ResearchCommissionStore(deps.library_deps.db);

      // Re-file collapse: the same open ask is returned, never twinned.
      const existing = store.find_open_duplicate(target.id, input.brief);
      if (existing) {
        return {
          ...base,
          commission_id: existing.id,
          title: existing.title,
          status: existing.status,
          already_existed: true,
          next_action:
            `Commission ${existing.id} is already ${existing.status} — report that to ` +
            'the user and check list_research_commissions for progress. Do not re-file.',
        };
      }

      const title = input.title ?? derive_title(input.brief);
      // Per-user cordon: a non-owner household requester's repository
      // shelves at THEIR visibility; owner/system builds are shelf-wide.
      const private_to =
        ctx.user && ctx.user.tier !== 'owner' ? ctx.user.id : null;
      const row = store.create({
        target_specialist_id: target.id,
        title,
        brief: input.brief,
        seed_urls: input.seed_urls,
        depth: input.depth,
        requested_by: ctx.user?.id ?? null,
        private_to,
      });

      memory.log_action({
        intent_id: ctx.intent_id,
        agent,
        tool_name: 'commission_research',
        tool_input: {
          commission_id: row.id,
          target_specialist_id: target.id,
          title,
          depth: input.depth,
          seed_urls: input.seed_urls,
        },
        execution_result: { commission_id: row.id, status: row.status },
        user_id: ctx.user?.id,
      });

      if (research_enabled()) {
        kick_commission_detached(deps, row.id, agent);
      }

      return {
        ...base,
        commission_id: row.id,
        title,
        status: row.status,
        next_action: research_enabled()
          ? `Commission ${row.id} filed and running in the background — tell the user ` +
            `the ${target.name} repository is being built (seeds first, then ` +
            `${input.depth} coverage) and that you'll have a guide on their shelf ` +
            'shortly. Check progress later with list_research_commissions.'
          : `Commission ${row.id} filed, but HEARTH_RESEARCH_COMMISSIONS=0 — the ` +
            'runner is disabled; it will execute when the kill switch lifts.',
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_commission_research(runner_deps_from(deps)) as Tool;
}
