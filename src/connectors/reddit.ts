/**
 * Reddit connector — three tools backed by reddit's OAuth API.
 *
 * - `read_subreddit({subreddit, sort?, limit?, time?})` — list threads in
 *   a subreddit's hot/new/top/rising feed.
 * - `read_reddit_thread({url|permalink, limit_comments?})` — drill into
 *   a single thread, return the OP body + top-level comments.
 * - `read_reddit_user({username, kind?, limit?})` — list a user's recent
 *   submissions, comments, or both. Use it for public civic figures
 *   whose posts matter — officials, candidates, organizers.
 *
 * CONTRACT (2026-08-10, supersedes the anonymous-JSON contract): reddit
 * closed anonymous access to the JSON endpoints. `<url>.json` returns
 * HTTP 403 to every non-browser client regardless of User-Agent —
 * verified live from the LLM host's residential IP: descriptive scripted UA,
 * full browser UA, and old.reddit.com all 403 with an HTML block page.
 * Two supported read paths remain, and the connector picks by config:
 *
 * - **OAuth** (when REDDIT_CLIENT_ID/SECRET are set): a "script" app
 *   credential exchanges `client_credentials` for a bearer token at
 *   /api/v1/access_token, then reads the same listing paths on
 *   https://oauth.reddit.com at ~100 requests/min. Full fidelity
 *   (scores, counts, flags). Caveat: since reddit's Responsible
 *   Builder Policy (late 2025) new API access is approval-gated —
 *   docs/reddit-oauth.md — so this credential may never exist.
 *
 * - **RSS** (default, no credential): reddit's public Atom feeds still
 *   serve anonymous clients with a descriptive UA — /r/<sub>/<sort>.rss,
 *   /user/<name>[/<kind>].rss, <permalink>.rss — an intentionally
 *   public surface (feed readers), verified live 2026-08-10. Degraded
 *   but honest: scores / comment counts / moderation flags are not in
 *   the feeds, so those fields are OMITTED (unknown ≠ zero), and the
 *   output carries `mode: 'rss'` + a note saying exactly that. The
 *   anonymous per-IP budget is small — bursts 429 — which fits the
 *   tools' LLM-paced call pattern.
 *
 * No recovery hint escalates listings to `browse_url` anymore: the
 * rendered page truncates listing data (the 2026-08-02/04 expired-
 * proposal incident), and the household rule is that a refusal is
 * taken at face value, not retried through another door.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';

const REDDIT_BASE = 'https://www.reddit.com';
const REDDIT_TOKEN_URL = `${REDDIT_BASE}/api/v1/access_token`;
const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';

// Read at call time (not module load) so a restart-free env change in a
// test or REPL takes effect — same pattern as courtlistener's CL_TOKEN.
const reddit_client_id = (): string => process.env.REDDIT_CLIENT_ID ?? '';
const reddit_client_secret = (): string => process.env.REDDIT_CLIENT_SECRET ?? '';
// Reddit's required UA shape: <platform>:<app>:<version> (by /u/<owner>).
// The owner is the reddit account the app credential was created under.
const reddit_ua = (): string =>
  process.env.REDDIT_USER_AGENT ??
  'server:hearth-civic-correspondent:v1.0 (by /u/AccountableFC)';

const SORT_ENUM = z.enum(['hot', 'new', 'top', 'rising', 'controversial']);
const TIME_ENUM = z.enum(['hour', 'day', 'week', 'month', 'year', 'all']);
const USER_KIND_ENUM = z.enum(['submitted', 'comments', 'overview']);

// ── Common shapes ──────────────────────────────────────────────────

// Engagement/moderation fields are OPTIONAL because RSS mode cannot know
// them — an omitted field means "unknown", which is honest; a fabricated
// 0 would read as a real measurement. OAuth mode fills all of them.
const Post = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  subreddit: z.string(),
  permalink: z.string(),
  url: z.string(),
  selftext: z.string(),
  selftext_preview: z.string(),
  score: z.number().optional(),
  num_comments: z.number().optional(),
  upvote_ratio: z.number().optional(),
  is_self: z.boolean(),
  link_flair_text: z.string().nullable().optional(),
  over_18: z.boolean().optional(),
  stickied: z.boolean().optional(),
  locked: z.boolean().optional(),
  created_iso: z.string(),
});

const Comment = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  body_preview: z.string(),
  score: z.number().optional(),
  permalink: z.string(),
  parent_id: z.string().optional(),
  is_submitter: z.boolean().optional(),
  stickied: z.boolean().optional(),
  created_iso: z.string(),
});

const RECOVERY_HINT = z
  .object({
    next_action: z.string().optional(),
    escalation: z.string().optional(),
  })
  .optional();

// ── OAuth token manager ─────────────────────────────────────────────

interface TokenCache {
  token: string;
  expires_at_ms: number;
}

let token_cache: TokenCache | null = null;
let token_inflight: Promise<TokenAcquire> | null = null;

type TokenAcquire =
  | { ok: true; token: string }
  | { ok: false; status: number; error: string };

/** Test hook — smoke:reddit-oauth resets between scenarios. */
export function _reset_reddit_token_cache(): void {
  token_cache = null;
  token_inflight = null;
}

