/**
 * Hearth — unified web UI client.
 *
 * Single-file ES module. Talks to:
 *   - /api/specialists, /api/conversations, /api/proposals, /api/interrupts
 *     (the 6a "specialist runtime" routes)
 *   - /app/api/avatars, /app/api/library, /app/api/search, /app/api/chat,
 *     /app/api/specialists (the 6b "/app" routes)
 *   - /app/api/events (SSE)
 *
 * No framework, no bundler. Vanilla DOM + small render helpers.
 */

const SETTINGS_KEY = 'hearth-app-settings-v1';
const DEFAULT_SETTINGS = {
  theme: 'auto',
  density: 'comfortable',
  show_details: false,
  show_reasoning: false,
  ack_library: true,
  toast_proposals: true,
  toast_interrupts: true,
  default_landing: 'kate',
  show_surface_indicators: true,
  // Cozy themes only — visual cues for cross-specialist consults.
  // `consult_rail_glow`: receiver's row in the rail pulses a soft warm
  // glow while being consulted. `consult_thread_motes`: a stream of
  // glowing warm motes drifts from sender → receiver across the rail's
  // right gutter. Both opt-in; both no-ops outside gilded/frosted.
  consult_rail_glow: false,
  consult_thread_motes: false,
};

const state = {
  specialists: [],
  by_id: new Map(),
  active_id: null,
  conv_id: null,
  messages: [],
  proposals: [],
  recommendations: [],
  pending_count: 0,
  thinking_ids: new Set(),
  // Activity LEDs (live/rag/deep/tool). `activity`: specialist_id → Set of
  // the currently-on channels ('rag'|'deep'|'tool'); 'live' is driven by
  // thinking_ids. 'tool' rides tool_invoked/tool_completed SSE events.
  // `led_timers`: `${id}:${channel}` → off-timer id, for the min-flash that
  // keeps even an instant blip visible (~300ms). Pure client state.
  activity: new Map(),
  led_timers: new Map(),
  // Specialist-as-Room (layout A). `surface` is the active center surface
  // ('office' | 'chat'); `surface_pref` remembers the last surface per
  // specialist so a return visit lands where you left it; `pane_cache` holds
  // the last fetched pane document per specialist; `_pane_token` guards
  // against a stale fetch painting after a newer specialist switch.
  surface: 'chat',
  surface_pref: new Map(),
  pane_cache: new Map(),
  _pane_token: 0,
  // Live-streaming buffer for the active conversation. Populated by
  // `message_token` SSE events while a specialist's reply is in
  // flight; cleared when `specialist_thinking: finished` lands. The
  // persisted `message_added` event then renders the real bubble.
  streaming_text: '',
  streaming_stream_id: null,
  // Live-streaming thinking trace for the active conversation. Populated
  // by `message_thinking_token` SSE events when the specialist's role
  // has think:true. Rendered as a collapsible pill above the streaming
  // bubble — the user sees the model deliberating, which makes the
  // ~1-2s before content_delta starts feel productive instead of dead.
  // The pill stays expanded by default while no content_delta has
  // arrived yet; once visible content starts streaming it auto-collapses
  // so the eye lands on the answer. Cleared when thinking finishes.
  streaming_thinking: '',
  streaming_thinking_collapsed: false,
  // "New messages" divider per conversation. Keyed by conv_id; value
  // is the ts_last_visited snapshot from BEFORE the user opened the
  // thread. render_messages renders a divider just before the first
  // specialist message with ts > before_ts. Cleared when the user
  // sends in that conv (they've caught up) or after a fresh visit
  // with no actual new messages.
  unread_markers: new Map(),
  _pending_unread_marker_ts: null,
  // Live tool-call status for the active conversation. Set by
  // `tool_invoked` SSE events and cleared on `tool_completed` /
  // `message_added` / `specialist_thinking: finished`. Drives the
  // status line under the typing/streaming bubble so the user sees
  // what the specialist is doing during long tool rounds (otherwise
  // a slow web_fetch or large prompt-eval looks like a hang).
  active_tool: null, // { tool_name, input_summary, started_at } — kept for back-compat with one-line render paths; primary view is tool_chain below
  // Per-conversation tool-call history. Map<conv_id, entries[]>. Each
  // entry: { call_id, tool_name, input_summary, started_at, ended_at, ok }.
  // Populated by `tool_invoked` (push) and `tool_completed` (update by
  // call_id) — using the EVENT's conversation_id, not the current
  // active conv. That means switching between specialists preserves
  // each conversation's chain, so you can leave Iris consulting
  // Beatrice, peek at Marguerite, and come back to see Iris's chain
  // intact. Cleared per-conv when `specialist_thinking: finished` lands
  // for that conv. Never wiped on plain conv-switch.
  tool_chains: new Map(), // Map<conv_id, ToolChainEntry[]>
  // User toggle for showing all entries vs. collapsed (newest N).
  // Also per-conversation so each conv remembers its own expand state.
  tool_chains_expanded: new Map(), // Map<conv_id, boolean>
  // Map of conversation_id → array of pending followups. Each entry:
  // { followup_id, summary, fire_at_iso, anchor_message_id, specialist_id }.
  // Populated by `followup_scheduled` SSE, drained by
  // `followup_delivered` (or by the matching message landing).
  pending_followups: new Map(),
  // Map of conversation_id → array of pending question_sets surfaced by
  // the present_questions tool. Each entry is the row fetched from
  // /api/present-questions/:id. Populated by `questions_presented` SSE
  // and the per-conv refresh; drained by `questions_answered` and by
  // the resume turn's `message_added`.
  pending_question_sets: new Map(),
  // conv_id -> array of listing-draft rows (Linda's draft_listing cards).
  // Hydrated on conv load + on `listing_draft_created`; rendered anchored
  // under her message, mirroring pending_question_sets.
  listing_drafts: new Map(),
  // Sub-agent delegations (2026-07-14). delegation_id -> row from
  // GET /api/specialists/kate/delegations, hydrated on load + invalidated
  // by the content-free delegation_started/delegation_completed SSE events
  // (the events carry ids only; task text arrives via the cordoned GET).
  // Drives the topbar 🐝 badge + tray popover and the in-conversation
  // delegation strip.
  delegations: new Map(),
  settings: load_settings(),
  sse: null,
  sse_backoff: 1000,
  modal: null,
};

const root = document.getElementById('root');
const messages_el = document.getElementById('messages');

// ── Sticky-bottom helper ─────────────────────────────────────────────
// Standard streaming-chat pattern (Slack / ChatGPT / Discord): the
// view pins to the bottom while the user is at the bottom; the moment
// they scroll up, we stop yanking them back. A small "↓ new messages"
// pill appears when content is arriving below their viewport so they
// can opt back in. Crucially this lets a specialist keep streaming
// in the background while the user reads earlier content.
const BOTTOM_THRESHOLD_PX = 80;
const sticky = {
  pinned: true,
  is_user_scrolling: false,
  user_scroll_timer: null,
};
function is_near_bottom() {
  return (
    messages_el.scrollHeight - messages_el.scrollTop - messages_el.clientHeight
    < BOTTOM_THRESHOLD_PX
  );
}
function scroll_to_bottom() {
  messages_el.scrollTop = messages_el.scrollHeight;
  sticky.pinned = true;
  update_jump_pill();
}
function maybe_stick_to_bottom() {
  if (sticky.pinned) {
    messages_el.scrollTop = messages_el.scrollHeight;
  } else {
    update_jump_pill();
  }
}
let jump_pill_el = null;
function ensure_jump_pill() {
  if (jump_pill_el) return jump_pill_el;
  // The pill lives in a dedicated wrapper that's a sibling of
  // .messages (inside .center, before .composer), positioned with
  // `position: sticky` to the bottom-center of the conversation
  // pane via CSS. Wrapper guarantees we don't depend on composer
  // height, don't fight flex children, and never expand to full
  // width via some inherited button rule.
  const parent = messages_el.parentElement || document.body;
  const composer = parent.querySelector('.composer');
  const wrap = document.createElement('div');
  wrap.className = 'jump-to-latest-wrap';
  wrap.setAttribute('aria-hidden', 'true');
  jump_pill_el = document.createElement('button');
  jump_pill_el.type = 'button';
  jump_pill_el.className = 'jump-to-latest';
  jump_pill_el.setAttribute('aria-label', 'Scroll to latest');
  jump_pill_el.textContent = '↓ Jump to latest';
  jump_pill_el.hidden = true;
  jump_pill_el.addEventListener('click', scroll_to_bottom);
  wrap.appendChild(jump_pill_el);
  // Insert just before the composer so the wrapper's natural flow
  // position is the seam between the messages and the composer.
  if (composer && composer.parentElement === parent) {
    parent.insertBefore(wrap, composer);
  } else {
    parent.appendChild(wrap);
  }
  return jump_pill_el;
}
function update_jump_pill() {
  const pill = ensure_jump_pill();
  // Only meaningful while a specialist is mid-turn — otherwise there's
  // nothing arriving below the user's viewport and the pill is noise.
  const someone_thinking =
    state.active_id && state.thinking_ids && state.thinking_ids.has(state.active_id);
  pill.hidden = sticky.pinned || !someone_thinking;
}
messages_el.addEventListener(
  'scroll',
  () => {
    // Any scroll event re-evaluates: if user is back at bottom, pin
    // resumes; if they're scrolled away, release the pin. The
    // is_user_scrolling flag lets programmatic scrolls (e.g.
    // scroll_to_bottom) not flip this state mid-update.
    sticky.pinned = is_near_bottom();
    update_jump_pill();
  },
  { passive: true },
);
const empty_conv_el = document.getElementById('empty-conv');
const empty_greeting_el = document.getElementById('empty-greeting');
const composer_input = document.getElementById('composer-input');
const send_btn = document.getElementById('btn-send');
const stop_btn = document.getElementById('btn-stop');
const conv_avatar_el = document.getElementById('conv-avatar');
const conv_name_el = document.getElementById('conv-name');
const conv_role_el = document.getElementById('conv-role');
const conv_state_el = document.getElementById('conv-state');
const conv_leds_el = document.getElementById('conv-leds');
const right_content = document.getElementById('right-content');
const staff_list_el = document.getElementById('staff-list');
const queue_badge_el = document.getElementById('queue-badge');
const queue_tab_badge_el = document.getElementById('queue-tab-badge');
// `status_dot_el` is the legacy connection-status LED. It was
// replaced by the user-bubble in Phase 1e but the variable name is
// kept so the existing dataset assignment sites (data-state /
// data-bridge in handle_sse_event / handle_bridge_status) still
// function — they now write to the bubble's dataset instead.
const status_dot_el = document.getElementById('user-bubble');
const user_bubble_el = document.getElementById('user-bubble');
const user_bubble_avatar_el = document.getElementById('user-bubble-avatar');
const user_bubble_name_el = document.getElementById('user-bubble-name');
const user_menu_el = document.getElementById('user-menu');
const context_fill_el = document.getElementById('context-fill');
const context_fill_label_el = document.getElementById('context-fill-label');
const context_fill_bar_el = context_fill_el?.querySelector('.context-fill-bar') ?? null;
const context_fill_popover_el = document.getElementById('context-fill-popover');
// Cache the most recent context_usage so the popover can render
// without an extra fetch the moment it opens.
let _last_context_usage = null;

// data-state on the bubble drives the border color (connected /
// reconnecting / disconnected); the property name `data-conn-state`
// is what the CSS reads, but the SSE handler writes `data-state`
// for back-compat. Map between them via a tiny setter wrapper.
if (status_dot_el) {
  const _orig_state_set = Object.getOwnPropertyDescriptor(DOMStringMap.prototype, 'state');
  // No-op: DOMStringMap accessors can't be overridden cleanly. Easier
  // path: the few code sites that mutate `dataset.state` are listed
  // in handle_sse_event; we update them to write `connState` instead.
  void _orig_state_set;
}
// Currently signed-in user (populated by load_current_user() during boot).
// Used by Phase 2a route filters via `?user_id=` query params on the
// few routes that don't yet take user from session.
let current_user = null;

// ── Settings ─────────────────────────────────────────────────────────────

function load_settings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function save_settings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // ignore
  }
}

function apply_settings() {
  // Theme MUST live on the document root (<html>), not the inner #root div.
  // `html, body` set the actual background/color, and the var()-indirection
  // tokens (e.g. `--rail-bg: var(--surface)`) are declared on :root — both
  // resolve against the element they live on. Applying the theme to a deeper
  // element left <body>'s inherited `color` and `--rail-bg` frozen at the
  // base/OS theme, so when the chosen theme disagreed with the browser's
  // prefers-color-scheme (e.g. Windows "app mode: light" while the user
  // picked Dark), the dark surfaces kept dark inherited text (dark-on-dark)
  // and the rails kept the light surface (light panes). Density / detail
  // flags stay on #root — their selectors only style descendants.
  document.documentElement.dataset.theme = state.settings.theme;
  root.dataset.density = state.settings.density;
  root.dataset.showDetails = String(state.settings.show_details);
  root.dataset.showReasoning = String(state.settings.show_reasoning);
  // Mirror the active theme's color-scheme onto <html> (the real
  // document root). The per-theme `color-scheme` rules in app.css live
  // on this #root DIV, which is too deep for the UA's page-level
  // dark-support check — so Edge's Automatic Dark Mode would otherwise
  // force-darken our already-dark themes on top of themselves. 'auto'
  // defers to the OS via `light dark`; explicit dark themes pin 'dark'.
  document.documentElement.style.colorScheme =
    state.settings.theme === 'light' ? 'light'
    : state.settings.theme === 'auto' ? 'light dark'
    : 'dark'; // dark / gilded / frosted
  // PR1: gilded/frosted themes get liquid-glass refraction on their
  // panes. Re-install on every theme change so a user can flip
  // between themes without reloading.
  apply_liquid_glass();
  // PR1: gilded/frosted themes also pull the context-fill donut down
  // into the composer row (tying context-usage to the act of typing).
  relocate_context_fill();
}

// PR1: Relocate the context-fill donut between topbar-actions
// (default) and the composer (cozy themes). The popover positions
// itself via getBoundingClientRect at open-time so it follows
// whichever home the donut currently lives in.
function relocate_context_fill() {
  const fill = document.getElementById('context-fill');
  if (!fill) return;
  const isCozy = state.settings.theme === 'gilded' ||
                 state.settings.theme === 'frosted';
  const composer = document.querySelector('.composer');
  const actions  = document.querySelector('.topbar-actions');
  if (isCozy) {
    if (composer && fill.parentElement !== composer) {
      composer.insertBefore(fill, composer.firstChild);
    }
  } else {
    if (actions && fill.parentElement !== actions) {
      // restore to the original slot (before the New-conversation button)
      const newConv = document.getElementById('btn-new-conv');
      if (newConv && newConv.parentElement === actions) {
        actions.insertBefore(fill, newConv);
      } else {
        actions.insertBefore(fill, actions.firstChild);
      }
    }
  }
}

// ── PR1: Liquid-glass refraction (gilded + frosted themes only) ─────
// Ported from theme-poc-gilded-v2.html. Each .rail / .center pane
// gets its own SVG <filter> built from a procedurally-generated
// bezel-displacement map (refraction concentrated at the edges,
// neutral in the middle — like a real glass tile).
//
// Per-pane filters mean each filter's displacement map matches its
// own pixel size; ResizeObserver rebuilds them when the layout shifts.
const _lgPending = new WeakMap();
let _lgSeq = 0;

function _lgMakeProfile(thickness, samples = 128, power = 1.3) {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    out[i] = Math.pow(1 - t, power) * thickness;
  }
  return out;
}
function _lgDisplacementMap(w, h, radius, bezel, profile, maxDisp) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 128; d[i + 1] = 128; d[i + 2] = 0; d[i + 3] = 255;
  }
  const r = radius, rSq = r * r, r1Sq = (r + 1) ** 2;
  const rBSq = Math.max(r - bezel, 0) ** 2;
  const wB = w - r * 2, hB = h - r * 2, S = profile.length;
  for (let y1 = 0; y1 < h; y1++) {
    for (let x1 = 0; x1 < w; x1++) {
      const x = x1 < r ? x1 - r : x1 >= w - r ? x1 - r - wB : 0;
      const y = y1 < r ? y1 - r : y1 >= h - r ? y1 - r - hB : 0;
      const dSq = x * x + y * y;
      if (dSq > r1Sq || dSq < rBSq) continue;
      const dist = Math.sqrt(dSq);
      const fromSide = r - dist;
      const op = dSq < rSq
        ? 1
        : 1 - (dist - Math.sqrt(rSq)) / (Math.sqrt(r1Sq) - Math.sqrt(rSq));
      if (op <= 0 || dist === 0) continue;
      const cos = x / dist, sin = y / dist;
      const bi = Math.min(((fromSide / bezel) * S) | 0, S - 1);
      const disp = profile[bi] || 0;
      const dX = (-cos * disp) / maxDisp;
      const dY = (-sin * disp) / maxDisp;
      const idx = (y1 * w + x1) * 4;
      d[idx]     = (128 + dX * 127 * op + 0.5) | 0;
      d[idx + 1] = (128 + dY * 127 * op + 0.5) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}
function _lgInstall(el) {
  const w = el.offsetWidth, h = el.offsetHeight;
  if (w < 4 || h < 4) return;
  const radius     = 20;
  const bezel      = Math.min(36, Math.min(w, h) * 0.10);
  const thickness  = 22;
  const blur       = 6;
  const sat        = 1.5;
  const profile    = _lgMakeProfile(thickness);
  const maxDisp    = Math.max(...Array.from(profile).map(Math.abs)) || 1;
  const dispUrl    = _lgDisplacementMap(w, h, radius, bezel, profile, maxDisp);
  const scale      = maxDisp;

  let fid = el.dataset.lgId;
  const defs = document.getElementById('lg-defs');
  if (!fid) {
    fid = 'lg-' + (++_lgSeq);
    el.dataset.lgId = fid;
    defs.insertAdjacentHTML('beforeend',
      `<filter id="${fid}" x="0%" y="0%" width="100%" height="100%"
               color-interpolation-filters="sRGB"></filter>`);
  }
  document.getElementById(fid).innerHTML = `
    <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="src"/>
    <feImage href="${dispUrl}" x="0" y="0" width="${w}" height="${h}" result="map"/>
    <feDisplacementMap in="src" in2="map"
        scale="${scale}" xChannelSelector="R" yChannelSelector="G"
        result="bent"/>
    <feColorMatrix in="bent" type="saturate" values="${sat}"/>
  `;
  el.classList.add('lg-applied');
  el.style.backdropFilter       = `url(#${fid})`;
  el.style.webkitBackdropFilter = `blur(${blur}px) saturate(${sat})`;
}
function _lgQueue(el) {
  clearTimeout(_lgPending.get(el));
  _lgPending.set(el, setTimeout(() => _lgInstall(el), 80));
}
function _lgUninstall(el) {
  el.style.backdropFilter = '';
  el.style.webkitBackdropFilter = '';
  el.classList.remove('lg-applied');
}
let _lgObserver = null;
function apply_liquid_glass() {
  const useLg = state.settings.theme === 'gilded' ||
                state.settings.theme === 'frosted';
  const panes = document.querySelectorAll('.rail, .center');
  if (!useLg) {
    if (_lgObserver) _lgObserver.disconnect();
    panes.forEach(_lgUninstall);
    return;
  }
  if (!_lgObserver) {
    _lgObserver = new ResizeObserver(entries => {
      for (const e of entries) _lgQueue(e.target);
    });
  }
  panes.forEach(p => { _lgObserver.observe(p); _lgQueue(p); });
}

// PR1: --active-hue propagation. Each specialist's color identity
// drives focus rings, donut, bubble glow. Call this from any place
// the "active specialist" changes; defaults to Kate's hue.
const SPECIALIST_HUES = {
  kate: 34, cassandra: 268, mariah: 220, anya: 12, vivian: 142,
  trainer: 168, iris: 200, cordelia: 248, brigid: 22,
  eleanor: 88, marguerite: 320, maggie: 246, astrid: 8,
  critic: 292, // Vera — the code-critic subagent (delegation chips/tray)
};
function set_active_hue(specialist_id) {
  const hue = SPECIALIST_HUES[specialist_id] ?? 34;
  document.documentElement.style.setProperty('--active-hue', hue);
}

// ── Cross-specialist consult cues (opt-in; cozy themes only) ───────
// Two complementary visualizations of the consult lifecycle, both
// gated by settings + theme:
//   • consult_rail_glow:   receiver row pulses while consulted
//   • consult_thread_motes: stream of warm motes drifts across the
//     rail from sender's name → receiver's name
// Driven from tool_invoked / tool_completed SSE events. The peer id
// is extracted from input_summary (server format: "→ <id>") using
// the same regex render_tool_chain uses.
const CONSULT_MOTE_COUNT = 14;
let _consult_motes_pool = null;       // [{el, active, ...}]
let _consult_anim = null;
let _consult_in_flight = new Map();   // call_id → { peer_id, sender_id }

function _is_cozy_theme() {
  const t = state.settings.theme;
  return t === 'gilded' || t === 'frosted';
}
function _ensure_mote_pool() {
  if (_consult_motes_pool) return _consult_motes_pool;
  const g = document.getElementById('consult-thread-motes');
  if (!g) return null;
  _consult_motes_pool = [];
  for (let i = 0; i < CONSULT_MOTE_COUNT; i++) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('class', 'consult-thread-mote');
    c.setAttribute('cx', -10); c.setAttribute('cy', -10);
    c.setAttribute('r', 2);
    g.appendChild(c);
    _consult_motes_pool.push({ el: c, active: false, t: 0, life: 0, spawn: 0, size: 2, jitterSeed: 0 });
  }
  return _consult_motes_pool;
}
function _end_of_name(li, host) {
  // The .staff-card markup has the name+role in the 2nd child div.
  // Use that wrapper's right edge as the anchor.
  const meta = li?.children[1];
  if (!meta) return null;
  const hr = host.getBoundingClientRect();
  const mr = meta.getBoundingClientRect();
  return {
    x: Math.min(mr.right - hr.left + 8, hr.width - 22 - 16),
    y: mr.top + mr.height / 2 - hr.top,
  };
}
function _consult_path(a, b, paneW) {
  const gx = paneW - 22, r = 8;
  const dy = Math.sign(b.y - a.y) || 1;
  if (Math.abs(b.y - a.y) < 2) return `M${a.x},${a.y} L${b.x},${b.y}`;
  return [
    `M ${a.x} ${a.y}`,
    `H ${gx - r}`,
    `Q ${gx} ${a.y} ${gx} ${a.y + dy * r}`,
    `V ${b.y - dy * r}`,
    `Q ${gx} ${b.y} ${gx - r} ${b.y}`,
    `H ${b.x}`,
  ].join(' ');
}
function _resize_consult_svg() {
  const svg = document.getElementById('consult-thread-svg');
  const rail = document.getElementById('rail-left');
  if (!svg || !rail) return;
  const r = rail.getBoundingClientRect();
  svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
  svg.style.width = r.width + 'px'; svg.style.height = r.height + 'px';
}
window.addEventListener('resize', _resize_consult_svg);
function _start_consult_motes(senderLi, receiverLi) {
  const motes = _ensure_mote_pool();
  if (!motes) return null;
  _resize_consult_svg();
  const svg = document.getElementById('consult-thread-svg');
  const path = document.getElementById('consult-thread-path');
  const recv = document.getElementById('consult-thread-recv');
  const rail = document.getElementById('rail-left');
  const a = _end_of_name(senderLi, rail);
  const b = _end_of_name(receiverLi, rail);
  if (!a || !b) return null;
  const paneW = rail.getBoundingClientRect().width;
  path.setAttribute('d', _consult_path(a, b, paneW));
  const len = path.getTotalLength();
  recv.setAttribute('cx', b.x - 2);
  recv.setAttribute('cy', b.y);
  svg.classList.remove('drawing', 'holding', 'fading');
  void svg.getBoundingClientRect();
  svg.classList.add('drawing', 'holding');

  // reset pool
  motes.forEach(m => { m.active = false; m.el.style.opacity = 0; });
  let lastSpawn = 0;
  const spawnInterval = 420, moteLifeBase = 3100, peakOpacity = 0.70;
  const startTime = performance.now();
  let stopAt = Infinity;                                            // set on end

  const envelope = (t) => {
    if (t < 0.20) return (t / 0.20) * peakOpacity;
    if (t > 0.78) return Math.max(0, (1 - t) / 0.22) * peakOpacity;
    return peakOpacity;
  };
  const tick = (now) => {
    if (now <= stopAt && now - lastSpawn >= spawnInterval) {
      const m = motes.find(m => !m.active);
      if (m) {
        m.active = true; m.spawn = now;
        m.life = moteLifeBase * (0.85 + Math.random() * 0.30);
        m.size = 1.4 + Math.random() * 1.2;
        m.jitterSeed = Math.random() * 6.28;
        m.el.setAttribute('r', m.size.toFixed(2));
        lastSpawn = now;
      }
    }
    let any = false;
    for (const m of motes) {
      if (!m.active) continue;
      const age = now - m.spawn;
      const t = age / m.life;
      if (t >= 1) { m.active = false; m.el.style.opacity = 0; continue; }
      any = true;
      const pt = path.getPointAtLength(t * len);
      const ahead = path.getPointAtLength(Math.min(len, t * len + 0.6));
      const tx = ahead.x - pt.x, ty = ahead.y - pt.y;
      const tlen = Math.hypot(tx, ty) || 1;
      const nx = -ty / tlen, ny = tx / tlen;
      const wob = Math.sin((age / 520) + m.jitterSeed) * 1.4
                + Math.sin((age / 230) + m.jitterSeed * 2) * 0.5;
      m.el.setAttribute('cx', (pt.x + nx * wob).toFixed(2));
      m.el.setAttribute('cy', (pt.y + ny * wob).toFixed(2));
      m.el.style.opacity = envelope(t).toFixed(3);
    }
    if (now <= stopAt || any) {
      _consult_anim = requestAnimationFrame(tick);
    } else {
      svg.classList.remove('drawing', 'holding', 'fading');
      _consult_anim = null;
    }
  };
  _consult_anim = requestAnimationFrame(tick);

  // Return a "stop" handle the completion callback can invoke.
  return () => { stopAt = performance.now(); };
}
function fire_consult_thread_start(call_id, peer_id, sender_id) {
  if (!_is_cozy_theme()) return;
  if (!state.settings.consult_rail_glow && !state.settings.consult_thread_motes) return;
  const entry = { peer_id, sender_id, stop: null, recvCard: null };
  // Rail glow
  if (state.settings.consult_rail_glow) {
    const card = document.querySelector(`.staff-card[data-id="${CSS.escape(peer_id)}"]`);
    if (card) { card.classList.add('consulting-receiver'); entry.recvCard = card; }
  }
  // Motes
  if (state.settings.consult_thread_motes) {
    const senderCard = document.querySelector(`.staff-card[data-id="${CSS.escape(sender_id)}"]`);
    const receiverCard = document.querySelector(`.staff-card[data-id="${CSS.escape(peer_id)}"]`);
    if (senderCard && receiverCard) {
      entry.stop = _start_consult_motes(senderCard, receiverCard);
    }
  }
  _consult_in_flight.set(call_id, entry);
}
function fire_consult_thread_end(call_id) {
  const entry = _consult_in_flight.get(call_id);
  if (!entry) return;
  _consult_in_flight.delete(call_id);
  if (entry.recvCard) entry.recvCard.classList.remove('consulting-receiver');
  if (entry.stop) entry.stop();
}

// ── PR3: Bubble feedback trainer ────────────────────────────────────
// Hover an assistant bubble → 👍 / 👎 picker fades in below.
// 👍 immediately seals a chip + POSTs a positive note.
// 👎 opens an inline multi-choice ("Too long / Wrong tone / Inaccurate
//   / Wrong timing / Other…"). Other morphs to a free-text input for
//   nuanced reasons. Selection POSTs and seals a chip.
//
// The note is appended to Knowledge/<Specialist>/memory.md server-
// side via POST /app/api/feedback. Specialists read recent memory at
// every deliberation pass, so the signal closes the loop without
// any per-message LLM call.
const FEEDBACK_DOWN_OPTIONS = ['Too long', 'Wrong tone', 'Inaccurate', 'Wrong timing', 'Other…'];

function attach_feedback_trainer(bubble, m) {
  if (bubble.dataset.fbWired) return;
  bubble.dataset.fbWired = '1';
  // The tray (chips that stuck after votes) lives bottom-anchored.
  const tray = document.createElement('div');
  tray.className = 'fb-tray';
  bubble.appendChild(tray);
  // The picker is hidden until the bubble is hovered.
  const picker = document.createElement('div');
  picker.className = 'fb-picker';
  picker.innerHTML =
    `<button type="button" class="fb-pick-btn" data-kind="up"   title="Worked — train more like this">${_fb_svg('up')}</button>` +
    `<button type="button" class="fb-pick-btn" data-kind="down" title="Did not land — tell her why">${_fb_svg('down')}</button>`;
  bubble.appendChild(picker);
  picker.querySelector('[data-kind="up"]').addEventListener('click', (e) => {
    e.stopPropagation();
    _fb_chip(tray, 'up');
    _fb_post(m, 'up', null);
  });
  picker.querySelector('[data-kind="down"]').addEventListener('click', (e) => {
    e.stopPropagation();
    _fb_open_down(bubble, tray, m);
  });
}

function _fb_svg(kind) {
  return kind === 'up'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11v10H4a1 1 0 0 1-1-1V12a1 1 0 0 1 1-1h3zm2 0l4-7c.6-1 1.5-1.4 2.5-1 1 .4 1.5 1.4 1.3 2.4L16 9h4.5c1.4 0 2.5 1.3 2.2 2.7l-1.5 7c-.2 1.1-1.2 1.8-2.3 1.8H9V11z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 13V3h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-3zm-2 0l-4 7c-.6 1-1.5 1.4-2.5 1-1-.4-1.5-1.4-1.3-2.4L8 15H3.5C2.1 15 1 13.7 1.3 12.3l1.5-7C3 4.2 4 3.5 5.1 3.5H15v9.5z" fill="currentColor"/></svg>';
}

function _fb_chip(tray, kind) {
  let chip = tray.querySelector(`.fb-chip[data-kind="${kind}"]`);
  if (chip) {
    const cnt = chip.querySelector('.fb-chip-count');
    cnt.textContent = (+cnt.textContent + 1).toString();
    return;
  }
  chip = document.createElement('span');
  chip.className = 'fb-chip';
  chip.dataset.kind = kind;
  chip.innerHTML = `${_fb_svg(kind)}<span class="fb-chip-count">1</span>`;
  tray.appendChild(chip);
}

function _fb_open_down(bubble, tray, m) {
  if (bubble.querySelector('.fb-down')) return;
  const field = document.createElement('div');
  field.className = 'fb-down';
  field.innerHTML =
    `<span class="fb-down-prompt">What didn't work?</span>` +
    `<div class="fb-down-options"></div>` +
    `<button type="button" class="fb-down-skip" title="Skip">×</button>`;
  const opts = field.querySelector('.fb-down-options');
  for (const label of FEEDBACK_DOWN_OPTIONS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fb-down-opt';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (label === 'Other…') {
        // morph to free-text input
        opts.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'in your own words';
        opts.appendChild(input);
        input.focus();
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter')  _close(input.value.trim() || 'Other');
          if (ev.key === 'Escape') _close(null);
        });
      } else {
        _close(label);
      }
    });
    opts.appendChild(b);
  }
  field.querySelector('.fb-down-skip').addEventListener('click', () => _close(null));
  bubble.appendChild(field);
  function _close(reason) {
    _fb_chip(tray, 'down');
    _fb_post(m, 'down', reason);
    field.remove();
  }
}

async function _fb_post(m, kind, reason) {
  try {
    const excerpt = _fb_excerpt(m);
    await api('/app/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specialist_id: m.specialist_id,
        message_id:    m.id,
        kind,
        excerpt,
        reason: reason || undefined,
        conversation_id: state.conv_id || undefined,
      }),
    });
  } catch (err) {
    // Best-effort — surface a quiet toast if the post failed so the
    // user knows the chip didn't actually train her.
    if (typeof toast === 'function') {
      toast(`Feedback couldn't be saved: ${err.message || err}`, true);
    }
    console.warn('[feedback] post failed', err);
  }
}

function _fb_excerpt(m) {
  // Strip markdown to a short plain-text excerpt for the memory entry.
  const raw = (m.content_md || '').replace(/```[\s\S]*?```/g, ' [code] ');
  return raw.replace(/[#>*_`\[\]()-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

// PR2: provenance glyphs for the per-message origin (vault / inbox /
// memory). Tiny inline SVG paths; theme-gated to cozy themes via CSS.
// The render only happens when render_message sees m.provenance.
const PROV_GLYPHS = {
  vault:  { label: 'vault',  svg: '<circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/>' },
  inbox:  { label: 'inbox',  svg: '<path d="M4 7h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z M4 8l8 5 8-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' },
  memory: { label: 'memory', svg: '<path d="M9 4c-3 0-5 2-5 5 0 2 1 3 2 4 0 1.5-1 2.5-1 3 0 1 1 2 2 2 1.5 0 3-1 3.5-2 2 1 5 .5 6.5-2 1.5-2.5.5-6-2-7 .5-2-1-3-3-3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' },
};

// PR2: After a render, mark the LAST specialist bubble with .listening
// so it breathes for ~3 cycles ("she's listening for your reply").
// CSS rule is theme-gated — a no-op on light/dark/auto.
let _listening_timer = null;
function mark_last_listening() {
  if (!messages_el) return;
  messages_el.querySelectorAll('.bubble.listening')
    .forEach(b => b.classList.remove('listening'));
  if (_listening_timer) { clearTimeout(_listening_timer); _listening_timer = null; }
  const all = messages_el.querySelectorAll('.msg.specialist .bubble');
  const last = all[all.length - 1];
  if (!last) return;
  last.classList.add('listening');
  // 2.8s × 3 cycles (matches the CSS keyframe count). Plus 100ms
  // safety so the final frame settles before we strip the class.
  _listening_timer = setTimeout(() => {
    last.classList.remove('listening');
    _listening_timer = null;
  }, 2800 * 3 + 100);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

async function api(path, init) {
  const res = await fetch(path, init);
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON, e.g. SSE */ }
  if (!res.ok) {
    throw new Error((json && json.error) || `HTTP ${res.status}`);
  }
  return json;
}

function escape_html(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Mountain Time formatter — used once a message ages past ~24h. Below that
// threshold the friendlier "just now / 3m ago / 5h ago" reads better; once
// it's a day-plus old, an absolute timestamp is more useful than "6d ago".
const _denver_fmt_today = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  hour: 'numeric',
  minute: '2-digit',
});
const _denver_fmt_year = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const _denver_fmt_full = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function relative_time(iso) {
  const ts = new Date(iso).getTime();
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  // 1d+ → absolute Mountain Time. Use year only when it's a different year.
  const now = new Date();
  const then = new Date(iso);
  if (now.getFullYear() !== then.getFullYear()) {
    return _denver_fmt_full.format(then) + ' MT';
  }
  return _denver_fmt_year.format(then) + ' MT';
}

const _denver_day_key = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Denver',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
const _denver_day_label = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  weekday: 'long', month: 'long', day: 'numeric',
});

function day_key_for(iso) {
  return _denver_day_key.format(new Date(iso));
}

function day_label_for(iso) {
  const today = _denver_day_key.format(new Date());
  const yest_d = new Date(Date.now() - 86400_000);
  const yesterday = _denver_day_key.format(yest_d);
  const k = _denver_day_key.format(new Date(iso));
  if (k === today) return 'Today';
  if (k === yesterday) return 'Yesterday';
  return _denver_day_label.format(new Date(iso));
}

function day_separator(iso) {
  const el = document.createElement('div');
  el.className = 'day-separator';
  el.textContent = day_label_for(iso);
  return el;
}

// Markdown renderer. Backed by vendored `marked` (CommonMark + GFM:
// tables, fenced code, strikethrough, task lists, autolinks) and
// sanitized by `DOMPurify` to scrub script / event-handler / dangerous
// URL attacks before insertion into the DOM. Both globals are loaded
// from /app/assets/ in index.html before this module runs.
//
// `marked` configuration:
//   - gfm: true        — GitHub-Flavored Markdown (tables, etc.)
//   - breaks: true     — soft line breaks → <br/>, matching how
//                        specialists actually write replies
//   - mangle: false    — don't obscure email-addresses (legacy quirk)
//   - headerIds: false — avoid id attribute collisions across many bubbles
//
// DOMPurify configuration: defaults plus `target="_blank"` and
// `rel="noopener"` enforced on all anchor tags so user-rendered links
// always open in a new tab and can't grab the opener.
let _marked_configured = false;
function _ensure_marked_ready() {
  if (_marked_configured) return;
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return;
  marked.setOptions({
    gfm: true,
    breaks: true,
    mangle: false,
    headerIds: false,
  });
  // Force anchor safety on every rendered link.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  _marked_configured = true;
}

function render_md(md) {
  if (!md) return '';
  // Fallback for the brief window after page load if marked failed to
  // load — render plain escaped text rather than nothing.
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    return `<p>${escape_html(md).replace(/\n/g, '<br/>')}</p>`;
  }
  _ensure_marked_ready();
  const raw = marked.parse(md);
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

/**
 * Post-process rendered markdown to add Discord-style code-block
 * affordances: a header strip with the language label + a Copy button.
 * No syntax highlighting (would need a vendored library); the win
 * here is "I can grab this code without selecting" — the highest-
 * value piece of the Discord experience for code shares.
 *
 * Idempotent: skips blocks already enhanced (marked via data attr).
 */
function enhance_code_blocks(container) {
  if (!container) return;
  const pres = container.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.dataset.enhanced === '1') continue;
    const code = pre.querySelector('code');
    if (!code) continue;
    // Extract the language hint marked left on the code tag (e.g.
    // "language-python"). Show "code" if no language was given.
    const lang_class = Array.from(code.classList).find((c) => c.startsWith('language-'));
    const lang = lang_class ? lang_class.slice('language-'.length) : 'code';
    const header = document.createElement('div');
    header.className = 'code-block-header';
    const label = document.createElement('span');
    label.className = 'code-block-lang';
    label.textContent = lang;
    const copy_btn = document.createElement('button');
    copy_btn.type = 'button';
    copy_btn.className = 'code-block-copy';
    copy_btn.innerHTML = '<span aria-hidden="true">⧉</span> Copy';
    copy_btn.addEventListener('click', async () => {
      const text = code.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        copy_btn.classList.add('copied');
        copy_btn.innerHTML = '<span aria-hidden="true">✓</span> Copied';
        setTimeout(() => {
          copy_btn.classList.remove('copied');
          copy_btn.innerHTML = '<span aria-hidden="true">⧉</span> Copy';
        }, 1600);
      } catch {
        copy_btn.textContent = 'Copy failed';
        setTimeout(() => { copy_btn.innerHTML = '<span aria-hidden="true">⧉</span> Copy'; }, 1600);
      }
    });
    header.appendChild(label);
    header.appendChild(copy_btn);
    pre.classList.add('code-block');
    pre.insertBefore(header, pre.firstChild);
    pre.dataset.enhanced = '1';
  }
}

// ── Initial load ─────────────────────────────────────────────────────────

async function bootstrap() {
  apply_settings();
  attach_global_handlers();
  attach_tab_handlers();
  attach_user_menu_handlers();
  // Resolve the current user FIRST — any 401 here means the auth
  // middleware didn't authenticate this browser, so we redirect to
  // the login page. Without this guard, downstream /api calls would
  // each 401 individually and the UI would render half-empty before
  // the user notices.
  const me = await load_current_user();
  if (!me) {
    location.href = '/app/login.html?from=' + encodeURIComponent(location.pathname + location.search);
    return;
  }
  render_user_bubble();
  const { specialists } = await api('/api/specialists');
  state.specialists = specialists;
  for (const s of specialists) state.by_id.set(s.id, s);
  render_staff();

  const landing = state.settings.default_landing === 'last'
    ? localStorage.getItem('hearth-last-specialist') || 'kate'
    : 'kate';
  await switch_specialist(landing || 'kate');

  open_sse();
  refresh_proposals();
  refresh_delegations();
  attach_fire_dock();
  void fire_refresh();
}

// ── User bubble + menu ─────────────────────────────────────────────────

async function load_current_user() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const j = await res.json();
    current_user = j.user || null;
    return current_user;
  } catch {
    return null;
  }
}

function render_user_bubble() {
  if (!user_bubble_el || !current_user) return;
  user_bubble_name_el.textContent = current_user.display_name || current_user.id;
  // Per-user avatar lookup: a /app/api/users/:id/avatar route is the
  // long-term home, but until that lands we fall back to a stable
  // initial-bubble rendered as a data URI. Keeps the bubble visually
  // anchored even on a fresh install.
  user_bubble_avatar_el.src = _user_initial_svg(current_user.display_name || current_user.id);
}

function _user_initial_svg(name) {
  const initial = String(name).trim().charAt(0).toUpperCase() || '?';
  // Hash-based hue so each user gets a stable distinct color.
  let h = 0;
  for (const c of name) h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  const hue = Math.abs(h) % 360;
  const fg = `hsl(${hue} 38% 52%)`;
  const bg = `hsl(${hue} 38% 18%)`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" fill="${bg}"/>` +
    `<text x="32" y="40" text-anchor="middle" font-family="Inter, system-ui, sans-serif" ` +
      `font-size="28" font-weight="600" fill="${fg}">${initial}</text>` +
    `</svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function attach_user_menu_handlers() {
  if (!user_bubble_el) return;
  user_bubble_el.addEventListener('click', toggle_user_menu);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !user_menu_el.hidden) close_user_menu();
  });
  // Dismiss on outside click.
  document.addEventListener('mousedown', (ev) => {
    if (user_menu_el.hidden) return;
    if (user_bubble_el.contains(ev.target) || user_menu_el.contains(ev.target)) return;
    close_user_menu();
  });
}

function toggle_user_menu() {
  if (!user_menu_el.hidden) { close_user_menu(); return; }
  if (!current_user) return;
  // Build menu lazily so theme/role changes reflect on each open.
  user_menu_el.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'user-menu-header';
  header.innerHTML =
    `<img src="${user_bubble_avatar_el.src}" alt="" />` +
    `<div class="user-menu-header-text">` +
      `<span class="user-menu-header-name">${escape_html(current_user.display_name || current_user.id)}</span>` +
      `<span class="user-menu-header-role">${escape_html(current_user.role || 'user')}</span>` +
    `</div>`;
  user_menu_el.appendChild(header);

  const settings_row = document.createElement('button');
  settings_row.type = 'button';
  settings_row.className = 'user-menu-row';
  settings_row.setAttribute('role', 'menuitem');
  settings_row.innerHTML =
    `<span class="user-menu-row-icon" aria-hidden="true">⚙</span>` +
    `<span>Settings</span>`;
  settings_row.addEventListener('click', () => {
    close_user_menu();
    open_settings();
  });
  user_menu_el.appendChild(settings_row);

  // Account row: change password. Always available (whether the user
  // is in bootstrap state or fully set up). Opens a small dynamic
  // modal — current_password + new_password (rotation mode) or just
  // new_password (bootstrap mode, server-detected).
  const change_pw_row = document.createElement('button');
  change_pw_row.type = 'button';
  change_pw_row.className = 'user-menu-row';
  change_pw_row.setAttribute('role', 'menuitem');
  change_pw_row.innerHTML =
    `<span class="user-menu-row-icon" aria-hidden="true">🔑</span>` +
    `<span>Change password…</span>`;
  change_pw_row.addEventListener('click', () => {
    close_user_menu();
    open_change_password_modal();
  });
  user_menu_el.appendChild(change_pw_row);

  // PIN row: label flips between "Set PIN" (no PIN yet — bootstrap or
  // post-clear) and "Change PIN" (existing PIN). The endpoint handles
  // both via /auth/set_pin — bootstrap mode skips step-up, rotation
  // mode requires it (UI prompts for old PIN first when needed).
  const has_pin = current_user.has_pin === true ||
    (current_user.bootstrap && current_user.bootstrap.must_set_pin === false);
  const pin_row = document.createElement('button');
  pin_row.type = 'button';
  pin_row.className = 'user-menu-row';
  pin_row.setAttribute('role', 'menuitem');
  pin_row.innerHTML =
    `<span class="user-menu-row-icon" aria-hidden="true">🔢</span>` +
    `<span>${has_pin ? 'Change PIN…' : 'Set PIN…'}</span>`;
  pin_row.addEventListener('click', () => {
    close_user_menu();
    open_set_pin_modal({ rotation: has_pin });
  });
  user_menu_el.appendChild(pin_row);

  const divider = document.createElement('div');
  divider.className = 'user-menu-divider';
  user_menu_el.appendChild(divider);

  const switch_row = document.createElement('button');
  switch_row.type = 'button';
  switch_row.className = 'user-menu-row';
  switch_row.setAttribute('role', 'menuitem');
  switch_row.innerHTML =
    `<span class="user-menu-row-icon" aria-hidden="true">↺</span>` +
    `<span>Switch user…</span>`;
  switch_row.addEventListener('click', logout_and_pick_user);
  user_menu_el.appendChild(switch_row);

  const logout_row = document.createElement('button');
  logout_row.type = 'button';
  logout_row.className = 'user-menu-row user-menu-row-danger';
  logout_row.setAttribute('role', 'menuitem');
  logout_row.innerHTML =
    `<span class="user-menu-row-icon" aria-hidden="true">🔒</span>` +
    `<span>Lock screen</span>`;
  logout_row.addEventListener('click', logout_and_pick_user);
  user_menu_el.appendChild(logout_row);

  // Position relative to the bubble — anchored bottom-right of the
  // bubble, expanding downward.
  const rect = user_bubble_el.getBoundingClientRect();
  user_menu_el.style.top = `${rect.bottom + 6}px`;
  user_menu_el.style.right = `${window.innerWidth - rect.right}px`;
  user_menu_el.style.left = 'auto';
  user_menu_el.hidden = false;
  user_bubble_el.setAttribute('aria-expanded', 'true');
}

function close_user_menu() {
  user_menu_el.hidden = true;
  user_bubble_el.setAttribute('aria-expanded', 'false');
}

// ── Context-fill donut ────────────────────────────────────────────────
//
// Pie indicator next to the + button. Reads
// /api/conversations/:id/context_usage which returns the last turn's
// tokens_in vs. the model ceiling. Refreshed on conv switch + on
// every message_added SSE for the active conv.
//
// Hover  → native tooltip with the precise numbers + model.
// Click  → popover with %, tokens/max, model, last-measured time,
//          contextual hint (e.g. "near full"), and a "Start new
//          conversation" button.

function _state_for(info) {
  if (!info || !info.tokens_used) return 'idle';
  const r = info.ratio || 0;
  if (r >= 0.85) return 'urgent';
  if (r >= 0.60) return 'warn';
  return 'ok';
}
function _fmt_k(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

async function refresh_context_fill() {
  if (!context_fill_el) return;
  if (!state.conv_id) {
    _last_context_usage = { tokens_used: 0, max_tokens: 0, ratio: 0 };
    render_context_fill(_last_context_usage);
    if (!context_fill_popover_el.hidden) render_context_fill_popover();
    return;
  }
  try {
    const r = await api(`/api/conversations/${state.conv_id}/context_usage`);
    _last_context_usage = r;
    render_context_fill(r);
  } catch {
    _last_context_usage = { tokens_used: 0, max_tokens: 0, ratio: 0 };
    render_context_fill(_last_context_usage);
  }
  // Re-render the popover live if it's open while the SSE fires.
  if (!context_fill_popover_el.hidden) render_context_fill_popover();
}

function render_context_fill(info) {
  if (!context_fill_el || !context_fill_bar_el) return;
  const ratio = Math.max(0, Math.min(1, info.ratio || 0));
  const pct = Math.round(ratio * 100);
  // SVG pathLength=100 → dasharray "<filled> 100" fills proportionally.
  context_fill_bar_el.setAttribute('stroke-dasharray', `${ratio * 100} 100`);
  context_fill_el.dataset.state = _state_for(info);
  context_fill_label_el.textContent = info.tokens_used > 0 ? `${pct}%` : '—';
  const model_str = info.model ? ` · ${info.model}` : '';
  context_fill_el.title =
    info.tokens_used > 0
      ? `Context: ${info.tokens_used.toLocaleString()} / ${info.max_tokens.toLocaleString()} tokens (${pct}%)${model_str} — click for details`
      : 'Context window — no turns yet — click for details';
}

function _hint_for(info) {
  if (!info || !info.tokens_used) {
    return {
      level: 'ok',
      text: 'No turns yet — the donut will fill as the conversation grows.',
    };
  }
  const r = info.ratio || 0;
  const free = Math.max(0, info.max_tokens - info.tokens_used);
  if (r >= 0.85) {
    return {
      level: 'urgent',
      text: `Near the model ceiling (~${_fmt_k(free)} tokens left). A few more turns risks the request being truncated or refused. Consider starting a new conversation.`,
    };
  }
  if (r >= 0.60) {
    return {
      level: 'warn',
      text: `Getting full (~${_fmt_k(free)} tokens left). Plenty of room for now, but watch the donut color.`,
    };
  }
  return {
    level: 'ok',
    text: `Plenty of room — ${_fmt_k(free)} tokens free.`,
  };
}

function render_context_fill_popover() {
  const pop = context_fill_popover_el;
  if (!pop || !_last_context_usage) return;
  const info = _last_context_usage;
  const ratio = Math.max(0, Math.min(1, info.ratio || 0));
  const pct = Math.round(ratio * 100);
  const st = _state_for(info);
  const hint = _hint_for(info);
  const measured = info.last_turn_at ? relative_time(info.last_turn_at) : 'never';
  const pct_class = st === 'urgent' ? 'urgent' : st === 'warn' ? 'warn' : '';

  pop.innerHTML =
    `<h4>Context window</h4>` +
    `<div class="cfp-pct ${pct_class}">${info.tokens_used > 0 ? pct + '%' : '—'}</div>` +
    `<div class="cfp-numbers">` +
      (info.tokens_used > 0
        ? `${info.tokens_used.toLocaleString()} / ${info.max_tokens.toLocaleString()} tokens`
        : `0 / ${(info.max_tokens || 0).toLocaleString()} tokens`) +
    `</div>` +
    `<div class="cfp-progress">` +
      `<div class="cfp-progress-bar ${pct_class}" style="width:${pct}%"></div>` +
    `</div>` +
    `<dl class="cfp-rows">` +
      (info.model ? `<dt>Model</dt><dd>${escape_html(info.model)}</dd>` : '') +
      `<dt>Measured</dt><dd>${escape_html(measured)}</dd>` +
      (state.active_id ? `<dt>Specialist</dt><dd>${escape_html(state.by_id.get(state.active_id)?.name || state.active_id)}</dd>` : '') +
    `</dl>` +
    `<div class="cfp-hint ${hint.level === 'ok' ? '' : hint.level}">${escape_html(hint.text)}</div>` +
    `<button type="button" class="cfp-action ${st === 'urgent' ? 'primary' : ''}" id="cfp-new-conv">` +
      `Start new conversation` +
    `</button>`;

  // Position under the donut.
  const rect = context_fill_el.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  pop.style.left = 'auto';
  pop.hidden = false;
  context_fill_el.setAttribute('aria-expanded', 'true');

  pop.querySelector('#cfp-new-conv').addEventListener('click', () => {
    close_context_fill_popover();
    start_new_conversation();
  });
}

function close_context_fill_popover() {
  context_fill_popover_el.hidden = true;
  context_fill_el.setAttribute('aria-expanded', 'false');
}

if (context_fill_el) {
  context_fill_el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!context_fill_popover_el.hidden) {
      close_context_fill_popover();
      return;
    }
    // Open: render with whatever we last fetched. Then kick a fresh
    // fetch so a long-stale value (e.g. user just resumed the tab)
    // gets corrected within a tick.
    render_context_fill_popover();
    refresh_context_fill();
  });
  document.addEventListener('mousedown', (ev) => {
    if (context_fill_popover_el.hidden) return;
    if (context_fill_el.contains(ev.target) || context_fill_popover_el.contains(ev.target)) return;
    close_context_fill_popover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !context_fill_popover_el.hidden) close_context_fill_popover();
  });
}

// ── Sub-agent tray + in-conversation delegation strip (2026-07-14) ───────
// Kate's crew, live. The SSE delegation_* events are content-free
// invalidation triggers; task text + digest previews come from the
// cordoned GET /api/specialists/kate/delegations. The 🐝 badge counts
// RUNNING delegations; the popover lists recent ones; the strip shows the
// current conversation's active/just-finished hand-offs.
const btn_subagents_el = document.getElementById('btn-subagents');
const subagents_badge_el = document.getElementById('subagents-badge');
const subagents_popover_el = document.getElementById('subagents-popover');

let _delegation_tick = null;

async function refresh_delegations() {
  try {
    const data = await api('/api/specialists/kate/delegations?limit=15');
    state.delegations.clear();
    for (const d of data.delegations || []) state.delegations.set(d.id, d);
  } catch {
    /* the tray is a nicety — keep last-known rows on a fetch miss */
  }
  render_subagents_badge();
  render_delegation_strip();
  if (subagents_popover_el && !subagents_popover_el.hidden) render_subagents_popover();
  // While anything runs, keep elapsed times moving (and catch a missed
  // completion event); go idle otherwise.
  const running = _running_delegations().length > 0;
  if (running && !_delegation_tick) {
    _delegation_tick = setInterval(refresh_delegations, 15_000);
  } else if (!running && _delegation_tick) {
    clearInterval(_delegation_tick);
    _delegation_tick = null;
  }
}

function _running_delegations() {
  return [...state.delegations.values()].filter((d) => d.status === 'running');
}

function render_subagents_badge() {
  if (!subagents_badge_el) return;
  const n = _running_delegations().length;
  subagents_badge_el.textContent = String(n);
  subagents_badge_el.hidden = n === 0;
  if (btn_subagents_el) btn_subagents_el.classList.toggle('subagents-active', n > 0);
}

function _delegation_elapsed(d) {
  const start = new Date(d.created_at).getTime();
  const end = d.completed_at ? new Date(d.completed_at).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

const _DELEGATION_GLYPH = { running: '◌', done: '✓', failed: '✕' };

function render_subagents_popover() {
  const pop = subagents_popover_el;
  if (!pop) return;
  const rows = [...state.delegations.values()];
  const body =
    rows.length === 0
      ? `<div class="sap-empty">No sub-agent work yet. Kate spins these off when she hands a task to a teammate.</div>`
      : rows
          .map((d) => {
            const hue = SPECIALIST_HUES[d.profile_id] ?? 200;
            const glyph = _DELEGATION_GLYPH[d.status] || '◌';
            const digest =
              d.status === 'done' && d.digest_preview
                ? `<div class="sap-digest">${escape_html(d.digest_preview.slice(0, 180))}${d.digest_preview.length > 180 ? '…' : ''}</div>`
                : d.status === 'failed' && d.error
                  ? `<div class="sap-digest sap-err">${escape_html(d.error.slice(0, 160))}</div>`
                  : '';
            return (
              `<div class="sap-row ${d.status}" style="--sap-hue:${hue}">` +
              `<img class="sap-avatar" src="/app/api/avatars/${encodeURIComponent(d.profile_id)}" alt="" />` +
              `<div class="sap-main">` +
              `<div class="sap-head">` +
              `<span class="sap-name">${escape_html(d.profile_name || d.profile_id)}</span>` +
              `<span class="sap-status ${d.status}">${glyph} ${escape_html(d.status)}</span>` +
              `<span class="sap-elapsed">${_delegation_elapsed(d)}</span>` +
              `</div>` +
              `<div class="sap-task">${escape_html(d.task)}</div>` +
              digest +
              `</div>` +
              `</div>`
            );
          })
          .join('');
  pop.innerHTML = `<h4>Sub-agents</h4>${body}`;
  const rect = btn_subagents_el.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  pop.style.left = 'auto';
  pop.hidden = false;
  btn_subagents_el.setAttribute('aria-expanded', 'true');
}

function close_subagents_popover() {
  if (!subagents_popover_el) return;
  subagents_popover_el.hidden = true;
  if (btn_subagents_el) btn_subagents_el.setAttribute('aria-expanded', 'false');
}

if (btn_subagents_el) {
  btn_subagents_el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!subagents_popover_el.hidden) {
      close_subagents_popover();
      return;
    }
    render_subagents_popover();
    refresh_delegations();
  });
  document.addEventListener('mousedown', (ev) => {
    if (subagents_popover_el.hidden) return;
    if (btn_subagents_el.contains(ev.target) || subagents_popover_el.contains(ev.target)) return;
    close_subagents_popover();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !subagents_popover_el.hidden) close_subagents_popover();
  });
}

// The in-conversation strip: one compact chip per delegation tied to THIS
// conversation — running ones pulse; finished ones linger five minutes
// (the actual report-back lands as a normal message and supersedes the
// chip). Re-attached at the end of render_messages() like the typing
// bubble, since innerHTML='' wipes it.
function render_delegation_strip() {
  if (!messages_el) return;
  const existing = messages_el.querySelector('.delegation-strip');
  const now = Date.now();
  const rows = [...state.delegations.values()].filter(
    (d) =>
      d.conversation_id === state.conv_id &&
      (d.status === 'running' ||
        (d.completed_at && now - new Date(d.completed_at).getTime() < 5 * 60_000)),
  );
  if (rows.length === 0 || !state.conv_id) {
    if (existing) existing.remove();
    return;
  }
  const strip = existing || document.createElement('div');
  strip.className = 'delegation-strip';
  strip.innerHTML = rows
    .map((d) => {
      const hue = SPECIALIST_HUES[d.profile_id] ?? 200;
      const name = escape_html(d.profile_name || d.profile_id);
      if (d.status === 'running') {
        return (
          `<div class="delegation-chip running" style="--chip-hue:${hue}" title="${escape_html(d.task)}">` +
          `<span class="chip-dot"></span>${name} is working in the background` +
          `<span class="chip-elapsed">${_delegation_elapsed(d)}</span></div>`
        );
      }
      if (d.status === 'failed') {
        return (
          `<div class="delegation-chip failed" style="--chip-hue:${hue}" title="${escape_html(d.error || '')}">` +
          `✕ ${name}'s hand-off failed — Kate will follow up</div>`
        );
      }
      return (
        `<div class="delegation-chip done" style="--chip-hue:${hue}" title="${escape_html(d.task)}">` +
        `✓ ${name} finished — Kate will report back here</div>`
      );
    })
    .join('');
  if (!existing) messages_el.appendChild(strip);
}

async function logout_and_pick_user() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch { /* even on network failure, going to login clears state */ }
  location.href = '/app/login.html';
}

// ── Staff rail ───────────────────────────────────────────────────────────

// Mirrors the COLORS map in src/app/routes/avatars.ts so the chip in the
// rail matches the fallback SVG color in the topbar avatar. Unknown ids
// fall back to the accent.
const STAFF_COLORS = {
  kate: '#7f5af0',
  vivian: '#5b8e7d',
  anya: '#c87065',
  eleanor: '#7a9b58',
  marguerite: '#9a7aa0',
  iris: '#5e8aa8',
  cassandra: '#a87d4a',
};

// Hash-based color for hires whose id isn't in STAFF_COLORS — keeps each
// new specialist visually distinct without needing config.
function _hash_color(id) {
  let h = 0;
  for (const ch of id) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 38% 52%)`;
}

function staff_color(id) {
  return STAFF_COLORS[id] || _hash_color(id);
}

let _staff_initials_cache = { signature: '', map: new Map() };

// Compute initials for the full roster with collision detection — if
// two specialists share a first letter, both bump to two letters. With
// a third collision on the two-letter form, keep walking until unique.
function compute_initials(specialists) {
  const sig = specialists.map((s) => `${s.id}:${s.name}`).join('|');
  if (_staff_initials_cache.signature === sig) return _staff_initials_cache.map;
  const map = new Map();
  const used = new Map(); // initials -> first-claimant id
  const want = (s, n) => (s.name || s.id || '?').replace(/\s+/g, '').slice(0, n).toUpperCase();
  // First pass: try single letter.
  for (const s of specialists) {
    const one = want(s, 1);
    if (!used.has(one)) {
      used.set(one, s.id);
      map.set(s.id, one);
    } else {
      map.set(s.id, null);
    }
  }
  // Second pass: collisions take two letters. If a one-letter winner
  // collides with a two-letter newcomer's prefix, promote them all.
  for (const s of specialists) {
    if (map.get(s.id) !== null) continue;
    let n = 2;
    let init = want(s, n);
    while (used.has(init) && used.get(init) !== s.id && n < 6) {
      n += 1;
      init = want(s, n);
    }
    used.set(init, s.id);
    map.set(s.id, init);
  }
  _staff_initials_cache = { signature: sig, map };
  return map;
}

// True when `specialist_id` has at least one unanswered present_questions
// set in local state — drives the rail "?" badge so a specialist waiting
// on your answer is visible even when you're on another tab. Derived from
// pending_question_sets (keyed by conversation_id; each row carries its
// own specialist_id) so there's a single source of truth.
function specialist_has_pending_questions(specialist_id) {
  for (const sets of state.pending_question_sets.values()) {
    if (
      Array.isArray(sets) &&
      sets.some(
        (s) => s && s.specialist_id === specialist_id && (s.status || 'pending') === 'pending',
      )
    ) {
      return true;
    }
  }
  return false;
}

function render_staff() {
  staff_list_el.innerHTML = '';
  const initials = compute_initials(state.specialists);
  // Kate first.
  const kate = state.specialists.find((s) => s.id === 'kate');
  if (kate) staff_list_el.appendChild(staff_card(kate, { kate: true, separator: true, initials }));
  // Others in declared order.
  for (const s of state.specialists) {
    if (s.id === 'kate') continue;
    staff_list_el.appendChild(staff_card(s, { initials }));
  }
}

function staff_card(s, opts = {}) {
  const btn = document.createElement('button');
  btn.className = 'staff-card' + (opts.kate ? ' kate' : '') + (opts.separator ? ' separator-after' : '');
  btn.dataset.id = s.id;
  if (s.id === state.active_id) btn.classList.add('active');
  if (state.thinking_ids.has(s.id)) btn.classList.add('thinking');

  const initials_map = opts.initials || compute_initials(state.specialists);
  const initials = initials_map.get(s.id) || (s.name || s.id || '?')[0].toUpperCase();
  const avatar = document.createElement('div');
  avatar.className = 'staff-avatar' + (initials.length > 1 ? ' two-letter' : '');
  avatar.style.setProperty('--specialist-color', staff_color(s.id));
  avatar.textContent = initials;
  avatar.setAttribute('aria-label', s.name);

  const meta = document.createElement('div');
  meta.style.minWidth = '0';
  // The .staff-typing dots are part of the DOM at all times — CSS
  // shows them only when the parent .staff-card has the .thinking
  // class (toggled by update_staff_thinking). No JS lifecycle needed.
  meta.innerHTML = `
    <div class="staff-name">${escape_html(s.name)}<span class="leds staff-leds" aria-hidden="true"><i class="led led-live" title="Generating reply"></i><i class="led led-rag" title="Retrieving / consulting"></i><i class="led led-deep" title="Deep-think on the Spark"></i><i class="led led-tool" title="Using a tool"></i></span><span class="staff-typing" aria-hidden="true"><span></span><span></span><span></span></span></div>
    <div class="staff-role">${escape_html(s.role)}</div>
  `;

  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.alignItems = 'center';
  right.style.gap = '6px';
  const unread = (s.unread_since_visit || 0) | 0;
  const has_unread = unread > 0 && s.id !== state.active_id;
  const unread_label = unread > 99 ? '99+' : String(unread);
  // Pending present_questions waiting on the user. Hidden for the active
  // specialist (you see the form inline there); shown on every other row
  // so a specialist's unanswered questions never get lost off-tab.
  const has_pending_q = s.id !== state.active_id && specialist_has_pending_questions(s.id);
  right.innerHTML =
    (has_pending_q
      ? `<span class="staff-pending-q" title="${escape_html(s.name)} is waiting on your answer — open their chat">?</span>`
      : '') +
    (has_unread
      ? `<span class="staff-unread" title="${unread} new message${unread === 1 ? '' : 's'} since you last opened ${escape_html(s.name)}'s thread">${unread_label}</span>`
      : '') +
    (has_pane(s)
      ? `<span class="staff-office-dot" title="${escape_html(s.name)} has an office"></span>`
      : '') +
    `<span class="staff-state-dot" data-state="ready"></span>`;

  btn.appendChild(avatar);
  btn.appendChild(meta);
  btn.appendChild(right);
  btn.addEventListener('click', () => switch_specialist(s.id));
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    open_context_menu(s.id);
  });
  let press_timer = null;
  btn.addEventListener('touchstart', () => {
    press_timer = setTimeout(() => open_context_menu(s.id), 600);
  });
  btn.addEventListener('touchend', () => {
    if (press_timer) clearTimeout(press_timer);
  });
  return btn;
}

/**
 * Refresh the topbar trust meter for the active specialist. The meter
 * lives in the conv-name row and renders the per-specialist authenticity
 * score (0-100 from Mariah's daily scan_specialist_authenticity) as
 * three signal bars — high ≥85 (all lit), medium 70-84 (2 lit), low <70
 * (1 amber bar lit). Hidden entirely when no score has been computed
 * yet (new hire, never scanned). The same thresholds drive
 * config/autonomy.yaml's graduation gate, so the bar count mirrors
 * whether a specialist can earn more autonomy right now.
 */
function update_trust_meter(spec) {
  const el = document.getElementById('trust-meter');
  if (!el) return;
  const text_el = el.querySelector('.trust-text');
  const auth = spec && spec.authenticity;
  if (!auth || typeof auth.score !== 'number') {
    el.classList.remove('has-score');
    el.removeAttribute('data-trust');
    if (text_el) text_el.textContent = 'trust · —';
    el.title = 'Authenticity score not yet computed for this specialist.';
    return;
  }
  const score = auth.score | 0;
  const tier = score >= 85 ? 'high' : score >= 70 ? 'medium' : 'low';
  el.dataset.trust = tier;
  el.classList.add('has-score');
  if (text_el) text_el.textContent = `trust · ${tier}`;
  const turns = auth.turns_in_window;
  const ts = auth.ts_computed;
  el.title =
    `Authenticity ${score}/100` +
    (typeof turns === 'number'
      ? ` over ${turns} recent turn${turns === 1 ? '' : 's'}`
      : '') +
    (ts ? ` (last computed ${new Date(ts).toLocaleString()})` : '') +
    `. Mariah's daily scan checks for fabrication-shaped patterns: ` +
    `thinking-only consults, parroted empty consults, fabrication after ` +
    `read failures, dropped-args tool calls. Below 70 also holds this ` +
    `specialist's autonomy graduations until the score recovers.`;
}

// ── Hearth rank badges (Trust-Ladder XP) ────────────────────────────────
// A specialist's copper→silver→gold→platinum→diamond standing + level + an XP
// bar (X to next), shown on the chat header and the office. Hydrated from
// GET /api/specialists/:id/rank; the route returns { enabled:false } when the
// Trust Ladder is off (HEARTH_TRUST_XP), in which case the badge stays hidden.
// Cached per specialist for the session; refreshed on each switch.
const _rank_cache = new Map();
async function fetch_rank(id) {
  if (_rank_cache.has(id)) return _rank_cache.get(id);
  let rank = null;
  try {
    const r = await api(`/api/specialists/${encodeURIComponent(id)}/rank`);
    rank = r && r.enabled ? r : null;
  } catch { rank = null; }
  _rank_cache.set(id, rank);
  return rank;
}
// Drop a cached rank so the next render refetches (e.g. after a proposal decision
// that may have moved XP). Best-effort; absent id is a no-op.
function invalidate_rank(id) { if (id) _rank_cache.delete(id); }

function _render_rank_badge(el, rank) {
  if (!el) return;
  if (!rank) { el.hidden = true; el.innerHTML = ''; return; }
  const pct = Math.round((rank.pct || 0) * 100);
  const next = rank.next_tier
    ? `${rank.xp_to_next} XP to ${rank.tier_name === rank.next_tier.name ? 'L' + (rank.level + 1) : rank.next_tier.name}`
    : `${rank.xp_to_next} XP to L${rank.level + 1}`;
  el.dataset.tier = rank.tier;
  el.title =
    `${rank.tier_name} · Level ${rank.level} · ${rank.xp} XP earned. ` +
    `${rank.xp_to_next} XP to the next level. ` +
    `Earned from your approvals of this specialist's proposals (the Trust Ladder).`;
  el.innerHTML =
    '<span class="rank-medal" aria-hidden="true"></span>'
    + `<span class="rank-label">${escape_html(rank.tier_name)} · Lv ${rank.level}</span>`
    + `<span class="rank-bar" aria-hidden="true"><span class="rank-bar-fill" style="width:${pct}%"></span></span>`
    + `<span class="rank-xp">${escape_html(next)}</span>`;
  el.hidden = false;
}

async function update_rank_badge(spec) {
  const el = document.getElementById('rank-badge');
  if (!el || !spec) return;
  _render_rank_badge(el, await fetch_rank(spec.id));
}

// Populate an office-pane badge placeholder for a specialist (async).
async function populate_office_rank(el, id) {
  if (!el || !id) return;
  _render_rank_badge(el, await fetch_rank(id));
}

// ── Activity LEDs (live / rag / deep / tool) ────────────────────────────
// Faithful HDD-blink indicators, driven entirely by live SSE events — no
// polling, no timers except the min-flash below. Toggle one LED on a
// specialist's left-rail card AND (if it's the active pane) the header.
function set_led(id, channel, on) {
  const card = staff_list_el.querySelector(`.staff-card[data-id="${CSS.escape(id)}"]`);
  if (card) card.querySelector('.staff-leds .led-' + channel)?.classList.toggle('on', !!on);
  if (id === state.active_id && conv_leds_el) {
    conv_leds_el.querySelector('.led-' + channel)?.classList.toggle('on', !!on);
  }
}
// rag/deep are often sub-second; keep the LED lit a minimum ~300ms after the
// real `off` so an instant blip is still visible (HDD-LED feel). A fresh `on`
// cancels the pending off, so sustained work stays solid.
function flash_led(id, channel, on) {
  const key = id + ':' + channel;
  const pending = state.led_timers.get(key);
  if (pending) { clearTimeout(pending); state.led_timers.delete(key); }
  let act = state.activity.get(id);
  if (!act) { act = new Set(); state.activity.set(id, act); }
  if (on) {
    act.add(channel);
    set_led(id, channel, true);
  } else {
    state.led_timers.set(key, setTimeout(() => {
      act.delete(channel);
      set_led(id, channel, false);
      state.led_timers.delete(key);
    }, 300));
  }
}
// Resync the header LEDs to the active specialist's current state — called on
// pane switch so the header reflects work already in flight.
function sync_conv_leds() {
  if (!conv_leds_el) return;
  const act = state.activity.get(state.active_id);
  conv_leds_el.querySelector('.led-live')?.classList.toggle('on', state.thinking_ids.has(state.active_id));
  conv_leds_el.querySelector('.led-rag')?.classList.toggle('on', !!act && act.has('rag'));
  conv_leds_el.querySelector('.led-deep')?.classList.toggle('on', !!act && act.has('deep'));
  conv_leds_el.querySelector('.led-tool')?.classList.toggle('on', !!act && act.has('tool'));
}

function update_staff_thinking() {
  for (const btn of staff_list_el.querySelectorAll('.staff-card')) {
    const on = state.thinking_ids.has(btn.dataset.id);
    btn.classList.toggle('thinking', on);
    // The 'live' LED is the same signal as the typing animation.
    btn.querySelector('.staff-leds .led-live')?.classList.toggle('on', on);
  }
  // Center pane state.
  if (state.thinking_ids.has(state.active_id)) {
    conv_state_el.textContent = 'thinking…';
    conv_state_el.classList.add('thinking');
  } else {
    conv_state_el.textContent = 'available';
    conv_state_el.classList.remove('thinking');
  }
  conv_leds_el?.querySelector('.led-live')?.classList.toggle('on', state.thinking_ids.has(state.active_id));
  update_typing_bubble();
}

/**
 * When the streaming runtime is emitting tokens for the active
 * conversation, rewrite the typing bubble's body to show the partial
 * text instead of the three-dot indicator. The typing-dots fade away
 * naturally because we replace the bubble's inner HTML — they were
 * only ever a placeholder for "tokens haven't started yet."
 *
 * When `streaming_text` is cleared (thinking finished), the bubble
 * either gets removed by update_typing_bubble (if thinking ended) or
 * snaps back to dots (if a new turn started). The `message_added`
 * event that follows replaces the streamed view with the persisted
 * message.
 */
/**
 * Render the live "Thinking…" pill above the streaming bubble. Inserted
 * into the typing message's body so it scrolls with the bubble. The
 * pill is a <details>-like collapsible: header row (avatar dot + label
 * + chevron + token count + elapsed) is always visible; the trace text
 * is hidden when collapsed.
 *
 * Auto-collapses the moment content_delta starts arriving (see the
 * `message_token` SSE branch) so the eye lands on the answer; users
 * can still click to re-expand.
 */
function update_thinking_pill() {
  const typing = messages_el.querySelector('.msg.specialist.typing');
  if (!typing) return;
  const body = typing.querySelector('.msg-body');
  if (!body) return;
  let pill = body.querySelector('.thinking-pill');
  if (!state.streaming_thinking) {
    if (pill) pill.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('div');
    pill.className = 'thinking-pill';
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'thinking-pill-header';
    header.innerHTML =
      '<span class="thinking-pill-icon">◔</span>' +
      '<span class="thinking-pill-label">Thinking…</span>' +
      '<span class="thinking-pill-count" aria-hidden="true"></span>' +
      '<span class="thinking-pill-chevron" aria-hidden="true">▾</span>';
    header.addEventListener('click', () => {
      state.streaming_thinking_collapsed = !state.streaming_thinking_collapsed;
      update_thinking_pill();
    });
    const trace = document.createElement('div');
    trace.className = 'thinking-pill-trace';
    pill.appendChild(header);
    pill.appendChild(trace);
    // Insert right after .msg-sender so it sits above the bubble in
    // reading order — the deliberation precedes the visible reply.
    const sender = body.querySelector('.msg-sender');
    if (sender && sender.nextSibling) body.insertBefore(pill, sender.nextSibling);
    else body.insertBefore(pill, body.firstChild);
  }
  const collapsed = !!state.streaming_thinking_collapsed;
  pill.classList.toggle('collapsed', collapsed);
  const count_el = pill.querySelector('.thinking-pill-count');
  if (count_el) {
    // Rough word count — gives the user a sense of how much the model
    // is chewing on without rendering the full trace until they ask.
    const words = state.streaming_thinking.trim().split(/\s+/).length;
    count_el.textContent = ` · ${words} word${words === 1 ? '' : 's'}`;
  }
  const trace = pill.querySelector('.thinking-pill-trace');
  if (trace && !collapsed) {
    // Plain escaped render — thinking traces are noisy enough without
    // markdown adding formatting on top. Newlines preserved so the
    // model's bulleted-thinking structure stays legible.
    trace.innerHTML = escape_html(state.streaming_thinking).replace(/\n/g, '<br/>');
    // Auto-scroll the trace to the bottom so newest reasoning is
    // visible (matches the chat-bubble streaming feel).
    trace.scrollTop = trace.scrollHeight;
  }
  maybe_stick_to_bottom();
}

// Progressive-markdown streaming. We batch DOM writes to one per
// animation frame (cheap re-renders on long streams) and render
// PARAGRAPH-COMPLETE blocks with marked.parse() while leaving the
// trailing partial as escaped text. This way headings, lists, tables,
// and code fences light up as each block completes — no jarring
// "transformation flash" when the persisted message_added lands —
// without the "several letters per line" mid-token <br> artifact
// caused by running marked over a half-token-deep paragraph.
let _streaming_raf_handle = null;
function update_streaming_bubble() {
  if (_streaming_raf_handle != null) return;
  _streaming_raf_handle = requestAnimationFrame(_flush_streaming_bubble);
}
function _flush_streaming_bubble() {
  _streaming_raf_handle = null;
  const existing = messages_el.querySelector('.msg.specialist.typing .bubble');
  if (!existing) return;
  if (!state.streaming_text) return;
  existing.classList.remove('typing-bubble');
  existing.classList.add('streaming-bubble', 'markdown-body');
  // Split into paragraph-complete blocks (separated by blank lines)
  // plus a trailing partial block. The partial gets escape-only
  // rendering; the completed blocks go through marked + DOMPurify
  // so the user sees emerging structure (lists, headings, tables,
  // fenced code) progressively. A trailing "```" with no closing
  // fence is left as escaped text until the closing fence arrives
  // — same logic implicitly handles tables with no separator yet.
  const raw = state.streaming_text;
  const blocks = raw.split(/\n{2,}/);
  const trailing_partial = blocks.pop() ?? '';
  // A fenced code block whose closing ``` hasn't streamed yet should
  // be carried forward into the trailing partial — otherwise marked
  // would render an unterminated <pre> that the closing fence later
  // contradicts. Count ``` in joined completed text; if odd, demote
  // the last completed block to the trailing partial.
  while (blocks.length > 0) {
    const joined = blocks.join('\n\n');
    if ((joined.match(/```/g) || []).length % 2 === 0) break;
    const demoted = blocks.pop();
    if (demoted == null) break;
  }
  const completed_md = blocks.join('\n\n');
  const completed_html = completed_md ? render_md(completed_md) : '';
  const trailing_html = trailing_partial
    ? `<p class="streaming-partial">${escape_html(trailing_partial).replace(/\n/g, '<br/>')}</p>`
    : '';
  existing.innerHTML = completed_html + trailing_html;
  // Enhance any completed code blocks (copy button + lang pill). The
  // idempotent guard skips already-enhanced blocks across rAF flushes
  // so we don't rebuild the header on every token.
  enhance_code_blocks(existing);
  // Sticky-bottom: only auto-scroll if the user is at (or near) the
  // bottom. If they've scrolled up to read earlier content, leave
  // them alone — the jump-to-latest pill picks up the slack.
  maybe_stick_to_bottom();
}

const TOOL_LABEL = {
  web_fetch_clean: 'reading the web',
  web_search: 'searching the web',
  search_library: 'checking her library',
  query_audit_log: 'reviewing the audit log',
  ha_calendar_query: 'checking the calendar',
  caldav_upcoming: 'checking the calendar',
  ha_get_state: 'checking Home Assistant',
  ha_list_entities: 'checking Home Assistant',
  friday_status: 'pulling FRIDAY status',
  route: 'computing a route',
  geocode: 'geocoding',
  distance_matrix: 'computing distances',
  nearby: 'searching nearby places',
  plan_ev_day: 'planning the EV day',
  upsert_place: 'updating a place note',
  import_gedcom: 'importing the GEDCOM',
  append_journal_entry: 'updating the vault',
  upsert_person_note: 'updating the vault',
  record_decision: 'updating the vault',
  find_or_create_person: 'updating the vault',
  link_notes: 'updating the vault',
  draft_message: 'drafting a message',
  prepare_briefing: 'preparing a briefing',
  propose_action: 'proposing an action',
  promise_followup: 'scheduling a follow-up',
  consult_specialist: 'consulting a teammate',
};

function tool_label(name) {
  if (name === '__thinking__') return 'thinking';
  return TOOL_LABEL[name] || `running ${name}`;
}

/**
 * Mirror of the server's `_summarize_tool_input` in
 * src/core/specialist_runtime.ts. Picks the most informative field of
 * a tool's input for the persisted-breadcrumb row beneath a specialist
 * message. Kept in lock-step with the server side so live-chain and
 * persisted-breadcrumb labels read identically — discrepancies would
 * make the user think two different things happened. If you add a
 * case here, add it there (and vice versa).
 */
function _summarize_persisted_tool_input(name, input) {
  const obj = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'web_fetch_clean': return String(obj.url || '');
    case 'web_search':
    case 'search_library':
      return typeof obj.query === 'string' ? `"${obj.query}"` : '';
    case 'query_audit_log':
      return obj.agent ? `agent=${obj.agent}` : 'recent activity';
    case 'ha_calendar_query':
      return obj.calendar ? `calendar=${obj.calendar}` : 'calendar';
    case 'ha_get_state':
      return typeof obj.entity_id === 'string' ? obj.entity_id : '';
    case 'ha_list_entities': {
      const parts = [];
      if (obj.domain) parts.push(obj.domain);
      if (obj.name_contains) parts.push(`"${obj.name_contains}"`);
      return parts.join(' · ');
    }
    case 'route':
      return `${obj.from_name || '?'} → ${obj.to_name || '?'}`;
    case 'geocode':
      return typeof obj.address === 'string' ? obj.address : '';
    case 'nearby':
      return typeof obj.amenity === 'string' ? obj.amenity : '';
    case 'promise_followup':
      return typeof obj.summary === 'string' ? `"${obj.summary}"` : 'follow-up';
    case 'import_gedcom':
      return typeof obj.path === 'string' ? obj.path : '';
    default: {
      let json;
      try { json = JSON.stringify(input); } catch { json = ''; }
      return json && json.length <= 60 ? json : '';
    }
  }
}

// How many tool entries remain visible before we collapse the older
// ones behind an expand toggle. The most recent N stay visible; older
// entries hide under a "▼ N earlier" pill the user can click to expand.
const TOOL_CHAIN_COLLAPSE_THRESHOLD = 4;

function _fmt_duration_ms(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Renders the live tool-chain panel beneath the typing/streaming
 * bubble. Each tool call the specialist runs during the current turn
 * shows up as one row: spinner-or-status icon, tool label, input
 * summary, duration once completed. Older entries collapse behind a
 * single "▼ N earlier tools" pill when the chain grows past
 * TOOL_CHAIN_COLLAPSE_THRESHOLD — the most recent rows stay visible
 * so the user can see what's happening NOW; the historical context
 * is one click away.
 *
 * Lazy-created inside the typing bubble; removed when the chain
 * empties (turn finished / no tools were called).
 */
function _get_or_create_chain(conv_id) {
  let arr = state.tool_chains.get(conv_id);
  if (!arr) {
    arr = [];
    state.tool_chains.set(conv_id, arr);
  }
  return arr;
}

function render_tool_chain() {
  const typing = messages_el.querySelector('.msg.specialist.typing');
  if (!typing) return;
  let panel = typing.querySelector('.tool-chain');
  // Always read from the CURRENT active conversation — that's what the
  // typing bubble in the DOM belongs to.
  const chain = state.tool_chains.get(state.conv_id) ?? [];
  if (chain.length === 0) {
    if (panel) panel.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'tool-chain';
    // Append INTO the body, not the wrapper. The wrapper is a flex
    // row (avatar | body); a sibling here makes the chain a third
    // column that steals horizontal space from the bubble — observed
    // as the bubble streaming "1 letter per row" with the chain
    // pushed beside it. Inside .msg-body (which is flex-column)
    // the chain stacks naturally below the bubble.
    const body = typing.querySelector('.msg-body') ?? typing;
    body.appendChild(panel);
  }
  panel.innerHTML = '';

  const expanded = state.tool_chains_expanded.get(state.conv_id) ?? false;
  const should_collapse =
    !expanded && chain.length > TOOL_CHAIN_COLLAPSE_THRESHOLD;
  const visible_count = should_collapse
    ? TOOL_CHAIN_COLLAPSE_THRESHOLD - 1
    : chain.length;
  const hidden_count = chain.length - visible_count;

  if (should_collapse) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-chain-toggle';
    toggle.textContent = `▼ ${hidden_count} earlier tool${hidden_count === 1 ? '' : 's'}`;
    toggle.addEventListener('click', () => {
      state.tool_chains_expanded.set(state.conv_id, true);
      render_tool_chain();
    });
    panel.appendChild(toggle);
  } else if (expanded && chain.length > TOOL_CHAIN_COLLAPSE_THRESHOLD) {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tool-chain-toggle';
    toggle.textContent = `▲ collapse`;
    toggle.addEventListener('click', () => {
      state.tool_chains_expanded.set(state.conv_id, false);
      render_tool_chain();
    });
    panel.appendChild(toggle);
  }

  const visible = chain.slice(chain.length - visible_count);
  for (const entry of visible) {
    const row = document.createElement('div');
    row.className = 'tool-chain-row';
    if (entry.ended_at == null) row.classList.add('in-flight');
    else if (entry.ok === false) row.classList.add('failed');
    else row.classList.add('done');

    const icon = document.createElement('span');
    icon.className = 'tool-chain-icon';
    if (entry.ended_at == null) {
      icon.textContent = '◌';
      icon.classList.add('spinning');
    } else if (entry.ok === false) {
      icon.textContent = '✕';
    } else {
      icon.textContent = '✓';
    }
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tool-chain-label';
    // Special-case consult_specialist so the row reads as "consulting
    // Beatrice" not "consulting a teammate — → trainer". The server-side
    // input_summary returns "→ <id>"; we resolve the id to a display
    // name via state.by_id. Fall back to the raw id if we don't have
    // the specialist loaded.
    if (entry.tool_name === 'consult_specialist') {
      row.classList.add('is-consult');
      const m = (entry.input_summary || '').match(/→\s*([\w-]+)/);
      const peer_id = m ? m[1] : '';
      const peer = peer_id ? state.by_id.get(peer_id) : null;
      const peer_name = peer ? peer.name : peer_id;
      // Inline peer avatar so the handoff is visible at a glance —
      // the chip reads visually as "→ [Beatrice's face] asking
      // Beatrice…" rather than just text. Fail-soft: if the peer id
      // doesn't resolve to a known specialist, just render the
      // wordmark without an avatar.
      if (peer_id) {
        const arrow = document.createElement('span');
        arrow.className = 'tool-chain-consult-arrow';
        arrow.textContent = '→';
        arrow.setAttribute('aria-hidden', 'true');
        row.appendChild(arrow);
        const peer_av = document.createElement('img');
        peer_av.className = 'tool-chain-consult-avatar';
        peer_av.src = `/app/api/avatars/${peer_id}`;
        peer_av.alt = '';
        peer_av.title = peer_name || peer_id;
        row.appendChild(peer_av);
      }
      // "asking Eleanor…" while in-flight reads warmer than "consulting"
      // — same word the user would use describing the moment. Once the
      // consult returns, flip to past tense.
      const verb_in_flight = 'asking';
      const verb_done = 'asked';
      const verb = entry.ended_at == null ? verb_in_flight : verb_done;
      label.textContent = peer_name
        ? `${verb} ${peer_name}${entry.ended_at == null ? '…' : ''}`
        : `${verb} a teammate${entry.ended_at == null ? '…' : ''}`;
      row.appendChild(label);
    } else {
      label.textContent = tool_label(entry.tool_name);
      row.appendChild(label);

      if (entry.input_summary) {
        const detail = document.createElement('span');
        detail.className = 'tool-chain-detail';
        detail.textContent = '— ' + entry.input_summary;
        row.appendChild(detail);
      }
    }

    if (entry.ended_at != null) {
      const dur = document.createElement('span');
      dur.className = 'tool-chain-duration';
      dur.textContent = ' · ' + _fmt_duration_ms(entry.ended_at - entry.started_at);
      row.appendChild(dur);
    }

    panel.appendChild(row);
  }
}

/**
 * Back-compat shim. The old code base called render_tool_status
 * across several event handlers; the new tool-chain panel supersedes
 * it but we keep the function as a thin alias so callers don't drift.
 */
function render_tool_status() {
  render_tool_chain();
}

/**
 * Renders the pending-followup pill(s) for the active conversation.
 * Anchored under the message that scheduled the followup; updates
 * the ETA every 15s while pending. Removed by followup_delivered SSE
 * (which prunes state.pending_followups), then this re-render clears
 * the DOM.
 */
function render_followup_pills() {
  // Remove any stale pills and per-message spinners first.
  for (const el of messages_el.querySelectorAll('.followup-pending')) el.remove();
  for (const el of messages_el.querySelectorAll('.followup-spinner')) el.remove();
  for (const el of messages_el.querySelectorAll('.msg.has-pending-followup')) {
    el.classList.remove('has-pending-followup');
  }
  const list = state.pending_followups.get(state.conv_id);
  if (!list || !list.length) return;
  for (const fu of list) {
    const anchor = fu.anchor_message_id
      ? messages_el.querySelector(`[data-message-id="${fu.anchor_message_id}"]`)
      : null;
    const fire_at = new Date(fu.fire_at_iso).getTime();
    const eta = Math.max(0, Math.round((fire_at - Date.now()) / 1000));
    const eta_str = eta < 60 ? `~${eta}s` : `~${Math.round(eta / 60)}m`;
    const pill = document.createElement('div');
    pill.className = 'followup-pending';
    pill.dataset.followupId = fu.followup_id;
    pill.innerHTML = `<span class="followup-icon">⏳</span><span class="followup-text">Following up: ${escape_html(fu.summary)} · ${eta_str}</span>`;
    if (anchor) anchor.insertAdjacentElement('afterend', pill);
    else messages_el.appendChild(pill);
    // Spinner on the anchor message itself, so the promise is visible
    // at a glance without scanning for the pill.
    if (anchor) {
      anchor.classList.add('has-pending-followup');
      const meta = anchor.querySelector('.msg-meta-bottom');
      if (meta) {
        const spinner = document.createElement('span');
        spinner.className = 'followup-spinner';
        spinner.dataset.followupId = fu.followup_id;
        const tip = `Follow-up pending: ${fu.summary} · ${eta_str}`;
        spinner.title = tip;
        spinner.setAttribute('aria-label', tip);
        meta.appendChild(spinner);
      }
    }
  }
}

// Periodic ETA refresh while any followups are pending.
setInterval(() => {
  if ((state.pending_followups.get(state.conv_id) || []).length) {
    render_followup_pills();
  }
}, 15_000);

/**
 * Renders any pending present_questions forms for the active
 * conversation. Each form is anchored under the specialist message
 * that triggered the tool call (or appended at the tail when no
 * matching message is in view). On submit, POSTs to
 * /api/present-questions/:id/answer; the server fires a resume turn
 * and the answers travel back through the normal SSE pipeline.
 */
function render_pending_question_forms() {
  for (const el of messages_el.querySelectorAll('.pq-form')) el.remove();
  const list = state.pending_question_sets.get(state.conv_id);
  if (!list || !list.length) return;
  for (const set of list) {
    if (set.status !== 'pending') continue;
    const card = build_question_form_card(set);
    let anchor = null;
    if (set.anchor_message_id) {
      anchor = messages_el.querySelector(`[data-message-id="${set.anchor_message_id}"]`);
    }
    if (!anchor) {
      // Fall back to the most recent specialist message.
      const specialist_msgs = messages_el.querySelectorAll('.msg.specialist:not(.typing)');
      anchor = specialist_msgs[specialist_msgs.length - 1] || null;
    }
    if (anchor) anchor.insertAdjacentElement('afterend', card);
    else messages_el.appendChild(card);
  }
}

function build_question_form_card(set) {
  const card = document.createElement('form');
  card.className = 'pq-form';
  card.dataset.questionSetId = set.id;
  card.setAttribute('aria-label', `Form: ${set.questions.length} question${set.questions.length === 1 ? '' : 's'} for you`);

  const header = document.createElement('div');
  header.className = 'pq-form-header';
  header.textContent = set.questions.length === 1
    ? 'A choice for you'
    : `${set.questions.length} choices for you`;
  card.appendChild(header);

  if (set.intro_md) {
    const intro = document.createElement('div');
    intro.className = 'pq-form-intro';
    intro.textContent = set.intro_md;
    card.appendChild(intro);
  }

  // Track the chosen value(s) per question id. Strings for single-
  // select, arrays for multi-select. "Other" values are kept as
  // free-text strings keyed off the question id with a __other__
  // sentinel so the submit handler can pluck the typed value.
  const selections = new Map();
  const other_inputs = new Map();

  for (const q of set.questions) {
    const block = document.createElement('div');
    block.className = 'pq-question';

    const prompt = document.createElement('div');
    prompt.className = 'pq-question-text';
    prompt.textContent = q.text;
    block.appendChild(prompt);

    const opts_wrap = document.createElement('div');
    opts_wrap.className = 'pq-options';

    const multi = Boolean(q.multi_select);

    for (const o of q.options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pq-option';
      btn.dataset.value = o.value;
      btn.innerHTML = `<span class="pq-option-label">${escape_html(o.label)}</span>` +
        (o.description ? `<span class="pq-option-desc">${escape_html(o.description)}</span>` : '');
      btn.addEventListener('click', () => {
        if (multi) {
          const cur = selections.get(q.id) || [];
          if (cur.includes(o.value)) {
            const next = cur.filter((v) => v !== o.value);
            if (next.length) selections.set(q.id, next);
            else selections.delete(q.id);
            btn.classList.remove('selected');
          } else {
            selections.set(q.id, [...cur, o.value]);
            btn.classList.add('selected');
          }
        } else {
          selections.set(q.id, o.value);
          for (const sib of opts_wrap.querySelectorAll('.pq-option')) sib.classList.remove('selected');
          btn.classList.add('selected');
          const other_input = other_inputs.get(q.id);
          if (other_input) other_input.value = '';
        }
      });
      opts_wrap.appendChild(btn);
    }

    // Auto-appended free-text "Other" — matches Claude Code AskUserQuestion UX.
    const other_row = document.createElement('div');
    other_row.className = 'pq-other-row';
    const other_label = document.createElement('label');
    other_label.className = 'pq-other-label';
    other_label.textContent = 'Other:';
    const other_input = document.createElement('input');
    other_input.type = 'text';
    other_input.className = 'pq-other-input';
    other_input.placeholder = multi ? 'add a free-text answer' : 'or type your own';
    other_input.maxLength = 240;
    other_input.addEventListener('input', () => {
      if (!multi) {
        // Single-select: typing into Other clears the button selection.
        if (other_input.value.trim()) {
          for (const sib of opts_wrap.querySelectorAll('.pq-option')) sib.classList.remove('selected');
          selections.delete(q.id);
        }
      }
    });
    other_inputs.set(q.id, other_input);
    other_label.appendChild(other_input);
    other_row.appendChild(other_label);
    opts_wrap.appendChild(other_row);

    block.appendChild(opts_wrap);
    card.appendChild(block);
  }

  const actions = document.createElement('div');
  actions.className = 'pq-actions';

  const submit_btn = document.createElement('button');
  submit_btn.type = 'submit';
  submit_btn.className = 'btn pq-submit';
  submit_btn.textContent = 'Submit';
  actions.appendChild(submit_btn);

  const skip_btn = document.createElement('button');
  skip_btn.type = 'button';
  skip_btn.className = 'btn pq-skip';
  skip_btn.textContent = 'Skip all';
  skip_btn.addEventListener('click', () => {
    selections.clear();
    for (const inp of other_inputs.values()) inp.value = '';
    submit_btn.click();
  });
  actions.appendChild(skip_btn);

  card.appendChild(actions);

  card.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit_btn.disabled = true;
    skip_btn.disabled = true;

    const answers = {};
    for (const q of set.questions) {
      const other_input = other_inputs.get(q.id);
      const other_text = (other_input?.value || '').trim();
      if (q.multi_select) {
        const arr = [...(selections.get(q.id) || [])];
        if (other_text) arr.push(other_text);
        if (arr.length) answers[q.id] = arr;
      } else {
        if (other_text) answers[q.id] = other_text;
        else if (selections.has(q.id)) answers[q.id] = selections.get(q.id);
      }
    }

    if (!set.id) {
      submit_btn.disabled = false;
      skip_btn.disabled = false;
      console.error('[present_questions] submit aborted — set.id missing on the captured set:', set);
      toast('Form has no question_set_id — reload the page', true);
      return;
    }

    const submit_url = `/api/present-questions/${encodeURIComponent(set.id)}/answer`;
    try {
      // Use a raw fetch so we can surface the URL, status, and body in
      // the toast — api() collapses everything into 'HTTP <code>' when
      // the response has no JSON body, which hides the actual cause.
      const raw = await fetch(submit_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      const body_text = await raw.text();
      console.log('[present_questions] POST', submit_url, '→', raw.status, body_text);
      if (!raw.ok) {
        const short_url = submit_url.length > 60 ? submit_url.slice(0, 57) + '...' : submit_url;
        throw new Error(`${raw.status} ${short_url} — ${body_text.slice(0, 120)}`);
      }
      const resp = body_text ? JSON.parse(body_text) : {};
      // Drop the set from local state; the resume turn's
      // message_added SSE will re-render the conversation with the
      // specialist's reply.
      const remaining = (state.pending_question_sets.get(state.conv_id) || []).filter(
        (s) => s.id !== set.id,
      );
      if (remaining.length) state.pending_question_sets.set(state.conv_id, remaining);
      else state.pending_question_sets.delete(state.conv_id);
      render_pending_question_forms();
      if (!resp || !resp.ok) toast('Answers recorded.', false);
    } catch (err) {
      submit_btn.disabled = false;
      skip_btn.disabled = false;
      toast(`Failed to submit: ${err.message}`, true);
    }
  });

  return card;
}

// ── Listing draft cards (Linda's draft_listing) ──────────────────────────
// Anchored under Linda's latest message, same model as the pending-question
// forms: re-pinned on every render, fetched on `listing_draft_created`.

function render_listing_draft_cards() {
  for (const el of messages_el.querySelectorAll('.listing-draft')) el.remove();
  const list = state.listing_drafts.get(state.conv_id);
  if (!list || !list.length) return;
  for (const draft of list) {
    const card = build_listing_draft_card(draft);
    // Anchor under the most recent specialist message (Linda's reply that
    // announced the drafts), falling back to the message tail.
    const specialist_msgs = messages_el.querySelectorAll('.msg.specialist:not(.typing)');
    const anchor = specialist_msgs[specialist_msgs.length - 1] || null;
    if (anchor) anchor.insertAdjacentElement('afterend', card);
    else messages_el.appendChild(card);
  }
}

function build_listing_draft_card(draft) {
  const card = document.createElement('div');
  card.className = 'listing-draft';
  card.dataset.listingDraftId = draft.id;

  const header = document.createElement('div');
  header.className = 'listing-draft-header';
  header.textContent = draft.item_title || 'Listing drafts';
  card.appendChild(header);

  if (draft.comps_summary) {
    const comps = document.createElement('div');
    comps.className = 'listing-draft-comps';
    comps.textContent = draft.comps_summary;
    card.appendChild(comps);
  }

  const PLATFORMS = [
    { key: 'ebay', label: 'eBay' },
    { key: 'poshmark', label: 'Poshmark' },
    { key: 'facebook', label: 'Facebook Marketplace' },
  ];
  const listings = draft.listings || {};

  // Tabs + panels.
  const tabs = document.createElement('div');
  tabs.className = 'listing-draft-tabs';
  const panels = document.createElement('div');
  panels.className = 'listing-draft-panels';
  card.appendChild(tabs);
  card.appendChild(panels);

  PLATFORMS.forEach((p, idx) => {
    const listing = listings[p.key];
    if (!listing) return;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'listing-draft-tab' + (idx === 0 ? ' selected' : '');
    tab.textContent = p.label;
    tabs.appendChild(tab);

    const panel = document.createElement('div');
    panel.className = 'listing-draft-panel' + (idx === 0 ? '' : ' hidden');
    panels.appendChild(panel);

    tab.addEventListener('click', () => {
      for (const t of tabs.querySelectorAll('.listing-draft-tab')) t.classList.remove('selected');
      for (const pn of panels.querySelectorAll('.listing-draft-panel')) pn.classList.add('hidden');
      tab.classList.add('selected');
      panel.classList.remove('hidden');
    });

    // A copyable field: label, value (mono), and a copy button.
    const field = (label, value, opts = {}) => {
      if (value === undefined || value === null || value === '') return;
      const wrap = document.createElement('div');
      wrap.className = 'listing-draft-field';
      const head = document.createElement('div');
      head.className = 'listing-draft-field-head';
      const lab = document.createElement('span');
      lab.className = 'listing-draft-field-label';
      lab.textContent = label;
      head.appendChild(lab);
      if (opts.copy !== false) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'listing-draft-copy';
        copy.textContent = 'Copy';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(String(value));
            copy.textContent = 'Copied';
            setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
          } catch {
            toast('Copy failed — select and copy manually', true);
          }
        });
        head.appendChild(copy);
      }
      wrap.appendChild(head);
      const val = document.createElement('div');
      val.className = 'listing-draft-field-value';
      val.textContent = String(value);
      wrap.appendChild(val);
      panel.appendChild(wrap);
    };

    field('Title', listing.title);
    const price_str = typeof listing.price === 'number' ? `$${listing.price}` : listing.price;
    field('Price', price_str);
    field('Condition', listing.condition, { copy: false });

    // Platform-specific extras.
    if (p.key === 'ebay' && Array.isArray(listing.item_specifics) && listing.item_specifics.length) {
      const specs = listing.item_specifics
        .map((s) => `${s.key}: ${s.value}`)
        .join('\n');
      field('Item specifics', specs);
      if (listing.format) field('Format', listing.format.replace('_', ' '), { copy: false });
    }
    if (p.key === 'poshmark') {
      if (Array.isArray(listing.hashtags) && listing.hashtags.length) {
        field('Hashtags', listing.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '));
      }
    }
    if (p.key === 'facebook' && listing.delivery) {
      field('Delivery', listing.delivery, { copy: false });
    }

    field('Description', listing.description);

    if (listing.price_rationale) {
      const why = document.createElement('div');
      why.className = 'listing-draft-rationale';
      why.textContent = `Why $${listing.price ?? ''}: ${listing.price_rationale}`;
      panel.appendChild(why);
    }
  });

  return card;
}

/**
 * Pending "...typing..." bubble for the active specialist. Lives as a
 * regular .msg.specialist node at the bottom of the messages list,
 * with class .typing and an animated three-dot indicator. Inserted
 * when thinking starts, removed when it ends or when a real message
 * lands in the conversation.
 */
function update_typing_bubble() {
  const should_show =
    state.active_id &&
    state.thinking_ids.has(state.active_id);
  const existing = messages_el.querySelector('.msg.specialist.typing');
  if (!should_show) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return; // already showing
  const spec = state.by_id.get(state.active_id);
  if (!spec) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg specialist typing';
  wrap.setAttribute('aria-label', `${spec.name} is typing`);
  const av = document.createElement('img');
  av.className = 'msg-avatar';
  av.src = `/app/api/avatars/${spec.id}`;
  av.alt = '';
  av.title = `${spec.name} — open profile`;
  av.style.cursor = 'pointer';
  av.addEventListener('click', () => open_profile_modal(spec.id));
  wrap.appendChild(av);
  const body = document.createElement('div');
  body.className = 'msg-body';
  const sender = document.createElement('div');
  sender.className = 'msg-sender';
  sender.textContent = spec.name;
  body.appendChild(sender);
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing-bubble';
  bubble.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  body.appendChild(bubble);
  wrap.appendChild(body);
  // Hide the "start a conversation" empty-state if it's the current child.
  if (!empty_conv_el.hidden) empty_conv_el.hidden = true;
  messages_el.appendChild(wrap);
  // A freshly-shown bubble adopts any status that already arrived.
  render_chat_status();
  // Sticky-bottom: only follow if the user was at the bottom.
  maybe_stick_to_bottom();
}

// ── Switching specialists / conversations ───────────────────────────────

async function switch_specialist(id) {
  const spec = state.by_id.get(id);
  if (!spec) return;
  // Snapshot the last-visit timestamp BEFORE we POST /visited or
  // optimistically clear the spec's local ts_last_visited. This is
  // the boundary the "New messages" divider lands on. Null on a
  // never-visited conv → no divider (everything is unread by
  // definition; the empty-state copy already implies that).
  state._pending_unread_marker_ts = spec.ts_last_visited || null;
  // Switching conversations resets the read context — land at the
  // bottom of the new thread.
  sticky.pinned = true;
  // Tool chains are per-conversation now (state.tool_chains is a Map),
  // so switching specialists preserves each conv's chain. Iris can
  // stay mid-consult to Beatrice while you peek at Marguerite's pane,
  // and when you come back the chain is still there.
  state.active_id = id;
  set_active_hue(id);                 // PR1: bleed her hue into focus rings, donut, glows
  localStorage.setItem('hearth-last-specialist', id);
  // Fire-and-forget the visit notification — server records it and
  // broadcasts via SSE so other tabs / windows clear the envelope.
  try {
    api(`/api/specialists/${id}/visited`, { method: 'POST' });
  } catch { /* non-critical */ }
  // Optimistic local clear so the envelope disappears immediately.
  if (spec) {
    spec.unread_since_visit = 0;
    spec.ts_last_visited = new Date().toISOString();
  }
  render_staff();

  conv_avatar_el.src = `/app/api/avatars/${id}`;
  conv_avatar_el.alt = spec.name;
  conv_name_el.textContent = spec.name;
  sync_conv_leds(); // reflect any work already in flight for this specialist
  conv_role_el.textContent = spec.role;
  update_trust_meter(spec);
  update_rank_badge(spec);
  composer_input.placeholder = `Talk to ${spec.name}…`;
  empty_greeting_el.textContent = greeting_for(spec);
  // PR2: cozy themes render a big portrait + serif "— Name" sub-line
  // under the greeting. Set both whenever the active specialist
  // changes; non-cozy themes hide them via CSS.
  const _ep = document.getElementById('empty-portrait');
  if (_ep) { _ep.src = `/app/api/avatars/${spec.id}`; _ep.alt = spec.name || ''; }
  const _es = document.getElementById('empty-sub');
  if (_es) _es.textContent = `— ${spec.name || ''}`;

  // Specialist-as-Room: pick the surface and paint the office immediately.
  // The pane fetch is independent of the conversation load below, so the
  // office is visible while messages stream in behind it. Pane-less
  // specialists are forced to chat (toggle stays hidden).
  render_surface_toggle(spec);
  set_surface(has_pane(spec) ? (state.surface_pref.get(id) || 'office') : 'chat');

  // Find the most recent conversation with this specialist, or create one.
  const list = await api(`/api/conversations?specialist_id=${encodeURIComponent(id)}`);
  let conv = list.conversations[0];
  if (!conv) {
    conv = await api('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specialist_id: id }),
    });
  }
  state.conv_id = conv.id;
  await load_messages(conv.id);
  // Decide whether to anchor a "New messages" divider for this conv.
  // Only show it if a) we have a prior visit timestamp AND b) at least
  // one specialist message landed in this conv after that timestamp.
  // User's own outgoing messages don't count — those don't surprise.
  const marker_ts = state._pending_unread_marker_ts;
  state._pending_unread_marker_ts = null;
  if (marker_ts) {
    const fresh = state.messages.some(
      (mm) => mm.role === 'specialist' && mm.ts > marker_ts,
    );
    if (fresh) state.unread_markers.set(conv.id, marker_ts);
    else state.unread_markers.delete(conv.id);
    // Re-render once the marker is in place so the divider shows up
    // on the very first paint of this conv.
    render_messages();
  }
  render_right_rail();
  update_staff_thinking();
  refresh_context_fill();
  // Reset stop-button state on conv switch — the active conversation
  // changed, the prior conversation's in-flight state is irrelevant
  // to this composer. If a turn is in flight on the new conv, the
  // next specialist_thinking event will re-show.
  show_stop(false);
}

function greeting_for(spec) {
  const greetings = {
    kate: "Hi Jasper — what's on your mind?",
    vivian: 'Ready when you are. What should we look at?',
    anya: 'Hi — how are Bailey and Mango doing today?',
    eleanor: "What's growing on?",
    marguerite: "Tell me what we're looking for.",
    iris: 'Diagnosis or design — what are we working on?',
    cassandra: 'All quiet from my seat. What did you want to check?',
  };
  return greetings[spec.id] || `Hi — talk to ${spec.name}…`;
}

async function start_new_conversation() {
  if (!state.active_id) return;
  const conv = await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ specialist_id: state.active_id }),
  });
  state.conv_id = conv.id;
  await load_messages(conv.id);
}

async function load_messages(conv_id) {
  const { messages } = await api(`/api/conversations/${conv_id}/messages?limit=100`);
  state.messages = messages;
  // Reconstruct pending followups from persisted tool_calls. This
  // covers two cases the SSE feed misses: (1) the user reloaded the
  // page between scheduling and delivery, (2) the followup was made
  // in a previous session. We treat any promise_followup result
  // whose fire_at_iso is still in the future AND has no later
  // specialist message in this conv as still pending.
  const now = Date.now();
  const pending = [];
  for (const m of messages) {
    if (m.role !== 'specialist' || !m.tool_calls_json) continue;
    let tcs;
    try { tcs = JSON.parse(m.tool_calls_json); } catch { continue; }
    if (!Array.isArray(tcs)) continue;
    for (const tc of tcs) {
      if (tc.name !== 'promise_followup' || !tc.result || tc.error) continue;
      const r = tc.result;
      if (!r.followup_id || !r.fire_at_iso) continue;
      // Suppress if a later specialist message in this conv has
      // ts >= fire_at_iso (delivery already happened).
      const delivered = messages.some(
        (mm) =>
          mm.role === 'specialist' &&
          mm.specialist_id === m.specialist_id &&
          mm.ts > r.fire_at_iso &&
          mm.id !== m.id,
      );
      if (delivered) continue;
      // Hide ones way past their fire time (>15min late — almost
      // certainly already delivered and we missed the SSE).
      const fire_at = new Date(r.fire_at_iso).getTime();
      if (fire_at < now - 15 * 60_000) continue;
      pending.push({
        followup_id: r.followup_id,
        summary: (tc.input && tc.input.summary) || '',
        fire_at_iso: r.fire_at_iso,
        anchor_message_id: m.id,
        specialist_id: m.specialist_id,
      });
    }
  }
  if (pending.length) state.pending_followups.set(conv_id, pending);
  else state.pending_followups.delete(conv_id);
  // Pull any pending question_sets for this conv so the inline form
  // survives a reload (or a switch into a conv with a set already
  // outstanding).
  try {
    const pq_resp = await api(`/api/conversations/${conv_id}/pending-questions`);
    const pq_list = Array.isArray(pq_resp.pending_questions) ? pq_resp.pending_questions : [];
    if (pq_list.length) state.pending_question_sets.set(conv_id, pq_list);
    else state.pending_question_sets.delete(conv_id);
  } catch {
    state.pending_question_sets.delete(conv_id);
  }
  // Pull any listing drafts for this conv so Linda's listing cards survive
  // a reload / switch-in, same as pending question forms.
  try {
    const ld_resp = await api(`/api/conversations/${conv_id}/listing-drafts`);
    const ld_list = Array.isArray(ld_resp.listing_drafts) ? ld_resp.listing_drafts : [];
    if (ld_list.length) state.listing_drafts.set(conv_id, ld_list);
    else state.listing_drafts.delete(conv_id);
  } catch {
    state.listing_drafts.delete(conv_id);
  }
  render_messages();
}

// ── Messages ─────────────────────────────────────────────────────────────

function render_messages() {
  // Snapshot pin state before clearing — innerHTML='' zeroes scrollTop
  // and would otherwise trip the scroll listener into thinking the
  // user is at the top.
  const was_pinned = sticky.pinned;
  messages_el.innerHTML = '';
  if (state.messages.length === 0) {
    empty_conv_el.hidden = false;
    messages_el.appendChild(empty_conv_el);
    return;
  }
  empty_conv_el.hidden = true;
  const GROUP_MS = 5 * 60 * 1000;
  let last_day = null;
  let prev = null;
  const unread_before_ts = state.unread_markers.get(state.conv_id) || null;
  let unread_divider_drawn = false;
  for (let i = 0; i < state.messages.length; i += 1) {
    const m = state.messages[i];
    const next = state.messages[i + 1];
    const day = day_key_for(m.ts);
    if (day !== last_day) {
      messages_el.appendChild(day_separator(m.ts));
      last_day = day;
    }
    // "New messages" divider — landed once, just before the first
    // specialist message whose ts is strictly newer than the visit
    // snapshot. User's own messages don't trigger; outgoing isn't
    // "new" from your own perspective.
    if (
      !unread_divider_drawn &&
      unread_before_ts &&
      m.role === 'specialist' &&
      m.ts > unread_before_ts
    ) {
      const div = document.createElement('div');
      div.className = 'unread-divider';
      div.innerHTML = '<span class="unread-divider-label">New</span>';
      messages_el.appendChild(div);
      unread_divider_drawn = true;
    }
    const same_sender = prev
      && prev.role === m.role
      && (m.role !== 'specialist' || prev.specialist_id === m.specialist_id)
      && Math.abs(new Date(m.ts) - new Date(prev.ts)) < GROUP_MS;
    const next_same = next
      && next.role === m.role
      && (m.role !== 'specialist' || next.specialist_id === m.specialist_id)
      && day_key_for(next.ts) === day
      && Math.abs(new Date(next.ts) - new Date(m.ts)) < GROUP_MS;
    const el = render_message(m);
    if (same_sender) el.classList.add('grouped');
    if (!next_same) el.classList.add('group-tail');
    messages_el.appendChild(el);
    prev = m;
  }
  // Reattach the typing bubble if the specialist is still thinking
  // (it got wiped by the innerHTML='' above).
  update_typing_bubble();
  // Pending followup pills get re-anchored on every render.
  render_followup_pills();
  render_pending_question_forms();
  render_listing_draft_cards();
  // Tool status reattaches inside the typing bubble if still active.
  render_tool_status();
  // Live sub-agent chips for this conversation (wiped by innerHTML='').
  render_delegation_strip();
  // PR2: cozy "listening" breath on the most-recent specialist bubble.
  // A no-op on non-cozy themes (the CSS rule is theme-gated).
  mark_last_listening();
  if (was_pinned) {
    sticky.pinned = true;
    messages_el.scrollTop = messages_el.scrollHeight;
  }
  update_jump_pill();
}

function render_message(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  wrap.dataset.messageId = m.id;

  if (m.role === 'specialist') {
    const sid = m.specialist_id || 'kate';
    const av = document.createElement('img');
    av.className = 'msg-avatar';
    av.src = `/app/api/avatars/${sid}`;
    av.alt = '';
    av.title = 'Open profile';
    av.style.cursor = 'pointer';
    av.addEventListener('click', () => open_profile_modal(sid));
    wrap.appendChild(av);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';

  // Sender label (specialist name) goes ABOVE — anchored top-left.
  // Timestamp goes BELOW the bubble.
  if (m.role === 'specialist') {
    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    const spec = state.by_id.get(m.specialist_id);
    sender.textContent = (spec && spec.name) || m.specialist_id || 'specialist';
    // PR2: provenance glyph (vault / inbox / memory) — appears only
    // when the backend supplies m.provenance. Graceful no-op otherwise.
    const prov = m.provenance;
    if (prov && PROV_GLYPHS[prov]) {
      const pill = document.createElement('span');
      pill.className = 'msg-provenance';
      pill.dataset.prov = prov;
      pill.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${PROV_GLYPHS[prov].svg}</svg>${PROV_GLYPHS[prov].label}`;
      sender.appendChild(pill);
    }
    body.appendChild(sender);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble markdown-body';
  bubble.innerHTML = render_md(m.content_md);
  enhance_code_blocks(bubble);
  // PR2: paint the speaker's hue into this bubble (cozy themes read
  // --bubble-hue for the inner glow / border / halo). User bubbles
  // inherit --active-hue from the root.
  if (m.role === 'specialist' && m.specialist_id) {
    const hue = (typeof SPECIALIST_HUES !== 'undefined') &&
                SPECIALIST_HUES[m.specialist_id];
    if (hue != null) bubble.style.setProperty('--bubble-hue', hue);
  }
  // PR3: attach the feedback trainer (👍/👎) to every specialist bubble.
  if (m.role === 'specialist') {
    attach_feedback_trainer(bubble, m);
  }
  body.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'msg-meta msg-meta-bottom';
  const surface = m.surface;
  const surface_icon =
    surface === 'telegram' ? ' · 📱'
    : surface === 'voice' ? ' · 🎤'
    : surface === 'web' ? ' · 💻'
    : '';
  meta.textContent = relative_time(m.ts) +
    (state.settings.show_surface_indicators && surface_icon ? surface_icon : '');
  // Tooltip shows the full Mountain-Time stamp (not UTC). Storage is
  // UTC; user surfaces render America/Denver.
  meta.title = _denver_fmt_full.format(new Date(m.ts)) + ' MT' +
    (surface ? ` (via ${surface})` : '');
  body.appendChild(meta);

  // Hover actions. Pinned to top-right of the bubble on desktop; on
  // touch devices the whole bar slides in beneath the bubble on long-
  // press (CSS handles the long-press affordance via :focus-within).
  // Three actions, mirroring Discord's hover-rail:
  //   Copy          — drop the rendered message text on the clipboard
  //   Reply         — quote the message into the composer (prefix each
  //                   line with `> `, then `\n` for the user to type)
  //   Ask another   — open a menu of other specialists; pick one and
  //                   the quoted text lands in their composer, ready
  //                   to send to a fresh specialist
  // System messages don't get the bar; their content is operational.
  if (m.role === 'specialist' || m.role === 'user') {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    bar.innerHTML = `
      <button type="button" class="msg-action" data-act="copy" title="Copy message" aria-label="Copy">
        <span aria-hidden="true">⧉</span>
      </button>
      <button type="button" class="msg-action" data-act="reply" title="Quote-reply" aria-label="Reply">
        <span aria-hidden="true">↩</span>
      </button>
      <button type="button" class="msg-action" data-act="ask-other" title="Ask another specialist" aria-label="Ask another">
        <span aria-hidden="true">⇄</span>
      </button>
    `;
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.msg-action');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'copy') copy_message_text(m);
      else if (act === 'reply') quote_reply_into_composer(m);
      else if (act === 'ask-other') open_ask_another_menu(btn, m);
    });
    wrap.appendChild(bar);
  }

  // Consult pills.
  const tool_calls = parse_json(m.tool_calls_json) || [];
  const consults = tool_calls.filter((t) => t.name === 'consult_specialist');
  for (const c of consults) {
    const peer_id = (c.input && c.input.specialist_id) || '';
    const peer = state.by_id.get(peer_id);
    if (!peer) continue;
    const pill = document.createElement('div');
    pill.className = 'consult-pill';
    pill.innerHTML =
      `<img src="/app/api/avatars/${peer.id}" alt=""/>` +
      `─→ Consulted ${escape_html(peer.name)} (${escape_html(peer.role)})`;
    body.appendChild(pill);
  }

  // Persisted tool-call breadcrumb. Always-on (NOT gated by
  // show_details) because it's load-bearing for spotting promise-
  // without-followthrough: when the specialist's text reads "let me
  // search for X" but the breadcrumb shows she only ran one earlier
  // tool, the ghost-promise pattern is visible at a glance instead
  // of hidden behind a settings toggle. The detail-shy `show_details`
  // path was over-hiding this signal — non_consult tool history is
  // user-facing context, not "internals."
  const non_consult = tool_calls.filter((t) => t.name !== 'consult_specialist');
  if (non_consult.length > 0) {
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'tool-breadcrumb';
    for (const t of non_consult) {
      const row = document.createElement('span');
      row.className = 'tool-breadcrumb-row' + (t.error ? ' failed' : ' done');
      const icon = document.createElement('span');
      icon.className = 'tool-breadcrumb-icon';
      icon.textContent = t.error ? '✕' : '✓';
      row.appendChild(icon);
      const label = document.createElement('span');
      label.className = 'tool-breadcrumb-label';
      label.textContent = tool_label(t.name);
      row.appendChild(label);
      const summary = _summarize_persisted_tool_input(t.name, t.input);
      if (summary) {
        const detail = document.createElement('span');
        detail.className = 'tool-breadcrumb-detail';
        detail.textContent = '— ' + summary;
        row.appendChild(detail);
      }
      breadcrumb.appendChild(row);
    }
    body.appendChild(breadcrumb);
  }

  // Reasoning trace. Whenever the message captured a <think> block,
  // surface a click-to-expand pill below the bubble — matches the
  // streaming pill, so the affordance is consistent live vs. saved.
  // When the global show_reasoning setting is on, the pill defaults to
  // expanded; otherwise it's collapsed and the user opens it on demand.
  if (m.reasoning_trace_md) {
    body.appendChild(_build_thinking_pill_for_message(m));
  }

  // Proposals.
  const proposal_ids = parse_json(m.proposals_created_json) || [];
  for (const pid of proposal_ids) {
    const p = state.proposals.find((x) => x.id === pid);
    if (p) body.appendChild(render_proposal_card(p));
  }

  wrap.appendChild(body);
  return wrap;
}

function parse_json(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Build a collapsible "Thinking" pill for a persisted message's
 * reasoning trace. Reuses .thinking-pill styling from the streaming
 * variant so live and saved feel identical. Default-collapsed unless
 * the global show_reasoning setting is on. Word-count in the header
 * gives the user a sense of how heavy the deliberation was without
 * forcing them to expand it.
 */
function _build_thinking_pill_for_message(m) {
  const pill = document.createElement('div');
  pill.className = 'thinking-pill thinking-pill-saved';
  const initially_expanded = !!state.settings.show_reasoning;
  if (!initially_expanded) pill.classList.add('collapsed');
  const trace_text = (m.reasoning_trace_md || '').trim();
  const word_count = trace_text ? trace_text.split(/\s+/).length : 0;
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'thinking-pill-header';
  header.innerHTML =
    '<span class="thinking-pill-icon" aria-hidden="true">💭</span>' +
    '<span class="thinking-pill-label">Thinking</span>' +
    `<span class="thinking-pill-count" aria-hidden="true"> · ${word_count} word${word_count === 1 ? '' : 's'}</span>` +
    '<span class="thinking-pill-chevron" aria-hidden="true">▾</span>';
  const trace_el = document.createElement('div');
  trace_el.className = 'thinking-pill-trace';
  trace_el.innerHTML = escape_html(trace_text).replace(/\n/g, '<br/>');
  header.addEventListener('click', () => {
    pill.classList.toggle('collapsed');
  });
  pill.appendChild(header);
  pill.appendChild(trace_el);
  return pill;
}

// ── Message hover actions ────────────────────────────────────────────────

async function copy_message_text(m) {
  const text = (m.content_md || '').trim();
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    // Fallback for HTTP / no-clipboard contexts: temporary textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('Copied'); }
    catch { toast('Copy failed', true); }
    ta.remove();
  }
}

function _quote_block(md) {
  return md
    .trim()
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
}

function quote_reply_into_composer(m) {
  const author =
    m.role === 'specialist'
      ? (state.by_id.get(m.specialist_id)?.name || m.specialist_id || 'them')
      : 'you';
  const quote = `> **${author}**\n${_quote_block(m.content_md || '')}\n\n`;
  const cur = composer_input.value;
  composer_input.value = quote + cur;
  // Cursor at the end (ready to type a reply after the quoted block).
  const pos = quote.length;
  composer_input.focus();
  composer_input.setSelectionRange(pos, pos);
  auto_resize_composer();
}

let _ask_other_menu_el = null;
function open_ask_another_menu(anchor_btn, m) {
  if (_ask_other_menu_el) { _ask_other_menu_el.remove(); _ask_other_menu_el = null; }
  const menu = document.createElement('div');
  menu.className = 'msg-ask-menu';
  // Filter out the originating specialist; ask-another implies a
  // different teammate. For user messages, all specialists are valid.
  const exclude = m.role === 'specialist' ? m.specialist_id : null;
  for (const s of state.specialists) {
    if (s.id === exclude) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'msg-ask-row';
    row.innerHTML =
      `<img src="/app/api/avatars/${s.id}" alt=""/>` +
      `<span class="msg-ask-name">${escape_html(s.name)}</span>` +
      `<span class="msg-ask-role">${escape_html(s.role || '')}</span>`;
    row.addEventListener('click', async () => {
      menu.remove();
      _ask_other_menu_el = null;
      // Switch to that specialist's conv, then prefill the composer
      // with a quoted snippet so the user can frame the question.
      await switch_specialist(s.id);
      quote_reply_into_composer(m);
    });
    menu.appendChild(row);
  }
  // Position relative to the anchor button. Use fixed positioning so
  // the menu floats above other panes — but anchor to the button's
  // bounding rect so it tracks scroll on open.
  const rect = anchor_btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${Math.max(8, rect.right - 240)}px`;
  document.body.appendChild(menu);
  _ask_other_menu_el = menu;
  // Dismiss on outside click / escape.
  const dismiss = (ev) => {
    if (ev && menu.contains(ev.target)) return;
    menu.remove();
    _ask_other_menu_el = null;
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', esc_dismiss, true);
  };
  const esc_dismiss = (ev) => { if (ev.key === 'Escape') dismiss(); };
  // Defer so the click that opened the menu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', esc_dismiss, true);
  }, 0);
}

// ── Proposal cards ───────────────────────────────────────────────────────

// "target_specialist_id" → "Target specialist", "body_md" → "Body".
function humanize_key(k) {
  return (
    String(k)
      .replace(/_/g, ' ')
      .replace(/\b(id|md)\b/g, '')
      .trim()
      .replace(/^./, (c) => c.toUpperCase()) || String(k)
  );
}

// Render a proposal payload as readable labeled text rather than a raw
// JSON dump — every proposal Jasper has to approve should read like a
// memo, not a struct.
function humanize_payload(payload) {
  if (payload == null || typeof payload !== 'object') return String(payload ?? '');
  const lines = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v == null || v === '') continue;
    const val =
      typeof v === 'string'
        ? v
        : typeof v === 'object'
          ? JSON.stringify(v, null, 2)
          : String(v);
    lines.push(`**${humanize_key(k)}:** ${val}`);
  }
  return lines.join('\n\n');
}

/**
 * Pull a string out of a payload field that's possibly singleton-
 * wrapped. Specialists routinely emit `{title: {title: "..."}}` when
 * the underlying tool schema declares a structured shape and the
 * LLM double-wraps on the way in. Returns the string or null.
 */
function _str_or_unwrap(v, expected_key) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (typeof v[expected_key] === 'string') return v[expected_key];
    // Single-key object containing a string — unwrap that too.
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v[keys[0]] === 'string') return v[keys[0]];
  }
  return null;
}

function proposal_title(p) {
  try {
    const payload = JSON.parse(p.payload_json);
    // Hiring packets, briefings, draft messages all have purpose-built
    // titles. Falls through to a generic "<Kind> from <specialist>"
    // when no recognizable title field exists.
    const headline = _str_or_unwrap(payload.headline, 'headline');
    if (headline) return headline;
    const title_str = _str_or_unwrap(payload.title, 'title');
    if (title_str) return title_str;
    if (payload.draft) return `Draft message · ${payload.occasion || 'no occasion'}`;
    if (payload.topic) return `Briefing · ${payload.topic}`;
    if (p.kind === 'persona_tuning' && payload.target_specialist_id)
      return `Persona tuning · ${payload.target_specialist_id}`;
    if (p.kind === 'binding_proposal') return `Binding proposal · structural change`;
    if (payload.task && payload.task.description) {
      return payload.task.description.split(/[.\n]/)[0].slice(0, 80);
    }
    // type.type === 'camera_check' etc. — pull a readable verb from
    // the inner type tag plus subject.
    if (payload.type && typeof payload.type === 'object') {
      const t = payload.type;
      if (t.camera && t.issue) return `${t.camera}: ${t.issue}`;
      if (t.type === 'data_cleanup' && Array.isArray(t.medications)) {
        return `Data cleanup · ${t.medications.length} medication record${t.medications.length === 1 ? '' : 's'}`;
      }
      if (t.recommendation) return String(t.recommendation).split(/[.\n]/)[0].slice(0, 80);
    }
    if (payload.body && payload.body.greeting) return String(payload.body.greeting).split(/[.\n]/)[0].slice(0, 80);
    if (payload.note) return String(payload.note).split(/[.\n]/)[0].slice(0, 80);
    if (payload.summary) return String(payload.summary).split(/[.\n]/)[0].slice(0, 80);
    // List-of-matches/shows shape (Maggie). Title = "N matches in <topic>"
    // if we can guess the topic from the first item.
    const list = payload?.body?.matches || payload?.body?.shows || payload?.matches || payload?.shows;
    if (Array.isArray(list) && list.length > 0) {
      const sample = list[0];
      const kind_hint = sample?.artist ? 'shows' : sample?.title ? 'items' : 'matches';
      return `${list.length} ${kind_hint} surfaced`;
    }
    // Last-ditch: take the first sentence of the rationale_md so the
    // user gets SOMETHING informative in the header. Trim heading
    // markdown and trailing punctuation.
    const rat = (p.rationale_md || '').trim().replace(/^[#*>\s-]+/, '');
    if (rat) {
      const first = rat.split(/[.\n]/)[0].trim();
      if (first) return first.slice(0, 80);
    }
    return `${humanize_key(p.kind)} from ${p.specialist_id}`;
  } catch {
    return `${humanize_key(p.kind)} from ${p.specialist_id}`;
  }
}

/**
 * Per-shape narrative detector. Returns an object describing the
 * proposal in human terms: what it will literally do, what it solves,
 * and any non-obvious implications the user should weigh before
 * approving. Falls back to a structured key/value render when no
 * detector matches.
 *
 * Shape: { what_md: string, solves_md?: string, implications: Implication[] }
 * Implication: { level: 'info'|'warn'|'urgent', label: string, detail?: string }
 *
 * Priority order matters — earlier matches win. Persona/binding/hire
 * have purpose-built shapes; generic action_proposal shapes (task,
 * type, dispatch) come after.
 */
function _proposal_narrative(p, payload) {
  const implications = _proposal_implications(p, payload);

  // ── Specific shapes first ───────────────────────────────────────────
  if (p.kind === 'draft_message' && payload?.body_md) {
    const recipient =
      payload.recipient?.display || payload.recipient?.id || 'someone';
    const body = typeof payload.body_md === 'string'
      ? payload.body_md
      : (payload.body_md.body || JSON.stringify(payload.body_md));
    const subject = payload.body_md?.subject ? ` (subject: *${payload.body_md.subject}*)` : '';
    return {
      what_md: `Send a draft message to **${recipient}**${subject}:\n\n${body}`,
      implications,
    };
  }

  if (p.kind === 'recommendation' && payload?.headline && payload?.specialist) {
    const s = payload.specialist;
    const caps = Array.isArray(payload.day_1_capabilities)
      ? payload.day_1_capabilities.map((c) => `- ${c}`).join('\n')
      : '';
    const queue = Array.isArray(payload.build_queue)
      ? payload.build_queue.map((q) => `- ${q}`).join('\n')
      : '';
    const gaps = payload.gap_analysis ? `\n\n**Gap analysis:** ${payload.gap_analysis}` : '';
    return {
      what_md:
        `Hire **${s.name || s.id}** as ${s.role || 'a specialist'} (voice: ${s.voice || 'default'}).\n\n` +
        (caps ? `**Day-one capabilities:**\n${caps}\n\n` : '') +
        (queue ? `**Build queue:**\n${queue}` : '') + gaps,
      solves_md: payload.gap_analysis || undefined,
      implications,
    };
  }

  if (p.kind === 'persona_tuning') {
    const target = payload?.target_specialist_id || '<unknown>';
    const change = payload?.proposed_change || '(no change text)';
    const diag = payload?.diagnosis || '';
    const fb = payload?.verbatim_feedback || '';
    return {
      what_md:
        `Update **${target}**'s persona:\n\n> ${String(change).replace(/\n/g, '\n> ')}`,
      solves_md: diag
        ? `${diag}${fb ? `\n\n_User feedback:_ "${fb}"` : ''}`
        : (fb ? `_User feedback:_ "${fb}"` : undefined),
      implications,
    };
  }

  if (p.kind === 'binding_proposal' || payload?.markdown) {
    // Trainer writes a markdown spec for a structural change.
    const md_map = payload?.markdown;
    if (md_map && typeof md_map === 'object') {
      const paths = Object.keys(md_map);
      const first_path = paths[0];
      const preview = first_path ? String(md_map[first_path]).slice(0, 600) : '';
      return {
        what_md:
          `Save a binding-proposal spec for a structural change at:\n\n` +
          paths.map((p2) => `- \`${p2}\``).join('\n') +
          (preview ? `\n\n**Preview:**\n\n${preview}${md_map[first_path].length > 600 ? '\n\n…' : ''}` : ''),
        implications,
      };
    }
  }

  // Cassandra/Kate's wrapped `{type: {type, ...}}` shape — several
  // sub-flavors. Branch on the inner type tag.
  if (payload?.type && typeof payload.type === 'object') {
    const inner = payload.type;
    if (inner.type === 'data_cleanup' && Array.isArray(inner.medications)) {
      const rows = inner.medications.map((m) =>
        `- **${m.name || m.med_id || 'record'}** — ${m.issue || ''}` +
        (m.recommendation ? `\n  - _Fix:_ ${m.recommendation}` : '')
      ).join('\n');
      return {
        what_md: `Clean up these records:\n\n${rows}`,
        implications,
      };
    }
    if (inner.recommendation) {
      const subject = inner.camera || inner.entity || inner.target;
      return {
        what_md: `**Proposed action:** ${inner.recommendation}` +
          (subject ? `\n\n_Target: ${subject}_` : ''),
        solves_md: inner.issue ? `**Issue:** ${inner.issue}` : undefined,
        implications,
      };
    }
    // Fallback for unknown inner shape: treat the inner object as the payload.
    const inner_lines = Object.entries(inner)
      .filter(([k]) => k !== 'type')
      .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
      .map(([k, v]) => `- **${humanize_key(k)}:** ${v}`)
      .join('\n');
    if (inner_lines) {
      return {
        what_md: `Action of type \`${inner.type || 'unknown'}\`:\n\n${inner_lines}`,
        implications,
      };
    }
  }

  // Kate's `{task: {description, ...}}` shape.
  if (payload?.task && typeof payload.task === 'object' && payload.task.description) {
    const task = payload.task;
    const extra_lines = Object.entries(task)
      .filter(([k]) => k !== 'description')
      .filter(([, v]) => v != null && v !== '' && typeof v !== 'object')
      .map(([k, v]) => `- **${humanize_key(k)}:** ${v}`)
      .join('\n');
    return {
      what_md: task.description + (extra_lines ? `\n\n${extra_lines}` : ''),
      implications,
    };
  }

  // Recommendation with note + suggested_followup.
  if (p.kind === 'recommendation' && payload?.note) {
    return {
      what_md: payload.note,
      solves_md: payload.suggested_followup
        ? `**Suggested follow-up:** ${payload.suggested_followup}`
        : undefined,
      implications,
    };
  }

  // Recommendation with shows / matches list (Maggie).
  const list_field = payload?.body?.shows || payload?.body?.matches || payload?.shows || payload?.matches;
  if (Array.isArray(list_field) && list_field.length > 0) {
    const greeting = payload?.body?.greeting ? `${payload.body.greeting}\n\n` : '';
    const items = list_field.map((it) => {
      if (typeof it === 'string') return `- ${it}`;
      const head = it.artist || it.title || it.name || it.headline || '';
      const where = [it.venue, it.location].filter(Boolean).join(' · ');
      const when = it.date || it.when || '';
      const why = it.why || it.rationale || '';
      const link = it.link || it.url ? ` ([link](${it.link || it.url}))` : '';
      const tail = [when, where].filter(Boolean).join(' · ');
      return `- **${head}**${tail ? ` — ${tail}` : ''}${why ? `\n  ${why}` : ''}${link}`;
    }).join('\n');
    return {
      what_md: `${greeting}${items}`,
      implications,
    };
  }

  // Calendar-event shape (kate's schedule_calendar_event).
  if (payload?.summary && payload?.start && payload?.calendar) {
    const when = `${payload.start}${payload.end ? ` → ${payload.end}` : ''}`;
    return {
      what_md:
        `Create a calendar event on **${payload.calendar}**:\n\n` +
        `- **What:** ${payload.summary}\n` +
        `- **When:** ${when}` +
        (payload.location ? `\n- **Where:** ${payload.location}` : '') +
        (payload.description ? `\n\n${payload.description}` : ''),
      implications,
    };
  }

  // Generic dispatch shape (Trainer-style `propose_code_change` etc.).
  if (payload?.dispatch_tool) {
    const tool = payload.dispatch_tool;
    const input = payload.dispatch_input || {};
    const input_lines = Object.entries(input)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `  - **${humanize_key(k)}:** ${typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200)}`)
      .join('\n');
    return {
      what_md: `Dispatch the **\`${tool}\`** tool with these inputs:\n\n${input_lines || '_(no inputs)_'}`,
      implications,
    };
  }

  // Fallback: structured key/value render with bold labels.
  if (payload && Object.keys(payload).length > 0) {
    return { what_md: humanize_payload(payload), implications };
  }
  return {
    what_md: '_(no payload — the rationale above is all the proposal carries)_',
    implications,
  };
}

/**
 * Extract user-visible costs/risks from execution metadata + payload.
 * Surfaced as a separate "Implications" section so the user weighs
 * them BEFORE clicking Approve. Order matters — urgent items first.
 */
function _proposal_implications(p, payload) {
  const out = [];
  const ek = p.execution_kind;

  // Dispatch → spell out exactly which tool will run server-side.
  if (ek === 'dispatch') {
    const tool = payload?.dispatch_tool || '(unspecified)';
    out.push({
      level: 'info',
      label: 'Will execute',
      detail: `Server will run \`${tool}\` on your approval. No further confirmation.`,
    });
  }
  if (ek === 'web_action') {
    out.push({
      level: 'warn',
      label: 'Web action',
      detail: 'A specialist will drive a browser on your behalf (Tier 2c — never auto-graduates).',
    });
  }
  if (ek === 'composite') {
    out.push({
      level: 'warn',
      label: 'Multi-step',
      detail: 'This proposal triggers a chain of follow-on actions if approved.',
    });
  }

  // Calendar writes are device-only (iOS EventKit). Approving here on the
  // web records the decision but does NOT write the event — that happens
  // when you approve on your iPhone. Say so, so a web approval that "does
  // nothing" isn't a mystery.
  if (p.kind === 'calendar_event') {
    out.push({
      level: 'info',
      label: 'Confirm on your phone',
      detail: 'Calendar changes are written on your iPhone (EventKit). Approving here records the decision — open Hearth on your phone to add it to your calendar.',
    });
  }

  // External-recipient hint — anything that looks like a send.
  const rec = payload?.recipient;
  if (rec && (rec.email || rec.phone)) {
    out.push({
      level: 'urgent',
      label: 'External send',
      detail: `Will reach ${rec.email || rec.phone} directly. Irreversible.`,
    });
  } else if (p.kind === 'draft_message' && rec && rec.id && rec.id !== 'kate') {
    out.push({
      level: 'urgent',
      label: 'External-bound message',
      detail: `Recipient: ${rec.display || rec.id}. Confirm the body before approving.`,
    });
  }

  // Money signals — anything with an amount / price / cost.
  const amt = payload?.amount ?? payload?.price ?? payload?.cost;
  if (amt != null) {
    out.push({
      level: 'urgent',
      label: 'Spend',
      detail: `${typeof amt === 'number' ? `$${amt.toFixed(2)}` : amt} — irreversible once executed.`,
    });
  }

  // File writes outside the vault.
  const paths = payload?.paths || payload?.path;
  if (paths) {
    const path_list = typeof paths === 'string' ? [paths] :
                      Array.isArray(paths) ? paths :
                      typeof paths === 'object' ? Object.keys(paths) : [];
    const risky = path_list.filter((pp) =>
      pp && !pp.startsWith('Knowledge/') && !pp.startsWith('Inbox/') &&
      !pp.startsWith('People/') && !pp.startsWith('Journal/') &&
      !pp.startsWith('Decisions/') && !pp.startsWith('System/'));
    if (risky.length > 0) {
      out.push({
        level: 'warn',
        label: 'Writes outside standard vault folders',
        detail: risky.map((p2) => `\`${p2}\``).join(', '),
      });
    }
  }

  // Graduation candidate — if this signature has been repeatedly approved.
  if (p.category_signature_hash) {
    out.push({
      level: 'info',
      label: 'Calibrates trust',
      detail: 'Approve-without-edits accumulates on this action class toward auto-graduation.',
    });
  }

  return out;
}

function render_proposal_card(p) {
  const card = document.createElement('div');
  card.className = 'proposal-card';
  card.dataset.proposalId = p.id;

  // Header: title + kind/specialist pill row.
  const title = document.createElement('div');
  title.className = 'proposal-title';
  title.textContent = proposal_title(p);

  const meta_row = document.createElement('div');
  meta_row.className = 'proposal-meta-row';
  const spec = state.by_id.get(p.specialist_id);
  const spec_name = (spec && spec.name) || p.specialist_id;
  const kind_label = humanize_key(p.kind);
  meta_row.innerHTML =
    `<span class="proposal-meta-chip proposal-meta-from">` +
      (spec ? `<img src="/app/api/avatars/${p.specialist_id}" alt=""/>` : '') +
      `${escape_html(spec_name)}` +
    `</span>` +
    `<span class="proposal-meta-chip proposal-meta-kind">${escape_html(kind_label)}</span>`;

  // Parse payload once for the rest of the card.
  let payload = {};
  try { payload = JSON.parse(p.payload_json) || {}; } catch { payload = {}; }
  const narrative = _proposal_narrative(p, payload);

  // ── Why? (rationale as prose, always shown) ───────────────────────
  const why = document.createElement('div');
  why.className = 'proposal-section proposal-why';
  why.innerHTML =
    `<div class="proposal-section-label">Why</div>` +
    `<div class="proposal-section-body markdown-body">${render_md(p.rationale_md || '_(no rationale captured)_')}</div>`;

  // ── What this will do (extracted narrative) ───────────────────────
  const what = document.createElement('div');
  what.className = 'proposal-section proposal-what';
  what.innerHTML =
    `<div class="proposal-section-label">What this will do</div>` +
    `<div class="proposal-section-body markdown-body">${render_md(narrative.what_md)}</div>`;
  enhance_code_blocks(what);

  // ── What it solves (optional) ─────────────────────────────────────
  let solves = null;
  if (narrative.solves_md) {
    solves = document.createElement('div');
    solves.className = 'proposal-section proposal-solves';
    solves.innerHTML =
      `<div class="proposal-section-label">What it solves</div>` +
      `<div class="proposal-section-body markdown-body">${render_md(narrative.solves_md)}</div>`;
  }

  // ── Implications (only when there ARE any) ────────────────────────
  let implications = null;
  if (narrative.implications.length > 0) {
    implications = document.createElement('div');
    implications.className = 'proposal-section proposal-implications';
    const has_urgent = narrative.implications.some((i) => i.level === 'urgent');
    if (has_urgent) implications.classList.add('has-urgent');
    const rows = narrative.implications.map((imp) => {
      const icon = imp.level === 'urgent' ? '⚠' : imp.level === 'warn' ? '⚠' : 'ℹ';
      return (
        `<div class="proposal-implication proposal-implication-${imp.level}">` +
          `<span class="proposal-implication-icon" aria-hidden="true">${icon}</span>` +
          `<span class="proposal-implication-text">` +
            `<strong>${escape_html(imp.label)}</strong>` +
            (imp.detail ? ` — ${escape_html(imp.detail)}` : '') +
          `</span>` +
        `</div>`
      );
    }).join('');
    implications.innerHTML =
      `<div class="proposal-section-label">${has_urgent ? '⚠ Implications' : 'Implications'}</div>` +
      rows;
  }

  // ── Raw payload (collapsed inspection) ────────────────────────────
  const raw = document.createElement('details');
  raw.className = 'proposal-raw';
  const raw_summary = document.createElement('summary');
  raw_summary.textContent = 'Show raw payload';
  const raw_pre = document.createElement('pre');
  raw_pre.className = 'proposal-raw-json';
  raw_pre.textContent = JSON.stringify(payload, null, 2);
  raw.appendChild(raw_summary);
  raw.appendChild(raw_pre);

  // Legacy alias — edit_proposal_inline replaces `.proposal-body`. Keep
  // it as a wrapper so the edit path still works (it now wraps the
  // What + Solves + Implications sections).
  const body = document.createElement('div');
  body.className = 'proposal-body';
  // Face cards judge a FACE — show it (the representative crop) so the
  // owner decides from evidence, not a text description.
  if (p.kind === 'face_enrollment' && payload && payload.rep_sighting_id) {
    const face = document.createElement('img');
    face.className = 'proposal-face-thumb';
    face.alt = '';
    face.src = `/api/specialists/cassandra/faces/crop/${encodeURIComponent(payload.rep_sighting_id)}`;
    face.addEventListener('error', () => face.remove());
    body.appendChild(face);
  }
  body.appendChild(what);
  if (solves) body.appendChild(solves);
  if (implications) body.appendChild(implications);
  body.appendChild(raw);

  const actions = document.createElement('div');
  actions.className = 'proposal-actions';

  // Face-enrollment cards render their REAL action set (member/friend
  // buttons + "New person…" + dismiss + keep-watching) — the generic
  // Approve/Deny pair can't answer "who is this?" (a bare approve has no
  // person to enroll, which is how the first who-is card sat unanswered).
  if (p.status === 'pending' && p.kind === 'face_enrollment' && Array.isArray(p.actions) && p.actions.length > 0) {
    for (const a of p.actions) {
      const btn = document.createElement('button');
      btn.className = a.style === 'primary' ? 'btn btn-primary' : a.style === 'destructive' ? 'btn btn-danger' : 'btn';
      btn.textContent = a.label;
      if (a.description) btn.title = a.description;
      btn.addEventListener('click', async () => {
        let modifications;
        if (a.id === 'new_person') {
          const nm = prompt('Name for the new entry?');
          if (!nm || !nm.trim()) return;
          modifications = { name: nm.trim(), relationship: 'friend' };
        } else if (a.effect === 'reject' && !confirm('Dismiss this face for good?')) {
          return;
        }
        btn.disabled = true;
        try {
          await api(`/api/proposals/${p.id}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action_id: a.id, ...(modifications ? { modifications } : {}) }),
          });
          await refresh_proposals();
          close_all_modals();
        } catch (e) {
          toast((e && e.message) || 'Action failed', true);
          btn.disabled = false;
        }
      });
      actions.appendChild(btn);
    }
  } else if (p.status === 'pending') {
    // Recommendation-kind proposals are informational, not gated.
    // The verb pair becomes Save / Dismiss instead of Approve / Deny;
    // Edit doesn't apply (there's no draft body to refine), so the
    // button is omitted. Underlying verdict still serializes as
    // 'approve' / 'deny' to the backend — only the labels change.
    const is_rec = p.kind === 'recommendation';

    const approve = document.createElement('button');
    approve.className = 'btn btn-primary';
    approve.textContent = is_rec ? 'Save' : 'Approve';
    approve.addEventListener('click', () => decide_proposal(p.id, 'approve'));

    const edit = is_rec ? null : document.createElement('button');
    if (edit) {
      edit.className = 'btn';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => edit_proposal_inline(card, p));
    }

    const deny = document.createElement('button');
    deny.className = 'btn btn-danger';
    deny.textContent = is_rec ? 'Dismiss' : 'Deny';
    deny.addEventListener('click', async () => {
      const reason = is_rec
        ? prompt('Why dismiss this (optional)?', '') || undefined
        : prompt('Reason for denying (optional)?', '') || undefined;
      await decide_proposal(p.id, 'deny', undefined, reason);
    });

    const snooze = document.createElement('button');
    snooze.className = 'btn';
    snooze.textContent = is_rec ? 'Later ▾' : 'Snooze ▾';

    const snooze_menu = document.createElement('div');
    snooze_menu.className = 'proposal-snooze-menu';

    const opts = [
      { label: 'In 1 hour', ms: 3600_000 },
      { label: 'In 4 hours', ms: 4 * 3600_000 },
      { label: 'Tomorrow 8am', until: tomorrow_8am() },
      { label: 'This weekend', until: next_saturday_9am() },
    ];
    for (const o of opts) {
      const b = document.createElement('button');
      b.textContent = o.label;
      b.addEventListener('click', () => {
        const until = o.until ?? new Date(Date.now() + o.ms).toISOString();
        snooze_proposal(p.id, until);
      });
      snooze_menu.appendChild(b);
    }
    snooze.addEventListener('click', () => snooze_menu.classList.toggle('open'));

    actions.appendChild(approve);
    if (edit) actions.appendChild(edit);
    actions.appendChild(deny);
    actions.appendChild(snooze);

    card.appendChild(title);
    card.appendChild(meta_row);
    card.appendChild(why);
    card.appendChild(body);
    card.appendChild(actions);
    card.appendChild(snooze_menu);
  } else {
    card.appendChild(title);
    card.appendChild(meta_row);
    card.appendChild(why);
    card.appendChild(body);
    const decided = document.createElement('div');
    decided.className =
      'proposal-decided ' + (p.status === 'denied' ? 'denied' : p.status === 'snoozed' ? 'snoozed' : '');
    decided.textContent =
      p.status === 'approved'
        ? '✓ Approved'
        : p.status === 'denied'
          ? '✕ Denied'
          : p.status === 'snoozed'
            ? `⏰ Snoozed`
            : `· ${p.status}`;
    card.appendChild(decided);
  }
  return card;
}

function edit_proposal_inline(card, p) {
  const body = card.querySelector('.proposal-body');
  let payload;
  try { payload = JSON.parse(p.payload_json); } catch { payload = {}; }
  const editable_text = payload.draft || payload.body_md || JSON.stringify(payload, null, 2);
  const ta = document.createElement('textarea');
  ta.value = editable_text;
  ta.style.width = '100%';
  ta.style.minHeight = '120px';
  ta.style.padding = '8px 10px';
  ta.style.borderRadius = '6px';
  ta.style.border = '1px solid var(--border-strong)';
  ta.style.background = 'var(--bg)';
  ta.style.color = 'var(--text)';
  ta.style.fontFamily = 'inherit';
  ta.style.fontSize = '13.5px';
  body.replaceWith(ta);
  ta.focus();

  const old_actions = card.querySelector('.proposal-actions');
  const new_actions = document.createElement('div');
  new_actions.className = 'proposal-actions';
  const save = document.createElement('button');
  save.className = 'btn btn-primary';
  save.textContent = 'Approve with edits';
  save.addEventListener('click', () => {
    const new_payload = { ...payload };
    if (payload.draft !== undefined) new_payload.draft = ta.value;
    else if (payload.body_md !== undefined) new_payload.body_md = ta.value;
    else {
      try { Object.assign(new_payload, JSON.parse(ta.value)); }
      catch { /* leave alone */ }
    }
    decide_proposal(p.id, 'approve', new_payload);
  });
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    refresh_proposals();
  });
  new_actions.appendChild(save);
  new_actions.appendChild(cancel);
  old_actions.replaceWith(new_actions);
}

async function decide_proposal(id, verdict, modifications, user_feedback) {
  await api(`/api/proposals/${id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verdict, modifications, user_feedback }),
  });
  await refresh_proposals();
  // Close any open queue / recommendation modal after a decision —
  // staring at a stale "Awaiting your nod" pane after you already
  // approved or denied is not the right UX. The rail re-renders on
  // refresh, so if there are more pending proposals Jasper can re-
  // open the queue with one click.
  close_all_modals();
  if (state.conv_id) await load_messages(state.conv_id);
}

async function snooze_proposal(id, until) {
  await api(`/api/proposals/${id}/snooze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ until }),
  });
  await refresh_proposals();
}

function tomorrow_8am() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(8, 0, 0, 0);
  return t.toISOString();
}

function next_saturday_9am() {
  const t = new Date();
  const days = (6 - t.getDay() + 7) % 7 || 7;
  t.setDate(t.getDate() + days);
  t.setHours(9, 0, 0, 0);
  return t.toISOString();
}

async function refresh_proposals() {
  const { proposals } = await api('/api/proposals?status=pending');
  // "Awaiting your nod" means actionable — something gated on Jasper's
  // decision. `recommendation`-kind proposals are informational (e.g.
  // Maggie's concert picks) — they don't block anything; saving /
  // dismissing them is a polite ack, not approval. Keep them out of
  // the queue + badge count; the rail's Recommendations section
  // surfaces them on its own.
  state.proposals = proposals.filter((p) => p.kind !== 'recommendation');
  state.recommendations = proposals.filter((p) => p.kind === 'recommendation');
  state.pending_count = state.proposals.length;
  if (state.pending_count > 0) {
    queue_badge_el.hidden = false;
    queue_badge_el.textContent = String(state.pending_count);
    queue_tab_badge_el.hidden = false;
    queue_tab_badge_el.textContent = String(state.pending_count);
  } else {
    queue_badge_el.hidden = true;
    queue_tab_badge_el.hidden = true;
  }
  if (state.active_id === 'kate') render_right_rail();
}

// ── Right rail ───────────────────────────────────────────────────────────

// ── Specialist office (pane) — Specialist-as-Room, web (layout A) ─────────
//
// Office is the primary surface for any specialist whose registry row
// carries a `pane_kind`; the server composes the layout document
// (`GET /api/specialists/:id/pane`) and we render its blocks here. Pane-less
// specialists never show the toggle and open straight to conversation.
// Mirrors the iOS `SpecialistRoomView` contract: the same block kinds, and
// the same forward-compatibility — an unknown block renders as nothing, so
// a new server-composed block kind never breaks an older client.

function has_pane(spec) {
  return !!(spec && typeof spec.pane_kind === 'string' && spec.pane_kind);
}

const _office_pane_el = () => document.getElementById('office-pane');
const _center_el = () => document.getElementById('center');

// Semantic hue tokens the composer emits (z1..z5, macro splits, severity).
// iOS resolves these from its theme palette; on web we map the known set and
// fall back to an evenly-spaced wheel position so any future category set
// still renders as distinct segments.
const OFFICE_HUE = {
  z1: '#5e8aa8', z2: '#5b8e7d', z3: '#c9a227', z4: '#cc7a33', z5: '#c43838',
  protein: '#5b8e7d', carbs: '#c9a227', fat: '#cc7a33',
  critical: '#c43838', warn: '#c98a1f', info: '#5e8aa8',
};
function _office_hue(token, i, n) {
  if (token && OFFICE_HUE[token]) return OFFICE_HUE[token];
  const h = (Math.round((i / Math.max(1, n)) * 320) + 200) % 360;
  return `hsl(${h} 45% 55%)`;
}

function _oel(html) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  return d.firstElementChild;
}

function render_surface_toggle(spec) {
  const wrap = document.getElementById('surface-toggle');
  if (!wrap) return;
  if (!has_pane(spec)) { wrap.hidden = true; return; }
  wrap.hidden = false;
  document.getElementById('seg-office').onclick = () => set_surface('office');
  document.getElementById('seg-chat').onclick = () => set_surface('chat');
}

function _move_seg_indicator() {
  const ind = document.getElementById('seg-ind');
  const active = document.querySelector('#surface-toggle .seg-btn.active');
  if (!ind || !active) return;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
}

// Switch the center between the office and the conversation. Sticky per
// specialist (state.surface_pref) so a returning visit lands where you left
// it; pane-less specialists are forced to chat.
function set_surface(surface) {
  const id = state.active_id;
  const spec = state.by_id.get(id);
  if (!has_pane(spec)) surface = 'chat';
  state.surface = surface;
  if (id) state.surface_pref.set(id, surface);
  const center = _center_el();
  if (center) center.dataset.surface = surface;
  // The context donut belongs to the conversation — hide it in the office.
  // (Cozy themes keep it in the composer, which the office already hides;
  // this also covers the default theme where the donut lives in the topbar.)
  if (context_fill_el) context_fill_el.classList.toggle('surface-hidden', surface === 'office');
  const office_btn = document.getElementById('seg-office');
  const chat_btn = document.getElementById('seg-chat');
  if (office_btn && chat_btn) {
    office_btn.classList.toggle('active', surface === 'office');
    office_btn.setAttribute('aria-selected', String(surface === 'office'));
    chat_btn.classList.toggle('active', surface === 'chat');
    chat_btn.setAttribute('aria-selected', String(surface === 'chat'));
    requestAnimationFrame(_move_seg_indicator);
  }
  if (surface === 'office') load_pane(id);
}

async function load_pane(id) {
  const pane = _office_pane_el();
  if (!pane || !id) return;
  const token = ++state._pane_token;
  // Client-rendered tabs (News Desk, Market Radar) need to know whose
  // office this is — render_pane only receives the doc.
  state._pane_specialist_id = id;
  // Cached doc paints instantly; we still refetch in the background so a
  // returning glance is never stale (same reactive contract as the rest of
  // the surfaces). No cache → skeleton until the first fetch lands.
  const cached = state.pane_cache.get(id);
  if (cached) render_pane(cached);
  else pane.innerHTML = _pane_skeleton();
  try {
    const doc = await api(`/api/specialists/${encodeURIComponent(id)}/pane`);
    if (token !== state._pane_token) return;   // a newer switch superseded us
    state.pane_cache.set(id, doc);
    render_pane(doc);
  } catch (err) {
    if (token !== state._pane_token) return;
    if (!cached) render_pane_empty(id, err);
  }
}

function _pane_skeleton() {
  return '<div class="office-skel">'
    + '<div class="office-sk" style="height:96px"></div>'
    + '<div class="office-sk" style="height:104px"></div>'
    + '<div class="office-sk" style="height:120px"></div></div>';
}

// ── Review swarm (2026-07-21) ────────────────────────────────────────────────
// Live red/blue/judge bench over a Beatrice code change, mounted in the Code
// Shop office and driven by the swarm_* SSE events (same stream as everything
// else). The iOS bee icon is the native sibling. Inform-only: the swarm reports
// findings; Kate still rules and the owner still merges.
const SWARM_ROLE_COLOR = { red: '#c0453a', blue: '#3f83c0', judge: '#c79a26' };
const SWARM_VERDICT_META = {
  pass: { label: 'passed', color: '#4a9d5b' },
  pass_with_concerns: { label: 'passed · concerns', color: '#c79a26' },
  block: { label: 'blocked', color: '#c0453a' },
};
const SWARM_SEVERITY_COLOR = { blocker: '#c0453a', concern: '#c79a26', nit: '#8a8078' };
const SWARM_DONE_LINGER_MS = 20 * 60 * 1000;

function swarm_state() {
  if (!state.swarm) state.swarm = new Map();
  return state.swarm;
}

function swarm_apply_event(e) {
  const m = swarm_state();
  if (e.type === 'swarm_review_started') {
    m.set(e.review_id, {
      review_id: e.review_id,
      change_id: e.change_id,
      title: e.title || e.change_id,
      tier: e.tier || 'bench',
      escalated_from: e.escalated_from || null,
      seats: (e.bench || []).map((b) => ({
        seat_id: b.seat_id, role: b.role, phase: 'queued', summary: '', tool: '', think: '',
      })),
      findings: [],
      verdict: null,
      ruling: null,
      done_at: 0,
    });
  } else {
    const r = m.get(e.review_id);
    if (!r) return; // connected mid-run — wait for the next start (iOS covers it via refetch)
    if (e.type === 'swarm_seat_update') {
      let seat = r.seats.find((s) => s.seat_id === e.seat_id);
      if (!seat) { seat = { seat_id: e.seat_id, role: e.role, phase: e.phase, summary: '', tool: '', think: '' }; r.seats.push(seat); }
      seat.phase = e.phase;
      if (e.summary) seat.summary = e.summary;
      // A settled seat stops showing its in-flight chatter.
      if (e.phase === 'done' || e.phase === 'failed') { seat.tool = ''; seat.think = ''; }
    } else if (e.type === 'swarm_finding_added') {
      r.findings.push({ seat_id: e.seat_id, severity: e.severity, summary: e.summary, refuted: !!e.refuted });
    } else if (e.type === 'swarm_verdict') {
      r.verdict = e.verdict;
      if (e.ruling) r.ruling = e.ruling;
      r.done_at = Date.now();
    }
  }
  swarm_sweep();
}

/**
 * The live half. Every seat runs a REAL sub-turn on conversation
 * `swarm:<review_id>:<seat_id>`, so its tool calls and streaming tokens already
 * arrive as ordinary turn events — this is what makes the arena move instead of
 * tick. Peeked at before the main switch; a no-op for every other conversation.
 */
function swarm_live_event(e) {
  const conv = e && e.conversation_id;
  if (!conv || conv.indexOf('swarm:') !== 0) return;
  const parts = conv.split(':'); // swarm : <review_id> : <seat_id>
  const r = swarm_state().get(parts[1]);
  if (!r) return;
  const seat = (r.seats || []).find((s) => s.seat_id === parts[2]);
  if (!seat) return;
  if (e.type === 'tool_invoked') {
    seat.tool = e.input_summary ? e.tool_name + ' · ' + e.input_summary : e.tool_name;
    if (seat.phase === 'queued') seat.phase = 'working';
  } else if (e.type === 'message_token') {
    seat.think = (seat.think + (e.delta || '')).slice(-150);
    if (seat.phase === 'queued') seat.phase = 'working';
  } else if (e.type === 'specialist_thinking' && e.state === 'started') {
    if (seat.phase === 'queued') seat.phase = 'working';
  } else {
    return; // nothing the arena cares about
  }
  swarm_sweep();
}

function swarm_sweep() {
  const m = swarm_state();
  const now = Date.now();
  // `keep` marks a case seeded from the server as the panel's memory — sweeping
  // it would defeat the fallback (it is old BY DEFINITION). Only live-streamed
  // reviews age out.
  for (const [id, r] of m) {
    if (r.done_at && !r.keep && now - r.done_at > SWARM_DONE_LINGER_MS) m.delete(id);
  }
  swarm_schedule_render();
}

/** Token streams fire dozens of events a second — coalesce into ~7 renders/s. */
function swarm_schedule_render() {
  if (state._swarm_render_pending) return;
  state._swarm_render_pending = true;
  setTimeout(() => {
    state._swarm_render_pending = false;
    if (state._swarm_panel_el && document.body.contains(state._swarm_panel_el)) {
      swarm_render_into(state._swarm_panel_el);
    }
  }, 140);
}

function swarm_seat_glyph(phase) {
  if (phase === 'done') return '✓';
  if (phase === 'failed') return '✕';
  if (phase === 'working') return '●';
  return '·';
}

function swarm_default_line(role) {
  if (role === 'red') return 'attacking the diff — looking for the break';
  if (role === 'blue') return 'defending & repairing the red findings';
  if (role === 'judge') return 'weighing the findings for a verdict';
  if (role === 'evidence') return 'testing whether the blocker is supported';
  if (role === 'mechanism') return 'tracing the code itself';
  if (role === 'impact') return 'measuring the blast radius';
  return '';
}

function render_swarm_panel() {
  const el = document.createElement('div');
  el.className = 'swarm-arena';
  el.style.marginBottom = '14px';
  state._swarm_panel_el = el;
  swarm_render_into(el);
  return el;
}

function swarm_render_into(el) {
  const all = Array.from(swarm_state().values());
  const head =
    '<div style="font:600 12px ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted,#8a8078);margin:4px 2px 8px;">⚔ Review swarm</div>';
  if (all.length === 0) {
    el.innerHTML =
      head +
      '<div style="font-size:12.5px;color:var(--text-muted,#8a8078);padding:2px;">No reviews in flight. When a code change lands, the red / blue / judge bench convenes here — live.</div>';
    return;
  }
  // One CASE per change: the bench, its ledger, and the higher court if the
  // block was appealed. Grouping by change is what makes the appeal read as a
  // continuation rather than a second unrelated row.
  const byChange = new Map();
  all.forEach((r) => {
    if (!byChange.has(r.change_id)) byChange.set(r.change_id, []);
    byChange.get(r.change_id).push(r);
  });
  const cases = Array.from(byChange.values()).sort(
    (a, b) => (b[0].done_at || Infinity) - (a[0].done_at || Infinity),
  );
  el.innerHTML = head + cases.map(swarm_case_html).join('');
}

// ── Plain-English vocabulary ─────────────────────────────────────────────────
// Everything the owner reads here is written for a person, not an engineer.
// The machine words (bchg ids, severities, tiers) stay behind the scenes.
const SWARM_ROLE_LABEL = {
  red: 'Tries to break it',
  blue: 'Defends & repairs',
  judge: 'Decides',
  evidence: 'Checks the proof',
  mechanism: 'Traces the code',
  impact: 'Weighs the fallout',
};
const SWARM_VERDICT_PLAIN = {
  pass: { t: 'Looks good', c: '#4a9d5b' },
  pass_with_concerns: { t: 'Good, with notes', c: '#c79a26' },
  block: { t: 'Found a real problem', c: '#c0453a' },
};
const SWARM_SEVERITY_PLAIN = { blocker: 'Real problem', concern: 'Worth a look', nit: 'Minor' };

/** Injected once — lets the nest pulse and lay out like the arena mock. */
function swarm_inject_css() {
  if (document.getElementById('swarm-arena-css')) return;
  const st = document.createElement('style');
  st.id = 'swarm-arena-css';
  st.textContent = [
    '.cs-wrap{max-width:860px}',
    '.cs-h{font:600 12px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted,#8a8078);margin:2px 2px 8px}',
    '.cs-card{border:1px solid var(--border,#3a352e);border-radius:12px;background:var(--surface,#211d17);padding:14px 16px;margin-bottom:12px}',
    '.cs-ask{font-size:15px;font-weight:600;margin-bottom:4px}',
    '.cs-say{font-size:13.5px;color:var(--text-muted,#8a8078);margin-bottom:10px}',
    '.cs-tech{font:10.5px ui-monospace,monospace;color:var(--text-muted,#8a8078);opacity:.75;margin-top:8px}',
    '.cs-btns{display:flex;gap:8px;flex-wrap:wrap}',
    '.cs-btn{font:600 12.5px inherit;border-radius:8px;padding:8px 14px;cursor:pointer;border:1px solid var(--border,#3a352e);background:transparent;color:var(--text,#e8e0d4)}',
    '.cs-btn.go{background:#4a9d5b;border-color:#4a9d5b;color:#0d1a10}',
    '.cs-btn.back{color:#c0453a;border-color:#c0453a}',
    '.cs-btn:hover{filter:brightness(1.1)}',
    '.cs-quiet{font-size:13.5px;color:var(--text-muted,#8a8078);padding:6px 2px}',
    '.nest{border:1px solid var(--border,#3a352e);border-radius:14px;background:var(--surface,#211d17);padding:15px 16px;margin-bottom:12px}',
    '.nest-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;flex-wrap:wrap}',
    '.nest-t{font-weight:600;font-size:14px}',
    '.nest-id{font:10.5px ui-monospace,monospace;color:var(--text-muted,#8a8078)}',
    '.stamp{font:800 11.5px ui-monospace,monospace;border:2px solid currentColor;border-radius:6px;padding:3px 11px;letter-spacing:.08em;white-space:nowrap}',
    '.seats{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px}',
    '.seat{border:1px solid var(--border,#3a352e);border-left:3px solid currentColor;border-radius:9px;padding:8px 10px;background:rgba(255,255,255,.02)}',
    '.seat-h{display:flex;align-items:center;gap:7px;font:700 10px ui-monospace,monospace;letter-spacing:.09em;text-transform:uppercase}',
    '.seat-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}',
    '.seat.on .seat-dot{animation:seatpulse 1.2s ease-out infinite}',
    '@keyframes seatpulse{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}',
    '.seat-say{font-size:12.5px;color:var(--text,#e8e0d4);margin-top:4px}',
    '.seat-live{font:9.5px ui-monospace,monospace;color:var(--text-muted,#8a8078);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.led{margin-top:10px;padding-top:9px;border-top:1px dashed var(--border,#3a352e)}',
    '.led-i{font-size:12.5px;margin-bottom:5px}',
    '.led-i.gone{opacity:.45;text-decoration:line-through}',
    '.sev{font:700 8.5px ui-monospace,monospace;color:#fff;border-radius:3px;padding:1px 5px;margin-right:6px}',
    '.court{margin-top:12px;padding:11px 13px;border:1px solid currentColor;border-radius:11px;background:rgba(199,154,38,.06)}',
    '.court-h{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:7px;font:700 10.5px ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}',
    '@media (prefers-reduced-motion:reduce){.seat.on .seat-dot{animation:none}}',
  ].join('\n');
  document.head.appendChild(st);
}

/** '' while it is live or freshly done; otherwise "last review · 3h ago". */
function swarm_age_label(r) {
  if (!r || !r.done_at) return '';
  const mins = Math.round((Date.now() - r.done_at) / 60000);
  if (mins < 30) return '';
  if (mins < 90) return 'last review · ' + mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return 'last review · ' + hrs + 'h ago';
  return 'last review · ' + Math.round(hrs / 24) + 'd ago';
}

/** One change = one nest: the reviewers, what they found, and the ruling. */
function swarm_case_html(reviews) {
  let bench = null;
  let court = null;
  reviews.forEach((r) => {
    if (r.tier === 'higher_court') court = r;
    else bench = r;
  });
  if (!bench) bench = reviews[0];
  const final = court || bench;
  const v = final.verdict ? SWARM_VERDICT_PLAIN[final.verdict] : null;
  const stamp = v
    ? '<span class="stamp" style="color:' + v.c + '">' + escape_html(v.t) + '</span>'
    : '<span class="nest-id">the reviewers are still working…</span>';
  // Say plainly when this is memory rather than something happening now — a
  // finished case shown hours later must not read as a live bench.
  const age = swarm_age_label(final);
  return (
    '<div class="nest">' +
    '<div class="nest-top"><div style="min-width:0">' +
    '<div class="nest-t">' + escape_html(bench.title || 'A change') + '</div>' +
    '<div class="nest-id">' + escape_html(bench.change_id || '') +
    (age ? ' · ' + escape_html(age) : '') + '</div></div>' +
    stamp + '</div>' +
    '<div class="seats">' + (bench.seats || []).map(swarm_pod_html).join('') + '</div>' +
    swarm_ledger_html(bench.findings) +
    (court ? swarm_court_html(court) : '') +
    '</div>'
  );
}

/** One reviewer: who they are, what they're doing, and — while they work — the
 *  file they just opened and the words they're writing. */
function swarm_pod_html(s) {
  const c = SWARM_ROLE_COLOR[s.role] || '#8a8078';
  const on = s.phase === 'working';
  const live = on && (s.tool || s.think)
    ? '<div class="seat-live">' + escape_html(s.tool ? '⛏ ' + s.tool : '› ' + s.think) + '</div>'
    : '';
  return (
    '<div class="seat' + (on ? ' on' : '') + '" style="color:' + c + '">' +
    '<div class="seat-h"><span class="seat-dot"></span>' +
    escape_html(SWARM_ROLE_LABEL[s.role] || s.role || '') + '</div>' +
    '<div class="seat-say">' + escape_html(s.summary || swarm_default_line(s.role)) + '</div>' +
    live + '</div>'
  );
}

function swarm_ledger_html(findings) {
  if (!findings || findings.length === 0) return '';
  return (
    '<div class="led"><div class="cs-h" style="margin-bottom:6px">What they found</div>' +
    findings.map((f) => {
      const sc = SWARM_SEVERITY_COLOR[f.severity] || '#8a8078';
      return '<div class="led-i' + (f.refuted ? ' gone' : '') + '">' +
        '<span class="sev" style="background:' + sc + '">' +
        escape_html(SWARM_SEVERITY_PLAIN[f.severity] || f.severity || '') + '</span>' +
        escape_html(f.summary || '') + '</div>';
    }).join('') +
    '</div>'
  );
}

/** The appeal — set apart, because a "no" is not the last word. */
function swarm_court_html(c) {
  const ruled = c.ruling === 'overturned'
    ? { t: 'They disagreed — it can go ahead', col: '#4a9d5b' }
    : c.ruling === 'upheld'
      ? { t: 'They agreed — it is a real problem', col: '#c0453a' }
      : { t: 'taking another look…', col: '#c79a26' };
  return (
    '<div class="court" style="color:' + ruled.col + '">' +
    '<div class="court-h"><span>⚖ Second opinion</span><span>' + escape_html(ruled.t) + '</span></div>' +
    '<div class="seats">' + (c.seats || []).map(swarm_pod_html).join('') + '</div>' +
    swarm_ledger_html(c.findings) +
    '</div>'
  );
}

// ── Kate's Code Shop tab ─────────────────────────────────────────────────────
// The workshop, in plain language. Rule of this surface: ONLY things you can act
// on, plus a short row of commands. No metrics, no history, no machine chatter —
// those live in the raw pane. The nest is the centerpiece.
function render_codeshop_view() {
  swarm_inject_css();
  const wrap = document.createElement('div');
  wrap.className = 'cs-wrap';
  wrap.innerHTML = '<div class="cs-quiet">Looking in on the workshop…</div>';
  state._codeshop_el = wrap;
  // Defer past mount. codeshop_refresh() bails on `document.body.contains(el)`,
  // and an async body runs SYNCHRONOUSLY up to its first await — so calling it
  // here ran the guard while `wrap` was still detached (the caller appends it
  // only after we return). It bailed every time and the placeholder above was
  // never replaced: the "Looking in on the workshop…" that never resolved.
  setTimeout(() => void codeshop_refresh(), 0);
  return wrap;
}

async function codeshop_refresh() {
  const el = state._codeshop_el;
  if (!el || !document.body.contains(el)) return;
  let pane = null;
  let active = null;
  try { pane = await api('/api/specialists/trainer/pane'); } catch (e) { pane = { _err: String((e && e.message) || e) }; }
  try { active = await api('/api/specialists/trainer/swarm/active'); } catch { active = null; }
  if (active && active.reviews) codeshop_seed_swarm(active.reviews);
  codeshop_render(el, pane);
}

/** Seed the nest from the server so opening the tab mid-run shows the bench.
 *  Live SSE state always wins — we never clobber a review already streaming. */
function codeshop_seed_swarm(rows) {
  const m = swarm_state();
  rows.forEach((r) => {
    if (m.has(r.review_id)) return;
    const tier = r.tier || 'bench';
    m.set(r.review_id, {
      review_id: r.review_id,
      change_id: r.change_id,
      title: r.title || r.change_id,
      tier,
      escalated_from: r.escalated_from || null,
      seats: (r.seats || []).map((s) => ({
        seat_id: s.seat_id, role: s.role, phase: s.phase || 'queued',
        summary: s.summary || '', tool: '', think: '',
      })),
      findings: (r.findings || []).map((f) => ({
        seat_id: f.seat_id, severity: f.severity, summary: f.summary, refuted: !!f.refuted,
      })),
      verdict: r.verdict || null,
      // The appeal's outcome is implied by its verdict.
      ruling: tier === 'higher_court' && r.verdict
        ? (r.verdict === 'block' ? 'upheld' : 'overturned')
        : null,
      done_at: r.judged_at ? (Date.parse(r.judged_at) || Date.now()) : 0,
      // Server-seeded: this IS the panel's memory, so the sweep must not age it
      // out. Live SSE reviews stay sweepable.
      keep: true,
    });
  });
}

function codeshop_render(el, pane) {
  // The codeshop pane nests its real content one level down: top-level blocks is
  // [{type:'tabs', tabs:[{blocks:[…]}]}]. Filtering the TOP level for merge links
  // therefore matched nothing and "Waiting on you" read empty even with merges
  // pending. Flatten tabs (and tolerate a future flat pane) before filtering.
  const raw = (pane && pane.blocks) || [];
  const blocks = raw.flatMap((b) =>
    b && b.type === 'tabs' && Array.isArray(b.tabs)
      ? b.tabs.flatMap((t) => (t && Array.isArray(t.blocks) ? t.blocks : []))
      : [b],
  );
  // ACTIONABLE ONLY: a change is surfaced here exactly when it is waiting on
  // YOUR yes/no — i.e. the server gave it an approve deep link.
  const asks = blocks.filter(
    (b) => b && b.type === 'link' && typeof b.deep_link === 'string' &&
      b.deep_link.indexOf('codeshop:merge:') === 0,
  );
  const nest = document.createElement('div');
  swarm_render_into(nest);

  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'cs-h';
  head.textContent = 'Waiting on you';
  el.appendChild(head);

  if (pane && pane._err) {
    const e = document.createElement('div');
    e.className = 'cs-quiet';
    e.textContent = 'Could not reach the workshop right now.';
    el.appendChild(e);
  } else if (asks.length === 0) {
    const q = document.createElement('div');
    q.className = 'cs-quiet';
    q.textContent = 'Nothing needs you right now. When the workshop finishes something, it waits for you here.';
    el.appendChild(q);
  } else {
    asks.forEach((b) => el.appendChild(codeshop_ask_card(b)));
  }

  const nh = document.createElement('div');
  nh.className = 'cs-h';
  nh.style.marginTop = '18px';
  nh.textContent = 'The bench';
  el.appendChild(nh);
  el.appendChild(nest);
  el.appendChild(codeshop_commands());
}

/** One thing waiting on a yes — asked as a question, in plain words. */
function codeshop_ask_card(b) {
  const proposal_id = String(b.deep_link).slice('codeshop:merge:'.length);
  // The server title reads "✓ Approve & merge — PR #N · <rationale>". Keep only
  // the human part; the mechanics move to the small line at the bottom.
  const raw = String(b.title || '').replace(/^✓\s*Approve & merge\s*—\s*/, '');
  const card = document.createElement('div');
  card.className = 'cs-card';
  card.innerHTML =
    '<div class="cs-ask">Kate\'s workshop finished a change. Should it go live?</div>' +
    '<div class="cs-say">' + escape_html(raw || 'A change to Hearth.') + '</div>' +
    '<div class="cs-btns"></div>' +
    '<div class="cs-tech">' + escape_html(String(b.subtitle || '')) + '</div>';
  const btns = card.querySelector('.cs-btns');
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'cs-btn go';
  yes.textContent = 'Yes — put it live';
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try { await codeshop_approve_merge(proposal_id); } finally { void codeshop_refresh(); }
  });
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'cs-btn back';
  no.textContent = 'Send it back';
  no.addEventListener('click', async () => {
    const why = window.prompt('What should they fix? (Kate passes this back to the workshop)');
    if (why === null) return;
    no.disabled = true;
    try {
      await api(`/api/proposals/${proposal_id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: 'deny', reason: why || 'Sent back for changes.' }),
      });
      toast('Sent back to the workshop.', false, 'trainer');
    } catch (e) {
      toast('Could not send it back: ' + String((e && e.message) || e), true);
    } finally {
      void codeshop_refresh();
    }
  });
  btns.appendChild(yes);
  btns.appendChild(no);
  return card;
}

/** A short, curated row of commands — not a menu of everything possible. */
function codeshop_commands() {
  const row = document.createElement('div');
  row.className = 'cs-btns';
  row.style.marginTop = '14px';
  const mk = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cs-btn';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  row.appendChild(mk('Ask Kate for a change', () => {
    if (typeof set_surface === 'function') set_surface('chat');
  }));
  row.appendChild(mk('Workshop settings', () => {
    if (typeof open_codeshop_settings_modal === 'function') open_codeshop_settings_modal();
  }));
  row.appendChild(mk('Refresh', () => { void codeshop_refresh(); }));
  return row;
}

function render_pane(doc) {
  const pane = _office_pane_el();
  if (!pane) return;
  state._last_pane_doc = doc;
  pane.innerHTML = '';
  pane.appendChild(_pane_header(doc));
  // Kate's office is TABBED (2026-06-10): Briefing (the server-composed
  // blocks) | News Desk (a client-rendered surface over /api/news, same
  // shape as the presence canvas — no server block involved).
  if (doc.pane_kind === 'briefing') pane.appendChild(render_briefing_tabs());
  // Vivian's office is TABBED too (2026-06-12): Finances (the server-
  // composed fuel blocks) | Market Radar (a client-rendered surface over
  // /api/specialists/:id/market_radar — News Desk pattern).
  if (doc.pane_kind === 'fuel') pane.appendChild(render_fuel_tabs());
  // Cordelia's library office is TABBED too (2026-06-14): Library (the server-
  // composed blocks) | The Second Brain (a client-rendered knowledge-mesh canvas
  // over /api/specialists/cordelia/brain — same shape as Market Radar).
  if (doc.pane_kind === 'library') pane.appendChild(render_library_tabs());
  // Cassandra's Watch Desk is TABBED: Watch Desk (server blocks) | People
  // (a client-rendered face-enrollment surface over /api/specialists/cassandra/faces)
  // | Plates (placeholder). Same shape as the fuel/news tabbed offices.
  if (doc.pane_kind === 'security') pane.appendChild(render_security_tabs());
  const body = document.createElement('div');
  body.className = 'office-body';
  // Code Shop office — the live review-swarm panel (red/blue/judge bench over a
  // Beatrice code change), mounted above the change buckets. Driven by swarm_*
  // SSE events; the iOS bee icon is the native sibling.
  if (doc.pane_kind === 'codeshop') body.appendChild(render_swarm_panel());
  // The presence office's live top-down room canvas is a client-rendered
  // surface (not a server block) mounted above the framing blocks — same shape
  // as the Code Shop's client-side settings modal keyed off pane_kind.
  if (doc.pane_kind === 'presence') body.appendChild(render_presence_canvas(doc));
  // Luna's Home office — the household floor-plan occupancy canvas (P1.5),
  // mounted above the server-composed framing blocks (hero + "In the house").
  if (doc.pane_kind === 'home') body.appendChild(render_home_canvas(doc));
  if (doc.pane_kind === 'briefing' && state._news_tab === 'home') {
    // Kate's Home tab (2026-07-04) — the floor-plan occupancy canvas that
    // lived on Luna's office until the fold. Client-fetched via
    // /api/specialists/kate/home_map + /home_occupancy (she holds read_home).
    body.appendChild(render_home_canvas(doc));
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'news') {
    body.appendChild(render_news_desk_view());
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'research') {
    // Kate's deep-research office — a client-rendered surface over
    // /api/specialists/:id/research (the caller's investigations). Live
    // status, per-sub-question progress, and the finished cited dossiers.
    //
    // SHADOWS the server's `research` pane tab (core/research_pane.ts,
    // 2026-07-29) exactly the way this file shadows the server's `news`,
    // `radar` and `security` tabs: same id, same concept: the server composes
    // the tab for iOS, the else-branch below unwraps only the `briefing` tab,
    // and this richer client surface is what web shows. One surface per client
    // per id. Read the "id: 'research' is DELIBERATE" section in
    // research_pane.ts before changing either side.
    body.appendChild(render_research_office());
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'friends') {
    // Kate's Friends office — a CRUD GUI over the People/ person notes
    // (/api/specialists/:id/friends): per-friend facts + upcoming dates +
    // linked flight watches. Cordon-filtered per viewer.
    body.appendChild(render_friends_office());
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'postoffice') {
    // Kate's Post Office — a client-rendered surface over
    // /api/specialists/:id/postoffice: triaged inbox buckets + the Orders /
    // tracking subtab + the setup gear. Cordon-filtered per viewer.
    body.appendChild(render_post_office_view());
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'bills') {
    // Kate's Bills desk — the "lay out my bills" surface over
    // /api/specialists/:id/bills: monthly-equivalent total, the anticipation
    // probe's open flags, upcoming estimates, the service roster. Cordoned.
    body.appendChild(render_bills_view());
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'media') {
    // Kate's Archive office — the web sibling of the iOS Archive tab, over
    // /api/media/*: browse the taxonomy, inference-search the context notes,
    // and direct-play (HTTP-range 206) video/audio inline. Cordon-filtered per
    // viewer (NSFW/private items are owner-only and never returned).
    body.appendChild(render_media_office());
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'codeshop') {
    // Kate's Code Shop — the workshop in plain language. Only what is waiting on
    // the owner, a curated command row, and the live review-swarm nest.
    body.appendChild(render_codeshop_view());
  } else if (doc.pane_kind === 'briefing' && state._news_tab === 'security') {
    // Kate's Security tab. When the server tab advertises the fused native
    // room (Person Threads, `native: 'security_room'`), the room REPLACES the
    // server-composed blocks — who's home, threads, flagged, and pulse all
    // live in the one read, and the enrollment desk is a link away. Otherwise
    // (older server / flag dark) the 2026-07-15 shape renders exactly as
    // before: server blocks flat + the People surface beneath.
    const tb = (doc.blocks || []).find((b) => b.type === 'tabs');
    const sec = tb && (tb.tabs || []).find((t) => t.id === 'security');
    if (sec && sec.native === 'security_room') {
      body.appendChild(render_security_room());
    } else {
      for (const b of (sec ? sec.blocks || [] : [])) {
        const node = render_pane_block(b);
        if (node) body.appendChild(node);
      }
      body.appendChild(render_people_room());
    }
  } else if (doc.pane_kind === 'fuel' && (state._fuel_tab || 'fuel') === 'radar') {
    body.appendChild(render_market_radar_view());
  } else if (doc.pane_kind === 'library' && (state._library_tab || 'library') === 'brain') {
    body.appendChild(render_brain_view());
  } else if (doc.pane_kind === 'security') {
    // Watch / Plates unwrap the active server tab's blocks flat; People is the
    // interactive client surface (capture → tag → enroll), not a server block.
    const tab = state._security_tab || 'watch';
    if (tab === 'people') {
      body.appendChild(render_people_room());
    } else if (tab === 'home') {
      // "Who's home & where" — Household Awareness P1. Client-rendered over the
      // occupancy route (home/away presence the server pane can't resolve).
      body.appendChild(render_occupancy_room());
    } else {
      const tb = (doc.blocks || []).find((b) => b.type === 'tabs');
      const active = tb && (tb.tabs || []).find((t) => t.id === tab);
      for (const b of (active ? active.blocks || [] : [])) {
        const node = render_pane_block(b);
        if (node) body.appendChild(node);
      }
    }
  } else {
    // Kate's briefing doc is a server `tabs` primitive (Briefing | News
    // Desk — iOS renders the segmented tabs natively). The web drives
    // its OWN tab bar above (the news tab here is the richer interactive
    // /api/news surface), so UNWRAP: render the briefing tab's blocks
    // flat instead of the segmented control.
    let blocks = doc.blocks || [];
    if (doc.pane_kind === 'briefing') {
      // Any server tabs block (News Desk and/or Security) — unwrap to the
      // briefing tab's blocks; the web drives its own tab bar above.
      const tb = blocks.find((b) => b.type === 'tabs' && (b.tabs || []).some((t) => t.id === 'briefing'));
      const brief_tab = tb && (tb.tabs || []).find((t) => t.id === 'briefing');
      if (brief_tab) blocks = brief_tab.blocks || [];
    } else if (doc.pane_kind === 'library') {
      // Library | The Brain server `tabs` primitive — iOS renders the
      // segmented tabs natively; the web drives its own tab bar above and
      // shows the richer Brain CANVAS on that tab (handled by the brain
      // branch earlier), so UNWRAP to the Library tab's blocks flat here.
      const tb = blocks.find((b) => b.type === 'tabs' && (b.tabs || []).some((t) => t.id === 'brain'));
      const lib_tab = tb && (tb.tabs || []).find((t) => t.id === 'library');
      if (lib_tab) blocks = lib_tab.blocks || [];
    } else if (doc.pane_kind === 'fuel') {
      // Finances | Market Radar server `tabs` primitive — same unwrap: iOS
      // renders the tabs natively; the web shows its richer radar CANVAS on
      // that tab (the fuel/radar branch earlier), so render the Finances
      // tab's blocks flat here.
      const tb = blocks.find((b) => b.type === 'tabs' && (b.tabs || []).some((t) => t.id === 'radar'));
      const fuel_tab = tb && (tb.tabs || []).find((t) => t.id === 'fuel');
      if (fuel_tab) blocks = fuel_tab.blocks || [];
    }
    for (const b of blocks) {
      const node = render_pane_block(b);
      if (node) body.appendChild(node);
    }
  }
  pane.appendChild(body);
  pane.appendChild(_pane_foot());
}

function _pane_header(doc) {
  const h = document.createElement('div');
  h.className = 'office-head';
  const fresh = doc.generated_at ? relative_time(doc.generated_at) : '';
  h.innerHTML =
    '<div class="office-head-main">'
    + `<div class="office-head-title">${escape_html(doc.title || '')}</div>`
    + (doc.subtitle ? `<div class="office-head-sub">${escape_html(doc.subtitle)}</div>` : '')
    + '<div class="rank-badge office-rank" id="office-rank-badge" hidden></div>'
    + '</div>'
    + (fresh ? `<div class="office-head-fresh">updated ${escape_html(fresh)}</div>` : '');
  // Hearth rank badge for the office (async populate; hidden until the Trust
  // Ladder is on + a rank exists). Uses the pane's specialist id.
  populate_office_rank(h.querySelector('#office-rank-badge'), state._pane_specialist_id);
  // Recon Desk gear — manual data-pipeline controls (Kristi's competitive
  // dashboard only). Opens a popover of labelled per-step triggers.
  if (doc.pane_kind === 'competitive') {
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'office-gear';
    gear.title = 'Data pipeline controls';
    gear.setAttribute('aria-label', 'Data pipeline controls');
    gear.innerHTML = '<span class="icon">⚙️</span>';
    gear.addEventListener('click', open_recon_ops_modal);
    h.appendChild(gear);
  }
  // Code Shop gear — Beatrice's repo/credentials, safety toggles, merge
  // defaults, and metric calibration (owner only).
  if (doc.pane_kind === 'codeshop') {
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'office-gear';
    gear.title = 'Code Shop settings';
    gear.setAttribute('aria-label', 'Code Shop settings');
    gear.innerHTML = '<span class="icon">⚙️</span>';
    gear.addEventListener('click', open_codeshop_settings_modal);
    h.appendChild(gear);
  }
  // Post Office gear — connect/manage your email inboxes (self-service for
  // every user). Shown only while the Post Office tab is the active one.
  if (doc.pane_kind === 'briefing' && state._news_tab === 'postoffice') {
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'office-gear';
    gear.title = 'Connect / manage inboxes';
    gear.setAttribute('aria-label', 'Connect or manage inboxes');
    gear.innerHTML = '<span class="icon">⚙️</span>';
    gear.addEventListener('click', open_postoffice_settings_modal);
    h.appendChild(gear);
  }
  // Presence gear — room calibration, sensor mount, firmware target (owner).
  if (doc.pane_kind === 'presence') {
    const gear = document.createElement('button');
    gear.type = 'button';
    gear.className = 'office-gear';
    gear.title = 'Presence settings';
    gear.setAttribute('aria-label', 'Presence settings');
    gear.innerHTML = '<span class="icon">⚙️</span>';
    gear.addEventListener('click', open_presence_settings_modal);
    h.appendChild(gear);
  }
  return h;
}

// Recon Desk data pipeline — the steps that fill the dashboard, in dependency
// order. Each fires Kristi's matching background job (or a deliberation pass)
// on the admin-gated fire endpoints. Labels/descriptions are written for a
// human reading the gear popover, not the job names.
const RECON_OPS = [
  { phase: '1 · Discover models & leaks', jobs: [
    { name: 'scan_vendor_sources',     label: 'Scan vendor sites',        desc: 'Find current models across HP, Dell, Lenovo & NVIDIA — all four classes (desktop, mobile, rack, edge).' },
    { name: 'scan_bench_isv_sources',  label: 'Scan benchmarks & ISV',    desc: 'Independent benchmark charts + which ISVs certify which hardware.' },
    { name: 'scan_frontier_sources',   label: 'Scan the frontier',        desc: 'Edge / DGX / Windows-on-ARM disruptors + non-tier-1 builders (BOXX, Puget…).' },
    { name: 'sweep_cert_registries_am',label: 'Sweep cert registries',    desc: 'Pre-launch leak radar — DMTF / ENERGY STAR / TCO models certified but not yet announced.' },
  ] },
  { phase: '2 · Record & enrich', jobs: [
    // Deterministic SKU catalog — one focused pass per OEM (mirrors the
    // drive_configurator split). Leads the phase: a from-scratch populate needs
    // the model recorded BEFORE the research pass synthesises over it and
    // quickspecs (below) deepens its envelope + cluster_swimlanes lanes it.
    // Pure LLM-over-clippings (no web fetch) → fast/awaited inline.
    { name: 'extract_skus_hp',         label: 'Catalog HP models',        desc: 'Record every HP workstation model from the clippings — Z2 Mini/SFF/Tower, Z1/Z4/Z6/Z8 + Fury, the ZBook line, Z-rack.', fast: true },
    { name: 'extract_skus_dell',       label: 'Catalog Dell models',      desc: 'Record every Dell Precision model — Pro Precision 9 T2/T4/T6, the 3000/5000/7000 mobile lines, compact/SFF.', fast: true },
    { name: 'extract_skus_lenovo',     label: 'Catalog Lenovo models',    desc: 'Record every Lenovo ThinkStation + ThinkPad-P model — P3/P5/P7/P8/PX towers, Tiny/SFF, ThinkPad P mobile.', fast: true },
    { name: 'extract_skus_nvidia',     label: 'Catalog NVIDIA models',    desc: 'Record NVIDIA edge-AI boxes (DGX Spark / IGX) + RTX PRO workstation cards.', fast: true },
    { delib: true,                     label: 'Run a research pass',       desc: 'Read the latest clippings → synthesis, projections & any models the catalog passes missed.' },
    { name: 'acquire_quickspecs',      label: 'Fetch spec sheets',        desc: 'Pull config maximums (max cores / memory / GPUs / PSU) from official QuickSpecs / PSREF / spec sheets.' },
    { name: 'acquire_pricing',         label: 'Acquire pricing',          desc: 'System + per-OEM component prices from vendor & reseller pages.' },
    { name: 'drive_configurator_hp',   label: 'Drive HP configurator',    desc: 'Live per-OEM option price deltas from HP’s “Customize & buy” flow (slow; browser-driven).' },
    { name: 'drive_configurator_dell', label: 'Drive Dell configurator',  desc: 'Same, for Dell (slow; browser-driven).' },
    { name: 'lookup_market_prices',    label: 'Look up market prices',    desc: 'Open-market street price per component, beside each OEM’s markup.' },
  ] },
  // Phase 3 + 4 jobs are pure LLM-over-clippings / store work (no web fetch),
  // so the gear awaits them inline (?wait=1) and the spinner runs until they
  // ACTUALLY conclude — `fast: true`. The browser/fetch jobs above stay
  // detached (awaiting a multi-minute browser job would hit a proxy timeout).
  { phase: '3 · Extract structured rows', jobs: [
    { name: 'extract_prices',          label: 'Extract system prices',    desc: 'Lift whole-system prices out of the fetched pages.', fast: true },
    { name: 'extract_commodity_prices',label: 'Extract component prices', desc: 'Lift per-OEM component / option prices.', fast: true },
    { name: 'extract_isv_certs',       label: 'Extract ISV certs',        desc: 'Lift ISV certified-hardware facts.', fast: true },
    { name: 'extract_radar',           label: 'Extract threat radar',     desc: 'Lift threats / new players / platform shifts.', fast: true },
  ] },
  { phase: '4 · Crunch & write', jobs: [
    { name: 'cluster_swimlanes',       label: 'Cluster swimlanes',        desc: 'Group SKUs by capability envelope so like competes with like (needed for the gap view).', fast: true },
    { name: 'reconcile_leak_radar',    label: 'Reconcile leak radar',     desc: 'Drop already-shipping certs, keep only genuine pre-launch leaks.', fast: true },
    { name: 'derive_swimlane_profiles',label: 'Derive lane profiles',     desc: 'Who each swimlane is for — personas / ICP / UCP, shown as the “Who it’s for” tap-down under a lane. Needs swimlanes clustered first.', fast: true },
    { name: 'assess_competitive_items',label: 'Write assessments',        desc: 'Kristi’s per-item analysis shown when you tap a row.', fast: true },
  ] },
];

const _RECON_SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const _RECON_SPEC = 'kristi';
// The deliberation ("research pass") step is tracked server-side under this
// synthetic job name (DELIBERATION_JOB_KEY in src/core/job_runs.ts).
const _RECON_DELIB_KEY = '__deliberation__';
// Cap on how long we'll poll a single step for completion before giving up on
// the UI (the server job keeps running regardless; reopening the gear re-seeds
// from the live tracker). 25 min covers the slowest configurator drive.
const _RECON_POLL_MS = 1500;
const _RECON_POLL_DEADLINE_MS = 25 * 60 * 1000;

function _recon_job_key(job) { return job.delib ? _RECON_DELIB_KEY : job.name; }

// Poll the server's job-run tracker. Returns a `{ <jobKey>: { status,
// duration_ms, error } }` map (empty on any failure — the caller keeps spinning).
async function _recon_status() {
  try {
    const r = await fetch(`/api/specialists/${_RECON_SPEC}/background_jobs/status`, { credentials: 'include' });
    if (!r.ok) return {};
    const x = await r.json().catch(() => ({}));
    return (x && x.jobs) || {};
  } catch (_) {
    return {};
  }
}

// Poll until this job leaves the `running` state on the server (or we hit the
// deadline). The server records ACTUAL completion of even the detached browser
// jobs, so this resolves only when the work is genuinely done.
async function _recon_poll_until_done(job) {
  const key = _recon_job_key(job);
  const deadline = performance.now() + _RECON_POLL_DEADLINE_MS;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, _RECON_POLL_MS));
    const rec = (await _recon_status())[key];
    if (!rec || rec.status === 'running') continue;
    if (rec.status === 'ok') return { ok: true, secs: ((rec.duration_ms || 0) / 1000).toFixed(1) };
    return { ok: false, error: rec.error };
  }
  return { ok: false, error: 'timed out waiting for completion' };
}

// Drive a row's braille spinner until `done_fn()` resolves, then render a
// persistent ✓ / ✗. `done_fn` returns `{ ok, secs?, error? }` (or throws).
// Shared by a fresh fire (kickoff + poll) and a resumed-on-reopen poll.
async function _recon_spin_until(btn, status, done_fn) {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Running…';
  status.className = 'recon-op-status running';
  let f = 0;
  status.textContent = _RECON_SPIN[0];
  const spin = setInterval(() => { status.textContent = _RECON_SPIN[++f % _RECON_SPIN.length]; }, 90);
  try {
    const done = await done_fn();
    if (!done.ok) throw new Error(done.error || 'job failed');
    status.className = 'recon-op-status ok';
    status.textContent = `✓ done · ${done.secs}s`;
    return true;
  } catch (e) {
    status.className = 'recon-op-status err';
    status.textContent = '✗ ' + ((e && e.message) ? e.message.slice(0, 70) : 'failed');
    return false;
  } finally {
    clearInterval(spin);
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Fire one step, then poll the server tracker until it ACTUALLY completes — the
// spinner spans the real work (a multi-minute scan or configurator drive
// included), and the ✓ persists until the step is re-run. Returns success.
async function _recon_fire(job, btn, status) {
  return _recon_spin_until(btn, status, async () => {
    const url = job.delib
      ? `/api/specialists/${_RECON_SPEC}/fire_deliberation?slot=07:30&detached=1`
      : `/api/specialists/${_RECON_SPEC}/fire_background_job?name=${encodeURIComponent(job.name)}`;
    const r = await fetch(url, { method: 'POST', credentials: 'include' });
    const x = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(x.error || `HTTP ${r.status}`);
    if (x.ok === false) throw new Error(x.error || 'failed to start');
    return _recon_poll_until_done(job);
  });
}

// Re-attach a spinner+poll to a step the server reports as already running
// (e.g. the gear was closed mid-run and reopened) — no new kickoff.
async function _recon_resume_running(job, btn, status) {
  return _recon_spin_until(btn, status, () => _recon_poll_until_done(job));
}

// Seed the gear from the server's tracker when it opens: persistent ✓/✗ for
// steps that ran this orchestrator lifetime, and a live spinner that resumes
// polling for anything still running.
async function _recon_seed(modal) {
  const jobs = await _recon_status();
  modal.querySelectorAll('.recon-op').forEach((row) => {
    const job = RECON_OPS[+row.dataset.g].jobs[+row.dataset.j];
    const rec = jobs[_recon_job_key(job)];
    if (!rec) return;
    const btn = row.querySelector('.recon-op-btn');
    const status = row.querySelector('.recon-op-status');
    if (rec.status === 'ok') {
      status.className = 'recon-op-status ok';
      status.textContent = `✓ done · ${((rec.duration_ms || 0) / 1000).toFixed(1)}s`;
    } else if (rec.status === 'failed') {
      status.className = 'recon-op-status err';
      status.textContent = '✗ ' + (rec.error ? String(rec.error).slice(0, 70) : 'failed');
    } else if (rec.status === 'running') {
      _recon_resume_running(job, btn, status);
    }
  });
}

// "Run everything" — fire the WHOLE pipeline in dependency order, one step at a
// time, NO overlap. Because _recon_fire now polls each step to ACTUAL
// completion (fast LLM jobs and slow browser jobs alike), the next step never
// starts until the prior genuinely finishes — no gap heuristic needed.
async function _recon_fire_all(all_btn, modal) {
  const steps = Array.from(modal.querySelectorAll('.recon-op')).map((row) => ({
    row,
    job: RECON_OPS[+row.dataset.g].jobs[+row.dataset.j],
    btn: row.querySelector('.recon-op-btn'),
    status: row.querySelector('.recon-op-status'),
  }));
  const prog = modal.querySelector('.recon-ops-allprog');
  all_btn.disabled = true;
  const prev = all_btn.textContent;
  let failed = 0;
  // Reset every row to a "queued" state so the cascade reads cleanly.
  steps.forEach(({ btn, status }) => {
    btn.disabled = true;
    status.className = 'recon-op-status';
    status.textContent = '· queued';
  });
  for (let i = 0; i < steps.length; i++) {
    const { row, job, btn, status } = steps[i];
    all_btn.textContent = `Running ${i + 1}/${steps.length}…`;
    if (prog) {
      prog.className = 'recon-ops-allprog running';
      prog.textContent = `Step ${i + 1} of ${steps.length}: ${job.label}`;
    }
    if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    const ok = await _recon_fire(job, btn, status);
    btn.disabled = true; // keep locked while the sequencer owns the pipeline
    if (!ok) failed++;
  }
  steps.forEach(({ btn }) => { btn.disabled = false; });
  all_btn.disabled = false;
  all_btn.textContent = prev;
  if (prog) {
    if (failed) {
      prog.className = 'recon-ops-allprog err';
      prog.textContent = `Done — ${steps.length - failed}/${steps.length} steps completed, ${failed} reported an error (see rows above).`;
    } else {
      prog.className = 'recon-ops-allprog ok';
      prog.textContent = `All ${steps.length} steps completed. The dashboard is up to date.`;
    }
  }
}

function open_recon_ops_modal() {
  const prior = document.getElementById('recon-ops-dynamic');
  if (prior) prior.remove();
  const modal = document.createElement('div');
  modal.id = 'recon-ops-dynamic';
  modal.className = 'modal modal-recon-ops';
  const groups = RECON_OPS.map((group, gi) =>
    `<div class="recon-op-group"><div class="recon-op-phase">${escape_html(group.phase)}</div>`
    + group.jobs.map((j, ji) =>
        `<div class="recon-op" data-g="${gi}" data-j="${ji}">`
        + `<div class="recon-op-text"><div class="recon-op-label">${escape_html(j.label)}</div>`
        + `<div class="recon-op-desc">${escape_html(j.desc)}</div></div>`
        + `<div class="recon-op-run"><button type="button" class="recon-op-btn">Run</button>`
        + `<div class="recon-op-status"></div></div></div>`
      ).join('')
    + '</div>'
  ).join('');
  modal.innerHTML =
    `<div class="modal-inner recon-ops-inner" role="dialog" aria-modal="true">`
    + `<div class="recon-ops-head"><h3>Recon Desk — data pipeline</h3>`
    + `<button type="button" class="iconbtn" data-act="close" aria-label="Close"><span class="icon">✕</span></button></div>`
    + `<p class="modal-sub">Trigger each step manually, or hit <b>Run everything</b> to fire the whole pipeline in order — one step at a time, no overlap. Scans &amp; the research pass run in the background (give them a few minutes before the dashboard fills).</p>`
    + `<div class="recon-ops-allbar"><button type="button" class="recon-op-btn recon-op-all">▶ Run everything</button>`
    + `<div class="recon-ops-allprog"></div></div>`
    + groups
    + `</div>`;
  document.body.appendChild(modal);
  document.getElementById('modal-backdrop').hidden = false;
  document.body.classList.add('modal-open');
  state.modal = 'recon-ops-dynamic';
  modal.querySelector('[data-act="close"]').addEventListener('click', close_all_modals);
  const all_btn = modal.querySelector('.recon-op-all');
  if (all_btn) all_btn.addEventListener('click', () => _recon_fire_all(all_btn, modal));
  modal.querySelectorAll('.recon-op').forEach((row) => {
    const job = RECON_OPS[+row.dataset.g].jobs[+row.dataset.j];
    const btn = row.querySelector('.recon-op-btn');
    const status = row.querySelector('.recon-op-status');
    btn.addEventListener('click', () => _recon_fire(job, btn, status));
  });
  // Seed persistent ✓/✗ (and resume spinners for anything still running) from
  // the server tracker, so checkmarks survive closing & reopening the gear.
  _recon_seed(modal);
}

function _pane_foot() {
  const spec = state.by_id.get(state.active_id);
  const foot = document.createElement('div');
  foot.className = 'office-foot';
  foot.id = 'office-foot';
  // Action bar: capture media to this specialist (same pipeline as the
  // composer's attach), and open the conversation. The context donut docks
  // here too when a cozy theme relocates it off the hidden composer.
  foot.innerHTML =
    '<button class="iconbtn office-attach" id="office-attach" type="button" title="Attach photos or files" aria-label="Attach"><span class="icon">📎</span></button>'
    + `<button class="office-pill" type="button">Talk to ${escape_html(spec ? spec.name : 'your specialist')} →</button>`;
  foot.querySelector('.office-pill').addEventListener('click', () => set_surface('chat'));
  foot.querySelector('#office-attach').addEventListener('click', open_media_picker);
  return foot;
}

function render_pane_empty(id, err) {
  const pane = _office_pane_el();
  if (!pane) return;
  const spec = state.by_id.get(id);
  pane.innerHTML =
    '<div class="office-empty"><div class="office-empty-ico">🏛️</div>'
    + `<div class="office-empty-t">${escape_html(spec ? spec.name : 'This specialist')}'s office is quiet right now</div>`
    + '<div class="office-empty-s">Nothing composed for this view yet — the conversation is always open.</div></div>';
  pane.appendChild(_pane_foot());
  if (err) console.debug('[office] pane unavailable', id, err.message);
}

function render_pane_block(b) {
  if (!b || typeof b.type !== 'string') return null;
  switch (b.type) {
    case 'hero_metric': return _blk_hero(b);
    case 'load_chart': return b.kind === 'sparkline' ? _blk_spark(b) : _blk_bars(b);
    case 'stacked_strip': return _blk_strip(b);
    case 'list': return _blk_list(b);
    case 'link': return _blk_link(b);
    case 'text': return _blk_text(b);
    case 'embed': return _blk_embed(b);
    case 'tabs': return _blk_tabs(b);
    case 'team_health': return _blk_team_health(b);
    case 'recommendation': return _blk_recommendation(b);
    default: return null;            // forward-compat: unknown block → nothing
  }
}

// Segmented/tabbed group — a tab bar at the top, each tab holding its OWN
// blocks (rendered recursively through render_pane_block). Kristi's Recon Desk
// uses it to toggle Desktop / Mobile / Rack / Edge-AI. Client-side switch; the
// active tab's blocks are (re)painted on click.
function _blk_tabs(b) {
  const tabs = Array.isArray(b.tabs) ? b.tabs : [];
  const wrap = document.createElement('div');
  wrap.className = 'office-block office-tabs';
  if (!tabs.length) return wrap;
  const bar = document.createElement('div');
  bar.className = 'office-tabbar';
  bar.setAttribute('role', 'tablist');
  const body = document.createElement('div');
  body.className = 'office-tab-body';

  let active = 0;
  const paint = () => {
    Array.from(bar.children).forEach((btn, i) => {
      const on = i === active;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    body.innerHTML = '';
    for (const blk of (tabs[active].blocks || [])) {
      const node = render_pane_block(blk);
      if (node) body.appendChild(node);
    }
  };

  tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'office-tab';
    btn.setAttribute('role', 'tab');
    btn.innerHTML = escape_html(t.label || '')
      + (typeof t.badge === 'number' && t.badge > 0
        ? ` <span class="office-tab-badge">${t.badge}</span>`
        : '');
    btn.addEventListener('click', () => { active = i; paint(); });
    bar.appendChild(btn);
  });

  wrap.appendChild(bar);
  wrap.appendChild(body);
  paint();
  return wrap;
}

function _blk_hero(b) {
  const down = /down/.test(b.delta_kind || '');
  return _oel(
    '<div class="office-block office-hero">'
    + `<div class="office-hero-val">${escape_html(b.value)}</div>`
    + '<div class="office-hero-col">'
    + `<div class="office-hero-lab">${escape_html(b.label)}</div>`
    + (b.delta
      ? `<span class="office-delta ${escape_html(b.delta_kind || 'neutral')}"><span class="arw">${down ? '▼' : '▲'}</span>${escape_html(b.delta)}</span>`
      : '')
    + '</div></div>');
}

function _blk_bars(b) {
  const pts = b.points || [];
  const max = Math.max(1, ...pts.map((p) => p.y || 0));
  // Bars scale to the height_hint so a 'md' chart has real presence in the
  // pane (matches the iOS LoadChartCard). 'sm' keeps the original compact look.
  const tall = b.height_hint === 'md';
  const span = tall ? 116 : 72;
  const cols = pts.map((p) => {
    const h = Math.round(((p.y || 0) / max) * span) + 3;
    const tip = p.detail || (p.label ? `${p.label}: ${p.y}` : String(p.y));
    return '<div class="office-bar-col">'
      + `<span class="office-bar-tip">${escape_html(tip)}</span>`
      + `<div class="office-bar" style="height:${h}px"></div>`
      + (p.label ? `<span class="office-bar-x">${escape_html(p.label)}</span>` : '')
      + '</div>';
  }).join('');
  return _oel(
    '<div class="office-block">'
    + (b.title ? `<div class="office-block-title">${escape_html(b.title)}</div>` : '')
    + `<div class="office-card office-bars${tall ? ' office-bars-md' : ''}"><span class="office-bars-grid"></span>${cols}</div></div>`);
}

function _blk_spark(b) {
  const ys = (b.points || []).map((p) => p.y || 0);
  const n = ys.length;
  const max = Math.max(1, ...ys);
  const W = 300;
  const H = 54;
  const X = (i) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const Y = (v) => H - (v / max) * H;
  const line = ys.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const last = ys.length - 1;
  return _oel(
    '<div class="office-block">'
    + (b.title ? `<div class="office-block-title">${escape_html(b.title)}</div>` : '')
    + `<div class="office-card office-spark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
    + `<path class="office-spark-fill" d="${area}"/><path class="office-spark-ln" d="${line}"/>`
    + (last >= 0 ? `<circle class="office-spark-pt" cx="${X(last).toFixed(1)}" cy="${Y(ys[last]).toFixed(1)}" r="3.2"/>` : '')
    + '</svg></div></div>');
}

function _blk_strip(b) {
  const segs = b.segments || [];
  const tot = segs.reduce((a, s) => a + (s.value || 0), 0) || 1;
  const unit = b.title && /min/i.test(b.title) ? 'm' : '';
  const bar = segs.map((s, i) => `<span style="flex-grow:${s.value || 0};background:${_office_hue(s.hue, i, segs.length)}"></span>`).join('');
  const leg = segs.map((s, i) =>
    `<div class="office-leg-item"><span class="office-sw" style="background:${_office_hue(s.hue, i, segs.length)}"></span>${escape_html(s.label)} · ${escape_html(String(s.value))}${unit}</div>`).join('');
  return _oel(
    '<div class="office-block">'
    + (b.title ? `<div class="office-block-title">${escape_html(b.title)}</div>` : '')
    + `<div class="office-card office-strip"><div class="office-strip-bar">${bar}</div><div class="office-strip-leg">${leg}</div></div></div>`);
}

// One office list row. Supports tap-through (web parity with iOS): an item with
// `detail_md` and/or per-item `charts` becomes an expandable disclosure — tap to
// reveal the rendered markdown + sparklines below. Otherwise a `deep_link` makes
// it a navigating row. Returns a wrapper so the expanded detail nests under it.
function _office_list_row(it) {
  it = it || {};
  const { title, subtitle, deep_link, detail_md } = it;
  const charts = it.charts || [];
  const expandable = !!(detail_md || charts.length);
  const ext = /^https?:/i.test(deep_link || '');

  const wrap = document.createElement('div');
  wrap.className = 'office-row-wrap';

  // Optional leading thumbnail (Linda's resale cards): a Cordelia capture id
  // resolves to the thumbnail endpoint. Hidden on load error so a missing
  // attachment leaves a clean text row, not a broken-image glyph.
  // frame_event_id (2026-07-15): the Security tab's Flagged rows carry the
  // camera frame the concern is about — same contract, security endpoint
  // (owner-gated; the img 404s cleanly once the event's frame ages out).
  const thumb = it.thumb_capture_id
    ? `<img class="office-row-thumb" loading="lazy" alt=""`
      + ` src="/api/cordelia/thumbnail/${encodeURIComponent(it.thumb_capture_id)}"`
      + ` onerror="this.remove()">`
    : it.frame_event_id
      ? `<img class="office-row-thumb" loading="lazy" alt=""`
        + ` src="/api/specialists/cassandra/security/frame/${encodeURIComponent(it.frame_event_id)}"`
        + ` onerror="this.remove()">`
      : '';

  const row = document.createElement('div');
  row.className = 'office-row'
    + (thumb ? ' office-row-thumbed' : '')
    + (expandable ? ' office-row-exp' : (deep_link ? ' office-row-link' : ''));
  row.innerHTML =
    thumb
    + `<div class="office-row-tx"><div class="office-row-t">${escape_html(title || '')}${ext ? ' <span class="office-ext">↗</span>' : ''}</div>`
    + (subtitle ? `<div class="office-row-s">${escape_html(subtitle)}</div>` : '')
    + '</div>'
    + (expandable ? '<span class="office-chev office-chev-exp">›</span>'
       : deep_link ? '<span class="office-chev">›</span>' : '');
  wrap.appendChild(row);

  if (expandable) {
    const det = document.createElement('div');
    det.className = 'office-row-detail';
    det.style.display = 'none';
    if (detail_md) {
      const md = document.createElement('div');
      md.className = 'office-row-md markdown-body';
      md.innerHTML = render_md(detail_md);
      det.appendChild(md);
    }
    for (const c of charts) det.appendChild(c.kind === 'sparkline' ? _blk_spark(c) : _blk_bars(c));
    wrap.appendChild(det);
    row.addEventListener('click', () => {
      const open = det.style.display !== 'none';
      det.style.display = open ? 'none' : '';
      row.classList.toggle('office-row-open', !open);
    });
  } else if (deep_link) {
    row.addEventListener('click', () => resolve_deep_link(deep_link));
  }
  return wrap;
}

function _blk_list(b) {
  const wrap = _oel(
    '<div class="office-block">'
    + (b.title ? `<div class="office-block-title">${escape_html(b.title)}</div>` : '')
    + '<div class="office-card office-list"></div></div>');
  const list = wrap.querySelector('.office-list');
  for (const it of (b.items || [])) list.appendChild(_office_list_row(it));
  return wrap;
}

function _blk_link(b) {
  const wrap = _oel('<div class="office-block"><div class="office-card office-list"></div></div>');
  wrap.querySelector('.office-list').appendChild(_office_list_row(b));
  return wrap;
}

function _blk_text(b) {
  const wrap = document.createElement('div');
  wrap.className = 'office-block office-text';
  wrap.innerHTML = render_md(b.body_md || '');
  return wrap;
}

function _blk_embed(b) {
  // Kate's office — her latest brief in-room. Reuses the exact renderer the
  // Today rail uses (`load_brief_into`), so the two never drift.
  if (b.view === 'brief') {
    const wrap = _oel(
      '<div class="office-block"><div class="office-block-title">Today’s brief</div>'
      + '<div class="office-card office-brief-card" id="office-brief-card"><div class="rail-empty">Loading…</div></div></div>');
    load_brief_into(wrap.querySelector('#office-brief-card'));
    return wrap;
  }
  // `library` (Cordelia) is the only other embed today. Render the recent-items
  // list inline by reusing the rail's loader; the full file manager is /files.
  const wrap = _oel(
    '<div class="office-block"><div class="office-block-title">Library</div>'
    + '<div class="office-card office-embed"><div class="office-embed-list"><div class="rail-empty">Loading…</div></div>'
    + '<a class="office-embed-open" href="/files">Open the full library →</a></div></div>');
  if (b.view === 'library') load_library_list(state.active_id, wrap.querySelector('.office-embed-list'));
  return wrap;
}

// Kate's "how's the team doing" glance — the web mirror of the iOS
// TeamHealthBlock. Concise by design: a pulse + one-line headline, a tight Brief
// row (with a mood-trend), an Escalations line only when there's signal, and
// one-line stuck-work rows (full detail on hover) — no count duplication, no
// machine-ledger dump. Owner-gated on the backend, so a non-owner never gets it.
// Styled via .office-team* classes in app.css; the pulse/mood colors track the
// theme palette (ok / accent / danger).
function _blk_team_health(b) {
  const pulse = b.pulse || 'calm';
  const PULSE = { calm: 'var(--ok, #5fb87a)', attentive: 'var(--accent, #c9a35e)', concerned: 'var(--danger, #d9706a)' };
  const pc = PULSE[pulse] || PULSE.calm;
  const cad = b.brief_cadence || {};
  const esc = b.escalations || {};
  const stuck = Array.isArray(b.stuck_work) ? b.stuck_work : [];

  const moodDots = (Array.isArray(cad.recent_moods) ? cad.recent_moods.slice(0, 5) : [])
    .map((m) => `<span class="office-team-mood" style="background:${PULSE[m] || 'var(--text-muted)'}"></span>`)
    .join('');

  const cadenceVal = cad.last_generated_at
    ? `${escape_html(relative_time(cad.last_generated_at))} · <span style="color:${cad.consumed ? 'var(--text-muted)' : 'var(--accent, #c9a35e)'}">${cad.consumed ? 'read' : 'unread'}</span>`
    : 'none yet';

  // Escalations row only when there's something to say — keeps a calm office quiet.
  let escRow = '';
  if (esc.today_total || esc.still_open) {
    const parts = [];
    if (esc.today_total) {
      parts.push(`${esc.today_total} today`);
      if (esc.cleared_by_kate) parts.push(`Kate cleared ${esc.cleared_by_kate}`);
    }
    if (esc.still_open) parts.push(`${esc.still_open} open`);
    escRow = `<div class="office-team-meta"><span class="k">Escalations</span><span>${escape_html(parts.join(' · '))}</span></div>`;
  }

  // One concise line per stuck item; the full ledger gap is the hover title.
  const SEVCLASS = { high: 'high', medium: 'med', low: 'low' };
  const SEVLABEL = { high: 'high', medium: 'watching', low: 'low' };
  const stuckHtml = stuck.length
    ? '<div class="office-team-stuck"><div class="office-team-stuck-label">Behind the scenes</div>'
      + stuck.map((s) => {
        const spec = state.by_id && state.by_id.get(s.subject_specialist_id);
        const who = escape_html(spec ? spec.name : String(s.subject_specialist_id || '').replace(/^\w/, (c) => c.toUpperCase()));
        const what = escape_html((s.task_summary || s.gap || '').trim());
        const tip = escape_html((s.gap || '').trim());
        const sev = SEVCLASS[s.severity] || 'low';
        return `<div class="office-team-row"${tip ? ` title="${tip}"` : ''}>`
          + `<span class="who">${who}</span>`
          + `<span class="what">${what}</span>`
          + `<span class="office-sev ${sev}">${SEVLABEL[s.severity] || 'low'}</span>`
          + '</div>';
      }).join('')
      + '</div>'
    : '';

  return _oel(
    '<div class="office-block"><div class="office-card office-team">'
    + '<div class="office-team-head">'
    +   `<span class="office-team-dot" style="color:${pc};background:${pc}"></span>`
    +   '<span class="office-team-eyebrow">The team</span>'
    +   `<span class="office-team-state" style="color:${pc}">${escape_html(pulse)}</span>`
    + '</div>'
    + (b.headline ? `<div class="office-team-line">${escape_html(b.headline)}</div>` : '')
    + `<div class="office-team-meta"><span class="k">Brief</span><span>${cadenceVal}</span><span class="office-team-moods">${moodDots}</span></div>`
    + escRow
    + stuckHtml
    + '</div></div>');
}

// Kate's recommendation card — a concern she couldn't settle herself, with her
// recommendation, what she tried, context-sensitive action buttons (decided
// through the normal proposal pipeline, so the decision trains her autonomy),
// and an inline "Ask Kate" reply. Owner-gated on the backend.
function _blk_recommendation(b) {
  const actions = Array.isArray(b.actions) ? b.actions : [];
  const wrap = _oel('<div class="office-block"><div class="office-card office-rec"></div></div>');
  const card = wrap.querySelector('.office-rec');

  const srcSpec = b.source_specialist_id && state.by_id ? state.by_id.get(b.source_specialist_id) : null;
  const srcName = srcSpec ? srcSpec.name : (b.source_specialist_id || '');

  card.innerHTML =
    '<div class="office-rec-head">'
    + `<div class="office-rec-title">${escape_html(b.title || 'Recommendation')}</div>`
    + (srcName ? `<div class="office-rec-src">${escape_html(srcName)} raised this</div>` : '')
    + '</div>'
    + (b.note_md ? `<div class="office-rec-note markdown-body">${render_md(b.note_md)}</div>` : '')
    + (b.attempt_md
        ? `<details class="office-rec-tried"><summary>What I tried</summary>`
          + `<div class="markdown-body">${render_md(b.attempt_md)}</div></details>`
        : '');

  const row = document.createElement('div');
  row.className = 'office-rec-actions';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = 'office-rec-btn office-rec-' + (a.style || 'secondary');
    btn.textContent = a.label || a.id;
    if (a.description) btn.title = a.description;
    btn.addEventListener('click', () => _decide_recommendation(b.proposal_id, a, btn));
    row.appendChild(btn);
  }
  if (b.ask_back) {
    const ask = document.createElement('button');
    ask.className = 'office-rec-btn office-rec-ask';
    ask.textContent = 'Ask Kate';
    ask.addEventListener('click', () => _toggle_rec_ask(card, b.proposal_id));
    row.appendChild(ask);
  }
  card.appendChild(row);

  const area = document.createElement('div');
  area.className = 'office-rec-ask-area';
  area.hidden = true;
  area.innerHTML =
    '<textarea class="office-rec-ask-input" rows="2" placeholder="Ask Kate about this…"></textarea>'
    + '<div class="office-rec-ask-row"><button class="office-rec-btn office-rec-primary office-rec-ask-send" type="button">Send</button></div>'
    + '<div class="office-rec-answer markdown-body" hidden></div>';
  card.appendChild(area);

  return wrap;
}

async function _decide_recommendation(proposal_id, action, btn) {
  if (action.effect === 'reject' && !window.confirm('Dismiss this recommendation?')) return;
  const row = btn.parentElement;
  const buttons = Array.from(row.querySelectorAll('button'));
  buttons.forEach((x) => { x.disabled = true; });
  const label = btn.textContent;
  btn.textContent = '…';
  try {
    await api(`/api/proposals/${proposal_id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_id: action.id }),
    });
    const verb = action.effect === 'reject' ? 'Dismissed'
      : action.effect === 'defer' ? 'Saved for later'
      : 'Done — Kate’s on it';
    toast(verb + '.');
    if (state.active_id) await load_pane(state.active_id);
  } catch (e) {
    const m = String((e && e.message) || e);
    buttons.forEach((x) => { x.disabled = false; });
    btn.textContent = label;
    if (/step.?up|pin/i.test(m)) toast('That needs your PIN — approve it from the Proposals queue.', true);
    else toast('Failed: ' + m, true);
  }
}

function _toggle_rec_ask(card, proposal_id) {
  const area = card.querySelector('.office-rec-ask-area');
  if (!area) return;
  area.hidden = !area.hidden;
  if (area.hidden) return;
  const input = area.querySelector('.office-rec-ask-input');
  input.focus();
  const send = area.querySelector('.office-rec-ask-send');
  if (!send.dataset.wired) {
    send.dataset.wired = '1';
    send.addEventListener('click', () => _send_rec_ask(area, proposal_id, send));
  }
}

async function _send_rec_ask(area, proposal_id, send) {
  const input = area.querySelector('.office-rec-ask-input');
  const answer = area.querySelector('.office-rec-answer');
  const q = (input.value || '').trim();
  if (!q) return;
  send.disabled = true;
  input.disabled = true;
  send.textContent = 'Kate’s thinking…';
  try {
    const res = await api(`/api/proposals/${proposal_id}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });
    answer.innerHTML = render_md(res.answer_md || '_(no reply)_');
    answer.hidden = false;
    input.value = '';
  } catch (e) {
    answer.innerHTML = render_md('_Couldn’t reach Kate: ' + String((e && e.message) || e) + '_');
    answer.hidden = false;
  } finally {
    send.disabled = false;
    input.disabled = false;
    send.textContent = 'Send';
  }
}

// Resolve a block's deep_link to a web action. The composer emits external
// ticket/tour/source URLs (open in a tab) plus one internal scheme today
// (Astrid's live-workout cue silence — a phone/Watch-side action).
function resolve_deep_link(url) {
  if (!url) return;
  if (/^https?:/i.test(url)) { window.open(url, '_blank', 'noopener'); return; }
  // Root-relative internal pages (/app/rides, /app/scrum-canvas, …) —
  // same-origin navigation in this tab. Pre-fix these fell through to
  // the toast and the Ride Log link just flashed its own path.
  if (url.startsWith('/')) { window.location.assign(url); return; }
  // A ride deep-link (hearth://workout/session/<id>) — iOS opens the
  // native ride detail; on web, take them to the Ride Log page (which
  // renders the route map + cue pins per ride).
  if (url.startsWith('hearth://workout/session/')) { window.location.assign('/app/rides'); return; }
  // Code Shop hero "Approve & merge" — codeshop:merge:<proposal_id>.
  if (url.startsWith('codeshop:merge:')) { codeshop_approve_merge(url.slice('codeshop:merge:'.length)); return; }
  if (url.startsWith('hearth://')) { toast('That action lives on your phone or Watch.'); return; }
  toast(url);
}

// Approve a Beatrice change's merge from the Code Shop hero. Reuses the
// proposal decide endpoint (owner-gated). A code merge demands a PIN step-up;
// we prompt for the PIN, grant the step-up (/api/auth/step_up), and RETRY the
// decide inline — the merge proposal is a `recommendation` kind, which the
// general Proposals queue filters out, so this is the only place it can be
// approved on the web.
async function codeshop_approve_merge(proposal_id) {
  if (!proposal_id) return;
  if (!window.confirm('Approve & merge this change? Beatrice will merge it to main.')) return;
  const do_decide = () =>
    api(`/api/proposals/${proposal_id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve' }),
    });
  try {
    await do_decide();
  } catch (e) {
    const m = String((e && e.message) || e);
    if (!/step.?up|pin/i.test(m)) {
      toast('Merge failed: ' + m, true);
      return;
    }
    // PIN step-up, then retry the decide.
    const pin = window.prompt('This merge needs your PIN to approve:');
    if (pin == null) return;
    if (!/^\d{4,8}$/.test(pin.trim())) {
      toast('PIN must be 4–8 digits.', true);
      return;
    }
    try {
      const pin_sha256 = await _sha256_hex(pin.trim());
      const step = await fetch('/api/auth/step_up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin_sha256 }),
      });
      if (!step.ok) {
        const j = await step.json().catch(() => ({}));
        toast(j.error || `PIN step-up failed (HTTP ${step.status})`, true);
        return;
      }
      await do_decide();
    } catch (e2) {
      toast('Merge failed: ' + String((e2 && e2.message) || e2), true);
      return;
    }
  }
  toast('Merging — Beatrice is on it.');
  if (typeof refresh_proposals === 'function') { try { await refresh_proposals(); } catch { /* best-effort */ } }
  if (state.active_id) await load_pane(state.active_id);
}

async function open_codeshop_settings_modal() {
  const prior = document.getElementById('codeshop-settings-dynamic');
  if (prior) prior.remove();
  let cfg;
  try {
    cfg = await api('/api/codeshop/settings');
  } catch (e) {
    toast('Code Shop settings: ' + ((e && e.message) || e), true);
    return;
  }
  const modal = document.createElement('div');
  modal.id = 'codeshop-settings-dynamic';
  modal.className = 'modal modal-codeshop';
  const text = (k, v, ph) =>
    `<label class="cs-field"><span>${escape_html(k)}</span><input data-k="${k}" type="text" value="${escape_html(v == null ? '' : v)}" placeholder="${escape_html(ph || '')}"></label>`;
  const pass = (k, isSet) =>
    `<label class="cs-field"><span>${escape_html(k)} ${isSet ? '<em class="cs-set">✓ set</em>' : '<em class="cs-unset">unset</em>'}</span>`
    + `<input data-k="${k}" type="password" autocomplete="new-password" placeholder="${isSet ? '•••••• (blank = keep)' : 'paste token'}"></label>`;
  const check = (k, v, label) =>
    `<label class="cs-check"><input data-k="${k}" type="checkbox" ${v ? 'checked' : ''}> ${escape_html(label)}</label>`;
  const num = (k, v, label) =>
    `<label class="cs-field"><span>${escape_html(label)}</span><input data-k="${k}" type="number" step="any" value="${escape_html(String(v))}"></label>`;
  const sel = (k, v, opts) =>
    `<label class="cs-field"><span>merge method</span><select data-k="${k}">${opts.map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
  modal.innerHTML =
    '<div class="modal-inner cs-inner" role="dialog" aria-modal="true">'
    + '<div class="recon-ops-head"><h3>Code Shop settings</h3><button type="button" class="iconbtn" data-act="close" aria-label="Close"><span class="icon">✕</span></button></div>'
    + '<p class="modal-sub">Beatrice\'s repo, credentials, safety &amp; metric tuning. The Gitea <b>token is what makes merge work</b> — it\'s stored server-side and never shown again.</p>'
    + `<div class="cs-sec"><h4>Repository</h4>${text('gitea_base_url', cfg.gitea_base_url)}${text('gitea_owner', cfg.gitea_owner)}${text('gitea_repo', cfg.gitea_repo)}${text('base_branch', cfg.base_branch)}${text('github_url', cfg.github_url)}</div>`
    + `<div class="cs-sec"><h4>Credentials (write-only)</h4>${pass('gitea_token', cfg.gitea_token_set)}${pass('github_token', cfg.github_token_set)}</div>`
    + `<div class="cs-sec"><h4>Safety</h4>${check('paused', cfg.paused, 'Pause Beatrice (stop opening changes)')}${check('require_pin_code_merge', cfg.require_pin_code_merge, 'Require PIN to merge code changes')}${check('auto_pull_config_merges', cfg.auto_pull_config_merges, 'Auto-pull config-only merges (hot-reload, no restart)')}</div>`
    + `<div class="cs-sec"><h4>Merge defaults</h4>${sel('merge_method', cfg.merge_method, ['merge', 'squash', 'rebase'])}${check('github_required', cfg.github_required, 'Require GitHub mirror push (else best-effort)')}</div>`
    + `<div class="cs-sec"><h4>Metric calibration</h4>${num('kwh_per_ktoken', cfg.kwh_per_ktoken, 'Estimated kWh per 1,000 generated tokens')}<p class="cs-hint">Drives the electricity ESTIMATE only (compute runs on local the LLM host/forza). Pleasantville TOU rates use sensible defaults.</p></div>`
    + '<div class="cs-actions"><button type="button" class="recon-op-btn cs-save">Save</button><div class="cs-savemsg"></div></div>'
    + '</div>';
  document.body.appendChild(modal);
  document.getElementById('modal-backdrop').hidden = false;
  document.body.classList.add('modal-open');
  state.modal = 'codeshop-settings-dynamic';
  modal.querySelector('[data-act="close"]').addEventListener('click', close_all_modals);
  modal.querySelector('.cs-save').addEventListener('click', async () => {
    const patch = {};
    modal.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') patch[k] = el.checked;
      else if (el.type === 'number') { if (el.value !== '') patch[k] = parseFloat(el.value); }
      else if (el.type === 'password') { if (el.value !== '') patch[k] = el.value; } // blank = keep existing
      else patch[k] = el.value;
    });
    const msg = modal.querySelector('.cs-savemsg');
    try {
      await api('/api/codeshop/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      msg.textContent = 'Saved ✓';
      msg.className = 'cs-savemsg ok';
      toast('Code Shop settings saved.');
      setTimeout(() => { close_all_modals(); if (state.active_id) load_pane(state.active_id); }, 600);
    } catch (e) {
      msg.textContent = 'Save failed: ' + ((e && e.message) || e);
      msg.className = 'cs-savemsg err';
    }
  });
}

// ── Post Office setup modal — connect/manage inboxes (self-service) ────────
async function open_postoffice_settings_modal() {
  const prior = document.getElementById('postoffice-settings-dynamic');
  if (prior) prior.remove();
  const sid = _po_specialist_id();
  let data;
  try {
    if (state._po_cache) state._po_cache.delete(sid);
    data = await _postoffice_fetch(sid);
  } catch (e) {
    toast('Post Office: ' + ((e && e.message) || e), true);
    return;
  }
  const presets = data.presets || {};
  const accounts = data.accounts || [];
  const canShare = !!data.can_share_household;

  const acctRows = accounts.map((a) => {
    const [lbl, tone] = _PO_STATUS[a.connection_status] || _PO_STATUS.untested;
    return `<div class="po-acct-row" data-aid="${escape_html(a.id)}">`
      + `<div class="po-acct-main"><b>${escape_html(a.display_name)}</b> <span class="po-acct-prov">${escape_html(a.provider)}</span>`
      + ` <span class="po-acct-st ${tone}">${escape_html(lbl)}</span>`
      + (a.private_to === 'household' ? ' <span class="po-acct-share">household</span>' : '')
      + `</div><div class="po-acct-actions">`
      + `<button type="button" class="po-mini" data-act="test">Test</button>`
      + `<button type="button" class="po-mini danger" data-act="remove">Remove</button></div></div>`;
  }).join('');

  const provOpts = ['gmail', 'icloud', 'outlook', 'fastmail', 'manual']
    .map((p) => `<option value="${p}">${escape_html(presets[p] ? presets[p].label : 'Manual IMAP/SMTP')}</option>`)
    .join('');

  const modal = document.createElement('div');
  modal.id = 'postoffice-settings-dynamic';
  modal.className = 'modal modal-codeshop';
  modal.innerHTML =
    '<div class="modal-inner cs-inner" role="dialog" aria-modal="true">'
    + '<div class="recon-ops-head"><h3>Post Office — your inboxes</h3><button type="button" class="iconbtn" data-act="close" aria-label="Close"><span class="icon">✕</span></button></div>'
    + '<p class="modal-sub">Connect an email account and Kate keeps a pulse on it — real replies + new mail surfaced, junk filtered, orders tracked. Gmail &amp; iCloud need an <b>app-specific password</b> (with two-factor on); your normal password won\'t work. Credentials are stored server-side and never shown again.</p>'
    + (acctRows ? `<div class="cs-sec"><h4>Connected</h4><div class="po-acct-list">${acctRows}</div></div>` : '')
    + '<div class="cs-sec"><h4>Add an inbox</h4>'
    + `<label class="cs-field"><span>Provider</span><select data-k="provider">${provOpts}</select></label>`
    + '<label class="cs-field"><span>Name (label)</span><input data-k="display_name" type="text" placeholder="e.g. Personal iCloud"></label>'
    + '<label class="cs-field"><span>Email address</span><input data-k="email" type="email" autocomplete="off" placeholder="you@icloud.com"></label>'
    + '<label class="cs-field"><span>App-specific password <a class="po-help" data-act="apphelp" target="_blank" rel="noopener">how do I get one?</a></span><input data-k="app_password" type="password" autocomplete="new-password" placeholder="xxxx-xxxx-xxxx-xxxx"></label>'
    + '<div class="po-manual" hidden>'
    + '<label class="cs-field"><span>IMAP host</span><input data-k="imap_host" type="text" placeholder="imap.example.com"></label>'
    + '<label class="cs-field"><span>IMAP port</span><input data-k="imap_port" type="number" value="993"></label>'
    + '<label class="cs-field"><span>SMTP host</span><input data-k="smtp_host" type="text" placeholder="smtp.example.com"></label>'
    + '<label class="cs-field"><span>SMTP port</span><input data-k="smtp_port" type="number" value="587"></label>'
    + '</div>'
    + (canShare ? '<label class="cs-check"><input data-k="share" type="checkbox"> Share with the household (everyone can use it)</label>' : '')
    + '<div class="cs-actions"><button type="button" class="recon-op-btn po-add">Connect inbox</button><div class="cs-savemsg"></div></div>'
    + '</div></div>';

  document.body.appendChild(modal);
  document.getElementById('modal-backdrop').hidden = false;
  document.body.classList.add('modal-open');
  state.modal = 'postoffice-settings-dynamic';
  modal.querySelector('[data-act="close"]').addEventListener('click', close_all_modals);

  const provSel = modal.querySelector('[data-k="provider"]');
  const manual = modal.querySelector('.po-manual');
  const help = modal.querySelector('[data-act="apphelp"]');
  const syncProv = () => {
    const p = provSel.value;
    manual.hidden = p !== 'manual';
    const url = presets[p] && presets[p].app_password_url;
    if (url) { help.setAttribute('href', url); help.style.display = ''; } else { help.style.display = 'none'; }
  };
  provSel.addEventListener('change', syncProv);
  syncProv();

  modal.querySelectorAll('.po-acct-row').forEach((row) => {
    const aid = row.dataset.aid;
    row.querySelector('[data-act="test"]').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true; btn.textContent = 'Testing…';
      try {
        const r = await api(`/api/specialists/${encodeURIComponent(sid)}/postoffice/accounts/${encodeURIComponent(aid)}/test`, { method: 'POST' });
        toast(r && r.ok ? 'Connection OK ✓' : 'Connection failed — check the app password.', !(r && r.ok));
      } catch (e) { toast('Test failed: ' + ((e && e.message) || e), true); }
      open_postoffice_settings_modal();
    });
    row.querySelector('[data-act="remove"]').addEventListener('click', async () => {
      if (!window.confirm('Remove this inbox? Kate will stop watching it.')) return;
      try {
        await api(`/api/specialists/${encodeURIComponent(sid)}/postoffice/accounts/${encodeURIComponent(aid)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: true }) });
        toast('Inbox removed.');
      } catch (e) { toast('Remove failed: ' + ((e && e.message) || e), true); }
      open_postoffice_settings_modal();
    });
  });

  modal.querySelector('.po-add').addEventListener('click', async () => {
    const v = (k) => { const el = modal.querySelector(`[data-k="${k}"]`); return el ? el.value.trim() : ''; };
    const msg = modal.querySelector('.cs-savemsg');
    const provider = v('provider');
    const email = v('email');
    const pw = modal.querySelector('[data-k="app_password"]').value;
    if (!v('display_name') || !email || !pw) { msg.textContent = 'Name, email, and password are required.'; msg.className = 'cs-savemsg err'; return; }
    const share = modal.querySelector('[data-k="share"]');
    const payload = {
      display_name: v('display_name'), provider,
      private_to: (share && share.checked) ? 'household' : 'owner',
      imap_user: email, imap_password: pw, smtp_user: email, smtp_password: pw,
    };
    if (provider === 'manual') {
      payload.imap_host = v('imap_host'); payload.imap_port = parseInt(v('imap_port') || '993', 10);
      payload.smtp_host = v('smtp_host'); payload.smtp_port = parseInt(v('smtp_port') || '587', 10);
    }
    msg.textContent = 'Connecting…'; msg.className = 'cs-savemsg';
    try {
      const r = await api(`/api/specialists/${encodeURIComponent(sid)}/postoffice/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const aid = r && r.account && r.account.id;
      let okMsg = 'Inbox connected ✓';
      if (aid) {
        try {
          const t = await api(`/api/specialists/${encodeURIComponent(sid)}/postoffice/accounts/${encodeURIComponent(aid)}/test`, { method: 'POST' });
          if (!(t && t.ok)) okMsg = 'Connected, but sign-in failed — check the app password.';
        } catch { /* test best-effort */ }
      }
      msg.textContent = okMsg; msg.className = 'cs-savemsg ' + (okMsg.indexOf('failed') >= 0 ? 'err' : 'ok');
      toast(okMsg, okMsg.indexOf('failed') >= 0);
      if (state._po_cache) state._po_cache.delete(sid);
      setTimeout(() => { close_all_modals(); if (state.active_id) load_pane(state.active_id); }, 900);
    } catch (e) {
      msg.textContent = 'Connect failed: ' + ((e && e.message) || e); msg.className = 'cs-savemsg err';
    }
  });
}

// ── Presence office — LD2450 top-down room canvas + WYSIWYG zone editor ─────
// (design-ld2450-zone-editor.md §4–§5). A vanilla-<canvas> room view: sensor
// at the apex, ±60° FOV cone, range arcs, up to 3 live target dots (trail +
// speed vector), and draggable/resizable zone rectangles. All internal math is
// MILLIMETERS in the radar frame (origin = sensor, X signed −left/+right, Y
// positive-away); px is for drawing only, mm only on pointer events. Data: GET
// /api/presence/state cold-paints; the `presence_targets` SSE keeps dots live;
// "Save" POSTs mm zones to /api/presence/zones (coordinator applies + acks via
// `presence_zones_acked`). Degrades to read-only when the coordinator isn't
// holding the device (device_connected:false) — never silently fails.

const LD2450 = { X_MIN: -3000, X_MAX: 3000, Y_MIN: 0, Y_MAX: 6000, FOV_DEG: 60, RANGE_MM: 6000 };
const ZONE_TYPES = ['Disabled', 'Detection', 'Filter'];
const _presence = {
  device_id: null, config: null, connected: false,
  targets: [], trails: new Map(),
  canvas: null, ctx: null, stage: null, ro: null, raf: 0,
  edit: false, draft: null, selected: 1, drag: null, saving: false,
  ptr_down: null, ptr_move: null, ptr_up: null,
};

function _pclamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function _pclamp_x(mm) { return _pclamp(mm, LD2450.X_MIN, LD2450.X_MAX); }
function _pclamp_y(mm) { return _pclamp(mm, LD2450.Y_MIN, LD2450.Y_MAX); }
function _psnap(mm) {
  const c = _presence.config;
  if (!c || !c.snap_enabled || !(c.snap_grid_mm > 0)) return mm;
  return Math.round(mm / c.snap_grid_mm) * c.snap_grid_mm;
}

// mm ↔ canvas-px transform (mount offset + rotation), per design §5.
function _presence_geom(cfg, W, H) {
  const pad = 16;
  const px_per_mm = cfg && cfg.px_per_m ? cfg.px_per_m / 1000 : (H - 2 * pad) / LD2450.RANGE_MM;
  const apex_x = W / 2 + ((cfg && cfg.mount_x_offset_mm) || 0) * px_per_mm;
  const apex_y = pad;
  const theta = (((cfg && cfg.mount_rotation_deg) || 0) * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  return {
    pad, px_per_mm, apex_x, apex_y,
    mmToPx(x, y) { const xr = x * cos - y * sin, yr = x * sin + y * cos; return [apex_x + xr * px_per_mm, apex_y + yr * px_per_mm]; },
    pxToMm(px, py) { const xr = (px - apex_x) / px_per_mm, yr = (py - apex_y) / px_per_mm; return [xr * cos + yr * sin, -xr * sin + yr * cos]; },
  };
}

// ── News Desk (Kate's office, second tab — 2026-06-10) ─────────────────────
// Client-rendered over /api/news: a word cloud of categories (size ∝ 7-day
// headline volume; active / paused / offered states), a filterable headline
// list, and a manage mode (gear) for pausing categories, switching on offered
// bundles, and free-text "track something new" (Cordelia scout → proposals).

function render_briefing_tabs() {
  const bar = document.createElement('div');
  bar.className = 'news-tabs';
  // 'home' (2026-07-04): the household floor-plan occupancy canvas, re-homed
  // from Luna's retired office — Kate holds read_home, and _home_fetch keys on
  // the CURRENT office's specialist id, so the same canvas works under her.
  // 'bills' (2026-07-04): the "lay out my bills" desk over /api/specialists/:id/bills.
  // 'security' (2026-07-15, the security fold's re-home): shown only when the
  // server doc carries the owner-only Security tab — renders its blocks plus
  // the interactive People (face-enrollment) surface, both re-homed from
  // Cassandra's roster-hidden Watch Desk.
  const entries = [['brief', 'Briefing'], ['home', 'Home'], ['news', 'News Desk'], ['research', 'Research'], ['friends', 'Friends'], ['postoffice', 'Post Office'], ['bills', 'Bills'], ['media', 'Archive']];
  const has_security = !!((state._last_pane_doc && state._last_pane_doc.blocks) || []).find(
    (b) => b.type === 'tabs' && (b.tabs || []).some((t) => t.id === 'security'),
  );
  if (has_security) entries.splice(2, 0, ['security', 'Security']);
  // 'codeshop' (2026-07-21): Beatrice's workshop, re-homed onto Kate's office.
  // Her own Code Shop pane went unreachable when she was demoted to
  // subagent_only (2026-07-14) — the roster filter drops her and there is no
  // deep-link router — which orphaned BOTH the review-swarm nest and the only
  // web surface for approving a merge. Owner-only: it is the owner's queue.
  // Second, not last: this is the only tab holding actions that are waiting on
  // the owner, so it should not be the ninth thing off the right edge.
  if (_media_is_owner()) entries.splice(1, 0, ['codeshop', 'Code Shop']);
  for (const [key, label] of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'news-tab' + ((state._news_tab || 'brief') === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if ((state._news_tab || 'brief') === key) return;
      state._news_tab = key;
      if (state._last_pane_doc) render_pane(state._last_pane_doc);
    });
    bar.appendChild(b);
  }
  return bar;
}

// ── Archive office (Kate's office, "Archive" tab — 2026-07-11) ─────────────
// The web sibling of the iOS Archive tab. Pure client render over the existing
// /api/media/* API: a Recent grid, a Browse taxonomy, inference search, and an
// inline HTTP-range (206) video/audio player. Every read is cordon-filtered
// server-side (an archived item silos to its requester; anything else 404-shapes),
// so the same tab is safe for household members — each sees only their own slice,
// and this file makes no eligibility decision of its own.

function _media_dur(s) {
  if (s == null || !Number.isFinite(s) || s <= 0) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}
function _media_bytes(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function _media_date(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch (e) { return String(iso).slice(0, 10); }
}
// Audio when there's no frame geometry (an audio-only rip has null width/height,
// whatever its media_kind label) — that decides <audio> vs <video>.
function _media_is_audio(it) {
  if (it.media_kind === 'image_gallery' || it.media_kind === 'photoset') return false;
  return !(it.width && it.height);
}
// Which player/glyph an item gets: an image gallery, audio, or video.
function _media_kind_of(it) {
  if (it.media_kind === 'image_gallery' || it.media_kind === 'photoset') return 'gallery';
  return _media_is_audio(it) ? 'audio' : 'video';
}

// Owner role, for the nav's owner-only Code Shop entry. Deliberately NOT part of
// the NSFW gate below any more — see its header.
function _media_is_owner() {
  const role = current_user && current_user.role;
  return role === 'admin' || role === 'owner';
}

// ── NSFW local-unlock gate (a PRESENCE gate, not an eligibility rule) ─────
// WHO MAY SEE AN ITEM IS THE SERVER'S DECISION, FULL STOP. Every item that
// reaches this client either passed the archive cordon — each item silos to the
// user who REQUESTED it (@core/media/cordon) — or was deliberately named to this
// user by its owner via POST /item/:id/share. So this file filters nothing by
// tier and nothing by path: the two client-side
// eligibility walls that used to live here (drop every `nsfw` item unless the
// viewer is the owner; hide the `Private/` subtree from a non-owner) were removed
// on 2026-07-29.
//
// They were not merely redundant with the cordon — they were WRONG, and the
// requester silo is what made that unmistakable. An archived item now belongs to
// whoever asked for it, so a household member or a friend can legitimately hold
// their OWN explicit item, and `/api/auth/step_up` verifies each user's OWN PIN
// at any tier. Owner-gating the reveal left that member at a permanent dead end
// on their own archive: the grid withheld the item, the unlock affordance (the
// Private chip) was hidden from them, `_media_open_private` hard-returned before
// it could prompt, and the withheld note's "enter your PIN" hint was suppressed —
// four locks and no key. iOS never had these rules either, so one shared item
// rendered on the phone and vanished in the browser: two clients, opposite
// answers to a question neither of them gets to answer.
//
// What survives is a different concern, and it is genuinely client-side: don't
// PAINT explicit content on a screen until whoever is sitting in front of it
// re-authenticates. That is shoulder-surfing, not authorization — the server
// cannot know whether this browser session has been unlocked. It is why the
// server projects the `nsfw` flag onto the row at all, and that flag is the ONE
// server-provided field this gate keys on; no new field was invented for it.
// iOS's `PrivateGate` is the same gate with Face ID instead of a PIN, and it is
// user-agnostic there too — so this one is user-agnostic as well.
//
// Withholding still has to be VISIBLE rather than silent: everything the gate
// holds back is counted by `_media_partition` (the one seam) and reported, and
// the reveal hint now points EVERY user at the unlock path.
//
// The NSFW subtree: media_category forces the first path segment to `Private`
// for anything not confirmed SFW, so `Private` (root) and `Private/…` are the
// locked section (mirrors the iOS "Private" grouping). Used for the padlock
// affordance + the re-lock edge — never to decide who may see a folder.
function _media_is_private_path(p) {
  return /^Private(\/|$)/i.test(String(p || ''));
}
// The lock: nobody — owner included — sees nsfw content until this session is
// unlocked via `_media_open_private` (a real /api/auth/step_up PIN re-auth, which
// is per-user and available at every tier). An nsfw item can live OUTSIDE Private
// (folder placement uses the pre-download verdict, the flag the final one), so the
// gate keys on the item's own server-provided `nsfw` flag, not just the folder.
// Two flags (mobile parity): `_media_nsfw_revealed` is SESSION-STICKY — once the
// PIN passes this session, nsfw ITEMS stay visible in grids (so an nsfw item
// mis-filed OUTSIDE Private isn't stranded). `state._media_private_unlocked` is
// PER-ACCESS — the Private FOLDER re-locks the moment you leave it (mobile's
// PrivateGate re-auths on every entry), so re-entering Private re-prompts the PIN.
function _media_nsfw_revealed() {
  return state._media_nsfw_revealed === true;
}
function _media_visible_items(items) {
  if (_media_nsfw_revealed()) return items || [];
  return (items || []).filter((it) => !it.nsfw);
}
// Leaving the Private subtree re-locks the FOLDER (not the session reveal): the
// next entry into Private re-prompts the PIN.
function _media_relock_private_if_leaving(path) {
  if (state._media_private_unlocked && !_media_is_private_path(path || '')) {
    state._media_private_unlocked = false;
  }
}
// ── the gate's accounting, in ONE place ────────────────────────────────────
// Split a listing payload into what this client will render and what the unlock
// gate held back. EVERY media listing surface — recent, browse, search — goes
// through here and nowhere else, and `_media_grid` no longer filters on its own
// (it renders exactly what it is handed).
//
// That single seam is the fix for two real gaps from when each surface filtered
// for itself: `_media_fill_search` handed raw results to `_media_grid`, which
// filtered them internally, so an all-explicit result set rendered an EMPTY grid
// with no message at all; and a listing whose visible half came up empty fell
// through to "nothing archived here yet" — a false statement about the caller's
// own archive.
//
// FOLDERS are never held back, and that is a decision rather than an omission.
// The only basis this client ever had for hiding the `Private/` subtree was "the
// viewer isn't the owner", and that basis goes with the tier check. It cannot be
// re-founded on the reveal flag either: the Private chip IS the unlock entry point
// (tapping it is what prompts for the PIN), so hiding it while the session is
// locked would rebuild the dead end in a new shape — a locked door with its only
// key behind it. The chip therefore always renders, wearing a padlock, and the
// server has already decided which folders exist for this caller (browse derives
// them from that caller's own cordon-filtered rows, so a listed folder always
// holds at least one item they may have). Nothing folder-shaped is withheld, so
// nothing folder-shaped is counted — the accounting reports what the gate
// actually does, not a policy it no longer has.
function _media_partition(items, folders) {
  const all_items = items || [];
  const vis_items = _media_visible_items(all_items);
  return {
    items: vis_items,
    folders: folders || [],
    withheld: { items: all_items.length - vis_items.length },
  };
}
// One phrasing of "what this screen is not showing you", shared by the empty
// state and the under-the-grid note so the two can't drift. Counts only — no
// titles, no thumbnails; naming a withheld item would defeat withholding it.
// The reveal hint is UNCONDITIONAL. The lock is a per-session paint gate and
// /api/auth/step_up checks whoever is looking against their OWN PIN, so every user
// has the same way through. It used to be owner-gated, which told a member their
// own item was hidden and then offered them nothing.
function _media_withheld_phrase(withheld) {
  const n = (withheld && withheld.items) || 0;
  if (n === 0) return null;
  const verb = n === 1 ? 'is' : 'are';
  return `${n} item${n === 1 ? '' : 's'} marked explicit ${verb} hidden on this screen.`
    + ' Open the Private folder and enter your PIN to reveal.';
}
// The note that rides UNDER a non-empty grid. Suppression has to be reported even
// when something else did render — reporting it only in the empty state is how a
// partial withholding stays silent.
function _media_withheld_note(withheld) {
  const phrase = _media_withheld_phrase(withheld);
  if (!phrase) return null;
  const el = document.createElement('div');
  el.className = 'media-withheld';
  el.textContent = phrase;
  return el;
}

// ── Heatmap parity helpers (mirror iOS HeatmapScrubber) ───────────────────
const MEDIA_MILWAUKEE_RED = '#E4002B';
// Renormalize a raw sample array so its peak is 1 (the server already
// normalizes, but be defensive — matches iOS `normalized()`). nil unless ≥2
// finite samples with a positive peak.
function _media_norm_samples(raw) {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const finite = raw.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  const peak = Math.max.apply(null, finite);
  if (!(peak > 0)) return null;
  return finite.map((v) => v / peak);
}
// External "most replayed" heat ([{start_time,end_time,value}]) → the value
// array, renormalized (iOS `externalHeatSamples`). The segments are evenly
// spaced, so index → x position; start/end times aren't needed for the curve.
function _media_external_samples(heatmap) {
  if (!Array.isArray(heatmap) || heatmap.length < 2) return null;
  return _media_norm_samples(heatmap.map((s) => (s && Number.isFinite(s.value) ? s.value : 0)));
}
// A chapter's start offset in seconds — real yt-dlp wire key is `start_time`;
// tolerate the internal `start_s`/`start` fallbacks.
function _media_chapter_start(c) {
  const v = c && (c.start_time ?? c.start_s ?? c.start);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// Chapter-start fractions (0…1) for the scrubber divider ticks (0 / end skipped).
function _media_chapter_fractions(d) {
  const dur = Number(d.duration_s) || 0;
  if (!dur || !Array.isArray(d.chapters)) return [];
  return d.chapters
    .map((c) => _media_chapter_start(c) / dur)
    .filter((f) => f > 0.004 && f < 0.996);
}

function render_media_office() {
  const root = document.createElement('div');
  root.className = 'media-office';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:54px"></div><div class="office-sk" style="height:200px"></div></div>';
  // Land on BROWSE (the folder taxonomy: Music / Video / Private / Images) to
  // match the mobile Archive, which leads with the folder browse — NOT a flat
  // Recent grid. Recent stays available on the toggle.
  if (state._media_mode == null) state._media_mode = 'browse';
  if (state._media_path == null) state._media_path = '';
  _media_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Archive unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
  });
  return root;
}

async function _media_paint(root) {
  root.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'media-bar';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'media-search';
  search.placeholder = 'Search the archive…';
  search.value = state._media_query || '';
  const content = document.createElement('div');
  content.className = 'media-content';

  let _t = null;
  search.addEventListener('input', () => {
    state._media_query = search.value;
    clearTimeout(_t);
    _t = setTimeout(() => {
      const q = (state._media_query || '').trim();
      if (q) { state._media_mode = 'search'; _media_fill_search(content, q); }
      else { state._media_mode = 'browse'; _media_fill_browse(content, state._media_path || ''); }
      _media_sync_toggle(bar);
    }, 260);
  });
  bar.appendChild(search);

  const toggle = document.createElement('div');
  toggle.className = 'media-toggle';
  for (const [key, label] of [['browse', 'Browse'], ['recent', 'Recent']]) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.mode = key; b.textContent = label;
    b.addEventListener('click', () => {
      state._media_query = ''; search.value = '';
      state._media_mode = key;
      if (key === 'recent') _media_fill_recent(content);
      else _media_fill_browse(content, state._media_path || '');
      _media_sync_toggle(bar);
    });
    toggle.appendChild(b);
  }
  bar.appendChild(toggle);
  root.appendChild(bar);
  root.appendChild(content);
  _media_sync_toggle(bar);

  const q = (state._media_query || '').trim();
  if (state._media_mode === 'search' && q) await _media_fill_search(content, q);
  else if (state._media_mode === 'browse') await _media_fill_browse(content, state._media_path || '');
  else await _media_fill_recent(content);
}

function _media_sync_toggle(bar) {
  const mode = state._media_mode || 'recent';
  const searching = !!(state._media_query || '').trim();
  for (const b of bar.querySelectorAll('.media-toggle button')) {
    b.classList.toggle('active', b.dataset.mode === mode && !searching);
  }
}

function _media_office_of(content) { return content.closest('.media-office'); }

async function _media_fill_recent(content) {
  _media_relock_private_if_leaving(''); // leaving Private → re-lock the folder
  content.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:180px"></div></div>';
  let payload;
  try { payload = await api('/api/media/recent?limit=60'); }
  catch (err) { content.innerHTML = `<div class="newsdesk-err">${escape_html(err.message || String(err))}</div>`; return; }
  const view = _media_partition(payload.items, null);
  content.innerHTML = '';
  if (!view.items.length) { content.appendChild(_media_empty(view.withheld)); return; }
  content.appendChild(_media_grid(view.items, _media_office_of(content)));
  const withheld = _media_withheld_note(view.withheld);
  if (withheld) content.appendChild(withheld);
}

async function _media_fill_browse(content, path) {
  _media_relock_private_if_leaving(path);
  content.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:180px"></div></div>';
  let payload;
  try { payload = await api(`/api/media/browse?path=${encodeURIComponent(path)}`); }
  catch (err) { content.innerHTML = `<div class="newsdesk-err">${escape_html(err.message || String(err))}</div>`; return; }
  state._media_path = payload.path || '';
  content.innerHTML = '';
  content.appendChild(_media_crumb(content, state._media_path));
  // Folders are rendered exactly as the server listed them — the browse response
  // is already cordon-filtered per caller, so there is no client-side eligibility
  // filter here. What the local unlock gate holds back (nsfw ITEMS, until this
  // session is unlocked) is counted, so a suppressed item is reported instead of
  // vanishing.
  const { folders, items, withheld } = _media_partition(payload.items, payload.folders);
  if (!folders.length && !items.length) {
    content.appendChild(_media_empty(withheld));
    return;
  }
  if (folders.length) {
    const fwrap = document.createElement('div');
    fwrap.className = 'media-folders';
    for (const f of folders) {
      const is_private = _media_is_private_path(f.path);
      const chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'media-folder' + (is_private ? ' is-private' : '');
      chip.innerHTML = `<span class="mf-ico">${is_private ? '🔒' : '📁'}</span><span class="mf-name">${escape_html(f.name)}</span><span class="mf-count">${f.count}</span>`;
      // The Private subtree is step-up gated for WHOEVER is looking: opening it
      // prompts for their PIN (a re-auth, the web analog of iOS's
      // Face-ID-on-every-access), once per session. Ordinary folders navigate
      // straight in.
      chip.addEventListener('click', () => {
        if (is_private) { _media_open_private(content, f.path); return; }
        state._media_path = f.path; _media_fill_browse(content, f.path);
      });
      fwrap.appendChild(chip);
    }
    content.appendChild(fwrap);
  }
  if (items.length) content.appendChild(_media_grid(items, _media_office_of(content)));
  const note = _media_withheld_note(withheld);
  if (note) content.appendChild(note);
}

// Open the Private subtree behind a session-scoped step-up. The caller's session
// already carries the real grant server-side (the API returns these items to them
// regardless — by cordon or by an explicit share), so this is a shoulder-surf
// gate, not the security boundary. It applies at ANY tier: a member or a friend
// can legitimately hold their own explicit item, and /api/auth/step_up verifies
// each user's OWN PIN — the old `if (!_media_is_owner()) return;` here was the
// hard end of that dead end, refusing to even prompt.
async function _media_open_private(content, path) {
  const enter = () => {
    state._media_private_unlocked = true; // folder unlocked (re-locks on exit)
    state._media_nsfw_revealed = true;    // session reveal (sticky) for nsfw items
    state._media_path = path;
    _media_fill_browse(content, path);
  };
  if (state._media_private_unlocked) { enter(); return; }

  // A real lock requires a passcode. If THIS user has no PIN, the folder can't be
  // locked — steer them to set one rather than prompt for a PIN they don't have.
  if (current_user && current_user.has_pin === false) {
    toast('Set a PIN to lock the private folder — opening Set PIN.', true);
    if (typeof open_set_pin_modal === 'function') { try { open_set_pin_modal({ rotation: false }); } catch (e) { /* best-effort */ } }
    return;
  }

  const pin = window.prompt('🔒 Private — enter your PIN to unlock:');
  if (pin == null) return; // cancelled — stays LOCKED (no bypass)
  const trimmed = pin.trim();
  if (!/^\d{4,8}$/.test(trimmed)) { toast('PIN must be 4–8 digits.', true); return; }
  try {
    const pin_sha256 = await _sha256_hex(trimmed);
    const step = await fetch('/api/auth/step_up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin_sha256 }),
    });
    if (step.ok) { enter(); return; } // verified → unlock for the session
    // FAIL CLOSED — a lock that opens on a wrong PIN / rate-limit / store error
    // isn't a lock. Anything but a verified PIN keeps NSFW hidden.
    const j = await step.json().catch(() => ({}));
    toast(j.error || (step.status === 429 ? 'Too many attempts — try again later.' : 'Incorrect PIN.'), true);
  } catch (e) {
    toast('Couldn’t verify PIN: ' + String((e && e.message) || e), true);
  }
}

async function _media_fill_search(content, q) {
  _media_relock_private_if_leaving(''); // leaving Private → re-lock the folder
  content.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:120px"></div></div>';
  let payload;
  try { payload = await api(`/api/media/search?q=${encodeURIComponent(q)}`); }
  catch (err) { content.innerHTML = `<div class="newsdesk-err">${escape_html(err.message || String(err))}</div>`; return; }
  // Search is gated exactly like recent/browse — it used to hand raw results
  // straight to `_media_grid` and rely on the filter buried inside it, which meant
  // an all-explicit result set rendered a silent empty grid.
  const view = _media_partition(payload.results, null);
  content.innerHTML = '';
  if (!view.items.length) {
    const e = document.createElement('div'); e.className = 'research-empty';
    const withheld = _media_withheld_phrase(view.withheld);
    // A hit the gate withheld is NOT "no matches" — never say it was.
    e.innerHTML = withheld
      ? `Matches for <em>${escape_html(q)}</em> — but ${escape_html(withheld)}`
      : `No archive matches for <em>${escape_html(q)}</em>.`;
    content.appendChild(e); return;
  }
  content.appendChild(_media_grid(view.items, _media_office_of(content), true));
  const note = _media_withheld_note(view.withheld);
  if (note) content.appendChild(note);
}

// The honest empty state, in two flavours, because "the screen is bare" has two
// different causes and only one of them is "nothing archived".
//  - `withheld` non-zero (the `_media_partition` count: explicit items the local
//    unlock gate held back until this session is unlocked) — the server DID return
//    content, so say what is being suppressed, and how to get at it, rather than
//    claiming an empty archive.
//  - nothing withheld — a genuinely empty shelf. An archived item belongs to
//    whoever asked for it (owner directive 2026-07-29), so this means "none of
//    YOURS": a normal state, and the copy says so instead of making a claim about
//    other people's shelves that this client cannot see.
function _media_empty(withheld) {
  const e = document.createElement('div');
  e.className = 'research-empty';
  const phrase = _media_withheld_phrase(withheld);
  e.innerHTML = phrase
    ? escape_html(phrase)
    : 'Nothing of yours archived here yet — every item is filed to whoever asked for it, so you see your own. Hand Kate a link in chat — <em>“archive this: &lt;url&gt;”</em> — and it’ll download, categorize, and land here.';
  return e;
}

function _media_crumb(content, path) {
  const wrap = document.createElement('div');
  wrap.className = 'media-crumb';
  const home = document.createElement('button');
  home.type = 'button'; home.className = 'media-crumb-seg'; home.textContent = 'Archive';
  home.addEventListener('click', () => { state._media_path = ''; _media_fill_browse(content, ''); });
  wrap.appendChild(home);
  let acc = '';
  for (const s of (path || '').split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${s}` : s;
    const cur = acc;
    wrap.appendChild(Object.assign(document.createElement('span'), { className: 'media-crumb-sep', textContent: '›' }));
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'media-crumb-seg'; b.textContent = s;
    b.addEventListener('click', () => { state._media_path = cur; _media_fill_browse(content, cur); });
    wrap.appendChild(b);
  }
  return wrap;
}

// A pure renderer: it draws exactly the items it is handed. The unlock gate is
// applied ONCE, by `_media_partition`, which every caller goes through — this
// function used to re-filter on its own, and a caller that leaned on that hidden
// filter (search did) got the suppression with none of the accounting.
function _media_grid(items, root, with_snippet) {
  const grid = document.createElement('div');
  grid.className = 'media-grid';
  for (const it of items || []) grid.appendChild(_media_card(it, root, with_snippet));
  return grid;
}

function _media_card(it, root, with_snippet) {
  const card = document.createElement('button');
  card.type = 'button'; card.className = 'media-card';
  const kind = _media_kind_of(it);
  const thumb = document.createElement('div');
  thumb.className = 'media-thumb' + (kind === 'audio' ? ' is-audio' : '');
  const img = document.createElement('img');
  img.loading = 'lazy'; img.alt = '';
  img.src = `/api/media/thumb/${encodeURIComponent(it.id)}`;
  img.addEventListener('error', () => { thumb.classList.add('no-thumb'); img.remove(); });
  thumb.appendChild(img);
  const dur = _media_dur(it.duration_s);
  if (dur) thumb.appendChild(Object.assign(document.createElement('span'), { className: 'media-dur', textContent: dur }));
  if (it.nsfw) thumb.appendChild(Object.assign(document.createElement('span'), { className: 'media-lock', textContent: '🔒' }));
  const glyph = kind === 'gallery' ? '▦' : kind === 'audio' ? '♪' : '▶';
  thumb.appendChild(Object.assign(document.createElement('span'), { className: 'media-play', textContent: glyph }));
  card.appendChild(thumb);
  const meta = document.createElement('div');
  meta.className = 'media-meta';
  meta.innerHTML = `<div class="media-title">${escape_html(it.title || 'Untitled')}</div>`
    + `<div class="media-sub">${escape_html([it.creator, it.genre].filter(Boolean).join(' · ') || it.source_site || '')}</div>`
    + (with_snippet && it.snippet ? `<div class="media-snip">${escape_html(it.snippet)}</div>` : '');
  card.appendChild(meta);
  card.addEventListener('click', () => _media_drill(root, it.id));
  return card;
}

async function _media_drill(root, id) {
  if (!root) return;
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:320px"></div></div>';
  let d;
  try { d = await api(`/api/media/item/${encodeURIComponent(id)}`); }
  catch (err) { root.innerHTML = `<div class="newsdesk-err">Couldn’t load that item: ${escape_html(err.message || String(err))}</div>`; return; }
  root.innerHTML = '';
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'research-back'; back.textContent = '← All media';
  back.addEventListener('click', () => {
    try { if (video && video.pause) video.pause(); } catch (e) { /* best-effort */ }
    _media_paint(root).catch(() => {});
  });
  root.appendChild(back);

  // The local unlock gate, applied to whoever is looking (NOT an eligibility
  // check — the API already decided this caller may have the item, by cordon or by
  // an explicit share). A still-locked session shouldn't be able to open one even
  // via a stale card, and a locked MEMBER gets the same key as a locked owner:
  // this used to answer them "This item is private" about their own archive.
  if (d.nsfw && !_media_nsfw_revealed()) {
    const note = document.createElement('div'); note.className = 'research-empty';
    note.textContent = '🔒 Locked — open the Private folder (PIN) to reveal NSFW.';
    root.appendChild(note);
    return;
  }

  const stream = `/api/media/stream/${encodeURIComponent(d.id)}`;
  const kind = _media_kind_of(d);
  let video = null;
  if (kind === 'gallery') {
    // A paged image set — a grid of lazy thumbnails, each opening a keyboard-
    // navigable lightbox. No black player box (there's no A/V track).
    root.appendChild(_media_gallery_view(d));
  } else {
    const built = _media_build_player(d, stream, kind);
    root.appendChild(built.el);
    video = built.media;
  }

  const head = document.createElement('div'); head.className = 'media-detail-head';
  head.innerHTML = `<div class="media-detail-title">${escape_html(d.title || 'Untitled')}${d.nsfw ? ' <span class="media-lock-inline">🔒 private</span>' : ''}</div>`
    + `<div class="media-detail-sub">${escape_html([d.creator, d.genre, d.source_site].filter(Boolean).join(' · '))}</div>`;
  root.appendChild(head);

  const chips = document.createElement('div'); chips.className = 'media-chips';
  const chip = (t) => { if (t) chips.appendChild(Object.assign(document.createElement('span'), { className: 'media-chip', textContent: t })); };
  chip(_media_dur(d.duration_s));
  if (d.width && d.height) chip(`${d.width}×${d.height}`);
  chip(d.container ? String(d.container).toUpperCase() : '');
  chip(_media_bytes(d.filesize));
  if (d.archived_at) chip('Archived ' + _media_date(d.archived_at));
  if (d.source_url) {
    const a = document.createElement('a'); a.className = 'media-chip media-src';
    a.href = d.source_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Source ↗';
    chips.appendChild(a);
  }
  root.appendChild(chips);

  const share = _media_share_block(d);
  if (share) root.appendChild(share);

  if (Array.isArray(d.chapters) && d.chapters.length && video) {
    const ch = document.createElement('div'); ch.className = 'media-chapters';
    for (const c of d.chapters) {
      const start = _media_chapter_start(c);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'media-chapter';
      b.innerHTML = `<span class="mc-t">${escape_html(_media_dur(start) || '0:00')}</span><span class="mc-l">${escape_html(c.title || '')}</span>`;
      b.addEventListener('click', () => { try { video.currentTime = start; if (video.play) video.play().catch(() => {}); } catch (e) {} });
      ch.appendChild(b);
    }
    root.appendChild(ch);
  }

  if (d.summary) {
    const sm = document.createElement('div'); sm.className = 'media-summary md-body';
    sm.innerHTML = render_md(d.summary);
    root.appendChild(sm);
  }

  if (Array.isArray(d.tags) && d.tags.length) {
    const tw = document.createElement('div'); tw.className = 'media-tags';
    for (const t of d.tags.slice(0, 24)) tw.appendChild(Object.assign(document.createElement('span'), { className: 'media-tag', textContent: String(t) }));
    root.appendChild(tw);
  }
}

// ── Share this item (2026-07-29) ───────────────────────────────────────────
// A THIN renderer over the server's `sharing` object on item detail. Who may
// receive (`targets`), who already has it (`shared_with`), whether sharing is
// allowed at all (`can_share`), and EVERY user-facing string — the picker footer
// (`hint`), the no-one-to-share-with line (`empty_hint`) and the current-state
// line (`state_label`) — are server-owned. This file draws checkboxes and POSTs
// the chosen ids back, then re-renders from the response rather than from the
// local checkbox state. Never hardcode a recipient, a rule, or a label here: the
// same payload drives the iOS Archive, so a new string belongs in
// src/app/routes/media.ts (the WebGUI/iOS consolidation directive). Only
// mechanism words that have no server-side state — the Share/Save/Cancel button
// captions — are authored locally.
//
// The verb is declarative set-replacement, so the checkbox list IS the request:
// unticking everyone unshares.

// The POST returns the BARE `sharing` object (contract-literal). Accept an
// `{ok, sharing}` envelope too: iOS carries the same two-way tolerance, so a
// shape flip on either side can never silently strand the picker with stale
// state again. `can_share` is the object's one required key, so its presence is
// what tells the two shapes apart.
function _media_sharing_from_response(res) {
  if (!res || typeof res !== 'object') return null;
  if (res.can_share !== undefined) return res;
  if (res.sharing && typeof res.sharing === 'object') return res.sharing;
  return null;
}

function _media_share_block(d) {
  if (!d || !d.sharing || d.sharing.can_share !== true) return null; // no affordance at all
  const wrap = document.createElement('div');
  wrap.className = 'media-share';
  let sharing = d.sharing;
  let open = false;

  const paint = () => {
    wrap.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'media-share-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'media-share-btn' + (open ? ' active' : '');
    btn.textContent = '⤴ Share';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.addEventListener('click', () => { open = !open; paint(); });
    bar.appendChild(btn);
    // Current state stays visible with the picker closed — rendered from the
    // server's `state_label`, which is null when nothing is shared (no chip
    // then, matching iOS, rather than a locally invented "Not shared").
    if (sharing.state_label) {
      bar.appendChild(Object.assign(document.createElement('span'), {
        className: 'media-share-state', textContent: String(sharing.state_label),
      }));
    }
    wrap.appendChild(bar);
    if (!open) return;

    const panel = document.createElement('div');
    panel.className = 'media-share-panel';
    const chosen = new Set((sharing.shared_with || []).map((s) => s && s.user_id));
    const targets = sharing.targets || [];
    for (const t of targets) {
      if (!t || !t.user_id) continue;
      const row = document.createElement('label');
      row.className = 'media-share-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = t.user_id; cb.checked = chosen.has(t.user_id);
      row.appendChild(cb);
      row.appendChild(Object.assign(document.createElement('span'), { className: 'ms-name', textContent: t.name || t.user_id }));
      if (t.tier) row.appendChild(Object.assign(document.createElement('span'), { className: 'ms-tier', textContent: String(t.tier) }));
      panel.appendChild(row);
    }
    if (!targets.length && sharing.empty_hint) {
      panel.appendChild(Object.assign(document.createElement('div'), {
        className: 'media-share-hint', textContent: String(sharing.empty_hint),
      }));
    }
    if (sharing.hint) {
      panel.appendChild(Object.assign(document.createElement('div'), { className: 'media-share-hint', textContent: String(sharing.hint) }));
    }
    const err = document.createElement('div'); err.className = 'media-share-err';
    panel.appendChild(err);

    const actions = document.createElement('div'); actions.className = 'media-share-actions';
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'media-share-save'; save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'media-share-cancel'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { open = false; paint(); });
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      save.disabled = true; save.textContent = 'Saving…'; err.textContent = '';
      const user_ids = [...panel.querySelectorAll('input[type=checkbox]')].filter((cb) => cb.checked).map((cb) => cb.value);
      try {
        const res = await api(`/api/media/item/${encodeURIComponent(d.id)}/share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_ids }),
        });
        // Re-render from server truth — the response carries the same object
        // shape as the read's `sharing`, post-mutation.
        const next = _media_sharing_from_response(res);
        if (next) { sharing = next; d.sharing = next; }
        open = false;
        paint();
      } catch (e) {
        save.disabled = false; save.textContent = 'Save';
        err.textContent = (e && e.message) || String(e);
      }
    });
    actions.appendChild(save); actions.appendChild(cancel);
    panel.appendChild(actions);
    wrap.appendChild(panel);
  };

  paint();
  return wrap;
}

// ── Custom A/V player with the two-heatmap scrubber (parity with iOS) ──────
// A <video>/<audio> element (native controls OFF) under a custom transport:
// play/pause, monospaced time labels, the two-heatmap scrubber that owns the
// timeline, and fullscreen for video. Reports throttled watch progress so the
// personal re-watch curve (the red overlay) fills over time. If building the
// custom chrome ever throws, falls back to native controls so playback is
// never blocked.
function _media_build_player(d, stream, kind) {
  const el = document.createElement('div');
  el.className = 'media-player' + (kind === 'audio' ? ' is-audio' : '');
  let media;
  if (kind === 'audio') {
    const cover = document.createElement('img'); cover.className = 'media-cover'; cover.alt = '';
    cover.src = `/api/media/thumb/${encodeURIComponent(d.id)}`;
    cover.addEventListener('error', () => cover.remove());
    el.appendChild(cover);
    media = document.createElement('audio');
    media.preload = 'metadata'; media.src = stream;
  } else {
    media = document.createElement('video');
    media.playsInline = true; media.preload = 'metadata';
    media.poster = `/api/media/thumb/${encodeURIComponent(d.id)}`;
    media.src = stream;
  }
  el.appendChild(media);
  try {
    el.appendChild(_media_transport(d, media, el, kind));
  } catch (e) {
    media.controls = true; // custom chrome failed → native controls, still plays
  }
  return { el, media };
}

// The transport row: [play] [current] [scrubber] [duration] [fullscreen?].
function _media_transport(d, media, playerEl, kind) {
  const bar = document.createElement('div');
  bar.className = 'media-transport';

  const playBtn = document.createElement('button');
  playBtn.type = 'button'; playBtn.className = 'mt-btn mt-play';
  playBtn.setAttribute('aria-label', 'Play'); playBtn.textContent = '▶';
  const toggle = () => { if (media.paused) media.play().catch(() => {}); else media.pause(); };
  playBtn.addEventListener('click', toggle);

  const cur = document.createElement('span'); cur.className = 'mt-time mt-cur'; cur.textContent = '0:00';
  const dur = document.createElement('span'); dur.className = 'mt-time mt-dur'; dur.textContent = _media_dur(d.duration_s) || '0:00';

  bar.appendChild(playBtn);
  bar.appendChild(cur);
  bar.appendChild(_media_scrubber(d, media));
  bar.appendChild(dur);

  if (kind !== 'audio') {
    const fs = document.createElement('button');
    fs.type = 'button'; fs.className = 'mt-btn mt-full';
    fs.setAttribute('aria-label', 'Fullscreen'); fs.textContent = '⛶';
    fs.addEventListener('click', () => {
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (playerEl.requestFullscreen) playerEl.requestFullscreen();
        else if (media.webkitEnterFullscreen) media.webkitEnterFullscreen(); // iOS Safari
      } catch (e) { /* best-effort */ }
    });
    bar.appendChild(fs);
    media.addEventListener('click', toggle);
    media.style.cursor = 'pointer';
  }

  // Captions/subtitles (tracks pulled by Kate's rescan_media_metadata). A <track>
  // per language + a CC button that cycles off → each lang → off. Video only.
  const caps = kind !== 'audio' && Array.isArray(d.captions)
    ? d.captions.filter((c) => c && c.lang)
    : [];
  if (caps.length) {
    for (const cap of caps) {
      const tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.src = `/api/media/captions/${encodeURIComponent(d.id)}/${encodeURIComponent(cap.lang)}`;
      tr.srclang = cap.lang;
      tr.label = cap.lang + (cap.auto ? ' (auto)' : '');
      media.appendChild(tr);
    }
    const cc = document.createElement('button');
    cc.type = 'button'; cc.className = 'mt-btn mt-cc'; cc.textContent = 'CC';
    cc.setAttribute('aria-label', 'Captions');
    let capOn = -1; // -1 = off; else index into caps
    cc.addEventListener('click', () => {
      capOn = capOn + 1 >= caps.length ? -1 : capOn + 1;
      const tt = media.textTracks;
      for (let i = 0; i < tt.length; i++) tt[i].mode = i === capOn ? 'showing' : 'disabled';
      cc.classList.toggle('active', capOn >= 0);
      cc.textContent = capOn >= 0 && caps.length > 1 ? 'CC·' + caps[capOn].lang : 'CC';
    });
    bar.appendChild(cc);
  }

  const syncPlay = () => {
    const playing = !media.paused && !media.ended;
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  };
  media.addEventListener('play', syncPlay);
  media.addEventListener('pause', syncPlay);
  media.addEventListener('ended', syncPlay);
  media.addEventListener('loadedmetadata', () => { dur.textContent = _media_dur(media.duration) || (_media_dur(d.duration_s) || '0:00'); });
  media.addEventListener('timeupdate', () => { cur.textContent = _media_dur(media.currentTime) || '0:00'; });
  return bar;
}

// The two-heatmap scrubber: a canvas overlaying the external "most replayed"
// curve (GREY, behind) and YOUR OWN re-watch curve (Milwaukee red, front)
// on the timeline, each normalized to its own peak — with a live playhead,
// buffered fill, and chapter divider ticks. Dragging seeks (live preview +
// commit); watch progress is reported (throttled ~5s + on seek) so the red
// curve fills over time. Faithful to iOS `HeatmapScrubber`.
//
// The red curve arrives as `household_heatmap` — a wire name kept for client
// compatibility. Since 2026-07-29 an archived item is visible to exactly one
// person, so those buckets are that person's own replays, not a household
// aggregate.
function _media_scrubber(d, media) {
  const external = _media_external_samples(d.heatmap);
  const mine = _media_norm_samples(Array.isArray(d.household_heatmap) ? d.household_heatmap : null);
  const hasHeat = !!(external || mine);
  const chapterFracs = _media_chapter_fractions(d);
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '').trim() || '#4da3ff';

  const el = document.createElement('div');
  el.className = 'media-scrub' + (hasHeat ? ' has-heat' : '');
  const canvas = document.createElement('canvas');
  el.appendChild(canvas);
  const bubble = document.createElement('div'); bubble.className = 'media-scrub-bubble'; bubble.hidden = true;
  el.appendChild(bubble);

  const HEAT_H = hasHeat ? 34 : 0;
  const GAP = hasHeat ? 6 : 0;
  const TRACK_H = 5;
  const PAD_TOP = hasHeat ? 2 : 9; // vertical breathing room / centering
  const totalH = PAD_TOP + HEAT_H + GAP + TRACK_H + 9; // + handle room
  el.style.height = totalH + 'px';

  const ctx = canvas.getContext('2d');
  let dragging = false, dragFrac = 0, rafId = 0, lastReported = -1e9;

  const durationOf = () => {
    const md = media.duration;
    if (Number.isFinite(md) && md > 0) return md;
    const dd = Number(d.duration_s);
    return Number.isFinite(dd) && dd > 0 ? dd : 0;
  };
  const progressFrac = () => {
    if (dragging) return dragFrac;
    const dur = durationOf();
    return dur > 0 && Number.isFinite(media.currentTime) ? Math.min(1, Math.max(0, media.currentTime / dur)) : 0;
  };
  const bufferedFrac = () => {
    try {
      const dur = durationOf();
      if (!(dur > 0) || !media.buffered || !media.buffered.length) return 0;
      return Math.min(1, media.buffered.end(media.buffered.length - 1) / dur);
    } catch (e) { return 0; }
  };

  function draw() {
    const rect = el.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const dpr = window.devicePixelRatio || 1;
    const pxW = Math.round(w * dpr), pxH = Math.round(totalH * dpr);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW; canvas.height = pxH;
      canvas.style.width = w + 'px'; canvas.style.height = totalH + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, totalH);
    const heatBottom = PAD_TOP + HEAT_H;
    // grey (crowd) behind, red (yours) in front but translucent so overlap
    // reads as "the crowd AND you" — the iOS layering + opacities exactly.
    if (external) _media_fill_curve(ctx, external, w, heatBottom, HEAT_H, 'rgba(255,255,255,0.20)', 'rgba(255,255,255,0.5)', 1);
    if (mine) _media_fill_curve(ctx, mine, w, heatBottom, HEAT_H, 'rgba(228,0,43,0.55)', 'rgba(228,0,43,0.95)', 1.5);
    const ty = PAD_TOP + HEAT_H + GAP + TRACK_H / 2;
    _media_track(ctx, 0, w, ty, 'rgba(255,255,255,0.22)', TRACK_H);
    const buf = bufferedFrac();
    if (buf > 0) _media_track(ctx, 0, w * buf, ty, 'rgba(255,255,255,0.38)', TRACK_H);
    const f = progressFrac(); const px = w * f;
    if (px > 0) _media_track(ctx, 0, px, ty, accent, TRACK_H);
    for (const b of chapterFracs) {
      const cx = w * b;
      ctx.beginPath();
      ctx.moveTo(cx, ty - TRACK_H / 2 - 2); ctx.lineTo(cx, ty + TRACK_H / 2 + 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    const r = dragging ? 8 : 6;
    ctx.beginPath(); ctx.arc(px, ty, r, 0, Math.PI * 2);
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 0.5; ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.stroke();
  }

  function loop() {
    if (!el.isConnected) { rafId = 0; return; } // detached → stop (no leak)
    draw();
    rafId = (!media.paused && !media.ended) ? requestAnimationFrame(loop) : 0;
  }
  const ensureLoop = () => { if (!rafId) rafId = requestAnimationFrame(loop); };

  function report(force) {
    const dur = durationOf(); const pos = media.currentTime;
    if (!(dur > 0) || !Number.isFinite(pos) || pos < 0) return;
    if (!force && Math.abs(pos - lastReported) < 5) return;
    lastReported = pos;
    api(`/api/media/progress/${encodeURIComponent(d.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position_s: pos, duration_s: dur }),
    }).catch(() => {});
  }

  const fracFromClientX = (clientX) => {
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
  };
  const setBubble = (f) => {
    const dur = durationOf();
    bubble.textContent = _media_dur(f * dur) || '0:00';
    const rect = el.getBoundingClientRect();
    bubble.style.left = Math.min(Math.max(20, rect.width * f), Math.max(20, rect.width - 20)) + 'px';
  };
  // Drag shows a live PREVIEW (handle + time bubble follow the finger) and
  // commits the actual seek on release — avoids a range-request storm from
  // seeking a long video on every pointermove, while still feeling live.
  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    dragFrac = fracFromClientX(e.clientX);
    bubble.hidden = false; setBubble(dragFrac); draw();
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dragFrac = fracFromClientX(e.clientX);
    setBubble(dragFrac); draw();
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false; bubble.hidden = true;
    const dur = durationOf();
    if (dur > 0) { media.currentTime = dragFrac * dur; report(true); } // commit + report the seek
    draw();
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  media.addEventListener('loadedmetadata', draw);
  media.addEventListener('durationchange', draw);
  media.addEventListener('progress', draw);
  media.addEventListener('timeupdate', () => { draw(); report(false); });
  media.addEventListener('seeked', draw);
  media.addEventListener('play', ensureLoop);
  media.addEventListener('pause', () => { draw(); report(true); });
  media.addEventListener('ended', () => { draw(); report(true); });
  // Self-removing resize hook (no persistent listener once the pane is gone).
  const onResize = () => { if (!el.isConnected) { window.removeEventListener('resize', onResize); return; } draw(); };
  window.addEventListener('resize', onResize);
  requestAnimationFrame(draw); // first paint once mounted (width is known)

  return el;
}

// Draw a rounded track segment [x1..x2] at y.
function _media_track(ctx, x1, x2, y, color, width) {
  if (x2 < x1) x2 = x1;
  ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(Math.max(x2, x1 + 0.01), y);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.stroke();
}
// Fill the area under a normalized (0…1) sample curve, with a top stroke line.
function _media_fill_curve(ctx, samples, w, bottom, h, fill, stroke, sw) {
  const n = samples.length; if (n < 2 || w <= 0) return;
  const X = (i) => (w * i) / (n - 1);
  const Y = (i) => bottom - Math.min(1, Math.max(0, samples[i])) * h;
  ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(i));
  ctx.lineTo(w, bottom); ctx.lineTo(0, bottom); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath(); ctx.moveTo(X(0), Y(0));
  for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(i));
  ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.lineJoin = 'round'; ctx.stroke();
}

// The set of image indices to render, from the item detail. Prefer the explicit
// images[] (each carries its server-side idx); fall back to a 0..image_count-1
// range. The server maps idx → the on-disk file, so the client only needs idx.
function _media_gallery_idxs(d) {
  if (Array.isArray(d.images) && d.images.length) {
    return d.images.map((x, j) => (x && Number.isFinite(x.idx) ? x.idx : j));
  }
  if (Number.isFinite(d.image_count) && d.image_count > 0) {
    return Array.from({ length: d.image_count }, (_, i) => i);
  }
  return [];
}

function _media_gallery_view(d) {
  const idxs = _media_gallery_idxs(d);
  if (!idxs.length) {
    const n = document.createElement('div'); n.className = 'media-gallery-note';
    n.textContent = 'Gallery is empty or still processing.';
    return n;
  }
  const wrap = document.createElement('div'); wrap.className = 'media-gallery';
  idxs.forEach((idx, pos) => {
    const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'mg-cell';
    const gi = document.createElement('img'); gi.loading = 'lazy'; gi.alt = '';
    gi.src = `/api/media/image/${encodeURIComponent(d.id)}/${idx}`;
    gi.addEventListener('error', () => cell.classList.add('mg-broken'));
    cell.appendChild(gi);
    cell.addEventListener('click', () => _media_lightbox(d.id, idxs, pos));
    wrap.appendChild(cell);
  });
  return wrap;
}

// Full-screen image viewer: prev/next (buttons + ← →), counter, Esc/backdrop to
// close. Removed cleanly (its keydown listener is torn down on close).
function _media_lightbox(id, idxs, start) {
  let pos = Math.max(0, Math.min(start | 0, idxs.length - 1));
  const ov = document.createElement('div'); ov.className = 'media-lightbox';
  const img = document.createElement('img'); img.alt = '';
  const counter = document.createElement('div'); counter.className = 'ml-counter';
  const show = () => {
    img.src = `/api/media/image/${encodeURIComponent(id)}/${idxs[pos]}`;
    counter.textContent = `${pos + 1} / ${idxs.length}`;
  };
  const prev = () => { pos = (pos - 1 + idxs.length) % idxs.length; show(); };
  const next = () => { pos = (pos + 1) % idxs.length; show(); };
  const close = () => { document.removeEventListener('keydown', onkey); ov.remove(); };
  const onkey = (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === 'ArrowRight') next();
  };
  const btn = (cls, txt, on) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.textContent = txt;
    b.addEventListener('click', (e) => { e.stopPropagation(); on(); });
    return b;
  };
  img.addEventListener('error', () => { counter.textContent = `${pos + 1} / ${idxs.length} · couldn’t load`; });
  ov.appendChild(img);
  ov.appendChild(counter);
  ov.appendChild(btn('ml-close', '✕', close));
  if (idxs.length > 1) { ov.appendChild(btn('ml-prev', '‹', prev)); ov.appendChild(btn('ml-next', '›', next)); }
  ov.addEventListener('click', close);
  img.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', onkey);
  show();
  document.body.appendChild(ov);
}

// Repaint the Archive tab in place when a media item finishes archiving
// (media_archived SSE) — only when it's the open surface. Cordon-filtered
// server-side, so a refetch only ever returns the viewer's own slice.
function media_invalidate() {
  if (
    state.surface === 'office' &&
    state._news_tab === 'media' &&
    state._last_pane_doc &&
    state._last_pane_doc.pane_kind === 'briefing'
  ) {
    render_pane(state._last_pane_doc);
  }
}

// ── Bills desk (Kate's office, sixth tab — 2026-07-04) ────────────────────
// Client-rendered over /api/specialists/:id/bills — the "lay out my bills"
// surface of the executive-assistant endgame: monthly-equivalent total, the
// anticipation probe's open flags, upcoming estimates ("around <date>" — the
// ledger's estimate rule, never a hard due date), and the service roster.
// Cordon-filtered per viewer server-side. Live: proposal SSE events drop the
// cache and repaint when the tab is up.

const BILLS_CACHE_MS = 30_000;

async function _bills_fetch(specialist_id) {
  state._bills_cache = state._bills_cache || new Map();
  const hit = state._bills_cache.get(specialist_id);
  if (hit && Date.now() - hit.at < BILLS_CACHE_MS) return hit.payload;
  const payload = await api(`/api/specialists/${encodeURIComponent(specialist_id)}/bills`);
  state._bills_cache.set(specialist_id, { at: Date.now(), payload });
  return payload;
}

function bills_invalidate() {
  state._bills_cache = null;
  if (state._news_tab === 'bills' && state._last_pane_doc && state._last_pane_doc.pane_kind === 'briefing') {
    render_pane(state._last_pane_doc);
  }
}

function _bills_money(cents, currency) {
  if (cents == null) return '';
  const v = cents / 100;
  const sym = (currency || 'USD') === 'USD' ? '$' : `${currency} `;
  return Number.isInteger(v) ? `${sym}${v}` : `${sym}${v.toFixed(2)}`;
}

function _bills_around(iso_date) {
  if (!iso_date) return '';
  try {
    return new Date(`${iso_date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (e) { return iso_date; }
}

function _bills_sec(text) {
  const el = document.createElement('div');
  el.className = 'radar-sec';
  el.textContent = text;
  return el;
}

function _bills_empty(text) {
  const el = document.createElement('div');
  el.className = 'po-empty';
  el.textContent = text;
  return el;
}

function render_bills_view() {
  const root = document.createElement('div');
  root.className = 'bills';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:90px"></div><div class="office-sk" style="height:200px"></div></div>';
  _bills_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Bills desk unavailable: ${escape_html(err && err.message || String(err))}</div>`;
  });
  return root;
}

function _bills_svc_row(s, dim) {
  const el = document.createElement('div');
  el.className = 'bills-svc' + (dim ? ' dim' : '');
  const meta = [s.category, s.cadence, s.autopay ? 'autopay' : '', s.last_bill_date ? `last bill ${s.last_bill_date}` : '']
    .filter(Boolean).join(' · ');
  const amt = s.typical_amount_cents != null ? _bills_money(s.typical_amount_cents, s.currency) : '';
  const mo = s.monthly_equivalent_cents != null ? `≈ ${_bills_money(s.monthly_equivalent_cents, s.currency)}/mo` : '';
  el.innerHTML =
    `<div class="bills-svc-top"><span class="bills-svc-vendor">${escape_html(s.vendor)}</span>`
    + `<span class="bills-svc-amt">${escape_html(amt)}${dim ? ` <span class="bills-svc-st">${escape_html(s.status)}</span>` : ''}</span></div>`
    + `<div class="bills-svc-meta">${escape_html(meta)}${mo ? `<span class="bills-svc-mo">${escape_html(mo)}</span>` : ''}</div>`;
  return el;
}

async function _bills_paint(root) {
  const sid = state._pane_specialist_id || state.active_id || 'kate';
  const data = await _bills_fetch(sid);
  root.innerHTML = '';

  const hero = document.createElement('div');
  hero.className = 'bills-hero';
  const total = _bills_money(data.monthly_total_cents, data.currency);
  hero.innerHTML =
    `<div class="bills-hero-total">${escape_html(total || '—')}<span class="bills-hero-per">/mo</span></div>`
    + `<div class="bills-hero-sub">standing services, monthly equivalent · ${escape_html(String(data.monthly_total_basis))} of ${escape_html(String((data.services || []).length))} priced</div>`;
  root.appendChild(hero);

  if ((data.attention || []).length) {
    root.appendChild(_bills_sec('Needs attention'));
    for (const a of data.attention) {
      const el = document.createElement('div');
      el.className = 'bills-flag';
      const tag = a.kind === 'service_lapsed' ? 'gone quiet' : 'no bill yet';
      el.innerHTML =
        `<div class="bills-flag-top"><span class="bills-flag-tag">${escape_html(tag)}</span>`
        + `<span class="bills-flag-vendor">${escape_html(a.vendor || '')}</span></div>`
        + `<div class="bills-flag-body">${escape_html((a.rationale_md || '').replace(/\*\*/g, ''))}</div>`
        + `<div class="bills-flag-hint">decide it from the proposal queue</div>`;
      root.appendChild(el);
    }
  }

  root.appendChild(_bills_sec('Coming up'));
  if (!(data.upcoming || []).length) {
    root.appendChild(_bills_empty('Nothing expected in the next few weeks.'));
  } else {
    for (const s of data.upcoming) {
      const el = document.createElement('div');
      el.className = 'bills-row';
      el.innerHTML =
        `<span class="bills-row-date">around ${escape_html(_bills_around(s.next_due_estimate))}</span>`
        + `<span class="bills-row-vendor">${escape_html(s.vendor)}</span>`
        + `<span class="bills-row-amt">${escape_html(_bills_money(s.typical_amount_cents, s.currency))}</span>`
        + `<span class="bills-row-meta">${escape_html([s.cadence, s.autopay ? 'autopay' : ''].filter(Boolean).join(' · '))}</span>`;
      root.appendChild(el);
    }
  }

  root.appendChild(_bills_sec(`Services (${(data.services || []).length})`));
  if (!(data.services || []).length) {
    root.appendChild(_bills_empty('No services learned yet — the ledger fills from your mail each week.'));
  } else {
    for (const s of data.services) root.appendChild(_bills_svc_row(s, false));
  }

  if ((data.inactive || []).length) {
    root.appendChild(_bills_sec('No longer active'));
    for (const s of data.inactive) root.appendChild(_bills_svc_row(s, true));
  }
}

// ── Post Office (Kate's office, fourth tab — 2026-06-20) ──────────────────
// Client-rendered over /api/specialists/:id/postoffice: the triaged inbox in
// five lanes + an Orders/tracking subtab + connected-account chips. The setup
// gear (open_postoffice_settings_modal) connects inboxes — self-service for
// every user. Live: mail_message_triaged / mail_account_updated SSE drop the
// cache + repaint.

const PO_CACHE_MS = 30_000;

function _po_specialist_id() { return state._pane_specialist_id || state.active_id || 'kate'; }

async function _postoffice_fetch(specialist_id) {
  state._po_cache = state._po_cache || new Map();
  const hit = state._po_cache.get(specialist_id);
  if (hit && Date.now() - hit.at < PO_CACHE_MS) return hit.payload;
  const payload = await api(`/api/specialists/${encodeURIComponent(specialist_id)}/postoffice`);
  state._po_cache.set(specialist_id, { at: Date.now(), payload });
  return payload;
}

const _PO_BUCKETS = [
  ['needs_you', 'Needs you', '⭐'],
  ['replies', 'Replies to your threads', '↩️'],
  ['new_mail', 'New mail', '✉️'],
  ['fyi', 'FYI · subscriptions', '📰'],
  ['junk', 'Filtered junk', '🗑️'],
];

const _PO_STATUS = {
  ok: ['✓ connected', 'ok'],
  auth_failed: ['⚠ sign-in failed', 'err'],
  unreachable: ['⚠ unreachable', 'err'],
  untested: ['• not checked yet', 'muted'],
};

const _PO_ORDER_STATUS = {
  ordered: ['Ordered', 'st-ordered'],
  shipped: ['Shipped', 'st-shipped'],
  in_transit: ['In transit', 'st-transit'],
  out_for_delivery: ['Out for delivery', 'st-out'],
  delivered: ['Delivered', 'st-delivered'],
  unknown: ['—', 'st-unknown'],
};

// Nearest scrollable ancestor (so a live refresh can keep the reader's place).
function _po_scrollable_ancestor(el) {
  let n = el && el.parentElement;
  while (n) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    n = n.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

// Live refresh on a mail SSE event: re-paint ONLY the Post Office view in
// place (not the whole pane) and PRESERVE the scroll position, so new mail
// arriving while you read doesn't yank you back to the top. Debounced so a
// burst (the initial sync) coalesces into one smooth update.
let _po_refresh_timer = null;
function _po_live_refresh(sid) {
  if (state._po_cache) state._po_cache.delete(sid);
  if (_po_refresh_timer) clearTimeout(_po_refresh_timer);
  _po_refresh_timer = setTimeout(() => {
    _po_refresh_timer = null;
    if (!(state.active_id === sid && state.surface === 'office' && state._news_tab === 'postoffice')) return;
    const root = document.querySelector('.postoffice');
    if (!root || !root.isConnected) return;
    const scroller = _po_scrollable_ancestor(root);
    const top = scroller ? scroller.scrollTop : 0;
    _postoffice_paint(root)
      .then(() => { if (scroller) scroller.scrollTop = top; })
      .catch(() => {});
  }, 900);
}

function render_post_office_view() {
  const root = document.createElement('div');
  root.className = 'postoffice';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:48px"></div><div class="office-sk" style="height:200px"></div></div>';
  _postoffice_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Post Office unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
  });
  return root;
}

async function _postoffice_paint(root) {
  const payload = await _postoffice_fetch(_po_specialist_id());
  root.innerHTML = '';
  const accounts = payload.accounts || [];

  if (accounts.length) {
    const strip = document.createElement('div');
    strip.className = 'po-accounts';
    for (const a of accounts) {
      const [lbl, tone] = _PO_STATUS[a.connection_status] || _PO_STATUS.untested;
      const chip = document.createElement('span');
      chip.className = 'po-acct ' + tone;
      chip.innerHTML = `<b>${escape_html(a.display_name)}</b> <span class="po-acct-st">${escape_html(lbl)}</span>`;
      strip.appendChild(chip);
    }
    root.appendChild(strip);
  }

  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'po-empty';
    empty.innerHTML = 'No inbox connected yet. Connect Gmail or iCloud and Kate keeps a pulse on your mail — surfacing the real replies and weeding out the junk.<br>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'po-connect-btn';
    btn.textContent = 'Connect an inbox';
    btn.addEventListener('click', open_postoffice_settings_modal);
    empty.appendChild(btn);
    root.appendChild(empty);
    return;
  }

  const sub = state._po_tab === 'orders' ? 'orders' : 'inbox';
  const bar = document.createElement('div');
  bar.className = 'po-subtabs';
  for (const [key, label] of [['inbox', 'Needs you'], ['orders', 'Orders & tracking']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'po-subtab' + (sub === key ? ' active' : '');
    const n = key === 'orders' ? (payload.orders || []).length : (payload.digest || []).length;
    b.textContent = label + (n ? ` (${n})` : '');
    b.addEventListener('click', () => {
      if ((state._po_tab || 'inbox') === key) return;
      state._po_tab = key;
      if (state._last_pane_doc) render_pane(state._last_pane_doc);
    });
    bar.appendChild(b);
  }
  root.appendChild(bar);

  if (sub === 'orders') _po_render_orders(root, payload);
  else _po_render_digest(root, payload);
}

const _PO_ACTION_LABEL = {
  reply: 'Reply', confirm: 'Confirm', schedule: 'Add to calendar',
  unsubscribe: 'Unsubscribe', dismiss: 'Dismiss', review: 'Review',
  not_me: 'Not me',
};

// The digest is the point: only what needs you, each with Kate's one-line take
// and a recommended action — NOT a mail dump. Bulk/promo/notifications/junk are
// filtered (counted in the footer, never listed).
function _po_render_digest(root, payload) {
  const items = payload.digest || [];
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'po-empty';
    e.textContent = payload.filtered_count
      ? `You're clear — nothing needs you. Kate filtered ${payload.filtered_count} bulk / low-signal message${payload.filtered_count === 1 ? '' : 's'}.`
      : "You're clear — nothing needs you right now.";
    root.appendChild(e);
    _po_append_footer(root, payload);
    return;
  }
  const list = document.createElement('div');
  list.className = 'po-digest';
  for (const m of items) list.appendChild(_po_digest_card(m));
  root.appendChild(list);
  _po_append_footer(root, payload);
}

// Escape text, but make http(s) URLs clickable (so the confirm/reply link in
// an opened email is reachable). Splits on URLs, escapes the rest.
function _po_linkify(text) {
  const parts = String(text || '').split(/(https?:\/\/[^\s<>"')]+)/g);
  return parts
    .map((p, i) => (i % 2 ? `<a href="${escape_html(p)}" target="_blank" rel="noopener">${escape_html(p)}</a>` : escape_html(p)))
    .join('');
}

function _po_digest_card(m) {
  const el = document.createElement('div');
  el.className = 'po-item' + (m.is_reply_to_me ? ' is-reply' : '');
  const who = escape_html(m.from_name || m.from || 'Unknown');
  const when = m.date ? relative_time(m.date) : '';
  const rec = _PO_ACTION_LABEL[m.suggested_action] || 'Review';
  el.innerHTML =
    `<div class="po-item-top"><span class="po-from">${who}</span><span class="po-when">${escape_html(when)}</span></div>`
    + (m.summary ? `<div class="po-summary">${escape_html(m.summary)}</div>` : '')
    + `<div class="po-subj">${escape_html(m.subject || '(no subject)')}</div>`
    + `<div class="po-item-foot"><span class="po-rec">Kate suggests: <b>${escape_html(rec)}</b></span><span class="po-actions"></span></div>`;
  const actions = el.querySelector('.po-actions');
  // Open — expand the full email inline so you can ACT on it (click the confirm
  // link, read the reply). Lazy-fetches the body the first time. This is what
  // makes "Kate suggests: Confirm" actionable today; Kate doing it FOR you is
  // the autonomous layer (next).
  const body_panel = document.createElement('div');
  body_panel.className = 'po-body';
  body_panel.hidden = true;
  let loaded = false;
  // The primary action button is LABELED by what Kate suggested (Confirm /
  // Reply / Add to calendar / Review), so the suggestion is the affordance —
  // not a generic "Open" that ignores it. Today it expands the email inline so
  // you reach the actionable content (the confirm link, the reply thread);
  // Kate doing it FOR you is the autonomous send/schedule layer (next). The
  // 'unsubscribe' suggestion has its own dedicated link below, so label its
  // expand button plainly.
  // When there's a real web-actionable target (a confirm link, a mailto reply),
  // THAT is the primary button and "Open" demotes to a secondary read affordance.
  // Otherwise the labeled expand IS the primary. 'unsubscribe' (own link below)
  // and 'not_me' (its own button below) expand under a plain "Open".
  const has_action = !!(m.action && m.action.url);
  const primary_label =
    has_action || m.suggested_action === 'unsubscribe' || m.suggested_action === 'not_me' ? 'Open' : rec;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = has_action ? 'po-act' : 'po-act primary';
  open.textContent = primary_label;
  open.addEventListener('click', async () => {
    if (!body_panel.hidden) {
      body_panel.hidden = true;
      open.textContent = primary_label;
      return;
    }
    body_panel.hidden = false;
    open.textContent = 'Hide';
    if (loaded) return;
    body_panel.innerHTML = '<div class="po-body-load">Loading…</div>';
    try {
      const full = await api(`/api/specialists/${encodeURIComponent(_po_specialist_id())}/postoffice/messages/${encodeURIComponent(m.id)}`);
      loaded = true;
      body_panel.innerHTML =
        `<div class="po-body-meta">${escape_html(full.from_name || full.from || '')} &lt;${escape_html(full.from || '')}&gt;</div>`
        + `<div class="po-body-text">${_po_linkify(full.body || '(no text content)')}</div>`;
    } catch (e) {
      loaded = false;
      body_panel.innerHTML = `<div class="po-body-load">Couldn't load: ${escape_html((e && e.message) || String(e))}</div>`;
    }
  });
  // The REAL action (server-extracted): a confirm/RSVP link, or a mailto reply
  // that opens the mail client. This is what makes "Confirm" actually confirm
  // and "Reply" actually reply — not just open the email.
  if (has_action) {
    const a = document.createElement('a');
    a.className = 'po-act primary';
    a.textContent = m.action.label;
    a.href = m.action.url;
    a.title = m.action.kind === 'reply' ? 'Reply in your mail app' : 'Open the confirmation link';
    if (!m.action.url.startsWith('mailto:')) { a.target = '_blank'; a.rel = 'noopener'; }
    actions.appendChild(a);
  }
  actions.appendChild(open);
  if (m.list_unsubscribe) {
    const u = document.createElement('a');
    u.className = 'po-act';
    u.textContent = 'Unsubscribe';
    u.href = m.list_unsubscribe;
    u.target = '_blank';
    u.rel = 'noopener';
    actions.appendChild(u);
  }
  // "Not me" — this message is misdirected (a notice for someone else, e.g. a
  // debt collector for a different person with your first name). Marks it
  // handled AND teaches Kate to suppress this sender going forward. Generic +
  // reversible; never a hardcoded block.
  const nm = document.createElement('button');
  nm.type = 'button';
  // When triage flagged the message as misdirected, "Not me" IS the lead action.
  nm.className = m.suggested_action === 'not_me' ? 'po-act primary' : 'po-act';
  nm.textContent = 'Not me';
  nm.title = 'This message is misdirected — filter this sender from now on';
  nm.addEventListener('click', async () => {
    nm.disabled = true;
    nm.textContent = '…';
    try {
      await api(
        `/api/specialists/${encodeURIComponent(_po_specialist_id())}/postoffice/messages/${encodeURIComponent(m.id)}/handled`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handled: true, reason: 'not_me' }) },
      );
      toast(`Got it — I'll filter mail from ${escape_html(m.from_name || m.from || 'this sender')}.`);
      el.remove();
    } catch (e) {
      nm.disabled = false;
      nm.textContent = 'Not me';
      toast('Failed: ' + ((e && e.message) || e), true);
    }
  });
  actions.appendChild(nm);
  const d = document.createElement('button');
  d.type = 'button';
  d.className = 'po-act';
  d.textContent = 'Dismiss';
  d.addEventListener('click', async () => {
    d.disabled = true;
    d.textContent = '…';
    try {
      await api(
        `/api/specialists/${encodeURIComponent(_po_specialist_id())}/postoffice/messages/${encodeURIComponent(m.id)}/handled`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handled: true }) },
      );
      el.remove();
    } catch (e) {
      d.disabled = false;
      d.textContent = 'Dismiss';
      toast('Dismiss failed: ' + ((e && e.message) || e), true);
    }
  });
  actions.appendChild(d);
  el.appendChild(body_panel);
  return el;
}

function _po_append_footer(root, payload) {
  const foot = document.createElement('div');
  foot.className = 'po-foot';
  if (payload.filtered_count) {
    const s = document.createElement('span');
    s.className = 'po-filtered';
    s.textContent = `${payload.filtered_count} filtered as bulk / low-signal`;
    foot.appendChild(s);
  }
  const re = document.createElement('button');
  re.type = 'button';
  re.className = 'po-relink';
  re.textContent = 'Re-run triage';
  re.title = 'Re-judge stored mail with the latest rules';
  re.addEventListener('click', async () => {
    re.disabled = true;
    re.textContent = 'Re-judging…';
    try {
      await api(`/api/specialists/${encodeURIComponent(_po_specialist_id())}/postoffice/retriage`, { method: 'POST' });
      if (state._po_cache) state._po_cache.delete(_po_specialist_id());
      toast('Re-triaged.');
      if (state._last_pane_doc) render_pane(state._last_pane_doc);
    } catch (e) {
      re.disabled = false;
      re.textContent = 'Re-run triage';
      toast('Re-triage failed: ' + ((e && e.message) || e), true);
    }
  });
  foot.appendChild(re);
  root.appendChild(foot);
}

function _po_render_orders(root, payload) {
  const orders = payload.orders || [];
  if (!orders.length) {
    const e = document.createElement('div');
    e.className = 'po-empty';
    e.textContent = 'No tracked orders right now. Order confirmations and shipping emails show up here automatically.';
    root.appendChild(e);
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'po-orders';
  for (const o of orders) grid.appendChild(_po_order_card(o));
  root.appendChild(grid);
}

function _po_order_card(o) {
  const el = document.createElement('div');
  el.className = 'po-order' + (o.flagged ? ' flagged' : '');
  const [stLbl, stCls] = _PO_ORDER_STATUS[o.status] || _PO_ORDER_STATUS.unknown;
  let ship = '';
  for (const s of o.shipments || []) {
    const carrier = escape_html(s.carrier || 'Carrier');
    const eta = s.expected_delivery ? ` · ${escape_html(s.expected_delivery)}` : '';
    if (s.tracking_url) {
      ship += `<div class="po-ship"><a href="${escape_html(s.tracking_url)}" target="_blank" rel="noopener">${carrier}: ${escape_html(s.tracking_number || 'track')}</a>${eta}</div>`;
    } else if (s.tracking_number) {
      ship += `<div class="po-ship">${carrier}: ${escape_html(s.tracking_number)}${eta}</div>`;
    } else if (s.carrier || s.expected_delivery) {
      ship += `<div class="po-ship">${carrier}${eta}</div>`;
    }
  }
  el.innerHTML =
    `<div class="po-order-top"><span class="po-merch">${escape_html(o.merchant || 'Order')}</span><span class="po-st ${stCls}">${escape_html(stLbl)}</span></div>`
    + (o.items ? `<div class="po-items">${escape_html(o.items)}</div>` : '')
    + (o.order_number
      ? `<div class="po-ordno">#${escape_html(o.order_number)}${o.total ? ' · ' + escape_html(o.total) : ''}</div>`
      : (o.total ? `<div class="po-ordno">${escape_html(o.total)}</div>` : ''))
    + ship;
  return el;
}

// ── Research office (Kate's office, third tab — 2026-06-19) ───────────────
// Same client-rendered-tab shape as the News Desk / Market Radar: the data
// comes from /api/specialists/:id/research (the caller's in-flight + recent
// deep-research investigations; per-requester cordon server-side). Live: the
// research_investigation_updated SSE event drops the cache + repaints.

const RESEARCH_CACHE_MS = 30_000;

async function _research_fetch(specialist_id) {
  state._research_cache = state._research_cache || new Map();
  const hit = state._research_cache.get(specialist_id);
  if (hit && Date.now() - hit.at < RESEARCH_CACHE_MS) return hit.payload;
  const payload = await api(`/api/specialists/${encodeURIComponent(specialist_id)}/research`);
  state._research_cache.set(specialist_id, { at: Date.now(), payload });
  return payload;
}

const _RESEARCH_STATUS_LABEL = {
  pending: 'Queued', planning: 'Planning', investigating: 'Researching',
  verifying: 'Verifying', synthesizing: 'Writing the report', done: 'Done', failed: 'Failed',
};

function _research_active_card(it) {
  const el = document.createElement('div');
  el.className = 'research-card';
  const pct = Math.round((it.progress || 0) * 100);
  const label = _RESEARCH_STATUS_LABEL[it.status] || it.status;
  el.innerHTML =
    `<div class="research-card-subject">${escape_html(it.subject)}</div>`
    + `<div class="research-status">${escape_html(label)}`
    + (it.sub_questions_total ? ` · ${it.sub_questions_answered}/${it.sub_questions_total} angles` : '')
    + (it.findings ? ` · ${it.findings} findings` : '')
    + '</div>'
    + `<div class="research-bar"><div class="research-bar-fill" style="width:${pct}%"></div></div>`
    + (it.log && it.log.length ? `<div class="research-log">${escape_html(it.log[it.log.length - 1])}</div>` : '');
  el.addEventListener('click', () => _research_drill(el.closest('.research'), it.investigation_id));
  return el;
}

function _research_recent_row(it) {
  const el = document.createElement('div');
  el.className = 'research-recent';
  el.innerHTML =
    `<span class="research-recent-subject">${escape_html(it.subject)}</span>`
    + `<span class="research-status">${it.status === 'done' ? '✓ report ready' : '⚠ ' + escape_html(it.status)}`
    + (it.findings ? ` · ${it.findings} findings` : '') + '</span>'
    + `<span class="research-recent-when">${it.completed_at ? relative_time(it.completed_at) : ''}</span>`;
  el.addEventListener('click', () => _research_drill(el.closest('.research'), it.investigation_id));
  return el;
}

function render_research_office() {
  const root = document.createElement('div');
  root.className = 'research';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:90px"></div><div class="office-sk" style="height:160px"></div></div>';
  _research_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Research office unavailable: ${escape_html(err && err.message || String(err))}</div>`;
  });
  return root;
}

async function _research_paint(root) {
  const sid = state._pane_specialist_id || 'kate';
  const payload = await _research_fetch(sid);
  if (!root.isConnected && root.childElementCount === 0) return;
  root.innerHTML = '';

  const active = payload.active || [];
  const recent = payload.recent || [];

  if (!active.length && !recent.length) {
    const empty = document.createElement('div');
    empty.className = 'research-empty';
    empty.innerHTML = 'No deep research yet. Ask in chat — e.g. <em>“deep research my massage therapist Dana Marsh”</em> — and a full cited report will land here.';
    root.appendChild(empty);
    return;
  }

  if (active.length) {
    root.appendChild(_research_section('In progress'));
    const grid = document.createElement('div');
    grid.className = 'research-grid';
    for (const it of active) grid.appendChild(_research_active_card(it));
    root.appendChild(grid);
  }
  if (recent.length) {
    root.appendChild(_research_section('Recent reports'));
    const rows = document.createElement('div');
    rows.className = 'research-recents';
    for (const it of recent) rows.appendChild(_research_recent_row(it));
    root.appendChild(rows);
  }
}

function _research_section(text) {
  const el = document.createElement('div');
  el.className = 'research-sec';
  el.textContent = text;
  return el;
}

async function _research_drill(root, rid) {
  if (!root) return;
  const sid = state._pane_specialist_id || 'kate';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:200px"></div></div>';
  let d;
  try {
    d = await api(`/api/specialists/${encodeURIComponent(sid)}/research/${encodeURIComponent(rid)}`);
  } catch (err) {
    root.innerHTML = `<div class="newsdesk-err">Couldn’t load that report: ${escape_html(err && err.message || String(err))}</div>`;
    return;
  }
  root.innerHTML = '';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'research-back';
  back.textContent = '← All research';
  back.addEventListener('click', () => { _research_paint(root).catch(() => {}); });
  root.appendChild(back);

  const head = document.createElement('div');
  head.className = 'research-detail-head';
  head.innerHTML = `<div class="research-card-subject">${escape_html(d.subject)}</div>`
    + `<div class="research-status">${escape_html(_RESEARCH_STATUS_LABEL[d.status] || d.status)}</div>`;
  root.appendChild(head);

  if (d.dossier_md) {
    const dossier = document.createElement('div');
    dossier.className = 'research-dossier md-body';
    dossier.innerHTML = render_md(d.dossier_md);
    root.appendChild(dossier);
  } else {
    const sub = document.createElement('div');
    sub.className = 'research-subs';
    for (const q of d.sub_questions || []) {
      const qel = document.createElement('div');
      qel.className = 'research-sub';
      const fits = (q.findings || []).map((f) => `<li>${escape_html(f.text)}</li>`).join('');
      qel.innerHTML = `<div class="research-sub-q">${escape_html(q.question)}</div>`
        + (fits ? `<ul class="research-sub-findings">${fits}</ul>`
                : `<div class="research-log">${escape_html(q.note || 'working…')}</div>`);
      sub.appendChild(qel);
    }
    root.appendChild(sub);
  }
}

// ── Friends (Kate's office, fourth tab — 2026-06-22) ──────────────────────
// A relationship dossier over the People/ notes (/api/specialists/:id/friends):
// stay-in-touch nudges, dates that matter, structured family/pets, gifting +
// hosting cues, linked flights, an interaction log, and chat-routed intelligence
// (reach out / gift ideas / deep-research / Kate's read). Cordon-filtered;
// genealogy excluded server-side.

const _REL_OPTIONS = ['family', 'friend', 'colleague', 'acquaintance', 'service'];
// The relationship tiers, top rung → bottom. relationship IS the tier; changing
// a card's picker re-buckets the person. 'self' is the pinned "You" rung.
const FRIEND_TIERS = [
  { key: 'self', label: 'You' },
  { key: 'family', label: 'Family' },
  { key: 'friend', label: 'Close Friends' },
  { key: 'colleague', label: 'Colleagues' },
  { key: 'acquaintance', label: 'Acquaintances' },
  { key: 'service', label: 'Service & Workers' },
];
const _CADENCE_OPTIONS = ['', 'weekly', 'monthly', 'quarterly', 'annually', 'event_only'];

function _friends_sid() { return state._pane_specialist_id || state.active_id || 'kate'; }
function _post(obj) { return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }

// Route an action through Kate's real chat turn (draft_message / deep_research /
// gift research all run there) — sets the composer, switches to chat, sends.
function _friends_ask(prompt) {
  try {
    if (typeof composer_input !== 'undefined' && composer_input) composer_input.value = prompt;
    if (typeof set_surface === 'function') set_surface('chat');
    if (typeof send_current === 'function') send_current();
  } catch (e) { /* fall back to a primed composer on the chat surface */ }
}

function render_friends_office() {
  const root = document.createElement('div');
  root.className = 'friends research';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:54px"></div><div class="office-sk" style="height:140px"></div></div>';
  _friends_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Friends unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
  });
  return root;
}

async function _friends_paint(root) {
  const sid = _friends_sid();
  let payload;
  try { payload = await api(`/api/specialists/${encodeURIComponent(sid)}/friends`); }
  catch (err) { root.innerHTML = `<div class="newsdesk-err">Friends unavailable: ${escape_html((err && err.message) || String(err))}</div>`; return; }
  root._friends_pid = null;
  root.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'friends-head';
  const addBtn = document.createElement('button');
  addBtn.type = 'button'; addBtn.className = 'friends-add'; addBtn.textContent = '＋ Add person';
  const slot = document.createElement('div');
  addBtn.addEventListener('click', () => {
    if (slot.childElementCount) { slot.innerHTML = ''; return; }
    slot.appendChild(_friends_form({
      title: 'New person',
      fields: [
        { name: 'name', label: 'Name', placeholder: 'e.g. Dana Marsh' },
        { name: 'relationship', label: 'Relationship', type: 'select', options: _REL_OPTIONS },
      ],
      submit_label: 'Add',
      onSubmit: async (v) => {
        if (!v.name) throw new Error('Name is required');
        const res = await api(`/api/specialists/${encodeURIComponent(sid)}/friends`, _post({ name: v.name, relationship: v.relationship }));
        slot.innerHTML = '';
        if (res && res.id) _friends_drill(root, res.id).catch(() => {}); else _friends_paint(root);
      },
    }));
  });
  head.appendChild(addBtn);
  root.appendChild(head);
  root.appendChild(slot);

  const friends = payload.friends || [];
  if (!friends.length) {
    const empty = document.createElement('div');
    empty.className = 'research-empty';
    empty.innerHTML = 'No people yet. Add someone above, or tell Kate in chat — “Dana is my massage therapist, her birthday is May 4, she has a dog named Biscuit.”';
    root.appendChild(empty);
    return;
  }
  // Group into tier rungs (You → Family → … → Service). The route already
  // sorted (overdue first, then soonest date, then name), so within a rung that
  // order is preserved. An unexpected relationship value falls to "Other".
  const buckets = new Map();
  for (const f of friends) {
    const key = FRIEND_TIERS.some((t) => t.key === f.relationship) ? f.relationship : 'other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(f);
  }
  const render_rung = (label, list) => {
    if (!list || !list.length) return;
    const overdue_n = list.filter((f) => f.overdue).length;
    root.appendChild(_friends_section(`${label} (${list.length})${overdue_n ? ` · ${overdue_n} to reconnect` : ''}`));
    const grid = document.createElement('div'); grid.className = 'research-grid friends-grid';
    for (const f of list) grid.appendChild(_friend_card(f, root));
    root.appendChild(grid);
  };
  for (const tier of FRIEND_TIERS) render_rung(tier.label, buckets.get(tier.key));
  render_rung('Other', buckets.get('other'));
}

function _friend_card(f, root) {
  const card = document.createElement('div');
  card.className = 'research-card friends-card';
  // The relationship pill IS the tier picker (except 'self' → fixed "You").
  const tier_html = f.relationship === 'self'
    ? '<span class="friends-pill">You</span>'
    : `<select class="friends-tier-select" title="Set tier">${FRIEND_TIERS.filter((t) => t.key !== 'self').map((t) => `<option value="${t.key}"${t.key === f.relationship ? ' selected' : ''}>${escape_html(t.label)}</option>`).join('')}</select>`;
  const over = f.overdue ? '<span class="friends-pill friends-overdue">overdue</span>' : '';
  card.innerHTML = `<div class="friends-card-top"><span class="research-card-subject">${escape_html(f.preferred_name || f.name)}</span><span class="friends-pills">${tier_html}${over}</span></div>`;
  const tierSel = card.querySelector('.friends-tier-select');
  if (tierSel) tierSel.addEventListener('change', async (e) => {
    e.stopPropagation();
    try { await api(`/api/specialists/${encodeURIComponent(_friends_sid())}/friends/${encodeURIComponent(f.id)}`, _post({ patch: { relationship: tierSel.value } })); }
    catch (err) { alert((err && err.message) || 'Could not change tier'); return; }
    _friends_paint(root).catch(() => {}); // re-bucket into the new rung
  });
  const up = _friend_next_label(f);
  if (up) { const d = document.createElement('div'); d.className = 'friends-next'; d.textContent = up; card.appendChild(d); }
  if ((f.interests || []).length) {
    const i = document.createElement('div'); i.className = 'friends-muted friends-interests';
    i.textContent = '♥ ' + f.interests.slice(0, 4).join(', '); card.appendChild(i);
  }
  const counts = [];
  if ((f.pets || []).length) counts.push(`🐾 ${f.pets.length}`);
  if ((f.relations || []).length) counts.push(`👪 ${f.relations.length}`);
  if ((f.relationships || []).length) counts.push(`🔗 ${f.relationships.length}`);
  if ((f.flights || []).length) counts.push(`✈️ ${f.flights.length}`);
  if (counts.length) { const c = document.createElement('div'); c.className = 'friends-counts'; c.textContent = counts.join('   '); card.appendChild(c); }
  card.addEventListener('click', (e) => { if (e.target.closest('button') || e.target.closest('select')) return; _friends_drill(root, f.id).catch(() => {}); });
  return card;
}

function _friend_next_label(f) {
  if (f.next_in_days == null || !(f.upcoming || []).length) {
    if (f.overdue && f.days_since_contact != null) return `last talked ${f.days_since_contact}d ago`;
    return '';
  }
  const e = f.upcoming[0];
  const icon = e.kind === 'birthday' ? '🎂' : e.kind === 'anniversary' ? '💍' : '📅';
  const what = e.kind === 'birthday' ? 'birthday' : (e.what || 'anniversary');
  const when = e.days_until === 0 ? 'today' : e.days_until === 1 ? 'tomorrow' : `in ${e.days_until}d`;
  return `${icon} ${what} ${when}`;
}

function _friends_section(text, action) {
  const el = document.createElement('div');
  el.className = 'research-sec friends-sec';
  const span = document.createElement('span'); span.textContent = text; el.appendChild(span);
  if (action) { el.appendChild(action); }
  return el;
}

function _act_btn(label, onClick, cls) {
  const b = document.createElement('button'); b.type = 'button';
  b.className = 'friends-act' + (cls ? ' ' + cls : ''); b.textContent = label;
  b.addEventListener('click', onClick); return b;
}

function _friends_chips(items, onRemove) {
  const wrap = document.createElement('div'); wrap.className = 'friends-chips';
  items.forEach((it, i) => {
    const chip = document.createElement('span'); chip.className = 'friends-chip'; chip.textContent = String(it);
    if (onRemove) { const x = document.createElement('button'); x.type = 'button'; x.className = 'friends-x'; x.textContent = '✕'; x.addEventListener('click', () => onRemove(i)); chip.appendChild(x); }
    wrap.appendChild(chip);
  });
  return wrap;
}

function _friend_flight_line(fl, root, pid, allow_untrack) {
  const row = document.createElement('div'); row.className = 'friends-flight';
  const route = [fl.dep_iata, fl.arr_iata].filter(Boolean).join('→');
  const gate = fl.arr_gate ? ` · gate ${escape_html(fl.arr_gate)}` : (fl.dep_gate ? ` · gate ${escape_html(fl.dep_gate)}` : '');
  const belt = fl.baggage_belt ? ` · belt ${escape_html(fl.baggage_belt)}` : '';
  row.innerHTML = `<span>✈️ <b>${escape_html(fl.flight_no)}</b>${fl.label ? ' (' + escape_html(fl.label) + ')' : ''} — ${escape_html(fl.status || 'tracking')}${route ? ' ' + escape_html(route) : ''}${gate}${belt}</span>`;
  if (allow_untrack) {
    const x = document.createElement('button'); x.type = 'button'; x.className = 'friends-x'; x.textContent = '✕'; x.title = 'Stop tracking';
    x.addEventListener('click', async () => {
      const sid = _friends_sid();
      try { await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}/flight/${encodeURIComponent(fl.id)}`, { method: 'DELETE' }); }
      catch (err) { alert((err && err.message) || 'Could not untrack'); return; }
      _friends_drill(root, pid).catch(() => {});
    });
    row.appendChild(x);
  }
  return row;
}

// Render ANY person-note value as readable text — string/number, an array, or a
// nested object (key: value, with a `{value:…}` wrapper unwrapped). Powers the
// living-CRM details view so every datapoint surfaces with zero per-field code.
function _crm_value(v) {
  if (v == null || v === '') return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.map(_crm_value).filter(Boolean).join(', ');
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === 'value') return _crm_value(v.value);
  return keys
    .filter((k) => v[k] != null && v[k] !== '')
    .map((k) => `${k.replace(/_/g, ' ')}: ${_crm_value(v[k])}`)
    .join(', ');
}

async function _friends_drill(root, pid) {
  const sid = _friends_sid();
  root._friends_pid = pid;
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:200px"></div></div>';
  let d;
  try { d = await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}`); }
  catch (err) { root.innerHTML = `<div class="newsdesk-err">Couldn’t load: ${escape_html((err && err.message) || String(err))}</div>`; return; }
  const f = d.friend;
  const name = f.preferred_name || f.name;
  const redraw = () => _friends_drill(root, pid).catch(() => {});
  const add = (field, item) => api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}/list`, _post({ field, item })).then(redraw);
  const rm = (field, index) => api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}/list/remove`, _post({ field, index })).then(redraw);

  root.innerHTML = '';
  const back = document.createElement('button'); back.type = 'button'; back.className = 'research-back'; back.textContent = '← All friends';
  back.addEventListener('click', () => { root._friends_pid = null; _friends_paint(root).catch(() => {}); });
  root.appendChild(back);

  // Header
  const head = document.createElement('div'); head.className = 'research-detail-head';
  head.innerHTML = `<div class="research-card-subject">${escape_html(name)}${f.pronouns ? ` <span class="friends-muted">(${escape_html(f.pronouns)})</span>` : ''}</div><div class="research-status">${escape_html(f.relationship || '')}${f.how_we_met ? ' · ' + escape_html(String(f.how_we_met)) : ''}</div>`;
  // Remove-contact affordance (confirm-gated; deletes the note + relationships +
  // flights + observations). The fix for "there's a duplicate Kim I can't remove."
  const del_btn = document.createElement('button'); del_btn.type = 'button'; del_btn.className = 'friends-x'; del_btn.title = 'Remove contact'; del_btn.textContent = '🗑';
  del_btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove ${name} from your contacts? This deletes their note, relationships, and tracked flights.`)) return;
    try { await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}`, { method: 'DELETE' }); }
    catch (err) { alert((err && err.message) || 'Could not remove'); return; }
    root._friends_pid = null; _friends_paint(root).catch(() => {});
  });
  head.appendChild(del_btn);
  root.appendChild(head);

  // Contact & details — the living CRM record: every datapoint we have on this
  // person (phone/email/address/sizes/travel notes) PLUS the `facts` catch-all,
  // so anything Kate records now or LATER surfaces automatically — not a
  // hand-picked subset.
  root.appendChild(_friends_section('Contact & details'));
  const crmWrap = document.createElement('div'); crmWrap.className = 'friends-upcoming';
  const crmRow = (label, value, icon) => {
    const s = _crm_value(value);
    if (!s) return;
    const row = document.createElement('div');
    row.innerHTML = `<span class="friends-muted">${icon ? icon + ' ' : ''}${escape_html(label)}:</span> ${escape_html(s)}`;
    crmWrap.appendChild(row);
  };
  const contactInfo = f.contact && typeof f.contact === 'object' ? f.contact : {};
  crmRow('Email', contactInfo.email, '✉️');
  crmRow('Phone', contactInfo.phone, '📞');
  crmRow('Preferred', contactInfo.preferred_channel, '💬');
  crmRow('Address', f.address, '📍');
  crmRow('Sizes', f.sizes, '📏');
  crmRow('Travel notes', f.travel_notes, '✈️');
  // The living catch-all — every other fact recorded on this person's note.
  for (const [k, v] of Object.entries(f.facts || {})) crmRow(k.replace(/_/g, ' '), v, '•');
  if (!crmWrap.childElementCount) {
    const n = document.createElement('div'); n.className = 'friends-muted';
    n.textContent = 'No contact details yet — tell Kate things like “Sam’s email is sam@example.com”.';
    crmWrap.appendChild(n);
  }
  root.appendChild(crmWrap);

  // Stay in touch
  const touchAction = _act_btn('Reach out', () => _friends_ask(`Draft a short, warm note to ${name} to reconnect.`), 'primary');
  root.appendChild(_friends_section('Stay in touch', touchAction));
  const touch = document.createElement('div'); touch.className = 'friends-touch';
  const cad = f.contact_cadence ? `every ${f.contact_cadence === 'event_only' ? 'big occasion' : f.contact_cadence.replace(/ly$/, '')}` : 'no cadence set';
  const since = f.days_since_contact == null ? 'never logged' : `${f.days_since_contact}d ago`;
  touch.innerHTML = `<span class="${f.overdue ? 'friends-overdue-txt' : ''}">Last contact: ${since}</span> · <span>${escape_html(cad)}</span>`;
  root.appendChild(touch);
  const touchBtns = document.createElement('div'); touchBtns.className = 'friends-btnrow';
  touchBtns.appendChild(_act_btn('✓ Log contact today', async () => { try { await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}/contacted`, _post({})); } catch (e) {} redraw(); }));
  const cadSel = document.createElement('select'); cadSel.className = 'friends-inline-select';
  for (const o of _CADENCE_OPTIONS) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o ? `cadence: ${o}` : 'cadence: —'; if (o === (f.contact_cadence || '')) opt.selected = true; cadSel.appendChild(opt); }
  cadSel.addEventListener('change', async () => { try { await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}`, _post({ patch: { contact_cadence: cadSel.value || undefined } })); } catch (e) {} redraw(); });
  touchBtns.appendChild(cadSel);
  root.appendChild(touchBtns);

  // Dates
  root.appendChild(_friends_section('Dates that matter'));
  const dates = document.createElement('div'); dates.className = 'friends-upcoming';
  if (f.birthday) { const b = document.createElement('div'); b.textContent = `🎂 birthday ${f.birthday}`; dates.appendChild(b); }
  for (const e of f.upcoming || []) {
    if (e.kind === 'birthday') continue; // shown above
    const icon = e.kind === 'anniversary' ? '💍' : '📅';
    const r = document.createElement('div'); r.textContent = `${icon} ${e.what || e.kind} — in ${e.days_until}d (${e.date})`; dates.appendChild(r);
  }
  if (!dates.childElementCount) { const n = document.createElement('div'); n.className = 'friends-muted'; n.textContent = 'No dates yet.'; dates.appendChild(n); }
  root.appendChild(dates);
  root.appendChild(_friends_form({
    title: 'Add a date', compact: true,
    fields: [
      { name: 'date', label: 'Date', placeholder: 'YYYY-MM-DD or MM-DD' },
      { name: 'what', label: 'What', placeholder: 'e.g. surgery, new job, graduation' },
      { name: 'recurring', label: 'Repeats yearly', type: 'checkbox' },
    ],
    submit_label: 'Add date',
    onSubmit: async (v) => { if (!v.date || !v.what) throw new Error('Date and label required'); await add('important_dates', { date: v.date, what: v.what, recurring: !!v.recurring }); },
  }));

  // Family & pets
  root.appendChild(_friends_section('Family & pets'));
  if ((f.relations || []).length) {
    const wrap = document.createElement('div'); wrap.className = 'friends-flights';
    f.relations.forEach((p, i) => {
      const row = document.createElement('div'); row.className = 'friends-flight';
      // Tolerant of both the legacy {name, relation} and the richer
      // {to, predicate} relation shapes the graph now writes.
      const rn = p.name || p.to || ''; const rr = p.relation || p.predicate || '';
      row.innerHTML = `<span>👤 <b>${escape_html(rn)}</b>${rr ? ' — ' + escape_html(rr) : ''}${p.birthday ? ' · 🎂 ' + escape_html(p.birthday) : ''}</span>`;
      const x = document.createElement('button'); x.type = 'button'; x.className = 'friends-x'; x.textContent = '✕'; x.addEventListener('click', () => rm('relations', i)); row.appendChild(x);
      wrap.appendChild(row);
    });
    root.appendChild(wrap);
  }
  if ((f.pets || []).length) {
    const wrap = document.createElement('div'); wrap.className = 'friends-flights';
    f.pets.forEach((p, i) => {
      const row = document.createElement('div'); row.className = 'friends-flight';
      const meta = [p.species, p.breed, p.notes].filter(Boolean).map(String).join(' · ');
      row.innerHTML = `<span>🐾 <b>${escape_html(p.name || '')}</b>${meta ? ' — ' + escape_html(meta) : ''}</span>`;
      const x = document.createElement('button'); x.type = 'button'; x.className = 'friends-x'; x.textContent = '✕'; x.addEventListener('click', () => rm('pets', i)); row.appendChild(x);
      wrap.appendChild(row);
    });
    root.appendChild(wrap);
  }
  const fpForms = document.createElement('div'); fpForms.className = 'friends-twocol';
  fpForms.appendChild(_friends_form({
    title: 'Add family member', compact: true,
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Mia' },
      { name: 'relation', label: 'Relation', placeholder: 'partner / child / parent' },
      { name: 'birthday', label: 'Birthday', placeholder: 'YYYY-MM-DD (optional)' },
    ],
    submit_label: 'Add', onSubmit: async (v) => { if (!v.name || !v.relation) throw new Error('Name and relation required'); await add('relations', { name: v.name, relation: v.relation, birthday: v.birthday || undefined }); },
  }));
  fpForms.appendChild(_friends_form({
    title: 'Add pet', compact: true,
    fields: [
      { name: 'name', label: 'Name', placeholder: 'e.g. Max' },
      { name: 'species', label: 'Species', placeholder: 'dog / cat / …' },
      { name: 'notes', label: 'Notes', placeholder: 'breed, quirks (optional)' },
    ],
    submit_label: 'Add', onSubmit: async (v) => { if (!v.name) throw new Error('Name required'); await add('pets', { name: v.name, species: v.species || undefined, notes: v.notes || undefined }); },
  }));
  root.appendChild(fpForms);

  // Connections — the relationship graph (both directions, with provenance).
  // Read-only here; the told-first author path is Kate chat ("Rosa is X's
  // hairdresser") via record_relationship. This panel is "what Kate believes."
  root.appendChild(_friends_section('Connections'));
  if ((f.relationships || []).length) {
    const wrap = document.createElement('div'); wrap.className = 'friends-flights';
    for (const rel of f.relationships) {
      const row = document.createElement('div'); row.className = 'friends-flight';
      const icon = rel.with_kind === 'place' ? '📍' : '🔗';
      const phrase = rel.direction === 'outgoing'
        ? `${escape_html(rel.role)}: <b>${escape_html(rel.with)}</b>`
        : `<b>${escape_html(rel.with)}</b>’s ${escape_html(rel.role)}`;
      const prov = rel.provenance || 'told';
      row.innerHTML = `<span>${icon} ${phrase} <span class="friends-muted">(${escape_html(prov)})</span></span>`;
      wrap.appendChild(row);
    }
    root.appendChild(wrap);
  } else {
    const n = document.createElement('div'); n.className = 'friends-muted';
    n.textContent = `No connections yet — tell Kate things like “Rosa is ${name}’s hairdresser”.`;
    root.appendChild(n);
  }

  // Hearth's read — the synthesis pass's durable narrative (a portrait + recurring
  // themes), distilled nightly from the observation stream below. Private to you
  // (it draws on owner-only observations); shown only when there's something to say.
  const _syn = f.synthesis;
  if (_syn && ((_syn.summary && _syn.summary.trim()) || (_syn.themes || []).length)) {
    root.appendChild(_friends_section('Hearth’s read'));
    if (_syn.summary && _syn.summary.trim()) {
      const s = document.createElement('div'); s.className = 'friends-synthesis-summary'; s.textContent = _syn.summary.trim();
      root.appendChild(s);
    }
    if ((_syn.themes || []).length) {
      const ul = document.createElement('ul'); ul.className = 'friends-synthesis-themes';
      for (const t of _syn.themes) { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); }
      root.appendChild(ul);
    }
    const meta = document.createElement('div'); meta.className = 'friends-muted';
    const swhen = (_syn.updated_at || '').slice(0, 10);
    const sn = _syn.source_observation_count || 0;
    meta.textContent = `Distilled from ${sn} observation${sn === 1 ? '' : 's'}${swhen ? ' · ' + swhen : ''}.`;
    root.appendChild(meta);
  }

  // What Hearth's noticed — the observational engine (A+D). Signals the system
  // picked up on its OWN (a mention, a capture, later a visit), each tagged with
  // its source so you can see where it learned it; ✕ dismisses noise.
  // The iMessage opt-in (per-contact, default OFF) gates the richest source:
  // Hearth learns from your 1:1 threads with this person and keeps only the
  // distillate (facts + open loops), never your messages.
  const _im_on = !!f.imessage_opt_in;
  const imBtn = _act_btn(_im_on ? '✓ iMessage: on' : 'Observe iMessage', async () => {
    try { await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}/imessage_opt_in`, _post({ enabled: !_im_on })); } catch (e) {}
    redraw();
  }, _im_on ? 'primary' : '');
  imBtn.title = _im_on
    ? `Observing your iMessages with ${name}. Only the distillate (facts & open loops) is kept — raw messages are never stored. Tap to turn off.`
    : `Turn on to keep up with ${name} from your 1:1 iMessage threads. Private to you; only the distillate is saved, never your messages.`;
  root.appendChild(_friends_section('What Hearth’s noticed', imBtn));
  const imNote = document.createElement('div'); imNote.className = 'friends-muted';
  imNote.textContent = _im_on
    ? 'iMessage observing is ON — only durable facts & open loops are saved (private to you); raw messages are never stored.'
    : `iMessage observing is off for ${name}. Turn it on (above) to learn from your 1:1 threads — distillate only, never your messages.`;
  root.appendChild(imNote);
  if ((f.observations || []).length) {
    const wrap = document.createElement('div'); wrap.className = 'friends-flights';
    for (const ob of f.observations) {
      const row = document.createElement('div'); row.className = 'friends-flight';
      const when = (ob.observed_at || '').slice(0, 10);
      row.innerHTML = `<span>👁 ${escape_html(ob.summary)} <span class="friends-muted">(${escape_html(ob.source_type)}${when ? ' · ' + escape_html(when) : ''})</span></span>`;
      const x = document.createElement('button'); x.type = 'button'; x.className = 'friends-x'; x.textContent = '✕'; x.title = 'Dismiss';
      x.addEventListener('click', async () => {
        try { await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}/observation/${encodeURIComponent(ob.id)}/dismiss`, _post({})); } catch (e) {}
        redraw();
      });
      row.appendChild(x);
      wrap.appendChild(row);
    }
    root.appendChild(wrap);
  } else {
    const n = document.createElement('div'); n.className = 'friends-muted';
    n.textContent = 'Nothing noticed yet — Hearth will log mentions, captures, and visits here as it sees them.';
    root.appendChild(n);
  }

  // Gifting & hosting
  const giftAction = _act_btn('Gift ideas', () => _friends_ask(`Suggest a few gift ideas for ${name} based on their interests${(f.interests || []).length ? ' (' + f.interests.join(', ') + ')' : ''}. Check their gift history so we don't repeat.`), 'primary');
  root.appendChild(_friends_section('Gifting & hosting', giftAction));
  const gh = document.createElement('div'); gh.className = 'friends-giftbox';
  const sub = (label, items, field) => {
    const wrap = document.createElement('div'); wrap.className = 'friends-subrow';
    const lab = document.createElement('span'); lab.className = 'friends-sublabel'; lab.textContent = label; wrap.appendChild(lab);
    wrap.appendChild(_friends_chips(items, (i) => rm(field, i)));
    const addInput = document.createElement('input'); addInput.className = 'friends-chip-add'; addInput.placeholder = '+ add';
    addInput.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && addInput.value.trim()) { const val = addInput.value.trim(); addInput.value = ''; try { await add(field, val); } catch (er) { alert((er && er.message) || 'failed'); } } });
    wrap.appendChild(addInput);
    return wrap;
  };
  gh.appendChild(sub('Interests', f.interests || [], 'likes'));
  gh.appendChild(sub('Avoid', f.dislikes || [], 'dislikes'));
  gh.appendChild(sub('Dietary', f.dietary || [], 'dietary'));
  if ((f.gift_history || []).length) {
    const ghist = document.createElement('div'); ghist.className = 'friends-muted';
    ghist.textContent = 'Past gifts: ' + f.gift_history.map((g) => g.what + (g.date ? ` (${g.date})` : '')).join(', ');
    gh.appendChild(ghist);
  }
  root.appendChild(gh);

  // Visits & flights
  root.appendChild(_friends_section('Visits & flights'));
  if ((f.flights || []).length) { const wrap = document.createElement('div'); wrap.className = 'friends-flights'; for (const x of f.flights) wrap.appendChild(_friend_flight_line(x, root, pid, true)); root.appendChild(wrap); }
  else { const n = document.createElement('div'); n.className = 'friends-muted'; n.textContent = 'No flights tracked.'; root.appendChild(n); }
  root.appendChild(_friends_form({
    title: 'Track a flight', compact: true,
    fields: [
      { name: 'flight_no', label: 'Flight', placeholder: 'e.g. UA2245' },
      { name: 'date', label: 'Date', placeholder: 'YYYY-MM-DD (default today)' },
      { name: 'label', label: 'Note', placeholder: 'e.g. coming to visit' },
    ],
    submit_label: 'Track', onSubmit: async (v) => { if (!v.flight_no) throw new Error('Flight number required'); await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}/flight`, _post({ flight_no: v.flight_no, date: v.date || undefined, label: v.label || undefined })); redraw(); },
  }));

  // History (interaction log)
  const logAction = _act_btn('Kate’s read', () => _friends_ask(`Give me a quick read on ${name} — what should I know and is there anything I'm overdue on?`));
  root.appendChild(_friends_section('History', logAction));
  if (f.note_body && f.note_body.trim()) { const body = document.createElement('div'); body.className = 'research-dossier md-body friends-notes'; body.innerHTML = render_md(f.note_body); root.appendChild(body); }
  root.appendChild(_friends_form({
    title: 'Log an interaction', compact: true,
    fields: [{ name: 'note', label: '', placeholder: 'e.g. had coffee — stressed about the move' }],
    submit_label: 'Log', onSubmit: async (v) => { if (!v.note) throw new Error('Write something'); await api(`/api/specialists/${encodeURIComponent(sid)}/friends/${encodeURIComponent(pid)}`, _post({ body_append: `- ${local_today_str()}: ${v.note}` })); redraw(); },
  }));

  // Intelligence
  const research = _act_btn(`Deep-research ${name}`, () => _friends_ask(`Deeply research ${name} and add what you find to their record.`), 'primary');
  root.appendChild(_friends_section('Intelligence', research));
}

function local_today_str() {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Denver' }); } catch (e) { return ''; }
}

// Compact inline form: fields → values; onSubmit(values) async (throws to show
// an error). Supports text / select / checkbox. Reused across the dossier.
function _friends_form(opts) {
  const form = document.createElement('form');
  form.className = 'friends-form' + (opts.compact ? ' friends-form-compact' : '');
  if (opts.title) { const t = document.createElement('div'); t.className = 'friends-form-title'; t.textContent = opts.title; form.appendChild(t); }
  const inputs = {};
  const fieldwrap = document.createElement('div'); fieldwrap.className = 'friends-fields';
  for (const fld of opts.fields) {
    const row = document.createElement('label'); row.className = 'friends-field';
    if (fld.label) { const sp = document.createElement('span'); sp.textContent = fld.label; row.appendChild(sp); }
    let input;
    if (fld.type === 'select') { input = document.createElement('select'); for (const o of fld.options) { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; input.appendChild(opt); } }
    else if (fld.type === 'checkbox') { input = document.createElement('input'); input.type = 'checkbox'; }
    else { input = document.createElement('input'); input.type = 'text'; if (fld.placeholder) input.placeholder = fld.placeholder; }
    inputs[fld.name] = { el: input, type: fld.type };
    row.appendChild(input); fieldwrap.appendChild(row);
  }
  form.appendChild(fieldwrap);
  const err = document.createElement('div'); err.className = 'friends-form-err';
  const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'friends-save'; submit.textContent = opts.submit_label || 'Save';
  form.appendChild(submit); form.appendChild(err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = ''; submit.disabled = true;
    const v = {};
    for (const [k, o] of Object.entries(inputs)) v[k] = o.type === 'checkbox' ? o.el.checked : o.el.value.trim();
    try { await opts.onSubmit(v); } catch (ex) { err.textContent = (ex && ex.message) || String(ex); submit.disabled = false; }
  });
  return form;
}

// ── Market Radar (Vivian's fuel office, second tab — 2026-06-12) ──────────
// Same client-rendered-tab shape as the News Desk: the snapshot comes
// from /api/specialists/:id/market_radar (latest refresh_market_radar
// run grouped per theme + the finance-news rail). Owner-only server-side.

function render_fuel_tabs() {
  const bar = document.createElement('div');
  bar.className = 'news-tabs';
  for (const [key, label] of [['fuel', 'Finances'], ['radar', 'Market Radar']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'news-tab' + ((state._fuel_tab || 'fuel') === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if ((state._fuel_tab || 'fuel') === key) return;
      state._fuel_tab = key;
      if (state._last_pane_doc) render_pane(state._last_pane_doc);
    });
    bar.appendChild(b);
  }
  return bar;
}

// ── Cordelia's Second Brain (library office tab) ────────────────────────────
// A client-rendered tab on her library office (pane_kind 'library'), same shape
// as the fuel/Market-Radar tab: a living knowledge mesh over
// /api/specialists/cordelia/brain — Cordelia at the center weaving her shelves,
// each synthesis a star (size = worth, colour = health grade), raw source dots
// feeding it. Click a synthesis to zoom to its individual facts + their
// provenance (which source notes ground it; click a source to see what it fed).
function render_library_tabs() {
  const bar = document.createElement('div');
  bar.className = 'news-tabs';
  for (const [key, label] of [['library', 'Library'], ['brain', 'The Second Brain']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'news-tab' + ((state._library_tab || 'library') === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if ((state._library_tab || 'library') === key) return;
      state._library_tab = key;
      if (state._last_pane_doc) render_pane(state._last_pane_doc);
    });
    bar.appendChild(b);
  }
  return bar;
}

const BRAIN_CACHE_MS = 60_000;
// Refined, lightly-desaturated system palette; `hi` is the orb's highlight stop
// (light from upper-left) so each star reads as a glowing sphere, not a flat dot.
const BRAIN_GRADE = {
  strong: { c: '#2FB07A', hi: '#74D6AB', label: 'strong' },
  sound: { c: '#2E89E6', hi: '#76B6F4', label: 'sound' },
  weak: { c: '#EEA23C', hi: '#F8CB80', label: 'weak' },
  rotting: { c: '#E2554F', hi: '#F2918C', label: 'rotting' },
};

async function _brain_fetch(specialist_id) {
  state._brain_cache = state._brain_cache || new Map();
  const hit = state._brain_cache.get(specialist_id);
  if (hit && Date.now() - hit.at < BRAIN_CACHE_MS) return hit.payload;
  const payload = await api(`/api/specialists/${encodeURIComponent(specialist_id)}/brain`);
  state._brain_cache.set(specialist_id, { at: Date.now(), payload });
  return payload;
}

function render_brain_view() {
  const root = document.createElement('div');
  root.className = 'brain';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:54px"></div><div class="office-sk" style="height:360px"></div></div>';
  _brain_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">The second brain is unavailable: ${escape_html(err && err.message || String(err))}</div>`;
  });
  return root;
}

function _brain_node_r(n) {
  return 7 + Math.min(n.source_count || 0, 12) * 0.9;
}

async function _brain_paint(root) {
  const sid = state._pane_specialist_id || 'cordelia';
  const payload = await _brain_fetch(sid);
  if (!root.isConnected && root.childElementCount === 0) return;
  root.innerHTML = '';
  const nodes = payload.nodes || [];
  const m = payload.metrics || {};

  const metrics = document.createElement('div');
  metrics.className = 'brain-metrics';
  metrics.innerHTML = [
    ['syntheses', m.syntheses], ['source links', m.source_links],
    ['fabrications caught', m.fabrications_caught], ['shelves', m.shelves],
  ].map(([l, v]) => `<div class="brain-metric"><span class="brain-metric-n">${escape_html(String(v ?? 0))}</span><span class="brain-metric-l">${escape_html(l)}</span></div>`).join('');
  root.appendChild(metrics);

  if (!nodes.length) {
    const empty = document.createElement('div');
    empty.className = 'brain-empty';
    empty.textContent = 'No syntheses yet — Cordelia distills your shelves into evergreen notes nightly at 04:20.';
    root.appendChild(empty);
    return;
  }

  // ── layout: hub at centre; every shelf gets an angular SECTOR sized to its
  //    node count, so the WHOLE ring is used — a lone shelf fills the circle
  //    instead of cramming into a top arc (the pile-up bug). Nodes spread
  //    evenly across their sector on two alternating radii; labels are then
  //    de-collided vertically by a deterministic solver with leader lines. ────
  const W = 1040, H = 740, hx = W / 2, hy = H / 2;
  const esc = escape_html;
  const trunc = (t, n2) => { t = String(t || ''); return t.length > n2 ? t.slice(0, n2 - 1).trimEnd() + '…' : t; };
  const shelves = payload.shelves || [];
  const by_shelf = new Map();
  for (const n of nodes) { if (!by_shelf.has(n.shelf)) by_shelf.set(n.shelf, []); by_shelf.get(n.shelf).push(n); }
  const shelf_ids = [];
  for (const sh of shelves) if (by_shelf.has(sh.id)) shelf_ids.push(sh.id);
  for (const id of by_shelf.keys()) if (!shelf_ids.includes(id)) shelf_ids.push(id);
  const shelf_name = new Map(shelves.map((s2) => [s2.id, s2.name]));
  const total = nodes.length || 1;
  const multi = shelf_ids.length > 1;
  const GAP = multi ? 0.10 : 0;                         // angular padding between sectors
  const usable = 2 * Math.PI - GAP * shelf_ids.length;
  const R = 232;
  const npos = new Map();                               // id -> { x, y, a }
  const shelf_mid = new Map();                          // id -> sector mid angle
  let cursor = -Math.PI / 2;                            // first sector starts at top
  for (const sid of shelf_ids) {
    const arr = by_shelf.get(sid);
    const sector = usable * (arr.length / total);
    const a0 = cursor + GAP / 2, a1 = a0 + sector;
    const pad = Math.min(0.18, sector * 0.16);          // keep nodes off the sector seams
    const lo = a0 + pad, hi = a1 - pad;
    arr.forEach((n, j) => {
      const t = arr.length === 1 ? 0.5 : j / (arr.length - 1);
      const a = lo + (hi - lo) * t;
      const rr = R + (j % 2 ? 26 : -8);                 // alternate radii so angular neighbours don't kiss
      npos.set(n.id, { x: hx + Math.cos(a) * rr, y: hy + Math.sin(a) * rr, a });
    });
    shelf_mid.set(sid, (a0 + a1) / 2);
    cursor = a1 + GAP / 2;
  }

  // ── build the SVG (one camera <g> for pan/zoom) ──────────────────────────
  // <defs>: per-grade orb gradients (light from upper-left) + the hub gradient.
  let defs = '<defs>';
  for (const k of ['strong', 'sound', 'weak', 'rotting']) {
    const gg = BRAIN_GRADE[k];
    defs += `<radialGradient id="bm-grad-${k}" cx="0.36" cy="0.30" r="0.9"><stop offset="0" stop-color="${gg.hi}"/><stop offset="0.6" stop-color="${gg.c}"/><stop offset="1" stop-color="${gg.c}"/></radialGradient>`;
  }
  defs += '<radialGradient id="bm-hub-grad" cx="0.4" cy="0.34" r="0.78"><stop offset="0" stop-color="#A8A2F4"/><stop offset="1" stop-color="#6A62D6"/></radialGradient></defs>';
  let s = `<svg class="brain-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Knowledge mesh: ${nodes.length} syntheses across ${shelf_ids.length} shelves">${defs}<g class="bm-cam">`;
  // faint orbit guide grounds the radial structure
  s += `<circle class="bm-orbit" cx="${hx}" cy="${hy}" r="${R}"/>`;
  // hub → each node (behind everything)
  nodes.forEach((n) => { const p = npos.get(n.id); if (p) s += `<line class="bm-hub" x1="${hx}" y1="${hy}" x2="${p.x}" y2="${p.y}"/>`; });
  // cross-shelf connections (#4) — faint synapse arcs bowing toward the hub:
  // the MESH that makes this a brain, not a stack of shelves. They light when a
  // node they touch is selected (see _brain_open).
  (payload.connections || []).forEach((cn) => {
    const pa = npos.get(cn.a), pb = npos.get(cn.b);
    if (!pa || !pb) return;
    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    const cx2 = mx + (hx - mx) * 0.38, cy2 = my + (hy - my) * 0.38;
    s += `<path class="bm-link" d="M${pa.x.toFixed(1)} ${pa.y.toFixed(1)} Q${cx2.toFixed(1)} ${cy2.toFixed(1)} ${pb.x.toFixed(1)} ${pb.y.toFixed(1)}" data-la="${encodeURIComponent(cn.a)}" data-lb="${encodeURIComponent(cn.b)}"><title>related across shelves (${Number(cn.weight).toFixed(2)})</title></path>`;
  });
  // shelf labels at each sector's outer edge
  for (const sid of shelf_ids) {
    const a = shelf_mid.get(sid); const c = Math.cos(a);
    s += `<text class="bm-shelf" x="${(hx + c * 332).toFixed(1)}" y="${(hy + Math.sin(a) * 332 + 4).toFixed(1)}" text-anchor="${c > 0.34 ? 'start' : c < -0.34 ? 'end' : 'middle'}">${esc(shelf_name.get(sid) || sid)}</text>`;
  }
  // gaps-as-voids — quiet "the brain is hungry here" markers, EVENLY spaced on
  // a calm middle ring so they never pile up (many demand topics map to the same
  // hot shelves). Restraint: just a faint dashed circle by default; the topic
  // reveals on hover (and a tooltip) so the centre stays clean.
  const gaps = (payload.gaps || []).slice(0, 6);
  gaps.forEach((gap, gi) => {
    const a = -Math.PI / 2 + (2 * Math.PI * (gi + 0.5)) / Math.max(1, gaps.length);
    const vx = hx + Math.cos(a) * 152, vy = hy + Math.sin(a) * 152, c = Math.cos(a);
    const anc = c > 0.34 ? 'start' : c < -0.34 ? 'end' : 'middle';
    s += `<g class="bm-void-g"><circle class="bm-void" cx="${vx.toFixed(1)}" cy="${vy.toFixed(1)}" r="5.5"><title>hungry to learn — ${esc(gap.sample || gap.label)}</title></circle><text class="bm-void-t" x="${(vx + c * 10).toFixed(1)}" y="${(vy + 4).toFixed(1)}" text-anchor="${anc}">${esc(trunc(gap.label, 18))}</text></g>`;
  });
  // the focused node's sources bloom into this layer on click
  s += '<g class="bm-srcs-live"></g>';
  // synthesis stars
  nodes.forEach((n, i) => {
    const p = npos.get(n.id); if (!p) return;
    const r = _brain_node_r(n);
    const gk = BRAIN_GRADE[n.health_grade] ? n.health_grade : 'sound';
    const g = BRAIN_GRADE[gk];
    if (n.grounding_outcome && n.grounding_outcome !== 'clean') s += `<circle class="bm-flag" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(r + 3.5).toFixed(1)}"/>`;
    s += `<circle class="bm-node" data-node="${i}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="url(#bm-grad-${gk})" style="--g:${g.c};animation-delay:${Math.min(i * 26, 600)}ms"><title>${esc(n.topic)} · ${g.label} ${Number(n.health_score).toFixed(2)}</title></circle>`;
  });

  // ── labels: place outboard of each star, then de-collide vertically ───────
  const labels = nodes.map((n, i) => {
    const p = npos.get(n.id); if (!p) return null;
    const r = _brain_node_r(n);
    const c = Math.cos(p.a), sn = Math.sin(p.a);
    const anchor = c > 0.34 ? 'start' : c < -0.34 ? 'end' : 'middle';
    const text = trunc(n.topic, 24);
    const ax = p.x + c * (r + 9), y0 = p.y + sn * (r + 9) + 4;
    return { i, anchor, text, ax, y: y0, w: text.length * 6.1, h: 14, ex: p.x + c * (r + 2), ey: p.y + sn * (r + 2) };
  }).filter(Boolean);
  const xspan = (L) => L.anchor === 'start' ? [L.ax, L.ax + L.w] : L.anchor === 'end' ? [L.ax - L.w, L.ax] : [L.ax - L.w / 2, L.ax + L.w / 2];
  for (let it = 0; it < 90; it++) {
    let moved = false;
    for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) {
      const A = labels[a], B = labels[b];
      const [aL, aR] = xspan(A), [bL, bR] = xspan(B);
      if (aR < bL - 2 || bR < aL - 2) continue;         // no horizontal overlap → can't collide
      const dy = B.y - A.y, need = (A.h + B.h) / 2 + 2.5;
      if (Math.abs(dy) >= need) continue;
      const push = (need - Math.abs(dy)) / 2 + 0.4;
      if (dy >= 0) { A.y -= push; B.y += push; } else { A.y += push; B.y -= push; }
      moved = true;
    }
    if (!moved) break;
  }
  for (const L of labels) {
    L.y = Math.max(15, Math.min(H - 8, L.y));
    if (Math.abs(L.y - L.ey) > 8) s += `<line class="bm-leader" x1="${L.ex.toFixed(1)}" y1="${L.ey.toFixed(1)}" x2="${L.ax.toFixed(1)}" y2="${(L.y - 4).toFixed(1)}"/>`;
    s += `<text class="bm-label" data-label="${L.i}" x="${L.ax.toFixed(1)}" y="${L.y.toFixed(1)}" text-anchor="${L.anchor}">${esc(L.text)}</text>`;
  }
  // hub — a glowing core with a breathing halo ring
  s += `<circle class="bm-hubhalo" cx="${hx}" cy="${hy}" r="40"/><circle class="bm-hubring" cx="${hx}" cy="${hy}" r="30"/><circle class="bm-hubc" cx="${hx}" cy="${hy}" r="22" fill="url(#bm-hub-grad)"/><text class="bm-hubt" x="${hx}" y="${hy + 4}" text-anchor="middle">Cordelia</text>`;
  s += '</g></svg>';

  const search = document.createElement('div');
  search.className = 'brain-search';
  search.innerHTML =
    '<input type="search" placeholder="Spotlight — recall across the brain…" aria-label="Search the second brain" />'
    + '<button type="button" class="brain-resynth" title="Re-distill the shelves now — heal rot, prune dead weight, regenerate">↻ Re-synthesize</button>';
  root.appendChild(search);

  // #5 owner cockpit: fire Cordelia's nightly distill job on demand (heal +
  // synthesize). The brain view is owner-gated at the route, so this only ever
  // renders for the owner.
  const resynth = search.querySelector('.brain-resynth');
  if (resynth) resynth.addEventListener('click', async () => {
    const label = resynth.textContent;
    resynth.disabled = true;
    resynth.textContent = '↻ Working…';
    try {
      await api('/api/specialists/cordelia/fire_background_job?name=nightly_shelf_synthesis', { method: 'POST', credentials: 'include' });
      resynth.textContent = '✓ Queued';
      if (state._brain_cache) state._brain_cache.clear();
    } catch {
      resynth.textContent = '⚠ Failed';
    }
    setTimeout(() => { resynth.textContent = label; resynth.disabled = false; }, 4000);
  });

  const stage = document.createElement('div');
  stage.className = 'brain-stage';
  stage.innerHTML = s;
  root.appendChild(stage);

  // spotlight recall: type a query → matching stars ignite; everything else
  // (star AND its label) dims back so the hits read clearly.
  const spot = search.querySelector('input');
  spot.addEventListener('input', () => {
    const toks = spot.value.trim().toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
    nodes.forEach((n, i) => {
      const dot = stage.querySelector(`[data-node="${i}"]`);
      const lab = stage.querySelector(`[data-label="${i}"]`);
      if (!toks.length) { [dot, lab].forEach((el) => el && el.classList.remove('dim', 'hit')); return; }
      const hay = (n.topic + ' ' + (n.prose || '') + ' ' + (n.facts || []).map((f) => f.text).join(' ')).toLowerCase();
      const match = toks.some((t) => hay.includes(t));
      [dot, lab].forEach((el) => { if (!el) return; el.classList.toggle('hit', match); el.classList.toggle('dim', !match); });
    });
  });

  const legend = document.createElement('div');
  legend.className = 'brain-legend';
  legend.innerHTML =
    Object.values(BRAIN_GRADE).map((g) => `<span class="brain-leg"><i style="background:${g.c}"></i>${g.label}</span>`).join('')
    + '<span class="brain-leg"><i class="void"></i>gap — wants learning</span>'
    + '<span class="brain-leg-note">size = breadth · colour = health · scroll to zoom · drag to pan · double-click to reset</span>';
  root.appendChild(legend);

  const detail = document.createElement('div');
  detail.className = 'brain-detail';
  detail.innerHTML = '<div class="brain-detail-hint">Click a star to zoom into its facts and trace where each one came from.</div>';
  root.appendChild(detail);

  // ── interaction: click star → bloom its sources + open its facts; click a
  //    bloomed source → light every other star that drew on it ───────────────
  const cam = stage.querySelector('.bm-cam');
  let panned = false;                 // a real drag sets this so its trailing click doesn't dismiss
  stage.addEventListener('click', (e) => {
    const nodeEl = e.target.closest('[data-node]');
    if (nodeEl) { _brain_open(detail, stage, nodes[+nodeEl.dataset.node], +nodeEl.dataset.node, npos); return; }
    const srcEl = e.target.closest('[data-src]');
    if (srcEl) {
      stage.querySelectorAll('.bm-node.used').forEach((el) => el.classList.remove('used'));
      stage.querySelectorAll('.bm-src.lit').forEach((el) => el.classList.remove('lit'));
      srcEl.classList.add('lit');
      const path = decodeURIComponent(srcEl.dataset.src);
      nodes.forEach((n, i) => {
        if ((n.sources || []).some((x) => x.path === path)) {
          const el = stage.querySelector(`[data-node="${i}"]`);
          if (el) el.classList.add('used');
        }
      });
      return;
    }
    if (panned) return;               // tail of a pan gesture — keep the current focus
    _brain_dismiss(stage, detail);    // tap empty space → lift the depth-of-field focus
  });

  // pan + zoom on the camera group. All transforms are in viewBox units; client
  // px are scaled by W/rect.width so panning tracks the cursor 1:1. Zoom is
  // anchored UNDER the cursor (the point you point at stays put) and gentle
  // (exp of the wheel delta), not a fixed step per event — fixes the jumpy feel.
  let k = 1, tx = 0, ty = 0, drag = null;
  const apply = () => cam.setAttribute('transform', `translate(${tx} ${ty}) scale(${k})`);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W, vy = ((e.clientY - r.top) / r.height) * H;
    const lx = (vx - tx) / k, ly = (vy - ty) / k;
    const nk = Math.max(0.6, Math.min(5, k * Math.exp(-e.deltaY * 0.0015)));
    tx = vx - nk * lx; ty = vy - nk * ly; k = nk;
    apply();
  }, { passive: false });
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-node],[data-src]')) return; // let stars/sources be clicked
    drag = { x: e.clientX, y: e.clientY, tx, ty }; panned = false;
    try { stage.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!panned && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) panned = true;
    const r = stage.getBoundingClientRect();
    tx = drag.tx + (e.clientX - drag.x) * (W / r.width);
    ty = drag.ty + (e.clientY - drag.y) * (H / r.height);
    apply();
  });
  const _end = (e) => { drag = null; try { stage.releasePointerCapture(e.pointerId); } catch { /* noop */ } stage.classList.remove('dragging'); };
  stage.addEventListener('pointerup', _end);
  stage.addEventListener('pointercancel', _end);
  // double-click empty space → smoothly reset the view + lift the focus
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-node],[data-src]')) return;
    cam.style.transition = 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)';
    k = 1; tx = 0; ty = 0; apply();
    setTimeout(() => { cam.style.transition = 'none'; }, 320);
    _brain_dismiss(stage, detail);
  });
}

/** Lift the depth-of-field focus: clear selection + bloom, reset the detail. */
function _brain_dismiss(stage, detail) {
  stage.querySelectorAll('.bm-node.sel,.bm-node.used,.bm-label.sel').forEach((el) => el.classList.remove('sel', 'used'));
  stage.querySelectorAll('.bm-link.lit').forEach((el) => el.classList.remove('lit'));
  const live = stage.querySelector('.bm-srcs-live');
  if (live) live.innerHTML = '';
  const cam = stage.querySelector('.bm-cam');
  if (cam) cam.classList.remove('focusing');
  if (detail) detail.innerHTML = '<div class="brain-detail-hint">Click a star to zoom into its facts and trace where each one came from.</div>';
}

function _brain_open(detail, stage, n, idx, npos) {
  // reset the prior selection + empty the live source-bloom layer
  stage.querySelectorAll('.bm-node.sel,.bm-node.used,.bm-label.sel').forEach((el) => el.classList.remove('sel', 'used'));
  stage.querySelectorAll('.bm-link.lit').forEach((el) => el.classList.remove('lit'));
  const cam = stage.querySelector('.bm-cam');
  if (cam) cam.classList.add('focusing');           // depth-of-field — recede everything but this constellation
  const live = stage.querySelector('.bm-srcs-live');
  if (live) live.innerHTML = '';
  const g = BRAIN_GRADE[n.health_grade] || BRAIN_GRADE.sound;
  const nodeEl = stage.querySelector(`[data-node="${idx}"]`);
  if (nodeEl) nodeEl.classList.add('sel');
  const labEl = stage.querySelector(`.bm-label[data-label="${idx}"]`);
  if (labEl) labEl.classList.add('sel');
  // light this synthesis's cross-shelf connections (#4)
  const enc = encodeURIComponent(n.id);
  stage.querySelectorAll('.bm-link').forEach((el) => {
    if (el.dataset.la === enc || el.dataset.lb === enc) el.classList.add('lit');
  });

  // bloom this synthesis's sources as a small constellation around the star,
  // fanned OUTBOARD (away from the hub) so the links read cleanly. data-si ===
  // the source index, so a fact-click can light exactly the circle(s) that
  // ground that fact.
  const p = npos && npos.get(n.id);
  if (live && p) {
    const sblo = (n.sources || []).slice(0, 14);
    const base = p.a;
    const span = Math.min(Math.PI * 1.25, 0.42 * Math.max(0, sblo.length - 1));
    let lines = '', dots = '';
    sblo.forEach((src, si) => {
      const a = sblo.length <= 1 ? base : base - span / 2 + (span * si) / (sblo.length - 1);
      const rr = 42 + (si % 2 ? 13 : 0);
      const sx = p.x + Math.cos(a) * rr, sy = p.y + Math.sin(a) * rr;
      const gone = src.present ? '' : ' gone';
      lines += `<line class="bm-srclink${gone}" x1="${p.x}" y1="${p.y}" x2="${sx}" y2="${sy}"/>`;
      dots += `<circle class="bm-src${gone}" data-src="${encodeURIComponent(src.path)}" data-si="${si}" cx="${sx}" cy="${sy}" r="5" style="animation-delay:${Math.min(si * 28, 360)}ms"><title>${escape_html(src.title)}${src.present ? '' : ' (deleted)'}</title></circle>`;
    });
    live.innerHTML = lines + dots;
  }

  const reasons = (n.health_reasons || []).length
    ? `<div class="brain-reasons">${(n.health_reasons || []).map((r) => `<span>${escape_html(r)}</span>`).join('')}</div>` : '';
  const ground = n.grounding_outcome && n.grounding_outcome !== 'clean'
    ? `<span class="brain-ground ${escape_html(n.grounding_outcome)}">gate: ${escape_html(n.grounding_outcome)}${n.grounding_flagged ? ` · ${n.grounding_flagged} dropped` : ''}</span>` : '';
  const facts = (n.facts || []).map((f, i) => `<li class="brain-fact" data-fact="${i}">${escape_html(f.text)}</li>`).join('');
  const sources = (n.sources || []).map((src, i) => `<li class="brain-src-row${src.present ? '' : ' gone'}" data-si="${i}"><span class="brain-src-t">${escape_html(src.title)}</span><span class="brain-src-p">${src.present ? '' : 'deleted'}</span></li>`).join('');
  // #2 worth instrument: how much this synthesis is actually used.
  const used = (n.usage_hits || 0) > 0
    ? `<span class="brain-used" title="worth ${escape_html(Number(n.worth ?? 0).toFixed(2))}">retrieved ${n.usage_hits}×</span>`
    : '<span class="brain-used none" title="never retrieved — the heal pass prunes dead weight">not yet used</span>';

  detail.innerHTML =
    `<div class="brain-detail-head">`
    + `<div class="brain-detail-title">${escape_html(n.topic)}</div>`
    + `<div class="brain-detail-meta"><span class="brain-grade-pill" style="background:${g.c}">${g.label} ${escape_html(Number(n.health_score).toFixed(2))}</span>`
    + `<span class="brain-detail-shelf">${escape_html(n.shelf_name)}</span>${used}${ground}</div>`
    + reasons + `</div>`
    + `<div class="brain-prose">${escape_html(n.prose || '')}</div>`
    + `<div class="brain-sec-t">Facts <span>${(n.facts || []).length}</span> — click one to trace its provenance</div><ol class="brain-facts">${facts}</ol>`
    + `<div class="brain-sec-t">Sources <span>${(n.sources || []).length}</span> — what these facts trace to</div><ul class="brain-srcs">${sources}</ul>`;

  // per-fact provenance: clicking a fact lights ONLY the source(s) that ground
  // it — both the detail rows and the bloomed circles on the canvas.
  detail.querySelectorAll('.brain-fact').forEach((row) => {
    row.addEventListener('click', () => {
      detail.querySelectorAll('.brain-fact.on, .brain-src-row.on').forEach((e) => e.classList.remove('on'));
      stage.querySelectorAll('.bm-src.lit2').forEach((e) => e.classList.remove('lit2'));
      row.classList.add('on');
      const f = n.facts[+row.dataset.fact] || { sources: [] };
      const sis = new Set(f.sources || []);
      stage.querySelectorAll('.bm-srcs-live [data-si]').forEach((el) => { if (sis.has(+el.dataset.si)) el.classList.add('lit2'); });
      detail.querySelectorAll('.brain-src-row').forEach((el) => { if (sis.has(+el.dataset.si)) el.classList.add('on'); });
    });
  });
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Cassandra's People room (face enrollment) ───────────────────────────────

function render_security_tabs() {
  const bar = document.createElement('div');
  bar.className = 'news-tabs';
  for (const [key, label] of [['watch', 'Watch Desk'], ['home', "Who's home"], ['people', 'People'], ['plates', 'Plates']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'news-tab' + ((state._security_tab || 'watch') === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      if ((state._security_tab || 'watch') === key) return;
      state._security_tab = key;
      if (state._last_pane_doc) render_pane(state._last_pane_doc);
    });
    bar.appendChild(b);
  }
  return bar;
}

const FACES_API = '/api/specialists/cassandra/faces';
const OCCUPANCY_API = '/api/specialists/cassandra/occupancy';
const FACE_CAMERAS = ['Front Door', 'Rear Door', 'Driveway Left', 'Driveway Right', 'Garage', 'Backyard'];

// ── The Security Room 2.0 (Person Threads; design-security-room-person-threads §5/§5a) ──
// The fused native room: ONE read (who's home + person threads + flagged +
// pulse) rendered whenever Kate's Security tab advertises `native:
// security_room`.
//
// 2.0 (the "naming didn't do anything" pass). 1.0 repainted the whole room
// after every mutation, which was correct and felt broken: naming a stranger
// who had five buckets visibly resolved one card and left the other four
// sitting there saying "New face". Three changes fix that:
//
//   1. TRIAGE SPLIT — "Needs you" (unnamed) above "Known" (enrolled). The room
//      is a queue that visibly drains instead of one undifferentiated grid.
//   2. GRADUATION — a named thread physically flies from one section into the
//      other (FLIP). The action has a consequence you can watch.
//   3. CASCADE — the name/assign response now carries `absorbed[]` (folded in
//      automatically) and `candidates[]` (the medium band), so naming one face
//      resolves the rest of that person's buckets and ASKS about the maybes,
//      inline, while their face is still on screen.
//
// Mutations are SURGICAL: mutate the model, re-render the affected section,
// animate, and let the SSE `security_room_updated` reconcile. 1.0 called a full
// repaint from the handler AND got an SSE repaint, racing two fetches — and the
// handler's captured `root` was detached by then, so it painted into nothing.
// `_secroom_root` is now the single live node every path paints.
const SECURITY_ROOM_API = '/api/specialists/kate/security_room';
const SECROOM_MERGE_API = '/api/specialists/kate/faces/clusters/merge';
const _secroom_crop_url = (sighting_id) => `/api/specialists/kate/faces/crop/${encodeURIComponent(sighting_id)}`;
const _secroom_time_fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' });
let _secroom_doc = null; // last-good doc — a fetch error never blanks a room that had data
let _secroom_root = null; // the LIVE room node; handlers and SSE both paint this
const _secroom_reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function render_security_room() {
  const root = document.createElement('div');
  root.className = 'secroom';
  _secroom_root = root;
  _secroom_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Security room unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
  });
  return root;
}

async function _secroom_paint(root) {
  if (!_secroom_doc) {
    root.innerHTML =
      '<div class="office-skel"><div class="office-sk" style="height:52px"></div>'
      + '<div class="office-sk" style="height:96px"></div><div class="office-sk" style="height:220px"></div></div>';
  }
  let doc;
  try {
    doc = await api(SECURITY_ROOM_API);
    _secroom_doc = doc;
  } catch (err) {
    if (!_secroom_doc) throw err;
    doc = _secroom_doc; // keep last-good; the next SSE/mutation repaints fresh
    toast(`Security room refresh failed: ${(err && err.message) || err}`, true);
  }
  _secroom_render(root, doc);
}

/** Full structural render. Section bodies are painted by their own helpers so
 *  a mutation can repaint ONE of them without touching the rest. */
function _secroom_render(root, doc) {
  root.innerHTML = '';
  root.appendChild(_secroom_narration_el(doc));
  if (doc.arrival) root.appendChild(_secroom_arrival_el(doc.arrival));
  root.appendChild(_secroom_whos_home_el(doc, root));
  root.appendChild(_secroom_needs_el(doc, root));
  root.appendChild(_secroom_known_el(doc, root));
  root.appendChild(_secroom_flagged_el(doc, root));
  root.appendChild(_secroom_pulse_el(doc.pulse));
}

/** Repaint just the two people sections (after a mutation), preserving scroll. */
function _secroom_repaint_people(root) {
  const doc = _secroom_doc;
  if (!doc || !root || !root.isConnected) return;
  const needs = root.querySelector('.secroom-needs');
  const known = root.querySelector('.secroom-known');
  if (needs) needs.replaceWith(_secroom_needs_el(doc, root));
  if (known) known.replaceWith(_secroom_known_el(doc, root));
}

function _secroom_threads(doc) {
  return (doc.threads || []).filter((t) => t.thread_status !== 'dismissed');
}
function _secroom_unnamed(doc) {
  return _secroom_threads(doc).filter((t) => t.thread_status !== 'named');
}
function _secroom_named(doc) {
  return _secroom_threads(doc).filter((t) => t.thread_status === 'named');
}

// The "This is…" candidate list: the enrolled roster AND everyone Kate tracks
// in the People graph (Sam, Kim, …) — picking a tracked friend bonds their
// dossier to a face anchor server-side, so visual learnings accumulate on the
// person, not a parallel roster. Values: `ep:<enrolled_id>` / `pp:<person_ref>`.
function _secroom_fill_people_select(sel, empty_text) {
  api(`${SECURITY_ROOM_API}/roster`)
    .then((r) => {
      const recognized = r.recognized || [];
      const tracked = r.tracked || [];
      if (recognized.length === 0 && tracked.length === 0) {
        sel.firstElementChild.textContent = empty_text;
        return;
      }
      const group = (label, rows, prefix, key) => {
        if (rows.length === 0) return;
        const og = document.createElement('optgroup');
        og.label = label;
        for (const p of rows) {
          const opt = document.createElement('option');
          opt.value = prefix + p[key];
          opt.textContent = p.name + (p.relationship ? ` (${p.relationship})` : '');
          og.appendChild(opt);
        }
        sel.appendChild(og);
      };
      group('On the roster', recognized, 'ep:', 'person_id');
      group('Friends Kate tracks', tracked, 'pp:', 'person_ref');
    })
    .catch(() => {
      sel.firstElementChild.textContent = 'Roster unavailable — type a name';
    });
}

/** Parse a people-select value into the identify/assign body field. */
function _secroom_person_choice(value) {
  if (value.startsWith('ep:')) return { person_id: value.slice(3) };
  if (value.startsWith('pp:')) return { person_ref: value.slice(3) };
  return null;
}

function _secroom_hue(seed) {
  let h = 0;
  for (const ch of String(seed || '?')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 46%)`;
}

function _secroom_narration_el(doc) {
  const el = document.createElement('div');
  el.className = 'secroom-narration';
  el.innerHTML = `<span class="secroom-kate-dot" aria-hidden="true"></span><span>${escape_html(doc.narration || '')}</span>`;
  return el;
}

function _secroom_arrival_el(arrival) {
  const el = document.createElement('div');
  el.className = 'secroom-arrival';
  const at = arrival.at ? _secroom_time_fmt.format(new Date(arrival.at)) : '';
  const path = (arrival.path || []).map((z) => escape_html(z)).join(' → ');
  el.innerHTML =
    `<span class="secroom-dot is-home" aria-hidden="true"></span>`
    + `<b>${escape_html(arrival.name)}</b>&nbsp;got home${at ? ` · ${escape_html(at)}` : ''}${path ? ` — ${path}` : ''}`;
  return el;
}

/** Section shell: header with a count pill + optional hint, then a body node. */
function _secroom_section(cls, title, count, hint, body) {
  const wrap = document.createElement('div');
  wrap.className = `faces-panel secroom-panel ${cls}`;
  const head = document.createElement('div');
  head.className = 'secroom-sechead';
  head.innerHTML =
    `<span class="faces-h">${escape_html(title)}</span>`
    + (count === null ? '' : `<span class="secroom-count${count === 0 ? ' is-quiet' : ''}">${count}</span>`)
    + (hint ? `<span class="secroom-hint">${escape_html(hint)}</span>` : '');
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

function _secroom_chip(entry, root, opts) {
  const unknown = !!(opts && opts.unknown);
  const chip = document.createElement(unknown ? 'button' : 'div');
  chip.className = 'secroom-chip' + (unknown ? ' is-unknown' : '');
  const ring = unknown ? 'is-unsure' : entry.presence === 'home' ? 'is-home' : entry.presence === 'away' ? 'is-away' : 'is-unsure';
  const img = entry.crop_url
    ? `<img class="secroom-face" src="${escape_html(entry.crop_url)}" alt="" loading="lazy">`
    : `<div class="secroom-face secroom-initials"${unknown ? '' : ` style="background:${_secroom_hue(entry.name)}"`}>${unknown ? '?' : escape_html((entry.name || '?').slice(0, 1).toUpperCase())}</div>`;
  const name = unknown ? 'Unknown' : escape_html(entry.name || 'Someone');
  const presence_word = unknown
    ? 'on a camera'
    : entry.presence === 'home' ? 'home' : entry.presence === 'away' ? 'away' : 'presence unknown';
  // Two timestamps, two meanings: `last_seen_at` dates a CAMERA sighting (so it
  // rides with the zone), while a household member's presence resolves from
  // GEOFENCE and carries no sighting at all — for those rows `presence_as_of`
  // (2026-07-29, additive) is the only freshness there is. It is APPENDED to the
  // presence word, never substituted for it: the word is the row's meaning, and
  // it is also the only presence an assistive reader gets, since the ring is
  // pure colour. Absent on an older server, the row reads as it did before.
  const camera_parts = [
    entry.zone || '',
    entry.last_seen_at ? relative_time(entry.last_seen_at) : '',
  ].filter(Boolean);
  const sub_parts = camera_parts.length > 0
    ? camera_parts
    : [presence_word, entry.presence_as_of ? relative_time(entry.presence_as_of) : ''].filter(Boolean);
  const sub = sub_parts.map(escape_html).join(' · ');
  chip.innerHTML =
    `<span class="secroom-ring ${ring}">${img}</span>`
    + `<span class="secroom-chip-name">${name}</span><span class="secroom-chip-sub">${sub}</span>`;
  // The label always LEADS with presence, even when the visible sub shows the
  // camera detail instead — colour is not an encoding. Built from the raw
  // strings rather than the escaped markup, so a zone containing `&` isn't read
  // out as an entity.
  const label_parts = camera_parts.length > 0 ? [presence_word, ...camera_parts] : sub_parts;
  chip.setAttribute('aria-label', `${unknown ? 'Unknown person' : entry.name || 'Someone'}, ${label_parts.join(', ')}`);
  if (unknown && entry.thread_id) {
    chip.addEventListener('click', () => {
      const t = _secroom_threads(_secroom_doc || {}).find((x) => x.thread_id === entry.thread_id);
      if (t) _secroom_open_detail(root, t);
      else toast('That visitor has no thread detail yet — the next sighting builds it.', false);
    });
  }
  return chip;
}

function _secroom_whos_home_el(doc, root) {
  const rail = document.createElement('div');
  rail.className = 'secroom-rail';
  const seen = doc.whos_home || [];
  for (const o of seen) rail.appendChild(_secroom_chip(o, root, {}));
  for (const u of doc.unknown_present || []) rail.appendChild(_secroom_chip(u, root, { unknown: true }));
  if (seen.length === 0 && (doc.unknown_present || []).length === 0) {
    rail.innerHTML = `<div class="faces-sub">Nobody on the cameras yet today.</div>`;
  }
  return _secroom_section('secroom-whos', 'Who’s home', null, null, rail);
}

/** Evidence pill — solid dot = matched on a face, hollow/dashed = carried on
 *  body and clothing. Confidence as TEXTURE; the owner never reads a number. */
function _secroom_evidence_pill(evidence) {
  if (evidence !== 'face' && evidence !== 'body') return '';
  const body = evidence === 'body';
  return `<span class="secroom-evid${body ? ' is-body' : ''}" title="${body
    ? 'Carried on build and clothing from an earlier face match — good for about a day'
    : 'Matched on a face'}">${body ? 'body' : 'face'}</span>`;
}

/** "Needs you" — the unnamed queue. Image-led cards, drag one onto another to
 *  merge two buckets of the same stranger. */
function _secroom_needs_el(doc, root) {
  const threads = _secroom_unnamed(doc);
  let body;
  if (threads.length === 0) {
    body = document.createElement('div');
    body.className = 'secroom-allclear';
    body.innerHTML = `<span class="secroom-tick" aria-hidden="true">✓</span>Everyone the cameras saw this week has a name.`;
  } else {
    body = document.createElement('div');
    body.className = 'secroom-grid';
    for (const t of threads) body.appendChild(_secroom_card(t, root));
  }
  return _secroom_section(
    'secroom-needs',
    'Needs you',
    threads.length,
    threads.length > 1 ? 'drag one card onto another to merge' : null,
    body,
  );
}

function _secroom_card(t, root) {
  const card = document.createElement('button');
  card.className = 'secroom-card';
  card.dataset.threadId = t.thread_id;
  card.draggable = true;
  const img = t.crop_url
    ? `<img class="secroom-card-img" src="${escape_html(t.crop_url)}" alt="" loading="lazy" onerror="this.classList.add('is-broken')">`
    : `<div class="secroom-card-img secroom-initials" style="background:${_secroom_hue(t.thread_id)}">?</div>`;
  const visits = t.visits_this_week > 1
    ? `${t.visits_this_week} visits this week`
    : t.visits_this_week === 1
      ? '1 visit this week'
      : 'first time here';
  const last = t.last_seen_at ? ` · ${escape_html(relative_time(t.last_seen_at))}` : '';
  const heading = (t.heading || []).length > 1
    ? `<div class="faces-sub secroom-heading">${(t.heading || []).map((z) => escape_html(z)).join(' → ')}</div>`
    : '';
  card.innerHTML =
    img
    + `<div class="secroom-card-meta">`
    + `<div class="secroom-card-name"><span class="secroom-ember-dot" aria-hidden="true"></span>New face${_secroom_evidence_pill(t.evidence)}</div>`
    + `<div class="faces-sub">${visits}${last}</div>`
    + (t.appearance ? `<div class="faces-sub secroom-clamp">${escape_html(t.appearance)}</div>` : '')
    + heading
    + `</div>`;
  card.setAttribute('aria-label', `New face, ${visits}`);
  card.addEventListener('click', () => _secroom_open_detail(root, t));
  _secroom_wire_drag(card, t, root);
  return card;
}

/** Drag-to-merge: two buckets of the same stranger is a photo-management
 *  task, not a dropdown. Uses the existing cluster-merge route. */
function _secroom_wire_drag(card, t, root) {
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', t.thread_id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('is-dragging'));
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('is-droptarget');
  });
  card.addEventListener('dragleave', () => card.classList.remove('is-droptarget'));
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    card.classList.remove('is-droptarget');
    const src_id = e.dataTransfer.getData('text/plain');
    if (!src_id || src_id === t.thread_id) return;
    try {
      await api(SECROOM_MERGE_API, _post({ src_cluster_id: src_id, dst_cluster_id: t.thread_id }));
      if (_secroom_doc) {
        _secroom_doc.threads = (_secroom_doc.threads || []).filter((x) => x.thread_id !== src_id);
      }
      _secroom_repaint_people(root);
      toast('Merged — same person, one bucket.', false);
    } catch (err) {
      toast(`Merge failed: ${(err && err.message) || err}`, true);
    }
  });
}

/** "Known" — where named people land. Deliberately quieter than the queue. */
function _secroom_known_el(doc, root) {
  const people = _secroom_named(doc);
  const body = document.createElement('div');
  body.className = 'secroom-known-list';
  if (people.length === 0) {
    body.innerHTML = `<div class="faces-sub">Nobody enrolled yet — name a face above and they'll appear here.</div>`;
  } else {
    for (const t of people) {
      const row = document.createElement('button');
      row.className = 'secroom-krow';
      row.dataset.threadId = t.thread_id;
      const img = t.crop_url
        ? `<img class="secroom-kface" src="${escape_html(t.crop_url)}" alt="" loading="lazy">`
        : `<div class="secroom-kface secroom-initials" style="background:${_secroom_hue(t.name)}">${escape_html((t.name || '?').slice(0, 1).toUpperCase())}</div>`;
      const bits = [t.relationship || 'known'];
      if (t.last_seen_at) bits.push(relative_time(t.last_seen_at));
      row.innerHTML =
        img
        + `<span class="secroom-kmeta"><span class="secroom-kname">${escape_html(t.name || 'Someone')}</span>`
        + `<span class="faces-sub">${escape_html(bits.join(' · '))}</span></span>`
        + `<span class="secroom-kcheck" aria-hidden="true">✓</span>`;
      row.setAttribute('aria-label', `${t.name || 'Someone'}, ${bits.join(', ')}`);
      row.addEventListener('click', () => _secroom_open_person(root, t));
      body.appendChild(row);
    }
  }
  return _secroom_section('secroom-known', 'Known', people.length, null, body);
}

/** FLIP: fly a ghost of each retiring card into the Known row it became, so
 *  naming someone is something you WATCH rather than infer from a repaint. */
function _secroom_graduate(root, firsts, thread_id) {
  if (_secroom_reduced()) return;
  const target = root.querySelector(`.secroom-krow[data-thread-id="${CSS.escape(thread_id)}"]`);
  if (!target) return;
  const last = target.getBoundingClientRect();
  Object.keys(firsts).forEach((id, i) => {
    const first = firsts[id];
    if (!first || !first.width) return;
    const ghost = document.createElement('div');
    ghost.className = 'secroom-ghost';
    ghost.style.cssText =
      `position:fixed;left:${first.left}px;top:${first.top}px;width:${first.width}px;`
      + `height:${first.height}px;z-index:60;pointer-events:none;`;
    if (first.img) ghost.innerHTML = `<img src="${escape_html(first.img)}" alt="">`;
    document.body.appendChild(ghost);
    const anim = ghost.animate(
      [
        { transform: 'none', opacity: 1 },
        {
          transform: `translate(${last.left - first.left}px, ${last.top - first.top}px) scale(${Math.max(0.12, 38 / first.width)})`,
          opacity: 0,
        },
      ],
      { duration: 440 + i * 70, easing: 'cubic-bezier(.32,.72,.28,1)' },
    );
    anim.addEventListener('finish', () => ghost.remove());
  });
}

/** Measure the cards about to leave, so the FLIP has a "first" to fly from. */
function _secroom_measure(root, thread_ids) {
  const firsts = {};
  for (const id of thread_ids) {
    const card = root.querySelector(`.secroom-card[data-thread-id="${CSS.escape(id)}"]`);
    if (!card) continue;
    const r = card.getBoundingClientRect();
    const img = card.querySelector('.secroom-card-img');
    firsts[id] = {
      left: r.left, top: r.top, width: r.width, height: r.height,
      img: img && img.tagName === 'IMG' ? img.getAttribute('src') : null,
    };
  }
  return firsts;
}

/**
 * The whole point of 2.0: apply a naming result to the room in one motion —
 * the named thread and every auto-absorbed sibling graduate together, and the
 * medium band is handed back for the inline ask.
 */
function _secroom_apply_naming(root, thread_id, out) {
  const doc = _secroom_doc;
  if (!doc) return;
  const absorbed = (out && out.absorbed) || [];
  const retiring = [thread_id].concat(absorbed.map((a) => a.thread_id));
  const firsts = _secroom_measure(root, retiring);

  // Promote the named thread in the model; retire the absorbed ones into it.
  let promoted = null;
  for (const t of doc.threads || []) {
    if (t.thread_id !== thread_id) continue;
    t.thread_status = 'named';
    t.name = out.name || t.name;
    t.person_id = out.person_id || t.person_id;
    promoted = t;
  }
  const absorbed_ids = new Set(absorbed.map((a) => a.thread_id));
  if (promoted) {
    for (const a of absorbed) {
      const row = (doc.threads || []).find((x) => x.thread_id === a.thread_id);
      if (row) promoted.sighting_count = (promoted.sighting_count || 0) + (row.sighting_count || 0);
    }
  }
  doc.threads = (doc.threads || []).filter((t) => !absorbed_ids.has(t.thread_id));

  _secroom_repaint_people(root);
  _secroom_graduate(root, firsts, thread_id);

  const n = absorbed.length;
  toast(
    n > 0
      ? `${out.name || 'Enrolled'} — and ${n} other sighting${n === 1 ? '' : 's'} of them folded in.`
      : `${out.name || 'Enrolled'} — recognition starts now.`,
    false,
  );
}

function _secroom_open_detail(root, thread) {
  const ov = document.createElement('div');
  ov.className = 'secroom-overlay';
  const onkey = (e) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onkey);
  };
  document.addEventListener('keydown', onkey);
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close();
  });

  const panel = document.createElement('div');
  panel.className = 'secroom-detail';
  const title = 'New face';

  // The face leads: a LARGE hero crop (best/freshest shot), then a strip of
  // recent shots that swap the hero on tap.
  const shot_urls = (thread.recent_sightings || []).map((s) => _secroom_crop_url(s.sighting_id));
  const hero_src = thread.crop_url || shot_urls[0] || null;
  const hero = hero_src
    ? `<img class="secroom-hero" src="${escape_html(hero_src)}" alt="best photo of ${escape_html(title)}" onerror="this.remove()">`
    : '';
  const shots = shot_urls
    .map((u, i) => `<img class="secroom-shot" src="${escape_html(u)}" alt="photo ${i + 1}" loading="lazy" onerror="this.remove()">`)
    .join('');
  panel.innerHTML =
    `<div class="secroom-detail-h"><span>${escape_html(title)}</span>`
    + `<span class="secroom-status is-unnamed">new</span>`
    + `<button class="secroom-x" aria-label="Close">✕</button></div>`
    + hero
    + (shot_urls.length > 1 ? `<div class="secroom-strip">${shots}</div>` : '')
    + _secroom_traits_html(thread)
    + _secroom_heading_html(thread)
    + _secroom_timeline_html(thread)
    + `<div class="secroom-actions"></div>`;
  panel.querySelector('.secroom-x').addEventListener('click', close);
  _secroom_wire_hero(panel);

  const actions = panel.querySelector('.secroom-actions');

  // Name — inline form, the prominent verb.
  const name_row = document.createElement('div');
  name_row.className = 'faces-row';
  const name_in = document.createElement('input');
  name_in.className = 'faces-name';
  name_in.placeholder = 'Who is this?';
  const name_btn = document.createElement('button');
  name_btn.className = 'faces-btn primary';
  name_btn.textContent = 'Name them';
  const do_name = async () => {
    const name = name_in.value.trim();
    if (!name) {
      name_in.focus();
      return;
    }
    name_btn.disabled = true;
    try {
      const out = await api(`${SECURITY_ROOM_API}/threads/${encodeURIComponent(thread.thread_id)}/name`, _post({ name }));
      _secroom_apply_naming(root, thread.thread_id, out);
      if ((out.candidates || []).length > 0) _secroom_show_cascade(root, panel, close, out);
      else close();
    } catch (err) {
      toast(`Name failed: ${(err && err.message) || err}`, true);
      name_btn.disabled = false;
    }
  };
  name_btn.addEventListener('click', do_name);
  name_in.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') do_name();
  });
  name_row.appendChild(name_in);
  name_row.appendChild(name_btn);
  actions.appendChild(name_row);

  // This is… — the merged picker: enrolled roster + tracked friends.
  const assign_row = document.createElement('div');
  assign_row.className = 'faces-row';
  const sel = document.createElement('select');
  sel.className = 'faces-name';
  sel.innerHTML = `<option value="">This is…</option>`;
  _secroom_fill_people_select(sel, 'Nobody to pick yet');
  const assign_btn = document.createElement('button');
  assign_btn.className = 'faces-btn';
  assign_btn.textContent = 'That’s them';
  assign_btn.addEventListener('click', async () => {
    const choice = _secroom_person_choice(sel.value || '');
    if (!choice) {
      sel.focus();
      return;
    }
    assign_btn.disabled = true;
    try {
      const out = await api(`${SECURITY_ROOM_API}/threads/${encodeURIComponent(thread.thread_id)}/assign`, _post(choice));
      _secroom_apply_naming(root, thread.thread_id, out);
      if ((out.candidates || []).length > 0) _secroom_show_cascade(root, panel, close, out);
      else close();
    } catch (err) {
      toast(`Assign failed: ${(err && err.message) || err}`, true);
      assign_btn.disabled = false;
    }
  });
  assign_row.appendChild(sel);
  assign_row.appendChild(assign_btn);
  actions.appendChild(assign_row);

  // Dismiss — courier / one-time visitor.
  const dis_btn = document.createElement('button');
  dis_btn.className = 'faces-btn danger';
  dis_btn.textContent = 'Not someone to remember';
  dis_btn.addEventListener('click', async () => {
    if (!confirm('Dismiss this visitor? Their photos clear out on their own in a few weeks.')) return;
    dis_btn.disabled = true;
    try {
      await api(`${SECURITY_ROOM_API}/threads/${encodeURIComponent(thread.thread_id)}/dismiss`, { method: 'POST' });
      if (_secroom_doc) {
        _secroom_doc.threads = (_secroom_doc.threads || []).filter((x) => x.thread_id !== thread.thread_id);
      }
      _secroom_repaint_people(root);
      close();
      toast('Dismissed — Kate won’t bring them up again.', false);
    } catch (err) {
      toast(`Dismiss failed: ${(err && err.message) || err}`, true);
      dis_btn.disabled = false;
    }
  });
  actions.appendChild(dis_btn);

  ov.appendChild(panel);
  document.body.appendChild(ov);
  name_in.focus();
}

/**
 * The inline ask. Naming just folded in everything the matcher was sure about;
 * these are the maybes. Asking here — with the person's face still on screen —
 * beats a proposal card the owner meets hours later.
 */
/** Full-size crop viewer — the last resort when a thumbnail is ambiguous and
 *  the decision is "enroll this person or don't". Click anywhere or Esc out. */
function _secroom_zoom(src, alt) {
  if (!src) return;
  const ov = document.createElement('div');
  ov.className = 'secroom-zoom';
  ov.innerHTML = `<img src="${escape_html(src)}" alt="${escape_html(alt || '')}">`;
  const onkey = (e) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onkey);
  };
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onkey);
  document.body.appendChild(ov);
}

function _secroom_show_cascade(root, panel, close, out) {
  const cands = out.candidates || [];
  const one = cands.length === 1;
  const who = escape_html(out.name || 'them');
  panel.innerHTML =
    `<div class="secroom-detail-h"><span>${escape_html(out.name || 'Enrolled')}</span>`
    + `<span class="secroom-status is-named">just named</span>`
    + `<button class="secroom-x" aria-label="Close">✕</button></div>`
    + `<div class="secroom-casc-lead">`
    + `${one ? 'One more face looks' : `${cands.length} more faces look`} like the same person. `
    + `${one ? 'Is this' : 'Are these'} <b>${who}</b>?</div>`
    + `<div class="secroom-cands"></div>`
    + `<div class="secroom-actions"></div>`;
  panel.querySelector('.secroom-x').addEventListener('click', close);

  const list = panel.querySelector('.secroom-cands');
  // The reference face: the thread the owner just named, whose crop is already
  // in the model. Falls back to nothing rather than showing a wrong face.
  const ref = (_secroom_doc && (_secroom_doc.threads || []).find((t) => t.person_id === out.person_id)) || null;
  const ref_crop = ref ? ref.crop_url : null;
  const confirm_one = async (cand, row) => {
    row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api(`${SECURITY_ROOM_API}/threads/${encodeURIComponent(cand.thread_id)}/confirm`, _post({ person_id: out.person_id }));
      if (_secroom_doc) {
        _secroom_doc.threads = (_secroom_doc.threads || []).filter((x) => x.thread_id !== cand.thread_id);
      }
      _secroom_repaint_people(root);
      row.classList.add('is-out');
      setTimeout(() => row.remove(), _secroom_reduced() ? 0 : 280);
    } catch (err) {
      toast(`Couldn’t fold that in: ${(err && err.message) || err}`, true);
      row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };

  for (const cand of cands) {
    const row = document.createElement('div');
    row.className = 'secroom-cand';
    const crop = cand.crop_sighting_id ? _secroom_crop_url(cand.crop_sighting_id) : null;
    const why = [
      cand.sighting_count ? `${cand.sighting_count} sighting${cand.sighting_count === 1 ? '' : 's'}` : '',
      (cand.cameras || []).slice(0, 2).join(', '),
      cand.last_seen_at ? relative_time(cand.last_seen_at) : '',
    ].filter(Boolean).join(' · ');
    // The ask is a COMPARISON — "is this Jasper?" — so put the person's own
    // face next to the candidate's and make both big enough to decide on.
    // Judging a 52px crop from memory, against a face that wasn't even on
    // screen, was asking for a coin flip.
    // A crop that fails to load falls back to a placeholder rather than being
    // removed: an empty gap under a "this face" label reads as broken, and the
    // row still has to be decidable (the why-line and the sizes carry it).
    const face = (url, cls, label) =>
      `<span class="secroom-cface">`
      + (url
        ? `<img class="secroom-candface ${cls}" src="${escape_html(url)}" alt="${escape_html(label)}" loading="lazy">`
        : `<span class="secroom-candface ${cls} secroom-initials">?</span>`)
      + `<span class="secroom-cface-label">${escape_html(label)}</span></span>`;
    row.innerHTML =
      `<span class="secroom-compare">`
      + face(ref_crop, 'is-ref', out.name || 'them')
      + `<span class="secroom-vs">vs</span>`
      + face(crop, 'is-cand', 'this face')
      + `</span>`
      + `<span class="secroom-candmeta"><span class="secroom-candwhy">${escape_html(why || 'seen before')}</span></span>`;
    for (const img of row.querySelectorAll('img.secroom-candface')) {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        _secroom_zoom(img.getAttribute('src'), img.getAttribute('alt'));
      });
      img.addEventListener('error', () => {
        const ph = document.createElement('span');
        ph.className = img.className + ' secroom-initials';
        ph.textContent = '?';
        img.replaceWith(ph);
      });
    }
    // Keep the two verbs together — floated apart they wrap onto separate
    // lines once the faces are big enough to actually compare.
    const verbs = document.createElement('span');
    verbs.className = 'secroom-cand-acts';
    const yes = document.createElement('button');
    yes.className = 'faces-btn primary';
    yes.textContent = 'Same person';
    const no = document.createElement('button');
    no.className = 'faces-btn';
    no.textContent = 'No';
    verbs.appendChild(yes);
    verbs.appendChild(no);
    row.appendChild(verbs);
    yes.addEventListener('click', () => confirm_one(cand, row));
    no.addEventListener('click', () => {
      row.classList.add('is-out');
      setTimeout(() => row.remove(), _secroom_reduced() ? 0 : 280);
    });
    list.appendChild(row);
  }

  const actions = panel.querySelector('.secroom-actions');
  const all = document.createElement('button');
  all.className = 'faces-btn primary';
  all.textContent = 'Yes to all';
  all.addEventListener('click', async () => {
    all.disabled = true;
    for (const row of [...list.querySelectorAll('.secroom-cand')]) {
      const yes = row.querySelector('button');
      if (yes && !yes.disabled) yes.click();
    }
    setTimeout(close, 500);
  });
  const done = document.createElement('button');
  done.className = 'faces-btn';
  done.textContent = 'Done';
  done.addEventListener('click', close);
  actions.appendChild(all);
  actions.appendChild(done);
}

/** Learned traits — today's observation accented, the durable profile quiet. */
function _secroom_traits_html(thread) {
  if ((thread.traits || []).length > 0) {
    return `<div class="secroom-traits">${(thread.traits || [])
      .map((t) => `<span class="secroom-trait${t.today ? ' is-today' : ''}">${escape_html(t.text)}</span>`)
      .join('')}</div>`;
  }
  return thread.appearance ? `<div class="faces-sub secroom-appearance">${escape_html(thread.appearance)}</div>` : '';
}

/** Direction of travel — the zone hops, when there was movement to report. */
function _secroom_heading_html(thread) {
  const hops = thread.heading || [];
  if (hops.length < 2) return '';
  return `<div class="secroom-headline"><span class="secroom-label">Heading</span>`
    + `<span>${hops.map((z) => escape_html(z)).join(' → ')}</span></div>`;
}

function _secroom_timeline_html(thread) {
  const by_day = new Map();
  for (const s of thread.recent_sightings || []) {
    const k = day_key_for(s.at);
    if (!by_day.has(k)) by_day.set(k, []);
    by_day.get(k).push(s);
  }
  let timeline = '';
  for (const rows of by_day.values()) {
    timeline += `<div class="secroom-day">${escape_html(_denver_day_label.format(new Date(rows[0].at)))}</div>`;
    for (const s of rows) {
      timeline +=
        `<div class="secroom-tl-row"><span class="secroom-cam-dot" style="background:${_secroom_hue(s.camera_name)}"></span>`
        + `<span>${escape_html(s.camera_name || 'camera')}</span>`
        + `<span class="secroom-tl-time">${escape_html(_secroom_time_fmt.format(new Date(s.at)))}</span></div>`;
    }
  }
  return timeline ? `<div class="secroom-timeline">${timeline}</div>` : '<div class="faces-sub">No recent sightings on file.</div>';
}

function _secroom_wire_hero(panel) {
  const hero_el = panel.querySelector('.secroom-hero');
  if (!hero_el) return;
  for (const s of panel.querySelectorAll('.secroom-shot')) {
    s.addEventListener('click', () => {
      hero_el.src = s.src;
    });
  }
}

/**
 * A named person's page. 1.0 dead-ended here at "nothing needs you" — exactly
 * when the accumulated data gets interesting. This is the dossier: what Kate
 * has learned, when they're usually around, the route they take, the history.
 */
function _secroom_open_person(root, thread) {
  const ov = document.createElement('div');
  ov.className = 'secroom-overlay';
  const onkey = (e) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    ov.remove();
    document.removeEventListener('keydown', onkey);
  };
  document.addEventListener('keydown', onkey);
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close();
  });

  const panel = document.createElement('div');
  panel.className = 'secroom-detail';
  const name = thread.name || 'Someone';
  const shot_urls = (thread.recent_sightings || []).map((s) => _secroom_crop_url(s.sighting_id));
  const hero_src = thread.crop_url || shot_urls[0] || null;
  const summary = [
    `${thread.sighting_count || 0} sighting${thread.sighting_count === 1 ? '' : 's'}`,
    thread.visits_this_week ? `${thread.visits_this_week} day${thread.visits_this_week === 1 ? '' : 's'} this week` : '',
    thread.last_seen_at ? `last ${relative_time(thread.last_seen_at)}` : '',
  ].filter(Boolean).join(' · ');

  panel.innerHTML =
    `<div class="secroom-detail-h"><span>${escape_html(name)}</span>`
    + `<span class="secroom-status is-named">${escape_html(thread.relationship || 'known')}</span>`
    + `<button class="secroom-x" aria-label="Close">✕</button></div>`
    + (hero_src ? `<img class="secroom-hero" src="${escape_html(hero_src)}" alt="best photo of ${escape_html(name)}" onerror="this.remove()">` : '')
    + (shot_urls.length > 1
      ? `<div class="secroom-strip">${shot_urls.map((u, i) => `<img class="secroom-shot" src="${escape_html(u)}" alt="photo ${i + 1}" loading="lazy" onerror="this.remove()">`).join('')}</div>`
      : '')
    + `<div class="faces-sub secroom-psummary">${escape_html(summary)}</div>`
    + ((thread.traits || []).length > 0
      ? `<div class="secroom-label">What Kate has learned</div>`
        + _secroom_traits_html(thread)
        + `<div class="faces-sub secroom-note">Today’s look is highlighted. These widen a match — they never name someone on their own.</div>`
      : '')
    + _secroom_heading_html(thread)
    + `<div class="secroom-label">Recent history</div>`
    + _secroom_timeline_html(thread);

  panel.querySelector('.secroom-x').addEventListener('click', close);
  _secroom_wire_hero(panel);
  ov.appendChild(panel);
  document.body.appendChild(ov);
}

/** Drop a resolved event from the model and repaint ONLY the flagged section,
 *  so the row's exit animation isn't torn down by a whole-room rebuild. */
function _secroom_retire_flag(root, event_id) {
  setTimeout(() => {
    if (_secroom_doc) {
      const before = (_secroom_doc.flagged || []).length;
      _secroom_doc.flagged = (_secroom_doc.flagged || []).filter((x) => x.id !== event_id);
      // The pill shows the ledger TOTAL, which may exceed the page — so the
      // optimistic drop has to decrement the total too, or the count freezes at
      // its pre-resolve value until the next fetch. (The unshown 11th concern
      // only appears on that fetch; this keeps the number honest meanwhile.)
      const removed = before - _secroom_doc.flagged.length;
      if (removed > 0 && typeof _secroom_doc.flagged_total === 'number') {
        _secroom_doc.flagged_total = Math.max(0, _secroom_doc.flagged_total - removed);
      }
    }
    const sec = root && root.querySelector('.secroom-flagged');
    if (sec && _secroom_doc) sec.replaceWith(_secroom_flagged_el(_secroom_doc, root));
  }, _secroom_reduced() ? 0 : 260);
}

function _secroom_flagged_el(doc, root) {
  const flagged = doc.flagged || [];
  // `flagged` is a bounded page (the server caps it); `flagged_total` is the
  // COUNT(*) behind it. Show the total — a truncated array counted as a fact is
  // the bug this replaced — and say plainly when rows are unshown. Older server
  // without the field: fall back to the page length, as before.
  const total = typeof doc.flagged_total === 'number' ? Math.max(doc.flagged_total, flagged.length) : flagged.length;
  const unshown = total - flagged.length;
  const wrap = document.createElement('div');
  wrap.className = 'faces-panel secroom-panel secroom-flagged';
  wrap.innerHTML =
    `<div class="secroom-sechead"><span class="faces-h">Needs a look</span>`
    + `<span class="secroom-count${total === 0 ? ' is-quiet' : ''}">${total}</span>`
    + (unshown > 0
      ? `<span class="secroom-hint">showing the ${flagged.length} most serious · ${unshown} more open</span>`
      : '')
    + `</div>`;
  if (flagged.length === 0) {
    // Earned all-clear (§5a): the quiet state is the reward, never whitespace.
    const clear = document.createElement('div');
    clear.className = 'secroom-allclear';
    clear.innerHTML = `<span class="secroom-check" aria-hidden="true">✓</span> All clear — nothing needs you.`;
    wrap.appendChild(clear);
    return wrap;
  }
  for (const f of flagged) {
    const row = document.createElement('div');
    row.className = 'secroom-flag';
    const sev = f.severity === 'critical' || f.severity === 'high' ? 'is-high' : 'is-medium';
    const frame = f.frame_event_id
      ? `<img class="secroom-frame" loading="lazy" alt="" src="/api/specialists/cassandra/security/frame/${encodeURIComponent(f.frame_event_id)}" onerror="this.remove()">`
      : '';
    row.innerHTML =
      `<span class="secroom-sev ${sev}" aria-hidden="true"></span>${frame}`
      + `<div class="secroom-flag-meta"><div class="secroom-flag-t">${escape_html(f.title)}</div>`
      + (f.summary ? `<div class="faces-sub secroom-clamp">${escape_html(f.summary)}</div>` : '')
      + `<div class="faces-sub">${[f.camera_name ? escape_html(f.camera_name) : '', f.at ? escape_html(relative_time(f.at)) : ''].filter(Boolean).join(' · ')}</div></div>`
      + `<div class="secroom-flag-actions"></div><div class="secroom-flag-more"></div>`;
    const acts = row.querySelector('.secroom-flag-actions');
    const more = row.querySelector('.secroom-flag-more');
    const resolve = async (disposition, note) => {
      try {
        await api(`${SECURITY_ROOM_API}/flagged/${encodeURIComponent(f.id)}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disposition, ...(note ? { note } : {}) }),
        });
        row.classList.add('is-leaving');
        _secroom_retire_flag(root, f.id);
      } catch (err) {
        toast(`That didn’t stick: ${(err && err.message) || err}`, true);
      }
    };

    // "It’s fine" — the one clearing verb. An added why becomes the
    // resolution_note (→ acknowledged, the ledger Kate learns "normal" from);
    // left blank it clears as plain noise (→ dismissed). One decision, not two.
    const fine = document.createElement('button');
    fine.className = 'faces-btn primary';
    fine.textContent = 'It’s fine';
    fine.addEventListener('click', () => {
      if (more.childElementCount > 0) {
        more.replaceChildren();
        return;
      }
      const why_row = document.createElement('div');
      why_row.className = 'faces-row secroom-why';
      const why = document.createElement('input');
      why.className = 'faces-name';
      why.placeholder = 'Add a why if you like — “that was the plumber”';
      const go = document.createElement('button');
      go.className = 'faces-btn primary';
      go.textContent = 'Done';
      const finish = () => {
        const note = why.value.trim();
        resolve(note ? 'acknowledged' : 'dismissed', note || null);
      };
      go.addEventListener('click', finish);
      why.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish();
      });
      more.replaceChildren(why_row);
      why_row.appendChild(why);
      why_row.appendChild(go);
      why.focus();
    });
    acts.appendChild(fine);

    // "This is…" — person-shaped events get the person verb, for REAL: the
    // identify endpoint finds the face behind the event (the thread seen on
    // that camera at that moment, else the flagged frame itself) and teaches
    // recognition; when there's nothing to learn from, the name still lands
    // in the ledger and the toast says so honestly. Camera events only.
    if (f.kind === 'camera_anomaly' || f.camera_name) {
      const who = document.createElement('button');
      who.className = 'faces-btn';
      who.textContent = 'This is…';
      who.addEventListener('click', () => {
        if (more.childElementCount > 0) {
          more.replaceChildren();
          return;
        }
        const who_row = document.createElement('div');
        who_row.className = 'faces-row secroom-why';
        const sel = document.createElement('select');
        sel.className = 'faces-name';
        sel.innerHTML = `<option value="">Someone Kate knows…</option>`;
        _secroom_fill_people_select(sel, 'Nobody to pick yet — type a name');
        const free = document.createElement('input');
        free.className = 'faces-name';
        free.placeholder = '…or a new name — “Paula next door”';
        const go = document.createElement('button');
        go.className = 'faces-btn primary';
        go.textContent = 'Done';
        const finish = async () => {
          const free_name = free.value.trim();
          const choice = _secroom_person_choice(sel.value || '');
          if (!free_name && !choice) {
            free.focus();
            return;
          }
          go.disabled = true;
          try {
            const out = await api(`${SECURITY_ROOM_API}/flagged/${encodeURIComponent(f.id)}/identify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(free_name ? { name: free_name } : choice),
            });
            if (out.learned === 'thread') toast(`${out.name} named — Kate will recognize them from here.`, false);
            else if (out.learned === 'frame') toast(`${out.name} learned from this very frame.`, false);
            else if (out.already_named) toast(`Noted — though Kate had this face down as ${out.already_named}.`, false);
            else if (out.learned === 'already') toast(`Right — Kate already knew. Cleared.`, false);
            else if (out.learned === 'name_only') toast(`${out.name} joins the roster by name — Kate will match a face to them as soon as she gets a clear look.`, false);
            else toast(`Noted — no clear face to learn from here, but ${out.name} is on the record.`, false);
            row.classList.add('is-leaving');
            _secroom_retire_flag(root, f.id);
          } catch (err) {
            toast(`That didn’t stick: ${(err && err.message) || err}`, true);
            go.disabled = false;
          }
        };
        go.addEventListener('click', finish);
        free.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') finish();
        });
        more.replaceChildren(who_row);
        who_row.appendChild(sel);
        who_row.appendChild(free);
        who_row.appendChild(go);
      });
      acts.appendChild(who);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function _secroom_pulse_el(pulse) {
  // Human summary line ("All 10 cameras up · watching quietly"); the numbers
  // live one disclosure down. Never louder than one line.
  const el = document.createElement('details');
  el.className = 'secroom-pulse';
  const bits = [];
  if (pulse.cameras_online == null) bits.push('Cameras unreachable right now');
  else if (pulse.cameras_online === pulse.cameras_total) bits.push(`All ${pulse.cameras_total} cameras up`);
  else bits.push(`${pulse.cameras_online} of ${pulse.cameras_total} cameras up`);
  if (pulse.monitor_reads_today > 0) bits.push('watching quietly');
  const detail = [
    pulse.monitor_reads_today != null ? `${pulse.monitor_reads_today} routine check-ins in the last day` : '',
    pulse.detector_ms != null ? `Detector at ${pulse.detector_ms.toFixed(1)} ms` : '',
    pulse.frigate_streaming != null ? `${pulse.frigate_streaming} cameras on continuous watch` : '',
    pulse.tracks_today ? `${pulse.tracks_today.total} movement tracks today · ${pulse.tracks_today.named} recognized` : '',
  ].filter(Boolean).map((s) => `<div class="faces-sub">${escape_html(s)}</div>`).join('');
  el.innerHTML = `<summary>${escape_html(bits.join(' · '))}</summary>${detail || '<div class="faces-sub">Nothing further.</div>'}`;
  return el;
}

// ── "Who's home & where" room (Household Awareness P1) ────────────────────────
// Client-rendered over the occupancy route (the People-room / market-radar
// pattern): enrolled people last-seen on a camera (room + appearance + when)
// joined with each member's phone home/away, plus active unrecognized people.
function render_occupancy_room() {
  const root = document.createElement('div');
  root.className = 'faces';
  _occupancy_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Who's-home view unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
  });
  return root;
}

function _presence_badge(presence) {
  const p = presence || 'unknown';
  const label = p === 'home' ? '🏠 home' : p === 'away' ? '✈ away' : '· unknown';
  return `<span class="faces-sub" style="white-space:nowrap">${label}</span>`;
}

function _occupancy_card(o, opts) {
  const card = document.createElement('div');
  card.className = 'face-card';
  const thumb = o.thumb_url
    ? `<img class="face-thumb" src="${escape_html(o.thumb_url)}" alt="">`
    : '<div class="face-thumb face-thumb-empty">?</div>';
  const when = o.last_seen_at ? relative_time(o.last_seen_at) : '';
  const title = (opts && opts.unknown) ? '⚠ Unrecognized person' : escape_html(o.name || 'Someone');
  const bits = [o.zone ? escape_html(o.zone) : '', when ? escape_html(when) : ''].filter(Boolean).join(' · ');
  const pres = (opts && opts.unknown) ? '' : ' ' + _presence_badge(o.presence);
  const wore = o.appearance ? `<div class="faces-sub">${escape_html(o.appearance)}</div>` : '';
  card.innerHTML = thumb + `<div class="face-meta">${title}${pres}<div class="faces-sub">${bits}</div>${wore}</div>`;
  return card;
}

async function _occupancy_paint(root) {
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:80px"></div><div class="office-sk" style="height:160px"></div></div>';
  let data;
  try {
    data = await api(OCCUPANCY_API);
  } catch (err) {
    root.innerHTML = `<div class="newsdesk-err">Occupancy unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
    return;
  }
  root.innerHTML = '';

  // Summary line — the one-liner the specialists also reason over.
  const summary = document.createElement('div');
  summary.className = 'faces-panel';
  summary.innerHTML = `<div class="faces-h">Who's home & where</div><div class="faces-sub">${escape_html(data.summary || 'No one seen on a camera recently.')}</div>`;
  if (!data.presence_available) {
    const note = document.createElement('div');
    note.className = 'faces-sub';
    note.style.marginTop = '6px';
    note.textContent = 'Home/away presence is unavailable (no location source) — showing camera sightings only.';
    summary.appendChild(note);
  }
  root.appendChild(summary);

  // Unrecognized people — the concern signal, surfaced first.
  const unknowns = data.unknown_present || [];
  if (unknowns.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'faces-panel';
    sec.innerHTML = '<div class="faces-h">Unrecognized · active</div><div class="faces-sub">People the cameras see but no enrolled face matches.</div>';
    const grid = document.createElement('div');
    grid.className = 'faces-grid';
    for (const u of unknowns) grid.appendChild(_occupancy_card(u, { unknown: true }));
    sec.appendChild(grid);
    root.appendChild(sec);
  }

  // Recognized people seen on a camera in the window.
  const occupants = data.occupants || [];
  const seenSec = document.createElement('div');
  seenSec.className = 'faces-panel';
  seenSec.innerHTML = '<div class="faces-h">Seen on camera</div>';
  if (occupants.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'faces-grid';
    for (const o of occupants) grid.appendChild(_occupancy_card(o, { unknown: false }));
    seenSec.appendChild(grid);
  } else {
    seenSec.innerHTML += '<div class="faces-sub">No enrolled person seen on a camera recently.</div>';
  }
  root.appendChild(seenSec);

  // Household roster — everyone's home/away (incl. members not on a camera).
  const members = data.household || [];
  if (members.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'faces-panel';
    sec.innerHTML = '<div class="faces-h">Household</div>';
    for (const m of members) {
      const row = document.createElement('div');
      row.className = 'faces-person';
      const where = m.last_zone ? `${escape_html(m.last_zone)}` : 'not on a camera recently';
      const info = document.createElement('div');
      info.innerHTML = `<div class="faces-person-name">${escape_html(m.name)}</div><div class="faces-sub">${where}</div>`;
      const badge = document.createElement('div');
      badge.innerHTML = _presence_badge(m.presence);
      row.appendChild(info);
      row.appendChild(badge);
      sec.appendChild(row);
    }
    root.appendChild(sec);
  }
}

// ── Luna's Home office — the household floor-plan occupancy canvas (P1.5) ─────
// A top-down floor plan with named "who is where" dots, mirroring the presence
// canvas lifecycle (dpr-resize + rAF paint + ResizeObserver). Reads the imported
// home_map geometry (/home_map) + the SANITIZED household occupancy
// (/home_occupancy — named map only, no unknowns/crops). The owner can tap a
// room to assign which Protect camera(s) see it (POST /home_map/assign); a
// household viewer gets the read-only map (editable:false hides the assign UI).
const _home = {
  canvas: null, ctx: null, stage: null, ro: null, raf: 0,
  map: null, occ: null, cameras: [], floor: 0, edit: false, id: null, timer: 0, picker: null,
};

function render_home_canvas(doc) {
  _home_teardown();
  _home.id = state._pane_specialist_id || 'luna';
  _home.floor = 0;
  _home.edit = false;
  const wrap = document.createElement('div');
  wrap.className = 'home-wrap';
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;';
  wrap.innerHTML =
    '<div class="home-floors" style="display:flex;gap:6px;flex-wrap:wrap;"></div>'
    + '<div class="home-stage" style="position:relative;width:100%;height:380px;border-radius:12px;overflow:hidden;background:rgba(140,160,180,0.05);">'
    + '<canvas class="home-canvas" style="display:block;width:100%;height:100%;touch-action:none;"></canvas></div>'
    + '<div class="home-toolbar" style="display:flex;align-items:center;gap:10px;min-height:24px;">'
    + '<button type="button" class="home-edit-btn" hidden style="font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(140,160,180,0.4);background:transparent;color:inherit;cursor:pointer;">Assign cameras</button>'
    + '<span class="home-hint" style="font-size:12px;opacity:0.7;"></span></div>';
  _home.stage = wrap.querySelector('.home-stage');
  _home.canvas = wrap.querySelector('.home-canvas');
  _home.ctx = _home.canvas.getContext('2d');
  wrap.querySelector('.home-edit-btn').addEventListener('click', _home_toggle_edit);
  _home.canvas.addEventListener('pointerdown', _home_pointerdown);
  _home.ro = new ResizeObserver(() => { _home_resize(); _home_request_paint(); });
  _home.ro.observe(_home.stage);
  requestAnimationFrame(() => { _home_resize(); _home_fetch(); });
  return wrap;
}

function _home_teardown() {
  if (_home.ro) { try { _home.ro.disconnect(); } catch {} }
  if (_home.raf) cancelAnimationFrame(_home.raf);
  if (_home.timer) clearInterval(_home.timer);
  if (_home.canvas) { try { _home.canvas.removeEventListener('pointerdown', _home_pointerdown); } catch {} }
  _home_close_picker();
  _home.ro = null; _home.raf = 0; _home.timer = 0;
  _home.canvas = null; _home.ctx = null; _home.stage = null; _home.map = null; _home.occ = null; _home.cameras = []; _home.edit = false;
}

async function _home_fetch() {
  try {
    _home.map = await api(`/api/specialists/${encodeURIComponent(_home.id)}/home_map`);
  } catch {
    _home.map = { rooms: [], floors: [], adjacency: [], editable: false };
  }
  // Full Protect roster for the assign datalist (so motion-only cameras that have
  // never produced a sighting are still offerable). Fail-open to [].
  try {
    _home.cameras = (await api(`/api/specialists/${encodeURIComponent(_home.id)}/home_cameras`)).cameras || [];
  } catch {
    _home.cameras = [];
  }
  const floors = (_home.map.floors || []).map((f) => f.level);
  if (floors.length && !floors.includes(_home.floor)) _home.floor = Math.min(...floors);
  await _home_fetch_occ();
  _home_render_floors();
  _home_update_toolbar();
  _home_request_paint();
  // Refresh occupancy while mounted; self-clear when the canvas leaves the DOM.
  if (_home.timer) clearInterval(_home.timer);
  _home.timer = setInterval(() => {
    if (!_home.canvas || !document.contains(_home.canvas)) { clearInterval(_home.timer); _home.timer = 0; return; }
    _home_fetch_occ().then(() => _home_request_paint());
  }, 20000);
}

async function _home_fetch_occ() {
  try {
    _home.occ = await api(`/api/specialists/${encodeURIComponent(_home.id)}/home_occupancy?window_minutes=30`);
  } catch {
    _home.occ = { occupants: [], household: [] };
  }
}

function _home_rooms_on_floor() {
  return (_home.map?.rooms || []).filter((r) => r.floor === _home.floor);
}
function _home_all_room_ids() {
  return new Set((_home.map?.rooms || []).map((r) => r.id));
}

function _home_render_floors() {
  const bar = _home.stage?.parentElement?.querySelector('.home-floors');
  if (!bar) return;
  const floors = (_home.map?.floors || []).slice().sort((a, b) => a.level - b.level);
  bar.innerHTML = '';
  if (floors.length <= 1) return;
  for (const f of floors) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = f.name || `Floor ${f.level}`;
    const on = f.level === _home.floor;
    b.style.cssText = `font-size:12px;padding:4px 10px;border-radius:8px;border:1px solid rgba(140,160,180,${on ? 0.6 : 0.25});background:${on ? 'rgba(140,170,200,0.18)' : 'transparent'};color:inherit;cursor:pointer;`;
    b.addEventListener('click', () => { _home.floor = f.level; _home_close_picker(); _home_render_floors(); _home_update_toolbar(); _home_request_paint(); });
    bar.appendChild(b);
  }
}

function _home_update_toolbar() {
  const wrap = _home.stage?.parentElement;
  if (!wrap) return;
  const btn = wrap.querySelector('.home-edit-btn');
  const hint = wrap.querySelector('.home-hint');
  if (btn) {
    btn.hidden = !(_home.map && _home.map.editable);
    btn.textContent = _home.edit ? 'Done' : 'Assign cameras';
    btn.style.background = _home.edit ? 'rgba(140,170,200,0.18)' : 'transparent';
  }
  if (hint) {
    const rooms = _home.map?.rooms || [];
    if (!rooms.length) { hint.textContent = 'No floor plan imported yet.'; return; }
    if (_home.edit) { hint.textContent = 'Tap a room to assign which camera(s) see it.'; return; }
    const ids = _home_all_room_ids();
    const unplaced = (_home.occ?.occupants || []).filter((o) => !o.zone_id || !ids.has(o.zone_id)).length;
    hint.textContent = unplaced > 0
      ? `${unplaced} ${unplaced === 1 ? 'person' : 'people'} not shown — their camera isn't assigned to a room yet.`
      : '';
  }
}

function _home_resize() {
  if (!_home.canvas || !_home.stage) return;
  const dpr = window.devicePixelRatio || 1;
  const w = _home.stage.clientWidth || 320;
  const h = _home.stage.clientHeight || 320;
  _home.canvas.width = Math.round(w * dpr);
  _home.canvas.height = Math.round(h * dpr);
  _home.canvas.style.width = w + 'px';
  _home.canvas.style.height = h + 'px';
  _home.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _home_request_paint() {
  if (_home.raf || !_home.ctx) return;
  _home.raf = requestAnimationFrame(() => { _home.raf = 0; _home_draw(); });
}

// Fit the active floor's room polygons (ft) into the canvas box, preserving
// aspect, centered with padding. Returns the ft→px transform.
function _home_geom(rooms, W, H) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rooms) for (const p of (r.polygon || [])) {
    if (p[0] < minX) minX = p[0]; if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0]; if (p[1] > maxY) maxY = p[1];
  }
  if (!isFinite(minX)) return null;
  const pad = 26;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
  return { toPx: (x, y) => [offX + (x - minX) * scale, offY + (y - minY) * scale] };
}

function _home_centroid(poly) {
  let sx = 0, sy = 0;
  for (const p of poly) { sx += p[0]; sy += p[1]; }
  return poly.length ? [sx / poly.length, sy / poly.length] : [0, 0];
}

function _home_draw() {
  const ctx = _home.ctx, canvas = _home.canvas;
  if (!ctx || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  const rooms = _home_rooms_on_floor();
  if (!rooms.length) {
    ctx.fillStyle = 'rgba(160,175,190,0.6)';
    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText((_home.map?.rooms?.length) ? 'No rooms on this floor' : 'No floor plan imported yet.', W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }
  const g = _home_geom(rooms, W, H);
  if (!g) return;

  // Occupants grouped by their room id (this floor only).
  const byRoom = new Map();
  for (const o of (_home.occ?.occupants || [])) {
    if (!o.zone_id) continue;
    if (!byRoom.has(o.zone_id)) byRoom.set(o.zone_id, []);
    byRoom.get(o.zone_id).push(o);
  }

  for (const r of rooms) {
    const poly = (r.polygon || []).map((p) => g.toPx(p[0], p[1]));
    if (poly.length < 3) continue;
    const occ = byRoom.get(r.id) || [];
    const occupied = occ.length > 0;
    ctx.beginPath();
    poly.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
    ctx.closePath();
    if (r.kind === 'outside') {
      ctx.fillStyle = 'rgba(110,160,120,0.10)'; ctx.strokeStyle = 'rgba(120,170,130,0.5)';
    } else if (r.kind === 'transition') {
      ctx.fillStyle = 'rgba(150,160,175,0.06)'; ctx.strokeStyle = 'rgba(150,160,175,0.4)';
    } else {
      ctx.fillStyle = occupied ? 'rgba(120,170,210,0.22)' : 'rgba(140,160,185,0.10)';
      ctx.strokeStyle = occupied ? 'rgba(120,180,220,0.9)' : 'rgba(150,168,190,0.55)';
    }
    ctx.fill();
    ctx.lineWidth = occupied ? 2 : 1.25;
    ctx.stroke();

    const [cx, cy] = _home_centroid(poly);
    ctx.fillStyle = 'rgba(220,228,236,0.85)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(r.name || r.id, cx, cy - 2);

    occ.forEach((o, idx) => {
      const ty = cy + 13 + idx * 15;
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      const tw = ctx.measureText(o.name).width;
      ctx.fillStyle = '#5ad0c0';
      ctx.shadowColor = 'rgba(90,208,192,0.6)';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(cx - tw / 2 - 7, ty - 3, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(228,236,242,0.96)';
      ctx.fillText(o.name, cx, ty);
    });
    ctx.textAlign = 'left';
  }
}

function _home_toggle_edit() {
  _home.edit = !_home.edit;
  _home_close_picker();
  _home_update_toolbar();
  _home_request_paint();
}

function _home_point_in_poly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

function _home_pointerdown(e) {
  if (!_home.edit || !_home.map?.editable) return;
  const rect = _home.canvas.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const dpr = window.devicePixelRatio || 1;
  const rooms = _home_rooms_on_floor();
  const g = _home_geom(rooms, _home.canvas.width / dpr, _home.canvas.height / dpr);
  if (!g) return;
  for (const r of rooms) {
    const poly = (r.polygon || []).map((p) => g.toPx(p[0], p[1]));
    if (poly.length >= 3 && _home_point_in_poly(px, py, poly)) { _home_open_picker(r); return; }
  }
}

function _home_camera_suggestions() {
  const set = new Set(typeof FACE_CAMERAS !== 'undefined' ? FACE_CAMERAS : []);
  for (const r of (_home.map?.rooms || [])) for (const c of (r.cameras || [])) set.add(c);
  // Every adopted Protect camera (incl. motion-only ones that never auto-fire).
  for (const c of (_home.cameras || [])) if (c && c.name) set.add(c.name);
  // An unassigned occupant's zone_id IS the live Protect camera name (the
  // get_household_occupancy fallback) — the best possible suggestion source.
  const ids = _home_all_room_ids();
  for (const o of (_home.occ?.occupants || [])) if (o.zone_id && !ids.has(o.zone_id)) set.add(o.zone_id);
  return Array.from(set).sort();
}

function _home_open_picker(room) {
  _home_close_picker();
  const wrap = _home.stage?.parentElement;
  if (!wrap) return;
  const cur = (room.cameras || []).join(', ');
  const cams = _home_camera_suggestions();
  const panel = document.createElement('div');
  panel.className = 'home-picker';
  panel.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;border:1px solid rgba(140,160,180,0.35);background:rgba(20,24,30,0.55);';
  panel.innerHTML =
    `<div style="font-size:13px;font-weight:600;">Cameras that see ${escape_html(room.name || room.id)}</div>`
    + '<div style="font-size:11px;opacity:0.65;">Comma-separated Protect camera names. Empty = none.</div>'
    + `<input class="home-cam-in" list="home-cam-dl" value="${escape_html(cur)}" placeholder="e.g. Kitchen Cam" style="font-size:13px;padding:6px 8px;border-radius:8px;border:1px solid rgba(140,160,180,0.4);background:transparent;color:inherit;">`
    + `<datalist id="home-cam-dl">${cams.map((c) => `<option value="${escape_html(c)}">`).join('')}</datalist>`
    + '<div style="display:flex;gap:8px;align-items:center;">'
    + '<button type="button" class="home-cam-save" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid rgba(120,180,220,0.6);background:rgba(120,170,200,0.18);color:inherit;cursor:pointer;">Save</button>'
    + '<button type="button" class="home-cam-cancel" style="font-size:12px;padding:5px 12px;border-radius:8px;border:1px solid rgba(140,160,180,0.3);background:transparent;color:inherit;cursor:pointer;">Cancel</button>'
    + '<span class="home-cam-msg" style="font-size:12px;opacity:0.8;"></span></div>';
  panel.querySelector('.home-cam-cancel').addEventListener('click', _home_close_picker);
  panel.querySelector('.home-cam-save').addEventListener('click', () => {
    const v = panel.querySelector('.home-cam-in').value || '';
    const cameras = v.split(',').map((s) => s.trim()).filter(Boolean);
    _home_save_assign(room.id, cameras, panel.querySelector('.home-cam-msg'));
  });
  wrap.appendChild(panel);
  _home.picker = panel;
  panel.querySelector('.home-cam-in').focus();
}

function _home_close_picker() {
  if (_home.picker && _home.picker.parentElement) _home.picker.remove();
  _home.picker = null;
}

async function _home_save_assign(room_id, cameras, msgEl) {
  if (msgEl) msgEl.textContent = 'Saving…';
  try {
    await api(`/api/specialists/${encodeURIComponent(_home.id)}/home_map/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room_id, cameras }),
    });
    if (msgEl) msgEl.textContent = 'Saved ✓';
    await _home_fetch();
    setTimeout(_home_close_picker, 600);
  } catch (err) {
    if (msgEl) msgEl.textContent = (err && err.message) || 'Failed';
  }
}

function _dataurl_to_blob(durl) {
  const comma = durl.indexOf(',');
  const head = durl.slice(0, comma);
  const b64 = durl.slice(comma + 1);
  const mime = (head.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function _camera_input(value) {
  const wrap = document.createElement('span');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'faces-cam';
  input.value = value || 'Front Door';
  input.setAttribute('list', 'faces-cam-list');
  let dl = document.getElementById('faces-cam-list');
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = 'faces-cam-list';
    for (const name of FACE_CAMERAS) {
      const o = document.createElement('option');
      o.value = name;
      dl.appendChild(o);
    }
    document.body.appendChild(dl);
  }
  wrap.appendChild(input);
  wrap._input = input;
  return wrap;
}

function render_people_room() {
  const root = document.createElement('div');
  root.className = 'faces';
  _people_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">People room unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
  });
  return root;
}

async function _people_paint(root) {
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:140px"></div><div class="office-sk" style="height:160px"></div></div>';
  let data;
  try {
    data = await api(FACES_API);
  } catch (err) {
    root.innerHTML = `<div class="newsdesk-err">Roster unavailable: ${escape_html((err && err.message) || String(err))}</div>`;
    return;
  }
  root.innerHTML = '';
  if (!data.cpai_available) {
    const banner = document.createElement('div');
    banner.className = 'faces-banner';
    banner.textContent = '⚠ Face server offline — enrollment and recognition are paused. Start the cpai container on glacier.';
    root.appendChild(banner);
  }
  if (data.arcface_available === false) {
    const banner = document.createElement('div');
    banner.className = 'faces-banner';
    banner.textContent = '⚠ ArcFace sidecar offline — matching runs on the legacy path and training is paused. Start the arcface container on glacier.';
    root.appendChild(banner);
  }
  root.appendChild(_faces_gallery(root));
  root.appendChild(_faces_roster(data.people || [], root, data.last_assign));
  root.appendChild(_faces_enroll_panel(root));
  root.appendChild(_faces_test_panel());
}

// "Discovered faces" — the Nest-style gallery of clustered sightings. Name a
// cluster to enroll its whole backlog at once, merge two that are the same
// person, or dismiss a non-person.
function _faces_gallery(root) {
  const sec = document.createElement('div');
  sec.className = 'faces-panel';
  sec.innerHTML = '<div class="faces-h">Discovered faces</div><div class="faces-sub">Repeated faces the cameras see are grouped automatically. Name one to teach recognition (it enrolls the whole backlog at once), merge two that are the same person, or dismiss a non-person.</div>';
  const grid = document.createElement('div');
  grid.className = 'faces-grid';
  grid.innerHTML = '<div class="faces-sub">Loading…</div>';
  sec.appendChild(grid);
  api(FACES_API + '/clusters')
    .then((data) => {
      grid.innerHTML = '';
      const clusters = data.clusters || [];
      if (clusters.length === 0) {
        grid.innerHTML = '<div class="faces-sub">No faces discovered yet — they appear here as the cameras see people (best from the doorbell cams).</div>';
        return;
      }
      for (const cl of clusters) grid.appendChild(_cluster_card(cl, clusters, root));
    })
    .catch((e) => {
      grid.innerHTML = `<div class="newsdesk-err">${escape_html((e && e.message) || String(e))}</div>`;
    });
  return sec;
}

function _cluster_card(cl, all, root) {
  const card = document.createElement('div');
  card.className = 'face-card' + (cl.status === 'named' ? ' named' : '');
  const seen = cl.last_seen_at ? relative_time(cl.last_seen_at) : '';
  const thumb = cl.thumb_url
    ? `<img class="face-thumb" src="${escape_html(cl.thumb_url)}" alt="">`
    : '<div class="face-thumb face-thumb-empty">?</div>';
  const title = cl.status === 'named' ? escape_html(cl.label || 'Named') : 'Unknown';
  card.innerHTML = thumb + `<div class="face-meta">${title} · seen ${cl.sighting_count}×${seen ? ' · ' + escape_html(seen) : ''}</div>`;
  if (cl.status === 'named') return card;

  // Drill-in (2026-07-18): tap the thumbnail to review ALL the cluster's
  // shots before deciding — Nest's "look at the photos first" affordance.
  // Naming from one 96px thumb is how a polluted cluster gets a wrong name.
  const thumb_el = card.querySelector('.face-thumb');
  if (thumb_el) {
    thumb_el.style.cursor = 'zoom-in';
    thumb_el.title = 'See all shots';
    let open = false;
    let drill = null;
    thumb_el.addEventListener('click', () => {
      if (open) {
        if (drill) drill.remove();
        drill = null;
        open = false;
        return;
      }
      open = true;
      drill = document.createElement('div');
      drill.className = 'face-drill';
      drill.innerHTML = '<div class="faces-sub">Loading shots…</div>';
      card.appendChild(drill);
      api(`${FACES_API}/clusters/${encodeURIComponent(cl.id)}`)
        .then((d) => {
          if (!drill) return;
          drill.innerHTML = '';
          for (const s of d.sightings || []) {
            const img = document.createElement('img');
            img.className = 'face-drill-shot';
            img.src = s.crop_url;
            img.alt = '';
            img.title = [s.camera_name, relative_time(s.captured_at)].filter(Boolean).join(' · ');
            drill.appendChild(img);
          }
          if (!drill.children.length) drill.innerHTML = '<div class="faces-sub">No shots recorded.</div>';
        })
        .catch(() => {
          if (drill) drill.innerHTML = '<div class="faces-sub">Shots unavailable.</div>';
        });
    });
  }

  const ctrls = document.createElement('div');
  ctrls.className = 'face-ctrls';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'faces-name';
  nameInput.placeholder = 'Name';
  const assign = document.createElement('button');
  assign.type = 'button';
  assign.className = 'faces-btn primary';
  assign.textContent = 'Assign';
  assign.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    assign.disabled = true;
    assign.textContent = 'Enrolling…';
    try {
      const r = await api(`${FACES_API}/clusters/${encodeURIComponent(cl.id)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      toast(`Enrolled ${name} from ${r.enrolled} face${r.enrolled === 1 ? '' : 's'}`);
      _people_paint(root);
    } catch (e) {
      toast((e && e.message) || 'Assign failed', true);
      assign.disabled = false;
      assign.textContent = 'Assign';
    }
  });
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'faces-btn';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', async () => {
    if (!confirm('Dismiss this face cluster? It will stop appearing here.')) return;
    try {
      await api(`${FACES_API}/clusters/${encodeURIComponent(cl.id)}/dismiss`, { method: 'POST' });
      _people_paint(root);
    } catch (e) {
      toast((e && e.message) || 'Dismiss failed', true);
    }
  });
  ctrls.appendChild(nameInput);
  ctrls.appendChild(assign);
  ctrls.appendChild(dismiss);

  // "same as…" offers NAMED targets only (2026-07-15): merging one unknown
  // into another is the nightly consolidation's job (vector-space, automatic)
  // — a human should only ever say "this unknown is Jasper". Unknowns are
  // never an item to assign to.
  const others = (all || []).filter((x) => x.id !== cl.id && x.status === 'named');
  if (others.length) {
    const merge = document.createElement('select');
    merge.className = 'faces-cam';
    merge.innerHTML =
      '<option value="">same as…</option>' +
      others
        .map((o) => `<option value="${escape_html(o.id)}">${escape_html(o.label || 'Named')} (${o.sighting_count}×)</option>`)
        .join('');
    merge.addEventListener('change', async () => {
      const dst = merge.value;
      if (!dst) return;
      try {
        await api(`${FACES_API}/clusters/merge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ src_cluster_id: cl.id, dst_cluster_id: dst }),
        });
        toast('Merged');
        _people_paint(root);
      } catch (e) {
        toast((e && e.message) || 'Merge failed', true);
      }
    });
    ctrls.appendChild(merge);
  }
  card.appendChild(ctrls);
  return card;
}

function _faces_enroll_panel(root) {
  const sec = document.createElement('div');
  sec.className = 'faces-panel';
  sec.innerHTML = '<div class="faces-h">Enroll a person</div><div class="faces-sub">Capture a clear frame from a doorbell camera — or upload a few photos (casual shots at doorbell-like angles beat studio portraits).</div>';

  // Upload path — masters seed recognition instantly; camera shots take
  // over as they accumulate.
  const upRow = document.createElement('div');
  upRow.className = 'faces-row';
  const upName = document.createElement('input');
  upName.type = 'text';
  upName.placeholder = 'Name';
  upName.className = 'faces-name';
  const upRel = document.createElement('input');
  upRel.type = 'text';
  upRel.placeholder = 'Relationship (optional)';
  upRel.className = 'faces-rel';
  const upInput = document.createElement('input');
  upInput.type = 'file';
  upInput.accept = 'image/*';
  upInput.multiple = true;
  upInput.style.display = 'none';
  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'faces-btn';
  upBtn.textContent = 'Upload photos…';
  upBtn.addEventListener('click', () => {
    if (!upName.value.trim()) { upName.focus(); return; }
    upInput.click();
  });
  upInput.addEventListener('change', async () => {
    if (!upInput.files || upInput.files.length === 0) return;
    upBtn.disabled = true;
    upBtn.textContent = 'Enrolling…';
    try {
      const fd = new FormData();
      fd.append('name', upName.value.trim());
      if (upRel.value.trim()) fd.append('relationship', upRel.value.trim());
      for (const f of upInput.files) fd.append('image', f, f.name);
      const r = await api(`${FACES_API}/enroll`, { method: 'POST', body: fd });
      toast(`Enrolled ${upName.value.trim()} (${r.total} photo${r.total === 1 ? '' : 's'}${r.master_vectors_added ? `, learned ${r.master_vectors_added}` : ''})`);
      _people_paint(root);
    } catch (e) {
      toast((e && e.message) || 'Upload failed', true);
      upBtn.disabled = false;
      upBtn.textContent = 'Upload photos…';
    }
  });
  upRow.appendChild(upName);
  upRow.appendChild(upRel);
  upRow.appendChild(upBtn);
  upRow.appendChild(upInput);
  sec.appendChild(upRow);

  const camRow = document.createElement('div');
  camRow.className = 'faces-row';
  const cam = _camera_input('Front Door');
  const capBtn = document.createElement('button');
  capBtn.type = 'button';
  capBtn.className = 'faces-btn';
  capBtn.textContent = 'Capture frame';
  camRow.appendChild(cam);
  camRow.appendChild(capBtn);
  sec.appendChild(camRow);

  const stage = document.createElement('div');
  stage.className = 'faces-stage';
  sec.appendChild(stage);

  let captured_blob = null;

  capBtn.addEventListener('click', async () => {
    capBtn.disabled = true;
    capBtn.textContent = 'Capturing…';
    stage.innerHTML = '';
    try {
      const out = await api(`${FACES_API}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera: cam._input.value.trim() }),
      });
      captured_blob = _dataurl_to_blob(out.frame);
      const img = document.createElement('img');
      img.className = 'faces-frame';
      img.src = out.frame;
      stage.appendChild(img);
      const note = document.createElement('div');
      note.className = 'faces-detect';
      note.textContent = out.face_count > 0
        ? `${out.face_count} face${out.face_count === 1 ? '' : 's'} detected — name the person below and enroll.`
        : 'No face detected in this frame — recapture with the person closer and facing the camera.';
      stage.appendChild(note);

      const nameRow = document.createElement('div');
      nameRow.className = 'faces-row';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Name (e.g. Jasper)';
      nameInput.className = 'faces-name';
      const relInput = document.createElement('input');
      relInput.type = 'text';
      relInput.placeholder = 'Relationship (optional)';
      relInput.className = 'faces-rel';
      const enrollBtn = document.createElement('button');
      enrollBtn.type = 'button';
      enrollBtn.className = 'faces-btn primary';
      enrollBtn.textContent = 'Enroll this face';
      enrollBtn.disabled = out.face_count === 0;
      nameRow.appendChild(nameInput);
      nameRow.appendChild(relInput);
      nameRow.appendChild(enrollBtn);
      stage.appendChild(nameRow);

      enrollBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        if (!captured_blob) return;
        enrollBtn.disabled = true;
        enrollBtn.textContent = 'Enrolling…';
        try {
          const fd = new FormData();
          fd.append('name', name);
          if (relInput.value.trim()) fd.append('relationship', relInput.value.trim());
          fd.append('image', captured_blob, 'enroll.jpg');
          const res = await api(`${FACES_API}/enroll`, { method: 'POST', body: fd });
          toast(`Enrolled ${name} (${res.total} photo${res.total === 1 ? '' : 's'})`);
          _people_paint(root);
        } catch (err) {
          toast((err && err.message) || 'Enroll failed', true);
          enrollBtn.disabled = false;
          enrollBtn.textContent = 'Enroll this face';
        }
      });
    } catch (err) {
      stage.innerHTML = `<div class="newsdesk-err">${escape_html((err && err.message) || 'Capture failed')}</div>`;
    } finally {
      capBtn.disabled = false;
      capBtn.textContent = 'Capture frame';
    }
  });

  return sec;
}

function _faces_test_panel() {
  const sec = document.createElement('div');
  sec.className = 'faces-panel';
  sec.innerHTML = '<div class="faces-h">Test on a live frame</div><div class="faces-sub">Check who recognition matches right now.</div>';
  const row = document.createElement('div');
  row.className = 'faces-row';
  const cam = _camera_input('Front Door');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'faces-btn';
  btn.textContent = 'Test recognition';
  const result = document.createElement('div');
  result.className = 'faces-detect';
  row.appendChild(cam);
  row.appendChild(btn);
  sec.appendChild(row);
  sec.appendChild(result);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Looking…';
    result.textContent = '';
    try {
      const out = await api(`${FACES_API}/test-recognize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera: cam._input.value.trim() }),
      });
      const names = (out.recognized || []).map((m) => `${m.name} (${Math.round(m.confidence * 100)}%)`);
      if (names.length) result.textContent = `Recognized: ${names.join(', ')}` + (out.unknown_faces ? ` · ${out.unknown_faces} unknown` : '');
      else result.textContent = out.unknown_faces ? `${out.unknown_faces} face(s), none enrolled.` : 'No faces in frame.';
    } catch (err) {
      result.textContent = (err && err.message) || 'Test failed';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test recognition';
    }
  });
  return sec;
}

function _faces_roster(people, root, last_assign) {
  const sec = document.createElement('div');
  sec.className = 'faces-panel';
  sec.innerHTML = `<div class="faces-h">Enrolled (${people.length})</div>`;
  // One-step undo for the latest assign (2026-07-15) — the wrong-click
  // escape hatch. Server-validated: a superseded assign 409s harmlessly.
  if (last_assign && last_assign.person) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'faces-btn';
    undo.textContent = `Undo last assign (${last_assign.person}${last_assign.at ? ', ' + relative_time(last_assign.at) : ''})`;
    undo.addEventListener('click', async () => {
      if (!confirm(`Undo the assign to ${last_assign.person}? The face returns to Discovered faces.`)) return;
      undo.disabled = true;
      try {
        await api(`${FACES_API}/undo_last`, { method: 'POST' });
        toast(`Undid the assign to ${last_assign.person}`);
        _people_paint(root);
      } catch (e) {
        toast((e && e.message) || 'Undo failed', true);
        undo.disabled = false;
      }
    });
    sec.appendChild(undo);
  }
  if (people.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'faces-sub';
    empty.textContent = 'No one enrolled yet. Capture a face above to teach recognition who belongs here.';
    sec.appendChild(empty);
    return sec;
  }
  for (const p of people) {
    sec.appendChild(_person_card(p, root));
  }
  return sec;
}

// One enrolled person, Nest-style (2026-07-18): the recognized-shot gallery
// IS the training set, and the health line says whether the matcher is armed.
// A person with photos but zero recognition vectors is effectively unenrolled
// — that state gets a visible warning + a one-tap "Train now".
function _person_card(p, root) {
  const card = document.createElement('div');
  card.className = 'faces-person-card';

  const head = document.createElement('div');
  head.className = 'faces-person';
  const seen = p.last_recognized_at ? `recognized ${relative_time(p.last_recognized_at)}` : 'never recognized';
  const starved = (p.vector_count || 0) < 4;
  const health = starved
    ? `<span class="faces-warn">⚠ recognition ${p.vector_count ? 'weak' : 'unarmed'} — ${p.vector_count || 0} reference shot${p.vector_count === 1 ? '' : 's'}</span>`
    : `${p.vector_count} reference shots${p.last_vector_at ? ' · learned ' + escape_html(relative_time(p.last_vector_at)) : ''}`;
  const info = document.createElement('div');
  info.innerHTML =
    `<div class="faces-person-name">${escape_html(p.name)}${p.in_sync === false ? ' <span class="faces-warn" title="not in the face server">⚠</span>' : ''}</div>` +
    `<div class="faces-sub">${escape_html([p.relationship, seen, `${p.sighting_count || 0} camera shot${p.sighting_count === 1 ? '' : 's'}`].filter(Boolean).join(' · '))}</div>` +
    `<div class="faces-health">${health}</div>`;
  head.appendChild(info);

  const btns = document.createElement('div');
  btns.className = 'faces-person-btns';
  // Add master/reference photos (identity anchors; capped server-side so
  // uploads can never crowd the camera-domain recognition set).
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;
    const fd = new FormData();
    fd.append('name', p.name);
    for (const f of fileInput.files) fd.append('image', f, f.name);
    try {
      const r = await api(`${FACES_API}/enroll`, { method: 'POST', body: fd });
      toast(`Added ${r.added} photo${r.added === 1 ? '' : 's'}${r.master_vectors_added ? ` · learned ${r.master_vectors_added}` : ''}`);
      _people_paint(root);
    } catch (e) {
      toast((e && e.message) || 'Upload failed', true);
    }
  });
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'faces-btn';
  addBtn.textContent = 'Add photos';
  addBtn.title = 'Upload reference photos (identity anchors — casual shots at doorbell-like angles work best)';
  addBtn.addEventListener('click', () => fileInput.click());
  btns.appendChild(fileInput);
  btns.appendChild(addBtn);
  if (starved && (p.sighting_count || 0) > 0) {
    const train = document.createElement('button');
    train.type = 'button';
    train.className = 'faces-btn primary';
    train.textContent = 'Train now';
    train.title = 'Build the recognition set from their recent camera shots';
    train.addEventListener('click', async () => {
      train.disabled = true;
      train.textContent = 'Training…';
      try {
        const r = await api(`${FACES_API}/persons/${encodeURIComponent(p.id)}/train_now`, { method: 'POST' });
        toast(`Learned ${r.added} shot${r.added === 1 ? '' : 's'} — recognition set now ${r.vector_count}`);
        _people_paint(root);
      } catch (e) {
        toast((e && e.message) || 'Training failed', true);
        train.disabled = false;
        train.textContent = 'Train now';
      }
    });
    btns.appendChild(train);
  }
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'faces-btn danger';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    if (!confirm(`Remove ${p.name} from the roster? They will no longer be recognized.`)) return;
    del.disabled = true;
    try {
      await api(`${FACES_API}/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      toast(`Removed ${p.name}`);
      _people_paint(root);
    } catch (err) {
      toast((err && err.message) || 'Delete failed', true);
      del.disabled = false;
    }
  });
  btns.appendChild(del);
  head.appendChild(btns);
  card.appendChild(head);

  // The recognized-shot strip — lazy, most-recent first, ✕ = "not them"
  // (removes the shot and rebuilds the recognition set from what's left).
  // The same fetch paints the reference-photo (master) strip + the
  // master/camera health split.
  {
    const refs = document.createElement('div');
    refs.className = 'face-strip face-ref-strip';
    card.appendChild(refs);
    const strip = document.createElement('div');
    strip.className = 'face-strip';
    if ((p.sighting_count || 0) > 0) strip.innerHTML = '<div class="faces-sub">Loading shots…</div>';
    card.appendChild(strip);
    api(`${FACES_API}/persons/${encodeURIComponent(p.id)}/gallery`)
      .then((g) => {
        // Reference photos (masters) — labeled + dashed to read as anchors,
        // not camera evidence; ✕ removes + rebuilds the master vectors.
        refs.innerHTML = '';
        const ref_photos = g.ref_photos || [];
        if (ref_photos.length > 0) {
          const lbl = document.createElement('div');
          lbl.className = 'faces-sub face-ref-label';
          const rs = g.recognition_set || {};
          lbl.textContent = `Reference photos (${ref_photos.length})` +
            (rs.master_count != null ? ` · set: ${rs.camera_count || 0} camera + ${rs.master_count || 0} master` : '');
          refs.appendChild(lbl);
          for (const rp of ref_photos) {
            const cell = document.createElement('div');
            cell.className = 'face-shot face-ref';
            cell.innerHTML =
              `<img src="${escape_html(rp.url)}" alt="" title="Reference photo">` +
              '<button type="button" class="face-shot-x" title="Remove this reference photo (masters rebuild from the rest)">✕</button>';
            cell.querySelector('.face-shot-x').addEventListener('click', async () => {
              if (!confirm('Remove this reference photo? Master vectors rebuild from the remaining photos.')) return;
              try {
                await api(`${FACES_API}/persons/${encodeURIComponent(p.id)}/photo/${rp.idx}`, { method: 'DELETE' });
                toast('Reference photo removed');
                _people_paint(root);
              } catch (e) {
                toast((e && e.message) || 'Remove failed', true);
              }
            });
            refs.appendChild(cell);
          }
        }
        strip.innerHTML = '';
        const shots = g.shots || [];
        if (shots.length === 0) {
          if ((p.sighting_count || 0) > 0) strip.innerHTML = '<div class="faces-sub">No camera shots yet.</div>';
          return;
        }
        let shown = 0;
        const render_shot = (s) => {
          const cell = document.createElement('div');
          cell.className = 'face-shot';
          cell.innerHTML =
            `<img src="${escape_html(s.crop_url)}" alt="" title="${escape_html([s.camera_name, relative_time(s.captured_at)].filter(Boolean).join(' · '))}">` +
            '<button type="button" class="face-shot-x" title="Not them — remove this shot and retrain">✕</button>';
          cell.querySelector('.face-shot-x').addEventListener('click', async () => {
            if (!confirm(`Not ${p.name}? The shot is removed and their recognition set repaired from the rest.`)) return;
            try {
              const r = await api(`${FACES_API}/sightings/${encodeURIComponent(s.id)}/reject`, { method: 'POST' });
              if (r.vector_count === 0) {
                toast('Shot removed — but the recognition set is now EMPTY. Use Train now once shots accumulate.', true);
              } else if (r.retrained) {
                toast(`Shot removed — recognition set rebuilt (${r.vector_count} shots)`);
              } else {
                toast(`Shot removed${r.vectors_deleted ? ` — ${r.vectors_deleted} trained vector(s) dropped` : ''}`);
              }
              _people_paint(root);
            } catch (e) {
              toast((e && e.message) || 'Remove failed', true);
            }
          });
          return cell;
        };
        for (const s of shots.slice(0, 8)) {
          strip.appendChild(render_shot(s));
          shown++;
        }
        if (shots.length > shown) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'faces-btn face-strip-more';
          more.textContent = `+${shots.length - shown} more`;
          more.addEventListener('click', () => {
            more.remove();
            for (const s of shots.slice(shown)) strip.appendChild(render_shot(s));
          });
          strip.appendChild(more);
        }
      })
      .catch(() => {
        strip.innerHTML = '<div class="faces-sub">Shots unavailable.</div>';
      });
  }
  return card;
}

const RADAR_CACHE_MS = 60_000;

async function _radar_fetch(specialist_id) {
  state._radar_cache = state._radar_cache || new Map();
  const hit = state._radar_cache.get(specialist_id);
  if (hit && Date.now() - hit.at < RADAR_CACHE_MS) return hit.payload;
  const payload = await api(`/api/specialists/${encodeURIComponent(specialist_id)}/market_radar`);
  state._radar_cache.set(specialist_id, { at: Date.now(), payload });
  return payload;
}

function render_market_radar_view() {
  const root = document.createElement('div');
  root.className = 'radar';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:110px"></div><div class="office-sk" style="height:220px"></div></div>';
  _radar_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">Market Radar unavailable: ${escape_html(err && err.message || String(err))}</div>`;
  });
  return root;
}

function _radar_pct(v, label) {
  if (v == null) return `<span class="radar-pct">${escape_html(label)} —</span>`;
  const cls = v >= 0 ? 'up' : 'down';
  const sign = v >= 0 ? '+' : '';
  return `<span class="radar-pct ${cls}">${escape_html(label)} ${sign}${escape_html(v.toFixed(1))}%</span>`;
}

function _radar_section_title(text) {
  const el = document.createElement('div');
  el.className = 'radar-sec';
  el.textContent = text;
  return el;
}

function _radar_card(s) {
  const el = document.createElement('div');
  el.className = 'radar-card';
  el.innerHTML =
    `<div class="radar-card-sym">${escape_html(s.symbol)}</div>`
    + `<div class="radar-card-name">${escape_html(s.name || '')}</div>`
    + `<div class="radar-card-rets">${_radar_pct(s.r_1mo_pct, '1mo')} ${_radar_pct(s.r_3mo_pct, '3mo')}</div>`
    + '<div class="radar-card-meta">'
    + (s.pct_off_52w_high != null ? `${escape_html(s.pct_off_52w_high.toFixed(1))}% off 52w high` : '')
    + (s.annualized_volatility_pct != null ? ` · vol ${escape_html(String(Math.round(s.annualized_volatility_pct)))}%` : '')
    + '</div>';
  return el;
}

const _RADAR_DELTA_KIND = {
  new: { tag: 'NEW', cls: 'new', icon: '✨' },
  accel: { tag: 'ACCELERATING', cls: 'accel', icon: '▲' },
  drop: { tag: 'COOLED OFF', cls: 'drop', icon: '▼' },
};

function _radar_delta(kind, m) {
  const k = _RADAR_DELTA_KIND[kind] || _RADAR_DELTA_KIND.new;
  const el = document.createElement('div');
  el.className = 'radar-delta ' + k.cls;
  const tail =
    kind === 'accel' && m.score_delta != null
      ? `score +${escape_html(String(Math.round(m.score_delta)))}`
      : kind === 'drop'
        ? 'left the top names'
        : `score ${escape_html(String(m.momentum_score))}`;
  el.innerHTML =
    `<span class="radar-delta-badge">${k.icon} ${escape_html(k.tag)}</span>`
    + `<span class="radar-delta-sym">${escape_html(m.symbol)}</span>`
    + `<span class="radar-delta-theme">${escape_html(m.theme_label || '')}</span>`
    + `<span class="radar-delta-rets">${_radar_pct(m.r_1mo_pct, '1mo')} ${_radar_pct(m.r_3mo_pct, '3mo')}</span>`
    + `<span class="radar-delta-tail">${tail}</span>`;
  return el;
}

function _radar_row(r) {
  const el = document.createElement('div');
  el.className = 'radar-row';
  el.innerHTML =
    `<span class="radar-row-sym">${escape_html(r.symbol)}</span>`
    + `<span class="radar-row-name">${escape_html(r.name || '')}</span>`
    + `<span class="radar-score" title="momentum score within this theme (0–100)">${escape_html(String(r.momentum_score))}</span>`
    + `<span class="radar-row-rets">${_radar_pct(r.r_1mo_pct, '1mo')} ${_radar_pct(r.r_3mo_pct, '3mo')}</span>`
    + '<span class="radar-row-risk">'
    + (r.annualized_volatility_pct != null ? `vol ${escape_html(String(Math.round(r.annualized_volatility_pct)))}%` : '')
    + (r.max_drawdown_3mo_pct != null ? ` · dd ${escape_html(String(Math.round(r.max_drawdown_3mo_pct)))}%` : '')
    + '</span>';
  return el;
}

async function _radar_paint(root) {
  const sid = state._pane_specialist_id || 'vivian';
  const payload = await _radar_fetch(sid);
  if (!root.isConnected && root.childElementCount === 0) return;
  root.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'radar-fresh' + (payload.stale ? ' stale' : '');
  head.textContent = payload.generated_at
    ? `Screen as of ${relative_time(payload.generated_at)}`
      + (payload.stale ? ' — stale; refreshes 06:50 / 13:30, or ask Vivian' : '')
    : 'No radar snapshot yet — the 06:50 / 13:30 refresh fills this in, or ask Vivian to refresh the radar.';
  root.appendChild(head);

  if ((payload.spotlight || []).length) {
    root.appendChild(_radar_section_title('Spotlight — strongest movers across themes'));
    const strip = document.createElement('div');
    strip.className = 'radar-strip';
    for (const s of payload.spotlight) strip.appendChild(_radar_card(s));
    root.appendChild(strip);
  }

  // What's NEW since the last comparison run — the "what's moving" delta.
  const mv = payload.movers;
  if (mv && ((mv.entered || []).length || (mv.accelerating || []).length || (mv.dropped || []).length)) {
    root.appendChild(_radar_section_title(`New & accelerating since ${relative_time(mv.since)}`));
    const wrap = document.createElement('div');
    wrap.className = 'radar-deltas';
    for (const m of mv.entered || []) wrap.appendChild(_radar_delta('new', m));
    for (const m of mv.accelerating || []) wrap.appendChild(_radar_delta('accel', m));
    for (const m of mv.dropped || []) wrap.appendChild(_radar_delta('drop', m));
    root.appendChild(wrap);
  }

  for (const t of payload.themes || []) {
    root.appendChild(_radar_section_title(t.label));
    const rows = document.createElement('div');
    rows.className = 'radar-rows';
    for (const row of t.items || []) rows.appendChild(_radar_row(row));
    root.appendChild(rows);
  }

  root.appendChild(_radar_section_title('AI & market headlines'));
  const list = document.createElement('div');
  list.className = 'news-list';
  const items = payload.news || [];
  if (items.length === 0) {
    list.innerHTML = '<div class="news-empty">No finance headlines yet — Vivian’s market feeds fill in with Cordelia’s nightly refresh (03:40).</div>';
  }
  for (const it of items) {
    const row = document.createElement('a');
    row.className = 'news-item';
    row.href = it.link;
    row.target = '_blank';
    row.rel = 'noopener noreferrer';
    const when = it.published_at || it.fetched_at;
    row.innerHTML =
      `<div class="news-item-title">${escape_html(it.title)}</div>`
      + (it.description ? `<div class="news-item-desc">${escape_html(it.description)}</div>` : '')
      + '<div class="news-item-meta">'
      + `<span class="news-item-src">${escape_html(it.source_domain)}</span>`
      + (it.category ? `<span class="news-item-cat">${escape_html(it.category)}</span>` : '')
      + (when ? `<span class="news-item-when">${escape_html(relative_time(when))}</span>` : '')
      + '</div>';
    list.appendChild(row);
  }
  root.appendChild(list);

  const foot = document.createElement('div');
  foot.className = 'radar-foot';
  foot.textContent = 'Momentum measures what IS moving, not what will. Speculative-sleeve sizing applies: 5–10% of investable assets, total, across all radar positions.';
  root.appendChild(foot);
}

const NEWS_CACHE_MS = 60_000;

async function _news_fetch_desk(category) {
  const key = category || '*';
  state._news_cache = state._news_cache || new Map();
  const hit = state._news_cache.get(key);
  if (hit && Date.now() - hit.at < NEWS_CACHE_MS) return hit.payload;
  const qs = category ? `?category=${encodeURIComponent(category)}` : '';
  const payload = await api(`/api/news/desk${qs}`);
  state._news_cache.set(key, { at: Date.now(), payload });
  return payload;
}

function _news_invalidate() {
  if (state._news_cache) state._news_cache.clear();
}

function render_news_desk_view() {
  const root = document.createElement('div');
  root.className = 'newsdesk';
  root.innerHTML = '<div class="office-skel"><div class="office-sk" style="height:88px"></div><div class="office-sk" style="height:200px"></div></div>';
  _news_paint(root).catch((err) => {
    root.innerHTML = `<div class="newsdesk-err">News Desk unavailable: ${escape_html(err && err.message || String(err))}</div>`;
  });
  return root;
}

async function _news_paint(root) {
  const payload = await _news_fetch_desk(state._news_filter || null);
  if (!root.isConnected && root.childElementCount === 0) return;
  root.innerHTML = '';

  // ── word cloud ──
  const cloud_wrap = document.createElement('div');
  cloud_wrap.className = 'news-cloud-wrap';
  const cloud = document.createElement('div');
  cloud.className = 'news-cloud';
  const cats = payload.categories || [];
  const max_n = Math.max(1, ...cats.map((c) => c.item_count_7d || 0));
  for (const c of cats) {
    const w = document.createElement('button');
    w.type = 'button';
    const px = 13 + Math.round(17 * Math.sqrt((c.item_count_7d || 0) / max_n));
    w.style.fontSize = `${px}px`;
    w.className = 'news-word ' + c.state
      + (state._news_filter === c.key ? ' filtered' : '');
    w.textContent = (c.state === 'offered' ? '+ ' : '') + c.key;
    w.title = c.state === 'offered'
      ? `Offered — click to start tracking (${c.source_count} feeds)`
      : `${c.item_count_7d} stories this week · ${c.source_count} feed(s)`
        + (c.state === 'paused' ? ' · paused' : '');
    w.addEventListener('click', () => _news_word_click(c, root));
    cloud.appendChild(w);
  }
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'office-gear news-gear' + (state._news_manage ? ' on' : '');
  gear.title = 'Manage categories (pause / resume / track new)';
  gear.innerHTML = '<span class="icon">⚙️</span>';
  gear.addEventListener('click', () => {
    state._news_manage = !state._news_manage;
    _news_paint(root);
  });
  cloud_wrap.appendChild(cloud);
  cloud_wrap.appendChild(gear);
  root.appendChild(cloud_wrap);

  if (state._news_manage) {
    const hint = document.createElement('div');
    hint.className = 'news-manage-hint';
    hint.textContent = 'Manage mode: click a word to pause/resume it; click an offered (+) word to start tracking it.';
    root.appendChild(hint);
    const track = document.createElement('div');
    track.className = 'news-track';
    track.innerHTML = '<input type="text" class="news-track-input" placeholder="Track something new… (Cordelia scouts; you approve the sources)" maxlength="180">'
      + '<button type="button" class="news-track-go">Scout</button>';
    const input = track.querySelector('.news-track-input');
    const go = track.querySelector('.news-track-go');
    const submit = async () => {
      const topic = (input.value || '').trim();
      if (topic.length < 3) return;
      go.disabled = true;
      go.textContent = 'Scouting…';
      try {
        const r = await api('/api/news/track', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ topic }),
        });
        toast(r.proposals_filed > 0
          ? `Filed ${r.proposals_filed} source proposal(s) for “${topic}” — approve them in the queue and they join the desk.`
          : (r.judge_error ? `Scout ran but the judge was unavailable — try again later.` : `Scout found nothing roster-worthy for “${topic}”.`));
        input.value = '';
      } catch (err) {
        toast(`Scout failed: ${err && err.message || err}`, true);
      } finally {
        go.disabled = false;
        go.textContent = 'Scout';
      }
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    root.appendChild(track);
  }

  // Kate's Read — her grounded take card: the lead on the unfiltered
  // desk, the category take when filtered. Composed nightly at 04:10.
  const takes = payload.takes || { lead: null, by_category: {} };
  const take = state._news_filter
    ? takes.by_category && takes.by_category[state._news_filter]
    : takes.lead;
  if (take && !state._news_manage) {
    const card = document.createElement('div');
    card.className = 'news-take';
    const doms = (take.cited_links || []).map((l) => {
      try { return new URL(l).hostname.replace(/^www\./, ''); } catch { return null; }
    }).filter(Boolean);
    const uniq = [...new Set(doms)].slice(0, 5);
    card.innerHTML =
      `<div class="news-take-head">Kate's read${state._news_filter ? ` · ${escape_html(state._news_filter)}` : ''}`
      + `<span class="news-take-when">${escape_html(relative_time(take.ts))}</span></div>`
      + `<div class="news-take-body">${_news_md_lite(take.take_md)}</div>`
      + (uniq.length ? `<div class="news-take-cites">grounded on ${escape_html(uniq.join(' · '))}</div>` : '');
    root.appendChild(card);
  }

  if (state._news_filter) {
    const chip = document.createElement('div');
    chip.className = 'news-filter-chip';
    chip.innerHTML = `Filtering: <b>${escape_html(state._news_filter)}</b> <button type="button" class="news-filter-x" aria-label="Clear filter">✕</button>`;
    chip.querySelector('.news-filter-x').addEventListener('click', () => {
      state._news_filter = null;
      _news_paint(root);
    });
    root.appendChild(chip);
  }

  // ── headlines ──
  const list = document.createElement('div');
  list.className = 'news-list';
  const items = payload.items || [];
  if (items.length === 0) {
    list.innerHTML = '<div class="news-empty">No headlines yet — the nightly refresh (03:40) fills this in; feeds also load on the next manual refresh.</div>';
  }
  for (const it of items) {
    const row = document.createElement('a');
    row.className = 'news-item';
    row.href = it.link;
    row.target = '_blank';
    row.rel = 'noopener noreferrer';
    const when = it.published_at || it.fetched_at;
    row.innerHTML =
      `<div class="news-item-title">${escape_html(it.title)}</div>`
      + (it.description ? `<div class="news-item-desc">${escape_html(it.description)}</div>` : '')
      + '<div class="news-item-meta">'
      + `<span class="news-item-src">${escape_html(it.source_domain)}</span>`
      + (it.category ? `<span class="news-item-cat">${escape_html(it.category)}</span>` : '')
      + (when ? `<span class="news-item-when">${escape_html(relative_time(when))}</span>` : '')
      + (it.because_you_watch ? `<span class="news-item-taste">because you watch ${escape_html(it.because_you_watch)}</span>` : '')
      + '</div>';
    list.appendChild(row);
  }
  root.appendChild(list);
}

// Minimal markdown for take prose: escape, then numbered citation
// links [1](url) → tiny superscript anchors, **bold**, *em*, legacy
// bare [ref] tokens dimmed, double-newline paragraphs. No raw HTML.
function _news_md_lite(md) {
  const esc = escape_html(md || '');
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p
      // Citations first so the bare-token rule below can't eat link syntax.
      .replace(/\[(\d{1,2})\]\((https?:[^)\s]+)\)/g,
        '<sup><a class="news-take-cite" href="$2" target="_blank" rel="noopener noreferrer">$1</a></sup>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*]+)\*/g, '<i>$1</i>')
      .replace(/\[([a-z0-9-]+-\d+)\]/gi, '<span class="news-take-ref">[$1]</span>')
      .replace(/\n/g, '<br>')}</p>`)
    .join('');
}

async function _news_word_click(c, root) {
  if (state._news_manage) {
    try {
      if (c.state === 'offered') {
        const r = await api(`/api/news/activate/${encodeURIComponent(c.key)}`, { method: 'POST' });
        toast(`Now tracking ${c.key} (${r.sources_added} feeds) — headlines arrive with the next refresh.`);
      } else {
        const paused = c.state !== 'paused';
        await api(`/api/news/categories/${encodeURIComponent(c.key)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paused }),
        });
        toast(paused ? `Paused ${c.key} — the nightly refresh skips it.` : `Resumed ${c.key}.`);
      }
      _news_invalidate();
      _news_paint(root);
    } catch (err) {
      toast(`${err && err.message || err}`, true);
    }
    return;
  }
  if (c.state === 'offered') {
    if (!window.confirm(`Start tracking “${c.key}”? Kate subscribes to ${c.source_count} curated feed(s); you can pause it anytime from the gear.`)) return;
    try {
      const r = await api(`/api/news/activate/${encodeURIComponent(c.key)}`, { method: 'POST' });
      toast(`Now tracking ${c.key} (${r.sources_added} feeds).`);
      _news_invalidate();
      _news_paint(root);
    } catch (err) {
      toast(`${err && err.message || err}`, true);
    }
    return;
  }
  state._news_filter = state._news_filter === c.key ? null : c.key;
  _news_paint(root);
}

function render_presence_canvas(doc) {
  _presence_teardown();
  const wrap = document.createElement('div');
  wrap.className = 'presence-wrap';
  wrap.innerHTML =
    '<div class="presence-banner" hidden></div>'
    + '<div class="presence-stage"><canvas class="presence-canvas"></canvas>'
    + '<div class="presence-badge" hidden></div></div>'
    + '<div class="presence-toolbar">'
    + '<button type="button" class="presence-btn presence-edit-btn">Edit zones</button>'
    + '<button type="button" class="presence-btn presence-ghost presence-reboot" hidden>Reboot device</button>'
    + '<div class="presence-edit-tools" hidden>'
    + '<div class="presence-zone-chips"></div>'
    + '<div class="presence-type-seg"></div>'
    + '<button type="button" class="presence-btn presence-save">Save</button>'
    + '<button type="button" class="presence-btn presence-ghost presence-cancel">Cancel</button>'
    + '<span class="presence-savemsg"></span>'
    + '</div></div>';
  _presence.stage = wrap.querySelector('.presence-stage');
  _presence.canvas = wrap.querySelector('.presence-canvas');
  _presence.ctx = _presence.canvas.getContext('2d');
  _presence.device_id = (doc && doc.subtitle ? String(doc.subtitle).split(' · ')[0] : null);

  wrap.querySelector('.presence-edit-btn').addEventListener('click', _presence_toggle_edit);
  wrap.querySelector('.presence-save').addEventListener('click', _presence_save);
  wrap.querySelector('.presence-cancel').addEventListener('click', _presence_cancel);
  wrap.querySelector('.presence-reboot').addEventListener('click', _presence_reboot);

  // ResizeObserver keeps the backing store crisp; rAF coalesces repaints.
  _presence.ro = new ResizeObserver(() => { _presence_resize(); _presence_request_paint(); });
  _presence.ro.observe(_presence.stage);

  // Pointer editing — down on the canvas, move/up on window so a drag that
  // leaves the canvas still tracks.
  _presence.ptr_down = (e) => _presence_pointerdown(e);
  _presence.ptr_move = (e) => _presence_pointermove(e);
  _presence.ptr_up = () => _presence_pointerup();
  _presence.canvas.addEventListener('pointerdown', _presence.ptr_down);
  window.addEventListener('pointermove', _presence.ptr_move);
  window.addEventListener('pointerup', _presence.ptr_up);

  // Defer first sizing/fetch until the node is in the DOM with a real box.
  requestAnimationFrame(() => { _presence_resize(); _presence_fetch_state(); });
  return wrap;
}

function _presence_teardown() {
  if (_presence.ro) { try { _presence.ro.disconnect(); } catch {} }
  if (_presence.raf) { cancelAnimationFrame(_presence.raf); _presence.raf = 0; }
  if (_presence.canvas && _presence.ptr_down) _presence.canvas.removeEventListener('pointerdown', _presence.ptr_down);
  if (_presence.ptr_move) window.removeEventListener('pointermove', _presence.ptr_move);
  if (_presence.ptr_up) window.removeEventListener('pointerup', _presence.ptr_up);
  _presence.ro = null; _presence.canvas = null; _presence.ctx = null; _presence.stage = null;
  _presence.edit = false; _presence.draft = null; _presence.drag = null;
}

async function _presence_fetch_state() {
  const dev = _presence.device_id;
  try {
    const st = await api(`/api/presence/state${dev ? `?device_id=${encodeURIComponent(dev)}` : ''}`);
    _presence.device_id = st.device_id || dev;
    _presence.config = st.config;
    _presence.connected = !!st.device_connected;
    if (st.snapshot && Array.isArray(st.snapshot.targets)) {
      _presence.targets = st.snapshot.targets.filter((t) => t.active);
    }
    _presence_update_banner();
    _presence_request_paint();
  } catch (err) {
    _presence.connected = false;
    _presence_update_banner(err && err.message);
    _presence_request_paint();
  }
}

function _presence_update_banner(err) {
  const wrap = _presence.stage && _presence.stage.parentElement;
  if (!wrap) return;
  const banner = wrap.querySelector('.presence-banner');
  const editBtn = wrap.querySelector('.presence-edit-btn');
  if (!banner) return;
  if (!_presence.connected) {
    banner.hidden = false;
    banner.textContent = err
      ? `Presence unavailable — ${err}`
      : 'Live presence is owned by Home Assistant right now — the viewer and editor are unavailable until Hearth holds the device.';
    if (editBtn) editBtn.disabled = true;
  } else {
    banner.hidden = true;
    if (editBtn) editBtn.disabled = false;
  }
  // The "Reboot device" button is only meaningful on the tuner path after a
  // write that needs persisting (reboot drops the voice session, so it's an
  // explicit owner action — never automatic).
  const rebootBtn = wrap.querySelector('.presence-reboot');
  if (rebootBtn) rebootBtn.hidden = !(_presence.connected && _presence.config && _presence.config.reboot_required);
  // Status chip (pending / reboot / error) from the config.
  const c = _presence.config;
  const msg = wrap.querySelector('.presence-savemsg');
  if (msg && !_presence.edit && c) {
    if (c.status === 'pending') { msg.textContent = '⟳ change queued'; msg.className = 'presence-savemsg pend'; }
    else if (c.reboot_required) { msg.textContent = '⟳ reboot needed'; msg.className = 'presence-savemsg pend'; }
    else if (c.status === 'error') { msg.textContent = '⚠ last write failed'; msg.className = 'presence-savemsg err'; }
    else { msg.textContent = ''; msg.className = 'presence-savemsg'; }
  }
}

function _presence_resize() {
  if (!_presence.canvas || !_presence.stage) return;
  const dpr = window.devicePixelRatio || 1;
  const w = _presence.stage.clientWidth || 320;
  const h = _presence.stage.clientHeight || 320;
  _presence.canvas.width = Math.round(w * dpr);
  _presence.canvas.height = Math.round(h * dpr);
  _presence.canvas.style.width = w + 'px';
  _presence.canvas.style.height = h + 'px';
  _presence.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function _presence_request_paint() {
  if (_presence.raf || !_presence.ctx) return;
  _presence.raf = requestAnimationFrame(() => { _presence.raf = 0; _presence_draw(); });
}

function _presence_draw() {
  const ctx = _presence.ctx, canvas = _presence.canvas, cfg = _presence.config;
  if (!ctx || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  ctx.clearRect(0, 0, W, H);
  if (!cfg) return;
  const g = _presence_geom(cfg, W, H);
  const dim = !_presence.connected;

  // Range arcs (1..6 m) as cone-clipped polylines, with labels.
  ctx.lineWidth = 1;
  for (let r = 1000; r <= LD2450.RANGE_MM; r += 1000) {
    ctx.beginPath();
    for (let a = -LD2450.FOV_DEG; a <= LD2450.FOV_DEG; a += 4) {
      const rad = (a * Math.PI) / 180;
      const [px, py] = g.mmToPx(r * Math.sin(rad), r * Math.cos(rad));
      if (a === -LD2450.FOV_DEG) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(150,168,186,0.16)';
    ctx.stroke();
    const [lx, ly] = g.mmToPx(0, r);
    ctx.fillStyle = 'rgba(160,175,190,0.5)';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${r / 1000} m`, lx + 3, ly - 3);
  }

  // FOV cone edges.
  ctx.strokeStyle = 'rgba(150,168,186,0.3)';
  ctx.lineWidth = 1.25;
  for (const sgn of [-1, 1]) {
    const rad = (sgn * LD2450.FOV_DEG * Math.PI) / 180;
    const [ex, ey] = g.mmToPx(LD2450.RANGE_MM * Math.sin(rad), LD2450.RANGE_MM * Math.cos(rad));
    ctx.beginPath(); ctx.moveTo(g.apex_x, g.apex_y); ctx.lineTo(ex, ey); ctx.stroke();
  }

  // Zones — draft when editing, else the stored config.
  const zones = _presence.edit && _presence.draft ? _presence.draft : (cfg.zones || []);
  for (const z of zones) _presence_draw_zone(ctx, g, z, dim);

  // Sensor apex marker.
  ctx.fillStyle = dim ? 'rgba(120,135,150,0.7)' : '#8fb3c8';
  ctx.beginPath(); ctx.arc(g.apex_x, g.apex_y, 4.5, 0, Math.PI * 2); ctx.fill();

  // Live target dots (+ trail + speed vector). Greyed when disconnected.
  for (const t of (_presence.targets || [])) {
    if (!t.active) continue;
    const trail = _presence.trails.get(t.index) || [];
    for (let i = 0; i < trail.length; i++) {
      const [tx, ty] = g.mmToPx(trail[i][0], trail[i][1]);
      ctx.globalAlpha = ((i + 1) / (trail.length + 1)) * (dim ? 0.25 : 0.5);
      ctx.fillStyle = dim ? '#8a93a0' : '#5ad0c0';
      ctx.beginPath(); ctx.arc(tx, ty, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const [dx, dy] = g.mmToPx(t.x_mm, t.y_mm);
    // Speed vector — radial from the apex (the stock platform's scalar speed is
    // toward/away), short + clamped.
    if (Math.abs(t.speed_mms) > 30) {
      const ux = dx - g.apex_x, uy = dy - g.apex_y, len = Math.hypot(ux, uy) || 1;
      const mag = _pclamp(Math.abs(t.speed_mms) / 25, 6, 40) * (t.speed_mms < 0 ? -1 : 1);
      ctx.strokeStyle = dim ? 'rgba(140,150,160,0.5)' : 'rgba(90,208,192,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx + (ux / len) * mag, dy + (uy / len) * mag); ctx.stroke();
    }
    ctx.fillStyle = dim ? '#9aa3b0' : '#5ad0c0';
    ctx.shadowColor = dim ? 'transparent' : 'rgba(90,208,192,0.7)';
    ctx.shadowBlur = dim ? 0 : 10;
    ctx.beginPath(); ctx.arc(dx, dy, 6, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
  }

  _presence_update_badge();
}

function _presence_draw_zone(ctx, g, z, dim) {
  const drawn = z.x1_mm !== z.x2_mm && z.y1_mm !== z.y2_mm;
  if (!drawn && z.type === 'Disabled' && !_presence.edit) return;
  const pts = [[z.x1_mm, z.y1_mm], [z.x2_mm, z.y1_mm], [z.x2_mm, z.y2_mm], [z.x1_mm, z.y2_mm]].map(([x, y]) => g.mmToPx(x, y));
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
  const selected = _presence.edit && z.index === _presence.selected;
  if (z.type === 'Filter') {
    ctx.fillStyle = dim ? 'rgba(150,90,90,0.12)' : 'rgba(196,56,56,0.16)';
    ctx.strokeStyle = dim ? 'rgba(150,90,90,0.5)' : 'rgba(196,56,56,0.8)';
  } else if (z.type === 'Detection') {
    ctx.fillStyle = _hex_rgba(z.color || '#5e8aa8', dim ? 0.1 : 0.22);
    ctx.strokeStyle = _hex_rgba(z.color || '#5e8aa8', dim ? 0.5 : 0.9);
  } else {
    ctx.fillStyle = 'rgba(150,150,160,0.06)';
    ctx.strokeStyle = 'rgba(150,150,160,0.35)';
  }
  ctx.lineWidth = selected ? 2.5 : 1.5;
  if (drawn) ctx.fill();
  ctx.setLineDash(z.type === 'Filter' ? [5, 4] : []);
  ctx.stroke();
  ctx.setLineDash([]);
  // Label at the first corner.
  if (drawn) {
    ctx.fillStyle = dim ? 'rgba(200,205,212,0.6)' : 'rgba(225,230,236,0.92)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`${z.name || 'Zone ' + z.index}`, Math.min(pts[0][0], pts[2][0]) + 4, Math.min(pts[0][1], pts[2][1]) + 13);
  }
  // Resize handles on the selected zone (edit mode).
  if (selected) {
    for (const h of _presence_handles(z)) {
      const [hx, hy] = g.mmToPx(h.mx, h.my);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = _hex_rgba(z.color || '#5e8aa8', 1);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(hx - 4, hy - 4, 8, 8); ctx.fill(); ctx.stroke();
    }
  }
}

function _presence_handles(z) {
  const cx = (z.x1_mm + z.x2_mm) / 2, cy = (z.y1_mm + z.y2_mm) / 2;
  return [
    { id: 'x1y1', mx: z.x1_mm, my: z.y1_mm, ax: 'x1_mm', ay: 'y1_mm' },
    { id: 'x2y1', mx: z.x2_mm, my: z.y1_mm, ax: 'x2_mm', ay: 'y1_mm' },
    { id: 'x2y2', mx: z.x2_mm, my: z.y2_mm, ax: 'x2_mm', ay: 'y2_mm' },
    { id: 'x1y2', mx: z.x1_mm, my: z.y2_mm, ax: 'x1_mm', ay: 'y2_mm' },
    { id: 'y1', mx: cx, my: z.y1_mm, ay: 'y1_mm' },
    { id: 'x2', mx: z.x2_mm, my: cy, ax: 'x2_mm' },
    { id: 'y2', mx: cx, my: z.y2_mm, ay: 'y2_mm' },
    { id: 'x1', mx: z.x1_mm, my: cy, ax: 'x1_mm' },
  ];
}

function _hex_rgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return `rgba(94,138,168,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function _presence_update_badge() {
  const wrap = _presence.stage && _presence.stage.parentElement;
  const badge = wrap && wrap.querySelector('.presence-badge');
  if (!badge) return;
  const active = (_presence.targets || []).filter((t) => t.active);
  if (!_presence.connected) { badge.hidden = true; return; }
  badge.hidden = false;
  badge.textContent = active.length ? `${active.length} present` : 'empty';
  badge.className = 'presence-badge' + (active.length ? ' on' : '');
}

// SSE: a republished snapshot updates the live buffer + trails and repaints.
function _presence_on_targets(e) {
  if (!_presence.ctx) return;
  if (_presence.device_id && e.device_id !== _presence.device_id) return;
  _presence.connected = true;
  _presence.targets = (e.targets || []).filter((t) => t.active);
  for (const t of _presence.targets) {
    const arr = _presence.trails.get(t.index) || [];
    arr.push([t.x_mm, t.y_mm]);
    while (arr.length > 6) arr.shift();
    _presence.trails.set(t.index, arr);
  }
  _presence_update_banner();
  _presence_request_paint();
}

function _presence_on_ack(e) {
  if (!_presence.config) return;
  if (_presence.device_id && e.device_id !== _presence.device_id) return;
  const wrap = _presence.stage && _presence.stage.parentElement;
  const msg = wrap && wrap.querySelector('.presence-savemsg');
  _presence.config.status = e.applied ? 'applied' : 'error';
  _presence.config.reboot_required = !!e.reboot_required;
  if (msg) {
    if (!e.applied) { msg.textContent = `⚠ ${e.error || 'apply failed'}`; msg.className = 'presence-savemsg err'; }
    else if (e.reboot_required) { msg.textContent = '⟳ applied — reboot to persist'; msg.className = 'presence-savemsg pend'; }
    else { msg.textContent = '✓ applied'; msg.className = 'presence-savemsg ok'; }
  }
  // Read-back confirms the device's stored rects (the tuner can clamp/round).
  _presence_fetch_state();
}

// ── editor ─────────────────────────────────────────────────────────────────

function _presence_toggle_edit() {
  if (!_presence.connected || !_presence.config) return;
  _presence.edit = !_presence.edit;
  const wrap = _presence.stage.parentElement;
  const tools = wrap.querySelector('.presence-edit-tools');
  const btn = wrap.querySelector('.presence-edit-btn');
  if (_presence.edit) {
    _presence.draft = (_presence.config.zones || []).map((z) => ({ ...z }));
    _presence.selected = (_presence.draft.find((z) => z.type !== 'Disabled') || _presence.draft[0] || { index: 1 }).index;
    tools.hidden = false; btn.textContent = 'Done';
    _presence_render_tools();
  } else {
    _presence.draft = null; _presence.drag = null;
    tools.hidden = true; btn.textContent = 'Edit zones';
    _presence_update_banner();
  }
  _presence_request_paint();
}

function _presence_render_tools() {
  const wrap = _presence.stage.parentElement;
  const chips = wrap.querySelector('.presence-zone-chips');
  const seg = wrap.querySelector('.presence-type-seg');
  chips.innerHTML = '';
  for (const z of (_presence.draft || [])) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'presence-chip' + (z.index === _presence.selected ? ' on' : '');
    b.style.setProperty('--zc', z.color || '#5e8aa8');
    b.textContent = z.name || `Zone ${z.index}`;
    b.addEventListener('click', () => { _presence.selected = z.index; _presence_render_tools(); _presence_request_paint(); });
    chips.appendChild(b);
  }
  seg.innerHTML = '';
  const sel = (_presence.draft || []).find((z) => z.index === _presence.selected);
  for (const t of ZONE_TYPES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'presence-seg-btn' + (sel && sel.type === t ? ' on' : '');
    b.textContent = t;
    b.addEventListener('click', () => _presence_set_type(t));
    seg.appendChild(b);
  }
}

function _presence_set_type(t) {
  const z = (_presence.draft || []).find((x) => x.index === _presence.selected);
  if (!z) return;
  z.type = t;
  // Drawing a fresh zone with zero area? Seed a sensible default rect so the
  // owner has something to grab.
  if (t !== 'Disabled' && z.x1_mm === z.x2_mm && z.y1_mm === z.y2_mm) {
    z.x1_mm = -700; z.x2_mm = 700; z.y1_mm = 800; z.y2_mm = 2400;
  }
  _presence_render_tools();
  _presence_request_paint();
}

function _presence_event_px(e) {
  const r = _presence.canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function _presence_pointerdown(e) {
  if (!_presence.edit || !_presence.draft) return;
  const dpr = window.devicePixelRatio || 1;
  const W = _presence.canvas.width / dpr, H = _presence.canvas.height / dpr;
  const g = _presence_geom(_presence.config, W, H);
  const [px, py] = _presence_event_px(e);
  const sel = _presence.draft.find((z) => z.index === _presence.selected);
  // 1) a handle on the selected zone?
  if (sel) {
    for (const h of _presence_handles(sel)) {
      const [hx, hy] = g.mmToPx(h.mx, h.my);
      if (Math.hypot(px - hx, py - hy) <= 9) {
        _presence.drag = { mode: 'resize', handle: h, zone: sel };
        e.preventDefault(); return;
      }
    }
  }
  // 2) inside a zone body → select + move (test in mm so rotation is undone).
  const [mx, my] = g.pxToMm(px, py);
  const inside = (z) => mx >= Math.min(z.x1_mm, z.x2_mm) && mx <= Math.max(z.x1_mm, z.x2_mm)
    && my >= Math.min(z.y1_mm, z.y2_mm) && my <= Math.max(z.y1_mm, z.y2_mm)
    && z.x1_mm !== z.x2_mm && z.y1_mm !== z.y2_mm;
  let hit = sel && inside(sel) ? sel : _presence.draft.find(inside);
  if (hit) {
    _presence.selected = hit.index;
    _presence.drag = { mode: 'move', zone: hit, startMx: mx, startMy: my, orig: { ...hit } };
    _presence_render_tools();
    e.preventDefault();
  }
}

function _presence_pointermove(e) {
  if (!_presence.drag) return;
  const dpr = window.devicePixelRatio || 1;
  const W = _presence.canvas.width / dpr, H = _presence.canvas.height / dpr;
  const g = _presence_geom(_presence.config, W, H);
  const [px, py] = _presence_event_px(e);
  const [mx, my] = g.pxToMm(px, py);
  const d = _presence.drag, z = d.zone;
  if (d.mode === 'resize') {
    if (d.handle.ax) z[d.handle.ax] = _pclamp_x(_psnap(mx));
    if (d.handle.ay) z[d.handle.ay] = _pclamp_y(_psnap(my));
  } else {
    let ddx = mx - d.startMx, ddy = my - d.startMy;
    // Clamp the translation so the whole rect stays in the legal box.
    const minx = Math.min(d.orig.x1_mm, d.orig.x2_mm), maxx = Math.max(d.orig.x1_mm, d.orig.x2_mm);
    const miny = Math.min(d.orig.y1_mm, d.orig.y2_mm), maxy = Math.max(d.orig.y1_mm, d.orig.y2_mm);
    ddx = _pclamp(ddx, LD2450.X_MIN - minx, LD2450.X_MAX - maxx);
    ddy = _pclamp(ddy, LD2450.Y_MIN - miny, LD2450.Y_MAX - maxy);
    z.x1_mm = _psnap(d.orig.x1_mm + ddx); z.x2_mm = _psnap(d.orig.x2_mm + ddx);
    z.y1_mm = _psnap(d.orig.y1_mm + ddy); z.y2_mm = _psnap(d.orig.y2_mm + ddy);
  }
  _presence_request_paint();
}

function _presence_pointerup() { _presence.drag = null; }

async function _presence_save() {
  if (_presence.saving || !_presence.draft) return;
  _presence.saving = true;
  const wrap = _presence.stage.parentElement;
  const msg = wrap.querySelector('.presence-savemsg');
  msg.textContent = 'saving…'; msg.className = 'presence-savemsg pend';
  const zones = _presence.draft.map((z) => ({
    index: z.index, type: z.type,
    x1_mm: Math.round(z.x1_mm), y1_mm: Math.round(z.y1_mm),
    x2_mm: Math.round(z.x2_mm), y2_mm: Math.round(z.y2_mm),
    name: z.name, color: z.color,
  }));
  try {
    const res = await api('/api/presence/zones', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: _presence.device_id, zones }),
    });
    _presence.config = res.config;
    // Optimistic: keep the dropped rects, exit edit, wait for the ack SSE.
    _presence.edit = false; _presence.draft = null;
    wrap.querySelector('.presence-edit-tools').hidden = true;
    wrap.querySelector('.presence-edit-btn').textContent = 'Edit zones';
    msg.textContent = '⟳ queued — applying on the device'; msg.className = 'presence-savemsg pend';
    _presence_request_paint();
  } catch (err) {
    msg.textContent = 'save failed: ' + ((err && err.message) || err);
    msg.className = 'presence-savemsg err';
  } finally {
    _presence.saving = false;
  }
}

function _presence_cancel() {
  _presence.edit = false; _presence.draft = null; _presence.drag = null;
  const wrap = _presence.stage.parentElement;
  wrap.querySelector('.presence-edit-tools').hidden = true;
  wrap.querySelector('.presence-edit-btn').textContent = 'Edit zones';
  _presence_update_banner();
  _presence_request_paint();
}

// Owner-triggered device reboot — the custom-firmware (tuner) path needs it to
// persist a zone write. It drops the voice session, so it's explicit + confirmed.
async function _presence_reboot() {
  if (!_presence.config) return;
  if (!confirm('Reboot the presence sensor to persist the last zone change?\n\nThis briefly drops the voice session on this device.')) return;
  const wrap = _presence.stage && _presence.stage.parentElement;
  const msg = wrap && wrap.querySelector('.presence-savemsg');
  if (msg) { msg.textContent = 'reboot queued…'; msg.className = 'presence-savemsg pend'; }
  try {
    await api('/api/presence/reboot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: _presence.device_id }),
    });
    toast('Reboot queued — the coordinator will reboot the device.');
    if (msg) { msg.textContent = '⟳ reboot queued'; msg.className = 'presence-savemsg pend'; }
  } catch (err) {
    if (msg) { msg.textContent = 'reboot failed: ' + ((err && err.message) || err); msg.className = 'presence-savemsg err'; }
  }
}

// ── presence ⚙ gear — room calibration + firmware target (owner only) ───────
async function open_presence_settings_modal() {
  const prior = document.getElementById('presence-settings-dynamic');
  if (prior) prior.remove();
  let cfg;
  try {
    const dev = _presence.device_id;
    const st = await api(`/api/presence/settings${dev ? `?device_id=${encodeURIComponent(dev)}` : ''}`);
    cfg = st.config;
  } catch (e) {
    toast('Presence settings: ' + ((e && e.message) || e), true);
    return;
  }
  const modal = document.createElement('div');
  modal.id = 'presence-settings-dynamic';
  modal.className = 'modal modal-codeshop';
  const num = (k, v, label, step) =>
    `<label class="cs-field"><span>${escape_html(label)}</span><input data-k="${k}" type="number" step="${step || 'any'}" value="${escape_html(v == null ? '' : String(v))}"></label>`;
  const text = (k, v, label) =>
    `<label class="cs-field"><span>${escape_html(label)}</span><input data-k="${k}" type="text" value="${escape_html(v == null ? '' : v)}"></label>`;
  const check = (k, v, label) =>
    `<label class="cs-check"><input data-k="${k}" type="checkbox" ${v ? 'checked' : ''}> ${escape_html(label)}</label>`;
  const fw = ['auto', 'entity', 'tuner']
    .map((o) => `<option value="${o}" ${o === cfg.firmware_target ? 'selected' : ''}>${o}</option>`).join('');
  const zonePres = (cfg.zones || []).map((z) =>
    `<div class="cs-zonerow"><input data-zk="name" data-zi="${z.index}" type="text" value="${escape_html(z.name || '')}" placeholder="Zone ${z.index} name">`
    + `<input data-zk="color" data-zi="${z.index}" type="color" value="${escape_html(z.color || '#5e8aa8')}"></div>`).join('');
  modal.innerHTML =
    '<div class="modal-inner cs-inner" role="dialog" aria-modal="true">'
    + '<div class="recon-ops-head"><h3>Presence settings</h3><button type="button" class="iconbtn" data-act="close" aria-label="Close"><span class="icon">✕</span></button></div>'
    + '<p class="modal-sub">Room calibration, sensor mount, and the firmware write path. All in millimeters (the radar frame).</p>'
    + `<div class="cs-sec"><h4>Room</h4>${text('room_name', cfg.room_name, 'Room name')}${num('room_width_mm', cfg.room_width_mm, 'Width (mm)')}${num('room_depth_mm', cfg.room_depth_mm, 'Depth (mm)')}</div>`
    + `<div class="cs-sec"><h4>Sensor mount</h4>${num('mount_x_offset_mm', cfg.mount_x_offset_mm, 'X offset from wall center (mm)')}${num('mount_rotation_deg', cfg.mount_rotation_deg, 'Rotation (deg)')}${num('mount_height_mm', cfg.mount_height_mm, 'Height (mm, informational)')}</div>`
    + `<div class="cs-sec"><h4>Canvas & snapping</h4>${num('px_per_m', cfg.px_per_m, 'Pixels per meter (blank = auto-fit 6 m)')}${num('snap_grid_mm', cfg.snap_grid_mm, 'Snap grid (mm, 0 = off)')}${check('snap_enabled', cfg.snap_enabled, 'Snap to grid while editing')}</div>`
    + `<div class="cs-sec"><h4>Firmware write path</h4><label class="cs-field"><span>firmware target</span><select data-k="firmware_target">${fw}</select></label>`
    + '<p class="cs-hint"><b>entity</b> — stock ESPHome <code>ld2450</code> build: live zone writes, no reboot. <b>tuner</b> — custom <code>satellite1_radar</code> firmware: HTTP tuner + reboot to persist (keeps the on-device tuner). <b>auto</b> — coordinator probes the device and picks.</p></div>'
    + `<div class="cs-sec"><h4>Zone names & colors</h4>${zonePres}</div>`
    + '<div class="cs-actions"><button type="button" class="recon-op-btn cs-save">Save</button><div class="cs-savemsg"></div></div>'
    + '</div>';
  document.body.appendChild(modal);
  document.getElementById('modal-backdrop').hidden = false;
  document.body.classList.add('modal-open');
  state.modal = 'presence-settings-dynamic';
  modal.querySelector('[data-act="close"]').addEventListener('click', close_all_modals);
  modal.querySelector('.cs-save').addEventListener('click', async () => {
    const patch = { device_id: _presence.device_id };
    modal.querySelectorAll('[data-k]').forEach((el) => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') patch[k] = el.checked;
      else if (el.type === 'number') patch[k] = el.value === '' ? (k === 'px_per_m' ? null : undefined) : parseFloat(el.value);
      else patch[k] = el.value;
    });
    const zmap = new Map();
    modal.querySelectorAll('[data-zi]').forEach((el) => {
      const i = parseInt(el.dataset.zi, 10);
      const z = zmap.get(i) || { index: i };
      z[el.dataset.zk] = el.value;
      zmap.set(i, z);
    });
    if (zmap.size) patch.zones = Array.from(zmap.values());
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
    const msg = modal.querySelector('.cs-savemsg');
    try {
      await api('/api/presence/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      msg.textContent = 'Saved ✓'; msg.className = 'cs-savemsg ok';
      toast('Presence settings saved.');
      setTimeout(() => { close_all_modals(); if (state.active_id) load_pane(state.active_id); }, 600);
    } catch (e) {
      msg.textContent = 'Save failed: ' + ((e && e.message) || e); msg.className = 'cs-savemsg err';
    }
  });
}

// Keep the segmented indicator aligned when the viewport reflows.
window.addEventListener('resize', () => {
  const wrap = document.getElementById('surface-toggle');
  if (wrap && !wrap.hidden) _move_seg_indicator();
});

function render_right_rail() {
  right_content.innerHTML = '';
  // Inbox panel appears on EVERY specialist's right rail since any
  // specialist can receive flags / questions / fyi messages. Mounted
  // first so it dominates the visual hierarchy when there's anything
  // unactioned waiting on this specialist.
  right_content.appendChild(render_inbox_panel(state.active_id));
  if (state.active_id === 'kate') {
    right_content.appendChild(render_kate_rail());
  } else {
    right_content.appendChild(render_library_rail(state.active_id));
  }
}

const INBOX_KIND_ICON = {
  flag: '🚩',
  question: '❓',
  fyi: '·',
  consult_response: '↩',
};

const INBOX_KIND_LABEL = {
  flag: 'Flag',
  question: 'Question',
  fyi: 'FYI',
  consult_response: 'Consult reply',
};

/**
 * Render the inbox section for one specialist. Unread first
 * (highlighted), then read-but-not-actioned. Actioned rows are hidden
 * by default; toggle reveals them. Each row shows the from-specialist
 * avatar, kind icon, body preview, age, and inline mark-read /
 * mark-actioned controls.
 */
function render_inbox_panel(specialist_id) {
  const wrap = document.createElement('div');
  wrap.className = 'rail-section inbox-panel';
  wrap.innerHTML = `<h3>Inbox</h3>`;
  const list = document.createElement('div');
  list.id = 'inbox-list';
  list.className = 'inbox-list';
  list.innerHTML = `<div class="rail-empty">Loading…</div>`;
  wrap.appendChild(list);
  load_inbox_list(specialist_id, list);
  return wrap;
}

async function load_inbox_list(specialist_id, container) {
  try {
    const res = await fetch(
      `/api/inbox?to=${encodeURIComponent(specialist_id)}&limit=50`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { messages } = await res.json();
    const unactioned = (messages || []).filter((m) => !m.actioned_at);
    container.innerHTML = '';
    if (unactioned.length === 0) {
      container.innerHTML = `<div class="rail-empty">Nothing pending. Clear inbox.</div>`;
      return;
    }
    // Order: unread first (urgent visual), then read-but-unactioned.
    unactioned.sort((a, b) => {
      if (!!a.read_at !== !!b.read_at) return a.read_at ? 1 : -1;
      return a.ts < b.ts ? 1 : -1;
    });
    for (const m of unactioned) {
      container.appendChild(render_inbox_row(m, specialist_id, container));
    }
  } catch (err) {
    container.innerHTML = `<div class="rail-empty">Inbox load failed: ${escape_html(err.message)}</div>`;
  }
}

function render_inbox_row(m, owner_id, container) {
  const row = document.createElement('div');
  row.className = 'inbox-row';
  if (!m.read_at) row.classList.add('unread');
  row.dataset.id = m.id;

  const header = document.createElement('div');
  header.className = 'inbox-row-header';
  const kind_span = document.createElement('span');
  kind_span.className = 'inbox-row-kind';
  kind_span.title = INBOX_KIND_LABEL[m.kind] || m.kind;
  kind_span.textContent = INBOX_KIND_ICON[m.kind] || '·';
  header.appendChild(kind_span);
  const from_span = document.createElement('span');
  from_span.className = 'inbox-row-from';
  const from_spec = state.by_id.get(m.from_specialist_id);
  from_span.textContent = from_spec ? from_spec.name : m.from_specialist_id;
  header.appendChild(from_span);
  const age = document.createElement('span');
  age.className = 'inbox-row-age';
  age.textContent = relative_time(m.ts);
  age.title = new Date(m.ts).toLocaleString();
  header.appendChild(age);
  row.appendChild(header);

  const body = document.createElement('div');
  body.className = 'inbox-row-body';
  // First line as preview; full text on expand. Preview stays plain
  // (clean truncation) so a half-rendered table/code-block doesn't
  // appear; the expanded full view uses the full markdown renderer.
  const first_line = (m.body_md || '').split('\n')[0] || '(empty)';
  body.textContent = first_line.length > 220 ? first_line.slice(0, 220) + '…' : first_line;
  row.appendChild(body);

  const has_more = (m.body_md || '').length > first_line.length;
  if (has_more) {
    const full = document.createElement('div');
    full.className = 'inbox-row-full markdown-body';
    full.hidden = true;
    full.innerHTML = render_md(m.body_md);
    row.appendChild(full);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'inbox-row-toggle';
    toggle.textContent = '▼ details';
    toggle.addEventListener('click', () => {
      const open = !full.hidden;
      full.hidden = open;
      toggle.textContent = open ? '▼ details' : '▲ collapse';
    });
    row.appendChild(toggle);
  }

  // Inbox messages between specialists are NOT human action items —
  // the recipient specialist marks them read/actioned during her own
  // deliberation pass. Clicking 'mark read' or 'actioned' from the
  // human-facing UI would set those fields on behalf of the
  // specialist and short-circuit her unread_for() query, killing the
  // loop (Beatrice would never see a flag Jasper "helpfully" cleared).
  // So we render state as read-only status here, not as actions.
  const status = document.createElement('div');
  status.className = 'inbox-row-status';
  if (m.actioned_at) {
    status.textContent = `actioned ${_short_ts(m.actioned_at)}`;
    status.classList.add('inbox-row-status-actioned');
  } else if (m.read_at) {
    status.textContent = `read ${_short_ts(m.read_at)} · awaiting action`;
    status.classList.add('inbox-row-status-read');
  } else {
    status.textContent = `unread · awaiting ${m.to_specialist_id}'s deliberation`;
    status.classList.add('inbox-row-status-unread');
  }
  row.appendChild(status);

  return row;
}

function _short_ts(iso) {
  try {
    const d = new Date(iso);
    const mins = Math.round((Date.now() - d.getTime()) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  } catch {
    return iso;
  }
}

async function inbox_post(path) {
  try {
    const res = await fetch(path, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    alert(`Inbox action failed: ${err.message}`);
  }
}

function render_kate_rail() {
  const wrap = document.createElement('div');

  // ── TODAY: latest brief preview ────────────────────────────────────────
  const today_sec = document.createElement('div');
  today_sec.className = 'rail-section';
  today_sec.innerHTML = `<h3>Today</h3><div class="rail-card" id="brief-card">Loading…</div>`;
  wrap.appendChild(today_sec);

  // ── AWAITING YOUR NOD ──────────────────────────────────────────────────
  const queue_sec = document.createElement('div');
  queue_sec.className = 'rail-section';
  queue_sec.innerHTML = `<h3>Awaiting your nod (${state.proposals.length})</h3>`;
  if (state.proposals.length === 0) {
    queue_sec.innerHTML += `<div class="rail-empty">Nothing pending. Kate has things in hand.</div>`;
  } else {
    for (const p of state.proposals.slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'queue-summary-item';
      item.innerHTML = `
        <span>${escape_html(proposal_title(p))}</span>
        <span class="meta">${escape_html(state.by_id.get(p.specialist_id)?.name || p.specialist_id)} · ${relative_time(p.ts_created)}</span>
      `;
      item.addEventListener('click', () => open_queue_modal());
      queue_sec.appendChild(item);
    }
    if (state.proposals.length > 5) {
      const more = document.createElement('div');
      more.style.fontSize = '12px';
      more.style.color = 'var(--accent)';
      more.style.cursor = 'pointer';
      more.style.padding = '4px';
      more.textContent = `See all ${state.proposals.length} →`;
      more.addEventListener('click', () => open_queue_modal());
      queue_sec.appendChild(more);
    }
  }
  wrap.appendChild(queue_sec);

  // ── RECOMMENDATIONS — informational picks from your staff ──────────────
  // Surfaces `recommendation`-kind proposals separately from the
  // gated "Awaiting your nod" queue. These are FYIs (Maggie's concert
  // picks, etc.) — Jasper can save them (approve) or dismiss them
  // (deny), but nothing's blocked on him deciding tonight.
  if (state.recommendations && state.recommendations.length > 0) {
    const recs_sec = document.createElement('div');
    recs_sec.className = 'rail-section';
    recs_sec.innerHTML = `<h3>Recommendations (${state.recommendations.length})</h3>`;
    for (const p of state.recommendations.slice(0, 5)) {
      const item = document.createElement('div');
      item.className = 'queue-summary-item';
      item.innerHTML = `
        <span>${escape_html(proposal_title(p))}</span>
        <span class="meta">${escape_html(state.by_id.get(p.specialist_id)?.name || p.specialist_id)} · ${relative_time(p.ts_created)}</span>
      `;
      item.addEventListener('click', () => open_recommendation_modal(p.id));
      recs_sec.appendChild(item);
    }
    wrap.appendChild(recs_sec);
  }

  // ── FROM YOUR STAFF: live inbox ────────────────────────────────────────
  const staff_sec = document.createElement('div');
  staff_sec.className = 'rail-section';
  staff_sec.innerHTML = `<h3>From your staff</h3><div id="kate-inbox">Loading…</div>`;
  wrap.appendChild(staff_sec);

  // Kick async loads.
  load_brief_into(wrap.querySelector('#brief-card'));
  load_kate_inbox_into(wrap.querySelector('#kate-inbox'));

  return wrap;
}

async function load_brief_into(card) {
  if (!card) return;
  try {
    const { brief } = await api('/api/briefs/latest');
    if (!brief) {
      card.innerHTML = `
        <div style="font-weight: 500; margin-bottom: 4px;">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div>
        <div style="font-size: 12.5px; color: var(--text-muted);">
          Kate's first brief will appear after her next deliberation pass (07:00, 12:30, 18:00, 22:00).
        </div>
      `;
      return;
    }
    card.classList.add(`mood-${brief.mood}`);
    const sec = brief.sections || {};
    const noticed = sec.noticed || '';
    const attention = Array.isArray(sec.attention_today) ? sec.attention_today : [];
    const watching = sec.watching || '';

    card.innerHTML = `
      <div style="font-weight: 500; margin-bottom: 4px;">
        ${escape_html(brief.kind.charAt(0).toUpperCase() + brief.kind.slice(1))} brief
        <span style="color: var(--text-muted); font-weight: normal; font-size: 12px;"> · ${relative_time(brief.ts_generated)}</span>
      </div>
      ${noticed ? `<div style="font-size: 13px; margin-bottom: 8px;">${escape_html(noticed)}</div>` : ''}
      <div id="brief-attention"></div>
      <div id="brief-questions"></div>
      ${watching ? `<div style="font-size: 12px; color: var(--text-muted); margin-top: 8px; font-style: italic;">Watching: ${escape_html(watching)}</div>` : ''}
      <div style="margin-top: 10px;">
        <button class="btn" id="brief-mark-consumed">Mark read</button>
      </div>
    `;

    // Inline present_questions forms attached to this brief — Kate's
    // way of asking 2-3 explicit choices instead of monologuing
    // implicit decisions in attention_today.
    const q_el = card.querySelector('#brief-questions');
    const sets = Array.isArray(brief.pending_question_sets) ? brief.pending_question_sets : [];
    for (const set of sets) {
      if (set.status !== 'pending') continue;
      q_el.appendChild(build_question_form_card(set));
    }

    const att_el = card.querySelector('#brief-attention');
    for (const a of attention) {
      const item = document.createElement('div');
      item.className = 'brief-attention-item';
      item.style.padding = '6px 0';
      item.style.borderTop = '1px solid var(--border)';
      // `urgency` is the attention tier (how soon to act), NOT the event
      // date. Every item here is by definition today's attention (the
      // section is `attention_today`, under a "TODAY'S BRIEF" header) and
      // the envelope defaults urgency to 'today' — so rendering it stamps a
      // redundant, date-looking "today" on every row, which collides with
      // the calendar-framed titles ("Thursday: …"). Surface only the tiers
      // that actually differ: `now` and `this_week`; suppress `today`.
      const urgency_label =
        a.urgency === 'now' ? 'now' : a.urgency === 'this_week' ? 'this week' : '';
      item.innerHTML = `
        <div style="font-size: 13px; font-weight: 500;">${escape_html(a.title || '')}${
          urgency_label
            ? `<span style="font-size: 11px; color: var(--text-muted); font-weight: normal;"> · ${escape_html(urgency_label)}</span>`
            : ''
        }</div>
        <div style="font-size: 12px; color: var(--text-muted);">${escape_html(a.body || '')}</div>
      `;
      if (a.source_specialist_id) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => switch_specialist(a.source_specialist_id));
      }
      att_el.appendChild(item);
    }

    card.querySelector('#brief-mark-consumed')?.addEventListener('click', async () => {
      try {
        await api(`/api/briefs/${brief.id}/consumed`, { method: 'POST' });
        toast('Brief marked read.', false);
        // Optimistic clear — re-render the right rail so the brief
        // is replaced by the "next brief at <slot>" placeholder. With
        // /api/briefs/latest now filtering consumed by default, the
        // re-fetch returns null and the placeholder branch fires.
        if (state.active_id === 'kate') render_right_rail();
      } catch (err) {
        toast(`Failed: ${err.message}`, true);
      }
    });
  } catch (err) {
    card.innerHTML = `<div class="rail-empty">Failed to load brief: ${escape_html(err.message)}</div>`;
  }
}

async function load_kate_inbox_into(container) {
  if (!container) return;
  try {
    const { messages } = await api('/api/inbox?to=kate&unread_only=1&limit=10');
    // Cross-specialist inbox entries (flag/question/fyi/consult_response)
    // are not user-conversation messages — the body IS the content. Render
    // the body inline; don't navigate anywhere. Skip blank bodies as a
    // defensive guard against any producer that bypasses consult()'s
    // synthesized diagnostic.
    const renderable = (messages ?? []).filter(
      (m) => (m.body_md ?? '').trim().length > 0,
    );
    if (renderable.length === 0) {
      container.innerHTML = `<div class="rail-empty">No unread flags from the team.</div>`;
      return;
    }
    container.innerHTML = '';
    const PREVIEW_CHARS = 140;
    for (const m of renderable) {
      const row = document.createElement('div');
      row.className = 'inbox-item';
      row.style.padding = '8px 6px';
      row.style.borderTop = '1px solid var(--border)';
      const from = state.by_id.get(m.from_specialist_id);
      const sev_icon = m.kind === 'flag' ? '⚠' : '·';
      const kind_label =
        m.kind === 'flag'
          ? 'flag'
          : m.kind === 'question'
            ? 'asked'
            : m.kind === 'consult_response'
              ? 'replied'
              : 'fyi';
      const body = m.body_md;
      const needs_expand = body.length > PREVIEW_CHARS;
      const preview = needs_expand ? body.slice(0, PREVIEW_CHARS) + '…' : body;
      row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 6px; font-size: 13px;">
          <img src="/app/api/avatars/${m.from_specialist_id}" alt="" style="width: 20px; height: 20px; border-radius: 50%;"/>
          <span style="font-weight: 500;">${escape_html((from && from.name) || m.from_specialist_id)}</span>
          <span style="color: var(--text-muted); font-size: 11px;">${sev_icon} ${kind_label}${m.to_specialist_id && m.to_specialist_id !== 'kate' ? ` → ${escape_html(state.by_id.get(m.to_specialist_id)?.name || m.to_specialist_id)}` : ''}</span>
          <span style="margin-left: auto; font-size: 11px; color: var(--text-muted);">${relative_time(m.ts)}</span>
        </div>
        <div class="inbox-body" style="font-size: 12.5px; margin-top: 4px; white-space: pre-wrap;">${escape_html(preview)}</div>
        <div style="margin-top: 6px; display: flex; gap: 6px;">
          ${needs_expand ? `<button class="btn-link" data-action="expand">Show full</button>` : ''}
          <button class="btn-link" data-action="dismiss" data-id="${m.id}">Dismiss</button>
        </div>
      `;
      const body_el = row.querySelector('.inbox-body');
      const expand_btn = row.querySelector('[data-action="expand"]');
      let expanded = false;
      expand_btn?.addEventListener('click', () => {
        expanded = !expanded;
        body_el.textContent = expanded ? body : preview;
        expand_btn.textContent = expanded ? 'Show less' : 'Show full';
      });
      row.querySelector('[data-action="dismiss"]')?.addEventListener('click', async () => {
        try {
          await api(`/api/inbox/${m.id}/mark_read`, { method: 'POST' });
          row.remove();
          if (container.children.length === 0) {
            container.innerHTML = `<div class="rail-empty">No unread flags from the team.</div>`;
          }
        } catch (err) {
          toast(`Failed: ${err.message}`, true);
        }
      });
      container.appendChild(row);
    }
  } catch (err) {
    container.innerHTML = `<div class="rail-empty">Failed to load inbox: ${escape_html(err.message)}</div>`;
  }
}

function render_library_rail(specialist_id) {
  const spec = state.by_id.get(specialist_id);
  if (!spec) return document.createElement('div');
  const wrap = document.createElement('div');

  const lib = document.createElement('div');
  lib.className = 'rail-section';
  lib.innerHTML = `<h3>${escape_html(spec.name)}'s library</h3>`;

  const drop = document.createElement('div');
  drop.className = 'library-drop';
  drop.innerHTML = `
    <strong>Drop files here</strong>
    <small>PDF, DOCX, MD, TXT, images, or URLs</small>
    <input type="file" id="library-file" accept=".pdf,.docx,.html,.htm,.md,.txt,.png,.jpg,.jpeg,.gif,.webp"/>
  `;
  const file_input = drop.querySelector('input');
  drop.addEventListener('click', () => file_input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    if (e.dataTransfer.files.length > 0) upload_library_file(e.dataTransfer.files[0], specialist_id);
  });
  file_input.addEventListener('change', () => {
    if (file_input.files.length > 0) upload_library_file(file_input.files[0], specialist_id);
  });
  lib.appendChild(drop);

  const url_row = document.createElement('div');
  url_row.className = 'library-url-row';
  url_row.innerHTML = `<input type="url" placeholder="https://…"/><button>Add</button>`;
  const url_input = url_row.querySelector('input');
  const url_btn = url_row.querySelector('button');
  const submit_url = async () => {
    const url = url_input.value.trim();
    if (!url) return;
    url_btn.disabled = true;
    try {
      await upload_library_url(url, specialist_id);
      url_input.value = '';
    } finally {
      url_btn.disabled = false;
    }
  };
  url_btn.addEventListener('click', submit_url);
  url_input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit_url(); });
  lib.appendChild(url_row);

  const list = document.createElement('div');
  list.id = 'library-list';
  list.innerHTML = `<div class="rail-empty">Loading…</div>`;
  lib.appendChild(list);
  wrap.appendChild(lib);

  load_library_list(specialist_id, list);
  return wrap;
}

function _phase_status_text(phase, detail, error) {
  switch (phase) {
    case 'queued': return 'queued…';
    case 'received': return `received${detail ? ` (${detail})` : ''}…`;
    case 'converting': return 'parsing & extracting text…';
    case 'summarizing': return detail || 'summarizing…';
    case 'indexing': return 'writing note and indexing…';
    case 'acknowledging': return detail || 'specialist acknowledging…';
    case 'done': return 'done';
    case 'failed': return error ? `failed: ${error}` : 'failed';
    default: return phase;
  }
}

async function load_library_list(specialist_id, container) {
  try {
    const { items } = await api(`/app/api/library/${specialist_id}?limit=30`);

    // Render in-flight uploads first (ghost rows with italic status).
    const pending = Array.from(state.pending_uploads?.values?.() ?? []).filter(
      (u) => u.specialist_id === specialist_id && u.phase !== 'done',
    );

    if ((!items || items.length === 0) && pending.length === 0) {
      container.innerHTML = `<div class="rail-empty">No library items yet. Drop a file above.</div>`;
      return;
    }
    container.innerHTML = '';

    for (const p of pending) {
      const row = document.createElement('div');
      row.className = `library-item pending phase-${p.phase}`;
      row.innerHTML = `
        <div class="library-item-title">${escape_html(p.filename)}</div>
        <div class="library-item-meta library-item-progress"><em>${escape_html(_phase_status_text(p.phase, p.detail, p.error))}</em></div>
      `;
      container.appendChild(row);
    }

    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'library-item library-item-clickable';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      // Tap/click the row (anywhere but the action cluster) to open the
      // fullscreen detail viewer. Keyboard parity via Enter/Space.
      row.addEventListener('click', () => open_library_detail(specialist_id, it));
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open_library_detail(specialist_id, it);
        }
      });

      const title_el = document.createElement('div');
      title_el.className = 'library-item-title';
      title_el.textContent = it.title;
      row.appendChild(title_el);

      if (it.summary) {
        const sum = document.createElement('div');
        sum.className = 'library-item-summary';
        sum.textContent = it.summary;
        row.appendChild(sum);
      }

      const meta = document.createElement('div');
      meta.className = 'library-item-meta';
      const kind_span = document.createElement('span');
      kind_span.className = 'library-item-kind';
      kind_span.textContent = it.kind;
      meta.appendChild(kind_span);
      const date_span = document.createElement('span');
      date_span.textContent = relative_time(it.captured_at);
      date_span.title = new Date(it.captured_at).toLocaleString();
      meta.appendChild(date_span);
      if (it.source_url) {
        const src = document.createElement('a');
        src.className = 'library-item-source';
        src.href = it.source_url;
        src.target = '_blank';
        src.rel = 'noopener';
        // Don't let following the source link also open the detail viewer.
        src.addEventListener('click', (ev) => ev.stopPropagation());
        try {
          src.textContent = new URL(it.source_url).hostname.replace(/^www\./, '');
        } catch {
          src.textContent = 'source';
        }
        meta.appendChild(src);
      }
      row.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'library-item-actions';
      // Clicks inside the action cluster (open-attachment / delete) must
      // not also trigger the row's open-detail handler.
      actions.addEventListener('click', (ev) => ev.stopPropagation());
      if (it.attachment_path) {
        // Extract just the filename portion (the attachment-serve
        // route enforces scoping internally via specialist_id).
        const att_name = it.attachment_path.split('/').pop() || '';
        if (att_name) {
          const open_att = document.createElement('a');
          open_att.className = 'library-item-action';
          open_att.href = `/app/api/library/${specialist_id}/attachments/${encodeURIComponent(att_name)}`;
          open_att.target = '_blank';
          open_att.rel = 'noopener';
          open_att.title = 'Open attachment';
          open_att.textContent = '📎';
          actions.appendChild(open_att);
        }
      }
      const del = document.createElement('button');
      del.className = 'library-item-action library-item-delete';
      del.type = 'button';
      del.title = 'Delete this entry';
      del.textContent = '🗑';
      del.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!confirm(`Delete "${it.title}" from ${specialist_id}'s library? This removes the note, the attachment, and the search index entries.`)) {
          return;
        }
        try {
          const res = await fetch(
            `/app/api/library/${specialist_id}/${encodeURIComponent(it.filename)}`,
            { method: 'DELETE' },
          );
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || `HTTP ${res.status}`);
          }
          row.remove();
        } catch (err) {
          alert(`Delete failed: ${err.message}`);
        }
      });
      actions.appendChild(del);
      row.appendChild(actions);

      container.appendChild(row);
    }
  } catch (err) {
    container.innerHTML = `<div class="rail-empty">Failed to load library: ${escape_html(err.message)}</div>`;
  }
}

// ── Library item detail viewer ───────────────────────────────────────────
//
// Tapping a library row opens a fullscreen modal. We open optimistically
// with the title/summary we already have, then fetch the full body
// (`/body` returns the list-item shape + raw markdown) and render a
// kind-aware hero: inline image, embedded PDF, or rendered markdown.

async function open_library_detail(specialist_id, it) {
  open_modal('modal-library');
  const title_el = document.getElementById('library-detail-title');
  const body_el = document.getElementById('library-detail-body');
  const open_link = document.getElementById('library-detail-open');
  title_el.textContent = it.title || it.filename || 'Library item';
  open_link.hidden = true;
  body_el.innerHTML = '<div class="library-detail-loading">Loading…</div>';
  // Remember which item is showing so a late-returning fetch from a
  // previous open doesn't clobber a newer one.
  const token = (state._library_detail_token = (state._library_detail_token || 0) + 1);
  try {
    const full = await api(
      `/app/api/library/${specialist_id}/${encodeURIComponent(it.filename)}/body`,
    );
    if (token !== state._library_detail_token) return;
    render_library_detail(specialist_id, full, body_el, open_link);
  } catch (err) {
    if (token !== state._library_detail_token) return;
    body_el.innerHTML = `<div class="library-detail-error">Failed to load: ${escape_html(err.message)}</div>`;
  }
}

function render_library_detail(specialist_id, item, body_el, open_link) {
  body_el.innerHTML = '';

  const att_name = item.attachment_path ? item.attachment_path.split('/').pop() : null;
  const att_url = att_name
    ? `/app/api/library/${specialist_id}/attachments/${encodeURIComponent(att_name)}`
    : null;
  const ext = att_name ? (att_name.split('.').pop() || '').toLowerCase() : '';
  const is_image =
    item.kind === 'image' || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
  const is_pdf = item.kind === 'pdf' || ext === 'pdf';

  // Meta row: kind badge · date · source link.
  const meta = document.createElement('div');
  meta.className = 'library-detail-meta';
  const kind_span = document.createElement('span');
  kind_span.className = 'library-item-kind';
  kind_span.textContent = item.kind || 'other';
  meta.appendChild(kind_span);
  if (item.captured_at) {
    const date_span = document.createElement('span');
    date_span.textContent = relative_time(item.captured_at);
    date_span.title = new Date(item.captured_at).toLocaleString();
    meta.appendChild(date_span);
  }
  if (item.source_url) {
    const src = document.createElement('a');
    src.className = 'library-item-source';
    src.href = item.source_url;
    src.target = '_blank';
    src.rel = 'noopener';
    try {
      src.textContent = new URL(item.source_url).hostname.replace(/^www\./, '');
    } catch {
      src.textContent = 'source';
    }
    meta.appendChild(src);
  }
  body_el.appendChild(meta);

  // Summary blurb (the glanceable one-liner), when present.
  if (item.summary) {
    const sum = document.createElement('div');
    sum.className = 'library-detail-summary';
    sum.textContent = item.summary;
    body_el.appendChild(sum);
  }

  // Header "open in new tab" affordance points at the raw asset when
  // there's a renderable attachment, else stays hidden.
  if (att_url && (is_image || is_pdf)) {
    open_link.href = att_url;
    open_link.hidden = false;
  } else {
    open_link.hidden = true;
  }

  // Kind-aware hero.
  if (is_image && att_url) {
    const fig = document.createElement('a');
    fig.className = 'library-detail-image-wrap';
    fig.href = att_url;
    fig.target = '_blank';
    fig.rel = 'noopener';
    fig.title = 'Open full size';
    const img = document.createElement('img');
    img.className = 'library-detail-image';
    img.src = att_url;
    img.alt = item.title || '';
    fig.appendChild(img);
    body_el.appendChild(fig);
  } else if (is_pdf && att_url) {
    const frame = document.createElement('iframe');
    frame.className = 'library-detail-pdf';
    frame.src = att_url;
    frame.title = item.title || 'PDF';
    body_el.appendChild(frame);
  } else if (item.body && item.body.trim()) {
    const md = document.createElement('div');
    md.className = 'library-detail-md markdown-body';
    md.innerHTML = render_md(item.body);
    enhance_code_blocks(md);
    body_el.appendChild(md);
  } else if (att_url) {
    // A non-previewable attachment (e.g. a binary doc) — offer to open it.
    const card = document.createElement('a');
    card.className = 'library-detail-download';
    card.href = att_url;
    card.target = '_blank';
    card.rel = 'noopener';
    card.textContent = `📎 Open ${att_name}`;
    body_el.appendChild(card);
  } else {
    const empty = document.createElement('div');
    empty.className = 'library-detail-error';
    empty.textContent = 'Nothing to preview for this item.';
    body_el.appendChild(empty);
  }
}

async function upload_library_file(file, specialist_id) {
  // Generate an upload_id so the server's progress events match up
  // with our ghost row. Plain ULID-ish — Math.random is fine for a
  // session-scoped correlation.
  const upload_id =
    'u_' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  // Optimistically render the ghost row immediately so the user has
  // feedback before the network round-trips start.
  state.pending_uploads = state.pending_uploads || new Map();
  state.pending_uploads.set(upload_id, {
    upload_id,
    specialist_id,
    filename: file.name,
    phase: 'queued',
    detail: `${(file.size / 1024).toFixed(0)} KB`,
    started_ms: Date.now(),
  });
  if (specialist_id === state.active_id) render_right_rail();

  const form = new FormData();
  form.append('file', file);
  form.append('specialist_id', specialist_id);
  form.append('acknowledge', state.settings.ack_library ? 'true' : 'false');
  form.append('upload_id', upload_id);
  try {
    const res = await fetch('/app/api/library/upload', { method: 'POST', body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    // Server's final `done` SSE event will clear the ghost row; defensive
    // cleanup after a short delay in case the SSE was dropped.
    setTimeout(() => {
      if (state.pending_uploads?.has(upload_id)) {
        state.pending_uploads.delete(upload_id);
        if (specialist_id === state.active_id) render_right_rail();
      }
    }, 1500);
    render_right_rail();
    if (json.acknowledged && state.conv_id) await load_messages(state.conv_id);
  } catch (err) {
    // Mark the ghost row as failed; let it linger 5s so the user sees the error.
    if (state.pending_uploads?.has(upload_id)) {
      const cur = state.pending_uploads.get(upload_id);
      cur.phase = 'failed';
      cur.error = err.message;
      state.pending_uploads.set(upload_id, cur);
      if (specialist_id === state.active_id) render_right_rail();
      setTimeout(() => {
        state.pending_uploads.delete(upload_id);
        if (specialist_id === state.active_id) render_right_rail();
      }, 5000);
    }
    toast(`Failed to add: ${err.message}`, true);
  }
}

// Send an image through the CAPTURE pipeline (Cordelia classifies + routes —
// e.g. an item staged for resale goes to Linda, who then looks at it and asks
// the seller for facts via present_questions). This is the right path for "an
// item to act on," distinct from the library (reference documents). A burst of
// captures sent together clusters server-side into ONE item, so multi-select
// of an item's photos becomes a single listing.
async function send_capture(file, note) {
  const form = new FormData();
  form.append('artifact', file);
  form.append('kind', 'photo');
  form.append('capturedAt', new Date().toISOString());
  if (note) form.append('note', note);
  form.append('metadata', JSON.stringify({ local_classification_hint: 'scene' }));
  const res = await fetch('/api/cordelia/capture', { method: 'POST', body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function upload_library_url(url, specialist_id) {
  toast(`Fetching ${url}…`);
  try {
    const json = await api('/app/api/library/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, specialist_id, acknowledge: state.settings.ack_library }),
    });
    toast(`✓ Added: ${json.title}`);
    render_right_rail();
    if (json.acknowledged && state.conv_id) await load_messages(state.conv_id);
  } catch (err) {
    toast(`Failed to add: ${err.message}`, true);
  }
}

// ── Composer / send ─────────────────────────────────────────────────────

composer_input.addEventListener('input', auto_resize_composer);
function auto_resize_composer() {
  composer_input.style.height = 'auto';
  composer_input.style.height = Math.min(240, composer_input.scrollHeight) + 'px';
}

// ── Composer autocomplete ──────────────────────────────────────────────
//
// Discord-style popup. Two trigger characters:
//   @  → match against specialist names (commit switches the active
//        specialist; the @token is removed from the input).
//   /  → match against client-side commands (/files, /queue, /search,
//        /new, /settings) plus every specialist's slash alias from
//        /api/users/specialist_aliases. Commit fires the action and
//        clears the slash from the input.
//
// Triggers fire only when the character begins a fresh token (start of
// input or after whitespace) — typing "foo@bar" is an email, not a
// mention.

let _alias_map = null; // Record<alias-without-slash, specialist_id>
async function ensure_alias_map() {
  if (_alias_map) return _alias_map;
  try {
    const j = await api('/api/users/specialist_aliases');
    _alias_map = (j && j.map) || {};
  } catch {
    _alias_map = {};
  }
  return _alias_map;
}

const SLASH_ACTIONS = [
  { cmd: 'new', label: '/new', hint: 'Start a fresh conversation', run: () => start_new_conversation() },
  { cmd: 'queue', label: '/queue', hint: 'Open the approval queue', run: () => open_queue_modal() },
  { cmd: 'search', label: '/search', hint: 'Search chat, vault, proposals', run: () => {
    open_modal('modal-search');
    search_input.value = '';
    search_results.innerHTML = '';
    setTimeout(() => search_input.focus(), 20);
  }},
  { cmd: 'files', label: '/files', hint: 'Open the library', run: () => { window.location.href = '/files'; } },
  { cmd: 'settings', label: '/settings', hint: 'Open settings', run: () => open_settings() },
];

const ac = {
  open: false,
  mode: null, // 'at' | 'slash'
  query: '',
  token_start: -1, // index in textarea where the trigger char sits
  items: [],
  selected: 0,
  el: null,
};

function _ensure_ac_el() {
  if (ac.el) return ac.el;
  ac.el = document.createElement('div');
  ac.el.className = 'composer-autocomplete';
  ac.el.hidden = true;
  // Anchor it just above the composer; CSS handles positioning.
  const composer = composer_input.parentElement;
  composer.insertBefore(ac.el, composer.firstChild);
  return ac.el;
}

function close_autocomplete() {
  ac.open = false;
  ac.items = [];
  ac.query = '';
  ac.mode = null;
  ac.token_start = -1;
  ac.selected = 0;
  if (ac.el) ac.el.hidden = true;
}

function _detect_trigger() {
  const cursor = composer_input.selectionStart || 0;
  const before = composer_input.value.slice(0, cursor);
  // Walk back to find the trigger char on this token. The token is
  // bounded by whitespace or the start of input. If anything other
  // than [a-z0-9_-] sits between the trigger and the cursor, the
  // trigger doesn't apply.
  const m = before.match(/(^|\s)([@/])([\w-]*)$/);
  if (!m) return null;
  const trigger_char = m[2];
  const query = m[3];
  // token_start is the index of the trigger char itself.
  const token_start = before.length - query.length - 1;
  return { mode: trigger_char === '@' ? 'at' : 'slash', query, token_start };
}

async function _refresh_autocomplete() {
  const trig = _detect_trigger();
  if (!trig) {
    close_autocomplete();
    return;
  }
  ac.mode = trig.mode;
  ac.query = trig.query.toLowerCase();
  ac.token_start = trig.token_start;

  if (trig.mode === 'at') {
    // Specialist name fuzzy match. Rank by prefix match, then substring.
    const q = ac.query;
    const items = [];
    for (const s of state.specialists) {
      const name = (s.name || '').toLowerCase();
      const id = (s.id || '').toLowerCase();
      let score = 0;
      if (!q) score = 1;
      else if (name.startsWith(q) || id.startsWith(q)) score = 3;
      else if (name.includes(q) || id.includes(q)) score = 1;
      if (score > 0) {
        items.push({
          score,
          id: s.id,
          label: s.name,
          hint: s.role || '',
          avatar: `/app/api/avatars/${s.id}`,
          run: () => switch_specialist(s.id),
        });
      }
    }
    items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    ac.items = items.slice(0, 6);
  } else {
    // Slash: client actions + specialist aliases. Specialist aliases
    // are 1-letter or full-name shortcuts that switch the active
    // specialist (same outcome as @<name>, but feels native to the
    // user who types `/kate` from muscle memory).
    const q = ac.query;
    const items = [];
    for (const a of SLASH_ACTIONS) {
      if (!q || a.cmd.startsWith(q)) {
        items.push({
          score: a.cmd === q ? 4 : a.cmd.startsWith(q) ? 3 : 1,
          id: a.cmd,
          label: a.label,
          hint: a.hint,
          avatar: null,
          run: a.run,
        });
      }
    }
    const aliases = await ensure_alias_map();
    for (const [alias, sid] of Object.entries(aliases)) {
      // alias may already include the leading slash; normalize.
      const bare = alias.replace(/^\//, '');
      if (q && !bare.startsWith(q)) continue;
      const spec = state.by_id.get(sid);
      if (!spec) continue;
      items.push({
        score: bare === q ? 4 : bare.startsWith(q) ? 2 : 1,
        id: bare,
        label: '/' + bare,
        hint: `Talk to ${spec.name}`,
        avatar: `/app/api/avatars/${sid}`,
        run: () => switch_specialist(sid),
      });
    }
    items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    ac.items = items.slice(0, 8);
  }

  if (ac.items.length === 0) {
    close_autocomplete();
    return;
  }
  ac.selected = Math.min(ac.selected, ac.items.length - 1);
  ac.open = true;
  _render_autocomplete();
}

function _render_autocomplete() {
  const el = _ensure_ac_el();
  if (!ac.open) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = '';
  ac.items.forEach((it, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'composer-autocomplete-row' + (i === ac.selected ? ' selected' : '');
    if (it.avatar) {
      const av = document.createElement('img');
      av.className = 'composer-autocomplete-avatar';
      av.src = it.avatar;
      av.alt = '';
      row.appendChild(av);
    } else {
      const ph = document.createElement('span');
      ph.className = 'composer-autocomplete-glyph';
      ph.textContent = '/';
      row.appendChild(ph);
    }
    const main = document.createElement('span');
    main.className = 'composer-autocomplete-main';
    const lab = document.createElement('span');
    lab.className = 'composer-autocomplete-label';
    lab.textContent = it.label;
    main.appendChild(lab);
    if (it.hint) {
      const hint = document.createElement('span');
      hint.className = 'composer-autocomplete-hint';
      hint.textContent = it.hint;
      main.appendChild(hint);
    }
    row.appendChild(main);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep composer focus
      _commit_autocomplete(i);
    });
    el.appendChild(row);
  });
}

function _commit_autocomplete(idx) {
  if (!ac.open || !ac.items[idx]) return;
  const item = ac.items[idx];
  // Strip the @token / /token from the composer. Everything from the
  // trigger char to the cursor disappears; the rest stays as-is for
  // the user to keep typing into.
  const cursor = composer_input.selectionStart || 0;
  const before = composer_input.value.slice(0, ac.token_start);
  const after = composer_input.value.slice(cursor);
  // Trim a leading space remnant so we don't leave "foo  bar".
  const stitched = (before + after).replace(/[ \t]{2,}/g, ' ');
  composer_input.value = stitched.trimStart();
  const new_pos = composer_input.value.length === 0 ? 0 : before.replace(/[ \t]+$/, '').length;
  composer_input.setSelectionRange(new_pos, new_pos);
  auto_resize_composer();
  close_autocomplete();
  try {
    item.run();
  } catch (err) {
    console.error('autocomplete commit failed', err);
  }
}

composer_input.addEventListener('input', () => {
  // Fire-and-forget — _refresh handles its own close path.
  _refresh_autocomplete();
});
composer_input.addEventListener('blur', () => {
  // Allow click on a row (which uses mousedown.preventDefault) before
  // collapsing; otherwise tap-to-pick on mobile fails.
  setTimeout(close_autocomplete, 120);
});

composer_input.addEventListener('keydown', (e) => {
  // Autocomplete navigation hijacks the keys when open.
  if (ac.open) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      ac.selected = (ac.selected + 1) % ac.items.length;
      _render_autocomplete();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      ac.selected = (ac.selected - 1 + ac.items.length) % ac.items.length;
      _render_autocomplete();
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      e.preventDefault();
      _commit_autocomplete(ac.selected);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close_autocomplete();
      return;
    }
  }
  // Enter sends; Shift+Enter / Cmd+Enter / Ctrl+Enter inserts a newline.
  if (e.key !== 'Enter') return;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  send_current();
});

send_btn.addEventListener('click', send_current);

// ── Stop button ──────────────────────────────────────────────────────────
//
// Visible while a specialist turn is in flight for the active
// conversation (toggled by specialist_thinking SSE events in
// handle_sse_event below). Click posts a cancel that aborts the
// runtime's AbortController on the server — the in-flight Ollama
// request is cut at the socket, the runtime writes "(stopped)", and
// the normal message_added event lands the bubble.
async function cancel_current_turn() {
  if (!state.conv_id) return;
  stop_btn.disabled = true;
  try {
    await api(`/api/conversations/${state.conv_id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (err) {
    toast(`Stop failed: ${err.message}`, true);
  } finally {
    stop_btn.disabled = false;
  }
}
stop_btn.addEventListener('click', cancel_current_turn);

function show_stop(visible) {
  stop_btn.hidden = !visible;
  send_btn.hidden = !!visible;
}

async function send_current() {
  const content = composer_input.value.trim();
  if (!content || !state.conv_id) return;
  composer_input.value = '';
  auto_resize_composer();
  // Sending a new message means the user wants to see the result —
  // re-pin to bottom regardless of where they were reading. Also
  // clear the "New messages" divider for this conv: by typing into
  // the thread the user has demonstrably caught up.
  sticky.pinned = true;
  state.unread_markers.delete(state.conv_id);
  // Optimistic user message.
  state.messages.push({
    id: `local-${Date.now()}`,
    role: 'user',
    content_md: content,
    ts: new Date().toISOString(),
    tool_calls_json: null,
    proposals_created_json: null,
    reasoning_trace_md: null,
    specialist_id: null,
  });
  render_messages();
  send_btn.disabled = true;
  try {
    await api(`/api/conversations/${state.conv_id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    await load_messages(state.conv_id);
    await refresh_proposals();
  } catch (err) {
    toast(`Send failed: ${err.message}`, true);
  } finally {
    send_btn.disabled = false;
    composer_input.focus();
  }
}

// ── Agent Rooms — multi-specialist group chat (owner-only) ─────────────────
// A room is a shared thread several specialists speak into. Per owner message
// an arbiter (or an @-address) picks 1-2 speakers who riff off each other.
// This surface is SSE-PUSH: the owner's message, each agent reply, and the
// turn started/done signals all arrive on the existing /app/api/events stream
// (handled in handle_sse_event) — nothing here polls. The thread reuses
// render_message() so every speaker gets their avatar + name + hue, and
// messages are always SORTED BY ts (GET array order isn't trustworthy).

function _rooms_state() {
  if (!state.rooms) {
    state.rooms = {
      list: [],          // RoomSummary[] from GET /api/rooms
      active_id: null,   // the open room's conversation id
      detail: null,      // { room_id, title, participant_ids, turn_in_flight, messages[] }
      creating: false,   // is the create-room form showing
      create_sel: new Set(), // selected participant ids in the create form
      addressed: '',     // @-addressed participant id for the next send ('' = arbiter)
      typing: new Map(), // specialist_id → name currently generating ("X is typing…")
    };
  }
  return state.rooms;
}

// A room id is `conversation_id` in the list payload but `room_id` in the
// create/detail payloads — normalize.
function _room_id_of(r) {
  return (r && (r.room_id || r.conversation_id || r.id)) || null;
}

let _rooms_css_injected = false;
function rooms_inject_css() {
  if (_rooms_css_injected) return;
  _rooms_css_injected = true;
  const css = `
.modal-inner-rooms{ width:min(1060px,95vw); max-width:1060px; height:min(84vh,820px);
  display:flex; flex-direction:column; padding:0; overflow:hidden; }
.modal-inner-rooms .modal-header{ padding:14px 18px; margin:0; }
.rooms-layout{ display:flex; flex:1; min-height:0;
  border-top:1px solid var(--border, rgba(127,127,127,.22)); }
.rooms-sidebar{ width:256px; flex:none; overflow-y:auto; padding:12px;
  display:flex; flex-direction:column; gap:8px;
  border-right:1px solid var(--border, rgba(127,127,127,.22)); }
.rooms-main{ flex:1; min-width:0; display:flex; flex-direction:column; }
.rooms-new-btn{ display:flex; align-items:center; justify-content:center; gap:6px;
  padding:9px 10px; border-radius:10px; font-weight:600; font-size:13.5px;
  border:1px dashed var(--border, rgba(127,127,127,.4)); background:transparent;
  color:var(--text, inherit); cursor:pointer; }
.rooms-new-btn:hover{ background:var(--accent-soft, rgba(127,127,127,.08)); }
.rooms-list{ display:flex; flex-direction:column; gap:4px; }
.rooms-list-empty{ font-size:12.5px; color:var(--text-muted); padding:8px 4px; line-height:1.5; }
.room-item{ text-align:left; padding:9px 10px; border-radius:10px; cursor:pointer;
  border:1px solid transparent; background:transparent; color:var(--text, inherit);
  display:flex; flex-direction:column; gap:5px; }
.room-item:hover{ background:var(--accent-soft, rgba(127,127,127,.08)); }
.room-item.active{ background:var(--accent-soft, rgba(127,127,127,.12));
  border-color:var(--border, rgba(127,127,127,.3)); }
.room-item-title{ font-weight:600; font-size:13.5px; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.room-item-avatars{ display:flex; gap:-6px; }
.room-item-avatars img{ width:20px; height:20px; border-radius:50%; object-fit:cover;
  margin-right:-6px; border:1.5px solid var(--surface, #222); }
.room-create{ display:flex; flex-direction:column; gap:10px; padding:10px;
  border:1px solid var(--border, rgba(127,127,127,.3)); border-radius:12px;
  background:var(--surface-2, rgba(127,127,127,.06)); }
.room-create h4{ margin:0; font-size:13px; }
.room-create input[type=text]{ width:100%; padding:7px 9px; border-radius:8px;
  border:1px solid var(--border, rgba(127,127,127,.3)); background:var(--surface, transparent);
  color:var(--text, inherit); font-size:13px; box-sizing:border-box; }
.room-pick{ display:flex; flex-wrap:wrap; gap:6px; max-height:180px; overflow-y:auto; }
.room-pick-chip{ display:flex; align-items:center; gap:6px; padding:5px 9px 5px 5px;
  border-radius:999px; border:1px solid var(--border, rgba(127,127,127,.3));
  background:transparent; color:var(--text, inherit); cursor:pointer; font-size:12.5px; }
.room-pick-chip img{ width:20px; height:20px; border-radius:50%; object-fit:cover; }
.room-pick-chip.selected{ background:var(--accent-soft, rgba(127,127,127,.16));
  border-color:var(--accent, rgba(127,127,127,.6)); font-weight:600; }
.room-create-actions{ display:flex; gap:8px; justify-content:flex-end; }
.room-create-hint{ font-size:11.5px; color:var(--text-muted); }
.rooms-empty{ flex:1; display:flex; align-items:center; justify-content:center;
  text-align:center; color:var(--text-muted); font-size:13.5px; padding:24px; line-height:1.6; }
.rooms-head{ padding:12px 16px; border-bottom:1px solid var(--border, rgba(127,127,127,.18));
  display:flex; flex-direction:column; gap:8px; }
.rooms-head-title{ font-weight:700; font-size:15px; }
.rooms-parts{ display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.rooms-part{ display:flex; align-items:center; gap:5px; padding:3px 5px 3px 3px;
  border-radius:999px; border:1px solid var(--border, rgba(127,127,127,.25));
  font-size:11.5px; color:var(--text-muted); }
.rooms-part img{ width:18px; height:18px; border-radius:50%; object-fit:cover; }
.rooms-part-x{ cursor:pointer; opacity:.6; border:none; background:none; color:inherit;
  font-size:12px; padding:0 2px; }
.rooms-part-x:hover{ opacity:1; }
.rooms-part-add{ font-size:11.5px; padding:3px 8px; border-radius:999px; cursor:pointer;
  border:1px dashed var(--border, rgba(127,127,127,.4)); background:transparent; color:var(--text-muted); }
.rooms-thread{ flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:2px; }
.rooms-thinking{ display:flex; align-items:center; gap:8px; padding:6px 16px 10px 66px;
  color:var(--text-muted); font-size:12.5px; }
.rooms-thinking[hidden]{ display:none; }
.rooms-typing-avatars{ display:inline-flex; }
.rooms-typing-avatar{ width:18px; height:18px; border-radius:50%; object-fit:cover;
  margin-right:-5px; border:1.5px solid var(--surface, #222); }
.rooms-thinking .dots{ display:inline-flex; gap:3px; }
.rooms-thinking .dots i{ width:5px; height:5px; border-radius:50%; background:currentColor;
  opacity:.4; animation:rooms-dot 1.2s infinite ease-in-out; }
.rooms-thinking .dots i:nth-child(2){ animation-delay:.2s; }
.rooms-thinking .dots i:nth-child(3){ animation-delay:.4s; }
@keyframes rooms-dot{ 0%,60%,100%{ opacity:.3; transform:translateY(0); } 30%{ opacity:1; transform:translateY(-3px); } }
.rooms-composer{ display:flex; gap:8px; align-items:flex-end; padding:10px 14px 14px;
  border-top:1px solid var(--border, rgba(127,127,127,.18)); }
.rooms-addr{ flex:none; padding:8px 6px; border-radius:9px; font-size:12.5px; max-width:150px;
  border:1px solid var(--border, rgba(127,127,127,.3)); background:var(--surface, transparent);
  color:var(--text, inherit); }
.rooms-composer textarea{ flex:1; min-height:40px; max-height:140px; resize:none;
  padding:9px 11px; border-radius:11px; font-size:13.5px; font-family:inherit; line-height:1.4;
  border:1px solid var(--border, rgba(127,127,127,.3)); background:var(--surface, transparent);
  color:var(--text, inherit); box-sizing:border-box; }
.rooms-composer textarea:disabled{ opacity:.55; }
.rooms-send{ flex:none; }
@media (max-width:720px){
  .modal-inner-rooms{ width:100vw; height:100vh; max-width:none; border-radius:0; }
  .rooms-layout{ flex-direction:column; }
  .rooms-sidebar{ width:auto; max-height:38%; border-right:none;
    border-bottom:1px solid var(--border, rgba(127,127,127,.22)); }
  .rooms-addr{ max-width:120px; }
}`;
  const el = document.createElement('style');
  el.id = 'rooms-css';
  el.textContent = css;
  document.head.appendChild(el);
}

function open_rooms_modal() {
  rooms_inject_css();
  open_modal('modal-rooms');
  const rs = _rooms_state();
  rooms_render_sidebar();
  rooms_render_main();
  void rooms_load_list();
  // Re-open the last room so a re-open (or SSE gap while closed) rehydrates.
  if (rs.active_id) void rooms_open(rs.active_id);
}

async function rooms_load_list() {
  const rs = _rooms_state();
  try {
    const resp = await api('/api/rooms');
    rs.list = Array.isArray(resp && resp.rooms) ? resp.rooms : [];
  } catch {
    rs.list = [];
  }
  // Most-recent first so the auto-opened room is the freshest.
  rs.list.sort((a, b) => String(b.ts_last_message_at || '').localeCompare(String(a.ts_last_message_at || '')));
  rooms_render_sidebar();
  // First open with no room selected → land in the most-recent room instead of
  // an empty pane. (Guarded on active_id so a create/switch already in progress
  // isn't overridden.)
  if (!rs.active_id && rs.list.length) {
    const first = _room_id_of(rs.list[0]);
    if (first) void rooms_open(first);
  }
}

async function rooms_open(id) {
  const rs = _rooms_state();
  rs.active_id = id;
  rs.creating = false;
  rs.addressed = '';
  rooms_render_sidebar();
  try {
    const detail = await api(`/api/rooms/${encodeURIComponent(id)}`);
    if (rs.active_id !== id) return; // a newer switch superseded us
    rs.detail = detail;
    rooms_render_main();
  } catch (e) {
    if (rs.active_id !== id) return;
    rs.detail = null;
    rooms_render_main();
    toast(`Couldn't open the room: ${e.message}`, true);
  }
}

async function rooms_create(title, ids) {
  const rs = _rooms_state();
  try {
    const resp = await api('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || undefined, participant_ids: ids }),
    });
    rs.creating = false;
    rs.create_sel = new Set();
    await rooms_load_list();
    const id = _room_id_of(resp);
    if (id) await rooms_open(id);
  } catch (e) {
    toast(`Couldn't create the room: ${e.message}`, true);
  }
}

async function rooms_add_participant(sid) {
  const rs = _rooms_state();
  if (!rs.active_id) return;
  try {
    const resp = await api(`/api/rooms/${encodeURIComponent(rs.active_id)}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specialist_id: sid }),
    });
    if (rs.detail) rs.detail.participant_ids = resp.participant_ids || rs.detail.participant_ids;
    rooms_render_main();
    void rooms_load_list();
  } catch (e) {
    toast(`Couldn't add: ${e.message}`, true);
  }
}

async function rooms_remove_participant(sid) {
  const rs = _rooms_state();
  if (!rs.active_id) return;
  try {
    const resp = await api(`/api/rooms/${encodeURIComponent(rs.active_id)}/participants/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    if (rs.detail) rs.detail.participant_ids = resp.participant_ids || rs.detail.participant_ids;
    rooms_render_main();
    void rooms_load_list();
  } catch (e) {
    toast(`Couldn't remove: ${e.message}`, true);
  }
}

async function rooms_send() {
  const rs = _rooms_state();
  if (!rs.active_id || !rs.detail) return;
  if (rs.detail.turn_in_flight) return;
  const input = document.getElementById('rooms-composer-input');
  const content = (input && input.value || '').trim();
  if (!content) return;
  const addressed = rs.addressed || undefined;
  input.value = '';
  input.style.height = '';
  // Optimistic: disable the composer + show the thinking row immediately.
  // The owner message + agent replies stream back over SSE; room_turn_done
  // clears this. (We never render the owner message optimistically — the
  // room_message_added event lands it, keeping one source of truth.)
  rs.detail.turn_in_flight = true;
  rooms_update_turn();
  try {
    const raw = await fetch(`/api/rooms/${encodeURIComponent(rs.active_id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, addressed_specialist_id: addressed }),
    });
    if (raw.status === 409) {
      // A turn is already running — restore the text so nothing is lost.
      rs.detail.turn_in_flight = true;
      rooms_update_turn();
      if (input) input.value = content;
      toast('A turn is already in progress in this room — hang on a moment.', false);
      return;
    }
    if (!raw.ok) {
      const body = await raw.text().catch(() => '');
      throw new Error(`${raw.status} ${body.slice(0, 120)}`);
    }
    // 202 {status:'running'} — SSE drives the rest.
  } catch (e) {
    rs.detail.turn_in_flight = false;
    rooms_update_turn();
    if (input) input.value = content;
    toast(`Message not sent: ${e.message}`, true);
  }
}

function rooms_render_sidebar() {
  const side = document.getElementById('rooms-sidebar');
  if (!side) return;
  const rs = _rooms_state();
  side.innerHTML = '';

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'rooms-new-btn';
  newBtn.innerHTML = '<span aria-hidden="true">＋</span><span>New room</span>';
  newBtn.addEventListener('click', () => {
    rs.creating = !rs.creating;
    if (rs.creating) rs.create_sel = new Set();
    rooms_render_sidebar();
    rooms_render_main();
  });
  side.appendChild(newBtn);

  if (rs.creating) side.appendChild(rooms_build_create_form());

  const list = document.createElement('div');
  list.className = 'rooms-list';
  if (!rs.list.length) {
    const empty = document.createElement('div');
    empty.className = 'rooms-list-empty';
    empty.textContent = 'No rooms yet. Start one with two or more specialists and let them riff.';
    list.appendChild(empty);
  } else {
    for (const r of rs.list) {
      const id = _room_id_of(r);
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'room-item' + (id === rs.active_id ? ' active' : '');
      const parts = Array.isArray(r.participant_ids) ? r.participant_ids : [];
      const title = (r.title && r.title.trim())
        || parts.map((p) => (state.by_id.get(p) || {}).name || p).join(', ')
        || 'Untitled room';
      const avatars = parts.slice(0, 5)
        .map((p) => `<img src="/app/api/avatars/${encodeURIComponent(p)}" alt="" title="${escape_html((state.by_id.get(p) || {}).name || p)}"/>`)
        .join('');
      item.innerHTML =
        `<span class="room-item-title">${escape_html(title)}</span>` +
        `<span class="room-item-avatars">${avatars}</span>`;
      item.addEventListener('click', () => { void rooms_open(id); });
      list.appendChild(item);
    }
  }
  side.appendChild(list);
}

function rooms_build_create_form() {
  const rs = _rooms_state();
  const wrap = document.createElement('div');
  wrap.className = 'room-create';
  wrap.innerHTML = '<h4>New room</h4>';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Room title (optional)';
  titleInput.maxLength = 120;
  wrap.appendChild(titleInput);

  const hint = document.createElement('div');
  hint.className = 'room-create-hint';
  hint.textContent = 'Pick at least two specialists.';
  wrap.appendChild(hint);

  const pick = document.createElement('div');
  pick.className = 'room-pick';
  // The roster (state.specialists) is the source — visible, hireable staff.
  for (const s of (state.specialists || [])) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'room-pick-chip' + (rs.create_sel.has(s.id) ? ' selected' : '');
    chip.innerHTML = `<img src="/app/api/avatars/${encodeURIComponent(s.id)}" alt=""/><span>${escape_html(s.name || s.id)}</span>`;
    chip.addEventListener('click', () => {
      if (rs.create_sel.has(s.id)) rs.create_sel.delete(s.id);
      else rs.create_sel.add(s.id);
      chip.classList.toggle('selected');
    });
    pick.appendChild(chip);
  }
  wrap.appendChild(pick);

  const actions = document.createElement('div');
  actions.className = 'room-create-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { rs.creating = false; rooms_render_sidebar(); rooms_render_main(); });
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'btn btn-primary';
  create.textContent = 'Create';
  create.addEventListener('click', () => {
    const ids = [...rs.create_sel];
    if (ids.length < 2) { toast('Pick at least two specialists for a room.', false); return; }
    void rooms_create(titleInput.value.trim(), ids);
  });
  actions.appendChild(cancel);
  actions.appendChild(create);
  wrap.appendChild(actions);
  return wrap;
}

function rooms_render_main() {
  const main = document.getElementById('rooms-main');
  if (!main) return;
  const rs = _rooms_state();
  main.innerHTML = '';

  if (!rs.detail) {
    const empty = document.createElement('div');
    empty.className = 'rooms-empty';
    empty.textContent = rs.list.length
      ? 'Pick a room on the left, or start a new one.'
      : 'Start a room with two or more specialists and let them riff — flirty banter, real tasks, whatever you\'re in the mood for.';
    main.appendChild(empty);
    return;
  }

  const detail = rs.detail;
  const parts = Array.isArray(detail.participant_ids) ? detail.participant_ids : [];

  // Header: title + participant chips (each removable) + an add control.
  const head = document.createElement('div');
  head.className = 'rooms-head';
  const title = (detail.title && detail.title.trim())
    || parts.map((p) => (state.by_id.get(p) || {}).name || p).join(', ')
    || 'Untitled room';
  const titleEl = document.createElement('div');
  titleEl.className = 'rooms-head-title';
  titleEl.textContent = title;
  head.appendChild(titleEl);

  const partsRow = document.createElement('div');
  partsRow.className = 'rooms-parts';
  for (const p of parts) {
    const chip = document.createElement('span');
    chip.className = 'rooms-part';
    chip.innerHTML = `<img src="/app/api/avatars/${encodeURIComponent(p)}" alt=""/>` +
      `<span>${escape_html((state.by_id.get(p) || {}).name || p)}</span>`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'rooms-part-x';
    x.textContent = '✕';
    x.title = 'Remove from room';
    x.addEventListener('click', () => {
      if (parts.length <= 2) { toast('A room needs at least two specialists.', false); return; }
      void rooms_remove_participant(p);
    });
    chip.appendChild(x);
    partsRow.appendChild(chip);
  }
  // "+ add" — the specialists not already in the room.
  const addable = (state.specialists || []).filter((s) => !parts.includes(s.id));
  if (addable.length) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'rooms-part-add';
    addBtn.textContent = '+ add';
    addBtn.addEventListener('click', () => rooms_open_add_menu(addBtn, addable));
    partsRow.appendChild(addBtn);
  }
  head.appendChild(partsRow);
  main.appendChild(head);

  // Thread.
  const thread = document.createElement('div');
  thread.className = 'rooms-thread';
  thread.id = 'rooms-thread';
  main.appendChild(thread);

  // Live "who's talking" indicator — filled by rooms_render_thinking() from the
  // per-speaker room_speaker events ("Kate is typing…"), falling back to a
  // generic line while the arbiter is choosing who speaks.
  const thinking = document.createElement('div');
  thinking.className = 'rooms-thinking';
  thinking.id = 'rooms-thinking';
  thinking.hidden = true;
  main.appendChild(thinking);

  // Composer: @-address select + textarea + send.
  const composer = document.createElement('div');
  composer.className = 'rooms-composer';
  const addr = document.createElement('select');
  addr.className = 'rooms-addr';
  addr.title = 'Address a specific specialist (otherwise the arbiter picks who speaks)';
  addr.innerHTML = '<option value="">Anyone</option>' +
    parts.map((p) => `<option value="${escape_html(p)}">@ ${escape_html((state.by_id.get(p) || {}).name || p)}</option>`).join('');
  addr.value = rs.addressed || '';
  addr.addEventListener('change', () => { rs.addressed = addr.value; });
  const ta = document.createElement('textarea');
  ta.id = 'rooms-composer-input';
  ta.rows = 1;
  ta.placeholder = 'Message the room…';
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void rooms_send(); }
  });
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'send-btn rooms-send';
  send.id = 'rooms-send-btn';
  send.textContent = 'Send';
  send.addEventListener('click', () => { void rooms_send(); });
  composer.appendChild(addr);
  composer.appendChild(ta);
  composer.appendChild(send);
  main.appendChild(composer);

  rooms_render_thread();
  rooms_update_turn();
}

// Simple popover of addable specialists, anchored to the "+ add" button.
function rooms_open_add_menu(anchor, addable) {
  const prior = document.getElementById('rooms-add-menu');
  if (prior) { prior.remove(); return; }
  const menu = document.createElement('div');
  menu.id = 'rooms-add-menu';
  menu.className = 'overflow-sheet';
  menu.style.position = 'fixed';
  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + 'px';
  menu.style.top = (rect.bottom + 4) + 'px';
  menu.style.zIndex = '9999';
  menu.style.maxHeight = '240px';
  menu.style.overflowY = 'auto';
  for (const s of addable) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'overflow-row';
    row.innerHTML = `<span class="overflow-row-icon"><img src="/app/api/avatars/${encodeURIComponent(s.id)}" alt="" style="width:20px;height:20px;border-radius:50%"/></span>` +
      `<span class="overflow-row-label">${escape_html(s.name || s.id)}</span>`;
    row.addEventListener('click', () => { menu.remove(); void rooms_add_participant(s.id); });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  setTimeout(() => {
    const onDoc = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', onDoc); } };
    document.addEventListener('click', onDoc);
  }, 0);
}

// Rebuild ONLY the thread from state — called on open and on each
// room_message_added. Messages are always sorted by ts (GET order isn't
// trustworthy — verified quirk) and reuse render_message() so each speaker
// keeps their avatar + name + hue.
function rooms_render_thread() {
  const thread = document.getElementById('rooms-thread');
  const rs = _rooms_state();
  if (!thread || !rs.detail) return;
  const msgs = (rs.detail.messages || []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  thread.innerHTML = '';
  for (const m of msgs) thread.appendChild(render_message(m));
  thread.scrollTop = thread.scrollHeight;
}

function rooms_update_turn() {
  const rs = _rooms_state();
  const ta = document.getElementById('rooms-composer-input');
  const send = document.getElementById('rooms-send-btn');
  const busy = !!(rs.detail && rs.detail.turn_in_flight);
  if (ta) ta.disabled = busy;
  if (send) send.disabled = busy;
  rooms_render_thinking();
}

// Render the live "who's talking" bar: "<Name> is typing…" (with avatar) for
// each agent actively generating — "A and B are typing…" if several — falling
// back to a generic "the room is thinking…" while the arbiter is still choosing
// who speaks. Hidden when no turn is in flight.
function rooms_render_thinking() {
  const el = document.getElementById('rooms-thinking');
  const rs = _rooms_state();
  if (!el) return;
  const busy = !!(rs.detail && rs.detail.turn_in_flight);
  const typers = rs.typing ? [...rs.typing.entries()] : []; // [id, name]
  if (!busy && typers.length === 0) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const dots = '<span class="dots"><i></i><i></i><i></i></span>';
  if (typers.length === 0) {
    el.innerHTML = `${dots}<span>the room is thinking…</span>`;
    return;
  }
  const avatars = typers
    .map(([id]) => `<img class="rooms-typing-avatar" src="/app/api/avatars/${encodeURIComponent(id)}" alt=""/>`)
    .join('');
  const names = typers.map(([, name]) => escape_html(name));
  let who;
  if (names.length === 1) who = `${names[0]} is typing`;
  else if (names.length === 2) who = `${names[0]} and ${names[1]} are typing`;
  else who = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing`;
  el.innerHTML = `<span class="rooms-typing-avatars">${avatars}</span><span>${who}</span>${dots}`;
}

// SSE: a message landed in a room. Append to the open room (dedup by id),
// re-render the thread. Ignored when the room isn't the open one — reopening
// refetches. (Cordoned server-side to the owning user.)
function rooms_on_message_added(event) {
  const rs = state.rooms;
  if (!rs || rs.active_id !== event.room_id || !rs.detail) return;
  const msgs = rs.detail.messages || (rs.detail.messages = []);
  if (event.message && !msgs.some((m) => m.id === event.message.id)) {
    msgs.push(event.message);
    rooms_render_thread();
  }
}

function rooms_on_turn(event, in_flight) {
  const rs = state.rooms;
  if (!rs || rs.active_id !== event.room_id || !rs.detail) return;
  rs.detail.turn_in_flight = in_flight;
  // A turn boundary resets who's typing (a stale typer never lingers).
  if (rs.typing) rs.typing.clear();
  rooms_update_turn();
}

// SSE: a specific agent started (`typing`) or finished (`done`) generating in a
// room. Maintain the typing set for the OPEN room and re-render the bar.
function rooms_on_speaker(event) {
  const rs = state.rooms;
  if (!rs || rs.active_id !== event.room_id || !rs.detail) return;
  if (!rs.typing) rs.typing = new Map();
  if (event.state === 'typing') rs.typing.set(event.specialist_id, event.name || event.specialist_id);
  else rs.typing.delete(event.specialist_id);
  rooms_render_thinking();
}

// ── SSE ──────────────────────────────────────────────────────────────────

function open_sse() {
  if (state.sse) { try { state.sse.close(); } catch {} }
  const sse = new EventSource('/app/api/events');
  state.sse = sse;
  sse.onopen = () => {
    if (status_dot_el) status_dot_el.dataset.connState = 'connected';
    state.sse_backoff = 1000;
    // If a room is open, the stream may have missed room events while it was
    // down (a reconnect mid-turn) — rehydrate the open room from GET so the
    // thread + in-flight flag are correct.
    if (state.rooms && state.rooms.active_id && !document.getElementById('modal-rooms').hidden) {
      void rooms_open(state.rooms.active_id);
    }
    // On the Fire is PATCH-driven, so a stream that was down missed every phase
    // that happened while it was — including terminal ones. Without this the
    // dock silently holds stale state after any blip (wifi handoff, laptop lid,
    // a deploy restarting the orchestrator) until the user changes tabs or
    // reloads, which is exactly the "needs a manual refresh" failure this
    // surface exists to eliminate. Reconnect ⇒ reconcile.
    void fire_refresh();
  };
  sse.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data);
      handle_sse_event(event);
    } catch {}
  };
  sse.onerror = () => {
    if (status_dot_el) status_dot_el.dataset.connState = 'reconnecting';
    // The dock stops claiming to be live the moment the stream drops.
    fire_set_stale(true);
    try { sse.close(); } catch {}
    state.sse = null;
    const delay = Math.min(30_000, state.sse_backoff);
    state.sse_backoff = Math.min(30_000, state.sse_backoff * 2);
    setTimeout(open_sse, delay);
  };
  // If the SSE 401s (session expired mid-tab), the browser fires
  // onerror repeatedly. Catch the auth case via a one-shot fetch and
  // bounce to login if we're no longer authenticated.
}

function handle_sse_event(event) {
  // Review-swarm seats run REAL sub-turns, so their tool calls and token stream
  // arrive as ordinary turn events on a `swarm:<review>:<seat>` conversation.
  // Peek at them for the live arena, then fall through to normal handling
  // (a no-op for every other conversation).
  swarm_live_event(event);
  switch (event.type) {
    case 'swarm_review_started':
    case 'swarm_seat_update':
    case 'swarm_finding_added':
    case 'swarm_verdict':
      // Review swarm (red/blue/judge over a code change) — update the live state
      // map and re-render the Code Shop panel if it's mounted (the iOS bee icon
      // is the native sibling on the same event stream).
      swarm_apply_event(event);
      break;
    case 'message_added':
      if (event.conversation_id === state.conv_id) {
        // Reload thread for the new message + any embedded proposals.
        load_messages(state.conv_id);
        // Each turn changes the context-fill — refresh the donut.
        // Cheap (one indexed audit query); fires only when the
        // ACTIVE conv added a message, not on other tabs / convs.
        refresh_context_fill();
      }
      break;
    case 'proposal_created':
      refresh_proposals();
      // A new probe flag may belong on the Bills desk's attention list.
      bills_invalidate();
      if (state.settings.toast_proposals) {
        const sname = state.by_id.get(event.specialist_id)?.name || event.specialist_id;
        toast(`${sname} prepared a proposal: ${event.title_preview}`, false, event.specialist_id);
      }
      break;
    case 'proposal_decided': {
      refresh_proposals();
      bills_invalidate();
      // A decision may have moved the specialist's Trust-Ladder XP. The event
      // doesn't name the specialist, so refresh the one in view (the common
      // case — you decided their proposal); others refresh on next switch.
      invalidate_rank(state.active_id);
      const s = state.by_id.get(state.active_id);
      if (s) { update_rank_badge(s); const o = document.getElementById('office-rank-badge'); if (o) populate_office_rank(o, state.active_id); }
      break;
    }
    case 'interrupt_raised':
      if (state.settings.toast_interrupts) {
        const sname = state.by_id.get(event.originating_specialist_id)?.name || event.originating_specialist_id;
        toast(`⚠ ${sname}: ${event.summary}`, false, event.originating_specialist_id);
      }
      break;
    case 'specialist_thinking':
      if (event.state === 'started') {
        state.thinking_ids.add(event.specialist_id);
        if (event.conversation_id === state.conv_id) {
          show_stop(true);
          // Make sure the typing bubble actually appears. This is
          // load-bearing on page refresh: the server's SSE handler
          // replays the active stream's `specialist_thinking: started`
          // for any in-flight turn so the UI can restore the bubble,
          // but update_typing_bubble was only being called from
          // render_messages / render_tool_status — neither of which
          // fires on raw SSE replay. Without this call the user
          // would refresh mid-stream and see no indication anyone was
          // typing until the next render trigger.
          update_typing_bubble();
        }
      } else {
        state.thinking_ids.delete(event.specialist_id);
        // The turn is over for THIS conversation — wipe the chain
        // for it (per-conv now, so other convs' chains are untouched).
        state.tool_chains.delete(event.conversation_id);
        state.tool_chains_expanded.delete(event.conversation_id);
        // Streaming buffer for this conversation is no longer
        // authoritative once the model finishes — the upcoming
        // `message_added` event will land the persisted version.
        if (event.conversation_id === state.conv_id) {
          state.streaming_text = '';
          state.streaming_stream_id = null;
          state.streaming_thinking = '';
          state.streaming_thinking_collapsed = false;
          state.active_tool = null;
          show_stop(false);
          render_tool_chain();
          // Remove the typing bubble now that thinking ended; otherwise
          // it lingers until message_added triggers a re-render.
          update_typing_bubble();
        }
      }
      update_staff_thinking();
      // Streaming state changed — re-evaluate whether the jump-pill
      // should still be visible (it only shows while someone is mid-turn).
      update_jump_pill();
      break;
    case 'specialist_activity':
      // rag/deep LEDs — emitted at the real start/end of retrieval +
      // deep-think consults. flash_led handles min-visibility for blips.
      flash_led(event.specialist_id, event.channel, event.state === 'on');
      break;
    case 'presence_targets':
      // Live LD2450 snapshot — update the presence canvas if it's mounted.
      _presence_on_targets(event);
      break;
    case 'presence_zones_acked':
      // Coordinator applied (or failed) a zone write — confirm in the editor.
      _presence_on_ack(event);
      break;
    case 'tool_invoked': {
      // TOOL LED on for the duration of the call. flash_led keeps an
      // instant blip visible (~300ms) and a fresh invoke cancels a
      // pending off, so a parallel/back-to-back burst stays solid.
      flash_led(event.specialist_id, 'tool', true);
      // Always file into the conv's chain, even if the user is
      // currently viewing a different conv — so when they switch back
      // (or refresh), the chain is still there.
      const chain = _get_or_create_chain(event.conversation_id);
      chain.push({
        call_id: event.tool_call_id,
        tool_name: event.tool_name,
        input_summary: event.input_summary || '',
        started_at: Date.now(),
        ended_at: null,
        ok: null,
      });
      if (event.conversation_id === state.conv_id) {
        state.active_tool = {
          tool_name: event.tool_name,
          input_summary: event.input_summary || '',
          started_at: Date.now(),
        };
        render_tool_chain();
        // Cozy consult cues — rail glow and/or mote stream when the
        // active conversation's specialist calls consult_specialist.
        if (event.tool_name === 'consult_specialist') {
          const peerMatch = (event.input_summary || '').match(/→\s*([\w-]+)/);
          const peer_id = peerMatch ? peerMatch[1] : null;
          const sender_id = event.specialist_id || state.active_id;
          if (peer_id && sender_id) {
            fire_consult_thread_start(event.tool_call_id, peer_id, sender_id);
          }
        }
      }
      break;
    }
    case 'tool_completed': {
      // TOOL LED off (deferred ~300ms by flash_led for min-visibility).
      flash_led(event.specialist_id, 'tool', false);
      const chain = state.tool_chains.get(event.conversation_id);
      if (chain) {
        const idx = chain.findIndex(
          (e) => e.call_id === event.tool_call_id && e.ended_at == null,
        );
        if (idx >= 0) {
          chain[idx].ended_at = Date.now();
          chain[idx].ok = event.ok !== false;
        } else {
          // No matching invoked entry (replay race / out-of-order
          // delivery) — synthesize one so the user still sees the
          // tool happened.
          chain.push({
            call_id: event.tool_call_id,
            tool_name: event.tool_name,
            input_summary: '',
            started_at: Date.now(),
            ended_at: Date.now(),
            ok: event.ok !== false,
          });
        }
      }
      if (event.conversation_id === state.conv_id) {
        state.active_tool = null;
        render_tool_chain();
        // End the consult cues when the matching consult tool completes.
        if (event.tool_name === 'consult_specialist') {
          fire_consult_thread_end(event.tool_call_id);
        }
      }
      break;
    }
    case 'followup_scheduled': {
      const list = state.pending_followups.get(event.conversation_id) || [];
      // Anchor the pill to the most recent specialist message in this
      // conversation (the one whose tool_calls included this followup).
      const anchor = [...state.messages].reverse().find((m) => m.role === 'specialist');
      list.push({
        followup_id: event.followup_id,
        summary: event.summary,
        fire_at_iso: event.fire_at_iso,
        anchor_message_id: anchor?.id,
        specialist_id: event.specialist_id,
      });
      state.pending_followups.set(event.conversation_id, list);
      if (event.conversation_id === state.conv_id) render_followup_pills();
      break;
    }
    case 'followup_delivered': {
      const list = state.pending_followups.get(event.conversation_id) || [];
      const next = list.filter((f) => f.followup_id !== event.followup_id);
      if (next.length) state.pending_followups.set(event.conversation_id, next);
      else state.pending_followups.delete(event.conversation_id);
      if (event.conversation_id === state.conv_id) render_followup_pills();
      break;
    }
    case 'delegation_started':
    case 'delegation_completed': {
      // Content-free invalidation trigger (ids + names only on the wire) —
      // the cordoned GET refetch repaints the 🐝 badge, the tray popover
      // (if open), and this conversation's delegation strip.
      refresh_delegations();
      break;
    }
    case 'questions_presented': {
      // A specialist just invoked present_questions. Fetch the full
      // set and anchor it on the latest specialist message. The
      // conversation_id is null when the set came from a brief
      // deliberation — in that case Kate's right rail shows the form
      // and chat ignores the event.
      if (!event.conversation_id) {
        // Brief-attached set (deliberation). Kate's right rail renders it;
        // if you're not on Kate, surface a toast so it isn't silently lost.
        if (state.active_id === 'kate') {
          refresh_brief();
        } else {
          const bname = state.by_id.get(event.specialist_id)?.name || 'A specialist';
          toast(`${bname} added questions to your brief — open Kate to answer`, false, event.specialist_id);
        }
        break;
      }
      api(`/api/present-questions/${event.question_set_id}`)
        .then((row) => {
          if (!row || row.status !== 'pending') return;
          const arr = state.pending_question_sets.get(event.conversation_id) || [];
          // Don't pre-fill anchor_message_id — the message_added event
          // that lands moments later triggers load_messages, which
          // calls render_pending_question_forms which falls back to
          // "the latest specialist message in state.messages." That
          // gives the form a fresh anchor every render instead of
          // pinning it to the now-stale prior reply.
          // De-dup: a switch-in fetch or SSE replay can re-deliver the set.
          if (!arr.some((s) => s && s.id === row.id)) arr.push(row);
          state.pending_question_sets.set(event.conversation_id, arr);
          // Surface it from the rail no matter which tab you're on — a "?"
          // badge on the asking specialist's row. Without this, questions
          // presented while you're elsewhere were stored silently and you
          // never knew to go answer them (the reported Linda bug).
          render_staff();
          if (event.conversation_id === state.conv_id) {
            render_pending_question_forms();
          } else {
            const sname = state.by_id.get(event.specialist_id)?.name || event.specialist_id;
            const n = event.question_count || (Array.isArray(row.questions) ? row.questions.length : 0) || 1;
            toast(
              `${sname} has ${n} question${n === 1 ? '' : 's'} for you — open ${sname}'s chat to answer`,
              false,
              event.specialist_id,
            );
          }
        })
        .catch(() => {});
      break;
    }
    case 'questions_answered': {
      // Drop the matching set from local state. The resume turn's
      // `message_added` event will re-trigger a render anyway, but
      // clearing eagerly keeps the form from briefly re-appearing on
      // a stale render.
      if (event.conversation_id) {
        const arr = state.pending_question_sets.get(event.conversation_id) || [];
        const next = arr.filter((s) => s.id !== event.question_set_id);
        if (next.length) state.pending_question_sets.set(event.conversation_id, next);
        else state.pending_question_sets.delete(event.conversation_id);
        // Clear the rail "?" badge once the set is answered (here or on
        // another surface — questions_answered fires cross-surface).
        render_staff();
        if (event.conversation_id === state.conv_id) render_pending_question_forms();
      } else if (state.active_id === 'kate') {
        refresh_brief();
      }
      break;
    }
    case 'listing_draft_created': {
      // Linda persisted a draft_listing card. Fetch the full row and
      // anchor it under her latest message, same model as questions.
      if (!event.conversation_id) break;
      api(`/api/listing-drafts/${event.listing_draft_id}`)
        .then((row) => {
          if (!row || !row.id) return;
          const arr = (state.listing_drafts.get(event.conversation_id) || [])
            .filter((d) => d.id !== row.id);
          arr.push(row);
          state.listing_drafts.set(event.conversation_id, arr);
          if (event.conversation_id === state.conv_id) render_listing_draft_cards();
        })
        .catch(() => {});
      break;
    }
    case 'resale_item_updated': {
      // Linda tracked or updated a resale item — her office (the Resale Desk)
      // reads the sales ledger, so drop its cached pane and, if it's the open
      // surface, refetch live. Same reactive contract as the other surfaces.
      const sid = event.specialist_id;
      state.pane_cache.delete(sid);
      if (state.active_id === sid && state.surface === 'office') load_pane(sid);
      break;
    }
    case 'security_room_updated': {
      // A person thread changed (named / assigned / dismissed) or a flagged
      // event resolved. Reconcile the LIVE room node in place rather than
      // re-rendering the whole pane: the owner's own mutations already applied
      // themselves surgically (and animated), so a pane-level rebuild here
      // would tear down the DOM mid-animation and re-fetch a second time.
      //
      // 1.0 called `render_pane(state._last_pane_doc)`, which built a NEW room
      // root — leaving the mutation handler's captured root detached and
      // painting into nothing. `_secroom_root` is the one live node.
      if (_secroom_root && _secroom_root.isConnected) {
        _secroom_paint(_secroom_root).catch(() => {
          /* keep last-good; the next event or tab visit repaints */
        });
      } else {
        // Room isn't mounted — drop the cache so the next visit reads fresh.
        _secroom_doc = null;
      }
      break;
    }
    case 'research_investigation_updated': {
      // Kate's deep-research runner advanced an investigation a slice — drop
      // the Research office cache and, if that tab is open for this
      // specialist, repaint the live progress. The route is cordon-filtered,
      // so a refetch only ever returns the viewer's own investigations.
      const sid = event.specialist_id;
      if (state._research_cache) state._research_cache.delete(sid);
      if (
        state.active_id === sid &&
        state.surface === 'office' &&
        state._news_tab === 'research' &&
        state._last_pane_doc
      ) {
        render_pane(state._last_pane_doc);
      }
      break;
    }
    case 'job_progress': {
      // On the Fire — patch the dock in place. Cordoned server-side, so anything
      // that reaches this client is a job the viewer may see.
      fire_on_progress(event);
      break;
    }
    case 'media_archived': {
      // A media item finished archiving — the Archive tab shows the caller's
      // cordon-filtered library, so refresh it in place if it's the open
      // surface. The event carries private_to; a client the server deemed
      // ineligible never receives it (router.ts per-subscriber cordon).
      media_invalidate();
      break;
    }
    case 'media_shared': {
      // An item's share set was replaced — a recipient's Archive grid gains it
      // (or loses a revoked one). Skip the SHARER's own echo: they already
      // re-rendered from the POST response, and repainting the tab would yank
      // them out of the open item detail. Server-cordoned to the sharer + the
      // named recipients (router.ts per-subscriber cordon).
      if (!current_user || event.by !== current_user.id) media_invalidate();
      break;
    }
    case 'room_message_added': {
      // Agent Rooms — a message landed (owner or an agent reply). Push it into
      // the open room thread (sorted by ts, dedup by id). Server-cordoned to
      // the owning user. This is the push that replaces polling.
      rooms_on_message_added(event);
      break;
    }
    case 'room_turn_started': {
      rooms_on_turn(event, true);
      break;
    }
    case 'room_turn_done': {
      rooms_on_turn(event, false);
      break;
    }
    case 'room_speaker': {
      // A specific agent started/finished generating — drive the live
      // "<Name> is typing…" indicator.
      rooms_on_speaker(event);
      break;
    }
    case 'mail_message_triaged':
    case 'mail_account_updated': {
      // Post Office changed (new triaged mail, or an account add/edit/test).
      // Refresh the Post Office view IN PLACE, preserving scroll position and
      // debounced — so mail arriving while you read doesn't yank you to the
      // top. The route is cordon-filtered (only the viewer's own mail).
      _po_live_refresh(event.specialist_id);
      break;
    }
    case 'library_upload_progress': {
      state.pending_uploads = state.pending_uploads || new Map();
      if (event.phase === 'done') {
        // Don't hold onto a 'done' row — let the real library list
        // refresh take over. Small delay so any in-flight refresh
        // sees the persisted item.
        setTimeout(() => {
          state.pending_uploads.delete(event.upload_id);
          if (event.specialist_id === state.active_id) render_right_rail();
        }, 200);
        if (event.specialist_id === state.active_id) {
          // Refresh library list to pull the just-persisted item.
          render_right_rail();
        }
      } else {
        state.pending_uploads.set(event.upload_id, {
          upload_id: event.upload_id,
          specialist_id: event.specialist_id,
          filename: event.filename,
          phase: event.phase,
          detail: event.detail,
          error: event.error,
        });
        if (event.specialist_id === state.active_id) render_right_rail();
      }
      break;
    }
    case 'message_token':
      if (event.conversation_id === state.conv_id) {
        if (state.streaming_stream_id !== event.stream_id) {
          state.streaming_stream_id = event.stream_id;
          state.streaming_text = '';
          state.streaming_thinking = '';
          state.streaming_thinking_collapsed = false;
        }
        // First content token of the round arrives — auto-collapse the
        // thinking pill so the eye lands on the answer, not the
        // verbose deliberation trace.
        if (!state.streaming_text && state.streaming_thinking) {
          state.streaming_thinking_collapsed = true;
        }
        state.streaming_text += event.delta;
        if (event.specialist_id && !state.thinking_ids.has(event.specialist_id)) {
          state.thinking_ids.add(event.specialist_id);
          update_staff_thinking();
        }
        update_typing_bubble();
        update_streaming_bubble();
      }
      break;
    case 'message_thinking_token':
      if (event.conversation_id === state.conv_id) {
        if (state.streaming_stream_id !== event.stream_id) {
          state.streaming_stream_id = event.stream_id;
          state.streaming_text = '';
          state.streaming_thinking = '';
          state.streaming_thinking_collapsed = false;
        }
        state.streaming_thinking += event.delta;
        if (event.specialist_id && !state.thinking_ids.has(event.specialist_id)) {
          state.thinking_ids.add(event.specialist_id);
          update_staff_thinking();
        }
        update_typing_bubble();
        update_thinking_pill();
      }
      break;
    case 'message_superseded':
      // A finalize guard rejected the streamed draft and is regenerating.
      // Drop the visible draft and return to a "refining…" typing state; the
      // corrected reply arrives via the next message_added (the redo is NOT
      // re-streamed). Replaces the old jarring wipe-and-retype.
      if (
        event.conversation_id === state.conv_id &&
        (!event.stream_id || state.streaming_stream_id === event.stream_id)
      ) {
        state.streaming_text = '';
        state.streaming_stream_id = null;
        state.streaming_thinking = '';
        state.streaming_thinking_collapsed = false;
        // Remove the stale draft DOM so update_typing_bubble re-creates a
        // fresh dots bubble (it short-circuits on an existing .typing node).
        const stale = messages_el.querySelector('.msg.specialist.typing');
        if (stale) stale.remove();
        update_typing_bubble();
        update_thinking_pill();
        if (event.specialist_id) {
          apply_specialist_status(event.specialist_id, 'refining the reply…', 20);
        }
      }
      break;
    case 'message_superseded':
      // A finalize guard rejected the streamed draft and is regenerating.
      // Drop the visible draft and return to a "refining…" typing state; the
      // corrected reply arrives via the next message_added (the redo is NOT
      // re-streamed). Replaces the old jarring wipe-and-retype.
      if (
        event.conversation_id === state.conv_id &&
        (!event.stream_id || state.streaming_stream_id === event.stream_id)
      ) {
        state.streaming_text = '';
        state.streaming_stream_id = null;
        state.streaming_thinking = '';
        state.streaming_thinking_collapsed = false;
        // Remove the stale draft DOM so update_typing_bubble re-creates a
        // fresh dots bubble (it short-circuits on an existing .typing node).
        const stale = messages_el.querySelector('.msg.specialist.typing');
        if (stale) stale.remove();
        update_typing_bubble();
        update_thinking_pill();
        if (event.specialist_id) {
          apply_specialist_status(event.specialist_id, 'refining the reply…', 20);
        }
      }
      break;
    case 'specialist_status':
      apply_specialist_status(event.specialist_id, event.status, event.ttl_seconds || 60);
      break;
    case 'inbox_message_added': {
      // Bump the recipient's unread count and re-render the staff list so
      // the envelope appears. If the user is already on that specialist's
      // thread, treat as already-seen (no envelope).
      const recipient = state.by_id.get(event.to_specialist_id);
      if (recipient && event.to_specialist_id !== state.active_id) {
        recipient.unread_since_visit = (recipient.unread_since_visit || 0) + 1;
        render_staff();
      }
      if (event.to_specialist_id === 'kate' && state.active_id === 'kate') {
        refresh_inbox_for_kate();
      }
      // If the user is currently viewing the recipient's pane, refresh
      // the inbox panel in their right rail so the new flag appears
      // without waiting for a reload.
      if (event.to_specialist_id === state.active_id) {
        const inbox_list = document.getElementById('inbox-list');
        if (inbox_list) load_inbox_list(state.active_id, inbox_list);
      }
      break;
    }
    case 'specialist_visited': {
      // Another tab/window opened this specialist's thread. Clear the envelope.
      const visited = state.by_id.get(event.specialist_id);
      if (visited) {
        visited.unread_since_visit = 0;
        visited.ts_last_visited = event.ts_last_visited;
        render_staff();
      }
      break;
    }
    case 'authenticity_updated': {
      // Mariah's daily scan_specialist_authenticity recomputed a
      // specialist's score. Update the in-memory record and, if this
      // is the active specialist, refresh the topbar trust meter.
      const s = state.by_id.get(event.specialist_id);
      if (s) {
        s.authenticity = {
          score: event.score,
          ts_computed: event.ts_computed,
          turns_in_window: s.authenticity?.turns_in_window ?? null,
        };
        if (event.specialist_id === state.active_id) {
          update_trust_meter(s);
        }
      }
      break;
    }
    case 'brief_generated':
      if (state.active_id === 'kate') refresh_brief();
      break;
    case 'library_updated':
      if (state.active_id === event.specialist_id) render_right_rail();
      break;
    case 'search_index_updated':
      // The next search will pick up new content; nothing to do now.
      break;
    case 'conversation_created':
      // A new conversation appeared (likely from a Telegram message that
      // crossed the 24h freshness threshold). If we're on that specialist
      // and the new conversation is more recent, switch to it.
      if (event.specialist_id === state.active_id) {
        void switch_specialist(event.specialist_id);
      }
      break;
    case 'active_specialist_changed':
      // Another surface (Telegram /kate, /vivian, ...) changed the
      // user's active specialist. Reflect in the UI on the next nav.
      break;
    case 'push_dispatched':
      // Quiet trace — surface only if details are on.
      if (state.settings.show_details) {
        const tag = event.via === 'queued' ? '⏸' : '📤';
        toast(`${tag} push ${event.kind} (${event.via})`);
      }
      break;
    case 'roadmap_updated':
      // Refetch only if the panel is currently open; otherwise the next
      // open_roadmap_modal() picks up the latest state. Quiet — no toast.
      if (state.modal === 'modal-roadmap') fetch_roadmap();
      break;
  }
}

// ── Specialist status (Prompt 6c) ────────────────────────────────────────

const _status_timers = new Map();

function apply_specialist_status(sid, status, ttl_seconds) {
  state.statuses = state.statuses || new Map();
  if (status) {
    state.statuses.set(sid, status);
  } else {
    state.statuses.delete(sid);
  }
  render_staff_status(sid);
  render_chat_status(); // Claude-style inline status in the open conversation
  // Auto-clear after ttl.
  const prev = _status_timers.get(sid);
  if (prev) clearTimeout(prev);
  if (status && ttl_seconds > 0) {
    _status_timers.set(
      sid,
      setTimeout(() => {
        state.statuses.delete(sid);
        render_staff_status(sid);
        render_chat_status();
      }, ttl_seconds * 1000),
    );
  }
}

/**
 * Render the live contextual status (the status_flavor phrase) INLINE in the
 * open conversation — inside the active specialist's typing bubble, the way
 * Claude shows its status line — while they work, before the reply streams in.
 * The roster staff-card line (render_staff_status) is kept for OTHER specialists
 * working in the background. No-ops unless the typing bubble is currently shown
 * for the active specialist; the bubble naturally hands off to the streaming
 * reply (which drops `.typing-bubble`), so this never fights the answer.
 */
function chat_status_phrase(status, spec) {
  if (!status) return '';
  const name = spec && spec.name;
  if (name) {
    const prefix = `${name} is `;
    if (status.toLowerCase().startsWith(prefix.toLowerCase())) {
      const rest = status.slice(prefix.length);
      return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : status;
    }
  }
  return status;
}

function render_chat_status() {
  const bubble = messages_el.querySelector('.msg.specialist.typing .typing-bubble');
  if (!bubble) return;
  const status = state.active_id && state.statuses && state.statuses.get(state.active_id);
  const spec = state.active_id && state.by_id.get(state.active_id);
  const phrase = status ? chat_status_phrase(status, spec) : '';
  if (phrase) {
    if (bubble.dataset.statusPhrase === phrase) return; // unchanged — skip churn
    bubble.dataset.statusPhrase = phrase;
    bubble.classList.add('has-status');
    bubble.textContent = '';
    const spin = document.createElement('span');
    spin.className = 'braille-spin';
    spin.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    txt.className = 'chat-status-text';
    txt.textContent = phrase;
    bubble.append(spin, txt);
  } else if (bubble.dataset.statusPhrase) {
    // Status cleared but still thinking → restore the dots.
    delete bubble.dataset.statusPhrase;
    bubble.classList.remove('has-status');
    bubble.innerHTML =
      '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  }
}

function render_staff_status(sid) {
  const card = staff_list_el.querySelector(`.staff-card[data-id="${sid}"]`);
  if (!card) return;
  let line = card.querySelector('.staff-status-line');
  const status = state.statuses && state.statuses.get(sid);
  if (status) {
    if (!line) {
      line = document.createElement('div');
      line.className = 'staff-status-line';
      const meta_div = card.querySelector('.staff-role')?.parentElement;
      if (meta_div) meta_div.appendChild(line);
    }
    // Animated braille spinner + the contextual status text. The spinner is a
    // pure-CSS glyph-cycling animation (see .braille-spin in app.css); text gets
    // its own span so the ellipsis truncation stays on the words, not the glyph.
    line.textContent = '';
    const spin = document.createElement('span');
    spin.className = 'braille-spin';
    spin.setAttribute('aria-hidden', 'true');
    const txt = document.createElement('span');
    txt.className = 'staff-status-text';
    txt.textContent = status;
    line.append(spin, txt);
  } else if (line) {
    line.remove();
  }
}

// ── Inbox + Brief refresh ────────────────────────────────────────────────

async function refresh_inbox_for_kate() {
  if (state.active_id !== 'kate') return;
  render_right_rail();
}

async function refresh_brief() {
  if (state.active_id !== 'kate') return;
  render_right_rail();
}

// ── Toasts ───────────────────────────────────────────────────────────────

function toast(text, is_error, specialist_id) {
  const t = document.createElement('div');
  t.className = 'toast';
  if (is_error) t.style.borderColor = 'var(--danger)';
  if (specialist_id) {
    const img = document.createElement('img');
    img.src = `/app/api/avatars/${specialist_id}`;
    img.alt = '';
    t.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = text;
  t.appendChild(span);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('fading');
    setTimeout(() => t.remove(), 300);
  }, 4000);
}

// ── Modals ───────────────────────────────────────────────────────────────

function open_modal(id) {
  document.getElementById('modal-backdrop').hidden = false;
  document.getElementById(id).hidden = false;
  state.modal = id;
  // Mobile: prevent background scroll while a sheet is up. CSS owns the
  // overflow rule (`body.modal-open { overflow: hidden }` in the
  // ≤899px block); we just toggle the class.
  document.body.classList.add('modal-open');
}
function close_all_modals() {
  document.getElementById('modal-backdrop').hidden = true;
  for (const m of document.querySelectorAll('.modal')) m.hidden = true;
  // Tear down any dynamic account modals (change-password, set-pin)
  // so the next open call gets a fresh form / cleared state.
  const acct = document.getElementById('account-modal-dynamic');
  if (acct) acct.remove();
  const recon = document.getElementById('recon-ops-dynamic');
  if (recon) recon.remove();
  state.modal = null;
  document.body.classList.remove('modal-open');
}

// ── Account modals: change password + set/change PIN ─────────────────
//
// Both fire from the user-bubble dropdown. Rendered dynamically so
// they don't bloat index.html. The backend endpoints
// (/api/auth/change_password and /api/auth/set_pin) handle bootstrap
// vs rotation modes server-side — the client just sends what the
// user typed; the backend gates on user.must_change_password /
// must_set_pin to decide whether current_password / step-up is
// required.

function _account_modal_open(inner_html, on_ready) {
  // Tear down any prior instance so the form state resets.
  const prior = document.getElementById('account-modal-dynamic');
  if (prior) prior.remove();
  const modal = document.createElement('div');
  modal.id = 'account-modal-dynamic';
  modal.className = 'modal modal-account';
  modal.innerHTML =
    `<div class="modal-inner" role="dialog" aria-modal="true">${inner_html}</div>`;
  document.body.appendChild(modal);
  document.getElementById('modal-backdrop').hidden = false;
  document.body.classList.add('modal-open');
  state.modal = 'account-modal-dynamic';
  if (on_ready) on_ready(modal);
}

function open_change_password_modal() {
  _account_modal_open(
    `
      <h3>Change password</h3>
      <p class="modal-sub">Choose a new password (minimum 10 characters).</p>
      <form id="acct-pw-form" autocomplete="off">
        <label class="acct-field">
          <span>Current password</span>
          <input type="password" name="current_password" autocomplete="current-password" required>
          <em class="acct-hint">Leave blank only if you're completing first-login setup.</em>
        </label>
        <label class="acct-field">
          <span>New password</span>
          <input type="password" name="new_password" autocomplete="new-password" required minlength="10">
        </label>
        <label class="acct-field">
          <span>Confirm new password</span>
          <input type="password" name="confirm_password" autocomplete="new-password" required minlength="10">
        </label>
        <div class="acct-actions">
          <button type="button" class="acct-btn acct-btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="acct-btn">Save</button>
        </div>
        <div class="acct-status" id="acct-pw-status"></div>
      </form>
    `,
    (modal) => {
      modal.querySelector('[data-act="cancel"]').addEventListener('click', close_all_modals);
      modal.querySelector('#acct-pw-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.target);
        const current = String(fd.get('current_password') || '');
        const np = String(fd.get('new_password') || '');
        const cf = String(fd.get('confirm_password') || '');
        const status = modal.querySelector('#acct-pw-status');
        status.className = 'acct-status';
        status.textContent = '';
        if (np.length < 10) {
          status.textContent = 'New password must be at least 10 characters.';
          status.classList.add('acct-status-err');
          return;
        }
        if (np !== cf) {
          status.textContent = "New passwords don't match.";
          status.classList.add('acct-status-err');
          return;
        }
        const body = current
          ? { current_password: current, new_password: np }
          : { new_password: np };
        try {
          const res = await fetch('/api/auth/change_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            status.textContent = data.error || `Failed (HTTP ${res.status})`;
            status.classList.add('acct-status-err');
            return;
          }
          status.textContent = `Password updated (${data.mode || 'rotation'} mode).`;
          status.classList.add('acct-status-ok');
          setTimeout(close_all_modals, 900);
        } catch (err) {
          status.textContent = `Network error: ${err.message || err}`;
          status.classList.add('acct-status-err');
        }
      });
    },
  );
}

function open_set_pin_modal(opts) {
  const rotation = !!(opts && opts.rotation);
  _account_modal_open(
    `
      <h3>${rotation ? 'Change PIN' : 'Set PIN'}</h3>
      <p class="modal-sub">
        ${rotation
          ? 'Enter your current PIN to authorize the change, then choose a new one.'
          : 'Choose a 4-8 digit PIN. You\'ll use this to confirm high-risk actions.'}
      </p>
      <form id="acct-pin-form" autocomplete="off">
        ${rotation ? `
          <label class="acct-field">
            <span>Current PIN</span>
            <input type="text" name="current_pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required>
          </label>
        ` : ''}
        <label class="acct-field">
          <span>New PIN</span>
          <input type="text" name="new_pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required>
        </label>
        <label class="acct-field">
          <span>Confirm new PIN</span>
          <input type="text" name="confirm_pin" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" required>
        </label>
        <div class="acct-actions">
          <button type="button" class="acct-btn acct-btn-secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="acct-btn">Save</button>
        </div>
        <div class="acct-status" id="acct-pin-status"></div>
      </form>
    `,
    (modal) => {
      modal.querySelector('[data-act="cancel"]').addEventListener('click', close_all_modals);
      modal.querySelector('#acct-pin-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const fd = new FormData(ev.target);
        const current_pin = String(fd.get('current_pin') || '');
        const np = String(fd.get('new_pin') || '');
        const cf = String(fd.get('confirm_pin') || '');
        const status = modal.querySelector('#acct-pin-status');
        status.className = 'acct-status';
        status.textContent = '';
        if (!/^\d{4,8}$/.test(np)) {
          status.textContent = 'PIN must be 4-8 digits.';
          status.classList.add('acct-status-err');
          return;
        }
        if (np !== cf) {
          status.textContent = "New PINs don't match.";
          status.classList.add('acct-status-err');
          return;
        }
        const new_pin_hash = await _sha256_hex(np);
        // Rotation: step_up with the OLD PIN first, then set_pin.
        // Bootstrap: skip step_up; the backend allows set_pin when
        // user.must_set_pin is true.
        try {
          if (rotation) {
            if (!/^\d{4,8}$/.test(current_pin)) {
              status.textContent = 'Current PIN must be 4-8 digits.';
              status.classList.add('acct-status-err');
              return;
            }
            const current_hash = await _sha256_hex(current_pin);
            const step = await fetch('/api/auth/step_up', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pin_sha256: current_hash }),
            });
            if (!step.ok) {
              const j = await step.json().catch(() => ({}));
              status.textContent = j.error || `Step-up failed (HTTP ${step.status})`;
              status.classList.add('acct-status-err');
              return;
            }
          }
          const res = await fetch('/api/auth/set_pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin_sha256: new_pin_hash }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            status.textContent = data.error || `Failed (HTTP ${res.status})`;
            status.classList.add('acct-status-err');
            return;
          }
          status.textContent = `PIN ${rotation ? 'changed' : 'set'} (${data.mode || 'rotation'} mode).`;
          status.classList.add('acct-status-ok');
          setTimeout(close_all_modals, 900);
        } catch (err) {
          status.textContent = `Network error: ${err.message || err}`;
          status.classList.add('acct-status-err');
        }
      });
    },
  );
}

// SHA-256 helper using SubtleCrypto when available, falling back to
// pure-JS (mirrors the inlined sha256() in login.html which can't
// depend on SubtleCrypto in plain-HTTP local contexts). Returns
// lowercase hex.
async function _sha256_hex(s) {
  if (window.crypto && window.crypto.subtle) {
    const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Inline fallback — same algorithm as login.html's sha256.
  function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const msg = unescape(encodeURIComponent(s));
  const bytes = Array.from(msg).map((c) => c.charCodeAt(0));
  const len = bytes.length;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const lenBits = len * 8;
  for (let i = 7; i >= 0; i--) bytes.push((lenBits / Math.pow(2, i * 8)) & 0xff);
  for (let i = 0; i < bytes.length; i += 64) {
    const w = [];
    for (let j = 0; j < 16; j++) w[j] = (bytes[i + j*4]<<24)|(bytes[i + j*4 + 1]<<16)|(bytes[i + j*4 + 2]<<8)|bytes[i + j*4 + 3];
    for (let j = 16; j < 64; j++) {
      const s0 = rr(w[j-15],7)^rr(w[j-15],18)^(w[j-15]>>>3);
      const s1 = rr(w[j-2],17)^rr(w[j-2],19)^(w[j-2]>>>10);
      w[j] = (w[j-16]+s0+w[j-7]+s1) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
    for (let j = 0; j < 64; j++) {
      const S1 = rr(e,6)^rr(e,11)^rr(e,25);
      const ch = (e&f)^(~e&g);
      const t1 = (hh+S1+ch+K[j]+w[j])>>>0;
      const S0 = rr(a,2)^rr(a,13)^rr(a,22);
      const mj = (a&b)^(a&c)^(b&c);
      const t2 = (S0+mj)>>>0;
      hh=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+hh)>>>0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map((v) => v.toString(16).padStart(8,'0')).join('');
}

// ── Avatar upload ────────────────────────────────────────────────────────

const avatar_state = { specialist_id: null, picked: null, preview_url: null };

function bust_avatar(specialist_id) {
  const v = Date.now();
  const re = new RegExp(`/app/api/avatars/${specialist_id}(\\?|$)`);
  for (const img of document.querySelectorAll('img')) {
    if (re.test(img.src)) {
      img.src = `/app/api/avatars/${specialist_id}?v=${v}`;
    }
  }
}

function open_avatar_modal(specialist_id) {
  const spec = state.by_id.get(specialist_id);
  if (!spec) return;
  if (avatar_state.preview_url) URL.revokeObjectURL(avatar_state.preview_url);
  avatar_state.specialist_id = specialist_id;
  avatar_state.picked = null;
  avatar_state.preview_url = null;
  document.getElementById('avatar-title').textContent = `Avatar — ${spec.name}`;
  const preview = document.getElementById('avatar-preview');
  preview.src = `/app/api/avatars/${specialist_id}?t=${Date.now()}`;
  preview.alt = spec.name;
  document.getElementById('avatar-save').disabled = true;
  document.getElementById('avatar-drop').classList.remove('dragover');
  document.getElementById('avatar-file').value = '';
  open_modal('modal-avatar');
}

function pick_avatar_file(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    toast('Pick an image file.', true);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('Image larger than 5 MB.', true);
    return;
  }
  if (avatar_state.preview_url) URL.revokeObjectURL(avatar_state.preview_url);
  avatar_state.picked = file;
  avatar_state.preview_url = URL.createObjectURL(file);
  document.getElementById('avatar-preview').src = avatar_state.preview_url;
  document.getElementById('avatar-save').disabled = false;
}

async function save_avatar() {
  if (!avatar_state.specialist_id || !avatar_state.picked) return;
  const id = avatar_state.specialist_id;
  const form = new FormData();
  form.append('file', avatar_state.picked);
  try {
    await api(`/app/api/avatars/${id}`, { method: 'POST', body: form });
    bust_avatar(id);
    toast('Avatar updated.', false, id);
    close_all_modals();
  } catch (err) {
    toast(`Avatar upload failed: ${err.message}`, true);
  }
}

async function revert_avatar() {
  if (!avatar_state.specialist_id) return;
  const id = avatar_state.specialist_id;
  try {
    await api(`/app/api/avatars/${id}`, { method: 'DELETE' });
    bust_avatar(id);
    toast('Reverted to initial.', false, id);
    close_all_modals();
  } catch (err) {
    toast(`Revert failed: ${err.message}`, true);
  }
}

(function init_right_rail_toggle() {
  const layout = document.querySelector('.layout');
  const btn = document.getElementById('rail-right-toggle');
  if (!layout || !btn) return;
  const KEY = 'hearth.right_collapsed';

  function apply(collapsed) {
    layout.classList.toggle('right-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand panel' : 'Collapse panel';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch (_) { /* private mode */ }

  // Apply the persisted state without animating on first paint — suppress the
  // grid transition, commit, then restore so the first real toggle animates.
  const prev = layout.style.transition;
  layout.style.transition = 'none';
  apply(collapsed);
  void layout.offsetWidth;
  layout.style.transition = prev;

  btn.addEventListener('click', () => {
    collapsed = !layout.classList.contains('right-collapsed');
    apply(collapsed);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (_) { /* private mode */ }
  });
})();

(function init_avatar_modal() {
  const drop = document.getElementById('avatar-drop');
  const file_input = document.getElementById('avatar-file');
  drop.addEventListener('click', () => file_input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file_input.click();
    }
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragover');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) pick_avatar_file(file);
  });
  file_input.addEventListener('change', () => {
    const file = file_input.files && file_input.files[0];
    if (file) pick_avatar_file(file);
  });
  document.getElementById('avatar-close').addEventListener('click', close_all_modals);
  document.getElementById('avatar-cancel').addEventListener('click', close_all_modals);
  document.getElementById('avatar-save').addEventListener('click', save_avatar);
  document.getElementById('avatar-revert').addEventListener('click', revert_avatar);

  // Click the avatar in the conv header to open the profile (the edit-
  // pencil overlay on the avatar inside the profile modal is what opens
  // this avatar-upload modal — direct upload moved one click deeper).
  const wrap = document.getElementById('conv-avatar-wrap');
  if (wrap) {
    wrap.addEventListener('click', () => {
      if (state.active_id) open_profile_modal(state.active_id);
    });
  }
})();

// ── Profile modal (Discord-style) ────────────────────────────────────────

async function open_profile_modal(specialist_id) {
  const spec = state.by_id.get(specialist_id);
  if (!spec) return;
  // Optimistic open — render whatever we have, fill in the rest from
  // the profile endpoint once it returns.
  open_modal('modal-profile');
  document.getElementById('profile-name').textContent = spec.name || specialist_id;
  document.getElementById('profile-role').textContent = spec.role || '';
  document.getElementById('profile-meta-line').textContent = '';
  document.getElementById('profile-avatar').src = `/app/api/avatars/${specialist_id}?t=${Date.now()}`;
  document.getElementById('profile-avatar').alt = spec.name || '';
  document.getElementById('profile-banner').style.backgroundImage =
    `url("/app/api/banners/${specialist_id}?t=${Date.now()}")`;
  document.getElementById('profile-body').innerHTML =
    '<div class="profile-empty">Loading profile…</div>';
  document.getElementById('profile-avatar-wrap').dataset.specialistId = specialist_id;
  document.getElementById('profile-banner-edit').dataset.specialistId = specialist_id;

  try {
    const profile = await api(`/app/api/profile/${encodeURIComponent(specialist_id)}`);
    render_profile_body(profile);
  } catch (err) {
    document.getElementById('profile-body').innerHTML =
      `<div class="profile-empty">Failed to load: ${escape_html(err.message)}</div>`;
  }
}

function _humanize_age(days) {
  if (days == null) return null;
  if (days < 1) return 'today';
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  if (days < 365) {
    const m = Math.floor(days / 30);
    return `${m} month${m === 1 ? '' : 's'} ago`;
  }
  const y = (days / 365).toFixed(1);
  return `${y} years ago`;
}

function render_profile_body(p) {
  const meta_bits = [];
  if (p.joined_at) {
    const human = _humanize_age(p.age_days);
    meta_bits.push(`Member since ${_denver_day_label.format(new Date(p.joined_at))}${human ? ` · ${human}` : ''}`);
  }
  if (p.voice) meta_bits.push(`Voice: ${escape_html(p.voice)}`);
  if (p.proactive && p.proactive.mode) meta_bits.push(`Mode: ${escape_html(p.proactive.mode)}`);
  if (p.totals) {
    if (p.totals.total_proposals) meta_bits.push(`${p.totals.total_proposals} proposals`);
    if (p.totals.total_audit_actions) meta_bits.push(`${p.totals.total_audit_actions} actions`);
  }
  document.getElementById('profile-meta-line').innerHTML =
    meta_bits.map((b, i) => i === 0 ? b : `<span class="dot">${b}</span>`).join('');

  const body = document.getElementById('profile-body');
  body.innerHTML = '';

  // Persona
  if (p.persona) {
    const sec = document.createElement('div');
    sec.className = 'profile-section';
    sec.innerHTML =
      `<h3>About</h3>` +
      `<div class="profile-persona">${escape_html(p.persona)}</div>`;
    body.appendChild(sec);
  }

  // Recent training (persona_tuning proposals authored by anyone targeting
  // this specialist, OR proposals this specialist authored that look like
  // tool/training work). For now we surface persona_tuning + any proposal
  // in (pending|approved|executed) that this specialist authored.
  const training = (p.recent_proposals || []).filter((x) => x.kind === 'persona_tuning');
  const recent_props = (p.recent_proposals || []).filter((x) => x.kind !== 'persona_tuning');
  if (training.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'profile-section';
    sec.innerHTML = `<h3>Recent training</h3><div class="profile-list" id="profile-training"></div>`;
    body.appendChild(sec);
    for (const t of training) sec.querySelector('#profile-training').appendChild(_profile_proposal_row(t));
  }

  // Recent proposals
  {
    const sec = document.createElement('div');
    sec.className = 'profile-section';
    sec.innerHTML = `<h3>Recent proposals</h3>` +
      (recent_props.length === 0
        ? `<div class="profile-empty">None yet.</div>`
        : `<div class="profile-list" id="profile-props"></div>`);
    body.appendChild(sec);
    if (recent_props.length > 0) {
      for (const x of recent_props) sec.querySelector('#profile-props').appendChild(_profile_proposal_row(x));
    }
  }

  // Recent activity (audit)
  {
    const sec = document.createElement('div');
    sec.className = 'profile-section';
    sec.innerHTML = `<h3>Recent activity</h3>` +
      ((p.recent_activity || []).length === 0
        ? `<div class="profile-empty">No tool calls logged yet.</div>`
        : `<div class="profile-list" id="profile-activity"></div>`);
    body.appendChild(sec);
    if ((p.recent_activity || []).length > 0) {
      const root = sec.querySelector('#profile-activity');
      for (const a of p.recent_activity) {
        const row = document.createElement('div');
        row.className = 'profile-list-item';
        row.innerHTML =
          `<span class="ts">${escape_html(relative_time(a.ts))}</span>` +
          `<span class="kind">${escape_html(a.tool_name)}</span>` +
          `<span class="text">${escape_html(a.result_summary || '')}</span>` +
          (a.error ? `<span class="status" style="color:var(--danger)">error</span>` : '');
        root.appendChild(row);
      }
    }
  }

  // Capabilities + knowledge_scope chips
  if ((p.capabilities || []).length > 0) {
    const sec = document.createElement('div');
    sec.className = 'profile-section';
    sec.innerHTML = `<h3>Capabilities</h3><div class="profile-chips" id="profile-caps"></div>`;
    body.appendChild(sec);
    const root = sec.querySelector('#profile-caps');
    for (const c of p.capabilities) {
      const chip = document.createElement('span');
      chip.className = 'profile-chip';
      chip.textContent = c;
      root.appendChild(chip);
    }
  }
  if ((p.knowledge_scope || []).length > 0) {
    const sec = document.createElement('div');
    sec.className = 'profile-section';
    sec.innerHTML = `<h3>Knowledge scope</h3><div class="profile-chips" id="profile-scope"></div>`;
    body.appendChild(sec);
    const root = sec.querySelector('#profile-scope');
    for (const c of p.knowledge_scope) {
      const chip = document.createElement('span');
      chip.className = 'profile-chip';
      chip.textContent = c;
      root.appendChild(chip);
    }
  }

  // Memory excerpt
  if (p.memory_excerpt) {
    const sec = document.createElement('div');
    sec.className = 'profile-section';
    sec.innerHTML = `<h3>Memory excerpt</h3>` +
      `<div class="profile-memory">${escape_html(p.memory_excerpt)}</div>`;
    body.appendChild(sec);
  }

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'profile-actions';
  actions.innerHTML = `
    <button class="btn" id="profile-view-library">View library</button>
    <button class="btn" id="profile-open-chat">Open chat</button>
  `;
  body.appendChild(actions);
  actions.querySelector('#profile-view-library').addEventListener('click', async () => {
    close_all_modals();
    await switch_specialist(p.id);
    set_mobile_pane('library');
  });
  actions.querySelector('#profile-open-chat').addEventListener('click', async () => {
    close_all_modals();
    await switch_specialist(p.id);
    set_mobile_pane('chat');
  });
}

function _profile_proposal_row(prop) {
  const row = document.createElement('div');
  row.className = 'profile-list-item';
  row.innerHTML =
    `<span class="ts">${escape_html(relative_time(prop.ts_created))}</span>` +
    `<span class="kind">${escape_html(prop.kind)}</span>` +
    `<span class="text">${escape_html(prop.rationale || '')}</span>` +
    `<span class="status">${escape_html(prop.status)}</span>`;
  return row;
}

(function init_profile_modal() {
  document.getElementById('profile-close').addEventListener('click', close_all_modals);
  // Pencil overlay on the profile avatar opens the upload modal.
  document.getElementById('profile-avatar-wrap').addEventListener('click', () => {
    const id = document.getElementById('profile-avatar-wrap').dataset.specialistId;
    if (!id) return;
    close_all_modals();
    open_avatar_modal(id);
  });
  // Banner edit chip opens the banner upload picker.
  document.getElementById('profile-banner-edit').addEventListener('click', () => {
    const id = document.getElementById('profile-banner-edit').dataset.specialistId;
    if (!id) return;
    pick_and_upload_banner(id);
  });
})();

async function pick_and_upload_banner(specialist_id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast('Banner larger than 8 MB.', true);
      return;
    }
    const form = new FormData();
    form.append('file', file);
    try {
      await api(`/app/api/banners/${specialist_id}`, { method: 'POST', body: form });
      const bust = `/app/api/banners/${specialist_id}?v=${Date.now()}`;
      document.getElementById('profile-banner').style.backgroundImage = `url("${bust}")`;
      toast('Banner updated.', false, specialist_id);
    } catch (err) {
      toast(`Banner upload failed: ${err.message}`, true);
    }
  });
  input.click();
}

// ── Search ───────────────────────────────────────────────────────────────

const search_input = document.getElementById('search-input');
const search_results = document.getElementById('search-results');
const search_scopes = document.getElementById('search-scopes');
let search_scope = 'all';
let search_focused_idx = -1;
let search_hits = [];

document.getElementById('btn-search').addEventListener('click', () => {
  open_modal('modal-search');
  search_input.value = '';
  search_results.innerHTML = '';
  setTimeout(() => search_input.focus(), 20);
});
document.getElementById('search-close').addEventListener('click', close_all_modals);

search_scopes.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  for (const c of search_scopes.querySelectorAll('.chip')) c.classList.remove('active');
  btn.classList.add('active');
  search_scope = btn.dataset.scope;
  run_search();
});

let search_timer = null;
search_input.addEventListener('input', () => {
  if (search_timer) clearTimeout(search_timer);
  search_timer = setTimeout(run_search, 200);
});

search_input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { close_all_modals(); return; }
  if (e.key === 'ArrowDown') {
    search_focused_idx = Math.min(search_hits.length - 1, search_focused_idx + 1);
    update_search_focus();
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    search_focused_idx = Math.max(0, search_focused_idx - 1);
    update_search_focus();
    e.preventDefault();
  } else if (e.key === 'Enter' && search_focused_idx >= 0) {
    activate_search_hit(search_hits[search_focused_idx]);
  }
});

async function run_search() {
  const q = search_input.value.trim();
  if (!q) { search_results.innerHTML = ''; return; }
  try {
    const out = await api(`/app/api/search?q=${encodeURIComponent(q)}&scope=${search_scope}`);
    render_search_results(out);
  } catch (err) {
    search_results.innerHTML = `<div class="rail-empty">Search failed: ${escape_html(err.message)}</div>`;
  }
}

function render_search_results(out) {
  search_results.innerHTML = '';
  search_hits = [];
  search_focused_idx = -1;
  const groups = [
    { key: 'chat', label: '📋 Chat history', items: out.chat || [] },
    { key: 'vault', label: '📚 Vault', items: out.vault || [] },
    { key: 'proposals', label: '⏰ Proposals', items: out.proposals || [] },
  ];
  let any = false;
  for (const g of groups) {
    if (g.items.length === 0) continue;
    any = true;
    const grp = document.createElement('div');
    grp.className = 'search-group';
    grp.innerHTML = `<h4>${g.label} (${g.items.length})</h4>`;
    for (const it of g.items) {
      const hit = document.createElement('div');
      hit.className = 'search-hit';
      const title =
        g.key === 'chat'
          ? `${state.by_id.get(it.specialist_id)?.name || it.role} · ${relative_time(it.ts)}`
          : g.key === 'vault'
            ? it.note_path
            : `${proposal_title({ kind: it.kind, specialist_id: it.specialist_id, payload_json: '{}', rationale_md: it.snippet })} · ${relative_time(it.ts_created)}`;
      hit.innerHTML = `<div>${escape_html(title)}</div><div class="search-hit-snippet">${escape_html(it.snippet || '')}</div>`;
      const ref = { group: g.key, ...it };
      hit.addEventListener('click', () => activate_search_hit(ref));
      grp.appendChild(hit);
      search_hits.push(ref);
    }
    search_results.appendChild(grp);
  }
  if (!any) {
    search_results.innerHTML = `<div class="rail-empty">No results.</div>`;
  }
}

function update_search_focus() {
  const all = search_results.querySelectorAll('.search-hit');
  for (let i = 0; i < all.length; i++) {
    all[i].classList.toggle('focused', i === search_focused_idx);
  }
  if (search_focused_idx >= 0) {
    all[search_focused_idx]?.scrollIntoView({ block: 'nearest' });
  }
}

async function activate_search_hit(hit) {
  if (!hit) return;
  close_all_modals();
  if (hit.group === 'chat') {
    // Jump to the conversation.
    const conv = await api(`/api/conversations`);
    const target = (conv.conversations || []).find((c) => c.id === hit.conversation_id);
    if (target) {
      state.active_id = target.specialist_id;
      state.conv_id = target.id;
      await switch_specialist(target.specialist_id);
      await load_messages(target.id);
      const el = messages_el.querySelector(`[data-message-id="${hit.message_id}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  } else if (hit.group === 'proposals') {
    open_queue_modal();
  } else if (hit.group === 'vault') {
    toast(`Vault hit: ${hit.note_path}`);
  }
}

// ── Queue overlay ────────────────────────────────────────────────────────

document.getElementById('btn-queue').addEventListener('click', open_queue_modal);
document.getElementById('queue-close').addEventListener('click', close_all_modals);
document.getElementById('library-detail-close').addEventListener('click', close_all_modals);

function open_queue_modal() {
  // Restore the default "Awaiting your nod" header in case a prior
  // recommendation modal left it overwritten.
  const header_h2 = document.querySelector('#modal-queue .modal-header h2');
  if (header_h2) header_h2.textContent = 'Awaiting your nod';
  open_modal('modal-queue');
  render_queue_modal();
}

function render_queue_modal() {
  const list = document.getElementById('queue-list');
  list.innerHTML = '';
  if (state.proposals.length === 0) {
    list.innerHTML = `<div class="rail-empty" style="padding: 32px; text-align: center;">Nothing in your queue. Kate has things in hand.</div>`;
    return;
  }
  for (const p of state.proposals) {
    const card = render_proposal_card(p);
    card.style.maxWidth = 'none';
    card.style.marginBottom = '12px';
    list.appendChild(card);
  }
}

// Reuses the queue modal but shows a single recommendation. Header
// flips to "Recommendation from <name>" so Jasper knows this isn't
// gated work. Approve / Deny on a recommendation = "save" / "dismiss"
// — same buttons, lower stakes; the kind difference is in the framing,
// not the verb names (changing those touches too many code paths).
function open_recommendation_modal(p_id) {
  const p = (state.recommendations ?? []).find((x) => x.id === p_id);
  if (!p) {
    open_queue_modal();
    return;
  }
  const header_h2 = document.querySelector('#modal-queue .modal-header h2');
  const author = state.by_id.get(p.specialist_id)?.name || p.specialist_id;
  if (header_h2) header_h2.textContent = `Recommendation from ${author}`;
  open_modal('modal-queue');
  const list = document.getElementById('queue-list');
  list.innerHTML = '';
  const card = render_proposal_card(p);
  card.style.maxWidth = 'none';
  card.style.marginBottom = '12px';
  list.appendChild(card);
}

// ── Roadmap overlay ──────────────────────────────────────────────────────
//
// Renders PLAN.md (parsed server-side into structured sections + items) as
// collapsible cards with filter pills. Live-updates via SSE roadmap_updated
// — the file on disk is the truth, this view reflects it within ~150ms of
// a save. See src/app/routes/roadmap.ts for the parser shape.

let _roadmap_data = null;     // { sections, mtime, raw } — last fetched
let _roadmap_filter = 'all';  // 'all' | 'not_started' | 'in_flight' | 'blocked' | 'done'

document.getElementById('btn-roadmap').addEventListener('click', open_roadmap_modal);
document.getElementById('roadmap-close').addEventListener('click', close_all_modals);

// Agent Rooms — owner-only multi-specialist group chat modal.
document.getElementById('btn-rooms').addEventListener('click', open_rooms_modal);
document.getElementById('rooms-close').addEventListener('click', close_all_modals);

// ── Mobile overflow menu ─────────────────────────────────────────────────
// The mobile topbar can only fit a few icons. The overflow button opens a
// pop-up menu listing the secondary actions. Tapping an item delegates to
// the actual button's handler (which lives on the now-hidden desktop
// icon), so behavior stays in lockstep with the desktop path.
const _overflow_btn   = document.getElementById('btn-overflow');
const _overflow_sheet = document.getElementById('overflow-sheet');
const _overflow_items = [
  { id: 'btn-search',    label: 'Search',     icon: '🔍', shortcut: '⌘K' },
  { id: 'btn-queue',     label: 'Queue',      icon: '⏰', badge_id: 'overflow-queue-badge' },
  { id: 'btn-subagents', label: 'Sub-agents', icon: '🐝', badge_id: 'overflow-subagents-badge' },
  { id: 'btn-rooms',     label: 'Agent Rooms', icon: '🎭' },
  { id: 'btn-files',     label: 'Library',    icon: '📁' },
  { id: 'btn-roadmap',   label: 'Roadmap',    icon: '🗺️' },
  { id: 'btn-settings',  label: 'Settings',   icon: '⚙️', mirror_open: open_settings },
];
function _build_overflow_sheet() {
  _overflow_sheet.innerHTML = '';
  for (const item of _overflow_items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'overflow-row';
    row.dataset.targetId = item.id;
    row.innerHTML =
      `<span class="overflow-row-icon">${item.icon}</span>` +
      `<span class="overflow-row-label">${escape_html(item.label)}</span>` +
      (item.shortcut ? `<span class="overflow-row-shortcut">${item.shortcut}</span>` : '') +
      (item.badge_id ? `<span class="overflow-row-badge" id="${item.badge_id}" hidden></span>` : '');
    row.addEventListener('click', () => {
      _overflow_sheet.hidden = true;
      _overflow_btn.setAttribute('aria-expanded', 'false');
      // Prefer a direct open-function for items whose desktop button
      // doesn't exist or isn't wired in mobile mode; otherwise click
      // the underlying button to re-use its handler.
      if (item.mirror_open) { item.mirror_open(); return; }
      const target = document.getElementById(item.id);
      if (target) target.click();
    });
    _overflow_sheet.appendChild(row);
  }
}
_build_overflow_sheet();

_overflow_btn.addEventListener('click', (e) => {
  e.stopPropagation();
  const showing = !_overflow_sheet.hidden;
  if (showing) {
    _overflow_sheet.hidden = true;
    _overflow_btn.setAttribute('aria-expanded', 'false');
    return;
  }
  const rect = _overflow_btn.getBoundingClientRect();
  // Anchor below the button, right-aligned, comfortably inset from the edge.
  _overflow_sheet.style.top = `${rect.bottom + 8}px`;
  _overflow_sheet.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  _overflow_sheet.hidden = false;
  _overflow_btn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => {
  if (_overflow_sheet.hidden) return;
  if (_overflow_sheet.contains(e.target) || _overflow_btn.contains(e.target)) return;
  _overflow_sheet.hidden = true;
  _overflow_btn.setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !_overflow_sheet.hidden) {
    _overflow_sheet.hidden = true;
    _overflow_btn.setAttribute('aria-expanded', 'false');
  }
});

// Mirror the queue badge into the overflow row badge.
function _mirror_overflow_queue_badge() {
  const pairs = [
    ['queue-badge', 'overflow-queue-badge'],
    ['subagents-badge', 'overflow-subagents-badge'],
  ];
  for (const [src_id, dst_id] of pairs) {
    const src = document.getElementById(src_id);
    const dst = document.getElementById(dst_id);
    if (!src || !dst) continue;
    if (src.hidden) {
      dst.hidden = true;
      dst.textContent = '';
    } else {
      dst.hidden = false;
      dst.textContent = src.textContent || '';
    }
  }
}
// Hook into the existing badge mutation by polling — cheap and avoids
// rewriting the badge-update code path. The badge changes maybe a few
// times a minute.
setInterval(_mirror_overflow_queue_badge, 1500);
_mirror_overflow_queue_badge();

document.getElementById('roadmap-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  for (const c of document.querySelectorAll('#roadmap-filters .chip')) {
    c.classList.remove('active');
  }
  btn.classList.add('active');
  _roadmap_filter = btn.dataset.filter || 'all';
  render_roadmap();
});

async function open_roadmap_modal() {
  open_modal('modal-roadmap');
  await fetch_roadmap();
}

async function fetch_roadmap() {
  try {
    const resp = await fetch('/app/api/roadmap', { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _roadmap_data = await resp.json();
  } catch (err) {
    _roadmap_data = null;
    const body = document.getElementById('roadmap-body');
    if (body) body.innerHTML =
      `<div class="roadmap-error">Couldn't load PLAN.md: ${err.message}</div>`;
    return;
  }
  render_roadmap();
}

function render_roadmap() {
  const body = document.getElementById('roadmap-body');
  if (!body || !_roadmap_data) return;
  const { sections, mtime } = _roadmap_data;

  // Header mtime indicator.
  const mtime_el = document.getElementById('roadmap-mtime');
  if (mtime_el && mtime) {
    const d = new Date(mtime);
    mtime_el.textContent = `· updated ${_format_relative_time(d)}`;
  }

  // Aggregate counts across ALL sections (not filtered) so the toolbar
  // shows the true distribution.
  const counts = { not_started: 0, in_flight: 0, blocked: 0, done: 0 };
  for (const s of sections) {
    for (const it of s.items) counts[it.status] = (counts[it.status] || 0) + 1;
  }
  const counts_el = document.getElementById('roadmap-counts');
  if (counts_el) {
    counts_el.innerHTML =
      `<span class="rm-count rm-count-in-flight">⏳ ${counts.in_flight} in flight</span>` +
      `<span class="rm-count rm-count-blocked">⚠ ${counts.blocked} blocked</span>` +
      `<span class="rm-count rm-count-not-started">○ ${counts.not_started} queued</span>` +
      `<span class="rm-count rm-count-done">✓ ${counts.done} shipped</span>`;
  }

  // Render sections matching the filter.
  body.innerHTML = '';
  for (const sec of sections) {
    const items = sec.items.filter(
      (it) => _roadmap_filter === 'all' || it.status === _roadmap_filter,
    );
    if (items.length === 0) continue;
    const section_el = document.createElement('section');
    section_el.className = `rm-section rm-section-${_slug(sec.title)}`;
    const header = document.createElement('header');
    header.className = 'rm-section-header';
    header.innerHTML =
      `<h3>${_escape(sec.title)} <span class="rm-section-count">${items.length}</span></h3>` +
      (sec.subtitle ? `<div class="rm-section-subtitle">${_escape(sec.subtitle)}</div>` : '');
    section_el.appendChild(header);
    const list = document.createElement('div');
    list.className = 'rm-items';
    for (const it of items) list.appendChild(render_roadmap_item(it));
    section_el.appendChild(list);
    body.appendChild(section_el);
  }

  if (!body.children.length) {
    body.innerHTML = `<div class="roadmap-empty">No items match this filter.</div>`;
  }
}

function render_roadmap_item(it) {
  const card = document.createElement('article');
  card.className = `rm-item rm-status-${it.status}`;
  // Click toggles body expansion.
  card.tabIndex = 0;
  card.addEventListener('click', () => card.classList.toggle('rm-expanded'));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      card.classList.toggle('rm-expanded');
    }
  });

  const badge = {
    not_started: '○',
    in_flight: '⏳',
    blocked: '⚠',
    done: '✓',
  }[it.status] || '·';

  const meta_bits = [];
  if (it.ship_date) meta_bits.push(`<span class="rm-meta-date">${it.ship_date}</span>`);
  if (it.commit) {
    // Link to Gitea by default; GitHub is the mirror.
    const url = `http://the always-on host.local:3010/jasper/hearth/commit/${it.commit}`;
    meta_bits.push(
      `<a class="rm-meta-commit" href="${url}" target="_blank" rel="noopener"
          onclick="event.stopPropagation()">${it.commit.slice(0, 7)}</a>`,
    );
  }

  card.innerHTML =
    `<div class="rm-item-row">` +
      `<span class="rm-status-badge" aria-label="${it.status}">${badge}</span>` +
      `<span class="rm-item-title">${_escape(it.title)}</span>` +
      (meta_bits.length ? `<span class="rm-meta">${meta_bits.join('')}</span>` : '') +
    `</div>` +
    (it.body ? `<div class="rm-item-body">${render_md(it.body)}</div>` : '');
  return card;
}

function _format_relative_time(d) {
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

function _slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function _escape(s) {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

// ── Settings modal ───────────────────────────────────────────────────────

// btn-settings was removed in Phase 1e — Settings now lives inside
// the user-bubble dropdown. Keep this guard so any legacy reference
// to the gear icon doesn't throw.
const _legacy_settings_btn = document.getElementById('btn-settings');
if (_legacy_settings_btn) _legacy_settings_btn.addEventListener('click', open_settings);
document.getElementById('settings-close').addEventListener('click', close_all_modals);

async function open_settings() {
  open_modal('modal-settings');
  const body = document.getElementById('settings-body');
  let status = null;
  try {
    status = await api('/status');
  } catch {}
  body.innerHTML = '';
  body.appendChild(settings_appearance());
  body.appendChild(settings_behavior());
  body.appendChild(settings_conversation());
  body.appendChild(settings_voice());
  body.appendChild(settings_notifications());
  body.appendChild(settings_privacy());
  // Phase 2b — admin Users panel surfaces only for sessions whose
  // user.role === 'admin'. Non-admins (regular users, future Sam)
  // never see it. The panel itself defers the network call until
  // after appending so the rest of Settings renders synchronously.
  if (current_user?.role === 'admin') {
    body.appendChild(settings_admin_users());
  }
  body.appendChild(settings_about(status));
}

// Privacy & Data — the member-facing *provable* cordon. Renders a plain
// statement of who can see this member's data, the live self-test (which
// actually exercises the cordoned read surfaces as them — see
// src/core/privacy_self_test.ts), and their owner-oversight history. The
// network call defers (like the admin panel) so the rest of Settings
// renders synchronously.
function settings_privacy() {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  sec.innerHTML = `
    <h3>Privacy &amp; Data</h3>
    <p class="settings-note">Your private notes, captures, and chats are walled off
      from everyone else — including the owner. Run the live check below: it actually
      tries to reach other members’ data <em>as you</em> and shows what came back.</p>
    <div class="privacy-summary" id="privacy-summary"></div>
    <button class="btn" id="privacy-run">Run privacy check</button>
    <div class="privacy-results" id="privacy-results" aria-live="polite"></div>
    <div class="privacy-oversight" id="privacy-oversight"></div>
    <div class="privacy-ledger" id="privacy-ledger"></div>
  `;

  const results = sec.querySelector('#privacy-results');
  const summary = sec.querySelector('#privacy-summary');
  const oversight = sec.querySelector('#privacy-oversight');
  const ledger = sec.querySelector('#privacy-ledger');
  const btn = sec.querySelector('#privacy-run');

  const fmt_date = (iso) => {
    try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
    catch { return iso; }
  };

  async function run() {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = 'Checking…';
    results.innerHTML = '';
    try {
      const r = await api('/api/users/privacy/report');

      summary.innerHTML = `
        <p class="privacy-rule">${escape_html(r.rule_summary || '')}</p>
        <ul class="privacy-guarantees">
          ${(r.guarantees || []).map((g) => `<li>${escape_html(g)}</li>`).join('')}
        </ul>`;

      const badge = r.overall_passed
        ? `<div class="privacy-badge ok">✓ Verified — no other member’s data is reachable by you</div>`
        : `<div class="privacy-badge bad">⚠ A check did not pass — see below</div>`;

      const probes = (r.probes || []).map((p) => {
        const probed = (p.actively_probed != null && p.actively_probed !== p.belonging_to_others)
          ? ` <span class="privacy-probe-sample">(live-searched ${p.actively_probed})</span>` : '';
        return `
          <div class="privacy-probe ${p.passed ? 'ok' : 'bad'}">
            <span class="privacy-mark">${p.passed ? '✓' : '✗'}</span>
            <div class="privacy-probe-body">
              <div class="privacy-probe-label">${escape_html(p.label)}</div>
              <div class="privacy-probe-count">
                <strong>${p.belonging_to_others}</strong> belong to other members${probed} ·
                <strong>${p.reachable_by_you}</strong> reachable by you
              </div>
              <div class="privacy-probe-desc">${escape_html(p.description)}</div>
            </div>
          </div>`;
      }).join('');

      results.innerHTML = badge + probes;

      const ex = r.exception || {};
      if (ex.used_count > 0) {
        oversight.innerHTML = `
          <h4>Owner oversight history</h4>
          <p class="settings-note">${escape_html(ex.explanation || '')}</p>
          <ul class="privacy-oversight-list">
            ${(ex.history || []).map((h) => `<li>${escape_html(h.reviewer)} reviewed a summary of your activity on ${fmt_date(h.at)}</li>`).join('')}
          </ul>`;
      } else {
        oversight.innerHTML = `
          <h4>Owner oversight history</h4>
          <p class="settings-note">No one has ever viewed a summary of your activity. ${escape_html(ex.explanation || '')}</p>`;
      }

      // Tamper-evident ledger (Phase 1b).
      const L = r.ledger || {};
      if (L.status === 'intact') {
        const span = L.scope === 'full' ? 'every entry' : `the ${L.entries_verified} most recent entries`;
        ledger.innerHTML = `
          <h4>Tamper-evident record</h4>
          <div class="privacy-badge ok">🔒 Verified — ${span} form an unbroken chain</div>
          <p class="settings-note">Every entry above is cryptographically linked to the one before it, so an edit or deletion can’t go unnoticed — ${L.total_entries} sealed ${L.total_entries === 1 ? 'entry' : 'entries'}.</p>`;
      } else if (L.status === 'broken') {
        ledger.innerHTML = `
          <h4>Tamper-evident record</h4>
          <div class="privacy-badge bad">⚠ Integrity check FAILED — the activity record may have been altered. Tell the owner.</div>`;
      } else {
        ledger.innerHTML = '';
      }
    } catch (err) {
      results.innerHTML = `<div class="privacy-badge bad">Couldn’t run the check: ${escape_html(err.message || String(err))}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  btn.addEventListener('click', run);
  // Defer the network call so Settings renders synchronously, then run once.
  setTimeout(run, 0);
  return sec;
}

function settings_appearance() {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  sec.innerHTML = `
    <h3>Appearance</h3>
    <div class="settings-row">
      <label>Theme</label>
      <select id="set-theme">
        <option value="auto">Auto</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
        <option value="gilded">Gilded · warm</option>
        <option value="frosted">Frosted · cool</option>
      </select>
    </div>
    <div class="settings-row">
      <label>Density</label>
      <select id="set-density">
        <option value="comfortable">Comfortable</option>
        <option value="compact">Compact</option>
      </select>
    </div>
  `;
  sec.querySelector('#set-theme').value = state.settings.theme;
  sec.querySelector('#set-density').value = state.settings.density;
  sec.querySelector('#set-theme').addEventListener('change', (e) => {
    state.settings.theme = e.target.value; save_settings(); apply_settings();
  });
  sec.querySelector('#set-density').addEventListener('change', (e) => {
    state.settings.density = e.target.value; save_settings(); apply_settings();
  });
  return sec;
}

function settings_behavior() {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  sec.innerHTML = `<h3>Behavior</h3>`;
  const rows = [
    ['show_details', 'Show tool-call details inline (power-user)'],
    ['ack_library', 'Specialists acknowledge new library items'],
    ['toast_proposals', 'Toast notifications for proposals'],
    ['toast_interrupts', 'Toast notifications for interrupts'],
    ['show_reasoning', 'Show reasoning traces (lengthy; default off)'],
    ['show_surface_indicators', 'Show message surface (📱/💻/🎤) next to timestamp'],
    ['consult_rail_glow',    'Receiver row glows in the rail when she is being consulted (cozy themes)'],
    ['consult_thread_motes', 'Stream of warm motes drifts across the rail during a consult (cozy themes)'],
  ];
  for (const [key, label] of rows) {
    const row = document.createElement('div');
    // toggle-row tells the mobile CSS to keep label + switch on one
    // row rather than stacking (the default mobile pattern for
    // label+input pairs).
    row.className = 'settings-row toggle-row';
    row.innerHTML = `<label>${label}</label><span class="toggle${state.settings[key] ? ' on' : ''}"></span>`;
    row.querySelector('.toggle').addEventListener('click', (e) => {
      state.settings[key] = !state.settings[key];
      save_settings(); apply_settings();
      e.currentTarget.classList.toggle('on', state.settings[key]);
      if (state.conv_id) load_messages(state.conv_id);
    });
    sec.appendChild(row);
  }
  return sec;
}

function settings_conversation() {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  sec.innerHTML = `
    <h3>Conversation</h3>
    <div class="settings-row">
      <label>Default landing</label>
      <select id="set-landing">
        <option value="kate">Kate</option>
        <option value="last">Last active specialist</option>
      </select>
    </div>
  `;
  sec.querySelector('#set-landing').value = state.settings.default_landing;
  sec.querySelector('#set-landing').addEventListener('change', (e) => {
    state.settings.default_landing = e.target.value;
    save_settings();
  });
  return sec;
}

// Kate's spoken voice register — the SERVER-side per-user setting the gapless
// voice orb (/api/voice/stream) applies as one instruct for the whole reply.
// Options come from the server (intimate tones only surface for the owner); the
// picker fetches the current value on open and POSTs on change. Defers its
// network call like the privacy panel so Settings renders synchronously.
function settings_voice() {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  sec.innerHTML = `
    <h3>Kate’s voice</h3>
    <p class="settings-note">How Kate sounds when she speaks (voice orb). <strong>Neutral</strong>
      is plain; <strong>Auto</strong> lets her pick a tone per reply; the rest pin a fixed register.</p>
    <div class="settings-row">
      <label>Spoken register</label>
      <select id="set-voice-emotion" disabled><option>Loading…</option></select>
    </div>
    <div class="settings-note" id="set-voice-emotion-note" aria-live="polite"></div>
  `;
  const sel = sec.querySelector('#set-voice-emotion');
  const note = sec.querySelector('#set-voice-emotion-note');

  async function load() {
    try {
      const r = await api('/api/voice/emotion_setting');
      sel.innerHTML = (r.options || [])
        .map((o) => `<option value="${escape_html(o.value)}">${escape_html(o.label)}</option>`)
        .join('');
      sel.value = r.mode || 'neutral';
      sel.disabled = !r.can_set;
      note.textContent = r.enabled
        ? ''
        : 'Spoken emotion is currently off system-wide — your choice is saved and takes effect once it’s enabled.';
    } catch (err) {
      sel.innerHTML = `<option>Unavailable</option>`;
      note.textContent = `Couldn’t load voice settings: ${err.message || String(err)}`;
    }
  }

  sel.addEventListener('change', async (e) => {
    const mode = e.target.value;
    sel.disabled = true;
    try {
      await api('/api/voice/emotion_setting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      toast(`Kate’s voice set to ${mode}.`);
    } catch (err) {
      toast(err.message || 'Could not update voice.', true);
      await load(); // revert to the server's truth (e.g. an owner-only tone)
    } finally {
      sel.disabled = false;
    }
  });

  setTimeout(load, 0);
  return sec;
}

function settings_notifications() {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  sec.innerHTML = `
    <h3>Notifications</h3>
    <div class="settings-row">
      <label>Quiet hours</label>
      <span id="set-quiet-hours">—</span>
    </div>
  `;
  // Populate quiet hours (gates APNs pushes by severity).
  const u_id = 'jasper';
  fetch('/api/users/quiet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: u_id, arg: 'status' }),
  })
    .then((r) => r.json())
    .then((q) => {
      const el = sec.querySelector('#set-quiet-hours');
      if (q.configured) {
        el.textContent = `${q.configured.start} → ${q.configured.end} (${q.configured.timezone})` +
          (q.manual ? ` · manual ${q.manual.mode}` : '');
      } else {
        el.textContent = 'no config';
      }
    })
    .catch(() => {});
  return sec;
}

function settings_about(status) {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  let services_html = '<div class="rail-empty">Loading…</div>';
  if (status) {
    services_html = `
      <div class="settings-row"><label>Service</label><span>${escape_html(status.service)} v${escape_html(status.version)}</span></div>
      <div class="settings-row"><label>Uptime</label><span>${Math.floor(status.uptime_s / 60)}m</span></div>
      <div class="settings-row"><label>Vault</label><span style="font-family: monospace; font-size: 12px;">${escape_html(status.vault_root)}</span></div>
      <div class="settings-row"><label>Ollama</label><span style="font-family: monospace; font-size: 12px;">${escape_html(status.ollama_url)}</span></div>
      <div class="settings-row"><label>Specialists loaded</label><span>${(status.specialists || []).length}</span></div>
      <div class="settings-row"><label>SSE subscribers</label><span>${status.sse_subscribers ?? 0}</span></div>
    `;
  }
  sec.innerHTML = `<h3>About</h3>${services_html}`;
  return sec;
}

// ── Admin Users panel (Phase 2b) ─────────────────────────────────────────
//
// Visible only when `current_user.role === 'admin'`. Lists every user
// from /api/admin/users with their tier, allowed_specialists, and PIN
// status; provides controls to toggle the PIN, curate the specialist
// list, and (rarely) change the tier. Save fires PATCH /api/admin/
// users/:id which round-trips the YAML write through users.yaml
// (comments preserved). Chokidar then re-fires reload on the
// orchestrator; the runtime sees the new state on the very next turn.

function settings_admin_users() {
  const sec = document.createElement('div');
  sec.className = 'settings-group';
  sec.innerHTML = `
    <h3>Admin · Users</h3>
    <details class="admin-create-user">
      <summary>+ Add a new user</summary>
      <form class="admin-create-user-form" id="admin-create-user-form" autocomplete="off">
        <div class="admin-create-row">
          <label>Username (id) <span class="hint">lowercase, snake_case</span></label>
          <input name="id" type="text" required pattern="[a-z][a-z0-9_]{0,63}" placeholder="e.g. sara_smith">
        </div>
        <div class="admin-create-row">
          <label>Display name</label>
          <input name="display_name" type="text" required maxlength="80" placeholder="e.g. Sam Smith">
        </div>
        <div class="admin-create-row">
          <label>Email</label>
          <input name="email" type="email" required placeholder="sam@example.com">
        </div>
        <div class="admin-create-row">
          <label>Initial password <span class="hint">min 10 chars — they'll change it on first login</span></label>
          <input name="initial_password" type="text" required minlength="10" placeholder="generate-a-strong-throwaway">
        </div>
        <div class="admin-create-row admin-create-row-2col">
          <div>
            <label>Tier</label>
            <select name="tier">
              <option value="household" selected>household</option>
              <option value="friend">friend</option>
              <option value="owner">owner</option>
            </select>
          </div>
          <div>
            <label>Role</label>
            <select name="role">
              <option value="user" selected>user</option>
              <option value="admin">admin</option>
              <option value="guest">guest</option>
            </select>
          </div>
        </div>
        <div class="admin-create-row">
          <label class="admin-create-checkbox">
            <input name="require_pin" type="checkbox" checked>
            Require PIN setup on first login
          </label>
        </div>
        <div class="admin-create-actions">
          <button type="submit" class="admin-create-btn">Create user</button>
          <span class="admin-create-status" id="admin-create-status"></span>
        </div>
      </form>
    </details>
    <div class="admin-users-list" id="admin-users-list">
      <div class="rail-empty">Loading…</div>
    </div>
  `;
  // Defer the fetch — keep Settings rendering synchronous.
  setTimeout(() => render_admin_users(sec.querySelector('#admin-users-list')), 0);
  // Wire the create form.
  setTimeout(() => _wire_admin_create_user(sec), 0);
  return sec;
}

function _wire_admin_create_user(sec) {
  const form = sec.querySelector('#admin-create-user-form');
  const status = sec.querySelector('#admin-create-status');
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.textContent = '';
    status.className = 'admin-create-status';
    const fd = new FormData(form);
    const body = {
      id: String(fd.get('id') || '').trim(),
      display_name: String(fd.get('display_name') || '').trim(),
      email: String(fd.get('email') || '').trim(),
      initial_password: String(fd.get('initial_password') || ''),
      tier: String(fd.get('tier') || 'household'),
      role: String(fd.get('role') || 'user'),
      require_pin: fd.get('require_pin') === 'on',
    };
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.error || `Failed (HTTP ${res.status})`;
        status.classList.add('admin-create-status-err');
        return;
      }
      status.textContent = `Created "${data.user.id}". Share the initial password — they'll be prompted to change it + set a PIN on first login.`;
      status.classList.add('admin-create-status-ok');
      form.reset();
      // Re-render the list so the new user shows up.
      const list = sec.querySelector('#admin-users-list');
      if (list) render_admin_users(list);
    } catch (err) {
      status.textContent = `Network error: ${err.message || err}`;
      status.classList.add('admin-create-status-err');
    }
  });
}

async function render_admin_users(container) {
  let resp;
  try {
    resp = await api('/api/admin/users');
  } catch (err) {
    container.innerHTML = `<div class="rail-empty">Failed to load: ${escape_html(String(err))}</div>`;
    return;
  }
  const users = resp.users || [];
  if (users.length === 0) {
    container.innerHTML = '<div class="rail-empty">No users configured.</div>';
    return;
  }
  // Pull the specialist roster once so allowed_specialists is curated
  // by checkbox rather than free-text. Failure is non-fatal — fall
  // back to comma-separated input.
  let all_specialists = [];
  try {
    const sresp = await api('/api/specialists');
    all_specialists = (sresp.specialists || []).map((s) => ({ id: s.id, name: s.name }));
  } catch { /* graceful — we render the list without checkboxes */ }

  container.innerHTML = '';
  for (const u of users) {
    container.appendChild(admin_user_row(u, all_specialists));
  }
}

function admin_user_row(u, all_specialists) {
  const row = document.createElement('div');
  row.className = 'admin-user-row';
  row.dataset.userId = u.id;

  const allow_set = u.allowed_specialists === '*'
    ? new Set(all_specialists.map((s) => s.id))
    : new Set(u.allowed_specialists || []);
  const open_to_all = u.allowed_specialists === '*';

  const tg_line = u.telegram_user_id
    ? `<span class="admin-pill admin-pill-info">Telegram bound</span>`
    : '';

  const pin_pill = u.has_pin
    ? `<span class="admin-pill admin-pill-ok">PIN enabled</span>`
    : `<span class="admin-pill admin-pill-warn">PIN disabled</span>`;

  const tier_pill = `<span class="admin-pill admin-pill-tier">${escape_html(u.tier)}</span>`;
  const role_pill = u.role === 'admin'
    ? `<span class="admin-pill admin-pill-admin">admin</span>`
    : '';

  row.innerHTML = `
    <div class="admin-user-head">
      <div class="admin-user-identity">
        <strong>${escape_html(u.display_name)}</strong>
        <span class="admin-user-id">${escape_html(u.id)}</span>
      </div>
      <div class="admin-user-pills">${tier_pill}${role_pill}${pin_pill}${tg_line}</div>
    </div>
    <div class="admin-user-controls">
      <div class="admin-user-row-inline">
        <label>Tier</label>
        <select class="admin-user-tier">
          <option value="owner">owner</option>
          <option value="household">household</option>
          <option value="friend">friend</option>
        </select>
      </div>
      <div class="admin-user-row-inline">
        <label>Email</label>
        <input class="admin-user-email" type="email" maxlength="320"
          placeholder="name@example.com" value="${escape_html(u.email || '')}"/>
      </div>
      <div class="admin-user-specialists">
        <label>Allowed specialists</label>
        <div class="admin-user-spec-mode">
          <label class="admin-radio">
            <input type="radio" name="aspec-mode-${escape_html(u.id)}" value="all" ${open_to_all ? 'checked' : ''}/> All
          </label>
          <label class="admin-radio">
            <input type="radio" name="aspec-mode-${escape_html(u.id)}" value="list" ${open_to_all ? '' : 'checked'}/> Specific list
          </label>
        </div>
        <div class="admin-user-spec-grid" ${open_to_all ? 'hidden' : ''}>
          ${all_specialists.map((s) => `
            <label class="admin-checkbox">
              <input type="checkbox" value="${escape_html(s.id)}" ${allow_set.has(s.id) ? 'checked' : ''}/>
              <span>${escape_html(s.name)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="admin-user-row-inline">
        <label>PIN</label>
        <div class="admin-user-pin-actions">
          <button class="btn" data-action="set-pin">Set new PIN…</button>
          <button class="btn btn-danger" data-action="clear-pin" ${u.has_pin ? '' : 'disabled'}>Disable PIN</button>
        </div>
      </div>
      <div class="admin-user-row-inline admin-user-save-row">
        <span class="admin-user-status" data-role="status"></span>
        <button class="btn btn-primary" data-action="save">Save</button>
      </div>
    </div>
  `;

  // Wire interactions.
  row.querySelector('.admin-user-tier').value = u.tier;
  const mode_inputs = row.querySelectorAll(`input[name="aspec-mode-${u.id}"]`);
  const spec_grid = row.querySelector('.admin-user-spec-grid');
  mode_inputs.forEach((input) => {
    input.addEventListener('change', () => {
      spec_grid.hidden = input.value !== 'list' || !input.checked;
    });
  });

  // Track patch state. Each control mutates a local `patch` object,
  // and Save sends the diff vs the loaded user's values.
  const patch = {};

  row.querySelector('.admin-user-tier').addEventListener('change', (e) => {
    if (e.target.value !== u.tier) patch.tier = e.target.value;
    else delete patch.tier;
  });

  // Email — empty string is the "clear it" sentinel the PATCH route maps
  // back to null. Only diff against the loaded value so an untouched row
  // doesn't send a no-op email patch.
  const orig_email = u.email || '';
  row.querySelector('.admin-user-email').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    if (v !== orig_email) patch.email = v;
    else delete patch.email;
  });
  mode_inputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (input.value === 'all' && input.checked) {
        patch.allowed_specialists = '*';
      } else if (input.value === 'list' && input.checked) {
        const checked_ids = [...spec_grid.querySelectorAll('input[type=checkbox]:checked')]
          .map((c) => c.value);
        patch.allowed_specialists = checked_ids;
      }
    });
  });
  spec_grid.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const checked_ids = [...spec_grid.querySelectorAll('input[type=checkbox]:checked')]
        .map((c) => c.value);
      patch.allowed_specialists = checked_ids;
    });
  });

  const set_pin_btn = row.querySelector('[data-action=set-pin]');
  const clear_pin_btn = row.querySelector('[data-action=clear-pin]');
  const save_btn = row.querySelector('[data-action=save]');
  const status_el = row.querySelector('[data-role=status]');

  set_pin_btn.addEventListener('click', async () => {
    const pin = prompt(`Set a new 4-digit PIN for ${u.display_name}:`);
    if (pin == null) return;
    if (!/^\d{4,8}$/.test(pin)) {
      alert('PIN must be 4–8 digits.');
      return;
    }
    // SHA-256 the PIN locally — same format the verify endpoint expects.
    const buf = new TextEncoder().encode(pin);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    patch.pin_hash = hex;
    status_el.textContent = '✓ PIN queued — click Save to apply';
    status_el.className = 'admin-user-status admin-user-status-ok';
  });

  clear_pin_btn.addEventListener('click', () => {
    if (!confirm(`Disable PIN for ${u.display_name}? They won't be able to sign in until a new PIN is set.`)) return;
    patch.pin_hash = '';
    status_el.textContent = '✓ PIN-disable queued — click Save to apply';
    status_el.className = 'admin-user-status admin-user-status-warn';
  });

  save_btn.addEventListener('click', async () => {
    if (Object.keys(patch).length === 0) {
      status_el.textContent = 'Nothing to save.';
      status_el.className = 'admin-user-status';
      return;
    }
    status_el.textContent = 'Saving…';
    status_el.className = 'admin-user-status';
    save_btn.disabled = true;
    try {
      const resp = await fetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error || `HTTP ${resp.status}`);
      status_el.textContent = '✓ Saved.';
      status_el.className = 'admin-user-status admin-user-status-ok';
      // Refresh the panel after a beat so the row reflects new state.
      setTimeout(() => render_admin_users(row.parentElement), 800);
    } catch (err) {
      status_el.textContent = `✗ ${err.message}`;
      status_el.className = 'admin-user-status admin-user-status-err';
      save_btn.disabled = false;
    }
  });

  return row;
}

// ── Hire modal ───────────────────────────────────────────────────────────

document.getElementById('btn-hire').addEventListener('click', open_hire_modal);
document.getElementById('hire-close').addEventListener('click', close_all_modals);

const HIRE_VOICES = [
  'warm', 'warm-direct', 'warm-precise', 'warm-encyclopedic',
  'warm-archival', 'warm-technical', 'warm-vigilant',
];
const HIRE_CAPS = [
  ['read_vault', 'Read vault', false, true],
  ['read_calendar', 'Read calendar', false, false],
  ['read_home_assistant', 'Read Home Assistant', false, false],
  ['read_audit_log', 'Read audit log', false, false],
  ['read_friday_system', 'Read FRIDAY system', false, false],
  ['read_finance_signals', 'Read finance signals', false, false],
  ['query_web', 'Query the web', false, true],
  ['write_vault_general', 'Write to vault (general)', false, false],
  ['write_proposals', 'Create proposals', false, true],
  ['citation_tracker', 'Citation tracker', false, false],
  ['send_email', 'Send email', true, false],
  ['send_sms', 'Send SMS', true, false],
  ['write_home_assistant', 'Control Home Assistant', true, false],
  ['web_action', 'Web automation', true, false],
  ['spend_money', 'Spend money', true, false],
];

const hire_draft = {
  step: 1,
  id: '', name: '', role: '', voice: 'warm',
  description: '', avatar: '',
  avatar_file: null, avatar_preview_url: null,
  knowledge_scope: [],
  capabilities: Object.fromEntries(HIRE_CAPS.map(([k, , , def]) => [k, def])),
  proactive: { mode: 'reactive', interrupt_threshold: 'medium' },
  persona: '',
};

function open_hire_modal() {
  hire_draft.step = 1;
  if (hire_draft.avatar_preview_url) URL.revokeObjectURL(hire_draft.avatar_preview_url);
  Object.assign(hire_draft, {
    id: '', name: '', role: '', voice: 'warm', description: '',
    avatar: '', avatar_file: null, avatar_preview_url: null,
    knowledge_scope: [],
    capabilities: Object.fromEntries(HIRE_CAPS.map(([k, , , def]) => [k, def])),
    proactive: { mode: 'reactive', interrupt_threshold: 'medium' },
    persona: '',
  });
  open_modal('modal-hire');
  render_hire();
}

function render_hire() {
  const body = document.getElementById('hire-body');
  const footer = document.getElementById('hire-footer');
  body.innerHTML = '';
  footer.innerHTML = `<span class="hire-progress">Step ${hire_draft.step} of 5</span>`;

  if (hire_draft.step === 1) {
    const step = document.createElement('div');
    step.className = 'hire-step active';
    step.innerHTML = `
      <h3>Identity</h3>
      <div class="hire-field">
        <label>Name</label>
        <input id="hire-name" type="text" placeholder="Eleanor" value="${escape_html(hire_draft.name)}"/>
      </div>
      <div class="hire-field">
        <label>Role</label>
        <input id="hire-role" type="text" placeholder="Master Gardener" value="${escape_html(hire_draft.role)}"/>
      </div>
      <div class="hire-field">
        <label>ID (snake_case)</label>
        <input id="hire-id" type="text" placeholder="eleanor" value="${escape_html(hire_draft.id)}"/>
      </div>
      <div class="hire-field">
        <label>Voice family</label>
        <select id="hire-voice">${HIRE_VOICES.map((v) => `<option value="${v}"${v === hire_draft.voice ? ' selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="hire-field">
        <label>Avatar (optional — drop later via Change avatar)</label>
        <div class="hire-avatar-field">
          <img class="hire-avatar-preview" id="hire-avatar-preview" alt=""
               src="${hire_draft.avatar_preview_url || ''}"
               style="${hire_draft.avatar_preview_url ? '' : 'background:var(--surface-2)'}"/>
          <div class="hire-avatar-actions">
            <button type="button" class="btn" id="hire-avatar-pick">Choose image…</button>
            <button type="button" class="btn btn-link" id="hire-avatar-clear" ${hire_draft.avatar_file ? '' : 'hidden'}>Clear</button>
          </div>
          <input type="file" id="hire-avatar-file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden />
        </div>
      </div>
    `;
    body.appendChild(step);
    body.querySelector('#hire-name').addEventListener('input', (e) => {
      hire_draft.name = e.target.value;
      if (!hire_draft.id) hire_draft.id = e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      body.querySelector('#hire-id').value = hire_draft.id;
    });
    body.querySelector('#hire-id').addEventListener('input', (e) => {
      hire_draft.id = e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      e.target.value = hire_draft.id;
    });
    body.querySelector('#hire-role').addEventListener('input', (e) => { hire_draft.role = e.target.value; });
    body.querySelector('#hire-voice').addEventListener('change', (e) => { hire_draft.voice = e.target.value; });
    const file_input = body.querySelector('#hire-avatar-file');
    body.querySelector('#hire-avatar-pick').addEventListener('click', () => file_input.click());
    body.querySelector('#hire-avatar-clear').addEventListener('click', () => {
      if (hire_draft.avatar_preview_url) URL.revokeObjectURL(hire_draft.avatar_preview_url);
      hire_draft.avatar_file = null;
      hire_draft.avatar_preview_url = null;
      render_hire();
    });
    file_input.addEventListener('change', () => {
      const f = file_input.files && file_input.files[0];
      if (!f) return;
      if (!f.type.startsWith('image/')) { toast('Pick an image file.', true); return; }
      if (f.size > 5 * 1024 * 1024) { toast('Image larger than 5 MB.', true); return; }
      if (hire_draft.avatar_preview_url) URL.revokeObjectURL(hire_draft.avatar_preview_url);
      hire_draft.avatar_file = f;
      hire_draft.avatar_preview_url = URL.createObjectURL(f);
      render_hire();
    });
  } else if (hire_draft.step === 2) {
    const step = document.createElement('div');
    step.className = 'hire-step active';
    step.innerHTML = `
      <h3>Domain</h3>
      <div class="hire-field">
        <label>Description (Kate uses this to draft a persona)</label>
        <textarea id="hire-desc" placeholder="A patient, encyclopedic gardener who watches the Pleasantville growing season…">${escape_html(hire_draft.description)}</textarea>
      </div>
      <div class="hire-field">
        <label>Knowledge scope (one path glob per line)</label>
        <textarea id="hire-scope" placeholder="Knowledge/Custom/${hire_draft.name || 'NewName'}/**">${escape_html(hire_draft.knowledge_scope.join('\n'))}</textarea>
      </div>
    `;
    body.appendChild(step);
    body.querySelector('#hire-desc').addEventListener('input', (e) => { hire_draft.description = e.target.value; });
    body.querySelector('#hire-scope').addEventListener('input', (e) => {
      hire_draft.knowledge_scope = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
    });
  } else if (hire_draft.step === 3) {
    const step = document.createElement('div');
    step.className = 'hire-step active';
    step.innerHTML = `<h3>Capabilities</h3><div class="hire-cap-grid" id="hire-caps"></div>`;
    body.appendChild(step);
    const grid = step.querySelector('#hire-caps');
    for (const [key, label, locked] of HIRE_CAPS) {
      const l = document.createElement('label');
      if (locked) l.classList.add('locked');
      l.innerHTML = `
        <input type="checkbox" ${hire_draft.capabilities[key] ? 'checked' : ''} ${locked ? 'disabled' : ''}/>
        <span>${label}${locked ? ' (locked — edit YAML to enable)' : ''}</span>
      `;
      l.querySelector('input').addEventListener('change', (e) => {
        hire_draft.capabilities[key] = e.target.checked;
      });
      grid.appendChild(l);
    }
  } else if (hire_draft.step === 4) {
    const step = document.createElement('div');
    step.className = 'hire-step active';
    step.innerHTML = `
      <h3>Cadence</h3>
      <div class="hire-field">
        <label>Mode</label>
        <select id="hire-mode">
          <option value="reactive">Reactive (on-demand)</option>
          <option value="batched">Batched (scheduled deliberation)</option>
          <option value="active">Active (continuous awareness)</option>
        </select>
      </div>
      <div class="hire-field" id="hire-deliberation-wrap">
        <label>Deliberation times (HH:MM, one per line) — for batched/active</label>
        <textarea id="hire-deliberation"></textarea>
      </div>
      <div class="hire-field">
        <label>Interrupt threshold</label>
        <select id="hire-threshold">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="medium-high">Medium-high</option>
          <option value="high">High</option>
        </select>
      </div>
    `;
    body.appendChild(step);
    body.querySelector('#hire-mode').value = hire_draft.proactive.mode;
    body.querySelector('#hire-threshold').value = hire_draft.proactive.interrupt_threshold || 'medium';
    body.querySelector('#hire-deliberation').value = (hire_draft.proactive.deliberation_at || []).join('\n');
    body.querySelector('#hire-mode').addEventListener('change', (e) => { hire_draft.proactive.mode = e.target.value; });
    body.querySelector('#hire-threshold').addEventListener('change', (e) => { hire_draft.proactive.interrupt_threshold = e.target.value; });
    body.querySelector('#hire-deliberation').addEventListener('input', (e) => {
      const slots = e.target.value.split('\n').map((s) => s.trim()).filter((s) => /^\d{2}:\d{2}$/.test(s));
      hire_draft.proactive.deliberation_at = slots;
    });
  } else if (hire_draft.step === 5) {
    const step = document.createElement('div');
    step.className = 'hire-step active';
    step.innerHTML = `
      <h3>Confirm</h3>
      <div class="hire-field">
        <label>Persona — generated by Kate</label>
        <div class="persona-preview" id="persona-preview">Generating…</div>
      </div>
      <div class="hire-field">
        <label>Edit persona before hiring</label>
        <textarea id="hire-persona" style="min-height: 200px;"></textarea>
      </div>
    `;
    body.appendChild(step);
    generate_persona_preview();
  }

  // Footer buttons.
  if (hire_draft.step > 1) {
    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = '← Back';
    back.addEventListener('click', () => { hire_draft.step--; render_hire(); });
    footer.appendChild(back);
  }
  if (hire_draft.step < 5) {
    const next = document.createElement('button');
    next.className = 'btn btn-primary';
    next.textContent = 'Next →';
    next.addEventListener('click', () => { hire_draft.step++; render_hire(); });
    footer.appendChild(next);
  } else {
    const hire = document.createElement('button');
    hire.className = 'btn btn-primary';
    hire.textContent = 'Hire';
    hire.addEventListener('click', do_hire);
    footer.appendChild(hire);
  }
}

async function generate_persona_preview() {
  const preview = document.getElementById('persona-preview');
  const ta = document.getElementById('hire-persona');
  try {
    const out = await api('/app/api/specialists/preview-persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: hire_draft.id || 'preview',
        name: hire_draft.name,
        role: hire_draft.role,
        voice: hire_draft.voice,
        description: hire_draft.description,
        proactive: hire_draft.proactive,
      }),
    });
    hire_draft.persona = out.persona;
    preview.textContent = out.persona;
    ta.value = out.persona;
  } catch (err) {
    const fallback =
      `You are ${hire_draft.name}, the household's new ${hire_draft.role}.\n\n` +
      `${hire_draft.description}\n\nVoice: ${hire_draft.voice}.`;
    hire_draft.persona = fallback;
    preview.textContent = fallback;
    ta.value = fallback;
  }
  ta.addEventListener('input', (e) => { hire_draft.persona = e.target.value; });
}

async function do_hire() {
  if (!hire_draft.id || !hire_draft.name || !hire_draft.role) {
    toast('Need id, name, and role.', true);
    hire_draft.step = 1; render_hire();
    return;
  }
  try {
    const created = await api('/app/api/specialists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: hire_draft.id,
        name: hire_draft.name,
        role: hire_draft.role,
        voice: hire_draft.voice,
        description: hire_draft.description,
        knowledge_scope: hire_draft.knowledge_scope,
        capabilities: hire_draft.capabilities,
        proactive: hire_draft.proactive,
        persona: hire_draft.persona,
      }),
    });
    if (hire_draft.avatar_file) {
      const form = new FormData();
      form.append('file', hire_draft.avatar_file);
      try {
        await api(`/app/api/avatars/${created.id}`, { method: 'POST', body: form });
      } catch (err) {
        toast(`Hired ${created.name} but avatar upload failed: ${err.message}`, true);
      }
    }
    if (hire_draft.avatar_preview_url) URL.revokeObjectURL(hire_draft.avatar_preview_url);
    hire_draft.avatar_file = null;
    hire_draft.avatar_preview_url = null;
    toast(`Hired ${created.name}.`);
    close_all_modals();
    const list = await api('/api/specialists');
    state.specialists = list.specialists;
    state.by_id = new Map(state.specialists.map((s) => [s.id, s]));
    render_staff();
    await switch_specialist(created.id);
    bust_avatar(created.id);
  } catch (err) {
    toast(`Hiring failed: ${err.message}`, true);
  }
}

// ── Context menu / attach ────────────────────────────────────────────────

function open_context_menu(id) {
  const spec = state.by_id.get(id);
  if (!spec) return;
  open_modal('modal-context');
  document.getElementById('context-title').textContent = `${spec.name}, ${spec.role}`;
  const body = document.getElementById('context-body');
  body.innerHTML = `
    <div class="settings-row"><label>ID</label><span>${escape_html(spec.id)}</span></div>
    <div class="settings-row"><label>Voice</label><span>${escape_html(spec.voice || '')}</span></div>
    <div class="settings-row"><label>Proactive</label><span>${escape_html(JSON.stringify(spec.proactive))}</span></div>
    <div class="settings-row"><label>Knowledge scope</label><span style="font-family: monospace; font-size: 12px;">${escape_html((spec.knowledge_scope || []).join('\n'))}</span></div>
    <div style="margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap;">
      <button class="btn btn-primary" id="ctx-profile">View profile</button>
      <button class="btn" id="ctx-library">View library</button>
      <button class="btn" id="ctx-avatar">Change avatar</button>
    </div>
  `;
  body.querySelector('#ctx-profile').addEventListener('click', () => {
    close_all_modals();
    open_profile_modal(id);
  });
  body.querySelector('#ctx-library').addEventListener('click', async () => {
    close_all_modals();
    await switch_specialist(id);
    set_mobile_pane('library');
  });
  body.querySelector('#ctx-avatar').addEventListener('click', () => {
    close_all_modals();
    open_avatar_modal(id);
  });
}

document.getElementById('context-close').addEventListener('click', close_all_modals);

// Media/file picker → documents to the library, images to the Cordelia
// capture pipeline. Shared by the composer's attach button AND the office
// action bar so capture works from the office without a detour through chat.
function open_media_picker() {
  if (!state.active_id) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true; // select all of an item's photos at once
  input.accept = '.pdf,.docx,.html,.htm,.md,.txt,.png,.jpg,.jpeg,.gif,.webp';
  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const is_image = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp)$/i.test(f.name);
    const images = files.filter(is_image);
    const docs = files.filter((f) => !is_image(f));

    // Documents are reference material -> library (unchanged).
    for (const f of docs) await upload_library_file(f, state.active_id);

    // Images are "an item to act on" -> capture pipeline. Cordelia clusters
    // the burst into one item and routes it (resale items reach Linda, who
    // looks + asks). When the seller is already talking to Linda, pass a
    // listing-intent note so routing is reliable. (Later: key this off a
    // server-advertised "accepts item photos" capability rather than the id.)
    if (images.length) {
      const note = state.active_id === 'linda' ? 'Listing this item for sale.' : undefined;
      let ok = 0;
      for (const f of images) {
        try { await send_capture(f, note); ok += 1; }
        catch (err) { toast(`Couldn't send ${f.name}: ${err.message}`, true); }
      }
      if (ok > 0) {
        toast(
          ok === 1 ? 'Photo sent — it’ll be routed in a moment.'
                   : `${ok} photos sent as one item — routing now.`,
          false,
        );
      }
    }
  });
  input.click();
}
document.getElementById('btn-attach').addEventListener('click', open_media_picker);

// ── Voice transcription (Prompt 7) ───────────────────────────────────────

const voice_state = {
  recording: false,
  recorder: null,
  chunks: [],
  start_ms: 0,
  elapsed_timer: null,
};

const mic_btn = document.getElementById('btn-mic');
const mic_indicator = (() => {
  const span = document.createElement('span');
  span.id = 'mic-indicator';
  span.style.cssText =
    'display:none; margin-left:6px; font-size:12px; color:var(--mic-recording-color, #c43838);';
  span.innerHTML = '<span style="color:#c43838">●</span> <span id="mic-elapsed">0:00</span>';
  mic_btn?.parentElement?.appendChild(span);
  return span;
})();

function format_elapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function start_voice_recording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('This browser cannot capture audio.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime =
      MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
    voice_state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    voice_state.chunks = [];
    voice_state.recording = true;
    voice_state.start_ms = Date.now();
    voice_state.recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) voice_state.chunks.push(e.data);
    });
    voice_state.recorder.addEventListener('stop', () => {
      stream.getTracks().forEach((t) => t.stop());
      void finalize_voice_recording();
    });
    voice_state.recorder.start();
    mic_btn.classList.add('recording');
    mic_btn.textContent = '⏹';
    mic_btn.title = 'Stop recording';
    mic_indicator.style.display = 'inline-block';
    const elapsed_el = document.getElementById('mic-elapsed');
    voice_state.elapsed_timer = setInterval(() => {
      if (!voice_state.recording) return;
      elapsed_el.textContent = format_elapsed(Date.now() - voice_state.start_ms);
    }, 250);
  } catch (err) {
    toast(`Mic permission denied: ${err.message || err}`);
  }
}

function stop_voice_recording() {
  if (!voice_state.recording) return;
  voice_state.recording = false;
  try {
    voice_state.recorder.stop();
  } catch {
    /* ignore */
  }
}

async function finalize_voice_recording() {
  clearInterval(voice_state.elapsed_timer);
  voice_state.elapsed_timer = null;
  mic_btn.classList.remove('recording');
  mic_btn.textContent = '🎤';
  mic_btn.title = 'Record voice memo';
  mic_indicator.style.display = 'none';

  const blob = new Blob(voice_state.chunks, { type: 'audio/webm' });
  if (blob.size < 256) {
    toast('Recording too short.');
    return;
  }

  const fd = new FormData();
  fd.append('file', blob, 'voice.webm');
  fd.append('language', 'en');
  try {
    const resp = await fetch('/app/api/transcribe', { method: 'POST', body: fd });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${resp.status}`);
    }
    const { transcript } = await resp.json();
    if (!transcript) {
      toast('Empty transcript.');
      return;
    }
    // Insert at cursor; do NOT auto-send (per Prompt 7 PART 4).
    const cur = composer_input.value;
    composer_input.value = cur ? `${cur} ${transcript}` : transcript;
    composer_input.focus();
  } catch (err) {
    toast(`Transcription failed: ${err.message || err}`);
  }
}

mic_btn.addEventListener('click', () => {
  if (voice_state.recording) {
    stop_voice_recording();
  } else {
    void start_voice_recording();
  }
});

document.getElementById('btn-new-conv').addEventListener('click', start_new_conversation);

document.getElementById('btn-staff-tab').addEventListener('click', () => set_mobile_pane('staff'));

document.getElementById('modal-backdrop').addEventListener('click', close_all_modals);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    if (state.modal !== 'modal-search') {
      open_modal('modal-search');
      setTimeout(() => search_input.focus(), 20);
    }
  }
  if (e.key === 'Escape' && state.modal) close_all_modals();
});

// ── Mobile tabs ──────────────────────────────────────────────────────────

function set_mobile_pane(pane) {
  const left = document.getElementById('rail-left');
  const center = document.getElementById('center');
  const right = document.getElementById('rail-right');
  left.classList.remove('active');
  center.classList.remove('active');
  right.classList.remove('active');
  if (pane === 'staff') left.classList.add('active');
  else if (pane === 'library') right.classList.add('active');
  else if (pane === 'queue') { open_queue_modal(); return; }
  else center.classList.add('active');
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.pane === pane);
  }
}

function attach_tab_handlers() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => set_mobile_pane(tab.dataset.pane));
  }
  // Default to chat pane on mobile.
  if (window.matchMedia('(max-width: 899px)').matches) {
    set_mobile_pane('chat');
  } else {
    document.getElementById('rail-left').classList.add('active');
    document.getElementById('center').classList.add('active');
    document.getElementById('rail-right').classList.add('active');
  }
}

// ── Global handlers ──────────────────────────────────────────────────────

function attach_global_handlers() {
  // Service worker registration (PWA).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => {});
  }
  attach_keyboard_avoidance();
  attach_mobile_swipe();
}

// On mobile, when the on-screen keyboard slides up, the layout below
// `visualViewport.height` becomes inaccessible — the composer disappears
// behind the keyboard. Translate `viewport.height` shrinkage into a CSS
// custom property that the composer's padding-bottom reads.
function attach_keyboard_avoidance() {
  if (!window.visualViewport) return;
  const root = document.documentElement;
  const update = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty('--kbd-h', `${overlap}px`);
    // Keep the latest message visible above the keyboard.
    if (sticky.pinned) messages_el.scrollTop = messages_el.scrollHeight;
  };
  window.visualViewport.addEventListener('resize', update);
  window.visualViewport.addEventListener('scroll', update);
  update();
}

// Horizontal swipe on the conversation area moves between mobile panes:
//   staff ← chat → library
// Vertical scrolls in the messages list still win; the gesture only
// fires when the horizontal delta dominates and exceeds a comfortable
// threshold.
function attach_mobile_swipe() {
  const order = ['staff', 'chat', 'library'];
  const target = document.querySelector('.layout');
  if (!target) return;
  let start_x = 0, start_y = 0, tracking = false, decided = false, dir = 0;
  target.addEventListener('touchstart', (e) => {
    if (!window.matchMedia('(max-width: 899px)').matches) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    start_x = t.clientX; start_y = t.clientY;
    tracking = true; decided = false; dir = 0;
  }, { passive: true });
  target.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - start_x;
    const dy = t.clientY - start_y;
    if (!decided) {
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
      // If the vertical motion dominates, it's a scroll — bow out.
      if (Math.abs(dy) > Math.abs(dx)) { tracking = false; return; }
      decided = true;
    }
    if (Math.abs(dx) > 70) {
      dir = dx > 0 ? -1 : 1;
      tracking = false;
      const current = current_mobile_pane();
      const idx = order.indexOf(current);
      const next_idx = Math.min(order.length - 1, Math.max(0, idx + dir));
      if (next_idx !== idx) set_mobile_pane(order[next_idx]);
    }
  }, { passive: true });
  target.addEventListener('touchend', () => { tracking = false; });
}

function current_mobile_pane() {
  if (document.getElementById('rail-left').classList.contains('active')) return 'staff';
  if (document.getElementById('rail-right').classList.contains('active')) return 'library';
  return 'chat';
}

// ── On the Fire — the in-flight work dock (2026-07-29) ─────────────────────
// The web half of the cross-domain job ledger (core/jobs.ts). Answers "is
// anything happening right now?" without asking Kate to poll on your behalf.
//
// State model: ONE map keyed `kind:id`, seeded from GET /app/api/jobs and then
// patched in place by `job_progress` SSE events. The dock is `hidden` whenever
// that map has nothing to show, so the resting UI is byte-identical to before.
//
// Why terminal rows linger: a job that finishes while the panel is closed is
// exactly the case this feature exists for (a 17-second download whose push got
// deferred seven hours). The pill glows until the panel is opened, then goes
// quiet — the win has to be visible without being nagging.

const FIRE_LINGER_MS = 10 * 60_000; // a finished row stays on the wall this long
const _fire = {
  jobs: new Map(),   // "kind:id" → Job
  open: false,
  unseen: 0,         // completions the user hasn't looked at yet
  sweep: null,
  // True while the SSE stream is down. A dead stream and a quiet one look
  // IDENTICAL otherwise — confident, still, silent — so the pane has to say
  // when it doesn't know. A surface that tells you whether to trust it is the
  // difference between live and merely animated.
  stale: false,
  // Cross-tab agreement. Two tabs each hold their own map, so a dismiss in one
  // used to leave the other showing a row that no longer exists for this user.
  channel: null,
};

function fire_key(kind, id) { return `${kind}:${id}`; }

/** "2m", "45s", "1h 12m" — compact, never more precise than it deserves. */
function fire_duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * "2m elapsed · usually ~3m" — the honest alternative to a fake progress bar.
 *
 * A media download has no byte counter, so rather than animate a lie we say how
 * long this one has been going and what normal looks like. `typical_ms` is a
 * MEDIAN over real history and is null until there are enough samples, in which
 * case we say nothing rather than guess.
 */
function fire_timing_label(job) {
  const started = Date.parse(job.created_at || '');
  const ended = Date.parse(job.completed_at || job.updated_at || '');
  const active = fire_is_active(job);
  const elapsed = active
    ? Date.now() - started
    : (Number.isFinite(ended) && Number.isFinite(started) ? ended - started : NaN);
  const el = fire_duration(elapsed);
  const typ = fire_duration(job.typical_ms);
  if (active) {
    if (el && typ) return `${el} elapsed · usually ~${typ}`;
    if (el) return `${el} elapsed`;
    return null;
  }
  return el ? `took ${el}` : null;
}
function fire_is_active(j) { return j.state === 'queued' || j.state === 'running'; }

/** A terminal row ages out; a failed one stays until dismissed (an error the
 *  user never saw is the same bug this feature fixes, one layer up). */
function fire_is_visible(j, now) {
  if (fire_is_active(j)) return true;
  if (j.state === 'failed') return true;
  const done_at = Date.parse(j.completed_at || j.updated_at || '') || 0;
  return now - done_at < FIRE_LINGER_MS;
}

async function fire_refresh() {
  try {
    const feed = await api('/app/api/jobs');
    _fire.jobs.clear();
    for (const j of [...(feed.active || []), ...(feed.recent || [])]) {
      _fire.jobs.set(fire_key(j.kind, j.id), j);
    }
    fire_render();
  } catch {
    // A 404 here means `jobs` isn't mounted on this deployment — leave the dock
    // hidden rather than showing a broken shell. Same fail-quiet posture as the
    // other optional surfaces.
  }
}

/** Patch one row from a `job_progress` event. The event is a strict subset of
 *  the Job shape (it carries `job_id` rather than `id`), so merge over whatever
 *  the last full read gave us instead of replacing — that keeps `created_at` and
 *  the full log from the GET while the phase advances live. */
function fire_on_progress(ev) {
  const key = fire_key(ev.kind, ev.job_id);
  const prev = _fire.jobs.get(key) || {};
  const was_active = prev.state === undefined || fire_is_active(prev);
  const next = {
    ...prev,
    id: ev.job_id,
    kind: ev.kind,
    title: ev.title,
    subtitle: ev.subtitle,
    owner_specialist_id: ev.owner_specialist_id,
    phase: ev.phase,
    phase_label: ev.phase_label,
    state: ev.state,
    progress: ev.progress,
    log: ev.log_tail && ev.log_tail.length ? ev.log_tail : (prev.log || []),
    awaited: ev.awaited,
    conversation_id: ev.conversation_id,
    result_route: ev.result_route,
    error: ev.error,
    completed_at: fire_is_active({ state: ev.state }) ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  _fire.jobs.set(key, next);
  // Count a completion the user hasn't seen — but only for work they asked for,
  // and only on the transition, so a repeated terminal emit can't inflate it.
  if (was_active && !fire_is_active(next) && next.awaited && !_fire.open) {
    _fire.unseen++;
  }
  fire_render();
}

function fire_render() {
  const dock = document.getElementById('fire-dock');
  const pill = document.getElementById('fire-pill');
  const label = document.getElementById('fire-pill-label');
  const panel = document.getElementById('fire-panel');
  const list = document.getElementById('fire-list');
  if (!dock || !pill || !label || !panel || !list) return;

  const now = Date.now();
  const rows = [..._fire.jobs.values()].filter((j) => fire_is_visible(j, now));
  // Active newest-first, then terminal most-recently-finished first.
  const active = rows.filter(fire_is_active).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const done = rows.filter((j) => !fire_is_active(j))
    .sort((a, b) => String(b.completed_at || b.updated_at).localeCompare(String(a.completed_at || a.updated_at)));

  // Only work the user is WAITING on drives the count — a scheduled commission
  // or a court-fired review must not make the pill claim their attention.
  const waiting = active.filter((j) => j.awaited).length;

  if (rows.length === 0) { dock.hidden = true; panel.hidden = true; _fire.open = false; return; }
  dock.hidden = false;

  pill.dataset.active = active.length > 0 ? '1' : '0';
  pill.dataset.unseen = _fire.unseen > 0 ? '1' : '0';
  pill.setAttribute('aria-expanded', String(_fire.open));
  label.textContent =
    active.length > 0
      ? `${waiting || active.length} on the fire`
      : _fire.unseen > 0
        ? `${_fire.unseen} finished`
        : 'On the fire';

  panel.hidden = !_fire.open;
  // The whole panel dims while the stream is down, so stale rows never read as
  // live ones.
  panel.dataset.stale = _fire.stale ? '1' : '0';
  if (!_fire.open) return;

  // A Clear all appears only when there is a finished shelf to clear.
  const clear_btn = document.getElementById('fire-clear');
  if (clear_btn) clear_btn.hidden = done.length === 0;

  list.textContent = '';
  if (_fire.stale) {
    const w = document.createElement('div');
    w.className = 'fire-stale';
    w.textContent = 'Reconnecting — this may be out of date.';
    list.appendChild(w);
  }
  if (rows.length === 0) {
    const e = document.createElement('div');
    e.className = 'fire-empty';
    e.textContent = 'Nothing on the fire.';
    list.appendChild(e);
    return;
  }
  for (const j of [...active, ...done]) list.appendChild(fire_row(j));
}

function fire_row(j) {
  const row = document.createElement('div');
  row.className = 'fire-row';
  row.dataset.state = j.state;

  const top = document.createElement('div');
  top.className = 'fire-row-top';
  const dot = document.createElement('span');
  dot.className = 'fire-row-dot';
  const title = document.createElement('span');
  title.className = 'fire-row-title';
  title.textContent = j.title || j.id;
  title.title = j.title || j.id;
  const phase = document.createElement('span');
  phase.className = 'fire-row-phase';
  phase.textContent = j.phase_label || j.phase || '';
  top.append(dot, title, phase);
  row.appendChild(top);

  if (fire_is_active(j)) {
    const bar = document.createElement('div');
    bar.className = 'fire-bar';
    const fill = document.createElement('div');
    if (typeof j.progress === 'number') {
      fill.className = 'fire-bar-fill';
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, j.progress)) * 100)}%`;
    } else {
      // Indeterminate is the HONEST render for a domain with no byte counter.
      fill.className = 'fire-bar-indet';
    }
    bar.appendChild(fill);
    row.appendChild(bar);
  }

  // The phase CHAIN, not a lone label. A chain reads as a state ("we're at
  // Filing, one step left"); a label reads as a status line. That difference is
  // the whole complaint about a feed.
  if (fire_is_active(j) && Array.isArray(j.phase_chain) && j.phase_chain.length > 1) {
    const chain = document.createElement('div');
    chain.className = 'fire-chain';
    const at = j.phase_chain.findIndex((p) => p.phase === j.phase);
    j.phase_chain.forEach((step, i) => {
      const el = document.createElement('span');
      el.className = 'fire-chain-step';
      // -1 (an unrecognized phase) leaves every step neutral rather than
      // wrongly marking the whole chain done.
      el.dataset.at = at < 0 ? 'unknown' : i < at ? 'past' : i === at ? 'now' : 'future';
      el.textContent = step.label;
      el.title = step.label;
      chain.appendChild(el);
    });
    row.appendChild(chain);
  }

  // Seat chips + tallies — the rich glance for a bench.
  if (j.detail && ((j.detail.seats || []).length || (j.detail.tally || []).length)) {
    const d = document.createElement('div');
    d.className = 'fire-detail';
    for (const seat of j.detail.seats || []) {
      const c = document.createElement('span');
      c.className = 'fire-seat';
      c.dataset.phase = seat.phase || 'queued';
      c.textContent = String(seat.role || '?').slice(0, 3).toUpperCase();
      c.title = `${seat.role} · ${seat.phase}`;
      d.appendChild(c);
    }
    for (const t of j.detail.tally || []) {
      const c = document.createElement('span');
      c.className = 'fire-tally';
      c.textContent = `${t.value} ${t.label}`;
      d.appendChild(c);
    }
    if (j.detail.outcome && !fire_is_active(j)) {
      const o = document.createElement('span');
      o.className = 'fire-outcome';
      o.dataset.verdict = /block/i.test(j.detail.outcome) ? 'block' : /pass/i.test(j.detail.outcome) ? 'pass' : 'other';
      o.textContent = j.detail.outcome.toUpperCase();
      d.appendChild(o);
    }
    row.appendChild(d);
  }

  // The runner's own log line — a better progress narrative than anything we'd
  // invent ("categorized clip · nsfw_pre=sfw").
  const tail = (j.log || []).at(-1);
  const sub = j.subtitle || tail;
  if (sub) {
    const s = document.createElement('div');
    s.className = 'fire-row-sub';
    s.textContent = fire_is_active(j) && tail ? tail : sub;
    row.appendChild(s);
  }

  // Elapsed, and what normal looks like. The honest substitute for a progress
  // percentage nobody can compute.
  const timing = fire_timing_label(j);
  if (timing) {
    const t = document.createElement('div');
    t.className = 'fire-row-timing';
    t.textContent = timing;
    row.appendChild(t);
  }
  if (j.error) {
    const e = document.createElement('div');
    e.className = 'fire-row-err';
    e.textContent = j.error; // verbatim — a paraphrased error is a lost error
    row.appendChild(e);
  }

  const actions = document.createElement('div');
  if (j.state === 'done' && j.result_route) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fire-row-link';
    b.textContent = j.kind === 'research' ? 'Read the report →' : 'Open in the archive →';
    b.addEventListener('click', () => void fire_open_result(j));
    actions.appendChild(b);
  }
  if (fire_is_active(j) && j.cancellable) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fire-row-link danger';
    b.textContent = 'Stop';
    b.addEventListener('click', () => void fire_cancel(j));
    actions.appendChild(b);
  }
  if (j.state === 'failed' && j.kind === 'media_archive') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fire-row-link';
    b.textContent = 'Retry';
    b.addEventListener('click', () => void fire_retry(j));
    actions.appendChild(b);
  }
  if (!fire_is_active(j)) {
    // Clearing is offered on ANY finished row, not just failures — the shelf is
    // the user's to tidy. Server-backed, so it holds across reload and devices.
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fire-row-link';
    b.textContent = 'Clear';
    b.addEventListener('click', () => void fire_dismiss(j));
    actions.appendChild(b);
  }
  if (actions.children.length) {
    actions.className = 'fire-row-actions';
    row.appendChild(actions);
  }
  return row;
}

/** Land on the surface that holds the result. There is no per-item deep-link
 *  router in the web client, so this opens the office tab that renders it
 *  rather than pretending to address the row. */
async function fire_open_result(j) {
  const tab = j.kind === 'research' ? 'research' : 'media';
  try {
    if (state.active_id !== 'kate') await switch_specialist('kate');
    state._news_tab = tab;
    set_surface('office');
    if (state._last_pane_doc) render_pane(state._last_pane_doc);
  } catch { /* navigation is best-effort */ }
}

async function fire_cancel(j) {
  try {
    await api(`/app/api/jobs/${encodeURIComponent(j.kind)}/${encodeURIComponent(j.id)}/cancel`, { method: 'POST' });
  } catch { /* the refresh below shows the truth either way */ }
  await fire_refresh();
}

/**
 * Clear one finished row. Server-backed (per user) so it holds across reload
 * and across devices — a local-only hide would come back on the next refetch,
 * which is the classic "the button did nothing" bug.
 *
 * Optimistic: the row leaves immediately and the refetch reconciles. A failure
 * therefore self-corrects rather than needing an error toast.
 */
async function fire_dismiss(j) {
  const key = fire_key(j.kind, j.id);
  _fire.jobs.delete(key);
  fire_render();
  fire_broadcast();
  try {
    await api(`/app/api/jobs/${encodeURIComponent(j.kind)}/${encodeURIComponent(j.id)}/dismiss`, { method: 'POST' });
  } catch { /* the refetch below is the truth */ }
  await fire_refresh();
}

/** Clear the finished shelf. Active work is deliberately untouched — "clear
 *  all" tidies, it never silences something still in flight. */
async function fire_clear_all() {
  for (const [k, j] of [..._fire.jobs]) if (!fire_is_active(j)) _fire.jobs.delete(k);
  _fire.unseen = 0;
  fire_render();
  fire_broadcast();
  try {
    await api('/app/api/jobs/clear', { method: 'POST' });
  } catch { /* refetch reconciles */ }
  await fire_refresh();
}

/** Retry a failed job by re-issuing the original request. `archive_url` dedups
 *  on the URL, so this is safe to press twice. */
async function fire_retry(j) {
  if (j.kind !== 'media_archive') return;
  try {
    await api('/app/api/jobs/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: j.kind, id: j.id }),
    });
  } catch { /* surfaced by the refetch */ }
  await fire_refresh();
}

/** Tell the other tabs. They re-read from the server rather than trusting the
 *  message body, so a stale sender can't corrupt a fresh receiver. */
function fire_broadcast() {
  try { _fire.channel?.postMessage({ type: 'jobs-changed' }); } catch { /* no BroadcastChannel */ }
}

function fire_toggle() {
  _fire.open = !_fire.open;
  // Opening IS the acknowledgement — the glow's job is done once seen.
  if (_fire.open) _fire.unseen = 0;
  fire_render();
}

function attach_fire_dock() {
  const pill = document.getElementById('fire-pill');
  const x = document.getElementById('fire-collapse');
  const clear = document.getElementById('fire-clear');
  if (clear) clear.addEventListener('click', (e) => { e.stopPropagation(); void fire_clear_all(); });
  if (pill) pill.addEventListener('click', fire_toggle);
  if (x) x.addEventListener('click', (e) => { e.stopPropagation(); _fire.open = false; fire_render(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _fire.open) { _fire.open = false; fire_render(); }
  });
  // A finished row ages out of the panel on a timer, so the dock needs a tick to
  // notice — 30s is well inside the 10-minute linger and costs nothing.
  if (_fire.sweep) clearInterval(_fire.sweep);
  _fire.sweep = setInterval(fire_render, 30_000);
  // Catch up after a background tab / sleep, where SSE may have dropped events.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void fire_refresh();
  });
  // Cross-tab: another tab cleared or started something. Receivers REFETCH
  // rather than trusting the payload, so two tabs converge on server truth
  // instead of gossiping stale rows at each other.
  try {
    _fire.channel = new BroadcastChannel('hearth-jobs');
    _fire.channel.onmessage = () => { void fire_refresh(); };
  } catch { /* Safari private mode / old browsers — degrade to per-tab */ }
}

/** The SSE layer calls this so the dock can admit when it's flying blind. */
function fire_set_stale(stale) {
  if (_fire.stale === stale) return;
  _fire.stale = stale;
  fire_render();
}

// ── Go ───────────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  console.error('bootstrap failed:', err);
  document.body.innerHTML =
    `<div style="padding: 40px; color: #c43838; font-family: sans-serif;">` +
    `Hearth failed to load: ${escape_html(err.message)}` +
    `</div>`;
});
