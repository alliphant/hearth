/**
 * Cordelia classifier — capture → routing decision.
 *
 * VL is the routing layer. For every photo capture (when the VL
 * endpoint is reachable) we ask Qwen3.6-27B-with-mmproj to describe
 * what the image actually IS — a coffee cup, a vet bill, a plant, a
 * concert poster. The classifier then picks a destination specialist
 * using the VL description plus every other available signal:
 *
 *   - VL description + salient_objects + suggested_specialist_hint —
 *     primary signal, semantic understanding of the whole image
 *   - on-device OCR text (iOS Vision, ships in the upload) — verbatim
 *     characters; the doc-shape evidence the model needs alongside
 *     the scene-shape evidence VL gives
 *   - iOS-side classification hint (`document` | `scene` | `face`) —
 *     a cheap prior, useful when VL and OCR disagree
 *   - user_note (the typed caption that ships with the capture) —
 *     the most discriminating signal for "what is this?"-shaped
 *     intent; reaches us when the user typed something at capture
 *     time
 *
 * Pre-2026-05-27 the pipeline had a "doc-track shortcut" that skipped
 * VL when OCR was ≥ 40 chars, on the theory that text-heavy captures
 * are documents. The Dunkin' cup case
 * (c_7c4msww1vy, 2026-05-27) showed the failure mode: a coffee cup
 * with a printed order label OCR'd to 111 chars of receipt-shaped
 * text and routed to Vivian at 0.95 confidence, even though VL
 * (when re-run by hand) saw "iced coffee in a plastic cup" and
 * picked brigid at 0.95. The shortcut was using OCR length to decide
 * whether to LOOK at the image — the wrong abstraction. VL now runs
 * on every photo when reachable; OCR is the fidelity / extraction
 * layer (verbatim text for downstream extractors + FTS indexing),
 * not the routing layer.
 *
 * The OCR sidecar (HEARTH_OCR_BASE_URL) still fires as a fallback,
 * but ONLY when iOS-side OCR was empty (voice memos, share-extension
 * captures that bypass CaptureVisionEnricher) — covering the case
 * iOS Vision didn't have a chance to read.
 *
 * For a cluster (multiple captures from one user inside the 5-min
 * window), we feed ALL items in a single prompt and let the model
 * return one decision per coherent subgroup. Multi-route fan-out
 * is supported: a single capture can appear in multiple decisions
 * when the image carries independent signals justifying different
 * specialists (see `filter_secondary_routes()` below).
 *
 * Below-threshold decisions DON'T disappear — the reactive driver
 * routes them to Kate for triage via raise_interrupt. The classifier
 * never silently drops a capture.
 */

import type { LLMRouter } from '@core/llm';
import type { LoadedSpecialist } from '@core/specialist';
import type { MemoryClient } from '@memory/client';
import type { CaptureClusterItem } from '@core/capture_cluster';
import {
  analyze_image_for_classifier,
  vl_reachable_for_classifier,
  type AnalyzeImageResult,
} from '@connectors/vl';
import {
  ocr_image_for_classifier,
  ocr_reachable_for_classifier,
  type OcrImageResult,
} from '@connectors/ocr';
import { read_clipping_frontmatter } from './intake/_capture_io';

/** Length above which OCR text is "substantial" — used only as a
 *  prompt-level descriptor today (the track field in audit metadata).
 *  No longer gates whether VL runs; that gate was the doc-track
 *  shortcut and produced the Dunkin' cup misroute. */
const OCR_SUBSTANTIAL_MIN = 40;
export const ROUTING_CONFIDENCE_THRESHOLD = 0.4;

export interface ClassifierInput {
  cluster_id: string;
  user_id: string;
  items: CaptureClusterItem[];
}

export interface CordeliaRoutingDecision {
  /** Captures this decision covers — a subset of the cluster (often = all). */
  capture_ids: string[];
  /** The chosen specialist; may be 'kate' for below-threshold triage. */
  specialist_id: string;
  confidence: number;
  /** Short human-readable reason; persists into capture_routes.route_reason. */
  route_reason: string;
  /** Doc-shape extract or VL description — what the intake handler reads. */
  extracted_payload: {
    track: 'doc' | 'scene' | 'mixed' | 'unclassified';
    ocr_text?: string;
    vl_description?: string;
    vl_salient_objects?: string[];
    ios_hint?: string;
    notes?: string;
    /** Classifier-supplied "what evidence in the capture justifies this
     *  pick" — prefixed `text:`/`scene:`/`hint:`/`user_note:`. The
     *  secondary-route gate compares prefixes across decisions on the
     *  same capture so a multi-route fan-out only fires when the
     *  routes rest on genuinely different signals. */
    signal_substrate?: string;
  };
  /** True when confidence was below threshold — caller queues Kate interrupt. */
  below_threshold: boolean;
}