async function do_acquire_token(): Promise<TokenAcquire> {
  const basic = Buffer.from(
    `${reddit_client_id()}:${reddit_client_secret()}`,
  ).toString('base64');
  const res = await safe_fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': reddit_ua(),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const detail =
      res.status === 401
        ? 'the client id/secret pair was rejected'
        : res.error ?? `HTTP ${res.status}: ${res.body.slice(0, 200)}`;
    return { ok: false, status: res.status, error: `token endpoint: ${detail}` };
  }
  try {
    const j = JSON.parse(res.body) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!j.access_token) {
      return {
        ok: false,
        status: res.status,
        error: `token endpoint returned no access_token: ${res.body.slice(0, 200)}`,
      };
    }
    // Refresh 120s before reddit's stated expiry so a token never dies
    // mid-pass; floor at 60s so a bogus expires_in can't spin-mint.
    const ttl_s = Math.max(60, (j.expires_in ?? 3600) - 120);
    token_cache = {
      token: j.access_token,
      expires_at_ms: Date.now() + ttl_s * 1000,
    };
    return { ok: true, token: j.access_token };
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      error: `unparseable token response: ${(err as Error).message}`,
    };
  }
}

// Single-flight: concurrent tool calls at boot share one token mint
// instead of racing N POSTs at the token endpoint. Failures are never
// cached — only a successful mint writes token_cache.
async function acquire_token(): Promise<TokenAcquire> {
  if (token_cache && token_cache.expires_at_ms > Date.now()) {
    return { ok: true, token: token_cache.token };
  }
  if (!token_inflight) {
    token_inflight = do_acquire_token().finally(() => {
      token_inflight = null;
    });
  }
  return token_inflight;
}

// ── Authenticated GET ───────────────────────────────────────────────

type RedditFailReason = 'auth' | 'http' | 'network';

type RedditGet =
  | { ok: true; body: string }
  | { ok: false; status: number; reason: RedditFailReason; error: string };

/** OAuth mode is active when both halves of the app credential are set. */
export function has_oauth_creds(): boolean {
  return Boolean(reddit_client_id() && reddit_client_secret());
}

