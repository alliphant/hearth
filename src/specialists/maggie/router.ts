/**
 * router.ts — Maggie-specific HTTP routes.
 *
 * Currently hosts the Tautulli webhook endpoint at /api/maggie/plex_event.
 * Tautulli's notification agent POSTs here on play_stop events (and any
 * other trigger configured in Tautulli's UI); the handler filters to
 * completed plays and writes them into Maggie's memory.md taste log so
 * she sees "Jasper finished X" without polling.
 *
 * Tautulli config (one-time):
 *   Settings → Notification Agents → Add → Webhook
 *   Webhook URL: http://your-always-on-host.local:7700/api/maggie/plex_event
 *   Webhook Method: POST
 *   Triggers: ✓ Watched (or ✓ Playback Stop with the threshold below)
 *   JSON Data (Watched tab):
 *     {
 *       "action": "watched",
 *       "user": "{user}",
 *       "media_type": "{media_type}",
 *       "title": "{title}",
 *       "grandparent_title": "{grandparent_title}",
 *       "parent_title": "{parent_title}",
 *       "year": "{year}",
 *       "percent_complete": "{percent_complete}",
 *       "rating_key": "{rating_key}",
 *       "library_name": "{library_name}"
 *     }
 *   Conditions: User is "allistar" (so the household's other users
 *               don't pollute Jasper's taste log)
 *
 * The handler is unauthenticated by default. Tautulli + Hearth are both
 * on the always-on host's LAN; if you ever expose the always-on host externally, add a shared-secret
 * query param check here. Audit log records every event so misuse is
 * visible.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { local_iso_date } from '@core/time';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '@app/events';

export interface MaggieRouterDeps {
  vault_root: string;
  memory: MemoryClient;
  events?: AppEventBus;
  /** Tautulli username filter — defaults to PLEX_USER env. Events from other users are dropped. */
  jasper_username?: string;
}

const PayloadSchema = z.object({
  action: z.string().optional(),
  user: z.string().optional(),
  media_type: z.string().optional(),
  title: z.string().optional(),
  grandparent_title: z.string().optional(),
  parent_title: z.string().optional(),
  year: z.union([z.string(), z.number()]).optional(),
  percent_complete: z.union([z.string(), z.number()]).optional(),
  rating_key: z.union([z.string(), z.number()]).optional(),
  library_name: z.string().optional(),
});

type Payload = z.infer<typeof PayloadSchema>;

const REL_PATH = 'Knowledge/Maggie/memory.md';
const SECTION_TITLE = "## Jasper's media mentions";
const MAX_PER_SECTION = 200;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function format_taste_line(p: Payload, now: Date): string {
  // Movie:   "Jasper finished <title> (<year>) — finished — <date>"
  // TV:      "Jasper finished <grandparent> — <title> (S<season>E<episode>) — <date>"
  // Music:   "Jasper played <grandparent> — <parent_title> — <title> — <date>"
  // Other:   "Jasper consumed <type> <title> — <date>"
  const date = local_iso_date(now);
  const mt = (p.media_type ?? '').toLowerCase();
  const title = p.title ?? '';
  const yr = num(p.year);
  if (mt === 'movie') {
    return `Jasper finished ${title}${yr ? ` (${yr})` : ''} — Plex flagged finished — ${date}`;
  }
  if (mt === 'episode') {
    const show = p.grandparent_title ?? '';
    const season = p.parent_title ?? '';
    return `Jasper finished ${show} — ${season ? season + ': ' : ''}${title} — ${date}`;
  }
  if (mt === 'track') {
    const artist = p.grandparent_title ?? '';
    const album = p.parent_title ?? '';
    return `Jasper played ${artist}${album ? ` (${album})` : ''} — ${title} — ${date}`;
  }
  return `Jasper consumed ${mt || 'media'} — ${title} — ${date}`;
}

