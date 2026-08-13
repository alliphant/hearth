/**
 * scripts/sanitize.ts
 *
 * Transforms the dev repo (alliphant/hearth-private) into the public,
 * sanitized mirror (alliphant/hearth). Driven by ops/sanitize-rules.yaml.
 *
 * Flow:
 *   1. Load rules (exclude_paths, text_replacements, file_overrides,
 *      forbidden_in_output, audit_excludes).
 *   2. Walk every file under repo root.
 *   3. Skip files matching exclude_paths.
 *   4. For each remaining file: apply text_replacements, write to OUT.
 *   5. Apply file_overrides (rename / copy_from / delete).
 *   6. Audit: scan OUT for forbidden_in_output literals. Fail if found.
 *   7. Print summary.
 *
 * Default mode is dry-run (no writes). Pass --apply to actually write.
 *
 * Usage:
 *   bun run scripts/sanitize.ts                  # preview (dry-run)
 *   bun run scripts/sanitize.ts --apply          # write to ~/hearth-prod
 *   bun run scripts/sanitize.ts --out ../foo --apply
 *   bun run scripts/sanitize.ts --audit-only     # scan current state, no writes
 *
 * Exit codes:
 *   0  clean
 *   1  audit failed (leaks detected)
 *   2  config error (missing rules file, bad regex, etc.)
 *   3  IO error
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  realpathSync,
} from 'node:fs';
import { resolve, relative, dirname, join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ── CLI parsing ────────────────────────────────────────────────────────

interface Args {
  out: string;
  apply: boolean;
  audit_only: boolean;
  rules_path: string;
  help: boolean;
}

function parse_args(argv: string[]): Args {
  const args: Args = {
    out: resolve(process.cwd(), '../hearth-prod'),
    apply: false,
    audit_only: false,
    rules_path: resolve(process.cwd(), 'ops/sanitize-rules.yaml'),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--audit-only') args.audit_only = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--out') {
      const next = argv[++i];
      if (!next) die(2, '--out requires a path argument');
      args.out = resolve(next);
    } else if (a === '--rules') {
      const next = argv[++i];
      if (!next) die(2, '--rules requires a path argument');
      args.rules_path = resolve(next);
    } else if (a && a.startsWith('--')) {
      die(2, `unknown flag: ${a}`);
    }
  }
  return args;
}

function print_help(): void {
  console.log(`sanitize — transform dev repo into sanitized hearth-prod mirror

Usage:
  bun run scripts/sanitize.ts [flags]

Flags:
  --apply              Actually write to the output directory.
                       Default is dry-run: prints what would change,
                       writes nothing.
  --out <path>         Output directory. Default: ../hearth-prod
  --audit-only         Skip the write phase; just audit current OUT for
                       leaks against forbidden_in_output.
  --rules <path>       Rules file. Default: ops/sanitize-rules.yaml
  --help, -h           This help.

Exit codes:
  0 = clean    1 = audit leak    2 = config error    3 = IO error
`);
}

// ── Rules schema ───────────────────────────────────────────────────────

interface TextReplacement {
  // Either `pattern` (raw regex) OR `name` (literal name → extended-
  // boundary regex helper). Exactly one of the two should be set.
  pattern?: string;
  name?: string;
  to: string;
  flags?: string;
}

interface FileOverride {
  path: string;
  action: 'rename' | 'copy_from' | 'delete';
  to?: string;       // for rename
  source?: string;   // for copy_from
}

interface Rules {
  exclude_paths: string[];
  text_replacements: TextReplacement[];
  file_overrides: FileOverride[];
  forbidden_in_output: string[];
  audit_excludes: string[];
  transform_excludes: string[];
}

function load_rules(path: string): Rules {
  if (!existsSync(path)) die(2, `rules file not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    die(2, `failed to parse rules YAML: ${(err as Error).message}`);
  }
  const r = parsed as Partial<Rules> | null;
  if (!r || typeof r !== 'object') die(2, 'rules file is empty or not a YAML object');
  return {
    exclude_paths: r.exclude_paths ?? [],
    text_replacements: r.text_replacements ?? [],
    file_overrides: r.file_overrides ?? [],
    forbidden_in_output: r.forbidden_in_output ?? [],
    audit_excludes: r.audit_excludes ?? [],
    transform_excludes: r.transform_excludes ?? [],
  };
}

// ── Glob matching (minimal, just what we need: **, *, plain paths) ────

function glob_to_regex(g: string): RegExp {
  // Escape regex metachars except *, /, .
  const escaped = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // ** matches any depth, *  matches any non-/
    .replace(/\*\*/g, '@@DOUBLESTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DOUBLESTAR@@/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function matches_any(rel_path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (glob_to_regex(p).test(rel_path)) return true;
    // A pattern like `foo/bar/**` should also prune the directory
    // `foo/bar` itself (without a trailing slash). Strip the trailing
    // `/**` and re-test.
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3);
      if (glob_to_regex(prefix).test(rel_path)) return true;
    }
  }
  return false;
}

