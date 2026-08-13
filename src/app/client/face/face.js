// Kate — VRM face surface.
// three-vrm renderer: loads ./kate.vrm, idles (blink / breathe / spring-bone
// physics), blends emotion presets with eased weights, and lip-syncs the mouth
// to an AnalyserNode over whatever audio is playing — Kate's TTS
// (/api/voice/tts), the mic, or a synthetic demo envelope.
// Vanilla ES module, no bundler; libs come from the importmap in index.html.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

const MODEL_URL = '/app/face/kate.vrm';
const EMOTIONS = ['neutral', 'happy', 'relaxed', 'surprised', 'sad', 'angry'];
const EMO_MAX = 0.85; // a full 1.0 preset reads stiff; cap a touch lower
// Framing preset (?view=): 'face' tight head+shoulders, 'bust' (default) head
// through chest so torso/shoulder/upper-arm motion reads, 'full' down to the
// hands so the forearm beat gestures are visible.
const VIEW = new URLSearchParams(location.search).get('view') || 'bust';
// .vrma body-animation clips (served from /app/face/anim/). The body pose +
// motion now come from real authored clips (incl. natural hand/finger pose)
// played through an AnimationMixer — idle loops, crossfading to a livelier
// clip while speaking. Expressions (viseme/blink/emotion) + spring physics
// stay procedural on top.
const CLIP_NAMES = ['idle_loop', 'Relax', 'LookAround', 'Thinking', 'Goodbye', 'Clapping', 'Surprised', 'Sad', 'Angry'];
// `idle_loop` is pixiv ChatVRM's calm talking-avatar idle. The natural look is
// idle + lip-sync with NO gesture crossfade (that read as stiff flailing), so
// talk defaults to the SAME clip. Both swappable via ?idle=/?talk= for tuning.
const IDLE_CLIP = new URLSearchParams(location.search).get('idle') || 'idle_loop';
const TALK_CLIP = new URLSearchParams(location.search).get('talk') || 'idle_loop';

const hud = document.getElementById('hud');
const boot = document.getElementById('boot');
const setStatus = (s) => { state.status = s; };

const state = {
  vrm: null,
  status: 'booting',
  mouth: 0, // smoothed 0..1 mouth-open
  emotion: 'neutral',
  mirror: false, // ambient mode: speak Kate's replies as they land (SSE)
  sway: 0,       // current idle head-sway magnitude (observability)
  fps: 0,
};

// Emotion is BLENDED, not snapped: each preset has a target + an eased current
// weight, so transitions fade and several can overlap (the hook the LLM
// performance-director layer will drive mid-utterance).
const emoTarget = {};
const emoCurrent = {};
for (const e of EMOTIONS) { emoTarget[e] = 0; emoCurrent[e] = 0; }

// ── Scene ──────────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 0.05, 30);
camera.position.set(0, 1.35, 0.95);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.32, 0);
controls.enableDamping = true;
controls.minDistance = 0.35;
controls.maxDistance = 4;
controls.update();

// Soft, warm-neutral key + fill so MToon/standard materials read well.
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(1.0, 1.8, 2.0);
scene.add(key);
const rim = new THREE.DirectionalLight(0xcad6ff, 1.0);
rim.position.set(-1.5, 1.2, -1.5);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4658, 1.4));

// ── Load the VRM ─────────────────────────────────────────────────────────────
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  MODEL_URL,
  (gltf) => {
    const vrm = gltf.userData.vrm;
    // v3 cleanup helpers (guarded — names have shifted across minor versions).
    try { VRMUtils.removeUnnecessaryVertices?.(gltf.scene); } catch (e) { /* noop */ }
    try { VRMUtils.combineSkeletons?.(gltf.scene); } catch (e) { /* noop */ }

    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    scene.add(vrm.scene);
    state.vrm = vrm;

    // She should look at the viewer when idle.
    if (vrm.lookAt) vrm.lookAt.target = camera;

    // Auto-frame head-and-shoulders from the actual head bone, so framing is
    // independent of the model's exact height. VRM 1.0 faces +Z, so the
    // camera sits in front at +Z.
    vrm.update(0);
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    if (head) {
      const p = new THREE.Vector3();
      head.getWorldPosition(p);
      const dist = VIEW === 'full' ? 1.95 : VIEW === 'face' ? 0.8 : 1.3;
      const drop = VIEW === 'full' ? 0.34 : VIEW === 'face' ? 0.05 : 0.16;
      camera.position.set(p.x, p.y - drop, p.z + dist);
      controls.target.set(p.x, p.y - drop, p.z);
      controls.update();
    }

    boot.style.display = 'none';
    setStatus('ready');
    applyEmotion('neutral');
    captureFingerRest(vrm); // bind finger pose, before the mixer runs
    loadAnimations(vrm); // real .vrma body motion (idle + talking crossfade)
  },
  (prog) => {
    if (prog.total) {
      const pct = Math.round((prog.loaded / prog.total) * 100);
      boot.lastElementChild.textContent = `Loading Kate… ${pct}%`;
    }
  },
  (err) => {
    console.error('[face] VRM load failed:', err);
    boot.innerHTML = `<div style="color:#ff9a9a">Failed to load kate.vrm<br><small>${(err && err.message) || err}</small></div>`;
    setStatus('load-error');
  },
);

