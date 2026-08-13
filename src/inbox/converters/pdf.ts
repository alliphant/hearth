import { extractText, getDocumentProxy } from 'unpdf';
import type { Converter, ConversionInput, ConversionResult } from '../types';

export const pdf_converter: Converter = {
  name: 'pdf',

  matches(input) {
    return (
      input.mime_type === 'application/pdf' || input.filename.endsWith('.pdf')
    );
  },

  async convert(input: ConversionInput): Promise<ConversionResult> {
    if (!input.bytes) {
      throw new Error('pdf_converter requires bytes');
    }

    // pdfjs-dist (wrapped by unpdf) transfers ownership of the input
    // ArrayBuffer to its parser, detaching the original Uint8Array's
    // backing buffer. After extractText() returns, `input.bytes.length`
    // becomes 0 and any attempt to use those bytes again — e.g. the
    // attachment_bytes return below, which the caller writes to disk —
    // produces a 0-byte file. Real symptom: Anya's the clinic VTH PDF uploads
    // landed on disk as empty placeholders, the markdown wrapper had
    // empty bodies, chunks_fts indexed nothing, and her search_library
    // returned no hits even though the user had clearly uploaded the
    // documents. Fix: hand pdfjs a fresh copy, keep the original intact
    // to write out as the attachment.
    const byte_size = input.bytes.length;
    const bytes_for_extract = new Uint8Array(input.bytes);
    const doc = await getDocumentProxy(bytes_for_extract);
    const { totalPages, text } = await extractText(doc, { mergePages: true });

    // First non-empty line of text, else filename
    const lines = (Array.isArray(text) ? text.join('\n') : text)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const title = (lines[0] ?? input.filename).slice(0, 200);

    const body = Array.isArray(text) ? text.join('\n\n') : text;

    return {
      kind: 'pdf',
      title,
      markdown_body: body.trim(),
      extracted_metadata: {
        page_count: totalPages,
        byte_size,
      },
      attachment_bytes: input.bytes,
      attachment_filename: input.filename,
      attachment_mime: 'application/pdf',
    };
  },
};
