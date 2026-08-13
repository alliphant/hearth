/**
 * scaffold_code — exact-idiom skeletons for the things Beatrice builds.
 *
 * The 35B authors reliably ONLY from inlined exact shapes (directed-build
 * lesson, 2026-06): asked to write "a tool like the others" from memory it
 * hallucinates a fake SDK. This tool makes generation fill-in-the-blanks —
 * it emits the CURRENT repo idiom (Tool<I,O> contract, ToolDeps create()
 * entry point, recovery-hint output field, sha256 idempotency key, the
 * registration checklist from the private dev log) with __PLACEHOLDER__ markers, so
 * the model's job shrinks to domain logic. Deterministic templates, no LLM.
 *
 * Each kind also names the live exemplar file to imitate when the template
 * isn't enough — read it with read_codebase_file, don't reinvent.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const KINDS = ['specialist_tool', 'connector', 'intake_handler', 'app_route', 'specialist_yaml'] as const;

const InputSchema = z.object({
  kind: z.enum(KINDS),
  /** snake_case name for the artifact (tool name, connector name, specialist id).
   *  NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
   *  interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
   *  and SILENTLY disables the whole tool grammar. The snake_case shape is
   *  validated in execute() instead. */
  name: z
    .string()
    .min(2)
    .max(60)
    .describe('snake_case name for the artifact, e.g. "track_listing".'),
  /** Owning specialist id (for specialist_tool / intake_handler paths). */
  specialist_id: z.string().max(40).optional(),
});

