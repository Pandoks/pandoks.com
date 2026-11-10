#!/usr/bin/env python3
"""Human-behavior detector for the stealth-browser stack.

Transparent statistical classifier over trusted input-event streams (JSONL of
keydown/wheel/mouse events; each feature maps through a monotone threshold rule
to a sub-score in [-1, +1], so every verdict is auditable feature-by-feature).
This is the v2 hardening of the v1 detector: it keeps the full v1 feature/rule
set -- the calibrated 6-dataset baseline is unchanged -- and closes four attack
surfaces v1 missed. v1 computed rigidity features (gap entropy, dwell/press/settle
CV) but never scored them, so a constant-rate dispatcher that hardcoded its
levels just past the human thresholds read as HUMAN; v2 scores them (collapsed
entropy/CV is machine-ward and discounts the level features that describe the
metronome rather than the behavior). v1 paired press events naively, so 60Hz
frame quantization created phantom multi-hundred-ms holds that flipped a machine
stream; v2 filters outlier holds and guards against timestamp-collided down/up
pairs. v1 read a replayed recording as independent evidence; v2 hashes quantized
gap-sequence windows, flags repeats as replay-suspect and discounts that
evidence. And v1 fused disagreeing categories into a confident verdict; v2
discounts confidence on cross-category contradiction. The regression gate that
asserts all of this (18-dataset baseline + adversarial attack matrix) is
behavior_attack_suite.py in this directory.

Usage:
  python3 scripts/behavior_detector.py <events.jsonl> [--max-events N] [--json]
  exit 0 = decided, 1 = UNKNOWN / no trusted events, 2 = usage error
"""
from __future__ import annotations

import bisect
import json
import math
import sys

# ---------------------------------------------------------------------------
# primitives (identical to v1)
# ---------------------------------------------------------------------------


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


def percentile(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def mean(xs):
    return sum(xs) / len(xs) if xs else None


def cv(xs):
    if not xs or len(xs) < 2:
        return None
    m = mean(xs)
    if m == 0:
        return None
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs)) / abs(m)


def median_of(xs):
    return percentile(xs, 0.5) if xs else None


GAP_BIN_EDGES = [0.0, 0.5, 2.0, 6.0, 18.0, 45.0, 110.0, 260.0, 600.0, 1400.0, 3000.0]


def gap_entropy(gaps):
    if not gaps or len(gaps) < 6:
        return None
    counts = [0] * (len(GAP_BIN_EDGES) - 1)
    for g in gaps:
        i = bisect.bisect_right(GAP_BIN_EDGES, max(0.0, g)) - 1
        counts[min(len(counts) - 1, max(0, i))] += 1
    total = sum(counts)
    if not total:
        return None
    h = 0.0
    for c in counts:
        if c:
            p = c / total
            h -= p * math.log2(p)
    return h / math.log2(len(counts))


def clamp(x, lo=-1.0, hi=1.0):
    return max(lo, min(hi, x))


# ---------------------------------------------------------------------------
# sub-stream segmentation (identical to v1)
# ---------------------------------------------------------------------------


def key_events(events):
    return [e for e in events if e.get("type") in ("keydown", "keyup", "keypress")]


def wheel_events(events):
    return [e for e in events if e.get("type") == "wheel"]


def press_events(events):
    return [e for e in events if e.get("type") in ("mousedown", "mouseup", "pointerdown", "pointerup", "click")]


# ---------------------------------------------------------------------------
# feature extraction
# ---------------------------------------------------------------------------


