/**
 * Process-local event bus for the unified UI's SSE channel.
 *
 * The orchestrator emits typed events at state-changing moments
 * (message added, proposal created/decided, interrupt raised, etc.).
 * The /app/api/events SSE route subscribes to this bus and streams
 * each event as a "data: <json>\n\n" frame.
 *
 * This is a deliberately tiny abstraction — single process, no broker.
 * If we ever go multi-process the bus will need a redis-like backend,
 * but for v0 a local pub/sub is enough.
 */

export type AppEvent =
  | {
      type: 'message_added';
      conversation_id: string;
      message_id: string;
      role: 'user' | 'specialist' | 'system';
      specialist_id?: string;
      content_preview: string;
    }
  | {
      type: 'proposal_created';
      proposal_id: string;
      specialist_id: string;
      kind: string;
      title_preview: string;
    }
  | {
      /**
       * Linda persisted a marketplace listing draft via `draft_listing`.
       * The web client fetches the full row (GET /api/listing-drafts/:id)
       * and renders the listing card anchored under her message in the
       * conversation. Mirrors `questions_presented`.
       */
      type: 'listing_draft_created';
      listing_draft_id: string;
      specialist_id: string;
      conversation_id: string | null;
      user_id: string;
    }
  | {
      type: 'proposal_decided';
      proposal_id: string;
      verdict: 'approve' | 'deny';
    }
  | {
      type: 'interrupt_raised';
      interrupt_id: string;
      originating_specialist_id: string;
      severity: 'low' | 'medium' | 'medium-high' | 'high';
      summary: string;
    }
  | {
      type: 'specialist_thinking';
      specialist_id: string;
      conversation_id: string;
      state: 'started' | 'finished';
    }
  | {
      /**
       * Per-specialist activity LED (HDD-blink indicators in the UI).
       * Emitted at the REAL async boundaries of an operation — `state:'on'`
       * the instant it starts, `state:'off'` the instant it returns — so the
       * lights are faithful to live backend work, never timed fakes. Pure
       * in-process pub/sub on the already-open SSE stream → ~zero cost.
       *
       * Channels are independent and can overlap:
       *  - 'rag'  — retrieval/consult in flight (turn-start auto-RAG,
       *             `search_library`).
       *  - 'deep' — deep-think escalation to the Spark's 80B
       *             (`consult_deep_model`) in flight.
       * ('live' — the specialist is generating a reply — is the EXISTING
       *  `specialist_thinking` started/finished signal; no new event needed.)
       */
      type: 'specialist_activity';
      specialist_id: string;
      conversation_id?: string;
      channel: 'rag' | 'deep';
      state: 'on' | 'off';
    }
  | {
      type: 'specialist_status';
      specialist_id: string;
      /** Set during a chat/voice turn so the client can scope the live
       *  "what they're doing right now" line to the right thread. Omitted
       *  for ambient/standby status. */
      conversation_id?: string;
      status: string | null;
      ttl_seconds?: number;
    }
  | {
      type: 'library_updated';
      specialist_id: string;
      item_count_delta: number;
    }
  | {
      type: 'inbox_message_added';
      message_id: string;
      from_specialist_id: string;
      to_specialist_id: string;
      kind: 'flag' | 'question' | 'fyi' | 'consult_response';
      severity: 'low' | 'medium' | 'medium-high' | 'high';
    }
  /**
   * Workout session lifecycle events (Astrid Pass 3). iOS posts to
   * /api/sensors/workout with one of three kinds; the route emits
   * the matching AppEvent so the live-mode subscriber wakes Astrid
   * (on start), evaluates throttle + smart-triggers (on packet), and
   * updates the PR shelf + clears the in-memory session state (on
   * completion). session_id is iOS-assigned (ULID) and stable across
   * the three event types — the orchestrator never invents it.
   */
  | {
      type: 'workout_started';
      session_id: string;
      user_id: string;
      workout_type: string;
      started_at: string;
    }
  | {
      type: 'workout_packet';
      session_id: string;
      user_id: string;
      /** Captured-at iso ts from the packet, for de-stale handling. */
      captured_at: string;
      /** Seconds elapsed since session start, per the packet payload. */
      elapsed_s: number;
      /** Active kcal burned so far, per the packet payload. */
      active_kcal: number;
      /** Current HR (bpm) if reported; otherwise null. */
      current_hr: number | null;
      /** Current HR zone (1-5) if reported; otherwise null. */
      current_hr_zone: number | null;
      /** Cumulative barometric elevation gain (m) if reported. */
      elevation_gain_m: number | null;
    }
  | {
      type: 'workout_completed';
      session_id: string;
      user_id: string;
      workout_type: string;
      ended_at: string;
      total_active_kcal: number;
      total_duration_s: number;
      total_distance_m: number | null;
      /** Total barometric elevation gain (m) if reported. */
      elevation_gain_m: number | null;
      /** Watch-estimated average cycling power (W) if reported. */
      avg_power_w: number | null;
      /** On-device-derived route descriptors (road/place names only). */
      route_notes: string[] | null;
    }
  | {
      type: 'brief_generated';
      brief_id: string;
      kind: 'morning' | 'midday' | 'evening' | 'overnight' | 'ad_hoc';
      mood: 'calm' | 'attentive' | 'concerned';
      /** The user this brief was generated for. iOS filters its
       *  TodayView refresh to events where user_id matches the
       *  signed-in user so Sam's app doesn't refresh on Jasper's
       *  brief landing (and vice versa). Optional for legacy
       *  consumers; new emitters always include it. */
      user_id?: string;
    }
  | {
      type: 'specialist_visited';
      specialist_id: string;
      ts_last_visited: string;
    }
  | {
      type: 'search_index_updated';
    }
  | {
      type: 'conversation_created';
      conversation_id: string;
      specialist_id: string;
      user_id?: string;
      source_surface: 'web' | 'telegram' | 'voice';
    }
  | {
      type: 'push_dispatched';
      push_id?: string;
      kind: string;
      severity?: 'low' | 'medium' | 'medium-high' | 'high';
      delivered: boolean;
      via: 'apns' | 'queued' | 'audit_only';
    }
  | {
      type: 'active_specialist_changed';
      user_id: string;
      specialist_id: string;
    }
  | {
      /**
       * Progress signal for an in-flight library upload. The client
       * generates an `upload_id` on drag-drop and renders a ghost row
       * with italic status text; this event updates the status line
       * through the upload phases.
       */
      type: 'library_upload_progress';
      upload_id: string;
      specialist_id: string;
      filename: string;
      phase: 'received' | 'converting' | 'summarizing' | 'indexing' | 'acknowledging' | 'done' | 'failed';
      detail?: string;
      error?: string;
    }
  | {
      /**
       * Streaming token delta for a specialist's in-flight reply.
       * Clients accumulate `delta` into the typing bubble for the
       * matching conversation_id; on the next `message_added` event
       * with the same conversation_id, replace the streamed buffer
       * with the persisted message body.
       */
      type: 'message_token';
      conversation_id: string;
      specialist_id: string;
      /** Stable id for this streaming session; lets the client
       *  distinguish multiple concurrent streams or detect resets. */
      stream_id: string;
      delta: string;
    }
  | {
      /**
       * Streaming token delta for the specialist's `<think>` reasoning
       * channel, when the LLM emits one (Qwen 3.6 with think:true).
       * Clients accumulate into a collapsible "Thinking…" pill above
       * the streaming bubble — feedback for the otherwise-dead 1–2s
       * before the visible reply starts streaming. Cleared by the
       * paired `specialist_thinking: finished` for the same conv.
       *
       * Same `stream_id` as the `message_token` events for the same
       * round, so the client can reset thinking + content together
       * when a multi-round turn starts a new round.
       */
      type: 'message_thinking_token';
      conversation_id: string;
      specialist_id: string;
      stream_id: string;
      delta: string;
    }
  | {
      /**
       * A streamed draft reply was rejected by a finalize guard and is
       * being regenerated. The client should DROP the live draft under
       * `stream_id` (clear the streaming bubble) and show a brief
       * "refining…" state — the corrected reply arrives via the next
       * `message_added` on the same conversation, NOT as a re-typed live
       * stream (the redo is withheld). This is the graceful swap that
       * replaces the old wipe-and-retype on a guard re-roll; emitted only
       * when a draft was actually shown live this round (research/voice
       * turns). Hold-back turns never show a draft, so never emit this.
       */
      type: 'message_superseded';
      conversation_id: string;
      specialist_id: string;
      stream_id: string;
    }
  | {
      /**
       * A tool call has just been invoked during a specialist turn.
       * Emitted once per tool BEFORE the tool executes, so the client
       * can render a live status line ("🔍 Marguerite is searching the
       * web…") even during long tool rounds where Ollama is silent
       * during prompt-eval. Pairs with `tool_completed` on the same
       * tool_call_id when the tool returns.
       */
      type: 'tool_invoked';
      conversation_id: string;
      specialist_id: string;
      tool_call_id: string;
      tool_name: string;
      /** One-line, user-readable summary of what the tool is doing —
       *  derived from the tool input (e.g. the URL for web_fetch_clean,
       *  the query string for web_search). Never raw JSON. */
      input_summary: string;
      /** Optional multi-line snippet of WHAT the tool is producing — populated
       *  for the code tools (propose_code_change / propose_code_edit) with the
       *  PR title + file(s) + a capped head of the code being written, so a UI
       *  can show a live "code in progress" preview during a directed build.
       *  Capped at emit time; absent for non-code tools. */
      preview?: string;
    }
  | {
      type: 'tool_completed';
      conversation_id: string;
      specialist_id: string;
      tool_call_id: string;
      tool_name: string;
      ok: boolean;
    }
  | {
      /**
       * The specialist successfully scheduled a `promise_followup`.
       * Carries enough for the client to render a pending-followup
       * pill below the message in question (and ungated in the staff
       * rail). Cleared when the actual follow-up message lands via
       * `message_added` on the same conversation.
       */
      type: 'followup_scheduled';
      conversation_id: string;
      specialist_id: string;
      followup_id: string;
      summary: string;
      fire_at_iso: string;
    }
  | {
      type: 'followup_delivered';
      conversation_id: string;
      specialist_id: string;
      followup_id: string;
      message_id: string;
    }
  | {
      /**
       * A sub-agent delegation dispatched (delegate tool → DelegationRunner).
       * Content-free BY DESIGN — ids + display names + mode only, no task
       * text (the SSE stream fans out to every connected client; task detail
       * is fetched per-caller through the cordoned
       * GET /api/specialists/:id/delegations). The web client renders a live
       * "working…" chip on the conversation + bumps the subagent tray badge.
       * Cleared by `delegation_completed` with the same delegation_id.
       */
      type: 'delegation_started';
      delegation_id: string;
      /** The requesting specialist (tray owner), e.g. 'kate'. */
      requested_by: string;
      /** The delegatee profile actually doing the work. */
      profile_id: string;
      profile_name: string;
      mode: 'quick' | 'background';
      /** Originating conversation, when the delegate call came from a real
       *  chat turn (null for deliberation/delegate-nested contexts). */
      conversation_id: string | null;
    }
  | {
      /** Terminal state of a delegation — ok:false covers failures. */
      type: 'delegation_completed';
      delegation_id: string;
      requested_by: string;
      profile_id: string;
      profile_name: string;
      ok: boolean;
      conversation_id: string | null;
    }
  | {
      /**
       * A specialist invoked `present_questions` and a pending_questions
       * row was persisted. Carries enough for the client to fetch the
       * full set and render the inline form on the matching specialist
       * message (or in Kate's right-rail brief, when attached to a
       * brief_id). Cleared by `questions_answered` for the same
       * question_set_id.
       */
      type: 'questions_presented';
      question_set_id: string;
      specialist_id: string;
      conversation_id: string | null;
      brief_id: string | null;
      question_count: number;
    }
  | {
      /**
       * Jasper submitted a `present_questions` form. Followed shortly
       * by a `message_added` carrying the specialist's resumed reply.
       */
      type: 'questions_answered';
      question_set_id: string;
      specialist_id: string;
      conversation_id: string | null;
      brief_id: string | null;
    }
  | {
      /**
       * PLAN.md changed on disk. The Roadmap overlay refetches and
       * re-renders on receipt. mtime_ms is informational (clients
       * compare to their last-fetched payload's `mtime`).
       */
      type: 'roadmap_updated';
      mtime_ms: number;
    }
  | {
      /**
       * A specialist's authenticity score was recomputed by Mariah's
       * scan_specialist_authenticity job (daily at 04:45, or ad-hoc
       * deliberation). The staff rail updates the badge live; nothing
       * else needs to react. Score is 0-100; a fresh score of 100
       * means zero authenticity findings in the lookback window.
       */
      type: 'authenticity_updated';
      specialist_id: string;
      score: number;
      ts_computed: string;
    }
  | {
      /**
       * A finalize reply-guard CAUGHT (or the model ADMITTED) a quality/honesty
       * miss this turn — a fabricated save/action, a ghost promise, an
       * answered-over read failure, a data-denial-without-query, or an
       * ungrounded citation/provenance/fact-critic claim — OR a tool call could
       * not be arg-recovered and spiralled. The GuardFeedbackDriver
       * (src/core/guard_feedback.ts) aggregates these per (class, guard,
       * tool/specialist) over a rolling window and, on a RECURRENCE edge, files a
       * process_miss (Mariah's ledger) + wakes Beatrice with a scoped diagnostic
       * task. A single catch is NOT an incident — the in-turn re-roll already
       * handled it; only a recurring pattern escalates. Deliberately LIGHT
       * fan-out: the durable record is the audit row written alongside each
       * catch (the driver re-counts from the audit log), so a dropped event only
       * delays the edge, never corrupts the count. The runtime emits it
       * fail-open; nothing user-facing reacts.
       */
      type: 'quality_signal';
      specialist_id: string;
      /** 'honesty' — a finalize-guard fabrication/denial catch; 'arg_mismatch' —
       *  a tool call that could not be recovered / spiralled; 'yield' — a
       *  capability that RAN CLEANLY and produced nothing (2026-08-01: the
       *  class error rate structurally cannot see — see
       *  src/core/capability_yield.ts). Picks the evidence_ref shape + which
       *  meta-agent diagnoses it.
       *
       *  Note the different clock: honesty/arg_mismatch signals arrive from a
       *  live turn, so their edge is instant. A yield edge is inherently
       *  MULTI-RUN (one barren night proves nothing about a daily job), so it
       *  is detected by `scan_capability_yield` and emitted here. What became
       *  instant is the escalation once the edge is real — before this the
       *  class never escalated at all. */
      signal_class: 'honesty' | 'arg_mismatch' | 'yield';
      /** The guard / audit `tool_name` that fired (e.g. 'fabricated_save_guard',
       *  'data_denial_guard', 'same_tool_spiral_exhaust'). Half of the
       *  evidence_ref key; the driver also counts audit rows of this name. */
      guard: string;
      /** The tool involved, when the signal is about a specific tool
       *  (arg_mismatch always; most honesty catches have none). */
      tool?: string;
      /** The specific failing field, for an arg_mismatch — completes the
       *  `arg-mismatch:<tool>:<field>` evidence_ref. */
      field?: string;
      /** Short human-readable detail (a reply / arg preview) for the miss gap. */
      detail: string;
      conversation_id?: string;
      user_id?: string;
    }
  | {
      /**
       * iOS pushed a sensor packet to /api/sensors/:signal. Fan-out is
       * deliberately light: consumers (Iris's runtime, Kate's router)
       * subscribe to the event then re-fetch the packet via the DB
       * index if they need the body, keeping the bus from carrying
       * arbitrarily large payloads. See BACKEND_SENSORS_BRIEF.md and
       * architecture.md § "Device-as-sensor pipeline".
       */
      type: 'sensor_packet_received';
      user_id: string;
      signal: string;
      captured_at: string;
      packet_id: string;
    }
  | {
      /**
       * A specialist declared an action they're about to take. iOS
       * starts a countdown Live Activity (`PreCommitAttributes`)
       * showing the summary + a "Stop" affordance. If the user taps
       * Stop, iOS POSTs /api/kate/precommit/:id/intercept; otherwise
       * the backend scheduler fires the dispatched action at
       * executes_at and emits `precommit_executed`.
       *
       * Spec: BACKEND_FILTER_BRIEF.md (Phase 3 minimum). v0.1 ships
       * the rails; the actual dispatch_tool invocation on expiry is
       * deferred until a real specialist tool uses the lane.
       */
      type: 'precommit_proposed';
      id: string;
      specialist_id: string;
      summary: string;
      window_seconds: number;
      executes_at: string;
    }
  | {
      /** User tapped "Stop" on the Live Activity. iOS ends the activity
       *  on receipt. */
      type: 'precommit_intercepted';
      id: string;
    }
  | {
      /** Window expired without intercept; backend scheduler executed
       *  (or marked-executed) the action. iOS ends the activity. */
      type: 'precommit_executed';
      id: string;
    }
  | {
      /**
       * A specialist proposed adding an event to the user's calendar
       * via the iOS-as-CalDAV-adapter flow (BACKEND_SENSORS_BRIEF
       * "Calendar write-back"). Always co-emitted with `proposal_created`
       * — clients that already handle `proposal_created` keep working;
       * iOS subscribes to this variant specifically to surface
       * EKEventStore-bound flow without parsing every proposal payload.
       *
       * iOS responds by writing the event locally and POSTing
       * `/api/proposals/:proposal_id/decide` with `{ verdict: "approve" }`
       * (low-stakes auto-apply) or routing through the confirmation
       * sheet first (higher-stakes).
       */
      type: 'calendar_event_proposed';
      proposal_id: string;
      specialist_id: string;
      title: string;
      ts_start: string;
      ts_end: string;
      location: string | null;
      calendar_hint: 'work' | 'personal' | 'household' | null;
      /** Set ⇒ this is a MOVE: the iOS event_id to relocate in place.
       *  Null ⇒ a fresh add. */
      replaces_event_id: string | null;
      /** iOS sets EKEvent.isAllDay when true. */
      is_all_day: boolean;
    }
  | {
      /**
       * A Cordelia capture has just been persisted by
       * POST /api/cordelia/capture. The reactive inbox driver
       * subscribes to this and pipes the capture through the
       * cluster buffer + classifier; downstream specialists never
       * read this directly. Carries enough for the driver to load
       * the capture without re-parsing multipart.
       */
      type: 'capture_received';
      capture_id: string;
      user_id: string;
      kind: 'voiceMemo' | 'photo' | 'sharedText' | 'sharedFile';
      note_path: string;
      attachment_path: string | null;
      captured_at: string;
    }
  | {
      /**
       * The reactive driver has finished classifying a capture
       * and written zero-or-more capture_routes rows. iOS Library
       * tab subscribes to update the routed-to chips on the
       * matching capture row without polling. `specialist_ids`
       * empty + `confidence: 0` means the classifier was below
       * threshold and routed to Kate for triage instead.
       */
      type: 'capture_routed';
      capture_id: string;
      specialist_ids: string[];
      confidence: number;
      route_reason: string;
      clustered_with: string[];
    }
  | {
      /**
       * The user's specialist UI prefs (favorites or sort_order)
       * changed. iOS surfaces (Today bento + Staff roster) subscribe
       * to re-sort without a full roster refetch — the row data is
       * the same; only the favorited flag and the position changed.
       * `user_id` so each household member only acts on their own
       * mutations.
       */
      type: 'specialist_prefs_changed';
      user_id: string;
      specialist_id?: string;
      kind: 'favorited' | 'reordered';
    }
  | {
      /**
       * Linda recorded or updated a tracked resale item via
       * `track_listing` (the chosen-listing card, a price drop, or a
       * sale). Linda's `resale` office pane reads the per-user sales
       * ledger, so the web client drops its pane cache for Linda and
       * refetches `GET /api/specialists/linda/pane` on receipt. Mirrors
       * `listing_draft_created` but targets the office, not the chat
       * card.
       */
      type: 'resale_item_updated';
      resale_item_id: string;
      specialist_id: string;
      user_id: string;
    }
  | {
      /**
       * Kate's deep-research runner advanced an investigation a slice
       * (plan → investigating → verifying → synthesizing → done/failed;
       * also `incomplete`, a partial dossier whose unattempted facets the
       * sweep will resume — the office renders it as still active).
       * The Research office tab drops its pane cache and refetches
       * GET /api/specialists/kate/research on receipt so the live progress
       * bar tracks the detached job. Per-slice granularity (not per-source)
       * — the runner persists per slice; the client acts only on its own
       * user_id (the cordon). Office-refetch event, no replay state.
       */
      type: 'research_investigation_updated';
      investigation_id: string;
      specialist_id: string;
      subject: string;
      status: string;
      user_id: string | null;
    }
  | {
      /**
       * The Voice Coordinator republished a throttled LD2450 target snapshot
       * (≤4 Hz) to POST /api/presence/targets. The presence office canvas
       * subscribes and repaints live target dots on rAF. Live targets are
       * ephemeral (PresenceLiveCache, not SQLite) — this is a pure fan-out
       * signal, NOT tracked in active_streams; no replay-on-subscribe (the
       * next frame refreshes it, and GET /api/presence/state covers cold
       * load). Mirrors `sensor_packet_received`'s light fan-out. Fields mirror
       * `PresenceSnapshot` (src/core/presence_cache.ts).
       */
      type: 'presence_targets';
      device_id: string;
      present: boolean;
      moving: number;
      still: number;
      nearest_mm: number | null;
      targets: Array<{
        index: number;
        x_mm: number;
        y_mm: number;
        speed_mms: number;
        angle_deg: number | null;
        distance_mm: number;
        active: boolean;
      }>;
      captured_at: string;
    }
  | {
      /**
       * The coordinator applied (or failed to apply) a desired zone config and
       * acked via POST /api/presence/zones/ack. The presence office editor
       * subscribes to confirm "✓ applied" / "⟳ reboot needed" / "⚠ error" on
       * the matching revision. Mirrors `proposal_decided`'s terse shape.
       */
      type: 'presence_zones_acked';
      device_id: string;
      revision: number;
      applied: boolean;
      reboot_required: boolean;
      error: string | null;
    }
  | {
      /**
       * A new inbound message was triaged into Kate's Post Office (by the
       * IMAP IDLE push driver or an on-demand mail_sync). The Post Office
       * office tab drops its pane cache + refetches GET
       * /api/specialists/kate/postoffice on receipt so a new reply/important
       * mail surfaces without a refresh. Office-refetch fan-out, no replay
       * state (mirrors `resale_item_updated`). `message_id` is the
       * mail_messages row id; `user_id` is the account owner (cordon).
       */
      type: 'mail_message_triaged';
      account_id: string;
      message_id: string;
      bucket: 'needs_you' | 'replies' | 'new_mail' | 'fyi' | 'junk';
      specialist_id: string;
      user_id: string;
    }
  | {
      /**
       * A Post Office account was created, edited, removed, or its
       * connection status changed (a test/sync result). The setup modal +
       * the office header refetch on receipt. Office-refetch fan-out, no
       * replay state.
       */
      type: 'mail_account_updated';
      account_id: string;
      specialist_id: string;
      user_id: string;
      status: string;
    }
  | {
      /**
       * An order was inserted or merged into the mail_orders projection
       * (src/core/mail_ingest.ts). The Household-Knowledge signal driver
       * subscribes and fans it into the graph (enrich → household_good node
       * + typed edges → Vivian/Luna/Kate slices). The driver reads the
       * merged order back via MailOrders.get_by_key, so the event stays a
       * thin (user_id, order_key) signal. The FIRST source of the generalized
       * signal router (Phase 2). Fail-open + gated (HEARTH_HOUSEHOLD_GRAPH);
       * off → the driver no-ops.
       */
      type: 'order_upserted';
      user_id: string;
      order_key: string;
      is_new: boolean;
    }
  | {
      /**
       * A household_good node was written/updated in the Household Knowledge
       * Graph (by the signal driver from an order, or later a capture/manual
       * source). An office surface (Kate's running picture, Vivian's cost,
       * Luna's appliances) can refetch on receipt. Office-refetch fan-out, no
       * replay state. `private_to` carries the good's cordon so a client only
       * acts on goods it may see.
       */
      type: 'household_good_updated';
      good_id: string;
      note_path: string;
      private_to: string;
      user_id: string | null;
    }
  | {
      /**
       * Media Archive (2026-07-11) — a new media item was filed onto the
       * Serapeum store. The /app Archive tab refetches on receipt. Office-refetch
       * fan-out, no replay state. `private_to` carries the item's cordon so a
       * client only acts on media it may see (NSFW/uncertain are owner-only).
       */
      type: 'media_archived';
      media_item_id: string;
      note_path: string;
      nsfw: boolean;
      private_to: string;
      user_id: string | null;
    }
  | {
      /**
       * Media sharing (2026-07-29) — an item's `shared_with` set was replaced
       * (POST /api/media/item/:id/share). Both Archive surfaces refetch on
       * receipt: a recipient's grid gains the item (or loses a revoked one).
       * `shared_with` is the FULL new set — the verb is set-replacement, so
       * there is no add/remove to reconcile. `by` is the sharer (always the
       * item's owner; null only for a user-less caller, which the verb can't
       * currently produce).
       *
       * Cordoned per subscriber in router.ts: it reaches the sharer and
       * `deliver_to` only — a third user has no business learning who shared
       * what with whom.
       */
      type: 'media_shared';
      media_item_id: string;
      shared_with: string[];
      by: string | null;
      /**
       * DELIVERY AUDIENCE — the users this event must reach, which is the UNION
       * of the prior and the new share set, NOT `shared_with`. A user the write
       * REVOKED is the subscriber who most needs to refetch: nothing else tells
       * their Archive to drop the item. Gating delivery on the new set alone
       * meant the one person who had to hear about a revoke was the one person
       * who didn't.
       *
       * Deliberately NOT part of the wire payload — `sse_wire_payload` strips
       * it at router.ts's single serialization site. Two reasons: the payload
       * shape is a published client contract, and the union names revoked
       * users, which a still-current recipient has no business learning.
       * Omitted → the audience falls back to `shared_with`, so an emitter that
       * forgets it degrades to the old behaviour, never to a broadcast.
       */
      deliver_to?: string[];
    }
  | {
      /**
       * On the Fire (2026-07-29) — a long-running job the user asked for changed
       * phase. ONE event for every domain in `core/jobs.ts` (media downloads,
       * deep research, commissions), emitted from the point each runner already
       * persists a status transition, so the payload reflects COMMITTED state.
       *
       * The web dock and the iOS ledger patch a row in place from this; the
       * chat-anchored job card rewrites itself from it. `log_tail` is capped at
       * 3 lines — this is a patch, not a transcript (drill into
       * GET /api/jobs/:kind/:id for the whole log).
       *
       * CORDONED like `media_archived`: `private_to` carries the job's own scope
       * and the /api/events fan-out drops it for a subscriber who couldn't see
       * the result (NSFW downloads are owner-only). `kind`, `phase` and `state`
       * are widened freely — clients decode them leniently to a named default,
       * so a new domain or phase costs no client deploy.
       */
      type: 'job_progress';
      kind: string;
      job_id: string;
      title: string;
      subtitle: string | null;
      owner_specialist_id: string;
      phase: string;
      phase_label: string;
      // 'blocked' = stopped and waiting on a human, not on more work (a
      // stalled research investigation). Neither running nor terminal; a
      // consumer that only splits finished-vs-unfinished treats it as
      // unfinished. See JobState in core/jobs.ts.
      state: 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
      /** null = indeterminate. Never synthesized from phase ordinals. */
      progress: number | null;
      log_tail: string[];
      /** The user asked for this in a thread and is owed an answer. */
      awaited: boolean;
      conversation_id: string | null;
      result_route: string | null;
      error: string | null;
      private_to: string | null;
      user_id: string | null;
      /**
       * Optional per-kind rich detail (seats on a review, tallies, an outcome
       * word). Mirrors `Job.detail` in core/jobs.ts; absent for kinds with
       * nothing structured to show, so clients must render without it.
       */
      detail?: {
        seats?: Array<{ id: string; role: string; phase: 'queued' | 'working' | 'done' | 'failed' }>;
        tally?: Array<{ label: string; value: number }>;
        outcome?: string;
      };
    }
  | {
      /**
       * Agent Rooms (2026-07-27) — a message landed in a multi-specialist room
       * (the owner's message or an agent reply). The web Rooms view appends it
       * to the open room thread (SORTED BY ts — GET order isn't trustworthy)
       * without polling; each agent reply pushes as it lands, so the riff
       * streams in live. Rooms are owner-only + cordoned, so the /api/events
       * `send()` delivers this ONLY to the owning user. `message` mirrors the
       * GET /api/rooms/:id message shape so the client reuses one render path.
       */
      type: 'room_message_added';
      room_id: string;
      user_id: string;
      message: {
        id: string;
        ts: string;
        role: 'user' | 'specialist' | 'system';
        specialist_id: string | null;
        name: string;
        content_md: string;
      };
    }
  | {
      /**
       * A room turn started — the owner's message was accepted and the arbiter
       * is picking speakers / agents are composing. The Rooms view shows a
       * per-room "thinking" indicator and disables the composer until the
       * paired `room_turn_done`. Owner-only, same cordon as `room_message_added`.
       */
      type: 'room_turn_started';
      room_id: string;
      user_id: string;
    }
  | {
      /**
       * A SPECIFIC agent in a room started (`typing`) or finished (`done`)
       * generating its reply. The web Rooms view renders "<Name> is typing…"
       * (and would show "A and B are typing…" if several are active) in place of
       * the generic "the room is thinking…" line. Speakers run sequentially, so
       * usually one is active at a time; the client tracks a set and clears it on
       * `room_turn_done`. Owner-only, same cordon as `room_message_added`.
       */
      type: 'room_speaker';
      room_id: string;
      user_id: string;
      specialist_id: string;
      name: string;
      state: 'typing' | 'done';
    }
  | {
      /**
       * A room turn finished. Clears the "thinking" indicator + re-enables the
       * composer. `speakers` is who spoke this turn (observability). Always
       * emitted — even on a failed/empty turn — so the client never sticks
       * disabled. Owner-only.
       */
      type: 'room_turn_done';
      room_id: string;
      user_id: string;
      speakers: string[];
    }
  | {
      /**
       * Review swarm (2026-07-21) — a red/blue/judge bench of critic sub-agents
       * over ONE Beatrice code change. These four correlated events drive the
       * live iOS "bee icon" + the web Code Shop panel. Inform-only: the swarm
       * reports findings; Kate still rules and the owner still merges.
       * `user_id` cordons client-side (null ⇒ owner/all). DARK behind
       * HEARTH_REVIEW_SWARM.
       */
      type: 'swarm_review_started';
      review_id: string;
      change_id: string;
      title: string;
      bench: Array<{ seat_id: string; role: SwarmSeatRole; conversation_id: string }>;
      /** 'bench' = the first pass; 'higher_court' = the appeal a block escalates to. */
      tier?: SwarmTier;
      /** On an appeal, the review_id being appealed. */
      escalated_from?: string;
      user_id: string | null;
    }
  | {
      type: 'swarm_seat_update';
      review_id: string;
      change_id: string;
      seat_id: string;
      role: SwarmSeatRole;
      phase: 'queued' | 'working' | 'done' | 'failed';
      summary?: string;
      tier?: SwarmTier;
      user_id: string | null;
    }
  | {
      type: 'swarm_finding_added';
      review_id: string;
      change_id: string;
      seat_id: string;
      severity: 'blocker' | 'concern' | 'nit';
      summary: string;
      refuted: boolean;
      tier?: SwarmTier;
      user_id: string | null;
    }
  | {
      type: 'swarm_verdict';
      review_id: string;
      change_id: string;
      verdict: 'pass' | 'pass_with_concerns' | 'block';
      tier?: SwarmTier;
      /** Higher court only — did the appeal uphold or overturn the block? */
      ruling?: 'upheld' | 'overturned';
      user_id: string | null;
    };