async function reddit_get(
  path: string,
  params: Record<string, string>,
): Promise<RedditGet> {
  const url = new URL(`${REDDIT_OAUTH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let reminted = false;
  for (;;) {
    const tok = await acquire_token();
    if (!tok.ok) {
      return {
        ok: false,
        status: tok.status,
        reason: 'auth',
        error: `reddit token acquisition failed: ${tok.error}`,
      };
    }
    const res = await safe_fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${tok.token}`,
        'User-Agent': reddit_ua(),
        Accept: 'application/json',
      },
    });
    if (res.ok) return { ok: true, body: res.body };
    if (res.status === 401 && !reminted) {
      // A 401 on a cached bearer means it expired or was revoked
      // mid-window; re-minting IS the OAuth contract, one pass only.
      token_cache = null;
      reminted = true;
      continue;
    }
    if (res.status === 0) {
      return {
        ok: false,
        status: 0,
        reason: 'network',
        error: res.error ?? 'network error reaching reddit',
      };
    }
    return {
      ok: false,
      status: res.status,
      reason: res.status === 401 ? 'auth' : 'http',
      error: `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
    };
  }
}

// ── RSS mode — reddit's public Atom feeds ───────────────────────────

/** Stamped on every RSS-mode result so a specialist can never mistake an
 *  absent metric for a measured zero. */
const RSS_MODE_NOTE =
  "RSS mode (no OAuth credential): reddit's public feeds carry no scores, " +
  'comment counts, or moderation flags — those fields are omitted because ' +
  'they are UNKNOWN, not zero. The anonymous feed budget is small; if a ' +
  'read 429s, wait rather than re-calling immediately.';

async function reddit_get_rss(
  path: string,
  params: Record<string, string>,
): Promise<RedditGet> {
  const url = new URL(`${REDDIT_BASE}${path}.rss`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await safe_fetch(url.toString(), {
    headers: { 'User-Agent': reddit_ua(), Accept: 'application/atom+xml' },
  });
  if (res.ok) return { ok: true, body: res.body };
  if (res.status === 0) {
    return {
      ok: false,
      status: 0,
      reason: 'network',
      error: res.error ?? 'network error reaching reddit',
    };
  }
  return {
    ok: false,
    status: res.status,
    reason: 'http',
    error: `HTTP ${res.status}: ${res.body.slice(0, 200)}`,
  };
}

function xml_unescape(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// The feed double-escapes: XML-escaped HTML. After the XML layer is
// unescaped the text still carries HTML entities (&amp;, &#39;, …), so
// strip tags first, then run the same entity decode once more.
function html_to_text(html: string): string {
  return xml_unescape(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AtomEntry {
  /** reddit thing kind from the entry id: t3 = post, t1 = comment. */
  kind: 't1' | 't3' | null;
  /** Bare id without the tN_ prefix. */
  id: string;
  title: string;
  /** Bare username without the /u/ prefix. */
  author: string;
  /** The reddit permalink (post or comment). */
  link: string;
  /** For link posts, the external target of the [link] anchor; '' for
   *  self posts (where it equals the permalink) and comments. */
  out_url: string;
  published_iso: string;
  /** Category term, e.g. "Pleasantville"; '' on user feeds (term is "u/x"). */
  subreddit: string;
  /** Selftext / comment body as plain text — the SC_OFF..SC_ON span of
   *  the content html; '' for link posts (no selftext). */
  text: string;
}

/**
 * Parse reddit's Atom feed (single-line XML, stable machine-written
 * shape — the regexes target that exact producer, not arbitrary XML).
 */
export function parse_reddit_atom(xml: string): AtomEntry[] {
  const entries: AtomEntry[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const chunk = m[1] ?? '';
    const id_m = /<id>(t\d)_([a-z0-9]+)<\/id>/.exec(chunk);
    const kind = id_m?.[1] === 't3' ? 't3' : id_m?.[1] === 't1' ? 't1' : null;
    const title_m = /<title>([\s\S]*?)<\/title>/.exec(chunk);
    const author_m = /<author><name>\/?u\/([^<]*)<\/name>/.exec(chunk);
    const link_m = /<link[^>]*href="([^"]+)"/.exec(chunk);
    const pub_m =
      /<published>([^<]+)<\/published>/.exec(chunk) ??
      /<updated>([^<]+)<\/updated>/.exec(chunk);
    const cat_m = /<category term="([^"]+)"/.exec(chunk);
    const content_m = /<content type="html">([\s\S]*?)<\/content>/.exec(chunk);

    const link = xml_unescape(link_m?.[1] ?? '');
    let text = '';
    let out_url = '';
    if (content_m) {
      const html = xml_unescape(content_m[1] ?? '');
      const sc = /<!-- SC_OFF -->([\s\S]*?)<!-- SC_ON -->/.exec(html);
      if (sc) text = html_to_text(sc[1] ?? '');
      const anchor_target = /href="([^"]+)">\s*\[link\]/.exec(html)?.[1];
      if (anchor_target && anchor_target !== link) out_url = anchor_target;
    }
    const cat = xml_unescape(cat_m?.[1] ?? '');
    entries.push({
      kind,
      id: id_m?.[2] ?? '',
      title: xml_unescape(title_m?.[1] ?? ''),
      author: author_m?.[1] ?? '[unknown]',
      link,
      out_url,
      published_iso: pub_m?.[1] ?? '',
      subreddit: cat.startsWith('u/') ? '' : cat,
      text,
    });
  }
  return entries;
}

function post_from_atom(e: AtomEntry): z.infer<typeof Post> {
  return {
    id: e.id,
    title: e.title,
    author: e.author,
    subreddit: e.subreddit,
    permalink: e.link,
    url: e.out_url || e.link,
    selftext: e.text,
    selftext_preview: preview(e.text),
    is_self: e.out_url === '',
    created_iso: e.published_iso,
  };
}

function comment_from_atom(e: AtomEntry): z.infer<typeof Comment> {
  return {
    id: e.id,
    author: e.author,
    body: e.text,
    body_preview: preview(e.text),
    permalink: e.link,
    created_iso: e.published_iso,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function preview(text: string, n: number = 400): string {
  if (text.length <= n) return text;
  return text.slice(0, n).trimEnd() + '…';
}

function iso_from_utc(t: unknown): string {
  if (typeof t !== 'number' || !isFinite(t)) return '';
  return new Date(t * 1000).toISOString();
}

interface RedditListingChild {
  kind: string;
  data: Record<string, unknown>;
}

interface RedditListing {
  kind: string;
  data: { children: RedditListingChild[]; after?: string | null };
}

function post_from(child: RedditListingChild) {
  const d = child.data;
  const selftext = String(d.selftext ?? '');
  return {
    id: String(d.id ?? ''),
    title: String(d.title ?? ''),
    author: String(d.author ?? '[deleted]'),
    subreddit: String(d.subreddit ?? ''),
    permalink: `https://www.reddit.com${String(d.permalink ?? '')}`,
    url: String(d.url ?? ''),
    selftext,
    selftext_preview: preview(selftext),
    score: typeof d.score === 'number' ? d.score : 0,
    num_comments: typeof d.num_comments === 'number' ? d.num_comments : 0,
    upvote_ratio:
      typeof d.upvote_ratio === 'number' ? d.upvote_ratio : undefined,
    is_self: Boolean(d.is_self),
    link_flair_text:
      typeof d.link_flair_text === 'string' ? d.link_flair_text : null,
    over_18: Boolean(d.over_18),
    stickied: Boolean(d.stickied),
    locked: Boolean(d.locked),
    created_iso: iso_from_utc(d.created_utc),
  };
}

