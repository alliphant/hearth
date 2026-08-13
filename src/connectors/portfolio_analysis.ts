/**
 * portfolio_analysis — Vivian's portfolio-aware operational tools
 * (2026-05-30).
 *
 * These are the highest-Sharpe activities available to a household,
 * per the evidence-based finance literature: tax-loss harvesting,
 * rebalancing, expense-ratio audits, concentration-risk monitoring.
 * Operational edges (no prediction required) that compound silently
 * over decades.
 *
 * Why two tools shipped now, not the whole six I proposed:
 *
 *   - `concentration_risk` — pure math over an input holdings list.
 *     Works today; works identically when Plaid lands.
 *   - `audit_expense_ratios` — needs an ER lookup. Ships with a
 *     static table of the ~50 most common funds + ETFs (Vanguard /
 *     iShares / Fidelity / Schwab) so we don't depend on a live API
 *     and the ER answer is fast + stable.
 *
 * Deferred until Plaid is wired (Tier 1 PLAN entry: cost & friction
 * audit needs real account integration):
 *
 *   - `tax_loss_harvest_scan` — needs cost basis + current prices
 *   - `rebalance_drift_check` — needs allocation + targets
 *   - `earnings_calendar_for_holdings` — needs holdings + earnings API
 *   - `insider_signal_for_holdings` — needs holdings + Form 4 scraping
 *
 * All four shape-the-same as `audit_expense_ratios` (accept holdings
 * inline OR pull from Plaid when wired) and will land in a follow-up.
 *
 * Both tools `read` risk, gated by `read_finance_signals`.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';

// ── concentration_risk ──────────────────────────────────────────────────────

const HoldingSchema = z.object({
  symbol: z.string().min(1).max(16).describe(
    'Ticker or fund symbol (e.g. "AAPL", "VTI", "BRK.B"). For non-public holdings (private equity, real estate), use a short stable identifier.',
  ),
  market_value: z.number().nonnegative().describe(
    'Current market value of this position in dollars.',
  ),
  asset_class: z
    .enum(['equity', 'etf', 'mutual_fund', 'bond', 'cash', 'crypto', 'real_estate', 'other'])
    .default('equity'),
  sector: z.string().max(60).optional().describe(
    'Optional sector tag for sector concentration analysis (Technology, Financials, Healthcare, etc.). Omit for ETFs/funds/cash.',
  ),
});

const ConcentrationInputSchema = z.object({
  holdings: z.array(HoldingSchema).min(1).max(500),
  single_position_threshold_pct: z
    .number()
    .min(0.5)
    .max(50)
    .default(5)
    .describe('Flag any single position above this percentage of total portfolio.'),
  sector_threshold_pct: z
    .number()
    .min(5)
    .max(80)
    .default(25)
    .describe('Flag any sector exposure above this percentage.'),
});

const FlagSchema = z.object({
  kind: z.enum(['single_position', 'sector', 'asset_class']),
  label: z.string(),
  current_pct: z.number(),
  threshold_pct: z.number(),
  market_value: z.number(),
  severity: z.enum(['watch', 'high', 'critical']),
});

const ConcentrationOutputSchema = z.object({
  total_value: z.number(),
  position_count: z.number(),
  flags: z.array(FlagSchema),
  top_5_concentration_pct: z.number().describe(
    'Sum of top 5 positions as percentage of total. Above 50% is structurally concentrated; rule of thumb is <30% for a diversified retail portfolio.',
  ),
  guidance: z.string(),
});

type ConcentrationIn = z.infer<typeof ConcentrationInputSchema>;
type ConcentrationOut = z.infer<typeof ConcentrationOutputSchema>;

function severity_for(current_pct: number, threshold_pct: number): 'watch' | 'high' | 'critical' {
  const ratio = current_pct / threshold_pct;
  if (ratio >= 3) return 'critical';
  if (ratio >= 1.5) return 'high';
  return 'watch';
}

export const concentration_risk: Tool<ConcentrationIn, ConcentrationOut> = {
  name: 'concentration_risk',
  description:
    "Audit a portfolio for single-position and sector concentration risk. Pure math — no predictions. Returns flags for any position above single_position_threshold_pct (default 5%) and any sector above sector_threshold_pct (default 25%), plus the top-5 concentration ratio (>50% is structurally concentrated, <30% is diversified for retail). Accept holdings inline today; will accept Plaid-linked holdings when that integration lands. Use this on any portfolio review pass.",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: ConcentrationInputSchema,
  output_schema: ConcentrationOutputSchema,

  idempotency_key(input) {
    // The hash uses symbols + values rounded to dollars so the same
    // portfolio shape collapses across small fluctuations.
    const sig = input.holdings
      .map((h) => `${h.symbol}:${Math.round(h.market_value)}`)
      .sort()
      .join('|');
    return `concentration:${sig.slice(0, 200)}:${input.single_position_threshold_pct}:${input.sector_threshold_pct}`;
  },

  async execute(input: ConcentrationIn, _ctx: ToolContext): Promise<ConcentrationOut> {
    const total = input.holdings.reduce((acc, h) => acc + h.market_value, 0);
    if (total <= 0) {
      return {
        total_value: 0,
        position_count: input.holdings.length,
        flags: [],
        top_5_concentration_pct: 0,
        guidance: 'Portfolio total is zero or negative; no concentration analysis possible.',
      };
    }
    const flags: z.infer<typeof FlagSchema>[] = [];

    // Single-position concentration.
    for (const h of input.holdings) {
      const pct = (h.market_value / total) * 100;
      if (pct > input.single_position_threshold_pct) {
        flags.push({
          kind: 'single_position',
          label: h.symbol,
          current_pct: Math.round(pct * 10) / 10,
          threshold_pct: input.single_position_threshold_pct,
          market_value: h.market_value,
          severity: severity_for(pct, input.single_position_threshold_pct),
        });
      }
    }

    // Sector concentration (only equity / etf holdings carry sectors today).
    const by_sector = new Map<string, number>();
    for (const h of input.holdings) {
      if (!h.sector) continue;
      by_sector.set(h.sector, (by_sector.get(h.sector) ?? 0) + h.market_value);
    }
    for (const [sector, value] of by_sector) {
      const pct = (value / total) * 100;
      if (pct > input.sector_threshold_pct) {
        flags.push({
          kind: 'sector',
          label: sector,
          current_pct: Math.round(pct * 10) / 10,
          threshold_pct: input.sector_threshold_pct,
          market_value: value,
          severity: severity_for(pct, input.sector_threshold_pct),
        });
      }
    }

    // Top-5 concentration.
    const top_5 = input.holdings
      .slice()
      .sort((a, b) => b.market_value - a.market_value)
      .slice(0, 5)
      .reduce((acc, h) => acc + h.market_value, 0);
    const top_5_pct = (top_5 / total) * 100;

    const guidance =
      flags.length === 0
        ? 'No concentration flags. Portfolio shape is within configured thresholds.'
        : `${flags.length} flag(s). Each flag is structural exposure to evaluate against the household's tolerance — not a sell signal. Concentration risk is the cost of conviction; the question is whether the conviction is informed.`;

    flags.sort((a, b) => b.current_pct - a.current_pct);

    return {
      total_value: Math.round(total),
      position_count: input.holdings.length,
      flags,
      top_5_concentration_pct: Math.round(top_5_pct * 10) / 10,
      guidance,
    };
  },
};

// ── audit_expense_ratios ────────────────────────────────────────────────────

/**
 * Static ER table for the most common funds + ETFs a US retail
 * portfolio holds. Numbers are public, updated annually; the household
 * NAS will be re-running this analysis monthly so a static table avoids
 * a live data dependency for the v1 ship. When live data lands (paid
 * Morningstar / Refinitiv feed), the table becomes the fallback for
 * unrecognized symbols.
 *
 * Source: each fund's official prospectus / product page as of 2026-05.
 * Numbers in basis points (1bp = 0.01%).
 */
