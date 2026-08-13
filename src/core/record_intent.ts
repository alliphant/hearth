/**
 * actionable_intent — a deterministic, HIGH-PRECISION detector for clear "act on
 * this" instructions handed to Kate, so the runtime can FORCE the matching tool
 * instead of trusting a small model to call it (the "fabricated save / dropped
 * promise" class: the user says "remember X" / "this appt is Sam's" / "remind me
 * to X" and the 9B replies "Noted" with no tool call). Pure + no LLM, so it's
 * smoke-testable and adds zero latency.
 *
 * Five intent classes, each mapped to a tool already on Kate's surface:
 *   - set_event_owner       — calendar ownership ("the Grant Taylor appt is
 *                             Sam's", "anything titled X belongs to Sam").
 *   - record_person_pref    — preferences + gifts ("remember Sam loves hiking",
 *                             "Kim is allergic to peanuts", "I got Dad a $60
 *                             speaker for his birthday").
 *   - schedule_calendar_event — scheduling ("put the dentist on my calendar
 *                             Thursday", "schedule a call with Sam for 2pm",
 *                             "block off Friday afternoon"). REQUIRES a temporal
 *                             anchor (a day/date/time) so the forced call has a
 *                             start to land on — the proposal the model produces
 *                             is still owner-confirmed on the phone.
 *   - promise_followup      — reminders / followups ("remind me to X", "don't let
 *                             me forget X", "follow up with Y about Z").
 *   - test_emergency_alert  — emergency-alert self-test ("do the emergency test",
 *                             "run an emergency drill", "fire the EBS test"). The
 *                             dangerous failure is FABRICATION — the model saying
 *                             "Test fired" with NO tool call, so nothing actually
 *                             sounds (the live voice bug, 2026-06-26). Forcing the
 *                             call is the safe behavior, so this class is the
 *                             anti-fabrication GUARD family (default-ON), not the
 *                             opt-in record/schedule family.
 *
 * Precision over recall BY DESIGN: forcing a tool when none was warranted writes
 * a spurious record / files a spurious proposal / sounds a spurious test, so a
 * miss (fall back to the model + the retry guard) is far cheaper than a false
 * positive. Questions never match; a clear cue or an unambiguous verb is required.
 *
 * Three kill switches gate the GROUPS of classes so each ships independently:
 *   - HEARTH_RECORD_INTENT_FORCE   → the record/attribute pair (LIVE in prod).
 *   - HEARTH_INTENT_FORCE          → the schedule + remind pair (Piece 7, DARK).
 *   - HEARTH_EMERGENCY_INTENT_FORCE → the emergency self-test (GUARD family;
 *                             default-ON, `=0` disables — like HEARTH_FACT_CRITIC
 *                             / HEARTH_DATA_DENIAL_GUARD, since fabricating a
 *                             fired safety alert is the dangerous failure).
 * `detect_actionable_intent` (the runtime's single entry point) is PURE and
 * detects all five; the runtime decides whether to honor each via
 * `intent_force_enabled_for(tool)`, so an unarmed group is byte-identical (the
 * detection result is discarded by the gate, no force, no audit).
 */

/** Gate for the record/attribute pair (set_event_owner / record_person_pref). */
export function record_intent_force_enabled(): boolean {
  return process.env.HEARTH_RECORD_INTENT_FORCE === '1';
}

/** Gate for the schedule + remind pair (schedule_calendar_event / promise_followup). */
export function intent_force_enabled(): boolean {
  return process.env.HEARTH_INTENT_FORCE === '1';
}

/**
 * Gate for the emergency self-test (test_emergency_alert). This is the
 * anti-fabrication GUARD family, NOT the opt-in record/schedule family: a
 * fabricated "Test fired" with no tool call is the dangerous failure, so forcing
 * the call is the SAFE default. ON unless explicitly disabled — same convention
 * as HEARTH_FACT_CRITIC / HEARTH_DATA_DENIAL_GUARD (`=0` is the kill switch).
 */
