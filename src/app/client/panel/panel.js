/* Hearth guest panel — client.
   Holds no house knowledge: rooms, tiles and truth all arrive from the server,
   which composes them from HA's area map plus live state. All fetches are
   RELATIVE so they resolve under /app/panel/. */

const I = {
  fan: '<path d="M12 12c0-4 1.5-7 4-7s3 4 0 5.5"/><path d="M12 12c4 0 7 1.5 7 4s-4 3-5.5 0"/><path d="M12 12c0 4-1.5 7-4 7s-3-4 0-5.5"/><path d="M12 12c-4 0-7-1.5-7-4s4-3 5.5 0"/>',
  bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1.2.9 1.9v.2h5.2v-.2c0-.7.3-1.4.9-1.9A6 6 0 0 0 12 3z"/>',
  scene: '<path d="M12 3l2.1 5.4 5.4 2.1-5.4 2.1L12 18l-2.1-5.4L4.5 10.5l5.4-2.1z"/>',
  music: '<circle cx="7" cy="17.5" r="2.5"/><circle cx="17.5" cy="15.5" r="2.5"/><path d="M9.5 17.5V6l10.5-2v11.5"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 5v14M16 5v14"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  door: '<path d="M6 3.5h12v17H6z"/><circle cx="14.5" cy="12" r="1"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
};

const POLL_MS = 4000;

const S = {
  room: localStorage.getItem('hearth.panel.room') || 'Living Room',
  phase: null,       // null = follow the server's clock
  rooms: [],
  pane: null,
  pending: new Set(),
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const svg = (n) => '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + (I[n] || I.bulb) + '</svg>';

let ac;
function chirp(hi) {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = 'triangle';
    o.frequency.setValueAtTime(hi ? 760 : 520, t);
    o.frequency.exponentialRampToValueAtTime(hi ? 1180 : 880, t + .05);
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(.05, t + .012);
    g.gain.exponentialRampToValueAtTime(.0001, t + .13);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + .15);
  } catch (e) {}
}
function buzz(m) { if (navigator.vibrate) navigator.vibrate(m); }

let tt;
function toast(m, bad) {
  const e = $('#toast');
  e.textContent = m;
  e.classList.toggle('bad', !!bad);
  e.classList.add('show');
  clearTimeout(tt);
  tt = setTimeout(() => e.classList.remove('show'), 2800);
}

// ------------------------------------------------------------------- the door

let doorShownFor = null;
function renderDoor(d) {
  const el = $('#door');
  if (!d || !d.active) {
    el.classList.remove('up');
    doorShownFor = null;
    return;
  }

  const fresh = d.since !== doorShownFor;
  if (fresh) {
    doorShownFor = d.since;
    // A ring is the one thing on this panel that interrupts.
    buzz([14, 60, 14]);
    chirp(true);
  }
  $('#doorLbl').textContent = d.reason === 'ring'
    ? "Someone's at the front door"
    : 'Someone is at the front door';
  $('#doorAgo').textContent = d.reason === 'ring' ? 'rang' : 'waiting';
  el.classList.add('up');
  if (fresh) $('#doorImg').src = 'api/doorbell/frame?t=' + Date.now();
}

// ------------------------------------------------------------------- rendering

function render() {
  const pane = S.pane;
  if (!pane) return;

  const dayish = pane.phase === 'morning' || pane.phase === 'afternoon';
  document.documentElement.setAttribute('data-phase', dayish ? 'day' : 'night');
  $('#roomName').textContent = pane.room;

  const urgent = pane.tiles.some((t) => t.urgent);
  $('#spine').style.background = urgent ? 'var(--ember)' : (pane.phase === 'night' ? 'var(--slate)' : 'var(--moss)');

  $('#outT').textContent = pane.temps.outside || '—';
  $('#houseT').textContent = pane.temps.house || '—';
  $('#roomTempLbl').textContent = pane.temps.room ? 'This room' : 'No sensor';
  $('#roomT').textContent = pane.temps.room || '—';
  $('#roomTempBox').classList.toggle('hot', !!pane.temps.room && parseFloat(pane.temps.room) > 85);

  renderDoor(pane.doorbell);

  $('#actions').innerHTML = pane.tiles.map((t) => {
    const pending = S.pending.has(t.entity_id);
    const cls = ['act', t.urgent ? 'urgent' : '', t.on ? 'on' : '', pending ? 'pending' : ''].filter(Boolean).join(' ');
    const sub = t.on && t.kind === 'toggle' ? 'On now — tap to turn off' : t.sub;
    return '<button class="' + cls + '" data-eid="' + esc(t.entity_id) + '" data-kind="' + t.kind +
      '" data-on="' + (t.on ? '1' : '') + '" data-lbl="' + esc(t.label) + '">' + svg(t.icon) +
      '<span class="txt"><span class="lbl">' + esc(t.label) + '</span><span class="sub">' + esc(sub) +
      '</span><span class="eid">' + esc(t.entity_id) + '</span></span><i class="pip"></i></button>';
  }).join('');

  tick();
}

