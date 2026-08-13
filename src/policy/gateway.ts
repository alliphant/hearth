/**
 * Hearth policy gateway.
 *
 * Loads a YAML rule file at boot, watches it for changes, and evaluates
 * each ToolCall against the rules top-to-bottom. The first rule whose
 * `applies_when` clause matches the call's context wins. The last rule
 * MUST be a catch-all (no `applies_when` or empty `applies_when`) — the
 * engine refuses to boot without one.
 *
 * Decisions:
 *   "auto"    → the orchestrator executes immediately
 *   "approve" → the orchestrator queues an Approval, pushes a prompt to
 *               the user via the configured channel, and returns 202
 *   "deny"    → the orchestrator returns 403 and audits the refusal
 *
 * Modifiers (currently only `cooldown_ms`) ride alongside the decision
 * — the orchestrator applies them in the execution path (e.g., wait
 * cooldown_ms after a human approval before running the tool).
 */

import { existsSync, readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { parse as parseYaml } from 'yaml';
import type { ToolCall } from '@core/tool';
import type { AgentName, RiskTier } from '@core/types';

export interface PolicyModifiers {
  cooldown_ms?: number;
}

export type GateDecision =
  | {
      decision: 'auto';
      rationale: string;
      matched_rule: string;
      modifiers?: PolicyModifiers;
    }
  | {
      decision: 'approve';
      rationale: string;
      matched_rule: string;
      modifiers?: PolicyModifiers;
    }
  | {
      decision: 'deny';
      rationale: string;
      matched_rule: string;
    };

export interface RecipientContext {
  id?: string;
  flags?: string[];
  /** 0 = familiar (talked recently), higher = stranger. Convention: 0–10. */
  novelty?: number;
  relationship?: string;
}

export interface PolicyContext {
  agent: AgentName | 'orchestrator';
  intent_id: string;
  risk: RiskTier;
  now: Date;
  recipient?: RecipientContext;
  intent_category?: string;
}

// ── Rule schema (parsed from YAML, validated at load time) ────────────────

interface RawRule {
  name?: string;
  applies_when?: {
    tool_risk?: string;
    recipient_flags?: string[];
    recipient_novelty?: string;
    recipient_relationship?: string;
    time_of_day?: string;
    intent_category?: string;
  };
  decision?: string;
  modifiers?: PolicyModifiers;
}

interface CompiledRule {
  name: string;
  decision: 'auto' | 'approve' | 'deny';
  modifiers?: PolicyModifiers;
  match: (call: ToolCall, ctx: PolicyContext) => boolean;
  is_default: boolean;
}

const VALID_DECISIONS = new Set(['auto', 'approve', 'deny']);

function parse_novelty_predicate(
  spec: string,
): (value: number | undefined) => boolean {
  const m = /^(>=|<=|==)\s*(-?\d+)$/.exec(spec.trim());
  if (!m) {
    throw new Error(
      `invalid recipient_novelty "${spec}" — expected ">=N", "<=N", or "==N"`,
    );
  }
  const op = m[1]!;
  const n = parseInt(m[2]!, 10);
  return (value) => {
    if (value === undefined) return false;
    if (op === '>=') return value >= n;
    if (op === '<=') return value <= n;
    return value === n;
  };
}

function parse_time_window(
  spec: string,
): (now: Date) => boolean {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec.trim());
  if (!m) {
    throw new Error(
      `invalid time_of_day "${spec}" — expected "HH:MM-HH:MM"`,
    );
  }
  const start_min = parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
  const end_min = parseInt(m[3]!, 10) * 60 + parseInt(m[4]!, 10);
  return (now) => {
    const cur = now.getHours() * 60 + now.getMinutes(); // time-guard-ok: host-clock policy window — correct under TZ=America/Denver container; migrate to local_hhmm if it runs UTC
    if (start_min <= end_min) {
      return cur >= start_min && cur < end_min;
    }
    // overnight wrap: e.g. 22:00-07:00 covers 22:00 → 23:59 and 00:00 → 06:59
    return cur >= start_min || cur < end_min;
  };
}