export function emergency_intent_force_enabled(): boolean {
  return process.env.HEARTH_EMERGENCY_INTENT_FORCE !== '0';
}

export type ActionableTool =
  | 'set_event_owner'
  | 'record_person_pref'
  | 'schedule_calendar_event'
  | 'promise_followup'
  | 'test_emergency_alert';

export interface RecordIntent {
  /** The tool the runtime should force. */
  tool: ActionableTool;
  /** Human-readable reason (audit / observability). */
  reason: string;
}
/** Alias — the superset name, same shape. */
export type ActionableIntent = RecordIntent;

/** The GROUPS, so the runtime can resolve the right kill switch per tool. */
const RECORD_TOOLS = new Set<ActionableTool>(['set_event_owner', 'record_person_pref']);
const EMERGENCY_TOOLS = new Set<ActionableTool>(['test_emergency_alert']);

/**
 * Which kill switch gates forcing for a given tool. The record/attribute pair
 * honors HEARTH_RECORD_INTENT_FORCE (live); the schedule + remind pair honors
 * HEARTH_INTENT_FORCE (dark); the emergency self-test honors
 * HEARTH_EMERGENCY_INTENT_FORCE (guard family, default-ON). Centralizing the
 * mapping here keeps the detector pure and the runtime's gating a one-liner.
 */
export function intent_force_enabled_for(tool: ActionableTool): boolean {
  if (EMERGENCY_TOOLS.has(tool)) return emergency_intent_force_enabled();
  return RECORD_TOOLS.has(tool) ? record_intent_force_enabled() : intent_force_enabled();
}

/** Questions and hypotheticals are never record/act instructions. */
function is_question(t: string): boolean {
  const s = t.trim();
  if (/\?\s*$/.test(s)) return true;
  return /^(do|does|did|is|are|was|were|can|could|would|will|should|have|has|what|who|whom|whose|when|where|why|how|which)\b/i.test(s);
}

// ── Calendar ownership → set_event_owner ────────────────────────────────────
// "belongs to <name>" / "is/are <name>'s" / "is mine|hers|his|theirs" — the
// unambiguous attribution verbs. (A possessive like "Sam's" is the strong cue.)
const OWNERSHIP = /\b(belongs?\s+to\s+\w|is\s+\w[\w'’-]*['’]s\b|are\s+\w[\w'’-]*['’]s\b|is\s+(mine|hers|his|theirs|yours|sam'?s|jasper'?s)\b)/i;
const CALENDAR_CUE = /\b(calendar|appointment|appt|event|meeting|invite|titled|named|mentioning|on the cal)\b/i;

