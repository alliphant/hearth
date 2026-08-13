/**
 * bench-think-scrutiny — does think-ON actually improve heavy-scrutiny work?
 *
 * The Incident→Immunity design (docs/design-incident-to-immunity.md) proposes
 * think-ON for exactly two surfaces: Beatrice's authoring passes and Kate's
 * review verdicts. The owner's directive: VALIDATE, don't presume. This bench
 * runs the three scrutiny task classes against the LIVE deep tier (the same
 * 35B llama.cpp endpoint production uses) in both conditions, scored
 * DETERMINISTICALLY:
 *
 *   A. review  — small diffs with ONE planted, subtle, repo-realistic bug
 *                (tz wall-clock, cordon leak, swallowed error, off-by-one)
 *                plus a genuinely clean diff. Score = correct verdict AND,
 *                for planted bugs, the finding names the right issue. A
 *                clean-diff denial is a false positive (scored wrong).
 *   B. edit    — produce a surgical {old_string,new_string}: old_string must
 *                match the given snippet byte-exactly and UNIQUELY, and the
 *                applied result must satisfy checkable requirements (the
 *                propose_code_edit contract).
 *   C. diagnose— an evidence pack with a true root cause and a planted decoy;
 *                the verdict must blame the right component.
 *
 * Both conditions use the exact production transport
 * (chat_template_kwargs.enable_thinking — src/core/providers/openai.ts:414).
 * Parse failures are counted as failures AND reported separately (think-ON's
 * known risk is rambling past the JSON contract). Latency + completion tokens
 * reported per condition. Honest by construction: if think-ON does not win,
 * the S4 flip does not ship.
 *
 *   BENCH_BASE_URL=http://your-llm-host.local:8200/v1 bun run scripts/bench-think-scrutiny.ts
 */

const BASE = process.env.BENCH_BASE_URL ?? 'http://your-llm-host.local:8200/v1';
const MODEL = process.env.BENCH_MODEL ?? 'qwen36-35b-a3b';
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 3);
const TEMP = Number(process.env.BENCH_TEMP ?? 0.6);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 2);
const MAX_TOKENS = Number(process.env.BENCH_MAX_TOKENS ?? 4096);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 240_000);
/** Which think conditions to run: "off", "on", or "off,on" (default). Lets a
 *  slow endpoint (the GB10 dense tier) be benched think-OFF-only, and lets a
 *  MODEL comparison reuse the suite (same tasks, different BENCH_BASE_URL). */
const CONDITIONS: boolean[] = (process.env.BENCH_CONDITIONS ?? 'off,on')
  .split(',')
  .map((c) => c.trim().toLowerCase() === 'on');

// ── task fixtures ────────────────────────────────────────────────────────

interface Task {
  id: string;
  category: 'review' | 'edit' | 'diagnose';
  system: string;
  user: string;
  /** Deterministic scorer over the parsed JSON. */
  score: (out: Record<string, unknown>) => { pass: boolean; why: string };
}

const REVIEW_SYSTEM =
  'You are a rigorous senior code reviewer. Review the diff for correctness bugs. ' +
  'Reply with ONE fenced json block only, shape: ' +
  '{"verdict":"approve"|"deny","findings":[{"issue":"<one sentence naming the concrete defect and where>"}]}. ' +
  'Deny ONLY for real defects; approve clean changes. No prose outside the json.';

function review_task(
  id: string,
  diff: string,
  expect_deny: boolean,
  issue_res: RegExp[],
): Task {
  return {
    id,
    category: 'review',
    system: REVIEW_SYSTEM,
    user: `Review this diff:\n\n\`\`\`diff\n${diff}\n\`\`\``,
    score: (out) => {
      const verdict = String(out.verdict ?? '').toLowerCase();
      const findings = Array.isArray(out.findings)
        ? out.findings.map((f) => String((f as Record<string, unknown>)?.issue ?? '')).join(' | ')
        : '';
      if (!expect_deny) {
        return verdict === 'approve'
          ? { pass: true, why: 'clean diff approved' }
          : { pass: false, why: `false positive: denied clean diff (${findings.slice(0, 100)})` };
      }
      if (verdict !== 'deny') return { pass: false, why: 'missed planted bug (approved)' };
      const named = issue_res.some((re) => re.test(findings));
      return named
        ? { pass: true, why: 'caught + named the planted bug' }
        : { pass: false, why: `denied but wrong reason: ${findings.slice(0, 120)}` };
    },
  };
}

