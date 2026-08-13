/**
 * deep_research — Kate's "go find out everything about X" hand-off
 * (2026-06-19).
 *
 * This is the fix for the skim-and-punt failure: a chat turn is hard-capped
 * (8 external fetches, 15 rounds, a 2000-token reply, no async), so when a
 * user asks Kate to "deeply research my massage therapist Dana Marsh" she
 * physically can't go deep in-turn — she skims a couple of searches and
 * suggests asking in person. This tool files a `research_investigations`
 * row and kicks a DETACHED background runner immediately; the runner
 * (research_investigation_runner.ts) decomposes the subject into
 * sub-questions, fans out searches, fetches + reads sources with [S#]
 * citations, adversarially verifies the load-bearing claims, and
 * synthesizes a cited dossier onto Kate's library (searchable) + a
 * person-note summary when the subject is a person. The tool returns
 * immediately so Kate says "On it — I'll have a full report shortly" and
 * moves on; the office tab tracks progress live, and she gets an inbox FYI
 * + a push when it lands.
 *
 * The runner does the browsing with its OWN context (web_search /
 * fetch_document run via *.execute, bypassing capability gating exactly as
 * the commission runner does), so Kate needs no query_web / browse_web —
 * `deep_research` is gated on `deep_research` alone. Friend-tier callers are
 * refused (an investigation spends real fetch budget).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { emit_job_progress, job_from_investigation_row } from '@core/jobs';
import { progress_of } from '@app/routes/research';
import {
  ResearchInvestigationStore,
  PERSON_SUBJECT_KINDS,
  type SubjectKind,
} from '@memory/stores/research_investigations';

/** How far back a "here's what I know about them" refine can re-open a prior
 *  investigation rather than filing a new one. Long enough that the owner can
 *  come back the next day with the missing detail. */
const REFINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
import {
  deep_research_enabled,
  investigation_runner_deps_from,
  kick_investigation_detached,
  prior_dossier_worth_refining,
  type InvestigationRunnerDeps,
} from '../research_investigation_runner';

const InputSchema = z.object({
  subject: z
    .string()
    .min(2)
    .max(200)
    .describe(
      "What to deeply research — a person's name ('Dana Marsh'), a product, " +
        'a place, a decision, or an open topic or question ("whether heat pumps ' +
        'hold up below zero"). Name the thing, not a full paragraph; put the ' +
        'framing in `brief`.',
    ),
  subject_kind: z
    .enum(['person', 'public_figure', 'product', 'place', 'decision', 'general'])
    .default('general')
    .describe(
      'What kind of subject this is — it selects how the researcher carves the ' +
        'work up. "person" for someone in the household\'s LIFE — a friend, a ' +
        'colleague, a doctor, a contractor, anyone they might actually meet or ' +
        'contact (drives a contact-record writeback). "public_figure" for someone ' +
        'in the PUBLIC record they are following rather than relating to — an ' +
        'elected official or candidate, a company executive, an author, a public ' +
        'personality; use this even when the person is local, so the household\'s ' +
        'contacts stay the people they actually know. "product" for a thing you ' +
        'might buy or own; "place" for somewhere; "decision" for a choice between ' +
        'options; "general" for an open topic or question — anything that is not ' +
        'one of the others.',
    ),
  brief: z
    .string()
    .min(3)
    .max(2000)
    .describe(
      'What the user actually wants to know — their framing, the angle, any ' +
        'specifics worth honoring ("background, training, and reviews for my ' +
        'massage therapist before my next appointment").',
    ),
  known_facts: z
    .array(z.string().min(2).max(300))
    .optional()
    .describe(
      'Anything the user already KNOWS that pins down which specific person or ' +
        'thing this is — an employer, a city, a school, a spouse, a business ' +
        'name, a profile URL, the name they publish under. Pass these whenever ' +
        'the user volunteers them, and ALWAYS pass them when a previous ' +
        'investigation came back unable to confirm who the subject was and the ' +
        'user is now telling you more: doing so RE-OPENS that same investigation ' +
        'and digs again with the anchor, instead of repeating the same failed ' +
        'search. A common name with no anchor is not a searchable identity.',
    ),
  depth: z
    .enum(['quick', 'standard', 'exhaustive'])
    // `.optional()` rather than `.default()` deliberately: a `.default()` makes
    // the field REQUIRED in the inferred input type, which breaks every caller
    // that invokes `.execute()` directly (the detached runners and the smokes).
    // Omitted is identical to 'standard' at the create below.
    .optional()
    .describe(
      'How much WORK to authorise, not how long to take. "quick" is a fast read; ' +
        '"standard" is the default workup; "exhaustive" keeps going across hundreds of ' +
        'sources until the questions are answered or the budget is spent. Pass ' +
        '"exhaustive" when the user asks for everything, when the subject matters to ' +
        'their safety, or when a previous run came back thin and they want it pushed ' +
        'harder — re-running the same subject at a deeper setting RESUMES that same ' +
        'investigation with the larger allowance rather than starting over.',
    ),
});

