#!/usr/bin/env python3
"""Offline tests: per-persona-OS avail area (fp_env) and launch window geometry.

No browser. The container's Xvfb screen is fixed at 1920x1080, so the launch
geometry is checked with real_display_size() pinned to that size.
Run: python3 scripts/test_screen_geometry.py
"""

from __future__ import annotations

import dataclasses
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from stealth_browser import fp_profiles, profile  # noqa: E402

XVFB = (1920, 1080)
EXPECTED_AVAIL = {"Win32": (1920, 1032), "MacIntel": (1920, 1080)}


def container_flags(fp_profile) -> list[str]:
    with mock.patch.object(profile, "in_container", return_value=True), \
            mock.patch.object(profile, "real_display_size", return_value=XVFB):
        return profile.chrome_launch_flags(profile.Identity(), headless=False,
                                           fp_profile=fp_profile)


def window_flags(flags: list[str]) -> list[str]:
    return [f for f in flags if f.startswith(("--window-size", "--window-position"))]


class TestPersonaGeometry(unittest.TestCase):
    def test_every_persona_env_and_window_agree(self):
        for p in fp_profiles.PROFILES:
            with self.subTest(p.label):
                aw, ah = EXPECTED_AVAIL[p.platform]
                env = fp_profiles.fp_env(p, 1, screen=XVFB)
                self.assertEqual(env["APEX_FP_SCREEN_AVAIL_W"], str(aw))
                self.assertEqual(env["APEX_FP_SCREEN_AVAIL_H"], str(ah))
                self.assertNotIn("APEX_FP_SCREEN_W", env)
                self.assertNotIn("APEX_FP_SCREEN_H", env)
                self.assertEqual(window_flags(container_flags(p)),
                                 ["--window-position=0,0",
                                  f"--window-size={aw},{ah}"])

    def test_windows_persona_has_a_taskbar(self):
        win = next(p for p in fp_profiles.PROFILES if p.platform == "Win32")
        env = fp_profiles.fp_env(win, 1, screen=XVFB)
        self.assertLess(int(env["APEX_FP_SCREEN_AVAIL_H"]), XVFB[1])

    def test_windows_10_persona_uses_the_40px_taskbar(self):
        win = next(p for p in fp_profiles.PROFILES if p.platform == "Win32")
        win10 = dataclasses.replace(win, ua_platform_version="1.0.0")
        env = fp_profiles.fp_env(win10, 1, screen=XVFB)
        self.assertEqual(env["APEX_FP_SCREEN_AVAIL_H"], "1040")

    def test_windows_avail_follows_a_scaled_screen(self):
        win = next(p for p in fp_profiles.PROFILES if p.platform == "Win32")
        env = fp_profiles.fp_env(win, 1, screen=(1536, 864))
        self.assertEqual((env["APEX_FP_SCREEN_AVAIL_W"],
                          env["APEX_FP_SCREEN_AVAIL_H"]), ("1536", "816"))

    def test_unknown_screen_leaves_avail_native(self):
        win = next(p for p in fp_profiles.PROFILES if p.platform == "Win32")
        with mock.patch.object(fp_profiles, "real_display_size", return_value=None):
            env = fp_profiles.fp_env(win, 1)
        self.assertNotIn("APEX_FP_SCREEN_AVAIL_W", env)
        self.assertNotIn("APEX_FP_SCREEN_AVAIL_H", env)

    def test_stock_chrome_window_fills_the_screen_at_origin(self):
        self.assertEqual(window_flags(container_flags(None)),
                         ["--window-position=0,0", "--window-size=1920,1080"])


if __name__ == "__main__":
    unittest.main()
