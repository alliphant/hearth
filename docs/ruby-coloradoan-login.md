# Ruby's Herald login — one-time setup on the workstation

Ruby's evening deliberation reads the Herald local-news section
via `browse_url` (the real Firefox session on the workstation) so the
paywall can be defeated by Jasper's actual subscription. Each
specialist runs in its own Firefox profile (`firefox -P <id>`); Ruby's
profile is fresh and not logged in.

This runbook gets Ruby's the workstation Firefox profile signed into Jasper's
Herald subscription so subsequent automated reads can render full
article bodies.

## When to run this

- Once at hire time (today).
- Whenever Herald rotates auth (rare; their session length is
  measured in weeks/months but not infinite).
- If the evening Herald sweep starts reporting paywall
  placeholders instead of bodies — that's Ruby's FYI signal that
  the session expired.

## Steps

On the dev workstation (or via SSH with X-forwarding from the workstation):

```bash
# 1. SSH to the workstation
ssh jasper@the workstation.local

# 2. Make sure agentd has spun up Ruby's profile at least once. The
#    easiest way is to fire a benign browse_url from Hearth (or just
#    let her first deliberation pass do it). After that, the profile
#    directory exists at ~/.mozilla/firefox/<rand>.ruby/.

# 3. Run Firefox interactively against Ruby's profile so you can
#    drive the login by hand:
firefox -P ruby --no-remote
```

In the launched Firefox window:

1. Navigate to `https://login.herald.com` (or click "Sign In" on
   herald.com).
2. Log in with Jasper's Herald credentials.
3. **Check "Keep me signed in"** if it's offered. This persists the
   session cookie across browser restarts.
4. Load `https://www.herald.com/news/local/` once and confirm
   that an article opens with the full body, not a paywall card.
5. **Close Firefox cleanly — fully quit the window.** The profile
   state persists on disk; closing doesn't lose anything.
   THIS STEP IS LOAD-BEARING — see the lock-conflict gotcha in
   [ruby-reddit-login.md](ruby-reddit-login.md).

Next time agentd spins up `firefox -P ruby` for an automated
browse_url call, the session is already authenticated.

## Verifying it worked

From Hearth, ask Ruby directly:

> "Ruby, do me a favor and check the Herald local news section
> right now. Read me one of today's headlines."

Watch the audit log for a `browse_url` call against `herald.com`.
If she returns headlines + an actual story summary, the login
succeeded. If she returns paywall language ("Subscribe to read…"),
the session didn't persist; repeat the steps above, paying
particular attention to the "Keep me signed in" checkbox.

## Why this isn't shared with other specialists

Each specialist gets her own Firefox profile by design — privacy
scope. Jasper's login state lives only in Ruby's profile, not in
Maggie's or anyone else's. If a future specialist also needs
Herald access, run this same flow against that specialist's
profile.

## Related runbook

- [ruby-reddit-login.md](ruby-reddit-login.md) — Ruby's reddit
  account (`u/AccountableFC`) login in the same Firefox profile.
  Same pattern, different source.

## Audit redaction

The `browse_url` connector redacts URLs to host-only in audit rows
by default (per `config/privacy.yaml` `browse.audit_redaction`). The
Herald article URLs Ruby reads end up in audit as
`host=herald.com path=<redacted>`. Full URLs and body content
land only in Ruby's vault writes (Knowledge/Pleasantville/news/), where
the standard `private_to: jasper` frontmatter scopes them.
