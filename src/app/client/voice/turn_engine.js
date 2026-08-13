/**
 * The pure turn-taking brain of the web voice orb — VAD-driven endpointing +
 * barge-in confirmation as a clock-free state machine. Port of the native
 * client's unit-tested `HearthVoiceCore.VoiceTurnEngine` (hearth-ios), which
 * itself encodes the scheme this repo's Satellite1 voice-coordinator proved
 * live (`integrations/voice-coordinator/state_machine.py` + config.py) and
 * the production voice-agent consensus (Pipecat / LiveKit / OpenAI Realtime).
 *
 * No I/O, no timers, no audio — time arrives as event payloads, decisions
 * leave as action strings. voice.html is the executor. Tested by
 * `bun run smoke:web-voice-engine`.
 *
 * Differences from the iOS original, on purpose:
 *  - Echo-peak decay is expressed PER SECOND and applied as
 *    `decay ** hopDuration`, so the policy is cadence-independent (web hops
 *    are 32 ms via Silero v5 / vad-web; iOS hops are 256 ms via CoreML).
 *  - `endpoint` does not require a live transcript: web STT is batch whisper
 *    (the transcript exists only AFTER the endpoint), so the executor owns
 *    the "empty transcript → just re-listen" decision. The adaptive
 *    completeness budgets remain for a future streaming-STT upgrade; today
 *    the neutral budget always applies.
 */

export const DEFAULT_TUNABLES = Object.freeze({
  // VAD hysteresis: a hop enters "speech" at/above enter, leaves below exit.
  speechEnterProbability: 0.75,
  speechExitProbability: 0.5,

  // Trailing silence that endpoints an utterance (seconds). Neutral is the
  // live one on web (no streaming transcript to judge completeness yet);
  // Satellite1 shipped 0.7 flat, LiveKit min 0.55, OpenAI server_vad 0.5.
  endpointSilenceComplete: 0.55,
  endpointSilenceNeutral: 0.8,
  endpointSilenceIncomplete: 1.3,

  // Cumulative voiced time before the window counts as "heard speech".
  minSpeech: 0.25,
  // Hard cap on one utterance — endpoint with whatever we have. Web is
  // batch-STT, so this also bounds the upload (30 s of 16 k wav ≈ 0.9 MB).
  maxUtterance: 30,
  // Recycle an idle (never-heard-speech) window: resets recurrent VAD state
  // and the capture buffer on a long-open mic.
  recycleIdleListenAfter: 50,

  // Barge-in during SPEAKING: probability floor hardened against residual
  // echo (Satellite1 ran 0.7 on a 0.5 base), sustained-speech confirmation
  // (LiveKit min_interruption_duration = 0.5 s), an absolute mic-RMS floor
  // (≈ Satellite1's 500/32768), and an adaptive gate vs. the decayed peak of
  // recent clearly-non-speech (presumed echo) hops.
  bargeProbability: 0.9,
  bargeSustain: 0.5,
  bargeRMSFloor: 0.015,
  bargeRMSEchoRatio: 2.0,
  // Per-SECOND decay of the echo peak (0.98 per 256 ms hop on iOS ≈ 0.92/s).
  echoPeakDecayPerSecond: 0.92,

  // Barge-in during THINKING (nothing playing → listening-grade probability
  // + the absolute RMS floor).
  thinkingBargeSustain: 0.4,
});

/** Actions returned by `vadHop` — the executor performs them. */
export const Action = Object.freeze({
  ENDPOINT: 'endpoint',
  RESTART_LISTENING: 'restartListening',
  BARGE_INTO_SPEAKING: 'bargeIntoSpeaking',
  BARGE_INTO_THINKING: 'bargeIntoThinking',
});

export class VoiceTurnEngine {
  /**
   * @param {object} opts
   * @param {boolean} opts.bargeCapable   echo-cancelled mic + user toggle on
   * @param {boolean} [opts.thinkingBargeCapable] defaults to bargeCapable's
   *   toggle intent; needs no AEC (nothing is playing while thinking)
   * @param {object} [opts.tunables]      overrides merged over DEFAULT_TUNABLES
   */
  constructor({ bargeCapable, thinkingBargeCapable, tunables } = {}) {
    this.t = { ...DEFAULT_TUNABLES, ...(tunables || {}) };
    this.bargeCapable = !!bargeCapable;
    this.thinkingBargeCapable = thinkingBargeCapable === undefined ? !!bargeCapable : !!thinkingBargeCapable;
    this.phase = 'idle'; // idle | listening | thinking | speaking

    // Listening window
    this._inSpeech = false;
    this._speechTime = 0;
    this._trailingSilence = 0;
    this._windowElapsed = 0;
    this._completeness = 'neutral'; // complete | neutral | incomplete

    // Barge confirmation (speaking + thinking)
    this._bargeSpeechTime = 0;
    this._echoPeakRMS = 0;
  }

  /** Cumulative voiced time crossed the "this was speech, not a blip" bar. */
  get heardSpeech() {
    return this._speechTime >= this.t.minSpeech;
  }

