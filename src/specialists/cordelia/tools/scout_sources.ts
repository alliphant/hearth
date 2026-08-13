/**
 * scout_sources — Cordelia's source-scouting muscle (knowledge
 * metabolism #4, 2026-06-10).
 *
 * Where acquire_knowledge works INSIDE a specialist's trusted roster,
 * scout_sources builds the roster itself: search the open web for a
 * topic, group results into candidate DOMAINS the target doesn't trust
 * yet, score each with a planner-role LLM judge on four axes —
 * authority (who publishes it), independence (vendor-captured?),
 * freshness (maintained?), fit (does it serve THIS specialist's
 * domain?) — and file a `trusted_source_addition` proposal per worthy
 * domain, carrying the judge's evidence, suggested tier, and suggested
 * refresh cadence. The OWNER approves every addition — scouting never
 * edits a roster directly, and a judge outage fails open to "report
 * candidates, propose nothing" (the proposal queue is owner attention;
 * unjudged spam is worse than a skipped pass).
 *
 * Already-rostered domains (manifest + subscriptions) and domains Jasper
 * previously DENIED for the target are excluded before judging.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import type { ProposalsStore } from '@core/proposals';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient } from '@memory/client';
import { web_search } from '@connectors/searxng';
import { denied_domains_for, read_sources, roster_tier } from '../sources_store';

const InputSchema = z.object({
  topic: z
    .string()
    .min(3)
    .max(180)
    .describe(
      'The knowledge domain to find authoritative sources for, phrased ' +
        'plainly ("feline chronic kidney disease nutrition").',
    ),
  specialist_id: z
    .string()
    .min(1)
    .describe("Whose roster you're building. Lowercase id ('anya', 'iris')."),
  max_candidates: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(6)
    .describe('Cap on candidate domains evaluated. Default 6.'),
});

const ScoresSchema = z.object({
  authority: z.number().min(0).max(1),
  independence: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  fit: z.number().min(0).max(1),
});

const CandidateSchema = z.object({
  domain: z.string(),
  example_url: z.string(),
  example_title: z.string(),
  rank: z.number(),
  judged: z.boolean(),
  scores: ScoresSchema.optional(),
  suggested_tier: z.union([z.literal(1), z.literal(2)]).optional(),
  suggested_cadence: z.enum(['daily', 'weekly', 'monthly', 'quarterly']).optional(),
  verdict: z.enum(['propose', 'skip']).optional(),
  reason: z.string().optional(),
});

const ProposedSchema = z.object({
  domain: z.string(),
  proposal_id: z.string(),
  suggested_tier: z.union([z.literal(1), z.literal(2)]),
  suggested_cadence: z.enum(['daily', 'weekly', 'monthly', 'quarterly']),
});

const OutputSchema = z.object({
  topic: z.string(),
  specialist_id: z.string(),
  candidates: z.array(CandidateSchema),
  proposals: z.array(ProposedSchema),
  /** Set when the judge was unavailable/unparseable — candidates are
   *  reported unjudged and NOTHING is proposed (fail-open). */
  judge_error: z.string().optional(),
  error: z.string().optional(),
  known_specialist_ids: z.array(z.string()).optional(),
  next_action: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ScoutSourcesDeps {
  specialists: SpecialistRegistry;
  proposals: ProposalsStore;
  memory: MemoryClient;
  llm: LLMRouter;
  /** Smoke seam — defaults to the real SearXNG connector. */
  search_fn?: typeof web_search.execute;
}

/** Proposals per scout pass — the queue is owner attention. */
const MAX_PROPOSALS_PER_SCOUT = 3;
/** A candidate must clear this average across the four axes to propose. */
const PROPOSE_SCORE_FLOOR = 0.6;

const JUDGE_SYSTEM =
  'You evaluate candidate WEB DOMAINS as durable trusted sources for a ' +
  'household research specialist. For each candidate, score 0..1 on:\n' +
  '  - authority: who publishes it — government / peer-reviewed / ' +
  'professional body / manufacturer-of-record score high; anonymous blogs, ' +
  'content farms, and SEO affiliates score low\n' +
  '  - independence: is it vendor-captured or ad-driven advice dressed as ' +
  'reference? independent/public-interest sources score high\n' +
  '  - freshness: does the site look maintained and current?\n' +
  '  - fit: does the DOMAIN (not just this one page) serve the ' +
  "specialist's described beat?\n" +
  'Then decide: propose=true only when the domain is worth adding to the ' +
  "specialist's standing trusted-source roster (not merely one useful " +
  'page). suggested_tier: 1 = primary/peer-reviewed/gov/professional-body, ' +
  '2 = high-quality secondary (cite with attribution). suggested_cadence: ' +
  'daily for news/wire feeds, weekly for calendar surfaces, monthly for ' +
  'evolving reference, quarterly for stable documentation.\n\n' +
  'Reply with ONLY a JSON array, one object per candidate, nothing else:\n' +
  '[{"domain": "<as given>", "authority": <0..1>, "independence": <0..1>, ' +
  '"freshness": <0..1>, "fit": <0..1>, "propose": <bool>, ' +
  '"suggested_tier": 1|2, "suggested_cadence": "daily"|"weekly"|"monthly"|"quarterly", ' +
  '"reason": "<short>"}]';