/** Bench seats attack/defend/judge; higher-court seats sit by lens. */
export type SwarmSeatRole =
  | 'red'
  | 'blue'
  | 'judge'
  | 'evidence'
  | 'mechanism'
  | 'impact';
export type SwarmTier = 'bench' | 'higher_court';

export type AppEventListener = (event: AppEvent) => void;

/**
 * The SUBSCRIBER-FACING projection of an event: the published payload with any
 * delivery-only field stripped. Applied once, at router.ts's single SSE
 * serialization site, so a field that exists to route an event can never be
 * mistaken for a field clients may read.
 *
 * Today that is exactly `media_shared.deliver_to` (the prior∪new share set —
 * see the variant's docs). Anything else passes through untouched.
 */
export function sse_wire_payload(event: AppEvent): unknown {
  if (event.type === 'media_shared') {
    const { deliver_to: _deliver_to, ...wire } = event;
    return wire;
  }
  return event;
}

/**
 * The per-subscriber cordon for `media_shared`: the sharer, plus every user the
 * write touched (`deliver_to` = prior ∪ new — NOT `shared_with`, which would
 * skip exactly the revoked user who has to refetch). Fail-closed for an
 * unidentified subscriber. Lives here, next to the event, so the routing rule
 * and the field's semantics can't drift apart — router.ts applies it.
 */
