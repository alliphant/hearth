/**
 * PR shelf — Astrid's per-(user, workout-type) personal-record tracker.
 *
 * Stored as plain markdown in the vault at
 *   users/<user_id>/astrid/records/<workout-type>.md
 *
 * Three metrics tracked v0:
 *   - longest_seconds          duration of the session
 *   - longest_distance_m       distance covered (null for strength/yoga)
 *   - highest_active_kcal      active calories burned
 *
 * Format on disk (a real example for `cycling`):
 *
 *   ---
 *   type: trainer_pr_shelf
 *   workout_type: cycling
 *   user_id: jasper
 *   updated: 2026-05-27T18:30:00Z
 *   ---
 *
 *   # cycling — Personal Records
 *
 *   ## Longest session
 *   - **78 min** on 2026-05-15
 *   - prior: 65 min on 2026-04-22
 *
 *   ## Highest active calories
 *   - **920 kcal** on 2026-05-15
 *   - prior: 810 kcal on 2026-04-22
 *
 *   ## Longest distance
 *   - **24.3 km** on 2026-05-15
 *   - prior: 19.8 km on 2026-04-22
 *
 * The "prior" line lets Astrid say "you just beat your PR by N minutes"
 * without needing a second lookup. When a record stands without being
 * broken, the prior line stays the same.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse as parse_yaml } from 'yaml';

/**
 * Floor below which a completed session is not "meaningful": it never
 * touches the PR shelf and never earns a session-end push. The
 * motivating class is phantom sessions — auto-detected walks and
 * aborted starts post end packets with near-zero duration. One of
 * those wrote a ~0-min cycling "PR" on 2026-06-01, which then served
 * as the midpoint/final_push duration baseline in live_throttle and
 * fired "Halfway through" 30 seconds into a 106-minute ride
 * (session 06FB8Q5RZAVM5298YTW7NNJBFC, 2026-06-10).
 */
export const MIN_MEANINGFUL_SESSION_S = 120;

export function is_meaningful_session(duration_s: number): boolean {
  return Number.isFinite(duration_s) && duration_s >= MIN_MEANINGFUL_SESSION_S;
}

export interface PRRecord {
  value: number;
  date: string;
  prior_value: number | null;
  prior_date: string | null;
}

export interface PRShelf {
  user_id: string;
  workout_type: string;
  updated: string;
  longest_seconds: PRRecord | null;
  longest_distance_m: PRRecord | null;
  highest_active_kcal: PRRecord | null;
}

export interface CompletedWorkout {
  workout_type: string;
  ended_at: string; // ISO timestamp
  duration_s: number;
  active_kcal: number;
  total_distance_m: number | null;
}

function shelf_rel_path(user_id: string, workout_type: string): string {
  return `users/${user_id}/astrid/records/${workout_type}.md`;
}

function format_date(iso: string): string {
  return iso.slice(0, 10);
}

function format_value(metric: 'longest_seconds' | 'longest_distance_m' | 'highest_active_kcal', value: number): string {
  switch (metric) {
    case 'longest_seconds':
      return `${Math.round(value / 60)} min`;
    case 'longest_distance_m':
      return `${(value / 1000).toFixed(2)} km`;
    case 'highest_active_kcal':
      return `${Math.round(value)} kcal`;
  }
}

const SECTION_HEADERS: Record<'longest_seconds' | 'longest_distance_m' | 'highest_active_kcal', string> = {
  longest_seconds: 'Longest session',
  longest_distance_m: 'Longest distance',
  highest_active_kcal: 'Highest active calories',
};

