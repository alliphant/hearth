/* Hearth Ride Log — /app/rides
 *
 * Vanilla JS over two JSON endpoints (same contract iOS uses):
 *   GET /api/workout/sessions            — completed sessions + names
 *   GET /api/workout/sessions/:id        — heartbeat series + cue texts
 * Series are fetched lazily per card (IntersectionObserver) so a long
 * history doesn't fan out sixty requests on load. Rides the /app
 * session cookie; 401 → sign-in hint.
 */
(() => {
  'use strict';

  const ZONES = ['z1', 'z2', 'z3', 'z4', 'z5'];
  const zone_color = (z) =>
    getComputedStyle(document.documentElement).getPropertyValue(`--${z}`).trim() || '#d8ad4a';

  const $ = (sel, el) => (el || document).querySelector(sel);
  const els = {
    status: $('#status'),
    statusText: $('#status-text'),
    filters: $('#filters'),
    stats: $('#stats'),
    rides: $('#rides'),
  };

  let sessions = [];
  let active_type = 'all';
  const series_cache = new Map();

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  function status(text, err) {
    els.statusText.textContent = text;
    els.status.classList.toggle('err', !!err);
  }

  async function api(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) {
      throw Object.assign(new Error('auth'), { auth: true });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── Formatting ──────────────────────────────────────────────────────

  const fmt_dur = (s) => {
    if (s == null) return '—';
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
  };
  const fmt_mi = (m) => (m == null ? null : `${(m / 1609.344).toFixed(1)} mi`);
  const fmt_day = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };
  const wx_line = (w) => {
    if (!w) return null;
    const bits = [];
    if (w.current_temperature_f != null) bits.push(`${Math.round(w.current_temperature_f)}°`);
    if (w.current_condition) bits.push(String(w.current_condition).toLowerCase());
    return bits.length ? bits.join(' ') : null;
  };

  // ── Sparklines (inline SVG) ─────────────────────────────────────────

  function spark_path(values, w, h, pad) {
    const xs = values.length - 1 || 1;
    const finite = values.filter((v) => v != null && Number.isFinite(v));
    if (finite.length < 2) return null;
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    const span = hi - lo || 1;
    const pts = values.map((v, i) => {
      const x = (i / xs) * (w - 2) + 1;
      const y = v == null ? null : h - pad - ((v - lo) / span) * (h - pad * 2);
      return [x, y];
    });
    let d = '';
    for (const [x, y] of pts) {
      if (y == null) continue;
      d += (d ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return { d, lo, hi };
  }

  function line_spark(values, color, { fill = false } = {}) {
    const W = 280; const H = 48;
    const p = spark_path(values, W, H, 5);
    if (!p) return '<div class="ph">not enough data</div>';
    const fill_d = `${p.d} L ${W - 1} ${H} L 1 ${H} Z`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${fill ? `<path d="${fill_d}" fill="${color}" opacity="0.16" stroke="none"></path>` : ''}
      <path class="draw" d="${p.d}" fill="none" stroke="${color}" stroke-width="1.8"
        stroke-linejoin="round" stroke-linecap="round"></path>
    </svg>`;
  }

  function hr_spark(series) {
    const hr = series.map((s) => s.current_hr);
    const zones = series.map((s) => s.current_hr_zone).filter((z) => z != null);
    const dominant = zones.length
      ? `z${Math.round(zones.reduce((a, b) => a + b, 0) / zones.length)}`
      : 'z3';
    return line_spark(hr, zone_color(dominant), { fill: true });
  }

  function elev_spark(series) {
    const gain = series.map((s) => s.elevation_gain_m);
    if (!gain.some((g) => g != null && g > 0)) return '<div class="ph">no elevation data</div>';
    return line_spark(gain, zone_color('z3') && getComputedStyle(document.documentElement).getPropertyValue('--oak').trim(), { fill: true });
  }

  function zonebar(zm) {
    if (!zm) return '';
    const total = ZONES.reduce((a, z) => a + (Number(zm[z]) || 0), 0);
    if (total <= 0) return '';
    const segs = ZONES.map((z) => {
      const v = Number(zm[z]) || 0;
      if (v <= 0) return '';
      return `<span style="width:${((v / total) * 100).toFixed(1)}%;background:${zone_color(z)}" title="${z.toUpperCase()} ${Math.round(v)} min"></span>`;
    }).join('');
    return `<div class="zonebar">${segs}</div>
      <div class="zonekey">${ZONES.map((z) => {
        const v = Math.round(Number(zm[z]) || 0);
        return v > 0 ? `<i style="color:${zone_color(z)}">${z.toUpperCase()} ${v}m</i>` : '';
      }).join('')}</div>`;
  }

  // ── Cards ───────────────────────────────────────────────────────────

  function metric_chips(s) {
    const chips = [];
    const mi = fmt_mi(s.distance_m);
    if (mi) chips.push(`<span class="m"><b>${mi}</b></span>`);
    chips.push(`<span class="m"><b>${fmt_dur(s.duration_s)}</b></span>`);
    if (s.avg_speed_kmh != null) chips.push(`<span class="m"><span class="lbl">avg</span><b>${(s.avg_speed_kmh / 1.609344).toFixed(1)} mph</b></span>`);
    if (s.elevation_gain_m != null && s.elevation_gain_m >= 1) chips.push(`<span class="m gain"><b>▲ ${Math.round(s.elevation_gain_m * 3.28084)} ft</b></span>`);
    chips.push(`<span class="m"><b>${Math.round(s.active_kcal ?? 0)}</b><span class="lbl"> kcal</span></span>`);
    if (s.avg_hr != null) chips.push(`<span class="m hr"><span class="lbl">♥</span><b>${Math.round(s.avg_hr)}</b><span class="lbl"> avg · ${s.max_hr != null ? Math.round(s.max_hr) + ' max' : ''}</span></span>`);
    if (s.avg_power_w != null) chips.push(`<span class="m pw"><b>${Math.round(s.avg_power_w)} W</b></span>`);
    return chips.join('');
  }

  function card(s) {
    const wx = wx_line(s.weather);
    const route = Array.isArray(s.route_notes) && s.route_notes.length
      ? ` · ${esc(s.route_notes[0])}` : '';
    return `<article class="ride" data-id="${esc(s.session_id)}">
      <div class="when">
        <span>${esc(fmt_day(s.started_at))}</span>
        ${wx ? `<span class="wx">${esc(wx)}</span>` : ''}
        <span style="flex:1"></span>
        <span class="type">${esc(s.workout_type)}</span>
      </div>
      <h2>${s.ride_name ? esc(s.ride_name) : `<span class="unnamed">unnamed ${esc(s.workout_type)}${route}</span>`}</h2>
      <div class="metrics">${metric_chips(s)}</div>
      <div class="sparks">
        <div class="spark"><div class="t">heart rate</div><div class="sp-hr"><div class="ph">…</div></div></div>
        <div class="spark"><div class="t">elevation gained</div><div class="sp-elev"><div class="ph">…</div></div></div>
      </div>
      ${zonebar(s.hr_zone_minutes)}
      <div class="detail"><div class="ridemap" style="display:none"></div><div class="cues"><div class="ph">…</div></div></div>
    </article>`;
  }

  async function load_series(card_el) {
    const id = card_el.dataset.id;
    if (series_cache.has(id)) return series_cache.get(id);
    const promise = api(`/api/workout/sessions/${encodeURIComponent(id)}`).catch(() => null);
    series_cache.set(id, promise);
    const detail = await promise;
    const hr_el = $('.sp-hr', card_el);
    const el_el = $('.sp-elev', card_el);
    if (!detail || !Array.isArray(detail.series) || detail.series.length < 2) {
      if (hr_el) hr_el.innerHTML = '<div class="ph">no live series for this session</div>';
      if (el_el) el_el.innerHTML = '<div class="ph">—</div>';
      return detail;
    }
    if (hr_el) hr_el.innerHTML = hr_spark(detail.series);
    if (el_el) el_el.innerHTML = elev_spark(detail.series);
    return detail;
  }

  // ── The coached-ride map (2026-06-12) ────────────────────────────
  // Route polyline + a pin per delivered cue, each popup carrying WHAT
  // Astrid said, the trigger, and WHY (the throttle's reason). Leaflet
  // loads lazily from CDN only when a session actually has a route.
  let leaflet_loading = null;
  function load_leaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leaflet_loading) return leaflet_loading;
    leaflet_loading = new Promise((res, rej) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      js.onload = () => res(window.L);
      js.onerror = rej;
      document.head.appendChild(js);
    });
    return leaflet_loading;
  }
  const CLS_COLOR = { effort: '#e08a2e', care: '#5aa6a0', narrative: '#9a7bd0', progress: '#3fae6e', wrap_up: '#4a8fd6', presence: '#b29c7e' };
  function humanize_trigger(t) { return String(t || '').replace(/_/g, ' '); }
  function nearest_point(points, ts) {
    const target = Date.parse(ts);
    if (!Number.isFinite(target)) return points[0];
    let best = points[0], best_d = Infinity;
    for (const p of points) {
      const d = Math.abs(Date.parse(p.t) - target);
      if (d < best_d) { best_d = d; best = p; }
    }
    return best;
  }
  async function render_map(card_el, detail) {
    const map_el = $('.ridemap', card_el);
    if (!map_el || map_el.dataset.done) return;
    const route = detail && detail.route;
    if (!route || !Array.isArray(route.points) || route.points.length < 2) return;
    map_el.dataset.done = '1';
    map_el.style.display = 'block';
    map_el.style.height = '320px';
    map_el.style.borderRadius = '10px';
    map_el.style.margin = '0 0 .9rem';
    try {
      const L = await load_leaflet();
      const map = L.map(map_el, { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      const latlngs = route.points.map((p) => [p.lat, p.lon]);
      const line = L.polyline(latlngs, { color: '#d8ad4a', weight: 4, opacity: 0.9 }).addTo(map);
      map.fitBounds(line.getBounds(), { padding: [24, 24] });
      const cues = (detail.cues || []).filter((c) => c.ts);
      for (const cue of cues) {
        const at = nearest_point(route.points, cue.ts);
        if (!at) continue;
        const color = CLS_COLOR[cue.cls] || '#b29c7e';
        const marker = L.circleMarker([at.lat, at.lon], {
          radius: 7, color: '#15100a', weight: 2, fillColor: color, fillOpacity: 0.95,
        }).addTo(map);
        const when = new Date(cue.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        marker.bindPopup(
          `<div style="max-width:240px"><b>${esc(cue.text)}</b><br>` +
          `<small>${esc(humanize_trigger(cue.trigger_id))} · ${esc(when)}` +
          (cue.reason ? `<br>why: ${esc(cue.reason)}` : '') +
          `</small></div>`,
        );
      }
    } catch (e) {
      map_el.style.display = 'none';
    }
  }

  async function toggle_detail(card_el) {
    const open = card_el.classList.toggle('open');
    if (!open) return;
    const detail = await load_series(card_el);
    if (detail) render_map(card_el, detail);
    const cues_el = $('.cues', card_el);
    if (!cues_el) return;
    const cues = detail && Array.isArray(detail.cues) ? detail.cues : [];
    if (cues.length === 0) {
      cues_el.innerHTML = '<h3>Astrid</h3><div class="ph" style="text-align:left">No cue history for this session (cue texts keep for 48h).</div>';
      return;
    }
    const t0 = detail.session ? Date.parse(detail.session.started_at) : NaN;
    cues_el.innerHTML = '<h3>Astrid, mid-ride</h3>' + cues.map((c) => {
      const at = Number.isFinite(t0) && c.ts ? Math.max(0, Math.round((Date.parse(c.ts) - t0) / 60000)) : null;
      return `<div class="cue">
        <span class="at">${at != null ? `${at}′` : ''}</span>
        <span class="txt">${esc(c.text)}<span class="trig">${esc(String(c.trigger_id || '').replace(/_/g, ' '))}</span></span>
      </div>`;
    }).join('');
  }

  // ── Stats + filters ─────────────────────────────────────────────────

  function render_stats(list) {
    const now = Date.now();
    const month = list.filter((s) => now - Date.parse(s.started_at) < 30 * 864e5);
    const sum = (arr, f) => arr.reduce((a, s) => a + (f(s) || 0), 0);
    const mi = sum(month, (s) => (s.distance_m || 0) / 1609.344);
    const gain_ft = sum(month, (s) => (s.elevation_gain_m || 0) * 3.28084);
    const kcal = sum(month, (s) => s.active_kcal || 0);
    const hours = sum(month, (s) => (s.duration_s || 0) / 3600);
    els.stats.innerHTML = `
      <div class="stat"><div class="k">last 30 days</div><div class="v">${month.length}<small> sessions</small></div></div>
      <div class="stat"><div class="k">distance</div><div class="v">${mi.toFixed(0)}<small> mi</small></div></div>
      <div class="stat"><div class="k">climbing</div><div class="v">${Math.round(gain_ft).toLocaleString()}<small> ft</small></div></div>
      <div class="stat"><div class="k">time moving</div><div class="v">${hours.toFixed(1)}<small> h</small></div></div>
      <div class="stat"><div class="k">energy</div><div class="v">${Math.round(kcal).toLocaleString()}<small> kcal</small></div></div>`;
  }

  function render_filters() {
    const types = ['all', ...new Set(sessions.map((s) => s.workout_type))];
    els.filters.innerHTML = types.map((t) =>
      `<button class="chip${t === active_type ? ' active' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('');
  }

  function render() {
    render_filters();
    const list = active_type === 'all' ? sessions : sessions.filter((s) => s.workout_type === active_type);
    render_stats(list);
    if (list.length === 0) {
      els.rides.innerHTML = '<div class="empty">No completed workouts yet — go ride, Astrid is watching the road for you.</div>';
      return;
    }
    els.rides.innerHTML = list.map(card).join('');
    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          observer.unobserve(e.target);
          void load_series(e.target);
        }
      }
    }, { rootMargin: '200px' });
    for (const el of els.rides.querySelectorAll('.ride')) {
      observer.observe(el);
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('a')) return;
        void toggle_detail(el);
      });
    }
  }

  els.filters.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.chip');
    if (!chip) return;
    active_type = chip.dataset.type;
    render();
  });

  async function boot() {
    try {
      const body = await api('/api/workout/sessions?limit=120');
      sessions = body.sessions || [];
      status(`${sessions.length} sessions`);
      render();
    } catch (err) {
      if (err && err.auth) {
        status('signed out', true);
        els.rides.innerHTML = '<div class="empty">Sign in at <a href="/app">/app</a> first, then come back.</div>';
      } else {
        status('failed to load', true);
        els.rides.innerHTML = `<div class="empty">Could not load the ride log — ${esc(err.message)}</div>`;
      }
    }
  }

  void boot();
})();
