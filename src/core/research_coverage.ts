/**
 * research_coverage — the deep-research coverage ledger (Deep Research v2
 * phase 2, 2026-07-29).
 *
 * The failure this exists for (design doc §2, F1). The owner asked for a
 * workup with six facets: a councilmember's record and stated reasons, an
 * assessment of those reasons, his re-election timing, what the city charter
 * requires for a recall, and the public case against a successor camera
 * vendor. What came back was a biography. Absent ENTIRELY: the recall
 * procedure, the successor-vendor case, the budget analysis, and the subject's
 * own stated reasoning.
 *
 * The cause was arithmetic, not judgment — six facets against a fan-out of six
 * sub-questions at three fetches each, where one facet alone ("what does the
 * charter require for a recall") needs sustained reading of a JS-rendered
 * municipal-code site. But the *damage* was that *nothing recorded the loss*.
 * A facet that was never attempted looked identical, in the finished dossier,
 * to one the sources genuinely could not answer, and identical to one that was
 * simply not asked. The reader had to notice an absence.
 *
 * So: every planned sub-question becomes a tracked facet, the dossier OPENS
 * with the ledger, and an investigation still carrying `not_attempted` facets
 * is `incomplete` rather than `done` — a state the existing sweep can resume.
 *
 * Everything here is PURE and needs no evidence corpus, no LLM, and no db —
 * which is why it can be pinned by a fast unit smoke (`smoke:research-coverage`)
 * and why it works regardless of what the verifier can or cannot check.
 *
 * It lives in src/core (not in the runner) so the office route and the read
 * tools can render a ledger without importing the runner's connector graph —
 * the same reason research_fetch.ts was lifted out.
 */
import type {
  CoverageFacet,
  CoverageLedger,
  FacetStatus,
  InvestigationPlan,
  SubQuestionResult,
} from '@memory/stores/research_investigations';

/** Facets whose absence makes an investigation `incomplete`, not `done`. */
export function has_unattempted(ledger: CoverageLedger | null | undefined): boolean {
  return (ledger?.facets ?? []).some((f) => f.status === 'not_attempted');
}

/**
 * Map the plan + whatever the investigators returned into the ledger.
 *
 * The mapping is deliberately mechanical — the honesty comes from the
 * sub-investigator having recorded WHICH kind of nothing it hit
 * (`not_attempted` vs `failed`), not from inference here:
 *
 *   - no result at all, or `not_attempted`  → **not_attempted** (resumable:
 *     the slice deadline ran out, or the search backend never answered — we
 *     did not look, which is different from having looked and found nothing)
 *   - `failed`                             → **unanswerable** (we looked; the
 *     sources do not support an answer, and the reason says why)
 *   - `partial` / `ok` with no findings    → **unanswerable**
 *   - `partial` with findings              → **partial**
 *   - `ok` with findings                   → **answered**
 */
export function compute_coverage(
  plan: InvestigationPlan | null | undefined,
  results: readonly SubQuestionResult[],
): CoverageLedger {
  const by_id = new Map<string, SubQuestionResult>();
  for (const r of results) by_id.set(r.sub_question_id, r);

  const facets: CoverageFacet[] = [];
  for (const sq of plan?.sub_questions ?? []) {
    const r = by_id.get(sq.id);
    const finding_count = r?.findings.length ?? 0;
    const source_count = r?.sources.length ?? 0;
    let status: FacetStatus;
    let reason: string | undefined;

    if (!r || r.status === 'not_attempted') {
      status = 'not_attempted';
      reason = r?.note ?? 'not attempted in this pass';
    } else if (r.status === 'failed') {
      status = 'unanswerable';
      reason = r.note ?? 'no answer could be grounded in available sources';
    } else if (finding_count === 0) {
      status = 'unanswerable';
      reason = r.note ?? 'sources were read but supported no answer';
    } else if (r.status === 'partial') {
      status = 'partial';
      reason = r.note ?? 'some sources could not be read';
    } else {
      status = 'answered';
    }

    facets.push({
      sub_question_id: sq.id,
      question: sq.question,
      status,
      ...(reason !== undefined ? { reason } : {}),
      finding_count,
      source_count,
    });
  }
  return { facets };
}