function comment_from(child: RedditListingChild) {
  const d = child.data;
  const body = String(d.body ?? '');
  return {
    id: String(d.id ?? ''),
    author: String(d.author ?? '[deleted]'),
    body,
    body_preview: preview(body),
    score: typeof d.score === 'number' ? d.score : 0,
    permalink: `https://www.reddit.com${String(d.permalink ?? '')}`,
    parent_id: String(d.parent_id ?? ''),
    is_submitter: Boolean(d.is_submitter),
    stickied: Boolean(d.stickied),
    created_iso: iso_from_utc(d.created_utc),
  };
}

/**
 * Map a failed reddit_get to the specialist-facing recovery hint.
 *
 * Deliberate absence: nothing here escalates a LISTING read to
 * `browse_url`. The rendered page truncates listing data (the 2026-08
 * incident), and re-reading a refused endpoint through another door is
 * exactly what the owner's refusal rule forbids. The one browser
 * mention left is the 404 existence check — rendering a profile page to
 * see whether an account exists at all is an ordinary visitor's read,
 * not a listings workaround.
 */
export function recovery_for(
  reason: RedditFailReason,
  status: number,
): { next_action?: string; escalation?: string } | undefined {
  if (reason === 'auth') {
    return {
      next_action:
        `Reddit rejected our app credential (HTTP ${status || '???'} during ` +
        `token minting or bearer auth). A Hearth credential problem — NOT ` +
        `evidence about the target. Report it so Jasper can fix the credential ` +
        `(docs/reddit-oauth.md; /docker/hearth/hearth.env on the LLM host). Do NOT ` +
        `fall back to browse_url for listings.`,
    };
  }
  if (status === 429) {
    return {
      next_action:
        `Reddit rate-limited this read (the OAuth budget is ~100 requests/min; ` +
        `the anonymous RSS budget is much smaller and 429s on bursts). Wait ` +
        `and let the next pass pick this up — do NOT re-read via browse_url; ` +
        `the rendered page truncates listings.`,
    };
  }
  if (status === 403) {
    return {
      next_action:
        `Reddit refused this authenticated read (HTTP 403) — usually a ` +
        `private, quarantined, or banned community, sometimes a temporary ` +
        `block. It is NOT proof that an account or subreddit is suspended, ` +
        `deleted, or deactivated, and must not be recorded as one. Note the ` +
        `refusal and move on.`,
    };
  }
  if (status === 404) {
    return {
      next_action:
        `Reddit returned 404. The subreddit/user/thread may not exist, be ` +
        `private, or have been removed — but a 404 is a lookup outcome, not ` +
        `proof of deletion; do not record it as an account-status fact. ` +
        `Double-check the spelling; for users, drop the leading u/. If the ` +
        `existence question itself matters, confirm on the rendered page via ` +
        `browse_url before drawing any conclusion.`,
    };
  }
  if (status >= 500) {
    return {
      next_action: `Reddit-side server error (HTTP ${status}) — transient; let the next pass retry.`,
    };
  }
  if (reason === 'network') {
    return {
      next_action:
        `Network error reaching reddit. Let the next pass retry; if it ` +
        `persists across passes, flag it as an outage.`,
    };
  }
  return undefined;
}

