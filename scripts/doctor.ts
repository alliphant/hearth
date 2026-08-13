/**
 * scripts/doctor.ts — post-install health diagnostic
 *
 * Single command that walks the install and reports what's healthy,
 * what's degraded, what's broken. Designed to be the first thing you
 * run when something doesn't feel right.
 *
 * Seven sections:
 *   1. Core services        — systemd states + port reachability
 *   2. Storage              — vault, library, db, disk
 *   3. Config               — every YAML parses + validates
 *   4. Personas             — all 12 load with substitution applied
 *   5. LLM endpoint         — reachable, what model
 *   6. Connectors           — probe each configured one
 *   7. Recent activity      — last audit row, today's brief, gaps
 *
 * Output is colored, scannable, with a summary + recommendations at
 * the bottom. Exit 0 if no failures; 1 otherwise.
 *
 * Usage:
 *   bun run doctor                       # default
 *   bun run doctor --quiet               # only print warns + fails
 *   bun run doctor --no-connectors       # skip connector probes (slow)
 *   bun run doctor --vault <path>        # override vault dir
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { parse as parseYaml } from 'yaml';

// ── Types ─────────────────────────────────────────────────────────────────

type Status = 'pass' | 'warn' | 'fail' | 'skip';

interface Check {
  status: Status;
  label: string;
  detail?: string;
  rec?: string;
}

interface Section {
  title: string;
  checks: Check[];
}

interface Args {
  quiet: boolean;
  no_connectors: boolean;
  vault: string;
  hearth_dir: string;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parse_args(argv: string[]): Args {
  const args: Args = {
    quiet: false,
    no_connectors: false,
    vault: process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`,
    hearth_dir: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet' || a === '-q') args.quiet = true;
    else if (a === '--no-connectors') args.no_connectors = true;
    else if (a === '--vault') args.vault = resolve(argv[++i] ?? '');
    else if (a === '--dir') args.hearth_dir = resolve(argv[++i] ?? '');
    else if (a === '--help' || a === '-h') {
      console.log(`hearth doctor — post-install health check

Usage:
  bun run doctor [flags]

Flags:
  --quiet, -q           only print warns + fails
  --no-connectors       skip connector probes (faster)
  --vault <path>        override vault dir
  --dir <path>          override hearth source dir (default: cwd)
  --help, -h            this`);
      process.exit(0);
    }
  }
  return args;
}

// ── Output ────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const GLYPH: Record<Status, string> = {
  pass: `${C.green}✓${C.reset}`,
  warn: `${C.yellow}⚠${C.reset}`,
  fail: `${C.red}✗${C.reset}`,
  skip: `${C.dim}-${C.reset}`,
};

function print_section(s: Section, quiet: boolean): void {
  // Skip the section header in quiet mode if nothing to show
  const visible = quiet ? s.checks.filter((c) => c.status !== 'pass' && c.status !== 'skip') : s.checks;
  if (visible.length === 0) return;
  console.log('');
  console.log(`  ${C.bold}${C.blue}── ${s.title} ${'─'.repeat(Math.max(2, 56 - s.title.length))}${C.reset}`);
  for (const c of visible) {
    const padded = c.label.padEnd(20);
    const detail = c.detail ? `${C.dim}${c.detail}${C.reset}` : '';
    console.log(`  ${GLYPH[c.status]} ${padded}  ${detail}`);
  }
}

function print_summary(sections: Section[], started_at: number): void {
  const all = sections.flatMap((s) => s.checks);
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of all) counts[c.status]++;
  const total = all.length;
  const elapsed = ((Date.now() - started_at) / 1000).toFixed(1);

  console.log('');
  console.log(`  ${C.bold}${C.blue}${'─'.repeat(60)}${C.reset}`);
  console.log(
    `  ${C.bold}${total} checks${C.reset} in ${elapsed}s · ` +
      `${C.green}${counts.pass} pass${C.reset} · ` +
      `${C.yellow}${counts.warn} warn${C.reset} · ` +
      `${C.red}${counts.fail} fail${C.reset} · ` +
      `${C.dim}${counts.skip} skip${C.reset}`,
  );

  const fixes = all.filter((c) => c.rec && (c.status === 'warn' || c.status === 'fail'));
  if (fixes.length > 0) {
    console.log('');
    console.log(`  ${C.bold}Things to look at${C.reset}`);
    for (const c of fixes) {
      const tag = c.status === 'fail' ? `${C.red}[fail]${C.reset}` : `${C.yellow}[warn]${C.reset}`;
      console.log(`    ${tag} ${c.label} — ${c.detail ?? ''}`);
      console.log(`       ${C.dim}try: ${c.rec}${C.reset}`);
    }
  }
  console.log('');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

async function http_ok(url: string, timeout_ms = 3000, headers: Record<string, string> = {}): Promise<{ ok: boolean; status: number; ms: number }> {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout_ms);
    const r = await fetch(url, { signal: ctrl.signal, headers });
    clearTimeout(t);
    return { ok: r.ok, status: r.status, ms: Date.now() - start };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - start };
  }
}

function read_env(hearth_dir: string): Record<string, string> {
  const env_path = resolve(hearth_dir, '.env');
  const out: Record<string, string> = {};
  if (!existsSync(env_path)) return out;
  for (const line of readFileSync(env_path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function bytes_to_human(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ago(ms_ago: number): string {
  const s = Math.floor(ms_ago / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Section 1: Core services ─────────────────────────────────────────────

async function check_core(args: Args): Promise<Section> {
  const checks: Check[] = [];
  const services = ['hearth-orchestrator', 'hearth-ingestor', 'hearth-scheduler'];

  for (const svc of services) {
    const state = sh(`systemctl --user is-active ${svc} 2>/dev/null`) || 'inactive';
    if (state === 'active') {
      const since = sh(`systemctl --user show ${svc} -p ActiveEnterTimestamp --value 2>/dev/null`);
      const uptime = since ? `up since ${since.split(' ').slice(1, 3).join(' ')}` : '';
      checks.push({ status: 'pass', label: svc.replace('hearth-', ''), detail: `${state} · ${uptime}` });
    } else {
      checks.push({
        status: 'fail',
        label: svc.replace('hearth-', ''),
        detail: state,
        rec: `systemctl --user start ${svc}`,
      });
    }
  }

  // Orchestrator HTTP healthcheck
  const port = process.env.HEARTH_PORT ?? '7700';
  const r = await http_ok(`http://localhost:${port}/status`);
  if (r.ok) {
    checks.push({ status: 'pass', label: `:${port} /status`, detail: `${r.ms}ms` });
  } else if (r.status > 0) {
    checks.push({ status: 'warn', label: `:${port} /status`, detail: `HTTP ${r.status}` });
  } else {
    checks.push({
      status: 'fail',
      label: `:${port} /status`,
      detail: 'unreachable',
      rec: 'systemctl --user start hearth-orchestrator (then re-run doctor)',
    });
  }

  // user-lingering check
  const linger = sh(`loginctl show-user ${process.env.USER} -p Linger --value 2>/dev/null`);
  if (linger === 'yes') {
    checks.push({ status: 'pass', label: 'user-lingering', detail: 'enabled — services survive logout' });
  } else {
    checks.push({
      status: 'warn',
      label: 'user-lingering',
      detail: 'not enabled — services will stop at logout',
      rec: `sudo loginctl enable-linger ${process.env.USER}`,
    });
  }

  return { title: 'Core services', checks };
}

// ── Section 2: Storage ────────────────────────────────────────────────────

function check_storage(args: Args): Section {
  const checks: Check[] = [];

  // Vault
  if (existsSync(args.vault)) {
    let md_count = 0;
    let total_bytes = 0;
    let last_mtime = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = `${dir}/${name}`;
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory() && !name.startsWith('.')) walk(p);
        else if (st.isFile() && name.endsWith('.md')) {
          md_count++;
          total_bytes += st.size;
          if (st.mtimeMs > last_mtime) last_mtime = st.mtimeMs;
        }
      }
    };
    try { walk(args.vault); } catch { /* permissions */ }
    const last_edit = last_mtime > 0 ? ago(Date.now() - last_mtime) : 'never';
    checks.push({
      status: 'pass',
      label: 'vault',
      detail: `${args.vault} · ${md_count} notes · ${bytes_to_human(total_bytes)} · last edit ${last_edit}`,
    });
  } else {
    checks.push({
      status: 'fail',
      label: 'vault',
      detail: `MISSING: ${args.vault}`,
      rec: 'bun run init:vault (or set HEARTH_VAULT_ROOT)',
    });
  }

  // Library
  const library_dir = process.env.HEARTH_LIBRARY_ROOT ?? `${process.env.HOME}/hearth-library`;
  if (existsSync(library_dir)) {
    const file_count = sh(`find "${library_dir}" -type f -not -path '*/.*' 2>/dev/null | wc -l`);
    const size = sh(`du -sh "${library_dir}" 2>/dev/null | cut -f1`);
    checks.push({
      status: 'pass',
      label: 'library',
      detail: `${library_dir} · ${file_count} files · ${size}`,
    });
  } else {
    checks.push({ status: 'skip', label: 'library', detail: `not present at ${library_dir}` });
  }

  // Database
  const db_path = process.env.HEARTH_DB_PATH ?? resolve(args.hearth_dir, 'data/hearth.db');
  if (existsSync(db_path)) {
    try {
      const db = new Database(db_path, { readonly: true });
      const audit_row = db.prepare('SELECT count(*) as n FROM audit_log').get() as { n: number };
      const conv_row = db.prepare('SELECT count(*) as n FROM conversations').get() as { n: number };
      const size = statSync(db_path).size;
      checks.push({
        status: 'pass',
        label: 'database',
        detail: `${db_path} · ${bytes_to_human(size)} · ${audit_row.n.toLocaleString()} audit rows · ${conv_row.n} conversations`,
      });
      db.close();
    } catch (e) {
      checks.push({ status: 'warn', label: 'database', detail: `${db_path} — read error: ${(e as Error).message}` });
    }
  } else {
    checks.push({ status: 'warn', label: 'database', detail: `not present at ${db_path} (created on first boot)` });
  }

  // Disk space
  const df = sh(`df -BG --output=avail "${process.env.HOME}" 2>/dev/null | tail -1 | tr -d ' G'`);
  const free_gb = parseInt(df, 10);
  if (free_gb >= 10) {
    checks.push({ status: 'pass', label: 'disk space', detail: `${free_gb} GB free in $HOME` });
  } else if (free_gb >= 2) {
    checks.push({ status: 'warn', label: 'disk space', detail: `only ${free_gb} GB free` });
  } else if (!isNaN(free_gb)) {
    checks.push({ status: 'fail', label: 'disk space', detail: `${free_gb} GB free — tight`, rec: 'free up space' });
  }

  return { title: 'Storage', checks };
}