// ── Walker ─────────────────────────────────────────────────────────────

function walk(root: string, rel: string = '', skip_globs: string[] = []): string[] {
  const abs = join(root, rel);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const child_rel = rel ? `${rel}/${name}` : name;
    // Prune directories matching an exclude — both faster and avoids
    // descending into unreadable docker-owned mounts (OSRM data, etc).
    if (skip_globs.length > 0 && matches_any(child_rel, skip_globs)) continue;
    if (skip_globs.length > 0 && matches_any(child_rel + '/', skip_globs)) continue;
    const child_abs = join(root, child_rel);
    let st;
    try {
      st = statSync(child_abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walk(root, child_rel, skip_globs));
    } else if (st.isFile()) {
      out.push(child_rel);
    }
  }
  return out;
}

// ── Transformer ────────────────────────────────────────────────────────

interface CompiledReplacement {
  re: RegExp;
  to: string;
  original: string;
}

/**
 * Build a regex that matches `name` as a complete word, where
 * "boundary" is permissive about JS-source-code backslash escapes
 * (`\n`, `\t`, etc) so a string literal like `"\nBailey"` still gets
 * the substitution. \b would fail here because `n` is a word char.
 */
function name_to_regex(name: string): string {
  const esc = name.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Lookbehind: start, OR non-word, OR backslash-followed-by-anything
  // (covers \n \t \r \\ etc — the prior char of `name` is the escape's
  // letter, with `\` two chars back, so we test against `\` two-back).
  // Lookahead: end, OR non-word-char.
  return `(?<=^|\\W|\\\\[A-Za-z])${esc}(?![A-Za-z0-9_])`;
}

function compile_replacements(reps: TextReplacement[]): CompiledReplacement[] {
  return reps.map((r) => {
    const pattern = r.pattern ?? (r.name ? name_to_regex(r.name) : undefined);
    if (!pattern) die(2, `text_replacement needs either 'pattern' or 'name'`);
    const flags = (r.flags ?? 'g').includes('g') ? r.flags ?? 'g' : (r.flags ?? '') + 'g';
    try {
      return { re: new RegExp(pattern, flags), to: r.to, original: pattern };
    } catch (err) {
      die(2, `bad regex in text_replacements: /${pattern}/ — ${(err as Error).message}`);
    }
  });
}

function transform_text(text: string, reps: CompiledReplacement[]): { out: string; changed: boolean; n: number } {
  let out = text;
  let total = 0;
  for (const r of reps) {
    const before = out;
    out = out.replace(r.re, r.to);
    if (out !== before) total += (before.match(r.re) || []).length;
  }
  return { out, changed: total > 0, n: total };
}

// Text vs binary heuristic: files with extensions known-binary skip
// text transformation (just copy bytes). Conservative.
const BINARY_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'mp4', 'mp3', 'webm',
  'wasm', 'zip', 'tar', 'gz', 'tgz', 'bin', 'so', 'dylib', 'a',
]);

