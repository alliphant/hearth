/**
 * acquire_knowledge — Cordelia's demand-driven acquisition sprint
 * (knowledge metabolism #3, 2026-06-10).
 *
 * One topic, one target shelf: search the web, fetch the top IN-ROSTER
 * candidates (the target's `trusted_sources` YAML manifest + their
 * source subscriptions — see sources_store.roster_tier), run each
 * through the quality gate, and shelve what survives via
 * save_library_item (chunks_fts + embeddings, trust_tier stamped). A
 * GOOD candidate on an out-of-roster domain files a
 * `trusted_source_addition` proposal for Jasper — never a silent shelf;
 * the owner approves every roster addition.
 *
 * This is the sprint the demand ledger feeds: knowledge_demand_report
 * surfaces evidence-backed gap topics → acquire_knowledge(topic,
 * specialist) closes them. Beatrice's expertise_gap flags route here
 * the same way (the deliberation playbook wires both).
 *
 * Per-user cordon: when the demand evidence came from ONE non-owner
 * user (the report's `private_to_hint`), pass it as
 * `private_to_user_id` — the shelved material then cordons to that
 * user's visibility instead of shelf-wide.
 *
 * Differs from curate_for_specialist (multi-focus-area enrichment over
 * Tier-1 site:-scoped searches) in being single-topic, roster-extended
 * (subscriptions count), cordon-aware, and demand-anchored — reach for
 * curate when broadening a shelf, for acquire when closing a measured
 * gap.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import type { ProposalsStore } from '@core/proposals';
import type { UserRegistry } from '@core/users';
import { web_search } from '@connectors/searxng';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';
import { denied_domains_for, read_sources, roster_tier } from '../sources_store';

const InputSchema = z.object({
  topic: z
    .string()
    .min(3)
    .max(180)
    .describe(
      'The knowledge gap to close, phrased as the user would ask it ' +
        '("EV off-peak charging rates Pleasantville"), not a search-string.',
    ),
  specialist_id: z
    .string()
    .min(1)
    .describe("Whose shelf the material lands on. Lowercase id ('iris', 'anya')."),
  max_candidates: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(5)
    .describe('Cap on in-roster candidates fetched + shelved. Hard max 5 per sprint.'),
  private_to_user_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Cordon: when the demand evidence came from one non-owner user (the demand report's " +
        'private_to_hint), pass their id so shelved material stays at THEIR visibility. ' +
        'Omit for shelf-wide reference material.',
    ),
  silent: z
    .boolean()
    .default(false)
    .describe(
      'Autonomous mode: shelve in-roster survivors only and SUPPRESS the out-of-roster ' +
        "trusted_source_addition proposals (no owner attention). For the nightly self-fetch " +
        'pass — the owner never gets a queue item from a background acquisition.',
    ),
});

const ShelvedSchema = z.object({
  url: z.string(),
  trust_tier: z.union([z.literal(1), z.literal(2)]),
  wrapper_note_path: z.string(),
  title: z.string(),
});

const ProposedSchema = z.object({
  url: z.string(),
  domain: z.string(),
  proposal_id: z.string(),
});

const SkippedSchema = z.object({
  url: z.string(),
  reason: z.string(),
});

const OutputSchema = z.object({
  topic: z.string(),
  specialist_id: z.string(),
  shelved: z.array(ShelvedSchema),
  proposed: z.array(ProposedSchema),
  skipped: z.array(SkippedSchema),
  /** Populated on the error path, with recovery alongside. */
  error: z.string().optional(),
  /** Recovery hint: valid specialist ids when specialist_id was unknown. */
  known_specialist_ids: z.array(z.string()).optional(),
  /** Recovery hint: the concrete next move when the sprint shelved nothing. */
  next_action: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface AcquireKnowledgeDeps {
  specialists: SpecialistRegistry;
  proposals: ProposalsStore;
  library_deps: LibraryRoutesDeps;
  users?: UserRegistry;
  /** Smoke seams — default to the real connectors. */
  search_fn?: typeof web_search.execute;
  fetch_fn?: typeof fetch_with_browser_fallback;
}

/** Out-of-roster proposals per sprint — the queue is owner attention. */
const MAX_PROPOSALS_PER_SPRINT = 2;
/** Only top-ranked results qualify as "good" out-of-roster candidates. */
const PROPOSAL_RANK_WINDOW = 8;

