/**
 * Hiring a new specialist.
 *
 * Two ways in:
 *
 *  - `POST /` — the modal flow. A form's worth of fields straight to a
 *    `config/specialists/<id>.yaml` file, with Kate generating the
 *    persona when one isn't supplied.
 *  - `POST /from-packet` — the agentic flow. Kate's `propose_hire` tool
 *    files a hiring packet as a Proposal; once Jasper approves it, this
 *    endpoint reads the packet back, materializes the specialist with
 *    its day-1 capabilities, and flags the build queue to Beatrice.
 *
 * Both paths share `materialize_specialist` — the YAML write, namespace
 * bootstrap, and registry reload.
 */

import { Hono } from 'hono';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { LoadedSpecialist, SpecialistRegistry } from '@core/specialist';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { ProposalsStore } from '@core/proposals';
import type { SpecialistInbox } from '@memory/stores/conversations';
import { to_turn_user } from '@core/users';
import type { AppEventBus } from '@app/events';
import { type Capability, is_capability } from '@core/capabilities';
import { HiringPacketSchema, VoiceEnum, draft_persona_validated } from '@core/hiring';

// Capabilities that are hard-locked off for hires made through the UI — to
// turn these on, you edit the YAML by hand. Safety rail.
const UI_HIRE_LOCKED: Capability[] = [
  'web_action',
  'send_email',
  'send_sms',
  'spend_money',
  'write_home_assistant',
];

export interface HireRoutesDeps {
  specialists_dir: string;
  vault_root: string;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  proposals: ProposalsStore;
  inbox: SpecialistInbox;
  /**
   * Optional. When present, build-queue flags emit an
   * `inbox_message_added` event with `severity: 'high'` so Beatrice's
   * `wake_on_flag: true` setting fires her deliberation immediately
   * instead of waiting for her next scheduled 03:00 slot. Without the
   * event the inbox row is stored but no wake fires — and a brand-new
   * hire's build queue sits idle for up to ~24h. Optional so
   * smoke-hiring.ts can construct deps without the bus.
   */
  events?: AppEventBus;
}

const HireSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'id must be lowercase snake_case'),
  name: z.string().min(1),
  role: z.string().min(1),
  avatar: z.string().optional(),
  voice: VoiceEnum,
  description: z.string().min(10).max(2000),
  knowledge_scope: z.array(z.string()).default([]),
  capabilities: z.record(z.string(), z.boolean()).default({}),
  proactive: z.object({
    mode: z.enum(['active', 'batched', 'reactive']),
    awareness_hz: z.number().positive().optional(),
    deliberation_at: z.array(z.string().regex(/^\d{2}:\d{2}$/)).optional(),
    interrupt_threshold: z.enum(['low', 'medium', 'medium-high', 'high']).optional(),
  }),
  /** Pre-generated persona text. When omitted, we'll have Kate generate it. */
  persona: z.string().optional(),
});

function capitalize_id(spec_id: string): string {
  return spec_id.charAt(0).toUpperCase() + spec_id.slice(1);
}

function bootstrap_namespace(
  vault_root: string,
  spec_id: string,
  display: string,
): void {
  // Knowledge/<CapitalizedId>/ — matches the convention used by every
  // other write site (memory_files.ts, loops.ts, library.ts). Stable
  // across rename of the display name; safe filename across platforms.
  const home = resolve(vault_root, 'Knowledge', capitalize_id(spec_id));
  mkdirSync(resolve(home, 'skills'), { recursive: true });
  mkdirSync(resolve(home, 'library', '_attachments'), { recursive: true });
  const mem = resolve(home, 'memory.md');
  if (!existsSync(mem)) {
    writeFileSync(
      mem,
      `# ${display}'s memory\n\n` +
        `Long-term observations live here. Dated entries; ${display} appends ` +
        `via her memory-write tool.\n\n` +
        `<!-- entries below -->\n`,
      'utf8',
    );
  }
}

