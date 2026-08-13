/**
 * The /app sub-router — Hearth's unified web UI.
 *
 * Mirrors the create_inbox_router pattern. Serves the static SPA shell from
 * src/app/client/, mounts /app/api/* sub-routes, and exposes the SSE event
 * stream that pushes server-side state changes to open browsers.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import type { ProposalsStore } from '@core/proposals';
import {
  AppEventBus,
  media_shared_reaches,
  sse_wire_payload,
  type AppEvent,
} from './events';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import { create_avatars_router } from './routes/avatars';
import { create_banners_router } from './routes/banners';
// create_sensors_router + create_kate_router are imported and mounted
// at the top level in apps/orchestrator/server.ts — see the NOTE
// inside create_app_router below.
import { create_profile_router } from './routes/profile';
import { create_library_router } from './routes/library';
import { create_search_router } from './routes/search';
import { create_jobs_router } from './routes/jobs';
import { create_chat_router } from './routes/chat';
import { create_hire_router } from './routes/hire';
import { create_feedback_router } from './routes/feedback';
import { create_roadmap_router } from './routes/roadmap';
import { create_topology_router } from './routes/topology';
import { create_hvac_router } from './routes/hvac';
import { create_panel_router } from './routes/panel';
import { serve_static } from './static';
import { ScrumStore } from '@memory/stores/scrum';
import { render_scrum_canvas_md } from '@core/scrum_render';
import { open_scrum_decisions } from '@core/scrum_pane';

export interface AppRouterDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  proposals: ProposalsStore;
  conversations: ConversationStore;
  interrupts: InterruptStore;
  inbox: SpecialistInbox;
  vault_root: string;
  specialists_dir: string;
  events: AppEventBus;
  llm?: import('@core/llm').LLMRouter;
  /** RAG embedder (Pass 7) — threaded into the library router for embed-at-ingest. */
  embedder?: import('@core/embeddings').Embedder;
}

