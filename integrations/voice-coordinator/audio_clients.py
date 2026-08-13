"""STT (parakeet) + TTS (forza) OpenAI-compat clients.

Wire shapes lifted verbatim from scripts/bench-voice.py (the proven probe):
  STT: POST {stt}/audio/transcriptions  (multipart: model + file)  → {"text": …}
  TTS: POST {tts}/audio/speech          (json: model/voice/input/response_format,
                                         stream:true)               → PCM/WAV bytes

Both are pure network I/O over the same A4000/forza endpoints HA's path uses,
so no device session is required to exercise them — they're testable now
(the smoke leaves them out to stay device-free, but ops can hit them directly,
exactly as bench-voice.py does).
"""
from __future__ import annotations

import logging
from typing import AsyncGenerator

import httpx

from .config import SttConfig, TtsConfig

log = logging.getLogger("voice_coordinator.audio")


class SttClient:
    def __init__(self, cfg: SttConfig, *, client: httpx.AsyncClient | None = None) -> None:
        self.cfg = cfg
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(cfg.timeout_s, connect=10.0))
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def transcribe_wav(self, wav_bytes: bytes) -> str:
        """Transcribe a complete WAV clip. Returns the recognized text ('' on miss)."""
        files = {
            "file": ("audio.wav", wav_bytes, "audio/wav"),
        }
        data = {
            "model": self.cfg.model,
            "language": self.cfg.language,
            # `response_format=text` keeps the body a bare string; default JSON
            # also fine. We parse both.
            "response_format": "json",
        }
        r = await self._client.post(
            f"{self.cfg.base_url}/audio/transcriptions",
            files=files,
            data=data,
        )
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        if "application/json" in ctype:
            return str(r.json().get("text", "")).strip()
        return r.text.strip()


class TtsClient:
    def __init__(self, cfg: TtsConfig, *, client: httpx.AsyncClient | None = None) -> None:
        self.cfg = cfg
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(cfg.timeout_s, connect=10.0))
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def synthesize_stream(self, text: str, *, instruct: str = "") -> AsyncGenerator[bytes, None]:
        """Stream synthesized audio bytes for `text`.

        `instruct` (when non-empty) is the emotion cue the Laur fine-tune's
        custom_voice_server accepts (warm/calm/upbeat…); omitted ⇒ neutral.

        Cancellable: the caller (the SPEAKING state) iterates this and stops
        iterating on barge-in, which closes the stream — the local TTS synth is
        torn down without waiting for the full clip (design §3 step 3).
        """
        body = {
            "model": self.cfg.model,
            "voice": self.cfg.voice,
            "input": text,
            "response_format": self.cfg.response_format,
            "stream": True,
        }
        if instruct:
            body["instruct"] = instruct
        async with self._client.stream(
            "POST",
            f"{self.cfg.base_url}/audio/speech",
            json=body,
        ) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk

    async def synthesize(self, text: str, *, instruct: str = "") -> bytes:
        """Non-streaming convenience — the whole clip in one buffer."""
        buf = bytearray()
        async for chunk in self.synthesize_stream(text, instruct=instruct):
            buf.extend(chunk)
        return bytes(buf)
