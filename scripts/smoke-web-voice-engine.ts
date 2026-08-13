/**
 * Smoke: web voice orb turn engine (src/app/client/voice/turn_engine.js).
 *
 * Synthetic-probability tests for the pure endpointing/barge-in state
 * machine — the same contract suite as the native client's HearthVoiceCore
 * tests (hearth-ios) and the Satellite1 coordinator's state-machine checks,
 * at the web's 32 ms hop cadence (Silero v5 via vad-web).
 *
 *   bun run smoke:web-voice-engine
 */

// Plain-JS browser module (no .d.ts on purpose — it ships to the client as-is).
// @ts-expect-error — untyped ES module; the smoke exercises its runtime contract.
import { Action, DEFAULT_TUNABLES, VoiceTurnEngine } from '../src/app/client/voice/turn_engine.js';

const HOP = 0.032; // 512 samples @ 16 kHz

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

type Pumped = { action: string; atHop: number } | null;
function pump(engine: VoiceTurnEngine, probability: number, rms: number, hops: number): Pumped {
  for (let i = 1; i <= hops; i++) {
    const action = engine.vadHop(probability, rms, HOP);
    if (action) return { action, atHop: i };
  }
  return null;
}
const hopsFor = (seconds: number) => Math.ceil(seconds / HOP);

// ── Endpointing ────────────────────────────────────────────────────────────
{
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.listenStarted(false);
  check('speech alone never endpoints', pump(e, 0.95, 0.1, hopsFor(2)) === null);
  const r = pump(e, 0.05, 0.001, hopsFor(3));
  check('endpoints after neutral silence budget', r?.action === Action.ENDPOINT);
  const wantHop = hopsFor(DEFAULT_TUNABLES.endpointSilenceNeutral);
  check(
    `neutral endpoint lands at ~${DEFAULT_TUNABLES.endpointSilenceNeutral}s (hop ${r ? r.atHop : '-'} ≈ ${wantHop})`,
    r !== null && Math.abs(r.atHop - wantHop) <= 1,
    `got hop ${r ? r.atHop : 'none'}`,
  );
  check('engine parks idle after endpoint', e.phase === 'idle');
  check('parked engine ignores further hops', pump(e, 0.95, 0.1, 20) === null);
}

{
  // Hysteresis: a mid-word dip between exit (0.5) and enter (0.75) stays
  // "speech" — trailing silence must not accumulate.
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.listenStarted(false);
  pump(e, 0.95, 0.1, 4);
  check('hysteresis bridges mid-word dips', pump(e, 0.6, 0.05, hopsFor(3)) === null);
}

{
  // Adaptive budgets stay wired for a future streaming-STT upgrade.
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.listenStarted(false);
  pump(e, 0.95, 0.1, 8); // ≥ minSpeech
  e.transcriptChanged('complete');
  const r = pump(e, 0.05, 0.001, hopsFor(3));
  check(
    'complete-sounding transcript endpoints faster',
    r !== null && r.action === Action.ENDPOINT
      && Math.abs(r.atHop - hopsFor(DEFAULT_TUNABLES.endpointSilenceComplete)) <= 1,
    `got hop ${r ? r.atHop : 'none'}`,
  );
}

{
  const t = { maxUtterance: 2.0 };
  const e = new VoiceTurnEngine({ bargeCapable: true, tunables: t });
  e.listenStarted(false);
  const r = pump(e, 0.95, 0.1, hopsFor(3));
  check('max utterance endpoints a ramble', r?.action === Action.ENDPOINT);
}

{
  const e = new VoiceTurnEngine({ bargeCapable: true, tunables: { recycleIdleListenAfter: 1.0 } });
  e.listenStarted(false);
  const r = pump(e, 0.05, 0.001, hopsFor(2));
  check('idle window recycles (never-heard-speech)', r?.action === Action.RESTART_LISTENING);
}

// ── Barge-in during SPEAKING ───────────────────────────────────────────────
{
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.listenStarted(false);
  e.thinkStarted();
  e.speakStarted();
  const r = pump(e, 0.95, 0.1, hopsFor(2));
  check('sustained speech barges into speaking', r?.action === Action.BARGE_INTO_SPEAKING);
  check(
    `barge confirms at ~${DEFAULT_TUNABLES.bargeSustain}s sustain`,
    r !== null && Math.abs(r.atHop - hopsFor(DEFAULT_TUNABLES.bargeSustain)) <= 1,
    `got hop ${r?.atHop}`,
  );
}

{
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.speakStarted();
  check('echo-like hops (high RMS, low probability) never barge', pump(e, 0.6, 0.3, 40) === null);
}

{
  // Warm start: gate is 2×floor from hop one, so speechy residual echo above
  // the bare floor but below the warmed gate can't barge.
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.speakStarted();
  check('warm-started echo gate blocks quiet speechy leak', pump(e, 0.95, 0.02, 40) === null);
}

