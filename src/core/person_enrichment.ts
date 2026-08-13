/**
 * person_enrichment — the self-maintaining dossier (2026-06-22).
 *
 * Mirrors the user-model learning loop, but the subject is OTHER people: a
 * nightly sweep mines the exhaust the system already stores (recent user
 * messages) for durable facts the user stated about people in their contact
 * graph, and merges them into the People/ note as STRUCTURED fields — so
 * "Sam's allergic to shellfish, and she got a dog named Biscuit" said in chat
 * lands in dietary + pets without any data entry.
 *
 * Disciplines (mirroring user_model_observers / sweep_user_models):
 *   - DARK by default (HEARTH_PERSON_ENRICH=1) — the sweep no-ops when off.
 *   - CHEAP tier (HEARTH_PERSON_ENRICH_TIER, default planner = the idle 3am 9B).
 *   - CORDONED — a message enriches only people its conversation OWNER can see;
 *     writes reuse upsert_person_note so the person stamp + schema validation
 *     apply. Genealogy excluded.
 *   - GROUNDED — extraction returns ONLY facts explicitly stated (no inference),
 *     fail-open to nothing on a parse/LLM error.
 *   - IDEMPOTENT — merges are union-dedup, so re-running over the same window
 *     adds a fact at most once. (No free-text note append, precisely so the
 *     nightly re-run can't duplicate.)
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient, PersonRow } from '@memory/client';
import type { UserRegistry } from '@core/users';
import { note_visible_to_caller, parse_private_to, type Caller } from '@memory/private_to';
import { parse_fm, is_genealogy, is_public_figure } from '@core/relationship_signals';
import { upsert_person_note } from '@agents/scribe/tools/upsert_person_note';

export function person_enrich_enabled(): boolean {
  return process.env.HEARTH_PERSON_ENRICH === '1';
}
function tier(): string {
  return process.env.HEARTH_PERSON_ENRICH_TIER || 'planner';
}
function window_ms(): number {
  const n = Number.parseInt(process.env.HEARTH_PERSON_ENRICH_WINDOW_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 26 * 60 * 60 * 1000; // 26h covers a daily run
}

export interface ExtractedFacts {
  interests?: string[];
  dislikes?: string[];
  dietary?: string[];
  pets?: Array<{ name: string; species?: string; notes?: string }>;
  important_dates?: Array<{ date: string; what: string; recurring?: boolean }>;
  relations?: Array<{ name: string; relation: string; birthday?: string }>;
}

/** Minimal LLM surface — LLMRouter satisfies it structurally; the smoke fakes it. */
export interface EnrichLLM {
  for_role(role: string): { provider: { complete(req: { messages: Array<{ role: string; content: string }>; temperature?: number; max_tokens?: number; think?: boolean }): Promise<{ content: string }> } };
}

function strip_fence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

const EXTRACT_SYSTEM =
  'You extract durable facts a user stated about a specific person, for a contact dossier. ' +
  'Return ONLY a JSON object with keys: interests (string[]), dislikes (string[]), dietary (string[]), ' +
  'pets ([{name,species,notes}]), important_dates ([{date,what,recurring}]), relations ([{name,relation,birthday}]). ' +
  'Include ONLY facts the user EXPLICITLY stated about THIS person in the messages — never infer, never guess, ' +
  'never carry over generic knowledge. Omit a key (or use []) when nothing applies. No prose, JSON only.';

export async function extract_person_facts(
  llm: EnrichLLM,
  name: string,
  snippets: string[],
): Promise<ExtractedFacts | null> {
  if (!snippets.length) return null;
  try {
    const resp = await llm.for_role(tier()).provider.complete({
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: `Person: ${name}\n\nThings the user said (may mention others — only attribute what is clearly about ${name}):\n${snippets.map((s) => `- ${s}`).join('\n')}` },
      ],
      temperature: 0.1,
      max_tokens: 400,
      // The deep tier (Qwen3.6-35B-A3B) is hybrid-thinking: without think:false it
      // emits its reasoning into reasoning_content, exhausts max_tokens, and returns
      // an EMPTY content — so JSON.parse('') throws and we silently extract nothing.
      think: false,
    });
    const parsed = JSON.parse(strip_fence(resp.content || '')) as ExtractedFacts;
    return parsed && typeof parsed === 'object' ? sanitize_facts(parsed) : null;
  } catch {
    return null; // fail-open: no enrichment beats a wrong one
  }
}

