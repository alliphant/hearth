/**
 * smoke:working-memory — the fused household situational block
 * (src/core/working_memory.ts) + its grounding-pack wiring.
 *
 * Self-contained: temp db + vault, no orchestrator, no LLM. Exercises:
 *   - the kill switch (HEARTH_WORKING_MEMORY unset → no blocks, ever)
 *   - section composition per store: mail (significant non-bulk only),
 *     people (life-event observations + birthdays), calendar (beyond the
 *     today/tomorrow near-window), goods (closing windows), proposals
 *   - the CORDON matrix: owner sees own mail + household signals, never
 *     Sam's mail / Sam's private items; Sam (household) sees her own
 *     mail + household signals, never Jasper's mail or system proposals;
 *     a friend-tier caller gets NO people section at all
 *   - caps ("…and N more" overflow lines)
 *   - per-section FAIL-OPEN: a throwing mail/observations store drops only
 *     that section
 *   - gather_grounding_packs integration: situational:true appends the
 *     block for a pack-less specialist; situational:false does not
 *
 *   bun run smoke:working-memory
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { ProposalsStore } from '@core/proposals';
import { MailStore, type MailMessageInput } from '@memory/stores/mail';
import { PersonObservations } from '@memory/stores/person_observations';
import { enrich_order_to_good } from '@core/household_knowledge/enrich';
import {
  compose_working_memory,
  render_working_memory_block,
  working_memory_blocks,
} from '@core/working_memory';
import { gather_grounding_packs } from '@core/grounding_packs';
import { local_iso_date } from '@core/time';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const TZ = 'America/Denver';

function mail_input(over: Partial<MailMessageInput>): MailMessageInput {
  return {
    direction: 'inbound',
    account_id: 'acct_jasper',
    user_id: 'jasper',
    private_to: 'jasper',
    uid: Math.floor(Math.random() * 1_000_000),
    message_id: null,
    in_reply_to: null,
    references: [],
    thread_key: `t_${Math.random().toString(36).slice(2, 10)}`,
    from_addr: 'friend@example.com',
    from_name: 'A Friend',
    to: ['jasper@example.com'],
    subject: 'hello',
    date_utc: new Date(Date.now() - 86_400_000).toISOString(),
    snippet: 'snippet',
    body_text: 'body',
    auth_spf: 'pass',
    auth_dkim: 'pass',
    auth_dmarc: 'pass',
    is_bulk: false,
    aligned: true,
    triage_category: 'authentic_personal',
    triage_importance: 0.8,
    triage_reasons: [],
    triage_bucket: 'needs_you',
    is_reply_to_me: false,
    summary: 'A friend wrote you.',
    suggested_action: 'reply',
    list_unsubscribe: null,
    ...over,
  };
}

async function main(): Promise<void> {
  delete process.env.HEARTH_WORKING_MEMORY;
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-working-memory-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const now = new Date();

  // ── Seed: mail ────────────────────────────────────────────────────────
  const mail = new MailStore(db);
  mail.upsert(mail_input({ subject: 'Dinner Friday?', summary: 'Marcus asks about dinner Friday.', from_name: 'Marcus' }));
  mail.upsert(mail_input({ subject: 'MEGA SALE', triage_category: 'promotional', is_bulk: true, triage_bucket: 'junk', uid: 2 }));
  mail.upsert(
    mail_input({
      account_id: 'acct_sara',
      user_id: 'sam',
      private_to: 'sam',
      subject: 'Yoga schedule',
      summary: 'Sam studio reply.',
      uid: 3,
    }),
  );

  // ── Seed: person observations + a birthday ────────────────────────────
  const obs = new PersonObservations(db);
  obs.record({
    person_id: 'p_lee001',
    user_id: 'jasper',
    kind: 'life_event',
    summary: '**Kim** — traveling to Bali next month.',
    source_type: 'imessage',
    private_to: 'household',
    observed_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
  });
  obs.record({
    person_id: 'p_kim001',
    user_id: 'sam',
    kind: 'life_event',
    summary: '**Kim** — new job at the clinic.',
    source_type: 'imessage',
    private_to: 'sam',
    observed_at: new Date(now.getTime() - 86_400_000).toISOString(),
  });
  const bday = local_iso_date(new Date(now.getTime() + 10 * 86_400_000), TZ).slice(5); // MM-DD, +10d
  memory.upsert_note(
    'People/Marcus Webb.md',
    { type: 'person', id: 'p_marcus', name: 'Marcus Webb', relationship: 'friend', birthday: bday, private_to: 'household' },
    '# Marcus Webb',
  );

  // ── Seed: life events (today → excluded; +5d → included; sam-private) ─
  const today_iso = new Date(now.getTime() + 2 * 3_600_000).toISOString();
  const plus5 = new Date(now.getTime() + 5 * 86_400_000).toISOString();
  memory.upsert_note(
    'Household/Calendar/le_today1.md',
    { type: 'life_event', id: 'le_today1', title: 'Standup today', event_date: today_iso, source: 'calendar', private_to: 'household' },
    '# Standup today',
  );
  memory.upsert_note(
    'Household/Calendar/le_trip01.md',
    { type: 'life_event', id: 'le_trip01', title: 'Blu trip', category: 'vacation', event_date: plus5, actionable: true, owner: 'jasper', source: 'calendar', private_to: 'household' },
    '# Blu trip',
  );
  memory.upsert_note(
    'Household/Calendar/le_sara01.md',
    { type: 'life_event', id: 'le_sara01', title: 'Sam private appt', event_date: plus5, source: 'calendar', private_to: 'sam' },
    '# Sam private appt',
  );

  // ── Seed: a household good with a closing return window ───────────────
  const e = enrich_order_to_good(
    {
      order_key: 'sony:wm1',
      merchant: 'Sony',
      items: 'soundbar speaker',
      order_total: '$200.00',
      order_date: new Date(now.getTime() - 26 * 86_400_000).toISOString(),
      status: 'delivered',
      // A soundbar is a durable object — required for a return window to be
      // derived at all (a consumable/service has none to close). See
      // enrich.ts `is_returnable`.
      fulfillment: 'durable_goods',
    },
    { buyer_display_name: 'Jasper', private_to: 'household', now },
  );
  memory.upsert_note(e.note_path, e.frontmatter as Record<string, unknown>, e.body);

  await rebuild(vault, memory, db);

  // ── Seed: proposals (system-null + sam-cordoned) ──────────────────────
  const proposals = new ProposalsStore(db);
  proposals.create({
    specialist_id: 'kate',
    kind: 'action_proposal',
    execution_kind: 'none',
    payload: { description: 'File the soundbar warranty' },
    rationale: 'File the Sony warranty paperwork before it lapses.',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'goods_followup', anchor: 'sony:wm1' },
    user_id: null,
  });
  proposals.create({
    specialist_id: 'kate',
    kind: 'action_proposal',
    execution_kind: 'none',
    payload: { description: 'Confirm yoga renewal' },
    rationale: 'Confirm the yoga studio renewal.',
    signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'personal', anchor: 'yoga' },
    user_id: 'sam',
  });

  const deps = { memory, db };

  // ── 1. Kill switch ─────────────────────────────────────────────────────
  check('kill switch: no blocks when HEARTH_WORKING_MEMORY unset',
    working_memory_blocks(deps, { user_id: 'jasper', tier: 'owner', now, timezone: TZ }).length === 0);
  process.env.HEARTH_WORKING_MEMORY = '1';

  // ── 2. Owner composition ───────────────────────────────────────────────
  const jasper = compose_working_memory(deps, { user_id: 'jasper', tier: 'owner', now, timezone: TZ });
  const jb = render_working_memory_block(jasper);
  check('owner: mail section carries his significant mail', jb.includes('Dinner Friday?'));
  check('owner: promotional/bulk mail excluded', !jb.includes('MEGA SALE'));
  check("owner: Sam's mail NEVER visible (no god-view)", !jb.includes('Yoga schedule'));
  check('owner: household life-event observation present', jb.includes('Bali'));
  check("owner: Sam's private observation excluded", !jb.includes('Kim'));
  check('owner: birthday within window present', jb.includes("Marcus Webb's birthday"));
  check('owner: +5d life event present', jb.includes('Blu trip'));
  check('owner: today event excluded (calendar pack owns the near window)', !jb.includes('Standup today'));
  check("owner: Sam's private life event excluded", !jb.includes('Sam private appt'));
  check('owner: goods follow-up present', jasper.counts.goods >= 1 && jb.includes('Purchases'));
  check('owner: system proposal visible', jb.includes('Sony warranty paperwork'));
  check("owner: Sam's proposal NOT visible", !jb.includes('yoga studio renewal'));

  // ── 3. Household member composition ────────────────────────────────────
  const sam = compose_working_memory(deps, { user_id: 'sam', tier: 'household', now, timezone: TZ });
  const sb = render_working_memory_block(sam);
  check("member: her own mail present", sb.includes('Yoga schedule'));
  check("member: Jasper's mail excluded", !sb.includes('Dinner Friday?'));
  check('member: household observation visible', sb.includes('Bali'));
  check('member: her private observation visible to her', sb.includes('Kim'));
  check('member: her private life event visible', sb.includes('Sam private appt'));
  check('member: system (user_id NULL) proposal not in her queue', !sb.includes('Sony warranty paperwork'));
  check('member: her own proposal present', sb.includes('yoga studio renewal'));

  // ── 4. Friend tier ─────────────────────────────────────────────────────
  const kim = compose_working_memory(deps, { user_id: 'kim', tier: 'friend', now, timezone: TZ });
  const lb = render_working_memory_block(kim);
  check('friend: no people section at all', !lb.includes("What's live") && !lb.includes('birthday'));
  check('friend: no household life events', !lb.includes('Blu trip'));
  check('friend: no household goods', !lb.includes('Purchases'));

  // ── 5. Caps ────────────────────────────────────────────────────────────
  for (let i = 0; i < 8; i++) {
    mail.upsert(mail_input({ subject: `Overflow ${i}`, uid: 100 + i, thread_key: `of_${i}` }));
  }
  const capped = compose_working_memory(deps, { user_id: 'jasper', tier: 'owner', now, timezone: TZ });
  const cap_block = capped.sections.find((s) => s.startsWith('**Mail needing you')) ?? '';
  const cap_lines = cap_block.split('\n').filter((l) => l.startsWith('- ')).length;
  check('caps: mail section holds 5 lines + overflow', cap_lines === 6 && cap_block.includes('more in the digest'));

  // ── 6. Per-section fail-open ───────────────────────────────────────────
  const broken = compose_working_memory(
    {
      memory,
      db,
      mail: { recent_inbound: () => { throw new Error('mail store down'); } },
      observations: { recent_life_events: () => { throw new Error('obs store down'); } },
    },
    { user_id: 'jasper', tier: 'owner', now, timezone: TZ },
  );
  const bb = render_working_memory_block(broken);
  check('fail-open: mail section dropped, composer did not throw', broken.counts.mail === 0 && !bb.includes('Dinner Friday?'));
  check('fail-open: calendar + goods + proposals sections survive',
    bb.includes('Blu trip') && bb.includes('Purchases') && bb.includes('Sony warranty paperwork'));

  // ── 7. Grounding-pack integration ──────────────────────────────────────
  const pack_ctx = {
    message: 'what needs my attention?',
    memory,
    user_id: 'jasper',
    now,
    timezone: TZ,
    tier: 'owner' as const,
  };
  const with_flag = await gather_grounding_packs('luna', { ...pack_ctx, situational: true });
  check('grounding packs: situational:true appends the fused block for a pack-less specialist',
    with_flag.some((b) => b.includes('Household pulse')));
  const without_flag = await gather_grounding_packs('luna', { ...pack_ctx, situational: false });
  check('grounding packs: situational:false appends nothing', without_flag.length === 0);
  delete process.env.HEARTH_WORKING_MEMORY;
  const env_off = await gather_grounding_packs('luna', { ...pack_ctx, situational: true });
  check('grounding packs: env kill switch wins over the YAML flag', env_off.length === 0);

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\nsmoke:working-memory — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