interface ClassifierItemContext {
  capture_id: string;
  kind: string;
  ocr_text: string;
  ocr_excerpt_source: 'ios' | 'fallback' | 'none';
  vl?: AnalyzeImageResult;
  ios_hint?: string;
  user_note?: string;
  /** Specialist the user EXPLICITLY aimed this capture at (chat-composer
   *  paperclip / macOS drop on a room). Validated against the intake roster
   *  before it's set here, so it's always a routable target. */
  routing_hint?: string;
}

export interface ClassifierDeps {
  llm: LLMRouter;
  memory: MemoryClient;
  vault_root: string;
  /** Specialists currently opted-in via proactive.intake_captures. The
   *  classifier restricts its picks to these; everything else routes
   *  to Kate. */
  intake_specialists: LoadedSpecialist[];
}

const SYSTEM_PROMPT = `You are the routing brain of a household chief-of-staff system. \
For a batch of captures (photos, voice memos, shared files) from one user, decide which \
household specialist(s) should act on them.

Each capture may carry up to five signals — weigh them ALL:

  - **VL description** — Qwen vision's read of what the image IS (a
    coffee cup, a receipt, a plant, a concert poster). This is the
    PRIMARY routing signal for photo captures. Trust it when it
    disagrees with OCR-shape: a coffee cup with a printed order
    label LOOKS like a receipt to OCR but IS a beverage.
  - **OCR text** — verbatim characters Apple Vision (iOS-side) or
    the OCR sidecar pulled off the image. Excellent for confirming
    domain (totals + payment line = receipt; ingredients list =
    food label) AND for the intake handler's extraction step. Don't
    let receipt-shaped text override a VL description that names a
    different object.
  - **iOS hint** — \`document\` / \`scene\` / \`face\`. A cheap prior;
    useful when VL and OCR disagree. \`scene\` + heavy OCR is the
    classic adversarial case (the cup).
  - **User note** — the caption the user typed at capture time. This
    is the highest-signal indicator of WHY they captured it. "What
    is the calorie count?" on a coffee cup → Brigid, not Vivian,
    regardless of how receipt-shaped the OCR is. When user_note is
    present, it should be load-bearing on the routing decision.
  - **Explicit target** — some captures say the user EXPLICITLY aimed
    them at a specialist (they attached the photo inside that
    specialist's chat, or dropped it on the specialist's room). This is
    the HIGHEST-priority signal — it outranks content. Route there with
    high confidence (>= 0.8); only override when the content is clearly
    unrelated to that specialist's domain.

Respond with ONLY a JSON object of this exact shape:

{
  "decisions": [
    {
      "capture_ids": ["c_xxxxxxxxxx", ...],
      "specialist_id": "<an id from the household roster below — NEVER an id that is not on it>",
      "confidence": 0.0-1.0,
      "route_reason": "one sentence, present-tense, what made you pick",
      "signal_substrate": "scene:\\"<short VL observation>\\" | text:\\"<short OCR excerpt>\\" | hint:\\"<ios hint reason>\\" | user_note:\\"<short quote>\\""
    }
  ]
}

Rules:
- Usually one decision per call — the whole cluster goes to one specialist (archive scans / old family photos → Cordelia, multi-shot of the same receipt → Vivian, voice memo about a plant → Eleanor).
- Split into multiple decisions when captures clearly span domains (a band poster AND a pet prescription in the same 5-minute window go to Maggie and Kate respectively — different captures, different specialists).
- **A SINGLE capture can also legitimately need multiple specialists** — emit one decision per (capture, specialist) pair. Examples: a vet bill is BOTH Vivian (cost tracking) AND Kate (the pet's household record); a coffee cup with the user asking about calories is BOTH Brigid (nutrition, from user_note) AND Vivian (purchase tracking, from receipt-shaped OCR); a utility bill (electric/gas/water — kWh, therms, gallons) is BOTH anna (energy/usage tracking, her property-energy beat) AND vivian (cost tracking). Reuse the same capture_id across multiple decisions when this happens.
- When you emit multiple decisions covering the SAME capture, the secondary needs at least confidence 0.6 AND a clearly distinct \`signal_substrate\` from the primary. Don't double-route from one signal — only when the image carries two independent signals (scene + OCR text, two different OCR excerpts, user_note + scene, etc.).
- Goods clearly staged FOR RESALE → Linda: clothing on a hanger or dress form, sneakers / a handbag / electronics shot against a plain backdrop, thrift- or estate-sale finds, price-tagged items, or a user_note saying they want to "sell", "list", or "flip" it. An item being worn or styled in a lived-in room is NOT a resale signal on its own — look for the sale intent or the deliberate product-shot staging.
- If unsure, lower the confidence — DON'T invent a specialist. confidence < 0.4 sends the capture to Kate for manual triage; that's the right outcome when you genuinely can't tell.
- \`signal_substrate\` is REQUIRED on every decision. It's the piece of evidence (scene observation, text excerpt, user-note quote, etc.) that justifies the pick. Keep it short (~80 chars) — the routing layer cites it on the secondary-route gate.
- specialist_id MUST come from the household roster below.`;

