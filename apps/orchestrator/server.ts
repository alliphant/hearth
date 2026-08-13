import { Hono } from 'hono';
import type { Context } from 'hono';
import { ulid } from 'ulid';
import { z } from 'zod';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ConfigLLMRouter } from '@core/router';
import { make_embedder } from '@core/embeddings';
import { configure_search } from '@connectors/search_router';
import { Scribe } from '@agents/scribe';
import { create_inbox_router } from '@inbox/router';
import { LibraryStore } from '@library/store';
import { create_library_router } from '@library/router';
import { Gateway, type GateDecision, type PolicyContext } from '@policy/gateway';
import { ApprovalStore } from '@policy/approvals';
import {
  push_text,
  push_approval,
  start_push_sweep,
} from '@policy/push';
import { UserRegistry, KvSettings } from '@core/users';
import { configure_review_swarm } from '@core/review_swarm';
import {
  pull_brief_context,
  put_warm_life_context,
} from '@core/domain_packs/life_context';
import { set_household_context } from '@core/household';
import { SessionStore } from '@core/sessions';
import { DeviceStore } from '@core/devices';
import { StepUpStore } from '@core/step_up';
import { create_auth_router } from '@app/routes/auth';
import { create_admin_router } from '@app/routes/admin';
import { create_auth_middleware } from '@app/auth_middleware';
import type { Tool, ToolCall, ToolContext } from '@core/tool';
import type { RiskTier } from '@core/types';
import { SpecialistRegistry } from '@core/specialist';
import { SpecialistRuntime } from '@core/specialist_runtime';
import type { DirectedTask } from '@core/deliberation';
import { ToolRegistry } from '@core/tool_registry';
import {
  load_extra_capabilities,
  watch_extra_capabilities,
} from '@core/capabilities';
import {
  ProposalsStore,
  load_autonomy_config,
  watch_autonomy_config,
  type ProposalRow,
} from '@core/proposals';
import {
  assess_proposal,
  proposal_critic_enabled,
  should_retire_refile,
  temporal_sanity,
} from '@core/proposal_critic';
import { sweep_trust_autoexec } from '@core/trust_teeth';
import { ProcessMissStore } from '@core/process_misses';
import { SkillsStore } from '@memory/stores/skills';
import { job_runs, DELIBERATION_JOB_KEY } from '@core/job_runs';
import { BUILD_AGENT_ID, BUILD_LEDGER_ID } from '@core/build_identity';
import { RoomsStore } from '@memory/stores/rooms';
import { LlmRoleOverrideStore } from '@memory/stores/llm_role_overrides';
import { DirectedDispatchStore, MAX_DISPATCH_ATTEMPTS } from '@memory/stores/directed_dispatches';
import { create_rooms_router } from '@app/routes/rooms';
import {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import { LoopDriver } from '@core/loops';
import { ReactiveInboxDriver } from '@core/reactive_inbox';
import { FlightTrackingDriver } from '@core/flight_tracking';
import { DangerousWeatherDriver } from '@core/dangerous_weather';
import { IndoorAirQualityDriver } from '@core/indoor_air_quality';
import { HouseAnomalyDriver } from '@core/house_anomaly';
import { LiveSynthesisDriver } from '@core/live_synthesis';
import { UserModelObserverDriver } from '@core/user_model_observers';
import { PersonObserverDriver } from '@core/person_observers';
import { PersonObservations } from '@memory/stores/person_observations';
import { MailIdleDriver } from '@core/mail_idle';
import { HouseholdGraphDriver } from '@core/household_knowledge/driver';
import { MailShelfDriver, type ShelveMailFn } from '@core/mail_shelf';
import { save_library_item } from '@app/routes/library';
import { CalendarSource } from '@core/calendar/calendar_source';
import { ReactiveTriggerDriver } from '@core/reactive_triggers';
import { GuardFeedbackDriver } from '@core/guard_feedback';
import { synthesize_shelves } from '../../src/specialists/cordelia/shelf_synthesis';
import { bootstrap_new_specialist } from '@core/specialist_bootstrap';
import { intake_receipt } from '../../src/specialists/vivian/intake/intake_receipt';
// intake_pet_record moved INSIDE Kate's dispatcher (the 2026-07-04 Anya
// fold-in) — src/specialists/kate/intake/index.ts imports it directly.
import { intake_plant } from '../../src/specialists/eleanor/intake/intake_plant';
import { intake_band_poster } from '../../src/specialists/maggie/intake/intake_band_poster';
import { intake_food_label } from '../../src/specialists/brigid/intake/intake_food_label';
import { intake_kate } from '../../src/specialists/kate/intake';
import { intake_book } from '../../src/specialists/cordelia/intake/intake_book';
import { intake_civic_mail } from '../../src/specialists/ruby/intake/intake_civic_mail';
import { intake_listing } from '../../src/specialists/linda/intake/intake_listing';
import { intake_utility_bill } from '../../src/specialists/anna/intake/intake_utility_bill';
import { ToolLoader, type ToolRoot } from '@core/tool_loader';
import { init_location_awareness } from '@core/location_awareness';
import { kate_awareness } from '@specialists/awareness/kate';
import { vivian_awareness } from '@specialists/awareness/vivian';
// anya / marguerite / iris awareness handlers retired with the 2026-07-04
// fold-in — their specialists no longer exist, so the loop never fired them.
import { eleanor_awareness } from '@specialists/awareness/eleanor';
import { maggie_awareness } from '@specialists/awareness/maggie';
import { astrid_awareness } from '@specialists/awareness/astrid';
import { create_maggie_router } from '@specialists/maggie/router';
import { create_specialists_router, directed_build_instruction } from '@app/routes/specialists';
import { create_privacy_router } from '@app/routes/privacy';
import { create_app_router } from '@app/router';
import { create_openai_shim_router } from '@app/routes/openai_shim';
import { start_precommit_scheduler } from '@core/precommit';
import { start_scheduled_tasks_tick } from '@core/scheduled_tasks_tick';
import { create_briefs_router } from '@app/routes/briefs';
import { create_inbox_router_api } from '@app/routes/inbox';
import { create_cordelia_router } from '@app/routes/cordelia';
import { create_apns_router } from '@app/routes/apns';
import { create_sensors_router } from '@app/routes/sensors';
import { create_scrum_router } from '@app/routes/scrum';
import { create_presence_router } from '@app/routes/presence';
import { create_news_router } from '@app/routes/news';
import { create_market_radar_router } from '@app/routes/market_radar';
import { create_research_router } from '@app/routes/research';
import { create_bills_router } from '@app/routes/bills';
import { create_friends_router } from '@app/routes/friends';
import { create_imessage_router } from '@app/routes/imessage';
import { create_postoffice_router } from '@app/routes/postoffice';
import { create_brain_router } from '@app/routes/brain';
import { create_home_router } from '@app/routes/home';
import { create_voice_router } from '@app/routes/voice';
import { create_workout_router, WorkoutSessionTracker } from '@app/routes/workout';
import { register_live_throttle } from '@specialists/astrid/live_throttle';
import { register_tracker as register_tracker_state } from '@specialists/astrid/tools/get_workout_state';
import { register_tracker as register_tracker_push } from '@specialists/astrid/tools/push_coaching_note';
import { create_kate_router } from '@app/routes/kate';
import { create_media_router } from '@app/routes/media';
import { create_jobs_router } from '@app/routes/jobs';
import { kick_media_archive_detached } from '@specialists/kate/media_archive_runner';
import {
  sweep_media_archive_jobs,
  type MediaArchiveRunnerDeps,
} from '../../src/specialists/kate/media_archive_runner';
// Per-specialist library router (Knowledge namespace under
// `Knowledge/<Spec>/library/`). The `_app` suffix disambiguates from
// the file-manager library router at `@library/router` already
// imported above, which serves a totally different surface (the
// `/files` finder under `~/hearth-library/`).
import { create_library_router as create_library_router_app } from '@app/routes/library';
import { ApnsTokenStore } from '@policy/apns';
import { create_relay_router, create_app_extras_router } from '@app/routes/relay';
import { AppEventBus } from '@app/events';
import { compact_memory, memory_path } from '@core/memory_files';

// ── Configuration ──────────────────────────────────────────────────────────

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const PORT = parseInt(process.env.HEARTH_PORT ?? '7700', 10);
const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const ROLES_PATH =
  process.env.HEARTH_ROLES_PATH ?? './config/llm-roles.yaml';
const POLICY_PATH = resolve(
  process.env.HEARTH_POLICY_PATH ?? './config/policies/v0.yaml',
);
const APPROVAL_TTL_HOURS = parseInt(
  process.env.HEARTH_APPROVAL_TTL_HOURS ?? '24',
  10,
);
const SPECIALISTS_DIR = resolve(
  process.env.HEARTH_SPECIALISTS_DIR ?? './config/specialists',
);
const AUTONOMY_PATH = resolve(
  process.env.HEARTH_AUTONOMY_PATH ?? './config/autonomy.yaml',
);
const CAPABILITIES_PATH = resolve(
  process.env.HEARTH_CAPABILITIES_PATH ?? './config/capabilities.yaml',
);
// The categorized file store browsed at /files — a dedicated tree
// OUTSIDE the markdown vault (binaries don't belong in the vault).
const LIBRARY_ROOT =
  process.env.HEARTH_LIBRARY_ROOT ?? `${process.env.HOME}/hearth-library`;

// ── Wiring ─────────────────────────────────────────────────────────────────

const db = open_db(DB_PATH);
const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });
const llm = new ConfigLLMRouter(ROLES_PATH, {
  ollama_base_url: OLLAMA_URL,
  openai_base_url: process.env.OPENAI_BASE_URL,
  openai_api_key: process.env.OPENAI_API_KEY,
});
// Hot role-override layer (2026-08-01). llm-roles.yaml is readFileSync'd once
// above and has no watcher, so swapping the model behind a role used to need a
// full restart — which made the most consequential self-modification the system
// can make also the one it could not undo quickly. The router consults this
// sync source (cached ~2s) BEFORE the YAML, so `manage_llm_role{action:"revert"}`
// takes effect on the next request. Fail-open: a throwing source, no source, or
// HEARTH_LLM_ROLE_OVERRIDES=0 all resolve to the YAML config.
{
  const role_overrides = new LlmRoleOverrideStore(db);
  llm.set_override_source(() => role_overrides.active_map());
  const active = role_overrides.active_map();
  if (active.size > 0) {
    console.log(
      `[llm-roles] ${active.size} ACTIVE override(s): ` +
        [...active.entries()].map(([r, p]) => `${r}→${JSON.stringify(p)}`).join(', '),
    );
  }
}
// RAG embedder (Pass 7). Resolves the `embeddings`/`reranker` role endpoints
// from llm-roles.yaml; returns a NoopEmbedder (FTS-only) unless
// HEARTH_RAG_VECTOR is set AND an embeddings endpoint resolves — so this is
// inert until the A4000 embeddings server is stood up and the flag flipped.
const embedder = make_embedder({
  embeddings: llm.endpoint_for_role('embeddings'),
  reranker: llm.endpoint_for_role('reranker'),
});
console.log(
  `[orchestrator] RAG vector retrieval: ${embedder.enabled ? `ON (model=${embedder.model})` : 'OFF (FTS-only)'}`,
);
// Hand the same embedder to the SearchRouter so every web_search reranks its
// results with the live infinity cross-encoder (cache → SearXNG/Brave →
// rerank). Module-level, so the detached deep-research/commission runners
// (whose ctx carries no embedder) get reranking too. Degrades to cache-only
// when the embedder is the NoopEmbedder.
configure_search({ embedder });
const scribe = new Scribe();
const library = new LibraryStore({ root: LIBRARY_ROOT, db });
const gateway = new Gateway(POLICY_PATH);
gateway.watch();
const approvals = new ApprovalStore(db);

// ── Specialist runtime wiring ─────────────────────────────────────────────

// Config-extended capability tokens (config/capabilities.yaml) must load
// before specialists compile — granted_set() validates every grant. The
// watcher re-validates specialist configs when the file changes, so a
// YAML granting a freshly-added capability stops failing with no restart.
load_extra_capabilities(CAPABILITIES_PATH);

// UserRegistry must construct BEFORE SpecialistRegistry: the household
// block in config/users.yaml drives persona token substitution
// ({{user_name}}, {{pet_names}}, etc.) inside load_specialist_file().
// Without this order, specialists load with default tokens visible in
// their persona text.
const users_registry = new UserRegistry(undefined, undefined, db);
set_household_context(users_registry.household_context());

