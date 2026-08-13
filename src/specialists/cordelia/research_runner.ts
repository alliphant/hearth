/**
 * research_runner — the engine behind Cordelia's research commissions
 * (2026-06-11).
 *
 * A commission is a durable deep-research job: "build Astrid a
 * bicycle + e-bike repair repository, seeded with this Trek service
 * manual PDF." One tool call can't hold that (tool-round budgets,
 * token ceilings, wall-clock), so the work lives in the
 * `research_commissions` table and THIS module advances it in bounded
 * slices:
 *
 *   pending      → plan: a planner-role LLM decomposes the brief into
 *                  subtopics + queries (fail-open: the brief itself
 *                  becomes the single subtopic).
 *   acquiring    → seeds first (owner-handed documents — fetched
 *                  binary-aware, PDFs/DOCX converted via the inbox
 *                  pipeline, shelved Tier 1 with quality gate
 *                  'minimal'), then per-subtopic search fan-out. An
 *                  in-roster candidate shelves at its manifest /
 *                  subscription tier; an out-of-roster DOMAIN goes
 *                  through the source judge (scout_sources' four axes)
 *                  — a commission is owner-initiated work, so a
 *                  judge-cleared domain may shelve directly, with the
 *                  verdict recorded and a trusted_source_addition
 *                  proposal filed at completion so the roster catches
 *                  up. Judge outage = roster-only for that slice
 *                  (fail-safe to the strict path). Denied domains are
 *                  never used. Progress persists after every document.
 *   synthesizing → compose the repository guide (a map of what
 *                  shelved, per subtopic, with summaries + an LLM
 *                  coverage/gaps overview, fail-open to deterministic-
 *                  only), shelve it, flag the target specialist's
 *                  inbox, file the roster proposals, mark done.
 *
 * Slices are deadline-bounded (HEARTH_RESEARCH_SLICE_MS); the detached
 * kick after commission_research runs slices back-to-back until done,
 * and the nightly advance_research_commissions background job sweeps
 * anything left (crash recovery, browser-deferred fetches, judge
 * outages). A slice that makes NO progress breaks the detached loop —
 * the nightly job is the retry, not a hot loop.
 *
 * Kill switch: HEARTH_RESEARCH_COMMISSIONS=0 (advances no-op; nothing
 * is lost — commissions stay open until re-enabled).
 */
import { ulid } from 'ulid';
import type { ToolContext } from '@core/tool';
import type { SpecialistRegistry, LoadedSpecialist } from '@core/specialist';
import type { ProposalsStore } from '@core/proposals';
import type { UserRegistry } from '@core/users';
import type { LLMRouter } from '@core/llm';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import { web_search } from '@connectors/searxng';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';
import {
  fetch_document as fetch_document_core,
  type DocumentFetch,
  type FetchDocSeams,
} from '@core/research_fetch';
// The binary-aware fetcher moved to @core/research_fetch so Kate's
// deep-research runner shares it. Re-exported here for back-compat —
// scripts/smoke-research.ts imports these names from this module.
export { document_mime_for_url } from '@core/research_fetch';
export type { DocumentFetch };
import {
  ResearchCommissionStore,
  OPEN_STATUSES,
  type CommissionPlan,
  type CommissionRow,
  type CommissionRunState,
  type CommissionStatus,
  type CommissionSubtopic,
  type JudgedDomain,
  type ShelvedDoc,
} from '@memory/stores/research_commissions';
import { denied_domains_for, read_sources, roster_tier } from './sources_store';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

export function research_enabled(): boolean {
  return process.env.HEARTH_RESEARCH_COMMISSIONS !== '0';
}

function slice_ms(): number {
  return parseInt(process.env.HEARTH_RESEARCH_SLICE_MS ?? String(5 * 60_000), 10);
}

/** Detached-kick ceiling — slices run back-to-back after a commission
 *  files; anything left after this is the nightly job's work. */
const MAX_DETACHED_SLICES = 8;

/** Consecutive errored slices before a commission is marked failed. */
const MAX_ERROR_STREAK = 3;

/** trusted_source_addition follow-ups per commission — owner attention. */
const MAX_PROPOSALS_PER_COMMISSION = 3;

/** Out-of-roster shelving floor: judge average across the four axes. */
const JUDGE_SCORE_FLOOR = 0.6;

interface DepthCaps {
  subtopics: number;
  queries_per_subtopic: number;
  docs_per_subtopic: number;
  /** Searched documents, on top of however many seeds were handed in. */
  total_docs: number;
  search_results: number;
}