export function media_shared_reaches(
  event: Extract<AppEvent, { type: 'media_shared' }>,
  user_id: string | undefined,
): boolean {
  if (user_id == null || user_id === '') return false;
  if (user_id === event.by) return true;
  return (event.deliver_to ?? event.shared_with).includes(user_id);
}

/**
 * In-memory snapshot of a streaming turn currently in flight. Maintained
 * by the AppEventBus from `specialist_thinking` / `message_token` events
 * so that new SSE subscribers (e.g. a refreshed browser) can be replayed
 * the current state without losing the spinner / partial text mid-flight.
 */
export interface ActiveStream {
  conversation_id: string;
  specialist_id: string;
  stream_id: string;
  partial_text: string;
  /** Partial thinking trace for the current stream_id. Empty when the
   *  specialist's `think` setting is false. Replayed on SSE reconnect
   *  so a refresh during a long think doesn't lose the pill. */
  partial_thinking: string;
  started_at_ms: number;
  last_token_at_ms: number;
}

/**
 * In-flight tool call. Tracked so refreshed browsers can rebuild
 * the tool-chain panel mid-turn instead of seeing a typing bubble
 * with no detail (a real failure mode: Iris consulting Beatrice
 * for 5+ min — without this, refreshing during the wait shows the
 * spinner but nothing about who she's talking to).
 */
