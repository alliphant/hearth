"""Hearth Voice Coordinator — an aioesphomeapi client that runs the Satellite1
as a Hearth-direct full-duplex voice device with barge-in.

See docs/design-esp-direct-voice.md. The pure barge-in state machine and the
LD2450 parsing are stdlib-only (importable + unit-testable without
aioesphomeapi / httpx); the device/network layers import their deps lazily.
"""

__all__ = ["config", "state_machine", "ld2450", "hearth_client", "audio_clients", "device", "coordinator"]
