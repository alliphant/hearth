"""Silero VAD (v5) over onnxruntime — open-mic endpointing + barge-in detection.

Raw onnxruntime (NO torch) to keep the container lean — requirements declare only
`onnxruntime` + `numpy`. Consumes 512-sample (32 ms) 16 kHz mono 16-bit PCM
frames — exactly one device API_AUDIO frame (the live device sends 1024-byte =
512-sample frames) — and returns `(speech_probability, is_speech)`.

Silero is STATEFUL: the recurrent state is threaded frame-to-frame. Call
`reset()` at the start of each LISTENING window so a fresh utterance doesn't
inherit the tail of the previous one.

FAIL-SOFT: if onnxruntime or the model file is absent / the model signature is
unexpected, the VAD is DISABLED (`process_frame → (0.0, False)`) and logs once —
the coordinator still runs (degrades to no endpointing / no barge-in) rather than
crashing. This matches the repo's fail-open posture for opportunistic subsystems.

Model file: `silero_vad.onnx` (~2 MB), v5. Path resolution:
  HEARTH_VC_VAD_MODEL env → else `models/silero_vad.onnx` next to this package.
Fetch once with `bash integrations/voice-coordinator/fetch-vad-model.sh`.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger("voice_coordinator.vad")


def default_model_path() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "silero_vad.onnx")


class SileroVad:
    """Stateful Silero v5 VAD. One instance per device/call."""

    def __init__(self, model_path: str | None = None, *, threshold: float = 0.5, sample_rate: int = 16000) -> None:
        self.enabled = False
        self.reason = ""
        self._threshold = threshold
        self._sr = sample_rate
        path = model_path or os.environ.get("HEARTH_VC_VAD_MODEL") or default_model_path()
        try:
            import numpy as np  # noqa: PLC0415
            import onnxruntime as ort  # noqa: PLC0415
        except Exception as e:  # noqa: BLE001
            self.reason = f"onnxruntime/numpy import failed: {e}"
            log.warning("Silero VAD disabled — %s. Endpointing + barge-in are OFF until bound.", self.reason)
            return
        if not os.path.exists(path):
            self.reason = f"model file not found: {path}"
            log.warning(
                "Silero VAD disabled — %s. Run integrations/voice-coordinator/fetch-vad-model.sh "
                "or set HEARTH_VC_VAD_MODEL. Endpointing + barge-in are OFF until bound.",
                self.reason,
            )
            return
        try:
            self._np = np
            opts = ort.SessionOptions()
            opts.inter_op_num_threads = 1
            opts.intra_op_num_threads = 1
            self._sess = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
            in_names = {i.name for i in self._sess.get_inputs()}
            # v5 signature: input [1,512] f32, state [2,1,128] f32, sr int64.
            if not {"input", "state", "sr"}.issubset(in_names):
                self.reason = f"unexpected model inputs {sorted(in_names)} (need input/state/sr — Silero v5 onnx)"
                log.warning("Silero VAD disabled — %s.", self.reason)
                return
            # Silero v5 feeds [context + new] per call: 16 kHz → 64 ctx + 512 new
            # (= 576 to the model); 8 kHz → 32 + 256. Feeding bare 512 (no context)
            # produces garbage probabilities — the context prepend is REQUIRED.
            self._num = 512 if self._sr == 16000 else 256
            self._ctx_size = 64 if self._sr == 16000 else 32
            self._state = np.zeros((2, 1, 128), dtype=np.float32)
            self._context = np.zeros((1, self._ctx_size), dtype=np.float32)
            self._sr_arr = np.array(self._sr, dtype=np.int64)
            self.enabled = True
            log.info(
                "Silero VAD loaded (%s, threshold=%.2f, sr=%d, chunk=%d+%d ctx)",
                path, threshold, sample_rate, self._num, self._ctx_size,
            )
        except Exception as e:  # noqa: BLE001
            self.reason = f"onnx load failed: {e}"
            log.warning("Silero VAD disabled — %s.", self.reason)

    def reset(self) -> None:
        """Clear recurrent state + context — call at the start of each LISTENING window."""
        if self.enabled:
            self._state = self._np.zeros((2, 1, 128), dtype=self._np.float32)
            self._context = self._np.zeros((1, self._ctx_size), dtype=self._np.float32)

    def process_frame(self, pcm16: bytes) -> tuple[float, bool]:
        """One 16-bit-LE mono PCM frame → (speech_probability, is_speech).

        Returns the RAW probability so the state machine can apply BOTH the
        listening threshold and the (higher) barge-in floor to the same value.
        """
        if not self.enabled or not pcm16:
            return (0.0, False)
        np = self._np
        audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        if audio.size == 0:
            return (0.0, False)
        need = self._num  # NEW samples per call (512 @ 16 kHz)
        if audio.size < need:
            audio = np.pad(audio, (0, need - audio.size))
        elif audio.size > need:
            audio = audio[-need:]  # keep the most recent `need` if a frame is oversized
        # Prepend the carried context (Silero v5): model input is [1, ctx+need].
        x = np.concatenate([self._context.reshape(-1), audio]).reshape(1, -1).astype(np.float32)
        try:
            out = self._sess.run(None, {"input": x, "state": self._state, "sr": self._sr_arr})
        except Exception as e:  # noqa: BLE001
            log.debug("VAD inference error (one frame skipped): %s", e)
            return (0.0, False)
        prob = float(np.asarray(out[0]).reshape(-1)[0])
        if len(out) > 1:
            self._state = out[1]  # thread recurrent state
        self._context = x[:, -self._ctx_size:]  # carry the last ctx samples forward
        return (prob, prob >= self._threshold)