function compile_rule(raw: RawRule, index: number): CompiledRule {
  const name = raw.name ?? `rule_${index}`;
  const decision = raw.decision;
  if (!decision || !VALID_DECISIONS.has(decision)) {
    throw new Error(
      `rule "${name}": decision must be one of auto|approve|deny (got ${decision})`,
    );
  }

  const aw = raw.applies_when;
  const is_default = !aw || Object.keys(aw).length === 0;

  // Compile each predicate eagerly so we surface YAML errors at load time,
  // not first-match time.
  const tool_risk = aw?.tool_risk;
  if (
    tool_risk !== undefined &&
    !['read', 'write_internal', 'send_external', 'spend_money'].includes(tool_risk)
  ) {
    throw new Error(
      `rule "${name}": invalid tool_risk "${tool_risk}"`,
    );
  }
  const required_flags = aw?.recipient_flags;
  const novelty_check = aw?.recipient_novelty
    ? parse_novelty_predicate(aw.recipient_novelty)
    : null;
  const relationship = aw?.recipient_relationship;
  const time_check = aw?.time_of_day
    ? parse_time_window(aw.time_of_day)
    : null;
  const intent_category = aw?.intent_category;

  const match = (call: ToolCall, ctx: PolicyContext): boolean => {
    if (tool_risk !== undefined && ctx.risk !== tool_risk) return false;
    if (required_flags && required_flags.length > 0) {
      const have = new Set(ctx.recipient?.flags ?? []);
      for (const f of required_flags) {
        if (!have.has(f)) return false;
      }
    }
    if (novelty_check && !novelty_check(ctx.recipient?.novelty)) return false;
    if (relationship && ctx.recipient?.relationship !== relationship) return false;
    if (time_check && !time_check(ctx.now)) return false;
    if (intent_category && ctx.intent_category !== intent_category) return false;
    return true;
  };

  return {
    name,
    decision: decision as 'auto' | 'approve' | 'deny',
    modifiers: raw.modifiers,
    match,
    is_default,
  };
}

function compile_rules(raw_rules: RawRule[]): CompiledRule[] {
  if (!Array.isArray(raw_rules) || raw_rules.length === 0) {
    throw new Error('policy file must contain a non-empty `rules:` array');
  }
  const compiled = raw_rules.map((r, i) => compile_rule(r, i));
  const last = compiled[compiled.length - 1]!;
  if (!last.is_default) {
    throw new Error(
      'policy file must end with a catch-all default rule (no `applies_when`)',
    );
  }
  return compiled;
}

// ── Gateway ────────────────────────────────────────────────────────────────

export class Gateway {
  private rules: CompiledRule[] = [];
  private watcher: FSWatcher | null = null;
  private last_load_at: Date | null = null;

  constructor(private path: string) {
    this.reload();
  }

  /** Force a fresh read of the policy file. Throws on invalid YAML. */
  reload(): void {
    if (!existsSync(this.path)) {
      throw new Error(`policy file not found: ${this.path}`);
    }
    const text = readFileSync(this.path, 'utf8');
    const parsed = parseYaml(text) as { rules?: RawRule[] } | null;
    if (!parsed || !parsed.rules) {
      throw new Error(`policy file missing "rules" key: ${this.path}`);
    }
    this.rules = compile_rules(parsed.rules);
    this.last_load_at = new Date();
    console.log(
      `[gateway] loaded ${this.rules.length} rule(s) from ${this.path}` +
        ` (default: "${this.rules[this.rules.length - 1]!.name}")`,
    );
  }

  /** Start watching the policy file for changes. Returns the watcher. */
  watch(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.watcher.on('change', () => {
      try {
        this.reload();
      } catch (err) {
        console.error(
          `[gateway] reload failed (keeping previous rules): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  evaluate(call: ToolCall, ctx: PolicyContext): GateDecision {
    for (const rule of this.rules) {
      if (rule.match(call, ctx)) {
        const rationale = `matched policy rule "${rule.name}"`;
        if (rule.decision === 'deny') {
          return {
            decision: 'deny',
            rationale,
            matched_rule: rule.name,
          };
        }
        return {
          decision: rule.decision,
          rationale,
          matched_rule: rule.name,
          modifiers: rule.modifiers,
        };
      }
    }
    // Should be unreachable — compile_rules enforces a default. Defensive
    // fallback: deny.
    return {
      decision: 'deny',
      rationale: 'no rule matched (unexpected — policy missing default?)',
      matched_rule: '__unreached__',
    };
  }

  // Diagnostics.
  describe(): {
    path: string;
    rule_count: number;
    last_load_at: string | null;
    rule_names: string[];
  } {
    return {
      path: this.path,
      rule_count: this.rules.length,
      last_load_at: this.last_load_at?.toISOString() ?? null,
      rule_names: this.rules.map((r) => r.name),
    };
  }
}
