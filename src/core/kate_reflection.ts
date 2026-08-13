/**
 * kate_reflection — the walk-the-house reflection pass (C2, the spine of
 * [docs/design-kate-self-direction.md](../../docs/design-kate-self-direction.md)).
 *
 * The general successor to the pairwise scans: ONE nightly open-mandate
 * deep-tier pass over the fused household picture + Kate's own open watch
 * ledger — "what's off, what connects, what needs doing that no scan owns?" —
 * producing typed observations with dispositions ordered CHEAPEST FIRST
 * (ignore | watch | investigate | act | ask). The durable ledger
 * ([kate_observations](../memory/stores/kate_observations.ts)) is what turns
 * one-shot noticing into ongoing attention: watches re-enter the next pass,
 * anchors dedup recurrences, dismissed stays dismissed.
 *
 * Noise discipline (the roster-gaps post-mortem, each cause countered
 * structurally):
 *  - typed grounded percepts: the input is the working-memory composition +
 *    the ledger, never raw exhaust; evidence_refs must point at it.
 *  - cheapest-first taxonomy: the prompt LEADS with ignore/watch; "an empty
 *    list is a good outcome" is stated outright.
 *  - structural dedup: anchor-keyed upserts + `exists_for_signature` on any
 *    proposal + a hard ≤2 proposals/pass cap.
 *
 * Arming discipline (the trust-teeth scored-week pattern applied to
 * initiative): HEARTH_KATE_REFLECTION=1 turns the pass on WATCH-ONLY — act /
 * investigate / ask dispositions are recorded as INTENDED but applied as
 * watch. HEARTH_KATE_REFLECTION_ACT=1 arms the act disposition (files
 * cordoned action_proposals through the normal court/owner path). The
 * intended-vs-applied pair on every ledger row is the soak's evidence of what
 * she WOULD have done.
 *
 * Fail-CLOSED: an LLM outage / garbled envelope files NOTHING (a proactive
 * surface skips rather than acting on noise — the scan_life_events contract).
 */
import type { Database } from 'bun:sqlite';
import type { LLMRouter, LLMMessage } from './llm';
import type { ProposalsStore } from './proposals';
import { compose_working_memory } from './working_memory';
import type { MemoryClient } from '@memory/client';
import {
  KateObservations,
  type ObservationDisposition,
  type KateObservationRow,
} from '@memory/stores/kate_observations';
import { local_iso_date } from './time';

export function kate_reflection_enabled(): boolean {
  return process.env.HEARTH_KATE_REFLECTION === '1';
}

/** The act disposition stays DOWNGRADED to watch until this is separately
 *  armed after the watch-only soak week (the scored-week gate — arming is the
 *  owner's call, never automatic). */
export function reflection_act_armed(): boolean {
  return process.env.HEARTH_KATE_REFLECTION_ACT === '1';
}

const PROPOSALS_PER_PASS_CAP = 2;
const ASKS_PER_PASS_CAP = 2;
const OBSERVATIONS_PER_PASS_CAP = 8;

/**
 * ── Attention earns rope (design-kate-self-direction.md §"the one genuinely
 * new governing mechanism") ────────────────────────────────────────────────
 *
 * The caps above are constants, which makes the noise question unanswerable:
 * initiative that the owner ignores costs exactly as much budget next pass as
 * initiative he acts on, so the loop cannot get quieter when it is wrong or
 * bolder when it is right. That is the roster-gaps failure shape — denied
 * packets re-filing every pass forever — and it is why arming the `act`
 * disposition has stayed too expensive to try.
 *
 * The throttle scores her OWN filed initiative by what the owner did with it,
 * and moves the caps. He never tunes a knob; his existing reactions are the
 * knob. Deliberately asymmetric and evidence-gated:
 *
 *   - Below MIN_SCORED samples the caps DO NOT MOVE. No evidence is a reason
 *     to keep today's behaviour, never a reason to widen.
 *   - Widening is capped at one extra of each. Rope, not a blank cheque.
 *   - Shrinking bottoms out at watch-only (zero proposals) but never stops
 *     her NOTICING — the ledger keeps filling, so a shrunk budget can still
 *     earn its way back. A throttle that silenced the evidence it is scored
 *     on could never recover.
 */