/**
 * Write the specialist's YAML, bootstrap their vault namespace, and
 * reload the registry. Shared by the modal POST and the from-packet
 * flow. Applies the UI-hire capability lock and the always-on defaults.
 * Throws if the specialist isn't visible after the reload.
 */

// On-hire knowledge bootstrap lives in src/core/specialist_bootstrap.ts
// and fires structurally on every newly-discovered specialist via
// SpecialistRegistry.on_specialist_added — so it covers this modal
// hire, /from-packet, AND direct YAML writes (the path that landed
// Ruby empty-shelved on 2026-05-30 and surfaced the gap). Both hire
// routes here just call materialize_specialist; the bootstrap is no
// longer their responsibility to invoke.

function materialize_specialist(
  deps: HireRoutesDeps,
  spec: {
    id: string;
    name: string;
    role: string;
    voice: z.infer<typeof VoiceEnum>;
    persona: string;
    knowledge_scope: string[];
    capabilities: Record<string, boolean>;
    proactive: unknown;
    avatar?: string;
  },
): LoadedSpecialist {
  // Hard-locked capabilities are forced off no matter who asked — to
  // grant one you edit the YAML by hand. Then apply the defaults every
  // specialist should have.
  const caps: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(spec.capabilities)) {
    caps[k] = UI_HIRE_LOCKED.includes(k as Capability) ? false : v;
  }
  if (caps.read_vault === undefined) caps.read_vault = true;
  if (caps.write_proposals === undefined) caps.write_proposals = true;
  if (caps.query_web === undefined) caps.query_web = true;

  const yaml_obj: Record<string, unknown> = {
    id: spec.id,
    name: spec.name,
    role: spec.role,
    voice: spec.voice,
    knowledge_scope:
      spec.knowledge_scope.length > 0
        ? spec.knowledge_scope
        : [`Knowledge/${capitalize_id(spec.id)}/**`],
    capabilities: caps,
    proactive: spec.proactive,
    persona: spec.persona,
  };
  if (spec.avatar) yaml_obj.avatar = spec.avatar;

  const yaml_text = stringifyYaml(yaml_obj, { lineWidth: 0 });
  const yaml_path = resolve(deps.specialists_dir, `${spec.id}.yaml`);

  // Atomic write: write to .tmp then rename.
  const tmp = `${yaml_path}.tmp.${Date.now()}`;
  writeFileSync(tmp, yaml_text, 'utf8');
  renameSync(tmp, yaml_path);

  bootstrap_namespace(deps.vault_root, spec.id, spec.name);

  // Force reload — chokidar will pick it up too, but reload() is synchronous.
  deps.specialists.reload();

  const created = deps.specialists.get(spec.id);
  if (!created) {
    throw new Error(`specialist not visible after reload — check ${yaml_path}`);
  }
  return created;
}

async function generate_persona(
  runtime: SpecialistRuntime,
  draft: z.infer<typeof HireSchema>,
  user: import('@core/users').TurnUser | undefined,
): Promise<string> {
  // Use Kate as the "HR" specialist for hires. If Kate isn't loaded
  // (somehow), fall back to a templated persona.
  if (!runtime.get('kate')) {
    return (
      `You are ${draft.name}, the household's new ${draft.role}.\n\n` +
      `${draft.description}\n\n` +
      `Voice: ${draft.voice}. You know nothing yet — the user will add ` +
      `materials to your library and you will get up to speed.`
    );
  }
  const prompt =
    `We're hiring a new specialist. Please draft their persona in the voice family "${draft.voice}". ` +
    `Keep it 150-300 words, written in second-person ("You are ${draft.name}..."). ` +
    `It should feel like a coherent staff member, not a tool. Capture warmth, ` +
    `competence, and the specifics of their domain. Avoid bullet lists; prose only.\n\n` +
    `Name: ${draft.name}\n` +
    `Role: ${draft.role}\n` +
    `Description of the role from Jasper: ${draft.description}\n\n` +
    `Output ONLY the persona text — no preamble, no closing remark.`;
  // Same shape gate as Kate's propose_hire: a turn that returns reasoning
  // prose or conversational preamble instead of the persona retries once
  // with a corrective nudge, then lands on the deterministic template.
  return draft_persona_validated({
    name: draft.name,
    log_label: 'hire',
    fallback:
      `You are ${draft.name}, the household's new ${draft.role}.\n\n` +
      `${draft.description}\n\n` +
      `Voice: ${draft.voice}.`,
    attempt: async (retry_nudge) => {
      const out = await runtime.turn({
        specialist_id: 'kate',
        conversation_id: `hire:${draft.id}`,
        message: {
          role: 'user',
          content: retry_nudge ? `${prompt}\n\n${retry_nudge}` : prompt,
        },
        conversation_history: [],
        // Phase 2b — hiring is an owner-only operation by design.
        // Caller threaded through so Kate's discretion block renders
        // correctly (typically empty for owner).
        user,
      });
      return out.message_text;
    },
  });
}

