/**
 * update_market_themes — Vivian's chat-time editor for her theme universes.
 *
 * `config/market-themes.yaml` was hand-edit-only; this lets "add OKLO to my
 * power theme" / "drop SOUN from ai_software" / "start a quantum theme" happen
 * in conversation. The connector reads the file fresh on every screen, so an
 * edit is live on the next `momentum_screen` — no restart, no reload hook.
 *
 * Edits are SURGICAL text splices, not a YAML Document round-trip: the round-
 * trip reflows the folded `description:` blocks and the inline ticker lists
 * (verified), which would mangle every theme. add/remove rewrite exactly the
 * one `tickers: [...]` line; add_theme appends one block at the end. The result
 * is re-validated against the themes schema before it's written — a splice
 * that produces an invalid file fails closed.
 */
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { THEMES_PATH, SYMBOL_RE, load_market_themes } from '@connectors/market_data';

// NOTE: no `.regex()` on these — a tool input_schema becomes a GBNF grammar on
// the interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
// and SILENTLY disables the whole tool grammar (length bounds + `.transform`
// are fine — only a `pattern` triggers it). The snake_case / ticker shape is
// validated in execute() and returned as a typed no-op note.
const THEME_ID_RE = /^[a-z0-9_]{2,40}$/;
const ThemeIdSchema = z.string().min(2).max(40);
const SymbolSchema = z
  .string()
  .min(1)
  .max(12)
  .transform((s) => s.toUpperCase());

