"""Hearth conversation-API client — the turn lifecycle the barge-in loop drives.

Every route here ALREADY EXISTS in the orchestrator (design §3 "Every Hearth
route it needs already exists"). This is a thin async wrapper, mirroring
/docker/pipecat/hearth_llm_service.py and src/app/routes/openai_shim.ts:

  create_or_reuse_voice_conversation()
    → POST /api/conversations {specialist_id, reuse:true, surface:"voice"}
  send_message(conv_id, text)            (fire-and-forget; reply streams on SSE)
    → POST /api/conversations/{id}/messages {content, surface:"voice"}
  stream_reply(conv_id)                  async-generator of sentence deltas
    → GET  /app/api/events  filtered by conversation_id (message_token → text)
  cancel(conv_id)                        the BARGE-IN backend half
    → POST /api/conversations/{id}/cancel

The cancel + reuse + voice-surface contract is exactly what
scripts/smoke-voice-coordinator.ts proves against the live orchestrator.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import AsyncGenerator

import httpx

from .config import HearthConfig

log = logging.getLogger("voice_coordinator.hearth")


@dataclass
class TurnEvent:
    """One decoded /app/api/events frame relevant to a voice turn."""

    kind: str  # "token" | "done" | "thinking" | "other"
    text: str = ""


class HearthClient:
    def __init__(self, cfg: HearthConfig, *, client: httpx.AsyncClient | None = None) -> None:
        self.cfg = cfg
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(cfg.turn_timeout_s, connect=10.0))
        self._owns_client = client is None

    @property
    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json"}
        if self.cfg.bearer:
            h["authorization"] = f"Bearer {self.cfg.bearer}"
        return h

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ── conversation lifecycle ───────────────────────────────────────────────

    async def create_or_reuse_voice_conversation(self) -> str:
        """Resolve the DEDICATED voice thread (reuse:true, surface:'voice').

        A reconnect rejoins the same thread within HEARTH_VOICE_REUSE_MS — the
        re-greeting fix (the private dev log "Voice reconnect must reuse the
        conversation"). Returns the conversation id.
        """
        r = await self._client.post(
            f"{self.cfg.base_url}/api/conversations",
            headers=self._headers,
            json={
                "specialist_id": self.cfg.specialist_id,
                "user_id": self.cfg.user_id,
                "title": "Voice (Satellite1)",
                "reuse": True,
                "surface": "voice",
            },
        )
        r.raise_for_status()
        conv_id = r.json().get("id")
        if not conv_id:
            raise RuntimeError("create conversation returned no id")
        log.info("voice conversation %s (specialist=%s)", conv_id, self.cfg.specialist_id)
        return conv_id

    def send_message(self, conv_id: str, text: str) -> asyncio.Task[None]:
        """Fire the turn WITHOUT awaiting it (deltas arrive on the SSE stream).

        Returns the background task so the caller can await/observe completion
        (it resolves when the turn — including a cancelled one — settles).
        """

        async def _post() -> None:
            try:
                r = await self._client.post(
                    f"{self.cfg.base_url}/api/conversations/{conv_id}/messages",
                    headers=self._headers,
                    json={"content": text, "surface": "voice"},
                )
                # 200 even for a cancelled turn (it persists "(stopped)").
                if r.status_code != 200:
                    log.warning("send_message %s → HTTP %s", conv_id, r.status_code)
            except Exception:  # noqa: BLE001 — fire-and-forget; SSE end is the signal
                log.exception("send_message failed for %s", conv_id)

        return asyncio.ensure_future(_post())

    async def cancel(self, conv_id: str) -> bool:
        """The BARGE-IN backend half. Aborts the in-flight turn → "(stopped)"."""
        try:
            r = await self._client.post(
                f"{self.cfg.base_url}/api/conversations/{conv_id}/cancel",
                headers=self._headers,
                json={},
                timeout=10.0,
            )
            cancelled = bool(r.json().get("cancelled"))
            log.info("cancel %s → cancelled=%s", conv_id, cancelled)
            return cancelled
        except Exception:  # noqa: BLE001
            log.exception("cancel failed for %s", conv_id)
            return False

    async def classify_emotion(self, text: str, context: str = "") -> str:
        """POST a reply (or ONE sentence of it) to /api/voice/emotion → the `instruct`
        tone word for the Laur fine-tune (warm/calm/upbeat…). When `context` (the full
        reply) is given, the sentence is classified IN CONTEXT so a fragment isn't
        misread (context-aware per-sentence, 2026-07-08). Fails OPEN to '' (neutral)
        on any error — emotion is cosmetic, never load-bearing."""
        try:
            body: dict[str, str] = {"text": text[:4000]}
            if context:
                body["context"] = context[:6000]
            r = await self._client.post(
                f"{self.cfg.base_url}/api/voice/emotion",
                headers=self._headers,
                json=body,
                timeout=5.0,
            )
            if r.status_code != 200:
                return ""
            return str(r.json().get("instruct", "") or "")
        except Exception:  # noqa: BLE001
            return ""

    async def last_specialist_message(self, conv_id: str) -> str | None:
        r = await self._client.get(
            f"{self.cfg.base_url}/api/conversations/{conv_id}/messages",
            headers=self._headers,
            params={"limit": 10},
        )
        r.raise_for_status()
        msgs = [m for m in r.json().get("messages", []) if m.get("role") == "specialist"]
        return msgs[-1]["content_md"] if msgs else None

    # ── streaming reply (the SSE consume the coordinator pipes to TTS) ────────

    async def stream_reply(self, conv_id: str) -> AsyncGenerator[TurnEvent, None]:
        """Yield TurnEvents for `conv_id` off /app/api/events until the turn ends.

        Mirrors openai_shim's bus subscription, but over HTTP SSE (the
        coordinator runs out-of-process). Yields a final TurnEvent(kind="done")
        on the specialist `message_added`, then returns.
        """
        url = f"{self.cfg.base_url}/app/api/events"
        async with self._client.stream(
            "GET",
            url,
            headers={**self._headers, "accept": "text/event-stream"},
            timeout=httpx.Timeout(self.cfg.turn_timeout_s, connect=10.0),
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                ev = _parse_event_line(line)
                if ev is None:
                    continue
                if ev.get("conversation_id") != conv_id:
                    continue
                etype = ev.get("type")
                if etype == "message_token" and ev.get("delta"):
                    yield TurnEvent(kind="token", text=str(ev["delta"]))
                elif etype == "message_thinking_token":
                    # Dropped on the floor for TTS (the private dev log Pipecat rule).
                    yield TurnEvent(kind="thinking")
                elif etype == "message_added" and ev.get("role") == "specialist":
                    yield TurnEvent(kind="done")
                    return


def _parse_event_line(line: str) -> dict | None:
    """Decode one `data: {...}` SSE line; None for comments/heartbeats/garbage."""
    if not line.startswith("data:"):
        return None
    body = line[len("data:") :].strip()
    if not body:
        return None
    try:
        obj = json.loads(body)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None
