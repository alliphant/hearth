# Proposal — self-service password reset + optional login 2FA

> **STATUS: SHAPE APPROVED 2026-06-07 — §0 decisions locked. No code
> shipped yet (awaiting an explicit "build it").** This is auth; per the
> standing rule nothing gets built until Jasper gives the go. The three
> design forks in **§0** are now decided (see the banner there).

*Author: Claude. Date: 2026-06-07.*

## Why

Today there is **no self-service password reset** (only an admin PATCH or
a hand-edit of `users.yaml`) and **no login second factor**. Jasper wants
household members to reset their *own* passwords via a one-time code sent
to **email (SMTP)** or **SMS (text)**, and wants an *optional* stronger
login 2FA available.

This proposal designs both, reusing the auth primitives already in the
tree so the new surface matches the patterns we already trust.

## What we're building on (already in the repo)

The design deliberately copies four existing things rather than inventing:

1. **argon2id + the comment-preserving write path.** Password hashing is
   `Bun.password.hash(pw, { algorithm: 'argon2id', memoryCost: 65536,
   timeCost: 3 })` and persistence is `UserRegistry.update_user(id, {
   password_hash })`, which rewrites `users.yaml` through the YAML
   Document API so comments survive
   ([src/core/users.ts:636](../../src/core/users.ts#L636),
   [auth.ts change_password:477](../../src/app/routes/auth.ts#L477)). A
   reset just lands a new hash through the same path.
2. **The PIN rate-limiter** — a per-user, kv-backed, restart-surviving
   sliding window (5 attempts / 15 min) in
   `_check_pin_rate` / `_record_pin_failure`
   ([src/core/users.ts:763](../../src/core/users.ts#L763)). This is the
   exact model for throttling reset-code *verify* attempts.
3. **The step-up grant store** — single-use, short-TTL, **atomically
   consumed** (`UPDATE … WHERE consumed_at IS NULL`)
   ([src/core/step_up.ts:75](../../src/core/step_up.ts#L75)). This is the
   exact model for a reset code's lifecycle.
4. **The APNs transport seam** — a typed `ApnsTransport` with
   `_test_set_transport(fn)` so smokes never touch Apple
   ([src/policy/apns.ts:255](../../src/policy/apns.ts#L255)). The new
   email/SMS sender mirrors this exactly so it's testable offline.

Existing facts that shape the design:

- **Every user already has an `email`** in `users.yaml`
  (jasper/sam/kim all do). **No user has a phone number** — there is no
  `phone` field anywhere yet. So email works for everyone today; SMS
  needs a new field first.
- The on-file emails are all **major-provider mailboxes** (Gmail). That
  matters for the transport choice (§4).
- Login is already email + password
  ([auth.ts /auth/login:258](../../src/app/routes/auth.ts#L258)) and
  already does the "don't leak whether the email exists" thing — a single
  `invalid credentials` for every failure
  ([auth.ts:266](../../src/app/routes/auth.ts#L266)), plus a constant-time
  dummy argon2 verify when the user doesn't exist
  ([users.ts:405](../../src/core/users.ts#L405)). The reset flow inherits
  this discipline.
- The PIN already *is* a kind of second factor — but only **step-up for
  high-risk actions** (approving a spend), not **login**. Login 2FA is a
  genuinely new thing.

---

## §0 — Decisions for Jasper (sign-off gates)

> **DECIDED 2026-06-07 (Jasper):** D0.1 → **Gmail SMTP (app password)**.
> D0.2 → **defer Twilio behind the abstraction** (email-only first).
> D0.3 → **opt-in login 2FA for all, nudge owner/admin.** All three are
> the recommended options below; the rest of the doc already assumes them.

These three are yours; everything else follows from them. My
recommendation is first in each list with the reasoning.

**D0.1 — Email transport.** How does the code actually get to a Gmail
inbox in seconds, not the spam folder?
- **(Recommended) Authenticated SMTP through an existing Gmail account
  (app password).** No new vendor, no signup; Gmail→Gmail delivers
  reliably because it's an authenticated, reputable sender. Config is 4
  env vars. Behind a swappable interface so we can change our minds.
- Hosted transactional API (Postmark / Resend / SES). Best deliverability
  + DKIM at scale, dead-simple HTTP, free tier covers household volume —
  but it's a new SaaS account and a second outbound cloud dependency.
- Local relay (postfix/msmtp from the home IP). Most "local-first," but a
  residential IP sending to Gmail gets spam-foldered or rejected, which
  *breaks* OTP. Not recommended as the default.

**D0.2 — SMS now, or design-for-later?**
- **(Recommended) Design the channel abstraction now, defer the Twilio
  transport.** Everyone has email; nobody has a phone on file. Ship email
  first; add an `phone` field + a `TwilioTransport` as a drop-in when a
  user actually wants texts. No rework — SMS becomes one transport class.
- Ship Twilio now. Requires: a paid Twilio account, a new verified-`phone`
  field on each user, and a phone-verification sub-flow. More surface for
  a feature nobody's asked to *use* yet.

**D0.3 — Login 2FA scope.**
- **(Recommended) Opt-in for everyone; recommended-not-enforced for
  owner/admin.** The threat model here is "well-meaning automation
  overstepping," and the orchestrator is Tailscale/LAN-bound, never
  WAN-exposed. Forcing TOTP on every household member is friction without
  a matching threat. Make it available; nudge the admin.
- Enforce 2FA for owner + admin tiers. Stronger, but a lost authenticator
  locks the captain out (mitigated by recovery codes).
- Reset only for now; defer login 2FA entirely. Smallest surface; revisit
  later.

*(My defaults below assume D0.1=Gmail SMTP, D0.2=defer SMS, D0.3=opt-in.
Say the word and I'll re-cut.)*

---

## §1 — Channel comparison & recommended default

| | **Email OTP (SMTP)** | **SMS OTP (Twilio)** | **TOTP (authenticator app)** |
|---|---|---|---|
| Infra needed | an email sender | paid Twilio + `phone` field | **none** (RFC 6238 math) |
| On file today? | ✅ all users | ❌ no phone field | ❌ nobody enrolled |
| App required? | no | no | **yes** (Authy / Google Auth / 1Password) |
| Friction | open inbox, type code | open texts, type code | install app, scan QR, have phone |
| Strength | medium (depends on inbox security) | medium (SIM-swap risk) | **strong** (no channel to intercept) |
| Good for **reset**? | **✅ best default** | ✅ if phone-first | ⚠️ awkward (lose the app → can't reset) |
| Good for **login 2FA**? | ✅ no-app fallback | ✅ | **✅ best** |

**Recommendation:**

- **Default reset channel → Email OTP.** Every user already has an email;
  no app to install; and — crucially — *the email inbox is itself the
  cordon* (§5): a code sent to `sam@…` can only be received by whoever
  controls that inbox, so a reset can only ever unlock Sam's account.
- **Optional login 2FA → TOTP, with Email OTP as the no-app fallback.**
  TOTP is the strongest and needs zero infra; the email path reuses the
  same sender so an app-averse member can still turn on 2FA.
- **SMS → design the abstraction, defer the transport** (D0.2).

---

## §2 — Flow A: forgot-password self-service reset

Two unauthenticated endpoints. The whole flow is anti-enumeration by
construction.

### A.1 — Request a code

```
POST /api/auth/request_password_reset   { email, channel? }   → always 200
```

1. Resolve the user by email (`UserRegistry.resolve_by_email`,
   [users.ts:380](../../src/core/users.ts#L380)).
2. **Always return the same 200 body** — *"If an account exists for that
   address, we've sent a reset code."* — whether or not the email exists,
   has the channel on file, or is rate-limited. Never branch the response
   on existence. (Mirrors the login non-leak.)
3. If (and only if) the user exists and has the channel: generate a code,
   hash it, store it, and send it (§3, §4). Requesting a *new* code
   invalidates any outstanding one for that account (one live code at a
   time).
4. **Rate-limit per email AND per source IP** so the endpoint can't be
   used to enumerate addresses or flood a victim's inbox. Same kv
   sliding-window as the PIN limiter.
5. Audit `auth_password_reset_requested` with the email *hash* + channel
   + whether-sent — but the **response is identical regardless**
   (reuse `_audit_auth`, [auth.ts:51](../../src/app/routes/auth.ts#L51)).

### A.2 — Confirm the code + set the new password

```
POST /api/auth/confirm_password_reset   { email, code, new_password }   → 200 | 401 | 429
```

1. **Rate-limit verify attempts per email** (kv sliding window; 5 wrong
   codes → the code is burned, 429 with `Retry-After`).
2. Look up the single live code for that account; constant-time compare
   the hash; **atomically consume it** (`UPDATE … WHERE consumed_at IS
   NULL`, copied from step-up) so two racing confirms can't both win.
3. On success: `new_password` (≥10 chars, same Zod rule as
   change_password, [auth.ts:199](../../src/app/routes/auth.ts#L199)) is
   argon2id-hashed and written via `update_user({ password_hash,
   must_change_password: false })`.
4. **Revoke every existing session and device for that user.** A reset
   means "I lost the password" — kill outstanding credentials so a reset
   also evicts anyone who shouldn't be there. (We already have
   `SessionStore.revoke` / `DeviceStore.revoke`.) The user logs in fresh.
5. Audit `auth_password_reset_completed`.
6. **Failure responses are flat:** wrong / expired / already-used code all
   return one *"invalid or expired code"* (don't distinguish); too many
   attempts → 429. No oracle.

---

## §3 — Token model (the reset code)

Mirrors `step_up.ts` (single-use, short-TTL, atomic consume) + the PIN
limiter (attempt cap).

- **Code shape:** 6-digit numeric (OTP convention; easy to type from a
  phone). Low entropy (10⁶) is *fine* because the attempt cap + short
  expiry + single-use do the real work — the same trade-off the 4-digit
  PIN makes, and the PIN limiter is the proven control here.
- **At rest:** store `sha256(code)` only, never the plaintext. (A slow
  hash like argon2 is overkill for a 10-minute single-use code, and an
  attacker who can read the DB can brute-force 10⁶ sha256 instantly
  anyway — so the at-rest hash is disclosure-hygiene; the *brute-force*
  defense is the rate limiter, stated plainly so nobody mistakes the
  hash for the control.)
- **Expiry:** 10 minutes.
- **Single live code per account:** a new request supersedes the old.
- **Single-use:** atomic consume on first correct submission.
- **Storage:** a new SQLite table (idempotent `CREATE … IF NOT EXISTS`,
  no `SCHEMA_VERSION` bump — additive, the repo's standard migration
  pattern). One generic table serves reset *and* the email-2FA path:

  ```sql
  CREATE TABLE IF NOT EXISTS otp_codes (
    id            TEXT PRIMARY KEY,         -- otp_<ulid>
    user_id       TEXT NOT NULL,
    purpose       TEXT NOT NULL,            -- 'password_reset' | 'login_2fa'
    channel       TEXT NOT NULL,            -- 'email' | 'sms'
    code_hash     TEXT NOT NULL,            -- sha256(code)
    destination_hint TEXT,                  -- redacted ('j***@gmail.com') for audit/UI
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    consumed_at   TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0
  );
  ```

  (Verify-attempt throttling can live in `attempt_count` here *or* in the
  kv sliding window the PIN limiter already uses — I lean kv for
  consistency with the existing limiter. Final call at implementation.)

---

## §4 — Flow B: optional login 2FA

Per-user opt-in. **Secrets live in SQLite, never in `users.yaml`** — the
YAML is hand-edited and git-tracked, so a TOTP seed must not sit there
(same rule the Code Shop follows for its tokens). `users.yaml` carries
only a non-secret `mfa_enabled` boolean + `mfa_method`; the secret + the
recovery-code hashes live in a `user_mfa` table.

```sql
CREATE TABLE IF NOT EXISTS user_mfa (
  user_id            TEXT PRIMARY KEY,
  method             TEXT NOT NULL,         -- 'totp' | 'email'
  totp_secret_enc    TEXT,                  -- encrypted at rest (key from env), null for email method
  recovery_codes_json TEXT,                 -- array of sha256(code), single-use
  enabled            INTEGER NOT NULL DEFAULT 0,
  enrolled_at        TEXT
);
```

### B.1 — Enroll (authenticated, behind a password re-auth / step-up)

```
POST /api/auth/mfa/enroll   { method }   → provisioning URI + QR (totp) | 'code sent' (email)
POST /api/auth/mfa/activate { code }     → activates after one successful verify + returns recovery codes (shown once)
```

Activation requires verifying one code first (proves enrollment worked),
then issues 8–10 single-use **recovery codes** (hashed at rest, shown
once) so a lost authenticator never means a locked-out account.

### B.2 — Login with 2FA (two-step)

1. `POST /auth/login { email, password }` → on a correct password, if
   `mfa_enabled`: **do not set the full session cookie.** Return
   `{ mfa_required: true, method, challenge_id }` (and, for the email
   method, send a code). Issue a short-lived **pending/half-session**
   token bound to `challenge_id`.
2. `POST /auth/login/mfa { challenge_id, code }` → verify TOTP (RFC 6238,
   ±1 time-step window for clock skew) **or** the email OTP **or** a
   single-use recovery code → on success, create the *real* session + set
   the cookie (the existing `_set_session_cookie`,
   [auth.ts:83](../../src/app/routes/auth.ts#L83)).
3. The second factor is rate-limited the same way (kv sliding window).

This composes cleanly with the existing PIN step-up: TOTP-at-login and
PIN-for-high-risk-actions are different gates for different moments and
don't interfere.

---

## §5 — How the per-user cordon constrains all of this

The reset flow is **structurally incapable of touching another user's
account**, and that's by design, not by a check we have to remember:

- **There is no `target_user_id` parameter anywhere in the reset flow.**
  You submit an email; a code goes to *that email's* on-file inbox;
  verifying the code unlocks *only that account*. You can only complete a
  reset for an account whose delivery channel you already control. So a
  reset *may only ever reset the requester's own account* — the same
  invariant the data cordon enforces for reads (see
  [data-separation.md](data-separation.md)).
- **Channel binding:** the confirm step must present the same email the
  request used, and the stored code is bound to that one `user_id`. A code
  minted for Sam cannot be redeemed against Jasper's account.
- **No owner override.** An admin can *still* reset another user the old
  way (the admin PATCH path) — that's a deliberate, role-gated, audited
  break-glass, not part of *self-service*. Self-service reset gives the
  owner **no** new reach into anyone else's account; it just lets each
  person recover their own login without bothering an admin.
- **Session eviction on reset** (§A.2 step 4) means a completed reset also
  protects the user — anyone holding a stale session to that account is
  logged out.

---

## §6 — Minimal infra to build

Two small modules, both mirroring `apns.ts`'s injectable-transport shape
so smokes run fully offline.

1. **`src/policy/mailer.ts`** — `send_mail({ to, subject, text, html })`,
   a typed `MailTransport`, a module-level transport with
   `_test_set_transport(fn)`, and a `mail_configured()` probe. Default
   transport per **D0.1** (Gmail SMTP via nodemailer-on-Bun, *or* a hosted
   provider's HTTP API via `fetch`). Env: `MAIL_FROM`, `SMTP_HOST`,
   `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (or `POSTMARK_TOKEN`).
2. **`src/core/otp.ts`** — owns code generation, `sha256` hashing, the
   `otp_codes` table, the request/verify rate limiters (reuse the kv
   sliding window), and `dispatch(channel, destination, code)` which fans
   to the mailer (and, later, an `sms.ts` Twilio transport — same shape,
   `fetch`-based; Bun's fetch is fine for Twilio, only APNs needed
   `node:http2`).
3. **Routes** — the four endpoints above, added to
   `create_auth_router` ([auth.ts:206](../../src/app/routes/auth.ts#L206)),
   reusing `_audit_auth` for every step. `/api/auth` is already on the
   middleware's public-prefix list, so the unauthenticated reset endpoints
   mount without fighting the auth gate.
4. **Schema** — `otp_codes` + `user_mfa`, both `CREATE … IF NOT EXISTS`,
   no version bump (additive, per the standard pattern).
5. **A `phone` field + `TwilioTransport`** — *only if* D0.2 says ship-now;
   otherwise this is the documented drop-in for later.

**Deferred / not in scope:** a residential SMTP relay, voice-call OTP,
WebAuthn/passkeys (a future stronger-than-TOTP option worth its own
proposal).

---

## §7 — Security checklist (what the implementation must satisfy)

- [ ] Reset request **never reveals whether an email exists** — identical
      200 body + flat timing in all branches.
- [ ] Codes **hashed at rest**; brute-force defense is the **rate limiter
      + expiry + single-use**, not the hash.
- [ ] **Two** throttles: per-email/per-IP on *request* (anti-enumeration,
      anti-inbox-flood) and per-code on *verify* (anti-brute-force), both
      restart-surviving like the PIN limiter.
- [ ] **Short expiry** (10 min), **one live code** per account, **atomic
      single-use** consume.
- [ ] Completed reset **revokes all sessions + devices** for the user.
- [ ] **Every step audited** (`auth_password_reset_requested` /
      `_completed`, `auth_mfa_*`) via `_audit_auth`; codes/secrets **never
      logged** (destination redacted to a hint).
- [ ] **Cordon:** no `target_user_id`; a reset can only ever land on the
      account whose channel received the code.
- [ ] **2FA:** TOTP ±1 step window; recovery codes single-use; half-session
      before the second factor; secrets in SQLite (encrypted), not YAML;
      second factor rate-limited.
- [ ] **Transport seam:** mailer/SMS injectable via `_test_set_transport`
      so a new smoke (`smoke:auth-reset`) runs without touching a real
      SMTP/SMS endpoint.

---

## §8 — Rollout

1. Jasper signs off on **§0** (transport, SMS-now-vs-later, 2FA scope).
2. Build `mailer.ts` + `otp.ts` + the `otp_codes` table + Flow A; add
   `smoke:auth-reset` (injected transport, full request→confirm→relogin
   cycle, the non-leak + rate-limit + single-use asserts).
3. Add the iOS/PWA "Forgot password?" UI against the two endpoints.
4. (If approved) `user_mfa` + Flow B (TOTP, then email-2FA fallback,
   recovery codes) + `smoke:auth-mfa`.
5. (If approved) `phone` field + `TwilioTransport` for SMS.
6. Docs: ship-log entry, `architecture.md` "auth" note, and a short
   user-facing "how to reset your password" page next to this one.
