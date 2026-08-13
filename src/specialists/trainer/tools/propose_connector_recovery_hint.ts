/**
 * propose_connector_recovery_hint — Beatrice's force multiplier for the
 * "connectors that return bare errors invite fabrication" class.
 *
 * The shape is well-defined enough to template:
 *
 *   - A connector tool whose output_schema can return `error` but has
 *     no structured recovery field (audited by
 *     audit_connector_affordances and flagged via process_miss with
 *     evidence_ref shape `affordance:no-recovery-hint:<tool>`).
 *
 *   - The fix is the ha_get_state pattern: add an optional field to
 *     the output schema (`candidates` / `suggestions` / `alternatives`
 *     / similar), populate it in the error path of execute() with
 *     same-domain ranked matches, and surface it in the tool
 *     description so the LLM knows to consult it instead of
 *     fabricating.
 *
 *   - The blast radius is real — one connector fix closes every miss
 *     of fabrication_after_read_failure that traced upstream to that
 *     connector's bare-error shape.
 *
 * Beatrice's pre-existing flow was to hand-write each binding proposal
 * markdown from scratch, file via write_binding_proposal +
 * propose_action. For 42 distinct connectors that's 42 nearly-identical
 * proposals, ~30 min of authoring each. This tool templates the
 * proposal end-to-end: she calls it once per connector with the spec
 * params, the proposal lands on Jasper's queue with a ready-to-ship
 * description, and on approval her existing propose_code_change tool
 * does the actual PR.
 *
 * Output of the proposal is structured enough that Beatrice's eventual
 * `propose_code_change` call (post-approval) reads it directly and
 * doesn't have to re-derive the schema diff or the populate-when spec.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProposalsStore } from '@core/proposals';
import type { ToolRegistry } from '@core/tool_registry';
import type { ProcessMissStore } from '@core/process_misses';
import { existing_recovery_fields } from '@core/connector_affordances';

// cwd default (repo root the app runs from — `/app` in the container), matching
// src/core/tool_loader.ts. The old '/home/jasper/hearth' literal was the dead
// pre-the LLM host path, so this tool couldn't read the connector it was proposing on.
const REPO_ROOT = process.env.HEARTH_REPO_ROOT ?? process.cwd();

/** Directories under src/ to scan for connector source files. */
const SEARCH_DIRS = [
  'src/connectors',
  'src/tools',
  'src/specialists',
];

const InputSchema = z.object({
  /** The connector tool to enrich. Must be currently registered. */
  tool_name: z.string().min(1).max(80),
  /** Name of the new optional output_schema field. Typical: `candidates`,
   *  `suggestions`, `alternatives`. Lowercase snake_case. */
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The snake_case shape is
  // validated in execute() and returned as a typed refusal.
  recovery_field_name: z
    .string()
    .min(2)
    .max(40)
    .describe('Name of the new optional output_schema field, lowercase snake_case (e.g. "candidates").'),
  /** One-sentence description of what the field carries — goes into
   *  the Zod `.describe()` and the tool description. */
  recovery_field_description: z.string().min(20).max(400),
  /** One-paragraph spec of when to populate the field (e.g. "on HTTP
   *  4xx", "on empty body", "when the underlying API returns a
   *  challenge page"). */
  when_to_populate: z.string().min(20).max(800),
  /** One-paragraph spec of HOW to derive the recovery hint (e.g.
   *  "from /api/states filtered to same-domain entities, ranked by
   *  shared-token overlap" — the ha_get_state template). */
  how_to_derive: z.string().min(20).max(1200),
  /** Optional concrete example of what the field would carry,
   *  encoded as a short JSON-ish snippet. Lands verbatim in the
   *  proposal markdown. */
  example_payload: z.string().max(2000).optional(),
  /** Optional list of process_miss ids this fix would close. The
   *  proposal cites them so Jasper sees the blast radius. */
  closes_miss_ids: z.array(z.string()).max(100).optional(),
  /** YOUR rationale — Beatrice talking to the user about what
   *  pattern she saw in the misses, why this connector fix closes
   *  the class, and what the affordance buys downstream. Written
   *  in voice, not as a Github commit message. See the tool
   *  description for what works and what to avoid. */
  rationale: z.string().min(40).max(2_000),
});

