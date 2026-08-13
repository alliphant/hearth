/**
 * Smoke for Maggie's Listening pane (Tier 1 #1) + check_show_status
 * (Tier 1 #2). Self-contained: temp vault + DB, seeded upcoming_shows
 * + artist_watchlist.md, stubbed Plex / *arr (read through the
 * ToolRegistry; missing tools take the graceful-degrade branch).
 *
 * Covers:
 *   - schema bump: upcoming_shows table created cleanly, with the
 *     ticket_status check constraint
 *   - parse_ticket_status returns the right enum for the four canonical
 *     page shapes (sold out, resale only, low availability, available,
 *     unknown)
 *   - check_show_status upserts (idempotent on artist/venue/date) and
 *     stamps ticket_status from the parsed markdown
 *   - compose_pane('maggie') returns a listening doc with four list
 *     blocks in order: Coming to town, On your radar, Hitting your
 *     Plex, New in the library
 *   - Coming to town filters sold_out and resale_only rows
 *   - On your radar reads the artist watchlist top-by-affinity
 *   - Plex + library sections degrade to a one-line "unavailable" item
 *     when the underlying tools aren't registered
 */

import { mkdirSync, rmSync, writeFileSync, mkdirSync as mkdir2 } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ConfigLLMRouter } from '../src/core/router';
import { ToolRegistry } from '../src/core/tool_registry';
import { compose_pane, type PaneDeps } from '../src/core/specialist_pane';
import {
  create as create_check_show_status,
  parse_ticket_status,
} from '../src/specialists/maggie/tools/check_show_status';
import type { LoadedSpecialist } from '../src/core/specialist';
import type { ToolContext, Tool } from '../src/core/tool';
import type { ToolDeps } from '../src/core/tool_deps';
import { z } from 'zod';

interface Env {
  vault_root: string;
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  llm: ConfigLLMRouter;
  registry: ToolRegistry;
  cleanup: () => void;
}

function init_env(): Env {
  const vault_root = resolve(tmpdir(), `hearth-listening-smoke-${Date.now()}`);
  const db_path = resolve(vault_root, 'data', 'smoke.db');
  mkdirSync(vault_root, { recursive: true });
  mkdirSync(resolve(vault_root, 'data'), { recursive: true });
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root, db });
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://localhost:11434',
  });
  const registry = new ToolRegistry();
  return {
    vault_root,
    db,
    memory,
    llm,
    registry,
    cleanup() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(vault_root, { recursive: true, force: true });
    },
  };
}

function seed_watchlist(vault_root: string): void {
  const dir = resolve(vault_root, 'Knowledge/Maggie');
  mkdir2(dir, { recursive: true });
  // Three artists, descending affinity. The watchlist parser tolerates
  // the v2 8-column format used by the live tool.
  const md =
    '# Artist watchlist\n\n' +
    '_seeded by smoke_\n\n' +
    '| Artist | Affinity | Source | Added | Last checked | Tour page | Past shows | Notes |\n' +
    '|---|---|---|---|---|---|---|---|\n' +
    '| Phoebe Bridgers | 9 | manual | 2026-05-01 | 2026-05-28 | https://phoebefuckingbridgers.com | 2024-09-12 Red Rocks (Morrison) | seeded |\n' +
    '| Khruangbin | 8 | manual | 2026-05-01 |  |  |  | seeded |\n' +
    '| Wet Leg | 7 | auto | 2026-05-01 |  |  |  | seeded |\n';
  writeFileSync(resolve(dir, 'artist_watchlist.md'), md, 'utf8');
}