// ── read_subreddit ──────────────────────────────────────────────────

// NOTE: no `.regex()` on `subreddit` — a tool input_schema becomes a GBNF
// grammar on the interactive 9B, and llama.cpp's converter mistranslates a
// regex `pattern` and SILENTLY disables the whole tool grammar (it then
// generates unconstrained, no validation error to recover from). The
// name-shape check — also a path-safety guard, since it lands in a URL path —
// lives in execute() and returns a typed recovery hint instead.
const SubredditIn = z.object({
  subreddit: z
    .string()
    .min(1)
    .max(50)
    .describe('Subreddit name without the leading r/, e.g. "pleasantville"'),
  sort: SORT_ENUM.default('hot'),
  limit: z.number().int().positive().max(50).default(25),
  /** Only meaningful for sort=top/controversial. */
  time: TIME_ENUM.optional(),
});

const SubredditOut = z.object({
  subreddit: z.string(),
  sort: z.string(),
  count: z.number(),
  posts: z.array(Post),
  mode: z.enum(['oauth', 'rss']).optional(),
  note: z.string().optional(),
  error: z.string().optional(),
  recovery_hint: RECOVERY_HINT,
});

type SubredditInT = z.infer<typeof SubredditIn>;
type SubredditOutT = z.infer<typeof SubredditOut>;

