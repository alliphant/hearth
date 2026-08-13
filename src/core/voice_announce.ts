/**
 * Voice-followup delivery — speak it on the Satellite1 if the user is present,
 * else push.
 *
 * The deliver-followup route (src/app/routes/specialists.ts) calls this when a
 * promised followup that was made on the VOICE surface concludes. Per the owner
 * decision (2026-06-15) the behavior is "present now, else push": the voice
 * coordinator (integrations/voice-coordinator) owns the presence decision — it
 * holds the LD2450 latch — so we POST the shaped reply to its /speak route and
 * let it answer spoken|away. On `away`, on any coordinator error, or when no
 * coordinator is configured, we fall back to a push.
 *
 * This is never load-bearing: the reply is already appended to the conversation
 * thread regardless, so this only decides HOW the user finds out. Fail-open to
 * push at every error path.
 */

export interface SpeakFollowupResult {
  spoken: boolean;
  pushed: boolean;
  reason: string;
}

export interface SpeakFollowupOpts {
  /** Already markdown-stripped, speakable reply text. */
  text: string;
  conversation_id: string;
  /** One-line summary of what was promised — context for the push + audit. */
  summary: string;
  /** Coordinator base URL (HEARTH_VOICE_COORDINATOR_URL). Unset ⇒ straight to push. */
  coordinator_url?: string;
  /** Bearer for the coordinator's /speak route (HEARTH_INTERNAL_BEARER). */
  bearer?: string;
  timeout_ms?: number;
  /** Optional pre-speech alert tone the coordinator plays AHEAD of the words —
   *  `'critical'` (EAS attention tone) or `'notice'` (soft chime). Used by the
   *  dangerous-weather announcer; omitted for ordinary followups. */
  pre_tone?: 'critical' | 'notice';
  /** Injected for tests; defaults to global fetch. */
  fetch_impl?: typeof fetch;
  /**
   * Push fallback. Resolves true when a push was delivered/queued. Injected so
   * tests never touch the APNs module; the route wires it to `push_text`.
   */
  push: (text: string) => Promise<boolean>;
}

export async function try_speak_followup(opts: SpeakFollowupOpts): Promise<SpeakFollowupResult> {
  const { text, conversation_id, summary, coordinator_url, bearer } = opts;
  const f = opts.fetch_impl ?? fetch;
  const timeout_ms = opts.timeout_ms ?? 8000;

  const fall_back_to_push = async (reason: string): Promise<SpeakFollowupResult> => {
    const pushed = await opts.push(text).catch(() => false);
    return { spoken: false, pushed, reason };
  };

  if (!coordinator_url) return fall_back_to_push('no_coordinator');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout_ms);
  try {
    const res = await f(`${coordinator_url.replace(/\/$/, '')}/speak`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ text, conversation_id, summary, ...(opts.pre_tone ? { pre_tone: opts.pre_tone } : {}) }),
      signal: ctrl.signal,
    });
    if (!res.ok) return fall_back_to_push(`coordinator_http_${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { spoken?: boolean; reason?: string };
    if (body.spoken === true) {
      return { spoken: true, pushed: false, reason: body.reason ?? 'spoken' };
    }
    // present:false (away) or any non-spoken verdict → push
    return fall_back_to_push(body.reason ?? 'away');
  } catch (e) {
    return fall_back_to_push(`coordinator_error:${(e as Error).name}`);
  } finally {
    clearTimeout(timer);
  }
}