const EXPENSE_RATIOS_BP: Record<string, { name: string; er_bp: number; exposure: string }> = {
  // ── Vanguard (low-cost benchmark) ──
  VTI: { name: 'Vanguard Total Stock Market ETF', er_bp: 3, exposure: 'US total market' },
  VOO: { name: 'Vanguard S&P 500 ETF', er_bp: 3, exposure: 'US large-cap S&P 500' },
  VXUS: { name: 'Vanguard Total International Stock ETF', er_bp: 5, exposure: 'ex-US developed + emerging' },
  BND: { name: 'Vanguard Total Bond Market ETF', er_bp: 3, exposure: 'US aggregate bond' },
  BNDX: { name: 'Vanguard Total International Bond ETF', er_bp: 7, exposure: 'ex-US bond, USD-hedged' },
  VTV: { name: 'Vanguard Value ETF', er_bp: 4, exposure: 'US large-cap value' },
  VUG: { name: 'Vanguard Growth ETF', er_bp: 4, exposure: 'US large-cap growth' },
  VB: { name: 'Vanguard Small-Cap ETF', er_bp: 5, exposure: 'US small-cap' },
  VWO: { name: 'Vanguard FTSE Emerging Markets ETF', er_bp: 8, exposure: 'emerging markets' },
  VEA: { name: 'Vanguard FTSE Developed Markets ETF', er_bp: 5, exposure: 'ex-US developed' },
  VTIAX: { name: 'Vanguard Total International Stock Index Admiral', er_bp: 9, exposure: 'ex-US (mutual fund)' },
  VTSAX: { name: 'Vanguard Total Stock Market Index Admiral', er_bp: 4, exposure: 'US total market (mutual fund)' },
  VBTLX: { name: 'Vanguard Total Bond Market Index Admiral', er_bp: 5, exposure: 'US aggregate bond (mutual fund)' },
  // ── iShares (BlackRock) ──
  ITOT: { name: 'iShares Core S&P Total US Stock Market ETF', er_bp: 3, exposure: 'US total market' },
  IVV: { name: 'iShares Core S&P 500 ETF', er_bp: 3, exposure: 'US large-cap S&P 500' },
  IXUS: { name: 'iShares Core MSCI Total International Stock ETF', er_bp: 7, exposure: 'ex-US total' },
  AGG: { name: 'iShares Core US Aggregate Bond ETF', er_bp: 3, exposure: 'US aggregate bond' },
  IEFA: { name: 'iShares Core MSCI EAFE ETF', er_bp: 7, exposure: 'ex-US developed' },
  IEMG: { name: 'iShares Core MSCI Emerging Markets ETF', er_bp: 9, exposure: 'emerging markets' },
  IJR: { name: 'iShares Core S&P Small-Cap ETF', er_bp: 6, exposure: 'US small-cap' },
  // ── Fidelity zero-cost lineup ──
  FZROX: { name: 'Fidelity ZERO Total Market Index Fund', er_bp: 0, exposure: 'US total market' },
  FZILX: { name: 'Fidelity ZERO International Index Fund', er_bp: 0, exposure: 'ex-US developed + emerging' },
  FXNAX: { name: 'Fidelity US Bond Index Fund', er_bp: 25, exposure: 'US aggregate bond' },
  FSKAX: { name: 'Fidelity Total Market Index Fund', er_bp: 1.5, exposure: 'US total market' },
  FTIHX: { name: 'Fidelity Total International Index Fund', er_bp: 6, exposure: 'ex-US' },
  // ── Schwab ──
  SCHB: { name: 'Schwab US Broad Market ETF', er_bp: 3, exposure: 'US total market' },
  SCHX: { name: 'Schwab US Large-Cap ETF', er_bp: 3, exposure: 'US large-cap' },
  SCHF: { name: 'Schwab International Equity ETF', er_bp: 6, exposure: 'ex-US developed' },
  SCHE: { name: 'Schwab Emerging Markets Equity ETF', er_bp: 11, exposure: 'emerging markets' },
  SCHZ: { name: 'Schwab US Aggregate Bond ETF', er_bp: 3, exposure: 'US aggregate bond' },
  // ── Higher-ER funds commonly held in legacy accounts ──
  AGTHX: { name: 'American Funds Growth Fund of America (A)', er_bp: 60, exposure: 'US large-cap growth (active)' },
  AIVSX: { name: 'American Funds Investment Co. of America (A)', er_bp: 56, exposure: 'US large-cap blend (active)' },
  ANCFX: { name: 'American Funds Fundamental Investors (A)', er_bp: 56, exposure: 'US large-cap blend (active)' },
  FCNTX: { name: 'Fidelity Contrafund', er_bp: 39, exposure: 'US large-cap growth (active)' },
  FXAIX: { name: 'Fidelity 500 Index Fund', er_bp: 1.5, exposure: 'US large-cap S&P 500' },
  // ── Money market / cash ──
  VMFXX: { name: 'Vanguard Federal Money Market Fund', er_bp: 11, exposure: 'cash equivalents' },
  SPAXX: { name: 'Fidelity Government Money Market', er_bp: 42, exposure: 'cash equivalents' },
};

