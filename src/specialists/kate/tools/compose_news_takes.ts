/**
 * compose_news_takes — Kate's Read: her grounded, evolving takes over
 * the News Desk (2026-06-10).
 *
 * The desk without this is a wire service; this is the editor. Runs as
 * Kate's 04:10 background job (after Cordelia's 03:40 refresh fills
 * news_items) on the deliberation tier:
 *
 *   1. Pull the fresh headlines per active category (window_hours).
 *   2. One LLM call, Kate's chief-of-staff voice: a desk-wide LEAD take
 *      ("what actually matters today, for Jasper specifically") plus a
 *      short take per category — each citing headline refs.
 *   3. DETERMINISTIC citation check: every cite must resolve to a
 *      headline that was actually in the prompt; a take with zero valid
 *      citations is DROPPED (no citations, no view — the Ruby Politics
 *      Desk discipline). Resolved cites are stored as news_items links.
 *   4. Prior takes are fed back in so views EVOLVE ("note what changed
 *      since yesterday") instead of resetting.
 *   5. Takes land in `news_takes` (desk + chat read the latest per
 *      category) AND a daily "Kate's read" note is shelved on her
 *      library via save_library_item — so asking her in chat grounds in
 *      the same takes through ordinary auto-RAG, zero extra plumbing.
 *
 * Fail-open: LLM down / unparseable → no new takes (yesterday's stand);
 * kill switch HEARTH_NEWS_TAKES=0. Volatile (run state mutates).
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import type { LLMRouter } from '@core/llm';
import { local_iso_date } from '@core/time';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';

const InputSchema = z.object({
  window_hours: z
    .number()
    .int()
    .min(6)
    .max(96)
    .default(36)
    .describe('How far back to read headlines. Default 36h.'),
  headlines_per_category: z
    .number()
    .int()
    .min(3)
    .max(15)
    .default(8)
    .describe('Top-N freshest headlines fed to the take per category.'),
  max_categories: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(14)
    .describe('Cap on categories taken per run (most headlines first).'),
});

const TakeSchema = z.object({
  category: z.string().nullable(),
  take_md: z.string(),
  cited_links: z.array(z.string()),
});

const OutputSchema = z.object({
  enabled: z.boolean(),
  takes_written: z.number(),
  takes_dropped: z.number(),
  categories_considered: z.number(),
  note_path: z.string().nullable(),
  skipped_reason: z.string().optional(),
  error: z.string().optional(),
  next_action: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ComposeNewsTakesDeps {
  db: Database;
  specialists: SpecialistRegistry;
  library_deps: LibraryRoutesDeps;
  llm: LLMRouter;
}

const LEAD_CAP = 1400;
const TAKE_CAP = 900;

const SYSTEM_PROMPT =
  "You are Kate, the household's chief of staff, writing your morning read " +
  'over the news desk for Jasper. You are EDUCATED and GROUNDED: every ' +
  'load-bearing claim cites the headline refs you were given (e.g. [ai-2]); ' +
  'you never introduce facts that are not in the headlines. Your value is ' +
  'JUDGMENT, not summary: what actually matters, what connects across ' +
  'beats, what it means for Jasper (his household, his projects, his ' +
  'interests), what to watch next. Where your prior take is provided, ' +
  'EVOLVE it — note what changed, keep positions that still hold, say so ' +
  'plainly when you were wrong. Tone: direct, warm, no pundit theatrics, ' +
  'no both-sides filler. Confidence proportional to evidence.\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"lead": {"take_md": "<your desk-wide read, 2-4 short paragraphs>", ' +
  '"cites": ["<ref>", …]}, "categories": [{"category": "<key>", ' +
  '"take_md": "<2-5 sentences>", "cites": ["<ref>", …]}, …]}';

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/** Parse the model's JSON with a loose fallback: fence-stripped first,
 *  then the outermost {...} span (models love a prose preamble). Throws
 *  with the reply HEAD included so a failure is diagnosable from the
 *  audit/error instead of opaque (the 2nd live run failed blind). */