{
  // Adaptive gate: loud clearly-non-speech echo raises the floor; a quiet
  // speechy leak then can't clear peak × ratio.
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.speakStarted();
  pump(e, 0.4, 0.2, 4);
  check('adaptive RMS gate blocks quiet leak after loud echo', pump(e, 0.95, 0.05, 40) === null);
}

{
  // A pause between the USER'S own words (mid-probability, high RMS) must
  // not teach the echo tracker — the resumed interruption still lands.
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.speakStarted();
  pump(e, 0.95, 0.3, 3); // "Wait—" (below sustain)
  check('user pause hop emits nothing', pump(e, 0.6, 0.2, 1) === null);
  const r = pump(e, 0.95, 0.3, hopsFor(2));
  check('resumed interruption still barges', r?.action === Action.BARGE_INTO_SPEAKING);
  check(
    'resume needs a fresh full sustain',
    r !== null && Math.abs(r.atHop - hopsFor(DEFAULT_TUNABLES.bargeSustain)) <= 1,
    `got hop ${r?.atHop}`,
  );
}

{
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.speakStarted();
  pump(e, 0.95, 0.1, 5); // below sustain
  pump(e, 0.05, 0.001, 1); // reset
  check('interrupted barge does not accumulate', pump(e, 0.95, 0.1, 5) === null);
}

{
  const e = new VoiceTurnEngine({ bargeCapable: false });
  e.speakStarted();
  check('bargeCapable=false means half-duplex', pump(e, 0.99, 0.5, 100) === null);
}

{
  // Barge-seeded listen: speech pre-credited → straight-to-silence endpoints.
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.speakStarted();
  pump(e, 0.95, 0.1, hopsFor(1));
  e.listenStarted(true);
  const r = pump(e, 0.05, 0.001, hopsFor(2));
  check('barge-seeded listen needs no reconfirmation', r?.action === Action.ENDPOINT);
}

// ── Barge-in during THINKING ───────────────────────────────────────────────
{
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.thinkStarted();
  const r = pump(e, 0.9, 0.1, hopsFor(1));
  check('speech during thinking cancels the turn', r?.action === Action.BARGE_INTO_THINKING);
  check(
    `thinking barge confirms at ~${DEFAULT_TUNABLES.thinkingBargeSustain}s`,
    r !== null && Math.abs(r.atHop - hopsFor(DEFAULT_TUNABLES.thinkingBargeSustain)) <= 1,
    `got hop ${r?.atHop}`,
  );
}

{
  const e = new VoiceTurnEngine({ bargeCapable: true });
  e.thinkStarted();
  check('quiet noise during thinking does not cancel (RMS floor)', pump(e, 0.9, 0.005, 30) === null);
  check('non-speech during thinking does not cancel (probability)', pump(e, 0.5, 0.2, 30) === null);
}

{
  // Thinking barge needs no AEC — it can stay on when playback barge is off.
  const e = new VoiceTurnEngine({ bargeCapable: false, thinkingBargeCapable: true });
  e.thinkStarted();
  const r = pump(e, 0.9, 0.1, hopsFor(1));
  check('thinking barge survives an AEC-less graph', r?.action === Action.BARGE_INTO_THINKING);
}

// ── Phase gating ───────────────────────────────────────────────────────────
{
  const e = new VoiceTurnEngine({ bargeCapable: true });
  check('idle engine ignores hops', pump(e, 0.99, 0.5, 10) === null);
  e.listenStarted(false);
  e.sessionEnded();
  check('ended session ignores hops', pump(e, 0.99, 0.5, 10) === null);
}

// ── Cadence independence of the echo decay ─────────────────────────────────
{
  // The per-second decay must behave the same at 32 ms and 256 ms hops:
  // after ~1 s of silence-echo decay, the gate should have relaxed equally.
  const runDecay = (hop: number) => {
    const e = new VoiceTurnEngine({ bargeCapable: true });
    e.speakStarted();
    e.vadHop(0.1, 0.2, hop); // teach the tracker one loud echo hop
    for (let elapsed = hop; elapsed < 1.0; elapsed += hop) e.vadHop(0.1, 0.001, hop);
    // Probe: a speechy hop at rms 0.3 — barge accrues only if 0.3 ≥ gate.
    let accrued = false;
    for (let i = 0; i < Math.ceil(DEFAULT_TUNABLES.bargeSustain / hop) + 2; i++) {
      if (e.vadHop(0.95, 0.3, hop)) { accrued = true; break; }
    }
    return accrued;
  };
  check('echo decay is cadence-independent (32 ms vs 256 ms agree)', runDecay(0.032) === runDecay(0.256));
}

console.log(`\nweb-voice-engine smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