def extract_typing(events):
    keys = sorted(key_events(events), key=lambda e: e.get("ts") or 0.0)
    downs = [e for e in keys if e.get("type") == "keydown"]
    ups = [e for e in keys if e.get("type") == "keyup"]
    if not downs:
        return None
    n_down = len(downs)
    dwell, gaps = [], []
    backspaces = 0
    for i, d in enumerate(downs):
        key = d.get("key") or d.get("code")
        if key == "Backspace":
            backspaces += 1
        for u in ups:
            if (u.get("ts") or 0) <= (d.get("ts") or 0):
                continue
            if (u.get("key") or u.get("code")) != key:
                continue
            if any((o.get("ts") or 0) > (d.get("ts") or 0) and (o.get("ts") or 0) < (u.get("ts") or 0) for o in downs):
                continue
            dt = (u.get("ts") or 0) - (d.get("ts") or 0)
            if dt >= 0:
                dwell.append(dt)
            break
        if i + 1 < len(downs):
            nxt = downs[i + 1]
            if (nxt.get("ts") or 0) > (d.get("ts") or 0):
                gaps.append((nxt.get("ts") or 0) - (d.get("ts") or 0))
    kd_gap = []
    for i in range(len(downs) - 1):
        dt = (downs[i + 1].get("ts") or 0) - (downs[i].get("ts") or 0)
        if dt >= 0:
            kd_gap.append(dt)
    flight = []
    for i in range(len(downs) - 1):
        k = downs[i].get("key") or downs[i].get("code")
        u = None
        for uu in ups:
            if (uu.get("ts") or 0) >= (downs[i].get("ts") or 0) and (uu.get("key") or uu.get("code")) == k:
                u = uu
                break
        if u is not None and (downs[i + 1].get("ts") or 0) > (u.get("ts") or 0):
            flight.append((downs[i + 1].get("ts") or 0) - (u.get("ts") or 0))
    if not kd_gap:
        return None
    return {
        "n_keys": n_down,
        "t_dwell_mean": mean(dwell) if dwell else None,
        "t_dwell_p50": percentile(dwell, 0.5) if dwell else None,
        "t_dwell_cv": cv(dwell) if dwell else None,
        "t_kd_gap_p50": percentile(kd_gap, 0.5),
        "t_kd_gap_p90": percentile(kd_gap, 0.9),
        "t_flight_p50": percentile(flight, 0.5) if flight else None,
        "t_flight_max": max(flight) if flight else None,
        "t_gap_entropy": gap_entropy(kd_gap),
        "t_backspace_rate": (backspaces / max(1, n_down - backspaces)) * 100.0,
    }


def _dedupe_press(events, tolerance_ms=3.0):
    if not events:
        return []
    out = [events[0]]
    for e in events[1:]:
        if (e.get("ts") or 0.0) - (out[-1].get("ts") or 0.0) <= tolerance_ms:
            continue
        out.append(e)
    return out


def _move_gestures(moves, max_gap_ms=150.0):
    gestures = []
    cur = []
    for m in moves:
        if cur and (m.get("ts") or 0) - (cur[-1].get("ts") or 0) > max_gap_ms:
            gestures.append(cur)
            cur = []
        cur.append(m)
    if cur:
        gestures.append(cur)
    return gestures


def _velocity_stats(gesture, span=5):
    n = len(gesture)
    speeds = []
    for i in range(span, n):
        dt = (gesture[i].get("ts") or 0) - (gesture[i - span].get("ts") or 0)
        if dt <= 0:
            continue
        dx = (gesture[i].get("x") or 0) - (gesture[i - span].get("x") or 0)
        dy = (gesture[i].get("y") or 0) - (gesture[i - span].get("y") or 0)
        speeds.append(math.hypot(dx, dy) / dt * 1000.0)
    if len(speeds) < 4:
        return None
    med = percentile(speeds, 0.5) or 0.0
    mx = max(speeds)
    if med <= 0:
        return None
    return (mx / med, sum(1 for s in speeds if s < 0.5 * mx) / len(speeds))


