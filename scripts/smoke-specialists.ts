export {}; // ensure module scope (avoids clash with other script globals)
/**
 * Smoke test for the specialist runtime.
 *
 * Requires the orchestrator to be running with HEARTH_TEST_MODE=1, so the
 * LLM is short-circuited with canned responses. (See SpecialistRuntime.canned_turn.)
 * Run via `bun run smoke:specialists` after starting the server with:
 *
 *   HEARTH_TEST_MODE=1 HEARTH_DISABLE_LOOPS=1 bun run dev
 *
 * Or set those env vars in your .env if you keep the server up for testing.
 */

const ORCH_URL = process.env.HEARTH_URL ?? 'http://localhost:7700';

interface Specialist {
  id: string;
  name: string;
  role: string;
  default_landing: boolean;
}

interface ConvCreateResp {
  id: string;
  specialist_id: string;
  ts_created: string;
}

interface SendMessageResp {
  message: { id: string; content_md: string };
  tool_calls_made: Array<{ name: string }>;
  proposals_created: string[];
  consulted_specialists: string[];
}

interface ProposalRow {
  id: string;
  specialist_id: string;
  status: string;
  category_signature_hash: string | null;
}

async function fetch_json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ORCH_URL}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch {
    throw new Error(`Non-JSON response from ${path} (${res.status}): ${text.slice(0, 200)}`);
  }
}

async function main() {
  console.log('→ GET /api/specialists');
  const list = await fetch_json<{ specialists: Specialist[] }>('/api/specialists');
  if (list.status !== 200) throw new Error(`/api/specialists failed: ${list.status}`);
  // The team grows (Mariah, Beatrice, Cordelia, …); assert a floor plus
  // the specialists this smoke actually exercises, not a rigid count.
  if (list.body.specialists.length < 7) {
    throw new Error(`expected at least 7 specialists, got ${list.body.specialists.length}`);
  }
  for (const id of ['kate', 'eleanor']) {
    if (!list.body.specialists.some((s) => s.id === id)) {
      throw new Error(`expected specialist "${id}" in the list`);
    }
  }
  const kate = list.body.specialists.find((s) => s.id === 'kate');
  if (!kate) throw new Error('Kate not found in specialists list');
  if (!kate.default_landing) throw new Error('Kate is not default_landing');
  console.log(`  ✓ ${list.body.specialists.length} specialists, Kate is default_landing`);

  console.log('\n→ POST /api/conversations (specialist_id=kate)');
  const cv = await fetch_json<ConvCreateResp>('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ specialist_id: 'kate' }),
  });
  if (cv.status !== 200) throw new Error(`/api/conversations failed: ${cv.status}`);
  const conv_id = cv.body.id;
  console.log(`  ✓ conversation ${conv_id}`);

  // Message 1: weather/garden → expect Eleanor consult.
  console.log('\n→ POST /api/conversations/<id>/messages — weather for garden');
  const m1 = await fetch_json<SendMessageResp>(
    `/api/conversations/${conv_id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: "What's the weather context for the garden today?",
      }),
    },
  );
  if (m1.status !== 200) {
    throw new Error(`message failed: ${m1.status} ${JSON.stringify(m1.body)}`);
  }
  const reply1 = m1.body.message.content_md.toLowerCase();
  if (!reply1.includes('eleanor') && !reply1.includes('master gardener')) {
    throw new Error(
      `Kate's reply did not mention Eleanor: ${m1.body.message.content_md.slice(0, 300)}`,
    );
  }
  console.log(
    `  ✓ Kate mentioned Eleanor (consulted: ${m1.body.consulted_specialists.join(', ') || '(none, mentioned only)'})`,
  );

  // Message 2: "Note that I watered" → expect proposal + Eleanor consult.
  console.log('\n→ POST /api/conversations/<id>/messages — watered the front yard');
  const m2 = await fetch_json<SendMessageResp>(
    `/api/conversations/${conv_id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Note that I watered the front yard today.',
      }),
    },
  );
  if (m2.status !== 200) {
    throw new Error(`message failed: ${m2.status} ${JSON.stringify(m2.body)}`);
  }
  if (m2.body.proposals_created.length === 0) {
    throw new Error('expected at least one proposal from the watered-yard message');
  }
  if (!m2.body.consulted_specialists.includes('eleanor')) {
    throw new Error(`expected Eleanor to be consulted; got: ${m2.body.consulted_specialists.join(', ')}`);
  }
  const proposal_id = m2.body.proposals_created[0]!;
  console.log(`  ✓ proposal ${proposal_id} created; Eleanor consulted via inbox`);

  // List proposals.
  console.log('\n→ GET /api/proposals?status=pending');
  const props = await fetch_json<{ proposals: ProposalRow[] }>(
    '/api/proposals?status=pending',
  );
  if (props.status !== 200) throw new Error(`proposals list failed: ${props.status}`);
  const our = props.body.proposals.find((p) => p.id === proposal_id);
  if (!our) throw new Error('our proposal not in pending list');
  console.log(`  ✓ pending list contains our proposal`);

  // Decide approve.
  console.log('\n→ POST /api/proposals/<id>/decide — approve');
  const dec = await fetch_json<{ status: string; autonomy_status: string }>(
    `/api/proposals/${proposal_id}/decide`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve' }),
    },
  );
  if (dec.status !== 200 || dec.body.status !== 'approved') {
    throw new Error(`decide failed: ${dec.status} ${JSON.stringify(dec.body)}`);
  }
  console.log(`  ✓ approved (autonomy_status=${dec.body.autonomy_status})`);

  // Search.
  console.log('\n→ GET /api/search?q=watered');
  const search = await fetch_json<{
    messages?: Array<{ snippet: string }>;
  }>('/api/search?q=watered&scope=messages');
  if (search.status !== 200) throw new Error(`search failed: ${search.status}`);
  const found = (search.body.messages ?? []).some((m) =>
    m.snippet.toLowerCase().includes('watered'),
  );
  if (!found) {
    throw new Error(
      `expected a message hit for "watered"; got: ${JSON.stringify(search.body)}`,
    );
  }
  console.log(`  ✓ search found the watered message`);

  // Capability enforcement: Eleanor doesn't have send_email; ask her to send.
  console.log('\n→ Capability check: Eleanor sending an email');
  const cv2 = await fetch_json<ConvCreateResp>('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ specialist_id: 'eleanor' }),
  });
  const m3 = await fetch_json<SendMessageResp>(
    `/api/conversations/${cv2.body.id}/messages`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Please send a message to the neighbor about the fence.',
      }),
    },
  );
  if (m3.status !== 200) throw new Error(`Eleanor message failed: ${m3.status}`);
  const reply3 = m3.body.message.content_md.toLowerCase();
  if (!reply3.includes("can't") && !reply3.includes('cannot') && !reply3.includes('outside')) {
    throw new Error(
      `Eleanor should have declined the send-message request; got: ${m3.body.message.content_md.slice(0, 300)}`,
    );
  }
  console.log(`  ✓ Eleanor declined (capability gating works)`);

  console.log('\n✓ SPECIALISTS SMOKE PASSED');
}

main().catch((err: unknown) => {
  console.error(
    `\n✗ SPECIALISTS SMOKE FAILED:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
