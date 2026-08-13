/**
 * GET /app/api/profile/:id — everything the profile modal renders.
 *
 * The lean /api/specialists/:id endpoint deliberately strips persona text
 * (it's load-bearing for the LLM, not part of the canonical specialist
 * dossier). The profile view is the human-facing dossier — persona,
 * tenure, recent activity, memory excerpt — so it's its own surface.
 *
 * Tenure comes from the YAML file's stat. birthtime is preferred (when
 * the filesystem records it); mtime is the fallback.
 */
import { Hono } from 'hono';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { SpecialistRegistry } from '@core/specialist';
import type { ProposalsStore } from '@core/proposals';

export interface ProfileRoutesDeps {
  db: Database;
  specialists: SpecialistRegistry;
  specialists_dir: string;
  vault_root: string;
  proposals: ProposalsStore;
}

function capitalize_id(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function read_tenure(
  specialists_dir: string,
  db: Database,
  id: string,
): { joined_at: string | null; age_days: number | null } {
  // Two sources, take the earlier:
  //  - The YAML file's birthtime / mtime (good for fresh hires, but
  //    unreliable after an rsync/restore where the file was re-created
  //    yesterday despite the specialist being on-staff for months).
  //  - The oldest audit_log row where the specialist was the agent
  //    (rock-solid: it's the first time the specialist DID something).
  let candidate: Date | null = null;
  const path = resolve(specialists_dir, `${id}.yaml`);
  if (existsSync(path)) {
    try {
      const st = statSync(path);
      const birth = st.birthtime;
      candidate = birth && birth.getTime() > 0 ? birth : st.mtime;
    } catch {
      /* ignore */
    }
  }
  try {
    const row = db
      .prepare(`SELECT MIN(ts) AS oldest FROM audit_log WHERE agent = @id`)
      .get({ '@id': id }) as { oldest: string | null };
    if (row.oldest) {
      const audit_dt = new Date(row.oldest);
      if (!candidate || audit_dt < candidate) candidate = audit_dt;
    }
  } catch {
    /* ignore */
  }
  if (!candidate) return { joined_at: null, age_days: null };
  return {
    joined_at: candidate.toISOString(),
    age_days: Math.floor((Date.now() - candidate.getTime()) / 86_400_000),
  };
}

function read_memory_excerpt(vault_root: string, id: string): string | null {
  const path = resolve(vault_root, 'Knowledge', capitalize_id(id), 'memory.md');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    // Skip the "<!-- entries below -->" boilerplate and the title. Keep
    // up to ~1200 chars so the modal stays comfortably scannable.
    const body = raw
      .replace(/^---[\s\S]*?---\s*/m, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (!body) return null;
    return body.length > 1200 ? body.slice(0, 1200) + '\n…' : body;
  } catch {
    return null;
  }
}

interface AuditRow {
  ts: string;
  tool_name: string;
  agent: string;
  tool_input: string;
  execution_result: string | null;
  gate_decision: string | null;
  error: string | null;
}

function recent_audit(db: Database, id: string, limit: number): Array<{
  ts: string; tool_name: string; result_summary: string; error: string | null;
}> {
  // Anything the specialist themselves did — agent=:id.
  const rows = db
    .prepare(
      `SELECT ts, tool_name, agent, tool_input, execution_result, gate_decision, error
       FROM audit_log
       WHERE agent = @id
       ORDER BY ts DESC
       LIMIT @lim`,
    )
    .all({ '@id': id, '@lim': limit }) as AuditRow[];
  return rows.map((r) => {
    let result_summary = '';
    if (r.error) {
      result_summary = `error: ${r.error.slice(0, 120)}`;
    } else if (r.execution_result) {
      try {
        const parsed = JSON.parse(r.execution_result) as Record<string, unknown>;
        const keys = Object.keys(parsed).slice(0, 3);
        result_summary = keys
          .map((k) => `${k}=${JSON.stringify(parsed[k]).slice(0, 50)}`)
          .join(' ');
      } catch {
        result_summary = r.execution_result.slice(0, 120);
      }
    }
    return { ts: r.ts, tool_name: r.tool_name, result_summary, error: r.error };
  });
}

function recent_proposals(db: Database, id: string, limit: number): Array<{
  id: string; ts_created: string; kind: string; status: string; rationale: string;
}> {
  const rows = db
    .prepare(
      `SELECT id, ts_created, kind, status, rationale_md
       FROM proposals
       WHERE specialist_id = @id
       ORDER BY ts_created DESC
       LIMIT @lim`,
    )
    .all({ '@id': id, '@lim': limit }) as Array<{
      id: string; ts_created: string; kind: string; status: string; rationale_md: string;
    }>;
  return rows.map((r) => ({
    id: r.id,
    ts_created: r.ts_created,
    kind: r.kind,
    status: r.status,
    rationale: (r.rationale_md ?? '').replace(/\s+/g, ' ').slice(0, 200),
  }));
}

function totals(db: Database, id: string): {
  total_proposals: number;
  total_audit_actions: number;
} {
  const tp = db
    .prepare(`SELECT COUNT(*) AS n FROM proposals WHERE specialist_id = @id`)
    .get({ '@id': id }) as { n: number };
  const ta = db
    .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE agent = @id`)
    .get({ '@id': id }) as { n: number };
  return { total_proposals: tp.n, total_audit_actions: ta.n };
}

export function create_profile_router(deps: ProfileRoutesDeps): Hono {
  const r = new Hono();

  r.get('/:id', (c) => {
    const id = c.req.param('id');
    const spec = deps.specialists.get(id);
    if (!spec) return c.json({ error: `unknown specialist: ${id}` }, 404);

    const tenure = read_tenure(deps.specialists_dir, deps.db, id);

    // Per-user cordon: the diagnostic fields — the specialist's memory
    // excerpt (the owner's accumulated context), recent proposals, and
    // recent audit activity — span every user's interactions. Expose them
    // only to the owner; a household/friend user sees the public identity
    // (persona, role, avatar, capabilities) but not the activity feed.
    const u = c.get('user');
    const is_owner = !u || u.tier === 'owner';

    return c.json({
      id: spec.id,
      name: spec.name,
      role: spec.role,
      voice: spec.voice,
      persona: spec.persona,
      avatar_url: `/app/api/avatars/${id}`,
      banner_url: `/app/api/banners/${id}`,
      capabilities: Array.from(spec.granted).sort(),
      knowledge_scope: spec.knowledge_scope,
      proactive: spec.proactive,
      joined_at: tenure.joined_at,
      age_days: tenure.age_days,
      memory_excerpt: is_owner ? read_memory_excerpt(deps.vault_root, id) : null,
      recent_proposals: is_owner ? recent_proposals(deps.db, id, 6) : [],
      recent_activity: is_owner ? recent_audit(deps.db, id, 8) : [],
      totals: is_owner ? totals(deps.db, id) : null,
    });
  });

  return r;
}
