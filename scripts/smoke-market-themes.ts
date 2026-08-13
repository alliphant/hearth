/**
 * smoke:market-themes — Vivian's update_market_themes write tool.
 *
 * Self-contained (temp themes file via HEARTH_MARKET_THEMES). Proves the
 * surgical splice edits exactly the ticker line and never reflows the folded
 * `description:` blocks (the reason the Document API was rejected), plus the
 * add/remove/add_theme paths, the no-op refusals, and that the connector's
 * own strict reader (load_market_themes) still parses the result.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../src/core/tool';
import { make_update_market_themes } from '../src/specialists/vivian/tools/update_market_themes';
import { load_market_themes } from '../src/connectors/market_data';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-market-themes-'));
const path = join(dir, 'market-themes.yaml');
process.env.HEARTH_MARKET_THEMES = path;

const FOLDED_DESC =
  '      A folded multi-line description that MUST survive the edit\n' +
  '      without any reflow — exact bytes preserved across the splice.';
const FILE =
  '# config/market-themes.yaml (smoke fixture)\n' +
  'themes:\n' +
  '  power_nuclear:\n' +
  '    label: Nuclear & power\n' +
  '    description: >-\n' +
  FOLDED_DESC +
  '\n' +
  '    tickers: [CEG, VST, OKLO]\n' +
  '  solo:\n' +
  '    label: One ticker\n' +
  '    tickers: [TSLA]\n';
writeFileSync(path, FILE);

const tool = make_update_market_themes();
const ctx = {} as ToolContext;
const run = (raw: Record<string, unknown>): ReturnType<typeof tool.execute> =>
  tool.execute(tool.input_schema.parse(raw), ctx);

async function main(): Promise<void> {
  // 1. add_ticker (lowercase coerces to upper) — and the folded description survives.
  const add = await run({ action: 'add_ticker', theme: 'power_nuclear', symbol: 'smr' });
  check('add_ticker ok', add.ok === true);
  check('SMR uppercased + appended', add.tickers_after.join(',') === 'CEG,VST,OKLO,SMR');
  const after_add = readFileSync(path, 'utf8');
  check('ticker line rewritten inline', after_add.includes('tickers: [CEG, VST, OKLO, SMR]'));
  check('folded description NOT reflowed (exact bytes)', after_add.includes(FOLDED_DESC));
  check('header comment preserved', after_add.startsWith('# config/market-themes.yaml (smoke fixture)'));

  // 2. duplicate add → no-op refusal.
  const dup = await run({ action: 'add_ticker', theme: 'power_nuclear', symbol: 'SMR' });
  check('duplicate ticker refused', dup.ok === false && /already in/.test(dup.note ?? ''));

  // 3. remove_ticker.
  const rm = await run({ action: 'remove_ticker', theme: 'power_nuclear', symbol: 'OKLO' });
  check('remove_ticker ok', rm.ok === true && !rm.tickers_after.includes('OKLO'));

  // 4. removing a ticker that isn't there → refusal.
  const rm_missing = await run({ action: 'remove_ticker', theme: 'power_nuclear', symbol: 'ZZZZ' });
  check('remove missing ticker refused', rm_missing.ok === false && /not in/.test(rm_missing.note ?? ''));

  // 5. refusing to empty a theme.
  const empty = await run({ action: 'remove_ticker', theme: 'solo', symbol: 'TSLA' });
  check('refuses to empty a theme', empty.ok === false && /at least one/.test(empty.note ?? ''));

  // 6. add_theme appends a new universe.
  const addt = await run({
    action: 'add_theme',
    theme: 'quantum',
    label: 'Quantum computing',
    description: 'Early, speculative — story names with thin revenue.',
    tickers: ['IONQ', 'RGTI'],
  });
  check('add_theme ok', addt.ok === true && addt.tickers_after.join(',') === 'IONQ,RGTI');

  // 7. duplicate theme refused.
  const dupt = await run({ action: 'add_theme', theme: 'power_nuclear', label: 'x' });
  check('duplicate theme refused', dupt.ok === false && /already exists/.test(dupt.note ?? ''));

  // 8. unknown theme → refusal with a known-themes hint.
  const unknown = await run({ action: 'add_ticker', theme: 'does_not_exist', symbol: 'AAPL' });
  check('unknown theme refused w/ hint', unknown.ok === false && /Known themes/.test(unknown.note ?? ''));

  // 9. the connector's strict reader still parses the final file.
  const loaded = await load_market_themes();
  check('connector still parses final file', !('error' in loaded));
  if (!('error' in loaded)) {
    check('quantum theme is readable by the connector', 'quantum' in loaded.themes);
    check('SMR landed in power_nuclear', (loaded.themes.power_nuclear?.tickers ?? []).includes('SMR'));
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HEARTH_MARKET_THEMES;
    console.log(failures === 0 ? '\nsmoke:market-themes OK' : `\nsmoke:market-themes FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
