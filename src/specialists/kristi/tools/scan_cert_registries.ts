/**
 * scan_cert_registries — Kristi's pre-launch leak radar.
 *
 * Certification / regulatory registries (DMTF Redfish, ENERGY STAR, TCO
 * Certified) publish certified model identifiers BEFORE retail launch, because
 * a vendor must certify before it can sell. So a model-string that appears in a
 * registry and isn't yet a known SKU is a leak — e.g. the Dec-2025 DMTF listing
 * `dell-pro-precision-9-t6-pw9t6260`.
 *
 * Pattern mirrors Ruby's `scan_council_meetings`: fetch each registry listing,
 * diff the set of certified model-strings against what we've already recorded,
 * and insert only the NEW ones. Cheap + idempotent when nothing moved — meant
 * to run frequently. Conditional on a content hash so an unchanged page costs
 * one cheap fetch and no extraction. When a registry page changes it's also
 * ingested into Kristi's library so her deliberation can read the full context.
 *
 * Runs as a background job (no user in ctx). Network/parse failures are
 * captured per-source and never throw the job.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore } from '@memory/stores/kristi_workstations';
import { make_ingest_to_library } from '@connectors/ingest_to_library';
import { browse_url } from '@connectors/avalanche';
import { web_search } from '@connectors/searxng';
import { BACKGROUND_MAX_AGE_MS } from '@connectors/search_router';
import { CERT_REGISTRY_SOURCES } from '../sources';

const MAX_NEW_PER_SOURCE = 40; // guard against a pattern matching the whole page

const InputSchema = z
  .object({
    registries: z
      .array(z.enum(['dmtf', 'energystar', 'tco']))
      .optional()
      .describe('Which registries to sweep. Omit for all.'),
    force: z
      .boolean()
      .default(false)
      .describe('Re-extract even if the registry page is unchanged since last sweep.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const Sighting = z.object({
  registry: z.string(),
  cert_model_string: z.string(),
  vendor_guess: z.string(),
  raw_url: z.string(),
});
const SourceResult = z.object({
  registry: z.string(),
  label: z.string(),
  new_sightings: z.array(Sighting),
  matched_total: z.number(),
  unchanged: z.boolean(),
  error: z.string().optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  results: z.array(SourceResult),
  total_new: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

function guess_vendor(
  match: string,
  hints: { contains: string; vendor: string }[] | undefined,
): string {
  if (!hints) return '';
  for (const h of hints) if (match.includes(h.contains)) return h.vendor;
  return '';
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  const ingest = make_ingest_to_library({
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      events: deps.events,
    },
    specialists: deps.specialists,
    users: deps.users,
  });

  return {
    name: 'scan_cert_registries',
    description:
      "Pre-launch leak radar. Render the certification/regulatory registries (DMTF, ENERGY STAR, TCO — JS SPAs) via the workstation and record only certified model-strings that are NEW since last seen — a new string is a workstation that's been certified but not yet announced at retail. Cheap and idempotent; safe to run frequently. Returns the new leaks. A non-empty list is the signal to research the model and reconcile it to a SKU.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel', 'browse_web', 'query_web'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    // Reporting-only: the fields are authoritative, but records only registry entries not already known, and the known set never shrinks, so zero is expected.
    yield: { produced: ['total_new'], armed: false },
    idempotency_key(input) {
      const r = (input.registries ?? ['dmtf', 'energystar', 'tco']).slice().sort().join(',');
      const hour = new Date().toISOString().slice(0, 13);
      return `scan_cert_registries:${r}:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      // One-time-ish: tag any sighting that predates the ws_class column so the
      // leak radar can be segmented by Desktop / Mobile / Rack / Edge-AI.
      store.backfill_sighting_classes();
      const wanted = new Set(input.registries ?? ['dmtf', 'energystar', 'tco']);
      const sources = CERT_REGISTRY_SOURCES.filter((s) => wanted.has(s.registry));
      const results: Output['results'] = [];
      let total_new = 0;
      let ok = true;

      for (const src of sources) {
        try {
          const host = new URL(src.url).host;
          const matched = new Map<string, string>(); // model_string -> raw_url it came from

          // (A) PRIMARY — search the registry domain for watched nomenclature.
          // Cert pages carry the model string in the URL/title (e.g. DMTF
          // /certifications/dell-pro-precision-9-t6-pw9t6260), and SearXNG
          // surfaces those individual pages even when the SPA listing won't
          // render scrapable rows. The result URL is the best raw_url to keep.
          for (const q of src.search_queries ?? []) {
            try {
              const sr = await web_search.execute(
                { query: `site:${host} ${q}`, max_results: 8, max_age_ms: BACKGROUND_MAX_AGE_MS },
                ctx,
              );
              for (const r of sr.results ?? []) {
                const hay = `${r.url} ${r.title}`.toLowerCase();
                for (const p of src.patterns) {
                  for (const m of hay.matchAll(new RegExp(p, 'gi'))) {
                    const s = m[0].replace(/\s+/g, ' ').trim();
                    if (s && !matched.has(s)) matched.set(s, r.url);
                  }
                }
              }
            } catch {
              /* one search failing is non-fatal — other queries + the render remain */
            }
          }

          // (B) SECONDARY — render the SPA listing via the workstation (plain fetch
          // returns chrome). Adds strings the listing shows, and when the page
          // changed, files the rendered text onto her shelf for leak context.
          let rendered = '';
          try {
            const page = await browse_url.execute({ url: src.url, wait_ms: src.wait_ms ?? 5000 }, ctx);
            if (!page.error && !page.defer_reason) rendered = page.text ?? '';
          } catch {
            /* render non-fatal; search matches above still stand */
          }
          if (rendered) {
            const text = rendered.toLowerCase();
            for (const p of src.patterns) {
              for (const m of text.matchAll(new RegExp(p, 'gi'))) {
                const s = m[0].replace(/\s+/g, ' ').trim();
                if (s && !matched.has(s)) matched.set(s, src.url);
              }
            }
            const hash = createHash('sha256').update(rendered).digest('hex');
            const prior = store.get_source_sync(src.url);
            if ((input.force || prior?.content_hash !== hash) && rendered.trim().length > 200) {
              store.record_source_sync(src.url, { content_hash: hash, row_count: matched.size });
              try {
                await ingest.execute(
                  { target_specialist_id: 'kristi', markdown: rendered.slice(0, 200_000), title_hint: src.label },
                  ctx,
                );
              } catch {
                /* ingest is non-critical for the radar */
              }
            }
          }

          // (C) diff against what we've recorded; insert only NEW strings,
          // attributing each to the page it was found on.
          const known = store.get_cert_strings(src.registry);
          const new_sightings: z.infer<typeof Sighting>[] = [];
          for (const [str, raw_url] of matched) {
            if (known.has(str)) continue;
            if (new_sightings.length >= MAX_NEW_PER_SOURCE) break;
            const vendor_guess = guess_vendor(str, src.vendor_hints);
            const { inserted } = store.record_cert_sighting({
              registry: src.registry,
              cert_model_string: str,
              vendor_guess,
              raw_url,
            });
            if (inserted) new_sightings.push({ registry: src.registry, cert_model_string: str, vendor_guess, raw_url });
          }

          total_new += new_sightings.length;
          results.push({
            registry: src.registry,
            label: src.label,
            new_sightings,
            matched_total: matched.size,
            unchanged: matched.size === 0,
          });
        } catch (err) {
          ok = false;
          results.push({
            registry: src.registry,
            label: src.label,
            new_sightings: [],
            matched_total: 0,
            unchanged: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'scan_cert_registries',
        tool_input: { registries: [...wanted] },
        execution_result: { ok, total_new, results },
      });

      return { ok, results, total_new };
    },
  };
}