const DEPTH_CAPS: Record<'standard' | 'deep', DepthCaps> = {
  standard: { subtopics: 5, queries_per_subtopic: 2, docs_per_subtopic: 2, total_docs: 12, search_results: 8 },
  deep: { subtopics: 8, queries_per_subtopic: 2, docs_per_subtopic: 3, total_docs: 24, search_results: 10 },
};

/* ------------------------------------------------------------------ */
/* Deps                                                                */
/* ------------------------------------------------------------------ */

export interface ResearchRunnerDeps {
  specialists: SpecialistRegistry;
  proposals: ProposalsStore;
  library_deps: LibraryRoutesDeps;
  llm: LLMRouter;
  inbox?: SpecialistInbox;
  events?: AppEventBus;
  users?: UserRegistry;
  /** Smoke seams — default to the real connectors. */
  search_fn?: typeof web_search.execute;
  fetch_page_fn?: typeof fetch_with_browser_fallback;
  fetch_doc_fn?: (url: string, mime: string) => Promise<DocumentFetch>;
}

/** Build runner deps from the standard ToolDeps bag — shared by the
 *  three commission tools so the wiring lives in one place. */
export function runner_deps_from(deps: import('@core/tool_deps').ToolDeps): ResearchRunnerDeps {
  return {
    specialists: deps.specialists,
    proposals: deps.proposals,
    llm: deps.llm,
    inbox: deps.inbox,
    events: deps.events,
    users: deps.users,
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
  };
}

/* ------------------------------------------------------------------ */
/* Binary-aware document fetch — lifted to @core/research_fetch        */
/* ------------------------------------------------------------------ */

/** Thin wrapper binding this runner's deps seams to the shared fetcher
 *  so the commission call sites stay unchanged. */
function fetch_document(
  deps: ResearchRunnerDeps,
  ctx: ToolContext,
  url: string,
  title_fallback?: string,
): Promise<DocumentFetch> {
  const seams: FetchDocSeams = {
    ...(deps.fetch_doc_fn !== undefined ? { fetch_doc_fn: deps.fetch_doc_fn } : {}),
    ...(deps.fetch_page_fn !== undefined ? { fetch_page_fn: deps.fetch_page_fn } : {}),
  };
  return fetch_document_core(seams, ctx, url, title_fallback);
}

/* ------------------------------------------------------------------ */
/* Planner — brief → subtopics                                         */
/* ------------------------------------------------------------------ */

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

async function plan_commission(
  deps: ResearchRunnerDeps,
  row: CommissionRow,
  target: LoadedSpecialist,
  caps: DepthCaps,
): Promise<{ plan: CommissionPlan; planner_ok: boolean }> {
  const fallback: CommissionPlan = {
    subtopics: [{ title: row.title, queries: [row.brief.slice(0, 180)] }],
  };
  let role;
  try {
    role = deps.llm.for_role('planner');
  } catch {
    return { plan: fallback, planner_ok: false };
  }
  try {
    const resp = await role.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            'You decompose a research commission into acquisition subtopics for a ' +
            'household librarian who will fetch and shelve real documents.\n\n' +
            `Reply with ONLY JSON, nothing else:\n` +
            `{"subtopics": [{"title": "<short>", "queries": ["<query>", "<query>"], "rationale": "<why>"}]}\n\n` +
            `Rules:\n` +
            `- At most ${caps.subtopics} subtopics, each with 1-${caps.queries_per_subtopic} queries.\n` +
            '- Queries are phrased the way a person would ask, not as keyword soup.\n' +
            '- Cover complementary facets: official/manufacturer documentation first ' +
            '(service manuals, spec sheets), then maintenance/how-to, then ' +
            'troubleshooting and safety. Skip facets the brief rules out.\n' +
            '- Do not duplicate coverage the seed documents already provide; go around them.',
        },
        {
          role: 'user',
          content:
            `Commission brief: ${row.brief}\n` +
            `Target specialist beat: ${target.name} — ${target.role}\n` +
            `Seed documents already in hand: ${row.seed_urls.length > 0 ? row.seed_urls.join(', ') : '(none)'}\n\n` +
            'Reply with ONLY the JSON object.',
        },
      ],
      temperature: 0.2,
      max_tokens: 1400,
      ...role.defaults,
      // AFTER the spread — a role default must never turn thinking back on.
      // The reply is JSON.parse()d and the deep tier returns EMPTY `content`
      // when it reasons (the trace goes to `reasoning_content` and eats
      // max_tokens), so a think-ON default silently degrades this to the
      // fallback plan. See media_category.ts for the canonical ordering.
      think: false,
    });
    const parsed = JSON.parse(strip_fence(resp.content)) as {
      subtopics?: Array<{ title?: unknown; queries?: unknown; rationale?: unknown }>;
    };
    if (!Array.isArray(parsed.subtopics)) return { plan: fallback, planner_ok: false };
    const subtopics: CommissionSubtopic[] = [];
    for (const raw of parsed.subtopics.slice(0, caps.subtopics)) {
      if (typeof raw.title !== 'string' || raw.title.length === 0) continue;
      const queries = Array.isArray(raw.queries)
        ? raw.queries
            .filter((q): q is string => typeof q === 'string' && q.trim().length > 2)
            .slice(0, caps.queries_per_subtopic)
        : [];
      if (queries.length === 0) continue;
      subtopics.push({
        title: raw.title.slice(0, 120),
        queries,
        ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale.slice(0, 300) } : {}),
      });
    }
    return subtopics.length > 0
      ? { plan: { subtopics }, planner_ok: true }
      : { plan: fallback, planner_ok: false };
  } catch {
    return { plan: fallback, planner_ok: false };
  }
}

