export {}; // module scope
/**
 * smoke:standing-duties — a declared duty must be runnable, and must be able
 * to fire at all.
 *
 * `standing_duties` is the scheduled rota the runtime resolves and hands the
 * deliberation pass as "these are due right now, all of them and only them."
 * The pass is told to trust it completely — that is the whole point, since the
 * alternative is the pass working out the weekday itself, which is what it
 * gets wrong. So the config has to be correct by construction:
 *
 *   1. Every `steps[].tool` EXISTS in the source tree.
 *   2. The specialist's capabilities SATISFY that tool.
 *   3. The tool is not `dispatch_only` (proposal-approval only — a pass can't
 *      call one).
 *   4. Every `slots` entry is either `*` or a REAL `deliberation_at` slot.
 *      This is the one that catches the silent killer: a duty declared for a
 *      slot the specialist doesn't run is not an error anywhere at runtime, it
 *      simply never fires — the exact failure mode (a duty that quietly stops
 *      happening) that moving the rota into config was meant to end.
 *   5. Ids are unique per specialist.
 *
 * Plus a resolver check with a FIXED date, so the weekday/window arithmetic is
 * pinned rather than trusted.
 *
 * Reads YAML + tool SOURCE, like smoke-tool-reflexes and
 * smoke-yield-coverage-lint — no DB, no LLM, no network, no native modules.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { render_standing_duties, duty_is_due, local_date_plus } from '../src/core/standing_duties';
import type { StandingDuty } from '../src/core/standing_duties';

const REPO = resolve(import.meta.dir, '..');
const SPECIALISTS_DIR = join(REPO, 'config', 'specialists');
const SEARCH_ROOTS = ['src/specialists', 'src/connectors', 'src/tools', 'src/agents'];

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}
const ALL_TS = SEARCH_ROOTS.flatMap((r) => walk(join(REPO, r)));

function tool_facts(tool: string): { caps: string[]; dispatch_only: boolean } | null {
  for (const file of ALL_TS) {
    const src = readFileSync(file, 'utf8');
    const at = src.indexOf(`name: '${tool}'`);
    if (at === -1) continue;
    const exec_at = src.indexOf('execute(', at);
    const w = src.slice(at, exec_at === -1 ? at + 6000 : exec_at);
    const m = /^[ \t]*required_capabilities:\s*\[([^\]]*)\]/m.exec(w);
    return {
      caps: [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).filter((c): c is string => !!c),
      dispatch_only: /^[ \t]*dispatch_only:\s*true/m.test(w),
    };
  }
  return null;
}

const failures: string[] = [];
let checked = 0;
let with_duties = 0;

for (const f of readdirSync(SPECIALISTS_DIR)) {
  if (!f.endsWith('.yaml')) continue;
  let doc: {
    id?: string;
    capabilities?: Record<string, boolean>;
    proactive?: { standing_duties?: StandingDuty[]; deliberation_at?: string[] };
  };
  try {
    doc = parse(readFileSync(join(SPECIALISTS_DIR, f), 'utf8'));
  } catch (err) {
    failures.push(`${f} does not parse: ${(err as Error).message}`);
    continue;
  }
  const duties = doc.proactive?.standing_duties ?? [];
  if (duties.length === 0) continue;
  with_duties++;

  const id = doc.id ?? f.replace(/\.yaml$/, '');
  const granted = new Set(
    Object.entries(doc.capabilities ?? {}).filter(([, v]) => v === true).map(([k]) => k),
  );
  const real_slots = new Set(doc.proactive?.deliberation_at ?? []);
  const seen_ids = new Set<string>();

  for (const d of duties) {
    checked++;
    const where = `${id}/${d.id}`;

    if (seen_ids.has(d.id)) failures.push(`${where} — duplicate duty id.`);
    seen_ids.add(d.id);

    for (const slot of d.slots) {
      if (slot === '*') continue;
      if (!real_slots.has(slot)) {
        failures.push(
          `${where} — declared for slot "${slot}", which is not in ${id}'s ` +
            `deliberation_at (${[...real_slots].join(', ') || 'none'}). It would ` +
            `NEVER fire, and nothing at runtime would say so.`,
        );
      }
    }

    for (const step of d.steps ?? []) {
      const facts = tool_facts(step.tool);
      if (!facts) {
        failures.push(`${where} → \`${step.tool}\` — no such tool in the source tree.`);
        continue;
      }
      if (facts.dispatch_only) {
        failures.push(`${where} → \`${step.tool}\` is dispatch_only — a pass can't call it.`);
      }
      const missing = facts.caps.filter((c) => !granted.has(c));
      if (missing.length > 0) {
        failures.push(
          `${where} → \`${step.tool}\` needs ${missing.join(' + ')}, which ${id} is not granted.`,
        );
      }
    }
  }
}

/* ── resolver: pin the arithmetic against a fixed instant ─────────────────── */
// 2026-08-03 is a MONDAY. Denver is UTC-6 in August, so 15:00Z is 09:00 local —
// same local date, which keeps the assertion honest about the zone mattering.
const MON = new Date('2026-08-03T15:00:00Z');
const TUE = new Date('2026-08-04T15:00:00Z');
const TZ = 'America/Denver';
const mk = (over: Partial<StandingDuty>): StandingDuty => ({
  id: 't',
  title: 'T',
  slots: ['07:00'],
  steps: [{ tool: 'x' }],
  ...over,
});

