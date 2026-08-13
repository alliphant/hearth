/**
 * smoke:reddit-oauth — the reddit connector's two-mode contract.
 *
 * The bug this guards: reddit closed anonymous access to the JSON
 * endpoints (2026-08 — every unauthenticated request 403s regardless of
 * User-Agent, verified live from the LLM host), and the old connector kept
 * hammering them, then hinted specialists to re-read listings via
 * browse_url, whose rendered page TRUNCATES listing data (the
 * 2026-08-02/04 expired-proposal incident). The contract now:
 *
 *   - creds configured → OAuth: bearer token → oauth.reddit.com,
 *     full-fidelity fields.
 *   - no creds (default; reddit's API approvals are gated and slow) →
 *     RSS: reddit's public Atom feeds, degraded-but-honest fields —
 *     scores/counts OMITTED because they are unknown, never zero.
 *   - no recovery hint escalates a listing read to browse_url.
 *
 * Pure/offline — global fetch is mocked; no network.
 */
import {
  read_subreddit,
  read_reddit_thread,
  recovery_for,
  reddit_thread_path,
  parse_reddit_atom,
  _reset_reddit_token_cache,
} from '../src/connectors/reddit';
import type { ToolContext } from '@core/tool';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const CTX = {} as unknown as ToolContext;
const real_fetch = globalThis.fetch;

// ── 1. Thread-reference → API path ──────────────────────────────────

check(
  'path: full www URL',
  reddit_thread_path('https://www.reddit.com/r/Pleasantville/comments/abc123/some_title/') ===
    '/r/Pleasantville/comments/abc123/some_title',
);
check(
  'path: old.reddit host normalizes',
  reddit_thread_path('https://old.reddit.com/r/Pleasantville/comments/abc123') ===
    '/r/Pleasantville/comments/abc123',
);
check(
  'path: bare permalink',
  reddit_thread_path('/r/Pleasantville/comments/abc123/t/') === '/r/Pleasantville/comments/abc123/t',
);
check(
  'path: legacy .json suffix stripped',
  reddit_thread_path('https://www.reddit.com/r/x/comments/y.json') === '/r/x/comments/y',
);
check(
  'path: query string dropped',
  reddit_thread_path('https://www.reddit.com/r/x/comments/y?utm_source=share') ===
    '/r/x/comments/y',
);
check('path: non-reddit-thread reference → null', reddit_thread_path('https://redd.it/abc123') === null);
check('path: garbage → null', reddit_thread_path('not a url') === null);

// ── 2. Recovery hints: honest, and never a listings browse_url escalation ──

const auth = recovery_for('auth', 401);
check('hint auth: credential problem, not target evidence', /credential/.test(auth?.next_action ?? ''));

const limited = recovery_for('http', 429);
check('hint 429: says wait', /[Ww]ait/.test(limited?.next_action ?? ''));

const forbidden = recovery_for('http', 403);
check('hint 403: keeps the not-account-status guard', /NOT proof/.test(forbidden?.next_action ?? ''));

const missing = recovery_for('http', 404);
check('hint 404: keeps the not-deletion guard', /not proof of deletion/.test(missing?.next_action ?? ''));

check('hint 500: transient', /transient/.test(recovery_for('http', 502)?.next_action ?? ''));
check('hint network: retry next pass', /next pass/.test(recovery_for('network', 0)?.next_action ?? ''));

// The old connector set an `escalation: browse_url(...)` pointer on 403/429 —
// that is the exact path that produced truncated data. It must stay gone.
for (const [label, hint] of [
  ['auth', auth],
  ['429', limited],
  ['403', forbidden],
] as const) {
  check(`hint ${label}: no escalation pointer`, hint?.escalation === undefined);
  check(`hint ${label}: does not direct listings to browse_url`, !/escalate/i.test(hint?.next_action ?? ''));
}

// ── 3. Atom parser: reddit's actual feed shape ──────────────────────

