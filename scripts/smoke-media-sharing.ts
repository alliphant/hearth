/**
 * smoke:media-sharing — per-item media sharing (2026-07-29).
 *
 * Self-contained: temp vault + db + archive dir + a fixture users.yaml, the
 * real create_media_router mounted in-process behind a fake auth middleware.
 * No orchestrator, no network.
 *
 * Proves the contract end to end:
 *   - the read model: `sharing` on item detail is server-owned (can_share,
 *     shared_with resolved to display names, the filtered target list, and ALL
 *     the user-facing copy) and the POST returns the SAME object, bare
 *   - a REVOCATION is authoritative in the list reads with no reprojection in
 *     between, while a fresh GRANT is still allowed to lag there
 *   - a revoked user is in the SSE delivery audience, and the audience never
 *     reaches the wire
 *   - a friend-tier caller is not handed the household roster
 *   - owner shares to a household member → the member can now see + stream
 *     the item, and `nas_path` never moved (same folder for both of them)
 *   - the RAG chunk gate follows (the member's inference-search finds it)
 *   - the grantee's `search_library` → `read_note` round-trip COMPLETES: ONE
 *     rule (cordon OR named grant) applied by both tools, so a shared item is
 *     never discoverable-but-unreadable by the person it was shared with; a
 *     non-grantee still gets a not-found, with no existence oracle
 *   - `{"user_ids": []}` unshares and the member loses visibility again
 *   - the REPAIR-SWEEP interaction: `rescan_media_metadata` facet:'nsfw' writes
 *     a cordon-only `private_to` patch, which must neither DROP a live grant nor
 *     RESURRECT a revoked one — including on the household → requester
 *     tightening branch, where tier visibility becomes grant-only visibility
 *   - a caller cannot share an item that is not theirs (403)
 *   - the OWNER cannot share a member's item — no god-view (404-shape)
 *   - a user_id outside the server's own `targets` set is rejected (400)
 *   - friend-tier users are eligible targets, and a friend's OWN item stays
 *     siloed from the owner
 *   - a server with no roster omits `sharing` entirely and 503s the verb
 *
 *   bun run smoke:media-sharing
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { index_chunks } from '@app/routes/library';
import { create_media_router } from '@app/routes/media';
import { AppEventBus, media_shared_reaches, sse_wire_payload, type AppEvent } from '@app/events';
import { media_cordon_for, tighten_media_cordon } from '@core/media/cordon';
import { search_library } from '@connectors/search_library';
import { read_note } from '@connectors/read_library_note';
import type { ToolContext } from '@core/tool';
import { UserRegistry, type UserConfig } from '@core/users';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

type TestUser = { id: string; tier: 'owner' | 'household' | 'friend' } | null;

/** A three-tier roster: owner (jasper), household (sam), friend (kim). */
const USERS_YAML = [
  'users:',
  '  - id: "jasper"',
  '    display_name: "Jasper"',
  '    telegram_user_id: null',
  '    telegram_chat_id: null',
  '    app_token: null',
  '    allowed_specialists: "*"',
  '    timezone: "America/Denver"',
  '    notification_config_ref: "default_user"',
  '    role: "admin"',
  '    tier: "owner"',
  '  - id: "sam"',
  '    display_name: "Sam"',
  '    telegram_user_id: null',
  '    telegram_chat_id: null',
  '    app_token: null',
  '    allowed_specialists: "*"',
  '    timezone: "America/Denver"',
  '    notification_config_ref: "default_user"',
  '    role: "user"',
  '    tier: "household"',
  '  - id: "kim"',
  '    display_name: "Kim Halapeno"',
  '    telegram_user_id: null',
  '    telegram_chat_id: null',
  '    app_token: null',
  '    allowed_specialists: [ "linda" ]',
  '    timezone: "America/Denver"',
  '    notification_config_ref: "default_user"',
  '    role: "user"',
  '    tier: "friend"',
  '',
].join('\n');