export const read_subreddit: Tool<SubredditInT, SubredditOutT> = {
  name: 'read_subreddit',
  description:
    "List threads in a subreddit's hot/new/top feed. Returns title + " +
    'author + score + comment count + a 400-char preview of any self-' +
    'text per post, plus the permalink for drill-down via ' +
    '`read_reddit_thread`. Use for community signal scans — what is ' +
    'the local community talking about right now, what is rising. ' +
    "Reads reddit's public RSS feeds by default (check `mode`/`note`: " +
    'in rss mode scores and comment counts are absent because they are ' +
    'UNKNOWN, not zero) or the OAuth API when a credential is configured. ' +
    'On an error, follow the recovery hint — never re-read reddit ' +
    'listings via `browse_url` (the rendered page truncates them).',
  risk: 'read',
  required_capabilities: ['read_reddit'],
  input_schema: SubredditIn,
  output_schema: SubredditOut,

  idempotency_key(input) {
    return `read_subreddit:${createHash('sha256')
      .update(input.subreddit)
      .update('\n')
      .update(input.sort)
      .update('\n')
      .update(String(input.limit))
      .update('\n')
      .update(input.time ?? '')
      .digest('hex')
      .slice(0, 16)}`;
  },

  async execute(input: SubredditInT, _ctx: ToolContext): Promise<SubredditOutT> {
    if (!/^[A-Za-z0-9_]+$/.test(input.subreddit)) {
      return {
        subreddit: input.subreddit,
        sort: input.sort,
        count: 0,
        posts: [],
        error:
          `"${input.subreddit}" is not a valid subreddit name (letters, digits, ` +
          `and underscore only).`,
        recovery_hint: {
          next_action:
            'Re-call read_subreddit with just the bare subreddit name, e.g. ' +
            '{"subreddit":"pleasantville"} — drop any leading "r/", URL, slashes, or spaces.',
        },
      };
    }
    const params: Record<string, string> = { limit: String(input.limit) };
    if (input.time && (input.sort === 'top' || input.sort === 'controversial')) {
      params.t = input.time;
    }

    if (!has_oauth_creds()) {
      const res = await reddit_get_rss(`/r/${input.subreddit}/${input.sort}`, params);
      if (!res.ok) {
        return {
          subreddit: input.subreddit,
          sort: input.sort,
          count: 0,
          posts: [],
          mode: 'rss',
          error: res.error,
          recovery_hint: recovery_for(res.reason, res.status),
        };
      }
      const posts = parse_reddit_atom(res.body)
        .filter((e) => e.kind === 't3')
        .map(post_from_atom);
      return {
        subreddit: input.subreddit,
        sort: input.sort,
        count: posts.length,
        posts,
        mode: 'rss',
        note: RSS_MODE_NOTE,
      };
    }

    params.raw_json = '1';
    const res = await reddit_get(`/r/${input.subreddit}/${input.sort}`, params);
    if (!res.ok) {
      return {
        subreddit: input.subreddit,
        sort: input.sort,
        count: 0,
        posts: [],
        mode: 'oauth',
        error: res.error,
        recovery_hint: recovery_for(res.reason, res.status),
      };
    }
    try {
      const json = JSON.parse(res.body) as RedditListing;
      const children = json.data?.children ?? [];
      const posts = children.filter((c) => c.kind === 't3').map(post_from);
      return {
        subreddit: input.subreddit,
        sort: input.sort,
        count: posts.length,
        posts,
        mode: 'oauth',
      };
    } catch (err) {
      return {
        subreddit: input.subreddit,
        sort: input.sort,
        count: 0,
        posts: [],
        mode: 'oauth',
        error: `Failed to parse reddit response: ${(err as Error).message}`,
      };
    }
  },
};

// ── read_reddit_thread ──────────────────────────────────────────────

const ThreadIn = z.object({
  /** Full https://www.reddit.com/... URL, OR a /r/sub/comments/id/... permalink. */
  url: z.string().min(8),
  limit_comments: z.number().int().positive().max(100).default(25),
});

const ThreadOut = z.object({
  url: z.string(),
  post: Post.nullable(),
  comments: z.array(Comment),
  count: z.number(),
  mode: z.enum(['oauth', 'rss']).optional(),
  note: z.string().optional(),
  error: z.string().optional(),
  recovery_hint: RECOVERY_HINT,
});

type ThreadInT = z.infer<typeof ThreadIn>;
type ThreadOutT = z.infer<typeof ThreadOut>;

/**
 * Reduce a thread reference (full URL on any *.reddit.com host, or a
 * bare /r/... permalink) to the path oauth.reddit.com serves. Returns
 * null when the reference has no reddit thread path we can read.
 */
export function reddit_thread_path(input_url: string): string | null {
  let u = input_url.trim();
  if (u.startsWith('/r/')) u = `${REDDIT_BASE}${u}`;
  let path: string;
  try {
    path = new URL(u).pathname;
  } catch {
    return null;
  }
  path = path.replace(/\/+$/, '').replace(/\.json$/, '');
  if (!path.startsWith('/r/') && !path.startsWith('/comments/')) return null;
  return path;
}

