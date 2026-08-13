export {};
/**
 * Seed Linda's library with AUTHORED resale knowledge (2026-06-03).
 *
 * Companion to `curate-linda-seed.ts` (which ingests external URLs). This
 * one files a small set of hand-authored, version-controlled markdown notes
 * from `scripts/seed/linda/*.md` onto Linda's shelf so she can retrieve them
 * with `search_library` / `read_note`:
 *
 *   - marketplace-fees.md          fee schedule + net-proceeds math
 *   - sourcing-roi-playbook.md     what to buy / skip / what a flip is worth
 *   - pricing-and-markdown-strategy.md  opening price + markdown cadence
 *   - resale-operations.md         cross-listing, shipping, photos, taxes
 *
 * Authored (not firecrawled) on purpose: a fee table and a strategy playbook
 * are higher-fidelity hand-written than scraped from login-gated help pages.
 * They're committed in the repo, so they're reviewable and re-seedable; when
 * a fee schedule changes, edit the note (and `src/connectors/marketplace_fees.ts`)
 * and re-run.
 *
 * Each note is POSTed to the live `/app/api/library/upload` endpoint as a
 * markdown file with `specialist_id=linda` — the same librarian pipeline a
 * direct user upload drives (convert → chunk into chunks_fts). `acknowledge`
 * is false so the seed doesn't spam Linda's inbox with upload acks.
 *
 * Run against a running orchestrator:
 *
 *   HEARTH_BASE_URL=https://your-llm-host.your-tailnet.ts.net \
 *   HEARTH_INTERNAL_BEARER=<token from mint:service-bearer> \
 *     bun run seed:linda-knowledge
 *
 * the always-on host a bearer first if needed:
 *   bun run mint:service-bearer -- --user=jasper --name=seed_linda_knowledge
 *
 * One-shot bootstrap; re-running re-files the notes (same filenames).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'seed', 'linda');

const NOTES = [
  'marketplace-fees.md',
  'sourcing-roi-playbook.md',
  'pricing-and-markdown-strategy.md',
  'resale-operations.md',
];

interface UploadResponse {
  note_path?: string;
  id?: string;
  error?: string;
  content_type?: string;
}

async function upload_one(
  base: string,
  bearer: string,
  filename: string,
): Promise<{ ok: boolean; filename: string; result: UploadResponse }> {
  const url = `${base.replace(/\/$/, '')}/app/api/library/upload`;
  const body = readFileSync(resolve(SEED_DIR, filename), 'utf8');
  const form = new FormData();
  form.append('file', new Blob([body], { type: 'text/markdown' }), filename);
  form.append('specialist_id', 'linda');
  form.append('acknowledge', 'false');
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'X-User-Timezone': 'America/Denver',
      },
      body: form,
    });
    const json = (await resp.json()) as UploadResponse;
    return { ok: resp.ok && !json.error, filename, result: json };
  } catch (err) {
    return { ok: false, filename, result: { error: (err as Error).message } };
  }
}

async function main(): Promise<void> {
  const base = process.env.HEARTH_BASE_URL ?? 'http://localhost:7700';
  const bearer = process.env.HEARTH_INTERNAL_BEARER;
  if (!bearer) {
    console.error(
      'HEARTH_INTERNAL_BEARER not set. the always-on host one via:\n' +
        '  bun run mint:service-bearer -- --user=jasper --name=seed_linda_knowledge',
    );
    process.exit(1);
  }
  console.log(`[seed:linda-knowledge] target=${base} notes=${NOTES.length}`);
  let ok = 0;
  let failed = 0;
  for (const filename of NOTES) {
    process.stdout.write(`  → ${filename} … `);
    const { ok: success, result } = await upload_one(base, bearer, filename);
    if (success) {
      ok++;
      console.log(`ok (${result.note_path ?? result.id ?? '<saved>'})`);
    } else {
      failed++;
      console.log(`FAILED — ${result.error ?? 'unknown'}`);
    }
  }
  console.log(`\n[seed:linda-knowledge] done — ok=${ok} failed=${failed}`);
  if (failed > 0) process.exit(2);
}

void main();