// ── edit fixtures ────────────────────────────────────────────────────────

const EDIT_GATE_SNIPPET = `  // Roster-gap report — staffing oversight only ('drive_roster_gaps':
  // Kate). Deterministic mining over Cordelia's triage interrupts +
  // unattributed knowledge demand; renders a prompt section instructing
  // her to convert above-bar clusters into propose_hire packets.
  let roster_gap_section = '';
  if (specialist.granted.has('drive_roster_gaps')) {
    try {
      const window_days = roster_gap_window_days();
      const gap_now = new Date();
      const report = mine_roster_gaps(db, { window_days, now: gap_now });
      roster_gap_section = render_roster_gap_section(report);
    } catch (err) {
      console.error('[deliberation] roster-gap mining failed (fail-open):', err);
    }
  }`;

const EDIT_REGEX_SNIPPET = `const InputSchema = z.object({
  artist: z
    .string()
    .min(1)
    .max(200)
    .describe('Artist or band name. Required.'),
  city: z
    .string()
    .max(120)
    .optional()
    .describe('City of the show, if known. Narrows the match.'),
  show_date: z
    .string()
    .regex(/^\\d{4}-\\d{2}-\\d{2}$/, 'show_date must be ISO YYYY-MM-DD')
    .optional()
    .describe('Exact show date when known. The strongest disambiguator.'),
});`;

const EDIT_LOOP_SNIPPET = `export function render_digest(mail: Row[], proposals: Row[]): string {
  const lines: string[] = [];
  for (let i = 0; i <= MAIL_CAP && i < mail.length; i++) {
    lines.push(render_mail_line(mail[i]!));
  }
  lines.push('---');
  // PROPOSAL_CAP - 1 with <= is deliberate here: the last slot is reserved
  // for the overflow line, so this loop renders PROPOSAL_CAP items total.
  for (let j = 0; j <= PROPOSAL_CAP - 1 && j < proposals.length; j++) {
    lines.push(render_proposal_line(proposals[j]!));
  }
  return lines.join('\\n');
}`;

// ── diagnosis fixtures ───────────────────────────────────────────────────

const DIAG_WORKER_PACK = `Evidence pack — dependency "firecrawl" flagged degraded (error rate 94% over 6h):

AUDIT ERROR SAMPLES (web_fetch_clean, newest first):
- "timeout waiting for scrape job (45s)" ×31
- "timeout waiting for scrape job (45s)" ×28
- "scrape job queued but never picked up" ×9

ENDPOINT PROBE: http://firecrawl:3002/ → HTTP 200 in 41ms (service reachable)

CONTAINER LOGS (firecrawl-api, last 50 lines): normal request logs, jobs enqueued, no errors.
CONTAINER LOGS (firecrawl-worker, last 50 lines):
  > firecrawl-worker@1.0.0 start
  > node dist/worker.js
  Error: Redis connection lost mid-job
  ELIFECYCLE Command failed with exit code 1.
  [container exited (1) 6 hours ago — no restart since]

CONTAINER LOGS (searxng, last 20 lines): 3× "upstream engine 'brave' returned 429" (rate-limit,
self-recovered; searxng serving normally, probe 200 in 12ms).

CONFIG: FIRECRAWL_BASE_URL=http://firecrawl:3002 (resolves), worker concurrency 3.`;

const DIAG_FIELD_PACK = `Evidence pack — tool "append_journal_entry" failing repeatedly for specialist "kate" (11 failures / 24h):

AUDIT ERROR SAMPLES (newest first):
- INPUT_VALIDATION_FAILED: required field "note_path" missing (received keys: ["path","body"])
- INPUT_VALIDATION_FAILED: required field "note_path" missing (received keys: ["path","body","tags"])
- INPUT_VALIDATION_FAILED: required field "note_path" missing (received keys: ["path","body"])

TOOL SCHEMA (input_schema, required): note_path (string), body (string). Optional: tags (string[]).
REGISTRY LINT: field "note_path" has near-synonym risk: models commonly emit "path". No alias configured.

LIVE ENDPOINT PROBE (forced tool channel, 3 shapes): the model emitted a tool call in 3/3 probes;
args carried "path" in 2/3, "note_path" in 1/3. All probes returned within 2.1s (endpoint healthy).

NETWORK: one unrelated "ETIMEDOUT api.pirateweather.net" in the same window (weather connector,
different tool, self-recovered).`;

