// Inbox conversion types — what comes in, what each converter must produce.

export type InboxKind =
  | 'article'
  | 'pdf'
  | 'docx'
  | 'html'
  | 'image'
  | 'text'
  | 'gedcom'
  | 'other';

export interface ConversionInput {
  filename: string;
  mime_type: string;
  bytes?: Uint8Array; // for file uploads
  text?: string; // for already-text inputs
  url?: string; // for URL fetches
}

export interface ConversionResult {
  kind: InboxKind;
  title: string;
  markdown_body: string;
  /** Original metadata extracted during conversion (page count, author, etc.) */
  extracted_metadata: Record<string, unknown>;
  /** If the original should be preserved as an attachment, set both. */
  attachment_bytes?: Uint8Array;
  attachment_filename?: string;
  attachment_mime?: string;
}

export interface Converter {
  name: string;
  matches(input: ConversionInput): boolean;
  convert(input: ConversionInput): Promise<ConversionResult>;
}