export function create_app_router(deps: AppRouterDeps): Hono {
  const r = new Hono();
  const client_dir = resolve(import.meta.dir, 'client');

  // ── Static shell ────────────────────────────────────────────────────

  r.get('/', (c) => serve_static(c, resolve(client_dir, 'index.html')));
  r.get('/login.html', (c) => serve_static(c, resolve(client_dir, 'login.html')));
  r.get('/voice.html', (c) => serve_static(c, resolve(client_dir, 'voice.html')));
  r.get('/showcase.html', (c) => serve_static(c, resolve(client_dir, 'showcase.html')));
  // Live compute + model fleet map. Served as a clean path (no .html) so it
  // reads as a first-class view; the file is plain static like the rest.
  r.get('/architecture', (c) => serve_static(c, resolve(client_dir, 'architecture.html')));
  // Household Awareness P2 live debug surface — polls the owner-only
  // person_tracks_debug endpoint (rides the web session cookie) and renders the
  // gallery / belief / multi-shot / per-camera-calibration state live.
  r.get('/awareness', (c) => serve_static(c, resolve(client_dir, 'awareness.html')));
  r.get('/app.css', (c) => serve_static(c, resolve(client_dir, 'app.css')));
  r.get('/app.js', (c) => serve_static(c, resolve(client_dir, 'app.js')));
  r.get('/manifest.webmanifest', (c) =>
    serve_static(c, resolve(client_dir, 'manifest.webmanifest')),
  );
  r.get('/sw.js', (c) => serve_static(c, resolve(client_dir, 'sw.js')));
  r.get('/assets/:name', (c) => {
    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) {
      return c.text('bad request', 400);
    }
    return serve_static(c, resolve(client_dir, 'assets', name));
  });
  // Web voice orb full-duplex runtime. /voice/:name serves COMMITTED files
  // (turn_engine.js — the pure endpointing/barge policy, smoke:web-voice-engine);
  // /voice/vendor/:name serves the FETCHED VAD binaries (Silero v5 onnx +
  // vad-web bundles + onnxruntime-web wasm — see voice/fetch-vad-web-assets.sh;
  // absent files 404 and voice.html degrades to the legacy turn-based loop).
  r.get('/voice/:name', (c) => {
    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) {
      return c.text('bad request', 400);
    }
    return serve_static(c, resolve(client_dir, 'voice', name));
  });
  r.get('/voice/vendor/:name', (c) => {
    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) {
      return c.text('bad request', 400);
    }
    return serve_static(c, resolve(client_dir, 'voice', 'vendor', name));
  });

  // ── Hearth Mac app download ─────────────────────────────────────────
  //
  // A self-contained "download the Mac app" landing page (download.html,
  // committed, icon inlined) plus the signed + notarized .app zip itself.
  // The page is in the repo; the BINARY lives OUTSIDE the repo on the host
  // and is bind-mounted in (mirrors the /compare/* passthrough) so a 20 MB
  // artifact never enters git — host dir is HEARTH_DOWNLOADS_ROOT, default
  // /data/downloads (compose: /docker/hearth/downloads:/data/downloads:ro).
  // Both /app/download and /app/download/<file> are allow-listed in the
  // auth middleware so the page is reachable without a Hearth login — same
  // public tier as showcase.html.
  const DOWNLOADS_ROOT = process.env.HEARTH_DOWNLOADS_ROOT ?? '/data/downloads';
  const serve_download_page = (c: Context) =>
    serve_static(c, resolve(client_dir, 'download.html'));
  r.get('/download', serve_download_page);
  r.get('/download/', serve_download_page);
  // The build manifest (version / size / sha256 / changelog) the page hydrates
  // from. Written beside the zip by scripts/publish-mac-app.sh. Served inline as
  // JSON (NOT an attachment like the binary route below) and registered BEFORE
  // the `:filename` catch-all so a publish never needs an HTML edit. 404 when
  // absent → the page falls back to its baked-in defaults.
  r.get('/download/manifest.json', (c) => {
    const abs = resolve(DOWNLOADS_ROOT, 'manifest.json');
    if (!existsSync(abs) || !statSync(abs).isFile()) return c.text('not found', 404);
    return new Response(new Uint8Array(readFileSync(abs)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  });
  // Archive index — every past build, newest first. DERIVED from the per-build
  // sidecars (`Hearth-*.json`) the publish script drops beside each zip, so it's
  // self-healing: a build added/removed on disk shows up/leaves with no index to
  // maintain. The page renders a collapsible "Previous versions" list from this.
  r.get('/download/archive.json', (c) => {
    let builds: unknown[] = [];
    try {
      const files = readdirSync(DOWNLOADS_ROOT)
        .filter((f) => f.startsWith('Hearth-') && f.endsWith('.json'))
        .slice(0, 200); // defensive cap
      builds = files
        .map((f) => {
          try {
            return JSON.parse(readFileSync(resolve(DOWNLOADS_ROOT, f), 'utf8')) as Record<string, unknown>;
          } catch {
            return null; // skip a malformed sidecar rather than failing the list
          }
        })
        .filter((b): b is Record<string, unknown> => b !== null)
        .sort((a, b) =>
          String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')),
        );
    } catch {
      builds = []; // no downloads dir yet → empty archive
    }
    return c.json({ builds }, 200, { 'Cache-Control': 'no-cache' });
  });
  r.get('/download/:filename', (c) => {
    const filename = c.req.param('filename');
    // Single path segment only — no traversal, no dotfiles, no nesting.
    if (filename.includes('..') || filename.includes('/') || filename.startsWith('.')) {
      return c.text('bad request', 400);
    }
    const abs = resolve(DOWNLOADS_ROOT, filename);
    const root = DOWNLOADS_ROOT.endsWith('/') ? DOWNLOADS_ROOT : DOWNLOADS_ROOT + '/';
    if (!abs.startsWith(root)) return c.text('bad request', 400);
    if (!existsSync(abs) || !statSync(abs).isFile()) return c.text('not found', 404);
    const bytes = readFileSync(abs);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  });

  // ── Compare pages ───────────────────────────────────────────────────
  //
  // Read-only passthrough to the ComfyUI output directory, bind-mounted
  // into this container at /data/comfyui-output. Used by ad-hoc compare
  // pages (e.g. /app/compare/ruby-compare/ruby-compare.html) so we can
  // iterate on specialist visuals through the same /app surface as the
  // rest of the UI — no separate webserver. Auth middleware still
  // gates this route like every other /app path.
  const COMPARE_ROOT =
    process.env.HEARTH_COMPARE_ROOT ?? '/data/comfyui-output';
  r.get('/compare/*', (c) => {
    const url_path = new URL(c.req.url).pathname;
    const rel = url_path.replace(/^.*\/compare\/+/, '');
    if (!rel || rel.includes('..')) return c.text('bad request', 400);
    const abs = resolve(COMPARE_ROOT, rel);
    if (
      abs !== COMPARE_ROOT &&
      !abs.startsWith(COMPARE_ROOT.endsWith('/') ? COMPARE_ROOT : COMPARE_ROOT + '/')
    ) {
      return c.text('bad request', 400);
    }
    return serve_static(c, abs);
  });

  // ── Beatrice's scrum dev-board canvas ───────────────────────────────
  //
  // A planning-canvas-style live render (markdown + mermaid) of the scrum
  // board, served under /app so it rides the web session + auth — no nginx
  // /api alternation needed for it to work. `board.md` is rendered on demand
  // from the store and owner-gated. Vendored mermaid/marked (no CDN; both
  // verified to make zero external calls). The structured iOS board renders
  // separately as the Code Shop "Scrum" tab — this is the chart/grooming
  // whiteboard. board.md must be registered before the `:name` catch-all.
  const scrum_canvas_dir = resolve(client_dir, 'scrum-canvas');
  const serve_canvas_index = (c: Context) =>
    serve_static(c, resolve(scrum_canvas_dir, 'index.html'));
  r.get('/scrum-canvas', serve_canvas_index);
  r.get('/scrum-canvas/', serve_canvas_index);
  r.get('/scrum-canvas/board.md', (c) => {
    const u = c.get('user');
    if (!u || u.tier !== 'owner') return c.text('owner only', 403);
    const md = render_scrum_canvas_md(new ScrumStore(deps.db));
    return new Response(md, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  });
  // Structured board JSON for the rich dashboard render (kanban + gauges).
  // board.md (above) stays for a markdown/mermaid view; this drives the styled UI.
  r.get('/scrum-canvas/board.json', (c) => {
    const u = c.get('user');
    if (!u || u.tier !== 'owner') return c.json({ error: 'owner only' }, 403);
    const store = new ScrumStore(deps.db);
    return c.json(
      {
        board: store.read_board(),
        burndown: store.burndown(),
        awaiting: open_scrum_decisions(deps.db),
        heatmap: store.activity_heatmap(),
      },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });
  r.get('/scrum-canvas/:name', (c) => {
    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) return c.text('bad request', 400);
    return serve_static(c, resolve(scrum_canvas_dir, name));
  });

  // ── Ride Log (Live Ride Companion Phase 2.5) ────────────────────────
  //
  // Static shell + vanilla JS, scrum-canvas pattern. Data comes from the
  // SAME top-level routes iOS uses (`/api/workout/sessions*` — the auth
  // middleware accepts the web session cookie as well as bearer tokens),
  // so this surface adds zero API duplication and needs no nginx edit
  // (`workout` is already in the /api alternation).
  const rides_dir = resolve(client_dir, 'rides');
  const serve_rides_index = (c: Context) =>
    serve_static(c, resolve(rides_dir, 'index.html'));
  r.get('/rides', serve_rides_index);
  r.get('/rides/', serve_rides_index);
  r.get('/rides/:name', (c) => {
    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) return c.text('bad request', 400);
    return serve_static(c, resolve(rides_dir, name));
  });

  // ── Kate's VRM face surface ─────────────────────────────────────────
  //
  // three-vrm avatar at /app/face (static dir — same pattern as rides /
  // scrum-canvas). Loads kate.vrm and runs idle (blink / breathe /
  // spring-bones), eased emotion blends, and amplitude lip-sync entirely
  // client-side; the "Speak" box posts to the top-level /api/voice/tts
  // proxy (Kate's Laur voice on forza). Behind the normal /app
  // web-session auth like every other /app path. kate.vrm is served by the
  // `:name` route below (octet-stream via the MIME default — fine for
  // GLTFLoader's arraybuffer fetch).
  const face_dir = resolve(client_dir, 'face');
  const serve_face_index = (c: Context) =>
    serve_static(c, resolve(face_dir, 'index.html'));
  r.get('/face', serve_face_index);
  r.get('/face/', serve_face_index);
  // Wildcard (not :name) so nested vendor/ paths — e.g.
  // /app/face/vendor/addons/loaders/GLTFLoader.js — resolve. Path-containment
  // guarded exactly like /compare/* above.
  r.get('/face/*', (c) => {
    const url_path = new URL(c.req.url).pathname;
    const rel = url_path.replace(/^.*\/face\/+/, '');
    if (!rel || rel.includes('..')) return c.text('bad request', 400);
    const abs = resolve(face_dir, rel);
    if (abs !== face_dir && !abs.startsWith(face_dir.endsWith('/') ? face_dir : face_dir + '/')) {
      return c.text('bad request', 400);
    }
    return serve_static(c, abs);
  });

  // ── Heat-pump replacement guide ─────────────────────────────────────
  //
  // Page + assets + state persistence, all owned by one sub-router (unlike
  // rides / face, whose data comes from routes mounted elsewhere). It has to
  // be self-contained: the guide's built-in autosave IIFE fetches a RELATIVE
  // `api/state`, so the state route must live directly beneath the page rather
  // than under /app/api/. See routes/hvac.ts for why the trailing slash is
  // handled inside a single handler and not by routing.
  r.route('/hvac', create_hvac_router({ db: deps.db, client_dir }));

  // ── Guest panel ─────────────────────────────────────────────────────
  //
  // Same self-contained shape as the guide above — page, assets and API under
  // one mount, because the panel fetches a RELATIVE `api/pane`.
  //
  // UNAUTHENTICATED (a guest has no Hearth account), so its paths are
  // allow-listed in the auth middleware AND every route inside is gated on the
  // caller being on the house LAN. /app/ is served on the public Tailscale
  // endpoint too, and light switches must not be reachable from it.
  // The runtime is what makes the panel's Kate button real; she answers as an
  // explicit friend-tier guest, never as the absent-caller owner default.
  r.route('/panel', create_panel_router({ client_dir, runtime: deps.runtime }));

  // ── API routes ──────────────────────────────────────────────────────

  r.route(
    '/api/avatars',
    create_avatars_router({
      specialists: deps.specialists,
      specialists_dir: deps.specialists_dir,
      vault_root: deps.vault_root,
      memory: deps.memory,
    }),
  );
  r.route(
    '/api/banners',
    create_banners_router({
      specialists: deps.specialists,
      vault_root: deps.vault_root,
      memory: deps.memory,
    }),
  );
  r.route(
    '/api/profile',
    create_profile_router({
      db: deps.db,
      specialists: deps.specialists,
      specialists_dir: deps.specialists_dir,
      vault_root: deps.vault_root,
      proposals: deps.proposals,
    }),
  );
  r.route(
    '/api/library',
    create_library_router({
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      embedder: deps.embedder,
      events: deps.events,
    }),
  );
  r.route(
    '/api/search',
    create_search_router({
      db: deps.db,
      conversations: deps.conversations,
      memory: deps.memory,
    }),
  );
  // On the Fire — the web dock reaches this at /app/api/jobs (this router is
  // mounted under /app). The SAME router is also mounted top-level in
  // apps/orchestrator/server.ts for iOS, which calls /api/jobs with no prefix.
  r.route('/api/jobs', create_jobs_router({ db: deps.db, events: deps.events }));
  r.route(
    '/api/chat',
    create_chat_router({
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      events: deps.events,
    }),
  );
  r.route(
    '/api/specialists',
    create_hire_router({
      specialists_dir: deps.specialists_dir,
      vault_root: deps.vault_root,
      specialists: deps.specialists,
      runtime: deps.runtime,
      proposals: deps.proposals,
      inbox: deps.inbox,
      events: deps.events,
    }),
  );
  r.route(
    '/api/feedback',
    create_feedback_router({
      specialists: deps.specialists,
      memory: deps.memory,
    }),
  );
  r.route(
    '/api/roadmap',
    create_roadmap_router({
      // app/router.ts → src/app/ → src/ → repo root (../..)
      repo_root: resolve(import.meta.dir, '../..'),
      events: deps.events,
    }),
  );
  // Live fleet map — boxes → GPU/CPU → model services + parallel health probes.
  // No deps: the topology is static config and the probes are outbound HTTP.
  r.route('/api/topology', create_topology_router());
  // NOTE: `/api/sensors` and `/api/kate` are mounted at the
  // **top level** in apps/orchestrator/server.ts, NOT here. This
  // router is mounted under `/app`, so anything registered here as
  // `/api/...` actually serves at `/app/api/...`. iOS calls
  // `/api/sensors/:signal` and `/api/kate/*` (no `/app` prefix);
  // putting those mounts here makes them 404 from iOS while still
  // appearing to work from the web client (which already lives at
  // `/app`). Re-discovered 2026-05-27 via SensorsView's
  // IngestHealthLine surfacing "HTTP 404: 404 Not Found" on every
  // ingest attempt — fix is the structural move, not a path
  // rewrite. Keep new top-level Hearth API routes (anything iOS
  // expects at `/api/...`) registered in server.ts.

  // ── SSE stream ──────────────────────────────────────────────────────

  r.get('/api/events', (c) => {
    const { readable, writable } = new TransformStream<string, string>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Per-subscriber cordon for cordon-bearing events: a `media_archived` for an
    // item this subscriber can't see (NSFW / owner-only) must NOT reach them —
    // the media router's 404-shape discipline extended to the live SSE stream.
    // Fail-closed (friend, no user_id) when unauthenticated.
    const sse_user = c.get('user');
    const sse_caller: Caller = sse_user
      ? { user_id: sse_user.id, tier: sse_user.tier }
      : { user_id: undefined, tier: 'friend' };
    const send = (event: AppEvent) => {
      // Cordon only — no `shared_with` here, deliberately. `media_archived`
      // fires at CREATION, before the item can have been shared with anyone
      // (the grant is a later, separate write), so there is never a grant to
      // honour on this event. Reaching a grantee is `media_shared`'s job, right
      // below, and it carries its own audience.
      if (event.type === 'media_archived' && !note_visible_to_caller(event.private_to, sse_caller)) {
        return;
      }
      // A share only concerns the sharer and the people the write TOUCHED —
      // who shared what with whom is not third-party business. The audience
      // includes REVOKED users: theirs is the Archive still showing an item
      // they no longer have, and nothing else tells them to refetch. Rule +
      // fail-closed default live with the event (events.ts).
      if (event.type === 'media_shared' && !media_shared_reaches(event, sse_caller.user_id)) {
        return;
      }
      // On the Fire: a job's live phase is the same information as its result,
      // so it rides the same cordon (an owner-only NSFW download must not
      // announce "Downloading <title>" to a household subscriber). A job with
      // no cordon column falls back to its requester.
      if (event.type === 'job_progress') {
        const cordoned = event.private_to ?? event.user_id;
        if (
          !(event.user_id !== null && event.user_id === sse_caller.user_id) &&
          !note_visible_to_caller(cordoned ?? undefined, sse_caller)
        ) {
          return;
        }
      }
      // Agent Rooms are owner-only + cordoned to the owning user — the room
      // thread's messages must not fan out to any other subscriber. Deliver
      // room_* events only to the owning user (fail-closed for everyone else).
      if (
        (event.type === 'room_message_added' ||
          event.type === 'room_turn_started' ||
          event.type === 'room_turn_done' ||
          event.type === 'room_speaker') &&
        sse_caller.user_id !== event.user_id
      ) {
        return;
      }
      // `sse_wire_payload` drops delivery-only fields (media_shared.deliver_to)
      // — routing metadata must never reach a subscriber as payload.
      void writer.write(`data: ${JSON.stringify(sse_wire_payload(event))}\n\n`);
    };
    const heartbeat = () => {
      void writer.write(`: heartbeat ${Date.now()}\n\n`);
    };

    const unsubscribe = deps.events.subscribe(send);
    // Send an initial "hello" so the client knows the stream is alive.
    void writer.write(`: hello ${Date.now()}\n\n`);

    // Replay any currently-active streaming turns so a refreshed
    // browser can restore its typing/streaming bubble without waiting
    // for a missing event. For each active stream we emit a synthetic
    // `specialist_thinking: started` plus a single `message_token`
    // carrying the accumulated partial text. Clients treat these
    // identically to live events.
    for (const s of deps.events.current_active_streams()) {
      send({
        type: 'specialist_thinking',
        specialist_id: s.specialist_id,
        conversation_id: s.conversation_id,
        state: 'started',
      });
      if (s.stream_id) {
        if (s.partial_thinking.length > 0) {
          send({
            type: 'message_thinking_token',
            conversation_id: s.conversation_id,
            specialist_id: s.specialist_id,
            stream_id: s.stream_id,
            delta: s.partial_thinking,
          });
        }
        if (s.partial_text.length > 0) {
          send({
            type: 'message_token',
            conversation_id: s.conversation_id,
            specialist_id: s.specialist_id,
            stream_id: s.stream_id,
            delta: s.partial_text,
          });
        }
      }
    }
    // Replay in-flight tool calls so a refresh mid-consult rebuilds
    // the tool-chain panel (e.g. Iris consulting Beatrice for 5+ min —
    // without this, the page reload would show the spinner but no
    // detail about who she's talking to).
    for (const t of deps.events.current_active_tool_calls()) {
      send({
        type: 'tool_invoked',
        conversation_id: t.conversation_id,
        specialist_id: t.specialist_id,
        tool_call_id: t.tool_call_id,
        tool_name: t.tool_name,
        input_summary: t.input_summary,
      });
    }

    const interval = setInterval(heartbeat, 25_000);

    const cleanup = () => {
      clearInterval(interval);
      unsubscribe();
      try {
        void writer.close();
      } catch {
        /* ignore */
      }
    };
    c.req.raw.signal.addEventListener('abort', cleanup);

    // Pipe text chunks to bytes for the actual Response.
    const out_stream = readable.pipeThrough(
      new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(chunk));
        },
      }),
    );

    return new Response(out_stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return r;
}
