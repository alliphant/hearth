/**
 * shell_safety — the finalize guard for shell commands handed to the owner
 * (2026-07-25, the whole-stack-outage incident).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every irreversible EFFECT in Hearth is gated: a `send_external` /
 * `spend_money` tool call routes through the approval queue, a code merge needs
 * an owner tap plus a PIN. But a fenced ```bash block in a reply is an effect
 * with no gate at all — the owner pastes it and it runs with full host
 * privileges. On 2026-07-25 that hole cost the whole box: asked why Plex was
 * down, the reply handed over
 *
 *     cd /opt/plex && docker compose down && docker compose up -d
 *
 * `/opt/plex` did not exist (it was invented — the diagnostic tools returned no
 * path, so a plausible one got authored), Docker Compose walked UP the tree from
 * the wrong cwd, found the MASTER /docker/docker-compose.yml, and a teardown
 * meant for one service removed ~45 containers. The fact-critic ran on that
 * reply and passed it: an invented directory is not a "claim" and a destructive
 * verb is not a fabrication, so nothing in the grounding layer looks at either.
 *
 * WHAT THIS GATES (the effect, not the composition)
 * -------------------------------------------------
 * Per the standing "tools are legos" principle this does NOT restrict what can
 * be composed. It checks two properties of the commands actually handed over:
 *
 *   1. DESTRUCTIVE VERB — an effect that removes, wipes, or reboots. It passes
 *      only when it is both TARGETED (names the one thing it acts on) and the
 *      reply states the BLAST RADIUS. An untargeted `docker compose down`, or a
 *      targeted one with no blast-radius statement, trips. Some effects are
 *      irreversible regardless of target (`rm -rf`, `prune`, `mkfs`, `reboot`,
 *      `modprobe -r`) and never pass on scoping alone.
 *   2. UNGROUNDED PATH — an absolute filesystem path inside a command block
 *      that appears NOWHERE in the turn's tool evidence. That is the invented
 *      `/opt/plex` exactly. Paths handed to the owner have to come from
 *      something a tool actually returned (`diagnose_service` now returns the
 *      real compose file for precisely this reason).
 *
 * The action is the standard one-retry NUDGE, in the same finalize pipeline as
 * the honesty guards: own latch, shared re-roll budget, deterministic (no LLM),
 * fail-open, kill switch HEARTH_SHELL_SAFETY_GUARD=0. It deliberately does NOT
 * rewrite or redact the reply — hard redaction was removed from this codebase at
 * the owner's direction (2026-05-30) and is not coming back. A second reply that
 * still carries the command goes through; the audit row + the `quality_signal`
 * it emits are what carry the miss onward to Beatrice via guard_feedback.
 */

/** One thing wrong with a command block in a reply. */
export interface ShellFinding {
  kind: 'destructive' | 'ungrounded_path' | 'ungrounded_compose';
  /** The offending command line (or path), trimmed and capped. */
  command: string;
  /** What it actually does / why it's flagged — goes verbatim into the nudge. */
  detail: string;
  /** Names the single thing it acts on (a service, a unit). */
  targeted: boolean;
  /** False when the effect is irreversible no matter what it targets. */
  escapable: boolean;
}

export interface ShellSafetyVerdict {
  findings: ShellFinding[];
  /** True when the reply must be re-rolled before the owner sees it. */
  needs_retry: boolean;
  /** Whether the reply states what the command will take down. */
  blast_radius_stated: boolean;
}

/** Kill switch — read at call time so a smoke can flip it after import. */
export function shell_safety_guard_enabled(): boolean {
  return process.env.HEARTH_SHELL_SAFETY_GUARD !== '0';
}

// ── extraction ───────────────────────────────────────────────────────────────

const SHELL_FENCE_TAGS = new Set([
  '', 'bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'shellsession', 'command',
]);

/**
 * The fenced code blocks that are shell commands. Untagged fences count only
 * when the first line looks like a command — an untagged JSON/YAML block is not
 * something anyone pastes into a prompt.
 */