/* ------------------------------------------------------------------ */
/* Source judge — out-of-roster domains                                */
/* ------------------------------------------------------------------ */

interface DomainEvidence {
  domain: string;
  evidence: Array<{ title: string; url: string; snippet: string }>;
}

interface JudgeVerdict extends JudgedDomain {
  propose: boolean;
}

/**
 * Scout-grade judge over candidate DOMAINS surfaced during a
 * commission. Same four axes as scout_sources; the floor decides
 * whether commissioned work may SHELVE from the domain, the `propose`
 * flag whether it's also worth a standing-roster proposal. null =
 * judge unavailable → the slice runs roster-only (fail-safe).
 */
async function judge_commission_domains(
  deps: ResearchRunnerDeps,
  brief: string,
  beat: string,
  candidates: DomainEvidence[],
): Promise<Map<string, JudgeVerdict> | null> {
  if (candidates.length === 0) return new Map();
  let role;
  try {
    role = deps.llm.for_role('planner');
  } catch {
    return null;
  }
  const listing = candidates
    .map(
      (c, i) =>
        `${i + 1}. domain: ${c.domain}\n` +
        c.evidence
          .map(
            (e) =>
              `   - "${e.title}" (${e.url})${e.snippet ? ` — ${e.snippet.slice(0, 160)}` : ''}`,
          )
          .join('\n'),
    )
    .join('\n');
  try {
    const resp = await role.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            'You evaluate candidate WEB DOMAINS as citable sources for an ' +
            'owner-commissioned research repository. Score each 0..1 on:\n' +
            '  - authority: government / peer-reviewed / professional body / ' +
            'manufacturer-of-record score high; anonymous blogs, content farms, ' +
            'SEO affiliates score low\n' +
            '  - independence: vendor-captured or ad-driven advice dressed as ' +
            'reference scores low\n' +
            '  - freshness: maintained and current?\n' +
            "  - fit: does the DOMAIN serve the specialist's described beat?\n" +
            'Also decide propose: true only when the domain is worth adding to the ' +
            "specialist's STANDING trusted-source roster (not merely citable for " +
            'this one repository). suggested_tier: 1 = primary / manufacturer-of-' +
            'record / professional-body, 2 = high-quality secondary. ' +
            'suggested_cadence: how often the domain meaningfully changes.\n\n' +
            'Reply with ONLY a JSON array, one object per candidate:\n' +
            '[{"domain": "<as given>", "authority": <0..1>, "independence": <0..1>, ' +
            '"freshness": <0..1>, "fit": <0..1>, "propose": <bool>, ' +
            '"suggested_tier": 1|2, "suggested_cadence": "daily"|"weekly"|"monthly"|"quarterly", ' +
            '"reason": "<short>"}]',
        },
        {
          role: 'user',
          content:
            `Specialist beat: ${beat}\n` +
            `Commission brief: ${brief}\n\n` +
            `Candidate domains with the search evidence that surfaced them:\n${listing}\n\n` +
            'Reply with ONLY the JSON array.',
        },
      ],
      temperature: 0.1,
      max_tokens: 1400,
      ...role.defaults,
      // AFTER the spread — see the planner call above. This reply is
      // JSON.parse()d too, so a think-ON role default would empty `content`
      // and drop every source verdict.
      think: false,
    });
    const parsed = JSON.parse(strip_fence(resp.content));
    if (!Array.isArray(parsed)) return null;
    const out = new Map<string, JudgeVerdict>();
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      if (typeof r.domain !== 'string') continue;
      const nums = [r.authority, r.independence, r.freshness, r.fit];
      if (!nums.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) continue;
      const avg =
        ((r.authority as number) +
          (r.independence as number) +
          (r.freshness as number) +
          (r.fit as number)) /
        4;
      out.set(r.domain.toLowerCase().replace(/^www\./, ''), {
        tier: r.suggested_tier === 1 ? 1 : 2,
        avg,
        reason: typeof r.reason === 'string' ? r.reason.slice(0, 300) : '',
        suggested_cadence:
          r.suggested_cadence === 'daily' ||
          r.suggested_cadence === 'weekly' ||
          r.suggested_cadence === 'monthly' ||
          r.suggested_cadence === 'quarterly'
            ? r.suggested_cadence
            : 'quarterly',
        propose: r.propose === true,
      });
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Advance — one bounded slice                                         */
/* ------------------------------------------------------------------ */