const specialists_registry = new SpecialistRegistry(SPECIALISTS_DIR);
specialists_registry.watch();
const capabilities_watcher = watch_extra_capabilities(CAPABILITIES_PATH, () =>
  specialists_registry.reload(),
);
const proposals_store = new ProposalsStore(db, load_autonomy_config(AUTONOMY_PATH));
// Hot-reload the autonomy graduation thresholds: a hand edit to
// config/autonomy.yaml (caps, approval counts, authenticity floors) is
// live on the next graduation check, no orchestrator restart — same
// chokidar posture as the policy gateway + capabilities watcher.
const autonomy_watcher = watch_autonomy_config(AUTONOMY_PATH, (cfg) =>
  proposals_store.set_config(cfg),
);
// Canonicalize proposal attribution at the store chokepoint: a filer
// given as a display name or alias ("Beatrice", "bea") resolves to the
// registered id ("trainer"); an unresolvable id throws rather than
// landing as a row no per-specialist filter can see (the 2026-06-10
// 'beatrice'/'maggia'/'all' rows). Closure reads the live registry, so
// hires/fires apply without rewiring.
proposals_store.set_specialist_resolver((cand) =>
  specialists_registry.resolve_id(cand),
);
// One-time backfill of title / summary / dedup_key for rows that
// pre-date the supersession columns. Idempotent — subsequent boots
// see no NULL rows and do nothing. Cheap (a few hundred rows max).
{
  const backfilled = proposals_store.backfill_titles();
  if (backfilled.rows_updated > 0) {
    console.log(
      `[proposals] backfilled title/summary/dedup_key for ${backfilled.rows_updated} legacy row(s)`,
    );
  }
}
// One-time triage: stamp legacy `approved` rows that never executed
// (manual/advisory kinds) as terminal `acknowledged` so they stop sitting in
// the queue forever (181 of them by 2026-06-14). Idempotent — after the first
// boot post-deploy, no rows match.
{
  const acked = proposals_store.backfill_acknowledge_stuck();
  if (acked.rows_updated > 0) {
    console.log(
      `[proposals] triaged ${acked.rows_updated} stuck approved proposal(s) → acknowledged`,
    );
  }
}
const process_misses_store = new ProcessMissStore(db);
const skills_store = new SkillsStore(db);
const conversations_store = new ConversationStore(db);
const rooms_store = new RoomsStore(db, conversations_store);
const interrupts_store = new InterruptStore(db);
const specialist_inbox = new SpecialistInbox(db);
const app_events = new AppEventBus();
const tool_registry = new ToolRegistry();
const kv_settings = new KvSettings(db);
// Directed-dispatch journal (2026-08-10): every directed deliberation the
// LoopDriver runs is journaled durable-first, so a deploy restart mid-build
// leaves a reconcilable row instead of an invisible loss. Boot reconciliation
// lives at the bottom of this file, next to the auto-deploy check.
const directed_dispatches = new DirectedDispatchStore(db);
const sessions_store = new SessionStore(db);
// Sweep expired session rows at boot — cheap, prevents the table from
// growing forever in a long-lived deploy. New rows + slide-expiry are
// handled inline by the auth middleware.
sessions_store.prune_expired();

// 2026-05-25 BACKEND_AUTH_BRIEF (hearth-ios). Bearer-token devices for
// native clients + PIN as second factor for high-risk actions. Stores
// shipped together; wiring optional in legacy deploys (auth router
// degrades gracefully when these are absent).
const devices_store = new DeviceStore(db);
const step_up_store = new StepUpStore(db);
// Prune expired + old-consumed step-up grants at boot (24h retention
// of consumed rows so the audit trail has lookback).
step_up_store.prune();

// APNs token store — registry of (device_token, environment) pairs the
// iOS app POSTs on cold launch + after auth. The push helpers fan out
// to this store; APNs is the only delivery channel.
const apns_tokens_store = new ApnsTokenStore(db);

// Wire the push pipeline. After this call, push_approval / push_text
// resolve to the real implementation. Delivery is conditional on
// `apns_configured()` returning true at send time — leaving APNS_KEY_PATH
// unset is a clean no-op (audit-only) for deployments that haven't
// enabled iOS push yet.
start_push_sweep({
  memory,
  db,
  users: users_registry,
  kv: kv_settings,
  events: app_events,
  apns_tokens: apns_tokens_store,
  // Kate-authors-the-line (kate_line.ts): the push funnel's voice pass.
  // DARK behind HEARTH_KATE_LINES; unset flag ⇒ byte-identical pushes.
  llm,
});

// Initialize the process-wide location snapshot cache. Backed by the
// iOS sensor stream (signal=location): every read returns the latest
// /api/sensors/location packet for the user, cached for snapshot_ttl
// minutes so a chat turn that calls get_current_location several
// times doesn't re-read SQLite + the payload file each call.
init_location_awareness(db, VAULT_ROOT);

const specialist_runtime = new SpecialistRuntime({
  specialists: specialists_registry,
  llm,
  memory,
  tools: tool_registry,
  proposals: proposals_store,
  inbox: specialist_inbox,
  events: app_events,
  // Household-presence join for the who's-home grounding block (2026-07-28).
  users: users_registry,
  // Lets the runtime file `runtime-affordance-gap` misses on tool-
  // round-ceiling exhaustion (2026-05-30). Without this the closed
  // loop never sees ceiling exhaustion as a structural class.
  process_misses: process_misses_store,
  // Guard-counter telemetry (2026-08-11): ceiling exhaustions and directed
  // duplicate-failure cuts increment `guard_counters` rows Mariah's
  // scan_program_health sweep reads. Fail-open inside the runtime.
  db,
  // Tier-1 procedural memory (2026-08-03) — the awareness block for skills a
  // specialist worked out and wrote down. Rendering only; the runtime never
  // executes a skill, so this widens no grant. See src/core/skills.ts.
  skills: skills_store,
  // RAG embedder (Pass 7) — turn-start auto-retrieval fuses vector + FTS
  // when enabled; NoopEmbedder otherwise (FTS-only).
  embedder,
});

// Review swarm (2026-07-21) — wire the red/blue/judge bench to the orchestrator
// singletons. When HEARTH_REVIEW_SWARM=1, a freshly-routed code change kicks off
// a detached swarm that reports findings to Kate + the live bee icon (inform-
// only; it never touches the code-teeth merge gate). DARK by default.
configure_review_swarm({
  runtime: specialist_runtime,
  events: app_events,
  db,
  inbox: specialist_inbox,
});

// Dynamic tool discovery. The ToolLoader scans the tool roots, registers
// every tool it finds, then (after watch()) hot-reloads on file change —
// a tool added or fixed in a merged PR goes live with no orchestrator
// restart. This replaces the former static tool_registry.register(...)
// block. Constructed after specialist_runtime because some tool
// factories (e.g. ingest_to_library) need it in their dependency bag.
const REPO_ROOT = resolve(import.meta.dir, '../..');
const tool_roots: ToolRoot[] = [
  { dir: resolve(REPO_ROOT, 'src/connectors') },
  { dir: resolve(REPO_ROOT, 'src/tools') },
  { dir: resolve(REPO_ROOT, 'src/specialists'), pattern: /[/\\]tools[/\\]/ },
];
const tool_loader = new ToolLoader({
  registry: tool_registry,
  roots: tool_roots,
  deps: {
    db,
    vault_root: VAULT_ROOT,
    memory,
    llm,
    proposals: proposals_store,
    inbox: specialist_inbox,
    interrupts: interrupts_store,
    conversations: conversations_store,
    specialists: specialists_registry,
    runtime: specialist_runtime,
    events: app_events,
    process_misses: process_misses_store,
    tool_registry,
    library,
    users: users_registry,
    // Embed-at-ingest for tool-path library shelving (curate /
    // refresh_subscriptions / acquire_knowledge) — same embedder the
    // routes use; NoopEmbedder when HEARTH_RAG_VECTOR is off.
    embedder,
    // Scoped-deliberation waker for driver tools (Case Driver). Late-bound:
    // loop_driver is constructed below; the closure only fires when a job
    // tool ticks, long after boot.
    wake_scoped: (id, opts) => loop_driver.wake_deliberation_scoped(id, opts),
    // Directed-build fire for the Proposal Court's approve path (2026-07-20)
    // — the same detached build the decide route fires (PR #95). Runs as the
    // BUILD_AGENT (Kate) since the 2026-07-21 Beatrice consolidation; the
    // ledger/merge authority stays under BUILD_LEDGER_ID.
    // Late-bound like wake_scoped; only fires from a court convening.
    fire_directed_build: (proposal) => {
      void loop_driver
        .fire_deliberation_now(
          BUILD_AGENT_ID,
          'build',
          {
            instruction: directed_build_instruction(proposal, { vault_root: VAULT_ROOT }),
            tools: ARCHITECT_BUILD_TOOLS,
            max_tokens: 8000,
          },
          undefined,
          { source: 'court', proposal_id: proposal.id },
        )
        .catch((err) => {
          console.error(
            `[court] directed build for approved proposal ${proposal.id} failed:`,
            err,
          );
        });
    },
  },
});
await tool_loader.load_all();
await tool_loader.watch();

// Schema lint (born-aligned gate) — warn on tool schemas that fight a small
// model (a regex `pattern` that silently disables the GBNF grammar, a required
// field whose conventional synonym the model emits, an over-wide required set).
// Warn-only; the central recovery + verify-before-claim are the runtime net.
// HEARTH_TOOL_LINT=0 silences it.
if (process.env.HEARTH_TOOL_LINT !== '0') {
  const lint_warnings = tool_registry.lint();
  if (lint_warnings.length > 0) {
    console.warn(
      `[tool-lint] ${lint_warnings.length} tool(s) have schema shapes that fight a small model:`,
    );
    for (const { tool, warnings } of lint_warnings) {
      for (const w of warnings) console.warn(`[tool-lint]   ${tool}: ${w}`);
    }
  }
}

const loop_driver = new LoopDriver({
  db,
  memory,
  specialists: specialists_registry,
  runtime: specialist_runtime,
  proposals: proposals_store,
  interrupts: interrupts_store,
  inbox: specialist_inbox,
  // For per-specialist background_jobs declared in YAML (Pass 7.5+).
  tools: tool_registry,
  llm,
  process_misses: process_misses_store,
  events: app_events,
  // Per-user identity store, so Kate's brief context puller can
  // resolve per-user home coords for weather (each household member
  // sees weather at THEIR home, not Jasper's).
  users: users_registry,
  // For awareness sweeps that deliver a proactive chat message (the
  // visitor ask-back lands Kate's "who was that?" in the owner's thread).
  conversations: conversations_store,
  // Directed fires journal here before running; boot reconciliation below
  // re-fires anything a restart killed mid-build.
  dispatch_journal: directed_dispatches,
});
loop_driver.register_awareness(kate_awareness);
loop_driver.register_awareness(vivian_awareness);
loop_driver.register_awareness(eleanor_awareness);
loop_driver.register_awareness(maggie_awareness);
loop_driver.register_awareness(astrid_awareness);

// Reactive inbox driver — Cordelia visual-understanding pipeline.
// Subscribes to `capture_received` events, runs the classifier, fans
// out routed captures to per-specialist intake handlers. Runs in
// parallel to the deliberation loop; failures don't block the
// existing path (the wrapper note + chokidar projection remains the
// durable record).
const reactive_inbox = new ReactiveInboxDriver({
  db,
  memory,
  llm,
  specialists: specialists_registry,
  inbox: specialist_inbox,
  interrupts: interrupts_store,
  events: app_events,
  conversations: conversations_store,
  runtime: specialist_runtime,
  users: users_registry,
  vault_root: VAULT_ROOT,
  embedder,
});
reactive_inbox.register_intake('vivian', intake_receipt);
reactive_inbox.register_intake('eleanor', intake_plant);
reactive_inbox.register_intake('maggie', intake_band_poster);
reactive_inbox.register_intake('brigid', intake_food_label);
reactive_inbox.register_intake('kate', intake_kate);
reactive_inbox.register_intake('cordelia', intake_book);
reactive_inbox.register_intake('ruby', intake_civic_mail);
reactive_inbox.register_intake('linda', intake_listing);
reactive_inbox.register_intake('anna', intake_utility_bill);

// Self-live (2026-06-15 #3): the Second Brain re-distills a shelf the MOMENT
// material is routed onto it, not at the nightly 04:20. Debounced + rate-limited
// + scoped to the one shelf; the capture_routed event carries the destinations.
// Autonomous, no owner surface. Kill switch: HEARTH_LIVE_SYNTHESIS=0.
const live_synthesis = new LiveSynthesisDriver((ids) =>
  synthesize_shelves(
    {
      library_deps: {
        db,
        vault_root: VAULT_ROOT,
        memory,
        specialists: specialists_registry,
        runtime: specialist_runtime,
        conversations: conversations_store,
        llm,
        embedder,
        events: app_events,
      },
    },
    { only_shelf_ids: ids, force: true },
  ),
);
live_synthesis.attach(app_events);

// Per-user model observers (2026-06-20): the AFFERENT feed for the unified
// per-user model (src/core/user_model.ts). Mines the exhaust the system already
// emits — capture_routed → an interests observation for the capturing user,
// a user message_added → a debounced routines observation for the conversation
// owner — into cheap record_observation calls (no LLM at intake). The nightly
// sweep_user_models job distills them. CORDONED (each observation under its own
// user_id), fail-open, and DARK until HEARTH_USER_MODEL=1 (every handler
// early-returns when off → a pure no-op).
const user_model_observers = new UserModelObserverDriver({
  facets: memory.user_profiles,
  conversation_owner: (id) => conversations_store.get(id)?.user_id ?? null,
  timezone_for: (uid) => users_registry.get_timezone(uid),
});
user_model_observers.attach(app_events);

// People observational engine (2026-06-22, A+D): the AFFERENT feed for the
// People reasoning substrate. The sibling of user_model_observers, but the
// subject is OTHER people — mines the same exhaust into provenance-stamped
// `person_observations` (a chat mention / a routed capture name-matched to a
// known person), so the Friends layer keeps each person current on its own.
// CORDONED (matches only people the signal's user can see; the observation
// inherits the person's private_to), fail-open, and DARK until
// HEARTH_PERSON_OBSERVERS=1 (every handler early-returns when off → no-op).
// iMessage (via the macOS app's chat.db) / Discord / presence / calendar drop
// in here as additional cases — the engine is signal-agnostic.
const person_observations = new PersonObservations(db);
const person_observers = new PersonObserverDriver({
  observations: person_observations,
  memory,
  conversation_owner: (id) => conversations_store.get(id)?.user_id ?? null,
  tier_for: (uid) => users_registry.get(uid)?.tier ?? 'friend',
});
person_observers.attach(app_events);

// Wake-on-flag wiring: subscribe to inbox_message_added events and
// nudge the loop driver to wake the recipient's deliberation if their
// YAML opts in (proactive.wake_on_flag: true). Debouncing lives in
// LoopDriver — this listener just forwards the signal.
// Wake-eligible kinds: flag (peer escalation) AND question (peer ask
// requiring action). FYI and consult_response are passive — they
// don't wake. Severity must be at least medium.
app_events.subscribe((ev) => {
  if (ev.type !== 'inbox_message_added') return;
  if (ev.kind !== 'flag' && ev.kind !== 'question') return;
  const sev = ev.severity;
  if (sev !== 'medium' && sev !== 'medium-high' && sev !== 'high') return;
  loop_driver.wake_deliberation(
    ev.to_specialist_id,
    `inbox ${ev.kind} from ${ev.from_specialist_id} (${sev})`,
  );
});