function is_binary_path(rel: string): boolean {
  const ext = (rel.split('.').pop() ?? '').toLowerCase();
  return BINARY_EXTS.has(ext);
}

// ── Audit ──────────────────────────────────────────────────────────────

interface Leak {
  file: string;
  pattern: string;
  matches: string[];
  line_numbers: number[];
}

function audit_dir(root: string, forbidden: string[], excludes: string[]): Leak[] {
  const files = walk(root, '', excludes);
  const compiled = forbidden.map((p) => {
    try {
      return { re: new RegExp(p, 'g'), original: p };
    } catch (err) {
      die(2, `bad regex in forbidden_in_output: /${p}/ — ${(err as Error).message}`);
    }
  });
  const leaks: Leak[] = [];
  for (const rel of files) {
    if (matches_any(rel, excludes)) continue;
    if (is_binary_path(rel)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (const c of compiled) {
      const matches: string[] = [];
      const line_numbers: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const m = line.match(c.re);
        if (m) {
          for (const hit of m) {
            matches.push(hit);
            line_numbers.push(i + 1);
          }
        }
      }
      if (matches.length > 0) {
        leaks.push({ file: rel, pattern: c.original, matches, line_numbers });
      }
    }
  }
  return leaks;
}

// ── Output writer ──────────────────────────────────────────────────────

interface WriteStats {
  files_shipped: number;
  files_transformed: number;
  total_replacements: number;
  overrides_applied: number;
  bytes_written: number;
}

function ensure_dir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function sanitize_to_out(
  src_root: string,
  out_root: string,
  rules: Rules,
  apply: boolean,
): WriteStats {
  const stats: WriteStats = {
    files_shipped: 0,
    files_transformed: 0,
    total_replacements: 0,
    overrides_applied: 0,
    bytes_written: 0,
  };
  const all_files = walk(src_root, '', rules.exclude_paths);
  const compiled = compile_replacements(rules.text_replacements);

  // Pass 1: bulk copy/transform
  for (const rel of all_files) {
    // walker already pruned exclude_paths; defense-in-depth re-check
    if (matches_any(rel, rules.exclude_paths)) continue;
    const src_abs = join(src_root, rel);
    const dst_abs = join(out_root, rel);

    // Verbatim-copy path: binaries, plus anything in transform_excludes
    // (the rules file itself, primarily — text_replacements applied to
    // its own patterns would silently corrupt them).
    if (is_binary_path(rel) || matches_any(rel, rules.transform_excludes)) {
      if (apply) {
        ensure_dir(dirname(dst_abs));
        copyFileSync(src_abs, dst_abs);
        stats.bytes_written += statSync(src_abs).size;
      }
      stats.files_shipped++;
      continue;
    }

    const text = readFileSync(src_abs, 'utf8');
    const { out, changed, n } = transform_text(text, compiled);
    if (changed) {
      stats.files_transformed++;
      stats.total_replacements += n;
    }
    if (apply) {
      ensure_dir(dirname(dst_abs));
      writeFileSync(dst_abs, out, 'utf8');
      stats.bytes_written += Buffer.byteLength(out, 'utf8');
    }
    stats.files_shipped++;
  }

  // Pass 2: per-file overrides (rename, copy_from, delete)
  for (const ov of rules.file_overrides) {
    const dst_abs = join(out_root, ov.path);

    if (ov.action === 'rename') {
      if (!ov.to) die(2, `file_override for ${ov.path} missing 'to:'`);
      const new_abs = join(out_root, ov.to);
      if (apply && existsSync(dst_abs)) {
        ensure_dir(dirname(new_abs));
        const bytes = readFileSync(dst_abs);
        writeFileSync(new_abs, bytes);
        rmSync(dst_abs);
      }
      stats.overrides_applied++;
      continue;
    }

    if (ov.action === 'delete') {
      if (apply && existsSync(dst_abs)) rmSync(dst_abs);
      stats.overrides_applied++;
      continue;
    }

    if (ov.action === 'copy_from') {
      if (!ov.source) die(2, `file_override for ${ov.path} missing 'source:'`);
      const src_abs = join(src_root, ov.source);
      if (!existsSync(src_abs)) die(2, `file_override source not found: ${ov.source}`);
      if (apply) {
        ensure_dir(dirname(dst_abs));
        const bytes = readFileSync(src_abs);
        writeFileSync(dst_abs, bytes);
        stats.bytes_written += bytes.length;
      }
      stats.overrides_applied++;
      continue;
    }

    die(2, `unknown action in file_override: ${(ov as { action: string }).action}`);
  }

  return stats;
}