const TASKS: Task[] = [
  review_task(
    'review_tz_wallclock',
    `--- a/src/core/brief_render.ts
+++ b/src/core/brief_render.ts
@@ -12,6 +12,12 @@ export function render_brief_header(user: TurnUser): string {
   const now = new Date();
-  const day = local_iso_date(now, user.timezone);
-  return \`Brief for \${user.display_name} — \${day}\`;
+  const day = now.toISOString().slice(0, 10);
+  const hour = now.getUTCHours();
+  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
+  return \`\${greeting}, \${user.display_name} — \${day}\`;
 }`,
    true,
    [/utc|timezone|time zone|wall.?clock|local_iso_date|getUTCHours|server time|user'?s? (local )?time/i],
  ),
  review_task(
    'review_cordon_leak',
    `--- a/src/app/routes/notes.ts
+++ b/src/app/routes/notes.ts
@@ -44,6 +44,14 @@ notes.get('/recent', async (c) => {
   const user = c.get('user');
+  // Surface the household's recent notes on the dashboard rail.
+  const rows = db
+    .prepare('SELECT note_path, title, private_to, mtime FROM clippings ORDER BY mtime DESC LIMIT 20')
+    .all() as ClippingRow[];
+  return c.json({ notes: rows.map((r) => ({ path: r.note_path, title: r.title })) });
 });`,
    true,
    [
      /private_to|cordon|visib|note_visible_to_caller|other users?'? (private )?(notes|data)|leak|scop/i,
      /filter(ing|ed)? by (the )?(user|household)|user (or|\/) ?household|without (any )?(user |visibility )?filter|all (notes|rows|clippings) (regardless|instead|for every)|ignores? the (authenticated )?user/i,
    ],
  ),
  review_task(
    'review_swallowed_error',
    `--- a/src/specialists/luna/tools/update_luna_vault.ts
+++ b/src/specialists/luna/tools/update_luna_vault.ts
@@ -88,10 +88,14 @@ export const update_luna_vault: Tool<Input, Output> = {
   async execute(input, ctx): Promise<Output> {
-    const note_path = write_vault_entry(ctx.memory, input);
-    return { saved: true, note_path };
+    try {
+      const note_path = write_vault_entry(ctx.memory, input);
+      return { saved: true, note_path };
+    } catch {
+      return { saved: true, note_path: vault_path_for(input) };
+    }
   }
 };`,
    true,
    [/swallow|catch|saved.?:.?true|claims? success|silent|lie|error is (ignored|hidden|discarded)|failure.{0,40}(success|saved)|(reports?|returns?).{0,30}(success|saved: ?true).{0,40}(fail|error|catch)|even (if|when|though).{0,30}(write )?(fail|throw)/i],
  ),
  review_task(
    'review_off_by_one',
    `--- a/src/core/working_memory.ts
+++ b/src/core/working_memory.ts
@@ -120,9 +120,11 @@ const MAIL_CAP = 5;
-    if (rows.length > 0) {
-      const lines = rows.slice(0, MAIL_CAP).map(mail_line);
+    if (rows.length > 0) {
+      const lines: string[] = [];
+      for (let i = 0; i <= MAIL_CAP && i < rows.length; i++) {
+        lines.push(mail_line(rows[i]!));
+      }
       if (rows.length > MAIL_CAP) lines.push(\`- …and \${rows.length - MAIL_CAP} more\`);`,
    true,
    [/off.?by.?one|<=|6 (items|lines|rows)|one (extra|more|too many)|boundary|cap \+ ?1|MAIL_CAP \+ ?1|exceeds? the cap|i <= MAIL_CAP/i],
  ),
  review_task(
    'review_idempotency_clock',
    `--- a/src/specialists/kate/tools/log_household_event.ts
+++ b/src/specialists/kate/tools/log_household_event.ts
@@ -30,6 +30,22 @@ const OutputSchema = z.object({ note_path: z.string() });
+// Contract reminder (repo-wide): idempotency keys are deterministic from
+// INPUTS ONLY — downstream dedup (scheduled_tasks, outbound queues) depends
+// on an identical call producing an identical key.
+export const log_household_event: Tool<Input, Output> = {
+  name: 'log_household_event',
+  description: 'Append a household event to the shared log.',
+  risk: 'write_internal',
+  required_capabilities: ['write_vault_general'],
+  input_schema: InputSchema,
+  output_schema: OutputSchema,
+  idempotency_key(input) {
+    const h = createHash('sha256');
+    h.update(input.title);
+    h.update('\\n');
+    h.update(String(input.occurred_at ?? Date.now()));
+    return \`log_household_event:\${h.digest('hex').slice(0, 16)}\`;
+  },
+  async execute(input, ctx): Promise<Output> {
+    const note_path = append_household_event(ctx.memory, input);
+    return { note_path };
+  },
+};`,
    true,
    [/Date\.now|non.?determin|deterministic|wall.?clock|timestamp|clock|same (call|input).{0,40}(different|new) key|dedup.{0,50}(break|defeat|bypass)|idempoten.{0,60}(now|time|clock)/i],
  ),
  review_task(
    'review_clean',
    `--- a/src/memory/stores/mail.ts
+++ b/src/memory/stores/mail.ts
@@ -381,6 +381,10 @@ export class MailStore {
   recent_inbound(opts?: {
     account_ids?: string[];
     since?: string;
     limit?: number;
     include_handled?: boolean;
+    /** When set, only messages in this triage bucket. */
+    bucket?: MailBucket;
   }): MailMessage[] {
     const clauses = ["direction = 'inbound'"];
     const params: Record<string, unknown> = {};
+    if (opts?.bucket) {
+      clauses.push('triage_bucket = @bucket');
+      params['@bucket'] = opts.bucket;
+    }
     if (opts?.since) {`,
    false,
    [],
  ),

  // ── B. surgical edits ──────────────────────────────────────────────────
  {
    id: 'edit_add_gate',
    category: 'edit',
    system:
      'You produce surgical search/replace edits. Reply with ONE fenced json block only, shape: ' +
      '{"old_string":"<byte-exact text that appears EXACTLY ONCE in the file>","new_string":"<replacement>"}. ' +
      'old_string must be copied character-for-character from the file, including indentation. No prose.',
    user:
      'File (src/core/deliberation.ts excerpt):\n```ts\n' +
      EDIT_GATE_SNIPPET +
      '\n```\n\nRequirement: gate the roster-gap mining on the env kill switch — the `if` must require ' +
      '`roster_gaps_enabled()` AND the existing capability check. Change nothing else.',
    score: (out) => score_edit(out, EDIT_GATE_SNIPPET, (applied) => {
      if (!/roster_gaps_enabled\(\)\s*&&\s*specialist\.granted\.has\('drive_roster_gaps'\)/.test(applied))
        return 'gate not composed correctly';
      if ((applied.match(/roster_gaps_enabled/g) ?? []).length !== 1) return 'gate duplicated';
      return null;
    }),
  },
  {
    id: 'edit_regex_strip',
    category: 'edit',
    system:
      'You produce surgical search/replace edits. Reply with ONE fenced json block only, shape: ' +
      '{"old_string":"<byte-exact text that appears EXACTLY ONCE in the file>","new_string":"<replacement>"}. ' +
      'old_string must be copied character-for-character from the file, including indentation. No prose.',
    user:
      'File (src/specialists/maggie/tools/mark_show_going.ts excerpt):\n```ts\n' +
      EDIT_REGEX_SNIPPET +
      '\n```\n\nRequirement: remove the `.regex(...)` call from the `show_date` field (a regex pattern in a ' +
      'tool input_schema silently disables the tool grammar). Keep `.optional()` and `.describe(...)` intact. ' +
      'Change nothing else.',
    score: (out) => score_edit(out, EDIT_REGEX_SNIPPET, (applied) => {
      if (/show_date:[\s\S]{0,220}\.regex\(/.test(applied)) return '.regex still present on show_date';
      if (!/show_date:[\s\S]{0,220}\.optional\(\)/.test(applied)) return '.optional() lost';
      if (!applied.includes(".describe('Exact show date")) return '.describe() lost';
      return null;
    }),
  },
  {
    id: 'edit_right_loop',
    category: 'edit',
    system:
      'You produce surgical search/replace edits. Reply with ONE fenced json block only, shape: ' +
      '{"old_string":"<byte-exact text that appears EXACTLY ONCE in the file>","new_string":"<replacement>"}. ' +
      'old_string must be copied character-for-character from the file, including indentation. No prose.',
    user:
      'File (src/core/digest.ts excerpt):\n```ts\n' +
      EDIT_LOOP_SNIPPET +
      '\n```\n\nRequirement: the MAIL loop has an off-by-one (`<=` renders CAP+1 lines) — fix it to `<`. ' +
      'The proposals loop below it is CORRECT and must not change. old_string must be unique in the file.',
    score: (out) => score_edit(out, EDIT_LOOP_SNIPPET, (applied) => {
      if (!/for \(let i = 0; i < MAIL_CAP && i < mail\.length; i\+\+\)/.test(applied))
        return 'mail loop not fixed to <';
      if (!/for \(let j = 0; j <= PROPOSAL_CAP - 1 && j < proposals\.length; j\+\+\)/.test(applied))
        return 'proposals loop was altered';
      return null;
    }),
  },

  // ── C. diagnosis ───────────────────────────────────────────────────────
  {
    id: 'diag_worker_crash',
    category: 'diagnose',
    system:
      'You are diagnosing a production incident from an evidence pack. Reply with ONE fenced json block only, ' +
      'shape: {"root_cause_component":"<the single failing component>","one_line":"<root cause in one sentence>"}. ' +
      'Blame only what the evidence supports. No prose outside the json.',
    user: DIAG_WORKER_PACK,
    score: (out) => {
      const comp = String(out.root_cause_component ?? '').toLowerCase();
      const line = String(out.one_line ?? '').toLowerCase();
      const blames_worker = /worker/.test(comp) || /worker/.test(line);
      const blames_decoy = /searxng|search/.test(comp);
      if (blames_decoy) return { pass: false, why: `blamed the decoy: ${comp}` };
      return blames_worker
        ? { pass: true, why: 'blamed the crashed worker' }
        : { pass: false, why: `blamed: ${comp} — ${line.slice(0, 80)}` };
    },
  },
  {
    id: 'diag_field_mismatch',
    category: 'diagnose',
    system:
      'You are diagnosing why an LLM agent tool call keeps failing, from an evidence pack. Reply with ONE fenced ' +
      'json block only, shape: {"root_cause_component":"<schema|model_args|network|auth>","one_line":"<root cause in one sentence>"}. ' +
      'Blame only what the evidence supports. No prose outside the json.',
    user: DIAG_FIELD_PACK,
    score: (out) => {
      const comp = String(out.root_cause_component ?? '').toLowerCase();
      const line = String(out.one_line ?? '').toLowerCase();
      if (/network/.test(comp)) return { pass: false, why: 'blamed the network decoy' };
      const right =
        /schema|model_args/.test(comp) &&
        /note_path|field|param|argument|rename|mismatch|`?path`?/.test(line);
      return right
        ? { pass: true, why: 'named the path→note_path field mismatch' }
        : { pass: false, why: `${comp} — ${line.slice(0, 80)}` };
    },
  },
];

// ── scoring helpers ──────────────────────────────────────────────────────

function count_occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

function score_edit(
  out: Record<string, unknown>,
  snippet: string,
  check_applied: (applied: string) => string | null,
): { pass: boolean; why: string } {
  const old_s = String(out.old_string ?? '');
  const new_s = String(out.new_string ?? '');
  if (!old_s || !new_s) return { pass: false, why: 'missing old_string/new_string' };
  const n = count_occurrences(snippet, old_s);
  if (n === 0) return { pass: false, why: 'old_string not byte-exact in file' };
  if (n > 1) return { pass: false, why: `old_string not unique (${n} matches)` };
  const applied = snippet.replace(old_s, new_s);
  const err = check_applied(applied);
  return err ? { pass: false, why: err } : { pass: true, why: 'edit applies + satisfies requirement' };
}

// ── LLM transport (mirrors production: chat_template_kwargs.enable_thinking) ─

interface CallResult {
  content: string;
  latency_ms: number;
  completion_tokens: number;
  error?: string;
}

async function call_llm(system: string, user: string, think: boolean): Promise<CallResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: TEMP,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        chat_template_kwargs: { enable_thinking: think },
      }),
    });
    if (!res.ok) return { content: '', latency_ms: Date.now() - t0, completion_tokens: 0, error: `HTTP ${res.status}` };
    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      usage?: { completion_tokens?: number };
    };
    const raw = j.choices?.[0]?.message?.content ?? '';
    return {
      content: raw,
      latency_ms: Date.now() - t0,
      completion_tokens: j.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    return { content: '', latency_ms: Date.now() - t0, completion_tokens: 0, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Escape raw control characters that appear INSIDE string literals — the
 * model emits multi-line old_string/new_string values with literal newlines,
 * which is invalid JSON. (Production authoring rides the grammar-constrained
 * tool-call channel where this can't happen; the bench's fenced-JSON
 * transport must tolerate it or it scores transport noise, not capability.)
 */
function repair_control_chars(s: string): string {
  let out = '';
  let in_string = false;
  let escaped = false;
  for (const ch of s) {
    if (in_string) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        in_string = false;
        out += ch;
        continue;
      }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') in_string = true;
    out += ch;
  }
  return out;
}

/** Strip <think> blocks, then find the first balanced JSON object (with a
 *  control-char repair pass — see repair_control_chars). */
function extract_json(content: string): Record<string, unknown> | null {
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], stripped];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    if (start === -1) continue;
    // Balanced-brace walk must ignore braces inside strings; simplest robust
    // path: repair the whole tail once, then walk.
    const repaired = repair_control_chars(c.slice(start));
    let depth = 0;
    let in_string = false;
    let escaped = false;
    for (let i = 0; i < repaired.length; i++) {
      const ch = repaired[i];
      if (in_string) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') in_string = false;
        continue;
      }
      if (ch === '"') in_string = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(repaired.slice(0, i + 1)) as Record<string, unknown>;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