function append_to_memory(vault_root: string, line: string, now: Date): void {
  const abs = resolve(vault_root, REL_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  let content = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  if (!content) {
    content =
      `# Maggie's memory\n\n` +
      `Working memory for Hearth's Media & Collection Manager. Auto-` +
      `maintained by the \`update_maggie_memory\` tool and the Tautulli ` +
      `play-event webhook. Jasper can also edit by hand if he wants.\n`;
  }
  if (!content.includes(SECTION_TITLE)) {
    content +=
      `\n${SECTION_TITLE}\n\n_One-line captures whenever Jasper mentions ` +
      `media — watching, saw, want to see, loved, hated. Newest first._\n`;
  }
  // Insert just after the section heading + intro paragraph, before any
  // existing entries.
  const heading_idx = content.indexOf(SECTION_TITLE);
  const after_heading = content.indexOf('\n', heading_idx) + 1;
  const next_h2_after = content.slice(after_heading).search(/^## /m);
  const section_end = next_h2_after < 0 ? content.length : after_heading + next_h2_after;
  let section_body = content.slice(after_heading, section_end);
  const intro_match = section_body.match(/^(\s*\n)?_[^_]+_\n/);
  const intro_chunk = intro_match ? intro_match[0] : '';
  let entries = section_body.slice(intro_chunk.length);

  const entry = `\n### ${now.toISOString()}\n\n${line}\n`;
  if (!entries.startsWith('\n')) entries = '\n' + entries;
  entries = `\n${entry}` + entries;

  // Cap to MAX_PER_SECTION entries (count "### " headers).
  const headers = [...entries.matchAll(/^### /gm)];
  if (headers.length > MAX_PER_SECTION) {
    const cutoff = headers[MAX_PER_SECTION];
    if (cutoff?.index !== undefined) entries = entries.slice(0, cutoff.index);
  }

  const new_section = intro_chunk + entries;
  const new_content = content.slice(0, after_heading) + new_section + content.slice(section_end);
  writeFileSync(abs, new_content, 'utf8');
}

export function create_maggie_router(deps: MaggieRouterDeps): Hono {
  const app = new Hono({ strict: false });
  const jasper = deps.jasper_username ?? process.env.PLEX_USER ?? '';

  app.post('/plex_event', async (c) => {
    const intent_id = ulid();
    // Capture raw body first so we can log it on any parse failure.
    let body_text = '';
    try {
      body_text = await c.req.text();
    } catch (err) {
      console.warn(`[maggie/plex_event] body read failed:`, err);
    }
    if (!body_text) {
      console.warn(`[maggie/plex_event] empty body received`);
      return c.json({ ok: false, error: 'empty body — Tautulli sent no JSON. Check the JSON Data field on the Watched tab.' }, 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body_text);
    } catch (err) {
      console.warn(
        `[maggie/plex_event] invalid JSON (${body_text.length} chars). First 300:`,
        body_text.slice(0, 300),
      );
      return c.json({
        ok: false,
        error: `invalid JSON body — first 200 chars: ${body_text.slice(0, 200)}`,
      }, 400);
    }
    const parsed = PayloadSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[maggie/plex_event] schema mismatch. Body:`, body_text.slice(0, 300));
      return c.json({ ok: false, error: parsed.error.message }, 400);
    }
    const p = parsed.data;
    const now = new Date();

    // Filter: only Jasper's plays (drop other household users).
    if (jasper && p.user && p.user !== jasper) {
      deps.memory.log_action({
        intent_id,
        agent: 'tautulli',
        tool_name: 'plex_event',
        tool_input: { action: p.action, user: p.user, media_type: p.media_type, title: p.title },
        execution_result: { skipped: 'wrong user' },
      });
      return c.json({ ok: true, skipped: 'wrong user' });
    }

    // Filter: only "completed" plays. Tautulli's 'watched' trigger fires
    // at the configured "watched percent" threshold (default 90). If
    // percent_complete is < 80 we treat it as a partial/skip.
    const pct = num(p.percent_complete);
    if (p.action !== 'watched' && pct != null && pct < 80) {
      deps.memory.log_action({
        intent_id,
        agent: 'tautulli',
        tool_name: 'plex_event',
        tool_input: { action: p.action, percent: pct, title: p.title },
        execution_result: { skipped: 'partial play' },
      });
      return c.json({ ok: true, skipped: 'partial play' });
    }

    // Write the taste-log entry.
    const line = format_taste_line(p, now);
    try {
      append_to_memory(deps.vault_root, line, now);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.memory.log_action({
        intent_id,
        agent: 'tautulli',
        tool_name: 'plex_event',
        tool_input: { title: p.title, media_type: p.media_type },
        error: `memory write failed: ${msg}`,
      });
      return c.json({ ok: false, error: msg }, 500);
    }

    const audit_id = deps.memory.log_action({
      intent_id,
      agent: 'tautulli',
      tool_name: 'plex_event',
      tool_input: {
        action: p.action,
        user: p.user,
        media_type: p.media_type,
        title: p.title,
        grandparent_title: p.grandparent_title,
        parent_title: p.parent_title,
        percent: pct,
      },
      execution_result: { wrote_line: line.slice(0, 200) },
    });

    return c.json({ ok: true, intent_id, audit_id, wrote: line });
  });

  // Test endpoint so we can verify the route is mounted without
  // configuring Tautulli first.
  app.get('/plex_event/ping', (c) => c.json({ ok: true, expected_user: jasper, route: 'POST /api/maggie/plex_event' }));

  return app;
}