// ── Section 3: Config ─────────────────────────────────────────────────────

function check_config(args: Args): Section {
  const checks: Check[] = [];
  const cfg_dir = resolve(args.hearth_dir, 'config');

  const yaml_files = [
    { name: 'users.yaml', path: 'users.yaml' },
    { name: 'policies', path: 'policies/v0.yaml' },
    { name: 'llm-roles', path: 'llm-roles.yaml' },
    { name: 'privacy', path: 'privacy.yaml' },
    { name: 'autonomy', path: 'autonomy.yaml' },
    { name: 'notifications', path: 'notifications.yaml' },
    { name: 'capabilities', path: 'capabilities.yaml' },
  ];

  for (const f of yaml_files) {
    const p = resolve(cfg_dir, f.path);
    if (!existsSync(p)) {
      // Some are optional in fresh installs
      if (f.name === 'users.yaml') {
        checks.push({ status: 'fail', label: f.name, detail: 'missing', rec: 'bash ops/install.sh --reconfigure' });
      } else {
        checks.push({ status: 'skip', label: f.name, detail: 'not present' });
      }
      continue;
    }
    try {
      const parsed = parseYaml(readFileSync(p, 'utf8'));
      let detail = `${p.replace(args.hearth_dir, '.')}`;
      if (f.name === 'users.yaml' && parsed?.users?.length > 0) {
        const admin = parsed.users.find((u: { role?: string }) => u.role === 'admin') ?? parsed.users[0];
        const has_household = !!parsed.household;
        detail += ` · ${parsed.users.length} user(s) (admin: ${admin?.id})` + (has_household ? ` · household bound` : '');
      } else if (f.name === 'policies' && parsed?.rules) {
        detail += ` · ${parsed.rules.length} rules`;
      } else if (f.name === 'llm-roles' && parsed?.roles) {
        detail += ` · ${Object.keys(parsed.roles).length} roles`;
      }
      checks.push({ status: 'pass', label: f.name, detail });
    } catch (e) {
      checks.push({
        status: 'fail',
        label: f.name,
        detail: `parse error: ${(e as Error).message.slice(0, 60)}`,
        rec: `yamllint ${p}`,
      });
    }
  }

  // specialists dir count
  const spec_dir = resolve(cfg_dir, 'specialists');
  if (existsSync(spec_dir)) {
    const files = readdirSync(spec_dir).filter((n) => n.endsWith('.yaml'));
    checks.push({ status: 'pass', label: 'specialists/', detail: `${files.length} persona file(s)` });
  } else {
    checks.push({ status: 'fail', label: 'specialists/', detail: 'missing dir', rec: 'check $HEARTH_DIR/config/specialists/' });
  }

  return { title: 'Config', checks };
}