export function create_hire_router(deps: HireRoutesDeps): Hono {
  const r = new Hono();

  r.post('/', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = HireSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    if (deps.specialists.has(parsed.data.id)) {
      return c.json({ error: `specialist already exists: ${parsed.data.id}` }, 409);
    }

    // Validate every requested capability token before we touch disk.
    const caps: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed.data.capabilities)) {
      if (!is_capability(k)) {
        return c.json({ error: `unknown capability: ${k}` }, 400);
      }
      caps[k] = v;
    }

    const persona =
      parsed.data.persona ?? (await generate_persona(deps.runtime, parsed.data, to_turn_user(c.get('user'), c.get('user_tz'))));

    let created: LoadedSpecialist;
    try {
      created = materialize_specialist(deps, {
        id: parsed.data.id,
        name: parsed.data.name,
        role: parsed.data.role,
        voice: parsed.data.voice,
        persona,
        knowledge_scope: parsed.data.knowledge_scope,
        capabilities: caps,
        proactive: parsed.data.proactive,
        avatar: parsed.data.avatar,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }

    return c.json({
      id: created.id,
      name: created.name,
      role: created.role,
      avatar: created.avatar ?? null,
      voice: created.voice,
      default_landing: created.default_landing,
      yaml_path: `config/specialists/${created.id}.yaml`,
      persona_preview: persona.slice(0, 300),
    });
  });

  // The agentic path: materialize a specialist from an approved hiring
  // packet (a Proposal filed by Kate's propose_hire tool).
  r.post('/from-packet', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const body = z.object({ proposal_id: z.string().min(1) }).safeParse(raw);
    if (!body.success) return c.json({ error: body.error.message }, 400);

    const proposal = deps.proposals.get(body.data.proposal_id);
    if (!proposal) {
      return c.json({ error: `unknown proposal: ${body.data.proposal_id}` }, 404);
    }
    // Accept `approved` AND the terminal `acknowledged` (a manual proposal the
    // decide route / boot triage stamped resolved) — both mean "the owner
    // approved this packet." materialize_specialist + record_execution below
    // then move it to `executed`. Anything else (pending/denied/executed) is a
    // not-yet- or already-handled packet.
    if (proposal.status !== 'approved' && proposal.status !== 'acknowledged') {
      return c.json(
        {
          error:
            `proposal ${proposal.id} is "${proposal.status}", not "approved" — ` +
            `approve the hiring packet first`,
        },
        409,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(proposal.payload_json);
    } catch {
      return c.json({ error: `proposal ${proposal.id} has an unreadable payload` }, 400);
    }
    const packet = HiringPacketSchema.safeParse(payload);
    if (!packet.success) {
      return c.json(
        { error: `proposal ${proposal.id} is not a hiring packet: ${packet.error.message}` },
        400,
      );
    }
    const spec = packet.data.specialist;
    if (deps.specialists.has(spec.id)) {
      return c.json({ error: `specialist already exists: ${spec.id}` }, 409);
    }

    const caps: Record<string, boolean> = {};
    for (const token of packet.data.day_1_capabilities) caps[token] = true;

    let created: LoadedSpecialist;
    try {
      created = materialize_specialist(deps, {
        id: spec.id,
        name: spec.name,
        role: spec.role,
        voice: spec.voice,
        persona: spec.persona,
        knowledge_scope: spec.knowledge_scope,
        capabilities: caps,
        proactive: spec.proactive,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }

    // Flag the build queue to Beatrice — each capability that still
    // needs a tool built before the new hire can be granted it.
    // Emit `inbox_message_added` with `severity: 'high'` so Beatrice's
    // `wake_on_flag: true` fires her deliberation immediately — without
    // this the build queue sits idle for up to ~24h waiting for her
    // 03:00 slot. Severity is `high` because a new-hire build queue is
    // by definition load-bearing (the specialist can't do their day-1
    // work until at least one of these capabilities exists).
    for (const item of packet.data.build_queue) {
      const inbox_id = deps.inbox.push({
        from_specialist_id: 'kate',
        to_specialist_id: 'trainer',
        kind: 'flag',
        body_md:
          `**New tool needed** for new hire ${created.name} (\`${created.id}\`).\n\n` +
          `**Capability:** \`${item.capability}\`\n${item.why}\n\n` +
          `Build the tool (and register the capability token) so ` +
          `${created.name} can be granted \`${item.capability}\`.`,
      });
      deps.events?.emit({
        type: 'inbox_message_added',
        message_id: inbox_id,
        from_specialist_id: 'kate',
        to_specialist_id: 'trainer',
        kind: 'flag',
        severity: 'high',
      });
    }

    // On-hire knowledge bootstrap fired automatically via
    // SpecialistRegistry.on_specialist_added → bootstrap_new_specialist
    // when materialize_specialist's reload() picked up the new YAML.
    // Nothing to do here.

    deps.proposals.record_execution(proposal.id, {
      specialist_id: created.id,
      day_1_capabilities: packet.data.day_1_capabilities,
      build_queue: packet.data.build_queue.map((b) => b.capability),
    });

    return c.json({
      id: created.id,
      name: created.name,
      role: created.role,
      day_1_capabilities: packet.data.day_1_capabilities,
      build_queue_flagged: packet.data.build_queue.length,
    });
  });

  // Preview the generated persona without writing anything — used by Step 5
  // of the hiring modal so the user can see what Kate proposed and edit it.
  r.post('/preview-persona', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = HireSchema.partial({ persona: true })
      .extend({
        name: z.string(),
        role: z.string(),
        description: z.string(),
        voice: VoiceEnum,
        id: z.string().default('preview'),
        proactive: z
          .object({
            mode: z.enum(['active', 'batched', 'reactive']),
            awareness_hz: z.number().positive().optional(),
            deliberation_at: z.array(z.string()).optional(),
            interrupt_threshold: z.string().optional(),
          })
          .default({ mode: 'reactive' }),
      })
      .safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const persona = await generate_persona(deps.runtime, parsed.data as never, to_turn_user(c.get('user'), c.get('user_tz')));
    return c.json({ persona });
  });

  // Delete a specialist: removes their YAML and forces a reload. Used by
  // the smoke for cleanup; could also back a future "let go" UI. Does NOT
  // remove the specialist's vault namespace — those files are user data.
  r.delete('/:id', (c) => {
    const id = c.req.param('id');
    const spec = deps.specialists.get(id);
    if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);
    try {
      rmSync(spec.source_path);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
    deps.specialists.reload();
    return c.json({ id, deleted: true });
  });

  // For convenience the modal can also read an existing config (read-only).
  r.get('/:id/yaml', (c) => {
    const id = c.req.param('id');
    const spec = deps.specialists.get(id);
    if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);
    try {
      const text = readFileSync(spec.source_path, 'utf8');
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  return r;
}
