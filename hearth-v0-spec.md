# FRIDAY brain v0 (Hearth) — Architecture Specification

**Status**: Pass 2 design, revised. The system being built is **FRIDAY brain**; **Hearth** is the v0 release codename and code namespace, paired with **Helix** for FRIDAY UI. Parallel-on-mint topology relative to FRIDAY UI. Tiered autonomy. Scribe + Concierge ship as v0 agents.

This document is the architectural source of truth for the v0 build. It is intentionally light on full implementations and heavy on interfaces, schemas, and policies — execution work goes to Claude Code from here.

---

## 0. Naming and relationship to FRIDAY

FRIDAY is one product, two layers running as independent services that converge at the dashboard surface:

- **FRIDAY UI** (release: **Helix**) — the existing dashboard / HUD running on the always-on host.
- **FRIDAY brain** (release: **Hearth**) — the agentic chief-of-staff layer specified here.

Each layer has its own codebase, lifecycle, and failure domain. FRIDAY UI runs perfectly without FRIDAY brain. FRIDAY brain has no UI of its own beyond an HTTP API and an approval inbox surface — its renderable state surfaces inside FRIDAY UI when both are present.

**Naming conventions**:
- User-facing terms: "FRIDAY", "FRIDAY brain", "Hearth (release)".
- Services and code namespaces: `hearth-*` (short, stable across product-name evolution).
- Vault frontmatter consent flag is `friday_managed` (what the user writes in their notes), not `hearth_*`.

---

## 1. Topology

FRIDAY brain runs on `mint` as four independent systemd services. Four integration seams with FRIDAY UI, nothing more — HTTP/IPC only, no shared state.

```
mint:/opt/friday/brain/
├── apps/
│   ├── orchestrator/       # planning loop, HTTP API :7700  → hearth-orchestrator.service
│   ├── ingestor/           # vault watcher + embedding     → hearth-ingestor.service
│   ├── scheduler/          # durable timer loop            → hearth-scheduler.service
│   └── approver/           # approval inbox + Telegram/Ntfy → hearth-approver.service
├── packages/
│   ├── core/               # types, Tool, LLMProvider, schemas
│   ├── memory/             # MemoryClient, ingestor pipeline, stores
│   ├── agents/             # Scribe, Concierge (+ stubs)
│   └── policy/             # risk tier evaluator
├── config/
│   ├── llm-roles.yaml      # role → provider → model mapping
│   └── policies/
│       └── v0.yaml         # gateway rules
├── data/
│   ├── hearth.db           # better-sqlite3 file (projection + audit + FTS5)
│   └── vectors.lance/      # LanceDB directory
├── vault/                  # → ~/vault-friday (symlink)
└── ops/
    ├── systemd/            # *.service unit files
    └── watchdog/           # HealthChecks.io ping config
```

### 1.1 FRIDAY UI integration seams

1. `GET /status` — FRIDAY UI dashboard renders a brain status card from this endpoint.
2. **Approval surface** — Telegram bot + Ntfy push + a card embedded in FRIDAY UI's day/night HUD.
3. **`friday-watchdog`** monitors the four `hearth-*` systemd units using existing severity profiles.
4. **FRIDAY Voice 2.0** (deferred) reads daily briefs via the existing Kokoro pipeline — brain emits structured brief JSON; UI's voice layer renders to audio.

### 1.2 Stack

| Concern | Choice |
|---------|--------|
| Runtime | Bun (Node 22 compat fallback) |
| Language | TypeScript (strict mode) |
| HTTP | Hono |
| Validation | Zod |
| Markdown frontmatter | gray-matter |
| File watcher | chokidar |
| Chunking + readers | llamaindex (TS) — used as library, not framework |
| Vector store | LanceDB (embedded, Rust core) |
| Structured store | better-sqlite3 with FTS5 enabled |
| Inference plane | Ollama on the always-on host |
| Process manager | systemd |

