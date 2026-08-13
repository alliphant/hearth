/**
 * Kind-aware proposal rendering — `title`, `summary`, and `dedup_key`
 * computed from `(kind, payload)`.
 *
 * Why these live outside `proposals.ts`:
 *   - The rendering rules are largely kind-specific and tend to evolve
 *     as Beatrice / Kate / Mariah grow new tools. Keeping them in one
 *     file lets a session add a new kind without re-reading the store.
 *   - The functions are pure — same `(kind, payload)` always produces
 *     the same fields. That makes them safe to call at write time
 *     (during `ProposalsStore.create`) AND from the backfill script
 *     that retitles existing rows.
 *
 * `dedup_key` is the supersession discriminator. Two open proposals
 * sharing a non-null dedup_key are talking about the same subject —
 * the newer one supersedes the older. Returning `null` means "this
 * kind doesn't supersede" (action_proposals to different recipients
 * shouldn't dedup; draft_messages with different bodies shouldn't
 * either). Only kinds whose subject is unambiguously identified from
 * payload — persona tuning per target specialist, connector recovery
 * per tool, binding proposal per yaml target — opt in.
 */

import type { ProposalAction, ProposalKind } from './proposals';
import { DEFAULT_ACTIONS } from './proposals';
import { format_short_datetime } from './time';

/** Best-effort cast — payloads are JSON-stringified before they hit
 *  the DB; whoever calls these helpers already deserialized. */
type Payload = Record<string, unknown> | null | undefined;

function as_object(value: unknown): Payload {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function as_string(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

/** Trim to first non-empty line, collapse internal whitespace, cap. */
function first_line(s: string | null | undefined, max = 120): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const line = trimmed.split('\n').find((row) => row.trim().length > 0) ?? trimmed;
  const condensed = line.trim().replace(/\s+/g, ' ');
  return condensed.length > max ? condensed.slice(0, max - 1) + '…' : condensed;
}

/** N sentences from the body, suitable for a list-row subtitle.
 *  Stops on the first `. ` after a min length; falls back to the
 *  first paragraph capped. */
function summarize(s: string | null | undefined, max = 220): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const paragraph = trimmed.split(/\n\n+/, 1)[0]?.trim() ?? trimmed;
  if (paragraph.length <= max) return paragraph;
  // Look for sentence boundaries inside the cap.
  const window = paragraph.slice(0, max);
  const lastSentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  if (lastSentence > max * 0.5) {
    return window.slice(0, lastSentence + 1);
  }
  return window.replace(/\s+\S*$/, '') + '…';
}

const VALID_ACTION_STYLES = new Set<ProposalAction['style']>(['primary', 'secondary', 'destructive']);
const VALID_ACTION_EFFECTS = new Set<ProposalAction['effect']>(['execute', 'modify', 'defer', 'reject', 'noop']);

/**
 * Validate + normalize a payload-supplied `actions` array (Kate's
 * recommendation cards). Drops malformed entries and clamps style/effect to
 * the known enums so a model-authored button set can never reach the client
 * as a broken action. Returns [] when nothing usable is present, so the
 * caller falls back to the kind's default set.
 */
function normalize_custom_actions(raw: unknown): ProposalAction[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposalAction[] = [];
  for (const item of raw) {
    const o = as_object(item);
    if (!o) continue;
    const id = as_string(o.id);
    const label = as_string(o.label);
    if (!id || !label) continue;
    const style = as_string(o.style) as ProposalAction['style'] | null;
    const effect = as_string(o.effect) as ProposalAction['effect'] | null;
    const description = as_string(o.description);
    out.push({
      id,
      label,
      style: style && VALID_ACTION_STYLES.has(style) ? style : 'secondary',
      effect: effect && VALID_ACTION_EFFECTS.has(effect) ? effect : 'noop',
      ...(description ? { description } : {}),
    });
  }
  return out;
}

// ── Title rendering ──────────────────────────────────────────────────────

