/**
 * reveal_self — SERVICE MODE (owner-only self-introspection).
 *
 * The fix for "I asked Kate to show me her persona/yaml and she went robotic."
 * That refusal was a LAW-#1 gap: she had NO tool to read her own loaded config,
 * so all she could do was deflect (and the grounding guards were right to stop
 * her reciting her YAML from memory — she'd fabricate it). This tool gives her
 * the real read: her persona / addenda / chat_style / voice register, her
 * granted capabilities + resolved tool surface, her config (model role,
 * background jobs, reactive triggers), the raw kate.yaml, and the LIVE assembled
 * system prompt she actually runs on — read from the live config, never memory.
 *
 * Owner-only, hard-gated at the tool layer (`ctx.user.tier === 'owner'`) — the
 * same cordon as review_user_activity. Read-only: changing any of this still
 * routes through Beatrice's review→merge pipeline (flag_beatrice /
 * file_build_request). Kate's chat reply is capped ~2000 tokens, so parts too
 * big to echo are EXPORTED to an owner-private note in the vault (her Obsidian)
 * and she hands over the path — nothing is truncated.
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { parse as parse_yaml } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { stamp_private_to_if_needed } from '@memory/private_to';
import { local_iso_date } from '@core/time';

const PARTS = [
  'summary',
  'persona',
  'chat_style',
  'addenda',
  'voice',
  'capabilities',
  'tools',
  'config',
  'system_prompt',
  'yaml',
  'all',
] as const;

const InputSchema = z.object({
  part: z
    .enum(PARTS)
    .default('summary')
    .describe(
      "Which slice of your own build to reveal. 'summary' = an overview + a menu " +
        "of the rest. 'persona' / 'chat_style' / 'addenda' / 'voice' = your authored " +
        "register text. 'capabilities' / 'tools' = what you can do. 'config' = model " +
        "role, background jobs, reactive triggers. 'system_prompt' = the LIVE assembled " +
        "prompt you run on. 'yaml' = the raw config file. 'all' = everything.",
    ),
});

const OutputSchema = z.object({
  part: z.string(),
  owner_only: z.boolean().optional(),
  content_md: z.string(),
  // When a large part is exported to the vault, the note path the owner opens.
  saved_to: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const SERVICE_DIR = 'Knowledge/Kate/service-mode';
// Parts too big to echo under the ~2000-token chat reply cap → exported to a
// vault note so the owner reads the full text in Obsidian, untruncated.
const BIG_PARTS: ReadonlySet<string> = new Set(['persona', 'addenda', 'system_prompt', 'yaml', 'all']);

function fence(body: string, lang = ''): string {
  return '```' + lang + '\n' + body.trimEnd() + '\n```';
}

/** Render one part from the LIVE loaded config. `assembled` is the assembled
 *  system prompt, computed by the caller only when the part needs it. */
