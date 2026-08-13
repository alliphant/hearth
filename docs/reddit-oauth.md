# Reddit access — RSS by default, OAuth if ever approved (2026-08-10)

Reddit closed anonymous access to its JSON endpoints in early August
2026: `<url>.json` returns HTTP 403 to every non-browser client
**regardless of User-Agent** — verified live from the LLM host's residential
IP with the descriptive scripted UA, a full Chrome UA, and
old.reddit.com (all 403 with an HTML block page). The
authenticated-browser workaround ([ruby-reddit-login.md](ruby-reddit-login.md))
renders but truncates listing data — that's what produced the two
expired proposals of 2026-08-02/04.

And the classic fix — "create an API app" — is no longer self-service:
reddit's **Responsible Builder Policy** (late 2025) gates every new
OAuth credential behind a manual approval request, with multi-week
queues and widespread reports of personal-use requests going
unanswered. So the connector
([src/connectors/reddit.ts](../src/connectors/reddit.ts)) has two
modes and picks by config:

## RSS mode — the default, live today, no credential

Reddit's public Atom feeds still serve anonymous clients with a
descriptive UA (verified live 2026-08-10 from the orchestrator
container): `/r/<sub>/<sort>.rss` (incl. `top.rss?t=week`),
`/user/<name>[/submitted|/comments].rss`, and `<permalink>.rss` for
thread comments. Feeds are an intentionally public surface — this is
ordinary feed-reader access, not a workaround.

Degraded but honest: the feeds carry no scores, comment counts, or
moderation flags, so those fields are **omitted** (unknown ≠ zero) and
every result is stamped `mode: 'rss'` plus a `note` saying exactly
that. Self/link posts are still distinguished (the feed's `[link]`
anchor), selftext and comment bodies come through, timestamps are real.

The anonymous per-IP budget is small — bursts 429 quickly; spaced
single requests are fine. Ruby's LLM-paced call pattern (one listing +
a few thread reads per pass) fits under it. On 429 the recovery hint
says wait — never re-read listings via `browse_url`.

## OAuth mode — full fidelity, if reddit ever approves a credential

With `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` set, the connector
switches to the OAuth API: `client_credentials` → bearer token at
`/api/v1/access_token` (cached, single-flight, one re-mint on a
mid-window 401) → the same listing paths on `https://oauth.reddit.com`
at ~100 req/min, with scores/counts/flags restored.

### If Jasper wants to pursue it (optional)

1. Request Data API access per the [Responsible Builder
   Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
   (category: developer; non-commercial, read-only civic research,
   <100 QPM, no posting/voting/automation of writes). Apply as
   **u/AccountableFC** (Ruby's read-only account) to keep it out of
   your personal reddit life. Expect weeks or silence — RSS mode
   covers the gap indefinitely.
2. If approved: <https://www.reddit.com/prefs/apps> → create app →
   type **script**, name `hearth-civic-correspondent`, redirect
   `http://localhost`.
3. Put the client id + secret in `/docker/hearth/hearth.env`:

   ```
   REDDIT_CLIENT_ID=<client id>
   REDDIT_CLIENT_SECRET=<secret>
   ```

4. `ssh glacier 'cd /docker && docker compose restart hearth-orchestrator'`

The connector's default User-Agent is
`server:hearth-civic-correspondent:v1.0 (by /u/AccountableFC)` —
reddit's required shape. Override with `REDDIT_USER_AGENT` only if the
app owner ever changes.

## Verifying

RSS mode, straight through the deployed connector:

```bash
ssh glacier 'docker exec hearth-orchestrator bun -e "const m = await import(\"/app/src/connectors/reddit.ts\"); console.log(JSON.stringify(await m.read_subreddit.execute({subreddit:\"Pleasantville\",sort:\"new\",limit:3},{}),null,1))"'
```

Then the audit log after Ruby's next COMMUNITY pass (07:30):

```bash
ssh glacier 'sqlite3 /docker/hearth/data/hearth.db "SELECT ts, tool_name, substr(execution_result,1,200) FROM audit_log WHERE agent=\"ruby\" AND (tool_name LIKE \"read_reddit%\" OR tool_name=\"read_subreddit\") ORDER BY ts DESC LIMIT 5"'
```

Successful reads have non-empty `posts` / `activity`, `mode`, and no
`error`.

## Failure contract (what specialists see)

| Condition | `error` | hint |
| --- | --- | --- |
| Bad/revoked OAuth creds | `token endpoint: the client id/secret pair was rejected` | credential problem, flag for Jasper |
| 429 (either mode) | `HTTP 429: …` | rate budget; wait for the next pass |
| 403 | `HTTP 403: …` | refusal ≠ suspended/deleted; never recorded as account status |
| 404 | `HTTP 404: …` | lookup outcome ≠ deletion; existence check via `browse_url` allowed |

Guarded by `bun run smoke:reddit-oauth`
([scripts/smoke-reddit-oauth.ts](../scripts/smoke-reddit-oauth.ts)) —
offline, global fetch mocked: Atom parsing against the live feed shape,
RSS-mode field omission (unknown ≠ zero), the OAuth mint/bearer/cache/
re-mint flow, and the no-browse_url-escalation rule.

## What did NOT change

- Ruby's read-only discipline (no posts/comments/votes/DMs — see
  "Your reddit identity" in
  [config/specialists/ruby.yaml](../config/specialists/ruby.yaml)).
- `browse_url` on reddit for *existence checks* (does this account
  exist at all) — an ordinary visitor's read. Listings never go
  through the browser: truncation.
- The the workstation Firefox login remains only as the rendered-page
  session for those existence checks; it is no longer part of the
  listing path at all.
