/**
 * Smoke for the emergency red-light flash (2026-06-26; group-based smooth fade).
 *
 * Self-contained: the HA transport (call_service + fetch_states) and the sleep
 * are injected. Asserts the redesigned flow — snapshot PER-BULB → smooth fade to
 * red via ROOM GROUPS (transition) → smooth per-bulb fade back. Covers: group vs
 * member-bulb vs ungrouped targeting, the per-bulb restore set, exclusion,
 * transitions, the fail-SAFE (no snapshot → no flash), restore-ALWAYS (a mid-flash
 * throw still restores), and the kill switch.
 */
import {
  flash_emergency_lights,
  maybe_flash_emergency_lights,
  emergency_light_flash_enabled,
} from '../src/core/emergency_lights';
import type { HAEntityState } from '../src/connectors/home_assistant';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const grp = (id: string, modes: string[], members: string[]): HAEntityState =>
  ({ entity_id: id, state: 'on', attributes: { supported_color_modes: modes, is_hue_group: true, entity_id: members }, last_changed: null }) as unknown as HAEntityState;
const bulb = (id: string, state: string, modes: string[]): HAEntityState =>
  ({ entity_id: id, state, attributes: { supported_color_modes: modes }, last_changed: null }) as unknown as HAEntityState;

// A Hue room group (color) with 2 member bulbs; a Hue room group (white) with 1;
// an ungrouped Lutron (excluded), another ungrouped Lutron (flashed), and an
// unavailable bulb (skipped). The members must be flashed VIA their group, never
// individually; the snapshot must be the PER-BULB set, never the groups.
const STATES: HAEntityState[] = [
  grp('light.living_room', ['color_temp', 'xy'], ['light.living_room_left', 'light.living_room_right']),
  bulb('light.living_room_left', 'on', ['color_temp', 'xy']),
  bulb('light.living_room_right', 'on', ['color_temp', 'xy']),
  grp('light.kitchen', ['brightness'], ['light.bar']),
  bulb('light.bar', 'on', ['brightness']),
  bulb('light.foyer_outdoor_sconces', 'off', ['brightness']), // ungrouped Lutron — EXCLUDED
  bulb('light.basement_mains', 'on', ['brightness']), // ungrouped Lutron — flashed individually
  bulb('light.broken', 'unavailable', ['xy']), // skipped (unavailable)
];

interface Call { domain: string; service: string; data: Record<string, unknown> }

function harness(opts: { throw_on_turn_on?: boolean; snapshot_fails?: boolean } = {}) {
  const calls: Call[] = [];
  const call_service = async (domain: string, service: string, data: Record<string, unknown> = {}) => {
    calls.push({ domain, service, data });
    if (opts.snapshot_fails && domain === 'scene' && service === 'create') return { ok: false as const, reason: 'no scene support' };
    if (opts.throw_on_turn_on && domain === 'light' && service === 'turn_on') throw new Error('HA exploded mid-fade');
    return { ok: true as const };
  };
  const fetch_states = async () => ({ ok: true as const, states: STATES });
  return { calls, call_service, fetch_states, sleep: async () => {} };
}

