/**
 * binary_text — "are these bytes prose, or a file the model must not read?"
 *
 * Promoted out of `read_library_note` on 2026-07-31 because it turned out to
 * be needed in two places, and the failure it prevents is severe.
 *
 * WHY THIS EXISTS. On 2026-07-31 a specialist was asked to read a receipt
 * image in the vault. `read_note` returned 29,819 characters of raw JPEG
 * decoded as a string; the model could not tell that from a document it had
 * merely failed to parse, so it filled the gap and reported a torque
 * specification ("20 Nm") that appeared nowhere in the image. It had
 * assembled the number from unrelated line items.
 *
 * **A reader that returns bytes-as-text is a confabulation engine.** The right
 * behaviour is to refuse and name the tool that CAN read the file, so the
 * model's next move is correct instead of invented.
 *
 * DETECTION IS CONTENT-BASED, NOT EXTENSION-BASED, and that is the point:
 * an extension test is wrong in both directions. A `.pdf` in the vault has a
 * perfectly good extracted-markdown body and must keep reading through, while
 * a denylist silently passes anything it has not heard of — which is exactly
 * how nine ~118 KB `.vrma` avatar-animation files sat readable under
 * `read_codebase_file`'s allowlisted `src/`, under its size cap, waiting to be
 * handed to a model as mojibake.
 *
 * Use this as the LAST gate, after whatever cheap extension check a caller
 * already has. It reads only the first 2 KB, so it is cheap enough to be
 * unconditional.
 */

/** Bytes sampled from the head of the content — enough to classify, cheap. */
const SAMPLE_BYTES = 2048;

/**
 * Fraction of the sample that must look like decode wreckage before we call
 * it binary. A stray U+FFFD shows up in legitimately mis-encoded prose, so
 * this gates on DENSITY rather than presence; real binary blows well past it.
 */
const SUSPECT_RATIO = 0.05;

export function looks_binary(body: string): boolean {
  if (body.length === 0) return false;
  const sample = body.slice(0, SAMPLE_BYTES);

  // A NUL byte never appears in text this system stores — decisive alone.
  if (sample.includes('\u0000')) return true;

  // U+FFFD is what a lossy byte→string decode leaves behind; C0 control chars
  // (excluding tab / CR / LF) do not occur in prose.
  let suspect = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\uFFFD') suspect++;
    else if (code < 0x09 || (code > 0x0d && code < 0x20)) suspect++;
  }
  return suspect / sample.length > SUSPECT_RATIO;
}