  /**
   * A listening window opened. `seededFromBarge` marks the restart following
   * a barge-in: the user is ALREADY speaking, so speech is pre-credited and
   * the window can endpoint without re-confirmation.
   */
  listenStarted(seededFromBarge = false) {
    this.phase = 'listening';
    this._windowElapsed = 0;
    this._trailingSilence = 0;
    this._completeness = 'neutral';
    this._bargeSpeechTime = 0;
    this._inSpeech = !!seededFromBarge;
    this._speechTime = seededFromBarge ? this.t.minSpeech : 0;
  }

  thinkStarted() {
    this.phase = 'thinking';
    this._bargeSpeechTime = 0;
  }

  speakStarted() {
    this.phase = 'speaking';
    this._bargeSpeechTime = 0;
    // Warm-start the echo tracker at the floor so speechy residual echo on
    // the very first hops faces a 2×-floor gate, not the bare floor.
    this._echoPeakRMS = this.t.bargeRMSFloor;
  }

  sessionEnded() {
    this.phase = 'idle';
  }

  /** Future streaming-STT hook — adjusts the endpoint budget. */
  transcriptChanged(completeness) {
    if (this.phase !== 'listening') return;
    this._completeness = completeness || 'neutral';
  }

  /**
   * One VAD hop over `duration` seconds of mic audio (echo-cancelled when
   * AEC is live). Returns an `Action` string or null.
   * @param {number} probability Silero speech probability 0..1
   * @param {number} rms mic RMS 0..1 for the same hop
   * @param {number} duration seconds (32 ms hops from vad-web v5)
   */
  vadHop(probability, rms, duration) {
    switch (this.phase) {
      case 'listening': return this._listeningHop(probability, duration);
      case 'speaking': return this._speakingHop(probability, rms, duration);
      case 'thinking': return this._thinkingHop(probability, rms, duration);
      default: return null;
    }
  }

  // ── Listening — VAD endpointing ────────────────────────────────────────

  _listeningHop(probability, duration) {
    this._windowElapsed += duration;

    // Hysteresis: enter speech high, leave it low (a mid-word dip between
    // the two thresholds keeps counting as speech).
    if (this._inSpeech) {
      if (probability < this.t.speechExitProbability) this._inSpeech = false;
    } else if (probability >= this.t.speechEnterProbability) {
      this._inSpeech = true;
    }
    if (this._inSpeech) {
      this._speechTime += duration;
      this._trailingSilence = 0;
    } else {
      this._trailingSilence += duration;
    }

    // Every terminal action parks the engine in idle so trailing hops can't
    // double-fire while the executor finalizes — the next listenStarted /
    // thinkStarted re-arms it.
    if (this.heardSpeech && this._trailingSilence >= this._silenceBudget()) {
      this.phase = 'idle';
      return Action.ENDPOINT;
    }
    if (this.heardSpeech && this._windowElapsed >= this.t.maxUtterance) {
      this.phase = 'idle';
      return Action.ENDPOINT;
    }
    if (!this.heardSpeech && this._windowElapsed >= this.t.recycleIdleListenAfter) {
      this.phase = 'idle';
      return Action.RESTART_LISTENING;
    }
    return null;
  }

  _silenceBudget() {
    switch (this._completeness) {
      case 'complete': return this.t.endpointSilenceComplete;
      case 'incomplete': return this.t.endpointSilenceIncomplete;
      default: return this.t.endpointSilenceNeutral;
    }
  }

  // ── Speaking — echo-hardened barge-in ──────────────────────────────────

  _speakingHop(probability, rms, duration) {
    if (!this.bargeCapable) return null;

    // Evaluate against the peak BEFORE this hop so the user's own speech
    // can't raise the bar it has to clear.
    const gate = Math.max(this.t.bargeRMSFloor, this._echoPeakRMS * this.t.bargeRMSEchoRatio);
    const isBargeSpeech = probability >= this.t.bargeProbability && rms >= gate;

    if (isBargeSpeech) {
      this._bargeSpeechTime += duration;
    } else {
      this._bargeSpeechTime = 0;
      this._echoPeakRMS *= this.t.echoPeakDecayPerSecond ** duration;
      // Only clearly-non-speech hops teach the echo tracker: a pause between
      // the USER'S own words (mid-probability, high RMS) must not raise the
      // bar their resumed interruption has to clear.
      if (probability < this.t.speechExitProbability) {
        this._echoPeakRMS = Math.max(this._echoPeakRMS, rms);
      }
    }

    if (this._bargeSpeechTime >= this.t.bargeSustain) {
      this.phase = 'idle'; // executor reopens listening (seeded) momentarily
      return Action.BARGE_INTO_SPEAKING;
    }
    return null;
  }

  // ── Thinking — speech cancels the pending turn ─────────────────────────

  _thinkingHop(probability, rms, duration) {
    if (!this.thinkingBargeCapable) return null;

    const isSpeech = probability >= this.t.speechEnterProbability && rms >= this.t.bargeRMSFloor;
    this._bargeSpeechTime = isSpeech ? this._bargeSpeechTime + duration : 0;

    if (this._bargeSpeechTime >= this.t.thinkingBargeSustain) {
      this.phase = 'idle';
      return Action.BARGE_INTO_THINKING;
    }
    return null;
  }
}