function renderHouse(house) {
  if (!house) {
    $('#houseRows').innerHTML = '<div class="body open">Could not read <code>friday_intel/house_data.json</code>.</div>';
    return;
  }

  const rows = [];
  const add = (id, k, v, warn, body) => rows.push(
    '<button class="row' + (warn ? ' warn' : '') + '" data-body="' + id + '"><span class="k">' + esc(k) +
    '</span><span class="v">' + esc(v) + '</span></button><div class="body" id="' + id + '">' + body + '</div>'
  );
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);

  const w = house.wifi;
  add('b-wifi', 'Wi-fi', w.has_guest_network ? w.ssid : 'no guest network', !w.has_guest_network,
    w.has_guest_network
      ? 'Network <b>' + esc(w.ssid) + '</b> · password <b>' + esc(w.password || '—') + '</b>'
      : 'There is <b>no guest network configured</b> — <code>wifi.guest.ssid</code> is empty in ' +
        '<code>house_data.json</code>. The panel deliberately does not show the main network password, ' +
        'so this stays blank until a guest SSID exists.');

  const e = house.entertainment || {};
  if (e.apple_tv || e.plex) {
    add('b-tv', 'TV & movies', 'Apple TV · Plex', false,
      [e.apple_tv, e.plex, e.streaming_notes].filter(Boolean).map(esc).join('<br><br>'));
  }

  const t = house.trash || {};
  if (t.day) {
    add('b-trash', 'Trash & recycling', t.day === t.recycling_day ? cap(t.day) : cap(t.day) + ' · rec ' + cap(t.recycling_day), false,
      'Trash goes out <b>' + esc(cap(t.day)) + '</b>, recycling <b>' + esc(cap(t.recycling_day || t.day)) + '</b>' +
      (t.reminder_night_before ? '. A reminder fires the night before.' : '.'));
  }

  const shut = house.shutoffs || [];
  if (shut.length) {
    add('b-shut', 'Shutoffs', String(shut.length) + ' recorded', false,
      '<ul style="margin:0;padding-left:18px">' + shut.map((s) =>
        '<li>' + esc(typeof s === 'string' ? s : [s.what, s.where].filter(Boolean).join(' — ')) + '</li>').join('') + '</ul>');
  }

  const c = house.contacts || {};
  const people = (c.emergency || []).concat(c.non_emergency || [], c.neighbors || []);
  if (people.length) {
    add('b-help', 'If something breaks', String(people.length) + ' contacts', false,
      people.map((p) => '<b>' + esc(p.name || p.who || 'contact') + '</b> · ' + esc(p.phone || p.number || '—') +
        (p.note ? ' — ' + esc(p.note) : '')).join('<br>'));
  }

  $('#houseRows').innerHTML = rows.join('');
  document.querySelectorAll('.row[data-body]').forEach((r) => r.addEventListener('click', () => {
    document.getElementById(r.dataset.body).classList.toggle('open');
    buzz(8);
  }));
}