const OutputSchema = z.object({
  kind: z.string(),
  path_suggestion: z.string(),
  skeleton: z.string(),
  registration_steps: z.array(z.string()),
  exemplar: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const BT = '`';

function tool_skeleton(name: string): string {
  return [
    '/**',
    ` * ${name} — __ONE_LINE_PURPOSE__`,
    ' */',
    "import { z } from 'zod';",
    "import { createHash } from 'node:crypto';",
    "import type { Tool, ToolContext } from '@core/tool';",
    "import type { ToolDeps } from '@core/tool_deps';",
    '',
    'const InputSchema = z.object({',
    '  // Required fields MUST be values the model can produce from the',
    '  // conversation (the private dev log "arg-spiral" rules). Anything the tool can',
    '  // fetch or derive from a store belongs INSIDE execute, not here.',
    '  query: z.string().min(1).max(500),',
    '});',
    '',
    'const OutputSchema = z.object({',
    '  ok: z.boolean(),',
    '  error: z.string().optional(),',
    '  // Recovery hint — POPULATED ON THE ERROR PATH (the connector',
    '  // affordance pattern). Required on any tool that can return error;',
    '  // audit_connector_affordances flags the gap otherwise.',
    '  candidates: z.array(z.string()).optional(),',
    '});',
    '',
    'type Input = z.infer<typeof InputSchema>;',
    'type Output = z.infer<typeof OutputSchema>;',
    '',
    `export function make_${name}(deps: ToolDeps): Tool<Input, Output> {`,
    '  return {',
    `    name: '${name}',`,
    "    description: '__LLM_FACING: what it does, when to reach for it, what comes back. This is what the planner sees.__',",
    "    risk: 'read', // read | write_internal | send_external | spend_money",
    "    required_capabilities: ['__CAPABILITY_TOKEN__'],",
    '    input_schema: InputSchema,',
    '    output_schema: OutputSchema,',
    '',
    '    idempotency_key(input) {',
    "      const h = createHash('sha256');",
    '      h.update(input.query);',
    `      return '${name}:' + h.digest('hex').slice(0, 16);`,
    '    },',
    '',
    '    async execute(input, ctx: ToolContext): Promise<Output> {',
    '      // ctx.user?.id is the ambient caller — NEVER require user_id as a',
    '      // model-supplied input. Audit external effects via',
    '      // ctx.memory.log_action({ intent_id: ctx.intent_id, ... }).',
    '      return { ok: true };',
    '    },',
    '  };',
    '}',
    '',
    '/** ToolLoader entry point. */',
    'export function create(deps: ToolDeps): Tool {',
    `  return make_${name}(deps) as Tool;`,
    '}',
    '',
  ].join('\n');
}

function intake_skeleton(name: string, specialist: string): string {
  return [
    '/**',
    ` * intake_${name} — ${specialist}'s intake handler for routed __SHAPE__ captures.`,
    ' *',
    ' * Fired by ReactiveInboxDriver when Cordelia routes a capture here and',
    ` * ${specialist}'s YAML sets proactive.intake_captures: true. NOT loaded by`,
    ' * ToolLoader (lives under intake/, not tools/) — imported explicitly by',
    ' * the orchestrator and registered via reactive_inbox.register_intake.',
    ' */',
    "import type { IntakeHandlerInput } from '@core/reactive_inbox';",
    '',
    `export async function intake_${name}(input: IntakeHandlerInput): Promise<void> {`,
    '  // input carries: capture_id, user_id, note_path, attachment_path,',
    '  // decision (the routing decision incl. extracted_payload), memory, db,',
    '  // llm, inbox, conversations, runtime. Read the capture signals from',
    '  // decision.extracted_payload; file domain artifacts via input.memory;',
    '  // FYI the user via input.inbox.push when something needs attention.',
    '}',
    '',
  ].join('\n');
}

function route_skeleton(name: string): string {
  return [
    `// __NAMESPACE__ route — mount via app.route('/api/${name}', r) in the`,
    '// orchestrator (or extend an existing sub-router). Conventions:',
    '// safeParse the body FIRST, ULID intent_id, audit before returning,',
    "// success body { intent_id, audit_id, ...result }, errors { error }.",
    '// 4xx input, 403 gate-denied, 5xx unexpected.',
    '//',
    '// ⚠ A NEW top-level /api/<namespace>/ needs the nginx alternation on',
    "// the LLM host (/docker/nginx/locations.conf + docker restart nginx) or it",
    '// falls through to Home Assistant and 404s (the private dev log "API mount topology").',
    "import { Hono } from 'hono';",
    "import { z } from 'zod';",
    "import { ulid } from 'ulid';",
    '',
    'const BodySchema = z.object({',
    '  // __FIELDS__',
    '});',
    '',
    'export function __make_router__(deps: { /* memory, db, events, … */ }): Hono {',
    '  const r = new Hono({ strict: false });',
    '',
    `  r.post('/', async (c) => {`,
    '    let raw: unknown;',
    '    try {',
    '      raw = await c.req.json();',
    '    } catch (err) {',
    '      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);',
    '    }',
    '    const parsed = BodySchema.safeParse(raw);',
    '    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);',
    '    const intent_id = ulid();',
    '    // __DO_THE_WORK__; audit via deps.memory.log_action({ intent_id, ... });',
    "    // emit the right AppEvent AFTER the DB write succeeds (the private dev log SSE rule).",
    '    return c.json({ intent_id });',
    '  });',
    '',
    '  return r;',
    '}',
    '',
  ].join('\n');
}

function yaml_skeleton(id: string): string {
  return [
    `id: ${id}`,
    'name: __DisplayName__',
    'role: __One-line role__',
    'voice: warm-direct  # one of the warm-* enum in specialist.ts',
    'llm_role: specialist',
    '',
    'knowledge_scope:',
    `  - Knowledge/__DisplayName__/**`,
    '',
    'capabilities:',
    '  read_vault: true',
    '  read_inbox: true',
    '  # Grant ONLY what the workflows need — every granted tool the persona',
    '  # never mentions is a dead grant (run the capability-visibility scan).',
    '',
    'proactive:',
    '  mode: passive  # active requires an awareness handler in src/specialists/awareness/',
    '  # deliberation_at: ["07:30"]',
    '  # tools_for_chat: []   # curate when grants resolve to >~15 tools',
    '  # research_workload: true  # only if 2+ external lookups + synthesis is typical',
    '',
    'persona: |',
    '  __Core identity, always-true posture. Mode-specific material goes in',
    '  chat_addendum / deliberation_addendum (the private dev log persona split).__',
    '',
  ].join('\n');
}

const STEPS: Record<(typeof KINDS)[number], (n: string, s: string) => string[]> = {
  specialist_tool: (n, s) => [
    `Write the file at src/specialists/${s}/tools/${n}.ts — ToolLoader auto-registers anything under tools/.`,
    `The capability token must exist in src/core/capabilities.ts AND be granted in config/specialists/${s}.yaml (granted-but-undeclared tokens are a BOOT-FAILURE class — never duplicate an existing token).`,
    `If ${s} curates tools_for_chat / tools_for_deliberation, add '${n}' to the right surface — a curated list silently EXCLUDES anything not named (the private dev log capability-visibility scan, steps 1-4).`,
    `Mention the tool in the persona/addendum so the model knows when to reach for it.`,
    `Extend the owning smoke with a case for '${n}'.`,
  ],
  connector: (n) => [
    `Write the file at src/connectors/${n}.ts.`,
    `Register in apps/orchestrator/server.ts's wiring block: tool_registry.register(${n}_tool as Tool) — connectors are NOT auto-scanned.`,
    `On the error path populate the recovery field (candidates/...) — audit_connector_affordances opens a miss for bare-error connectors.`,
    `Add a smoke case (smoke:connectors skips per-tool when env is unset — follow that pattern for optional infra).`,
  ],
  intake_handler: (n, s) => [
    `Write the file at src/specialists/${s}/intake/intake_${n}.ts (intake/ is NOT ToolLoader-scanned).`,
    `Import + register in apps/orchestrator/server.ts: reactive_inbox.register_intake('${s}', intake_${n}).`,
    `Set proactive.intake_captures: true on config/specialists/${s}.yaml.`,
    `Add a case to scripts/smoke-visual-pipeline.ts asserting the new artifact lands.`,
  ],
  app_route: (n) => [
    `Mount the router in apps/orchestrator/server.ts (or extend the owning sub-router under src/app/routes/).`,
    `Emit the right AppEvent after the DB write (events are how the UI stays live).`,
    `If this is a NEW top-level /api/${n}/ namespace: add it to the nginx alternation on the LLM host (/docker/nginx/locations.conf, then docker restart nginx) or external clients 404.`,
    `Add a smoke (in-process router mount is the established pattern — see smoke:presence).`,
  ],
  specialist_yaml: (n) => [
    `Write config/specialists/${n}.yaml — SpecialistRegistry hot-reloads it (no restart).`,
    `Run ${BT}bun run init:vault${BT} to scaffold Knowledge/<Name>/ namespaces (idempotent).`,
    `proactive.mode: active REQUIRES an awareness handler in src/specialists/awareness/${n}.ts wired via loop_driver.register_awareness — without it the loop is a no-op.`,
    `Run the capability-visibility scan (the private dev log): every granted capability must be surfaced AND mentioned, or it's a dead grant.`,
    `Curate tools_for_chat if grants resolve to >~15 tools (the args-fumble wall).`,
  ],
};

const EXEMPLARS: Record<(typeof KINDS)[number], string> = {
  specialist_tool: 'src/specialists/kate/tools/flag_beatrice.ts',
  connector: 'src/connectors/weather.ts',
  intake_handler: 'src/specialists/vivian/intake/intake_receipt.ts',
  app_route: 'src/app/routes/presence.ts',
  specialist_yaml: 'config/specialists/ruby.yaml',
};

export const scaffold_code_tool: Tool<Input, Output> = {
  name: 'scaffold_code',
  description:
    'Emit the exact current-repo skeleton for a new artifact: specialist_tool, connector, ' +
    'intake_handler, app_route, or specialist_yaml. Returns the file skeleton (replace the ' +
    '__PLACEHOLDER__ markers with domain logic), the path to write it at, the registration ' +
    'checklist, and the live exemplar file to imitate for anything the template leaves ' +
    'open. ALWAYS start a build from this — never author the contract shape from memory.',
  risk: 'read',
  required_capabilities: ['read_codebase'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `scaffold_code:${input.kind}:${input.name}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    // Name-shape check moved off the schema (a regex `pattern` silently disables
    // the 9B's tool grammar). The name lands in the suggested file path.
    if (!/^[a-z][a-z0-9_]*$/.test(input.name)) {
      throw new Error(
        `name must be lowercase snake_case — a letter, then letters/digits/` +
          `underscores (e.g. "track_listing"); got "${input.name}".`,
      );
    }
    const s = input.specialist_id ?? '__SPECIALIST_ID__';
    let path_suggestion: string;
    let skeleton: string;
    switch (input.kind) {
      case 'specialist_tool':
        path_suggestion = `src/specialists/${s}/tools/${input.name}.ts`;
        skeleton = tool_skeleton(input.name);
        break;
      case 'connector':
        path_suggestion = `src/connectors/${input.name}.ts`;
        skeleton = tool_skeleton(input.name);
        break;
      case 'intake_handler':
        path_suggestion = `src/specialists/${s}/intake/intake_${input.name}.ts`;
        skeleton = intake_skeleton(input.name, s);
        break;
      case 'app_route':
        path_suggestion = `src/app/routes/${input.name}.ts`;
        skeleton = route_skeleton(input.name);
        break;
      case 'specialist_yaml':
        path_suggestion = `config/specialists/${input.name}.yaml`;
        skeleton = yaml_skeleton(input.name);
        break;
    }
    return {
      kind: input.kind,
      path_suggestion,
      skeleton,
      registration_steps: STEPS[input.kind](input.name, s),
      exemplar: EXEMPLARS[input.kind],
    };
  },
};

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return scaffold_code_tool as Tool;
}
