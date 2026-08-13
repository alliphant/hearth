/**
 * mealie.ts — connector for the household's self-hosted Mealie recipe
 * manager (running in docker on the always-on host at http://localhost:9925/api/).
 *
 * Brigid is the primary consumer. Five tools, two read + three write:
 *
 *   mealie_search_recipes        — filter the library by name + tags
 *   mealie_get_recipe            — full detail for one slug
 *   mealie_get_meal_plan_history — what dinners landed on recent dates
 *   mealie_set_meal_plan         — publish a week of dinner entries
 *   mealie_import_recipe_url     — scrape a URL into the library, fire-
 *                                  and-forget a friday-sdxl thumb job
 *
 * Auth is the long-lived MEALIE_TOKEN already provisioned in mint's
 * docker-compose for the friday-sdxl service (recipe-thumb orchestrator)
 * — reused here so there is one credential surface for the household's
 * Mealie. If the env is unset the tools return a clean "not configured"
 * error rather than throwing, matching the *arr connector's pattern.
 *
 * Capability gating:
 *   read tools     → required_capabilities: [read_meal_plan]
 *   set_meal_plan  → required_capabilities: [write_meal_plan]
 *   import_recipe  → required_capabilities: [manage_recipes]
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';
import { local_iso_date } from '@core/time';

const MEALIE_BASE_URL = (process.env.MEALIE_BASE_URL ?? 'http://localhost:9925').replace(/\/+$/, '');
const MEALIE_TOKEN = process.env.MEALIE_TOKEN ?? '';
const SDXL_BASE_URL = (process.env.FRIDAY_SDXL_BASE_URL ?? 'http://localhost:8790').replace(/\/+$/, '');

interface MealieResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

async function mealie_fetch<T = unknown>(
  path: string,
  init: RequestInit = {},
  timeout_ms = 20_000,
): Promise<MealieResult<T>> {
  if (!MEALIE_TOKEN) {
    return {
      ok: false,
      error:
        'Mealie is not configured — set MEALIE_TOKEN (and optionally ' +
        'MEALIE_BASE_URL) in Hearth\'s .env and restart the orchestrator.',
    };
  }
  const res = await safe_fetch(
    `${MEALIE_BASE_URL}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${MEALIE_TOKEN}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    timeout_ms,
  );
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error ?? `Mealie HTTP ${res.status}: ${res.body.slice(0, 300)}`,
    };
  }
  if (!res.body) {
    return { ok: true, status: res.status, data: null as unknown as T };
  }
  try {
    return { ok: true, status: res.status, data: JSON.parse(res.body) as T };
  } catch {
    // Some endpoints (recipe import) return a bare string slug.
    return { ok: true, status: res.status, data: res.body as unknown as T };
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── mealie_search_recipes ────────────────────────────────────────────────

const SearchInput = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe('Free-text search across recipe names. Omit to list by tag or just page through the library.'),
  tags: z
    .array(z.string().min(1).max(80))
    .max(8)
    .optional()
    .describe('Filter by tag slugs OR names (e.g. ["weeknight", "chicken"]). All listed tags must match.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(12)
    .describe('Max number of recipes to return (1-50). Default 12 — enough for a week of options.'),
});

const RecipeSummary = z.object({
  slug: z.string().describe('Stable URL-safe id — pass this to mealie_get_recipe / mealie_set_meal_plan.'),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).describe('Tag names (not slugs) for human readability.'),
  total_time: z.string().nullable().describe('Free-form total time string from the recipe, or null.'),
  rating: z.number().nullable(),
  last_made: z.string().nullable().describe('ISO date the recipe was last cooked, or null if never tagged.'),
});

const SearchOutput = z.object({
  total: z.number(),
  returned: z.number(),
  recipes: z.array(RecipeSummary),
  error: z.string().optional(),
});

type SearchInputT = z.infer<typeof SearchInput>;
type SearchOutputT = z.infer<typeof SearchOutput>;

function normalize_summary(o: Record<string, unknown>): z.infer<typeof RecipeSummary> {
  const tags_raw = Array.isArray(o.tags) ? (o.tags as Array<Record<string, unknown>>) : [];
  const tags = tags_raw.map((t) => str(t.name) || str(t.slug)).filter((s) => s.length > 0);
  return {
    slug: str(o.slug),
    name: str(o.name),
    description: str(o.description).slice(0, 400),
    tags,
    total_time: typeof o.totalTime === 'string' && o.totalTime ? o.totalTime : null,
    rating: num(o.rating),
    last_made: typeof o.lastMade === 'string' && o.lastMade ? o.lastMade : null,
  };
}

export const mealie_search_recipes: Tool<SearchInputT, SearchOutputT> = {
  name: 'mealie_search_recipes',
  description:
    'Search the household Mealie recipe library by free-text query and/or tags. Returns lightweight summaries — name, slug, tags, total time, rating, last_made. Use the slug with mealie_get_recipe for the full ingredient list, or with mealie_set_meal_plan to schedule. `tags` matches all listed names case-insensitively. `limit` defaults to 12.',
  risk: 'read',
  required_capabilities: ['read_meal_plan'],
  input_schema: SearchInput,
  output_schema: SearchOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.query ?? '');
    h.update('\n');
    h.update((input.tags ?? []).slice().sort().join(','));
    h.update('\n');
    h.update(String(input.limit ?? 12));
    return `mealie_search_recipes:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, _ctx: ToolContext): Promise<SearchOutputT> {
    const params = new URLSearchParams();
    params.set('perPage', String(input.limit));
    if (input.query) params.set('search', input.query);
    for (const t of input.tags ?? []) params.append('tags', t);

    const res = await mealie_fetch<{ items?: unknown[]; total?: number }>(
      `/api/recipes?${params.toString()}`,
    );
    if (!res.ok) return { total: 0, returned: 0, recipes: [], error: res.error };
    const items = Array.isArray(res.data?.items) ? res.data!.items : [];
    const recipes = items.slice(0, input.limit).map((r) => normalize_summary((r ?? {}) as Record<string, unknown>));
    return { total: num(res.data?.total) ?? recipes.length, returned: recipes.length, recipes };
  },
};

// ── mealie_get_recipe ────────────────────────────────────────────────────

const GetInput = z.object({
  slug: z
    .string()
    .min(1)
    .max(200)
    .describe('The recipe slug (e.g. "rosemary-roasted-potatoes"). Get this from a mealie_search_recipes result or a mealie_import_recipe_url return.'),
});

const Ingredient = z.object({
  display: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  food: z.string().nullable(),
  note: z.string().nullable(),
});

const RecipeDetail = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  servings: z.number().nullable(),
  total_time: z.string().nullable(),
  prep_time: z.string().nullable(),
  cook_time: z.string().nullable(),
  tags: z.array(z.string()),
  categories: z.array(z.string()),
  ingredients: z.array(Ingredient),
  instructions: z.array(z.string()),
  notes: z.array(z.string()),
  source_url: z.string().nullable(),
  rating: z.number().nullable(),
  last_made: z.string().nullable(),
  image_url: z.string().nullable(),
  error: z.string().optional(),
});

type GetInputT = z.infer<typeof GetInput>;
type GetOutputT = z.infer<typeof RecipeDetail>;

function normalize_detail(o: Record<string, unknown>): GetOutputT {
  const tags_raw = Array.isArray(o.tags) ? (o.tags as Array<Record<string, unknown>>) : [];
  const cats_raw = Array.isArray(o.recipeCategory) ? (o.recipeCategory as Array<Record<string, unknown>>) : [];
  const ings_raw = Array.isArray(o.recipeIngredient) ? (o.recipeIngredient as Array<Record<string, unknown>>) : [];
  const inst_raw = Array.isArray(o.recipeInstructions) ? (o.recipeInstructions as Array<Record<string, unknown>>) : [];
  const notes_raw = Array.isArray(o.notes) ? (o.notes as Array<Record<string, unknown>>) : [];
  const slug = str(o.slug);
  return {
    slug,
    name: str(o.name),
    description: str(o.description),
    servings: num(o.recipeServings),
    total_time: typeof o.totalTime === 'string' && o.totalTime ? o.totalTime : null,
    prep_time: typeof o.prepTime === 'string' && o.prepTime ? o.prepTime : null,
    cook_time: typeof o.cookTime === 'string' && o.cookTime ? o.cookTime : null,
    tags: tags_raw.map((t) => str(t.name) || str(t.slug)).filter((s) => s.length > 0),
    categories: cats_raw.map((c) => str(c.name) || str(c.slug)).filter((s) => s.length > 0),
    ingredients: ings_raw.map((i) => ({
      display: str(i.display) || str(i.note),
      quantity: num(i.quantity),
      unit: i.unit && typeof i.unit === 'object' ? str((i.unit as Record<string, unknown>).name) || null : null,
      food: i.food && typeof i.food === 'object' ? str((i.food as Record<string, unknown>).name) || null : null,
      note: typeof i.note === 'string' && i.note ? i.note : null,
    })),
    instructions: inst_raw.map((i) => str(i.text)).filter((s) => s.length > 0),
    notes: notes_raw.map((n) => str(n.text)).filter((s) => s.length > 0),
    source_url: typeof o.orgURL === 'string' && o.orgURL ? o.orgURL : null,
    rating: num(o.rating),
    last_made: typeof o.lastMade === 'string' && o.lastMade ? o.lastMade : null,
    // Mealie returns a relative `image` token; build the absolute URL.
    image_url: typeof o.image === 'string' && o.image && o.image !== 'none'
      ? `${MEALIE_BASE_URL}/api/media/recipes/${str(o.id)}/images/original.webp`
      : null,
  };
}

export const mealie_get_recipe: Tool<GetInputT, GetOutputT> = {
  name: 'mealie_get_recipe',
  description:
    'Fetch the full record for one recipe — ingredients, instructions, servings, times, tags, categories, source URL, last_made. Pass the `slug` returned by mealie_search_recipes (or by mealie_import_recipe_url after a save). Use when planning a meal that needs the ingredient list, not just the title.',
  risk: 'read',
  required_capabilities: ['read_meal_plan'],
  input_schema: GetInput,
  output_schema: RecipeDetail,

  idempotency_key(input) {
    return `mealie_get_recipe:${input.slug}`;
  },

  async execute(input, _ctx: ToolContext): Promise<GetOutputT> {
    const res = await mealie_fetch<Record<string, unknown>>(
      `/api/recipes/${encodeURIComponent(input.slug)}`,
    );
    if (!res.ok) {
      return {
        slug: input.slug,
        name: '',
        description: '',
        servings: null,
        total_time: null,
        prep_time: null,
        cook_time: null,
        tags: [],
        categories: [],
        ingredients: [],
        instructions: [],
        notes: [],
        source_url: null,
        rating: null,
        last_made: null,
        image_url: null,
        error: res.error,
      };
    }
    return normalize_detail(res.data ?? {});
  },
};

// ── mealie_get_meal_plan_history ────────────────────────────────────────

const HistoryInput = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(180)
    .default(28)
    .describe('How many days back from today to fetch. Default 28 (four weeks — long enough to see rotation, short enough to stay fast).'),
  future_days: z.coerce
    .number()
    .int()
    .min(0)
    .max(180)
    .default(0)
    .describe('Days FORWARD from today to also include. Default 0 (history only). Set to 7-14 to see the current draft week alongside recent history.'),
});

const PlanEntry = z.object({
  id: z.number(),
  date: z.string().describe('YYYY-MM-DD'),
  slot: z.string().describe('Mealie entryType: "breakfast" | "lunch" | "dinner" | "side". Brigid only writes "dinner".'),
  recipe_slug: z.string().nullable().describe('null when the entry is free-text (takeout, leftovers).'),
  title: z.string().nullable(),
  note: z.string().nullable(),
});

const HistoryOutput = z.object({
  window: z.object({ start: z.string(), end: z.string() }),
  count: z.number(),
  entries: z.array(PlanEntry),
  error: z.string().optional(),
});

type HistoryInputT = z.infer<typeof HistoryInput>;
type HistoryOutputT = z.infer<typeof HistoryOutput>;

function iso_date_offset(offset_days: number): string {
  // Day arithmetic in Denver: "tomorrow" means tomorrow on the user's
  // calendar, not on UTC's. 24h * offset is the simplest approximation;
  // DST transition days drift by an hour relative to local midnight,
  // but the local_iso_date wrap pins the result to the correct local day.
  const d = new Date(Date.now() + offset_days * 86_400_000);
  return local_iso_date(d);
}

function normalize_plan_entry(o: Record<string, unknown>): z.infer<typeof PlanEntry> {
  const recipe_obj = o.recipe && typeof o.recipe === 'object' ? (o.recipe as Record<string, unknown>) : null;
  const slug = recipe_obj ? str(recipe_obj.slug) : '';
  return {
    id: num(o.id) ?? 0,
    date: str(o.date),
    slot: str(o.entryType),
    recipe_slug: slug ? slug : null,
    title: typeof o.title === 'string' && o.title ? o.title : null,
    note: typeof o.text === 'string' && o.text ? o.text : null,
  };
}

export const mealie_get_meal_plan_history: Tool<HistoryInputT, HistoryOutputT> = {
  name: 'mealie_get_meal_plan_history',
  description:
    "Read recent meal-plan entries from Mealie — what dinners (and any other slots) landed on which dates over the last N days. Use before drafting a new week to avoid back-to-back repeats and to spot rotation gaps. Returns date + slot + recipe_slug (or free-text title/note for non-recipe entries like takeout).",
  risk: 'read',
  required_capabilities: ['read_meal_plan'],
  input_schema: HistoryInput,
  output_schema: HistoryOutput,

  idempotency_key(input) {
    return `mealie_get_meal_plan_history:${input.days}:${input.future_days}`;
  },

  async execute(input, _ctx: ToolContext): Promise<HistoryOutputT> {
    // Defaults from the Zod schema are applied by the registry's
    // safeParse; if a caller bypasses parsing (smoke tests, direct
    // invocation) we apply them defensively here too.
    const days = Number.isFinite(input.days) ? input.days : 28;
    const future_days = Number.isFinite(input.future_days) ? input.future_days : 0;
    const start = iso_date_offset(-days);
    const end = iso_date_offset(future_days);
    const params = new URLSearchParams();
    params.set('start_date', start);
    params.set('end_date', end);
    params.set('perPage', '200');
    const res = await mealie_fetch<{ items?: unknown[] }>(
      `/api/households/mealplans?${params.toString()}`,
    );
    if (!res.ok) {
      return { window: { start, end }, count: 0, entries: [], error: res.error };
    }
    const items = Array.isArray(res.data?.items) ? res.data!.items : [];
    const entries = items.map((r) => normalize_plan_entry((r ?? {}) as Record<string, unknown>));
    return { window: { start, end }, count: entries.length, entries };
  },
};

// ── mealie_set_meal_plan ─────────────────────────────────────────────────

const PlanSlotEnum = z.enum(['breakfast', 'lunch', 'dinner', 'side']);

// NOTE: no `.regex()` on the date fields — a tool input_schema becomes a GBNF
// grammar on the interactive 9B, and llama.cpp's converter mistranslates a
// regex `pattern` and SILENTLY disables the whole tool grammar (it then
// generates unconstrained, with no validation error to recover from). The
// YYYY-MM-DD shape is validated in execute() instead and returned as a typed
// error.
const MealEntryInput = z.object({
  date: z.string().describe('YYYY-MM-DD calendar date for this slot.'),
  slot: PlanSlotEnum.default('dinner').describe('Mealie entryType. Brigid almost always passes "dinner".'),
  recipe_slug: z
    .string()
    .max(200)
    .optional()
    .describe('Mealie slug to schedule. Omit when the slot is takeout / leftovers / freeform — pass `title` instead.'),
  title: z
    .string()
    .max(200)
    .optional()
    .describe('Free-text title shown in Mealie when no recipe_slug. Use for "Takeout — Thai", "Leftovers — Sunday\'s pot roast", "Out — birthday dinner".'),
  note: z
    .string()
    .max(500)
    .optional()
    .describe('Optional one-line note attached to the entry — for "doubled, planned leftovers for Wed lunch" etc.'),
});

const SetPlanInput = z.object({
  start_date: z
    .string()
    .describe("Anchor date of the week being published (YYYY-MM-DD) — used for the vault plan-summary filename and for the audit envelope. Each entry's own `date` is what actually drives Mealie."),
  meals: z
    .array(MealEntryInput)
    .min(1)
    .max(28)
    .describe('The entries to publish. A standard weekly run = 7 dinners. Each entry creates one Mealie meal-plan row.'),
  replace_existing: z
    .boolean()
    .default(true)
    .describe('When true (default), delete any existing entries for the same (date, slot) tuples before inserting — so a redraft of the week cleanly overwrites Brigid\'s previous draft. False appends.'),
});

const MealPlanResultEntry = z.object({
  date: z.string(),
  slot: z.string(),
  recipe_slug: z.string().nullable(),
  title: z.string().nullable(),
  ok: z.boolean(),
  mealie_id: z.number().nullable(),
  error: z.string().nullable(),
});

const SetPlanOutput = z.object({
  start_date: z.string(),
  total_requested: z.number(),
  total_created: z.number(),
  total_replaced: z.number(),
  results: z.array(MealPlanResultEntry),
  error: z.string().optional(),
});

type SetPlanInputT = z.infer<typeof SetPlanInput>;
type SetPlanOutputT = z.infer<typeof SetPlanOutput>;

export const mealie_set_meal_plan: Tool<SetPlanInputT, SetPlanOutputT> = {
  name: 'mealie_set_meal_plan',
  description:
    "Publish a batch of meal-plan entries into Mealie. Each entry is one row keyed by (date, slot); pass `recipe_slug` for a library recipe or `title` for freeform (takeout / leftovers / out). When `replace_existing` is true (default) Brigid's redraft cleanly overwrites the same week. Use this AFTER Jasper has approved the draft — there is no separate approval gate on this tool. Returns per-entry success so the LLM can confirm what landed and what fell through.",
  risk: 'write_internal',
  required_capabilities: ['write_meal_plan'],
  input_schema: SetPlanInput,
  output_schema: SetPlanOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.start_date);
    for (const m of input.meals) {
      h.update('\n');
      h.update(`${m.date}|${m.slot}|${m.recipe_slug ?? ''}|${m.title ?? ''}|${m.note ?? ''}`);
    }
    return `mealie_set_meal_plan:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, _ctx: ToolContext): Promise<SetPlanOutputT> {
    // Shape-check the dates here (moved off the schema to keep it grammar-safe).
    // A malformed date would poison the Mealie query params + POST bodies, so
    // reject the whole batch with a typed error before any write.
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const bad_dates = [
      ...(ymd.test(input.start_date) ? [] : [`start_date "${input.start_date}"`]),
      ...input.meals
        .map((m, i) => (ymd.test(m.date) ? null : `meals[${i}].date "${m.date}"`))
        .filter((x): x is string => x !== null),
    ];
    if (bad_dates.length > 0) {
      return {
        start_date: input.start_date,
        total_requested: input.meals.length,
        total_created: 0,
        total_replaced: 0,
        results: [],
        error: `dates must be YYYY-MM-DD; got ${bad_dates.join(', ')}.`,
      };
    }

    let total_replaced = 0;

    // 1. Optionally clear existing (date, slot) entries so a redraft of
    //    the same week doesn't double-book. We compute the (date, slot)
    //    tuple set, fetch the current week's entries with one paged
    //    query, and DELETE any that match.
    if (input.replace_existing) {
      const dates = Array.from(new Set(input.meals.map((m) => m.date))).sort();
      if (dates.length > 0) {
        const start = dates[0]!;
        const end = dates[dates.length - 1]!;
        const want = new Set(input.meals.map((m) => `${m.date}|${m.slot ?? 'dinner'}`));
        const existing = await mealie_fetch<{ items?: Array<Record<string, unknown>> }>(
          `/api/households/mealplans?start_date=${start}&end_date=${end}&perPage=200`,
        );
        if (existing.ok && Array.isArray(existing.data?.items)) {
          for (const row of existing.data!.items!) {
            const key = `${str(row.date)}|${str(row.entryType)}`;
            const id = num(row.id);
            if (id != null && want.has(key)) {
              const del = await mealie_fetch(`/api/households/mealplans/${id}`, { method: 'DELETE' });
              if (del.ok) total_replaced++;
            }
          }
        }
      }
    }

    // 2. Resolve recipe_slug → recipeId for entries that name a recipe.
    //    Mealie's mealplan POST takes recipeId (uuid), not slug, when
    //    you want the recipe link. We look each one up; an unknown slug
    //    falls back to a freeform entry with the slug echoed in `title`.
    const slug_to_id = new Map<string, string | null>();
    for (const m of input.meals) {
      if (m.recipe_slug && !slug_to_id.has(m.recipe_slug)) {
        const lookup = await mealie_fetch<Record<string, unknown>>(
          `/api/recipes/${encodeURIComponent(m.recipe_slug)}`,
        );
        slug_to_id.set(m.recipe_slug, lookup.ok ? (str(lookup.data?.id) || null) : null);
      }
    }

    // 3. Create each entry.
    //    Mealie's mealplan POST is strict: `title` and `text` must be
    //    strings, never null. When recipeId is set, Mealie ignores
    //    title/text anyway, but the request still has to satisfy its
    //    schema — so we pass empty strings instead of null.
    const results: z.infer<typeof MealPlanResultEntry>[] = [];
    let total_created = 0;
    for (const m of input.meals) {
      const slot = m.slot ?? 'dinner';
      const recipe_id = m.recipe_slug ? slug_to_id.get(m.recipe_slug) ?? null : null;
      const title = m.title ?? (m.recipe_slug && !recipe_id ? `(missing slug) ${m.recipe_slug}` : '');
      const body: Record<string, unknown> = {
        date: m.date,
        entryType: slot,
        title,
        text: m.note ?? '',
        recipeId: recipe_id,
      };
      const post = await mealie_fetch<Record<string, unknown>>(
        '/api/households/mealplans',
        { method: 'POST', body: JSON.stringify(body) },
      );
      if (post.ok) {
        total_created++;
        results.push({
          date: m.date,
          slot,
          recipe_slug: m.recipe_slug ?? null,
          title: m.title ?? null,
          ok: true,
          mealie_id: num(post.data?.id),
          error: null,
        });
      } else {
        results.push({
          date: m.date,
          slot,
          recipe_slug: m.recipe_slug ?? null,
          title: m.title ?? null,
          ok: false,
          mealie_id: null,
          error: post.error ?? 'unknown error',
        });
      }
    }

    return {
      start_date: input.start_date,
      total_requested: input.meals.length,
      total_created,
      total_replaced,
      results,
    };
  },
};

// ── mealie_import_recipe_url ────────────────────────────────────────────

const ImportInput = z.object({
  url: z
    .string()
    .url()
    .describe('Public recipe URL Mealie should scrape (Serious Eats, NYT Cooking, BBC Good Food, etc.). Mealie uses the `recipe_scrapers` library — some anti-bot sites fall through with a clean error.'),
  include_tags: z
    .boolean()
    .default(false)
    .describe("When true, let Mealie ingest the source's tags too. Default false because most sites' tag taxonomies are SEO chum that pollutes Brigid's filtering. Add curated tags via Mealie's UI or a follow-up."),
  generate_thumb: z
    .boolean()
    .default(true)
    .describe('When true (default), POST a fire-and-forget request to friday-sdxl at :8790/generate to render a clean kitchen-style thumbnail. Set false if the source already has a usable image and you want to skip the LLM+FLUX pipeline.'),
});

const ImportOutput = z.object({
  ok: z.boolean(),
  slug: z.string().nullable().describe('The Mealie slug for the imported recipe — use this with mealie_get_recipe / mealie_set_meal_plan.'),
  url: z.string(),
  thumb_job: z
    .object({ job_id: z.string(), queue_depth: z.number() })
    .nullable()
    .describe('Present when generate_thumb=true and friday-sdxl accepted the job; null when skipped or unreachable.'),
  message: z.string(),
  error: z.string().optional(),
});

type ImportInputT = z.infer<typeof ImportInput>;
type ImportOutputT = z.infer<typeof ImportOutput>;

async function fire_thumb_job(slug: string): Promise<{ job_id: string; queue_depth: number } | null> {
  // Best-effort — never let a thumb-pipeline issue tank the recipe import.
  const res = await safe_fetch(
    `${SDXL_BASE_URL}/generate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, mode: 'reimagine' }),
    },
    8_000,
  );
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.body) as { job_id?: string; queue_depth?: number };
    if (!j.job_id) return null;
    return { job_id: j.job_id, queue_depth: num(j.queue_depth) ?? 0 };
  } catch {
    return null;
  }
}

export const mealie_import_recipe_url: Tool<ImportInputT, ImportOutputT> = {
  name: 'mealie_import_recipe_url',
  description:
    "Scrape a public recipe URL into the Mealie library via Mealie's built-in `recipe_scrapers`-backed import. Returns the new slug (use with mealie_get_recipe / mealie_set_meal_plan). On success, fires a fire-and-forget thumbnail-generation job at friday-sdxl unless `generate_thumb=false`. Some anti-bot sites (Allrecipes, sometimes Serious Eats) fail upstream — surface the error and don't retry; ask Jasper for a different URL.",
  risk: 'write_internal',
  required_capabilities: ['manage_recipes'],
  input_schema: ImportInput,
  output_schema: ImportOutput,

  idempotency_key(input) {
    return `mealie_import_recipe_url:${createHash('sha256').update(input.url).digest('hex').slice(0, 16)}`;
  },

  async execute(input, _ctx: ToolContext): Promise<ImportOutputT> {
    const res = await mealie_fetch<unknown>(
      '/api/recipes/create/url',
      {
        method: 'POST',
        body: JSON.stringify({ url: input.url, includeTags: input.include_tags }),
      },
      45_000,
    );
    if (!res.ok) {
      return {
        ok: false,
        slug: null,
        url: input.url,
        thumb_job: null,
        message: `Mealie couldn't scrape that URL — usually anti-bot blocking. Try a different source or save the recipe text manually.`,
        error: res.error,
      };
    }
    // Mealie's create/url returns a bare JSON string slug.
    const slug = typeof res.data === 'string' ? res.data : str((res.data as Record<string, unknown>)?.slug);
    if (!slug) {
      return {
        ok: false,
        slug: null,
        url: input.url,
        thumb_job: null,
        message: 'Mealie returned no slug — import probably failed silently.',
        error: 'no slug returned',
      };
    }

    const thumb_job = input.generate_thumb ? await fire_thumb_job(slug) : null;
    const thumb_note = input.generate_thumb
      ? thumb_job
        ? ` Thumb job ${thumb_job.job_id} queued (depth ${thumb_job.queue_depth}).`
        : ' Thumb generation skipped — friday-sdxl unreachable.'
      : '';
    return {
      ok: true,
      slug,
      url: input.url,
      thumb_job,
      message: `Saved "${slug}" to Mealie.${thumb_note}`,
    };
  },
};
