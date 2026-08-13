/**
 * quarantine-library-trash — one-shot cleanup of existing curation junk
 * (#2b). Ruby's bootstrap left ~50% trash on her shelf (PDF-download
 * interstitials and nav-chrome shells saved AS the documents). This walks
 * every specialist's library, runs the SAME quality gate
 * (src/connectors/capture_quality.ts) the save path now enforces, and
 * QUARANTINES (never deletes) the captures it would reject today.
 *
 * Uses the structural pre-filter only (no LLM) — so it quarantines only
 * the UNAMBIGUOUS shells (the documented trash is all <200 chars and is
 * caught deterministically). Ambiguous captures fail-open (kept) and are
 * left for the live gate / manual review; this script never over-removes.
 *
 * Rejected captures are MOVED to Knowledge/<Spec>/library/_quarantine/
 * (wrapper note + its attachment), de-indexed from the clippings +
 * chunks_fts tables (so search stops returning them), and recorded in
 * Knowledge/<Spec>/library/_quarantine/MANIFEST.md. Nothing is deleted —
 * review the manifest and delete by hand if you agree.
 *
 *   bun run scripts/quarantine-library-trash.ts            # DRY RUN (report only)
 *   bun run scripts/quarantine-library-trash.ts --apply    # actually move + de-index
 *
 * Honors HEARTH_VAULT_ROOT / HEARTH_DB_PATH like the long-running services.
 */

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import matter from 'gray-matter';
import { open_db } from '@memory/stores/structured';
import { assess_capture_quality } from '@connectors/capture_quality';
import { quarantine_note } from '@core/library_quarantine';

const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const APPLY = process.argv.includes('--apply');

const db = open_db(DB_PATH);

interface Rejected {
  namespace: string;
  note_rel: string;
  reason: string;
  content_type: string;
  follow_url?: string;
}

const rejected: Rejected[] = [];
let scanned = 0;

const knowledge_abs = resolve(VAULT_ROOT, 'Knowledge');
if (!existsSync(knowledge_abs)) {
  console.error(`No Knowledge/ dir at ${knowledge_abs} — nothing to scan.`);
  process.exit(0);
}

for (const ns of readdirSync(knowledge_abs)) {
  const lib_abs = join(knowledge_abs, ns, 'library');
  if (!existsSync(lib_abs)) continue;
  let entries: string[];
  try {
    entries = readdirSync(lib_abs);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue; // skip _attachments/_archive/_quarantine subdirs
    const note_abs = join(lib_abs, name);
    let st;
    try {
      st = statSync(note_abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    scanned++;

    let raw: string;
    try {
      raw = readFileSync(note_abs, 'utf8');
    } catch {
      continue;
    }
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    // Structural-only gate (no llm): deterministic, never over-removes.
    const verdict = await assess_capture_quality({
      body: parsed.content,
      source_url: typeof fm.source_url === 'string' ? fm.source_url : undefined,
      kind: typeof fm.kind === 'string' ? fm.kind : undefined,
      mode: 'full',
    });
    if (verdict.ok) continue;

    const note_rel = `Knowledge/${ns}/library/${name}`;
    rejected.push({
      namespace: ns,
      note_rel,
      reason: verdict.reason ?? 'low-quality capture',
      content_type: verdict.content_type ?? 'thin',
      follow_url: verdict.follow_url,
    });

    if (APPLY) {
      // The move + de-index mechanics live in ONE place (src/core/library_quarantine.ts).
      // They used to be inline here, and drifted: `chunk_embeddings` was never
      // dropped, so a quarantined note stayed reachable through the VECTOR half
      // of hybrid retrieval. Extracted 2026-07-31 so the next caller inherits
      // the fix instead of copying the bug.
      const q = quarantine_note(
        db,
        VAULT_ROOT,
        note_rel,
        `**${verdict.content_type}**: ${verdict.reason}` +
          (verdict.follow_url ? ` (real file: ${verdict.follow_url})` : ''),
      );
      if (q.error) console.error(`  ! could not move ${note_rel}: ${q.error}`);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────
console.log(`\nScanned ${scanned} library captures across all specialists.`);
console.log(`${rejected.length} rejected by the structural quality gate:\n`);
const by_ns = new Map<string, Rejected[]>();
for (const r of rejected) {
  const arr = by_ns.get(r.namespace) ?? [];
  arr.push(r);
  by_ns.set(r.namespace, arr);
}
for (const [ns, arr] of by_ns) {
  console.log(`  ${ns}/  (${arr.length})`);
  for (const r of arr) {
    console.log(
      `    - ${basename(r.note_rel)}  [${r.content_type}] ${r.reason}` +
        (r.follow_url ? `  → ${r.follow_url}` : ''),
    );
  }
}
console.log(
  APPLY
    ? `\n✓ APPLIED — ${rejected.length} captures quarantined + de-indexed. See each library's _quarantine/MANIFEST.md.`
    : `\n(DRY RUN — nothing moved. Re-run with --apply to quarantine + de-index.)`,
);
db.close();
