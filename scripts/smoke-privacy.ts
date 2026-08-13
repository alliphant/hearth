export {};
/**
 * smoke:privacy — the per-user data cordon's NEW surfaces (2026-06-04):
 * the proposals user_id split, and the owner-oversight review_user_activity
 * tool. The visibility/stamp matrix is covered by smoke:multiuser; this
 * focuses on Commit 4 (proposals) + Commit 5a (oversight).
 *
 * Self-contained: temp SQLite + a fixture users.yaml. No live orchestrator,
 * no real LLM (the oversight tool fails soft to a tally summary when the
 * summarizer is absent, which is exactly what we exercise).
 *
 *   bun run smoke:privacy
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ProposalsStore } from '@core/proposals';
import { ConversationStore, SpecialistInbox, InterruptStore } from '@memory/stores/conversations';
import { UserRegistry } from '@core/users';
import { create as create_review_tool } from '@specialists/kate/tools/review_user_activity';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolContext } from '@core/tool';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

interface ReviewOut {
  ok: boolean;
  target_user_id: string;
  window_since: string | null;
  summary: string | null;
  counts: { audit_actions: number; captures: number; conversations: number } | null;
  error?: string;
  candidates?: Array<{ user_id: string; display_name: string; tier: string }>;
}

const SIG = (specialist_id: string, kind: string) => ({
  specialist_id,
  kind,
  category: 'test',
});

async function main() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-privacy-'));
  const vault = resolve(root, 'vault');
  let pass = 0;
  try {
    const db = open_db(resolve(root, 'hearth.db'));
    const memory = new MemoryClient({ vault_root: vault, db });
    const proposals = new ProposalsStore(db);
    const conversations = new ConversationStore(db);

    const users_yaml = resolve(root, 'users.yaml');
    writeFileSync(
      users_yaml,
      [
        'users:',
        '  - id: "jasper"',
        '    display_name: "Jasper"',
        '    allowed_specialists: "*"',
        '    timezone: "America/Denver"',
        '    notification_config_ref: "default_user"',
        '    tier: "owner"',
        '    role: "admin"',
        '  - id: "sam"',
        '    display_name: "Sam"',
        '    allowed_specialists: ["kate"]',
        '    timezone: "America/Denver"',
        '    notification_config_ref: "default_user"',
        '    tier: "household"',
        '  - id: "kim"',
        '    display_name: "Kim"',
        '    allowed_specialists: ["kate"]',
        '    timezone: "America/Denver"',
        '    notification_config_ref: "default_user"',
        '    tier: "friend"',
        '',
      ].join('\n'),
      'utf8',
    );
    const users = new UserRegistry(users_yaml, resolve(root, 'notifications.yaml'));

    // ─── 1. create() forces system kinds to NULL, cordons action kinds ───
    console.log('→ proposals.create scopes user_id by kind');
    const sara_draft = proposals.create({
      specialist_id: 'kate',
      kind: 'draft_message',
      user_id: 'sam',
      execution_kind: 'manual',
      payload: { recipient_id: 'friend', draft: 'hi' },
      rationale: "Sam's draft",
      signature: SIG('kate', 'draft_message'),
    });
    const jasper_action = proposals.create({
      specialist_id: 'kate',
      kind: 'action_proposal',
      user_id: 'jasper',
      execution_kind: 'none',
      payload: { note: "Jasper's action" },
      rationale: "Jasper's action",
      signature: SIG('kate', 'action_proposal'),
    });
    // A system kind passed a user_id is FORCED to NULL (owner-global).
    // `skip_kate_review` opts out of the Kate pre-review gate (2026-06-15):
    // a trainer-authored recommendation/persona_tuning/binding_proposal is
    // otherwise born `pending_kate_review` (hidden from the owner's default
    // queue until Kate promotes it). That status lifecycle is orthogonal to
    // the user_id cordon this smoke verifies, so we file it `pending` to keep
    // the cordon assertions (owner-sees / non-owner-doesn't) meaningful.
    const sys_rec = proposals.create({
      specialist_id: 'trainer',
      kind: 'recommendation',
      user_id: 'sam', // should be ignored
      execution_kind: 'none',
      payload: { note: 'tune a tool' },
      rationale: 'system improvement',
      signature: SIG('trainer', 'recommendation'),
      skip_kate_review: true,
    });
    const lee_book = proposals.create({
      specialist_id: 'cordelia',
      kind: 'book_candidate',
      user_id: 'kim',
      execution_kind: 'composite',
      payload: { queue_note_path: 'x', title_candidate: 'A Book' },
      rationale: "Kim's book",
      signature: SIG('cordelia', 'book_candidate'),
    });

    assert(proposals.get(sara_draft)!.user_id === 'sam', 'action proposal keeps user_id=sam');
    assert(proposals.get(jasper_action)!.user_id === 'jasper', "owner action proposal user_id=jasper");
    assert(proposals.get(sys_rec)!.user_id === null, 'system recommendation forced to user_id NULL');
    assert(proposals.get(lee_book)!.user_id === 'kim', 'friend book candidate user_id=kim');
    pass++;

    // ─── 2. list(visible_to) cordons the queue per caller ─────────────────
    console.log('→ proposals.list cordons by caller tier + id');
    const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

    // Owner: sees system (NULL) + own (jasper); NOT sam's, NOT kim's.
    const owner_view = ids(proposals.list({ visible_to: { user_id: 'jasper', tier: 'owner' } }));
    assert(owner_view.has(sys_rec), 'owner sees system recommendation');
    assert(owner_view.has(jasper_action), 'owner sees own action proposal');
    assert(!owner_view.has(sara_draft), "owner does NOT see Sam's draft");
    assert(!owner_view.has(lee_book), "owner does NOT see Kim's book candidate");

    // Household (Sam): sees ONLY her own; NOT system, NOT owner's, NOT kim's.
    const sara_view = ids(proposals.list({ visible_to: { user_id: 'sam', tier: 'household' } }));
    assert(sara_view.has(sara_draft), 'Sam sees her own draft');
    assert(!sara_view.has(sys_rec), 'Sam does NOT see system/self-improvement proposals');
    assert(!sara_view.has(jasper_action), "Sam does NOT see Jasper's action proposal");
    assert(!sara_view.has(lee_book), "Sam does NOT see Kim's proposals");

    // Friend (Kim): sees ONLY his own.
    const lee_view = ids(proposals.list({ visible_to: { user_id: 'kim', tier: 'friend' } }));
    assert(lee_view.has(lee_book), 'Kim sees his own book candidate');
    assert(lee_view.size === 1, 'Kim sees ONLY his own (1 proposal)');

    // No visible_to → unfiltered (internal/diagnostic).
    const all_view = proposals.list({});
    assert(all_view.length >= 4, 'unfiltered list returns everything (internal caller)');
    pass++;

    // ─── 3. owner-oversight tool — refusal + recovery + audited allow ─────
    console.log('→ review_user_activity: owner-only, audited, recovery hint');
    const tool = create_review_tool({ db, conversations, users } as unknown as ToolDeps);

    const base_ctx = (user: { id: string; tier: 'owner' | 'household' | 'friend' }): ToolContext => ({
      memory,
      // llm.for_role throws → tool fails soft to a tally summary (tested path).
      llm: { for_role: () => { throw new Error('no llm in smoke'); } } as unknown as ToolContext['llm'],
      now: new Date('2026-06-04T12:00:00Z'),
      intent_id: 'oversight-test',
      specialist_id: 'kate',
      user,
    });

    // Non-owner caller is refused, no data.
    const refused = (await tool.execute(
      { target_user_id: 'kim' },
      base_ctx({ id: 'sam', tier: 'household' }),
    )) as ReviewOut;
    assert(refused.ok === false, 'non-owner caller refused');
    assert(refused.summary === null && refused.counts === null, 'refusal returns no data');
    assert((refused.error ?? '').toLowerCase().includes('owner-only'), 'refusal explains owner-only');

    // Owner, unknown target → candidates (recovery hint), not a guess.
    const unknown_target = (await tool.execute(
      { target_user_id: 'nobody' },
      base_ctx({ id: 'jasper', tier: 'owner' }),
    )) as ReviewOut;
    assert(unknown_target.ok === false, 'unknown target → not ok');
    assert(Array.isArray(unknown_target.candidates) && unknown_target.candidates.length >= 2, 'unknown target returns candidate users');
    assert(
      unknown_target.candidates!.every((c) => c.tier !== 'owner'),
      'candidates are non-owner users only',
    );

    // Owner reviewing Kim → ok, counts present, audit row written.
    const reviewed = (await tool.execute(
      { target_user_id: 'kim' },
      base_ctx({ id: 'jasper', tier: 'owner' }),
    )) as ReviewOut;
    assert(reviewed.ok === true, 'owner review of a friend succeeds');
    assert(reviewed.counts !== null, 'review returns activity counts');
    assert(typeof reviewed.summary === 'string' && reviewed.summary!.length > 0, 'review returns a summary (fail-soft tally)');
    const audit_row = db
      .prepare(`SELECT user_id, tool_input FROM audit_log WHERE tool_name = 'owner_oversight_review' ORDER BY id DESC LIMIT 1`)
      .get() as { user_id: string | null; tool_input: string } | undefined;
    assert(audit_row !== undefined, 'owner_oversight_review audit row written');
    assert(audit_row!.user_id === 'jasper', 'oversight audit attributes the reviewer (jasper)');
    assert(JSON.parse(audit_row!.tool_input).target_user_id === 'kim', 'oversight audit records the target (kim)');
    pass++;

    // ─── 4. inbox-flag / interrupt cordon (2026-06-05) ───────────────────
    console.log('→ inbox flags cordon by originating_user_id');
    const inbox = new SpecialistInbox(db);
    const interrupts = new InterruptStore(db);

    // Three flags to Kate: Sam's personal, a household/system-shared (NULL),
    // and Jasper's own.
    inbox.push({ from_specialist_id: 'anya', to_specialist_id: 'kate', kind: 'flag', body_md: "Sam's pet refill low", originating_user_id: 'sam' });
    inbox.push({ from_specialist_id: 'cordelia', to_specialist_id: 'kate', kind: 'fyi', body_md: 'Shared car service due', originating_user_id: null });
    inbox.push({ from_specialist_id: 'vivian', to_specialist_id: 'kate', kind: 'flag', body_md: "Jasper's bill", originating_user_id: 'jasper' });

    const bodies = (rows: { body_md: string }[]) => new Set(rows.map((r) => r.body_md));

    // Jasper's brief read: his own + shared, NOT Sam's.
    const jasper_inbox = bodies(inbox.unactioned_for('kate', 50, 'jasper'));
    assert(jasper_inbox.has("Jasper's bill"), "Jasper sees his own flag");
    assert(jasper_inbox.has('Shared car service due'), 'Jasper sees the household/system-shared flag (NULL)');
    assert(!jasper_inbox.has("Sam's pet refill low"), "Jasper does NOT see Sam's personal flag — the leak is closed");

    // Sam's brief read: her own + shared, NOT Jasper's.
    const sara_inbox = bodies(inbox.unactioned_for('kate', 50, 'sam'));
    assert(sara_inbox.has("Sam's pet refill low"), 'Sam sees her own flag');
    assert(sara_inbox.has('Shared car service due'), 'Sam sees the shared flag');
    assert(!sara_inbox.has("Jasper's bill"), "Sam does NOT see Jasper's flag");

    // Unfiltered (domain-coordination / internal) read sees all three.
    assert(inbox.unactioned_for('kate', 50).length === 3, 'unfiltered read sees every flag');

    // Interrupts persist originating_user_id.
    const intr = interrupts.create({ originating_specialist_id: 'cordelia', severity: 'medium', summary: 'Kim triage', routed_to: 'kate', originating_user_id: 'kim' });
    assert(intr.originating_user_id === 'kim', 'interrupt persists originating_user_id');
    pass++;

    // ─── 5. specialist-profile recent-work rail cordons inbox by originating user ───
    // The profile "recent activity" rail reads specialist_inboxes directly;
    // WITHOUT the cordon it leaked a friend's routed-capture flags into the
    // OWNER's view — the reported "I see Kim's uploads routed in Vivian's
    // inbox" bug. This replicates the route's cordoned query and asserts the
    // owner can't see a friend's flag on a specialist's profile.
    console.log('→ specialist-profile recent-work rail cordons inbox flags');
    inbox.push({ from_specialist_id: 'cordelia', to_specialist_id: 'vivian', kind: 'flag', body_md: 'Cordelia routed 4 ski captures (Kim)', originating_user_id: 'kim' });
    inbox.push({ from_specialist_id: 'cordelia', to_specialist_id: 'vivian', kind: 'fyi', body_md: 'Shared finance note', originating_user_id: null });
    inbox.push({ from_specialist_id: 'vivian', to_specialist_id: 'cordelia', kind: 'flag', body_md: "Jasper's receipt", originating_user_id: 'jasper' });

    const rail = (viewer: { id: string; tier: 'owner' | 'household' | 'friend' } | null): Set<string> => {
      const cordon = viewer
        ? viewer.tier === 'owner'
          ? 'AND (originating_user_id IS NULL OR originating_user_id = @uid)'
          : 'AND originating_user_id = @uid'
        : 'AND originating_user_id IS NULL';
      const rows = db
        .prepare(
          `SELECT body_md FROM specialist_inboxes
            WHERE (to_specialist_id = @sid OR from_specialist_id = @sid) ${cordon}
            ORDER BY ts DESC LIMIT 20`,
        )
        .all({ '@sid': 'vivian', ...(viewer ? { '@uid': viewer.id } : {}) }) as { body_md: string }[];
      return new Set(rows.map((r) => r.body_md));
    };

    const owner_rail = rail({ id: 'jasper', tier: 'owner' });
    assert(!owner_rail.has('Cordelia routed 4 ski captures (Kim)'), "owner does NOT see Kim's routed-capture flag on Vivian's profile — leak closed");
    assert(owner_rail.has("Jasper's receipt"), 'owner sees their own flag on the rail');
    assert(owner_rail.has('Shared finance note'), 'owner sees shared (NULL) traffic on the rail');
    const lee_rail = rail({ id: 'kim', tier: 'friend' });
    assert(lee_rail.has('Cordelia routed 4 ski captures (Kim)'), 'Kim sees his own routed-capture flag');
    assert(!lee_rail.has("Jasper's receipt") && !lee_rail.has('Shared finance note'), 'friend rail shows only their own');
    // No-viewer (unauthenticated) is fail-CLOSED: only shared (NULL) traffic.
    const anon_rail = rail(null);
    assert(anon_rail.has('Shared finance note') && !anon_rail.has('Cordelia routed 4 ski captures (Kim)') && !anon_rail.has("Jasper's receipt"), 'no-viewer rail is fail-closed (shared only)');
    pass++;

    console.log(`\n✓ ${pass} checks passed. smoke:privacy done.`);
  } catch (err) {
    console.error(`\n✗ smoke:privacy FAILED after ${pass} passing check(s):`);
    console.error(err);
    process.exitCode = 1;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
