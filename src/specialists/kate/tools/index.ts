/**
 * Kate's special tools. Registered with the global ToolRegistry alongside
 * the connector tools. Capabilities are declared on each tool — only Kate
 * has `write_vault_general` and `write_proposals` together in the seed
 * config, but the gating is per-tool, so any future specialist that earns
 * those capabilities can also use these.
 */

import type { ToolRegistry } from '@core/tool_registry';
import type { ProposalsStore } from '@core/proposals';
import type {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import type { SpecialistRegistry } from '@core/specialist';
import type { Tool } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { AppEventBus } from '@app/events';
import { make_propose_action } from './propose_action';
import { make_recommend_to_user } from './recommend_to_user';
import { make_draft_message } from './draft_message';
import { make_update_jasper_style_memory } from './update_jasper_style_memory';
import { make_distill_jasper_style } from './distill_jasper_style';
import { make_observe_jasper_voice } from './observe_jasper_voice';
import { make_delegate_proposal } from './delegate_proposal';
import { make_promote_interrupt } from './promote_interrupt';
import { make_absorb_interrupt } from './absorb_interrupt';
import { make_schedule_calendar_event } from './schedule_calendar_event';
import { make_propose_hire } from './propose_hire';
import { make_flag_beatrice } from './flag_beatrice';
// Emergency-alert drill (2026-06-24): the MANUAL counterpart to the autonomous
// dangerous-weather driver — Kate fires a labeled test through both the
// Satellite1 (tone + speech) and a household push when the owner asks (voice/chat).
import { make_test_emergency_alert } from './test_emergency_alert';
// Announce-on-device (2026-07-21): speak an ARBITRARY sentence aloud on the
// Satellite1 on command ("say hi to Kyle on the speaker") — the free-text
// sibling of the emergency drill and the first "terminal act as a composable
// tool" wedge. Wraps the same proven try_speak_followup path, minus the fixed
// drill string.
import { make_announce_on_device } from './announce_on_device';
import { make_review_user_activity } from './review_user_activity';
import { make_update_user_profile } from './update_user_profile';
import { create as create_compose_news_takes } from './compose_news_takes';
import { create as create_query_news_items } from './query_news_items';
// Deep-research investigations (2026-06-19): the auto-handoff entry point +
// the two reads Kate uses to report back, plus the nightly sweep (job-only).
import { create as create_deep_research } from './deep_research';
import { create as create_archive_url } from './archive_url';
import { create as create_media_archive_status } from './media_archive_status';
import { create as create_rescan_media_metadata } from './rescan_media_metadata';
import { create as create_list_research_investigations } from './list_research_investigations';
import { create as create_get_research_investigation } from './get_research_investigation';
import { create as create_advance_research_investigations } from './advance_research_investigations';
// Capability-demand ledger (2026-07-14): the clustered tool-surface miss
// report — what the team keeps reaching for and lacking. Recurring real
// gaps become file_build_request specs (the agentic-acquisition loop).
import { create as create_read_capability_demand } from './read_capability_demand';
// System health (2026-06-20): the scan (background job) + the "is everything
// working?" read tool. Beatrice's restart_service auto-loads (no pack).
import { create as create_scan_system_health } from './scan_system_health';
import { create as create_scan_capability_yield } from './scan_capability_yield';
import { create as create_manage_llm_role } from './manage_llm_role';
import { create as create_review_change_windows } from './review_change_windows';
import { create as create_system_health } from './system_health';
// Case Driver tick (Incident→Immunity S1, 2026-07-02): walk open process
// misses to proven closure — nudge/verify wakes + escalate-once. Job-only;
// off her LLM surfaces. DARK behind HEARTH_CASE_DRIVER.
import { create as create_drive_open_cases } from './drive_open_cases';
// Proposal Court (2026-07-02): the Council tick — multi-lens consensus over
// the aged pending queue. Job-only; DARK behind HEARTH_PROPOSAL_COURT.
import { create as create_convene_proposal_court } from './convene_proposal_court';
// Walk-the-house reflection (C2 self-direction spine, 2026-07-03): nightly
// open-mandate pass + the durable observation/watch ledger. Job-only; DARK
// behind HEARTH_KATE_REFLECTION (act disposition further behind _ACT).
import { create_reflect_household } from './reflect_household';
// ...and the one-way door OUT of that ledger (2026-08-02). Unlike the tick,
// this one IS on her LLM surfaces: settling a watch for good is a judgment
// she makes in conversation, and the nightly envelope pass has no tool
// channel to reach it from.
import { create_settle_observation } from './settle_observation';
// Service mode (2026-07-08): owner-only self-introspection — Kate reads her OWN
// live loaded config (persona / prompt / capabilities / tools / model+jobs+triggers
// / raw YAML / the assembled system prompt) instead of deflecting. The LAW-#1 fix
// for the "show me your persona -> robotic refusal" gap.
import { create_reveal_self } from './reveal_self';
// Service mode (2026-07-14): pin (or report) Kate's spoken voice register —
// "speak warmer / use your tender voice / just read the room". Owner-only;
// persists a per-user preference the /api/voice/stream path applies.
import { create_set_voice_emotion } from './set_voice_emotion';
// 2026-07-21: owner-only transcript read of the owner's OWN thread with another
// specialist, so Kate works from the real conversation when he references it.
import { create_read_specialist_conversation } from './read_specialist_conversation';
// Service mode Phase B (2026-07-08): infra diagnostics — Kate reads the the LLM host
// Docker stack (Plex etc.) through the guarded ops-relay. Owner-gated; reads
// read-any, restart allowlist-gated at the relay.
import { create_infra_service } from './infra_service';
import { wake_host, sleep_host, list_power_hosts } from './host_power';
// Host diagnostics (2026-07-25): the layer BELOW the containers. Open-ended
// read-only command in a sandbox whose walls (no network, read-only `/`,
// `nobody`, caps dropped) are what make it safe — so a host-layer fault is
// observable instead of guessed at. Same `service_mode_infra` capability.
import { create_host_diag } from './host_diag';
// Court scorecard (trust-teeth Phase 1, 2026-07-02): court-vs-owner agreement
// read — per-lens + overall rates, reversals, backtest, the arming gate. On
// her chat surface so the owner can just ask "how's the court doing?".
import { create as create_court_scorecard } from './court_scorecard';
// Precedent memory (C3 self-direction, 2026-07-05): the nightly case indexer
// over the decided history (job-only) + the household-case-law recall read
// (chat + deliberation). DARK behind HEARTH_PRECEDENT.
import { create as create_index_precedent } from './index_precedent';
import { create as create_recall_precedent } from './recall_precedent';
// Per-user model nightly tick (2026-06-20): walk active users × facets and
// refresh the threshold-crossed ones. Job-only (Kate's 03:30 background_job);
// off her LLM surfaces.
import { create as create_sweep_user_models } from './sweep_user_models';
import { create as create_sweep_person_facts } from './sweep_person_facts';
// iMessage observer distill tick (2026-06-22): consume staged iMessage windows
// for opted-in contacts → person-note facts + observations, drop the raw.
// Job-only (Kate's 03:45 background_job); off her LLM surfaces.
import { create as create_distill_imessage_observations } from './distill_imessage_observations';
// People-engine synthesis pass (2026-06-24): promote durable/recurring observation
// signal into the dossier (facts + a cordoned relationship narrative), decay the
// ephemeral, surface actionable open loops as followups. Job-only (Kate's 04:00
// background_job, after the distill); off her LLM surfaces.
import { create as create_synthesize_person_dossiers } from './synthesize_person_dossiers';
// Household Knowledge Graph followups (2026-06-20): date-scan goods for closing
// return windows / expiring warranties and file a followup proposal on the edge.
// Job-only (Kate's background_job); off her LLM surfaces.
import { create as create_scan_good_followups } from './scan_good_followups';
// Services & Bills ledger (Phase A executive-assistant endgame, 2026-07-04):
// the weekly mail-exhaust learner (job-only) + the comprehensive chat read.
import { create as create_learn_household_services } from './learn_household_services';
import { create as create_manage_household_services } from './manage_household_services';
import { create as create_household_services } from './household_services';
// Phase C anticipation: the EXPECTED-but-missing bill probe + lapse edge over
// the ledger. Job-only (daily 08:35); DARK until HEARTH_BILL_ANTICIPATION=1.
import { create as create_scan_expected_bills } from './scan_expected_bills';
// Calendar Knowledge Graph followups (Phase 3, 2026-06-20): date-scan upcoming
// birthdays (→ gift) / vacations (→ flights) / appointments (→ prep) and file a
// followup proposal on the edge. Job-only (Kate's background_job); off her LLM
// surfaces. DARK until HEARTH_CALENDAR_TRIGGERS=1.
import { create as create_scan_calendar_followups } from './scan_calendar_followups';
import { create as create_scan_cross_signals } from './scan_cross_signals';
// People-engine Phase C (2026-06-25): scan the relationship life-event observation
// stream (a friend's trip / new job / engagement / move / loss) for a NEW,
// actionable milestone and offer to help, on the edge. Job-only; off her LLM
// surfaces. DARK until HEARTH_LIFE_EVENT_OFFERS=1.
import { create as create_scan_life_events } from './scan_life_events';
// People-engine Phase B (2026-06-25): "before you see them" — an upcoming meeting
// naming a known person → a briefing (open loops / what to bring up / overdue).
// Job-only; off her LLM surfaces. DARK until HEARTH_MEETING_PREP=1.
import { create as create_scan_meeting_prep } from './scan_meeting_prep';
// Calendar owner attribution (2026-06-20, Phase 2): record whose a
// generically-labeled shared-calendar event is, so future ones self-attribute.
import { create as create_set_event_owner } from './set_event_owner';
// People accretion (Phase 3, 2026-06-20): record what a person likes/dislikes/
// wears + past gifts, so the birthday→gift loop draws real ideas within a
// learned budget. Plain Tool (no construct deps).
import { record_person_pref } from './record_person_pref';
// Post Office (2026-06-20): the triaged-mail read surface (mail_list /
// mail_thread / mail_search) + the on-demand pull (mail_sync). The always-on
// IMAP IDLE driver does the continuous ingest; these answer "any replies?".
import { create_mail_tools } from './mail_tools';
// Kate's skeptic-review gate over Beatrice's self-modification changes. These
// live in sibling files but MUST be enumerated here — this directory is a pack
// (index.ts), so the ToolLoader loads only what this list returns; un-listed
// sibling files are silently ignored.
import { create as create_review_change } from './review_change';
import { create as create_list_changes_for_review } from './list_changes_for_review';
import {
  make_list_proposals_for_review,
  make_review_trainer_proposal,
} from './review_trainer_proposal';
// Person + decision write tools shared with the Scribe agent. The
// Scribe versions retain their /scribe/* HTTP routes for legacy
// callers; here we hand the same Tool objects (now annotated with
// `required_capabilities: ['write_vault_general']`) to the registry
// so Kate can invoke them inside a chat turn. Without this, Kate had
// nowhere to land notes about a household member — the symptom Jasper
// hit asking her about Sam.
import { find_or_create_person } from '@agents/scribe/tools/find_or_create_person';
import { upsert_person_note } from '@agents/scribe/tools/upsert_person_note';
import { record_decision } from '@agents/scribe/tools/record_decision';
// Relationship graph (Phase 0): told-first authoring + the graph-walk read, so
// Kate understands who-is-who ("Rosa is Sam's hairdresser") instead of
// reading people at face value. Both use ctx at runtime — no factory deps.
import { record_relationship } from './record_relationship';
import { who_is } from './who_is';
import { delete_person } from './delete_person';
// The old Concierge agent's birthdays/anniversaries read, re-homed here when
// the fixed-persona Concierge retired (2.0 P0, 2026-07-06). The social-secretary
// surface needs it so Kate's occasions sweep queries the people table instead
// of recalling dates from persona memory.
import { upcoming_dates } from './upcoming_dates';
// Folded-domain tools re-homed here in the 2.0 P0 pass (2026-07-06). They
// used to live under src/specialists/{iris,luna,marguerite}/tools/, where the
// ToolLoader's per-file scan registered them; kate/tools has THIS aggregator,
// so they must be returned from create() explicitly or they never register.
import { plan_ev_day } from './plan_ev_day';
import { create as create_update_luna_vault } from './update_luna_vault';
import { create as create_distill_house_day } from './distill_house_day';
import { import_gedcom } from './import_gedcom';

export interface KateToolDeps {
  proposals: ProposalsStore;
  inbox: SpecialistInbox;
  interrupts: InterruptStore;
  conversations: ConversationStore;
  specialists: SpecialistRegistry;
  vault_root: string;
  events?: AppEventBus;
}

export function register_kate_tools(
  registry: ToolRegistry,
  deps: KateToolDeps,
): void {
  // The registry being registered INTO is also the internal-action gate's
  // risk-tier source — a dispatch_tool naming a read/write_internal tool is
  // rejected at filing time with a "call it directly" steer.
  registry.register(
    make_propose_action(deps.proposals, {
      tool_registry: registry,
      specialists: deps.specialists,
    }) as Tool,
  );
  registry.register(make_recommend_to_user(deps.proposals) as Tool);
  registry.register(make_draft_message(deps.proposals, deps.vault_root) as Tool);
  registry.register(make_update_jasper_style_memory(deps.vault_root) as Tool);
  registry.register(make_distill_jasper_style(deps.vault_root) as Tool);
  registry.register(
    make_observe_jasper_voice(deps.vault_root, deps.conversations) as Tool,
  );
  registry.register(
    make_delegate_proposal(deps.proposals, deps.inbox, deps.specialists) as Tool,
  );
  registry.register(make_promote_interrupt(deps.interrupts, deps.events) as Tool);
  registry.register(make_absorb_interrupt(deps.interrupts) as Tool);
  registry.register(make_schedule_calendar_event(deps.proposals) as Tool);
  registry.register(make_flag_beatrice(deps.inbox, deps.events) as Tool);
  registry.register(make_update_user_profile(deps.vault_root) as Tool);
  registry.register(record_person_pref as Tool);
  registry.register(find_or_create_person as Tool);
  registry.register(upsert_person_note as Tool);
  registry.register(record_decision as Tool);
  registry.register(upcoming_dates as Tool);
  registry.register(record_relationship as Tool);
  registry.register(who_is as Tool);
  registry.register(delete_person as Tool);
}

/**
 * ToolLoader entry point. Kate's tools are a pack — this directory's
 * index aggregates them, so the loader treats index.ts as the single
 * entry and reloads the whole pack when any file in it changes.
 */
export function create(deps: ToolDeps): Tool[] {
  return [
    // tool_registry backs the internal-action gate: an action_proposal whose
    // named tool is read/write_internal is rejected with a do-it-now steer.
    make_propose_action(deps.proposals, {
      tool_registry: deps.tool_registry,
      specialists: deps.specialists,
    }) as Tool,
    make_recommend_to_user(deps.proposals) as Tool,
    make_draft_message(deps.proposals, deps.vault_root) as Tool,
    make_update_jasper_style_memory(deps.vault_root) as Tool,
    make_distill_jasper_style(deps.vault_root) as Tool,
    make_observe_jasper_voice(deps.vault_root, deps.conversations) as Tool,
    make_delegate_proposal(deps.proposals, deps.inbox, deps.specialists) as Tool,
    make_promote_interrupt(deps.interrupts, deps.events) as Tool,
    make_absorb_interrupt(deps.interrupts) as Tool,
    make_schedule_calendar_event(deps.proposals) as Tool,
    make_propose_hire(deps.proposals, deps.specialists, deps.tool_registry) as Tool,
    make_flag_beatrice(deps.inbox, deps.events) as Tool,
    make_test_emergency_alert(deps.users) as Tool,
    make_announce_on_device() as Tool,
    make_update_user_profile(deps.vault_root) as Tool,
    make_review_user_activity(deps.db, deps.conversations, deps.users) as Tool,
    create_review_change(deps) as Tool,
    create_list_changes_for_review(deps) as Tool,
    // Kate's pre-review gate for Beatrice's self-improvement SPECS
    // (binding_proposal / persona_tuning / recommendation) — the sibling of
    // the code-change gate above. They're held `pending_kate_review` until she
    // promotes them to the owner or sends them back to Beatrice.
    make_list_proposals_for_review(deps.proposals) as Tool,
    make_review_trainer_proposal({
      proposals: deps.proposals,
      inbox: deps.inbox,
      events: deps.events,
    }) as Tool,
    // Kate's Read — the 04:10 News Desk take composer (background job;
    // not on her LLM surfaces).
    create_compose_news_takes(deps) as Tool,
    // Brief-time read of the desk's raw headlines, grouped by category —
    // on her deliberation surface so the 07:00 brief opens with overnight
    // news, cited by source domain.
    create_query_news_items(deps) as Tool,
    // Deep research: the chat hand-off + the two reads (surfaced in
    // tools_for_chat) + the nightly sweep tool (job-only, off her LLM
    // surfaces — the background_jobs runner invokes it by name).
    create_deep_research(deps) as Tool,
    create_archive_url(deps) as Tool,
    create_media_archive_status(deps) as Tool,
    create_rescan_media_metadata(deps) as Tool,
    create_list_research_investigations(deps) as Tool,
    create_get_research_investigation(deps) as Tool,
    create_advance_research_investigations(deps) as Tool,
    // System health: the read tool (tools_for_chat) + the scan (background job,
    // off her LLM surfaces — the background_jobs runner invokes it by name).
    create_system_health(deps) as Tool,
    create_scan_system_health(deps) as Tool,
    create_scan_capability_yield(deps) as Tool,
    create_manage_llm_role(deps) as Tool,
    create_review_change_windows(deps) as Tool,
    create_drive_open_cases(deps) as Tool,
    create_convene_proposal_court(deps) as Tool,
    // Walk-the-house reflection tick (C2 self-direction spine; job-only, off
    // her LLM surfaces — the background_jobs runner invokes it by name).
    create_reflect_household(deps) as Tool,
    create_settle_observation(deps) as Tool,
    // Service mode (owner-only self-reveal): the LAW-#1 fix for "show me your
    // persona -> robotic refusal" — reads the real loaded config, never memory.
    create_reveal_self(deps) as Tool,
    create_set_voice_emotion(deps) as Tool,
    create_read_specialist_conversation(deps) as Tool,
    // Service mode Phase B: infra diagnostics (list_services / diagnose_service /
    // restart_container) — Kate reads the the LLM host Docker stack via the ops-relay.
    ...create_infra_service(deps),
    // Host diagnostics: the machine layer under the containers (owner-only).
    ...create_host_diag(deps),
    // Host POWER (owner-only): wake a machine with WoL / put it back to sleep.
    // Allowlisted in config/power_hosts.yaml; the always-on and mid-session
    // refusals are enforced on the TARGET's agentd, not here.
    wake_host as Tool,
    sleep_host as Tool,
    list_power_hosts as Tool,
    // Court scorecard: the agreement read (tools_for_chat) — the convening
    // itself stays job-only above.
    create_court_scorecard(deps) as Tool,
    // Precedent memory (C3): the case indexer (job-only, off her LLM surfaces —
    // the background_jobs runner invokes it by name) + the recall read
    // (tools_for_chat + tools_for_deliberation). DARK behind HEARTH_PRECEDENT.
    create_index_precedent(deps) as Tool,
    create_recall_precedent(deps) as Tool,
    // Capability-demand ledger read (tools_for_chat + tools_for_deliberation).
    create_read_capability_demand(deps) as Tool,
    // Per-user model nightly tick (job-only, off her LLM surfaces — the
    // background_jobs runner invokes it by name).
    create_sweep_user_models(deps) as Tool,
    create_sweep_person_facts(deps) as Tool,
    // iMessage observer distill (job-only, off her LLM surfaces — the
    // background_jobs runner invokes it by name).
    create_distill_imessage_observations(deps) as Tool,
    // People-engine synthesis pass (job-only, off her LLM surfaces — the
    // background_jobs runner invokes it by name).
    create_synthesize_person_dossiers(deps) as Tool,
    // Household-goods followups (job-only, off her LLM surfaces — the
    // background_jobs runner invokes it by name).
    create_scan_good_followups(deps) as Tool,
    // Services & Bills ledger (Phase A executive-assistant endgame, 2026-07-04):
    // the weekly mail-exhaust learner (job-only, off her LLM surfaces) + the
    // comprehensive chat read ("do we have trash service?", "lay out my bills").
    // DARK until HEARTH_HOUSEHOLD_SERVICES=1 (the read works as soon as the
    // ledger has rows).
    create_learn_household_services(deps) as Tool,
    create_household_services(deps) as Tool,
    // Told-first ledger writes (2026-07-05) — the chat-time mutation tool
    // (add/update/deactivate/remove/list), source 'manual' + confidence 1.0.
    create_manage_household_services(deps) as Tool,
    // Phase C — the expected-but-missing bill probe + lapse edge (job-only).
    // DARK until HEARTH_BILL_ANTICIPATION=1.
    create_scan_expected_bills(deps) as Tool,
    // Calendar followups — birthday→gift / vacation→flights / appointment→prep
    // (job-only, off her LLM surfaces). DARK until HEARTH_CALENDAR_TRIGGERS=1.
    create_scan_calendar_followups(deps) as Tool,
    // Cross-signal "I noticed" fusion nudges — visitor+occasion / double-booking
    // (job-only, off her LLM surfaces). DARK until HEARTH_CROSS_SIGNAL=1.
    create_scan_cross_signals(deps) as Tool,
    // Life-event proactive offers — a friend's trip/new job/engagement/move/loss
    // (job-only, off her LLM surfaces). DARK until HEARTH_LIFE_EVENT_OFFERS=1.
    create_scan_life_events(deps) as Tool,
    // "Before you see them" meeting prep — an upcoming meeting with a known person
    // (job-only, off her LLM surfaces). DARK until HEARTH_MEETING_PREP=1.
    create_scan_meeting_prep(deps) as Tool,
    // Calendar owner attribution — the learn path (chat tool).
    create_set_event_owner(deps) as Tool,
    // People accretion — the learn path (chat tool): likes/dislikes/sizes/gifts.
    record_person_pref as Tool,
    // Post Office: mail_list / mail_thread / mail_search (read_mail) +
    // mail_sync (ingest_mail). send_email is NOT here — dispatch-only.
    ...create_mail_tools(deps),
    find_or_create_person as Tool,
    upsert_person_note as Tool,
    record_decision as Tool,
    upcoming_dates as Tool,
    // Folded-domain tools (EV day-planning, house ledger, genealogy import) —
    // granted via kate.yaml since the 2026-07-04 fold-in, re-homed 2026-07-06.
    plan_ev_day as Tool,
    create_update_luna_vault(deps) as Tool,
    // Nightly house ledger (Phase 3, 2026-07-13) — the 05:10 house_ledger job
    // distills yesterday into Knowledge/Luna/house-log.md (job-only surface).
    create_distill_house_day(deps) as Tool,
    import_gedcom as Tool,
    // Relationship graph (Phase 0): understand who-is-who, told-first.
    record_relationship as Tool,
    who_is as Tool,
    delete_person as Tool,
  ];
}
