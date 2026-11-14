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
            "tlsUaMismatch", "tlsAcceptLanguageOk", "mediaQueriesOk",
            "systemColorsOk", "intlTimezoneOk", "webrtcDepthOk", "sensorsMiscOk",
            "webAuthnCapsOk", "wasmFeaturesOk", "tlsSecFetchOk"]
NEW_CHECKS = [c for c in checks._CHECKS if c[0] in NEW_KEYS]
OTHER_KEYS = [c[0] for c in checks._CHECKS if c[0] not in NEW_KEYS]


def scored(probe: dict) -> dict:
    return checks.score(probe)


class TestRegistration(unittest.TestCase):
    def test_new_checks_are_registered(self):
        self.assertEqual([c[0] for c in NEW_CHECKS], NEW_KEYS)

    def test_count_is_base_62_plus_6_plus_8(self):
        self.assertEqual(len(checks._CHECKS), 76)
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


class TestMediaQueriesOk(unittest.TestCase):
    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "mediaQueriesOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, **overrides):
        probe = {"mediaQueriesOk": True,
                 "mediaQueries": {"prefersColorScheme": "light",
                                  "forcedColors": "none", "monochrome": True,
                                  "displayGamutSrgb": True, "invertedColors": False}}
        probe.update(overrides)
        return probe

    def test_pass_shape(self):
        self._assert(self.base_probe(), True)

    def test_fail_no_scheme_match(self):
        probe = self.base_probe(mediaQueriesOk=False,
                                mediaQueries={"prefersColorScheme": "none",
                                              "forcedColors": "none", "monochrome": True,
                                              "displayGamutSrgb": True})
        self._assert(probe, False)

    def test_fail_color_display_claimed_monochrome(self):
        probe = self.base_probe(mediaQueriesOk=False,
                                mediaQueries={"prefersColorScheme": "dark",
                                              "forcedColors": "none", "monochrome": False,
                                              "displayGamutSrgb": True})
        self._assert(probe, False)


class TestSystemColorsOk(unittest.TestCase):
    NAMES = ["AccentColor", "AccentColorText", "ActiveText", "ButtonBorder",
             "ButtonFace", "ButtonText", "Canvas", "CanvasText", "Field", "FieldText",
             "GrayText", "Highlight", "HighlightText", "InfoBackground", "InfoText",
             "LinkText", "Mark", "MarkText", "VisitedText"]

    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "systemColorsOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, uach="Windows", active_text="rgb(0, 102, 204)", **overrides):
        colors = {n: "rgb(1, 2, 3)" for n in self.NAMES}
        colors["ActiveText"] = active_text
        probe = {"systemColorsOk": True, "uachPlatform": uach, "systemColors": colors}
        probe.update(overrides)
        return probe

    def test_pass_windows_accent_blue(self):
        self._assert(self.base_probe(), True)

    def test_fail_windows_reports_linux_red(self):
        probe = self.base_probe(systemColorsOk=False, active_text="rgb(255, 0, 0)")
        self._assert(probe, False)

    def test_fail_transparent_color(self):
        colors = {n: "rgb(1, 2, 3)" for n in self.NAMES}
        colors["Highlight"] = "rgba(0, 0, 0, 0)"
        probe = self.base_probe(systemColorsOk=False, systemColors=colors)
        self._assert(probe, False)

    def test_non_windows_persona_not_pinned_to_windows_value(self):
        self._assert(self.base_probe(uach="Linux", active_text="rgb(255, 0, 0)"), True)


class TestIntlTimezoneOk(unittest.TestCase):
    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "intlTimezoneOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, **overrides):
        probe = {"intlTimezoneOk": True, "intlTimeZone": "Europe/Berlin",
                 "intlFormatPartsOk": True, "intlCaseFirstOk": True}
        probe.update(overrides)
        return probe

    def test_pass_shape(self):
        self._assert(self.base_probe(), True)

    def test_fail_etc_unknown_zone(self):
        probe = self.base_probe(intlTimezoneOk=False, intlTimeZone="Etc/Unknown")
        self._assert(probe, False)

    def test_fail_empty_zone(self):
        probe = self.base_probe(intlTimezoneOk=False, intlTimeZone="")
        self._assert(probe, False)

    def test_fail_missing_format_parts(self):
        probe = self.base_probe(intlTimezoneOk=False, intlFormatPartsOk=False)
        self._assert(probe, False)


class TestWebrtcDepthOk(unittest.TestCase):
    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "webrtcDepthOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, **overrides):
        probe = {"webrtcDepthOk": True, "webrtcCapsOk": True, "webrtcSdpOk": True,
                 "webrtcStatsOk": True, "webrtcVideoCaps": ["VIDEO/VP8", "VIDEO/VP9",
                                                            "VIDEO/H264"],
                 "webrtcAudioCaps": ["AUDIO/OPUS"], "webrtcSdpRtpMaps": ["OPUS", "VP8"],
                 "webrtcStatsConnected": True, "webrtcStatsCiphers": ["AES_256_GCM"],
                 "webrtcDtlsCiphers": ["TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256"]}
        probe.update(overrides)
        return probe

    def test_pass_shape(self):
        self._assert(self.base_probe(), True)

    def test_fail_caps_missing_h264(self):
        probe = self.base_probe(webrtcDepthOk=False, webrtcCapsOk=False,
                                webrtcVideoCaps=["VIDEO/VP8", "VIDEO/VP9"])
        self._assert(probe, False)

    def test_fail_sdp_codec_outside_caps(self):
        probe = self.base_probe(webrtcDepthOk=False, webrtcSdpOk=False,
                                webrtcSdpRtpMaps=["OPUS", "VP8", "NOTREALCODEC"])
        self._assert(probe, False)

    def test_fail_non_aes_srtp_cipher(self):
        probe = self.base_probe(webrtcDepthOk=False, webrtcStatsOk=False,
                                webrtcStatsCiphers=["SOMETHING_ELSE"])
        self._assert(probe, False)

    def test_pass_inconclusive_when_not_connected(self):
        probe = self.base_probe(webrtcStatsConnected=False, webrtcStatsCiphers=None)
        self._assert(probe, True)


