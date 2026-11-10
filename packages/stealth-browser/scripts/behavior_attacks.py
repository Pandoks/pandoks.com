"""Adversarial stream generators for the human-detector attack suite.

Every function here produces a JSONL-shaped list[dict] of trusted input events
(same schema as testdata/behavior/datasets/*). They are transforms over recorded
datasets plus synthetic builders for fully scripted streams. No repo edits --
everything operates on copies in memory.

Dataset sources (committed under packages/stealth-browser/testdata/behavior/):
  datasets/ -- the 6-stream calibration benchmark recorded with the capture
  harness (3 human + 3 machine streams, typing/clicks/scroll).
  patched/  -- 12 captures from the PATCHED stealth-browser humanizer driver
  (4 seeds x 3 modalities), the loop-closure evidence that the driver's own
  output passes the human detector.
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
TESTDATA = HERE.parent / "testdata" / "behavior"
DATASETS = TESTDATA / "datasets"
PATCHED = TESTDATA / "patched"

STREAM_NAMES = [
    ("machine-typing", f"{DATASETS}/machine-typing.jsonl"),
    ("machine-clicks", f"{DATASETS}/machine-clicks.jsonl"),
    ("machine-scroll", f"{DATASETS}/machine-scroll.jsonl"),
    ("human-typing", f"{DATASETS}/human-typing.jsonl"),
    ("human-clicks", f"{DATASETS}/human-clicks.jsonl"),
    ("human-scroll", f"{DATASETS}/human-scroll.jsonl"),
    ("patched-typing", f"{PATCHED}/patched-typing.jsonl"),
    ("patched-clicks", f"{PATCHED}/patched-clicks.jsonl"),
    ("patched-scroll", f"{PATCHED}/patched-scroll.jsonl"),
    ("seed1-typing", f"{PATCHED}/seed1-typing.jsonl"),
    ("seed1-clicks", f"{PATCHED}/seed1-clicks.jsonl"),
    ("seed1-scroll", f"{PATCHED}/seed1-scroll.jsonl"),
    ("seed424242-typing", f"{PATCHED}/seed424242-typing.jsonl"),
    ("seed424242-clicks", f"{PATCHED}/seed424242-clicks.jsonl"),
    ("seed424242-scroll", f"{PATCHED}/seed424242-scroll.jsonl"),
    ("seed777-typing", f"{PATCHED}/seed777-typing.jsonl"),
    ("seed777-clicks", f"{PATCHED}/seed777-clicks.jsonl"),
    ("seed777-scroll", f"{PATCHED}/seed777-scroll.jsonl"),
]


def load_events(path: str) -> list[dict]:
    events = []
    with open(path, "rb") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(e, dict) or not e.get("isTrusted", False):
                continue
            events.append(e)
    return events


def _max_ts(events):
    return max((e.get("ts") or 0.0) for e in events)


def _min_ts(events):
    return min((e.get("ts") or 0.0) for e in events)


def offset_ts(events, off):
    out = []
    for e in events:
        e = dict(e)
        e["ts"] = (e.get("ts") or 0.0) + off
        out.append(e)
    return out


def scale_ts(events, f, jitter=0.0, rng=None):
    """Re-time: ts' = t0 + f * (ts - t0), optionally + per-event noise.

    This is the parameter-sweep / replay re-timing transform: every relative
    timing (dwell, gap, flight, press, settle) scales by f; geometry is kept.
    """
    rng = rng or random
    t0 = _min_ts(events)
    out = []
    for e in events:
        e = dict(e)
        base = t0 + f * ((e.get("ts") or 0.0) - t0)
        if jitter:
            base += rng.gauss(0.0, jitter)
        e["ts"] = max(0.0, base)
        out.append(e)
    return out


def add_gaussian_jitter(events, sigma, rng):
    out = []
    for e in events:
        e = dict(e)
        e["ts"] = max(0.0, (e.get("ts") or 0.0) + rng.gauss(0.0, sigma))
        out.append(e)
    return out


def add_uniform_jitter(events, span, rng):
    out = []
    for e in events:
        e = dict(e)
        e["ts"] = max(0.0, (e.get("ts") or 0.0) + rng.uniform(-span, span))
        out.append(e)
    return out


def quantize_ts(events, grid_ms=16.667):
    """Force every ts onto the 60Hz frame grid (scripted rAF pacing)."""
    out = []
    for e in events:
        e = dict(e)
        e["ts"] = round((e.get("ts") or 0.0) / grid_ms) * grid_ms
        out.append(e)
    return out


def append_stream(base, extra, gap_ms=800.0):
    """Concatenate extra AFTER base with a gap; returns merged sorted by ts."""
    off = _max_ts(base) + gap_ms - _min_ts(extra)
    return sorted(base + offset_ts(extra, off), key=lambda e: e.get("ts") or 0.0)


def interleave_streams(a, b, gap_ms=800.0):
    """Merge two streams onto one clock (b starts gap_ms after a ends)."""
    off = _max_ts(a) + gap_ms - _min_ts(b)
    return sorted(a + offset_ts(b, off), key=lambda e: e.get("ts") or 0.0)


def truncate(events, n):
    return events[:n]


# ---------------------------------------------------------------------------
# synthetic adversarial builders
# ---------------------------------------------------------------------------

def _mk_key(ts, type_, key, code=None):
    return {
        "ts": ts, "type": type_, "isTrusted": True, "key": key, "code": code or key,
        "x": None, "y": None, "buttons": 0, "button": None,
    }


def constant_gap_typing(human_typing_events, gap_ms=220.0):
    """Keep recorded human dwells but force keydown->keydown gaps constant.

    The recorded keystroke dynamics survive; the pacing becomes a rigid
    constant-rate dispatcher. If the detector scores only dwell/flight level,
    this passes as HUMAN.
    """
    keys = sorted(
        [e for e in human_typing_events if e.get("type") in ("keydown", "keyup", "keypress")],
        key=lambda e: e.get("ts") or 0.0,
    )
    downs = [e for e in keys if e.get("type") == "keydown"]
    ups = [e for e in keys if e.get("type") == "keyup"]
    # recorded dwell per keydown (first matching later keyup, same key)
    dwell = {}
    for d in downs:
        key = d.get("key") or d.get("code")
        for u in ups:
            if (u.get("ts") or 0) > (d.get("ts") or 0) and (u.get("key") or u.get("code")) == key:
                dwell[id(d)] = max(0.0, (u.get("ts") or 0) - (d.get("ts") or 0))
                break
        else:
            dwell[id(d)] = 20.0
    out = []
    t = 1000.0
    for d in downs:
        key = d.get("key") or d.get("code")
        out.append(_mk_key(t, "keydown", key, d.get("code")))
        out.append(_mk_key(t + dwell[id(d)], "keyup", key, d.get("code")))
        t += gap_ms
    return sorted(out, key=lambda e: e.get("ts"))


def rigid_threshold_typing(n_keys=60):
    """Hardcode every typing boundary just past the detector's human side,
    with ZERO variance (rigid dispatcher that studied the detector):
    dwell 72ms (rule saturates +1 at >=70), kd-gap 125ms (+1 at >=120)."""
    out = []
    t = 1000.0
    for i in range(n_keys):
        ch = "a" if i % 5 else " "
        out.append(_mk_key(t, "keydown", ch, "KeyA" if ch != " " else "Space"))
        out.append(_mk_key(t + 72.0, "keyup", ch, "KeyA" if ch != " " else "Space"))
        t += 125.0
    return sorted(out, key=lambda e: e.get("ts"))


def _mk_move(ts, x, y):
    return {"ts": ts, "type": "mousemove", "isTrusted": True, "x": x, "y": y,
            "dx": 0, "dy": 0, "buttons": 0, "button": 0}


def _mk_press(ts, type_, x=500, y=400):
    return {"ts": ts, "type": type_, "isTrusted": True, "x": x, "y": y,
            "dx": 0, "dy": 0, "buttons": 1 if type_ == "mousedown" else 0, "button": 0}


def rigid_threshold_clicks(n_clicks=5, hold_ms=92.0, settle_ms=45.0):
    """Hardcode the click boundaries (hold 92ms > 90 threshold, settle 45ms
    > 40 threshold) with a perfectly linear constant-speed approach path.
    Velocity features read machine (ratio 1.0, slow_frac 0) but press/settle
    saturate +1."""
    out = []
    t = 1000.0
    for i in range(n_clicks):
        steps = 30
        for s in range(steps):
            out.append(_mk_move(t + s * 16.7, 200 + s * 10.0, 400))
        t += steps * 16.7  # approach done
        out.append(_mk_move(t, 500, 400))
        t += settle_ms
        out.append(_mk_press(t, "mousedown"))
        t += hold_ms
        out.append(_mk_press(t, "mouseup"))
        t += 160.0  # release gap (>=150 saturates +1)
    return sorted(out, key=lambda e: e.get("ts"))


def constant_delta_scroll(n=18):
    """Constant-rate scroll dispatcher: fixed delta (300px), fixed tick gap."""
    out = []
    t = 1000.0
    for i in range(n):
        out.append({"ts": t, "type": "wheel", "isTrusted": True,
                    "deltaX": 0, "deltaY": 300, "x": 500, "y": 400})
        t += 100.0
    return sorted(out, key=lambda e: e.get("ts"))