export function compute_proposal_title(
  kind: ProposalKind,
  payload: unknown,
  rationale_md: string,
): string {
  const p = as_object(payload);
  switch (kind) {
    case 'persona_tuning': {
      const target = as_string(p?.target_specialist_id);
      const diagnosis = as_string(p?.diagnosis);
      if (target && diagnosis) {
        return `Tune ${capitalize(target)}'s persona — ${diagnosis}`;
      }
      if (target) return `Tune ${capitalize(target)}'s persona`;
      return first_line(rationale_md) ?? 'Persona tuning';
    }
    case 'recommendation': {
      // Kate's user-facing recommendation cards carry a `headline` — the
      // concern in a few words. Beatrice's connector-recovery recs use
      // tool_name/field instead.
      const headline = as_string(p?.headline);
      if (headline) return first_line(headline) ?? headline;
      const tool = as_string(p?.tool_name);
      const field = as_string(p?.recovery_field_name);
      if (tool && field) {
        return `Add \`${field}\` to ${tool} on error path`;
      }
      // Generic recommendation — fall back to payload.summary if present.
      const summary = as_string(p?.summary);
      if (summary) return first_line(summary) ?? summary;
      return first_line(rationale_md) ?? 'Recommendation';
    }
    case 'binding_proposal': {
      const target_yaml = as_string(p?.specialist_yaml)
        ?? as_string(p?.target_yaml);
      const change = as_string(p?.change_summary) ?? as_string(p?.summary);
      if (target_yaml && change) return `Update ${target_yaml}: ${change}`;
      if (target_yaml) return `Update ${target_yaml}`;
      return first_line(rationale_md) ?? 'Binding proposal';
    }
    case 'draft_message': {
      // Payload sometimes wraps recipient as { recipient: { name, id } }
      // and sometimes flat as recipient_name / recipient_id. Tolerate both.
      const recipientObj = as_object(p?.recipient);
      const name = as_string(recipientObj?.name)
        ?? as_string(p?.recipient_name)
        ?? as_string(recipientObj?.id)
        ?? as_string(p?.recipient_id);
      const subject = as_string(p?.subject);
      if (name && subject) return `Draft to ${name}: ${subject}`;
      if (name) return `Draft to ${name}`;
      return first_line(rationale_md) ?? 'Draft message';
    }
    case 'briefing': {
      const title = as_string(p?.title);
      if (title) return title;
      return first_line(rationale_md) ?? 'Briefing';
    }
    case 'calendar_event': {
      const title = as_string(p?.title);
      const startISO = as_string(p?.ts_start) ?? as_string(p?.start_date);
      // A `replaces_event_id` marks a reschedule, not a fresh add — say so.
      const prefix = as_string(p?.replaces_event_id) ? 'Move: ' : '';
      if (title && startISO) {
        const startLabel = format_short_datetime(startISO);
        return startLabel ? `${prefix}${title} — ${startLabel}` : `${prefix}${title}`;
      }
      if (title) return `${prefix}${title}`;
      return first_line(rationale_md) ?? 'Calendar event';
    }
    case 'action_proposal': {
      // action_proposal payloads vary by tool. The convention that's
      // emerging: message-sending tools nest under `message`, with a
      // recipient + body. Others put a `summary` or `action_description`.
      const messageObj = as_object(p?.message);
      const messageBody = messageObj
        ? as_string(messageObj.body_md) ?? as_string(messageObj.body)
        : null;
      const recipient = messageObj
        ? as_string(messageObj.to_specialist_id)
          ?? as_string(messageObj.to_specialist)
          ?? as_string(messageObj.to)
        : null;
      if (recipient && messageBody) {
        return `Message ${capitalize(recipient)}: ${truncate(messageBody, 60)}`;
      }
      const summary = as_string(p?.summary) ?? as_string(p?.action_description);
      if (summary) return first_line(summary) ?? summary;
      return first_line(rationale_md) ?? 'Action proposal';
    }
    case 'book_candidate': {
      const title = as_string(p?.title_candidate);
      const author = as_string(p?.author_candidate);
      if (title && author) return `Book — ${title} (${author})`;
      if (title) return `Book — ${title}`;
      return first_line(rationale_md) ?? 'Book candidate';
    }
    case 'trusted_source_addition': {
      const domain = as_string(p?.domain);
      const target = as_string(p?.target_specialist_id);
      const tier = typeof p?.tier === 'number' ? (p.tier as number) : null;
      if (domain && target && tier) {
        return `Add ${domain} → ${capitalize(target)}'s Tier ${tier} sources`;
      }
      return first_line(rationale_md) ?? 'Trusted source addition';
    }
    case 'scrum_decision': {
      const question = as_string(p?.question);
      const sprint = as_string(p?.sprint_label);
      const isCommit = as_string(p?.dispatch_tool) != null;
      if (isCommit) return sprint ? `Commit sprint ${sprint}` : question ?? 'Commit sprint';
      if (question) return `Scrum: ${truncate(question, 80)}`;
      return first_line(rationale_md) ?? 'Scrum decision';
    }
    case 'face_enrollment': {
      const name = as_string(p?.person_name);
      if (name) return `Recurring face at the door — is it ${capitalize(name)}?`;
      const n = typeof p?.sighting_count === 'number' ? (p.sighting_count as number) : null;
      return n ? `Who is this? A face seen ${n} times` : 'Who is this recurring face?';
    }
    default:
      return first_line(rationale_md) ?? kind;
  }
}

