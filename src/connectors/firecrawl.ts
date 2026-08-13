import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { Semaphore } from '@core/semaphore';
import { safe_fetch } from './_audit';

const FIRECRAWL_BASE_URL =
  process.env.FIRECRAWL_BASE_URL ?? 'http://localhost:3002';
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY ?? '';

/**
 * Global concurrency limiter on the Firecrawl scrape call (2026-06-28).
 *
 * EVERY firecrawl scrape funnels through `web_fetch_clean.execute` — the
 * registry path, direct `.execute()` callers (ingest helpers), the
 * browser-fallback wrapper, and the deep-research / commission / source-refresh
 * fan-outs. So one semaphore HERE bounds the whole system's load on the
 * Firecrawl service regardless of how many callers fan out. This is the
 * root-cause fix for the nightly burst: Cordelia's 03–04 MT knowledge jobs used
 * to fire dozens of concurrent scrapes, saturate the API, and make the health
 * probe time out → a nightly "firecrawl down" incident that self-healed when the
 * burst ended. With a cap the burst DRAINS through a bounded queue
 * (backpressure) instead of overloading — the background jobs aren't
 * latency-sensitive, and daytime traffic rarely exceeds the cap so it's
 * transparent. The health probe (system_health.ts) intentionally does NOT go
 * through here, so it stays responsive and reports accurate health even mid-burst.
 *
 * Tunable `HEARTH_FIRECRAWL_MAX_CONCURRENCY` (default 3); `0` = unbounded
 * (kill switch — byte-identical to pre-limiter behavior).
 */
function firecrawl_max_concurrency(): number {
  const v = Number(process.env.HEARTH_FIRECRAWL_MAX_CONCURRENCY);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 3;
}
let _limiter: Semaphore | null = null;
let _limiter_max = -1;
function firecrawl_limiter(): Semaphore | null {
  const max = firecrawl_max_concurrency();
  if (max === 0) return null; // kill switch — no limiting
  if (!_limiter || _limiter_max !== max) {
    _limiter = new Semaphore(max);
    _limiter_max = max;
  }
  return _limiter;
}

/** Diagnostics: in-flight + queued scrapes, and the configured cap (0 = off). */
export function firecrawl_limiter_stats(): { inflight: number; queued: number; max: number } {
  const max = firecrawl_max_concurrency();
  if (max === 0 || !_limiter) return { inflight: 0, queued: 0, max };
  return { inflight: _limiter.current_depth() - _limiter.queued(), queued: _limiter.queued(), max };
}

/** Test seam — drop the cached limiter so the next call rebuilds from env. */
export function _reset_firecrawl_limiter(): void {
  _limiter = null;
  _limiter_max = -1;
}

const InputSchema = z.object({
  url: z.string().url(),
});

const OutputSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  markdown: z.string(),
  extracted_at: z.string(),
  error: z.string().optional(),
  /**
   * On error or empty body, mechanically-derived alternative URLs the
   * calling LLM can retry against instead of fabricating an answer
   * from nothing. Mirrors `ha_get_state.candidates` (the template
   * cited in binding-proposal `connector-recovery-web-fetch-clean`):
   * present only on the error branch; same-domain variants ranked by
   * how reliably each one tends to recover a 404/empty-body failure.
   */
  candidates: z
    .array(
      z.object({
        url: z.string(),
        why_relevant: z.string(),
      }),
    )
    .optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * Given a failing URL, derive a small set of same-domain variants
 * worth retrying. Mechanical, deterministic, zero network cost — the
 * LLM picks one, makes another tool call. Order matters: most-likely-
 * to-recover first so the LLM's first retry has the best odds.
 *
 * Strategies (in order):
 *   - flip trailing slash
 *   - drop / add `.html` / `.htm`
 *   - parent directory listing
 *   - sitemap.xml on the same host (the canonical "what's actually here")
 *   - robots.txt on the same host
 *   - bare origin
 */
