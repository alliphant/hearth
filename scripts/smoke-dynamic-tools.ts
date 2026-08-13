/**
 * smoke:dynamic-tools — the dynamic tool surface (2026-06-08), fully offline.
 *
 * Asserts the parts verifiable without a live LLM:
 *  1. tool-RAG ranking surfaces the message-relevant tools (deterministic fake
 *     embedder so cosine order is assertable);
 *  2. compose_hot_set keeps the FLOOR and honors the cap;
 *  3. partition_awareness splits catalog into ready/rest cleanly;
 *  4. apply_load_tools: granted→newly, un-granted→missing (never loaded),
 *     already-hot→already, over-budget→capped (capability-safe by construction);
 *  5. _build_turn_surface FAIL-OPEN — embeddings off / non-chat surface / env
 *     kill switch ⇒ dynamic_on=false and the curated surface (byte-identical
 *     to today); and the happy path produces catalog=full, hot⊆catalog w/ floor.
 *
 * The full live win (tokens_in drop on a real Kate chat turn) is measured
 * against the LLM host, not here. Mirrors scripts/smoke-directed-task.ts's offline
 * `new SpecialistRuntime({...} as deps)` + `_test_*` seam pattern.
 */
import { SpecialistRuntime, type SpecialistRuntimeDeps } from '@core/specialist_runtime';
import type { LoadedSpecialist } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';
import type { Tool } from '@core/tool';
import { type Embedder, NoopEmbedder } from '@core/embeddings';
import {
  rank_tools_for_message,
  compose_hot_set,
  partition_awareness,
  compact_catalog_lines,
  apply_load_tools,
  format_load_tools_result,
  FLOOR_TOOL_NAMES,
  MAX_HOT_TOOLS,
  MAX_HOT_TOOLS_DELIBERATION,
  MAX_TOTAL_LOADED,
  type CachedVec,
} from '@core/dynamic_tools';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}
const names = (ts: Array<{ name: string }>) => ts.map((t) => t.name).sort();
const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── Deterministic fake embedder: a vector over topic-keyword counts, so a
// message and the relevant tool descriptions share nonzero dims → high cosine.
const TOPICS: Record<string, string[]> = {
  calendar: ['calendar', 'schedule', 'meeting', 'event', 'tomorrow', 'appointment'],
  weather: ['weather', 'temperature', 'forecast', 'rain', 'storm', 'degrees'],
  maps: ['route', 'direction', 'drive', 'distance', 'nearby', 'map', 'far'],
  comms: ['message', 'text', 'email', 'draft', 'send', 'reply'],
};
const fakeEmbedder: Embedder = {
  enabled: true,
  model: 'fake-topics',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const low = t.toLowerCase();
      return Object.values(TOPICS).map((kws) => kws.reduce((n, k) => n + (low.includes(k) ? 1 : 0), 0));
    });
  },
  async rerank() {
    return null;
  },
};

// ── Mock catalog (real-ish Tool shape; only name+description are read here). ──
const mk = (name: string, description: string): Tool =>
  ({ name, description }) as unknown as Tool;