const JudgeRowSchema = z.object({
  domain: z.string(),
  authority: z.number().min(0).max(1),
  independence: z.number().min(0).max(1),
  freshness: z.number().min(0).max(1),
  fit: z.number().min(0).max(1),
  propose: z.boolean(),
  suggested_tier: z.union([z.literal(1), z.literal(2)]).default(2),
  suggested_cadence: z.enum(['daily', 'weekly', 'monthly', 'quarterly']).default('monthly'),
  reason: z.string().default(''),
});

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

function host_of(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

interface DomainCandidate {
  domain: string;
  example_url: string;
  example_title: string;
  rank: number;
  evidence: Array<{ title: string; url: string; snippet: string }>;
}

async function judge_candidates(
  llm: LLMRouter,
  topic: string,
  specialist_beat: string,
  candidates: DomainCandidate[],
): Promise<Map<string, z.infer<typeof JudgeRowSchema>> | null> {
  let role;
  try {
    role = llm.for_role('planner');
  } catch {
    return null;
  }
  const listing = candidates
    .map(
      (c, i) =>
        `${i + 1}. domain: ${c.domain}\n` +
        c.evidence
          .map((e) => `   - "${e.title}" (${e.url})${e.snippet ? ` — ${e.snippet.slice(0, 160)}` : ''}`)
          .join('\n'),
    )
    .join('\n');
  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `Specialist beat: ${specialist_beat}\n` +
            `Topic being scouted: ${topic}\n\n` +
            `Candidate domains with the search evidence that surfaced them:\n${listing}\n\n` +
            'Reply with ONLY the JSON array.',
        },
      ],
      temperature: 0.1,
      max_tokens: 1200,
      think: false,
      ...role.defaults,
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = new Map<string, z.infer<typeof JudgeRowSchema>>();
  for (const item of parsed) {
    const r = JudgeRowSchema.safeParse(item);
    if (!r.success) continue;
    out.set(r.data.domain.toLowerCase().replace(/^www\./, ''), r.data);
  }
  return out.size > 0 ? out : null;
}

