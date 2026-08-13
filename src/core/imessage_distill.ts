/**
 * imessage_distill — the nightly distillation of staged iMessage windows into
 * the People reasoning substrate (the iMessage signal source, 2026-06-22).
 *
 * The macOS app uploads raw 1:1 message windows for OPTED-IN contacts into the
 * transient `imessage_staging` buffer (cheap, frequent). This nightly pass is
 * the expensive half: per opted-in person it filters out ephemeral chatter,
 * then distills the substantive windows into the DISTILLATE Hearth keeps —
 *
 *   - durable FACTS about the person (likes/dislikes/dietary/pets/dates/
 *     relations) → merged into the People/ note via the SAME grounded,
 *     union-dedup `extract_person_facts` + `merge_facts` engine the chat-told
 *     enrichment uses (so a fact about a shared contact is communal, exactly
 *     as if it had been typed into the card);
 *   - relationship SIGNAL that is uniquely iMessage — open loops/commitments
 *     ("you owe Sam that recipe"), life events (moved / new job / engaged),
 *     topics worth prepping, and (2026-07-26) STYLE notes on how the person
 *     actually communicates — → `person_observations` (source_type
 *     'imessage'), stamped `private_to` = the UPLOADER (owner-only), because
 *     the distillate of someone's private correspondence is theirs to see.
 *     Style is extracted HERE rather than downstream because this is the only
 *     point where the raw voice exists: the transcript is dropped below, so no
 *     later pass could recover how they write. It accumulates into the
 *     synthesis pass's `communication` portrait.
 *
 * Then it DROPS the staged raw. Hearth never becomes a searchable archive of
 * message history — the Mac's chat.db is the source of truth; re-distill =
 * re-upload. This is the load-bearing privacy boundary.
 *
 * Disciplines (mirroring person_enrichment / capture_quality / the observer
 * engine — every one is a contract, not a nicety):
 *   - DARK by default (HEARTH_IMESSAGE_OBSERVER=1) — the sweep no-ops when off.
 *   - CADENCE-GATED — the upload clock and the distill clock are decoupled; the
 *     job fires nightly but only actually distills once
 *     HEARTH_IMESSAGE_DISTILL_MIN_INTERVAL_H (default 20h) has elapsed, so the
 *     cadence is a tunable knob (set it to 168 for weekly) with no YAML edit.
 *   - GROUNDED + FAIL-OPEN — extraction returns ONLY what was stated; any LLM /
 *     parse error degrades to "extract nothing," never a wrong fact. The
 *     substance filter fails OPEN to "distill" (the grounded extract is the
 *     backstop — it pulls nothing from noise; the filter only saves cost).
 *   - CORDONED — observations carry the uploader's cordon; the opt-in is
 *     re-checked here as defense-in-depth (a window for a not-opted person is
 *     dropped, never distilled).
 *   - IDEMPOTENT — fact merges are union-dedup; observations key on a content
 *     hash; staged raw is dropped on consume, so a re-run can't double-write.
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient, PersonRow } from '@memory/client';
import type { UserRegistry } from '@core/users';
import { parse_fm } from '@core/relationship_signals';
import { upsert_person_note } from '@agents/scribe/tools/upsert_person_note';
import {
  extract_person_facts,
  merge_facts,
  type EnrichLLM,
} from '@core/person_enrichment';
import { PersonObservations } from '@memory/stores/person_observations';
import { ImessageStaging, ImessageOptIn, type StagedMessage } from '@memory/stores/imessage_staging';
import { resolve_person_for_write } from '@core/entity_hydration';
import type { Caller } from '@memory/private_to';

export function imessage_observer_enabled(): boolean {
  return process.env.HEARTH_IMESSAGE_OBSERVER === '1';
}
function distill_tier(): string {
  return process.env.HEARTH_IMESSAGE_DISTILL_TIER || 'planner';
}
function min_interval_ms(): number {
  const h = Number.parseFloat(process.env.HEARTH_IMESSAGE_DISTILL_MIN_INTERVAL_H ?? '');
  // Default 20h: a nightly job always passes; set 168 for weekly, 0 to disable.
  return Number.isFinite(h) && h >= 0 ? h * 60 * 60 * 1000 : 20 * 60 * 60 * 1000;
}
function max_attempts(): number {
  const n = Number.parseInt(process.env.HEARTH_IMESSAGE_DISTILL_MAX_ATTEMPTS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
function strip_fence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

const LAST_DISTILL_KEY = 'last_distill_at';
const MAX_TRANSCRIPT_MESSAGES = 80;
const MAX_TRANSCRIPT_CHARS = 6000;

// ── transcript rendering ──────────────────────────────────────────────────────

/** Render a window as a speaker-attributed transcript ("Me:" / "<Name>:") so the
 *  extractor can attribute facts AND open-loop direction. Capped for prompt size. */
