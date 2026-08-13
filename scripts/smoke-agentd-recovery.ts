/**
 * smoke:agentd-recovery — AvalancheClient hung-session recovery.
 *
 * Pure-function test of the client half of the agentd teardown trio, with an
 * injected fake fetch (no network, no box). Covers `forceTeardown` (DELETE
 * /sessions/{id} → true / 404 → false / 5xx → throw) and the
 * `reapAgentSessions` fallback: when the clean WebDriver DELETE fails (a
 * wedged geckodriver), it falls back to forceTeardown via agentd's session
 * route. The agentd-side periodic reaper (reapExpiredSessions + the ticker)
 * is parse-checked; it can't be unit-run without the box's child processes.
 */
import { AvalancheClient } from '../src/connectors/avalanche';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

interface Call {
  method: string;
  path: string;
}

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a client whose fetch is routed by a per-test handler that also
 *  records every (method, path) it sees. */
function clientWith(
  route: (method: string, path: string, calls: Call[]) => Response | Promise<Response>,
): { client: AvalancheClient; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname });
    return route(method, url.pathname, calls);
  }) as typeof fetch;
  const client = new AvalancheClient({
    host: '127.0.0.1',
    token: 'agentd-token',
    mac: 'AA:BB:CC:DD:EE:FF',
    fetchImpl,
  });
  return { client, calls };
}

async function main(): Promise<void> {
  // 1. forceTeardown 200 → true, and it hits agentd's session route.
  {
    const { client, calls } = clientWith((m, p) =>
      m === 'DELETE' && p === '/sessions/s1' ? json(200, { ok: true }) : json(500),
    );
    const ok = await client.forceTeardown('s1');
    check('forceTeardown 200 → true', ok === true);
    check('forceTeardown hits DELETE /sessions/{id}', calls.some((c) => c.method === 'DELETE' && c.path === '/sessions/s1'));
  }

  // 2. forceTeardown 404 → false (already gone).
  {
    const { client } = clientWith(() => json(404, { error: 'unknown_session' }));
    check('forceTeardown 404 → false', (await client.forceTeardown('gone')) === false);
  }

  // 3. forceTeardown 5xx → throws.
  {
    const { client } = clientWith(() => json(500));
    let threw = false;
    try {
      await client.forceTeardown('x');
    } catch {
      threw = true;
    }
    check('forceTeardown 5xx → throws', threw);
  }

  // 4. reapAgentSessions fallback: clean WebDriver DELETE fails → forceTeardown.
  {
    const { client, calls } = clientWith((m, p) => {
      if (m === 'GET' && p === '/status') {
        return json(200, { sessions: [{ session_id: 's1', gd_session_id: 'gd1', agent: 'cordelia' }] });
      }
      if (m === 'DELETE' && p === '/wd/session/gd1') return json(500); // wedged geckodriver
      if (m === 'DELETE' && p === '/sessions/s1') return json(200, { ok: true }); // force path
      return json(404);
    });
    const cleared = await client.reapAgentSessions('cordelia');
    check('reapAgentSessions falls back to forceTeardown', cleared === 1);
    check('clean WebDriver DELETE attempted first', calls.some((c) => c.path === '/wd/session/gd1'));
    check('force teardown attempted after', calls.some((c) => c.path === '/sessions/s1'));
  }

  // 5. both paths fail → cleared 0, no throw.
  {
    const { client } = clientWith((m, p) => {
      if (m === 'GET' && p === '/status') {
        return json(200, { sessions: [{ session_id: 's2', gd_session_id: 'gd2', agent: 'cordelia' }] });
      }
      return json(500); // both deleteSession and forceTeardown fail
    });
    check('both paths fail → cleared 0, no throw', (await client.reapAgentSessions('cordelia')) === 0);
  }

  // 6. clean path still works — forceTeardown NOT called when WebDriver DELETE succeeds.
  {
    const { client, calls } = clientWith((m, p) => {
      if (m === 'GET' && p === '/status') {
        return json(200, { sessions: [{ session_id: 's3', gd_session_id: 'gd3', agent: 'cordelia' }] });
      }
      if (m === 'DELETE' && p === '/wd/session/gd3') return json(200);
      return json(500);
    });
    const cleared = await client.reapAgentSessions('cordelia');
    check('clean reap clears the orphan', cleared === 1);
    check('no force teardown on a clean reap', !calls.some((c) => c.path.startsWith('/sessions/')));
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    console.log(failures === 0 ? '\nsmoke:agentd-recovery OK' : `\nsmoke:agentd-recovery FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
