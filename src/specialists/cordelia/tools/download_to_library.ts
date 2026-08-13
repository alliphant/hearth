/**
 * download_to_library — Cordelia's acquisition tool for the file manager.
 *
 * Where `ingest_to_library` files cleaned TEXT onto a specialist's vault
 * shelf for RAG, this fetches a FILE — a PDF, a dataset, an installer,
 * an image — and drops the raw bytes into the categorized store at
 * ~/hearth-library/ that Jasper browses through the /files UI.
 *
 * The flow Cordelia runs: Jasper asks her to find something → she
 * searches (web_search) and vets candidates (web_fetch_clean) → she
 * downloads the winner here into the right category → Jasper grabs it
 * from http://localhost:7700/files.
 *
 * Risk: write_internal (it writes a file to local disk). Capability:
 * `download_files`, granted to Cordelia only in the seed config.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { LLMRouter } from '@core/llm';
import { assess_download_integrity } from '@connectors/download_integrity';
import {
  LIBRARY_CATEGORIES,
  type LibraryStore,
  sanitize_filename,
} from '@library/store';

/** Default 5 GB cap; override with HEARTH_LIBRARY_MAX_DOWNLOAD_BYTES. */
const MAX_DOWNLOAD_BYTES = parseInt(
  process.env.HEARTH_LIBRARY_MAX_DOWNLOAD_BYTES ??
    String(5 * 1024 * 1024 * 1024),
  10,
);

/** Generous timeout — a multi-GB file over a slow link takes a while. */
const FETCH_TIMEOUT_MS = parseInt(
  process.env.HEARTH_LIBRARY_DOWNLOAD_TIMEOUT_MS ?? String(10 * 60 * 1000),
  10,
);

const InputSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The direct URL of the file to download (http or https).'),
  category: z
    .enum(LIBRARY_CATEGORIES)
    .describe(
      'Which top-level library category the file belongs in. One of: ' +
        LIBRARY_CATEGORIES.join(', ') + '.',
    ),
  subfolder: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Optional sub-folder within the category to file this under, e.g. ' +
        '"Ioniq-5" or "ROCm". Created if it does not exist. Omit to drop ' +
        'the file straight in the category root.',
    ),
  filename: z
    .string()
    .max(255)
    .optional()
    .describe(
      'Optional filename override. If omitted, the name is taken from the ' +
        'server (Content-Disposition) or the URL path.',
    ),
  description: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'A short description of what the file is — shown in the file ' +
        "manager's Get Info panel and used for search.",
    ),
  tags: z
    .array(z.string().max(60))
    .max(20)
    .optional()
    .describe('Optional tags for search and organization.'),
});

const OutputSchema = z.object({
  id: z.string(),
  filename: z.string(),
  rel_path: z.string(),
  category: z.string(),
  size: z.number(),
  mime: z.string().nullable(),
  source_url: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** filename="x" / filename*=UTF-8''x out of a Content-Disposition header. */
function filename_from_disposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain && plain[1] ? plain[1].trim() : null;
}

/** Last path segment of a URL, query string and fragment stripped. */
function filename_from_url(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

export function make_download_to_library(
  library: LibraryStore,
  llm?: LLMRouter,
): Tool<Input, Output> {
  return {
    name: 'download_to_library',
    description:
      'Download a file from a URL into Jasper’s categorized library (the ' +
      '/files file manager). Use this once you have vetted a source and ' +
      'want the actual file — a PDF, dataset, installer, image — saved for ' +
      'him. Pick the right `category`; use `subfolder` to group related ' +
      'files. Give a `description` and `tags` so it is findable later. ' +
      'For filing cleaned text onto a specialist’s RAG shelf, use ' +
      'ingest_to_library instead.',
    risk: 'write_internal',
    required_capabilities: ['download_files'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const dir = input.subfolder
        ? `${input.category}/${input.subfolder}`
        : input.category;
      return `download_to_library:${dir}:${input.url}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      if (!/^https?:$/i.test(new URL(input.url).protocol)) {
        throw new Error('download_to_library: only http(s) URLs are supported');
      }

      let res: Response;
      try {
        res = await fetch(input.url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': 'hearth-library/1.0' },
        });
      } catch (err) {
        throw new Error(
          `download_to_library: fetch failed — ${(err as Error).message}`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `download_to_library: ${input.url} returned HTTP ${res.status}`,
        );
      }

      // Reject early on a declared length over the cap.
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `download_to_library: file is ${declared} bytes, over the ` +
            `${MAX_DOWNLOAD_BYTES}-byte cap`,
        );
      }
      if (!res.body) {
        throw new Error('download_to_library: response had no body');
      }

      // Stream with a running byte count so a chunked response with no
      // Content-Length still can't blow past the cap.
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();
            throw new Error(
              `download_to_library: download exceeded the ` +
                `${MAX_DOWNLOAD_BYTES}-byte cap`,
            );
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (total === 0) {
        throw new Error('download_to_library: downloaded file was empty');
      }

      const name = sanitize_filename(
        input.filename ||
          filename_from_disposition(res.headers.get('content-disposition')) ||
          filename_from_url(input.url) ||
          'download',
      );
      const content_type = res.headers.get('content-type');
      const mime = content_type ? content_type.split(';')[0]?.trim() : null;
      const dir = input.subfolder
        ? `${input.category}/${input.subfolder}`
        : input.category;

      // Integrity + intent gate (2026-06-01). The fetch can return HTTP
      // 200 with a redirect/landing page, login wall, or error stub in
      // place of the file (Ruby's FCGOV budget pull). Reject before the
      // trash lands; hand Cordelia the real file's URL to retry with.
      const integrity = await assess_download_integrity({
        bytes,
        filename: name,
        url: input.url,
        description: input.description ?? null,
        llm,
      });
      if (!integrity.ok) {
        throw new Error(
          `download_to_library: refused to save — ${integrity.reason}. ` +
            (integrity.follow_url
              ? `The actual file appears to be at ${integrity.follow_url}; ` +
                'call download_to_library again with that URL.'
              : `This URL did not return the file (got ${integrity.sniffed_format}). ` +
                'Find a direct link to the file and retry.'),
        );
      }

      const saved = library.write_file({
        dir,
        filename: name,
        bytes,
        source_url: input.url,
        description: input.description ?? null,
        tags: input.tags ?? [],
        mime: mime || null,
        downloaded_by: 'cordelia',
      });

      return {
        id: saved.id,
        filename: saved.filename,
        rel_path: saved.rel_path,
        category: saved.category,
        size: saved.size,
        mime: saved.mime,
        source_url: saved.source_url,
      };
    },
  };
}

/** ToolLoader entry point — pulls the LibraryStore from the deps bag. */
export function create(deps: ToolDeps): Tool {
  return make_download_to_library(deps.library, deps.llm) as Tool;
}
