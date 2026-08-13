# Ruby's reddit login — one-time setup on the workstation

> **⚠️ Superseded for the read tools (2026-08-10).** Reddit closed
> anonymous JSON access entirely — every non-browser client 403s
> regardless of UA — and the browser-rendered path truncates listing
> data. `read_subreddit` / `read_reddit_thread` / `read_reddit_user`
> now read reddit's **public RSS feeds** by default, switching to the
> OAuth API if a credential is ever approved: see
> [reddit-oauth.md](reddit-oauth.md). The Firefox login below remains
> relevant ONLY for `browse_url` existence checks on rendered reddit
> pages — it is no longer part of the listing path, and no recovery
> hint escalates listings to the browser anymore.

Ruby reads r/Pleasantville and individual reddit users (Kim:
u/Kinnasad) via her `read_subreddit`, `read_reddit_thread`, and
`read_reddit_user` tools. Each specialist runs
in its own Firefox profile (`firefox -P <id>`); Ruby's profile gets
signed into a dedicated reddit account.

**Account identity:** `u/AccountableFC` — created 2026-05-30, kept
separate from Jasper's personal reddit life on purpose. See the
"Your reddit identity" section in
[config/specialists/ruby.yaml](../config/specialists/ruby.yaml) for
the read-only discipline.

## When to run this

- Once at hire time (done 2026-05-30).
- Whenever reddit invalidates the session — usually weeks-to-months,
  faster if reddit detects unusual activity from the account.
- If the daily read_subreddit / read_reddit_user calls start
  returning HTTP 401/403 with body content suggesting "log in to
  continue" instead of the standard anti-bot interstitial, that's
  the signal.

## Steps

```bash
# 1. SSH to the workstation.
ssh jasper@the workstation

# 2. Make sure Ruby's profile exists. By now it does (created
#    interactively during the Herald setup). If not, fire any
#    browse_url call from Hearth so agentd materializes it.

# 3. Run Firefox interactively against Ruby's profile.
firefox -P ruby --no-remote
```

In the launched Firefox window:

1. Navigate to `https://www.reddit.com/login`.
2. Sign in as `u/AccountableFC`. Use the password manager / your
   stored credential — do NOT type it into shared screen contexts.
3. **Check any "Keep me signed in" / "Stay logged in" option** so
   the session persists across browser restarts.
4. Load `https://www.reddit.com/r/Pleasantville/` once and confirm
   the page renders fully (vote arrows visible, profile menu shows
   AccountableFC).
5. **Close Firefox cleanly — fully quit the window.** The profile
   state persists on disk; closing doesn't lose anything. THIS
   STEP IS LOAD-BEARING.

> **⚠️ Gotcha — profile lock conflict.** Firefox profiles are
> single-process by design. If your interactive `firefox -P ruby
> --no-remote` window stays open after login, agentd's `browse_url`
> WebDriver calls will fail with `createSession returned 500:
> webdriver_create_failed / Failed to set preferences`. The
> interactive Firefox holds `~/.config/mozilla/firefox/<profile>/
> .parentlock` and the `lock` symlink, blocking the WebDriver
> session. Verify after closing:
>
> ```bash
> ls ~/.config/mozilla/firefox/zw5g4zv6.ruby/lock
> # Should say: cannot access 'lock': No such file or directory
> ```
>
> If you ever need to update the login again, follow the same
> "open Firefox interactively → log in → CLOSE Firefox completely"
> sequence.

## New-account probation (historical)

AccountableFC's first-30-days "trust score" probation ended in
late June 2026. The paragraph that used to live here — expect 429s,
fall back to `browse_url` minus `.json` — described the anonymous-
JSON era and is obsolete: since 2026-08-10 the read tools use the
OAuth API ([reddit-oauth.md](reddit-oauth.md)) and listings never
go through the browser.

## What Ruby will NEVER do with this account

Ruby's persona explicitly forbids — and these are structural, not
aspirational:

- Posting submissions
- Commenting on threads
- Upvoting or downvoting
- Saving posts
- Subscribing to subreddits
- Sending DMs / chat messages
- Updating profile details

She reads. She observes. She synthesizes into the vault. That's the
whole interaction model. If the audit log ever shows AccountableFC
making a write call to reddit, that's a persona-discipline failure
worth treating as a high-severity bug.

## Verifying it worked

The audit log is the truth. After a deliberation pass that called
`read_subreddit` or `read_reddit_user`:

```bash
ssh glacier 'sqlite3 /docker/hearth/data/hearth.db "SELECT ts, tool_name, substr(execution_result,1,200) FROM audit_log WHERE agent=\"ruby\" AND (tool_name LIKE \"read_reddit%\" OR tool_name=\"read_subreddit\") ORDER BY ts DESC LIMIT 5"'
```

Successful authenticated reads have non-empty `posts` / `activity`
arrays and no `error` field. HTTP 403 / 429 errors return populated
`recovery_hint` pointers — those are expected occasionally during
probation, not bugs.

## Audit redaction

Reddit URLs Ruby reads end up in the audit log host-only by default,
per the `browse.audit_redaction` setting in `config/privacy.yaml`
(when she falls back to `browse_url`). Direct `read_reddit_*` tool
audit rows carry the subreddit / username / thread URL — those are
public-by-construction so no redaction is needed there.