export function extract_shell_blocks(reply: string): string[] {
  const blocks: string[] = [];
  const fence = /```([A-Za-z0-9_+-]*)\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(reply)) !== null) {
    const tag = (m[1] ?? '').toLowerCase();
    const body = m[2] ?? '';
    if (!SHELL_FENCE_TAGS.has(tag)) continue;
    if (tag === '') {
      const first = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
      if (!/^(\$\s+)?(sudo\s+)?(cd|docker|systemctl|git|rm|ssh|apt|modprobe|dd|mkfs|reboot|shutdown|journalctl|curl|bun|npm)\b/.test(first)) {
        continue;
      }
    }
    blocks.push(body);
  }
  return blocks;
}

/** Inline single-backtick spans — a one-liner in prose is just as pasteable. */
function extract_inline_spans(reply: string): string[] {
  const out: string[] = [];
  const span = /(?<!`)`([^`\n]{2,200})`(?!`)/g;
  let m: RegExpExecArray | null;
  while ((m = span.exec(reply)) !== null) out.push(m[1] ?? '');
  return out;
}

/** Split a block into individual commands: newlines plus `&&`, `||`, `;`, `|`. */
function command_lines(block: string): string[] {
  return block
    .split(/\r?\n/)
    .flatMap((line) => line.split(/&&|\|\||;|(?<!\|)\|(?!\|)/))
    .map((s) => s.trim().replace(/^\$\s+/, ''))
    .filter((s) => s.length > 0 && !s.startsWith('#'));
}

// ── destructive verbs ────────────────────────────────────────────────────────

/** Operands of a `docker compose <verb>` — the service names, flags stripped.
 *  A flag that takes a value (`-t 30`, `--rmi all`) has its value skipped too,
 *  so `docker compose down --rmi all` reads as UNtargeted, which it is. */
function compose_operands(rest: string): string[] {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const VALUED = new Set(['-t', '--timeout', '--rmi', '--scale', '--project-name', '-p', '--profile', '-f', '--file']);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('-')) {
      if (VALUED.has(t) && i + 1 < tokens.length) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

const STRIP_SUDO = /^(sudo\s+(-[A-Za-z]+\s+)*)?/;

/** Deterministic destructive-verb detection over ONE command line. */
export function classify_command(raw: string): ShellFinding | null {
  const cmd = raw.trim().replace(STRIP_SUDO, '').trim();
  if (!cmd) return null;
  const cap = (s: string) => (s.length > 200 ? s.slice(0, 197) + '…' : s);

  // Expanding every container on the host — the worst shape, any verb.
  if (/\$\(\s*docker\s+ps\s+[^)]*-a[^)]*\)/.test(cmd) || /\$\(docker ps -aq\)/.test(cmd)) {
    return {
      kind: 'destructive', command: cap(cmd), targeted: false, escapable: false,
      detail: 'expands to EVERY container on the host, including ones unrelated to the problem',
    };
  }

  // `docker compose down` / `rm` — teardown of a whole project unless a service
  // is named. This is the exact shape that took the box down.
  const dc = /^docker[\s-]+compose\b(.*?)\b(down|rm)\b(.*)$/s.exec(cmd);
  if (dc) {
    const verb = dc[2]!;
    const operands = compose_operands(dc[3] ?? '');
    return {
      kind: 'destructive', command: cap(cmd), targeted: operands.length > 0, escapable: true,
      detail:
        operands.length > 0
          ? `\`compose ${verb}\` stops and REMOVES ${operands.join(', ')} — say what that takes offline`
          : `\`compose ${verb}\` with no service named stops and REMOVES every container in the compose project ` +
            `it resolves to — and compose resolves that project by walking UP from the current directory`,
    };
  }
  // `docker compose up` with no service recreates the whole project.
  const dcu = /^docker[\s-]+compose\b(.*?)\bup\b(.*)$/s.exec(cmd);
  if (dcu) {
    const operands = compose_operands(dcu[2] ?? '');
    if (operands.length === 0) {
      return {
        kind: 'destructive', command: cap(cmd), targeted: false, escapable: true,
        detail:
          '`compose up` with no service named creates/recreates EVERY service in the project it resolves to; ' +
          'one service failing to start leaves the rest stuck part-way',
      };
    }
    return null;
  }

  // Prune — reclaims anything not currently in use, across the whole daemon.
  if (/^docker\s+(system|volume|image|network|builder|container)\s+prune\b/.test(cmd)) {
    return {
      kind: 'destructive', command: cap(cmd), targeted: false, escapable: false,
      detail: 'deletes every unused object of that type daemon-wide — unrecoverable, and reaches far past this service',
    };
  }

  // rm -rf in any flag order.
  if (/^rm\s+(-[A-Za-z]*\s+)*-[A-Za-z]*(?:rf|fr)[A-Za-z]*\b/.test(cmd) || /^rm\s+(-[A-Za-z]+\s+)*-r\b.*\s-f\b/.test(cmd)) {
    return {
      kind: 'destructive', command: cap(cmd), targeted: false, escapable: false,
      detail: 'recursive force-delete — nothing to undo it',
    };
  }

  // Kernel module unload — takes the driver out from under anything using it.
  if (/^(modprobe\s+-r|rmmod)\b/.test(cmd)) {
    return {
      kind: 'destructive', command: cap(cmd), targeted: false, escapable: false,
      detail: 'unloads a live kernel module — every process holding that device fails immediately',
    };
  }

  // Whole-host power state.
  if (/^(reboot|poweroff|halt|shutdown\b|init\s+[06]\b|systemctl\s+(reboot|poweroff|halt)\b)/.test(cmd)) {
    return {
      kind: 'destructive', command: cap(cmd), targeted: false, escapable: false,
      detail: 'restarts or powers off the entire host — every service on it goes down',
    };
  }

  // Filesystem / block-device destruction.
  if (/^(mkfs(\.\w+)?\b|dd\b[^\n]*\bof=\/dev\/)/.test(cmd)) {
    return {
      kind: 'destructive', command: cap(cmd), targeted: false, escapable: false,
      detail: 'writes directly to a block device — destroys whatever is on it',
    };
  }

  // Discarding working-tree state.
  if (/^git\s+(reset\s+--hard|clean\s+-[A-Za-z]*f)/.test(cmd)) {
    return {
      kind: 'destructive', command: cap(cmd), targeted: false, escapable: false,
      detail: 'discards uncommitted work in that tree with no way back',
    };
  }

  // Targeted container removal — bounded, but still a removal.
  const drm = /^docker\s+(?:container\s+)?rm\b(.*)$/s.exec(cmd);
  if (drm) {
    const operands = compose_operands(drm[1] ?? '');
    return {
      kind: 'destructive', command: cap(cmd), targeted: operands.length > 0, escapable: true,
      detail: `removes the container${operands.length ? ` ${operands.join(', ')}` : 's'} — recreating it needs its original run/compose definition`,
    };
  }

  return null;
}

