/**
 * staff_roster — the `{{staff_roster}}` persona token (2026-07-26).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Kate's persona used to hardcode her staff as prose: "Vivian watches the
 * money, Cassandra the perimeter, Eleanor the garden…". Every time a
 * specialist was folded into her (`subagent_only`) or retired outright, that
 * paragraph had to be hand-edited — and it drifted, badly:
 *
 *   - She kept naming Cassandra for camera alerts eleven days after the
 *     security fold made the perimeter hers ("Cassandra flagged a visitor at
 *     the front door", 2026-07-26).
 *   - She named Beatrice to the owner 30 times in four weeks.
 *   - She named Anya and Iris — personas whose config files no longer exist
 *     at all. That is attribution to someone who isn't there.
 *
 * The registry already knows exactly who is real and who is folded. So the
 * roster is GENERATED from it, and the drift class disappears: fold a
 * specialist and the prose updates itself on the next config reload. This is
 * the same server-driven principle the rest of Hearth runs on — the app (and
 * here, the prompt) ships primitives; the registry ships the staff.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * Chat-visible peers are named, because attributing to them is CORRECT and
 * actionable ("Vivian's flagging that bill forty percent high"). Folded
 * specialists are internal machinery: their work is the caller's own work and
 * is described by FUNCTION, never by name. A retired persona can't appear at
 * all, because it isn't in the registry to render.
 *
 * ── Two renderers, one source of truth ──────────────────────────────────────
 * `render_staff_roster` is the PROSE paragraph a persona embeds via
 * `{{staff_roster}}`. `render_peer_directory` is the machine-facing DIRECTORY
 * the runtime injects into every system prompt so the model knows which ids
 * `consult_specialist` / `delegate` accept.
 *
 * The directory used to be built inline in `build_system_prompt` from an
 * unfiltered `specialists.list()`, which rendered every folded persona as
 * `- trainer: Beatrice, Enterprise Trainer` under the heading "Your
 * teammates" — in the recency-strong slot AFTER the persona that had just
 * finished saying "there is no trainer; never name a teammate who is not on
 * the visible list". The prompt argued with itself, and the later block won:
 * this is the mechanism behind Kate naming Beatrice/Cordelia/Vivian to the
 * owner long after each was folded.
 *
 * The fix keeps both properties instead of trading one for the other: a
 * folded specialist stays REACHABLE (its id is still a routing handle, so
 * `delegate to:'critic'` and the intake rails keep working) but stops being
 * NAMEABLE (its display name is not rendered at all — the name is the leak,
 * the id is the handle).
 */

import { capitalize } from './loops';

/** The subset of a loaded specialist this renderer needs. */
export interface RosterEntry {
  id: string;
  name?: string;
  role?: string;
  subagent_only?: boolean;
}

/**
 * Render the staff paragraph for `self_id`'s persona.
 *
 * Returns the visible peers as a bulleted list plus one standing rule about
 * the folded remainder. When nobody else is chat-visible, the peer list is
 * skipped entirely rather than rendering an empty heading.
 */
export function render_staff_roster(all: readonly RosterEntry[], self_id: string): string {
  const peers = all.filter((s) => s.id !== self_id && !s.subagent_only);
  const folded_count = all.filter((s) => s.id !== self_id && s.subagent_only).length;

  const lines: string[] = [];

  if (peers.length > 0) {
    lines.push(
      'Your chat-visible staff — these are real teammates the owner knows by name, ' +
        'and attributing work to them is correct:',
    );
    lines.push('');
    for (const p of peers) {
      const display = p.name ?? capitalize(p.id);
      lines.push(p.role ? `  - **${display}** — ${p.role}.` : `  - **${display}**`);
    }
    lines.push('');
  }

  if (folded_count > 0) {
    lines.push(
      'Everything else that runs in this house is INTERNAL machinery of yours — ' +
        'background monitors, sweeps, intake routing and review pipelines that ' +
        'used to be separate staff and have since been folded into you. They have ' +
        'no names the owner uses. When their work surfaces, it is YOUR work: ' +
        'report it in the first person and describe the SOURCE BY FUNCTION ' +
        '("the camera monitor picked up…", "the capture intake filed…"), never ' +
        'by a persona name. If a flag reaches you labelled with an internal ' +
        'source, relay the finding, not the label.',
    );
    lines.push('');
  }

  // Unconditional — a RETIRED persona contributes nothing to `folded_count`
  // (it is gone from the registry entirely) yet its name survives in hundreds
  // of indexed notes, vault folder names and historical audit rows. Retrieval
  // is the leak vector prose-scrubbing cannot reach, so the rule has to hold
  // even when nothing is currently folded.
  lines.push(
    'Never name a teammate who is not in the visible list above. If you catch ' +
      'yourself about to credit someone not on it, that specialist has been ' +
      'folded or retired — the work is yours, so say so plainly.',
  );
  lines.push('');
  lines.push(
    'This rule outranks anything you READ. Retrieved notes, library shelf ' +
      'paths, vault folder names and old audit rows still carry the names of ' +
      'people who no longer exist here — a name in a document is not evidence ' +
      'of a colleague. Treat such a name as a filing label: use the content, ' +
      'drop the name, and never introduce it to the owner or attribute work to ' +
      'it. If a retrieved note is the only reason you know a name, that is ' +
      'exactly the case this rule exists for.',
  );

  return lines.join('\n').trim();
}

