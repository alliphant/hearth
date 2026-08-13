#!/usr/bin/env bash
# Grade the grounding engine — Phase 1a/2a (commit 23cad96) + 1b (commit bc58b79),
# deployed to the LLM host 2026-06-05. Splits the audit_log at the deploy cutoff and
# compares re-roll-guard rates for the worst-offender specialists, plus confirms
# 1a (auto-RAG) + 1b (structured packs) are firing. Self-computing — no stale
# hardcoded baseline; it reads both windows live.
#
# ⚠ GOTCHA (load-bearing): audit_log.ts is ISO-8601 TEXT (e.g.
# 2026-06-05T20:44:36.997Z), NOT ms-epoch. Time filters MUST be ISO-string
# comparisons. A numeric ms compare (`ts > 1780689005393`) silently matches
# EVERY row (lexicographic "2026" > "1780") and looks like "no change" — the
# trap that made the first cut of this script lie. Do not reintroduce it.
#
# Run from a machine with SSH access to the LLM host (Jasper's Mac / tailnet):
#   bash scripts/grade-grounding.sh
set -uo pipefail

CUT='2026-06-05T19:50:00.000Z'   # ~deploy moment (1a/2a; 1b followed same day)
DB=/docker/hearth/data/hearth.db
Q() { ssh your-llm-host.local "sqlite3 -readonly $DB \"$1\""; }
GUARDS="SUM(tool_name='specialist_turn') turns, SUM(tool_name='fact_critic') fact_critic, SUM(tool_name='ghost_promise_guard') ghost, SUM(tool_name='provenance_guard') prov, SUM(tool_name='blank_turn_fallback') blank"
WHO="agent IN ('ruby','anna','kristi','kate')"

echo "================ GROUNDING ENGINE — GRADE ================"
echo "Cutoff: $CUT   (commits 23cad96=1a/2a, bc58b79=1b)"
echo "audit_log.ts is ISO-8601 text — filters use STRING compare (see header)."
echo
echo "---- BASELINE  (pre-deploy: ts < cutoff) ----"
Q "SELECT agent, $GUARDS FROM audit_log WHERE ts < '$CUT' AND $WHO GROUP BY agent ORDER BY turns DESC;"
echo
echo "---- SINCE DEPLOY  (ts >= cutoff) ----"
echo "    success = Anna/Ruby/Kristi (fact_critic+ghost+prov)/turns materially BELOW baseline"
Q "SELECT agent, $GUARDS FROM audit_log WHERE ts >= '$CUT' AND $WHO GROUP BY agent ORDER BY turns DESC;"
echo
echo "---- 1b firing? (grounding_pack rows since deploy) ----"
Q "SELECT agent, COUNT(*) packs FROM audit_log WHERE tool_name='grounding_pack' AND ts >= '$CUT' GROUP BY agent ORDER BY packs DESC;"
echo
echo "---- 1a firing? (rag_retrieval rows since deploy) ----"
Q "SELECT agent, COUNT(*) rag FROM audit_log WHERE tool_name='rag_retrieval' AND ts >= '$CUT' GROUP BY agent ORDER BY rag DESC LIMIT 12;"
echo
echo "========================================================="
echo "READ IT: need >= ~15-20 chat turns/specialist since deploy for signal."
echo "Empty 'since deploy' => not enough usage yet, wait. grounding_pack ~0 for"
echo "anna/ruby/kristi => 1b isn't matching their messages (revisit the keyword/"
echo "address/vendor gating in src/core/grounding_packs.ts)."
echo
echo "======= KATE PERSON-MODEL POLISH (deployed 2026-07-28) ======="
KCUT='2026-07-28T00:00:00.000Z'   # person-model polish deploy day
echo "---- Kate guard rate, 14d before vs since $KCUT ----"
Q "SELECT CASE WHEN ts < '$KCUT' THEN 'before' ELSE 'since' END win, $GUARDS FROM audit_log WHERE agent='kate' AND ts >= '2026-07-14T00:00:00.000Z' GROUP BY win;"
echo
echo "---- Kate pack fires since deploy (household/person/security ride grounding_pack) ----"
Q "SELECT date(ts) d, COUNT(*) packs FROM audit_log WHERE tool_name='grounding_pack' AND agent='kate' AND ts >= '$KCUT' GROUP BY d ORDER BY d DESC LIMIT 10;"
echo
echo "---- Appearance profile health (rows should be ACTIVE and refreshing) ----"
Q "SELECT kind, dismissed, COUNT(*), MAX(observed_at) FROM person_observations WHERE kind LIKE 'appearance%' GROUP BY kind, dismissed;"
echo
echo "---- Owner self-distill landing? (imessage obs on the owner's person row) ----"
Q "SELECT p.name, o.kind, COUNT(*) FROM person_observations o JOIN people p ON p.id=o.person_id WHERE o.source_type='imessage' AND p.relationship='self' GROUP BY p.name, o.kind;"
echo
echo "READ IT: 'since' guard rate at or below 'before' with packs firing = the"
echo "polish is working. appearance dismissed=1 rows reappearing = the decay"
echo "exemption regressed. Empty owner self-distill after a nightly run with"
echo "iMessage windows staged = check the People row resolves (relationship:"
echo "self or exact display-name match) — the self-distill skips silently."
