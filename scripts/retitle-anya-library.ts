/**
 * One-shot retitle for Anya's two existing the clinic VTH wrapper notes.
 * They were ingested with the old "first-extracted-line" title path,
 * which produced unreadable titles like "the clinic VTH: Jasper Doe,
 * 'Bailey' ,0000000, Visit Date: 2/17/2026 Page 1 VISIT MEDICAL
 * SUMMARY - BRIEF - SMALL ANIMAL INTERNAL MEDICINE Visit Date:..."
 *
 * Reads each wrapper note's body, calls the same titleize+summarize
 * LLM the new upload path uses, rewrites frontmatter in place, and
 * leaves the filename alone (renaming would cascade to clippings.note_path
 * and chunks_fts and isn't worth the churn for these two — the library
 * UI lists by frontmatter title, not filename).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import matter from 'gray-matter';
import { ConfigLLMRouter } from '@core/router';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const ROLES_PATH = process.env.HEARTH_ROLES_PATH ?? './config/llm-roles.yaml';
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

const TARGETS = [
  'Knowledge/Anya/library/2026-05-19-vet-hospital-jasper-doe-bailey-0000000-visit-date-2-17-2026-p.md',
  'Knowledge/Anya/library/2026-05-19-vet-hospital-doe-jasper-bailey-0000000-visit-date-8-15-2024-p.md',
];

const llm = new ConfigLLMRouter(ROLES_PATH, {
  ollama_base_url: OLLAMA_URL,
  openai_base_url: process.env.OPENAI_BASE_URL,
  openai_api_key: process.env.OPENAI_API_KEY,
});

async function titleize(
  hint: string,
  body: string,
): Promise<{ title?: string; summary?: string }> {
  const role = llm.for_role('scribe_writer');
  if (!role) return {};
  const truncated =
    body.length > 8000
      ? body.slice(0, 8000) + '\n\n[...truncated for summary]'
      : body;
  const resp = await role.provider.complete({
    messages: [
      {
        role: 'system',
        content:
          "You produce two short fields for a household vault's library entry.\n\n" +
          'FORMAT — reply with these two lines EXACTLY, nothing else:\n' +
          'TITLE: <8-14 word human-friendly title>\n' +
          'SUMMARY: <1-2 sentence summary, ~60 words max, plain prose>\n\n' +
          'TITLE GUIDELINES:\n' +
          '- Treat the entry as something a human will scan in a list. Examples of good titles:\n' +
          '  "Bailey\'s the clinic VTH internal medicine visit — Feb 17, 2026"\n' +
          '  "Eleanor\'s soil test results from Front Range Ag — Apr 2026"\n' +
          '  "Mortgage closing docs — 3215 Westwood, Sep 2024"\n' +
          '- Lead with the WHO (person/pet/property) and WHAT, then any date worth knowing.\n' +
          '- No raw header dumps, no page numbers, no patient IDs, no all-caps section names.\n' +
          '- Do not include the file extension. Do not start with "Document:" or "PDF:".\n\n' +
          'SUMMARY GUIDELINES:\n' +
          '- What kind of doc, who/what it concerns, the most important factual content.\n' +
          '- Never invent details. Use only what is in the body.\n' +
          '- Plain prose, no headings, no bullets.',
      },
      {
        role: 'user',
        content: `Extracted-first-line hint (may be garbage — use only if useful): ${hint}\n\nBody:\n${truncated}`,
      },
    ],
    temperature: 0.3,
    think: false,
  });
  const out = resp.content.trim();
  if (!out) return {};
  const title_match = out.match(/^\s*TITLE:\s*(.+?)\s*$/im);
  const summary_match = out.match(/SUMMARY:\s*([\s\S]+?)\s*$/im);
  const title = title_match?.[1]?.trim();
  const summary = summary_match?.[1]?.trim();
  return {
    title: title && title.length > 0 ? title.slice(0, 140) : undefined,
    summary: summary && summary.length > 0 ? summary : undefined,
  };
}

for (const rel of TARGETS) {
  const abs = `${VAULT_ROOT}/${rel}`;
  const raw = readFileSync(abs, 'utf8');
  const parsed = matter(raw);
  const old_title = String(parsed.data.title ?? '(none)');
  console.log(`\n--- ${rel} ---`);
  console.log(`OLD title: ${old_title.slice(0, 100)}${old_title.length > 100 ? '…' : ''}`);
  const body = parsed.content.trim();
  if (body.length < 50) {
    console.log(`SKIP: body is essentially empty (${body.length} chars)`);
    continue;
  }
  const { title, summary } = await titleize(old_title, body);
  if (!title) {
    console.log('SKIP: titleize returned no title');
    continue;
  }
  console.log(`NEW title:  ${title}`);
  if (summary) console.log(`NEW summary: ${summary}`);
  parsed.data.title = title;
  if (summary) parsed.data.summary = summary;
  if (old_title && old_title !== title) {
    parsed.data.extracted_header = old_title;
  }
  const out = matter.stringify(parsed.content, parsed.data);
  writeFileSync(abs, out);
  console.log(`WROTE ${rel}`);
}

console.log('\ndone.');
process.exit(0);