export function render_transcript(messages: StagedMessage[], person_name: string): string {
  const lines: string[] = [];
  let chars = 0;
  for (const m of messages.slice(-MAX_TRANSCRIPT_MESSAGES)) {
    const text = (m.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${m.from_me ? 'Me' : person_name}: ${text}`;
    chars += line.length;
    if (chars > MAX_TRANSCRIPT_CHARS) break;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Latest message timestamp in a window (when it was actually said), for an
 *  honest observation timeline. Falls back to now. */
function latest_ts(messages: StagedMessage[], fallback: string): string {
  let max = '';
  for (const m of messages) if (typeof m.ts === 'string' && m.ts > max) max = m.ts;
  return max || fallback;
}

// ── substance filter (structural pre-filter + LLM judge, fail-open) ────────────

/** Is a single message substantive (vs "k" / "omw" / an emoji)? */
function is_substantive(text: string): boolean {
  const t = (text ?? '').trim();
  return t.length >= 25 || t.split(/\s+/).filter(Boolean).length >= 5;
}

export interface SubstanceSignal {
  substantive_count: number;
  total_chars: number;
  verdict: 'skip' | 'distill' | 'judge';
}

/** Deterministic structural pre-filter — content SHAPE, not a word blacklist.
 *  A window with zero substantive lines can carry no durable signal (skip); a
 *  window with several clearly can (distill); the ambiguous middle pays for the
 *  model. Mirrors capture_quality's structural band. */
export function window_substance_signal(messages: StagedMessage[]): SubstanceSignal {
  let substantive_count = 0;
  let total_chars = 0;
  for (const m of messages) {
    const t = (m.text ?? '').trim();
    total_chars += t.length;
    if (is_substantive(t)) substantive_count += 1;
  }
  if (substantive_count === 0) return { substantive_count, total_chars, verdict: 'skip' };
  if (substantive_count >= 3) return { substantive_count, total_chars, verdict: 'distill' };
  return { substantive_count, total_chars, verdict: 'judge' };
}

const SUBSTANCE_SYSTEM =
  'You decide whether a 1:1 text-message conversation window contains DURABLE ' +
  'SIGNAL worth remembering for a personal chief-of-staff — anything like: a ' +
  'fact about the person (their job, where they live, family, pets, diet, ' +
  'preferences), a life event (moving, new job, engaged, a baby, a loss), an ' +
  'open loop or commitment ("I\'ll send you that", "let me know about Sat"), or ' +
  'a topic worth following up on. It is NOT worth remembering when the window is ' +
  'pure ephemeral chatter: logistics ("omw", "running late"), reactions ("lol", ' +
  '"haha", "nice"), or one-word acknowledgements with no content.\n' +
  'Reply with ONLY this JSON: {"has_signal": <bool>, "reason": "<short>"}';

async function judge_window_substance(llm: EnrichLLM, transcript: string): Promise<boolean> {
  let role;
  try {
    role = llm.for_role(distill_tier());
  } catch {
    return true; // fail-open
  }
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: SUBSTANCE_SYSTEM },
        { role: 'user', content: `Conversation:\n${transcript}\n\nReply with ONLY the JSON.` },
      ],
      temperature: 0.1,
      max_tokens: 120,
      think: false, // suppress 35B reasoning; otherwise content is empty → JSON.parse throws → fail-open
    });
    const parsed = JSON.parse(strip_fence(resp.content || '')) as { has_signal?: unknown };
    return parsed?.has_signal !== false; // anything but an explicit false → distill (fail-open)
  } catch {
    return true; // fail-open: a judge outage never drops a real window
  }
}

/** The full substance gate: structural first, judge only the ambiguous middle.
 *  Fail-open to distill everywhere. */
export async function assess_window_substance(args: { messages: StagedMessage[]; transcript: string; llm?: EnrichLLM }): Promise<boolean> {
  const sig = window_substance_signal(args.messages);
  if (sig.verdict === 'skip') return false;
  if (sig.verdict === 'distill') return true;
  if (!args.llm) return true; // ambiguous + no judge → fail-open distill
  return judge_window_substance(args.llm, args.transcript);
}

// ── iMessage-specific signal extraction (loops / life-events / topics) ─────────

export interface ImessageSignals {
  open_loops: Array<{ summary: string; owed_by?: 'me' | 'them' | 'mutual'; due_hint?: string }>;
  life_events: Array<{ summary: string }>;
  topics: Array<{ summary: string }>;
  /** How the person COMMUNICATES — the durable relational signal the other kinds
   *  never carried. Extracted here because this is the only point in the pipeline
   *  where the raw voice is visible: the transcript is dropped a few lines later,
   *  so a downstream pass could never recover it. Feeds the synthesis pass's
   *  `communication` portrait (the relational sibling of the user's own style
   *  profile). */
  style_notes: Array<{ summary: string }>;
}

// Built per-contact so the model writes real names, not the words "the contact"
// / "the owner" / "Me" (the 35B parrots those role-words from a generic prompt).
export function signals_system(person_name: string): string {
  return (
    `You extract durable relationship signal from a 1:1 iMessage conversation, for ` +
    `a personal chief-of-staff who wants to keep up with ${person_name}. In the ` +
    `transcript "Me:" is the owner (the principal) and the other speaker is ` +
    `${person_name}. Return ONLY a JSON object with keys:\n` +
    `  open_loops:  [{summary, owed_by, due_hint}]  — commitments still genuinely ` +
    `OPEN. summary is JUST the pending thing (e.g. "send the recipe", "book ` +
    `daycare for Mango") — do NOT restate who owes whom; that's owed_by, which is ` +
    `"me" (the owner owes ${person_name}), "them" (${person_name} owes / is ` +
    `waiting on the owner), or "mutual". due_hint is any time reference ` +
    `("Saturday", "next week"), else omit. SKIP trivial same-day errands and ` +
    `anything already resolved in the thread — keep only loops that still matter ` +
    `days later.\n` +
    `  life_events: [{summary}]  — a real change in ${person_name}'s life stated ` +
    `in the thread (moving, new job, engaged, new baby, a loss, travel, health).\n` +
    `  topics:      [{summary}]  — subjects worth remembering to ask ${person_name} ` +
    `about next time (their job hunt, a trip they took, a project).\n` +
    `  style_notes: [{summary}]  — how ${person_name} COMMUNICATES, judged from the ` +
    `way they actually write in this transcript: their register (warm / terse / ` +
    `formal / playful), message length and rhythm, what they open with, what they ask the ` +
    `owner about, how they handle a serious or emotional subject, humor and how it ` +
    `lands, how quickly and how fully they answer a direct question, anything they ` +
    `consistently do or avoid. Describe ${person_name}'s OWN voice, NEVER the ` +
    `owner's, and never what was discussed (that's topics). Note only what this ` +
    `transcript actually shows — 0-3 notes, and [] when the window is too thin to ` +
    `tell. This is the one signal that is about HOW they talk rather than WHAT ` +
    `happened, so keep it observational, specific, and free of flattery.\n` +
    `Write every summary in plain prose, naming ${person_name} explicitly and ` +
    `calling the owner "you" — NEVER the words "the contact", "the owner", or "Me". ` +
    `Include ONLY what is EXPLICITLY present in the messages — never infer, never ` +
    `guess, never carry over generic knowledge. Omit a key (or use []) when nothing ` +
    `applies. Keep each summary to one short sentence. JSON only.`
  );
}

// ── Owner-side self signal (2026-07-28) ──────────────────────────────────────
// The same transcripts carry the OWNER's half — what they committed to, what's
// occupying them, what changed in THEIR life — and until now all of it was
// discarded, which is why the owner's own dossier stayed empty while every
// contact's grew. One extraction per uploader per sweep over their sent lines
// (across all contacts), written to their own People row so the nightly
// synthesis builds THEIR portrait with zero new machinery. Same privacy
// boundary: the distillate is kept, the raw is dropped, cordon = the uploader.

export function owner_signals_system(owner_name: string): string {
  return (
    `You extract durable signal ABOUT ${owner_name} from messages ${owner_name} ` +
    `sent to various friends (each line is "To <friend>: <message>"). The subject ` +
    `is ${owner_name} ONLY — never the friends. Return ONLY a JSON object with keys:\n` +
    `  open_loops:  [{summary, due_hint}] — commitments ${owner_name} made that are ` +
    `still genuinely open ("promised to send Kim the ladder", "owes Ceci a call"). ` +
    `SKIP trivial same-day errands and anything already resolved.\n` +
    `  life_events: [{summary}] — a real change in ${owner_name}'s OWN life stated ` +
    `in these messages (travel booked, job news, health, a project started).\n` +
    `  topics:      [{summary}] — what is genuinely occupying ${owner_name} lately, ` +
    `judged from what they keep bringing up.\n` +
    `  style_notes: [{summary}] — 0-2 observations on how ${owner_name} writes.\n` +
    `Name ${owner_name} explicitly in every summary. Include ONLY what is ` +
    `EXPLICITLY present — never infer, never guess. Omit a key (or []) when ` +
    `nothing applies. One short sentence each. JSON only.`
  );
}

export async function extract_owner_signals(
  llm: EnrichLLM,
  owner_name: string,
  sent_lines: string[],
): Promise<ImessageSignals | null> {
  const transcript = sent_lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
  if (!transcript.trim()) return null;
  let role;
  try {
    role = llm.for_role(distill_tier());
  } catch {
    return null;
  }
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: owner_signals_system(owner_name) },
        { role: 'user', content: `Messages ${owner_name} sent:\n${transcript}\n\nReply with ONLY the JSON.` },
      ],
      temperature: 0.1,
      max_tokens: 500,
      think: false, // 35B reasoning would leave content empty → JSON.parse throws → fail-open
    });
    const parsed = JSON.parse(strip_fence(resp.content || '')) as Partial<ImessageSignals>;
    if (!parsed || typeof parsed !== 'object') return null;
    const pick_summaries = (v: unknown): Array<{ summary: string }> =>
      Array.isArray(v)
        ? v
            .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
            .map((o) => String(o.summary ?? '').trim())
            .filter(Boolean)
            .map((summary) => ({ summary }))
        : [];
    const open_loops: ImessageSignals['open_loops'] = [];
    if (Array.isArray(parsed.open_loops)) {
      for (const x of parsed.open_loops) {
        if (!x || typeof x !== 'object') continue;
        const o = x as Record<string, unknown>;
        const summary = String(o.summary ?? '').trim();
        if (!summary) continue;
        const due = typeof o.due_hint === 'string' && o.due_hint.trim() ? o.due_hint.trim() : undefined;
        open_loops.push(due ? { summary, due_hint: due } : { summary });
      }
    }
    return {
      open_loops,
      life_events: pick_summaries(parsed.life_events),
      topics: pick_summaries(parsed.topics),
      style_notes: pick_summaries(parsed.style_notes).slice(0, 2),
    };
  } catch {
    return null;
  }
}