export interface ActiveToolCall {
  conversation_id: string;
  specialist_id: string;
  tool_call_id: string;
  tool_name: string;
  input_summary: string;
  started_at_ms: number;
}

export class AppEventBus {
  private listeners = new Set<AppEventListener>();
  // Active streams keyed by conversation_id. A specialist can only
  // have one in-flight turn per conversation at a time, so this is
  // safe. The runtime emits `specialist_thinking: started/finished`
  // around every turn and `message_token` events in between; we use
  // those to maintain the snapshot.
  private active_streams = new Map<string, ActiveStream>();
  // In-flight tool calls keyed by conversation_id. Each list holds
  // every tool currently between `tool_invoked` and `tool_completed`
  // for that conv. Replayed on SSE subscribe so a refreshed browser
  // mid-consult rebuilds the tool-chain panel.
  private active_tool_calls = new Map<string, ActiveToolCall[]>();

  subscribe(l: AppEventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(event: AppEvent): void {
    // Update the in-memory streaming snapshot BEFORE fanning out, so
    // listeners subscribing in the same microtask see a consistent
    // view via current_active_streams().
    this._track(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[event bus] listener failed:', err);
      }
    }
  }

  /**
   * Snapshot of currently-active streams. SSE handlers replay these
   * as a `hello` event (or as synthetic `specialist_thinking: started`
   * + `message_token` pairs) when a new subscriber connects so the
   * UI can restore typing / streaming bubbles after a refresh.
   */
  current_active_streams(): ActiveStream[] {
    return Array.from(this.active_streams.values());
  }