// Reactive triggers (2026-06-18): wake a specialist's deliberation on a
// real-world EVENT — a location flip → home arrival wakes Luna — instead of
// only on the deliberation_at clock. Edge-detected off the AppEventBus, then
// fired through loop_driver.wake_deliberation_scoped (debounce + per-key
// min-interval, deep tier only — never the interactive tier). Specialists opt
// in via proactive.triggers in their YAML; with none subscribed the roster is
// unchanged. Kill switch HEARTH_REACTIVE_TRIGGERS=0 makes attach() a no-op.
const reactive_triggers = new ReactiveTriggerDriver({
  specialists: specialists_registry,
  waker: loop_driver,
  // The home anchor resolver is how the home defs decide home-ness from a
  // packet's coordinates (live iOS payloads carry no place_id). Passed as a
  // FUNCTION, not a snapshot, so an edit to config/users.yaml `home_location`
  // takes effect on the next edge without a restart (users.yaml hot-reloads).
  trigger_deps: { memory, home_anchor: (uid) => users_registry.home_coords(uid) },
});
reactive_triggers.attach(app_events);

// Live flight tracking (2026-06-21): an adaptive-cadence poll of the
// tracked_flights watch-list that pushes the watcher the moment a flight is
// delayed / departs / lands / changes gate / assigns a baggage belt. Outbound-
// only (no inbound webhook → no public ingress). DARK until
// HEARTH_FLIGHT_TRACKING=1; attach() is a no-op otherwise.
const flight_tracking = new FlightTrackingDriver({ db, events: app_events });
flight_tracking.attach();

// Dangerous-weather alerts (2026-06-23): a 60s ticker that edge-detects a real
// danger from the WeatherFlow Tempest (close active lightning, extreme wind
// gust) + Pirate's NWS severe-weather warnings, and on the false→true edge
// alerts the household BOTH ways — speaks it over the Satellite1 (if anyone's
// home + near) AND pushes every home member at `high` severity (pierces quiet
// hours). Deterministic delivery (no LLM in the safety loop). DARK until
// HEARTH_DANGEROUS_WEATHER=1; attach() is a no-op otherwise. Fail-open per tick.
const dangerous_weather = new DangerousWeatherDriver({
  db,
  memory,
  users: users_registry,
  coordinator_url: process.env.HEARTH_VOICE_COORDINATOR_URL,
  bearer: process.env.HEARTH_INTERNAL_BEARER,
});
dangerous_weather.attach();

// Indoor air-quality alerts (2026-06-25): the indoor sibling of the weather
// driver — a 60s ticker over the AirThings monitors (CO₂ / radon / VOC / PM2.5)
// + the cameras' CO/smoke-alarm detection. CO₂ is acute here (a kegerator CO₂
// cylinder leak pools low where the dogs are) → chime then EBS klaxon; a CO/smoke
// alarm → klaxon; radon/VOC/PM2.5 → gentle chime. Shares the once-per-episode +
// relief-valve cadence engine; alerts as Kate (push + Satellite1). Deterministic.
// DARK until HEARTH_AIR_QUALITY_ALERTS=1; attach() is a no-op otherwise.
const indoor_air_quality = new IndoorAirQualityDriver({
  db,
  memory,
  users: users_registry,
  coordinator_url: process.env.HEARTH_VOICE_COORDINATOR_URL,
  bearer: process.env.HEARTH_INTERNAL_BEARER,
});
indoor_air_quality.attach();

// House not-keeping-up alerts (2026-07-13, house-fusion Phase 3): a 5-min
// ticker over the thermostat — the equipment ran the whole window while the
// temperature moved the WRONG way → push (heating + below-freezing outside =
// CRITICAL, pipe risk; else a notice chime). Same episodic engine as the
// weather/air drivers; deterministic, model never in the loop. Trend/efficiency
// analysis deliberately lives in Kate's deliberation over house_thermal_history
// + the nightly ledger, NOT here. DARK until HEARTH_HOUSE_ANOMALY=1.
const house_anomaly = new HouseAnomalyDriver({
  db,
  memory,
  users: users_registry,
  coordinator_url: process.env.HEARTH_VOICE_COORDINATOR_URL,
  bearer: process.env.HEARTH_INTERNAL_BEARER,
});
house_anomaly.attach();

// Post Office (2026-06-20): Kate's pulse on Jasper's email. A poll backbone
// (sync_all on an interval — the correctness guarantee) + a best-effort IMAP
// IDLE listener per account (the push path) that ingests + triages new mail
// into the mail_messages projection. DARK until HEARTH_MAIL=1; attach() is a
// no-op otherwise. Fail-open: a throwing account is logged + skipped.
const mail_idle = new MailIdleDriver({ db, llm, events: app_events, users: users_registry });
mail_idle.attach(app_events);

// Household Knowledge Graph — the first SIGNAL SOURCE fan-out. Subscribes to
// `order_upserted` (emitted by mail_ingest) and turns each order into a typed
// household_good node + inference edges, fanning the slice to Vivian (cost) +
// Luna (warranty/manual); Kate reads the running picture. DARK until
// HEARTH_HOUSEHOLD_GRAPH=1; attach() is a no-op otherwise. Fail-open.
const household_graph = new HouseholdGraphDriver({
  events: app_events,
  memory,
  db,
  inbox: specialist_inbox,
  users: users_registry,
});
household_graph.attach();

// Mail second-brain shelving — significant non-bulk mail → save_library_item
// (vault note + chunks_fts + embeddings), RAG-searchable + feeding the knowledge
// graph, stamped private_to the account OWNER (mail never leaks cross-user via
// RAG). The save_library_item call is injected so src/core stays @app-value-free.
// DARK until HEARTH_MAIL_SHELVE=1; attach() is a no-op otherwise. Fail-open.
const shelve_mail: ShelveMailFn = async (input) => {
  const spec = specialists_registry.get('kate');
  if (!spec) return false;
  const saved = await save_library_item(
    {
      db,
      vault_root: VAULT_ROOT,
      memory,
      specialists: specialists_registry,
      runtime: specialist_runtime,
      conversations: conversations_store,
      llm,
      embedder,
      events: app_events,
    },
    { filename: input.filename, mime_type: 'text/markdown', text: input.markdown },
    spec,
    { source: 'file', quality_gate: 'off', private_to: input.user_id },
  );
  return !('rejected' in saved);
};
const mail_shelf = new MailShelfDriver({ events: app_events, db, shelve: shelve_mail });
mail_shelf.attach();

// Calendar signal source (Phase 2) — the 2nd source on the generic SignalRouter.
// On each iOS calendar snapshot, attribute new events to a household member
// (the fusion engine — calendar/organizer/location/learned), write an
// attributed life_event, and deliver Kate a batched calendar FYI (with any
// "whose is this?" asks). DARK until HEARTH_CALENDAR_GRAPH=1; fail-open.
const calendar_source = new CalendarSource({
  events: app_events,
  memory,
  db,
  inbox: specialist_inbox,
  users: users_registry,
});
calendar_source.attach();

// Guard-feedback (2026-06-22): a finalize reply-guard catch (fabricated save/
// action, ghost promise, answered-over read failure, data-denial, ungrounded
// claim) or an unrecovered tool-arg failure emits a `quality_signal`; this
// driver aggregates RECURRENCES per (class, guard, tool/specialist) and, on the
// edge, files a process_miss (Mariah's ledger) + scoped-wakes Beatrice with a
// directed diagnostic task — the instant, event-driven sibling of the nightly
// scans. Same wake spine as the reactive triggers (deep tier, debounced). Meta-
// agents' own catches are skipped (no Beatrice-diagnoses-Beatrice loop).
// Kill switch HEARTH_GUARD_FEEDBACK=0 → attach() is a no-op.
const guard_feedback = new GuardFeedbackDriver({
  specialists: specialists_registry,
  waker: loop_driver,
  process_misses: process_misses_store,
  memory,
});
guard_feedback.attach(app_events);

// ── Media Archive sweep (2026-07-11) ──────────────────────────────────────
// Crash-recovery + liveness: re-kick any OPEN media_archive_jobs at boot and on
// a periodic tick. The archive_url tool's detached kick fires only at creation,
// so a job stranded by a transient error or a mid-run restart would otherwise
// never resume. Kill switch HEARTH_MEDIA_ARCHIVE=0 makes the sweep a no-op.
const media_runner_deps: MediaArchiveRunnerDeps = {
  memory,
  llm,
  db,
  vault_root: VAULT_ROOT,
  archive_root: process.env.HEARTH_MEDIA_ARCHIVE_ROOT ?? './data/media-archive',
  embedder,
  inbox: specialist_inbox,
  events: app_events,
};
sweep_media_archive_jobs(media_runner_deps);
setInterval(() => sweep_media_archive_jobs(media_runner_deps), 5 * 60_000).unref();

// On-hire knowledge bootstrap wiring: every time a new specialist
// YAML appears (modal hire, agentic /from-packet hire, direct YAML
// write, git pull), fire the bootstrap helper. The registry
// suppresses the listener on the constructor's initial load so cold
// start doesn't re-fire for every existing specialist; chokidar-
// triggered reloads downstream do fire it. See
// src/core/specialist_bootstrap.ts for the full rationale.
specialists_registry.on_specialist_added((id) => {
  bootstrap_new_specialist(id, {
    specialists: specialists_registry,
    inbox: specialist_inbox,
    events: app_events,
    memory,
  });
});

// Don't start loops during smoke tests — they'd interfere with deterministic
// audit counts and would fire deliberation against a test LLM.
if (process.env.HEARTH_DISABLE_LOOPS !== '1') {
  loop_driver.start();
  reactive_inbox.start();
  // Pre-commit scheduler: 5s tick, sweeps kate_filter_queue for
  // disposition='precommit_pending' rows whose executes_at has
  // passed and marks them outcome='executed' with the
  // precommit_executed AppEvent fired so iOS can end the Live
  // Activity. v0.1 does NOT yet invoke dispatch_tool — when a
  // specialist tool actually creates pre-commits, wire the
  // dispatch through tool_registry here.
  start_precommit_scheduler(db, app_events);
  // Scheduled-tasks tick — the former apps/scheduler process folded
  // in-process (2.0 P0). Fires due scheduled_tasks rows (followup delivery,
  // the nightly eval run) against this same server; first cycle is one poll
  // interval after boot so the listener is up. Self-reseeds the nightly-eval
  // rows (idempotent keys), replacing scripts/schedule-nightly-evals.ts.
  start_scheduled_tasks_tick({ db, memory, base_url: `http://localhost:${PORT}` });
}

// ── HTTP ───────────────────────────────────────────────────────────────────

const app = new Hono({ strict: false });

// ── Auth (Phase 1 multi-user) ──────────────────────────────────────────────
// Mount BEFORE any other routes so every downstream request runs
// through the gate. The middleware allow-lists /api/auth/*, /status,
// /musickit-auth, and the /app login-page static assets. Everything else
// needs a session cookie.
app.route('/api', create_auth_router({
  users: users_registry,
  sessions: sessions_store,
  devices: devices_store,
  step_up: step_up_store,
  memory,
}));
app.use('*', create_auth_middleware({
  users: users_registry,
  sessions: sessions_store,
  devices: devices_store,
}));

// OpenAI-compatible chat-completions shim → Kate. Gated by the auth
// middleware above (HA's voice agent sends a mint:service-bearer token as
// its api_key); bridges OpenAI chat-completions onto Kate's full runtime
// via the conversation API + in-process event bus. See routes/openai_shim.ts.
app.route('/v1', create_openai_shim_router({ events: app_events }));

// Phase 2b admin surface — gated by `role === 'admin'` inside the
// router itself (the auth middleware above already proved a session
// exists; admin.ts proves the session belongs to an admin).
app.route('/api', create_admin_router({ users: users_registry }));