const CATALOG: Tool[] = [
  mk('search_library', 'Search your knowledge library notes and files.'), // floor
  mk('present_questions', 'Ask the user a set of structured questions.'), // floor
  mk('sensor_calendar_upcoming', 'List upcoming calendar events and meetings on your schedule.'),
  mk('weather_now', 'Current weather conditions and temperature.'),
  mk('weather_forecast', 'Multi-day weather forecast.'),
  mk('route', 'Driving directions, route and distance to a place.'),
  mk('nearby', 'Find places nearby on the map.'),
  mk('draft_message', 'Draft a text message or email to send to someone.'),
  mk('propose_action', 'Propose an action for the user to approve.'),
  mk('schedule_calendar_event', 'Schedule a new calendar event or appointment.'),
  // Filler past MAX_HOT_TOOLS (12), so the degraded-mode slice has something to
  // actually cut. Deliberately topic-neutral: the ranking assertions above pick
  // winners by keyword overlap, and these match no TOPICS bucket, so they can
  // never displace a ranked result. A catalog smaller than the cap would make
  // the "hot is strictly smaller" check unfailable — the exact shape of the
  // real case (Kate: 98 curated) needs a list longer than the cap to express.
  mk('upsert_place', 'Save or update a place note.'),
  mk('record_decision', 'Record a decision that was made.'),
  mk('read_note', 'Read a note by path.'),
  mk('who_is', 'Look up a person and what is known about them.'),
  mk('household_services', 'The household vendor and bill ledger.'),
  mk('system_health', 'Dependency health from the last scan.'),
  // Past MAX_HOT_TOOLS_DELIBERATION (20) as well, so the deliberation
  // assertions below have a surface that actually exceeds their cap. Same
  // topic-neutral rule as the filler above.
  mk('record_person_pref', 'Record a fact about a person.'),
  mk('set_event_owner', 'Attribute a calendar event to a household member.'),
  mk('recall_precedent', 'How similar past cases were decided.'),
  mk('read_inbox', 'Read your inbox.'),
  mk('recommend_to_user', 'File a recommendation card.'),
  mk('promote_interrupt', 'Push an interrupt to the owner.'),
  mk('absorb_interrupt', 'Acknowledge a false alarm.'),
  mk('upcoming_dates', 'Birthdays and anniversaries.'),
];

// ── 1. tool-RAG ranking ─────────────────────────────────────────────────────
{
  const cache = new Map<string, CachedVec>();
  const top2 = await rank_tools_for_message({
    message: 'directions to the dentist',
    catalog: CATALOG,
    embedder: fakeEmbedder,
    cache,
    k: 2,
  });
  check('ranking: "directions" → top-2 are route + nearby', eq(top2.slice().sort(), ['nearby', 'route']));
  check('ranking: caches a vector per catalog tool', cache.size === CATALOG.length);

  const cal = await rank_tools_for_message({
    message: 'what is on my calendar tomorrow',
    catalog: CATALOG,
    embedder: fakeEmbedder,
    cache,
    k: 3,
  });
  check(
    'ranking: "calendar" surfaces the calendar tools',
    cal.includes('sensor_calendar_upcoming') || cal.includes('schedule_calendar_event'),
  );
  check('ranking: warm cache does not re-grow', cache.size === CATALOG.length);
}

// ── 2. compose_hot_set: floor present, cap honored ──────────────────────────
{
  const ranked = ['route', 'nearby', 'draft_message', 'propose_action'];
  const hot = compose_hot_set(CATALOG, ranked, FLOOR_TOOL_NAMES, 4);
  check('compose: cap respected (4)', hot.length === 4);
  check('compose: floor always present', FLOOR_TOOL_NAMES.every((f) => hot.some((t) => t.name === f)));
  check('compose: top ranked included under cap', hot.some((t) => t.name === 'route'));
  check('compose: cap drops the ranked tail (not floor)', !hot.some((t) => t.name === 'propose_action'));
}

// ── 3. partition_awareness ──────────────────────────────────────────────────
{
  const hot = compose_hot_set(CATALOG, ['route', 'nearby'], FLOOR_TOOL_NAMES, MAX_HOT_TOOLS);
  const { ready, rest } = partition_awareness(CATALOG, hot);
  check('partition: ready === hot', eq(names(ready), names(hot)));
  check('partition: ready ∪ rest === catalog, disjoint', ready.length + rest.length === CATALOG.length);
  check('partition: a hot tool is not in rest', !rest.some((t) => t.name === 'route'));

  // rest-tier rendering is COMPACT (truncated) — keeps full-catalog awareness cheap.
  const longDesc = [{ name: 'verbose_tool', description: 'x'.repeat(200) }];
  const line = compact_catalog_lines(longDesc, 60);
  check('compact: truncates a long rest-tier description', line.length < 90 && line.includes('…'));
  check('compact: keeps a short description intact', compact_catalog_lines([{ name: 'y', description: 'short desc' }]).includes('short desc'));
}

