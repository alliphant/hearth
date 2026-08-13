/**
 * smoke:civic-member-name — the roster-pollution guard (2026-07-29).
 *
 * The live civic_members roster held exactly two rows, "Councilmember" and
 * "City Council", with empty role/district/term and 2 votes attributed to
 * them. Agenda HEADINGS had been lifted into member_name by the vote
 * extractor, whose only filter was length + has-letters. The consequence:
 * member_dossier("Chris Barrett") returned nothing, and voting_record /
 * council_alignment / scan_conflicts all sat on an unbacked roster.
 */
import { is_plausible_member_name } from '../src/specialists/ruby/civic_analysis';

let passed = 0, failed = 0;
const check = (n: string, c: boolean): void => {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
};

console.log('→ the exact rows that polluted the live roster');
for (const junk of ['Councilmember', 'City Council', 'councilmembers', 'Mayor Pro Tem', 'City Staff', 'The Council', 'Board', 'District 1']) {
  check(`rejects "${junk}"`, !is_plausible_member_name(junk));
}

console.log('→ real people pass');
for (const name of ['Chris Barrett', 'Councilmember Chris Barrett', 'Joan Vance', "Shirley Okafor", 'Tricia Greco', 'Muñoz', 'Emily Whitaker', 'Kelly Sandoval']) {
  check(`accepts "${name}"`, is_plausible_member_name(name));
}

console.log('→ edges');
check('rejects empty', !is_plausible_member_name(''));
check('rejects whitespace', !is_plausible_member_name('   '));
check('rejects a bare number', !is_plausible_member_name('2025'));
check('rejects a single initial', !is_plausible_member_name('A'));
check('accepts a lone surname', is_plausible_member_name('Sandoval'));

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ CIVIC-MEMBER-NAME SMOKE FAILED'); process.exit(1); }
console.log('\n✓ CIVIC-MEMBER-NAME SMOKE OK');
