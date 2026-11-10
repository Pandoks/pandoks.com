#!/usr/bin/env python3
"""Regression gate for the human-behavior detector (behavior_detector.py).

Asserts, entirely from the repo-committed datasets
(packages/stealth-browser/testdata/behavior/{datasets,patched}, ~1.5MB total --
the benchmark captures plus 12 patched-driver captures, committed so the gate is
self-contained; the read-only originals live at
/var/tmp/stealth-check/behavior-capture/datasets and /var/tmp/stealth-check/patched-capture):

  1. 18/18 baseline -- the 6 benchmark streams (3 machine + 3 human) classify
     correctly and the 12 patched-driver captures (4 seeds x typing/clicks/scroll)
     all read HUMAN. The patched set is the loop-closure evidence: the
     humanizer's own output passes the adversarial human detector.
  2. The v1->v2 hardening holds against the 502-row adversarial attack matrix:
     constant-rate / hardcoded-threshold structural streams, 60Hz frame-grid
     quantization, replayed duplicate recordings, and human/machine mixed
     streams must not produce a confident wrong verdict. v1 fails each of these;
     v2 closes them.

The matrix runs in well under a second, so this is cheap enough to run on every
detector change. exit 0 = gate passes, 1 = assertion failure, 2 = datasets missing.

Usage:
  python3 scripts/behavior_attack_suite.py
  python3 scripts/behavior_attack_suite.py --datasets <dir> --patched <dir>
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import behavior_attacks as A  # noqa: E402
import behavior_detector as D  # noqa: E402

# Residual known mismatches of the current hardening (documented, not regression
# targets): extreme-jitter machine-clicks flips (sigma >= 100) and two extreme
# retime scales (f=0.1 human-typing, f>=5 machine-typing). A detector regression
# that re-opens a closed attack class pushes this count up.
KNOWN_MAX_MISMATCH = 9


def classify(events):
    return D.classify(D.extract_all(events))


def load_streams(datasets: Path, patched: Path) -> dict[str, list[dict]]:
    streams = {}
    for name, path in A.STREAM_NAMES:
        p = Path(path)
        p = datasets / p.name if name.split("-")[0] in ("machine", "human") else patched / p.name
        streams[name] = A.load_events(str(p))
    return streams


def assert_baseline(streams) -> tuple[int, list[str]]:
    """18 datasets -> expected verdict (machine-* MACHINE, the rest HUMAN)."""
    failures = []
    for name, events in streams.items():
        exp = "MACHINE" if name.startswith("machine") else "HUMAN"
        r = classify(events)
        if r["verdict"] != exp:
            failures.append(f"baseline {name}: expected {exp}, got {r['verdict']} "
                            f"(score={r['score']:+.3f} conf={r['confidence']:.3f})")
    return 18 - len(failures), failures


def build_matrix(streams, rng_seed=1337) -> list[dict]:
    """Full adversarial attack matrix (ported from the hardening harness)."""
    rng = random.Random(rng_seed)
    rows = []

    def rec(attack, stream, expected, events, replay=False):
        r = classify(events)
        rows.append({"attack": attack, "stream": stream, "expected": expected,
                     "verdict": r["verdict"], "conf": r["confidence"],
                     "replay_flagged": "replay-suspect" in (r.get("note") or "")})
        return r

    for name, events in streams.items():
        cls = "machine" if name.startswith("machine") else "human"
        exp = "MACHINE" if cls == "machine" else "HUMAN"
        for sigma in (5, 15, 25, 50, 100, 200):
            for seed in (1, 2, 3):
                rec(f"jitter-gauss sigma={sigma}", name, exp,
                    A.add_gaussian_jitter(events, sigma, random.Random(seed)))
        for span in (25, 50):
            rec(f"jitter-uniform span={span}", name, exp,
                A.add_uniform_jitter(events, span, random.Random(9)))
        rec("quantize-60hz", name, exp, A.quantize_ts(events))

    for name in ("human-typing", "human-clicks", "human-scroll",
                 "machine-typing", "machine-clicks", "machine-scroll",
                 "patched-typing", "patched-clicks", "patched-scroll"):
        exp = "MACHINE" if name.startswith("machine") else "HUMAN"
        for n in (3, 5, 10, 15, 25):
            rec(f"truncate-n={n}", name, exp, A.truncate(streams[name], n))

    mixed_specs = [
        ("mt+hs", "machine-typing", "human-scroll"),
        ("ht+ms", "human-typing", "machine-scroll"),
        ("mc+hs", "machine-clicks", "human-scroll"),
        ("ht+mc", "human-typing", "machine-clicks"),
        ("ht+hk+ms", "human-typing", "machine-scroll", "human-clicks"),
        ("mt+hk", "machine-typing", "human-clicks"),
        ("mt+hk+hs", "machine-typing", "human-clicks", "human-scroll"),
    ]
    for spec in mixed_specs:
        label, parts = spec[0], spec[1:]
        merged = streams[parts[0]]
        for p in parts[1:]:
            merged = A.append_stream(merged, streams[p])
        human_parts = [p for p in parts if p.startswith("human")]
        exp = "HUMAN" if len(human_parts) * 2 > len(parts) else "MACHINE"
        rec(f"mixed {label}", "+".join(parts), exp, merged)

    baseline_conf = {}
    for name in ("human-scroll", "human-clicks", "machine-typing"):
        exp = "MACHINE" if name.startswith("machine") else "HUMAN"
        baseline_conf[name] = classify(streams[name])["confidence"]
        for k in (2, 5, 20):
            dup = streams[name]
            for _ in range(k - 1):
                dup = A.append_stream(dup, streams[name], gap_ms=1200.0)
            rec(f"replay-dup k={k}", name, exp, dup)

    sweep_fs = (0.1, 0.25, 0.5, 0.75, 1.25, 1.5, 2.0, 5.0, 10.0)
    for name in ("human-typing", "human-clicks", "human-scroll", "machine-typing"):
        exp = "MACHINE" if name.startswith("machine") else "HUMAN"
        for f in sweep_fs:
            rec(f"retime f={f}", name, exp, A.scale_ts(streams[name], f))
    for name in ("human-scroll", "human-typing"):
        for f in (0.25, 2.0):
            rec(f"retime-jitter f={f}", name, "HUMAN",
                A.scale_ts(streams[name], f, jitter=3.0, rng=rng))

    for name, events, exp in [
        ("constant-gap-typing", A.constant_gap_typing(streams["human-typing"]), "MACHINE"),
        ("rigid-threshold-typing", A.rigid_threshold_typing(), "MACHINE"),
        ("rigid-threshold-clicks", A.rigid_threshold_clicks(), "MACHINE"),
        ("rigid-full-session", A.rigid_threshold_typing(60) + A.rigid_threshold_clicks(), "MACHINE"),
        ("constant-delta-scroll", A.constant_delta_scroll(), "MACHINE"),
    ]:
        rec(f"structural {name}", name, exp, events)

    for name, events in streams.items():
        exp = "MACHINE" if name.startswith("machine") else "HUMAN"
        rec("baseline", name, exp, events)
    return rows, baseline_conf


def assert_hardening(rows, baseline_conf) -> list[str]:
    failures = []
    for r in rows:
        a, name = r["attack"], r["stream"]
        # structural constant-rate / hardcoded-threshold gaming attacks
        if a.startswith("structural") and r["verdict"] == "HUMAN":
            failures.append(f"hardening {a}: rigid stream read HUMAN")
        # 60Hz quantization must not flip a machine stream (v1 flipped machine-clicks)
        if a == "quantize-60hz" and name.startswith("machine") and r["verdict"] == "HUMAN":
            failures.append(f"hardening {a} {name}: machine stream read HUMAN")
        # mixed human/machine streams: never the opposite-sign verdict
        if a.startswith("mixed") and ((r["expected"] == "MACHINE" and r["verdict"] == "HUMAN")
                                      or (r["expected"] == "HUMAN" and r["verdict"] == "MACHINE")):
            failures.append(f"hardening {a}: contradiction read {r['verdict']} (conf {r['conf']:.3f})")
        # replay: correct verdict and no confidence inflation (per row); the
        # replay flag itself is asserted per stream after the loop -- the
        # 16-gap duplicate-window hash only fires where >=2 aligned windows
        # exist, which depends on the stream's base size relative to k
        # (e.g. the 19-event scroll stream only reaches it at k=20)
        if a.startswith("replay-dup"):
            if r["verdict"] != r["expected"]:
                failures.append(f"hardening {a} {name}: got {r['verdict']}")
            if r["conf"] > baseline_conf[name] + 1e-9:
                failures.append(f"hardening {a} {name}: conf {r['conf']:.3f} inflated "
                                f"above baseline {baseline_conf[name]:.3f}")
        # jittered re-time must not flip a human stream to MACHINE (v1 flipped typing)
        if a == "retime-jitter" and name == "human-typing" and r["verdict"] == "MACHINE":
            failures.append(f"hardening {a} {name}: human stream read MACHINE")

    flagged_per_stream: dict[str, bool] = {}
    for r in rows:
        if r["attack"].startswith("replay-dup"):
            flagged_per_stream[r["stream"]] = (flagged_per_stream.get(r["stream"], False)
                                               or r["replay_flagged"])
    for name, flagged in flagged_per_stream.items():
        if not flagged:
            failures.append(f"hardening replay-dup {name}: replay never flagged at any k")

    mismatches = [r for r in rows
                  if (r["expected"] == "MACHINE" and r["verdict"] == "HUMAN")
                  or (r["expected"] == "HUMAN" and r["verdict"] == "MACHINE")]
    if len(mismatches) > KNOWN_MAX_MISMATCH:
        failures.append(f"matrix mismatches {len(mismatches)} > known {KNOWN_MAX_MISMATCH}")
    return failures


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--datasets", type=Path, default=here.parent / "testdata" / "behavior" / "datasets",
                    help="benchmark dataset dir (default: committed testdata)")
    ap.add_argument("--patched", type=Path, default=here.parent / "testdata" / "behavior" / "patched",
                    help="patched-driver dataset dir (default: committed testdata)")
    args = ap.parse_args()
    for d in (args.datasets, args.patched):
        if not d.is_dir():
            print(f"missing dataset dir: {d}", file=sys.stderr)
            return 2

    streams = load_streams(args.datasets, args.patched)
    empty = [n for n, e in streams.items() if not e]
    if empty:
        print(f"no trusted events in: {', '.join(empty)}", file=sys.stderr)
        return 2

    passed, baseline_failures = assert_baseline(streams)
    print(f"[{'PASS' if not baseline_failures else 'FAIL'}] baseline: {passed}/18 expected verdicts")
    for f in baseline_failures:
        print(f"    - {f}")

    rows, baseline_conf = build_matrix(streams)
    hardening_failures = assert_hardening(rows, baseline_conf)
    print(f"[{'PASS' if not hardening_failures else 'FAIL'}] attack matrix: {len(rows)} rows, "
          f"hardening assertions")
    for f in hardening_failures:
        print(f"    - {f}")

    if baseline_failures or hardening_failures:
        total = len(baseline_failures) + len(hardening_failures)
        print(f"\nGATE: FAIL ({total} failure(s))")
        return 1
    print("\nGATE: PASS -- 18/18 baseline and all hardening assertions hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
