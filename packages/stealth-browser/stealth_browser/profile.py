"""Coherent identity profile for a stealth browser session.

A fingerprinter (CreepJS, Cloudflare, DataDome) does not block you for being a
bot. It blocks you for *lying* -- for an internally inconsistent fingerprint.
This module produces a single coherent identity: every field (timezone, locale,
UA, platform, screen) agrees with every other field and, ideally, with the exit
IP of the proxy you route through.

Nothing here patches the browser. It only chooses *consistent* values and the
launch flags that remove the obvious headless tells. The browser itself stays a
real, unmodified Chrome -- that is what gives an authentic TLS/HTTP2 fingerprint
and an authentic JS/DOM surface for free.
"""

from __future__ import annotations

import os
import platform
import shutil
from dataclasses import dataclass, field


def chrome_path() -> str:
    """Resolve the real Google Chrome executable for this environment.

    Order: $CHROME_PATH override (Docker sets this) -> per-OS default ->
    PATH lookup. We want REAL Google Chrome (genuine consumer UA/fingerprint),
    not Chromium and not Chrome-for-Testing.
    """
    env = os.environ.get("CHROME_PATH")
    if env and os.path.exists(env):
        return env
    candidates = {
        "Darwin": [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ],
        "Linux": [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/chrome",
        ],
        "Windows": [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ],
    }.get(platform.system(), [])
    for c in candidates:
        if os.path.exists(c):
            return c
    found = shutil.which("google-chrome") or shutil.which("google-chrome-stable")
    if found:
        return found
    # last resort: return the macOS default so the error message is clear
    return candidates[0] if candidates else "google-chrome"


# A realistic desktop profile. The defaults MUST match the real exit IP --
# timezone, geolocation and IP-geo are cross-referenced by strict fingerprinters
# (iphey flags "trying to hide your location" the moment they disagree).
#
# The defaults below describe the *actual* network this runs on (Comcast,
# Santa Clara CA -> America/Los_Angeles). DO NOT spoof these to another region
# unless you also route through a proxy whose exit IP is in that region:
# spoofing geo/timezone without a matching IP *creates* the very inconsistency
# detectors look for. `for_ip()` / `match_real_ip()` keep this honest.
@dataclass
class Identity:
    # --- locale / geo (MUST agree with the exit IP) ---
    timezone: str = "America/Los_Angeles"
    locale: str = "en-US"
    accept_language: str = "en-US,en;q=0.9"
    # geolocation must sit inside the timezone above (Santa Clara, CA)
    latitude: float = 37.3486
    longitude: float = -121.9732

    # --- display ---
    # A very common MacBook logical resolution. Chrome reports CSS pixels here.
    viewport_width: int = 1512
    viewport_height: int = 859
    screen_width: int = 1512
    screen_height: int = 982
    device_scale_factor: float = 2.0  # Retina

    # --- platform (derived from the host so navigator.platform never lies) ---
    platform_name: str = field(default="")
    is_mac: bool = field(default=False)

    # Whether to push a geolocation override at all. A normal Chrome user has
    # NOT granted geolocation -- the permission sits at "prompt" and no
    # coordinates are exposed. Overriding geolocation is only useful (and only
    # safe) when it exactly matches the exit IP. Default off: most fingerprint
    # checks never read geolocation, and an un-granted geo is the human norm.
    override_geolocation: bool = False

    def __post_init__(self) -> None:
        host = platform.system()
        if not self.platform_name:
            self.platform_name = {
                "Darwin": "MacIntel",
                "Windows": "Win32",
                "Linux": "Linux x86_64",
            }.get(host, "MacIntel")
        self.is_mac = host == "Darwin"


import random as _random

# IANA timezone for each US state/region we might see from an IP-geo lookup.
# Used by identity_for_ip_geo() to derive a coherent timezone from a region.
_REGION_TZ = {
    "California": "America/Los_Angeles",
    "Washington": "America/Los_Angeles",
    "Oregon": "America/Los_Angeles",
    "Nevada": "America/Los_Angeles",
    "New York": "America/New_York",
    "Texas": "America/Chicago",
    "Illinois": "America/Chicago",
    "Colorado": "America/Denver",
    "Arizona": "America/Phoenix",
    "Florida": "America/New_York",
}

# The dominant browser locale for a country -- so a proxy exiting in Germany
# gets de-DE, not en-US. A locale that disagrees with the IP's country is a
# real coherence signal that strict fingerprinters cross-check. This is honest
# matching, not spoofing: the request genuinely exits in that country.
_COUNTRY_LOCALE = {
    "US": ("en-US", "en-US,en;q=0.9"),
    "GB": ("en-GB", "en-GB,en;q=0.9"),
    "CA": ("en-CA", "en-CA,en;q=0.9,fr-CA;q=0.8"),
    "AU": ("en-AU", "en-AU,en;q=0.9"),
    "DE": ("de-DE", "de-DE,de;q=0.9,en;q=0.8"),
    "FR": ("fr-FR", "fr-FR,fr;q=0.9,en;q=0.8"),
    "ES": ("es-ES", "es-ES,es;q=0.9,en;q=0.8"),
    "IT": ("it-IT", "it-IT,it;q=0.9,en;q=0.8"),
    "NL": ("nl-NL", "nl-NL,nl;q=0.9,en;q=0.8"),
    "BR": ("pt-BR", "pt-BR,pt;q=0.9,en;q=0.8"),
    "JP": ("ja-JP", "ja-JP,ja;q=0.9,en;q=0.8"),
    "TW": ("zh-TW", "zh-TW,zh;q=0.9,en;q=0.8"),
}