export function read_shelf(vault_root: string, user_id: string, workout_type: string): PRShelf | null {
  const abs = resolve(vault_root, shelf_rel_path(user_id, workout_type));
  if (!existsSync(abs)) return null;
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const fm_match = /^---\n([\s\S]+?)\n---/.exec(text);
  if (!fm_match) return null;
  let fm: { user_id?: string; workout_type?: string; updated?: string; records?: Record<string, unknown> } = {};
  try {
    fm = parse_yaml(fm_match[1]!) ?? {};
  } catch {
    return null;
  }
  const body = text.slice(fm_match[0].length);

  // Machine-owned raw values live in frontmatter (written since
  // 2026-06-10). The body render is display-rounded ("106 min"), so
  // re-deriving seconds from it loses precision — a sub-30s session
  // renders "0 min" and reads back as a 0-second baseline. Prefer the
  // frontmatter records when present; the body regex survives only as
  // the fallback for legacy shelves written before the records block.
  const fm_records = fm.records != null && typeof fm.records === 'object' ? fm.records : null;
  const parse_fm_record = (v: unknown): PRRecord | null => {
    if (v == null || typeof v !== 'object') return null;
    const r = v as Record<string, unknown>;
    if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return null;
    if (typeof r.date !== 'string') return null;
    return {
      value: r.value,
      date: r.date,
      prior_value: typeof r.prior_value === 'number' && Number.isFinite(r.prior_value) ? r.prior_value : null,
      prior_date: typeof r.prior_date === 'string' ? r.prior_date : null,
    };
  };

  // Parse the three sections — each is "## Longest session\n- **N min** on YYYY-MM-DD\n- prior: M min on YYYY-MM-DD".
  const parse_section = (
    header: string,
    metric: 'longest_seconds' | 'longest_distance_m' | 'highest_active_kcal',
  ): PRRecord | null => {
    const sec_re = new RegExp(`## ${header}\\s*\\n- \\*\\*([0-9.]+)[^*]*\\*\\*\\s+on\\s+(\\d{4}-\\d{2}-\\d{2})(?:\\s*\\n- prior:\\s+([0-9.]+)[^o]*on\\s+(\\d{4}-\\d{2}-\\d{2}))?`);
    const m = sec_re.exec(body);
    if (!m) return null;
    // Reverse the format_value logic to get the raw stored numeric.
    // Cleaner: re-derive from the display number by reversing the unit.
    const raw = Number.parseFloat(m[1]!);
    const value =
      metric === 'longest_seconds' ? raw * 60 :
      metric === 'longest_distance_m' ? raw * 1000 :
      raw;
    const prior_raw = m[3] ? Number.parseFloat(m[3]) : null;
    const prior_value =
      prior_raw == null ? null :
      metric === 'longest_seconds' ? prior_raw * 60 :
      metric === 'longest_distance_m' ? prior_raw * 1000 :
      prior_raw;
    return {
      value,
      date: m[2]!,
      prior_value,
      prior_date: m[4] ?? null,
    };
  };

  return {
    user_id: fm.user_id ?? user_id,
    workout_type: fm.workout_type ?? workout_type,
    updated: fm.updated ?? new Date().toISOString(),
    longest_seconds: fm_records
      ? parse_fm_record(fm_records.longest_seconds)
      : parse_section(SECTION_HEADERS.longest_seconds, 'longest_seconds'),
    longest_distance_m: fm_records
      ? parse_fm_record(fm_records.longest_distance_m)
      : parse_section(SECTION_HEADERS.longest_distance_m, 'longest_distance_m'),
    highest_active_kcal: fm_records
      ? parse_fm_record(fm_records.highest_active_kcal)
      : parse_section(SECTION_HEADERS.highest_active_kcal, 'highest_active_kcal'),
  };
}

function render_section(
  metric: 'longest_seconds' | 'longest_distance_m' | 'highest_active_kcal',
  record: PRRecord | null,
): string {
  if (!record) return '';
  const header = SECTION_HEADERS[metric];
  const value_str = format_value(metric, record.value);
  const lines = [`## ${header}`, `- **${value_str}** on ${record.date}`];
  if (record.prior_value != null && record.prior_date) {
    lines.push(`- prior: ${format_value(metric, record.prior_value)} on ${record.prior_date}`);
  }
  return lines.join('\n');
}