// Same-exposure low-cost alternative recommendations. When a high-ER
// holding shares exposure with one of these, the audit suggests a swap
// AND quotes the dollar savings over 30 years.
const LOW_COST_BY_EXPOSURE: Record<string, string> = {
  'US total market': 'VTI / ITOT / FZROX',
  'US large-cap S&P 500': 'VOO / IVV / FXAIX',
  'US large-cap blend (active)': 'VTI / ITOT (passive equivalent)',
  'US large-cap growth (active)': 'VUG (passive equivalent)',
  'ex-US developed + emerging': 'VXUS / IXUS / FZILX',
  'ex-US developed': 'VEA / IEFA / SCHF',
  'emerging markets': 'VWO / IEMG / SCHE',
  'US aggregate bond': 'BND / AGG / FXNAX',
  'ex-US bond, USD-hedged': 'BNDX',
  'US small-cap': 'VB / IJR',
  'cash equivalents': 'VMFXX (Vanguard) or a 4%+ HYSA',
};

function compounding_savings_dollars(market_value: number, current_er_bp: number, target_er_bp: number, years = 30, growth_rate = 0.07): number {
  // Future value differential: principal grows at (g - er) each year
  // for `years` years. We compute FV at both ERs and return the gap.
  const fv_at = (er_bp: number) =>
    market_value * Math.pow(1 + growth_rate - er_bp / 10_000, years);
  return Math.round(fv_at(target_er_bp) - fv_at(current_er_bp));
}