// ── ungrounded paths ─────────────────────────────────────────────────────────

/** Roots that are standard on any Linux host — a path under one of these is
 *  not the invention class this catches, and flagging them would be noise. */
const SYSTEM_PREFIXES = [
  '/tmp', '/dev', '/proc', '/sys', '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/boot', '/etc', '/var/run', '/var/log',
];

const PATH_RE = /(?<![\w$@:/~.])\/[A-Za-z0-9._][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._][A-Za-z0-9._+-]*)+\/?/g;

function normalize_path(p: string): string {
  return p.replace(/\/+$/, '').toLowerCase();
}

/**
 * Absolute paths in the handed-over commands that appear NOWHERE in the turn's
 * tool evidence. A path whose PARENT is grounded passes (descending into a real
 * directory is legitimate); a path with no grounded ancestor at all is the
 * invention class. Requires ≥2 segments so a bare `/docker` is never flagged.
 */
export function find_ungrounded_paths(blocks: string[], evidence: string): ShellFinding[] {
  const hay = (evidence || '').toLowerCase();
  const seen = new Set<string>();
  const out: ShellFinding[] = [];
  for (const block of blocks) {
    for (const m of block.matchAll(PATH_RE)) {
      const rawPath = m[0]!;
      if (/[*?{}$]/.test(rawPath)) continue;
      const p = normalize_path(rawPath);
      if (seen.has(p)) continue;
      if (SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'))) continue;
      seen.add(p);
      if (hay.includes(p)) continue;
      const parent = p.slice(0, p.lastIndexOf('/'));
      if (parent.includes('/') && hay.includes(parent)) continue; // a real descent
      out.push({
        kind: 'ungrounded_path',
        command: rawPath,
        targeted: false,
        escapable: false,
        detail:
          `nothing you read this turn mentions ${rawPath} — it isn't in any tool result, so it may not exist`,
      });
    }
  }
  return out;
}

/** A compose invocation that pins its project explicitly is self-describing. */
const COMPOSE_PINNED = /(^|\s)(-f|--file|-p|--project-name|--project-directory)(\s|=)/;
const COMPOSE_CMD = /^docker[\s-]+compose\b/;
/** The tool reported the target IS compose-managed (JSON or prose form). */
const COMPOSE_EVIDENCE = /compose_managed"?\s*[:=]\s*true|compose[_\s]file/i;
/** ...and reported the opposite — the strongest possible ungrounding. */
const NOT_COMPOSE_EVIDENCE = /compose_managed"?\s*[:=]\s*false/i;

/**
 * A `docker compose` command whose project the reply cannot possibly know.
 *
 * The 2026-07-25 outage is usually retold as "an invented path", but the
 * mechanism was narrower and nastier: compose resolves its project by walking
 * UP the directory tree, so a compose command that does not pin `-f <file>`
 * acts on whichever project happens to be above the cwd — on the LLM host that is
 * the MASTER compose file for ~45 services. `infra_service` builds every
 * command in the `-f <file>` form precisely for this reason, so a compose
 * command WITHOUT that form did not come from the tool; it came from priors.
 *
 * The destructive-verb check above cannot catch this class, because the verb
 * is usually `restart` or `logs` — not destructive at all — and the ungrounded
 * PATH check cannot catch it either, since the dangerous form is the one
 * carrying no path to check. `docker compose restart hearth-embeddings` sails
 * through both, and hearth-embeddings has no compose file at all.
 *
 * Grounded means one of: the command pins its project explicitly (`-f`/`-p`),
 * or some tool this turn actually reported a compose-managed service. Evidence
 * that explicitly says `compose_managed: false` is never grounding, whatever
 * else the turn read.
 */
export function find_ungrounded_compose(lines: string[], evidence: string): ShellFinding[] {
  const hay = evidence || '';
  const says_managed = COMPOSE_EVIDENCE.test(hay);
  const says_unmanaged = NOT_COMPOSE_EVIDENCE.test(hay);
  const seen = new Set<string>();
  const out: ShellFinding[] = [];
  for (const raw of lines) {
    const cmd = raw.trim().replace(STRIP_SUDO, '').trim();
    if (!COMPOSE_CMD.test(cmd) || seen.has(cmd)) continue;
    if (COMPOSE_PINNED.test(cmd)) continue; // self-describing; the path check owns it
    if (says_managed && !says_unmanaged) continue; // a tool vouched for a project
    seen.add(cmd);
    out.push({
      kind: 'ungrounded_compose',
      command: cmd.length > 200 ? cmd.slice(0, 197) + '…' : cmd,
      targeted: false,
      escapable: false,
      detail: says_unmanaged
        ? 'the tool you read says this container has NO compose file — it was started with a bare ' +
          '`docker run`, so there is no compose project for this command to act on'
        : 'no `-f <file>`, and nothing you read this turn shows a compose project — compose resolves ' +
          'its project by walking UP from whatever directory this is run in, so this may act on a ' +
          'far larger stack than the one service',
    });
  }
  return out;
}

// ── blast-radius statement ───────────────────────────────────────────────────

/**
 * Does the reply say what the command takes down? Deliberately STRICT: this is
 * the only way a destructive command passes, so a false negative costs one
 * nudge while a false positive lets a stack-wide teardown through.
 */
export function has_blast_radius_statement(reply: string): boolean {
  const t = reply.toLowerCase();
  return (
    /\bblast radius\b/.test(t) ||
    /\b(affects?|touches|hits|stops|restarts|takes down|removes)\s+(only|just)\b/.test(t) ||
    /\b(only|just)\s+(that|this|the one)\s+(service|container|stack|project)\b/.test(t) ||
    /\bnothing else (on|is|will|gets|goes)\b/.test(t) ||
    /\bno other (services?|containers?)\b/.test(t) ||
    /\bevery(thing| container| service)[^.]{0,40}\b(in|on)\b[^.]{0,60}\b(project|stack|host|box|file)\b/.test(t) ||
    /\bwill (also )?(stop|take down|remove|restart|recreate)\b[^.]{0,80}\b\d+\s+(other\s+)?(containers?|services?)\b/.test(t)
  );
}

// ── the verdict ──────────────────────────────────────────────────────────────

/**
 * Assess the shell commands in a finished reply. PURE + deterministic + cheap:
 * a reply with no command block returns clean without touching anything.
 */
export function assess_shell_safety(opts: { reply: string; evidence?: string }): ShellSafetyVerdict {
  const reply = opts.reply ?? '';
  const clean: ShellSafetyVerdict = { findings: [], needs_retry: false, blast_radius_stated: false };
  if (!reply.trim()) return clean;

  const blocks = extract_shell_blocks(reply);
  const inline = extract_inline_spans(reply);
  if (blocks.length === 0 && inline.length === 0) return clean;

  const findings: ShellFinding[] = [];
  const dedup = new Set<string>();
  // Destructive verbs: fenced blocks AND inline spans (both get pasted).
  for (const line of [...blocks.flatMap(command_lines), ...inline.flatMap(command_lines)]) {
    const f = classify_command(line);
    if (f && !dedup.has(f.command)) {
      dedup.add(f.command);
      findings.push(f);
    }
  }
  // Ungrounded paths: fenced blocks only — a path discussed in prose is
  // conversation, a path inside a command block is an instruction.
  if (blocks.length > 0) findings.push(...find_ungrounded_paths(blocks, opts.evidence ?? ''));
  // Unpinned compose: fenced AND inline, because the dangerous form is short
  // enough to be handed over inline (`docker compose restart x`) and it gets
  // pasted just the same.
  for (const f of find_ungrounded_compose(
    [...blocks.flatMap(command_lines), ...inline.flatMap(command_lines)],
    opts.evidence ?? '',
  )) {
    if (!dedup.has(f.command)) {
      dedup.add(f.command);
      findings.push(f);
    }
  }

  const blast_radius_stated = has_blast_radius_statement(reply);
  // A grounding failure is never excused by a blast-radius sentence: stating
  // the radius of a command whose project you cannot identify states nothing.
  const needs_retry = findings.some((f) =>
    f.kind === 'ungrounded_path' || f.kind === 'ungrounded_compose'
      ? true
      : !(f.escapable && f.targeted && blast_radius_stated),
  );
  return { findings, needs_retry, blast_radius_stated };
}

/**
 * The one-retry nudge. Points at what TO do (narrowest command, grounded path,
 * stated blast radius) rather than enumerating prohibitions, and — like every
 * other guard nudge — must not leak: the model rewrites the reply directly, with
 * no apology and no mention of this note.
 */
export function shell_safety_retry_nudge(findings: ShellFinding[]): string {
  const destructive = findings.filter((f) => f.kind === 'destructive');
  const paths = findings.filter((f) => f.kind === 'ungrounded_path');
  const compose = findings.filter((f) => f.kind === 'ungrounded_compose');
  const lines: string[] = [];
  for (const f of destructive.slice(0, 5)) lines.push(`- \`${f.command}\` — ${f.detail}`);
  for (const f of paths.slice(0, 5)) lines.push(`- \`${f.command}\` — ${f.detail}`);
  for (const f of compose.slice(0, 5)) lines.push(`- \`${f.command}\` — ${f.detail}`);

  return (
    `[SHELL SAFETY — internal system note, not from the user]\n\n` +
    `The commands in your reply would reach further than the problem does, ` +
    `and the user runs them verbatim:\n${lines.join('\n')}\n\n` +
    `Rewrite the reply with commands that clear this bar:\n` +
    (destructive.length
      ? `1. NARROWEST FORM. Fix the one service that's broken. Name it explicitly — ` +
        `\`docker compose -f <file> restart <service>\` or \`docker compose -f <file> up -d <service>\`, ` +
        `never a bare \`down\`/\`up\` that acts on a whole project. Prefer restart/recreate over teardown.\n` +
        `2. STATE THE BLAST RADIUS in the reply itself — say plainly what the command touches and what it ` +
        `leaves alone. If it genuinely has to be wide, say how wide before the command.\n`
      : '') +
    (paths.length
      ? `${destructive.length ? '3' : '1'}. GROUNDED PATHS ONLY. Every path you hand over must come from ` +
        `something a tool actually returned this turn — \`diagnose_service\` returns the real compose file, ` +
        `working dir and project for a container. If you don't have the path, call the tool for it or say you ` +
        `need to look it up. Do not compose a plausible-looking directory.\n`
      : '') +
    (compose.length
      ? `${destructive.length || paths.length ? '4' : '1'}. NEVER AN UNPINNED \`docker compose\`. Call ` +
        `\`diagnose_service\` for the container and use the exact command it returns. It tells you whether ` +
        `there is a compose project at all — some containers here were started with a bare \`docker run\` and ` +
        `have NO compose file anywhere, and for those the whole answer is \`docker restart <container>\`. ` +
        `If a compose project does exist, pin it with \`-f <file>\`. Never hand over a compose command whose ` +
        `project you are inferring.\n`
      : '') +
    `\nUse the \`-f <file>\` form rather than \`cd <dir> && docker compose …\`: compose finds its project by ` +
    `walking UP the directory tree, so a \`cd\` into a directory with no compose file in it silently targets ` +
    `the parent project instead — that is how a one-service fix becomes a whole-stack outage.\n\n` +
    `Write the corrected reply directly, in your normal voice. Don't apologize, don't narrate the change, ` +
    `and don't mention this note.`
  );
}
