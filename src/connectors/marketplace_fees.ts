/**
 * Marketplace seller-fee schedule — the data behind Linda's net-proceeds
 * and profit numbers.
 *
 * Verified June 2026 against each platform's official fee page (cited
 * below). Fees DO change (Poshmark's 2024 reversal, Mercari's Jan-2025
 * re-introduction, eBay's 2026 apparel bump), so:
 *   - the HUMAN source of truth is Linda's seeded `marketplace-fees`
 *     library note (authored alongside this, with the same numbers + the
 *     official URLs to re-verify);
 *   - this module is the MACHINE estimate used only to fill in `fees`
 *     when the seller didn't record an exact number, so the office can
 *     show a realistic net instead of pretending fees are zero.
 * When a platform changes its schedule, update both here and the note.
 *
 * Sources (June 2026):
 *   eBay      — https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822
 *   Poshmark  — https://support.poshmark.com/s/article/297755057
 *   Mercari   — https://www.mercari.com/us/help_center/article/169/
 *   Facebook  — https://www.facebook.com/business/help (Marketplace selling fees)
 *   Depop     — https://news.depop.com/.../depop-removes-selling-fees-in-the-united-states/
 */

export type FeePlatform = 'ebay' | 'poshmark' | 'facebook' | 'mercari' | 'depop' | 'other';

export interface FeeEstimate {
  /** Estimated seller fee in USD for a sale at `sale_price`. */
  fee: number;
  /** One-line, human-readable description of the rate applied. */
  basis: string;
}

/** Apparel categories take eBay's higher 15.3% clothing/accessories rate. */
const APPAREL_RE =
  /cloth|apparel|jacket|coat|dress|shirt|blouse|sweater|shoe|footwear|boot|sneaker|bag|purse|accessor|hat|scarf|jean|pant|skirt/i;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Estimate the seller fee a marketplace takes on a sale. Used to fill in
 * an unrecorded `fees` value when computing profit — the seller can always
 * record the exact fee to override the estimate.
 *
 * Facebook is local-pickup-only in Linda's workflow (0% fee); pass a
 * different platform if a shipped sale needs the 5% shipped rate.
 */
export function estimate_platform_fee(
  platform: FeePlatform | null | undefined,
  sale_price: number,
  opts: { category?: string | null } = {},
): FeeEstimate {
  if (!platform || sale_price <= 0) return { fee: 0, basis: 'no fee data' };
  switch (platform) {
    case 'ebay': {
      // Final value fee on the sale price + a fixed per-order fee. Apparel
      // (Linda's bread and butter) is the higher 15.3% band as of 2026.
      const rate = opts.category && APPAREL_RE.test(opts.category) ? 0.153 : 0.136;
      const per_order = sale_price > 10 ? 0.4 : 0.3;
      const fee = round2(sale_price * rate + per_order);
      return { fee, basis: `eBay ${Math.round(rate * 100)}% + $${per_order.toFixed(2)} per order` };
    }
    case 'poshmark': {
      // $2.95 flat under $15, else a flat 20%.
      if (sale_price < 15) return { fee: 2.95, basis: 'Poshmark $2.95 flat (under $15)' };
      return { fee: round2(sale_price * 0.2), basis: 'Poshmark 20%' };
    }
    case 'mercari':
      return { fee: round2(sale_price * 0.1), basis: 'Mercari 10%' };
    case 'depop':
      // Selling fee removed for US sellers (2024); payment processing only.
      return { fee: round2(sale_price * 0.033 + 0.45), basis: 'Depop 3.3% + $0.45 processing' };
    case 'facebook':
      // Local pickup is free — Linda's FB listings are local-only.
      return { fee: 0, basis: 'Facebook local pickup (no fee)' };
    case 'other':
    default:
      return { fee: 0, basis: 'no fee data' };
  }
}