def extract_clicks(events):
    moves = sorted([e for e in events if e.get("type") == "mousemove"], key=lambda e: e.get("ts") or 0.0)
    downs = _dedupe_press(sorted([e for e in events if e.get("type") in ("mousedown", "pointerdown")], key=lambda e: e.get("ts") or 0.0))
    ups = _dedupe_press(sorted([e for e in events if e.get("type") in ("mouseup", "pointerup")], key=lambda e: e.get("ts") or 0.0))
    if not downs:
        return None
    press_hold, settle = [], []
    for d in downs:
        key = d.get("button")
        for u in ups:
            if (u.get("ts") or 0) <= (d.get("ts") or 0):
                continue
            if u.get("button") != key:
                continue
            if any((o.get("ts") or 0) > (d.get("ts") or 0) and (o.get("ts") or 0) < (u.get("ts") or 0) for o in downs):
                continue
            # v2: ambiguity guard -- if another down shares the up's timestamp
            # (grid-cell collision, e.g. 60Hz quantization), the up may belong
            # to that down instead; this pair is ambiguous, keep looking.
            if any(o is not d and (o.get("ts") or 0) == (u.get("ts") or 0) for o in downs):
                continue
            dt = (u.get("ts") or 0) - (d.get("ts") or 0)
            if dt >= 0:
                press_hold.append(dt)
            pre = [m for m in moves if (m.get("ts") or 0) < (d.get("ts") or 0)]
            if pre:
                settle.append((d.get("ts") or 0) - (pre[-1].get("ts") or 0))
            break
    # v2: drop outlier holds -- a hold >8x the median (median <200ms) is
    # multi-frame pairing noise (60Hz quantization can inflate a 5ms hold into
    # a phantom multi-hundred-ms one). Keep only if median itself is large.
    med = median_of(press_hold) if press_hold else None
    if med is not None and med < 200.0 and len(press_hold) >= 2:
        press_hold = [p for p in press_hold if p <= med * 8.0] or press_hold
    rel_gap = []
    for u in ups:
        later = [m for m in moves if (m.get("ts") or 0) > (u.get("ts") or 0)]
        if later:
            rel_gap.append((later[0].get("ts") or 0) - (u.get("ts") or 0))
    ratios, slows = [], []
    for g in _move_gestures(moves):
        st = _velocity_stats(g)
        if st is not None:
            ratios.append(st[0])
            slows.append(st[1])
    speed_ratio = median_of(ratios) if ratios else None
    slow_frac = median_of(slows) if slows else None
    reversals = None
    if len(moves) >= 8:
        dirs = []
        for i in range(1, len(moves)):
            dx = (moves[i].get("x") or 0) - (moves[i - 1].get("x") or 0)
            dirs.append(1 if dx >= 0 else -1)
        flips = sum(1 for i in range(1, len(dirs)) if dirs[i] != dirs[i - 1])
        reversals = flips / len(dirs)
    return {
        "n_clicks": len(downs),
        "c_press_mean": mean(press_hold) if press_hold else None,
        "c_press_p50": percentile(press_hold, 0.5) if press_hold else None,
        "c_press_max": max(press_hold) if press_hold else None,
        "c_press_cv": cv(press_hold) if press_hold else None,
        "c_settle_p50": percentile(settle, 0.5) if settle else None,
        "c_settle_cv": cv(settle) if settle else None,
        "c_release_p50": percentile(rel_gap, 0.5) if rel_gap else None,
        "c_speed_ratio": speed_ratio,
        "c_slow_frac": slow_frac,
        "c_reversals": reversals,
    }


def extract_scroll(events):
    wheels = wheel_events(events)
    if len(wheels) < 3:
        return None
    deltas = [abs(w.get("deltaY") or 0.0) for w in wheels]
    signs = [1 if (w.get("deltaY") or 0) >= 0 else -1 for w in wheels]
    gaps = []
    for i in range(len(wheels) - 1):
        dt = (wheels[i + 1].get("ts") or 0) - (wheels[i].get("ts") or 0)
        if dt >= 0:
            gaps.append(dt)
    n = len(deltas)
    xs = [i / max(1, n - 1) for i in range(n)]
    mx_, my_ = mean(xs), mean(deltas)
    var_x = sum((x - mx_) ** 2 for x in xs)
    slope = sum((x - mx_) * (d - my_) for x, d in zip(xs, deltas)) / var_x if var_x else 0.0
    rel_slope = slope / my_ if my_ else 0.0
    pauses = sum(1 for g in gaps if g > 400.0) / max(1, len(gaps))
    return {
        "n_wheel": len(wheels),
        "s_delta_p50": percentile(deltas, 0.5),
        "s_delta_max": max(deltas),
        "s_delta_cv": cv(deltas),
        "s_slope": rel_slope if n >= 6 else None,
        "s_gap_p50": percentile(gaps, 0.5) if gaps else None,
        "s_gap_max": max(gaps) if gaps else None,
        "s_gap_entropy": gap_entropy(gaps),
        "s_pause_frac": pauses,
        "s_reversals": sum(1 for i in range(1, len(signs)) if signs[i] != signs[i - 1]),
    }


