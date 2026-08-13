import TurndownService from 'turndown';
import type { Converter, ConversionInput, ConversionResult } from '../types';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Don't convert <script>, <style>, or <noscript> blocks
turndown.remove(['script', 'style', 'noscript']);

export const html_converter: Converter = {
  name: 'html',

  matches(input) {
    return (
      input.mime_type === 'text/html' ||
      input.filename.endsWith('.html') ||
      input.filename.endsWith('.htm')
    );
  },

  async convert(input: ConversionInput): Promise<ConversionResult> {
    const html =
      input.text ?? (input.bytes ? new TextDecoder().decode(input.bytes) : '');

    // Pull <title> if present
    const title_match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = title_match?.[1]?.trim().slice(0, 200) ?? input.filename;

    const markdown_body = turndown.turndown(html);

    return {
      kind: 'html',
      title,
      markdown_body,
      extracted_metadata: {
        byte_size: input.bytes?.length ?? html.length,
      },
    };
  },
};