const rcheck = (ok: unknown, msg: string) => {
  if (!ok) failures.push(`resolver: ${msg}`);
};
rcheck(duty_is_due(mk({ dow: ['mon'] }), '07:00', MON, TZ), 'a Monday duty is due on Monday');
rcheck(!duty_is_due(mk({ dow: ['mon'] }), '07:00', TUE, TZ), 'a Monday duty is NOT due on Tuesday');
rcheck(!duty_is_due(mk({ dow: ['mon'] }), '12:30', MON, TZ), 'a 07:00 duty is not due at 12:30');
rcheck(duty_is_due(mk({ slots: ['*'] }), '22:00', TUE, TZ), 'a "*" duty is due at any slot');
rcheck(duty_is_due(mk({ dow: ['mon'], dom_max: 7 }), '07:00', MON, TZ), 'first-Monday duty fires on the 3rd');
rcheck(
  !duty_is_due(mk({ dow: ['mon'], dom_max: 2 }), '07:00', MON, TZ),
  'dom_max excludes a Monday past the cap',
);
rcheck(local_date_plus(MON, TZ, 14) === '2026-08-17', `+14d from 2026-08-03 is 2026-08-17 (got ${local_date_plus(MON, TZ, 14)})`);
rcheck(local_date_plus(MON, TZ, 0) === '2026-08-03', 'a 0-day window is today');
// DST: 2026-11-01 is the US fall-back. A ms-based +7 would land a day early.
const DST = new Date('2026-10-30T15:00:00Z');
rcheck(local_date_plus(DST, TZ, 7) === '2026-11-06', `+7d across the DST fall-back is 2026-11-06 (got ${local_date_plus(DST, TZ, 7)})`);

const rendered_mon = render_standing_duties(
  [mk({ id: 'weekly', title: 'Weekly', dow: ['mon'], windows: { due_soon: 14 } }), mk({ id: 'daily', title: 'Daily' })],
  '07:00',
  MON,
  TZ,
);
rcheck(rendered_mon.includes('Weekly') && rendered_mon.includes('Daily'), 'Monday renders both duties');
rcheck(rendered_mon.includes('2026-08-17'), 'a window renders as an absolute date, not a day count');
rcheck(rendered_mon.includes('Monday 2026-08-03'), 'the header states the resolved weekday + date');

const rendered_tue = render_standing_duties(
  [mk({ id: 'weekly', title: 'Weekly', dow: ['mon'] }), mk({ id: 'daily', title: 'Daily' })],
  '07:00',
  TUE,
  TZ,
);
rcheck(!rendered_tue.includes('Weekly'), 'Tuesday OMITS the Monday duty entirely — not "skip it"');
rcheck(rendered_tue.includes('Daily'), 'Tuesday still renders the daily duty');
rcheck(render_standing_duties([], '07:00', MON, TZ) === '', 'no duties ⇒ empty string (prompt unchanged)');
rcheck(
  render_standing_duties([mk({ dow: ['sat'] })], '07:00', MON, TZ) === '',
  'none due ⇒ empty string',
);

if (failures.length > 0) {
  console.error(`\n✗ standing_duties — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}
console.log(
  `✓ standing_duties — ${checked} duty(ies) across ${with_duties} specialist(s) runnable and ` +
    `schedulable; resolver arithmetic pinned (weekday, dom_max, windows, DST).`,
);