async function main(): Promise<void> {
  process.env.HEARTH_EMERGENCY_FLASH_CYCLES = '1';
  process.env.HEARTH_EMERGENCY_FLASH_RAMP_MS = '1200';
  process.env.HEARTH_EMERGENCY_FLASH_EXCLUDE = 'light.foyer_outdoor_sconces';
  delete process.env.HEARTH_EMERGENCY_FLASH_RGB;

  // ── group-targeted smooth fade → red → restore ────────────────────────────
  console.log('→ fade to red via GROUPS, restore PER-BULB, with transitions');
  {
    const h = harness();
    const r = await flash_emergency_lights({ call_service: h.call_service, fetch_states: h.fetch_states, sleep: h.sleep });
    check('result ok + restored', r.ok && r.restored, JSON.stringify(r));
    check('flashed 2 groups (living_room + kitchen)', r.group_count === 2, `groups=${r.group_count}`);
    check('3 flash targets (2 groups + 1 ungrouped Lutron)', r.target_count === 3, `targets=${r.target_count}`);
    check('snapshot is the 4 PER-BULB lights (2 members + bar + basement_mains)', r.snapshot_count === 4, `snap=${r.snapshot_count}`);
    check('1 color target (the color group)', r.color_count === 1, `color=${r.color_count}`);
    check('2 brightness targets (kitchen group + Lutron)', r.bright_count === 2, `bright=${r.bright_count}`);

    const create = h.calls.find((c) => c.domain === 'scene' && c.service === 'create');
    const snap = (create?.data.snapshot_entities ?? []) as string[];
    check('FIRST call is the per-bulb scene.create', h.calls[0]?.service === 'create');
    check('snapshot = individual bulbs, NOT groups', snap.slice().sort().join(',') === 'light.bar,light.basement_mains,light.living_room_left,light.living_room_right', snap.join(','));
    check('snapshot excludes the GROUP entities', !snap.includes('light.living_room') && !snap.includes('light.kitchen'));
    check('snapshot excludes the excluded sconce', !snap.includes('light.foyer_outdoor_sconces'));
    check('snapshot excludes the unavailable bulb', !snap.includes('light.broken'));

    const red = h.calls.find((c) => c.domain === 'light' && c.service === 'turn_on' && Array.isArray(c.data.rgb_color));
    check('RED is sent to the color GROUP (not its member bulbs)', JSON.stringify(red?.data.entity_id) === '["light.living_room"]', JSON.stringify(red?.data.entity_id));
    check('member bulbs are NOT addressed directly', !h.calls.some((c) => c.domain === 'light' && Array.isArray(c.data.entity_id) && (c.data.entity_id as string[]).includes('light.living_room_left')));
    check('red is [255,0,0]', JSON.stringify(red?.data.rgb_color) === '[255,0,0]');
    check('red fade uses a smooth TRANSITION (not a hard strobe)', typeof red?.data.transition === 'number' && (red!.data.transition as number) > 0, String(red?.data.transition));
    const bright = h.calls.find((c) => c.domain === 'light' && c.service === 'turn_on' && !c.data.rgb_color);
    check('brightness targets are the white group + Lutron', JSON.stringify((bright?.data.entity_id as string[])?.slice().sort()) === '["light.basement_mains","light.kitchen"]', JSON.stringify(bright?.data.entity_id));
    check('brightness fade also uses a transition', typeof bright?.data.transition === 'number');

    const restore = h.calls.find((c) => c.domain === 'scene' && c.service === 'turn_on');
    check('restore is scene.turn_on of the snapshot scene WITH a transition (smooth back)',
      restore?.data.entity_id === 'scene.hearth_emergency_restore' && typeof restore?.data.transition === 'number');
    check('NO hard turn_off strobe anywhere (smooth fade, not on/off)', !h.calls.some((c) => c.domain === 'light' && c.service === 'turn_off'));
    check('cleanup scene.delete is last', h.calls.at(-1)?.domain === 'scene' && h.calls.at(-1)?.service === 'delete');
  }

  // ── fail-SAFE: snapshot fails → do NOT flash ──────────────────────────────
  console.log('\n→ fail-safe: snapshot failure → never flash');
  {
    const h = harness({ snapshot_fails: true });
    const r = await flash_emergency_lights({ call_service: h.call_service, fetch_states: h.fetch_states, sleep: h.sleep });
    check('result not ok (snapshot failed)', !r.ok && /snapshot failed/.test(r.reason ?? ''));
    check('NO light commands issued', !h.calls.some((c) => c.domain === 'light'));
    check('NO restore issued', !h.calls.some((c) => c.domain === 'scene' && c.service === 'turn_on'));
  }

  // ── restore-ALWAYS: a throw mid-fade still restores ───────────────────────
  console.log('\n→ restore-always: a mid-fade throw still restores the house');
  {
    const h = harness({ throw_on_turn_on: true });
    const r = await flash_emergency_lights({ call_service: h.call_service, fetch_states: h.fetch_states, sleep: h.sleep });
    check('result not ok (fade threw) but does not crash', !r.ok);
    check('snapshot taken first', h.calls[0]?.service === 'create');
    check('restore STILL ran (finally) — house not left red', r.restored && h.calls.some((c) => c.domain === 'scene' && c.service === 'turn_on'));
  }

  // ── kill switch ───────────────────────────────────────────────────────────
  console.log('\n→ kill switch: maybe_flash no-ops when disabled');
  {
    delete process.env.HEARTH_EMERGENCY_LIGHT_FLASH;
    check('disabled by default', emergency_light_flash_enabled() === false);
    const h = harness();
    maybe_flash_emergency_lights({ call_service: h.call_service, fetch_states: h.fetch_states, sleep: h.sleep });
    await new Promise((r) => setTimeout(r, 20));
    check('no HA calls when disabled', h.calls.length === 0, `calls=${h.calls.length}`);
    process.env.HEARTH_EMERGENCY_LIGHT_FLASH = '1';
    check('enabled when HEARTH_EMERGENCY_LIGHT_FLASH=1', emergency_light_flash_enabled() === true);
    delete process.env.HEARTH_EMERGENCY_LIGHT_FLASH;
  }

  console.log(`\n  passed=${passed}  failed=${failed}`);
  if (failed > 0) { console.error('\n✗ EMERGENCY-LIGHTS SMOKE FAILED'); process.exit(1); }
  console.log('\n✓ EMERGENCY-LIGHTS SMOKE OK');
}

main().catch((err: unknown) => {
  console.error('\n✗ EMERGENCY-LIGHTS SMOKE CRASHED:', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
