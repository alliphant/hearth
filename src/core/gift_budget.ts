/**
 * gift_budget (Phase 3, 2026-06-20) — the LEARNED per-person gift budget + the
 * pure People-accretion helpers behind Kate's birthday→gift loop.
 *
 * The budget is DERIVED from a person's own recorded gift spend (Person note
 * `gift_history[].cost`) — never a hard-coded constant (Jasper's "$50-75" was an
 * example, not a default). With no recorded spend the budget is `null` and the
 * basis says "ask" — Kate then asks rather than inventing a number. The richer
 * cross-gift narrative lives in the owner's `gift_budget` user_model facet
 * (user_model.ts); this is the precise per-recipient figure the trigger reads.
 *
 * Pure + deterministic (no LLM, no clock beyond the injected `now`), so the gift
 * loop's budget math is fully smoke-tested.
 */

export interface GiftHistoryEntry {
  date: string;
  what: string;
  cost?: number;
  occasion?: string;
  reception?: string;
}

export interface LearnedGiftBudget {
  /** The central learned figure (median of recent gift costs); null when no spend recorded. */
  amount: number | null;
  /** Observed low/high of the sample — a real range, not a guessed band. */
  low: number | null;
  high: number | null;
  currency: string;
  /** Human-readable explanation of how it was learned (or why it's absent). */
  basis: string;
  confidence: 'none' | 'low' | 'med' | 'high';
  /** How many costed gifts informed it. */
  sample_n: number;
}

const RECENT_SAMPLE = 5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/**
 * Derive a per-person gift budget from the recipient's recorded gift spend.
 * Uses the most recent `RECENT_SAMPLE` costed gifts (newest by date), so the
 * figure tracks current generosity, not a lifetime average.
 */
export function compute_learned_gift_budget(
  gift_history: GiftHistoryEntry[] | undefined,
  opts: { currency?: string } = {},
): LearnedGiftBudget {
  const currency = opts.currency ?? 'USD';
  const costed = (gift_history ?? [])
    .filter((g) => typeof g.cost === 'number' && Number.isFinite(g.cost) && g.cost! > 0)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')) // newest first
    .slice(0, RECENT_SAMPLE);

  if (costed.length === 0) {
    return {
      amount: null, low: null, high: null, currency,
      basis: 'no recorded gift spend yet — ask what to spend',
      confidence: 'none', sample_n: 0,
    };
  }

  const costs = costed.map((g) => g.cost!);
  const amount = median(costs);
  const low = Math.min(...costs);
  const high = Math.max(...costs);
  const confidence: LearnedGiftBudget['confidence'] = costed.length >= 4 ? 'high' : costed.length >= 2 ? 'med' : 'low';
  return {
    amount, low, high, currency,
    basis: `median of ${costed.length} recorded gift${costed.length === 1 ? '' : 's'} (${currency} ${low}–${high})`,
    confidence, sample_n: costed.length,
  };
}

/** A short, human display of a learned budget for a proposal rationale / task. */
export function format_gift_budget(b: LearnedGiftBudget): string {
  if (b.amount === null) return 'budget: not set yet (ask)';
  return b.low === b.high
    ? `budget: ~${b.currency} ${b.amount}`
    : `budget: ~${b.currency} ${b.amount} (range ${b.low}–${b.high})`;
}

const LIST_CAP = 40;

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Merge new entries into a likes/dislikes list, case-insensitively deduped + capped. */
export function accrete_string_list(existing: string[] | undefined, add: string[]): string[] {
  const out = [...(existing ?? [])];
  const seen = new Set(out.map(norm));
  for (const raw of add) {
    const v = raw.trim();
    if (!v || seen.has(norm(v))) continue;
    seen.add(norm(v));
    out.push(v);
  }
  return out.slice(-LIST_CAP);
}

/** Append a gift to gift_history, deduped on (date, what), capped. */
export function accrete_gift_history(
  existing: GiftHistoryEntry[] | undefined,
  entry: GiftHistoryEntry,
): GiftHistoryEntry[] {
  const out = [...(existing ?? [])];
  const key = (g: GiftHistoryEntry) => `${g.date} ${norm(g.what)}`;
  const seen = new Set(out.map(key));
  if (!seen.has(key(entry))) out.push(entry);
  return out.slice(-LIST_CAP);
}
