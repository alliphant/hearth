/**
 * audit_specialist_expertise — Beatrice's expertise-coverage lens (NEXT.md 15c
 * part C; design at docs/design-cordelia-specialist-excellence.md §4C).
 *
 * The knowledge-curation complement to Mariah's behavior/config scans. Where
 * `audit_connector_affordances` walks the TOOL registry for missing recovery
 * hints, this walks the SPECIALIST registry for missing EXPERTISE — scoring each
 * opted-in specialist against the 9-axis craft rubric Cordelia owns
 * (Knowledge/Cordelia/craft/), and emitting an `expertise_gap` finding per axis
 * that's below bar.
 *
 * The seam (decided 2026-06-03): **Beatrice judges, Cordelia curates.** This tool
 * IS the judgment — it does not fill the gap. Each gap:
 *   1. opens a `process_miss` (the ledger row — idempotent on a stable
 *      evidence_ref, drives Mariah's dashboard + `verify_fix_landed` auto-close),
 *   2. flags Cordelia over the EXISTING flag_cordelia / wake_on_flag rails (one
 *      consolidated inbox flag per specialist, listing its gap axes + merged
 *      focus_areas), so she wakes off-schedule and runs `curate_for_specialist`
 *      (shelf gaps) or files a `propose_action` for spec-level deltas.
 *
 * Scope is OPT-IN: only specialists with `deepen: true` on their YAML are
 * audited — keeps Cordelia's ≤3-shelves/pass curate budget safe and lets Jasper
 * choose who's in scope. A per-run cap on specialists flagged (FLAG_CAP) is the
 * second budget guard.
 *
 * FAIL-OPEN: a judge error / unparseable response yields no findings for that
 * specialist — an audit outage must never manufacture a gap. Mirrors
 * src/core/fact_critic.ts.
 *
 * Modeled on src/specialists/mariah/tools/audit_connector_affordances.ts
 * (idempotent evidence_ref + current_findings_refs for verify) and
 * src/core/fact_critic.ts (the planner-role JSON judge call).
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type {
  ProcessMissSeverity,
  ProcessMissStore,
} from '@core/process_misses';
import type { LoadedSpecialist, SpecialistRegistry } from '@core/specialist';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { LLMRouter } from '@core/llm';

/**
 * The nine axes of specialist excellence — the craft rubric distilled in
 * Knowledge/Cordelia/craft/. Kept in sync with the seed
 * (scripts/seed-cordelia-craft.ts). The judge scores against these and returns
 * only the axes that are a GAP.
 */
const AXES = [
  'domain_coverage',
  'source_tiers',
  'grounded_falsifier',
  'epistemic_labeling',
  'two_layer_architecture',
  'capability_swimlanes',
  'leak_signal',
  'recurring_questions',
  'demand_side',
] as const;
type Axis = (typeof AXES)[number];
const AXIS_SET: ReadonlySet<string> = new Set(AXES);

/** At most this many specialists get a wake-flag to Cordelia per run — the
 *  second budget guard (after opt-in scope) on her ≤3-shelves/pass curation.
 *  Gaps beyond the cap still land as ledger misses; they're addressed via the
 *  dashboard/ledger rather than an individual wake. */
const FLAG_CAP = 3;

/** Cap persona/evidence fed to the judge so a long persona can't blow context. */
const PERSONA_CHARS = 6_000;

const InputSchema = z.object({
  // Optional override — audit a single specialist by id (ignores deepen gate),
  // for ad-hoc runs / smokes. Omitted = the scheduled behavior (all deepen:true).
  specialist_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Audit ONE specialist by id, bypassing the deepen gate (ad-hoc/diagnostic). ' +
        'Omit for the scheduled sweep of every deepen:true specialist.',
    ),
});

const OpenedSchema = z.object({
  miss_id: z.string(),
  specialist_id: z.string(),
  axis: z.string(),
  gap_kind: z.string(),
  severity: z.string(),
  evidence_ref: z.string(),
});

