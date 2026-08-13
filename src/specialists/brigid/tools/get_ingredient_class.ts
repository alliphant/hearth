/**
 * get_ingredient_class — return the freshness class (1-5) for one or
 * more ingredients, from config/ingredient_classes.yaml.
 *
 * Brigid uses this to sequence a week's dinners — high-volatility
 * proteins (class 1: fish, shellfish) land Mon/Tue, hardier proteins
 * (class 3: whole chicken) land mid-week, pantry-driven meals (class 5)
 * float anywhere.
 *
 * Misses (an ingredient the yaml doesn't list) return class `null` with
 * `judged: false` — Brigid can then ask the LLM to judge it or default
 * to class 5 (pantry). This keeps the yaml from needing to enumerate
 * every ingredient that exists; the prior is informative, not authoritative.
 *
 * Matching is case-insensitive substring: a query "ground beef" matches
 * the yaml entry "ground beef" exactly; "fresh shrimp" matches "shrimp".
 * Most specific match wins — if multiple classes contain a substring,
 * the lowest class number (most volatile) is reported, because it's the
 * safe default for planning.
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parse_yaml } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';

const CLASSES_PATH = resolve(
  process.env.HEARTH_INGREDIENT_CLASSES_PATH ?? './config/ingredient_classes.yaml',
);

const InputSchema = z.object({
  ingredients: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(40)
    .describe('Ingredient names to look up (1-40 per call). Free-text, lowercase or mixed; matching is case-insensitive.'),
});

const Match = z.object({
  ingredient: z.string(),
  class_num: z.number().nullable().describe('Integer 1-5, or null when no class matched.'),
  description: z.string().nullable().describe("Human-readable class description (e.g. 'Highly volatile — use within ~2 days')."),
  matched_term: z.string().nullable().describe('The yaml entry that matched, or null on miss.'),
  judged: z.boolean().describe('True when a class was assigned from the yaml; false on a miss (caller should LLM-judge or default to 5).'),
});

const OutputSchema = z.object({
  results: z.array(Match),
  hint: z.string().describe('Tells the LLM how to use the result.'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface ClassBlock {
  description?: string;
  ingredients?: string[];
}

interface ClassesYaml {
  class_1?: ClassBlock;
  class_2?: ClassBlock;
  class_3?: ClassBlock;
  class_4?: ClassBlock;
  class_5?: ClassBlock;
}

interface CompiledClass {
  num: number;
  description: string;
  needles: string[]; // lowercased ingredient strings
}

let _compiled: CompiledClass[] | null = null;
let _compiled_mtime: number | null = null;

function load_classes(): CompiledClass[] {
  if (!existsSync(CLASSES_PATH)) return [];
  try {
    const raw = parse_yaml(readFileSync(CLASSES_PATH, 'utf8')) as ClassesYaml | null;
    if (!raw) return [];
    const out: CompiledClass[] = [];
    for (const num of [1, 2, 3, 4, 5] as const) {
      const block = (raw as Record<string, ClassBlock | undefined>)[`class_${num}`];
      if (!block) continue;
      const needles = Array.isArray(block.ingredients)
        ? block.ingredients
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .map((s) => s.toLowerCase().trim())
        : [];
      out.push({
        num,
        description: typeof block.description === 'string' ? block.description : '',
        needles,
      });
    }
    return out;
  } catch (err) {
    console.warn(`[get_ingredient_class] parse failed: ${(err as Error).message}`);
    return [];
  }
}

function compiled(): CompiledClass[] {
  // Re-read when the file changes on disk so chokidar's hot-reload story
  // applies here too. Cheap mtime check, no full re-parse on hit.
  try {
    const mtime = Bun.file(CLASSES_PATH).lastModified;
    if (_compiled && _compiled_mtime === mtime) return _compiled;
    _compiled = load_classes();
    _compiled_mtime = mtime;
  } catch {
    if (!_compiled) _compiled = load_classes();
  }
  return _compiled;
}

function classify(ingredient: string): { class_num: number; description: string; matched: string } | null {
  const needle = ingredient.toLowerCase().trim();
  if (!needle) return null;
  // Most-volatile-wins — iterate classes in order so class 1 takes
  // precedence over a class-4 match on the same substring.
  for (const c of compiled()) {
    for (const n of c.needles) {
      if (needle === n || needle.includes(n) || n.includes(needle)) {
        return { class_num: c.num, description: c.description, matched: n };
      }
    }
  }
  return null;
}

export const get_ingredient_class: Tool<Input, Output> = {
  name: 'get_ingredient_class',
  description:
    "Look up the freshness class (1-5) for one or more ingredients, from the household's ingredient_classes.yaml. Class 1 = use within ~2 days (fish, shellfish, soft greens), 2 = within ~4 days (ground meat, fresh dairy), 3 = ~7 days (whole-muscle meat, hardy veg), 4 = ~14 days (root veg, eggs, butter), 5 = pantry. Brigid sequences class 1 to Mon/Tue, class 2 to Mon-Wed, class 3 to any weeknight, classes 4-5 anywhere. Misses return class_num=null + judged=false — fall back to LLM judgment or default to class 5.",
  risk: 'read',
  required_capabilities: [],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const norm = input.ingredients
      .map((s) => s.toLowerCase().trim())
      .slice()
      .sort()
      .join('|');
    return `get_ingredient_class:${norm.slice(0, 200)}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    const results: z.infer<typeof Match>[] = [];
    for (const ing of input.ingredients) {
      const hit = classify(ing);
      if (hit) {
        results.push({
          ingredient: ing,
          class_num: hit.class_num,
          description: hit.description,
          matched_term: hit.matched,
          judged: true,
        });
      } else {
        results.push({
          ingredient: ing,
          class_num: null,
          description: null,
          matched_term: null,
          judged: false,
        });
      }
    }
    const misses = results.filter((r) => !r.judged).length;
    const hint =
      misses === 0
        ? 'All ingredients classified. Schedule low class numbers (1-2) earlier in the week.'
        : `${misses} ingredient(s) unmatched — judge each as class 1 (≤2d), 2 (≤4d), 3 (≤7d), 4 (≤14d), or 5 (pantry), or default to 5.`;
    return { results, hint };
  },
};