def extract_all(events):
    return {
        "typing": extract_typing(events),
        "clicks": extract_clicks(events),
        "scroll": extract_scroll(events),
        "replay_suspect": replay_suspect(events),
    }


# ---------------------------------------------------------------------------
# v2: replay-duplicate detection
# ---------------------------------------------------------------------------


def replay_suspect(events, window=16, quant_ms=5.0):
    """Hash quantized inter-event gap windows; duplicates => replayed data.

    A recorded stream replayed k times repeats identical gap sequences. We
    hash every sliding window of `window` inter-event gaps (quantized to
    `quant_ms`); >=2 identical non-overlapping windows => suspect. Natural
    human/humanizer data essentially never repeats a 16-gap window exactly at
    5 ms resolution.
    """
    ts = sorted((e.get("ts") or 0.0) for e in events if e.get("isTrusted", False))
    if len(ts) < window * 2 + 2:
        return False
    gaps = [(round((ts[i + 1] - ts[i]) / quant_ms) * quant_ms) for i in range(len(ts) - 1)]
    seen = set()
    # non-overlapping windows only (overlaps would over-trigger on periodic data)
    for start in range(0, len(gaps) - window + 1, window):
        h = hash(tuple(gaps[start : start + window]))
        if h in seen:
            return True
        seen.add(h)
    return False


# ---------------------------------------------------------------------------
# scoring rules
# ---------------------------------------------------------------------------


def r_dwell(v):
    if v is None:
        return 0.0
    if v <= 30.0:
        return -1.0
    if v >= 70.0:
        return 1.0
    return (v - 30.0) / 40.0 * 2 - 1


def r_kd_gap_p50(v):
    if v is None:
        return 0.0
    if v <= 45.0:
        return -1.0
    if v >= 120.0:
        return 1.0
    return (v - 45.0) / 75.0 * 2 - 1


def r_kd_gap_p90(v):
    if v is None:
        return 0.0
    if v <= 60.0:
        return -1.0
    if v >= 150.0:
        return 1.0
    return (v - 60.0) / 90.0 * 2 - 1


def r_flight(v):
    if v is None:
        return 0.0
    if v <= 10.0:
        return -1.0
    if v >= 80.0:
        return 1.0
    return (v - 10.0) / 70.0 * 2 - 1


def r_gap_entropy(v):
    if v is None:
        return 0.0
    # v2: negative arm only -- entropy doesn't separate the calibrated classes
    # (machine 0.33 vs human 0.24), but a COLLAPSED distribution (<0.10) is a
    # rigid constant-rate dispatcher regardless of its level.
    if v <= 0.10:
        return -1.0
    return 0.0


def r_dwell_cv(v):
    if v is None:
        return 0.0
    # collapsed dwell variance = scripted constant hold
    if v <= 0.10:
        return -1.0
    return 0.0


def r_backspace(v):
    if v is None:
        return 0.0
    return clamp(v / 2.0)


def r_press(v):
    if v is None:
        return 0.0
    if v <= 40.0:
        return -1.0
    if v >= 90.0:
        return 1.0
    return (v - 40.0) / 50.0 * 2 - 1


def r_press_cv(v):
    if v is None:
        return 0.0
    # extreme rigidity: cv ~0 means every hold is the same value (scripted).
    # The calibrated human streams sit at 0.26; the patched driver at 0.03-0.08;
    # only near-exact constants (<0.01) are called machine.
    if v <= 0.01:
        return -1.0
    return 0.0


def r_settle(v):
    if v is None:
        return 0.0
    if v <= 5.0:
        return -1.0
    if v >= 40.0:
        return 1.0
    return (v - 5.0) / 35.0 * 2 - 1


def r_settle_cv(v):
    if v is None:
        return 0.0
    if v <= 0.01:
        return -1.0
    return 0.0


def r_release(v):
    if v is None:
        return 0.0
    if v <= 5.0:
        return -1.0
    if v >= 150.0:
        return 1.0
    return (v - 5.0) / 145.0 * 2 - 1


def r_speed_ratio(v):
    if v is None:
        return 0.0
    if v <= 1.15:
        return -1.0
    if v >= 1.60:
        return 1.0
    return (v - 1.15) / 0.45 * 2 - 1