// ── Idle: blink + breathe ────────────────────────────────────────────────────
let nextBlinkIn = 1.5 + Math.random() * 2.5;
let blinkT = -1; // -1 = eyes open; >=0 = blinking
function updateBlink(dt, em) {
  nextBlinkIn -= dt;
  if (blinkT < 0 && nextBlinkIn <= 0) blinkT = 0;
  if (blinkT >= 0) {
    blinkT += dt;
    const dur = 0.16;
    const half = dur / 2;
    const v = blinkT < half ? blinkT / half : 1 - (blinkT - half) / half;
    em.setValue('blink', Math.max(0, Math.min(1, v)));
    if (blinkT >= dur) { blinkT = -1; em.setValue('blink', 0); nextBlinkIn = 1.8 + Math.random() * 3.2; }
  }
}

// ── Body animation: real .vrma clips via AnimationMixer ─────────────────────
// The body pose + motion come from authored clips (natural hand/finger pose
// included), not hand-rolled bone math. The idle clip loops; while speaking we
// crossfade to a livelier clip and back. Expression tracks are stripped from
// the clips so our viseme / blink / emotion stay authoritative (we also write
// them AFTER mixer.update each frame).
let mixer = null;
const actions = {};
let idleAction = null;
let talkAction = null;
let talkLevel = 0; // smoothed 0..1 idle→talk blend

function stripExpressionTracks(clip) {
  // Keep ONLY bone rotations: drops expression + lookAt tracks (so the face +
  // gaze stay ours) AND the hips position/root-motion track (so she stays
  // planted and no source-skeleton scale mismatch can distort the pose).
  clip.tracks = clip.tracks.filter((tr) => /\.quaternion$/.test(tr.name) && !/lookAt/i.test(tr.name));
  return clip;
}

async function loadAnimations(vrm) {
  try {
    mixer = new THREE.AnimationMixer(vrm.scene);
    const vrmaLoader = new GLTFLoader();
    vrmaLoader.register((p) => new VRMAnimationLoaderPlugin(p));
    for (const name of CLIP_NAMES) {
      try {
        const g = await vrmaLoader.loadAsync(`/app/face/anim/${name}.vrma`);
        const va = g.userData.vrmAnimations && g.userData.vrmAnimations[0];
        if (!va) { console.warn('[face] no vrmAnimation in', name); continue; }
        const clip = stripExpressionTracks(createVRMAnimationClip(va, vrm));
        clip.name = name;
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        actions[name] = action;
      } catch (e) { console.warn('[face] clip load failed:', name, e); }
    }
    idleAction = actions[IDLE_CLIP] || Object.values(actions)[0] || null;
    talkAction = actions[TALK_CLIP] || idleAction;
    if (idleAction) { idleAction.setEffectiveWeight(1).play(); }
    if (talkAction && talkAction !== idleAction) { talkAction.setEffectiveWeight(0).play(); }
    setStatus(idleAction ? 'ready' : 'ready (no body clips)');
  } catch (e) { console.warn('[face] animation init failed', e); }
}

function updateBodyAnim(dt) {
  if (!mixer) return;
  const speaking = (isPlaying || state.mouth > 0.06) ? 1 : 0;
  talkLevel += (speaking - talkLevel) * Math.min(1, dt * 3);
  if (idleAction && talkAction && idleAction !== talkAction) {
    talkAction.setEffectiveWeight(talkLevel);
    idleAction.setEffectiveWeight(1 - talkLevel);
  }
  state.talk = +talkLevel.toFixed(2);
  mixer.update(dt);
}