export const read_reddit_thread: Tool<ThreadInT, ThreadOutT> = {
  name: 'read_reddit_thread',
  description:
    'Drill into a reddit thread: returns the post itself plus the top ' +
    'N top-level comments with author + body preview + score. Pass a ' +
    'full reddit URL or a /r/sub/comments/... permalink. Use after ' +
    '`read_subreddit` surfaces a thread worth understanding in detail. ' +
    "Reads reddit's public RSS feeds by default (in rss mode comment " +
    'scores are absent — UNKNOWN, not zero) or the OAuth API when a ' +
    'credential is configured. On an error, follow the recovery hint — ' +
    'never re-read reddit listings via `browse_url` (the rendered page ' +
    'truncates them).',
  risk: 'read',
  required_capabilities: ['read_reddit'],
  input_schema: ThreadIn,
  output_schema: ThreadOut,

  idempotency_key(input) {
    return `read_reddit_thread:${createHash('sha256')
      .update(input.url)
      .update('\n')
      .update(String(input.limit_comments))
      .digest('hex')
      .slice(0, 16)}`;
  },

  async execute(input: ThreadInT, _ctx: ToolContext): Promise<ThreadOutT> {
    const path = reddit_thread_path(input.url);
    if (!path) {
      return {
        url: input.url,
        post: null,
        comments: [],
        count: 0,
        error: `"${input.url}" is not a reddit thread URL or /r/... permalink.`,
        recovery_hint: {
          next_action:
            'Re-call read_reddit_thread with the full https://www.reddit.com/r/' +
            '<sub>/comments/<id>/... URL (or that path alone) — short redd.it ' +
            'links must be expanded to the canonical permalink first.',
        },
      };
    }
    if (!has_oauth_creds()) {
      const res = await reddit_get_rss(path, { limit: String(input.limit_comments) });
      if (!res.ok) {
        return {
          url: input.url,
          post: null,
          comments: [],
          count: 0,
          mode: 'rss',
          error: res.error,
          recovery_hint: recovery_for(res.reason, res.status),
        };
      }
      // Thread feed: first entry is the t3 post, the rest are t1 comments.
      const entries = parse_reddit_atom(res.body);
      const post_entry = entries.find((e) => e.kind === 't3');
      const comments = entries.filter((e) => e.kind === 't1').map(comment_from_atom);
      return {
        url: input.url,
        post: post_entry ? post_from_atom(post_entry) : null,
        comments,
        count: comments.length,
        mode: 'rss',
        note: RSS_MODE_NOTE,
      };
    }

    const res = await reddit_get(path, {
      limit: String(input.limit_comments),
      depth: '2',
      sort: 'top',
      raw_json: '1',
    });
    if (!res.ok) {
      return {
        url: input.url,
        post: null,
        comments: [],
        count: 0,
        mode: 'oauth',
        error: res.error,
        recovery_hint: recovery_for(res.reason, res.status),
      };
    }
    try {
      // Thread endpoint returns a 2-element array: [postListing, commentListing].
      const json = JSON.parse(res.body) as RedditListing[];
      const post_children = json[0]?.data?.children ?? [];
      const comment_children = json[1]?.data?.children ?? [];
      const first = post_children[0];
      const post = first && first.kind === 't3' ? post_from(first) : null;
      const comments = comment_children
        .filter((c) => c.kind === 't1')
        .map(comment_from);
      return {
        url: input.url,
        post,
        comments,
        count: comments.length,
        mode: 'oauth',
      };
    } catch (err) {
      return {
        url: input.url,
        post: null,
        comments: [],
        count: 0,
        mode: 'oauth',
        error: `Failed to parse reddit thread: ${(err as Error).message}`,
      };
    }
  },
};

// ── read_reddit_user ────────────────────────────────────────────────

// NOTE: no `.regex()` on `username` — see the SubredditIn note above. The
// name-shape check (also a URL-path-safety guard) lives in execute().
const UserIn = z.object({
  username: z
    .string()
    .min(1)
    .max(50)
    .describe('Reddit username without the leading u/'),
  kind: USER_KIND_ENUM.default('overview'),
  limit: z.number().int().positive().max(50).default(25),
});

const UserActivity = z.object({
  kind: z.enum(['post', 'comment']),
  post: Post.optional(),
  comment: Comment.optional(),
});

const UserOut = z.object({
  username: z.string(),
  kind: z.string(),
  count: z.number(),
  activity: z.array(UserActivity),
  mode: z.enum(['oauth', 'rss']).optional(),
  note: z.string().optional(),
  error: z.string().optional(),
  recovery_hint: RECOVERY_HINT,
});

type UserInT = z.infer<typeof UserIn>;
type UserOutT = z.infer<typeof UserOut>;

