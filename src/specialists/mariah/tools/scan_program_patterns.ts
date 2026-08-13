/**
 * scan_program_patterns — Mariah's fuzzy detection pass.
 *
 * `scan_program_health` catches the deterministic failures: a proposal
 * errored, a promised follow-up never delivered. This catches the softer
 * shortfalls that need judgment, not just a status flag:
 *
 *   - error_pattern      — one agent's tool erroring over and over
 *   - repeated_miss_class — a specialist accumulating misses of one kind
 *   - reasked_consult     — the user asking again because the first
 *                           answer didn't land
 *
 * Two phases. A deterministic SQL gather assembles candidate signals;
 * then an LLM judgment call decides which are genuine process misses
 * worth opening (a connector flaking during an external outage is not a
 * specialist's miss; the same connector erroring on malformed input
 * is). Idempotent — every candidate carries a stable `evidence_ref`, so
 * a miss is opened at most once per pattern.
 *
 * HEARTH_TEST_MODE short-circuits the LLM with a deterministic verdict
 * (confirm every gathered candidate) so smokes stay reproducible — the
 * same pattern `deliberation.ts` uses for its fixtures.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type {
  ProcessMissSeverity,
  ProcessMissStore,
} from '@core/process_misses';

const InputSchema = z.object({
  // Optional, not `.default()` — a Zod default makes the schema's input
  // and output types diverge, which the Tool<I,O> signature rejects. The
  // default is applied in execute() instead.
  lookback_hours: z.coerce.number().int().positive().max(8760).optional(),
});

const DEFAULT_LOOKBACK_HOURS = 168;

const OpenedSchema = z.object({
  miss_id: z.string(),
  subject_specialist_id: z.string(),
  pattern: z.string(),
  evidence_ref: z.string(),
});

const OutputSchema = z.object({
  candidates_seen: z.number(),
  already_tracked: z.number(),
  judged_not_a_miss: z.number(),
  misses_opened: z.array(OpenedSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

type PatternKind = 'error_pattern' | 'repeated_miss_class' | 'reasked_consult';

interface Candidate {
  kind: PatternKind;
  /** Stable, idempotent — a miss is opened at most once per ref. */
  evidence_ref: string;
  subject_specialist_id: string;
  /** What the subject was supposed to deliver. */
  task_summary: string;
  /** The raw evidence the LLM weighs. */
  signal: string;
  default_severity: ProcessMissSeverity;
}

interface Verdict {
  evidence_ref: string;
  is_miss: boolean;
  severity: ProcessMissSeverity;
  gap: string;
}

// Detection thresholds. A pattern below these never even becomes a
// candidate — the LLM only judges signals that already cleared a floor.
const ERROR_CLUSTER_MIN = 3;
const REPEATED_MISS_MIN = 3;
const REASK_WINDOW_HOURS = 24;

const TEST_MODE = (): boolean => process.env.HEARTH_TEST_MODE === '1';

