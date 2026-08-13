export {}; // module scope
/**
 * smoke:prompt-supply — what the PROMPT hands the model must be true.
 *
 * The guards added on 2026-08-03 are all egress: they catch the model saying
 * something wrong on the way out. That is the wrong end to be working at when
 * the prompt is what supplied the wrong thing in the first place. A guard that
 * fires on a name the persona handed over is a retry nobody should have to
 * spend, and it only ever fires AFTER the bad turn was generated.
 *
 * This lint works the supply side. It reads every model-facing prose block in
 * every specialist config and fails when the prompt supplies:
 *
 *   1. **A folded or retired persona NAME.** The registry-derived roster keeps
 *      these out of the runtime-rendered directory; nothing was checking the
 *      prose. Nine survived the first pass in Kate alone — including "walk me
 *      through Beatrice's change" quoted as something the OWNER says, which is
 *      worse than a leak: it coaches the model to expect a name the owner has
 *      no referent for.
 *   2. **A tool the specialist cannot call.** Prose names tools constantly, in
 *      backticks. When a persona says to call `x` and `x` needs a capability
 *      this specialist wasn't granted, the model reaches for it, gets
 *      `forbidden`, and lands in the improvise-an-answer state every other
 *      guard exists to prevent. Same failure as a bad `tool_reflexes` row —
 *      but reflexes are linted and prose was not.
 *   3. **An unresolved `{{token}}`.** A token with no household value reaches
 *      the model as literal `{{…}}`. Deferred per-user tokens are resolved per
 *      turn and are excluded here.
 *
 * INOCULATED EXCEPTIONS are honoured, because a few of these names are load
 * bearing: `Knowledge/Anya/` and `users/<uid>/astrid/` are frozen vault PATHS
 * a specialist needs in order to read the files, and Kate's persona already
 * says so explicitly. A name inside a path segment is a filing label, not a
 * colleague, so path occurrences are exempt — but ONLY as a path.
 *
 * Reads YAML + tool source (no DB, LLM, network or native modules), so it runs
 * in the CI ring. The runtime-rendered half of the supply — the peer directory
 * — is asserted separately in smoke:folded-names.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { tool_facts, granted_set, missing_capabilities } from './lib/tool-source';
import { RETIRED_PERSONA_NAMES } from '../src/core/staff_roster';

const REPO = resolve(import.meta.dir, '..');
const SPECIALISTS_DIR = join(REPO, 'config', 'specialists');

/** The blocks that are rendered into a prompt verbatim. YAML `#` comments are
 *  NOT here on purpose — they never reach the model, so a comment explaining a
 *  fold is documentation, not supply. That distinction is the whole reason
 *  this lint reads parsed values rather than the raw file. */
const PROSE_FIELDS = [
  'persona',
  'chat_addendum',
  'deliberation_addendum',
  'chat_style',
  'voice_persona',
  'voice_style',
] as const;

interface SpecDoc {
  id?: string;
  name?: string;
  subagent_only?: boolean;
  capabilities?: Record<string, boolean>;
  [k: string]: unknown;
}

const docs: SpecDoc[] = [];
for (const f of readdirSync(SPECIALISTS_DIR)) {
  if (!f.endsWith('.yaml')) continue;
  docs.push(parse(readFileSync(join(SPECIALISTS_DIR, f), 'utf8')) as SpecDoc);
}

const folded = docs.filter((d) => d.subagent_only).map((d) => d.name ?? d.id ?? '');
const UNATTRIBUTABLE = [...new Set([...folded, ...RETIRED_PERSONA_NAMES])].filter(
  (n) => n.length >= 3,
);

/** Household tokens the runtime resolves PER TURN, so a literal in the YAML is
 *  correct rather than a leak (see DEFERRED_PERSONA_TOKENS in specialist.ts). */
const DEFERRED_TOKENS = new Set([
  'user_name',
  'primary_vehicle',
  'pet_names',
  'partner_name',
  'staff_roster',
]);

const failures: string[] = [];
const advisories: string[] = [];
let blocks = 0;

