import type { Converter, ConversionInput, ConversionResult } from './types';
import { text_converter } from './converters/text';
import { html_converter } from './converters/html';
import { pdf_converter } from './converters/pdf';
import { docx_converter } from './converters/docx';
import { image_converter } from './converters/image';
import { url_converter } from './converters/url';
import { gedcom_converter } from './converters/gedcom';

// Order matters: more specific converters first. url_converter is
// checked first because a URL takes precedence over any bytes/mime
// that came with the request. gedcom_converter runs before
// text_converter because some GEDCOM uploads come with mime
// text/plain — we want the specialized parse + roster preview, not
// a raw text passthrough.
const CONVERTERS: Converter[] = [
  url_converter,
  pdf_converter,
  docx_converter,
  image_converter,
  html_converter,
  gedcom_converter,
  text_converter,
];

export async function convert(input: ConversionInput): Promise<ConversionResult> {
  for (const c of CONVERTERS) {
    if (c.matches(input)) {
      return await c.convert(input);
    }
  }
  throw new Error(
    `No converter matched for filename=${input.filename} mime=${input.mime_type} url=${input.url ?? 'none'}`,
  );
}

export function supported_extensions(): string[] {
  return [
    '.txt', '.md', '.html', '.htm', '.pdf', '.docx',
    '.png', '.jpg', '.jpeg', '.gif', '.webp',
    '.ged', '.gedcom',
  ];
}