export async function extract_imessage_signals(
  llm: EnrichLLM,
  person_name: string,
  transcript: string,
): Promise<ImessageSignals | null> {
  if (!transcript.trim()) return null;
  let role;
  try {
    role = llm.for_role(distill_tier());
  } catch {
    return null;
  }
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: signals_system(person_name) },
        { role: 'user', content: `Contact: ${person_name}\n\nConversation:\n${transcript}\n\nReply with ONLY the JSON.` },
      ],
      temperature: 0.1,
      max_tokens: 700, // + style_notes
      think: false, // suppress 35B reasoning; otherwise content is empty → JSON.parse throws → fail-open
    });
    const parsed = JSON.parse(strip_fence(resp.content || '')) as Partial<ImessageSignals>;
    if (!parsed || typeof parsed !== 'object') return null;
    const norm_arr = <T>(v: unknown, pick: (o: Record<string, unknown>) => T | null): T[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
            .map(pick)
            .filter((x): x is T => x !== null)
        : [];
    return {
      open_loops: norm_arr(parsed.open_loops, (o) => {
        const summary = String(o.summary ?? '').trim();
        if (!summary) return null;
        const owed = o.owed_by === 'me' || o.owed_by === 'them' || o.owed_by === 'mutual' ? o.owed_by : undefined;
        const due = typeof o.due_hint === 'string' && o.due_hint.trim() ? o.due_hint.trim() : undefined;
        return { summary, owed_by: owed, due_hint: due };
      }),
      life_events: norm_arr(parsed.life_events, (o) => {
        const summary = String(o.summary ?? '').trim();
        return summary ? { summary } : null;
      }),
      topics: norm_arr(parsed.topics, (o) => {
        const summary = String(o.summary ?? '').trim();
        return summary ? { summary } : null;
      }),
      style_notes: norm_arr(parsed.style_notes, (o) => {
        const summary = String(o.summary ?? '').trim();
        return summary ? { summary } : null;
      }).slice(0, 3),
    };
  } catch {
    return null; // fail-open: no signal beats a wrong one
  }
}

