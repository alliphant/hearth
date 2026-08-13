/**
 * Eleanor — plant photo / garden observation intake.
 *
 * Garden photos rarely come with OCR text; the VL description is
 * what the handler reads. We file an observation note onto
 * Knowledge/Eleanor/observations/<date>-<topic>.md so Eleanor's
 * deliberation pass can correlate against the yard journal.
 *
 * No proposal — Eleanor's domain is observe + propose-on-deliberation,
 * not act-now. If the description mentions pest / disease keywords,
 * we tag the note so her next pass picks it up.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { audit_intake, date_part, mark_intake_done, slug } from '../../_intake_helpers';

const ALERT_KEYWORDS = [
  'aphid', 'aphids', 'mite', 'mites', 'rust', 'blight', 'mildew', 'wilt',
  'rot', 'fungus', 'fungal', 'spot', 'spots', 'yellowing', 'chlorosis',
  'caterpillar', 'larva', 'larvae', 'eaten', 'damage', 'damaged', 'browning',
];

export const intake_plant: IntakeHandler = async (input: IntakeHandlerInput) => {
  const payload = input.decision.extracted_payload;
  const desc = payload.vl_description ?? '';
  const salient = payload.vl_salient_objects ?? [];
  const corpus = `${desc} ${salient.join(' ')}`.toLowerCase();

  const alert_hits = ALERT_KEYWORDS.filter((kw) => corpus.includes(kw));
  const date = date_part(new Date().toISOString());
  const topic_seed =
    salient.find((s) => /^[a-z]/i.test(s)) ?? (alert_hits[0] ?? 'observation');
  const rel = `Knowledge/Eleanor/observations/${date}-${slug(topic_seed)}.md`;

  const fm: Record<string, unknown> = {
    type: 'garden_observation',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    captured_on: date,
    salient_objects: salient,
    alert_keywords_present: alert_hits,
    needs_attention: alert_hits.length > 0,
    private_to: input.user_id,
  };

  const lines: string[] = [];
  lines.push(`# Garden observation — ${date}`);
  lines.push('');
  lines.push(`**Route reason**: ${input.decision.route_reason}`);
  if (desc) {
    lines.push('');
    lines.push('## VL description');
    lines.push(desc);
  }
  if (salient.length) {
    lines.push('');
    lines.push(`**Salient**: ${salient.join(', ')}`);
  }
  if (alert_hits.length) {
    lines.push('');
    lines.push(`**Alert keywords**: ${alert_hits.join(', ')}`);
  }
  lines.push('');
  lines.push('## Source');
  lines.push(`Capture: [[${input.note_path}|original]]`);

  input.memory.upsert_note(rel, fm, lines.join('\n'));

  let inbox_id: string | null = null;
  if (alert_hits.length > 0) {
    inbox_id = input.inbox.push({
      from_specialist_id: 'cordelia',
      to_specialist_id: 'eleanor',
      kind: 'fyi',
      body_md: `Garden photo with alert keyword(s) **${alert_hits.join(', ')}** — observation filed at [[${rel}]].`,
      originating_user_id: input.user_id,
    });
  }

  mark_intake_done(input.memory, input.note_path, {
    handler: 'eleanor.intake_plant',
    outcome: alert_hits.length > 0 ? 'proposed' : 'filed',
    artifact_path: rel,
    summary: alert_hits.length > 0
      ? `Garden observation with alerts: ${alert_hits.join(', ')}`
      : 'Garden observation filed',
  });

  audit_intake(input, {
    handler: 'eleanor.intake_plant',
    record_path: rel,
    alert_keywords: alert_hits,
    inbox_id: inbox_id ?? undefined,
  });
};