  /**
   * Snapshot of currently-in-flight tool calls across all conversations.
   * SSE handlers replay these as synthetic `tool_invoked` events when
   * a subscriber connects, so a refreshed browser sees Iris's
   * "consulting Beatrice" row even if the consult started before the
   * page loaded.
   */
  current_active_tool_calls(): ActiveToolCall[] {
    const out: ActiveToolCall[] = [];
    for (const arr of this.active_tool_calls.values()) {
      for (const t of arr) out.push(t);
    }
    return out;
  }

  size(): number {
    return this.listeners.size;
  }

  private _track(event: AppEvent): void {
    if (event.type === 'specialist_thinking') {
      if (event.state === 'started') {
        const now = Date.now();
        this.active_streams.set(event.conversation_id, {
          conversation_id: event.conversation_id,
          specialist_id: event.specialist_id,
          // No stream_id yet — first message_token will populate it.
          stream_id: '',
          partial_text: '',
          partial_thinking: '',
          started_at_ms: now,
          last_token_at_ms: now,
        });
      } else {
        this.active_streams.delete(event.conversation_id);
        // Turn ended — any in-flight tool calls for this conv are
        // stale. Normally tool_completed fires before specialist_thinking
        // finished, but if the turn aborted mid-tool the cleanup
        // happens here.
        this.active_tool_calls.delete(event.conversation_id);
      }
    } else if (event.type === 'message_token') {
      const cur = this.active_streams.get(event.conversation_id);
      if (cur) {
        if (cur.stream_id !== event.stream_id) {
          cur.stream_id = event.stream_id;
          cur.partial_text = '';
          cur.partial_thinking = '';
        }
        cur.partial_text += event.delta;
        cur.last_token_at_ms = Date.now();
      }
    } else if (event.type === 'message_thinking_token') {
      const cur = this.active_streams.get(event.conversation_id);
      if (cur) {
        if (cur.stream_id !== event.stream_id) {
          cur.stream_id = event.stream_id;
          cur.partial_text = '';
          cur.partial_thinking = '';
        }
        cur.partial_thinking += event.delta;
        cur.last_token_at_ms = Date.now();
      }
    } else if (event.type === 'message_superseded') {
      // A finalize guard rejected the live draft. Clear the buffered partial
      // so a reconnecting client replays nothing for the dropped stream — the
      // corrected reply arrives via the next message_added.
      const cur = this.active_streams.get(event.conversation_id);
      if (cur) {
        cur.partial_text = '';
        cur.partial_thinking = '';
      }
    } else if (event.type === 'message_added' && event.role === 'specialist') {
      // Safety net: if a finished event was lost (handler crash, fan-out
      // bug), the canonical message landing clears any leftover stream.
      this.active_streams.delete(event.conversation_id);
      // Also drop any leftover tool calls — the turn is canonically over.
      this.active_tool_calls.delete(event.conversation_id);
    } else if (event.type === 'tool_invoked') {
      const list = this.active_tool_calls.get(event.conversation_id) ?? [];
      list.push({
        conversation_id: event.conversation_id,
        specialist_id: event.specialist_id,
        tool_call_id: event.tool_call_id,
        tool_name: event.tool_name,
        input_summary: event.input_summary,
        started_at_ms: Date.now(),
      });
      this.active_tool_calls.set(event.conversation_id, list);
    } else if (event.type === 'tool_completed') {
      const list = this.active_tool_calls.get(event.conversation_id);
      if (list) {
        const idx = list.findIndex((t) => t.tool_call_id === event.tool_call_id);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.active_tool_calls.delete(event.conversation_id);
      }
    }
  }
}
