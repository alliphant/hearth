/**
 * Speakable-text shaping for the voice surface.
 *
 * Extracted from src/app/routes/openai_shim.ts (2026-06-15) so the
 * Satellite1 streaming path AND the deliver-followup announce path
 * (src/core/voice_announce.ts) share ONE definition — a voice followup
 * spoken on the device must be shaped exactly like a live voice reply.
 */

/**
 * Make text TTS-safe so the voice never reads symbols aloud as literal glyphs.
 * Two jobs: (1) strip markdown — the `voice_style` rule tells Kate "no
 * markdown", but a quantized model still emits bullets/bold for lists; (2)
 * spell out symbols/units the TTS voice can't pronounce (the Laur voice on
 * forza can't say the degree glyph). DETERMINISTIC backstop on the spoken
 * path only — the stored transcript keeps the raw text. Keeps the words,
 * drops/spells the markup. Line-anchored list/header strips are safe per
 * emitted chunk: the sentence splitter cuts on newlines, so each bullet
 * arrives as its own chunk.
 */
export function strip_markdown_for_speech(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code
    .replace(/`([^`]+)`/g, '$1')               // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')    // links -> text
    .replace(/^[ \t]*>{1,}\s?/gm, '')           // blockquotes
    .replace(/^[ \t]*#{1,6}\s+/gm, '')          // headers
    .replace(/^[ \t]*[-*+]\s+/gm, '')           // bullet markers
    .replace(/^[ \t]*\d+[.)]\s+/gm, '')         // numbered-list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // bold
    .replace(/__([^_]+)__/g, '$1')              // bold
    .replace(/\*([^*\n]+)\*/g, '$1')            // italic
    .replace(/~~([^~]+)~~/g, '$1')              // strikethrough
    // Spell out units the Laur TTS voice mispronounces. "72°F"/"72 °F"/"72℉"
    // -> "72 degrees" (the model can't voice the degree glyph). \b guards
    // against eating "°Fahrenheit". Add sibling units here as they surface.
    .replace(/\s*(?:°\s*F\b|℉)/g, ' degrees')
    .replace(/[ \t]{2,}/g, ' ');                // collapse spaces
}