/** A stable observation source_ref so re-extraction of the same loop/topic
 *  collapses (the person_observations UNIQUE key is (person, source_type,
 *  source_ref, kind)). */
function signal_ref(kind: string, summary: string): string {
  return createHash('sha256').update(`${kind}|${summary.toLowerCase().trim()}`).digest('hex').slice(0, 16);
}

/** Render an open-loop into a one-line observation summary that carries who owes. */
function loop_summary(person_name: string, l: { summary: string; owed_by?: string; due_hint?: string }): string {
  const who =
    l.owed_by === 'me' ? `you owe ${person_name}` :
    l.owed_by === 'them' ? `${person_name} owes you` :
    l.owed_by === 'mutual' ? 'open between you' : 'open';
  const due = l.due_hint ? ` (${l.due_hint})` : '';
  return `Open loop — ${who}${due}: ${l.summary}`;
}

// ── the sweep ──────────────────────────────────────────────────────────────────

export interface ImessageDistillDeps {
  db: Database;
  memory: MemoryClient;
  llm: EnrichLLM;
  users?: UserRegistry;
  now?: () => Date;
}

export interface ImessageDistillResult {
  enabled: boolean;
  skipped: boolean;
  people: number;
  facts: number;
  observations: number;
  dropped: number;
}

const ZERO: Omit<ImessageDistillResult, 'enabled' | 'skipped'> = { people: 0, facts: 0, observations: 0, dropped: 0 };