// ── runner ───────────────────────────────────────────────────────────────

interface SampleRow {
  task: string;
  category: string;
  think: boolean;
  sample: number;
  pass: boolean;
  parse_ok: boolean;
  why: string;
  latency_ms: number;
  completion_tokens: number;
}

async function pooled<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]!();
    }
  });
  await Promise.all(workers);
  return out;
}

async function main(): Promise<void> {
  console.log(`bench-think-scrutiny — ${BASE} model=${MODEL} samples=${SAMPLES} temp=${TEMP}\n`);
  const jobs: Array<() => Promise<SampleRow>> = [];
  for (const think of CONDITIONS) {
    for (const task of TASKS) {
      for (let s = 0; s < SAMPLES; s++) {
        jobs.push(async () => {
          const r = await call_llm(task.system, task.user, think);
          if (r.error) {
            return { task: task.id, category: task.category, think, sample: s, pass: false, parse_ok: false, why: `transport: ${r.error}`, latency_ms: r.latency_ms, completion_tokens: r.completion_tokens };
          }
          const parsed = extract_json(r.content);
          if (!parsed) {
            return { task: task.id, category: task.category, think, sample: s, pass: false, parse_ok: false, why: `unparseable (${r.content.replace(/\s+/g, ' ').slice(0, 80)}…)`, latency_ms: r.latency_ms, completion_tokens: r.completion_tokens };
          }
          const verdict = task.score(parsed);
          return { task: task.id, category: task.category, think, sample: s, pass: verdict.pass, parse_ok: true, why: verdict.why, latency_ms: r.latency_ms, completion_tokens: r.completion_tokens };
        });
      }
    }
  }

  const rows = await pooled(jobs, CONCURRENCY);

  // ── report ─────────────────────────────────────────────────────────────
  const conds: Array<[string, boolean]> = CONDITIONS.map((t) => [t ? 'think-ON' : 'think-OFF', t]);
  console.log('── per-task results ──');
  for (const task of TASKS) {
    const line = conds
      .map(([label, t]) => {
        const rs = rows.filter((r) => r.task === task.id && r.think === t);
        const p = rs.filter((r) => r.pass).length;
        return `${label} ${p}/${rs.length}`;
      })
      .join('   ');
    console.log(`  ${task.id.padEnd(24)} ${line}`);
  }
  console.log('\n── failures detail ──');
  for (const r of rows.filter((x) => !x.pass)) {
    console.log(`  [${r.think ? 'ON ' : 'OFF'}] ${r.task}#${r.sample}: ${r.why}`);
  }
  console.log('\n── summary ──');
  for (const [label, t] of conds) {
    const rs = rows.filter((r) => r.think === t);
    const pass = rs.filter((r) => r.pass).length;
    const parse_fail = rs.filter((r) => !r.parse_ok).length;
    const lat = rs.reduce((a, r) => a + r.latency_ms, 0) / rs.length;
    const tok = rs.reduce((a, r) => a + r.completion_tokens, 0) / rs.length;
    for (const cat of ['review', 'edit', 'diagnose'] as const) {
      const cs = rs.filter((r) => r.category === cat);
      const cp = cs.filter((r) => r.pass).length;
      console.log(`  ${label}  ${cat.padEnd(9)} ${cp}/${cs.length}`);
    }
    console.log(
      `  ${label}  TOTAL     ${pass}/${rs.length}  (parse-fail ${parse_fail}, mean ${Math.round(lat / 1000)}s, mean ${Math.round(tok)} completion-tok)\n`,
    );
  }
  console.log(JSON.stringify({ rows }, null, 0).slice(0, 0)); // keep rows referenced
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
export {};
