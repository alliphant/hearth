/**
 * fabricated_save (semantic) — the LLM-judge backstop for a claimed-but-unwritten
 * save, complementing the regex `_detect_fabricated_save` in specialist_runtime.
 *
 * The interactive model (even the 35B) occasionally SAYS it recorded a fact —
 * "Noted — Ceci's birthday is April 16", "her phone number is recorded" — while
 * emitting NO write tool call. The strict `SAVE_CLAIM_PATTERNS` regex requires a
 * clean "…to/in <target>" tail, so it MISSES those passive / "Noted —" shapes,
 * and the user looks for a record that isn't there.
 *
 * This is the fact_critic / data_denial pattern, NOT more regex: Layer 1 a cheap
 * high-recall gate (a record/save verb is present), Layer 2 a planner-role judge
 * that decides whether the reply actually CLAIMS a completed durable save. On a
 * fabricated save the runtime re-rolls with the SAME nudge the regex guard uses —
 * a plain re-prompt (no forced tool_choice), so the model catches its OWN claim
 * and, being capable, almost always calls the tool the second time. It is NEITHER
 * a forced tool_choice NOR a phrasing→tool map. Fail-open on every path; the
 * conversation-only / budget / kill-switch gates are applied at the call site.
 */
import { judgment_role, type LLMRouter } from '@core/llm';

// ── Layer 1 — high-recall gate ───────────────────────────────────────────────
// A completion/record verb the model uses when it THINKS it saved something.
// Broad on purpose (the judge supplies precision); deliberately WITHOUT the
// "to/in <target>" tail the strict regex required — that tail is exactly what
// these misses lack ("…is recorded", "Noted — …"). A record verb (or an explicit
// "in her record" phrase) must be present, so it's not every acknowledgment.
const SAVE_VERB =
  /\b(record(?:ed|ing)?|sav(?:ed|ing)|note[ds]?|noting|logg(?:ed|ing)|fil(?:ed|ing)|stor(?:ed|ing)|captur(?:ed|ing)|jott(?:ed|ing)|updat(?:ed|ing)|add(?:ed|ing))\b/i;
const IN_RECORD =
  /\b(?:in|on|to)\s+(?:her|his|their|your|the)\s+(?:\w+['’]s\s+)?(?:record|note|notes|contact|contacts|file|profile|vault)\b/i;

export function looks_like_save_claim(reply: string): boolean {
  const t = (reply || '').trim();
  if (!t) return false;
  return SAVE_VERB.test(t) || IN_RECORD.test(t);
}

function strip_fence(s: string): string {
  const m = (s || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m ? m[1]! : s || '').trim();
}

const JUDGE_SYSTEM =
  `You audit an assistant's reply for a FABRICATED SAVE: the reply tells the user a ` +
  `durable fact/record was SAVED / RECORDED / UPDATED / NOTED-into-their-record THIS ` +
  `TURN, but NO write tool ran — so nothing was persisted and the user will later look ` +
  `for a record that isn't there.\n\n` +
  `Decide ONLY from the reply + the (no-write) tool ledger:\n` +
  `- fabricated=true: the reply states a fact about a person/thing is now KEPT — ` +
  `"Noted — Ceci's birthday is April 16", "her phone number is recorded", "added to ` +
  `her contact", "that's in her record now", "I've got that saved".\n` +
  `- fabricated=false: a plain acknowledgment with NO save claim ("Got it, what's ` +
  `next?"); "I noted your concern" about a feeling/opinion (not a durable record); a ` +
  `QUESTION; or the assistant saying it WILL save later (a promise, not done).\n\n` +
  `Output ONLY JSON: {"fabricated": true|false, "item": "<short: what was claimed saved, else empty>"}.`;

export interface FabricatedSaveVerdict {
  /** Whether the judge ran (false when gated out / failed open before the call). */
  checked: boolean;
  fabricated: boolean;
  /** Short description of the claimed-saved item (for the nudge + audit). */
  item: string;
}

/**
 * Layer 2 — the planner-role judge. Returns fabricated:true only when the reply
 * genuinely claims a completed durable save with no write behind it. Fail-open
 * (no llm / role error / model error / unparseable → fabricated:false).
 */
export async function assess_fabricated_save(args: {
  reply: string;
  /** A compact one-line tool ledger for the turn (no-write expected). */
  ledger: string;
  llm?: LLMRouter;
}): Promise<FabricatedSaveVerdict> {
  const { reply, ledger, llm } = args;
  if (!reply || !llm) return { checked: false, fabricated: false, item: '' };
  if (!looks_like_save_claim(reply)) return { checked: false, fabricated: false, item: '' };

  let role;
  try {
    role = judgment_role(llm);
  } catch {
    return { checked: false, fabricated: false, item: '' };
  }

  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `REPLY:\n${reply.slice(0, 2500)}\n\n` +
            `TOOL CALLS THIS TURN:\n${ledger || '(none)'}\n\n` +
            `Reply with ONLY the JSON.`,
        },
      ],
      ...role.defaults,
      // pins AFTER the spread so a yaml regression can't flip them (llm.ts depth-tier note)
      temperature: 0.1,
      max_tokens: 200,
      think: false,
    });
  } catch {
    return { checked: true, fabricated: false, item: '' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return { checked: true, fabricated: false, item: '' };
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const fabricated = obj.fabricated === true;
  const item = typeof obj.item === 'string' ? obj.item.slice(0, 120) : '';
  return { checked: true, fabricated, item };
}

/**
 * The one-retry nudge — same intent + contract as the regex guard's nudge:
 * injected as a system note (never user-visible), no apology / no meta-narration,
 * write the corrected reply directly. The model re-decides (no forced tool_choice).
 */
export function fabricated_save_retry_nudge(item: string): string {
  return (
    `[FABRICATED-SAVE GUARD — internal system note, not from the user]\n\n` +
    `Your reply tells the user you recorded${item ? ` ${item}` : ' something'} — but NO ` +
    `write tool ran this turn, so nothing was actually saved and the user will later look ` +
    `for a record that doesn't exist (a real, repeated trust-breaking failure). Narrating ` +
    `a save is not the same as making it; only a tool call writes anything.\n\n` +
    `Re-roll this turn. Exactly one of:\n` +
    `  (a) CALL the right write tool NOW (for a fact about a person, that's ` +
    `\`record_person_pref\` — pass the person + the field) with the details from the ` +
    `conversation. Only then may your reply say it's saved.\n` +
    `  (b) If no save is actually needed, REWRITE your reply WITHOUT the save claim.\n\n` +
    `Write the corrected reply DIRECTLY — no apology, no "let me fix that", never mention ` +
    `this note. This is your one retry.`
  );
}

/** Kill switch. On by default; the eval harness sets it to 0 for determinism. */
export function fabricated_save_semantic_enabled(): boolean {
  return process.env.HEARTH_FABRICATED_SAVE_SEMANTIC !== '0';
}