def r_slow_frac(v):
    if v is None:
        return 0.0
    if v <= 0.15:
        return -1.0
    if v >= 0.35:
        return 1.0
    return (v - 0.15) / 0.20 * 2 - 1


def r_scroll_delta_p50(v):
    if v is None:
        return 0.0
    if v >= 200.0:
        return -1.0
    if v <= 170.0:
        return 1.0
    return (200.0 - v) / 30.0 * 2 - 1


def r_scroll_cv(v):
    if v is None:
        return 0.0
    if v <= 0.24:
        return -1.0
    if v >= 0.31:
        return 1.0
    return (v - 0.24) / 0.07 * 2 - 1


def r_scroll_pause(v):
    if v is None:
        return 0.0
    if v <= 0.06:
        return -1.0
    if v >= 0.15:
        return 1.0
    return (v - 0.06) / 0.09 * 2 - 1


def r_scroll_slope(v):
    if v is None:
        return 0.0
    if v >= -0.10:
        return -1.0
    if v <= -0.25:
        return 1.0
    return (-(v) - 0.10) / 0.15 * 2 - 1


def r_scroll_gap_entropy(v):
    if v is None:
        return 0.0
    # collapsed tick spacing = constant-rate scroller (machine-scroll 0.36,
    # human-scroll 0.42-0.53; only near-zero entropy is called out)
    if v <= 0.15:
        return -1.0
    return 0.0


TYPING_RULES = [
    ("t_dwell_mean", r_dwell, 1.0),
    ("t_kd_gap_p50", r_kd_gap_p50, 1.0),
    ("t_kd_gap_p90", r_kd_gap_p90, 0.7),
    ("t_flight_p50", r_flight, 0.8),
    ("t_backspace_rate", r_backspace, 0.4),
    ("t_gap_entropy", r_gap_entropy, 0.6),
    ("t_dwell_cv", r_dwell_cv, 0.4),
]

CLICK_RULES = [
    ("c_press_mean", r_press, 1.0),
    ("c_settle_p50", r_settle, 0.8),
    ("c_release_p50", r_release, 0.3),
    ("c_speed_ratio", r_speed_ratio, 0.5),
    ("c_slow_frac", r_slow_frac, 0.4),
    ("c_press_cv", r_press_cv, 0.5),
    ("c_settle_cv", r_settle_cv, 0.4),
]

SCROLL_RULES = [
    ("s_delta_p50", r_scroll_delta_p50, 0.8),
    ("s_delta_cv", r_scroll_cv, 0.6),
    ("s_pause_frac", r_scroll_pause, 0.2),
    ("s_slope", r_scroll_slope, 0.5),
    ("s_gap_entropy", r_scroll_gap_entropy, 0.25),
]

MIN_SUPPORT = {"typing": 3, "clicks": 1, "scroll": 3}
FULL_SUPPORT = {"typing": 10, "clicks": 3, "scroll": 6}


def support_count(cat, feats):
    if cat == "typing":
        return (feats or {}).get("n_keys", 0)
    if cat == "clicks":
        return (feats or {}).get("n_clicks", 0)
    if cat == "scroll":
        return (feats or {}).get("n_wheel", 0)
    return 0