function specialist_roster_block(specialists: LoadedSpecialist[]): string {
  return specialists
    .map((s) => `- ${s.id} (${s.name}, ${s.role})`)
    .join('\n');
}

function items_block(items: ClassifierItemContext[]): string {
  return items
    .map((it, idx) => {
      const lines: string[] = [];
      lines.push(`## Capture ${idx + 1} — ${it.capture_id} (${it.kind})`);
      if (it.routing_hint) {
        lines.push(
          `EXPLICIT TARGET: the user aimed this capture directly at ${it.routing_hint} ` +
            `(attached it in ${it.routing_hint}'s chat / dropped it on their room). Strong ` +
            `prior — route to ${it.routing_hint} with high confidence unless the content is ` +
            `clearly unrelated to their domain.`,
        );
      }
      if (it.ios_hint) lines.push(`iOS hint: ${it.ios_hint}`);
      if (it.user_note) lines.push(`User note: ${it.user_note}`);
      if (it.ocr_text) {
        const excerpt = it.ocr_text.length > 1500 ? it.ocr_text.slice(0, 1500) + ' …[truncated]' : it.ocr_text;
        lines.push(`OCR text (${it.ocr_excerpt_source}):\n${excerpt}`);
      }
      if (it.vl?.available && it.vl.description) {
        lines.push(`VL description: ${it.vl.description}`);
        if (it.vl.salient_objects.length) {
          lines.push(`Salient objects: ${it.vl.salient_objects.join(', ')}`);
        }
        if (it.vl.suggested_specialist_hint && it.vl.suggested_specialist_hint !== 'unknown') {
          lines.push(`VL hint: ${it.vl.suggested_specialist_hint}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

interface RawDecision {
  capture_ids: string[];
  specialist_id: string;
  confidence: number;
  route_reason: string;
  signal_substrate: string;
}

function parse_decisions(content: string): RawDecision[] | null {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const j = JSON.parse(cleaned) as { decisions?: unknown };
    if (!Array.isArray(j.decisions)) return null;
    const out: RawDecision[] = [];
    for (const d of j.decisions) {
      if (typeof d !== 'object' || d === null) continue;
      const dd = d as Record<string, unknown>;
      const capture_ids = Array.isArray(dd.capture_ids)
        ? dd.capture_ids.filter((v): v is string => typeof v === 'string')
        : [];
      const specialist_id = typeof dd.specialist_id === 'string' ? dd.specialist_id : '';
      const confidence =
        typeof dd.confidence === 'number'
          ? Math.max(0, Math.min(1, dd.confidence))
          : 0;
      const route_reason = typeof dd.route_reason === 'string' ? dd.route_reason : '';
      const signal_substrate =
        typeof dd.signal_substrate === 'string' ? dd.signal_substrate : '';
      if (capture_ids.length === 0 || !specialist_id) continue;
      out.push({ capture_ids, specialist_id, confidence, route_reason, signal_substrate });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Secondary-route gate. When the classifier emits multiple decisions
 * covering the same capture, the FIRST (highest-confidence after sort)
 * is the primary — always kept. Each additional decision for the same
 * capture is the secondary; we accept it only when:
 *
 *   1. confidence >= SECONDARY_CONFIDENCE_MIN (0.6) — a strict bar so
 *      we don't blast every interested specialist with a weak signal,
 *   2. specialist_id differs from the primary's (no self-shadowing),
 *   3. signal_substrate prefix differs from the primary's
 *      (text:/scene:/hint:/user_note:) — the secondary must rest on
 *      a genuinely different piece of evidence in the image.
 *
 * The gate runs per-capture so a cluster of 3 captures, each with its
 * own primary + secondary, fans out cleanly without one capture's
 * secondaries contaminating another's.
 */
export const SECONDARY_CONFIDENCE_MIN = 0.6;

/**
 * Normalize a `signal_substrate` value for distinctness comparison.
 * Strips the type prefix (`text:`/`scene:`/`hint:`/`user_note:`), drops
 * surrounding quotes, lowercases, and collapses whitespace. Two
 * substrates that normalize identically came from the same signal in
 * the capture — the model just re-cited it for a second specialist.
 *
 * Substrates that normalize differently (whether same-class
 * `text:"TOTAL..."` vs `text:"Patient name..."` or cross-class
 * `text:"..."` vs `scene:"..."`) are independent signals and a
 * legitimate basis for multi-routing.
 */
function normalize_substrate(sub: string): string {
  const colon = sub.indexOf(':');
  const body = colon === -1 ? sub : sub.slice(colon + 1);
  return body
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function filter_secondary_routes(
  decisions: CordeliaRoutingDecision[],
): CordeliaRoutingDecision[] {
  // Group by capture_id while preserving the original decision order.
  const by_capture = new Map<string, CordeliaRoutingDecision[]>();
  for (const d of decisions) {
    for (const cid of d.capture_ids) {
      const bucket = by_capture.get(cid) ?? [];
      bucket.push(d);
      by_capture.set(cid, bucket);
    }
  }

  // For each capture, decide which (capture, specialist) pairs survive.
  // A pair survives iff the decision is the primary for this capture
  // OR it clears the secondary gate.
  const survivors = new Set<string>();
  for (const [cid, bucket] of by_capture.entries()) {
    // Sort by confidence desc, stable; below_threshold decisions are
    // their own primary (we don't compete them — the apply layer routes
    // them to Kate triage and that's separate from the secondary gate).
    const sorted = bucket.slice().sort((a, b) => b.confidence - a.confidence);
    const primary = sorted[0]!;
    survivors.add(`${cid}:${primary.specialist_id}`);
    if (primary.below_threshold) continue;
    // Collect every substrate already justified for this capture — the
    // primary's plus any accepted secondaries — so a third decision
    // re-citing the primary's signal AND a fourth re-citing the
    // accepted secondary's signal both get filtered.
    const accepted_substrates = new Set<string>();
    const primary_sub = normalize_substrate(
      primary.extracted_payload.signal_substrate ?? '',
    );
    if (primary_sub) accepted_substrates.add(primary_sub);
    for (const candidate of sorted.slice(1)) {
      if (candidate.below_threshold) continue;
      if (candidate.specialist_id === primary.specialist_id) continue;
      if (candidate.confidence < SECONDARY_CONFIDENCE_MIN) continue;
      const candidate_sub = normalize_substrate(
        candidate.extracted_payload.signal_substrate ?? '',
      );
      // Reject when the candidate's substrate is empty (no evidence
      // cited — the classifier didn't earn the second route) OR
      // identical to a substrate already accepted for this capture
      // (the classifier double-cited one signal).
      if (!candidate_sub) continue;
      if (accepted_substrates.has(candidate_sub)) continue;
      survivors.add(`${cid}:${candidate.specialist_id}`);
      accepted_substrates.add(candidate_sub);
    }
  }

  // Rebuild the decision list, dropping any (decision × capture_id) pair
  // that didn't survive. A decision that no longer covers any captures
  // is removed entirely.
  const out: CordeliaRoutingDecision[] = [];
  for (const d of decisions) {
    const kept_ids = d.capture_ids.filter((cid) =>
      survivors.has(`${cid}:${d.specialist_id}`),
    );
    if (kept_ids.length === 0) continue;
    out.push({ ...d, capture_ids: kept_ids });
  }
  return out;
}

export async function classify_cluster(
  input: ClassifierInput,
  deps: ClassifierDeps,
): Promise<CordeliaRoutingDecision[]> {
  const item_ctxs: ClassifierItemContext[] = [];
  let any_image = false;

  for (const item of input.items) {
    const fm = read_clipping_frontmatter(deps.memory, item.note_path);
    const meta = (fm?.extracted_metadata ?? {}) as Record<string, unknown>;
    const ios_hint =
      typeof meta.local_classification_hint === 'string'
        ? (meta.local_classification_hint as string)
        : undefined;
    const local_ocr =
      typeof meta.on_device_ocr_text === 'string'
        ? (meta.on_device_ocr_text as string)
        : (typeof meta.local_transcript_excerpt === 'string'
            ? (meta.local_transcript_excerpt as string)
            : '');
    const user_note =
      typeof meta.user_note === 'string'
        ? (meta.user_note as string)
        : undefined;
    // Explicit routing target the user set on iOS (chat-composer paperclip /
    // macOS drop on a room). Only honored when it names a specialist who can
    // actually act on a capture (opted into intake) or Kate — otherwise it's
    // noise and content routing decides. Surfaced to the model as a strong
    // prior, NOT a hard override, so the LLM still owns the call.
    const routing_hint_raw =
      typeof meta.routing_specialist_hint === 'string'
        ? (meta.routing_specialist_hint as string).trim().toLowerCase()
        : undefined;
    const routing_hint =
      routing_hint_raw &&
      (routing_hint_raw === 'kate' ||
        deps.intake_specialists.some((s) => s.id === routing_hint_raw))
        ? routing_hint_raw
        : undefined;

    let ocr_text = local_ocr;
    let ocr_source: 'ios' | 'fallback' | 'none' = ocr_text.length > 0 ? 'ios' : 'none';

    // OCR sidecar fallback — fires ONLY when iOS-side OCR is empty
    // (voice memos that don't run through CaptureVisionEnricher,
    // share-extension captures from third-party apps, etc.). For
    // any capture iOS already OCR'd, we trust those bytes.
    if (
      item.kind === 'photo' &&
      ocr_text.length === 0 &&
      ocr_reachable_for_classifier() &&
      item.attachment_path
    ) {
      const r: OcrImageResult = await ocr_image_for_classifier({
        image_path: item.attachment_path,
        vault_root: deps.vault_root,
      });
      if (r.available && r.text.length > 0) {
        ocr_text = r.text;
        ocr_source = 'fallback';
      }
    }

    // VL is the routing layer for every photo capture (no OCR-length
    // gate, no doc-track shortcut). Runs in addition to whatever OCR
    // signal we have; the classifier weighs them as parallel inputs.
    // Pre-2026-05-27 this was gated by `ocr_text.length < DOC_TEXT_MIN`
    // — the gate that let the Dunkin' cup misroute to Vivian because
    // its printed order label OCR'd to 111 chars of receipt-shaped
    // text and VL never ran to see the cup itself.
    let vl: AnalyzeImageResult | undefined;
    if (
      item.kind === 'photo' &&
      vl_reachable_for_classifier() &&
      item.attachment_path
    ) {
      any_image = true;
      vl = await analyze_image_for_classifier(
        {
          image_path: item.attachment_path,
          vault_root: deps.vault_root,
          user_note,
        },
        deps.llm,
      );
    }

    item_ctxs.push({
      capture_id: item.capture_id,
      kind: item.kind,
      ocr_text,
      ocr_excerpt_source: ocr_source,
      vl,
      ios_hint,
      user_note,
      routing_hint,
    });
  }

  // If we have NOTHING — no OCR, no VL, no notes — return one
  // below-threshold decision so Kate gets triage. Don't burn an LLM
  // call on empty input.
  const has_signal = item_ctxs.some(
    (it) => it.ocr_text.length > 0 || it.vl?.description || it.user_note || it.ios_hint || it.routing_hint,
  );
  if (!has_signal) {
    return [
      {
        capture_ids: input.items.map((i) => i.capture_id),
        specialist_id: 'kate',
        confidence: 0,
        route_reason: 'no extractable signal from OCR/VL/user-note; routing to Kate for triage',
        extracted_payload: { track: 'unclassified' },
        below_threshold: true,
      },
    ];
  }

  // `track` is informational metadata on the audit row — it describes
  // which signal carried the routing. With VL-always semantics:
  //   - `mixed`  — both substantial OCR (≥ OCR_SUBSTANTIAL_MIN chars)
  //                AND a VL description landed; classifier wove them
  //   - `doc`    — substantial OCR, no VL (provider down / unreachable)
  //   - `scene`  — no substantial OCR, VL carried the load
  //   - downstream `unclassified` is set on the final decision when
  //     signal vacuum hits earlier in this function.
  const has_substantive_doc = item_ctxs.some(
    (it) => it.ocr_text.length >= OCR_SUBSTANTIAL_MIN,
  );
  const track: 'doc' | 'scene' | 'mixed' =
    has_substantive_doc && any_image ? 'mixed'
    : has_substantive_doc ? 'doc'
    : 'scene';

  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    {
      role: 'user' as const,
      content: [
        '# Household specialists available',
        specialist_roster_block(deps.intake_specialists),
        '',
        `# Capture cluster (${input.items.length} item(s)) — user_id ${input.user_id}, track ${track}`,
        items_block(item_ctxs),
        '',
        'Reply with ONLY the JSON object described in the system message.',
      ].join('\n'),
    },
  ];

  const role = deps.llm.for_role('planner');
  const resp = await role.provider.complete({
    messages,
    temperature: 0.2,
    max_tokens: 600,
    think: false,
    ...role.defaults,
  });
  const decisions = parse_decisions(resp.content);
  if (!decisions) {
    return [
      {
        capture_ids: input.items.map((i) => i.capture_id),
        specialist_id: 'kate',
        confidence: 0,
        route_reason: `classifier returned unparseable JSON; raw: ${resp.content.slice(0, 160)}`,
        extracted_payload: { track: 'unclassified' },
        below_threshold: true,
      },
    ];
  }

  const allowed_ids = new Set(deps.intake_specialists.map((s) => s.id));
  // Always allow 'kate' as a fallback target even when she isn't opted into intake.
  allowed_ids.add('kate');

  const out: CordeliaRoutingDecision[] = [];
  for (const d of decisions) {
    const id_in_set = allowed_ids.has(d.specialist_id);
    const final_id = id_in_set ? d.specialist_id : 'kate';
    const below_threshold =
      !id_in_set || d.confidence < ROUTING_CONFIDENCE_THRESHOLD;
    const reason = id_in_set
      ? d.route_reason
      : `classifier picked unknown specialist ${d.specialist_id}; routing to Kate for triage`;
    // Carry forward signal per-capture so the intake handler reads context.
    const capture_ctxs = item_ctxs.filter((c) => d.capture_ids.includes(c.capture_id));
    const combined_ocr = capture_ctxs.map((c) => c.ocr_text).filter((t) => t.length > 0).join('\n\n---\n\n');
    const combined_vl_desc = capture_ctxs
      .map((c) => c.vl?.description)
      .filter((t): t is string => !!t)
      .join('\n\n');
    const salient = Array.from(
      new Set(capture_ctxs.flatMap((c) => c.vl?.salient_objects ?? [])),
    );
    out.push({
      capture_ids: d.capture_ids,
      specialist_id: final_id,
      confidence: d.confidence,
      route_reason: reason,
      extracted_payload: {
        track,
        ocr_text: combined_ocr || undefined,
        vl_description: combined_vl_desc || undefined,
        vl_salient_objects: salient.length > 0 ? salient : undefined,
        ios_hint: capture_ctxs.find((c) => c.ios_hint)?.ios_hint,
        notes: capture_ctxs.find((c) => c.user_note)?.user_note,
        signal_substrate: d.signal_substrate || undefined,
      },
      below_threshold,
    });
  }
  // Apply the secondary-route gate. The classifier may emit multiple
  // decisions covering the same capture (vet bill → Vivian + Anya);
  // this is where we enforce that secondaries earn their seat by
  // confidence + signal_substrate distinctness.
  return filter_secondary_routes(out);
}