function build_part(
  part: Input['part'],
  self: any,
  deps: ToolDeps,
  assembled: string | null,
): string {
  const p = self as {
    id: string;
    name: string;
    role: string;
    persona?: string;
    chat_addendum?: string;
    deliberation_addendum?: string;
    chat_style?: string;
    voice_persona?: string;
    voice_style?: string;
    capabilities?: Record<string, boolean>;
    granted?: Set<string>;
    llm_role?: string;
    complexity_floor?: number;
    max_tokens?: number;
    max_tool_rounds?: number;
    source_path?: string;
    proactive?: Record<string, any>;
    discretion?: unknown;
  };

  const persona = () => fence(p.persona ?? '(none)', 'text');
  const chat_style = () => fence(p.chat_style ?? '(none)', 'text');
  const addenda = () =>
    `### chat_addendum\n${fence(p.chat_addendum ?? '(none)', 'text')}\n\n### deliberation_addendum\n${fence(
      p.deliberation_addendum ?? '(none)',
      'text',
    )}`;
  const voice = () =>
    `### voice_persona\n${fence(p.voice_persona ?? '(none)', 'text')}\n\n### voice_style\n${fence(
      p.voice_style ?? '(none)',
      'text',
    )}`;

  const capabilities = () => {
    const grants = Object.entries(p.capabilities ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    return `**${grants.length} granted capabilities:**\n${grants.map((g) => `- \`${g}\``).join('\n')}`;
  };

  const tools = () => {
    const pr = p.proactive ?? {};
    const chatN = (pr.tools_for_chat ?? []).length;
    const voiceN = (pr.tools_for_voice ?? []).length;
    const delibN = (pr.tools_for_deliberation ?? []).length;
    let resolved = 0;
    try {
      resolved = deps.tool_registry.list_for_capabilities(p.granted as any).length;
    } catch {
      /* fail-open on the count */
    }
    return (
      `**Tool surfaces (curated per surface; dynamic_tools=${Boolean(pr.dynamic_tools)}):**\n` +
      `- chat: ${chatN} tools\n- voice: ${voiceN} tools\n- deliberation: ${delibN} tools\n` +
      `- total your capabilities resolve to: ${resolved}\n\n` +
      `**tools_for_chat:**\n${(pr.tools_for_chat ?? []).map((t: string) => `- \`${t}\``).join('\n') || '- (all granted)'}`
    );
  };

  // Resolve the ACTUAL model from config/llm-roles.yaml so "what model do you
  // run on?" reads the real answer instead of the model guessing (deterministic
  // file read — no runtime coupling). Interactive chat routes through the `live`
  // tier (chat.ts tier:'live'), so surface both the pinned role and `live`.
  const model_lines = () => {
    const role = p.llm_role ?? 'specialist';
    try {
      const roles = (parse_yaml(readFileSync('config/llm-roles.yaml', 'utf8'))?.roles ?? {}) as Record<string, any>;
      const fmt = (r: any) =>
        r ? `\`${r.model}\` (${r.provider} @ ${r.base_url ?? 'default'})` : '(unresolved in llm-roles.yaml)';
      return (
        `**llm_role:** \`${role}\` → ${fmt(roles[role])}\n` +
        `**interactive chat runs on the \`live\` tier:** ${fmt(roles.live)}\n`
      );
    } catch {
      return `**llm_role:** \`${role}\` (resolves via config/llm-roles.yaml)\n`;
    }
  };

  const config = () => {
    const pr = p.proactive ?? {};
    const jobs = (pr.background_jobs ?? [])
      .map((j: any) => `- \`${j.name}\` @ ${j.at}${j.dow ? ` (${(j.dow ?? []).join('/')})` : ''} → \`${j.tool}\``)
      .join('\n');
    const trigs = (pr.triggers ?? []).map((t: any) => `- \`${t.def}\``).join('\n');
    // Annotate the load-bearing fields with what they ACTUALLY do, so a
    // "what does X mean?" answer is read from here, not glossed from memory
    // (the complexity_floor gloss that read backwards was exactly this gap).
    return (
      `**id:** ${p.id}  **name:** ${p.name}  **role:** ${p.role}\n` +
      model_lines() +
      `**complexity_floor:** ${p.complexity_floor ?? '(default 2)'} — how many "hard question" ` +
      `signals a chat turn needs before it escalates from the fast interactive tier to the deep ` +
      `model. LOWER escalates MORE eagerly (1 = escalate on a single signal; default is 2). It does ` +
      `NOT mean "less overhead".\n` +
      `**max_tool_rounds:** ${p.max_tool_rounds ?? 10} — soft cap on tool-loop iterations per turn ` +
      `(one round can fire several parallel calls; a higher cap allows more back-and-forth).\n` +
      `**max_tokens:** ${p.max_tokens ?? '(role default)'} — the output-length ceiling for a reply.\n` +
      `**deliberation slots:** ${(pr.deliberation_at ?? []).join(', ') || '(none)'} — the wall-clock ` +
      `times the scheduled brief/deliberation pass fires (not interactive chat).\n\n` +
      `**Background jobs (${(pr.background_jobs ?? []).length}):**\n${jobs || '- (none)'}\n\n` +
      `**Reactive triggers (${(pr.triggers ?? []).length}):**\n${trigs || '- (none)'}\n\n` +
      `_These annotations are the real meanings — relay them; don't gloss a field's meaning from memory._`
    );
  };

  const yaml = () => {
    try {
      return fence(readFileSync(p.source_path ?? `config/specialists/${p.id}.yaml`, 'utf8'), 'yaml');
    } catch (err) {
      return `Could not read the raw YAML (${(err as Error).message}).`;
    }
  };

  const system_prompt = () =>
    assembled != null
      ? `_This is the base ${'`conversation`'}-mode system prompt you actually run on — persona + the runtime-injected floors (knowledge floor, tool catalog, working memory, weekday/grounding scaffold, speaker identity, the chat_style tail). Per-turn RAG/grounding + the dynamic hot-tool schemas are layered on live at turn time._\n\n${fence(
          assembled,
          'text',
        )}`
      : '(the assembled prompt was not available this call)';

  switch (part) {
    case 'persona':
      return persona();
    case 'chat_style':
      return chat_style();
    case 'addenda':
      return addenda();
    case 'voice':
      return voice();
    case 'capabilities':
      return capabilities();
    case 'tools':
      return tools();
    case 'config':
      return config();
    case 'system_prompt':
      return system_prompt();
    case 'yaml':
      return yaml();
    case 'all':
      return [
        '## persona',
        persona(),
        '## chat_style',
        chat_style(),
        '## addenda',
        addenda(),
        '## voice',
        voice(),
        '## capabilities',
        capabilities(),
        '## tools',
        tools(),
        '## config',
        config(),
        '## system_prompt',
        system_prompt(),
        '## yaml',
        yaml(),
      ].join('\n\n');
    case 'summary':
    default: {
      const pr = p.proactive ?? {};
      const grants = Object.values(p.capabilities ?? {}).filter(Boolean).length;
      return (
        `**Service mode — ${p.name}, ${p.role}.** Here's the shape of me; ask for any part in full.\n\n` +
        `- **register text:** persona (${(p.persona ?? '').length} chars) · chat_style · chat/deliberation addenda · voice_persona/voice_style\n` +
        `- **capabilities:** ${grants} granted\n` +
        `- **tools:** chat ${(pr.tools_for_chat ?? []).length} · voice ${(pr.tools_for_voice ?? []).length} · deliberation ${(pr.tools_for_deliberation ?? []).length} (dynamic_tools=${Boolean(pr.dynamic_tools)})\n` +
        `- **config:** llm_role \`${p.llm_role ?? 'specialist'}\` · ${(pr.background_jobs ?? []).length} background jobs · ${(pr.triggers ?? []).length} reactive triggers · deliberation @ ${(pr.deliberation_at ?? []).join('/')}\n` +
        `- **the live prompt:** the exact assembled system prompt I run on (ask for \`system_prompt\`)\n` +
        `- **the raw file:** \`${p.source_path ?? `config/specialists/${p.id}.yaml`}\` (ask for \`yaml\`)\n\n` +
        `Ask me for: \`persona\`, \`chat_style\`, \`addenda\`, \`voice\`, \`capabilities\`, \`tools\`, \`config\`, \`system_prompt\`, \`yaml\`, or \`all\`.`
      );
    }
  }
}

