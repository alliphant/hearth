/**
 * smoke:library-pane — self-contained test of Cordelia's composed
 * Knowledge Desk office (src/core/library_pane.ts).
 *
 * Temp vault + db. Seeds Cordelia/Inbox capture clippings (routed +
 * triage, with private_to cordon variants) and demand-ledger signals,
 * then asserts: triage-first hero, the triage backlog list, recently-
 * filed with destinations, owner-only knowledge gaps from the committed
 * demand ledger, the cordon (a non-owner doesn't see owner-private
 * captures or the gaps section), and that the library embed survives.
 * No LLM, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { compose_library_pane } from '../src/core/library_pane';
import type { PaneDeps } from '../src/core/specialist_pane';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-libpane-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });

function uid(): string {
  return ulid();
}

const NOW = Date.now();
const iso = (days_ago: number): string => new Date(NOW - days_ago * 86_400_000).toISOString();

function seed_capture(o: {
  id: string;
  title: string;
  captured_at: string;
  private_to?: string;
  routing_status?: 'routed' | 'triage';
  routed_to?: string[];
}): void {
  const fm = {
    type: 'clipping',
    routing_status: o.routing_status ?? null,
    routed_to: o.routed_to ?? [],
    ...(o.private_to ? { private_to: o.private_to } : {}),
  };
  db.prepare(
    `INSERT INTO clippings (id, kind, source, title, captured_at, note_path, frontmatter_json, mtime, private_to)
     VALUES (@id, 'photo', 'cordelia', @title, @ts, @path, @fm, @ts, @pt)`,
  ).run({
    '@id': o.id,
    '@title': o.title,
    '@ts': o.captured_at,
    '@path': `Cordelia/Inbox/${o.captured_at.slice(0, 10)}-photo-${o.id}.md`,
    '@fm': JSON.stringify(fm),
    '@pt': o.private_to ?? null,
  });
}

function seed_demand(query: string, agent: string, days_ago: number): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, execution_result, user_id)
     VALUES (@id, @ts, @i, @agent, 'search_library', @inp, @exec, 'jasper')`,
  ).run({
    '@id': uid(),
    '@ts': iso(days_ago),
    '@i': uid(),
    '@agent': agent,
    '@inp': JSON.stringify({ query_preview: query }),
    '@exec': JSON.stringify({ hits: 0 }),
  });
}

const owner_deps = { memory, viewer_is_owner: true } as unknown as PaneDeps;
const guest_deps = { memory, viewer_is_owner: false } as unknown as PaneDeps;

function main(): void {
  // Captures: 2 triage, 2 routed (owner), 1 routed but SAM-private.
  seed_capture({ id: 'c_triage1', title: 'Blurry receipt', captured_at: iso(1), routing_status: 'triage' });
  seed_capture({ id: 'c_triage2', title: 'Unknown gadget', captured_at: iso(2), routing_status: 'triage' });
  seed_capture({ id: 'c_routed1', title: 'Vet bill', captured_at: iso(1), routing_status: 'routed', routed_to: ['vivian', 'anya'] });
  seed_capture({ id: 'c_routed2', title: 'Concert poster', captured_at: iso(3), routing_status: 'routed', routed_to: ['maggie'] });
  seed_capture({ id: 'c_sara', title: "Sam's prescription", captured_at: iso(1), routing_status: 'routed', routed_to: ['anya'], private_to: 'sam' });

  // Demand: a clustered theme that should surface as a gap, attributed.
  seed_demand('ioniq 5 heat pump cold weather range', 'iris', 2);
  seed_demand('ioniq 5 heat pump preconditioning range loss', 'iris', 3);
  seed_demand('ioniq 5 heat pump efficiency winter', 'iris', 4);

  // ── owner view ──────────────────────────────────────────────────────
  const owner = compose_library_pane(db, 'jasper', owner_deps);
  check('owner: title is the Knowledge Desk', owner.title === 'Knowledge Desk');
  const hero = owner.blocks.find((b) => b.type === 'hero_metric');
  check('owner: triage-first hero', hero?.type === 'hero_metric' && /triage/i.test(hero.label + hero.value));
  const triageList = owner.blocks.find((b) => b.type === 'list' && b.title === 'Awaiting triage');
  check('owner: triage backlog list (2)', triageList?.type === 'list' && triageList.items.length === 2);
  const filed = owner.blocks.find((b) => b.type === 'list' && b.title === 'Recently filed');
  check('owner: recently-filed shows destinations',
    filed?.type === 'list' && filed.items.some((i) => /vivian|anya/.test(i.subtitle ?? '')));
  check('owner: sees own/household captures',
    filed?.type === 'list' && filed.items.some((i) => i.title === 'Vet bill'));
  // The per-user cordon is pure — the OWNER does NOT bypass it. Jasper must
  // NOT see Sam's private capture in his Library office either.
  check('owner: does NOT see Sam-private capture (cordon has no god-view)',
    filed?.type === 'list' && !filed.items.some((i) => i.title.includes("Sam's prescription")));
  const gaps = owner.blocks.find((b) => b.type === 'list' && b.title === 'Knowledge gaps');
  check('owner: knowledge-gaps section present', gaps?.type === 'list');
  check('owner: demand cluster surfaces as a gap',
    gaps?.type === 'list' && gaps.items.some((i) => /ioniq|heat|pump/i.test(i.title)));
  check('owner: library embed survives at the bottom',
    owner.blocks.some((b) => b.type === 'embed' && b.view === 'library'));

  // ── non-owner (household) view ──────────────────────────────────────
  const guest = compose_library_pane(db, 'kim', guest_deps);
  const guestFiled = guest.blocks.find((b) => b.type === 'list' && b.title === 'Recently filed');
  check('guest: does NOT see Sam-private capture',
    guestFiled?.type === 'list' && !guestFiled.items.some((i) => i.title.includes("Sam's prescription")));
  check('guest: does NOT see owner-private captures either',
    guestFiled?.type === 'list' && !guestFiled.items.some((i) => i.title === 'Vet bill'));
  check('guest: no knowledge-gaps section (owner-only)',
    !guest.blocks.some((b) => b.type === 'list' && b.title === 'Knowledge gaps'));

  db.close();
  rmSync(dir, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nsmoke:library-pane — all checks passed');
}

main();
