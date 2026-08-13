/**
 * scan_specialist_alignment — Mariah's roster check.
 *
 * `scan_program_health` catches work that FAILED; `scan_program_patterns`
 * catches behaviour that DRIFTED. This catches the layer underneath: a
 * specialist whose CONFIGURATION is misaligned, so they fail — or fall
 * quiet — before any single piece of work does.
 *
 * Four deterministic checks per specialist:
 *
 *   - uncurated_tool_surface — a broad capability grant with no
 *     `tools_for_chat` curation. Past ~15 tool schemas Qwen3.6 drops
 *     tool-call args to `{}`; the turn then retry-storms and times out.
 *     This is the class the "Iris times out" report belonged to. See
 *     architecture.md "Per-turn tool curation".
 *   - dangling_curation_ref — a `tools_for_chat` / `tools_for_deliberation`
 *     entry that resolves to no registered tool: a typo that silently
 *     curates nothing.
 *   - left_behind — a specialist with no audited activity at all over
 *     the lookback window. Work may be routing around them.
 *   - persona_prescribes_unavailable_tool — the specialist's persona
 *     names a real registered tool (in backticks) that the specialist
 *     cannot actually invoke because either (a) their capability grant
 *     doesn't enable it, or (b) their `tools_for_chat` /
 *     `tools_for_deliberation` curates it out. Caught Beatrice's
 *     prescribed `write_binding_proposal` flow before the tool existed.
 *
 * Opens a process miss per finding, keyed by a stable `evidence_ref` so
 * a re-run never double-flags — the same idempotency contract as the two
 * sibling scans. Runs as Mariah's daily background job; can also be
 * invoked directly.
 */