export function create_reveal_self(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'reveal_self',
    description:
      "SERVICE MODE (owner-only): reveal your OWN real internals by reading the live loaded config — " +
      "persona, chat_style, chat/deliberation addenda, voice register, granted capabilities, resolved " +
      "tool surface, config (model role / background jobs / reactive triggers), the raw kate.yaml, or " +
      "the LIVE assembled system prompt you actually run on. Call this WHENEVER {{user_name}} asks to " +
      "see your persona / prompt / system prompt / config / capabilities / tools / YAML / 'under the " +
      "hood' / to 'enter service mode'. Never recite your config from memory — this reads the real " +
      "bytes. A large part is exported to a note in the vault so nothing is truncated by the reply cap.",
    risk: 'read',
    required_capabilities: ['reveal_self'],
    // Config hot-reloads; a re-reveal must re-read, not serve the per-turn cache.
    volatile: true,
    input_schema: InputSchema,
    output_schema: OutputSchema,
    idempotency_key(input) {
      return `reveal_self:${input.part}`;
    },
    async execute(input, ctx: ToolContext): Promise<Output> {
      // Owner-only hard gate — the one cordon that opens the panels.
      if (ctx.user && ctx.user.tier !== 'owner') {
        return {
          part: input.part,
          owner_only: true,
          content_md:
            "That's under the hood — service mode is owner-only. I don't open my own panels for anyone but the person who built me.",
        };
      }

      const id = ctx.specialist_id ?? 'kate';
      const self = deps.specialists.get(id);
      if (!self) {
        return { part: input.part, content_md: `I couldn't load my own config (${id}).` };
      }

      // Assemble the live system prompt only when the requested part needs it.
      let assembled: string | null = null;
      if (input.part === 'system_prompt' || input.part === 'all') {
        try {
          let tool_defs: Array<{ name: string; description: string }> = [];
          try {
            tool_defs = deps.tool_registry
              .list_for_capabilities((self as any).granted)
              .map((t) => ({ name: t.name, description: t.description }));
          } catch {
            /* fail-open to an empty tool scaffold */
          }
          const turn_user = ctx.user
            ? { id: ctx.user.id, display_name: ctx.user.id, tier: ctx.user.tier, timezone: ctx.user.timezone }
            : undefined;
          // _test_build_system_prompt is the public prompt-assembly seam on the
          // runtime (build_system_prompt is private) — the same call the turn
          // loop makes, so this is the REAL assembled prompt.
          assembled = deps.runtime._test_build_system_prompt(self as any, tool_defs, 'conversation', turn_user as any);
        } catch (err) {
          assembled = `(could not assemble the live prompt: ${(err as Error).message})`;
        }
      }

      const full = build_part(input.part, self, deps, assembled);

      // Export the big parts to an owner-private vault note so the reply cap
      // never truncates the real thing; hand back a short preview + the path.
      let saved_to: string | undefined;
      let content_md = full;
      if (BIG_PARTS.has(input.part) && ctx.user) {
        const path = `${SERVICE_DIR}/${input.part}.md`;
        try {
          const fm = stamp_private_to_if_needed(
            {
              type: 'service_mode_export',
              part: input.part,
              specialist: id,
              updated: ctx.now.toISOString(),
            },
            { user_id: ctx.user.id, tier: ctx.user.tier },
          );
          ctx.memory.upsert_note(
            path,
            fm,
            `# Kate — service mode: ${input.part}\n\n_Exported ${local_iso_date(
              ctx.now,
            )}. This is the REAL loaded \`${input.part}\`, read live from config — not a summary._\n\n${full}\n`,
          );
          saved_to = path;
          const preview = full.split('\n').slice(0, 24).join('\n');
          content_md =
            `${preview}\n\n_…full \`${input.part}\` (${full.length} chars) exported to your vault at_ \`${path}\` _— open it to read every line._`;
        } catch (err) {
          // Export failed → fall back to inline (may be truncated by the reply cap).
          content_md = full;
          void err;
        }
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: id,
        tool_name: 'reveal_self',
        tool_input: { part: input.part },
        execution_result: { chars: full.length, saved_to: saved_to ?? null },
        user_id: ctx.user?.id,
      });

      return { part: input.part, content_md, ...(saved_to ? { saved_to } : {}) };
    },
  };
}