function parse_json_loose(s: string, finish_reason?: string): unknown {
  const t = strip_fence(s);
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    `unparseable reply${finish_reason === 'length' ? ' (TRUNCATED at max_tokens)' : ''}: ` +
      JSON.stringify(t.slice(0, 180)),
  );
}

/** Coerce the take-text key the model naturally emits (arg-spiral rule:
 *  accept the shape, don't reject). First live run: the 35B used
 *  `take_md` for entry 0 then drifted to other keys for the rest. */
function coerce_take_entry(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  const o = { ...(v as Record<string, unknown>) };
  if (typeof o.take_md !== 'string') {
    const alt = o.take ?? o.text ?? o.view ?? o.take_markdown ?? o.body ?? o.md;
    if (typeof alt === 'string') o.take_md = alt;
  }
  if (!Array.isArray(o.cites)) {
    const altc = o.citations ?? o.refs ?? o.cited ?? o.sources;
    if (Array.isArray(altc)) o.cites = altc;
  }
  return o;
}

const LeadEntrySchema = z.preprocess(coerce_take_entry, z.object({
  take_md: z.string(),
  cites: z.array(z.string()).default([]),
}));
const CategoryEntrySchema = z.preprocess(coerce_take_entry, z.object({
  category: z.string(),
  take_md: z.string(),
  cites: z.array(z.string()).default([]),
}));

interface HeadlineRef {
  ref: string;
  link: string;
  title: string;
  description: string;
  source_domain: string;
  category: string;
}

export function takes_enabled(): boolean {
  return process.env.HEARTH_NEWS_TAKES !== '0';
}

