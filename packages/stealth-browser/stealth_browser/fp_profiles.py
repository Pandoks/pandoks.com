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

import json
import os
import random
from dataclasses import dataclass, field
from pathlib import Path


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
    gpu_class: str = "apple"   # apple | nvidia | amd | intel | llvmpipe | adreno | mali
    color_depth: int = 24
    # Optional per-persona WebGL float-range overrides. Default None -> fp_env
    # derives from gpu_class (D3D11/Metal=1; llvmpipe=255). Linux real-GPU
    # personas set these to the Mesa values (line 255 / point 256): Intel iris +
    # AMD radeonsi share the Mesa GL stack with llvmpipe (measured on our host).
    webgl_line_width_max: int | None = None
    webgl_point_size_max: int | None = None
    # --- mobile (Android) ---------------------------------------------------
    # Mobile personas are emulated at RUNTIME over CDP (setUserAgentOverride +
    # metadata, setDeviceMetricsOverride mobile=True, setTouchEmulationEnabled)
    # -- NOT via a rebuild. When `is_mobile`, fp_env emits only the hardware
    # subset (GPU/cores/mem) and `mobile_emulation_spec()` carries everything
    # CDP applies (UA/UA-CH/touch/DPR/viewport). Desktop personas ignore these.
    is_mobile: bool = False
    device_scale_factor: float = 1.0   # devicePixelRatio (mobile DPR)
    ua_reduced: str = ""               # full reduced UA string (Android 10; K)
    ua_model: str = ""                 # UA-CH high-entropy model (e.g. SM-S911B)
    ua_platform_version_mobile: str = ""  # UA-CH platformVersion (e.g. 14.0.0)
    max_touch_points: int = 0


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
        label="Windows desktop, AMD RX 6700 XT",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=16, device_memory=8,
        webgl_vendor="Google Inc. (AMD)",
        webgl_renderer="ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=2560, screen_h=1440, avail_w=2560, avail_h=1400,
        gpu_class="amd",
    ),
    # --- additional Apple-Silicon (gpu_class="apple") ---
    FpProfile(
        label="MacBook Air 13 M1",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M1, "
                       "Unspecified Version)",
        screen_w=1440, screen_h=900, avail_w=1440, avail_h=862,
        gpu_class="apple",
    ),
    FpProfile(
        label="MacBook Pro 16 M2 Max",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=12, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, "
                       "Unspecified Version)",
        screen_w=1728, screen_h=1117, avail_w=1728, avail_h=1079,
        gpu_class="apple",
    ),
    FpProfile(
        label="MacBook Pro 14 M2 Pro",
        platform="MacIntel", ua_platform="macOS",
        hw_concurrency=10, device_memory=8,
        webgl_vendor="Google Inc. (Apple)",
        webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, "
                       "Unspecified Version)",
        screen_w=1512, screen_h=982, avail_w=1512, avail_h=944,
        gpu_class="apple",
    ),
    # --- additional Windows / NVIDIA (gpu_class="nvidia") ---
    FpProfile(
        label="Windows desktop, NVIDIA RTX 4060",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=16, device_memory=8,
        webgl_vendor="Google Inc. (NVIDIA)",
        webgl_renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1040,
        gpu_class="nvidia",
    ),
    FpProfile(
        label="Windows desktop, NVIDIA RTX 4090",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=24, device_memory=8,
        webgl_vendor="Google Inc. (NVIDIA)",
        webgl_renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=2560, screen_h=1440, avail_w=2560, avail_h=1400,
        gpu_class="nvidia",
    ),
    FpProfile(
        label="Windows laptop, NVIDIA GTX 1660 Ti",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=12, device_memory=8,
        webgl_vendor="Google Inc. (NVIDIA)",
        webgl_renderer="ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti (0x00002182) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1032,
        gpu_class="nvidia",
    ),
    # --- additional Windows / Intel (gpu_class="intel") ---
    FpProfile(
        label="Windows laptop, Intel UHD 630",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Intel)",
        webgl_renderer="ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1032,
        gpu_class="intel",
    ),
    # --- additional Windows / AMD (gpu_class="amd") ---
    FpProfile(
        label="Windows desktop, AMD RX 7600",
        platform="Win32", ua_platform="Windows",
        hw_concurrency=12, device_memory=8,
        webgl_vendor="Google Inc. (AMD)",
        webgl_renderer="ANGLE (AMD, AMD Radeon RX 7600 (0x00007480) "
                       "Direct3D11 vs_5_0 ps_5_0, D3D11)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1040,
        gpu_class="amd",
    ),
    # --- Linux desktop, Mesa llvmpipe software renderer (gpu_class="llvmpipe")
    # A real GPU-less Linux config (VM / cloud desktop / driver-less laptop) and
    # the ONLY persona whose GPU stack is 100% MEASURED on our own host (no
    # speculation): WebGL = Mesa llvmpipe (OpenGL, line-width [1,255], point
    # [1,256], maxTex 16384), WebGPU = Chrome's bundled SwiftShader left native.
    # platform/UA are genuinely Linux (the host IS Linux) -- zero OS spoofing.
    FpProfile(
        label="Linux desktop, Mesa llvmpipe",
        platform="Linux x86_64", ua_platform="Linux",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Mesa)",
        webgl_renderer="ANGLE (Mesa, llvmpipe (LLVM 20.1.2 256 bits), "
                       "OpenGL 4.5)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1053,
        gpu_class="llvmpipe",
    ),
    # --- Android phones (emulated at runtime over CDP; see mobile fields) ---
    # Reduced UA is frozen to "Android 10; K" (verified); the real model/version
    # live ONLY in UA-CH high-entropy. CDP applies UA/UA-CH/touch/DPR/viewport;
    # APEX_FP spoofs the GPU. Coherence runtime-verified (stealth-android run):
    # mobile=true + touch(5) + pointer:coarse + DPR + Adreno all agree.
    FpProfile(
        label="Samsung Galaxy S23 (Android)",
        platform="Linux armv8l", ua_platform="Android",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Qualcomm",
        webgl_renderer="ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)",
        screen_w=360, screen_h=780, avail_w=360, avail_h=780,
        gpu_class="adreno",
        is_mobile=True, device_scale_factor=3.0, max_touch_points=5,
        ua_reduced=("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"),
        ua_model="SM-S911B", ua_platform_version_mobile="14.0.0",
    ),
    FpProfile(
        label="Google Pixel 7 (Android)",
        platform="Linux armv8l", ua_platform="Android",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="ARM",
        webgl_renderer="ANGLE (ARM, Mali-G710, OpenGL ES 3.2)",
        screen_w=412, screen_h=915, avail_w=412, avail_h=915,
        gpu_class="mali",
        is_mobile=True, device_scale_factor=2.625, max_touch_points=5,
        ua_reduced=("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"),
        ua_model="Pixel 7", ua_platform_version_mobile="14.0.0",
    ),
    # --- Linux desktop, real GPU (Mesa stack: same GL float ranges as our
    # measured llvmpipe -- Intel iris + AMD radeonsi share Mesa with llvmpipe;
    # line 255 / point 256. Renderer strings are real Linux/OpenGL ANGLE strings
    # mined from a public fingerprint DB. NVIDIA-Linux uses the proprietary
    # driver (different ranges, unmeasured here) so it's intentionally absent.)
    FpProfile(
        label="Linux desktop, Intel UHD 630 (Mesa)",
        platform="Linux x86_64", ua_platform="Linux",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Google Inc. (Intel)",
        webgl_renderer="ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), "
                       "OpenGL 4.6)",
        screen_w=1920, screen_h=1080, avail_w=1920, avail_h=1053,
        gpu_class="intel",
        webgl_line_width_max=255, webgl_point_size_max=256,
    ),
    FpProfile(
        label="Linux desktop, AMD Radeon (Mesa radeonsi)",
        platform="Linux x86_64", ua_platform="Linux",
        hw_concurrency=12, device_memory=8,
        webgl_vendor="Google Inc. (AMD)",
        webgl_renderer="ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 "
                       "LLVM 17.0.6), OpenGL 4.6)",
        screen_w=2560, screen_h=1440, avail_w=2560, avail_h=1413,
        gpu_class="amd",
        webgl_line_width_max=255, webgl_point_size_max=256,
    ),
    # --- additional Android phones (CDP-emulated; data-only additions) ---
    FpProfile(
        label="Google Pixel 8 (Android)",
        platform="Linux armv8l", ua_platform="Android",
        hw_concurrency=9, device_memory=8,
        webgl_vendor="ARM",
        webgl_renderer="ANGLE (ARM, Mali-G715, OpenGL ES 3.2)",
        screen_w=412, screen_h=915, avail_w=412, avail_h=915,
        gpu_class="mali",
        is_mobile=True, device_scale_factor=2.625, max_touch_points=5,
        ua_reduced=("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"),
        ua_model="Pixel 8", ua_platform_version_mobile="14.0.0",
    ),
    FpProfile(
        label="OnePlus 11 (Android)",
        platform="Linux armv8l", ua_platform="Android",
        hw_concurrency=8, device_memory=8,
        webgl_vendor="Qualcomm",
        webgl_renderer="ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)",
        screen_w=360, screen_h=804, avail_w=360, avail_h=804,
        gpu_class="adreno",
        is_mobile=True, device_scale_factor=3.0, max_touch_points=5,
        ua_reduced=("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"),
        ua_model="CPH2449", ua_platform_version_mobile="14.0.0",
    ),
    FpProfile(
        label="Samsung Galaxy A54 (Android)",
        platform="Linux armv8l", ua_platform="Android",
        # 8GB variant -> deviceMemory 8 (Chrome only reports powers of two;
        # the previous value 6 is impossible and itself a bot tell).
        hw_concurrency=8, device_memory=8,
        webgl_vendor="ARM",
        webgl_renderer="ANGLE (ARM, Mali-G68, OpenGL ES 3.2)",
        screen_w=412, screen_h=892, avail_w=412, avail_h=892,
        gpu_class="mali",
        is_mobile=True, device_scale_factor=2.625, max_touch_points=5,
        ua_reduced=("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"),
        ua_model="SM-A546B", ua_platform_version_mobile="14.0.0",
    ),
]


