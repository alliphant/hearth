/**
 * smoke:recall-brain — self-contained test of the recall_brain tool (#5).
 * Temp vault + db; seeds synthesis notes + a raw note (all on the tomato-blight
 * topic, all chunked into FTS) across visibility buckets, then asserts:
 *   - recall returns ONLY the distilled syntheses, never the raw fragment
 *   - the per-user cordon holds (owner does NOT recall a sam-private synthesis;
 *     sam does)
 *   - prose / health grade / sources / shelf are surfaced from frontmatter
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { recall_brain } from '../src/tools/recall_brain';
import type { ToolContext } from '../src/core/tool';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-recall-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const NOW = new Date('2026-06-15T12:00:00Z');

function seed_synth(o: { shelf: string; slug: string; private_to?: string; grade: string; score: number }): string {
  const p = `Knowledge/${o.shelf}/library/_synthesis/${o.slug}.md`;
  const fm: Record<string, unknown> = {
    type: 'synthesis_note',
    title: `${o.slug} — synthesis`,
    specialist_scope: o.shelf.toLowerCase(),
    topic_label: 'tomato blight',
    synthesized_from: [`Knowledge/${o.shelf}/library/src-a.md`],
    synthesized_at: NOW.toISOString(),
    derived: true,
    grounding_outcome: 'clean',
    health_grade: o.grade,
    health_score: o.score,
  };
  if (o.private_to) fm.private_to = o.private_to;
  memory.upsert_note(p, fm, `# tomato blight — what we know\n\nCopper fungicide slows tomato blight; remove infected leaves.\n\n## Sources (1)\n- **src** — \`x\`\n`);
  db.prepare(`INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, 0, @c)`).run({
    '@p': p,
    '@c': 'tomato blight copper fungicide infected leaves',
  });
  return p;
}

// A household synthesis (owner + household see it), a sam-private one (only
// sam), and a RAW clipping on the same topic (must be excluded — not distilled).
const SYN_HH = seed_synth({ shelf: 'Eleanor', slug: 'shelf-tomato', private_to: 'household', grade: 'sound', score: 0.78 });
const SYN_SARA = seed_synth({ shelf: 'Eleanor', slug: 'sam-tomato', private_to: 'sam', grade: 'weak', score: 0.5 });
const RAW = 'Knowledge/Eleanor/library/raw-tomato.md';
memory.upsert_note(RAW, { type: 'clipping', title: 'Raw tomato note', private_to: 'household' }, 'tomato blight raw capture');
db.prepare(`INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, 0, @c)`).run({
  '@p': RAW,
  '@c': 'tomato blight raw capture copper',
});

const ctx_for = (id: string, tier: string): ToolContext =>
  ({ memory, now: NOW, intent_id: 'i', user: { id, tier } } as unknown as ToolContext);

// ── owner recall ────────────────────────────────────────────────────────────
{
  const out = await recall_brain.execute({ topic: 'tomato blight', k: 5 }, ctx_for('jasper', 'owner'));
  check('owner: found a synthesis', out.found && out.syntheses.length >= 1);
  check('owner: the household synthesis is recalled', out.syntheses.some((s) => s.note_path === SYN_HH));
  check('synthesis-only: the RAW clipping is NEVER returned', !out.syntheses.some((s) => s.note_path === RAW));
  check('cordon: owner does NOT recall the sam-private synthesis', !out.syntheses.some((s) => s.note_path === SYN_SARA));
  const hh = out.syntheses.find((s) => s.note_path === SYN_HH)!;
  check('surfaces prose / grade / score / sources / shelf', !!hh && hh.prose.includes('Copper fungicide') && hh.health_grade === 'sound' && hh.health_score === 0.78 && hh.sources.length === 1 && hh.shelf === 'Eleanor');
}

// ── sam recall (cordon lets her see her own) ───────────────────────────────
{
  const out = await recall_brain.execute({ topic: 'tomato blight', k: 5 }, ctx_for('sam', 'household'));
  check('cordon: sam recalls HER private synthesis', out.syntheses.some((s) => s.note_path === SYN_SARA));
  check('cordon: sam also sees the household synthesis', out.syntheses.some((s) => s.note_path === SYN_HH));
}

// ── audit + miss path ───────────────────────────────────────────────────────
{
  const out = await recall_brain.execute({ topic: 'nonexistent quantum widget', k: 3 }, ctx_for('jasper', 'owner'));
  check('no match → found:false, empty list', !out.found && out.syntheses.length === 0);
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'recall_brain'`).get() as { n: number };
  check('every recall writes an audit row', rows.n === 3);
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nsmoke:recall-brain OK' : `\nsmoke:recall-brain FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