function snippet(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Errors clustered by (agent, tool) — a tool that keeps failing. */
function gather_error_patterns(db: Database, since_iso: string): Candidate[] {
  const rows = db
    .prepare(
      `SELECT agent, tool_name, COUNT(*) AS n, MIN(error) AS sample_error
         FROM audit_log
        WHERE ts >= @since
          AND error IS NOT NULL
          AND agent NOT IN ('ingestor')
        GROUP BY agent, tool_name
        HAVING COUNT(*) >= @min`,
    )
    .all({ '@since': since_iso, '@min': ERROR_CLUSTER_MIN }) as Array<{
    agent: string;
    tool_name: string;
    n: number;
    sample_error: string | null;
  }>;
  return rows.map((r) => ({
    kind: 'error_pattern' as const,
    evidence_ref: `pattern:errors:${r.agent}:${r.tool_name}`,
    subject_specialist_id: r.agent,
    task_summary: `\`${r.tool_name}\` running cleanly for ${r.agent}`,
    signal:
      `${r.n} errors from \`${r.agent}\` calling \`${r.tool_name}\` ` +
      `since ${since_iso}. Sample error: ${snippet(r.sample_error ?? '(no message)', 280)}`,
    default_severity: r.n >= 10 ? 'high' : 'medium',
  }));
}

/**
 * Normalize a miss's evidence_ref into its CLASS key — the recurring SHAPE of
 * the miss, stripped of the per-instance identity (the specialist id, dated
 * suffixes, trailing ids). Two misses that share a class key are the SAME kind
 * of shortfall recurring:
 *   auth:fab-after-read-failure-consult:01KW36…  → auth:fab-after-read-failure-consult
 *   honesty:fabricated_save:kate                 → honesty:fabricated_save
 *   arg-mismatch:read_note                       → arg-mismatch:read_note
 *   round-ceiling:kate:2026-W26                  → round-ceiling
 *   kristi-spec-reject:2026-06-28                → kristi-spec-reject
 * Returns null when nothing class-bearing survives (a bare id / no ref) — those
 * misses can't anchor a "same class recurring" signal, so they're unclassified.
 */
export function miss_class_key(evidence_ref: string | null | undefined, subject: string): string | null {
  if (!evidence_ref) return null;
  const kept: string[] = [];
  for (const raw of evidence_ref.split(':')) {
    const p = raw.trim();
    if (!p) continue;
    if (p === subject) continue; // the specialist id is the instance, not the class
    if (/^\d{4}-\d{2}/.test(p)) break; // ISO date suffix (2026-06-28) → boundary
    if (/^\d{4}-w\d{1,2}$/i.test(p) || /^w\d{1,2}$/i.test(p)) break; // ISO week
    // a trailing per-incident id is the instance, not the class:
    if (kept.length > 0 && p.length >= 12 && /\d/.test(p) && /^[0-9a-z]+$/i.test(p)) break; // ULID-ish
    // typed id (c_…, pm_…, ap_…): a short prefix + a base32-ish body. Require a
    // DIGIT in the body so a tool/class name like `read_note` / `data_denial`
    // (no digits) is NOT mistaken for an id and stays part of the class.
    if (kept.length > 0 && /^[a-z]{1,4}_[0-9a-z]*\d[0-9a-z]*$/i.test(p)) break;
    kept.push(p.toLowerCase());
  }
  return kept.length ? kept.join(':') : null;
}

/**
 * A specialist accumulating the SAME CLASS of miss — a structural signal.
 *
 * The bar is a coherent recurring class, not a count of unrelated misses. The
 * old "≥3 misses of ANY kind → open a `pattern:repeat:<subject>` miss" fanned
 * out to every specialist the moment a shared outage (firecrawl down → every
 * agent's web_fetch_clean fails → read-failure misses everywhere) padded their
 * ledgers — 18 generic "fundamental deficits" misses in one morning, routed to
 * Mariah with no actionable gap (the 2026-06-28 cascade; the meta-loop-noise
 * class). Clustering by `miss_class_key` keeps only genuinely repeated shapes
 * (the same tool's arg-mismatch, the same fabrication guard) and names the
 * specific class — a specialist with 3 unrelated one-off misses no longer trips.
 * Infra-health misses (`dependency:*`) and pattern-derived misses are excluded:
 * neither is the specialist's own quality.
 */
function gather_repeated_miss_classes(misses: ProcessMissStore): Candidate[] {
  // (subject → class_key → gaps)
  const by_subject = new Map<string, Map<string, string[]>>();
  for (const m of misses.list()) {
    const ref = m.evidence_ref ?? null;
    // A pattern-derived miss is not evidence of itself; a dependency-health
    // incident is infra, not the specialist's quality — skip both.
    if (ref && (ref.startsWith('pattern:') || ref.startsWith('dependency:'))) continue;
    const cls = miss_class_key(ref, m.subject_specialist_id);
    if (!cls) continue; // unclassified misses can't anchor a "same class" signal
    const classes = by_subject.get(m.subject_specialist_id) ?? new Map<string, string[]>();
    const arr = classes.get(cls) ?? [];
    arr.push(m.gap);
    classes.set(cls, arr);
    by_subject.set(m.subject_specialist_id, classes);
  }
  const out: Candidate[] = [];
  for (const [subject, classes] of by_subject) {
    for (const [cls, gaps] of classes) {
      if (gaps.length < REPEATED_MISS_MIN) continue;
      const sample = gaps
        .slice(0, 6)
        .map((g) => `“${snippet(g, 100)}”`)
        .join('; ');
      out.push({
        kind: 'repeated_miss_class',
        evidence_ref: `pattern:repeat:${subject}:${cls}`,
        subject_specialist_id: subject,
        task_summary: `\`${subject}\` no longer recurring on \`${cls}\``,
        signal:
          `${gaps.length} process misses of the SAME class (\`${cls}\`) have been ` +
          `opened against \`${subject}\` — a recurring shortfall, not one-offs. ` +
          `Gaps: ${sample}`,
        default_severity: 'high',
      });
    }
  }
  return out;
}

/** Consecutive user turns in one conversation — a possible re-ask. */
function gather_reasked_consults(db: Database, since_iso: string): Candidate[] {
  const msgs = db
    .prepare(
      `SELECT m.id, m.conversation_id, m.ts, m.content_md, c.specialist_id
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.role = 'user' AND m.ts >= @since
        ORDER BY m.conversation_id, m.ts`,
    )
    .all({ '@since': since_iso }) as Array<{
    id: string;
    conversation_id: string;
    ts: string;
    content_md: string;
    specialist_id: string;
  }>;
  const out: Candidate[] = [];
  for (let i = 1; i < msgs.length; i++) {
    const prev = msgs[i - 1]!;
    const cur = msgs[i]!;
    if (prev.conversation_id !== cur.conversation_id) continue;
    const gap_ms = new Date(cur.ts).getTime() - new Date(prev.ts).getTime();
    if (gap_ms <= 0 || gap_ms > REASK_WINDOW_HOURS * 3_600_000) continue;
    out.push({
      kind: 'reasked_consult',
      evidence_ref: `pattern:reask:${cur.id}`,
      subject_specialist_id: cur.specialist_id,
      task_summary: `answering \`${cur.specialist_id}\`'s user clearly the first time`,
      signal:
        `In conversation ${cur.conversation_id} the user asked \`${cur.specialist_id}\` ` +
        `twice, ${Math.round(gap_ms / 60_000)}m apart.\n` +
        `FIRST: ${snippet(prev.content_md, 240)}\n` +
        `THEN:  ${snippet(cur.content_md, 240)}`,
    default_severity: 'low',
    });
  }
  return out;
}

/** Deterministic test-mode gap text — stands in for the LLM's wording. */
function test_gap(c: Candidate): string {
  switch (c.kind) {
    case 'error_pattern':
      return `a tool is erroring repeatedly — ${c.subject_specialist_id} needs to find out why`;
    case 'repeated_miss_class':
      return `the same class of miss keeps recurring for ${c.subject_specialist_id}`;
    case 'reasked_consult':
      return `the user had to re-ask — the first answer did not land`;
  }
}

/**
 * The judgment phase. In TEST_MODE every gathered candidate is confirmed
 * (the gather thresholds are the judgment); otherwise an LLM weighs each
 * one and returns a verdict per candidate.
 */
async function judge(candidates: Candidate[], ctx: ToolContext): Promise<Verdict[]> {
  if (candidates.length === 0) return [];
  if (TEST_MODE()) {
    return candidates.map((c) => ({
      evidence_ref: c.evidence_ref,
      is_miss: true,
      severity: c.default_severity,
      gap: test_gap(c),
    }));
  }

  const system =
    `You are Mariah, the household's program manager, doing a pattern review. ` +
    `Below are candidate signals from the program — error clusters, specialists ` +
    `accumulating misses, possibly re-asked questions. For EACH candidate judge ` +
    `whether it is a genuine PROCESS MISS worth opening for follow-up, or ` +
    `acceptable noise (a one-off, an external outage, an unrelated coincidence). ` +
    `Be conservative: open a miss only when a specialist's work plausibly fell ` +
    `short. Reply with ONE json code block of the shape:\n` +
    '```json\n' +
    `{ "verdicts": [ { "ref": "<evidence_ref>", "is_miss": true, ` +
    `"severity": "low|medium|high", "gap": "<one sentence: what fell short>" } ] }\n` +
    '```\n' +
    `Include every ref exactly once.`;
  const user = candidates
    .map(
      (c, i) =>
        `### Candidate ${i + 1}\n` +
        `ref: ${c.evidence_ref}\n` +
        `kind: ${c.kind}\n` +
        `subject specialist: ${c.subject_specialist_id}\n` +
        `signal: ${c.signal}`,
    )
    .join('\n\n');

  try {
    const role = ctx.llm.for_role('reflector');
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: role.defaults.temperature,
    });
    const m = resp.content.match(/```json\s*\n([\s\S]*?)\n```/);
    if (!m || m[1] === undefined) return [];
    const parsed = JSON.parse(m[1]) as {
      verdicts?: Array<{ ref?: unknown; is_miss?: unknown; severity?: unknown; gap?: unknown }>;
    };
    const verdicts: Verdict[] = [];
    for (const v of parsed.verdicts ?? []) {
      if (typeof v.ref !== 'string' || typeof v.gap !== 'string') continue;
      const severity: ProcessMissSeverity =
        v.severity === 'low' || v.severity === 'high' ? v.severity : 'medium';
      verdicts.push({
        evidence_ref: v.ref,
        is_miss: v.is_miss === true,
        severity,
        gap: v.gap,
      });
    }
    return verdicts;
  } catch (err) {
    console.error('[scan_program_patterns] LLM judgment failed:', err);
    return [];
  }
}