// Mirrors the live feed byte-shape observed 2026-08-10: single-line XML,
// SC_OFF/SC_ON around selftext/comment bodies, "[link]" anchor for the
// post target, XML-escaped HTML content, t3_/t1_ id prefixes.
const SELF_POST_ENTRY =
  '<entry><author><name>/u/civic_sam</name><uri>https://www.reddit.com/user/civic_sam</uri></author>' +
  '<category term="Pleasantville" label="r/Pleasantville"/>' +
  '<content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;Council votes &amp;amp; agenda notes&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt; &amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/civic_sam&quot;&gt; /u/civic_sam &lt;/a&gt; &lt;br/&gt; &lt;span&gt;&lt;a href=&quot;https://www.reddit.com/r/Pleasantville/comments/aaa111/council_votes/&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;</content>' +
  '<id>t3_aaa111</id><link href="https://www.reddit.com/r/Pleasantville/comments/aaa111/council_votes/" />' +
  '<updated>2026-08-10T22:08:41+00:00</updated><published>2026-08-10T20:00:00+00:00</published>' +
  '<title>Council votes &amp; agenda</title></entry>';
const LINK_POST_ENTRY =
  '<entry><author><name>/u/poster2</name></author><category term="Pleasantville" label="r/Pleasantville"/>' +
  '<content type="html">&amp;#32; submitted by &amp;#32; &lt;a href=&quot;https://www.reddit.com/user/poster2&quot;&gt; /u/poster2 &lt;/a&gt; &lt;span&gt;&lt;a href=&quot;https://herald.com/story/x&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt;</content>' +
  '<id>t3_bbb222</id><link href="https://www.reddit.com/r/Pleasantville/comments/bbb222/story/" />' +
  '<published>2026-08-10T21:00:00+00:00</published><title>News story</title></entry>';
const COMMENT_ENTRY =
  '<entry><author><name>/u/replier</name></author><category term="Pleasantville" label="r/Pleasantville" />' +
  '<content type="html">&lt;!-- SC_OFF --&gt;&lt;div class=&quot;md&quot;&gt;&lt;p&gt;I was at the hearing&lt;/p&gt;&lt;/div&gt;&lt;!-- SC_ON --&gt;</content>' +
  '<id>t1_ccc333</id><link href="https://www.reddit.com/r/Pleasantville/comments/aaa111/council_votes/ccc333/"/>' +
  '<updated>2026-08-10T22:05:29+00:00</updated>' +
  '<title>/u/replier on Council votes &amp; agenda</title></entry>';
const FEED_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">' +
  '<category term="Pleasantville" label="r/Pleasantville"/><updated>2026-08-10T23:00:00+00:00</updated>' +
  '<link rel="self" href="https://www.reddit.com/r/Pleasantville/new.rss" type="application/atom+xml" />';
const SUB_FEED = `${FEED_HEAD}${SELF_POST_ENTRY}${LINK_POST_ENTRY}</feed>`;
const THREAD_FEED = `${FEED_HEAD}${SELF_POST_ENTRY}${COMMENT_ENTRY}</feed>`;

{
  const entries = parse_reddit_atom(SUB_FEED);
  check('atom: two entries', entries.length === 2);
  const [self_post, link_post] = entries;
  check('atom: kind t3', self_post?.kind === 't3' && link_post?.kind === 't3');
  check('atom: bare id', self_post?.id === 'aaa111');
  check('atom: title unescaped', self_post?.title === 'Council votes & agenda');
  check('atom: author bare username', self_post?.author === 'civic_sam');
  check('atom: subreddit from category', self_post?.subreddit === 'Pleasantville');
  check('atom: selftext from SC span, entities decoded', self_post?.text === 'Council votes & agenda notes');
  check('atom: self post has no out_url', self_post?.out_url === '');
  check('atom: link post carries external target', link_post?.out_url === 'https://herald.com/story/x');
  check('atom: link post has empty selftext', link_post?.text === '');
  check('atom: published preferred over updated', self_post?.published_iso === '2026-08-10T20:00:00+00:00');
}
{
  const entries = parse_reddit_atom(THREAD_FEED);
  const comment = entries.find((e) => e.kind === 't1');
  check('atom: comment classified t1', comment?.id === 'ccc333');
  check('atom: comment body from SC span', comment?.text === 'I was at the hearing');
  check('atom: comment permalink', comment?.link.endsWith('/ccc333/') === true);
}