// ── Summary rendering ─────────────────────────────────────────────────────

export function compute_proposal_summary(
  kind: ProposalKind,
  payload: unknown,
  rationale_md: string,
): string | null {
  const p = as_object(payload);
  switch (kind) {
    case 'persona_tuning': {
      const proposed = as_string(p?.proposed_change);
      if (proposed) return summarize(proposed);
      return summarize(rationale_md);
    }
    case 'recommendation': {
      const fieldDesc = as_string(p?.recovery_field_description);
      const blast = typeof p?.blast_radius === 'number'
        ? p.blast_radius as number
        : null;
      const blastNote = blast != null && blast > 0
        ? ` Closes ${blast} open ${blast === 1 ? 'miss' : 'misses'}.`
        : '';
      if (fieldDesc) {
        return summarize(fieldDesc) + blastNote;
      }
      const summary = as_string(p?.summary);
      if (summary) return summarize(summary);
      return summarize(rationale_md);
    }
    case 'draft_message': {
      const body = as_string(p?.body_md) ?? as_string(p?.body);
      if (body) return summarize(body);
      return summarize(rationale_md);
    }
    case 'calendar_event': {
      const location = as_string(p?.location);
      const notes = as_string(p?.notes);
      if (location && notes) {
        return summarize(`${notes} (${location})`);
      }
      if (location) return `At ${location}.`;
      if (notes) return summarize(notes);
      return summarize(rationale_md);
    }
    case 'book_candidate': {
      // The rationale sentence intake_book sets is the right summary
      // (mentions the title + the three legitimate outcomes). Fall
      // back to a brief fixed sentence when payload is sparse.
      return summarize(rationale_md);
    }
    case 'trusted_source_addition': {
      const just = as_string(p?.justification);
      const candidate = as_string(p?.candidate_title) ?? as_string(p?.candidate_url);
      if (just && candidate) return summarize(`${candidate}. ${just}`);
      if (just) return summarize(just);
      return summarize(rationale_md);
    }
    case 'scrum_decision': {
      const rec = as_string(p?.recommendation);
      if (rec) return summarize(`Beatrice recommends: ${rec}`);
      return summarize(rationale_md);
    }
    case 'face_enrollment': {
      // The rationale carries the full evidence sentence (seen N times,
      // exclusive-presence correlation) — exactly the right summary.
      return summarize(rationale_md);
    }
    case 'briefing':
    case 'action_proposal':
    case 'binding_proposal':
    default:
      return summarize(rationale_md);
  }
}

// ── Dedup key (supersession discriminator) ────────────────────────────────

/**
 * Returns a string that identifies the *subject* of a proposal. Two
 * open proposals sharing a non-null dedup_key are talking about the
 * same subject — the newer one supersedes the older.
 *
 * Returning `null` means "don't supersede" — the kind doesn't have a
 * clean subject identity (action_proposal generally, draft_message
 * unless we trust subject lines, etc.). Better to leave those as
 * independent rows the user can manually compare than to risk
 * suppressing a meaningfully-different proposal.
 */