// Manual deliberation trigger — invokes a specialist's deliberation
// pass synchronously, off-schedule. Useful when you've just landed
// a flag in someone's inbox and don't want to wait for their next
// scheduled slot. Returns when the pass completes (or fails). Slot
// defaults to '00:00' (the canonical "ad-hoc reflection" slot) but
// can be overridden — for Kate, '07:00' / '12:30' / '18:00' /
// '22:00' are her report-time slots that produce a brief.
app.post('/api/specialists/:id/fire_deliberation', async (c) => {
  const id = c.req.param('id');
  if (!specialists_registry.get(id)) {
    return c.json({ error: `unknown specialist: ${id}` }, 404);
  }
  const slot = c.req.query('slot') ?? '00:00';

  // Per-user brief fire (2026-06-17): `?user_id=sam` runs Kate's brief pass FOR
  // that user — the same per-user fan-out the scheduled slot does, on demand
  // (regenerate a household member's brief / diagnose a missing one). Firing
  // another user's brief is owner-only; a user may refire their own.
  const fire_user_id = c.req.query('user_id') ?? undefined;
  if (fire_user_id) {
    const caller = c.get('user') as { id?: string; tier?: string } | undefined;
    if (caller?.tier !== 'owner' && caller?.id !== fire_user_id) {
      return c.json({ error: 'firing another user’s brief is owner-only' }, 403);
    }
  }

  // Owner-directed task (the on-demand "build" channel): an optional JSON body
  // `{ task, tools?, max_tokens? }` makes this pass execute that one directive
  // on the strong model with a focused tool surface, instead of the standing
  // audit/grooming work. The directive can author CODE (propose_code_change),
  // so it's owner-gated — and the work still routes through Kate's skeptic
  // review + the owner merge gate; nothing auto-merges. Body is optional, so a
  // plain off-schedule fire (no body) is unchanged.
  let directed_task: DirectedTask | undefined;
  let body_raw: unknown;
  try {
    body_raw = await c.req.json();
  } catch {
    body_raw = undefined;
  }
  if (body_raw && typeof body_raw === 'object' && body_raw !== null) {
    const b = body_raw as Record<string, unknown>;
    if (typeof b.task === 'string' && b.task.trim().length > 0) {
      const caller = c.get('user') as { tier?: string } | undefined;
      if (caller?.tier !== 'owner') {
        return c.json({ error: 'directed deliberation tasks are owner-only' }, 403);
      }
      directed_task = {
        instruction: b.task,
        ...(Array.isArray(b.tools)
          ? { tools: b.tools.filter((t): t is string => typeof t === 'string') }
          : {}),
        ...(typeof b.max_tokens === 'number' ? { max_tokens: b.max_tokens } : {}),
        // Per-pass round budget (2026-08-11). Omitted → the directed default
        // (HEARTH_DIRECTED_TOOL_ROUNDS, 30) applies in the deliberation
        // channel; the runtime clamps to TOOL_ROUNDS_OVERRIDE_CAP.
        ...(typeof b.max_tool_rounds === 'number' && Number.isFinite(b.max_tool_rounds)
          ? { max_tool_rounds: Math.floor(b.max_tool_rounds) }
          : {}),
        // Per-pass thinking override (S4 scrutiny). Omitted → directed passes
        // default think-ON only under HEARTH_SCRUTINY_THINK=1, which the
        // 2026-07-02 bench says to leave unset (no accuracy gain, 14× cost).
        ...(typeof b.think === 'boolean' ? { think: b.think } : {}),
      };
    }
  }

  // Detached + tracked: kick the pass off, return immediately, and record its
  // real completion in `job_runs` under DELIBERATION_JOB_KEY so the Recon Desk
  // gear can poll it to an honest checkmark (a research pass can run minutes —
  // longer than the proxy read timeout — so it can't be awaited inline).
  if (c.req.query('detached') === '1') {
    job_runs.start(id, DELIBERATION_JOB_KEY);
    void (async () => {
      try {
        await loop_driver.fire_deliberation_now(id, slot, directed_task, fire_user_id, {
          source: 'fire_deliberation',
        });
        job_runs.finish(id, DELIBERATION_JOB_KEY, true);
      } catch (err) {
        job_runs.finish(id, DELIBERATION_JOB_KEY, false, err instanceof Error ? err.message : String(err));
      }
    })();
    return c.json({ ok: true, started: true, specialist_id: id, slot, directed: Boolean(directed_task), user_id: fire_user_id });
  }
  const t0 = performance.now();
  try {
    await loop_driver.fire_deliberation_now(id, slot, directed_task, fire_user_id, {
      source: 'fire_deliberation',
    });
    return c.json({
      ok: true,
      specialist_id: id,
      slot,
      directed: Boolean(directed_task),
      duration_ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        specialist_id: id,
        slot,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Math.round(performance.now() - t0),
      },
      500,
    );
  }
});

// Manual reactive-trigger fire (debug/test). Fires a specialist's scoped wake
// on demand — bypassing the event + edge-detection + debounce + min_interval —
// so a trigger is verifiable without staging real sensor data or restarting to
// clear in-memory edge-state (the friction hit verifying home_arrival). The
// task comes from the specialist's YAML subscription, so the fired pass matches
// the real one. Owner-only (it spends a deep-tier deliberation). Mirrors
// fire_deliberation / fire_background_job; same /api/specialists namespace, no
// nginx edit. Fire-and-return — read the outcome from the logs / audit_log
// (tool_name=reactive_trigger_fired) like the detached deliberation path.
app.post('/api/specialists/:id/fire_trigger', async (c) => {
  const caller = c.get('user') as { tier?: string } | undefined;
  if (caller?.tier !== 'owner') {
    return c.json({ error: 'fire_trigger is owner-only' }, 403);
  }
  const id = c.req.param('id');
  const spec = specialists_registry.get(id);
  if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);
  const subs = spec.proactive?.triggers ?? [];
  const def = c.req.query('def');
  if (!def) {
    return c.json({ error: 'pass ?def=<trigger def name>', available: subs.map((t) => t.def) }, 400);
  }
  const sub = subs.find((t) => t.def === def);
  if (!sub) {
    return c.json(
      { error: `${id} has no trigger subscription for def '${def}'`, available: subs.map((t) => t.def) },
      404,
    );
  }
  // Force an immediate fire: zero debounce + zero min_interval bypass the
  // production thrash guards (irrelevant for a one-shot manual test). A
  // `:manual` dedupe_key keeps its rate-limit slot separate from a real edge's.
  loop_driver.wake_deliberation_scoped(id, {
    task: sub.task,
    reason: `manual fire_trigger of ${def} (owner test)`,
    dedupe_key: `${def}:manual`,
    debounce_ms: 0,
    min_interval_ms: 0,
  });
  return c.json({ ok: true, fired: { specialist: id, def, task: sub.task } });
});

// Behavioral eval run — the golden-task regression suite (src/core/evals).
// Replays curated past-failure scenarios against the LIVE personas + LIVE
// model with fixture tools; results land in eval_runs; a pass→fail
// regression files a process_miss (eval:<task_id>) into Mariah's ledger.
// Owner/internal only; detached (the suite makes several real LLM turns).
// Fired nightly by the scheduler (scripts/schedule-nightly-evals.ts) and
// on demand after a persona/prompt/model change.
app.post('/api/evals/run', async (c) => {
  const caller = c.get('user') as { tier?: string } | undefined;
  if (caller && caller.tier !== 'owner') {
    return c.json({ error: 'eval runs are owner-only' }, 403);
  }
  const { GOLDEN_TASKS } = await import('@core/evals/golden_tasks');
  const { run_all_golden } = await import('@core/evals/harness');
  void (async () => {
    try {
      const { results, regressions } = await run_all_golden({
        tasks: GOLDEN_TASKS,
        llm,
        config_dir: SPECIALISTS_DIR,
        live_db: db,
        model_label: 'live',
        // Sample each task rather than running it once (2026-08-05). A single
        // run per night could not distinguish a real regression from model
        // stochasticity — over 2026-08-03..05 three tasks flipped pass↔fail on
        // consecutive nights with no code change between them, which is wider
        // noise than any persona change worth detecting. Majority-of-N.
        // 3 × 18 tasks is a few extra minutes on a detached overnight run.
        samples: Math.max(1, Number(process.env.HEARTH_EVAL_SAMPLES ?? 3)),
        log: (line) => console.log(line),
      });
      const passed = results.filter((r) => r.passed).length;
      console.log(
        `[evals] suite done: ${passed}/${results.length} passed, ${regressions} regression(s)`,
      );
      // Post-run diagnosis (2026-08-03). The suite has always said WHAT broke
      // and change_measurement has always said whether a fix HELPED; the hole
      // between them was that nothing read a failure and asked WHY — a red
      // task filed a process_miss and waited for a human. This closes it.
      // Diagnoses only; APPLIES NOTHING; files at most a Kate-gated proposal,
      // and only when HEARTH_EVAL_EVOLUTION_FILE is also set. Dark by default.
      try {
        const { run_eval_evolution_pass } = await import('@core/eval_diagnosis');
        await run_eval_evolution_pass(
          {
            failing: results.filter((r) => !r.passed).map((r) => r.task_id),
            tasks: GOLDEN_TASKS,
            log: (line) => console.log(line),
          },
          {
            db,
            tools: tool_registry,
            specialists: specialists_registry,
            llm,
            proposals: proposals_store,
          },
        );
      } catch (err) {
        // The post-mortem must never cost us the run it is analysing.
        console.error('[eval-evolution] pass failed:', err);
      }
      memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: 'eval_suite_run',
        tool_input: { tasks: results.length },
        execution_result: {
          passed,
          failed: results.length - passed,
          regressions,
          failing: results.filter((r) => !r.passed).map((r) => r.task_id),
        },
      });
    } catch (err) {
      console.error('[evals] suite crashed:', err);
    }
  })();
  return c.json({ ok: true, started: true, tasks: GOLDEN_TASKS.length });
});

