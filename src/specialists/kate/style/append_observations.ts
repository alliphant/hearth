import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MemoryClient } from '@memory/client';
import { local_iso_date } from '@core/time';

const RAW_PATH = 'Knowledge/Kate/jasper_style.md';
const MAX_ENTRIES = 200;
const BULLET_RE = /^- \*\*\d{4}-\d{2}-\d{2}\*\* —/gm;

const HEADER =
  `# Jasper's communication style — Kate's notes\n\n` +
  `Dated bullets. Kate appends as she learns his voice — from edits she's\n` +
  `seen on her drafts, from his in-conversation corrections, and from the\n` +
  `passive observation pass over recent turns.\n` +
  `Cap: ${MAX_ENTRIES} entries; oldest rotates out.\n\n`;

export interface AppendResult {
  note_path: string;
  appended: number;
  entries_after: number;
  rotated: number;
}

/**
 * Append one or more dated observations to Knowledge/Kate/jasper_style.md.
 * Rotates the oldest entries out when the file would exceed MAX_ENTRIES.
 * Idempotent at the (date, text) tuple level — duplicate (same date AND
 * same observation text) is silently dropped so the observer can run
 * repeatedly without bloating the log.
 */
export function append_style_observations(
  memory: MemoryClient,
  vault_root: string,
  observations: string[],
  now: Date,
  tz?: string,
): AppendResult {
  const today = local_iso_date(now, tz);
  const abs = resolve(vault_root, RAW_PATH);

  let body = existsSync(abs) ? readFileSync(abs, 'utf8') : HEADER;
  // Drop any existing observation text equal to one we're about to add
  // (regardless of date) so re-runs don't duplicate.
  const existing_texts = new Set<string>();
  for (const line of body.split('\n')) {
    const m = line.match(/^- \*\*\d{4}-\d{2}-\d{2}\*\* — (.*)$/);
    if (m) existing_texts.add(m[1]!.trim());
  }

  const fresh = observations
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && !existing_texts.has(o));

  if (fresh.length === 0) {
    const count = (body.match(BULLET_RE) ?? []).length;
    return { note_path: RAW_PATH, appended: 0, entries_after: count, rotated: 0 };
  }

  const new_lines = fresh.map((o) => `- **${today}** — ${o}`).join('\n');
  body = body.trimEnd() + '\n' + new_lines + '\n';

  let rotated = 0;
  while (true) {
    const matches = body.match(BULLET_RE) ?? [];
    if (matches.length <= MAX_ENTRIES) break;
    const idx = body.indexOf(matches[0]!);
    const next = body.indexOf('\n- **', idx + 1);
    if (next < 0) break;
    body = body.slice(0, idx) + body.slice(next + 1);
    rotated += 1;
  }

  // Raw style observations about Jasper are owner-sensitive captain state.
  memory.upsert_note(RAW_PATH, { private_to: 'owner' }, body);
  const after = (body.match(BULLET_RE) ?? []).length;
  return { note_path: RAW_PATH, appended: fresh.length, entries_after: after, rotated };
}