// ── Section 4: Personas (substitution check) ─────────────────────────────

async function check_personas(args: Args): Promise<Section> {
  const checks: Check[] = [];
  const spec_dir = resolve(args.hearth_dir, 'config/specialists');
  if (!existsSync(spec_dir)) {
    return { title: 'Personas', checks: [{ status: 'skip', label: 'persona scan', detail: 'no config/specialists/' }] };
  }

  // We need the same load path the orchestrator uses. The cleanest path
  // is to dynamically import @core/specialist + @core/household + the
  // capability loader, the way verify-household.ts does. If those fail
  // (path aliases broken), fall back to surface-level YAML parsing.
  try {
    const { UserRegistry } = await import('@core/users');
    const { set_household_context } = await import('@core/household');
    const { load_specialist_file } = await import('@core/specialist');
    const { load_extra_capabilities } = await import('@core/capabilities');

    const cap_path = resolve(args.hearth_dir, 'config/capabilities.yaml');
    if (existsSync(cap_path)) load_extra_capabilities(cap_path);

    const users = new UserRegistry();
    set_household_context(users.household_context());

    const files = readdirSync(spec_dir).filter((n) => n.endsWith('.yaml'));
    let leaks_total = 0;
    let leaky_files: string[] = [];
    for (const f of files) {
      try {
        const s = load_specialist_file(resolve(spec_dir, f));
        const leftover = s.persona.match(/\{\{[a-z_]+(?::[^}]*)?\}\}/g);
        if (leftover) {
          leaks_total += leftover.length;
          leaky_files.push(`${f}(${[...new Set(leftover)].join(',')})`);
        }
      } catch (e) {
        checks.push({
          status: 'fail',
          label: `persona: ${f.replace('.yaml', '')}`,
          detail: `won't load: ${(e as Error).message.slice(0, 80)}`,
        });
      }
    }
    if (leaks_total === 0) {
      checks.push({
        status: 'pass',
        label: 'substitution',
        detail: `${files.length} personas loaded · 0 unsubstituted tokens`,
      });
    } else {
      checks.push({
        status: 'warn',
        label: 'substitution',
        detail: `${leaks_total} unsubstituted token(s) in ${leaky_files.slice(0, 3).join(', ')}`,
        rec: 'add the missing field to household: in config/users.yaml',
      });
    }
  } catch (e) {
    checks.push({
      status: 'warn',
      label: 'persona scan',
      detail: `import failed (run from $HEARTH_DIR?): ${(e as Error).message.slice(0, 60)}`,
    });
  }

  return { title: 'Personas', checks };
}

