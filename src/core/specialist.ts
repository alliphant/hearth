/**
 * Specialist configuration: schema, loader, and watcher.
 *
 * Each specialist lives in `config/specialists/<id>.yaml`. The runtime
 * instantiates them from config at boot and hot-reloads on file change via
 * chokidar. Personas are validated by Zod so a malformed YAML fails loudly
 * at load time rather than silently degrading the LLM call.
 *
 * Specialists are NOT agents — they're personas with a `knowledge_scope`
 * filter (which vault paths they can read from when answering) and a
 * `capabilities` set (which tools they can invoke). See architecture.md
 * "The specialist abstraction" for the design.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  type Capability,
  granted_set,
  is_capability,
  all_capabilities,
} from './capabilities';
import { get_household_context, substitute, DEFERRED_PERSONA_TOKENS } from './household';
import { TierEnum } from './users';

const VoiceEnum = z.enum([
  'warm',
  'warm-direct',
  'warm-precise',
  'warm-encyclopedic',
  'warm-archival',
  'warm-technical',
  'warm-vigilant',
]);

const InterruptThresholdEnum = z.enum(['low', 'medium', 'medium-high', 'high']);

/**
 * Match a clock spec like "07:00" or "*:15" — exact HH and MM, or `*`
 * as a wildcard on either side. "*:15" = hourly at :15; "03:00" = once
 * a day at 3 AM; "*:*" = every minute (use carefully).
 */
const ClockSpec = z
  .string()
  .regex(/^(\*|\d{1,2}):(\*|\d{1,2})$/, 'time must be HH:MM, with * allowed for hour or minute');

/** Lowercase short weekday names, indexed to match JS `Date.getDay()`
 *  (0 = Sunday … 6 = Saturday) so a `dow` gate is a plain index lookup. */
const DowEnum = z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/**
 * Background job declaration. Fires at every minute matching `at`,
 * invoking `tool` with optional static `input`. Specialists declare
 * these in their YAML; LoopDriver runs them on the same 60-second
 * tick as deliberation, audited natively through the tool registry.
 *
 * `dow` restricts a job to specific weekdays (e.g. a WEEKLY analyst
 * sweep that runs only on Monday) — omit for the default every-day
 * cadence. It composes with `at`: the job fires only when BOTH the
 * clock spec matches AND today is one of the listed days.
 *
 * `dom_max` restricts a job to the first N days of the month (local
 * day-of-month ≤ dom_max). Composes with `dow` to express "first
 * <weekday> of the month": `dow:["mon"], dom_max:7` = the FIRST
 * Monday (a Monday can only fall on days 1-7 once a month). E.g. a
 * monthly emergency-alert drill.
 */
export const BackgroundJobSchema = z
  .object({
    name: z.string().min(1).max(80),
    at: ClockSpec,
    tool: z.string().min(1).max(80),
    input: z.record(z.string(), z.unknown()).optional(),
    dow: z
      .array(DowEnum)
      .min(1)
      .optional()
      .describe('Restrict to these weekdays (local). Omit = every day. e.g. ["mon"] for a weekly job.'),
    dom_max: z
      .number()
      .int()
      .min(1)
      .max(31)
      .optional()
      .describe('Only run when the local day-of-month ≤ this. With dow:["mon"], dom_max:7 = the first Monday of the month (a monthly job).'),
  })
  .strict();

/**
 * A reactive trigger subscription (2026-06-18). Declares that this
 * specialist's deliberation should WAKE off-schedule when a real-world
 * event occurs — the event-driven counterpart to `deliberation_at`'s
 * fixed clock. `def` names a code-registered TriggerDef
 * ([src/core/reactive_triggers.ts](reactive_triggers.ts)) that owns the
 * matching + edge-detection; the YAML stays declarative (no expression
 * eval). `task` is the scoped framing the woken pass receives ("you were
 * woken because X — handle just this").
 *
 * Fires through `LoopDriver.wake_deliberation_scoped`, which debounces +
 * rate-limits, so a burst collapses to one pass and a still-true condition
 * can't re-fire inside `min_interval_ms`. `params` is the def's optional
 * config (e.g. a threshold). Empty/omitted (the default) = no reactive
 * triggers; the specialist's scheduled cadence is unchanged. Gated
 * process-wide by `HEARTH_REACTIVE_TRIGGERS` (kill switch).
 */
