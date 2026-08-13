# hearth-backend — harness working notes

Distilled rules for coding agents/harnesses (OpenCode et al). The full
orientation lives in the private dev log — that file is ~90k tokens and does NOT fit
a local-model context; `opencode_build` overwrites it with this file inside
its scratch worktrees (Phase-0 eval 2026-07-18: auto-ingesting the full
the private dev log put the harness into a fatal compaction loop on the 49k slot).
Keep this file SHORT — it ships into every harness run's context.

Bun + TypeScript orchestrator. Conventions that matter:

- Typecheck: `bunx tsc --noEmit`. Run scripts with `bun run <path>` or the
  package.json script entries.
- Path aliases: `@core/*`→src/core, `@memory/*`→src/memory,
  `@app/*`→src/app, `@library/*`→src/library, `@specialists/*`→src/specialists.
- bun:sqlite named binds MUST carry their sigil: `stmt.run({ '@id': x })`,
  never `{ id: x }` (bare keys silently bind NULL).
- Timestamps are ISO-8601 TEXT; lexicographic compare IS chronological.
- Smoke scripts: scripts/smoke-*.ts with a local assert() failure counter,
  ✓/✗ lines, a final PASSED/FAILED line, and explicit process.exit.
- ONLY edit under src/, config/, scripts/, apps/ — root files
  (package.json, AGENTS.md), .env, data/, node_modules are outside the
  change-pipeline allowlist.
- Do not delete or rename files in a harness run (deletions are not
  collected) — edit in place or add new files.
- Every change ships through review: checks → adversarial critique → Kate
  review → owner merge. A correct minimal change beats a broad one.
