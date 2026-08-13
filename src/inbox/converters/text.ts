import type { Converter, ConversionInput, ConversionResult } from '../types';

export const text_converter: Converter = {
  name: 'text',

  matches(input) {
    return (
      input.mime_type === 'text/plain' ||
      input.mime_type === 'text/markdown' ||
      input.filename.endsWith('.txt') ||
      input.filename.endsWith('.md')
    );
  },

  async convert(input: ConversionInput): Promise<ConversionResult> {
    const text =
      input.text ?? (input.bytes ? new TextDecoder().decode(input.bytes) : '');
    const is_markdown =
      input.mime_type === 'text/markdown' || input.filename.endsWith('.md');

    // Use the first non-empty line as the title, stripped of leading hash marks
    const first_line =
      text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? input.filename;
    const title = first_line.replace(/^#+\s*/, '').slice(0, 120);

    return {
      kind: 'text',
      title,
      markdown_body: text,
      extracted_metadata: {
        byte_size: input.bytes?.length ?? text.length,
        was_markdown: is_markdown,
      },
    };
  },
};