for (const doc of docs) {
  const id = doc.id ?? '?';
  const granted = granted_set(doc.capabilities);
  const self_name = doc.name ?? doc.id;

  for (const field of PROSE_FIELDS) {
    const text = doc[field];
    if (typeof text !== 'string' || text.length === 0) continue;
    blocks++;
    const lines = text.split('\n');

    lines.forEach((line, i) => {
      const at = `${id}.${field}:${i + 1}`;

      // ── 1. folded / retired persona names ──────────────────────────────
      for (const nm of UNATTRIBUTABLE) {
        const re = new RegExp(`\\b${nm}\\b`, 'g');
        for (const m of line.matchAll(re)) {
          // A specialist naming ITSELF is its identity, not a leak. A folded
          // specialist still has a name inside its own reasoning context —
          // "You are Vera, the household's code critic" is exactly right; what
          // must not happen is that name reaching the OWNER, which is a
          // property of who relays it, not of who holds it.
          if (self_name && nm.toLowerCase() === self_name.toLowerCase()) continue;
          // Exempt a name used as a PATH segment (`Knowledge/Anya/`,
          // `users/<uid>/astrid/`) — a frozen directory is a filing label.
          const before = line.slice(Math.max(0, m.index! - 1), m.index!);
          const after = line.slice(m.index! + nm.length, m.index! + nm.length + 1);
          if (before === '/' || after === '/') continue;
          // Exempt an explicit inoculation — prose that names it in order to
          // forbid it ("there is no \"Anya\" and you never say that word").
          if (/there is no|never say that word|FROZEN|not a person/i.test(line)) continue;

          const retired = RETIRED_PERSONA_NAMES.includes(nm);
          const detail = `${at} — supplies "${nm}": ${line.trim().slice(0, 100)}`;
          if (retired) {
            // A RETIRED persona has no config at all. There is no routing
            // justification for the name anywhere, at any tier — an
            // instruction to consult one is an instruction to consult nobody.
            failures.push(`${detail}  [RETIRED — no such specialist exists]`);
          } else if (!doc.subagent_only) {
            // A CHAT-VISIBLE specialist talks to the owner directly, so a
            // folded name in its prose is the same live bug Kate had.
            failures.push(`${detail}  [chat-visible ⇒ reaches the owner directly]`);
          } else {
            // Folded → folded. Defensible: these are subagents describing real
            // internal routing to each other, and their output only reaches
            // the owner through a relay that has its own egress guard. Worth
            // seeing, not worth failing on.
            advisories.push(detail);
          }
        }
      }

      // ── 2. backticked tools this specialist cannot call ────────────────
      for (const m of line.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) {
        const name = m[1]!;
        const facts = tool_facts(name);
        if (!facts) continue; // not a tool name — a field, a flag, a path
        // Require a CALL CUE. A persona legitimately mentions a tool it does
        // not hold when telling a story about one — trainer's persona cites
        // "Kristi's `update_sku` gap" as a past incident, and its addendum
        // recounts that `extract_meeting_votes` ran 59 times and recorded 3
        // votes. Neither is an instruction. Flagging a bare mention made this
        // check produce two false positives on its first run; the failure mode
        // being guarded is the prompt telling the model to REACH for something
        // it cannot have.
        const lead = line.slice(Math.max(0, m.index! - 44), m.index!);
        const CUE = /\b(call|calls|use|uses|using|run|runs|fire|fires|invoke|reach for|via|through|with)\s+$|[→⇒]\s*$/i;
        if (!CUE.test(lead)) continue;
        const missing = missing_capabilities(name, granted);
        if (missing.length > 0) {
          failures.push(
            `${at} — tells ${id} to use \`${name}\`, which needs ` +
              `${missing.join(' + ')} and is NOT granted. The model will reach ` +
              `for it and get \`forbidden\`.`,
          );
        }
      }

      // ── 3. unresolved template tokens ──────────────────────────────────
      for (const m of line.matchAll(/\{\{(\w+)\}\}/g)) {
        if (!DEFERRED_TOKENS.has(m[1]!)) {
          failures.push(`${at} — unresolved template token {{${m[1]}}} would reach the model.`);
        }
      }
    });
  }
}

if (advisories.length > 0) {
  // Reported, never fatal — see the folded-to-folded branch above.
  console.log(`\n· ${advisories.length} folded→folded reference(s), internal routing (not failing):`);
  for (const a of advisories.slice(0, 8)) console.log(`    ${a}`);
  if (advisories.length > 8) console.log(`    …and ${advisories.length - 8} more`);
  console.log('');
}

if (failures.length > 0) {
  console.error(`\n✗ prompt-supply — ${failures.length} problem(s) across ${blocks} prose blocks:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}
console.log(
  `✓ prompt-supply — ${blocks} prose blocks across ${docs.length} specialists supply no ` +
    `folded/retired name, no ungranted tool, and no unresolved token ` +
    `(${UNATTRIBUTABLE.length} names guarded).`,
);
