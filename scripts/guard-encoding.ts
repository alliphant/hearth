/**
 * guard:encoding — reject control bytes and invalid UTF-8 in tracked text source.
 *
 * Why this exists: during the 2026-06-03 Kristi work an editor wrote NUL bytes
 * where spaces were intended in `src/memory/stores/kristi_workstations.ts`.
 * `grep` silently SKIPS a file containing a NUL as "binary", so the corruption
 * was nearly invisible and would have shipped a broken `coverage_summary`; `tsc`
 * tolerated it. This guard byte-scans every tracked text file and fails loudly
 * with the file + byte offset of the first problem.
 *
 * Scope: `git ls-files` filtered to text source extensions
 * (.ts .tsx .js .md .yaml .yml .json .sql), minus machine-generated `*.min.js`
 * bundles. Single forward byte pass per file.
 *
 * Run: `bun run guard:encoding` (exits non-zero, listing offenders).
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const TEXT_EXT = new Set(['ts', 'tsx', 'js', 'md', 'yaml', 'yml', 'json', 'sql']);

interface Problem {
  offset: number;
  reason: string;
}

/**
 * First control byte or invalid-UTF-8 byte in `bytes`, or null if clean.
 * Minimal RFC-3629 validator — a single forward pass, no allocation.
 *
 * NUL (0x00) is technically valid UTF-8 (U+0000) but is banned outright: it's
 * the corruption class that motivated the guard, and grep hides it by treating
 * the whole file as binary.
 *
 * The OTHER C0 controls (and DEL) are banned for the same reason, added
 * 2026-08-02. Banning only NUL closed one byte and left the class open: for two
 * months `src/core/feed_parse.ts` carried literal 0x01/0x02 bytes as hash
 * delimiters — the identical authoring slip that later produced the NUL in
 * `process_misses.ts`, invisible the whole time because this guard did not look
 * for them. A control byte is never legitimate in hand-authored source; write
 * the `\x01` escape, which is runtime-identical and survives a grep.
 *
 * Tab / LF / CR are the only exceptions — they are ordinary text.
 *
 * There is deliberately NO per-line opt-out comment (the `time-guard-ok`
 * pattern). A hand-authored control byte has no legitimate use to grant an
 * exception to, and an inline comment cannot usefully annotate an invisible
 * byte anyway. Machine-generated bundles are handled by path (see
 * `tracked_text_files`), not by escape hatch.
 */
function first_problem(bytes: Uint8Array): Problem | null {
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i]!;
    if (b === 0x00) return { offset: i, reason: 'NUL byte (0x00)' };
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) {
      return {
        offset: i,
        reason:
          `control byte 0x${b.toString(16).padStart(2, '0')} — write it as the ` +
          `\\x${b.toString(16).padStart(2, '0')} escape, not a literal byte`,
      };
    }
    if (b < 0x80) {
      i++;
      continue;
    }
    // Determine sequence length + the allowed range of the FIRST continuation
    // byte (the lead byte constrains it; the rest are always 0x80–0xBF).
    let len: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      len = 2;
    } else if (b === 0xe0) {
      len = 3;
      lo = 0xa0;
    } else if (b >= 0xe1 && b <= 0xec) {
      len = 3;
    } else if (b === 0xed) {
      len = 3;
      hi = 0x9f;
    } else if (b >= 0xee && b <= 0xef) {
      len = 3;
    } else if (b === 0xf0) {
      len = 4;
      lo = 0x90;
    } else if (b >= 0xf1 && b <= 0xf3) {
      len = 4;
    } else if (b === 0xf4) {
      len = 4;
      hi = 0x8f;
    } else {
      return { offset: i, reason: `invalid UTF-8 lead byte 0x${b.toString(16).padStart(2, '0')}` };
    }
    if (i + len > n) {
      return { offset: i, reason: 'truncated UTF-8 sequence at end of file' };
    }
    for (let k = 1; k < len; k++) {
      const c = bytes[i + k]!;
      const clo = k === 1 ? lo : 0x80;
      const chi = k === 1 ? hi : 0xbf;
      if (c < clo || c > chi) {
        return { offset: i + k, reason: `invalid UTF-8 continuation byte 0x${c.toString(16).padStart(2, '0')}` };
      }
    }
    i += len;
  }
  return null;
}

function tracked_text_files(): string[] {
  const out = Bun.spawnSync(['git', 'ls-files'], { cwd: ROOT });
  if (out.exitCode !== 0) {
    console.error('guard:encoding — `git ls-files` failed:', out.stderr.toString());
    process.exit(2);
  }
  return out.stdout
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => {
      const dot = p.lastIndexOf('.');
      if (dot === -1) return false;
      if (!TEXT_EXT.has(p.slice(dot + 1).toLowerCase())) return false;
      // Minified bundles are machine-generated, not hand-authored, so the
      // "a literal control byte should have been an escape" rule does not
      // apply — the generator's output is not source anyone greps or edits.
      // `mermaid.min.js` legitimately carries a 0x01 inside its packed data.
      // Scoped to the `.min.js` convention rather than a path list so a newly
      // vendored bundle needs no edit here.
      if (p.toLowerCase().endsWith('.min.js')) return false;
      return true;
    });
}

interface Offender {
  file: string;
  problem: Problem;
}

function main(): void {
  const files = tracked_text_files();
  const offenders: Offender[] = [];
  for (const rel of files) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(`${ROOT}/${rel}`);
    } catch {
      continue; // tracked-but-absent (e.g. mid-rebase); skip rather than crash
    }
    const problem = first_problem(bytes);
    if (problem) offenders.push({ file: rel, problem });
  }

  if (offenders.length === 0) {
    console.log(`guard:encoding — clean (${files.length} tracked text files, no control bytes / invalid UTF-8)`);
    return;
  }

  console.error(`guard:encoding — ${offenders.length} file(s) with control bytes or invalid UTF-8:\n`);
  for (const o of offenders) {
    console.error(`  ${o.file}: byte ${o.problem.offset} — ${o.problem.reason}`);
  }
  process.exit(1);
}

main();
