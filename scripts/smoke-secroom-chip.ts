/**
 * smoke:secroom-chip — the Security Room's who's-home CHIP copy (web client).
 *
 * Why this exists: `_secroom_chip` in src/app/client/app.js decides what a
 * person's chip SAYS, and a 2026-07-29 change to it silently dropped the
 * home/away word for exactly the rows it was meant to improve. A household
 * member whose presence resolves from GEOFENCE carries `zone: null` and
 * `last_seen_at: null` (there is no camera sighting behind the verdict), so the
 * presence word was the whole subtitle; adding a `presence_as_of` fallback into
 * the same slot made the array non-empty and the presence branch dead, leaving a
 * bare "9m ago" chip whose only remaining home/away signal was the ring COLOUR —
 * which a screen reader cannot see. The rule the fix restores: a timestamp is
 * APPENDED to the presence word, never substituted for it, and the aria-label
 * always carries presence as TEXT.
 *
 * app.js is a plain browser bundle (no module system — it is served as-is), so
 * there is nothing to import. This lifts the ONE function out of the source text
 * and runs it against minimal stubs for the three browser globals it touches.
 * Extraction failure is a loud FAIL, never a silent skip: if the function is
 * renamed or restructured, this smoke says so instead of quietly passing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const APP_JS = join(import.meta.dir, '..', 'src', 'app', 'client', 'app.js');
const FN_NAME = '_secroom_chip';

/** Lift `function <name>(…) {…}` out of a source file by brace matching. */
function extract_function(src: string, name: string): string | null {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

const fn_src = extract_function(readFileSync(APP_JS, 'utf8'), FN_NAME);
check(`E1 ${FN_NAME} is still a top-level function in app.js`, fn_src !== null);
if (!fn_src) {
  console.log(`\nsmoke:secroom-chip FAILED (${failures}) — nothing to test`);
  process.exit(1);
}

/** The browser globals the chip touches, and nothing else. `relative_time` is
 *  stubbed to an identity-ish map so the assertions read as literal copy. */
const RELATIVE: Record<string, string> = { A: '2h ago', B: '3m ago', C: '9m ago' };
type Chip = { innerHTML: string; attrs: Record<string, string> };
const make_chip = new Function(`
  const escape_html = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const relative_time = (iso) => (${JSON.stringify(RELATIVE)})[iso] ?? iso;
  const _secroom_hue = () => '#abc';
  const _secroom_threads = () => [];
  const _secroom_open_detail = () => {};
  const toast = () => {};
  const _secroom_doc = null;
  const document = { createElement: (tag) => ({ tag, className: '', innerHTML: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener() {} }) };
  ${fn_src}
  return ${FN_NAME};
`)() as (entry: Record<string, unknown>, root: null, opts: Record<string, unknown>) => Chip;

const sub = (chip: Chip): string => chip.innerHTML.match(/secroom-chip-sub">([^<]*)</)?.[1] ?? '';
const label = (chip: Chip): string => chip.attrs['aria-label'] ?? '';

/* ── The regression: home by GEOFENCE — presence word, plus the time ───────── */
{
  const home = make_chip({ name: 'Sam Reed', presence: 'home', zone: null, last_seen_at: null, presence_as_of: 'C' }, null, {});
  check('C1 a geofence-only row keeps its presence word and APPENDS the time', sub(home) === 'home · 9m ago');
  check('C1b …and the label carries presence as text, not as ring colour', label(home) === 'Sam Reed, home, 9m ago');
  const away = make_chip({ name: 'Sam Reed', presence: 'away', zone: null, last_seen_at: null, presence_as_of: 'A' }, null, {});
  check('C2 away is not dropped either', sub(away) === 'away · 2h ago');
  const unknown_presence = make_chip({ name: 'Kim', presence: 'unknown', zone: null, last_seen_at: null, presence_as_of: null }, null, {});
  check('C3 no verdict at all still says so in words', sub(unknown_presence) === 'presence unknown');
}

/* ── Older server (no presence_as_of): byte-identical to the pre-2026-07-29 copy */
{
  const legacy = make_chip({ name: 'Sam Reed', presence: 'home', zone: null, last_seen_at: null }, null, {});
  check('C4 a server without presence_as_of reads exactly as before', sub(legacy) === 'home');
}

/* ── A camera-seen row: the sighting detail still leads the visible chip ───── */
{
  const cam = make_chip({ name: 'Jasper', presence: 'home', zone: 'Driveway Right', last_seen_at: 'B', presence_as_of: 'C' }, null, {});
  check('C5 zone + sighting age lead the visible sub (unchanged copy)', sub(cam) === 'Driveway Right · 3m ago');
  check('C5b …and the label still leads with presence', label(cam) === 'Jasper, home, Driveway Right, 3m ago');
}

/* ── Unknown visitors keep their own copy ──────────────────────────────────── */
{
  const seen = make_chip({ thread_id: 't1', zone: 'Porch', last_seen_at: 'B' }, null, { unknown: true });
  check('C6 an unknown visitor on a camera is unchanged', sub(seen) === 'Porch · 3m ago');
  const bare = make_chip({ thread_id: 't1', zone: null, last_seen_at: null }, null, { unknown: true });
  check('C6b …and with no detail still reads "on a camera"', sub(bare) === 'on a camera');
}

/* ── Escaping: markup escaped, aria-label NOT double-encoded ───────────────── */
{
  const amp = make_chip({ name: 'Jasper', presence: 'home', zone: 'Deck & Yard', last_seen_at: null }, null, {});
  check('C7 the zone is html-escaped in the markup', sub(amp) === 'Deck &amp; Yard');
  check('C7b …and the label reads the raw text, not the entity', label(amp) === 'Jasper, home, Deck & Yard');
}

console.log(failures === 0 ? '\nsmoke:secroom-chip OK' : `\nsmoke:secroom-chip FAILED (${failures})`);
process.exit(failures > 0 ? 1 : 0);