const FACT_DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/;
/** upsert_person_note validates the date-shaped fields strictly — a relation's
 *  `birthday` and an `important_dates[].date` must be YYYY-MM-DD or MM-DD — and it
 *  rejects the WHOLE patch on any bad field. The LLM, though, emits `birthday: null`
 *  (or a free-form "next year") for unknown/fuzzy dates. Drop a relation's birthday
 *  unless it's a real date, and drop a dateless important_date, so one unknown
 *  birthday can't sink the entire fact patch (interests, dietary, pets, …). */
export function sanitize_facts(f: ExtractedFacts): ExtractedFacts {
  const out: ExtractedFacts = { ...f };
  if (Array.isArray(out.relations)) {
    out.relations = out.relations
      .filter((r) => r && typeof r.name === 'string' && r.name.trim().length > 0)
      .map((r) => {
        const rel: { name: string; relation: string; birthday?: string } = { name: r.name, relation: r.relation };
        if (typeof r.birthday === 'string' && FACT_DATE_RE.test(r.birthday.trim())) rel.birthday = r.birthday.trim();
        return rel;
      });
  }
  if (Array.isArray(out.important_dates)) {
    out.important_dates = out.important_dates.filter(
      (d) => d && typeof d.date === 'string' && FACT_DATE_RE.test(d.date.trim()) && typeof d.what === 'string' && d.what.trim().length > 0,
    );
  }
  return out;
}

function as_str_arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function as_arr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
}

function union_strings(existing: string[], incoming: string[] | undefined): { merged: string[]; added: string[] } {
  const have = new Set(existing.map((s) => s.toLowerCase().trim()));
  const merged = [...existing];
  const added: string[] = [];
  for (const raw of incoming ?? []) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!v || have.has(v.toLowerCase())) continue;
    have.add(v.toLowerCase());
    merged.push(v);
    added.push(v);
  }
  return { merged, added };
}

function union_objects<T extends Record<string, unknown>>(
  existing: Array<Record<string, unknown>>,
  incoming: T[] | undefined,
  key: (o: Record<string, unknown>) => string,
): { merged: Array<Record<string, unknown>>; added: T[] } {
  const have = new Set(existing.map((o) => key(o).toLowerCase()));
  const merged = [...existing];
  const added: T[] = [];
  for (const o of incoming ?? []) {
    if (!o || typeof o !== 'object') continue;
    const k = key(o as Record<string, unknown>).toLowerCase().trim();
    if (!k || have.has(k)) continue;
    have.add(k);
    merged.push(o as Record<string, unknown>);
    added.push(o);
  }
  return { merged, added };
}

/** Pure merge: union-dedup the extracted facts into the existing frontmatter.
 *  Returns the patch (only fields that gained something) + a list of what was
 *  added (for audit). `interests` maps to the `likes` schema field. */
export function merge_facts(fm: Record<string, unknown>, ex: ExtractedFacts): { patch: Record<string, unknown>; added: string[] } {
  const patch: Record<string, unknown> = {};
  const added: string[] = [];

  const likes = union_strings(as_str_arr(fm.likes), ex.interests);
  if (likes.added.length) { patch.likes = likes.merged; added.push(...likes.added.map((x) => `interest:${x}`)); }
  const dis = union_strings(as_str_arr(fm.dislikes), ex.dislikes);
  if (dis.added.length) { patch.dislikes = dis.merged; added.push(...dis.added.map((x) => `dislike:${x}`)); }
  const diet = union_strings(as_str_arr(fm.dietary), ex.dietary);
  if (diet.added.length) { patch.dietary = diet.merged; added.push(...diet.added.map((x) => `dietary:${x}`)); }

  const pets = union_objects(as_arr(fm.pets), ex.pets, (o) => String(o.name ?? ''));
  if (pets.added.length) { patch.pets = pets.merged; added.push(...pets.added.map((p) => `pet:${p.name}`)); }
  const dates = union_objects(as_arr(fm.important_dates), ex.important_dates, (o) => `${o.date ?? ''}|${o.what ?? ''}`);
  if (dates.added.length) { patch.important_dates = dates.merged; added.push(...dates.added.map((d) => `date:${d.what}`)); }
  const rels = union_objects(as_arr(fm.relations), ex.relations, (o) => String(o.name ?? ''));
  if (rels.added.length) { patch.relations = rels.merged; added.push(...rels.added.map((r) => `relation:${r.name}`)); }

  return { patch, added };
}