// ── Relaxed hands ────────────────────────────────────────────────────────────
// The idle clip animates the body but NOT the fingers, so they sit in the
// model's flat bind pose ("stiff open"). Curl the four fingers into a natural
// relaxed rest each frame (after the mixer), over the captured bind rotation.
// VRM finger flexion is rotation about local Z (left −, right + to mirror); the
// thumb uses a different axis so we leave it at rest. Tune CURL if too fisted.
const CURL = { Proximal: 0.22, Intermediate: 0.40, Distal: 0.26 };
const FINGER_BONES = [];
for (const side of ['left', 'right']) {
  for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
    for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
      FINGER_BONES.push([side + finger + seg, side === 'left' ? -CURL[seg] : CURL[seg]]);
    }
  }
}
const fingerRest = {};
const _fe = new THREE.Euler();
const _fq = new THREE.Quaternion();
function captureFingerRest(vrm) {
  for (const [bone] of FINGER_BONES) {
    const node = vrm.humanoid?.getNormalizedBoneNode(bone);
    if (node) fingerRest[bone] = node.quaternion.clone();
  }
}
function relaxHands(vrm) {
  for (const [bone, amt] of FINGER_BONES) {
    const rest = fingerRest[bone];
    if (!rest) continue;
    const node = vrm.humanoid.getNormalizedBoneNode(bone);
    if (!node) continue;
    _fe.set(0, 0, amt, 'XYZ');
    _fq.setFromEuler(_fe);
    node.quaternion.copy(rest).multiply(_fq);
  }
}

// ── Emotion: eased blend ─────────────────────────────────────────────────────
function applyEmotion(name) {
  state.emotion = name;
  for (const e of EMOTIONS) emoTarget[e] = (e === name && e !== 'neutral') ? 1 : 0;
  document.querySelectorAll('#emo button').forEach((b) => b.classList.toggle('on', b.dataset.emo === name));
}

function updateEmotion(dt, em) {
  const k = Math.min(1, dt * 4.5); // ~0.2s settle — fades in/out, never snaps
  for (const e of EMOTIONS) {
    if (e === 'neutral') continue;
    emoCurrent[e] += (emoTarget[e] - emoCurrent[e]) * k;
    if (emoCurrent[e] < 0.001) emoCurrent[e] = 0;
    em.setValue(e, emoCurrent[e] * EMO_MAX);
  }
}

// ── Audio + amplitude lip-sync ───────────────────────────────────────────────
let audioCtx = null;
let analyser = null;
let timeData = null;
let micSource = null;
let demoUntil = 0;
let isPlaying = false;
const LIP_GAIN = 11;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    timeData = new Uint8Array(analyser.fftSize);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function micLevel() {
  if (!analyser) return 0;
  analyser.getByteTimeDomainData(timeData);
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / timeData.length);
}

function updateLipSync(dt, em) {
  let target = 0;
  const now = performance.now();
  if (analyser && (micSource || isPlaying)) {
    target = Math.min(1, micLevel() * LIP_GAIN);
  } else if (now < demoUntil) {
    const t = (demoUntil - now) / 1000;
    target = Math.max(0, (0.5 + 0.5 * Math.sin(t * 19)) * (0.55 + 0.45 * Math.sin(t * 3.3)));
  }
  // Asymmetric smoothing — open fast, close a touch slower, reads natural.
  const kk = target > state.mouth ? 0.55 : 0.32;
  state.mouth += (target - state.mouth) * kk;
  if (state.mouth < 0.01) state.mouth = 0;
  em.setValue('aa', state.mouth);
}

// Play decoded audio through the analyser so the mouth tracks it exactly.
// Resolves when playback ends so the speak queue can advance.
function playArrayBuffer(buf) {
  return new Promise((resolve) => {
    ensureAudio();
    audioCtx.decodeAudioData(
      buf.slice(0),
      (audioBuf) => {
        const src = audioCtx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(analyser);
        analyser.connect(audioCtx.destination);
        isPlaying = true;
        src.onended = () => {
          isPlaying = false;
          try { analyser.disconnect(audioCtx.destination); } catch (e) {}
          resolve();
        };
        src.start();
        setStatus('speaking');
      },
      (err) => { console.error('[face] decode failed', err); setStatus('decode-error'); resolve(); },
    );
  });
}

// Sequential speak queue — one utterance at a time, so mirrored replies (and
// manual Speak presses) never talk over each other.
const speakQueue = [];
let speaking = false;
function enqueueSpeak(text, voice) {
  if (!text || !text.trim()) return;
  speakQueue.push({ text: text.trim(), voice });
  void drainSpeakQueue();
}
async function drainSpeakQueue() {
  if (speaking || speakQueue.length === 0) return;
  speaking = true;
  const { text, voice } = speakQueue.shift();
  setStatus('synthesizing…');
  try {
    const res = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) setStatus(`tts ${res.status} (backend only)`);
    else await playArrayBuffer(await res.arrayBuffer());
  } catch (e) {
    setStatus('tts unreachable (run via orchestrator)');
    console.warn('[face] /api/voice/tts failed:', e);
  }
  speaking = false;
  void drainSpeakQueue();
}