const ExpenseAuditInputSchema = z.object({
  holdings: z.array(HoldingSchema).min(1).max(500),
  high_er_threshold_bp: z
    .number()
    .min(5)
    .max(200)
    .default(25)
    .describe('Flag any fund with ER above this. 25bp is generous; 10bp is strict.'),
  years_horizon: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(30)
    .describe('Compounding horizon for the savings calculation.'),
  growth_rate: z
    .number()
    .min(0)
    .max(0.2)
    .default(0.07)
    .describe('Nominal annual return assumption for the savings model. 7% is the long-run US equity median, adjust for portfolio composition.'),
});

const ExpenseFindingSchema = z.object({
  symbol: z.string(),
  name: z.string().nullable(),
  exposure: z.string().nullable(),
  current_er_bp: z.number().nullable(),
  market_value: z.number(),
  flagged: z.boolean(),
  suggested_swap: z.string().nullable(),
  suggested_swap_er_bp: z.number().nullable(),
  annual_fee_drag_dollars: z.number().nullable(),
  compounded_savings_dollars: z.number().nullable(),
});

const ExpenseAuditOutputSchema = z.object({
  holdings_audited: z.number(),
  holdings_recognized: z.number(),
  holdings_flagged: z.number(),
  total_annual_fee_drag_dollars: z.number(),
  total_compounded_savings_dollars: z.number(),
  findings: z.array(ExpenseFindingSchema),
  guidance: z.string(),
});

type ExpenseAuditIn = z.infer<typeof ExpenseAuditInputSchema>;
type ExpenseAuditOut = z.infer<typeof ExpenseAuditOutputSchema>;

