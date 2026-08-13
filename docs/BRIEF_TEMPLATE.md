# BRIEF_TEMPLATE — Kate's brief tone and priority order

This document is the canonical reference for Kate's four-times-daily
brief (`morning` / `midday` / `evening` / `overnight`). It governs:

- what goes in `noticed` vs. `attention_today` vs. `watching`
- the priority order across all sections
- the surface-tier classification for candidate items
- length budgets and item caps
- exceptions where Hearth-internal items DO belong on the hero card

The brief renders as the hero card on the iOS dashboard. It is the
first thing Jasper reads on every cold launch. The rule of thumb:
**a brief should read as "what matters in my life today," not "what's
happening inside the specialist autonomy machinery."**

The brief schema (`Brief` / `BriefSections`) is consumed by the iOS
client unchanged — do not modify the shape. The priority order is
enforced by the generator prompt in `src/core/deliberation.ts`
(`brief_section`) and by Kate's `tools_for_deliberation` set in
`config/specialists/kate.yaml`.

---

## Priority order (life first)

Every section follows the same priority for what goes first. Lead
sentences and lead items come from the top of this list.

1. **Weather worth acting on.** Precip windows, temperature extremes,
   air-quality changes, sunset times when relevant. One sentence with
   the action implication baked in.
   - "Storms late afternoon — morning's the window for the deck repair."
   - "Hard freeze tonight; drag the patio plants in before sunset."
2. **Household state.** Pet medical (Anya), household systems Iris
   flags (CO2, indoor temp, security, EV charge when it constrains
   plans), appliance / delivery events.
   - "Eddie's refill pushed two weeks. Current supply: 8 days."
   - "Ioniq's at 38%, charger free after 9p."
3. **Life-side calendar.** Today + tomorrow's events, conflicts,
   anything Brigid or Vivian noticed that Jasper should know.
   - "Calendar's clear after 3p. Coffee with M at 10a — leave 9:45."
4. **Promised follow-ups landing today.** Things Hearth committed
   to surface back when ready (via `promise_followup`).
   - "You asked me to dig into the EV insurance question last week —
      I've got Vivian's writeup ready."
5. **Hearth-internal autonomy.** Trainer's binding proposals,
   Mariah's program-management scans, signature-graduation
   candidates, authenticity scores, persona tuning, connector
   affordance audits.
   - **DEFAULT: omit from `noticed` and `attention_today`.**
   - Lives in `watching` (briefly) or `ready_for_review` (as
     individual proposals). See exceptions below.

---

## Surface tiers

Classify each candidate item before placing it. Only tiers 1–2
appear in `attention_today`; tiers 3–4 go to `watching` or get
dropped.

| Tier | Name                       | Where it goes                    |
|------|----------------------------|----------------------------------|
| 1    | life                       | `noticed` (lead), `attention_today` |
| 2    | meta-requires-approval     | `attention_today` (with exception) |
| 3    | meta-watch                 | `watching` and/or `ready_for_review` |
| 4    | meta-omit                  | dropped                          |

The generator prompt asks Kate to mentally classify every candidate
before rendering. The classification is not part of the brief
schema — it's a generation-time discipline.

---

## Exceptions — Hearth-meta on the hero card

Two narrow cases where a Hearth-internal item DOES belong in
`attention_today`:

1. **A proposal that requires Jasper's approval AND has a real-world
   side effect on his life.** Vivian approving a charge, Brigid
   booking an actual reservation, Iris toggling home automation in
   a meaningful way. Surface as Priority 2 or 3 in placement order.
   - Pure Hearth-meta proposals (Trainer persona tuning, Beatrice
     connector improvements, Mariah roster alignment) DO NOT
     qualify. They go to `ready_for_review` or `watching`.
2. **A specialist's authenticity score crossing a threshold
   downward** — the signal-strength bar going amber or red. Brief
   one-line mention; Jasper needs to know if Vivian or Anya is
   drifting. Routine score updates don't qualify.

---

## Caps and length budget

| Field              | Cap                                       |
|--------------------|-------------------------------------------|
| `noticed`          | 2–4 short sentences; lead is life-side    |
| `attention_today`  | HARD CAP 4 items                          |
| - `title`          | ≤ 60 chars                                |
| - `body`           | ≤ 200 chars                               |
| `ready_for_review` | no cap; full one-line summaries           |
| `watching`         | 1–3 short sentences                       |

If a 5th life item exists, push it to `watching`. If a 5th
Hearth-meta item exists, omit it.

**Total body across all sections targets ~600 chars; hard cap
~1000.** If you're over, cut Hearth-meta first, then prose padding.

---

## Verified life-context (load-bearing anti-hallucination layer)

Kate's brief used to hallucinate values like "Ioniq 5 is at 97%"
when the SoC entity wasn't even configured — she'd recall numbers
from memory because her prompt didn't have any live readings to
cite. The fix is structural: a pre-pumped `verified_life_context`
block, injected into her deliberation prompt at every report slot
BEFORE the LLM turn runs.

