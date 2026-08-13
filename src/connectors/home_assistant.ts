import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';
import { require_caller_tier } from '@core/tool_gates';

const HA_BASE_URL = process.env.HA_BASE_URL ?? 'http://homeassistant.local:8123';
const HA_TOKEN = process.env.HA_TOKEN ?? '';

function ha_headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${HA_TOKEN}`,
  };
}

// ── ha_get_state ─────────────────────────────────────────────────────────

const GetStateInput = z.object({
  entity_id: z.string().min(1),
});

const GetStateOutput = z.object({
  entity_id: z.string(),
  state: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  last_changed: z.string().nullable(),
  error: z.string().optional(),
  /** When the requested entity_id 404s, the connector pulls all entities
   *  in the same domain and surfaces up to 10 close matches by shared-
   *  token overlap. The LLM reads this and retries against a real id
   *  instead of fabricating a value. Only set on 404. */
  candidates: z
    .array(z.object({ entity_id: z.string(), friendly_name: z.string().nullable() }))
    .optional(),
});

/**
 * Pull entities in `domain` from /api/states and rank by how many
 * non-trivial tokens they share with `wanted_id`. Returns up to `limit`
 * best matches with `entity_id` + `friendly_name`. Pure helper; no
 * audit, no caching — invoked only on the 404 recovery path so cost is
 * bounded to one /api/states call per failed read.
 */
async function _suggest_candidates_for_404(
  wanted_id: string,
  limit = 10,
): Promise<Array<{ entity_id: string; friendly_name: string | null }>> {
  const dot = wanted_id.indexOf('.');
  if (dot <= 0) return [];
  const domain = wanted_id.slice(0, dot);
  const leaf = wanted_id.slice(dot + 1).toLowerCase();
  const wanted_tokens = new Set(
    leaf
      .split(/[_\s-]+/)
      .filter((t) => t.length >= 3 && !/^\d+$/.test(t)),
  );
  if (wanted_tokens.size === 0) return [];

  const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/states`;
  const res = await safe_fetch(url, { headers: ha_headers() });
  if (!res.ok) return [];
  let arr: Array<{ entity_id: string; attributes?: { friendly_name?: string } }>;
  try {
    arr = JSON.parse(res.body) as Array<{
      entity_id: string;
      attributes?: { friendly_name?: string };
    }>;
  } catch {
    return [];
  }

  const scored: Array<{ entity_id: string; friendly_name: string | null; score: number }> = [];
  for (const e of arr) {
    if (!e.entity_id.startsWith(`${domain}.`)) continue;
    const e_leaf = e.entity_id.slice(domain.length + 1).toLowerCase();
    const e_tokens = new Set(
      e_leaf.split(/[_\s-]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t)),
    );
    let score = 0;
    for (const t of wanted_tokens) if (e_tokens.has(t)) score++;
    if (score === 0) continue;
    scored.push({
      entity_id: e.entity_id,
      friendly_name: e.attributes?.friendly_name ?? null,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ entity_id, friendly_name }) => ({
    entity_id,
    friendly_name,
  }));
}

