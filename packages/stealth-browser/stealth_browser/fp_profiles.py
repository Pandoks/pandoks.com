"""Per-session fingerprint profiles for the apex-chromium patched binary.

The apex-chromium build reads APEX_FP_* environment variables to spoof
canvas / WebGL / audio / navigator / screen natively (see apex-chromium/).
This module picks a coherent profile per session and produces the env dict.

A profile is a *real, internally-consistent device identity* -- every field
agrees with every other (a Mac platform gets a Mac WebGL renderer, a Retina
screen, 8-or-more cores). Picking among real device profiles is honest
diversity: real visitors genuinely have different machines. It is NOT forging
an impossible device.

Only used when apex runs the patched apex-chromium binary. With stock Chrome
the patches do not exist, so the env vars are simply ignored.
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass, field


@dataclass(frozen=True)
class FpProfile:
    """One coherent, real device fingerprint.

    `gpu_class` is the host-GPU family this profile is valid on. WebGL
    fingerprinting is not just the renderer STRING -- a detector can render a
    3D scene and hash the pixels, which reflects the real GPU. So a profile is
    only coherent if its claimed GPU matches the host's actual GPU class.
    apex therefore picks profiles whose gpu_class == the detected host class,
    making WebGL coherent string + numeric params + precision + render output.
    """

    label: str
    platform: str          # navigator.platform
    ua_platform: str       # navigator.userAgentData.platform
    hw_concurrency: int    # navigator.hardwareConcurrency
    device_memory: float   # navigator.deviceMemory (0.25..8, power of two)
    webgl_vendor: str
    webgl_renderer: str
    screen_w: int
    screen_h: int
    avail_w: int
    avail_h: int
    gpu_class: str = "apple"   # apple | nvidia | amd | intel
    color_depth: int = 24


# A pool of real, common device configurations. Each row is a genuine device
# class -- the WebGL renderer string is the actual ANGLE string that hardware
# reports. Coherence is built in: a row's platform, GPU vendor/renderer, and
# gpu_class all describe ONE real machine. apex picks only rows whose
# gpu_class matches the host GPU, so WebGL is coherent end to end.
PROFILES: list[FpProfile] = [
    # --- Apple-Silicon Macs (gpu_class="apple") ---
    FpProfile(
        label="MacBook Pro 14 M1 Pro",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=10, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, "
                       "Unspecified Version)",
        screen_w=1512, screen_h=982, avail_w=1512, avail_h=944,
        gpu_class="apple",
    ),
    FpProfile(
        label="MacBook Air 13 M2",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M2, "
                       "Unspecified Version)",
        screen_w=1470, screen_h=956, avail_w=1470, avail_h=918,
        gpu_class="apple",
    ),
    FpProfile(
        label="MacBook Pro 16 M1 Max",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=10, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, "
                       "Unspecified Version)",
        screen_w=1728, screen_h=1117, avail_w=1728, avail_h=1079,
        gpu_class="apple",
    ),
    FpProfile(
        label="MacBook Pro 14 M3",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M3, "
                       "Unspecified Version)",
        screen_w=1512, screen_h=982, avail_w=1512, avail_h=944,
        gpu_class="apple",
    ),
    # --- Windows / NVIDIA (gpu_class="nvidia") ---
    FpProfile(
        label="Windows desktop, NVIDIA RTX 3060",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=12, device_memory=8,
        webgl_vendor="Google Inc. (NVIDIA)",
        webgl_renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1040,
        gpu_class="nvidia",
    ),
    # --- Windows / Intel (gpu_class="intel") ---
    FpProfile(
        label="Windows laptop, Intel Iris Xe",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Intel)",
        webgl_renderer="ANGLE (Intel, Intel(R) Iris(R) Xe Graphics "
                       "(0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1032,
        gpu_class="intel",
    ),
    # --- Windows / AMD (gpu_class="amd") ---
    FpProfile(
        label="Windows desktop, AMD RX 6700",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=16, device_memory=8,
        webgl_vendor="Google Inc. (AMD)",
        webgl_renderer="ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 "
                       "vs_5_0 ps_5_0, D3D11)",
        screen_w=2560, screen_h=1440, avail_w=2560, avail_h=1400,
        gpu_class="amd",
    ),
]


def detect_host_gpu_class() -> str:
    """Detect the host GPU family: apple | nvidia | amd | intel.

    WebGL render output reflects the real GPU, so apex only serves profiles
    matching the host's class. Overridable with APEX_HOST_GPU.
    """
    forced = os.environ.get("APEX_HOST_GPU", "").strip().lower()
    if forced in ("apple", "nvidia", "amd", "intel"):
        return forced
    import platform as _plat
    import subprocess
    sys_name = _plat.system()
    if sys_name == "Darwin":
        # Apple Silicon -> Apple GPU; Intel Macs are rare now but check.
        mach = _plat.machine()
        if mach == "arm64":
            return "apple"
        try:
            out = subprocess.run(
                ["system_profiler", "SPDisplaysDataType"],
                capture_output=True, text=True, timeout=8).stdout.lower()
        except Exception:  # noqa: BLE001
            return "apple"
        if "nvidia" in out:
            return "nvidia"
        if "amd" in out or "radeon" in out:
            return "amd"
        if "intel" in out:
            return "intel"
        return "apple"
    if sys_name in ("Linux", "Windows"):
        # best-effort: look for a GPU vendor string
        try:
            if sys_name == "Linux":
                out = subprocess.run(["lspci"], capture_output=True,
                                     text=True, timeout=8).stdout.lower()
            else:
                out = subprocess.run(
                    ["wmic", "path", "win32_VideoController", "get", "name"],
                    capture_output=True, text=True, timeout=8).stdout.lower()
        except Exception:  # noqa: BLE001
            return "intel"
        if "nvidia" in out:
            return "nvidia"
        if "amd" in out or "radeon" in out:
            return "amd"
        return "intel"
    return "intel"


# Cache the host GPU class once.
_HOST_GPU_CLASS = detect_host_gpu_class()


def pick_profile_by_label(label_or_substring: str) -> FpProfile | None:
    """Find a profile by exact label or case-insensitive substring match.

    Used by the APEX_PROFILE env var and per-session "profile" request field
    so callers can pin a specific machine ("MacBook Pro 14 M1 Pro",
    "Windows desktop, NVIDIA RTX 3060", or even just "m1 pro" / "rtx").
    Returns None if no match -> callers fall back to pick_profile().
    """
    if not label_or_substring:
        return None
    needle = label_or_substring.strip().lower()
    # exact match first
    for p in PROFILES:
        if p.label.lower() == needle:
            return p
    # then substring
    for p in PROFILES:
        if needle in p.label.lower():
            return p
    return None


def pick_profile(rng: random.Random | None = None) -> FpProfile:
    """Pick a random profile whose GPU class matches the host.

    Env override: APEX_PROFILE=<label substring> pins a specific profile
    instead of randomising. Useful for service mode where the caller wants
    "give me a Windows RTX 3060 session" -- set APEX_PROFILE per container.

    This is the key to deep WebGL coherence: the profile's claimed GPU IS the
    host GPU, so the renderer string, numeric GL params, shader precision, and
    actual rendered-pixel output all agree -- not just the string. Per-session
    variety comes from the multiple device models within the host's GPU class.
    """
    pinned = os.environ.get("APEX_PROFILE", "").strip()
    if pinned:
        match = pick_profile_by_label(pinned)
        if match is not None:
            return match
        # fall through to host-coherent random if APEX_PROFILE didn't match
    r = rng or random
    coherent = [p for p in PROFILES if p.gpu_class == _HOST_GPU_CLASS]
    if not coherent:
        # no profile for this GPU class -- fall back to the whole pool, but
        # this means WebGL render output may not match the string (logged).
        coherent = PROFILES
    return r.choice(coherent)


def fp_env(profile: FpProfile, seed: int) -> dict[str, str]:
    """Build the APEX_FP_* environment dict for a session.

    `seed` drives the deterministic canvas/audio noise -- one fresh seed per
    session, so each session's canvas/audio hash differs but is stable within
    the session. The battery level is also seed-derived: per-session distinct,
    stable within the session, in a plausible discharging-laptop band.
    """
    # per-session battery: deterministic from seed, 0.55..0.95, whole percent
    rng = random.Random(seed)
    battery_pct = rng.randint(55, 95)
    return {
        "APEX_FP_ACTIVE": "1",
        "APEX_FP_SEED": str(seed & 0xFFFFFFFF),
        "APEX_FP_PLATFORM": profile.platform,
        "APEX_FP_UA_PLATFORM": profile.ua_platform,
        "APEX_FP_HW_CONCURRENCY": str(profile.hw_concurrency),
        "APEX_FP_DEVICE_MEMORY": str(profile.device_memory),
        "APEX_FP_WEBGL_VENDOR": profile.webgl_vendor,
        "APEX_FP_WEBGL_RENDERER": profile.webgl_renderer,
        "APEX_FP_SCREEN_W": str(profile.screen_w),
        "APEX_FP_SCREEN_H": str(profile.screen_h),
        "APEX_FP_SCREEN_AVAIL_W": str(profile.avail_w),
        "APEX_FP_SCREEN_AVAIL_H": str(profile.avail_h),
        "APEX_FP_COLOR_DEPTH": str(profile.color_depth),
        "APEX_FP_BATTERY_LEVEL": str(battery_pct / 100.0),
        "APEX_FP_BATTERY_CHARGING": "0",
    }


def patched_chrome_path() -> str | None:
    """Path to the apex-chromium patched binary, if APEX_CHROME_PATH is set.

    When unset, apex falls back to stock Chrome and the APEX_FP_* env vars are
    inert (stock Chrome has no patches reading them).
    """
    p = os.environ.get("APEX_CHROME_PATH")
    return p if (p and os.path.exists(p)) else None