`src/core/brief_context.ts` is the puller. At each report slot it
reads a fixed set of HA entities and produces a shaped object:

```json
{
  "ev": {
    "soc_percent": { "status": "fresh", "source_entity": "sensor.ioniq5_state_of_charge", "value": "73", "unit": "%", "ts_read": "..." },
    "range_miles": { "status": "fresh", "source_entity": "sensor.ioniq5_range", "value": "212", "unit": "mi", "ts_read": "..." }
  },
  "weather": {
    "forecast": { "status": "fresh", ... },
    "precip_probability_today": { "status": "unavailable", "source_entity": null, "reason": "not configured (set env HEARTH_BRIEF_PRECIP_PROB_TODAY_ENTITY ...)" },
    "indoor_temp": { ... }
  },
  "calendar": {
    "status": "fresh",
    "today": [{ "summary": "...", "start": "...", ... }],
    "tomorrow": [...],
    "source_entities": ["calendar.personal"]
  }
}
```

Unconfigured entities and HA errors surface as explicit
`status: 'unavailable'` with a `reason`. The brief prompt then
forbids Kate from filling those gaps from memory — she either
cites the verified value, says "no current reading on X," or
omits the line. Saying nothing is correct when there's nothing
to cite.

### Configuring the puller

Entity IDs live in environment variables (see `.env.example`):

| Env var                                     | What it reads                          |
|---------------------------------------------|----------------------------------------|
| `IONIQ5_SOC_ENTITY`                         | EV state of charge (also used by Iris) |
| `IONIQ5_RANGE_ENTITY`                       | EV range (also used by Iris)           |
| `HEARTH_BRIEF_WEATHER_ENTITY`               | Weather forecast (HA `weather.*`)      |
| `HEARTH_BRIEF_PRECIP_PROB_TODAY_ENTITY`     | Today's precip probability             |
| `HEARTH_BRIEF_INDOOR_TEMP_ENTITY`           | Indoor temp from a room sensor         |
| `HEARTH_BRIEF_CALENDAR_ENTITY_IDS`          | Comma-separated calendar entity_ids    |

The puller fails open — if HA is down or an entity errors, the
brief still renders with the readings that succeeded, marking the
rest unavailable.

### Beyond the verified block

For signals NOT in `verified_life_context` (pet medical from Anya,
garden from Eleanor, finance from Vivian, family from Brigid), the
brief prompt directs Kate to:

- Read peer inbox flags (MEDIUM trust — peer LLM narrative).
- Call `search_library` / `read_note` THIS pass before quoting
  vault values.
- Call additional `ha_get_state` / `ha_calendar_query` /
  `caldav_upcoming` / `web_search` reads when needed — tool
  returns this pass are HIGH trust the same way the verified
  block is.

The standing rule: **values come from tool returns or
verified_life_context, NEVER from memory.** Recall is for finding
where to look, not for what to cite.

---

## Anti-patterns (do NOT do)

- **Stating a value from recall.** "Ioniq 5 at 97%" without the
  SoC reading in `verified_life_context` is the canonical
  hallucination — it happened because the entity wasn't even
  configured, and Kate filled the gap from training data. The
  fix is the verified block + the forbidden-patterns list in the
  prompt. If `verified_life_context.ev.soc_percent.status` is
  `'unavailable'`, DO NOT state an SoC value.
- **Leading `noticed` with proposal-queue counts** ("Trainer filed
  6 binding proposals…"). The single line "queued N for your
  review" is fine; enumerating them is not.
- **Treating specialist-internal score updates as headline news.**
  Authenticity drift downward = brief mention; score going up = log
  it, don't surface.
- **Naming entities not in the tool returns or context arrays.**
  Reportage, not fiction.
- **Filling the 4-item cap with Hearth-meta when life items exist
  to push there.** Life beats meta every time.
- **Adding `surface_tier` to the brief schema.** The classification
  is a generation-time discipline, not an output field — the iOS
  client reads the brief shape as-is.

---

## Verifying a brief reads right

After a brief renders, ask: if Jasper had three seconds, would he
get the most important thing on his plate today? If the answer is
"no — the lead is Trainer's autonomy graduation," the priority
order isn't being respected. Open
`src/core/deliberation.ts:brief_section` and check whether the
prompt is being read correctly; check whether
`tools_for_deliberation` still includes the life-context reads.

A representative weekday midday brief should read more like:

> **Noticed:** Storms rolling in late afternoon — morning's the
> window for anything outdoors. Eddie's refill is delayed two
> weeks per Anya. Calendar's clear after 3p.
>
> **attention_today[0]:** Storm window today — 55% precip 4–8p.
> Walk Eddie before noon; reschedule the patio call.
>
> **attention_today[1]:** Eddie refill pushed — Anya bumped
> pharmacy delivery to next Tues. Current supply: 8 days.
>
> **watching:** Trainer filed 6 connector-recovery proposals;
> Mariah's program scans clean; Vivian queued 1 spend approval.

The iOS hero card then naturally leads with the storm + Eddie
items; the "X proposals waiting" pill carries the Trainer-side
signal at the bottom of the card.