export const ha_get_state: Tool<z.infer<typeof GetStateInput>, z.infer<typeof GetStateOutput>> = {
  name: 'ha_get_state',
  description:
    'Read the current state of a Home Assistant entity by entity_id (e.g. "sensor.front_door", "light.kitchen"). Returns state + attributes + last_changed timestamp. On a 404 (entity_id does not exist on this HA instance), also returns `candidates`: a list of close-match entity_ids in the same domain — retry against one of those instead of guessing again.',
  risk: 'read',
  required_capabilities: ['read_home_assistant'],
  input_schema: GetStateInput,
  output_schema: GetStateOutput,

  idempotency_key(input) {
    return `ha_get_state:${createHash('sha256').update(input.entity_id).digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext) {
    // HA exposes whole-house state — HVAC, lights, sensors — household
    // members legitimately need read access. Friend tier gets refused
    // because individual entity reads can include Jasper-specific
    // sensors (`device_tracker.jasons_phone`, EV-charge entities, etc.).
    require_caller_tier(ctx, ['owner', 'household']);

    if (!HA_TOKEN) {
      return {
        entity_id: input.entity_id,
        state: null,
        attributes: {},
        last_changed: null,
        error: 'HA_TOKEN not configured',
      };
    }
    const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/states/${encodeURIComponent(input.entity_id)}`;
    const res = await safe_fetch(url, { headers: ha_headers() });
    if (!res.ok) {
      const base = {
        entity_id: input.entity_id,
        state: null,
        attributes: {},
        last_changed: null,
        error: res.error ?? `HA HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
      if (res.status === 404) {
        const candidates = await _suggest_candidates_for_404(input.entity_id);
        if (candidates.length > 0) return { ...base, candidates };
      }
      return base;
    }
    try {
      const json = JSON.parse(res.body) as {
        state?: string;
        attributes?: Record<string, unknown>;
        last_changed?: string;
      };
      return {
        entity_id: input.entity_id,
        state: json.state ?? null,
        attributes: json.attributes ?? {},
        last_changed: json.last_changed ?? null,
      };
    } catch (err) {
      return {
        entity_id: input.entity_id,
        state: null,
        attributes: {},
        last_changed: null,
        error: `Failed to parse HA response: ${(err as Error).message}`,
      };
    }
  },
};

// `ha_get_my_location` removed 2026-05-30. The HA Companion iOS app on
// Jasper's phone was the data source; Hearth's iOS app is the
// replacement, but routes phone-as-sensor signals directly into the
// orchestrator rather than via HA. See [the private shipped-log archive].

interface HARawState {
  state?: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export async function fetch_ha_state(entity_id: string): Promise<HARawState | null> {
  const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/states/${encodeURIComponent(entity_id)}`;
  const res = await safe_fetch(url, { headers: ha_headers() });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.body) as HARawState;
  } catch {
    return null;
  }
}

/** One full-state row as HA's `/api/states` returns it. */
export interface HAEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

/**
 * Fetch the WHOLE `/api/states` dump in one call. A reusable building
 * block for any connector that resolves several entities at once (the
 * Tempest weather-station connector reads ~20 sensors per current-
 * conditions read; one dump + a local map beats 20 per-entity calls and
 * also yields the `candidates` list for free when entities are absent).
 *
 * Returns a tagged result rather than `null` so the caller can tell
 * "HA_TOKEN not set" (operator action) apart from "HA unreachable"
 * (transient) and surface the right recovery hint — mirrors
 * `fetch_brief_weather`'s shape in the weather connector.
 */
export async function fetch_ha_all_states(): Promise<
  { ok: true; states: HAEntityState[] } | { ok: false; reason: string }
> {
  if (!HA_TOKEN) return { ok: false, reason: 'HA_TOKEN not configured' };
  const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/states`;
  const res = await safe_fetch(url, { headers: ha_headers() });
  if (!res.ok) return { ok: false, reason: res.error ?? `HA HTTP ${res.status}` };
  try {
    return { ok: true, states: JSON.parse(res.body) as HAEntityState[] };
  } catch (err) {
    return { ok: false, reason: `Failed to parse HA /api/states: ${(err as Error).message}` };
  }
}

/**
 * Which HA AREA each entity belongs to, resolved live.
 *
 * The area registry is not exposed over the REST API at all — it lives in
 * `.storage/core.area_registry`, which a container cannot read. The template
 * endpoint is the one supported way in: `areas()` + `area_entities()` render
 * the whole map server-side in a single call (19 areas / ~273 assigned
 * entities here), so nothing has to snapshot a registry file and go stale
 * when a device is re-homed.
 *
 * Areas are what let a surface ask "what is in the room I'm standing in"
 * without hard-coding entity ids — and the id slug is NOT a substitute, since
 * `media_player.loft_speaker` is named "Foyer Speaker" and lives in the Loft.
 */
export async function fetch_ha_area_map(): Promise<
  { ok: true; by_entity: Map<string, string>; areas: string[] } | { ok: false; reason: string }
> {
  if (!HA_TOKEN) return { ok: false, reason: 'HA_TOKEN not configured' };

  const template =
    '{% set ns = namespace(out=[]) %}' +
    '{% for a in areas() %}' +
    '{% set ns.out = ns.out + [{"area": area_name(a), "entities": area_entities(a)}] %}' +
    '{% endfor %}{{ ns.out | to_json }}';

  const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/template`;
  const res = await safe_fetch(url, {
    method: 'POST',
    headers: ha_headers(),
    body: JSON.stringify({ template }),
  });
  if (!res.ok) return { ok: false, reason: res.error ?? `HA HTTP ${res.status}` };

  try {
    const rows = JSON.parse(res.body) as { area: string; entities: string[] }[];
    const by_entity = new Map<string, string>();
    for (const row of rows) for (const e of row.entities) by_entity.set(e, row.area);
    return { ok: true, by_entity, areas: rows.map((r) => r.area) };
  } catch (err) {
    return { ok: false, reason: `Failed to parse HA area template: ${(err as Error).message}` };
  }
}

/**
 * A single still from a camera entity.
 *
 * Deliberately NOT routed through `safe_fetch`: that helper reads the body as
 * text, which corrupts a JPEG. Same timeout and same fail-tagged shape,
 * bytes instead of a string.
 */
export async function fetch_ha_camera_snapshot(
  entity_id: string,
  timeout_ms = 15_000,
): Promise<
  { ok: true; bytes: Uint8Array<ArrayBuffer>; content_type: string } | { ok: false; reason: string }
> {
  if (!HA_TOKEN) return { ok: false, reason: 'HA_TOKEN not configured' };
  const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/camera_proxy/${encodeURIComponent(entity_id)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(timeout_ms),
    });
    if (!res.ok) return { ok: false, reason: `HA HTTP ${res.status}` };
    return {
      ok: true,
      bytes: new Uint8Array(await res.arrayBuffer()),
      content_type: res.headers.get('content-type') ?? 'image/jpeg',
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** One recorder-history row as HA's `/api/history/period` returns it. */
export interface HAHistoryPoint {
  state: string;
  last_changed: string;
  /** Present on full-fidelity fetches; `minimal_response` omits it on all
   *  but each entity's first point. */
  attributes?: Record<string, unknown>;
}

/**
 * Fetch recorder HISTORY for a set of entities — `GET /api/history/period/
 * <start>` — the time-dimension sibling of `fetch_ha_all_states`. Used by
 * `house_thermal_history` (HVAC duty cycle + heat-loss fits over the last
 * N hours).
 *
 * Options map to the endpoint's honesty-relevant knobs:
 *   - `minimal` → `minimal_response`: state + last_changed only (cheap; right
 *     for numeric sensor series).
 *   - `significant_only: false` → `significant_changes_only=0`: EVERY
 *     recorded point. Required when the signal lives in ATTRIBUTES (a
 *     climate entity's `hvac_action` changes while its state string does
 *     not) — the default significance filter would drop exactly those rows.
 *
 * Coverage is bounded by the recorder's retention (default ~10 days) — a
 * start before retention returns what exists, silently shorter; callers own
 * that honesty (see house_thermal's `caveats`). Tagged result like its
 * siblings so callers can tell "not configured" from "unreachable".
 */
export async function fetch_ha_history(
  entity_ids: string[],
  start_iso: string,
  opts: { end_iso?: string; minimal?: boolean; significant_only?: boolean } = {},
): Promise<
  { ok: true; history: Record<string, HAHistoryPoint[]> } | { ok: false; reason: string }
> {
  if (!HA_TOKEN) return { ok: false, reason: 'HA_TOKEN not configured' };
  if (entity_ids.length === 0) return { ok: true, history: {} };
  const params = new URLSearchParams();
  params.set('filter_entity_id', entity_ids.join(','));
  if (opts.end_iso) params.set('end_time', opts.end_iso);
  if (opts.minimal) params.set('minimal_response', '');
  if (opts.significant_only === false) params.set('significant_changes_only', '0');
  const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/history/period/${encodeURIComponent(start_iso)}?${params.toString()}`;
  const res = await safe_fetch(url, { headers: ha_headers() });
  if (!res.ok) return { ok: false, reason: res.error ?? `HA HTTP ${res.status}` };
  try {
    const arr = JSON.parse(res.body) as Array<
      Array<{
        entity_id?: string;
        state?: string;
        last_changed?: string;
        last_updated?: string;
        attributes?: Record<string, unknown>;
      }>
    >;
    const history: Record<string, HAHistoryPoint[]> = {};
    for (const series of arr) {
      if (!Array.isArray(series)) continue;
      // minimal_response carries entity_id only on each entity's FIRST point.
      const id = series[0]?.entity_id;
      if (!id) continue;
      history[id] = series
        .map((p) => {
          // ⚠ HA semantics: `last_changed` moves ONLY when the STATE string
          // changes; an attribute-only update (a climate entity's hvac_action
          // / current_temperature — the interesting parts) moves
          // `last_updated`. Reading last_changed collapses every attribute
          // row onto the last mode flip's instant (live-caught 2026-07-14:
          // 25 climate rows all stamped alike → fake 100% coverage, zero
          // duty). Prefer last_updated; sensors are identical either way.
          const ts = p.last_updated ?? p.last_changed;
          if (typeof p.state !== 'string' || typeof ts !== 'string') return null;
          return {
            state: p.state,
            last_changed: ts,
            ...(p.attributes ? { attributes: p.attributes } : {}),
          };
        })
        .filter((p): p is HAHistoryPoint => p !== null);
    }
    return { ok: true, history };
  } catch (err) {
    return { ok: false, reason: `Failed to parse HA history: ${(err as Error).message}` };
  }
}

/**
 * Call a Home Assistant SERVICE — `POST /api/services/<domain>/<service>` with a
 * JSON body (entity targeting + service data). The one WRITE primitive into HA.
 *
 * Deliberately NOT a model-facing tool: it's a code-level helper for DETERMINISTIC
 * safety output (the emergency red-light flash), the same way the EBS tone/push
 * are composed in code, not chosen by the LLM. Keeping arbitrary HA control off
 * the small model's surface bounds the blast radius. Fail-tagged like
 * `fetch_ha_all_states` so callers can distinguish "not configured" from a
 * transient HTTP error and stay fail-open.
 */
export async function ha_call_service(
  domain: string,
  service: string,
  data: Record<string, unknown> = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!HA_TOKEN) return { ok: false, reason: 'HA_TOKEN not configured' };
  const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
  const res = await safe_fetch(url, {
    method: 'POST',
    headers: ha_headers(),
    body: JSON.stringify(data),
  });
  if (!res.ok) return { ok: false, reason: res.error ?? `HA HTTP ${res.status}` };
  return { ok: true };
}

// ── ha_list_entities ─────────────────────────────────────────────────────

const ListEntitiesInput = z.object({
  domain: z.string().optional(),
  /** Case-insensitive substring filter on entity_id AND friendly_name.
   *  Use this to scope a large domain (e.g. ~140 sensors) to the handful
   *  you actually care about — "soil" / "Bed 2" / "ioniq" — so the
   *  result fits inside the next-round context window. Without it, the
   *  full list often gets truncated before the interesting entities. */
  name_contains: z.string().min(1).optional(),
  /** Hard cap on returned entities. Defaults to 50 — enough to see a
   *  domain's worth of sensors at a glance, low enough that the result
   *  fits inside the runtime's tool-result context cap. */
  limit: z.coerce.number().int().positive().max(500).default(50),
});

const EntitySchema = z.object({
  entity_id: z.string(),
  state: z.string().nullable(),
  friendly_name: z.string().nullable(),
});

const ListEntitiesOutput = z.object({
  entities: z.array(EntitySchema),
  /** Set when results were trimmed by `limit`. Tells the model "narrow
   *  your filter or raise the limit" rather than silently dropping
   *  matches. */
  truncated: z.boolean().optional(),
  total_matched: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

// NOTE: the HA-CalDAV calendar tools (ha_calendar_query read +
// ha_calendar_create_event write) were RETIRED 2026-06-14 per
// BACKEND_HA_CALDAV_DEPRECATION_BRIEF. Calendar READS now come from the
// iOS calendar snapshot (sensor_calendar_* tools in
// src/connectors/sensor_calendar.ts; Iris's plan_ev_day reads the same
// store directly); calendar WRITES go through Kate's
// schedule_calendar_event → iOS EventKit proposal path. No server-side
// Apple/CalDAV credentials remain.

export const ha_list_entities: Tool<
  z.infer<typeof ListEntitiesInput>,
  z.infer<typeof ListEntitiesOutput>
> = {
  name: 'ha_list_entities',
  description:
    'List Home Assistant entities, optionally filtered by `domain` (e.g. "light", "sensor", "binary_sensor") and/or `name_contains` (case-insensitive substring matched against both entity_id and friendly_name — use this to scope to e.g. "soil" or "Bed 2"). Returns entity_id, state, and friendly_name. Default limit is 50; set `truncated:true` when more matched than fit.',
  risk: 'read',
  required_capabilities: ['read_home_assistant'],
  input_schema: ListEntitiesInput,
  output_schema: ListEntitiesOutput,

  idempotency_key(input) {
    return `ha_list_entities:${input.domain ?? '*'}:${(input.name_contains ?? '').toLowerCase()}:${input.limit ?? 50}`;
  },

  async execute(input, ctx: ToolContext) {
    // Same tier policy as ha_get_state — entity discovery can surface
    // Jasper-specific device_tracker / sensor entities, so friend tier
    // gets refused.
    require_caller_tier(ctx, ['owner', 'household']);

    if (!HA_TOKEN) {
      return {
        entities: [],
        error: 'HA_TOKEN not configured',
      };
    }
    const url = `${HA_BASE_URL.replace(/\/$/, '')}/api/states`;
    const res = await safe_fetch(url, { headers: ha_headers() });
    if (!res.ok) {
      return {
        entities: [],
        error: res.error ?? `HA HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    try {
      const arr = JSON.parse(res.body) as Array<{
        entity_id: string;
        state?: string;
        attributes?: { friendly_name?: string };
      }>;
      const prefix = input.domain ? `${input.domain}.` : '';
      const needle = input.name_contains?.toLowerCase();
      const all = arr
        .filter((e) => !prefix || e.entity_id.startsWith(prefix))
        .map((e) => ({
          entity_id: e.entity_id,
          state: e.state ?? null,
          friendly_name: e.attributes?.friendly_name ?? null,
        }))
        .filter((e) => {
          if (!needle) return true;
          if (e.entity_id.toLowerCase().includes(needle)) return true;
          if (e.friendly_name?.toLowerCase().includes(needle)) return true;
          return false;
        });
      const limit = input.limit;
      const entities = all.slice(0, limit);
      const truncated = all.length > entities.length;
      // Order matters: truncated + total_matched go BEFORE entities so
      // the runtime's tool-result compaction (see
      // src/core/tool_result_compaction.ts) doesn't cut them off when
      // the entity list is large. The model needs to see
      // "truncated:true, total_matched:140" to know to re-call with
      // name_contains.
      return truncated
        ? { truncated, total_matched: all.length, entities }
        : { entities };
    } catch (err) {
      return {
        entities: [],
        error: `Failed to parse HA response: ${(err as Error).message}`,
      };
    }
  },
};
