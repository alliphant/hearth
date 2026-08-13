"""LD2450 mmWave presence/zone parsing — pure functions (stdlib only, testable).

The coordinator subscribes to the device's LD2450 entities over the native API
(design §4): presence/moving/still binary_sensors + up to 3 targets, each with
x/y/speed/angle/distance. This module turns the raw entity-state stream into a
normalized PresenceSnapshot the state machine's barge-in gate + a future Hearth
presence-store republish consume.

Entity naming on the FutureProof Satellite1 follows ESPHome's LD2450 component:
  binary_sensor: "<name> Presence" / "Moving Target" / "Still Target"
  sensor:        "Target-1 X" / "Target-1 Y" / "Target-1 Speed" /
                 "Target-1 Angle" / "Target-1 Distance"  (and -2, -3)
Number (writable, zone editor): "Zone-1 X1/Y1/X2/Y2" … (design §4 — Phase 3).

We match leniently (lowercased substring) so a firmware label tweak doesn't
silently drop a target — and report what we DIDN'T recognize for diagnostics.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class Target:
    index: int
    x_mm: float | None = None
    y_mm: float | None = None
    speed_mms: float | None = None
    angle_deg: float | None = None
    distance_mm: float | None = None

    @property
    def active(self) -> bool:
        # A target with a non-zero coordinate is tracking something.
        return any(v not in (None, 0) for v in (self.x_mm, self.y_mm, self.distance_mm))

    @property
    def computed_distance_mm(self) -> float | None:
        if self.distance_mm is not None:
            return self.distance_mm
        if self.x_mm is not None and self.y_mm is not None:
            return (self.x_mm**2 + self.y_mm**2) ** 0.5
        return None


@dataclass
class PresenceSnapshot:
    present: bool = False
    moving: bool = False
    still: bool = False
    targets: list[Target] = field(default_factory=list)

    def nearest_distance_mm(self) -> float | None:
        ds = [t.computed_distance_mm for t in self.targets if t.computed_distance_mm is not None]
        return min(ds) if ds else None

    def present_and_near(self, near_threshold_mm: float = 2500.0) -> bool:
        """The barge-in gate (design §3 optional): someone present AND within
        `near_threshold_mm` (default 2.5 m). False when no presence at all."""
        if not self.present:
            return False
        nd = self.nearest_distance_mm()
        if nd is None:
            # Presence true but no target distance — trust the presence sensor.
            return True
        return nd <= near_threshold_mm


_TARGET_RE = re.compile(r"target[\s_-]*([123])", re.IGNORECASE)


def _as_float(v: object) -> float | None:
    if v is None:
        return None
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _as_bool(v: object) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in ("on", "true", "1", "yes", "detected", "occupied")
    return False


def parse_presence(states: dict[str, object]) -> PresenceSnapshot:
    """Build a PresenceSnapshot from a {entity_name: value} map.

    `states` keys are human entity names (or object_ids) as the coordinator
    accumulates them from the native-API state stream. Matching is
    case-insensitive substring so it survives label tweaks.
    """
    snap = PresenceSnapshot()
    targets: dict[int, Target] = {}

    for raw_name, value in states.items():
        name = raw_name.lower()

        # binary presence sensors
        if "presence" in name or "occupancy" in name:
            snap.present = snap.present or _as_bool(value)
            continue
        if "moving target" in name or name.endswith("moving") or "moving_target" in name:
            snap.moving = snap.moving or _as_bool(value)
            continue
        if "still target" in name or name.endswith("still") or "still_target" in name:
            snap.still = snap.still or _as_bool(value)
            continue

        # per-target numeric sensors
        m = _TARGET_RE.search(name)
        if m:
            idx = int(m.group(1))
            t = targets.setdefault(idx, Target(index=idx))
            fv = _as_float(value)
            if "speed" in name:
                t.speed_mms = fv
            elif "angle" in name:
                t.angle_deg = fv
            elif "distance" in name or "resolution" in name and "distance" in name:
                t.distance_mm = fv
            elif re.search(r"\bx\b", name) or name.endswith(" x") or "_x" in name:
                t.x_mm = fv
            elif re.search(r"\by\b", name) or name.endswith(" y") or "_y" in name:
                t.y_mm = fv
            continue

    snap.targets = [targets[i] for i in sorted(targets)]
    # A target actively tracking implies presence even if the binary sensor lags.
    if not snap.present and any(t.active for t in snap.targets):
        snap.present = True
    return snap
