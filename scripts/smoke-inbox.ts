import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ORCH_URL = process.env.HEARTH_URL ?? 'http://localhost:7700';
const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;

interface SavedResp {
  id: string;
  wrapper_note_path: string;
  attachment_path?: string;
  title: string;
  kind: string;
  error?: string;
}

interface RecentResp {
  items: Array<{
    path: string;
    title: string;
    captured_at: string;
    kind: string;
    reviewed: boolean;
  }>;
}

async function main() {
  // 1. UI page
  console.log(`→ GET ${ORCH_URL}/inbox`);
  const page_res = await fetch(`${ORCH_URL}/inbox/`);
  if (!page_res.ok) throw new Error(`Inbox UI not reachable: ${page_res.status}`);
  const html = await page_res.text();
  if (!html.includes('Hearth Inbox')) {
    throw new Error('Inbox UI HTML does not contain expected title');
  }
  console.log('  ✓ inbox HTML served');

  // 2. Markdown file upload
  console.log(`\n→ POST ${ORCH_URL}/inbox/upload (markdown)`);
  const md_body = `# Smoke Test ${new Date().toISOString()}\n\nThis is a smoke-test markdown file for the Hearth Inbox.\n\n- bullet one\n- bullet two\n`;
  const md_file = new File([md_body], 'inbox-smoke-test.md', {
    type: 'text/markdown',
  });
  const form = new FormData();
  form.append('file', md_file);
  const up_res = await fetch(`${ORCH_URL}/inbox/upload`, {
    method: 'POST',
    body: form,
  });
  const up_json = (await up_res.json()) as SavedResp;
  console.log('  response:', JSON.stringify(up_json, null, 2));
  if (!up_res.ok) throw new Error(`Upload failed: ${up_json.error ?? up_res.statusText}`);
  if (!up_json.wrapper_note_path) throw new Error('Missing wrapper_note_path');

  // Verify wrapper note exists and has expected frontmatter
  const wrapper_abs = resolve(VAULT_ROOT, up_json.wrapper_note_path);
  if (!existsSync(wrapper_abs)) throw new Error(`Wrapper note missing: ${wrapper_abs}`);
  const wrapper_content = readFileSync(wrapper_abs, 'utf8');
  if (!wrapper_content.includes('type: clipping')) {
    throw new Error('Wrapper note frontmatter missing type: clipping');
  }
  if (!wrapper_content.includes('kind: text')) {
    throw new Error('Wrapper note frontmatter missing kind: text');
  }
  console.log(`  ✓ wrapper note at ${wrapper_abs}`);

  // 3. Recent list reflects the upload
  console.log(`\n→ GET ${ORCH_URL}/inbox/recent`);
  const recent_res = await fetch(`${ORCH_URL}/inbox/recent`);
  const recent_json = (await recent_res.json()) as RecentResp;
  if (!recent_json.items?.some((it) => it.path === up_json.wrapper_note_path)) {
    throw new Error('Recent list does not contain the uploaded item');
  }
  console.log(`  ✓ ${recent_json.items.length} items in recent list (uploaded item present)`);

  // 4. URL ingest (use example.com — small, stable, low-controversy)
  console.log(`\n→ POST ${ORCH_URL}/inbox/url`);
  const url_res = await fetch(`${ORCH_URL}/inbox/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/' }),
  });
  const url_json = (await url_res.json()) as SavedResp;
  console.log('  response:', JSON.stringify(url_json, null, 2));
  if (!url_res.ok) {
    // Don't fail the whole smoke if example.com is unreachable; warn instead
    console.warn(`  ⚠ URL ingest failed (network?): ${url_json.error ?? url_res.statusText}`);
  } else {
    const url_abs = resolve(VAULT_ROOT, url_json.wrapper_note_path);
    if (!existsSync(url_abs)) throw new Error(`URL wrapper note missing: ${url_abs}`);
    const url_content = readFileSync(url_abs, 'utf8');
    if (!url_content.includes('source: url')) {
      throw new Error('URL wrapper note frontmatter missing source: url');
    }
    console.log(`  ✓ URL wrapper note at ${url_abs}`);
  }

  console.log(`\n✓ INBOX SMOKE PASSED`);
}

main().catch((err: unknown) => {
  console.error(
    `\n✗ INBOX SMOKE FAILED:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
