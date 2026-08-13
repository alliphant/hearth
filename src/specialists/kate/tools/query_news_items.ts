/**
 * query_news_items — read the News Desk's fresh headlines.
 *
 * The nightly source refresh (Cordelia, 03:40) fills `news_items` with
 * categorized headlines; `compose_news_takes` (04:10) turns them into
 * Kate's editorial takes. But the 07:00 BRIEF deliberation had no read of
 * the raw headlines, so the morning brief never opened with what actually
 * happened overnight. This is that read: recent headlines grouped by
 * category, each carrying its `source_domain` so the brief can cite where
 * a line came from.
 *
 * Generic + capability-gated (`read_news`) so any future news-reading
 * specialist inherits it — same posture as the market-radar read.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const InputSchema = z.object({
  window_hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .default(24)
    .describe('How far back to read headlines. Default 24h (overnight).'),
  categories: z
    .array(z.string().min(1).max(60))
    .max(20)
    .optional()
    .describe(
      'Limit to these desk categories (e.g. ["markets", "ai-business"]). ' +
        'Omit for all active categories.',
    ),
  per_category: z
    .number()
    .int()
    .min(1)
    .max(15)
    .default(5)
    .describe('Max headlines returned per category. Default 5.'),
});

const HeadlineSchema = z.object({
  title: z.string(),
  source_domain: z.string(),
  link: z.string(),
  published_at: z.string().nullable(),
});

const OutputSchema = z.object({
  window_hours: z.number(),
  total: z.number(),
  categories: z.array(
    z.object({
      category: z.string(),
      count: z.number(),
      headlines: z.array(HeadlineSchema),
    }),
  ),
  /** Populated when nothing is fresh in the window — an actionable hint. */
  note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface CatRow {
  category: string;
  n: number;
}
interface HeadlineRow {
  title: string;
  source_domain: string;
  link: string;
  published_at: string | null;
}

export function make_query_news_items(db: Database): Tool<Input, Output> {
  return {
    name: 'query_news_items',
    description:
      "Read the News Desk's fresh headlines, grouped by category, each with " +
      'its source domain. Use this at brief time to open with what actually ' +
      'happened overnight — cite the source domain on any headline you ' +
      'surface. Reads the news_items the nightly source refresh fills; ' +
      'returns nothing (with a hint) when no headlines are fresh in the window.',
    risk: 'read',
    required_capabilities: ['read_news'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const cats = (input.categories ?? []).slice().sort().join(',');
      return `query_news_items:${input.window_hours}:${input.per_category}:${cats}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const cutoff = new Date(
        Date.now() - input.window_hours * 3_600_000,
      ).toISOString();

      // Active categories in the window, most-covered first. A caller-
      // supplied filter narrows to those categories.
      const filter = input.categories && input.categories.length > 0;
      const cat_sql =
        `SELECT category, COUNT(*) AS n FROM news_items
          WHERE fetched_at >= @cutoff AND category IS NOT NULL` +
        (filter
          ? ` AND category IN (${input.categories!.map((_, i) => `@c${i}`).join(',')})`
          : '') +
        ` GROUP BY category ORDER BY n DESC`;
      const cat_params: Record<string, string> = { '@cutoff': cutoff };
      if (filter) {
        input.categories!.forEach((c, i) => {
          cat_params[`@c${i}`] = c;
        });
      }
      const cats = db.prepare(cat_sql).all(cat_params) as CatRow[];

      // `per_category` is a Zod-validated integer (1-15); inline it as a
      // literal — bun:sqlite binds a JS number into `LIMIT @n` as a float,
      // which SQLite rejects with SQLITE_MISMATCH.
      const limit = Math.trunc(input.per_category);
      const head_stmt = db.prepare(
        `SELECT title, source_domain, link, published_at FROM news_items
          WHERE category = @cat AND fetched_at >= @cutoff
          ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ${limit}`,
      );

      let total = 0;
      const categories = cats.map((c) => {
        const headlines = head_stmt.all({
          '@cat': c.category,
          '@cutoff': cutoff,
        }) as HeadlineRow[];
        total += headlines.length;
        return {
          category: c.category,
          count: c.n,
          headlines: headlines.map((h) => ({
            title: h.title,
            source_domain: h.source_domain,
            link: h.link,
            published_at: h.published_at,
          })),
        };
      });

      return {
        window_hours: input.window_hours,
        total,
        categories,
        ...(total === 0
          ? {
              note: `No headlines fetched in the last ${input.window_hours}h — the nightly source refresh (03:40) may not have run yet, or widen window_hours.`,
            }
          : {}),
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_query_news_items(deps.db) as Tool;
}