function seed_shows(db: import('bun:sqlite').Database): void {
  // Five upcoming shows: 3 visible (available/low/unknown), 1 sold_out
  // (filtered), 1 resale_only (filtered).
  const now = new Date().toISOString();
  const future = (days: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const stmt = db.prepare(
    `INSERT INTO upcoming_shows (
       id, user_id, artist, venue, city, show_date,
       tickets_url, source_url, ticket_status, ticket_status_checked_at,
       affinity_at_capture, rationale, first_seen_at, last_seen_at
     ) VALUES (
       @id, 'jasper', @artist, @venue, @city, @show_date,
       @tickets_url, NULL, @status, @checked_at,
       @affinity, @rationale, @now, @now
     )`,
  );
  stmt.run({
    '@id': ulid(),
    '@artist': 'Khruangbin',
    '@venue': 'Riverbend Amphitheatre',
    '@city': 'Glenhaven, CO',
    '@show_date': future(20),
    '@tickets_url': 'https://example.com/khruangbin',
    '@status': 'available',
    '@checked_at': now,
    '@affinity': 8,
    '@rationale': 'Heavy rotation on Plex this month',
    '@now': now,
  });
  stmt.run({
    '@id': ulid(),
    '@artist': 'Wet Leg',
    '@venue': 'Midtown Theater',
    '@city': 'Pleasantville, CO',
    '@show_date': future(45),
    '@tickets_url': null,
    '@status': 'low',
    '@checked_at': now,
    '@affinity': 7,
    '@rationale': 'Watchlist add from auto signal',
    '@now': now,
  });
  stmt.run({
    '@id': ulid(),
    '@artist': 'Phoebe Bridgers',
    '@venue': 'Red Rocks',
    '@city': 'Morrison, CO',
    '@show_date': future(10),
    '@tickets_url': 'https://example.com/phoebe',
    '@status': 'sold_out',
    '@checked_at': now,
    '@affinity': 9,
    '@rationale': 'Top-tier affinity',
    '@now': now,
  });
  stmt.run({
    '@id': ulid(),
    '@artist': 'Big Thief',
    '@venue': 'Mission Ballroom',
    '@city': 'Denver, CO',
    '@show_date': future(60),
    '@tickets_url': 'https://example.com/bigthief',
    '@status': 'resale_only',
    '@checked_at': now,
    '@affinity': 7,
    '@rationale': 'Adjacent to recent listening',
    '@now': now,
  });
  stmt.run({
    '@id': ulid(),
    '@artist': 'Animal Collective',
    '@venue': 'The Bluebird Theater',
    '@city': 'Denver, CO',
    '@show_date': future(33),
    '@tickets_url': 'https://example.com/animal',
    '@status': 'unknown',
    '@checked_at': now,
    '@affinity': 6,
    '@rationale': 'Catalog deep-cut play',
    '@now': now,
  });
}

function make_spec(pane_kind: 'listening' | null): LoadedSpecialist {
  return {
    id: 'maggie',
    name: 'Maggie',
    role: 'Media & Collection Manager',
    avatar: null,
    voice: 'warm-technical',
    aliases: [],
    persona: '',
    knowledge_scope: [],
    granted: new Set(),
    proactive: { mode: 'batched', awareness_hz: 0.5, interrupt_threshold: 'low' },
    discretion: undefined,
    pane_kind,
    max_tool_rounds: 14,
  } as unknown as LoadedSpecialist;
}

function pane_deps(env: Env): PaneDeps {
  return {
    vault_root: env.vault_root,
    memory: env.memory,
    llm: env.llm,
    tool_registry: env.registry,
  };
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const ok = (msg: string): void => {
    console.log(`  ✓ ${msg}`);
    passed++;
  };
  const fail = (msg: string, detail?: unknown): void => {
    console.log(`  ✗ ${msg}`, detail ?? '');
    failed++;
  };

  console.log('\n── parse_ticket_status ─────────────────────────────────');
  {
    const r1 = parse_ticket_status('Tickets sold out. Check back later.');
    r1.status === 'sold_out' ? ok('parses "sold out" → sold_out') : fail('sold_out parse', r1);

    const r2 = parse_ticket_status('Only resale only — try StubHub.');
    r2.status === 'resale_only' ? ok('parses "resale only" → resale_only') : fail('resale_only parse', r2);

    const r3 = parse_ticket_status('Last 5 tickets left! Limited availability.');
    r3.status === 'low' ? ok('parses "last 5 tickets" → low') : fail('low parse', r3);

    const r4 = parse_ticket_status('Buy Tickets — On Sale Now.');
    r4.status === 'available' ? ok('parses "buy tickets" → available') : fail('available parse', r4);

    const r5 = parse_ticket_status('A jazz quartet plays the city tonight.');
    r5.status === 'unknown' ? ok('no signals → unknown') : fail('unknown parse', r5);

    const r6 = parse_ticket_status('Sold out — buy tickets at the door if any drops.');
    r6.status === 'sold_out' ? ok('sold_out beats co-present "buy tickets"') : fail('precedence', r6);
  }

  console.log('\n── check_show_status (no fetch — neither URL) ──────────');
  {
    const env = init_env();
    try {
      seed_watchlist(env.vault_root);
      const deps_bag: Partial<ToolDeps> = {
        db: env.db,
        vault_root: env.vault_root,
        memory: env.memory,
        llm: env.llm,
      };
      const tool = create_check_show_status(deps_bag as ToolDeps);
      const ctx: ToolContext = {
        memory: env.memory,
        llm: env.llm,
        now: new Date(),
        intent_id: 'smoke-css-1',
      };
      const r = await tool.execute(
        {
          artist: 'Khruangbin',
          venue: 'Riverbend Amphitheatre',
          show_date: '2026-08-15',
          rationale: 'Heavy rotation match',
          force_browse: false,
        },
        ctx,
      );
      r.was_inserted ? ok('first call inserts a new row') : fail('expected insert', r);
      r.ticket_status === 'unknown' ? ok('no URL → unknown status') : fail('status not unknown', r);
      r.fetched_url == null ? ok('no URL passed → fetched_url null') : fail('fetched_url not null', r);

      // Re-call same key — should update last_seen_at, not insert.
      const r2 = await tool.execute(
        {
          artist: 'Khruangbin',
          venue: 'Riverbend Amphitheatre',
          show_date: '2026-08-15',
          rationale: 'Heavy rotation match (refreshed)',
          force_browse: false,
        },
        ctx,
      );
      !r2.was_inserted ? ok('idempotent on (artist, venue, date)') : fail('expected update, got insert', r2);
      r2.id === r.id ? ok('same row id on update') : fail('id changed across upsert', { first: r.id, second: r2.id });

      // Affinity inheritance from the artist watchlist (no affinity_hint passed).
      type Row = { affinity_at_capture: number | null };
      const row = env.db
        .prepare(`SELECT affinity_at_capture FROM upcoming_shows WHERE id = @id`)
        .get({ '@id': r2.id }) as Row | undefined;
      row?.affinity_at_capture === 8
        ? ok('affinity inherited from watchlist (Khruangbin → 8)')
        : fail('affinity not inherited', row);
    } finally {
      env.cleanup();
    }
  }

  console.log('\n── compose_pane(maggie, listening) ─────────────────────');
  {
    const env = init_env();
    try {
      seed_watchlist(env.vault_root);
      seed_shows(env.db);
      const doc = await compose_pane(make_spec('listening'), env.db, 'jasper', pane_deps(env));
      doc != null ? ok('returns a pane document') : fail('null pane doc');
      if (!doc) throw new Error('pane null');

      doc.pane_kind === 'listening' ? ok('pane_kind is listening') : fail('wrong pane_kind', doc);
      doc.title === 'Listening' ? ok('title is Listening') : fail('wrong title', doc);
      doc.blocks.length === 5 ? ok('five blocks (sections)') : fail('block count', doc);

      // Section order ('Worth a look' — Maggie's thematic picks — inserted at
      // index 2, shifting Plex + library down one).
      const titles = doc.blocks.map((b) => (b.type === 'list' ? b.title : '<embed>'));
      titles[0]?.startsWith('Coming to town') ? ok('first: Coming to town') : fail('section 1', titles);
      titles[1] === 'On your radar' ? ok('second: On your radar') : fail('section 2', titles);
      titles[2] === 'Worth a look' ? ok('third: Worth a look') : fail('section 3', titles);
      titles[3]?.startsWith('Hitting your Plex') ? ok('fourth: Hitting your Plex') : fail('section 4', titles);
      titles[4] === 'New in the library' ? ok('fifth: New in the library') : fail('section 5', titles);

      // Coming to town content: 3 visible (sold_out + resale_only filtered),
      // ordered by show_date ascending.
      const coming = doc.blocks[0]!;
      if (coming.type !== 'list') {
        fail('coming-to-town block is not a list', coming);
      } else {
        const artists = coming.items.map((i) => i.title);
        artists.length === 3 ? ok('sold_out + resale_only filtered (3 visible)') : fail('filter count', artists);
        !artists.includes('Phoebe Bridgers') ? ok('Phoebe (sold_out) filtered') : fail('sold_out leaked', artists);
        !artists.includes('Big Thief') ? ok('Big Thief (resale_only) filtered') : fail('resale_only leaked', artists);
        artists[0] === 'Phoebe Bridgers'
          ? fail('ordering wrong — sold-out should be filtered', artists)
          : ok('nearest non-sold-out first');
        // Available row carries "Tickets available" status label.
        const khru = coming.items.find((i) => i.title === 'Khruangbin');
        khru?.subtitle?.includes('Tickets available')
          ? ok('available row carries "Tickets available" label')
          : fail('status label missing', khru);
        const wet = coming.items.find((i) => i.title === 'Wet Leg');
        wet?.subtitle?.includes('Tickets low')
          ? ok('low row carries "Tickets low" label')
          : fail('low label missing', wet);
        // Unknown status has no trailing status label (just date + venue).
        const animal = coming.items.find((i) => i.title === 'Animal Collective');
        animal && !/Tickets|Sold out|Resale/.test(animal.subtitle ?? '')
          ? ok('unknown status renders without a status suffix')
          : fail('unknown leaked a label', animal);
      }

      // On your radar: top-by-affinity from the watchlist (Phoebe 9, Khruangbin 8, Wet Leg 7).
      const radar = doc.blocks[1]!;
      if (radar.type !== 'list') {
        fail('radar block is not a list', radar);
      } else {
        radar.items[0]?.title === 'Phoebe Bridgers' ? ok('radar top is Phoebe (affinity 9)') : fail('radar top wrong', radar);
        radar.items[0]?.subtitle?.includes('Affinity 9') ? ok('radar shows affinity') : fail('affinity missing', radar);
        radar.items[0]?.subtitle?.includes('last seen')
          ? ok('radar shows last-seen when present')
          : fail('last-seen missing', radar);
        radar.items[1]?.title === 'Khruangbin' ? ok('radar second is Khruangbin') : fail('radar order', radar);
      }

      // Plex + arr graceful degrade (no tools registered).
      const plex = doc.blocks[2]!;
      if (plex.type === 'list' && plex.items.length === 1 && plex.items[0]?.title === '—') {
        ok('Plex degrades to placeholder when tool absent');
      } else {
        fail('plex degrade unexpected', plex);
      }
      const lib = doc.blocks[3]!;
      if (lib.type === 'list' && lib.items.length === 1 && lib.items[0]?.title === '—') {
        ok('library degrades to placeholder when tool absent');
      } else {
        fail('library degrade unexpected', lib);
      }
    } finally {
      env.cleanup();
    }
  }

  console.log('\n── compose_pane(maggie, null) — null pane_kind ─────────');
  {
    const env = init_env();
    try {
      const doc = await compose_pane(make_spec(null), env.db, 'jasper', pane_deps(env));
      doc == null ? ok('null pane_kind → null doc → 404 fallback') : fail('expected null', doc);
    } finally {
      env.cleanup();
    }
  }

  console.log('\n── compose_pane with stubbed Plex + media_library tools ─');
  {
    const env = init_env();
    try {
      seed_watchlist(env.vault_root);
      seed_shows(env.db);

      // Stub plex_heavy_rotation
      const plex_tool: Tool = {
        name: 'plex_heavy_rotation',
        description: 'stub',
        risk: 'read',
        input_schema: z.any() as z.ZodType,
        output_schema: z.any() as z.ZodType,
        idempotency_key: () => 'stub',
        async execute() {
          return {
            stat: 'top_artists',
            window_days: 30,
            items: [
              { title: 'Khruangbin', parent_title: '', grandparent_title: '', plays: 42, duration_seconds: null, last_played: '2026-05-28T12:00:00Z' },
              { title: 'Phoebe Bridgers', parent_title: '', grandparent_title: '', plays: 33, duration_seconds: null, last_played: '2026-05-27T12:00:00Z' },
            ],
          };
        },
      };
      env.registry.register(plex_tool);

      // Stub media_library (history view across apps)
      const lib_tool: Tool = {
        name: 'media_library',
        description: 'stub',
        risk: 'read',
        input_schema: z.any() as z.ZodType,
        output_schema: z.any() as z.ZodType,
        idempotency_key: () => 'stub',
        async execute(input) {
          const app = (input as { app: string }).app;
          if (app === 'sonarr') {
            return {
              app, view: 'history', count: 1, summary: '',
              items: [
                { event: 'episodeFileImported', title: 'Severance S03E04', date: '2026-05-28T01:00:00Z' },
                { event: 'grabbed', title: 'Some unfinished thing', date: '2026-05-28T00:00:00Z' },
              ],
            };
          }
          if (app === 'radarr') {
            return {
              app, view: 'history', count: 1, summary: '',
              items: [
                { event: 'movieFileImported', title: 'Dune Part Three (2026)', date: '2026-05-29T01:00:00Z' },
              ],
            };
          }
          return { app, view: 'history', count: 0, summary: '', items: [] };
        },
      };
      env.registry.register(lib_tool);

      const doc = await compose_pane(make_spec('listening'), env.db, 'jasper', pane_deps(env));
      if (!doc) throw new Error('null doc');
      // 'Worth a look' at index 2 shifts Plex → 3 and library → 4.
      const plex = doc.blocks[3]!;
      if (plex.type !== 'list') {
        fail('plex block not a list', plex);
      } else {
        plex.items[0]?.title === 'Khruangbin' ? ok('Plex top artist surfaces') : fail('plex top', plex);
        plex.items[0]?.subtitle?.includes('42 plays') ? ok('Plex play count surfaces') : fail('plex plays', plex);
      }
      const lib = doc.blocks[4]!;
      if (lib.type !== 'list') {
        fail('library block not a list', lib);
      } else {
        // newest first across apps; imported only.
        lib.items[0]?.title === 'Dune Part Three (2026)' ? ok('library newest first') : fail('library order', lib);
        const titles = lib.items.map((i) => i.title);
        !titles.includes('Some unfinished thing') ? ok('grab-only items filtered') : fail('grabbed leaked', titles);
      }
    } finally {
      env.cleanup();
    }
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
