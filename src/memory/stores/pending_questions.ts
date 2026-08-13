/**
 * Persistence for the `present_questions` tool.
 *
 * A specialist mid-turn can call `present_questions` to surface 1-4
 * multi-select questions to Jasper instead of monologuing through an
 * implicit decision. Each call creates a row here; the web pane renders
 * the form; Jasper submits; the answer endpoint marks the row answered
 * and fires a fresh specialist turn so the specialist can act on the
 * choices. See `src/tools/present_questions.ts` for the tool itself and
 * the `/api/present-questions/...` route in `routes/specialists.ts`.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface QuestionSpec {
  id: string;
  text: string;
  options: QuestionOption[];
  multi_select?: boolean;
  // The user the form is for — any user id (owner, household, or a
  // friend-tier seller like 'kim'), or 'either'. Defaults at the tool to
  // the CONVERSATION's user, not a hardcoded 'jasper' (which mis-stamped a
  // friend's form as the owner's). Informational today — the client renders
  // any pending set for the active conversation — but kept honest so a
  // future per-user filter is correct.
  target_user?: string;
}

export type AnswerValue = string | string[];

export interface PendingQuestionRow {
  id: string;
  ts_created: string;
  ts_answered: string | null;
  specialist_id: string;
  conversation_id: string | null;
  brief_id: string | null;
  anchor_message_id: string | null;
  intro_md: string | null;
  questions: QuestionSpec[];
  answers: Record<string, AnswerValue> | null;
  status: 'pending' | 'answered' | 'superseded';
}

interface RawRow {
  id: string;
  ts_created: string;
  ts_answered: string | null;
  specialist_id: string;
  conversation_id: string | null;
  brief_id: string | null;
  anchor_message_id: string | null;
  intro_md: string | null;
  questions_json: string;
  answers_json: string | null;
  status: 'pending' | 'answered' | 'superseded';
}

function hydrate(row: RawRow): PendingQuestionRow {
  let questions: QuestionSpec[] = [];
  try {
    questions = JSON.parse(row.questions_json) as QuestionSpec[];
  } catch {
    questions = [];
  }
  let answers: Record<string, AnswerValue> | null = null;
  if (row.answers_json) {
    try {
      answers = JSON.parse(row.answers_json) as Record<string, AnswerValue>;
    } catch {
      answers = null;
    }
  }
  return {
    id: row.id,
    ts_created: row.ts_created,
    ts_answered: row.ts_answered,
    specialist_id: row.specialist_id,
    conversation_id: row.conversation_id,
    brief_id: row.brief_id,
    anchor_message_id: row.anchor_message_id,
    intro_md: row.intro_md,
    questions,
    answers,
    status: row.status,
  };
}

export class PendingQuestionsStore {
  constructor(private db: Database) {}

  create(input: {
    specialist_id: string;
    conversation_id?: string | null;
    brief_id?: string | null;
    anchor_message_id?: string | null;
    intro_md?: string | null;
    questions: QuestionSpec[];
  }): PendingQuestionRow {
    const id = `pq_${ulid().toLowerCase().slice(-12)}`;
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pending_questions
           (id, ts_created, specialist_id, conversation_id, brief_id,
            anchor_message_id, intro_md, questions_json, status)
         VALUES (@id, @ts, @sid, @cid, @bid, @amid, @intro, @qjson, 'pending')`,
      )
      .run({
        '@id': id,
        '@ts': ts,
        '@sid': input.specialist_id,
        '@cid': input.conversation_id ?? null,
        '@bid': input.brief_id ?? null,
        '@amid': input.anchor_message_id ?? null,
        '@intro': input.intro_md ?? null,
        '@qjson': JSON.stringify(input.questions),
      });
    return {
      id,
      ts_created: ts,
      ts_answered: null,
      specialist_id: input.specialist_id,
      conversation_id: input.conversation_id ?? null,
      brief_id: input.brief_id ?? null,
      anchor_message_id: input.anchor_message_id ?? null,
      intro_md: input.intro_md ?? null,
      questions: input.questions,
      answers: null,
      status: 'pending',
    };
  }

  get(id: string): PendingQuestionRow | null {
    const r = this.db
      .prepare(`SELECT * FROM pending_questions WHERE id = @id`)
      .get({ '@id': id }) as RawRow | undefined;
    return r ? hydrate(r) : null;
  }

  /**
   * Mark answered and stash the answer map. Returns the updated row or
   * null when the id is unknown or the row is already in a terminal
   * state (we don't overwrite an existing answer; the route surfaces a
   * 409 in that case).
   */
  answer(
    id: string,
    answers: Record<string, AnswerValue>,
  ): PendingQuestionRow | null {
    const cur = this.get(id);
    if (!cur) return null;
    if (cur.status !== 'pending') return null;
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE pending_questions
            SET status = 'answered', ts_answered = @ts, answers_json = @ajson
          WHERE id = @id AND status = 'pending'`,
      )
      .run({
        '@id': id,
        '@ts': ts,
        '@ajson': JSON.stringify(answers),
      });
    return { ...cur, ts_answered: ts, answers, status: 'answered' };
  }

  list_pending_for_conversation(conversation_id: string): PendingQuestionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_questions
          WHERE conversation_id = @cid AND status = 'pending'
          ORDER BY ts_created ASC`,
      )
      .all({ '@cid': conversation_id }) as RawRow[];
    return rows.map(hydrate);
  }

  list_for_brief(brief_id: string): PendingQuestionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_questions
          WHERE brief_id = @bid
          ORDER BY ts_created ASC`,
      )
      .all({ '@bid': brief_id }) as RawRow[];
    return rows.map(hydrate);
  }
}