### 1.3 Inference

- **Reasoning + planning**: Qwen 3.6 35B A3B Q5_K_M on the always-on host (~24 GB unified), via Ollama
- **Embeddings**: `bge-large-en-v1.5` on the always-on host (~1.3 GB), via Ollama
- **Reranker**: `bge-reranker-v2-m3` on the always-on host (~600 MB), via Ollama

All model access is mediated by the `LLMProvider` interface (§2.4). Switching models, or moving inference to the LLM host/3090 in v1, is a config change — not a code change.

Notes from community on Qwen 3.6 35B A3B in agentic settings:
- Set `chat-template-kwargs '{"preserve_thinking":true}'` to retain `<think>` traces across turns. Matters for multi-step agent loops.
- Temperature ~0.6, no presence penalty, for stable tool-calling.

---

## 2. The orchestrator

### 2.1 Loop

`Plan → Dispatch → Gate → Observe → Reflect`. Single entry point: `POST /intent { text, history }`.

```typescript
// packages/core/src/orchestrator.ts

interface Step {
  agent: AgentName;           // 'scribe' | 'concierge' | ...
  intent: string;
  expects: string;
}

interface Plan {
  intent_id: string;
  steps: Step[];
  rationale: string;
}

interface Observation {
  step: Step;
  tool_call: ToolCall;
  gate_decision: GateDecision;
  result: unknown;
  cost: { tokens_in: number; tokens_out: number; ms: number };
  audit_id: string;
}

interface ReflectDecision {
  outcome: 'continue' | 'replan' | 'done';
  next_step_index?: number;
  message_to_user?: string;
}

class Orchestrator {
  async run(intent: string, history: Message[]): Promise<RunResult> {
    let plan = await this.plan(intent, history);
    const observations: Observation[] = [];
    let replans = 0;
    let i = 0;

    while (i < plan.steps.length) {
      const step = plan.steps[i];
      const agent = this.agents[step.agent];
      const call = await agent.choose_tool(step, observations);
      const gate = await this.gateway.evaluate(call, this.context());

      if (gate.decision === 'deny') {
        observations.push({ step, tool_call: call, gate_decision: gate, result: { denied: true } });
      } else if (gate.decision === 'approve') {
        await this.approvals.queue({ call, gate, step });
        const verdict = await this.approvals.wait(
          call.idempotency_key,
          { timeout_ms: 24 * 3600 * 1000 }
        );
        if (!verdict.approved) {
          observations.push({
            step, tool_call: call, gate_decision: gate,
            result: { skipped: true, reason: verdict.reason }
          });
        } else {
          const result = await this.execute(verdict.modified_call ?? call);
          observations.push({
            step, tool_call: verdict.modified_call ?? call,
            gate_decision: gate, result
          });
        }
      } else {
        const result = await this.execute(call);
        observations.push({ step, tool_call: call, gate_decision: gate, result });
      }

      const reflection = await this.reflect(plan, observations, intent);
      if (reflection.outcome === 'done') break;
      if (reflection.outcome === 'replan') {
        if (++replans > 3) throw new RuntimeError('replan_budget_exhausted');
        plan = await this.plan(intent, [...history, ...this.summarize(observations)]);
        i = 0;
        continue;
      }
      i = reflection.next_step_index ?? i + 1;
    }

    return { plan, observations };
  }
}
```

### 2.2 Tool interface

```typescript
// packages/core/src/tool.ts

export const RiskTier = z.enum(['read', 'write_internal', 'send_external', 'spend_money']);
export type RiskTier = z.infer<typeof RiskTier>;

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  risk: RiskTier;
  input_schema: z.ZodSchema<I>;
  output_schema: z.ZodSchema<O>;
  idempotency_key(input: I): string;
  execute(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolCall<I = unknown> {
  tool_name: string;
  input: I;
  idempotency_key: string;
  rationale: string;
}

export interface ToolContext {
  vault: VaultClient;
  memory: MemoryClient;
  audit: AuditClient;
  llm: LLMRouter;        // resolves role → provider; see §2.4
  now: Date;
}
```

