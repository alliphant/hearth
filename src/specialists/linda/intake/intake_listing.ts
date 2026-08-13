/**
 * Linda — marketplace item intake.
 *
 * Cordelia routes a photo (set) of goods staged for resale to Linda. A
 * picture tells Linda color/silhouette/condition-cues/vibe — useful for
 * the marketing copy — but NOT the facts she needs to list (brand, exact
 * size, material, true condition, flaws). So this handler does two things:
 *
 *   1. Files the item onto her shelf (Marketplace/<date>/...) with
 *      status `awaiting_facts`, capturing the VL description + OCR so the
 *      eventual draft has the visual context.
 *   2. WAKES her — resolves the seller's conversation with Linda and posts
 *      her opening message asking for the facts. Linda is mode:reactive
 *      with no wake_on_flag, so without this the routed photo would sit as
 *      a dormant inbox flag; this is what makes "a photo lands → Linda
 *      reaches out" real, exactly as her persona promises.
 *
 * When the seller replies with the facts, Linda's normal chat turn takes
 * over: she researches sold comps (web_search) and calls draft_listing to
 * emit the three platform listing cards.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { to_turn_user } from '@core/users';
import { audit_intake, date_part, mark_intake_done, slug } from '../../_intake_helpers';

function item_label(vl_description: string | undefined, ocr_text: string | undefined): string {
  // Prefer a short noun phrase from the VL description; fall back to the
  // first OCR line; else a generic label. Linda re-confirms in chat anyway.
  const vl = (vl_description ?? '').trim();
  if (vl) {
    const first = (vl.split(/[.\n]/)[0] ?? '').trim();
    if (first.length >= 3) return first.slice(0, 80);
  }
  const ocr_first = (ocr_text ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length >= 3);
  return (ocr_first ?? 'item').slice(0, 80);
}

export const intake_listing: IntakeHandler = async (input: IntakeHandlerInput) => {
  const payload = input.decision.extracted_payload;
  const vl_description = payload.vl_description;
  const ocr_text = payload.ocr_text ?? '';
  // The caption the seller typed with the photos ("can you price these out?
  // great condition"). Highest-signal instruction — thread it into the shelf
  // note + the turn so Linda addresses what they actually asked.
  const seller_note = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  const photo_count = input.decision.capture_ids.length;
  const label = item_label(vl_description, ocr_text);

  // 1. File the item onto Linda's Marketplace shelf, awaiting facts.
  const rel = `Marketplace/${date_part(new Date().toISOString())}/${input.capture_id}-${slug(label)}.md`;
  const fm: Record<string, unknown> = {
    type: 'marketplace_item',
    status: 'awaiting_facts',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    photo_count,
    vl_label: label,
    private_to: input.user_id,
  };
  const lines: string[] = [];
  lines.push(`# Marketplace item — ${label}`);
  lines.push('');
  lines.push(`**Photos**: ${photo_count}`);
  lines.push(`**Route reason**: ${input.decision.route_reason}`);
  if (seller_note) lines.push(`**Seller's note**: ${seller_note}`);
  lines.push('');
  lines.push('**Status**: awaiting seller facts (brand, size, condition, flaws, price).');
  if (vl_description) {
    lines.push('', '## What the photos show', vl_description);
  }
  if (ocr_text.length > 0) {
    lines.push('', '## OCR text (tags / labels)', '', '```', ocr_text, '```');
  }
  lines.push('', '## Source', `Capture: [[${input.note_path}|original]]`);
  input.memory.upsert_note(rel, fm, lines.join('\n'));

  // 2. Wake Linda — open (or reuse) the seller's conversation and run a REAL
  //    turn so she looks at the photo (analyze_image / ocr_image) and raises
  //    present_questions herself for the facts she still needs. Falls back to
  //    a deterministic prose greeting if the turn can't run, so the seller is
  //    never left with nothing.
  const { conversation } = input.conversations.resolve_for_user(input.user_id, 'linda');

  // Deterministic fallback greeting (also the failback if the turn errors).
  const greeting = [
    `Ooh — ${photo_count > 1 ? `${photo_count} photos` : 'a photo'} of ${label.toLowerCase().startsWith('a ') ? label : `a ${label}`} just came in. Let's get it sold.`,
    '',
    "A picture tells me a lot, but not everything buyers search for. Give me these and I'll pull comps and draft all three listings (eBay, Poshmark, Facebook Marketplace):",
    '',
    '• **Brand** (and model, if there is one)',
    '• **Size / measurements**',
    '• **Condition**, and be honest about any **flaws** (a stated flaw sells; a hidden one comes back)',
    '• **What you paid / what you’re hoping to get**',
    '• **Ship it, or local pickup only?**',
    '',
    "Reply right here and I'll take it from there.",
  ].join('\n');

  // The turn prompt is a synthetic, non-persisted nudge (same pattern as the
  // library acknowledge-addition turn): it primes Linda but the seller only
  // sees her reply + any present_questions form she raises.
  const turn_prompt = [
    `A seller just sent ${photo_count} photo${photo_count === 1 ? '' : 's'} of an item to list.`,
    seller_note ? `The seller's note with the photos: "${seller_note}" — acknowledge it and address what they asked.` : '',
    input.attachment_path ? `Primary image attachment: ${input.attachment_path}` : '',
    vl_description ? `Vision first-pass: ${vl_description}` : '',
    '',
    'Look at it NOW: call analyze_image on the attachment for color/material/styling, and ocr_image to read any tag/label text (brand, size, material, care). Then greet the seller warmly in your voice, tell them what you can see, and call present_questions to collect what you still need — condition grade and ship-vs-local as tap choices, brand / size+measurements / flaws / price as free-text. Do NOT draft yet; you need the facts first.',
  ]
    .filter(Boolean)
    .join('\n');

  let turn_ok = false;
  try {
    const user = to_turn_user(input.users.get(input.user_id));
    const out = await input.runtime.turn({
      specialist_id: 'linda',
      conversation_id: conversation.id,
      message: { role: 'user', content: turn_prompt },
      conversation_history: input.conversations
        .list_messages(conversation.id, { limit: 10 })
        .map((m) => ({
          role: m.role,
          content: m.content_md,
          specialist_id: m.specialist_id ?? undefined,
          ts: m.ts,
        })),
      user,
    });
    const msg = input.conversations.append_message({
      conversation_id: conversation.id,
      role: 'specialist',
      specialist_id: 'linda',
      content_md: out.message_text,
      surface: 'web',
    });
    input.events?.emit({
      type: 'message_added',
      conversation_id: conversation.id,
      message_id: msg.id,
      role: 'specialist',
      specialist_id: 'linda',
      content_preview: out.message_text.slice(0, 140),
    });
    turn_ok = true;
  } catch (err) {
    // Failback: post the deterministic greeting so the seller is prompted.
    console.error('[linda.intake_listing] turn failed, falling back to greeting:', err);
    const msg = input.conversations.append_message({
      conversation_id: conversation.id,
      role: 'specialist',
      specialist_id: 'linda',
      content_md: greeting,
      surface: 'web',
    });
    input.events?.emit({
      type: 'message_added',
      conversation_id: conversation.id,
      message_id: msg.id,
      role: 'specialist',
      specialist_id: 'linda',
      content_preview: greeting.slice(0, 140),
    });
  }

  mark_intake_done(input.memory, input.note_path, {
    handler: 'linda.intake_listing',
    outcome: 'noted',
    artifact_path: rel,
    summary: `Filed marketplace item "${label}" (${photo_count} photo${photo_count === 1 ? '' : 's'}); Linda ${turn_ok ? 'looked and asked the seller for facts' : 'asked the seller for facts (greeting fallback)'}.`,
  });

  audit_intake(input, {
    handler: 'linda.intake_listing',
    record_path: rel,
    item_label: label,
    photo_count,
    conversation_id: conversation.id,
  });
};