const TriggerSubscriptionSchema = z
  .object({
    def: z.string().min(1).max(80),
    task: z.string().min(1).max(400),
    params: z.record(z.string(), z.unknown()).optional(),
    debounce_ms: z.number().int().positive().max(600_000).optional(),
    min_interval_ms: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict();

export type TriggerSubscription = z.infer<typeof TriggerSubscriptionSchema>;

const ProactiveSchema = z
  .object({
    mode: z.enum(['active', 'batched', 'reactive']),
    awareness_hz: z.number().positive().optional(),
    deliberation_at: z
      .array(z.string().regex(/^\d{2}:\d{2}$/))
      .optional(),
    // Restrict the deliberation_at slots to specific LOCAL weekdays —
    // the deliberation analogue of a background job's `dow`. Omit for
    // the default every-day cadence. A weekly specialist (Luna's Monday
    // house sweep) sets e.g. ["mon"] instead of burning a daily pass
    // whose addendum says "do nothing six days out of seven". Off-
    // schedule wakes (wake_on_flag, fire_deliberation) are NOT gated —
    // this only filters the scheduled tick.
    deliberation_dow: z
      .array(DowEnum)
      .min(1)
      .optional()
      .describe('Restrict deliberation_at slots to these weekdays (local). Omit = every day.'),
    interrupt_threshold: InterruptThresholdEnum.optional(),
    /**
     * Standing duties (2026-08-03) — the scheduled rota a deliberation
     * addendum used to carry as prose, as data the runtime can resolve.
     *
     * A duty declares WHEN it runs (`slots` + optional `dow` / `dom_max`),
     * WHAT it calls (`steps`, with static arguments already chosen), any
     * day-`windows` it reasons over, and the `judgment` that stays prose.
     * `render_standing_duties` filters to the duties actually due for the
     * current slot/date and converts every window to an absolute date, so the
     * pass never determines the weekday, picks a parameter from it, or
     * computes "14 days from now" — the three things the prose form asked for
     * and the model gets wrong silently. See src/core/standing_duties.ts.
     *
     * Omitted ⇒ nothing rendered, prompt byte-identical.
     */
    standing_duties: z
      .array(
        z
          .object({
            id: z.string().min(1).max(60),
            title: z.string().min(1).max(80),
            slots: z.array(z.string().regex(/^(\d{2}:\d{2}|\*)$/)).min(1),
            dow: z.array(DowEnum).min(1).optional(),
            dom_max: z.number().int().min(1).max(31).optional(),
            steps: z
              .array(
                z
                  .object({
                    tool: z.string().min(1).max(80),
                    input: z.record(z.string(), z.unknown()).optional(),
                    note: z.string().optional(),
                  })
                  .strict(),
              )
              .min(1),
            windows: z.record(z.string(), z.number().int().min(1).max(3650)).optional(),
            judgment: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    background_jobs: z.array(BackgroundJobSchema).default([]),
    // When true, an incoming inbox flag (kind='flag', severity>=medium)
    // wakes this specialist's deliberation off-schedule via the loop
    // driver's debounced wake_deliberation(). Use sparingly — only
    // for specialists whose entire job is reacting to peer signals
    // (Beatrice, Kate). Active-mode specialists watching the world
    // don't need it; they have their own awareness handler.
    wake_on_flag: z.boolean().default(false),
    // Override the specialist_deliberation role's default `think`
    // setting. Default true preserves existing behavior. Set false
    // for specialists whose deliberation work is structural / direct
    // (e.g. Beatrice draft-proposals from inbox flags — no benefit
    // from a long <think> trace, and the trace pushes her over the
    // LLM timeout under typical persona + context size).
    think_in_deliberation: z.boolean().default(true),
    // Route this specialist's scheduled deliberation pass onto the LIVE
    // tier's A4000 server (the `librarian` provider) instead of the 27B
    // on the 3090 (2026-05-31). The deliberation PROMPT + tool curation
    // are unchanged (still keyed on `specialist_deliberation`); only the
    // inference endpoint moves, via the runtime's `provider_role` seam —
    // so a 07:00/04:00 pass doesn't compete with interactive chat on the
    // 3090. Opt-in for verification/curation specialists (Cordelia) whose
    // deliberation tolerates the 2-bit quant; leave OFF for brief-quality
    // passes (Kate). See docs/design-two-tier-inference.md §3.
    deliberate_on_live: z.boolean().default(false),
    // The NAMED generalization of the boolean above (2026-08-02): route this
    // specialist's deliberation onto an arbitrary endpoint profile instead of
    // the one hard-coded lane `deliberate_on_live` can reach. Same seam
    // (`provider_role`), same guarantee — the deliberation PROMPT and tool
    // curation stay keyed on `specialist_deliberation`; only the
    // provider/model/window/timeout move, resolved wholesale from the named
    // role (see resolve/`for_role` in specialist_runtime).
    //
    // Added because the boolean could only ever express "the live lane," and
    // the real need was a WINDOW: kristi's pass 400'd at 49393 tokens against
    // the deep lane's 49152/slot, and neither Ada has the VRAM to grow one.
    // `deliberate_on_role: specialist_deliberation_deep` puts her on forza's
    // 65536/slot instead. Any future "this pass needs a different box" is now
    // a config line rather than a new boolean + a new branch.
    //
    // Takes precedence over `deliberate_on_live` when both are set. Unknown
    // role names fail at role resolution, not silently — keep it in sync with
    // config/llm-roles.yaml. Leave UNSET for anything latency-sensitive: the
    // lane a role names may be far slower (see the forza cost note in
    // llm-roles.yaml).
    deliberate_on_role: z.string().optional(),
    // Curated tool set the specialist sees during deliberation passes.
    // Empty/omitted means "all tools her capabilities grant" (the
    // legacy behavior). Listing tools restricts the decision surface
    // — observed 2026-05-19 that Qwen3.6 drops tool args when 15+
    // tools are visible but reliably fills them with 1-3 tools in
    // scope. Conversation turns still get the full capability set;
    // this only narrows the deliberation context. Since 2026-07-17
    // the BASE_TOOLSET read floor (search_library, read_note,
    // recall_brain, remember, …) is unioned into deliberation just
    // like chat — a curated list here can no longer strand an
    // autonomous pass without a read path.
    tools_for_deliberation: z.array(z.string().min(1)).default([]),
    // Curated tool set for conversation (chat) turns — the
    // `llm_role === 'specialist'` analogue of tools_for_deliberation.
    // Empty/omitted = all capability-granted tools. Set it for
    // generalist specialists (Kate) whose granted set is large enough
    // to bloat every chat prompt; consult_specialist reaches anything
    // left off the list.
    tools_for_chat: z.array(z.string().min(1)).default([]),
    // Curated tool set for the VOICE surface (`llm_role === 'voice_realtime'`
    // / surface:'voice'). The spoken-receptionist analogue of
    // tools_for_chat: a much tighter list whose serialized JSON schemas are
    // the dominant voice-turn prefill cost (measured 2026-06-07: Kate's
    // 37-tool chat surface ≈ 9.8K+ tokens of tool defs alone — the bulk of
    // an 18.7K-token voice prompt). Empty/omitted = fall back to
    // tools_for_chat (legacy voice behavior; a specialist with no voice surface is unchanged). When
    // set, it is the EXACT voice surface — the BASE_TOOLSET knowledge
    // floor is NOT unioned in (voice has no knowledge-first snippet), so
    // list any reads the spoken turn needs explicitly. consult_specialist is
    // always appended by the runtime, so depth is one consult away.
    tools_for_voice: z.array(z.string().min(1)).default([]),
    // Dynamic tool surface (2026-06-08). When true (chat turns only), the
    // specialist is made AWARE of its full capability-granted tool set (cheap
    // name+description catalog) while only a small message-ranked HOT set ships
    // full JSON schemas; a `load_tools` meta-tool pulls any other tool's schema
    // on demand. Decouples awareness from the (expensive) invocation grammar so
    // a broad-grant generalist (Kate) stops paying ~10K tokens of unused tool
    // schemas every turn. Fail-open: with this false, or embeddings
    // down, or a non-chat surface, the turn is byte-identical to the
    // curated path. Env `HEARTH_DYNAMIC_TOOLS=0` force-disables everywhere. See
    // src/core/dynamic_tools.ts + architecture.md "Per-turn tool curation".
    // Default ON since 2026-07-17 (owner directive: every specialist
    // should be aware of — and able to reach — everything they're
    // granted; proven on kate/kristi/ruby/maggie since 2026-06-08).
    // Set `dynamic_tools: false` in a specialist's YAML to opt out.
    dynamic_tools: z.boolean().default(true),
    // Per-specialist extension of the dynamic surface's hot-set FLOOR
    // (dynamic_tools mode only; the curated path is unaffected). Tools
    // listed here ship full schemas on EVERY dynamic turn alongside the
    // global floor (search_library, present_questions) — for the 1-2
    // tools so core to a specialist's job that a message-RAG ranking
    // miss on a terse message must never strand them (Kate + calendar:
    // a "Call" turn ranked zero calendar tools hot and Kate burned the
    // turn looping on search_library into a blank_turn_fallback,
    // 2026-07-15). Every entry is a per-turn prefill cost — keep it to
    // genuine can't-miss tools. Names not in the granted catalog are
    // skipped (capability-safe by construction).
    dynamic_tools_floor: z.array(z.string().min(1)).default([]),
    // Per-specialist override of the deliberation user-prompt's
    // *opening framing*. Default prelude is the generic "this is your
    // scheduled X reflection… be conservative, most of the time the
    // answer is 'nothing needs attention'" — perfect for passive
    // reflective specialists (Cassandra watches, Eleanor watches),
    // wrong for active-research specialists (Maggie's concert
    // research, Beatrice's structural-gap workflow) whose deliberation
    // SHOULD always do work. When set, the override REPLACES the
    // default prelude. The trust-tier explanation, inbox / miss
    // sections, context JSON, and reply-shape outro still ship.
    deliberation_prelude_override: z.string().optional(),
    // Slot-keyed beat scripts (2026-08-05). A multi-slot specialist whose
    // prelude carried EVERY slot's workflow paid the whole rota on every
    // pass — Ruby's six beats were 14,075 chars (~3.9k tokens) of which one
    // pass ever runs one. Keyed by the exact `deliberation_at` slot string;
    // the matching beat renders AFTER the (shared) prelude override, and
    // non-matching beats don't ship at all. A slot with no entry (an
    // off-schedule 'wake', a trigger pass) gets just the shared prelude —
    // and trigger passes replace the prelude entirely anyway. Ignored when
    // empty, so existing single-script specialists are byte-identical.
    deliberation_beats: z.record(z.string(), z.string()).default({}),
    // Per-specialist override of the deliberation user-prompt's
    // *closing instruction* — the "reply with a SINGLE JSON code
    // block of this shape" demand. Default outro asks for the
    // envelope shape; an active-action specialist can replace it
    // with "your output is tool calls; the envelope is optional /
    // not needed for your case." Used together with the prelude
    // override for active-research specialists.
    deliberation_outro_override: z.string().optional(),
    /**
     * Opt this specialist into the reactive Cordelia-capture pipeline.
     * When true and a per-specialist intake handler is registered, the
     * ReactiveInboxDriver fires that handler within seconds of a
     * matching capture landing — outside the deliberation cadence.
     * Off by default so a specialist with no handler stays a no-op
     * even if the classifier picks them.
     */
    intake_captures: z.boolean().default(false),
    /**
     * Mark this specialist as a research-heavy workload (2026-05-30).
     * When true, build_system_prompt() injects a structural research-
     * efficiency block at turn-start (chat AND deliberation modes)
     * covering: plan tool calls before firing, batch parallel fan-
     * outs, don't re-fetch documents already in context, cap scope on
     * broad questions, surface what couldn't be confirmed rather than
     * truncating on exhaust, and don't emit the same call twice in
     * one parallel fan-out.
     *
     * Replaces per-persona carve-outs ("Research efficiency — don't
     * burn rounds" sections written inline in YAML) — same architectural
     * shape as BASE_TOOLSET making the knowledge floor structural.
     * Audit log on 2026-05-30 showed Vivian's first-turn sequential
     * exhaustion AND a separate failure mode (duplicate calls inside
     * a parallel fan-out tripping `same_tool_spiral_exhaust`) — both
     * close with the same lifted-to-runtime fix.
     *
     * Pair with `max_tool_rounds` (the budget itself) when the
     * specialist's workflows legitimately need >10 rounds. Default
     * false so specialists who don't research stay unchanged.
     */
    research_workload: z.boolean().default(false),
    /**
     * Working-memory opt-in (2026-07-01). When true (AND env
     * HEARTH_WORKING_MEMORY=1), this specialist's chat turns and
     * deliberation passes carry the fused household situational block —
     * mail needing you, live people signals, upcoming life events, goods
     * follow-ups, pending proposals — composed per-caller (cordoned) from
     * the stores the signal pipelines already fill. See
     * src/core/working_memory.ts. Chat rides the grounding-pack verified
     * channel; deliberation gets a `situational_signals` ctx field. Voice
     * is deliberately excluded (lean-prefill surface). Default ON since
     * 2026-07-17 (owner directive: specialists should remember what's
     * going on in the household, not just their own shelf; soaked on
     * Kate since 2026-07-01). The block is per-caller cordoned, so the
     * flip widens awareness, not privacy. Env HEARTH_WORKING_MEMORY
     * remains the global gate; set `situational_context: false` in a
     * specialist's YAML to opt out.
     */
    situational_context: z.boolean().default(true),
    /**
     * Reactive trigger subscriptions (2026-06-18) — wake this specialist's
     * deliberation on a real-world EVENT (a location flip, a routed capture,
     * a domain threshold crossing) instead of only on the `deliberation_at`
     * clock. Each entry names a code-registered TriggerDef + a scoped task;
     * matching/edge-detection lives in typed TS (no eval). See
     * TriggerSubscriptionSchema above + reactive_triggers.ts. Empty default
     * = unchanged scheduled cadence; kill switch HEARTH_REACTIVE_TRIGGERS.
     */
    triggers: z.array(TriggerSubscriptionSchema).default([]),
  })
  .strict();

/**
 * Per-tier visibility behavior for a single specialist (Phase 2b).
 *
 * Encodes what this specialist does when a caller of the named tier
 * asks them something in their domain. Three behaviors:
 *
 *   - `open`   — answer normally, share what they know
 *   - `defer`  — politely redirect to a different specialist (default
 *                `defer_to: kate`) without disclosing detail
 *   - `refuse` — courteous refusal; suggests an alternative path
 *
 * The owner tier is implicitly `open` for every specialist (the
 * captain has full visibility by design); the schema only declares
 * household + friend tiers to keep YAML compact.
 *
 * `allowed_tiers` is the HARD boundary. When set, callers whose tier
 * is not in the list get a canned refusal WITHOUT an LLM call at all
 * (defense in depth — even a jailbroken model can't leak because the
 * runtime never asks it). When unset, the LLM call proceeds and the
 * persona + rendered discretion block guide behavior.
 *
 * Use `allowed_tiers` for specialists whose domain is structurally
 * owner-only (Cassandra: security, Vivian: finance). Use per-tier
 * `visibility` for specialists who modulate WHAT they share rather
 * than WHETHER they engage (most others).
 *
 * Mental model: hard refusal = "I don't take that call"; soft
 * defer = "I'll route you to the right person"; open = "happy to
 * help with that".
 */
const VisibilityBehaviorEnum = z.enum(['open', 'defer', 'refuse']);
export type VisibilityBehavior = z.infer<typeof VisibilityBehaviorEnum>;

const DiscretionSchema = z
  .object({
    /** Per-tier behavior. Owner is always 'open' and not declared. */
    visibility: z
      .object({
        household: VisibilityBehaviorEnum.default('open'),
        friend: VisibilityBehaviorEnum.default('defer'),
      })
      .strict()
      .default({}),
    /** Specialist id to suggest when deferring or refusing. */
    defer_to: z.string().min(1).default('kate'),
    /** Hard boundary — callers outside this list never reach the LLM. */
    allowed_tiers: z.array(TierEnum).optional(),
    /**
     * Per-tier flag for whether this specialist tracks the caller's
     * data independently (separate memory.md, separate library scope,
     * separate vault namespace). Brigid tracks diets per-user;
     * Marguerite tracks family trees per-user. Most specialists don't.
     */
    per_user_tracking: z
      .object({
        household: z.boolean().default(false),
        friend: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Discretion = z.infer<typeof DiscretionSchema>;

// Capabilities object: a record of <capability_token> → bool. Unknown tokens
// are rejected so config typos fail at load.
const CapabilitiesSchema = z
  .record(z.string(), z.boolean())
  .superRefine((obj, ctx) => {
    for (const key of Object.keys(obj)) {
      if (!is_capability(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown capability: "${key}". Valid: ${all_capabilities().join(', ')}`,
        });
      }
    }
  });

export const SpecialistConfigSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'id must be lowercase snake_case'),
    name: z.string().min(1),
    role: z.string().min(1),
    avatar: z.string().optional(),
    /**
     * Canonical visual description of this specialist — who they are on
     * camera (age, hair, eyes, build, signature wardrobe), WITHOUT style/
     * medium/scene tails. The generate_image tool prepends it when a
     * specialist depicts themselves, so self-portraits stay on-model
     * with the avatar the user already knows. (The styled generator
     * that produced those canonical portraits was retired with the CPU
     * ComfyUI on 2026-07-30; avatars are uploaded now.)
     */
    appearance: z.string().optional(),
    voice: VoiceEnum,
    // Optional LLM-role override for this specialist's conversational
    // turns — resolved through config/llm-roles.yaml. Omitted = the
    // standard 'specialist' chat role. Deliberation/drafter passes keep
    // their own explicit roles. Routes one specialist onto a different
    // model (e.g. an uncensored variant) without touching the others.
    llm_role: z.string().optional(),
    persona: z.string().min(20),
    /**
     * Mode-specific persona addenda (added 2026-05-29 to address
     * chat-turn prefill bloat). The `persona` field above stays the
     * core identity / always-injected base. Anything that is:
     *   - chat-only (turn-taking patterns, conversational tone rules,
     *     real-time escalation guidance, response-shape hints) →
     *     belongs in `chat_addendum`.
     *   - deliberation-only (scheduled-pass workflow scripts, JSON
     *     envelope shaping, day-of-week procedures) →
     *     belongs in `deliberation_addendum`.
     * Both addenda are optional; omitted ≡ legacy behavior (persona
     * is the entire specialist scaffold). build_system_prompt() in
     * specialist_runtime.ts appends the right one based on `mode`.
     * Maggie's persona was 9.5K tokens with workflow inline; splitting
     * cut the chat-turn injection to ~3K and the deliberation
     * injection to ~8K — measured prefill drop ~3 sec on RTX 3090 /
     * Qwen 3.6 27B Q4.
     */
    chat_addendum: z.string().optional(),
    deliberation_addendum: z.string().optional(),
    /**
     * Spoken-surface style overlay (added 2026-06-05). When a turn arrives
     * with `surface: 'voice'` (today: the Satellite1 → Kate stack via the
     * openai_shim), build_system_prompt() appends this text as the
     * recency-weighted TAIL of the system prompt — so the specialist keeps
     * her full chat persona + tools but shapes the OUTPUT for the ear:
     * conversational, no markdown/symbols, units spoken as words
     * ("ninety-three degrees", not "93°F"). Opt-in per specialist: omitted
     * ≡ voice turns render exactly like screen turns (legacy behavior).
     * Only specialists actually spoken aloud need it (Kate today). NOT the
     * same as the `llm_role: voice_realtime` path, which swaps in an entirely
     * slim prompt — this leaves the persona intact and only adds output rules.
     */
    voice_style: z.string().optional(),
    /**
     * Conversation-surface character tail (added 2026-07-03) — the chat
     * sibling of voice_style. build_system_prompt() appends this as the LAST
     * section of a conversation-mode system prompt, AFTER the late-loaded
     * grounding/weekday compliance essays. Why: decoders weight the last
     * system content most (the reason those essays live last), so without a
     * tail the model's strongest-attention region every chat turn is 100%
     * compliance text and the persona's warmth — tens of thousands of tokens
     * back — reads clinical. This is the exact "clinical and cold" symptom
     * the voice path documented on 2026-06-05 and solved with its slim
     * prompt + voice_style tail; chat never got the same cure until now.
     * Register ONLY (tone, rhythm, wit, formatting reflexes) — grounding and
     * honesty rules are NOT softened, and an author should say so inside the
     * block itself. Opt-in: omitted ≡ legacy prompt, byte-identical.
     */
    chat_style: z.string().optional(),
    /**
     * Tool reflexes (2026-08-03) — the question-shape → tool routing table,
     * rendered by build_system_prompt() into the recency-strong zone of every
     * CHAT prompt, just above `chat_style`.
     *
     * ── Why a config table and not prose ────────────────────────────────────
     * "When he asks X, call `tool_y` FIRST" is the single most repeated
     * sentence shape in a mature persona, and writing each one as prose has
     * three costs. It is expensive (Kate carried ~30 of them, each spending a
     * paragraph of standing prefill on one routing fact). It is scattered, so
     * the same reflex gets re-stated in `persona` AND `chat_addendum` as
     * authors add to whichever block they're editing. And it is unverifiable:
     * prose can name a tool the specialist does not hold, or one that has been
     * renamed, and nothing catches it — the model just learns to reach for a
     * tool that will come back `unknown_tool`.
     *
     * As data, all three go away. One line per reflex instead of a paragraph;
     * one place to look; and `smoke:tool-reflexes` boots the real tool
     * registry and fails CI when a reflex names a tool that does not exist or
     * that this specialist's capabilities cannot reach. Dynamic in that the
     * table is generated from live config, deterministic in that a reflex
     * which survives the lint is guaranteed callable.
     *
     * ── What belongs here ───────────────────────────────────────────────────
     * A REFLEX is "this shape of question ⇒ this tool, this turn, before
     * answering" — the recurring cases where recall is stale by construction
     * (who works here, who a person is, what a container's state is) and the
     * failure mode is a confident wrong answer rather than a shrug. It is NOT
     * a workflow ("at the 07:00 slot, run the occasions sweep" belongs in
     * `deliberation_addendum`) and NOT tool documentation (argument shapes
     * belong in the tool's own description, which the model already gets).
     *
     * `when` is the question shape in the user's words; `tool` is the exact
     * registered tool name; `note` is the one clause that makes the call
     * correct (a required argument, the field to lead with, the wrong tool it
     * is commonly confused with). Keep the table short — every entry is
     * standing prefill on every chat turn, so a reflex that fires once a month
     * belongs in the tool description instead. Omitted ⇒ no block rendered,
     * prompt byte-identical to before.
     */
    tool_reflexes: z
      .array(
        z.object({
          when: z.string().min(1),
          tool: z.string().min(1),
          note: z.string().optional(),
        }),
      )
      .default([]),
    /**
     * Slim persona used ONLY on voice turns (added 2026-06-07), in place of the
     * full `persona`. The voice branch of build_system_prompt() prefills this
     * instead of the full COS persona when set. Why: a voice turn's persona
     * prefill is the dominant cold-turn latency — Kate's full persona is ~4.5K
     * tokens, which costs ~1.47s of prefill on a cache-miss voice turn vs ~0.37s
     * for a ~600-token voice persona (measured on the 9B, 2026-06-07). Warm
     * (slot-cached) turns are ~0.06s either way, so this only matters on the
     * common cold turn (first utterance of a call / slot evicted). The voice
     * persona only needs the identity + escalate-don't-guess posture; the heavy
     * chat/research scaffold is already dropped by the voice prompt mode, and
     * `voice_style` (the speakable-output rules) is still appended on top.
     * Opt-in: omitted ≡ voice turns prefill the full `persona` (legacy). Honors
     * {{user_name}} per-speaker via voice_persona_template, like `persona`.
     */
    voice_persona: z.string().optional(),
    knowledge_scope: z.array(z.string()).default([]),
    // Turn-start auto-RAG opt-out (default ON). When true, a conversational
    // turn retrieves top-K library chunks scoped to knowledge_scope BEFORE
    // the first token, so the specialist answers from retrieved material
    // instead of memory (and the fact-critic has retrieved evidence to
    // verify against). Set false ONLY for latency-critical specialists whose
    // value is real-time and who don't need library grounding (e.g. Astrid
    // mid-workout coaching) — they keep the explicit `search_library` tool.
    // Voice turns and scopeless specialists skip auto-RAG regardless. See
    // the turn-start RAG gate in specialist_runtime.ts.
    auto_rag: z.boolean().default(true),
    /**
     * Mark this specialist's CHAT turns as narrative — roleplay, fiction,
     * collaborative storytelling — rather than factual assertion (2026-07-27).
     * When true, the finalize reply-guard stack (ghost-promise, fabricated-
     * save/action, save-honesty, read-failure, data-denial, citation,
     * provenance, fact-critic) is suppressed on the `conversation` surface by
     * zeroing that turn's re-roll budget — the same seam the voice path
     * already uses.
     *
     * Why this is a category flag and not a threshold: every guard in the
     * stack asks "does this claim trace to evidence retrieved THIS turn?"
     * (tool results, history, RAG). Invented narrative has no such evidence
     * by construction, so the guards fire on ordinary in-fiction prose no
     * matter how they're tuned. Observed on Mariah over 2026-07-13..27:
     * ghost-promise matched present-tense narration (26 fires, nothing
     * factual in any of them) and the fact critic flagged in-fiction nouns
     * as fabrications (30 fires, e.g. `named_entity:Chief of Staff`). Because
     * she also carries `proactive.research_workload: true` her chat streams
     * LIVE, so each re-roll superseded a visible draft and re-typed it — the
     * user-visible "she regenerates" report that prompted this.
     *
     * Deliberately CHAT-ONLY. A narrative specialist's `deliberation` turns
     * are real work making real assertions (Mariah's stuck-work ledger,
     * process misses) and keep the full guard stack. The synthesis nudge is
     * likewise unaffected — it never consumed the re-roll budget, so a blank
     * or meta-only turn after tool calls is still recovered.
     *
     * Default false: every existing specialist is byte-identical.
     */
    narrative: z.boolean().default(false),
    capabilities: CapabilitiesSchema.default({}),
    proactive: ProactiveSchema,
    default_landing: z.boolean().default(false),
    /**
     * Kate sub-agents Phase 1 (2026-07-03). When true, this specialist is
     * NOT chat-facing: hidden from the /app + iOS staff rosters and the
     * composer alias map. EVERYTHING ELSE stays alive — deliberation
     * slots, background jobs, inbox, capability grants, capture-intake
     * candidacy (a routed vet bill still fires Anya's extractor), and the
     * profile stays reachable via `consult_specialist` and Kate's
     * `delegate` tool. Demotion hides the chat relationship, never the
     * machine work — re-owning intake/jobs is Phase 3's fold-in job. This
     * is the demotion lever for folding a specialist into Kate's staff
     * (docs/design-kate-subagents.md) without deleting its capability
     * bundle. A `default_landing` specialist can never be subagent_only.
     */
    subagent_only: z.boolean().default(false),
    // slash-command + @<name> aliases used by the /app web composer's
    // autocomplete (e.g. /cos → kate).
    aliases: z.array(z.string().min(1).max(32)).default([]),
    // Per-specialist override of MAX_TOOL_ROUNDS (the sequential
    // tool-call ceiling for a single turn — chat AND deliberation,
    // since both go through runtime.turn / turn_streaming today).
    // Default 10. Bump for research-heavy specialists whose workflows
    // legitimately need search → drill → cross-confirm → capture →
    // reply chains that hit the wall (Maggie: concert/artist recon;
    // Cordelia: deep catalog research). Do not bump as a "more is
    // better" reflex — each round adds tool input + output to context,
    // and a specialist that's spinning will exhaust whatever ceiling
    // it has. Cap at 20.
    max_tool_rounds: z.number().int().min(1).max(20).optional(),
    // DELIBERATION-slot override of the ceiling (2026-08-11, directed-build
    // postmortem). Chat and deliberation shared one number, so sizing a
    // specialist's chat honestly also guillotined their deliberation: Ruby's
    // civic passes exhausted 18/18 (pm_24nap9a5pfm1) while her chat cap was
    // right. Applies to `specialist_deliberation` turns only; unset → falls
    // through to `max_tool_rounds`. Directed builds additionally carry a
    // per-pass override on the DirectedTask itself and don't need this.
    // Capped at 60 to match TOOL_ROUNDS_OVERRIDE_CAP — a deliberation pass
    // deeper than that is a spiral, not research.
    max_tool_rounds_deliberation: z.number().int().min(1).max(60).optional(),
    // Per-specialist output-token ceiling, overriding the LLM role's
    // `max_tokens` default for THIS specialist's turns (chat + deliberation).
    // The generic chat tiers cap at 2000 on purpose (output length is the
    // dominant latency cost). Research-heavy specialists whose answers are
    // legitimately long — multi-section briefings with sources (Kristi),
    // deep catalog synthesis — set this higher (≈4000) so they don't get
    // guillotined mid-list at the generic cap. Do NOT raise as a "bigger is
    // better" reflex: a 4000-token answer on the 80B is ~2.5 min. Cap 8000.
    max_tokens: z.number().int().min(1).max(8000).optional(),
    // How many independent complexity signals escalate a CHAT turn to the
    // deep tier (think-ON). The complexity gate defaults to 2 (precision
    // over recall — see complexity.ts). A broad-grant generalist that
    // reasons in SHORT operational asks — Kate the chief-of-staff — sets
    // this to 1 so terse reasoning questions ("Why does Kristi own hire
    // packets?", "Is this redundant?") escalate off the fast 9B instead of
    // being fabricated on it (the 2026-06-16 Kristi-scope spiral). A floor
    // of 1 also escalates short single-signal asks; trivial chat (zero
    // signals) never escalates at any floor. Leave unset for domain
    // specialists — escalating their narrow turns just adds latency.
    complexity_floor: z.number().int().min(1).max(3).optional(),
    /**
     * Opt this specialist into Beatrice's expertise-coverage audit
     * (`audit_specialist_expertise`, NEXT.md 15c part C). When true, the
     * audit scores this specialist against the 9-axis craft rubric
     * (Knowledge/Cordelia/craft/) and emits an `expertise_gap` finding —
     * a process_miss + a Cordelia wake-flag — per axis below bar.
     * Default false: the audit is opt-in so it can't flood Cordelia's
     * ≤3-shelves/pass curate budget, and so Jasper chooses who's in scope
     * (typically a specialist being deliberately built out, e.g. Kristi).
     */
    deepen: z.boolean().default(false),
    /**
     * Per-tier discretion policy (Phase 2b). When omitted, the
     * specialist defaults to fully open household behavior and a
     * polite defer-to-Kate posture for friends — the least-disruptive
     * shape for the existing single-user codebase. Sensitive
     * specialists (Cassandra, Vivian) MUST declare `allowed_tiers`
     * explicitly; the default isn't safe for them.
     */
    discretion: DiscretionSchema.default({}),
    /**
     * Stage 2 of the Specialist-as-Room shift (see
     * `~/Projects/hearth-ios/SPECIALIST_AS_ROOM_BRIEF.md`). When
     * non-null, the iOS bento + Staff roster route the tap to a
     * `SpecialistRoomView` that fetches `GET /api/specialists/:id/pane`
     * and renders the returned layout document as the body, with
     * the existing chat thread reachable via the footer pill.
     * When null (the default), the tap routes straight to chat —
     * the legacy behavior. Not every specialist earns a pane;
     * adding one is a deliberate decision per spec.
     *
     * The enum is closed on the BACKEND so `compose_pane` stays
     * exhaustively checked — adding a kind means adding its composer.
     * It no longer needs a paired iOS edit: since the 2026-05-30
     * `hasPane` refactor, iOS routes to the room on raw `paneKind`
     * string presence and renders whatever typed blocks the pane
     * document carries (`PaneBlockView` dispatches on block kind, not
     * pane kind). A kind iOS has no typed case for still opens the
     * room and renders server-composed blocks.
     */
    pane_kind: z
      .enum(['library', 'activity', 'today', 'listening', 'fuel', 'program', 'civic', 'competitive', 'property', 'resale', 'codeshop', 'briefing', 'presence', 'home'])
      .nullable()
      .default(null),
    /**
     * Domain-knowledge trust manifest (Slice A — 2026-05-30).
     * Cordelia's curation tooling uses this to decide what to auto-
     * ingest into this specialist's library vs. what to surface for
     * human review.
     *
     * tier_1 — peer-reviewed, government (non-captured), or top-tier
     *   professional bodies. Auto-ingest on curate. International-first
     *   by deliberate diversification (Cochrane / NICE / NHS / CMAJ /
     *   CSEP / WHO alongside ACSM / NSCA / PubMed). Specifically does
     *   NOT lean on US HHS-family guidance — the underlying research
     *   apparatus (PubMed index, PMC archive) stays Tier 1, but
     *   recommendation surfaces (cdc.gov / health.gov) move to Tier 2.
     * tier_2 — high-quality but with provenance disclosure. Ingest
     *   stamps `trust_tier: 2` in the wrapper note's frontmatter; the
     *   specialist cites when referencing.
     *
     * Each entry is a domain pattern (host suffix). curation matches
     * URL host against the longest pattern first.
     *
     * Growth path: when curation finds a high-quality source not in
     * either tier, it files a `trusted_source_addition` proposal for
     * user review instead of silently ingesting (the Tier-3 gate).
     */
    trusted_sources: z
      .object({
        tier_1: z.array(z.string().min(3)).default([]),
        tier_2: z.array(z.string().min(3)).default([]),
      })
      .strict()
      .default({ tier_1: [], tier_2: [] }),
  })
  .strict();

export type SpecialistConfig = z.infer<typeof SpecialistConfigSchema>;

/**
 * Resolve the trust tier of a candidate URL against a specialist's
 * `trusted_sources` manifest. Returns:
 *   - 1 — URL host (or any parent suffix) is in tier_1: auto-ingest
 *   - 2 — URL host matches tier_2: ingest with `trust_tier: 2` provenance
 *   - null — unlisted: Cordelia's curate tool routes through
 *     `propose_trusted_source` (Slice B) instead of silent ingest.
 *
 * Suffix match is strict — "nih.gov" matches "ods.od.nih.gov" but NOT
 * "evil-nih.gov.example". Tier 1 wins ties (most-trusted classification
 * sticks).
 */
export function resolve_trust_tier(
  url: string,
  specialist: Pick<SpecialistConfig, 'trusted_sources'>,
): 1 | 2 | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const matches = (domain: string): boolean => {
    const d = domain.toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  };
  const t1 = specialist.trusted_sources.tier_1 ?? [];
  if (t1.some(matches)) return 1;
  const t2 = specialist.trusted_sources.tier_2 ?? [];
  if (t2.some(matches)) return 2;
  return null;
}

export interface LoadedSpecialist extends SpecialistConfig {
  granted: Set<Capability>;
  source_path: string;
  /** Persona/addenda with {{user_name}} left as a literal token (all other
   *  household tokens substituted), so the runtime resolves it to the
   *  current turn's speaker rather than the admin baked at load. Optional:
   *  configs compiled outside load_specialist_file (e.g. a hire-generated
   *  persona) won't have them — build_system_prompt falls back to the
   *  admin-bound `persona`/addenda fields. */
  persona_template?: string;
  chat_addendum_template?: string;
  deliberation_addendum_template?: string;
  voice_persona_template?: string;
}

export function compile(
  cfg: SpecialistConfig & {
    persona_template?: string;
    chat_addendum_template?: string;
    deliberation_addendum_template?: string;
  },
  source_path: string,
): LoadedSpecialist {
  const granted = granted_set(
    Object.entries(cfg.capabilities ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k),
  );
  // Auto-include the specialist's own namespace `Knowledge/<CapId>/**`
  // in their knowledge_scope if not already declared. Eliminates the
  // class of bug where uploads land in their library but their scope
  // explicitly lists some other folder (e.g. Anya scoped to
  // Knowledge/Veterinary while uploads went to Knowledge/Anya/library).
  const ns_cap = cfg.id.charAt(0).toUpperCase() + cfg.id.slice(1);
  const self_glob = `Knowledge/${ns_cap}/**`;
  const scope = cfg.knowledge_scope.includes(self_glob) || cfg.knowledge_scope.includes('**')
    ? cfg.knowledge_scope
    : [self_glob, ...cfg.knowledge_scope];
  return { ...cfg, knowledge_scope: scope, granted, source_path };
}

export function load_specialist_file(path: string): LoadedSpecialist {
  const text = readFileSync(path, 'utf8');
  const raw = parseYaml(text) as unknown;
  const parsed = SpecialistConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid specialist config ${path}: ${parsed.error.message}`);
  }
  // Substitute household tokens ({{user_name}}, {{pet_names}}, etc.) in
  // the persona text. The YAML on disk stays generic — the running
  // persona is bound to whatever household lives in config/users.yaml.
  // Addenda go through the same substitution so {{user_name}} etc. work
  // wherever the author put them.
  const ctx = get_household_context();
  // Deferred-identity copies: the PER-USER household tokens (DEFERRED_PERSONA_TOKENS
  // — {{user_name}}, {{primary_vehicle}}, {{pet_names}}, {{partner_name}}, …) are
  // left as literals so the runtime resolves them to the CURRENT turn's speaker
  // (build_system_prompt → resolve_household_for_user), not the admin baked at
  // load. So Sam's Iris doesn't reference Jasper's Ioniq. Household-WIDE tokens
  // (brand, home, city, venues) are still bound here. The plain `persona`/addenda
  // below stay admin-bound for every non-turn consumer (UI persona preview,
  // doctor's leftover-token check, hire bootstrap analysis).
  const bound = {
    ...parsed.data,
    persona: substitute(parsed.data.persona, ctx),
    chat_addendum: parsed.data.chat_addendum
      ? substitute(parsed.data.chat_addendum, ctx)
      : undefined,
    deliberation_addendum: parsed.data.deliberation_addendum
      ? substitute(parsed.data.deliberation_addendum, ctx)
      : undefined,
    // Voice overlay goes through the same household-token substitution as the
    // addenda. No deferred-identity (_template) copy: it carries generic
    // speakable-output rules, not {{user_name}}-addressed persona prose.
    voice_style: parsed.data.voice_style
      ? substitute(parsed.data.voice_style, ctx)
      : undefined,
    // Chat character tail — same treatment as voice_style (household-wide
    // tokens bound at load; no deferred-identity copy — author it
    // speaker-generic and let the speaker-identity block carry who's talking).
    chat_style: parsed.data.chat_style
      ? substitute(parsed.data.chat_style, ctx)
      : undefined,
    // Reflex table — household tokens resolved like every other prose field,
    // so a `when`/`note` that mentions the household reads as prose rather
    // than leaking a literal `{{…}}` to the model. `tool` is an identifier
    // and is never substituted.
    tool_reflexes: parsed.data.tool_reflexes.map((r) => ({
      when: substitute(r.when, ctx),
      tool: r.tool,
      note: r.note ? substitute(r.note, ctx) : undefined,
    })),
    persona_template: substitute(parsed.data.persona, ctx, DEFERRED_PERSONA_TOKENS),
    chat_addendum_template: parsed.data.chat_addendum
      ? substitute(parsed.data.chat_addendum, ctx, DEFERRED_PERSONA_TOKENS)
      : undefined,
    deliberation_addendum_template: parsed.data.deliberation_addendum
      ? substitute(parsed.data.deliberation_addendum, ctx, DEFERRED_PERSONA_TOKENS)
      : undefined,
    // Slim voice persona — deferred-identity copy so the per-user tokens resolve
    // to the current speaker per turn (same treatment as persona_template).
    voice_persona_template: parsed.data.voice_persona
      ? substitute(parsed.data.voice_persona, ctx, DEFERRED_PERSONA_TOKENS)
      : undefined,
  };
  return compile(bound, path);
}

/**
 * Learned trusted-source overlay (2026-08-05). Approved
 * `trusted_source_addition` proposals used to be written INTO the deploy
 * checkout's YAML by the resolver — un-committed learning that the next
 * `git pull --ff-only` either refused over or a force-pull destroyed
 * (11 of Ruby's learned domains were one force-pull from gone). When
 * `HEARTH_CONFIG_OVERLAY_DIR` is set, approvals land in
 * `<dir>/trusted-sources.yaml` instead — a DATA-side file that survives
 * deploys — and this loader merges it over the git-tracked manifests.
 * Shape: `{ <specialist_id>: { tier_1: [domains], tier_2: [domains] } }`.
 * Unset env (dev boxes, CI) ⇒ no overlay, byte-identical loads.
 */
export function trusted_source_overlay_path(): string | null {
  const dir = process.env.HEARTH_CONFIG_OVERLAY_DIR;
  return dir ? resolve(dir, 'trusted-sources.yaml') : null;
}

function read_trusted_source_overlay(): Record<
  string,
  { tier_1?: string[]; tier_2?: string[] }
> {
  const path = trusted_source_overlay_path();
  if (!path || !existsSync(path)) return {};
  try {
    const raw = parseYaml(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object'
      ? (raw as Record<string, { tier_1?: string[]; tier_2?: string[] }>)
      : {};
  } catch (err) {
    // Fail-open: a malformed overlay must not take the whole roster down.
    console.error(`[specialists] trusted-source overlay unreadable (ignored): ${path}`, err);
    return {};
  }
}

export function load_specialists_dir(dir: string): LoadedSpecialist[] {
  if (!existsSync(dir)) {
    throw new Error(`specialist config dir not found: ${dir}`);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const overlay = read_trusted_source_overlay();
  const out: LoadedSpecialist[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = resolve(dir, f);
    const loaded = load_specialist_file(path);
    if (seen.has(loaded.id)) {
      throw new Error(`duplicate specialist id: ${loaded.id} (in ${path})`);
    }
    seen.add(loaded.id);
    const extra = overlay[loaded.id];
    if (extra) {
      for (const tier of ['tier_1', 'tier_2'] as const) {
        for (const domain of extra[tier] ?? []) {
          if (typeof domain !== 'string' || domain.length < 3) continue;
          if (!loaded.trusted_sources[tier].includes(domain)) {
            loaded.trusted_sources[tier].push(domain);
          }
        }
      }
    }
    out.push(loaded);
  }
  // At most one specialist may be marked default_landing.
  const default_count = out.filter((s) => s.default_landing).length;
  if (default_count > 1) {
    throw new Error(`multiple specialists marked default_landing: only one is allowed`);
  }
  // The landing specialist is by definition user-facing — a hidden default
  // would strand every new conversation on an invisible roster entry.
  const hidden_landing = out.find((s) => s.default_landing && s.subagent_only);
  if (hidden_landing) {
    throw new Error(
      `specialist ${hidden_landing.id} is default_landing and subagent_only — a hidden landing specialist is a contradiction`,
    );
  }
  return out;
}

export class SpecialistRegistry {
  private by_id = new Map<string, LoadedSpecialist>();
  private watcher: FSWatcher | null = null;
  private reload_listeners: Array<() => void> = [];
  // Per-add listeners run once per newly-discovered specialist id —
  // covers any path that lands a new YAML in the dir: the modal hire
  // (POST /api/specialists), the agentic hire (POST /from-packet),
  // a direct YAML write (Claude-on-glacier dropping a file), or a
  // git pull pulling in someone else's hire. Before this existed,
  // only /from-packet ran the on-hire knowledge bootstrap inline,
  // so Ruby — created via direct YAML write on 2026-05-30 — landed
  // with an empty Knowledge/Pleasantville/ shelf until a Claude
  // session manually injected the bootstrap flags. Routing through
  // the registry's diff means the trigger is structural: every
  // future hire path gets the same bootstrap for free.
  private added_listeners: Array<(id: string) => void> = [];
  // Suppresses added-listener firing during the constructor's initial
  // load — on cold start, every existing specialist looks "new" vs.
  // the empty pre-load set, but we don't want to re-bootstrap them.
  // Flipped to false after the initial reload returns, so subsequent
  // chokidar-triggered reloads do fire listeners normally.
  private suppress_added_listeners = true;
  // Dedupe across multiple reload events for the same id within a
  // process lifetime — chokidar can fire `add` + `change` close
  // together on a fresh YAML write, and we only want one bootstrap
  // per specialist per process.
  private added_fired_for = new Set<string>();
  // Coalesces a burst of chokidar events (a `git pull` rewriting several
  // YAMLs at once) into a single reload after the dir falls quiet, so we
  // never re-read a half-written YAML mid-pull (which parses as an error
  // and logs "keeping previous configs") or reload N times for one pull.
  // Mirrors ToolLoader's RELOAD_DEBOUNCE_MS.
  private reload_timer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RELOAD_DEBOUNCE_MS = 350;

  constructor(private dir: string) {
    this.reload();
    this.suppress_added_listeners = false;
  }

  reload(): void {
    const previous_ids = new Set(this.by_id.keys());
    const specialists = load_specialists_dir(this.dir);
    this.by_id.clear();
    for (const s of specialists) this.by_id.set(s.id, s);
    console.log(
      `[specialists] loaded ${specialists.length} specialist(s): ${specialists
        .map((s) => s.id)
        .join(', ')}`,
    );
    // Diff: ids in the new set that weren't in the previous set.
    const added_ids: string[] = [];
    for (const id of this.by_id.keys()) {
      if (!previous_ids.has(id)) added_ids.push(id);
    }
    for (const cb of this.reload_listeners) {
      try {
        cb();
      } catch (err) {
        console.error('[specialists] reload listener failed:', err);
      }
    }
    if (this.suppress_added_listeners) return;
    for (const id of added_ids) {
      if (this.added_fired_for.has(id)) continue;
      this.added_fired_for.add(id);
      for (const cb of this.added_listeners) {
        try {
          cb(id);
        } catch (err) {
          console.error(
            `[specialists] added listener failed for ${id}:`,
            err,
          );
        }
      }
    }
  }

  watch(): void {
    if (this.watcher) return;
    // Watch the learned trusted-source overlay too (when configured):
    // an approval that lands there must apply without a restart, same as
    // the legacy in-repo YAML write did (that write was inside this
    // watched dir, so it hot-reloaded for free).
    const overlay = trusted_source_overlay_path();
    this.watcher = chokidar.watch(overlay ? [this.dir, overlay] : this.dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    const handler = () => {
      // Debounce: re-arm on every event so a multi-file pull collapses
      // into one reload once the dir is quiet.
      if (this.reload_timer) clearTimeout(this.reload_timer);
      this.reload_timer = setTimeout(() => {
        this.reload_timer = null;
        try {
          this.reload();
        } catch (err) {
          console.error(
            `[specialists] reload failed (keeping previous configs): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }, SpecialistRegistry.RELOAD_DEBOUNCE_MS);
    };
    this.watcher.on('add', handler);
    this.watcher.on('change', handler);
    this.watcher.on('unlink', handler);
  }

  async close(): Promise<void> {
    if (this.reload_timer) {
      clearTimeout(this.reload_timer);
      this.reload_timer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  on_reload(cb: () => void): void {
    this.reload_listeners.push(cb);
  }

  /** Fires once per newly-discovered specialist id. The constructor's
   *  initial load also fires (every existing specialist looks "new"
   *  vs. the empty pre-load set), so listeners MUST guard with their
   *  own idempotency (typically: query audit_log for a prior bootstrap
   *  entry) to avoid re-firing across orchestrator restarts. */
  on_specialist_added(cb: (id: string) => void): void {
    this.added_listeners.push(cb);
  }

  get(id: string): LoadedSpecialist | null {
    return this.by_id.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.by_id.has(id);
  }

  /**
   * Resolve a specialist *reference* — an id, a display name, or a
   * slash-command alias, case-insensitively — to the canonical id, or
   * null when nothing on the roster matches. This is the one mapping
   * for the display-name habit ("Beatrice" / "bea" → `trainer`): an
   * LLM that knows a specialist by name resolves to the same id every
   * config and store keys on. Deliberately NOT fuzzy — a typo
   * ("maggia") returns null so the caller decides loudly, the same
   * posture as `granted_set` rejecting unknown capability tokens.
   */
  resolve_id(candidate: string): string | null {
    if (this.by_id.has(candidate)) return candidate;
    const want = candidate.trim().toLowerCase();
    if (want.length === 0) return null;
    for (const s of this.by_id.values()) {
      if (s.id.toLowerCase() === want) return s.id;
      if (s.name.toLowerCase() === want) return s.id;
      if (s.aliases.some((a) => a.toLowerCase() === want)) return s.id;
    }
    return null;
  }

  list(): LoadedSpecialist[] {
    return Array.from(this.by_id.values());
  }

  default_landing(): LoadedSpecialist | null {
    return this.list().find((s) => s.default_landing) ?? null;
  }
}