// ── Section 5: LLM endpoint ──────────────────────────────────────────────

async function check_llm(args: Args): Promise<Section> {
  const env = read_env(args.hearth_dir);
  const checks: Check[] = [];

  // Prefer values from the live orchestrator's /status, which knows
  // exactly what URLs it's using regardless of whether they came from
  // .env, a systemd Environment= line, or a drop-in. Fall back to the
  // env file + process env if the orchestrator isn't up.
  const port = process.env.HEARTH_PORT ?? env.HEARTH_PORT ?? '7700';
  let runtime_ollama: string | undefined;
  let runtime_openai: string | undefined;
  try {
    const r = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const body = (await r.json()) as { ollama_url?: string; openai_base_url?: string | null };
      runtime_ollama = body.ollama_url;
      runtime_openai = body.openai_base_url ?? undefined;
    }
  } catch { /* orchestrator down — fall back below */ }

  const ollama_url = runtime_ollama ?? env.OLLAMA_BASE_URL ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const ollama_explicit = !!(runtime_ollama || env.OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL);
  const openai_url = runtime_openai ?? env.OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL;

  // If OPENAI_BASE_URL is explicitly set, probe that path. Otherwise
  // probe the Ollama default (the orchestrator does the same).
  if (openai_url) {
    const r = await http_ok(`${openai_url}/models`, 4000);
    if (r.ok) {
      checks.push({ status: 'pass', label: 'openai-compatible', detail: `${openai_url} reachable` });
    } else if (r.status === 401) {
      checks.push({ status: 'fail', label: 'openai-compatible', detail: `${openai_url} 401`, rec: 'check OPENAI_API_KEY in .env' });
    } else {
      checks.push({
        status: 'fail',
        label: 'openai-compatible',
        detail: `${openai_url} ${r.status > 0 ? `HTTP ${r.status}` : 'unreachable'}`,
        rec: `curl -v ${openai_url}/models — confirm the endpoint`,
      });
    }
  } else {
    const r = await http_ok(`${ollama_url}/api/version`, 4000);
    const tag = ollama_explicit ? '' : ' (default)';
    if (r.ok) {
      const tags = await http_ok(`${ollama_url}/api/tags`, 4000);
      let model_info = '';
      if (tags.ok) {
        try {
          const body = (await (await fetch(`${ollama_url}/api/tags`)).json()) as { models: Array<{ name: string }> };
          model_info = body.models?.length
            ? ` · ${body.models.length} model(s): ${body.models.map((m) => m.name).slice(0, 3).join(', ')}`
            : '';
        } catch { /* ignore */ }
      }
      checks.push({ status: 'pass', label: `ollama${tag}`, detail: `${ollama_url} reachable${model_info}` });
    } else {
      checks.push({
        status: 'fail',
        label: `ollama${tag}`,
        detail: `${ollama_url} unreachable`,
        rec: ollama_explicit
          ? 'is ollama running? `ollama serve` or check the service'
          : 'no LLM endpoint configured. Either start Ollama, or set OPENAI_BASE_URL in .env',
      });
    }
  }

  return { title: 'LLM', checks };
}