// ── 4. apply_load_tools: capability-safe + idempotent + bounded ─────────────
{
  const hotNames = new Set(['search_library', 'present_questions', 'route']);
  const r1 = apply_load_tools({ names: ['draft_message'], catalog: CATALOG, hotNames, total_loaded: 0 });
  check('load: granted catalog tool → newly', r1.newly.length === 1 && r1.newly[0]!.name === 'draft_message');

  const r2 = apply_load_tools({ names: ['route'], catalog: CATALOG, hotNames, total_loaded: 0 });
  check('load: already-hot → already (not re-loaded)', r2.already.includes('route') && r2.newly.length === 0);

  const r3 = apply_load_tools({ names: ['nonexistent_tool'], catalog: CATALOG, hotNames, total_loaded: 0 });
  check('load: not in catalog → missing (never loaded — no escalation)', r3.missing.includes('nonexistent_tool') && r3.newly.length === 0);

  const r4 = apply_load_tools({ names: ['draft_message'], catalog: CATALOG, hotNames, total_loaded: MAX_TOTAL_LOADED });
  check('load: over per-turn budget → capped', r4.capped.includes('draft_message') && r4.newly.length === 0);

  check('load: result message names what loaded', format_load_tools_result(r1).includes('draft_message'));
}

// ── 5. _build_turn_surface: fail-open + happy path ──────────────────────────
const fakeTools = { list_for_capabilities: () => CATALOG } as unknown as ToolRegistry;
const mkSpec = (over: Record<string, unknown> = {}): LoadedSpecialist =>
  ({
    id: 'kate',
    granted: new Set<string>(),
    proactive: {
      dynamic_tools: true,
      tools_for_chat: ['sensor_calendar_upcoming', 'weather_now'],
      tools_for_voice: [],
      tools_for_deliberation: [],
      ...over,
    },
  }) as unknown as LoadedSpecialist;
const mkRuntime = (embedder: Embedder) =>
  new SpecialistRuntime({ tools: fakeTools, embedder } as unknown as SpecialistRuntimeDeps);