export function make_scan_program_patterns(
  db: Database,
  misses: ProcessMissStore,
): Tool<Input, Output> {
  return {
    name: 'scan_program_patterns',
    description:
      "Mariah's fuzzy detection pass. Where scan_program_health catches deterministic failures, this catches the softer shortfalls that need judgment: a tool erroring repeatedly, a specialist accumulating the same class of miss, the user re-asking because the first answer didn't land. It gathers candidate patterns from the audit log, the process-miss ledger, and conversations, has them judged, and opens a process miss for each genuine one. Deterministic and idempotent — safe to run any time; it never double-flags. Takes an optional `lookback_hours` (default 168). Returns a digest of what was seen and what was opened.",
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    yield: { none: true, reason: 'a detector — it opens a miss only on a coherent repeated class; zero means no pattern recurred' },
    idempotency_key() {
      return 'scan_program_patterns';
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const now = ctx.now ?? new Date();
      const lookback_hours = input.lookback_hours ?? DEFAULT_LOOKBACK_HOURS;
      const since_iso = new Date(
        now.getTime() - lookback_hours * 3_600_000,
      ).toISOString();

      // ── phase 1: deterministic gather ───────────────────────────────────
      const all_candidates: Candidate[] = [
        ...gather_error_patterns(db, since_iso),
        ...gather_repeated_miss_classes(misses),
        ...gather_reasked_consults(db, since_iso),
      ];

      // Drop candidates already tracked by an existing miss before the
      // judgment call — the LLM only ever weighs genuinely new signals.
      const tracked = new Set<string>();
      for (const m of misses.list()) {
        if (m.evidence_ref) tracked.add(m.evidence_ref);
      }
      const fresh = all_candidates.filter((c) => !tracked.has(c.evidence_ref));
      const already_tracked = all_candidates.length - fresh.length;

      // ── phase 2: judgment ───────────────────────────────────────────────
      const verdicts = await judge(fresh, ctx);
      const verdict_by_ref = new Map(verdicts.map((v) => [v.evidence_ref, v]));

      // ── phase 3: open a miss per confirmed candidate ────────────────────
      const opened: z.infer<typeof OpenedSchema>[] = [];
      let judged_not_a_miss = 0;
      for (const c of fresh) {
        const v = verdict_by_ref.get(c.evidence_ref);
        if (!v || !v.is_miss) {
          judged_not_a_miss++;
          continue;
        }
        const miss_id = misses.create({
          subject_specialist_id: c.subject_specialist_id,
          reporter: 'mariah',
          task_summary: c.task_summary,
          gap: v.gap,
          severity: v.severity,
          evidence_ref: c.evidence_ref,
        });
        opened.push({
          miss_id,
          subject_specialist_id: c.subject_specialist_id,
          pattern: c.kind,
          evidence_ref: c.evidence_ref,
        });
      }

      return {
        candidates_seen: all_candidates.length,
        already_tracked,
        judged_not_a_miss,
        misses_opened: opened,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_scan_program_patterns(deps.db, deps.process_misses) as Tool;
}
