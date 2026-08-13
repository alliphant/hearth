/**
 * ingest_to_library — Cordelia's primary working tool.
 *
 * Lets the caller ingest a source (URL or raw markdown) into a target
 * specialist's library (Knowledge/<TargetCapId>/library/), going
 * through the same convert → titleize → index pipeline as a manual
 * upload. Routes to `save_library_item` so the wrapper note ends up
 * with a clean LLM-generated title and summary, the body chunked into
 * chunks_fts for the target specialist's RAG, and a clippings row
 * registered.
 *
 * Capability: `write_vault_any_library`. Only Cordelia has this grant
 * in the seed config — every other specialist tends their own shelf
 * via the upload UI or via cleanup_library_trash, and they consult
 * Cordelia when they need a source filed onto someone else's shelf.
 *
 * Why this exists as a tool, not just an HTTP route: the route is
 * multipart and meant for human uploads. Specialists need a clean
 * programmatic entry point with input validation and audit logging
 * routed through the tool registry like everything else they do.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import type { UserRegistry } from '@core/users';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';
import { fetch_with_browser_fallback } from './fetch_with_browser_fallback';

const InputSchema = z.object({
  target_specialist_id: z.string().min(1),
  // Exactly one of url / markdown must be set. Validated in execute()
  // because Zod's discriminated-union ergonomics fight the Tool<I,O>
  // generic typing pattern used elsewhere.
  url: z.string().url().optional(),
  markdown: z.string().min(1).max(2_000_000).optional(),
  // Human-overridable hint for the title; otherwise the LLM-generated
  // clean title from the ingest pipeline wins.
  title_hint: z.string().min(1).max(280).optional(),
});

const OutputSchema = z.object({
  // Null on a quality-gate rejection (see `rejected`); a string on a
  // successful ingest.
  wrapper_note_path: z.string().nullable(),
  target_specialist_id: z.string(),
  title: z.string().nullable(),
  kind: z.string().nullable(),
  attachment_path: z.string().nullable(),
  // Quality gate (#2b): present + true when the capture was rejected as a
  // shell (nav-chrome / interstitial / paywall / thin) before save —
  // nothing was written. `follow_url` names the real binary when the
  // rejection was a download interstitial.
  rejected: z.boolean().optional(),
  rejection_reason: z.string().optional(),
  content_type: z.string().optional(),
  follow_url: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface IngestToLibraryDeps {
  library_deps: LibraryRoutesDeps;
  specialists: SpecialistRegistry;
  users?: UserRegistry;
}

export function make_ingest_to_library(
  deps: IngestToLibraryDeps,
): Tool<Input, Output> {
  return {
    name: 'ingest_to_library',
    description:
      "Fetch a source (URL preferred) or accept a markdown blob, and file it onto a target specialist's library shelf at Knowledge/<TargetSpecialist>/library/. The pipeline auto-titles, summarizes, and indexes for search. Use this when you're acting as the household's research-and-acquisition function: a specialist needs an authoritative document they don't yet have, you go find it (or the user hands you the URL), you ingest it onto their shelf so it becomes searchable for them on the next turn. Either `url` OR `markdown` must be provided. `target_specialist_id` is the lowercase id of the shelf-owner (e.g. 'eleanor', 'linda', 'kristi').",
    risk: 'write_internal',
    required_capabilities: ['write_vault_any_library'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const key = input.url ?? (input.markdown ?? '').slice(0, 240);
      return `ingest:${input.target_specialist_id}:${key.slice(0, 200)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!input.url && !input.markdown) {
        throw new Error(
          'ingest_to_library: exactly one of `url` or `markdown` must be provided',
        );
      }
      if (input.url && input.markdown) {
        throw new Error(
          'ingest_to_library: provide either `url` or `markdown`, not both',
        );
      }
      const target = deps.specialists.get(input.target_specialist_id);
      if (!target) {
        throw new Error(
          `ingest_to_library: unknown target_specialist_id "${input.target_specialist_id}"`,
        );
      }

      let conversion_input;
      let source: 'url' | 'file';
      let source_url: string | undefined;
      if (input.url) {
        // Try Firecrawl first; if the URL is bot-blocked (Mayo,
        // Cleveland Clinic, Harvard Health, etc.) escalate to
        // browse_url via the workstation's warmed Firefox profile. Per
        // the private dev log the rule is "try web_fetch_clean ONCE, escalate
        // to browse_url on the SAME URL on failure" — applied here
        // when the caller hands us a URL we don't know in advance is
        // bot-protected.
        const outcome = await fetch_with_browser_fallback(input.url, ctx, {
          title_fallback: input.title_hint,
        });
        if (outcome.kind === 'failed' || outcome.kind === 'deferred') {
          throw new Error(
            `ingest_to_library: ${outcome.kind === 'deferred' ? 'browser deferred' : 'fetch failed'} for ${input.url}: ${outcome.reason}`,
          );
        }
        if (outcome.kind === 'firecrawl') {
          conversion_input = {
            filename: input.url,
            mime_type: 'text/url',
            url: input.url,
          };
        } else {
          // browser-fetched plain text wrapped as markdown by the helper.
          conversion_input = {
            filename: input.url,
            mime_type: 'text/markdown',
            text: outcome.markdown,
          };
        }
        source = 'url';
        source_url = input.url;
      } else {
        const filename = (input.title_hint
          ? input.title_hint.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)
          : 'note') + '.md';
        conversion_input = {
          filename,
          mime_type: 'text/markdown',
          text: input.markdown!,
        };
        source = 'file';
      }

      const tz = deps.users?.get_timezone(ctx.user?.id ?? null);
      const saved = await save_library_item(
        deps.library_deps,
        conversion_input,
        target,
        // A user ingesting a URL into a shelf scopes it to them; a
        // user-less/system ingest stays shelf-wide (null).
        { source, source_url, tz, private_to: ctx.user?.id ?? null },
      );

      // Quality gate (#2b): the capture was a shell — nothing written.
      // Return a structured rejection so the calling specialist can act
      // (try a different source, follow the real file) instead of
      // believing it filed something.
      if ('rejected' in saved) {
        return {
          wrapper_note_path: null,
          target_specialist_id: target.id,
          title: null,
          kind: null,
          attachment_path: null,
          rejected: true,
          rejection_reason: saved.reason,
          content_type: saved.content_type,
          ...(saved.follow_url ? { follow_url: saved.follow_url } : {}),
        };
      }

      return {
        wrapper_note_path: saved.wrapper_note_path,
        target_specialist_id: target.id,
        title: saved.title,
        kind: saved.kind,
        attachment_path: saved.attachment_path ?? null,
      };
    },
  };
}

/** ToolLoader entry point. Builds the library pipeline deps from the bag. */
export function create(deps: ToolDeps): Tool {
  return make_ingest_to_library({
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
  }) as Tool;
}