### 2.3 Plan schema

LLM-generated plans must validate. Two attempts; on second failure, fall back to a single-step `clarify` action.

```typescript
const PlanSchema = z.object({
  intent_id: z.string().uuid(),
  rationale: z.string().min(10).max(500),
  steps: z.array(z.object({
    agent: z.enum(['scribe', 'concierge']),     // v0 set; expanded later
    intent: z.string().min(5).max(200),
    expects: z.string().min(5).max(200),
  })).min(1).max(10),
});
```

### 2.4 LLMProvider abstraction

All model interaction is mediated by `LLMProvider`. The orchestrator and agents never instantiate providers directly — they request models by *role* and the `LLMRouter` resolves the right provider+model+params for that role.

```typescript
// packages/core/src/llm.ts

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCallSpec[];
  tool_call_id?: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: ToolDef[];
  response_format?: { type: 'json_schema'; schema: object };
  preserve_thinking?: boolean;       // Qwen 3.6 specific; ignored by other providers
}

export interface LLMResponse {
  content: string;
  tool_calls: ToolCallSpec[];
  thinking?: string;                  // <think> trace if present
  finish_reason: string;
  cost: { tokens_in: number; tokens_out: number; ms: number; model: string };
}

export interface LLMProvider {
  name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  capabilities(): LLMCapabilities;
}

export interface LLMCapabilities {
  supports_json_schema: boolean;
  supports_tool_calls: boolean;
  supports_thinking_mode: boolean;
  max_context: number;
  cost_per_1m_in_cents: number;
  cost_per_1m_out_cents: number;
}

export interface LLMRouter {
  for_role(role: LLMRole): { provider: LLMProvider; defaults: Partial<LLMRequest> };
}

export type LLMRole =
  | 'planner' | 'reflector'
  | 'scribe_writer' | 'concierge_drafter'
  | 'embeddings' | 'reranker';
```