const INITIATIVE_WINDOW_DAYS = 30;
const INITIATIVE_MIN_SCORED = 4;
const INITIATIVE_WIDEN_AT = 0.6;
const INITIATIVE_SHRINK_AT = 0.25;

export interface InitiativeCaps {
  proposals: number;
  asks: number;
  observations: number;
}

export interface InitiativeScore {
  /** Filed initiative the owner acted on (approved / acknowledged / ran). */
  engaged: number;
  /** Filed initiative he turned down or let lapse. */
  dismissed: number;
  scored: number;
  /** null until `scored >= INITIATIVE_MIN_SCORED` — never "close enough". */
  rate: number | null;
  caps: InitiativeCaps;
  note: string;
}

const DEFAULT_CAPS: InitiativeCaps = {
  proposals: PROPOSALS_PER_PASS_CAP,
  asks: ASKS_PER_PASS_CAP,
  observations: OBSERVATIONS_PER_PASS_CAP,
};

/**
 * Score the initiative she has already filed, from the owner's verdicts on
 * it. Only observations that BECAME something (`applied_disposition` =
 * `proposal:<id>`) are scorable — a watch nobody was shown is not evidence
 * either way, and counting it would let her inflate her own budget by
 * noticing more.
 *
 * Pure over the two stores; no LLM.
 */
export function score_initiative(
  store: KateObservations,
  proposals: ProposalsStore,
  opts?: { window_days?: number; now?: Date },
): InitiativeScore {
  const window = opts?.window_days ?? INITIATIVE_WINDOW_DAYS;
  const rows = store.recent_anchors(window, 200);
  let engaged = 0;
  let dismissed = 0;
  for (const row of rows) {
    if (!row.applied_disposition.startsWith('proposal:')) continue;
    const pid = row.applied_disposition.slice('proposal:'.length);
    let status: string | null = null;
    try {
      status = proposals.get(pid)?.status ?? null;
    } catch {
      status = null;
    }
    if (!status) continue;
    // Same verdict axis the court scorecard uses, so "engagement" means the
    // same thing in both places.
    if (
      status === 'approved' ||
      status === 'acknowledged' ||
      status === 'executed' ||
      status === 'failed'
    ) {
      engaged++;
    } else if (status === 'denied' || status === 'expired' || status === 'superseded') {
      dismissed++;
    }
    // pending / snoozed: he has not answered yet — not evidence in either
    // direction (silence is not consent, the digest rule).
  }
  const scored = engaged + dismissed;
  if (scored < INITIATIVE_MIN_SCORED) {
    return {
      engaged,
      dismissed,
      scored,
      rate: null,
      caps: { ...DEFAULT_CAPS },
      note:
        `Initiative unscored (${scored}/${INITIATIVE_MIN_SCORED} decided in ${window}d) — ` +
        `caps unchanged. Too little evidence is never a reason to widen.`,
    };
  }
  const rate = engaged / scored;
  if (rate >= INITIATIVE_WIDEN_AT) {
    return {
      engaged,
      dismissed,
      scored,
      rate,
      caps: {
        proposals: PROPOSALS_PER_PASS_CAP + 1,
        asks: ASKS_PER_PASS_CAP + 1,
        observations: OBSERVATIONS_PER_PASS_CAP + 2,
      },
      note: `Initiative engaged ${engaged}/${scored} — caps widened one notch.`,
    };
  }
  if (rate <= INITIATIVE_SHRINK_AT) {
    return {
      engaged,
      dismissed,
      scored,
      rate,
      caps: {
        proposals: 0,
        asks: 1,
        observations: Math.max(4, OBSERVATIONS_PER_PASS_CAP - 2),
      },
      note:
        `Initiative dismissed ${dismissed}/${scored} — back to watch-only. ` +
        `She keeps noticing; she stops filing until the record improves.`,
    };
  }
  return {
    engaged,
    dismissed,
    scored,
    rate,
    caps: { ...DEFAULT_CAPS },
    note: `Initiative mixed (${engaged}/${scored}) — caps held at the default.`,
  };
}
const WATCH_INPUT_CAP = 12;
/** How far back the anchor-dedup pool reaches, and how many it carries. A
 *  concern she settled last week must still be recognizable tonight. */
