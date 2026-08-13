"""Configuration for the Hearth Voice Coordinator.

Every value is an env-var override with a sane default, mirroring the repo's
"never hard-code paths/hosts" convention (see agentd config.ts and the
push_receiver unit). The the LLM host deploy supplies these via the compose env;
local dev / a dev-kit run supplies them on the CLI.

Facts pinned from docs/design-esp-direct-voice.md §8:
  - device      192.168.0.29  (satellite1-aabbcc), native API port 6053
  - parakeet    <your-llm-host-ip>:8093  (STT faster-whisper-large-v3-turbo-ct2)
  - forza TTS   192.168.0.188:8023  (voice EN_F_Laur)
  - orchestrator 127.0.0.1:7700 (host network on the LLM host)

The PSK is a SECRET — supply it via HEARTH_VC_DEVICE_PSK (compose env /
EnvironmentFile), never a checked-in default. Same for the Hearth bearer.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v is not None and v != "" else default


def _env_opt(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v else None


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class DeviceConfig:
    """The ESPHome Satellite1 native-API endpoint."""

    host: str = field(default_factory=lambda: _env("HEARTH_VC_DEVICE_HOST", "192.168.0.29"))
    port: int = field(default_factory=lambda: _env_int("HEARTH_VC_DEVICE_PORT", 6053))
    # Noise PSK (base64) — REQUIRED to authenticate. None ⇒ the client logs and
    # no-ops (so the skeleton runs against a device it can't reach without
    # crashing). On the LLM host it comes from HA's core.config_entries; paste it
    # into the compose EnvironmentFile.
    psk: str | None = field(default_factory=lambda: _env_opt("HEARTH_VC_DEVICE_PSK"))
    # Optional plaintext-API password fallback (only if a device ever runs the
    # API without encryption — the live device uses Noise, so normally unset).
    password: str = field(default_factory=lambda: _env("HEARTH_VC_DEVICE_PASSWORD", ""))
    # Human label for logs / multi-device disambiguation.
    name: str = field(default_factory=lambda: _env("HEARTH_VC_DEVICE_NAME", "satellite1"))
    # Expected device hostname (`satellite1-aabbcc`) — connect uses host/IP, this
    # is only for the noise-handshake `expected_name` sanity check when set.
    expected_name: str | None = field(default_factory=lambda: _env_opt("HEARTH_VC_DEVICE_EXPECTED_NAME"))


@dataclass(frozen=True)
class HearthConfig:
    """The orchestrator + the bearer the coordinator authenticates with."""

    base_url: str = field(default_factory=lambda: _env("HEARTH_VC_HEARTH_URL", "http://127.0.0.1:7700").rstrip("/"))
    bearer: str | None = field(default_factory=lambda: _env_opt("HEARTH_INTERNAL_BEARER") or _env_opt("HEARTH_VC_BEARER"))
    specialist_id: str = field(default_factory=lambda: _env("HEARTH_VC_SPECIALIST", "kate"))
    # user_id the conversation runs as (must match the bearer's device user).
    user_id: str = field(default_factory=lambda: _env("HEARTH_VC_USER_ID", "jasper"))
    # Per-turn timeout for the message POST (the streaming reply arrives on SSE).
    turn_timeout_s: float = field(default_factory=lambda: _env_float("HEARTH_VC_TURN_TIMEOUT_S", 180.0))


@dataclass(frozen=True)
class SttConfig:
    """parakeet/speaches faster-whisper, OpenAI-compat transcription."""

    base_url: str = field(default_factory=lambda: _env("HEARTH_VC_STT_URL", "http://<your-llm-host-ip>:8093/v1").rstrip("/"))
    model: str = field(
        default_factory=lambda: _env("HEARTH_VC_STT_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
    )
    language: str = field(default_factory=lambda: _env("HEARTH_VC_STT_LANGUAGE", "en"))
    timeout_s: float = field(default_factory=lambda: _env_float("HEARTH_VC_STT_TIMEOUT_S", 30.0))


@dataclass(frozen=True)
class TtsConfig:
    """forza Kokoro/Zonos, OpenAI-compat speech synthesis."""

    base_url: str = field(default_factory=lambda: _env("HEARTH_VC_TTS_URL", "http://192.168.0.188:8023/v1").rstrip("/"))
    voice: str = field(default_factory=lambda: _env("HEARTH_VC_TTS_VOICE", "EN_F_Laur"))
    model: str = field(default_factory=lambda: _env("HEARTH_VC_TTS_MODEL", "EN_F_Laur"))
    # mp3 is the CONFIRMED media_player playback format (the device fetched +
    # played an mp3 clip out the speaker while the mic stayed open, 2026-06-07).
    # The SPEAKING output serves the clip at an HTTP URL the device GETs.
    response_format: str = field(default_factory=lambda: _env("HEARTH_VC_TTS_FORMAT", "mp3"))
    sample_rate: int = field(default_factory=lambda: _env_int("HEARTH_VC_TTS_SAMPLE_RATE", 24000))
    timeout_s: float = field(default_factory=lambda: _env_float("HEARTH_VC_TTS_TIMEOUT_S", 60.0))


@dataclass(frozen=True)
class VadConfig:
    """Silero VAD endpointing on the AEC'd mic + the barge-in threshold.

    The barge-in energy/probability threshold MUST sit ABOVE the §2-measured
    residual echo floor (design §3 / risks). It's a config knob, not a magic
    constant, precisely so the AEC test result tunes it without a code change.
    """

    # Silero speech probability over which a frame counts as "speech".
    speech_threshold: float = field(default_factory=lambda: _env_float("HEARTH_VC_VAD_SPEECH_THRESHOLD", 0.5))
    # End-of-utterance silence gap (ms) before we treat LISTENING as done.
    endpoint_silence_ms: int = field(default_factory=lambda: _env_int("HEARTH_VC_VAD_ENDPOINT_SILENCE_MS", 700))
    # Self-heal a hung LISTENING window. A false wake (no command spoken) hangs the
    # machine in LISTENING with no endpoint — the device LED ring spins until reset.
    # If NO speech onset is detected within this window, the coordinator resets to
    # IDLE (run_end → ring off). It is gated on no-speech, so once the user starts
    # talking the endpoint logic owns the close-out and a real command is never cut
    # off — which is what makes a short 5 s safe.
    max_listen_s: float = field(default_factory=lambda: _env_float("HEARTH_VC_MAX_LISTEN_S", 5.0))
    # During SPEAKING, sustained speech for this long over the echo floor
    # triggers BARGE-IN. >~300 ms per design §3 to reject transient echo.
    barge_in_min_ms: int = field(default_factory=lambda: _env_int("HEARTH_VC_BARGE_IN_MIN_MS", 320))
    # The residual-echo floor the AEC test measures. A frame's speech signal
    # must exceed BOTH the silero threshold AND this floor to count as a
    # genuine interrupt while Kate is talking. Default conservative until the
    # §2 ERLE/WER test sets it.
    barge_in_speech_threshold: float = field(
        default_factory=lambda: _env_float("HEARTH_VC_BARGE_IN_SPEECH_THRESHOLD", 0.7)
    )
    # Energy (16-bit PCM RMS) floor a frame must clear to count as a BARGE during
    # playback. Kate's AEC'd residual is speech-SHAPED (high Silero prob) but
    # QUIET; a real barge is loud. This floor separates the two so she doesn't
    # barge herself. Tune from the live "mic during SPEAKING … rms=" telemetry.
    barge_in_rms_floor: float = field(
        default_factory=lambda: _env_float("HEARTH_VC_BARGE_IN_RMS_FLOOR", 500.0)
    )
    # B+ adaptive echo-floor (design-voice-barge-in.md §5). The barge floor is
    # max(barge_in_rms_floor, observed-residual-peak × ratio) — so a loud syllable
    # the fixed floor would let through is rejected, while a louder human passes.
    # ratio = how many× over the live residual a barge must be; decay = per-frame
    # (32 ms) decay of the residual peak-hold.
    barge_in_rms_ratio: float = field(
        default_factory=lambda: _env_float("HEARTH_VC_BARGE_IN_RMS_RATIO", 2.0)
    )
    barge_in_echo_peak_decay: float = field(
        default_factory=lambda: _env_float("HEARTH_VC_BARGE_IN_ECHO_DECAY", 0.98)
    )
    # Frame size the VAD consumes (Silero v5 wants 512 samples @ 16 kHz = 32 ms).
    frame_samples: int = field(default_factory=lambda: _env_int("HEARTH_VC_VAD_FRAME_SAMPLES", 512))
    sample_rate: int = field(default_factory=lambda: _env_int("HEARTH_VC_MIC_SAMPLE_RATE", 16000))
    # Path to silero_vad.onnx (v5). Empty → vad.default_model_path()
    # (models/silero_vad.onnx next to the package; fetch via fetch-vad-model.sh).
    model_path: str = field(default_factory=lambda: _env("HEARTH_VC_VAD_MODEL", ""))


@dataclass(frozen=True)
class CoordinatorConfig:
    device: DeviceConfig = field(default_factory=DeviceConfig)
    hearth: HearthConfig = field(default_factory=HearthConfig)
    stt: SttConfig = field(default_factory=SttConfig)
    tts: TtsConfig = field(default_factory=TtsConfig)
    vad: VadConfig = field(default_factory=VadConfig)
    # Health endpoint port (host network on the LLM host). The container exposes a
    # tiny /health for `restart: unless-stopped` + monitoring, and serves the
    # SPEAKING-state TTS clips at /tts/<id> for the device to fetch.
    health_port: int = field(default_factory=lambda: _env_int("HEARTH_VC_HEALTH_PORT", 8094))
    # The coordinator's OWN LAN host/IP — the device fetches TTS clips from here
    # (http://<self_host>:<health_port>/tts/<id>). Host-network on the LLM host =
    # <your-llm-host-ip>. MUST be device-reachable (not 127.0.0.1).
    self_host: str = field(default_factory=lambda: _env("HEARTH_VC_SELF_HOST", "<your-llm-host-ip>"))
    # When true, require LD2450 "present & near" to accept a barge-in (design
    # §3 optional gate). Off by default until presence republish lands (Phase 3).
    gate_barge_in_on_presence: bool = field(
        default_factory=lambda: _env_bool("HEARTH_VC_GATE_BARGE_ON_PRESENCE", False)
    )
    # SPEAKING-output playback mode (design-voice-barge-in.md §5 Phase B):
    #   'stream_gapless' [default] — ONE continuous chunked HTTP stream per turn
    #     (forza mp3 piped through as it synthesizes). Same time-to-first-word as
    #     multi-clip, but ONE media_player session = ONE stable mic↔ref delay, so
    #     the XMOS `fixed_delay` AEC converges once and HOLDS (residual ≈20). This
    #     is what makes open-mic barge safe; required for enable_barge_in.
    #   'stream' — legacy per-sentence multi-clip (rollback). Re-issues a
    #     media_player announcement per sentence; each restart shifts the mic↔ref
    #     delay and de-converges the AEC (residual ≈11k → self-barge). Playback
    #     only — the runtime refuses to arm the open mic in this mode.
    tts_playback_mode: str = field(
        default_factory=lambda: _env("HEARTH_VC_TTS_PLAYBACK_MODE", "stream_gapless")
    )
    # Phase A — the physical Action button as a deterministic, AEC-independent
    # barge. `btn_action` is a binary_sensor; its press surfaces over the native
    # API (and the firmware already stops playback locally on a single press), so
    # the coordinator catches the rising edge → cancel the turn + re-listen. ON by
    # default (no false-fire risk, unlike the acoustic path).
    barge_button: bool = field(default_factory=lambda: _env_bool("HEARTH_VC_BARGE_BUTTON", True))
    # The device entity name (or object_id substring) that identifies that button.
    barge_button_name: str = field(
        default_factory=lambda: _env("HEARTH_VC_BARGE_BUTTON_NAME", "Button Right (Action)")
    )
    # Master switch for ACOUSTIC (open-mic) full-duplex barge-in. OFF by default
    # until gapless playback is confirmed AEC-converged on-device (Probe 1,
    # design-voice-barge-in.md §7): with 'stream' (multi-clip) playback Kate's
    # residual self-barges, so the runtime only arms the open mic when the mode is
    # 'stream_gapless'. The Action button (above) gives working barge meanwhile.
    enable_barge_in: bool = field(
        default_factory=lambda: _env_bool("HEARTH_VC_ENABLE_BARGE_IN", False)
    )
    # Proactive spoken followups (2026-06-15). Hearth POSTs a concluded promised
    # followup to POST /speak; if the user is present+near the device speaks it,
    # else it answers spoken:false and Hearth pushes instead. ON by default; the
    # /speak route is bearer-gated (cfg.hearth.bearer) since it puts audio in the
    # room. Kill switch for the whole proactive-speak path.
    enable_announce: bool = field(
        default_factory=lambda: _env_bool("HEARTH_VC_ENABLE_ANNOUNCE", True)
    )
    # Inferred spoken emotion (2026-06-16; per-sentence 2026-07-08). When on, the
    # coordinator classifies each reply sentence's tone (context-aware per sentence
    # by default — see emotion_per_sentence — via Hearth POST /api/voice/emotion) and
    # passes the resulting `instruct` to the Laur fine-tune. OFF by default; fails
    # open to neutral on any classify error.
    enable_emotion: bool = field(
        default_factory=lambda: _env_bool("HEARTH_VC_EMOTION", False)
    )
    # Context-aware PER-SENTENCE emotion (2026-07-08). On (default): each sentence is
    # classified GIVEN the whole reply-so-far and delivered with its OWN instruct, so
    # a reply that opens neutral/factual and lands on a warm/reassuring closer (the
    # measured-common shape) gets that arc instead of one flat turn tone. The classify
    # rides one sentence AHEAD of playback, so only sentence 1 is on the first-audio
    # path (same cost as turn-once). Set 0 to classify once from the first sentence.
    # No effect unless enable_emotion is on.
    emotion_per_sentence: bool = field(
        default_factory=lambda: _env_bool("HEARTH_VC_EMOTION_PER_SENTENCE", True)
    )
    # Max ms the synth loop waits for a sentence's per-sentence emotion classify before
    # speaking it neutral. The classify is PRE-KICKED when the sentence arrives (SPEAK),
    # so by synth time it is almost always already done and this wait is ~0; the cap is
    # the backstop so a slow/contended classify can never stall the gapless stream (the
    # inter-sentence-gap regression this replaced).
    emotion_wait_ms: int = field(
        default_factory=lambda: _env_int("HEARTH_VC_EMOTION_WAIT_MS", 500)
    )
    # Overlapped ("speculative") batch STT (2026-07-08). speaches has no usable
    # streaming-transcription endpoint (/v1/realtime is WebRTC-only + rc-buggy), and
    # batch STT is already fast (~0.15-0.5 s) — the real fixed post-speech latency is
    # the VAD endpoint-silence wait. So instead of streaming, OVERLAP the batch
    # transcription with that wait: at the first trailing pause (stt_overlap_silence_ms
    # of silence after speech) the coordinator fires a batch transcription of the
    # utterance-so-far, so it finishes DURING the endpoint wait; _run_stt uses that
    # result if speech didn't resume (else re-transcribes). FAIL-OPEN: any error → a
    # normal batch transcription, never a regression. ON by default;
    # HEARTH_VC_STT_OVERLAP=0 reverts to transcribe-only-after-endpoint.
    stt_overlap: bool = field(
        default_factory=lambda: _env_bool("HEARTH_VC_STT_OVERLAP", True)
    )
    # Trailing-silence (ms) after speech before firing the speculative transcription.
    # MUST be < endpoint_silence_ms so the STT overlaps the remaining wait; large
    # enough to skip within-utterance micro-pauses.
    stt_overlap_silence_ms: int = field(
        default_factory=lambda: _env_int("HEARTH_VC_STT_OVERLAP_SILENCE_MS", 250)
    )
    log_level: str = field(default_factory=lambda: _env("HEARTH_VC_LOG_LEVEL", "INFO"))

    @classmethod
    def from_env(cls) -> "CoordinatorConfig":
        return cls()