export interface AdvanceResult {
  commission_id: string;
  status: CommissionStatus | 'missing';
  /** Did this slice move the commission forward at all? The detached
   *  loop stops on false to avoid hot-looping a broken backend. */
  progressed: boolean;
  shelved_total: number;
  proposed_total: number;
  error?: string;
}

function host_of(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function push_log(state: CommissionRunState, line: string): void {
  state.log = [...(state.log ?? []), line].slice(-40);
}

export async function advance_commission(
  deps: ResearchRunnerDeps,
  ctx: ToolContext,
  commission_id: string,
  opts: { deadline_ms?: number } = {},
): Promise<AdvanceResult> {
  const store = new ResearchCommissionStore(deps.library_deps.db);
  const memory = deps.library_deps.memory;
  const agent = ctx.specialist_id ?? 'cordelia';
  let row = store.get(commission_id);
  if (!row) {
    return {
      commission_id,
      status: 'missing',
      progressed: false,
      shelved_total: 0,
      proposed_total: 0,
      error: 'commission not found',
    };
  }
  if (!research_enabled() || !OPEN_STATUSES.includes(row.status)) {
    return {
      commission_id,
      status: row.status,
      progressed: false,
      shelved_total: row.shelved.length,
      proposed_total: row.proposed.length,
      ...(research_enabled()
        ? {}
        : { error: 'HEARTH_RESEARCH_COMMISSIONS=0 — runner disabled by kill switch' }),
    };
  }
  const target = deps.specialists.get(row.target_specialist_id);
  if (!target) {
    store.update(row.id, {
      status: 'failed',
      error: `unknown target specialist "${row.target_specialist_id}"`,
    });
    return {
      commission_id,
      status: 'failed',
      progressed: false,
      shelved_total: row.shelved.length,
      proposed_total: row.proposed.length,
      error: `unknown target specialist "${row.target_specialist_id}"`,
    };
  }

  const caps = DEPTH_CAPS[row.depth];
  const deadline = Date.now() + (opts.deadline_ms ?? slice_ms());
  const search_fn = deps.search_fn ?? web_search.execute.bind(web_search);
  const tz = deps.users?.get_timezone(row.requested_by ?? ctx.user?.id ?? null);
  const state: CommissionRunState & { error_streak?: number } = { ...row.state };
  let progressed = false;
  let slice_error: string | undefined;

  const persist = (patch: Parameters<ResearchCommissionStore['update']>[1] = {}): void => {
    store.update(row!.id, { state, ...patch });
  };

  /** Shelve one fetched document; returns true when it landed. */
  const shelve = async (
    url: string,
    subtopic: string,
    tier: 1 | 2 | null,
    fetched: DocumentFetch,
    quality: 'full' | 'minimal',
  ): Promise<boolean> => {
    if (fetched.kind === 'deferred' || fetched.kind === 'failed') {
      row!.skipped.push({ url, reason: `${fetched.kind}: ${fetched.reason}`, subtopic });
      persist({ skipped: row!.skipped });
      return false;
    }
    const input =
      fetched.kind === 'document'
        ? { filename: fetched.filename, mime_type: fetched.mime, bytes: fetched.bytes }
        : { filename: url, mime_type: 'text/markdown', text: fetched.markdown };
    const saved = await save_library_item(deps.library_deps, input, target, {
      source: 'url',
      source_url: url,
      ...(tz !== undefined ? { tz } : {}),
      trust_tier_override: tier,
      quality_gate: quality,
      private_to: row!.private_to,
    });
    if ('rejected' in saved) {
      row!.skipped.push({
        url,
        reason: `quality gate (${saved.content_type}): ${saved.reason}`,
        subtopic,
      });
      persist({ skipped: row!.skipped });
      return false;
    }
    row!.shelved.push({
      url,
      title: saved.title,
      wrapper_note_path: saved.wrapper_note_path,
      trust_tier: tier,
      subtopic,
    });
    persist({ shelved: row!.shelved, skipped: row!.skipped });
    return true;
  };

  try {
    /* ---- plan ---------------------------------------------------- */
    if (row.status === 'pending') {
      const { plan, planner_ok } = await plan_commission(deps, row, target, caps);
      push_log(
        state,
        planner_ok
          ? `planned ${plan.subtopics.length} subtopic(s)`
          : 'planner unavailable — running the brief as a single subtopic',
      );
      row = { ...row, plan, status: 'acquiring' };
      persist({ plan, status: 'acquiring' });
      progressed = true;
    }

    /* ---- acquire -------------------------------------------------- */
    if (row.status === 'acquiring') {
      const plan = row.plan ?? { subtopics: [] };
      const entries = read_sources(memory);
      const denied = denied_domains_for(memory, target.id);
      const seen = new Set(state.seen_urls ?? []);
      const judged: Record<string, JudgedDomain & { propose?: boolean }> = {
        ...(state.judged_domains ?? {}),
      };
      const rejected = new Set(state.rejected_domains ?? []);
      state.judge_down = false;
      const mark_seen = (url: string): void => {
        seen.add(url);
        state.seen_urls = [...seen];
      };

      // Seeds: owner-handed documents — Tier 1, minimal gate.
      if (!state.seeds_done) {
        for (const url of row.seed_urls) {
          if (seen.has(url)) continue;
          if (Date.now() > deadline) break;
          const fetched = await fetch_document(deps, ctx, url);
          mark_seen(url);
          const ok = await shelve(url, 'Seed documents', 1, fetched, 'minimal');
          push_log(state, ok ? `seed shelved: ${url}` : `seed skipped: ${url}`);
          progressed = true;
          persist();
        }
        if (row.seed_urls.every((u) => seen.has(u))) {
          state.seeds_done = true;
          persist();
        }
      }

      // Subtopics — resume at the cursor; persist after every document.
      let cursor = state.subtopic_cursor ?? 0;
      const searched_total = (): number =>
        row!.shelved.filter((s) => s.subtopic !== 'Seed documents').length;

      while (
        cursor < plan.subtopics.length &&
        Date.now() <= deadline &&
        searched_total() < caps.total_docs &&
        state.seeds_done
      ) {
        const subtopic = plan.subtopics[cursor]!;
        const already =
          row.shelved.filter((s) => s.subtopic === subtopic.title).length;
        let shelved_here = already;

        // Gather candidates across this subtopic's queries.
        const hits: Array<{ title: string; url: string; snippet: string }> = [];
        let search_ok = false;
        for (const query of subtopic.queries) {
          const resp = await search_fn({ query, max_results: caps.search_results }, ctx);
          if (resp.error) {
            push_log(state, `search failed for "${query}": ${resp.error}`);
            slice_error = `web_search failed: ${resp.error}`;
            continue;
          }
          search_ok = true;
          for (const hit of resp.results) {
            if (!hits.some((h) => h.url === hit.url)) hits.push(hit);
          }
        }
        if (!search_ok) {
          // Search backend down — do NOT advance the cursor (that would
          // silently "complete" subtopics with nothing shelved). The
          // commission stays at this subtopic; the nightly job retries.
          persist();
          break;
        }

        // Judge the unjudged out-of-roster domains in one batch.
        const unjudged = new Map<string, DomainEvidence>();
        for (const hit of hits) {
          const domain = host_of(hit.url);
          if (!domain || denied.has(domain) || rejected.has(domain)) continue;
          if (judged[domain]) continue;
          if (roster_tier(hit.url, target, entries) !== null) continue;
          const existing = unjudged.get(domain);
          if (existing) {
            if (existing.evidence.length < 3) {
              existing.evidence.push({ title: hit.title, url: hit.url, snippet: hit.snippet });
            }
          } else if (unjudged.size < 8) {
            unjudged.set(domain, {
              domain,
              evidence: [{ title: hit.title, url: hit.url, snippet: hit.snippet }],
            });
          }
        }
        if (unjudged.size > 0) {
          const verdicts = await judge_commission_domains(
            deps,
            row.brief,
            `${target.name} — ${target.role}`,
            [...unjudged.values()],
          );
          if (verdicts === null) {
            state.judge_down = true;
            push_log(state, 'source judge unavailable — roster-only for this slice');
          } else {
            for (const [domain, v] of verdicts) {
              if (v.avg >= JUDGE_SCORE_FLOOR) {
                judged[domain] = v;
              } else {
                rejected.add(domain);
              }
            }
            state.judged_domains = judged;
            state.rejected_domains = [...rejected];
            persist();
          }
        }

        // Fetch + shelve in rank order until the per-subtopic cap.
        for (const hit of hits) {
          if (shelved_here >= caps.docs_per_subtopic) break;
          if (searched_total() >= caps.total_docs) break;
          if (Date.now() > deadline) break;
          if (seen.has(hit.url)) continue;
          const domain = host_of(hit.url);
          if (!domain) continue;
          if (denied.has(domain)) {
            mark_seen(hit.url);
            row.skipped.push({
              url: hit.url,
              reason: `domain previously denied for ${target.id}`,
              subtopic: subtopic.title,
            });
            persist({ skipped: row.skipped });
            continue;
          }
          let tier: 1 | 2 | null = roster_tier(hit.url, target, entries);
          if (tier === null) {
            const verdict = judged[domain];
            if (!verdict) continue; // rejected, unjudged (judge down), or junk
            tier = verdict.tier;
          }
          mark_seen(hit.url);
          const fetched = await fetch_document(deps, ctx, hit.url, hit.title);
          const ok = await shelve(hit.url, subtopic.title, tier, fetched, 'full');
          if (ok) {
            shelved_here++;
            progressed = true;
            push_log(state, `shelved (T${tier}) ${hit.url}`);
          }
          persist();
        }

        // Move on only when the subtopic is genuinely finished — cap
        // reached, or every candidate was consumed/skipped.
        const exhausted = hits.every((h) => {
          if (seen.has(h.url)) return true;
          const d = host_of(h.url);
          if (!d) return true;
          if (denied.has(d) || rejected.has(d)) return true;
          // Unjudged out-of-roster while the judge is down stays pending
          // for a future slice; everything else was reachable this slice.
          if (
            state.judge_down &&
            !judged[d] &&
            roster_tier(h.url, target, entries) === null
          ) {
            return false;
          }
          return true;
        });
        if (
          shelved_here >= caps.docs_per_subtopic ||
          (exhausted && Date.now() <= deadline) ||
          hits.length === 0
        ) {
          cursor++;
          state.subtopic_cursor = cursor;
          progressed = true;
          persist();
        } else if (Date.now() > deadline) {
          break;
        } else if (!exhausted) {
          // Judge down with pending candidates — stop here; the next
          // slice (judge back) resumes this subtopic.
          break;
        }
      }

      const finished =
        state.seeds_done === true &&
        ((state.subtopic_cursor ?? 0) >= plan.subtopics.length ||
          searched_total() >= caps.total_docs);
      if (finished) {
        row = { ...row, status: 'synthesizing' };
        push_log(state, 'acquisition complete — synthesizing the repository guide');
        persist({ status: 'synthesizing' });
        progressed = true;
      }
    }

    /* ---- synthesize ----------------------------------------------- */
    if (row.status === 'synthesizing') {
      const done = await synthesize_commission(deps, ctx, store, row, state, tz);
      row = done.row;
      progressed = true;
      if (done.flagged) push_log(state, `flagged ${target.id} — repository ready`);
      persist();
    }

    state.error_streak = 0;
    persist({ error: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    slice_error = msg;
    state.error_streak = (state.error_streak ?? 0) + 1;
    push_log(state, `slice error (${state.error_streak}/${MAX_ERROR_STREAK}): ${msg}`);
    if (state.error_streak >= MAX_ERROR_STREAK) {
      persist({ status: 'failed', error: msg });
      row = { ...row, status: 'failed' };
    } else {
      persist({ error: msg });
    }
  }

  const fresh = store.get(commission_id) ?? row;
  memory.log_action({
    intent_id: ctx.intent_id,
    agent,
    tool_name: 'research_commission',
    tool_input: { commission_id, target_specialist_id: fresh.target_specialist_id },
    execution_result: {
      status: fresh.status,
      progressed,
      shelved: fresh.shelved.length,
      proposed: fresh.proposed.length,
      skipped: fresh.skipped.length,
    },
    ...(slice_error ? { error: slice_error } : {}),
    ...(ctx.user?.id ? { user_id: ctx.user.id } : {}),
  });

  return {
    commission_id,
    status: fresh.status,
    progressed,
    shelved_total: fresh.shelved.length,
    proposed_total: fresh.proposed.length,
    ...(slice_error ? { error: slice_error } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Synthesis                                                           */
/* ------------------------------------------------------------------ */

async function synthesize_commission(
  deps: ResearchRunnerDeps,
  ctx: ToolContext,
  store: ResearchCommissionStore,
  row: CommissionRow,
  state: CommissionRunState,
  tz: string | undefined,
): Promise<{ row: CommissionRow; flagged: boolean }> {
  const memory = deps.library_deps.memory;
  const target = deps.specialists.get(row.target_specialist_id)!;

  // Roster follow-ups: judged domains that actually contributed a
  // shelved doc AND the judge said are roster-worthy. Capped; the
  // signature anchor dedups against scout/acquire proposals for the
  // same (target, domain).
  const judged = state.judged_domains ?? {};
  const used_domains = new Set(
    row.shelved.map((s) => host_of(s.url)).filter((d): d is string => d !== null),
  );
  for (const [domain, v] of Object.entries(judged)) {
    if (row.proposed.length >= MAX_PROPOSALS_PER_COMMISSION) break;
    if (!used_domains.has(domain)) continue;
    if (!(v as JudgedDomain & { propose?: boolean }).propose) continue;
    if (row.proposed.some((p) => p.domain === domain)) continue;
    const proposal_id = deps.proposals.create({
      specialist_id: 'cordelia',
      kind: 'trusted_source_addition',
      rationale:
        `Research commission **${row.id}** ("${row.title}") for **${target.name}** ` +
        `shelved material from **${domain}**, which the source judge rates ` +
        `roster-worthy (avg ${v.avg.toFixed(2)}). ${v.reason}\n\n` +
        `Approving adds the domain to ${target.name}'s standing trusted roster so ` +
        `future sprints and subscriptions can draw from it without a judge pass.`,
      payload: {
        target_specialist_id: target.id,
        domain,
        tier: v.tier,
        candidate_url: row.shelved.find((s) => host_of(s.url) === domain)?.url ?? '',
        candidate_title:
          row.shelved.find((s) => host_of(s.url) === domain)?.title ?? domain,
        justification: `Used by commission ${row.id}; judge avg ${v.avg.toFixed(2)}.`,
        suggested_cadence: v.suggested_cadence,
      },
      execution_kind: 'composite', // decide-time resolver patches the YAML + subscribes
      signature: {
        specialist_id: 'cordelia',
        kind: 'trusted_source_addition',
        category: 'knowledge_curation',
        anchor: `${target.id}:${domain}`,
      },
    });
    row.proposed.push({ domain, proposal_id, suggested_tier: v.tier });
  }
  store.update(row.id, { proposed: row.proposed });

  // Repository guide — deterministic skeleton, grouped by subtopic,
  // each doc with its wrapper summary when one was generated.
  const by_subtopic = new Map<string, ShelvedDoc[]>();
  for (const doc of row.shelved) {
    const list = by_subtopic.get(doc.subtopic) ?? [];
    list.push(doc);
    by_subtopic.set(doc.subtopic, list);
  }
  const lines: string[] = [];
  lines.push(`# ${row.title} — repository guide`);
  lines.push('');
  lines.push(
    `Commissioned ${row.created_at} · built by Cordelia for ${target.name} · ` +
      `commission \`${row.id}\` (${row.depth}).`,
  );
  lines.push('');
  lines.push(`**Brief:** ${row.brief}`);
  lines.push('');
  lines.push(`## What's on this shelf (${row.shelved.length} documents)`);
  for (const [subtopic, docs] of by_subtopic) {
    lines.push('');
    lines.push(`### ${subtopic}`);
    for (const doc of docs) {
      const note = memory.read_note(doc.wrapper_note_path);
      const summary =
        note && typeof (note.frontmatter as Record<string, unknown>).summary === 'string'
          ? ((note.frontmatter as Record<string, unknown>).summary as string)
          : null;
      const tier_label = doc.trust_tier !== null ? ` (Tier ${doc.trust_tier})` : '';
      lines.push(`- **${doc.title}**${tier_label} — \`${doc.wrapper_note_path}\``);
      lines.push(`  - Source: ${doc.url}`);
      if (summary) lines.push(`  - ${summary}`);
    }
  }
  if (row.proposed.length > 0) {
    lines.push('');
    lines.push('## Proposed roster additions (awaiting approval)');
    for (const p of row.proposed) {
      lines.push(`- \`${p.domain}\` — suggested Tier ${p.suggested_tier} (proposal \`${p.proposal_id}\`)`);
    }
  }
  if (row.skipped.length > 0) {
    lines.push('');
    lines.push(`## Skipped (${row.skipped.length})`);
    for (const s of row.skipped.slice(0, 8)) {
      lines.push(`- ${s.url} — ${s.reason}`);
    }
    if (row.skipped.length > 8) lines.push(`- …${row.skipped.length - 8} more`);
  }

  // LLM coverage overview — fail-open to the deterministic guide.
  const overview = await compose_overview(deps, row);
  if (overview) {
    lines.push('');
    lines.push('## Coverage notes');
    lines.push(overview);
  }

  const saved = await save_library_item(
    deps.library_deps,
    {
      filename: `${row.id}-repository-guide.md`,
      mime_type: 'text/markdown',
      text: lines.join('\n') + '\n',
    },
    target,
    {
      source: 'file',
      ...(tz !== undefined ? { tz } : {}),
      trust_tier_override: null,
      quality_gate: 'off', // composed from records already gated individually
      private_to: row.private_to,
    },
  );
  let index_note_path: string | null = null;
  if (!('rejected' in saved)) index_note_path = saved.wrapper_note_path;

  // Tell the target specialist their shelf grew — the knowledge-floor
  // inbox section surfaces this on their next chat turn.
  let flagged = false;
  if (deps.inbox) {
    const inbox_id = deps.inbox.push({
      from_specialist_id: 'cordelia',
      to_specialist_id: target.id,
      kind: 'flag',
      // Per-user cordon: a household member's commissioned repository
      // must not surface in another user's brief.
      originating_user_id: row.private_to,
      body_md:
        `**Research repository ready** — commission \`${row.id}\` ("${row.title}").\n\n` +
        `${row.shelved.length} document(s) are now on your shelf; the guide is at ` +
        `\`${index_note_path ?? '(guide rejected — see commission record)'}\`. ` +
        `Use \`search_library\` to draw on it; cite trust_tier provenance as usual.`,
    });
    deps.events?.emit({
      type: 'inbox_message_added',
      message_id: inbox_id,
      from_specialist_id: 'cordelia',
      to_specialist_id: target.id,
      kind: 'flag',
      severity: 'medium',
    });
    flagged = true;
  }

  store.update(row.id, {
    status: 'done',
    ...(index_note_path ? { index_note_path } : {}),
    proposed: row.proposed,
  });
  return { row: { ...row, status: 'done', index_note_path }, flagged };
}

async function compose_overview(
  deps: ResearchRunnerDeps,
  row: CommissionRow,
): Promise<string | null> {
  let role;
  try {
    role = deps.llm.for_role('planner');
  } catch {
    return null;
  }
  try {
    const listing = row.shelved
      .map((s) => `- [${s.subtopic}] ${s.title}`)
      .join('\n');
    const resp = await role.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            'You write the closing coverage notes for a research repository a ' +
            'librarian just assembled. Two short paragraphs, plain prose, no ' +
            'headings: (1) what the shelf now covers, grounded ONLY in the ' +
            'document titles provided; (2) the most important gaps worth a ' +
            'follow-up commission. Under 200 words total. Never invent documents.',
        },
        {
          role: 'user',
          content: `Brief: ${row.brief}\n\nShelved documents:\n${listing}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 600,
      ...role.defaults,
      // AFTER the spread — prose, not JSON, but the same failure: a think-ON
      // default spends max_tokens on `reasoning_content` and returns empty
      // `content`, so the coverage notes silently vanish.
      think: false,
    });
    const text = resp.content.trim();
    return text.length > 40 ? text : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Serialization + the detached kick                                   */
/* ------------------------------------------------------------------ */

/** Per-commission promise chains — two advances for the same commission
 *  must never interleave (both would mutate the same cursor state). */
const _chains = new Map<string, Promise<unknown>>();

export function advance_commission_chained(
  deps: ResearchRunnerDeps,
  ctx: ToolContext,
  commission_id: string,
  opts: { deadline_ms?: number } = {},
): Promise<AdvanceResult> {
  const prior = _chains.get(commission_id) ?? Promise.resolve();
  const run = prior.then(() => advance_commission(deps, ctx, commission_id, opts));
  _chains.set(
    commission_id,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/**
 * Fire-and-forget run after commission_research files — slices
 * back-to-back so an owner ask completes within minutes, not at the
 * 03:20 sweep. A no-progress slice breaks the loop (broken search
 * backend, judge down with nothing rosterable, browser deferred);
 * the nightly background job is the retry path.
 */
export function kick_commission_detached(
  deps: ResearchRunnerDeps,
  commission_id: string,
  agent: string,
): void {
  void (async () => {
    try {
      for (let i = 0; i < MAX_DETACHED_SLICES; i++) {
        const ctx: ToolContext = {
          memory: deps.library_deps.memory,
          llm: deps.llm,
          now: new Date(),
          intent_id: ulid(),
          specialist_id: agent,
        };
        const res = await advance_commission_chained(deps, ctx, commission_id);
        if (!OPEN_STATUSES.includes(res.status as CommissionStatus)) break;
        if (!res.progressed) break;
      }
    } catch (err) {
      console.error(`[research] detached run failed for ${commission_id}:`, err);
    }
  })();
}
