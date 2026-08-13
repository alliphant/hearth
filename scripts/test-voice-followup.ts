/**
 * smoke:voice-followup — the speak-or-push delivery for a promised followup
 * made on the voice surface (src/core/voice_announce.ts).
 *
 * Contract under test ("present now, else push", 2026-06-15): POST the shaped
 * reply to the coordinator's /speak; if it answers spoken:true the user heard
 * it (no push); on away / any coordinator error / no coordinator configured,
 * fall back to a push. Never throws — fail-open to push at every error path.
 * Pure: fetch + push are injected, no live orchestrator, no coordinator.
 */
import { try_speak_followup } from '../src/core/voice_announce';

let checks = 0;
let fails = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) fails++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
}

/** A fetch stub that returns a fixed status + JSON body, recording the call. */
function fetch_returning(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A push stub recording the text it was asked to send. */
function push_stub(result: boolean) {
  const sent: string[] = [];
  return {
    fn: async (t: string) => {
      sent.push(t);
      return result;
    },
    sent,
  };
}

async function main(): Promise<void> {
  // 1. present → coordinator speaks → spoken:true, NO push, correct route + bearer
  {
    const f = fetch_returning(200, { spoken: true, reason: 'present' });
    const p = push_stub(true);
    const r = await try_speak_followup({
      text: 'Back on your last-frost question — May 15th.',
      conversation_id: 'conv_x',
      summary: 'last frost',
      coordinator_url: 'http://coord.test:8094/',
      bearer: 'tok',
      fetch_impl: f.impl,
      push: p.fn,
    });
    check('present → spoken:true', r.spoken === true);
    check('present → no push', r.pushed === false && p.sent.length === 0);
    check('POSTs /speak (trailing slash trimmed)', f.calls[0]?.url === 'http://coord.test:8094/speak');
    check('sends bearer', (f.calls[0]?.init.headers as Record<string, string>)?.authorization === 'Bearer tok');
    const sent_body = JSON.parse(String(f.calls[0]?.init.body));
    check('body carries text + conversation_id', sent_body.text.includes('May 15th') && sent_body.conversation_id === 'conv_x');
  }

  // 2. away → spoken:false → push fires with the shaped text
  {
    const f = fetch_returning(200, { spoken: false, reason: 'away' });
    const p = push_stub(true);
    const r = await try_speak_followup({
      text: 'Your package ships Tuesday.',
      conversation_id: 'c2',
      summary: 'package',
      coordinator_url: 'http://coord.test:8094',
      bearer: 'tok',
      fetch_impl: f.impl,
      push: p.fn,
    });
    check('away → spoken:false', r.spoken === false);
    check('away → pushed:true', r.pushed === true);
    check('away → push got the reply text', p.sent[0] === 'Your package ships Tuesday.');
    check('away → reason away', r.reason === 'away');
  }

  // 3. coordinator HTTP 500 → push fallback
  {
    const f = fetch_returning(500, { error: 'boom' });
    const p = push_stub(true);
    const r = await try_speak_followup({
      text: 'hi',
      conversation_id: 'c3',
      summary: 's',
      coordinator_url: 'http://coord.test:8094',
      fetch_impl: f.impl,
      push: p.fn,
    });
    check('500 → not spoken', r.spoken === false);
    check('500 → pushed', r.pushed === true && p.sent.length === 1);
    check('500 → reason coordinator_http_500', r.reason === 'coordinator_http_500');
  }

  // 4. coordinator unreachable (fetch throws) → push fallback, never throws
  {
    const throwing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const p = push_stub(true);
    const r = await try_speak_followup({
      text: 'hi',
      conversation_id: 'c4',
      summary: 's',
      coordinator_url: 'http://coord.test:8094',
      fetch_impl: throwing,
      push: p.fn,
    });
    check('unreachable → not spoken', r.spoken === false);
    check('unreachable → pushed', r.pushed === true);
    check('unreachable → reason coordinator_error:*', r.reason.startsWith('coordinator_error'));
  }

  // 5. no coordinator configured → straight to push, no fetch
  {
    let fetched = false;
    const impl = (async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const p = push_stub(true);
    const r = await try_speak_followup({
      text: 'hi',
      conversation_id: 'c5',
      summary: 's',
      coordinator_url: undefined,
      fetch_impl: impl,
      push: p.fn,
    });
    check('no coordinator → not spoken', r.spoken === false);
    check('no coordinator → pushed', r.pushed === true);
    check('no coordinator → never hit the network', fetched === false);
    check('no coordinator → reason no_coordinator', r.reason === 'no_coordinator');
  }

  // 6. push itself failing must not throw (pushed:false, still resolves)
  {
    const f = fetch_returning(200, { spoken: false, reason: 'away' });
    const p = {
      fn: async () => {
        throw new Error('apns down');
      },
    };
    const r = await try_speak_followup({
      text: 'hi',
      conversation_id: 'c6',
      summary: 's',
      coordinator_url: 'http://coord.test:8094',
      fetch_impl: f.impl,
      push: p.fn as (t: string) => Promise<boolean>,
    });
    check('push throw → pushed:false, no throw', r.spoken === false && r.pushed === false);
  }

  console.log('─'.repeat(50));
  if (fails) {
    console.log(`  ${fails}/${checks} FAILED`);
    process.exit(1);
  }
  console.log(`  ✓ smoke:voice-followup PASSED (${checks} checks)`);
}

void main();