export function make_compose_news_takes(deps: ComposeNewsTakesDeps): Tool<Input, Output> {
  return {
    name: 'compose_news_takes',
    description:
      "Compose Kate's Read: her grounded lead take + per-category takes over the News Desk's fresh headlines, each citation-verified against news_items (no citations, no take), evolving her prior positions. Runs nightly at 04:10 after the source refresh; the takes surface on the News Desk tab and a daily note shelves to her library so chat answers ground in the same views. Manual catch-up only — do not call repeatedly.",
    risk: 'write_internal',
    required_capabilities: ['write_news_takes'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `compose_news_takes:${input.window_hours}:${input.headlines_per_category}:${input.max_categories}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const base: Output = {
        enabled: true,
        takes_written: 0,
        takes_dropped: 0,
        categories_considered: 0,
        note_path: null,
      };
      if (!takes_enabled()) {
        return {
          ...base,
          enabled: false,
          skipped_reason: 'HEARTH_NEWS_TAKES=0 — takes disabled by kill switch',
        };
      }
      const now = ctx.now ?? new Date();
      const cutoff = new Date(now.getTime() - input.window_hours * 3_600_000).toISOString();

      // Fresh headlines per category, most-covered categories first.
      const cat_rows = deps.db
        .prepare(
          `SELECT category, COUNT(*) AS n FROM news_items
            WHERE fetched_at >= @cutoff AND category IS NOT NULL
            GROUP BY category ORDER BY n DESC LIMIT @cap`,
        )
        .all({ '@cutoff': cutoff, '@cap': input.max_categories }) as Array<{
        category: string;
        n: number;
      }>;
      base.categories_considered = cat_rows.length;
      if (cat_rows.length === 0) {
        return {
          ...base,
          skipped_reason: 'no fresh categorized headlines in the window',
          next_action:
            'Run after the nightly source refresh (03:40) has filled news_items, or widen window_hours.',
        };
      }

      const item_stmt = deps.db.prepare(
        `SELECT link, title, description, source_domain, category FROM news_items
          WHERE category = @cat AND fetched_at >= @cutoff
          ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT @n`,
      );
      const refs = new Map<string, HeadlineRef>();
      const sections: string[] = [];
      for (const c of cat_rows) {
        const items = item_stmt.all({
          '@cat': c.category,
          '@cutoff': cutoff,
          '@n': input.headlines_per_category,
        }) as Array<Omit<HeadlineRef, 'ref'>>;
        const lines: string[] = [`### ${c.category}`];
        items.forEach((it, i) => {
          const ref = `${c.category}-${i + 1}`;
          refs.set(ref, { ...it, ref });
          lines.push(
            `[${ref}] ${it.title} (${it.source_domain})${it.description ? ` — ${it.description.slice(0, 200)}` : ''}`,
          );
        });
        sections.push(lines.join('\n'));
      }

      // Prior takes (latest per category + lead) for evolution.
      const prior_rows = deps.db
        .prepare(`SELECT category, take_md, ts FROM news_takes ORDER BY ts DESC LIMIT 60`)
        .all() as Array<{ category: string | null; take_md: string; ts: string }>;
      const prior_seen = new Set<string>();
      const priors: string[] = [];
      for (const p of prior_rows) {
        const key = p.category ?? '__lead__';
        if (prior_seen.has(key)) continue;
        prior_seen.add(key);
        priors.push(`- ${p.category ?? 'LEAD'} (${p.ts}): ${p.take_md.slice(0, 400)}`);
      }

      // One deliberation-tier call. Parsing is FAIL-SOFT per entry: a
      // malformed category must not kill the lead + the good takes.
      let lead: z.infer<typeof LeadEntrySchema> | null = null;
      let cat_entries: Array<z.infer<typeof CategoryEntrySchema>> = [];
      try {
        const role = deps.llm.for_role('specialist_deliberation');
        const resp = await role.provider.complete({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content:
                `Today is ${local_iso_date(now)}.\n\n` +
                `Fresh headlines by category (cite by the [ref] tokens):\n\n${sections.join('\n\n')}\n\n` +
                (priors.length > 0
                  ? `Your prior takes (evolve these — note what changed):\n${priors.join('\n')}\n\n`
                  : '') +
                'Reply with ONLY the JSON. Every object uses exactly the keys ' +
                '"category" (string), "take_md" (string), "cites" (array of ref strings).',
            },
          ],
          temperature: 0.4,
          max_tokens: 5000,
          think: false,
          ...role.defaults,
        });
        const raw = parse_json_loose(resp.content, resp.finish_reason) as Record<string, unknown>;
        const lead_r = LeadEntrySchema.safeParse(raw.lead);
        if (lead_r.success) lead = lead_r.data;
        else base.takes_dropped++;
        if (Array.isArray(raw.categories)) {
          for (const entry of raw.categories) {
            const r = CategoryEntrySchema.safeParse(entry);
            if (r.success) cat_entries.push(r.data);
            else base.takes_dropped++;
          }
        }
        if (!lead && cat_entries.length === 0) {
          throw new Error('no parseable takes in the reply');
        }
      } catch (err) {
        return {
          ...base,
          error: `take composition failed: ${(err as Error).message}`,
          next_action:
            "Yesterday's takes stand. Retry when the deliberation tier is back.",
        };
      }

      // Deterministic citation gate: refs must resolve; no cites → no take.
      const resolve_cites = (cites: string[]): string[] => {
        const links: string[] = [];
        for (const c of cites) {
          const hit = refs.get(c.trim());
          if (hit && !links.includes(hit.link)) links.push(hit.link);
        }
        return links;
      };

      /**
       * Linkify a take's prose (2026-06-10 follow-up): each inline
       * [ref] token that resolves becomes a tiny numbered markdown
       * link [n](article-url) — numbered by first appearance, same
       * ref ⇒ same number — so citations are TAPPABLE everywhere
       * (web card, iOS detail_md, the shelved daily note) with zero
       * renderer special-casing. Tokens that don't resolve are
       * stripped (they cite nothing; the take survived on its other
       * cites). Returns the rewritten prose + links in superscript
       * order, which becomes the stored cited_links order so the
       * "grounded on" footer matches the numbering.
       */
      const linkify_take = (md: string): { md: string; ordered_links: string[] } => {
        const ordered_links: string[] = [];
        const num_for = new Map<string, number>();
        const out = md.replace(/\[([a-z0-9-]+-\d+)\]/gi, (_m, tok: string) => {
          const hit = refs.get(tok.trim());
          if (!hit) return '';
          let n = num_for.get(hit.link);
          if (n === undefined) {
            ordered_links.push(hit.link);
            n = ordered_links.length;
            num_for.set(hit.link, n);
          }
          return `[${n}](${hit.link})`;
        });
        return { md: out.replace(/[ \t]+([.,;:])/g, '$1'), ordered_links };
      };
      const ts = now.toISOString();
      const model = 'specialist_deliberation';
      const ins = deps.db.prepare(
        `INSERT INTO news_takes (id, category, take_md, cited_links, ts, model)
         VALUES (@id, @cat, @md, @cites, @ts, @model)`,
      );
      const accepted: Array<{ category: string | null; take_md: string; links: string[] }> = [];
      const consider = [
        ...(lead
          ? [{ category: null as string | null, take_md: lead.take_md, cites: lead.cites, cap: LEAD_CAP }]
          : []),
        ...cat_entries.map((c) => ({
          category: c.category as string | null,
          take_md: c.take_md,
          cites: c.cites,
          cap: TAKE_CAP,
        })),
      ];
      for (const t of consider) {
        const links = resolve_cites(t.cites);
        const known_cat = t.category === null || refs.size === 0
          ? true
          : cat_rows.some((c) => c.category === t.category);
        if (links.length === 0 || !known_cat || t.take_md.trim().length < 20) {
          base.takes_dropped++;
          continue;
        }
        // Inline refs become tappable numbered links; any resolved cite
        // the model listed but didn't reference inline still belongs in
        // the footer, appended after the inline-ordered ones.
        const { md: linked_md, ordered_links } = linkify_take(t.take_md.trim());
        const all_links = [
          ...ordered_links,
          ...links.filter((l) => !ordered_links.includes(l)),
        ];
        const take_md = linked_md.slice(0, t.cap + ordered_links.length * 80);
        ins.run({
          '@id': `nt_${ulid().toLowerCase()}`,
          '@cat': t.category,
          '@md': take_md,
          '@cites': JSON.stringify(all_links),
          '@ts': ts,
          '@model': model,
        });
        accepted.push({ category: t.category, take_md, links: all_links });
        base.takes_written++;
      }

      // Shelve the daily note so chat grounds in the same takes via RAG.
      if (accepted.length > 0) {
        const kate = deps.specialists.get('kate');
        if (kate) {
          const date = local_iso_date(now);
          const body: string[] = [];
          for (const t of accepted) {
            body.push(t.category === null ? `## The lead` : `## ${t.category}`);
            body.push(t.take_md);
            body.push(
              `Grounded on: ${t.links.map((l) => `[${new URL(l).hostname.replace(/^www\./, '')}](${l})`).join(' · ')}`,
            );
            body.push('');
          }
          const saved = await save_library_item(
            deps.library_deps,
            {
              filename: `kates-read-${date}.md`,
              mime_type: 'text/markdown',
              text: `# Kate's read — ${date}\n\n${body.join('\n')}`,
            },
            kate,
            {
              source: 'file',
              quality_gate: 'off', // citation-gated already; never a shell
              private_to: null,
              trust_tier_override: null,
            },
          );
          if (!('rejected' in saved)) base.note_path = saved.wrapper_note_path;
        }
      }

      deps.library_deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'compose_news_takes',
        tool_input: {
          window_hours: input.window_hours,
          headlines_per_category: input.headlines_per_category,
        },
        execution_result: {
          takes_written: base.takes_written,
          takes_dropped: base.takes_dropped,
          categories_considered: base.categories_considered,
          note_path: base.note_path,
        },
        user_id: ctx.user?.id,
      });

      return base;
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_compose_news_takes({
    db: deps.db,
    specialists: deps.specialists,
    llm: deps.llm,
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      embedder: deps.embedder,
      events: deps.events,
    },
  }) as Tool;
}