Provider implementations live in `packages/core/src/providers/`:
- `OllamaProvider` — local Qwen 3.6 35B A3B (plus embeddings/reranker via Ollama's APIs)
- `OpenAIProvider` — OpenAI-compatible APIs (cloud fallback, Hermes 4 hosted, future Claude/GPT for one-offs)

Role mapping lives in `config/llm-roles.yaml`:

```yaml
roles:
  planner:
    provider: ollama
    model: qwen3.6:35b-a3b-q5
    temperature: 0.6
    preserve_thinking: true
  reflector:
    provider: ollama
    model: qwen3.6:35b-a3b-q5
    temperature: 0.3
  scribe_writer:
    provider: ollama
    model: qwen3.6:35b-a3b-q5
    temperature: 0.7
  concierge_drafter:
    provider: ollama
    model: qwen3.6:35b-a3b-q5
    temperature: 0.7
  embeddings:
    provider: ollama
    model: bge-large-en-v1.5
  reranker:
    provider: ollama
    model: bge-reranker-v2-m3
```

A model upgrade (Hermes 4 35B A3B side-by-side eval, or future Qwen versions, or pointing the planner at Claude for one experiment) is a config edit and a service restart — no code changes anywhere downstream.

---

## 3. Memory layer

Built from individually mature libraries glued by ~500 lines of TypeScript we own. No third-party RAG framework as a critical dependency.

### 3.1 Pipeline

```
~/vault-friday/  ← Obsidian (you edit)
       │
       ▼
   chokidar watcher (hearth-ingestor)
       │
       ▼
   parse frontmatter (gray-matter) → validate (zod by type)
       │
       ├──→ chunk body (llamaindex MarkdownNodeParser, ~300 tok, 50 overlap)
       │         │
       │         ▼
       │     embed via Ollama (bge-large) → LanceDB upsert
       │
       └──→ project frontmatter → SQLite tables
                                   (people, decisions, journal_entries, ...)
                                   + graph_edges (wikilinks)
                                   + chunks_fts (FTS5 BM25)
       
   ┌─────────────────────────────────────┐
   │   MemoryClient (unified API)        │
   │   retrieve(query, filters)          │
   │   query_people / query_decisions    │
   │   upcoming_dates / contact_history  │
   │   upsert_note / append_to_note      │
   │   log_action                        │
   └─────────────────────────────────────┘
                │
                ▼
       orchestrator + agents
```

### 3.2 Vault namespaces

```
~/vault-friday/
├── People/        — type: person
├── Journal/       — type: journal_entry
├── Decisions/     — type: decision, append-only
├── Calendar/      — type: event (future, Executive agent)
├── Accounts/      — type: account (future, Treasury agent)
├── Projects/      — type: project
├── Drafts/        — type: draft (Concierge drafts before send)
└── System/
    ├── Audit/     — type: audit_log, daily-rotated
    ├── Prompts/   — agent system prompts, version-controlled
    ├── Policies/  — risk tier rules (YAML; mirrored to config/policies/)
    └── Tools/     — generated tool docs (rebuilt from code)
```

### 3.3 Person frontmatter schema (v0 critical)

```yaml
---
type: person
id: p_a4f2c1                    # stable, never changes
name: "Alex Doe"
preferred_name: "Mom"
relationship: family            # family | friend | colleague | acquaintance | service
birthday: "1948-03-22"          # ISO if year known, else MM-DD
anniversaries:
  - { date: "1969-06-14", what: "wedding", with: "Robert Doe" }
contact:
  email: ["mom@example.com"]
  phone: ["+1..."]
  preferred_channel: email      # email | sms | imessage | card | call
  card_address: "..."           # for physical cards
tone: warm                      # warm | formal | playful | dry
contact_cadence: monthly        # weekly | monthly | quarterly | annually | event_only
last_contacted: "2026-04-12"
sensitive: false                # true → always approval, never auto
friday_managed: true            # opt-in: FRIDAY brain may propose proactive contact
do_not_contact: false           # nuclear
gift_history:
  - { date: "2025-12-25", what: "kindle paperwhite", reception: "loved" }
---
```

Zod schema:

```typescript
const PersonFrontmatter = z.object({
  type: z.literal('person'),
  id: z.string().regex(/^p_[a-z0-9]{6}$/),
  name: z.string(),
  preferred_name: z.string().optional(),
  relationship: z.enum(['family', 'friend', 'colleague', 'acquaintance', 'service']),
  birthday: z.string().regex(/^(\d{4}-)?\d{2}-\d{2}$/).optional(),
  anniversaries: z.array(z.object({
    date: z.string(), what: z.string(), with: z.string().optional(),
  })).default([]),
  contact: z.object({
    email: z.array(z.string().email()).default([]),
    phone: z.array(z.string()).default([]),
    preferred_channel: z.enum(['email', 'sms', 'imessage', 'card', 'call']).optional(),
    card_address: z.string().optional(),
  }).default({}),
  tone: z.enum(['warm', 'formal', 'playful', 'dry']).default('warm'),
  contact_cadence: z.enum(['weekly', 'monthly', 'quarterly', 'annually', 'event_only']).optional(),
  last_contacted: z.string().optional(),
  sensitive: z.boolean().default(false),
  friday_managed: z.boolean().default(false),
  do_not_contact: z.boolean().default(false),
  gift_history: z.array(z.object({
    date: z.string(), what: z.string(), reception: z.string().optional(),
  })).default([]),
});
```

Other note schemas (Decision, JournalEntry, Project, AuditLog) follow the same pattern; document at implementation time.

### 3.4 Ingestor

`hearth-ingestor` is a long-running service:

1. **Watch** `~/vault-friday/**/*.md` via chokidar.
2. **Parse** YAML frontmatter on each change with gray-matter.
3. **Validate** against the Zod schema for the note's `type`. Invalid notes log to `System/Audit/` and are skipped — never silently corrupted.
4. **Project** frontmatter into typed SQLite tables (`people`, `decisions`, `journal_entries`, etc.).
5. **Parse wikilinks** `[[X]]` from body → upsert into `graph_edges`.
6. **Chunk** body via llamaindex `MarkdownNodeParser` (paragraph-aware, ~300 tokens with 50-token overlap).
7. **Embed** chunks via the `embeddings` LLM role (Ollama → `bge-large-en-v1.5`) → upsert into LanceDB with metadata `{ note_path, chunk_idx, mtime, frontmatter_snapshot }`.
8. **Index** chunk text into `chunks_fts` SQLite virtual table for BM25.
9. **Audit** the ingestion event into `audit_log`.

The vault is canonical. Both derived stores (LanceDB + SQLite) are fully reproducible from the vault: `bun run ingestor:rebuild` truncates and replays.

### 3.5 MemoryClient API

The unified interface every agent and the orchestrator uses:

```typescript
// packages/memory/src/client.ts

export interface MemoryClient {
  retrieve(params: RetrieveParams): Promise<RetrieveHit[]>;
  query_people(filter: PersonFilter): Promise<Person[]>;
  query_decisions(filter: DecisionFilter): Promise<Decision[]>;
  upcoming_dates(days_ahead: number, types?: DateEventType[]): Promise<DateEvent[]>;
  contact_history(person_id: string, limit?: number): Promise<ContactEvent[]>;
  neighbors(note_path: string, hops?: number): Promise<NoteRef[]>;
  upsert_note(path: string, frontmatter: object, body: string): Promise<void>;
  append_to_note(path: string, body: string): Promise<void>;
  log_action(record: AuditRecord): Promise<string>;
}

export interface RetrieveParams {
  query: string;
  k?: number;                                  // default 8
  filters?: {
    types?: NoteType[];
    relationship?: string;
    friday_managed?: boolean;
    [field: string]: unknown;
  };
  include_neighbors?: boolean;
}

export interface RetrieveHit {
  note_path: string;
  chunk_text: string;
  score: number;
  frontmatter: Record<string, unknown>;
}
```

### 3.6 Retrieval implementation

`retrieve()` runs vector search (LanceDB) and BM25 (SQLite FTS5) in parallel, fuses with reciprocal rank fusion (RRF, k=60), takes top 30, reranks with `bge-reranker-v2-m3` via Ollama, returns top `k`. Frontmatter filters apply as pre-filter when SQLite-resolvable, post-filter otherwise. Reranker call is the only expensive stage — ~80ms typical on the integrated AI accelerator.

---

## 4. Approval gateway

### 4.1 Risk tier policy

| Tier | Default | Notes |
|------|---------|-------|
| `read` | auto | no audit gating |
| `write_internal` | auto | full audit, no human gate |
| `send_external` | **tiered** | rule-based; see policy YAML |
| `spend_money` | always approval | 30s cooldown before send |

### 4.2 Policy engine

```typescript
interface ActionContext {
  tool: { name: string; risk: RiskTier };
  input: unknown;
  recipients: Array<{
    person_id: string;
    novelty: number;             // # of prior successful contacts of same type
    sensitive: boolean;
    relationship: string;
    do_not_contact: boolean;
  }>;
  amount_cents?: number;
  now: Date;
  intent_category?: string;      // 'birthday' | 'reply' | 'cold' | ...
}

interface PolicyResult {
  decision: 'auto' | 'approve' | 'deny';
  rationale: string;
  matched_rules: string[];
}
```

Rules live in `config/policies/v0.yaml`, evaluated top-to-bottom; first match wins. A `default` rule must be present.

```yaml
- name: "Always auto for reads"
  applies_when: { tool_risk: read }
  decision: auto

- name: "Always auto for internal writes"
  applies_when: { tool_risk: write_internal }
  decision: auto

- name: "Money always requires approval"
  applies_when: { tool_risk: spend_money }
  decision: approve
  modifiers: { cooldown_ms: 30000 }

- name: "First contact requires approval"
  applies_when: { tool_risk: send_external, recipient_novelty: "==0" }
  decision: approve

- name: "Sensitive recipients always escalate"
  applies_when: { recipient_flags: [sensitive] }
  decision: approve

- name: "Quiet hours escalate"
  applies_when: { tool_risk: send_external, time_of_day: "22:00-07:00" }
  decision: approve

- name: "Do-not-contact denies"
  applies_when: { recipient_flags: [do_not_contact] }
  decision: deny

- name: "Routine birthday to known family"
  applies_when:
    tool_risk: send_external
    intent_category: birthday
    recipient_relationship: family
    recipient_novelty: ">=3"
  decision: auto

# default fallback — must be last
- name: "Default: outbound requires approval"
  applies_when: { tool_risk: send_external }
  decision: approve
```

### 4.3 Approval inbox

Three surfaces, one API:

```
POST /approvals             # queue
GET  /approvals?status=open # list
POST /approvals/:id/decide  # body: { verdict: 'approve'|'deny', modified_call? }
```

Surfaces: Telegram bot (push + reply), Ntfy (push fallback), FRIDAY UI dashboard card.

24-hour timeout per queued action. Timeout → policy default (deny for outbound; configurable per rule).

### 4.4 Audit log

Every gate decision and every executed action writes two records:

1. SQLite `audit_log` (queryable).
2. Daily markdown in `~/vault-friday/System/Audit/YYYY-MM-DD.md` (greppable, human-readable, scrolls in Obsidian).

```typescript
interface AuditRecord {
  id: string;
  ts: string;
  intent_id: string;
  step: Step;
  tool_call: ToolCall;
  gate_decision: PolicyResult;
  execution_result?: unknown;
  human_verdict?: { who: string; verdict: 'approve' | 'deny'; modified: boolean };
  cost: { tokens_in: number; tokens_out: number; ms: number };
}
```

---

## 5. V0 agents: Scribe + Concierge

### 5.1 Scribe

Vault writer. Only agent allowed to write most namespaces.

```typescript
const ScribeTools = [
  {
    name: 'upsert_person_note',
    risk: 'write_internal',
    description: 'Create or update a person note. Merges patch into frontmatter; appends body if provided.',
    input_schema: z.object({
      identifier: z.union([
        z.object({ id: z.string() }),
        z.object({ name: z.string() }),
      ]),
      patch: z.record(z.unknown()),     // partial PersonFrontmatter
      body_append: z.string().optional(),
    }),
  },
  {
    name: 'append_journal_entry',
    risk: 'write_internal',
    input_schema: z.object({
      date: z.string().optional(),       // default today
      body: z.string(),
      tags: z.array(z.string()).default([]),
    }),
  },
  {
    name: 'record_decision',
    risk: 'write_internal',
    input_schema: DecisionFrontmatter.omit({ id: true, type: true }).extend({
      body: z.string().optional(),
    }),
  },
  {
    name: 'link_notes',
    risk: 'write_internal',
    input_schema: z.object({
      from: z.string(),
      to: z.string(),
      context: z.string().optional(),
    }),
  },
  {
    name: 'find_or_create_person',
    risk: 'write_internal',
    input_schema: z.object({
      name: z.string(),
      hints: z.record(z.string()).optional(),
    }),
  },
];
```

### 5.2 Concierge

Read-mostly for weeks 3–6. Write tools (`draft_*`) come online week 7+. Send tools gated by approval.

```typescript
const ConciergeTools = [
  {
    name: 'surface_relationship_signal',
    risk: 'read',
    description: 'Generate daily brief: upcoming dates, lapsed contacts, suggested actions.',
    input_schema: z.object({
      horizon_days: z.number().default(14),
      include_lapsed: z.boolean().default(true),
    }),
  },
  {
    name: 'upcoming_dates',
    risk: 'read',
    input_schema: z.object({
      days_ahead: z.number().default(30),
      types: z.array(z.enum(['birthday', 'anniversary'])).default(['birthday', 'anniversary']),
    }),
  },
  {
    name: 'contact_history',
    risk: 'read',
    input_schema: z.object({
      person_id: z.string(),
      limit: z.number().default(10),
    }),
  },
  // Week 7+:
  {
    name: 'draft_message',
    risk: 'write_internal',
    input_schema: z.object({
      person_id: z.string(),
      occasion: z.enum(['birthday', 'anniversary', 'check_in', 'congrats', 'condolence', 'other']),
      channel: z.enum(['email', 'sms', 'imessage', 'card']),
      notes: z.string().optional(),
    }),
  },
  {
    name: 'send_message',
    risk: 'send_external',
    input_schema: z.object({
      draft_path: z.string(),
    }),
  },
  {
    name: 'order_card',
    risk: 'spend_money',
    input_schema: z.object({
      draft_path: z.string(),
      provider: z.enum(['lob']).default('lob'),
    }),
  },
];
```

### 5.3 Phased rollout

| Phase | Duration | Capability | Gate posture |
|-------|----------|-----------|--------------|
| 1 | Weeks 1–2 | Scribe only | all auto (write_internal) |
| 2 | Weeks 3–6 | Concierge read-only briefs | all auto (read) |
| 3 | Weeks 7+ | Concierge drafts | drafts auto, sends approval |
| 4 | Month 3+ | Routine birthday/anniv auto-graduates per recipient | policy-driven |

---

## 6. Scheduler

Durable timer loop, SQLite-backed, watchdog-tick driven. Lighter than Temporal; sufficient for v0.

```typescript
interface ScheduledTask {
  id: string;
  fire_at: string;            // ISO
  intent: string;             // re-enters orchestrator as a fresh intent
  context: Record<string, unknown>;
  idempotency_key: string;
  max_attempts: number;       // default 3
  status: 'pending' | 'fired' | 'failed' | 'cancelled';
}
```

Tick interval: 60s. On fire, the scheduler posts to `/intent` with the stored intent text and context payload. Failures retry with exponential backoff. Watchdog ping each cycle so failures surface in HealthChecks.io.

Concierge uses this for: scheduled birthday card orders (fire 7–10 days ahead for delivery), follow-up check-ins, recurring contact cadences.

---

## 7. Pass 3 work items

In order of urgency:

1. **Bootstrap** — repo init (`bun init`, `package.json`, `tsconfig`, workspaces), dependency installation list, and the first ~10 files of code (types, LLMProvider + OllamaProvider, MemoryClient skeleton + SQLite schemas, Scribe with one working tool, minimal Hono HTTP app, systemd units, a smoke-test script). The goal: by the end of this pass, `curl localhost:7700/intent -d '{"text":"note that I had coffee with Alex today"}'` produces a journal entry in the vault and an audit row.
2. **Plan and Reflect system prompts** for Qwen 3.6 35B A3B, stored as version-controlled markdown in `System/Prompts/`. Tested against a synthetic intent corpus before production wiring.
3. **Scribe full agent** — remaining four tools end-to-end with HTTP shim for journaling.
4. **Ingestor full implementation** — chokidar + chunker + embeddings + projection.
5. **Daily Concierge brief generator** design (Week 3+ output).
6. **Telegram bot UX** for approvals.
7. **Backup strategy** — `restic` over `~/vault-friday/` + nightly LanceDB snapshot + SQLite WAL backup.

---

*End of Pass 2 (revised) spec.*