// ── 4. No credential → RSS mode, degraded-but-honest fields ─────────

delete process.env.REDDIT_CLIENT_ID;
delete process.env.REDDIT_CLIENT_SECRET;
_reset_reddit_token_cache();

let fetch_calls: { url: string; init: RequestInit }[] = [];
function respond(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
}
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  fetch_calls.push({ url: u, init: init ?? {} });
  if (u.startsWith('https://www.reddit.com/r/pleasantville/new.rss')) return respond(200, SUB_FEED);
  if (u.startsWith('https://www.reddit.com/r/Pleasantville/comments/aaa111/council_votes.rss'))
    return respond(200, THREAD_FEED);
  throw new Error(`smoke: unexpected fetch ${u}`);
}) as unknown as typeof fetch;

{
  const out = await read_subreddit.execute({ subreddit: 'pleasantville', sort: 'new', limit: 2 }, CTX);
  check('rss sub: read succeeded', out.error === undefined && out.count === 2);
  check('rss sub: mode stamped', out.mode === 'rss');
  check('rss sub: unknown-not-zero note present', /not zero/i.test(out.note ?? ''));
  check('rss sub: score omitted, not fabricated', out.posts[0]?.score === undefined);
  check('rss sub: num_comments omitted', out.posts[0]?.num_comments === undefined);
  check('rss sub: self/link distinguished', out.posts[0]?.is_self === true && out.posts[1]?.is_self === false);
  check('rss sub: link post url is the external target', out.posts[1]?.url === 'https://herald.com/story/x');
  check('rss sub: UA sent', /hearth-civic-correspondent/.test(((fetch_calls[0]?.init.headers ?? {}) as Record<string, string>)['User-Agent'] ?? ''));
  check('rss sub: no oauth/token calls', fetch_calls.every((c) => !c.url.includes('oauth.reddit.com') && !c.url.includes('access_token')));
}

{
  fetch_calls = [];
  const out = await read_reddit_thread.execute(
    { url: 'https://www.reddit.com/r/Pleasantville/comments/aaa111/council_votes/', limit_comments: 10 },
    CTX,
  );
  check('rss thread: post extracted', out.post?.id === 'aaa111');
  check('rss thread: comments extracted', out.count === 1 && out.comments[0]?.body === 'I was at the hearing');
  check('rss thread: comment score omitted', out.comments[0]?.score === undefined);
  check('rss thread: mode stamped', out.mode === 'rss');
}

// ── 5. OAuth flow: token mint shape, bearer read, token cache ───────

process.env.REDDIT_CLIENT_ID = 'smoke-id';
process.env.REDDIT_CLIENT_SECRET = 'smoke-secret';
_reset_reddit_token_cache();
fetch_calls = [];

const LISTING = JSON.stringify({
  kind: 'Listing',
  data: {
    children: [
      {
        kind: 't3',
        data: {
          id: 'p1',
          title: 'Smoke post',
          author: 'smoker',
          subreddit: 'pleasantville',
          permalink: '/r/pleasantville/comments/p1/smoke_post/',
          url: 'https://www.reddit.com/r/pleasantville/comments/p1/smoke_post/',
          selftext: 'body',
          score: 5,
          num_comments: 2,
          is_self: true,
          created_utc: 1754800000,
        },
      },
    ],
  },
});