// ── Section 6: Connectors ────────────────────────────────────────────────

async function check_connectors(args: Args): Promise<Section> {
  if (args.no_connectors) return { title: 'Connectors', checks: [{ status: 'skip', label: 'connector probes', detail: 'skipped (--no-connectors)' }] };
  const env = read_env(args.hearth_dir);
  const checks: Check[] = [];

  interface Probe {
    name: string;
    url_var: string;
    health_path?: string;
    auth_var?: string;
    auth_kind?: 'bearer' | 'header' | 'apikey-query' | 'token-header';
    header_name?: string;
  }
  const probes: Probe[] = [
    { name: 'home_assistant', url_var: 'HA_BASE_URL', health_path: '/api/', auth_var: 'HA_TOKEN', auth_kind: 'bearer' },
    { name: 'firecrawl',      url_var: 'FIRECRAWL_BASE_URL', health_path: '/health' },
    { name: 'searxng',        url_var: 'SEARXNG_BASE_URL' },
    { name: 'nominatim',      url_var: 'NOMINATIM_BASE_URL', health_path: '/status' },
    { name: 'osrm-drive',     url_var: 'OSRM_DRIVE_URL' },
    { name: 'tautulli',       url_var: 'TAUTULLI_URL', health_path: '/api/v2?cmd=status', auth_var: 'TAUTULLI_API_KEY', auth_kind: 'apikey-query' },
    { name: 'sonarr',         url_var: 'SONARR_URL', health_path: '/api/v3/system/status', auth_var: 'SONARR_API_KEY', auth_kind: 'token-header', header_name: 'X-Api-Key' },
    { name: 'radarr',         url_var: 'RADARR_URL', health_path: '/api/v3/system/status', auth_var: 'RADARR_API_KEY', auth_kind: 'token-header', header_name: 'X-Api-Key' },
    { name: 'lidarr',         url_var: 'LIDARR_URL', health_path: '/api/v1/system/status', auth_var: 'LIDARR_API_KEY', auth_kind: 'token-header', header_name: 'X-Api-Key' },
    { name: 'readarr',        url_var: 'READARR_URL', health_path: '/api/v1/system/status', auth_var: 'READARR_API_KEY', auth_kind: 'token-header', header_name: 'X-Api-Key' },
    { name: 'mealie',         url_var: 'MEALIE_URL', health_path: '/api/app/about' },
    { name: 'metube',         url_var: 'METUBE_URL' },
    { name: 'workstation',    url_var: 'STEAMBOAT_URL', health_path: '/health' },
  ];

  for (const p of probes) {
    const url = env[p.url_var];
    if (!url) {
      checks.push({ status: 'skip', label: p.name, detail: `${p.url_var} not set` });
      continue;
    }
    let probe_url = url + (p.health_path ?? '/');
    const headers: Record<string, string> = {};
    if (p.auth_var) {
      const tok = env[p.auth_var];
      if (!tok) {
        checks.push({
          status: 'warn',
          label: p.name,
          detail: `${p.url_var} set but ${p.auth_var} missing`,
          rec: `set ${p.auth_var} in .env`,
        });
        continue;
      }
      if (p.auth_kind === 'bearer') headers['Authorization'] = `Bearer ${tok}`;
      else if (p.auth_kind === 'token-header') headers[p.header_name ?? 'X-Api-Key'] = tok;
      else if (p.auth_kind === 'apikey-query') probe_url += (probe_url.includes('?') ? '&' : '?') + `apikey=${tok}`;
    }
    const r = await http_ok(probe_url, 4000, headers);
    if (r.ok) {
      checks.push({ status: 'pass', label: p.name, detail: `${url} ok · ${r.ms}ms` });
    } else if (r.status === 401 || r.status === 403) {
      checks.push({
        status: 'fail',
        label: p.name,
        detail: `${url} ${r.status} — auth bad`,
        rec: `refresh ${p.auth_var} in .env, then restart hearth-orchestrator`,
      });
    } else if (r.status > 0) {
      checks.push({ status: 'warn', label: p.name, detail: `${url} HTTP ${r.status}` });
    } else {
      checks.push({
        status: 'warn',
        label: p.name,
        detail: `${url} unreachable (timeout)`,
        rec: `is the service running? curl -v ${url}`,
      });
    }
  }
  return { title: 'Connectors', checks };
}