function derive_url_candidates(failing_url: string): Array<{ url: string; why_relevant: string }> {
  let parsed: URL;
  try {
    parsed = new URL(failing_url);
  } catch {
    return [];
  }
  const out: Array<{ url: string; why_relevant: string }> = [];
  const seen = new Set<string>([failing_url]);
  const push = (url: string, why: string): void => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, why_relevant: why });
  };
  const path = parsed.pathname;
  // Trailing-slash flip.
  if (path.endsWith('/') && path !== '/') {
    const next = new URL(failing_url);
    next.pathname = path.slice(0, -1);
    push(next.toString(), 'same path without trailing slash');
  } else if (path !== '/' && !path.includes('.')) {
    const next = new URL(failing_url);
    next.pathname = path + '/';
    push(next.toString(), 'same path with trailing slash');
  }
  // Extension swap.
  if (path.endsWith('.html')) {
    const next = new URL(failing_url);
    next.pathname = path.slice(0, -5);
    push(next.toString(), 'same path without .html extension');
  } else if (path.endsWith('.htm')) {
    const next = new URL(failing_url);
    next.pathname = path.slice(0, -4) + '.html';
    push(next.toString(), 'same path with .html instead of .htm');
  } else if (path !== '/' && !path.includes('.')) {
    const next = new URL(failing_url);
    next.pathname = path.replace(/\/?$/, '') + '/index.html';
    push(next.toString(), 'index.html under the same path');
  }
  // Parent directory.
  if (path !== '/' && path !== '') {
    const trimmed = path.replace(/\/$/, '');
    const last_slash = trimmed.lastIndexOf('/');
    if (last_slash >= 0) {
      const next = new URL(failing_url);
      next.pathname = trimmed.slice(0, last_slash + 1);
      next.search = '';
      next.hash = '';
      push(next.toString(), 'parent directory listing');
    }
  }
  // Sitemap + robots — canonical "what's actually here".
  push(`${parsed.origin}/sitemap.xml`, 'sitemap for the host');
  push(`${parsed.origin}/robots.txt`, 'robots.txt may name canonical paths');
  // Bare origin as final fallback.
  push(`${parsed.origin}/`, 'host root');
  return out.slice(0, 6);
}

export const web_fetch_clean: Tool<Input, Output> = {
  name: 'web_fetch_clean',
  description:
    'Fetch a URL and return its main content as clean markdown, via the local Firecrawl service. Use for articles, docs, blog posts — anything you want to read without ads or navigation chrome. On error (404, empty body, parse failure), also returns `candidates`: same-domain URL variants worth retrying instead of fabricating an answer — retry against one of those before reporting the fetch failed.',
  risk: 'read',
  required_capabilities: ['query_web'],
  // Firecrawl markdown averages 8-30 KB; tighter budget keeps multi-
  // fetch research turns from blowing out next-round prompt eval. The
  // full markdown still lands in the audit log via execution_result.
  llm_budget: 2000,
  // Slow external fetch — counts against the per-turn heavy-call cap so a
  // research fan-out can't lag the turn / bloat context without bound.
  weight: 'heavy',
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `web_fetch_clean:${createHash('sha256').update(input.url).digest('hex').slice(0, 16)}`;
  },

  async execute(input: Input, _ctx: ToolContext): Promise<Output> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (FIRECRAWL_API_KEY) {
      headers['Authorization'] = `Bearer ${FIRECRAWL_API_KEY}`;
    }
    const do_scrape = () =>
      safe_fetch(
        `${FIRECRAWL_BASE_URL.replace(/\/$/, '')}/v1/scrape`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            url: input.url,
            formats: ['markdown'],
          }),
        },
      );
    // Bound concurrent scrapes so a fan-out burst can't saturate Firecrawl —
    // backpressure (queue), not a stampede. Kill switch → run unbounded.
    const limiter = firecrawl_limiter();
    const res = limiter ? await limiter.with_slot(do_scrape) : await do_scrape();
    if (!res.ok) {
      return {
        url: input.url,
        title: null,
        markdown: '',
        extracted_at: new Date().toISOString(),
        error: res.error ?? `Firecrawl HTTP ${res.status}: ${res.body.slice(0, 200)}`,
        candidates: derive_url_candidates(input.url),
      };
    }
    try {
      const json = JSON.parse(res.body) as {
        data?: { markdown?: string; metadata?: { title?: string } };
        success?: boolean;
        error?: string;
      };
      if (json.success === false || !json.data?.markdown) {
        return {
          url: input.url,
          title: null,
          markdown: '',
          extracted_at: new Date().toISOString(),
          error: json.error ?? 'Firecrawl returned no markdown',
          candidates: derive_url_candidates(input.url),
        };
      }
      return {
        url: input.url,
        title: json.data.metadata?.title ?? null,
        markdown: json.data.markdown,
        extracted_at: new Date().toISOString(),
      };
    } catch (err) {
      return {
        url: input.url,
        title: null,
        markdown: '',
        extracted_at: new Date().toISOString(),
        error: `Failed to parse Firecrawl response: ${(err as Error).message}`,
        candidates: derive_url_candidates(input.url),
      };
    }
  },
};
