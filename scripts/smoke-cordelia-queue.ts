/**
 * smoke:cordelia-queue — update_queue_note_status terminal write.
 *
 * Self-contained (temp vault + db). Covers the happy path (queued →
 * acquired, processed_at stamped) plus the three refusals that keep the
 * tool from mutating anything it shouldn't: out-of-scope path, missing
 * note, and a non-book_candidate note.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import type { ToolContext } from '../src/core/tool';
import { make_update_queue_note_status } from '../src/specialists/cordelia/tools/update_queue_note_status';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-cordelia-queue-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const tool = make_update_queue_note_status(memory);
const ctx = {} as ToolContext; // execute ignores ctx

const QUEUE = 'Knowledge/Cordelia/queue/2026-06-14-the-overstory.md';

async function main(): Promise<void> {
  // Seed a queued book-candidate note (mirrors intake_book's shape).
  memory.upsert_note(
    QUEUE,
    { type: 'book_candidate', status: 'queued', title_candidate: 'The Overstory', private_to: 'jasper' },
    '# Book candidate — The Overstory\n',
  );

  // 1. Happy path: queued → acquired, with a reason.
  const ok = await tool.execute(
    { queue_note_path: QUEUE, status: 'acquired', reason: 'shelved OA copy' },
    ctx,
  );
  check('updated true', ok.updated === true);
  check('status_before reported', ok.status_before === 'queued');
  check('status_now is acquired', ok.status_now === 'acquired');

  const after = memory.read_note(QUEUE);
  check('on-disk status is acquired', after?.frontmatter.status === 'acquired');
  check('processed_at stamped', typeof after?.frontmatter.processed_at === 'string');
  check('processed_reason recorded', after?.frontmatter.processed_reason === 'shelved OA copy');
  check('title preserved (merge, not clobber)', after?.frontmatter.title_candidate === 'The Overstory');

  // 2. Out-of-scope path is refused, nothing written.
  const out = await tool.execute(
    { queue_note_path: 'People/Jasper.md', status: 'skipped' },
    ctx,
  );
  check('out-of-scope refused', out.updated === false && /out of scope/.test(out.note ?? ''));

  // 3. Missing queue note is refused (recovery hint names the folder).
  const missing = await tool.execute(
    { queue_note_path: 'Knowledge/Cordelia/queue/does-not-exist.md', status: 'skipped' },
    ctx,
  );
  check('missing note refused', missing.updated === false && /no queue note found/.test(missing.note ?? ''));

  // 4. A non-book_candidate note under the queue folder is refused.
  const OTHER = 'Knowledge/Cordelia/queue/not-a-book.md';
  memory.upsert_note(OTHER, { type: 'clipping', status: 'open' }, 'something else');
  const wrong = await tool.execute({ queue_note_path: OTHER, status: 'acquired' }, ctx);
  check('non-book_candidate refused', wrong.updated === false && /not a book_candidate/.test(wrong.note ?? ''));
  check('non-book_candidate left intact', memory.read_note(OTHER)?.frontmatter.status === 'open');
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(
      failures === 0 ? '\nsmoke:cordelia-queue OK' : `\nsmoke:cordelia-queue FAILED (${failures})`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