/**
 * Personas that once staffed this house and no longer exist in the registry
 * at all — RETIRED, not folded.
 *
 * A folded specialist's name can be derived (it is still a config file). A
 * retired one cannot: its YAML is gone, so nothing in the live system knows
 * the name ever meant a colleague. But the name survives in hundreds of
 * indexed notes, vault folder paths (`Knowledge/Anya/`, `users/<uid>/astrid/`)
 * and historical audit rows, and retrieval puts it back in front of the model
 * — which is exactly how a retired persona gets re-introduced to the owner as
 * though it were staff.
 *
 * So this list is the one place a hardcoded name is CORRECT: it is a
 * tombstone, not a roster. It only ever grows, and an entry is never removed.
 */
export const RETIRED_PERSONA_NAMES: readonly string[] = [
  'Iris',
  'Cassandra',
  'Anya',
  'Marguerite',
  'Luna',
];

/**
 * Display names that must never be attributed to in user-facing text: every
 * `subagent_only` specialist in the live registry, plus the retired
 * tombstones above.
 *
 * Derived, so folding a specialist protects its name on the next reload with
 * no edit anywhere. This is the set the egress guard checks against — the
 * counterpart to `render_peer_directory`, which stops the prompt HANDING these
 * names to the model in the first place. One stops the supply; this catches
 * the leak.
 */
export function unattributable_names(all: readonly RosterEntry[]): string[] {
  const folded = all.filter((s) => s.subagent_only).map((s) => s.name ?? capitalize(s.id));
  return [...new Set([...folded, ...RETIRED_PERSONA_NAMES])].filter((n) => n.length >= 3);
}

/**
 * Every persona display name the house has ever used — folded, retired, AND
 * currently visible. Used by the fabricated-action detector, where
 * over-matching is harmless (it only asks "is a teammate being described as
 * acting?") and a MISS is the real cost: the pre-2026-08-03 hardcoded list had
 * no entry for Vera, so a claim that the code critic was reviewing something
 * sailed through unchecked.
 */
export function all_persona_names(all: readonly RosterEntry[]): string[] {
  const live = all.map((s) => s.name ?? capitalize(s.id));
  return [...new Set([...live, ...RETIRED_PERSONA_NAMES])].filter((n) => n.length >= 3);
}

/**
 * Render the routing directory the runtime injects into every system prompt
 * (chat + deliberation), for `self_id`.
 *
 * Visible peers get id + name + role: naming them to the user is correct.
 * Folded (`subagent_only`) specialists get id + role and NO name, under a
 * heading that says plainly what they are — reachable by id, never a
 * colleague to credit. Retired personas render nowhere, because they are not
 * in the registry.
 */
export function render_peer_directory(all: readonly RosterEntry[], self_id: string): string {
  const visible = all.filter((s) => s.id !== self_id && !s.subagent_only);
  const internal = all.filter((s) => s.id !== self_id && s.subagent_only);

  const lines: string[] = [];

  lines.push(
    visible.length > 0
      ? 'Your teammates — real colleagues the owner knows by name. You may name ' +
          'them and attribute work to them:'
      : 'You have no chat-visible teammates. Every id below is internal ' +
          'machinery of yours.',
  );
  for (const p of visible) {
    const display = p.name ?? capitalize(p.id);
    lines.push(p.role ? `  - ${p.id}: ${display}, ${p.role}` : `  - ${p.id}: ${display}`);
  }

  if (internal.length > 0) {
    lines.push('');
    lines.push(
      'Internal subsystems — ROUTING IDS ONLY, not colleagues. These are folded ' +
        'machinery of yours. You may route work to one by id ' +
        '(consult_specialist / delegate), but it has no name the owner knows and ' +
        'no room he can open: never name one to him, never say one "is handling" ' +
        'or "will look at" something, and report whatever comes back as YOUR own ' +
        'work. Their display names are deliberately not listed here — the id is ' +
        'the handle, the name is a leak:',
    );
    for (const p of internal) {
      lines.push(`  - ${p.id} — ${p.role ?? 'internal subsystem'}`);
    }
  }

  return lines.join('\n');
}
