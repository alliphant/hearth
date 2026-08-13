import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import { local_iso_date } from '@core/time';
import type { Tool, ToolContext } from '@core/tool';
import {
  read_style_corpus,
  format_corpus_for_prompt,
} from '@specialists/kate/style/read_corpus';

const RAW_PATH = 'Knowledge/Kate/jasper_style.md';
const PROFILE_PATH = 'Knowledge/Kate/jasper_style_profile.md';
const CORPUS_REL = 'Knowledge/Kate/style_corpus';

const MAX_CORPUS_CHARS = 60_000;
const MAX_BULLETS_CHARS = 10_000;
const MAX_PRIOR_PROFILE_CHARS = 8_000;

const InputSchema = z.object({});

const OutputSchema = z.object({
  profile_path: z.string(),
  profile_chars: z.number(),
  corpus_files_read: z.number(),
  corpus_files_skipped: z.number(),
  corpus_bytes: z.number(),
  bullets_count: z.number(),
  truncated: z.boolean(),
  model: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function read_raw_bullets(vault_root: string): { text: string; count: number } {
  const abs = resolve(vault_root, RAW_PATH);
  if (!existsSync(abs)) return { text: '', count: 0 };
  const body = readFileSync(abs, 'utf8');
  const matches = body.match(/^- \*\*\d{4}-\d{2}-\d{2}\*\* —/gm) ?? [];
  const trimmed =
    body.length > MAX_BULLETS_CHARS
      ? body.slice(body.length - MAX_BULLETS_CHARS)
      : body;
  return { text: trimmed, count: matches.length };
}

function read_prior_profile(vault_root: string): string {
  const abs = resolve(vault_root, PROFILE_PATH);
  if (!existsSync(abs)) return '';
  const { content } = matter(readFileSync(abs, 'utf8'));
  return content.length > MAX_PRIOR_PROFILE_CHARS
    ? content.slice(0, MAX_PRIOR_PROFILE_CHARS) + '\n[...prior profile truncated]'
    : content;
}

export function make_distill_jasper_style(vault_root: string): Tool<Input, Output> {
  return {
    name: 'distill_jasper_style',
    description:
      "Rebuild Knowledge/Kate/jasper_style_profile.md by distilling Jasper's raw style observations and the writing samples under Knowledge/Kate/style_corpus/ into a structured profile. Reads prior profile as a strong prior. Idempotent: safe to re-run; will overwrite the profile.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_general', 'read_vault'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(_input) {
      return `distill_jasper_style:${createHash('sha256').update(local_iso_date()).digest('hex').slice(0, 12)}`;
    },

    async execute(_input, ctx: ToolContext): Promise<Output> {
      const corpus_dir = resolve(vault_root, CORPUS_REL);
      const corpus = existsSync(corpus_dir)
        ? await read_style_corpus(corpus_dir)
        : { files: [], total_bytes: 0, skipped: [] };
      const formatted = format_corpus_for_prompt(corpus.files, MAX_CORPUS_CHARS);
      const raw = read_raw_bullets(vault_root);
      const prior = read_prior_profile(vault_root);

      const prompts_dir = process.env.HEARTH_PROMPTS_DIR ?? './config/prompts';
      const prompt_path = resolve(prompts_dir, 'kate_style_distill.md');
      if (!existsSync(prompt_path)) {
        throw new Error(`kate_style_distill.md prompt missing at ${prompt_path}`);
      }
      const system_prompt = readFileSync(prompt_path, 'utf8');

      const user_payload = [
        '## prior_profile',
        prior.trim().length > 0 ? prior : '(empty — first run)',
        '',
        '## raw_bullets',
        raw.text.trim().length > 0 ? raw.text : '(no bullets yet)',
        '',
        '## corpus',
        formatted.body.trim().length > 0
          ? formatted.body
          : '(no corpus files dropped yet)',
      ].join('\n');

      const role = ctx.llm.for_role('scribe_writer');
      const resp = await role.provider.complete({
        messages: [
          { role: 'system', content: system_prompt },
          { role: 'user', content: user_payload },
        ],
        temperature: role.defaults.temperature,
      });

      const profile_body = resp.content.trim();
      const now_iso = ctx.now.toISOString();
      const frontmatter = {
        // Jasper's distilled writing-style profile is owner-sensitive
        // captain state; cordon it from household/friend RAG.
        private_to: 'owner',
        last_distilled: now_iso,
        bullets_read: raw.count,
        corpus_files_read: formatted.used_files,
        corpus_files_skipped: corpus.skipped.length,
        corpus_bytes: corpus.total_bytes,
        corpus_truncated: formatted.truncated,
        model: resp.cost.model,
      };

      ctx.memory.upsert_note(PROFILE_PATH, frontmatter, profile_body);

      return {
        profile_path: PROFILE_PATH,
        profile_chars: profile_body.length,
        corpus_files_read: formatted.used_files,
        corpus_files_skipped: corpus.skipped.length,
        corpus_bytes: corpus.total_bytes,
        bullets_count: raw.count,
        truncated: formatted.truncated,
        model: resp.cost.model,
      };
    },
  };
}