interface SharedWithEntry {
  user_id: string;
  name: string;
  tier: string | null;
  shared_at: string | null;
}
interface Sharing {
  can_share: boolean;
  shared_with?: SharedWithEntry[];
  targets?: { user_id: string; name: string; tier: string }[];
  /** Server-owned copy: picker footer / empty-pool line / current-state line. */
  hint?: string;
  empty_hint?: string;
  state_label?: string | null;
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-mediashare-'));
  const vault = join(tmp, 'vault');
  const archive_root = join(tmp, 'archive');
  mkdirSync(vault, { recursive: true });
  mkdirSync(archive_root, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });

  const users_path = join(tmp, 'users.yaml');
  writeFileSync(users_path, USERS_YAML, 'utf-8');
  const users = new UserRegistry(users_path, join(tmp, 'notifications.yaml'));
  check('fixture roster loads (3 users)', users.list().length === 3);

  function write_media_file(nas_path: string, size: number): void {
    const abs = resolve(archive_root, nas_path);
    mkdirSync(dirname(abs), { recursive: true });
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = i % 251;
    writeFileSync(abs, buf);
  }

  function write_media_note(
    id: string,
    name: string,
    opts: { nas_path: string; private_to: string; nsfw?: boolean; body?: string },
  ): string {
    const fm: Record<string, unknown> = {
      type: 'media_item',
      id,
      name,
      media_kind: 'clip',
      source_site: 'youtube',
      source_url: `https://x/${id}`,
      creator: 'Tester',
      nsfw: opts.nsfw ?? false,
      duration_s: 120,
      container: 'mp4',
      archived_at: '2026-07-29T00:00:00Z',
      nas_path: opts.nas_path,
      private_to: opts.private_to,
      tags: [],
    };
    const body = opts.body ?? `## Summary\nA test ${name}.\n\n## Description\n${name} synthwave archive clip.`;
    const path = `MediaArchive/2026-07-29-${id}.md`;
    memory.upsert_note(path, fm, body);
    index_chunks(db, path, body);
    write_media_file(opts.nas_path, 600);
    return path;
  }

  // jasper's own clip (the shareable one), a household clip (nobody's to share),
  // sam's own clip (the no-god-view case), and kim's own clip (friend silo).
  const jasper_note = write_media_note('mi_ownclip', 'Owner Clip', {
    nas_path: 'Video/YouTube/Test/mi_ownclip.mp4',
    private_to: 'jasper',
    body: '## Summary\nOwner Clip.\n\n## Description\nsynthwave owner-only night drive.',
  });
  const hh_note = write_media_note('mi_hhclip', 'Household Clip', {
    nas_path: 'Video/YouTube/Test/mi_hhclip.mp4',
    private_to: 'household',
  });
  write_media_note('mi_saraclip', 'Sam Clip', {
    nas_path: 'Video/Sam/mi_saraclip.mp4',
    private_to: 'sam',
  });
  write_media_note('mi_leeclip', 'Kim Clip', {
    nas_path: 'Video/Kim/mi_leeclip.mp4',
    private_to: 'kim',
  });

  await rebuild(vault, memory, db);

  // ── mount the real router behind a fake auth middleware ──────────────────
  let user: TestUser = { id: 'jasper', tier: 'owner' };
  const seen: AppEvent[] = [];
  const events = new AppEventBus();
  events.subscribe((e) => seen.push(e));
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('user', user as unknown as UserConfig);
    await next();
  });
  app.route('/api/media', create_media_router({ db, memory, archive_root, users, events }));
  const req = (path: string, init?: RequestInit) => app.request(path, init);
  const item = async (id: string) => (await (await req(`/api/media/item/${id}`)).json()) as Record<string, unknown> & { sharing?: Sharing };
  const share = (id: string, user_ids: unknown) =>
    req(`/api/media/item/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_ids }),
    });
  const nas_path_of = (note_path: string) =>
    memory.read_note(note_path)?.frontmatter?.nas_path as string | undefined;

  // ── 1. the read model ────────────────────────────────────────────────────
  user = { id: 'jasper', tier: 'owner' };
  const own = await item('mi_ownclip');
  const s0 = own.sharing as Sharing;
  check('item detail carries a `sharing` object', !!s0);
  check('owner can share their own item', s0.can_share === true);
  check('nothing shared yet', Array.isArray(s0.shared_with) && s0.shared_with.length === 0);
  check('the hint copy is server-owned', typeof s0.hint === 'string' && s0.hint.length > 0);
  check('the empty-pool copy is server-owned too', typeof s0.empty_hint === 'string' && s0.empty_hint.length > 0);
  check('state_label is null while nothing is shared (no client-invented chip)', s0.state_label === null);
  const target_ids = (s0.targets ?? []).map((t) => t.user_id);
  check('targets exclude the caller (= the owning user)', !target_ids.includes('jasper'));
  check('targets include the household member', target_ids.includes('sam'));
  check('targets include the friend-tier user (named grants are not tier widening)', target_ids.includes('kim'));
  check('targets carry server-resolved display names', (s0.targets ?? []).some((t) => t.name === 'Sam'));
  check('targets carry the tier for the client label', (s0.targets ?? []).some((t) => t.user_id === 'kim' && t.tier === 'friend'));

  // A household item is nobody's to share; a member's item the owner can't
  // even see. Both must render NO share affordance.
  const hh = await item('mi_hhclip');
  check('a household item is not shareable', (hh.sharing as Sharing).can_share === false);
  check('a not-shareable item leaks no roster', (hh.sharing as Sharing).targets === undefined);
  check('a not-shareable item leaks no share set', (hh.sharing as Sharing).shared_with === undefined);

  // ── 2. no god-view: the owner cannot see OR share a member's item ─────────
  check('owner gets 404 on the member’s item (pure cordon)', (await req('/api/media/item/mi_saraclip')).status === 404);
  check('owner cannot share the member’s item (404-shape, never 403)', (await share('mi_saraclip', ['kim'])).status === 404);
  check('owner gets 404 on the friend’s item (friend silo intact)', (await req('/api/media/item/mi_leeclip')).status === 404);

  // ── 3. bad requests are rejected against the SERVER's target set ──────────
  check('an unknown user_id is rejected', (await share('mi_ownclip', ['nobody'])).status === 400);
  check('sharing to yourself is rejected (not a target)', (await share('mi_ownclip', ['jasper'])).status === 400);
  check('a non-array user_ids is rejected', (await share('mi_ownclip', 'sam')).status === 400);
  // A set-replacement verb must never silently drop a malformed id — dropping
  // it would UNSHARE rather than error.
  check('a non-string entry is rejected, not dropped', (await share('mi_ownclip', [123])).status === 400);
  check('a blank entry is rejected, not dropped', (await share('mi_ownclip', ['  '])).status === 400);
  const missing_body = await req('/api/media/item/mi_ownclip/share', { method: 'POST' });
  check('a missing body is rejected', missing_body.status === 400);
  check('a rejected share wrote nothing', (memory.read_note(jasper_note)?.frontmatter?.shared_with ?? null) === null);

  // ── 4. owner shares to the household member ──────────────────────────────
  const nas_before = nas_path_of(jasper_note);
  const res = await share('mi_ownclip', ['sam']);
  check('share returns 200', res.status === 200);
  // The response IS the `sharing` object — bare, contract-literal, NOT wrapped
  // in an `{ok, sharing}` envelope. One decoder serves the read and the write.
  const body = (await res.json()) as Sharing & { ok?: unknown; sharing?: unknown };
  check('the POST response is the BARE sharing object', body.can_share === true && body.sharing === undefined);
  check('the POST response carries no envelope flag', body.ok === undefined);
  const s1 = body as Sharing;
  check('share echoes the same `sharing` object shape', s1.can_share === true && Array.isArray(s1.shared_with) && Array.isArray(s1.targets) && typeof s1.hint === 'string');
  check('shared_with names the member', (s1.shared_with ?? []).map((e) => e.user_id).join() === 'sam');
  check('state_label is server-composed once shared', s1.state_label === 'Shared with Sam');
  check('shared_with is resolved to a display name', (s1.shared_with ?? [])[0]?.name === 'Sam');
  check('shared_with carries the tier', (s1.shared_with ?? [])[0]?.tier === 'household');
  check('shared_with carries a shared_at stamp', typeof (s1.shared_with ?? [])[0]?.shared_at === 'string');
  check('targets still include the already-shared member (toggle list, not add-only)', (s1.targets ?? []).some((t) => t.user_id === 'sam'));
  check('the read model agrees with the write response', JSON.stringify(((await item('mi_ownclip')).sharing)) === JSON.stringify(s1));
  check('the grant landed in the note frontmatter', JSON.stringify(memory.read_note(jasper_note)?.frontmatter?.shared_with) === '["sam"]');
  check('nas_path did NOT move (same folder for both of them)', nas_path_of(jasper_note) === nas_before);
  const shared_evt = seen.find((e) => e.type === 'media_shared');
  check('a media_shared event fired', !!shared_evt);
  check('the event carries the full new set + the sharer', shared_evt?.type === 'media_shared' && shared_evt.shared_with.join() === 'sam' && shared_evt.by === 'jasper');
  check('the event reaches the new recipient', shared_evt?.type === 'media_shared' && media_shared_reaches(shared_evt, 'sam'));
  check('the event does NOT reach an untouched third user', shared_evt?.type === 'media_shared' && !media_shared_reaches(shared_evt, 'kim'));
  check('the event is fail-closed for an unidentified subscriber', shared_evt?.type === 'media_shared' && !media_shared_reaches(shared_evt, undefined));

  // ── 5. the member can now SEE + STREAM it, at the same path ──────────────
  // No reprojection has happened yet — the single-item reads consult the LIVE
  // note precisely so a share works the instant it is saved.
  user = { id: 'sam', tier: 'household' };
  const member_view = await req('/api/media/item/mi_ownclip');
  check('the member can now read the shared item (200)', member_view.status === 200);
  const member_item = (await member_view.json()) as { sharing?: Sharing; stream_url?: string };
  check('the recipient sees no share affordance (not theirs to share)', (member_item.sharing as Sharing).can_share === false);
  const member_stream = await req('/api/media/stream/mi_ownclip', { headers: { Range: 'bytes=0-9' } });
  check('the member can range-stream the shared item (206)', member_stream.status === 206);
  const member_bytes = new Uint8Array(await member_stream.arrayBuffer());
  user = { id: 'jasper', tier: 'owner' };
  const owner_stream = await req('/api/media/stream/mi_ownclip', { headers: { Range: 'bytes=0-9' } });
  const owner_bytes = new Uint8Array(await owner_stream.arrayBuffer());
  check('both users stream the identical bytes from the identical file', member_bytes.join() === owner_bytes.join());
  user = { id: 'sam', tier: 'household' };
  check('the member still cannot share it (403 — visible, not theirs)', (await share('mi_ownclip', [])).status === 403);

  // ── 6. the RAG chunk gate follows the grant ──────────────────────────────
  const member_search = (await (await req('/api/media/search?q=synthwave')).json()) as { results: { id: string }[] };
  check('the member’s inference-search now surfaces the shared item', member_search.results.some((r) => r.id === 'mi_ownclip'));

  // ── 6b. search_library → read_note completes for the GRANTEE ─────────────
  // The rule has to be ONE rule, applied by every read path, or this pair
  // loops. Kate's knowledge_scope is `'**'` and media notes are chunk-indexed,
  // so a grantee's search legitimately returns a chunk from an item shared with
  // them; `read_note` then consulted only `private_to` and answered "note not
  // found… Try search_library" — pointing straight back at the tool that
  // produced the path. Fail-closed, so nothing leaked, but an item that is
  // discoverable-but-unreadable by the one person it was shared with is not
  // shared. Driven through the REAL tools, not a re-implementation of them.
  const tool_ctx = (u: NonNullable<TestUser>) =>
    ({ memory, user: { id: u.id, tier: u.tier } } as unknown as ToolContext);
  const sara_ctx = tool_ctx({ id: 'sam', tier: 'household' });
  const grantee_hits = await search_library.execute({ query: 'synthwave', k: 5 }, sara_ctx);
  check(
    'the grantee’s search_library returns the shared item’s note_path',
    grantee_hits.hits.some((h) => h.note_path === jasper_note),
  );
  const grantee_read = await read_note.execute({ note_path: jasper_note }, sara_ctx);
  check(
    '…and read_note on that very path succeeds — no search→read loop',
    grantee_read.note_path === jasper_note && grantee_read.body.includes('synthwave'),
  );

  // The same pair for a user with NO grant must stay closed on BOTH halves —
  // and read_note must fail as "not found", never as a distinguishable
  // "forbidden" (an existence oracle is its own leak).
  const lee_ctx = tool_ctx({ id: 'kim', tier: 'friend' });
  let denied = '';
  try {
    await read_note.execute({ note_path: jasper_note }, lee_ctx);
  } catch (err) {
    denied = err instanceof Error ? err.message : String(err);
  }
  check('a NON-grantee still cannot read_note the item', denied.includes('note not found'));
  check('…and the refusal is a not-found, not an existence oracle', !/forbid|denied|private|cordon/i.test(denied));
  const lee_hits = await search_library.execute({ query: 'synthwave', k: 5 }, lee_ctx);
  check(
    '…and never saw its chunk either (the chunk gate agrees with the tool)',
    !lee_hits.hits.some((h) => h.note_path === jasper_note),
  );

  // ── 6c. the ONE rule at the seam the NON-media read paths share ──────────
  // `/api/search`'s vault branch, the specialist office's vault search and
  // Cordelia's Knowledge Desk resolve visibility through these two MemoryClient
  // methods instead of spelling the rule a third time. Each used to pass only
  // `private_to`; pinned here so a future caller can't be written against a
  // cordon-only contract and re-open the search→read loop somewhere new.
  const path_visible = (u: NonNullable<TestUser>) =>
    memory.note_path_visible_to_caller(jasper_note, { user_id: u.id, tier: u.tier });
  check('note_path_visible_to_caller honours the named grant, from the LIVE note', path_visible({ id: 'sam', tier: 'household' }));
  check('…and still refuses a non-grantee', !path_visible({ id: 'kim', tier: 'friend' }));
  check('…and refuses a user-less system caller (a grant never matches one)', !memory.note_path_visible_to_caller(jasper_note, { user_id: undefined, tier: 'household' }));
  check('…and an unreadable path fails CLOSED, not open', !memory.note_path_visible_to_caller('MediaArchive/nope.md', { user_id: 'sam', tier: 'household' }));

  // ── 7. the list reads converge on the next reprojection ──────────────────
  await rebuild(vault, memory, db);
  const member_browse = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('the member’s browse lists the shared item once reprojected', member_browse.items.some((i) => i.id === 'mi_ownclip'));
  check('the member’s browse still hides the owner’s other items', !member_browse.items.some((i) => i.id === 'mi_saraclip'));

  // The projected-row flavour of the same rule (candidate-then-confirm), now
  // that the projection names the grantee. Cordelia's Knowledge Desk reads
  // `clippings` rows through this exact method.
  const projected_row = db
    .prepare('SELECT note_path, private_to, frontmatter_json FROM media_items WHERE id = @id')
    .get({ '@id': 'mi_ownclip' }) as { note_path: string; private_to: string | null; frontmatter_json: string };
  check('note_row_visible_to_caller confirms a projected grant against the live note', memory.note_row_visible_to_caller(projected_row, { user_id: 'sam', tier: 'household' }));
  check('…and refuses a row whose projection names nobody like this caller', !memory.note_row_visible_to_caller(projected_row, { user_id: 'kim', tier: 'friend' }));

  // ── 8. friend-tier grant works too ───────────────────────────────────────
  user = { id: 'jasper', tier: 'owner' };
  check('sharing to a friend returns 200', (await share('mi_ownclip', ['sam', 'kim'])).status === 200);
  user = { id: 'kim', tier: 'friend' };
  check('the friend can read the item they were named on', (await req('/api/media/item/mi_ownclip')).status === 200);
  check('the friend can stream it', (await req('/api/media/stream/mi_ownclip', { headers: { Range: 'bytes=0-9' } })).status === 206);
  check('the friend still cannot see an un-shared item', (await req('/api/media/item/mi_hhclip')).status === 404);
  // The documented asymmetry, asserted so it can't drift: a NEW grant reaches
  // the LIST reads only once the projection names the recipient (the ingestor's
  // next reproject), because a candidate set that doesn't name you has nothing
  // to confirm. The single-item reads above already work — that is the point.
  const lag_browse = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('a fresh grant still LAGS in browse until the next reproject (grants may lag)', !lag_browse.items.some((i) => i.id === 'mi_ownclip'));

  // The earlier stamp must survive a set rewrite that keeps the same member.
  user = { id: 'jasper', tier: 'owner' };
  const after_add = (await item('mi_ownclip')).sharing as Sharing;
  const sara_stamp = (after_add.shared_with ?? []).find((e) => e.user_id === 'sam')?.shared_at;
  check('shared_at survives a set rewrite for a member who stayed', sara_stamp === (s1.shared_with ?? [])[0]?.shared_at);

  // ── 9. empty user_ids unshares completely ────────────────────────────────
  const unshared = await share('mi_ownclip', []);
  check('unshare returns 200', unshared.status === 200);
  const s2 = (await unshared.json()) as Sharing;
  check('the share set is empty', (s2.shared_with ?? []).length === 0);
  check('state_label is null again after a full unshare', s2.state_label === null);
  check('the frontmatter records the empty set', JSON.stringify(memory.read_note(jasper_note)?.frontmatter?.shared_with) === '[]');

  // ── the REVOKED user must be told. Delivery is gated on prior ∪ new, not on
  // the new set — otherwise the one subscriber who has to refetch is the one
  // who never hears about it.
  const revoke_evt = seen.filter((e) => e.type === 'media_shared').at(-1);
  check('the revoke emitted a media_shared event', revoke_evt?.type === 'media_shared');
  check('its payload is still the (now empty) new set', revoke_evt?.type === 'media_shared' && revoke_evt.shared_with.length === 0);
  check('it is delivered to the REVOKED member', revoke_evt?.type === 'media_shared' && media_shared_reaches(revoke_evt, 'sam'));
  check('it is delivered to the REVOKED friend', revoke_evt?.type === 'media_shared' && media_shared_reaches(revoke_evt, 'kim'));
  check('it is delivered to the sharer', revoke_evt?.type === 'media_shared' && media_shared_reaches(revoke_evt, 'jasper'));
  // The audience names revoked users, so it must never reach a subscriber: the
  // wire payload stays exactly the three published fields.
  const wire = sse_wire_payload(revoke_evt as AppEvent) as Record<string, unknown>;
  check('the delivery audience is stripped from the wire payload', wire.deliver_to === undefined);
  check('the wire payload is exactly the published shape', JSON.stringify(Object.keys(wire).sort()) === JSON.stringify(['by', 'media_item_id', 'shared_with', 'type']));
  user = { id: 'sam', tier: 'household' };
  check('the member loses the item again (404-shape)', (await req('/api/media/item/mi_ownclip')).status === 404);
  check('the member loses the stream again', (await req('/api/media/stream/mi_ownclip')).status === 404);
  const search_after = (await (await req('/api/media/search?q=synthwave')).json()) as { results: { id: string }[] };
  check('the member’s search drops it again (chunk gate re-closed)', !search_after.results.some((r) => r.id === 'mi_ownclip'));
  // REVOCATION IS AUTHORITATIVE — the LIST reads must drop it too, with NO
  // reprojection in between. This is the check whose absence let the leak
  // through: item/stream/search all read the live note, browse/recent read the
  // projection, and the share verb never touches the projection.
  const stale_row = db
    .prepare('SELECT frontmatter_json FROM media_items WHERE id = @id')
    .get({ '@id': 'mi_ownclip' }) as { frontmatter_json: string } | undefined;
  const stale_claim = JSON.parse(stale_row?.frontmatter_json ?? '{}') as { shared_with?: unknown };
  // Precondition, not decoration: if the projection had already caught up, the
  // two checks below would pass without proving anything about the read path.
  check(
    'precondition: the projection still CLAIMS the now-revoked grant',
    Array.isArray(stale_claim.shared_with) && stale_claim.shared_with.includes('sam'),
  );
  const revoked_browse = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('the member’s BROWSE drops the revoked item immediately (no reproject needed)', !revoked_browse.items.some((i) => i.id === 'mi_ownclip'));
  const revoked_recent = (await (await req('/api/media/recent?limit=60')).json()) as { items: { id: string }[] };
  check('the member’s RECENT drops the revoked item immediately too', !revoked_recent.items.some((i) => i.id === 'mi_ownclip'));
  user = { id: 'kim', tier: 'friend' };
  check('the friend loses it too', (await req('/api/media/item/mi_ownclip')).status === 404);
  const revoked_friend_browse = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('the friend’s browse drops it immediately as well', !revoked_friend_browse.items.some((i) => i.id === 'mi_ownclip'));

  // ── 10. the repair sweep × sharing — a cordon patch must neither DROP a
  // live grant nor RESURRECT a revoked one ─────────────────────────────────
  // `rescan_media_metadata` facet:'nsfw' re-files an item's cordon by writing
  // `upsert_note(note_path, { private_to: next }, '')` — a patch that never
  // mentions `shared_with`. The grant survives that write for exactly one
  // reason: `upsert_note` shallow-MERGES over the note's existing frontmatter
  // (`{ ...parsed.data, ...frontmatter }`). Nothing else asserted it, so
  // widening the facet to a full-frontmatter rewrite — or changing that merge —
  // would silently unshare every shared item, and the obvious "re-attach the
  // grant" fix for that would resurrect a revoked one. Both directions are
  // pinned here, against the REAL cordon helpers the facet calls.
  const grant_of = (note_path: string) =>
    JSON.stringify(memory.read_note(note_path)?.frontmatter?.shared_with);

  check('media_cordon_for silos an archived item to its requester', media_cordon_for('jasper') === 'jasper');
  check('tighten_media_cordon re-files a household item onto its requester', tighten_media_cordon('household', 'jasper') === 'jasper');
  check('tighten_media_cordon leaves an already-narrow cordon alone', tighten_media_cordon('jasper', 'jasper') === 'jasper');

  // ── 10a. an ON-POLICY item (the common sweep case: cordon already narrow,
  // a verdict lands) — both patch shapes the facet writes ───────────────────
  user = { id: 'jasper', tier: 'owner' };
  check('re-granted for the repair case', (await share('mi_ownclip', ['sam'])).status === 200);
  const repaired_cordon = tighten_media_cordon(
    memory.read_note(jasper_note)?.frontmatter?.private_to as string | undefined,
    'jasper',
  );
  // The cordon-only patch (no frames scored) …
  memory.upsert_note(jasper_note, { private_to: repaired_cordon }, '');
  check('a private_to-only repair PRESERVES the grant (no silent unshare)', grant_of(jasper_note) === '["sam"]');
  // … and the shape it writes when a verdict DID land.
  memory.upsert_note(jasper_note, { private_to: repaired_cordon, nsfw: false, nsfw_score: 0.012 }, '');
  check('the cordon+verdict patch shape preserves it too', grant_of(jasper_note) === '["sam"]');
  check('the repair left the on-policy cordon where it was', memory.read_note(jasper_note)?.frontmatter?.private_to === 'jasper');
  const repaired_sharing = (await item('mi_ownclip')).sharing as Sharing;
  check('the read model still reports the grant after the repair', (repaired_sharing.shared_with ?? []).map((e) => e.user_id).join() === 'sam');
  check('the shared_at stamp survived the repair write', typeof (repaired_sharing.shared_with ?? [])[0]?.shared_at === 'string');
  user = { id: 'sam', tier: 'household' };
  check('the grantee still reads the repaired item', (await req('/api/media/item/mi_ownclip')).status === 200);
  check('the grantee still streams the repaired item', (await req('/api/media/stream/mi_ownclip', { headers: { Range: 'bytes=0-9' } })).status === 206);

  // ── 10b. …and a repair that runs AFTER a revoke must not undo the revoke ──
  user = { id: 'jasper', tier: 'owner' };
  check('revoke before the second repair returns 200', (await share('mi_ownclip', [])).status === 200);
  memory.upsert_note(jasper_note, { private_to: repaired_cordon }, '');
  check('a repair AFTER a revoke does not resurrect the grant', grant_of(jasper_note) === '[]');
  user = { id: 'sam', tier: 'household' };
  check('the revoked member stays out of the item read after the repair', (await req('/api/media/item/mi_ownclip')).status === 404);
  check('the revoked member stays out of the stream after the repair', (await req('/api/media/stream/mi_ownclip')).status === 404);
  // Nothing has reprojected since §7, so the projection still CLAIMS the grant:
  // this is the LIST read confirming against the live note on a REPAIRED row.
  const repair_stale = JSON.parse(
    (db
      .prepare('SELECT frontmatter_json FROM media_items WHERE id = @id')
      .get({ '@id': 'mi_ownclip' }) as { frontmatter_json: string }).frontmatter_json,
  ) as { shared_with?: unknown };
  check(
    'precondition: the projection still claims the revoked grant',
    Array.isArray(repair_stale.shared_with) && repair_stale.shared_with.includes('sam'),
  );
  const repair_browse = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('the revoked member stays out of BROWSE after the repair (no reproject)', !repair_browse.items.some((i) => i.id === 'mi_ownclip'));

  // ── 10c. the TIGHTENING branch — a household-shelved item carrying a grant.
  // This is the case the sweep exists for, and the one where the two rules
  // interact: re-filing household → requester turns TIER visibility into
  // GRANT-ONLY visibility, so the grant must survive the re-file while the
  // member who saw it by tier must lose it.
  memory.upsert_note(hh_note, { shared_with: ['kim'], shared_at: { kim: '2026-07-29T00:00:00Z' } }, '');
  user = { id: 'sam', tier: 'household' };
  check('precondition: the household item is visible to the member by TIER', (await req('/api/media/item/mi_hhclip')).status === 200);
  user = { id: 'kim', tier: 'friend' };
  check('precondition: the friend sees it only via the grant', (await req('/api/media/item/mi_hhclip')).status === 200);
  const hh_cordon = tighten_media_cordon(
    memory.read_note(hh_note)?.frontmatter?.private_to as string | undefined,
    'jasper',
  );
  check('the repair re-files the off-policy item onto the requester', hh_cordon === 'jasper');
  memory.upsert_note(hh_note, { private_to: hh_cordon }, '');
  check('the tightening repair PRESERVES the grant', grant_of(hh_note) === '["kim"]');
  // A cordon TIGHTENING reaches the list reads on the next reproject: the
  // projected cordon is consulted as a fast-path ALLOW, so a note that has
  // narrowed still passes it until the projection catches up. Run the ingestor.
  await rebuild(vault, memory, db);
  user = { id: 'sam', tier: 'household' };
  check('the member loses the re-filed item (tier visibility is gone)', (await req('/api/media/item/mi_hhclip')).status === 404);
  const hh_browse_member = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('…and it leaves the member’s browse', !hh_browse_member.items.some((i) => i.id === 'mi_hhclip'));
  user = { id: 'kim', tier: 'friend' };
  check('the granted friend keeps the re-filed item', (await req('/api/media/item/mi_hhclip')).status === 200);
  const hh_browse_friend = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('the grant survived the reproject into the friend’s browse', hh_browse_friend.items.some((i) => i.id === 'mi_hhclip'));
  // Revoke on the note only, then repair again. The projection now names kim, so
  // the revoke has to be caught by candidate-then-confirm on a repaired row.
  memory.upsert_note(hh_note, { shared_with: [], shared_at: {} }, '');
  memory.upsert_note(hh_note, { private_to: tighten_media_cordon(hh_cordon, 'jasper') }, '');
  check('a repair after revoking that grant does not resurrect it', grant_of(hh_note) === '[]');
  check('the revoked friend loses the re-filed item immediately', (await req('/api/media/item/mi_hhclip')).status === 404);
  const hh_browse_revoked = (await (await req('/api/media/browse?path=Video/YouTube/Test')).json()) as { items: { id: string }[] };
  check('…and drops out of their browse with no further reproject', !hh_browse_revoked.items.some((i) => i.id === 'mi_hhclip'));

  // ── 11. the roster is household-confidential: a FRIEND sees only the owner ─
  // A friend who owns one archived item used to receive every user's id, display
  // name and tier — contradicting the same reasoning that strips `targets`
  // entirely at can_share:false. Sharing UP to the owner is the one flow with a
  // justification; friend→household-member is deliberately not offered.
  user = { id: 'kim', tier: 'friend' };
  const lee_sharing = (await item('mi_leeclip')).sharing as Sharing;
  check('a friend can share their OWN item', lee_sharing.can_share === true);
  const lee_target_ids = (lee_sharing.targets ?? []).map((t) => t.user_id);
  check('a friend’s target list is exactly the owner', lee_target_ids.join() === 'jasper');
  check('a friend is NOT handed the household roster', !lee_target_ids.includes('sam'));
  check('a friend cannot share to a household member (not a target → 400)', (await share('mi_leeclip', ['sam'])).status === 400);
  check('a friend CAN share up to the owner', (await share('mi_leeclip', ['jasper'])).status === 200);
  user = { id: 'jasper', tier: 'owner' };
  check('the owner can now read the friend’s shared item', (await req('/api/media/item/mi_leeclip')).status === 200);
  check('…and cannot re-share it (still not theirs)', (await share('mi_leeclip', [])).status === 403);
  // A household-tier caller keeps the full pool — the restriction is tier-scoped
  // to friends, not a blanket narrowing.
  user = { id: 'sam', tier: 'household' };
  const sara_target_ids = (((await item('mi_saraclip')).sharing as Sharing).targets ?? []).map((t) => t.user_id);
  check('a household caller still sees the owner as a target', sara_target_ids.includes('jasper'));
  check('a household caller still sees the friend as a target', sara_target_ids.includes('kim'));

  // ── 12. a server with no roster: no surface, no verb ─────────────────────
  user = { id: 'jasper', tier: 'owner' };
  const app2 = new Hono();
  app2.use('*', async (c, next) => {
    if (user) c.set('user', user as unknown as UserConfig);
    await next();
  });
  app2.route('/api/media', create_media_router({ db, memory, archive_root }));
  const rosterless = (await (await app2.request('/api/media/item/mi_ownclip')).json()) as { sharing?: unknown };
  check('no roster → the `sharing` key is absent entirely', rosterless.sharing === undefined);
  const rosterless_post = await app2.request('/api/media/item/mi_ownclip/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_ids: ['sam'] }),
  });
  check('no roster → the share verb 503s', rosterless_post.status === 503);

  // ── 13. auth gate ────────────────────────────────────────────────────────
  user = null;
  check('401 without a user', (await share('mi_ownclip', [])).status === 401);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:media-sharing — ${passed} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