/** The nightly distill. Returns counts; never throws (fail-open per person). */
export async function run_imessage_distill_sweep(deps: ImessageDistillDeps): Promise<ImessageDistillResult> {
  if (!imessage_observer_enabled()) return { enabled: false, skipped: false, ...ZERO };
  const now = (deps.now ?? (() => new Date()))();
  const staging = new ImessageStaging(deps.db);
  const opt_in = new ImessageOptIn(deps.db);
  const observations = new PersonObservations(deps.db);

  // Cadence gate — decouple the distill clock from the upload clock.
  const last = staging.get_meta(LAST_DISTILL_KEY);
  if (last) {
    const elapsed = now.getTime() - new Date(last).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < min_interval_ms()) {
      return { enabled: true, skipped: true, ...ZERO };
    }
  }

  let people = 0;
  let facts = 0;
  let obs = 0;
  let dropped = 0;

  // Owner-side self signal (2026-07-28): the owner's own substantive sent
  // lines, collected across every contact's windows BEFORE the raw is dropped,
  // keyed by uploader. Distilled once per uploader after the loop.
  const self_lines = new Map<string, string[]>();

  for (const person_id of staging.pending_person_ids()) {
    const windows = staging.pending_for_person(person_id);
    const ids = windows.map((w) => w.id);
    try {
      const user_id = windows[0]?.user_id;
      // Defense-in-depth opt-in re-check: a window for a not-opted (or unknown)
      // contact is dropped, never distilled.
      if (!user_id || !opt_in.is_enabled_for(person_id, user_id)) {
        dropped += staging.drop(ids);
        continue;
      }
      const person = deps.memory.query_people({}).find((p) => p.id === person_id);
      if (!person) {
        dropped += staging.drop(ids);
        continue;
      }

      const messages = windows.flatMap((w) => w.messages);
      const transcript = render_transcript(messages, person.name);

      // Substance filter — drop ephemeral-only windows without paying for distill.
      const worth = await assess_window_substance({ messages, transcript, llm: deps.llm });
      if (!worth) {
        dropped += staging.drop(ids);
        continue;
      }

      // Bank the owner's own substantive sent lines for the post-loop self
      // distill (the raw is dropped below; this is the only chance to read it).
      {
        const mine = self_lines.get(user_id) ?? [];
        for (const m of messages) {
          if (m.from_me && is_substantive(m.text) && mine.length < 60) {
            mine.push(`To ${person.name}: ${(m.text ?? '').replace(/\s+/g, ' ').trim()}`);
          }
        }
        self_lines.set(user_id, mine);
      }

      const observed_at = latest_ts(messages, now.toISOString());
      const caller_tier = deps.users?.get(user_id)?.tier ?? 'owner';
      const ctx: ToolContext = {
        memory: deps.memory,
        llm: deps.llm as unknown as LLMRouter,
        now,
        intent_id: ulid(),
        user: { id: user_id, tier: caller_tier },
      };

      // 1) Durable facts → the People note (communal, via the shared engine).
      const snippets = messages
        .filter((m) => is_substantive(m.text))
        .map((m) => `${m.from_me ? 'Me' : person.name}: ${m.text.replace(/\s+/g, ' ').trim()}`)
        .slice(0, 40);
      try {
        const extracted = await extract_person_facts(deps.llm, person.name, snippets);
        if (extracted) {
          const { patch, added } = merge_facts(parse_fm(person.frontmatter_json), extracted);
          if (added.length) {
            await upsert_person_note.execute({ identifier: { id: person.id }, patch }, ctx);
            facts += added.length;
          }
        }
      } catch (e) {
        // Isolate the facts write: a People-note failure must NOT lose the
        // relationship-signal observations below, nor trip the per-person retry.
        console.error(`[imessage-distill] facts step failed for ${person_id}:`, e);
      }

      // 2) Relationship signal → person_observations (owner-only cordon).
      try {
        const signals = await extract_imessage_signals(deps.llm, person.name, transcript);
        if (signals) {
          const record = (kind: string, summary: string, confidence: number): void => {
            if (!summary.trim()) return;
            const r = observations.record({
              person_id: person.id,
              user_id,
              kind,
              summary: summary.slice(0, 280),
              source_type: 'imessage',
              source_ref: signal_ref(kind, summary),
              confidence,
              private_to: user_id, // the distillate of private correspondence stays the uploader's
              observed_at,
            });
            if (r.is_new) obs += 1;
          };
          for (const l of signals.open_loops) record('open_loop', loop_summary(person.name, l), 0.7);
          for (const e of signals.life_events) record('life_event', `Life event — ${e.summary}`, 0.6);
          for (const t of signals.topics) record('topic', `Talk about: ${t.summary}`, 0.5);
          // How they talk. Low confidence per window BY DESIGN — one conversation
          // is weak evidence of a person's voice; it earns weight by recurring
          // across windows, which is exactly what the synthesis pass rewards.
          for (const s of signals.style_notes) record('style', `How they communicate — ${s.summary}`, 0.4);
        }
      } catch (err) {
        console.error(`[imessage-distill] signals step failed for ${person_id}:`, err);
      }

      // 3) DROP the raw — Hearth keeps only the distillate.
      dropped += staging.drop(ids);
      people += 1;
    } catch (err) {
      console.error(`[imessage-distill] person ${person_id} failed (fail-open):`, err);
      // Fail-open per person: leave the raw for a retry, but bound retention so
      // a persistently-failing distill can't hoard private message text forever.
      try {
        staging.bump_attempts(ids);
        const exhausted = staging.exhausted_ids(max_attempts());
        if (exhausted.length) dropped += staging.drop(exhausted);
      } catch {
        /* ignore */
      }
    }
  }

  // Owner-side self distill — one extraction per uploader over their banked
  // sent lines. Their observations land on their OWN People row, so the
  // nightly synthesis builds the owner's portrait exactly like a friend's.
  // Fail-open at every seam: no resolvable self row / thin evidence / LLM
  // error → skip silently, never a ghost person row.
  for (const [uploader_id, lines] of self_lines) {
    if (lines.length < 6) continue; // too thin to say anything honest
    try {
      const member = deps.users?.get(uploader_id);
      const owner_name = member?.display_name || uploader_id;
      const caller: Caller = { user_id: uploader_id, tier: (member?.tier ?? 'owner') as Caller['tier'] };
      const self_person = resolve_person_for_write(deps.memory, owner_name, caller);
      if (!self_person) continue;
      const signals = await extract_owner_signals(deps.llm, owner_name, lines);
      if (!signals) continue;
      const record = (kind: string, summary: string, confidence: number): void => {
        if (!summary.trim()) return;
        const r = observations.record({
          person_id: self_person.id,
          user_id: uploader_id,
          kind,
          summary: summary.slice(0, 280),
          source_type: 'imessage',
          source_ref: signal_ref(`self_${kind}`, summary),
          confidence,
          private_to: uploader_id, // the owner's own distillate is theirs alone
          observed_at: now.toISOString(),
        });
        if (r.is_new) obs += 1;
      };
      for (const l of signals.open_loops) record('open_loop', l.due_hint ? `${l.summary} (${l.due_hint})` : l.summary, 0.6);
      for (const e of signals.life_events) record('life_event', `Life event — ${e.summary}`, 0.6);
      for (const t of signals.topics) record('topic', t.summary, 0.5);
      for (const s of signals.style_notes) record('style', `How they communicate — ${s.summary}`, 0.4);
    } catch (err) {
      console.error(`[imessage-distill] owner self-distill failed for ${uploader_id} (fail-open):`, err);
    }
  }

  staging.set_meta(LAST_DISTILL_KEY, now.toISOString());
  return { enabled: true, skipped: false, people, facts, observations: obs, dropped };
}