export const read_reddit_user: Tool<UserInT, UserOutT> = {
  name: 'read_reddit_user',
  description:
    "Pull a reddit user's recent submissions, comments, or both " +
    '(overview = mixed timeline; submitted = posts only; comments = ' +
    'comments only). Use it for public civic figures whose posts are ' +
    'worth tracking — officials, candidates, organizers commenting on ' +
    'local issues — paired with `read_reddit_thread` on individual ' +
    "permalinks for surrounding context. Reads reddit's public RSS " +
    'feeds by default (in rss mode scores/counts are absent — UNKNOWN, ' +
    'not zero) or the OAuth API when a credential is configured. On a ' +
    '403/404, follow the recovery hint — a refusal means our read was ' +
    'refused, NOT that the account is suspended or gone.',
  risk: 'read',
  required_capabilities: ['read_reddit'],
  input_schema: UserIn,
  output_schema: UserOut,

  idempotency_key(input) {
    return `read_reddit_user:${createHash('sha256')
      .update(input.username)
      .update('\n')
      .update(input.kind)
      .update('\n')
      .update(String(input.limit))
      .digest('hex')
      .slice(0, 16)}`;
  },

  async execute(input: UserInT, _ctx: ToolContext): Promise<UserOutT> {
    if (!/^[A-Za-z0-9_-]+$/.test(input.username)) {
      return {
        username: input.username,
        kind: input.kind,
        count: 0,
        activity: [],
        error:
          `"${input.username}" is not a valid reddit username (letters, digits, ` +
          `underscore, and hyphen only).`,
        recovery_hint: {
          next_action:
            'Re-call read_reddit_user with just the bare username, e.g. ' +
            '{"username":"spez"} — drop any leading "u/", URL, slashes, or spaces.',
        },
      };
    }
    if (!has_oauth_creds()) {
      // overview lives at /user/<name>.rss; submitted/comments get a segment.
      const rss_path =
        input.kind === 'overview'
          ? `/user/${input.username}`
          : `/user/${input.username}/${input.kind}`;
      const res = await reddit_get_rss(rss_path, { limit: String(input.limit) });
      if (!res.ok) {
        return {
          username: input.username,
          kind: input.kind,
          count: 0,
          activity: [],
          mode: 'rss',
          error: res.error,
          recovery_hint: recovery_for(res.reason, res.status),
        };
      }
      const activity: z.infer<typeof UserActivity>[] = [];
      for (const e of parse_reddit_atom(res.body)) {
        if (e.kind === 't3') activity.push({ kind: 'post', post: post_from_atom(e) });
        else if (e.kind === 't1')
          activity.push({ kind: 'comment', comment: comment_from_atom(e) });
      }
      return {
        username: input.username,
        kind: input.kind,
        count: activity.length,
        activity,
        mode: 'rss',
        note: RSS_MODE_NOTE,
      };
    }

    const res = await reddit_get(`/user/${input.username}/${input.kind}`, {
      limit: String(input.limit),
      raw_json: '1',
    });
    if (!res.ok) {
      return {
        username: input.username,
        kind: input.kind,
        count: 0,
        activity: [],
        mode: 'oauth',
        error: res.error,
        recovery_hint: recovery_for(res.reason, res.status),
      };
    }
    try {
      const json = JSON.parse(res.body) as RedditListing;
      const children = json.data?.children ?? [];
      const activity: z.infer<typeof UserActivity>[] = [];
      for (const c of children) {
        if (c.kind === 't3') activity.push({ kind: 'post', post: post_from(c) });
        else if (c.kind === 't1')
          activity.push({ kind: 'comment', comment: comment_from(c) });
      }
      return {
        username: input.username,
        kind: input.kind,
        count: activity.length,
        activity,
        mode: 'oauth',
      };
    } catch (err) {
      return {
        username: input.username,
        kind: input.kind,
        count: 0,
        activity: [],
        mode: 'oauth',
        error: `Failed to parse reddit user response: ${(err as Error).message}`,
      };
    }
  },
};

/** ToolLoader entry point — three tools out of one file. */
export function create(_deps: unknown): Tool[] {
  return [
    read_subreddit as unknown as Tool,
    read_reddit_thread as unknown as Tool,
    read_reddit_user as unknown as Tool,
  ];
}