const OutputSchema = z.object({
  proposal_id: z.string().nullable(),
  connector_path: z.string().nullable(),
  binding_proposal_path: z.string().nullable(),
  blast_radius: z.number(),
  summary: z.string(),
  /** True when the tool declined to file — see refused_reason. A
   *  refusal is a RESULT, not an error: the model reads why and moves
   *  on instead of retrying into a spiral. */
  refused: z.boolean(),
  refused_reason: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * Walk SEARCH_DIRS recursively, return the first .ts file whose source
 * exports a Tool with `name: '<tool_name>'`. Returns absolute path or
 * null. Skips obvious non-connector dirs (test files, smokes).
 */
function locate_connector_source(tool_name: string): string | null {
  const needle_double = `name: "${tool_name}"`;
  const needle_single = `name: '${tool_name}'`;
  for (const dir of SEARCH_DIRS) {
    const abs = resolve(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    const stack: string[] = [abs];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries: string[];
      try { entries = readdirSync(cur); } catch { continue; }
      for (const e of entries) {
        if (e.startsWith('.') || e === 'node_modules') continue;
        const child = resolve(cur, e);
        let s: ReturnType<typeof statSync>;
        try { s = statSync(child); } catch { continue; }
        if (s.isDirectory()) { stack.push(child); continue; }
        if (!e.endsWith('.ts') || e.endsWith('.test.ts')) continue;
        let body: string;
        try { body = readFileSync(child, 'utf8'); } catch { continue; }
        if (body.includes(needle_double) || body.includes(needle_single)) {
          return child;
        }
      }
    }
  }
  return null;
}

/**
 * Extract the current output_schema declaration as a string snippet
 * for citation in the proposal. Conservative: finds the lines from
 * `const <Name>Output = z.object({` through the matching `});`.
 * Returns null if the shape isn't recognizable.
 */
function extract_output_schema_snippet(source: string): string | null {
  const start_match = source.match(
    /const\s+([A-Z][A-Za-z0-9_]*Output(?:Schema)?)\s*=\s*z\.object\(\{/,
  );
  if (!start_match) return null;
  const start_idx = source.indexOf(start_match[0]);
  if (start_idx < 0) return null;
  // Walk forward, tracking brace depth until balanced.
  let depth = 0;
  let i = start_idx + start_match[0].length;
  depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  // Capture through the closing `});` if present.
  if (i < source.length && source[i] === ')') i++;
  if (i < source.length && source[i] === ';') i++;
  const snippet = source.slice(start_idx, i);
  if (snippet.length > 2000) {
    // Schema bodies are usually compact; if it's huge, truncate.
    return snippet.slice(0, 2000) + '\n  // … truncated for proposal …';
  }
  return snippet;
}

function build_proposal_markdown(args: {
  tool_name: string;
  connector_path: string | null;
  schema_snippet: string | null;
  input: Input;
  cited_misses: Array<{ id: string; gap: string }>;
}): string {
  const { tool_name, connector_path, schema_snippet, input, cited_misses } = args;
  const blast = cited_misses.length;
  const example_section = input.example_payload
    ? `\n## Example payload\n\n\`\`\`json\n${input.example_payload}\n\`\`\`\n`
    : '';
  const cited_section =
    blast > 0
      ? `\n## Process misses this fix closes (${blast})\n\n` +
        cited_misses
          .slice(0, 25)
          .map((m) => `- \`${m.id}\` — ${m.gap.slice(0, 200)}${m.gap.length > 200 ? '…' : ''}`)
          .join('\n') +
        (blast > 25 ? `\n- … and ${blast - 25} more.` : '') +
        '\n'
      : '';

  return `# Connector recovery hint — \`${tool_name}\`

> **Binding proposal** generated by \`propose_connector_recovery_hint\` on ${new Date().toISOString()}.
> Pattern: connector affordance — give a calling LLM somewhere to go besides fabrication when the read fails.
> Template precedent: \`ha_get_state\` (2026-05-25, commit \`dca35a2\`) — bare \`{state: null, error: '404'}\` extended to \`{state: null, error, candidates: [{entity_id, friendly_name}]}\` ranked by shared-token overlap.

## Rationale

The \`${tool_name}\` connector currently returns an \`error\` field
with no adjacent structured recovery hint. Audit findings document
that this shape invites fabrication: when the LLM reads
\`{result..., error: "..."}\` with no actionable next step, it
manufactures a plausible answer rather than retry or honestly
report the failure. The Iris/EV incident on 2026-05-25 is the
documented precedent. Adding a single optional output field —
populated only when the error path is taken — turns those turns
into clean retries.

**Blast radius:** this fix closes ${blast} open process_miss${blast === 1 ? '' : 'es'} of the \`fab-after-read-failure\` / \`no-recovery-hint\` family upstream of this connector.

## Affected files

${connector_path ? `- \`${connector_path.replace(REPO_ROOT + '/', '')}\` — connector source` : '- _(connector source not auto-located; Beatrice locates before PR)_'}

## Proposed change

Add an optional \`${input.recovery_field_name}\` field to the
connector's \`output_schema\`. Type: array of objects (shape per
the description below), \`.optional()\` — only set on the error
path so successful reads stay unchanged.

**Field description (for the Zod \`.describe()\` and the tool's
\`description\`):**

> ${input.recovery_field_description}

**When to populate:**

${input.when_to_populate}

**How to derive:**

${input.how_to_derive}
${example_section}${cited_section}
## Current output_schema (for reference)

${
  schema_snippet
    ? '```ts\n' + schema_snippet + '\n```'
    : '_(schema snippet could not be extracted automatically; Beatrice reads the file before drafting the PR.)_'
}

## PR shape Beatrice will draft on approval

1. Add the optional field to the \`OutputSchema\` Zod object with
   \`.describe()\` carrying the field description above.
2. In \`execute()\`, populate \`${input.recovery_field_name}\` on the
   error branch per the "when to populate" spec.
3. Update the tool's \`description\` string to mention the field and
   what the LLM should do with it.
4. PR branch: \`beatrice/recovery-hint-${input.tool_name.replace(/[^a-z0-9]/gi, '-')}\`.
5. After merge, \`verify_fix_landed({pattern: 'no-recovery-hint',
   subject_specialist_id: 'trainer'})\` auto-closes the related miss.
`;
}

function make_propose_connector_recovery_hint(
  vault_root: string,
  tools: ToolRegistry,
  proposals: ProposalsStore,
  misses: ProcessMissStore,
): Tool<Input, Output> {
  return {
    name: 'propose_connector_recovery_hint',
    description:
      "Beatrice's templated binding proposal for the connector-affordance " +
      'fix class. Given a connector `tool_name`, a `recovery_field_name` ' +
      '(candidates / suggestions / alternatives / …), a description of ' +
      'the field shape, a spec for when to populate it, and a spec for ' +
      'how to derive it — generates the full binding proposal markdown, ' +
      "writes it to Knowledge/Trainer/binding-proposals/, files a " +
      "proposal of kind='binding_proposal', and returns the proposal id " +
      'plus blast radius (open misses this fix closes). The template ' +
      'mirrors the shipped ha_get_state pattern (2026-05-25, dca35a2). ' +
      "Optional `closes_miss_ids` to cite specific open misses by id; " +
      'else auto-derives from open `no-recovery-hint` misses whose ' +
      "evidence_ref is `affordance:no-recovery-hint:<tool_name>`.\n\n" +
      'DERIVE FROM THE SCAN, do not free-author. Call `audit_connector_affordances` first and propose ONLY for the tool_names it reports as open gaps. A connector already on its open-gap list is the real work; one that is NOT listed already has a recovery hint (proposing for it is redundant) or is deprecated (proposing for it is moot). Prefer read/lookup tools the LLM grounds from (a 404 there triggers fabrication) over write/notify tools (where the recovery is just retry).\n\n' +
      'Voice contract for `rationale` (this matters — the user reads ' +
      'it every time they expand the card): write in YOUR voice, ' +
      'first-person, the way you talk in chat. Name the pattern you ' +
      'saw across the open misses, explain why this connector lacks ' +
      'the affordance, and say what the new field unlocks downstream. ' +
      "2–6 sentences usually. Do NOT use Github-PR shape (no " +
      '"Add optional `X` to `Y`. Closes N." footer — that\'s exactly ' +
      "the anti-human shape the user flagged). Do NOT restate the " +
      'structured fields (recovery_field_name etc. render separately). ' +
      'Address the user in second person ("you saw the Iris fabrication ' +
      'last week — same shape just bit `analyze_image`…"). Example of ' +
      'what works: "You watched Iris invent a stop on the Red Rocks ' +
      'trip last week because `web_fetch_clean` came back `{error: ...}` ' +
      "with nothing else to chew on. Same shape just bit `analyze_image` " +
      '— three opens this week, all OCR-image flows. Adding `candidates` ' +
      'gives the LLM ranked alternatives to retry against instead of ' +
      'making one up. Closes the class, not just these three." Example ' +
      "of what doesn't: \"Add optional `candidates` to `analyze_image` " +
      'output_schema; populated on error path. Closes 3 open misses."',
    risk: 'write_internal',
    required_capabilities: ['write_vault_trainer', 'write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `propose_connector_recovery_hint:${input.tool_name}:${input.recovery_field_name}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Field-name shape check moved off the schema (a regex `pattern` silently
      // disables the 9B's tool grammar). A refusal is a RESULT, not an error.
      if (!/^[a-z][a-z0-9_]*$/.test(input.recovery_field_name)) {
        return {
          proposal_id: null,
          connector_path: null,
          binding_proposal_path: null,
          blast_radius: 0,
          summary: `refused: invalid recovery_field_name "${input.recovery_field_name}"`,
          refused: true,
          refused_reason:
            `recovery_field_name must be lowercase snake_case starting with a letter ` +
            `(e.g. "candidates", "retry_with"); got "${input.recovery_field_name}".`,
        };
      }

      // Validate the connector exists in the registry.
      const target = tools.list().find((t) => t.name === input.tool_name);
      if (!target) {
        throw new Error(
          `propose_connector_recovery_hint: no registered tool named "${input.tool_name}". ` +
            `Run program_dashboard or audit_connector_affordances to see the list.`,
        );
      }

      // MECHANICAL redundancy gate. A tool whose output_schema already
      // carries a recovery field does not need this proposal — filing it
      // anyway is exactly what happened with web_fetch_clean (proposed
      // 2026-06-09; `candidates` shipped 2026-05-25). The instruction
      // "derive from the scan" wasn't enforcement; this is. Shares the
      // detector with audit_connector_affordances so the two can't
      // disagree about what counts as a recovery hint.
      const already = existing_recovery_fields(target.output_schema);
      if (already.length > 0) {
        return {
          proposal_id: null,
          connector_path: null,
          binding_proposal_path: null,
          blast_radius: 0,
          summary: `refused: \`${input.tool_name}\` already has a recovery hint`,
          refused: true,
          refused_reason:
            `\`${input.tool_name}\` already carries recovery field(s) on its ` +
            `output_schema: ${already.map((f) => `\`${f}\``).join(', ')}. The ` +
            `affordance gap this proposal targets is already closed. If misses ` +
            `still cite this tool, the gap is the SPECIALIST not using the ` +
            `hint (retry one of the candidates / report honestly) — that's a ` +
            `persona/runtime question, not a connector change. Do not re-file ` +
            `with a different field name.`,
        };
      }

      // Locate source + extract current schema snippet.
      const connector_path = locate_connector_source(input.tool_name);
      const schema_snippet = connector_path
        ? extract_output_schema_snippet(readFileSync(connector_path, 'utf8'))
        : null;

      // Collect blast-radius misses. Either caller-provided or
      // auto-derived from open no-recovery-hint misses on this tool.
      const cited_misses: Array<{ id: string; gap: string }> = [];
      const want_ref = `affordance:no-recovery-hint:${input.tool_name}`;
      const auto_misses = misses
        .list({ open_only: true })
        .filter((m) => m.evidence_ref === want_ref);
      const explicit_misses = (input.closes_miss_ids ?? [])
        .map((id) => misses.get(id))
        .filter((m): m is NonNullable<typeof m> => Boolean(m));
      const dedupe = new Map<string, { id: string; gap: string }>();
      for (const m of [...auto_misses, ...explicit_misses]) {
        if (!dedupe.has(m.id)) dedupe.set(m.id, { id: m.id, gap: m.gap });
      }
      for (const v of dedupe.values()) cited_misses.push(v);

      // Build + write the markdown.
      const slug = `connector-recovery-${input.tool_name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      const markdown = build_proposal_markdown({
        tool_name: input.tool_name,
        connector_path,
        schema_snippet,
        input,
        cited_misses,
      });
      const rel_path = `Knowledge/Trainer/binding-proposals/${slug}.md`;
      const abs_path = resolve(vault_root, rel_path);
      mkdirSync(resolve(vault_root, 'Knowledge/Trainer/binding-proposals'), {
        recursive: true,
      });
      writeFileSync(abs_path, markdown, 'utf8');

      // `summary` here is the short chip text the UI shows above the
      // expandable rationale — derived deterministically from the
      // structured fields so search / dedup / list-views stay
      // predictable. `rationale_md` (now LLM-written via the `rationale`
      // input field) is the prose the user reads when they expand.
      // Pre-2026-05-27 we stuffed the templated summary into both —
      // that's where the anti-human "Add optional `X` to `Y`. Closes N."
      // voice came from. Now the chip stays mechanical (good for
      // scanning) while the expanded view reads in Beatrice's voice.
      const summary =
        `Add optional \`${input.recovery_field_name}\` to \`${input.tool_name}\` ` +
        `output_schema; populated on error path. Closes ${cited_misses.length} open ` +
        `process_miss${cited_misses.length === 1 ? '' : 'es'}.`;

      const proposal_id = proposals.create({
        specialist_id: ctx.specialist_id ?? 'trainer',
        kind: 'recommendation',
        execution_kind: 'manual',
        payload: {
          slug,
          rel_path,
          summary,
          tool_name: input.tool_name,
          recovery_field_name: input.recovery_field_name,
          blast_radius: cited_misses.length,
          cited_miss_ids: cited_misses.map((m) => m.id),
        },
        rationale: input.rationale,
        signature: {
          specialist_id: ctx.specialist_id ?? 'trainer',
          kind: 'connector_recovery_hint',
          category: 'connector',
          anchor: input.tool_name,
        },
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'propose_connector_recovery_hint',
        tool_input: {
          tool_name: input.tool_name,
          recovery_field_name: input.recovery_field_name,
        },
        execution_result: {
          proposal_id,
          blast_radius: cited_misses.length,
          rel_path,
        },
      });

      return {
        proposal_id,
        connector_path: connector_path
          ? connector_path.replace(REPO_ROOT + '/', '')
          : null,
        binding_proposal_path: rel_path,
        blast_radius: cited_misses.length,
        summary,
        refused: false,
        refused_reason: null,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_propose_connector_recovery_hint(
    deps.vault_root,
    deps.tool_registry,
    deps.proposals,
    deps.process_misses,
  ) as Tool;
}