const JUDGED_WINDOW_DAYS = 30;
const JUDGED_INPUT_CAP = 40;
const STALE_WATCH_DAYS = 21;

const DISPOSITIONS: ReadonlySet<string> = new Set(['ignore', 'watch', 'investigate', 'act', 'ask']);

export interface ReflectionDeps {
  db: Database;
  memory: MemoryClient;
  llm: LLMRouter;
  proposals: ProposalsStore;
  /** Injectable for the smoke; defaults to a real store over `db`. */
  observations?: KateObservations;
  /** Best-effort audit hook (the tool wires memory.log_action). */
  audit?: (summary: Record<string, unknown>) => void;
}

export interface ReflectionOpts {
  user_id: string;
  tier: 'owner' | 'household' | 'friend';
  timezone?: string;
  now?: Date;
}

export interface ReflectionResult {
  enabled: boolean;
  ran: boolean;
  parse_failed?: boolean;
  /** The envelope needed (and survived) the one-shot repair round. */
  repaired?: boolean;
  observations: number;
  new_items: number;
  recurring: number;
  suppressed: number;
  downgraded: number;
  proposals_filed: string[];
  /** Ask-disposition briefing cards filed this pass (2026-07-20). */
  asks_filed: string[];
  expired: number;
  /** The engagement throttle's verdict + the caps it set for this pass. */
  initiative?: InitiativeScore;
}

interface ParsedObservation {
  anchor: string;
  summary: string;
  rationale: string;
  evidence_refs: string[];
  disposition: ObservationDisposition;
  recheck_when?: string | null;
}

/** Strict, defensive envelope parse — fail-CLOSED on anything malformed.
 *  Tolerates a fenced code block (the 35B under plain JSON instructions
 *  occasionally fences); rejects everything else. Exported for the smoke. */