function renderGaps(house) {
  const gaps = [];
  if (house && !house.wifi.has_guest_network) {
    gaps.push("<b>Guest wi-fi network.</b> <code>wifi.guest.ssid</code> is blank and no UniFi guest/SSID entity exists in HA. Fill those two fields in FRIDAY's house app and this ships.");
  }
  gaps.push('<b>Blinds and shades.</b> The only cover in the house is <code>cover.double_bay_isg</code> — the garage door.');
  gaps.push("<b>Door locks.</b> The only lock is <code>lock.2023_ioniq_5_door_lock</code>, and the Ioniq's subscription is dead.");
  gaps.push('<b>A guest room.</b> No such HA area — guests are in Living Room / Loft / Basement Game Area / Theater.');
  if (S.kate && S.kate.wired && !canRecord) {
    gaps.push('<b>Kate by voice.</b> She answers, but holding to talk needs a microphone, and browsers only allow that over https. Over plain http this panel asks her by typing.');
  }
  $('#gapList').innerHTML = gaps.map((g) => '<li>' + g + '</li>').join('');
}

// ---------------------------------------------------------------- the polling

let timer = null;

async function refresh() {
  // Nothing polls for a panel nobody is looking at — this is most of the
  // reason the panel is cheap to leave open on a bedside table.
  if (document.hidden) return;
  try {
    const q = new URLSearchParams({ room: S.room });
    if (S.phase) q.set('phase', S.phase);
    const res = await fetch('api/pane?' + q);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    S.pane = await res.json();
    S.pending.clear();
    $('#connState').innerHTML = '<span class="live">live</span>';
    render();
  } catch (err) {
    $('#connState').innerHTML = '<span class="stale">' + esc(String(err.message || err)) + '</span>';
  }
}

function start() {
  if (timer) clearInterval(timer);
  refresh();
  timer = setInterval(refresh, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  tick();
  refresh();
});

// --------------------------------------------------------------------- actions

$('#actions').addEventListener('click', async (ev) => {
  const b = ev.target.closest('.act');
  if (!b) return;

  const eid = b.dataset.eid;
  const kind = b.dataset.kind;
  const was = !!b.dataset.on;
  const label = b.dataset.lbl.toLowerCase();

  buzz(was ? 8 : [9, 26, 9]);
  chirp(!was);
  S.pending.add(eid);
  b.classList.add('pending');
  if (kind === 'toggle') b.classList.toggle('on', !was);

  try {
    const res = await fetch('api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: eid, on: kind === 'toggle' ? !was : undefined }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
    toast(kind === 'toggle' ? (was ? 'Off — ' : 'Done — ') + label : label);
    setTimeout(refresh, 600);
  } catch (err) {
    S.pending.delete(eid);
    b.classList.remove('pending');
    if (kind === 'toggle') b.classList.toggle('on', was);
    toast("Didn't take — " + err.message, true);
  }
});

// ----------------------------------------------------------------- room sheet

const sheet = $('#sheet');
$('#roomBtn').addEventListener('click', () => {
  $('#roomList').innerHTML = S.rooms.map((r) =>
    '<button data-r="' + esc(r) + '" aria-pressed="' + (r === S.room) + '">' + esc(r) + '</button>').join('');
  buzz(8);
  sheet.classList.add('open');
});
$('#scrim').addEventListener('click', () => sheet.classList.remove('open'));
$('#roomList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.room = b.dataset.r;
  localStorage.setItem('hearth.panel.room', S.room);
  buzz(12); chirp(true);
  sheet.classList.remove('open');
  toast('Now showing ' + S.room);
  start();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sheet.classList.remove('open'); });

document.querySelectorAll('.demo button[data-ph]').forEach((b) => b.addEventListener('click', () => {
  S.phase = S.phase === b.dataset.ph ? null : b.dataset.ph;
  document.querySelectorAll('.demo button[data-ph]').forEach((x) =>
    x.setAttribute('aria-pressed', x.dataset.ph === S.phase));
  buzz(8);
  start();
}));

$('#idBtn').addEventListener('click', () => {
  const on = document.body.classList.toggle('ids');
  $('#idBtn').setAttribute('aria-pressed', on);
  buzz(8);
});

// ---------------------------------------------------------------------- kate

const kate = $('#kate');
const kateLbl = $('#kateLbl');
let rec = null, chunks = [], recording = false, busy = false;

// getUserMedia only exists in a SECURE CONTEXT. The panel is normally reached
// over plain http://your-llm-host.local, so on most visits there is no microphone to
// be had — the button becomes "Ask Kate" and opens a text box instead of
// pretending to listen.
const canRecord = !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