import { z } from 'zod';
import { statSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type {
  ProcessMissSeverity,
  ProcessMissStore,
} from '@core/process_misses';
import type { SpecialistRegistry } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';

const InputSchema = z.object({
  // Window for the left-behind check. Optional, not `.default()` — a Zod
  // default diverges the schema's input/output types and the Tool<I,O>
  // signature rejects it; the default is applied in execute().
  lookback_days: z.coerce.number().int().positive().max(365).optional(),
});

const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Effective chat tool count at or above which Qwen3.6 starts dropping
 * tool-call arguments. The runtime always appends `consult_specialist`
 * on top of the capability-resolved set, so the effective count is
 * `registry_count + 1`.
 */
const QWEN_TOOL_CEILING = 15;

type Finding =
  | 'uncurated_tool_surface'
  | 'dangling_curation_ref'
  | 'left_behind'
  | 'persona_prescribes_unavailable_tool';

const OpenedSchema = z.object({
  miss_id: z.string(),
  subject_specialist_id: z.string(),
  finding: z.string(),
  evidence_ref: z.string(),
});

const OutputSchema = z.object({
  specialists_checked: z.number(),
  uncurated_seen: z.number(),
  dangling_seen: z.number(),
  left_behind_seen: z.number(),
  persona_unavailable_tool_seen: z.number(),
  already_tracked: z.number(),
  misses_opened: z.array(OpenedSchema),
  /** Every evidence_ref this scan would emit on this run, BEFORE the
   *  idempotency dedup. Used by verify_fix_landed to know which refs
   *  the scan currently considers active so a fixed-by-reality miss
   *  can auto-close. */
  current_findings_refs: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function make_scan_specialist_alignment(
  db: Database,
  specialists: SpecialistRegistry,
  tools: ToolRegistry,
  misses: ProcessMissStore,
): Tool<Input, Output> {
  return {
    name: 'scan_specialist_alignment',
    description:
      'Sweep the specialist roster for CONFIGURATION misalignment — the ' +
      'layer below failed work. Opens a process miss for each: an ' +
      'uncurated tool surface past the curation wall (makes Qwen drop ' +
      'tool-call args, so the turn retry-storms and times out), a ' +
      'dangling tools_for_chat / tools_for_deliberation entry (a typo ' +
      'that curates nothing), and a specialist with no audited activity ' +
      'at all (work routing around them — no one left behind). ' +
      'Deterministic and idempotent — safe to run any time; it never ' +
      'double-flags. Takes an optional lookback_days (default 30). ' +
      'Returns a digest of what was seen and the misses newly opened. ' +
      "This is Mariah's roster check; it also runs daily as her " +
      'background job.',
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    yield: { none: true, reason: 'a detector — zero findings means every specialist roster is aligned' },
    idempotency_key() {
      return 'scan_specialist_alignment';
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const now = ctx.now ?? new Date();
      const lookback_days = input.lookback_days ?? DEFAULT_LOOKBACK_DAYS;
      const window_ms = lookback_days * 86_400_000;
      const since_iso = new Date(now.getTime() - window_ms).toISOString();

      const tracked = new Set<string>();
      for (const m of misses.list()) {
        if (m.evidence_ref) tracked.add(m.evidence_ref);
      }

      // Every registered tool name, plus consult_specialist — which the
      // runtime appends to every turn, so it is never in the registry
      // but is always a valid curation entry.
      const tool_names = new Set<string>(tools.list().map((t) => t.name));
      tool_names.add('consult_specialist');

      const opened: z.infer<typeof OpenedSchema>[] = [];
      const current_findings_refs: string[] = [];
      let already = 0;
      let uncurated_seen = 0;
      let dangling_seen = 0;
      let left_behind_seen = 0;
      let persona_unavailable_tool_seen = 0;

      const roster = specialists.list();
      const audit_count = db.prepare(
        `SELECT COUNT(*) AS n FROM audit_log
          WHERE agent = @id AND ts >= @since`,
      );

      for (const s of roster) {
        const p = s.proactive;

        // ── A. uncurated tool surface ───────────────────────────────────
        const granted_count = tools.list_for_capabilities(s.granted).length;
        const effective = granted_count + 1; // + consult_specialist
        if (effective >= QWEN_TOOL_CEILING && p.tools_for_chat.length === 0) {
          uncurated_seen++;
          const ref = `roster:uncurated-chat:${s.id}`;
          current_findings_refs.push(ref);
          if (tracked.has(ref)) {
            already++;
          } else {
            const also_delib =
              (p.deliberation_at?.length ?? 0) > 0 &&
              p.tools_for_deliberation.length === 0;
            const gap =
              `${s.name}'s capability grant resolves to ${effective} ` +
              `tools, but proactive.tools_for_chat is empty — every chat ` +
              `turn is uncurated. Past ~${QWEN_TOOL_CEILING} tool schemas ` +
              `Qwen3.6 drops tool-call args to {}, which retry-storms the ` +
              `turn and times it out. Fix: set proactive.tools_for_chat` +
              (also_delib ? ' (and tools_for_deliberation)' : '') +
              ` in config/specialists/${s.id}.yaml to the short list ` +
              `${s.name}'s workflows actually need.`;
            const severity: ProcessMissSeverity =
              effective >= QWEN_TOOL_CEILING + 7 ? 'high' : 'medium';
            const miss_id = misses.create({
              subject_specialist_id: s.id,
              reporter: 'mariah',
              task_summary: `keeping ${s.name}'s chat-turn tool surface curated`,
              gap,
              severity,
              evidence_ref: ref,
            });
            opened.push({
              miss_id,
              subject_specialist_id: s.id,
              finding: 'uncurated_tool_surface' satisfies Finding,
              evidence_ref: ref,
            });
          }
        }

        // ── B. dangling curation references ─────────────────────────────
        const dangling: string[] = [];
        for (const name of [
          ...p.tools_for_chat,
          ...p.tools_for_deliberation,
        ]) {
          if (!tool_names.has(name) && !dangling.includes(name)) {
            dangling.push(name);
          }
        }
        if (dangling.length > 0) {
          dangling_seen++;
          const ref = `roster:dangling-tool:${s.id}`;
          current_findings_refs.push(ref);
          if (tracked.has(ref)) {
            already++;
          } else {
            const miss_id = misses.create({
              subject_specialist_id: s.id,
              reporter: 'mariah',
              task_summary: `keeping ${s.name}'s tool-curation lists valid`,
              gap:
                `${s.name}'s curation lists name ${dangling.length} ` +
                `tool(s) that no registered tool matches: ` +
                `${dangling.join(', ')}. A curation entry that resolves ` +
                `to nothing is silently dropped — likely a typo or a ` +
                `renamed/removed tool. Fix the name in ` +
                `config/specialists/${s.id}.yaml.`,
              severity: 'low',
              evidence_ref: ref,
            });
            opened.push({
              miss_id,
              subject_specialist_id: s.id,
              finding: 'dangling_curation_ref' satisfies Finding,
              evidence_ref: ref,
            });
          }
        }

        // ── D. persona prescribes a tool the specialist can't invoke ───
        // Walk the persona for backtick-quoted tool names that match a
        // real registered tool, then verify the specialist actually has
        // access. Effective access = granted by capabilities AND (no
        // curated list OR the tool is in the relevant curated list).
        // Catches the Beatrice class: persona says "call X" but X is
        // either ungranted, curated out, or only exists in chat and the
        // persona prescribes it in deliberation.
        const persona_text = s.persona ?? '';
        if (persona_text.length > 0) {
          const tick_re = /`([a-z][a-z0-9_]{4,40})`/g;
          const mentioned = new Set<string>();
          let m: RegExpExecArray | null;
          while ((m = tick_re.exec(persona_text)) !== null) {
            const tname = m[1];
            if (tname && tool_names.has(tname)) mentioned.add(tname);
          }
          // Resolve effective access. consult_specialist is auto-
          // appended by the runtime so always counts as accessible.
          const granted_names = new Set<string>(
            tools.list_for_capabilities(s.granted).map((t) => t.name),
          );
          granted_names.add('consult_specialist');
          const chat_set = new Set<string>(p.tools_for_chat);
          const delib_set = new Set<string>(p.tools_for_deliberation);
          const chat_curated = chat_set.size > 0;
          const delib_curated = delib_set.size > 0;
          const unavailable: string[] = [];
          for (const name of mentioned) {
            if (!granted_names.has(name)) {
              unavailable.push(name);
              continue;
            }
            // Capability-granted but possibly curated out everywhere.
            // If both lists are curated and the tool is in neither,
            // it cannot be invoked from any turn. (If only one list is
            // curated, the other is wide-open and the tool is
            // reachable there — so don't flag.)
            if (
              chat_curated &&
              delib_curated &&
              !chat_set.has(name) &&
              !delib_set.has(name)
            ) {
              unavailable.push(name);
            }
          }
          if (unavailable.length > 0) {
            persona_unavailable_tool_seen++;
            const ref = `roster:persona-tool-gap:${s.id}`;
            current_findings_refs.push(ref);
            if (tracked.has(ref)) {
              already++;
            } else {
              const miss_id = misses.create({
                subject_specialist_id: s.id,
                reporter: 'mariah',
                task_summary: `keeping ${s.name}'s persona aligned with their tools`,
                gap:
                  `${s.name}'s persona names ${unavailable.length} tool(s) ` +
                  `they can't invoke from any turn: ${unavailable.join(', ')}. ` +
                  `Either grant the missing capability, add the tool to ` +
                  `tools_for_chat / tools_for_deliberation, or revise the ` +
                  `persona so it doesn't prescribe an action they have no ` +
                  `tool for. This is the class of bug that had Beatrice ` +
                  `silently failing to write binding-proposal markdown for ` +
                  `weeks.`,
                severity: 'medium',
                evidence_ref: ref,
              });
              opened.push({
                miss_id,
                subject_specialist_id: s.id,
                finding: 'persona_prescribes_unavailable_tool' satisfies Finding,
                evidence_ref: ref,
              });
            }
          }
        }

        // ── C. left behind ──────────────────────────────────────────────
        // Skip a specialist whose config was created/edited inside the
        // window — recently-touched means actively worked on, not
        // abandoned. An unstattable path (none in production) is treated
        // as old so the check still runs.
        let recently_touched = false;
        try {
          recently_touched =
            statSync(s.source_path).mtimeMs >= now.getTime() - window_ms;
        } catch {
          recently_touched = false;
        }
        if (!recently_touched) {
          const row = audit_count.get({
            '@id': s.id,
            '@since': since_iso,
          }) as { n: number } | undefined;
          if ((row?.n ?? 0) === 0) {
            left_behind_seen++;
            const ref = `roster:idle:${s.id}`;
            current_findings_refs.push(ref);
            if (tracked.has(ref)) {
              already++;
            } else {
              const miss_id = misses.create({
                subject_specialist_id: s.id,
                reporter: 'mariah',
                task_summary: `keeping ${s.name} engaged in the program`,
                gap:
                  `${s.name} has no audited activity in the last ` +
                  `${lookback_days} days — no turns, no deliberation, no ` +
                  `tool calls. Either work is routing around this role or ` +
                  `the role is no longer needed. Worth a deliberate look, ` +
                  `not a silent drift.`,
                severity: 'low',
                evidence_ref: ref,
              });
              opened.push({
                miss_id,
                subject_specialist_id: s.id,
                finding: 'left_behind' satisfies Finding,
                evidence_ref: ref,
              });
            }
          }
        }
      }

      return {
        specialists_checked: roster.length,
        uncurated_seen,
        dangling_seen,
        left_behind_seen,
        persona_unavailable_tool_seen,
        already_tracked: already,
        misses_opened: opened,
        current_findings_refs,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_scan_specialist_alignment(
    deps.db,
    deps.specialists,
    deps.tool_registry,
    deps.process_misses,
  ) as Tool;
}