async function toggleMic(btn) {
  ensureAudio();
  if (micSource) {
    try { micSource.mediaStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { micSource.disconnect(); } catch (e) {}
    micSource = null;
    btn.classList.remove('on');
    setStatus('ready');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micSource = audioCtx.createMediaStreamSource(stream);
    micSource.mediaStream = stream;
    micSource.connect(analyser); // measure only — never to destination (no echo)
    btn.classList.add('on');
    setStatus('mic live');
  } catch (e) {
    setStatus('mic denied');
    console.warn('[face] mic error', e);
  }
}

// ── Controls wiring ──────────────────────────────────────────────────────────
const sayEl = document.getElementById('say');
const voiceEl = document.getElementById('voice');
document.getElementById('speak').addEventListener('click', () => enqueueSpeak(sayEl.value, voiceEl.value));
sayEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') enqueueSpeak(sayEl.value, voiceEl.value); });
document.getElementById('mic').addEventListener('click', (e) => toggleMic(e.currentTarget));
document.getElementById('demo').addEventListener('click', () => { ensureAudio(); demoUntil = performance.now() + 2600; setStatus('demo lips'); });
document.querySelectorAll('#emo button').forEach((b) => b.addEventListener('click', () => applyEmotion(b.dataset.emo)));

// ── Ambient mirror mode ──────────────────────────────────────────────────────
// Subscribe to the server SSE and speak Kate's replies as they finalize, so a
// wall display becomes an autonomous presence. The full reply text comes from
// accumulated `message_token` deltas (content_preview is capped at 200 chars);
// `message_added` (specialist=kate) finalizes → enqueue to TTS + lip-sync.
let sse = null;
const kateStreams = {};       // conversation_id -> accumulated reply text
const spokenKeys = new Set(); // dedup (guards SSE reconnect replays)

function onSseEvent(e) {
  if (e.type === 'message_token' && e.specialist_id === 'kate') {
    kateStreams[e.conversation_id] = (kateStreams[e.conversation_id] || '') + (e.delta || '');
  } else if (e.type === 'message_added' && e.role === 'specialist' && e.specialist_id === 'kate') {
    const full = (kateStreams[e.conversation_id] || '').trim() || (e.content_preview || '').trim();
    delete kateStreams[e.conversation_id];
    if (!full) return;
    const key = `${e.conversation_id}:${full.length}:${full.slice(0, 40)}`;
    if (spokenKeys.has(key)) return;
    spokenKeys.add(key);
    setStatus('mirror: speaking');
    ensureAudio();
    enqueueSpeak(full, voiceEl.value);
  }
}

function setMirror(on) {
  state.mirror = on;
  document.getElementById('mirror').classList.toggle('on', on);
  if (on && !sse) {
    ensureAudio(); // first user gesture path; autoplay may still need a tap
    sse = new EventSource('/app/api/events');
    sse.onmessage = (ev) => { let e; try { e = JSON.parse(ev.data); } catch (_) { return; } onSseEvent(e); };
    sse.onerror = () => setStatus('mirror: reconnecting…'); // EventSource auto-retries
    setStatus('mirror: listening');
  } else if (!on && sse) {
    sse.close();
    sse = null;
    setStatus('ready');
  }
}
document.getElementById('mirror').addEventListener('click', () => setMirror(!state.mirror));

// URL flags for the wall display: ?mirror=1 auto-listens, ?kiosk=1 hides the
// control bar + HUD for a clean ambient screen.
const params = new URLSearchParams(location.search);
if (params.get('kiosk') === '1') {
  document.getElementById('bar').style.display = 'none';
  document.getElementById('hud').style.display = 'none';
}
if (params.get('mirror') === '1') {
  // Autoplay needs a gesture; arm on first interaction if the browser blocks it.
  const arm = () => { setMirror(true); window.removeEventListener('pointerdown', arm); };
  setMirror(true);
  window.addEventListener('pointerdown', arm, { once: true });
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Expose a tiny debug handle so the mouth value is inspectable from the console.
window.__kate = state;

// ── Render loop ──────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let fpsAccum = 0, fpsFrames = 0;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (state.vrm) {
    updateBodyAnim(dt); // mixer drives body bones (idle ⇄ talk)
    relaxHands(state.vrm); // curl fingers (clip doesn't pose them)
    const em = state.vrm.expressionManager;
    // written AFTER the mixer so our face stays authoritative over any clip
    if (em) { updateBlink(dt, em); updateLipSync(dt, em); updateEmotion(dt, em); }
    state.vrm.update(dt); // springbones + lookAt + applies expression weights
  }
  controls.update();
  renderer.render(scene, camera);

  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 0.5) { state.fps = Math.round(fpsFrames / fpsAccum); fpsAccum = 0; fpsFrames = 0; }
  hud.textContent =
    `status  ${state.status}\n` +
    `fps     ${state.fps}\n` +
    `mouth   ${state.mouth.toFixed(2)}\n` +
    `emotion ${state.emotion}`;
}
tick();