# ============================================================================
# GENERATED real-device templates (2026-06-07). Each row is built from a
# VERIFIED primitive -- the exact ANGLE WebGL renderer string + real PCI device
# id a genuine machine reports (researched + sourced: techpowerup/pci.ids +
# real fingerprint corpora for desktop GPUs; deviceandbrowserinfo corpus for
# Apple Metal strings; chromium UA-reduction + viewport DBs for Android) -- then
# expanded across the real (screen, cores) combinations that actually ship for
# each GPU. Invariants enforced for coherence:
#   * navigator.deviceMemory is ALWAYS a power of two <= 8 (Chrome caps at 8;
#     >8, or a non-power-of-two like 6, is itself a bot tell).
#   * hardwareConcurrency stays in the realistic band for the GPU tier.
#   * the renderer string (incl. the 0x<PCIID>) is the literal ANGLE output.
# The per-session farbling seed makes each session's canvas/audio/WebGL HASH
# unique (~4.3e9 per template), so these templates are the realistic *device
# distribution*, not the fingerprint count -- adding more is honest diversity.
# To grow further: append a verified GPU/chip/model row below.
# ----------------------------------------------------------------------------

# tier -> realistic (screen_w, screen_h, avail_h) at the panel's logical/CSS
# size. avail_h = screen_h - Windows 11 taskbar (~48px); avail_w == screen_w.
_WIN_SCREENS: dict[str, list[tuple[int, int, int]]] = {
    "high": [(2560, 1440, 1392), (3840, 2160, 2112), (2560, 1600, 1552)],
    "mid": [(1920, 1080, 1032), (2560, 1440, 1392), (1920, 1200, 1152)],
    "budget": [(1920, 1080, 1032), (1366, 768, 720), (1600, 900, 852)],
    "laptop": [(1920, 1080, 1032), (1536, 864, 816), (2560, 1440, 1392)],
}
# tier -> realistic logical-core counts (cores x SMT) for CPUs paired with it.
_WIN_CORES: dict[str, list[int]] = {
    "high": [16, 24, 32],
    "mid": [12, 16, 24],
    "budget": [8, 12, 16],
    "laptop": [8, 12, 16],
}
# (gpu name, gpu_class, UNMASKED_VENDOR, exact ANGLE UNMASKED_RENDERER, tier)
_WIN_GPUS: list[tuple[str, str, str, str, str]] = [
    # NVIDIA -- vendor "Google Inc. (NVIDIA)"
    ("NVIDIA GeForce RTX 4090", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"),
    ("NVIDIA GeForce RTX 4080", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 (0x00002704) Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"),
    ("NVIDIA GeForce RTX 4070 Ti", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"),
    ("NVIDIA GeForce RTX 4070", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("NVIDIA GeForce RTX 4060 Ti", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Ti (0x00002803) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("NVIDIA GeForce RTX 4060", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 (0x00002882) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("NVIDIA GeForce RTX 3080", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("NVIDIA GeForce RTX 3070", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("NVIDIA GeForce RTX 3060 Ti", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Ti (0x00002486) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("NVIDIA GeForce RTX 3060", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("NVIDIA GeForce RTX 3050", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 (0x00002507) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("NVIDIA GeForce RTX 2060", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 (0x00001F08) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("NVIDIA GeForce GTX 1660 Ti", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti (0x00002182) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("NVIDIA GeForce GTX 1650", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("NVIDIA GeForce GTX 1060 6GB", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB (0x00001C03) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("NVIDIA GeForce RTX 4060 Laptop GPU", "nvidia", "Google Inc. (NVIDIA)",
     "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU (0x000028E0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "laptop"),
    # AMD -- vendor "Google Inc. (AMD)"; family PCI id shared, name differs
    ("AMD Radeon RX 7900 XT", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 7900 XT (0x0000744C) Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"),
    ("AMD Radeon RX 7800 XT", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 7800 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"),
    ("AMD Radeon RX 7700 XT", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 7700 XT (0x0000747E) Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"),
    ("AMD Radeon RX 6800", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 6800 (0x000073BF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("AMD Radeon RX 6700 XT", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("AMD Radeon RX 6600 XT", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 6600 XT (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("AMD Radeon RX 6600", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("AMD Radeon RX 7600", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 7600 (0x00007480) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("AMD Radeon RX 580", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon RX 580 (0x000067DF) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("AMD Radeon(TM) Graphics", "amd", "Google Inc. (AMD)",
     "ANGLE (AMD, AMD Radeon(TM) Graphics (0x0000164E) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    # Intel -- vendor "Google Inc. (Intel)"
    ("Intel Arc A770", "intel", "Google Inc. (Intel)",
     "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("Intel Arc A750", "intel", "Google Inc. (Intel)",
     "ANGLE (Intel, Intel(R) Arc(TM) A750 Graphics (0x000056A1) Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"),
    ("Intel UHD Graphics 770", "intel", "Google Inc. (Intel)",
     "ANGLE (Intel, Intel(R) UHD Graphics 770 (0x0000A780) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("Intel UHD Graphics 630 (desktop)", "intel", "Google Inc. (Intel)",
     "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)", "budget"),
    ("Intel Iris Xe Graphics", "intel", "Google Inc. (Intel)",
     "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)", "laptop"),
]

# Apple Silicon: (chip, model label, screen_w, screen_h, avail_h, cores).
# Renderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple <chip>, Unspecified
# Version)", vendor "Google Inc. (Apple)", platform MacIntel, deviceMemory 8.
# Laptop avail_h = screen_h - notch/menubar (corpus-observed); desktop/external
# avail_h = screen_h - 25 (menubar; Dock auto-hides).
_APPLE_ROWS: list[tuple[str, str, int, int, int, int]] = [
    ("M1", "MacBook Air 13 M1", 1440, 900, 862, 8),
    ("M1", "MacBook Pro 13 M1", 1440, 900, 862, 8),
    ("M1", "Mac mini M1", 1920, 1080, 1055, 8),
    ("M1", "iMac 24 M1", 2048, 1152, 1127, 8),
    ("M2", "MacBook Air 13 M2", 1470, 956, 918, 8),
    ("M2", "MacBook Air 15 M2", 1710, 1112, 1074, 8),
    ("M2", "Mac mini M2", 2560, 1440, 1415, 8),
    ("M3", "MacBook Air 13 M3", 1470, 956, 918, 8),
    ("M3", "MacBook Air 15 M3", 1710, 1112, 1074, 8),
    ("M3", "iMac 24 M3", 2048, 1152, 1127, 8),
    ("M4", "iMac 24 M4", 2048, 1152, 1127, 10),
    ("M4", "Mac mini M4", 2560, 1440, 1415, 10),
    ("M4", "MacBook Air 13 M4", 1470, 956, 918, 10),
    ("M1 Pro", "MacBook Pro 14 M1 Pro", 1512, 982, 944, 10),
    ("M1 Pro", "MacBook Pro 16 M1 Pro", 1728, 1117, 1079, 10),
    ("M1 Max", "MacBook Pro 14 M1 Max", 1512, 982, 944, 10),
    ("M1 Max", "MacBook Pro 16 M1 Max", 1728, 1117, 1079, 10),
    ("M1 Ultra", "Mac Studio M1 Ultra", 2560, 1440, 1415, 20),
    ("M2 Pro", "MacBook Pro 14 M2 Pro", 1512, 982, 944, 12),
    ("M2 Pro", "MacBook Pro 16 M2 Pro", 1728, 1117, 1079, 12),
    ("M2 Pro", "Mac mini M2 Pro", 2560, 1440, 1415, 12),
    ("M2 Max", "MacBook Pro 16 M2 Max", 1728, 1117, 1079, 12),
    ("M2 Max", "Mac Studio M2 Max", 3840, 2160, 2135, 12),
    ("M2 Ultra", "Mac Studio M2 Ultra", 3840, 2160, 2135, 24),
    ("M3 Pro", "MacBook Pro 14 M3 Pro", 1512, 982, 944, 12),
    ("M3 Pro", "MacBook Pro 16 M3 Pro", 1728, 1117, 1079, 12),
    ("M3 Max", "MacBook Pro 14 M3 Max", 1512, 982, 944, 16),
    ("M3 Max", "MacBook Pro 16 M3 Max", 1728, 1117, 1079, 16),
    ("M3 Ultra", "Mac Studio M3 Ultra", 3840, 2160, 2135, 28),
    ("M4 Pro", "MacBook Pro 14 M4 Pro", 1512, 982, 944, 14),
    ("M4 Pro", "MacBook Pro 16 M4 Pro", 1728, 1117, 1079, 14),
    ("M4 Pro", "Mac mini M4 Pro", 2560, 1440, 1415, 14),
    ("M4 Max", "MacBook Pro 16 M4 Max", 1728, 1117, 1079, 16),
    ("M4 Max", "Mac Studio M4 Max", 3840, 2160, 2135, 16),
]

_CHROME_MAJOR = "149"  # keep in lockstep with the apex-chromium build + browser._CHROME_BRANDS
_ANDROID_UA = (
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
    f"(KHTML, like Gecko) Chrome/{_CHROME_MAJOR}.0.0.0 Mobile Safari/537.36"
)
# Android: (label, ua_model, gpu_class, vendor, renderer, w, h, dpr, mem, cores).
# Frozen UA (Android 10; K) + platform Linux armv8l + touch 5 are universal.
# Snapdragon->Adreno rows (US "U" Samsung codes match the Adreno GPU); Pixel
# Tensor->Mali (Tensor G3 in Pixel 8/8Pro is 9-core). deviceMemory <= 8.
_ANDROID_ROWS: list[tuple[str, str, str, str, str, int, int, float, int, int]] = [
    ("Samsung Galaxy S21", "SM-G991U", "adreno", "Qualcomm",
     "ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)", 360, 800, 3.0, 8, 8),
    ("Samsung Galaxy S22", "SM-S901U", "adreno", "Qualcomm",
     "ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)", 360, 780, 3.0, 8, 8),
    ("Samsung Galaxy S23 Ultra", "SM-S918B", "adreno", "Qualcomm",
     "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)", 384, 824, 3.75, 8, 8),
    ("Samsung Galaxy S24", "SM-S921U", "adreno", "Qualcomm",
     "ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)", 360, 780, 3.0, 8, 8),
    ("Samsung Galaxy S24 Ultra", "SM-S928B", "adreno", "Qualcomm",
     "ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)", 384, 824, 3.75, 8, 8),
    ("Google Pixel 6", "Pixel 6", "mali", "ARM",
     "ANGLE (ARM, Mali-G78, OpenGL ES 3.2)", 412, 915, 2.625, 8, 8),
    ("Google Pixel 8 Pro", "Pixel 8 Pro", "mali", "ARM",
     "ANGLE (ARM, Mali-G715, OpenGL ES 3.2)", 448, 997, 3.0, 8, 9),
    ("Google Pixel 9", "Pixel 9", "mali", "ARM",
     "ANGLE (ARM, Mali-G715, OpenGL ES 3.2)", 360, 808, 3.0, 8, 8),
    ("OnePlus 12", "CPH2581", "adreno", "Qualcomm",
     "ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)", 412, 919, 3.0, 8, 8),
    ("Xiaomi 13", "2211133G", "adreno", "Qualcomm",
     "ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)", 393, 852, 3.0, 8, 8),
]


def _gen_windows() -> list[FpProfile]:
    out: list[FpProfile] = []
    for name, gclass, vendor, renderer, tier in _WIN_GPUS:
        form = "laptop" if tier == "laptop" else "desktop"
        for w, h, ah in _WIN_SCREENS[tier]:
            for c in _WIN_CORES[tier]:
                out.append(FpProfile(
                    label=f"Windows {form}, {name} {w}x{h} {c}c",
                    platform="Win32", ua_platform="Windows",
                    hw_concurrency=c, device_memory=8,
                    webgl_vendor=vendor, webgl_renderer=renderer,
                    screen_w=w, screen_h=h, avail_w=w, avail_h=ah,
                    gpu_class=gclass,
                ))
    return out


def _gen_apple() -> list[FpProfile]:
    out: list[FpProfile] = []
    for chip, label, w, h, ah, cores in _APPLE_ROWS:
        out.append(FpProfile(
            # core count disambiguates binned vs full chips (e.g. 10- vs 12-core
            # M2 Pro) so labels stay unique vs the hand-written rows above.
            label=f"{label} {cores}c", platform="MacIntel", ua_platform="macOS",
            hw_concurrency=cores, device_memory=8,
            webgl_vendor="Google Inc. (Apple)",
            webgl_renderer=(f"ANGLE (Apple, ANGLE Metal Renderer: Apple {chip}, "
                            "Unspecified Version)"),
            screen_w=w, screen_h=h, avail_w=w, avail_h=ah, gpu_class="apple",
        ))
    return out


def _gen_android() -> list[FpProfile]:
    out: list[FpProfile] = []
    for label, model, gclass, vendor, renderer, w, h, dpr, mem, cores in _ANDROID_ROWS:
        out.append(FpProfile(
            label=f"{label} (Android)",
            platform="Linux armv8l", ua_platform="Android",
            hw_concurrency=cores, device_memory=mem,
            webgl_vendor=vendor, webgl_renderer=renderer,
            screen_w=w, screen_h=h, avail_w=w, avail_h=h, gpu_class=gclass,
            is_mobile=True, device_scale_factor=dpr, max_touch_points=5,
            ua_reduced=_ANDROID_UA, ua_model=model,
            ua_platform_version_mobile="14.0.0",
        ))
    return out


def _extend_profiles() -> None:
    """Append generated templates, de-duped against existing rows by the tuple
    that defines a distinct device (renderer + screen + cores + platform)."""
    def key(p: FpProfile) -> tuple:
        return (p.webgl_renderer, p.screen_w, p.screen_h,
                p.hw_concurrency, p.platform)
    seen = {key(p) for p in PROFILES}
    for p in _gen_windows() + _gen_apple() + _gen_android():
        k = key(p)
        if k not in seen:
            seen.add(k)
            PROFILES.append(p)


_extend_profiles()


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


def persona_fingerprint(persona_dir) -> tuple["FpProfile", int]:
    """Return (FpProfile, seed) STABLE for a persona/account.

    The ACCOUNT model: each account maps to a persistent persona dir, and its
    fingerprint (device profile + farbling seed) is generated ONCE and saved in
    <persona>/apex-fingerprint.json, then reused every session. So an account
    looks like ONE fixed device over time -- same canvas/audio/WebGL hash and
    same device profile every login -- while different accounts get different,
    unlinkable fingerprints (exactly the Multilogin/GoLogin "profile" model).

    `persona_dir` None (pool exhausted -> ephemeral) returns a fresh random
    fingerprint, which is correct for a throwaway session. Generation honors
    APEX_PROFILE + host GPU class via pick_profile(). If the saved profile label
    no longer exists (PROFILES changed), it regenerates + re-saves. Best-effort:
    a read/write failure degrades to a fresh fingerprint, never blocks.
    """
    if persona_dir is None:
        return pick_profile(), random.getrandbits(32)
    path = Path(persona_dir) / "apex-fingerprint.json"
    try:
        if path.exists():
            data = json.loads(path.read_text())
            prof = pick_profile_by_label(data.get("profile", ""))
            if prof is not None and "seed" in data:
                return prof, int(data["seed"]) & 0xFFFFFFFF
    except Exception:  # noqa: BLE001 - corrupt/missing -> regenerate
        pass
    prof = pick_profile()
    seed = random.getrandbits(32)
    try:
        path.write_text(json.dumps({"profile": prof.label, "seed": seed}))
    except Exception:  # noqa: BLE001 - persistence best-effort
        pass
    return prof, seed


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
    if profile.is_mobile:
        # Mobile: CDP owns UA / UA-CH / navigator.platform / screen / touch /
        # DPR (see mobile_emulation_spec + the launcher). APEX_FP only spoofs
        # the GPU + cores/mem + canvas/audio noise the binary renders natively.
        # Adreno/Mali GLES line-width is [1,1] (no wide lines on mobile GL).
        return {
            "APEX_FP_ACTIVE": "1",
            "APEX_FP_SEED": str(seed & 0xFFFFFFFF),
            "APEX_FP_HW_CONCURRENCY": str(profile.hw_concurrency),
            "APEX_FP_DEVICE_MEMORY": str(profile.device_memory),
            "APEX_FP_WEBGL_VENDOR": profile.webgl_vendor,
            "APEX_FP_WEBGL_RENDERER": profile.webgl_renderer,
            "APEX_FP_WEBGL_LINE_WIDTH_MAX": "1",
            "APEX_FP_BATTERY_LEVEL": str(battery_pct / 100.0),
            "APEX_FP_BATTERY_CHARGING": str(rng.choice([0, 1])),
            "APEX_FP_NET_RTT": str(rng.choice([50, 100, 150])),
            "APEX_FP_NET_DOWNLINK": "10",
            "APEX_FP_NET_EFFECTIVE_TYPE": "4g",
        }
    # navigator.connection: a residential broadband profile. Chrome caps
    # downlink at 10 Mbps and rounds rtt to 50ms for privacy, so these ARE the
    # values a real fast connection reports -- the spoof matters because a
    # datacenter/headless host often reports rtt~0 or an odd effectiveType,
    # which is the datacenter-vs-residential tell. rtt varies per session.
    net_rtt = rng.choice([50, 50, 100, 100, 150])
    # storage.estimate().quota: a per-origin quota in a plausible residential
    # band (120-400 GiB), seed-stable. Datacenter VMs report small/uniform
    # quotas tied to a tiny host disk.
    quota_bytes = rng.randint(120, 400) * 1024 * 1024 * 1024
    # Sec-CH-UA-Platform-Version must be coherent with the spoofed platform: a
    # macOS platform with a Linux kernel version is itself a tell. Verified
    # real values -- macOS uses the macOS version, Win11 24H2 reports "15.0.0".
    ua_platform_version = {
        "macOS": "14.6.0",
        "Windows": "15.0.0",
    }.get(profile.ua_platform, "")
    # Per-backend WebGL float ranges + WebGPU coherence. Windows=ANGLE-D3D11,
    # macOS=ANGLE-Metal (both line-width [1,1]; point-size 1024/511). Linux
    # software = ANGLE-GL on Mesa llvmpipe, whose REAL ranges are [1,255]/
    # [1,256] (MEASURED on our host) -- forcing [1,1] there would itself be the
    # tell. For llvmpipe we also leave WebGPU NATIVE (empty vendor -> the apex
    # WebGPU patches don't fire): a real GPU-less Linux Chrome reports Chrome's
    # bundled SwiftShader (vendor "google", maxTex 8192, fallback), and that
    # honest software pairing is coherent (no lie) for a GPU-less-Linux persona.
    if profile.gpu_class == "llvmpipe":
        line_width_max, point_size_max = "255", "256"
        webgpu_vendor, webgpu_arch = "", ""
    elif profile.gpu_class == "apple":
        line_width_max, point_size_max = "1", "511"
        webgpu_vendor, webgpu_arch = profile.gpu_class, ""
    else:  # nvidia / intel / amd -> ANGLE-D3D11
        line_width_max, point_size_max = "1", "1024"
        webgpu_vendor, webgpu_arch = profile.gpu_class, ""
    # Per-persona overrides win (Linux real-GPU personas: Mesa ranges 255/256).
    if profile.webgl_line_width_max is not None:
        line_width_max = str(profile.webgl_line_width_max)
    if profile.webgl_point_size_max is not None:
        point_size_max = str(profile.webgl_point_size_max)
    return {
        "APEX_FP_ACTIVE": "1",
        "APEX_FP_SEED": str(seed & 0xFFFFFFFF),
        "APEX_FP_PLATFORM": profile.platform,
        "APEX_FP_UA_PLATFORM": profile.ua_platform,
        "APEX_FP_HW_CONCURRENCY": str(profile.hw_concurrency),
        "APEX_FP_DEVICE_MEMORY": str(profile.device_memory),
        "APEX_FP_WEBGL_VENDOR": profile.webgl_vendor,
        "APEX_FP_WEBGL_RENDERER": profile.webgl_renderer,
        # WebGL float ranges that betray the SOFTWARE renderer (ANGLE-GL/
        # llvmpipe) vs the persona's claimed backend. Line-width is [1,1] on
        # BOTH D3D11 (Windows) and Metal (macOS) -- neither does wide lines --
        # so it's always 1. Point-size max is backend-specific: ANGLE-Metal
        # reports 511, ANGLE-D3D11 reports 1024.
        "APEX_FP_WEBGL_LINE_WIDTH_MAX": line_width_max,
        "APEX_FP_WEBGL_POINT_SIZE_MAX": point_size_max,
        # WebGPU adapter must agree with the WebGL GPU -- 2025-26 detectors
        # cross-check the two and flag a mismatch. The web-exposed WebGPU
        # vendor is the lowercase GPU family, which is exactly gpu_class
        # ("apple"/"nvidia"/"amd"/"intel"). The patched binary also forces
        # isFallbackAdapter=false so the headless box's SwiftShader adapter
        # doesn't out itself. architecture is left empty: stock Chrome reports
        # empty for many real adapters (verified for NVIDIA), and an absent
        # value is coherent (never a contradiction), whereas a guessed
        # per-family arch string risks an outright mismatch.
        # TODO: verify real per-family architecture strings (apple/intel/amd)
        # and set them here for an even tighter match.
        "APEX_FP_WEBGPU_VENDOR": webgpu_vendor,
        "APEX_FP_WEBGPU_ARCHITECTURE": webgpu_arch,
        "APEX_FP_SCREEN_W": str(profile.screen_w),
        "APEX_FP_SCREEN_H": str(profile.screen_h),
        "APEX_FP_SCREEN_AVAIL_W": str(profile.avail_w),
        "APEX_FP_SCREEN_AVAIL_H": str(profile.avail_h),
        "APEX_FP_COLOR_DEPTH": str(profile.color_depth),
        "APEX_FP_BATTERY_LEVEL": str(battery_pct / 100.0),
        "APEX_FP_BATTERY_CHARGING": "0",
        "APEX_FP_NET_RTT": str(net_rtt),
        "APEX_FP_NET_DOWNLINK": "10",
        "APEX_FP_NET_EFFECTIVE_TYPE": "4g",
        "APEX_FP_STORAGE_QUOTA": str(quota_bytes),
        "APEX_FP_UA_PLATFORM_VERSION": ua_platform_version,
    }


def mobile_emulation_spec(profile: FpProfile) -> dict | None:
    """CDP device-emulation params for a mobile persona, else None.

    The launcher feeds these to CDP Emulation.setUserAgentOverride (UA +
    navigator.platform + UA-CH metadata) / setDeviceMetricsOverride (mobile
    viewport + DPR + pointer:coarse/hover:none) / setTouchEmulationEnabled
    (maxTouchPoints). The UA-CH `brands`/`fullVersionList` are NOT here -- the
    launcher reads the browser's REAL Chrome brands at runtime so they're never
    fabricated; only the platform bits below become Android.
    """
    if not profile.is_mobile:
        return None
    return {
        "ua": profile.ua_reduced,
        "navigator_platform": profile.platform,   # "Linux armv8l"
        "ua_ch_platform": profile.ua_platform,    # "Android"
        "ua_ch_platform_version": profile.ua_platform_version_mobile,
        "ua_ch_model": profile.ua_model,
        "ua_ch_mobile": True,
        "form_factors": ["Mobile"],
        "width": profile.screen_w,
        "height": profile.screen_h,
        "device_scale_factor": profile.device_scale_factor,
        "max_touch_points": profile.max_touch_points,
    }


def patched_chrome_path() -> str | None:
    """Path to the apex-chromium patched binary, if APEX_CHROME_PATH is set.

    When unset, apex falls back to stock Chrome and the APEX_FP_* env vars are
    inert (stock Chrome has no patches reading them).
    """
    p = os.environ.get("APEX_CHROME_PATH")
    return p if (p and os.path.exists(p)) else None