// ── Preferences + gifts → record_person_pref ────────────────────────────────
const RECORD_CUE = /\b(remember|make a note|note that|keep in mind|for the record|fyi)\b/i;
const PREF_VERB = /\b(likes?|loves?|hates?|prefers?|enjoys?|is into|are into|can'?t stand|is allergic to|wears?(?: a)? size|takes? a size|favou?rite)\b/i;
const GIFT_CUE = /\b(gave|got|bought|gifted|picked up)\b[\s\S]{0,40}\b(for (his|her|their|my)|as a (gift|present)|for [a-z]+'?s? (birthday|christmas|anniversary|graduation|holiday))/i;

/**
 * Detect a clear record/attribute instruction. Returns the tool to force, or
 * null when the message is a question or lacks an unambiguous record cue.
 */
export function detect_record_intent(text: string): RecordIntent | null {
  const t = (text ?? '').trim();
  if (t.length < 4 || is_question(t)) return null;

  // 1. Calendar ownership is the most specific — check first. An ownership verb
  //    plus a calendar cue is unambiguous; a bare "belongs to <name>" is also a
  //    strong attribution signal in a chief-of-staff chat.
  const has_ownership = OWNERSHIP.test(t);
  if (has_ownership && (CALENDAR_CUE.test(t) || /\bbelongs?\s+to\b/i.test(t))) {
    return { tool: 'set_event_owner', reason: 'calendar ownership statement' };
  }

  // 2. Preferences + gifts.
  if (GIFT_CUE.test(t)) {
    return { tool: 'record_person_pref', reason: 'gift statement' };
  }
  if (RECORD_CUE.test(t) && PREF_VERB.test(t)) {
    return { tool: 'record_person_pref', reason: 'remember + preference' };
  }
  // A bare preference statement still counts when it names a 3rd-person subject
  // ("Sam loves hiking") — but NOT a 1st-person reaction ("I like this").
  if (PREF_VERB.test(t) && /\b([A-Z][a-z]+|he|she|they|her|his|their|mom|dad|grandma|grandpa)\b/.test(t) && !/^\s*i\s/i.test(t)) {
    return { tool: 'record_person_pref', reason: 'third-person preference' };
  }
  // "remember I like X" — an explicit record cue about the speaker is fine.
  if (RECORD_CUE.test(t) && PREF_VERB.test(t)) {
    return { tool: 'record_person_pref', reason: 'remember preference' };
  }

  return null;
}

// ── Scheduling → schedule_calendar_event ────────────────────────────────────
// Strong calendar-write cues. "schedule" must be a VERB (not the noun in "my
// schedule is full") — the negative lookbehind rejects an article/possessive
// before it. "put/add … on/to (my|the) calendar" is the explicit anchor form.
const SCHEDULE_VERB =
  /(?<!\b(?:the|my|a|an|this|that|your|his|her|our|their|whole|busy|packed|full)\s)\bschedule\s+(?:a|an|the|my|our|some|another|\d|[a-z])/i;
const PUT_ON_CALENDAR =
  /\b(?:put|add|pop|pencil|stick|throw|get|book)\b[\s\S]{0,60}\b(?:on|onto|in|into|to)\s+(?:my|the|our)\s+(?:calendar|cal)\b/i;
const BLOCK_OFF = /\bblock\s+(?:off|out)\b/i;
const SET_UP_MEETING =
  /\bset\s+up\s+(?:a\s+|an\s+|the\s+)?(?:meeting|call|appointment|appt|lunch|dinner|sync|catch[\s-]?up|1:1|one[\s-]on[\s-]one)\b/i;
// A temporal anchor: a day, date, month, time, or relative window. REQUIRED for
// the scheduling class so the forced call has a start to land on (and so we don't
// force on "schedule a call sometime" → an arg-spiral with no date). The
// proposal the model produces is still owner-confirmed on the phone.
const TEMPORAL_HINT =
  /\b(?:today|tonight|tomorrow|tmrw|this (?:week|weekend|morning|afternoon|evening|coming \w+)|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)|mon|tue|tues|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday|monday|tuesday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|noon|midnight|morning|afternoon|evening|weekend|\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2}|\bat\s+\d|\d{1,2}\/\d{1,2}|\d{1,2}(?:st|nd|rd|th)\b|in\s+\d+\s+(?:days?|weeks?|hours?|months?))\b/i;