export function make_scout_sources(deps: ScoutSourcesDeps): Tool<Input, Output> {
  const search_fn = deps.search_fn ?? web_search.execute.bind(web_search);
  return {
    name: 'scout_sources',
    description:
      "Scout authoritative NEW sources for a specialist's trusted roster: search the open web for a topic, group results into candidate domains the target doesn't trust yet (rostered + previously-denied domains excluded), score each with an LLM judge on authority/independence/freshness/fit, and file a trusted_source_addition proposal per worthy domain with suggested tier + refresh cadence. Jasper approves every addition — this never edits a roster directly. Use when acquire_knowledge reports no roster coverage for a demand topic, or when building out a new specialist's rack. If the judge is unavailable the pass reports candidates unjudged and proposes nothing.",
    risk: 'write_internal',
    required_capabilities: ['query_web', 'write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.topic.toLowerCase().trim());
      h.update(`:${input.specialist_id}:${input.max_candidates}`);
      return `scout_sources:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const agent = ctx.specialist_id ?? 'cordelia';
      const base: Output = {
        topic: input.topic,
        specialist_id: input.specialist_id,
        candidates: [],
        proposals: [],
      };

      const target = deps.specialists.get(input.specialist_id);
      if (!target) {
        return {
          ...base,
          error: `unknown specialist_id "${input.specialist_id}"`,
          known_specialist_ids: deps.specialists.list().map((s) => s.id).sort(),
          next_action: 'Retry with one of known_specialist_ids.',
        };
      }

      const search_resp = await search_fn({ query: input.topic, max_results: 20 }, ctx);
      if (search_resp.error) {
        return {
          ...base,
          error: `web_search failed: ${search_resp.error}`,
          next_action: 'Search backend unreachable — retry the scout later.',
        };
      }

      const entries = read_sources(deps.memory);
      const denied = denied_domains_for(deps.memory, target.id);
      const by_domain = new Map<string, DomainCandidate>();
      for (let rank = 0; rank < search_resp.results.length; rank++) {
        const hit = search_resp.results[rank]!;
        const domain = host_of(hit.url);
        if (!domain) continue;
        if (roster_tier(hit.url, target, entries) !== null) continue; // already trusted
        if (denied.has(domain)) continue; // Jasper said no — stays no
        const existing = by_domain.get(domain);
        if (existing) {
          if (existing.evidence.length < 3) {
            existing.evidence.push({ title: hit.title, url: hit.url, snippet: hit.snippet });
          }
          continue;
        }
        if (by_domain.size >= input.max_candidates) continue;
        by_domain.set(domain, {
          domain,
          example_url: hit.url,
          example_title: hit.title,
          rank: rank + 1,
          evidence: [{ title: hit.title, url: hit.url, snippet: hit.snippet }],
        });
      }
      const candidates = Array.from(by_domain.values());
      if (candidates.length === 0) {
        return {
          ...base,
          next_action:
            'Every result was already rostered or denied — the roster may already cover this topic; try acquire_knowledge instead.',
        };
      }

      const beat = `${target.name} — ${target.role}`;
      const verdicts = await judge_candidates(deps.llm, input.topic, beat, candidates);

      if (verdicts === null) {
        // FAIL-OPEN: report what was found, propose nothing. An unjudged
        // proposal queue is worse than a skipped pass.
        base.candidates = candidates.map((c) => ({
          domain: c.domain,
          example_url: c.example_url,
          example_title: c.example_title,
          rank: c.rank,
          judged: false,
        }));
        base.judge_error =
          'source judge unavailable or unparseable — candidates reported unjudged, no proposals filed';
        base.next_action = 'Re-run the scout when the planner model is back.';
      } else {
        for (const c of candidates) {
          const v = verdicts.get(c.domain);
          if (!v) {
            base.candidates.push({
              domain: c.domain,
              example_url: c.example_url,
              example_title: c.example_title,
              rank: c.rank,
              judged: false,
            });
            continue;
          }
          const scores = {
            authority: v.authority,
            independence: v.independence,
            freshness: v.freshness,
            fit: v.fit,
          };
          const avg = (v.authority + v.independence + v.freshness + v.fit) / 4;
          const worthy = v.propose && avg >= PROPOSE_SCORE_FLOOR;
          base.candidates.push({
            domain: c.domain,
            example_url: c.example_url,
            example_title: c.example_title,
            rank: c.rank,
            judged: true,
            scores,
            suggested_tier: v.suggested_tier,
            suggested_cadence: v.suggested_cadence,
            verdict: worthy ? 'propose' : 'skip',
            reason: v.reason,
          });
          if (!worthy || base.proposals.length >= MAX_PROPOSALS_PER_SCOUT) continue;
          const proposal_id = deps.proposals.create({
            specialist_id: 'cordelia',
            kind: 'trusted_source_addition',
            rationale:
              `Source scout for **${target.name}** on "${input.topic}" rates ` +
              `**${c.domain}** worth adding to their trusted roster.\n\n` +
              `Judge scores — authority ${v.authority.toFixed(2)}, independence ` +
              `${v.independence.toFixed(2)}, freshness ${v.freshness.toFixed(2)}, ` +
              `fit ${v.fit.toFixed(2)}. ${v.reason}\n\n` +
              `Evidence: ${c.evidence.map((e) => `"${e.title}" (${e.url})`).join('; ')}.\n\n` +
              `Suggested Tier ${v.suggested_tier}; on approval, a ` +
              `${v.suggested_cadence} subscription is the natural follow-up ` +
              `(add_trusted_source with specialist_id + cadence).`,
            payload: {
              target_specialist_id: target.id,
              domain: c.domain,
              tier: v.suggested_tier,
              candidate_url: c.example_url,
              candidate_title: c.example_title,
              justification: `Scouted for "${input.topic}"; judge avg ${avg.toFixed(2)}.`,
              suggested_cadence: v.suggested_cadence,
              judge_scores: scores,
            },
            execution_kind: 'composite', // decide-time resolver patches the YAML + subscribes
            signature: {
              specialist_id: 'cordelia',
              kind: 'trusted_source_addition',
              category: 'knowledge_curation',
              anchor: `${target.id}:${c.domain}`,
            },
          });
          base.proposals.push({
            domain: c.domain,
            proposal_id,
            suggested_tier: v.suggested_tier,
            suggested_cadence: v.suggested_cadence,
          });
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent,
        tool_name: 'scout_sources',
        tool_input: {
          topic: input.topic,
          specialist_id: input.specialist_id,
          max_candidates: input.max_candidates,
        },
        execution_result: {
          candidates: base.candidates.length,
          proposals: base.proposals.length,
          judge_ok: base.judge_error === undefined,
        },
        user_id: ctx.user?.id,
      });

      return base;
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_scout_sources({
    specialists: deps.specialists,
    proposals: deps.proposals,
    memory: deps.memory,
    llm: deps.llm,
  }) as Tool;
}
