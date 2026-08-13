/**
 * smoke:fabricated-image — the two image-delivery guards (2026-07-28).
 *
 * A matched pair, both exact set-membership checks over the server-minted
 * ULID filename rather than regex heuristics:
 *
 *   - `_detect_fabricated_image` — a LINK with no call behind it. The route
 *     404s and the user sees a broken tile.
 *   - `_detect_unplaced_image` — a CALL whose markdown line never made it
 *     into the reply. The image exists but nothing renders; the model
 *     narrates it instead ("The image renders in the chat") and then
 *     argues with the user about a blank space.
 *
 * Pure-function test: no LLM, no live runtime.
 */
import { _detect_fabricated_image, _detect_unplaced_image } from '../src/core/specialist_runtime';

type Call = { name: string; error?: string; input?: unknown; result?: unknown };
const calls = (...cs: Call[]) => cs as unknown as Parameters<typeof _detect_fabricated_image>[1];

/** A landed generate_image call that minted `file`. */
const minted = (file: string): Call => ({
  name: 'generate_image',
  result: { ok: true, image_url: `/api/media/generated/${file}`, markdown: `![x](/api/media/generated/${file})` },
});

const A = 'img-01kyjh0e9sy37kjnwtyqrpkb2s.png';
const B = 'img-01kyjgw9eses12vy12x693k2hq.png';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

function fires(text: string, cs: Call[]): boolean {
  return _detect_fabricated_image(text, calls(...cs)) !== null;
}

function main(): void {
  // ── FIRES: an image link with nothing behind it ───────────────────────
  check(
    'an image link with zero tool calls fires',
    fires(`Here's the render you asked for:\n\n![a misty ridge](/api/media/generated/${A})`, []),
  );
  check(
    'a link that does not match the minted filename fires',
    fires(`![take two](/api/media/generated/${A})`, [minted(B)]),
  );
  check(
    'a FAILED generate_image call does not back a link',
    fires(`![it worked](/api/media/generated/${A})`, [
      { name: 'generate_image', error: 'ComfyUI timeout' },
    ]),
  );
  check(
    'two links when only one was minted fires',
    fires(
      `![one](/api/media/generated/${A})\n\n![two](/api/media/generated/${B})`,
      [minted(A)],
    ),
  );
  check(
    'an unrelated tool call does not back a link',
    fires(`![chart](/api/media/generated/${A})`, [{ name: 'program_dashboard', result: {} }]),
  );

  // ── DOES NOT FIRE: the link the tool actually returned ────────────────
  check(
    'the minted link does not fire',
    !fires(`Here it is:\n\n![a misty ridge](/api/media/generated/${A})`, [minted(A)]),
  );
  check(
    'both links fire-free when both were minted',
    !fires(
      `![one](/api/media/generated/${A})\n\n![two](/api/media/generated/${B})`,
      [minted(A), minted(B)],
    ),
  );
  check(
    'a reply with no image link does not fire',
    !fires('Three misses closed this pass; the graduation queue is clear.', [])
  );
  check(
    'an honest failure admission with no link does not fire',
    !fires("The image didn't come out — ComfyUI timed out. Want me to try again?", [
      { name: 'generate_image', error: 'timeout' },
    ]),
  );
  check(
    'an unrelated media URL does not fire',
    !fires('Archived it: /api/media/thumb/01kyjh0e9sy37kjnwtyqrpkb2s', []),
  );

  // ── UNPLACED: the call landed but the line never reached the user ─────
  const unplaced = (text: string, cs: Call[]) =>
    _detect_unplaced_image(text, calls(...cs)) !== null;

  check(
    'narrating the image instead of embedding it fires (the Mariah 23:28 case)',
    unplaced('*The image renders in the chat, capturing the exact moment.*', [minted(A)]),
  );
  check(
    'an empty reply after a successful generate_image fires',
    unplaced('', [minted(A)]),
  );
  check(
    'two images generated, only one placed fires',
    unplaced(`![one](/api/media/generated/${A})`, [minted(A), minted(B)]),
  );
  check(
    'placing the link does NOT fire',
    !unplaced(`Here it is:\n\n![x](/api/media/generated/${A})`, [minted(A)]),
  );
  check(
    'placing it in a message_user body instead of the reply does NOT fire',
    !unplaced('Sent it over.', [
      minted(A),
      { name: 'message_user', input: { body: `![x](/api/media/generated/${A})` } },
    ]),
  );
  check(
    'a FAILED generate_image does not demand placement',
    !unplaced("It didn't come out — the engine timed out.", [
      { name: 'generate_image', error: 'timeout' },
    ]),
  );
  check(
    'no generate_image call at all does not fire',
    !unplaced('Three misses closed this pass.', [{ name: 'program_dashboard', result: {} }]),
  );

  if (process.exitCode === 1) {
    console.log('\nsmoke:fabricated-image FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:fabricated-image — ${checks} checks passed`);
}

main();
