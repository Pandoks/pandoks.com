"""Per-session fingerprint profiles for the apex-chromium patched binary.

The apex-chromium build reads APEX_FP_* environment variables to spoof
canvas / WebGL / audio / navigator natively (see apex-chromium/).
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

import hashlib
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
    # High-entropy Sec-CH-UA-Platform-Version override. None -> the
    # UA_PLATFORM_VERSION_BY_PLATFORM map. The Windows map value is 15.0.0
    # (Win11 23H2); Windows 10 and 11 both report "Windows NT 10.0" in the
    # UA, so a Win10 persona is claimed ONLY through this field: it must be
    # "1.0.0" (a real Win10 machine reports platform version 1.0.0, and
    # >= 13 is what detectors read as Win11).
    ua_platform_version: str | None = None
    gpu_class: str = "apple"   # apple | nvidia | amd | intel
    # WebGPU GPUAdapterInfo.architecture. Dawn's vocabulary is per-GPU
    # generation, not per-CPU ISA: "common-3" (Apple), "ampere"/"lovelace"
    # (NVIDIA 30xx/40xx), "rdna-2" (AMD 6000), "gen-12lp" (Intel Xe),
    # "software" (SwiftShader). None -> WEBGPU_ARCH_BY_CLASS fallback.
    webgpu_arch: str | None = None
    # WebGPU GPUAdapterInfo fields, persona-coherent with the profile's GPU.
    # description = the device's marketing name (matches the WebGL renderer
    # string), driver = the backend string ("Metal"/"D3D12"), device_id = the
    # hex device ID Chrome reports (GPUAdapterInfo.device is always lowercase
    # hex; real values here for coherence).
    webgpu_device: str | None = None
    webgpu_driver: str | None = None
    webgpu_device_id: str | None = None
    # Per-limit overrides (GPUSupportedLimits names -> values). Empty ->
    # WEBGPU_LIMITS_BY_CLASS fallback; both empty -> leave the real limits.
    webgpu_limits: dict[str, int] = field(default_factory=dict)
    # WebGPU feature allowlist override (subset of real adapter.features).
    # Empty -> WEBGPU_FEATURES_BY_CLASS fallback; both empty -> real set kept.
    webgpu_features: tuple[str, ...] = ()
    # "laptop" personas report a discharging battery; "desktop" personas have
    # no battery and report what Chrome does for one: charging=true, level=1.
    form_factor: str = "laptop"   # laptop | desktop
    # Media capability overrides (APEX_FP_MEDIA_* / APEX_FP_WEBAUTHN_*; see
    # apex_fingerprint.h). True emits "1"; False (default) emits nothing --
    # the binary then reports the REAL capability. Set what the persona's
    # CLAIMED hardware justifies (hw decode/encode, HEVC, Dolby Vision,
    # platform authenticator).
    media_hw_decode: bool = False
    media_hw_encode: bool = False
    media_hevc: bool = False
    media_dolby_vision: bool = False
    platform_authenticator: bool = False
    # Claimed total disk size in GiB. Real Chrome derives navigator.storage.
    # estimate()'s quota from the HOST disk (60% of total capacity: pool =
    # total * 0.8, per_key = pool * 0.75), so the container's disk leaks
    # through as the quota. fp_env computes the quota for this claimed size
    # with the same stock formula and emits it. None -> no quota override.
    disk_gb: float | None = None
    # Relative sampling weight from the real-visitor population, so the
    # profile mix reproduces what real machines look like instead of a uniform
    # pick. Source: apify-fingerprint-datapoints 0.16.0
    # (fingerprint-network-definition.zip -> network.json, node
    # "hardwareConcurrency"), the conditional table of hardwareConcurrency
    # given userAgent, pooled (equal-weight per UA) over all desktop-Chrome
    # UAs per OS -- the model is rebuilt from the newest 30,000 real-visitor
    # records (see stealth-chromium/docs/persona-generation-research.md,
    # "Data provenance"). Values are the share of that core count within the
    # OS's desktop population:
    #   Mac:  8 cores 0.441, 10 cores 0.175 (8/10/12/14 = 44/18/5/5%)
    #   Windows: 8 cores 0.284, 12 cores 0.177, 16 cores 0.147
    # (8/4/12/16 = 28/19/18/15%).
    # deviceMemory stays 8 on every profile on purpose: real Chrome reports
    # navigator.deviceMemory clamped at 8 GB (ApproximatedDeviceMemory caps
    # at 8), so 8 is both the API-possible maximum and the most common real
    # value (38% of desktop traffic in the same model; the 16/32 shares there
    # come from the collector's raw-RAM path, which the clamped API never
    # produces). Sampling outside {0.25..8} would be rarer than the detector
    # rule allows, not more realistic.
    population_weight: float = 1.0


# Default WebGPU architecture per gpu_class, used when a persona does not
# pin a more specific one (e.g. "lovelace" for an RTX 40-series).
WEBGPU_ARCH_BY_CLASS: dict[str, str] = {
    "apple": "common-3",
    "nvidia": "ampere",
    "amd": "rdna-2",
    "intel": "gen-12lp",
    "software": "software",
}

# GPUAdapterInfo.type per gpu_class ("discrete" vs "integrated" bus). The
# desktop cards are discrete; Apple Silicon and integrated Xe are integrated.
WEBGPU_TYPE_BY_CLASS: dict[str, str] = {
    "apple": "integrated",
    "nvidia": "discrete",
    "amd": "discrete",
    "intel": "integrated",
    "software": "cpu",
}

# TODO: verify -- per-limit persona values against a real machine of each
# class before trusting them (the probe can diff them). These are the WebGPU
# limits that visibly differ by GPU class; spec-max'd limits are left native.
WEBGPU_LIMITS_BY_CLASS: dict[str, dict[str, int]] = {
    # Apple Silicon (Metal): M-series limits.
    "apple": {
        "maxTextureDimension1D": 8192,
        "maxTextureDimension2D": 8192,
        "maxTextureDimension3D": 2048,
        "maxTextureArrayLayers": 256,
        "maxBindGroups": 4,
        "maxBindGroupsPlusVertexBuffers": 8,
        "maxComputeInvocationsPerWorkgroup": 1024,
        "maxComputeWorkgroupSizeX": 1024,
        "maxComputeWorkgroupSizeY": 1024,
        "maxComputeWorkgroupSizeZ": 1024,
        "maxComputeWorkgroupStorageSize": 32768,
        "maxBufferSize": 268435456,
        "maxStorageBufferBindingSize": 268435456,
    },
    # Desktop D3D12 (NVIDIA/AMD/Intel): shared D3D12-reported limits.
    "nvidia": {
        "maxTextureDimension1D": 16384,
        "maxTextureDimension2D": 16384,
        "maxTextureDimension3D": 2048,
        "maxTextureArrayLayers": 2048,
        "maxBindGroups": 8,
        "maxBindGroupsPlusVertexBuffers": 40,
        "maxComputeInvocationsPerWorkgroup": 1024,
        "maxComputeWorkgroupSizeX": 1024,
        "maxComputeWorkgroupSizeY": 1024,
        "maxComputeWorkgroupSizeZ": 1024,
        "maxComputeWorkgroupStorageSize": 32768,
        "maxBufferSize": 4294967296,
        "maxStorageBufferBindingSize": 4294967296,
    },
}
WEBGPU_LIMITS_BY_CLASS["amd"] = WEBGPU_LIMITS_BY_CLASS["nvidia"]
WEBGPU_LIMITS_BY_CLASS["intel"] = WEBGPU_LIMITS_BY_CLASS["nvidia"]

# Persona-coherent WebGPU feature allowlists (APEX_FP_WEBGPU_FEATURES). The
# binary reports real features INTERSECT the allowlist (subset-only), so every
# name must be (a) a real WebGPU feature string and (b) one the claimed GPU
# class genuinely exposes on its native backend. Names verified against
# Chromium 157.0.8103.38 gpu_supported_features.idl. Class differences that
# matter: Apple (Metal) does ASTC not BC; discrete x86 (D3D12) does BC not
# ASTC; the integrated Intel list is a strict subset of the discrete lists
# (no shader-f16/subgroups/bc-sliced-3d).
WEBGPU_FEATURES_BY_CLASS: dict[str, tuple[str, ...]] = {
    "apple": (
        "core-features-and-limits",
        "depth-clip-control",
        "depth32float-stencil8",
        "timestamp-query",
        "indirect-first-instance",
        "shader-f16",
        "rg11b10ufloat-renderable",
        "bgra8unorm-storage",
        "float32-filterable",
        "float32-blendable",
        "dual-source-blending",
        "subgroups",
        "clip-distances",
        "texture-compression-astc",
    ),
    "nvidia": (
        "core-features-and-limits",
        "depth-clip-control",
        "depth32float-stencil8",
        "timestamp-query",
        "indirect-first-instance",
        "shader-f16",
        "rg11b10ufloat-renderable",
        "bgra8unorm-storage",
        "float32-filterable",
        "float32-blendable",
        "dual-source-blending",
        "subgroups",
        "clip-distances",
        "texture-compression-bc",
        "texture-compression-bc-sliced-3d",
    ),
    "amd": (
        "core-features-and-limits",
        "depth-clip-control",
        "depth32float-stencil8",
        "timestamp-query",
        "indirect-first-instance",
        "shader-f16",
        "rg11b10ufloat-renderable",
        "bgra8unorm-storage",
        "float32-filterable",
        "float32-blendable",
        "dual-source-blending",
        "subgroups",
        "clip-distances",
        "texture-compression-bc",
        "texture-compression-bc-sliced-3d",
    ),
    "intel": (
        "core-features-and-limits",
        "depth-clip-control",
        "depth32float-stencil8",
        "timestamp-query",
        "indirect-first-instance",
        "rg11b10ufloat-renderable",
        "bgra8unorm-storage",
        "float32-filterable",
        "float32-blendable",
        "dual-source-blending",
        "clip-distances",
        "texture-compression-bc",
    ),
}

# Sec-CH-UA-* architecture and platform-version per navigator.platform family.
# These mirror the defaults in apex_fingerprint.h's UAPersona (the C++ maps the
# same values from APEX_FP_UA_PLATFORM), emitted explicitly so a persona can
# never fall out of sync with the binary if the env-vars row changes.
#
# Platform-version coherence rule (the OS version is carried ONLY in this
# high-entropy hint; Windows 10 and 11 both report "Windows NT 10.0" in the
# UA): a real Win10 machine reports 1.0.0, >= 13 is Win11. 15.0.0 = Win11
# 23H2. A Win10 persona is claimed by setting the profile's
# ua_platform_version to "1.0.0" (the per-profile field overrides this map).
UA_ARCH_BY_PLATFORM: dict[str, str] = {
    "Win32": "x86",
    "MacIntel": "arm",
    "Linux x86_64": "x86",
}
UA_PLATFORM_VERSION_BY_PLATFORM: dict[str, str] = {
    "Win32": "15.0.0",
    "MacIntel": "26.7.2",
    "Linux x86_64": "",
}

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
        gpu_class="apple", webgpu_arch="common-3", form_factor="laptop",
        webgpu_device="Apple M1 Pro", webgpu_driver="Metal",
        # GPUAdapterInfo.device is always the hex device id (IORegistry
        # device-id = the Apple chip id), never the MTLDevice name.
        webgpu_device_id="0x6000",
        webgpu_features=(
            "core-features-and-limits", "depth-clip-control",
            "depth32float-stencil8", "timestamp-query",
            "indirect-first-instance", "shader-f16",
            "rg11b10ufloat-renderable", "bgra8unorm-storage",
            "float32-filterable", "float32-blendable",
            "dual-source-blending", "subgroups",
            "texture-compression-astc",
        ),
        media_hw_decode=True, media_hw_encode=True, media_hevc=True,
        disk_gb=512,
        population_weight=0.175,
    ),
    FpProfile(
        label="MacBook Air 13 M2",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M2, "
                       "Unspecified Version)",
        gpu_class="apple", webgpu_arch="common-3", form_factor="laptop",
        webgpu_device="Apple M2", webgpu_driver="Metal",
        webgpu_device_id="0x8112",
        media_hw_decode=True, media_hw_encode=True, media_hevc=True,
        disk_gb=256,
        population_weight=0.441,
    ),
    FpProfile(
        label="MacBook Pro 16 M1 Max",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=10, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, "
                       "Unspecified Version)",
        gpu_class="apple", webgpu_arch="common-3", form_factor="laptop",
        webgpu_device="Apple M1 Max", webgpu_driver="Metal",
        webgpu_device_id="0x6001",
        webgpu_features=(
            "core-features-and-limits", "depth-clip-control",
            "depth32float-stencil8", "timestamp-query",
            "indirect-first-instance", "shader-f16",
            "rg11b10ufloat-renderable", "bgra8unorm-storage",
            "float32-filterable", "float32-blendable",
            "dual-source-blending", "subgroups",
            "texture-compression-astc",
        ),
        media_hw_decode=True, media_hw_encode=True, media_hevc=True,
        disk_gb=1024,
        population_weight=0.175,
    ),
    FpProfile(
        label="MacBook Pro 14 M3",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M3, "
                       "Unspecified Version)",
        gpu_class="apple", webgpu_arch="common-3", form_factor="laptop",
        webgpu_device="Apple M3", webgpu_driver="Metal",
        webgpu_device_id="0x8132",
        media_hw_decode=True, media_hw_encode=True, media_hevc=True,
        disk_gb=512,
        population_weight=0.441,
    ),
    # --- Windows / NVIDIA (gpu_class="nvidia") ---
    FpProfile(
        label="Windows desktop, NVIDIA RTX 3060",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=12, device_memory=8,
        webgl_vendor="Google Inc. (NVIDIA)",
        webgl_renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        gpu_class="nvidia", webgpu_arch="ampere", form_factor="desktop",
        webgpu_device="NVIDIA GeForce RTX 3060",
        webgpu_driver="D3D12", webgpu_device_id="0x2503",
        media_hw_decode=True, media_hw_encode=True, media_hevc=True,
        platform_authenticator=True,
        disk_gb=1024,
        population_weight=0.177,
    ),
    # --- Windows / Intel (gpu_class="intel") ---
    FpProfile(
        label="Windows laptop, Intel Iris Xe",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Intel)",
        webgl_renderer="ANGLE (Intel, Intel(R) Iris(R) Xe Graphics "
                       "(0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        gpu_class="intel", webgpu_arch="gen-12lp", form_factor="laptop",
        webgpu_device="Intel(R) Iris(R) Xe Graphics",
        webgpu_driver="D3D12", webgpu_device_id="0x46a6",
        media_hw_decode=True, media_hw_encode=True,
        media_hevc=True, media_dolby_vision=True,
        disk_gb=512,
        population_weight=0.284,
    ),
    # --- Windows / AMD (gpu_class="amd") ---
    FpProfile(
        label="Windows desktop, AMD RX 6700",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=16, device_memory=8,
        webgl_vendor="Google Inc. (AMD)",
        webgl_renderer="ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 "
                       "vs_5_0 ps_5_0, D3D11)",
        gpu_class="amd", webgpu_arch="rdna-2", form_factor="desktop",
        webgpu_device="AMD Radeon RX 6700 XT", webgpu_driver="D3D12",
        webgpu_device_id="0x73df",  # real Navi22 (kernel amdgpu table)
        media_hw_decode=True, media_hw_encode=True, media_hevc=True,
        platform_authenticator=True,
        disk_gb=1024,
        population_weight=0.147,
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


def real_display_size() -> tuple[int, int] | None:
    """Best-effort real display size in logical pixels, or None.

    The screen is never spoofed, so the launch window must fit the REAL
    display -- a window larger than the screen it is on is the
    impossible-geometry tell. Callers clamp the window size to this.
    """
    import platform as _plat
    import re
    import subprocess
    if _plat.system() == "Linux":
        # Xvfb: the -screen arg of the running server IS the display size.
        try:
            out = subprocess.run(["ps", "-eo", "args"], capture_output=True,
                                 text=True, timeout=8).stdout
        except Exception:  # noqa: BLE001
            return None
        m = re.search(r"-screen\s+\d+\s+(\d+)x(\d+)", out)
        if m:
            return (int(m.group(1)), int(m.group(2)))
    return None


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
    # Weighted by the real-visitor population (see population_weight): a
    # uniform pick over the pool makes every claimed machine equally common,
    # which is itself a rarity signal -- real 8-core machines are several
    # times more common than 10/16-core ones.
    return r.choices(coherent, weights=[p.population_weight
                                        for p in coherent])[0]


def fp_env(profile: FpProfile, seed: int) -> dict[str, str]:
    """Build the APEX_FP_* environment dict for a session.

    `seed` drives the deterministic canvas/audio noise -- one fresh seed per
    session, so each session's canvas/audio hash differs but is stable within
    the session. For laptop personas the battery level is also seed-derived:
    per-session distinct, stable within the session, in a plausible
    discharging-laptop band. Desktop personas have no battery, and Chrome on
    battery-less hardware reports charging=true, level=1 (chargingTime=0,
    dischargingTime=Infinity), so those personas report exactly that.
    """
    if profile.form_factor == "desktop":
        battery_level, battery_charging = "1", "1"
    else:
        # deterministic from seed, 0.55..0.95, whole percent
        rng = random.Random(seed)
        battery_level = str(rng.randint(55, 95) / 100.0)
        battery_charging = "0"
    webgpu_arch = profile.webgpu_arch or WEBGPU_ARCH_BY_CLASS[profile.gpu_class]
    # Canvas farbling key: 64 bits, stable per persona. Real canvas hashes are
    # stable for hundreds of days, so the persona's canvas hash must NOT change
    # between sessions; derive it from the persona label. (The C++ fallback --
    # the 32-bit session seed -- is brute-forceable from one attacker-drawn
    # canvas, so this variable must always be emitted.)
    canvas_key = int.from_bytes(
        hashlib.sha256(f"apex-canvas:{profile.label}".encode()).digest()[:8],
        "big",
    )
    env = {
        "APEX_FP_ACTIVE": "1",
        "APEX_FP_SEED": str(seed & 0xFFFFFFFF),
        "APEX_FP_PLATFORM": profile.platform,
        "APEX_FP_UA_PLATFORM": profile.ua_platform,
        "APEX_FP_CANVAS_KEY": str(canvas_key),
        "APEX_FP_UA_ARCH": UA_ARCH_BY_PLATFORM[profile.platform],
        "APEX_FP_UA_PLATFORM_VERSION": (profile.ua_platform_version
                                        or UA_PLATFORM_VERSION_BY_PLATFORM[profile.platform]),
        "APEX_FP_HW_CONCURRENCY": str(profile.hw_concurrency),
        "APEX_FP_DEVICE_MEMORY": str(profile.device_memory),
        "APEX_FP_WEBGL_VENDOR": profile.webgl_vendor,
        "APEX_FP_WEBGL_RENDERER": profile.webgl_renderer,
        # WebGPU adapter info uses the persona gpu_class, which maps directly
        # to the org-id strings WebGPU reports ("apple"/"intel"/"nvidia"/"amd").
        # Architecture is Dawn's per-GPU-generation name, NOT a CPU ISA.
        "APEX_FP_WEBGPU_VENDOR": profile.gpu_class,
        "APEX_FP_WEBGPU_ARCH": webgpu_arch,
        # Identity fields so adapter.info agrees with the WebGL renderer
        # string (description = the device's marketing name, driver = the
        # backend string, device_id = the hex device ID).
        "APEX_FP_WEBGPU_DESCRIPTION": profile.webgpu_device or "",
        "APEX_FP_WEBGPU_DRIVER": profile.webgpu_driver or "",
        "APEX_FP_WEBGPU_TYPE": WEBGPU_TYPE_BY_CLASS[profile.gpu_class],
        # The screen is NOT spoofed: a screen value that disagrees with the
        # real window/display geometry is the impossible-geometry tell (a
        # window larger than the screen it is on, a dpr its panel can't have).
        # The binary reports the REAL screen natively, which is always
        # coherent; real_display_size() clamps the launch window to fit it.
        "APEX_FP_BATTERY_LEVEL": battery_level,
        "APEX_FP_BATTERY_CHARGING": battery_charging,
    }
    if profile.webgpu_device_id:
        env["APEX_FP_WEBGPU_DEVICE_ID"] = profile.webgpu_device_id
    webgpu_limits = dict(profile.webgpu_limits) if profile.webgpu_limits \
        else WEBGPU_LIMITS_BY_CLASS.get(profile.gpu_class)
    if webgpu_limits:
        for limit_name, limit_value in webgpu_limits.items():
            env[f"APEX_FP_WEBGPU_LIMIT_{limit_name}"] = str(limit_value)
    webgpu_features = profile.webgpu_features or \
        WEBGPU_FEATURES_BY_CLASS.get(profile.gpu_class, ())
    if webgpu_features:
        env["APEX_FP_WEBGPU_FEATURES"] = ",".join(webgpu_features)
    # Storage quota: replicate the stock Chromium formula for the persona's
    # claimed disk (storage/browser/quota/quota_settings.cc: pool = total *
    # kPoolSizeRatio (0.8), per_key = pool * 0.75 -- two int truncations), so
    # the emitted byte count is byte-identical to what stock Chrome reports
    # on a disk of this size.
    if profile.disk_gb:
        quota = int(int(profile.disk_gb * (1024 ** 3) * 0.8) * 0.75)
        env["APEX_FP_STORAGE_QUOTA_BYTES"] = str(quota)
    # navigator.connection: stock-desktop-plausible values, chosen so the
    # real reporting path produces exactly these numbers (rtt 50ms is the
    # report granularity; 12000 kbps clamps to the 10 Mbps report maximum for
    # ANY per-origin rounding multiplier: 12000*0.90 = 10800 > 10000).
    env["APEX_FP_NETINFO_EFFECTIVE_TYPE"] = "4g"
    env["APEX_FP_NETINFO_RTT_MS"] = "50"
    env["APEX_FP_NETINFO_DOWNLINK_KBPS"] = "12000"
    # Media capability / platform-authenticator overrides: emit only what the
    # persona's hardware claims (unset -> the binary reports the real
    # capability).
    if profile.media_hw_decode:
        env["APEX_FP_MEDIA_HW_DECODE"] = "1"
    if profile.media_hw_encode:
        env["APEX_FP_MEDIA_HW_ENCODE"] = "1"
    if profile.media_hevc:
        env["APEX_FP_MEDIA_HEVC"] = "1"
    if profile.media_dolby_vision:
        env["APEX_FP_MEDIA_DOLBY_VISION"] = "1"
    if profile.platform_authenticator:
        env["APEX_FP_WEBAUTHN_PLATFORM"] = "1"
    return env


def patched_chrome_path() -> str | None:
    """Path to the apex-chromium patched binary, if APEX_CHROME_PATH is set.

    When unset, apex falls back to stock Chrome and the APEX_FP_* env vars are
    inert (stock Chrome has no patches reading them).
    """
    p = os.environ.get("APEX_CHROME_PATH")
    return p if (p and os.path.exists(p)) else None