def classify(feats):
    replay = bool(feats.pop("replay_suspect", False))
    categories = {}
    per_feature = {}
    raw_scores = {}
    confidences = {}
    for cat, rules in (("typing", TYPING_RULES), ("clicks", CLICK_RULES), ("scroll", SCROLL_RULES)):
        f = feats[cat]
        support = support_count(cat, f) if f else 0
        if not f or support < MIN_SUPPORT[cat]:
            raw_scores[cat] = 0.0
            confidences[cat] = 0.0
            categories[cat] = "no-data"
            continue
        total_w = 0.0
        num = 0.0
        entries = []
        # v2: collapse-discount -- when the stream's rigidity markers say the
        # timing is a rigid metronome (gap entropy or dwell/press/settle CV
        # collapsed), the LEVEL features describe the metronome, not the
        # behavior: discount their sub-scores instead of only adding a small
        # negative term (which the saturated level rules outvote).
        level_scale = 1.0
        if cat == "typing":
            ent = f.get("t_gap_entropy")
            dcv = f.get("t_dwell_cv")
            if ent is not None and ent <= 0.10:
                level_scale = 0.35
            if dcv is not None and dcv <= 0.05:
                level_scale = min(level_scale, 0.35)
        if cat == "clicks":
            pcv = f.get("c_press_cv")
            scv = f.get("c_settle_cv")
            if pcv is not None and pcv <= 0.01:
                level_scale = 0.35
            if scv is not None and scv <= 0.01:
                level_scale = min(level_scale, 0.35)
        LEVEL_RULES = {"t_dwell_mean", "t_kd_gap_p50", "t_kd_gap_p90", "t_flight_p50",
                       "c_press_mean", "c_settle_p50"}
        for name, rule, w in rules:
            v = f.get(name)
            if v is None:
                continue  # v2: no-info rules don't dilute the score
            s = rule(v)
            if name in LEVEL_RULES and level_scale < 1.0:
                s *= level_scale
            num += s * w
            total_w += w
            entries.append((name, v, s, w))
        raw = num / total_w if total_w else 0.0
        raw_scores[cat] = raw
        eff = min(1.0, support / FULL_SUPPORT[cat])
        if replay:
            eff *= 0.5  # repeated identical recording is not independent evidence
        confidences[cat] = abs(raw) * eff
        per_feature[cat] = entries
        categories[cat] = "human" if raw > 0.15 else ("machine" if raw < -0.15 else "unclear")
    active = {c: s for c, s in raw_scores.items() if abs(s) > 1e-9}
    if not active:
        return {
            "verdict": "UNKNOWN",
            "score": 0.0,
            "confidence": 0.0,
            "categories": categories,
            "raw_scores": raw_scores,
            "confidences": confidences,
            "per_feature": per_feature,
            "note": "no category produced enough evidence",
        }
    wsum = sum(confidences[c] for c in active) or 1.0
    overall = sum(raw_scores[c] * confidences[c] for c in active) / wsum
    confidence = abs(overall) * min(1.0, 0.5 + 0.25 * len(active))
    # v2: contradiction discount -- categories that disagree on sign must not
    # produce a confident verdict
    signs = {1 if s > 0 else -1 for s in active.values()}
    if len(signs) > 1:
        confidence *= 0.6
    verdict = "HUMAN" if overall > 0 else "MACHINE"
    if abs(overall) < 0.10 or confidence < 0.20:
        verdict = "UNKNOWN"
    out = {
        "verdict": verdict,
        "score": overall,
        "confidence": confidence,
        "categories": categories,
        "raw_scores": raw_scores,
        "confidences": confidences,
        "per_feature": per_feature,
    }
    if replay:
        out["note"] = "replay-suspect: repeated identical gap sequences (support discounted)"
    return out


def report(res, feats):
    v = res["verdict"]
    print(f"VERDICT: {v}   score={res['score']:+.3f}  confidence={res['confidence']:.3f}")
    for cat in ("typing", "clicks", "scroll"):
        print(f"  [{cat:<7}] raw={res['raw_scores'][cat]:+.3f}  conf={res['confidences'][cat]:.3f}  ({res['categories'][cat]})")
        entries = res["per_feature"].get(cat) or []
        for name, val, sub, w in entries:
            vs = "n/a" if val is None else f"{val:.2f}" if isinstance(val, float) else str(val)
            print(f"      {name:<18} {vs:>9}  -> sub={sub:+.3f}  (w={w})")


def main(argv):
    args = [a for a in argv[1:]]
    max_events = None
    json_out = False
    path = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--max-events" and i + 1 < len(args):
            max_events = int(args[i + 1])
            i += 2
            continue
        if a == "--json":
            json_out = True
            i += 1
            continue
        if not path:
            path = a
        i += 1
    if not path:
        print("usage: behavior_detector.py <jsonl> [--max-events N] [--json]", file=sys.stderr)
        return 2
    events = load_events(path)
    if max_events is not None:
        events = events[:max_events]
    if not events:
        print("VERDICT: UNKNOWN  (no trusted events)", file=sys.stderr)
        return 1
    feats = extract_all(events)
    res = classify(feats)
    if json_out:
        out = dict(res)
        out["n_events"] = len(events)
        print(json.dumps(out, indent=2))
        return 0
    report(res, feats)
    return 0 if res["verdict"] != "UNKNOWN" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
