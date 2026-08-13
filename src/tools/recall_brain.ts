/**
 * recall_brain — a specialist asks its OWN Second Brain "what do I already
 * know about X" and gets back the DISTILLED layer: the grounded, evergreen
 * `synthesis_note`s ("what we know about X"), each with its sources, its
 * health grade, and when it was distilled — not the raw fragments.
 *
 * Why it's distinct from `search_library`: that returns raw chunks (the
 * fidelity layer); this returns only the curated syntheses (the knowledge
 * layer). The turn-start RAG already LEADS with syntheses (the read-path
 * prior), so the implicit path is covered; this is the EXPLICIT move for when
 * a specialist wants to deliberately consult what's been consolidated before
 * researching a topic from scratch ("do I already have a view on this?").
 *
 * Capability-gated by `read_vault`. Cordon-safe: it rides `retrieve_hybrid`,
 * which applies the same `private_to` gate as every other read — a specialist
 * never recalls another user's private synthesis. Reachable via the dynamic
 * tool surface / per-specialist curation; deliberately NOT in the always-on
 * base toolset (its schema shouldn't tax every prompt).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { retrieve_hybrid } from '@core/retrieval';
import { NOOP_EMBEDDER } from '@core/embeddings';

const SYNTHESIS_PATH_RE = /\/_synthesis\//;
const SHELF_RE = /^Knowledge\/([^/]+)\/library\//;

const InputSchema = z.object({
  topic: z.string().min(2).max(300),
  k: z.coerce.number().int().min(1).max(8).default(3),
});

const SynthSchema = z.object({
  topic: z.string(),
  note_path: z.string(),
  shelf: z.string(),
  prose: z.string(),
  health_grade: z.string().nullable(),
  health_score: z.number().nullable(),
  sources: z.array(z.string()),
  synthesized_at: z.string().nullable(),
});

const OutputSchema = z.object({
  found: z.boolean(),
  syntheses: z.array(SynthSchema),
  topic_queried: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** The "what we know" prose, between the `# … — what we know` heading and the
 *  `## Sources` block. */
function extract_prose(body: string): string {
  const after_heading = body.replace(/^#[^\n]*\n+/, '');
  return (after_heading.split(/\n##\s+sources/i)[0] ?? after_heading).trim();
}

export const recall_brain: Tool<Input, Output> = {
  name: 'recall_brain',
  description:
    "Recall what you already KNOW about a topic — your shelf's distilled syntheses (the evergreen \"what we know about X\" notes), each with its sources and a confidence grade. Use this before researching a topic from scratch, to check whether you already have a consolidated view. Returns only the distilled layer (not raw fragments — use search_library for those). Example: {topic: \"tomato blight treatment\", k: 3}.",
  risk: 'read',
  required_capabilities: ['read_vault'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.topic.toLowerCase().trim());
    h.update(String(input.k));
    return `recall_brain:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    // Over-fetch raw, then keep only synthesis hits (one chunk per note is
    // typical, but dedupe defensively). Cordon rides retrieve_hybrid.
    const hits = await retrieve_hybrid({
      memory: ctx.memory,
      embedder: ctx.embedder ?? NOOP_EMBEDDER,
      query: input.topic,
      knowledge_scope: ['**'],
      k: Math.max(input.k * 4, 12),
      user_id: ctx.user?.id,
      user_tier: ctx.user?.tier ?? 'owner',
    });

    const seen = new Set<string>();
    const syntheses: z.infer<typeof SynthSchema>[] = [];
    for (const h of hits) {
      if (syntheses.length >= input.k) break;
      if (!SYNTHESIS_PATH_RE.test(h.note_path) || seen.has(h.note_path)) continue;
      seen.add(h.note_path);
      const note = ctx.memory.read_note(h.note_path);
      if (!note) continue;
      const fm = note.frontmatter as Record<string, unknown>;
      if (fm.type !== 'synthesis_note') continue;
      syntheses.push({
        topic: typeof fm.topic_label === 'string' ? fm.topic_label : (h.title ?? input.topic),
        note_path: h.note_path,
        shelf: SHELF_RE.exec(h.note_path)?.[1] ?? '',
        prose: extract_prose(note.body),
        health_grade: typeof fm.health_grade === 'string' ? fm.health_grade : null,
        health_score: typeof fm.health_score === 'number' ? fm.health_score : null,
        sources: Array.isArray(fm.synthesized_from)
          ? (fm.synthesized_from.filter((p) => typeof p === 'string') as string[])
          : [],
        synthesized_at: typeof fm.synthesized_at === 'string' ? fm.synthesized_at : null,
      });
    }

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'orchestrator',
      tool_name: 'recall_brain',
      tool_input: { topic_preview: input.topic.slice(0, 120), k: input.k },
      execution_result: { found: syntheses.length, paths: syntheses.map((s) => s.note_path) },
      user_id: ctx.user?.id,
    });

    return { found: syntheses.length > 0, syntheses, topic_queried: input.topic };
  },
};