export const audit_expense_ratios: Tool<ExpenseAuditIn, ExpenseAuditOut> = {
  name: 'audit_expense_ratios',
  description:
    "Audit a portfolio's expense ratios against a curated table of low-cost alternatives. For each holding above high_er_threshold_bp (default 25), surface the annual fee drag in dollars AND the compounded savings over the configured horizon (default 30 years at 7%) if swapped to a same-exposure low-cost equivalent. This is the highest-Sharpe activity available to a household — catching a 0.50% ER on a $500K position when a 0.03% ETF exists is ~$140K saved over 30 years. Accepts holdings inline today; will accept Plaid-linked holdings when that integration lands.",
  risk: 'read',
  required_capabilities: ['read_finance_signals'],
  input_schema: ExpenseAuditInputSchema,
  output_schema: ExpenseAuditOutputSchema,

  idempotency_key(input) {
    const sig = input.holdings
      .map((h) => `${h.symbol}:${Math.round(h.market_value)}`)
      .sort()
      .join('|');
    return `expense_audit:${sig.slice(0, 200)}:${input.high_er_threshold_bp}:${input.years_horizon}`;
  },

  async execute(input: ExpenseAuditIn, _ctx: ToolContext): Promise<ExpenseAuditOut> {
    const findings: z.infer<typeof ExpenseFindingSchema>[] = [];
    let recognized = 0;
    let flagged = 0;
    let total_annual_drag = 0;
    let total_compounded_savings = 0;

    for (const h of input.holdings) {
      const meta = EXPENSE_RATIOS_BP[h.symbol.toUpperCase()];
      if (!meta) {
        findings.push({
          symbol: h.symbol,
          name: null,
          exposure: null,
          current_er_bp: null,
          market_value: h.market_value,
          flagged: false,
          suggested_swap: null,
          suggested_swap_er_bp: null,
          annual_fee_drag_dollars: null,
          compounded_savings_dollars: null,
        });
        continue;
      }
      recognized += 1;
      const annual_drag = (meta.er_bp / 10_000) * h.market_value;
      const above_threshold = meta.er_bp > input.high_er_threshold_bp;
      let suggested_swap: string | null = null;
      let suggested_swap_er_bp: number | null = null;
      let compounded_savings: number | null = null;
      if (above_threshold) {
        flagged += 1;
        suggested_swap = LOW_COST_BY_EXPOSURE[meta.exposure] ?? null;
        // Use the lowest ER from the swap symbols we know.
        if (suggested_swap) {
          const tickers = suggested_swap.split(/\s*\/\s*/);
          const er_bps = tickers
            .map((t) => EXPENSE_RATIOS_BP[t.trim().toUpperCase()]?.er_bp)
            .filter((v): v is number => typeof v === 'number');
          if (er_bps.length > 0) {
            suggested_swap_er_bp = Math.min(...er_bps);
            compounded_savings = compounding_savings_dollars(
              h.market_value,
              meta.er_bp,
              suggested_swap_er_bp,
              input.years_horizon,
              input.growth_rate,
            );
          }
        }
      }
      total_annual_drag += annual_drag;
      if (compounded_savings) total_compounded_savings += compounded_savings;
      findings.push({
        symbol: h.symbol,
        name: meta.name,
        exposure: meta.exposure,
        current_er_bp: meta.er_bp,
        market_value: h.market_value,
        flagged: above_threshold,
        suggested_swap,
        suggested_swap_er_bp,
        annual_fee_drag_dollars: Math.round(annual_drag),
        compounded_savings_dollars: compounded_savings,
      });
    }

    findings.sort((a, b) => (b.compounded_savings_dollars ?? 0) - (a.compounded_savings_dollars ?? 0));

    const unrecognized = input.holdings.length - recognized;
    const guidance =
      flagged === 0
        ? `No high-ER flags across ${recognized} recognized holding(s). ${unrecognized > 0 ? `${unrecognized} symbol(s) weren't in the curated table — pull their ER manually from the prospectus and re-run if you want them audited.` : ''}`
        : `${flagged} flagged holding(s). Total annual fee drag: $${Math.round(total_annual_drag).toLocaleString()}. Compounded over ${input.years_horizon} years at ${(input.growth_rate * 100).toFixed(1)}%: $${Math.round(total_compounded_savings).toLocaleString()} saved if swapped to the suggested low-cost equivalents. Swaps preserve the same exposure; the only thing being moved is the fee. ${unrecognized > 0 ? `${unrecognized} symbol(s) weren't in the curated table.` : ''}`;

    return {
      holdings_audited: input.holdings.length,
      holdings_recognized: recognized,
      holdings_flagged: flagged,
      total_annual_fee_drag_dollars: Math.round(total_annual_drag),
      total_compounded_savings_dollars: Math.round(total_compounded_savings),
      findings,
      guidance,
    };
  },
};

export function create(_deps: import('@core/tool_deps').ToolDeps): Tool[] {
  return [concentration_risk as Tool, audit_expense_ratios as Tool];
}
