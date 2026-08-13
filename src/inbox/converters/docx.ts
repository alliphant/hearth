import mammoth from 'mammoth';
import TurndownService from 'turndown';
import type { Converter, ConversionInput, ConversionResult } from '../types';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

export const docx_converter: Converter = {
  name: 'docx',

  matches(input) {
    return (
      input.mime_type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      input.filename.endsWith('.docx')
    );
  },

  async convert(input: ConversionInput): Promise<ConversionResult> {
    if (!input.bytes) {
      throw new Error('docx_converter requires bytes');
    }

    const { value: html, messages } = await mammoth.convertToHtml({
      buffer: Buffer.from(input.bytes),
    });

    const markdown_body = turndown.turndown(html).trim();

    // First non-empty line for title
    const first_line = markdown_body
      .split('\n')
      .map((l) => l.trim().replace(/^#+\s*/, ''))
      .find((l) => l.length > 0);
    const title = (first_line ?? input.filename).slice(0, 200);

    return {
      kind: 'docx',
      title,
      markdown_body,
      extracted_metadata: {
        byte_size: input.bytes.length,
        mammoth_warnings: messages.length,
      },
      attachment_bytes: input.bytes,
      attachment_filename: input.filename,
      attachment_mime:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  },
};