/** Counts by status, for a one-line summary. */
export function coverage_tally(
  ledger: CoverageLedger | null | undefined,
): Record<FacetStatus, number> & { total: number } {
  const tally = {
    answered: 0,
    partial: 0,
    unanswerable: 0,
    not_attempted: 0,
    total: 0,
  };
  for (const f of ledger?.facets ?? []) {
    tally[f.status] += 1;
    tally.total += 1;
  }
  return tally;
}

/** One-line human summary — "4 of 6 answered (1 partial, 1 not attempted)". */
export function coverage_summary_line(ledger: CoverageLedger | null | undefined): string {
  const t = coverage_tally(ledger);
  if (t.total === 0) return 'no facets planned';
  const extras: string[] = [];
  if (t.partial > 0) extras.push(`${t.partial} partial`);
  if (t.unanswerable > 0) extras.push(`${t.unanswerable} unanswerable`);
  if (t.not_attempted > 0) extras.push(`${t.not_attempted} not attempted`);
  return (
    `${t.answered} of ${t.total} facet(s) answered` +
    (extras.length > 0 ? ` (${extras.join(', ')})` : '')
  );
}

const MARK: Record<FacetStatus, string> = {
  answered: '✅ answered',
  partial: '🟡 partial',
  unanswerable: '⛔ unanswerable',
  not_attempted: '⬜ not attempted',
};

/**
 * The markdown block the dossier OPENS with.
 *
 * Rendered deterministically and prepended by the runner rather than asked of
 * the synthesiser: the whole point is that the reader cannot miss what was not
 * established, and a section the model composes is a section the model can
 * quietly omit. (This is not pre-injection working around a decision — the
 * model still writes every substantive word of the dossier; this is the
 * dossier's own table of contents, derived from what the pipeline recorded.)
 */
export function render_coverage_section(ledger: CoverageLedger | null | undefined): string {
  const facets = ledger?.facets ?? [];
  if (facets.length === 0) return '';
  const lines: string[] = [];
  lines.push('## Coverage');
  lines.push('');
  lines.push(`_${coverage_summary_line(ledger)}._`);
  lines.push('');
  for (const f of facets) {
    const detail =
      f.status === 'answered'
        ? `${f.finding_count} finding(s) from ${f.source_count} source(s)`
        : (f.reason ?? '');
    lines.push(`- **${MARK[f.status]}** — ${f.question}${detail ? ` — ${detail}` : ''}`);
  }
  const gaps = facets.filter((f) => f.status === 'not_attempted');
  if (gaps.length > 0) {
    lines.push('');
    lines.push(
      `> ⚠ ${gaps.length} facet(s) were never attempted, so this report is INCOMPLETE. ` +
        'Nothing below should be read as covering them.',
    );
  }
  return lines.join('\n');
}

/**
 * Put the coverage block at the top of the dossier, after the H1 when the
 * synthesiser wrote one (so the report still opens with its own title).
 * Idempotent: a dossier that already carries a Coverage section is returned
 * unchanged, so a re-synthesis on resume cannot stack two of them.
 */
export function prepend_coverage_section(
  dossier: string,
  ledger: CoverageLedger | null | undefined,
): string {
  const block = render_coverage_section(ledger);
  if (block === '') return dossier;
  if (/^##\s+Coverage\s*$/m.test(dossier)) return dossier;

  const lines = dossier.split('\n');
  let insert_at = 0;
  // Skip leading blanks, then take an H1 with us if there is one.
  while (insert_at < lines.length && lines[insert_at]!.trim() === '') insert_at++;
  if (insert_at < lines.length && /^#\s+\S/.test(lines[insert_at]!)) {
    insert_at++;
    // Carry any immediately-following bold metadata lines (the skeleton's
    // "**Brief:** …") above the ledger — they identify the report.
    while (insert_at < lines.length && lines[insert_at]!.trim() === '') insert_at++;
    while (insert_at < lines.length && /^\*\*[^*]+:\*\*/.test(lines[insert_at]!.trim())) {
      insert_at++;
    }
  } else {
    insert_at = 0;
  }
  const head = lines.slice(0, insert_at);
  const tail = lines.slice(insert_at);
  return [...head, '', block, '', ...tail].join('\n').replace(/\n{3,}/g, '\n\n');
}