const InputSchema = z.object({
  action: z.enum(['add_ticker', 'remove_ticker', 'add_theme']),
  theme: ThemeIdSchema.describe('The theme universe id (snake_case).'),
  symbol: SymbolSchema.optional().describe(
    'Ticker to add/remove (required for add_ticker / remove_ticker).',
  ),
  label: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe('Short display name (required for add_theme).'),
  description: z
    .string()
    .max(400)
    .optional()
    .describe('One-liner read when choosing the universe (add_theme).'),
  tickers: z
    .array(SymbolSchema)
    .max(40)
    .optional()
    .describe('Initial tickers for a new theme (add_theme).'),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  theme: z.string(),
  tickers_after: z.array(z.string()),
  themes_total: z.number(),
  /** Populated on a no-op / refusal (theme missing, ticker already present…). */
  note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function fail(action: string, theme: string, note: string): Output {
  return { ok: false, action, theme, tickers_after: [], themes_total: 0, note };
}

/** Index range [start, end) of the YAML block whose 2-space header is `theme`. */
function theme_block(lines: string[], theme: string): { start: number; end: number } | null {
  const header = new RegExp(`^  ${theme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`);
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    // A theme block ends at the next line indented <= 2 (next theme / EOF).
    const indent = (l.match(/^(\s*)/)?.[1] ?? '').length;
    if (indent <= 2) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Rewrite the single inline `tickers: [...]` line within a theme's block. */
function splice_tickers(
  src: string,
  theme: string,
  mutate: (current: string[]) => string[] | { error: string },
): { next: string; tickers_after: string[] } | { error: string } {
  const lines = src.split('\n');
  const block = theme_block(lines, theme);
  if (!block) return { error: `theme '${theme}' not found` };
  let ti = -1;
  for (let i = block.start + 1; i < block.end; i++) {
    if (/^\s+tickers:\s*\[.*\]\s*$/.test(lines[i] ?? '')) {
      ti = i;
      break;
    }
  }
  if (ti < 0) {
    return {
      error: `theme '${theme}' has no inline \`tickers: [..]\` line — edit it by hand`,
    };
  }
  const line = lines[ti] ?? '';
  const indent = line.match(/^(\s*)/)?.[1] ?? '    ';
  const inner = line.replace(/^\s+tickers:\s*\[(.*)\]\s*$/, '$1');
  const current = inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const mutated = mutate(current);
  if (!Array.isArray(mutated)) return { error: mutated.error };
  lines[ti] = `${indent}tickers: [${mutated.join(', ')}]`;
  return { next: lines.join('\n'), tickers_after: mutated };
}

export function make_update_market_themes(): Tool<Input, Output> {
  return {
    name: 'update_market_themes',
    description:
      'Edit your market theme universes (config/market-themes.yaml) in chat. ' +
      "`add_ticker` / `remove_ticker` change a theme's ticker list; `add_theme` " +
      'starts a new universe (needs `label`, optional `description` + initial ' +
      '`tickers`). The change is live on your next momentum_screen — no restart. ' +
      'Use this when Jasper says "add OKLO to the power theme" or "track a quantum ' +
      'basket." It does not buy or sell anything; it only curates what you screen.',
    risk: 'write_internal',
    required_capabilities: ['write_market_radar'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `update_market_themes:${input.action}:${input.theme}:${input.symbol ?? ''}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      // Shape checks moved off the schema (a regex `pattern` silently disables
      // the 9B's tool grammar). Validate here; surface a typed no-op note.
      if (!THEME_ID_RE.test(input.theme)) {
        return fail(
          input.action,
          input.theme,
          `theme id "${input.theme}" must be snake_case — lowercase letters, ` +
            `digits, and underscore, 2-40 chars (e.g. "power_nuclear").`,
        );
      }
      if (input.symbol !== undefined && !SYMBOL_RE.test(input.symbol)) {
        return fail(input.action, input.theme, `"${input.symbol}" is not a valid ticker symbol.`);
      }
      const bad_ticker = (input.tickers ?? []).find((t) => !SYMBOL_RE.test(t));
      if (bad_ticker !== undefined) {
        return fail(input.action, input.theme, `"${bad_ticker}" is not a valid ticker symbol.`);
      }

      const path = THEMES_PATH();
      const loaded = await load_market_themes();
      if ('error' in loaded) return fail(input.action, input.theme, loaded.error);
      const themes = loaded.themes;
      const exists = Object.prototype.hasOwnProperty.call(themes, input.theme);

      let src: string;
      try {
        src = readFileSync(path, 'utf8');
      } catch (err) {
        return fail(input.action, input.theme, `themes file unreadable: ${(err as Error).message}`);
      }

      let next: string;
      let tickers_after: string[];

      if (input.action === 'add_theme') {
        if (exists) {
          return fail(input.action, input.theme, `theme '${input.theme}' already exists — use add_ticker`);
        }
        if (!input.label) {
          return fail(input.action, input.theme, 'add_theme needs a label');
        }
        tickers_after = input.tickers ?? [];
        const desc = (input.description ?? '').trim();
        const block =
          `\n  ${input.theme}:\n` +
          `    label: ${input.label}\n` +
          (desc ? `    description: ${desc}\n` : '') +
          `    tickers: [${tickers_after.join(', ')}]\n`;
        next = src.replace(/\s*$/, '\n') + block;
      } else {
        if (!exists) {
          const known = Object.keys(themes).slice(0, 20).join(', ');
          return fail(input.action, input.theme, `theme '${input.theme}' not found. Known themes: ${known}`);
        }
        if (!input.symbol) {
          return fail(input.action, input.theme, `${input.action} needs a symbol`);
        }
        const sym = input.symbol;
        const spliced = splice_tickers(src, input.theme, (current) => {
          if (input.action === 'add_ticker') {
            if (current.includes(sym)) return { error: `${sym} already in ${input.theme}` };
            return [...current, sym];
          }
          if (!current.includes(sym)) return { error: `${sym} not in ${input.theme}` };
          const after = current.filter((t) => t !== sym);
          if (after.length === 0) return { error: `refusing to empty ${input.theme} — a theme needs at least one ticker` };
          return after;
        });
        if ('error' in spliced) return fail(input.action, input.theme, spliced.error);
        next = spliced.next;
        tickers_after = spliced.tickers_after;
      }

      // Re-validate the whole file before writing — a splice that breaks the
      // schema (or the connector's strict read) must never land.
      const check = parseYaml(next) as unknown;
      const valid =
        !!check &&
        typeof check === 'object' &&
        'themes' in (check as Record<string, unknown>);
      if (!valid) {
        return fail(input.action, input.theme, 'edit produced an invalid themes file — aborted, nothing written');
      }

      writeFileSync(path, next, 'utf8');

      const themes_total = input.action === 'add_theme'
        ? Object.keys(themes).length + 1
        : Object.keys(themes).length;
      return { ok: true, action: input.action, theme: input.theme, tickers_after, themes_total };
    },
  };
}

export function create(_deps: ToolDeps): Tool {
  return make_update_market_themes() as Tool;
}
