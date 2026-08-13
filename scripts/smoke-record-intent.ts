/**
 * smoke:record-intent — the deterministic actionable-intent detector that drives
 * forced tool calls (the fix for the 9B "fabricated save / dropped promise"
 * class). Pure, no LLM.
 *
 * Precision is the whole game: a false positive FORCES a spurious write / files a
 * spurious proposal, so the matrix weights negatives (questions, reactions,
 * non-actionable statements) as hard as positives.
 *
 *   bun run smoke:record-intent
 */
import {
  detect_record_intent,
  detect_schedule_remind_intent,
  detect_emergency_test_intent,
  detect_actionable_intent,
  intent_force_enabled,
  intent_force_enabled_for,
  record_intent_force_enabled,
  emergency_intent_force_enabled,
} from '@core/record_intent';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function main(): void {
  // ── POSITIVES → set_event_owner (calendar ownership) ──────────────────────
  const cal: Array<[string, string]> = [
    ['the Grant Taylor 6/30 calendar appt belongs to Sam', 'belongs to + calendar'],
    ["anything titled 'Ann Kent' belongs to Sam", 'titled + belongs to'],
    ['massages w/ Dana belong to me', 'belong to me'],
    ["the 2pm appointment is Sam's", "appointment + is X's"],
    ['that event is mine, not hers', 'event + is mine'],
  ];
  for (const [msg, why] of cal) {
    const r = detect_record_intent(msg);
    check(`set_event_owner: "${msg}" (${why})`, r?.tool === 'set_event_owner');
    // detect_actionable_intent is a superset — record/attribute wins.
    check(`actionable→set_event_owner: "${msg}"`, detect_actionable_intent(msg)?.tool === 'set_event_owner');
  }

  // ── POSITIVES → record_person_pref (prefs + gifts) ────────────────────────
  const pref: Array<[string, string]> = [
    ['remember Sam loves hiking and dark chocolate', 'remember + loves'],
    ['Kim is allergic to peanuts', '3rd-person allergy'],
    ['note that my dad hates surprises', 'note that + hates'],
    ['I got Dad a $60 speaker for his birthday', 'gift for his birthday'],
    ['she wears a size 8 shoe', '3rd-person size'],
  ];
  for (const [msg, why] of pref) {
    const r = detect_record_intent(msg);
    check(`record_person_pref: "${msg}" (${why})`, r?.tool === 'record_person_pref');
  }

  // ── NEGATIVES → null (no force) ───────────────────────────────────────────
  const neg: string[] = [
    'whose appointment is on the 30th?',
    'does Sam like hiking?',
    'what should I get Kim for his birthday?',
    'can you check the calendar?',
    'I like this idea',
    'the weather is nice today',
    "thanks, that's perfect",
    'is the 2pm meeting mine or hers?',
    'who does the Grant Taylor appointment belong to?',
  ];
  for (const msg of neg) {
    const r = detect_record_intent(msg);
    check(`null (no force): "${msg}"`, r === null);
  }

  // ── POSITIVES → schedule_calendar_event (Piece 7) ─────────────────────────
  // Each carries a calendar-write cue AND a temporal anchor.
  const sched: Array<[string, string]> = [
    ['schedule a dentist appointment for Thursday at 2pm', 'schedule + verb + time'],
    ['put the dentist on my calendar for Thursday', 'put on calendar + day'],
    ['add lunch with Sam to the calendar tomorrow', 'add to calendar + tomorrow'],
    ['block off Friday afternoon for the move', 'block off + Friday afternoon'],
    ['set up a meeting with the contractor next Tuesday', 'set up a meeting + next Tue'],
    ['schedule a call with the bank at 10am', 'schedule a call + at 10am'],
    ['put a reminder for the oil change on my calendar 6/30', 'put on calendar + date'],
  ];
  for (const [msg, why] of sched) {
    const r = detect_schedule_remind_intent(msg);
    check(`schedule_calendar_event: "${msg}" (${why})`, r?.tool === 'schedule_calendar_event');
    check(`actionable→schedule: "${msg}"`, detect_actionable_intent(msg)?.tool === 'schedule_calendar_event');
  }

  // ── POSITIVES → promise_followup (Piece 7) ────────────────────────────────
  const remind: Array<[string, string]> = [
    ['remind me to call the dentist tomorrow', 'remind me to'],
    ['remind me about the insurance renewal', 'remind me about'],
    ["don't let me forget to water the plants", "don't let me forget"],
    ['follow up with the contractor about the quote', 'follow up with'],
    ['follow up on the warranty claim', 'follow up on'],
    ['remind me that I owe Sam $40', 'remind me that'],
  ];
  for (const [msg, why] of remind) {
    const r = detect_schedule_remind_intent(msg);
    check(`promise_followup: "${msg}" (${why})`, r?.tool === 'promise_followup');
    check(`actionable→promise: "${msg}"`, detect_actionable_intent(msg)?.tool === 'promise_followup');
  }

  // ── NEGATIVES for the new classes → null (precision) ──────────────────────
  const newNeg: string[] = [
    "what's on my calendar Thursday?", // question
    'can you schedule a call for me?', // polite question → model handles
    'did you remind me about the dentist?', // recall question
    'remind me what time the meeting is', // recall, not a reminder-set
    'remind me when Kim arrives', // recall (when)
    'my schedule is packed this week', // "schedule" the noun
    "I'll follow up with Sam tomorrow", // user's own intent, not a directive
    'schedule a call with the bank', // scheduling cue but NO time anchor → no force
    'put the dentist on my calendar', // calendar cue but NO time anchor → no force
    'set up the new printer this weekend', // "set up" but not a meeting/call
    'we should plan something fun', // no cue
    'the meeting went well today', // past-tense reaction
  ];
  for (const msg of newNeg) {
    const r = detect_schedule_remind_intent(msg);
    check(`null (no force): "${msg}"`, r === null);
    check(`actionable null: "${msg}"`, detect_actionable_intent(msg) === null);
  }

  // ── POSITIVES → test_emergency_alert (2026-06-26, voice anti-fabrication) ──
  // An imperative emergency-test/drill command. The live bug: Kate said "Test
  // fired" on voice with ZERO tool calls, so nothing sounded. Forcing the call
  // is the fix — these must detect so the runtime forces test_emergency_alert.
  const emerg: Array<[string, string]> = [
    ['Please do the emergency test', 'do + emergency test (the live voice bug)'],
    ['do the emergency test', 'bare leading "do" is imperative, not a question'],
    ['test the emergency alert', 'test + emergency alert'],
    ['run an emergency drill', 'run + emergency drill'],
    ['fire the EBS test', 'fire + ebs'],
    ['test your emergency broadcast system', 'test + emergency broadcast system'],
    ['sound the emergency alarm tone', 'sound + emergency alarm'],
    ['run the emergency alert test now', 'run + emergency alert'],
    ['do a test of the emergency broadcast', 'do + emergency broadcast'],
  ];
  for (const [msg, why] of emerg) {
    const r = detect_emergency_test_intent(msg);
    check(`test_emergency_alert: "${msg}" (${why})`, r?.tool === 'test_emergency_alert');
    // emergency is the most specific imperative — actionable resolves to it.
    check(`actionable→emergency: "${msg}"`, detect_actionable_intent(msg)?.tool === 'test_emergency_alert');
  }

  // ── NEGATIVES for the emergency class → null (precision) ──────────────────
  const emergNeg: string[] = [
    'what does the emergency test do?', // question
    'can you test the emergency alert?', // polite question → model handles
    'is the emergency broadcast working?', // status question
    'run the dishwasher', // action verb, no emergency subject
    'test the new printer', // "test" but no emergency subject
    'the emergency exit is to the left', // emergency, no action verb
    'how do I fire up the grill?', // "fire" but not an emergency subject + question
    'remember Sam loves the emergency podcast', // emergency word, but a record-pref cue
  ];
  for (const msg of emergNeg) {
    check(`emergency null (no force): "${msg}"`, detect_emergency_test_intent(msg) === null);
  }
  // The record-pref negative above must NOT resolve to emergency via the union.
  check(
    'union: "remember Sam loves the emergency podcast" → record_person_pref not emergency',
    detect_actionable_intent('remember Sam loves the emergency podcast')?.tool === 'record_person_pref',
  );

  // ── kill switches + per-group gate resolution ─────────────────────────────
  delete process.env.HEARTH_RECORD_INTENT_FORCE;
  check('record force disabled by default (dark)', record_intent_force_enabled() === false);
  process.env.HEARTH_RECORD_INTENT_FORCE = '1';
  check('record force enables on flag', record_intent_force_enabled() === true);
  // record/attribute group resolves to HEARTH_RECORD_INTENT_FORCE
  check('gate(set_event_owner) ← record flag (on)', intent_force_enabled_for('set_event_owner') === true);
  check('gate(record_person_pref) ← record flag (on)', intent_force_enabled_for('record_person_pref') === true);
  delete process.env.HEARTH_RECORD_INTENT_FORCE;
  check('gate(set_event_owner) ← record flag (off)', intent_force_enabled_for('set_event_owner') === false);

  delete process.env.HEARTH_INTENT_FORCE;
  check('intent force disabled by default (dark)', intent_force_enabled() === false);
  // schedule + remind group resolves to HEARTH_INTENT_FORCE, INDEPENDENT of the record flag
  check('gate(schedule_calendar_event) off when intent flag unset', intent_force_enabled_for('schedule_calendar_event') === false);
  check('gate(promise_followup) off when intent flag unset', intent_force_enabled_for('promise_followup') === false);
  process.env.HEARTH_INTENT_FORCE = '1';
  check('intent force enables on flag', intent_force_enabled() === true);
  check('gate(schedule_calendar_event) ← intent flag (on)', intent_force_enabled_for('schedule_calendar_event') === true);
  check('gate(promise_followup) ← intent flag (on)', intent_force_enabled_for('promise_followup') === true);
  // the record group is NOT armed by the intent flag (groups are independent)
  check('record group still dark under intent flag only', intent_force_enabled_for('set_event_owner') === false);
  delete process.env.HEARTH_INTENT_FORCE;

  // ── emergency group: GUARD family — default-ON, `=0` is the kill switch ────
  delete process.env.HEARTH_EMERGENCY_INTENT_FORCE;
  check('emergency force ON by default (guard family)', emergency_intent_force_enabled() === true);
  check('gate(test_emergency_alert) ON by default', intent_force_enabled_for('test_emergency_alert') === true);
  process.env.HEARTH_EMERGENCY_INTENT_FORCE = '0';
  check('emergency force disabled by kill switch (=0)', emergency_intent_force_enabled() === false);
  check('gate(test_emergency_alert) off under kill switch', intent_force_enabled_for('test_emergency_alert') === false);
  process.env.HEARTH_EMERGENCY_INTENT_FORCE = '1';
  check('emergency force back ON (=1)', intent_force_enabled_for('test_emergency_alert') === true);
  // emergency group is independent of the record/schedule flags
  check('record group still dark under emergency flag only', intent_force_enabled_for('set_event_owner') === false);
  delete process.env.HEARTH_EMERGENCY_INTENT_FORCE;

  console.log(`\n✅ smoke:record-intent — ${passed} checks passed`);
}

main();