class TestSensorsMiscOk(unittest.TestCase):
    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "sensorsMiscOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, **overrides):
        probe = {"sensorsMiscOk": True, "uachPlatform": "Windows",
                 "sensorTypes": {"accelerometer": "function", "gyroscope": "function",
                                 "magnetometer": "function", "deviceOrientation": "function",
                                 "deviceMotion": "function"},
                 "sensorEventsFired": 0,
                 "xrInfo": {"present": True, "immersiveVr": False, "immersiveAr": False},
                 "miscPresence": {"vendor": "Google Inc.", "productSub": "20030107",
                                  "vendorSub": "20030107", "vendorFlavors": None,
                                  "maxActions": 2, "domBlockers": None,
                                  "serviceWorker": True, "presentation": "object",
                                  "broadcastChannel": "function", "imageCapture": "function"}}
        probe.update(overrides)
        return probe

    def test_pass_shape(self):
        self._assert(self.base_probe(), True)

    def test_fail_sensor_event_fired_on_desktop(self):
        probe = self.base_probe(sensorsMiscOk=False, sensorEventsFired=1)
        self._assert(probe, False)

    def test_fail_wrong_vendor(self):
        probe = self.base_probe(sensorsMiscOk=False)
        probe["miscPresence"]["vendor"] = "Not Google"
        self._assert(probe, False)

    def test_fail_wrong_product_sub(self):
        probe = self.base_probe(sensorsMiscOk=False)
        probe["miscPresence"]["productSub"] = "20030108"
        self._assert(probe, False)

    def test_fail_wrong_max_actions(self):
        probe = self.base_probe(sensorsMiscOk=False)
        probe["miscPresence"]["maxActions"] = 10
        self._assert(probe, False)

    def test_fail_dom_blockers_reported(self):
        probe = self.base_probe(sensorsMiscOk=False)
        probe["miscPresence"]["domBlockers"] = 2
        self._assert(probe, False)


class TestWebAuthnCapsOk(unittest.TestCase):
    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "webAuthnCapsOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, caps=None, **overrides):
        caps = caps if caps is not None else {"conditionalGet": False,
                                             "hybridTransport": True,
                                             "passkeyPlatformAuthenticator": False,
                                             "userVerifyingPlatformAuthenticator": False}
        probe = {"webAuthnCapsOk": True, "webAuthnCaps": caps}
        probe.update(overrides)
        return probe

    def test_pass_known_key_subset(self):
        self._assert(self.base_probe(), True)

    def test_fail_unknown_key(self):
        probe = self.base_probe(webAuthnCapsOk=False,
                                caps={"madeUpCapability": True})
        self._assert(probe, False)

    def test_fail_non_boolean_value(self):
        probe = self.base_probe(webAuthnCapsOk=False,
                                caps={"hybridTransport": "yes"})
        self._assert(probe, False)

    def test_fail_missing_caps(self):
        probe = self.base_probe(webAuthnCapsOk=False, caps=None)
        self._assert(probe, False)


class TestWasmFeaturesOk(unittest.TestCase):
    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "wasmFeaturesOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, **overrides):
        features = {k: True for k in ["simd", "threads", "bulkMemory", "exceptions",
                                     "referenceTypes", "relaxedSimd", "gc", "memory64",
                                     "tailCall"]}
        probe = {"wasmFeaturesOk": True, "wasmFeatures": features}
        probe.update(overrides)
        return probe

    def test_pass_all_features(self):
        self._assert(self.base_probe(), True)

    def test_fail_one_feature_absent(self):
        probe = self.base_probe(wasmFeaturesOk=False)
        probe["wasmFeatures"]["gc"] = False
        self._assert(probe, False)


class TestTlsSecFetchOk(unittest.TestCase):
    def _assert(self, probe, expected):
        hit = next(r for r in scored(probe)["results"] if r["key"] == "tlsSecFetchOk")
        self.assertEqual(hit["ok"], expected)

    def base_probe(self, site="none", mode="navigate", dest="document", user="?1",
                   observed=True, **overrides):
        probe = {"tlsSecFetchOk": True, "tlsSecFetchObserved": observed,
                 "tlsSecFetch": {"site": site, "mode": mode, "dest": dest, "user": user}}
        probe.update(overrides)
        return probe

    def test_pass_coherent_navigation_set(self):
        self._assert(self.base_probe(), True)

    def test_fail_missing_user(self):
        self._assert(self.base_probe(user=None), False)

    def test_fail_wrong_mode(self):
        self._assert(self.base_probe(mode="no-cors"), False)

    def test_fail_wrong_site(self):
        self._assert(self.base_probe(site="same-origin"), False)

    def test_pass_when_no_headers_observable(self):
        probe = self.base_probe(observed=False, site=None, mode=None, dest=None,
                               user=None)
        self._assert(probe, True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