export function compute_dedup_key(
  kind: ProposalKind,
  payload: unknown,
): string | null {
  const p = as_object(payload);
  switch (kind) {
    case 'persona_tuning': {
      const target = as_string(p?.target_specialist_id);
      // Only supersede when we know which specialist the tuning is
      // for — without that, we'd collapse all persona-tunings into
      // one queue slot.
      return target ? `persona_tuning:${target}` : null;
    }
    case 'recommendation': {
      // Kate's recommendations: keyed by concern-class so re-escalating the
      // same unresolved concern supersedes the older card (and the same key
      // anchors the autonomy signature). Prefer an explicit concern_key,
      // fall back to the originating source_ref.
      const concern = as_string(p?.concern_key) ?? as_string(p?.source_ref);
      if (concern) return `recommendation:concern:${concern}`;
      // Connector-recovery recommendations are a TEMPLATE swept across the
      // tool registry, not per-tool work — so they key on the PATTERN, not
      // the tool.
      //
      // Keying by tool (what this did until 2026-07-31) gives the sweep one
      // queue slot per tool in the registry: "Add `candidates` to <tool> on
      // error path" was filed 79 times across 28 distinct tools between
      // 2026-05-25 and 2026-07-29, and exactly one ever executed. Each was
      // a different `recommendation:tool:*` key, so supersession — working
      // exactly as designed — never collapsed any of them against each
      // other. The ceiling was template × registry rather than one proposal.
      //
      // One open slot per pattern means the next instance of a sweep has to
      // wait for the current one to actually land. That is the intended
      // pressure: with the recovery envelope now central (`with_candidates`,
      // #231), a per-tool instance is a two-line call, so there is no
      // legitimate need for 28 simultaneous open proposals about it.
      const recovery_field = as_string(p?.recovery_field_name);
      if (recovery_field) {
        return `recommendation:pattern:connector_recovery:${recovery_field}`;
      }
      // Other tool-scoped recommendations stay keyed by tool: a genuine
      // per-tool contract fix (rename this field on THAT tool) really is a
      // distinct subject, and collapsing those would hide real work.
      const tool = as_string(p?.tool_name);
      const slug = as_string(p?.slug);
      if (tool) return `recommendation:tool:${tool}`;
      // Generic recommendation may carry a slug (binding-proposal
      // markdown path); fall back to that.
      if (slug) return `recommendation:slug:${slug}`;
      return null;
    }
    case 'binding_proposal': {
      // Binding-proposal slug is the canonical subject — Beatrice
      // writes the markdown to `Knowledge/Trainer/binding-proposals/
      // <slug>.md` and re-files when the proposal needs refinement.
      const slug = as_string(p?.slug);
      const target = as_string(p?.specialist_yaml) ?? as_string(p?.target_yaml);
      const change = as_string(p?.change_summary);
      if (slug) return `binding_proposal:slug:${slug}`;
      if (target && change) return `binding_proposal:${target}:${change}`;
      return null;
    }
    case 'calendar_event': {
      // Same calendar event proposed twice (different language, same
      // start time + title) should collapse. Anchor on title +
      // ts_start since two distinct events with the same title at
      // different times are valid.
      const title = as_string(p?.title);
      const start = as_string(p?.ts_start) ?? as_string(p?.start_date);
      if (title && start) return `calendar_event:${start}:${title}`;
      return null;
    }
    case 'book_candidate': {
      // Anchor on the queue note path — re-firing intake_book on the
      // same capture (e.g. via /api/cordelia/reclassify/:id) collapses
      // through the existing supersession mechanism instead of
      // surfacing a duplicate decision form.
      const queue_path = as_string(p?.queue_note_path);
      if (queue_path) return `book_candidate:${queue_path}`;
      return null;
    }
    case 'trusted_source_addition': {
      // Dedup on (target_specialist, domain). Cordelia re-proposing
      // the same domain for the same specialist supersedes (the user
      // hasn't acted yet; she's refining her justification with a
      // newer candidate URL). A different specialist gets its own row.
      const target = as_string(p?.target_specialist_id);
      const domain = as_string(p?.domain);
      if (target && domain) return `trusted_source_addition:${target}:${domain}`;
      return null;
    }
    case 'scrum_decision': {
      // A commit gate supersedes the prior one for the same sprint; a judgment
      // call supersedes a re-ask of the same question.
      const sprint = as_string(p?.sprint_label);
      if (as_string(p?.dispatch_tool) && sprint) return `scrum_decision:commit:${sprint}`;
      const question = as_string(p?.question);
      if (question) return `scrum_decision:q:${question.toLowerCase().slice(0, 80)}`;
      return null;
    }
    case 'face_enrollment': {
      // One card per face cluster — a re-file about the same cluster (e.g.
      // with more sightings) supersedes rather than stacking duplicates.
      const cluster = as_string(p?.cluster_id);
      if (cluster) return `face_enrollment:${cluster}`;
      return null;
    }
    case 'action_proposal': {
      // Miss-batch actions: an action_proposal whose payload names a
      // set of process-miss ids + an action has a real subject — the
      // (action, id-set) pair. The 2026-06-08 twins ("15 escalated
      // misses already routed to Beatrice", filed twice one minute
      // apart with reworded summaries) shared exactly this subject and
      // sat in the owner's queue as duplicates. Generic
      // action_proposals (no miss_ids) keep no key — no safe subject.
      const miss_ids = Array.isArray(p?.miss_ids)
        ? (p.miss_ids as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
      const action = as_string(p?.action);
      if (miss_ids.length > 0 && action) {
        return `action_proposal:misses:${action}:${miss_ids.slice().sort().join(',')}`;
      }
      return null;
    }
    case 'briefing': {
      // A briefing's subject is its topic (plus the event it serves, when
      // present). A re-prepared briefing on the same topic supersedes the
      // stale unread offer instead of stacking a second card — the
      // 2026-06-10 "Kate pending interrupts escalation" twins. Depth is
      // deliberately NOT part of the subject: a thorough re-prep replaces
      // the quick one.
      const topic = as_string(p?.topic);
      const for_event = as_string(p?.for_event);
      if (topic) {
        const topic_norm = topic.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
        return `briefing:${topic_norm}${for_event ? `:${for_event}` : ''}`;
      }
      return null;
    }
    case 'draft_message':
    default:
      // No safe subject — leave as independent rows.
      return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  const condensed = s.replace(/\s+/g, ' ').trim();
  return condensed.length > max ? condensed.slice(0, max - 1) + '…' : condensed;
}

/**
 * Tappable action set for a proposal — what the user sees as buttons
 * on iOS / web. Computed at create time and persisted into
 * `actions_json`; clients render exactly this list.
 *
 * Each kind chooses verbs that match what "approve" actually MEANS
 * for it — `draft_message` says "Send" not "Approve" because that's
 * the honest verb. `book_candidate` is a 3-way choice (Acquire /
 * File only / Skip) where every option is a legitimate outcome, not
 * a yes/no.
 *
 * Effect semantics drive the decide handler's dispatch:
 *   - `execute` → run the side effect (send the message, add the
 *     event, mutate the queue note, etc.). The decide handler's
 *     existing `dispatch_tool` path or a kind-specific resolver
 *     produces the effect.
 *   - `modify` → the user wants to revise; mark approved, kind's
 *     resolver decides what "revise" means. v0.1 stubs these as a
 *     proposal re-open with a user_feedback marker; the full
 *     edit-then-resubmit flow lands later.
 *   - `defer` → snooze 24h, reappears tomorrow.
 *   - `reject` → mark denied; trains autonomy graduation negatively.
 *   - `noop` → mark approved with no side effect (briefing
 *     acknowledged, no further work to do).
 */
export function compute_proposal_actions(
  kind: ProposalKind,
  payload: unknown,
): ProposalAction[] {
  const p = as_object(payload);
  switch (kind) {
    case 'draft_message': {
      // Payload-aware label: prefer the recipient's name when we can
      // resolve one so the user sees "Send to Alex" not the generic
      // "Send." Resolution mirrors compute_proposal_title — recipient
      // sometimes nests under `recipient.{name,id}` and sometimes flat
      // as recipient_name / recipient_id. Tolerate both shapes; fall
      // through to generic "Send" when we have nothing.
      const recipientObj = as_object(p?.recipient);
      const name = as_string(recipientObj?.name)
        ?? as_string(p?.recipient_name)
        ?? as_string(recipientObj?.id)
        ?? as_string(p?.recipient_id);
      const sendLabel = name ? `Send to ${name}` : 'Send';
      const sendDesc = name
        ? `Send the draft to ${name} as written.`
        : 'Send the draft as written.';
      return [
        { id: 'send', label: sendLabel, style: 'primary', effect: 'execute',
          description: sendDesc },
        { id: 'edit', label: 'Edit draft', style: 'secondary', effect: 'modify',
          description: 'Revise before sending — the draft re-opens with your changes.' },
        { id: 'discard', label: 'Discard', style: 'destructive', effect: 'reject',
          description: "Don't send. The draft is lost." },
      ];
    }
    case 'calendar_event': {
      // A `replaces_event_id` marks a reschedule — the primary action
      // moves the existing event rather than adding a new one.
      const moving = Boolean(as_string(p?.replaces_event_id));
      return [
        { id: 'add', label: moving ? 'Move event' : 'Add to calendar', style: 'primary', effect: 'execute',
          description: moving
            ? 'Relocate the existing event on your calendar via iOS EKEventStore.'
            : 'Write the event to your calendar via iOS EKEventStore.' },
        { id: 'edit_time', label: 'Edit time', style: 'secondary', effect: 'modify',
          description: 'Reschedule before adding — the specialist will revise.' },
        { id: 'skip', label: 'Skip', style: 'destructive', effect: 'reject',
          description: "Don't add. The event is dismissed." },
      ];
    }
    case 'persona_tuning':
      return [
        { id: 'apply', label: 'Apply', style: 'primary', effect: 'execute',
          description: "Apply Beatrice's persona edit to the target specialist." },
        { id: 'revise', label: 'Revise', style: 'secondary', effect: 'modify',
          description: 'Send Beatrice back with your feedback for a refined version.' },
        { id: 'reject', label: 'Reject', style: 'destructive', effect: 'reject',
          description: "Don't apply. The persona stays as-is." },
      ];
    case 'binding_proposal':
      return [
        { id: 'open_pr', label: 'Open PR', style: 'primary', effect: 'execute',
          description: "Trigger Beatrice's propose_code_change for the binding." },
        { id: 'defer', label: 'Defer', style: 'secondary', effect: 'defer',
          description: 'Reappears in the queue tomorrow.' },
        { id: 'reject', label: 'Reject', style: 'destructive', effect: 'reject',
          description: "Don't open a PR." },
      ];
    case 'recommendation': {
      // Kate's recommendation cards supply their own context-sensitive
      // buttons (label + effect) in `payload.actions` — honor them when
      // present + well-shaped. Otherwise fall back to the generic
      // Apply / Defer / Reject set (Beatrice's connector-recovery recs).
      const custom = normalize_custom_actions(p?.actions);
      if (custom.length) return custom;
      return [
        { id: 'apply', label: 'Apply', style: 'primary', effect: 'execute',
          description: 'Acknowledge and act on the recommendation.' },
        { id: 'defer', label: 'Defer', style: 'secondary', effect: 'defer',
          description: 'Reappears in the queue tomorrow.' },
        { id: 'reject', label: 'Reject', style: 'destructive', effect: 'reject',
          description: 'Dismiss the recommendation.' },
      ];
    }
    case 'action_proposal': {
      // Payload-aware verb selection. action_proposal is a wildcard
      // kind — the actual operation could be sending a message,
      // cancelling a subscription, scheduling a follow-up, dispatching
      // a tool call, etc. The user shouldn't have to read the
      // rationale_md to know what "Run" means. Pull the most-specific
      // verb we can derive from payload shape.
      //
      // Resolution order:
      //   1. payload.tool_name → "Run <tool_name>" (most precise)
      //   2. payload.message.* → "Send to <recipient>" (matches the
      //      title-renderer convention for message-shaped action props)
      //   3. payload.verb / payload.action / payload.action_verb (an
      //      explicit hint Beatrice or Kate can set)
      //   4. Fall through to generic "Run"
      let primaryLabel = 'Run';
      let primaryDesc = 'Execute the proposed action.';
      const tool = as_string(p?.tool_name);
      const messageObj = as_object(p?.message);
      const recipient = messageObj
        ? as_string(messageObj.to_specialist_id)
          ?? as_string(messageObj.to_specialist)
          ?? as_string(messageObj.to)
        : null;
      const explicitVerb = as_string(p?.verb)
        ?? as_string(p?.action)
        ?? as_string(p?.action_verb);
      if (tool) {
        primaryLabel = `Run ${tool}`;
        primaryDesc = `Execute the proposed call to \`${tool}\`.`;
      } else if (recipient) {
        primaryLabel = `Send to ${capitalize(recipient)}`;
        primaryDesc = `Dispatch the message to ${capitalize(recipient)}.`;
      } else if (explicitVerb) {
        primaryLabel = capitalize(explicitVerb);
        primaryDesc = `Execute: ${explicitVerb}.`;
      }
      if (!tool && !recipient && !explicitVerb) {
        // No executable action in the payload — this is an FYI /
        // observation, not something to "Run". A misleading execute
        // verb on a non-actionable card is the "actions don't line up
        // to a real button" bug; the honest outcomes are acknowledge or
        // clear. (Creation-side, brief-slot observations no longer reach
        // here at all — see kate.yaml tools_for_deliberation — so this
        // is the defense-in-depth for any chat-originated FYI.)
        return [
          { id: 'got_it', label: 'Got it', style: 'primary', effect: 'noop',
            description: 'Acknowledge — there is nothing to execute.' },
          { id: 'dismiss', label: 'Dismiss', style: 'destructive', effect: 'reject',
            description: 'Clear it from the queue.' },
        ];
      }
      return [
        { id: 'run', label: primaryLabel, style: 'primary', effect: 'execute',
          description: primaryDesc },
        { id: 'modify', label: 'Modify', style: 'secondary', effect: 'modify',
          description: 'Send back with revisions before running.' },
        { id: 'reject', label: 'Reject', style: 'destructive', effect: 'reject',
          description: "Don't run." },
      ];
    }
    case 'briefing':
      return [
        { id: 'got_it', label: 'Got it', style: 'primary', effect: 'noop',
          description: 'Mark as read.' },
        { id: 'discuss', label: 'Discuss', style: 'secondary', effect: 'modify',
          description: 'Open Kate to talk through the brief.' },
        { id: 'snooze', label: 'Snooze', style: 'destructive', effect: 'defer',
          description: 'Push to the next slot.' },
      ];
    case 'book_candidate':
      // The three legitimate outcomes for a captured book cover. All
      // three are `execute` because each one produces a concrete
      // queue-note mutation — there's no "reject" semantic; even
      // "Skip" is the user explicitly closing the loop.
      return [
        { id: 'acquire', label: 'Find a copy', style: 'primary', effect: 'execute',
          description: 'Hunt for an OA / library / Readarr copy at the 04:00 pass.' },
        { id: 'file_only', label: 'Just file the note', style: 'secondary', effect: 'execute',
          description: "Keep the queue entry for reference — don't spend effort acquiring." },
        { id: 'skip', label: 'Skip', style: 'destructive', effect: 'execute',
          description: 'Mark the queue note as skipped; treat as a non-acquisition.' },
      ];
    case 'trusted_source_addition':
      return [
        { id: 'add', label: 'Add to trusted_sources', style: 'primary', effect: 'execute',
          description: "Patch the specialist's YAML in place — comment-preserving via the YAML Document API." },
        // `execute`, not `modify`: the kind's resolver handles tier_swap
        // deterministically (append to the OPPOSITE tier) — a modify effect
        // short-circuits to acknowledged before the resolver block runs.
        { id: 'tier_swap', label: 'Add at other tier', style: 'secondary', effect: 'execute',
          description: 'Approve the domain but flip the tier (Tier 1 ↔ Tier 2).' },
        { id: 'reject', label: 'Reject', style: 'destructive', effect: 'reject',
          description: "Don't add. The domain is recorded as denied so Cordelia doesn't re-propose." },
      ];
    case 'scrum_decision': {
      // A sprint-commit gate is filed with a dispatch_tool — approval RUNS the
      // commit (scrum_sprint_write). A judgment call carries `options`; each
      // becomes a button whose pick is recorded in action_taken (execution_kind
      // 'none', no dispatch) so Beatrice reads the resolution next grooming pass.
      const dispatch = as_string(p?.dispatch_tool);
      if (dispatch) {
        return [
          { id: 'commit', label: 'Commit', style: 'primary', effect: 'execute',
            description: 'Commit these epics to the sprint.' },
          { id: 'hold', label: 'Hold', style: 'destructive', effect: 'reject',
            description: "Don't commit yet — Beatrice re-grooms." },
        ];
      }
      const raw = Array.isArray(p?.options) ? (p!.options as unknown[]) : [];
      const opts = raw
        .map((o) => as_object(o))
        .map((o) => ({ id: as_string(o?.id), label: as_string(o?.label), description: as_string(o?.description) }))
        .filter((o): o is { id: string; label: string; description: string | null } => !!o.id && !!o.label);
      if (opts.length > 0) {
        const actions: ProposalAction[] = opts.map((o, i) => ({
          id: o.id,
          label: o.label,
          style: i === 0 ? 'primary' : 'secondary',
          effect: 'execute',
          description: o.description ?? undefined,
        }));
        actions.push({
          id: 'park', label: 'Decide later', style: 'secondary', effect: 'defer',
          description: 'Reappears at the next standup.',
        });
        return actions;
      }
      // Free-form decision — record the answer (user_feedback) or park it.
      return [
        { id: 'resolve', label: 'Resolve', style: 'primary', effect: 'execute',
          description: 'Record your answer; Beatrice picks it up next grooming pass.' },
        { id: 'park', label: 'Decide later', style: 'secondary', effect: 'defer',
          description: 'Reappears at the next standup.' },
      ];
    }
    case 'face_enrollment': {
      const name = as_string(p?.person_name);
      // "Who is this?" shape — one button per household member.
      if (!name && Array.isArray(p?.options)) {
        const member_actions: ProposalAction[] = (p!.options as unknown[])
          .map((o) => as_object(o))
          .map((o) => ({ id: as_string(o?.id), name: as_string(o?.name) }))
          .filter((o): o is { id: string; name: string } => !!o.id && !!o.name)
          .map((o, i) => ({
            id: o.id,
            label: `It's ${capitalize(o.name)}`,
            style: i === 0 ? ('primary' as const) : ('secondary' as const),
            effect: 'execute' as const,
            description: `Enroll this face's sighting crops as ${capitalize(o.name)} — recognized by name from now on.`,
          }));
        return [
          ...member_actions,
          { id: 'new_person', label: 'New person…', style: 'secondary', effect: 'execute',
            description: 'Name them — starts a fresh friend entry and enrolls these shots under it.' },
          { id: 'not_them', label: 'Not a person / ignore', style: 'destructive', effect: 'reject',
            description: 'Dismiss this face for good — never asked about again.' },
          { id: 'keep_watching', label: 'Keep watching', style: 'secondary', effect: 'defer',
            description: 'Not sure yet — re-surfaces tomorrow with any new sightings.' },
        ];
      }
      const who = name ?? 'them';
      return [
        { id: 'enroll', label: `Yes — it's ${capitalize(who)}`, style: 'primary', effect: 'execute',
          description: `Enroll this face's sighting crops as ${capitalize(who)} — recognized by name from now on, reference set kept fresh automatically.` },
        { id: 'new_person', label: 'No — new person…', style: 'secondary', effect: 'execute',
          description: 'Someone else — name them to start a fresh friend entry with these shots.' },
        { id: 'not_them', label: 'Not a person / ignore', style: 'destructive', effect: 'reject',
          description: 'Dismiss this face — never asked about again (retention cleans it up).' },
        { id: 'keep_watching', label: 'Keep watching', style: 'secondary', effect: 'defer',
          description: 'Not sure yet — re-surfaces tomorrow with any new sightings.' },
      ];
    }
    default: {
      // Future-compat: a new kind without a switch arm renders the
      // generic Approve/Deny set, but we log so the gap shows up in
      // the orchestrator log (and downstream audits) instead of
      // silently shipping the bland labels. When you see this warning
      // for a kind that ships often, add a case above with the right
      // verbs. The fallback existing was the source of flag
      // `01KSVPWF1V0Z1NPRX6P6GA5FT3` (action-label generics).
      console.warn(
        `[proposal_render] no action-label case for kind="${kind}" — ` +
          `falling back to generic Approve/Deny. Add a switch arm to ` +
          `compute_proposal_actions() with verbs that match what ` +
          `"approve" actually MEANS for this kind.`,
      );
      return DEFAULT_ACTIONS;
    }
  }
}