function host_of(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function make_acquire_knowledge(deps: AcquireKnowledgeDeps): Tool<Input, Output> {
  const search_fn = deps.search_fn ?? web_search.execute.bind(web_search);
  const fetch_fn = deps.fetch_fn ?? fetch_with_browser_fallback;
  return {
    name: 'acquire_knowledge',
    description:
      "Run a demand-driven acquisition sprint: search the web for ONE topic, fetch the top candidates from the target specialist's trusted roster (their trusted_sources manifest + source subscriptions, cap 5), quality-gate, and shelve survivors onto their library with trust_tier provenance. A well-ranked candidate from an out-of-roster domain files a trusted_source_addition proposal for Jasper instead of shelving — owner approval is the roster gate. Feed it topics from knowledge_demand_report (pass that topic's private_to_hint as private_to_user_id when set) or from a Beatrice expertise-gap flag. For multi-area shelf broadening use curate_for_specialist; this is for closing one measured gap.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_any_library', 'query_web'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.topic.toLowerCase().trim());
      h.update(`:${input.specialist_id}:${input.max_candidates}:${input.private_to_user_id ?? ''}`);
      return `acquire_knowledge:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const memory = deps.library_deps.memory;
      const agent = ctx.specialist_id ?? 'cordelia';
      const base: Output = {
        topic: input.topic,
        specialist_id: input.specialist_id,
        shelved: [],
        proposed: [],
        skipped: [],
      };

      const target = deps.specialists.get(input.specialist_id);
      if (!target) {
        // Recovery hint instead of a bare throw — give the model the
        // valid ids so the retry is grounded (connector affordance rule).
        return {
          ...base,
          error: `unknown specialist_id "${input.specialist_id}"`,
          known_specialist_ids: deps.specialists.list().map((s) => s.id).sort(),
          next_action: 'Retry with one of known_specialist_ids.',
        };
      }

      const search_resp = await search_fn({ query: input.topic, max_results: 15 }, ctx);
      if (search_resp.error) {
        return {
          ...base,
          error: `web_search failed: ${search_resp.error}`,
          next_action:
            'Search backend unreachable — retry later, or use curate_for_specialist with explicit focus areas once search is back.',
        };
      }

      const entries = read_sources(memory);
      const denied = denied_domains_for(memory, target.id);
      const seen_urls = new Set<string>();
      const proposed_domains = new Set<string>();

      for (let rank = 0; rank < search_resp.results.length; rank++) {
        const hit = search_resp.results[rank]!;
        if (base.shelved.length >= input.max_candidates) break;
        if (seen_urls.has(hit.url)) continue;
        seen_urls.add(hit.url);
        const host = host_of(hit.url);
        if (!host) {
          base.skipped.push({ url: hit.url, reason: 'unparseable URL' });
          continue;
        }

        const tier = roster_tier(hit.url, target, entries);
        if (tier === null) {
          // Out-of-roster. A top-ranked hit is a GOOD candidate → propose
          // (never silently shelve); below the window it's just noise. In
          // `silent` (autonomous) mode we skip proposing entirely — a background
          // sprint must never put an item in the owner's queue.
          if (
            !input.silent &&
            rank < PROPOSAL_RANK_WINDOW &&
            base.proposed.length < MAX_PROPOSALS_PER_SPRINT &&
            !proposed_domains.has(host) &&
            !denied.has(host.replace(/^www\./, ''))
          ) {
            const proposal_id = deps.proposals.create({
              specialist_id: 'cordelia',
              kind: 'trusted_source_addition',
              rationale:
                `Acquisition sprint for **${target.name}** on "${input.topic}" found a ` +
                `well-ranked candidate on **${host}**, which is not in their trusted ` +
                `roster. Result: "${hit.title}". Snippet: ${hit.snippet || '(none)'}.\n\n` +
                `Proposing Tier 2 (with attribution) as the safer default — approve to ` +
                `let future sprints and subscriptions draw from this domain.`,
              payload: {
                target_specialist_id: target.id,
                domain: host.replace(/^www\./, ''),
                tier: 2,
                candidate_url: hit.url,
                candidate_title: hit.title,
                justification: `Ranked #${rank + 1} for the demand topic "${input.topic}".`,
              },
              execution_kind: 'composite', // decide-time resolver patches the YAML + subscribes
              signature: {
                specialist_id: 'cordelia',
                kind: 'trusted_source_addition',
                category: 'knowledge_curation',
                anchor: `${target.id}:${host.replace(/^www\./, '')}`,
              },
            });
            proposed_domains.add(host);
            base.proposed.push({
              url: hit.url,
              domain: host.replace(/^www\./, ''),
              proposal_id,
            });
          } else {
            base.skipped.push({
              url: hit.url,
              reason: denied.has(host.replace(/^www\./, ''))
                ? `domain previously denied for ${target.id} — not re-proposed`
                : 'out-of-roster (not in the proposal window)',
            });
          }
          continue;
        }

        // In-roster — fetch, gate, shelve.
        const outcome = await fetch_fn(hit.url, ctx, { title_fallback: hit.title });
        if (outcome.kind === 'deferred' || outcome.kind === 'failed') {
          base.skipped.push({ url: hit.url, reason: `${outcome.kind}: ${outcome.reason}` });
          continue;
        }
        const tz = deps.users?.get_timezone(ctx.user?.id ?? null);
        const saved = await save_library_item(
          deps.library_deps,
          { filename: hit.url, mime_type: 'text/markdown', text: outcome.markdown },
          target,
          {
            source: 'url',
            source_url: hit.url,
            tz,
            trust_tier_override: tier,
            quality_gate: 'full',
            // Cordon: demand from one non-owner user shelves at THEIR
            // visibility; otherwise shelf-wide reference material.
            private_to: input.private_to_user_id ?? null,
          },
        );
        if ('rejected' in saved) {
          base.skipped.push({
            url: hit.url,
            reason: `quality gate (${saved.content_type}): ${saved.reason}`,
          });
          continue;
        }
        base.shelved.push({
          url: hit.url,
          trust_tier: tier,
          wrapper_note_path: saved.wrapper_note_path,
          title: saved.title,
        });
      }

      if (base.shelved.length === 0 && base.proposed.length === 0) {
        base.next_action =
          "The roster had no usable coverage for this topic — run scout_sources to find authoritative domains worth adding, or curate_for_specialist if the target's Tier-1 manifest should cover it.";
      }

      memory.log_action({
        intent_id: ctx.intent_id,
        agent,
        tool_name: 'acquire_knowledge',
        tool_input: {
          topic: input.topic,
          specialist_id: input.specialist_id,
          max_candidates: input.max_candidates,
          private_to_user_id: input.private_to_user_id,
        },
        execution_result: {
          shelved: base.shelved.length,
          proposed: base.proposed.length,
          skipped: base.skipped.length,
          paths: base.shelved.map((s) => s.wrapper_note_path),
        },
        user_id: ctx.user?.id,
      });

      return base;
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_acquire_knowledge({
    specialists: deps.specialists,
    proposals: deps.proposals,
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      embedder: deps.embedder,
      events: deps.events,
    },
    users: deps.users,
  }) as Tool;
}