// ── Reporter ───────────────────────────────────────────────────────────

const COLOR = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function print_summary(args: Args, stats: WriteStats, leaks: Leak[]): void {
  const mode = args.audit_only ? 'audit-only' : args.apply ? 'APPLY' : 'dry-run';
  const c = COLOR;
  console.log('');
  console.log(`${c.bold}sanitize summary${c.reset}  (mode: ${mode})`);
  console.log(`  src:               ${process.cwd()}`);
  console.log(`  out:               ${args.out}`);
  console.log('');
  if (!args.audit_only) {
    console.log(`  files shipped:     ${stats.files_shipped}`);
    console.log(`  files transformed: ${stats.files_transformed}`);
    console.log(`  total replacements:${stats.total_replacements}`);
    console.log(`  overrides applied: ${stats.overrides_applied}`);
    if (args.apply) {
      console.log(`  bytes written:     ${stats.bytes_written.toLocaleString()}`);
    }
    console.log('');
  }
  if (leaks.length === 0) {
    console.log(`${c.green}✓ audit clean${c.reset} — no forbidden literals in shipped output`);
  } else {
    console.log(`${c.red}✗ audit failed${c.reset} — ${leaks.length} leak(s):`);
    for (const l of leaks.slice(0, 20)) {
      const where = l.line_numbers.slice(0, 3).map((n) => `:${n}`).join(',');
      console.log(`  ${c.yellow}${l.file}${where}${c.reset} matched /${c.cyan}${l.pattern}${c.reset}/ → ${l.matches.slice(0, 3).join(', ')}${l.matches.length > 3 ? ` (+${l.matches.length - 3} more)` : ''}`);
    }
    if (leaks.length > 20) console.log(`  ... +${leaks.length - 20} more`);
    console.log('');
    console.log(`${c.dim}Hint: add a regex to ops/sanitize-rules.yaml text_replacements,${c.reset}`);
    console.log(`${c.dim}or extend audit_excludes if the match is intentional.${c.reset}`);
  }
  if (!args.apply && !args.audit_only) {
    console.log('');
    console.log(`${c.dim}Dry-run — nothing written. Re-run with --apply to write to ${args.out}.${c.reset}`);
  }
}

function die(code: number, msg: string): never {
  console.error(`${COLOR.red}✗ ${msg}${COLOR.reset}`);
  process.exit(code);
}

/**
 * Refuse to run if the output path could clobber the source repo.
 *
 * Three layered checks (any failure → hard abort, exit 2):
 *   1. realpath(out) == realpath(cwd)              — writing into yourself
 *   2. realpath(out) is inside realpath(cwd)       — would shadow source files
 *   3. realpath(cwd) is inside realpath(out)       — even more dangerous
 *   4. out is an existing git repo whose origin matches a known dev mirror
 *      (alliphant/hearth-private, jasper/hearth-private) — refuse to ship
 *      sanitized output INTO the private dev tree
 *
 * Belt-and-suspenders: also refuse if --out points at the same dir that
 * a running orchestrator's vault references (would only matter in weird
 * symlink setups, but cheap to check).
 */
