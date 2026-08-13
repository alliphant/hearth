/**
 * Minimal streaming RFC4180 CSV parser.
 *
 * The repo has no CSV dependency and the your county assessor files are large
 * (~44–96MB) with quoted fields containing embedded commas (legal
 * descriptions, "LAST, FIRST" owner names). Loading a 96MB file into one
 * string + naive split(',') would both blow memory and mis-parse those
 * fields, so this consumes the fetch body as a stream and emits header-keyed
 * records in batches.
 *
 * Handles: quoted fields, embedded commas, escaped quotes (""), CRLF/LF, a
 * quoted field that spans chunk boundaries. The first record is taken as the
 * header row; every subsequent record is yielded as Record<header, value>.
 */

export interface CsvStreamOptions {
  /** Rows per batch handed to onBatch (one DB transaction per batch). */
  batch_size?: number;
}

/**
 * Stream-parse a CSV ReadableStream, invoking onBatch with arrays of
 * header-keyed records. Returns the total data-row count.
 */
export async function parseCsvStream(
  body: ReadableStream<Uint8Array>,
  onBatch: (rows: Record<string, string>[]) => void | Promise<void>,
  opts: CsvStreamOptions = {},
): Promise<number> {
  const batch_size = opts.batch_size ?? 5000;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');

  let header: string[] | null = null;
  let total = 0;
  let batch: Record<string, string>[] = [];

  // CSV state machine carried across chunks.
  let field = '';
  let row: string[] = [];
  let in_quotes = false;
  let prev_was_quote_in_quotes = false; // saw a '"' while in_quotes (maybe escaped)

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = async () => {
    // Ignore a trailing empty line (single empty field, no other content).
    if (row.length === 1 && row[0] === '' ) {
      row = [];
      return;
    }
    if (!header) {
      header = row.map((h) => h.trim());
    } else {
      const rec: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) rec[header[i]!] = row[i] ?? '';
      batch.push(rec);
      total++;
      if (batch.length >= batch_size) {
        await onBatch(batch);
        batch = [];
      }
    }
    row = [];
  };

  const consume = async (text: string) => {
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (in_quotes) {
        if (prev_was_quote_in_quotes) {
          prev_was_quote_in_quotes = false;
          if (c === '"') {
            field += '"'; // escaped quote
            continue;
          }
          // The prior quote actually closed the field.
          in_quotes = false;
          // fall through to handle c as a normal char
        } else if (c === '"') {
          prev_was_quote_in_quotes = true;
          continue;
        } else {
          field += c;
          continue;
        }
      }
      // not in quotes (or just exited)
      if (c === '"') {
        in_quotes = true;
      } else if (c === ',') {
        pushField();
      } else if (c === '\n') {
        pushField();
        await pushRow();
      } else if (c === '\r') {
        // swallow; the \n handles the row break
      } else {
        field += c;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await consume(decoder.decode(value, { stream: true }));
  }
  // Flush any trailing decoder bytes + a final record with no trailing newline.
  await consume(decoder.decode());
  if (prev_was_quote_in_quotes) in_quotes = false;
  if (field !== '' || row.length > 0) {
    pushField();
    await pushRow();
  }
  if (batch.length > 0) await onBatch(batch);

  return total;
}