function render_shelf(shelf: PRShelf): string {
  // Raw records ride the frontmatter as JSON flow mappings (valid YAML)
  // so read_shelf round-trips exact values; the body below is the
  // human-readable display render.
  const fm_record = (record: PRRecord | null): string => (record ? JSON.stringify(record) : 'null');
  const fm = [
    '---',
    'type: trainer_pr_shelf',
    `user_id: ${shelf.user_id}`,
    `workout_type: ${shelf.workout_type}`,
    `updated: ${shelf.updated}`,
    'records:',
    `  longest_seconds: ${fm_record(shelf.longest_seconds)}`,
    `  longest_distance_m: ${fm_record(shelf.longest_distance_m)}`,
    `  highest_active_kcal: ${fm_record(shelf.highest_active_kcal)}`,
    '---',
    '',
    `# ${shelf.workout_type} — Personal Records`,
    '',
  ].join('\n');
  const sections = (['longest_seconds', 'longest_distance_m', 'highest_active_kcal'] as const)
    .map((m) => render_section(m, shelf[m]))
    .filter((s) => s.length > 0)
    .join('\n\n');
  return `${fm}${sections}\n`;
}

/**
 * Apply a completed workout to the shelf. Returns the updated shelf
 * and the list of metrics that were beaten (so the caller can format
 * a "you just beat your X PR by N" coaching note).
 */
export function update_shelf(
  vault_root: string,
  user_id: string,
  completed: CompletedWorkout,
): { shelf: PRShelf; broken: Array<'longest_seconds' | 'longest_distance_m' | 'highest_active_kcal'> } {
  const existing = read_shelf(vault_root, user_id, completed.workout_type);

  // Degenerate sessions never touch the shelf — see MIN_MEANINGFUL_SESSION_S.
  if (!is_meaningful_session(completed.duration_s)) {
    return {
      shelf: existing ?? {
        user_id,
        workout_type: completed.workout_type,
        updated: new Date().toISOString(),
        longest_seconds: null,
        longest_distance_m: null,
        highest_active_kcal: null,
      },
      broken: [],
    };
  }

  const broken: Array<'longest_seconds' | 'longest_distance_m' | 'highest_active_kcal'> = [];
  const date = format_date(completed.ended_at);
  const now = new Date().toISOString();

  function bump(
    metric: 'longest_seconds' | 'longest_distance_m' | 'highest_active_kcal',
    value: number | null,
    current: PRRecord | null,
  ): PRRecord | null {
    if (value == null || !Number.isFinite(value) || value <= 0) return current;
    if (!current) {
      return { value, date, prior_value: null, prior_date: null };
    }
    if (value > current.value) {
      broken.push(metric);
      return { value, date, prior_value: current.value, prior_date: current.date };
    }
    return current;
  }

  const next: PRShelf = {
    user_id,
    workout_type: completed.workout_type,
    updated: now,
    longest_seconds: bump('longest_seconds', completed.duration_s, existing?.longest_seconds ?? null),
    longest_distance_m: bump('longest_distance_m', completed.total_distance_m, existing?.longest_distance_m ?? null),
    highest_active_kcal: bump('highest_active_kcal', completed.active_kcal, existing?.highest_active_kcal ?? null),
  };

  // Only write the file when something actually changed (broken record
  // OR first-time write) — avoids noise in git history / chokidar
  // re-projection for an unchanged shelf.
  const wrote_anything =
    broken.length > 0 ||
    existing === null ||
    next.longest_seconds !== existing.longest_seconds ||
    next.longest_distance_m !== existing.longest_distance_m ||
    next.highest_active_kcal !== existing.highest_active_kcal;
  if (wrote_anything) {
    const abs = resolve(vault_root, shelf_rel_path(user_id, completed.workout_type));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, render_shelf(next), 'utf8');
  }

  return { shelf: next, broken };
}