// ── Section 7: Recent activity ───────────────────────────────────────────

function check_activity(args: Args): Section {
  const checks: Check[] = [];
  const db_path = process.env.HEARTH_DB_PATH ?? resolve(args.hearth_dir, 'data/hearth.db');
  if (!existsSync(db_path)) {
    return { title: 'Recent activity', checks: [{ status: 'skip', label: 'audit log', detail: 'db not present' }] };
  }
  try {
    const db = new Database(db_path, { readonly: true });

    // Last audit row (column is `ts`, not `ts_created`)
    const last = db.prepare('SELECT ts, agent, tool_name FROM audit_log ORDER BY ts DESC LIMIT 1').get() as
      | { ts: string; agent: string; tool_name: string }
      | undefined;
    if (last) {
      const ms_ago = Date.now() - new Date(last.ts).getTime();
      const status: Status = ms_ago < 5 * 60 * 1000 ? 'pass' : 'warn';
      checks.push({
        status,
        label: 'last audit row',
        detail: `${ago(ms_ago)} · ${last.agent} → ${last.tool_name}`,
      });
    } else {
      checks.push({ status: 'warn', label: 'audit log', detail: 'empty — no actions logged yet' });
    }

    // Today's brief (column is `ts_generated`)
    const today = new Date().toISOString().slice(0, 10);
    let brief_row: { ts_generated: string; mood: string } | undefined;
    try {
      brief_row = db
        .prepare('SELECT ts_generated, mood FROM briefs WHERE date(ts_generated) = ? ORDER BY ts_generated DESC LIMIT 1')
        .get(today) as { ts_generated: string; mood: string } | undefined;
    } catch { /* table might not exist on fresh installs */ }
    if (brief_row) {
      checks.push({
        status: 'pass',
        label: "today's brief",
        detail: `fired ${ago(Date.now() - new Date(brief_row.ts_generated).getTime())} · mood: ${brief_row.mood}`,
      });
    } else {
      const hour = new Date().getHours();
      if (hour < 7) {
        checks.push({ status: 'skip', label: "today's brief", detail: 'not yet 7 AM' });
      } else {
        checks.push({
          status: 'warn',
          label: "today's brief",
          detail: 'Kate has not deliberated yet today',
          rec: 'journalctl --user -u hearth-orchestrator | grep deliberation | tail',
        });
      }
    }

    // Audit log rate (last hour)
    const hour_ago = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const hour_count = db.prepare('SELECT count(*) as n FROM audit_log WHERE ts > ?').get(hour_ago) as { n: number };
    checks.push({ status: 'pass', label: 'activity (1h)', detail: `${hour_count.n} audit rows` });

    db.close();
  } catch (e) {
    checks.push({ status: 'warn', label: 'activity', detail: `db read error: ${(e as Error).message.slice(0, 60)}` });
  }
  return { title: 'Recent activity', checks };
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parse_args(process.argv.slice(2));
  const started = Date.now();
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');

  console.log('');
  console.log(`${C.bold}${C.magenta}  🩺  Hearth doctor${C.reset}  ${C.dim}${ts}${C.reset}`);

  const sections: Section[] = [];
  sections.push(await check_core(args));
  sections.push(check_storage(args));
  sections.push(check_config(args));
  sections.push(await check_personas(args));
  sections.push(await check_llm(args));
  sections.push(await check_connectors(args));
  sections.push(check_activity(args));

  for (const s of sections) print_section(s, args.quiet);
  print_summary(sections, started);

  const has_fail = sections.flatMap((s) => s.checks).some((c) => c.status === 'fail');
  process.exit(has_fail ? 1 : 0);
}

void main();