// Manual background-job trigger — runs a specialist's background job(s)
// off-schedule. `?name=<job>` runs one; `?all=1` runs every job in the
// specialist's YAML order (the dependency order). The scheduled sweeps only
// fire on the clock; this is the on-demand lever (first-run populate, re-run
// after a config change). Each invoked tool enforces its own capability grant
// + logs its own audit action — so results are always observable in audit_log.
//
// DETACHED BY DEFAULT: heavy browser jobs (drive_configurator, scans) run for
// minutes — longer than the nginx proxy read timeout — so awaiting them in the
// request truncates the run (504 → client disconnect → the loop dies mid-way,
// e.g. after HP before Dell, with no result written). So the route fires the
// job(s) in the background and returns immediately; read outcomes from the
// audit log / store. Pass `?wait=1` to AWAIT instead (only for fast jobs whose
// result you want inline — extract_*/cluster/assess/lookup, not the browser
// ones).
app.post('/api/specialists/:id/fire_background_job', async (c) => {
  const id = c.req.param('id');
  const spec = specialists_registry.get(id);
  if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);
  const jobs = spec.proactive?.background_jobs ?? [];
  const name = c.req.query('name');
  const all = c.req.query('all') === '1';
  const wait = c.req.query('wait') === '1';
  if (!name && !all) {
    return c.json({ error: 'pass ?name=<job> or ?all=1 (add ?wait=1 to await fast jobs)', available: jobs.map((j) => j.name) }, 400);
  }
  if (name && !jobs.some((j) => j.name === name)) {
    return c.json({ error: `unknown background job '${name}' for ${id}`, available: jobs.map((j) => j.name) }, 404);
  }
  const to_run = all ? jobs.map((j) => j.name) : [name as string];

  // Run each job in YAML order, sequentially, capturing per-job outcomes.
  const runAll = async () => {
    const results: Array<{ name: string; ok: boolean; result?: unknown; error?: string; duration_ms: number }> = [];
    for (const n of to_run) {
      const j0 = performance.now();
      // Track start/finish so a detached caller (the Recon Desk gear) can poll
      // this job to an actual completion checkmark via the status route below.
      job_runs.start(id, n);
      try {
        const outcome = await loop_driver.fire_background_job_now(id, n);
        const ok = outcome?.ok ?? false;
        const error = outcome ? (outcome.ok ? undefined : `${outcome.reason ?? 'failed'}: ${outcome.error ?? ''}`) : 'job not run (missing deps or job)';
        job_runs.finish(id, n, ok, error);
        results.push({
          name: n,
          ok,
          result: outcome?.ok ? outcome.result : undefined,
          error,
          duration_ms: Math.round(performance.now() - j0),
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        job_runs.finish(id, n, false, error);
        results.push({ name: n, ok: false, error, duration_ms: Math.round(performance.now() - j0) });
      }
    }
    return results;
  };

  if (wait) {
    const t0 = performance.now();
    const results = await runAll();
    return c.json({ ok: results.every((r) => r.ok), specialist_id: id, ran: results.length, results, duration_ms: Math.round(performance.now() - t0) });
  }

  // Detached: don't await — the run survives the request, so a multi-minute
  // browser job can't be cut off by a proxy/client timeout. Read results from
  // the audit log when it completes.
  void runAll().catch((err) => console.error(`[fire_background_job] ${id} background run failed:`, err));
  return c.json({
    ok: true,
    started: true,
    specialist_id: id,
    jobs: to_run,
    note: 'running in background — poll GET /api/specialists/:id/background_jobs/status for actual completion (or pass ?wait=1 to await fast jobs inline)',
  });
});

// Completion status of a specialist's on-demand background-job + deliberation
// runs (the ones fired detached above). The Recon Desk gear polls this to flip
// each step's spinner to a real checkmark when the job actually concludes, and
// to seed persistent checkmarks when the gear is re-opened. The deliberation
// pass is tracked under DELIBERATION_JOB_KEY. A job that never ran this
// orchestrator lifetime is simply absent from the map.
app.get('/api/specialists/:id/background_jobs/status', (c) => {
  const id = c.req.param('id');
  if (!specialists_registry.get(id)) {
    return c.json({ error: `unknown specialist: ${id}` }, 404);
  }
  return c.json({ specialist_id: id, jobs: job_runs.for_specialist(id) });
});

const IntentSchema = z.object({
  text: z.string().min(1).max(8000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .default([]),
});

/**
 * User-facing changelog — parsed from CHANGELOG.md at the repo root.
 * Distinct from the engineering ship log at docs/archive/shipped-*.md:
 * CHANGELOG.md is human-readable "what changed for you" bullets that
 * iOS surfaces when Jasper long-presses the flame icon on Today.
 *
 * No auth — the changelog is freely readable. Parser is intentionally
 * minimal: H2 headers (`## YYYY-MM-DD` or `## Earlier`) become section
 * boundaries; `- ` bullets become entries; any other markdown is
 * dropped. The result is a flat list of sections, each with a heading
 * and an ordered array of human-readable strings.
 */
app.get('/api/changelog', async (c) => {
  const path = resolve(REPO_ROOT, 'CHANGELOG.md');
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return c.json({ sections: [] });
  }
  const sections: Array<{ heading: string; entries: string[] }> = [];
  let current: { heading: string; entries: string[] } | null = null;
  for (const line of raw.split('\n')) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && h2[1]) {
      current = { heading: h2[1], entries: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^-\s+(.+?)\s*$/.exec(line);
    if (bullet && bullet[1] && current) {
      // Strip markdown emphasis runs (`**bold**`, `*ital*`) to a
      // single human sentence; preserve in-line backticks since
      // they're rare and reading "fine on small surfaces.
      const text = bullet[1]
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');
      current.entries.push(text);
    }
  }
  return c.json({ sections });
});

app.get('/status', (c) =>
  c.json({
    service: 'hearth-orchestrator',
    version: '0.0.1',
    vault_root: VAULT_ROOT,
    db_path: DB_PATH,
    ollama_url: OLLAMA_URL,
    // openai_base_url comes from .env OR a systemd Environment= line —
    // exposing it here means tooling (e.g. scripts/doctor.ts) can read
    // the actual runtime value without having to scrape systemd. The
    // API key is NEVER exposed; URL only.
    openai_base_url: process.env.OPENAI_BASE_URL ?? null,
    uptime_s: Math.round(process.uptime()),
    agents: ['scribe'],
    tools: {
      scribe: Array.from(scribe.tools.keys()),
      specialist: tool_registry.list().map((t) => t.name),
      // Non-empty means a tool module failed to (re)load, so the registry
      // above is serving a PREVIOUS version of that module's tools — the
      // running set no longer matches the tree and needs a restart. A
      // reload failure must be visible here, not only in the log.
      stale: tool_loader.stale_entries(),
    },
    specialists: specialists_registry.list().map((s) => ({
      id: s.id,
      role: s.role,
      default_landing: s.default_landing,
    })),
    features: ['inbox', 'approvals', 'specialists', 'app', 'library'],
    policy: gateway.describe(),
    loops_running: process.env.HEARTH_DISABLE_LOOPS !== '1',
    sse_subscribers: app_events.size(),
  }),
);

app.route('/inbox', create_inbox_router({ vault_root: VAULT_ROOT, memory }));

// ── Library / file manager at /files (Phase 2) ────────────────────────────
app.route('/files', create_library_router({ library, memory }));

// ── Maggie Phase 6: Tautulli play-event webhook ──────────────────────────
// Mounted at /api/maggie; Tautulli's notification agent POSTs to
// /api/maggie/plex_event on completed plays and the handler writes
// taste-log entries into Knowledge/Maggie/memory.md. Maggie's awareness
// handler picks up the new audit rows on her next tick.
app.route(
  '/api/maggie',
  create_maggie_router({
    vault_root: VAULT_ROOT,
    memory,
    events: app_events,
  }),
);

// ── Briefs + inter-specialist inbox (Prompt 6c) ───────────────────────────
// Mount BEFORE /api so the prefix matcher routes /api/briefs/* and
// /api/inbox/* to the specific sub-routers.
app.route('/api/briefs', create_briefs_router({ db }));
app.route('/api/inbox', create_inbox_router_api({ inbox: specialist_inbox }));
// Cordelia capture — iOS posts voice memos / photos / shared text here.
// Writes a vault wrapper note + audit row; downstream routing (transcription,
// classify-to-specialist) is a follow-up arc.
app.route(
  '/api/cordelia',
  create_cordelia_router({
    memory,
    vault_root: VAULT_ROOT,
    db,
    events: app_events,
    reactive: reactive_inbox,
  }),
);

// Agent rooms (2026-07-21): owner-only multi-specialist group chat. Auth-gated
// by the /api/* middleware; each handler re-checks owner tier + room ownership.
app.route(
  '/api/rooms',
  create_rooms_router({
    conversations: conversations_store,
    rooms: rooms_store,
    specialists: specialists_registry,
    runtime: specialist_runtime,
    llm,
    events: app_events,
  }),
);

// APNs registration + diagnostics. Auth-gated by the middleware
// mounted on /api/*; the route handlers read `c.get('user')` for the
// caller identity. iOS calls /register on every cold launch + after
// auth; /test-push lets Jasper verify the full pipeline (key signing →
// HTTP/2 → device wake) without waiting for a real brief.
app.route('/api/apns', create_apns_router({ memory, apns_tokens: apns_tokens_store }));

// Kate's spoken-voice surface: /api/voice/tts (browser → forza Qwen3-TTS
// proxy) + /api/voice/emotion (spoken-tone classify for the Satellite1
// coordinator). The old Pipecat /sdp proxy was deleted in the 2.0 P0 pass
// (container retired 2026-06-08).
app.route('/api/voice', create_voice_router({ llm, kv: kv_settings }));

// iOS device-as-sensor ingest. iOS calls `POST /api/sensors/:signal`
// from each per-signal feeder; the route handler validates the
// envelope + per-signal payload schema, rate-limits, writes a
// sensor_packets row, emits a `sensor_packet_received` AppEvent.
// Pre-2026-05-27 this was registered inside create_app_router (which
// is mounted at /app), so the actual path on the server was
// /app/api/sensors/:signal — iOS hit /api/sensors/:signal and got
// 404 silently. SensorsView's IngestHealthLine surfaced the 404 once
// hearth-ios build 20 shipped the try? → try/catch refactor; the
// fix is the structural move from create_app_router to the
// top-level mount here.
app.route(
  '/api/sensors',
  create_sensors_router({
    db,
    vault_root: VAULT_ROOT,
    memory,
    events: app_events,
    users: users_registry,
  }),
);

// Beatrice's scrum / dev-board reads — board JSON, the token-budgeted précis,
// and the markdown+mermaid the web planning-canvas page polls. Owner-gated;
// writes flow through Beatrice's scrum_* tools, never these routes. The nginx
// `/api/(...)` alternation on the LLM host needs `scrum` added (single-file bind
// mount — edit + `docker restart nginx`, not reload).
app.route(
  '/api/scrum',
  create_scrum_router({
    db,
    // "Start developing" on a board card → the directed-build pipeline,
    // detached + job-tracked exactly like the fire_deliberation route. Opens a
    // reviewed PR; never merges (skeptic review + owner merge gate downstream).
    // The PASS runs as BUILD_AGENT_ID (Kate) post-consolidation, but the JOB
    // stays tracked under BUILD_LEDGER_ID on purpose: job_runs is keyed
    // (specialist_id, job_key), and Kate's own detached brief fires already
    // write ('kate', DELIBERATION_JOB_KEY). Sharing that pair would make a
    // finishing build stamp her brief job complete (and vice-versa) and corrupt
    // the /specialists/:id/jobs poll.
    fire_directed_build: (directive, tools) => {
      job_runs.start(BUILD_LEDGER_ID, DELIBERATION_JOB_KEY);
      void (async () => {
        try {
          await loop_driver.fire_deliberation_now(
            BUILD_AGENT_ID,
            '00:00',
            {
              instruction: directive,
              tools,
            },
            undefined,
            { source: 'scrum' },
          );
          job_runs.finish(BUILD_LEDGER_ID, DELIBERATION_JOB_KEY, true);
        } catch (err) {
          job_runs.finish(
            BUILD_LEDGER_ID,
            DELIBERATION_JOB_KEY,
            false,
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    },
  }),
);

// LD2450 presence office (design-ld2450-zone-editor.md). The web pane reads
// live targets (POST /api/presence/targets from the Voice Coordinator → SSE)
// and writes desired zones down (POST /api/presence/zones → coordinator polls
// /zones/pending → applies → /zones/ack). Web → Hearth → coordinator → device;
// the pane never touches the device. Owner-gated viewer/editor/gear; the
// coordinator's machine routes need only an authenticated principal. The nginx
// `/api/(...)` alternation on the LLM host needs `presence` added (single-file bind
// mount — edit + `docker restart nginx`, not reload) or it 404s.
app.route('/api/presence', create_presence_router({ db, memory, events: app_events }));
// Media Archive serving surface (2026-07-11). NEW top-level /api namespace →
// add `media` to the the LLM host nginx /api/(...) alternation in
// /docker/nginx/locations.conf + `docker restart nginx`, else /api/media/* 404s.
// archive_root = the NAS media store bind-mounted into the container (see
// design-media-archival.md deploy notes); falls back to a local dir so a
// dev/smoke box with no NAS mount still boots.
app.route(
  '/api/media',
  create_media_router({
    db,
    memory,
    archive_root: process.env.HEARTH_MEDIA_ARCHIVE_ROOT ?? './data/media-archive',
    // generate_image (Krea 2 on forza) writes chat images here; the
    // route serves them back at /api/media/generated/:filename.
    generated_root: `${VAULT_ROOT}/_attachments/generated`,
    // The roster is the ONLY source of eligible share targets (item detail's
    // server-owned `sharing` object + POST /item/:id/share).
    users: users_registry,
    events: app_events,
    embedder,
  }),
);

// On the Fire (2026-07-29) — the cross-domain in-flight work ledger behind the
// web dock and the iOS tab accessory. Mounted at BOTH levels on purpose: iOS
// calls /api/jobs directly, and the web client lives under /app so it reaches
// the same router at /app/api/jobs (the pairing the per-specialist library
// already uses). NEW top-level /api namespace → add `jobs` to the the LLM host nginx
// /api/(...) alternation in /docker/nginx/locations.conf + `docker restart
// nginx` (single-file bind mount — a reload serves the stale inode), else
// /api/jobs 404s for the phone while quietly working in the browser.
app.route(
  '/api/jobs',
  create_jobs_router({
    db,
    events: app_events,
    // Retry is DELEGATED to the media pipeline rather than reimplemented in the
    // router: reset the row to `pending` through the domain's own store, then
    // re-kick its detached runner — exactly what `archive_url` does. The router
    // takes a callback so it keeps no dependency on how that pipeline is built.
    retry_media: (job_id: string) => {
      try {
        memory.media_jobs.update(job_id, { status: 'pending', error: null });
        kick_media_archive_detached(
          {
            memory,
            llm,
            db,
            vault_root: VAULT_ROOT,
            archive_root: process.env.HEARTH_MEDIA_ARCHIVE_ROOT ?? './data/media-archive',
            ...(embedder ? { embedder } : {}),
            inbox: specialist_inbox,
            events: app_events,
          },
          job_id,
          'kate',
        );
      } catch (err) {
        console.error('[jobs] retry failed:', (err as Error)?.message ?? err);
      }
    },
  }),
);

// iMessage observer ingest (2026-06-22) — the macOS app uploads raw 1:1
// windows for OPTED-IN contacts here; the nightly distill keeps only the
// distillate (People-note facts + relationship observations) and drops the
// raw. Hearth owns + enforces the per-contact opt-in registry (the toggle UI
// lives on the Friends card). DARK until HEARTH_IMESSAGE_OBSERVER=1. NEW
// top-level /api namespace — the `/api/(...)` alternation on the LLM host needs
// `imessage` added (single-file bind mount — edit + `docker restart nginx`,
// not reload) or it 404s.
app.route('/api/imessage', create_imessage_router({ db, memory }));

// News Desk (2026-06-10) — the second tab in Kate's office. Word-cloud
// categories over ALL categorized source subscriptions (cross-rack) +
// headlines from news_items (the feed-aware refresh), gear pause
// toggles, offered-bundle activation, and free-text "track something
// new" (Cordelia scout → proposals → approval auto-subscribes). The
// nginx `/api/(...)` alternation on the LLM host needs `news` added
// (single-file bind mount — edit + `docker restart nginx`) or it 404s.
app.route(
  '/api/news',
  create_news_router({
    db,
    memory,
    specialists: specialists_registry,
    tool_registry,
    llm,
  }),
);

// Vivian's Market Radar — the fuel office's second tab data feed
// (2026-06-12): latest momentum-screen snapshot per theme + the
// finance-news rail (news_items in the radar categories). Lives under
// the EXISTING /api/specialists namespace, so no nginx alternation
// change. Capability-gated per specialist (read_market_data), owner-only.
app.route(
  '/api/specialists',
  create_market_radar_router({ db, specialists: specialists_registry }),
);

// Kate's Research office — the deep-research office tab's data feed
// (2026-06-19): the caller's in-flight investigations with live status +
// per-sub-question progress, and the recent finished dossiers, plus the
// cancel verb (2026-07-29; `events` is what lets a cancel clear the office's
// live progress bar without a refresh). EXISTING /api/specialists namespace
// (no nginx edit). Capability-gated per specialist (deep_research);
// per-requester cordon (owner has no god-view).
app.route(
  '/api/specialists',
  create_research_router({ db, specialists: specialists_registry, events: app_events }),
);

// Kate's Bills office tab — the "lay out my bills" surface (2026-07-04):
// monthly-equivalent total + upcoming estimates + the anticipation probe's
// open flags + the service roster, over the cordoned ledger reads. EXISTING
// /api/specialists namespace (no nginx edit). Capability-gated per
// specialist (monitor_household_services); per-requester cordon.
app.route(
  '/api/specialists',
  create_bills_router({ memory, specialists: specialists_registry, proposals: proposals_store }),
);

// Kate's Friends office tab — a CRUD GUI over the People/ person notes
// (2026-06-22): per-friend facts + upcoming dates + linked flight watches,
// per-requester cordoned (read_vault-gated). EXISTING /api/specialists
// namespace (no nginx edit). Writes reuse the real person + flight tools
// (find_or_create_person / upsert_person_note / track_flight) with the caller
// threaded in, so stamping + validation + audit apply.
app.route(
  '/api/specialists',
  create_friends_router({ db, memory, specialists: specialists_registry, llm }),
);

// Kate's Post Office — the email-triage office tab's data feed + account setup
// (2026-06-20): triaged inbox buckets (cordon-filtered) + redacted accounts +
// provider presets for the setup gear. EXISTING /api/specialists namespace (no
// nginx edit). Capability-gated (read_mail); household read, owner-only setup.
app.route(
  '/api/specialists',
  create_postoffice_router({ db, memory, specialists: specialists_registry, llm, events: app_events, users: users_registry }),
);

// Cordelia's Second Brain — the synthesis layer as one navigable graph
// (2026-06-14): every shelf's distilled syntheses with live health scores,
// grounding verdicts, sources, and per-fact provenance, for the office tab's
// galaxy→shelf→synthesis→fact canvas (web + iOS/macOS). EXISTING
// /api/specialists namespace (no nginx edit); owner-only + cordon-filtered.
app.route(
  '/api/specialists',
  create_brain_router({ db, memory, vault_root: VAULT_ROOT, specialists: specialists_registry }),
);

// Luna's Home office — the household-shared "who is where" map + the owner-only
// camera/BLE assignment overlay (Household Awareness Layer P1.5). Same
// /api/specialists namespace (no nginx change); household-tier read, owner write.
app.route(
  '/api/specialists',
  create_home_router({ db, memory, specialists: specialists_registry, users: users_registry, events: app_events }),
);

// Astrid Pass 3 — live workout streaming. Distinct from /api/sensors/healthkit
// (different cadence, different consumers). Mounted at top level following
// the same convention as /api/sensors above per the route-mount-trap memory.
// The tracker is the in-memory session state; the live throttle subscriber
// listens on workout_packet + workout_completed events and fires push
// templates / PR shelf updates. get_workout_state + push_coaching_note
// tools receive a reference to the tracker via register_tracker.
const workout_tracker = new WorkoutSessionTracker();
workout_tracker.start_gc();
register_tracker_state(workout_tracker);
register_tracker_push(workout_tracker);
register_live_throttle({
  events: app_events,
  tracker: workout_tracker,
  memory,
  vault_root: VAULT_ROOT,
  // Live Ride Companion Phase 1 — insight render + Laur cue clips +
  // APNs workout_cue delivery (design doc §6). Same TTS default the
  // /api/voice/tts proxy uses (Laur on forza :8023).
  db,
  llm,
  apns_tokens: apns_tokens_store,
  users: users_registry,
  tts_base_url: process.env.HEARTH_VOICE_TTS_URL ?? 'http://192.168.0.188:8023',
  cue_clip_dir: process.env.HEARTH_CUE_CLIP_DIR ?? resolve(dirname(resolve(DB_PATH)), 'astrid-cues'),
});
app.route(
  '/api/workout',
  create_workout_router({
    db,
    vault_root: VAULT_ROOT,
    memory,
    events: app_events,
    tracker: workout_tracker,
  }),
);

// Kate-as-filter surfaces (held items + pre-commit). Same mount
// reasoning as sensors — iOS calls /api/kate/* directly; the route
// belongs at top level, not under /app.
app.route('/api/kate', create_kate_router({ db, events: app_events }));

// Per-specialist library. Web UI hits `/app/api/library/*` (mounted
// inside create_app_router for same-origin convenience with the SPA
// assets); the iOS Knowledge tab hits `/api/library/*` per the
// `/api/*` convention every other iOS-facing namespace follows.
// Mounting twice with the same router factory keeps both surfaces
// honest — no path divergence, single set of handlers. Same fix
// shape as sensors (2026-05-27 move) without disturbing the SPA's
// existing call sites. Nginx alternation on the always-on host needs `library`
// added alongside `sensors|kate|apns|cordelia|feedback|roadmap`
// for the iOS path to traverse Tailscale TLS.
app.route(
  '/api/library',
  create_library_router_app({
    db,
    vault_root: VAULT_ROOT,
    memory,
    specialists: specialists_registry,
    runtime: specialist_runtime,
    conversations: conversations_store,
    llm,
    embedder,
    events: app_events,
  }),
);

// User-preference + STT endpoints the /app web UI depends on. The user
// routes mount under /api (/users/specialist_aliases, active_specialist,
// quiet); the app extras (/transcribe) mount under /app/api below so they
// share an origin with the static SPA.
app.route(
  '/api',
  create_relay_router({
    db,
    memory,
    specialists: specialists_registry,
    runtime: specialist_runtime,
    conversations: conversations_store,
    users: users_registry,
    kv: kv_settings,
    events: app_events,
  }),
);

// ── Specialist runtime routes (Prompt 6a) ─────────────────────────────────
// The focused architect tool surface for an owner-directed Beatrice build.
// `propose_code_change` / `propose_code_edit` live on NO standing surface (she
// holds `write_codebase_pr` but it's curated out of BOTH tools_for_chat and
// tools_for_deliberation), so they only become callable via this per-turn
// override. Kept under the ~15-tool arg-drop threshold; the reads come first —
// they're the existence-check that stops her rebuilding a tool that exists.
const ARCHITECT_BUILD_TOOLS = [
  'grep_codebase',
  'read_codebase_file',
  'list_codebase',
  'analyze_capability_gaps',
  'propose_code_edit',
  'propose_code_change',
  'consult_deep_model',
  'read_inbox',
  // read_proposal_by_id (2026-08-11): the instruction inlines the payload,
  // but a truncation marker or a referenced sibling proposal still needs the
  // full record — this is the read that replaces round-burning hunts.
  'read_proposal_by_id',
];
app.route(
  '/api',
  create_specialists_router({
    db,
    memory,
    specialists: specialists_registry,
    runtime: specialist_runtime,
    proposals: proposals_store,
    conversations: conversations_store,
    interrupts: interrupts_store,
    inbox: specialist_inbox,
    tools: tool_registry,
    llm,
    vault_root: VAULT_ROOT,
    workout_tracker,
    events: app_events,
    users: users_registry,
    step_up: step_up_store,
    // Approved build → run the BUILD_AGENT's deliberation on the strong model
    // with the architect tools in hand. Detached (fire-and-forget): a build runs
    // for minutes, far longer than the /decide response should block.
    fireDirectedBuild: (proposal) => {
      void loop_driver
        .fire_deliberation_now(
          BUILD_AGENT_ID,
          'build',
          {
            instruction: directed_build_instruction(proposal, { vault_root: VAULT_ROOT }),
            tools: ARCHITECT_BUILD_TOOLS,
            max_tokens: 8000,
          },
          undefined,
          { source: 'decide', proposal_id: proposal.id },
        )
        .catch((err) => {
          console.error(
            `[fanout] directed build for approved proposal ${proposal.id} failed:`,
            err,
          );
        });
    },
  }),
);

// Member-facing provable cordon — /api/users/privacy/report. Lives under the
// existing /api/users/* namespace (already in the nginx alternation).
app.route(
  '/api',
  create_privacy_router({
    db,
    memory,
    proposals: proposals_store,
    conversations: conversations_store,
    users: users_registry,
  }),
);

// ── Unified UI at /app (Prompt 6b) ───────────────────────────────────────
// Mount the app extras (/transcribe) under /app/api BEFORE the main /app
// router so Hono's prefix matcher routes the specific path here rather
// than treating it as a static-file request.
app.route('/app/api', create_app_extras_router());

app.route(
  '/app',
  create_app_router({
    db,
    memory,
    specialists: specialists_registry,
    runtime: specialist_runtime,
    proposals: proposals_store,
    conversations: conversations_store,
    interrupts: interrupts_store,
    inbox: specialist_inbox,
    vault_root: VAULT_ROOT,
    specialists_dir: SPECIALISTS_DIR,
    events: app_events,
    llm,
    embedder,
  }),
);

// Root → /app/ so the natural entry point is the new UI. /inbox remains.
app.get('/', (c) => c.redirect('/app/', 302));

// ── Tool execution path ────────────────────────────────────────────────────

/**
 * Look up the call's tool in the registered agents and invoke it. If the
 * tool isn't yet implemented (e.g. send_external tools land in later
 * prompts), return a stub result so the approval flow still produces a
 * sensible record.
 */
async function dispatch(
  call: ToolCall,
  ctx: ToolContext,
): Promise<{ result: unknown; error?: string }> {
  if (scribe.tools.has(call.tool_name)) {
    return scribe.invoke(call, ctx);
  }
  console.log(
    `[dispatch] STUB: would have executed ${call.tool_name}: ${JSON.stringify(call.input)}`,
  );
  return {
    result: {
      stub: true,
      tool_name: call.tool_name,
      input: call.input,
      message: `STUB: ${call.tool_name} not yet implemented; recorded the intent only.`,
    },
  };
}

/** Apply gate modifiers (currently cooldown_ms) then dispatch. */
async function execute(
  call: ToolCall,
  ctx: ToolContext,
  gate: GateDecision,
): Promise<{ result: unknown; error?: string }> {
  const cooldown_ms =
    gate.decision !== 'deny' ? gate.modifiers?.cooldown_ms : undefined;
  if (cooldown_ms && cooldown_ms > 0) {
    console.log(
      `[gate] applying ${cooldown_ms}ms cooldown before executing ${call.tool_name}`,
    );
    await new Promise((r) => setTimeout(r, cooldown_ms));
  }
  return dispatch(call, ctx);
}

// ── Tool-call shared handler (Scribe /scribe/<tool>) ───────────────────────

interface PolicyExtras {
  recipient?: PolicyContext['recipient'];
  intent_category?: string;
}

async function handle_tool_call(
  c: Context,
  tool: Tool,
  parsed_input: unknown,
  agent: PolicyContext['agent'] = 'scribe',
  policy_extras: PolicyExtras = {},
): Promise<Response> {
  const intent_id = ulid();
  const now = new Date();
  const call: ToolCall = {
    tool_name: tool.name,
    input: parsed_input,
    idempotency_key: tool.idempotency_key(parsed_input as never),
    rationale: `direct call to ${agent}.${tool.name}`,
  };

  const gate = gateway.evaluate(call, {
    agent,
    intent_id,
    risk: tool.risk,
    now,
    ...policy_extras,
  });

  if (gate.decision === 'deny') {
    const audit_id = memory.log_action({
      intent_id,
      agent: agent,
      tool_name: tool.name,
      tool_input: parsed_input,
      gate_decision: {
        decision: 'deny',
        rationale: gate.rationale,
        matched_rules: [gate.matched_rule],
      },
      error: `denied by gateway: ${gate.rationale}`,
    });
    return c.json(
      {
        intent_id,
        audit_id,
        error: 'denied by gateway',
        rationale: gate.rationale,
        matched_rule: gate.matched_rule,
      },
      403,
    );
  }

  if (gate.decision === 'approve') {
    const approval_id = approvals.create(call, gate);
    const queued = approvals.get(approval_id)!;
    void push_approval(queued, memory);
    const audit_id = memory.log_action({
      intent_id,
      agent: agent,
      tool_name: tool.name,
      tool_input: parsed_input,
      gate_decision: {
        decision: 'approve',
        rationale: gate.rationale,
        matched_rules: [gate.matched_rule],
      },
      execution_result: { approval_id, status: 'pending_approval' },
    });
    return c.json(
      {
        intent_id,
        audit_id,
        approval_id,
        status: 'pending_approval',
        rationale: gate.rationale,
        matched_rule: gate.matched_rule,
      },
      202,
    );
  }

  // auto
  const ctx: ToolContext = { memory, llm, now, intent_id };
  const { result, error } = await execute(call, ctx, gate);

  const audit_id = memory.log_action({
    intent_id,
    agent: agent,
    tool_name: tool.name,
    tool_input: parsed_input,
    gate_decision: {
      decision: 'auto',
      rationale: gate.rationale,
      matched_rules: [gate.matched_rule],
    },
    execution_result: result,
    error,
  });

  if (error) {
    return c.json({ intent_id, audit_id, error }, 500);
  }
  return c.json({ intent_id, audit_id, result });
}

function make_tool_handler(tool: Tool, agent: PolicyContext['agent'] = 'scribe') {
  return async (c: Context) => {
    let raw_body: unknown;
    try {
      raw_body = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = tool.input_schema.safeParse(raw_body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    return handle_tool_call(c, tool, parsed.data, agent);
  };
}

for (const [name, tool] of scribe.tools) {
  app.post(`/scribe/${name}`, make_tool_handler(tool, 'scribe'));
}

// ── Programmatic read endpoints (query_people / retrieve / brief) ──────────

const QueryPeopleSchema = z.object({
  relationship: z.string().optional(),
  friday_managed: z.boolean().optional(),
  do_not_contact: z.boolean().optional(),
});

app.post('/memory/query_people', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (err) {
    return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
  }
  const parsed = QueryPeopleSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }
  const intent_id = ulid();
  const people = memory.query_people(parsed.data);
  const audit_id = memory.log_action({
    intent_id,
    agent: 'orchestrator',
    tool_name: 'query_people',
    tool_input: parsed.data,
    execution_result: { count: people.length },
  });
  return c.json({ intent_id, audit_id, people });
});

const RetrieveSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(50).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});

app.post('/memory/retrieve', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (err) {
    return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
  }
  const parsed = RetrieveSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }
  const intent_id = ulid();
  const error = 'retrieval requires ingestor + embeddings (Pass 4)';
  const audit_id = memory.log_action({
    intent_id,
    agent: 'orchestrator',
    tool_name: 'retrieve',
    tool_input: parsed.data,
    error,
  });
  return c.json({ intent_id, audit_id, error }, 501);
});

// ── Approvals API ──────────────────────────────────────────────────────────

const DecideSchema = z.object({
  verdict: z.enum(['approve', 'deny']),
  who: z.string().min(1),
  reason: z.string().optional(),
  modified_call: z
    .object({
      tool_name: z.string(),
      input: z.unknown(),
      idempotency_key: z.string(),
      rationale: z.string(),
    })
    .partial()
    .optional(),
});

app.get('/approvals', (c) => {
  const status = c.req.query('status') as
    | 'open'
    | 'approved'
    | 'denied'
    | 'expired'
    | undefined;
  const rows = approvals.list(status);
  return c.json({ approvals: rows });
});

app.get('/approvals/:id', (c) => {
  const id = c.req.param('id');
  const row = approvals.get(id);
  if (!row) return c.json({ error: `approval not found: ${id}` }, 404);
  return c.json(row);
});

app.post('/approvals/:id/decide', async (c) => {
  const id = c.req.param('id');
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (err) {
    return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
  }
  const parsed = DecideSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const existing = approvals.get(id);
  if (!existing) {
    return c.json({ error: `approval not found: ${id}` }, 404);
  }

  // Idempotent: re-deciding a non-open approval returns the original decision.
  if (existing.status !== 'open') {
    return c.json({
      approval_id: id,
      status: existing.status,
      idempotent: true,
      human_verdict: existing.human_verdict,
    });
  }

  // Build the modified call by merging into the original.
  const merged_call: ToolCall = {
    ...existing.tool_call,
    ...(parsed.data.modified_call ?? {}),
    // Re-validate input shape: if modified_call.input is set, use it; else keep original.
    input:
      parsed.data.modified_call?.input !== undefined
        ? parsed.data.modified_call.input
        : existing.tool_call.input,
  };
  const used_modified = parsed.data.modified_call !== undefined;

  const human_verdict = {
    verdict: parsed.data.verdict,
    who: parsed.data.who,
    reason: parsed.data.reason,
    modified: used_modified,
  };

  const decided = approvals.decide(
    id,
    human_verdict,
    used_modified ? merged_call : undefined,
  );
  if (!decided) {
    return c.json({ error: `approval not found after update: ${id}` }, 404);
  }

  // Audit the decision itself.
  const audit_id = memory.log_action({
    intent_id: id,
    agent: 'orchestrator',
    tool_name: 'approval_decision',
    tool_input: {
      approval_id: id,
      verdict: parsed.data.verdict,
      modified: used_modified,
      tool: existing.tool_call.tool_name,
    },
    human_verdict: {
      who: parsed.data.who,
      verdict: parsed.data.verdict,
      modified: used_modified,
    },
  });

  if (parsed.data.verdict === 'deny') {
    return c.json({
      approval_id: id,
      status: 'denied',
      audit_id,
      human_verdict,
    });
  }

  // Approved → execute (apply cooldown from the original gate decision).
  const intent_id = ulid();
  const ctx: ToolContext = { memory, llm, now: new Date(), intent_id };
  const { result, error } = await execute(merged_call, ctx, existing.gate_decision);

  const exec_audit_id = memory.log_action({
    intent_id,
    agent: 'orchestrator',
    tool_name: 'execute_approved',
    tool_input: {
      approval_id: id,
      tool: merged_call.tool_name,
      modified: used_modified,
    },
    execution_result: result,
    error,
  });

  if (error) {
    return c.json(
      {
        approval_id: id,
        status: 'approved',
        audit_id,
        exec_audit_id,
        error,
      },
      500,
    );
  }
  return c.json({
    approval_id: id,
    status: 'approved',
    audit_id,
    exec_audit_id,
    result,
  });
});

// ── Test endpoints (for smoke-approvals.ts) ────────────────────────────────
//
// These are deliberately unauthenticated and always available. They don't
// execute anything dangerous — any synthetic call gets dispatched through
// the same path, and `dispatch()` returns a STUB for unknown tool_names.
// Safe to leave on in v0 single-host deployments.

const TestQueueSchema = z.object({
  tool_name: z.string().default('test_send_external'),
  risk: z
    .enum(['read', 'write_internal', 'send_external', 'spend_money'])
    .default('send_external'),
  input: z.record(z.string(), z.unknown()).default({}),
  recipient: z
    .object({
      id: z.string().optional(),
      flags: z.array(z.string()).optional(),
      novelty: z.number().optional(),
      relationship: z.string().optional(),
    })
    .optional(),
});

app.post('/test/queue_action', async (c) => {
  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    // empty body acceptable — all fields have defaults
  }
  const parsed = TestQueueSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  // Synthesize a Tool-shaped object just enough to drive the shared
  // handler. We bypass make_tool_handler because the test action is
  // intentionally not a real registered tool.
  const synth_tool: Tool = {
    name: parsed.data.tool_name,
    description: 'synthetic test tool (smoke-approvals)',
    risk: parsed.data.risk as RiskTier,
    input_schema: z.unknown() as z.ZodType<unknown>,
    output_schema: z.unknown() as z.ZodType<unknown>,
    idempotency_key: () =>
      `test:${parsed.data.tool_name}:${JSON.stringify(parsed.data.input)}`,
    execute: async () => parsed.data.input,
  };

  return handle_tool_call(c, synth_tool, parsed.data.input, 'orchestrator', {
    recipient: parsed.data.recipient,
  });
});

