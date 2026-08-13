/**
 * smoke:message-user — the specialist→user messaging path (message_user).
 *
 * Self-contained: temp db + real ConversationStore + real AppEventBus, a stub
 * UserRegistry (jasper=owner '*', kim=friend rostered to linda only), a fake
 * push deliver. Asserts: the cordon (Linda→Kim allowed, Kate→Kim refused with
 * a relay hint, Linda→owner allowed), name resolution ("Kim" → kim), unknown
 * recipient → candidates, and that an allowed send appends a specialist
 * message + emits message_added + pushes the recipient + audits. No network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { ConversationStore } from '../src/memory/stores/conversations';
import { AppEventBus } from '../src/app/events';
import { make_message_user } from '../src/tools/message_user';
import type { PushResult, PushSourceContext } from '../src/policy/push';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-msguser-'));
const db = open_db(join(dir, 'smoke.db'));
const conversations = new ConversationStore(db);
const events = new AppEventBus();

const USERS = [
  { id: 'jasper', display_name: 'Jasper', tier: 'owner', allowed_specialists: '*' },
  { id: 'kim', display_name: 'Kim', tier: 'friend', allowed_specialists: ['linda'] },
];
const users = {
  list: () => USERS,
  get: (id: string) => USERS.find((u) => u.id === id) ?? null,
  is_specialist_allowed: (user: { allowed_specialists: '*' | string[] }, sid: string) =>
    user.allowed_specialists === '*' || user.allowed_specialists.includes(sid),
} as unknown as Parameters<typeof make_message_user>[0]['users'];

const specialists = {
  get: (id: string) => (id === 'linda' ? { name: 'Linda' } : id === 'kate' ? { name: 'Kate' } : null),
} as unknown as Parameters<typeof make_message_user>[0]['specialists'];

const pushes: Array<{ user_id: string; text: string; ctx: PushSourceContext }> = [];
const deliver = async (user_id: string, text: string, ctx: PushSourceContext): Promise<PushResult> => {
  pushes.push({ user_id, text, ctx });
  return { delivered: true, via: 'apns' };
};

const seen_events: Array<{ type: string; role?: string; conversation_id?: string }> = [];
events.subscribe((e) => seen_events.push(e as never));

const audits: Array<Record<string, unknown>> = [];
// `turn_user` is the user whose turn/context this is — the context guard
// requires the recipient to BE this user. Pass the user the specialist is
// serving (or deliberating about).
function ctx_for(specialist_id: string, turn_user?: { id: string; tier: string }) {
  return {
    memory: { log_action: (r: Record<string, unknown>) => { audits.push(r); return 'audit_id'; } },
    intent_id: `i_${specialist_id}_${audits.length}`,
    specialist_id,
    now: new Date(),
    ...(turn_user ? { user: turn_user } : {}),
  } as never;
}
const LEE = { id: 'kim', tier: 'friend' };
const JASON = { id: 'jasper', tier: 'owner' };

const tool = make_message_user({ conversations, events, users, specialists, deliver });

async function main(): Promise<void> {
  const seed_user_msg = (user_id: string, specialist_id: string, text: string): void => {
    const { conversation } = conversations.resolve_for_user(user_id, specialist_id);
    conversations.append_message({ conversation_id: conversation.id, role: 'user', content_md: text });
  };

  // 0. CONTEXT GUARD — Linda in JASON's turn cannot message Kim. This is the
  //    seal on cross-user leakage: a specialist reading the owner's data in
  //    the owner's turn can't carry it into a message to a different user.
  const pushes_before_xctx = pushes.length;
  const xctx = (await tool.execute({ to_user: 'kim', message: 'From a Jasper-context turn.' }, ctx_for('linda', JASON))) as Record<string, unknown>;
  check('cross-context refused: Linda in Jasper’s turn cannot message Kim', xctx.ok === false && /conversation you.re in|isn.t .*'s|working with them/i.test(String(xctx.error)));
  check('cross-context sent NO push', pushes.length === pushes_before_xctx);

  // 1. Friend COLD outreach (in Kim's context, but no thread he started) →
  //    refused by the friend gate. Also proves "Kim" resolved.
  const cold = (await tool.execute({ to_user: 'Kim', message: 'Cold hello, no prior contact.' }, ctx_for('linda', LEE))) as Record<string, unknown>;
  check('friend cold outreach refused (no user-initiated thread)', cold.ok === false && /follow up|hasn.t messaged|cold/i.test(String(cold.error)));
  check('refusal is the friend gate, proving "Kim" resolved (not "no user")', !/no user/i.test(String(cold.error)));

  // 2. Friend FOLLOW-UP: Kim wrote first → Linda (in Kim's context) may reply.
  seed_user_msg('kim', 'linda', 'Here are the photos of the K70.');
  const r1 = (await tool.execute({ to_user: 'kim', message: 'Hi Kim — what switch color is it?' }, ctx_for('linda', LEE))) as Record<string, unknown>;
  check('Linda → Kim follow-up allowed (he messaged first)', r1.ok === true);
  check('Linda → Kim pushed to kim with her name', pushes.some((p) => p.user_id === 'kim' && p.text.startsWith('Linda: ')));
  check('Linda → Kim emitted message_added (specialist role)', seen_events.some((e) => e.type === 'message_added' && e.role === 'specialist'));
  check('Linda → Kim audited as message_user attributed to kim', audits.some((a) => a.tool_name === 'message_user' && a.user_id === 'kim'));

  // 3. Anti-nag: Kim hasn't replied → an immediate second message is refused.
  const pushes_before_nag = pushes.length;
  const nag = (await tool.execute({ to_user: 'kim', message: 'Also, the box?' }, ctx_for('linda', LEE))) as Record<string, unknown>;
  check('anti-nag: second message refused while awaiting reply', nag.ok === false && /haven.t replied|wait/i.test(String(nag.error)));
  check('anti-nag sent NO push', pushes.length === pushes_before_nag);

  // 4. After Kim replies, Linda may message again.
  seed_user_msg('kim', 'linda', 'Red switches.');
  const r3 = (await tool.execute({ to_user: 'kim', message: 'Perfect — listing coming up.' }, ctx_for('linda', LEE))) as Record<string, unknown>;
  check('after the user replies, the specialist may message again', r3.ok === true);

  // 5. Cordon (defense-in-depth) — even IN Kim's context, Kate (not on his
  //    roster) is refused. Belt-and-suspenders behind the context guard.
  const pushes_before_kate = pushes.length;
  const kate = (await tool.execute({ to_user: 'kim', message: 'Kate reaching Kim directly.' }, ctx_for('kate', LEE))) as Record<string, unknown>;
  check('Kate → Kim refused by the cordon (relay hint)', kate.ok === false && String(kate.error).includes('linda'));
  check('Kate → Kim sent NO push', pushes.length === pushes_before_kate);

  // 6. OWNER proactive (in Jasper's own context) with NO prior thread → allowed.
  const owner = (await tool.execute({ to_user: 'jasper', message: 'Proactive nudge for the owner.' }, ctx_for('linda', JASON))) as Record<string, unknown>;
  check('owner proactive allowed with no initiation (tier exemption)', owner.ok === true);

  // 6. Unknown recipient → candidates roster, no send.
  const unknown = (await tool.execute({ to_user: 'zed', message: 'Nobody by this name.' }, ctx_for('linda'))) as Record<string, unknown>;
  check('unknown recipient refused', unknown.ok === false);
  check('unknown recipient returns the roster as candidates', Array.isArray(unknown.candidates) && (unknown.candidates as string[]).some((c) => c.includes('kim')));

  // 7. No specialist context → refused.
  const no_spec = (await tool.execute({ to_user: 'kim', message: 'No specialist.' }, { memory: { log_action: () => 'x' }, intent_id: 'i', now: new Date() } as never)) as Record<string, unknown>;
  check('refused when not called from a specialist turn', no_spec.ok === false);

  rmSync(dir, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\nsmoke:message-user FAILED (${failures})`);
    process.exit(1);
  }
  console.log('\n✓ smoke:message-user — all checks passed');
}

void main();