{
  // DEGRADED (2026-08-03): embeddings off, but the specialist is opted in →
  // keep the two-tier shape, don't collapse to "every curated schema ships".
  //
  // This assertion used to read `dynamic_on === false` + `hot === catalog ===
  // curated`. That contract was written when the only alternative to ranking
  // was the legacy curated surface — but it meant an embeddings outage
  // INFLATED the prompt to every curated tool's full schema (98 of them for
  // Kate, ~9.8K tokens) at the same moment the outage stripped RAG grounding
  // out of that prompt. Degraded mode keeps awareness + load_tools, so REACH
  // is unchanged and only the pre-loaded slice shrinks; what's lost is ranking
  // quality, not access.
  const rt = mkRuntime(new NoopEmbedder());
  const spec = mkSpec();
  const surface = await rt._test_build_turn_surface(spec, 'live', 'directions to the dentist');
  const curated = rt._test_curate_tools_for_turn(CATALOG, spec, 'live');
  check('degraded(embeddings off): still two-tier (dynamic_on=true)', surface.dynamic_on === true);
  check(
    'degraded: awareness is the FULL granted catalog — reach preserved',
    surface.catalog.length === CATALOG.length,
  );
  // The cap is the invariant that matters — NOT "hot ≤ curated". Degraded mode
  // also pins the knowledge floor, so for a specialist whose curated list is
  // tiny the slice can be slightly LARGER than the curated surface while still
  // being bounded. That is correct: the bound on prefill is MAX_HOT_TOOLS, and
  // the floor is what keeps a stranded turn from having no read path at all.
  check('degraded: hot respects the cap', surface.hot.length <= MAX_HOT_TOOLS);
  void curated;
  check(
    'degraded: floor still pinned hot',
    FLOOR_TOOL_NAMES.every((f) => surface.hot.some((t) => t.name === f)),
  );
  check(
    'degraded: hot ⊆ catalog',
    surface.hot.every((t) => surface.catalog.some((c) => c.name === t.name)),
  );
  // Deterministic: no embedder means no ranking, so the same inputs must give
  // the same slice regardless of the message.
  const other = await rt._test_build_turn_surface(spec, 'live', 'something else entirely');
  check('degraded: slice is deterministic across messages', eq(names(surface.hot), names(other.hot)));
}
{
  // The case degraded mode exists FOR: a curated list far larger than the cap.
  // The fixture above has 2 curated tools, so nothing can shrink; Kate has 98,
  // which under the old fail-open shipped 98 full JSON schemas. Build a spec
  // whose curated list is the whole catalog and assert the slice is bounded.
  const rt = mkRuntime(new NoopEmbedder());
  const big = mkSpec({ tools_for_chat: CATALOG.map((t) => t.name) });
  const surface = await rt._test_build_turn_surface(big, 'live', 'anything');
  const curated = rt._test_curate_tools_for_turn(CATALOG, big, 'live');
  check('degraded(large list): hot is strictly smaller than curated', surface.hot.length < curated.length);
  check('degraded(large list): reach preserved via full awareness', surface.catalog.length === CATALOG.length);
}
{
  // NOT opted in + embeddings off → unchanged legacy curated surface. The
  // degraded path must never touch a specialist that never asked for dynamic.
  const rt = mkRuntime(new NoopEmbedder());
  const spec = mkSpec({ dynamic_tools: false });
  const surface = await rt._test_build_turn_surface(spec, 'live', 'directions to the dentist');
  const curated = rt._test_curate_tools_for_turn(CATALOG, spec, 'live');
  check('not opted in + embeddings off: dynamic_on=false', surface.dynamic_on === false);
  check(
    'not opted in + embeddings off: hot === catalog === curated (byte-identical legacy)',
    eq(names(surface.hot), names(curated)) && eq(names(surface.catalog), names(curated)),
  );
}
{
  // Happy path: embeddings live, chat role → dynamic_on, full catalog, hot⊆catalog w/ floor.
  const rt = mkRuntime(fakeEmbedder);
  const spec = mkSpec();
  const s = await rt._test_build_turn_surface(spec, 'live', 'directions to the dentist');
  check('dynamic on: dynamic_on=true', s.dynamic_on === true);
  check('dynamic on: catalog is the FULL granted set', s.catalog.length === CATALOG.length);
  check('dynamic on: hot ⊆ catalog and capped', s.hot.length <= MAX_HOT_TOOLS && s.hot.every((t) => CATALOG.some((c) => c.name === t.name)));
  check('dynamic on: floor in hot', FLOOR_TOOL_NAMES.every((f) => s.hot.some((t) => t.name === f)));
  check('dynamic on: message-relevant tools in hot (route/nearby)', s.hot.some((t) => t.name === 'route') && s.hot.some((t) => t.name === 'nearby'));
  check('dynamic on: hot is SMALLER than catalog (the win)', s.hot.length < s.catalog.length);
}
{
  // Per-specialist floor (2026-07-15): dynamic_tools_floor pins a can't-miss
  // tool into the hot set even when the message ranks it nowhere (the Kate
  // "Call" turn: zero calendar tools hot → search_library spiral → blank turn).
  const rt = mkRuntime(fakeEmbedder);
  const spec = mkSpec({ dynamic_tools_floor: ['sensor_calendar_upcoming'] });
  const s = await rt._test_build_turn_surface(spec, 'live', 'directions to the dentist');
  check('specialist floor: pinned tool hot on an unrelated message', s.hot.some((t) => t.name === 'sensor_calendar_upcoming'));
  check('specialist floor: global floor still present', FLOOR_TOOL_NAMES.every((f) => s.hot.some((t) => t.name === f)));

  const rt2 = mkRuntime(fakeEmbedder);
  const s2 = await rt2._test_build_turn_surface(mkSpec({ dynamic_tools_floor: ['not_a_granted_tool'] }), 'live', 'directions to the dentist');
  check('specialist floor: ungranted name skipped, surface intact (capability-safe)', s2.dynamic_on === true && !s2.hot.some((t) => t.name === 'not_a_granted_tool'));
}
{
  // Voice parity (2026-07-08): voice_realtime now runs the dynamic surface too
  // (was hard-gated to the curated tools_for_voice list) — same reach as chat.
  const rt = mkRuntime(fakeEmbedder);
  const spec = mkSpec({ tools_for_voice: ['sensor_calendar_upcoming', 'weather_now'] });
  const s = await rt._test_build_turn_surface(spec, 'voice_realtime', 'directions to the dentist');
  check('voice parity: dynamic_on=true on voice_realtime', s.dynamic_on === true);
  check('voice parity: catalog is the FULL granted set', s.catalog.length === CATALOG.length);
  check(
    'voice parity: hot⊆catalog w/ floor',
    s.hot.length <= MAX_HOT_TOOLS && FLOOR_TOOL_NAMES.every((f) => s.hot.some((t) => t.name === f)),
  );
  const rt2 = mkRuntime(new NoopEmbedder());
  const s2 = await rt2._test_build_turn_surface(spec, 'voice_realtime', 'directions');
  // Voice degrades the same way — and matters MORE here, since voice prefill is
  // the dominant first-word latency cost.
  check('voice degraded: still two-tier when embeddings off', s2.dynamic_on === true);
  check('voice degraded: hot capped', s2.hot.length <= MAX_HOT_TOOLS);
  check('voice degraded: awareness is the full catalog', s2.catalog.length === CATALOG.length);
}
{
  // DELIBERATION now runs the two-tier surface too (2026-08-05). This assertion
  // used to read `dynamic_on === false (chat-only gate)`. That gate is what left
  // the one surface that needed this most paying full freight: Kate's 44
  // deliberation tools serialized to ~14,595 tokens, 43% of a static prompt the
  // runtime was already rejecting ("STATIC PROMPT TOO BIG — nothing was
  // evictable"). Thread compaction cannot touch that — a `trigger:` pass has no
  // thread — so the schemas had to shrink.
  //
  // A pass takes the DETERMINISTIC slice, never the ranked one: its "message" is
  // a multi-thousand-token context envelope whose cosine against a tool
  // description is noise, and a scheduled pass wants the same surface every
  // night rather than one reshuffled by whatever the envelope happened to say.
  const rt = mkRuntime(fakeEmbedder);
  const big = mkSpec({ tools_for_deliberation: CATALOG.map((t) => t.name) });
  const s = await rt._test_build_turn_surface(big, 'specialist_deliberation', 'directions');
  check('deliberation: two-tier when the surface exceeds the cap', s.dynamic_on === true);
  check('deliberation: hot is capped', s.hot.length <= MAX_HOT_TOOLS_DELIBERATION);
  check(
    'deliberation: awareness is the CURATED surface, not the full granted catalog',
    s.catalog.length <= big.proactive.tools_for_deliberation.length + FLOOR_TOOL_NAMES.length,
  );
  // Determinism: no ranking means the same slice regardless of the envelope.
  const s2 = await rt._test_build_turn_surface(big, 'specialist_deliberation', 'something else');
  check(
    'deliberation: slice is deterministic across envelopes',
    eq(names(s.hot), names(s2.hot)),
  );
}
{
  // A surface that already FITS under the cap stays byte-identical — no
  // awareness block, no load_tools, nothing to gain and a real cost to pay.
  const rt = mkRuntime(fakeEmbedder);
  const small = mkSpec({ tools_for_deliberation: ['route', 'nearby'] });
  const s = await rt._test_build_turn_surface(small, 'specialist_deliberation', 'directions');
  check('deliberation: a surface under the cap does NOT go two-tier', s.dynamic_on === false);
}
{
  // Env kill switch.
  const prev = process.env.HEARTH_DYNAMIC_TOOLS;
  process.env.HEARTH_DYNAMIC_TOOLS = '0';
  const rt = mkRuntime(fakeEmbedder);
  const s = await rt._test_build_turn_surface(mkSpec(), 'live', 'directions');
  check('env kill switch: HEARTH_DYNAMIC_TOOLS=0 → dynamic_on=false', s.dynamic_on === false);
  if (prev === undefined) delete process.env.HEARTH_DYNAMIC_TOOLS;
  else process.env.HEARTH_DYNAMIC_TOOLS = prev;
}
{
  // Not opted in → dynamic off.
  const rt = mkRuntime(fakeEmbedder);
  const s = await rt._test_build_turn_surface(mkSpec({ dynamic_tools: false }), 'live', 'directions');
  check('not opted in: dynamic_on=false', s.dynamic_on === false);
}

console.log(`\n${failures === 0 ? '✓' : '✗'} smoke-dynamic-tools: ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
