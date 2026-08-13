/**
 * guard:time — ban hand-rolled wall-clock time formatting outside src/core/time.ts.
 *
 * Why this exists: the May-2026 farmers-market bug (a 9 AM event rendered as
 * 3 PM) was a hand-rolled `getUTCHours()` formatter in `proposal_render.ts`; a
 * same-day audit found 22 sites of the same class. `src/core/time.ts` is the
 * ONLY sanctioned home for local/wall-clock formatting (`format_short_datetime`,
 * `local_iso_date`, `local_hhmm`, `local_day_start`, …). Every server caller
 * that bakes a user's local day / wall-clock minute into output must route
 * through it; reading `getUTC*` / `getHours()` / `toISOString().slice(0,10)` /
 * `new Intl.DateTimeFormat` directly picks up the host clock or a UTC day by
 * accident.
 *
 * Scope: `src/` and `apps/`, `.ts` / `.tsx` only (server code). Excluded:
 *   - `src/core/time.ts` itself (the sanctioned implementation),
 *   - `src/app/client/**` — browser code runs on the user's own device, where
 *     host-local time IS the user's local time by design,
 *   - `*.test.ts`.
 * (`scripts/` — smokes + CLI tools — is out of scope per the task's `src/ + apps/`
 * boundary.)
 *
 * Opt-out: a genuine, reviewed exception (UTC date arithmetic, an explicitly
 * tz-threaded `Intl.DateTimeFormat`, a `Date → YYYY-MM-DD` coercion) carries an
 * inline `// time-guard-ok: <reason>` comment on the offending line. Prefer that
 * over weakening a pattern — and prefer migrating to a `time.ts` helper over an
 * opt-out when the call is genuinely user-facing.
 *
 * Run: `bun run guard:time` (exits non-zero, listing offenders).
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const SCAN_DIRS = ['src', 'apps'];

/** Paths excluded from the scan (prefix match, repo-relative). */
const EXCLUDE_PREFIXES = [
  'src/core/time.ts', // the one sanctioned implementation
  'src/app/client/', // browser code — host tz IS the user's tz
];

const OPT_OUT = 'time-guard-ok';

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: 'getUTCHours', re: /getUTCHours\b/ },
  { name: 'getUTCDate', re: /getUTCDate\b/ },
  { name: 'getUTCMinutes', re: /getUTCMinutes\b/ },
  { name: 'getHours(', re: /getHours\s*\(/ },
  { name: 'getMinutes(', re: /getMinutes\s*\(/ },
  { name: 'toISOString().slice(0,10)', re: /\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/ },
  { name: 'new Intl.DateTimeFormat', re: /new\s+Intl\.DateTimeFormat\b/ },
];

interface Offender {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

/**
 * Strip the comment portion of a line so a banned pattern *mentioned in a doc
 * comment* (e.g. time.ts's own warnings echoed elsewhere) isn't flagged as a
 * code use. Naive but sufficient for method-call patterns: cut at the first
 * `//` that isn't inside an obvious string. We accept the rare edge (a `//`
 * inside a string literal preceding a real call on the same line) — code that
 * shape doesn't occur for these patterns.
 */
function code_portion(line: string): string {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function scan_file(abs: string, rel: string, offenders: Offender[]): void {
  const src = readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  let in_block_comment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    // Track /* … */ block comments line-by-line.
    if (in_block_comment) {
      if (raw.includes('*/')) in_block_comment = false;
      continue;
    }
    // A line that opens a block comment and doesn't close it: skip + enter.
    const open = raw.indexOf('/*');
    if (open !== -1 && !raw.includes('*/', open)) {
      in_block_comment = true;
      continue;
    }
    // Block-comment continuation / single-line block comment / JSDoc star line.
    if (trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    if (raw.includes(OPT_OUT)) continue;

    const code = code_portion(raw);
    for (const p of PATTERNS) {
      if (p.re.test(code)) {
        offenders.push({ file: rel, line: i + 1, pattern: p.name, text: trimmed });
      }
    }
  }
}

async function main(): Promise<void> {
  const offenders: Offender[] = [];
  for (const dir of SCAN_DIRS) {
    const glob = new Bun.Glob(`${dir}/**/*.{ts,tsx}`);
    for await (const rel of glob.scan({ cwd: ROOT })) {
      const norm = rel.replace(/\\/g, '/');
      if (norm.endsWith('.test.ts')) continue;
      if (EXCLUDE_PREFIXES.some((p) => (p.endsWith('/') ? norm.startsWith(p) : norm === p))) {
        continue;
      }
      scan_file(`${ROOT}/${norm}`, norm, offenders);
    }
  }

  if (offenders.length === 0) {
    console.log('guard:time — clean (no hand-rolled wall-clock formatting outside src/core/time.ts)');
    return;
  }

  console.error(
    `guard:time — ${offenders.length} banned wall-clock pattern(s) found.\n` +
      `Route user-facing local/wall-clock formatting through src/core/time.ts, or\n` +
      `if this is a reviewed exception add an inline \`// ${OPT_OUT}: <reason>\` comment.\n`,
  );
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  [${o.pattern}]  ${o.text}`);
  }
  process.exit(1);
}

await main();