let api_statuses: number[] = [];
let token_serial = 0;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  fetch_calls.push({ url: u, init: init ?? {} });
  if (u.startsWith('https://www.reddit.com/api/v1/access_token')) {
    token_serial++;
    return respond(200, JSON.stringify({ access_token: `tok${token_serial}`, expires_in: 3600 }));
  }
  const status = api_statuses.shift() ?? 200;
  if (status !== 200) return respond(status, status === 401 ? 'Unauthorized' : 'nope');
  return respond(200, LISTING);
}) as unknown as typeof fetch;

{
  const out = await read_subreddit.execute({ subreddit: 'pleasantville', sort: 'new', limit: 2 }, CTX);
  check('oauth: read succeeded', out.error === undefined && out.count === 1);
  check('oauth: mode stamped', out.mode === 'oauth');
  check('oauth: full-fidelity fields present', out.posts[0]?.score === 5 && out.posts[0]?.num_comments === 2);

  const mint = fetch_calls[0];
  const read = fetch_calls[1];
  check('oauth: first call mints at the token endpoint', mint?.url.startsWith('https://www.reddit.com/api/v1/access_token') === true);
  const mint_headers = (mint?.init.headers ?? {}) as Record<string, string>;
  check('oauth: mint uses HTTP basic client auth', /^Basic /.test(mint_headers.Authorization ?? ''));
  check('oauth: mint asks for client_credentials', String(mint?.init.body) === 'grant_type=client_credentials');
  check('oauth: mint sends the descriptive UA', /hearth-civic-correspondent/.test(mint_headers['User-Agent'] ?? ''));

  check('oauth: read goes to oauth.reddit.com', read?.url.startsWith('https://oauth.reddit.com/r/pleasantville/new') === true);
  const read_headers = (read?.init.headers ?? {}) as Record<string, string>;
  check('oauth: read carries the bearer', read_headers.Authorization === 'Bearer tok1');
}

{
  const before = fetch_calls.length;
  await read_subreddit.execute({ subreddit: 'pleasantville', sort: 'new', limit: 2 }, CTX);
  const minted = fetch_calls.slice(before).filter((c) => c.url.includes('access_token'));
  check('oauth: token is cached across calls (no re-mint)', minted.length === 0);
}

// ── 6. Expired bearer: exactly one re-mint, then the read lands ─────

_reset_reddit_token_cache();
fetch_calls = [];
token_serial = 0;
api_statuses = [401];

{
  const out = await read_subreddit.execute({ subreddit: 'pleasantville', sort: 'new', limit: 2 }, CTX);
  check('remint: read succeeded after one re-mint', out.error === undefined && out.count === 1);
  const mints = fetch_calls.filter((c) => c.url.includes('access_token'));
  const reads = fetch_calls.filter((c) => c.url.startsWith('https://oauth.reddit.com/'));
  check('remint: exactly two mints', mints.length === 2);
  check('remint: exactly two reads', reads.length === 2);
  const second_read_headers = (reads[1]?.init.headers ?? {}) as Record<string, string>;
  check('remint: second read uses the fresh bearer', second_read_headers.Authorization === 'Bearer tok2');
}

// ── 7. A 403 on a valid credential surfaces the guard hint ──────────

_reset_reddit_token_cache();
fetch_calls = [];
token_serial = 0;
api_statuses = [403];

{
  const out = await read_subreddit.execute({ subreddit: 'privateplace', sort: 'hot', limit: 2 }, CTX);
  check('403: error surfaced', /HTTP 403/.test(out.error ?? ''));
  check('403: hint carries the not-account-status guard', /NOT proof/.test(out.recovery_hint?.next_action ?? ''));
  check('403: no browse_url escalation pointer', out.recovery_hint?.escalation === undefined);
}

globalThis.fetch = real_fetch;
delete process.env.REDDIT_CLIENT_ID;
delete process.env.REDDIT_CLIENT_SECRET;

console.log(failures === 0 ? '\nsmoke:reddit-oauth OK' : `\nsmoke:reddit-oauth FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
