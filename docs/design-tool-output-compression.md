# Tool-output compression — design for a future pass

**Status:** Not started. Surface this when a research-heavy specialist
(Maggie, Cordelia) starts routinely tripping `MAX_TOOL_ROUNDS` exhaustion
or `OPENAI_IDLE_TIMEOUT_MS` (currently 120s) on synthesis.

## The problem

Every `web_fetch_clean` / `browse_url` / `search_library` / Plex /
Tautulli call returns a payload measured in kilobytes. After 8–14 tool
rounds on a research-heavy chat or deliberation turn, the LLM context
holds 100–200 KB of accumulated tool output. That cost cascades:

- **Synthesis latency.** the LLM host (Qwen3.6-27B-Q4 + DFlash, single slot,
  96k context) spends real wall-clock time scanning that backlog before
  emitting the first SSE token of the final reply. The 2026-05-24
  South-Arcade / Honey-Revenge turn was 107s end to end after the idle
  timeout was bumped to 120s; before the bump it tripped 45s and
  fell back to a canned reply.
- **Context-limit pressure.** 96k slot ÷ ~3 chars/token ≈ 32k tokens.
  Persona + system prompt + conversation history is 8–12k. That leaves
  20–24k for tool output before context truncation begins eating earlier
  rounds. A 10-round turn at 2KB/round average is fine; a 14-round turn
  at 8KB/round average crosses the wall.
- **Grammar pressure.** Each round ships every visible tool's JSON
  schema to the backend for GBNF compilation. Bigger context = slower
  prefill = greater chance of model degradation (empty-args, ghost
  promises, MAX_TOOL_ROUNDS exhaustion). Per
  `architecture.md` "Per-turn tool curation".
- **Boilerplate dominance.** Most of the kilobytes are nav menus,
  cookie banners, footer links, "you might also like" widgets that
  Firecrawl doesn't strip cleanly. The actual signal — dates, venues,
  prices, headlines — is usually <500 chars per page.

What the LLM actually USES from a tool result is typically 5–10% of
what we feed it. Compression should target the other 90–95%.

## Design — three layers, ship them independently

The right shape is **defense in depth**: each layer wins on its own
and they compose. Don't wait for "the right architecture" — Phase 1
is a 20-line change with immediate impact; Phase 3 is structural.

### Phase 1 — Smart truncation at the tool-result boundary

**Where:** Each connector tool's `execute()` returns its full result,
but the `tool_results_for_llm` projection that gets re-fed to the
specialist on the next round caps the relevant text field at a
configurable budget (default ~4000 chars per result, ~2x the average
real signal).

**How:** A `truncate_for_llm(text, budget)` helper that:
1. Preserves the first ~30% of the budget verbatim (intro / headline).
2. Searches the body for "high-signal" lines — anything matching
   /\d{4}|jan|feb|...|tickets|sold out|festival|venue|\$\d/i — and
   collects them up to the budget.
3. Appends `[...truncated N chars; full result in audit_log]` so the
   LLM knows context was elided and doesn't hallucinate completeness.

**Full result stays in audit.** `tool_calls_made[].result` in the
audit/persistence path remains uncompressed — for debugging,
replayability, and the "show details" UI toggle. Only the
LLM-facing copy gets cut.

**Per-tool override.** Tools whose output is already small (`media_search`,
`upcoming_dates`, `caldav_upcoming`) opt out by setting `llm_budget:
'full'` in their Tool descriptor. Tools whose output is reliably bulky
(`web_fetch_clean`, `browse_url`, `read_note` on large notes) opt into
a tighter budget (e.g. 2000 chars).

**Estimated impact:** 60–80% reduction in LLM context per tool result
on Firecrawl-style returns. Synthesis latency drops proportionally.
Zero behavioral risk on small results.

**Estimated effort:** 2–3 hours. One helper, one wiring point in
specialist_runtime where `tool_results_for_llm` is built, one Tool
descriptor field.

### Phase 2 — Mid-turn summarization for sliding context

**Where:** Add a `summarize_tool_results` pass in the
specialist_runtime between rounds, triggered when accumulated
tool-output context exceeds a threshold (e.g. 30k tokens).

**How:** The pass calls `consult_deep_model` (or a dedicated faster
role) with: "the user asked X; here are the last N tool results; emit
a 1000-char digest of what's relevant to X, dropping everything that
isn't." Replace the N raw results with the digest in the LLM's
context. Keep the latest 1–2 raw for cross-reference.

**Why a separate call instead of Phase 1's smart truncation?**
Truncation is content-agnostic. Summarization is query-aware: it knows
"Jasper asked about Colorado tour dates" and drops the LA / Phoenix /
Seattle bullets that smart-truncation would keep.

**Trigger conditions** (any of):
- Token count of accumulated tool results > 30k
- Round count > 8 AND the user query is a single focused question
- Specialist YAML sets `proactive.aggressive_compression: true`

**Estimated effort:** ~1 day. Heavier because it needs the digest
prompt template, the call site in the runtime loop, and a per-
specialist config flag.

### Phase 3 — Structured tool outputs (the long-term play)

**Where:** Refactor tool output shape so the LLM-facing schema is
structured by default, not free-form text.

**How:** `web_fetch_clean` and `browse_url` currently return
`{markdown: string}`. They should ALSO return (and prefer for LLM
consumption):

```ts
{
  page_summary: string,           // 1-3 sentences, model-generated
  structured: {
    events?: Array<{date, venue, city, support?}>,
    products?: Array<{name, price, availability}>,
    headlines?: string[],
    links?: Array<{text, href}>,
  },
  raw_markdown?: string,           // only when no structure extracted
}
```

The "extract structure" step lives inside the tool, not in the
specialist's LLM. Could use a small fast extraction model
(Qwen3.6-Heretic in Lemonade, or a cheap remote like Haiku) called
once per fetch. Cache by URL+content-hash so repeat fetches don't
re-extract.

**Why this is Phase 3, not Phase 1:** It's the right architecture
but a large surface change. Every browse tool's output schema
shifts; every specialist's persona that references those tools may
need adjustment; the small extraction model becomes a load-bearing
dep. Phase 1 buys most of the latency win without any of this.

**Estimated effort:** ~3–5 days, plus a model-routing decision.

## What NOT to do

- **Don't compress in the connector wrapper without preserving raw.**
  Audit log + debugging need the original. Always two paths: full to
  audit, compressed to LLM.
- **Don't drop low-signal lines blindly.** "Cookie banner" lines and
  "you might also like" lines are predictable; "© 2026 Some Venue"
  lines are noise but sometimes the only place a venue name appears.
  Test against the existing smokes before shipping.
- **Don't bake compression into the persona.** Telling Maggie "ask
  for less data" is the wrong layer — she shouldn't be reasoning
  about her own context budget. The compression is invisible at
  her layer; she gets less verbose tool results and synthesizes
  faster, without any persona awareness needed.
- **Don't add Phase 2 + Phase 3 simultaneously.** Ship Phase 1, measure,
  decide whether Phase 2 or Phase 3 is the higher-leverage next step
  given how the actual data looks.

## Measurement

Before shipping Phase 1, capture a baseline on a Maggie research turn:
- Bytes of `tool_calls_made[].result` content
- Time from last tool-result-emit to first synthesis SSE token
- Total turn wall-clock
- Round count

After shipping Phase 1, same metrics. Target: 60%+ reduction in the
bytes; 30%+ reduction in synthesis-start time. If you don't see those,
the truncator isn't aggressive enough or the boilerplate is uglier
than expected — iterate before moving to Phase 2.
