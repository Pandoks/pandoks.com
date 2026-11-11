#!/usr/bin/env python3
"""Offline unit tests for the battery expansion (checks.score + the new _CHECKS).

No browser: each new check's predicate is fed synthetic probe dicts for its
pass and fail shapes. Run: python3 scripts/test_battery_expansion.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from stealth_browser import checks  # noqa: E402

NEW_KEYS = ["cdpEnumOk", "eventTrustOk", "stackTracesOk", "tlsSurfaceOk",
            "tlsUaMismatch", "tlsAcceptLanguageOk"]
NEW_CHECKS = [c for c in checks._CHECKS if c[0] in NEW_KEYS]
OTHER_KEYS = [c[0] for c in checks._CHECKS if c[0] not in NEW_KEYS]


def scored(probe: dict) -> dict:
    return checks.score(probe)


class TestRegistration(unittest.TestCase):
    def test_new_checks_are_registered(self):
        self.assertEqual([c[0] for c in NEW_CHECKS], NEW_KEYS)

    def test_count_is_base_62_plus_6(self):
        self.assertEqual(len(checks._CHECKS), 68)
        self.assertEqual(len(OTHER_KEYS), 62)

    def test_empty_probe_fails_every_new_check(self):
        r = scored({})
        failing = {x["key"] for x in r["results"] if not x["ok"]}
        self.assertEqual(failing & set(NEW_KEYS), set(NEW_KEYS))

    def test_throw_in_predicate_counts_as_failure(self):
        boomed = ("boom", "throws", lambda p: p["boom"])
        old = checks._CHECKS[:]
        checks._CHECKS[:] = old + [boomed]
        try:
            out = checks.score({})
        finally:
            checks._CHECKS[:] = old
        self.assertFalse(out["results"][-1]["ok"])
        self.assertEqual(out["results"][-1]["key"], "boom")


class TestCdpEnumOk(unittest.TestCase):
    def _assert(self, probe, key, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == key)
        self.assertEqual(hit["ok"], expected)

    def test_pass_when_no_enumeration_hits(self):
        probe = {"cdpEnumOk": True, "cdpWindowEnumHits": [],
                 "cdpGlobalEnumHits": [], "cdpNavigatorEnumHits": [],
                 "cdpDocumentEnumHits": [], "cdpInjectedGlobals": []}
        self._assert(probe, "cdpEnumOk", True)

    def test_fail_on_patchright_global(self):
        probe = {"cdpEnumOk": False, "cdpInjectedGlobals": ["__patchright"],
                 "cdpWindowEnumHits": [], "cdpGlobalEnumHits": [],
                 "cdpNavigatorEnumHits": [], "cdpDocumentEnumHits": []}
        hit = next(r for r in scored(probe)["results"] if r["key"] == "cdpEnumOk")
        self.assertFalse(hit["ok"])
        # the recorded hit is in the per-check value
        self.assertIs(hit["value"], False)


class TestEventTrustOk(unittest.TestCase):
    def test_pass_when_all_untrusted_and_native(self):
        probe = {"eventTrustOk": True, "syntheticIsTrusted": False,
                 "listenerIsTrusted": False, "legacyIsTrusted": False,
                 "isTrustedGetterNative": True}
        self._assert(probe, "eventTrustOk", True)

    def test_fail_when_synthetic_reports_trusted(self):
        probe = {"eventTrustOk": False, "syntheticIsTrusted": True,
                 "listenerIsTrusted": False, "legacyIsTrusted": False,
                 "isTrustedGetterNative": True}
        self._assert(probe, "eventTrustOk", False)

    def _assert(self, probe, key, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == key)
        self.assertEqual(hit["ok"], expected)


class TestStackTracesOk(unittest.TestCase):
    def test_pass_when_no_leak_paths(self):
        probe = {"stackTracesOk": True, "stackLeakPaths": []}
        hit = next(r for r in scored(probe)["results"] if r["key"] == "stackTracesOk")
        self.assertTrue(hit["ok"])

    def test_fail_when_patchright_frame_leaks(self):
        probe = {"stackTracesOk": False, "stackLeakPaths": ["evalError"]}
        hit = next(r for r in scored(probe)["results"] if r["key"] == "stackTracesOk")
        self.assertFalse(hit["ok"])
        self.assertEqual(hit["value"], False)


class TestTlsSurface(unittest.TestCase):
    def base_probe(self, **overrides):
        probe = {"tlsSurfaceOk": True, "tlsUaMismatch": False,
                 "tlsAcceptLanguageOk": True, "tlsJa3": "ja3-string",
                 "tlsJa3Hash": "abc123", "tlsJa4": "ja4-string",
                 "tlsJa4R": "ja4-r-string", "tlsHttpVersion": "h2",
                 "tlsServerUa": "Mozilla/5.0", "tlsMethod": "GET",
                 "tlsRequestHeaders": [], "tlsAcceptLanguage": "en-US,en;q=0.9",
                 "tlsAutomationHeaders": []}
        probe.update(overrides)
        return probe

    def key(self, probe, key):
        return next(r for r in scored(probe)["results"] if r["key"] == key)

    def test_pass_shape(self):
        probe = self.base_probe()
        self.assertTrue(self.key(probe, "tlsSurfaceOk")["ok"])
        self.assertTrue(self.key(probe, "tlsUaMismatch")["ok"])
        self.assertTrue(self.key(probe, "tlsAcceptLanguageOk")["ok"])

    def test_fail_missing_ja4(self):
        probe = self.base_probe(tlsJa4=None, tlsSurfaceOk=False)
        self.assertFalse(self.key(probe, "tlsSurfaceOk")["ok"])

    def test_fail_ua_mismatch(self):
        probe = self.base_probe(tlsUaMismatch=True, tlsSurfaceOk=False,
                                tlsServerUa="HeadlessChrome/120")
        self.assertFalse(self.key(probe, "tlsUaMismatch")["ok"])
        self.assertFalse(self.key(probe, "tlsSurfaceOk")["ok"])

    def test_fail_automation_header(self):
        probe = self.base_probe(tlsSurfaceOk=False, tlsAutomationHeaders=["x-pw"])
        self.assertFalse(self.key(probe, "tlsSurfaceOk")["ok"])

    def test_fail_accept_language_missing_but_headers_sent(self):
        probe = self.base_probe(tlsAcceptLanguageOk=False, tlsAcceptLanguage=None,
                                tlsRequestHeaders=["user-agent: Mozilla/5.0"],
                                tlsSurfaceOk=False)
        self.assertFalse(self.key(probe, "tlsAcceptLanguageOk")["ok"])

    def test_missing_probe_means_fail(self):
        probe = {k: v for k, v in self.base_probe().items() if k != "tlsUaMismatch"}
        self.assertFalse(self.key(probe, "tlsUaMismatch")["ok"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
