/**
 * smoke:delivery-window — the read-the-room delivery gate (Piece 5). Pure
 * function, no I/O: drives should_deliver_now + resolve_presence over the full
 * matrix so a regression is caught without a vault or a live clock.
 *
 *   bun run smoke:delivery-window
 */
import {
  should_deliver_now,
  resolve_presence,
  delivery_window_enabled,
} from '@core/delivery_window';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const NOW = new Date('2026-06-21T15:00:00Z');

function main(): void {
  // ── URGENT always delivers, even when everything else would defer ──────────
  const blocking = {
    quiet: true,
    quiet_until: '2026-06-21T22:00:00Z',
    in_meeting: true,
    meeting_ends: '2026-06-21T16:00:00Z',
    presence: 'away' as const,
    last_push_ms_ago: 1_000,
  };
  check('high severity always delivers', should_deliver_now({ ...blocking, severity: 'high' }, NOW).deliver === true);
  check('interrupt kind always delivers', should_deliver_now({ ...blocking, kind: 'interrupt' }, NOW).deliver === true);

  // ── AWAITED work (On the Fire, 2026-07-29) ────────────────────────────────
  // The regression this locks down: job ma_qqwrhh1a4gcg finished in 17 seconds
  // and its "it's filed" was queued to 05:59:59Z the NEXT MORNING for
  // `in_meeting`, while the owner sat in the thread asking whether Kate was
  // going to say anything. A completion the user is waiting on is the second
  // half of their own turn, not an interruption of it.
  check(
    'awaited delivers mid-meeting (the ma_qqwrhh1a4gcg regression)',
    should_deliver_now(
      { severity: 'medium', in_meeting: true, meeting_ends: '2026-06-21T16:00:00Z', is_awaited: true },
      NOW,
    ).deliver === true,
  );
  check(
    'awaited delivers while away',
    should_deliver_now({ severity: 'medium', presence: 'away', is_awaited: true }, NOW).deliver === true,
  );
  check(
    'awaited delivers inside the recency gap',
    should_deliver_now({ severity: 'medium', last_push_ms_ago: 1_000, is_awaited: true }, NOW).deliver === true,
  );
  // Quiet hours is NOT skipped once the request has gone cold — a deep dive
  // fired at 23:00 that lands at 02:00 must not wake the house.
  check(
    'awaited + quiet + FRESH request → delivers',
    should_deliver_now(
      { severity: 'medium', quiet: true, quiet_until: '2026-06-21T22:00:00Z', is_awaited: true, awaited_age_ms: 20_000 },
      NOW,
    ).deliver === true,
  );
  const cold = should_deliver_now(
    {
      severity: 'medium',
      quiet: true,
      quiet_until: '2026-06-21T22:00:00Z',
      is_awaited: true,
      awaited_age_ms: 3 * 60 * 60_000,
    },
    NOW,
  );
  check('awaited + quiet + COLD request → still defers', cold.deliver === false && cold.defer_reason === 'quiet_hours');
  check('cold awaited defer still targets quiet end', cold.not_before === '2026-06-21T22:00:00Z');
  // A missing age means the caller didn't measure — treated as fresh, never as
  // an excuse to hold an answer the user may be waiting for.
  check(
    'awaited with unknown age is treated as fresh',
    should_deliver_now({ severity: 'medium', quiet: true, is_awaited: true }, NOW).deliver === true,
  );
  // The bypass is opt-IN: an ordinary proactive nudge is unaffected.
  const nudge = should_deliver_now({ severity: 'medium', in_meeting: true, meeting_ends: null }, NOW);
  check('a non-awaited nudge still defers mid-meeting', nudge.deliver === false && nudge.defer_reason === 'in_meeting');

  // ── Quiet hours → defer, not_before = quiet end ────────────────────────────
  const q = should_deliver_now({ severity: 'medium', quiet: true, quiet_until: '2026-06-21T22:00:00Z' }, NOW);
  check('quiet hours defers', q.deliver === false && q.defer_reason === 'quiet_hours');
  check('quiet defer not_before = quiet end', q.not_before === '2026-06-21T22:00:00Z');

  // ── Mid-meeting → defer, not_before = meeting end ──────────────────────────
  const m = should_deliver_now({ severity: 'medium', in_meeting: true, meeting_ends: '2026-06-21T16:00:00Z' }, NOW);
  check('in-meeting defers', m.deliver === false && m.defer_reason === 'in_meeting');
  check('meeting defer not_before = meeting end', m.not_before === '2026-06-21T16:00:00Z');
  // No known end → a re-check delay in the future.
  const m2 = should_deliver_now({ severity: 'medium', in_meeting: true, meeting_ends: null }, NOW);
  check('meeting with no end → future re-check', m2.deliver === false && Date.parse(m2.not_before!) > NOW.getTime());

  // ── Presence away → defer for a GENERAL nudge; location nudge is EXEMPT ─────
  const away = should_deliver_now({ severity: 'medium', presence: 'away' }, NOW);
  check('away defers a general nudge', away.deliver === false && away.defer_reason === 'presence_away');
  check('away + location nudge DELIVERS (exempt)', should_deliver_now({ severity: 'medium', presence: 'away', is_location_nudge: true }, NOW).deliver === true);
  check('home delivers', should_deliver_now({ severity: 'medium', presence: 'home' }, NOW).deliver === true);

  // ── Recency → defer; not_before = now + remaining gap ──────────────────────
  const r = should_deliver_now({ severity: 'medium', last_push_ms_ago: 120_000, min_gap_ms: 600_000 }, NOW);
  check('recent push defers', r.deliver === false && r.defer_reason === 'recency');
  check('recency not_before = now + remaining gap', Date.parse(r.not_before!) - NOW.getTime() === 480_000);
  check('an old push does NOT defer', should_deliver_now({ severity: 'medium', last_push_ms_ago: 11 * 60_000, min_gap_ms: 600_000 }, NOW).deliver === true);

  // ── Precedence: quiet > meeting > away > recency (first blocker wins) ───────
  check('precedence: quiet wins over meeting/away/recency', should_deliver_now({ severity: 'medium', ...blocking }, NOW).defer_reason === 'quiet_hours');
  check('precedence: meeting wins over away/recency', should_deliver_now({ severity: 'medium', in_meeting: true, presence: 'away', last_push_ms_ago: 1_000 }, NOW).defer_reason === 'in_meeting');
  check('precedence: away wins over recency', should_deliver_now({ severity: 'medium', presence: 'away', last_push_ms_ago: 1_000, min_gap_ms: 600_000 }, NOW).defer_reason === 'presence_away');

  // ── Fail-open: unknown signals never defer ─────────────────────────────────
  check('all signals unknown → delivers (fail-open)', should_deliver_now({ severity: 'medium' }, NOW).deliver === true);
  check('presence unknown → no away-defer', should_deliver_now({ severity: 'medium', presence: 'unknown' }, NOW).deliver === true);

  // ── resolve_presence — conservative three-state ────────────────────────────
  // The place_id path (an iOS geofence region crossing) still works…
  check('unavailable snapshot → unknown', resolve_presence({ available: false, kind: 'visit_arrival', place_id: 'home' }) === 'unknown');
  check('arrival at home → home', resolve_presence({ available: true, kind: 'visit_arrival', place_id: 'home' }) === 'home');
  check('region_enter home → home', resolve_presence({ available: true, kind: 'region_enter', place_id: 'home' }) === 'home');
  check('departure from home → away', resolve_presence({ available: true, kind: 'visit_departure', place_id: 'home' }) === 'away');
  check('region_exit home → away', resolve_presence({ available: true, kind: 'region_exit', place_id: 'home' }) === 'away');
  check('arrival at a non-home place → away', resolve_presence({ available: true, kind: 'visit_arrival', place_id: 'gym' }) === 'away');
  check('significant_change → unknown', resolve_presence({ available: true, kind: 'significant_change', place_id: null }) === 'unknown');

  // …but the REAL iOS payload carries no place_id at all, so presence has to
  // come from coords vs the home anchor. Before 2026-07-26 every case below
  // read 'unknown' and the presence-away defer never engaged even once.
  const HOME_ANCHOR = { lat: 39.7411, lng: -104.9880 };
  const at_home = { lat: 39.7418, lon: -104.9880 }; // ~80m out — inside the radius
  const elsewhere = { lat: 39.7392, lon: -104.9903 }; // ~4.8km out
  check(
    'LIVE SHAPE: visit_arrival at home coords, no place_id → home',
    resolve_presence({ available: true, kind: 'visit_arrival', place_id: null, coords: at_home }, HOME_ANCHOR) === 'home',
  );
  check(
    'LIVE SHAPE: visit_departure at home coords, no place_id → away',
    resolve_presence({ available: true, kind: 'visit_departure', place_id: null, coords: at_home }, HOME_ANCHOR) === 'away',
  );
  check(
    'a departure from somewhere ELSE says nothing about home → unknown',
    resolve_presence({ available: true, kind: 'visit_departure', place_id: null, coords: elsewhere }, HOME_ANCHOR) === 'unknown',
  );
  check(
    'LIVE SHAPE: visit_arrival far from home, no place_id → away',
    resolve_presence({ available: true, kind: 'visit_arrival', place_id: null, coords: elsewhere }, HOME_ANCHOR) === 'away',
  );
  check(
    'no anchor + no place_id → unknown (degrades, never guesses)',
    resolve_presence({ available: true, kind: 'visit_arrival', place_id: null, coords: at_home }, null) === 'unknown',
  );
  check(
    'significant_change at home coords → unknown (transit fix, not an edge)',
    resolve_presence({ available: true, kind: 'significant_change', place_id: null, coords: at_home }, HOME_ANCHOR) === 'unknown',
  );

  // ── Kill switch ────────────────────────────────────────────────────────────
  delete process.env.HEARTH_DELIVERY_WINDOW;
  check('gate disabled by default (dark)', delivery_window_enabled() === false);
  process.env.HEARTH_DELIVERY_WINDOW = '1';
  check('gate enables on flag', delivery_window_enabled() === true);
  delete process.env.HEARTH_DELIVERY_WINDOW;

  console.log(`\n✅ smoke:delivery-window — ${passed} checks passed`);
}

main();
