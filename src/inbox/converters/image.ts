import type { Converter, ConversionInput, ConversionResult } from '../types';

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const IMAGE_EXTS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.heif',
];

export const image_converter: Converter = {
  name: 'image',

  matches(input) {
    if (IMAGE_MIMES.has(input.mime_type)) return true;
    const lower = input.filename.toLowerCase();
    return IMAGE_EXTS.some((ext) => lower.endsWith(ext));
  },

  async convert(input: ConversionInput): Promise<ConversionResult> {
    if (!input.bytes) {
      throw new Error('image_converter requires bytes');
    }

    const title = input.filename;
    // The wrapper note's body is a markdown image link pointing at the
    // stored attachment. The actual attachment_path is resolved by storage.ts
    // before writing the wrapper note, so we use a placeholder here.
    const markdown_body = [
      `![${title}](_attachments/${title})`,
      '',
      '_No vision caption yet — add Qwen 3.6 vision captioning here in a future pass._',
    ].join('\n');

    return {
      kind: 'image',
      title,
      markdown_body,
      extracted_metadata: {
        byte_size: input.bytes.length,
        mime_type: input.mime_type,
      },
      attachment_bytes: input.bytes,
      attachment_filename: input.filename,
      attachment_mime: input.mime_type,
    };
  },
};