// ── Name matching (deterministic, conservative) ─────────────────────────────
function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build name → person matchers for an owner's visible people. Full names always
 *  match; a first name matches ONLY when it's unique among them (no guessing). */
function build_matchers(people: PersonRow[]): Array<{ row: PersonRow; re: RegExp }> {
  const first_counts = new Map<string, number>();
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) first_counts.set(first, (first_counts.get(first) ?? 0) + 1);
  }
  const out: Array<{ row: PersonRow; re: RegExp }> = [];
  for (const p of people) {
    const names = new Set<string>();
    if (p.name.trim()) names.add(p.name.trim());
    if (p.preferred_name && p.preferred_name.trim()) names.add(p.preferred_name.trim());
    const first = p.name.trim().split(/\s+/)[0];
    if (first && (first_counts.get(first.toLowerCase()) ?? 0) === 1) names.add(first);
    for (const n of names) out.push({ row: p, re: new RegExp(`\\b${escape_re(n)}\\b`, 'i') });
  }
  return out;
}

export interface EnrichDeps {
  db: Database;
  memory: MemoryClient;
  llm: EnrichLLM;
  users?: UserRegistry;
  now?: () => Date;
}

interface MsgRow { content: string | null; owner: string | null }

/** The nightly sweep. Returns counts; never throws (fail-open per owner/person). */
export async function run_person_enrichment_sweep(deps: EnrichDeps): Promise<{ people: number; facts: number }> {
  if (!person_enrich_enabled()) return { people: 0, facts: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - window_ms()).toISOString();

  let rows: MsgRow[] = [];
  try {
    rows = deps.db
      .prepare(
        `SELECT m.content_md AS content, c.user_id AS owner
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.role = 'user' AND m.ts > @cutoff`,
      )
      .all({ '@cutoff': cutoff }) as MsgRow[];
  } catch {
    return { people: 0, facts: 0 };
  }

  const by_owner = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.owner || !r.content) continue;
    const a = by_owner.get(r.owner) ?? [];
    a.push(r.content);
    by_owner.set(r.owner, a);
  }

  let people = 0;
  let facts = 0;
  for (const [owner, msgs] of by_owner) {
    try {
      const caller: Caller = { user_id: owner, tier: deps.users?.get(owner)?.tier ?? 'owner' };
      // `self` IS enriched here (the owner's own note is the per-user model's
      // baseline) — so this composes the class predicates rather than using
      // `is_non_contact`. Public figures are excluded: mining "give me the
      // lowdown on Chris Barrett" for biographical facts keeps a councilmember's
      // record current as though he were someone in the household's life.
      const visible = deps.memory.query_people({}).filter((row) => {
        const fm = parse_fm(row.frontmatter_json);
        if (is_genealogy(fm, row.note_path) || is_public_figure(row)) return false;
        return note_visible_to_caller(parse_private_to(fm.private_to), caller);
      });
      if (!visible.length) continue;
      const matchers = build_matchers(visible);
      const per_person = new Map<string, { row: PersonRow; snippets: string[] }>();
      for (const msg of msgs) {
        for (const { row, re } of matchers) {
          if (re.test(msg)) {
            const e = per_person.get(row.id) ?? { row, snippets: [] };
            if (!e.snippets.includes(msg)) e.snippets.push(msg);
            per_person.set(row.id, e);
          }
        }
      }
      for (const { row, snippets } of per_person.values()) {
        try {
          const extracted = await extract_person_facts(deps.llm, row.name, snippets.slice(0, 12));
          if (!extracted) continue;
          const { patch, added } = merge_facts(parse_fm(row.frontmatter_json), extracted);
          if (added.length === 0) continue;
          const ctx: ToolContext = {
            memory: deps.memory,
            llm: deps.llm as unknown as LLMRouter,
            now,
            intent_id: ulid(),
            user: { id: caller.user_id!, tier: caller.tier },
          };
          await upsert_person_note.execute({ identifier: { id: row.id }, patch }, ctx);
          people += 1;
          facts += added.length;
        } catch {
          /* fail-open per person */
        }
      }
    } catch {
      /* fail-open per owner */
    }
  }
  return { people, facts };
}