function kateIdle(label) {
  kate.classList.remove('live');
  kateLbl.textContent = label || (canRecord ? 'Hold to ask Kate' : 'Ask Kate');
}

function sayReply(heard, reply) {
  const box = $('#kateAnswer');
  $('#kateHeard').textContent = heard ? '“' + heard + '”' : '';
  $('#kateHeard').style.display = heard ? '' : 'none';
  $('#kateReply').textContent = reply;
  box.classList.add('up');
}

async function askKate(payload) {
  if (busy) return;
  busy = true;
  kateIdle('Thinking…');
  try {
    const q = new URLSearchParams({ room: S.room });
    const res = await fetch('api/ask?' + q, payload);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.status);
    sayReply(j.heard, j.reply);
    chirp(true);
  } catch (err) {
    toast('Kate: ' + err.message, true);
  } finally {
    busy = false;
    kateIdle();
  }
}

async function startRecording() {
  if (busy || recording) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    toast('No microphone: ' + err.message, true);
    return;
  }
  chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    // Anything this short is a mis-tap, not a question.
    if (blob.size < 2000) { kateIdle(); return; }
    const fd = new FormData();
    fd.append('audio', blob, 'ask.webm');
    askKate({ method: 'POST', body: fd });
  };
  rec.start();
  recording = true;
  kate.classList.add('live');
  kateLbl.textContent = 'Listening…';
  buzz(14);
  chirp(true);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  kate.classList.remove('live');
  kateLbl.textContent = 'One moment…';
  buzz(8);
  try { rec.stop(); } catch (e) { kateIdle(); }
}

function askByText() {
  if (busy) return;
  const q = window.prompt('Ask Kate');
  if (!q || !q.trim()) return;
  askKate({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: q.trim() }),
  });
}

// Bound ONCE, at boot, from the mode the server + browser actually support.
// (Registering both and unbinding one later does not work — the hold handler
// is an arrow, so removeEventListener would never match it.)
const onDown = (e) => { e.preventDefault(); startRecording(); };
function wireKateInput(mode) {
  if (mode === 'voice') {
    kate.addEventListener('pointerdown', onDown);
    kate.addEventListener('pointerup', stopRecording);
    kate.addEventListener('pointercancel', stopRecording);
    kate.addEventListener('pointerleave', stopRecording);
  } else if (mode === 'text') {
    kate.addEventListener('click', askByText);
  }
}
$('#kateClose').addEventListener('click', () => $('#kateAnswer').classList.remove('up'));

// The clock repaints when the panel is already repainting for a human — the
// rule the e-ink concept set, kept so both surfaces behave the same.
function tick() {
  const d = new Date();
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  $('#clock').textContent = h + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ------------------------------------------------------------------------ boot

(async function boot() {
  tick();
  try {
    const b = await (await fetch('api/bootstrap')).json();
    S.rooms = b.rooms;
    if (!S.rooms.includes(S.room)) S.room = S.rooms[0];
    S.kate = b.kate || { wired: false, stt: false };
    renderHouse(b.house);
    renderGaps(b.house);

    // The button describes what it can actually do on THIS visit: hold-to-talk
    // only when there is both a reachable microphone and a live transcriber;
    // tap-to-type otherwise; plainly out of order when Kate herself is down.
    const mode = !S.kate.wired ? 'off' : (canRecord && S.kate.stt) ? 'voice' : 'text';
    wireKateInput(mode);
    if (mode === 'off') {
      kate.disabled = true;
      kateLbl.textContent = 'Kate is offline';
    } else if (mode === 'text') {
      kateIdle(canRecord ? 'Ask Kate (typing — transcriber is down)' : 'Ask Kate');
    } else {
      kateIdle('Hold to ask Kate');
    }
    if (b.house && b.house.updated) {
      $('#srcLine').textContent = 'live from home assistant · house facts ' + b.house.updated;
    }
    document.querySelectorAll('.demo button[data-ph]').forEach((x) =>
      x.setAttribute('aria-pressed', x.dataset.ph === b.phase));
  } catch (err) {
    toast('Server unreachable: ' + err.message, true);
  }
  start();
})();