export function parse_reflection_envelope(raw: string): ParsedObservation[] | null {
  let text = (raw ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const obs = (parsed as { observations?: unknown }).observations;
  if (!Array.isArray(obs)) return null;
  const out: ParsedObservation[] = [];
  for (const o of obs.slice(0, OBSERVATIONS_PER_PASS_CAP)) {
    if (typeof o !== 'object' || o === null) continue;
    const r = o as Record<string, unknown>;
    const disposition = typeof r.disposition === 'string' ? r.disposition.trim().toLowerCase() : '';
    const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
    const anchor = typeof r.anchor === 'string' ? r.anchor.trim() : '';
    if (!DISPOSITIONS.has(disposition) || summary.length < 3 || anchor.length < 2) continue;
    const refs = Array.isArray(r.evidence_refs)
      ? r.evidence_refs.filter((x): x is string => typeof x === 'string').slice(0, 6)
      : [];
    out.push({
      anchor,
      summary: summary.slice(0, 400),
      rationale: (typeof r.rationale === 'string' ? r.rationale.trim() : '').slice(0, 400),
      evidence_refs: refs,
      disposition: disposition as ObservationDisposition,
      recheck_when: typeof r.recheck_when === 'string' ? r.recheck_when.slice(0, 120) : null,
    });
  }
  return out;
}

function render_watch_lines(watches: KateObservationRow[]): string {
  if (watches.length === 0) return '(none yet)';
  return watches
    .map(
      (w) =>
        `- [${w.anchor}] ${w.summary} (seen ${w.times_seen}x since ${w.ts_created.slice(0, 10)}` +
        `${w.recheck_when ? `; recheck: ${w.recheck_when}` : ''})`,
    )
    .join('\n');
}

/** Anchors already judged and SETTLED (resolved/expired) — rendered compactly
 *  so re-noticing costs a line, not a new row. Open watches are excluded
 *  because they get their own, fuller section. */
function render_settled_lines(judged: KateObservationRow[], watches: KateObservationRow[]): string {
  const open = new Set(watches.map((w) => w.anchor));
  const settled = judged.filter((j) => !open.has(j.anchor));
  if (settled.length === 0) return '(nothing settled recently)';
  return settled
    .map((j) => `- [${j.anchor}] ${j.summary.slice(0, 90)} (${j.applied_disposition}, ${j.times_seen}x)`)
    .join('\n');
}

export function build_reflection_messages(input: {
  picture: string;
  watches: KateObservationRow[];
  /** Everything judged in the last month — the reuse pool. */
  judged?: KateObservationRow[];
  local_date: string;
}): LLMMessage[] {
  const system = [
    'You are Kate — chief of staff of this household. This is your private',
    'end-of-night walk of the house: nobody asked a question; you are looking',
    'over the whole picture yourself, the way a good ship\'s AI checks her hull.',
    '',
    'TASK: from the picture and your open watches below, surface what is off,',
    'what connects, or what needs doing that no scheduled scan already owns.',
    '',
    'RULES — read carefully:',
    '- Ground EVERY observation in the picture or watches below. Each',
    '  evidence_refs entry must quote or closely paraphrase a line from them.',
    '  If you cannot point at it, you did not observe it.',
    '- Most nights little or nothing is worth raising. An EMPTY observations',
    '  list is a good outcome, not a failure. Never manufacture a concern.',
    '- Dispositions, CHEAPEST FIRST — prefer the earliest that fits:',
    '    ignore — noted, not worth attention; keeps you from re-noticing it',
    '    watch — keep an eye on it; set recheck_when (a condition or a date)',
    '    investigate — worth a deeper look before bothering anyone',
    '    act — a concrete next step someone should approve (rare; be sure)',
    '    ask — only the owner can resolve it',
    '- anchor: a short STABLE key for the underlying thing (not tonight\'s',
    '  wording) — lowercase words and colons, e.g. "water-bill:spike" or',
    '  "sam:recurring-headaches" — so tomorrow\'s walk recognizes it.',
    '  REUSE, don\'t re-mint: if the thing you are noticing is ALREADY on YOUR',
    '  OPEN WATCHES below, copy its EXACT [anchor] verbatim — do NOT coin a new',
    '  variant for the same concern. e.g. if "hyundai:bluelink:cancellation" is',
    '  already watched, a follow-up tonight stays "hyundai:bluelink:cancellation",',
    '  never "…:cancellation-pending" or "…:stale" or "ev:bluelink-cancellation".',
    '  A NEW anchor is only for something genuinely not already on the list.',
    '- Voice: write summary and rationale as YOURSELF — dry, warm, specific.',
    '  "Third night the garage stayed open past midnight" beats "anomalous',
    '  garage state detected."',
    '',
    'Output STRICT JSON, nothing else:',
    '{"observations":[{"anchor":"...","summary":"...","rationale":"...",',
    '"evidence_refs":["..."],"disposition":"ignore|watch|investigate|act|ask",',
    '"recheck_when":"..."}]}',
  ].join('\n');

  const user = [
    `Local date: ${input.local_date}`,
    '',
    '## THE PICTURE (fused household state)',
    input.picture.trim() || '(the picture is empty tonight — most likely nothing to raise)',
    '',
    '## YOUR OPEN WATCHES (things you are already keeping an eye on)',
    render_watch_lines(input.watches),
    '',
    '## ALREADY SETTLED (you judged these recently — do not re-raise them',
    '## unless something CHANGED; if it did, reuse the exact [anchor])',
    render_settled_lines(input.judged ?? [], input.watches),
    '',
    'Your walk of the house — observations (STRICT JSON):',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** household/owner-visible signal → owner-global proposal; a member's → theirs. */
function cordon_user(private_to: string | null | undefined): string | null {
  if (!private_to || private_to === 'household' || private_to === 'owner') return null;
  return private_to;
}

/** Tokenize a normalized anchor into its colon/dash-separated parts (drop
 *  single-char noise). "hyundai:bluelink:cancellation-pending" →
 *  {hyundai, bluelink, cancellation, pending}. */
function anchor_tokens(anchor: string): Set<string> {
  return new Set(
    KateObservations.normalize_anchor(anchor)
      .split(/[:-]+/)
      .filter((t) => t.length > 1),
  );
}

/**
 * Dedup backstop for the model minting a FRESH anchor for a concern it's
 * already judged (the observed "hyundai:bluelink:cancellation" → "…:stale" →
 * "ev:bluelink-cancellation" proliferation, one real concern becoming four
 * rows). If the raw anchor isn't an exact match, snap it onto the known
 * anchor that shares ≥2 tokens with Jaccard ≥ THRESHOLD (best match wins) so
 * the concern accrues on ONE row (times_seen) instead of splintering.
 *
 * The candidate pool is every RECENTLY JUDGED anchor, not just the open
 * watches. Scoping it to open rows made the backstop weakest exactly where
 * splintering is likeliest: a concern she keeps deciding to ignore is
 * resolved, therefore invisible, therefore re-coined tomorrow under a new
 * name. (This matters more since `ignore` became terminal — resolving those
 * rows correctly would otherwise have emptied the pool.)
 *
 * Conservative by construction: the ≥2-shared-token floor means a single
 * shared GENERIC token never merges distinct concerns — "amazon:payment" and
 * "usenet:payment" share only {payment}; "t-mobile:security" and
 * "ecobee:security" share only {security} → both correctly stay separate.
 *
 * The 0.5 floor stays where it was. Loosening it to 0.4 to catch one more
 * Bluelink variant was tried and reverted: at 0.4, "amazon:payment:declined"
 * and "twitch:payment:declined" merge on two GENERIC tokens, which silently
 * fuses unrelated concerns — a worse failure than a splinter row, because a
 * splinter is visible and a false merge is not. Widening the POOL is the
 * structural fix here; the threshold is not the lever.
 */
const ANCHOR_MERGE_JACCARD = () => Number(process.env.HEARTH_KATE_ANCHOR_JACCARD ?? '0.5');

function canonicalize_anchor(raw: string, known: KateObservationRow[]): string {
  const norm = KateObservations.normalize_anchor(raw);
  if (known.some((w) => w.anchor === norm)) return norm; // exact — already stable
  const mine = anchor_tokens(norm);
  if (mine.size === 0) return norm;
  let best: { anchor: string; score: number } | null = null;
  for (const w of known) {
    const theirs = anchor_tokens(w.anchor);
    let shared = 0;
    for (const t of mine) if (theirs.has(t)) shared++;
    if (shared < 2) continue;
    const jaccard = shared / (mine.size + theirs.size - shared);
    if (jaccard >= ANCHOR_MERGE_JACCARD() && (!best || jaccard > best.score)) {
      best = { anchor: w.anchor, score: jaccard };
    }
  }
  return best?.anchor ?? norm;
}

export async function run_reflection(deps: ReflectionDeps, opts: ReflectionOpts): Promise<ReflectionResult> {
  const result: ReflectionResult = {
    enabled: kate_reflection_enabled(),
    ran: false,
    observations: 0,
    new_items: 0,
    recurring: 0,
    suppressed: 0,
    downgraded: 0,
    proposals_filed: [],
    asks_filed: [],
    expired: 0,
  };
  if (!result.enabled) return result;

  const now = opts.now ?? new Date();
  const store = deps.observations ?? new KateObservations(deps.db);

  // ── Gather: the fused picture (cordoned to the recipient) + open watches ──
  let picture = '';
  try {
    picture = compose_working_memory(
      { memory: deps.memory, db: deps.db },
      { user_id: opts.user_id, tier: opts.tier, now, timezone: opts.timezone },
    ).sections.join('\n\n');
  } catch (err) {
    console.error('[kate-reflection] working-memory compose failed (continuing with watches only):', err);
  }
  const watches = store.open_watches(WATCH_INPUT_CAP, opts.user_id);
  // The dedup pool: everything judged in the last month, open or settled.
  // Open watches are a strict subset — they lead the list because they are
  // what she is actively carrying.
  const judged = store.recent_anchors(JUDGED_WINDOW_DAYS, JUDGED_INPUT_CAP, opts.user_id);

  // ── One deep-tier envelope call — fail-CLOSED ──────────────────────────────
  let raw = '';
  try {
    const role = deps.llm.for_role('specialist_deliberation');
    const resp = await role.provider.complete({
      messages: build_reflection_messages({
        picture,
        watches,
        judged,
        local_date: local_iso_date(now, opts.timezone),
      }),
      ...role.defaults,
      temperature: 0.4,
      max_tokens: 1200,
      think: false,
      signal: AbortSignal.timeout(120_000),
    });
    raw = resp?.content ?? '';
  } catch (err) {
    console.error('[kate-reflection] LLM pass failed (fail-closed, nothing filed):', err);
    deps.audit?.({ ...result, error: 'llm_failed' });
    return result;
  }

  let parsed = parse_reflection_envelope(raw);
  if (parsed === null && raw.trim().length > 0) {
    // ONE repair round (2026-07-20): 22% of nightly passes (4/18 audited)
    // died here un-repaired — the pass consumed a full deep-tier read of the
    // house and produced nothing. The repair is the cheapest possible ask:
    // hand the model its own malformed output and demand only the JSON.
    // Still fail-CLOSED if the repair also garbles.
    try {
      const role = deps.llm.for_role('specialist_deliberation');
      const resp = await role.provider.complete({
        messages: [
          {
            role: 'system',
            content:
              'You repair malformed JSON. Reply with ONLY the corrected JSON object — ' +
              'no prose, no code fences, no commentary. Preserve the content; fix the syntax.',
          },
          {
            role: 'user',
            content:
              'This was supposed to be a JSON object of shape ' +
              '{"observations":[{"anchor","summary","rationale","evidence_refs","disposition","recheck_when"}]}. ' +
              `Repair it:\n\n${raw.slice(0, 3_000)}`,
          },
        ] as LLMMessage[],
        ...role.defaults,
        temperature: 0,
        max_tokens: 1200,
        think: false,
        signal: AbortSignal.timeout(60_000),
      });
      parsed = parse_reflection_envelope(resp?.content ?? '');
      if (parsed !== null) result.repaired = true;
    } catch {
      /* repair is best-effort; the fail-closed path below still owns the miss */
    }
  }
  if (parsed === null) {
    result.parse_failed = true;
    console.error('[kate-reflection] envelope parse failed (fail-closed, nothing filed)');
    deps.audit?.({ ...result, error: 'parse_failed' });
    return result;
  }
  result.ran = true;

  // Attention earns rope: her caps this pass are a function of what the owner
  // did with the initiative she already filed. Computed AFTER the LLM call so
  // a throttled pass still costs one read of the house — the budget governs
  // what she FILES, not whether she looks.
  const initiative = score_initiative(store, deps.proposals, { now });
  result.initiative = initiative;
  parsed = parsed.slice(0, initiative.caps.observations);
  result.observations = parsed.length;

  // ── Apply — ledger first, effects only through existing gates ─────────────
  const act_armed = reflection_act_armed();
  for (const o of parsed) {
    // Dedup backstop: snap a freshly-minted anchor onto an existing open watch
    // it clearly restates, so the same concern accrues on ONE row instead of
    // proliferating. Runs before the signature + upsert so both see the
    // canonical anchor. (The prompt's reuse rule is the primary fix.)
    o.anchor = canonicalize_anchor(o.anchor, judged);
    let applied: string = o.disposition;

    if (o.disposition === 'act' && act_armed && result.proposals_filed.length < initiative.caps.proposals) {
      const signature = {
        specialist_id: 'kate',
        kind: 'action_proposal',
        category: 'kate_reflection',
        anchor: KateObservations.normalize_anchor(o.anchor),
      };
      if (!deps.proposals.exists_for_signature(signature)) {
        try {
          const pid = deps.proposals.create({
            specialist_id: 'kate',
            kind: 'action_proposal',
            user_id: cordon_user(opts.tier === 'owner' ? null : opts.user_id),
            execution_kind: 'none',
            payload: {
              followup_kind: 'kate_reflection',
              anchor: KateObservations.normalize_anchor(o.anchor),
              summary: o.summary,
              evidence_refs: o.evidence_refs,
              verb: 'review',
            },
            rationale: o.rationale || o.summary,
            signature,
          });
          result.proposals_filed.push(pid);
          applied = `proposal:${pid}`;
        } catch (err) {
          console.error('[kate-reflection] proposal create failed (observation kept as watch):', err);
          applied = 'watch';
        }
      } else {
        applied = 'watch'; // already offered once — keep watching, don't re-file
      }
    } else if (o.disposition === 'ask' && result.asks_filed.length < initiative.caps.asks) {
      // The ask disposition, IMPLEMENTED (2026-07-20) — previously every ask
      // silently became a watch, so the one disposition that GENERATES owner
      // signal produced none (5 intents in 17 days, all swallowed). An ask
      // files as a self-expiring briefing card (the court-digest shape):
      // her question in plain language, gone on the FYI TTL if ignored —
      // never an approval demand, never queue pressure.
      const signature = {
        specialist_id: 'kate',
        kind: 'briefing',
        category: 'kate_reflection_ask',
        anchor: KateObservations.normalize_anchor(o.anchor),
      };
      if (!deps.proposals.exists_for_signature(signature)) {
        try {
          const pid = deps.proposals.create({
            specialist_id: 'kate',
            kind: 'briefing',
            user_id: cordon_user(opts.tier === 'owner' ? null : opts.user_id),
            execution_kind: 'none',
            payload: {
              topic: `Kate wants your read: ${o.summary.slice(0, 80)}`,
              depth: 'quick',
              body_md:
                `**What I'm seeing:** ${o.summary}\n\n` +
                (o.rationale ? `**Why I'm asking:** ${o.rationale}\n\n` : '') +
                'Tell me in chat — one line is plenty. This card expires on its own ' +
                "if it's not worth your time.",
            },
            rationale: o.rationale || o.summary,
            signature,
          });
          result.asks_filed.push(pid);
          applied = `ask:${pid}`;
        } catch (err) {
          console.error('[kate-reflection] ask create failed (kept as watch):', err);
          applied = 'watch';
        }
      } else {
        applied = 'watch'; // already asked once — don't nag
      }
    } else if (o.disposition === 'act' || o.disposition === 'investigate' || o.disposition === 'ask') {
      // Watch-only soak (or over the per-pass cap): record intent, apply watch.
      applied = 'watch';
      result.downgraded++;
    }

    const up = store.upsert({
      anchor: o.anchor,
      summary: o.summary,
      rationale: o.rationale,
      evidence_refs: o.evidence_refs,
      intended_disposition: o.disposition,
      applied_disposition: applied,
      recheck_when: o.recheck_when ?? null,
      private_to: opts.tier === 'owner' ? null : opts.user_id,
      now,
    });
    if (up.suppressed) result.suppressed++;
    else if (up.is_new) result.new_items++;
    else result.recurring++;
  }

  result.expired = store.expire_stale(STALE_WATCH_DAYS, now);
  deps.audit?.({ ...result });
  return result;
}

/**
 * Compact watch-list render for Kate's DELIBERATION context (the 07:00 brief
 * pass) — her open watches, so the brief's `watching` section is fed by her
 * own ledger instead of being re-derived from scratch each morning. Cordoned
 * to the brief recipient. Empty string when off/empty (byte-identical ctx).
 */
export function render_own_watchlist(db: Database, for_user: string, cap = 8): string {
  if (!kate_reflection_enabled()) return '';
  try {
    const store = new KateObservations(db);
    const watches = store.open_watches(cap, for_user);
    if (watches.length === 0) return '';
    return watches
      .map((w) => `- ${w.summary} (watching since ${w.ts_created.slice(0, 10)}, seen ${w.times_seen}x)`)
      .join('\n');
  } catch (err) {
    console.error('[kate-reflection] watchlist render failed (fail-open):', err);
    return '';
  }
}
