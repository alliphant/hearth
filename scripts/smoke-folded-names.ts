export {}; // module scope
/**
 * smoke:folded-names — the egress half of the fold.
 *
 * `render_peer_directory` stops the PROMPT handing a folded persona's name to
 * the model. `_detect_folded_name` catches the model saying one anyway — from
 * a retrieved note, a vault folder path, an old audit row, or plain
 * confabulation. This smoke pins the boundary that makes that guard safe to
 * ship as a NUDGE rather than a block: it must fire on attribution, and stay
 * quiet on the ordinary sentences that merely contain a human name.
 *
 * The derived name sets are asserted against the live config, so folding a
 * specialist (or retiring one) is covered the moment the YAML changes.
 *
 * No DB, no LLM, no network, no native modules — CI-ring safe.
 */
import { resolve } from 'node:path';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import {
  all_persona_names,
  unattributable_names,
  render_peer_directory,
  RETIRED_PERSONA_NAMES,
} from '../src/core/staff_roster';
import { _detect_folded_name } from '../src/core/specialist_runtime';

const REPO = resolve(import.meta.dir, '..');
load_extra_capabilities(
  resolve(REPO, process.env.HEARTH_CAPABILITIES_PATH ?? 'config/capabilities.yaml'),
);
const specialists = new SpecialistRegistry(resolve(REPO, 'config/specialists'));
const roster = specialists.list();

let failures = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
};

const unattributable = unattributable_names(roster);
const banned = (n: string) => unattributable.some((x) => x.toLowerCase() === n.toLowerCase());

console.log('\n── the derived sets ──');
const folded = roster.filter((s) => s.subagent_only);
check(folded.length > 0, `registry has folded specialists (${folded.length})`);
for (const s of folded) {
  check(banned(s.name ?? s.id), `folded "${s.name ?? s.id}" is unattributable`);
}
for (const s of roster.filter((s) => !s.subagent_only)) {
  check(!banned(s.name ?? s.id), `visible "${s.name ?? s.id}" is NOT unattributable`);
}
for (const n of RETIRED_PERSONA_NAMES) {
  check(banned(n), `retired "${n}" is unattributable (tombstone, no config to derive from)`);
}
// The detector's set is wider than the guard's, and must cover the visible too
// — a MISS there was the pre-2026-08-03 hole that let "Vera" through unchecked.
const all_names = all_persona_names(roster);
for (const s of roster) {
  check(
    all_names.some((n) => n.toLowerCase() === (s.name ?? s.id).toLowerCase()),
    `detector set covers "${s.name ?? s.id}"`,
  );
}

console.log('\n── fires on attribution ──');
const FIRES = [
  "Vera's found a blocker in that change.",
  'Beatrice is reviewing her playbook now.',
  'Cordelia has been asked to file it.',
  'Vivian flagged that bill as forty percent over.',
  'I checked with Astrid and she recommends backing off this week.',
  'Iris will handle the charge plan tonight.',
  "Cassandra's perimeter sweep came back clean.",
];
for (const t of FIRES) check(_detect_folded_name(t, unattributable) !== null, `fires: "${t}"`);

console.log('\n── stays quiet ──');
const QUIET = [
  // The correct first-person rewrite the nudge asks for.
  'I found a blocker in that change.',
  'The critique came back with one blocker and two nits.',
  'The camera monitor picked up someone at the front door.',
  // A VISIBLE teammate acting is correct and attributable.
  "Ruby's flagging that permit hearing — I'll confirm it.",
  'Mariah is auditing the tool usage this week.',
  // A bare mention is not an attribution. These names belong to real people
  // too, and a household contact really can be called Anna or Astrid.
  'Anna is a lovely name for the baby.',
  'I put Astrid on the guest list.',
  'Your sister Vivian called while you were out.',
  // A bare "asked/told" is deliberately NOT a consulting phrase — these are
  // ordinary human names and this is an ordinary sentence about a contact.
  'I asked Anna about the baby shower.',
  'You told Brigid you would bring the pie.',
  // Empty / no-name replies.
  '',
  'Nothing needs you today.',
];
for (const t of QUIET) check(_detect_folded_name(t, unattributable) === null, `quiet: "${t}"`);

console.log('\n── the prompt never supplies the names ──');
const directory = render_peer_directory(roster, 'kate');
for (const s of folded) {
  const nm = s.name ?? s.id;
  check(!new RegExp(`\\b${nm}\\b`).test(directory), `directory omits "${nm}"`);
  check(new RegExp(`\\b${s.id}\\b`).test(directory), `directory keeps routing id "${s.id}"`);
}

console.log(
  failures === 0
    ? `\n✓ folded-names — supply cut at the prompt, leak caught at egress.\n`
    : `\n✗ folded-names — ${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