const FlaggedSchema = z.object({
  specialist_id: z.string(),
  inbox_message_id: z.string(),
  axes: z.array(z.string()),
});

const OutputSchema = z.object({
  specialists_audited: z.number(),
  gaps_found: z.number(),
  misses_opened: z.array(OpenedSchema),
  cordelia_flags: z.array(FlaggedSchema),
  already_tracked: z.number(),
  /**
   * Every evidence_ref this scan considers active right now, BEFORE the
   * idempotency dedup. `verify_fix_landed` reads this to auto-close a miss
   * whose ref no longer appears (the audit_connector_affordances contract).
   */
  current_findings_refs: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** One gap the judge found, post-validation. */
interface Gap {
  axis: Axis;
  gap_kind: 'shelf' | 'spec';
  severity: ProcessMissSeverity;
  focus_areas: string[];
  rationale: string;
}

const JUDGE_SYSTEM = `You audit a household specialist's EXPERTISE against a fixed 9-axis craft rubric — the reusable model of what separates an expert specialist from a brochure-reader. You are the JUDGE; you do not fix anything. Return ONLY the axes that are genuinely BELOW BAR for this specialist, as JSON.

The nine axes:
1. domain_coverage — does the persona+shelf cover the WHOLE territory, including the counter-positioning lanes the obvious vendor/source wants ignored (an analyst who only talks the incumbent is brochure-level), and are distinct sub-buyers/profiles kept separate, named players named?
2. source_tiers — an explicit tiered trusted_sources manifest (tier_1 primary/peer-reviewed/registry vs tier_2 directional), not empty, not all one vendor, recommendation-surfaces not mislabeled tier_1.
3. grounded_falsifier — does the persona require every load-bearing claim to trace to a source AND carry a falsifier (the observation that would prove it wrong)?
4. epistemic_labeling — confirmed vs announced vs leaked kept distinct; forward dates tagged as projections; vendor peak/marketing figures de-rated; volatile quantities treated as time-series not constants.
5. two_layer_architecture — for comparative/quantitative domains, a scan→extract→synthesize pipeline into an OWN structured store with a validated write chokepoint, then grounded read projections — not "search the web each turn." (N/A for purely read/advisory domains — only a gap if the domain is comparative/quantitative.)
6. capability_swimlanes — compares like-for-like by capability envelope, NOT by vendor name or marketing tier.
7. leak_signal — a standing scan of the domain's leading indicator (registries, cert matrices, filings, release notes, preprints) so launches don't surprise it. (Only a gap if the domain HAS a leading indicator.)
8. recurring_questions — the small set of questions that decide every answer in the domain, surfaced as standing flags the specialist asks FIRST.
9. demand_side — who the thing is FOR, derived backwards from a real workflow's demand to the capability driver to the buyer; persona/ICP/UCP, including who looks like a fit but should buy elsewhere.

For each GAP, classify gap_kind:
- "shelf" — closeable by curating more/better SOURCES onto the specialist's library (thin coverage, empty/weak sources, missing leading-indicator content). Cordelia fixes via curate_for_specialist.
- "spec" — needs a DEFINITION change (a persona discipline like falsifier/recurring-question/demand-side method, a trusted_sources tier, a structured-store layer). Cordelia files a propose_action for Jasper.

Be conservative: only flag a real, actionable gap, and only axes that genuinely apply to THIS specialist's domain (don't flag two_layer_architecture or leak_signal for a domain that doesn't need them). Severity: high = the gap causes wrong/fabricated answers; medium = noticeably below expert; low = a refinement.

Reply with ONLY this JSON, no prose:
{"gaps":[{"axis":"<one of the nine keys>","gap_kind":"shelf"|"spec","severity":"low"|"medium"|"high","focus_areas":["topic prompt phrased as a user would, for the curate pass"],"rationale":"one sentence citing the specific shortfall"}]}
If the specialist is at bar on every axis, reply {"gaps":[]}.`;

/** Strip a ```json … ``` fence if the model wrapped its JSON. */
function strip_fence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? (m[1] ?? t) : t;
}

function cap_id(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Count library notes on a specialist's shelf (the machine signal for "thin
 *  shelf"). Reads the clippings projection by note_path prefix. */
function shelf_size(db: Database, specialist_id: string): number {
  try {
    const row = db
      .query('SELECT COUNT(*) AS n FROM clippings WHERE note_path LIKE ?')
      .get(`Knowledge/${cap_id(specialist_id)}/%`) as { n?: number } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Build the deterministic signal block handed to the judge alongside the
 *  persona — so the judge reasons from real numbers, not just prose. */
function machine_signals(s: LoadedSpecialist, db: Database): string {
  const t1 = s.trusted_sources.tier_1?.length ?? 0;
  const t2 = s.trusted_sources.tier_2?.length ?? 0;
  const shelf = shelf_size(db, s.id);
  const tools = [
    ...s.proactive.tools_for_chat,
    ...s.proactive.tools_for_deliberation,
  ];
  const unique_tools = new Set(tools).size;
  return [
    `trusted_sources: tier_1=${t1}, tier_2=${t2}`,
    `library_shelf_notes: ${shelf}`,
    `knowledge_scope_globs: ${s.knowledge_scope.length}`,
    `curated_tool_count: ${unique_tools}`,
    `capabilities: ${Array.from(s.granted).sort().join(', ') || '(none)'}`,
  ].join('\n');
}

/** Parse + validate the judge's gaps, dropping malformed items (robust to a
 *  judge that emits one bad row among good ones). Returns [] on total failure
 *  (fail-open). */
function parse_gaps(content: string): Gap[] {
  let raw: unknown;
  try {
    raw = JSON.parse(strip_fence(content));
  } catch {
    return [];
  }
  const obj = raw as { gaps?: unknown };
  if (!obj || !Array.isArray(obj.gaps)) return [];
  const out: Gap[] = [];
  const seen = new Set<string>();
  for (const item of obj.gaps) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Record<string, unknown>;
    const axis = String(g.axis ?? '');
    if (!AXIS_SET.has(axis) || seen.has(axis)) continue;
    const gap_kind = g.gap_kind === 'spec' ? 'spec' : 'shelf';
    const sev = g.severity;
    const severity: ProcessMissSeverity =
      sev === 'high' || sev === 'medium' || sev === 'low' ? sev : 'medium';
    const focus_areas = Array.isArray(g.focus_areas)
      ? g.focus_areas
          .map((f) => String(f))
          .filter((f) => f.length >= 3)
          .slice(0, 5)
      : [];
    const rationale = typeof g.rationale === 'string' ? g.rationale : '';
    seen.add(axis);
    out.push({ axis: axis as Axis, gap_kind, severity, focus_areas, rationale });
  }
  return out;
}

const SEVERITY_RANK: Record<ProcessMissSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export interface AuditExpertiseDeps {
  specialists: SpecialistRegistry;
  misses: ProcessMissStore;
  inbox: SpecialistInbox;
  events?: AppEventBus;
  llm: LLMRouter;
  db: Database;
}

export function make_audit_specialist_expertise(
  deps: AuditExpertiseDeps,
): Tool<Input, Output> {
  return {
    name: 'audit_specialist_expertise',
    description:
      "Beatrice's expertise-coverage audit. Walks the specialists who opted in via `deepen: true` and scores each against the 9-axis craft rubric (domain-coverage completeness, source-tier discipline, grounded/falsifier claims, confirmed/announced/leaked labeling, two-layer store architecture, capability-envelope swimlanes, leak signal, recurring-question flags, demand-side persona/ICP/UCP). Each gap opens a `process_miss` AND flags Cordelia (one consolidated flag per specialist) to curate the shelf or propose a spec delta. Pass `specialist_id` to audit just one (bypasses the deepen gate). Idempotent on (specialist + axis); FAIL-OPEN on judge error.",
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `audit_specialist_expertise:${input.specialist_id ?? 'all'}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      // The audit roster: one named specialist (ad-hoc) or every deepen:true.
      const roster: LoadedSpecialist[] = input.specialist_id
        ? (() => {
            const s = deps.specialists.get(input.specialist_id!);
            return s ? [s] : [];
          })()
        : deps.specialists.list().filter((s) => s.deepen);

      const tracked = new Set<string>();
      for (const m of deps.misses.list()) {
        if (m.evidence_ref) tracked.add(m.evidence_ref);
      }

      const misses_opened: z.infer<typeof OpenedSchema>[] = [];
      const cordelia_flags: z.infer<typeof FlaggedSchema>[] = [];
      const current_findings_refs: string[] = [];
      let already_tracked = 0;
      let gaps_found = 0;

      // Order so the per-run flag budget goes to the highest-need specialists.
      type PendingFlag = {
        specialist: LoadedSpecialist;
        gaps: Array<Gap & { miss_id: string }>;
        max_rank: number;
      };
      const pending: PendingFlag[] = [];

      let role;
      try {
        role = deps.llm.for_role('planner');
      } catch {
        // No judge available → audit can't run; fail-open with an empty result.
        return {
          specialists_audited: 0,
          gaps_found: 0,
          misses_opened: [],
          cordelia_flags: [],
          already_tracked: 0,
          current_findings_refs: [],
        };
      }

      for (const s of roster) {
        const persona = (s.persona ?? '').slice(0, PERSONA_CHARS);
        const addenda = [
          s.chat_addendum ? `CHAT ADDENDUM:\n${s.chat_addendum}` : '',
          s.deliberation_addendum
            ? `DELIBERATION ADDENDUM:\n${s.deliberation_addendum}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n')
          .slice(0, PERSONA_CHARS);
        // mission: composes when Beatrice Pass 2 lands; absent today.
        const mission = (s as { mission?: string }).mission;

        let resp;
        try {
          resp = await role.provider.complete({
            messages: [
              { role: 'system', content: JUDGE_SYSTEM },
              {
                role: 'user',
                content:
                  `SPECIALIST: ${s.name} (id: ${s.id})\n` +
                  `ROLE: ${s.role}\n` +
                  (mission ? `MISSION: ${mission}\n` : '') +
                  `\nMACHINE SIGNALS:\n${machine_signals(s, deps.db)}\n\n` +
                  `PERSONA:\n${persona}\n\n` +
                  (addenda ? `${addenda}\n\n` : '') +
                  `Score this specialist against the 9 axes. Reply with ONLY the JSON.`,
              },
            ],
            temperature: 0.1,
            max_tokens: 900,
            think: false,
            ...role.defaults,
          });
        } catch {
          // FAIL-OPEN per specialist — skip, never fabricate a gap.
          continue;
        }

        const gaps = parse_gaps(resp.content);
        const new_for_specialist: Array<Gap & { miss_id: string }> = [];
        let max_rank = 0;

        for (const g of gaps) {
          const ref = `${s.id}:expertise:${g.axis}`;
          current_findings_refs.push(ref);
          if (tracked.has(ref)) {
            already_tracked++;
            continue;
          }
          tracked.add(ref);
          gaps_found++;

          const focus_line = g.focus_areas.length
            ? g.focus_areas.map((f) => `\`${f}\``).join(', ')
            : '(judge named no focus areas — derive from the rationale)';
          const gap_text =
            `**Expertise gap — axis \`${g.axis}\` (${g.gap_kind}).** ` +
            `${s.name} (\`${s.id}\`) scored below bar on the craft rubric. ` +
            `${g.rationale}\n\n` +
            `Focus areas: ${focus_line}\n\n` +
            `Cordelia: for a \`shelf\` gap, run \`curate_for_specialist\` against ` +
            `${s.id}'s trusted_sources for these focus areas. For a \`spec\` gap, ` +
            `file a \`propose_action\` for the definition delta (a persona ` +
            `discipline, a trusted_sources tier, or a structured-store layer). ` +
            `Read the craft note for axis \`${g.axis}\` in ` +
            `Knowledge/Cordelia/craft/ and \`read_specialist_spec(${s.id})\` first.`;

          const miss_id = deps.misses.create({
            subject_specialist_id: s.id,
            reporter: 'trainer',
            task_summary:
              `closing the \`${g.axis}\` expertise gap on ${s.name}'s ` +
              `${g.gap_kind === 'shelf' ? 'library shelf' : 'spec'}`,
            gap: gap_text,
            severity: g.severity,
            evidence_ref: ref,
          });
          misses_opened.push({
            miss_id,
            specialist_id: s.id,
            axis: g.axis,
            gap_kind: g.gap_kind,
            severity: g.severity,
            evidence_ref: ref,
          });
          new_for_specialist.push({ ...g, miss_id });
          max_rank = Math.max(max_rank, SEVERITY_RANK[g.severity]);
        }

        if (new_for_specialist.length > 0) {
          pending.push({ specialist: s, gaps: new_for_specialist, max_rank });
        }
      }

      // One consolidated Cordelia wake-flag per specialist, highest-need first,
      // capped at FLAG_CAP/run (= her ≤3-shelves/pass budget). Un-flagged gaps
      // still live as ledger misses (visible on Mariah's dashboard).
      pending.sort((a, b) => b.max_rank - a.max_rank);
      for (const p of pending.slice(0, FLAG_CAP)) {
        const s = p.specialist;
        const axes = p.gaps.map((g) => g.axis);
        const merged_focus = Array.from(
          new Set(p.gaps.flatMap((g) => g.focus_areas)),
        ).slice(0, 8);
        const focus_block = merged_focus.length
          ? merged_focus.map((f) => `- \`${f}\``).join('\n')
          : '- (derive focus areas from the per-axis misses below)';
        const axis_lines = p.gaps
          .map(
            (g) =>
              `- **${g.axis}** (${g.gap_kind}, ${g.severity}) — ${g.rationale} ` +
              `[miss \`${g.miss_id}\`]`,
          )
          .join('\n');
        const body_md =
          `**Expertise gap** flagged by Beatrice (trainer) — target: \`${s.id}\` ` +
          `(${s.name}), ${p.gaps.length} axis/axes below bar.\n\n` +
          `${axis_lines}\n\n` +
          `**Merged focus areas for the curate pass:**\n${focus_block}\n\n` +
          `Read the relevant craft notes in \`Knowledge/Cordelia/craft/\` and ` +
          `\`read_specialist_spec(${s.id})\`, then close each gap: \`shelf\` → ` +
          `\`curate_for_specialist\`; \`spec\` → \`propose_action\` for the ` +
          `definition delta (Jasper approves). Beatrice has moved on — ship it ` +
          `in your next pass.`;

        const inbox_id = deps.inbox.push({
          from_specialist_id: 'trainer',
          to_specialist_id: 'cordelia',
          kind: 'flag',
          body_md,
        });
        deps.events?.emit({
          type: 'inbox_message_added',
          message_id: inbox_id,
          from_specialist_id: 'trainer',
          to_specialist_id: 'cordelia',
          kind: 'flag',
          severity: p.max_rank >= SEVERITY_RANK.high ? 'high' : 'medium',
        });
        cordelia_flags.push({
          specialist_id: s.id,
          inbox_message_id: inbox_id,
          axes,
        });
      }

      return {
        specialists_audited: roster.length,
        gaps_found,
        misses_opened,
        cordelia_flags,
        already_tracked,
        current_findings_refs,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_audit_specialist_expertise({
    specialists: deps.specialists,
    misses: deps.process_misses,
    inbox: deps.inbox,
    events: deps.events,
    llm: deps.llm,
    db: deps.db,
  }) as Tool;
}