// ── Reminders / followups → promise_followup ────────────────────────────────
// "remind me to/about/that …" — but NOT "remind me what/when/who …" (that's a
// recall request, not a reminder to set).
const REMIND_SET = /\bremind me\b(?!\s+(?:what|when|where|who|whose|which|how|why)\b)/i;
const DONT_FORGET = /\bdon'?t let me forget\b/i;
const FOLLOW_UP = /\b(?:follow[\s-]?up)\s+(?:on|with)\b/i;
// The user stating their OWN intent ("I'll follow up with Sam") is not a
// directive to Kate — only the explicit reminder forms still count then.
const FIRST_PERSON_INTENT = /^\s*(?:i['’\s]|i'?ll\b|i'?m\b|i\s+will\b|i\s+am\b|we'?ll\b|we\s+will\b)/i;

/**
 * Detect a clear scheduling or reminder instruction. Same `{tool, reason}` shape
 * as detect_record_intent; null when the message is a question or lacks an
 * unambiguous cue. Gated by HEARTH_INTENT_FORCE at the call site (see
 * intent_force_enabled_for) — this function is pure.
 */
export function detect_schedule_remind_intent(text: string): RecordIntent | null {
  const t = (text ?? '').trim();
  if (t.length < 4 || is_question(t)) return null;

  // Scheduling — a calendar-write cue AND a temporal anchor.
  const schedule_cue =
    SCHEDULE_VERB.test(t) || PUT_ON_CALENDAR.test(t) || BLOCK_OFF.test(t) || SET_UP_MEETING.test(t);
  if (schedule_cue && TEMPORAL_HINT.test(t)) {
    return { tool: 'schedule_calendar_event', reason: 'scheduling instruction with a time anchor' };
  }

  // Reminders / followups.
  if (REMIND_SET.test(t) || DONT_FORGET.test(t)) {
    return { tool: 'promise_followup', reason: 'reminder instruction' };
  }
  if (FOLLOW_UP.test(t) && !FIRST_PERSON_INTENT.test(t)) {
    return { tool: 'promise_followup', reason: 'follow-up directive' };
  }

  return null;
}

// ── Emergency-alert self-test → test_emergency_alert ─────────────────────────
// An imperative "test / run / fire / sound the emergency alert / broadcast / EBS
// / drill" command. Anchored on the emergency-domain SUBJECT (so a bare "test
// it" / "run that" can't match) AND an action verb — both required. Questions
// are rejected upstream by is_question. Unlike the record/schedule classes, the
// dangerous failure here is FABRICATION (the model narrating a fired alert with
// no tool call), so the detector exists to FORCE the call, not to persist a fact.
const EMERGENCY_SUBJECT =
  /\b(?:emergency\s+(?:alert|broadcast|alarm|test|drill|tone|siren|system|response\s+test)|emergency\s+broadcast\s+system|ebs)\b/i;
const EMERGENCY_ACTION =
  /\b(?:test|tests|testing|run|fire|trigger|sound|drill|set\s+off|kick\s+off|do|perform|play|try|demo|initiate)\b/i;

// The shared is_question() rejects a leading "do" (for "do you like X?"), but an
// emergency command is overwhelmingly imperative on a leading "do the test" /
// "do a test of …" — a genuine question carries a trailing "?" (caught here) or a
// non-imperative wh/aux lead. So the emergency class uses a stricter check that
// EXCLUDES leading do/does/did, keeping every real-question form rejected.
function _emergency_is_question(t: string): boolean {
  const s = t.trim();
  if (/\?\s*$/.test(s)) return true;
  return /^(is|are|was|were|can|could|would|will|should|have|has|what|who|whom|whose|when|where|why|how|which)\b/i.test(s);
}

/**
 * Detect a clear emergency-alert self-test command. Same `{tool, reason}` shape;
 * null on a question or a message lacking the emergency-domain subject + action.
 */
export function detect_emergency_test_intent(text: string): RecordIntent | null {
  const t = (text ?? '').trim();
  if (t.length < 4 || _emergency_is_question(t)) return null;
  if (EMERGENCY_SUBJECT.test(t) && EMERGENCY_ACTION.test(t)) {
    return { tool: 'test_emergency_alert', reason: 'emergency-alert self-test command' };
  }
  return null;
}

/**
 * The runtime's single entry point: the union of all five classes. The
 * emergency self-test is the most specific imperative (its own subject anchor),
 * then record / attribute, then schedule / remind. PURE — the per-group kill
 * switch is applied by the caller via intent_force_enabled_for(tool).
 */
export function detect_actionable_intent(text: string): RecordIntent | null {
  return (
    detect_emergency_test_intent(text) ??
    detect_record_intent(text) ??
    detect_schedule_remind_intent(text)
  );
}
