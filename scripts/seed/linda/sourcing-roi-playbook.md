# Sourcing ROI playbook — what to buy, what to skip, and what each flip is really worth

Selling well starts before the listing — at the moment you decide whether to
acquire an item at all. This is the front of the funnel most resellers ignore:
they price the sale but never price the *buy*. The seller's own ledger
(tracked sales: cost basis, sale price, days-to-sell) is the dataset that
makes sourcing a decision instead of a gamble.

## The only number that matters at the buy: net ROI per day of effort

A flip isn't "I paid $8, sold for $40, so 5×." It's:

`net profit = sale_price − platform_fee − cost_basis − shipping`
`ROI = net_profit / cost_basis`
`velocity = net_profit / days_held`

A $40 item you paid $8 for that sits 90 days is worse than a $25 item you paid
$6 for that moves in 5 days. **Velocity beats multiple.** Cash you can
redeploy is worth more than a fat margin you're storing in a closet. When you
advise sourcing, weight both: a high-ROI / low-velocity item is fine
occasionally, but a portfolio of them is a storage unit, not a business.

## The buy ceiling: price the buy off SOLD comps, working backwards

Before paying for anything, run the same sold-comp research you'd run to price
a listing, then work backwards to a maximum buy price:

`max_buy = (realistic_sold_price × (1 − platform_fee%)) − target_net − shipping`

Example: a jacket whose condition-matched SOLD comps cluster at $45, sold on
Poshmark (20% fee), where you want at least $20 net:
`max_buy = ($45 × 0.80) − $20 = $36 − $20 = $16`. Pay $16 or less or walk.
**Discipline at the buy is where resale profit is actually made** — you can't
out-list a bad purchase price.

## What to source MORE of — read it off the seller's own history

Once there's a ledger, the answer to "what should I buy?" stops being
guesswork. Look at the seller's tracked sales and rank categories/brands by:

1. **Sell-through** (did it sell at all, vs. sit and get pulled),
2. **Velocity** (days-to-sell — fast movers free up cash and attention),
3. **Net ROI** (multiple after fees and cost).

The pattern that almost always emerges: a handful of brands/categories carry
the business. Those are the **buy-more list**. The long tail of
slow/low-margin items is the **stop-buying list** — even if individual flips
felt good, they cost time and shelf space the winners deserved.

Use `query_sales_history` (optionally filtered by category) to ground this:
"Your best flips this quarter were Patagonia (avg 3.2× net, 6 days) and Le
Creuset (2.8×, 9 days); fast-fashion averaged 1.1× and 34 days — I'd stop
buying it and put that cash into more of the first two."

## Evergreen high-ROI categories (the reseller's bread and butter)

These tend to hold value secondhand and reward keyword-savvy listings —
useful priors before the seller has enough history of her own:

- **Outdoor / technical apparel & gear** — Patagonia, Arc'teryx, The North
  Face, Carhartt. Durable, branded, searched by name.
- **Quality cookware & home** — Le Creuset, Staub, cast iron, Pyrex (vintage
  patterns), KitchenAid attachments. Heavy = favors local/FB (no shipping, no
  fee).
- **Discontinued / collectible lines** — a discontinued pattern, colorway, or
  model with a real following commands a premium and justifies a higher ask;
  the rarity beat in the listing is what earns it.
- **Brand-name footwear, bags, denim** in good condition — searchable,
  shippable, strong sold-comp data.
- **Tools, small electronics, media** with model numbers — model-number
  searches convert; sold comps are precise.

## What to be wary of sourcing

- **Fast fashion** (Shein, H&M, Forever 21) — low resale value, slow,
  margin eaten by fees and shipping.
- **Anything you can't condition-grade honestly** — a flaw you miss comes back
  as a return and a hit to standing.
- **Bulky low-value items that need shipping** — shipping cost + fee can erase
  the margin; only worth it as local/FB pickup.
- **Trend-chasing at peak** — by the time a trend is obvious, sold prices are
  already softening; the comps tell you, the hype doesn't.

## The loop

Source against the buy ceiling → list well → track the outcome → let the
ledger re-rank the buy-more / stop-buying lists → source smarter next time.
The whole point of tracking sales is to close this loop: every sale should
make the next *purchase* better, not just the next listing.
