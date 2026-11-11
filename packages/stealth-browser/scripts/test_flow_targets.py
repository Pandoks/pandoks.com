#!/usr/bin/env python3
"""Offline unit tests for flow_targets' pass-criterion logic.

No browser, no service, no network: exercises the token-detection parser and
the pass criterion (the exact logic that decides PASS/FAIL in the battery)
plus the fixture/expression invariants they depend on. Run:
  python scripts/test_flow_targets.py
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import flow_targets  # noqa: E402


class TestParseTokenResult(unittest.TestCase):
    def test_json_string_with_tokens(self):
        raw = json.dumps({"tokens": ["0.ABCd.ef"], "state": "OK"})
        out = flow_targets.parse_token_result(raw)
        self.assertEqual(out["tokens"], ["0.ABCd.ef"])
        self.assertEqual(out["state"], "OK")
        self.assertIsNone(out["parse_error"])

    def test_dict_input(self):
        out = flow_targets.parse_token_result({"tokens": ["tok1"],
                                               "state": "OK"})
        self.assertEqual(out["tokens"], ["tok1"])

    def test_empty_tokens(self):
        out = flow_targets.parse_token_result(json.dumps(
            {"tokens": [], "state": "PENDING"}))
        self.assertEqual(out["tokens"], [])
        self.assertEqual(out["state"], "PENDING")
        self.assertIsNone(out["parse_error"])

    def test_blank_strings_dropped(self):
        out = flow_targets.parse_token_result(json.dumps(
            {"tokens": ["", "   ", "tok"]}))
        self.assertEqual(out["tokens"], ["tok"])

    def test_garbage_string(self):
        out = flow_targets.parse_token_result("<html>not json</html>")
        self.assertIsNone(out["state"])
        self.assertEqual(out["tokens"], [])
        self.assertEqual(out["parse_error"], "not json")

    def test_none_and_non_dict(self):
        self.assertEqual(flow_targets.parse_token_result(None)["parse_error"],
                         "not a dict")
        self.assertEqual(
            flow_targets.parse_token_result(["a"])["parse_error"],
            "not a dict")


class TestFlowPasses(unittest.TestCase):
    def test_pass_on_token(self):
        ok, reason = flow_targets.flow_passes(
            {"tokens": ["tok"], "state": "OK", "parse_error": None})
        self.assertTrue(ok)
        self.assertIn("token present", reason)

    def test_fail_on_no_token_mentions_state(self):
        ok, reason = flow_targets.flow_passes(
            {"tokens": [], "state": "PENDING", "parse_error": None})
        self.assertFalse(ok)
        self.assertIn("PENDING", reason)

    def test_fail_on_parse_error(self):
        ok, reason = flow_targets.flow_passes(
            {"tokens": [], "state": None, "parse_error": "not json"})
        self.assertFalse(ok)
        self.assertIn("not json", reason)

    def test_fail_on_unparseable_object(self):
        ok, reason = flow_targets.flow_passes("weird")
        self.assertFalse(ok)
        self.assertIn("unparseable", reason)


class TestConstantsAndShape(unittest.TestCase):
    def test_time_bounds_are_sane(self):
        self.assertGreater(flow_targets.TOKEN_GRACE_S, 0)
        self.assertGreater(flow_targets.TOKEN_TIMEOUT_S,
                           flow_targets.TOKEN_GRACE_S)
        self.assertLess(flow_targets.TOKEN_POLL_INTERVAL_S,
                        flow_targets.TOKEN_GRACE_S)

    def test_turnstile_flow_has_click_candidates(self):
        turnstile = dict((name, spec) for name, spec, _ in
                         flow_targets.FLOW_TARGETS)
        self.assertTrue(flow_targets.TURNSTILE_CLICK_SELECTORS)
        for sel in flow_targets.TURNSTILE_CLICK_SELECTORS:
            self.assertIn("challenges.cloudflare.com", sel)

    def test_hcaptcha_flow_has_click_candidates(self):
        for sel in flow_targets.HCAPTCHA_CLICK_SELECTORS:
            self.assertIn("hcaptcha.com", sel)

    def test_names_match_adversarial_section(self):
        names = [name for name, _, _ in flow_targets.FLOW_TARGETS]
        self.assertEqual(names, ["cloudflare-turnstile", "recaptcha-v3",
                                 "hcaptcha"])


class TestExtractionExpression(unittest.TestCase):
    def test_is_iife_and_jsonifying(self):
        js = flow_targets.TOKEN_EXTRACT_JS
        self.assertTrue(js.lstrip().startswith("(() => {"))
        self.assertIn("JSON.stringify", js)

    def test_covers_all_token_sources(self):
        js = flow_targets.TOKEN_EXTRACT_JS
        for name in ("cf-turnstile-response", "g-recaptcha-response",
                     "h-captcha-response", "token", "state"):
            self.assertIn(name, js)


class TestFixtures(unittest.TestCase):
    def _read(self, name: str) -> str:
        path = flow_targets.FIXTURE_DIR / name
        self.assertTrue(path.is_file(), f"missing fixture: {path}")
        return path.read_text()

    def test_recaptcha_fixture_uses_test_sitekey_and_executes(self):
        html = self._read("recaptcha_v3.html")
        self.assertIn("6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI", html)
        self.assertIn("grecaptcha.execute", html)
        self.assertIn('id="token"', html)
        self.assertIn('id="state"', html)

    def test_hcaptcha_fixture_uses_test_sitekey(self):
        html = self._read("hcaptcha.html")
        self.assertIn("10000000-ffff-ffff-ffff-000000000001", html)
        self.assertIn("hcaptcha.render", html)
        self.assertIn('id="token"', html)

    def test_probe_file_declared_matches_disk(self):
        path = flow_targets.FIXTURE_DIR / flow_targets.FIXTURE_PROBE_FILE
        self.assertTrue(path.is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