app.post('/test/reload_policy', (c) => {
  try {
    gateway.reload();
    return c.json({ reloaded: true, policy: gateway.describe() });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// ── Background sweep: expire old open approvals ────────────────────────────

function sweep_expired_approvals(): void {
  const cutoff = new Date(Date.now() - APPROVAL_TTL_HOURS * 60 * 60 * 1000);
  const expired = approvals.expire_open_before(cutoff);
  for (const id of expired) {
    memory.log_action({
      intent_id: id,
      agent: 'orchestrator',
      tool_name: 'approval_expired',
      tool_input: { approval_id: id, ttl_hours: APPROVAL_TTL_HOURS },
      error: `expired after ${APPROVAL_TTL_HOURS}h`,
    });
  }
  if (expired.length > 0) {
    console.log(`[sweep] expired ${expired.length} approval(s)`);
  }
}

const SWEEP_INTERVAL_MS = 60 * 1000;
const sweep_handle = setInterval(sweep_expired_approvals, SWEEP_INTERVAL_MS);
// Run once at boot so a long-stopped server catches up immediately.
sweep_expired_approvals();

// ── Background sweep: expire stale FYI proposal cards ──────────────────────
//
// A proposal whose own action set offers no decision (no execute/reject
// effect — e.g. a briefing's Got-it/Discuss/Snooze) is a read item, not a
// decision. Unacknowledged FYIs used to sit 'pending' forever and pile the
// owner's queue up; they now expire after HEARTH_PROPOSAL_FYI_TTL_HOURS
// (default 48). Snoozed rows are exempt; see ProposalsStore.expire_stale_fyi.

const FYI_TTL_HOURS = Number(process.env.HEARTH_PROPOSAL_FYI_TTL_HOURS ?? '48');

function sweep_expired_fyi_proposals(): void {
  const expired = proposals_store.expire_stale_fyi(FYI_TTL_HOURS);
  for (const id of expired) {
    memory.log_action({
      intent_id: id,
      agent: 'orchestrator',
      tool_name: 'proposal_expired',
      tool_input: { proposal_id: id, ttl_hours: FYI_TTL_HOURS },
      execution_result: { reason: 'fyi_ttl' },
    });
  }
  if (expired.length > 0) {
    console.log(`[sweep] expired ${expired.length} stale FYI proposal(s)`);
  }
}

const fyi_sweep_handle = setInterval(sweep_expired_fyi_proposals, SWEEP_INTERVAL_MS);
sweep_expired_fyi_proposals();

// ── Background sweep: wake proposals whose snooze window has passed ────────
//
// The counterpart to `snooze()` / the `defer` action, missing until 2026-07-18:
// `snoozed_until` was written and then only ever read as `IS NULL`, so a
// deferred card left the queue permanently — it never woke, the FYI TTL
// exempts snoozed rows, and the Court only lists `pending`. "Decide later"
// silently meant "never", against a documented "reappears tomorrow". Waking
// restores the row to plain `pending` so every normal path picks it back up.
function sweep_woken_proposals(): void {
  const woken = proposals_store.wake_snoozed();
  for (const id of woken) {
    memory.log_action({
      intent_id: id,
      agent: 'orchestrator',
      tool_name: 'proposal_woken',
      tool_input: { proposal_id: id },
      execution_result: { reason: 'snooze_window_passed' },
    });
  }
  if (woken.length > 0) {
    console.log(`[sweep] woke ${woken.length} snoozed proposal(s)`);
  }
}

const wake_sweep_handle = setInterval(sweep_woken_proposals, SWEEP_INTERVAL_MS);
sweep_woken_proposals();

// ── Background sweep: proposal-filing quality critic ───────────────────────
//
// Catches the noise create()'s equality dedup can't: the SAME root cause
// re-filed under a drifting fingerprint (semantic duplicate), and a fix that
// doesn't address its own diagnosis (fix_mismatch). Runs OUT OF BAND here, not
// in create()'s sync hot path. Critiques only proposals filed since the last
// tick (each gets judged exactly once in steady state). FAIL-OPEN + DARK by
// default (HEARTH_PROPOSAL_CRITIC=1 to enable). Conservative actions: a
// duplicate supersedes the NEWER row (the canonical earlier one survives); a
// fix_mismatch is AUDITED only (never auto-denied). See proposal_critic.ts.
let last_critic_sweep_ms = Date.now(); // skip the existing backlog at boot

async function sweep_proposal_quality(): Promise<void> {
  if (!proposal_critic_enabled()) return;
  const since = new Date(last_critic_sweep_ms).toISOString();
  last_critic_sweep_ms = Date.now();
  const pending = proposals_store.list({ status: 'pending' });
  const fresh = pending.filter((p) => p.ts_created > since);
  if (fresh.length === 0) return;
  const now = new Date();
  // C6 fold-in (2026-07-05): the decided history the judge screens re-files
  // against — recently denied/expired rows (the critic used to see only the
  // OPEN queue, so "denied last month, re-filed this month" sailed through).
  let decided: ProposalRow[] = [];
  try {
    decided = [
      ...proposals_store.list({ status: 'denied', limit: 120 }),
      ...proposals_store.list({ status: 'expired', limit: 120 }),
    ].filter(
      (p) => p.ts_decided && now.getTime() - Date.parse(p.ts_decided) <= 45 * 86_400_000,
    );
  } catch {
    /* fail-open — no decided history just means the pre-C6 critic behavior */
  }
  for (const proposal of fresh) {
    // C6 deterministic temporal sanity — a calendar event that already ended
    // or prep for a past event is dead weight at FILING time; expire it in
    // code (typed payload contracts only — see temporal_sanity), no judge.
    const t = temporal_sanity(proposal, now);
    if (t.stale) {
      const expired = proposals_store.expire_one(proposal.id, `proposal-critic: ${t.reason}`);
      memory.log_action({
        intent_id: proposal.id,
        agent: 'orchestrator',
        tool_name: 'proposal_critic',
        tool_input: { proposal_id: proposal.id, action: 'temporal_stale' },
        execution_result: { expired, reason: t.reason },
      });
      if (expired) {
        console.log(`[critic] temporal-stale expired ${proposal.id} (${t.reason})`);
        continue;
      }
    }
    let verdict;
    try {
      verdict = await assess_proposal({ proposal, open: pending, decided, llm });
    } catch {
      continue; // fail-open — a critic error never touches the proposal
    }
    if (verdict.action === 'duplicate' && verdict.duplicate_of) {
      const flipped = proposals_store.supersede_duplicate(
        proposal.id,
        verdict.duplicate_of,
        `proposal-critic: ${verdict.reason}`,
      );
      memory.log_action({
        intent_id: proposal.id,
        agent: 'orchestrator',
        tool_name: 'proposal_critic',
        tool_input: { proposal_id: proposal.id, action: 'duplicate', duplicate_of: verdict.duplicate_of },
        execution_result: { superseded: flipped, reason: verdict.reason },
      });
      if (flipped) {
        console.log(`[critic] superseded duplicate ${proposal.id} → ${verdict.duplicate_of} (${verdict.reason})`);
      }
    } else if (verdict.action === 'refile_of_denied' && verdict.duplicate_of) {
      // Structural close ONLY on a strong label: a recent denial with a
      // reason on record (precedent's label-honesty contract). An expired /
      // reason-less prior is surfaced, never auto-killed — a lapse is timing,
      // and "denied" without a reason could mean already-handled.
      const prior = proposals_store.get(verdict.duplicate_of);
      const strong = prior ? should_retire_refile(prior, now) : false;
      const flipped = strong
        ? proposals_store.supersede_duplicate(
            proposal.id,
            verdict.duplicate_of,
            `proposal-critic: re-files a recently denied proposal — ${verdict.reason}`,
          )
        : false;
      memory.log_action({
        intent_id: proposal.id,
        agent: 'orchestrator',
        tool_name: 'proposal_critic',
        tool_input: {
          proposal_id: proposal.id,
          action: 'refile_of_denied',
          duplicate_of: verdict.duplicate_of,
        },
        execution_result: { superseded: flipped, strong_label: strong, reason: verdict.reason },
      });
      console.log(
        `[critic] refile_of_denied on ${proposal.id} → ${verdict.duplicate_of} ` +
          `(${strong ? 'retired' : 'flagged only — weak label'}; ${verdict.reason})`,
      );
    } else if (verdict.action === 'fix_mismatch') {
      // Surface only — never auto-deny a fix on the judge's say-so.
      memory.log_action({
        intent_id: proposal.id,
        agent: 'orchestrator',
        tool_name: 'proposal_critic',
        tool_input: { proposal_id: proposal.id, action: 'fix_mismatch' },
        execution_result: { reason: verdict.reason },
      });
      console.log(`[critic] fix_mismatch flagged on ${proposal.id} (${verdict.reason})`);
    }
  }
}

const critic_sweep_handle = setInterval(() => void sweep_proposal_quality(), SWEEP_INTERVAL_MS);

// ── Background sweep: trust-teeth undo-window executor ─────────────────────
//
// Resolves `trust_autoexec` rows the Proposal Court armed (graduated
// tier2c/3 signature + unanimous bench, src/core/trust_teeth.ts): a row
// whose undo window passed with the proposal still pending executes through
// the SAME decide()+effects path an owner tap runs; a row the owner touched
// first (deny = the undo, snooze = an explicit defer) cancels. Gated at
// tick time on HEARTH_TRUST_TEETH — dark ⇒ every tick is a no-op. Rows are
// durable, so armed executions survive a restart.

async function sweep_trust_teeth(): Promise<void> {
  try {
    const r = await sweep_trust_autoexec({
      db,
      proposals: proposals_store,
      memory,
      specialists: specialists_registry,
      tools: tool_registry,
      llm,
      events: app_events,
    });
    if (r.executed.length > 0 || r.canceled.length > 0 || r.failed.length > 0) {
      console.log(
        `[trust-teeth] sweep: ${r.executed.length} executed, ${r.canceled.length} canceled, ${r.failed.length} failed`,
      );
    }
  } catch (err) {
    console.error('[trust-teeth] sweep failed:', err);
  }
}

const trust_teeth_sweep_handle = setInterval(() => void sweep_trust_teeth(), SWEEP_INTERVAL_MS);
void sweep_trust_teeth(); // boot catch-up: execute windows that lapsed while down

// ── Weekly memory.md compaction (Prompt 6c) ────────────────────────────────
//
// Runs once per hour and checks if it's Sunday 02:00 local. Compacts each
// specialist's memory.md by folding entries older than 30 days into a single
// "## Archive: pre-<date>" block summarized by Kate.

let last_compact_run: string | null = null;

async function compact_all_memories_if_due(): Promise<void> {
  const now = new Date();
  const slot_key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`; // time-guard-ok: host-clock weekly-compaction gate — correct under TZ=America/Denver container; migrate to local_hhmm if it runs UTC
  // Sunday = 0, target hour = 02.
  if (now.getDay() !== 0 || now.getHours() !== 2) return; // time-guard-ok: host-clock weekly-compaction gate (see above)
  if (last_compact_run === slot_key) return;
  last_compact_run = slot_key;

  const summarize = async (text: string): Promise<string> => {
    if (process.env.HEARTH_TEST_MODE === '1') {
      // Test-mode: a deterministic short summary.
      return `[summary of ${text.split('\n').filter((l) => l.startsWith('## ')).length} archived entries]`;
    }
    try {
      const resolved = llm.for_role('specialist');
      const resp = await resolved.provider.complete({
        messages: [
          {
            role: 'system',
            content:
              'You are Kate. Summarize the following dated notes from a specialist\'s memory file into a calm, narrative paragraph or two. Preserve dates worth remembering; drop transient noise.',
          },
          { role: 'user', content: text.slice(0, 50_000) },
        ],
        temperature: 0.3,
      });
      return resp.content.trim();
    } catch (err) {
      return `[compaction summary unavailable: ${(err as Error).message}]`;
    }
  };

  // Walk every specialist × every user. Since the 2026-07-29 per-user split
  // each user has their own `memory_<id>.md` (the owner keeps the canonical
  // `memory.md`), and a job that compacted only the canonical file would let
  // member files grow forever. Dedupe on the resolved path rather than
  // special-casing the owner id, so `memory_path` stays the single source of
  // truth for which user maps to which file.
  for (const s of specialists_registry.list()) {
    const seen = new Set<string>();
    for (const user_id of [undefined, ...users_registry.list().map((u) => u.id)]) {
      const rel = memory_path(s.id, user_id);
      if (seen.has(rel)) continue;
      seen.add(rel);
      try {
        const result = await compact_memory({
          memory,
          specialist_id: s.id,
          user_id,
          keep_recent_days: 30,
          summarize,
        });
        if (result.archived_count > 0) {
          memory.log_action({
            intent_id: ulid(),
            agent: 'orchestrator',
            tool_name: 'memory_compact',
            tool_input: { specialist_id: s.id, memory_file: rel, keep_recent_days: 30 },
            execution_result: result,
          });
          console.log(
            `[compact] ${rel}: archived ${result.archived_count}, kept ${result.remaining_count}`,
          );
        }
      } catch (err) {
        console.error(`[compact] failed for ${rel}:`, err);
      }
    }
  }
}

const COMPACT_INTERVAL_MS = 60 * 60 * 1000;
const compact_handle = setInterval(() => void compact_all_memories_if_due(), COMPACT_INTERVAL_MS);
void compact_all_memories_if_due();

// ── Background warmer: keep life-context (weather + EV) hot for chat/voice ──
//
// kate_pack pre-injects today's calendar (a local read) PLUS weather + EV/home
// status so a voice/chat turn READS them instead of fabricating. But weather/EV
// are NETWORK reads (Pirate API, HA) a ~2s turn can't afford inline — so we warm
// them here on an interval and stow the result in the process-local warm cache
// (life_context.put_warm_life_context); kate_pack reads it with zero network.
// The weather connector's own 5-min (lat,lng) TTL caps actual upstream API hits
// (household members sharing one home dedupe to ~1 call / 5 min), keeping us well
// under Pirate's 10k/month free tier. Owner + household tiers only (friend-tier
// users aren't voice consumers). Fail-soft per user: a throwing read never breaks
// the loop, and a cold entry simply means kate_pack pre-injects nothing for that
// signal that turn.
async function warm_life_context_all(): Promise<void> {
  for (const u of users_registry.list()) {
    if (u.tier === 'friend') continue;
    try {
      const ctx = await pull_brief_context({
        memory,
        user_id: u.id,
        users: users_registry,
      });
      put_warm_life_context(u.id, ctx);
    } catch (err) {
      console.error(`[life-warmer] ${u.id} failed (non-fatal):`, err);
    }
  }
}

const LIFE_WARM_INTERVAL_MS = 3 * 60 * 1000;
const life_warm_handle = setInterval(() => void warm_life_context_all(), LIFE_WARM_INTERVAL_MS);
// Warm once at boot so the first voice turn after a restart is already grounded.
void warm_life_context_all();

// ── Legacy /intent (Prompt 0 compatibility) ────────────────────────────────

/**
 * Legacy convenience route — direct shortcut to append_journal_entry. Prefer
 * typed /scribe/* endpoints for new callers.
 */
app.post('/intent', async (c) => {
  const parsed = IntentSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.message }, 400);
  }

  const intent_id = ulid();
  const call: ToolCall = {
    tool_name: 'append_journal_entry',
    input: { body: parsed.data.text, tags: [] },
    idempotency_key: `intent:${intent_id}`,
    rationale:
      'legacy /intent shortcut: routes to Scribe.append_journal_entry',
  };

  const ctx: ToolContext = {
    memory,
    llm,
    now: new Date(),
    intent_id,
  };

  const { result, error } = await scribe.invoke(call, ctx);

  const audit_id = memory.log_action({
    intent_id,
    agent: 'scribe',
    tool_name: call.tool_name,
    tool_input: call.input,
    execution_result: result,
    error,
  });

  if (error) {
    return c.json({ intent_id, audit_id, error }, 500);
  }
  return c.json({ intent_id, audit_id, result });
});

// ── Clean shutdown ─────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  console.log('orchestrator shutting down');
  clearInterval(sweep_handle);
  clearInterval(fyi_sweep_handle);
  clearInterval(wake_sweep_handle);
  clearInterval(critic_sweep_handle);
  clearInterval(trust_teeth_sweep_handle);
  clearInterval(compact_handle);
  clearInterval(life_warm_handle);
  try {
    loop_driver.stop();
  } catch {
    /* ignore */
  }
  try {
    reactive_inbox.stop();
  } catch {
    /* ignore */
  }
  try {
    await gateway.close();
  } catch {
    /* ignore */
  }
  try {
    await specialists_registry.close();
  } catch {
    /* ignore */
  }
  try {
    await tool_loader.close();
  } catch {
    /* ignore */
  }
  try {
    await capabilities_watcher.close();
  } catch {
    /* ignore */
  }
  try {
    await autonomy_watcher.close();
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// Auto-deploy boot reconciliation (2026-07-05): the relay runs deploys
// DETACHED (the requester is this container), so a rollback can't be
// reported by the dispatching process — the freshly-booted one asks the
// relay what the last deploy did. A rolled-back deploy pushes the owner +
// flags Beatrice ONCE (latched on the deploy's own timestamp in kv).
if (process.env.HEARTH_AUTO_DEPLOY === '1') {
  setTimeout(() => {
    void (async () => {
      try {
        const { fetch_last_deploy } = await import('@connectors/ops_relay');
        const last = await fetch_last_deploy();
        if (!last || (last.status !== 'rolled_back' && last.status !== 'rollback_failed')) return;
        const latch_key = 'auto_deploy:last_alerted_at';
        if (kv_settings.get<string>(latch_key) === last.at) return;
        kv_settings.set(latch_key, last.at);
        await push_text(
          `⚠️ Auto-deploy of ${last.to_sha?.slice(0, 8) ?? 'a merge'} failed its boot health check — ` +
            `rolled back to ${last.prev_sha.slice(0, 8)} and running fine. Beatrice is flagged with the details.`,
          memory,
          ulid(),
          'auto_deploy_rollback',
        );
        specialist_inbox.push({
          from_specialist_id: 'kate',
          to_specialist_id: 'trainer',
          kind: 'flag',
          body_md:
            `**Auto-deploy ROLLED BACK.** ${last.detail}\n\n` +
            `The merge is on main but NOT deployed. Diagnose the boot failure ` +
            `(read_service_logs hearth-orchestrator), fix via propose_code_edit, ` +
            `and the next merge re-deploys.`,
        });
      } catch (err) {
        console.error('[auto-deploy] boot reconciliation failed (fail-open):', err);
      }
    })();
  }, 15_000);
}

// Directed-dispatch boot reconciliation (2026-08-10): a directed build runs
// fire-and-forget in this process while its upstream records are already
// terminal (proposal acknowledged, trainer FYI says "do NOT re-file") — so a
// deploy restart mid-build used to lose the work with no visible trace (four
// approved builds died this way on 2026-08-10). The journal row the LoopDriver
// wrote before running is the recovery contract: any row still unfinished at
// boot is a restart casualty — re-fire it. Attempt-capped so a build that
// somehow kills the process can't crash-loop the boot; at the cap the row is
// abandoned LOUDLY (trainer inbox flag + audit row), never silently. The
// snapshot is taken synchronously at boot so dispatches fired AFTER boot can't
// be mistaken for casualties; the 15s delay (same posture as the auto-deploy
// check above) lets the tool loader and specialists settle first. Gated with
// the loops: a smoke/test boot must not spend real deliberations replaying a
// production journal.
if (process.env.HEARTH_DISABLE_LOOPS !== '1') {
  const stale = directed_dispatches.unfinished();
  if (stale.length > 0) {
    console.log(
      `[directed-dispatch] ${stale.length} unfinished directed dispatch(es) from a prior boot — reconciling in 15s`,
    );
    setTimeout(() => {
      for (const row of stale) {
        // Re-read: a short pass from the snapshot may have finished meanwhile.
        const live = directed_dispatches.get(row.id);
        if (!live || live.finished_at != null) continue;

        const label = live.proposal_id ? `proposal ${live.proposal_id}` : `'${(live.task?.instruction ?? '').slice(0, 80)}'`;
        if (!live.task || live.attempts >= MAX_DISPATCH_ATTEMPTS) {
          const reason = !live.task
            ? 'task_json unreadable'
            : `died in ${live.attempts} attempt(s) — not re-firing`;
          directed_dispatches.abandon(live.id, reason);
          memory.log_action({
            intent_id: ulid(),
            agent: 'orchestrator',
            tool_name: 'directed_dispatch_abandoned',
            tool_input: { dispatch_id: live.id, source: live.source, proposal_id: live.proposal_id, reason },
          });
          specialist_inbox.push({
            from_specialist_id: 'kate',
            to_specialist_id: BUILD_LEDGER_ID,
            kind: 'flag',
            ...(live.proposal_id ? { related_proposal_id: live.proposal_id } : {}),
            body_md:
              `**Directed build ABANDONED after ${live.attempts} attempt(s).** ` +
              `The dispatch for ${label} (via ${live.source}) never finished — each attempt was ` +
              `killed by an orchestrator restart or failed outright (${reason}). It will NOT be ` +
              `re-fired automatically. If the work still matters, re-dispatch it deliberately ` +
              `(the "do NOT re-file" guidance in the original FYI is void for this one).\n\n` +
              `Task: ${live.task?.instruction.slice(0, 600) ?? '(unreadable)'}`,
          });
          // Loud directed failures (2026-08-11): abandonment is the terminal
          // death of an approved build — Mariah's ledger must see it, not just
          // the trainer inbox. Same per-directive evidence key as the in-pass
          // failure shapes so every death of one build folds onto one row.
          try {
            const preview = (live.task?.instruction ?? live.id).slice(0, 240);
            const directive_key = createHash('sha256').update(preview).digest('hex').slice(0, 12);
            process_misses_store.create({
              subject_specialist_id: live.specialist_id,
              reporter: 'orchestrator',
              task_summary: `Directed build pass: "${preview.slice(0, 200)}"`,
              gap:
                `directed-build-failure (abandoned): the dispatch for ${label} (via ` +
                `${live.source}) was abandoned at the ${MAX_DISPATCH_ATTEMPTS}-attempt cap — ` +
                `${reason}. It will NOT be re-fired automatically; if the work still ` +
                `matters it must be re-dispatched deliberately.`,
              severity: 'high',
              evidence_ref: `directed-build-fail:${live.specialist_id}:${directive_key}`,
            });
          } catch (miss_err) {
            console.error('[directed-dispatch] failed to file abandonment miss:', miss_err);
          }
          console.error(`[directed-dispatch] ABANDONED ${live.id} (${label}): ${reason}`);
          continue;
        }

        directed_dispatches.bump_attempt(live.id);
        memory.log_action({
          intent_id: ulid(),
          agent: 'orchestrator',
          tool_name: 'directed_dispatch_refired',
          tool_input: {
            dispatch_id: live.id,
            source: live.source,
            proposal_id: live.proposal_id,
            attempt: live.attempts + 1,
            originally_fired_at: live.fired_at,
          },
        });
        console.log(
          `[directed-dispatch] re-firing ${live.id} (${label}, attempt ${live.attempts + 1}/${MAX_DISPATCH_ATTEMPTS})`,
        );
        void loop_driver
          .fire_deliberation_now(live.specialist_id, live.slot, live.task, live.user_id ?? undefined, {
            source: live.source,
            journal_id: live.id,
            ...(live.proposal_id ? { proposal_id: live.proposal_id } : {}),
          })
          .catch((err) => {
            console.error(`[directed-dispatch] re-fired dispatch ${live.id} failed:`, err);
          });
      }
    }, 15_000);
  }
}

console.log(`hearth-orchestrator listening on :${PORT}`);
console.log(`  vault:  ${VAULT_ROOT}`);
console.log(`  db:     ${DB_PATH}`);
console.log(`  ollama: ${OLLAMA_URL}`);
console.log(`  roles:  ${ROLES_PATH}`);
console.log(`  policy: ${POLICY_PATH}`);
console.log(`  inbox:  http://localhost:${PORT}/inbox`);
console.log(`  files:  http://localhost:${PORT}/files  (${LIBRARY_ROOT})`);
console.log(`  scribe: ${Array.from(scribe.tools.keys()).join(', ')}`);
console.log(
  `  specialists: ${specialists_registry.list().map((s) => s.id).join(', ')}`,
);
console.log(
  `  connector/specialist tools: ${tool_registry.list().map((t) => t.name).join(', ')}`,
);
console.log(`  app:    http://localhost:${PORT}/app/`);

// idleTimeout is in seconds — must exceed our longest LLM round-trip.
// Ollama serializes requests per model by default, so a queued 30s
// specialist turn while another is in flight can easily exceed 60s.
// Set to 255 (Bun's max) so we never drop a slow LLM call.
export default { port: PORT, fetch: app.fetch, idleTimeout: 255 };
