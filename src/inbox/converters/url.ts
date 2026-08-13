import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import type { Converter, ConversionInput, ConversionResult } from '../types';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.remove(['script', 'style', 'noscript', 'iframe']);

export const url_converter: Converter = {
  name: 'url',

  matches(input) {
    return input.url !== undefined && input.url.length > 0;
  },

  async convert(input: ConversionInput): Promise<ConversionResult> {
    if (!input.url) {
      throw new Error('url_converter requires url');
    }

    const res = await fetch(input.url, {
      headers: {
        // Many sites serve different content based on UA; use a plausible one
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch ${input.url}: ${res.status} ${res.statusText}`);
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url: input.url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.content) {
      // Fall back: turndown the whole page
      const markdown_body = turndown.turndown(html);
      const title_match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = title_match?.[1]?.trim().slice(0, 200) ?? input.url;
      return {
        kind: 'article',
        title,
        markdown_body,
        extracted_metadata: {
          source_url: input.url,
          extraction: 'fallback_full_page',
        },
      };
    }

    const markdown_body = turndown.turndown(article.content);
    const title = (article.title ?? input.url).slice(0, 200);

    return {
      kind: 'article',
      title,
      markdown_body,
      extracted_metadata: {
        source_url: input.url,
        byline: article.byline ?? null,
        excerpt: article.excerpt ?? null,
        site_name: article.siteName ?? null,
        length_chars: article.length ?? null,
        extraction: 'readability',
      },
    };
  },
};