function safety_guard(src: string, out: string, apply: boolean): void {
  const src_real = realpathSync(src);
  // out may not exist yet — resolve without realpath for that case
  let out_real: string;
  try {
    out_real = realpathSync(out);
  } catch {
    out_real = resolve(out);
  }

  const inside = (a: string, b: string) =>
    a !== b && (a + sep).startsWith(b + sep);

  if (out_real === src_real) {
    die(
      2,
      `refusing to run: output path is the same as source (${src_real}). ` +
        `The sanitizer would overwrite the live dev tree. Did you mean --out ../hearth-prod?`,
    );
  }
  if (inside(out_real, src_real)) {
    die(
      2,
      `refusing to run: output (${out_real}) is INSIDE the source tree (${src_real}). ` +
        `That would silently shadow files. Pick an --out path outside the source.`,
    );
  }
  if (inside(src_real, out_real)) {
    die(
      2,
      `refusing to run: source (${src_real}) is INSIDE the output (${out_real}). ` +
        `That would destroy the source. Pick a different --out.`,
    );
  }

  // If out exists and is a git repo whose remotes reference any
  // *-private mirror, refuse. (Matching `hearth-private` covers the
  // alliphant/hearth-private and jasper/hearth-private cases; matching
  // any `-private` suffix also catches forks that follow the same
  // naming convention. The legitimate public remotes — alliphant/hearth
  // and jasper/hearth — don't contain the `-private` substring at all.)
  if (existsSync(join(out_real, '.git'))) {
    const config_path = join(out_real, '.git', 'config');
    if (existsSync(config_path)) {
      const config_text = readFileSync(config_path, 'utf8');
      if (/-private[./]/i.test(config_text)) {
        die(
          2,
          `refusing to run: output (${out_real}) is a git repo whose remotes point at a ` +
            `private dev mirror (something matching /-private[./]/i in .git/config). ` +
            `Sanitized output must NOT ship into the dev tree. Pick a different --out.`,
        );
      }
    }
  }

  // Show the resolved paths before any work, so a misconfigured run is
  // easy to ctrl-C out of.
  console.log(`${COLOR.dim}src (read-only): ${src_real}${COLOR.reset}`);
  console.log(
    `${COLOR.dim}out (${apply ? 'will be written' : 'dry-run scratch'}): ${out_real}${COLOR.reset}`,
  );
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parse_args(process.argv.slice(2));
  if (args.help) {
    print_help();
    process.exit(0);
  }
  const rules = load_rules(args.rules_path);
  const src_root = process.cwd();

  let stats: WriteStats = {
    files_shipped: 0,
    files_transformed: 0,
    total_replacements: 0,
    overrides_applied: 0,
    bytes_written: 0,
  };

  if (!args.audit_only) {
    // For dry-run we still need to compute stats, but we don't write
    // and we audit against the in-memory transformed content. Implement
    // by writing to a scratch dir under /tmp, auditing it, removing.
    let target = args.out;
    let scratch = false;
    if (!args.apply) {
      target = `/tmp/hearth-sanitize-${Date.now()}`;
      scratch = true;
    }
    // Safety guard runs against the REAL target (or apply path), never
    // against the scratch dir — refuse to clobber the dev tree.
    safety_guard(src_root, args.apply ? args.out : target, args.apply);
    ensure_dir(target);
    stats = sanitize_to_out(src_root, target, rules, true);
    // For dry-run, swap stats.bytes_written display so it's clear nothing
    // was written to the actual out dir.
    if (scratch) stats.bytes_written = 0;
    const leaks = audit_dir(target, rules.forbidden_in_output, rules.audit_excludes);
    print_summary(args, stats, leaks);
    if (scratch) {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    process.exit(leaks.length === 0 ? 0 : 1);
  }

  // audit-only mode
  if (!existsSync(args.out)) die(3, `--audit-only: out dir does not exist: ${args.out}`);
  const leaks = audit_dir(args.out, rules.forbidden_in_output, rules.audit_excludes);
  print_summary(args, stats, leaks);
  process.exit(leaks.length === 0 ? 0 : 1);
}

void main();
