#!/usr/bin/env python3
"""Regression guard for the fingerprint model -- pure-Python (no nodriver), so it
runs in CI and locally: `python tests/test_fingerprint.py` (exits non-zero on
failure) or `pytest`. Locks in the coherence invariants fixed in the gap audit.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from stealth_browser import fp_profiles as fp  # noqa: E402

_VALID_MEM = {0.25, 0.5, 1, 2, 4, 8}


def test_every_profile_coherent():
    seen = set()
    for p in fp.PROFILES:
        assert p.label not in seen, f"duplicate label: {p.label}"
        seen.add(p.label)
        # deviceMemory is a power of two <= 8 (Chrome caps at 8; >8 / 6 = bot tell)
        assert p.device_memory in _VALID_MEM, f"{p.label}: bad mem {p.device_memory}"
        # realistic core band
        assert 1 <= p.hw_concurrency <= 64, f"{p.label}: cores {p.hw_concurrency}"
        # avail never exceeds screen
        assert p.avail_w <= p.screen_w and p.avail_h <= p.screen_h, \
            f"{p.label}: avail > screen"
        assert p.webgl_vendor and p.webgl_renderer, f"{p.label}: empty webgl"
        if p.ua_platform == "Windows":
            assert "0x" in p.webgl_renderer, f"{p.label}: Windows renderer no PCI id"
        if p.is_mobile:
            assert p.ua_model and p.ua_reduced and p.max_touch_points == 5, \
                f"{p.label}: mobile fields incomplete"
            assert p.platform == "Linux armv8l"
        else:
            assert p.max_touch_points == 0, f"{p.label}: desktop has touch"


def test_profile_count_and_diversity():
    assert len(fp.PROFILES) >= 300, f"expected >=300 profiles, got {len(fp.PROFILES)}"
    classes = {p.gpu_class for p in fp.PROFILES}
    assert {"nvidia", "amd", "intel", "apple", "adreno"}.issubset(classes)


def test_battery_coherence():
    def env_for(label):
        p = next(x for x in fp.PROFILES if label.lower() in x.label.lower())
        return p, fp.fp_env(p, 424242)
    # desktops: mains/full
    for d in ("Windows desktop, NVIDIA RTX 4090", "iMac 24", "Mac Studio",
              "Mac mini", "Linux desktop, Mesa llvmpipe"):
        p, e = env_for(d)
        assert not fp._has_battery(p), f"{p.label} should have no battery"
        assert e["APEX_FP_BATTERY_LEVEL"] == "1.0" and \
            e["APEX_FP_BATTERY_CHARGING"] == "1", f"{p.label} battery not mains/full"
    # laptops/phones: discharging band possible, level in 0.55..0.95
    for d in ("MacBook Air 13 M2", "Windows laptop, Intel Iris Xe",
              "Samsung Galaxy S23"):
        p, e = env_for(d)
        assert fp._has_battery(p), f"{p.label} should have a battery"
        lvl = float(e["APEX_FP_BATTERY_LEVEL"])
        assert 0.5 <= lvl <= 0.96, f"{p.label} battery level {lvl} out of band"


def test_persona_fingerprint_stable_and_diverse():
    tmp = tempfile.mkdtemp()
    # same account -> identical (profile, seed) across 3 "logins"
    a = Path(tmp) / "acct-a"; a.mkdir()
    runs = [fp.persona_fingerprint(a) for _ in range(3)]
    assert len({(pr.label, s) for pr, s in runs}) == 1, "account fp not stable"
    # different accounts -> distinct, spanning multiple device classes
    fps = []
    for i in range(30):
        d = Path(tmp) / f"acct-{i}"; d.mkdir()
        fps.append(fp.persona_fingerprint(d))
    assert len({(pr.label, s) for pr, s in fps}) >= 25, "accounts not diverse"
    assert len({pr.gpu_class for pr, s in fps}) >= 3, "device classes not diverse"
    # ephemeral (None) -> fresh each call
    assert fp.persona_fingerprint(None)[1] != fp.persona_fingerprint(None)[1]


def test_apex_languages_emitted_from_locale():
    # the env list fed to the apex-languages patch is the q-stripped accept-lang
    from stealth_browser.profile import identity_for_ip_geo
    idn = identity_for_ip_geo({"country": "ES", "timezone": "Europe/Madrid"},
                              vary_viewport=False)
    assert idn.locale == "es-ES"
    langs = ",".join(t.split(";")[0].strip()
                     for t in idn.accept_language.split(",") if t.strip())
    assert langs == "es-ES,es,en"


def test_persona_group_and_host_feasibility():
    import importlib
    os.environ["APEX_HOST_GPU"] = "intel"  # software/Intel/Apple host maxes at 16384
    os.environ.pop("APEX_PROFILE_GROUP", None)
    importlib.reload(fp)
    pool = fp._persona_pool()
    assert pool, "feasible pool empty"
    assert all(fp._persona_max_texture(p) <= 16384 for p in pool), \
        "16384 host offered a 32768 persona"
    os.environ["APEX_PROFILE_GROUP"] = "apple,intel"
    assert {p.gpu_class for p in fp._persona_pool()}.issubset({"apple", "intel"})
    os.environ["APEX_PROFILE_GROUP"] = "MacBook"
    assert all("macbook" in p.label.lower() for p in fp._persona_pool())
    os.environ.pop("APEX_PROFILE_GROUP", None)
    os.environ["APEX_HOST_GPU"] = "nvidia"
    importlib.reload(fp)
    assert any(p.gpu_class == "nvidia" for p in fp._persona_pool())
    os.environ.pop("APEX_HOST_GPU", None)
    importlib.reload(fp)


def _run():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run())