# A small set of *real, common* desktop viewport sizes. Per-session variety
# here is honest -- real visitors genuinely have different window sizes. This
# is NOT forging hardware; it is picking among ordinary, plausible values.
_COMMON_VIEWPORTS = [
    (1512, 859, 982, 2.0),    # 14" MacBook Pro
    (1440, 812, 900, 2.0),    # 13" MacBook Air
    (1920, 969, 1080, 1.0),   # common 1080p desktop
    (1536, 746, 864, 1.25),   # common Windows laptop (150% scaling)
    (1366, 657, 768, 1.0),    # older/budget laptop
    (1680, 939, 1050, 1.0),   # 1680x1050 desktop
]


def identity_for_ip_geo(geo: dict, *, vary_viewport: bool = True) -> Identity:
    """Build a coherent Identity from an IP-geolocation dict.

    `geo` is the normalized dict from `proxy.lookup_exit_geo()`:
    keys `timezone`, `latitude`, `longitude`, `region`, `country`.

    Everything is matched to the network: timezone from the IP, locale from
    the IP's country, geo coordinates from the IP. This guarantees the identity
    AGREES with the exit IP -- the thing iphey/pixelscan flag the instant it
    disagrees. With `vary_viewport`, each call also picks a different (but
    entirely ordinary) window size, so sessions are not byte-identical.
    """
    tz = geo.get("timezone") or _REGION_TZ.get(
        geo.get("region", ""), "America/Los_Angeles")
    country = (geo.get("country") or "US").upper()
    locale, accept_language = _COUNTRY_LOCALE.get(
        country, ("en-US", "en-US,en;q=0.9"))

    kwargs: dict = {
        "timezone": tz,
        "locale": locale,
        "accept_language": accept_language,
    }
    lat, lon = geo.get("latitude"), geo.get("longitude")
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        kwargs["latitude"] = float(lat)
        kwargs["longitude"] = float(lon)
    if vary_viewport:
        vw, vh, sh, dsf = _random.choice(_COMMON_VIEWPORTS)
        kwargs.update(viewport_width=vw, viewport_height=vh,
                      screen_width=vw, screen_height=sh,
                      device_scale_factor=dsf)
    return Identity(**kwargs)


def in_container() -> bool:
    """Detect if we're running inside a container (Docker sets these)."""
    if os.environ.get("STEALTH_IN_DOCKER") == "1":
        return True
    return os.path.exists("/.dockerenv")


def chrome_launch_flags(identity: Identity, *, headless: bool,
                        proxy=None) -> list[str]:
    """Chrome command-line flags that remove headless/automation tells.

    The single most important choice: do NOT pass --headless. Headless Chrome
    has its own detectable rendering + missing-feature quirks (CreepJS scored
    --headless 67% headless). We run *headful*. In Docker the browser still
    runs headful -- onto an Xvfb virtual display, NOT --headless.

    These flags strip the two loudest automation signals:
      * --disable-blink-features=AutomationControlled -> navigator.webdriver
      * (we never pass --enable-automation, which adds the "Chrome is being
        controlled by automated software" infobar and other tells)
    """
    flags = [
        # kill the navigator.webdriver = true signal
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-service-autorun",
        "--password-store=basic",
        "--use-mock-keychain",
        # stable, real-user-ish rendering
        "--disable-features=IsolateOrigins,site-per-process,Translate",
        "--disable-popup-blocking",
        # keep the GPU on -- a real machine has WebGL; SwiftShader looks fake
        f"--lang={identity.locale}",
        f"--window-size={identity.viewport_width},{identity.viewport_height}",
    ]
    if in_container():
        # Required to run Chrome (headful, on Xvfb) inside a container:
        #  --no-sandbox        -- Chrome's sandbox cannot init as root in a
        #                         container. Mild automation tell, but
        #                         unavoidable here and NOT page-visible.
        #  --disable-dev-shm-usage -- containers give /dev/shm only ~64MB;
        #                         without this Chrome crashes on big pages.
        flags += ["--no-sandbox", "--disable-dev-shm-usage"]
        # WebGL: a container has no GPU. Without help Chrome disables WebGL
        # entirely (renderer = null -- a dead headless tell). We route WebGL
        # through ANGLE's GL backend on top of Mesa's llvmpipe (installed in
        # the image). llvmpipe is a REAL software renderer used by countless
        # GPU-less Linux desktops -- so the renderer string is genuine and
        # not the Chrome-internal "SwiftShader" tell. No JS patching needed.
        flags += [
            "--use-gl=angle",
            "--use-angle=gl",
            "--ignore-gpu-blocklist",
            "--enable-webgl",
            "--enable-unsafe-swiftshader",  # fallback only
        ]
    # Opt-in cert tolerance for TLS-TERMINATING unblockers (e.g. Oxylabs Web
    # Unblocker, which MITMs HTTPS and presents its own CA). Without this,
    # every navigation through such an endpoint dies with
    # ERR_CERT_AUTHORITY_INVALID. Gated on its own env var (NOT on `proxy`,
    # since both cores wire the proxy via the driver and call this without the
    # proxy arg). Do NOT set it for a transparent tunnelling proxy -- it
    # weakens TLS validation; the clean alternative is to install the
    # unblocker's CA cert into the system store.
    if os.environ.get("APEX_PROXY_IGNORE_CERT") == "1":
        flags.append("--ignore-certificate-errors")
    if proxy is not None and getattr(proxy, "configured", False):
        # route all of Chrome's traffic through the proxy. Credentials are NOT
        # in this flag -- they are supplied over CDP (Fetch.authRequired).
        flags.append(proxy.chrome_flag())
    if headless:
        # only used by the headless control test; the real run stays headful
        flags.append("--headless=new")
    return flags
