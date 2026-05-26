"""Identity -- coherent fingerprint identity for an apex session.

apex reuses stealth-browser's Identity (and identity_for_ip_geo, which builds a
coherent identity matched to a proxy's exit IP). This module re-exports them so
apex code imports identity from one place, and so host-matching extensions
(headless-stealth's host-detection idea) have a home here without touching the
core.

The current Identity is already host-coherent: __post_init__ derives
platform_name from the real OS, and stealth-browser never patches WebGL/CPU in
JS -- they leak the real host truthfully. So "host-matched profile" is achieved
by construction; this module is the extension point if per-session host
variety is added later.
"""

from __future__ import annotations


from stealth_browser.profile import (  # noqa: F401  -- re-exported
    Identity,
    identity_for_ip_geo,
    chrome_launch_flags,
    chrome_path,
    in_container,
)

__all__ = [
    "Identity",
    "identity_for_ip_geo",
    "chrome_launch_flags",
    "chrome_path",
    "in_container",
]