const OutputSchema = z.object({
  investigation_id: z.string().optional(),
  subject: z.string(),
  status: z.string().optional(),
  /** True when an OPEN investigation into the same subject already existed. */
  already_running: z.boolean(),
  /** True when new facts re-opened a finished investigation instead of
   *  filing a fresh one. */
  refined: z.boolean().default(false),
  /** The anchor facts now on the row (merged across refinements). */
  known_facts: z.array(z.string()).optional(),
  enabled: z.boolean(),
  next_action: z.string(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_deep_research(deps: InvestigationRunnerDeps): Tool<Input, Output> {
  return {
    name: 'deep_research',
    description:
      'Hand off a deep-research investigation: a background researcher decomposes the subject into sub-questions, fans out web searches, fetches and reads sources with citations, verifies the load-bearing claims, and writes a cited dossier onto your library + a person-note summary (for a person). Use this whenever the user asks you to "deeply research / dig into / do a full workup on / find out everything about" ANY subject — a person, a product, a place, a decision between options, or an open topic or question — you CANNOT do that justice in one chat turn, so do NOT run web_search yourself for it. Call this with the subject + their framing, then tell them you\'re on it and will have a full report shortly. Runs over minutes in the background; check list_research_investigations / get_research_investigation later — do NOT wait or re-file after success.',
    risk: 'write_internal',
    required_capabilities: ['deep_research'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.subject.trim().toLowerCase());
      h.update(`:${input.subject_kind}:`);
      h.update(input.brief.trim().toLowerCase());
      // Facts are part of the ASK: without them a refine ("she works at
      // BrightCase") would hit the per-turn duplicate-call cache and be served
      // the original, unrefined result.
      h.update(`:${(input.known_facts ?? []).map((f) => f.trim().toLowerCase()).sort().join('|')}`);
      // Depth is part of the ASK for the same reason facts are: "research him
      // again, properly" is a DIFFERENT request from the one already made this
      // turn, and without this it would be served the shallow result from the
      // duplicate-call cache instead of re-opening at the deeper budget.
      h.update(`:${input.depth ?? 'standard'}`);
      return `deep_research:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const memory = deps.library_deps.memory;
      const agent = ctx.specialist_id ?? 'kate';
      const base = {
        subject: input.subject,
        already_running: false,
        refined: false,
        enabled: deep_research_enabled(),
      };
      const facts = (input.known_facts ?? []).map((f) => f.trim()).filter((f) => f.length > 1);

      if (ctx.user?.tier === 'friend') {
        return {
          ...base,
          error: 'deep research is owner/household-only',
          next_action:
            'Tell the user a deep-research job needs a household member to request it — ' +
            'offer a quick web_search-based answer in this turn instead.',
        };
      }

      const store = new ResearchInvestigationStore(deps.library_deps.db);

      // NEW FACTS RE-OPEN THE SAME INVESTIGATION (2026-07-30).
      //
      // The "Josie Kim Reyes" investigation could not find her because a
      // private person's name alone is not a searchable identity — it returned
      // six strangers who shared part of the name. The answer to that is not a
      // better search, it is the owner handing over an anchor: an employer, a
      // city, a profile link. When they do, this is the SAME question with the
      // missing piece, so we re-open the SAME row — keeping its id, cordon,
      // person link and evidence trail — rather than filing a rival
      // investigation into the same human being.
      // A STALLED or INCOMPLETE run is re-opened even with NO new facts
      // (2026-08-01). The stall notice tells the owner "ask me to research them
      // again at exhaustive depth and I'll resume this same investigation" —
      // and until this condition existed that was false: the re-open only
      // triggered on new facts, so taking option 1 filed a RIVAL investigation
      // into the same person and abandoned the row that was actually stalled.
      // Three independent reviewers converged on it. Raising the depth is
      // itself new information about how to proceed, so it re-opens on its own.
      // No new facts, no depth — still re-open, as long as the prior run is
      // genuinely STUCK. Gating this on a depth being supplied meant a plain
      // "any luck on Jonathan?" filed a rival investigation into the same
      // person and abandoned the stalled one. The `stuck` test below is what
      // keeps a FINISHED dossier safe; this gate only decides whether to look.
      {
        const prior = store.find_recent_for_subject(
          input.subject,
          ctx.user?.id ?? null,
          REFINE_WINDOW_MS,
        );
        // With no new facts we only re-open something that is genuinely STUCK.
        // A finished run is left alone: re-running a `done` investigation just
        // because a depth was passed would silently discard a good dossier.
        const stuck = prior !== null && (prior.status === 'stalled' || prior.status === 'incomplete');
        if (prior && (facts.length > 0 || stuck)) {
          // Refine the standing dossier when it was about the right person;
          // start clean when it was not (a stranger's biography must never be
          // "revised" into the next revision).
          const carry = prior_dossier_worth_refining(prior);
          const reopened = store.reopen_with_facts(prior.id, facts, {
          carry_dossier: carry,
          // Honour a depth the caller actually asked for; undefined leaves the
          // prior run's setting alone. This is what makes "re-run it deeper and
          // it resumes with a larger allowance" true rather than just claimed.
          ...(input.depth ? { depth: input.depth } : {}),
        });
          if (reopened) {
            memory.log_action({
              intent_id: ctx.intent_id,
              agent,
              tool_name: 'deep_research_refined',
              tool_input: { investigation_id: reopened.id, subject: input.subject, facts },
              execution_result: {
                investigation_id: reopened.id,
                status: reopened.status,
                anchor_facts: reopened.anchor_facts.length,
              },
              ...(ctx.user?.id ? { user_id: ctx.user.id } : {}),
            });
            if (deep_research_enabled()) kick_investigation_detached(deps, reopened.id, agent);
            return {
              ...base,
              investigation_id: reopened.id,
              status: reopened.status,
              refined: true,
              known_facts: reopened.anchor_facts,
              next_action:
                `Re-opened the existing investigation into "${reopened.subject}" ` +
                `(\`${reopened.id}\`) with what they just told you — now anchored on: ` +
                `${reopened.anchor_facts.join('; ')}. It is ${
                  carry
                    ? `REVISING the existing dossier (revision ${reopened.revision})`
                    : 'starting clean, because the previous attempt could not confirm who they were'
                }. Tell them you're taking another run at it WITH that detail and will report ` +
                `back. Do NOT research it yourself now.`,
            };
          }
        }
      }

      // Re-file collapse: the same open subject is returned, never twinned.
      const existing = store.find_open_for_subject(input.subject, ctx.user?.id ?? null);
      if (existing) {
        return {
          ...base,
          investigation_id: existing.id,
          status: existing.status,
          already_running: true,
          next_action:
            `An investigation into "${existing.subject}" is already ${existing.status} ` +
            `(\`${existing.id}\`) — tell the user it's already underway and you'll report ` +
            'back; check get_research_investigation for progress. Do not re-file.',
        };
      }

      // Resolve (don't create) a person id so the writeback updates the right
      // note; the writeback itself find_or_creates on completion.
      let person_id: string | null = null;
      if (PERSON_SUBJECT_KINDS.includes(input.subject_kind as SubjectKind)) {
        const found = memory.find_person({ name: input.subject });
        if (found) person_id = found.id;
      }

      // Per-user cordon: a non-owner household requester's investigation +
      // its dossier shelve at THEIR visibility; the owner's are owner-private.
      const private_to = ctx.user && ctx.user.tier !== 'owner' ? ctx.user.id : null;

      const row = store.create({
        subject: input.subject,
        subject_kind: input.subject_kind as SubjectKind,
        brief: input.brief,
        person_id,
        requested_by: ctx.user?.id ?? null,
        // Whoever filed it gets the dossier on THEIR shelf — otherwise a
        // research front other than Kate writes into a library outside its
        // own knowledge_scope and can never read its own work back.
        agent_id: agent,
        private_to,
        conversation_id: ctx.conversation_id ?? null,
        depth: input.depth ?? 'standard',
      });
      if (facts.length > 0) store.update(row.id, { anchor_facts: facts });

      memory.log_action({
        intent_id: ctx.intent_id,
        agent,
        tool_name: 'deep_research',
        tool_input: {
          investigation_id: row.id,
          subject: input.subject,
          subject_kind: input.subject_kind,
        },
        execution_result: { investigation_id: row.id, status: row.status },
        ...(ctx.user?.id ? { user_id: ctx.user.id } : {}),
      });

      if (deep_research_enabled()) {
        // Same reason as archive_url: the row goes on the wall the instant the
        // ask is accepted, not after the planner's first slice returns (which is
        // minutes for a dive). Without this the pane is empty during exactly the
        // window the user is wondering whether anything is happening.
        emit_job_progress(deps.library_deps.events, job_from_investigation_row(row, progress_of));
        kick_investigation_detached(deps, row.id, agent);
      }

      return {
        ...base,
        investigation_id: row.id,
        status: row.status,
        next_action: deep_research_enabled()
          ? `Investigation ${row.id} filed and running in the background. Tell the user ` +
            `you're on it and will have a full report on "${input.subject}" shortly — ` +
            'and do NOT research it yourself this turn. They can watch it on your ' +
            'Research tab; you\'ll get the dossier on your shelf to read back.'
          : `Investigation ${row.id} filed, but HEARTH_DEEP_RESEARCH=0 — the runner is ` +
            'disabled; it will execute when the kill switch lifts.',
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_deep_research(investigation_runner_deps_from(deps)) as Tool;
}
